import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from './config/config';
import { MailWorkerService } from './mail/mail-worker.service';
import { WorkerModule } from './worker.module';

/** Entry point of the background worker (Render: crm-worker). */
async function main() {
  const cfg = loadConfig();
  const app = await NestFactory.createApplicationContext(WorkerModule.register(cfg), {
    logger: new ConsoleLogger({ json: cfg.isProd }),
  });
  // SIGTERM (deploys) → Nest closes providers → QueueService stops pg-boss gracefully.
  app.enableShutdownHooks();
  await app.get(MailWorkerService).start();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
