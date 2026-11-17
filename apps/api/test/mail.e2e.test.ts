import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, sha256Hex } from '@crm/crypto';
import { AuditService } from '../src/audit/audit.service';
import type { AppConfig } from '../src/config/config';
import { MailWorkerService } from '../src/mail/mail-worker.service';
import { QUEUES, QueueService } from '../src/mail/queue.service';
import { RetentionService } from '../src/mail/retention.service';
import { SubscriptionService } from '../src/mail/subscription.service';
import { SyncService } from '../src/mail/sync.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { WorkerModule } from '../src/worker.module';
import { FakeMail } from './fake-mail';
import { APP_URL, Client, bootApp, clientAs, makeUser, prisma } from './helpers';

const PUSH_SA = 'gmail-push@crm-test.iam.gserviceaccount.com';
const MAIL_ENV = {
  GOOGLE_CLIENT_ID: 'g-client',
  GOOGLE_CLIENT_SECRET: 'g-secret',
  GMAIL_PUBSUB_TOPIC: 'projects/crm-test/topics/gmail-push',
  GMAIL_PUSH_SERVICE_ACCOUNT: PUSH_SA,
};

let fake: FakeMail;
let app: INestApplication;
let cfg: AppConfig;
let sync: SyncService;
let admin: Client;
let n = 0;

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
const mailbox = (p: string) => `${p}.${Date.now().toString(36)}${n++}@seodiscovery.test`;

beforeAll(async () => {
  fake = await new FakeMail().start();
  ({ app, cfg } = await bootApp({ mailEndpoints: fake.endpoints(), env: MAIL_ENV }));
  sync = app.get(SyncService);
  admin = await clientAs(app, (await makeUser({ role: 'SUPER_ADMIN' })).id);
});

afterAll(async () => {
  await app.close();
  fake.stop();
});

/** Runs the full browser flow: start → (provider consent) → callback. Returns the redirect target. */
async function connect(provider: 'google' | 'microsoft', box: string, opts: { noRefresh?: boolean; scope?: string; client?: Client; tamper?: boolean } = {}) {
  const c = opts.client ?? admin;
  const start = await c.post(`/accounts/oauth/${provider}/start`, { syncDays: 30 });
  expect(start.status).toBe(200);
  const url = new URL(start.body.url);
  const state = opts.tamper ? 'forged' : url.searchParams.get('state')!;
  const code = fake.issueCode(provider === 'google' ? 'GMAIL' : 'MICROSOFT', box, opts);
  const cb = await c.get(`/accounts/oauth/${provider}/callback?code=${code}&state=${encodeURIComponent(state)}`);
  expect(cb.status).toBe(302);
  return { location: cb.headers.location as string, authorizeUrl: url };
}

const accountOf = (box: string) => prisma.emailAccount.findUniqueOrThrow({ where: { emailAddress: box } });

async function queuedSyncs(accountId: string) {
  const boss = await app.get(QueueService).get();
  return boss.findJobs(QUEUES.sync, { key: accountId });
}

function gmailMessage(box: string, id: string, over: Partial<Parameters<FakeMail['gmailAdd']>[1]> = {}) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    from: 'Client One <client@acme.com>',
    to: box,
    subject: `Subject ${id}`,
    text: `Body of ${id}`,
    date: daysAgo(2),
    messageId: `<${id}@acme.com>`,
    ...over,
  };
}

