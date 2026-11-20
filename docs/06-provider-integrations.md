# 06 — Email Provider Integration Plan

## 1. Adapter contract (`packages/providers`)

```ts
interface MailProviderAdapter {
  readonly provider: 'GMAIL' | 'MICROSOFT' | 'IMAP';
  testConnection(): Promise<ConnectionReport>;
  listFolders(): Promise<NormalizedFolder[]>;
  initialSync(opts: { since: Date; folders: string[] }, sink: MessageSink): Promise<SyncCursor>;
  incrementalSync(cursor: SyncCursor, sink: MessageSink): Promise<SyncCursor>; // throws CursorExpired
  fetchAttachment(messageRef: string, attachmentRef: string): Promise<Readable>;
  send(mime: Buffer, ctx: { providerThreadId?: string; parentProviderMessageId?: string }): Promise<SentRef>;
  setFlags(refs: string[], change: { read?: boolean; starred?: boolean; folder?: FolderType }): Promise<void>;
  subscribe?(webhookUrl: string): Promise<SubscriptionInfo>;   // Gmail watch / Graph subscription
  renewSubscription?(sub: SubscriptionInfo): Promise<SubscriptionInfo>;
  revoke(): Promise<void>;
}
```

`MessageSink` receives `NormalizedMessage` objects in batches. The shared ingestion pipeline (dedupe → thread → persist → events) is provider-agnostic and is tested once.

Errors fall into four classes that drive retry behaviour:
- `AuthError`: the account goes to `NEEDS_REAUTH`, connectors and admins are notified, and retries stop.
- `RateLimited(retryAfter)`: delay the job.
- `TransientError`: retry with exponential backoff (5 attempts, 30s up to 30 min).
- `CursorExpired`: run a full resync of the window.

## 2. Gmail / Google Workspace (Gmail API v1)

**Setup.** One Google Cloud project, an OAuth consent screen and a Pub/Sub topic `gmail-push` with `gmail-api-push@system.gserviceaccount.com` as publisher. The push subscription points to `/webhooks/gmail` with OIDC auth.

**Scopes.** `https://www.googleapis.com/auth/gmail.modify` (read, label and flag changes), `gmail.send`, `openid email`. `gmail.modify` is a **restricted scope**. Two ways to handle that:
- **Workspace accounts (recommended)**: mark the app *Internal* or use domain-wide trust (admin console → API controls → trust the app). This avoids Google verification for company mailboxes.
- **External @gmail.com accounts**: these need Google OAuth verification plus a CASA security assessment before going beyond 100 test users. Plan for this in Phase 2 if consumer Gmail accounts are in scope.

**Sync.**
- Initial: `messages.list(q="after:<syncFrom>")` paged, then `messages.get(format=full)` through batch requests (≤50 per batch, rate-limited per account and per project quota). Store `historyId` from the newest message or the `getProfile` response.
- Incremental: `history.list(startHistoryId, historyTypes=[messageAdded,messageDeleted,labelAdded,labelRemoved])`. A 404 response means `CursorExpired`, which triggers a full resync of the window.
- Push: `users.watch({topicName, labelIds:[INBOX,SENT,…]})`, renewed every 24h (it expires after 7 days). A notification carries `{emailAddress, historyId}`. Look up the account, then enqueue an incremental sync.
- Fallback: an incremental poll every 5 minutes per account (jittered), even when push is healthy.
- Labels map to `EmailFolder`. System labels (INBOX, SENT, DRAFT, SPAM, TRASH, STARRED, UNREAD) map to the matching `FolderType` and flags.

**Send.** Build the MIME with `In-Reply-To`/`References`, then `messages.send({raw, threadId})`. Gmail keeps the thread only when `threadId` is set, the headers match **and** the subject matches.

**Tokens.** The refresh token is stored encrypted, and the access token is refreshed 5 minutes before expiry. An `invalid_grant` response (password change, revocation, or the 7-day expiry for apps still in Testing) raises `AuthError`. Disconnecting calls `oauth2.revoke`.

## 3. Microsoft 365 / Outlook (Microsoft Graph v1.0)

**Setup.** An Entra ID multi-tenant app registration (or a single-tenant one if all mailboxes are in the company tenant). Redirect URI `/api/v1/accounts/oauth/microsoft/callback`.

**Delegated scopes.** `Mail.ReadWrite`, `Mail.Send`, `offline_access`, `User.Read`. For shared mailboxes (e.g. `sales@` as a shared mailbox): `Mail.ReadWrite.Shared` and `Mail.Send.Shared`, accessed through `/users/{shared}/…`. Alternatively an admin can grant app-only `Mail.ReadWrite` scoped by an **Application Access Policy** to a mail-enabled security group. That route is recommended for the company tenant because it doesn't depend on one person's token.

