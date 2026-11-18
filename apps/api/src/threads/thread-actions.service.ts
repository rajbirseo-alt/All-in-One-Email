import { Injectable } from '@nestjs/common';
import type { FolderType } from '@crm/db';
import { AccessPolicy } from '../access/access-policy.service';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { IngestService } from '../mail/ingest.service';
import { QueueService, type FlagAction } from '../mail/queue.service';
import { PrismaService } from '../prisma/prisma.service';

/** Folder changes per action, applied locally so the next sync does not undo the action before the provider has it. */
const FOLDER_CHANGE: Partial<Record<FlagAction, { remove: FolderType[]; add: FolderType | null }>> = {
  archive: { remove: ['INBOX'], add: 'ARCHIVE' },
  unarchive: { remove: ['ARCHIVE'], add: 'INBOX' },
  spam: { remove: ['INBOX', 'ARCHIVE'], add: 'SPAM' },
  'not-spam': { remove: ['SPAM'], add: 'INBOX' },
};
/** Changing where a conversation lives is a status-level action; read/star is personal triage. */
const STATUS_LEVEL = new Set<FlagAction>(['archive', 'unarchive', 'spam', 'not-spam']);

@Injectable()
export class ThreadActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessPolicy,
    private readonly ingest: IngestService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  private async visible(ctx: RequestContext, id: string, permission: 'conversation.read' | 'conversation.status') {
    if (!ctx.permissions[permission]) throw Errors.forbidden();
    const t = await this.prisma.emailThread.findFirst({ where: { AND: [{ id }, await this.access.threadWhere(ctx, permission)] } });
    if (!t) {
      // Visible for reading but not for this action → 403; not visible at all → 404.
      const readable = await this.prisma.emailThread.count({ where: { AND: [{ id }, await this.access.threadWhere(ctx)] } });
      throw readable ? Errors.forbidden() : Errors.notFound('Conversation');
    }
    return t;
  }

  async apply(ctx: RequestContext, id: string, action: FlagAction) {
    const thread = await this.visible(ctx, id, STATUS_LEVEL.has(action) ? 'conversation.status' : 'conversation.read');
    const messages = await this.prisma.emailMessage.findMany({
      where: { threadId: id },
      orderBy: { receivedAt: 'asc' },
      select: { id: true, direction: true, isRead: true, isStarred: true },
    });
    if (!messages.length) return;
    const last = messages.at(-1)!;
    let targets: string[];

    switch (action) {
      case 'read':
        targets = messages.filter((m) => !m.isRead).map((m) => m.id);
        await this.prisma.emailMessage.updateMany({ where: { id: { in: targets } }, data: { isRead: true } });
        break;
      case 'unread': {
        // Like Gmail/Outlook: mark the latest inbound message unread.
        const lastIn = [...messages].reverse().find((m) => m.direction === 'INBOUND') ?? last;
        targets = [lastIn.id];
        await this.prisma.emailMessage.update({ where: { id: lastIn.id }, data: { isRead: false } });
        break;
      }
      case 'star':
        targets = [last.id];
        await this.prisma.emailMessage.update({ where: { id: last.id }, data: { isStarred: true } });
        break;
      case 'unstar':
        targets = messages.filter((m) => m.isStarred).map((m) => m.id);
        await this.prisma.emailMessage.updateMany({ where: { threadId: id }, data: { isStarred: false } });
        await this.unlinkFolders(thread.emailAccountId, messages.map((m) => m.id), ['STARRED']);
        break;
      default: {
        targets = messages.map((m) => m.id);
        const change = FOLDER_CHANGE[action]!;
        await this.unlinkFolders(thread.emailAccountId, targets, change.remove);
        if (change.add) {
          const folder = await this.prisma.emailFolder.findFirst({ where: { emailAccountId: thread.emailAccountId, type: change.add } });
          if (folder) await this.prisma.messageFolder.createMany({ data: targets.map((messageId) => ({ messageId, folderId: folder.id })), skipDuplicates: true });
        }
      }
    }
    await this.ingest.refreshThreads([id]);
    if (STATUS_LEVEL.has(action)) {
      await this.prisma.$transaction((tx) => this.audit.record(tx, ctx, { action: `thread.${action}`, entityType: 'EmailThread', entityId: id }));
    }
    if (targets.length) await this.queue.enqueueFlags({ threadId: id, action, messageIds: targets });
  }

  private async unlinkFolders(accountId: string, messageIds: string[], types: FolderType[]) {
    await this.prisma.messageFolder.deleteMany({ where: { messageId: { in: messageIds }, folder: { emailAccountId: accountId, type: { in: types } } } });
  }

  /** Snooze is CRM-only: the conversation leaves the inbox until `until` (null = wake now). */
  async snooze(ctx: RequestContext, id: string, until: Date | null) {
    await this.visible(ctx, id, 'conversation.read');
    if (until && until.getTime() <= Date.now()) throw Errors.validation([{ path: 'until', message: 'Choose a time in the future' }]);
    await this.prisma.emailThread.update({ where: { id }, data: { snoozedUntil: until } });
  }
}
