# Phase 2 — Gmail and Microsoft 365 mailboxes

**Status:** built and tested locally against stand-in Google and Microsoft servers, 2026-11-17. **Not yet verified with real mailboxes, and not deployed.** Per the spec, the integration does not count as complete until the real-account checks below pass.

Website URL used below: `https://crm-web-gn7n.onrender.com`. If you move to your own domain, update `APP_URL` and every redirect URI.

## What works

| Area | Delivered |
|---|---|
| Connect | **Mailboxes** screen (Super Admin): *Connect Gmail* / *Connect Microsoft 365*, choose a department and how many days of existing mail to import. OAuth with PKCE and a signed state cookie bound to the admin who started it. Offline access is required; a grant without a refresh token or without mail scope is refused with a clear message |
| Credentials | Refresh and access tokens are envelope-encrypted (AES-256-GCM, versioned master key, account id bound as AAD). Access tokens refresh 5 minutes before expiry or after a 401. Microsoft's rotated refresh tokens are saved |
| Gmail sync | Labels become folders (system flags such as UNREAD and CATEGORY_* are not folders). The first sync imports the window and records the history position first, so nothing in between is lost. Incremental sync via `history.list`: new mail, label/read/star changes, deletions. If Google has dropped old history, the window is re-read |
| Microsoft sync | Per-folder delta queries with immutable ids: moves are not mistaken for deletions. Inbox, Sent, Archive, Junk and custom top-level folders are synced by default; Drafts and Deleted are off. Expired delta tokens restart that folder. Attachment metadata is fetched |
| Storage | Messages are deduplicated by mailbox + provider id. Threads come from Gmail `threadId` / Graph `conversationId`, otherwise In-Reply-To / References. Inbound vs outbound, unread counts, starred, spam/trash/archived, SLA clock (`awaitingReplySince`), first response time |
| Push | Gmail watch → Pub/Sub → `/api/v1/webhooks/gmail`, verified by Google's signed OIDC token (signature, audience, service account), deduplicated per Pub/Sub message. Graph subscriptions on Inbox and Sent with a random clientState (only its hash is stored) and lifecycle events. Both are renewed automatically |
| Reliability | Every mailbox is checked every 5 minutes even when push works. One queued + one running sync per mailbox. Retries with backoff (30 s to 30 min, 5 attempts). A revoked grant sets **Reconnect needed** immediately (no pointless retries). 5 failed runs in a row set **Failing**. Reconnecting resumes from the stored cursor |
| Management | Health table (status, messages, conversations, last sync, newest mail, push on/off, last error). Per mailbox: sync now, full resync, pause/resume, disconnect, display name, department, folders on/off, access grants (employee / team / department × Read / Reply / Manage), last 20 sync runs |
| Disconnect + retention | Disconnect stops push, revokes the Google grant, deletes the stored credential and schedules deletion of the mail **120 days** later. A daily job (03:00 IST) deletes the content and keeps the account row and its audit trail |
| Audit | Connect, reconnect, settings, folders, access, sync, pause/resume, disconnect, automatic status changes and purges are all logged |
| Worker | New Render service `crm-worker` (`node apps/api/dist/worker.js`). Jobs live in PostgreSQL (pg-boss), so no Redis is needed |

## How it was verified

- **99 automated tests, all passing** (`npm test`). New in this phase:
  - **7 provider unit tests**: address lists with quoted commas and groups, RFC 2047 headers (UTF-8 B, ISO-8859-1 Q), Gmail MIME trees with latin-1 text parts and inline/attached files, Graph messages, error classification, token refresh on 401.
  - **23 end-to-end tests** against a real PostgreSQL and a local stand-in for Google and Microsoft (`apps/api/test/fake-mail.ts`). That server speaks the documented Gmail, Graph and OAuth HTTP shapes. It is a test double, **not proof that the real integration works**. The tests cover:
    - connect flow, including forged state, stolen state cookie, missing refresh token and missing scope;
    - encrypted token storage, Gmail initial and incremental sync, label changes, deletions, expired history;
    - token refresh, revoked grant → Reconnect needed → reconnect without re-importing;
    - Microsoft folder delta, moves, deletions, expired delta token, subscription creation and renewal;
    - Gmail push token checks (wrong audience, wrong service account, forged token) and duplicate deliveries;
    - Graph validation handshake and clientState checks;
    - access-based visibility, pause/resume, full resync, disconnect with revocation, the 120-day purge;
    - the **real worker process** picking up a queued sync from pg-boss and setting up push.
- **Live run of the production builds** (API + worker + web on the local PostgreSQL with the new migration): the worker started and scheduled its jobs without errors; through the web proxy, the Mailboxes page loads, the API refuses unauthenticated calls, the Graph validation handshake echoes correctly and Gmail push stays closed while unconfigured.

