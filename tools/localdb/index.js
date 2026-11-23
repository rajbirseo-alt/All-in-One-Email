// Starts a real PostgreSQL 17 server from npm-packaged binaries (no Docker needed).
// Used by `npm run db:local` for development and by the API e2e tests.
const path = require('node:path');
const fs = require('node:fs');
const EmbeddedPostgres = require('embedded-postgres').default;

/** The role the app connects as: owns its databases but is not a superuser, like Render's user, so Row-Level Security applies. */
const APP_ROLE = 'crm_app';

/**
 * @param {{ dataDir: string, port: number, persistent?: boolean }} opts
 * @returns {Promise<{ url: (db: string) => string, adminUrl: (db: string) => string, createDatabase: (db: string) => Promise<void>, stop: () => Promise<void> }>}
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
  const admin = async (db, fn) => {
    const c = pg.getPgClient(db, 'localhost');
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  await admin('postgres', async (c) => {
    const { rowCount } = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    if (!rowCount) await c.query(`CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB PASSWORD '${password}'`);
  });
  return {
    url: (db) => `postgresql://${APP_ROLE}:${password}@localhost:${port}/${db}`,
    adminUrl: (db) => `postgresql://${user}:${password}@localhost:${port}/${db}`,
    async createDatabase(db) {
      try {
        await pg.createDatabase(db);
      } catch (e) {
        if (!/already exists/.test(String(e?.message ?? e))) throw e;
      }
      // The app role owns the database and everything in it (databases made before this change too).
      await admin('postgres', (c) => c.query(`ALTER DATABASE "${db}" OWNER TO ${APP_ROLE}`));
      await admin(db, async (c) => {
        await c.query(`ALTER SCHEMA public OWNER TO ${APP_ROLE}`);
        const { rows } = await c.query(`
          SELECT format('ALTER %s %s OWNER TO ${APP_ROLE}', CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' ELSE 'TABLE' END, c.oid::regclass) AS sql
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S', 'v', 'p') AND pg_get_userbyid(c.relowner) <> '${APP_ROLE}'
          UNION ALL
          SELECT format('ALTER FUNCTION %s OWNER TO ${APP_ROLE}', p.oid::regprocedure) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> '${APP_ROLE}' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
          UNION ALL
          SELECT format('ALTER TYPE %s OWNER TO ${APP_ROLE}', t.oid::regtype) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'public' AND t.typtype = 'e' AND pg_get_userbyid(t.typowner) <> '${APP_ROLE}'`);
        for (const r of rows) await c.query(r.sql);
      });
    },
    stop: () => pg.stop(),
  };
}

module.exports = { startLocalPostgres };
