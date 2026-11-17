import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { GMAIL_SCOPES, GRAPH_SCOPES, type MailOAuthClient } from '@crm/providers';
import type { MailEndpoints } from '../src/mail/mail-endpoints';

/**
 * Local stand-in for Google (OAuth, Gmail API) and Microsoft (OAuth, Graph) used by the
 * end-to-end tests. It speaks the same HTTP API shapes the real services document; it is a test
 * double, NOT proof of a working integration (that needs real mailboxes, see docs/06 §6).
 */

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

export interface GmailFakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  from: string;
  to: string;
  subject: string;
  text: string;
  date: Date;
  messageId: string;
  inReplyTo?: string;
  attachment?: { filename: string; mime: string; size: number };
}

export interface GraphFakeMessage {
  id: string;
  conversationId: string;
  folderId: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  received: Date;
  isRead: boolean;
  internetMessageId: string;
  attachments?: { id: string; name: string; contentType: string; size: number }[];
}

type GmailHistory = { id: number; added?: string[]; deleted?: string[]; labels?: string[] };

export class FakeMail {
  server!: Server;
  base = '';
  readonly calls: { method: string; path: string }[] = [];

  // OAuth
  /** code → identity the code was issued for. */
  codes = new Map<string, { provider: 'GMAIL' | 'MICROSOFT'; mailbox: string; noRefresh?: boolean; scope?: string }>();
  access = new Map<string, { provider: 'GMAIL' | 'MICROSOFT'; mailbox: string; expiresIn: number }>();
  refresh = new Map<string, { provider: 'GMAIL' | 'MICROSOFT'; mailbox: string }>();
  revoked: string[] = [];
  private seq = 0;
  /** Seconds until issued access tokens expire (tests set 0 to force refreshes). */
  accessTtl = 3600;

  // Gmail state per mailbox
  gmail = new Map<string, { messages: Map<string, GmailFakeMessage>; history: GmailHistory[]; historyId: number; oldestHistory: number; watches: number }>();
  // Graph state per mailbox
  graph = new Map<string, { messages: Map<string, GraphFakeMessage>; changes: { folderId: string; id: string; removed: boolean }[]; subs: Map<string, string> }>();

  // Pub/Sub OIDC signing
  private key!: CryptoKey;
  jwk!: JWK;

  async start() {
    const kp = await generateKeyPair('RS256');
    this.key = kp.privateKey as CryptoKey;
    this.jwk = { ...(await exportJWK(kp.publicKey)), kid: 'pubsub', alg: 'RS256' };
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        res.writeHead(500).end(JSON.stringify({ error: { message: String(e) } }));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop() {
    this.server.close();
  }

  endpoints(): MailEndpoints {
    const google: MailOAuthClient = {
      provider: 'GMAIL',
      clientId: 'g-client',
      clientSecret: 'g-secret',
      authorizeEndpoint: `${this.base}/google/authorize`,
      tokenEndpoint: `${this.base}/token`,
      revokeEndpoint: `${this.base}/revoke`,
      scopes: GMAIL_SCOPES,
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    };
    const microsoft: MailOAuthClient = {
      provider: 'MICROSOFT',
      clientId: 'ms-client',
      clientSecret: 'ms-secret',
      authorizeEndpoint: `${this.base}/ms/authorize`,
      tokenEndpoint: `${this.base}/token`,
      revokeEndpoint: null,
      scopes: GRAPH_SCOPES,
      extraAuthParams: {},
    };
    return {
      gmailApiBase: `${this.base}/gmail/v1/users/me`,
      graphApiBase: `${this.base}/graph/v1.0`,
      oauth: { GMAIL: google, MICROSOFT: microsoft },
      fetch: (...args) => fetch(...args),
      googleJwks: createLocalJWKSet({ keys: [this.jwk] }),
    };
  }

  /** Signs a Pub/Sub-style push token. */
  pushToken(claims: { aud: string; email: string; email_verified?: boolean; iss?: string }) {
    return new SignJWT({ email: claims.email, email_verified: claims.email_verified ?? true })
      .setProtectedHeader({ alg: 'RS256', kid: 'pubsub' })
      .setIssuer(claims.iss ?? 'https://accounts.google.com')
      .setAudience(claims.aud)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.key);
  }

  issueCode(provider: 'GMAIL' | 'MICROSOFT', mailbox: string, opts: { noRefresh?: boolean; scope?: string } = {}) {
    const code = `code-${++this.seq}`;
    this.codes.set(code, { provider, mailbox, ...opts });
    return code;
  }

