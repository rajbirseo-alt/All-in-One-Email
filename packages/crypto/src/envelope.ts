import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for secrets at rest (mailbox tokens/passwords, TOTP secrets).
 *
 *   plaintext ──AES-256-GCM(dataKey)──▶ ciphertext            (per record, random dataKey)
 *   dataKey   ──AES-256-GCM(masterKey vN)──▶ wrappedDataKey    (master key never stored in DB)
 *
 * Rotating the master key means re-wrapping data keys, not re-encrypting every payload.
 * `KeyProvider` is the seam for a cloud KMS later; `StaticKeyProvider` reads versioned keys from env.
 */

export interface KeyProvider {
  readonly keyId: string;
  readonly currentVersion: number;
  wrap(dataKey: Buffer): Promise<{ wrapped: Buffer; version: number }>;
  unwrap(wrapped: Buffer, version: number): Promise<Buffer>;
}

export interface EncryptedBlob {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  wrappedDataKey: Buffer;
  keyId: string;
  keyVersion: number;
}

const ALG = 'aes-256-gcm';

function seal(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv(ALG, key, iv);
  c.setAAD(aad);
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, ciphertext, authTag: c.getAuthTag() };
}

function open(key: Buffer, iv: Buffer, ciphertext: Buffer, authTag: Buffer, aad: Buffer) {
  const d = createDecipheriv(ALG, key, iv);
  d.setAAD(aad);
  d.setAuthTag(authTag);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

/**
 * Keys come from `ENCRYPTION_KEYS`, a JSON object of version → base64 32-byte key,
 * e.g. {"1":"…","2":"…"}. The highest version encrypts; all versions decrypt.
 */
export class StaticKeyProvider implements KeyProvider {
  readonly keyId = 'static';
  readonly currentVersion: number;
  private readonly keys = new Map<number, Buffer>();

  /** Accepts `{"1":"<b64>","2":"<b64>"}`, or a single bare base64 key (treated as version 1). */
  constructor(keysJson: string) {
    let parsed: Record<string, string>;
    const trimmed = keysJson.trim();
    if (!trimmed.startsWith('{') && /^[A-Za-z0-9+/=_-]+$/.test(trimmed)) {
      parsed = { 1: trimmed };
    } else {
      try {
        parsed = JSON.parse(trimmed) as Record<string, string>;
      } catch {
        throw new Error('ENCRYPTION_KEYS must be JSON like {"1":"<base64 32 bytes>"} or a single base64 key');
      }
    }
    for (const [v, b64] of Object.entries(parsed)) {
      const version = Number(v);
      const key = Buffer.from(b64, 'base64');
      if (!Number.isInteger(version) || version < 1) throw new Error(`Invalid key version "${v}"`);
      if (key.length !== 32) throw new Error(`Key version ${v} must decode to 32 bytes`);
      this.keys.set(version, key);
    }
    if (this.keys.size === 0) throw new Error('ENCRYPTION_KEYS contains no keys');
    this.currentVersion = Math.max(...this.keys.keys());
  }

  async wrap(dataKey: Buffer) {
    const key = this.keys.get(this.currentVersion)!;
    const { iv, ciphertext, authTag } = seal(key, dataKey, Buffer.from(`kek:v${this.currentVersion}`));
    return { wrapped: Buffer.concat([iv, authTag, ciphertext]), version: this.currentVersion };
  }

  async unwrap(wrapped: Buffer, version: number) {
    const key = this.keys.get(version);
    if (!key) throw new Error(`Master key version ${version} is not configured`);
    return open(key, wrapped.subarray(0, 12), wrapped.subarray(28), wrapped.subarray(12, 28), Buffer.from(`kek:v${version}`));
  }
}

export class Envelope {
  constructor(private readonly keys: KeyProvider) {}

  /** `context` is bound as AAD (e.g. "user:<id>:mfa") so a blob cannot be swapped onto another record. */
  async encrypt(plaintext: string | Buffer, context: string): Promise<EncryptedBlob> {
    const dataKey = randomBytes(32);
    try {
      const body = seal(dataKey, Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8'), Buffer.from(context));
      const { wrapped, version } = await this.keys.wrap(dataKey);
      return { ...body, wrappedDataKey: wrapped, keyId: this.keys.keyId, keyVersion: version };
    } finally {
      dataKey.fill(0);
    }
  }

  async decrypt(blob: EncryptedBlob, context: string): Promise<Buffer> {
    const dataKey = await this.keys.unwrap(blob.wrappedDataKey, blob.keyVersion);
    try {
      return open(dataKey, blob.iv, blob.ciphertext, blob.authTag, Buffer.from(context));
    } finally {
      dataKey.fill(0);
    }
  }

  /** Single-column form: [ver:2][wlen:2][wrapped][iv:12][tag:16][ciphertext]. */
  async encryptToBytes(plaintext: string | Buffer, context: string): Promise<Buffer> {
    const b = await this.encrypt(plaintext, context);
    const header = Buffer.alloc(4);
    header.writeUInt16BE(b.keyVersion, 0);
    header.writeUInt16BE(b.wrappedDataKey.length, 2);
    return Buffer.concat([header, b.wrappedDataKey, b.iv, b.authTag, b.ciphertext]);
  }

  async decryptFromBytes(bytes: Buffer, context: string): Promise<Buffer> {
    const version = bytes.readUInt16BE(0);
    const wlen = bytes.readUInt16BE(2);
    let o = 4;
    const wrappedDataKey = bytes.subarray(o, (o += wlen));
    const iv = bytes.subarray(o, (o += 12));
    const authTag = bytes.subarray(o, (o += 16));
    const ciphertext = bytes.subarray(o);
    return this.decrypt({ ciphertext, iv, authTag, wrappedDataKey, keyId: this.keys.keyId, keyVersion: version }, context);
  }
}
