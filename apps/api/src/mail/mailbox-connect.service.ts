import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { newId, randomToken, safeEqual, signToken, verifyToken } from '@crm/crypto';
import {
  AuthError,
  GmailClient,
  GraphClient,
  ProviderHttp,
  buildAuthorizeUrl,
  testImapAccount,
  exchangeCode,
  type MailProviderId,
} from '@crm/providers';
import type { z } from 'zod';
import type { connectMailboxSchema, imapAccountSchema, imapConnectSchema } from '@crm/shared';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import type { RequestContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialService } from './credential.service';
import { MAIL_ENDPOINTS, type MailEndpoints } from './mail-endpoints';
import { QueueService } from './queue.service';

export const MAILBOX_PROVIDER_PARAM: Record<string, MailProviderId> = { google: 'GMAIL', microsoft: 'MICROSOFT' };

interface ConnectState extends Record<string, unknown> {
  p: MailProviderId;
  state: string;
  verifier: string;
  /** The admin who started the flow; the callback must come from the same session user. */
  uid: string;
  dep: string | null;
  days: number;
}

/** Error codes shown on the Mailboxes page after a failed connect. */
export class ConnectError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

@Injectable()
export class MailboxConnectService {
  private readonly log = new Logger(MailboxConnectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    @Inject(MAIL_ENDPOINTS) private readonly endpoints: MailEndpoints,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  redirectUri(provider: MailProviderId) {
    return `${this.cfg.appOrigin}/api/v1/accounts/oauth/${provider === 'GMAIL' ? 'google' : 'microsoft'}/callback`;
  }

  /** Builds the provider consent URL and the signed state cookie (PKCE verifier inside). */
  async start(ctx: RequestContext, provider: MailProviderId, input: z.infer<typeof connectMailboxSchema>) {
    const client = this.endpoints.oauth[provider];
    if (!client) throw Errors.notFound('Mailbox provider');
    if (input.departmentId && !(await this.prisma.department.findUnique({ where: { id: input.departmentId } }))) {
      throw Errors.validation([{ path: 'departmentId', message: 'Unknown department' }]);
    }
    const verifier = randomToken(48);
    const payload: ConnectState = {
      p: provider,
      state: randomToken(24),
      verifier,
      uid: ctx.userId,
      dep: input.departmentId ?? null,
      days: input.syncDays ?? this.cfg.MAIL_INITIAL_SYNC_DAYS,
    };
    const url = buildAuthorizeUrl(client, {
      redirectUri: this.redirectUri(provider),
      state: payload.state,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    return { url, stateCookie: signToken(payload, 'mail-oauth-state', 10 * 60_000, this.cfg.SESSION_SECRET) };
  }

  /** Completes the consent: verifies state, stores encrypted tokens, creates or reconnects the mailbox. */
  async complete(
    ctx: RequestContext,
    provider: MailProviderId,
    query: { code?: string; state?: string; error?: string },
    stateCookie: string | undefined,
  ): Promise<string> {
    const client = this.endpoints.oauth[provider];
    if (!client) throw new ConnectError('provider_disabled');
    if (query.error) throw new ConnectError(query.error === 'access_denied' ? 'cancelled' : 'provider_error');
    const saved = stateCookie ? verifyToken<ConnectState>(stateCookie, 'mail-oauth-state', this.cfg.SESSION_SECRET) : null;
    if (!saved || saved.p !== provider || saved.uid !== ctx.userId || !query.state || !safeEqual(saved.state, query.state) || !query.code) {
      throw new ConnectError('invalid_state');
    }

    let tokens;
    try {
      tokens = await exchangeCode(client, { code: query.code, redirectUri: this.redirectUri(provider), codeVerifier: saved.verifier }, this.endpoints.fetch);
    } catch (e) {
      this.log.warn(`${provider} mailbox code exchange failed: ${(e as Error).message}`);
      throw new ConnectError('token_exchange_failed');
    }
    // Without a refresh token the mailbox would stop syncing within an hour.
    if (!tokens.refreshToken) throw new ConnectError('no_refresh_token');
    const refreshToken = tokens.refreshToken;
    const missing = client.scopes.filter((s) => !['openid', 'email', 'offline_access'].includes(s) && !tokens.scopes.some((g) => g.toLowerCase() === s.toLowerCase()));
    if (provider === 'GMAIL' && missing.length) throw new ConnectError('scope_not_granted');

    const http = new ProviderHttp(async () => tokens.accessToken, this.endpoints.fetch);
    let emailAddress: string;
    let displayName: string | null = null;
    try {
      if (provider === 'GMAIL') emailAddress = (await new GmailClient(http, this.endpoints.gmailApiBase).profile()).emailAddress;
      else ({ emailAddress, displayName } = await new GraphClient(http, this.endpoints.graphApiBase).me());
    } catch (e) {
      this.log.warn(`${provider} mailbox identity lookup failed: ${(e as Error).message}`);
      throw new ConnectError(e instanceof AuthError ? 'scope_not_granted' : 'provider_error');
    }
    if (!emailAddress.includes('@')) throw new ConnectError('no_mailbox');

    const syncFromDate = new Date(Date.now() - saved.days * 86_400_000);
    const accountId = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.emailAccount.findUnique({ where: { emailAddress }, include: { folders: { select: { deltaLink: true } } } });
      if (existing && existing.provider !== provider) throw new ConnectError('connected_with_other_provider');
      if (existing) {
        const fresh = !!existing.purgedAt;
        const hasCursor = !fresh && (!!existing.gmailHistoryId || existing.folders.some((f) => !!f.deltaLink));
        const data = {
          status: hasCursor ? ('ACTIVE' as const) : ('INITIAL_SYNC' as const),
          disconnectedAt: null,
          purgeAfter: null,
          purgedAt: null,
          lastError: null,
          lastErrorAt: null,
          consecutiveFailures: 0,
          ...(fresh ? { gmailHistoryId: null, syncFromDate, connectedById: ctx.userId } : {}),
        };
        if (fresh) await tx.emailFolder.updateMany({ where: { emailAccountId: existing.id }, data: { deltaLink: null } });
        await tx.emailAccount.update({ where: { id: existing.id }, data });
        await this.credentials.store(tx, existing.id, { ...tokens, refreshToken });
        await this.audit.record(tx, ctx, {
          action: 'account.reconnect',
          entityType: 'EmailAccount',
          entityId: existing.id,
          before: { status: existing.status },
          after: { status: data.status },
          metadata: { provider, emailAddress, scopes: tokens.scopes },
        });
        return existing.id;
      }
      const id = newId();
      await tx.emailAccount.create({
        data: {
          id,
          provider,
          emailAddress,
          displayName,
          departmentId: saved.dep,
          status: 'INITIAL_SYNC',
          connectedById: ctx.userId,
          syncFromDate,
        },
      });
      await this.credentials.store(tx, id, { ...tokens, refreshToken });
      await this.audit.record(tx, ctx, {
        action: 'account.connect',
        entityType: 'EmailAccount',
        entityId: id,
        after: { provider, emailAddress, departmentId: saved.dep, syncFromDate },
        metadata: { scopes: tokens.scopes },
      });
      return id;
    });
    await this.queue.enqueueSync(accountId, 'INITIAL');
    return accountId;
  }

  // ───────────── IMAP / SMTP (password) mailboxes ─────────────

  private imapCfg(input: z.infer<typeof imapAccountSchema>) {
    return { email: input.email, username: input.username, password: input.password, imap: input.imap, smtp: input.smtp };
  }

  /** DNS, IMAP sign-in over TLS, folder list, SMTP sign-in. Stores nothing. */
  async testImap(input: z.infer<typeof imapAccountSchema>) {
    const r = await testImapAccount(this.imapCfg(input), this.endpoints.imap);
    return { ok: r.ok, steps: r.steps, folders: r.folders.map((f) => ({ name: f.name, type: f.type })) };
  }

  /**
   * Connects (or reconnects) an IMAP mailbox. The connection test must pass first, so a wrong
   * password is never saved. The password is stored envelope-encrypted.
   */
  async connectImap(ctx: RequestContext, input: z.infer<typeof imapConnectSchema>) {
    if (input.departmentId && !(await this.prisma.department.findUnique({ where: { id: input.departmentId } }))) {
      throw Errors.validation([{ path: 'departmentId', message: 'Unknown department' }]);
    }
    const existing = await this.prisma.emailAccount.findUnique({ where: { emailAddress: input.email } });
    if (existing && existing.provider !== 'IMAP') throw Errors.conflict('This address is already connected through Google or Microsoft', 'CONNECTED_WITH_OTHER_PROVIDER');
    const test = await this.testImap(input);
    if (!test.ok) throw Errors.validation(test.steps.filter((s) => !s.ok).map((s) => ({ path: s.step, message: s.message })), 'The connection test failed');

    const cfg = this.imapCfg(input);
    const syncFromDate = new Date(Date.now() - (input.syncDays ?? this.cfg.MAIL_INITIAL_SYNC_DAYS) * 86_400_000);
    const accountId = await this.prisma.$transaction(async (tx) => {
      if (existing) {
        const fresh = !!existing.purgedAt;
        const data = {
          status: fresh ? ('INITIAL_SYNC' as const) : ('ACTIVE' as const),
          disconnectedAt: null,
          purgeAfter: null,
          purgedAt: null,
          lastError: null,
          lastErrorAt: null,
          consecutiveFailures: 0,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(fresh ? { syncFromDate, connectedById: ctx.userId } : {}),
        };
        // After a purge every folder cursor starts again.
        if (fresh) await tx.emailFolder.updateMany({ where: { emailAccountId: existing.id }, data: { uidValidity: null, lastUid: null, highestModSeq: null } });
        await tx.emailAccount.update({ where: { id: existing.id }, data });
        await this.credentials.storePassword(tx, existing.id, cfg);
        await this.audit.record(tx, ctx, {
          action: 'account.reconnect',
          entityType: 'EmailAccount',
          entityId: existing.id,
          before: { status: existing.status },
          after: { status: data.status },
          metadata: { provider: 'IMAP', emailAddress: input.email, imapHost: input.imap.host, smtpHost: input.smtp.host },
        });
        return existing.id;
      }
      const id = newId();
      await tx.emailAccount.create({
        data: { id, provider: 'IMAP', emailAddress: input.email, displayName: input.displayName ?? null, departmentId: input.departmentId ?? null, status: 'INITIAL_SYNC', connectedById: ctx.userId, syncFromDate },
      });
      await this.credentials.storePassword(tx, id, cfg);
      await this.audit.record(tx, ctx, {
        action: 'account.connect',
        entityType: 'EmailAccount',
        entityId: id,
        after: { provider: 'IMAP', emailAddress: input.email, departmentId: input.departmentId ?? null, syncFromDate, imapHost: input.imap.host, smtpHost: input.smtp.host },
      });
      return id;
    });
    await this.queue.enqueueSync(accountId, existing && !existing.purgedAt ? 'POLL' : 'INITIAL');
    return accountId;
  }

  /** Saved server settings for the reconnect form (never the password). */
  async imapSettings(accountId: string) {
    const c = await this.prisma.emailCredential.findUnique({ where: { emailAccountId: accountId }, include: { emailAccount: { select: { provider: true } } } });
    if (!c || c.emailAccount.provider !== 'IMAP' || !c.imapHost || !c.smtpHost) throw Errors.notFound('IMAP settings');
    return {
      username: c.username ?? '',
      imap: { host: c.imapHost, port: c.imapPort ?? 993, security: c.imapSecurity ?? 'TLS' },
      smtp: { host: c.smtpHost, port: c.smtpPort ?? 465, security: c.smtpSecurity ?? 'TLS' },
    };
  }
}