  // ───────── Gmail helpers ─────────
  gmailBox(mailbox: string) {
    let b = this.gmail.get(mailbox);
    if (!b) {
      b = { messages: new Map(), history: [], historyId: 1000, oldestHistory: 1000, watches: 0 };
      this.gmail.set(mailbox, b);
    }
    return b;
  }

  gmailAdd(mailbox: string, m: GmailFakeMessage) {
    const b = this.gmailBox(mailbox);
    b.messages.set(m.id, m);
    b.history.push({ id: ++b.historyId, added: [m.id] });
  }

  gmailSetLabels(mailbox: string, id: string, labelIds: string[]) {
    const b = this.gmailBox(mailbox);
    b.messages.get(id)!.labelIds = labelIds;
    b.history.push({ id: ++b.historyId, labels: [id] });
  }

  gmailDelete(mailbox: string, id: string) {
    const b = this.gmailBox(mailbox);
    b.messages.delete(id);
    b.history.push({ id: ++b.historyId, deleted: [id] });
  }

  /** Simulates Google dropping old history (startHistoryId too old → 404). */
  gmailExpireHistory(mailbox: string) {
    const b = this.gmailBox(mailbox);
    b.oldestHistory = b.historyId + 1;
  }

  // ───────── Graph helpers ─────────
  graphBox(mailbox: string) {
    let b = this.graph.get(mailbox);
    if (!b) {
      b = { messages: new Map(), changes: [], subs: new Map() };
      this.graph.set(mailbox, b);
    }
    return b;
  }

  graphAdd(mailbox: string, m: GraphFakeMessage) {
    const b = this.graphBox(mailbox);
    b.messages.set(m.id, m);
    b.changes.push({ folderId: m.folderId, id: m.id, removed: false });
  }

  graphMove(mailbox: string, id: string, folderId: string) {
    const b = this.graphBox(mailbox);
    const m = b.messages.get(id)!;
    b.changes.push({ folderId: m.folderId, id, removed: true });
    m.folderId = folderId;
    b.changes.push({ folderId, id, removed: false });
  }

  graphDelete(mailbox: string, id: string) {
    const b = this.graphBox(mailbox);
    const m = b.messages.get(id)!;
    b.messages.delete(id);
    b.changes.push({ folderId: m.folderId, id, removed: true });
  }

  // ───────── HTTP ─────────
  private async body(req: IncomingMessage) {
    let s = '';
    for await (const c of req) s += c;
    return s;
  }

