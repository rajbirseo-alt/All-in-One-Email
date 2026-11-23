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

## Email accounts — Phase 2 (built) and Phase 4 (IMAP)
| Method | Path | 🔒 / Notes |
|---|---|---|
| GET | `/accounts` | Signed in. Mailbox managers see all; others see mailboxes granted to them, their team or their department. Includes health: status, last success, last error, message/thread counts, newest message, push on/off |
| GET | `/accounts/providers` | `account.connect` or `account.manage`. Which providers are configured, push availability, import window, retention days |
| POST | `/accounts/oauth/:provider/start` | `account.connect`. `google` or `microsoft`. Body `{departmentId?, syncDays?}`. Returns `{url}` and sets a signed state cookie (PKCE verifier, state, starting user) |
| POST | `/accounts/imap/test` | `account.connect`. `{email, username, password, imap{host,port,security}, smtp{…}}` → `{ok, steps[dns,imap,folders,smtp], folders}`. Saves nothing. Private/loopback hosts and non-TLS connections are refused |
| POST | `/accounts/imap` | `account.connect`. Same body plus `departmentId?, syncDays?`. Runs the test first (422 with the failed steps); creates the mailbox, or reconnects an existing IMAP one with new settings. 409 if the address is connected through Google/Microsoft. The password is stored envelope-encrypted |
| GET | `/accounts/:id/imap` | `account.manage`. Saved server settings (never the password), for the reconnect form |
| GET | `/accounts/oauth/:provider/callback` | `account.connect`, same user who started. Stores the encrypted tokens, creates or reconnects the mailbox, queues the first sync. Redirects to `/admin/mailboxes?connected=<id>` or `?error=<code>` |
| GET | `/accounts/:id` | `account.manage`. Detail: folders with counts, push subscriptions, access grants, last 20 sync runs |
| PATCH | `/accounts/:id` | `account.manage`. `{displayName?, departmentId?}` |
| PUT | `/accounts/:id/folders` | `account.manage`. `{folders:[{folderId, syncEnabled}]}` |
| POST | `/accounts/:id/sync` | `account.manage`. Queues an incremental sync. `?full=true` re-reads the import window (deduplicated). 202 |
| POST | `/accounts/:id/pause` · `/resume` | `account.manage` |
| DELETE | `/accounts/:id` | `account.manage`. Disconnect: stop push, revoke the token (Google), delete the credential, schedule the purge (120 days) |
| PUT | `/accounts/:id/access` | `account.manage`. `{grants:[{userId | teamId | departmentId, level: READ|REPLY|MANAGE}]}`. Replaces all grants |
| POST | `/accounts/imap/test` · `/accounts/imap` | Phase 4 |

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
| GET | `/threads/counts` | Badge counts: unread for inbox/mine/unassigned, totals for the other views |
| GET | `/threads/:id` | Thread + messages + attachments metadata + notes + assignment and status history |
| POST | `/threads/:id/read` · `/unread` · `/star` · `/unstar` · `/archive` · `/unarchive` · `/spam` · `/not-spam` | Pushed back to the provider by the `flag.push` job |
| POST | `/threads/:id/snooze` | `{until}` |
| POST | `/threads/:id/status` | 🔒 `conversation.status` — `{status, reason?, followUpAt?}`. Status is one of IN_PROGRESS, WAITING_FOR_CLIENT, PENDING_REPLY, FOLLOW_UP_REQUIRED, REPLY_NOT_NEEDED, CLOSED or OPEN (reopens to NEW/ASSIGNED; NEW and ASSIGNED otherwise follow the assignment). `followUpAt` turns the conversation into FOLLOW_UP_REQUIRED at that time. *(Phase 6)* |
| POST | `/threads/:id/priority` | 🔒 `conversation.status` — `{priority}`; re-picks the SLA policy *(Phase 6)* |
| GET | `/threads/:id/status-history` | Status changes with source (user, client message, our reply, system) *(Phase 6)* |
| GET | `/events` | Server-Sent Events: `thread.updated {threadIds}` (filtered per user), `presence`, `notification` (only on the owner's streams; the client refetches its bell), `session.ended`. Replaces the WebSocket plan below |
| POST | `/threads/bulk` | `{threadIds[], action, assigneeId?/teamId?/departmentId?, tagId?}`, max 500, synchronous; returns `{done, failed[]}` |
| GET | `/search?q=` | Full-text over authorised threads (subject, participants, body) |
| GET | `/messages/:id/raw` | *(later)* 🔒 `conversation.raw` — original headers for debugging |

## Compose & send — Phase 3
| Method | Path | Notes |
|---|---|---|
| POST | `/drafts` | `{emailAccountId, mode, threadId?, inReplyToMessageId?, to, cc, bcc, subject, bodyHtml}`. Server pre-fills recipients and subject for reply, reply-all and forward |
| PATCH | `/drafts/:id` | Autosave (debounced client side) |
| DELETE | `/drafts/:id` | |
| POST | `/drafts/:id/attachments` | Multipart upload. Size and type limits, virus scan |
| POST | `/drafts/:id/cancel-send` | Cancels a scheduled send that has not started |
| POST | `/drafts/:id/send` | 🔒 `conversation.reply` + mailbox `REPLY`. Body `{baseThreadVersion, scheduledFor?}`. Returns 409 `THREAD_CHANGED` with `newMessages[]` on collision. Returns 202 `{status:"QUEUED"}`, and the result arrives over WS |
| GET | `/attachments/:id/download` | Permission check → 302 to a 60-second presigned URL |
| CRUD | `/signatures`, `/templates` | Templates support `{{contact.name}}`-style variables |

## Assignment & collaboration — Phase 5
| Method | Path | Notes |
|---|---|---|
| POST | `/threads/:id/assign` | 🔒 `conversation.assign` — `{assigneeId? teamId? departmentId? reason?}` |
| POST | `/threads/:id/unassign` | |
| GET | `/threads/:id/assignments` | History |
| GET | `/threads/:id/assignees` | 🔒 `conversation.assign` — people, teams and departments the caller may assign to |
| POST | `/threads/:id/presence` | `{state: viewing|composing|left}`; delivered as `presence` events on `/events` |
| CRUD | `/assignment-rules` · PUT `/assignment-rules/order` | 🔒 `rules.manage` |
| POST | `/assignment-rules/test` | Dry-runs a sample message or an existing thread against the rules |
| CRUD | `/threads/:id/notes` | Body supports `@[userId]` mentions. Edit and delete only by the author |
| PUT/DELETE | `/threads/:id/shares/:userId` | 🔒 `conversation.share` |
| PUT/DELETE | `/threads/:id/tags/:tagId` · CRUD `/tags` | |

## SLA & notifications — Phase 6
| Method | Path | Notes |
|---|---|---|
| GET/POST · PUT/DELETE `:id` | `/sla-policies` | 🔒 `sla.manage`. A policy is saved with its steps (`{name, departmentId, priority, calendarId, isEnabled, isDefault, steps[{afterBusinessMinutes, action, marksOverdue}]}`), replacing the planned `/steps` sub-resource. Exactly one step marks overdue; one enabled policy per department + priority. Department managers manage only their own departments' policies |
| GET/POST · PUT/DELETE `:id` | `/calendars` | 🔒 `sla.manage`; writes need company-wide scope. `{name, timezone, weeklyHours{mon..sun: [["09:30","18:30"]]}}` |
| POST · DELETE `:holidayId` | `/calendars/:id/holidays` | `{date: YYYY-MM-DD, name}` |
| GET | `/notifications?unread=&cursor=&limit=` · `/notifications/unread-count` · POST `/notifications/:id/read` · POST `/notifications/read-all` | Signed in; always the caller's own |
| GET/PUT | `/notification-preferences` | Per kind: `inApp` (bell) and `push` (devices) |
| GET | `/push-subscriptions/config` | `{enabled, publicKey}` (VAPID) |
| GET · POST · DELETE | `/push-subscriptions` | This browser's Web Push subscription. Endpoints must belong to a browser push service (FCM, Mozilla, Windows, Apple) |

## CRM & leads — Phase 7 (as built)

**Scopes.** Records outside the caller's scope return 404.
- **Contacts.** OWN means contacts the caller owns. TEAM and DEPARTMENT add contacts owned by those people; DEPARTMENT also adds contacts filed under the department. At every scope, the contact of a conversation or lead the caller can read is also visible.
- **Leads.** OWN means the caller is the owner. TEAM adds leads owned by team members and leads from the team's queue. DEPARTMENT adds the department's leads.
- **Tasks.** OWN means tasks assigned to or created by the caller. TEAM and DEPARTMENT add those people's tasks.

| Method | Path | Notes |
|---|---|---|
| GET · POST | `/contacts` | 🔒 `contact.read` / `contact.write`. List: `?q&type&ownerId&companyId&page&limit` → `{items,total}`. Create: `{emails[], name, phone, companyId, website, country, type, ownerId?, departmentId?, notes}`. An address another contact already has → 409 `EMAIL_IN_USE`. Owner and department must stay within the caller's scope (422) |
| GET · PUT | `/contacts/:id` | A merged contact's id returns the contact it was merged into. Includes `canEdit`, `canMerge`, `merges[]` |
| POST · DELETE | `/contacts/:id/emails`, `/contacts/:id/emails/:emailId` · POST `…/:emailId/primary` | The last address cannot be removed (409 `LAST_EMAIL`) |
| PUT | `/contacts/:id/tags` | `{tagIds[]}` (the same tags as conversations) |
| GET | `/contacts/:id/timeline` | `{threads, leads, tasks}`, each filtered by its own scope |
| GET | `/contacts/owner-options` | People the caller may give contacts to |
| GET · POST `dismiss` | `/contacts/duplicates` | 🔒 `contact.merge`. Returns pairs `{a, b, score, reasons[]}`. Matches on: the same phone (last 10 digits); a similar name at the same company (trigram ≥ 0.5); the same full name (≥ 0.8); the same mailbox name at another domain. `{aId,bId}` dismisses a pair |
| POST | `/contacts/:id/merge` | 🔒 `contact.merge`. `{sourceContactIds[], dryRun}` (or `?dryRun=true`) → `{moves, fills, conflicts}`; a commit also returns `mergeIds`. Empty target fields are filled from the source and notes are appended; for other differences the target's value is kept |
| POST | `/contact-merges/:id/undo` | 🔒 `contact.merge`. 409 `ALREADY_UNDONE` / `TARGET_MERGED` |
| GET · POST · GET/PUT `:id` | `/companies` | The domain is normalised (`https://www.x.com/a` → `x.com`). A free-mail domain → 422; a taken one → 409 `DOMAIN_IN_USE` |
| GET · POST | `/leads` | 🔒 `lead.read` / `lead.write`. List: `?status&ownerId&q`. Create from `{threadId}` (the contact comes from the conversation; 409 `LEAD_EXISTS` if it already has an open lead) or from `{contactId}`, plus `title, ownerId, estimatedValue, currency, serviceInterest`. The owner defaults to the caller |
| GET · PUT | `/leads/:id` | Detail with `history`, `tasks` and `sourceThread` (only if the caller can read it). A new owner is notified (`LEAD_ASSIGNED`) |
| POST | `/leads/:id/status` | `{status, note?, lostReason?}`. LOST needs a reason. WON makes the contact a client |
| GET | `/leads/summary` · `/leads/owner-options` | Summary: `?from&to` → counts per stage, open/won/lost, conversion, won value per currency, figures per owner |
| GET · POST · GET/PUT `:id` | `/tasks` | 🔒 `task.*`. `?view=mine\|created\|all&status&threadId&leadId&contactId`. The assignee must be within the caller's `task.write` scope, and linked records must be readable |
| POST | `/tasks/:id/complete` · `/reopen` · `/cancel` | |
| GET | `/tasks/assignee-options` | |
| GET | `/threads/:id/crm` | 🔒 `conversation.read`. `{contact, leads, tasks, canCreateLead, canCreateTask}` for the panel next to a conversation |

**Automatic behaviour**
- **Contact matching.** Every synced or sent conversation is matched to the person outside the company. When the sender is our own domain or a robot (for example a website form), the Reply-To address is used. The contact, and the company for its domain, are created the first time they are seen.
- **Lead routing.** An assignment rule with `createLead` opens a lead for the person it assigned. That person gets a `LEAD_ASSIGNED` notification and a follow-up task due in 24 hours. No lead is opened if the sender already has an open one.
- **Lead stage.** Our first reply on the lead's conversation moves it from New to Contacted.
- **Task reminders.** The worker's minute sweep sends one `TASK_DUE` notification per due time.

## AI & automation — Phase 8 (as built)
AI calls need `ai.use` covering the conversation (the same scopes as conversations; 404 outside it). They return 503 `AI_DISABLED` / `AI_UNAVAILABLE` when the server has no key or the provider fails, 403 `AI_NOT_ALLOWED` when the mailbox has AI switched off, and 429 when the provider is busy. AI endpoints are limited to 20 calls per user per minute.

| Method | Path | Notes |
|---|---|---|
| GET | `/ai/status` | `{enabled, model, autoAnalyze}` |
| GET | `/threads/:id/insights` | Cached `{available, reason, stale, summary, category, sentiment, urgency{level,reason}, lead{isLead,confidence,serviceInterest,companyName,reason}, followUp{needed,inDays,action}}`. Reading never calls the AI |
| POST | `/threads/:id/insights/refresh` | Analyses now (up to the latest message) |
| POST | `/ai/suggest-reply` | `{threadId, tone: professional\|friendly\|concise\|formal\|apologetic, instructions?}` → `AiSuggestion` (PROPOSED) |
| GET | `/threads/:id/ai-suggestions` | The caller's open suggestions |
| POST | `/ai/suggestions/:id/use` · `/discard` | `use` creates a reply **Draft** owned by the caller (`source=AI`, status EDITING), with normal draft permissions. 409 if already used. There is no endpoint that sends an AI suggestion |
| POST | `/ai/rewrite` | `{draftId, text, kind: grammar\|tone, tone?}` → `{text}`. Only the caller's own draft; the draft is not changed |
| GET · POST · PUT/DELETE `:id` | `/automation-rules` | 🔒 `automation.manage`. `{name, description?, trigger: MESSAGE_RECEIVED\|LEAD_DETECTED\|USER_ABSENT, departmentId?, isEnabled, conditions{match, conditions[{field, op, value}]}, actions[]}`. Actions: `assign`, `set_priority`, `set_status`, `add_tag`, `notify`, `create_task`, `create_lead`, `request_ai_draft`, `reassign_absent`. **No action sends email**; unknown types → 422. Department scope: only rules with their own `departmentId`, acting within it |
| POST | `/automation-rules/:id/enable` · `/disable` | |
| POST | `/automation-rules/:id/test` | `{threadId}` → `{matched, reason, facts, actions[{type, detail}]}`. Dry run: writes nothing |
| GET | `/automation-rules/:id/runs` | Last 100 runs with each action's result |
| PATCH | `/accounts/:id` | Now also `{aiEnabled}`: false = no content of this mailbox is sent to the AI provider |

**Automatic behaviour**
- New live inbound mail (not history, spam or trash), when AI is on for the mailbox: the worker analyses it, fires `LEAD_DETECTED` (confidence ≥ 0.7, once per conversation), then runs `MESSAGE_RECEIVED` rules. Without AI, the `MESSAGE_RECEIVED` rules run directly.
- Marking someone absent fires `USER_ABSENT`.
- Each rule runs at most once per event (`AutomationRun.idempotencyKey`).

## Analytics — Phase 9 (as built)
Range parameters (all range endpoints): `range=today|yesterday|week|month|custom` (week = last 7 days, month = last 30 days, both including today), `from`/`to` (YYYY-MM-DD, inclusive, custom only, at most a year), `departmentId` (narrows; never widens). Days follow `REPORT_TIMEZONE` (default Asia/Kolkata). Every response states `asOf`, the last finished rollup.

| Method | Path | Notes |
|---|---|---|
| GET | `/analytics/overview` | Range: incoming, outgoing, new conversations, closed, SLA breaches, reply averages (clock and working-hours minutes; first reply and all replies). Now: mailboxes, unread, unassigned, pending, overdue (the inbox view conditions). `ai` token usage for company-wide scope |
| GET | `/analytics/md` | Management summary: tiles, department table (range + live workload), 12-month trend |
| GET | `/analytics/me` | The caller's own work: assigned, newly assigned, pending, overdue, follow-ups and tasks due, closed, own average vs team median, next 10 conversations by SLA due |
| GET | `/analytics/response-times?groupBy=user|department|account` | Per group: incoming, outgoing, replies, averages, closed, SLA breaches |
| GET | `/analytics/workload?groupBy=user|department` | Now: open, pending, overdue |
| GET | `/analytics/trends?metric=incoming,replies&interval=day|week|month&periods=` | Up to 4 metrics (`incoming, outgoing, newThreads, replies, avgResponse, avgBusinessResponse, closed, slaBreaches`); empty buckets included |
| GET | `/analytics/leads/funnel` | Leads created in the range: current status, stages reached, won/lost, won value, conversion |
| GET | `/analytics/accounts` | Mailbox health (company-wide and department scope only) |
| GET | `/analytics/export.csv?report=productivity|departments|accounts|daily|leads|workload` | 🔒 `report.export` (plus `report.read` for the scope). UTF-8 CSV with formula cells neutralised; audited as `report.export` |

**Scope** (`report.read`): ALL = everything; DEPARTMENT = the departments the caller belongs to or manages (conversation department, else the mailbox's); TEAM = the caller's teams plus the people in teams they lead; OWN = their own figures. `/analytics/me` always shows the caller's own work.

**Definitions** (to be signed off):
- *Reply time*: from the first unanswered client message in a conversation to the next outgoing message. Shown in working hours (the department's SLA calendar, else the default policy's) and in clock hours.
- *Incoming / new conversations / SLA breaches* count for the conversation's assignee; *outgoing / replies* for the sender in the CRM (else the assignee); *closed* for whoever closed it.
- Spam and trash are never counted. Figures of purged mailboxes are kept.

## WebSocket events (socket.io namespace `/rt`)
Server → client: `thread.updated`, `thread.new`, `message.new`, `message.sent`, `message.send_failed`, `notification.new`, `presence.thread` (`{threadId, viewers[], composers[]}`), `account.health`, `bulk.progress`.
Client → server: `thread.join` (authorised server-side), `thread.leave`, `thread.composing` (`{threadId, active}`).
