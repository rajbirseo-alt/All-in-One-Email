import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHost, testImapAccount } from '@crm/providers';
import { CredentialService } from '../src/mail/credential.service';
import { ImapIdleService } from '../src/mail/imap-idle.service';
import { QUEUES, QueueService, type FlagJob, type SendJob } from '../src/mail/queue.service';
import { SyncService } from '../src/mail/sync.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { SendService } from '../src/compose/send.service';
import type { FlagPushService } from '../src/mail/flag-push.service';
import { FakeImapBox, rawMail } from './fake-imap';
import { FakeMail } from './fake-mail';
import { bootApp, type Client, clientAs, makeUser, prisma } from './helpers';
import { connectMailbox, daysAgo, gmailMessage, MAIL_ENV, uniqueMailbox, workerServices } from './mail-helpers';

let app: INestApplication;
let fake: FakeMail;
let admin: Client;
let sync: SyncService;
let sender: SendService;
let flags: FlagPushService;
let box: FakeImapBox;
const address = uniqueMailbox('zoho');
let accountId: string;
const stamp = Date.now().toString(36);
const mid = (k: string) => `<${k}.${stamp}@client.example>`;

const threadOf = async (messageId: string) => {
  const m = await prisma.emailMessage.findFirstOrThrow({ where: { emailAccountId: accountId, internetMessageId: messageId }, include: { thread: true, folders: { include: { folder: true } } } });
  return m;
};

async function drainSends(draftId: string) {
  const boss = await app.get(QueueService).get();
  const jobs = (await boss.findJobs<SendJob>(QUEUES.send, { queued: true })).filter((j) => j.data.draftId === draftId);
  const out: string[] = [];
  for (const j of jobs) {
    out.push(await sender.send(j.data));
    await boss.deleteJob(QUEUES.send, j.id);
  }
  return out;
}
async function drainFlags(threadId: string) {
  const boss = await app.get(QueueService).get();
  const jobs = await boss.findJobs<FlagJob>(QUEUES.flags, { key: threadId, queued: true });
  for (const j of jobs) {
    await flags.push(j.data);
    await boss.deleteJob(QUEUES.flags, j.id);
  }
  return jobs.length;
}

beforeAll(async () => {
  fake = await new FakeMail().start();
  ({ app } = await bootApp({ mailEndpoints: fake.endpoints(), env: MAIL_ENV }));
  sync = app.get(SyncService);
  ({ sender, flags } = await workerServices(app));
  admin = await clientAs(app, (await makeUser({ role: 'SUPER_ADMIN' })).id);
  box = await new FakeImapBox(address).start();
  // History in the mailbox before it is connected: two recent, one older than the import window.
  box.deliver('INBOX', rawMail({ from: 'Asha Rao <asha@client.example>', to: address, subject: 'Website redesign quote', messageId: mid('h1'), text: 'Please quote' }), [], daysAgo(3));
  box.deliver('INBOX', rawMail({ from: 'Old Client <old@client.example>', to: address, subject: 'Ancient', messageId: mid('old') }), ['\\Seen'], daysAgo(400));
  box.deliver('Sent', rawMail({ from: address, to: 'asha@client.example', subject: 'Re: Website redesign quote', messageId: mid('h2'), inReplyTo: mid('h1'), references: mid('h1') }), ['\\Seen'], daysAgo(2));
  box.deliver('INBOX', rawMail({ from: 'Asha Rao <asha@client.example>', to: address, subject: 'Brief attached', messageId: mid('att'), attachment: { filename: 'brief.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 brief content '.repeat(40)) } }), ['\\Seen'], daysAgo(1));
});

afterAll(async () => {
  box?.stop();
  fake?.stop();
  await app?.close();
});

