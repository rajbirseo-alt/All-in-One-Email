import { Inject, Injectable } from '@nestjs/common';
import { newId, randomToken, sha256Hex } from '@crm/crypto';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { baseCookie, clearCookie, clientIp, cookieNames, userAgent } from '../common/http';

const TOUCH_INTERVAL_MS = 5 * 60_000;

export interface ValidSession {
  id: string;
  userId: string;
  authMethod: string;
  expiresAt: Date;
  user: { id: string; roleKey: string; departmentId: string | null };
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private get maxAgeMs() {
    return this.cfg.SESSION_MAX_DAYS * 86_400_000;
  }
  private get idleMs() {
    return this.cfg.SESSION_IDLE_HOURS * 3_600_000;
  }

  /** Creates the session, sets cookies, records the login. Caller provides the transaction. */
  async create(tx: Tx, userId: string, authMethod: string, req: Request, res: Response) {
    const token = randomToken(32);
    const now = new Date();
    const session = await tx.session.create({
      data: {
        id: newId(),
        userId,
        tokenHash: sha256Hex(token),
        authMethod,
        ip: clientIp(req),
        userAgent: userAgent(req),
        expiresAt: new Date(now.getTime() + this.maxAgeMs),
      },
    });
    await tx.user.update({
      where: { id: userId },
      data: { lastLoginAt: now, failedLoginCount: 0, lockedUntil: null },
    });
    await this.audit.record(tx, { userId, ip: clientIp(req), userAgent: userAgent(req) }, {
      action: 'auth.login',
      entityType: 'session',
      entityId: session.id,
      metadata: { authMethod },
    });
    const names = cookieNames(this.cfg);
    res.cookie(names.session, token, baseCookie(this.cfg, { httpOnly: true, maxAge: this.maxAgeMs }));
    this.issueCsrf(res);
    return session;
  }

  /** Double-submit CSRF token: readable by the web app, echoed back in X-CSRF-Token. */
  issueCsrf(res: Response) {
    res.cookie(cookieNames(this.cfg).csrf, randomToken(24), baseCookie(this.cfg, { httpOnly: false, maxAge: this.maxAgeMs }));
  }

  clearCookies(res: Response) {
    const names = cookieNames(this.cfg);
    clearCookie(res, this.cfg, names.session);
    clearCookie(res, this.cfg, names.csrf, false);
  }

  /** `touch: false` checks without counting as activity (used by the live-update stream, so an idle open tab still times out). */
  async validate(token: string | undefined, opts: { touch?: boolean } = {}): Promise<ValidSession | null> {
    if (!token || token.length > 200) return null;
    const s = await this.prisma.session.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: { select: { id: true, status: true, departmentId: true, role: { select: { key: true } } } } },
    });
    const now = Date.now();
    if (!s || s.revokedAt || s.expiresAt.getTime() <= now) return null;
    if (now - s.lastSeenAt.getTime() > this.idleMs) return null;
    if (s.user.status !== 'ACTIVE') return null;
    if (opts.touch !== false && now - s.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date(now) } });
    }
    return {
      id: s.id,
      userId: s.userId,
      authMethod: s.authMethod,
      expiresAt: s.expiresAt,
      user: { id: s.user.id, roleKey: s.user.role.key, departmentId: s.user.departmentId },
    };
  }

  async revokeAllForUser(tx: Tx, userId: string, exceptSessionId?: string) {
    const r = await tx.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
    return r.count;
  }
}
