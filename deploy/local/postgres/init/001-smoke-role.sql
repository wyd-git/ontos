\set ON_ERROR_STOP on
\set runtime_password 'local-only-postgres-runtime-secret'

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE ROLE ontos_smoke_owner
  NOLOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION;

CREATE ROLE ontos_smoke_runtime
  LOGIN
  PASSWORD :'runtime_password'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION;

CREATE SCHEMA ontos_smoke AUTHORIZATION ontos_smoke_owner;

SET ROLE ontos_smoke_owner;
CREATE TABLE ontos_smoke.object_probe (
  object_id text PRIMARY KEY,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
RESET ROLE;

GRANT USAGE ON SCHEMA ontos_smoke TO ontos_smoke_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE ontos_smoke.object_probe TO ontos_smoke_runtime;
ALTER ROLE ontos_smoke_runtime SET search_path = ontos_smoke, pg_catalog;
