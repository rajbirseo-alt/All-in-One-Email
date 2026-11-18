# Phase 3 — Unified inbox and email actions

**Status:** built and tested locally against stand-in Google and Microsoft servers, 2026-11-18. **Not yet verified with real mailboxes** (same blocker as Phase 2: Google/Microsoft app setup). Not deployed beyond what `main` auto-deploys.

## What works

| Area | Delivered |
|---|---|
| Who sees what | Conversation scopes from [05 §4](../05-auth-permissions.md): ALL, DEPARTMENT, TEAM, ASSIGNED, plus mailbox grants to an employee, team or department, shares and @-mentions. A mailbox assigned to a department counts as that department's mail. Out-of-scope conversations, messages and attachments return 404 |
| Inbox | `/inbox`: three columns, with views on the left, the list in the middle and the conversation on the right. One column on phones. Views: Inbox, Assigned to me, Unassigned, Unread, Awaiting reply, Starred, Snoozed, Follow-up, Waiting for client, Sent, Archive, Closed, Spam, Trash, All. Unread badges, mailbox filter, full-text search (subject, sender, body), "Load more" paging |
| Reading | HTML is sanitised on the server, with no scripts, forms, frames, `<style>` or event handlers. It renders in a sandboxed frame with no script permission. Remote images (tracking pixels) are hidden until *Show images*. Embedded `cid:` images and attachments are fetched from Gmail/Outlook only after the same permission check, and a checksum is recorded |
| Triage | Mark read/unread, star, archive, spam (plus undo), snooze (3 h / tomorrow / next Monday). The CRM updates at once; the change then goes to Gmail labels or Outlook (read flag, flag, move to Archive/Junk), in order per conversation. A sync in between does not undo it |
| Writing | Reply, Reply all (never including the mailbox itself), Forward (original attachments included) and New email from any mailbox you may send from. The server pre-fills recipients, subject and quote. Autosave. Bold/italic/underline/list/link; pasting inserts plain text only. File uploads (25 MB total, executables refused). Templates. Default signature. Send later, with cancel |
| Sending | **Only the explicit Send** sends: no other code path does, which will also hold for AI drafts in Phase 8. Permission is checked again at send time: replying needs REPLY/MANAGE on the mailbox unless the conversation is assigned to you. If new mail arrived while you wrote, sending stops and shows it, with *Send anyway* / *Keep editing*. Gmail: MIME with `In-Reply-To`/`References` and the Gmail thread id. Outlook: its own reply / reply-all / forward flow, so the Outlook conversation stays intact, with upload sessions for files over 3 MB. The sent message appears in the CRM at once and is not duplicated when the provider's copy syncs |
| Never twice | A draft is claimed atomically before sending. If Gmail accepted a message but the call failed, the retry finds it by its Message-ID instead of sending again. A half-built Outlook draft is rebuilt rather than sent twice. A cancelled and re-scheduled send ignores the old job |
| Live updates | New mail, sends and colleagues' changes refresh open inboxes within about a second (Server-Sent Events, with PostgreSQL NOTIFY between worker and API). Each user only gets ids of conversations they may see. A revoked session is cut off at the next 25-second heartbeat, which doesn't keep idle sessions alive |
| Signatures & templates | `/settings/compose`. Signatures are per user (default per mailbox or for all). Templates are private, shared with your department, or company-wide (admins). Both are sanitised on save |
| Audit | Every send (ids and counts only, never bodies), cancellations, archive/spam |

## How it was verified

- **131 automated tests, all passing** (`npm test`). New in this phase, 32 end-to-end tests against a real PostgreSQL and the local stand-in for Google and Microsoft:
  - **access matrix:** no access, assigned, mailbox grant READ vs REPLY, department manager by mailbox department, team leader by team grant, @-mention;
  - **inbox:** views, search, paging and counts;
  - **reading:** HTML sanitising and image blocking; attachment downloads with checksums from both providers, including Gmail's unstable attachment ids;
  - **triage:** read/archive/spam/star pushed to each provider, archive surviving an intermediate sync, snooze;
  - **drafts and sending:** reply/reply-all prefill, privacy of drafts, Gmail threading headers, THREAD_CHANGED and *Send anyway*, forward with original plus uploaded files, the ambiguous-failure retry that must not send twice, scheduled send and cancel, Outlook reply-all with a 3.5 MB upload session (checked to send no token to the pre-authenticated upload URL), no duplicate after sync;
  - **signatures, templates and sharing;**
  - **live updates:** filtered per user, ended on revocation, refused without login.
- **Live run of the production builds** (API + worker + `next start`) on the dev database, with the stand-in Google server, all through the web proxy. 9/9 checks passed:
  1. connect a mailbox
  2. the worker imports it
  3. it appears in the inbox
  4. the conversation opens
  5. a live update arrives through the Next.js proxy without buffering
  6. a reply is sent by the worker into the Gmail thread with the right headers
  7. `/inbox` loads
  8. `/settings/compose` loads
  9. `/admin/mailboxes` loads

## Not verified yet (needs real mailboxes)

From [06 §6](../06-provider-integrations.md#6-real-account-test-checklist): **3** (replies thread correctly at the recipient for Gmail and Outlook), **4** (replies from the provider's own UI show up), **5** (flags both ways), **6** (attachments intact both ways). Phase 3's exit criterion — replies threading correctly at the recipient, attachment checksums matching — also needs real accounts.

## Known gaps carried forward

- **Database row-level security (RLS) is not done.** The docs scheduled it for this phase as a second layer behind the query filters. Every query already goes through the access filter, and the 32 tests check it. RLS needs per-request database transactions, so it moves to Phase 10 (hardening).
- **Uploaded attachments are stored in PostgreSQL** until sent, then deleted. Object storage (S3/R2) and virus scanning (ClamAV) are not set up yet: received attachments are proxied, never stored.
- The editor is deliberately simple: no inline images, font sizes or tables.
- Assignment, internal notes and status changes come in Phase 5 / 6. The views exist; "Assigned to me" stays empty until then.
- Gmail provider drafts are not imported; drafts live in the CRM.
- Search treats `zebrafish.com` as one word (PostgreSQL text search): search `zebrafish.com`, not `zebrafish`.
