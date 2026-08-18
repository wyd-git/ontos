import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import { parseArtifactDigest, type ArtifactDigest } from "@ontos/contracts";
import {
  GarbageCollectionService,
  IndexPlanAdmissionService,
  type IndexCapacityCrypto,
} from "@ontos/materialization-application";
import {
  executeProjectionDdlRequest,
  PostgresGarbageCollectionRepository,
  PostgresIndexPlanAdmissionRepository,
  ProjectionDdlExecutorError,
  scanAndRecordProjectPhysicalInventory,
} from "@ontos/materialization-postgres";
import { IndexPlanError, type ReleaseIndexPlanInput } from "@ontos/materialization-domain";
import pg from "pg";

import { runDatabaseMigrations } from "../../database/migrator.ts";
import { resolvePostgresTestImage } from "../../database/postgres-test-image.ts";

const execFileAsync = promisify(execFile);
const postgresImage = resolvePostgresTestImage();
const database = "ontos_g20209";
const adminPassword = "local-only-g20209-admin-secret";
const runtimePassword = "local-only-g20209-runtime-secret";
const ddlPassword = "local-only-g20209-ddl-secret";
const projectId = "00000000-0000-4000-8000-000000002901";
const principalId = "00000000-0000-4000-8000-000000002902";
const release1 = "00000000-0000-4000-8000-000000002903";
const release2 = "00000000-0000-4000-8000-000000002904";
const objectScopes = [
  ["00000000-0000-4000-8000-000000002911", "00000000-0000-4000-8000-000000002921"],
  ["00000000-0000-4000-8000-000000002912", "00000000-0000-4000-8000-000000002922"],
  ["00000000-0000-4000-8000-000000002913", "00000000-0000-4000-8000-000000002923"],
] as const;
const cliPath = fileURLToPath(
  new URL("../../../apps/projection-ddl-executor/src/main.ts", import.meta.url),
);

