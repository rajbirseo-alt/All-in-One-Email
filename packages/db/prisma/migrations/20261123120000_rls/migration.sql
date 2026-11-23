-- Phase 10: Postgres Row-Level Security on conversation content (docs/05 section 5, layer 3).
--
-- The API states its caller at the start of every transaction:
--   app.user_id       the employee ('' = no employee: a public route -> nothing is visible)
--   app.thread_scope  their conversation.read scope (ALL | DEPARTMENT | TEAM | ASSIGNED | OWN | '')
--   app.system        'on' for work the API does on its own behalf
-- A session that never set app.user_id (the worker, migrations, maintenance) is trusted.
-- The policies mirror AccessPolicy.threadWhere, so a query that forgets its access filter
-- still returns only what the caller may see.

CREATE OR REPLACE FUNCTION crm_rls_open() RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN current_setting('app.user_id', true) IS NULL
      OR current_setting('app.system', true) = 'on'
      OR (current_setting('app.user_id', true) <> '' AND current_setting('app.thread_scope', true) = 'ALL');
END $$;

CREATE OR REPLACE FUNCTION crm_rls_uid() RETURNS text LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN nullif(current_setting('app.user_id', true), '');
END $$;

-- 0 = nothing, 1 = ASSIGNED, 2 = TEAM, 3 = DEPARTMENT (ALL is handled by crm_rls_open).
CREATE OR REPLACE FUNCTION crm_rls_rank() RETURNS int LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF crm_rls_uid() IS NULL THEN RETURN 0; END IF;
  RETURN CASE current_setting('app.thread_scope', true) WHEN 'ASSIGNED' THEN 1 WHEN 'TEAM' THEN 2 WHEN 'DEPARTMENT' THEN 3 ELSE 0 END;
END $$;

-- Teams the caller belongs to or leads.
CREATE OR REPLACE FUNCTION crm_rls_teams() RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE uid text := crm_rls_uid();
BEGIN
  RETURN ARRAY(SELECT "teamId" FROM team_members WHERE "userId" = uid UNION SELECT id FROM teams WHERE "leaderId" = uid);
END $$;

-- People in the teams the caller leads.
CREATE OR REPLACE FUNCTION crm_rls_led_members() RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE uid text := crm_rls_uid();
BEGIN
  RETURN ARRAY(SELECT m."userId" FROM team_members m JOIN teams t ON t.id = m."teamId" WHERE t."leaderId" = uid);
END $$;

-- Departments the caller belongs to or manages.
CREATE OR REPLACE FUNCTION crm_rls_depts() RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE uid text := crm_rls_uid();
BEGIN
  RETURN ARRAY(SELECT "departmentId" FROM users WHERE id = uid AND "departmentId" IS NOT NULL UNION SELECT id FROM departments WHERE "managerId" = uid);
END $$;

