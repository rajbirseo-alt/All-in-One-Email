// Load-test server: the production builds of the API (RLS on) and the worker, against the
// load database, plus a local IMAP host for measuring how fast new mail becomes visible.
// Started by tools/loadtest/run.mts as a child process (so the load generator does not share
// its CPU). Messages from the parent: { deliver: { messageId, subject } }.
import { createRequire } from 'node:module';
import { FakeMail } from '../../apps/api/test/fake-mail.ts';
import { FakeImapBox, rawMail } from '../../apps/api/test/fake-imap.ts';

const require = createRequire(import.meta.url);
const { loadConfig } = require('../../apps/api/dist/config/config.js');
const { createApp } = require('../../apps/api/dist/create-app.js');
// Diagnosis only: LOAD_NO_RLS=1 measures the same load without the per-statement RLS context.
if (process.env.LOAD_NO_RLS === '1') {
  const { PrismaService } = require('../../apps/api/dist/prisma/prisma.service.js');
  Object.defineProperty(PrismaService, 'rlsContext', { get: () => false, set: () => undefined });
}

const port = Number(process.env.LOAD_API_PORT ?? 4100);
const cfg = loadConfig();
const fake = await new FakeMail().start();
const endpoints = fake.endpoints();
const box = await new FakeImapBox(process.env.LOAD_IMAP_ADDRESS!).start();
const app = await createApp(cfg, { mailEndpoints: endpoints });
// Server-side request time (from the first byte in to the response finished), for the report.
const serverMs: number[] = [];
app.use((req: { url: string }, res: { on: (e: string, f: () => void) => void }, next: () => void) => {
  const t0 = performance.now();
  res.on('finish', () => serverMs.push(performance.now() - t0));
  next();
});
await app.listen(port, '127.0.0.1');
// The worker runs in its own process, as on Render (crm-worker is a separate service).
const { fork } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');
const workerProc = fork(fileURLToPath(new URL('./worker.mts', import.meta.url)), [], { env: { ...process.env, LOAD_FAKE_MAIL: JSON.stringify(endpoints) }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
await new Promise((r) => workerProc.once('message', r));
const worker = { close: async () => { workerProc.kill(); } };

process.on('message', (m: { deliver?: { messageId: string; subject: string }; stop?: boolean }) => {
  if (m.deliver) box.deliver('INBOX', rawMail({ from: 'Load Client <client@load.example>', to: process.env.LOAD_IMAP_ADDRESS!, subject: m.deliver.subject, messageId: m.deliver.messageId, text: 'Load test enquiry' }));
  if (m.stop) {
    void (async () => {
      await worker.close();
      await app.close();
      box.stop();
      fake.stop();
      process.exit(0);
    })();
  }
});
// Diagnostics for the report: CPU of this process and event-loop delay, every 5 s.
const { monitorEventLoopDelay } = await import('node:perf_hooks');
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
let cpu = process.cpuUsage();
let at = Date.now();
setInterval(() => {
  const d = process.cpuUsage(cpu);
  const ms = Date.now() - at;
  const sorted = serverMs.splice(0).sort((a, b) => a - b);
  const p95 = sorted.length ? Math.round(sorted[Math.floor(sorted.length * 0.95)]!) : 0;
  process.send!({ diag: { serverP95: p95, served: sorted.length, cpu: Math.round(((d.user + d.system) / 1000 / ms) * 100), loopP99: Math.round(loop.percentile(99) / 1e6) } });
  cpu = process.cpuUsage();
  at = Date.now();
  loop.reset();
}, 5000).unref();
process.send!({ ready: true, imap: box.settings(), port });
