import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ImapFlow, type ListResponse } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';
import { AuthError, ProviderRequestError, TransientError } from './errors';
import { normalizeMessageId } from './message-utils';
import type { Address, FolderKind, NormalizedFolder, NormalizedMessage } from './types';

export type ImapSecurity = 'TLS' | 'STARTTLS';

export interface ServerSettings {
  host: string;
  port: number;
  security: ImapSecurity;
}

/** Everything needed to reach an IMAP/SMTP mailbox. The password only lives in memory. */
export interface ImapAccountConfig {
  email: string;
  username: string;
  password: string;
  imap: ServerSettings;
  smtp: ServerSettings;
}

/**
 * Transport policy. Production is strict: TLS 1.2+, verified certificates, and no connections to
 * private or loopback addresses (a typed-in host must not reach our own network).
 * Only tests relax it, through code, never through an environment variable.
 */
export interface ImapTransportPolicy {
  /** Tests: talk plain TCP to local fake servers. */
  plaintextForTests?: boolean;
  /** Tests: allow 127.0.0.1 / private ranges. */
  allowPrivateHosts?: boolean;
  /** Socket timeouts (ms). */
  timeoutMs?: number;
}

const KEPT_HEADERS = ['message-id', 'in-reply-to', 'references', 'date', 'list-id', 'list-unsubscribe', 'auto-submitted', 'precedence', 'return-path'];

// ───────────── host checks ─────────────

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** DNS check: the host must resolve, and (in production) only to public addresses. */
export async function checkHost(host: string, policy: ImapTransportPolicy = {}): Promise<string[]> {
  if (!/^[a-z0-9.-]+$/i.test(host) && !isIP(host)) throw new ProviderRequestError(`"${host}" is not a valid server name`);
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new ProviderRequestError(`The server name ${host} could not be found`);
  }
  if (!policy.allowPrivateHosts && addrs.some(isPrivateAddress)) throw new ProviderRequestError(`${host} points to a private network address, which is not allowed`);
  return addrs;
}

// ───────────── folders ─────────────

const SPECIAL: Record<string, FolderKind> = {
  '\\inbox': 'INBOX',
  '\\sent': 'SENT',
  '\\drafts': 'DRAFTS',
  '\\junk': 'SPAM',
  '\\trash': 'TRASH',
  '\\archive': 'ARCHIVE',
  '\\all': 'ARCHIVE',
  '\\flagged': 'STARRED',
  '\\important': 'IMPORTANT',
};
const BY_NAME: [RegExp, FolderKind][] = [
  [/^inbox$/i, 'INBOX'],
  [/^(sent|sent items|sent mail|sent messages|outbox sent|gesendet|envoy[ée]s)$/i, 'SENT'],
  [/^(drafts?|entw[üu]rfe|brouillons)$/i, 'DRAFTS'],
  [/^(spam|junk|junk e-?mail|bulk mail|courrier ind[ée]sirable)$/i, 'SPAM'],
  [/^(trash|deleted|deleted items|deleted messages|bin|papierkorb|corbeille)$/i, 'TRASH'],
  [/^(archive|archives|all mail)$/i, 'ARCHIVE'],
];

export function folderKind(f: { path: string; name: string; specialUse?: string; flags?: Set<string> }): FolderKind {
  if (f.path.toUpperCase() === 'INBOX') return 'INBOX';
  const special = f.specialUse ? SPECIAL[f.specialUse.toLowerCase()] : undefined;
  if (special) return special;
  for (const flag of f.flags ?? []) {
    const k = SPECIAL[flag.toLowerCase()];
    if (k) return k;
  }
  const leaf = f.name.trim();
  return BY_NAME.find(([re]) => re.test(leaf))?.[1] ?? 'CUSTOM';
}

// ───────────── messages ─────────────

/** Read / starred state from IMAP flags (\Seen, \Flagged; some servers drop the backslash). */
export function imapFlagState(flags: Set<string>) {
  return { isRead: hasFlag(flags, 'seen'), isStarred: hasFlag(flags, 'flagged'), isDeleted: hasFlag(flags, 'deleted') };
}

