import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import { DateTime } from 'luxon';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { businessMinutesBetween, type CalendarSpec, type WeeklyHours } from '../sla/business-clock';

export type RollupKind = 'fast' | 'settle' | 'rebuild';

/** Windows (in hours back from the current hour) of the scheduled runs. */
export const ROLLUP_WINDOWS = { fast: 3, settle: 48 } as const;
/** A first run with no history builds this far back, a week at a time. */
const INITIAL_BACKFILL_DAYS = 400;
const CHUNK_DAYS = 7;
/** Serialises rollups across worker instances and the CLI. */
const LOCK_KEY = 940_113;

interface PairRow {
  id: string;
  threadId: string;
  since: Date;
  responded: Date;
  isFirst: boolean;
  emailAccountId: string;
  dept: string | null;
  teamId: string | null;
  usr: string | null;
}

/** Local hour bucket of a UTC `timestamp` column, as a UTC `timestamp` again. */
const hourOf = (col: Prisma.Sql, tz: string) => Prisma.sql`(date_trunc('hour', (${col} AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'`;

/**
 * Builds the report tables from the mail, status and SLA data (docs/07 Phase 9).
 *
 * 1. **Response facts**: every outbound message that answers a waiting client message, from the
 *    first unanswered inbound message to that reply, in clock minutes and in business minutes of
 *    the department's calendar (else the default SLA policy's calendar).
 * 2. **Hourly rollup** per mailbox × department × team × person in the report time zone.
 *
 * Each run recomputes a window of whole local hours (delete + insert in one transaction, under an
 * advisory lock), so it can be repeated at will. Mailboxes whose mail was purged are never
 * touched: their figures stay as they were.
 *
 * Attribution: incoming mail, new conversations and SLA breaches count for the conversation's
 * current assignee; outgoing mail and replies for the employee who sent them through the CRM
 * (else the assignee); closures for whoever closed (else the assignee). The department is the
 * conversation's, else its mailbox's.
 */
