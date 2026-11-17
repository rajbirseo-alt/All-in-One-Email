import { CursorExpiredError } from './errors';
import type { ProviderHttp } from './http';
import { normalizeMessageId } from './message-utils';
import type { Address, FolderKind, NormalizedAttachment, NormalizedFolder, NormalizedMessage } from './types';

export const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

const WELL_KNOWN: [string, FolderKind][] = [
  ['inbox', 'INBOX'],
  ['sentitems', 'SENT'],
  ['drafts', 'DRAFTS'],
  ['archive', 'ARCHIVE'],
  ['junkemail', 'SPAM'],
  ['deleteditems', 'TRASH'],
];

const MESSAGE_FIELDS = [
  'id',
  'conversationId',
  'internetMessageId',
  'subject',
  'bodyPreview',
  'body',
  'from',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'receivedDateTime',
  'sentDateTime',
  'isRead',
  'isDraft',
  'hasAttachments',
  'flag',
  'parentFolderId',
].join(',');

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

export interface GraphRawMessage {
  id: string;
  '@removed'?: { reason: string };
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  flag?: { flagStatus?: string };
  parentFolderId?: string;
}

export interface DeltaPage {
  messages: NormalizedMessage[];
  /** Ids that left this folder (moved or deleted). */
  removedIds: string[];
  nextLink: string | null;
  deltaLink: string | null;
}

export class GraphClient {
  private readonly http: Pick<ProviderHttp, 'json'>;

  constructor(
    http: ProviderHttp,
    private readonly base = GRAPH_API_BASE,
  ) {
    // Immutable ids keep a message's id stable when it moves between folders, so a move is
    // not mistaken for a delete followed by a new message.
    this.http = {
      json: (url, opts = {}) =>
        http.json(url, { ...opts, headers: { ...opts.headers, prefer: ['IdType="ImmutableId"', opts.headers?.prefer].filter(Boolean).join(', ') } }),
    };
  }

  async me(): Promise<{ id: string; emailAddress: string; displayName: string | null }> {
    const { body } = await this.http.json<{ id: string; mail?: string | null; userPrincipalName?: string; displayName?: string }>(
      `${this.base}/me?$select=id,mail,userPrincipalName,displayName`,
    );
    const email = (body.mail || body.userPrincipalName || '').toLowerCase();
    return { id: body.id, emailAddress: email, displayName: body.displayName ?? null };
  }

  /** Top-level folders, with the well-known ones typed. Child folders are not listed in this phase. */
  async folders(): Promise<NormalizedFolder[]> {
    const typed = new Map<string, FolderKind>();
    for (const [name, type] of WELL_KNOWN) {
      const { status, body } = await this.http.json<{ id: string }>(`${this.base}/me/mailFolders/${name}?$select=id`, { allow: [404] });
      if (status !== 404) typed.set(body.id, type);
    }
    const out: NormalizedFolder[] = [];
    let url: string | null = `${this.base}/me/mailFolders?$top=100&$select=id,displayName`;
    while (url) {
      const page: { body: { value: { id: string; displayName: string }[]; '@odata.nextLink'?: string } } = await this.http.json(url);
      for (const f of page.body.value) {
        out.push({ providerFolderId: f.id, name: f.displayName, path: f.displayName, type: typed.get(f.id) ?? 'CUSTOM' });
      }
      url = page.body['@odata.nextLink'] ?? null;
    }
    return out;
  }

  /** First delta page for a folder, limited to mail received since `since`. */
  deltaStart(folderId: string, since: Date): Promise<DeltaPage> {
    const params = new URLSearchParams({ $select: MESSAGE_FIELDS, $filter: `receivedDateTime ge ${since.toISOString()}` });
    return this.delta(`${this.base}/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?${params}`);
  }

