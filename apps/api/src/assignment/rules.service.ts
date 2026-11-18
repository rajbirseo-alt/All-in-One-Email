import { Injectable } from '@nestjs/common';
import type { Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import type { AssignmentRuleView, RuleTestResult } from '@crm/shared';
import type { z } from 'zod';
import type { assignmentRuleSchema, ruleTestSchema } from '@crm/shared';
import { AccessPolicy } from '../access/access-policy.service';
import { AuditService, diff } from '../audit/audit.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { AssignmentService } from './assignment.service';
import { RoutingService, matches, type RuleConditions, type RuleFacts } from './routing.service';

const include = {
  team: { select: { id: true, name: true, departmentId: true } },
  department: { select: { id: true, name: true } },
} satisfies Prisma.AssignmentRuleInclude;
type Row = Prisma.AssignmentRuleGetPayload<{ include: typeof include }>;

/**
 * Assignment rules. `rules.manage` at ALL scope manages every rule; at DEPARTMENT scope only rules
 * that route into the manager's own departments (and only those are shown to them).
 */
@Injectable()
export class RulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly audit: AuditService,
    private readonly assignment: AssignmentService,
    private readonly routing: RoutingService,
  ) {}

  private async userNames(ids: (string | null)[]) {
    const rows = await this.prisma.user.findMany({ where: { id: { in: ids.filter((x): x is string => !!x) } }, select: { id: true, name: true, departmentId: true } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Departments a rule routes into. */
  private async ruleDepartment(r: { targetType: string; targetUserId: string | null; teamId: string | null; departmentId: string | null }) {
    if (r.targetType === 'USER') return (await this.prisma.user.findUnique({ where: { id: r.targetUserId! }, select: { departmentId: true } }))?.departmentId ?? null;
    if (r.targetType === 'TEAM') return (await this.prisma.team.findUnique({ where: { id: r.teamId! }, select: { departmentId: true } }))?.departmentId ?? null;
    return r.departmentId;
  }

  private async allowed(ctx: RequestContext, r: Parameters<RulesService['ruleDepartment']>[0]) {
    const scope = ctx.permissions['rules.manage'];
    if (scope === 'ALL') return true;
    if (scope !== 'DEPARTMENT') return false;
    const dept = await this.ruleDepartment(r);
    return !!dept && (await this.access.departmentIds(ctx)).includes(dept);
  }

  private async view(ctx: RequestContext, rows: Row[]): Promise<AssignmentRuleView[]> {
    const users = await this.userNames(rows.map((r) => r.targetUserId));
    const out: AssignmentRuleView[] = [];
    for (const r of rows) {
      if (!(await this.allowed(ctx, r))) continue;
      const u = r.targetUserId ? users.get(r.targetUserId) : null;
      out.push({
        id: r.id,
        name: r.name,
        position: r.position,
        isEnabled: r.isEnabled,
        conditions: r.conditions as unknown as AssignmentRuleView['conditions'],
        targetType: r.targetType,
        targetUser: u ? { id: u.id, name: u.name } : null,
        team: r.team ? { id: r.team.id, name: r.team.name } : null,
        department: r.department,
        strategy: r.strategy,
        setPriority: r.setPriority,
        canEdit: true,
      });
    }
    return out;
  }

  async list(ctx: RequestContext) {
    const rows = await this.prisma.assignmentRule.findMany({ include, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    return this.view(ctx, rows);
  }

  private async validate(input: z.infer<typeof assignmentRuleSchema>) {
    const bad = (path: string, message: string) => Errors.validation([{ path, message }]);
    if (input.targetType === 'USER' && !(await this.prisma.user.count({ where: { id: input.targetUserId!, status: { in: ['ACTIVE', 'INVITED'] } } }))) throw bad('targetUserId', 'Unknown employee');
    if (input.targetType === 'TEAM' && !(await this.prisma.team.count({ where: { id: input.teamId! } }))) throw bad('teamId', 'Unknown team');
    if (input.targetType === 'DEPARTMENT' && !(await this.prisma.department.count({ where: { id: input.departmentId! } }))) throw bad('departmentId', 'Unknown department');
    for (const c of input.conditions.conditions) {
      if (c.field === 'mailbox' && !(await this.prisma.emailAccount.count({ where: { id: c.value } }))) throw bad('conditions', 'Unknown mailbox in a condition');
    }
  }

  private data(input: z.infer<typeof assignmentRuleSchema>) {
    return {
      name: input.name,
      isEnabled: input.isEnabled,
      conditions: input.conditions as unknown as Prisma.InputJsonValue,
      targetType: input.targetType,
      targetUserId: input.targetType === 'USER' ? input.targetUserId! : null,
      teamId: input.targetType === 'TEAM' ? input.teamId! : null,
      departmentId: input.targetType === 'DEPARTMENT' ? input.departmentId! : null,
      strategy: input.targetType === 'USER' ? ('DIRECT' as const) : input.strategy,
      setPriority: input.setPriority ?? null,
    };
  }

  async create(ctx: RequestContext, input: z.infer<typeof assignmentRuleSchema>) {
    await this.validate(input);
    const data = this.data(input);
    if (!(await this.allowed(ctx, data))) throw Errors.forbidden('You can only create rules that route into your own department');
    const id = newId();
    await this.prisma.$transaction(async (tx) => {
      const max = await tx.assignmentRule.aggregate({ _max: { position: true } });
      await tx.assignmentRule.create({ data: { id, ...data, position: (max._max.position ?? 0) + 1, createdById: ctx.userId } });
      await this.audit.record(tx, ctx, { action: 'rule.create', entityType: 'AssignmentRule', entityId: id, after: data });
    });
    return (await this.list(ctx)).find((r) => r.id === id)!;
  }

  private async editable(ctx: RequestContext, id: string) {
    const r = await this.prisma.assignmentRule.findUnique({ where: { id } });
    if (!r || !(await this.allowed(ctx, r))) throw Errors.notFound('Rule');
    return r;
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof assignmentRuleSchema>) {
    const before = await this.editable(ctx, id);
    await this.validate(input);
    const data = this.data(input);
    if (!(await this.allowed(ctx, data))) throw Errors.forbidden('You can only route into your own department');
    await this.prisma.$transaction(async (tx) => {
      await tx.assignmentRule.update({ where: { id }, data });
      const d = diff(before as unknown as Record<string, unknown>, data as unknown as Record<string, unknown>);
      if (d.changed) await this.audit.record(tx, ctx, { action: 'rule.update', entityType: 'AssignmentRule', entityId: id, before: d.before, after: d.after });
    });
    return (await this.list(ctx)).find((r) => r.id === id)!;
  }

  async remove(ctx: RequestContext, id: string) {
    const before = await this.editable(ctx, id);
    await this.prisma.$transaction(async (tx) => {
      // Past assignments keep their history; only the link to the deleted rule is cleared.
      await tx.assignment.updateMany({ where: { ruleId: id }, data: { ruleId: null } });
      await tx.assignmentRule.delete({ where: { id } });
      await this.audit.record(tx, ctx, { action: 'rule.delete', entityType: 'AssignmentRule', entityId: id, before: { name: before.name } });
    });
  }

  /** Whole-list reordering changes everyone's routing, so it needs ALL scope. */
  async reorder(ctx: RequestContext, ids: string[]) {
    if (ctx.permissions['rules.manage'] !== 'ALL') throw Errors.forbidden('Only administrators can reorder all rules');
    const existing = await this.prisma.assignmentRule.findMany({ select: { id: true } });
    if (existing.length !== ids.length || !existing.every((r) => ids.includes(r.id))) throw Errors.validation([{ path: 'ids', message: 'List every rule exactly once' }]);
    await this.prisma.$transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.assignmentRule.update({ where: { id }, data: { position: i + 1 } });
      await this.audit.record(tx, ctx, { action: 'rule.reorder', entityType: 'AssignmentRule', after: ids });
    });
    return this.list(ctx);
  }

  /** Dry run: which rule would match and who would get it now. Writes nothing, advances nothing. */
  async test(ctx: RequestContext, input: z.infer<typeof ruleTestSchema>): Promise<RuleTestResult> {
    let facts: RuleFacts | null;
    if (input.threadId) {
      const visible = await this.prisma.emailThread.count({ where: { AND: [{ id: input.threadId }, await this.access.threadWhere(ctx)] } });
      if (!visible) throw Errors.notFound('Conversation');
      facts = await this.routing.factsFor(input.threadId);
      if (!facts) throw Errors.validation([{ path: 'threadId', message: 'This conversation has no incoming message' }]);
    } else {
      const s = input.sample!;
      const from = s.from.trim().toLowerCase();
      facts = { mailbox: s.accountId, from, fromDomain: from.split('@')[1] ?? '', to: s.to.split(/[,;]/).map((x) => x.trim().toLowerCase()).filter(Boolean), subject: s.subject, body: s.body };
    }
    const rules = await this.routing.enabledRules();
    const checked = rules.map((r) => ({ id: r.id, name: r.name, matched: matches(r.conditions as unknown as RuleConditions, facts!) }));
    const rule = rules.find((r) => checked.find((c) => c.id === r.id)!.matched) ?? null;
    const named = async (id: string | null) => (id ? this.prisma.user.findUnique({ where: { id }, select: { id: true, name: true } }) : null);
    let wouldAssignTo: { id: string; name: string } | null = null;
    if (rule?.targetType === 'USER') wouldAssignTo = await named(rule.targetUserId);
    else if (rule) wouldAssignTo = await this.assignment.pick({ teamId: rule.teamId, departmentId: rule.teamId ? null : rule.departmentId }, rule.strategy);
    const [team, department] = await Promise.all([
      rule?.teamId ? this.prisma.team.findUnique({ where: { id: rule.teamId }, select: { id: true, name: true } }) : null,
      rule?.departmentId ? this.prisma.department.findUnique({ where: { id: rule.departmentId }, select: { id: true, name: true } }) : null,
    ]);
    // Rules of other departments still decide the routing, but their names are not shown.
    const visible = new Set<string>();
    for (const r of rules) if (await this.allowed(ctx, r)) visible.add(r.id);
    const shown = (r: { id: string; name: string }) => (visible.has(r.id) ? r : { id: '', name: "Another department's rule" });
    return {
      rule: rule ? shown({ id: rule.id, name: rule.name }) : null,
      wouldAssignTo,
      queue: { team, department },
      checked: checked.filter((c) => visible.has(c.id)),
    };
  }
}