-- Mailboxes whose conversations the caller sees through a grant (or, at DEPARTMENT scope, the department's mailboxes).
CREATE OR REPLACE FUNCTION crm_rls_accounts() RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE
  uid text := crm_rls_uid();
  r int := crm_rls_rank();
  teams text[] := CASE WHEN crm_rls_rank() >= 2 THEN crm_rls_teams() ELSE '{}'::text[] END;
  depts text[] := CASE WHEN crm_rls_rank() >= 3 THEN crm_rls_depts() ELSE '{}'::text[] END;
BEGIN
  IF r = 0 THEN RETURN '{}'::text[]; END IF;
  RETURN ARRAY(
    SELECT "emailAccountId" FROM email_account_access
     WHERE "userId" = uid OR "teamId" = ANY (teams) OR "departmentId" = ANY (depts)
    UNION
    SELECT id FROM email_accounts WHERE "departmentId" = ANY (depts));
END $$;

-- Conversations shared with the caller.
CREATE OR REPLACE FUNCTION crm_rls_shared() RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE uid text := crm_rls_uid();
BEGIN
  IF uid IS NULL THEN RETURN '{}'::text[]; END IF;
  RETURN ARRAY(SELECT "threadId" FROM thread_shares WHERE "userId" = uid);
END $$;

-- Conversations where the caller is @-mentioned in a (not deleted) note. Reads internal_notes as
-- the system (app.system on for the lookup), so the notes policy does not recurse into this one.
CREATE OR REPLACE FUNCTION crm_rls_mentioned() RETURNS text[] LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  uid text := crm_rls_uid();
  prev text := current_setting('app.system', true);
  ids text[];
BEGIN
  IF uid IS NULL THEN RETURN '{}'::text[]; END IF;
  PERFORM set_config('app.system', 'on', true);
  ids := ARRAY(SELECT DISTINCT n."threadId" FROM note_mentions m JOIN internal_notes n ON n.id = m."noteId" WHERE m."userId" = uid AND n."deletedAt" IS NULL);
  PERFORM set_config('app.system', coalesce(prev, ''), true);
  RETURN ids;
END $$;

-- Every per-caller value above is wrapped in (SELECT …), so Postgres computes it once per
-- statement (InitPlan) and the per-row test is a few comparisons.
--
-- One policy per command: reading, inserting and deleting need the conversation to be visible;
-- an update needs the row to be visible before the change only (assigning a conversation to
-- another team legitimately makes it invisible to the person who did it).
CREATE OR REPLACE FUNCTION crm_rls_policies(tbl text, visible text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('CREATE POLICY crm_read ON %I FOR SELECT USING (%s)', tbl, visible);
  EXECUTE format('CREATE POLICY crm_insert ON %I FOR INSERT WITH CHECK (%s)', tbl, visible);
  EXECUTE format('CREATE POLICY crm_update ON %I FOR UPDATE USING (%s) WITH CHECK (true)', tbl, visible);
  EXECUTE format('CREATE POLICY crm_delete ON %I FOR DELETE USING (%s)', tbl, visible);
END $$;

SELECT crm_rls_policies('email_threads', $p$
  (SELECT crm_rls_open())
  OR ((SELECT crm_rls_rank()) >= 1 AND (
       "assigneeId" = (SELECT crm_rls_uid())
    OR "emailAccountId" = ANY ((SELECT crm_rls_accounts())::text[])
    OR ((SELECT crm_rls_rank()) >= 2 AND ("teamId" = ANY ((SELECT crm_rls_teams())::text[]) OR "assigneeId" = ANY ((SELECT crm_rls_led_members())::text[])))
    OR ((SELECT crm_rls_rank()) >= 3 AND "departmentId" = ANY ((SELECT crm_rls_depts())::text[]))
    OR id = ANY ((SELECT crm_rls_shared())::text[])
    OR id = ANY ((SELECT crm_rls_mentioned())::text[])
  ))
$p$);

-- Content tables follow their conversation (the subquery is itself filtered by the policy above).
SELECT crm_rls_policies('email_messages', $p$ (SELECT crm_rls_open()) OR EXISTS (SELECT 1 FROM email_threads t WHERE t.id = email_messages."threadId") $p$);
-- Draft uploads (no message yet) belong to the draft's author; the API checks those.
SELECT crm_rls_policies('attachments', $p$ (SELECT crm_rls_open()) OR "messageId" IS NULL OR EXISTS (SELECT 1 FROM email_messages m WHERE m.id = attachments."messageId") $p$);
SELECT crm_rls_policies('internal_notes', $p$ (SELECT crm_rls_open()) OR EXISTS (SELECT 1 FROM email_threads t WHERE t.id = internal_notes."threadId") $p$);
SELECT crm_rls_policies('ai_summaries', $p$ (SELECT crm_rls_open()) OR EXISTS (SELECT 1 FROM email_threads t WHERE t.id = ai_summaries."threadId") $p$);
