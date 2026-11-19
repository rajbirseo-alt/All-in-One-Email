import { describe, expect, it } from 'vitest';
import { companyNameFromDomain, emailDomain, isAutomatedAddress, isFreeMailDomain, phoneKey } from './crm';

describe('CRM helpers', () => {
  it('names a company from its domain', () => {
    expect(companyNameFromDomain('acme.com')).toBe('Acme');
    expect(companyNameFromDomain('acme-labs.co.uk')).toBe('Acme Labs');
    expect(companyNameFromDomain('mail.bigcorp.io')).toBe('Bigcorp');
    expect(companyNameFromDomain('shop.com.au')).toBe('Shop');
  });

  it('recognises free mail and robots', () => {
    expect(isFreeMailDomain('Gmail.com')).toBe(true);
    expect(isFreeMailDomain('rediffmail.com')).toBe(true);
    expect(isFreeMailDomain('acme.com')).toBe(false);
    expect(emailDomain('A@Acme.COM')).toBe('acme.com');
    for (const a of ['noreply@x.com', 'no-reply@x.com', 'do_not_reply@x.com', 'mailer-daemon@x.com', 'notifications+abc@github.com']) expect(isAutomatedAddress(a)).toBe(true);
    for (const a of ['john@x.com', 'reply@x.com', 'nora@x.com']) expect(isAutomatedAddress(a)).toBe(false);
  });

  it('normalises phone numbers for matching', () => {
    expect(phoneKey('+91 98765 43210')).toBe('9876543210');
    expect(phoneKey('098765-43210')).toBe('9876543210');
    expect(phoneKey('123')).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });
});
