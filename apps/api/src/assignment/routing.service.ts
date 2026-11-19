import { Injectable, Logger } from '@nestjs/common';
import type { AssignmentRule } from '@crm/db';
import type { Participant } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AssignmentService } from './assignment.service';
import { LeadsService } from '../crm/leads.service';

export interface RuleFacts {
  mailbox: string;
  from: string;
  fromDomain: string;
  to: string[];
  subject: string;
  body: string;
}

interface Condition {
  field: 'mailbox' | 'from' | 'fromDomain' | 'to' | 'subject' | 'body';
  op: 'is' | 'contains' | 'startsWith' | 'endsWith' | 'notContains';
  value: string;
}
export interface RuleConditions {
  match: 'all' | 'any';
  conditions: Condition[];
}

/** Mail received more than this before the mailbox was connected is history, not new work: never routed. */
const HISTORY_GRACE_MS = 5 * 60_000;

function test(op: Condition['op'], actual: string, expected: string) {
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

/** Case-insensitive rule matching. For recipients, `notContains` means no recipient contains it. */
export function matches(c: RuleConditions, f: RuleFacts): boolean {
  const one = (x: Condition) => {
    if (x.field === 'to') return x.op === 'notContains' ? f.to.every((t) => test('notContains', t, x.value)) : f.to.some((t) => test(x.op, t, x.value));
    return test(x.op, f[x.field], x.value);
  };
  return c.match === 'any' ? c.conditions.some(one) : c.conditions.every(one);
}

export function htmlText(html: string) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Routes NEW incoming conversations through the ordered assignment rules (first match wins).
 * Never touches history imported at connect time, conversations that were ever assigned, or
 * conversations without an inbound message.
 */
@Injectable()
export class RoutingService {
  private readonly log = new Logger(RoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly assignment: AssignmentService,
    private readonly leads: LeadsService,
  ) {}

  /** Facts from the first inbound message of a thread. */
  async factsFor(threadId: string): Promise<RuleFacts | null> {
    const m = await this.prisma.emailMessage.findFirst({
      where: { threadId, direction: 'INBOUND' },
      orderBy: { receivedAt: 'asc' },
      select: { emailAccountId: true, fromAddress: true, toRecipients: true, ccRecipients: true, subject: true, bodyText: true, bodyHtml: true, receivedAt: true },
    });
    if (!m) return null;
    const people = (v: unknown) => (Array.isArray(v) ? (v as Participant[]).map((p) => p.address.toLowerCase()) : []);
    return {
      mailbox: m.emailAccountId,
      from: m.fromAddress.toLowerCase(),
      fromDomain: m.fromAddress.split('@')[1]?.toLowerCase() ?? '',
      to: [...people(m.toRecipients), ...people(m.ccRecipients)],
      subject: m.subject,
      body: (m.bodyText ?? htmlText(m.bodyHtml ?? '')).slice(0, 20_000),
    };
  }

  async enabledRules() {
    return this.prisma.assignmentRule.findMany({ where: { isEnabled: true }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  }

  firstMatch(rules: AssignmentRule[], facts: RuleFacts) {
    return rules.find((r) => matches(r.conditions as unknown as RuleConditions, facts)) ?? null;
  }

  /** Called after each sync with the threads it touched. Errors are logged, never fail the sync. */
  async routeNew(threadIds: Iterable<string>) {
    const ids = [...threadIds];
    if (!ids.length) return 0;
    const fresh = await this.prisma.emailThread.findMany({
      where: { id: { in: ids }, status: 'NEW', assigneeId: null, teamId: null, assignments: { none: {} } },
      select: { id: true, emailAccount: { select: { createdAt: true } } },
    });
    if (!fresh.length) return 0;
    const rules = await this.enabledRules();
    if (!rules.length) return 0;
    let routed = 0;
    for (const t of fresh) {
      try {
        const first = await this.prisma.emailMessage.findFirst({ where: { threadId: t.id, direction: 'INBOUND' }, orderBy: { receivedAt: 'asc' }, select: { receivedAt: true } });
        if (!first || first.receivedAt.getTime() < t.emailAccount.createdAt.getTime() - HISTORY_GRACE_MS) continue;
        const facts = await this.factsFor(t.id);
        const rule = facts && this.firstMatch(rules, facts);
        if (!rule) continue;
        const meta = { method: 'RULE' as const, actor: null, ruleId: rule.id, reason: `Rule: ${rule.name}`, setPriority: rule.setPriority };
        if (rule.targetType === 'USER') await this.assignment.apply(t.id, { assigneeId: rule.targetUserId }, meta);
        else await this.assignment.assignToPool(t.id, { teamId: rule.teamId, departmentId: rule.teamId ? null : rule.departmentId }, rule.strategy, meta);
        routed++;
        // Lead routing: the rule also opens a sales lead, owned by whoever it just assigned.
        if (rule.createLead) await this.leads.createFromRule(t.id, rule).catch((e: Error) => this.log.error(`Lead for ${t.id} failed: ${e.message}`));
      } catch (e) {
        this.log.error(`Routing ${t.id} failed: ${(e as Error).message}`);
      }
    }
    return routed;
  }
}
