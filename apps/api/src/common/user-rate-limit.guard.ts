import { HttpException, HttpStatus, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { AuthedRequest } from './request-context';

/**
 * Per-employee request limit (after sign-in), so one runaway browser tab or script cannot starve
 * everyone else. The per-IP limit in front of it is generous because a whole office usually
 * shares one public IP. Fixed one-minute windows, kept in memory per API instance.
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastSweep = Date.now();

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const userId = req.ctx?.userId;
    if (!userId) return true;
    const now = Date.now();
    if (now - this.lastSweep > 120_000) {
      for (const [k, w] of this.windows) if (now - w.start >= 60_000) this.windows.delete(k);
      this.lastSweep = now;
    }
    let w = this.windows.get(userId);
    if (!w || now - w.start >= 60_000) this.windows.set(userId, (w = { start: now, count: 0 }));
    if (++w.count > this.cfg.RATE_LIMIT_PER_USER_PER_MIN) {
      const res = context.switchToHttp().getResponse<Response>();
      res.setHeader('Retry-After', String(Math.ceil((w.start + 60_000 - now) / 1000)));
      throw new HttpException({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a moment and try again.' } }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
