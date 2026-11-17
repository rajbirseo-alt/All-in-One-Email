import { loadConfig } from './config/config';
import { createApp } from './create-app';

async function main() {
  const cfg = loadConfig();
  const app = await createApp(cfg);
  await app.listen(cfg.PORT, '0.0.0.0');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
