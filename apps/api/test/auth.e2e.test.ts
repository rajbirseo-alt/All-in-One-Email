import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Algorithm, hash } from '@node-rs/argon2';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '@crm/crypto';
import type { SsoProviderConfig } from '../src/auth/sso.service';
import { buildSsoProviders } from '../src/auth/sso.service';
import { APP_URL, Client, DOMAIN, bootApp, clientAs, makeUser, prisma, testConfig, uniqueEmail } from './helpers';

const PASSWORD = 'correct horse battery staple';
let pwHash: string;

// ── Local OIDC issuer: real RS256 signatures, real JWKS verification, real token exchange over HTTP ──
let issuerServer: Server;
let nextClaims: Record<string, unknown> = {};
let privateKey: CryptoKey;
let jwk: JWK;
// Set per attempt so one issuer can stand in for Google and Microsoft.
let nextIssuer = 'https://accounts.google.com';
let nextAudience = 'test-google-client';
const MS_TENANT = '11111111-2222-3333-4444-555555555555';
const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const SSO_ENV = {
  GOOGLE_CLIENT_ID: 'test-google-client',
  GOOGLE_CLIENT_SECRET: 'secret',
  MICROSOFT_CLIENT_ID: 'test-ms-client',
  MICROSOFT_CLIENT_SECRET: 'secret',
  MICROSOFT_TENANT_ID: MS_TENANT,
};

