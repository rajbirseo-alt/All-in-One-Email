import { Inject, Injectable } from '@nestjs/common';
import { Envelope, newId } from '@crm/crypto';
import { AuthError, ImapClient, ProviderHttp, refreshAccessToken, type AccessTokenSource, type ImapAccountConfig, type MailProviderId, type TokenSet } from '@crm/providers';
import { ENVELOPE } from '../crypto.provider';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { MAIL_ENDPOINTS, type MailEndpoints } from './mail-endpoints';

interface StoredTokens {
  refreshToken: string;
  accessToken: string;
  expiresAt: string;
}

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Mailbox OAuth tokens, envelope-encrypted (AES-256-GCM, versioned master key) with the account
 * id bound as additional authenticated data. Plaintext tokens only exist in memory during a call.
 */
@Injectable()
export class CredentialService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENVELOPE) private readonly envelope: Envelope,
    @Inject(MAIL_ENDPOINTS) private readonly endpoints: MailEndpoints,
  ) {}

  private context(accountId: string) {
    return `email-credential:${accountId}`;
  }

  async store(tx: Tx, accountId: string, tokens: TokenSet & { refreshToken: string }) {
    const payload: StoredTokens = { refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt.toISOString() };
    const blob = await this.envelope.encrypt(JSON.stringify(payload), this.context(accountId));
    const data = {
      kind: 'OAUTH' as const,
      ciphertext: new Uint8Array(blob.ciphertext),
      iv: new Uint8Array(blob.iv),
      authTag: new Uint8Array(blob.authTag),
      wrappedDataKey: new Uint8Array(blob.wrappedDataKey),
      keyId: blob.keyId,
      keyVersion: blob.keyVersion,
      scopes: tokens.scopes,
      accessTokenExpiresAt: tokens.expiresAt,
    };
    await tx.emailCredential.upsert({
      where: { emailAccountId: accountId },
      create: { id: newId(), emailAccountId: accountId, ...data },
      update: { ...data, rotatedAt: new Date() },
    });
  }

  /**
   * IMAP/SMTP: the password is encrypted like OAuth tokens; host, port and security are not
   * secret and sit in plain columns so the settings form can show them.
   */
  async storePassword(tx: Tx, accountId: string, cfg: Omit<ImapAccountConfig, 'email'>) {
    const blob = await this.envelope.encrypt(JSON.stringify({ password: cfg.password }), this.context(accountId));
    const data = {
      kind: 'PASSWORD' as const,
      ciphertext: new Uint8Array(blob.ciphertext),
      iv: new Uint8Array(blob.iv),
      authTag: new Uint8Array(blob.authTag),
      wrappedDataKey: new Uint8Array(blob.wrappedDataKey),
      keyId: blob.keyId,
      keyVersion: blob.keyVersion,
      scopes: [],
      accessTokenExpiresAt: null,
      username: cfg.username,
      imapHost: cfg.imap.host,
      imapPort: cfg.imap.port,
      imapSecurity: cfg.imap.security,
      smtpHost: cfg.smtp.host,
      smtpPort: cfg.smtp.port,
      smtpSecurity: cfg.smtp.security,
    };
    await tx.emailCredential.upsert({
      where: { emailAccountId: accountId },
      create: { id: newId(), emailAccountId: accountId, ...data },
      update: { ...data, rotatedAt: new Date() },
    });
  }

  /** Decrypted IMAP/SMTP settings; AuthError when there is no password (disconnected). */
  async imapConfig(accountId: string): Promise<ImapAccountConfig> {
    const c = await this.prisma.emailCredential.findUnique({ where: { emailAccountId: accountId }, include: { emailAccount: { select: { emailAddress: true } } } });
    if (!c || c.kind !== 'PASSWORD' || !c.imapHost || !c.smtpHost) throw new AuthError('No stored password (mailbox disconnected)');
    const { password } = JSON.parse((await this.decrypt(c, accountId)).toString('utf8')) as { password: string };
    return {
      email: c.emailAccount.emailAddress,
      username: c.username ?? c.emailAccount.emailAddress,
      password,
      imap: { host: c.imapHost, port: c.imapPort ?? 993, security: c.imapSecurity ?? 'TLS' },
      smtp: { host: c.smtpHost, port: c.smtpPort ?? 465, security: c.smtpSecurity ?? 'TLS' },
    };
  }

  async imap(accountId: string) {
    return new ImapClient(await this.imapConfig(accountId), this.endpoints.imap);
  }

  private decrypt(c: { ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array; wrappedDataKey: Uint8Array; keyId: string; keyVersion: number }, accountId: string) {
    return this.envelope.decrypt(
      { ciphertext: Buffer.from(c.ciphertext), iv: Buffer.from(c.iv), authTag: Buffer.from(c.authTag), wrappedDataKey: Buffer.from(c.wrappedDataKey), keyId: c.keyId, keyVersion: c.keyVersion },
      this.context(accountId),
    );
  }

  private async load(accountId: string): Promise<StoredTokens> {
    const c = await this.prisma.emailCredential.findUnique({ where: { emailAccountId: accountId } });
    if (!c) throw new AuthError('No stored credential (mailbox disconnected)');
    const plain = await this.envelope.decrypt(
      {
        ciphertext: Buffer.from(c.ciphertext),
        iv: Buffer.from(c.iv),
        authTag: Buffer.from(c.authTag),
        wrappedDataKey: Buffer.from(c.wrappedDataKey),
        keyId: c.keyId,
        keyVersion: c.keyVersion,
      },
      this.context(accountId),
    );
    return JSON.parse(plain.toString('utf8')) as StoredTokens;
  }

  /** Decrypted refresh token, for revocation on disconnect. */
  async refreshTokenOf(accountId: string): Promise<string | null> {
    try {
      return (await this.load(accountId)).refreshToken;
    } catch {
      return null;
    }
  }

  /** A token source for provider clients: refreshes ahead of expiry, or when forced after a 401. */
  tokenSource(accountId: string, provider: MailProviderId): AccessTokenSource {
    return async (force) => {
      const t = await this.load(accountId);
      if (!force && new Date(t.expiresAt).getTime() - Date.now() > REFRESH_MARGIN_MS) return t.accessToken;
      const client = this.endpoints.oauth[provider];
      if (!client) throw new AuthError(`${provider} sign-in is not configured on this server`);
      const fresh = await refreshAccessToken(client, t.refreshToken, this.endpoints.fetch);
      // Microsoft rotates refresh tokens; Google keeps the original one.
      await this.store(this.prisma, accountId, { ...fresh, refreshToken: fresh.refreshToken ?? t.refreshToken });
      return fresh.accessToken;
    };
  }

  http(accountId: string, provider: MailProviderId) {
    return new ProviderHttp(this.tokenSource(accountId, provider), this.endpoints.fetch);
  }
}