describe('connection test and security', () => {
  it('reports each step and refuses a wrong password', async () => {
    const ok = await admin.post('/accounts/imap/test', box.settings());
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.steps.map((s: { step: string }) => s.step)).toEqual(['dns', 'imap', 'folders', 'smtp']);
    expect(ok.body.folders.map((f: { type: string }) => f.type)).toEqual(expect.arrayContaining(['INBOX', 'SENT', 'ARCHIVE', 'SPAM', 'TRASH']));

    const bad = await admin.post('/accounts/imap/test', box.settings(address, 'wrong'));
    expect(bad.body.ok).toBe(false);
    expect(bad.body.steps.find((s: { step: string }) => s.step === 'imap')).toMatchObject({ ok: false });
    expect(bad.body.steps.find((s: { step: string }) => s.step === 'smtp')).toMatchObject({ ok: false });

    const dns = await admin.post('/accounts/imap/test', { ...box.settings(), imap: { host: 'no-such-host.invalid', port: 993, security: 'TLS' } });
    expect(dns.body.steps).toEqual([expect.objectContaining({ step: 'dns', ok: false })]);
    // A wrong password is never saved.
    const refused = await admin.post('/accounts/imap', box.settings(address, 'wrong'));
    expect(refused.status).toBe(422);
    expect(await prisma.emailAccount.count({ where: { emailAddress: address } })).toBe(0);
  });

  it('production policy: private and loopback addresses are refused; TLS is required', async () => {
    await expect(checkHost('127.0.0.1')).rejects.toThrow(/private network/);
    await expect(checkHost('10.1.2.3')).rejects.toThrow(/private network/);
    await expect(checkHost('localhost')).rejects.toThrow(/private network/);
    // Without the test-only plaintext switch the client insists on TLS, which the fake server does not speak.
    const strict = await testImapAccount(box.settings(), { allowPrivateHosts: true, timeoutMs: 2000 });
    expect(strict.ok).toBe(false);
    expect(strict.steps.find((s) => s.step === 'imap')?.ok).toBe(false);
  });

  it('only mailbox admins may connect', async () => {
    const emp = await clientAs(app, (await makeUser({ role: 'EMPLOYEE' })).id);
    expect((await emp.post('/accounts/imap/test', box.settings())).status).toBe(403);
    expect((await emp.post('/accounts/imap', box.settings())).status).toBe(403);
  });
});

describe('connect and first sync', () => {
  it('stores the password encrypted and imports the window', async () => {
    const r = await admin.post('/accounts/imap', { ...box.settings(), displayName: 'Zoho Sales', syncDays: 30 });
    expect(r.status).toBe(201);
    accountId = r.body.id;
    const cred = await prisma.emailCredential.findUniqueOrThrow({ where: { emailAccountId: accountId } });
    expect(cred.kind).toBe('PASSWORD');
    expect(cred).toMatchObject({ username: address, imapHost: '127.0.0.1', imapPort: box.imapPort, smtpPort: box.smtpPort });
    expect(Buffer.from(cred.ciphertext).toString('utf8')).not.toContain(box.password);
    expect((await app.get(CredentialService).imapConfig(accountId)).password).toBe(box.password);
    expect((await admin.get(`/accounts/${accountId}/imap`)).body).toEqual({ username: address, imap: { host: '127.0.0.1', port: box.imapPort, security: 'TLS' }, smtp: { host: '127.0.0.1', port: box.smtpPort, security: 'TLS' } });
    expect(await prisma.auditLog.count({ where: { action: 'account.connect', entityId: accountId } })).toBe(1);

    expect(await sync.run(accountId, 'INITIAL')).toBe('succeeded');
    const account = await prisma.emailAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.status).toBe('ACTIVE');
    const msgs = await prisma.emailMessage.findMany({ where: { emailAccountId: accountId } });
    expect(msgs.map((m) => m.internetMessageId).sort()).toEqual([mid('att'), mid('h1'), mid('h2')].sort());
    // Our reply in Sent joins the client's thread by its headers, as outbound.
    const reply = await threadOf(mid('h2'));
    expect(reply.direction).toBe('OUTBOUND');
    expect(reply.threadId).toBe((await threadOf(mid('h1'))).threadId);
    expect((await threadOf(mid('h1'))).isRead).toBe(false);
    expect((await threadOf(mid('att'))).folders[0]!.imapUid).not.toBeNull();
    // The contact was matched as for any other mailbox.
    expect((await threadOf(mid('h1'))).thread.contactId).not.toBeNull();
    // A second run imports nothing twice.
    await sync.run(accountId, 'POLL');
    expect(await prisma.emailMessage.count({ where: { emailAccountId: accountId } })).toBe(3);
  });

  it('cannot take over an address connected through Google', async () => {
    const g = uniqueMailbox('gm');
    fake.gmailAdd(g, gmailMessage(g, 'x1'));
    await connectMailbox(admin, fake, 'google', g);
    const r = await admin.post('/accounts/imap', { ...box.settings(), email: g });
    expect(r.status).toBe(409);
  });
});

