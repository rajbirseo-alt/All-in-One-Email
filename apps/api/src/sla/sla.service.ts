import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Priority, type SlaAction } from '@crm/db';
import { newId } from '@crm/crypto';
import type { ThreadSla } from '@crm/shared';
import { EventsPublisher } from '../events/events.service';
import { NotificationsService, type NotifyInput, type Outbox } from '../notifications/notifications.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { addBusinessMinutes, formatLocal, type CalendarSpec, type WeeklyHours } from './business-clock';

/** Statuses in which no reply is owed, so the clock stops. */
export const SLA_PAUSED = new Set(['WAITING_FOR_CLIENT', 'REPLY_NOT_NEEDED', 'CLOSED']);
/** Mail received before the mailbox was connected is history: no clock runs for it. */
const HISTORY_GRACE_MS = 5 * 60_000;
/** A step that was already due when its policy was saved is recorded without alerting anyone. */
const RETRO_TOLERANCE_MS = 60_000;

const policyInclude = { steps: { orderBy: [{ afterBusinessMinutes: 'asc' }, { action: 'asc' }] }, calendar: { include: { holidays: true } } } satisfies Prisma.SlaPolicyInclude;
type PolicyRow = Prisma.SlaPolicyGetPayload<{ include: typeof policyInclude }>;
type ThreadRow = Prisma.EmailThreadGetPayload<{ include: { emailAccount: { select: { createdAt: true; departmentId: true } } } }>;

export function calendarSpec(c: PolicyRow['calendar']): CalendarSpec {
  return { timezone: c.timezone, weeklyHours: c.weeklyHours as unknown as WeeklyHours, holidays: new Set(c.holidays.map((h) => h.date.toISOString().slice(0, 10))) };
}

/** Most specific wins: department + priority, then department, then priority, then the default policy. */
export function matchPolicy<P extends { departmentId: string | null; priority: Priority | null; isDefault: boolean; isEnabled: boolean }>(
  policies: P[],
  departmentId: string | null,
  priority: Priority,
): P | null {
  const on = policies.filter((p) => p.isEnabled);
  return (
    on.find((p) => departmentId && p.departmentId === departmentId && p.priority === priority) ??
    on.find((p) => departmentId && p.departmentId === departmentId && p.priority === null) ??
    on.find((p) => p.departmentId === null && p.priority === priority) ??
    on.find((p) => p.isDefault) ??
    null
  );
}

/**
 * Business-hours SLA. A waiting cycle starts when a client's message is left unanswered
 * (`awaitingReplySince`) and ends with a reply or a status in which no reply is owed. Each policy
 * step fires at most once per cycle (unique SlaEvent row), so restarts and parallel sweepers
 * never alert twice.
 */
@Injectable()
export class SlaService {
  private readonly log = new Logger(SlaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly events: EventsPublisher,
  ) {}

  loadPolicies(db: Tx = this.prisma): Promise<PolicyRow[]> {
    return db.slaPolicy.findMany({ include: policyInclude, orderBy: { createdAt: 'asc' } });
  }

  private cycleOf(t: ThreadRow): Date | null {
    if (!t.awaitingReplySince || SLA_PAUSED.has(t.status) || t.isSpam || t.isTrashed) return null;
    if (t.awaitingReplySince.getTime() < t.emailAccount.createdAt.getTime() - HISTORY_GRACE_MS) return null;
    return t.awaitingReplySince;
  }

  private plan(policy: PolicyRow, cycleStart: Date) {
    const spec = calendarSpec(policy.calendar);
    return policy.steps.map((s) => ({ step: s, dueAt: addBusinessMinutes(spec, cycleStart, s.afterBusinessMinutes) }));
  }

