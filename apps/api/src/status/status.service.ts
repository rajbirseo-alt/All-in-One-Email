import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type ChangeSource, type ConversationStatus, type Priority } from '@crm/db';
import { newId } from '@crm/crypto';
import type { MANUAL_STATUSES, StatusHistoryEntry } from '@crm/shared';
import { AccessPolicy } from '../access/access-policy.service';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { EventsPublisher } from '../events/events.service';
import { NotificationsService, type NotifyInput, type Outbox } from '../notifications/notifications.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { SlaService } from '../sla/sla.service';

/** What a sync / send changed in a conversation (from IngestService.refreshThreads). */
export interface MailChange {
  threadId: string;
  /** The conversation had no messages before (new thread). */
  created: boolean;
  newInbound: boolean;
  newOutbound: boolean;
  /** The new messages are live mail, not history imported when the mailbox was connected. */
  live: boolean;
}

type ManualStatus = (typeof MANUAL_STATUSES)[number];

/** Closed-like statuses a client's new message reopens. */
const REOPEN_ON_INBOUND = new Set<ConversationStatus>(['WAITING_FOR_CLIENT', 'FOLLOW_UP_REQUIRED', 'REPLY_NOT_NEEDED', 'CLOSED']);
/** Open statuses that a reply from us turns into "Waiting for client". */
const WAIT_AFTER_REPLY = new Set<ConversationStatus>(['NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_REPLY', 'FOLLOW_UP_REQUIRED']);
const CLOSED_LIKE = new Set<ConversationStatus>(['CLOSED', 'REPLY_NOT_NEEDED']);

/**
 * The conversation status state machine. NEW and ASSIGNED follow the assignment; employees choose
 * the working statuses; new mail re-assesses the status (a client's reply reopens, our reply waits
 * for the client); a follow-up date turns into "Follow-up required" when it comes.
 */
@Injectable()
export class StatusService {
  private readonly log = new Logger(StatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly audit: AuditService,
    private readonly events: EventsPublisher,
    private readonly notifications: NotificationsService,
    private readonly sla: SlaService,
  ) {}

  private async changeable(ctx: RequestContext, id: string) {
    if (!ctx.permissions['conversation.status']) throw Errors.forbidden();
    const t = await this.prisma.emailThread.findFirst({ where: { AND: [{ id }, await this.access.threadWhere(ctx, 'conversation.status')] } });
    if (t) return t;
    const readable = await this.prisma.emailThread.count({ where: { AND: [{ id }, await this.access.threadWhere(ctx)] } });
    throw readable ? Errors.forbidden('You cannot change the status of this conversation') : Errors.notFound('Conversation');
  }

  async canChange(ctx: RequestContext, id: string) {
    if (!ctx.permissions['conversation.status']) return false;
    return (await this.prisma.emailThread.count({ where: { AND: [{ id }, await this.access.threadWhere(ctx, 'conversation.status')] } })) > 0;
  }

  /** Writes a status change with history (inside the caller's transaction). */
  private async write(tx: Tx, t: { id: string; status: ConversationStatus }, to: ConversationStatus, source: ChangeSource, by: string | null, reason: string | null, extra: Prisma.EmailThreadUpdateInput = {}) {
    await tx.emailThread.update({
      where: { id: t.id },
      data: { status: to, ...(to === 'CLOSED' ? { closedAt: new Date() } : CLOSED_LIKE.has(t.status) ? { closedAt: null } : {}), ...extra },
    });
    if (to !== t.status) await tx.statusHistory.create({ data: { id: newId(), threadId: t.id, fromStatus: t.status, toStatus: to, changedById: by, source, reason } });
  }

