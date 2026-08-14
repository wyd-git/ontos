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
const db01MetaTables = [
  "artifact_references",
  "package_installation_changes",
  "package_installations",
  "package_revisions",
  "packages",
  "projects",
  "release_channels",
  "release_pins",
  "release_serving_heads",
  "releases",
  "resource_dependencies",
  "resource_revisions",
  "resources",
  "runtime_activations",
  "validation_reports",
] as const;
const db01AuthzTables = ["authorization_epochs", "principals", "role_bindings"] as const;
const db01Ids = {
  principal: "00000000-0000-4000-8000-000000000001",
  duplicatePrincipal: "00000000-0000-4000-8000-000000000002",
  project: "00000000-0000-4000-8000-000000000101",
  duplicateProject: "00000000-0000-4000-8000-000000000102",
  resource: "00000000-0000-4000-8000-000000000201",
  duplicateResource: "00000000-0000-4000-8000-000000000202",
  revision: "00000000-0000-4000-8000-000000000301",
  duplicateRevision: "00000000-0000-4000-8000-000000000302",
  validationReport: "00000000-0000-4000-8000-000000000303",
  release: "00000000-0000-4000-8000-000000000401",
  activation: "00000000-0000-4000-8000-000000000501",
  package: "00000000-0000-4000-8000-000000000601",
  packageRevision: "00000000-0000-4000-8000-000000000701",
  duplicatePackageRevision: "00000000-0000-4000-8000-000000000702",
  installation: "00000000-0000-4000-8000-000000000801",
  change: "00000000-0000-4000-8000-000000000901",
  artifactReference: "00000000-0000-4000-8000-000000001001",
  binding: "00000000-0000-4000-8000-000000001101",
} as const;
const db01Digests = {
  revision: `sha256:${"1".repeat(64)}`,
  release: `sha256:${"2".repeat(64)}`,
  activation: `sha256:${"3".repeat(64)}`,
  package: `sha256:${"4".repeat(64)}`,
  artifact: `sha256:${"5".repeat(64)}`,
  other: `sha256:${"6".repeat(64)}`,
} as const;

