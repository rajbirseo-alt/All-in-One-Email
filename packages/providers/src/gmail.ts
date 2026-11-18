import { CursorExpiredError } from './errors';
import type { ProviderHttp } from './http';
import { decodeBytes, decodeEncodedWords, decodeEntities, normalizeMessageId, parseAddressList, parseDate, parseReferences } from './message-utils';
import type { FolderKind, NormalizedAttachment, NormalizedFolder, NormalizedMessage } from './types';

export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

const SYSTEM_LABELS: Record<string, FolderKind> = {
  INBOX: 'INBOX',
  SENT: 'SENT',
  DRAFT: 'DRAFTS',
  SPAM: 'SPAM',
  TRASH: 'TRASH',
  STARRED: 'STARRED',
  IMPORTANT: 'IMPORTANT',
};
/** System labels that are flags or tabs rather than folders. */
const IGNORED_LABELS = new Set(['UNREAD', 'CHAT']);

const KEPT_HEADERS = ['message-id', 'in-reply-to', 'references', 'date', 'list-id', 'list-unsubscribe', 'auto-submitted', 'precedence', 'return-path'];

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailRawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  sizeEstimate?: number;
  internalDate?: string;
  payload?: GmailPart;
}

export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[];
  messagesDeleted?: { message: { id: string } }[];
  labelsAdded?: { message: { id: string; labelIds?: string[] }; labelIds: string[] }[];
  labelsRemoved?: { message: { id: string; labelIds?: string[] }; labelIds: string[] }[];
}

export class GmailClient {
  constructor(
    private readonly http: ProviderHttp,
    private readonly base = GMAIL_API_BASE,
  ) {}

  async profile(): Promise<{ emailAddress: string; historyId: string; messagesTotal: number }> {
    const { body } = await this.http.json<{ emailAddress: string; historyId: string; messagesTotal: number }>(`${this.base}/profile`);
    return { ...body, emailAddress: body.emailAddress.toLowerCase() };
  }

  async labels(): Promise<NormalizedFolder[]> {
    const { body } = await this.http.json<{ labels?: { id: string; name: string; type: string }[] }>(`${this.base}/labels`);
    const out: NormalizedFolder[] = [];
    for (const l of body.labels ?? []) {
      if (IGNORED_LABELS.has(l.id) || l.id.startsWith('CATEGORY_')) continue;
      const type = SYSTEM_LABELS[l.id] ?? (l.type === 'system' ? null : 'CUSTOM');
      if (!type) continue;
      out.push({ providerFolderId: l.id, name: type === 'CUSTOM' ? l.name : titleCase(l.id === 'DRAFT' ? 'Drafts' : l.name), path: l.name, type });
    }
    return out;
  }

