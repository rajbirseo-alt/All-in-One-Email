/**
 * Rebuilds the report tables from the stored mail (Phase 9).
 *
 *   npm run cli:analytics-rebuild -w @crm/api -- [--days 400]
 *
 * Needed after changing REPORT_TIMEZONE or a business calendar that should apply to past
 * figures. Mailboxes whose mail was already purged keep their existing figures.
 */
import { PrismaService } from '../prisma/prisma.service';
import { loadConfig } from '../config/config';
import { RollupService } from '../analytics/rollup.service';

async function main() {
  const cfg = loadConfig();
  const i = process.argv.indexOf('--days');
  const days = i >= 0 ? Number(process.argv[i + 1]) : 400;
  if (!Number.isInteger(days) || days < 1 || days > 3660) throw new Error('--days must be a whole number between 1 and 3660');
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const t0 = Date.now();
    const r = await new RollupService(prisma, cfg).rebuild(days);
    console.log(`Rebuilt ${days} days in time zone ${cfg.REPORT_TIMEZONE}: ${r.facts} replies, ${r.rows} hourly rows (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
