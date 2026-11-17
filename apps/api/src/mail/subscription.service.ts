import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId, randomToken, sha256Hex } from '@crm/crypto';
import { AuthError } from '@crm/providers';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { SyncService } from './sync.service';

/** Graph message subscriptions last at most 4230 minutes; ask for slightly less. */
const GRAPH_LIFETIME_MS = 4200 * 60_000;
/** Renew when less than this is left (the renewal job runs hourly). */
const GRAPH_RENEW_BEFORE_MS = 24 * 3_600_000;
/** Gmail watch lasts 7 days; Google recommends renewing daily. */
const GMAIL_RENEW_BEFORE_MS = 6 * 86_400_000;
const GRAPH_PUSH_FOLDERS = ['INBOX', 'SENT'] as const;

/**
 * Push notifications (Gmail watch → Pub/Sub, Graph subscriptions). They only make new mail show
 * up faster; the 5-minute poll keeps working without them.
 */
@Injectable()
export class SubscriptionService {
  private readonly log = new Logger(SubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: SyncService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Creates missing / renews expiring subscriptions for one active account. Never throws for push problems. */
  async ensure(accountId: string): Promise<void> {
    const account = await this.prisma.emailAccount.findUnique({ where: { id: accountId } });
    if (!account || account.status !== 'ACTIVE') return;
    try {
      if (account.provider === 'GMAIL' && this.cfg.gmailPushEnabled) await this.ensureGmail(accountId);
      if (account.provider === 'MICROSOFT' && this.cfg.graphPushEnabled) await this.ensureGraph(accountId);
    } catch (e) {
      // AuthError is surfaced by the next sync run; other push failures just leave polling in charge.
      if (!(e instanceof AuthError)) this.log.warn(`Push setup failed for ${accountId}: ${(e as Error).message}`);
    }
  }

  private async ensureGmail(accountId: string) {
    const current = await this.prisma.emailWebhookSubscription.findFirst({ where: { emailAccountId: accountId, provider: 'GMAIL', status: 'ACTIVE' } });
    if (current && current.expiresAt.getTime() - Date.now() > GMAIL_RENEW_BEFORE_MS) return;
    const { expiration } = await this.sync.gmail(accountId).watch(this.cfg.GMAIL_PUBSUB_TOPIC!);
    if (current) {
      await this.prisma.emailWebhookSubscription.update({ where: { id: current.id }, data: { expiresAt: expiration } });
    } else {
      await this.prisma.emailWebhookSubscription.create({
        data: { id: newId(), emailAccountId: accountId, provider: 'GMAIL', resource: this.cfg.GMAIL_PUBSUB_TOPIC!, expiresAt: expiration },
      });
    }
  }

  private async ensureGraph(accountId: string) {
    const graph = this.sync.graph(accountId);
    const folders = await this.prisma.emailFolder.findMany({ where: { emailAccountId: accountId, type: { in: [...GRAPH_PUSH_FOLDERS] } } });
    for (const folder of folders) {
      const resource = `me/mailFolders('${folder.providerFolderId}')/messages`;
      const current = await this.prisma.emailWebhookSubscription.findFirst({
        where: { emailAccountId: accountId, provider: 'MICROSOFT', resource, status: 'ACTIVE' },
      });
      const target = new Date(Date.now() + GRAPH_LIFETIME_MS);
      if (current?.externalId) {
        if (current.expiresAt.getTime() - Date.now() > GRAPH_RENEW_BEFORE_MS) continue;
        const renewed = await graph.renewSubscription(current.externalId, target);
        if (renewed) {
          await this.prisma.emailWebhookSubscription.update({ where: { id: current.id }, data: { expiresAt: renewed } });
          continue;
        }
        await this.prisma.emailWebhookSubscription.update({ where: { id: current.id }, data: { status: 'EXPIRED' } });
      }
      const clientState = randomToken(32);
      const created = await graph.createSubscription({
        resource,
        notificationUrl: `${this.cfg.webhookBaseUrl}/graph`,
        lifecycleNotificationUrl: `${this.cfg.webhookBaseUrl}/graph/lifecycle`,
        clientState,
        expiresAt: target,
      });
      await this.prisma.emailWebhookSubscription.create({
        data: {
          id: newId(),
          emailAccountId: accountId,
          provider: 'MICROSOFT',
          externalId: created.id,
          resource,
          clientStateHash: sha256Hex(clientState),
          expiresAt: created.expiresAt,
        },
      });
    }
  }

  /** Hourly job: ensure push for every active account (cheap when nothing is due). */
  async renewDue() {
    const accounts = await this.prisma.emailAccount.findMany({ where: { status: 'ACTIVE', provider: { in: ['GMAIL', 'MICROSOFT'] } }, select: { id: true } });
    for (const a of accounts) await this.ensure(a.id);
  }

  /** Stops push at the provider (best effort) and marks local rows deleted. */
  async removeAll(accountId: string) {
    const subs = await this.prisma.emailWebhookSubscription.findMany({ where: { emailAccountId: accountId, status: 'ACTIVE' } });
    for (const s of subs) {
      try {
        if (s.provider === 'GMAIL') await this.sync.gmail(accountId).stopWatch();
        else if (s.externalId) await this.sync.graph(accountId).deleteSubscription(s.externalId);
      } catch (e) {
        this.log.warn(`Could not remove subscription ${s.id} at the provider: ${(e as Error).message}`);
      }
    }
    await this.prisma.emailWebhookSubscription.updateMany({ where: { emailAccountId: accountId, status: 'ACTIVE' }, data: { status: 'DELETED' } });
  }
}
