-- Hand-written migration: features Prisma's schema language cannot express.

-- 1. Full-text search over messages (generated column + GIN index).
ALTER TABLE "email_messages" DROP COLUMN IF EXISTS "searchVector";
ALTER TABLE "email_messages" ADD COLUMN "searchVector" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce("subject", '')), 'A') ||
  setweight(to_tsvector('simple', coalesce("fromAddress", '') || ' ' || coalesce("fromName", '')), 'B') ||
  setweight(to_tsvector('simple', coalesce("bodyText", '')), 'C')
) STORED;
CREATE INDEX "email_messages_searchVector_idx" ON "email_messages" USING GIN ("searchVector");

-- 2. Fuzzy lookup for contact matching / duplicate detection.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "contact_emails_email_trgm_idx" ON "contact_emails" USING GIN ("email" gin_trgm_ops);
CREATE INDEX "contacts_name_trgm_idx" ON "contacts" USING GIN ("name" gin_trgm_ops);

-- 3. A mailbox grant targets exactly one of user / team / department.
ALTER TABLE "email_account_access" ADD CONSTRAINT "email_account_access_one_grantee" CHECK (
  ("userId" IS NOT NULL)::int + ("teamId" IS NOT NULL)::int + ("departmentId" IS NOT NULL)::int = 1
);

-- 4. Audit log is append-only, enforced inside the database regardless of which role connects.
--    The only permitted deletion is the retention purge (rows older than 7 years) and only when
--    the purge job sets `SET LOCAL app.audit_purge = 'on'` in its transaction.
CREATE OR REPLACE FUNCTION crm_audit_logs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.audit_purge', true) = 'on'
     AND OLD."createdAt" < now() - interval '7 years' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION crm_audit_logs_guard();

CREATE OR REPLACE FUNCTION crm_audit_logs_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs cannot be truncated' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_no_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION crm_audit_logs_no_truncate();
