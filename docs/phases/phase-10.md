# Phase 10 — Hardening and production readiness

**Status:** built and tested locally, 2026-11-23. The restore drill runs in CI on every push.

Go-live still needs:
- the production plans, the ClamAV service and the attachment bucket on Render;
- an external penetration test;
- sign-off of the acceptance criteria ([acceptance.md](../acceptance.md)), most of which wait for real mailboxes.

## What works

### 1. Access control in the database (Postgres row-level security)

- **Five tables are filtered by PostgreSQL itself:** conversations, messages, attachments, internal notes and AI summaries. They follow the same rules as the app: assigned, team, department, mailbox grants, shares and @-mentions.
- **A second layer:** if application code ever forgets its access filter, the database still returns only what the employee may see. A test removes the filter on purpose to prove it.
- **Fail closed:** a request without a signed-in employee sees no conversation rows at all.
- **Writes too:** an employee cannot change or add notes to a conversation they cannot see. Handing a conversation to another team still works.
- **Tests now match Render:** local and CI databases now connect as a normal, non-superuser owner, like Render, because a superuser would silently bypass RLS.

### 2. Attachments: virus scanning and encrypted storage

**Virus scanning (ClamAV).** Every upload, every received file before download, and every forwarded file is scanned.
- **Infected file:** refused with the virus name, never stored or passed on, and recorded in the audit log.
- **Scanner unreachable:** files are refused rather than let through. Queued emails retry.
- On when `CLAMAV_HOST` is set.

**Object storage (any S3 bucket, e.g. Cloudflare R2).**
- Uploaded files, and received files after their first download, are kept in the bucket **encrypted with the app's own keys**.
- Received files then download fast, even while the mailbox is paused.
- Stored files are deleted when the email is sent, the draft is deleted, or the mailbox's mail is purged.
- On when `S3_BUCKET` is set; otherwise behaviour stays as before.

### 3. Monitoring and alerts

- **Admin → System health:** database, background worker, job queues, mailbox sync, sending, report figures, virus scanner and storage, each ok / warning / failing in plain words.
- **Alerts:** every 5 minutes the worker re-checks. Super Admins get a notification (bell and browser push) **once** when something breaks or gets worse, and once when it recovers.
- **`/api/v1/metrics`** (Prometheus format, token-protected) for an external monitor.

### 4. Security fixes

- Content-Security-Policy and HSTS on all pages.
- **Rate limits:** generous per IP (a whole office shares one IP) plus a per-employee limit.
- Error messages are kept in background jobs, so a failed send shows its real reason.
- Full list: [security-review.md](../security-review.md).

### 5. Load test: [load-test.md](../runbooks/load-test.md)

**Setup:**
- 50 mailboxes × 2,000 emails a day: 100,000 conversations.
- 100 employees using the inbox at once, against the production builds with RLS on.

**Results:**
- **New mail visible in 2–4 s** (SLO < 60 s ✅). The first mail after connecting a mailbox took 13 s.
- **Inbox list:** p50 ~120 ms, **p95 302–322 ms** (SLO < 300 ms: at the limit on a laptop that also ran the load generator, the worker and the database). To be confirmed on Render with `crm-api` on the Standard plan.

**Real problems the load test found and fixed:**

| Problem | Before | After |
|---|---|---|
| RLS check per row | 37 s per list | 30 ms |
| Search under RLS | 25 s | 1 s |
| Report rollup | 10+ min | 23 s |
| One dead IMAP host | delayed every other mailbox's push | mailboxes connect in parallel |
| New mailbox, first mail | waited for the 5-minute poll | caught up when push starts |
| Permission lookups | repeated on every request | cached, dropped at once on change |

### 6. Backups and restore drill: [backup-restore.md](../runbooks/backup-restore.md)

On every CI run, a production-like database (non-superuser owner, 5,000 conversations, 100 employees) is backed up with `pg_dump` and restored into an empty database. Then:
- the row counts of all tables and the id checksums must match;
- all RLS policies must be present;
- **RLS must still work in the restored copy.**

The runbook also explains Render's point-in-time recovery. It warns that `ENCRYPTION_KEYS` must be backed up separately, and that `pg_dump` needs `--enable-row-security`.

### 7. Runbooks

| Runbook | Covers |
|---|---|
| [deploy.md](../runbooks/deploy.md) | Services, recommended plans, secrets, domain, rollback, the database role |
| [monitoring.md](../runbooks/monitoring.md) | Checks, thresholds, external alerts |
| [incidents.md](../runbooks/incidents.md) | What to do for each alert |
| [backup-restore.md](../runbooks/backup-restore.md) | Backups, restore, the drill |
| [load-test.md](../runbooks/load-test.md) | How to run the load test, the results |

## How it was verified

**Automated tests: 22 new end-to-end tests.**

**RLS (6 tests)**
- For 8 people of every scope, the database alone returns exactly what AccessPolicy allows.
- Content tables follow their conversation.
- Raw SQL, batches and transactions are filtered.
- Writes to hidden conversations are refused.
- A request without a user sees nothing.
- Over HTTP with the app filter removed, an employee still gets only their own.

**Virus scanning and storage (10 tests)**
- The clamd protocol, including files larger than one chunk.
- An infected upload is refused and stored nowhere.
- An infected received file is blocked on every attempt and audited.
- Forwarding an infected file fails the send.
- A scanner outage refuses files (503).
- S3 signing is verified by the stand-in.
- Files are stored encrypted (the plaintext is not in the bucket) and served from storage while the mailbox is paused.
- Uploads are deleted after send; files go with draft delete and with the retention purge.

**Health (4 tests):** all checks run; a stopped scanner fails; metrics need the token; alerts go out once per problem, once when worse, and once on recovery.

**Rate limit and permission cache (2 tests).**

**Earlier tests:** all still pass; the analytics test also checks the rewritten rollup. **270 tests in total.**

**Other checks**
- **Load test:** see above.
- **Restore drill:** in CI.
- **Production build smoke:** pages load with the new security headers.

**Not checked by eye:** the new screens (System health, the dashboard from Phase 9) compile and load, but have not been looked at in a browser.

## Needed from SEO Discovery

1. **Production plans on Render:** `crm-api` and `crm-worker` on **Standard**. Starter is too small for 100 active employees.
2. **A ClamAV service** (Docker image `clamav/clamav:stable`, 3 GB+ RAM). Set `CLAMAV_HOST`.
3. **An attachment bucket** (e.g. Cloudflare R2) and its keys (`S3_*`).
4. **A safe copy of `ENCRYPTION_KEYS`** outside Render (password manager).
5. **An external monitor:** uptime on `/api/v1/health`, and optionally Prometheus scraping of `/api/v1/metrics` with a `METRICS_TOKEN`.
6. **An external penetration test** before go-live.
7. **Acceptance sign-off** ([acceptance.md](../acceptance.md)). It needs the real mailboxes and inputs listed there.

## Known gaps

- **Viewing is not audited.** Opening a conversation and downloading a file are not in the audit log; decide whether viewing must be logged.
- **The CSP allows inline scripts,** which Next.js needs without nonces.
- **Inbox p95 is at the limit locally.** It must be measured on Render. If it is above 300 ms there, run 2 API instances.
- **Late reassignments in reports.** The two-day "settle" of report figures runs nightly, so a conversation reassigned more than 3 hours later shows its new owner in reports from the next morning.
- **Search cap.** Search looks at up to 2,000 candidate conversations per word. With a very common word, an employee with narrow access may miss some of their own matches; more specific words find them.