  /** Recomputes policy, due time and next step for these conversations (idempotent). */
  async evaluate(threadIds: Iterable<string>, policies?: PolicyRow[]) {
    const ids = [...new Set(threadIds)];
    if (!ids.length) return;
    policies ??= await this.loadPolicies();
    const changed: string[] = [];
    for (const id of ids) {
      const t = await this.prisma.emailThread.findUnique({ where: { id }, include: { emailAccount: { select: { createdAt: true, departmentId: true } } } });
      if (!t) continue;
      const cycle = this.cycleOf(t);
      const policy = cycle ? matchPolicy(policies, t.departmentId ?? t.emailAccount.departmentId, t.priority) : null;
      let next: { slaPolicyId: string | null; slaDueAt: Date | null; slaNextAt: Date | null; slaBreachedAt: Date | null };
      if (!cycle || !policy) {
        next = { slaPolicyId: policy?.id ?? null, slaDueAt: null, slaNextAt: null, slaBreachedAt: null };
      } else {
        const fired = await this.prisma.slaEvent.findMany({ where: { threadId: id, cycleStart: cycle }, select: { stepId: true } });
        const firedIds = new Set(fired.map((f) => f.stepId));
        const plan = this.plan(policy, cycle);
        const overdueAt = plan.filter((p) => p.step.marksOverdue && p.dueAt).map((p) => p.dueAt!.getTime());
        const pending = plan.filter((p) => !firedIds.has(p.step.id) && p.dueAt).map((p) => p.dueAt!.getTime());
        const breached = plan.some((p) => firedIds.has(p.step.id) && (p.step.marksOverdue || p.step.action === 'ESCALATE'));
        next = {
          slaPolicyId: policy.id,
          slaDueAt: overdueAt.length ? new Date(Math.min(...overdueAt)) : null,
          slaNextAt: pending.length ? new Date(Math.min(...pending)) : null,
          slaBreachedAt: breached ? (t.slaBreachedAt ?? new Date()) : null,
        };
      }
      const same = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
      if (t.slaPolicyId !== next.slaPolicyId || !same(t.slaDueAt, next.slaDueAt) || !same(t.slaNextAt, next.slaNextAt) || !same(t.slaBreachedAt, next.slaBreachedAt)) {
        await this.prisma.emailThread.update({ where: { id }, data: next });
        changed.push(id);
      }
    }
    if (changed.length) await this.events.threadsChanged(changed).catch(() => undefined);
  }

  /** After a policy or calendar changes: every conversation with a running (or possible) clock. */
  async reevaluateOpen() {
    const policies = await this.loadPolicies();
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.emailThread.findMany({
        where: { OR: [{ awaitingReplySince: { not: null } }, { slaPolicyId: { not: null } }, { slaNextAt: { not: null } }] },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!rows.length) return;
      await this.evaluate(
        rows.map((r) => r.id),
        policies,
      );
      cursor = rows.at(-1)!.id;
    }
  }

  /** Fires every step that has come due (run every minute by the worker). Returns the number of conversations handled. */
  async sweep(now = new Date(), limit = 200): Promise<number> {
    const due = await this.prisma.emailThread.findMany({ where: { slaNextAt: { lte: now } }, select: { id: true }, orderBy: { slaNextAt: 'asc' }, take: limit });
    for (const { id } of due) {
      await this.fireDue(id, now).catch((e: Error) => this.log.error(`SLA step for ${id} failed: ${e.message}`));
    }
    return due.length;
  }

