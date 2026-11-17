// npm run db:local — keeps a persistent dev database running on port 54329 until Ctrl+C.
const path = require('node:path');
const { startLocalPostgres } = require('./index');

(async () => {
  const dataDir = path.resolve(__dirname, '../../.localdb/dev');
  const db = await startLocalPostgres({ dataDir, port: 54329 });
  await db.createDatabase('crm');
  console.log(`PostgreSQL ready: ${db.url('crm')}`);
  const shutdown = async () => {
    await db.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
