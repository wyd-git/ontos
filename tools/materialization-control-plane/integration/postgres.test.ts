import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import pg from "pg";

import { databaseMigrationDirectory, runDatabaseMigrations } from "../../database/migrator.ts";
import { resolvePostgresTestImage } from "../../database/postgres-test-image.ts";
import { compileReleaseIndexPlan } from "../../projection-capacity/index-plan.ts";
import {
  executeProjectionDdlPlan,
  projectionDdlPlanDigest,
  ProjectionDdlError,
  type ProjectionDdlAction,
  type ProjectionDdlPlanImmutable,
} from "../projection-ddl.ts";

const execFileAsync = promisify(execFile);
const postgresImage = resolvePostgresTestImage();
const database = "ontos_g20201";
const adminPassword = "local-only-g20201-admin-secret";
const runtimePassword = "local-only-g20201-runtime-secret";
const ddlPassword = "local-only-g20201-ddl-secret";
const projectId = "00000000-0000-4000-8000-000000000101";
const resourceId = "00000000-0000-4000-8000-000000000201";
const revisionId = "00000000-0000-4000-8000-000000000301";
const cliPath = fileURLToPath(new URL("../projection-ddl-cli.ts", import.meta.url));

void test(
  "G2-02-01 trusted Projection DDL Executor survives PostgreSQL 16 adversarial cases",
  { timeout: 180_000 },
  async () => {
    const containerName = `ontos-g20201-${process.pid}-${randomUUID().slice(0, 8)}`;
    const spikeMigrationDirectory = await migrationPrefixDirectory(6);
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
      "--tmpfs",
      "/var/lib/postgresql/data:rw,noexec,nosuid,size=1g",
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
        application_name: "ontos-g2-02-01-admin",
      };
      const ddlConfig: pg.ClientConfig = {
        ...adminConfig,
        user: "g20201_ddl_login",
        password: ddlPassword,
        application_name: "ontos-g2-02-01-ddl-test",
      };
      await waitForPostgreSql(adminConfig);
      await withClient(adminConfig, async (admin) => {
        await runDatabaseMigrations(admin, { directory: spikeMigrationDirectory });
        await createSpikeFixture(admin);
        await assertExecutorRoleAndOwnership(admin);
      });

      await assertRuntimeRoleBoundaries(adminConfig);

      await withClient(adminConfig, async (admin) => {
        const createPlan = buildPlan({
          requestId: "00000000-0000-4000-8000-000000000401",
          action: "CREATE",
          referenceCount: 1,
        });
        await insertPlan(admin, createPlan);

        const created = await withClient(ddlConfig, (client) =>
          executeProjectionDdlPlan(client, createPlan.requestId),
        );
        assert.equal(created.outcome, "CREATED");
        assert.match(created.catalogDigest, /^sha256:[0-9a-f]{64}$/u);
        await assertIndexExists(admin, createPlan.indexName, createPlan.physicalSignature);

        const replayed = await withClient(ddlConfig, (client) =>
          executeProjectionDdlPlan(client, createPlan.requestId),
        );
        assert.equal(replayed.outcome, "REUSED");
        assert.equal(replayed.attemptCount, 2);

        await exerciseDefinitionMismatch(admin, ddlConfig);
        await exerciseStalePlan(admin, ddlConfig);
        await exerciseTamperedPlanDigest(admin, ddlConfig);
        await exerciseDropAndReferenceGuard(admin, ddlConfig, createPlan);
        await exerciseKilledExecutor(admin, adminConfig, ddlConfig);

        const statuses = await admin.query<{
          readonly state: string;
          readonly last_result_code: string | null;
        }>(
          `SELECT state, last_result_code
           FROM ops.projection_ddl_requests
           ORDER BY request_id`,
        );
        assert.equal(
          statuses.rows.some((row) => row.state === "RUNNING"),
          false,
        );
        assert.equal(
          statuses.rows.some((row) => row.last_result_code === "DDL_PLAN_STALE"),
          true,
        );
        assert.equal(
          statuses.rows.some((row) => row.last_result_code === "DDL_INDEX_DEFINITION_MISMATCH"),
          true,
        );
      });
    } finally {
      await rm(spikeMigrationDirectory, { recursive: true, force: true });
      await docker(["rm", "--force", "--volumes", containerName], true);
    }
  },
);

