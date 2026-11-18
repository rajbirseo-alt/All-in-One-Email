import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@crm/crypto';
import { SendService } from '../src/compose/send.service';
import { IngestService } from '../src/mail/ingest.service';
import { QUEUES, QueueService, type SendJob } from '../src/mail/queue.service';
import { SyncService } from '../src/mail/sync.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AttachmentsService } from '../src/threads/attachments.service';
import { AccessPolicy } from '../src/access/access-policy.service';
import { attachmentBytes, FakeMail, mimeHeader } from './fake-mail';
import { bootApp, type Client, clientAs, makeDepartment, makeUser, prisma } from './helpers';
import { connectMailbox, daysAgo, gmailMessage, MAIL_ENV, uniqueMailbox } from './mail-helpers';

let fake: FakeMail;
let app: INestApplication;
let admin: Client;
let adminId: string;
let sync: SyncService;
let sender: SendService;
const box = uniqueMailbox('replies');
const ol = uniqueMailbox('olsend');
let boxId: string;
let olId: string;

const thread = (providerThreadId: string) => prisma.emailThread.findFirstOrThrow({ where: { providerThreadId } });

/** Runs queued send jobs for a draft like the worker does; returns the outcomes. */
async function runSends(draftId: string) {
  const boss = await app.get(QueueService).get();
  const jobs = (await boss.findJobs<SendJob>(QUEUES.send, { queued: true })).filter((j) => j.data.draftId === draftId);
  const out: string[] = [];
  for (const j of jobs) {
    try {
      out.push(await sender.send(j.data));
    } catch (e) {
      out.push(`threw:${(e as Error).name}`);
    }
    await boss.deleteJob(QUEUES.send, j.id);
  }
  return out;
}

beforeAll(async () => {
  fake = await new FakeMail().start();
  ({ app } = await bootApp({ mailEndpoints: fake.endpoints(), env: MAIL_ENV }));
  sync = app.get(SyncService);
  const prismaSvc = app.get(PrismaService);
  sender = new SendService(prismaSvc, sync, app.get(IngestService), new AttachmentsService(prismaSvc, app.get(AccessPolicy), sync));
  adminId = (await makeUser({ role: 'SUPER_ADMIN' })).id;
  admin = await clientAs(app, adminId);

  fake.gmailAdd(box, gmailMessage(box, 'c1', { from: 'Client One <client@acme.com>', to: `${box}, Colleague <colleague@acme.com>`, subject: 'Need a quote', messageId: '<c1@acme.com>' }));
  fake.gmailAdd(box, gmailMessage(box, 'c2', { subject: 'Brief attached', messageId: '<c2@acme.com>', attachment: { filename: 'brief.pdf', mime: 'application/pdf', size: 40 } }));
  boxId = await connectMailbox(admin, fake, 'google', box);
  await sync.run(boxId, 'INITIAL');

  fake.graphAdd(ol, { id: 'r1', conversationId: 'rc1', folderId: 'F-INBOX', from: 'lead@client.com', to: ol, subject: 'Outlook enquiry', html: '<p>Hi</p>', received: daysAgo(1), isRead: false, internetMessageId: '<r1@client.com>' });
  olId = await connectMailbox(admin, fake, 'microsoft', ol);
  await sync.run(olId, 'INITIAL');
});

afterAll(async () => {
  await app.close();
  fake.stop();
});

