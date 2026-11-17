// Starts a real PostgreSQL 17 server from npm-packaged binaries (no Docker needed).
// Used by `npm run db:local` for development and by the API e2e tests.
const path = require('node:path');
const fs = require('node:fs');
const EmbeddedPostgres = require('embedded-postgres').default;

/**
 * @param {{ dataDir: string, port: number, persistent?: boolean }} opts
 * @returns {Promise<{ url: (db: string) => string, createDatabase: (db: string) => Promise<void>, stop: () => Promise<void> }>}
 */
async function startLocalPostgres({ dataDir, port, persistent = true }) {
  const user = 'crm';
  const password = 'crm_local_dev';
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent,
    onLog: () => {},
    onError: (e) => process.stderr.write(String(e)),
  });
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    await pg.initialise();
  }
  await pg.start();
  return {
    url: (db) => `postgresql://${user}:${password}@localhost:${port}/${db}`,
    async createDatabase(db) {
      try {
        await pg.createDatabase(db);
      } catch (e) {
        if (!/already exists/.test(String(e?.message ?? e))) throw e;
      }
    },
    stop: () => pg.stop(),
  };
}

module.exports = { startLocalPostgres };
