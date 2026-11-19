import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type NotificationType } from '@crm/db';
import { newId } from '@crm/crypto';
import { NOTIFICATION_TYPES, type NotificationView } from '@crm/shared';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { EventsPublisher } from '../events/events.service';
import { QueueService } from '../mail/queue.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { isAllowedPushEndpoint } from './push.service';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  threadId?: string | null;
  /** Where a click goes; defaults to the conversation (or the bell). */
  url?: string;
  data?: Record<string, unknown>;
}

/** Work to do once the transaction that wrote the notifications has committed. */
export interface Outbox {
  live: { userId: string; id: string }[];
  push: { userId: string; title: string; body: string | null; url: string; tag: string }[];
}

/** Stored with the notification; older rows fall back to their conversation. */
function urlOf(n: { threadId: string | null; data: Prisma.JsonValue }) {
  const u = (n.data as { url?: unknown } | null)?.url;
  return typeof u === "string" && u.startsWith("/") ? u : n.threadId ? `/inbox?thread=${n.threadId}` : "/";
}

const emptyOutbox = (): Outbox => ({ live: [], push: [] });

/**
 * The one place notifications are created. Each employee's preferences decide whether a
 * notification goes to the bell (in-app) and/or to their devices (browser push).
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsPublisher,
    private readonly queue: QueueService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Writes notifications inside the caller's transaction; call `flush` after it commits. */
  async createIn(tx: Tx, inputs: NotifyInput[], outbox: Outbox = emptyOutbox()): Promise<Outbox> {
    if (!inputs.length) return outbox;
    const userIds = [...new Set(inputs.map((i) => i.userId))];
    const [active, prefs] = await Promise.all([
      tx.user.findMany({ where: { id: { in: userIds }, status: 'ACTIVE' }, select: { id: true } }),
      tx.notificationPreference.findMany({ where: { userId: { in: userIds }, type: { in: [...new Set(inputs.map((i) => i.type))] } } }),
    ]);
    const isActive = new Set(active.map((u) => u.id));
    const pref = new Map(prefs.map((p) => [`${p.userId}:${p.type}`, p]));
    for (const n of inputs) {
      if (!isActive.has(n.userId)) continue;
      const p = pref.get(`${n.userId}:${n.type}`) ?? { inApp: true, push: true };
      const title = n.title.slice(0, 300);
      const url = n.url ?? (n.threadId ? `/inbox?thread=${n.threadId}` : '/');
      if (p.inApp) {
        const id = newId();
        await tx.notification.create({
          data: { id, userId: n.userId, type: n.type, title, body: n.body ?? null, threadId: n.threadId ?? null, data: { ...(n.data ?? {}), url } as Prisma.InputJsonValue },
        });
        outbox.live.push({ userId: n.userId, id });
      }
      if (p.push && this.cfg.webPushEnabled) outbox.push.push({ userId: n.userId, title, body: n.body ?? null, url, tag: n.threadId ?? n.type });
    }
    return outbox;
  }

  /** Live bell update (SSE) and browser push. Never throws: notifying must not undo the action. */
  async flush(outbox: Outbox) {
    try {
      for (const userId of new Set(outbox.live.map((l) => l.userId))) await this.events.notificationsChanged(userId);
      if (outbox.push.length) {
        const withDevices = new Set(
          (await this.prisma.pushSubscription.findMany({ where: { userId: { in: outbox.push.map((p) => p.userId) } }, select: { userId: true } })).map((s) => s.userId),
        );
        for (const p of outbox.push) if (withDevices.has(p.userId)) await this.queue.enqueuePush(p);
      }
    } catch (e) {
      this.log.warn(`Notification delivery failed: ${(e as Error).message}`);
    }
  }

  async notify(inputs: NotifyInput[]) {
    if (!inputs.length) return;
    const outbox = await this.prisma.$transaction((tx) => this.createIn(tx, inputs));
    await this.flush(outbox);
  }

  // ───────────── the employee's own bell ─────────────

  async list(ctx: RequestContext, q: { unread?: boolean; cursor?: string; limit: number }): Promise<{ items: NotificationView[]; nextCursor: string | null; unread: number }> {
    const where: Prisma.NotificationWhereInput = { userId: ctx.userId, ...(q.unread ? { readAt: null } : {}) };
    if (q.cursor) {
      const c = await this.prisma.notification.findFirst({ where: { id: q.cursor, userId: ctx.userId }, select: { createdAt: true, id: true } });
      if (!c) throw Errors.badRequest('Invalid cursor');
      where.OR = [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }];
    }
    const [rows, unread] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.limit + 1 }),
      this.unreadCount(ctx),
    ]);
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, threadId: n.threadId, url: urlOf(n), readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() })),
      nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
      unread,
    };
  }

  unreadCount(ctx: RequestContext) {
    return this.prisma.notification.count({ where: { userId: ctx.userId, readAt: null } });
  }

  async markRead(ctx: RequestContext, id: string) {
    const r = await this.prisma.notification.updateMany({ where: { id, userId: ctx.userId, readAt: null }, data: { readAt: new Date() } });
    if (!r.count && !(await this.prisma.notification.count({ where: { id, userId: ctx.userId } }))) throw Errors.notFound('Notification');
    await this.events.notificationsChanged(ctx.userId);
  }

  async markAllRead(ctx: RequestContext) {
    await this.prisma.notification.updateMany({ where: { userId: ctx.userId, readAt: null }, data: { readAt: new Date() } });
    await this.events.notificationsChanged(ctx.userId);
  }

  // ───────────── preferences ─────────────

  async preferences(ctx: RequestContext) {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId: ctx.userId } });
    const by = new Map(rows.map((r) => [r.type, r]));
    return {
      pushAvailable: this.cfg.webPushEnabled,
      items: NOTIFICATION_TYPES.map((t) => ({ type: t.type, label: t.label, description: t.description, inApp: by.get(t.type)?.inApp ?? true, push: by.get(t.type)?.push ?? true })),
    };
  }

  async setPreferences(ctx: RequestContext, items: { type: NotificationType; inApp: boolean; push: boolean }[]) {
    await this.prisma.$transaction(
      items.map((i) =>
        this.prisma.notificationPreference.upsert({
          where: { userId_type: { userId: ctx.userId, type: i.type } },
          create: { userId: ctx.userId, type: i.type, inApp: i.inApp, push: i.push },
          update: { inApp: i.inApp, push: i.push },
        }),
      ),
    );
    return this.preferences(ctx);
  }

  // ───────────── this device's push subscription ─────────────

  async subscribe(ctx: RequestContext, s: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent: string | null) {
    if (!this.cfg.webPushEnabled) throw Errors.conflict('Browser notifications are not set up on the server', 'PUSH_DISABLED');
    if (!isAllowedPushEndpoint(s.endpoint)) throw Errors.validation([{ path: 'endpoint', message: 'Not a browser push service' }]);
    // An endpoint belongs to one browser profile; if another employee used it before, it moves to the caller.
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: s.endpoint },
      create: { id: newId(), userId: ctx.userId, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null },
      update: { userId: ctx.userId, p256dh: s.keys.p256dh, auth: s.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null },
    });
  }

  async unsubscribe(ctx: RequestContext, endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint, userId: ctx.userId } });
  }

  async devices(ctx: RequestContext) {
    return (await this.prisma.pushSubscription.findMany({ where: { userId: ctx.userId }, orderBy: { createdAt: 'desc' } })).map((s) => ({
      endpoint: s.endpoint,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
    }));
  }
}
