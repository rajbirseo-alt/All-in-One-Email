import { Injectable } from '@nestjs/common';
import { Prisma } from '@crm/db';
import { newId } from '@crm/crypto';
import type { AssignmentEntry, BulkResult, NoteView, TagView } from '@crm/shared';
import type { z } from 'zod';
import type { bulkSchema, tagSchema } from '@crm/shared';
import { AccessPolicy } from '../access/access-policy.service';
import { AuditService } from '../audit/audit.service';
import { ApiException, Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { EventsPublisher } from '../events/events.service';
import type { FlagAction } from '../mail/queue.service';
import { NotificationsService, type Outbox } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ThreadActionsService } from '../threads/thread-actions.service';
import { AssignmentService } from './assignment.service';

/** Mentions are written as @[userId] in note bodies. */
const MENTION = /@\[([A-Za-z0-9-]{1,64})\]/g;

/**
 * Internal notes, shares, tags, assignment history and bulk actions. Notes are internal by
 * construction: the email builder only reads draft fields, never notes.
 */
@Injectable()
export class CollabService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly audit: AuditService,
    private readonly assignment: AssignmentService,
    private readonly actions: ThreadActionsService,
    private readonly events: EventsPublisher,
    private readonly notifications: NotificationsService,
  ) {}

  private async visible(ctx: RequestContext, threadId: string, permission: 'conversation.read' | 'conversation.share' = 'conversation.read') {
    if (!ctx.permissions[permission]) throw Errors.forbidden();
    const t = await this.prisma.emailThread.findFirst({ where: { AND: [{ id: threadId }, await this.access.threadWhere(ctx, permission)] } });
    if (t) return t;
    const readable = await this.prisma.emailThread.count({ where: { AND: [{ id: threadId }, await this.access.threadWhere(ctx)] } });
    throw readable ? Errors.forbidden() : Errors.notFound('Conversation');
  }

  // ───────────── notes ─────────────

  async notes(ctx: RequestContext, threadId: string): Promise<NoteView[]> {
    await this.visible(ctx, threadId);
    const rows = await this.prisma.internalNote.findMany({
      where: { threadId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: { id: true, name: true } }, mentions: { include: { user: { select: { id: true, name: true } } } } },
    });
    return rows.map((n) => ({
      id: n.id,
      author: n.author,
      body: n.body,
      mentions: n.mentions.map((m) => m.user),
      createdAt: n.createdAt.toISOString(),
      editedAt: n.editedAt?.toISOString() ?? null,
      canEdit: n.authorId === ctx.userId,
    }));
  }

  /** Mentioned people get access to this conversation (docs/05 §4) and a notification. */
  private async mentionedUsers(body: string) {
    const ids = [...new Set([...body.matchAll(MENTION)].map((m) => m[1]!))];
    if (!ids.length) return [];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids }, status: 'ACTIVE' }, select: { id: true } });
    if (users.length !== ids.length) throw Errors.validation([{ path: 'body', message: 'A mentioned person does not exist or is not active' }]);
    return ids;
  }

  async addNote(ctx: RequestContext, threadId: string, body: string) {
    const t = await this.visible(ctx, threadId);
    const mentions = await this.mentionedUsers(body);
    const id = newId();
    const pending: { outbox: Outbox | null } = { outbox: null };
    await this.prisma.$transaction(async (tx) => {
      await tx.internalNote.create({ data: { id, threadId, authorId: ctx.userId, body } });
      await tx.noteMention.createMany({ data: mentions.map((userId) => ({ noteId: id, userId })) });
      const author = (await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name ?? 'A colleague';
      pending.outbox = await this.notifications.createIn(
        tx,
        mentions
          .filter((u) => u !== ctx.userId)
          .map((userId) => ({ userId, type: 'NOTE_MENTION' as const, title: `${author} mentioned you: ${t.subject}`, threadId, data: { noteId: id } })),
      );
      await this.audit.record(tx, ctx, { action: 'note.create', entityType: 'EmailThread', entityId: threadId, metadata: { noteId: id, mentions } });
    });
    if (pending.outbox) await this.notifications.flush(pending.outbox);
    await this.events.threadsChanged([threadId]);
    return (await this.notes(ctx, threadId)).find((n) => n.id === id)!;
  }

  async editNote(ctx: RequestContext, threadId: string, noteId: string, body: string | null) {
    await this.visible(ctx, threadId);
    const n = await this.prisma.internalNote.findFirst({ where: { id: noteId, threadId, deletedAt: null } });
    if (!n) throw Errors.notFound('Note');
    if (n.authorId !== ctx.userId) throw Errors.forbidden('Only the author can change a note');
    const mentions = body === null ? [] : await this.mentionedUsers(body);
    await this.prisma.$transaction(async (tx) => {
      if (body === null) {
        await tx.internalNote.update({ where: { id: noteId }, data: { deletedAt: new Date() } });
      } else {
        await tx.internalNote.update({ where: { id: noteId }, data: { body, editedAt: new Date() } });
        await tx.noteMention.deleteMany({ where: { noteId } });
        await tx.noteMention.createMany({ data: mentions.map((userId) => ({ noteId, userId })) });
      }
      // Bodies are not copied into the audit log.
      await this.audit.record(tx, ctx, { action: body === null ? 'note.delete' : 'note.update', entityType: 'EmailThread', entityId: threadId, metadata: { noteId } });
    });
    await this.events.threadsChanged([threadId]);
  }

  // ───────────── shares ─────────────

  async share(ctx: RequestContext, threadId: string, userId: string, canReply: boolean | null) {
    await this.visible(ctx, threadId, 'conversation.share');
    if (canReply !== null && !(await this.prisma.user.count({ where: { id: userId, status: 'ACTIVE' } }))) throw Errors.validation([{ path: 'userId', message: 'Unknown employee' }]);
    await this.prisma.$transaction(async (tx) => {
      if (canReply === null) await tx.threadShare.deleteMany({ where: { threadId, userId } });
      else {
        await tx.threadShare.upsert({ where: { threadId_userId: { threadId, userId } }, create: { threadId, userId, sharedById: ctx.userId, canReply }, update: { canReply } });
      }
      await this.audit.record(tx, ctx, { action: canReply === null ? 'thread.unshare' : 'thread.share', entityType: 'EmailThread', entityId: threadId, metadata: { userId, canReply } });
    });
    await this.events.threadsChanged([threadId]);
  }

  // ───────────── history ─────────────

  async history(ctx: RequestContext, threadId: string): Promise<AssignmentEntry[]> {
    await this.visible(ctx, threadId);
    const rows = await this.prisma.assignment.findMany({
      where: { threadId },
      orderBy: { createdAt: 'desc' },
      include: {
        assignee: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        assignedBy: { select: { id: true, name: true } },
        rule: { select: { id: true, name: true } },
      },
    });
    return rows.map((a) => ({
      id: a.id,
      assignee: a.assignee,
      team: a.team,
      department: a.department,
      assignedBy: a.assignedBy,
      method: a.method,
      rule: a.rule,
      reason: a.reason,
      createdAt: a.createdAt.toISOString(),
      endedAt: a.endedAt?.toISOString() ?? null,
    }));
  }

  // ───────────── tags ─────────────

  async tags(): Promise<TagView[]> {
    return this.prisma.tag.findMany({ select: { id: true, name: true, color: true }, orderBy: { name: 'asc' } });
  }

  async saveTag(ctx: RequestContext, id: string | null, input: z.infer<typeof tagSchema>) {
    const tid = id ?? newId();
    try {
      if (id) await this.prisma.tag.update({ where: { id }, data: input });
      else await this.prisma.tag.create({ data: { id: tid, ...input } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw Errors.validation([{ path: 'name', message: 'A tag with this name exists' }]);
      throw e;
    }
    await this.prisma.$transaction((tx) => this.audit.record(tx, ctx, { action: id ? 'tag.update' : 'tag.create', entityType: 'Tag', entityId: tid, after: input }));
    return (await this.tags()).find((t) => t.id === tid)!;
  }

  async deleteTag(ctx: RequestContext, id: string) {
    await this.prisma.tag.delete({ where: { id } });
    await this.prisma.$transaction((tx) => this.audit.record(tx, ctx, { action: 'tag.delete', entityType: 'Tag', entityId: id }));
  }

  async setTag(ctx: RequestContext, threadId: string, tagId: string, on: boolean) {
    await this.visible(ctx, threadId);
    if (on) {
      if (!(await this.prisma.tag.count({ where: { id: tagId } }))) throw Errors.notFound('Tag');
      await this.prisma.threadTag.upsert({ where: { threadId_tagId: { threadId, tagId } }, create: { threadId, tagId, addedById: ctx.userId }, update: {} });
    } else {
      await this.prisma.threadTag.deleteMany({ where: { threadId, tagId } });
    }
    await this.events.threadsChanged([threadId]);
  }

  // ───────────── bulk ─────────────

  /** Applies one action to up to 500 conversations; each is permission-checked on its own. */
  async bulk(ctx: RequestContext, input: z.infer<typeof bulkSchema>): Promise<BulkResult> {
    if (input.action === 'assign' && !input.assigneeId && !input.teamId && !input.departmentId) throw Errors.validation([{ path: 'assigneeId', message: 'Choose who to assign to' }]);
    if ((input.action === 'tag' || input.action === 'untag') && !input.tagId) throw Errors.validation([{ path: 'tagId', message: 'Choose a tag' }]);
    const failed: BulkResult['failed'] = [];
    let done = 0;
    for (const id of [...new Set(input.threadIds)]) {
      try {
        switch (input.action) {
          case 'assign':
            await this.assignment.assignByUser(ctx, id, { assigneeId: input.assigneeId, teamId: input.teamId, departmentId: input.departmentId }, 'BULK');
            break;
          case 'unassign':
            await this.assignment.unassignByUser(ctx, id, 'BULK');
            break;
          case 'tag':
          case 'untag':
            await this.setTag(ctx, id, input.tagId!, input.action === 'tag');
            break;
          default:
            await this.actions.apply(ctx, id, input.action as FlagAction);
        }
        done++;
      } catch (e) {
        const code = e instanceof ApiException ? ((e.getResponse() as { error?: { code?: string } }).error?.code ?? 'ERROR') : 'ERROR';
        // A bad target is the same for every conversation: report it once instead of 500 times.
        if (code === 'VALIDATION_FAILED' && done === 0 && !failed.length) throw e;
        failed.push({ id, code });
      }
    }
    return { done, failed };
  }
}
