-- Anonymo · the request log as a Timescale hypertable with 30-day retention (Backend §7, WS10).
--
-- An operator step, not an app migration: run it as the schema owner after `scripts/migrate.ts`, and again after any
-- migration that recreates the table. It is idempotent and safe to re-run.
--
--   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 [-v retention_days=30] -f deploy/timescale/requests-hypertable.sql
--   docker compose -f docker-compose.yml -f docker-compose.anonymo.yml --profile ops run --rm timescale-ops
--
-- Which table: `requests` when it exists (the spec's name), otherwise `generations` (the gateway's request log today;
-- metadata only, no prompt or output text). Time column: `at` when present, otherwise `ts`.
--
-- What it changes, once:
--   1. CREATE EXTENSION timescaledb (needs a server started with shared_preload_libraries=timescaledb).
--   2. A hypertable needs the time column in every unique index. When the primary key is (id) alone it becomes
--      (id, <time>). Inserts never use ON CONFLICT on this table, so the app is unaffected; ids stay random UUID-class
--      values. Any other unique index without the time column, or a foreign key that references this table, stops
--      the script before anything changes (fix that in an app migration first).
--   3. create_hypertable(..., migrate_data => true) with 1-day chunks. This rewrites existing rows and holds a lock
--      for the duration: run it in a maintenance window, after a verified backup (infra/README.md).
--   4. A retention policy dropping chunks older than :retention_days (default 30). Re-running with a new value
--      replaces the policy.
-- Every step runs in one transaction except CREATE EXTENSION.

\set ON_ERROR_STOP on
\if :{?retention_days}
\else
  \set retention_days 30
\endif

CREATE EXTENSION IF NOT EXISTS timescaledb;

BEGIN;

SELECT set_config('anonymo.retention_days', :'retention_days', true) AS retention_days_set \gset

DO $$
DECLARE
  tbl text := CASE WHEN to_regclass('public.requests') IS NOT NULL THEN 'requests' ELSE 'generations' END;
  rel regclass;
  tcol text;
  tnum smallint;
  pk record;
  bad text;
  days int := current_setting('anonymo.retention_days')::int;
BEGIN
  IF days < 1 OR days > 3650 THEN
    RAISE EXCEPTION 'retention_days must be between 1 and 3650 (got %)', days;
  END IF;
  rel := to_regclass('public.' || quote_ident(tbl));
  IF rel IS NULL THEN
    RAISE EXCEPTION 'neither public.requests nor public.generations exists: run scripts/migrate.ts first';
  END IF;

  SELECT a.attname, a.attnum INTO tcol, tnum
  FROM pg_attribute a
  WHERE a.attrelid = rel AND a.attname IN ('at', 'ts') AND NOT a.attisdropped
    AND format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone'
  ORDER BY (a.attname = 'at') DESC
  LIMIT 1;
  IF tcol IS NULL THEN
    RAISE EXCEPTION '%: no timestamptz column named at or ts', tbl;
  END IF;

  IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_schema = 'public' AND hypertable_name = tbl) THEN
    RAISE NOTICE '% is already a hypertable', tbl;
  ELSE
    -- Nothing may reference it: Timescale cannot keep a foreign key that points at a hypertable's chunks.
    SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ') INTO bad
    FROM pg_constraint WHERE confrelid = rel AND contype = 'f';
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION '% is referenced by foreign keys (%); drop or move them in an app migration first', tbl, bad;
    END IF;

    -- Every unique index other than the primary key must already include the time column.
    SELECT string_agg(i.indexrelid::regclass::text, ', ') INTO bad
    FROM pg_index i
    WHERE i.indrelid = rel AND i.indisunique AND NOT i.indisprimary AND NOT (tnum = ANY (i.indkey::smallint[]));
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'unique indexes on % without %: %; widen them in an app migration first', tbl, tcol, bad;
    END IF;

    -- Primary key (id) -> (id, time).
    SELECT c.conname, i.indkey::smallint[] AS cols INTO pk
    FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid
    WHERE c.conrelid = rel AND c.contype = 'p';
    IF pk.conname IS NOT NULL AND NOT (tnum = ANY (pk.cols)) THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', rel, pk.conname);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I PRIMARY KEY (%s, %I)', rel, pk.conname,
        (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
         FROM unnest(pk.cols) WITH ORDINALITY AS k(num, ord)
         JOIN pg_attribute a ON a.attrelid = rel AND a.attnum = k.num), tcol);
      RAISE NOTICE '% primary key now includes %', tbl, tcol;
    END IF;

    PERFORM create_hypertable(rel, tcol, chunk_time_interval => INTERVAL '1 day', migrate_data => true);
    RAISE NOTICE '% is now a hypertable on %', tbl, tcol;
  END IF;

  PERFORM remove_retention_policy(rel, if_exists => true);
  PERFORM add_retention_policy(rel, make_interval(days => days));
  RAISE NOTICE '% keeps % days', tbl, days;
END $$;

COMMIT;

-- One summary row for the operator's log: table, time column, chunk count and the retention window.
SELECT h.hypertable_name AS table_name,
       d.column_name AS time_column,
       h.num_chunks AS chunks,
       j.config ->> 'drop_after' AS retention
FROM timescaledb_information.hypertables h
JOIN timescaledb_information.dimensions d USING (hypertable_schema, hypertable_name)
LEFT JOIN timescaledb_information.jobs j
  ON j.hypertable_schema = h.hypertable_schema AND j.hypertable_name = h.hypertable_name AND j.proc_name = 'policy_retention'
WHERE h.hypertable_schema = 'public' AND h.hypertable_name IN ('requests', 'generations');