async function migrationPrefixDirectory(through: number): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), `ontos-g20201-migrations-`));
  for (const file of (await readdir(databaseMigrationDirectory)).sort()) {
    const version = Number(file.slice(0, 4));
    if (Number.isInteger(version) && version <= through && file.endsWith(".sql")) {
      await copyFile(resolve(databaseMigrationDirectory, file), resolve(directory, file));
    }
  }
  return directory;
}

async function createSpikeFixture(admin: pg.Client): Promise<void> {
  await admin.query(`
    CREATE ROLE g20201_api_login LOGIN PASSWORD '${runtimePassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
    CREATE ROLE g20201_worker_login LOGIN PASSWORD '${runtimePassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
    CREATE ROLE g20201_ops_login LOGIN PASSWORD '${runtimePassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
    CREATE ROLE g20201_ddl_login LOGIN PASSWORD '${ddlPassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    GRANT api_runtime TO g20201_api_login;
    GRANT worker_runtime TO g20201_worker_login;
    GRANT read_only_ops TO g20201_ops_login;
    GRANT migration_owner TO g20201_ddl_login;
    GRANT CONNECT ON DATABASE ${database} TO g20201_ddl_login;
    GRANT USAGE ON SCHEMA runtime, ops TO g20201_ddl_login;

    SET ROLE migration_owner;
    CREATE TABLE runtime.project_runtime_inventories (
      project_id uuid PRIMARY KEY,
      inventory_revision bigint NOT NULL CHECK (inventory_revision >= 0)
    );
    CREATE TABLE runtime.object_current (
      project_id uuid NOT NULL,
      generation_id uuid NOT NULL,
      object_type_resource_id uuid NOT NULL,
      object_type_revision_id uuid NOT NULL,
      object_rid uuid NOT NULL,
      canonical_primary_key text NOT NULL,
      properties jsonb NOT NULL,
      lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('active', 'inactive')),
      PRIMARY KEY (project_id, generation_id, object_type_resource_id, object_rid)
    );
    CREATE TABLE ops.projection_ddl_requests (
      request_id uuid PRIMARY KEY,
      project_id uuid NOT NULL,
      action text NOT NULL CHECK (action IN ('CREATE', 'DROP')),
      state text NOT NULL CHECK (state IN ('APPROVED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
      inventory_revision bigint NOT NULL CHECK (inventory_revision >= 0),
      plan_digest text NOT NULL CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
      index_name text NOT NULL CHECK (octet_length(index_name) <= 63),
      target_table text NOT NULL,
      recipe text NOT NULL,
      property_key text NOT NULL,
      object_type_resource_id uuid NOT NULL,
      object_type_revision_id uuid NOT NULL,
      physical_signature text NOT NULL CHECK (physical_signature ~ '^[0-9a-f]{64}$'),
      reference_count integer NOT NULL CHECK (reference_count >= 0),
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_result_code text,
      catalog_digest text,
      started_at timestamptz,
      finished_at timestamptz
    );
    CREATE VIEW ops.projection_ddl_request_statuses AS
      SELECT request_id, project_id, action, state, attempt_count,
             last_result_code, started_at, finished_at
      FROM ops.projection_ddl_requests;
    INSERT INTO runtime.project_runtime_inventories (project_id, inventory_revision)
    VALUES ('${projectId}', 7);
    INSERT INTO runtime.object_current
      (project_id, generation_id, object_type_resource_id, object_type_revision_id,
       object_rid, canonical_primary_key, properties, lifecycle_state)
    VALUES
      ('${projectId}', '00000000-0000-4000-8000-000000000501', '${resourceId}', '${revisionId}',
       '00000000-0000-4000-8000-000000000601', 'order-1', '{"status":"open"}', 'active'),
      ('${projectId}', '00000000-0000-4000-8000-000000000501', '${resourceId}', '${revisionId}',
       '00000000-0000-4000-8000-000000000602', 'order-2', '{"status":"closed"}', 'active');
    REVOKE ALL ON runtime.project_runtime_inventories, runtime.object_current,
                  ops.projection_ddl_requests FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
    GRANT SELECT ON ops.projection_ddl_request_statuses
      TO api_runtime, worker_runtime, read_only_ops;
    GRANT SELECT ON runtime.project_runtime_inventories, ops.projection_ddl_requests
      TO g20201_ddl_login;
    GRANT UPDATE (state, attempt_count, last_result_code, catalog_digest, started_at, finished_at)
      ON ops.projection_ddl_requests TO g20201_ddl_login;
    RESET ROLE;
  `);
}

