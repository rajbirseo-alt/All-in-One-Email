import { Injectable } from '@nestjs/common';
import { Prisma, type AssignmentMethod, type AssignmentStrategy, type Priority } from '@crm/db';
import { newId } from '@crm/crypto';
import type { AssigneeOptions } from '@crm/shared';
import { AccessPolicy } from '../access/access-policy.service';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { EventsPublisher } from '../events/events.service';
import { NotificationsService, type Outbox } from '../notifications/notifications.service';
import { PrismaService, asSystem, systemStep, type Tx } from '../prisma/prisma.service';
import { SlaService } from '../sla/sla.service';

export interface AssignTarget {
  assigneeId?: string | null;
  teamId?: string | null;
  departmentId?: string | null;
}

export interface AssignMeta {
  method: AssignmentMethod;
  actor: RequestContext | null;
  ruleId?: string | null;
  reason?: string | null;
  setPriority?: Priority | null;
}

/** Statuses that count as open work for least-loaded routing. */
const OPEN_WORK: Prisma.EmailThreadWhereInput = { status: { notIn: ['CLOSED', 'REPLY_NOT_NEEDED'] }, isArchived: false, isSpam: false, isTrashed: false };

const available = (now: Date): Prisma.UserWhereInput => ({ status: 'ACTIVE', OR: [{ isAbsent: false }, { absentUntil: { lt: now } }] });

