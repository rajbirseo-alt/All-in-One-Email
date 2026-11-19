import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type LeadSource, type LeadStatus } from '@crm/db';
import { newId } from '@crm/crypto';
import { OPEN_LEAD_STATUSES, type LeadDetail, type LeadListItem, type LeadSummary } from '@crm/shared';
import type { z } from 'zod';
import type { leadCreateSchema, leadListQuery, leadStatusSchema, leadSummaryQuery, leadUpdateSchema } from '@crm/shared';
import { AuditService, diff } from '../audit/audit.service';
import { Errors } from '../common/errors';
import type { AuditActor, RequestContext } from '../common/request-context';
import { NotificationsService, type Outbox } from '../notifications/notifications.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import type { MailChange } from '../status/status.service';
import { ContactLinkService } from './contact-link.service';
import { CrmAccess } from './crm-access';
import { TasksService, taskInclude } from './tasks.service';

/** A new lead's follow-up task is due this long after the lead is created or first gets an owner. */
export const LEAD_FOLLOW_UP_MS = 24 * 3_600_000;

const OPEN: LeadStatus[] = [...OPEN_LEAD_STATUSES];

const leadInclude = {
  contact: { select: { id: true, name: true, emails: { select: { email: true, isPrimary: true }, orderBy: [{ isPrimary: 'desc' }, { email: 'asc' }], take: 1 } } },
  company: { select: { id: true, name: true, domain: true } },
  owner: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  _count: { select: { tasks: { where: { status: 'OPEN' } } } },
} satisfies Prisma.LeadInclude;
type Row = Prisma.LeadGetPayload<{ include: typeof leadInclude }>;