async function startIssuer() {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey as CryptoKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' };
  issuerServer = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      if (params.get('code') !== 'good-code' || !params.get('code_verifier')) {
        res.writeHead(400).end('{"error":"invalid_grant"}');
        return;
      }
      const idToken = await new SignJWT(nextClaims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(nextIssuer)
        .setAudience(nextAudience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id_token: idToken }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => issuerServer.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(issuerServer.address() as AddressInfo).port}`;
}

let app: INestApplication;

beforeAll(async () => {
  pwHash = await hash(PASSWORD, { algorithm: Algorithm.Argon2id });
  const issuerUrl = await startIssuer();
  // Start from the real Google and Microsoft provider configs (claim, tenant and issuer rules)
  // and point only the network endpoints at the local issuer.
  const local = (p: SsoProviderConfig): SsoProviderConfig => ({
    ...p,
    authorizationEndpoint: `${issuerUrl}/authorize`,
    tokenEndpoint: `${issuerUrl}/token`,
    jwks: createLocalJWKSet({ keys: [jwk] }),
  });
  ({ app } = await bootApp({ ssoProviders: buildSsoProviders(testConfig(SSO_ENV)).map(local) }));
});

afterAll(async () => {
  await app.close();
  issuerServer.close();
});

async function passwordLogin(c: Client, email: string, password = PASSWORD) {
  return c.post('/auth/login', { email, password });
}

describe('providers', () => {
  it('reports which sign-in methods are configured', async () => {
    const r = await new Client(app).get('/auth/providers');
    expect(r.body).toEqual({ google: true, microsoft: true, password: true });
  });
});

describe('password sign-in', () => {
  it('signs in an employee, returns /me, and requires CSRF to log out', async () => {
    const u = await makeUser({ role: 'EMPLOYEE', passwordHash: pwHash });
    const c = new Client(app);
    const r = await passwordLogin(c, u.email.toUpperCase()); // email is case-insensitive
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok' });
    expect(c.cookies.has('crm_session')).toBe(true);

    const me = await c.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(u.email);
    expect(me.body.permissions['conversation.read']).toBe('ASSIGNED');
    expect(me.body.permissions['user.manage']).toBeUndefined();

    const noCsrf = await c.post('/auth/logout', {}, { 'X-CSRF-Token': 'wrong' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_FAILED');

    expect((await c.post('/auth/logout')).status).toBe(204);
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('rejects requests from a foreign origin', async () => {
    const r = await new Client(app).post('/auth/login', { email: 'x@y.z', password: 'x' }, { Origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });

  it('gives the same error for unknown user and wrong password', async () => {
    const u = await makeUser({ role: 'EMPLOYEE', passwordHash: pwHash });
    const a = await passwordLogin(new Client(app), u.email, 'wrong password!!');
    const b = await passwordLogin(new Client(app), uniqueEmail('nobody'), 'wrong password!!');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('locks the account after 10 failures, even for the right password', async () => {
    const u = await makeUser({ role: 'EMPLOYEE', passwordHash: pwHash });
    // Spread over clients so the per-IP throttle (10/min) is not what stops us — it is per route+IP,
    // so we write the counter directly for 9 and do the 10th through the API.
    await prisma.user.update({ where: { id: u.id }, data: { failedLoginCount: 9 } });
    expect((await passwordLogin(new Client(app), u.email, 'nope nope nope')).status).toBe(401);
    const locked = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect((await passwordLogin(new Client(app), u.email)).status).toBe(401);
    const audit = await prisma.auditLog.count({ where: { entityId: u.id, action: 'auth.login_failed' } });
    expect(audit).toBeGreaterThanOrEqual(1);
  });

  it('refuses suspended and invited users', async () => {
    const s = await makeUser({ role: 'EMPLOYEE', passwordHash: pwHash, status: 'SUSPENDED' });
    const i = await makeUser({ role: 'EMPLOYEE', passwordHash: pwHash, status: 'INVITED' });
    expect((await passwordLogin(new Client(app), s.email)).status).toBe(401);
    expect((await passwordLogin(new Client(app), i.email)).status).toBe(401);
  });
});

describe('mandatory TOTP for admins', () => {
  it('forces enrollment, then verifies codes and blocks replay', async () => {
    const u = await makeUser({ role: 'SUPER_ADMIN', passwordHash: pwHash });
    const c = new Client(app);
    const first = await passwordLogin(c, u.email);
    expect(first.body.status).toBe('mfa_enrollment_required');
    expect(c.cookies.has('crm_session')).toBe(false);

    const start = await c.post('/auth/mfa/enroll/start', { mfaToken: first.body.mfaToken });
    expect(start.status).toBe(200);
    expect(start.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const secret: string = start.body.secret;

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(Buffer.from(stored.mfaSecretEnc!).includes(Buffer.from(secret))).toBe(false); // encrypted at rest

    const bad = await c.post('/auth/mfa/enroll/confirm', { mfaToken: first.body.mfaToken, code: '000000' });
    expect(bad.status).toBe(401);
    const code = totp(secret);
    const ok = await c.post('/auth/mfa/enroll/confirm', { mfaToken: first.body.mfaToken, code });
    expect(ok.body).toEqual({ status: 'ok' });
    expect((await c.get('/auth/me')).body.user.mfaEnabled).toBe(true);

    // Second sign-in: verify step. The code used for enrollment must not be accepted again.
    const c2 = new Client(app);
    const second = await passwordLogin(c2, u.email);
    expect(second.body.status).toBe('mfa_required');
    const replay = await c2.post('/auth/mfa/verify', { mfaToken: second.body.mfaToken, code });
    expect(replay.status).toBe(401);

    // Next time-step's code works (simulates waiting 30 s).
    const next = totp(secret, Date.now() + 30_000);
    const verified = await c2.post('/auth/mfa/verify', { mfaToken: second.body.mfaToken, code: next });
    expect(verified.body).toEqual({ status: 'ok' });
    const session = await prisma.session.findFirstOrThrow({ where: { userId: u.id, authMethod: 'password+totp' }, orderBy: { createdAt: 'desc' } });
    expect(session.revokedAt).toBeNull();
  });

  it('rejects a forged or wrong-stage MFA token', async () => {
    const r = await new Client(app).post('/auth/mfa/verify', { mfaToken: 'abc.def', code: '123456' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('MFA_TOKEN_INVALID');
  });

  it('does not let admins disable mandatory MFA', async () => {
    const u = await makeUser({ role: 'MD' });
    const c = await clientAs(app, u.id);
    expect((await c.del('/auth/mfa/self')).status).toBe(403);
  });
});

type Claims = (nonce: string) => Record<string, unknown>;

/** Runs start → provider → callback against the local issuer and returns the final redirect. */
async function ssoAttempt(
  provider: 'google' | 'microsoft',
  claims: Claims,
  opts: { code?: string; tamperState?: boolean; iss?: string } = {},
) {
  const c = new Client(app);
  const start = await c.get(`/auth/sso/${provider}/start`);
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.location as string);
  expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
  expect(loc.searchParams.get('redirect_uri')).toBe(`${APP_URL}/api/v1/auth/sso/${provider}/callback`);
  const built = claims(loc.searchParams.get('nonce')!);
  nextClaims = built;
  nextAudience = provider === 'google' ? 'test-google-client' : 'test-ms-client';
  nextIssuer = opts.iss ?? (provider === 'google' ? 'https://accounts.google.com' : `https://login.microsoftonline.com/${String(built.tid)}/v2.0`);
  const state = opts.tamperState ? 'not-the-state' : loc.searchParams.get('state')!;
  const cb = await c.get(`/auth/sso/${provider}/callback?code=${opts.code ?? 'good-code'}&state=${encodeURIComponent(state)}`);
  expect(cb.status).toBe(302);
  return { c, location: cb.headers.location as string };
}