/** "1:5,7,9:12": compact UID sets keep commands short. */
export function uidSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}

const hasFlag = (flags: Set<string> | undefined, name: string) => {
  const want = name.toLowerCase();
  for (const f of flags ?? []) if (f.toLowerCase().replace(/^\\/, '') === want) return true;
  return false;
};

function addresses(v: AddressObject | AddressObject[] | undefined): Address[] {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  const out: Address[] = [];
  const walk = (items: { address?: string; name?: string; group?: { address?: string; name?: string }[] }[]) => {
    for (const a of items) {
      if (a.group) walk(a.group);
      else if (a.address) out.push({ address: a.address.toLowerCase(), name: a.name || null });
    }
  };
  for (const o of list) walk(o.value);
  return out;
}

/** The id a message keeps across folders: its Message-ID; else its position in this folder. */
export function imapMessageKey(messageId: string | null, folderPath: string, uidValidity: bigint | number, uid: number) {
  return messageId ? `mid:${messageId}` : `uid:${uidValidity}:${uid}@${folderPath}`;
}

export interface ImapFetched {
  uid: number;
  flags: Set<string>;
  internalDate: Date | null;
  source: Buffer;
}

/** Parses a raw message into the shape the ingestion pipeline stores. */
export async function parseImapMessage(m: ImapFetched, folderPath: string, uidValidity: bigint | number): Promise<NormalizedMessage> {
  const p = await simpleParser(m.source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const v = p.headers.get(name);
    if (typeof v === 'string' && v) headers[name] = v.slice(0, 2000);
  }
  const mid = normalizeMessageId(p.messageId ?? null);
  const refs = Array.isArray(p.references) ? p.references : p.references ? p.references.split(/\s+/) : [];
  const text = p.text ?? null;
  const html = typeof p.html === 'string' ? p.html : null;
  const attachments = p.attachments.map((a, i) => ({
    providerAttachmentId: `part:${i}`,
    filename: (a.filename ?? `attachment-${i + 1}`).slice(0, 500),
    contentType: (a.contentType ?? 'application/octet-stream').slice(0, 200),
    sizeBytes: a.size ?? a.content?.length ?? 0,
    contentId: a.contentId ? a.contentId.replace(/^<|>$/g, '') : null,
    isInline: a.contentDisposition === 'inline' || !!a.related,
  }));
  const from = addresses(p.from)[0] ?? null;
  return {
    providerMessageId: imapMessageKey(mid, folderPath, uidValidity, m.uid),
    providerThreadId: null,
    internetMessageId: mid,
    inReplyTo: normalizeMessageId(p.inReplyTo ?? null),
    references: refs.map((r) => normalizeMessageId(r)).filter((r): r is string => !!r),
    from,
    to: addresses(p.to),
    cc: addresses(p.cc),
    bcc: addresses(p.bcc),
    replyTo: addresses(p.replyTo),
    subject: p.subject ?? '',
    snippet: text ? text.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
    bodyText: text,
    bodyHtml: html,
    headers: Object.keys(headers).length ? headers : null,
    sizeBytes: m.source.length,
    isRead: hasFlag(m.flags, 'seen'),
    isDraft: hasFlag(m.flags, 'draft'),
    isStarred: hasFlag(m.flags, 'flagged'),
    receivedAt: m.internalDate ?? p.date ?? new Date(),
    sentAt: p.date ?? null,
    providerFolderIds: [folderPath],
    imapUid: m.uid,
    hasAttachments: attachments.length > 0,
    attachments,
  };
}

// ───────────── the client ─────────────

