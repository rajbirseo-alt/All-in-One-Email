# 05 — Authentication & Permissions Design

## 1. Two separate OAuth concerns

| | Employee login | Mailbox connection |
|---|---|---|
| Purpose | Prove who the employee is | Let the CRM read and send mail for a mailbox |
| Scopes | `openid email profile` only | Gmail / Graph mail scopes (see 06) |
| Stored | `UserIdentity` (provider + subject) | `EmailCredential` (encrypted tokens) |
| Effect | Creates a session | Creates an `EmailAccount`. Does **not** give the connector automatic visibility; Super Admin assigns access |

Logging in with Google never pulls in that person's personal mailbox. Mailboxes are only added through the Accounts screen by users holding `account.connect`.

## 2. Employee authentication

- **Primary: SSO** through Google and/or Microsoft, using OIDC Authorization Code + PKCE, `state` and `nonce`. The user must already exist (invited, matched on the exact address) and must not be suspended. Accepted accounts (rules in `apps/api/src/auth/login-policy.ts`):
  | Account | Accepted when |
  |---|---|
  | Google Workspace | `hd` claim and email both on `ALLOWED_LOGIN_DOMAINS`, `email_verified` |
  | Personal Google | No `hd`, address is `@gmail.com` / `@googlemail.com`, `email_verified` |
  | Microsoft work/school | `tid` = `MICROSOFT_TENANT_ID`, email on `ALLOWED_LOGIN_DOMAINS` |
  | Personal Microsoft | `tid` = the consumer tenant `9188040d-…`, address on an Outlook.com/Hotmail/Live/MSN domain |

  The personal rows are switched on by `PERSONAL_ACCOUNT_LOGIN` (decided 2026-11-17: on). These are the only consumer accounts whose address the provider itself owns. Rejected:
  - consumer Google accounts registered under any other address, including the company's;
  - personal Microsoft accounts on non-Microsoft addresses;
  - every other Entra tenant, because its admins can set any email claim.

  Microsoft uses the `common` authority when personal accounts are on, and the issuer is checked against the token's `tid`. Invites accept the same address types.
- **Fallback: email + password**, which can be turned off per deployment. Passwords are hashed with argon2id (m=64MB, t=3). Logins are rate-limited per IP and per account, with a lockout after 10 failures in 15 minutes. **TOTP MFA is mandatory for Super Admin, MD and anyone with `account.manage`.**
- **Bootstrap**: `npm run seed -w @crm/db` creates the system roles and permission catalogue. A one-time CLI command `create-super-admin --email` creates the first Super Admin. There are no default passwords.

## 3. Sessions

- An opaque random 256-bit token goes in cookie `__Host-crm_session` (`Secure; HttpOnly; SameSite=Lax; Path=/`). The DB stores `sha256(token)` only.
- The session expires after 12h of inactivity and 7 days at most. Every session is listed in "Active sessions" and can be revoked.
- Suspending a user or changing their role revokes all of their sessions immediately. The permission cache key includes `role.updatedAt`.
- CSRF uses a double-submit token (`crm_csrf` cookie + `X-CSRF-Token` header) on every non-GET request. The WebSocket handshake checks the Origin header.
- Security headers: strict CSP (no inline scripts), HSTS, `frame-ancestors 'none'`. Email HTML renders in a sandboxed iframe (`sandbox` without `allow-scripts`, remote images proxied and blocked until the user clicks).

## 4. RBAC model

```
effective(user, permission) = override DENY            → none
                            | override GRANT(scope)    → scope
                            | role permission (scope)  → scope
                            | none
```

### Permission catalogue (initial)

| Key | Meaning |
|---|---|
| `conversation.read` | View threads/messages/attachments |
| `conversation.reply` | Send from a mailbox (also needs mailbox `REPLY` access) |
| `conversation.assign` | Assign / reassign / bulk assign |
| `conversation.status` | Change status |
| `conversation.share` | Share a thread with a colleague |
| `conversation.raw` | View raw headers |
| `note.write` | Internal notes |
| `account.connect` / `account.manage` | Add mailboxes / manage settings, access, disconnect |
| `user.read` / `user.manage` | Directory / invite, edit, suspend |
| `role.manage` | Roles, permissions, overrides |
| `org.manage` | Departments, teams |
| `rules.manage` | Assignment rules |
| `sla.manage` | SLA policies and calendars |
| `automation.manage` | Automation rules |
| `contact.read` / `contact.write` / `contact.merge` | CRM |
| `lead.read` / `lead.write` | Leads |
| `task.read` / `task.write` | Tasks |
| `report.read` / `report.export` | Dashboards / CSV export |
| `audit.read` | Audit log |
| `ai.use` | AI assistant features |

### Default role matrix (scope per permission; "—" = none)

