# Runbook: backups and restore

## What must be backed up

1. **The PostgreSQL database `crm-db`.** It holds all data, including the job queue.
2. **`ENCRYPTION_KEYS`** (in Render's environment). It decrypts mailbox passwords/tokens, TOTP secrets and attachment files. Keep a copy in the company password manager. **A database backup without the keys cannot reconnect a single mailbox.**
3. **The attachment bucket**, if `S3_BUCKET` is set. Turn on the provider's object versioning or bucket replication. Files there are encrypted with the keys above.

Mail itself is also at the providers (Gmail, Microsoft 365, IMAP hosts). After a restore, the worker syncs anything newer than the backup on its next run, so mail received after the backup is not lost.

## Automatic backups (Render)

Render takes automatic backups of paid PostgreSQL instances and offers point-in-time recovery. The retention window depends on the workspace plan. **Check it** under `crm-db` → **Recovery**, and make sure it is at least 7 days.

## Manual backup (before risky changes)

Use PostgreSQL 17 client tools and the database's **external** connection string from Render:

```bash
pg_dump --format=custom --enable-row-security --no-owner --no-privileges \
  --dbname="$EXTERNAL_DATABASE_URL" --file="crm-$(date +%F-%H%M).dump"
```

`--enable-row-security` is required. The conversation tables force row-level security, and without the flag pg_dump stops with *"query would be affected by row-level security policy"*.

The app's database user does not set an employee, so it is treated as a trusted session. The dump is therefore complete.

Store the file encrypted (it contains every email). Delete it when it is no longer needed.

## Restore

**Point in time (Render):**
1. Go to `crm-db` → **Recovery**, choose the time, and restore into a **new** database.
2. Point `DATABASE_URL` of `crm-api` and `crm-worker` at it, then redeploy both.
3. Check System health.

**From a dump file:**
1. Create an empty database owned by the app user.
2. Run:
   ```bash
   pg_restore --no-owner --no-privileges --exit-on-error --dbname="$NEW_DATABASE_URL" crm-2026-…dump
   ```
3. Then point `DATABASE_URL` at it as above.

**After a restore:**
- **Wrong or missing keys:** if mailboxes show "needs reconnecting", the restored database is being used with the wrong `ENCRYPTION_KEYS`.
- **Report figures:** the analytics rollup runs every 10 minutes. Run `npm run cli:analytics-rebuild -w @crm/api -- --days 30` to refresh the recent ones at once.

## Restore drill

`tools/backup/restore-drill.mts` runs on **every CI build** (GitHub Actions, against PostgreSQL 17). It:

1. Builds a database the way production does: real migrations, a non-superuser owner, a fixed dataset of 5,000 conversations and 100 employees.
2. Backs it up with `pg_dump --enable-row-security`.
3. Restores it into an empty database.
4. Checks the copy:
   - the row counts of every table;
   - id checksums of threads, messages, users, audit log and migrations;
   - that all 20 RLS policies are present and enforced on the 5 content tables;
   - that **an employee still sees only their own conversations in the restored copy**, while an admin sees all.

To run it by hand against any PostgreSQL 17 you control:

```bash
DRILL_ADMIN_URL=postgresql://postgres:…@host:5432/postgres node tools/backup/restore-drill.mts
```

**Do one real drill a quarter on Render:**
1. Restore the production database to a new instance (point in time, about 1 hour ago).
2. Run the verification part against it.
3. Note the time it took. That is the realistic recovery time.
4. Delete the instance.
