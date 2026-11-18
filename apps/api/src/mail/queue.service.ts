import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import type { SyncKind } from '@crm/db';
import { APP_CONFIG, type AppConfig } from '../config/config';

export const QUEUES = {
  sync: 'mail-sync',
  poll: 'mail-poll',
  subscriptions: 'mail-subscriptions',
  purge: 'mail-purge',
  /** Read/star/archive/spam changes pushed back to the provider, in order per conversation. */
  flags: 'mail-flags',
  /** Outgoing mail (drafts approved by a human). */
  send: 'mail-send',
} as const;

export type FlagAction = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'unarchive' | 'spam' | 'not-spam';

export interface FlagJob {
  threadId: string;
  action: FlagAction;
  /** Stored message ids the action applies to. */
  messageIds: string[];
}

export interface SendJob {
  draftId: string;
  /** The approval this job belongs to; a cancelled and re-approved draft ignores older jobs. */
  approvedAt: string;
}

export interface SyncJob {
  accountId: string;
  kind: SyncKind;
}

/**
 * Background jobs on PostgreSQL (pg-boss), so no separate Redis is needed. The API only enqueues;
 * the worker process (src/worker.ts) runs the handlers and the schedules.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly log = new Logger(QueueService.name);
  private boss: Promise<PgBoss> | null = null;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** Lazily starts pg-boss. `worker` also runs maintenance and cron scheduling. */
  get(mode: 'producer' | 'worker' = 'producer'): Promise<PgBoss> {
    this.boss ??= (async () => {
      const boss = new PgBoss({
        connectionString: this.cfg.DATABASE_URL,
        supervise: mode === 'worker',
        schedule: mode === 'worker',
        max: mode === 'worker' ? 5 : 2,
      });
      boss.on('error', (e: Error) => this.log.error(`queue: ${e.message}`));
      await boss.start();
      await this.createQueues(boss);
      return boss;
    })();
    return this.boss;
  }

  private async createQueues(boss: PgBoss) {
    const existing = new Set((await boss.getQueues()).map((q) => q.name));
    // One queued + one running sync per mailbox: a burst of webhooks collapses into one run.
    if (!existing.has(QUEUES.sync)) {
      await boss.createQueue(QUEUES.sync, { policy: 'stately', retryLimit: 5, retryDelay: 30, retryBackoff: true, retryDelayMax: 1800, expireInSeconds: 3600 });
    }
    if (!existing.has(QUEUES.flags)) {
      await boss.createQueue(QUEUES.flags, { policy: 'key_strict_fifo', retryLimit: 5, retryDelay: 15, retryBackoff: true, retryDelayMax: 900 });
    }
    // Sending is retried only for errors where the provider did not accept the message (see SendService).
    if (!existing.has(QUEUES.send)) {
      await boss.createQueue(QUEUES.send, { policy: 'standard', retryLimit: 3, retryDelay: 20, retryBackoff: true, expireInSeconds: 600 });
    }
    for (const name of [QUEUES.poll, QUEUES.subscriptions, QUEUES.purge]) {
      if (!existing.has(name)) await boss.createQueue(name, { policy: 'singleton', retryLimit: 2 });
    }
  }

  async enqueueSync(accountId: string, kind: SyncKind): Promise<void> {
    const boss = await this.get();
    await boss.send(QUEUES.sync, { accountId, kind } satisfies SyncJob, { singletonKey: accountId });
  }

  async enqueueFlags(job: FlagJob): Promise<void> {
    const boss = await this.get();
    await boss.send(QUEUES.flags, job, { singletonKey: job.threadId });
  }

  async enqueueSend(job: SendJob, startAfter?: Date): Promise<void> {
    const boss = await this.get();
    await boss.send(QUEUES.send, job, startAfter ? { startAfter } : {});
  }

  async onModuleDestroy() {
    if (!this.boss) return;
    const boss = await this.boss.catch(() => null);
    await boss?.stop({ graceful: true, timeout: 20_000 });
  }
}
