import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUES, QueueService, type SyncJob } from './queue.service';
import { RetentionService } from './retention.service';
import { SubscriptionService } from './subscription.service';
import { SyncService } from './sync.service';

/** Schedules (UTC). */
export const SCHEDULES = {
  /** Fallback poll, even when push is healthy (docs/06). */
  poll: '*/5 * * * *',
  subscriptions: '7 * * * *',
  /** 21:30 UTC = 03:00 IST. */
  purge: '30 21 * * *',
} as const;

/** Runs in the worker process only: job handlers and cron schedules. */
@Injectable()
export class MailWorkerService {
  private readonly log = new Logger(MailWorkerService.name);

  constructor(
    private readonly queue: QueueService,
    private readonly sync: SyncService,
    private readonly subscriptions: SubscriptionService,
    private readonly retention: RetentionService,
    private readonly prisma: PrismaService,
  ) {}

  /** One sync job; after a successful run, push subscriptions are created or renewed if due. */
  async handleSync(job: SyncJob) {
    const outcome = await this.sync.run(job.accountId, job.kind);
    if (outcome === 'succeeded') await this.subscriptions.ensure(job.accountId);
    return outcome;
  }

  async enqueuePoll() {
    const accounts = await this.prisma.emailAccount.findMany({
      where: { status: { in: ['ACTIVE', 'ERROR', 'INITIAL_SYNC'] }, provider: { in: ['GMAIL', 'MICROSOFT'] } },
      select: { id: true },
    });
    for (const a of accounts) await this.queue.enqueueSync(a.id, 'POLL');
    return accounts.length;
  }

  async start() {
    const boss = await this.queue.get('worker');
    await boss.work<SyncJob>(QUEUES.sync, { localConcurrency: 4 }, async (jobs) => {
      for (const job of jobs) await this.handleSync(job.data);
    });
    await boss.work(QUEUES.poll, async () => {
      await this.enqueuePoll();
    });
    await boss.work(QUEUES.subscriptions, async () => {
      await this.subscriptions.renewDue();
    });
    await boss.work(QUEUES.purge, async () => {
      await this.retention.purgeDue();
    });
    await boss.schedule(QUEUES.poll, SCHEDULES.poll);
    await boss.schedule(QUEUES.subscriptions, SCHEDULES.subscriptions);
    await boss.schedule(QUEUES.purge, SCHEDULES.purge);
    // Catch up right away after a restart instead of waiting for the first tick.
    await this.enqueuePoll();
    this.log.log('Mail worker started');
  }
}