@Injectable()
export class RollupService {
  private readonly log = new Logger(RollupService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  get timezone() {
    return this.cfg.REPORT_TIMEZONE;
  }

  /** Start of the local hour containing `at`. */
  hourStart(at: Date) {
    return DateTime.fromJSDate(at, { zone: this.timezone }).startOf('hour').toJSDate();
  }

  /** Scheduled runs: the last few hours every 10 minutes; the last two days every hour. A first run backfills. */
  async scheduled(kind: 'fast' | 'settle', now = new Date()) {
    const done = await this.prisma.analyticsRun.count({ where: { finishedAt: { not: null }, error: null } });
    if (!done) return this.rebuild(INITIAL_BACKFILL_DAYS, now);
    const to = DateTime.fromJSDate(this.hourStart(now)).plus({ hours: 1 }).toJSDate();
    const from = DateTime.fromJSDate(to).minus({ hours: ROLLUP_WINDOWS[kind] }).toJSDate();
    return this.run(kind, from, to);
  }

  /** Rebuilds the last `days` days (a week per transaction), oldest first. */
  async rebuild(days: number, now = new Date()) {
    const end = DateTime.fromJSDate(this.hourStart(now)).plus({ hours: 1 });
    let from = end.setZone(this.timezone).minus({ days }).startOf('day');
    let total = { rows: 0, facts: 0 };
    while (from < end) {
      const to = DateTime.min(from.plus({ days: CHUNK_DAYS }), end);
      const r = await this.run('rebuild', from.toJSDate(), to.toJSDate());
      total = { rows: total.rows + r.rows, facts: total.facts + r.facts };
      from = to;
    }
    return total;
  }

  /** Recomputes [from, to); both must be local hour starts. */
  async run(kind: RollupKind, from: Date, to: Date): Promise<{ rows: number; facts: number }> {
    const runId = newId();
    await this.prisma.analyticsRun.create({ data: { id: runId, kind, fromHour: from, toHour: to } });
    try {
      const calendars = await this.calendars();
      const result = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
          const facts = await this.buildFacts(tx, from, to, calendars);
          const rows = await this.buildHourly(tx, from, to);
          return { rows, facts };
        },
        { timeout: 600_000, maxWait: 60_000 },
      );
      await this.prisma.analyticsRun.update({ where: { id: runId }, data: { ...result, finishedAt: new Date() } });
      return result;
    } catch (e) {
      await this.prisma.analyticsRun.update({ where: { id: runId }, data: { error: (e as Error).message.slice(0, 1000), finishedAt: new Date() } });
      this.log.error(`Analytics ${kind} rollup ${from.toISOString()}–${to.toISOString()} failed: ${(e as Error).message}`);
      throw e;
    }
  }

  /** Calendar per department, plus the fallback (default SLA policy's, else the oldest calendar). */
  private async calendars() {
    const rows = await this.prisma.businessCalendar.findMany({ include: { holidays: true, departments: { select: { id: true } } }, orderBy: { createdAt: 'asc' } });
    const spec = (c: (typeof rows)[number]): CalendarSpec => ({
      timezone: c.timezone,
      weeklyHours: c.weeklyHours as unknown as WeeklyHours,
      holidays: new Set(c.holidays.map((h) => h.date.toISOString().slice(0, 10))),
    });
    const byDept = new Map<string, CalendarSpec>();
    for (const c of rows) for (const d of c.departments) byDept.set(d.id, spec(c));
    const def = await this.prisma.slaPolicy.findFirst({ where: { isDefault: true }, select: { calendarId: true } });
    const fallbackRow = rows.find((c) => c.id === def?.calendarId) ?? rows[0];
    return { byDept, fallback: fallbackRow ? spec(fallbackRow) : null };
  }

  private async buildFacts(tx: Tx, from: Date, to: Date, cals: Awaited<ReturnType<RollupService['calendars']>>) {
    const pairs = await tx.$queryRaw<PairRow[]>`
      WITH touched AS (
        SELECT DISTINCT "threadId" FROM email_messages
        WHERE direction = 'OUTBOUND' AND NOT "isDraft" AND "receivedAt" >= ${from} AND "receivedAt" < ${to}
      ),
      m AS (
        SELECT m.id, m."threadId", m.direction, m."receivedAt" AS at, m."sentByUserId",
               row_number() OVER w AS rn,
               count(*) FILTER (WHERE m.direction = 'OUTBOUND') OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS grp
        FROM email_messages m JOIN touched t ON t."threadId" = m."threadId"
        WHERE NOT m."isDraft"
        WINDOW w AS (PARTITION BY m."threadId" ORDER BY m."receivedAt", m.id)
      ),
      pairs AS (
        SELECT o.id, o."threadId", o."sentByUserId", o.at AS responded, min(i.at) AS since
        FROM m o JOIN m i ON i."threadId" = o."threadId" AND i.direction = 'INBOUND' AND i.grp = o.grp AND i.rn < o.rn
        WHERE o.direction = 'OUTBOUND'
        GROUP BY o.id, o."threadId", o."sentByUserId", o.at
      ),
      ranked AS (
        SELECT p.*, row_number() OVER (PARTITION BY p."threadId" ORDER BY p.responded, p.id) = 1 AS "isFirst" FROM pairs p
      )
      SELECT r.id, r."threadId", r.since, r.responded, r."isFirst",
             th."emailAccountId", COALESCE(th."departmentId", a."departmentId") AS dept, th."teamId",
             COALESCE(r."sentByUserId", th."assigneeId") AS usr
      FROM ranked r
      JOIN email_threads th ON th.id = r."threadId"
      JOIN email_accounts a ON a.id = th."emailAccountId"
      WHERE r.responded >= ${from} AND r.responded < ${to}
        AND NOT th."isSpam" AND NOT th."isTrashed" AND a."purgedAt" IS NULL`;

    await tx.$executeRaw`
      DELETE FROM analytics_response_facts f
      WHERE f."respondedAt" >= ${from} AND f."respondedAt" < ${to}
        AND f."emailAccountId" IN (SELECT id FROM email_accounts WHERE "purgedAt" IS NULL)`;
    if (!pairs.length) return 0;
    const data = pairs.map((p) => {
      const cal = (p.dept && cals.byDept.get(p.dept)) || cals.fallback;
      return {
        messageId: p.id,
        threadId: p.threadId,
        emailAccountId: p.emailAccountId,
        departmentId: p.dept,
        teamId: p.teamId,
        userId: p.usr,
        waitingSince: p.since,
        respondedAt: p.responded,
        clockMinutes: Math.max(0, Math.floor((p.responded.getTime() - p.since.getTime()) / 60_000)),
        businessMinutes: cal ? businessMinutesBetween(cal, p.since, p.responded) : null,
        isFirst: p.isFirst,
      };
    });
    for (let i = 0; i < data.length; i += 5000) {
      await tx.responseFact.createMany({ data: data.slice(i, i + 5000), skipDuplicates: true });
    }
    return data.length;
  }

  private async buildHourly(tx: Tx, from: Date, to: Date) {
    const tz = this.timezone;
    await tx.$executeRaw`
      DELETE FROM analytics_hourly
      WHERE hour >= ${from} AND hour < ${to}
        AND "emailAccountId" IN (SELECT id FROM email_accounts WHERE "purgedAt" IS NULL)`;
    return tx.$executeRaw`
      INSERT INTO analytics_hourly (hour, "dimKey", "emailAccountId", "departmentId", "teamId", "userId",
        incoming, outgoing, "newThreads", replies, "replyMinutes", "replyBizMinutes", "replyBizCount",
        "firstReplies", "firstReplyMinutes", "firstReplyBizMinutes", "firstReplyBizCount", closed, "slaBreaches")
      WITH t AS (
        SELECT th.id, th."emailAccountId" AS acc, COALESCE(th."departmentId", a."departmentId") AS dept, th."teamId" AS team, th."assigneeId" AS usr
        FROM email_threads th JOIN email_accounts a ON a.id = th."emailAccountId"
        WHERE NOT th."isSpam" AND NOT th."isTrashed" AND a."purgedAt" IS NULL
      ),
      ev AS (
        SELECT m."receivedAt" AS at, t.acc, t.dept, t.team, t.usr,
               1 AS inc, 0 AS outg, 0 AS nt, 0 AS cl, 0 AS br, 0 AS rp, 0 AS rm, 0 AS rbm, 0 AS rbc, 0 AS fr, 0 AS frm, 0 AS frbm, 0 AS frbc
        FROM email_messages m JOIN t ON t.id = m."threadId"
        WHERE m.direction = 'INBOUND' AND NOT m."isDraft" AND m."receivedAt" >= ${from} AND m."receivedAt" < ${to}
        UNION ALL
        SELECT m."receivedAt", t.acc, t.dept, t.team, COALESCE(m."sentByUserId", t.usr), 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        FROM email_messages m JOIN t ON t.id = m."threadId"
        WHERE m.direction = 'OUTBOUND' AND NOT m."isDraft" AND m."receivedAt" >= ${from} AND m."receivedAt" < ${to}
        UNION ALL
        SELECT th."firstMessageAt", t.acc, t.dept, t.team, t.usr, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        FROM email_threads th JOIN t ON t.id = th.id
        WHERE th."firstMessageAt" >= ${from} AND th."firstMessageAt" < ${to}
        UNION ALL
        SELECT h."createdAt", t.acc, t.dept, t.team, COALESCE(h."changedById", t.usr), 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0
        FROM status_history h JOIN t ON t.id = h."threadId"
        WHERE h."toStatus" = 'CLOSED' AND h."createdAt" >= ${from} AND h."createdAt" < ${to}
        UNION ALL
        SELECT e."firedAt", t.acc, t.dept, t.team, t.usr, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0
        FROM sla_events e JOIN sla_steps s ON s.id = e."stepId" JOIN t ON t.id = e."threadId"
        WHERE s."marksOverdue" AND e."firedAt" >= ${from} AND e."firedAt" < ${to}
        UNION ALL
        SELECT f."respondedAt", f."emailAccountId", f."departmentId", f."teamId", f."userId", 0, 0, 0, 0, 0,
               1, f."clockMinutes", COALESCE(f."businessMinutes", 0), (f."businessMinutes" IS NOT NULL)::int,
               f."isFirst"::int, CASE WHEN f."isFirst" THEN f."clockMinutes" ELSE 0 END,
               CASE WHEN f."isFirst" THEN COALESCE(f."businessMinutes", 0) ELSE 0 END,
               (f."isFirst" AND f."businessMinutes" IS NOT NULL)::int
        FROM analytics_response_facts f JOIN email_accounts a ON a.id = f."emailAccountId"
        WHERE a."purgedAt" IS NULL AND f."respondedAt" >= ${from} AND f."respondedAt" < ${to}
      )
      SELECT ${hourOf(Prisma.sql`at`, tz)} AS hour,
             concat_ws('|', acc, COALESCE(dept, ''), COALESCE(team, ''), COALESCE(usr, '')),
             acc, dept, team, usr,
             sum(inc)::int, sum(outg)::int, sum(nt)::int, sum(rp)::int, sum(rm)::bigint, sum(rbm)::bigint, sum(rbc)::int,
             sum(fr)::int, sum(frm)::bigint, sum(frbm)::bigint, sum(frbc)::int, sum(cl)::int, sum(br)::int
      FROM ev
      GROUP BY 1, 2, 3, 4, 5, 6`;
  }

  /** The last successful run (dashboards show it as "updated at"). */
  async asOf(): Promise<Date | null> {
    const r = await this.prisma.analyticsRun.findFirst({ where: { finishedAt: { not: null }, error: null }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } });
    return r?.finishedAt ?? null;
  }
}