describe('connecting a mailbox', () => {
  it('is limited to account.connect holders', async () => {
    const emp = await clientAs(app, (await makeUser({ role: 'EMPLOYEE' })).id);
    expect((await emp.post('/accounts/oauth/google/start', {})).status).toBe(403);
    expect((await emp.get('/accounts/providers')).status).toBe(403);
    expect((await admin.get('/accounts/providers')).body).toMatchObject({ gmail: true, microsoft: true, gmailPush: true, microsoftPush: false, retentionDays: 120 });
  });

  it('connects Gmail: offline consent with PKCE, encrypted tokens, audit entry, initial sync queued', async () => {
    const box = mailbox('sales');
    const { location, authorizeUrl } = await connect('google', box);
    expect(authorizeUrl.searchParams.get('access_type')).toBe('offline');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${APP_URL}/api/v1/accounts/oauth/google/callback`);

    const a = await accountOf(box);
    expect(location).toBe(`${APP_URL}/admin/mailboxes?connected=${a.id}`);
    expect(a).toMatchObject({ provider: 'GMAIL', status: 'INITIAL_SYNC' });
    expect(a.syncFromDate!.getTime()).toBeLessThan(daysAgo(29).getTime());

    const cred = await prisma.emailCredential.findUniqueOrThrow({ where: { emailAccountId: a.id } });
    const refreshToken = [...fake.refresh.entries()].find(([, v]) => v.mailbox === box)![0];
    expect(Buffer.from(cred.ciphertext).includes(Buffer.from(refreshToken))).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: 'account.connect', entityId: a.id } })).toBe(1);
    expect((await queuedSyncs(a.id)).map((j) => j.data)).toEqual([{ accountId: a.id, kind: 'INITIAL' }]);
  });

  it('rejects a forged state, a grant without refresh token and missing mail scope', async () => {
    expect((await connect('google', mailbox('x'), { tamper: true })).location).toContain('error=invalid_state');
    expect((await connect('google', mailbox('y'), { noRefresh: true })).location).toContain('error=no_refresh_token');
    expect((await connect('google', mailbox('z'), { scope: 'openid email' })).location).toContain('error=scope_not_granted');
  });

  it('binds the callback to the admin who started it', async () => {
    const other = await clientAs(app, (await makeUser({ role: 'SUPER_ADMIN' })).id);
    const start = await admin.post('/accounts/oauth/google/start', {});
    const state = new URL(start.body.url).searchParams.get('state')!;
    other.cookies.set('crm_mail_oauth', admin.cookies.get('crm_mail_oauth')!); // stolen cookie
    const code = fake.issueCode('GMAIL', mailbox('stolen'));
    const cb = await other.get(`/accounts/oauth/google/callback?code=${code}&state=${state}`);
    expect(cb.headers.location).toContain('error=invalid_state');
  });
});

describe('Gmail sync', () => {
  const box = mailbox('gmail');
  let id: string;

  beforeAll(async () => {
    fake.gmailAdd(box, gmailMessage(box, 'm1', { attachment: { filename: 'brief.pdf', mime: 'application/pdf', size: 2048 } }));
    fake.gmailAdd(box, gmailMessage(box, 'm2', { threadId: 't-m1', from: box, to: 'client@acme.com', labelIds: ['SENT'], date: daysAgo(1), inReplyTo: '<m1@acme.com>' }));
    fake.gmailAdd(box, gmailMessage(box, 'm3', { labelIds: ['INBOX', 'Label_1'], date: daysAgo(3) }));
    fake.gmailAdd(box, gmailMessage(box, 'old', { date: daysAgo(40) }));
    fake.gmailAdd(box, gmailMessage(box, 'draft', { labelIds: ['DRAFT'] }));
    await connect('google', box);
    id = (await accountOf(box)).id;
  });

  it('imports the sync window into threads, folders and attachments', async () => {
    expect(await sync.run(id, 'INITIAL')).toBe('succeeded');
    const a = await accountOf(box);
    expect(a.status).toBe('ACTIVE');
    expect(a.gmailHistoryId).toBeTruthy();

    const msgs = await prisma.emailMessage.findMany({ where: { emailAccountId: id }, include: { attachments: true, folders: { include: { folder: true } } }, orderBy: { providerMessageId: 'asc' } });
    expect(msgs.map((m) => m.providerMessageId)).toEqual(['m1', 'm2', 'm3']); // not the old one, not the draft
    const [m1, m2, m3] = msgs;
    expect(m1).toMatchObject({ direction: 'INBOUND', isRead: false, fromAddress: 'client@acme.com', fromName: 'Client One', internetMessageId: '<m1@acme.com>', bodyText: 'Body of m1', hasAttachments: true });
    expect(m1!.attachments).toMatchObject([{ filename: 'brief.pdf', contentType: 'application/pdf', sizeBytes: 2048, providerAttachmentId: 'a-m1' }]);
    expect(m2).toMatchObject({ direction: 'OUTBOUND', threadId: m1!.threadId });
    expect(m3!.folders.map((f) => f.folder.name).sort()).toEqual(['Clients', 'Inbox']);

    const thread = await prisma.emailThread.findUniqueOrThrow({ where: { id: m1!.threadId } });
    expect(thread).toMatchObject({ messageCount: 2, unreadCount: 1, hasAttachments: true, awaitingReplySince: null, lastOutboundAt: m2!.receivedAt });
    expect(thread.firstResponseAt).toEqual(m2!.receivedAt);
    expect((await prisma.emailThread.findFirstOrThrow({ where: { emailAccountId: id, providerThreadId: 't-m3' } })).awaitingReplySince).toEqual(m3!.receivedAt);
    // CATEGORY_* and UNREAD are flags, not folders.
    expect((await prisma.emailFolder.findMany({ where: { emailAccountId: id } })).map((f) => f.type).sort()).toEqual(['CUSTOM', 'INBOX', 'SENT', 'STARRED', 'TRASH']);
  });

  it('is idempotent: running again stores nothing twice', async () => {
    expect(await sync.run(id, 'INCREMENTAL')).toBe('succeeded');
    expect(await prisma.emailMessage.count({ where: { emailAccountId: id } })).toBe(3);
  });

  it('applies history: new reply, read/label change and deletion', async () => {
    fake.gmailAdd(box, gmailMessage(box, 'm4', { threadId: 't-m1', date: new Date(), text: 'Thanks!' }));
    fake.gmailSetLabels(box, 'm3', ['INBOX', 'STARRED']); // read + starred, Clients label removed
    fake.gmailDelete(box, 'm2');
    expect(await sync.run(id, 'WEBHOOK')).toBe('succeeded');

    const ids = (await prisma.emailMessage.findMany({ where: { emailAccountId: id }, select: { providerMessageId: true } })).map((m) => m.providerMessageId).sort();
    expect(ids).toEqual(['m1', 'm3', 'm4']);
    const m3 = await prisma.emailMessage.findFirstOrThrow({ where: { emailAccountId: id, providerMessageId: 'm3' }, include: { folders: { include: { folder: true } } } });
    expect(m3.isRead).toBe(true);
    expect(m3.isStarred).toBe(true);
    expect(m3.folders.map((f) => f.folder.type).sort()).toEqual(['INBOX', 'STARRED']);

    const t1 = await prisma.emailThread.findFirstOrThrow({ where: { emailAccountId: id, providerThreadId: 't-m1' } });
    // Outbound m2 was deleted, so the thread is waiting for a reply again since m1.
    expect(t1).toMatchObject({ messageCount: 2, lastOutboundAt: null });
    expect(t1.awaitingReplySince).not.toBeNull();
    const log = await prisma.syncLog.findFirstOrThrow({ where: { emailAccountId: id, kind: 'WEBHOOK' } });
    expect(log).toMatchObject({ status: 'SUCCEEDED', messagesAdded: 1 });
  });

  it('resyncs the window when Gmail no longer has the history id', async () => {
    fake.gmailExpireHistory(box);
    fake.gmailAdd(box, gmailMessage(box, 'm5', { date: new Date() }));
    expect(await sync.run(id, 'POLL')).toBe('succeeded');
    expect(await prisma.emailMessage.count({ where: { emailAccountId: id } })).toBe(4);
  });
});

describe('tokens', () => {
  it('refreshes expired access tokens and keeps Google’s refresh token', async () => {
    const box = mailbox('refresh');
    fake.gmailAdd(box, gmailMessage(box, 'r1'));
    fake.accessTtl = 0; // every access token is already expired
    await connect('google', box);
    fake.accessTtl = 3600;
    const a = await accountOf(box);
    expect(await sync.run(a.id, 'INITIAL')).toBe('succeeded');
    expect(await prisma.emailMessage.count({ where: { emailAccountId: a.id } })).toBe(1);
    expect((await prisma.emailCredential.findUniqueOrThrow({ where: { emailAccountId: a.id } })).rotatedAt).not.toBeNull();
  });

  it('marks a revoked grant NEEDS_REAUTH without retrying, and a reconnect resumes from the cursor', async () => {
    const box = mailbox('revoked');
    fake.gmailAdd(box, gmailMessage(box, 'v1'));
    await connect('google', box);
    const a = await accountOf(box);
    await sync.run(a.id, 'INITIAL');

    for (const [t, v] of fake.refresh) if (v.mailbox === box) fake.refresh.delete(t);
    for (const [t, v] of fake.access) if (v.mailbox === box) fake.access.delete(t);
    expect(await sync.run(a.id, 'POLL')).toBe('needs_reauth');
    const after = await accountOf(box);
    expect(after.status).toBe('NEEDS_REAUTH');
    expect(after.lastError).toContain('invalid_grant');
    expect(await prisma.auditLog.count({ where: { action: 'account.status', entityId: a.id } })).toBe(1);
    expect(await sync.run(a.id, 'POLL')).toBe('skipped');

    fake.gmailAdd(box, gmailMessage(box, 'v2', { date: new Date() }));
    await connect('google', box);
    const re = await accountOf(box);
    expect(re.status).toBe('ACTIVE'); // cursor kept → incremental, not a full import
    expect(await prisma.auditLog.count({ where: { action: 'account.reconnect', entityId: a.id } })).toBe(1);
    expect(await sync.run(a.id, 'INCREMENTAL')).toBe('succeeded');
    expect(await prisma.emailMessage.count({ where: { emailAccountId: a.id } })).toBe(2);
  });
});

describe('Microsoft 365 sync', () => {
  const box = mailbox('outlook');
  let id: string;

  beforeAll(async () => {
    const base = { conversationId: 'c1', from: 'lead@client.com', to: box, isRead: false };
    fake.graphAdd(box, { ...base, id: 'g1', folderId: 'F-INBOX', subject: 'Enquiry', html: '<p>Need SEO</p>', received: daysAgo(2), internetMessageId: '<g1@client.com>', attachments: [{ id: 'att-1', name: 'rfp.docx', contentType: 'application/msword', size: 5000 }] });
    fake.graphAdd(box, { ...base, id: 'g2', folderId: 'F-SENT', from: box, to: 'lead@client.com', subject: 'RE: Enquiry', html: '<p>Sure</p>', received: daysAgo(1), isRead: true, internetMessageId: '<g2@seo>' });
    fake.graphAdd(box, { ...base, id: 'g3', conversationId: 'c2', folderId: 'F-PROJECTS', subject: 'Project', html: 'x', received: daysAgo(3), internetMessageId: '<g3@c>' });
    fake.graphAdd(box, { ...base, id: 'g4', conversationId: 'c3', folderId: 'F-DRAFTS', subject: 'draft folder', html: 'x', received: daysAgo(1), internetMessageId: '<g4@c>' });
    expect((await connect('microsoft', box)).location).toContain('connected=');
    id = (await accountOf(box)).id;
  });

  it('imports synced folders with immutable ids, conversations and attachments', async () => {
    expect((await accountOf(box)).displayName).toBe('Sales Team');
    expect(await sync.run(id, 'INITIAL')).toBe('succeeded');
    const folders = await prisma.emailFolder.findMany({ where: { emailAccountId: id } });
    expect(Object.fromEntries(folders.map((f) => [f.name, f.syncEnabled]))).toEqual({ Inbox: true, 'Sent Items': true, Archive: true, Drafts: false, Projects: true });
    expect(folders.filter((f) => f.syncEnabled).every((f) => f.deltaLink)).toBe(true);

    const msgs = await prisma.emailMessage.findMany({ where: { emailAccountId: id }, include: { attachments: true }, orderBy: { providerMessageId: 'asc' } });
    expect(msgs.map((m) => m.providerMessageId)).toEqual(['g1', 'g2', 'g3']);
    expect(msgs[0]).toMatchObject({ direction: 'INBOUND', bodyHtml: '<p>Need SEO</p>', hasAttachments: true });
    expect(msgs[0]!.attachments[0]).toMatchObject({ filename: 'rfp.docx', providerAttachmentId: 'att-1' });
    expect(msgs[1]).toMatchObject({ direction: 'OUTBOUND', threadId: msgs[0]!.threadId });
  });

  it('keeps moved messages, removes deleted ones, adds new ones', async () => {
    fake.graphMove(box, 'g1', 'F-ARCHIVE');
    fake.graphDelete(box, 'g3');
    fake.graphAdd(box, { id: 'g5', conversationId: 'c1', folderId: 'F-INBOX', from: 'lead@client.com', to: box, subject: 'RE: Enquiry', html: 'next', received: new Date(), isRead: false, internetMessageId: '<g5@c>' });
    expect(await sync.run(id, 'WEBHOOK')).toBe('succeeded');

    const msgs = await prisma.emailMessage.findMany({ where: { emailAccountId: id }, include: { folders: { include: { folder: true } } }, orderBy: { providerMessageId: 'asc' } });
    expect(msgs.map((m) => m.providerMessageId)).toEqual(['g1', 'g2', 'g5']);
    expect(msgs[0]!.folders.map((f) => f.folder.type)).toEqual(['ARCHIVE']);
    const thread = await prisma.emailThread.findFirstOrThrow({ where: { emailAccountId: id, providerThreadId: 'c1' } });
    expect(thread).toMatchObject({ messageCount: 3, unreadCount: 2 }); // g1 (archived, unread) + g5
    expect(thread.awaitingReplySince).toEqual(msgs[2]!.receivedAt);
  });

  it('restarts a folder whose delta token expired', async () => {
    const inbox = await prisma.emailFolder.findFirstOrThrow({ where: { emailAccountId: id, type: 'INBOX' } });
    await prisma.emailFolder.update({ where: { id: inbox.id }, data: { deltaLink: `${fake.base}/graph/v1.0/me/mailFolders/F-INBOX/messages/delta?$deltatoken=expired` } });
    expect(await sync.run(id, 'POLL')).toBe('succeeded');
    expect(await prisma.emailMessage.count({ where: { emailAccountId: id } })).toBe(3);
  });

  it('creates Graph subscriptions with a hashed clientState and renews them', async () => {
    const prismaSvc = app.get(PrismaService);
    const subs = new SubscriptionService(prismaSvc, sync, { ...cfg, graphPushEnabled: true, webhookBaseUrl: 'https://crm.example/api/v1/webhooks' });
    await subs.ensure(id);
    const rows = await prisma.emailWebhookSubscription.findMany({ where: { emailAccountId: id, status: 'ACTIVE' } });
    expect(rows.map((r) => r.resource).sort()).toEqual(["me/mailFolders('F-INBOX')/messages", "me/mailFolders('F-SENT')/messages"]);
    const clientState = [...fake.graphBox(box).subs.values()][0]!;
    expect(rows.some((r) => r.clientStateHash === sha256Hex(clientState))).toBe(true);

    await prisma.emailWebhookSubscription.updateMany({ where: { emailAccountId: id }, data: { expiresAt: new Date(Date.now() + 3_600_000) } });
    await subs.ensure(id);
    const renewed = await prisma.emailWebhookSubscription.findMany({ where: { emailAccountId: id, status: 'ACTIVE' } });
    expect(renewed).toHaveLength(2);
    expect(renewed.every((r) => r.expiresAt.getTime() > Date.now() + 48 * 3_600_000)).toBe(true);
  });
});

describe('webhooks', () => {
  const raw = () => request(app.getHttpServer());

  it('accepts a verified Gmail push once, enqueues a sync and rejects forged tokens', async () => {
    const box = mailbox('push');
    await connect('google', box);
    const a = await accountOf(box);
    await prisma.emailAccount.update({ where: { id: a.id }, data: { status: 'ACTIVE' } });
    const boss = await app.get(QueueService).get();
    await boss.deleteQueuedJobs(QUEUES.sync);

    const body = { message: { data: Buffer.from(JSON.stringify({ emailAddress: box, historyId: '9' })).toString('base64'), messageId: `pm-${newId()}` } };
    const aud = `${APP_URL}/api/v1/webhooks/gmail`;
    const good = await fake.pushToken({ aud, email: PUSH_SA });
    expect((await raw().post('/api/v1/webhooks/gmail').set('Authorization', `Bearer ${good}`).send(body)).status).toBe(204);
    expect((await raw().post('/api/v1/webhooks/gmail').set('Authorization', `Bearer ${good}`).send(body)).status).toBe(204);
    expect(await prisma.webhookEvent.count({ where: { externalEventId: body.message.messageId } })).toBe(1);
    expect((await queuedSyncs(a.id)).map((j) => j.data)).toEqual([{ accountId: a.id, kind: 'WEBHOOK' }]);

    const wrongAud = await fake.pushToken({ aud: 'https://evil.example', email: PUSH_SA });
    const wrongSa = await fake.pushToken({ aud, email: 'someone@evil.iam.gserviceaccount.com' });
    for (const t of [wrongAud, wrongSa, 'not-a-jwt']) {
      expect((await raw().post('/api/v1/webhooks/gmail').set('Authorization', `Bearer ${t}`).send(body)).status).toBe(401);
    }
  });

  it('echoes the Graph validation token as plain text', async () => {
    const r = await raw().post('/api/v1/webhooks/graph?validationToken=abc%20123').set('Content-Type', 'text/plain').send('');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.text).toBe('abc 123');
  });

  it('accepts Graph notifications only with the right clientState; lifecycle events schedule renewal', async () => {
    const box = mailbox('graphpush');
    await connect('microsoft', box);
    const a = await accountOf(box);
    await prisma.emailAccount.update({ where: { id: a.id }, data: { status: 'ACTIVE' } });
    const sub = await prisma.emailWebhookSubscription.create({
      data: { id: newId(), emailAccountId: a.id, provider: 'MICROSOFT', externalId: `ext-${newId()}`, resource: 'r', clientStateHash: sha256Hex('right-secret'), expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const bad = await raw().post('/api/v1/webhooks/graph').send({ value: [{ subscriptionId: sub.externalId, clientState: 'wrong', changeType: 'created' }] });
    expect(bad.status).toBe(202);
    expect((await prisma.emailWebhookSubscription.findUniqueOrThrow({ where: { id: sub.id } })).lastNotifiedAt).toBeNull();

    const ok = await raw().post('/api/v1/webhooks/graph').send({ value: [{ subscriptionId: sub.externalId, clientState: 'right-secret', changeType: 'created' }] });
    expect(ok.status).toBe(202);
    expect((await prisma.emailWebhookSubscription.findUniqueOrThrow({ where: { id: sub.id } })).lastNotifiedAt).not.toBeNull();

    await raw().post('/api/v1/webhooks/graph/lifecycle').send({ value: [{ subscriptionId: sub.externalId, clientState: 'right-secret', lifecycleEvent: 'reauthorizationRequired' }] });
    expect((await prisma.emailWebhookSubscription.findUniqueOrThrow({ where: { id: sub.id } })).expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('mailbox management', () => {
  const box = mailbox('manage');
  let id: string;

  beforeAll(async () => {
    fake.gmailAdd(box, gmailMessage(box, 'x1'));
    await connect('google', box);
    id = (await accountOf(box)).id;
    await sync.run(id, 'INITIAL');
  });

  it('shows employees only mailboxes granted to them, their team or department', async () => {
    const emp = await makeUser({ role: 'EMPLOYEE' });
    const ec = await clientAs(app, emp.id);
    expect((await ec.get('/accounts')).body.find((m: { id: string }) => m.id === id)).toBeUndefined();
    expect((await ec.get(`/accounts/${id}`)).status).toBe(403);

    const bad = await admin.put(`/accounts/${id}/access`, { grants: [{ userId: emp.id, teamId: emp.id, level: 'READ' }] });
    expect(bad.status).toBe(422);
    const r = await admin.put(`/accounts/${id}/access`, { grants: [{ userId: emp.id, level: 'REPLY' }] });
    expect(r.status).toBe(200);
    expect(r.body.access).toMatchObject([{ level: 'REPLY', user: { id: emp.id } }]);
    const mine = (await ec.get('/accounts')).body.find((m: { id: string }) => m.id === id);
    expect(mine).toMatchObject({ emailAddress: box, status: 'ACTIVE', messageCount: 1 });
    expect(await prisma.auditLog.count({ where: { action: 'account.access', entityId: id } })).toBe(1);
  });

  it('returns health detail with folders, counts and sync logs', async () => {
    const d = await admin.get(`/accounts/${id}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ id, provider: 'GMAIL', status: 'ACTIVE', messageCount: 1, threadCount: 1 });
    expect(d.body.folders.find((f: { type: string }) => f.type === 'INBOX').messageCount).toBe(1);
    expect(d.body.syncLogs[0]).toMatchObject({ kind: 'INITIAL', status: 'SUCCEEDED', messagesAdded: 1 });
  });

  it('pauses, resumes and queues manual syncs', async () => {
    expect((await admin.post(`/accounts/${id}/pause`)).status).toBe(204);
    expect(await sync.run(id, 'POLL')).toBe('skipped');
    expect((await admin.post(`/accounts/${id}/sync`)).status).toBe(409);
    expect((await admin.post(`/accounts/${id}/resume`)).status).toBe(204);
    expect((await accountOf(box)).status).toBe('ACTIVE');
    expect((await admin.post(`/accounts/${id}/sync?full=true`)).status).toBe(202);
    expect((await accountOf(box)).status).toBe('INITIAL_SYNC');
    expect(await sync.run(id, 'INITIAL')).toBe('succeeded');
    expect(await prisma.emailMessage.count({ where: { emailAccountId: id } })).toBe(1);
  });

  it('disconnects: revokes at Google, deletes the credential and schedules the 120-day purge', async () => {
    const refreshToken = [...fake.refresh.entries()].find(([, v]) => v.mailbox === box)![0];
    const r = await admin.del(`/accounts/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('DISCONNECTED');
    expect(fake.revoked).toContain(refreshToken);
    expect(await prisma.emailCredential.count({ where: { emailAccountId: id } })).toBe(0);
    const a = await accountOf(box);
    expect(Math.round((a.purgeAfter!.getTime() - Date.now()) / 86_400_000)).toBe(120);
    expect(await sync.run(id, 'POLL')).toBe('skipped');
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'account.disconnect', entityId: id } })).metadata).toMatchObject({ providerRevoked: true });
  });

  it('purges mail content once the retention period has passed, keeping the audit trail', async () => {
    const retention = new RetentionService(app.get(PrismaService), app.get(AuditService));
    expect(await retention.purgeDue()).toBe(0);
    await prisma.emailAccount.update({ where: { id }, data: { purgeAfter: new Date(Date.now() - 1000) } });
    expect(await retention.purgeDue()).toBeGreaterThanOrEqual(1);
    expect(await prisma.emailMessage.count({ where: { emailAccountId: id } })).toBe(0);
    expect(await prisma.emailThread.count({ where: { emailAccountId: id } })).toBe(0);
    expect((await accountOf(box)).purgedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'account.purge', entityId: id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: id } })).toBeGreaterThan(3);
  });
});

describe('worker process', () => {
  let worker: INestApplicationContext;

  afterAll(async () => {
    await worker?.close();
  });

  it('picks up the queued initial sync and activates the mailbox', async () => {
    worker = await NestFactory.createApplicationContext(WorkerModule.register(cfg, { mailEndpoints: fake.endpoints() }), { logger: false });
    await worker.get(MailWorkerService).start();
    const box = mailbox('worker');
    fake.gmailAdd(box, gmailMessage(box, 'w1'));
    await connect('google', box);
    const a = await accountOf(box);
    const deadline = Date.now() + 30_000;
    while ((await accountOf(box)).status !== 'ACTIVE' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    expect((await accountOf(box)).status).toBe('ACTIVE');
    expect(await prisma.emailMessage.count({ where: { emailAccountId: a.id } })).toBe(1);
    // Push was set up after the first successful sync (Pub/Sub topic configured in this test env).
    expect(fake.gmailBox(box).watches).toBe(1);
  }, 40_000);
});
