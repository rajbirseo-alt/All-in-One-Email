# SEO Discovery — Unified Email CRM

A central place to connect every company mailbox (Gmail / Google Workspace, Microsoft 365 / Outlook, and IMAP/SMTP custom domains), with assignment, SLA tracking, CRM contacts and leads, AI-assisted drafting and management reporting.

**Status:** Phase 1 (authentication, employees, permissions, database) is complete and deployed on Render. Phase 2 (Gmail + Microsoft 365 mailboxes) Phase 3 (unified inbox, reading, triage, reply/forward/send, live updates) Phase 5 (assignment, routing rules, notes, sharing, tags, presence) and Phase 6 (status, working-hours SLA, escalation, notification bell and browser push) are built and tested locally, and wait for verification with real mailboxes and devices: see [phase-2.md](docs/phases/phase-2.md), [phase-3.md](docs/phases/phase-3.md), [phase-5.md](docs/phases/phase-5.md) and [phase-6.md](docs/phases/phase-6.md).

## Design documents

1. [System architecture](docs/01-architecture.md)
2. [Database schema](docs/02-database-schema.md) — source: [packages/db/prisma/schema.prisma](packages/db/prisma/schema.prisma)
3. [API endpoints](docs/03-api.md)
4. [UI wireframes](docs/04-ui-wireframes.md)
5. [Authentication & permissions](docs/05-auth-permissions.md)
6. [Email provider integrations](docs/06-provider-integrations.md)
7. [Development milestones](docs/07-milestones.md), including the recorded infrastructure, login, AI and retention decisions
8. [Testing strategy](docs/08-testing-strategy.md)

## Stack

Next.js + React + TypeScript + Tailwind · NestJS · PostgreSQL + Prisma · pg-boss (jobs on PostgreSQL) · socket.io · Gmail API · Microsoft Graph · imapflow / nodemailer · OpenAI API · S3-compatible storage.

## Repository

```
apps/api        NestJS API (auth, users, roles, org, audit, mailboxes) + worker (src/worker.ts)
apps/web        Next.js app (sign-in + admin screens)
packages/db     Prisma schema, migrations, seed
packages/shared Permission catalogue, role matrix, validation schemas, API types
packages/crypto Envelope encryption, TOTP, tokens
packages/providers Gmail + Microsoft Graph clients, mailbox OAuth, message parsing
tools/localdb   Real PostgreSQL 17 for dev/tests without Docker
render.yaml     Render Blueprint
```

Local setup, tests and deployment steps: [docs/phases/phase-1.md](docs/phases/phase-1.md#run-it-locally).