  /** Follows a nextLink or a stored deltaLink. Throws CursorExpiredError when the delta token expired. */
  async delta(url: string): Promise<DeltaPage> {
    const { status, body } = await this.http.json<{ value: GraphRawMessage[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }>(url, {
      headers: { prefer: 'odata.maxpagesize=50, outlook.body-content-type="html"' },
      allow: [404, 410],
    });
    if (status === 410 || status === 404) throw new CursorExpiredError('Graph delta token expired', status);
    const messages: NormalizedMessage[] = [];
    const removedIds: string[] = [];
    for (const m of body.value) {
      if (m['@removed']) removedIds.push(m.id);
      else messages.push(normalizeGraphMessage(m));
    }
    return { messages, removedIds, nextLink: body['@odata.nextLink'] ?? null, deltaLink: body['@odata.deltaLink'] ?? null };
  }

  /** Full message (used when a delta entry only carries changed fields). */
  async getMessage(id: string): Promise<NormalizedMessage | null> {
    const { status, body } = await this.http.json<GraphRawMessage>(`${this.base}/me/messages/${encodeURIComponent(id)}?$select=${MESSAGE_FIELDS}`, {
      headers: { prefer: 'outlook.body-content-type="html"' },
      allow: [404],
    });
    return status === 404 ? null : normalizeGraphMessage(body);
  }

  async attachments(messageId: string): Promise<NormalizedAttachment[]> {
    const { status, body } = await this.http.json<{ value: { id: string; name?: string; contentType?: string; size?: number; isInline?: boolean; contentId?: string }[] }>(
      `${this.base}/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`,
      { allow: [404] },
    );
    if (status === 404) return [];
    return body.value.map((a) => ({
      providerAttachmentId: a.id,
      filename: a.name || 'attachment',
      contentType: a.contentType || 'application/octet-stream',
      sizeBytes: a.size ?? 0,
      contentId: a.contentId ?? null,
      isInline: !!a.isInline,
    }));
  }

  async createSubscription(p: { resource: string; notificationUrl: string; lifecycleNotificationUrl: string; clientState: string; expiresAt: Date }) {
    const { body } = await this.http.json<{ id: string; expirationDateTime: string }>(`${this.base}/subscriptions`, {
      method: 'POST',
      body: {
        changeType: 'created,updated,deleted',
        notificationUrl: p.notificationUrl,
        lifecycleNotificationUrl: p.lifecycleNotificationUrl,
        resource: p.resource,
        expirationDateTime: p.expiresAt.toISOString(),
        clientState: p.clientState,
      },
    });
    return { id: body.id, expiresAt: new Date(body.expirationDateTime) };
  }

  /** Returns null when the subscription no longer exists (it must be recreated). */
  async renewSubscription(id: string, expiresAt: Date): Promise<Date | null> {
    const { status, body } = await this.http.json<{ expirationDateTime: string }>(`${this.base}/subscriptions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { expirationDateTime: expiresAt.toISOString() },
      allow: [404],
    });
    return status === 404 ? null : new Date(body.expirationDateTime);
  }

  async deleteSubscription(id: string): Promise<void> {
    await this.http.json(`${this.base}/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE', allow: [404] });
  }
}

function addr(r: GraphRecipient | undefined): Address | null {
  const a = r?.emailAddress?.address;
  return a && a.includes('@') ? { address: a.toLowerCase(), name: r?.emailAddress?.name || null } : null;
}
const addrs = (list: GraphRecipient[] | undefined) => (list ?? []).map(addr).filter((a): a is Address => a !== null);

export function normalizeGraphMessage(m: GraphRawMessage): NormalizedMessage {
  const isHtml = (m.body?.contentType ?? '').toLowerCase() === 'html';
  const received = m.receivedDateTime ? new Date(m.receivedDateTime) : new Date();
  return {
    providerMessageId: m.id,
    providerThreadId: m.conversationId ?? null,
    internetMessageId: normalizeMessageId(m.internetMessageId),
    // Graph does not return In-Reply-To/References without fetching raw headers; threading uses conversationId.
    inReplyTo: null,
    references: [],
    from: addr(m.from),
    to: addrs(m.toRecipients),
    cc: addrs(m.ccRecipients),
    bcc: addrs(m.bccRecipients),
    replyTo: addrs(m.replyTo),
    subject: m.subject ?? '',
    snippet: m.bodyPreview ?? null,
    bodyText: isHtml ? null : (m.body?.content ?? null),
    bodyHtml: isHtml ? (m.body?.content ?? null) : null,
    headers: null,
    sizeBytes: null,
    isRead: m.isRead ?? false,
    isDraft: m.isDraft ?? false,
    isStarred: m.flag?.flagStatus === 'flagged',
    receivedAt: received,
    sentAt: m.sentDateTime ? new Date(m.sentDateTime) : null,
    providerFolderIds: m.parentFolderId ? [m.parentFolderId] : [],
    hasAttachments: m.hasAttachments ?? false,
    // Filled by the sync step via attachments() when hasAttachments is true.
    attachments: [],
  };
}
