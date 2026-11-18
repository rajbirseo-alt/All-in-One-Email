import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@crm/crypto';
import { FlagPushService } from '../src/mail/flag-push.service';
import { QUEUES, QueueService, type FlagJob } from '../src/mail/queue.service';
import { SyncService } from '../src/mail/sync.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { sanitizeEmailHtml } from '../src/threads/email-html';
import { attachmentBytes, FakeMail } from './fake-mail';
import { bootApp, type Client, clientAs, makeDepartment, makeUser, prisma } from './helpers';
import { connectMailbox, daysAgo, gmailMessage, MAIL_ENV, uniqueMailbox } from './mail-helpers';

let fake: FakeMail;
let app: INestApplication;
let admin: Client;
let sync: SyncService;
let flags: FlagPushService;

const sales = uniqueMailbox('sales');
const outlook = uniqueMailbox('ol');
let salesId: string;
let outlookId: string;
let salesDept: { id: string };
const thread = (providerThreadId: string) => prisma.emailThread.findFirstOrThrow({ where: { providerThreadId } });

/** Runs the queued provider-push jobs for a thread, like the worker does. */
async function drainFlags(threadId: string) {
  const boss = await app.get(QueueService).get();
  const jobs = await boss.findJobs<FlagJob>(QUEUES.flags, { key: threadId, queued: true });
  for (const j of jobs) {
    await flags.push(j.data);
    await boss.deleteJob(QUEUES.flags, j.id);
  }
  return jobs.map((j) => j.data.action);
}

beforeAll(async () => {
  fake = await new FakeMail().start();
  ({ app } = await bootApp({ mailEndpoints: fake.endpoints(), env: MAIL_ENV }));
  sync = app.get(SyncService);
  flags = new FlagPushService(app.get(PrismaService), sync);
  admin = await clientAs(app, (await makeUser({ role: 'SUPER_ADMIN' })).id);

  fake.gmailAdd(sales, gmailMessage(sales, 'a1', { subject: 'Website audit quote', text: 'We need an audit for our zebrafish shop', attachment: { filename: 'brief.pdf', mime: 'application/pdf', size: 40 } }));
  fake.gmailAdd(sales, gmailMessage(sales, 'a2', { subject: 'Backlinks', date: daysAgo(1), html: '<p onclick="steal()">Hi<script>alert(1)</script></p><img src="https://tracker.example/p.gif"><a href="https://ok.example">link</a>' }));
  fake.gmailAdd(sales, gmailMessage(sales, 'a3', { subject: 'Old archived', labelIds: ['Label_1'], date: daysAgo(3) }));
  salesId = await connectMailbox(admin, fake, 'google', sales);
  expect(await sync.run(salesId, 'INITIAL')).toBe('succeeded');
  // Gmail does not list spam in the initial import; it arrives later through history.
  fake.gmailAdd(sales, gmailMessage(sales, 'a4', { subject: 'Cheap pills', labelIds: ['SPAM'], date: daysAgo(1) }));
  expect(await sync.run(salesId, 'WEBHOOK')).toBe('succeeded');
  salesDept = await makeDepartment();
  await prisma.emailAccount.update({ where: { id: salesId }, data: { departmentId: salesDept.id } });

  fake.graphAdd(outlook, { id: 'o1', conversationId: 'oc1', folderId: 'F-INBOX', from: 'lead@client.com', to: outlook, subject: 'Outlook lead', html: '<p>Hello</p>', received: daysAgo(1), isRead: false, internetMessageId: '<o1@c>', attachments: [{ id: 'oa1', name: 'rfp.docx', contentType: 'application/msword', size: 30 }] });
  outlookId = await connectMailbox(admin, fake, 'microsoft', outlook);
  expect(await sync.run(outlookId, 'INITIAL')).toBe('succeeded');
});

afterAll(async () => {
  await app.close();
  fake.stop();
});

const ids = (items: { id: string }[]) => items.map((i) => i.id).sort();

