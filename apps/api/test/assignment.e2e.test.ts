import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@crm/crypto';
import { AssignmentService } from '../src/assignment/assignment.service';
import { SendService } from '../src/compose/send.service';
import { EventsHub } from '../src/events/events.service';
import { IngestService } from '../src/mail/ingest.service';
import { QUEUES, QueueService, type SendJob } from '../src/mail/queue.service';
import { SyncService } from '../src/mail/sync.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AttachmentsService } from '../src/threads/attachments.service';
import { AccessPolicy } from '../src/access/access-policy.service';
import { FakeMail } from './fake-mail';
import { bootApp, type Client, clientAs, makeDepartment, makeUser, prisma } from './helpers';
import { connectMailbox, daysAgo, gmailMessage, MAIL_ENV, uniqueMailbox, workerServices } from './mail-helpers';

let fake: FakeMail;
let app: INestApplication;
let admin: Client;
let sync: SyncService;
const sales = uniqueMailbox('sales');
const accounts = uniqueMailbox('accounts');
const hr = uniqueMailbox('hr');
const ids: Record<string, string> = {};
let salesDept: { id: string };
let financeDept: { id: string };
let salesTeam: { id: string };
let people: Record<string, { id: string }>;
const ruleIds: string[] = [];
let seq = 0;

const thread = (providerThreadId: string) => prisma.emailThread.findFirstOrThrow({ where: { providerThreadId } });
/** A new incoming email (after connect), synced the way the worker does. */
async function receive(box: string, over: Parameters<typeof gmailMessage>[2] = {}) {
  const id = `n${++seq}`;
  fake.gmailAdd(box, gmailMessage(box, id, { date: new Date(), ...over }));
  await sync.run(ids[box]!, 'WEBHOOK');
  return thread(`t-${id}`);
}

beforeAll(async () => {
  fake = await new FakeMail().start();
  ({ app } = await bootApp({ mailEndpoints: fake.endpoints(), env: MAIL_ENV }));
  sync = app.get(SyncService);
  admin = await clientAs(app, (await makeUser({ role: 'SUPER_ADMIN' })).id);

  salesDept = await makeDepartment();
  financeDept = await makeDepartment();
  const hrDept = await makeDepartment();
  people = {
    s1: await makeUser({ role: 'EMPLOYEE', departmentId: salesDept.id, name: 'Sales One' }),
    s2: await makeUser({ role: 'EMPLOYEE', departmentId: salesDept.id, name: 'Sales Two' }),
    away: await makeUser({ role: 'EMPLOYEE', departmentId: salesDept.id, name: 'Away' }),
    resting: await makeUser({ role: 'EMPLOYEE', departmentId: salesDept.id, name: 'Out of rotation' }),
    f1: await makeUser({ role: 'EMPLOYEE', departmentId: financeDept.id, name: 'Finance One' }),
    f2: await makeUser({ role: 'EMPLOYEE', departmentId: financeDept.id, name: 'Finance Two' }),
    hr1: await makeUser({ role: 'EMPLOYEE', departmentId: hrDept.id, name: 'HR One' }),
    lead: await makeUser({ role: 'TEAM_LEADER', departmentId: salesDept.id, name: 'Sales Lead' }),
    salesMgr: await makeUser({ role: 'DEPT_MANAGER', departmentId: salesDept.id, name: 'Sales Manager' }),
    vip: await makeUser({ role: 'EMPLOYEE', departmentId: salesDept.id, name: 'VIP Owner' }),
  };
  await prisma.user.update({ where: { id: people.away!.id }, data: { isAbsent: true, absentUntil: new Date(Date.now() + 86_400_000) } });
  salesTeam = await prisma.team.create({ data: { id: newId(), name: `Sales ${newId()}`, departmentId: salesDept.id, leaderId: people.lead!.id } });
  for (const k of ['s1', 's2', 'away', 'resting']) await prisma.teamMember.create({ data: { teamId: salesTeam.id, userId: people[k]!.id, inRotation: k !== 'resting' } });

  for (const box of [sales, accounts, hr]) {
    fake.gmailAdd(box, gmailMessage(box, `hist-${box}`, { date: daysAgo(3), subject: 'Invoice from last week' }));
    ids[box] = await connectMailbox(admin, fake, 'google', box);
    await sync.run(ids[box]!, 'INITIAL');
  }

  const rule = async (body: object) => {
    const r = await admin.post('/assignment-rules', body);
    expect(r.status).toBe(201);
    ruleIds.push(r.body.id);
    return r.body;
  };
  await rule({ name: 'Sales enquiries', conditions: { match: 'all', conditions: [{ field: 'mailbox', op: 'is', value: ids[sales] }] }, targetType: 'TEAM', teamId: salesTeam.id, strategy: 'ROUND_ROBIN', setPriority: 'HIGH' });
  await rule({ name: 'Invoices', conditions: { match: 'all', conditions: [{ field: 'mailbox', op: 'is', value: ids[accounts] }, { field: 'subject', op: 'contains', value: 'invoice' }] }, targetType: 'DEPARTMENT', departmentId: financeDept.id, strategy: 'LEAST_LOADED' });
  await rule({ name: 'HR', conditions: { match: 'all', conditions: [{ field: 'mailbox', op: 'is', value: ids[hr] }] }, targetType: 'USER', targetUserId: people.hr1!.id });
});

