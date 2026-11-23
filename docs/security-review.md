# Security review (Phase 10)

This is an internal review against the spec's security rules and the OWASP Top 10. It is **not a substitute for an external penetration test**, which should be run against the production deploy before go-live (see the end).

## Access control (spec: "enforced on the backend and database queries")

| Layer | What it does | How it is tested |
|---|---|---|
| Route guard | Every route declares its rule; a route without one is denied (fail closed) | Endpoint × role matrix (`rbac.e2e`) |
| Query layer (AccessPolicy) | Every query merges the caller's scope; records out of scope return 404 | Each module's e2e tests |
| **PostgreSQL row-level security (new)** | Threads, messages, attachments, internal notes and AI summaries are filtered in the database by the caller's scope. A request without a signed-in user sees nothing | `rls.e2e`. With the application filter removed on purpose, an employee still only gets their own conversations, and the database's answer equals AccessPolicy's for 8 people of different scopes. Also checked after a restore (`restore-drill`) |
| Live updates | Every event is filtered per subscriber, now also as that subscriber in the database | `events.e2e` |

**Exceptions** (code runs as the system, each documented in the code):
- the worker process;
- the two search lookups that only produce candidate ids;
- the write that hands a conversation over (after the app-level check);
- the shared live-update listener.

## Findings fixed in this phase

| # | Finding | Fix |
|---|---|---|
| 1 | Local and CI databases connected as a superuser, so RLS would have been silently bypassed in every test | They now connect as a non-superuser owner, like Render. The RLS tests would fail otherwise |
| 2 | Attachments were not virus-scanned | ClamAV scanning of uploads, downloads and forwards. Infected files are refused and audited; an unreachable scanner refuses (fail closed) |
| 3 | Uploaded files were stored in the database in plain form | With object storage they are envelope-encrypted with the app's keys before upload. The bucket alone reveals nothing |
| 4 | Web pages had no Content-Security-Policy or HSTS | CSP: scripts and connections to this origin only, no plugins, no framing. HSTS in production |
| 5 | The rate limit was per IP only, so a whole office behind one IP could be blocked | Generous per-IP limit plus a per-employee limit (429 with `Retry-After`) |
| 6 | CSV exports could carry spreadsheet formulas (CSV injection) | Formula-like cells are prefixed (Phase 9) |
| 7 | `ApiException` messages were lost in background jobs ("Api Exception") | The message is kept, so failed sends show the real reason |

## Checked and in place (earlier phases)

- **Secrets:** mailbox passwords, OAuth tokens and TOTP secrets are envelope-encrypted; key rotation is supported.
- **Sessions:** httpOnly, SameSite cookies; CSRF double-submit token plus an Origin check on writes; idle and absolute expiry; revocation on role change.
- **Sign-in:** rate-limited per IP; TOTP required for Super Admin, MD and anyone who manages employees, roles or mailboxes; SSO restricted to company domains and invited addresses.
- **Email content:** HTML is sanitised and shown in a sandboxed iframe without scripts; remote images load only on request.
- **IMAP/SMTP:** private addresses are refused in production (SSRF); TLS 1.2+ with certificate checks.
- **AI:** cannot send. Replies stay drafts until a person sends them (a test scans the code paths). Internal notes are never sent to the AI.
- **Audit:** an append-only audit log (a database trigger refuses updates and deletes) of sign-ins, sends, assignments, status changes, merges, exports, AI use and permission changes.

## Open items

1. **External penetration test** of the production deploy. Suggested scope: authentication and sessions, cross-employee access (IDOR), the mailbox-connect flows (SSRF), file upload and download, CSV export, and the AI prompt-injection guard.
2. **Opening a conversation and downloading a file are not audit-logged yet.** Decide whether viewing must be logged; it adds a row per view.
3. **The CSP allows inline scripts** (Next.js needs them without nonces). Moving to nonces would tighten it.
4. **Dependency scanning:** turn on GitHub Dependabot alerts for the repository.