describe('drafts', () => {
  it('pre-fills a reply: recipient, Re: subject, quote, base version', async () => {
    const t = await thread('t-c1');
    const r = await admin.post('/drafts', { mode: 'REPLY', threadId: t.id });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ mode: 'REPLY', status: 'EDITING', to: [{ address: 'client@acme.com', name: 'Client One' }], cc: [], subject: 'Re: Need a quote', baseThreadVersion: t.version });
    expect(r.body.bodyHtml).toContain('Client One &lt;client@acme.com&gt; wrote:');
    expect(r.body.bodyHtml).toContain('Body of c1');
  });

  it('reply-all copies the other recipients but never the mailbox itself', async () => {
    const t = await thread('t-c1');
    const r = await admin.post('/drafts', { mode: 'REPLY_ALL', threadId: t.id });
    expect(r.body.to.map((p: { address: string }) => p.address)).toEqual(['client@acme.com']);
    expect(r.body.cc.map((p: { address: string }) => p.address)).toEqual(['colleague@acme.com']);
  });

  it('is private to its author and needs REPLY access to the mailbox', async () => {
    const t = await thread('t-c1');
    const mine = await admin.post('/drafts', { mode: 'REPLY', threadId: t.id });
    const emp = await makeUser({ role: 'EMPLOYEE' });
    const ec = await clientAs(app, emp.id);
    expect((await ec.get(`/drafts/${mine.body.id}`)).status).toBe(404);
    await prisma.emailAccountAccess.create({ data: { id: newId(), emailAccountId: boxId, userId: emp.id, level: 'READ' } });
    expect((await ec.post('/drafts', { mode: 'REPLY', threadId: t.id })).status).toBe(403);
    expect((await ec.post('/drafts', { mode: 'NEW', emailAccountId: boxId })).status).toBe(403);
    await prisma.emailAccountAccess.updateMany({ where: { userId: emp.id }, data: { level: 'REPLY' } });
    expect((await ec.post('/drafts', { mode: 'REPLY', threadId: t.id })).status).toBe(201);
  });

  it('autosaves edits and refuses executable attachments', async () => {
    const d = (await admin.post('/drafts', { mode: 'NEW', emailAccountId: boxId })).body;
    const u = await admin.patch(`/drafts/${d.id}`, { to: [{ address: 'x@example.com' }], subject: 'Hello', bodyHtml: '<p>Hi</p>' });
    expect(u.body).toMatchObject({ subject: 'Hello', to: [{ address: 'x@example.com' }] });
    const bad = await admin.upload(`/drafts/${d.id}/attachments`, 'run.exe', Buffer.from('MZ'));
    expect(bad.status).toBe(422);
    const ok = await admin.upload(`/drafts/${d.id}/attachments`, 'notes.txt', Buffer.from('hello file'));
    expect(ok.status).toBe(201);
    expect(ok.body.attachments).toMatchObject([{ filename: 'notes.txt', sizeBytes: 10 }]);
  });
});

