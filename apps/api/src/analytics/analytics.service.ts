import { Injectable } from '@nestjs/common';
import { Prisma } from '@crm/db';
import { DateTime } from 'luxon';
import type { z } from 'zod';
import type {
  AccountHealthRow,
  AnalyticsOverview,
  AnalyticsRange,
  LeadFunnel,
  MdDashboard,
  MyDashboard,
  ResponseAverages,
  ResponseTimeRow,
  TrendPoint,
  TrendsResult,
  WorkloadRow,
  analyticsRangeQuery,
  trendsQuery,
} from '@crm/shared';
import { AccessPolicy } from '../access/access-policy.service';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { RollupService } from './rollup.service';

type RangeQuery = z.infer<typeof analyticsRangeQuery>;
type TrendsQuery = z.infer<typeof trendsQuery>;

const NONE = Prisma.sql`FALSE`;
const LEAD_STAGES = ['NEW', 'CONTACTED', 'FOLLOW_UP', 'INTERESTED', 'PROPOSAL_SENT', 'NEGOTIATION', 'WON'] as const;
const LEAD_STATUSES = [...LEAD_STAGES, 'LOST'] as const;

/** Which figures the caller may see: report.read scope (docs/05), optionally narrowed to one department. */
interface ReportScope {
  level: 'ALL' | 'DEPARTMENT' | 'TEAM' | 'OWN' | 'NONE';
  /** For analytics_hourly / analytics_response_facts (unqualified columns). */
  sql: Prisma.Sql;
  thread: Prisma.EmailThreadWhereInput;
  lead: Prisma.LeadWhereInput;
  account: Prisma.EmailAccountWhereInput;
}

interface Sums {
  incoming: number;
  outgoing: number;
  newThreads: number;
  replies: number;
  replyMinutes: number;
  replyBizMinutes: number;
  replyBizCount: number;
  firstReplies: number;
  firstReplyMinutes: number;
  firstReplyBizMinutes: number;
  firstReplyBizCount: number;
  closed: number;
  slaBreaches: number;
}

const SUMS = Prisma.sql`
  COALESCE(sum(incoming), 0)::int AS incoming, COALESCE(sum(outgoing), 0)::int AS outgoing, COALESCE(sum("newThreads"), 0)::int AS "newThreads",
  COALESCE(sum(replies), 0)::int AS replies, COALESCE(sum("replyMinutes"), 0)::float8 AS "replyMinutes",
  COALESCE(sum("replyBizMinutes"), 0)::float8 AS "replyBizMinutes", COALESCE(sum("replyBizCount"), 0)::int AS "replyBizCount",
  COALESCE(sum("firstReplies"), 0)::int AS "firstReplies", COALESCE(sum("firstReplyMinutes"), 0)::float8 AS "firstReplyMinutes",
  COALESCE(sum("firstReplyBizMinutes"), 0)::float8 AS "firstReplyBizMinutes", COALESCE(sum("firstReplyBizCount"), 0)::int AS "firstReplyBizCount",
  COALESCE(sum(closed), 0)::int AS closed, COALESCE(sum("slaBreaches"), 0)::int AS "slaBreaches"`;

