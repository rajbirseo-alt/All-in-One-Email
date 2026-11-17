/**
 * Bootstraps the first Super Admin (there are no default accounts or passwords).
 *
 *   npm run cli:create-super-admin -w @crm/api -- --email cmo@company.com --name "Full Name" [--password-link]
 *
 * Without --password-link the user signs in with Google/Microsoft SSO using that address.
 * With it, a one-time 72-hour link is printed for setting a password (TOTP enrolment follows).
 */
import { PrismaClient } from '@crm/db';
import { newId, randomToken, sha256Hex } from '@crm/crypto';
import { seed } from '@crm/db/dist/seed';
import { loadConfig } from '../config/config';
import { allowedLoginEmailHint, classifyLoginEmail } from '../auth/login-policy';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const cfg = loadConfig();
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  const wantLink = process.argv.includes('--password-link');
  if (!email || !name || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw new Error('Usage: --email <address> --name "<full name>" [--password-link]');
  }
  if (!classifyLoginEmail(cfg, email)) throw new Error(`Email must be ${allowedLoginEmailHint(cfg)}`);
  if (wantLink && !cfg.PASSWORD_LOGIN_ENABLED) throw new Error('Password sign-in is disabled (PASSWORD_LOGIN_ENABLED=false)');

  const prisma = new PrismaClient();
  try {
    await seed(prisma);
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'SUPER_ADMIN' } });
    const result = await prisma.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { email } });
      if (user) {
        user = await tx.user.update({ where: { id: user.id }, data: { roleId: role.id, status: user.status === 'ACTIVE' ? 'ACTIVE' : 'INVITED' } });
      } else {
        user = await tx.user.create({ data: { id: newId(), email, name, roleId: role.id, status: 'INVITED' } });
      }
      let link: string | null = null;
      if (wantLink) {
        const token = randomToken(32);
        await tx.userActionToken.updateMany({ where: { userId: user.id, purpose: 'set_password', usedAt: null }, data: { usedAt: new Date() } });
        await tx.userActionToken.create({
          data: { id: newId(), userId: user.id, purpose: 'set_password', tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 72 * 3_600_000) },
        });
        link = `${cfg.appOrigin}/set-password?token=${encodeURIComponent(token)}`;
      }
      await tx.auditLog.create({
        data: { id: newId(), actorType: 'SYSTEM', action: 'user.bootstrap_super_admin', entityType: 'user', entityId: user.id, metadata: { via: 'cli' } },
      });
      return { user, link };
    });
    console.log(`Super Admin ready: ${result.user.email} (status ${result.user.status}).`);
    if (result.link) console.log(`One-time password link (valid 72 h):\n${result.link}`);
    else console.log('Sign in with Google or Microsoft using this address.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
