import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import { DateTime } from 'luxon';
import { RollupService } from '../src/analytics/rollup.service';
import { csvCell } from '../src/analytics/csv';
import { median } from '../src/analytics/analytics.service';
import { bootApp, type Client, clientAs, makeDepartment, makeUser, prisma } from './helpers';

/**
 * Phase 9 exit criterion: dashboard numbers reconcile with direct SQL on a fixed dataset.
 * The dataset is one past week (Mon 3 – Sun 9 Feb 2025, Asia/Kolkata), written straight into the
 * tables so every timestamp is known. Expected figures are computed from the raw rows, not from
 * the report tables.
 */
const TZ = 'Asia/Kolkata';
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toJSDate();
const WEEK = { range: 'custom', from: '2025-02-03', to: '2025-02-09' };
const qs = (o: Record<string, string | undefined>) => '?' + new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined) as [string, string][]).toString();

let app: INestApplication;
let rollup: RollupService;
const stamp = Date.now().toString(36);
let D: { id: string };
let E: { id: string };
const u: Record<string, { id: string; name: string }> = {};
const as: Record<string, Client> = {};
const acc: Record<string, string> = {};
const th: Record<string, string> = {};

let mseq = 0;
async function msg(threadId: string, accountId: string, direction: 'INBOUND' | 'OUTBOUND', when: string, sentBy: string | null = null) {
  await prisma.emailMessage.create({
    data: {
      id: newId(),
      threadId,
      emailAccountId: accountId,
      providerMessageId: `an-${stamp}-${++mseq}`,
      direction,
      fromAddress: direction === 'INBOUND' ? 'client@example.com' : 'us@example.com',
      toRecipients: [],
      subject: 'Analytics fixture',
      receivedAt: at(when),
      sentAt: direction === 'OUTBOUND' ? at(when) : null,
      sentByUserId: sentBy,
    },
  });
}
async function thread(key: string, accountId: string, o: Partial<Prisma.EmailThreadUncheckedCreateInput> & { first: string; last: string }) {
  const { first, last, ...rest } = o;
  th[key] = newId();
  await prisma.emailThread.create({
    data: { id: th[key]!, emailAccountId: accountId, subject: `Fixture ${key}`, normalizedSubject: `fixture ${key}`, firstMessageAt: at(first), lastMessageAt: at(last), ...rest },
  });
  return th[key]!;
}

