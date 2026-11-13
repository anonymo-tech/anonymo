-- Read-only database role for monitoring/anonymo-exporter.ts (WS10). Run as the schema owner after migrations:
--   ANONYMO_MONITOR_PASSWORD=... psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f deploy/anonymo/monitor-role.sql
-- It can read only the tables the exporter names, and from kv only through a view limited to Anonymo job and
-- balance rows. It cannot read keys, ledgers, deposits' source addresses, receipts or any request rows.
\set ON_ERROR_STOP on
\getenv monitor_password ANONYMO_MONITOR_PASSWORD
\if :{?monitor_password}
\else
  \echo 'Set ANONYMO_MONITOR_PASSWORD'
  \quit 1
\endif

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anonymo_monitor') AS create_monitor \gset
\if :create_monitor
  SELECT format('CREATE ROLE anonymo_monitor LOGIN PASSWORD %L', :'monitor_password') \gexec
\else
  SELECT format('ALTER ROLE anonymo_monitor LOGIN PASSWORD %L', :'monitor_password') \gexec
\endif
ALTER ROLE anonymo_monitor NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
ALTER ROLE anonymo_monitor SET statement_timeout = '5s';
ALTER ROLE anonymo_monitor SET default_transaction_read_only = on;

SELECT current_database() AS target_database \gset
GRANT CONNECT ON DATABASE :"target_database" TO anonymo_monitor;
GRANT USAGE ON SCHEMA public TO anonymo_monitor;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anonymo_monitor;

-- Canary outcomes (route id, ok, time), route tiers, TEE attestation freshness, refusal counts, withdrawal queue.
GRANT SELECT (provider_id, ok, ts, source) ON health TO anonymo_monitor;
GRANT SELECT (provider_id, tier) ON offers TO anonymo_monitor;
GRANT SELECT (id, attested, attested_at, tee_kind, status) ON providers TO anonymo_monitor;
GRANT SELECT ON refusal_stats TO anonymo_monitor;
GRANT SELECT (status, created_at) ON anonymo_withdrawals TO anonymo_monitor;

-- kv holds other operator state; expose only the rows the exporter reads.
CREATE OR REPLACE VIEW anonymo_monitor_kv WITH (security_barrier) AS
  SELECT key, value, updated_at FROM kv
  WHERE key LIKE 'anonymo:balance:%' OR key LIKE 'anonymo:cursor:%'
     OR key IN ('job-health:anonymo-canaries', 'job-health:anonymo-balances', 'job-health:anonymo-deposits',
                'job-health:anonymo-sanctions', 'job-health:health-flush');
GRANT SELECT ON anonymo_monitor_kv TO anonymo_monitor;