afterAll(async () => {
  await prisma.assignment.updateMany({ where: { ruleId: { in: ruleIds } }, data: { ruleId: null } });
  await prisma.assignmentRule.deleteMany({ where: { id: { in: ruleIds } } });
  await app.close();
  fake.stop();
});

describe('routing rules (sales@ / accounts@ / hr@)', () => {
  it('leaves mail imported at connect time alone', async () => {
    for (const box of [sales, accounts, hr]) {
      const t = await thread(`t-hist-${box}`);
      expect(t).toMatchObject({ assigneeId: null, teamId: null, status: 'NEW' });
      expect(await prisma.assignment.count({ where: { threadId: t.id } })).toBe(0);
    }
  });

  it('sales@: round-robin through the team, skipping people away or out of rotation, with priority', async () => {
    const got: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = await receive(sales);
      expect(t).toMatchObject({ teamId: salesTeam.id, departmentId: salesDept.id, priority: 'HIGH', status: 'ASSIGNED' });
      got.push(t.assigneeId!);
    }
    const eligible = [people.s1!.id, people.s2!.id].sort();
    expect(new Set(got)).toEqual(new Set(eligible));
    expect(got[0]).not.toBe(got[1]);
    expect(got[0]).toBe(got[2]);
    const a = await prisma.assignment.findFirstOrThrow({ where: { assigneeId: got[0] }, include: { rule: true } });
    expect(a).toMatchObject({ method: 'ROUND_ROBIN', endedAt: null });
    expect(a.rule?.name).toBe('Sales enquiries');
    expect(await prisma.notification.count({ where: { userId: got[0], type: 'ASSIGNED' } })).toBeGreaterThanOrEqual(2);
  });

  it('accounts@: invoices go to the least-loaded Finance person; other mail stays in the queue', async () => {
    const busy = await receive(accounts, { subject: 'Invoice 1' });
    const first = busy.assigneeId!;
    expect([people.f1!.id, people.f2!.id]).toContain(first);
    const next = await receive(accounts, { subject: 'Re: invoice 2' });
    expect(next.assigneeId).not.toBe(first); // the other one has fewer open conversations
    expect(next.departmentId).toBe(financeDept.id);
    const other = await receive(accounts, { subject: 'Partnership idea' });
    expect(other).toMatchObject({ assigneeId: null, status: 'NEW' });
  });

  it('hr@: always to the HR person', async () => {
    const t = await receive(hr, { subject: 'Leave request' });
    expect(t.assigneeId).toBe(people.hr1!.id);
  });

  it('first matching rule wins; reordering changes the winner', async () => {
    const vip = await admin.post('/assignment-rules', { name: 'VIP client', conditions: { match: 'any', conditions: [{ field: 'fromDomain', op: 'is', value: 'bigclient.com' }] }, targetType: 'USER', targetUserId: people.vip!.id });
    ruleIds.push(vip.body.id);
    const before = await receive(sales, { from: 'CEO <ceo@bigclient.com>' });
    expect(before.assigneeId).not.toBe(people.vip!.id); // Sales rule is earlier
    const all = (await admin.get('/assignment-rules')).body.map((r: { id: string }) => r.id);
    const order = [vip.body.id, ...all.filter((x: string) => x !== vip.body.id)];
    expect((await admin.put('/assignment-rules/order', { ids: order })).status).toBe(200);
    const after = await receive(sales, { from: 'CEO <ceo@bigclient.com>' });
    expect(after.assigneeId).toBe(people.vip!.id);
  });

  it('dry run reports the match and the next person without assigning or advancing', async () => {
    const countBefore = await prisma.assignment.count();
    const r1 = await admin.post('/assignment-rules/test', { sample: { accountId: ids[sales], from: 'someone@x.com', subject: 'Hi' } });
    const r2 = await admin.post('/assignment-rules/test', { sample: { accountId: ids[sales], from: 'someone@x.com', subject: 'Hi' } });
    expect(r1.body.rule.name).toBe('Sales enquiries');
    expect(r1.body.wouldAssignTo.id).toBe(r2.body.wouldAssignTo.id);
    expect(r1.body.checked.find((c: { name: string }) => c.name === 'HR').matched).toBe(false);
    expect(await prisma.assignment.count()).toBe(countBefore);
    const none = await admin.post('/assignment-rules/test', { sample: { accountId: ids[accounts], from: 'a@b.com', subject: 'Partnership' } });
    expect(none.body.rule).toBeNull();
  });

  it('department managers manage only rules routing into their department', async () => {
    const mgr = await clientAs(app, people.salesMgr!.id);
    const names = (await mgr.get('/assignment-rules')).body.map((r: { name: string }) => r.name);
    expect(names).toContain('Sales enquiries');
    expect(names).not.toContain('HR');
    const hrRule = await mgr.post('/assignment-rules', { name: 'x', conditions: { match: 'all', conditions: [{ field: 'subject', op: 'contains', value: 'x' }] }, targetType: 'USER', targetUserId: people.hr1!.id });
    expect(hrRule.status).toBe(403);
    expect((await mgr.put('/assignment-rules/order', { ids: ruleIds })).status).toBe(403);
    expect((await (await clientAs(app, people.s1!.id)).get('/assignment-rules')).status).toBe(403);
  });
});

