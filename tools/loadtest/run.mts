// Phase 10 load test (docs/runbooks/load-test.md).
//
//   node --env-file=.env tools/loadtest/run.mts            (needs `npm run db:local` and `npm run build`)
//
// 1. Creates (once) the database `crm_load` on the local cluster, migrates and seeds it with the
//    target scale: 50 mailboxes × 2,000 emails/day (LOAD_DAYS days, default 2), 100 employees in
//    10 departments and teams with mailbox grants, realistic status/assignment mix.
// 2. Starts the production builds of the API (Postgres RLS on) and the worker in a child process.
// 3. 100 signed-in employees (admins, managers, team leaders, staff) use the inbox at the same time
//    for LOAD_SECONDS (default 60): list, counts, open a conversation, sometimes search.
// 4. Meanwhile new mail arrives at an IMAP mailbox every 10 s; we time until it is visible in the
//    inbox through the API.
// Prints p50/p95/p99 per request type and the SLOs: inbox list p95 < 300 ms, new mail < 60 s.
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { seedSql } from './seed.mts';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../..');
const pg = require(require.resolve('pg', { paths: [path.join(root, 'apps/api')] }));
const { execFileSync } = require('node:child_process');

const DAYS = Number(process.env.LOAD_DAYS ?? 2);
const PER_DAY = 2000;
const MAILBOXES = 50;
const USERS = 100;
/** Concurrent employees (default all 100). */
const VUS = Number(process.env.LOAD_VUS ?? USERS);
const SECONDS = Number(process.env.LOAD_SECONDS ?? 60);
/** Pause between one employee's actions, ms (default 2–8 s: reading a mail, typing). LOAD_THINK_MS=100-500 is a stress test. */
const [THINK_MIN, THINK_MAX] = (process.env.LOAD_THINK_MS ?? '2000-8000').split('-').map(Number) as [number, number];
const THREADS = Math.round((MAILBOXES * PER_DAY * DAYS) / 2); // ~2 messages per conversation

const devUrl = new URL(process.env.DATABASE_URL!);
const adminUrl = new URL(devUrl);
adminUrl.username = 'crm'; // the cluster's bootstrap superuser (tools/localdb), only for CREATE DATABASE
const loadUrl = new URL(devUrl);
loadUrl.pathname = '/crm_load';
const LOAD_DB = loadUrl.toString();

async function q(url: string, sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

// ── 1. database ──
const exists = (await q(adminUrl.toString().replace(/\/[^/]*$/, '/postgres'), 'SELECT 1 FROM pg_database WHERE datname = $1', ['crm_load'])).rowCount;
if (!exists) await q(adminUrl.toString().replace(/\/[^/]*$/, '/postgres'), `CREATE DATABASE crm_load OWNER ${devUrl.username}`);
const env = { ...process.env, DATABASE_URL: LOAD_DB };
execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], { cwd: path.join(root, 'packages/db'), env, stdio: 'pipe' });
execFileSync(process.execPath, ['dist/seed.js'], { cwd: path.join(root, 'packages/db'), env, stdio: 'pipe' });

