import { Inject, Injectable, Logger } from '@nestjs/common';
import webpush from 'web-push';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { PushJob } from '../mail/queue.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Push endpoints come from the browser, so the server only ever calls the browser vendors'
 * push services (no request forgery towards internal hosts). Tests add their local fake.
 */
export const PUSH_HOSTS: { exact: Set<string>; suffixes: string[]; allowHttpLocalhost: boolean } = {
  exact: new Set(['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']),
  suffixes: ['.notify.windows.com', '.push.apple.com', '.push.services.mozilla.com'],
  allowHttpLocalhost: false,
};

export function isAllowedPushEndpoint(endpoint: string) {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (PUSH_HOSTS.allowHttpLocalhost && u.protocol === 'http:' && u.hostname === '127.0.0.1') return true;
  if (u.protocol !== 'https:' || u.port) return false;
  return PUSH_HOSTS.exact.has(u.hostname) || PUSH_HOSTS.suffixes.some((s) => u.hostname.endsWith(s));
}

/** Sends one notification to every registered device of an employee (worker only). */
@Injectable()
export class PushService {
  private readonly log = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async send(job: PushJob): Promise<{ sent: number; removed: number }> {
    if (!this.cfg.webPushEnabled) return { sent: 0, removed: 0 };
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId: job.userId } });
    const payload = JSON.stringify({ title: job.title, body: job.body, url: job.url, tag: job.tag });
    let sent = 0;
    let removed = 0;
    for (const s of subs) {
      if (!isAllowedPushEndpoint(s.endpoint)) {
        await this.prisma.pushSubscription.deleteMany({ where: { id: s.id } });
        removed++;
        continue;
      }
      // web-push encrypts the payload (RFC 8291) and signs the VAPID header; the request itself goes out with fetch.
      const req = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
        TTL: 3600,
        urgency: 'high',
        vapidDetails: { subject: this.cfg.VAPID_SUBJECT ?? this.cfg.appOrigin, publicKey: this.cfg.VAPID_PUBLIC_KEY!, privateKey: this.cfg.VAPID_PRIVATE_KEY! },
      });
      try {
        const res = await fetch(req.endpoint, {
          method: 'POST',
          headers: req.headers as Record<string, string>,
          body: req.body ? new Uint8Array(req.body) : null,
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          sent++;
        } else if (res.status === 404 || res.status === 410) {
          // The browser dropped the subscription (signed out, uninstalled, permission revoked).
          await this.prisma.pushSubscription.deleteMany({ where: { id: s.id } });
          removed++;
        } else {
          this.log.warn(`Push to a device failed (${res.status})`);
        }
      } catch (e) {
        this.log.warn(`Push to a device failed: ${(e as Error).message}`);
      }
    }
    return { sent, removed };
  }
}
