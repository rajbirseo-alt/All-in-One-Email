import { Inject, Injectable } from '@nestjs/common';
import { newId, randomToken, sha256Hex } from '@crm/crypto';
import type { LoginResponse } from '@crm/shared';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PermissionService } from '../access/permission.service';
import { Errors, ApiException } from '../common/errors';
import { clientIp, userAgent } from '../common/http';
import type { RequestContext } from '../common/request-context';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import type { SsoClaims, SsoProviderId } from './sso.service';
import { SsoError } from './sso.service';

const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60_000;
const SET_PASSWORD_TTL_MS = 72 * 3_600_000;

const invalidCredentials = () => new ApiException(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordService,
    private readonly mfa: MfaService,
    private readonly perms: PermissionService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private actor(req: Request, userId: string | null) {
    return { userId, ip: clientIp(req), userAgent: userAgent(req) };
  }

  private async recordFailure(userId: string, req: Request, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id: userId }, data: { failedLoginCount: { increment: 1 } } });
      if (u.failedLoginCount >= MAX_FAILURES) {
        await tx.user.update({ where: { id: userId }, data: { lockedUntil: new Date(Date.now() + LOCK_MS), failedLoginCount: 0 } });
      }
      await this.audit.record(tx, this.actor(req, null), {
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: userId,
        metadata: { reason },
      });
    });
  }

  async passwordLogin(email: string, password: string, req: Request, res: Response): Promise<LoginResponse> {
    if (!this.cfg.PASSWORD_LOGIN_ENABLED) throw Errors.notFound('Password sign-in');
    const user = await this.prisma.user.findUnique({ where: { email }, include: { role: { select: { key: true } } } });
    const ok = await this.passwords.verify(user?.passwordHash, password); // always runs: uniform timing
    if (!user) throw invalidCredentials();
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      // Locked: reject without revealing whether the password was right.
      throw invalidCredentials();
    }
    if (!ok || !user.passwordHash) {
      await this.recordFailure(user.id, req, 'bad_password');
      throw invalidCredentials();
    }
    if (user.status !== 'ACTIVE') {
      await this.recordFailure(user.id, req, `status_${user.status.toLowerCase()}`);
      throw invalidCredentials();
    }

    if (user.mfaEnabledAt) return { status: 'mfa_required', mfaToken: this.mfa.stepToken(user.id, 'verify') };
    const perms = await this.perms.effectiveFor(user.id);
    if (this.mfa.isRequired(user.role.key, perms)) {
      return { status: 'mfa_enrollment_required', mfaToken: this.mfa.stepToken(user.id, 'enroll') };
    }
    await this.prisma.$transaction((tx) => this.sessions.create(tx, user.id, 'password', req, res));
    return { status: 'ok' };
  }

  private async activeUserFromStep(token: string, stage: 'verify' | 'enroll') {
    const userId = this.mfa.readStepToken(token, stage);
    if (!userId) throw new ApiException(401, 'MFA_TOKEN_INVALID', 'Your sign-in attempt expired — start again');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'ACTIVE' || (user.lockedUntil && user.lockedUntil > new Date())) {
      throw new ApiException(401, 'MFA_TOKEN_INVALID', 'Your sign-in attempt expired — start again');
    }
    return user;
  }

  async mfaVerify(mfaToken: string, code: string, req: Request, res: Response): Promise<LoginResponse> {
    const user = await this.activeUserFromStep(mfaToken, 'verify');
    const ok = await this.prisma.$transaction(async (tx) => {
      if (!(await this.mfa.checkCode(tx, user.id, code))) return false;
      await this.sessions.create(tx, user.id, 'password+totp', req, res);
      return true;
    });
    if (!ok) {
      await this.recordFailure(user.id, req, 'bad_totp');
      throw new ApiException(401, 'INVALID_CODE', 'That code is not valid — check your authenticator app');
    }
    return { status: 'ok' };
  }

  async mfaEnrollStart(mfaToken: string) {
    const user = await this.activeUserFromStep(mfaToken, 'enroll');
    if (user.mfaEnabledAt) throw Errors.conflict('Two-factor authentication is already enabled');
    return this.prisma.$transaction((tx) => this.mfa.beginEnrollment(tx, user.id, user.email));
  }

  async mfaEnrollConfirm(mfaToken: string, code: string, req: Request, res: Response): Promise<LoginResponse> {
    const user = await this.activeUserFromStep(mfaToken, 'enroll');
    const ok = await this.prisma.$transaction(async (tx) => {
      if (user.mfaEnabledAt || !(await this.mfa.checkCode(tx, user.id, code))) return false;
      await tx.user.update({ where: { id: user.id }, data: { mfaEnabledAt: new Date() } });
      await this.audit.record(tx, this.actor(req, user.id), { action: 'auth.mfa_enabled', entityType: 'user', entityId: user.id });
      await this.sessions.create(tx, user.id, 'password+totp', req, res);
      return true;
    });
    if (!ok) throw new ApiException(401, 'INVALID_CODE', 'That code is not valid — check your authenticator app');
    return { status: 'ok' };
  }

  /** Self-service enrollment from the account page (already signed in). */
  async selfEnrollStart(ctx: RequestContext) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (user.mfaEnabledAt) throw Errors.conflict('Two-factor authentication is already enabled');
    return this.prisma.$transaction((tx) => this.mfa.beginEnrollment(tx, user.id, user.email));
  }

  async selfEnrollConfirm(ctx: RequestContext, code: string) {
    const ok = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: ctx.userId } });
      if (user.mfaEnabledAt || !(await this.mfa.checkCode(tx, user.id, code))) return false;
      await tx.user.update({ where: { id: user.id }, data: { mfaEnabledAt: new Date() } });
      await this.audit.record(tx, ctx, { action: 'auth.mfa_enabled', entityType: 'user', entityId: user.id });
      return true;
    });
    if (!ok) throw new ApiException(401, 'INVALID_CODE', 'That code is not valid — check your authenticator app');
  }

  async selfDisableMfa(ctx: RequestContext) {
    if (this.mfa.isRequired(ctx.roleKey, ctx.permissions)) {
      throw Errors.forbidden('Two-factor authentication is mandatory for your role');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: ctx.userId }, data: { mfaEnabledAt: null, mfaSecretEnc: null, mfaLastUsedStep: null } });
      await this.audit.record(tx, ctx, { action: 'auth.mfa_disabled', entityType: 'user', entityId: ctx.userId });
    });
  }

  /**
   * SSO sign-in. Only pre-invited employees can sign in: the identity is linked on first use by
   * matching the verified company email, after which the provider subject is authoritative.
   */
  async ssoLogin(provider: SsoProviderId, claims: SsoClaims, req: Request, res: Response) {
    await this.prisma.$transaction(async (tx) => {
      const identity = await tx.userIdentity.findUnique({
        where: { provider_providerSubject: { provider, providerSubject: claims.subject } },
        include: { user: true },
      });
      let user = identity?.user ?? null;
      if (!user) {
        user = await tx.user.findUnique({ where: { email: claims.email } });
        if (!user) throw new SsoError('not_invited');
        const existing = await tx.userIdentity.findFirst({ where: { userId: user.id, provider } });
        if (existing) throw new SsoError('identity_mismatch'); // a different account of this provider is already linked
        await tx.userIdentity.create({ data: { id: newId(), userId: user.id, provider, providerSubject: claims.subject } });
        await this.audit.record(tx, this.actor(req, user.id), {
          action: 'auth.identity_linked',
          entityType: 'user',
          entityId: user.id,
          metadata: { provider },
        });
      }
      if (user.status === 'INVITED') {
        user = await tx.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', name: user.name || claims.name || user.email } });
      }
      if (user.status !== 'ACTIVE') throw new SsoError('account_suspended');
      await this.sessions.create(tx, user.id, provider, req, res);
    });
  }

  async logout(ctx: RequestContext, res: Response) {
    await this.prisma.$transaction(async (tx) => {
      await tx.session.update({ where: { id: ctx.sessionId }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, ctx, { action: 'auth.logout', entityType: 'session', entityId: ctx.sessionId });
    });
    this.sessions.clearCookies(res);
  }

  async listSessions(ctx: RequestContext) {
    const rows = await this.prisma.session.findMany({
      where: { userId: ctx.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    const idleCutoff = Date.now() - this.cfg.SESSION_IDLE_HOURS * 3_600_000;
    return rows
      .filter((s) => s.lastSeenAt.getTime() > idleCutoff)
      .map((s) => ({
        id: s.id,
        ip: s.ip,
        userAgent: s.userAgent,
        authMethod: s.authMethod,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        current: s.id === ctx.sessionId,
      }));
  }

  async revokeSession(ctx: RequestContext, sessionId: string) {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.session.updateMany({ where: { id: sessionId, userId: ctx.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      if (r.count === 0) throw Errors.notFound('Session');
      await this.audit.record(tx, ctx, { action: 'auth.session_revoked', entityType: 'session', entityId: sessionId });
    });
  }

  /** Admin creates a one-time link for an employee to set (or reset) their password. */
  async createPasswordLink(ctx: RequestContext, userId: string) {
    if (!this.cfg.PASSWORD_LOGIN_ENABLED) throw Errors.notFound('Password sign-in');
    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!target) throw Errors.notFound('Employee');
    if (target.status === 'SUSPENDED' || target.status === 'DEACTIVATED') {
      throw Errors.conflict('Reactivate this employee before creating a password link');
    }
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + SET_PASSWORD_TTL_MS);
    await this.prisma.$transaction(async (tx) => {
      await tx.userActionToken.updateMany({ where: { userId, purpose: 'set_password', usedAt: null }, data: { usedAt: new Date() } });
      await tx.userActionToken.create({
        data: { id: newId(), userId, purpose: 'set_password', tokenHash: sha256Hex(token), createdById: ctx.userId, expiresAt },
      });
      await this.audit.record(tx, ctx, { action: 'user.password_link_created', entityType: 'user', entityId: userId });
    });
    return { url: `${this.cfg.appOrigin}/set-password?token=${encodeURIComponent(token)}`, expiresAt: expiresAt.toISOString() };
  }

  async setPassword(token: string, password: string, req: Request) {
    if (!this.cfg.PASSWORD_LOGIN_ENABLED) throw Errors.notFound('Password sign-in');
    const hash = await this.passwords.hash(password);
    await this.prisma.$transaction(async (tx) => {
      const t = await tx.userActionToken.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { user: true } });
      if (!t || t.purpose !== 'set_password' || t.usedAt || t.expiresAt <= new Date()) {
        throw new ApiException(400, 'LINK_INVALID', 'This link is invalid or has expired — ask an administrator for a new one');
      }
      if (t.user.status === 'SUSPENDED' || t.user.status === 'DEACTIVATED') {
        throw new ApiException(400, 'LINK_INVALID', 'This link is invalid or has expired — ask an administrator for a new one');
      }
      const claimed = await tx.userActionToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) throw new ApiException(400, 'LINK_INVALID', 'This link has already been used');
      await tx.user.update({
        where: { id: t.userId },
        data: { passwordHash: hash, status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
      });
      await this.sessions.revokeAllForUser(tx, t.userId);
      await this.audit.record(tx, this.actor(req, t.userId), { action: 'auth.password_set', entityType: 'user', entityId: t.userId });
    });
  }
}