beforeAll(async () => {
  ({ app } = await bootApp({ env: { REPORT_TIMEZONE: TZ } }));
  rollup = app.get(RollupService);
  D = await makeDepartment(`Analytics D ${stamp}`);
  E = await makeDepartment(`Analytics E ${stamp}`);
  for (const [k, role, dept, name] of [
    ['admin', 'SUPER_ADMIN', null, 'Analytics Admin'],
    ['mgr', 'DEPT_MANAGER', D, 'Analytics Manager'],
    ['lead', 'TEAM_LEADER', D, 'Analytics Lead'],
    ['rep1', 'SALES', D, 'Rep One'],
    ['rep2', 'SALES', D, '=HYPERLINK("x")'],
    ['emp', 'EMPLOYEE', E, 'Emp E'],
  ] as const) {
    u[k] = await makeUser({ role, departmentId: dept?.id ?? null, name });
    as[k] = await clientAs(app, u[k]!.id);
  }
  await prisma.department.update({ where: { id: D.id }, data: { managerId: u.mgr!.id } });
  const team = await prisma.team.create({ data: { id: newId(), name: `Analytics T ${stamp}`, departmentId: D.id, leaderId: u.lead!.id } });
  await prisma.teamMember.create({ data: { teamId: team.id, userId: u.rep1!.id } });
  // Business hours for D: Mon–Fri 09:00–18:00 IST.
  const day: [string, string][] = [['09:00', '18:00']];
  const cal = await prisma.businessCalendar.create({
    data: { id: newId(), name: `Analytics cal ${stamp}`, timezone: TZ, weeklyHours: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: [], sun: [] } },
  });
  await prisma.department.update({ where: { id: D.id }, data: { calendarId: cal.id } });
  const policy = await prisma.slaPolicy.create({ data: { id: newId(), name: `Analytics ${stamp}`, departmentId: D.id, calendarId: cal.id, isEnabled: false } });
  const step = await prisma.slaStep.create({ data: { id: newId(), policyId: policy.id, afterBusinessMinutes: 120, action: 'NOTIFY_ASSIGNEE', marksOverdue: true } });

  for (const [k, dept] of [['A', D], ['B', E]] as const) {
    acc[k] = newId();
    await prisma.emailAccount.create({
      data: { id: acc[k]!, provider: 'IMAP', emailAddress: `analytics-${k.toLowerCase()}-${stamp}@example.com`, departmentId: dept.id, status: 'ACTIVE', connectedById: u.admin!.id },
    });
  }
  const A = acc.A!;
  // t1: two client messages, reply 1 h later; client again at 17:00, reply next morning; closed.
  const t1 = await thread('t1', A, { first: '2025-02-03T10:00', last: '2025-02-04T10:00', assigneeId: u.rep1!.id, teamId: team.id, status: 'CLOSED', closedAt: at('2025-02-04T12:00') });
  await msg(t1, A, 'INBOUND', '2025-02-03T10:00');
  await msg(t1, A, 'INBOUND', '2025-02-03T10:30');
  await msg(t1, A, 'OUTBOUND', '2025-02-03T11:00', u.rep1!.id); // 60 clock / 60 business, first
  await msg(t1, A, 'INBOUND', '2025-02-03T17:00');
  await msg(t1, A, 'OUTBOUND', '2025-02-04T10:00', u.rep1!.id); // 1020 clock / 120 business
  await prisma.statusHistory.create({ data: { id: newId(), threadId: t1, fromStatus: 'IN_PROGRESS', toStatus: 'CLOSED', changedById: u.rep1!.id, source: 'USER', createdAt: at('2025-02-04T12:00') } });
  // t2: weekend mail answered from outside the CRM on Sunday evening (credited to the assignee); SLA breached.
  const t2 = await thread('t2', A, { first: '2025-02-08T10:00', last: '2025-02-09T20:00', assigneeId: u.rep2!.id });
  await msg(t2, A, 'INBOUND', '2025-02-08T10:00');
  await msg(t2, A, 'OUTBOUND', '2025-02-09T20:00'); // 2040 clock / 0 business, first
  await prisma.slaEvent.create({ data: { id: newId(), threadId: t2, stepId: step.id, cycleStart: at('2025-02-08T10:00'), firedAt: at('2025-02-08T12:00') } });
  // t3: unanswered, unassigned, 10 minutes after local midnight (still Sunday in UTC).
  await thread('t3', A, { first: '2025-02-03T00:10', last: '2025-02-03T00:10', awaitingReplySince: at('2025-02-03T00:10'), slaDueAt: at('2025-02-03T11:00') });
  await msg(th.t3!, A, 'INBOUND', '2025-02-03T00:10');
  // t4: spam — never counted.
  await thread('t4', A, { first: '2025-02-05T09:00', last: '2025-02-05T09:00', isSpam: true });
  await msg(th.t4!, A, 'INBOUND', '2025-02-05T09:00');
  // t6: we wrote first (no waiting client → not a reply), client answered (now pending).
  await thread('t6', A, { first: '2025-02-07T10:00', last: '2025-02-07T11:00', assigneeId: u.rep1!.id, awaitingReplySince: at('2025-02-07T11:00') });
  await msg(th.t6!, A, 'OUTBOUND', '2025-02-07T10:00', u.rep1!.id);
  await msg(th.t6!, A, 'INBOUND', '2025-02-07T11:00');
  // t5: the other department.
  await thread('t5', acc.B!, { first: '2025-02-06T14:00', last: '2025-02-06T15:00', assigneeId: u.emp!.id });
  await msg(th.t5!, acc.B!, 'INBOUND', '2025-02-06T14:00');
  await msg(th.t5!, acc.B!, 'OUTBOUND', '2025-02-06T15:00', u.emp!.id);
  // Mail outside the week does not count.
  await msg(t1, A, 'INBOUND', '2025-02-10T09:00');

  // Leads.
  const contact = await prisma.contact.create({ data: { id: newId(), name: `Analytics contact ${stamp}` } });
  const lead = async (o: { owner: string; dept: string; status: 'WON' | 'LOST' | 'NEW'; created: string; path: ('NEW' | 'CONTACTED' | 'INTERESTED' | 'WON' | 'LOST')[]; value?: number }) => {
    const id = newId();
    await prisma.lead.create({
      data: { id, title: 'Fixture lead', contactId: contact.id, source: 'MANUAL', status: o.status, ownerId: o.owner, departmentId: o.dept, estimatedValue: o.value ?? null, createdAt: at(o.created), wonAt: o.status === 'WON' ? at(o.created) : null },
    });
    for (const s of o.path) await prisma.leadStatusHistory.create({ data: { id: newId(), leadId: id, toStatus: s, createdAt: at(o.created) } });
  };
  await lead({ owner: u.rep1!.id, dept: D.id, status: 'WON', created: '2025-02-04T12:00', path: ['NEW', 'CONTACTED', 'WON'], value: 1000 });
  await lead({ owner: u.rep2!.id, dept: D.id, status: 'LOST', created: '2025-02-05T12:00', path: ['NEW', 'INTERESTED', 'LOST'] });
  await lead({ owner: u.emp!.id, dept: E.id, status: 'NEW', created: '2025-02-06T12:00', path: ['NEW'] });

  // Build the report tables for that week (plus the Monday after).
  await rollup.run('rebuild', at('2025-02-03T00:00'), at('2025-02-11T00:00'));
});

