# 01 — System Architecture

## 1. Goals that drive the design

1. **No employee can see email they are not authorised for.** Access is checked on the server for every query, and Postgres Row-Level Security (RLS) enforces it again as a second layer.
2. **Email is never lost or duplicated.** Webhooks only speed up sync; they are not what keeps data correct. Every mailbox also has a sync cursor, a scheduled reconciliation and idempotent writes.
3. **Every reply goes out from the correct account and stays in its thread.** Each conversation belongs to exactly one mailbox. Sending uses that mailbox's provider adapter and keeps the RFC 5322 threading headers.
4. **Humans stay in control of outbound mail.** AI and automation can create drafts. Only the explicit send action of an authorised employee sends external email.

## 2. Topology

```
                         ┌──────────────────────────────┐
  Browser / PWA  ───────▶│  apps/web  (Next.js, React)  │  SSR + client; talks only to apps/api
                         └──────────────┬───────────────┘
                                        │ HTTPS (REST + WebSocket), session cookie
                         ┌──────────────▼───────────────┐
  Google Pub/Sub ───────▶│  apps/api  (NestJS)          │  REST, WebSocket gateway, webhook receivers,
  Graph notifications ──▶│                              │  OAuth callbacks, AccessPolicy, audit
                         └───┬───────────┬──────────┬───┘
                             │           │          │ enqueue jobs
                   Prisma    │     Redis │          ▼
                ┌────────────▼──┐   ┌────▼─────────────────────────────┐
                │  PostgreSQL   │   │ Redis: BullMQ queues, WS pub/sub, │
                │  (RLS on)     │   │ rate-limit counters, presence     │
                └────────────▲──┘   └────▲─────────────────────────────┘
                             │           │ consume jobs
                         ┌───┴───────────┴──────────────────┐
                         │  apps/worker (NestJS standalone)  │  sync, send, SLA, automation, AI,
                         │  + imap-idle supervisor           │  notifications, subscription renewal
                         └───┬───────────┬──────────┬───────┘
                             │           │          │
                   Gmail API  Graph API  IMAP/SMTP   OpenAI API     Object storage (S3-compatible)
```

