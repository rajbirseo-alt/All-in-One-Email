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
  /** SLA steps and follow-up dates that have come due (every minute). */
  slaSweep: 'sla-sweep',
  /** Browser push for one notification. */
  push: 'notify-push',
  /** AI analysis of a conversation (summary, category, urgency, lead detection). */
  ai: 'ai-analyze',
  /** Automation rules for one event. */
  automation: 'automation-run',
  /** Report rollup of the last few hours (every 10 minutes). */
  analyticsFast: 'analytics-fast',
  /** Report rollup of the last two days, catching late changes (nightly). */
  analyticsSettle: 'analytics-settle',
  /** Health checks; administrators are told when something breaks or recovers (every 5 minutes). */
  healthAlerts: 'health-alerts',
} as const;

/** Analyse a conversation; then run the automation rules for the new mail. */
export interface AiJob {
  threadId: string;
  /** The inbound message that triggered it (MESSAGE_RECEIVED event key). */
  messageId: string | null;
}

export type AutomationTriggerName = 'MESSAGE_RECEIVED' | 'LEAD_DETECTED' | 'USER_ABSENT';
export interface AutomationJob {
  trigger: AutomationTriggerName;
  /** Unique per event: a rule runs at most once for it. */
  eventKey: string;
  threadId?: string | null;
  userId?: string | null;
}

export type FlagAction = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'unarchive' | 'spam' | 'not-spam';

export interface FlagJob {
  threadId: string;
  action: FlagAction;
  /** Stored message ids the action applies to. */
  messageIds: string[];
  /**
   * IMAP: where each copy was (folder path, type, UID) before the action changed the local
   * folder links, so the worker can find it on the server.
   */
  imapRefs?: { path: string; type: string; uid: number }[];
}

export interface SendJob {
  draftId: string;
  /** The approval this job belongs to; a cancelled and re-approved draft ignores older jobs. */
  approvedAt: string;
}

/** A browser push to every device of one employee. Carries no mail content beyond the notification title. */
export interface PushJob {
  userId: string;
  title: string;
  body: string | null;
  /** Path in the web app to open on click. */
  url: string;
  tag: string;
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
    if (!existing.has(QUEUES.push)) {
      await boss.createQueue(QUEUES.push, { policy: 'standard', retryLimit: 2, retryDelay: 30, expireInSeconds: 300 });
    }
    if (!existing.has(QUEUES.ai)) {
      await boss.createQueue(QUEUES.ai, { policy: 'standard', retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 600 });
    }
    if (!existing.has(QUEUES.automation)) {
      await boss.createQueue(QUEUES.automation, { policy: 'standard', retryLimit: 2, retryDelay: 30, expireInSeconds: 900 });
    }
    for (const name of [QUEUES.poll, QUEUES.subscriptions, QUEUES.purge, QUEUES.slaSweep, QUEUES.analyticsFast, QUEUES.analyticsSettle, QUEUES.healthAlerts]) {
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

  async enqueueAi(job: AiJob): Promise<void> {
    const boss = await this.get();
    await boss.send(QUEUES.ai, job, { singletonKey: job.threadId });
  }

  async enqueueAutomation(job: AutomationJob): Promise<void> {
    const boss = await this.get();
    await boss.send(QUEUES.automation, job);
  }

  async enqueuePush(job: PushJob): Promise<void> {
    const boss = await this.get();
    await boss.send(QUEUES.push, job);
  }

  async onModuleDestroy() {
    if (!this.boss) return;
    const boss = await this.boss.catch(() => null);
    await boss?.stop({ graceful: true, timeout: 20_000 });
  }
}
