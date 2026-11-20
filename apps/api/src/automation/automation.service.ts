import { Injectable } from '@nestjs/common';
import type { AutomationRule, Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import type { AutomationRuleView, AutomationRunView, AutomationTestResult } from '@crm/shared';
import type { z } from 'zod';
import type { automationRuleSchema } from '@crm/shared';
import { AccessPolicy } from '../access/access-policy.service';
import { AuditService, diff } from '../audit/audit.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationEngine, type AutomationAction } from './automation-engine';

type Input = z.infer<typeof automationRuleSchema>;

/**
 * Automation rules admin (`automation.manage`). Company-wide scope manages every rule; department
 * scope only rules limited to its own departments, whose actions stay inside those departments.
 */
@Injectable()
export class AutomationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly audit: AuditService,
    private readonly engine: AutomationEngine,
  ) {}

  private async scope(ctx: RequestContext): Promise<{ all: boolean; depts: string[] }> {
    const s = ctx.permissions['automation.manage'];
    if (s === 'ALL') return { all: true, depts: [] };
    if (s === 'DEPARTMENT') return { all: false, depts: await this.access.departmentIds(ctx) };
    throw Errors.forbidden();
  }

  private async views(rows: (AutomationRule & { department: { id: string; name: string } | null })[]): Promise<AutomationRuleView[]> {
    const [last, counts] = await Promise.all([
      this.prisma.automationRun.findMany({ where: { ruleId: { in: rows.map((r) => r.id) } }, orderBy: { startedAt: 'desc' }, distinct: ['ruleId'], select: { ruleId: true, status: true, startedAt: true } }),
      this.prisma.automationRun.groupBy({ by: ['ruleId'], where: { ruleId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }),
    ]);
    return rows.map((r) => {
      const l = last.find((x) => x.ruleId === r.id);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        trigger: r.trigger,
        department: r.department,
        isEnabled: r.isEnabled,
        position: r.position,
        conditions: r.conditions as unknown as AutomationRuleView['conditions'],
        actions: r.actions as unknown as AutomationRuleView['actions'],
        lastRun: l ? { status: l.status, startedAt: l.startedAt.toISOString() } : null,
        runCount: counts.find((c) => c.ruleId === r.id)?._count._all ?? 0,
        canEdit: true,
      };
    });
  }

  async list(ctx: RequestContext) {
    const s = await this.scope(ctx);
    const rows = await this.prisma.automationRule.findMany({
      where: s.all ? {} : { departmentId: { in: s.depts } },
      include: { department: { select: { id: true, name: true } } },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return this.views(rows);
  }

  private async editable(ctx: RequestContext, id: string) {
    const s = await this.scope(ctx);
    const r = await this.prisma.automationRule.findUnique({ where: { id } });
    if (!r || (!s.all && (!r.departmentId || !s.depts.includes(r.departmentId)))) throw Errors.notFound('Automation rule');
    return r;
  }

  /** References must exist; department-scoped rules stay inside their department. */
  private async validate(ctx: RequestContext, input: Input) {
    const s = await this.scope(ctx);
    const bad = (path: string, message: string) => Errors.validation([{ path, message }]);
    if (!s.all) {
      if (!input.departmentId) throw bad('departmentId', 'Choose your department: company-wide rules need administrator rights');
      if (!s.depts.includes(input.departmentId)) throw bad('departmentId', 'Choose one of your departments');
    }
    if (input.departmentId && !(await this.prisma.department.count({ where: { id: input.departmentId } }))) throw bad('departmentId', 'Unknown department');
    const dept = input.departmentId ?? null;
    const userOk = async (id: string) => !!(await this.prisma.user.count({ where: { id, status: { in: ['ACTIVE', 'INVITED'] }, ...(dept && !s.all ? { departmentId: dept } : {}) } }));
    for (const [i, a] of (input.actions as AutomationAction[]).entries()) {
      const path = `actions.${i}`;
      if (a.type === 'assign') {
        if (a.targetType === 'USER' && !(await userOk(a.targetUserId!))) throw bad(path, 'Unknown employee, or outside the department');
        if (a.targetType === 'TEAM' && !(await this.prisma.team.count({ where: { id: a.teamId!, ...(dept && !s.all ? { departmentId: dept } : {}) } }))) throw bad(path, 'Unknown team, or outside the department');
        if (a.targetType === 'DEPARTMENT' && (!(await this.prisma.department.count({ where: { id: a.departmentId! } })) || (!s.all && a.departmentId !== dept))) throw bad(path, 'Unknown department, or not this rule’s department');
      }
      if (a.type === 'add_tag' && !(await this.prisma.tag.count({ where: { id: a.tagId } }))) throw bad(path, 'Unknown tag');
      if (a.type === 'notify') for (const u of a.userIds) if (!(await userOk(u))) throw bad(path, 'Unknown employee, or outside the department');
      if (a.type === 'create_task' && a.assignTo === 'user' && !(await userOk(a.userId!))) throw bad(path, 'Unknown employee, or outside the department');
      if (a.type === 'reassign_absent' && a.to === 'user' && !(await userOk(a.userId!))) throw bad(path, 'Unknown employee, or outside the department');
    }
    for (const c of input.conditions.conditions) {
      if (c.field === 'mailbox' && !(await this.prisma.emailAccount.count({ where: { id: c.value } }))) throw bad('conditions', 'Unknown mailbox in a condition');
    }
  }

  private data(input: Input) {
    return {
      name: input.name,
      description: input.description ?? null,
      trigger: input.trigger,
      departmentId: input.departmentId ?? null,
      isEnabled: input.isEnabled,
      conditions: input.conditions as unknown as Prisma.InputJsonValue,
      actions: input.actions as unknown as Prisma.InputJsonValue,
    };
  }

  private async one(id: string) {
    return (await this.views([await this.prisma.automationRule.findUniqueOrThrow({ where: { id }, include: { department: { select: { id: true, name: true } } } })]))[0]!;
  }

  async create(ctx: RequestContext, input: Input) {
    await this.validate(ctx, input);
    const id = newId();
    const data = this.data(input);
    await this.prisma.$transaction(async (tx) => {
      const max = await tx.automationRule.aggregate({ _max: { position: true } });
      await tx.automationRule.create({ data: { id, ...data, position: (max._max.position ?? 0) + 1, createdById: ctx.userId } });
      await this.audit.record(tx, ctx, { action: 'automation.create', entityType: 'AutomationRule', entityId: id, after: data });
    });
    return this.one(id);
  }

  async update(ctx: RequestContext, id: string, input: Input) {
    const before = await this.editable(ctx, id);
    await this.validate(ctx, input);
    const data = this.data(input);
    await this.prisma.$transaction(async (tx) => {
      await tx.automationRule.update({ where: { id }, data });
      const d = diff(before as unknown as Record<string, unknown>, data as unknown as Record<string, unknown>);
      if (d.changed) await this.audit.record(tx, ctx, { action: 'automation.update', entityType: 'AutomationRule', entityId: id, before: d.before, after: d.after });
    });
    return this.one(id);
  }

  async setEnabled(ctx: RequestContext, id: string, isEnabled: boolean) {
    const before = await this.editable(ctx, id);
    if (before.isEnabled !== isEnabled) {
      await this.prisma.$transaction(async (tx) => {
        await tx.automationRule.update({ where: { id }, data: { isEnabled } });
        await this.audit.record(tx, ctx, { action: isEnabled ? 'automation.enable' : 'automation.disable', entityType: 'AutomationRule', entityId: id });
      });
    }
    return this.one(id);
  }

  async remove(ctx: RequestContext, id: string) {
    const before = await this.editable(ctx, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.automationRule.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'automation.delete', entityType: 'AutomationRule', entityId: id, before: { name: before.name } });
    });
  }

  async runs(ctx: RequestContext, id: string): Promise<AutomationRunView[]> {
    await this.editable(ctx, id);
    const rows = await this.prisma.automationRun.findMany({ where: { ruleId: id }, orderBy: { startedAt: 'desc' }, take: 100 });
    const threads = new Map(
      (await this.prisma.emailThread.findMany({ where: { id: { in: rows.flatMap((r) => (r.threadId ? [r.threadId] : [])) } }, select: { id: true, subject: true } })).map((t) => [t.id, t]),
    );
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      error: r.error,
      thread: r.threadId ? (threads.get(r.threadId) ?? null) : null,
      output: (r.output as AutomationRunView['output'] | null) ?? [],
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    }));
  }

  /** Dry run of a saved rule against a conversation the caller can read. Writes nothing. */
  async test(ctx: RequestContext, id: string, threadId: string): Promise<AutomationTestResult> {
    const rule = await this.editable(ctx, id);
    if (!ctx.permissions['conversation.read'] || !(await this.prisma.emailThread.count({ where: { AND: [{ id: threadId }, await this.access.threadWhere(ctx)] } }))) throw Errors.notFound('Conversation');
    return this.engine.describe(rule, threadId);
  }
}