const googleClaims =
  (email: string, sub: string, extra: Record<string, unknown> = {}): Claims =>
  (nonce) => ({ sub, email, email_verified: true, hd: DOMAIN, name: 'SSO Person', nonce, ...extra });

const msClaims =
  (email: string, oid: string, tid = MS_TENANT): Claims =>
  (nonce) => ({ sub: `s-${oid}`, oid, tid, email, preferred_username: email, name: 'SSO Person', nonce });

/** A unique address on a consumer domain. */
const personalEmail = (domain: string) => uniqueEmail('p').replace(/@.*/, `@${domain}`);

describe('Google SSO (local OIDC issuer)', () => {
  it('signs in an invited employee, activates them and links the identity', async () => {
    const u = await makeUser({ role: 'EMPLOYEE', status: 'INVITED' });
    const { c, location } = await ssoAttempt('google', googleClaims(u.email, `g-${u.id}`));
    expect(location).toBe(`${APP_URL}/`);
    expect((await c.get('/auth/me')).body.user.id).toBe(u.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).status).toBe('ACTIVE');
    expect(await prisma.userIdentity.count({ where: { userId: u.id, provider: 'google' } })).toBe(1);

    // Second sign-in matches by provider subject, even if the email claim changed.
    const again = await ssoAttempt('google', googleClaims(u.email, `g-${u.id}`));
    expect(again.location).toBe(`${APP_URL}/`);
  });

  it('signs in an invited employee with a personal Gmail account', async () => {
    const u = await makeUser({ role: 'EMPLOYEE', status: 'INVITED', email: personalEmail('gmail.com') });
    const { c, location } = await ssoAttempt('google', googleClaims(u.email, `g-${u.id}`, { hd: undefined }));
    expect(location).toBe(`${APP_URL}/`);
    expect((await c.get('/auth/me')).body.user.id).toBe(u.id);
  });

  it('rejects people who were not invited, including Gmail users', async () => {
    expect((await ssoAttempt('google', googleClaims(uniqueEmail('stranger'), 'g-stranger'))).location).toBe(`${APP_URL}/login?error=not_invited`);
    const gmail = personalEmail('gmail.com');
    expect((await ssoAttempt('google', googleClaims(gmail, 'g-stranger2', { hd: undefined }))).location).toBe(`${APP_URL}/login?error=not_invited`);
  });

  it('rejects consumer Google accounts that use a company or non-Gmail address', async () => {
    const u = await makeUser({ role: 'EMPLOYEE', status: 'INVITED' });
    expect((await ssoAttempt('google', googleClaims(u.email, `g2-${u.id}`, { hd: undefined }))).location).toBe(`${APP_URL}/login?error=domain_not_allowed`);
    const yahoo = personalEmail('yahoo.com');
    expect((await ssoAttempt('google', googleClaims(yahoo, 'g-yahoo', { hd: undefined }))).location).toBe(`${APP_URL}/login?error=domain_not_allowed`);
  });

  it("rejects another company's Workspace and unverified emails", async () => {
    const u = await makeUser({ role: 'EMPLOYEE', status: 'INVITED' });
    expect((await ssoAttempt('google', googleClaims(u.email, 'x', { hd: 'other.example' }))).location).toContain('error=domain_not_allowed');
    expect((await ssoAttempt('google', googleClaims(u.email, 'x', { email_verified: false }))).location).toContain('error=email_unverified');
  });

  it('rejects a tampered state, a wrong nonce and a failed code exchange', async () => {
    const u = await makeUser({ role: 'EMPLOYEE', status: 'INVITED' });
    expect((await ssoAttempt('google', googleClaims(u.email, 'x'), { tamperState: true })).location).toContain('error=invalid_state');
    expect((await ssoAttempt('google', () => googleClaims(u.email, 'x')('wrong-nonce'))).location).toContain('error=invalid_nonce');
    expect((await ssoAttempt('google', googleClaims(u.email, 'x'), { code: 'bad-code' })).location).toContain('error=token_exchange_failed');
  });

  it('rejects suspended employees', async () => {
    const u = await makeUser({ role: 'EMPLOYEE', status: 'SUSPENDED' });
    const { location } = await ssoAttempt('google', googleClaims(u.email, `g-${u.id}`));
    expect(location).toContain('error=account_suspended');
  });
});

