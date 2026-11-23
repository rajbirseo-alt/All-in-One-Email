import { createHash, createHmac } from 'node:crypto';

/**
 * Minimal S3-compatible object client (PUT / GET / DELETE) with AWS Signature V4, path-style
 * URLs. Works with AWS S3, Cloudflare R2, Backblaze B2, MinIO and others. Kept small on purpose:
 * the CRM needs three calls, not the whole AWS SDK.
 */
export interface S3Config {
  endpoint: string; // e.g. https://<account>.r2.cloudflarestorage.com or https://s3.ap-south-1.amazonaws.com
  region: string; // "auto" for R2
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const sha256 = (d: Buffer | string) => createHash('sha256').update(d).digest('hex');
const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
/** RFC 3986 encoding of each path segment (S3 rule: keep "/" between segments). */
const encodeKey = (key: string) => key.split('/').map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/** Signs one request (exported for the tests, which verify signatures independently). */
export function signS3(cfg: S3Config, method: string, key: string, body: Buffer, now = new Date()): SignedRequest {
  const base = new URL(cfg.endpoint);
  const path = `${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(cfg.bucket)}/${encodeKey(key)}`;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const headers: Record<string, string> = { host: base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  const canonical = [method, path, '', ...names.map((n) => `${n}:${headers[n]}`), '', names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, cfg.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return { url: `${base.protocol}//${base.host}${path}`, headers };
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class S3Client {
  constructor(
    private readonly cfg: S3Config,
    private readonly timeoutMs = 30_000,
  ) {}

  private async call(method: 'PUT' | 'GET' | 'DELETE', key: string, body: Buffer = Buffer.alloc(0)) {
    const { url, headers } = signS3(this.cfg, method, key, body);
    const res = await fetch(url, {
      method,
      headers: { ...headers, ...(method === 'PUT' ? { 'content-type': 'application/octet-stream', 'content-length': String(body.length) } : {}) },
      body: method === 'PUT' ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return res;
  }

  async put(key: string, data: Buffer) {
    const res = await this.call('PUT', key, data);
    if (!res.ok) throw new S3Error(res.status, `Object storage refused the upload (${res.status})`);
    await res.arrayBuffer();
  }

  /** null when the object does not exist. */
  async get(key: string): Promise<Buffer | null> {
    const res = await this.call('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new S3Error(res.status, `Object storage refused the download (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string) {
    const res = await this.call('DELETE', key);
    if (!res.ok && res.status !== 404) throw new S3Error(res.status, `Object storage refused the delete (${res.status})`);
    await res.arrayBuffer();
  }
}
