import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import pg from "pg";

import { loadMigrationDefinitions } from "./definitions.ts";
import { isDatabaseMigrationError } from "./errors.ts";
import { db00MigrationDirectory, runDatabaseMigrations } from "./migrator.ts";

const execFileAsync = promisify(execFile);
const postgresImage =
  "postgres:16.14-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8";
const database = "ontos_db00";
const adminPassword = "local-only-db00-admin-secret";
const runtimePassword = "local-only-db00-runtime-secret";
const runtimeRoles = ["api_runtime", "worker_runtime", "read_only_ops"] as const;

void test(
  "DB-00 deploys on PostgreSQL 16 and enforces runtime boundaries",
  { timeout: 120_000 },
  async () => {
    const containerName = `ontos-db00-${process.pid}-${randomUUID().slice(0, 8)}`;
    await docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--env",
      `POSTGRES_PASSWORD=${adminPassword}`,
      "--env",
      `POSTGRES_DB=${database}`,
      "--publish",
      "127.0.0.1::5432",
      postgresImage,
    ]);

    try {
      const port = await publishedPostgreSqlPort(containerName);
      const adminConfig: pg.ClientConfig = {
        host: "127.0.0.1",
        port,
        database,
        user: "postgres",
        password: adminPassword,
        application_name: "ontos-db00-integration",
      };
      await waitForPostgreSql(adminConfig);

      await withClient(adminConfig, async (admin) => {
        await assertStableMigrationError(
          runDatabaseMigrations(admin, { supportedMajors: [15] }),
          "DB_VERSION_UNSUPPORTED",
        );
        await assertDatabaseStillEmpty(admin);

        await assertStableMigrationError(
          runDatabaseMigrations(admin, { requiredExtensions: ["db00_missing_extension"] }),
          "DB_REQUIRED_EXTENSION_MISSING",
        );
        await assertDatabaseStillEmpty(admin);

        const firstRun = await runDatabaseMigrations(admin);
        assert.equal(firstRun.noOp, false);
        assert.deepEqual(
          firstRun.applied.map(({ fileName }) => fileName),
          ["0001_foundation.sql"],
        );

        const secondRun = await runDatabaseMigrations(admin);
        assert.deepEqual(secondRun.applied, []);
        assert.equal(secondRun.noOp, true);

        await assertLedger(admin);
        await assertFormalRoles(admin);
        await assertSchemaBoundaries(admin);
        await exerciseForwardRepair(admin);
        await createPrivilegeProbe(admin);
        await createRuntimeLogins(admin);
      });

      await assertSecondDatabaseAndConcurrentRunner(adminConfig);

      for (const login of ["db00_api_login", "db00_worker_login"] as const) {
        await withClient(
          { ...adminConfig, user: login, password: runtimePassword },
          assertAppendOnlyRuntime,
        );
      }
      await withClient(
        { ...adminConfig, user: "db00_read_only_login", password: runtimePassword },
        assertReadOnlyRuntime,
      );
    } finally {
      await docker(["rm", "--force", containerName], true);
    }
  },
);

async function assertDatabaseStillEmpty(client: pg.Client): Promise<void> {
  const result = await client.query<{
    readonly migration_schema_exists: boolean;
    readonly migration_owner_exists: boolean;
  }>(`
    SELECT pg_catalog.to_regnamespace('ontos_migration') IS NOT NULL AS migration_schema_exists,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'migration_owner'
           ) AS migration_owner_exists`);
  assert.deepEqual(result.rows[0], {
    migration_schema_exists: false,
    migration_owner_exists: false,
  });
}

async function assertSecondDatabaseAndConcurrentRunner(
  adminConfig: pg.ClientConfig,
): Promise<void> {
  await withClient(adminConfig, async (admin) => {
    await admin.query("CREATE DATABASE ontos_db00_second");
  });
  const secondDatabaseConfig = { ...adminConfig, database: "ontos_db00_second" };
  const [left, right] = await Promise.all([
    withClient(secondDatabaseConfig, runMigrationsWithDatabaseCause),
    withClient(secondDatabaseConfig, runMigrationsWithDatabaseCause),
  ]);
  assert.equal(left.applied.length + right.applied.length, 1);
  assert.equal(Number(left.noOp) + Number(right.noOp), 1);
}

async function runMigrationsWithDatabaseCause(client: pg.Client) {
  try {
    return await runDatabaseMigrations(client);
  } catch (error) {
    if (isDatabaseMigrationError(error) && error.cause instanceof Error) throw error.cause;
    throw error;
  }
}

