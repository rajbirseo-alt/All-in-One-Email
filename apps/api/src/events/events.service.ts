import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Response } from 'express';
import { Client } from 'pg';
import { Prisma } from '@crm/db';
import { AccessPolicy } from '../access/access-policy.service';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';

export const EVENTS_CHANNEL = 'crm_events';
export const PRESENCE_CHANNEL = 'crm_presence';
/** Payload: the user id whose notifications changed (the client refetches its own bell). */
export const NOTIFY_CHANNEL = 'crm_notify';
/** Presence older than this is dropped (clients refresh every ~30 s). */
const PRESENCE_TTL_MS = 75_000;

interface PresenceNotice {
  threadId: string;
  userId: string;
  name: string;
  state: 'viewing' | 'composing' | 'left';
  at: number;
}
/** Keeps each NOTIFY payload well under PostgreSQL's 8000-byte limit. */
const IDS_PER_NOTIFY = 100;


export interface ThreadEvent {
  type: 'thread.updated';
  threadIds: string[];
}

/** Publishes change events from any process (API or worker) through PostgreSQL NOTIFY. */
@Injectable()
export class EventsPublisher {
  constructor(private readonly prisma: PrismaService) {}

  async threadsChanged(threadIds: Iterable<string>) {
    const ids = [...new Set(threadIds)];
    for (let i = 0; i < ids.length; i += IDS_PER_NOTIFY) {
      const payload: ThreadEvent = { type: 'thread.updated', threadIds: ids.slice(i, i + IDS_PER_NOTIFY) };
      await this.prisma.$executeRaw(Prisma.sql`SELECT pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(payload)})`);
    }
  }

  async notificationsChanged(userId: string) {
    await this.prisma.$executeRaw(Prisma.sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${userId})`);
  }
}

interface Subscriber {
  ctx: RequestContext;
  res: Response;
  stillValid: () => Promise<boolean>;
}

/**
 * Live updates over Server-Sent Events. One LISTEN connection per API instance; every event is
 * filtered per subscriber with the same AccessPolicy as the REST endpoints, and only ids are sent
 * (the client refetches through the normal, permission-checked endpoints).
 */
@Injectable()
export class EventsHub implements OnModuleDestroy {
  private readonly log = new Logger(EventsHub.name);
  private readonly subscribers = new Set<Subscriber>();
  private listener: Promise<Client> | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  /** Interval of keep-alives and session re-checks (tests shorten it). */
  static heartbeatMs = 25_000;

  constructor(
    private readonly access: AccessPolicy,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private listen(): Promise<Client> {
    this.listener ??= (async () => {
      const client = new Client({ connectionString: this.cfg.DATABASE_URL });
      client.on('notification', (n) => {
        if (!n.payload) return;
        try {
          if (n.channel === EVENTS_CHANNEL) void this.dispatch(JSON.parse(n.payload) as ThreadEvent);
          else if (n.channel === PRESENCE_CHANNEL) void this.onPresence(JSON.parse(n.payload) as PresenceNotice);
          else if (n.channel === NOTIFY_CHANNEL) this.onNotify(n.payload);
        } catch {
          /* ignore malformed */
        }
      });
      client.on('error', (e) => {
        this.log.error(`event listener: ${e.message}`);
        this.listener = null; // reconnect on the next subscriber
      });
      await client.connect();
      await client.query(`LISTEN ${EVENTS_CHANNEL}`);
      await client.query(`LISTEN ${PRESENCE_CHANNEL}`);
      await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
      return client;
    })();
    return this.listener;
  }

  // ───────────── presence ("Priya is replying…") ─────────────

  /** threadId → userId → state. Fed by NOTIFY, so every API instance has the same view. */
  private readonly presence = new Map<string, Map<string, { name: string; state: 'viewing' | 'composing'; at: number }>>();

  /** Announces that a user is viewing/composing in a thread (clients repeat it every ~30 s). */
  async publishPresence(threadId: string, userId: string, name: string, state: 'viewing' | 'composing' | 'left') {
    await this.listen();
    const notice: PresenceNotice = { threadId, userId, name, state, at: Date.now() };
    await this.prisma.$executeRaw(Prisma.sql`SELECT pg_notify(${PRESENCE_CHANNEL}, ${JSON.stringify(notice)})`);
  }

  presenceFor(threadId: string): { userId: string; name: string; state: 'viewing' | 'composing' }[] {
    const now = Date.now();
    const m = this.presence.get(threadId);
    if (!m) return [];
    for (const [u, p] of m) if (now - p.at > PRESENCE_TTL_MS) m.delete(u);
    return [...m].map(([userId, p]) => ({ userId, name: p.name, state: p.state }));
  }

  private async onPresence(n: PresenceNotice) {
    let m = this.presence.get(n.threadId);
    if (!m) this.presence.set(n.threadId, (m = new Map()));
    if (n.state === 'left') m.delete(n.userId);
    else m.set(n.userId, { name: n.name, state: n.state, at: n.at });
    const list = this.presenceFor(n.threadId);
    for (const s of this.subscribers) {
      const ok = await this.prisma.emailThread.count({ where: { AND: [{ id: n.threadId }, await this.access.threadWhere(s.ctx)] } });
      if (ok) s.res.write(`event: presence\ndata: ${JSON.stringify({ threadId: n.threadId, users: list })}\n\n`);
    }
  }

  async subscribe(ctx: RequestContext, res: Response, stillValid: () => Promise<boolean>) {
    await this.listen();
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    const sub: Subscriber = { ctx, res, stillValid };
    this.subscribers.add(sub);
    res.on('close', () => this.subscribers.delete(sub));
    this.heartbeat ??= setInterval(() => void this.beat(), EventsHub.heartbeatMs);
  }

  /** Keeps proxies from closing idle streams, and ends streams whose session was revoked. */
  private async beat() {
    for (const s of this.subscribers) {
      if (!(await s.stillValid().catch(() => false))) {
        s.res.write('event: session.ended\ndata: {}\n\n');
        s.res.end();
        this.subscribers.delete(s);
      } else {
        s.res.write(': ping\n\n');
      }
    }
  }

  /** Only the owner's own streams hear about their notifications. */
  private onNotify(userId: string) {
    for (const s of this.subscribers) if (s.ctx.userId === userId) s.res.write('event: notification\ndata: {}\n\n');
  }

  private async dispatch(ev: ThreadEvent) {
    for (const s of this.subscribers) {
      const visible = await this.prisma.emailThread.findMany({
        where: { AND: [{ id: { in: ev.threadIds } }, await this.access.threadWhere(s.ctx)] },
        select: { id: true },
      });
      if (visible.length) s.res.write(`event: thread.updated\ndata: ${JSON.stringify({ threadIds: visible.map((v) => v.id) })}\n\n`);
    }
  }

  async onModuleDestroy() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const s of this.subscribers) s.res.end();
    this.subscribers.clear();
    const l = await this.listener?.catch(() => null);
    await l?.end().catch(() => undefined);
  }
}