describe('Microsoft SSO (local OIDC issuer, multi-tenant authority)', () => {
  it('signs in an invited employee from the company tenant', async () => {
    const u = await makeUser({ role: 'EMPLOYEE', status: 'INVITED' });
    const { c, location } = await ssoAttempt('microsoft', msClaims(u.email, `o-${u.id}`));
    expect(location).toBe(`${APP_URL}/`);
    expect((await c.get('/auth/me')).body.user.id).toBe(u.id);
    const ident = await prisma.userIdentity.findFirstOrThrow({ where: { userId: u.id, provider: 'microsoft' } });
    expect(ident.providerSubject).toBe(`${MS_TENANT}:o-${u.id}`);
  });

  it('signs in an invited employee with a personal Outlook.com account', async () => {
    const u = await makeUser({ role: 'EMPLOYEE', status: 'INVITED', email: personalEmail('outlook.com') });
    const { location } = await ssoAttempt('microsoft', msClaims(u.email, `o-${u.id}`, MSA_TENANT));
    expect(location).toBe(`${APP_URL}/`);
  });

  it("rejects other companies' tenants, even for an invited address", async () => {
    const u = await makeUser({ role: 'EMPLOYEE', status: 'INVITED' });
    const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect((await ssoAttempt('microsoft', msClaims(u.email, 'o-x', other))).location).toContain('error=tenant_not_allowed');
  });

  it('rejects a personal Microsoft account that uses a company or non-Microsoft address', async () => {
    const u = await makeUser({ role: 'EMPLOYEE', status: 'INVITED' });
    expect((await ssoAttempt('microsoft', msClaims(u.email, 'o-y', MSA_TENANT))).location).toContain('error=domain_not_allowed');
    const gmail = await makeUser({ role: 'EMPLOYEE', status: 'INVITED', email: personalEmail('gmail.com') });
    expect((await ssoAttempt('microsoft', msClaims(gmail.email, 'o-z', MSA_TENANT))).location).toContain('error=domain_not_allowed');
  });

  it('rejects a token whose issuer does not match its tenant', async () => {
    const u = await makeUser({ role: 'EMPLOYEE', status: 'INVITED' });
    const forged = `https://login.microsoftonline.com/${MSA_TENANT}/v2.0`;
    expect((await ssoAttempt('microsoft', msClaims(u.email, 'o-w'), { iss: forged })).location).toContain('error=invalid_id_token');
  });
});

