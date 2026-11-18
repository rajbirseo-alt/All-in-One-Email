import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@crm/db';
import { newId, randomToken, sha256Hex } from '@crm/crypto';
import type { SystemRoleKey } from '@crm/shared';
import { loadConfig, type AppConfig } from '../src/config/config';
import { createApp } from '../src/create-app';
import type { SsoProviderConfig } from '../src/auth/sso.service';
import type { MailEndpoints } from '../src/mail/mail-endpoints';

export const DOMAIN = 'seodiscovery.test';
export const APP_URL = 'http://localhost:3000';

export function testConfig(over: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL!,
    APP_URL,
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-123',
    ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 7).toString('base64') }),
    ALLOWED_LOGIN_DOMAINS: DOMAIN,
    PASSWORD_LOGIN_ENABLED: 'true',
    LOGIN_RATE_LIMIT_PER_MIN: '1000',
    ...over,
  });
}

export async function bootApp(opts: { ssoProviders?: SsoProviderConfig[]; env?: Record<string, string>; mailEndpoints?: MailEndpoints } = {}) {
  const cfg = testConfig(opts.env);
  const app = await createApp(cfg, { ssoProviders: opts.ssoProviders ?? [], mailEndpoints: opts.mailEndpoints });
  await app.init();
  return { app, cfg };
}

/** Minimal browser-like client: keeps cookies and echoes the CSRF cookie in X-CSRF-Token. */
export class Client {
  cookies = new Map<string, string>();
  constructor(private readonly app: INestApplication) {}

  private absorb(res: request.Response) {
    const set = res.headers['set-cookie'] as unknown as string[] | undefined;
    for (const c of set ?? []) {
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq);
      const value = decodeURIComponent(pair!.slice(eq + 1));
      if (!value || /expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async send(method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, body?: unknown, headers: Record<string, string> = {}) {
    let r = request(this.app.getHttpServer())[method](`/api/v1${path}`);
    if (this.cookies.size) r = r.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '));
    const csrf = this.cookies.get('crm_csrf');
    if (csrf && method !== 'get') r = r.set('X-CSRF-Token', csrf);
    r = r.set('Origin', APP_URL);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    const res = await (body !== undefined ? r.send(body as object) : r);
    this.absorb(res);
    return res;
  }

  get = (p: string, h?: Record<string, string>) => this.send('get', p, undefined, h);
  post = (p: string, b?: unknown, h?: Record<string, string>) => this.send('post', p, b ?? {}, h);
  patch = (p: string, b: unknown) => this.send('patch', p, b);
  put = (p: string, b: unknown) => this.send('put', p, b);
  del = (p: string) => this.send('delete', p);

  /** Multipart upload of one file in field "file". */
  async upload(path: string, filename: string, content: Buffer) {
    let r = request(this.app.getHttpServer()).post(`/api/v1${path}`).set('Origin', APP_URL);
    if (this.cookies.size) r = r.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '));
    const csrf = this.cookies.get('crm_csrf');
    if (csrf) r = r.set('X-CSRF-Token', csrf);
    const res = await r.attach('file', content, filename);
    this.absorb(res);
    return res;
  }
}

export const prisma = new PrismaClient();

export async function roleId(key: SystemRoleKey | string) {
  return (await prisma.role.findUniqueOrThrow({ where: { key } })).id;
}

let n = 0;
export function uniqueEmail(prefix = 'user') {
  return `${prefix}.${Date.now().toString(36)}${(n++).toString(36)}@${DOMAIN}`;
}

export async function makeUser(opts: {
  role: SystemRoleKey | string;
  departmentId?: string | null;
  status?: 'INVITED' | 'ACTIVE' | 'SUSPENDED';
  passwordHash?: string;
  name?: string;
  email?: string;
}) {
  return prisma.user.create({
    data: {
      id: newId(),
      email: opts.email ?? uniqueEmail(opts.role.toLowerCase()),
      name: opts.name ?? `${opts.role} user`,
      roleId: await roleId(opts.role),
      departmentId: opts.departmentId ?? null,
      status: opts.status ?? 'ACTIVE',
      passwordHash: opts.passwordHash ?? null,
    },
  });
}

/** Signs a client in by creating a session row directly (bypasses login UI for authorization tests). */
export async function clientAs(app: INestApplication, userId: string) {
  const token = randomToken(32);
  await prisma.session.create({
    data: {
      id: newId(),
      userId,
      tokenHash: sha256Hex(token),
      authMethod: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const c = new Client(app);
  c.cookies.set('crm_session', token);
  c.cookies.set('crm_csrf', randomToken(16));
  return c;
}

export async function makeDepartment(name = `Dept ${newId().slice(-6)}`) {
  return prisma.department.create({ data: { id: newId(), name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') } });
}
