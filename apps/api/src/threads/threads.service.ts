import { Injectable } from '@nestjs/common';
import { Prisma } from '@crm/db';
import type { MessageView, Participant, ThreadCounts, ThreadDetail, ThreadListItem, ThreadView } from '@crm/shared';
import type { z } from 'zod';
import type { threadListQuery } from '@crm/shared';
import { AccessPolicy } from '../access/access-policy.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { sanitizeEmailHtml, textToHtml } from './email-html';
import { EventsHub } from '../events/events.service';

const listInclude = {
  emailAccount: { select: { id: true, emailAddress: true, displayName: true, provider: true } },
  assignee: { select: { id: true, name: true } },
  team: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  tags: { select: { tag: { select: { id: true, name: true, color: true } } }, orderBy: { createdAt: 'asc' } },
  messages: {
    orderBy: { receivedAt: 'desc' },
    take: 1,
    where: { direction: 'INBOUND' },
    select: { fromAddress: true, fromName: true },
  },
} satisfies Prisma.EmailThreadInclude;
type ListRow = Prisma.EmailThreadGetPayload<{ include: typeof listInclude }>;

const COUNT_VIEWS: ThreadView[] = ['inbox', 'mine', 'unassigned', 'unread', 'pending', 'starred', 'snoozed', 'followup'];
const iso = (d: Date | null) => (d ? d.toISOString() : null);

function encodeCursor(t: { lastMessageAt: Date; id: string }) {
  return Buffer.from(`${t.lastMessageAt.toISOString()}|${t.id}`).toString('base64url');
}
function decodeCursor(c: string): { at: Date; id: string } | null {
  const [at, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  const d = at ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) && id ? { at: d, id } : null;
}

