import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  Envelope,
  StaticKeyProvider,
  base32Decode,
  base32Encode,
  hotp,
  newId,
  signToken,
  totp,
  verifyToken,
  verifyTotp,
} from './index';

const key = () => randomBytes(32).toString('base64');

describe('Envelope', () => {
  it('round-trips and binds the context', async () => {
    const env = new Envelope(new StaticKeyProvider(JSON.stringify({ 1: key() })));
    const bytes = await env.encryptToBytes('refresh-token-xyz', 'account:1');
    expect(bytes.includes(Buffer.from('refresh-token-xyz'))).toBe(false);
    expect((await env.decryptFromBytes(bytes, 'account:1')).toString()).toBe('refresh-token-xyz');
    await expect(env.decryptFromBytes(bytes, 'account:2')).rejects.toThrow();
  });

  it('decrypts old data after a master-key rotation', async () => {
    const k1 = key();
    const before = new Envelope(new StaticKeyProvider(JSON.stringify({ 1: k1 })));
    const blob = await before.encryptToBytes('secret', 'ctx');
    const after = new Envelope(new StaticKeyProvider(JSON.stringify({ 1: k1, 2: key() })));
    expect((await after.decryptFromBytes(blob, 'ctx')).toString()).toBe('secret');
    const fresh = await after.encrypt('x', 'ctx');
    expect(fresh.keyVersion).toBe(2);
  });

  it('rejects tampered ciphertext', async () => {
    const env = new Envelope(new StaticKeyProvider(JSON.stringify({ 1: key() })));
    const bytes = await env.encryptToBytes('secret', 'ctx');
    bytes[bytes.length - 1]! ^= 1;
    await expect(env.decryptFromBytes(bytes, 'ctx')).rejects.toThrow();
  });

  it('validates key configuration', () => {
    expect(() => new StaticKeyProvider('{"1":"c2hvcnQ="}')).toThrow(/32 bytes/);
    expect(() => new StaticKeyProvider('{not json')).toThrow(/JSON/);
    expect(() => new StaticKeyProvider('c2hvcnQ=')).toThrow(/32 bytes/);
  });

  it('accepts a single bare base64 key as version 1 (Render generateValue)', async () => {
    const k = key();
    const bare = new Envelope(new StaticKeyProvider(k));
    const blob = await bare.encryptToBytes('s', 'c');
    const json = new Envelope(new StaticKeyProvider(JSON.stringify({ 1: k })));
    expect((await json.decryptFromBytes(blob, 'c')).toString()).toBe('s');
  });
});

describe('TOTP', () => {
  // RFC 4226 Appendix D test vectors (secret = ASCII "12345678901234567890").
  it('matches RFC 4226 HOTP vectors', () => {
    const secret = Buffer.from('12345678901234567890');
    expect([0, 1, 2, 9].map((c) => hotp(secret, c))).toEqual(['755224', '287082', '359152', '520489']);
  });

  it('base32 round-trips', () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });

  it('accepts ±1 step and rejects others', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const t = 1_700_000_000_000;
    expect(verifyTotp(secret, totp(secret, t), t)).not.toBeNull();
    expect(verifyTotp(secret, totp(secret, t - 30_000), t)).not.toBeNull();
    expect(verifyTotp(secret, totp(secret, t - 90_000), t)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', t)).toBeNull();
  });
});

describe('signed tokens', () => {
  it('verifies purpose, signature and expiry', () => {
    const t = signToken({ uid: 'u1' }, 'mfa', 60_000, 's3cret');
    expect(verifyToken(t, 'mfa', 's3cret')?.uid).toBe('u1');
    expect(verifyToken(t, 'oauth', 's3cret')).toBeNull();
    expect(verifyToken(t, 'mfa', 'other')).toBeNull();
    expect(verifyToken(signToken({}, 'mfa', -1, 's3cret'), 'mfa', 's3cret')).toBeNull();
  });
});

describe('newId', () => {
  it('is UUIDv7-shaped and time-ordered', async () => {
    const a = newId();
    await new Promise((r) => setTimeout(r, 2));
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