  async change(ctx: RequestContext, id: string, input: { status: ManualStatus; reason?: string; followUpAt?: Date | null }) {
    await this.changeable(ctx, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM email_threads WHERE id = ${id} FOR UPDATE`);
      const t = await tx.emailThread.findUniqueOrThrow({ where: { id } });
      const to: ConversationStatus = input.status === 'OPEN' ? (t.assigneeId ? 'ASSIGNED' : 'NEW') : input.status;
      if (input.status === 'OPEN' && !CLOSED_LIKE.has(t.status) && t.status !== 'WAITING_FOR_CLIENT' && t.status !== 'FOLLOW_UP_REQUIRED') {
        throw Errors.conflict('This conversation is already open', 'ALREADY_OPEN');
      }
      const followUpAt = CLOSED_LIKE.has(to) ? null : input.followUpAt === undefined ? (to === 'FOLLOW_UP_REQUIRED' ? null : t.followUpAt) : input.followUpAt;
      if (to === t.status && (followUpAt?.getTime() ?? null) === (t.followUpAt?.getTime() ?? null)) return;
      await this.write(tx, t, to, 'USER', ctx.userId, input.reason ?? null, { followUpAt });
      await this.audit.record(tx, ctx, {
        action: 'thread.status',
        entityType: 'EmailThread',
        entityId: id,
        before: { status: t.status, followUpAt: t.followUpAt?.toISOString() ?? null },
        after: { status: to, followUpAt: followUpAt?.toISOString() ?? null },
        metadata: { reason: input.reason ?? null },
      });
    });
    await this.sla.evaluate([id]);
    await this.events.threadsChanged([id]);
  }

  async setPriority(ctx: RequestContext, id: string, priority: Priority) {
    const t = await this.changeable(ctx, id);
    if (t.priority === priority) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.emailThread.update({ where: { id }, data: { priority } });
      await this.audit.record(tx, ctx, { action: 'thread.priority', entityType: 'EmailThread', entityId: id, before: { priority: t.priority }, after: { priority } });
    });
    await this.sla.evaluate([id]);
    await this.events.threadsChanged([id]);
  }

  async history(ctx: RequestContext, id: string): Promise<StatusHistoryEntry[]> {
    const visible = await this.prisma.emailThread.count({ where: { AND: [{ id }, await this.access.threadWhere(ctx)] } });
    if (!visible) throw Errors.notFound('Conversation');
    const rows = await this.prisma.statusHistory.findMany({ where: { threadId: id }, orderBy: { createdAt: 'desc' }, take: 100, include: { changedBy: { select: { id: true, name: true } } } });
    return rows.map((r) => ({ id: r.id, from: r.fromStatus, to: r.toStatus, source: r.source, changedBy: r.changedBy, reason: r.reason, createdAt: r.createdAt.toISOString() }));
  }

  // ───────────── re-assessment on new mail ─────────────

  /**
   * Called after a sync or a send stored new messages. A client's new message reopens a
   * waiting/closed conversation and tells the assignee; our reply moves an open conversation to
   * "Waiting for client". Imported history is never re-assessed.
   */
  async afterMail(changes: MailChange[]) {
    let outbox: Outbox | null = null;
    const touched: string[] = [];
    for (const c of changes) {
      if (!c.live || (!c.newInbound && !c.newOutbound)) continue;
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM email_threads WHERE id = ${c.threadId} FOR UPDATE`);
        const t = await tx.emailThread.findUnique({ where: { id: c.threadId } });
        if (!t || t.isSpam || t.isTrashed) return null;
        const notes: NotifyInput[] = [];
        let changed = false;
        if (t.awaitingReplySince && c.newInbound) {
          // The client wrote last.
          if (REOPEN_ON_INBOUND.has(t.status)) {
            await this.write(tx, t, t.assigneeId ? 'PENDING_REPLY' : 'NEW', 'INBOUND_MESSAGE', null, 'client replied', { followUpAt: null });
            changed = true;
          } else if (t.followUpAt) {
            await tx.emailThread.update({ where: { id: t.id }, data: { followUpAt: null } });
            changed = true;
          }
          if (t.assigneeId && !c.created) notes.push({ userId: t.assigneeId, type: 'CLIENT_REPLIED', title: `New reply: ${t.subject}`, body: t.snippet?.slice(0, 140) ?? null, threadId: t.id });
        } else if (!t.awaitingReplySince && c.newOutbound && WAIT_AFTER_REPLY.has(t.status) && t.lastOutboundAt) {
          await this.write(tx, t, 'WAITING_FOR_CLIENT', 'OUTBOUND_MESSAGE', null, 'reply sent');
          changed = true;
        }
        const ob = await this.notifications.createIn(tx, notes, outbox ?? undefined);
        return { changed, ob };
      });
      if (!result) continue;
      outbox = result.ob;
      if (result.changed) touched.push(c.threadId);
    }
    if (outbox) await this.notifications.flush(outbox);
    if (touched.length) await this.events.threadsChanged(touched).catch(() => undefined);
  }

  // ───────────── follow-up dates ─────────────

  /** Conversations whose follow-up date has come become "Follow-up required" and the assignee is told. */
  async followUpSweep(now = new Date(), limit = 200): Promise<number> {
    const due = await this.prisma.emailThread.findMany({ where: { followUpAt: { lte: now } }, select: { id: true }, take: limit, orderBy: { followUpAt: 'asc' } });
    const touched: string[] = [];
    for (const { id } of due) {
      const outbox = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM email_threads WHERE id = ${id} FOR UPDATE`);
        const t = await tx.emailThread.findUnique({ where: { id }, include: { team: { select: { leaderId: true } } } });
        if (!t?.followUpAt || t.followUpAt > now) return null;
        if (CLOSED_LIKE.has(t.status)) {
          await tx.emailThread.update({ where: { id }, data: { followUpAt: null } });
          return null;
        }
        await this.write(tx, t, 'FOLLOW_UP_REQUIRED', 'SYSTEM', null, 'follow-up date reached', { followUpAt: null });
        const to = t.assigneeId ?? t.team?.leaderId ?? null;
        return this.notifications.createIn(tx, to ? [{ userId: to, type: 'FOLLOW_UP_DUE', title: `Follow up: ${t.subject}`, body: null, threadId: id }] : []);
      });
      if (outbox) {
        touched.push(id);
        await this.notifications.flush(outbox);
      }
    }
    if (touched.length) {
      await this.sla.evaluate(touched);
      await this.events.threadsChanged(touched).catch(() => undefined);
    }
    return touched.length;
  }
}