@Injectable()
export class ThreadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly hub: EventsHub,
  ) {}

  /** Conditions of each sidebar view. Spam and trash only appear in their own views. */
  viewWhere(ctx: RequestContext, view: ThreadView, now = new Date()): Prisma.EmailThreadWhereInput {
    const clean = { isSpam: false, isTrashed: false };
    const notSnoozed = { OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] };
    switch (view) {
      case 'inbox':
        return { ...clean, isArchived: false, status: { not: 'CLOSED' }, AND: [notSnoozed] };
      case 'mine':
        return { ...clean, assigneeId: ctx.userId, status: { not: 'CLOSED' } };
      case 'unassigned':
        return { ...clean, isArchived: false, assigneeId: null, teamId: null, status: { not: 'CLOSED' }, AND: [notSnoozed] };
      case 'unread':
        return { ...clean, unreadCount: { gt: 0 } };
      case 'pending':
        return { ...clean, awaitingReplySince: { not: null }, status: { notIn: ['REPLY_NOT_NEEDED', 'CLOSED'] } };
      case 'waiting':
        return { ...clean, status: 'WAITING_FOR_CLIENT' };
      case 'followup':
        return { ...clean, OR: [{ status: 'FOLLOW_UP_REQUIRED' }, { followUpAt: { lte: now } }] };
      case 'starred':
        return { ...clean, isStarred: true };
      case 'snoozed':
        return { ...clean, snoozedUntil: { gt: now } };
      case 'sent':
        return { ...clean, lastOutboundAt: { not: null } };
      case 'archive':
        return { ...clean, isArchived: true };
      case 'spam':
        return { isSpam: true, isTrashed: false };
      case 'trash':
        return { isTrashed: true };
      case 'closed':
        return { ...clean, status: 'CLOSED' };
      case 'all':
        return clean;
    }
  }

  /** Full-text search over message subject, sender and body (generated tsvector + GIN index). */
  private async searchThreadIds(q: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ threadId: string }[]>(Prisma.sql`
      SELECT DISTINCT "threadId" FROM email_messages
      WHERE "searchVector" @@ websearch_to_tsquery('simple', ${q})
      LIMIT 2000`);
    return rows.map((r) => r.threadId);
  }

  async list(ctx: RequestContext, q: z.infer<typeof threadListQuery>): Promise<{ items: ThreadListItem[]; nextCursor: string | null }> {
    const and: Prisma.EmailThreadWhereInput[] = [await this.access.threadWhere(ctx), this.viewWhere(ctx, q.view)];
    if (q.accountId?.length) and.push({ emailAccountId: { in: q.accountId } });
    if (q.status?.length) and.push({ status: { in: q.status } });
    if (q.assigneeId) and.push({ assigneeId: q.assigneeId });
    if (q.dateFrom) and.push({ lastMessageAt: { gte: q.dateFrom } });
    if (q.dateTo) and.push({ lastMessageAt: { lte: q.dateTo } });
    if (q.hasAttachments) and.push({ hasAttachments: q.hasAttachments === 'true' });
    if (q.tagId?.length) and.push({ tags: { some: { tagId: { in: q.tagId } } } });
    if (q.teamId) and.push({ teamId: q.teamId });
    if (q.q) {
      const ids = await this.searchThreadIds(q.q);
      and.push({
        OR: [
          { id: { in: ids } },
          { subject: { contains: q.q, mode: 'insensitive' } },
          { messages: { some: { fromAddress: { contains: q.q.toLowerCase() } } } },
        ],
      });
    }
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      if (!c) throw Errors.badRequest('Invalid cursor');
      and.push({ OR: [{ lastMessageAt: { lt: c.at } }, { lastMessageAt: c.at, id: { lt: c.id } }] });
    }
    const rows = await this.prisma.emailThread.findMany({
      where: { AND: and },
      include: listInclude,
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const fallbacks = await this.fallbackSenders(page.filter((r) => !r.messages.length).map((r) => r.id));
    return {
      items: page.map((r) => this.toItem(r, fallbacks.get(r.id) ?? null)),
      nextCursor: rows.length > q.limit ? encodeCursor(page.at(-1)!) : null,
    };
  }

  /** For threads without inbound mail (sent-only), show the latest sender. */
  private async fallbackSenders(threadIds: string[]) {
    const out = new Map<string, Participant>();
    for (const id of threadIds) {
      const m = await this.prisma.emailMessage.findFirst({ where: { threadId: id }, orderBy: { receivedAt: 'desc' }, select: { fromAddress: true, fromName: true } });
      if (m) out.set(id, { address: m.fromAddress, name: m.fromName });
    }
    return out;
  }

  private toItem(r: ListRow, fallback: Participant | null): ThreadListItem {
    const m = r.messages[0];
    return {
      id: r.id,
      subject: r.subject,
      snippet: r.snippet,
      status: r.status,
      priority: r.priority,
      account: r.emailAccount,
      assignee: r.assignee,
      team: r.team,
      department: r.department,
      tags: r.tags.map((t) => t.tag),
      from: m ? { address: m.fromAddress, name: m.fromName } : fallback,
      messageCount: r.messageCount,
      unreadCount: r.unreadCount,
      hasAttachments: r.hasAttachments,
      isStarred: r.isStarred,
      isArchived: r.isArchived,
      isSpam: r.isSpam,
      isTrashed: r.isTrashed,
      lastMessageAt: r.lastMessageAt.toISOString(),
      awaitingReplySince: iso(r.awaitingReplySince),
      snoozedUntil: iso(r.snoozedUntil),
      followUpAt: iso(r.followUpAt),
    };
  }

  async counts(ctx: RequestContext): Promise<ThreadCounts> {
    const visible = await this.access.threadWhere(ctx);
    const now = new Date();
    const entries = await Promise.all(
      COUNT_VIEWS.map(async (v) => {
        const extra: Prisma.EmailThreadWhereInput = v === 'inbox' || v === 'mine' || v === 'unassigned' ? { unreadCount: { gt: 0 } } : {};
        return [v, await this.prisma.emailThread.count({ where: { AND: [visible, this.viewWhere(ctx, v, now), extra] } })] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  /** A thread the caller may read, else 404 (existence never leaks). */
  async findVisible(ctx: RequestContext, id: string) {
    const t = await this.prisma.emailThread.findFirst({ where: { AND: [{ id }, await this.access.threadWhere(ctx)] }, include: listInclude });
    if (!t) throw Errors.notFound('Conversation');
    return t;
  }

  async detail(ctx: RequestContext, id: string, loadRemoteImages: boolean): Promise<ThreadDetail> {
    const t = await this.findVisible(ctx, id);
    const messages = await this.prisma.emailMessage.findMany({
      where: { threadId: id },
      orderBy: { receivedAt: 'asc' },
      include: { attachments: { orderBy: { filename: 'asc' } }, sentBy: { select: { id: true, name: true } } },
    });
    const views: MessageView[] = messages.map((m) => {
      const byCid = new Map(m.attachments.filter((a) => a.contentId).map((a) => [a.contentId!, a.id]));
      const cidUrl = (cid: string) => {
        const aid = byCid.get(cid);
        return aid ? `/api/v1/attachments/${aid}/download?inline=1` : null;
      };
      const body = m.bodyHtml
        ? sanitizeEmailHtml(m.bodyHtml, { cidUrl, loadRemoteImages })
        : { html: textToHtml(m.bodyText ?? m.snippet ?? ''), blockedImages: 0 };
      const people = (v: Prisma.JsonValue) => (Array.isArray(v) ? (v as unknown as Participant[]) : []);
      return {
        id: m.id,
        direction: m.direction,
        from: { address: m.fromAddress, name: m.fromName },
        to: people(m.toRecipients),
        cc: people(m.ccRecipients),
        bcc: m.direction === 'OUTBOUND' ? people(m.bccRecipients) : [],
        replyTo: people(m.replyTo),
        subject: m.subject,
        sentAt: iso(m.sentAt),
        receivedAt: m.receivedAt.toISOString(),
        isRead: m.isRead,
        isStarred: m.isStarred,
        html: body.html,
        blockedImages: body.blockedImages,
        // Inline images referenced from the body are not listed again as attachments.
        attachments: m.attachments
          .filter((a) => !(a.isInline && a.contentId && m.bodyHtml?.includes(`cid:${a.contentId}`)))
          .map((a) => ({ id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes, isInline: a.isInline })),
        sentBy: m.sentBy,
      };
    });
    return {
      ...this.toItem(t, null),
      version: t.version,
      messages: views,
      canReply: await this.access.canReply(ctx, t),
      canAssign: !!ctx.permissions['conversation.assign'] && (await this.prisma.emailThread.count({ where: { AND: [{ id }, await this.access.threadWhere(ctx, 'conversation.assign')] } })) > 0,
      canShare: !!ctx.permissions['conversation.share'] && (await this.prisma.emailThread.count({ where: { AND: [{ id }, await this.access.threadWhere(ctx, 'conversation.share')] } })) > 0,
      shares: (await this.prisma.threadShare.findMany({ where: { threadId: id }, include: { user: { select: { id: true, name: true } } } })).map((s) => ({ user: s.user, canReply: s.canReply })),
      presence: this.hub.presenceFor(id).filter((p) => p.userId !== ctx.userId),
    };
  }
}