describe('manual assignment', () => {
  it('stays consistent under 10 simultaneous assignments', async () => {
    const t = await receive(accounts, { subject: 'Race' });
    const targets = Object.values(people).slice(0, 10);
    const results = await Promise.all(targets.map((p) => admin.post(`/threads/${t.id}/assign`, { assigneeId: p.id })));
    expect(results.every((r) => r.status === 204)).toBe(true);
    const current = await prisma.assignment.findMany({ where: { threadId: t.id, endedAt: null } });
    expect(current).toHaveLength(1);
    expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: t.id } })).assigneeId).toBe(current[0]!.assigneeId);
    expect(await prisma.assignment.count({ where: { threadId: t.id } })).toBe(10);
  });

  it('round-robin stays fair when many conversations arrive at once', async () => {
    const svc = app.get(AssignmentService);
    const threads = [];
    for (let i = 0; i < 6; i++) threads.push(await receive(accounts, { subject: `Burst ${i}` }));
    await Promise.all(threads.map((t) => svc.assignToPool(t.id, { teamId: salesTeam.id }, 'ROUND_ROBIN', { method: 'RULE', actor: null })));
    const owners = await prisma.emailThread.findMany({ where: { id: { in: threads.map((t) => t.id) } }, select: { assigneeId: true } });
    const counts = owners.reduce<Record<string, number>>((m, o) => ((m[o.assigneeId!] = (m[o.assigneeId!] ?? 0) + 1), m), {});
    expect(Object.values(counts).sort()).toEqual([3, 3]);
  });

  it('limits who a team leader may assign to, and records history; unassigning reopens', async () => {
    const t = await receive(sales);
    await prisma.emailThread.update({ where: { id: t.id }, data: { assigneeId: null, teamId: salesTeam.id } });
    const lead = await clientAs(app, people.lead!.id);
    const opts = (await lead.get(`/threads/${t.id}/assignees`)).body;
    expect(opts.users.map((u: { id: string }) => u.id)).toContain(people.s2!.id);
    expect(opts.users.map((u: { id: string }) => u.id)).not.toContain(people.f1!.id);
    expect((await lead.post(`/threads/${t.id}/assign`, { assigneeId: people.f1!.id })).status).toBe(422);
    expect((await lead.post(`/threads/${t.id}/assign`, { assigneeId: people.s2!.id, reason: 'knows the client' })).status).toBe(204);
    expect((await (await clientAs(app, people.s1!.id)).post(`/threads/${t.id}/assign`, { assigneeId: people.s1!.id })).status).toBe(403);
    expect((await lead.post(`/threads/${t.id}/unassign`)).status).toBe(204);
    const after = await prisma.emailThread.findUniqueOrThrow({ where: { id: t.id } });
    expect(after).toMatchObject({ assigneeId: null, status: 'NEW' });
    const hist = (await admin.get(`/threads/${t.id}/assignments`)).body;
    expect(hist[0]).toMatchObject({ assignee: { id: people.s2!.id }, reason: 'knows the client', method: 'MANUAL' });
    expect(hist[0].endedAt).not.toBeNull();
  });
});

