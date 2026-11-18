import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EmailAccount, SyncKind } from '@crm/db';
import { newId } from '@crm/crypto';
import {
  AuthError,
  CursorExpiredError,
  GmailClient,
  GraphClient,
  ProviderRequestError,
  type NormalizedFolder,
  type NormalizedMessage,
} from '@crm/providers';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialService } from './credential.service';
import { IngestService, type FolderRef, type IngestResult, type IngestTarget } from './ingest.service';
import { MAIL_ENDPOINTS, type MailEndpoints } from './mail-endpoints';
import { RoutingService } from '../assignment/routing.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Consecutive failed runs before the account is shown as ERROR. */
export const ERROR_THRESHOLD = 5;
const FETCH_CONCURRENCY = 5;
const INGEST_BATCH = 25;
/** Folder types synced by default for Graph (Gmail labels are not per-folder syncs). */
const GRAPH_DEFAULT_SYNC = new Set(['INBOX', 'SENT', 'ARCHIVE', 'SPAM', 'CUSTOM']);
const SKIP_STATUSES = new Set(['PAUSED', 'DISCONNECTED', 'NEEDS_REAUTH']);

export type SyncOutcome = 'succeeded' | 'skipped' | 'needs_reauth';

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

const epochSeconds = (d: Date) => Math.floor(d.getTime() / 1000);

/**
 * Pulls mail from Gmail / Microsoft Graph into the database. Webhooks only trigger runs; this
 * cursor-based sync (plus a 5-minute poll) is what keeps the data complete and correct.
 */
