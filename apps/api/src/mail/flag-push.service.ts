import { Injectable } from '@nestjs/common';
import { newId } from '@crm/crypto';
import { AuthError } from '@crm/providers';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialService } from './credential.service';
import type { FlagAction, FlagJob } from './queue.service';
import { SyncService } from './sync.service';

const GMAIL_LABELS: Record<FlagAction, { add: string[]; remove: string[] }> = {
  read: { add: [], remove: ['UNREAD'] },
  unread: { add: ['UNREAD'], remove: [] },
  star: { add: ['STARRED'], remove: [] },
  unstar: { add: [], remove: ['STARRED'] },
  archive: { add: [], remove: ['INBOX'] },
  unarchive: { add: ['INBOX'], remove: [] },
  spam: { add: ['SPAM'], remove: ['INBOX'] },
  'not-spam': { add: ['INBOX'], remove: ['SPAM'] },
};
const GRAPH_MOVE: Partial<Record<FlagAction, string>> = { archive: 'archive', unarchive: 'inbox', spam: 'junkemail', 'not-spam': 'inbox' };

/** Worker: applies a CRM triage action at the provider (FLAG_PUSH in sync logs). */
@Injectable()
export class FlagPushService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: SyncService,
    private readonly credentials: CredentialService,
  ) {}

  async push(job: FlagJob): Promise<void> {
    const messages = await this.prisma.emailMessage.findMany({
      where: { id: { in: job.messageIds } },
      select: { providerMessageId: true, emailAccountId: true, emailAccount: { select: { provider: true, status: true } } },
    });
    if (!messages.length) return;
    const account = messages[0]!.emailAccount;
    const accountId = messages[0]!.emailAccountId;
    if (!['ACTIVE', 'ERROR', 'INITIAL_SYNC'].includes(account.status)) return;
    const ids = messages.map((m) => m.providerMessageId);
    const log = await this.prisma.syncLog.create({ data: { id: newId(), emailAccountId: accountId, kind: 'FLAG_PUSH', status: 'RUNNING', details: { action: job.action, messages: ids.length } } });
    try {
      if (account.provider === 'GMAIL') {
        const { add, remove } = GMAIL_LABELS[job.action];
        await this.sync.gmail(accountId).modifyLabels(ids, add, remove);
      } else if (account.provider === 'MICROSOFT') {
        const graph = this.sync.graph(accountId);
        for (const id of ids) {
          if (job.action === 'read' || job.action === 'unread') await graph.updateMessage(id, { isRead: job.action === 'read' });
          else if (job.action === 'star' || job.action === 'unstar') await graph.updateMessage(id, { flag: { flagStatus: job.action === 'star' ? 'flagged' : 'notFlagged' } });
          else await graph.moveMessage(id, GRAPH_MOVE[job.action]!);
        }
      } else {
        await this.imap(accountId, job);
      }
      await this.prisma.syncLog.update({ where: { id: log.id }, data: { status: 'SUCCEEDED', messagesUpdated: ids.length, finishedAt: new Date() } });
    } catch (e) {
      await this.prisma.syncLog.update({ where: { id: log.id }, data: { status: 'FAILED', error: (e as Error).message.slice(0, 1000), finishedAt: new Date() } });
      // A revoked grant is surfaced by the next sync run (NEEDS_REAUTH); retrying cannot help.
      if (e instanceof AuthError) return;
      throw e;
    }
  }

  /**
   * IMAP: flags are set on each copy of the message (per folder and UID). Archive / spam move the
   * inbox copy to the Archive / Junk folder, and back. The next sync records the new UID.
   */
  private async imap(accountId: string, job: FlagJob) {
    const action = job.action;
    const refs =
      job.imapRefs ??
      (
        await this.prisma.messageFolder.findMany({
          where: { messageId: { in: job.messageIds }, imapUid: { not: null } },
          select: { imapUid: true, folder: { select: { providerFolderId: true, type: true } } },
        })
      ).map((l) => ({ path: l.folder.providerFolderId, type: l.folder.type, uid: Number(l.imapUid) }));
    const byFolder = new Map<string, { type: string; uids: number[] }>();
    for (const r of refs) {
      const e = byFolder.get(r.path) ?? { type: r.type, uids: [] };
      e.uids.push(r.uid);
      byFolder.set(r.path, e);
    }
    const special = async (type: 'ARCHIVE' | 'SPAM' | 'INBOX') =>
      (await this.prisma.emailFolder.findFirst({ where: { emailAccountId: accountId, type }, orderBy: { name: 'asc' }, select: { providerFolderId: true } }))?.providerFolderId ?? null;
    const imap = await this.credentials.imap(accountId);
    try {
      const FLAG: Partial<Record<FlagAction, { add?: string[]; remove?: string[] }>> = {
        read: { add: ['\\Seen'] },
        unread: { remove: ['\\Seen'] },
        star: { add: ['\\Flagged'] },
        unstar: { remove: ['\\Flagged'] },
      };
      const flag = FLAG[action];
      if (flag) {
        for (const [path, f] of byFolder) await imap.setFlags(path, f.uids, flag);
        return;
      }
      const from = action === 'archive' || action === 'spam' ? 'INBOX' : action === 'unarchive' ? 'ARCHIVE' : 'SPAM';
      const to = await special(action === 'archive' ? 'ARCHIVE' : action === 'spam' ? 'SPAM' : 'INBOX');
      if (!to) throw new Error(`This mailbox has no ${action === 'archive' ? 'Archive' : action === 'spam' ? 'Junk' : 'Inbox'} folder`);
      for (const [path, f] of byFolder) if (f.type === from && path !== to) await imap.move(path, f.uids, to);
    } finally {
      await imap.close();
    }
  }
}
