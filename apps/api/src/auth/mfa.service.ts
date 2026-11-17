import { Inject, Injectable } from '@nestjs/common';
import { Envelope, generateTotpSecret, otpauthUri, signToken, verifyToken, verifyTotp } from '@crm/crypto';
import { MFA_REQUIRED_PERMISSIONS, MFA_REQUIRED_ROLES, type EffectivePermissions, type PermissionKey } from '@crm/shared';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { ENVELOPE } from '../crypto.provider';

const STEP_TOKEN_TTL_MS = 10 * 60_000;
const ISSUER = 'SEO Discovery CRM';

export type MfaStage = 'verify' | 'enroll';

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENVELOPE) private readonly envelope: Envelope,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private ctx(userId: string) {
    return `user:${userId}:mfa`;
  }

  isRequired(roleKey: string, perms: EffectivePermissions): boolean {
    if (MFA_REQUIRED_ROLES.has(roleKey)) return true;
    return (Object.keys(perms) as PermissionKey[]).some((k) => MFA_REQUIRED_PERMISSIONS.has(k));
  }

  /** Proof that the password step succeeded; only valid for the next MFA call. */
  stepToken(userId: string, stage: MfaStage) {
    return signToken({ uid: userId, stage }, 'mfa-step', STEP_TOKEN_TTL_MS, this.cfg.SESSION_SECRET);
  }

  readStepToken(token: string, stage: MfaStage): string | null {
    const data = verifyToken<{ uid: string; stage: string }>(token, 'mfa-step', this.cfg.SESSION_SECRET);
    return data && data.stage === stage ? data.uid : null;
  }

  /** Stores a new (not yet enabled) secret and returns what the authenticator app needs. */
  async beginEnrollment(tx: Tx, userId: string, email: string) {
    const secret = generateTotpSecret();
    await tx.user.update({
      where: { id: userId },
      data: {
        mfaSecretEnc: new Uint8Array(await this.envelope.encryptToBytes(secret, this.ctx(userId))),
        mfaEnabledAt: null,
        mfaLastUsedStep: null,
      },
    });
    return { secret, otpauthUri: otpauthUri(secret, email, ISSUER) };
  }

  /** Verifies a code, rejects replays of an already-used time step, and records the step. */
  async checkCode(tx: Tx, userId: string, code: string): Promise<boolean> {
    const u = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaSecretEnc: true, mfaLastUsedStep: true } });
    if (!u.mfaSecretEnc) return false;
    const secret = (await this.envelope.decryptFromBytes(Buffer.from(u.mfaSecretEnc), this.ctx(userId))).toString('utf8');
    const step = verifyTotp(secret, code);
    if (step === null || (u.mfaLastUsedStep !== null && step <= u.mfaLastUsedStep)) return false;
    // Conditional update closes the race where the same code is submitted twice concurrently.
    const r = await tx.user.updateMany({
      where: { id: userId, OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }] },
      data: { mfaLastUsedStep: step },
    });
    return r.count === 1;
  }
}
