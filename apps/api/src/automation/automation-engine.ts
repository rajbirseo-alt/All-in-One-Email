import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type AutomationRule } from '@crm/db';
import { newId } from '@crm/crypto';
import type { Participant } from '@crm/shared';
import type { z } from 'zod';
import type { automationActionSchema } from '@crm/shared';
import { PermissionService } from '../access/permission.service';
import { htmlText } from '../assignment/routing.service';
import { AssignmentService } from '../assignment/assignment.service';
import type { RequestContext } from '../common/request-context';
import { DraftsService } from '../compose/drafts.service';
import { LeadsService } from '../crm/leads.service';
import { TasksService } from '../crm/tasks.service';
import { InsightsService } from '../ai/insights.service';
import { SuggestionsService } from '../ai/suggestions.service';
import type { AutomationJob } from '../mail/queue.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { StatusService } from '../status/status.service';

export type AutomationAction = z.infer<typeof automationActionSchema>;
export interface Conditions {
  match: 'all' | 'any';
  conditions: { field: string; op: 'is' | 'contains' | 'notContains' | 'startsWith' | 'endsWith'; value: string }[];
}
export interface ActionResult {
  type: string;
  ok: boolean;
  detail: string;
}

/** Facts a rule's conditions are checked against (all lower-cased strings). */
export type Facts = Record<string, string | string[]>;

const OPEN_WORK = { status: { notIn: ['CLOSED', 'REPLY_NOT_NEEDED'] as ('CLOSED' | 'REPLY_NOT_NEEDED')[] }, isSpam: false, isTrashed: false };

function test(op: Conditions['conditions'][number]['op'], actual: string, expected: string) {
  const a = actual.toLowerCase();
  const e = expected.toLowerCase();
  switch (op) {
    case 'is':
      return a === e;
    case 'contains':
      return a.includes(e);
    case 'notContains':
      return !a.includes(e);
    case 'startsWith':
      return a.startsWith(e);
    case 'endsWith':
      return a.endsWith(e);
  }
}

export function conditionsMatch(c: Conditions, f: Facts): boolean {
  if (!c.conditions.length) return true;
  const one = (x: Conditions['conditions'][number]) => {
    const v = f[x.field];
    if (Array.isArray(v)) return x.op === 'notContains' ? v.every((t) => test('notContains', t, x.value)) : v.some((t) => test(x.op, t, x.value));
    return test(x.op, v ?? '', x.value);
  };
  return c.match === 'any' ? c.conditions.some(one) : c.conditions.every(one);
}

/**
 * Runs automation rules for one event. Each rule runs at most once per event (unique
 * idempotency key), in position order, and every run is logged with what each action did.
 *
 * The action set is closed (see `automationActionSchema`): none of them sends email.
 * `request_ai_draft` only writes a DRAFT for the assignee to review and send themselves.
 */
@Injectable()
export class AutomationEngine {
  private readonly log = new Logger(AutomationEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly assignment: AssignmentService,
    private readonly status: StatusService,
    private readonly notifications: NotificationsService,
    private readonly tasks: TasksService,
    private readonly leads: LeadsService,
    private readonly insights: InsightsService,
    private readonly suggestions: SuggestionsService,
    private readonly drafts: DraftsService,
    private readonly permissions: PermissionService,
  ) {}

  /** The latest incoming message and the conversation's state, plus the cached AI insights. */
  async threadFacts(threadId: string): Promise<Facts | null> {
    const t = await this.prisma.emailThread.findUnique({ where: { id: threadId }, include: { assignee: { select: { isAbsent: true, absentUntil: true } } } });
    if (!t) return null;
    const m = await this.prisma.emailMessage.findFirst({
      where: { threadId, direction: 'INBOUND' },
      orderBy: { receivedAt: 'desc' },
      select: { fromAddress: true, toRecipients: true, ccRecipients: true, subject: true, bodyText: true, bodyHtml: true },
    });
    const people = (v: Prisma.JsonValue) => (Array.isArray(v) ? (v as unknown as Participant[]).map((p) => p.address.toLowerCase()) : []);
    const ai = await this.insights.facts(threadId);
    const absent = !!t.assignee?.isAbsent && (!t.assignee.absentUntil || t.assignee.absentUntil > new Date());
    return {
      mailbox: t.emailAccountId,
      from: m?.fromAddress.toLowerCase() ?? '',
      fromDomain: m?.fromAddress.split('@')[1]?.toLowerCase() ?? '',
      to: m ? [...people(m.toRecipients), ...people(m.ccRecipients)] : [],
      subject: m?.subject ?? t.subject,
      body: (m?.bodyText ?? htmlText(m?.bodyHtml ?? '')).slice(0, 20_000),
      priority: t.priority,
      status: t.status,
      category: ai.category,
      urgency: ai.urgency,
      sentiment: ai.sentiment,
      assigned: t.assigneeId ? 'yes' : 'no',
      assigneeAbsent: absent ? 'yes' : 'no',
    };
  }

