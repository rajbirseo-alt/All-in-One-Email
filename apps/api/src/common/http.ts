import type { CookieOptions, Request, Response } from 'express';
import type { AppConfig } from '../config/config';

export function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

export function userAgent(req: Request): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 500) : null;
}

/** `__Host-` requires Secure + Path=/ + no Domain; used whenever we're on https. */
export function cookieNames(cfg: AppConfig) {
  const secure = cfg.APP_URL.startsWith('https://');
  return {
    secure,
    session: secure ? '__Host-crm_session' : 'crm_session',
    csrf: secure ? '__Host-crm_csrf' : 'crm_csrf',
    oauth: secure ? '__Host-crm_oauth' : 'crm_oauth',
    mailOauth: secure ? '__Host-crm_mail_oauth' : 'crm_mail_oauth',
  };
}

export function baseCookie(cfg: AppConfig, extra: Partial<CookieOptions> = {}): CookieOptions {
  return { path: '/', sameSite: 'lax', secure: cookieNames(cfg).secure, ...extra };
}

export function clearCookie(res: Response, cfg: AppConfig, name: string, httpOnly = true) {
  res.clearCookie(name, baseCookie(cfg, { httpOnly }));
}