| Permission | Super Admin/CMO | MD | Dept Manager | Team Leader | Employee | Sales | HR | Finance |
|---|---|---|---|---|---|---|---|---|
| conversation.read | ALL | ALL | DEPARTMENT | TEAM | ASSIGNED | ASSIGNED | ASSIGNED | ASSIGNED |
| conversation.reply | ALL | ALL | DEPARTMENT | TEAM | ASSIGNED | ASSIGNED | ASSIGNED | ASSIGNED |
| conversation.assign | ALL | ALL | DEPARTMENT | TEAM | — | — | — | — |
| conversation.status | ALL | ALL | DEPARTMENT | TEAM | ASSIGNED | ASSIGNED | ASSIGNED | ASSIGNED |
| account.connect/manage | ALL | — | — | — | — | — | — | — |
| user.manage / role.manage | ALL | — | — | — | — | — | — | — |
| user.read | ALL | ALL | DEPARTMENT | TEAM | TEAM | TEAM | ALL | TEAM |
| rules / sla / automation.manage | ALL | — | DEPARTMENT | — | — | — | — | — |
| contact.read / write | ALL | ALL | DEPARTMENT | TEAM | OWN | DEPARTMENT | OWN | DEPARTMENT |
| lead.read / write | ALL | ALL | DEPARTMENT | TEAM | — | OWN | — | — |
| report.read | ALL | ALL | DEPARTMENT | TEAM | OWN | OWN | OWN | OWN |
| audit.read | ALL | ALL | — | — | — | — | — | — |
| ai.use | ALL | ALL | DEPARTMENT | TEAM | ASSIGNED | ASSIGNED | ASSIGNED | ASSIGNED |

The Sales, HR and Finance roles differ from Employee mostly in which **mailboxes** they receive through `EmailAccountAccess`, for example the HR department being granted `hr@`. Every cell can be edited in the admin UI. The table above is just the seed data.

### What a scope means for conversations

A user may read thread *T* if they hold `conversation.read` and one of these is true:

- **ALL**: any thread.
- **DEPARTMENT**: `T.departmentId ∈ user.departments`, **or** `T.emailAccountId` is granted to their department, **or** any narrower rule below matches.
- **TEAM**: `T.teamId ∈ user.teams`, **or** `T.assigneeId` is a member of a team they lead, **or** `T.emailAccountId` is granted to their team, **or** an ASSIGNED rule matches.
- **ASSIGNED**: `T.assigneeId = user`, **or** `ThreadShare(T, user)` exists, **or** the user was @-mentioned in a note on T, **or** `T.emailAccountId` is granted **directly** to the user (their personal mailbox).
- **OWN** (contacts and leads): `ownerId = user`.

An explicit mailbox grant (`EmailAccountAccess`) widens access to that mailbox only. It never widens access to other mailboxes. Unassigned threads in a team mailbox are visible to the team that holds a grant on that mailbox, which is how a team inbox works.

## 5. Enforcement layers

1. **Guard**: `@RequirePermission('conversation.reply')` on every controller method. A route without a decorator fails a CI lint rule, so it can't be forgotten.
2. **AccessPolicy (query layer)**: services never call `prisma.emailThread.findMany` directly. They call `threadRepo.findMany(ctx, args)`, which merges `accessPolicy.threadWhere(ctx, 'conversation.read')` into `where`. Single-record fetches use the same filter, so an ID the user cannot see returns 404 rather than 403. The same pattern covers messages, attachments, notes, contacts, leads, tasks, notifications, search and analytics.
3. **Postgres RLS (defense in depth; built in Phase 10)**: the API states the caller at the start of every transaction (`set_config('app.user_id' / 'app.thread_scope' / 'app.system', …, true)`, through a Prisma extension and AsyncLocalStorage set per request). Policies on `email_threads`, `email_messages`, `attachments`, `internal_notes` and `ai_summaries` mirror rule 4 (§4): assigned, mailbox grants, team and led members, department, shares and @-mentions, each computed once per statement. The tables use FORCE ROW LEVEL SECURITY because the app's database user owns them. A request without a signed-in user sees no rows (fail closed). The worker never sets a caller and is trusted. Documented system steps: the worker, search candidate lookups, the hand-over write and the live-update listener. Tested in `rls.e2e` (the app filter removed on purpose) and after every restore drill.
4. **Real-time**: WS rooms are joined only after the same check, and every broadcast is filtered per recipient.
5. **Tests**: an authorisation test matrix (see 08) seeds each role and asserts allow/deny on every endpoint.

## 6. Audit

Every mutating service call writes an `AuditLog` row in the same transaction: actor, action, entity, before/after for changed fields, IP and user agent. Logins, failed logins, session revocations, permission changes, mailbox connect and disconnect, sends, assignments, status changes, merges, exports and AI suggestion usage are all logged. Message bodies are never written to the audit log; it records IDs only.