describe('incremental sync', () => {
  it('new mail, replies by header and by subject, flags, moves and deletions', async () => {
    box.deliver('INBOX', rawMail({ from: 'Asha Rao <asha@client.example>', to: address, subject: 'Re: Website redesign quote', messageId: mid('n1'), inReplyTo: mid('h2'), references: `${mid('h1')} ${mid('h2')}` }));
    // A client whose mail program drops the headers: same subject, same person.
    box.deliver('INBOX', rawMail({ from: 'asha@client.example', to: address, subject: 'RE: Website redesign quote', messageId: mid('n2') }));
    // No Message-ID at all.
    const noId = box.deliver('INBOX', rawMail({ from: 'Robot Free <person@other.example>', to: address, subject: 'No id here', messageId: null }));
    await sync.run(accountId, 'IDLE');
    const t1 = (await threadOf(mid('h1'))).threadId;
    expect((await threadOf(mid('n1'))).threadId).toBe(t1);
    expect((await threadOf(mid('n2'))).threadId).toBe(t1);
    const thread = await prisma.emailThread.findUniqueOrThrow({ where: { id: t1 } });
    expect(thread.messageCount).toBe(4);
    expect(thread.awaitingReplySince).not.toBeNull();
    const noIdMsg = await prisma.emailMessage.findFirstOrThrow({ where: { emailAccountId: accountId, subject: 'No id here' } });
    expect(noIdMsg.providerMessageId).toMatch(/^uid:/);

    // Read and starred in webmail.
    const n1 = box.find('INBOX', mid('n1'))!;
    box.setFlags('INBOX', n1.uid, ['\\Seen', '\\Flagged']);
    await sync.run(accountId, 'POLL');
    expect((await threadOf(mid('n1')))).toMatchObject({ isRead: true, isStarred: true });

    // Moved to Archive in webmail: same message, now only in Archive.
    const h1 = box.find('INBOX', mid('h1'))!;
    box.moveOnServer('INBOX', h1.uid, 'Archive');
    await sync.run(accountId, 'POLL');
    const moved = await threadOf(mid('h1'));
    expect(moved.folders.map((f) => f.folder.type)).toEqual(['ARCHIVE']);
    expect(await prisma.emailMessage.count({ where: { emailAccountId: accountId, internetMessageId: mid('h1') } })).toBe(1);

    // Deleted in webmail.
    box.expunge('INBOX', noId.uid);
    await sync.run(accountId, 'POLL');
    expect(await prisma.emailMessage.count({ where: { id: noIdMsg.id } })).toBe(0);
  });

  it('a renumbered folder (UIDVALIDITY change) is read again without duplicates', async () => {
    const before = await prisma.emailMessage.count({ where: { emailAccountId: accountId } });
    box.renumber('INBOX');
    await sync.run(accountId, 'POLL');
    expect(await prisma.emailMessage.count({ where: { emailAccountId: accountId } })).toBe(before);
    const inbox = await prisma.emailFolder.findFirstOrThrow({ where: { emailAccountId: accountId, type: 'INBOX' } });
    expect(Number(inbox.uidValidity)).toBe(box.imap.getMailbox('INBOX').uidvalidity);
    const link = (await threadOf(mid('n1'))).folders.find((f) => f.folderId === inbox.id)!;
    expect(Number(link.imapUid)).toBeGreaterThanOrEqual(1000);
  });
});

