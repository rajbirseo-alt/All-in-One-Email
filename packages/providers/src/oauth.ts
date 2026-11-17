import { AuthError, ProviderRequestError, TransientError } from './errors';
import { mapError, safeJson, type FetchFn } from './http';
import type { MailProviderId, TokenSet } from './types';

/**
 * OAuth for connecting a MAILBOX (offline access to mail), separate from employee sign-in.
 * The same Google / Entra app registrations are reused with an extra redirect URI.
 */
export interface MailOAuthClient {
  provider: MailProviderId;
  clientId: string;
  clientSecret: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  /** Google only. Microsoft has no per-token revocation endpoint. */
  revokeEndpoint: string | null;
  scopes: string[];
  extraAuthParams: Record<string, string>;
}

export const GMAIL_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify'];
export const GRAPH_SCOPES = ['openid', 'email', 'offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'];

export function googleMailOAuth(clientId: string, clientSecret: string): MailOAuthClient {
  return {
    provider: 'GMAIL',
    clientId,
    clientSecret,
    authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
    scopes: GMAIL_SCOPES,
    // offline + consent: Google only returns a refresh token on a consented offline grant.
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  };
}

/** `authority`: "common" (work/school + personal) or a tenant id. */
export function microsoftMailOAuth(clientId: string, clientSecret: string, authority = 'common'): MailOAuthClient {
  const base = `https://login.microsoftonline.com/${authority}/oauth2/v2.0`;
  return {
    provider: 'MICROSOFT',
    clientId,
    clientSecret,
    authorizeEndpoint: `${base}/authorize`,
    tokenEndpoint: `${base}/token`,
    revokeEndpoint: null,
    scopes: GRAPH_SCOPES,
    extraAuthParams: { prompt: 'select_account' },
  };
}

export function buildAuthorizeUrl(c: MailOAuthClient, p: { redirectUri: string; state: string; codeChallenge: string; loginHint?: string }) {
  const q = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: p.redirectUri,
    scope: c.scopes.join(' '),
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256',
    ...c.extraAuthParams,
    ...(p.loginHint ? { login_hint: p.loginHint } : {}),
  });
  return `${c.authorizeEndpoint}?${q.toString()}`;
}

async function tokenRequest(c: MailOAuthClient, form: Record<string, string>, fetchImpl: FetchFn): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetchImpl(c.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...form }),
    });
  } catch (e) {
    throw new TransientError(`Token endpoint unreachable: ${(e as Error).message}`);
  }
  const body = safeJson(await res.text()) as Record<string, unknown>;
  if (!res.ok) {
    // invalid_grant = revoked, expired (incl. Google's 7-day limit for apps in Testing) or password changed.
    if (body?.error === 'invalid_grant' || body?.error === 'unauthorized_client' || body?.error === 'interaction_required') {
      throw new AuthError(`${String(body.error)}: ${String(body.error_description ?? '')}`.trim(), res.status);
    }
    throw mapError(res.status, body, res.headers.get('retry-after'));
  }
  if (typeof body.access_token !== 'string') throw new ProviderRequestError('Token response without access_token');
  const expiresIn = Number(body.expires_in ?? 3600);
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : c.scopes,
  };
}

export function exchangeCode(c: MailOAuthClient, p: { code: string; redirectUri: string; codeVerifier: string }, fetchImpl: FetchFn = fetch) {
  return tokenRequest(c, { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier }, fetchImpl);
}

export function refreshAccessToken(c: MailOAuthClient, refreshToken: string, fetchImpl: FetchFn = fetch) {
  const form: Record<string, string> = { grant_type: 'refresh_token', refresh_token: refreshToken };
  if (c.provider === 'MICROSOFT') form.scope = c.scopes.join(' ');
  return tokenRequest(c, form, fetchImpl);
}

/** Best effort: returns false when the provider has no revocation endpoint or the call failed. */
export async function revokeToken(c: MailOAuthClient, token: string, fetchImpl: FetchFn = fetch): Promise<boolean> {
  if (!c.revokeEndpoint) return false;
  try {
    const res = await fetchImpl(c.revokeEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    // 400 invalid_token = already revoked/expired, which is the desired end state.
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}