async function assertRuntimeRoleBoundaries(adminConfig: pg.ClientConfig): Promise<void> {
  const logins = ["g20201_api_login", "g20201_worker_login", "g20201_ops_login"] as const;
  for (const login of logins) {
    await withClient(
      { ...adminConfig, user: login, password: runtimePassword, application_name: login },
      async (client) => {
        const status = await client.query<{ readonly count: number }>(
          "SELECT count(*)::integer FROM ops.projection_ddl_request_statuses",
        );
        assert.equal(status.rows[0]?.count, 0);
        await assert.rejects(client.query("SELECT * FROM ops.projection_ddl_requests"));
        await assert.rejects(
          client.query(
            `INSERT INTO ops.projection_ddl_requests
             (request_id, project_id, action, state, inventory_revision, plan_digest,
              index_name, target_table, recipe, property_key, object_type_resource_id,
              object_type_revision_id, physical_signature, reference_count)
             VALUES (gen_random_uuid(), gen_random_uuid(), 'CREATE', 'APPROVED', 0,
                     'sha256:${"0".repeat(64)}', 'raw_sql', 'runtime.object_current',
                     'RAW_SQL', 'x', gen_random_uuid(), gen_random_uuid(), '${"0".repeat(64)}', 0)`,
          ),
        );
        await assert.rejects(
          client.query(
            `CREATE INDEX g20201_forbidden_${login} ON runtime.object_current (project_id)`,
          ),
        );
        await assert.rejects(client.query("SET ROLE migration_owner"));
        const identity = await client.query<{ readonly current_user: string }>(
          "SELECT current_user",
        );
        assert.equal(identity.rows[0]?.current_user, login);
      },
    );
  }
}

async function assertExecutorRoleAndOwnership(admin: pg.Client): Promise<void> {
  const role = await admin.query<{
    readonly rolcanlogin: boolean;
    readonly rolsuper: boolean;
    readonly rolcreatedb: boolean;
    readonly rolcreaterole: boolean;
    readonly rolinherit: boolean;
    readonly rolreplication: boolean;
    readonly rolbypassrls: boolean;
    readonly owner_member: boolean;
  }>(`
    SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
           rolreplication, rolbypassrls,
           pg_catalog.pg_has_role('g20201_ddl_login', 'migration_owner', 'MEMBER') AS owner_member
    FROM pg_catalog.pg_roles
    WHERE rolname = 'g20201_ddl_login'`);
  assert.deepEqual(role.rows[0], {
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolinherit: false,
    rolreplication: false,
    rolbypassrls: false,
    owner_member: true,
  });

  const owners = await admin.query<{ readonly qualified_name: string; readonly owner: string }>(`
    SELECT namespace.nspname || '.' || class.relname AS qualified_name,
           pg_catalog.pg_get_userbyid(class.relowner) AS owner
    FROM pg_catalog.pg_class AS class
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
    WHERE (namespace.nspname, class.relname) IN (
      ('runtime', 'project_runtime_inventories'),
      ('runtime', 'object_current'),
      ('ops', 'projection_ddl_requests'),
      ('ops', 'projection_ddl_request_statuses')
    )
    ORDER BY qualified_name`);
  assert.equal(owners.rows.length, 4);
  assert.equal(
    owners.rows.every((row) => row.owner === "migration_owner"),
    true,
  );
}

async function exerciseDefinitionMismatch(
  admin: pg.Client,
  ddlConfig: pg.ClientConfig,
): Promise<void> {
  const plan = buildPlan({
    requestId: "00000000-0000-4000-8000-000000000402",
    action: "CREATE",
    referenceCount: 1,
    objectTypeResourceId: "00000000-0000-4000-8000-000000000202",
    objectTypeRevisionId: "00000000-0000-4000-8000-000000000302",
  });
  await admin.query(
    `SET ROLE migration_owner;
     CREATE INDEX ${plan.indexName} ON runtime.object_current (canonical_primary_key);
     RESET ROLE;`,
  );
  await insertPlan(admin, plan);
  await assert.rejects(
    withClient(ddlConfig, (client) => executeProjectionDdlPlan(client, plan.requestId)),
    ddlError("DDL_INDEX_DEFINITION_MISMATCH"),
  );
  const preserved = await admin.query<{ readonly exists: boolean }>(
    "SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists",
    [`runtime.${plan.indexName}`],
  );
  assert.equal(preserved.rows[0]?.exists, true);
  await admin.query(`SET ROLE migration_owner; DROP INDEX runtime.${plan.indexName}; RESET ROLE;`);
}

