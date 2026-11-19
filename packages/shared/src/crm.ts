/**
 * Free / consumer mail domains. A company is never created for these: two people at gmail.com
 * are not colleagues. Extend when a new provider shows up in the inbox.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk', 'yahoo.in', 'ymail.com', 'rocketmail.com',
  'outlook.com', 'outlook.in', 'hotmail.com', 'hotmail.co.uk', 'hotmail.in', 'live.com', 'live.in', 'live.co.uk', 'msn.com', 'passport.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'aim.com',
  'proton.me', 'protonmail.com', 'pm.me',
  'zoho.com', 'zohomail.com', 'zohomail.in',
  'yandex.com', 'yandex.ru', 'mail.ru',
  'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.com', 'email.com',
  'rediffmail.com', 'rediff.com', 'sify.com',
  'qq.com', '163.com', '126.com', 'sina.com',
  'tutanota.com', 'tuta.io', 'fastmail.com', 'hey.com',
]);

export function emailDomain(address: string): string {
  return address.split('@')[1]?.trim().toLowerCase() ?? '';
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.trim().toLowerCase());
}

/** Robots and bounces: never turned into contacts automatically (they are still matched if one exists). */
export function isAutomatedAddress(address: string): boolean {
  const local = address.split('@')[0]?.toLowerCase() ?? '';
  return /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|alerts?|automated|system)([-_.+].*)?$/.test(local);
}

/** "acme-labs.co.uk" → "Acme Labs": a readable first guess at a company name from its domain. */
export function companyNameFromDomain(domain: string): string {
  const parts = domain.toLowerCase().split('.');
  // Drop the public suffix (one or two short labels such as "com", "co.uk", "com.au").
  let i = parts.length - 1;
  if (i > 0) i--;
  if (i > 0 && parts[i]!.length <= 3 && parts[i + 1]!.length <= 3) i--;
  const label = parts[Math.max(0, i)] ?? domain;
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Digits only, without a leading country "0" or "+": for duplicate detection by phone. */
export function phoneKey(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : null;
}