void test(
  "DB-01 upgrades on PostgreSQL 16 and enforces metadata boundaries",
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
        process.stdout.write(
          `CI_METADATA postgres.server_version_num=${String(firstRun.serverVersionNum)}\n`,
        );
        assert.deepEqual(
          firstRun.applied.map(({ fileName }) => fileName),
          [
            "0001_foundation.sql",
            "0002_metadata_control_plane.sql",
            "0003_resource_revision_guards.sql",
            "0004_dependency_validation_guards.sql",
            "0005_release_lifecycle_guards.sql",
          ],
        );

        const secondRun = await runDatabaseMigrations(admin);
        assert.deepEqual(secondRun.applied, []);
        assert.equal(secondRun.noOp, true);

        await assertLedger(admin);
        await assertFormalRoles(admin);
        await assertIntentionalRoleEscalationDetected(admin);
        await assertSchemaBoundaries(admin);
        await assertDb01Catalog(admin);
        await assertDb01PrivilegeMatrix(admin);
        await assertDb01ScopeBoundary(admin);
        await exerciseForwardRepair(admin);
        await createPrivilegeProbe(admin);
        await createRuntimeLogins(admin);
      });

      await assertSecondDatabaseAndConcurrentRunner(adminConfig);

      await withClient(
        { ...adminConfig, user: "db00_api_login", password: runtimePassword },
        async (client) => {
          await assertAppendOnlyRuntime(client);
          await assertDb01ApiWritesAndConstraints(client);
        },
      );
      await withClient(
        { ...adminConfig, user: "db00_worker_login", password: runtimePassword },
        async (client) => {
          await assertAppendOnlyRuntime(client);
          await assertDb01WorkerBoundaries(client);
        },
      );
      await withClient(
        { ...adminConfig, user: "db00_read_only_login", password: runtimePassword },
        async (client) => {
          await assertReadOnlyRuntime(client);
          await assertDb01OpsBoundaries(client);
        },
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
  assert.equal(left.applied.length + right.applied.length, 5);
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
  assert.deepEqual(
    result.rows,
    definitions.map((definition) => ({
      version: definition.version,
      name: definition.name,
      sha256: definition.sha256,
      applied_by: "postgres",
      applied_role: "migration_owner",
      server_version_num: 160_014,
    })),
  );
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

async function assertIntentionalRoleEscalationDetected(client: pg.Client): Promise<void> {
  await client.query("GRANT migration_owner TO api_runtime");
  let detected = false;
  try {
    await assertFormalRoles(client);
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    detected = true;
  } finally {
    await client.query("REVOKE migration_owner FROM api_runtime");
  }
  assert.equal(detected, true, "the role gate must detect a runtime-to-owner membership");
  await assertFormalRoles(client);
  process.stdout.write("CI_METADATA intentional.role_escalation=blocked\n");
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

async function assertDb01Catalog(client: pg.Client): Promise<void> {
  const tables = await client.query<{
    readonly schemaname: string;
    readonly tablename: string;
    readonly tableowner: string;
  }>(`
    SELECT schemaname, tablename, tableowner
    FROM pg_catalog.pg_tables
    WHERE schemaname IN ('meta', 'authz')
    ORDER BY schemaname, tablename`);
  assert.deepEqual(tables.rows, [
    ...db01AuthzTables.map((tablename) => ({
      schemaname: "authz",
      tablename,
      tableowner: "migration_owner",
    })),
    ...db01MetaTables.map((tablename) => ({
      schemaname: "meta",
      tablename,
      tableowner: "migration_owner",
    })),
  ]);

  const requiredConstraints = [
    "package_installations_project_package_uq",
    "package_revisions_version_uq",
    "packages_api_name_tombstone_uq",
    "principals_external_identity_uq",
    "projects_api_name_key",
    "release_channels_pkey",
    "release_pins_order_uq",
    "release_pins_pkey",
    "release_serving_heads_pkey",
    "resource_revisions_digest_uq",
    "resources_api_name_tombstone_uq",
  ];
  const constraints = await client.query<{ readonly conname: string }>(
    `
    SELECT conname
    FROM pg_catalog.pg_constraint
    WHERE connamespace IN ('meta'::regnamespace, 'authz'::regnamespace)
      AND conname = ANY($1::text[])
    ORDER BY conname`,
    [requiredConstraints],
  );
  assert.deepEqual(
    constraints.rows.map(({ conname }) => conname),
    requiredConstraints,
  );

  const activeBindingIndexes = await client.query<{ readonly indexname: string }>(`
    SELECT indexname
    FROM pg_catalog.pg_indexes
    WHERE schemaname = 'authz'
      AND indexname IN ('role_bindings_active_project_uq', 'role_bindings_active_resource_uq')
    ORDER BY indexname`);
  assert.deepEqual(
    activeBindingIndexes.rows.map(({ indexname }) => indexname),
    ["role_bindings_active_project_uq", "role_bindings_active_resource_uq"],
  );
}

async function assertDb01PrivilegeMatrix(client: pg.Client): Promise<void> {
  for (const table of db01MetaTables) {
    const relation = `meta.${table}`;
    await assertTablePrivileges(client, "api_runtime", relation, {
      select: true,
      insert: true,
      update: false,
      delete: false,
      truncate: false,
    });
    for (const role of ["worker_runtime", "read_only_ops"] as const) {
      await assertTablePrivileges(client, role, relation, {
        select: true,
        insert: false,
        update: false,
        delete: false,
        truncate: false,
      });
    }
  }

  for (const table of db01AuthzTables) {
    const relation = `authz.${table}`;
    await assertTablePrivileges(client, "api_runtime", relation, {
      select: true,
      insert: true,
      update: false,
      delete: false,
      truncate: false,
    });
    await assertTablePrivileges(client, "worker_runtime", relation, {
      select: table === "authorization_epochs",
      insert: false,
      update: false,
      delete: false,
      truncate: false,
    });
    await assertTablePrivileges(client, "read_only_ops", relation, {
      select: false,
      insert: false,
      update: false,
      delete: false,
      truncate: false,
    });
  }

  const updateColumns = await client.query<{
    readonly table_schema: string;
    readonly table_name: string;
    readonly column_name: string;
  }>(`
    SELECT table_schema, table_name, column_name
    FROM information_schema.column_privileges
    WHERE grantee = 'api_runtime' AND privilege_type = 'UPDATE'
      AND table_schema IN ('meta', 'authz')
    ORDER BY table_schema, table_name, column_name`);
  assert.deepEqual(
    updateColumns.rows.map(
      ({ table_schema, table_name, column_name }) => `${table_schema}.${table_name}.${column_name}`,
    ),
    [
      "authz.authorization_epochs.changed_at",
      "authz.authorization_epochs.epoch",
      "authz.principals.changed_at",
      "authz.principals.disabled_at",
      "authz.principals.state",
      "authz.role_bindings.changed_at",
      "authz.role_bindings.revoked_at",
      "authz.role_bindings.state",
      "meta.package_installation_changes.changed_at",
      "meta.package_installation_changes.state",
      "meta.package_installations.active_package_revision_id",
      "meta.package_installations.active_release_id",
      "meta.package_installations.changed_at",
      "meta.package_installations.control_sequence",
      "meta.projects.changed_at",
      "meta.projects.display_name",
      "meta.projects.publication_sequence",
      "meta.projects.state",
      "meta.release_channels.activation_id",
      "meta.release_channels.changed_at",
      "meta.release_channels.control_sequence",
      "meta.release_channels.release_id",
      "meta.release_serving_heads.activation_id",
      "meta.release_serving_heads.changed_at",
      "meta.release_serving_heads.control_sequence",
      "meta.releases.changed_at",
      "meta.releases.published_at",
      "meta.releases.published_by_principal_id",
      "meta.releases.staged_at",
      "meta.releases.staged_channel_control_sequence",
      "meta.releases.staged_from_activation_id",
      "meta.releases.staged_from_release_id",
      "meta.releases.staged_validation_context_digest",
      "meta.releases.state",
      "meta.resource_revisions.changed_at",
      "meta.resource_revisions.content",
      "meta.resource_revisions.content_digest",
      "meta.resource_revisions.etag",
      "meta.resource_revisions.state",
      "meta.resources.changed_at",
      "meta.resources.state",
    ],
  );
}

async function assertTablePrivileges(
  client: pg.Client,
  role: string,
  relation: string,
  expected: {
    readonly select: boolean;
    readonly insert: boolean;
    readonly update: boolean;
    readonly delete: boolean;
    readonly truncate: boolean;
  },
): Promise<void> {
  const privileges = await client.query<{
    readonly select: boolean;
    readonly insert: boolean;
    readonly update: boolean;
    readonly delete: boolean;
    readonly truncate: boolean;
  }>(
    `
    SELECT pg_catalog.has_table_privilege($1, $2, 'SELECT') AS select,
           pg_catalog.has_table_privilege($1, $2, 'INSERT') AS insert,
           pg_catalog.has_table_privilege($1, $2, 'UPDATE') AS update,
           pg_catalog.has_table_privilege($1, $2, 'DELETE') AS delete,
           pg_catalog.has_table_privilege($1, $2, 'TRUNCATE') AS truncate`,
    [role, relation],
  );
  assert.deepEqual(privileges.rows[0], expected, `${role} on ${relation}`);
}

async function assertDb01ScopeBoundary(client: pg.Client): Promise<void> {
  const deferredTables = await client.query<{
    readonly schemaname: string;
    readonly tablename: string;
  }>(`
    SELECT schemaname, tablename
    FROM pg_catalog.pg_tables
    WHERE schemaname IN ('runtime', 'action', 'ops', 'audit')
    ORDER BY schemaname, tablename`);
  assert.deepEqual(deferredTables.rows, []);
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
  const directory = await mkdtemp(resolve(tmpdir(), "ontos-db01-forward-repair-"));
  const firstMigration = resolve(directory, "0001_foundation.sql");
  const secondMigration = resolve(directory, "0002_metadata_control_plane.sql");
  const thirdMigration = resolve(directory, "0003_resource_revision_guards.sql");
  const fourthMigration = resolve(directory, "0004_dependency_validation_guards.sql");
  const fifthMigration = resolve(directory, "0005_release_lifecycle_guards.sql");
  const failedMigration = resolve(directory, "0006_failed_attempt.sql");
  const defectMigration = resolve(directory, "0006_forward_repair_probe.sql");
  const repairMigration = resolve(directory, "0007_forward_repair.sql");

  try {
    await copyFile(resolve(db00MigrationDirectory, "0001_foundation.sql"), firstMigration);
    await copyFile(
      resolve(db00MigrationDirectory, "0002_metadata_control_plane.sql"),
      secondMigration,
    );
    await copyFile(
      resolve(db00MigrationDirectory, "0003_resource_revision_guards.sql"),
      thirdMigration,
    );
    await copyFile(
      resolve(db00MigrationDirectory, "0004_dependency_validation_guards.sql"),
      fourthMigration,
    );
    await copyFile(
      resolve(db00MigrationDirectory, "0005_release_lifecycle_guards.sql"),
      fifthMigration,
    );
    await writeFile(
      failedMigration,
      `CREATE TABLE ops.db01_forward_repair_probe (
         id bigint PRIMARY KEY,
         value text
       );
       SELECT 1 / 0;\n`,
    );

    await assertStableMigrationError(
      runDatabaseMigrations(client, { directory }),
      "DB_MIGRATION_EXECUTION_FAILED",
    );
    await assertProbeAndLedgerState(client, false, 5);

    await rm(failedMigration);
    await writeFile(
      defectMigration,
      `CREATE TABLE ops.db01_forward_repair_probe (
         id bigint PRIMARY KEY,
         value text
       );
       INSERT INTO ops.db01_forward_repair_probe (id, value) VALUES (1, NULL);\n`,
    );
    const defectRun = await runDatabaseMigrations(client, { directory });
    assert.deepEqual(
      defectRun.applied.map(({ version }) => version),
      [6],
    );

    await writeFile(
      repairMigration,
      `UPDATE ops.db01_forward_repair_probe
       SET value = 'repaired'
       WHERE value IS NULL;
       ALTER TABLE ops.db01_forward_repair_probe
       ALTER COLUMN value SET NOT NULL;\n`,
    );
    const repairRun = await runDatabaseMigrations(client, { directory });
    assert.deepEqual(
      repairRun.applied.map(({ version }) => version),
      [7],
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
      FROM ops.db01_forward_repair_probe AS probe
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = 'ops.db01_forward_repair_probe'::regclass
       AND attribute.attname = 'value'
      WHERE probe.id = 1`);
    assert.deepEqual(repaired.rows[0], { value: "repaired", is_not_null: true });

    await writeFile(
      defectMigration,
      `CREATE TABLE ops.db01_forward_repair_probe (id bigint PRIMARY KEY, value text);\n`,
    );
    await assertStableMigrationError(
      runDatabaseMigrations(client, { directory }),
      "DB_MIGRATION_HISTORY_DIVERGED",
    );
    await assertProbeAndLedgerState(client, true, 7);
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
    SELECT pg_catalog.to_regclass('ops.db01_forward_repair_probe') IS NOT NULL AS probe_exists,
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

async function assertDb01ApiWritesAndConstraints(client: pg.Client): Promise<void> {
  await assertQueryError(
    client,
    `INSERT INTO meta.projects
       (project_id, api_name, display_name, state)
     VALUES ($1, 'ForbiddenInitialState', 'Forbidden initial state', 'archived')`,
    [db01Ids.duplicateProject],
    "55000",
  );

  await client.query(
    `INSERT INTO authz.principals
       (principal_id, oidc_issuer, oidc_subject, display_name)
     VALUES ($1, 'https://issuer.example.test', 'subject-1', 'DB-01 Principal')`,
    [db01Ids.principal],
  );
  await client.query(
    `INSERT INTO meta.projects (project_id, api_name, display_name)
     VALUES ($1, 'CoreProject', 'Core Project')`,
    [db01Ids.project],
  );
  await client.query(
    `INSERT INTO meta.resources
       (resource_id, project_id, namespace, api_name, family)
     VALUES ($1, $2, 'commerce.core', 'Order', 'object_type')`,
    [db01Ids.resource, db01Ids.project],
  );
  await client.query(
    `INSERT INTO meta.resource_revisions
       (revision_id, resource_id, revision_number, family, content_digest, content,
        created_by_principal_id)
     VALUES ($1, $2, 1, 'object_type', $3, '{"schemaVersion":1}'::jsonb, $4)`,
    [db01Ids.revision, db01Ids.resource, db01Digests.revision, db01Ids.principal],
  );
  await client.query(
    `INSERT INTO meta.validation_reports
       (report_id, subject_type, subject_id, resource_revision_id, subject_digest,
        validation_context_digest, validator_version, valid, issues)
     VALUES ($1, 'resource_revision', $2, $2, $3, $3, 'metadata-g2-01-v1', TRUE, '[]'::jsonb)`,
    [db01Ids.validationReport, db01Ids.revision, db01Digests.revision],
  );
  await client.query(
    `UPDATE meta.resource_revisions
     SET state = 'validated', changed_at = clock_timestamp()
     WHERE revision_id = $1`,
    [db01Ids.revision],
  );
  await client.query(
    `UPDATE meta.resource_revisions
     SET state = 'published', changed_at = clock_timestamp()
     WHERE revision_id = $1`,
    [db01Ids.revision],
  );

  await client.query(
    `INSERT INTO meta.releases
       (release_id, project_id, release_number, manifest_digest, target_channel_name,
        created_by_principal_id)
     VALUES ($1, $2, 1, $3, 'production', $4)`,
    [db01Ids.release, db01Ids.project, db01Digests.release, db01Ids.principal],
  );
  await client.query(
    `INSERT INTO meta.release_pins
       (release_id, resource_id, revision_id, pin_order, family, content_digest)
     VALUES ($1, $2, $3, 0, 'object_type', $4)`,
    [db01Ids.release, db01Ids.resource, db01Ids.revision, db01Digests.revision],
  );
  await assertQueryError(
    client,
    `INSERT INTO meta.release_pins
       (release_id, resource_id, revision_id, pin_order, family, content_digest)
     VALUES ($1, $2, $3, 0, 'object_type', $4)`,
    [db01Ids.release, db01Ids.resource, db01Ids.revision, db01Digests.revision],
    "23505",
  );
  await client.query(
    `INSERT INTO meta.validation_reports
       (report_id, subject_type, subject_id, release_id, subject_digest,
        validation_context_digest, validator_version, valid, issues)
     VALUES ('00000000-0000-4000-8000-000000000304', 'release', $1, $1, $2,
             $3, 'metadata-release-g2-01-v1', TRUE, '[]'::jsonb)`,
    [db01Ids.release, db01Digests.release, db01Digests.other],
  );
  await client.query(
    `UPDATE meta.releases
     SET state = 'staging',
         staged_channel_control_sequence = 0,
         staged_validation_context_digest = $2,
         staged_at = clock_timestamp(),
         changed_at = clock_timestamp()
     WHERE release_id = $1`,
    [db01Ids.release, db01Digests.other],
  );
  await assertQueryError(
    client,
    `INSERT INTO meta.release_pins
       (release_id, resource_id, revision_id, pin_order, family, content_digest)
     VALUES ($1, $2, $3, 1, 'object_type', $4)`,
    [db01Ids.release, db01Ids.resource, db01Ids.revision, db01Digests.revision],
    "55000",
  );
  await client.query(
    `UPDATE meta.releases SET state = 'ready', changed_at = clock_timestamp()
     WHERE release_id = $1`,
    [db01Ids.release],
  );
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO meta.runtime_activations
       (activation_id, release_id, activation_digest)
     VALUES ($1, $2, $3)`,
    [db01Ids.activation, db01Ids.release, db01Digests.activation],
  );
  await client.query(
    `UPDATE meta.releases
     SET state = 'published', published_by_principal_id = $2,
         published_at = clock_timestamp(), changed_at = clock_timestamp()
     WHERE release_id = $1`,
    [db01Ids.release, db01Ids.principal],
  );
  await client.query(
    `INSERT INTO meta.release_serving_heads
       (release_id, activation_id, control_sequence)
     VALUES ($1, $2, 1)`,
    [db01Ids.release, db01Ids.activation],
  );
  await client.query(
    `INSERT INTO meta.release_channels
       (project_id, channel_name, release_id, activation_id, control_sequence)
     VALUES ($1, 'production', $2, $3, 1)`,
    [db01Ids.project, db01Ids.release, db01Ids.activation],
  );
  await client.query("COMMIT");

  await client.query(
    `INSERT INTO meta.packages
       (package_id, namespace, api_name, created_by_principal_id)
     VALUES ($1, 'commerce.packages', 'CommerceCore', $2)`,
    [db01Ids.package, db01Ids.principal],
  );
  await client.query(
    `INSERT INTO meta.package_revisions
       (package_revision_id, package_id, version, manifest_digest, manifest,
        created_by_principal_id)
     VALUES ($1, $2, '1.0.0', $3, '{"schemaVersion":1}'::jsonb, $4)`,
    [db01Ids.packageRevision, db01Ids.package, db01Digests.package, db01Ids.principal],
  );
  await client.query(
    `INSERT INTO meta.package_installations
       (installation_id, project_id, package_id)
     VALUES ($1, $2, $3)`,
    [db01Ids.installation, db01Ids.project, db01Ids.package],
  );
  await client.query(
    `INSERT INTO meta.package_installation_changes
       (change_id, installation_id, project_id, package_id, request_key,
        target_package_revision_id, target_release_id)
     VALUES ($1, $2, $3, $4, 'db01-package-request-0001', $5, $6)`,
    [
      db01Ids.change,
      db01Ids.installation,
      db01Ids.project,
      db01Ids.package,
      db01Ids.packageRevision,
      db01Ids.release,
    ],
  );
  await client.query(
    `UPDATE meta.package_installation_changes
     SET state = 'active', changed_at = clock_timestamp()
     WHERE change_id = $1`,
    [db01Ids.change],
  );
  await client.query(
    `UPDATE meta.package_installations
     SET active_package_revision_id = $2, active_release_id = $3,
         control_sequence = control_sequence + 1, changed_at = clock_timestamp()
     WHERE installation_id = $1`,
    [db01Ids.installation, db01Ids.packageRevision, db01Ids.release],
  );
  await client.query(
    `INSERT INTO meta.artifact_references
       (artifact_reference_id, digest, media_type, source_kind, source_id)
     VALUES ($1, $2, 'application/json', 'package_revision', $3)`,
    [db01Ids.artifactReference, db01Digests.artifact, db01Ids.packageRevision],
  );
  await client.query(
    `INSERT INTO authz.role_bindings
       (binding_id, project_id, principal_id, scope, role)
     VALUES ($1, $2, $3, 'project', 'owner')`,
    [db01Ids.binding, db01Ids.project, db01Ids.principal],
  );
  await client.query(`INSERT INTO authz.authorization_epochs (project_id) VALUES ($1)`, [
    db01Ids.project,
  ]);

  await assertDb01Uniqueness(client);
  await assertDb01PublishedFactsImmutable(client);

  const activePointers = await client.query<{
    readonly active_package_revision_id: string;
    readonly active_release_id: string;
    readonly control_sequence: string;
  }>(
    `
    SELECT active_package_revision_id, active_release_id, control_sequence
    FROM meta.package_installations
    WHERE installation_id = $1`,
    [db01Ids.installation],
  );
  assert.deepEqual(activePointers.rows[0], {
    active_package_revision_id: db01Ids.packageRevision,
    active_release_id: db01Ids.release,
    control_sequence: "1",
  });
}

async function assertDb01Uniqueness(client: pg.Client): Promise<void> {
  await assertQueryError(
    client,
    `INSERT INTO authz.principals
       (principal_id, oidc_issuer, oidc_subject, display_name)
     VALUES ($1, 'https://issuer.example.test', 'subject-1', 'Duplicate')`,
    [db01Ids.duplicatePrincipal],
    "23505",
  );
  await assertQueryError(
    client,
    `INSERT INTO meta.projects (project_id, api_name, display_name)
     VALUES ($1, 'CoreProject', 'Duplicate')`,
    [db01Ids.duplicateProject],
    "23505",
  );
  await assertQueryError(
    client,
    `INSERT INTO meta.resources
       (resource_id, project_id, namespace, api_name, family)
     VALUES ($1, $2, 'commerce.core', 'Order', 'object_type')`,
    [db01Ids.duplicateResource, db01Ids.project],
    "23505",
  );
  await assertQueryError(
    client,
    `INSERT INTO meta.resource_revisions
       (revision_id, resource_id, parent_revision_id, revision_number, family,
        content_digest, content, created_by_principal_id)
     VALUES ($1, $2, $5, 2, 'object_type', $3, '{}'::jsonb, $4)`,
    [
      db01Ids.duplicateRevision,
      db01Ids.resource,
      db01Digests.revision,
      db01Ids.principal,
      db01Ids.revision,
    ],
    "23505",
  );
  await assertQueryError(
    client,
    `INSERT INTO meta.package_revisions
       (package_revision_id, package_id, version, manifest_digest, manifest,
        created_by_principal_id)
     VALUES ($1, $2, '1.0.0', $3, '{}'::jsonb, $4)`,
    [db01Ids.duplicatePackageRevision, db01Ids.package, db01Digests.other, db01Ids.principal],
    "23505",
  );
  await assertQueryError(
    client,
    `INSERT INTO meta.release_channels
       (project_id, channel_name, release_id, activation_id, control_sequence)
     VALUES ($1, 'production', $2, $3, 1)`,
    [db01Ids.project, db01Ids.release, db01Ids.activation],
    "23505",
  );
  await assertQueryError(
    client,
    `INSERT INTO meta.release_serving_heads
       (release_id, activation_id, control_sequence)
     VALUES ($1, $2, 1)`,
    [db01Ids.release, db01Ids.activation],
    "23505",
  );
  await assertQueryError(
    client,
    `INSERT INTO authz.role_bindings
       (binding_id, project_id, principal_id, scope, role)
     VALUES ('00000000-0000-4000-8000-000000001102', $1, $2, 'project', 'viewer')`,
    [db01Ids.project, db01Ids.principal],
    "23505",
  );
}

async function assertDb01PublishedFactsImmutable(client: pg.Client): Promise<void> {
  await assertQueryError(
    client,
    `INSERT INTO meta.resource_dependencies
       (dependency_id, source_revision_id, target_revision_id, dependency_type, source_path)
     VALUES ('00000000-0000-4000-8000-000000001201', $1,
             '00000000-0000-4000-8000-000000001202', 'property_reference', '/properties/0')`,
    [db01Ids.revision],
    "55000",
  );
  await assertQueryError(
    client,
    `UPDATE meta.resource_revisions
     SET content = '{"mutated":true}'::jsonb, content_digest = $2,
         etag = etag + 1, changed_at = clock_timestamp()
     WHERE revision_id = $1`,
    [db01Ids.revision, db01Digests.other],
    "55000",
  );
  await assertQueryError(
    client,
    "DELETE FROM meta.resource_revisions WHERE revision_id = $1",
    [db01Ids.revision],
    "42501",
  );
  await assertQueryError(client, "TRUNCATE meta.resource_revisions", [], "42501");

  await assertQueryError(
    client,
    `UPDATE meta.releases
     SET published_at = published_at + interval '1 second', changed_at = clock_timestamp()
     WHERE release_id = $1`,
    [db01Ids.release],
    "55000",
  );
  await assertQueryError(
    client,
    "DELETE FROM meta.releases WHERE release_id = $1",
    [db01Ids.release],
    "42501",
  );
  await assertQueryError(client, "TRUNCATE meta.releases", [], "42501");

  await assertQueryError(
    client,
    "UPDATE meta.package_revisions SET manifest = '{}'::jsonb WHERE package_revision_id = $1",
    [db01Ids.packageRevision],
    "42501",
  );
  await assertQueryError(
    client,
    "DELETE FROM meta.package_revisions WHERE package_revision_id = $1",
    [db01Ids.packageRevision],
    "42501",
  );
  await assertQueryError(client, "TRUNCATE meta.package_revisions", [], "42501");
}

async function assertDb01WorkerBoundaries(client: pg.Client): Promise<void> {
  await client.query("SELECT release_id FROM meta.releases WHERE release_id = $1", [
    db01Ids.release,
  ]);
  await client.query("SELECT epoch FROM authz.authorization_epochs WHERE project_id = $1", [
    db01Ids.project,
  ]);
  await assertQueryError(
    client,
    `INSERT INTO meta.projects (project_id, api_name, display_name)
     VALUES ($1, 'WorkerDenied', 'Worker denied')`,
    [db01Ids.duplicateProject],
    "42501",
  );
  await assertQueryError(
    client,
    "UPDATE meta.resources SET state = 'archived' WHERE resource_id = $1",
    [db01Ids.resource],
    "42501",
  );
  await assertQueryError(client, "SELECT * FROM authz.principals", [], "42501");
}

async function assertDb01OpsBoundaries(client: pg.Client): Promise<void> {
  await client.query("SELECT release_id FROM meta.releases WHERE release_id = $1", [
    db01Ids.release,
  ]);
  await assertQueryError(
    client,
    "UPDATE meta.projects SET display_name = 'Denied' WHERE project_id = $1",
    [db01Ids.project],
    "42501",
  );
  await assertQueryError(client, "SELECT * FROM authz.authorization_epochs", [], "42501");
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

async function assertQueryError(
  client: pg.Client,
  sql: string,
  values: readonly unknown[],
  code: string,
): Promise<void> {
  await assert.rejects(
    client.query(sql, [...values]),
    (error: unknown) => isPostgreSqlError(error) && error.code === code,
    `${code}: ${sql}`,
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