async function exerciseStalePlan(admin: pg.Client, ddlConfig: pg.ClientConfig): Promise<void> {
  const plan = buildPlan({
    requestId: "00000000-0000-4000-8000-000000000403",
    action: "CREATE",
    referenceCount: 1,
    inventoryRevision: "6",
    objectTypeResourceId: "00000000-0000-4000-8000-000000000203",
    objectTypeRevisionId: "00000000-0000-4000-8000-000000000303",
  });
  await insertPlan(admin, plan);
  await assert.rejects(
    withClient(ddlConfig, (client) => executeProjectionDdlPlan(client, plan.requestId)),
    ddlError("DDL_PLAN_STALE"),
  );
  const absent = await admin.query<{ readonly exists: boolean }>(
    "SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists",
    [`runtime.${plan.indexName}`],
  );
  assert.equal(absent.rows[0]?.exists, false);
}

async function exerciseTamperedPlanDigest(
  admin: pg.Client,
  ddlConfig: pg.ClientConfig,
): Promise<void> {
  const plan = buildPlan({
    requestId: "00000000-0000-4000-8000-000000000408",
    action: "CREATE",
    referenceCount: 1,
    objectTypeResourceId: "00000000-0000-4000-8000-000000000208",
    objectTypeRevisionId: "00000000-0000-4000-8000-000000000308",
  });
  await insertPlan(admin, plan);
  await admin.query(
    "UPDATE ops.projection_ddl_requests SET plan_digest = $2 WHERE request_id = $1::uuid",
    [plan.requestId, `sha256:${"f".repeat(64)}`],
  );
  await assert.rejects(
    withClient(ddlConfig, (client) => executeProjectionDdlPlan(client, plan.requestId)),
    ddlError("DDL_PLAN_DIGEST_MISMATCH"),
  );
  const failed = await admin.query<{ readonly state: string; readonly last_result_code: string }>(
    `SELECT state, last_result_code
     FROM ops.projection_ddl_requests
     WHERE request_id = $1::uuid`,
    [plan.requestId],
  );
  assert.deepEqual(failed.rows[0], {
    state: "FAILED",
    last_result_code: "DDL_PLAN_DIGEST_MISMATCH",
  });
}

async function exerciseDropAndReferenceGuard(
  admin: pg.Client,
  ddlConfig: pg.ClientConfig,
  originalCreate: ProjectionDdlPlanImmutable,
): Promise<void> {
  const dropPlan: ProjectionDdlPlanImmutable = {
    ...originalCreate,
    requestId: "00000000-0000-4000-8000-000000000404",
    action: "DROP",
    referenceCount: 0,
  };
  await insertPlan(admin, dropPlan);
  const dropped = await withClient(ddlConfig, (client) =>
    executeProjectionDdlPlan(client, dropPlan.requestId),
  );
  assert.equal(dropped.outcome, "DROPPED");
  const repeated = await withClient(ddlConfig, (client) =>
    executeProjectionDdlPlan(client, dropPlan.requestId),
  );
  assert.equal(repeated.outcome, "ABSENT");

  const recreatePlan: ProjectionDdlPlanImmutable = {
    ...originalCreate,
    requestId: "00000000-0000-4000-8000-000000000405",
  };
  await insertPlan(admin, recreatePlan);
  assert.equal(
    (
      await withClient(ddlConfig, (client) =>
        executeProjectionDdlPlan(client, recreatePlan.requestId),
      )
    ).outcome,
    "CREATED",
  );

  const referencedDrop: ProjectionDdlPlanImmutable = {
    ...originalCreate,
    requestId: "00000000-0000-4000-8000-000000000406",
    action: "DROP",
    referenceCount: 1,
  };
  await insertPlan(admin, referencedDrop);
  await assert.rejects(
    withClient(ddlConfig, (client) => executeProjectionDdlPlan(client, referencedDrop.requestId)),
    ddlError("DDL_INDEX_REFERENCED"),
  );
  await assertIndexExists(admin, originalCreate.indexName, originalCreate.physicalSignature);
}

