DO $db00_roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'migration_owner') THEN
    EXECUTE 'CREATE ROLE migration_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'api_runtime') THEN
    EXECUTE 'CREATE ROLE api_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'worker_runtime') THEN
    EXECUTE 'CREATE ROLE worker_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'read_only_ops') THEN
    EXECUTE 'CREATE ROLE read_only_ops NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'migration_owner'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'DB_ROLE_CONFLICT:migration_owner';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname IN ('api_runtime', 'worker_runtime', 'read_only_ops')
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR NOT rolinherit OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'DB_ROLE_CONFLICT:runtime_role';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
    WHERE member_role.rolname IN (
      'migration_owner', 'api_runtime', 'worker_runtime', 'read_only_ops'
    )
  ) THEN
    RAISE EXCEPTION 'DB_ROLE_CONFLICT:formal_role_membership';
  END IF;
END
$db00_roles$;

DO $db00_database_acl$
BEGIN
  EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format(
    'GRANT CONNECT, CREATE ON DATABASE %I TO migration_owner',
    current_database()
  );
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO api_runtime, worker_runtime, read_only_ops',
    current_database()
  );
END
$db00_database_acl$;

REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;

SET LOCAL ROLE migration_owner;

CREATE SCHEMA meta AUTHORIZATION migration_owner;
CREATE SCHEMA authz AUTHORIZATION migration_owner;
CREATE SCHEMA runtime AUTHORIZATION migration_owner;
CREATE SCHEMA action AUTHORIZATION migration_owner;
CREATE SCHEMA ops AUTHORIZATION migration_owner;
CREATE SCHEMA audit AUTHORIZATION migration_owner;
CREATE SCHEMA ontos_migration AUTHORIZATION migration_owner;

DO $db00_schema_owners$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace
    WHERE nspname IN ('meta', 'authz', 'runtime', 'action', 'ops', 'audit', 'ontos_migration')
      AND pg_catalog.pg_get_userbyid(nspowner) <> 'migration_owner'
  ) THEN
    RAISE EXCEPTION 'DB_SCHEMA_OWNER_CONFLICT';
  END IF;
END
$db00_schema_owners$;

REVOKE ALL PRIVILEGES ON SCHEMA ontos_migration FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
GRANT USAGE ON SCHEMA meta, authz, runtime, action, ops, audit TO api_runtime, worker_runtime;
GRANT USAGE ON SCHEMA ops, audit TO read_only_ops;

ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner REVOKE ALL PRIVILEGES ON ROUTINES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner REVOKE ALL PRIVILEGES ON TYPES FROM PUBLIC;

CREATE TABLE ontos_migration.schema_migrations (
  version bigint PRIMARY KEY CHECK (version > 0),
  name text NOT NULL CHECK (name ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_by name NOT NULL,
  applied_role name NOT NULL CHECK (applied_role = 'migration_owner'),
  server_version_num integer NOT NULL CHECK (server_version_num > 0)
);

REVOKE ALL PRIVILEGES ON TABLE ontos_migration.schema_migrations
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
