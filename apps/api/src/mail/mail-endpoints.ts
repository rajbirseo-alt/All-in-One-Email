import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import {
  GMAIL_API_BASE,
  GRAPH_API_BASE,
  googleMailOAuth,
  microsoftMailOAuth,
  type FetchFn,
  type MailOAuthClient,
  type MailProviderId,
} from '@crm/providers';
import type { AppConfig } from '../config/config';

/**
 * Where the mail module talks to. Production uses the real Google / Microsoft endpoints; the
 * end-to-end tests point these at local fake servers.
 */
export interface MailEndpoints {
  gmailApiBase: string;
  graphApiBase: string;
  oauth: Partial<Record<MailProviderId, MailOAuthClient>>;
  fetch: FetchFn;
  /** Verifies Pub/Sub push OIDC tokens (Google's keys). */
  googleJwks: JWTVerifyGetKey;
}

export const MAIL_ENDPOINTS = Symbol('MAIL_ENDPOINTS');

export function buildMailEndpoints(cfg: AppConfig): MailEndpoints {
  const oauth: MailEndpoints['oauth'] = {};
  if (cfg.googleEnabled) oauth.GMAIL = googleMailOAuth(cfg.GOOGLE_CLIENT_ID!, cfg.GOOGLE_CLIENT_SECRET!);
  if (cfg.microsoftEnabled) {
    // Same audience as sign-in: "common" when personal accounts are allowed, else the company tenant only.
    const authority = cfg.PERSONAL_ACCOUNT_LOGIN ? 'common' : cfg.MICROSOFT_TENANT_ID!;
    oauth.MICROSOFT = microsoftMailOAuth(cfg.MICROSOFT_CLIENT_ID!, cfg.MICROSOFT_CLIENT_SECRET!, authority);
  }
  return {
    gmailApiBase: GMAIL_API_BASE,
    graphApiBase: GRAPH_API_BASE,
    oauth,
    fetch: (...args) => fetch(...args),
    googleJwks: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
  };
}
