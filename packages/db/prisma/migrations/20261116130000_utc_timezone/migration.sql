-- Prisma stores DateTime as UTC in `timestamp without time zone` columns. Database-side
-- defaults (CURRENT_TIMESTAMP) and now() comparisons in raw SQL (audit retention trigger,
-- SLA and purge jobs) use the session time zone, so pin it to UTC for every connection.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
END
$$;