void test(
  "G2-02-09 persists admitted Plans and reconciles every P0 recipe with isolated DDL credentials",
  { timeout: 240_000 },
  async () => {
    const containerName = `ontos-g20209-${process.pid}-${randomUUID().slice(0, 8)}`;
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
        application_name: "ontos-g2-02-09-admin",
      };
      const apiConfig = { ...adminConfig, user: "g20209_api", password: runtimePassword };
      const workerConfig = { ...adminConfig, user: "g20209_worker", password: runtimePassword };
      const ddlConfig = { ...adminConfig, user: "g20209_ddl", password: ddlPassword };
      await waitForPostgreSql(adminConfig);
      await withClient(adminConfig, async (admin) => {
        await runDatabaseMigrations(admin);
        await seedFixture(admin);
      });
      await assertRuntimeBoundaries(apiConfig, workerConfig);

      const crypto = productionCrypto();
      const apiPool = new pg.Pool(apiConfig);
      let staged;
      try {
        staged = await new IndexPlanAdmissionService({
          repository: new PostgresIndexPlanAdmissionRepository(apiPool),
          crypto,
        }).stageReleasePlan({ plan: releasePlan(release1), at: 10 });
      } finally {
        await apiPool.end();
      }
      assert.equal(staged.persistedPlans.length, 3);
      assert.equal(staged.compiled.indexes.length, 11);
      assert.deepEqual([...new Set(staged.compiled.indexes.map((index) => index.recipe))].sort(), [
        "ARRAY_GIN",
        "BTREE_BOOLEAN",
        "BTREE_DATE",
        "BTREE_DECIMAL",
        "BTREE_ENUM",
        "BTREE_INTEGER",
        "BTREE_TEXT",
        "BTREE_TIMESTAMP",
        "TRIGRAM_GIN",
        "UNIQUE_BTREE",
      ]);
      const apiReusePool = new pg.Pool(apiConfig);
      try {
        const reused = await new IndexPlanAdmissionService({
          repository: new PostgresIndexPlanAdmissionRepository(apiReusePool),
          crypto,
        }).stageReleasePlan({ plan: releasePlan(release2), at: 11 });
        assert.equal(
          reused.persistedPlans.every((plan) => plan.reused),
          true,
        );

        const changed = releasePlan(release1);
        const firstType = required(changed.objectTypes[0]);
        const firstIndex = required(firstType.indexes[0]);
        assert.equal(firstIndex.kind, "btree");
        await assert.rejects(
          new IndexPlanAdmissionService({
            repository: new PostgresIndexPlanAdmissionRepository(apiReusePool),
            crypto,
          }).stageReleasePlan({
            plan: {
              ...changed,
              objectTypes: [
                {
                  ...firstType,
                  indexes: [
                    {
                      kind: "btree",
                      keys: [{ propertyId: "title", direction: "DESC" }],
                      evidenceRefs: firstIndex.evidenceRefs,
                    },
                    ...firstType.indexes.slice(1),
                  ],
                },
                ...changed.objectTypes.slice(1),
              ],
            },
            at: 12,
          }),
          (error: unknown) =>
            error instanceof IndexPlanError && error.code === "INDEX_DECLARATION_INVALID",
        );
      } finally {
        await apiReusePool.end();
      }
      const uniqueIndexName = required(
        staged.compiled.indexes.find((index) => index.recipe === "UNIQUE_BTREE"),
      ).name;

      const requests = await queueEveryEntry(workerConfig, staged.persistedPlans);
      assert.equal(requests.length, staged.compiled.indexes.length);
      const incompletePool = new pg.Pool(apiConfig);
      try {
        await assert.rejects(
          new IndexPlanAdmissionService({
            repository: new PostgresIndexPlanAdmissionRepository(incompletePool),
            crypto,
          }).stageReleasePlan({ plan: releasePlan(release2), at: 13 }),
          (error: unknown) =>
            error instanceof IndexPlanError && error.code === "INDEX_INVENTORY_INCOMPLETE",
        );
      } finally {
        await incompletePool.end();
      }
      const definitions = new Map(staged.compiled.indexes.map((item) => [item.name, item]));
      await exerciseWrongCatalogDefinition(adminConfig, ddlConfig, requests[0], definitions);
      await exerciseTamperedPersistedDefinition(adminConfig, ddlConfig, requests[1]);
      await exerciseKilledExecutor(adminConfig, ddlConfig, requests[2]);
      for (const request of requests.slice(3)) {
        const result = await withClient(ddlConfig, (client) =>
          executeProjectionDdlRequest(client, request.requestId),
        );
        assert.equal(result.outcome, "CREATED");
      }

      await withClient(adminConfig, async (admin) => {
        const catalog = await admin.query<{
          readonly count: number;
          readonly allValid: boolean;
          readonly allReady: boolean;
          readonly allSigned: boolean;
        }>(`
          SELECT count(*)::integer AS count,
                 bool_and(index_catalog.indisvalid) AS "allValid",
                 bool_and(index_catalog.indisready) AS "allReady",
                 bool_and(obj_description(index_class.oid, 'pg_class') LIKE
                          'ontos:index-signature:sha256:%') AS "allSigned"
          FROM pg_class AS index_class
          JOIN pg_namespace AS namespace ON namespace.oid = index_class.relnamespace
          JOIN pg_index AS index_catalog ON index_catalog.indexrelid = index_class.oid
          WHERE namespace.nspname = 'runtime' AND index_class.relname LIKE 'ok_oc_%'`);
        assert.deepEqual(catalog.rows[0], {
          count: requests.length,
          allValid: true,
          allReady: true,
          allSigned: true,
        });
        const uniqueDefinition = await admin.query<{ readonly definition: string }>(
          `SELECT pg_get_indexdef(index_class.oid) AS definition
           FROM pg_class AS index_class
           JOIN pg_namespace AS namespace ON namespace.oid = index_class.relnamespace
           WHERE namespace.nspname = 'runtime' AND index_class.relname = $1`,
          [uniqueIndexName],
        );
        assert.match(
          required(uniqueDefinition.rows[0]).definition,
          /USING btree \(project_id, generation_id,/u,
        );
      });

      const workerPool = new pg.Pool(workerConfig);
      try {
        const measured = await scanAndRecordProjectPhysicalInventory(workerPool, crypto, {
          projectId,
          expectedInventoryRevision: 1n,
        });
        assert.equal(measured.inventoryRevision, 2n);
        assert.equal(measured.totalRelationBytes > 0n, true);
        assert.equal(measured.indexBytes > 0n, true);
      } finally {
        await workerPool.end();
      }

      const secondPool = new pg.Pool(apiConfig);
      try {
        const reused = await new IndexPlanAdmissionService({
          repository: new PostgresIndexPlanAdmissionRepository(secondPool),
          crypto,
        }).stageReleasePlan({ plan: releasePlan(release2), at: 20 });
        assert.equal(
          reused.persistedPlans.every((plan) => plan.reused),
          true,
        );
        assert.deepEqual(
          reused.compiled.indexes.map((index) => index.physicalSignature).sort(),
          staged.compiled.indexes.map((index) => index.physicalSignature).sort(),
        );
      } finally {
        await secondPool.end();
      }
      await exerciseGcAuthorizedDrops(adminConfig, apiConfig, ddlConfig, requests.length);
    } finally {
      await docker(["rm", "--force", "--volumes", containerName], true);
    }
  },
);

