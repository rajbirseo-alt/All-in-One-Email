import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { randomToken, safeEqual, signToken, verifyToken } from '@crm/crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { domainOf, isMicrosoftConsumerDomain, MICROSOFT_CONSUMER_TENANT_ID, PERSONAL_GOOGLE_DOMAINS } from './login-policy';

export type SsoProviderId = 'google' | 'microsoft';

export interface SsoClaims {
  subject: string;
  email: string;
  name: string | null;
}

export interface SsoProviderConfig {
  id: SsoProviderId;
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Exact issuer, or a check for multi-tenant authorities whose issuer varies per account. */
  issuer: string | ((iss: string, p: JWTPayload) => boolean);
  jwks: JWTVerifyGetKey;
  extraAuthParams?: Record<string, string>;
  /** Maps verified id_token claims to an identity, or returns an error code. */
  claims(p: JWTPayload): SsoClaims | { error: string };
}

export const SSO_PROVIDERS = Symbol('SSO_PROVIDERS');

export class SsoError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Builds the real Google / Microsoft OIDC configs from env. Providers without credentials are omitted. */
export function buildSsoProviders(cfg: AppConfig): SsoProviderConfig[] {
  const out: SsoProviderConfig[] = [];
  const allowed = new Set(cfg.ALLOWED_LOGIN_DOMAINS);
  const personal = cfg.PERSONAL_ACCOUNT_LOGIN;
  const nameOf = (p: JWTPayload) => (typeof p.name === 'string' ? p.name : null);

  if (cfg.googleEnabled) {
    // `hd` only pre-selects the account chooser; the hd claim is re-checked on the token below.
    const hdHint: Record<string, string> = !personal && cfg.ALLOWED_LOGIN_DOMAINS.length === 1 ? { hd: cfg.ALLOWED_LOGIN_DOMAINS[0]! } : {};
    out.push({
      id: 'google',
      clientId: cfg.GOOGLE_CLIENT_ID!,
      clientSecret: cfg.GOOGLE_CLIENT_SECRET!,
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      issuer: 'https://accounts.google.com',
      jwks: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
      extraAuthParams: { ...hdHint, prompt: 'select_account' },
      claims: (p) => {
        const email = String(p.email ?? '').toLowerCase();
        if (p.email_verified !== true) return { error: 'email_unverified' };
        const d = domainOf(email);
        if (typeof p.hd === 'string') {
          // Workspace account: must be the company's Workspace, with a company address.
          if (!allowed.has(p.hd.toLowerCase()) || !allowed.has(d)) return { error: 'domain_not_allowed' };
        } else if (!(personal && PERSONAL_GOOGLE_DOMAINS.has(d))) {
          // Consumer Google account: only real Gmail addresses. A consumer account that merely
          // uses a company (or any other) address is not proof of owning that mailbox.
          return { error: 'domain_not_allowed' };
        }
        return { subject: String(p.sub), email, name: nameOf(p) };
      },
    });
  }

  if (cfg.microsoftEnabled) {
    const tenant = cfg.MICROSOFT_TENANT_ID!.toLowerCase();
    // Personal Microsoft accounts need the multi-tenant `common` authority (the app registration
    // must allow "work/school and personal accounts"). Tenants are still restricted below.
    const authority = personal ? 'common' : tenant;
    const base = `https://login.microsoftonline.com/${authority}`;
    const tenants = new Set(personal ? [tenant, MICROSOFT_CONSUMER_TENANT_ID] : [tenant]);
    out.push({
      id: 'microsoft',
      clientId: cfg.MICROSOFT_CLIENT_ID!,
      clientSecret: cfg.MICROSOFT_CLIENT_SECRET!,
      authorizationEndpoint: `${base}/oauth2/v2.0/authorize`,
      tokenEndpoint: `${base}/oauth2/v2.0/token`,
      // With `common` the issuer embeds the account's tenant, so it is checked per token.
      issuer: (iss, p) => typeof p.tid === 'string' && iss === `https://login.microsoftonline.com/${p.tid}/v2.0`,
      jwks: createRemoteJWKSet(new URL(`${base}/discovery/v2.0/keys`)),
      extraAuthParams: { prompt: 'select_account' },
      claims: (p) => {
        const tid = String(p.tid ?? '').toLowerCase();
        if (!tenants.has(tid)) return { error: 'tenant_not_allowed' };
        const email = String(p.email ?? p.preferred_username ?? '').toLowerCase();
        if (!email.includes('@')) return { error: 'domain_not_allowed' };
        const d = domainOf(email);
        if (tid === tenant) {
          if (!allowed.has(d)) return { error: 'domain_not_allowed' };
        } else if (!isMicrosoftConsumerDomain(d)) {
          // Personal Microsoft account: only Outlook.com/Hotmail/Live addresses, which Microsoft owns.
          return { error: 'domain_not_allowed' };
        }
        const oid = typeof p.oid === 'string' ? p.oid : String(p.sub);
        return { subject: `${tid}:${oid}`, email, name: nameOf(p) };
      },
    });
  }
  return out;
}