/** Turns imapflow / socket failures into the error classes that drive retries. */
function classify(e: unknown): Error {
  const err = e as { authenticationFailed?: boolean; responseText?: string; code?: string; message?: string; serverResponseCode?: string };
  if (err?.authenticationFailed || err?.serverResponseCode === 'AUTHENTICATIONFAILED' || /auth|login|credentials|password/i.test(err?.responseText ?? '')) {
    return new AuthError(`The mail server refused the username or password${err.responseText ? `: ${err.responseText}` : ''}`);
  }
  if (e instanceof AuthError || e instanceof ProviderRequestError || e instanceof TransientError) return e;
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'NoConnection'].includes(err?.code ?? '') || /timeout|socket|connection/i.test(err?.message ?? '')) {
    return new TransientError(`Could not reach the mail server: ${err?.message ?? err?.code}`);
  }
  if (/certificate|self.signed|tls|ssl/i.test(err?.message ?? '')) return new ProviderRequestError(`Secure connection failed: ${err?.message}`);
  return new ProviderRequestError(err?.responseText ?? err?.message ?? String(e));
}

export interface FolderState {
  uidValidity: bigint;
  uidNext: number;
  exists: number;
}

export class ImapClient {
  private client: ImapFlow | null = null;

  constructor(
    private readonly cfg: ImapAccountConfig,
    private readonly policy: ImapTransportPolicy = {},
  ) {}