interface QueuedRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly indexPlanId: string;
  readonly entryKey: string;
  readonly indexName: string;
}

async function exerciseGcAuthorizedDrops(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
  ddlConfig: pg.ClientConfig,
  expectedIndexCount: number,
): Promise<void> {
  const apiPool = new pg.Pool(apiConfig);
  try {
    const service = new GarbageCollectionService({
      repository: new PostgresGarbageCollectionRepository(apiPool),
      crypto: productionCrypto(),
      objectStore: { deleteVersion: () => Promise.resolve() },
      batchSize: 2,
    });
    await withClient(adminConfig, (admin) =>
      admin.query(
        `SET ROLE migration_owner;
         UPDATE ops.gc_root_provider_registry
         SET capability_state = 'ACTIVE', changed_at = clock_timestamp()
         WHERE capability_key = 'runtime.preflight-token';
         RESET ROLE`,
      ),
    );
    const incomplete = await service.dryRun({
      projectId,
      idempotencyKey: "g2-02-12-provider-missing-0000",
    });
    assert.equal(incomplete.analysis.status, "BLOCKED");
    assert.deepEqual(incomplete.analysis.candidates, []);
    assert.equal(
      incomplete.analysis.blockedReasons.includes("PROVIDER_MISSING:runtime.preflight-token"),
      true,
    );
    await withClient(adminConfig, (admin) =>
      admin.query(
        `SET ROLE migration_owner;
         UPDATE ops.gc_root_provider_registry
         SET capability_state = 'INACTIVE', changed_at = clock_timestamp()
         WHERE capability_key = 'runtime.preflight-token';
         RESET ROLE`,
      ),
    );
    const dryRun = await service.dryRun({
      projectId,
      idempotencyKey: "g2-02-12-projection-drop-0001",
    });
    assert.ok(dryRun.planId);
    assert.equal(dryRun.analysis.status, "READY");
    assert.equal(
      dryRun.analysis.candidates.filter((entry) => entry.kind === "INDEX").length,
      expectedIndexCount,
    );
    const planId = required(dryRun.planId);
    let executed = 0;
    for (;;) {
      const batch = await service.commitNext({ projectId, planId });
      for (const requestId of batch.indexRequestIds) {
        if (executed === 0) {
          await exerciseKilledDropExecutor(adminConfig, ddlConfig, requestId);
        }
        const result = await withClient(ddlConfig, (client) =>
          executeProjectionDdlRequest(client, requestId),
        );
        assert.equal(["DROPPED", "ABSENT"].includes(result.outcome), true);
        const replay = await withClient(ddlConfig, (client) =>
          executeProjectionDdlRequest(client, requestId),
        );
        assert.deepEqual(replay, result);
        executed += 1;
      }
      if (batch.state === "COMMITTED") break;
    }
    assert.equal(executed, expectedIndexCount);
    const status = await withClient(adminConfig, async (admin) => {
      const result = await admin.query<{
        readonly planState: string;
        readonly retired: number;
        readonly physical: number;
      }>(
        `SELECT
           (SELECT state FROM ops.gc_plans
             WHERE project_id = $1::uuid AND gc_plan_id = $2::uuid) AS "planState",
           (SELECT count(*)::integer FROM runtime.index_inventory
             WHERE project_id = $1::uuid AND state = 'retired') AS retired,
           (SELECT count(*)::integer
              FROM pg_class AS class
              JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
             WHERE namespace.nspname = 'runtime' AND class.relname LIKE 'ok_oc_%') AS physical`,
        [projectId, planId],
      );
      return required(result.rows[0]);
    });
    assert.deepEqual(status, {
      planState: "committed",
      retired: expectedIndexCount,
      physical: 0,
    });
  } finally {
    await apiPool.end();
  }
}

