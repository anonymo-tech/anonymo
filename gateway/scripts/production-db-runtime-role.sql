\set ON_ERROR_STOP on
-- Run as the migration/schema owner after migrations, with RUNTIME_DB_PASSWORD injected into psql.
-- API and workers get application DML only; they cannot create/alter schema objects or roles.
\getenv runtime_password RUNTIME_DB_PASSWORD
SELECT format('CREATE ROLE anonymo_runtime LOGIN PASSWORD %L', :'runtime_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anonymo_runtime')
\gexec
ALTER ROLE anonymo_runtime PASSWORD :'runtime_password';
ALTER ROLE anonymo_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE anonymo TO anonymo_runtime;
GRANT USAGE ON SCHEMA public, drizzle TO anonymo_runtime;
REVOKE CREATE ON SCHEMA public, drizzle FROM PUBLIC, anonymo_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anonymo_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anonymo_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA drizzle FROM anonymo_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO anonymo_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE anonymo IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anonymo_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE anonymo IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anonymo_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE anonymo IN SCHEMA drizzle
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anonymo_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE anonymo IN SCHEMA drizzle
  GRANT SELECT ON TABLES TO anonymo_runtime;
