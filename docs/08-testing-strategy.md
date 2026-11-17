# 08 — Testing Strategy

## Layers

| Layer | Tooling | What it covers |
|---|---|---|
| Unit | Vitest | Threading algorithm, subject normalisation, MIME building (headers, no notes), SLA business-minute math, rule condition evaluator, permission resolution, encryption round-trip |
| Integration | Vitest + Testcontainers (Postgres, Redis, GreenMail for IMAP/SMTP) | Ingestion pipeline idempotency, AccessPolicy queries + RLS against a real DB, queue retries, IMAP adapter against a real IMAP server |
| Contract | Recorded fixtures from real provider responses (sanitised) | Gmail history/messages/batch parsing; Graph delta/subscription payloads; error mapping (401/404/410/429) |
| API / E2E | Supertest for API; Playwright for web | Full user flows per role; collision 409 flow; bulk actions |
| Authorisation matrix | Generated test suite | For each of the 8 roles × every endpoint × own/assigned/team/dept/other records → expected allow/deny. Runs in CI on every PR |
| Concurrency | Parallel Vitest + k6 | Simultaneous assigns/sends on one thread; duplicate webhook storms; two workers syncing the same account (lock) |
| Load | k6 | Phase 10 SLOs (inbox p95 < 300ms; 100 concurrent users; ingestion throughput) |
| Security | OWASP ZAP baseline, `npm audit`, Semgrep, dependency review; manual pen-test in Phase 10 | XSS via email HTML, CSRF, IDOR, SSRF (IMAP host field: block private IP ranges), auth bypass |
| Real accounts | Manual + scripted checklist (06 §6) | Required before any integration is marked complete |

## Rules

- **Test fixtures are not integration proof.** Fixtures and GreenMail drive automated tests. The integration status for a provider becomes "complete" only once the real-account checklist has been run and logged in `docs/phases/phase-N.md`, with date, account type (the address itself is redacted) and results.
- **Every bug fix adds a regression test.**
- **Tests that must exist and stay green**:
  - `send.noAiAutoSend`: static and runtime check that only `DraftsService.send()` reaches `adapter.send()`, that it requires a human session actor, and that automation and AI actions have no `send` type.
  - `notes.neverInMime`: builds MIME for a thread with notes and asserts that no note text is present.
  - `access.noLeak`: an employee lists, gets, searches, downloads attachments and subscribes over WS for another employee's thread → nothing returned (404 / empty).
  - `sync.exactlyOnce`: replays the same Gmail history page, Graph delta page and IMAP fetch 3 times → message count unchanged.
  - `sync.expiredToken`: an adapter throwing AuthError → account NEEDS_REAUTH, notification created, no retry storm.
  - `sla.businessHours`: inbound Friday 17:30 with a 2h SLA and Mon–Fri 09:00–18:00 hours → due Monday 10:30, and a holiday on Monday → Tuesday.

## Environments

- **Local**: Docker Compose (Postgres 16, Redis 7, MinIO, GreenMail, ClamAV) and seed data of fake users only. Fake mail is never presented as integration proof.
- **Staging**: same topology as prod, connected to dedicated real test mailboxes per provider.
- **Production**: migrations through `prisma migrate deploy` in CI/CD with a pre-deploy backup snapshot.

## Multi-user testing

Playwright runs with multiple browser contexts, one per role (Super Admin, Manager, two Employees), at the same time against staging. The scenarios are: assign → notification; both employees open the same thread → presence banner → one sends → the other gets 409; manager note mention → notification.