afterAll(async () => {
  await prisma.emailAccount.updateMany({ where: { id: { in: Object.values(acc) } }, data: { status: 'PAUSED' } });
  await app?.close();
});

/** Replies computed straight from the stored messages (independent of the rollup SQL). */
async function rawReplies(accountIds: string[]) {
  const msgs = await prisma.emailMessage.findMany({
    where: { emailAccountId: { in: accountIds }, thread: { isSpam: false, isTrashed: false } },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
  });
  const byThread = new Map<string, typeof msgs>();
  for (const m of msgs) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
  const out: { thread: string; clock: number; first: boolean; at: Date }[] = [];
  for (const [t, list] of byThread) {
    let waiting: Date | null = null;
    let n = 0;
    for (const m of list) {
      if (m.direction === 'INBOUND') waiting ??= m.receivedAt;
      else if (waiting) {
        out.push({ thread: t, clock: Math.floor((m.receivedAt.getTime() - waiting.getTime()) / 60_000), first: n++ === 0, at: m.receivedAt });
        waiting = null;
      } else waiting = null;
    }
  }
  const from = at('2025-02-03T00:00');
  const to = at('2025-02-10T00:00');
  return out.filter((r) => r.at >= from && r.at < to);
}

describe('Phase 9: dashboard numbers reconcile with direct SQL', () => {
  it('overview for department D equals direct counts on the source tables', async () => {
    const res = await as.admin!.get('/analytics/overview' + qs({ ...WEEK, departmentId: D.id }));
    expect(res.status).toBe(200);
    const o = res.body;
    expect(o).toMatchObject({ from: '2025-02-03', to: '2025-02-09', timezone: TZ });
    expect(o.asOf).toBeTruthy();

    const from = at('2025-02-03T00:00');
    const to = at('2025-02-10T00:00');
    const [direct] = await prisma.$queryRaw<{ incoming: number; outgoing: number; threads: number; closed: number; breaches: number }[]>(Prisma.sql`
      SELECT
        (SELECT count(*)::int FROM email_messages m JOIN email_threads t ON t.id = m."threadId"
          WHERE m."emailAccountId" = ${acc.A} AND m.direction = 'INBOUND' AND NOT t."isSpam" AND m."receivedAt" >= ${from} AND m."receivedAt" < ${to}) AS incoming,
        (SELECT count(*)::int FROM email_messages m JOIN email_threads t ON t.id = m."threadId"
          WHERE m."emailAccountId" = ${acc.A} AND m.direction = 'OUTBOUND' AND NOT t."isSpam" AND m."receivedAt" >= ${from} AND m."receivedAt" < ${to}) AS outgoing,
        (SELECT count(*)::int FROM email_threads WHERE "emailAccountId" = ${acc.A} AND NOT "isSpam" AND "firstMessageAt" >= ${from} AND "firstMessageAt" < ${to}) AS threads,
        (SELECT count(*)::int FROM status_history h JOIN email_threads t ON t.id = h."threadId"
          WHERE t."emailAccountId" = ${acc.A} AND h."toStatus" = 'CLOSED' AND h."createdAt" >= ${from} AND h."createdAt" < ${to}) AS closed,
        (SELECT count(*)::int FROM sla_events e JOIN email_threads t ON t.id = e."threadId"
          WHERE t."emailAccountId" = ${acc.A} AND e."firedAt" >= ${from} AND e."firedAt" < ${to}) AS breaches`);
    expect(direct).toEqual({ incoming: 6, outgoing: 4, threads: 4, closed: 1, breaches: 1 });
    expect({ incoming: o.incoming, outgoing: o.outgoing, threads: o.newThreads, closed: o.closed, breaches: o.slaBreaches }).toEqual(direct);

    const replies = await rawReplies([acc.A!]);
    expect(replies.map((r) => r.clock).sort((a, b) => a - b)).toEqual([60, 1020, 2040]);
    const avgClock = Math.round(replies.reduce((s, r) => s + r.clock, 0) / replies.length);
    const firsts = replies.filter((r) => r.first);
    expect(o.response).toEqual({
      replies: replies.length,
      avgMinutes: avgClock, // 1040
      avgBusinessMinutes: 60, // (60 + 120 + 0) / 3 in D's Mon–Fri 09–18 calendar
      firstReplies: firsts.length,
      avgFirstMinutes: Math.round(firsts.reduce((s, r) => s + r.clock, 0) / firsts.length), // 1050
      avgFirstBusinessMinutes: 30,
    });

    // Live counts use the inbox conditions.
    expect({ pending: o.pending, unassigned: o.unassigned, overdue: o.overdue, accounts: o.accounts }).toEqual({ pending: 2, unassigned: 1, overdue: 1, accounts: 1 });
    expect(o.ai).toBeNull(); // only company-wide without a department filter
  });

  it('days follow the report time zone (00:10 IST on Monday is Monday, though still Sunday in UTC)', async () => {
    const mon = await as.admin!.get('/analytics/overview' + qs({ range: 'custom', from: '2025-02-03', to: '2025-02-03', departmentId: D.id }));
    expect(mon.body.incoming).toBe(4); // t1 ×3 + t3
    const sun = await as.admin!.get('/analytics/overview' + qs({ range: 'custom', from: '2025-02-02', to: '2025-02-02', departmentId: D.id }));
    expect(sun.body.incoming).toBe(0);
  });

  it('per person, department and mailbox', async () => {
    const byUser = (await as.admin!.get('/analytics/response-times' + qs({ ...WEEK, departmentId: D.id, groupBy: 'user' }))).body as { key: string | null; incoming: number; replies: number; avgMinutes: number | null; avgBusinessMinutes: number | null; closed: number }[];
    const row = (id: string | null) => byUser.find((r) => r.key === id);
    expect(row(u.rep1!.id)).toMatchObject({ incoming: 4, replies: 2, avgMinutes: 540, avgBusinessMinutes: 90, closed: 1 });
    expect(row(u.rep2!.id)).toMatchObject({ incoming: 1, replies: 1, avgMinutes: 2040, avgBusinessMinutes: 0 });
    expect(row(null)).toMatchObject({ name: 'Nobody assigned', incoming: 1, replies: 0, avgMinutes: null });

    const byDept = (await as.admin!.get('/analytics/response-times' + qs({ ...WEEK, groupBy: 'department' }))).body as { key: string; name: string; incoming: number; replies: number }[];
    expect(byDept.find((r) => r.key === D.id)).toMatchObject({ name: D.id && `Analytics D ${stamp}`, incoming: 6, replies: 3 });
    expect(byDept.find((r) => r.key === E.id)).toMatchObject({ incoming: 1, replies: 1 });

    const byAcc = (await as.admin!.get('/analytics/response-times' + qs({ ...WEEK, groupBy: 'account' }))).body as { key: string; incoming: number }[];
    expect(byAcc.find((r) => r.key === acc.A)?.incoming).toBe(6);
  });

  it('workload is live and uses the inbox conditions', async () => {
    const w = (await as.admin!.get('/analytics/workload' + qs({ departmentId: D.id }))).body as { key: string | null; open: number; pending: number; overdue: number }[];
    expect(w.find((r) => r.key === u.rep1!.id)).toMatchObject({ open: 1, pending: 1, overdue: 0 }); // t6 (t1 is closed)
    expect(w.find((r) => r.key === null)).toMatchObject({ open: 1, pending: 1, overdue: 1 }); // t3
    const wd = (await as.admin!.get('/analytics/workload' + qs({ groupBy: 'department', departmentId: D.id }))).body;
    expect(wd).toEqual([expect.objectContaining({ key: D.id, open: 3, pending: 2, overdue: 1 })]);
  });

  it('lead funnel: current stage, stages reached, value won, conversion', async () => {
    const f = (await as.admin!.get('/analytics/leads/funnel' + qs({ ...WEEK, departmentId: D.id }))).body;
    expect(f.total).toBe(2);
    expect(f.won).toBe(1);
    expect(f.lost).toBe(1);
    expect(f.conversionRate).toBe(50);
    expect(f.wonValue).toEqual([{ currency: 'USD', amount: 1000 }]);
    expect(Object.fromEntries(f.reached.map((r: { status: string; count: number }) => [r.status, r.count]))).toEqual({ NEW: 2, CONTACTED: 2, FOLLOW_UP: 2, INTERESTED: 2, PROPOSAL_SENT: 1, NEGOTIATION: 1, WON: 1 });
  });

  it('daily CSV: one row per local day, matching the overview', async () => {
    const res = await as.admin!.get('/analytics/export.csv' + qs({ ...WEEK, departmentId: D.id, report: 'daily' }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('daily-2025-02-03-to-2025-02-09.csv');
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(8);
    const cells = lines.slice(1).map((l) => l.split(','));
    expect(cells.map((c) => c[0])).toEqual(['2025-02-03', '2025-02-04', '2025-02-05', '2025-02-06', '2025-02-07', '2025-02-08', '2025-02-09']);
    expect(cells.reduce((s, c) => s + Number(c[1]), 0)).toBe(6);
    expect(cells[0]!.slice(0, 5)).toEqual(['2025-02-03', '4', '1', '2', '1']);
    expect(await prisma.auditLog.count({ where: { actorId: u.admin!.id, action: 'report.export', entityId: 'daily' } })).toBe(1);
  });
});

describe('Phase 9: scope', () => {
  it('a department manager sees only their department, whatever filter they send', async () => {
    const mine = (await as.mgr!.get('/analytics/overview' + qs(WEEK))).body;
    expect({ incoming: mine.incoming, replies: mine.response.replies, pending: mine.pending }).toEqual({ incoming: 6, replies: 3, pending: 2 });
    const other = (await as.mgr!.get('/analytics/overview' + qs({ ...WEEK, departmentId: E.id }))).body;
    expect({ incoming: other.incoming, pending: other.pending, accounts: other.accounts }).toEqual({ incoming: 0, pending: 0, accounts: 0 });
    const depts = (await as.mgr!.get('/analytics/response-times' + qs({ ...WEEK, groupBy: 'department' }))).body as { key: string }[];
    expect(depts.map((d) => d.key)).toEqual([D.id]);
    const accts = (await as.mgr!.get('/analytics/accounts' + qs(WEEK))).body as { id: string; incoming: number }[];
    expect(accts).toEqual([expect.objectContaining({ id: acc.A, incoming: 6 })]);
    const f = (await as.mgr!.get('/analytics/leads/funnel' + qs(WEEK))).body;
    expect(f.total).toBe(2);
  });

  it('a team leader sees their team and their people', async () => {
    const o = (await as.lead!.get('/analytics/overview' + qs(WEEK))).body;
    expect(o.incoming).toBe(4); // t1 (team) + t6 (rep1)
    expect((await as.lead!.get('/analytics/accounts' + qs(WEEK))).body).toEqual([]);
  });

  it('an employee sees only their own figures', async () => {
    const o = (await as.rep1!.get('/analytics/overview' + qs(WEEK))).body;
    expect({ incoming: o.incoming, replies: o.response.replies, accounts: o.accounts }).toEqual({ incoming: 4, replies: 2, accounts: 0 });
    const users = (await as.rep1!.get('/analytics/response-times' + qs({ ...WEEK, groupBy: 'user' }))).body as { key: string }[];
    expect(users.map((r) => r.key)).toEqual([u.rep1!.id]);
    expect((await as.emp!.get('/analytics/overview' + qs({ ...WEEK, departmentId: D.id }))).body.incoming).toBe(0);
  });

  it('CSV export needs report.export; cells that look like formulas are neutralised', async () => {
    expect((await as.mgr!.get('/analytics/export.csv' + qs({ ...WEEK, report: 'productivity' }))).status).toBe(403);
    const res = await as.admin!.get('/analytics/export.csv' + qs({ ...WEEK, departmentId: D.id, report: 'productivity' }));
    expect(res.status).toBe(200);
    expect(res.text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(res.text).toContain('Rep One,1,1,0,4,');
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('a,b')).toBe('"a,b"');
  });

  it('bad ranges are refused', async () => {
    expect((await as.admin!.get('/analytics/overview' + qs({ range: 'custom', from: '2025-02-09', to: '2025-02-03' }))).status).toBe(422);
    expect((await as.admin!.get('/analytics/overview' + qs({ range: 'custom', from: '2023-01-01', to: '2025-01-01' }))).status).toBe(422);
    expect((await as.admin!.get('/analytics/overview' + qs({ range: 'custom' }))).status).toBe(422);
  });
});

describe('Phase 9: the employee dashboard', () => {
  it('own work, own average against the team median, and what to answer next', async () => {
    const me = (await as.rep1!.get('/analytics/me' + qs(WEEK))).body;
    expect(me).toMatchObject({ assigned: 1, pending: 1, closed: 1, replies: 2, myAvgMinutes: 540, myAvgBusinessMinutes: 90 });
    expect(me.nextUp.map((t: { id: string }) => t.id)).toEqual([th.t6]);
    // rep1's team: rep1 (540) only, and the leader with no replies → median of [540].
    expect(me.teamMedianMinutes).toBe(540);
    expect(median([1, 5, 3, 10])).toBe(4);
  });
});

describe('Phase 9: rollup', () => {
  it('is repeatable and keeps the figures of purged mailboxes', async () => {
    const before = (await as.admin!.get('/analytics/response-times' + qs({ ...WEEK, groupBy: 'account' }))).body as { key: string; incoming: number; replies: number }[];
    await rollup.run('rebuild', at('2025-02-03T00:00'), at('2025-02-11T00:00'));
    const again = (await as.admin!.get('/analytics/response-times' + qs({ ...WEEK, groupBy: 'account' }))).body as { key: string; incoming: number }[];
    expect(again.find((r) => r.key === acc.A)).toEqual(before.find((r) => r.key === acc.A));

    // Mailbox B is purged (mail deleted after disconnect): a rebuild must not erase its figures.
    await prisma.emailThread.deleteMany({ where: { emailAccountId: acc.B } });
    await prisma.emailAccount.update({ where: { id: acc.B }, data: { status: 'DISCONNECTED', purgedAt: new Date() } });
    await rollup.run('rebuild', at('2025-02-03T00:00'), at('2025-02-11T00:00'));
    const after = (await as.admin!.get('/analytics/response-times' + qs({ ...WEEK, groupBy: 'account' }))).body as { key: string; incoming: number; replies: number }[];
    expect(after.find((r) => r.key === acc.B)).toMatchObject({ incoming: 1, replies: 1 });
    expect(await prisma.responseFact.count({ where: { emailAccountId: acc.B } })).toBe(1);
  });

  it('scheduled runs cover the current hours and report when they finished', async () => {
    const r = await rollup.scheduled('fast');
    expect(r.rows).toBeGreaterThanOrEqual(0);
    const run = await prisma.analyticsRun.findFirstOrThrow({ where: { kind: 'fast' }, orderBy: { startedAt: 'desc' } });
    expect(run.error).toBeNull();
    expect(run.toHour.getTime()).toBeGreaterThan(Date.now());
    expect(run.toHour.getTime() - run.fromHour.getTime()).toBe(3 * 3_600_000);
  });
});