async function exerciseKilledExecutor(
  admin: pg.Client,
  adminConfig: pg.ClientConfig,
  ddlConfig: pg.ClientConfig,
): Promise<void> {
  const plan = buildPlan({
    requestId: "00000000-0000-4000-8000-000000000407",
    action: "CREATE",
    referenceCount: 1,
    objectTypeResourceId: "00000000-0000-4000-8000-000000000207",
    objectTypeRevisionId: "00000000-0000-4000-8000-000000000307",
  });
  await insertPlan(admin, plan);

  const blocker = new pg.Client({ ...adminConfig, application_name: "ontos-g20201-blocker" });
  await blocker.connect();
  await blocker.query("BEGIN");
  await blocker.query("SET LOCAL ROLE migration_owner");
  await blocker.query("LOCK TABLE runtime.object_current IN ACCESS EXCLUSIVE MODE");

  const databaseUrl = postgresUrl(ddlConfig);
  const child = spawn(process.execPath, [cliPath, "--plan-id", plan.requestId], {
    env: { ...process.env, ONTOS_PROJECTION_DDL_DATABASE_URL: databaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectChildOutput(child);
  try {
    await waitUntil(async () => {
      const state = await admin.query<{ readonly state: string }>(
        "SELECT state FROM ops.projection_ddl_requests WHERE request_id = $1::uuid",
        [plan.requestId],
      );
      const activity = await admin.query<{ readonly blocked: boolean }>(`
        SELECT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_stat_activity
          WHERE application_name = 'ontos-projection-ddl-executor'
            AND query ILIKE 'CREATE INDEX CONCURRENTLY%'
            AND wait_event_type = 'Lock'
        ) AS blocked`);
      return state.rows[0]?.state === "RUNNING" && activity.rows[0]?.blocked === true;
    });
    assert.equal(child.kill("SIGKILL"), true);
    await waitForChildClose(child);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    await blocker.end().catch(() => undefined);
  }
  const captured = await output;
  assert.equal(captured.stdout.includes(ddlPassword), false);
  assert.equal(captured.stderr.includes(ddlPassword), false);
  assert.equal(captured.stdout.includes(databaseUrl), false);
  assert.equal(captured.stderr.includes(databaseUrl), false);

  await waitUntil(async () => {
    const activity = await admin.query<{ readonly active: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_stat_activity
        WHERE application_name = 'ontos-projection-ddl-executor'
      ) AS active`);
    return activity.rows[0]?.active === false;
  });
  const interrupted = await admin.query<{ readonly state: string; readonly attempt_count: number }>(
    `SELECT state, attempt_count
     FROM ops.projection_ddl_requests
     WHERE request_id = $1::uuid`,
    [plan.requestId],
  );
  assert.deepEqual(interrupted.rows[0], { state: "RUNNING", attempt_count: 1 });

  const recovered = await withClient(ddlConfig, (client) =>
    executeProjectionDdlPlan(client, plan.requestId),
  );
  assert.equal(
    ["CREATED", "REUSED"].includes(recovered.outcome),
    true,
    "replay must recover whether PostgreSQL aborted or completed after the client was killed",
  );
  assert.equal(recovered.attemptCount, 2);
  assert.equal(
    (await withClient(ddlConfig, (client) => executeProjectionDdlPlan(client, plan.requestId)))
      .outcome,
    "REUSED",
  );
}

function buildPlan(input: {
  readonly requestId: string;
  readonly action: ProjectionDdlAction;
  readonly referenceCount: number;
  readonly inventoryRevision?: string;
  readonly objectTypeResourceId?: string;
  readonly objectTypeRevisionId?: string;
}): ProjectionDdlPlanImmutable {
  const objectTypeResourceId = input.objectTypeResourceId ?? resourceId;
  const objectTypeRevisionId = input.objectTypeRevisionId ?? revisionId;
  const compiled = compileReleaseIndexPlan({
    projectId,
    releaseId: input.requestId,
    evidenceCatalog: ["ddl:projection-spike"],
    objectTypes: [
      {
        resourceId: objectTypeResourceId,
        revisionId: objectTypeRevisionId,
        properties: [
          { propertyId: "id", type: "string", primaryKey: true },
          { propertyId: "status", type: "string", filterable: true },
        ],
        indexes: [
          {
            kind: "btree",
            keys: [{ propertyId: "status", direction: "ASC" }],
            evidenceRefs: ["ddl:projection-spike"],
          },
        ],
      },
    ],
  }).indexes[0];
  assert.ok(compiled);
  return {
    requestId: input.requestId,
    projectId,
    action: input.action,
    inventoryRevision: input.inventoryRevision ?? "7",
    indexName: compiled.name,
    targetTable: "runtime.object_current",
    recipe: "BTREE_TEXT",
    propertyKey: "status",
    objectTypeResourceId,
    objectTypeRevisionId,
    physicalSignature: compiled.physicalSignature,
    referenceCount: input.referenceCount,
  };
}

async function insertPlan(admin: pg.Client, plan: ProjectionDdlPlanImmutable): Promise<void> {
  await admin.query(
    `INSERT INTO ops.projection_ddl_requests
       (request_id, project_id, action, state, inventory_revision, plan_digest,
        index_name, target_table, recipe, property_key, object_type_resource_id,
        object_type_revision_id, physical_signature, reference_count)
     VALUES ($1::uuid, $2::uuid, $3, 'APPROVED', $4::bigint, $5, $6, $7, $8, $9,
             $10::uuid, $11::uuid, $12, $13)`,
    [
      plan.requestId,
      plan.projectId,
      plan.action,
      plan.inventoryRevision,
      projectionDdlPlanDigest(plan),
      plan.indexName,
      plan.targetTable,
      plan.recipe,
      plan.propertyKey,
      plan.objectTypeResourceId,
      plan.objectTypeRevisionId,
      plan.physicalSignature,
      plan.referenceCount,
    ],
  );
}

async function assertIndexExists(
  admin: pg.Client,
  indexName: string,
  physicalSignature: string,
): Promise<void> {
  const result = await admin.query<{
    readonly is_valid: boolean;
    readonly is_ready: boolean;
    readonly signature: string | null;
  }>(
    `SELECT catalog.indisvalid AS is_valid, catalog.indisready AS is_ready,
            pg_catalog.obj_description(class.oid, 'pg_class') AS signature
     FROM pg_catalog.pg_class AS class
     JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
     JOIN pg_catalog.pg_index AS catalog ON catalog.indexrelid = class.oid
     WHERE namespace.nspname = 'runtime' AND class.relname = $1`,
    [indexName],
  );
  assert.deepEqual(result.rows[0], {
    is_valid: true,
    is_ready: true,
    signature: `ontos:index-signature:${physicalSignature}`,
  });
}

function ddlError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ProjectionDdlError && error.code === code;
}

function postgresUrl(config: pg.ClientConfig): string {
  return `postgresql://${encodeURIComponent(String(config.user))}:${encodeURIComponent(String(config.password))}@${String(config.host)}:${String(config.port)}/${String(config.database)}`;
}

function collectChildOutput(
  child: ChildProcess,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  let stdout = "";
  let stderr = "";
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  assert.ok(childStdout);
  assert.ok(childStderr);
  childStdout.setEncoding("utf8");
  childStderr.setEncoding("utf8");
  childStdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  childStderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", () => resolve({ stdout, stderr }));
  });
}

async function waitForChildClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("DDL Executor child did not exit.")), 10_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for PostgreSQL evidence.");
}

async function publishedPostgreSqlPort(containerName: string): Promise<number> {
  const { stdout } = await execFileAsync("docker", [
    "inspect",
    "--format",
    '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
    containerName,
  ]);
  const port = Number(stdout.trim());
  assert.ok(Number.isInteger(port) && port > 0);
  return port;
}

async function waitForPostgreSql(config: pg.ClientConfig): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await withClient(config, async (client) => client.query("SELECT 1"));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
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

async function docker(args: readonly string[], ignoreFailure = false): Promise<void> {
  try {
    await execFileAsync("docker", [...args]);
  } catch (error) {
    if (!ignoreFailure) throw error;
  }
}
