// Backup + restore drill (docs/runbooks/backup-restore.md). Runs in CI on every push and can be
// run by hand against any PostgreSQL 17 you can reach with pg_dump / pg_restore 17.
//
//   DRILL_ADMIN_URL=postgresql://postgres:…@host:5432/postgres \
//   DRILL_PG_DUMP="pg_dump" DRILL_PG_RESTORE="pg_restore" \
//   node tools/backup/restore-drill.mts
//
// DRILL_PG_DUMP / DRILL_PG_RESTORE may be a command prefix, e.g. "docker exec -i <container> pg_dump".
// DRILL_TOOL_HOST: host/port as seen by those tools (default the same as DRILL_ADMIN_URL).
//
// 1. Builds a source database like production: the real migrations and seed, owned by a
//    non-superuser app role (so Row-Level Security applies), plus a fixed dataset.
// 2. Backs it up with pg_dump --format=custom --enable-row-security (required: the conversation
//    tables FORCE row-level security, so a plain pg_dump stops with an error).
// 3. Restores into a new, empty database owned by the same role.
// 4. Verifies: every table's row count and an id checksum match, migrations match, RLS policies
//    and functions exist, and RLS still hides conversations from an employee in the restored copy.
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { seedSql } from '../loadtest/seed.mts';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../..');
const pg = require(require.resolve('pg', { paths: [path.join(root, 'apps/api')] }));

const ADMIN = new URL(process.env.DRILL_ADMIN_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres');
const ROLE = 'crm_drill_app';
const PASSWORD = 'drill_password_123';
const SRC = 'crm_drill_source';
const DST = 'crm_drill_restored';
const split = (cmd: string) => cmd.split(' ').filter(Boolean);
const DUMP = split(process.env.DRILL_PG_DUMP ?? 'pg_dump');
const RESTORE = split(process.env.DRILL_PG_RESTORE ?? 'pg_restore');
const toolHost = new URL(process.env.DRILL_TOOL_HOST ? `postgresql://${process.env.DRILL_TOOL_HOST}` : ADMIN.toString());

const appUrl = (db: string, forTools = false) => {
  const u = new URL((forTools ? toolHost : ADMIN).toString());
  u.username = ROLE;
  u.password = PASSWORD;
  u.pathname = `/${db}`;
  return u.toString();
};
const adminDb = (db: string) => {
  const u = new URL(ADMIN.toString());
  u.pathname = `/${db}`;
  return u.toString();
};
async function q(url: string, sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}
const step = (s: string) => console.log(`\n▶ ${s}`);
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push([name, ok, info]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
};
function run(cmd: string[], opts: { input?: string; output?: string }) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd[0]!, cmd.slice(1), { stdio: [opts.input ? 'pipe' : 'ignore', opts.output ? 'pipe' : 'inherit', 'inherit'] });
    if (opts.input) createReadStream(opts.input).pipe(p.stdin!);
    if (opts.output) p.stdout!.pipe(createWriteStream(opts.output));
    p.on('error', reject);
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd.join(' ')} exited with ${c}`))));
  });
}

// ── 1. source ──
step('Source database: real migrations, seed and a fixed dataset, owned by a non-superuser role');
const admin = adminDb('postgres');
for (const db of [SRC, DST]) await q(admin, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
if (!(await q(admin, 'SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE])).rowCount) {
  await q(admin, `CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PASSWORD}'`);
}
await q(admin, `CREATE DATABASE ${SRC} OWNER ${ROLE}`);
await q(adminDb(SRC), `ALTER SCHEMA public OWNER TO ${ROLE}`);
const env = { ...process.env, DATABASE_URL: appUrl(SRC) };
execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], { cwd: path.join(root, 'packages/db'), env, stdio: 'pipe' });
execFileSync(process.execPath, ['dist/seed.js'], { cwd: path.join(root, 'packages/db'), env, stdio: 'pipe' });
await q(appUrl(SRC), seedSql({ domain: 'drill.example', users: 100, mailboxes: 10, threads: 5000, days: 7 }));
await q(appUrl(SRC), `INSERT INTO thread_shares ("threadId", "userId", "sharedById", "createdAt") VALUES ('lt-th-2', 'lt-user-31', 'lt-user-1', now())`);