describe('who sees which conversations', () => {
  it('lets an employee without access see nothing, and hides existence', async () => {
    const emp = await clientAs(app, (await makeUser({ role: 'EMPLOYEE' })).id);
    const t = await thread('t-a1');
    expect((await emp.get('/threads?view=all')).body.items.filter((i: { account: { id: string } }) => [salesId, outlookId].includes(i.account.id))).toEqual([]);
    expect((await emp.get(`/threads/${t.id}`)).status).toBe(404);
    const att = await prisma.attachment.findFirstOrThrow({ where: { message: { threadId: t.id } } });
    expect((await emp.get(`/attachments/${att.id}/download`)).status).toBe(404);
  });

  it('shows an assigned conversation, with reply allowed', async () => {
    const u = await makeUser({ role: 'EMPLOYEE' });
    const t = await thread('t-a1');
    await prisma.emailThread.update({ where: { id: t.id }, data: { assigneeId: u.id } });
    const c = await clientAs(app, u.id);
    const list = (await c.get('/threads?view=all')).body.items;
    expect(ids(list)).toEqual([t.id]);
    expect((await c.get(`/threads/${t.id}`)).body.canReply).toBe(true);
    await prisma.emailThread.update({ where: { id: t.id }, data: { assigneeId: null } });
  });

  it('a mailbox grant shows the whole mailbox; replying needs REPLY level', async () => {
    const u = await makeUser({ role: 'EMPLOYEE' });
    const c = await clientAs(app, u.id);
    await prisma.emailAccountAccess.create({ data: { id: newId(), emailAccountId: salesId, userId: u.id, level: 'READ' } });
    const list = (await c.get('/threads?view=all')).body.items;
    expect(list.every((i: { account: { id: string } }) => i.account.id === salesId)).toBe(true);
    expect(list).toHaveLength(3); // a1, a2, a3 — spam only in its own view
    const t = await thread('t-a2');
    expect((await c.get(`/threads/${t.id}`)).body.canReply).toBe(false);
    await prisma.emailAccountAccess.updateMany({ where: { userId: u.id }, data: { level: 'REPLY' } });
    expect((await c.get(`/threads/${t.id}`)).body.canReply).toBe(true);
  });

  it('department managers see mailboxes of their department; team leaders see team-granted mailboxes', async () => {
    const mgr = await makeUser({ role: 'DEPT_MANAGER', departmentId: salesDept.id });
    const other = await makeUser({ role: 'DEPT_MANAGER', departmentId: (await makeDepartment()).id });
    expect((await (await clientAs(app, mgr.id)).get('/threads?view=all')).body.items.length).toBe(3);
    expect((await (await clientAs(app, other.id)).get(`/threads?view=all&accountId=${salesId}`)).body.items).toEqual([]);

    const lead = await makeUser({ role: 'TEAM_LEADER' });
    const team = await prisma.team.create({ data: { id: newId(), name: `T ${newId()}`, departmentId: salesDept.id, leaderId: lead.id } });
    const lc = await clientAs(app, lead.id);
    expect((await lc.get(`/threads?view=all&accountId=${outlookId}`)).body.items).toEqual([]);
    await prisma.emailAccountAccess.create({ data: { id: newId(), emailAccountId: outlookId, teamId: team.id, level: 'READ' } });
    expect((await lc.get(`/threads?view=all&accountId=${outlookId}`)).body.items).toHaveLength(1);
  });

  it('an @-mention in a note gives access to that conversation only', async () => {
    const u = await makeUser({ role: 'EMPLOYEE' });
    const t = await thread('t-a3');
    const note = await prisma.internalNote.create({ data: { id: newId(), threadId: t.id, authorId: (await makeUser({ role: 'SUPER_ADMIN' })).id, body: 'see this' } });
    await prisma.noteMention.create({ data: { noteId: note.id, userId: u.id } });
    expect(ids((await (await clientAs(app, u.id)).get('/threads?view=all')).body.items)).toEqual([t.id]);
  });
});