async function seedFixture(admin: pg.Client): Promise<void> {
  await admin.query(`
    CREATE ROLE g20209_api LOGIN PASSWORD '${runtimePassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
    CREATE ROLE g20209_worker LOGIN PASSWORD '${runtimePassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
    CREATE ROLE g20209_ddl LOGIN PASSWORD '${ddlPassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    GRANT api_runtime TO g20209_api;
    GRANT worker_runtime TO g20209_worker;
    GRANT migration_owner TO g20209_ddl;
    GRANT CONNECT ON DATABASE ${database} TO g20209_ddl;

    SET ROLE migration_owner;
    INSERT INTO authz.principals
      (principal_id, oidc_issuer, oidc_subject, display_name)
    VALUES ('${principalId}', 'https://g20209.test', 'owner', 'G2-02-09 Owner');
    INSERT INTO meta.projects (project_id, api_name, display_name)
    VALUES ('${projectId}', 'G20209Project', 'G2-02-09 Project');
  `);
  for (const [index, [resourceId, revisionId]] of objectScopes.entries()) {
    const content = publishedObjectType(index);
    const contentDigest = publishedObjectTypeDigest(index);
    await admin.query(
      `INSERT INTO meta.resources
         (resource_id, project_id, namespace, api_name, family)
       VALUES ($1::uuid, $2::uuid, 'g20209.core', $3, 'object_type')`,
      [resourceId, projectId, `IndexedType${index + 1}`],
    );
    await admin.query(
      `INSERT INTO meta.resource_revisions
         (revision_id, resource_id, revision_number, family, content_digest,
          content, created_by_principal_id)
       VALUES ($1::uuid, $2::uuid, 1, 'object_type', $3,
               $4::jsonb, $5::uuid)`,
      [revisionId, resourceId, contentDigest, JSON.stringify(content), principalId],
    );
    await admin.query(
      `INSERT INTO meta.validation_reports
         (report_id, subject_type, subject_id, resource_revision_id,
          subject_digest, validation_context_digest, validator_version, valid, issues)
       VALUES ($1::uuid, 'resource_revision', $2::uuid, $2::uuid,
               $3, $3, 'metadata-g2-01-v1', true, '[]'::jsonb)`,
      [randomUUID(), revisionId, contentDigest],
    );
    for (const state of ["validated", "published"] as const) {
      await admin.query(
        `UPDATE meta.resource_revisions
         SET state = $2, changed_at = clock_timestamp()
         WHERE revision_id = $1::uuid`,
        [revisionId, state],
      );
    }
  }
  for (const [releaseIndex, releaseId] of [release1, release2].entries()) {
    await admin.query(
      `INSERT INTO meta.releases
         (release_id, project_id, release_number, manifest_digest, created_by_principal_id)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)`,
      [releaseId, projectId, releaseIndex + 1, digest(`release-${releaseIndex + 1}`), principalId],
    );
    for (const [index, [resourceId, revisionId]] of objectScopes.entries()) {
      await admin.query(
        `INSERT INTO meta.release_pins
           (release_id, resource_id, revision_id, pin_order, family, content_digest)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'object_type', $5)`,
        [releaseId, resourceId, revisionId, index, publishedObjectTypeDigest(index)],
      );
    }
  }
  await admin.query(
    `INSERT INTO runtime.project_runtime_inventories
       (project_id, state_revision, inventory_revision, measurement_complete, inventory_digest)
     VALUES ($1::uuid, 1, 1, true, $2)`,
    [projectId, digest("initial-inventory")],
  );
  await admin.query("RESET ROLE");
}

function publishedObjectType(index: number) {
  const definitions = [
    {
      apiName: "IndexedType1",
      titlePropertyApiName: "title",
      defaultSearchPropertyApiNames: ["title"],
      defaultSort: [],
      properties: [
        publishedProperty("id", "string", { unique: true }),
        publishedProperty("title", "string", { filterable: true, searchable: true }),
        publishedProperty("tags", "string[]", { filterable: true }),
      ],
    },
    {
      apiName: "IndexedType2",
      titlePropertyApiName: "externalCode",
      defaultSearchPropertyApiNames: [],
      defaultSort: [{ propertyApiName: "amount", direction: "asc" }],
      properties: [
        publishedProperty("id", "string", { unique: true }),
        publishedProperty("externalCode", "string", { unique: true }),
        publishedProperty("quantity", "integer", { filterable: true }),
        publishedProperty("amount", "decimal", { sortable: true }),
        publishedProperty("dueDate", "date", { filterable: true }),
      ],
    },
    {
      apiName: "IndexedType3",
      titlePropertyApiName: "status",
      defaultSearchPropertyApiNames: [],
      defaultSort: [{ propertyApiName: "updatedAt", direction: "desc" }],
      properties: [
        publishedProperty("id", "string", { unique: true }),
        publishedProperty("updatedAt", "timestamp", { sortable: true }),
        publishedProperty("enabled", "boolean", { filterable: true }),
        publishedProperty("status", "enum", { filterable: true }),
        publishedProperty("details", "json", {
          filterable: true,
          jsonFilterPaths: ["/category"],
        }),
      ],
    },
  ] as const;
  const selected = required(definitions[index]);
  return {
    schemaVersion: 1,
    apiName: selected.apiName,
    displayName: selected.apiName,
    description: `${selected.apiName} published fixture.`,
    primaryKeyPropertyApiName: "id",
    titlePropertyApiName: selected.titlePropertyApiName,
    defaultSearchPropertyApiNames: selected.defaultSearchPropertyApiNames,
    defaultSort: selected.defaultSort,
    defaultClassification: "internal",
    properties: selected.properties,
  };
}