describe('sending through Gmail', () => {
  it('sends a reply in the same Gmail thread with threading headers, and records it once', async () => {
    const t = await thread('t-c1');
    const d = (await admin.post('/drafts', { mode: 'REPLY', threadId: t.id })).body;
    await admin.patch(`/drafts/${d.id}`, { bodyHtml: '<p>Here is our quote.</p>' });
    const s = await admin.post(`/drafts/${d.id}/send`, { baseThreadVersion: d.baseThreadVersion });
    expect(s.status).toBe(202);
    expect(s.body.status).toBe('QUEUED');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'message.send', entityId: d.id } });
    expect(JSON.stringify(audit)).not.toContain('Here is our quote'); // bodies never go into the audit log

    expect(await runSends(d.id)).toEqual(['sent']);
    const sent = fake.gmailSent.at(-1)!;
    expect(sent.threadId).toBe('t-c1');
    expect(mimeHeader(sent.raw, 'In-Reply-To')).toBe('<c1@acme.com>');
    expect(mimeHeader(sent.raw, 'References')).toContain('<c1@acme.com>');
    expect(mimeHeader(sent.raw, 'Subject')).toBe('Re: Need a quote');
    expect(mimeHeader(sent.raw, 'Message-ID')).toMatch(new RegExp(`@${box.split('@')[1]!.replace('.', '\\.')}>$`));
    expect(sent.raw).toContain('Here is our quote.');

    const draft = await prisma.draft.findUniqueOrThrow({ where: { id: d.id } });
    expect(draft.status).toBe('SENT');
    const out = await prisma.emailMessage.findUniqueOrThrow({ where: { id: draft.sentMessageId! } });
    expect(out).toMatchObject({ direction: 'OUTBOUND', threadId: t.id, sentByUserId: adminId });
    expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: t.id } })).awaitingReplySince).toBeNull();

    const before = await prisma.emailMessage.count({ where: { threadId: t.id } });
    await sync.run(boxId, 'WEBHOOK'); // the provider's copy arrives through sync: no duplicate
    expect(await prisma.emailMessage.count({ where: { threadId: t.id } })).toBe(before);
  });

  it('refuses to send when new mail arrived while writing (THREAD_CHANGED), then sends after review', async () => {
    const t = await thread('t-c1');
    const d = (await admin.post('/drafts', { mode: 'REPLY', threadId: t.id })).body;
    fake.gmailAdd(box, gmailMessage(box, 'c3', { threadId: 't-c1', subject: 'Re: Need a quote', text: 'Actually, one more thing', date: new Date(), messageId: '<c3@acme.com>' }));
    await sync.run(boxId, 'WEBHOOK');
    const r = await admin.post(`/drafts/${d.id}/send`, { baseThreadVersion: d.baseThreadVersion });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('THREAD_CHANGED');
    expect(r.body.error.details.newMessages.map((m: { snippet: string }) => m.snippet)).toEqual(['Actually, one more thing']);
    const again = await admin.post(`/drafts/${d.id}/send`, { baseThreadVersion: r.body.error.details.currentVersion });
    expect(again.status).toBe(202);
    expect(await runSends(d.id)).toEqual(['sent']);
  });

  it('forwards with the original attachment and uploads, fetched at send time', async () => {
    const t = await thread('t-c2');
    const d = (await admin.post('/drafts', { mode: 'FORWARD', threadId: t.id })).body;
    expect(d.subject).toBe('Fwd: Brief attached');
    expect(d.attachments.map((a: { filename: string }) => a.filename)).toEqual(['brief.pdf']);
    await admin.upload(`/drafts/${d.id}/attachments`, 'extra.txt', Buffer.from('extra content'));
    await admin.patch(`/drafts/${d.id}`, { to: [{ address: 'partner@agency.com' }] });
    await admin.post(`/drafts/${d.id}/send`, {});
    expect(await runSends(d.id)).toEqual(['sent']);
    const raw = fake.gmailSent.at(-1)!.raw;
    expect(raw).toContain('filename=brief.pdf');
    expect(raw).toContain(Buffer.from(attachmentBytes('c2')).toString('base64'));
    expect(raw).toContain(Buffer.from('extra content').toString('base64'));
    expect(mimeHeader(raw, 'In-Reply-To')).toBeNull();
    // Uploaded bytes are dropped once sent.
    expect(await prisma.attachment.count({ where: { draftId: d.id, content: { not: null } } })).toBe(0);
  });

  it('never sends twice when Gmail accepted the message but the call failed', async () => {
    const d = (await admin.post('/drafts', { mode: 'NEW', emailAccountId: boxId })).body;
    await admin.patch(`/drafts/${d.id}`, { to: [{ address: 'new@lead.com' }], subject: 'Hello there', bodyHtml: '<p>Hi</p>' });
    await admin.post(`/drafts/${d.id}/send`, {});
    const job = { draftId: d.id, approvedAt: (await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).approvedAt!.toISOString() };
    fake.gmailSendFailAfterAccept = 1;
    const sentBefore = fake.gmailSent.length;
    await expect(sender.send(job)).rejects.toThrow(); // 503: retried by the queue
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('QUEUED');
    expect(await sender.send(job)).toBe('sent'); // the retry finds the message by its Message-ID
    expect(fake.gmailSent.length).toBe(sentBefore + 1);
    expect(await sender.send(job)).toBe('skipped'); // and a stray duplicate job does nothing
    await (await app.get(QueueService).get()).deleteQueuedJobs(QUEUES.send);
  });

  it('lets a scheduled send be cancelled before it goes out', async () => {
    const d = (await admin.post('/drafts', { mode: 'NEW', emailAccountId: boxId })).body;
    await admin.patch(`/drafts/${d.id}`, { to: [{ address: 'later@lead.com' }], subject: 'Later' });
    const r = await admin.post(`/drafts/${d.id}/send`, { scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
    expect(r.status).toBe(202);
    const boss = await app.get(QueueService).get();
    const [job] = (await boss.findJobs<SendJob>(QUEUES.send, { queued: true })).filter((j) => j.data.draftId === d.id);
    expect(job!.startAfter.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect((await admin.post(`/drafts/${d.id}/cancel-send`)).body.status).toBe('EDITING');
    expect(await sender.send(job!.data)).toBe('skipped');
    expect((await admin.post(`/drafts/${d.id}/send`, { scheduledFor: daysAgo(1).toISOString() })).status).toBe(422);
  });
});

describe('sending through Microsoft 365', () => {
  it('replies with createReplyAll, uploads large files via an upload session, keeps the conversation', async () => {
    const t = await thread('rc1');
    const d = (await admin.post('/drafts', { mode: 'REPLY_ALL', threadId: t.id })).body;
    const big = Buffer.alloc(3_500_000, 7);
    await admin.upload(`/drafts/${d.id}/attachments`, 'big.bin', big);
    await admin.upload(`/drafts/${d.id}/attachments`, 'small.txt', Buffer.from('small'));
    await admin.patch(`/drafts/${d.id}`, { bodyHtml: '<p>Thanks, attached.</p>' });
    await admin.post(`/drafts/${d.id}/send`, { baseThreadVersion: d.baseThreadVersion });
    expect(await runSends(d.id)).toEqual(['sent']);

    const sent = fake.graphSent.at(-1)!.message;
    expect(sent).toMatchObject({ createdVia: 'createReplyAll', replyToId: 'r1', conversationId: 'rc1', subject: 'Re: Outlook enquiry', to: 'lead@client.com' });
    expect(sent.html).toContain('Thanks, attached.');
    const files = Object.fromEntries((sent.attachments ?? []).map((a) => [a.name, a.bytes]));
    expect(files['big.bin']!.equals(big)).toBe(true);
    expect(files['small.txt']!.toString()).toBe('small');

    const draft = await prisma.draft.findUniqueOrThrow({ where: { id: d.id } });
    const out = await prisma.emailMessage.findUniqueOrThrow({ where: { id: draft.sentMessageId! } });
    expect(out).toMatchObject({ threadId: t.id, providerMessageId: draft.providerDraftId, direction: 'OUTBOUND' });
    const before = await prisma.emailMessage.count({ where: { emailAccountId: olId } });
    await sync.run(olId, 'WEBHOOK'); // Sent Items delta delivers the same immutable id: no duplicate
    expect(await prisma.emailMessage.count({ where: { emailAccountId: olId } })).toBe(before);
  });
});

describe('signatures and templates', () => {
  it('adds the default signature (sanitised) to new drafts', async () => {
    const s = await admin.post('/signatures', { name: 'Main', html: '<p>Regards, <b>Admin</b></p><script>x()</script>', isDefault: true });
    expect(s.status).toBe(201);
    expect(s.body.html).not.toContain('script');
    const d = (await admin.post('/drafts', { mode: 'NEW', emailAccountId: boxId })).body;
    expect(d.bodyHtml).toContain('Regards, <b>Admin</b>');
  });

  it('shares templates privately, with a department, or company-wide (admins only)', async () => {
    const dept = await makeDepartment();
    const author = await makeUser({ role: 'EMPLOYEE', departmentId: dept.id });
    const colleague = await makeUser({ role: 'EMPLOYEE', departmentId: dept.id });
    const outsider = await makeUser({ role: 'EMPLOYEE' });
    const ac = await clientAs(app, author.id);
    expect((await ac.post('/templates', { name: 'Co', bodyHtml: 'x', sharing: 'company' })).status).toBe(403);
    const t = await ac.post('/templates', { name: `Quote ${newId()}`, subject: 'Your quote', bodyHtml: '<p>Dear client</p>', sharing: 'department' });
    expect(t.status).toBe(201);
    const names = async (u: string) => (await (await clientAs(app, u)).get('/templates')).body.map((x: { id: string }) => x.id);
    expect(await names(colleague.id)).toContain(t.body.id);
    expect(await names(outsider.id)).not.toContain(t.body.id);
    expect((await (await clientAs(app, colleague.id)).del(`/templates/${t.body.id}`)).status).toBe(403);
    expect((await admin.post('/templates', { name: 'Company', bodyHtml: 'x', sharing: 'company' })).status).toBe(201);
  });
});