**Sync.**
- Initial and incremental: `GET /me/mailFolders/{id}/messages/delta` per synced folder, storing `@odata.deltaLink` in `EmailFolder.deltaLink`. A 410 Gone (expired) triggers a resync of that folder.
- Push: `POST /subscriptions` on `me/mailFolders('inbox')/messages` and `…('sentitems')/messages`, with `changeType=created,updated,deleted`, a random `clientState` (only its hash is stored), and `lifecycleNotificationUrl`. Message subscriptions last at most ~70 hours, so they are renewed every 48h. On `reauthorizationRequired` they are reauthorised, and on `missed` a delta sync is enqueued.
- Fallback: a delta poll every 5 minutes.
- Fetch `internetMessageId`, `conversationId`, `internetMessageHeaders` (on demand) and `body` with `Prefer: outlook.body-content-type="html"`.

**Send.** For replies: `POST /messages/{parentId}/createReply` (or `createReplyAll`), `PATCH` the body and recipients, upload attachments (an upload session for anything over 3MB), then `POST /messages/{draftId}/send`. This keeps the Outlook conversation intact. For new mail: `sendMail`. Sent copies arrive through delta and are reconciled by `internetMessageId`.

**Throttling.** On 429, honour `Retry-After` and cap concurrency per mailbox at 4 (Graph allows 4 concurrent requests per mailbox).

## 4. Generic IMAP / SMTP (custom domains, cPanel, Zoho, GoDaddy, Hostinger, Yahoo, iCloud…)

