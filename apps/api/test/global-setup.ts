import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Starts a throwaway real PostgreSQL 17, applies the actual migrations and the seed.
 * Workers inherit DATABASE_URL because they are spawned after this runs.
 */
export default async function setup() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { startLocalPostgres } = require('@crm/localdb');
  // Inside the repo (git-ignored) rather than the OS temp dir, which other tools may clean mid-run.
  const root = path.resolve(__dirname, '../../../.localdb');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'test-pg-'));
  const port = 55000 + Math.floor(Math.random() * 4000);
  const pg = await startLocalPostgres({ dataDir: dir, port, persistent: false });
  await pg.createDatabase('crm_test');
  const url = pg.url('crm_test');
  process.env.DATABASE_URL = url;

  const dbPkg = path.resolve(__dirname, '../../../packages/db');
  const prismaBin = path.resolve(__dirname, '../../../node_modules/prisma/build/index.js');
  execFileSync(process.execPath, [prismaBin, 'migrate', 'deploy'], { cwd: dbPkg, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  execFileSync(process.execPath, ['dist/seed.js'], { cwd: dbPkg, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });

  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
