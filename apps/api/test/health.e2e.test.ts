import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId } from '@crm/crypto';
import type { SystemHealth } from '@crm/shared';
import { SystemHealthService } from '../src/health/system-health.service';
import { FakeClamd } from './fake-storage';
import { bootApp, type Client, clientAs, makeUser, prisma } from './helpers';

/** Phase 10: system health checks, the metrics endpoint and administrator alerts. */
const TOKEN = 'metrics-token-for-tests-0123456789';
let app: INestApplication;
let health: SystemHealthService;
let clamd: FakeClamd;
let admin: Client;
let adminId: string;
const stamp = Date.now().toString(36);

beforeAll(async () => {
  clamd = await new FakeClamd().start();
  ({ app } = await bootApp({ env: { METRICS_TOKEN: TOKEN, CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clamd.port) } }));
  health = app.get(SystemHealthService);
  adminId = (await makeUser({ role: 'SUPER_ADMIN', name: 'Health Admin' })).id;
  admin = await clientAs(app, adminId);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  clamd?.stop();
});

describe('Phase 10: system health', () => {
  it('runs every check; only administrators may see it', async () => {
    const id = newId();
    await prisma.emailAccount.create({ data: { id, provider: 'IMAP', emailAddress: `broken-${stamp}@example.com`, status: 'NEEDS_REAUTH', connectedById: adminId } });
    const r = await admin.get('/system/health');
    expect(r.status).toBe(200);
    const h = r.body as SystemHealth;
    expect(h.checks.map((c) => c.key)).toEqual(['database', 'worker', 'queues', 'mailbox-sync', 'sending', 'reports', 'virus-scan', 'storage']);
    for (const c of h.checks) expect(['ok', 'warn', 'fail']).toContain(c.status);
    expect(h.checks.find((c) => c.key === 'database')!.status).toBe('ok');
    const mail = h.checks.find((c) => c.key === 'mailbox-sync')!;
    expect(mail.status).not.toBe('ok');
    expect(mail.detail).toContain(`broken-${stamp}@example.com`);
    expect(h.checks.find((c) => c.key === 'virus-scan')).toMatchObject({ status: 'ok', detail: 'Scanner answering' });
    // No worker runs in this test process, so the worker check reports it.
    expect(h.checks.find((c) => c.key === 'worker')!.status).toBe('fail');
    await prisma.emailAccount.update({ where: { id }, data: { status: 'DISCONNECTED' } });

    const emp = await clientAs(app, (await makeUser({ role: 'EMPLOYEE' })).id);
    expect((await emp.get('/system/health')).status).toBe(403);
  });

  it('a stopped virus scanner is a failing check', async () => {
    clamd.down = true;
    try {
      const h = await health.run();
      expect(h.checks.find((c) => c.key === 'virus-scan')!.status).toBe('fail');
    } finally {
      clamd.down = false;
    }
  });

  it('metrics: Prometheus text behind a bearer token', async () => {
    const srv = app.getHttpServer();
    expect((await request(srv).get('/api/v1/metrics')).status).toBe(401);
    expect((await request(srv).get('/api/v1/metrics').set('Authorization', 'Bearer wrong-token-wrong-token-xx')).status).toBe(401);
    const ok = await request(srv).get('/api/v1/metrics').set('Authorization', `Bearer ${TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('text/plain');
    expect(ok.text).toMatch(/^crm_check_status\{check="database"\} 0$/m);
    expect(ok.text).toMatch(/^crm_check_value\{check="database"\} \d+$/m);
    expect(ok.text).toMatch(/^crm_up [01]$/m);
  });
});

describe('Phase 10: alerts', () => {
  const fixed = (status: 'ok' | 'warn' | 'fail', detail: string): SystemHealth => ({
    status,
    checkedAt: new Date().toISOString(),
    checks: [{ key: `test-check-${stamp}`, label: 'Test check', status, detail, value: null }],
  });
  const alerts = () => prisma.notification.findMany({ where: { userId: adminId, type: 'SYSTEM_ALERT' }, orderBy: { createdAt: 'asc' } });

  it('tells administrators once per problem, once when it gets worse, and once on recovery', async () => {
    const spy = vi.spyOn(health, 'run');
    spy.mockResolvedValueOnce(fixed('ok', 'fine'));
    await health.alert();
    expect(await alerts()).toHaveLength(0);

    spy.mockResolvedValueOnce(fixed('warn', '2 emails failed'));
    expect((await health.alert()).alerted).toEqual([`test-check-${stamp}`]);
    spy.mockResolvedValueOnce(fixed('warn', '3 emails failed'));
    expect((await health.alert()).alerted).toEqual([]); // same problem: no repeat
    spy.mockResolvedValueOnce(fixed('fail', 'stuck'));
    await health.alert(); // worse
    spy.mockResolvedValueOnce(fixed('warn', 'better'));
    await health.alert(); // improving: no alert
    spy.mockResolvedValueOnce(fixed('ok', 'fine'));
    await health.alert(); // recovered

    const list = await alerts();
    expect(list.map((n) => n.title)).toEqual(['Warning: Test check', 'Problem: Test check', 'Recovered: Test check']);
    expect(list[0]!.body).toBe('2 emails failed');
    expect(list[0]!.data).toMatchObject({ url: '/admin/system' });
    expect(await prisma.systemAlert.findUniqueOrThrow({ where: { key: `test-check-${stamp}` } })).toMatchObject({ status: 'ok' });
    spy.mockRestore();
  });
});