  /** Department the event belongs to: the conversation's (or its mailbox's), or the absent person's. */
  async eventDepartment(job: { threadId?: string | null; userId?: string | null }) {
    if (job.threadId) {
      const t = await this.prisma.emailThread.findUnique({ where: { id: job.threadId }, select: { departmentId: true, emailAccount: { select: { departmentId: true } } } });
      return t?.departmentId ?? t?.emailAccount.departmentId ?? null;
    }
    if (job.userId) return (await this.prisma.user.findUnique({ where: { id: job.userId }, select: { departmentId: true } }))?.departmentId ?? null;
    return null;
  }

  async run(job: AutomationJob): Promise<number> {
    const rules = await this.prisma.automationRule.findMany({ where: { trigger: job.trigger, isEnabled: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
    if (!rules.length) return 0;
    const facts = job.threadId ? await this.threadFacts(job.threadId) : {};
    if (!facts) return 0;
    const dept = await this.eventDepartment(job);
    let ran = 0;
    for (const rule of rules) {
      if (rule.departmentId && rule.departmentId !== dept) continue;
      if (!conditionsMatch(rule.conditions as unknown as Conditions, facts)) continue;
      const runId = newId();
      try {
        await this.prisma.automationRun.create({ data: { id: runId, ruleId: rule.id, threadId: job.threadId ?? null, idempotencyKey: `${rule.id}:${job.eventKey}`, status: 'SUCCEEDED' } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue; // already ran for this event
        throw e;
      }
      ran++;
      const output: ActionResult[] = [];
      let error: string | null = null;
      for (const action of rule.actions as unknown as AutomationAction[]) {
        try {
          output.push(await this.execute(rule, action, job));
        } catch (e) {
          error = (e as Error).message.slice(0, 1000);
          output.push({ type: action.type, ok: false, detail: error });
          this.log.warn(`Automation "${rule.name}" action ${action.type} failed: ${error}`);
          break;
        }
      }
      await this.prisma.automationRun.update({ where: { id: runId }, data: { status: error ? 'FAILED' : 'SUCCEEDED', error, output: output as unknown as Prisma.InputJsonValue, finishedAt: new Date() } });
    }
    return ran;
  }

  /** A request context for an employee (drafts are created with their own permissions). */
  private async actAs(userId: string): Promise<RequestContext | null> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, include: { role: { select: { key: true } } } });
    if (!u || u.status !== 'ACTIVE') return null;
    return { userId: u.id, sessionId: 'automation', roleKey: u.role.key, departmentId: u.departmentId, permissions: await this.permissions.effectiveFor(u.id), ip: null, userAgent: 'automation' };
  }

  private async execute(rule: AutomationRule, a: AutomationAction, job: AutomationJob): Promise<ActionResult> {
    const reason = `Automation: ${rule.name}`;
    const meta = { method: 'AUTOMATION' as const, actor: null, reason };
    const thread = job.threadId ? await this.prisma.emailThread.findUnique({ where: { id: job.threadId }, include: { team: { select: { leaderId: true } }, department: { select: { managerId: true } } } }) : null;
    const ok = (detail: string): ActionResult => ({ type: a.type, ok: true, detail });
    const skip = (detail: string): ActionResult => ({ type: a.type, ok: true, detail: `Skipped: ${detail}` });

    if (a.type === 'reassign_absent') {
      if (!job.userId) return skip('no employee');
      const open = await this.prisma.emailThread.findMany({ where: { assigneeId: job.userId, ...OPEN_WORK }, select: { id: true, teamId: true, departmentId: true } });
      let moved = 0;
      for (const t of open) {
        const m = { ...meta, method: 'ABSENCE_REASSIGN' as const, reason: `${reason} (absence)` };
        if (a.to === 'user' && a.userId) moved += (await this.assignment.apply(t.id, { assigneeId: a.userId }, m)) ? 1 : 0;
        else if (t.teamId) moved += (await this.assignment.assignToPool(t.id, { teamId: t.teamId }, 'ROUND_ROBIN', m)) ? 1 : 0;
        else if (t.departmentId) moved += (await this.assignment.assignToPool(t.id, { departmentId: t.departmentId }, 'ROUND_ROBIN', m)) ? 1 : 0;
      }
      return ok(`${moved} of ${open.length} open conversations reassigned`);
    }

    if (a.type === 'notify') {
      const to = new Set<string>();
      if (a.to === 'users') a.userIds.forEach((u) => to.add(u));
      if (a.to === 'assignee' && thread?.assigneeId) to.add(thread.assigneeId);
      if (a.to === 'team_leader' && thread?.team?.leaderId) to.add(thread.team.leaderId);
      if (a.to === 'department_manager') {
        const managerId = thread?.department?.managerId ?? (job.userId ? (await this.prisma.user.findUnique({ where: { id: job.userId }, select: { department: { select: { managerId: true } } } }))?.department?.managerId : null);
        if (managerId) to.add(managerId);
      }
      if (job.userId && job.trigger === 'USER_ABSENT') to.delete(job.userId);
      if (!to.size) return skip('nobody to notify');
      await this.notifications.notify([...to].map((userId) => ({ userId, type: 'AUTOMATION' as const, title: a.message, body: thread ? `${thread.subject} · ${rule.name}` : rule.name, threadId: thread?.id ?? null })));
      return ok(`Notified ${to.size}`);
    }

    if (!thread) return skip('no conversation');

    switch (a.type) {
      case 'assign': {
        let changed: boolean;
        if (a.targetType === 'USER') changed = await this.assignment.apply(thread.id, { assigneeId: a.targetUserId! }, meta);
        else changed = await this.assignment.assignToPool(thread.id, { teamId: a.targetType === 'TEAM' ? a.teamId : null, departmentId: a.targetType === 'DEPARTMENT' ? a.departmentId : null }, a.strategy, meta);
        const after = await this.prisma.emailThread.findUniqueOrThrow({ where: { id: thread.id }, select: { assignee: { select: { name: true } } } });
        return ok(changed ? `Assigned${after.assignee ? ` to ${after.assignee.name}` : ' to the queue'}` : 'Already assigned that way');
      }
      case 'set_priority':
        return ok((await this.status.setBySystem(thread.id, { priority: a.priority }, reason)) ? `Priority ${a.priority.toLowerCase()}` : 'Priority unchanged');
      case 'set_status':
        return ok((await this.status.setBySystem(thread.id, { status: a.status }, reason)) ? `Status ${a.status}` : 'Status unchanged');
      case 'add_tag': {
        const tag = await this.prisma.tag.findUnique({ where: { id: a.tagId } });
        if (!tag) return skip('the tag was deleted');
        await this.prisma.threadTag.upsert({ where: { threadId_tagId: { threadId: thread.id, tagId: tag.id } }, create: { threadId: thread.id, tagId: tag.id, addedById: null }, update: {} });
        return ok(`Tagged “${tag.name}”`);
      }
      case 'create_task': {
        const assigneeId = a.assignTo === 'user' ? a.userId : thread.assigneeId;
        if (!assigneeId) return skip('the conversation has nobody assigned');
        const id = await this.prisma.$transaction(async (tx) => {
          const outbox = { live: [], push: [] };
          const tid = await this.tasks.createIn(tx, { title: a.title, assigneeId, dueAt: new Date(Date.now() + a.dueInHours * 3_600_000), threadId: thread.id, contactId: thread.contactId, createdById: null }, outbox);
          // System tasks notify too (createIn only notifies when a person gave the task).
          await this.notifications.createIn(tx, [{ userId: assigneeId, type: 'TASK_ASSIGNED', title: `New task: ${a.title}`, threadId: thread.id, url: `/tasks?task=${tid}` }], outbox);
          return { tid, outbox };
        });
        await this.notifications.flush(id.outbox);
        return ok(`Task “${a.title}” created`);
      }
      case 'create_lead': {
        const id = await this.leads.createFromRule(thread.id, { id: rule.id, name: rule.name, leadServiceInterest: a.serviceInterest ?? null });
        return id ? ok('Lead created') : skip('the contact already has an open lead, or there is no outside contact');
      }
      case 'request_ai_draft': {
        if (!thread.assigneeId) return skip('the conversation has nobody assigned');
        const blocked = await this.insights.blockedReason(thread.id);
        if (blocked) return skip(blocked);
        const ctx = await this.actAs(thread.assigneeId);
        if (!ctx || !ctx.permissions['ai.use']) return skip('the assignee cannot use the AI assistant');
        const suggestion = await this.suggestions.generate(thread.id, thread.assigneeId, a.tone, a.instructions);
        // A draft owned by the assignee, made with their permissions. Sending it is up to them.
        const draft = await this.drafts.create(ctx, { mode: 'REPLY', threadId: thread.id });
        await this.suggestions.fillDraft(draft.id, suggestion);
        await this.prisma.aiSuggestion.update({ where: { id: suggestion.id }, data: { status: 'USED_AS_DRAFT', draftId: draft.id } });
        await this.notifications.notify([{ userId: thread.assigneeId, type: 'AUTOMATION', title: `AI draft ready to review: ${thread.subject}`, body: 'Check and edit it before sending; it is not sent automatically.', threadId: thread.id }]);
        return ok('AI draft created for the assignee to review (not sent)');
      }
    }
  }

  /** Dry run: what the rule would do now for this conversation. Writes nothing. */
  async describe(rule: Pick<AutomationRule, 'trigger' | 'departmentId' | 'conditions' | 'actions'>, threadId: string) {
    const facts = (await this.threadFacts(threadId)) ?? {};
    const dept = await this.eventDepartment({ threadId });
    const flat: Record<string, string> = Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : k === 'body' ? `${v.slice(0, 120)}${v.length > 120 ? '…' : ''}` : v]));
    if (rule.trigger === 'USER_ABSENT') return { matched: false, reason: 'Absence rules run when an employee is marked absent, not for a conversation', facts: flat, actions: [] };
    if (rule.departmentId && rule.departmentId !== dept) return { matched: false, reason: 'The conversation is not in this rule’s department', facts: flat, actions: [] };
    if (!conditionsMatch(rule.conditions as unknown as Conditions, facts)) return { matched: false, reason: 'The conditions are not met', facts: flat, actions: [] };
    const names = async (ids: string[]) => (await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { name: true } })).map((u) => u.name).join(', ');
    const out: { type: string; detail: string }[] = [];
    for (const a of rule.actions as unknown as AutomationAction[]) {
      let detail: string;
      switch (a.type) {
        case 'assign':
          detail = a.targetType === 'USER' ? `Assign to ${await names([a.targetUserId!])}` : `Assign to the ${a.targetType === 'TEAM' ? 'team' : 'department'}${a.strategy === 'DIRECT' ? ' queue' : ` (${a.strategy === 'ROUND_ROBIN' ? 'round-robin' : 'least loaded'})`}`;
          break;
        case 'set_priority':
          detail = `Set priority to ${a.priority.toLowerCase()}`;
          break;
        case 'set_status':
          detail = `Set status to ${a.status}`;
          break;
        case 'add_tag':
          detail = `Add tag ${(await this.prisma.tag.findUnique({ where: { id: a.tagId } }))?.name ?? '(deleted)'}`;
          break;
        case 'notify':
          detail = `Notify ${a.to === 'users' ? await names(a.userIds) : a.to.replace('_', ' ')}: “${a.message}”`;
          break;
        case 'create_task':
          detail = `Task “${a.title}” due in ${a.dueInHours} h`;
          break;
        case 'create_lead':
          detail = 'Open a sales lead';
          break;
        case 'request_ai_draft':
          detail = 'Write an AI reply draft for the assignee to review (never sent automatically)';
          break;
        case 'reassign_absent':
          detail = 'Reassign the absent person’s open conversations';
          break;
      }
      out.push({ type: a.type, detail });
    }
    return { matched: true, reason: null, facts: flat, actions: out };
  }
}