## Not verified yet (needs your accounts)

Nothing in this phase has talked to the real Google or Microsoft yet. Real-account checklist from [06 §6](../06-provider-integrations.md#6-real-account-test-checklist), Phase 2 part:

| # | Check | Status |
|---|---|---|
| 1 | Connect 2+ Gmail/Workspace and 2+ Microsoft 365 mailboxes; message counts in the window match the provider | ⏳ |
| 2 | Mail sent from outside shows up within 60 s with push, within 5 min without | ⏳ |
| 7 | Revoke access at the provider → *Reconnect needed*; reconnect → nothing missing or duplicated | ⏳ |
| 8 | Stop the worker 30 min during incoming mail → after restart every message present exactly once | ⏳ |
| 3–6 | Replies, flags and attachments in both directions | Phase 3 |

## Setup you need to do

### A. Google Cloud (Gmail)
1. Open your Google Cloud project, or create one. Enable the **Gmail API** (and **Cloud Pub/Sub API** if you want push).
2. **OAuth consent screen**:
   - User type **External**.
   - Scopes `openid`, `email`, `profile`, `.../auth/gmail.modify`.
   - Leave it in **Testing** for now and add every mailbox you will connect, and every employee who signs in with Google, as a **test user**.

   In Testing, Google ends mailbox connections after 7 days (the mailbox shows *Reconnect needed*), and only test users can sign in. Both limits go away after Google's verification and CASA review, which you are starting.
3. **OAuth client (Web application)**, authorised redirect URIs:
   - `https://crm-web-gn7n.onrender.com/api/v1/auth/sso/google/callback` (employee sign-in)
   - `https://crm-web-gn7n.onrender.com/api/v1/accounts/oauth/google/callback` (mailboxes)
4. **Push (optional, recommended)**:
   - Create topic `gmail-push`.
   - Give `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on it.
   - Create a service account (e.g. `gmail-push`).
   - Create a **push** subscription to `https://crm-web-gn7n.onrender.com/api/v1/webhooks/gmail` with **authentication enabled** using that service account. Leave the audience empty, so it defaults to the endpoint URL.

### B. Microsoft Entra (Microsoft 365 / Outlook)
1. Use the sign-in app registration. Supported accounts: *any organizational directory and personal Microsoft accounts*.
2. **Authentication → Web redirect URIs**:
   - `https://crm-web-gn7n.onrender.com/api/v1/auth/sso/microsoft/callback`
   - `https://crm-web-gn7n.onrender.com/api/v1/accounts/oauth/microsoft/callback`
3. **API permissions → Microsoft Graph → Delegated**: `openid`, `email`, `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`. Then **Grant admin consent** for your tenant.
4. **Certificates & secrets**: create a client secret.

### C. Render
1. Push the code. The Blueprint creates **`crm-worker`**, about $7/month on the Starter plan.
2. In **Render → Environment Groups → `crm-integrations`**, set:
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`
   - for push: `GMAIL_PUBSUB_TOPIC` (`projects/<project-id>/topics/gmail-push`) and `GMAIL_PUSH_SERVICE_ACCOUNT` (the service account's email)
3. Save. `crm-api` and `crm-worker` both read this group.

### D. Connect
1. Sign in as Super Admin and open **Mailboxes → Connect Gmail / Connect Microsoft 365**.
2. Sign in **as the mailbox** (e.g. sales@) and allow access.
3. The status shows *Importing*, then *Syncing*. Then grant access to the people or teams who will work that mailbox.

## Known gaps carried forward

- Reading and replying to conversations is Phase 3 (inbox UI, compose/send, attachment download, flags pushed back to the provider).
- Microsoft: child folders, shared mailboxes and the app-only (Application Access Policy) route are not built yet.
- Status re-assessment when a customer writes into a closed conversation is Phase 6 (SLA). The SLA clock data is already maintained.
- Microsoft offers no per-token revocation. Disconnect deletes the stored token, and the audit entry records `providerRevoked: false`.
- The web start script uses Linux shell syntax, so start Next directly on Windows: `cd apps/web && npx next start -p 3000`.

## Run it locally

```bash
npm run db:local                                 # terminal 1
npm run db:migrate && npm run build
npm run start:local -w @crm/api                  # terminal 2: API on :4000
npm run start:worker:local -w @crm/api           # terminal 3: worker
cd apps/web && npx next start -p 3000            # terminal 4: web
```

Connecting a real mailbox locally needs the Google/Microsoft redirect URIs for `http://localhost:3000/...` added to the apps. Push stays off locally: Graph requires https, and Pub/Sub can't reach localhost. The 5-minute poll still syncs.