describe('notes, shares, tags, bulk, presence', () => {
  it('notes: @mention gives access and notifies; only the author edits; notes never go out by email', async () => {
    const t = await receive(hr, { subject: 'Policy question' });
    const outsider = await makeUser({ role: 'EMPLOYEE' });
    const oc = await clientAs(app, outsider.id);
    expect((await oc.get(`/threads/${t.id}`)).status).toBe(404);
    const n = await admin.post(`/threads/${t.id}/notes`, { body: `Internal: client is unhappy, @[${outsider.id}] please check` });
    expect(n.status).toBe(201);
    expect(n.body.mentions).toEqual([{ id: outsider.id, name: outsider.name }]);
    expect((await oc.get(`/threads/${t.id}`)).status).toBe(200);
    expect(await prisma.notification.count({ where: { userId: outsider.id, type: 'NOTE_MENTION' } })).toBe(1);
    expect((await oc.patch(`/threads/${t.id}/notes/${n.body.id}`, { body: 'hijack' })).status).toBe(403);
    expect((await admin.post(`/threads/${t.id}/notes`, { body: '@[nonexistent-user] hi' })).status).toBe(422);

    // A reply sent afterwards contains nothing from the note.
    const prismaSvc = app.get(PrismaService);
    void prismaSvc;
    const { sender } = await workerServices(app);
    const d = (await admin.post('/drafts', { mode: 'REPLY', threadId: t.id })).body;
    await admin.post(`/drafts/${d.id}/send`, { baseThreadVersion: d.baseThreadVersion });
    const boss = await app.get(QueueService).get();
    for (const j of (await boss.findJobs<SendJob>(QUEUES.send, { queued: true })).filter((x) => x.data.draftId === d.id)) await sender.send(j.data);
    expect(fake.gmailSent.at(-1)!.raw).not.toContain('client is unhappy');

    expect((await admin.del(`/threads/${t.id}/notes/${n.body.id}`)).status).toBe(204);
    expect((await admin.get(`/threads/${t.id}/notes`)).body).toEqual([]);
  });

  it('shares grant read, optionally reply, and can be withdrawn', async () => {
    const t = await receive(hr, { subject: 'Share me' });
    const u = await makeUser({ role: 'EMPLOYEE' });
    const c = await clientAs(app, u.id);
    expect((await admin.put(`/threads/${t.id}/shares/${u.id}`, { canReply: false })).status).toBe(204);
    expect((await c.get(`/threads/${t.id}`)).body.canReply).toBe(false);
    await admin.put(`/threads/${t.id}/shares/${u.id}`, { canReply: true });
    expect((await c.get(`/threads/${t.id}`)).body.canReply).toBe(true);
    expect((await admin.get(`/threads/${t.id}`)).body.shares).toEqual([{ user: { id: u.id, name: u.name }, canReply: true }]);
    await admin.del(`/threads/${t.id}/shares/${u.id}`);
    expect((await c.get(`/threads/${t.id}`)).status).toBe(404);
  });

  it('tags are managed by rule managers, applied by readers, and filter the list', async () => {
    const tag = await admin.post('/tags', { name: `Hot lead ${newId().slice(-6)}`, color: '#dc2626' });
    expect(tag.status).toBe(201);
    expect((await (await clientAs(app, people.s1!.id)).post('/tags', { name: 'Nope' })).status).toBe(403);
    const t = await receive(sales);
    const owner = await clientAs(app, t.assigneeId!);
    expect((await owner.put(`/threads/${t.id}/tags/${tag.body.id}`)).status).toBe(204);
    const list = (await admin.get(`/threads?view=all&tagId=${tag.body.id}`)).body.items;
    expect(list.map((i: { id: string }) => i.id)).toEqual([t.id]);
    expect(list[0].tags).toEqual([tag.body]);
  });

  it('bulk-assigns, reporting conversations the caller cannot touch', async () => {
    const a = await receive(hr, { subject: 'Bulk 1' });
    const b = await receive(hr, { subject: 'Bulk 2' });
    const mgr = await clientAs(app, people.salesMgr!.id);
    const r = await mgr.post('/threads/bulk', { threadIds: [a.id, b.id], action: 'assign', assigneeId: people.s1!.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ done: 0, failed: [{ id: a.id, code: 'NOT_FOUND' }, { id: b.id, code: 'NOT_FOUND' }] });
    const ok = await admin.post('/threads/bulk', { threadIds: [a.id, b.id], action: 'assign', teamId: salesTeam.id });
    expect(ok.body).toEqual({ done: 2, failed: [] });
    expect((await prisma.emailThread.findUniqueOrThrow({ where: { id: a.id } })).teamId).toBe(salesTeam.id);
  });

  it('shows who else is looking at or replying to a conversation', async () => {
    const t = await receive(sales);
    const owner = await clientAs(app, t.assigneeId!);
    expect((await owner.post(`/threads/${t.id}/presence`, { state: 'composing' })).status).toBe(204);
    const hub = app.get(EventsHub);
    for (let i = 0; i < 40 && !hub.presenceFor(t.id).length; i++) await new Promise((r) => setTimeout(r, 50));
    const seen = (await admin.get(`/threads/${t.id}`)).body.presence;
    expect(seen).toEqual([{ userId: t.assigneeId, name: expect.any(String), state: 'composing' }]);
    expect((await owner.get(`/threads/${t.id}`)).body.presence).toEqual([]); // not shown to oneself
  });
});