**Connect.** The test flow checks DNS, then TLS (TLS 1.2 or higher, certificate verified; the strict default can't be turned off in production), IMAP LOGIN/AUTHENTICATE, LIST, SMTP EHLO + AUTH. Presets fill in host, port and security for common providers. Some providers need an app password (Yahoo, iCloud, Zoho with 2FA), and the UI says so. OAuth2 XOAUTH2 is supported in the adapter for providers that offer it.

**Sync (imapflow).**
- Per folder: track `UIDVALIDITY`, `lastUid` and `HIGHESTMODSEQ`. If UIDVALIDITY changes, clear that folder's UID map and resync the folder.
- New mail: `UID FETCH lastUid+1:*` (envelope, bodystructure, flags, headers), then `BODY.PEEK[]` so the fetch doesn't set `\Seen`.
- Flags: with CONDSTORE, `FETCH 1:* (FLAGS) (CHANGEDSINCE modseq)`. Without it, compare flags over the last N days every 15 minutes.
- Deletions: QRESYNC `VANISHED` where supported. Otherwise a periodic UID SEARCH ALL diff over the sync window.
- Push: one IDLE connection per account on INBOX. A supervisor process holds the connections, reconnects with backoff and re-IDLEs every 25 minutes. Other folders are polled every 5 minutes, and INBOX is polled as a fallback.
- Connection budget: at most 2 connections per account (IDLE + work), because many hosts limit concurrent logins.

**Send.** nodemailer SMTP (465 TLS / 587 STARTTLS), then IMAP `APPEND` to the Sent folder (detected through the SPECIAL-USE `\Sent` flag or a name heuristic). Gmail-over-SMTP is skipped because those accounts use the Gmail API. The `Message-ID` is generated locally as `<uuid@sender-domain>` and saved, so the copy in Sent dedupes correctly.

**Threading.** IMAP threads come from headers: `In-Reply-To` → `References` (from the end) → normalised subject plus participants within 30 days.

## 5. Shared concerns

- **Duplicate prevention**: unique `(emailAccountId, providerMessageId)`. For sends, the outbound record is written with the local `internetMessageId` first, and the synced copy is matched to it rather than inserted again.
- **Attachments**: metadata is synced eagerly and content lazily (on first view or download). Inline images under 1MB are fetched eagerly. Limits: 25MB inbound per file (larger ones are kept as provider references only), 25MB per outbound message (Gmail/Graph limits). Files are scanned with ClamAV before download is allowed, and `scanStatus` stays PENDING until then.
- **Reconnect**: a reconnect keeps the `EmailAccount` row and its cursors and runs an incremental sync. If a cursor has expired while the account was disconnected, it runs a windowed resync, which dedupe makes safe.
- **Disconnect**: revoke the token at the provider, delete the subscription or watch, delete the credential, set status DISCONNECTED and schedule the purge (02 §Retention).
- **Sync health**: `consecutiveFailures ≥ 5` sets status `ERROR` and alerts admins. The health screen shows lag (now − newest provider timestamp seen).

## 4a. IMAP / SMTP as built (Phase 4, 2026-11-20)

- **Libraries:** imapflow (IMAP), mailparser (MIME), nodemailer (SMTP).
- **Connect:** the form runs four checks: DNS, IMAP sign-in, folder list (an inbox must exist) and SMTP sign-in. Nothing is saved unless all pass. Presets exist for Zoho (.com and .in), Hostinger, GoDaddy, cPanel (`mail.<domain>`), Yahoo and iCloud.
- **Storage:** the password is stored in `EmailCredential` (kind `PASSWORD`), envelope-encrypted like OAuth tokens. Host, port and security are kept in plain columns. A reconnect updates the password or settings and keeps the cursors.
- **Transport policy (production):** implicit TLS or STARTTLS only, TLS ≥ 1.2, certificates verified. Hosts that resolve to private, loopback or link-local addresses are refused, so a typed-in server cannot reach our own network. Only the tests relax this, in code (`MailEndpoints.imap`), never through an environment variable.
- **Message identity:** `providerMessageId` is `mid:<Message-ID>`, so one message has one row across folders (a move, or mail sent to oneself). Without a Message-ID it is `uid:<uidvalidity>:<uid>@<folder>`. Each folder copy is a `MessageFolder` row carrying its `imapUid`.
- **Sync, per synced folder** (defaults: Inbox, Sent, Archive, Junk, custom folders):
  - The first read searches `SINCE <window>`. After that, UIDs above `lastUid`.
  - Already-stored UIDs are skipped, so an interrupted import resumes where it stopped.
  - Then the flags of the folder's copies within the window are fetched: read/starred are updated, and UIDs that are gone (or flagged \\Deleted) are unlinked. A message left in no synced folder is removed.
  - A changed UIDVALIDITY drops the folder's links and reads the window again; Message-IDs dedupe.
  - CONDSTORE/QRESYNC are not used yet; the flag pass covers the window on every run.
- **Threading:** In-Reply-To / References, otherwise the same normalised subject (4+ characters) with the same sender or recipients within 30 days.
- **Push:** the worker's `ImapIdleService` keeps one IDLE connection per active IMAP mailbox on its inbox. EXISTS queues a sync (debounced 1.5 s). It reconnects with backoff (5 s doubling up to 5 min), and imapflow re-issues IDLE every 25 minutes. The 5-minute poll includes IMAP. That is at most 2 connections per mailbox (IDLE + sync).
- **Send:** SMTP with Bcc only in the envelope (the Bcc header is never sent). Then the full copy is APPENDed to Sent unless a message with that Message-ID is already there (servers that file their own copy). Once SMTP accepts, the draft is marked (`providerDraftId = smtp-accepted:<Message-ID>`), so a retry never sends twice; it only finishes the Sent copy. A failed APPEND does not fail the send.
- **CRM actions:** read and star set \\Seen / \\Flagged on every copy. Archive moves the inbox copy to the Archive folder, spam to Junk, and back. The folder and UID are captured when the action is taken, because the local links change at once.
- **Attachments:** metadata is stored at sync. Content is fetched on demand by downloading the message from one of its folders and taking the part out.
- **Errors:** a refused login → `AuthError` (the mailbox goes to NEEDS_REAUTH). Network, timeout and 4xx SMTP → `TransientError` (retried). Certificate/TLS problems → a non-retried error with the reason.

## 5a. As built in Phase 2 (2026-11-17)

Where the implementation differs from or narrows the plan above:
- **Scopes requested at connect.** Gmail: `openid email https://www.googleapis.com/auth/gmail.modify`. `gmail.modify` also covers `messages.send`, so no separate `gmail.send` is needed. Microsoft: `openid email offline_access User.Read Mail.ReadWrite Mail.Send`. Both reuse the sign-in apps, with an extra redirect URI.
- **Gmail initial sync** fetches messages one by one with 5 in parallel, not through batch requests. It skips messages already stored, so an interrupted import resumes where it stopped.
- **Graph** sends `Prefer: IdType="ImmutableId"` on every call, so a message keeps its id when moved. Only top-level folders are listed. Child folders, shared mailboxes and the app-only Application Access Policy route are not built yet.
- **Provider drafts are not imported.** CRM drafts come in Phase 3.
- **Attachments**: metadata only. Content download and virus scanning come in Phase 3 with the attachment viewer.
- **Status re-assessment** (a new inbound message re-opening CLOSED / REPLY_NOT_NEEDED) is left to Phase 6. Phase 2 maintains `awaitingReplySince`, `firstResponseAt` and the counts.
- **Microsoft disconnect** cannot revoke a single refresh token: Graph only offers revoking all of a user's sessions. The stored token is deleted, and the audit entry records `providerRevoked: false`.
- **Webhooks** reach the API through `crm-web` (`${APP_URL}/api/v1/webhooks/...`). Graph push is only enabled when `APP_URL` is https. Gmail push is only enabled when `GMAIL_PUBSUB_TOPIC` and `GMAIL_PUSH_SERVICE_ACCOUNT` are set.

## 6. Real-account test checklist (done per provider before it is marked complete)

1. Connect 2+ accounts of the provider. Initial sync count matches the provider UI within the sync window.
2. Send a mail from outside → it appears within 60s (push) and within 5 min with push disabled.
3. Reply from the CRM → the recipient sees it in the same thread; the provider's Sent folder shows it; there is no duplicate in the CRM.
4. Reply from the provider's own web UI → it appears in the CRM thread as outbound.
5. Mark read/star/archive in the CRM → reflected at the provider, and the reverse.
6. Attachments: receive PDF/image/zip; download them intact (checksum compared); send attachments.
7. Revoke access at the provider → the account goes to NEEDS_REAUTH and a notification fires; reconnect → no missing or duplicate messages.
8. Kill the worker for 30 minutes during inbound traffic → after restart every message is present exactly once.