  private options() {
    const plain = !!this.policy.plaintextForTests;
    return {
      host: this.cfg.imap.host,
      port: this.cfg.imap.port,
      secure: !plain && this.cfg.imap.security === 'TLS',
      doSTARTTLS: plain ? false : this.cfg.imap.security === 'STARTTLS',
      auth: { user: this.cfg.username, pass: this.cfg.password },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const, servername: this.cfg.imap.host },
      logger: false as const,
      connectionTimeout: this.policy.timeoutMs ?? 20_000,
      greetingTimeout: this.policy.timeoutMs ?? 20_000,
      socketTimeout: 5 * 60_000,
      // Re-issue IDLE well inside the 29-minute limit of RFC 2177.
      maxIdleTime: 25 * 60_000,
      disableAutoIdle: true,
      emitLogs: false,
    };
  }

  /** The live connection (IDLE supervisor). */
  get raw(): ImapFlow {
    if (!this.client) throw new ProviderRequestError('Not connected');
    return this.client;
  }

  async connect(opts: { autoIdle?: boolean } = {}) {
    if (this.client?.usable) return this;
    await checkHost(this.cfg.imap.host, this.policy);
    const c = new ImapFlow({ ...this.options(), disableAutoIdle: !opts.autoIdle });
    c.on('error', () => undefined); // surfaced through the failing call instead
    try {
      await c.connect();
    } catch (e) {
      throw classify(e);
    }
    this.client = c;
    return this;
  }

  async close() {
    const c = this.client;
    this.client = null;
    if (!c) return;
    try {
      await c.logout();
    } catch {
      c.close();
    }
  }

  private async run<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    await this.connect();
    try {
      return await fn(this.client!);
    } catch (e) {
      throw classify(e);
    }
  }

  /** Runs `fn` with the folder selected (read-write), holding imapflow's mailbox lock. */
  async inFolder<T>(path: string, fn: (c: ImapFlow, state: FolderState) => Promise<T>): Promise<T> {
    return this.run(async (c) => {
      const lock = await c.getMailboxLock(path);
      try {
        const mb = c.mailbox;
        if (!mb) throw new ProviderRequestError(`Folder ${path} could not be opened`);
        return await fn(c, { uidValidity: BigInt(mb.uidValidity), uidNext: mb.uidNext, exists: mb.exists });
      } finally {
        lock.release();
      }
    });
  }

  async folders(): Promise<NormalizedFolder[]> {
    const list = await this.run((c) => c.list());
    return list
      .filter((f: ListResponse) => !hasFlag(f.flags, 'noselect') && !hasFlag(f.flags, 'nonexistent'))
      .map((f: ListResponse) => ({ providerFolderId: f.path, name: f.name, path: f.path, type: folderKind(f) }));
  }

  /** UIDs of messages received since `since` (server-side date, day precision). */
  async uidsSince(path: string, since: Date): Promise<{ state: FolderState; uids: number[] }> {
    return this.inFolder(path, async (c, state) => {
      if (!state.exists) return { state, uids: [] };
      const found = await c.search({ since }, { uid: true });
      return { state, uids: (found || []).sort((a, b) => a - b) };
    });
  }

  /** UIDs above `afterUid` (new mail). */
  async uidsAfter(path: string, afterUid: number): Promise<{ state: FolderState; uids: number[] }> {
    return this.inFolder(path, async (c, state) => {
      if (!state.exists || state.uidNext <= afterUid + 1) return { state, uids: [] };
      const found = await c.search({ uid: `${afterUid + 1}:*` }, { uid: true });
      // "n:*" always matches the highest message even when it is below n.
      return { state, uids: (found || []).filter((u) => u > afterUid).sort((a, b) => a - b) };
    });
  }

  /** Full messages (BODY.PEEK[]: fetching never marks them read). */
  async fetchMessages(path: string, uids: number[]): Promise<{ state: FolderState; messages: ImapFetched[] }> {
    return this.inFolder(path, async (c, state) => {
      const messages: ImapFetched[] = [];
      if (!uids.length) return { state, messages };
      for await (const m of c.fetch(uidSet(uids), { uid: true, flags: true, internalDate: true, source: true }, { uid: true })) {
        if (m.source) messages.push({ uid: m.uid, flags: m.flags ?? new Set(), internalDate: m.internalDate ? new Date(m.internalDate) : null, source: m.source });
      }
      return { state, messages };
    });
  }

  /** Current flags of these UIDs; UIDs missing from the result were expunged. */
  async flagsOf(path: string, uids: number[]): Promise<Map<number, Set<string>>> {
    return this.inFolder(path, async (c) => {
      const out = new Map<number, Set<string>>();
      if (!uids.length) return out;
      for await (const m of c.fetch(uidSet(uids), { uid: true, flags: true }, { uid: true })) out.set(m.uid, m.flags ?? new Set());
      return out;
    });
  }

  async setFlags(path: string, uids: number[], change: { add?: string[]; remove?: string[] }) {
    if (!uids.length) return;
    await this.inFolder(path, async (c) => {
      if (change.add?.length) await c.messageFlagsAdd(uidSet(uids), change.add, { uid: true });
      if (change.remove?.length) await c.messageFlagsRemove(uidSet(uids), change.remove, { uid: true });
    });
  }

  async move(path: string, uids: number[], destination: string) {
    if (!uids.length) return;
    await this.inFolder(path, (c) => c.messageMove(uidSet(uids), destination, { uid: true }));
  }

  /** UIDs in `path` whose Message-ID header is `messageId`. */
  async findByMessageId(path: string, messageId: string): Promise<number[]> {
    return this.inFolder(path, async (c, state) => {
      if (!state.exists) return [];
      return (await c.search({ header: { 'message-id': messageId } }, { uid: true })) || [];
    });
  }

  async append(path: string, raw: Buffer, flags: string[] = ['\\Seen']) {
    await this.run((c) => c.append(path, raw, flags));
  }

  /** The raw message, for attachment downloads. */
  async source(path: string, uid: number): Promise<Buffer | null> {
    return this.inFolder(path, async (c) => {
      const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
      return m && m.source ? m.source : null;
    });
  }
}

/** Attachment `part:<n>` of a raw message. */
export async function attachmentFromSource(source: Buffer, providerAttachmentId: string): Promise<Buffer | null> {
  const n = /^part:(\d+)$/.exec(providerAttachmentId)?.[1];
  if (n === undefined) return null;
  const p = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  return p.attachments[Number(n)]?.content ?? null;
}

// ───────────── SMTP ─────────────

function smtpTransport(cfg: ImapAccountConfig, policy: ImapTransportPolicy) {
  const plain = !!policy.plaintextForTests;
  return nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: !plain && cfg.smtp.security === 'TLS',
    requireTLS: !plain && cfg.smtp.security === 'STARTTLS',
    ignoreTLS: plain,
    auth: { user: cfg.username, pass: cfg.password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: cfg.smtp.host },
    connectionTimeout: policy.timeoutMs ?? 20_000,
    greetingTimeout: policy.timeoutMs ?? 20_000,
    socketTimeout: 60_000,
  });
}

