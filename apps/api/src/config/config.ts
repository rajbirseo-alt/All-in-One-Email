import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  );

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(4000),
    DATABASE_URL: z.string().url(),
    /** Public origin of the web app, e.g. https://crm.seodiscovery.com. The API is reached via `${APP_URL}/api`. */
    APP_URL: z.string().url(),
    /** HMAC key for signed short-lived tokens (OAuth state, MFA step). ≥ 32 random bytes. */
    SESSION_SECRET: z.string().min(32),
    /** {"1":"<base64 32 bytes>"} — see packages/crypto/src/envelope.ts */
    ENCRYPTION_KEYS: z.string().min(10),
    ALLOWED_LOGIN_DOMAINS: csv,
    PASSWORD_LOGIN_ENABLED: bool.default('true'),
    /** Also allow invited employees on Gmail / personal Microsoft accounts (see auth/login-policy.ts). */
    PERSONAL_ACCOUNT_LOGIN: bool.default('true'),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    /** Entra ID tenant (directory) id of the company: the only work/school tenant allowed to sign in. */
    MICROSOFT_TENANT_ID: z.string().optional(),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
    SESSION_IDLE_HOURS: z.coerce.number().positive().default(12),
    SESSION_MAX_DAYS: z.coerce.number().positive().default(7),
    LOGIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(10),

    // ── Mailboxes (Phase 2). Connecting reuses GOOGLE_* / MICROSOFT_* client credentials. ──
    /** How far back the first sync of a new mailbox goes. */
    MAIL_INITIAL_SYNC_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    /** Mail content of a disconnected mailbox is deleted after this many days (decided: 120). */
    MAIL_RETENTION_DAYS: z.coerce.number().int().min(1).default(120),
    /** Gmail push: Pub/Sub topic, e.g. projects/my-project/topics/gmail-push. Without it Gmail is polled every 5 minutes. */
    GMAIL_PUBSUB_TOPIC: z.string().regex(/^projects\/[^/]+\/topics\/[^/]+$/, 'projects/<project>/topics/<topic>').optional(),
    /** Service account the Pub/Sub push subscription authenticates as (its OIDC token is verified). */
    GMAIL_PUSH_SERVICE_ACCOUNT: z.string().email().optional(),
    /** Audience configured on the push subscription. Defaults to the webhook URL. */
    GMAIL_PUSH_AUDIENCE: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production' && !c.APP_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'must be https in production' });
    }
    if (c.ALLOWED_LOGIN_DOMAINS.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['ALLOWED_LOGIN_DOMAINS'], message: 'set at least one company domain' });
    }
    if (!!c.GOOGLE_CLIENT_ID !== !!c.GOOGLE_CLIENT_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['GOOGLE_CLIENT_SECRET'], message: 'set both Google client id and secret' });
    }
    const ms = [c.MICROSOFT_CLIENT_ID, c.MICROSOFT_CLIENT_SECRET, c.MICROSOFT_TENANT_ID].filter(Boolean).length;
    if (ms !== 0 && ms !== 3) {
      ctx.addIssue({ code: 'custom', path: ['MICROSOFT_TENANT_ID'], message: 'set Microsoft client id, secret and tenant id together' });
    }
    if (!!c.GMAIL_PUBSUB_TOPIC !== !!c.GMAIL_PUSH_SERVICE_ACCOUNT) {
      ctx.addIssue({ code: 'custom', path: ['GMAIL_PUSH_SERVICE_ACCOUNT'], message: 'set GMAIL_PUBSUB_TOPIC and GMAIL_PUSH_SERVICE_ACCOUNT together' });
    }
  });

export type AppConfig = z.infer<typeof schema> & {
  isProd: boolean;
  googleEnabled: boolean;
  microsoftEnabled: boolean;
  appOrigin: string;
  /** Public URL that providers call back (webhooks reach the API through the web proxy). */
  webhookBaseUrl: string;
  /** Graph only delivers notifications to https endpoints. */
  graphPushEnabled: boolean;
  gmailPushEnabled: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // A blank value means "not set" (Render can pass empty strings for unset references).
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== '')));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  const c = parsed.data;
  return {
    ...c,
    isProd: c.NODE_ENV === 'production',
    googleEnabled: !!c.GOOGLE_CLIENT_ID,
    microsoftEnabled: !!c.MICROSOFT_CLIENT_ID,
    appOrigin: new URL(c.APP_URL).origin,
    webhookBaseUrl: `${new URL(c.APP_URL).origin}/api/v1/webhooks`,
    graphPushEnabled: !!c.MICROSOFT_CLIENT_ID && c.APP_URL.startsWith('https://'),
    gmailPushEnabled: !!c.GOOGLE_CLIENT_ID && !!c.GMAIL_PUBSUB_TOPIC,
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