async function assertLedger(client: pg.Client): Promise<void> {
  const definitions = await loadMigrationDefinitions(db00MigrationDirectory);
  const result = await client.query<{
    readonly version: number;
    readonly name: string;
    readonly sha256: string;
    readonly applied_by: string;
    readonly applied_role: string;
    readonly server_version_num: number;
  }>(`
    SELECT version::integer, name, sha256, applied_by, applied_role, server_version_num
    FROM ontos_migration.schema_migrations
    ORDER BY version`);
  const definition = definitions[0];
  assert.ok(definition);
  assert.deepEqual(result.rows, [
    {
      version: definition.version,
      name: definition.name,
      sha256: definition.sha256,
      applied_by: "postgres",
      applied_role: "migration_owner",
      server_version_num: 160_014,
    },
  ]);
}

async function assertFormalRoles(client: pg.Client): Promise<void> {
  const result = await client.query<{
    readonly rolname: string;
    readonly rolcanlogin: boolean;
    readonly rolsuper: boolean;
    readonly rolcreatedb: boolean;
    readonly rolcreaterole: boolean;
    readonly rolinherit: boolean;
    readonly rolreplication: boolean;
    readonly rolbypassrls: boolean;
  }>(`
    SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
           rolinherit, rolreplication, rolbypassrls
    FROM pg_catalog.pg_roles
    WHERE rolname IN ('migration_owner', 'api_runtime', 'worker_runtime', 'read_only_ops')
    ORDER BY rolname`);
  assert.equal(result.rows.length, 4);
  for (const row of result.rows) {
    assert.equal(row.rolcanlogin, false, row.rolname);
    assert.equal(row.rolsuper, false, row.rolname);
    assert.equal(row.rolcreatedb, false, row.rolname);
    assert.equal(row.rolcreaterole, false, row.rolname);
    assert.equal(row.rolreplication, false, row.rolname);
    assert.equal(row.rolbypassrls, false, row.rolname);
    assert.equal(row.rolinherit, row.rolname !== "migration_owner", row.rolname);
    const parentMemberships = await client.query<{ readonly count: number }>(
      `SELECT count(*)::integer AS count
       FROM pg_catalog.pg_auth_members
       WHERE member = $1::regrole`,
      [row.rolname],
    );
    assert.equal(parentMemberships.rows[0]?.count, 0, row.rolname);
  }

  for (const role of runtimeRoles) {
    const membership = await client.query<{ readonly is_member: boolean }>(
      "SELECT pg_catalog.pg_has_role($1::name, 'migration_owner', 'MEMBER') AS is_member",
      [role],
    );
    assert.equal(membership.rows[0]?.is_member, false, role);

    const databasePrivileges = await client.query<{
      readonly can_connect: boolean;
      readonly can_create: boolean;
      readonly can_temporary: boolean;
    }>(
      `SELECT pg_catalog.has_database_privilege($1, current_database(), 'CONNECT') AS can_connect,
              pg_catalog.has_database_privilege($1, current_database(), 'CREATE') AS can_create,
              pg_catalog.has_database_privilege($1, current_database(), 'TEMPORARY') AS can_temporary`,
      [role],
    );
    assert.deepEqual(databasePrivileges.rows[0], {
      can_connect: true,
      can_create: false,
      can_temporary: false,
    });
  }
}

async function assertSchemaBoundaries(client: pg.Client): Promise<void> {
  const schemas = await client.query<{ readonly nspname: string; readonly owner: string }>(`
    SELECT nspname, pg_catalog.pg_get_userbyid(nspowner) AS owner
    FROM pg_catalog.pg_namespace
    WHERE nspname IN ('meta', 'authz', 'runtime', 'action', 'ops', 'audit', 'ontos_migration')
    ORDER BY nspname`);
  assert.equal(schemas.rows.length, 7);
  assert.ok(schemas.rows.every(({ owner }) => owner === "migration_owner"));

  for (const role of runtimeRoles) {
    const ledgerAccess = await client.query<{ readonly can_select: boolean }>(
      "SELECT pg_catalog.has_table_privilege($1, 'ontos_migration.schema_migrations', 'SELECT') AS can_select",
      [role],
    );
    assert.equal(ledgerAccess.rows[0]?.can_select, false, role);
  }
}