const avg = (sum: number, n: number) => (n > 0 ? Math.round(sum / n) : null);
export function averages(s: Sums): ResponseAverages {
  return {
    replies: s.replies,
    avgMinutes: avg(s.replyMinutes, s.replies),
    avgBusinessMinutes: avg(s.replyBizMinutes, s.replyBizCount),
    firstReplies: s.firstReplies,
    avgFirstMinutes: avg(s.firstReplyMinutes, s.firstReplies),
    avgFirstBusinessMinutes: avg(s.firstReplyBizMinutes, s.firstReplyBizCount),
  };
}
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/**
 * Dashboards and reports (docs/03 "Analytics"). Range figures come from the hourly rollup
 * (RollupService); "right now" figures (pending, overdue, unassigned…) are counted live with the
 * same conditions as the inbox views. Everything is limited to the caller's report.read scope.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly rollup: RollupService,
  ) {}

  get timezone() {
    return this.rollup.timezone;
  }

  // ───────────── range and scope ─────────────

  /** [from, to) instants of a range in the report time zone. */
  resolveRange(q: Pick<RangeQuery, 'range' | 'from' | 'to'>, now = new Date()) {
    const zone = this.timezone;
    const today = DateTime.fromJSDate(now, { zone }).startOf('day');
    let start: DateTime;
    let endDay: DateTime; // inclusive
    switch (q.range) {
      case 'today':
        [start, endDay] = [today, today];
        break;
      case 'yesterday':
        [start, endDay] = [today.minus({ days: 1 }), today.minus({ days: 1 })];
        break;
      case 'month':
        [start, endDay] = [today.minus({ days: 29 }), today];
        break;
      case 'custom':
        start = DateTime.fromISO(q.from!, { zone }).startOf('day');
        endDay = DateTime.fromISO(q.to!, { zone }).startOf('day');
        break;
      case 'week':
      default:
        [start, endDay] = [today.minus({ days: 6 }), today];
    }
    return { from: start.toJSDate(), to: endDay.plus({ days: 1 }).toJSDate(), fromDate: start.toISODate()!, toDate: endDay.toISODate()! };
  }

  private async rangeInfo(q: RangeQuery, r: ReturnType<AnalyticsService['resolveRange']>): Promise<AnalyticsRange> {
    const asOf = await this.rollup.asOf();
    return { range: q.range, from: r.fromDate, to: r.toDate, timezone: this.timezone, asOf: asOf?.toISOString() ?? null };
  }

  /** Members of the teams the caller leads (team leaders see their people's figures). */
  private async ledMembers(ctx: RequestContext) {
    const rows = await this.prisma.teamMember.findMany({ where: { team: { leaderId: ctx.userId } }, select: { userId: true } });
    return [...new Set([ctx.userId, ...rows.map((r) => r.userId)])];
  }

  async scope(ctx: RequestContext, departmentId?: string | null): Promise<ReportScope> {
    const s = ctx.permissions['report.read'];
    let out: ReportScope;
    if (s === 'ALL') {
      out = { level: 'ALL', sql: Prisma.sql`TRUE`, thread: {}, lead: {}, account: {} };
    } else if (s === 'DEPARTMENT') {
      const depts = await this.access.departmentIds(ctx);
      out = {
        level: 'DEPARTMENT',
        sql: Prisma.sql`"departmentId" = ANY(${depts}::text[])`,
        thread: { OR: [{ departmentId: { in: depts } }, { departmentId: null, emailAccount: { departmentId: { in: depts } } }] },
        lead: { OR: [{ departmentId: { in: depts } }, { owner: { departmentId: { in: depts } } }] },
        account: { departmentId: { in: depts } },
      };
    } else if (s === 'TEAM') {
      const [teams, people] = await Promise.all([this.access.teamIds(ctx), this.ledMembers(ctx)]);
      out = {
        level: 'TEAM',
        sql: Prisma.sql`("teamId" = ANY(${teams}::text[]) OR "userId" = ANY(${people}::text[]))`,
        thread: { OR: [{ teamId: { in: teams } }, { assigneeId: { in: people } }] },
        lead: { OR: [{ ownerId: { in: people } }, { sourceThread: { teamId: { in: teams } } }] },
        account: { id: { in: [] } },
      };
    } else if (s) {
      out = { level: 'OWN', sql: Prisma.sql`"userId" = ${ctx.userId}`, thread: { assigneeId: ctx.userId }, lead: { ownerId: ctx.userId }, account: { id: { in: [] } } };
    } else {
      out = { level: 'NONE', sql: NONE, thread: { id: { in: [] } }, lead: { id: { in: [] } }, account: { id: { in: [] } } };
    }
    if (departmentId) {
      out.sql = Prisma.sql`(${out.sql}) AND "departmentId" = ${departmentId}`;
      out.thread = { AND: [out.thread, { OR: [{ departmentId }, { departmentId: null, emailAccount: { departmentId } }] }] };
      out.lead = { AND: [out.lead, { departmentId }] };
      out.account = { AND: [out.account, { departmentId }] };
    }
    out.thread = { AND: [out.thread, { isSpam: false, isTrashed: false, emailAccount: { purgedAt: null } }] };
    return out;
  }

  // ───────────── building blocks ─────────────

  private async sums(scope: ReportScope, from: Date, to: Date): Promise<Sums> {
    const [row] = await this.prisma.$queryRaw<Sums[]>`SELECT ${SUMS} FROM analytics_hourly WHERE hour >= ${from} AND hour < ${to} AND ${scope.sql}`;
    return row!;
  }

  /** The inbox view conditions (ThreadsService.viewWhere) for the live counts. */
  private live(scope: ReportScope, now = new Date()) {
    const notSnoozed = { OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] };
    const pending: Prisma.EmailThreadWhereInput = { awaitingReplySince: { not: null }, status: { notIn: ['REPLY_NOT_NEEDED', 'CLOSED'] } };
    const overdue: Prisma.EmailThreadWhereInput = { slaDueAt: { lte: now }, awaitingReplySince: { not: null }, status: { notIn: ['WAITING_FOR_CLIENT', 'REPLY_NOT_NEEDED', 'CLOSED'] } };
    const unassigned: Prisma.EmailThreadWhereInput = { isArchived: false, assigneeId: null, teamId: null, status: { not: 'CLOSED' }, AND: [notSnoozed] };
    const count = (w: Prisma.EmailThreadWhereInput) => this.prisma.emailThread.count({ where: { AND: [scope.thread, w] } });
    return { pending, overdue, unassigned, count };
  }

  // ───────────── endpoints ─────────────

  async overview(ctx: RequestContext, q: RangeQuery): Promise<AnalyticsOverview> {
    const r = this.resolveRange(q);
    const scope = await this.scope(ctx, q.departmentId);
    const live = this.live(scope);
    const [s, unread, unassigned, pending, overdue, accounts, ai, info] = await Promise.all([
      this.sums(scope, r.from, r.to),
      live.count({ unreadCount: { gt: 0 } }),
      live.count(live.unassigned),
      live.count(live.pending),
      live.count(live.overdue),
      scope.level === 'ALL' || scope.level === 'DEPARTMENT'
        ? this.prisma.emailAccount.count({ where: { AND: [scope.account, { purgedAt: null, status: { not: 'DISCONNECTED' } }] } })
        : Promise.resolve(0),
      scope.level === 'ALL' && !q.departmentId ? this.aiUsage(r.from, r.to) : Promise.resolve(null),
      this.rangeInfo(q, r),
    ]);
    return {
      ...info,
      incoming: s.incoming,
      outgoing: s.outgoing,
      newThreads: s.newThreads,
      closed: s.closed,
      slaBreaches: s.slaBreaches,
      response: averages(s),
      accounts,
      unread,
      unassigned,
      pending,
      overdue,
      ai,
    };
  }

  private async aiUsage(from: Date, to: Date) {
    const a = await this.prisma.aiSummary.aggregate({ where: { createdAt: { gte: from, lt: to } }, _count: true, _sum: { inputTokens: true, outputTokens: true } });
    return { analyses: a._count, inputTokens: a._sum.inputTokens ?? 0, outputTokens: a._sum.outputTokens ?? 0 };
  }

  async responseTimes(ctx: RequestContext, q: RangeQuery & { groupBy: 'user' | 'department' | 'account' }): Promise<ResponseTimeRow[]> {
    const r = this.resolveRange(q);
    const scope = await this.scope(ctx, q.departmentId);
    const col = { user: Prisma.sql`"userId"`, department: Prisma.sql`"departmentId"`, account: Prisma.sql`"emailAccountId"` }[q.groupBy];
    const rows = await this.prisma.$queryRaw<(Sums & { key: string | null })[]>`
      SELECT ${col} AS key, ${SUMS} FROM analytics_hourly
      WHERE hour >= ${r.from} AND hour < ${r.to} AND ${scope.sql}
      GROUP BY 1`;
    const names = await this.names(q.groupBy, rows.map((x) => x.key));
    return rows
      .map((x) => ({
        key: x.key,
        name: x.key ? (names.get(x.key) ?? 'Unknown') : q.groupBy === 'user' ? 'Nobody assigned' : q.groupBy === 'department' ? 'No department' : 'Unknown',
        incoming: x.incoming,
        outgoing: x.outgoing,
        closed: x.closed,
        slaBreaches: x.slaBreaches,
        ...averages(x),
      }))
      .sort((a, b) => b.incoming + b.replies - (a.incoming + a.replies) || a.name.localeCompare(b.name));
  }

  private async names(kind: 'user' | 'department' | 'account', keys: (string | null)[]) {
    const ids = keys.filter((k): k is string => !!k);
    if (!ids.length) return new Map<string, string>();
    if (kind === 'user') return new Map((await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    if (kind === 'department') return new Map((await this.prisma.department.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
    return new Map((await this.prisma.emailAccount.findMany({ where: { id: { in: ids } }, select: { id: true, emailAddress: true } })).map((a) => [a.id, a.emailAddress]));
  }

  async workload(ctx: RequestContext, q: { groupBy: 'user' | 'department'; departmentId?: string }): Promise<WorkloadRow[]> {
    const scope = await this.scope(ctx, q.departmentId);
    const live = this.live(scope);
    const open: Prisma.EmailThreadWhereInput = { AND: [scope.thread, { status: { not: 'CLOSED' }, isArchived: false }] };
    const byUser = async (w: Prisma.EmailThreadWhereInput) =>
      (await this.prisma.emailThread.groupBy({ by: ['assigneeId'], where: { AND: [open, w] }, _count: true })).map((g) => ({ key: g.assigneeId, n: g._count }));
    let groups: { open: { key: string | null; n: number }[]; pending: { key: string | null; n: number }[]; overdue: { key: string | null; n: number }[] };
    if (q.groupBy === 'user') {
      const [o, p, d] = await Promise.all([byUser({}), byUser(live.pending), byUser(live.overdue)]);
      groups = { open: o, pending: p, overdue: d };
    } else {
      // Department = the conversation's, else its mailbox's (as in the rollup).
      const rows = await this.prisma.emailThread.findMany({
        where: open,
        select: { departmentId: true, emailAccount: { select: { departmentId: true } }, awaitingReplySince: true, status: true, slaDueAt: true },
      });
      const now = Date.now();
      const tally = (pred: (t: (typeof rows)[number]) => boolean) => {
        const m = new Map<string | null, number>();
        for (const t of rows) if (pred(t)) m.set(t.departmentId ?? t.emailAccount.departmentId, (m.get(t.departmentId ?? t.emailAccount.departmentId) ?? 0) + 1);
        return [...m].map(([key, n]) => ({ key, n }));
      };
      const isPending = (t: (typeof rows)[number]) => !!t.awaitingReplySince && !['REPLY_NOT_NEEDED', 'CLOSED'].includes(t.status);
      groups = {
        open: tally(() => true),
        pending: tally(isPending),
        overdue: tally((t) => isPending(t) && t.status !== 'WAITING_FOR_CLIENT' && !!t.slaDueAt && t.slaDueAt.getTime() <= now),
      };
    }
    const keys = [...new Set(groups.open.map((g) => g.key))];
    const names = await this.names(q.groupBy, keys);
    const get = (list: { key: string | null; n: number }[], k: string | null) => list.find((g) => g.key === k)?.n ?? 0;
    return keys
      .map((k) => ({
        key: k,
        name: k ? (names.get(k) ?? 'Unknown') : q.groupBy === 'user' ? 'Nobody assigned' : 'No department',
        open: get(groups.open, k),
        pending: get(groups.pending, k),
        overdue: get(groups.overdue, k),
      }))
      .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
  }

  async trends(ctx: RequestContext, q: TrendsQuery, now = new Date()): Promise<TrendsResult> {
    const zone = this.timezone;
    const periods = q.periods ?? (q.interval === 'day' ? 30 : 12);
    const unit = q.interval;
    const last = DateTime.fromJSDate(now, { zone }).startOf(unit);
    const first = last.minus({ [`${unit}s`]: periods - 1 });
    const scope = await this.scope(ctx, q.departmentId);
    const points = await this.buckets(scope, unit, first, last.plus({ [`${unit}s`]: 1 }), q.metric);
    const asOf = await this.rollup.asOf();
    return { interval: unit, timezone: zone, asOf: asOf?.toISOString() ?? null, points };
  }

  /** One point per local day / week (Monday) / month in [first, end), empty buckets included. */
  private async buckets(scope: ReportScope, unit: 'day' | 'week' | 'month', first: DateTime, end: DateTime, metrics: readonly string[]): Promise<TrendPoint[]> {
    const tz = this.timezone;
    const rows = await this.prisma.$queryRaw<(Sums & { bucket: Date })[]>`
      SELECT date_trunc(${unit}, (hour AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) AS bucket, ${SUMS}
      FROM analytics_hourly
      WHERE hour >= ${first.toJSDate()} AND hour < ${end.toJSDate()} AND ${scope.sql}
      GROUP BY 1`;
    // `bucket` is a local wall-clock timestamp; read its date part as written.
    const byKey = new Map(rows.map((r) => [r.bucket.toISOString().slice(0, 10), r]));
    const out: TrendPoint[] = [];
    for (let b = first; b < end; b = b.plus({ [`${unit}s`]: 1 })) {
      const key = b.toISODate()!;
      const s = byKey.get(key);
      const values: Record<string, number | null> = {};
      for (const m of metrics) {
        if (!s) values[m] = m === 'avgResponse' || m === 'avgBusinessResponse' ? null : 0;
        else if (m === 'avgResponse') values[m] = avg(s.replyMinutes, s.replies);
        else if (m === 'avgBusinessResponse') values[m] = avg(s.replyBizMinutes, s.replyBizCount);
        else values[m] = (s as unknown as Record<string, number>)[m] ?? 0;
      }
      out.push({ bucket: key, values });
    }
    return out;
  }

  /** Daily points for a range (CSV export). */
  async daily(ctx: RequestContext, q: RangeQuery) {
    const r = this.resolveRange(q);
    const scope = await this.scope(ctx, q.departmentId);
    const zone = this.timezone;
    return this.buckets(scope, 'day', DateTime.fromJSDate(r.from, { zone }), DateTime.fromJSDate(r.to, { zone }), ['incoming', 'outgoing', 'newThreads', 'replies', 'avgResponse', 'avgBusinessResponse', 'closed', 'slaBreaches']);
  }

  async leadFunnel(ctx: RequestContext, q: RangeQuery): Promise<LeadFunnel> {
    const r = this.resolveRange(q);
    const scope = await this.scope(ctx, q.departmentId);
    const leads = await this.prisma.lead.findMany({
      where: { AND: [scope.lead, { createdAt: { gte: r.from, lt: r.to } }] },
      select: { status: true, estimatedValue: true, currency: true, statusHistory: { select: { toStatus: true } } },
    });
    const rank = (s: string) => LEAD_STAGES.indexOf(s as (typeof LEAD_STAGES)[number]);
    const byStatus = LEAD_STATUSES.map((status) => ({ status, count: leads.filter((l) => l.status === status).length }));
    const furthest = leads.map((l) => Math.max(rank(l.status), ...l.statusHistory.map((h) => rank(h.toStatus)), 0));
    const reached = LEAD_STAGES.map((status, i) => ({ status, count: furthest.filter((f) => f >= i).length }));
    const wonValue = new Map<string, number>();
    for (const l of leads) if (l.status === 'WON' && l.estimatedValue) wonValue.set(l.currency ?? 'USD', (wonValue.get(l.currency ?? 'USD') ?? 0) + Number(l.estimatedValue));
    const won = byStatus.find((b) => b.status === 'WON')!.count;
    const lost = byStatus.find((b) => b.status === 'LOST')!.count;
    return {
      ...(await this.rangeInfo(q, r)),
      total: leads.length,
      byStatus,
      reached,
      won,
      lost,
      wonValue: [...wonValue].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })),
      conversionRate: won + lost > 0 ? Math.round((won / (won + lost)) * 1000) / 10 : null,
    };
  }

  async accounts(ctx: RequestContext, q: RangeQuery): Promise<AccountHealthRow[]> {
    const r = this.resolveRange(q);
    const scope = await this.scope(ctx, q.departmentId);
    if (scope.level !== 'ALL' && scope.level !== 'DEPARTMENT') return [];
    const since = new Date(Date.now() - 86_400_000);
    const accounts = await this.prisma.emailAccount.findMany({
      where: { AND: [scope.account, { purgedAt: null }] },
      select: { id: true, emailAddress: true, displayName: true, provider: true, status: true, lastSuccessAt: true, lastError: true, _count: { select: { syncLogs: { where: { status: 'FAILED', startedAt: { gte: since } } } } } },
      orderBy: { emailAddress: 'asc' },
    });
    if (!accounts.length) return [];
    const incoming = await this.prisma.$queryRaw<{ id: string; n: number }[]>`
      SELECT "emailAccountId" AS id, COALESCE(sum(incoming), 0)::int AS n FROM analytics_hourly
      WHERE hour >= ${r.from} AND hour < ${r.to} AND "emailAccountId" = ANY(${accounts.map((a) => a.id)}::text[]) AND ${scope.sql}
      GROUP BY 1`;
    const inc = new Map(incoming.map((i) => [i.id, i.n]));
    return accounts.map((a) => ({
      id: a.id,
      emailAddress: a.emailAddress,
      displayName: a.displayName,
      provider: a.provider,
      status: a.status,
      lastSuccessAt: a.lastSuccessAt?.toISOString() ?? null,
      lastError: a.status === 'ACTIVE' ? null : a.lastError,
      failures24h: a._count.syncLogs,
      incoming: inc.get(a.id) ?? 0,
    }));
  }

  async md(ctx: RequestContext, q: RangeQuery): Promise<MdDashboard> {
    const r = this.resolveRange(q);
    const scope = await this.scope(ctx, q.departmentId);
    const live = this.live(scope);
    const zone = this.timezone;
    const thisMonth = DateTime.now().setZone(zone).startOf('month');
    const [s, pending, unassigned, overdue, newLeads, wonLeads, depts, load, monthly, info] = await Promise.all([
      this.sums(scope, r.from, r.to),
      live.count(live.pending),
      live.count(live.unassigned),
      live.count(live.overdue),
      this.prisma.lead.count({ where: { AND: [scope.lead, { createdAt: { gte: r.from, lt: r.to } }] } }),
      this.prisma.lead.count({ where: { AND: [scope.lead, { status: 'WON', wonAt: { gte: r.from, lt: r.to } }] } }),
      this.responseTimes(ctx, { ...q, groupBy: 'department' }),
      this.workload(ctx, { groupBy: 'department', departmentId: q.departmentId }),
      this.buckets(scope, 'month', thisMonth.minus({ months: 11 }), thisMonth.plus({ months: 1 }), ['incoming', 'replies', 'avgBusinessResponse']),
      this.rangeInfo(q, r),
    ]);
    const keys = [...new Set([...depts.map((d) => d.key), ...load.map((l) => l.key)])];
    const departments = keys.map((k) => {
      const d = depts.find((x) => x.key === k);
      const l = load.find((x) => x.key === k);
      return {
        key: k,
        name: d?.name ?? l?.name ?? 'No department',
        incoming: d?.incoming ?? 0,
        outgoing: d?.outgoing ?? 0,
        closed: d?.closed ?? 0,
        slaBreaches: d?.slaBreaches ?? 0,
        replies: d?.replies ?? 0,
        avgMinutes: d?.avgMinutes ?? null,
        avgBusinessMinutes: d?.avgBusinessMinutes ?? null,
        firstReplies: d?.firstReplies ?? 0,
        avgFirstMinutes: d?.avgFirstMinutes ?? null,
        avgFirstBusinessMinutes: d?.avgFirstBusinessMinutes ?? null,
        open: l?.open ?? 0,
        pending: l?.pending ?? 0,
        overdue: l?.overdue ?? 0,
      };
    });
    return { ...info, incoming: s.incoming, pending, unassigned, overdue, newLeads, wonLeads, response: averages(s), departments, monthly };
  }

  /** The employee's own dashboard: always their own work, whatever their report scope. */
  async me(ctx: RequestContext, q: RangeQuery, now = new Date()): Promise<MyDashboard> {
    const r = this.resolveRange(q, now);
    const mine: ReportScope = {
      level: 'OWN',
      sql: Prisma.sql`"userId" = ${ctx.userId}`,
      thread: { AND: [{ assigneeId: ctx.userId }, { isSpam: false, isTrashed: false, emailAccount: { purgedAt: null } }] },
      lead: { ownerId: ctx.userId },
      account: { id: { in: [] } },
    };
    const live = this.live(mine, now);
    const endOfToday = DateTime.fromJSDate(now, { zone: this.timezone }).endOf('day').toJSDate();
    const teams = await this.prisma.team.findMany({
      where: { OR: [{ members: { some: { userId: ctx.userId } } }, { leaderId: ctx.userId }] },
      select: { leaderId: true, members: { select: { userId: true } } },
    });
    const team = [...new Set([ctx.userId, ...teams.flatMap((t) => [...(t.leaderId ? [t.leaderId] : []), ...t.members.map((m) => m.userId)])])];
    const [s, assigned, newAssigned, pending, overdue, followUpsDue, tasksDue, perPerson, nextUp, info] = await Promise.all([
      this.sums(mine, r.from, r.to),
      live.count({ status: { not: 'CLOSED' } }),
      this.prisma.assignment.count({ where: { assigneeId: ctx.userId, createdAt: { gte: r.from, lt: r.to }, thread: { isSpam: false, isTrashed: false } } }),
      live.count(live.pending),
      live.count(live.overdue),
      live.count({ followUpAt: { lte: now }, status: { not: 'CLOSED' } }),
      this.prisma.task.count({ where: { assigneeId: ctx.userId, status: 'OPEN', dueAt: { lte: endOfToday } } }),
      this.prisma.$queryRaw<{ userId: string; m: number; n: number; bm: number; bn: number }[]>`
        SELECT "userId", COALESCE(sum("replyMinutes"), 0)::float8 AS m, COALESCE(sum(replies), 0)::int AS n,
               COALESCE(sum("replyBizMinutes"), 0)::float8 AS bm, COALESCE(sum("replyBizCount"), 0)::int AS bn
        FROM analytics_hourly WHERE hour >= ${r.from} AND hour < ${r.to} AND "userId" = ANY(${team}::text[])
        GROUP BY 1`,
      this.prisma.emailThread.findMany({
        where: { AND: [mine.thread, live.pending] },
        orderBy: [{ slaDueAt: { sort: 'asc', nulls: 'last' } }, { awaitingReplySince: 'asc' }],
        take: 10,
        select: { id: true, subject: true, priority: true, status: true, awaitingReplySince: true, slaDueAt: true },
      }),
      this.rangeInfo(q, r),
    ]);
    const others = team.length > 1;
    const avgs = perPerson.filter((p) => p.n > 0).map((p) => p.m / p.n);
    const bizAvgs = perPerson.filter((p) => p.bn > 0).map((p) => p.bm / p.bn);
    const a = averages(s);
    return {
      ...info,
      assigned,
      newAssigned,
      pending,
      overdue,
      followUpsDue,
      tasksDue,
      closed: s.closed,
      replies: s.replies,
      myAvgMinutes: a.avgMinutes,
      myAvgBusinessMinutes: a.avgBusinessMinutes,
      teamMedianMinutes: others ? median(avgs.map(Math.round)) : null,
      teamMedianBusinessMinutes: others ? median(bizAvgs.map(Math.round)) : null,
      nextUp: nextUp.map((t) => ({
        id: t.id,
        subject: t.subject,
        priority: t.priority,
        status: t.status,
        awaitingReplySince: t.awaitingReplySince?.toISOString() ?? null,
        slaDueAt: t.slaDueAt?.toISOString() ?? null,
        overdue: !!t.slaDueAt && t.slaDueAt <= now && t.status !== 'WAITING_FOR_CLIENT',
      })),
    };
  }
}
