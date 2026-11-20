export type MailProviderId = 'GMAIL' | 'MICROSOFT';

/** Mirrors the FolderType enum in packages/db. */
export type FolderKind = 'INBOX' | 'SENT' | 'DRAFTS' | 'ARCHIVE' | 'SPAM' | 'TRASH' | 'STARRED' | 'IMPORTANT' | 'CUSTOM';

export interface Address {
  address: string;
  name: string | null;
}

export interface NormalizedFolder {
  providerFolderId: string;
  name: string;
  path: string | null;
  type: FolderKind;
}

export interface NormalizedAttachment {
  providerAttachmentId: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId: string | null;
  isInline: boolean;
}

/** One message in the provider-independent shape the ingestion pipeline stores. */
export interface NormalizedMessage {
  providerMessageId: string;
  /** Gmail threadId / Graph conversationId. */
  providerThreadId: string | null;
  internetMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: Address | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  subject: string;
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  /** Selected raw headers kept for threading/debugging. */
  headers: Record<string, string> | null;
  sizeBytes: number | null;
  isRead: boolean;
  isDraft: boolean;
  isStarred: boolean;
  receivedAt: Date;
  sentAt: Date | null;
  /** Gmail label ids / the Graph parent folder id / the IMAP folder path. */
  providerFolderIds: string[];
  /** IMAP: the message's UID in that folder. */
  imapUid?: number | null;
  /** Provider's own flag. Graph lists attachment metadata separately, so `attachments` can be empty while this is true. */
  hasAttachments: boolean;
  attachments: NormalizedAttachment[];
}

export interface TokenSet {
  accessToken: string;
  /** Null when the provider did not return a new one (Google keeps the original). */
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

/** Returns a valid access token; `forceRefresh` after the provider rejected the current one. */
export type AccessTokenSource = (forceRefresh: boolean) => Promise<string>;