@Injectable()
export class AssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly audit: AuditService,
    private readonly events: EventsPublisher,
    private readonly notifications: NotificationsService,
    private readonly sla: SlaService,
  ) {}

  // ───────────── who may assign to whom ─────────────

  /** People, teams and departments the caller may assign to (by `conversation.assign` scope). */
  async options(ctx: RequestContext): Promise<AssigneeOptions> {
    const scope = ctx.permissions['conversation.assign'];
    if (!scope) return { users: [], teams: [], departments: [] };
    const userSel = { id: true, name: true, email: true, isAbsent: true } as const;
    if (scope === 'ALL') {
      const [users, teams, departments] = await Promise.all([
        this.prisma.user.findMany({ where: { status: 'ACTIVE' }, select: userSel, orderBy: { name: 'asc' } }),
        this.prisma.team.findMany({ select: { id: true, name: true, departmentId: true }, orderBy: { name: 'asc' } }),
        this.prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      ]);
      return { users, teams, departments };
    }
    if (scope === 'DEPARTMENT') {
      const depts = await this.access.departmentIds(ctx);
      const [users, teams, departments] = await Promise.all([
        this.prisma.user.findMany({ where: { status: 'ACTIVE', OR: [{ id: ctx.userId }, { departmentId: { in: depts } }] }, select: userSel, orderBy: { name: 'asc' } }),
        this.prisma.team.findMany({ where: { departmentId: { in: depts } }, select: { id: true, name: true, departmentId: true }, orderBy: { name: 'asc' } }),
        this.prisma.department.findMany({ where: { id: { in: depts } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      ]);
      return { users, teams, departments };
    }
    // TEAM (and narrower): own teams and their members only.
    const teamIds = await this.access.teamIds(ctx);
    const [users, teams] = await Promise.all([
      this.prisma.user.findMany({ where: { status: 'ACTIVE', OR: [{ id: ctx.userId }, { teamMemberships: { some: { teamId: { in: teamIds } } } }] }, select: userSel, orderBy: { name: 'asc' } }),
      this.prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true, departmentId: true }, orderBy: { name: 'asc' } }),
    ]);
    return { users, teams, departments: [] };
  }

  private async assertTarget(ctx: RequestContext, t: AssignTarget) {
    const o = await this.options(ctx);
    const bad = (path: string) => Errors.validation([{ path, message: 'You cannot assign to this person, team or department' }]);
    if (t.assigneeId && !o.users.some((u) => u.id === t.assigneeId)) throw bad('assigneeId');
    if (t.teamId && !o.teams.some((x) => x.id === t.teamId)) throw bad('teamId');
    if (t.departmentId && !o.departments.some((x) => x.id === t.departmentId)) throw bad('departmentId');
  }

  /** The thread if the caller may assign it (404 if invisible, 403 if visible but outside the assign scope). */
  async assignable(ctx: RequestContext, threadId: string) {
    if (!ctx.permissions['conversation.assign']) throw Errors.forbidden();
    const t = await this.prisma.emailThread.findFirst({ where: { AND: [{ id: threadId }, await this.access.threadWhere(ctx, 'conversation.assign')] } });
    if (t) return t;
    const readable = await this.prisma.emailThread.count({ where: { AND: [{ id: threadId }, await this.access.threadWhere(ctx)] } });
    throw readable ? Errors.forbidden() : Errors.notFound('Conversation');
  }

  async canAssign(ctx: RequestContext, threadId: string) {
    if (!ctx.permissions['conversation.assign']) return false;
    return (await this.prisma.emailThread.count({ where: { AND: [{ id: threadId }, await this.access.threadWhere(ctx, 'conversation.assign')] } })) > 0;
  }

  async assignByUser(ctx: RequestContext, threadId: string, target: AssignTarget, method: AssignmentMethod = 'MANUAL', reason?: string) {
    await this.assignable(ctx, threadId);
    await this.assertTarget(ctx, target);
    await this.apply(threadId, target, { method, actor: ctx, reason });
  }

  async unassignByUser(ctx: RequestContext, threadId: string, method: AssignmentMethod = 'MANUAL') {
    await this.assignable(ctx, threadId);
    await this.apply(threadId, { assigneeId: null, teamId: null, departmentId: null }, { method, actor: ctx });
  }

  // ───────────── the one place assignments are written ─────────────

  /**
   * Assigns under a row lock on the thread, so concurrent assignments serialise: exactly one
   * current Assignment row remains and the thread always matches it.
   */
  async apply(threadId: string, target: AssignTarget, meta: AssignMeta): Promise<boolean> {
    const pending: { outbox: Outbox | null } = { outbox: null };
    const changed = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM email_threads WHERE id = ${threadId} FOR UPDATE`);
        const t = await tx.emailThread.findUnique({ where: { id: threadId } });
        if (!t) throw Errors.notFound('Conversation');

        let { assigneeId = null, teamId = null, departmentId = null } = target;
        if (assigneeId) {
          const u = await tx.user.findUnique({ where: { id: assigneeId }, select: { departmentId: true, teamMemberships: { select: { teamId: true } } } });
          if (!u) throw Errors.validation([{ path: 'assigneeId', message: 'Unknown employee' }]);
          // Keep the team queue when the person belongs to it; otherwise the person's own department.
          if (!teamId && t.teamId && u.teamMemberships.some((m) => m.teamId === t.teamId)) teamId = t.teamId;
          departmentId ??= u.departmentId ?? (teamId ? null : t.departmentId);
        }
        if (teamId && !departmentId) departmentId = (await tx.team.findUnique({ where: { id: teamId }, select: { departmentId: true } }))?.departmentId ?? null;

        if (t.assigneeId === assigneeId && t.teamId === teamId && t.departmentId === departmentId && !meta.setPriority) return false;

        const now = new Date();
        await tx.assignment.updateMany({ where: { threadId, endedAt: null }, data: { endedAt: now } });
        if (assigneeId || teamId || departmentId) {
          await tx.assignment.create({
            data: { id: newId(), threadId, assigneeId, teamId, departmentId, assignedById: meta.actor?.userId ?? null, method: meta.method, ruleId: meta.ruleId ?? null, reason: meta.reason ?? null },
          });
        }
        const status = assigneeId && t.status === 'NEW' ? 'ASSIGNED' : !assigneeId && t.status === 'ASSIGNED' ? 'NEW' : t.status;
        // After a hand-over the conversation may no longer be visible to whoever handed it over, and
        // Postgres RLS checks the new row against the read policy. The hand-over itself was authorised
        // above (assignable / rule), so this one write runs as the system.
        await systemStep(tx, () =>
          tx.emailThread.updateMany({
            where: { id: threadId },
            data: { assigneeId, teamId, departmentId, status, ...(meta.setPriority ? { priority: meta.setPriority } : {}) },
          }),
        );
        if (status !== t.status) {
          await tx.statusHistory.create({
            data: { id: newId(), threadId, fromStatus: t.status, toStatus: status, changedById: meta.actor?.userId ?? null, source: meta.actor ? 'USER' : 'SYSTEM', reason: 'assignment' },
          });
        }
        if (assigneeId && assigneeId !== t.assigneeId && assigneeId !== meta.actor?.userId) {
          pending.outbox = await this.notifications.createIn(tx, [
            {
              userId: assigneeId,
              type: t.assigneeId ? 'REASSIGNED' : 'ASSIGNED',
              title: `Assigned to you: ${t.subject}`,
              body: meta.reason ?? null,
              threadId,
              data: { method: meta.method, ruleId: meta.ruleId ?? null },
            },
          ]);
        }
        await this.audit.record(tx, meta.actor ?? { userId: null, actorType: 'SYSTEM' }, {
          action: assigneeId || teamId || departmentId ? 'thread.assign' : 'thread.unassign',
          entityType: 'EmailThread',
          entityId: threadId,
          before: { assigneeId: t.assigneeId, teamId: t.teamId, departmentId: t.departmentId },
          after: { assigneeId, teamId, departmentId },
          metadata: { method: meta.method, ruleId: meta.ruleId ?? null, reason: meta.reason ?? null },
        });
        return true;
      },
      { timeout: 15_000 },
    );
    if (pending.outbox) await this.notifications.flush(pending.outbox);
    if (changed) {
      // A new department or priority can mean a different SLA policy. System follow-ups: they must
      // also run when the conversation has just left the actor's view.
      await asSystem(async () => {
        await this.sla.evaluate([threadId]).catch(() => undefined);
        await this.events.threadsChanged([threadId]);
      });
    }
    return changed;
  }

  // ───────────── picking a person in a team or department ─────────────

  /** Eligible people: active, not away; team members only when in rotation. Ordered by id for a stable rotation. */
  private async candidates(db: Tx, pool: { teamId?: string | null; departmentId?: string | null }) {
    const now = new Date();
    const where: Prisma.UserWhereInput = pool.teamId
      ? { ...available(now), teamMemberships: { some: { teamId: pool.teamId, inRotation: true } } }
      : { ...available(now), departmentId: pool.departmentId! };
    return (await db.user.findMany({ where, select: { id: true, name: true }, orderBy: { id: 'asc' } })) as { id: string; name: string }[];
  }

  /**
   * Picks who gets the next conversation for a team/department. With `lock`, a transaction-level
   * advisory lock serialises concurrent picks for the same pool (round-robin never hands two new
   * conversations to the same person because of a race). Without it (dry-run) nothing is written.
   */
  async pick(pool: { teamId?: string | null; departmentId?: string | null }, strategy: AssignmentStrategy, db: Tx = this.prisma, lock = false) {
    if (strategy === 'DIRECT') return null;
    const key = pool.teamId ?? pool.departmentId!;
    if (lock) await db.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`rr:${key}`}))`);
    const people = await this.candidates(db, pool);
    if (!people.length) return null;
    const lastAssigned = async () => {
      const rows = await db.assignment.findMany({
        where: { assigneeId: { in: people.map((p) => p.id) }, ...(pool.teamId ? { teamId: pool.teamId } : { departmentId: pool.departmentId }) },
        orderBy: { createdAt: 'desc' },
        select: { assigneeId: true, createdAt: true },
        take: 500,
      });
      const last = new Map<string, number>();
      for (const r of rows) if (r.assigneeId && !last.has(r.assigneeId)) last.set(r.assigneeId, r.createdAt.getTime());
      return { last, latest: rows[0]?.assigneeId ?? null };
    };
    if (strategy === 'ROUND_ROBIN') {
      const { latest } = await lastAssigned();
      const i = latest ? people.findIndex((p) => p.id === latest) : -1;
      return people[(i + 1) % people.length]!;
    }
    // LEAST_LOADED: fewest open conversations; ties go to whoever was assigned least recently.
    const load = await db.emailThread.groupBy({ by: ['assigneeId'], where: { ...OPEN_WORK, assigneeId: { in: people.map((p) => p.id) } }, _count: { _all: true } });
    const count = new Map(load.map((l) => [l.assigneeId, l._count._all]));
    const { last } = await lastAssigned();
    return [...people].sort((a, b) => (count.get(a.id) ?? 0) - (count.get(b.id) ?? 0) || (last.get(a.id) ?? 0) - (last.get(b.id) ?? 0))[0]!;
  }

  /**
   * Assigns into a pool with a strategy, atomically (pick + assign under the pool lock). Rule
   * routing records the strategy as the method; automation and absence keep their own method.
   */
  async assignToPool(threadId: string, pool: { teamId?: string | null; departmentId?: string | null }, strategy: AssignmentStrategy, meta: AssignMeta) {
    if (strategy === 'DIRECT') return this.apply(threadId, { teamId: pool.teamId ?? null, departmentId: pool.departmentId ?? null }, meta);
    return this.prisma.$transaction(async (tx) => {
      const who = await this.pick(pool, strategy, tx, true);
      // The lock is held until this transaction ends; apply() runs its own row-locked transaction.
      return this.apply(threadId, { assigneeId: who?.id ?? null, teamId: pool.teamId ?? null, departmentId: pool.departmentId ?? null }, { ...meta, method: who && meta.method === 'RULE' ? (strategy === 'ROUND_ROBIN' ? 'ROUND_ROBIN' : 'LEAST_LOADED') : meta.method });
    }, { timeout: 20_000 });
  }
}
