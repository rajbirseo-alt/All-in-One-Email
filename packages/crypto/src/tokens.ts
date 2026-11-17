import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** Opaque random token for cookies / one-time links. Only `sha256Hex(token)` is persisted. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Time-ordered UUID (v7 layout) — sortable primary keys with good B-tree locality. */
export function newId(): string {
  const ms = BigInt(Date.now());
  const rnd = randomBytes(10);
  const b = Buffer.alloc(16);
  b.writeUIntBE(Number(ms >> 16n), 0, 4);
  b.writeUInt16BE(Number(ms & 0xffffn), 4);
  b[6] = 0x70 | (rnd[0]! & 0x0f);
  b[7] = rnd[1]!;
  b[8] = 0x80 | (rnd[2]! & 0x3f);
  rnd.copy(b, 9, 3, 10);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export { randomUUID };

/**
 * Compact signed token: base64url(json).base64url(hmac-sha256). Used for short-lived,
 * stateless values (OAuth state cookie, MFA step token). Always carries `exp` (ms epoch)
 * and a `purpose` so a token minted for one flow cannot be replayed in another.
 */
export function signToken(payload: Record<string, unknown>, purpose: string, ttlMs: number, secret: string): string {
  const body = Buffer.from(JSON.stringify({ ...payload, purpose, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken<T extends Record<string, unknown>>(token: string, purpose: string, secret: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { purpose: string; exp: number };
    if (data.purpose !== purpose || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}
