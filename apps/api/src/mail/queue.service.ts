import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import type { SyncKind } from '@crm/db';
import { APP_CONFIG, type AppConfig } from '../config/config';

export const QUEUES = {
  sync: 'mail-sync',
  poll: 'mail-poll',
  subscriptions: 'mail-subscriptions',
  purge: 'mail-purge',
} as const;

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
    for (const name of [QUEUES.poll, QUEUES.subscriptions, QUEUES.purge]) {
      if (!existing.has(name)) await boss.createQueue(name, { policy: 'singleton', retryLimit: 2 });
    }
  }

  async enqueueSync(accountId: string, kind: SyncKind): Promise<void> {
    const boss = await this.get();
    await boss.send(QUEUES.sync, { accountId, kind } satisfies SyncJob, { singletonKey: accountId });
  }

  async onModuleDestroy() {
    if (!this.boss) return;
    const boss = await this.boss.catch(() => null);
    await boss?.stop({ graceful: true, timeout: 20_000 });
  }
}
