import { Inject, Injectable, Logger } from '@nestjs/common';
import { connect } from 'node:net';
import type { HealthCheck, SystemHealth } from '@crm/shared';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUES } from '../mail/queue.service';

/** Thresholds (docs/runbooks/monitoring.md). */
export const HEALTH_LIMITS = {
  /** A connected mailbox whose last successful sync is older than this is lagging (poll runs every 5 min). */
  syncLagWarnSec: 15 * 60,
  syncLagFailSec: 60 * 60,
  /** The worker runs the SLA sweep every minute; no completed sweep for this long = worker down. */
  workerSilentFailSec: 5 * 60,
  /** Jobs waiting longer than this. */
  queueWaitWarnSec: 10 * 60,
  queueWaitFailSec: 30 * 60,
  /** Report figures older than this. */
  analyticsStaleWarnSec: 2 * 3600,
  dbLatencyWarnMs: 500,
} as const;

const worst = (a: HealthCheck['status'], b: HealthCheck['status']) => (a === 'fail' || b === 'fail' ? 'fail' : a === 'warn' || b === 'warn' ? 'warn' : 'ok');
const mins = (s: number) => (s < 120 ? `${Math.round(s)} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

/**
 * The checks behind Admin → System health, the /metrics endpoint and the alert job: database,
 * background worker, queues, mailbox sync, sending, reports, virus scanner and storage.
 */
@Injectable()
export class SystemHealthService {
  private readonly log = new Logger(SystemHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly notifications: NotificationsService,
  ) {}

  async run(now = new Date()): Promise<SystemHealth> {
    const checks = await Promise.all([this.database(), this.worker(now), this.queues(now), this.mailboxes(now), this.sending(now), this.reports(now), this.scanner(), this.storage()]);
    const flat = checks.flat();
    return { status: flat.reduce((s, c) => worst(s, c.status), 'ok' as HealthCheck['status']), checkedAt: now.toISOString(), checks: flat };
  }

  private async safe(key: string, label: string, fn: () => Promise<HealthCheck>): Promise<HealthCheck> {
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error).message;
      // The job tables are created by pg-boss when the worker (or the API's first enqueue) starts.
      if (/relation "pgboss\.[a-z_]+" does not exist/.test(msg)) {
        return { key, label, status: 'fail', detail: 'The background worker has never started on this database (no job tables yet). Check the crm-worker service.', value: null };
      }
      return { key, label, status: 'fail', detail: `Check failed: ${msg.slice(0, 200)}`, value: null };
    }
  }

  private database() {
    return this.safe('database', 'Database', async () => {
      const t0 = Date.now();
      await this.prisma.$queryRaw`SELECT 1`;
      const ms = Date.now() - t0;
      return { key: 'database', label: 'Database', status: ms > HEALTH_LIMITS.dbLatencyWarnMs ? 'warn' : 'ok', detail: `Responding in ${ms} ms`, value: ms };
    });
  }

  /** The SLA sweep completes every minute while the worker is up. */
  private worker(now: Date) {
    return this.safe('worker', 'Background worker', async () => {
      const [r] = await this.prisma.$queryRaw<{ last: Date | null }[]>`SELECT max(completed_on) AS last FROM pgboss.job WHERE name = ${QUEUES.slaSweep} AND state = 'completed'`;
      const age = r?.last ? (now.getTime() - r.last.getTime()) / 1000 : null;
      if (age === null) return { key: 'worker', label: 'Background worker', status: 'fail', detail: 'No sign of the worker yet (no scheduled job has completed)', value: null };
      return {
        key: 'worker',
        label: 'Background worker',
        status: age > HEALTH_LIMITS.workerSilentFailSec ? 'fail' : 'ok',
        detail: age > HEALTH_LIMITS.workerSilentFailSec ? `Silent for ${mins(age)}: mail sync, sending and SLA alerts are stopped` : `Last scheduled job ${mins(age)} ago`,
        value: Math.round(age),
      };
    });
  }

  private queues(now: Date) {
    return this.safe('queues', 'Job queues', async () => {
      const rows = await this.prisma.$queryRaw<{ name: string; waiting: number; oldest: Date | null; failed: number }[]>`
        SELECT name,
               count(*) FILTER (WHERE state IN ('created', 'retry') AND start_after <= now())::int AS waiting,
               min(created_on) FILTER (WHERE state IN ('created', 'retry') AND start_after <= now()) AS oldest,
               count(*) FILTER (WHERE state = 'failed' AND completed_on > now() - interval '1 hour')::int AS failed
        FROM pgboss.job GROUP BY name`;
      const waiting = rows.reduce((n, r) => n + r.waiting, 0);
      const failed = rows.reduce((n, r) => n + r.failed, 0);
      const oldest = rows.reduce((m, r) => (r.oldest && (!m || r.oldest < m) ? r.oldest : m), null as Date | null);
      const wait = oldest ? (now.getTime() - oldest.getTime()) / 1000 : 0;
      const status = wait > HEALTH_LIMITS.queueWaitFailSec ? 'fail' : wait > HEALTH_LIMITS.queueWaitWarnSec || failed > 0 ? 'warn' : 'ok';
      const slow = rows.filter((r) => r.oldest && (now.getTime() - r.oldest.getTime()) / 1000 > HEALTH_LIMITS.queueWaitWarnSec).map((r) => r.name);
      return {
        key: 'queues',
        label: 'Job queues',
        status,
        detail: `${waiting} waiting${waiting ? `, oldest ${mins(wait)}` : ''}${failed ? `; ${failed} failed in the last hour` : ''}${slow.length ? ` (slow: ${slow.join(', ')})` : ''}`,
        value: Math.round(wait),
      };
    });
  }

  private mailboxes(now: Date) {
    return this.safe('mailbox-sync', 'Mailbox sync', async () => {
      const accounts = await this.prisma.emailAccount.findMany({ where: { purgedAt: null, status: { not: 'DISCONNECTED' } }, select: { emailAddress: true, status: true, lastSuccessAt: true } });
      const broken = accounts.filter((a) => a.status === 'NEEDS_REAUTH' || a.status === 'ERROR');
      const active = accounts.filter((a) => a.status === 'ACTIVE');
      const lags = active.map((a) => ({ a, lag: a.lastSuccessAt ? (now.getTime() - a.lastSuccessAt.getTime()) / 1000 : Infinity }));
      const max = lags.reduce((m, l) => Math.max(m, l.lag), 0);
      const lagging = lags.filter((l) => l.lag > HEALTH_LIMITS.syncLagWarnSec).map((l) => l.a.emailAddress);
      const status = max > HEALTH_LIMITS.syncLagFailSec ? 'fail' : broken.length || lagging.length ? 'warn' : 'ok';
      const parts = [`${active.length} active`];
      if (broken.length) parts.push(`${broken.length} need attention (${broken.map((b) => b.emailAddress).slice(0, 3).join(', ')})`);
      if (lagging.length) parts.push(`${lagging.length} behind (${lagging.slice(0, 3).join(', ')})`);
      else if (active.length) parts.push(`slowest last synced ${mins(max)} ago`);
      return { key: 'mailbox-sync', label: 'Mailbox sync', status, detail: parts.join('; '), value: Number.isFinite(max) ? Math.round(max) : null };
    });
  }

  private sending(now: Date) {
    return this.safe('sending', 'Sending', async () => {
      const [failed, stuck] = await Promise.all([
        this.prisma.draft.count({ where: { status: 'FAILED', updatedAt: { gte: new Date(now.getTime() - 86_400_000) } } }),
        this.prisma.draft.count({ where: { status: { in: ['QUEUED', 'SENDING'] }, updatedAt: { lt: new Date(now.getTime() - 15 * 60_000) } } }),
      ]);
      return {
        key: 'sending',
        label: 'Sending',
        status: stuck ? 'fail' : failed ? 'warn' : 'ok',
        detail: stuck ? `${stuck} emails waiting more than 15 min to go out` : failed ? `${failed} emails failed to send in the last 24 h` : 'No failed or stuck emails',
        value: stuck + failed,
      };
    });
  }

  private reports(now: Date) {
    return this.safe('reports', 'Report figures', async () => {
      const last = await this.prisma.analyticsRun.findFirst({ where: { finishedAt: { not: null }, error: null }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } });
      const age = last?.finishedAt ? (now.getTime() - last.finishedAt.getTime()) / 1000 : null;
      return {
        key: 'reports',
        label: 'Report figures',
        status: age === null || age > HEALTH_LIMITS.analyticsStaleWarnSec ? 'warn' : 'ok',
        detail: age === null ? 'Not built yet' : `Updated ${mins(age)} ago`,
        value: age === null ? null : Math.round(age),
      };
    });
  }

  private async scanner(): Promise<HealthCheck> {
    if (!this.cfg.CLAMAV_HOST) {
      return { key: 'virus-scan', label: 'Virus scanning', status: this.cfg.isProd ? 'warn' : 'ok', detail: 'Off (CLAMAV_HOST is not set): attachments are not scanned', value: null };
    }
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect({ host: this.cfg.CLAMAV_HOST!, port: this.cfg.CLAMAV_PORT });
      let reply = '';
      s.setTimeout(5000, () => (s.destroy(), resolve(false)));
      s.on('error', () => resolve(false));
      s.on('connect', () => s.write('zPING\0'));
      s.on('data', (d) => {
        reply += d.toString();
        if (reply.includes('PONG')) (s.destroy(), resolve(true));
      });
      s.on('end', () => resolve(reply.includes('PONG')));
    });
    return { key: 'virus-scan', label: 'Virus scanning', status: ok ? 'ok' : 'fail', detail: ok ? 'Scanner answering' : 'Scanner not answering: uploads and downloads of attachments are refused', value: ok ? 1 : 0 };
  }

  private async storage(): Promise<HealthCheck> {
    return this.cfg.S3_BUCKET
      ? { key: 'storage', label: 'Attachment storage', status: 'ok', detail: `Object storage (${this.cfg.S3_BUCKET}), encrypted`, value: null }
      : { key: 'storage', label: 'Attachment storage', status: 'ok', detail: 'Uploads in the database; received files fetched from the mailbox', value: null };
  }

  /**
   * Alert job (worker, every 5 minutes): tells active Super Admins once when a check goes wrong
   * or gets worse, and once when it recovers. State lives in system_alerts, so restarts and
   * parallel workers do not repeat alerts.
   */
  async alert(now = new Date()) {
    const h = await this.run(now);
    const admins = await this.prisma.user.findMany({ where: { status: 'ACTIVE', role: { key: 'SUPER_ADMIN' } }, select: { id: true } });
    const sent: string[] = [];
    for (const c of h.checks) {
      const prev = await this.prisma.systemAlert.findUnique({ where: { key: c.key } });
      const prevStatus = prev?.status ?? 'ok';
      if (prevStatus === c.status) {
        if (prev && prev.detail !== c.detail) await this.prisma.systemAlert.update({ where: { key: c.key }, data: { detail: c.detail } });
        continue;
      }
      // Claim the transition (only one worker notifies).
      const claimed = prev
        ? (await this.prisma.systemAlert.updateMany({ where: { key: c.key, status: prevStatus }, data: { status: c.status, detail: c.detail, since: now, notifiedAt: now } })).count === 1
        : await this.prisma.systemAlert
            .create({ data: { key: c.key, status: c.status, detail: c.detail, since: now, notifiedAt: now } })
            .then(() => true)
            .catch(() => false);
      if (!claimed) continue;
      const recovered = c.status === 'ok';
      const worse = !recovered && (prevStatus === 'ok' || c.status === 'fail');
      if (!recovered && !worse) continue; // fail → warn: improving, no alert
      await this.notifications.notify(
        admins.map((a) => ({
          userId: a.id,
          type: 'SYSTEM_ALERT' as const,
          title: recovered ? `Recovered: ${c.label}` : `${c.status === 'fail' ? 'Problem' : 'Warning'}: ${c.label}`,
          body: c.detail,
          url: '/admin/system',
        })),
      );
      sent.push(c.key);
      this.log.warn(`Health ${c.key}: ${prevStatus} → ${c.status} (${c.detail})`);
    }
    return { status: h.status, alerted: sent };
  }

  /** Prometheus text format for an external monitor. */
  prometheus(h: SystemHealth) {
    const rank = { ok: 0, warn: 1, fail: 2 } as const;
    const lines = ['# HELP crm_check_status 0 = ok, 1 = warning, 2 = failing', '# TYPE crm_check_status gauge'];
    for (const c of h.checks) lines.push(`crm_check_status{check="${c.key}"} ${rank[c.status]}`);
    lines.push('# HELP crm_check_value Measured value of each check (seconds, counts or ms; see the runbook)', '# TYPE crm_check_value gauge');
    for (const c of h.checks) if (c.value !== null) lines.push(`crm_check_value{check="${c.key}"} ${c.value}`);
    lines.push('# TYPE crm_up gauge', `crm_up ${rank[h.status] < 2 ? 1 : 0}`);
    return lines.join('\n') + '\n';
  }
}