interface StatePayload extends Record<string, unknown> {
  p: SsoProviderId;
  state: string;
  nonce: string;
  verifier: string;
}

@Injectable()
export class SsoService {
  private readonly log = new Logger(SsoService.name);
  private readonly byId: Map<SsoProviderId, SsoProviderConfig>;

  constructor(
    @Inject(SSO_PROVIDERS) providers: SsoProviderConfig[],
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    this.byId = new Map(providers.map((p) => [p.id, p]));
  }

  enabled(id: SsoProviderId) {
    return this.byId.has(id);
  }

  redirectUri(id: SsoProviderId) {
    return `${this.cfg.appOrigin}/api/v1/auth/sso/${id}/callback`;
  }

  /** Authorization Code + PKCE + state + nonce. The returned cookie value carries the secrets, signed. */
  start(id: SsoProviderId): { url: string; stateCookie: string } {
    const p = this.byId.get(id);
    if (!p) throw new SsoError('provider_disabled');
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
      client_id: p.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri(id),
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...p.extraAuthParams,
    });
    const stateCookie = signToken({ p: id, state, nonce, verifier } satisfies StatePayload, 'oauth-state', 10 * 60_000, this.cfg.SESSION_SECRET);
    return { url: `${p.authorizationEndpoint}?${params.toString()}`, stateCookie };
  }

  async complete(id: SsoProviderId, query: { code?: string; state?: string; error?: string }, stateCookie: string | undefined): Promise<SsoClaims> {
    const p = this.byId.get(id);
    if (!p) throw new SsoError('provider_disabled');
    if (query.error) throw new SsoError(query.error === 'access_denied' ? 'cancelled' : 'provider_error');
    const saved = stateCookie ? verifyToken<StatePayload>(stateCookie, 'oauth-state', this.cfg.SESSION_SECRET) : null;
    if (!saved || saved.p !== id || !query.state || !safeEqual(saved.state, query.state) || !query.code) {
      throw new SsoError('invalid_state');
    }

    const res = await fetch(p.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: query.code,
        redirect_uri: this.redirectUri(id),
        client_id: p.clientId,
        client_secret: p.clientSecret,
        code_verifier: saved.verifier,
      }),
    });
    if (!res.ok) {
      this.log.warn(`${id} token exchange failed: HTTP ${res.status}`);
      throw new SsoError('token_exchange_failed');
    }
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new SsoError('no_id_token');

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(body.id_token, p.jwks, {
        ...(typeof p.issuer === 'string' ? { issuer: p.issuer } : {}),
        audience: p.clientId,
        clockTolerance: 60,
      }));
      if (typeof p.issuer === 'function' && !p.issuer(String(payload.iss ?? ''), payload)) throw new Error('unexpected "iss" claim value');
    } catch (e) {
      this.log.warn(`${id} id_token rejected: ${(e as Error).message}`);
      throw new SsoError('invalid_id_token');
    }
    if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, saved.nonce)) throw new SsoError('invalid_nonce');
    const claims = p.claims(payload);
    if ('error' in claims) throw new SsoError(claims.error);
    return claims;
  }
}