// ── 2. backup ──
step('Backup: pg_dump --format=custom --enable-row-security');
const dir = mkdtempSync(path.join(tmpdir(), 'crm-drill-'));
const file = path.join(dir, 'crm.dump');
const t0 = performance.now();
await run([...DUMP, '--format=custom', '--enable-row-security', '--no-owner', '--no-privileges', `--dbname=${appUrl(SRC, true)}`], { output: file });
const dumpSec = (performance.now() - t0) / 1000;
check('backup written', statSync(file).size > 10_000, `${(statSync(file).size / 1024).toFixed(0)} KB in ${dumpSec.toFixed(1)} s`);

// ── 3. restore ──
step('Restore into a new, empty database');
await q(admin, `CREATE DATABASE ${DST} OWNER ${ROLE}`);
await q(adminDb(DST), `ALTER SCHEMA public OWNER TO ${ROLE}`);
const t1 = performance.now();
await run([...RESTORE, '--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${appUrl(DST, true)}`], { input: file });
const restoreSec = (performance.now() - t1) / 1000;
check('restore completed', true, `${restoreSec.toFixed(1)} s`);

// ── 4. verify ──
step('Verify the restored copy');
const tables = (await q(appUrl(SRC), `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r: { tablename: string }) => r.tablename);
// The table owner reads everything (no app.user_id set = trusted session, like the worker).
const countsOf = async (db: string) => {
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number((await q(appUrl(db), `SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n);
  return out;
};
const [a, b] = await Promise.all([countsOf(SRC), countsOf(DST)]);
const diffs = tables.filter((t) => a[t] !== b[t]);
check(`row counts of all ${tables.length} tables match`, diffs.length === 0, diffs.length ? diffs.map((t) => `${t}: ${a[t]} vs ${b[t]}`).join(', ') : `${Object.values(a).reduce((x, y) => x + y, 0).toLocaleString()} rows`);
for (const t of ['email_threads', 'email_messages', 'users', 'audit_logs', '_prisma_migrations']) {
  const sum = async (db: string) => (await q(appUrl(db), `SELECT md5(string_agg(id::text, ',' ORDER BY id)) AS h FROM "${t}"`)).rows[0].h;
  check(`${t}: id checksum matches`, (await sum(SRC)) === (await sum(DST)));
}
const policies = async (db: string) => Number((await q(appUrl(db), `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`)).rows[0].n);
check('row-level security policies restored', (await policies(DST)) === (await policies(SRC)) && (await policies(DST)) >= 20, `${await policies(DST)} policies`);
const forced = Number((await q(appUrl(DST), `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('email_threads','email_messages','attachments','internal_notes','ai_summaries') AND relrowsecurity AND relforcerowsecurity`)).rows[0].n);
check('RLS enabled and forced on the 5 content tables', forced === 5);
const visible = async (db: string, user: string, scope: string) => {
  const c = new pg.Client({ connectionString: appUrl(db) });
  await c.connect();
  await c.query('BEGIN');
  await c.query(`SELECT set_config('app.user_id', $1, true), set_config('app.thread_scope', $2, true), set_config('app.system', '', true)`, [user, scope]);
  const n = Number((await c.query(`SELECT count(*)::int AS n FROM email_threads`)).rows[0].n);
  await c.query('ROLLBACK');
  await c.end();
  return n;
};
const all = b.email_threads!;
const empSrc = await visible(SRC, 'lt-user-31', 'ASSIGNED');
const empDst = await visible(DST, 'lt-user-31', 'ASSIGNED');
check('RLS works in the restored copy: an employee sees only their conversations', empDst === empSrc && empDst > 0 && empDst < all, `${empDst} of ${all}`);
check('RLS works in the restored copy: an admin sees everything', (await visible(DST, 'lt-user-1', 'ALL')) === all);

rmSync(dir, { recursive: true, force: true });
for (const db of [SRC, DST]) await q(admin, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed · backup ${dumpSec.toFixed(1)} s · restore ${restoreSec.toFixed(1)} s`);
process.exit(failed ? 1 : 0);
