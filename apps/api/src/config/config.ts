import { z } from 'zod';
import { DateTime } from 'luxon';

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

    // ── Browser push notifications (Phase 6). Generate once with `npx web-push generate-vapid-keys`. ──
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    /** Contact the push services can reach, e.g. mailto:it@seodiscovery.com. Defaults to APP_URL. */
    VAPID_SUBJECT: z.string().optional(),
    /** AI (Phase 8). Off until a key is set. Email content of mailboxes with AI allowed is sent to this provider. */
    OPENAI_API_KEY: z.string().optional(),
    /** OpenAI-compatible endpoint (OpenAI, Azure OpenAI proxy, or the test fake). */
    OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
    /** Analyse new incoming mail automatically (summary, category, urgency, lead detection). */
    AI_AUTO_ANALYZE: bool.default('true'),
    /** One line about the company for reply suggestions. */
    AI_COMPANY_CONTEXT: z.string().max(1000).default('SEO Discovery is a digital marketing agency (SEO, PPC, social media, web design and development).'),
    /** Attachment storage (Phase 10): any S3-compatible bucket (AWS S3, Cloudflare R2, …). Off when S3_BUCKET is unset. */
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    /** Virus scanning (Phase 10): a clamd TCP endpoint. When set, every file is scanned and unscannable files are refused. */
    CLAMAV_HOST: z.string().optional(),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
    /** Reports (Phase 9): days, weeks and hourly buckets follow this zone. Changing it needs `npm run cli:analytics-rebuild`. */
    REPORT_TIMEZONE: z.string().default('Asia/Kolkata').refine((tz) => DateTime.now().setZone(tz).isValid, 'not a valid IANA time zone'),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production' && !c.APP_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'must be https in production' });
    }
    if (c.S3_BUCKET) {
      for (const k of ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) if (!c[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'required when S3_BUCKET is set' });
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
    if (!!c.VAPID_PUBLIC_KEY !== !!c.VAPID_PRIVATE_KEY) {
      ctx.addIssue({ code: 'custom', path: ['VAPID_PRIVATE_KEY'], message: 'set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY together' });
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
  /** Browser push is on when VAPID keys are configured. */
  webPushEnabled: boolean;
  /** AI features are on when an API key is configured. */
  aiEnabled: boolean;
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
    webPushEnabled: !!c.VAPID_PUBLIC_KEY && !!c.VAPID_PRIVATE_KEY,
    aiEnabled: !!c.OPENAI_API_KEY,
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
