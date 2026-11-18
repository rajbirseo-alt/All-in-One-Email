import type { INestApplication } from '@nestjs/common';
import { createECDH, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import webpush from 'web-push';
import { newId } from '@crm/crypto';
import { APP_CONFIG, type AppConfig } from '../src/config/config';
import { QUEUES, QueueService, type PushJob } from '../src/mail/queue.service';
import { SyncService } from '../src/mail/sync.service';
import { PUSH_HOSTS, PushService } from '../src/notifications/push.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SlaService } from '../src/sla/sla.service';
import { StatusService } from '../src/status/status.service';
import { FakeMail } from './fake-mail';
import { bootApp, type Client, clientAs, makeDepartment, makeUser, prisma } from './helpers';
import { connectMailbox, daysAgo, gmailMessage, MAIL_ENV, uniqueMailbox } from './mail-helpers';

/**
 * Time-travel tests: messages carry fixed past dates (the mailbox is treated as connected long
 * before), and the SLA sweeper runs with an explicit "now".
 */
const vapid = webpush.generateVAPIDKeys();
let fake: FakeMail;
let app: INestApplication;
let base: string;
let sync: SyncService;
let sla: SlaService;
let status: StatusService;
let admin: Client;
let agent: Client;
let outsider: Client;
let manager: Client;
let people: Record<string, { id: string }>;
let dept: { id: string };
let otherDept: { id: string };
let team: { id: string };
let calendarId: string;
let policyId: string;
const box = uniqueMailbox('support');
const historyBox = uniqueMailbox('support-history');
const ids: Record<string, string> = {};
const policies: string[] = [];
let seq = 0;

// Friday 21 Nov 2025 … Wednesday 26 Nov 2025 (Monday 24 Nov is a holiday). India is UTC+5:30. Fixed past dates.
const IST = (local: string) => new Date(`${local}+05:30`);

const thread = (providerThreadId: string) => prisma.emailThread.findFirstOrThrow({ where: { providerThreadId } });
const notes = (userId: string, type?: string) => prisma.notification.findMany({ where: { userId, ...(type ? { type: type as never } : {}) }, orderBy: { createdAt: 'asc' } });

async function receive(over: Parameters<typeof gmailMessage>[2]) {
  const id = `s${++seq}`;
  fake.gmailAdd(box, gmailMessage(box, id, over));
  await sync.run(ids[box]!, 'WEBHOOK');
  return id;
}

function openStream(c: Client) {
  const events: string[] = [];
  let res: IncomingMessage | null = null;
  const ready = new Promise<void>((resolve) => {
    const req = httpRequest(`${base}/api/v1/events`, { headers: { cookie: [...c.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ') } }, (r) => {
      res = r;
      r.on('data', (chunk) => events.push(String(chunk)));
      resolve();
    });
    req.end();
  });
  return { events, ready, close: () => res?.destroy() };
}
const until = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (!(await cond()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return cond();
};

beforeAll(async () => {
  fake = await new FakeMail().start();
  ({ app } = await bootApp({ mailEndpoints: fake.endpoints(), env: { ...MAIL_ENV, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:it@seodiscovery.test' } }));
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  sync = app.get(SyncService);
  sla = app.get(SlaService);
  status = app.get(StatusService);

  dept = await makeDepartment();
  otherDept = await makeDepartment();
  people = {
    admin: await makeUser({ role: 'SUPER_ADMIN' }),
    md: await makeUser({ role: 'MD', name: 'The MD' }),
    agent: await makeUser({ role: 'EMPLOYEE', departmentId: dept.id, name: 'Agent' }),
    leader: await makeUser({ role: 'TEAM_LEADER', departmentId: dept.id, name: 'Leader' }),
    manager: await makeUser({ role: 'DEPT_MANAGER', departmentId: dept.id, name: 'Manager' }),
    outsider: await makeUser({ role: 'EMPLOYEE', departmentId: otherDept.id, name: 'Outsider' }),
  };
  admin = await clientAs(app, people.admin!.id);
  agent = await clientAs(app, people.agent!.id);
  outsider = await clientAs(app, people.outsider!.id);
  manager = await clientAs(app, people.manager!.id);
  await prisma.department.update({ where: { id: dept.id }, data: { managerId: people.manager!.id } });
  team = await prisma.team.create({ data: { id: newId(), name: `Support ${newId()}`, departmentId: dept.id, leaderId: people.leader!.id } });
  await prisma.teamMember.create({ data: { teamId: team.id, userId: people.agent!.id } });

  for (const b of [box, historyBox]) {
    fake.gmailAdd(b, gmailMessage(b, `hist-${b}`, { date: daysAgo(3), subject: 'Old enquiry' }));
    ids[b] = await connectMailbox(admin, fake, 'google', b);
    await sync.run(ids[b]!, 'INITIAL');
    await prisma.emailAccount.update({ where: { id: ids[b]! }, data: { departmentId: dept.id } });
  }
  // The support mailbox was "connected" long ago, so the dated test mail below is live mail, not history.
  await prisma.emailAccount.update({ where: { id: ids[box]! }, data: { createdAt: new Date('2025-01-01T00:00:00Z') } });

  const cal = await admin.post('/calendars', { name: `India office ${newId()}`, timezone: 'Asia/Kolkata', weeklyHours: { mon: [['09:30', '18:30']], tue: [['09:30', '18:30']], wed: [['09:30', '18:30']], thu: [['09:30', '18:30']], fri: [['09:30', '18:30']], sat: [], sun: [] } });
  expect(cal.status).toBe(201);
  calendarId = cal.body.id;
  expect((await admin.post(`/calendars/${calendarId}/holidays`, { date: '2025-11-24', name: 'Company holiday' })).status).toBe(201);

  const p = await admin.post('/sla-policies', {
    name: 'Support',
    departmentId: dept.id,
    calendarId,
    steps: [
      { afterBusinessMinutes: 0, action: 'NOTIFY_ASSIGNEE' },
      { afterBusinessMinutes: 60, action: 'REMIND_ASSIGNEE' },
      { afterBusinessMinutes: 120, action: 'ALERT_MANAGER', marksOverdue: true },
      { afterBusinessMinutes: 480, action: 'ESCALATE' },
    ],
  });
  expect(p.status).toBe(201);
  policyId = p.body.id;
  policies.push(policyId);
  // Saved "before" the dated test mail, so its steps alert (steps already due at save time are recorded silently).
  await prisma.slaPolicy.update({ where: { id: policyId }, data: { updatedAt: new Date('2025-01-01T00:00:00Z') } });
});

afterAll(async () => {
  PUSH_HOSTS.allowHttpLocalhost = false;
  await prisma.emailThread.updateMany({ where: { slaPolicyId: { in: policies } }, data: { slaPolicyId: null } });
  await prisma.slaPolicy.deleteMany({ where: { id: { in: policies } } });
  await app?.close();
  fake?.stop();
});

describe('SLA clock (business hours, weekends, holidays, time zone)', () => {
  let t: Awaited<ReturnType<typeof thread>>;

  it('imported history never starts a clock', async () => {
    const h = await thread(`t-hist-${historyBox}`);
    expect(h.awaitingReplySince).not.toBeNull();
    expect(h.slaDueAt).toBeNull();
    expect(h.slaNextAt).toBeNull();
  });

  it('a client email on Friday 17:30 IST is due Tuesday 10:30 IST (weekend and Monday holiday skipped)', async () => {
    const id = await receive({ date: IST('2025-11-21T17:30:00'), subject: 'Need help with my order' });
    t = await thread(`t-${id}`);
    expect((await admin.post(`/threads/${t.id}/assign`, { assigneeId: people.agent!.id })).status).toBe(204);
    t = await thread(`t-${id}`);
    expect(t.slaPolicyId).toBe(policyId);
    expect(t.slaDueAt?.toISOString()).toBe(IST('2025-11-25T10:30:00').toISOString());
    // The first step (0 minutes) is due at once.
    expect(t.slaNextAt?.toISOString()).toBe(IST('2025-11-21T17:30:00').toISOString());

    const detail = await agent.get(`/threads/${t.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.slaDueAt).toBe(IST('2025-11-25T10:30:00').toISOString());
    expect(detail.body.sla.policy.name).toBe('Support');
    expect(detail.body.sla.timezone).toBe('Asia/Kolkata');
    expect(detail.body.sla.steps.map((s: { dueAt: string }) => s.dueAt)).toEqual([
      IST('2025-11-21T17:30:00').toISOString(),
      IST('2025-11-21T18:30:00').toISOString(),
      IST('2025-11-25T10:30:00').toISOString(),
      IST('2025-11-25T16:30:00').toISOString(),
    ]);
  });

  it('fires each step once, at its business time', async () => {
    await sla.sweep(IST('2025-11-21T17:31:00'));
    expect((await notes(people.agent!.id, 'SLA_REMINDER')).map((n) => n.title)).toEqual(['Waiting for a reply: Need help with my order']);

    await sla.sweep(IST('2025-11-21T18:31:00'));
    const reminders = await notes(people.agent!.id, 'SLA_REMINDER');
    expect(reminders).toHaveLength(2);
    expect(reminders[1]!.body).toBe('Reply due by 25 Nov, 10:30 am');

    // Saturday, and the Monday holiday: nothing new, and not overdue yet.
    await sla.sweep(IST('2025-11-22T12:00:00'));
    await sla.sweep(IST('2025-11-24T17:00:00'));
    expect(await notes(people.manager!.id, 'SLA_OVERDUE')).toHaveLength(0);
    expect((await thread(t.providerThreadId!)).slaBreachedAt).toBeNull();

    // Tuesday 10:30 IST: overdue → the department manager is alerted (no team queue), conversation marked breached.
    await sla.sweep(IST('2025-11-25T10:31:00'));
    const alerts = await notes(people.manager!.id, 'SLA_OVERDUE');
    expect(alerts.map((n) => n.title)).toEqual(['Overdue: Need help with my order']);
    expect(alerts[0]!.body).toBe('Assigned to Agent · was due 25 Nov, 10:30 am');
    expect((await thread(t.providerThreadId!)).slaBreachedAt?.toISOString()).toBe(IST('2025-11-25T10:30:00').toISOString());

    // Running the sweep again (or a second worker) never alerts twice.
    await sla.sweep(IST('2025-11-25T10:35:00'));
    await sla.sweep(IST('2025-11-25T10:35:00'));
    expect(await notes(people.manager!.id, 'SLA_OVERDUE')).toHaveLength(1);
    expect(await notes(people.agent!.id, 'SLA_REMINDER')).toHaveLength(2);

    // 16:30 IST: escalated to the MD.
    await sla.sweep(IST('2025-11-25T16:31:00'));
    expect((await notes(people.md!.id, 'SLA_ESCALATED')).map((n) => n.title)).toEqual(['Escalated: Need help with my order']);
    expect((await thread(t.providerThreadId!)).slaNextAt).toBeNull();
  });

  it('lists the conversation in the overdue view, for those who can see it', async () => {
    const o = await admin.get('/threads?view=overdue');
    expect(o.body.items.map((i: { id: string }) => i.id)).toContain(t.id);
    expect((await agent.get('/threads?view=overdue')).body.items.map((i: { id: string }) => i.id)).toEqual([t.id]);
    expect((await outsider.get('/threads?view=overdue')).body.items).toEqual([]);
    expect((await agent.get('/threads/counts')).body.overdue).toBe(1);
  });

  it('our reply stops the clock and waits for the client; the client’s answer starts a new cycle', async () => {
    fake.gmailAdd(box, { ...gmailMessage(box, `r${++seq}`, { threadId: t.providerThreadId!, date: IST('2025-11-25T17:00:00'), subject: 'Re: Need help with my order' }), from: box, to: 'client@acme.com', labelIds: ['SENT'] });
    await sync.run(ids[box]!, 'WEBHOOK');
    let now = await thread(t.providerThreadId!);
    expect(now.status).toBe('WAITING_FOR_CLIENT');
    expect(now.slaDueAt).toBeNull();
    expect(now.slaBreachedAt).toBeNull();
    expect((await agent.get('/threads?view=overdue')).body.items).toEqual([]);

    fake.gmailAdd(box, gmailMessage(box, `c${++seq}`, { threadId: t.providerThreadId!, date: IST('2025-11-26T10:00:00'), subject: 'Re: Need help with my order', text: 'Thanks, one more question' }));
    await sync.run(ids[box]!, 'WEBHOOK');
    now = await thread(t.providerThreadId!);
    expect(now.status).toBe('PENDING_REPLY');
    expect(now.slaDueAt?.toISOString()).toBe(IST('2025-11-26T12:00:00').toISOString());
    expect((await notes(people.agent!.id, 'CLIENT_REPLIED')).map((n) => n.title)).toEqual(['New reply: Need help with my order']);

    // New cycle: its first step fires again (once).
    await sla.sweep(IST('2025-11-26T10:01:00'));
    expect(await notes(people.agent!.id, 'SLA_REMINDER')).toHaveLength(3);

    const h = await agent.get(`/threads/${t.id}/status-history`);
    expect(h.body.slice(0, 2).map((e: { to: string; source: string }) => `${e.source}:${e.to}`)).toEqual(['INBOUND_MESSAGE:PENDING_REPLY', 'OUTBOUND_MESSAGE:WAITING_FOR_CLIENT']);
  });

  it('a conversation waiting in a team queue alerts the team leader', async () => {
    const id = await receive({ date: IST('2025-11-26T09:30:00'), subject: 'Queue question' });
    const q = await thread(`t-${id}`);
    expect((await admin.post(`/threads/${q.id}/assign`, { teamId: team.id })).status).toBe(204);
    await sla.sweep(IST('2025-11-26T11:31:00'));
    expect((await notes(people.leader!.id, 'SLA_REMINDER')).map((n) => n.title)).toEqual(['Waiting for a reply: Queue question', 'Reply overdue: Queue question']);
    expect((await notes(people.leader!.id, 'SLA_OVERDUE')).map((n) => n.title)).toEqual(['Overdue: Queue question']);
    expect((await notes(people.leader!.id, 'SLA_OVERDUE'))[0]!.body).toBe('Not assigned to anyone · was due 26 Nov, 11:30 am');
  });

  it('a calendar change moves running due times without alerting retroactively', async () => {
    const before = (await thread(t.providerThreadId!)).slaDueAt;
    // Open at 08:00 instead: Wednesday 10:00 + 120 business minutes is still 12:00 (all inside hours).
    const all = { mon: [['08:00', '18:30']], tue: [['08:00', '18:30']], wed: [['08:00', '18:30']], thu: [['08:00', '18:30']], fri: [['08:00', '18:30']], sat: [], sun: [] };
    expect((await admin.put(`/calendars/${calendarId}`, { name: 'India office', timezone: 'Asia/Kolkata', weeklyHours: all })).status).toBe(200);
    expect((await thread(t.providerThreadId!)).slaDueAt).toEqual(before);
    // The policy now counts as saved "today", so steps of this (past) cycle are recorded without alerts.
    const managerAlerts = (await notes(people.manager!.id, 'SLA_OVERDUE')).length;
    await sla.sweep(IST('2025-11-26T23:00:00'));
    expect((await notes(people.manager!.id, 'SLA_OVERDUE')).length).toBe(managerAlerts);
    expect((await thread(t.providerThreadId!)).slaBreachedAt).not.toBeNull();
  });
});

describe('status changes', () => {
  let t: Awaited<ReturnType<typeof thread>>;

  beforeAll(async () => {
    const id = await receive({ date: new Date(), subject: 'Status test' });
    t = await thread(`t-${id}`);
    expect((await admin.post(`/threads/${t.id}/assign`, { assigneeId: people.agent!.id })).status).toBe(204);
  });

  it('the assignee moves through working statuses with history and audit', async () => {
    expect((await agent.post(`/threads/${t.id}/status`, { status: 'IN_PROGRESS', reason: 'looking into it' })).status).toBe(204);
    expect((await thread(t.providerThreadId!)).status).toBe('IN_PROGRESS');
    expect((await agent.post(`/threads/${t.id}/status`, { status: 'CLOSED' })).status).toBe(204);
    const closed = await thread(t.providerThreadId!);
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedAt).not.toBeNull();
    expect(closed.slaDueAt).toBeNull();
    expect((await agent.post(`/threads/${t.id}/status`, { status: 'OPEN' })).status).toBe(204);
    const open = await thread(t.providerThreadId!);
    expect(open.status).toBe('ASSIGNED');
    expect(open.closedAt).toBeNull();
    expect(open.slaDueAt).not.toBeNull();
    expect((await agent.post(`/threads/${t.id}/status`, { status: 'OPEN' })).body.error.code).toBe('ALREADY_OPEN');

    const h = (await agent.get(`/threads/${t.id}/status-history`)).body;
    expect(h.slice(0, 3).map((e: { to: string; source: string; changedBy: { name: string } | null }) => `${e.source}:${e.to}:${e.changedBy?.name}`)).toEqual([
      'USER:ASSIGNED:Agent',
      'USER:CLOSED:Agent',
      'USER:IN_PROGRESS:Agent',
    ]);
    expect(h[2].reason).toBe('looking into it');
    expect(await prisma.auditLog.count({ where: { entityId: t.id, action: 'thread.status' } })).toBe(3);
  });

  it('rejects NEW/ASSIGNED as manual targets and hides other people’s conversations', async () => {
    expect((await agent.post(`/threads/${t.id}/status`, { status: 'ASSIGNED' })).status).toBe(422);
    expect((await outsider.post(`/threads/${t.id}/status`, { status: 'CLOSED' })).status).toBe(404);
    expect((await outsider.get(`/threads/${t.id}/status-history`)).status).toBe(404);
  });

  it('a follow-up date turns into "Follow-up required" and tells the assignee', async () => {
    const at = new Date(Date.now() + 3_600_000);
    expect((await agent.post(`/threads/${t.id}/status`, { status: 'WAITING_FOR_CLIENT', followUpAt: at.toISOString() })).status).toBe(204);
    expect((await thread(t.providerThreadId!)).followUpAt?.toISOString()).toBe(at.toISOString());
    expect(await status.followUpSweep(new Date())).toBe(0);
    expect(await status.followUpSweep(new Date(Date.now() + 2 * 3_600_000))).toBe(1);
    const now = await thread(t.providerThreadId!);
    expect(now.status).toBe('FOLLOW_UP_REQUIRED');
    expect(now.followUpAt).toBeNull();
    expect((await notes(people.agent!.id, 'FOLLOW_UP_DUE')).map((n) => n.title)).toEqual(['Follow up: Status test']);
    expect((await agent.post(`/threads/${t.id}/status`, { status: 'CLOSED', followUpAt: at.toISOString() })).status).toBe(422);
  });

  it('priority changes pick the matching SLA policy', async () => {
    const urgent = await admin.post('/sla-policies', { name: 'Support urgent', departmentId: dept.id, priority: 'URGENT', calendarId, steps: [{ afterBusinessMinutes: 15, action: 'ALERT_MANAGER', marksOverdue: true }] });
    expect(urgent.status).toBe(201);
    policies.push(urgent.body.id);
    expect((await agent.post(`/threads/${t.id}/status`, { status: 'IN_PROGRESS' })).status).toBe(204);
    expect((await agent.post(`/threads/${t.id}/priority`, { priority: 'URGENT' })).status).toBe(204);
    expect((await thread(t.providerThreadId!)).slaPolicyId).toBe(urgent.body.id);
    expect((await agent.post(`/threads/${t.id}/priority`, { priority: 'NORMAL' })).status).toBe(204);
    expect((await thread(t.providerThreadId!)).slaPolicyId).toBe(policyId);
  });
});

describe('SLA administration', () => {
  const steps = [{ afterBusinessMinutes: 30, action: 'REMIND_ASSIGNEE', marksOverdue: true }];

  it('validates policies and calendars', async () => {
    expect((await admin.post('/sla-policies', { name: 'Clash', departmentId: dept.id, calendarId, steps })).body.error.code).toBe('POLICY_OVERLAP');
    expect((await admin.post('/sla-policies', { name: 'No overdue', departmentId: otherDept.id, calendarId, steps: [{ afterBusinessMinutes: 30, action: 'REMIND_ASSIGNEE' }] })).status).toBe(422);
    expect((await admin.post('/sla-policies', { name: 'Nothing', calendarId, steps })).status).toBe(422);
    expect((await admin.post('/calendars', { name: 'Bad', timezone: 'Mars/Olympus', weeklyHours: { mon: [['09:00', '17:00']], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } })).status).toBe(422);
    expect((await admin.post('/calendars', { name: 'Closed', timezone: 'Asia/Kolkata', weeklyHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } })).status).toBe(422);
    expect((await admin.post(`/calendars/${calendarId}/holidays`, { date: '2025-11-24', name: 'Again' })).body.error.code).toBe('DUPLICATE_HOLIDAY');
    expect((await admin.post(`/calendars/${calendarId}/holidays`, { date: '2026-02-30', name: 'Not a day' })).status).toBe(422);
    expect((await admin.del(`/calendars/${calendarId}`)).body.error.code).toBe('CALENDAR_IN_USE');
  });

  it('department managers manage only their own department’s policies', async () => {
    const list = await manager.get('/sla-policies');
    expect(list.status).toBe(200);
    expect(list.body.find((p: { id: string }) => p.id === policyId).canEdit).toBe(true);
    expect((await manager.post('/sla-policies', { name: 'Elsewhere', departmentId: otherDept.id, calendarId, steps })).status).toBe(403);
    expect((await manager.post('/sla-policies', { name: 'Default', isDefault: true, calendarId, steps })).status).toBe(403);
    expect((await manager.post('/calendars', { name: 'Mine', timezone: 'Asia/Kolkata', weeklyHours: { mon: [['09:00', '17:00']], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } })).status).toBe(403);
    expect((await manager.get('/calendars')).status).toBe(200);
    const own = await manager.post('/sla-policies', { name: 'Support low', departmentId: dept.id, priority: 'LOW', calendarId, steps });
    expect(own.status).toBe(201);
    policies.push(own.body.id);
    expect((await manager.put(`/sla-policies/${own.body.id}`, { name: 'Support low (edited)', departmentId: dept.id, priority: 'LOW', calendarId, steps })).body.name).toBe('Support low (edited)');
    const foreign = await admin.post('/sla-policies', { name: 'Other dept', departmentId: otherDept.id, calendarId, steps });
    policies.push(foreign.body.id);
    expect((await manager.del(`/sla-policies/${foreign.body.id}`)).status).toBe(404);
    expect((await manager.del(`/sla-policies/${own.body.id}`)).status).toBe(204);
  });

  it('employees cannot see SLA settings', async () => {
    expect((await agent.get('/sla-policies')).status).toBe(403);
    expect((await agent.get('/calendars')).status).toBe(403);
  });
});

describe('notifications', () => {
  it('each employee sees and clears only their own', async () => {
    const mine = await agent.get('/notifications');
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThan(3);
    expect(mine.body.items.every((n: { id: string }) => n.id)).toBe(true);
    expect((await agent.get('/notifications/unread-count')).body.unread).toBe(mine.body.unread);

    const managerNote = (await notes(people.manager!.id))[0]!;
    expect((await agent.post(`/notifications/${managerNote.id}/read`)).status).toBe(404);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: managerNote.id } })).readAt).toBeNull();

    expect((await agent.post(`/notifications/${mine.body.items[0].id}/read`)).status).toBe(204);
    expect((await agent.get('/notifications/unread-count')).body.unread).toBe(mine.body.unread - 1);
    expect((await agent.get('/notifications?unread=true')).body.items.some((n: { id: string }) => n.id === mine.body.items[0].id)).toBe(false);
    expect((await agent.post('/notifications/read-all')).status).toBe(204);
    expect((await agent.get('/notifications/unread-count')).body.unread).toBe(0);
    expect((await prisma.notification.count({ where: { userId: people.manager!.id, readAt: null } })) > 0).toBe(true);
  });

  it('pages with a cursor', async () => {
    const p1 = await agent.get('/notifications?limit=2');
    expect(p1.body.items).toHaveLength(2);
    const p2 = await agent.get(`/notifications?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
    expect(new Date(p2.body.items[0].createdAt) <= new Date(p1.body.items[1].createdAt)).toBe(true);
  });

  it('the bell updates live, only on the owner’s stream', async () => {
    const a = openStream(agent);
    const o = openStream(outsider);
    await Promise.all([a.ready, o.ready]);
    await new Promise((r) => setTimeout(r, 200));
    const id = await receive({ date: new Date(), subject: 'Live bell' });
    const tt = await thread(`t-${id}`);
    expect((await admin.post(`/threads/${tt.id}/assign`, { assigneeId: people.agent!.id })).status).toBe(204);
    expect(await until(() => a.events.join('').includes('event: notification'))).toBe(true);
    expect(o.events.join('').includes('event: notification')).toBe(false);
    a.close();
    o.close();
  });

  it('preferences switch a kind off for the bell', async () => {
    const prefs = await agent.get('/notification-preferences');
    expect(prefs.body.pushAvailable).toBe(true);
    expect(prefs.body.items.find((i: { type: string }) => i.type === 'ASSIGNED')).toMatchObject({ inApp: true, push: true });
    const put = await agent.put('/notification-preferences', { items: [{ type: 'ASSIGNED', inApp: false, push: false }] });
    expect(put.body.items.find((i: { type: string }) => i.type === 'ASSIGNED')).toMatchObject({ inApp: false, push: false });
    expect((await agent.put('/notification-preferences', { items: [{ type: 'LEAD_ASSIGNED', inApp: false, push: false }] })).status).toBe(422);

    const before = (await notes(people.agent!.id, 'ASSIGNED')).length;
    const id = await receive({ date: new Date(), subject: 'Quiet assignment' });
    expect((await admin.post(`/threads/${(await thread(`t-${id}`)).id}/assign`, { assigneeId: people.agent!.id })).status).toBe(204);
    expect((await notes(people.agent!.id, 'ASSIGNED')).length).toBe(before);
    await agent.put('/notification-preferences', { items: [{ type: 'ASSIGNED', inApp: true, push: true }] });
  });
});

describe('browser push', () => {
  let server: Server;
  let endpoint: string;
  const received: { headers: IncomingMessage['headers']; body: Buffer; path: string }[] = [];
  let reply = 201;
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks), path: req.url ?? '' });
        res.statusCode = reply;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/push/${newId()}`;
  });
  afterAll(() => server?.close());

  it('only accepts real browser push services as endpoints', async () => {
    expect((await agent.post('/push-subscriptions', { endpoint: 'https://internal.example.com/hook', keys })).status).toBe(422);
    expect((await agent.post('/push-subscriptions', { endpoint, keys })).status).toBe(422);
    const cfg = await agent.get('/push-subscriptions/config');
    expect(cfg.body).toEqual({ enabled: true, publicKey: vapid.publicKey });
  });

  it('queues a push for subscribed devices and delivers it encrypted with VAPID', async () => {
    PUSH_HOSTS.allowHttpLocalhost = true;
    expect((await agent.post('/push-subscriptions', { endpoint, keys })).status).toBe(204);
    expect((await agent.get('/push-subscriptions')).body.map((d: { endpoint: string }) => d.endpoint)).toEqual([endpoint]);

    const boss = await app.get(QueueService).get();
    await boss.fetch(QUEUES.push, { batchSize: 100 }); // drain older jobs
    const id = await receive({ date: new Date(), subject: 'Pushed assignment' });
    expect((await admin.post(`/threads/${(await thread(`t-${id}`)).id}/assign`, { assigneeId: people.agent!.id })).status).toBe(204);
    const jobs = (await boss.fetch<PushJob>(QUEUES.push, { batchSize: 10 })) ?? [];
    const job = jobs.find((j) => j.data.userId === people.agent!.id)!;
    expect(job.data.title).toBe('Assigned to you: Pushed assignment');
    expect(job.data.url).toMatch(/^\/inbox\?thread=/);

    const push = new PushService(app.get(PrismaService), app.get<AppConfig>(APP_CONFIG));
    expect(await push.send(job.data)).toEqual({ sent: 1, removed: 0 });
    const got = received.at(-1)!;
    expect(got.headers['content-encoding']).toBe('aes128gcm');
    expect(String(got.headers.authorization)).toMatch(/^vapid t=.+, k=/);
    expect(got.body.includes(Buffer.from('Pushed assignment'))).toBe(false); // end-to-end encrypted
  });

  it('forgets a device the push service reports as gone', async () => {
    reply = 410;
    const push = new PushService(app.get(PrismaService), app.get<AppConfig>(APP_CONFIG));
    expect(await push.send({ userId: people.agent!.id, title: 'x', body: null, url: '/inbox', tag: 'x' })).toEqual({ sent: 0, removed: 1 });
    expect((await agent.get('/push-subscriptions')).body).toEqual([]);
  });
});
