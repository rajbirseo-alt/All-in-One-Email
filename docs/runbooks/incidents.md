# Runbook: common incidents

Start with **Admin → System health**. It usually names the problem.

## A mailbox "needs reconnecting"

**Cause:** the provider refused the stored access. Typical reasons: a changed password, revoked consent, or an expired app password.

**Effect:** no new mail from that mailbox. Nothing is lost; mail stays at the provider.

**Fix:** Admin → Mailboxes → **Reconnect** (OAuth), or **Change password or server** (IMAP). The next sync fetches everything missed. There are no duplicates, because messages are keyed by provider id / Message-ID.

## "Background worker" is failing

**Check:** Render → `crm-worker` → logs and restarts. Common causes:
- out of memory (raise the plan);
- a crash loop after a deploy (roll back);
- a database connection limit.

**After it is back:** sync, sending, SLA steps and alerts catch up by themselves. Jobs are in PostgreSQL and survive restarts.

## Mail is slow to appear

**Check:** "Mailbox sync" and "Job queues".
- **One mailbox behind:** its provider is slow or rate-limiting. See its sync log under Admin → Mailboxes.
- **All mailboxes behind and the queue is growing:** the worker is overloaded. Raise the `crm-worker` plan, or add a second worker instance; jobs are shared safely.

## Emails stuck or failing to send

**Check:** "Sending". Failed drafts show the reason to their author, who can edit and send again.

**Stuck in the queue:** the worker is down, or the provider is rate-limiting.

**Never resend by hand from the provider.** The CRM records accepted sends and never sends twice.

## Virus scanner not answering

**Effect:** attachment uploads and downloads are refused (503) until it is back; this is deliberate. Sends with attachments retry by themselves.

**Fix:** Render → the ClamAV service. It needs 3 GB+ memory, and its first start downloads signatures, which takes a few minutes.

## Slow pages

**Check:** Render metrics for `crm-api` CPU and `crm-db` CPU and connections.

**Fixes:**
- API CPU above 80%: raise the plan, or run 2 instances. The API is stateless, so any instance can serve any request, and live updates use PostgreSQL LISTEN.
- Load test numbers for comparison: [load-test.md](load-test.md).

## Someone may have seen mail they should not

1. Admin → Audit log: filter by the person and the time. Sign-ins, sends, assignments, status changes, exports, blocked files and permission changes are there. Opening a conversation or downloading a file is **not** logged yet (see the known gaps in `docs/phases/phase-10.md`).
2. Check their role and overrides under Admin → Employees.
3. Access is enforced twice, by the API and by PostgreSQL row-level security. A gap needs **both** to be wrong; report it as a security bug.

## Restore needed

See [backup-restore.md](backup-restore.md).