function publishedProperty(
  apiName: string,
  valueType:
    | "string"
    | "string[]"
    | "enum"
    | "integer"
    | "decimal"
    | "date"
    | "timestamp"
    | "boolean"
    | "json",
  capabilities: {
    readonly unique?: boolean;
    readonly filterable?: boolean;
    readonly sortable?: boolean;
    readonly searchable?: boolean;
    readonly jsonFilterPaths?: readonly string[];
  } = {},
) {
  return {
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `${apiName} fixture property.`,
    valueType,
    ...(valueType === "string" ? { caseSensitive: true } : {}),
    nullable: false,
    writeMode: "source_only",
    unique: capabilities.unique ?? false,
    filterable: capabilities.filterable ?? false,
    sortable: capabilities.sortable ?? false,
    searchable: capabilities.searchable ?? false,
    ...(valueType === "enum" ? { enumValues: ["ACTIVE", "INACTIVE"] } : {}),
    ...(valueType === "decimal" ? { decimalPrecision: 18, decimalScale: 2 } : {}),
    ...(capabilities.jsonFilterPaths === undefined
      ? {}
      : { jsonFilterPaths: capabilities.jsonFilterPaths }),
  };
}

function publishedObjectTypeDigest(index: number): ArtifactDigest {
  return digest(JSON.stringify(publishedObjectType(index)));
}

async function assertRuntimeBoundaries(
  apiConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
): Promise<void> {
  for (const config of [apiConfig, workerConfig]) {
    await withClient(config, async (client) => {
      await assert.rejects(client.query("SET ROLE migration_owner"));
      await assert.rejects(
        client.query("CREATE INDEX forbidden_g20209 ON runtime.object_current (project_id)"),
      );
      await assert.rejects(client.query("SELECT * FROM ops.projection_ddl_requests"));
    });
  }
}

async function queueEveryEntry(
  workerConfig: pg.ClientConfig,
  plans: readonly { readonly indexPlanId: string }[],
): Promise<QueuedRequest[]> {
  return withClient(workerConfig, async (worker) => {
    const entries = await worker.query<{
      readonly projectId: string;
      readonly indexPlanId: string;
      readonly entryKey: string;
      readonly indexName: string;
    }>(
      `SELECT entry.project_id AS "projectId", entry.index_plan_id AS "indexPlanId",
              entry.entry_key AS "entryKey", entry.index_name AS "indexName"
       FROM runtime.index_plan_entries AS entry
       WHERE entry.project_id = $1::uuid
         AND entry.index_plan_id = ANY($2::uuid[])
       ORDER BY entry.index_plan_id, entry.ordinal`,
      [projectId, plans.map((plan) => plan.indexPlanId)],
    );
    const queued: QueuedRequest[] = [];
    for (const entry of entries.rows) {
      const requestId = randomUUID();
      const result = await worker.query<{ readonly requestId: string; readonly state: string }>(
        `SELECT request_id AS "requestId", state
         FROM ops.request_projection_index_build($1::uuid, $2::uuid, $3, $4::uuid)`,
        [entry.projectId, entry.indexPlanId, entry.entryKey, requestId],
      );
      assert.equal(result.rows[0]?.state, "APPROVED");
      queued.push({ requestId, ...entry });
    }
    return queued;
  });
}