async function createPrivilegeProbe(client: pg.Client): Promise<void> {
  await client.query(`
    BEGIN;
    SET LOCAL ROLE migration_owner;
    CREATE TABLE audit.db00_append_only_probe (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      value text NOT NULL
    );
    CREATE FUNCTION audit.db00_owner_function() RETURNS integer
    LANGUAGE sql IMMUTABLE AS 'SELECT 1';
    CREATE TYPE audit.db00_owner_enum AS ENUM ('only_value');
    COMMIT;`);

  for (const role of runtimeRoles) {
    const defaults = await client.query<{
      readonly can_select: boolean;
      readonly can_insert: boolean;
      readonly can_execute: boolean;
      readonly can_use_type: boolean;
    }>(
      `SELECT pg_catalog.has_table_privilege($1, 'audit.db00_append_only_probe', 'SELECT') AS can_select,
              pg_catalog.has_table_privilege($1, 'audit.db00_append_only_probe', 'INSERT') AS can_insert,
              pg_catalog.has_function_privilege($1, 'audit.db00_owner_function()', 'EXECUTE') AS can_execute,
              pg_catalog.has_type_privilege($1, 'audit.db00_owner_enum', 'USAGE') AS can_use_type`,
      [role],
    );
    assert.deepEqual(defaults.rows[0], {
      can_select: false,
      can_insert: false,
      can_execute: false,
      can_use_type: false,
    });
  }

  await client.query(`
    BEGIN;
    SET LOCAL ROLE migration_owner;
    GRANT SELECT, INSERT ON audit.db00_append_only_probe TO api_runtime, worker_runtime;
    GRANT USAGE, SELECT ON SEQUENCE audit.db00_append_only_probe_id_seq TO api_runtime, worker_runtime;
    GRANT SELECT ON audit.db00_append_only_probe TO read_only_ops;
    COMMIT;`);
}