  private send(res: ServerResponse, status: number, body?: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? '' : JSON.stringify(body));
  }

  private authed(req: IncomingMessage, provider: 'GMAIL' | 'MICROSOFT') {
    const t = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const a = this.access.get(t);
    return a && a.provider === provider ? a.mailbox : null;
  }

  private issueTokens(provider: 'GMAIL' | 'MICROSOFT', mailbox: string, withRefresh: boolean, scope?: string) {
    const accessToken = `at-${++this.seq}`;
    this.access.set(accessToken, { provider, mailbox, expiresIn: this.accessTtl });
    const out: Record<string, unknown> = {
      access_token: accessToken,
      expires_in: this.accessTtl,
      token_type: 'Bearer',
      scope: scope ?? (provider === 'GMAIL' ? GMAIL_SCOPES : GRAPH_SCOPES).join(' '),
    };
    if (withRefresh) {
      const rt = `rt-${++this.seq}`;
      this.refresh.set(rt, { provider, mailbox });
      out.refresh_token = rt;
    }
    return out;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, this.base);
    const path = url.pathname;
    this.calls.push({ method: req.method!, path });

    if (req.method === 'POST' && path === '/token') {
      const form = new URLSearchParams(await this.body(req));
      if (form.get('grant_type') === 'authorization_code') {
        const c = this.codes.get(form.get('code') ?? '');
        if (!c || !form.get('code_verifier')) return this.send(res, 400, { error: 'invalid_grant' });
        this.codes.delete(form.get('code')!);
        return this.send(res, 200, this.issueTokens(c.provider, c.mailbox, !c.noRefresh, c.scope));
      }
      const r = this.refresh.get(form.get('refresh_token') ?? '');
      if (!r) return this.send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      // Microsoft rotates refresh tokens; Google does not return a new one.
      const tokens = this.issueTokens(r.provider, r.mailbox, r.provider === 'MICROSOFT');
      if (r.provider === 'MICROSOFT') this.refresh.delete(form.get('refresh_token')!);
      return this.send(res, 200, tokens);
    }
    if (req.method === 'POST' && path === '/revoke') {
      const token = new URLSearchParams(await this.body(req)).get('token') ?? '';
      this.revoked.push(token);
      this.refresh.delete(token);
      return this.send(res, 200, {});
    }
    if (path.startsWith('/gmail/v1/users/me')) return this.gmailApi(req, res, path.slice('/gmail/v1/users/me'.length), url);
    if (path.startsWith('/graph/v1.0')) return this.graphApi(req, res, path.slice('/graph/v1.0'.length), url);
    this.send(res, 404, { error: { message: 'not found' } });
  }

  private gmailRaw(m: GmailFakeMessage, format: string) {
    if (format === 'minimal') return { id: m.id, threadId: m.threadId, labelIds: m.labelIds };
    const headers = [
      { name: 'From', value: m.from },
      { name: 'To', value: m.to },
      { name: 'Subject', value: m.subject },
      { name: 'Message-ID', value: m.messageId },
      { name: 'Date', value: m.date.toUTCString() },
      ...(m.inReplyTo ? [{ name: 'In-Reply-To', value: m.inReplyTo }] : []),
    ];
    const textPart = { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }], body: { size: m.text.length, data: b64url(m.text) } };
    const payload = m.attachment
      ? {
          mimeType: 'multipart/mixed',
          headers,
          parts: [textPart, { mimeType: m.attachment.mime, filename: m.attachment.filename, headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { attachmentId: `a-${m.id}`, size: m.attachment.size } }],
        }
      : { ...textPart, headers: [...headers, ...textPart.headers] };
    return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: m.text.slice(0, 100), sizeEstimate: 1000, internalDate: String(m.date.getTime()), payload };
  }

  private async gmailApi(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
    const mailbox = this.authed(req, 'GMAIL');
    if (!mailbox) return this.send(res, 401, { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } });
    const b = this.gmailBox(mailbox);
    if (path === '/profile') return this.send(res, 200, { emailAddress: mailbox, historyId: String(b.historyId), messagesTotal: b.messages.size });
    if (path === '/labels') {
      return this.send(res, 200, {
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'SENT', name: 'SENT', type: 'system' },
          { id: 'UNREAD', name: 'UNREAD', type: 'system' },
          { id: 'STARRED', name: 'STARRED', type: 'system' },
          { id: 'TRASH', name: 'TRASH', type: 'system' },
          { id: 'CATEGORY_PROMOTIONS', name: 'CATEGORY_PROMOTIONS', type: 'system' },
          { id: 'Label_1', name: 'Clients', type: 'user' },
        ],
      });
    }
    if (path === '/messages') {
      const after = Number(/after:(\d+)/.exec(url.searchParams.get('q') ?? '')?.[1] ?? 0) * 1000;
      const all = [...b.messages.values()].filter((m) => m.date.getTime() > after && !m.labelIds.includes('DRAFT')).sort((x, y) => y.date.getTime() - x.date.getTime());
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const page = all.slice(start, start + 2); // tiny pages exercise pagination
      return this.send(res, 200, {
        messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
        ...(start + 2 < all.length ? { nextPageToken: String(start + 2) } : {}),
      });
    }
    const msg = /^\/messages\/([^/]+)$/.exec(path);
    if (msg) {
      const m = b.messages.get(decodeURIComponent(msg[1]!));
      return m ? this.send(res, 200, this.gmailRaw(m, url.searchParams.get('format') ?? 'full')) : this.send(res, 404, { error: { code: 404, message: 'Not Found' } });
    }
    if (path === '/history') {
      const start = Number(url.searchParams.get('startHistoryId'));
      if (start < b.oldestHistory) return this.send(res, 404, { error: { code: 404, message: 'Requested entity was not found.' } });
      const history = b.history
        .filter((h) => h.id > start)
        .map((h) => ({
          id: String(h.id),
          ...(h.added ? { messagesAdded: h.added.map((id) => ({ message: { id, threadId: b.messages.get(id)?.threadId ?? id } })) } : {}),
          ...(h.deleted ? { messagesDeleted: h.deleted.map((id) => ({ message: { id } })) } : {}),
          ...(h.labels ? { labelsAdded: h.labels.map((id) => ({ message: { id }, labelIds: [] })) } : {}),
        }));
      return this.send(res, 200, { history, historyId: String(b.historyId) });
    }
    if (path === '/watch' && req.method === 'POST') {
      b.watches++;
      return this.send(res, 200, { historyId: String(b.historyId), expiration: String(Date.now() + 7 * 86_400_000) });
    }
    if (path === '/stop' && req.method === 'POST') return this.send(res, 204);
    this.send(res, 404, { error: { code: 404, message: 'Not Found' } });
  }

  private graphRaw(m: GraphFakeMessage) {
    return {
      id: m.id,
      conversationId: m.conversationId,
      internetMessageId: m.internetMessageId,
      subject: m.subject,
      bodyPreview: m.html.replace(/<[^>]+>/g, '').slice(0, 100),
      body: { contentType: 'html', content: m.html },
      from: { emailAddress: { address: m.from, name: m.from.split('@')[0] } },
      toRecipients: [{ emailAddress: { address: m.to } }],
      receivedDateTime: m.received.toISOString(),
      sentDateTime: m.received.toISOString(),
      isRead: m.isRead,
      isDraft: false,
      hasAttachments: !!m.attachments?.length,
      flag: { flagStatus: 'notFlagged' },
      parentFolderId: m.folderId,
    };
  }

  private async graphApi(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
    const mailbox = this.authed(req, 'MICROSOFT');
    if (!mailbox) return this.send(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'expired' } });
    if (!String(req.headers.prefer ?? '').includes('IdType="ImmutableId"')) return this.send(res, 400, { error: { code: 'TestExpectation', message: 'immutable ids required' } });
    const b = this.graphBox(mailbox);
    if (path === '/me') return this.send(res, 200, { id: 'user-1', mail: mailbox, userPrincipalName: mailbox, displayName: 'Sales Team' });
    const wk: Record<string, string> = { inbox: 'F-INBOX', sentitems: 'F-SENT', archive: 'F-ARCHIVE', drafts: 'F-DRAFTS' };
    const one = /^\/me\/mailFolders\/([a-z]+)$/.exec(path);
    if (one) return wk[one[1]!] ? this.send(res, 200, { id: wk[one[1]!] }) : this.send(res, 404, { error: { code: 'ErrorFolderNotFound', message: 'x' } });
    if (path === '/me/mailFolders') {
      return this.send(res, 200, {
        value: [
          { id: 'F-INBOX', displayName: 'Inbox' },
          { id: 'F-SENT', displayName: 'Sent Items' },
          { id: 'F-ARCHIVE', displayName: 'Archive' },
          { id: 'F-DRAFTS', displayName: 'Drafts' },
          { id: 'F-PROJECTS', displayName: 'Projects' },
        ],
      });
    }
    const delta = /^\/me\/mailFolders\/([^/]+)\/messages\/delta$/.exec(path);
    if (delta) {
      const folderId = decodeURIComponent(delta[1]!);
      const token = url.searchParams.get('$deltatoken');
      if (token === 'expired') return this.send(res, 410, { error: { code: 'SyncStateNotFound', message: 'gone' } });
      let value: unknown[];
      if (token === null) {
        const since = /receivedDateTime ge (\S+)/.exec(url.searchParams.get('$filter') ?? '')?.[1];
        value = [...b.messages.values()].filter((m) => m.folderId === folderId && (!since || m.received >= new Date(since))).map((m) => this.graphRaw(m));
      } else {
        const fromIdx = Number(token);
        value = b.changes
          .slice(fromIdx)
          .filter((c) => c.folderId === folderId)
          .map((c) => (c.removed ? { id: c.id, '@removed': { reason: 'deleted' } } : this.graphRaw(b.messages.get(c.id)!)));
      }
      const next = `${this.base}/graph/v1.0/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$deltatoken=${b.changes.length}`;
      return this.send(res, 200, { value, '@odata.deltaLink': next });
    }
    const att = /^\/me\/messages\/([^/]+)\/attachments$/.exec(path);
    if (att) {
      const m = b.messages.get(decodeURIComponent(att[1]!));
      return this.send(res, 200, { value: (m?.attachments ?? []).map((a) => ({ ...a, isInline: false })) });
    }
    if (path === '/subscriptions' && req.method === 'POST') {
      const body = JSON.parse(await this.body(req)) as { clientState: string; expirationDateTime: string };
      const id = `sub-${++this.seq}`;
      b.subs.set(id, body.clientState);
      return this.send(res, 201, { id, expirationDateTime: body.expirationDateTime });
    }
    const sub = /^\/subscriptions\/([^/]+)$/.exec(path);
    if (sub) {
      const id = decodeURIComponent(sub[1]!);
      if (!b.subs.has(id)) return this.send(res, 404, { error: { code: 'ResourceNotFound', message: 'x' } });
      if (req.method === 'DELETE') {
        b.subs.delete(id);
        return this.send(res, 204);
      }
      const body = JSON.parse(await this.body(req)) as { expirationDateTime: string };
      return this.send(res, 200, { id, expirationDateTime: body.expirationDateTime });
    }
    this.send(res, 404, { error: { code: 'NotFound', message: path } });
  }
}
