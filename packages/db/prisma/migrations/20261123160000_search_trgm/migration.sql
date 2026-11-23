-- Phase 10 (load test): inbox search matches parts of subjects and sender addresses with
-- ILIKE '%…%'; trigram indexes keep that fast at 100k+ conversations.
CREATE INDEX IF NOT EXISTS "email_threads_subject_trgm_idx" ON "email_threads" USING GIN ("subject" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "email_messages_fromAddress_trgm_idx" ON "email_messages" USING GIN ("fromAddress" gin_trgm_ops);