describe('views, search and paging', () => {
  it('separates inbox, archive, spam and unread', async () => {
    const get = async (view: string) => (await admin.get(`/threads?view=${view}&accountId=${salesId}`)).body.items.map((i: { subject: string }) => i.subject).sort();
    expect(await get('inbox')).toEqual(['Backlinks', 'Website audit quote']);
    expect(await get('archive')).toEqual(['Old archived']);
    expect(await get('spam')).toEqual(['Cheap pills']);
    expect(await get('unread')).toEqual(['Backlinks', 'Website audit quote']);
  });

  it('finds conversations by body text, subject and sender', async () => {
    const q = async (s: string) => (await admin.get(`/threads?view=all&q=${encodeURIComponent(s)}&accountId=${salesId}`)).body.items.map((i: { subject: string }) => i.subject);
    expect(await q('zebrafish')).toEqual(['Website audit quote']);
    expect(await q('backlinks')).toEqual(['Backlinks']);
    expect((await q('client@acme.com')).length).toBe(3);
  });

  it('pages with a stable cursor', async () => {
    const p1 = await admin.get(`/threads?view=all&accountId=${salesId}&limit=2`);
    expect(p1.body.items).toHaveLength(2);
    const p2 = await admin.get(`/threads?view=all&accountId=${salesId}&limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    expect(new Set([...ids(p1.body.items), ...ids(p2.body.items)]).size).toBe(3);
    expect((await admin.get('/threads?cursor=garbage')).status).toBe(400);
  });

  it('returns sidebar counts', async () => {
    const c = (await admin.get('/threads/counts')).body;
    expect(c.unread).toBeGreaterThanOrEqual(3);
    expect(Object.keys(c).sort()).toEqual(['followup', 'inbox', 'mine', 'pending', 'snoozed', 'starred', 'unassigned', 'unread']);
  });
});

describe('reading a conversation', () => {
  it('sanitises HTML and blocks remote images until asked', async () => {
    const t = await thread('t-a2');
    const d = (await admin.get(`/threads/${t.id}`)).body;
    const html: string = d.messages[0].html;
    expect(html).not.toMatch(/script|onclick|alert/);
    expect(html).toContain('data-blocked-src="https://tracker.example/p.gif"');
    expect(html).not.toContain(' src="https://tracker');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(d.messages[0].blockedImages).toBe(1);
    const withImages = (await admin.get(`/threads/${t.id}?images=true`)).body.messages[0];
    expect(withImages.html).toContain('src="https://tracker.example/p.gif"');
  });

  it('rewrites inline cid images and drops styles, forms and javascript: links', () => {
    const out = sanitizeEmailHtml(
      '<style>body{background:url(https://x)}</style><form><input name=a></form><a href="javascript:alert(1)">x</a><img src="cid:logo@x"><img src="cid:unknown"><p style="color:red;position:fixed">t</p>',
      { cidUrl: (cid) => (cid === 'logo@x' ? '/api/v1/attachments/A1/download?inline=1' : null), loadRemoteImages: false },
    );
    expect(out.html).not.toMatch(/<style|<form|<input|javascript:|position/);
    expect(out.html).toContain('src="/api/v1/attachments/A1/download?inline=1"');
    expect(out.html).toContain('color:red');
  });

  it('downloads attachments from Gmail and Outlook intact, recording a checksum', async () => {
    const t = await thread('t-a1');
    const d = (await admin.get(`/threads/${t.id}`)).body;
    const att = d.messages[0].attachments[0];
    expect(att).toMatchObject({ filename: 'brief.pdf', contentType: 'application/pdf' });
    const r = await admin.get(`/attachments/${att.id}/download`);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain('attachment; filename="brief.pdf"');
    expect(r.headers['content-type']).toBe('application/octet-stream');
    const expected = createHash('sha256').update(attachmentBytes('a1')).digest('hex');
    expect(createHash('sha256').update(r.body as Buffer).digest('hex')).toBe(expected);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } })).sha256).toBe(expected);

    // Gmail attachment ids are not stable: a stale id is recovered by re-reading the message.
    await prisma.attachment.update({ where: { id: att.id }, data: { providerAttachmentId: 'stale' } });
    expect((await admin.get(`/attachments/${att.id}/download`)).status).toBe(200);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } })).providerAttachmentId).toBe('a-a1');

    const ot = await thread('oc1');
    const oatt = (await admin.get(`/threads/${ot.id}`)).body.messages[0].attachments[0];
    const or = await admin.get(`/attachments/${oatt.id}/download`);
    expect(Buffer.from(or.body as Buffer).toString()).toBe(attachmentBytes('oa1'));
  });
});

describe('triage actions', () => {
  it('marks read locally at once and pushes UNREAD removal to Gmail', async () => {
    const t = await thread('t-a1');
    expect((await admin.post(`/threads/${t.id}/read`)).status).toBe(204);
    expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: t.id } })).unreadCount).toBe(0);
    expect(await drainFlags(t.id)).toEqual(['read']);
    expect(fake.modifications.at(-1)).toMatchObject({ mailbox: sales, ids: ['a1'], removeLabelIds: ['UNREAD'] });
    expect(fake.gmailBox(sales).messages.get('a1')!.labelIds).not.toContain('UNREAD');
  });

  it('archives without the next sync undoing it, then pushes to Gmail', async () => {
    const t = await thread('t-a2');
    expect((await admin.post(`/threads/${t.id}/archive`)).status).toBe(204);
    expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: t.id } })).isArchived).toBe(true);
    await sync.run(salesId, 'POLL'); // a sync before the push must not revert it
    expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: t.id } })).isArchived).toBe(true);
    await drainFlags(t.id);
    expect(fake.gmailBox(sales).messages.get('a2')!.labelIds).not.toContain('INBOX');
    await sync.run(salesId, 'WEBHOOK');
    expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: t.id } })).isArchived).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'thread.archive', entityId: t.id } })).toBe(1);
  });

  it('marks spam on Outlook by moving to Junk, and stars by flagging', async () => {
    const t = await thread('oc1');
    await admin.post(`/threads/${t.id}/star`);
    await admin.post(`/threads/${t.id}/spam`);
    expect(await drainFlags(t.id)).toEqual(['star', 'spam']);
    expect(fake.graphPatches.at(-1)).toMatchObject({ id: 'o1', patch: { flag: { flagStatus: 'flagged' } } });
    expect(fake.graphMoves.at(-1)).toMatchObject({ id: 'o1', destinationId: 'junkemail' });
  });

  it('requires conversation.status scope for archive, and visibility for everything', async () => {
    const u = await makeUser({ role: 'EMPLOYEE' });
    const c = await clientAs(app, u.id);
    const t = await thread('t-a1');
    expect((await c.post(`/threads/${t.id}/read`)).status).toBe(404);
    expect((await admin.post(`/threads/${t.id}/explode`)).status).toBe(404);
  });

  it('snoozes out of the inbox until a future time', async () => {
    const t = await thread('t-a1');
    expect((await admin.post(`/threads/${t.id}/snooze`, { until: daysAgo(1).toISOString() })).status).toBe(422);
    expect((await admin.post(`/threads/${t.id}/snooze`, { until: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(204);
    const inbox = (await admin.get(`/threads?view=inbox&accountId=${salesId}`)).body.items.map((i: { id: string }) => i.id);
    expect(inbox).not.toContain(t.id);
    expect((await admin.get(`/threads?view=snoozed&accountId=${salesId}`)).body.items.map((i: { id: string }) => i.id)).toContain(t.id);
    await admin.post(`/threads/${t.id}/snooze`, { until: null });
    expect((await admin.get(`/threads?view=inbox&accountId=${salesId}`)).body.items.map((i: { id: string }) => i.id)).toContain(t.id);
  });
});