export function leadItem(l: Row): LeadListItem {
  return {
    id: l.id,
    title: l.title,
    status: l.status,
    source: l.source,
    contact: { id: l.contact.id, name: l.contact.name, email: l.contact.emails[0]?.email ?? null },
    company: l.company,
    owner: l.owner,
    department: l.department,
    estimatedValue: l.estimatedValue?.toFixed(2) ?? null,
    currency: l.currency,
    serviceInterest: l.serviceInterest,
    sourceThreadId: l.sourceThreadId,
    openTasks: l._count.tasks,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

interface OpenLead {
  title: string;
  contactId: string;
  threadId: string | null;
  source: LeadSource;
  ownerId: string | null;
  departmentId: string | null;
  estimatedValue?: number | null;
  currency?: string;
  serviceInterest?: string | null;
  reason?: string;
}

/**
 * Sales leads: New → Contacted → Follow-up → Interested → Proposal sent → Negotiation → Won / Lost.
 * Opening a lead (by hand, or by an assignment rule with "create a lead") records its history,
 * marks the contact as a prospect, tells the owner and gives them a follow-up task.
 */
@Injectable()
export class LeadsService {
  private readonly log = new Logger(LeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crm: CrmAccess,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly tasks: TasksService,
    private readonly contacts: ContactLinkService,
  ) {}

  // ───────────── reading ─────────────

  async list(ctx: RequestContext, q: z.infer<typeof leadListQuery>): Promise<LeadListItem[]> {
    const and: Prisma.LeadWhereInput[] = [await this.crm.leadWhere(ctx)];
    if (q.status) and.push({ status: q.status });
    if (q.ownerId) and.push({ ownerId: q.ownerId === 'none' ? null : q.ownerId });
    if (q.q) {
      const s = { contains: q.q, mode: 'insensitive' as const };
      and.push({ OR: [{ title: s }, { contact: { name: s } }, { contact: { emails: { some: { email: s } } } }, { company: { name: s } }] });
    }
    const rows = await this.prisma.lead.findMany({ where: { AND: and }, include: leadInclude, orderBy: { updatedAt: 'desc' }, take: 1000 });
    return rows.map(leadItem);
  }

  async listFor(ctx: RequestContext, where: Prisma.LeadWhereInput) {
    const rows = await this.prisma.lead.findMany({ where: { AND: [where, await this.crm.leadWhere(ctx)] }, include: leadInclude, orderBy: { updatedAt: 'desc' }, take: 200 });
    return rows.map(leadItem);
  }

  /** Pipeline counts and conversion for the caller's leads created in the range. */
  async summary(ctx: RequestContext, q: z.infer<typeof leadSummaryQuery>): Promise<LeadSummary> {
    const where: Prisma.LeadWhereInput = { AND: [await this.crm.leadWhere(ctx), ...(q.from || q.to ? [{ createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } }] : [])] };
    const [byStatus, wonValue, byOwner] = await Promise.all([
      this.prisma.lead.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.lead.groupBy({ by: ['currency'], where: { AND: [where, { status: 'WON' }] }, _sum: { estimatedValue: true } }),
      this.prisma.lead.groupBy({ by: ['ownerId', 'status'], where, _count: { _all: true } }),
    ]);
    const count = (s: LeadStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
    const won = count('WON');
    const lost = count('LOST');
    const owners = await this.prisma.user.findMany({ where: { id: { in: byOwner.flatMap((b) => (b.ownerId ? [b.ownerId] : [])) } }, select: { id: true, name: true } });
    const perOwner = new Map<string | null, { open: number; won: number; lost: number }>();
    for (const b of byOwner) {
      const e = perOwner.get(b.ownerId) ?? { open: 0, won: 0, lost: 0 };
      if (b.status === 'WON') e.won += b._count._all;
      else if (b.status === 'LOST') e.lost += b._count._all;
      else e.open += b._count._all;
      perOwner.set(b.ownerId, e);
    }
    return {
      byStatus: (['NEW', 'CONTACTED', 'FOLLOW_UP', 'INTERESTED', 'PROPOSAL_SENT', 'NEGOTIATION', 'WON', 'LOST'] as LeadStatus[]).map((s) => ({ status: s, count: count(s) })),
      open: OPEN.reduce((n, s) => n + count(s), 0),
      won,
      lost,
      conversionRate: won + lost ? won / (won + lost) : null,
      wonValue: wonValue.filter((w) => w._sum.estimatedValue).map((w) => ({ currency: w.currency ?? 'USD', value: w._sum.estimatedValue!.toFixed(2) })),
      byOwner: [...perOwner].map(([id, v]) => ({ owner: id ? (owners.find((o) => o.id === id) ?? null) : null, ...v })).sort((a, b) => b.open + b.won - (a.open + a.won)),
    };
  }

  async get(ctx: RequestContext, id: string): Promise<LeadDetail> {
    const l = await this.prisma.lead.findFirst({ where: { AND: [{ id }, await this.crm.leadWhere(ctx)] }, include: { ...leadInclude, sourceThread: { select: { id: true, subject: true } } } });
    if (!l) throw Errors.notFound('Lead');
    const [history, tasks, canEdit, threadOk] = await Promise.all([
      this.prisma.leadStatusHistory.findMany({ where: { leadId: id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.task.findMany({ where: { AND: [{ leadId: id }, await this.crm.taskWhere(ctx)] }, include: taskInclude, orderBy: [{ status: 'asc' }, { dueAt: { sort: 'asc', nulls: 'last' } }] }),
      this.canEdit(ctx, id),
      l.sourceThreadId ? this.crm.threadReadable(ctx, l.sourceThreadId) : false,
    ]);
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: history.flatMap((h) => (h.changedById ? [h.changedById] : [])) } }, select: { id: true, name: true } })).map((u) => [u.id, u]));
    return {
      ...leadItem(l),
      lostReason: l.lostReason,
      wonAt: l.wonAt?.toISOString() ?? null,
      lostAt: l.lostAt?.toISOString() ?? null,
      sourceThread: threadOk ? l.sourceThread : null,
      history: history.map((h) => ({ id: h.id, from: h.fromStatus, to: h.toStatus, changedBy: h.changedById ? (names.get(h.changedById) ?? null) : null, note: h.note, createdAt: h.createdAt.toISOString() })),
      tasks: await this.tasks.views(ctx, tasks),
      canEdit,
    };
  }

  ownerOptions(ctx: RequestContext) {
    return this.crm.people(ctx, 'lead.write');
  }

  private async canEdit(ctx: RequestContext, id: string) {
    if (!ctx.permissions['lead.write']) return false;
    return (await this.prisma.lead.count({ where: { AND: [{ id }, await this.crm.leadWhere(ctx, 'lead.write')] } })) > 0;
  }

  private async editable(ctx: RequestContext, id: string) {
    if (ctx.permissions['lead.write']) {
      const l = await this.prisma.lead.findFirst({ where: { AND: [{ id }, await this.crm.leadWhere(ctx, 'lead.write')] } });
      if (l) return l;
    }
    const visible = await this.prisma.lead.count({ where: { AND: [{ id }, await this.crm.leadWhere(ctx)] } });
    throw visible ? Errors.forbidden('You cannot change this lead') : Errors.notFound('Lead');
  }

  private async assertOwner(ctx: RequestContext, ownerId: string | null) {
    const scope = ctx.permissions['lead.write'];
    if (ownerId === null) {
      // A lead without an owner would vanish from an OWN-scope user's view.
      if (scope === 'OWN' || scope === 'ASSIGNED') throw Errors.validation([{ path: 'ownerId', message: 'Choose who owns the lead' }]);
      return;
    }
    if (!(await this.crm.canHandTo(ctx, 'lead.write', ownerId))) throw Errors.validation([{ path: 'ownerId', message: 'You cannot give leads to this person' }]);
  }

  // ───────────── opening a lead ─────────────

  /** The one place leads are created. Runs in the caller's transaction; returns the new id. */
  private async open(tx: Tx, actor: RequestContext | AuditActor, input: OpenLead, outbox: Outbox) {
    const id = newId();
    const contact = await tx.contact.findUniqueOrThrow({ where: { id: input.contactId }, select: { companyId: true, type: true, ownerId: true } });
    await tx.lead.create({
      data: {
        id,
        title: input.title.slice(0, 300),
        contactId: input.contactId,
        companyId: contact.companyId,
        sourceThreadId: input.threadId,
        source: input.source,
        ownerId: input.ownerId,
        departmentId: input.departmentId,
        estimatedValue: input.estimatedValue ?? null,
        currency: input.currency ?? 'USD',
        serviceInterest: input.serviceInterest ?? null,
      },
    });
    await tx.leadStatusHistory.create({ data: { id: newId(), leadId: id, fromStatus: null, toStatus: 'NEW', changedById: actor.userId, note: input.reason ?? null } });
    // The person becomes a prospect, and the lead's owner looks after the contact unless someone already does.
    await tx.contact.update({
      where: { id: input.contactId },
      data: { ...(contact.type === 'OTHER' ? { type: 'PROSPECT' as const } : {}), ...(!contact.ownerId && input.ownerId ? { ownerId: input.ownerId } : {}) },
    });
    if (input.ownerId) await this.handOver(tx, actor, { id, title: input.title, threadId: input.threadId, contactId: input.contactId }, input.ownerId, outbox, true);
    await this.audit.record(tx, actor, {
      action: 'lead.create',
      entityType: 'Lead',
      entityId: id,
      after: { title: input.title, contactId: input.contactId, threadId: input.threadId, source: input.source, ownerId: input.ownerId, departmentId: input.departmentId },
      metadata: input.reason ? { reason: input.reason } : undefined,
    });
    return id;
  }

  /** A new owner: notification (unless they did it themselves) and, the first time, a follow-up task. */
  private async handOver(tx: Tx, actor: RequestContext | AuditActor, lead: { id: string; title: string; threadId: string | null; contactId: string }, ownerId: string, outbox: Outbox, firstOwner: boolean) {
    if (ownerId !== actor.userId) {
      await this.notifications.createIn(tx, [{ userId: ownerId, type: 'LEAD_ASSIGNED', title: `New lead: ${lead.title}`, threadId: lead.threadId, url: `/leads?lead=${lead.id}` }], outbox);
    }
    if (firstOwner && !(await tx.task.count({ where: { leadId: lead.id, status: 'OPEN' } }))) {
      await this.tasks.createIn(tx, { title: `Follow up: ${lead.title}`, assigneeId: ownerId, dueAt: new Date(Date.now() + LEAD_FOLLOW_UP_MS), threadId: lead.threadId, leadId: lead.id, contactId: lead.contactId, createdById: null }, outbox);
    }
  }

  async create(ctx: RequestContext, input: z.infer<typeof leadCreateSchema>) {
    let contactId = input.contactId ?? null;
    let thread: { id: string; subject: string; departmentId: string | null; contactId: string | null } | null = null;
    if (input.threadId) {
      if (!(await this.crm.threadReadable(ctx, input.threadId))) throw Errors.notFound('Conversation');
      thread = await this.prisma.emailThread.findUniqueOrThrow({ where: { id: input.threadId }, select: { id: true, subject: true, departmentId: true, contactId: true } });
      if (!thread.contactId) {
        await this.contacts.linkThreads([thread.id]);
        thread.contactId = (await this.prisma.emailThread.findUniqueOrThrow({ where: { id: thread.id }, select: { contactId: true } })).contactId;
      }
      if (!thread.contactId) throw Errors.validation([{ path: 'threadId', message: 'This conversation has no outside contact to make a lead for' }]);
      contactId = thread.contactId;
      const existing = await this.prisma.lead.findFirst({ where: { sourceThreadId: thread.id, status: { in: OPEN } }, select: { id: true } });
      if (existing) throw Errors.conflict('This conversation already has an open lead', 'LEAD_EXISTS');
    } else if (!(await this.prisma.contact.count({ where: { AND: [{ id: contactId! }, await this.crm.contactWhere(ctx)] } }))) {
      throw Errors.notFound('Contact');
    }
    const ownerId = input.ownerId === undefined ? ctx.userId : input.ownerId;
    await this.assertOwner(ctx, ownerId);
    const contact = await this.prisma.contact.findUniqueOrThrow({ where: { id: contactId! }, select: { name: true, emails: { where: { isPrimary: true }, select: { email: true } } } });
    const owner = ownerId ? await this.prisma.user.findUnique({ where: { id: ownerId }, select: { departmentId: true } }) : null;
    const outbox: Outbox = { live: [], push: [] };
    const id = await this.prisma.$transaction((tx) =>
      this.open(
        tx,
        ctx,
        {
          title: input.title ?? thread?.subject ?? `Enquiry from ${contact.name ?? contact.emails[0]?.email ?? 'contact'}`,
          contactId: contactId!,
          threadId: thread?.id ?? null,
          source: thread ? 'INBOUND_EMAIL' : 'MANUAL',
          ownerId,
          departmentId: thread?.departmentId ?? owner?.departmentId ?? null,
          estimatedValue: input.estimatedValue,
          currency: input.currency,
          serviceInterest: input.serviceInterest,
        },
        outbox,
      ),
    );
    await this.notifications.flush(outbox);
    return this.get(ctx, id);
  }

  /**
   * An assignment rule with "create a lead" matched a new conversation. The owner is whoever the
   * rule assigned (none for a queue). Skipped when the contact already has an open lead.
   */
  async createFromRule(threadId: string, rule: { id: string; name: string; leadServiceInterest: string | null }) {
    const t = await this.prisma.emailThread.findUnique({ where: { id: threadId }, select: { id: true, subject: true, assigneeId: true, departmentId: true, contactId: true } });
    if (!t) return null;
    if (!t.contactId) await this.contacts.linkThreads([threadId]);
    const contactId = t.contactId ?? (await this.prisma.emailThread.findUnique({ where: { id: threadId }, select: { contactId: true } }))?.contactId;
    if (!contactId) return null;
    if (await this.prisma.lead.count({ where: { OR: [{ sourceThreadId: threadId }, { contactId, status: { in: OPEN } }] } })) return null;
    const outbox: Outbox = { live: [], push: [] };
    const id = await this.prisma.$transaction((tx) =>
      this.open(
        tx,
        { userId: null, actorType: 'SYSTEM' },
        { title: t.subject, contactId, threadId, source: 'INBOUND_EMAIL', ownerId: t.assigneeId, departmentId: t.departmentId, serviceInterest: rule.leadServiceInterest, reason: `Rule: ${rule.name}` },
        outbox,
      ),
    );
    await this.notifications.flush(outbox);
    return id;
  }

  // ───────────── changing a lead ─────────────

  async update(ctx: RequestContext, id: string, input: z.infer<typeof leadUpdateSchema>) {
    const before = await this.editable(ctx, id);
    if (input.ownerId !== undefined && input.ownerId !== before.ownerId) await this.assertOwner(ctx, input.ownerId);
    const data: Prisma.LeadUncheckedUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.ownerId !== undefined) data.ownerId = input.ownerId;
    if (input.estimatedValue !== undefined) data.estimatedValue = input.estimatedValue;
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.serviceInterest !== undefined) data.serviceInterest = input.serviceInterest;
    const outbox: Outbox = { live: [], push: [] };
    await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id }, data });
      const comparable = { ...before, estimatedValue: before.estimatedValue?.toNumber() ?? null } as unknown as Record<string, unknown>;
      const d = diff(comparable, data as Record<string, unknown>);
      if (d.changed) await this.audit.record(tx, ctx, { action: 'lead.update', entityType: 'Lead', entityId: id, before: d.before, after: d.after });
      if (input.ownerId && input.ownerId !== before.ownerId) {
        await this.handOver(tx, ctx, { id, title: input.title ?? before.title, threadId: before.sourceThreadId, contactId: before.contactId }, input.ownerId, outbox, !before.ownerId);
      }
    });
    await this.notifications.flush(outbox);
    return this.get(ctx, id);
  }

  async setStatus(ctx: RequestContext, id: string, input: z.infer<typeof leadStatusSchema>) {
    const before = await this.editable(ctx, id);
    if (before.status === input.status) return this.get(ctx, id);
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.lead.update({
        where: { id },
        data: {
          status: input.status,
          wonAt: input.status === 'WON' ? now : null,
          lostAt: input.status === 'LOST' ? now : null,
          lostReason: input.status === 'LOST' ? input.lostReason! : null,
        },
      });
      await tx.leadStatusHistory.create({ data: { id: newId(), leadId: id, fromStatus: before.status, toStatus: input.status, changedById: ctx.userId, note: input.status === 'LOST' ? input.lostReason! : (input.note ?? null) } });
      // A won lead makes the person a client.
      if (input.status === 'WON') await tx.contact.updateMany({ where: { id: before.contactId, type: { in: ['OTHER', 'PROSPECT'] } }, data: { type: 'CLIENT' } });
      await this.audit.record(tx, ctx, { action: 'lead.status', entityType: 'Lead', entityId: id, before: { status: before.status }, after: { status: input.status, lostReason: input.lostReason ?? null }, metadata: input.note ? { note: input.note } : undefined });
    });
    return this.get(ctx, id);
  }

  /** Our first reply on a lead's conversation moves a New lead to Contacted. */
  async afterMail(changes: MailChange[]) {
    const ids = changes.filter((c) => c.newOutbound && c.live).map((c) => c.threadId);
    if (!ids.length) return;
    const leads = await this.prisma.lead.findMany({ where: { sourceThreadId: { in: ids }, status: 'NEW' }, select: { id: true } });
    for (const l of leads) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const moved = await tx.lead.updateMany({ where: { id: l.id, status: 'NEW' }, data: { status: 'CONTACTED' } });
          if (!moved.count) return;
          await tx.leadStatusHistory.create({ data: { id: newId(), leadId: l.id, fromStatus: 'NEW', toStatus: 'CONTACTED', changedById: null, note: 'Reply sent' } });
        });
      } catch (e) {
        this.log.error(`Lead ${l.id} update after mail failed: ${(e as Error).message}`);
      }
    }
  }

}