  /** One page of message ids matching a Gmail search query (newest first). */
  async listMessageIds(q: string, pageToken?: string): Promise<{ ids: string[]; nextPageToken: string | null }> {
    const params = new URLSearchParams({ q, maxResults: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const { body } = await this.http.json<{ messages?: { id: string }[]; nextPageToken?: string }>(`${this.base}/messages?${params}`);
    return { ids: (body.messages ?? []).map((m) => m.id), nextPageToken: body.nextPageToken ?? null };
  }

  /** Full message, or null when it no longer exists. */
  async getMessage(id: string): Promise<NormalizedMessage | null> {
    const { status, body } = await this.http.json<GmailRawMessage>(`${this.base}/messages/${encodeURIComponent(id)}?format=full`, { allow: [404] });
    if (status === 404) return null;
    const acc = walkMessage(body);
    for (const b of acc.pending) {
      const { body: data } = await this.http.json<{ data?: string }>(
        `${this.base}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(b.attachmentId)}`,
      );
      if (data.data) acc[b.kind] = decodeBytes(Buffer.from(data.data, 'base64url'), b.charset);
    }
    return normalizeGmailMessage(body, acc);
  }

  /** Adds/removes labels on up to 1000 messages (read = remove UNREAD, archive = remove INBOX, …). */
  async modifyLabels(ids: string[], add: string[], remove: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 1000) {
      await this.http.json(`${this.base}/messages/batchModify`, {
        method: 'POST',
        body: { ids: ids.slice(i, i + 1000), addLabelIds: add, removeLabelIds: remove },
      });
    }
  }

  /** Attachment bytes, or null when Gmail no longer accepts this attachment id. */
  async attachment(messageId: string, attachmentId: string): Promise<Buffer | null> {
    const { status, body } = await this.http.json<{ data?: string }>(
      `${this.base}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { allow: [400, 404] },
    );
    return status === 200 && body.data ? Buffer.from(body.data, 'base64url') : null;
  }

  /** Current label ids of a message (cheap), or null when it no longer exists. */
  async getLabelIds(id: string): Promise<string[] | null> {
    const { status, body } = await this.http.json<GmailRawMessage>(`${this.base}/messages/${encodeURIComponent(id)}?format=minimal`, { allow: [404] });
    return status === 404 ? null : (body.labelIds ?? []);
  }

  /** One page of history since `startHistoryId`. Throws CursorExpiredError when Google no longer has it. */
  async history(startHistoryId: string, pageToken?: string): Promise<{ history: GmailHistoryRecord[]; historyId: string; nextPageToken: string | null }> {
    const params = new URLSearchParams({ startHistoryId, maxResults: '500' });
    for (const t of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) params.append('historyTypes', t);
    if (pageToken) params.set('pageToken', pageToken);
    const { status, body } = await this.http.json<{ history?: GmailHistoryRecord[]; historyId: string; nextPageToken?: string }>(
      `${this.base}/history?${params}`,
      { allow: [404] },
    );
    if (status === 404) throw new CursorExpiredError('Gmail history id expired', 404);
    return { history: body.history ?? [], historyId: body.historyId, nextPageToken: body.nextPageToken ?? null };
  }

  /** Starts (or renews) push notifications to a Pub/Sub topic. Expires after 7 days. */
  async watch(topicName: string): Promise<{ historyId: string; expiration: Date }> {
    const { body } = await this.http.json<{ historyId: string; expiration: string }>(`${this.base}/watch`, {
      method: 'POST',
      body: { topicName, labelIds: ['INBOX', 'SENT'], labelFilterBehavior: 'include' },
    });
    return { historyId: body.historyId, expiration: new Date(Number(body.expiration)) };
  }

  async stopWatch(): Promise<void> {
    await this.http.json(`${this.base}/stop`, { method: 'POST', allow: [404] });
  }
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function header(part: GmailPart | undefined, name: string): string | null {
  const h = part?.headers?.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : null;
}

function charsetOf(part: GmailPart): string | null {
  const ct = header(part, 'content-type');
  const m = ct ? /charset\s*=\s*"?([^";\s]+)"?/i.exec(ct) : null;
  return m ? m[1]! : null;
}

export function walkMessage(m: GmailRawMessage): WalkAcc {
  const acc: WalkAcc = { text: null, html: null, attachments: [], pending: [] };
  if (m.payload) walk(m.payload, acc);
  return acc;
}

function decodePartBody(part: GmailPart): string | null {
  const data = part.body?.data;
  if (!data) return null;
  return decodeBytes(Buffer.from(data, 'base64url'), charsetOf(part));
}

/** Walks the MIME tree: first text/plain and text/html outside attachments, plus attachment metadata. */
interface WalkAcc {
  text: string | null;
  html: string | null;
  attachments: NormalizedAttachment[];
  pending: { kind: 'text' | 'html'; attachmentId: string; charset: string | null }[];
}

function walk(part: GmailPart, acc: WalkAcc) {
  const mime = (part.mimeType ?? '').toLowerCase();
  const disposition = (header(part, 'content-disposition') ?? '').toLowerCase();
  const isAttachment = !!part.filename || (!!part.body?.attachmentId && !mime.startsWith('text/'));
  if (isAttachment && !mime.startsWith('multipart/')) {
    const cid = header(part, 'content-id');
    acc.attachments.push({
      providerAttachmentId: part.body?.attachmentId ?? null,
      filename: decodeEncodedWords(part.filename || 'attachment'),
      contentType: mime || 'application/octet-stream',
      sizeBytes: part.body?.size ?? 0,
      contentId: cid ? cid.replace(/^<|>$/g, '') : null,
      isInline: disposition.startsWith('inline') || (!!cid && !disposition.startsWith('attachment')),
    });
    return;
  }
  if ((mime === 'text/plain' && acc.text === null) || (mime === 'text/html' && acc.html === null)) {
    const kind = mime === 'text/plain' ? 'text' : 'html';
    if (part.body?.data) acc[kind] = decodePartBody(part);
    // Large bodies come as a separate attachment download.
    else if (part.body?.attachmentId) acc.pending.push({ kind, attachmentId: part.body.attachmentId, charset: charsetOf(part) });
  }
  for (const p of part.parts ?? []) walk(p, acc);
}

export function normalizeGmailMessage(m: GmailRawMessage, acc: WalkAcc = walkMessage(m)): NormalizedMessage {
  const p = m.payload;
  const labels = m.labelIds ?? [];
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const v = header(p, name);
    if (v) headers[name] = v;
  }
  const from = parseAddressList(header(p, 'from'))[0] ?? null;
  return {
    providerMessageId: m.id,
    providerThreadId: m.threadId,
    internetMessageId: normalizeMessageId(header(p, 'message-id')),
    inReplyTo: normalizeMessageId(header(p, 'in-reply-to')),
    references: parseReferences(header(p, 'references')),
    from,
    to: parseAddressList(header(p, 'to')),
    cc: parseAddressList(header(p, 'cc')),
    bcc: parseAddressList(header(p, 'bcc')),
    replyTo: parseAddressList(header(p, 'reply-to')),
    subject: decodeEncodedWords(header(p, 'subject') ?? ''),
    snippet: m.snippet ? decodeEntities(m.snippet) : null,
    bodyText: acc.text,
    bodyHtml: acc.html,
    headers: Object.keys(headers).length ? headers : null,
    sizeBytes: m.sizeEstimate ?? null,
    isRead: !labels.includes('UNREAD'),
    isDraft: labels.includes('DRAFT'),
    isStarred: labels.includes('STARRED'),
    receivedAt: m.internalDate ? new Date(Number(m.internalDate)) : (parseDate(header(p, 'date')) ?? new Date()),
    sentAt: parseDate(header(p, 'date')),
    providerFolderIds: labels,
    hasAttachments: acc.attachments.some((a) => !a.isInline),
    attachments: acc.attachments,
  };
}
