# 03 — API Endpoint Documentation

Base path is `/api/v1`. The API uses JSON and is authenticated by an httpOnly session cookie. Every mutating request must carry an `X-CSRF-Token` header (double-submit). Request bodies are validated with shared Zod schemas from `packages/shared`. An OpenAPI spec generated from those schemas is planned for Phase 10. Until then, this document is the reference.

**Conventions**
- Lists use cursor pagination: `?cursor=<opaque>&limit=50` (max 100). The response is `{ items, nextCursor }`.
- Errors look like `{ error: { code, message, details? } }`. Codes include `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404 (also returned for records the caller is not allowed to see, so existence never leaks), `VALIDATION_FAILED` 422, `THREAD_CHANGED` 409, `RATE_LIMITED` 429 and `PROVIDER_ERROR` 502.
- `Idempotency-Key` header is accepted on send and bulk endpoints.
- 🔒 marks the permission key that is required. Scope (OWN/ASSIGNED/TEAM/DEPARTMENT/ALL) is applied automatically by AccessPolicy.

## Auth & session
| Method | Path | Notes |
|---|---|---|
| GET | `/auth/sso/:provider/start` | `google` or `microsoft`. Starts the OIDC flow (PKCE + state + nonce) |
| GET | `/auth/sso/:provider/callback` | Creates the session. Rejects emails outside the allowed company domains |
| POST | `/auth/login` | Optional email + password (argon2id). Returns `mfaRequired` when TOTP is on |
| POST | `/auth/mfa/verify` | `{mfaToken, code}`. Rejects reuse of an already-used code |
| POST | `/auth/mfa/enroll/start` · `/auth/mfa/enroll/confirm` | Mandatory enrolment during sign-in (`mfaToken` from login) |
| POST | `/auth/mfa/self/start` · `/auth/mfa/self/confirm` · DELETE `/auth/mfa/self` | Self-service from the account page. Disabling is refused when the role requires MFA |
| POST | `/auth/password/set` | `{token, password}` from a one-time admin link |
| GET | `/auth/providers` | Which sign-in methods are configured |
| POST | `/auth/logout` | Revokes the current session |
| GET | `/auth/me` | Current user, role, effective permissions with scopes |
| GET | `/auth/sessions` · DELETE `/auth/sessions/:id` | List and revoke own sessions |

## Users, roles, org — Phase 1
| Method | Path | 🔒 |
|---|---|---|
| GET/POST | `/users` | `user.read` / `user.manage` |
| GET/PATCH | `/users/:id` | `user.read` / `user.manage` |
| POST | `/users/:id/suspend` · `/users/:id/reactivate` | `user.manage` (suspend revokes all sessions) |
| PUT | `/users/:id/absence` | `{isAbsent, absentUntil}`. Self, or `user.manage` |
| POST | `/users/:id/password-link` | `user.manage` — one-time 72h set-password link (only its hash is stored) |
| POST | `/users/:id/mfa/reset` | `user.manage` — clears 2FA and signs the user out everywhere |
| GET | `/users/:id/permission-overrides` · `/users/:id/effective-permissions` | `role.manage` (effective: also self) |
| PATCH | `/me` | Own name and time zone |
| GET | `/health` | Public. Database reachability (Render health check) |
| PUT | `/users/:id/permission-overrides` | `role.manage` |
| GET/POST | `/roles` · PATCH/DELETE `/roles/:id` | `role.manage` (system roles cannot be deleted) |
| PUT | `/roles/:id/permissions` | `role.manage` — `[{permissionKey, scope}]` |
| GET | `/permissions` | `role.manage` — catalogue |
| CRUD | `/departments`, `/teams`, `/teams/:id/members` | `org.manage` |
| GET | `/audit-logs?entityType&entityId&actorId&action&from&to` | `audit.read` |

## Email accounts — Phases 2 and 4
| Method | Path | 🔒 / Notes |
|---|---|---|
| GET | `/accounts` | Accounts the caller can see, with health: status, lastSyncedAt, lastError, queue lag |
| POST | `/accounts/oauth/:provider/start` | `account.connect`. Requests the mailbox scopes from 06 |
| GET | `/accounts/oauth/:provider/callback` | Stores encrypted tokens, discovers folders, enqueues initial sync |
| POST | `/accounts/imap/test` | `account.connect`. `{email, username, password, imap{host,port,security}, smtp{...}}` → per-step result (DNS, TLS, auth, list folders, SMTP auth) without saving |
| POST | `/accounts/imap` | Same body. Saves after a successful test |
| GET | `/accounts/:id` | Detail, folders, subscriptions, last 20 sync logs |
| PATCH | `/accounts/:id` | `account.manage` — displayName, department, syncFromDate |
| PUT | `/accounts/:id/folders` | `account.manage` — `[{folderId, syncEnabled}]` |
| POST | `/accounts/:id/sync` | `account.manage` — manual incremental sync. `?full=true` triggers a resync |
| POST | `/accounts/:id/reconnect` | Re-runs OAuth, or accepts a new password. Resumes from the existing cursors |
| POST | `/accounts/:id/pause` · `/resume` | `account.manage` |
| DELETE | `/accounts/:id` | `account.manage` — disconnect: revoke token, delete credential, schedule purge |
| GET/PUT | `/accounts/:id/access` | `account.manage` — grants to users, teams or departments |
| GET | `/accounts/:id/sync-logs` | `account.manage` |

## Webhooks (no session; each verified per provider)
| Method | Path | Verification |
|---|---|---|
| POST | `/webhooks/gmail` | Pub/Sub push with an OIDC JWT. Checks signature, `aud`, and the service-account email |
| POST | `/webhooks/graph` | Echoes `validationToken` on creation. Afterwards checks `clientState` against the stored hash (constant-time) |
| POST | `/webhooks/graph/lifecycle` | Handles `reauthorizationRequired`, `subscriptionRemoved` and `missed` → renew or resync |

Webhook handlers only dedupe the event and enqueue a sync. They return 202 within milliseconds.

## Conversations — Phase 3
| Method | Path | Notes |
|---|---|---|
| GET | `/threads` | `view=all\|mine\|assigned\|unassigned\|unread\|pending\|waiting\|followup\|closed\|sent\|drafts\|archive\|spam\|overdue` plus filters `accountId[] departmentId[] assigneeId[] from to dateFrom dateTo subject status[] priority[] tagId[] q` |
| GET | `/threads/counts` | Badge counts per view for the sidebar |
| GET | `/threads/:id` | Thread + messages + attachments metadata + notes + assignment and status history |
| PATCH | `/threads/:id` | `{priority?, followUpAt?}` |
| POST | `/threads/:id/read` · `/unread` · `/star` · `/unstar` · `/archive` · `/unarchive` · `/spam` · `/not-spam` | Pushed back to the provider by the `flag.push` job |
| POST | `/threads/:id/snooze` | `{until}` |
| POST | `/threads/:id/status` | 🔒 `conversation.status` — `{status, reason?}` |
| POST | `/threads/bulk` | `{threadIds[], action, params}`, max 500 per call, async job with progress over WS |
| GET | `/search?q=` | Full-text over authorised threads (subject, participants, body) |
| GET | `/messages/:id/raw` | 🔒 `conversation.raw` — original headers for debugging |

## Compose & send — Phase 3
| Method | Path | Notes |
|---|---|---|
| POST | `/drafts` | `{emailAccountId, mode, threadId?, inReplyToMessageId?, to, cc, bcc, subject, bodyHtml}`. Server pre-fills recipients and subject for reply, reply-all and forward |
| PATCH | `/drafts/:id` | Autosave (debounced client side) |
| DELETE | `/drafts/:id` | |
| POST | `/drafts/:id/attachments` | Multipart upload. Size and type limits, virus scan |
| POST | `/drafts/:id/send` | 🔒 `conversation.reply` + mailbox `REPLY`. Body `{baseThreadVersion, scheduledFor?}`. Returns 409 `THREAD_CHANGED` with `newMessages[]` on collision. Returns 202 `{status:"QUEUED"}`, and the result arrives over WS |
| GET | `/attachments/:id/download` | Permission check → 302 to a 60-second presigned URL |
| CRUD | `/signatures`, `/templates` | Templates support `{{contact.name}}`-style variables |

## Assignment & collaboration — Phase 5
| Method | Path | Notes |
|---|---|---|
| POST | `/threads/:id/assign` | 🔒 `conversation.assign` — `{assigneeId? teamId? departmentId? reason?}` |
| POST | `/threads/:id/unassign` | |
| GET | `/threads/:id/assignments` | History |
| CRUD | `/assignment-rules` · PUT `/assignment-rules/order` | 🔒 `rules.manage` |
| POST | `/assignment-rules/test` | Dry-runs a sample message or an existing thread against the rules |
| CRUD | `/threads/:id/notes` | Body supports `@[userId]` mentions. Edit and delete only by the author |
| PUT/DELETE | `/threads/:id/shares/:userId` | 🔒 `conversation.share` |
| PUT/DELETE | `/threads/:id/tags/:tagId` · CRUD `/tags` | |

## SLA & notifications — Phase 6
| Method | Path | Notes |
|---|---|---|
| CRUD | `/sla-policies`, `/sla-policies/:id/steps`, `/calendars`, `/calendars/:id/holidays` | 🔒 `sla.manage` |
| GET | `/notifications?unread=true` · POST `/notifications/:id/read` · POST `/notifications/read-all` | |
| GET/PUT | `/notification-preferences` | |
| POST/DELETE | `/push-subscriptions` | Web Push subscribe and unsubscribe |

## CRM & leads — Phase 7
| Method | Path | Notes |
|---|---|---|
| CRUD | `/contacts`, `/contacts/:id/emails`, `/companies` | Scoped by owner or department |
| GET | `/contacts/:id/timeline` | Every authorised thread, lead and task for the contact |
| GET | `/contacts/duplicates` | Candidate pairs with scores (same email domain + name similarity, same phone) |
| POST | `/contacts/:id/merge` | `{sourceContactIds[]}` → preview with `?dryRun=true`, then commit |
| CRUD | `/leads` · POST `/leads/:id/status` | 🔒 `lead.*` |
| CRUD | `/tasks` · POST `/tasks/:id/complete` | |

## AI & automation — Phase 8
| Method | Path | Notes |
|---|---|---|
| GET | `/threads/:id/insights` | Cached summary, category, sentiment, urgency, lead score, follow-up |
| POST | `/threads/:id/insights/refresh` | Rate-limited per user |
| POST | `/ai/suggest-reply` | `{threadId, tone?, instructions?}` → `AiSuggestion` (PROPOSED) |
| POST | `/ai/rewrite` | `{text, kind: grammar\|tone, tone?}` → text |
| POST | `/ai/suggestions/:id/use` | Creates a **Draft** (`source=AI`). There is no endpoint that sends an AI suggestion directly |
| CRUD | `/automation-rules` · POST `/automation-rules/:id/enable` · `/disable` · `/test` | 🔒 `automation.manage` |
| GET | `/automation-rules/:id/runs` | |

## Analytics — Phase 9
| Method | Path | Notes |
|---|---|---|
| GET | `/analytics/overview?range=today\|yesterday\|week\|month\|custom&from&to` | Admin/CMO tiles |
| GET | `/analytics/md` | MD dashboard |
| GET | `/analytics/me` | Employee dashboard |
| GET | `/analytics/response-times?groupBy=user\|department\|account` | |
| GET | `/analytics/workload` · `/analytics/leads/funnel` · `/analytics/trends?metric=&interval=day\|week\|month` | |
| GET | `/analytics/export.csv?report=` | 🔒 `report.export` |

All analytics are scoped by AccessPolicy. A department manager calling `/analytics/overview` only gets their own department's figures.

## WebSocket events (socket.io namespace `/rt`)
Server → client: `thread.updated`, `thread.new`, `message.new`, `message.sent`, `message.send_failed`, `notification.new`, `presence.thread` (`{threadId, viewers[], composers[]}`), `account.health`, `bulk.progress`.
Client → server: `thread.join` (authorised server-side), `thread.leave`, `thread.composing` (`{threadId, active}`).
