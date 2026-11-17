# Phase 1 — Authentication, employees, permissions, database

**Status:** complete locally, verified 2026-11-16. Not yet deployed to Render.

## What works

| Area | Delivered |
|---|---|
| Database | 53-table schema plus 4 migrations: init, full-text search / trigram indexes / mailbox-grant check / **append-only audit trigger**, TOTP replay column, UTC clock. Zero drift between schema and migrations |
| Seed | 27 permissions and 8 system roles with the default matrix from [05](../05-auth-permissions.md). Idempotent and never overwrites an admin's role edits |
| Sign-in | Google and Microsoft SSO using OIDC with PKCE, state and nonce, and JWKS-verified ID tokens. Accepts the company Workspace (`hd` claim) and company Entra tenant, plus personal Gmail and personal Microsoft accounts (`PERSONAL_ACCOUNT_LOGIN`). Other tenants and consumer accounts on other addresses are rejected. Only pre-invited employees can sign in; their identity is linked on first sign-in |
| Password sign-in | argon2id hashing; uniform errors and timing; lockout after 10 failures; 10 attempts/min per IP; one-time 72h set-password links (only hashes stored) |
| 2FA | TOTP, mandatory for Super Admin, MD and holders of `user/role/account.manage`. Secrets are envelope-encrypted (AES-256-GCM). A used code is never accepted twice |
| Sessions | Opaque token, only its hash stored. httpOnly `__Host-` cookies in production. 12h idle timeout, 7-day maximum. Users can list and revoke their sessions. Role change and suspension revoke all sessions |
| Request security | Global guard fails closed (a route without an access rule is denied). Origin check plus double-submit CSRF on every mutation. Helmet headers. Rate limiting |
| RBAC | Role matrix × scope (OWN/ASSIGNED/TEAM/DEPARTMENT/ALL), per-user GRANT/DENY overrides with expiry. Scopes are applied in queries, and out-of-scope records return 404 |
| Anti-lockout / anti-escalation | Nobody can grant access wider than their own. Nobody can grant themselves overrides or edit their own role. The Super Admin role is immutable. The last active Super Admin cannot be demoted or suspended |
| Admin UI | Employees (invite, edit, suspend/reactivate, password link, 2FA reset, overrides), Roles & permissions matrix, Departments & teams (members, rotation flag), Audit log (filters + before/after), My account (profile, away status, 2FA, sessions) |
| Audit | Every sign-in, failure and admin change is written in the same transaction. Secrets are redacted. The database itself rejects UPDATE/DELETE/TRUNCATE |
| Deploy | [render.yaml](../../render.yaml): public `crm-web` proxies `/api` to a private `crm-api`, plus managed PostgreSQL 17 (Singapore). Migrations and seed run in `preDeployCommand` |

## How it was verified

- **69 automated tests, all passing** (`npm test`): 8 permission-model unit tests, 10 crypto tests (including the RFC 4226 vectors), and 51 API end-to-end tests. The end-to-end tests run against a throwaway **real PostgreSQL 17** with the real migrations. They cover:
  - an allow/deny matrix for all 8 roles × admin endpoints
  - scoped directory visibility
  - escalation guards and last-Super-Admin protection
  - the full user lifecycle, with its audit trail checked
  - lockout and rate limiting
  - TOTP enrolment, verification and replay rejection
  - Google and Microsoft SSO against a local OIDC issuer that signs real RS256 tokens: company and personal accounts accepted; other tenants, forged issuer, non-Gmail consumer accounts, unverified email, tampered state, wrong nonce, failed code exchange, uninvited and suspended users rejected; personal accounts switched off
  - one-time links, session revocation and idle expiry
  - audit tamper-proofing and the UTC clock
- **Live smoke run** of the production builds (`next start` + `node dist/main.js`) through the web proxy. Bootstrap CLI → set-password link → forced 2FA enrolment → signed in → create department, team and employee → audit trail → logout → all 7 pages served. 15/15 checks passed.

## Not verified yet (needs your accounts)

- **Real Google and Microsoft sign-in.** The code path is tested against a local issuer that behaves like Google. Testing with your real tenants needs:
  - *Google:* Cloud console → OAuth consent screen, user type **External** (Internal would block Gmail users), scopes `openid email profile` only, so no Google verification is needed for sign-in. Then OAuth client (Web), redirect URI `https://<APP_URL>/api/v1/auth/sso/google/callback`.
  - *Microsoft:* Entra ID → App registration, supported account types **"Accounts in any organizational directory and personal Microsoft accounts"** (the code still accepts only your tenant and personal accounts). Redirect URI `https://<APP_URL>/api/v1/auth/sso/microsoft/callback`. A client secret, and your tenant ID.
- **Render deployment.** The blueprint has not been validated with the Render CLI (not installed here) and has not been deployed. After the first deploy, check that the client IPs in the audit log are real employee IPs. If they show Render-internal addresses, adjust `TRUST_PROXY_HOPS`.

## Known gaps carried forward

- No CI pipeline yet. The project is not in a Git repository.
- RLS policies ship with the conversation tables in Phase 3, which is the first phase with tables they protect.
- The permission cache is per request (2 queries). Redis caching comes with Phase 2's Redis.
- The local dev database contains one leftover test audit row (`action = 'test'`). It cannot be deleted, by design.

## Run it locally

```bash
npm install
npm run db:local                       # terminal 1: PostgreSQL 17 on :54329
cp .env.example .env                   # then fill SESSION_SECRET / ENCRYPTION_KEYS (commands inside)
npm run db:migrate && npm run build
npm run cli:local:create-super-admin -w @crm/api -- --email you@seodiscovery.com --name "Your Name" --password-link
npm run start:local -w @crm/api        # terminal 2: API on :4000
npm run start -w @crm/web              # terminal 3: web on :3000 → open the printed link
npm test                               # all suites
```

## First production deploy (Render)

1. Push the repo to GitHub or GitLab, then in Render choose **New → Blueprint** and select the repo.
2. Enter `APP_URL` (the public https URL of `crm-web`, or your custom domain), `ALLOWED_LOGIN_DOMAINS`, and the Google/Microsoft credentials.
3. **Back up `ENCRYPTION_KEYS`** (Render generates it) somewhere safe outside Render. Without it, stored 2FA secrets, and later mailbox tokens, cannot be decrypted.
4. Open the `crm-api` shell and run `node apps/api/dist/cli/create-super-admin.js --email <you> --name "<name>"`. Then sign in with Google or Microsoft. Add `--password-link` to use a password instead.