  private async fireDue(threadId: string, now: Date) {
    const pending: { outbox: Outbox | null } = { outbox: null };
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM email_threads WHERE id = ${threadId} FOR UPDATE`);
        const t = await tx.emailThread.findUnique({ where: { id: threadId }, include: { emailAccount: { select: { createdAt: true, departmentId: true } } } });
        if (!t) return;
        const cycle = this.cycleOf(t);
        if (!cycle) return;
        const policy = matchPolicy(await this.loadPolicies(tx), t.departmentId ?? t.emailAccount.departmentId, t.priority);
        if (!policy) return;
        const fired = new Set((await tx.slaEvent.findMany({ where: { threadId, cycleStart: cycle }, select: { stepId: true } })).map((f) => f.stepId));
        const plan = this.plan(policy, cycle);
        const overdue = plan.filter((p) => p.step.marksOverdue && p.dueAt).map((p) => p.dueAt!.getTime());
        const dueAt = overdue.length ? new Date(Math.min(...overdue)) : null;
        let breachedAt = t.slaBreachedAt;
        for (const { step, dueAt: stepDue } of plan) {
          if (!stepDue || stepDue > now || fired.has(step.id)) continue;
          const r = await tx.slaEvent.createMany({ data: [{ id: newId(), threadId, stepId: step.id, cycleStart: cycle }], skipDuplicates: true });
          if (!r.count) continue;
          if (step.marksOverdue || step.action === 'ESCALATE') breachedAt ??= stepDue;
          if (stepDue.getTime() < policy.updatedAt.getTime() - RETRO_TOLERANCE_MS) continue;
          const inputs = await this.recipients(tx, t, step.action, dueAt, policy.calendar.timezone, now);
          pending.outbox = await this.notifications.createIn(tx, inputs, pending.outbox ?? undefined);
        }
        if ((breachedAt?.getTime() ?? null) !== (t.slaBreachedAt?.getTime() ?? null)) await tx.emailThread.update({ where: { id: threadId }, data: { slaBreachedAt: breachedAt } });
      },
      { timeout: 20_000 },
    );
    if (pending.outbox) await this.notifications.flush(pending.outbox);
    await this.evaluate([threadId]);
  }

  /** Who hears about a step: the assignee (or, for a queue, its team leader / department manager), managers, or the MD. */
  private async recipients(tx: Tx, t: ThreadRow, action: SlaAction, dueAt: Date | null, tz: string, now: Date): Promise<NotifyInput[]> {
    const departmentId = t.departmentId ?? t.emailAccount.departmentId;
    const [team, dept] = await Promise.all([
      t.teamId ? tx.team.findUnique({ where: { id: t.teamId }, select: { leaderId: true } }) : null,
      departmentId ? tx.department.findUnique({ where: { id: departmentId }, select: { managerId: true } }) : null,
    ]);
    const leaderOrManager = [team?.leaderId, dept?.managerId].find((u) => u && u !== t.assigneeId) ?? null;
    const base = { threadId: t.id, data: { action } };
    const dueText = dueAt ? formatLocal(dueAt, tz) : null;
    const subject = t.subject;
    switch (action) {
      case 'NOTIFY_ASSIGNEE':
      case 'REMIND_ASSIGNEE': {
        const to = t.assigneeId ?? leaderOrManager;
        if (!to) return [];
        const late = dueAt && dueAt <= now;
        const title = action === 'NOTIFY_ASSIGNEE' ? `Waiting for a reply: ${subject}` : late ? `Reply overdue: ${subject}` : `Reply due soon: ${subject}`;
        return [{ ...base, userId: to, type: 'SLA_REMINDER', title, body: dueText ? (late ? `Was due ${dueText}` : `Reply due by ${dueText}`) : null }];
      }
      case 'ALERT_MANAGER': {
        if (!leaderOrManager) return [];
        const who = t.assigneeId ? (await tx.user.findUnique({ where: { id: t.assigneeId }, select: { name: true } }))?.name : null;
        return [{ ...base, userId: leaderOrManager, type: 'SLA_OVERDUE', title: `Overdue: ${subject}`, body: `${who ? `Assigned to ${who}` : 'Not assigned to anyone'}${dueText ? ` · was due ${dueText}` : ''}` }];
      }
      case 'ESCALATE': {
        const top = await tx.user.findMany({ where: { status: 'ACTIVE', role: { key: { in: ['MD', 'SUPER_ADMIN'] } } }, select: { id: true } });
        return top.map((u) => ({ ...base, userId: u.id, type: 'SLA_ESCALATED' as const, title: `Escalated: ${subject}`, body: dueText ? `Reply was due ${dueText}` : null }));
      }
    }
  }

  /** What the conversation view shows: policy, due time and each step's time. */
  async describe(threadId: string): Promise<ThreadSla> {
    const t = await this.prisma.emailThread.findUnique({ where: { id: threadId }, include: { emailAccount: { select: { createdAt: true, departmentId: true } } } });
    const empty: ThreadSla = { policy: null, dueAt: null, breachedAt: null, timezone: null, steps: [] };
    if (!t) return empty;
    const cycle = this.cycleOf(t);
    const policy = cycle ? matchPolicy(await this.loadPolicies(), t.departmentId ?? t.emailAccount.departmentId, t.priority) : null;
    if (!cycle || !policy) return empty;
    const fired = new Map((await this.prisma.slaEvent.findMany({ where: { threadId, cycleStart: cycle } })).map((e) => [e.stepId, e.firedAt]));
    return {
      policy: { id: policy.id, name: policy.name },
      dueAt: t.slaDueAt?.toISOString() ?? null,
      breachedAt: t.slaBreachedAt?.toISOString() ?? null,
      timezone: policy.calendar.timezone,
      steps: this.plan(policy, cycle).map((p) => ({
        action: p.step.action,
        afterBusinessMinutes: p.step.afterBusinessMinutes,
        dueAt: p.dueAt?.toISOString() ?? null,
        firedAt: fired.get(p.step.id)?.toISOString() ?? null,
        marksOverdue: p.step.marksOverdue,
      })),
    };
  }
}
