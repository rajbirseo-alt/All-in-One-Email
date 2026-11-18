# 02 — Database Schema

The source of truth is [packages/db/prisma/schema.prisma](../packages/db/prisma/schema.prisma). It passes `prisma validate` and contains 53 models and 35 enums. This document explains the design. It does not repeat every column.

## Entity map

```
Role ─< RolePermission >─ Permission ─< UserPermissionOverride >─ User
Department ─< Team ─< TeamMember >─ User          User ─< Session, UserIdentity

EmailAccount ─1 EmailCredential (encrypted)
     │ ─< EmailAccountAccess (user | team | department, READ/REPLY/MANAGE)
     │ ─< EmailFolder ─< MessageFolder >─ EmailMessage ─< Attachment
     │ ─< EmailWebhookSubscription, SyncLog
     └─< EmailThread ─< EmailMessage
              │ ─< Assignment, StatusHistory, InternalNote ─< NoteMention
              │ ─< ThreadShare, ThreadTag >─ Tag, Draft ─< Attachment
              │ ─< AiSummary, AiSuggestion, SlaEvent, Task, Notification
              └── Contact ─< ContactEmail;  Contact >─ Company;  Lead >─ Contact

AssignmentRule, RoundRobinCursor, SlaPolicy ─< SlaStep, BusinessCalendar ─< Holiday
AutomationRule ─< AutomationRun, WebhookEvent, AuditLog
```

## Design decisions

**Single company (single-tenant).** The system serves SEO Discovery only, so there is no `organizationId` on every row. Isolation happens between employees, not between tenants.

**A conversation belongs to exactly one mailbox.** `EmailThread.emailAccountId` is required. That is how "reply from the correct account" is guaranteed. Sometimes one external email reaches two company mailboxes (for example sales@ and info@ both CC'd). Each mailbox then gets its own thread, and the UI links them through the shared `internetMessageId` and shows "Also in info@".

**Provider IDs sit next to internal IDs.**
- `EmailThread.providerThreadId`: Gmail `threadId`, Graph `conversationId`, null for IMAP
- `EmailMessage.providerMessageId`: Gmail message id, Graph id, IMAP `uidvalidity:uid@folder`
- `EmailFolder.providerFolderId`: Gmail label id, Graph folder id, IMAP path
- `EmailMessage.internetMessageId`, `inReplyTo`, `references`: the RFC 5322 headers that work across providers

**Duplicate prevention** is done with unique constraints, so it doesn't depend on application logic:
- `email_messages (email_account_id, provider_message_id)`
- `email_threads (email_account_id, provider_thread_id)`
- `webhook_events (provider, external_event_id)`
- `drafts.idempotency_key`, `automation_runs.idempotency_key`, `sla_events (thread_id, step_id, cycle_start)`

**Collision detection.** `EmailThread.version` goes up on every inbound or outbound message and on every status change. A draft stores `baseThreadVersion`, and the send endpoint compares the two (see 01 §6).

**SLA clock.** `awaitingReplySince` is set when an inbound message arrives that has no later outbound message. It is cleared when someone replies or the status moves to `REPLY_NOT_NEEDED` or `CLOSED`. `SlaEvent` rows make each escalation step fire only once per waiting cycle.

**"Reply Not Needed" leaves pending reports.** Pending-response queries filter `awaitingReplySince IS NOT NULL AND status NOT IN ('REPLY_NOT_NEEDED','CLOSED')`. When a new inbound message arrives, the status is re-assessed back to `PENDING_REPLY` (see 05 and the status rules in 03).

**Credentials.** `EmailCredential` stores only an AES-256-GCM ciphertext, IV, auth tag and a **KMS-wrapped data key**. Rotating the key means re-wrapping the data keys, not re-encrypting all data. Plaintext tokens exist only in worker memory while a job runs.

**Contacts.** Each address in `ContactEmail.email` is unique, so one address maps to one contact, and one contact can have many addresses. A merge sets `mergedIntoId` on the losing contact and moves its emails, threads, leads and tasks in one transaction. Nothing is hard-deleted, which keeps merges auditable and reversible by an admin.

**Audit log is append-only.** The application DB role is granted only `INSERT, SELECT` on `audit_logs`.

## Things Prisma cannot express (raw SQL migration `20261116110000_security_search`)

Columns use Prisma's camelCase names (quoted in SQL). The sketch below shows the intent; the migration file is authoritative. Audit immutability is implemented as a trigger rather than REVOKE, because on Render the application connects as the table owner. RLS was planned with the conversation module in Phase 3 and has moved to Phase 10 (hardening); see phases/phase-3.md.

```sql
-- Full-text search
ALTER TABLE email_messages ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(subject,'')), 'A') ||
  setweight(to_tsvector('simple', coalesce(from_address,'') || ' ' || coalesce(from_name,'')), 'B') ||
  setweight(to_tsvector('simple', coalesce(body_text,'')), 'C')
) STORED;
CREATE INDEX email_messages_search_idx ON email_messages USING GIN (search_vector);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX contact_emails_trgm ON contact_emails USING GIN (email gin_trgm_ops);
CREATE INDEX contacts_name_trgm  ON contacts USING GIN (name gin_trgm_ops);

-- Exactly one grantee on mailbox access
ALTER TABLE email_account_access ADD CONSTRAINT one_grantee CHECK (
  (user_id IS NOT NULL)::int + (team_id IS NOT NULL)::int + (department_id IS NOT NULL)::int = 1);

-- Audit immutability
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM crm_app;

-- Row-Level Security (defense in depth; see docs/05 §5)
ALTER TABLE email_threads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_notes ENABLE ROW LEVEL SECURITY;
-- policies call crm_can_read_thread(thread_id) which reads current_setting('app.user_id')
-- and the precomputed table user_visible_accounts / user_thread_grants.
```

## Indexing strategy

The schema's indexes are built for the heaviest queries:

| Query | Index |
|---|---|
| Mailbox list, newest first | `email_threads (email_account_id, last_message_at desc)` |
| "Assigned to me" by status | `email_threads (assignee_id, status, last_message_at desc)` |
| Overdue sweeper | `email_threads (status, sla_due_at)` |
| Thread view | `email_messages (thread_id, received_at)` |
| Threading lookup | `email_messages (email_account_id, internet_message_id)` |
| Notifications bell | `notifications (user_id, read_at, created_at desc)` |
| Snooze wake-up | `email_threads (snoozed_until)` |

## Retention

- Disconnecting an account sets `status = DISCONNECTED`, `disconnectedAt`, and `purgeAfter = now + retention period` (**120 days**, decided 2026-11-16; configurable). The credential is deleted immediately and the provider token is revoked.
- A daily job purges message bodies, attachments in storage and threads for accounts past `purgeAfter`. Metadata needed for reports (counts, response times) stays in aggregate tables built in Phase 9.
- Audit logs are kept for **7 years** (decided 2026-11-16). They are exempt from mailbox purges. A database trigger blocks any UPDATE, DELETE or TRUNCATE on `audit_logs`. The only exception is the retention purge, which may delete rows older than 7 years once it sets `app.audit_purge = on`.
- The database session time zone is pinned to UTC (migration `20261116130000_utc_timezone`), so database-side timestamps match the UTC values Prisma writes.