describe('sending', () => {
  it('a reply goes out over SMTP with Bcc only in the envelope, is filed in Sent once, and threads', async () => {
    const t = (await threadOf(mid('n2'))).thread;
    const d = (await admin.post('/drafts', { mode: 'REPLY', threadId: t.id })).body;
    await admin.patch(`/drafts/${d.id}`, { bodyHtml: '<p>Here is the quote.</p>', bcc: [{ address: 'boss@seodiscovery.test' }] });
    const s = await admin.post(`/drafts/${d.id}/send`, { baseThreadVersion: d.baseThreadVersion });
    expect(s.status).toBe(202);
    expect(await drainSends(d.id)).toEqual(['sent']);

    expect(box.sent).toHaveLength(1);
    const out = box.sent[0]!;
    expect(out.from).toBe(address);
    expect(out.to.sort()).toEqual(['asha@client.example', 'boss@seodiscovery.test']);
    expect(out.raw).not.toMatch(/^Bcc:/im);
    expect(out.raw).toMatch(new RegExp(`^In-Reply-To: ${mid('n2').replace(/[.<>]/g, '\\$&')}`, 'im'));
    const draft = await prisma.draft.findUniqueOrThrow({ where: { id: d.id } });
    const copy = box.find('Sent', draft.messageIdHeader!)!;
    expect(copy).toBeTruthy();
    expect(copy.raw).toMatch(/^Bcc: boss@seodiscovery.test/im);

    // The next sync sees the Sent copy: still one message, now with its UID.
    await sync.run(accountId, 'POLL');
    const stored = await prisma.emailMessage.findMany({ where: { emailAccountId: accountId, internetMessageId: draft.messageIdHeader } , include: { folders: true } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.threadId).toBe(t.id);
    expect(stored[0]!.direction).toBe('OUTBOUND');
    expect(stored[0]!.folders[0]!.imapUid).not.toBeNull();
  });

  it('a retry after SMTP accepted the mail never sends it twice', async () => {
    const t = (await threadOf(mid('n2'))).thread;
    const d = (await admin.post('/drafts', { mode: 'REPLY', threadId: t.id })).body;
    await admin.patch(`/drafts/${d.id}`, { bodyHtml: '<p>Once only.</p>' });
    await admin.post(`/drafts/${d.id}/send`, { baseThreadVersion: (await prisma.emailThread.findUniqueOrThrow({ where: { id: t.id } })).version });
    const sentBefore = box.sent.length;
    // Simulate: SMTP accepted on a first attempt that then crashed before recording.
    const job = (await (await app.get(QueueService).get()).findJobs<SendJob>(QUEUES.send, { queued: true })).find((j) => j.data.draftId === d.id)!;
    const mId = `<retry.${stamp}@${address.split('@')[1]}>`;
    await prisma.draft.update({ where: { id: d.id }, data: { messageIdHeader: mId, providerDraftId: `smtp-accepted:${mId}` } });
    expect(await drainSends(d.id)).toEqual(['sent']);
    expect(box.sent.length).toBe(sentBefore);
    expect(box.find('Sent', mId)).toBeTruthy();
    void job;
  });

  it('a temporary SMTP failure is retried', async () => {
    const t = (await threadOf(mid('n2'))).thread;
    const d = (await admin.post('/drafts', { mode: 'REPLY', threadId: t.id })).body;
    await admin.patch(`/drafts/${d.id}`, { bodyHtml: '<p>Second try.</p>' });
    await admin.post(`/drafts/${d.id}/send`, { baseThreadVersion: (await prisma.emailThread.findUniqueOrThrow({ where: { id: t.id } })).version });
    box.failNextSends = 1;
    const boss = await app.get(QueueService).get();
    const job = (await boss.findJobs<SendJob>(QUEUES.send, { queued: true })).find((j) => j.data.draftId === d.id)!;
    await expect(sender.send(job.data)).rejects.toThrow(/Try again later|for now/);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('QUEUED');
    expect(await sender.send(job.data)).toBe('sent');
    await boss.deleteJob(QUEUES.send, job.id);
    expect(box.sent.filter((m) => m.raw.includes('Second try.'))).toHaveLength(1);
  });
});

describe('CRM actions reach the server', () => {
  it('read, star, archive and spam', async () => {
    const m = await threadOf(mid('att'));
    const uid = Number(m.folders[0]!.imapUid);
    await admin.post(`/threads/${m.threadId}/unread`);
    await drainFlags(m.threadId);
    expect(box.messages('INBOX').find((x) => x.uid === uid)!.flags.map((f) => f.replace(/^\\/, ''))).not.toContain('Seen');
    await admin.post(`/threads/${m.threadId}/star`);
    await drainFlags(m.threadId);
    expect(box.messages('INBOX').find((x) => x.uid === uid)!.flags.map((f) => f.replace(/^\\/, ''))).toContain('Flagged');
    await admin.post(`/threads/${m.threadId}/archive`);
    await drainFlags(m.threadId);
    expect(box.find('INBOX', mid('att'))).toBeUndefined();
    expect(box.find('Archive', mid('att'))).toBeTruthy();
    await sync.run(accountId, 'POLL');
    expect((await threadOf(mid('att'))).folders.map((f) => f.folder.type)).toEqual(['ARCHIVE']);
  });

  it('attachments download intact from the server', async () => {
    const m = await threadOf(mid('att'));
    const att = await prisma.attachment.findFirstOrThrow({ where: { messageId: m.id } });
    expect(att).toMatchObject({ filename: 'brief.pdf', contentType: 'application/pdf' });
    const r = await admin.get(`/attachments/${att.id}/download`);
    expect(r.status).toBe(200);
    const expected = Buffer.from('%PDF-1.4 brief content '.repeat(40));
    expect(createHash('sha256').update(r.body as Buffer).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'));
  });
});

describe('IDLE and failures', () => {
  it('new mail on the server queues a sync within seconds (IDLE)', async () => {
    const queued: string[] = [];
    const idle = new ImapIdleService(app.get(PrismaService), app.get(CredentialService), { enqueueSync: async (id: string, kind: string) => void queued.push(`${id}:${kind}`) } as unknown as QueueService);
    await idle.start();
    try {
      for (let i = 0; i < 50 && !idle.watching().includes(accountId); i++) await new Promise((r) => setTimeout(r, 100));
      expect(idle.watching()).toContain(accountId);
      box.deliver('INBOX', rawMail({ from: 'asha@client.example', to: address, subject: 'Pinged', messageId: mid('idle') }));
      for (let i = 0; i < 60 && !queued.length; i++) await new Promise((r) => setTimeout(r, 100));
      expect(queued).toContain(`${accountId}:IDLE`);
    } finally {
      await idle.stop();
    }
  });

  it('a changed password marks the mailbox for reconnecting, and reconnecting resumes', async () => {
    box.changePassword('new-password');
    expect(await sync.run(accountId, 'POLL')).toBe('needs_reauth');
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: accountId } })).status).toBe('NEEDS_REAUTH');
    const r = await admin.post('/accounts/imap', box.settings(address, 'new-password'));
    expect(r.status).toBe(201);
    expect(r.body.id).toBe(accountId);
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: accountId } })).status).toBe('ACTIVE');
    const before = await prisma.emailMessage.count({ where: { emailAccountId: accountId } });
    expect(await sync.run(accountId, 'POLL')).toBe('succeeded');
    // The mail that arrived meanwhile is there; nothing duplicated.
    expect(await prisma.emailMessage.count({ where: { emailAccountId: accountId } })).toBe(before + 1);
  });

  it('disconnecting deletes the stored password', async () => {
    expect((await admin.del(`/accounts/${accountId}`)).status).toBe(200);
    expect(await prisma.emailCredential.count({ where: { emailAccountId: accountId } })).toBe(0);
  });
});
