import { Injectable } from '@nestjs/common';
import type { Prisma, TaskStatus } from '@crm/db';
import { newId } from '@crm/crypto';
import type { TaskView } from '@crm/shared';
import type { z } from 'zod';
import type { taskCreateSchema, taskListQuery, taskUpdateSchema } from '@crm/shared';
import { AuditService, diff } from '../audit/audit.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { NotificationsService, type Outbox } from '../notifications/notifications.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { CrmAccess } from './crm-access';

export const taskInclude = {
  assignee: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  thread: { select: { id: true, subject: true } },
  lead: { select: { id: true, title: true } },
  contact: { select: { id: true, name: true } },
} satisfies Prisma.TaskInclude;
type Row = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

export interface SystemTask {
  title: string;
  assigneeId: string;
  dueAt: Date | null;
  threadId?: string | null;
  leadId?: string | null;
  contactId?: string | null;
  createdById?: string | null;
}

const taskUrl = (id: string) => `/tasks?task=${id}`;

/** Tasks: follow-ups and to-dos, optionally linked to a conversation, a lead and/or a contact. */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crm: CrmAccess,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async views(ctx: RequestContext, rows: Row[]): Promise<TaskView[]> {
    if (!rows.length) return [];
    const readable = await this.crm.readableIds(ctx, {
      threads: rows.flatMap((r) => (r.threadId ? [r.threadId] : [])),
      leads: rows.flatMap((r) => (r.leadId ? [r.leadId] : [])),
      contacts: rows.flatMap((r) => (r.contactId ? [r.contactId] : [])),
    });
    const writable = new Set(
      ctx.permissions['task.write']
        ? (await this.prisma.task.findMany({ where: { AND: [{ id: { in: rows.map((r) => r.id) } }, await this.crm.taskWhere(ctx, 'task.write')] }, select: { id: true } })).map((t) => t.id)
        : [],
    );
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      dueAt: t.dueAt?.toISOString() ?? null,
      status: t.status,
      assignee: t.assignee,
      createdBy: t.createdBy,
      thread: t.thread && readable.threads.has(t.thread.id) ? t.thread : null,
      lead: t.lead && readable.leads.has(t.lead.id) ? t.lead : null,
      contact: t.contact && readable.contacts.has(t.contact.id) ? t.contact : null,
      completedAt: t.completedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      canEdit: writable.has(t.id),
    }));
  }

  async list(ctx: RequestContext, q: z.infer<typeof taskListQuery>) {
    const and: Prisma.TaskWhereInput[] = [await this.crm.taskWhere(ctx)];
    if (q.view === 'mine') and.push({ assigneeId: ctx.userId });
    if (q.view === 'created') and.push({ createdById: ctx.userId });
    if (q.status) and.push({ status: q.status });
    if (q.threadId) and.push({ threadId: q.threadId });
    if (q.leadId) and.push({ leadId: q.leadId });
    if (q.contactId) and.push({ contactId: q.contactId });
    const rows = await this.prisma.task.findMany({
      where: { AND: and },
      include: taskInclude,
      orderBy: [{ status: 'asc' }, { dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 500,
    });
    return this.views(ctx, rows);
  }

  async get(ctx: RequestContext, id: string) {
    const t = await this.prisma.task.findFirst({ where: { AND: [{ id }, await this.crm.taskWhere(ctx)] }, include: taskInclude });
    if (!t) throw Errors.notFound('Task');
    return (await this.views(ctx, [t]))[0]!;
  }

  assigneeOptions(ctx: RequestContext) {
    return this.crm.people(ctx, 'task.write');
  }

  /** Writes a task inside the caller's transaction (lead follow-ups); notifies the assignee if someone else created it. */
  async createIn(tx: Tx, t: SystemTask, outbox?: Outbox) {
    const id = newId();
    await tx.task.create({
      data: { id, title: t.title.slice(0, 300), assigneeId: t.assigneeId, createdById: t.createdById ?? null, dueAt: t.dueAt, threadId: t.threadId ?? null, leadId: t.leadId ?? null, contactId: t.contactId ?? null },
    });
    if (t.createdById && t.createdById !== t.assigneeId) {
      await this.notifications.createIn(tx, [{ userId: t.assigneeId, type: 'TASK_ASSIGNED', title: `New task: ${t.title}`, threadId: t.threadId ?? null, url: taskUrl(id) }], outbox);
    }
    return id;
  }

  async create(ctx: RequestContext, input: z.infer<typeof taskCreateSchema>) {
    const assigneeId = input.assigneeId ?? ctx.userId;
    if (!(await this.crm.canHandTo(ctx, 'task.write', assigneeId))) throw Errors.validation([{ path: 'assigneeId', message: 'You cannot give tasks to this person' }]);
    let contactId = input.contactId ?? null;
    if (input.threadId) {
      if (!(await this.crm.threadReadable(ctx, input.threadId))) throw Errors.notFound('Conversation');
      contactId ??= (await this.prisma.emailThread.findUnique({ where: { id: input.threadId }, select: { contactId: true } }))?.contactId ?? null;
    }
    if (input.leadId) {
      const lead = await this.prisma.lead.findFirst({ where: { AND: [{ id: input.leadId }, await this.crm.leadWhere(ctx)] }, select: { contactId: true } });
      if (!lead) throw Errors.notFound('Lead');
      contactId ??= lead.contactId;
    }
    if (input.contactId && !(await this.prisma.contact.count({ where: { AND: [{ id: input.contactId }, await this.crm.contactWhere(ctx)] } }))) throw Errors.notFound('Contact');
    const outbox: Outbox = { live: [], push: [] };
    const id = await this.prisma.$transaction(async (tx) => {
      const tid = await this.createIn(tx, { title: input.title, assigneeId, dueAt: input.dueAt ?? null, threadId: input.threadId, leadId: input.leadId, contactId, createdById: ctx.userId }, outbox);
      if (input.description) await tx.task.update({ where: { id: tid }, data: { description: input.description } });
      await this.audit.record(tx, ctx, { action: 'task.create', entityType: 'Task', entityId: tid, after: { title: input.title, assigneeId, dueAt: input.dueAt ?? null, threadId: input.threadId ?? null, leadId: input.leadId ?? null, contactId } });
      return tid;
    });
    await this.notifications.flush(outbox);
    return this.get(ctx, id);
  }

  /** The task if the caller may change it (404 if invisible, 403 if visible but read-only). */
  private async editable(ctx: RequestContext, id: string) {
    if (ctx.permissions['task.write']) {
      const t = await this.prisma.task.findFirst({ where: { AND: [{ id }, await this.crm.taskWhere(ctx, 'task.write')] } });
      if (t) return t;
    }
    const visible = await this.prisma.task.count({ where: { AND: [{ id }, await this.crm.taskWhere(ctx)] } });
    throw visible ? Errors.forbidden('You cannot change this task') : Errors.notFound('Task');
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof taskUpdateSchema>) {
    const before = await this.editable(ctx, id);
    if (input.assigneeId && input.assigneeId !== before.assigneeId && !(await this.crm.canHandTo(ctx, 'task.write', input.assigneeId))) {
      throw Errors.validation([{ path: 'assigneeId', message: 'You cannot give tasks to this person' }]);
    }
    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId;
    if (input.dueAt !== undefined) {
      data.dueAt = input.dueAt;
      // A new due time gets its own reminder.
      if ((input.dueAt?.getTime() ?? null) !== (before.dueAt?.getTime() ?? null)) data.dueNotifiedAt = null;
    }
    const outbox: Outbox = { live: [], push: [] };
    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id }, data });
      const d = diff(before as unknown as Record<string, unknown>, data as Record<string, unknown>);
      if (d.changed) await this.audit.record(tx, ctx, { action: 'task.update', entityType: 'Task', entityId: id, before: d.before, after: d.after });
      if (input.assigneeId && input.assigneeId !== before.assigneeId && input.assigneeId !== ctx.userId) {
        await this.notifications.createIn(tx, [{ userId: input.assigneeId, type: 'TASK_ASSIGNED', title: `New task: ${input.title ?? before.title}`, threadId: before.threadId, url: taskUrl(id) }], outbox);
      }
    });
    await this.notifications.flush(outbox);
    return this.get(ctx, id);
  }

  async setStatus(ctx: RequestContext, id: string, status: TaskStatus) {
    const before = await this.editable(ctx, id);
    if (before.status === status) return this.get(ctx, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id }, data: { status, completedAt: status === 'DONE' ? new Date() : null } });
      await this.audit.record(tx, ctx, { action: status === 'DONE' ? 'task.complete' : status === 'OPEN' ? 'task.reopen' : 'task.cancel', entityType: 'Task', entityId: id, before: { status: before.status }, after: { status } });
    });
    return this.get(ctx, id);
  }

  /** Worker sweep: one TASK_DUE notification per due time. Returns how many were sent. */
  async dueSweep(now = new Date(), limit = 200) {
    const due = await this.prisma.task.findMany({
      where: { status: 'OPEN', dueAt: { lte: now }, dueNotifiedAt: null },
      select: { id: true, title: true, assigneeId: true, threadId: true },
      orderBy: { dueAt: 'asc' },
      take: limit,
    });
    let sent = 0;
    for (const t of due) {
      const outbox = await this.prisma.$transaction(async (tx) => {
        // Claim it first, so two workers never both remind.
        const claimed = await tx.task.updateMany({ where: { id: t.id, status: 'OPEN', dueNotifiedAt: null }, data: { dueNotifiedAt: now } });
        if (!claimed.count) return null;
        return this.notifications.createIn(tx, [{ userId: t.assigneeId, type: 'TASK_DUE', title: `Task due: ${t.title}`, threadId: t.threadId, url: taskUrl(t.id) }]);
      });
      if (outbox) {
        sent++;
        await this.notifications.flush(outbox);
      }
    }
    return sent;
  }
}