const domain = (process.env.ALLOWED_LOGIN_DOMAINS ?? 'seodiscovery.com').split(',')[0]!.trim();
const seeded = Number((await q(LOAD_DB, `SELECT count(*)::int AS n FROM email_threads WHERE id LIKE 'lt-th-%'`)).rows[0].n);
if (seeded !== THREADS) {
  console.log(`Seeding ${THREADS.toLocaleString()} conversations / ${(THREADS * 2).toLocaleString()} messages …`);
  const t0 = performance.now();
  const sql = seedSql({ domain, users: USERS, mailboxes: MAILBOXES, threads: THREADS, days: DAYS });
  const c = new pg.Client({ connectionString: LOAD_DB });
  await c.connect();
  await c.query(sql);
  await c.end();
  console.log(`  seeded in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}

// Mailboxes of earlier runs point at IMAP hosts that no longer exist.
await q(LOAD_DB, `UPDATE email_accounts SET status = 'DISCONNECTED' WHERE "emailAddress" LIKE 'load.idle.%' AND status <> 'DISCONNECTED'`);

// ── 2. server ──
const imapAddress = `load.idle.${Date.now().toString(36)}@client-host.example`;
const child = fork(path.join(import.meta.dirname, 'server.mts'), [], {
  env: { ...env, LOAD_API_PORT: '4100', LOAD_IMAP_ADDRESS: imapAddress, RATE_LIMIT_PER_IP_PER_MIN: '1000000', RATE_LIMIT_PER_USER_PER_MIN: '100000', APP_URL: 'http://localhost:4100' },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  // Diagnosis: LOAD_CPU_PROF=<dir> writes a CPU profile of the API process.
  execArgv: process.env.LOAD_CPU_PROF ? ['--cpu-prof', `--cpu-prof-dir=${process.env.LOAD_CPU_PROF}`] : [],
});
const ready = await new Promise<{ imap: Record<string, unknown>; port: number }>((resolve, reject) => {
  child.once('message', (m) => resolve(m as never));
  child.once('exit', (c) => reject(new Error(`server exited ${c}`)));
});
const API = `http://127.0.0.1:${ready.port}/api/v1`;
const diag: { cpu: number; loopP99: number; serverP95: number; served: number }[] = [];
child.on('message', (m: { diag?: { cpu: number; loopP99: number; serverP95: number; served: number } }) => m.diag && diag.push(m.diag));
const dbSamples: { active: number; waiting: number; idletx: number; total: number }[] = [];

const { randomBytes, createHash } = await import('node:crypto');
async function session(userId: string) {
  const token = randomBytes(32).toString('base64url');
  await q(LOAD_DB, `INSERT INTO sessions (id, "userId", "tokenHash", "authMethod", "expiresAt", "createdAt", "lastSeenAt") VALUES ($1, $2, $3, 'load-test', now() + interval '2 hours', now(), now())`, [
    `lt-s-${randomBytes(8).toString('hex')}`,
    userId,
    createHash('sha256').update(token).digest('hex'),
  ]);
  const csrf = randomBytes(16).toString('hex');
  return { cookie: `crm_session=${token}; crm_csrf=${csrf}`, csrf };
}
const sessions = await Promise.all(Array.from({ length: USERS }, (_, i) => session(`lt-user-${i + 1}`)));
const call = async (s: { cookie: string; csrf: string }, method: string, p: string, body?: unknown) => {
  const res = await fetch(`${API}${p}`, { method, headers: { cookie: s.cookie, origin: 'http://localhost:4100', 'x-csrf-token': s.csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

// Connect the IMAP mailbox (as the first admin) and grant it to everyone in department 1.
const admin = sessions[0]!;
const conn = await call(admin, 'POST', '/accounts/imap', { ...ready.imap, displayName: 'Load IDLE box', departmentId: 'lt-dept-1', syncDays: 1 });
if (conn.status !== 201) throw new Error(`IMAP connect failed: ${conn.status} ${JSON.stringify(conn.json)}`);
for (let i = 0; i < 80 && (await q(LOAD_DB, `SELECT status FROM email_accounts WHERE id = $1`, [conn.json.id])).rows[0].status !== 'ACTIVE'; i++) await new Promise((r) => setTimeout(r, 250));
await new Promise((r) => setTimeout(r, 3000)); // IDLE supervisor picks the mailbox up

// The worker rebuilds the last two days of report figures when it starts; measure the inbox
// after that (its hourly repeat is measured separately: LOAD_WITH_ROLLUP=1 skips this wait).
if (!process.env.LOAD_WITH_ROLLUP) {
  const since = new Date(Date.now() - 120_000);
  for (let i = 0; i < 240; i++) {
    const r = await q(LOAD_DB, `SELECT count(*)::int AS n FROM analytics_runs WHERE kind = 'settle' AND "finishedAt" > $1`, [since]);
    if (r.rows[0].n > 0) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

// ── 3. load ──
type Kind = 'list' | 'counts' | 'detail' | 'search' | 'me';
const lat: Record<Kind, number[]> = { list: [], counts: [], detail: [], search: [], me: [] };
/** Diagnosis: LOAD_ONLY=me|list|counts runs just that request. */
const ONLY = process.env.LOAD_ONLY as Kind | undefined;
const errors: Record<string, number> = {};
/** List latency per view × role group, to find slow combinations. */
const byView: Record<string, number[]> = {};
const groupOf = (i: number) => (i < 2 ? 'admin' : i < 12 ? 'manager' : i < 22 ? 'leader' : 'staff');
/** The first seconds warm up the server (JIT, database connections) and are not counted. */
const WARMUP_MS = Number(process.env.LOAD_WARMUP_S ?? 15) * 1000;
const measureFrom = Date.now() + WARMUP_MS;
const end = Date.now() + WARMUP_MS + SECONDS * 1000;
async function vu(i: number) {
  const s = sessions[i]!;
  let ids: string[] = [];
  while (Date.now() < end) {
    const roll = Math.random();
    const kind: Kind = ONLY ?? (roll < 0.45 ? 'list' : roll < 0.65 ? 'counts' : roll < 0.95 && ids.length ? 'detail' : roll < 0.95 ? 'list' : 'search');
    const view = ['inbox', 'mine', 'pending', 'unassigned'][Math.floor(Math.random() * 4)];
    const p = kind === 'me' ? '/auth/me' : kind === 'list' ? `/threads?view=${view}&limit=50` : kind === 'counts' ? '/threads/counts' : kind === 'detail' ? `/threads/${ids[Math.floor(Math.random() * ids.length)]}` : `/threads?view=all&q=proposal+${Math.floor(Math.random() * 1000)}`;
    const t0 = performance.now();
    const r = await call(s, 'GET', p).catch((e) => ({ status: 0, json: String(e) }) as const);
    const counted = Date.now() >= measureFrom;
    if (counted) lat[kind].push(performance.now() - t0);
    if (counted && kind === 'list') (byView[`${view}/${groupOf(i)}`] ??= []).push(performance.now() - t0);
    if (r.status !== 200 && counted) errors[`${kind}:${r.status}`] = (errors[`${kind}:${r.status}`] ?? 0) + 1;
    if (kind === 'list' && r.status === 200) ids = (r.json.items as { id: string }[]).map((t) => t.id).slice(0, 20);
    await new Promise((res) => setTimeout(res, THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN)));
  }
}

// New mail visibility, measured through the API as the first admin.
const visibility: number[] = [];
async function newMail() {
  let n = 0;
  while (Date.now() < end - 5000) {
    const mid = `<load.${Date.now()}.${n++}@client.example>`;
    const subject = `Load arrival ${n} ${Date.now().toString(36)}`;
    const t0 = Date.now();
    child.send({ deliver: { messageId: mid, subject } });
    for (;;) {
      const r = await call(admin, 'GET', `/threads?view=all&accountId=${conn.json.id}&limit=5`);
      if (r.status === 200 && (r.json.items as { subject: string }[]).some((t) => t.subject === subject)) {
        visibility.push((Date.now() - t0) / 1000);
        break;
      }
      if (Date.now() - t0 > 120_000) {
        visibility.push(Infinity);
        break;
      }
      await new Promise((res) => setTimeout(res, 250));
    }
    await new Promise((res) => setTimeout(res, 10_000));
  }
}

const sampler = setInterval(async () => {
  const r = await q(LOAD_DB, `SELECT count(*) FILTER (WHERE state = 'active')::int AS active, count(*) FILTER (WHERE wait_event_type IN ('Lock', 'LWLock', 'IO'))::int AS waiting, count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS idletx, count(*)::int AS total FROM pg_stat_activity WHERE datname = 'crm_load' AND pid <> pg_backend_pid()`).catch(() => null);
  if (r) dbSamples.push(r.rows[0]);
  if (process.env.LOAD_DIAG) {
    const slow = await q(LOAD_DB, `SELECT round(extract(epoch from now() - query_start) * 1000)::int AS ms, regexp_replace(left(query, 160), '\s+', ' ', 'g') AS sql FROM pg_stat_activity WHERE datname = 'crm_load' AND state = 'active' AND pid <> pg_backend_pid() ORDER BY query_start LIMIT 3`).catch(() => null);
    for (const row of slow?.rows ?? []) if (row.ms > 500) console.log(`  slow ${row.ms} ms: ${row.sql}`);
  }
}, 2000);
console.log(`Load: ${VUS} employees (pause ${THINK_MIN}–${THINK_MAX} ms between actions) for ${SECONDS} s against ${THREADS.toLocaleString()} conversations (RLS on) …`);
const t0 = performance.now();
const mail = newMail();
await Promise.all(Array.from({ length: VUS }, (_, i) => vu(i)));
const elapsed = (performance.now() - t0) / 1000 - WARMUP_MS / 1000;
await mail;
clearInterval(sampler);

// ── 4. report ──
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const total = Object.values(lat).reduce((n, l) => n + l.length, 0);
console.log(`\n${total.toLocaleString()} requests in ${elapsed.toFixed(0)} s (${(total / elapsed).toFixed(0)}/s)`);
console.log('request        count     p50      p95      p99');
for (const [k, l] of Object.entries(lat)) console.log(`${k.padEnd(12)} ${String(l.length).padStart(7)} ${pct(l, 50).toFixed(0).padStart(6)} ms ${pct(l, 95).toFixed(0).padStart(6)} ms ${pct(l, 99).toFixed(0).padStart(6)} ms`);
const avgOf = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
console.log(`server process: CPU avg ${avgOf(diag.map((d) => d.cpu))}% of one core (max ${Math.max(0, ...diag.map((d) => d.cpu))}%), event-loop delay p99 max ${Math.max(0, ...diag.map((d) => d.loopP99))} ms, server-side p95 per 5 s: ${diag.map((d) => d.serverP95).join(', ')} ms`);
console.log(`database: active queries avg ${avgOf(dbSamples.map((d) => d.active))} (max ${Math.max(0, ...dbSamples.map((d) => d.active))}), waiting on locks/IO max ${Math.max(0, ...dbSamples.map((d) => d.waiting))}, idle in transaction avg ${avgOf(dbSamples.map((d) => d.idletx))}, connections max ${Math.max(0, ...dbSamples.map((d) => d.total))}`);
if (process.env.LOAD_DIAG) for (const [k, l] of Object.entries(byView).sort()) console.log(`  list ${k.padEnd(22)} n=${String(l.length).padStart(4)} p50 ${pct(l, 50).toFixed(0)} ms p95 ${pct(l, 95).toFixed(0)} ms`);
console.log(`errors: ${Object.keys(errors).length ? JSON.stringify(errors) : 'none'}`);
console.log(`new mail visible after: ${visibility.map((v) => `${v.toFixed(1)} s`).join(', ')}`);
const listP95 = pct(lat.list, 95);
const worstNew = Math.max(...visibility);
console.log(`\nSLO inbox list p95 < 300 ms: ${listP95 < 300 ? 'PASS' : 'FAIL'} (${listP95.toFixed(0)} ms)`);
console.log(`SLO new mail visible < 60 s: ${worstNew < 60 ? 'PASS' : 'FAIL'} (worst ${worstNew.toFixed(1)} s)`);
child.send({ stop: true });
await new Promise((r) => child.once('exit', r));
process.exit(listP95 < 300 && worstNew < 60 && !Object.keys(errors).length ? 0 : 1);