@Injectable()
export class SyncService {
  private readonly log = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialService,
    private readonly ingest: IngestService,
    private readonly audit: AuditService,
    @Inject(MAIL_ENDPOINTS) private readonly endpoints: MailEndpoints,
    private readonly routing: RoutingService,
    private readonly notifications: NotificationsService,
  ) {}

  gmail(accountId: string) {
    return new GmailClient(this.credentials.http(accountId, 'GMAIL'), this.endpoints.gmailApiBase);
  }

  graph(accountId: string) {
    return new GraphClient(this.credentials.http(accountId, 'MICROSOFT'), this.endpoints.graphApiBase);
  }

  /**
   * One sync run. AuthError marks the account NEEDS_REAUTH and returns (retrying cannot help);
   * other errors are recorded and rethrown so the queue retries with backoff.
   */
  async run(accountId: string, kind: SyncKind): Promise<SyncOutcome> {
    const account = await this.prisma.emailAccount.findUnique({ where: { id: accountId } });
    if (!account || SKIP_STATUSES.has(account.status) || account.provider === 'IMAP') return 'skipped';

    const log = await this.prisma.syncLog.create({ data: { id: newId(), emailAccountId: accountId, kind, status: 'RUNNING' } });
    const result = this.ingest.emptyResult();
    try {
      const initial = account.status === 'CONNECTING' || account.status === 'INITIAL_SYNC';
      if (account.provider === 'GMAIL') await this.syncGmail(account, initial, kind, result);
      else await this.syncGraph(account, initial, result);
      await this.ingest.refreshThreads(result.threadIds);
      // New conversations go through the assignment rules (history imported at connect does not).
      await this.routing.routeNew(result.threadIds).catch((e: Error) => this.log.error(`Routing failed: ${e.message}`));

      await this.prisma.$transaction([
        this.prisma.syncLog.update({
          where: { id: log.id },
          data: {
            status: 'SUCCEEDED',
            messagesAdded: result.added,
            messagesUpdated: result.updated,
            details: { removed: result.removed, threads: result.threadIds.size, initial },
            finishedAt: new Date(),
          },
        }),
        this.prisma.emailAccount.update({
          where: { id: accountId },
          data: { status: 'ACTIVE', lastSyncedAt: new Date(), lastSuccessAt: new Date(), consecutiveFailures: 0, lastError: null, lastErrorAt: null },
        }),
      ]);
      return 'succeeded';
    } catch (e) {
      // Keep whatever was stored before the failure consistent.
      await this.ingest.refreshThreads(result.threadIds).catch(() => undefined);
      const message = (e as Error).message.slice(0, 1000);
      const auth = e instanceof AuthError;
      const failures = account.consecutiveFailures + 1;
      const status = auth ? 'NEEDS_REAUTH' : failures >= ERROR_THRESHOLD ? 'ERROR' : account.status;
      await this.prisma.$transaction(async (tx) => {
        await tx.syncLog.update({
          where: { id: log.id },
          data: { status: 'FAILED', error: message, messagesAdded: result.added, messagesUpdated: result.updated, finishedAt: new Date() },
        });
        await tx.emailAccount.update({
          where: { id: accountId },
          data: { status, lastSyncedAt: new Date(), lastError: message, lastErrorAt: new Date(), consecutiveFailures: auth ? account.consecutiveFailures : failures },
        });
        if (status !== account.status) {
          await this.audit.record(tx, { userId: null, actorType: 'SYSTEM' }, {
            action: 'account.status',
            entityType: 'EmailAccount',
            entityId: accountId,
            before: { status: account.status },
            after: { status },
            metadata: { reason: message },
          });
        }
      });
      if (auth && account.status !== 'NEEDS_REAUTH') {
        await this.notifications.notify([
          { userId: account.connectedById, type: 'ACCOUNT_NEEDS_REAUTH', title: 'Mailbox ' + account.emailAddress + ' must be reconnected', body: 'Open Administration → Mailboxes and choose Reconnect.', data: { accountId } },
        ]).catch(() => undefined);
      }
      if (auth) {
        this.log.warn(`Mailbox ${accountId} needs to be reconnected: ${message}`);
        return 'needs_reauth';
      }
      throw e;
    }
  }

  // ───────────────────────────── folders ─────────────────────────────

  /** Upserts provider folders; returns providerFolderId → stored folder. New folders get the default sync flag. */
  async syncFolders(account: EmailAccount, folders: NormalizedFolder[]): Promise<Map<string, FolderRef & { providerFolderId: string; syncEnabled: boolean; deltaLink: string | null }>> {
    for (const f of folders) {
      await this.prisma.emailFolder.upsert({
        where: { emailAccountId_providerFolderId: { emailAccountId: account.id, providerFolderId: f.providerFolderId } },
        create: {
          id: newId(),
          emailAccountId: account.id,
          providerFolderId: f.providerFolderId,
          name: f.name.slice(0, 500),
          path: f.path?.slice(0, 1000) ?? null,
          type: f.type,
          syncEnabled: account.provider === 'GMAIL' ? true : GRAPH_DEFAULT_SYNC.has(f.type),
        },
        update: { name: f.name.slice(0, 500), path: f.path?.slice(0, 1000) ?? null, type: f.type },
      });
    }
    return this.folderMap(account.id);
  }

  private async folderMap(accountId: string) {
    const rows = await this.prisma.emailFolder.findMany({
      where: { emailAccountId: accountId },
      select: { id: true, type: true, providerFolderId: true, syncEnabled: true, deltaLink: true },
    });
    return new Map(rows.map((r) => [r.providerFolderId, r]));
  }

  private target(account: EmailAccount, folders: Map<string, FolderRef & { syncEnabled: boolean }>): IngestTarget {
    // Gmail labels with sync switched off are simply not linked; Graph folders with sync off are not fetched.
    const linked = new Map([...folders].filter(([, f]) => f.syncEnabled));
    return { accountId: account.id, accountEmail: account.emailAddress, folders: linked };
  }

  private syncWindowStart(account: EmailAccount) {
    return account.syncFromDate ?? new Date(account.createdAt.getTime() - 30 * 86_400_000);
  }

  // ───────────────────────────── Gmail ─────────────────────────────

  private async syncGmail(account: EmailAccount, initial: boolean, kind: SyncKind, result: IngestResult) {
    const gmail = this.gmail(account.id);
    const refreshFolders = initial || kind === 'POLL' || kind === 'INITIAL';
    const folders = refreshFolders ? await this.syncFolders(account, await gmail.labels()) : await this.folderMap(account.id);
    const target = this.target(account, folders);

    if (initial || !account.gmailHistoryId) {
      await this.gmailWindow(account, gmail, target, result);
      return;
    }
    try {
      await this.gmailHistory(account, gmail, target, result);
    } catch (e) {
      if (!(e instanceof CursorExpiredError)) throw e;
      // History older than ~1 week is gone: resync the window (dedupe makes this safe).
      this.log.warn(`Gmail history expired for ${account.id}; resyncing window`);
      await this.gmailWindow(account, gmail, target, result);
    }
  }

  /** Lists every message in the sync window and stores the ones not yet stored. */
  private async gmailWindow(account: EmailAccount, gmail: GmailClient, target: IngestTarget, result: IngestResult) {
    // Record the history position BEFORE listing: changes during listing are replayed by the next incremental run.
    const { historyId } = await gmail.profile();
    const q = `after:${epochSeconds(this.syncWindowStart(account))} -in:drafts`;
    let pageToken: string | undefined;
    do {
      const page = await gmail.listMessageIds(q, pageToken);
      const known = new Set(
        (
          await this.prisma.emailMessage.findMany({
            where: { emailAccountId: account.id, providerMessageId: { in: page.ids } },
            select: { providerMessageId: true },
          })
        ).map((r) => r.providerMessageId),
      );
      const missing = page.ids.filter((id) => !known.has(id));
      for (let i = 0; i < missing.length; i += INGEST_BATCH) {
        const batch = await mapLimit(missing.slice(i, i + INGEST_BATCH), FETCH_CONCURRENCY, (id) => gmail.getMessage(id));
        await this.ingest.ingest(target, batch.filter((m): m is NormalizedMessage => !!m), result);
      }
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);
    await this.prisma.emailAccount.update({ where: { id: account.id }, data: { gmailHistoryId: historyId } });
  }

  private async gmailHistory(account: EmailAccount, gmail: GmailClient, target: IngestTarget, result: IngestResult) {
    const changed = new Set<string>();
    const deleted = new Set<string>();
    let pageToken: string | undefined;
    let latest = account.gmailHistoryId!;
    do {
      const page = await gmail.history(account.gmailHistoryId!, pageToken);
      for (const h of page.history) {
        h.messagesAdded?.forEach((x) => changed.add(x.message.id));
        h.labelsAdded?.forEach((x) => changed.add(x.message.id));
        h.labelsRemoved?.forEach((x) => changed.add(x.message.id));
        h.messagesDeleted?.forEach((x) => deleted.add(x.message.id));
      }
      latest = page.historyId;
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);

    for (const id of deleted) changed.delete(id);
    result.removed += await this.ingest.removeMessages(account.id, [...deleted], result.threadIds);

    const ids = [...changed];
    const stored = new Set(
      (
        await this.prisma.emailMessage.findMany({
          where: { emailAccountId: account.id, providerMessageId: { in: ids } },
          select: { providerMessageId: true },
        })
      ).map((r) => r.providerMessageId),
    );
    for (let i = 0; i < ids.length; i += INGEST_BATCH) {
      const fetched = await mapLimit(ids.slice(i, i + INGEST_BATCH), FETCH_CONCURRENCY, async (id) => {
        if (!stored.has(id)) return gmail.getMessage(id);
        // Known message: only labels/flags can change, so the cheap format is enough.
        const labels = await gmail.getLabelIds(id);
        return labels ? ({ ...LABEL_ONLY, providerMessageId: id, providerFolderIds: labels, isRead: !labels.includes('UNREAD'), isStarred: labels.includes('STARRED'), isDraft: labels.includes('DRAFT') } as NormalizedMessage) : null;
      });
      const gone = ids.slice(i, i + INGEST_BATCH).filter((_, k) => fetched[k] === null);
      result.removed += await this.ingest.removeMessages(account.id, gone, result.threadIds);
      await this.ingest.ingest(target, fetched.filter((m): m is NormalizedMessage => !!m), result);
    }
    await this.prisma.emailAccount.update({ where: { id: account.id }, data: { gmailHistoryId: latest } });
  }

  // ───────────────────────────── Microsoft Graph ─────────────────────────────

  private async syncGraph(account: EmailAccount, initial: boolean, result: IngestResult) {
    const graph = this.graph(account.id);
    const folders = await this.syncFolders(account, await graph.folders());
    const target = this.target(account, folders);
    const since = this.syncWindowStart(account);
    const removedEverywhere: string[] = [];

    for (const folder of folders.values()) {
      if (!folder.syncEnabled) continue;
      let page;
      try {
        page = initial || !folder.deltaLink ? await graph.deltaStart(folder.providerFolderId, since) : await graph.delta(folder.deltaLink);
      } catch (e) {
        if (!(e instanceof CursorExpiredError)) throw e;
        page = await graph.deltaStart(folder.providerFolderId, since);
      }
      for (;;) {
        for (const m of page.messages) {
          if (m.hasAttachments && m.attachments.length === 0) m.attachments = await graph.attachments(m.providerMessageId);
        }
        await this.ingest.ingest(target, page.messages, result);
        await this.ingest.unlinkFromFolder(account.id, folder.id, page.removedIds);
        removedEverywhere.push(...page.removedIds);
        if (page.nextLink) page = await graph.delta(page.nextLink);
        else break;
      }
      if (!page.deltaLink) throw new ProviderRequestError('Graph delta ended without a deltaLink');
      await this.prisma.emailFolder.update({ where: { id: folder.id }, data: { deltaLink: page.deltaLink, lastSyncedAt: new Date() } });
    }
    // A message that left every synced folder was deleted or moved out of scope.
    result.removed += await this.ingest.removeOrphans(account.id, removedEverywhere, result.threadIds);
  }
}

/** Placeholder fields for a label-only Gmail update (ingest only reads flags and folders for known messages). */
const LABEL_ONLY: Omit<NormalizedMessage, 'providerMessageId' | 'providerFolderIds' | 'isRead' | 'isStarred' | 'isDraft'> = {
  providerThreadId: null,
  internetMessageId: null,
  inReplyTo: null,
  references: [],
  from: null,
  to: [],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: '',
  snippet: null,
  bodyText: null,
  bodyHtml: null,
  headers: null,
  sizeBytes: null,
  receivedAt: new Date(0),
  sentAt: null,
  hasAttachments: false,
  attachments: [],
};
