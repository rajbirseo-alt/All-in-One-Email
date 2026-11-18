import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Response } from 'express';
import { Client } from 'pg';
import { Prisma } from '@crm/db';
import { AccessPolicy } from '../access/access-policy.service';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';

export const EVENTS_CHANNEL = 'crm_events';
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
        if (n.channel !== EVENTS_CHANNEL || !n.payload) return;
        try {
          void this.dispatch(JSON.parse(n.payload) as ThreadEvent);
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
      return client;
    })();
    return this.listener;
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