> **Implementation decisions (Phase 2, 2026-11-17).** These change the diagram above:
> - **Job queue on PostgreSQL ([pg-boss](https://github.com/timgit/pg-boss)) instead of Redis + BullMQ.** It gives the same retries with backoff, cron schedules and one-job-per-mailbox deduplication. It needs no extra service: it runs on this machine without Docker and in tests against the same real PostgreSQL, and Render needs no Key Value service. Redis may still be added in Phase 3 if multi-instance WebSocket fan-out needs it.
> - **The worker is `apps/api/src/worker.ts`**, a second entry point of the API codebase (Render service `crm-worker`), not a separate `apps/worker` package. Both share the same modules.
> - **Provider clients are plain `fetch` code in `packages/providers`**, not `googleapis` / the Graph SDK. This keeps the dependencies small, makes error mapping explicit and lets the tests drive them against local fake servers.

**Why the worker is a separate process:** sync and IMAP IDLE connections are long-running and hold many connections. Running them away from the HTTP API means heavy sync work can't slow the API down, and each can be scaled separately: more API replicas for users, more worker replicas for mailboxes.

## 3. Repository layout (npm workspaces monorepo)

```
apps/
  web/        Next.js 15 App Router, TypeScript, Tailwind, TanStack Query, socket.io-client
  api/        NestJS HTTP + WebSocket gateway
  worker/     NestJS application context running BullMQ processors and schedulers
packages/
  db/         Prisma schema, migrations (incl. raw SQL for RLS/tsvector), generated client, seed
  shared/     Zod DTO schemas, permission keys, enums, API types shared by web/api/worker
  providers/  MailProvider interface + gmail / graph / imap adapters (no Nest dependency)
  crypto/     Envelope encryption (AES-256-GCM + KMS key wrapping), token hashing
  ui/         Reusable React components (buttons, tables, menus, editor shell)
docs/         This design set
```

## 4. Backend modules (apps/api and apps/worker share these)

| Module | Responsibility |
|---|---|
| `auth` | SSO login (Google/Microsoft OIDC), optional password + TOTP, sessions, CSRF |
| `users`, `roles`, `departments`, `teams` | Employee directory and RBAC configuration |
| `access` | **AccessPolicy**: turns (user, permission) into Prisma `where` fragments; sets RLS context |
| `accounts` | Mailbox connect / test / reconnect / disconnect, health, folder selection |
| `sync` | Provider-agnostic ingestion pipeline (normalise → dedupe → thread → persist → emit events) |
| `conversations` | Threads, messages, folders/views, search, flags (read/star/archive/snooze) |
| `compose` | Drafts, signatures, templates, MIME build, send queue, collision check |
| `attachments` | Lazy download, storage, scan, signed download URLs |
| `assignment` | Rules engine, round-robin/least-loaded, bulk ops, history |
| `status` | Status state machine + history |
| `sla` | Business-hours clock, policy matching, step scheduling, overdue views |
| `notifications` | In-app (WS), Web Push (VAPID), preferences |
| `collaboration` | Notes, mentions, shares, tags, presence |
| `crm` | Contacts, companies, matching, duplicate detection, merge |
| `leads` | Lead pipeline, lead detection hand-off, tasks |
| `ai` | OpenAI calls, insight caching, suggestion → draft (never send) |
| `automation` | Trigger/condition/action engine, run log |
| `analytics` | Aggregates for the three dashboards and reports |
| `audit` | Append-only audit writer used by every mutating service |

## 5. Event flow: inbound email (the core path)

1. **Signal**: a Gmail Pub/Sub push, Graph notification, IMAP IDLE `EXISTS`, or scheduled poll → enqueue `sync.incremental {accountId}`. Jobs use a stable job ID per account, so a burst of signals becomes one job.
2. **Fetch** (worker): the adapter pulls changes since the stored cursor (Gmail `historyId`, Graph `deltaLink`, IMAP `UIDVALIDITY/UID/MODSEQ`).
3. **Normalise** into a provider-neutral `NormalizedMessage`.
4. **Dedupe**: upsert on `(emailAccountId, providerMessageId)`. A repeat is a no-op apart from syncing flags.
5. **Thread**: use the provider thread ID if there is one (Gmail `threadId`, Graph `conversationId`). Otherwise match `In-Reply-To`/`References` to known `internetMessageId`s in the same account. Fall back to the normalised subject plus a participant overlap within 30 days.
6. **Persist** in one transaction: message, folder links, attachment metadata, thread counters, `awaitingReplySince`, and a contact match or create.
7. **Emit domain events** to the in-process bus, then to BullMQ: `message.received`. Assignment rules run first, then the status re-assessment and the SLA scheduler. Then come AI classification (async, optional), automation rules, lead detection and notifications.
8. **Push to clients**: a Redis pub/sub fan-out to WebSocket rooms (`user:{id}`, `thread:{id}`). Before any payload goes out, each recipient's access is filtered again.

## 6. Event flow: outbound reply

1. The employee presses Send. The API checks `conversation.reply` on the thread and `REPLY` access on the mailbox.
2. **Collision check**: the draft carries `baseThreadVersion`. If `thread.version` has moved on because a message arrived or a colleague replied, the API returns `409 THREAD_CHANGED` with the new messages. The UI shows them, and the user confirms or edits.
3. The draft becomes `QUEUED` with an `idempotencyKey`, and `send.message` is enqueued.
4. The worker builds MIME (nodemailer `MailComposer`): `From` = account address, `In-Reply-To` and `References` from the parent message, attachments streamed from storage. **Internal notes are not inputs to this builder at all.**
5. It sends through the adapter: Gmail `messages.send` with `threadId`; Graph `createReply`/`send` on the parent; SMTP and then IMAP `APPEND` to Sent.
6. It records the outbound message, updates the thread (`lastOutboundAt`, `firstResponseAt`, status → `WAITING_FOR_CLIENT` by default), stops the SLA cycle and writes an audit entry.

## 7. Real-time

- socket.io on the API, with a Redis adapter for multi-instance fan-out.
- Connections are authenticated with the session cookie during the WS handshake.
- **Presence and collision hints**: `thread.viewing` / `thread.composing` events are kept in Redis with a TTL. The UI shows "Priya is replying…". The server-side version check in §6 is the authoritative guard.

## 8. Storage

- **PostgreSQL 16**. Message bodies sit in `email_messages` (TOAST handles large bodies). Full-text search uses a generated `tsvector` with a GIN index. If search volume outgrows Postgres, switch to OpenSearch behind the same `SearchService` interface.
- **Object storage** (S3 / Cloudflare R2 / GCS through the S3 API) for attachments. Server-side encryption is on, keys are content-addressed (`sha256`), and the bucket is private. Downloads go through the API (permission check, then a 60-second presigned URL with `Content-Disposition: attachment`).
- **Job queue**: pg-boss tables in the same PostgreSQL (see the Phase 2 decision in §2). **Redis 7** is optional, for the socket.io adapter, presence and short-lived caches if needed later; it would hold nothing that is the only copy of data.

## 9. Deployment target

All services are containerised (Docker): `web`, `api` (≥2 replicas), `worker` (≥2 replicas, one of which runs the IMAP IDLE supervisor with leader election through a Redis lock), managed Postgres with PITR backups, managed Redis, and S3-compatible storage. Any container platform works (Render, AWS ECS, GCP Cloud Run + GCE for IDLE, Kubernetes). The Phase 10 plan in [07-milestones.md](07-milestones.md) picks one with the team.

Observability: structured JSON logs (pino), OpenTelemetry traces, Sentry for errors, and Prometheus-style metrics. Key metrics are sync lag per account, queue depth, send failures and webhook latency.

## 10. Key technology choices

| Concern | Choice | Reason |
|---|---|---|
| IMAP | `imapflow` | Maintained, supports IDLE, CONDSTORE/QRESYNC, async iterators |
| SMTP / MIME | `nodemailer` + `mailparser` | Standard and robust; MailComposer gives full header control |
| Gmail | Gmail REST API v1 via `fetch` (`packages/providers`) | History + watch; explicit error mapping |
| Microsoft | Graph REST v1.0 via `fetch` (`packages/providers`) | Delta queries, immutable ids, subscriptions |
| Queue | pg-boss (PostgreSQL) | Retries with backoff, cron schedules, one queued + one running sync per mailbox |
| Validation | Zod (shared) + Nest pipes | One schema used by both web forms and API |
| HTML safety | `sanitize-html` on the server + sandboxed iframe render | Email HTML is hostile input |
| Editor | TipTap | Rich text, mentions (for notes), extensible |
| AI | OpenAI Chat Completions with JSON-schema structured outputs (OpenAI-compatible base URL), model set in config (`OPENAI_MODEL`, default gpt-4o-mini) | Structured outputs for classification |