function classifySmtp(e: unknown): Error {
  const err = e as { code?: string; responseCode?: number; response?: string; message?: string };
  if (err?.code === 'EAUTH' || err?.responseCode === 535 || err?.responseCode === 534) return new AuthError(`The mail server refused the username or password${err.response ? `: ${err.response}` : ''}`);
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(err?.code ?? '') || (err?.responseCode && err.responseCode >= 400 && err.responseCode < 500)) {
    return new TransientError(`Sending failed for now: ${err?.response ?? err?.message}`);
  }
  if (e instanceof AuthError || e instanceof ProviderRequestError || e instanceof TransientError) return e;
  return new ProviderRequestError(err?.response ?? err?.message ?? String(e));
}

/** EHLO + AUTH without sending anything. */
export async function smtpVerify(cfg: ImapAccountConfig, policy: ImapTransportPolicy = {}) {
  await checkHost(cfg.smtp.host, policy);
  const t = smtpTransport(cfg, policy);
  try {
    await t.verify();
  } catch (e) {
    throw classifySmtp(e);
  } finally {
    t.close();
  }
}

/** Sends a finished MIME message. Recipients come from the envelope (Bcc is never in `raw`). */
export async function smtpSend(cfg: ImapAccountConfig, raw: Buffer, envelope: { from: string; to: string[] }, policy: ImapTransportPolicy = {}) {
  await checkHost(cfg.smtp.host, policy);
  const t = smtpTransport(cfg, policy);
  try {
    const info = await t.sendMail({ envelope, raw });
    if (info.rejected?.length && !info.accepted?.length) throw new ProviderRequestError(`The mail server refused every recipient: ${info.rejected.join(', ')}`);
    return { accepted: (info.accepted ?? []).map(String), rejected: (info.rejected ?? []).map(String) };
  } catch (e) {
    throw classifySmtp(e);
  } finally {
    t.close();
  }
}

// ───────────── connection test ─────────────

export interface ConnectionStep {
  step: 'dns' | 'imap' | 'folders' | 'smtp';
  ok: boolean;
  message: string;
}

/** The checks shown on the Connect form: DNS, IMAP login (TLS), folder list, SMTP login. */
export async function testImapAccount(cfg: ImapAccountConfig, policy: ImapTransportPolicy = {}): Promise<{ ok: boolean; steps: ConnectionStep[]; folders: NormalizedFolder[] }> {
  const steps: ConnectionStep[] = [];
  let folders: NormalizedFolder[] = [];
  const fail = (step: ConnectionStep['step'], e: unknown) => steps.push({ step, ok: false, message: (e as Error).message });
  try {
    await checkHost(cfg.imap.host, policy);
    if (cfg.smtp.host !== cfg.imap.host) await checkHost(cfg.smtp.host, policy);
    steps.push({ step: 'dns', ok: true, message: 'Server names found' });
  } catch (e) {
    fail('dns', e);
    return { ok: false, steps, folders };
  }
  const imap = new ImapClient(cfg, policy);
  try {
    await imap.connect();
    steps.push({ step: 'imap', ok: true, message: `Signed in to ${cfg.imap.host}` });
    folders = await imap.folders();
    const inbox = folders.some((f) => f.type === 'INBOX');
    steps.push({ step: 'folders', ok: inbox, message: inbox ? `${folders.length} folders found` : 'No inbox found on this server' });
  } catch (e) {
    fail(steps.some((s) => s.step === 'imap') ? 'folders' : 'imap', e);
  } finally {
    await imap.close();
  }
  try {
    await smtpVerify(cfg, policy);
    steps.push({ step: 'smtp', ok: true, message: `Signed in to ${cfg.smtp.host} for sending` });
  } catch (e) {
    fail('smtp', e);
  }
  return { ok: steps.length === 4 && steps.every((s) => s.ok), steps, folders };
}