async function exerciseWrongCatalogDefinition(
  adminConfig: pg.ClientConfig,
  ddlConfig: pg.ClientConfig,
  request: QueuedRequest | undefined,
  definitions: ReadonlyMap<string, unknown>,
): Promise<void> {
  const target = required(request);
  assert.equal(definitions.has(target.indexName), true);
  await withClient(adminConfig, async (admin) => {
    await admin.query(
      `SET ROLE migration_owner;
       CREATE INDEX ${quoteIdentifier(target.indexName)} ON runtime.object_current (project_id);
       RESET ROLE;`,
    );
  });
  await assert.rejects(
    withClient(ddlConfig, (client) => executeProjectionDdlRequest(client, target.requestId)),
    ddlError("DDL_INDEX_DEFINITION_MISMATCH"),
  );
  await withClient(adminConfig, async (admin) => {
    assert.equal(
      (
        await admin.query<{ readonly exists: boolean }>(
          "SELECT to_regclass($1) IS NOT NULL AS exists",
          [`runtime.${target.indexName}`],
        )
      ).rows[0]?.exists,
      true,
    );
    await admin.query(
      `SET ROLE migration_owner; DROP INDEX runtime.${quoteIdentifier(target.indexName)}; RESET ROLE;`,
    );
  });
  assert.equal(
    ["CREATED", "REUSED"].includes(
      (
        await withClient(ddlConfig, (client) =>
          executeProjectionDdlRequest(client, target.requestId),
        )
      ).outcome,
    ),
    true,
  );
}

async function exerciseTamperedPersistedDefinition(
  adminConfig: pg.ClientConfig,
  ddlConfig: pg.ClientConfig,
  request: QueuedRequest | undefined,
): Promise<void> {
  const target = required(request);
  const original = await withClient(adminConfig, async (admin) => {
    const result = await admin.query<{ readonly definition: unknown }>(
      `SELECT definition FROM runtime.index_plan_entries
       WHERE project_id = $1::uuid AND index_plan_id = $2::uuid AND entry_key = $3`,
      [projectId, target.indexPlanId, target.entryKey],
    );
    await admin.query(
      `ALTER TABLE runtime.index_plan_entries DISABLE TRIGGER index_plan_entries_immutable`,
    );
    await admin.query(
      `UPDATE runtime.index_plan_entries
       SET definition = jsonb_set(definition, '{evidenceRefs}', '["tampered:evidence"]'::jsonb)
       WHERE project_id = $1::uuid AND index_plan_id = $2::uuid AND entry_key = $3`,
      [projectId, target.indexPlanId, target.entryKey],
    );
    await admin.query(
      `ALTER TABLE runtime.index_plan_entries ENABLE TRIGGER index_plan_entries_immutable`,
    );
    return required(result.rows[0]).definition;
  });
  await assert.rejects(
    withClient(ddlConfig, (client) => executeProjectionDdlRequest(client, target.requestId)),
    ddlError("DDL_PLAN_DIGEST_MISMATCH"),
  );
  await withClient(adminConfig, async (admin) => {
    await admin.query(
      `ALTER TABLE runtime.index_plan_entries DISABLE TRIGGER index_plan_entries_immutable`,
    );
    await admin.query(
      `UPDATE runtime.index_plan_entries SET definition = $4::jsonb
       WHERE project_id = $1::uuid AND index_plan_id = $2::uuid AND entry_key = $3`,
      [projectId, target.indexPlanId, target.entryKey, JSON.stringify(original)],
    );
    await admin.query(
      `ALTER TABLE runtime.index_plan_entries ENABLE TRIGGER index_plan_entries_immutable`,
    );
  });
  assert.equal(
    (await withClient(ddlConfig, (client) => executeProjectionDdlRequest(client, target.requestId)))
      .outcome,
    "CREATED",
  );
}

