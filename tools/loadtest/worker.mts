// Load-test worker process: the production worker build, with the fake mail endpoints of the
// server process (so it can reach the local IMAP host). Started by server.mts.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadConfig } = require('../../apps/api/dist/config/config.js');
const { WorkerModule } = require('../../apps/api/dist/worker.module.js');
const { MailWorkerService } = require('../../apps/api/dist/mail/mail-worker.service.js');
const { NestFactory } = require('@nestjs/core');

const cfg = loadConfig();
// Functions do not survive JSON: only IMAP is used here, so plain fetch is enough.
const mailEndpoints = { ...JSON.parse(process.env.LOAD_FAKE_MAIL!), fetch: (...a: Parameters<typeof fetch>) => fetch(...a), googleJwks: async () => { throw new Error('not used'); } };
const worker = await NestFactory.createApplicationContext(WorkerModule.register(cfg, { mailEndpoints }), { logger: false });
await worker.get(MailWorkerService).start();
process.send!({ ready: true });
process.on('SIGTERM', () => void worker.close().then(() => process.exit(0)));