describe('personal accounts switched off (PERSONAL_ACCOUNT_LOGIN=false)', () => {
  const [google, microsoft] = buildSsoProviders(testConfig({ ...SSO_ENV, PERSONAL_ACCOUNT_LOGIN: 'false' }));
  const claimsOf = (p: SsoProviderConfig | undefined, c: Claims) => p!.claims(c('n'));

  it('accepts only the company Workspace and tenant', () => {
    expect(claimsOf(google, googleClaims('a@gmail.com', 's', { hd: undefined }))).toEqual({ error: 'domain_not_allowed' });
    expect(claimsOf(microsoft, msClaims('a@outlook.com', 'o', MSA_TENANT))).toEqual({ error: 'tenant_not_allowed' });
    expect(claimsOf(google, googleClaims(`a@${DOMAIN}`, 's'))).toMatchObject({ email: `a@${DOMAIN}` });
    expect(claimsOf(microsoft, msClaims(`a@${DOMAIN}`, 'o'))).toMatchObject({ subject: `${MS_TENANT}:o` });
  });

  it('uses the single-tenant authority and hints the company domain', () => {
    expect(microsoft!.authorizationEndpoint).toBe(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize`);
    expect(google!.extraAuthParams).toMatchObject({ hd: DOMAIN });
  });

  it('refuses to invite personal addresses', async () => {
    const { app: strict } = await bootApp({ env: { PERSONAL_ACCOUNT_LOGIN: 'false' } });
    try {
      const admin = await makeUser({ role: 'SUPER_ADMIN' });
      const role = await prisma.role.findUniqueOrThrow({ where: { key: 'EMPLOYEE' } });
      const r = await (await clientAs(strict, admin.id)).post('/users', { email: personalEmail('gmail.com'), name: 'Gmail Person', roleId: role.id });
      expect(r.status).toBe(422);
    } finally {
      await strict.close();
    }
  });
});

describe('inviting personal addresses (default)', () => {
  it('accepts Gmail and Outlook addresses but not other consumer domains', async () => {
    const admin = await makeUser({ role: 'SUPER_ADMIN' });
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'EMPLOYEE' } });
    const c = await clientAs(app, admin.id);
    const invite = (email: string) => c.post('/users', { email, name: 'Personal Person', roleId: role.id });
    expect((await invite(personalEmail('gmail.com'))).status).toBe(201);
    expect((await invite(personalEmail('hotmail.co.uk'))).status).toBe(201);
    const bad = await invite(personalEmail('yahoo.com'));
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body.error.details)).toContain('Gmail');
  });

  it('reports a disabled provider as not found', async () => {
    const { app: none } = await bootApp();
    try {
      expect((await new Client(none).get('/auth/sso/microsoft/start')).status).toBe(404);
    } finally {
      await none.close();
    }
  });
});

describe('one-time password links', () => {
  it('lets an invited employee set a password once', async () => {
    const admin = await makeUser({ role: 'SUPER_ADMIN' });
    const u = await makeUser({ role: 'EMPLOYEE', status: 'INVITED' });
    const ac = await clientAs(app, admin.id);
    const link = await ac.post(`/users/${u.id}/password-link`);
    expect(link.status).toBe(200);
    const token = new URL(link.body.url).searchParams.get('token')!;
    expect(await prisma.userActionToken.count({ where: { tokenHash: token } })).toBe(0); // only the hash is stored

    const c = new Client(app);
    expect((await c.post('/auth/password/set', { token, password: 'short' })).status).toBe(422);
    expect((await c.post('/auth/password/set', { token, password: PASSWORD })).status).toBe(204);
    expect((await c.post('/auth/password/set', { token, password: PASSWORD })).status).toBe(400);
    expect((await passwordLogin(new Client(app), u.email)).body).toEqual({ status: 'ok' });
  });
});

describe('sessions', () => {
  it('lists own sessions and revokes another one', async () => {
    const u = await makeUser({ role: 'EMPLOYEE', passwordHash: pwHash });
    const a = new Client(app);
    const b = new Client(app);
    await passwordLogin(a, u.email);
    await passwordLogin(b, u.email);
    const list = await a.get('/auth/sessions');
    expect(list.body).toHaveLength(2);
    const other = list.body.find((s: { current: boolean }) => !s.current);
    expect((await a.del(`/auth/sessions/${other.id}`)).status).toBe(204);
    expect((await b.get('/auth/me')).status).toBe(401);
    expect((await a.get('/auth/me')).status).toBe(200);
  });

  it('expires idle sessions', async () => {
    const u = await makeUser({ role: 'EMPLOYEE' });
    const c = await clientAs(app, u.id);
    await prisma.session.updateMany({ where: { userId: u.id }, data: { lastSeenAt: new Date(Date.now() - 13 * 3_600_000) } });
    expect((await c.get('/auth/me')).status).toBe(401);
  });
});
