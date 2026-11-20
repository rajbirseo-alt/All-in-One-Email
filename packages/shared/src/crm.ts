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

/**
 * Server settings for common hosts. `{domain}` is replaced by the mailbox's domain.
 * `appPassword`: the provider requires an app password when two-step login is on.
 */
export const IMAP_PRESETS = [
  { id: 'zoho', label: 'Zoho Mail', imap: { host: 'imap.zoho.com', port: 993, security: 'TLS' }, smtp: { host: 'smtp.zoho.com', port: 465, security: 'TLS' }, appPassword: true, note: 'Accounts in the India data centre use imap.zoho.in and smtp.zoho.in. Turn on IMAP access in Zoho Mail settings first.' },
  { id: 'zoho-in', label: 'Zoho Mail (India)', imap: { host: 'imap.zoho.in', port: 993, security: 'TLS' }, smtp: { host: 'smtp.zoho.in', port: 465, security: 'TLS' }, appPassword: true, note: 'Turn on IMAP access in Zoho Mail settings first.' },
  { id: 'hostinger', label: 'Hostinger', imap: { host: 'imap.hostinger.com', port: 993, security: 'TLS' }, smtp: { host: 'smtp.hostinger.com', port: 465, security: 'TLS' }, appPassword: false, note: null },
  { id: 'godaddy', label: 'GoDaddy (Workspace Email)', imap: { host: 'imap.secureserver.net', port: 993, security: 'TLS' }, smtp: { host: 'smtpout.secureserver.net', port: 465, security: 'TLS' }, appPassword: false, note: null },
  { id: 'cpanel', label: 'cPanel / own hosting', imap: { host: 'mail.{domain}', port: 993, security: 'TLS' }, smtp: { host: 'mail.{domain}', port: 465, security: 'TLS' }, appPassword: false, note: 'Your host may use a different server name; it is shown under "Connect Devices" in cPanel.' },
  { id: 'yahoo', label: 'Yahoo Mail', imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'TLS' }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'TLS' }, appPassword: true, note: 'Create an app password in Yahoo account security.' },
  { id: 'icloud', label: 'iCloud Mail', imap: { host: 'imap.mail.me.com', port: 993, security: 'TLS' }, smtp: { host: 'smtp.mail.me.com', port: 587, security: 'STARTTLS' }, appPassword: true, note: 'Create an app-specific password at appleid.apple.com. The username is the part before @icloud.com.' },
  { id: 'other', label: 'Other', imap: { host: '', port: 993, security: 'TLS' }, smtp: { host: '', port: 465, security: 'TLS' }, appPassword: false, note: null },
] as const;
