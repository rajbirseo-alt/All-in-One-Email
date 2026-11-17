import type { AppConfig } from '../config/config';

/**
 * Which email addresses may belong to an employee login.
 *
 * - Company: a domain in ALLOWED_LOGIN_DOMAINS. Via SSO it must come from the company Google
 *   Workspace (`hd` claim) or the company Entra tenant.
 * - Personal (PERSONAL_ACCOUNT_LOGIN=true): consumer Gmail, or a personal Microsoft account on a
 *   Microsoft consumer domain. These are the only consumer accounts whose email address the
 *   provider itself owns, so the address in the token is proof of the mailbox. Google accounts
 *   registered under some other address, and other companies' Entra tenants (whose admins can
 *   set any email claim), are rejected.
 *
 * Either way, sign-in still requires an existing invitation for that exact address.
 */
export const PERSONAL_GOOGLE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Tenant id Microsoft uses for all personal (MSA) accounts. */
export const MICROSOFT_CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

/** outlook.com, hotmail.co.uk, live.in, msn.com, … */
export function isMicrosoftConsumerDomain(domain: string) {
  return /^(outlook|hotmail|live|windowslive)\.[a-z]{2,3}(\.[a-z]{2})?$/.test(domain) || domain === 'msn.com' || domain === 'passport.com';
}

export const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

export type LoginEmailKind = 'company' | 'personal_google' | 'personal_microsoft';

export function classifyLoginEmail(cfg: AppConfig, email: string): LoginEmailKind | null {
  const d = domainOf(email);
  if (cfg.ALLOWED_LOGIN_DOMAINS.includes(d)) return 'company';
  if (!cfg.PERSONAL_ACCOUNT_LOGIN) return null;
  if (PERSONAL_GOOGLE_DOMAINS.has(d)) return 'personal_google';
  if (isMicrosoftConsumerDomain(d)) return 'personal_microsoft';
  return null;
}

export function allowedLoginEmailHint(cfg: AppConfig) {
  const company = cfg.ALLOWED_LOGIN_DOMAINS.join(', ');
  return cfg.PERSONAL_ACCOUNT_LOGIN ? `a company address (${company}), Gmail or a personal Outlook/Hotmail/Live address` : `a company address (${company})`;
}