async function exerciseForwardRepair(client: pg.Client): Promise<void> {
  const directory = await mkdtemp(resolve(tmpdir(), "ontos-db00-forward-repair-"));
  const firstMigration = resolve(directory, "0001_foundation.sql");
  const failedMigration = resolve(directory, "0002_failed_attempt.sql");
  const defectMigration = resolve(directory, "0002_forward_repair_probe.sql");
  const repairMigration = resolve(directory, "0003_forward_repair.sql");

  try {
    await copyFile(resolve(db00MigrationDirectory, "0001_foundation.sql"), firstMigration);
    await writeFile(
      failedMigration,
      `CREATE TABLE ops.db00_forward_repair_probe (
         id bigint PRIMARY KEY,
         value text
       );
       SELECT 1 / 0;\n`,
    );

    await assertStableMigrationError(
      runDatabaseMigrations(client, { directory }),
      "DB_MIGRATION_EXECUTION_FAILED",
    );
    await assertProbeAndLedgerState(client, false, 1);

    await rm(failedMigration);
    await writeFile(
      defectMigration,
      `CREATE TABLE ops.db00_forward_repair_probe (
         id bigint PRIMARY KEY,
         value text
       );
       INSERT INTO ops.db00_forward_repair_probe (id, value) VALUES (1, NULL);\n`,
    );
    const defectRun = await runDatabaseMigrations(client, { directory });
    assert.deepEqual(
      defectRun.applied.map(({ version }) => version),
      [2],
    );

    await writeFile(
      repairMigration,
      `UPDATE ops.db00_forward_repair_probe
       SET value = 'repaired'
       WHERE value IS NULL;
       ALTER TABLE ops.db00_forward_repair_probe
       ALTER COLUMN value SET NOT NULL;\n`,
    );
    const repairRun = await runDatabaseMigrations(client, { directory });
    assert.deepEqual(
      repairRun.applied.map(({ version }) => version),
      [3],
    );

    const definitions = await loadMigrationDefinitions(directory);
    const history = await client.query<{
      readonly version: number;
      readonly sha256: string;
    }>(`
      SELECT version::integer, sha256
      FROM ontos_migration.schema_migrations
      ORDER BY version`);
    assert.deepEqual(
      history.rows,
      definitions.map(({ version, sha256 }) => ({ version, sha256 })),
    );

    const repaired = await client.query<{
      readonly value: string;
      readonly is_not_null: boolean;
    }>(`
      SELECT probe.value, attribute.attnotnull AS is_not_null
      FROM ops.db00_forward_repair_probe AS probe
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = 'ops.db00_forward_repair_probe'::regclass
       AND attribute.attname = 'value'
      WHERE probe.id = 1`);
    assert.deepEqual(repaired.rows[0], { value: "repaired", is_not_null: true });

    await writeFile(
      defectMigration,
      `CREATE TABLE ops.db00_forward_repair_probe (id bigint PRIMARY KEY, value text);\n`,
    );
    await assertStableMigrationError(
      runDatabaseMigrations(client, { directory }),
      "DB_MIGRATION_HISTORY_DIVERGED",
    );
    await assertProbeAndLedgerState(client, true, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertProbeAndLedgerState(
  client: pg.Client,
  probeExists: boolean,
  ledgerRows: number,
): Promise<void> {
  const result = await client.query<{
    readonly probe_exists: boolean;
    readonly ledger_rows: number;
  }>(`
    SELECT pg_catalog.to_regclass('ops.db00_forward_repair_probe') IS NOT NULL AS probe_exists,
           (SELECT count(*)::integer FROM ontos_migration.schema_migrations) AS ledger_rows`);
  assert.deepEqual(result.rows[0], {
    probe_exists: probeExists,
    ledger_rows: ledgerRows,
  });
}

async function createRuntimeLogins(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE ROLE db00_api_login LOGIN PASSWORD '${runtimePassword}';
    CREATE ROLE db00_worker_login LOGIN PASSWORD '${runtimePassword}';
    CREATE ROLE db00_read_only_login LOGIN PASSWORD '${runtimePassword}';
    GRANT api_runtime TO db00_api_login;
    GRANT worker_runtime TO db00_worker_login;
    GRANT read_only_ops TO db00_read_only_login;`);
}

async function assertAppendOnlyRuntime(client: pg.Client): Promise<void> {
  await client.query("INSERT INTO audit.db00_append_only_probe (value) VALUES ('accepted')");
  const selected = await client.query<{ readonly count: number }>(
    "SELECT count(*)::integer AS count FROM audit.db00_append_only_probe",
  );
  assert.ok((selected.rows[0]?.count ?? 0) >= 1);

  await assertPrivilegeDenied(client, "UPDATE audit.db00_append_only_probe SET value = 'denied'");
  await assertPrivilegeDenied(client, "DELETE FROM audit.db00_append_only_probe");
  await assertPrivilegeDenied(client, "TRUNCATE audit.db00_append_only_probe");
  await assertPrivilegeDenied(
    client,
    "ALTER TABLE audit.db00_append_only_probe ADD COLUMN denied text",
  );
  await assertCommonEscalationsDenied(client);
}

async function assertReadOnlyRuntime(client: pg.Client): Promise<void> {
  await client.query("SELECT count(*) FROM audit.db00_append_only_probe");
  await assertPrivilegeDenied(
    client,
    "INSERT INTO audit.db00_append_only_probe (value) VALUES ('denied')",
  );
  await assertPrivilegeDenied(client, "UPDATE audit.db00_append_only_probe SET value = 'denied'");
  await assertPrivilegeDenied(client, "DELETE FROM audit.db00_append_only_probe");
  await assertCommonEscalationsDenied(client);
}

async function assertCommonEscalationsDenied(client: pg.Client): Promise<void> {
  await assertPrivilegeDenied(client, "CREATE SCHEMA db00_denied");
  await assertPrivilegeDenied(client, "CREATE ROLE db00_denied_role");
  await assertPrivilegeDenied(client, "CREATE EXTENSION hstore WITH SCHEMA audit");
  await assertPrivilegeDenied(client, "SET ROLE migration_owner");
  await assertPrivilegeDenied(client, "SELECT * FROM ontos_migration.schema_migrations");
}

async function assertPrivilegeDenied(client: pg.Client, sql: string): Promise<void> {
  await assert.rejects(
    client.query(sql),
    (error: unknown) => isPostgreSqlError(error) && error.code === "42501",
  );
}

async function assertStableMigrationError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => isDatabaseMigrationError(error) && error.code === code,
  );
}

async function withClient<T>(
  config: pg.ClientConfig,
  action: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client(config);
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}

async function waitForPostgreSql(config: pg.ClientConfig): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await withClient(config, async (client) => {
        await client.query("SELECT 1");
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("PostgreSQL integration container did not become ready.", { cause: lastError });
}

async function publishedPostgreSqlPort(containerName: string): Promise<number> {
  const { stdout } = await execFileAsync("docker", ["port", containerName, "5432/tcp"]);
  const match = /:(?<port>[0-9]+)\s*$/u.exec(stdout);
  const port = Number(match?.groups?.["port"]);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Docker did not publish a valid PostgreSQL port.");
  }
  return port;
}

async function docker(arguments_: readonly string[], ignoreFailure = false): Promise<void> {
  try {
    await execFileAsync("docker", arguments_);
  } catch (error) {
    if (!ignoreFailure) throw error;
  }
}

function isPostgreSqlError(value: unknown): value is { readonly code: string } {
  return typeof value === "object" && value !== null && "code" in value;
}
