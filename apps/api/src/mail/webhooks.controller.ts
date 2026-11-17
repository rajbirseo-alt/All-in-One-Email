import { Body, Controller, HttpCode, Inject, Logger, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { jwtVerify } from 'jose';
import { Prisma } from '@crm/db';
import { newId, safeEqual, sha256Hex } from '@crm/crypto';
import { Public } from '../common/decorators';
import { Errors } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { MAIL_ENDPOINTS, type MailEndpoints } from './mail-endpoints';
import { QueueService } from './queue.service';

interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  lifecycleEvent?: 'reauthorizationRequired' | 'subscriptionRemoved' | 'missed';
}

/**
 * Provider push endpoints. No session; each request is verified for its provider. Handlers only
 * deduplicate and enqueue a sync, so they answer within milliseconds.
 */
@Public()
@Controller('webhooks')
export class WebhooksController {
  private readonly log = new Logger(WebhooksController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    @Inject(MAIL_ENDPOINTS) private readonly endpoints: MailEndpoints,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Gmail → Pub/Sub push. Verified by the OIDC token Pub/Sub attaches (signature, audience, service account). */
  @Post('gmail')
  @HttpCode(204)
  async gmail(@Req() req: Request, @Body() body: { message?: { data?: string; messageId?: string } }) {
    if (!this.cfg.gmailPushEnabled) throw Errors.notFound('Endpoint');
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    try {
      const { payload } = await jwtVerify(token, this.endpoints.googleJwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: this.cfg.GMAIL_PUSH_AUDIENCE ?? `${this.cfg.webhookBaseUrl}/gmail`,
      });
      if (payload.email !== this.cfg.GMAIL_PUSH_SERVICE_ACCOUNT || payload.email_verified !== true) throw new Error('unexpected service account');
    } catch (e) {
      this.log.warn(`Rejected Gmail push: ${(e as Error).message}`);
      throw Errors.unauthenticated('Invalid push token');
    }

    const messageId = body.message?.messageId;
    let data: { emailAddress?: string };
    try {
      data = JSON.parse(Buffer.from(body.message?.data ?? '', 'base64').toString('utf8')) as { emailAddress?: string };
    } catch {
      return; // malformed: ack so Pub/Sub does not redeliver forever
    }
    if (!messageId || !data.emailAddress) return;
    if (!(await this.firstDelivery('GMAIL', messageId))) return;

    const account = await this.prisma.emailAccount.findFirst({
      where: { provider: 'GMAIL', emailAddress: data.emailAddress.toLowerCase(), status: { in: ['ACTIVE', 'ERROR'] } },
      select: { id: true },
    });
    if (!account) return;
    await this.prisma.emailWebhookSubscription.updateMany({ where: { emailAccountId: account.id, provider: 'GMAIL', status: 'ACTIVE' }, data: { lastNotifiedAt: new Date() } });
    await this.queue.enqueueSync(account.id, 'WEBHOOK');
  }

  /** Graph change notifications. Validation handshake echoes the token; notifications must carry our clientState. */
  @Post('graph')
  async graph(@Query('validationToken') validationToken: string | undefined, @Body() body: { value?: GraphNotification[] }, @Res() res: Response) {
    if (validationToken !== undefined) return this.echo(res, validationToken);
    const accounts = await this.verified(body.value ?? []);
    for (const { accountId } of accounts) await this.queue.enqueueSync(accountId, 'WEBHOOK');
    res.status(202).end();
  }

  /** Graph lifecycle events: renew (reauthorizationRequired), recreate (subscriptionRemoved) or resync (missed). */
  @Post('graph/lifecycle')
  async graphLifecycle(@Query('validationToken') validationToken: string | undefined, @Body() body: { value?: GraphNotification[] }, @Res() res: Response) {
    if (validationToken !== undefined) return this.echo(res, validationToken);
    for (const n of await this.verified(body.value ?? [])) {
      if (n.event === 'subscriptionRemoved') {
        await this.prisma.emailWebhookSubscription.update({ where: { id: n.subscriptionRowId }, data: { status: 'EXPIRED' } });
      } else if (n.event === 'reauthorizationRequired') {
        // Due now: the post-sync push check renews it.
        await this.prisma.emailWebhookSubscription.update({ where: { id: n.subscriptionRowId }, data: { expiresAt: new Date() } });
      }
      await this.queue.enqueueSync(n.accountId, 'WEBHOOK');
    }
    res.status(202).end();
  }

  private echo(res: Response, token: string) {
    res.status(200).type('text/plain').send(token.slice(0, 1024));
  }

  /** Keeps notifications whose subscription exists and whose clientState matches (constant-time). */
  private async verified(items: GraphNotification[]) {
    const out: { accountId: string; subscriptionRowId: string; event: GraphNotification['lifecycleEvent'] }[] = [];
    const seen = new Set<string>();
    for (const n of items.slice(0, 1000)) {
      if (!n.subscriptionId || !n.clientState) continue;
      const sub = await this.prisma.emailWebhookSubscription.findUnique({
        where: { provider_externalId: { provider: 'MICROSOFT', externalId: n.subscriptionId } },
        include: { emailAccount: { select: { status: true } } },
      });
      if (!sub?.clientStateHash || !safeEqual(sha256Hex(n.clientState), sub.clientStateHash)) {
        this.log.warn(`Rejected Graph notification for subscription ${n.subscriptionId}`);
        continue;
      }
      if (!['ACTIVE', 'ERROR'].includes(sub.emailAccount.status)) continue;
      const key = `${sub.id}:${n.lifecycleEvent ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.prisma.emailWebhookSubscription.update({ where: { id: sub.id }, data: { lastNotifiedAt: new Date() } });
      out.push({ accountId: sub.emailAccountId, subscriptionRowId: sub.id, event: n.lifecycleEvent });
    }
    return out;
  }

  /** Records a provider event id; false if it was already processed. */
  private async firstDelivery(provider: 'GMAIL' | 'MICROSOFT', externalEventId: string) {
    try {
      await this.prisma.webhookEvent.create({ data: { id: newId(), provider, externalEventId: externalEventId.slice(0, 200) } });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false;
      throw e;
    }
  }
}
