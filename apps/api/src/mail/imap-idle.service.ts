import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { AuthError, type ImapClient } from '@crm/providers';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialService } from './credential.service';
import { QueueService } from './queue.service';

interface Watch {
  client: ImapClient | null;
  attempts: number;
  retry: NodeJS.Timeout | null;
  debounce: NodeJS.Timeout | null;
  closed: boolean;
}

/** How often the set of IMAP mailboxes to watch is re-read (a newly connected mailbox is watched within this). */
const RECONCILE_MS = 15_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Worker: keeps one IMAP IDLE connection per active IMAP mailbox on its inbox (docs/06 §4). New
 * mail (EXISTS) queues a sync within seconds. Connections drop and come back with backoff;
 * imapflow re-issues IDLE every 25 minutes. The 5-minute poll stays the safety net, and syncs
 * use their own second connection (at most two per mailbox).
 */
@Injectable()
export class ImapIdleService implements OnModuleDestroy {
  private readonly log = new Logger(ImapIdleService.name);
  private readonly watches = new Map<string, Watch>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialService,
    private readonly queue: QueueService,
  ) {}

  async start() {
    this.stopped = false;
    await this.reconcile();
    this.timer = setInterval(() => void this.reconcile().catch((e: Error) => this.log.warn(`IDLE reconcile failed: ${e.message}`)), RECONCILE_MS);
    this.timer.unref();
  }

  /** Mailboxes currently watched (for tests and the health log). */
  watching(): string[] {
    return [...this.watches].filter(([, w]) => !!w.client).map(([id]) => id);
  }

  async reconcile() {
    if (this.stopped) return;
    const wanted = new Set(
      (await this.prisma.emailAccount.findMany({ where: { provider: 'IMAP', status: { in: ['ACTIVE', 'ERROR'] } }, select: { id: true } })).map((a) => a.id),
    );
    for (const id of [...this.watches.keys()]) if (!wanted.has(id)) await this.drop(id);
    // In parallel: one unreachable host must not hold up the others.
    await Promise.all([...wanted].filter((id) => !this.watches.has(id)).map((id) => this.open(id)));
  }

  private async open(accountId: string, attempts = 0) {
    if (this.stopped) return;
    const w: Watch = { client: null, attempts, retry: null, debounce: null, closed: false };
    this.watches.set(accountId, w);
    try {
      const client = await this.credentials.imap(accountId);
      await client.connect({ autoIdle: true });
      const inbox = (await this.prisma.emailFolder.findFirst({ where: { emailAccountId: accountId, type: 'INBOX' }, select: { providerFolderId: true } }))?.providerFolderId ?? 'INBOX';
      const raw = client.raw;
      await raw.mailboxOpen(inbox, { readOnly: true });
      raw.on('exists', () => this.trigger(accountId, w));
      raw.on('close', () => this.lost(accountId, w));
      w.client = client;
      w.attempts = 0;
      // Mail that arrived while the mailbox was not watched (just connected, or reconnecting).
      this.trigger(accountId, w);
      // Start idling now rather than after imapflow's quiet period.
      void raw.idle().catch(() => undefined);
    } catch (e) {
      // A wrong password is reported by the next sync (NEEDS_REAUTH), which stops the watch.
      if (!(e instanceof AuthError)) this.log.warn(`IDLE for ${accountId} failed: ${(e as Error).message}`);
      this.lost(accountId, w);
    }
  }

  private trigger(accountId: string, w: Watch) {
    if (w.debounce) return;
    w.debounce = setTimeout(() => {
      w.debounce = null;
      void this.queue.enqueueSync(accountId, 'IDLE').catch((e: Error) => this.log.warn(`Queueing sync for ${accountId} failed: ${e.message}`));
    }, 1500);
    w.debounce.unref();
  }

  private lost(accountId: string, w: Watch) {
    if (w.closed || this.stopped || this.watches.get(accountId) !== w) return;
    w.closed = true;
    w.client = null;
    const delay = Math.min(MAX_BACKOFF_MS, 5000 * 2 ** w.attempts);
    w.retry = setTimeout(() => {
      if (this.watches.get(accountId) === w) this.watches.delete(accountId);
      void this.open(accountId, w.attempts + 1);
    }, delay);
    w.retry.unref();
  }

  private async drop(accountId: string) {
    const w = this.watches.get(accountId);
    this.watches.delete(accountId);
    if (!w) return;
    w.closed = true;
    if (w.retry) clearTimeout(w.retry);
    if (w.debounce) clearTimeout(w.debounce);
    await w.client?.close().catch(() => undefined);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const id of [...this.watches.keys()]) await this.drop(id);
  }

  async onModuleDestroy() {
    await this.stop();
  }
}