async function exerciseKilledExecutor(
  adminConfig: pg.ClientConfig,
  ddlConfig: pg.ClientConfig,
  request: QueuedRequest | undefined,
): Promise<void> {
  const target = required(request);
  const blocker = new pg.Client(adminConfig);
  await blocker.connect();
  await blocker.query("BEGIN");
  await blocker.query("SET LOCAL ROLE migration_owner");
  await blocker.query("LOCK TABLE runtime.object_current IN ACCESS EXCLUSIVE MODE");
  const childEnvironment = { ...process.env };
  delete childEnvironment.ONTOS_DATABASE_URL;
  delete childEnvironment.ONTOS_API_DATABASE_URL;
  delete childEnvironment.ONTOS_WORKER_DATABASE_URL;
  delete childEnvironment.ONTOS_MIGRATION_DATABASE_URL;
  childEnvironment.ONTOS_PROJECTION_DDL_DATABASE_URL = postgresUrl(ddlConfig);
  const child = spawn(process.execPath, [cliPath, "--plan-id", target.requestId], {
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectOutput(child);
  try {
    await waitUntil(async () =>
      withClient(adminConfig, async (admin) => {
        const result = await admin.query<{ readonly blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE application_name = 'ontos-projection-ddl-executor'
               AND query ILIKE 'CREATE%INDEX CONCURRENTLY%'
               AND wait_event_type = 'Lock'
           ) AS blocked`,
        );
        return result.rows[0]?.blocked === true;
      }),
    );
    assert.equal(child.kill("SIGKILL"), true);
    await waitForChild(child);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    await blocker.end().catch(() => undefined);
  }
  const captured = await output;
  assert.equal(captured.stdout.includes(ddlPassword), false);
  assert.equal(captured.stderr.includes(ddlPassword), false);
  const interrupted = await withClient(adminConfig, async (admin) =>
    admin.query<{ readonly state: string; readonly inventoryState: string }>(
      `SELECT request.state, inventory.state AS "inventoryState"
       FROM ops.projection_ddl_requests AS request
       JOIN runtime.index_plan_entries AS entry
         ON entry.project_id = request.project_id AND entry.index_plan_id = request.index_plan_id
        AND entry.entry_key = request.entry_key
       JOIN runtime.index_inventory AS inventory
         ON inventory.project_id = request.project_id AND inventory.index_name = entry.index_name
       WHERE request.request_id = $1::uuid`,
      [target.requestId],
    ),
  );
  assert.deepEqual(interrupted.rows[0], { state: "RUNNING", inventoryState: "building" });
  assert.equal(
    ["CREATED", "REUSED"].includes(
      (
        await withClient(ddlConfig, (client) =>
          executeProjectionDdlRequest(client, target.requestId),
        )
      ).outcome,
    ),
    true,
  );
}

async function exerciseKilledDropExecutor(
  adminConfig: pg.ClientConfig,
  ddlConfig: pg.ClientConfig,
  requestId: string,
): Promise<void> {
  const blocker = new pg.Client(adminConfig);
  await blocker.connect();
  await blocker.query("BEGIN");
  await blocker.query("LOCK TABLE runtime.object_current IN ACCESS EXCLUSIVE MODE");
  const childEnvironment = { ...process.env };
  delete childEnvironment.ONTOS_DATABASE_URL;
  delete childEnvironment.ONTOS_API_DATABASE_URL;
  delete childEnvironment.ONTOS_WORKER_DATABASE_URL;
  delete childEnvironment.ONTOS_MIGRATION_DATABASE_URL;
  childEnvironment.ONTOS_PROJECTION_DDL_DATABASE_URL = postgresUrl(ddlConfig);
  const child = spawn(process.execPath, [cliPath, "--plan-id", requestId], {
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectOutput(child);
  let backendPid: number | undefined;
  try {
    await waitUntil(async () =>
      withClient(adminConfig, async (admin) => {
        const result = await admin.query<{ readonly pid: number }>(
          `SELECT pid FROM pg_stat_activity
           WHERE application_name = 'ontos-projection-ddl-executor'
             AND wait_event_type = 'Lock'
           ORDER BY backend_start DESC LIMIT 1`,
        );
        backendPid = result.rows[0]?.pid;
        return backendPid !== undefined;
      }),
    );
    assert.equal(child.kill("SIGKILL"), true);
    await waitForChild(child);
    if (backendPid !== undefined) {
      await withClient(adminConfig, (admin) =>
        admin.query("SELECT pg_terminate_backend($1::integer)", [backendPid]),
      );
    }
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    await blocker.end().catch(() => undefined);
  }
  const captured = await output;
  assert.equal(captured.stdout.includes(ddlPassword), false);
  assert.equal(captured.stderr.includes(ddlPassword), false);
  await withClient(adminConfig, async (admin) => {
    const state = await admin.query<{
      readonly requestState: string;
      readonly inventoryState: string;
      readonly physicalPresent: boolean;
    }>(
      `SELECT request.state AS "requestState", inventory.state AS "inventoryState",
              to_regclass('runtime.' || inventory.index_name) IS NOT NULL AS "physicalPresent"
       FROM ops.projection_ddl_requests AS request
       JOIN runtime.index_inventory AS inventory
         ON inventory.project_id = request.project_id
        AND inventory.index_plan_id = request.index_plan_id
        AND inventory.entry_key = request.entry_key
       WHERE request.request_id = $1::uuid`,
      [requestId],
    );
    assert.deepEqual(state.rows[0], {
      requestState: "RUNNING",
      inventoryState: "ready",
      physicalPresent: true,
    });
  });
}

function releasePlan(releaseId: string): ReleaseIndexPlanInput {
  return {
    projectId,
    releaseId,
    evidenceCatalog: [
      "q:text",
      "q:search",
      "q:tags",
      "q:unique",
      "q:integer",
      "q:decimal",
      "q:date",
      "q:timestamp",
      "q:boolean",
      "q:enum",
      "q:json",
    ],
    objectTypes: [
      {
        resourceId: objectScopes[0][0],
        revisionId: objectScopes[0][1],
        properties: [
          { propertyId: "id", type: "string", primaryKey: true },
          { propertyId: "title", type: "string", filterable: true, searchable: true },
          { propertyId: "tags", type: "string[]", filterable: true },
        ],
        indexes: [
          { kind: "btree", keys: [{ propertyId: "title" }], evidenceRefs: ["q:text"] },
          { kind: "gin_trigram", propertyId: "title", evidenceRefs: ["q:search"] },
          { kind: "gin_array", propertyId: "tags", evidenceRefs: ["q:tags"] },
        ],
      },
      {
        resourceId: objectScopes[1][0],
        revisionId: objectScopes[1][1],
        properties: [
          { propertyId: "id", type: "string", primaryKey: true },
          { propertyId: "externalCode", type: "string", unique: true },
          { propertyId: "quantity", type: "integer", filterable: true },
          { propertyId: "amount", type: "decimal", sortable: true },
          { propertyId: "dueDate", type: "date", filterable: true },
        ],
        indexes: [
          {
            kind: "btree",
            keys: [{ propertyId: "externalCode" }],
            unique: true,
            evidenceRefs: ["q:unique"],
          },
          { kind: "btree", keys: [{ propertyId: "quantity" }], evidenceRefs: ["q:integer"] },
          { kind: "btree", keys: [{ propertyId: "amount" }], evidenceRefs: ["q:decimal"] },
          { kind: "btree", keys: [{ propertyId: "dueDate" }], evidenceRefs: ["q:date"] },
        ],
      },
      {
        resourceId: objectScopes[2][0],
        revisionId: objectScopes[2][1],
        properties: [
          { propertyId: "id", type: "string", primaryKey: true },
          { propertyId: "updatedAt", type: "timestamp", sortable: true },
          { propertyId: "enabled", type: "boolean", filterable: true },
          { propertyId: "status", type: "enum", filterable: true },
          {
            propertyId: "details",
            type: "json",
            registeredJsonPaths: [{ path: "$.category", valueType: "string", filterable: true }],
          },
        ],
        indexes: [
          {
            kind: "btree",
            keys: [{ propertyId: "updatedAt", direction: "DESC" }],
            evidenceRefs: ["q:timestamp"],
          },
          { kind: "btree", keys: [{ propertyId: "enabled" }], evidenceRefs: ["q:boolean"] },
          { kind: "btree", keys: [{ propertyId: "status" }], evidenceRefs: ["q:enum"] },
          {
            kind: "btree",
            keys: [{ propertyId: "details", jsonPath: "$.category" }],
            evidenceRefs: ["q:json"],
          },
        ],
      },
    ],
  };
}

function productionCrypto(): IndexCapacityCrypto {
  return { randomId: randomUUID, digestCanonicalText: digest };
}

function digest(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}

function ddlError(code: ProjectionDdlExecutorError["code"]) {
  return (error: unknown) => error instanceof ProjectionDdlExecutorError && error.code === code;
}

function postgresUrl(config: pg.ClientConfig): string {
  return `postgresql://${String(config.user)}:${String(config.password)}@${String(config.host)}:${String(config.port)}/${String(config.database)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function waitForPostgreSql(config: pg.ClientConfig): Promise<void> {
  await waitUntil(async () => {
    try {
      await withClient(config, (client) => client.query("SELECT 1").then(() => true));
      return true;
    } catch {
      return false;
    }
  });
}

async function publishedPostgreSqlPort(containerName: string): Promise<number> {
  return Number.parseInt(
    (await docker(["port", containerName, "5432/tcp"])).split(":").at(-1) ?? "",
    10,
  );
}

async function docker(args: readonly string[], ignoreFailure = false): Promise<string> {
  try {
    return (await execFileAsync("docker", [...args], { encoding: "utf8" })).stdout.trim();
  } catch (error) {
    if (ignoreFailure) return "";
    throw error;
  }
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

async function waitUntil(action: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await action()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for PostgreSQL state.");
}

function collectOutput(child: ChildProcess): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  return new Promise((resolve) => child.once("close", () => resolve({ stdout, stderr })));
}

async function waitForChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing integration fixture value.");
  return value;
}
