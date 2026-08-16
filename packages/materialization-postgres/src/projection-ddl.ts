import { createHash } from "node:crypto";

import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  type ArtifactDigest,
} from "@ontos/contracts";
import { definitionForPersistence } from "@ontos/materialization-application";
import {
  calculateObjectTypeIndexPlanDigest,
  validateCompiledIndexDefinition,
  type CompiledIndexDefinition,
} from "@ontos/materialization-domain";
import type pg from "pg";

export type ProjectionDdlErrorCode =
  | "DDL_CATALOG_VERIFICATION_FAILED"
  | "DDL_DATABASE_BOUNDARY_INVALID"
  | "DDL_DROP_NOT_AUTHORIZED"
  | "DDL_EXECUTION_FAILED"
  | "DDL_INDEX_BUSY"
  | "DDL_INDEX_DEFINITION_MISMATCH"
  | "DDL_INPUT_INVALID"
  | "DDL_PLAN_DIGEST_MISMATCH"
  | "DDL_PLAN_INVALID"
  | "DDL_PLAN_NOT_FOUND"
  | "DDL_PLAN_STALE";

export class ProjectionDdlExecutorError extends Error {
  readonly code: ProjectionDdlErrorCode;

  constructor(code: ProjectionDdlErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "ProjectionDdlExecutorError";
    this.code = code;
  }
}

export interface ProjectionDdlExecutionResult {
  readonly projectId: string;
  readonly requestId: string;
  readonly indexName: string;
  readonly outcome: "CREATED" | "REUSED" | "DROPPED" | "ABSENT";
  readonly attemptCount: number;
  readonly catalogDigest: string;
  readonly observedBytes: bigint;
}

interface BoundaryRow extends pg.QueryResultRow {
  readonly identityUnchanged: boolean;
  readonly ownerMember: boolean;
  readonly apiMember: boolean;
  readonly workerMember: boolean;
  readonly opsMember: boolean;
  readonly privilegedLogin: boolean;
  readonly databaseCreate: boolean;
  readonly serverVersion: number;
}

interface RequestRow extends pg.QueryResultRow {
  readonly projectId: string;
  readonly requestId: string;
  readonly action: "CREATE" | "DROP";
  readonly state: "APPROVED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  readonly inventoryRevision: string;
  readonly indexPlanId: string;
  readonly entryKey: string;
  readonly attemptCount: number;
  readonly lastResultCode: string | null;
  readonly catalogDigest: string | null;
  readonly gcPlanId: string | null;
  readonly gcPlanDigest: string | null;
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly planDigest: string;
  readonly compilerVersion: string;
  readonly entryCount: number;
  readonly indexName: string;
  readonly physicalSignature: string;
  readonly definitionDigest: string;
  readonly definition: unknown;
  readonly inventoryState: "planned" | "building" | "ready" | "retired" | "failed";
  readonly inventoryName: string;
  readonly inventorySignature: string;
}

interface PlanEntryRow extends pg.QueryResultRow {
  readonly entryKey: string;
  readonly ordinal: number;
  readonly indexName: string;
  readonly physicalSignature: string;
  readonly definitionDigest: string;
  readonly definition: unknown;
}

interface CatalogRow extends pg.QueryResultRow {
  readonly oid: string;
  readonly indexSchema: string;
  readonly indexName: string;
  readonly tableSchema: string;
  readonly tableName: string;
  readonly accessMethod: string;
  readonly unique: boolean;
  readonly valid: boolean;
  readonly ready: boolean;
  readonly keyCount: number;
  readonly predicate: string | null;
  readonly signatureComment: string | null;
  readonly observedBytes: string;
}

interface CatalogKeyRow extends pg.QueryResultRow {
  readonly position: number;
  readonly definition: string;
  readonly opclassSchema: string;
  readonly opclassName: string;
  readonly collationSchema: string | null;
  readonly collationName: string | null;
  readonly collationProvider: string | null;
  readonly collationDeterministic: boolean | null;
  readonly options: number;
}

interface CatalogIndex {
  readonly row: CatalogRow;
  readonly keys: readonly CatalogKeyRow[];
}

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const indexNamePattern = /^ok_oc_(?:bt|uq|trgm|arr)_[0-9a-f]{10}_[0-9a-f]{8}_[0-9a-f]{12}$/u;
const signatureCommentPrefix = "ontos:index-signature:";
const advisoryNamespace = 737_217_209;

export function parseProjectionDdlRequestId(args: readonly string[]): string {
  const value = args[1];
  if (args.length !== 2 || args[0] !== "--plan-id" || !canonicalUuidPattern.test(value ?? "")) {
    throw new ProjectionDdlExecutorError("DDL_INPUT_INVALID");
  }
  return required(value);
}

export async function assertProjectionDdlDatabaseBoundary(client: pg.Client): Promise<void> {
  const result = await client.query<BoundaryRow>(`
    SELECT
      current_user = session_user AS "identityUnchanged",
      pg_has_role(current_user, 'migration_owner', 'MEMBER') AS "ownerMember",
      pg_has_role(current_user, 'api_runtime', 'MEMBER') AS "apiMember",
      pg_has_role(current_user, 'worker_runtime', 'MEMBER') AS "workerMember",
      pg_has_role(current_user, 'read_only_ops', 'MEMBER') AS "opsMember",
      (SELECT role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
              OR role.rolreplication OR role.rolbypassrls OR role.rolinherit
         FROM pg_roles AS role WHERE role.rolname = session_user) AS "privilegedLogin",
      has_database_privilege(current_user, current_database(), 'CREATE') AS "databaseCreate",
      current_setting('server_version_num')::integer AS "serverVersion"
  `);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row === undefined ||
    !row.identityUnchanged ||
    !row.ownerMember ||
    row.apiMember ||
    row.workerMember ||
    row.opsMember ||
    row.privilegedLogin ||
    row.databaseCreate ||
    row.serverVersion < 160_000
  ) {
    throw new ProjectionDdlExecutorError("DDL_DATABASE_BOUNDARY_INVALID");
  }
}

export async function executeProjectionDdlRequest(
  client: pg.Client,
  requestId: string,
): Promise<ProjectionDdlExecutionResult> {
  if (!canonicalUuidPattern.test(requestId)) {
    throw new ProjectionDdlExecutorError("DDL_INPUT_INVALID");
  }
  await client.query("SET application_name = 'ontos-projection-ddl-executor'");
  await assertProjectionDdlDatabaseBoundary(client);
  await client.query("SET ROLE migration_owner");
  await client.query("SET search_path = pg_catalog");
  let plan: RequestRow | undefined;
  let locked = false;
  try {
    const claimed = await claimRequest(client, requestId);
    plan = claimed.plan;
    validateRequestRow(plan);
    if (claimed.replay && plan.action === "DROP") return replayDrop(plan);
    locked = await tryLock(client, plan.projectId);
    if (!locked) throw new ProjectionDdlExecutorError("DDL_INDEX_BUSY");
    plan = await loadRequest(client, requestId, false);
    validateRequestRow(plan);
    await verifyPersistedPlan(client, plan);
    await assertInventoryRevision(client, plan);
    const definition = parseDefinition(plan.definition);
    if (plan.action === "DROP") {
      await verifyGcDropAuthorization(client, plan);
      const execution = await reconcileDrop(client, definition);
      const catalogDigest = digestDroppedCatalog(plan, execution.outcome);
      await markSucceeded(client, plan, catalogDigest, "0", execution.outcome);
      return Object.freeze({
        projectId: plan.projectId,
        requestId: plan.requestId,
        indexName: plan.indexName,
        outcome: execution.outcome,
        attemptCount: plan.attemptCount,
        catalogDigest,
        observedBytes: 0n,
      });
    }
    const execution = await reconcileCreate(client, definition);
    const catalogDigest = digestCatalog(plan, execution.catalog);
    await markSucceeded(
      client,
      plan,
      catalogDigest,
      execution.catalog.row.observedBytes,
      execution.outcome,
    );
    return Object.freeze({
      projectId: plan.projectId,
      requestId: plan.requestId,
      indexName: plan.indexName,
      outcome: execution.outcome,
      attemptCount: plan.attemptCount,
      catalogDigest,
      observedBytes: BigInt(execution.catalog.row.observedBytes),
    });
  } catch (error) {
    const stable = stableError(error);
    if (plan !== undefined) await markFailedQuietly(client, plan, stable.code);
    throw stable;
  } finally {
    if (locked && plan !== undefined) await unlockQuietly(client, plan.projectId);
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query("RESET search_path").catch(() => undefined);
  }
}

async function claimRequest(
  client: pg.Client,
  requestId: string,
): Promise<{ readonly plan: RequestRow; readonly replay: boolean }> {
  await client.query("BEGIN");
  try {
    const plan = await loadRequest(client, requestId, true);
    validateRequestRow(plan);
    if (plan.state === "SUCCEEDED") {
      await client.query("COMMIT");
      return { plan, replay: true };
    }
    const updated = await client.query<{ readonly attemptCount: number }>(
      `UPDATE ops.projection_ddl_requests
       SET state = 'RUNNING', attempt_count = attempt_count + 1,
           last_result_code = NULL, catalog_digest = NULL,
           started_at = clock_timestamp(), finished_at = NULL
       WHERE project_id = $1::uuid AND request_id = $2::uuid
       RETURNING attempt_count AS "attemptCount"`,
      [plan.projectId, requestId],
    );
    if (plan.action === "CREATE") {
      await client.query(
        `UPDATE runtime.index_inventory
         SET state = 'building', last_result_code = NULL, changed_at = clock_timestamp()
         WHERE project_id = $1::uuid
           AND index_name = $2
           AND physical_signature = $3
           AND state IN ('planned', 'building', 'failed')`,
        [plan.projectId, plan.indexName, plan.physicalSignature],
      );
    }
    await client.query("COMMIT");
    return {
      plan: {
        ...plan,
        state: "RUNNING",
        attemptCount: required(updated.rows[0]).attemptCount,
        inventoryState: plan.action === "CREATE" ? "building" : plan.inventoryState,
      },
      replay: false,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function loadRequest(
  client: pg.Client,
  requestId: string,
  forUpdate: boolean,
): Promise<RequestRow> {
  const result = await client.query<RequestRow>(
    `SELECT request.project_id AS "projectId", request.request_id AS "requestId",
            request.action, request.state,
            request.inventory_revision::text AS "inventoryRevision",
            request.index_plan_id AS "indexPlanId", request.entry_key AS "entryKey",
            request.attempt_count AS "attemptCount",
            request.last_result_code AS "lastResultCode",
            request.catalog_digest AS "catalogDigest",
            request.gc_plan_id AS "gcPlanId", request.gc_plan_digest AS "gcPlanDigest",
            plan.target_resource_id AS "targetResourceId",
            plan.target_revision_id AS "targetRevisionId",
            plan.plan_digest AS "planDigest", plan.compiler_version AS "compilerVersion",
            plan.entry_count AS "entryCount", entry.index_name AS "indexName",
            entry.physical_signature AS "physicalSignature",
            entry.definition_digest AS "definitionDigest", entry.definition,
            inventory.state AS "inventoryState", inventory.index_name AS "inventoryName",
            inventory.physical_signature AS "inventorySignature"
     FROM ops.projection_ddl_requests AS request
     JOIN runtime.index_plans AS plan
       ON plan.project_id = request.project_id
      AND plan.index_plan_id = request.index_plan_id
     JOIN runtime.index_plan_entries AS entry
       ON entry.project_id = request.project_id
      AND entry.index_plan_id = request.index_plan_id
      AND entry.entry_key = request.entry_key
     JOIN runtime.index_inventory AS inventory
       ON inventory.project_id = request.project_id
      AND inventory.index_name = entry.index_name
      AND inventory.physical_signature = entry.physical_signature
     WHERE request.request_id = $1::uuid${forUpdate ? " FOR UPDATE OF request" : ""}`,
    [requestId],
  );
  if (result.rows.length !== 1 || result.rows[0] === undefined) {
    throw new ProjectionDdlExecutorError("DDL_PLAN_NOT_FOUND");
  }
  return result.rows[0];
}

function validateRequestRow(plan: RequestRow): void {
  if (
    !canonicalUuidPattern.test(plan.projectId) ||
    !canonicalUuidPattern.test(plan.requestId) ||
    !canonicalUuidPattern.test(plan.indexPlanId) ||
    !canonicalUuidPattern.test(plan.targetResourceId) ||
    !canonicalUuidPattern.test(plan.targetRevisionId) ||
    !/^[1-9][0-9]*$/u.test(plan.inventoryRevision) ||
    !indexNamePattern.test(plan.indexName) ||
    plan.inventoryName !== plan.indexName ||
    plan.inventorySignature !== plan.physicalSignature ||
    plan.compilerVersion !== "g2-02-09-v1" ||
    !Number.isSafeInteger(plan.entryCount) ||
    plan.entryCount < 1 ||
    !Number.isSafeInteger(plan.attemptCount) ||
    plan.attemptCount < 0
  ) {
    throw new ProjectionDdlExecutorError("DDL_PLAN_INVALID");
  }
  parseArtifactDigest(plan.planDigest);
  parseArtifactDigest(plan.physicalSignature);
  parseArtifactDigest(plan.definitionDigest);
  if (
    (plan.action === "CREATE" && (plan.gcPlanId !== null || plan.gcPlanDigest !== null)) ||
    (plan.action === "DROP" &&
      (plan.gcPlanId === null ||
        !canonicalUuidPattern.test(plan.gcPlanId) ||
        plan.gcPlanDigest === null ||
        !["ready", "retired"].includes(plan.inventoryState)))
  ) {
    throw new ProjectionDdlExecutorError("DDL_DROP_NOT_AUTHORIZED");
  }
  if (plan.gcPlanDigest !== null) parseArtifactDigest(plan.gcPlanDigest);
  const definition = parseDefinition(plan.definition);
  if (
    definition.name !== plan.indexName ||
    definition.physicalSignature !== plan.physicalSignature ||
    definition.resourceId !== plan.targetResourceId ||
    definition.revisionId !== plan.targetRevisionId
  ) {
    throw new ProjectionDdlExecutorError("DDL_PLAN_INVALID");
  }
}

async function verifyPersistedPlan(client: pg.Client, plan: RequestRow): Promise<void> {
  const result = await client.query<PlanEntryRow>(
    `SELECT entry_key AS "entryKey", ordinal, index_name AS "indexName",
            physical_signature AS "physicalSignature",
            definition_digest AS "definitionDigest", definition
     FROM runtime.index_plan_entries
     WHERE project_id = $1::uuid AND index_plan_id = $2::uuid
     ORDER BY ordinal`,
    [plan.projectId, plan.indexPlanId],
  );
  if (result.rows.length !== plan.entryCount) {
    throw new ProjectionDdlExecutorError("DDL_PLAN_INVALID");
  }
  const definitions = result.rows.map((row, ordinal) => {
    if (row.ordinal !== ordinal) throw new ProjectionDdlExecutorError("DDL_PLAN_INVALID");
    const definition = parseDefinition(row.definition);
    const digest = digestDefinition(definition);
    if (
      digest !== row.definitionDigest ||
      definition.name !== row.indexName ||
      definition.physicalSignature !== row.physicalSignature
    ) {
      throw new ProjectionDdlExecutorError("DDL_PLAN_DIGEST_MISMATCH");
    }
    return definition;
  });
  const actualPlanDigest = calculateObjectTypeIndexPlanDigest(
    plan.targetResourceId,
    plan.targetRevisionId,
    definitions,
    sha256,
  );
  if (actualPlanDigest !== plan.planDigest) {
    throw new ProjectionDdlExecutorError("DDL_PLAN_DIGEST_MISMATCH", {
      cause: new Error(
        JSON.stringify({
          actualPlanDigest,
          expectedPlanDigest: plan.planDigest,
          signatures: definitions.map((definition) => definition.physicalSignature),
        }),
      ),
    });
  }
}

function parseDefinition(value: unknown): CompiledIndexDefinition {
  try {
    if (!isRecord(value) || !isRecord(value.predicate) || !Array.isArray(value.keys)) {
      throw new Error("shape");
    }
    const definition = value as unknown as CompiledIndexDefinition;
    validateCompiledIndexDefinition(definition, sha256);
    return definition;
  } catch (error) {
    if (error instanceof ProjectionDdlExecutorError) throw error;
    throw new ProjectionDdlExecutorError("DDL_PLAN_INVALID", { cause: error });
  }
}

async function assertInventoryRevision(client: pg.Client, plan: RequestRow): Promise<void> {
  const result = await client.query<{ readonly inventoryRevision: string }>(
    `SELECT inventory_revision::text AS "inventoryRevision"
     FROM runtime.project_runtime_inventories
     WHERE project_id = $1::uuid`,
    [plan.projectId],
  );
  if (result.rows[0]?.inventoryRevision !== plan.inventoryRevision) {
    throw new ProjectionDdlExecutorError("DDL_PLAN_STALE");
  }
}

async function verifyGcDropAuthorization(client: pg.Client, plan: RequestRow): Promise<void> {
  if (plan.gcPlanId === null || plan.gcPlanDigest === null) {
    throw new ProjectionDdlExecutorError("DDL_DROP_NOT_AUTHORIZED");
  }
  try {
    await client.query("SELECT ontos_migration.g20212_assert_plan_current($1::uuid, $2::uuid)", [
      plan.projectId,
      plan.gcPlanId,
    ]);
  } catch (error) {
    if (
      isRecord(error) &&
      (error.code === "40001" || String(error.message).includes("GC_PLAN_STALE"))
    ) {
      throw new ProjectionDdlExecutorError("DDL_PLAN_STALE", { cause: error });
    }
    throw error;
  }
  const result = await client.query<{ readonly authorized: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM ops.gc_plans AS gc_plan
       JOIN ops.gc_plan_entries AS gc_entry
         ON gc_entry.project_id = gc_plan.project_id
        AND gc_entry.gc_plan_id = gc_plan.gc_plan_id
       JOIN runtime.index_inventory AS inventory
         ON inventory.project_id = gc_entry.project_id
        AND inventory.physical_signature = gc_entry.entry_key
       WHERE gc_plan.project_id = $1::uuid
         AND gc_plan.gc_plan_id = $2::uuid
         AND gc_plan.plan_digest = $3
         AND gc_plan.state IN ('committing', 'waiting_for_index_ddl')
         AND gc_entry.entry_kind = 'INDEX'
         AND gc_entry.entry_key = $4
         AND gc_entry.disposition = 'CANDIDATE'
         AND gc_entry.completed_at IS NULL
         AND inventory.index_plan_id = $5::uuid
         AND inventory.entry_key = $6
         AND inventory.index_name = $7
         AND inventory.state = 'ready'
     ) AS authorized`,
    [
      plan.projectId,
      plan.gcPlanId,
      plan.gcPlanDigest,
      plan.physicalSignature,
      plan.indexPlanId,
      plan.entryKey,
      plan.indexName,
    ],
  );
  if (result.rows[0]?.authorized !== true) {
    throw new ProjectionDdlExecutorError("DDL_DROP_NOT_AUTHORIZED");
  }
}

async function reconcileCreate(
  client: pg.Client,
  definition: CompiledIndexDefinition,
): Promise<{ readonly outcome: "CREATED" | "REUSED"; readonly catalog: CatalogIndex }> {
  const existing = await inspectIndex(client, definition.name);
  if (existing !== null) {
    assertCatalogDefinition(definition, existing, true);
    if (existing.row.valid && existing.row.ready) {
      await ensureSignatureComment(client, definition, existing.row.signatureComment);
      const verified = await inspectIndex(client, definition.name);
      if (verified === null)
        throw new ProjectionDdlExecutorError("DDL_CATALOG_VERIFICATION_FAILED");
      assertCatalogDefinition(definition, verified, false);
      return { outcome: "REUSED", catalog: verified };
    }
    await client.query(
      `DROP INDEX CONCURRENTLY ${quoteIdentifier("runtime")}.${quoteIdentifier(definition.name)}`,
    );
  }
  await client.query(createIndexSql(definition));
  await client.query(commentSql(definition));
  const created = await inspectIndex(client, definition.name);
  if (created === null) throw new ProjectionDdlExecutorError("DDL_CATALOG_VERIFICATION_FAILED");
  assertCatalogDefinition(definition, created, false);
  return { outcome: "CREATED", catalog: created };
}

async function reconcileDrop(
  client: pg.Client,
  definition: CompiledIndexDefinition,
): Promise<{ readonly outcome: "DROPPED" | "ABSENT" }> {
  const existing = await inspectIndex(client, definition.name);
  if (existing === null) return { outcome: "ABSENT" };
  assertCatalogDefinition(definition, existing, false);
  await client.query(
    `DROP INDEX CONCURRENTLY ${quoteIdentifier("runtime")}.${quoteIdentifier(definition.name)}`,
  );
  if ((await inspectIndex(client, definition.name)) !== null) {
    throw new ProjectionDdlExecutorError("DDL_CATALOG_VERIFICATION_FAILED");
  }
  return { outcome: "DROPPED" };
}

async function inspectIndex(client: pg.Client, indexName: string): Promise<CatalogIndex | null> {
  const result = await client.query<CatalogRow>(
    `SELECT index_class.oid::text, index_namespace.nspname AS "indexSchema",
            index_class.relname AS "indexName", table_namespace.nspname AS "tableSchema",
            table_class.relname AS "tableName", access_method.amname AS "accessMethod",
            index_catalog.indisunique AS unique, index_catalog.indisvalid AS valid,
            index_catalog.indisready AS ready,
            index_catalog.indnkeyatts::integer AS "keyCount",
            pg_get_expr(index_catalog.indpred, index_catalog.indrelid, true) AS predicate,
            obj_description(index_class.oid, 'pg_class') AS "signatureComment",
            pg_relation_size(index_class.oid)::text AS "observedBytes"
     FROM pg_class AS index_class
     JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
     JOIN pg_index AS index_catalog ON index_catalog.indexrelid = index_class.oid
     JOIN pg_class AS table_class ON table_class.oid = index_catalog.indrelid
     JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
     JOIN pg_am AS access_method ON access_method.oid = index_class.relam
     WHERE index_namespace.nspname = 'runtime' AND index_class.relname = $1`,
    [indexName],
  );
  const row = result.rows[0];
  if (result.rows.length === 0 || row === undefined) return null;
  if (result.rows.length !== 1) {
    throw new ProjectionDdlExecutorError("DDL_CATALOG_VERIFICATION_FAILED");
  }
  const keys = await client.query<CatalogKeyRow>(
    `SELECT position, pg_get_indexdef($1::oid, position, true) AS definition,
            opclass_namespace.nspname AS "opclassSchema",
            opclass.opcname AS "opclassName",
            collation_namespace.nspname AS "collationSchema",
            index_collation.collname AS "collationName",
            index_collation.collprovider AS "collationProvider",
            index_collation.collisdeterministic AS "collationDeterministic",
            index_catalog.indoption[position - 1]::integer AS options
     FROM pg_index AS index_catalog
     CROSS JOIN LATERAL generate_series(1, index_catalog.indnkeyatts) AS position
     JOIN pg_opclass AS opclass ON opclass.oid = index_catalog.indclass[position - 1]
     JOIN pg_namespace AS opclass_namespace ON opclass_namespace.oid = opclass.opcnamespace
     LEFT JOIN pg_collation AS index_collation
       ON index_collation.oid = index_catalog.indcollation[position - 1]
     LEFT JOIN pg_namespace AS collation_namespace
       ON collation_namespace.oid = index_collation.collnamespace
     WHERE index_catalog.indexrelid = $1::oid
     ORDER BY position`,
    [row.oid],
  );
  return Object.freeze({ row, keys: Object.freeze(keys.rows) });
}

function assertCatalogDefinition(
  definition: CompiledIndexDefinition,
  catalog: CatalogIndex,
  allowInvalid: boolean,
): void {
  const expectedKeys = expectedCatalogKeys(definition);
  const expectedOpclasses = expectedCatalogOpclasses(definition);
  const expectedComment = `${signatureCommentPrefix}${definition.physicalSignature}`;
  const matches =
    catalog.row.indexSchema === "runtime" &&
    catalog.row.indexName === definition.name &&
    catalog.row.tableSchema === "runtime" &&
    catalog.row.tableName === "object_current" &&
    catalog.row.accessMethod === (definition.kind === "btree" ? "btree" : "gin") &&
    catalog.row.unique === definition.unique &&
    catalog.row.keyCount === expectedKeys.length &&
    catalog.keys.length === expectedKeys.length &&
    catalog.keys.every(
      (key, index) =>
        normalizeSql(key.definition) === normalizeSql(required(expectedKeys[index])) &&
        `${key.opclassSchema}.${key.opclassName}` === expectedOpclasses[index] &&
        catalogCollation(key) === expectedCatalogCollations(definition)[index] &&
        key.options === expectedCatalogOptions(definition)[index],
    ) &&
    normalizeSql(catalog.row.predicate ?? "") === normalizeSql(expectedPredicate(definition)) &&
    (catalog.row.signatureComment === null || catalog.row.signatureComment === expectedComment) &&
    (allowInvalid || (catalog.row.valid && catalog.row.ready));
  if (!matches) {
    throw new ProjectionDdlExecutorError("DDL_INDEX_DEFINITION_MISMATCH", {
      cause: new Error(
        JSON.stringify({
          actualKeys: catalog.keys.map((key) => key.definition),
          expectedKeys,
          normalizedActualKeys: catalog.keys.map((key) => normalizeSql(key.definition)),
          normalizedExpectedKeys: expectedKeys.map(normalizeSql),
          actualOpclasses: catalog.keys.map((key) => `${key.opclassSchema}.${key.opclassName}`),
          expectedOpclasses,
          actualCollations: catalog.keys.map(catalogCollation),
          expectedCollations: expectedCatalogCollations(definition),
          actualOptions: catalog.keys.map((key) => key.options),
          expectedOptions: expectedCatalogOptions(definition),
          actualPredicate: catalog.row.predicate,
          expectedPredicate: expectedPredicate(definition),
          normalizedActualPredicate: normalizeSql(catalog.row.predicate ?? ""),
          normalizedExpectedPredicate: normalizeSql(expectedPredicate(definition)),
        }),
      ),
    });
  }
}

function expectedCatalogOptions(definition: CompiledIndexDefinition): number[] {
  if (definition.kind !== "btree") return definition.keys.map(() => 0);
  // PostgreSQL encodes DESC + its default NULLS FIRST as bits 1 | 2.
  const options = [
    ...(definition.unique ? [0, 0] : []),
    ...definition.keys.map((key) => (key.direction === "DESC" ? 3 : 0)),
  ];
  if (!definition.unique) options.push(0);
  return options;
}

function createIndexSql(definition: CompiledIndexDefinition): string {
  const unique = definition.unique ? "UNIQUE " : "";
  const method = definition.kind === "btree" ? "btree" : "gin";
  return `CREATE ${unique}INDEX CONCURRENTLY ${quoteIdentifier(definition.name)}
ON ${quoteIdentifier("runtime")}.${quoteIdentifier("object_current")} USING ${method}
(${expectedCatalogKeys(definition).join(", ")})
WHERE ${expectedPredicate(definition)}`;
}

function expectedCatalogKeys(definition: CompiledIndexDefinition): string[] {
  if (definition.kind === "gin_trigram") {
    return [
      `((${propertyExpression(required(definition.keys[0]))}) COLLATE "C") runtime.gin_trgm_ops`,
    ];
  }
  if (definition.kind === "gin_array") {
    const key = required(definition.keys[0]);
    return [`(${arrayPropertyExpression(key.propertyId)}) pg_catalog.jsonb_path_ops`];
  }
  const keys = [
    ...(definition.unique ? ["project_id", "generation_id"] : []),
    ...definition.keys.map((key) => {
      const direction = key.direction === "DESC" ? " DESC" : "";
      return `(${typedPropertyExpression(key)})${direction}`;
    }),
  ];
  if (!definition.unique) keys.push(`canonical_primary_key COLLATE "C"`);
  return keys;
}

function expectedCatalogCollations(definition: CompiledIndexDefinition): (string | null)[] {
  if (definition.kind === "gin_trigram") return ["pg_catalog.C:c:true"];
  if (definition.kind === "gin_array") return [null];
  const collations = [
    ...(definition.unique ? [null, null] : []),
    ...definition.keys.map((key) =>
      key.valueType === "string" || key.valueType === "enum" ? "pg_catalog.C:c:true" : null,
    ),
  ];
  if (!definition.unique) collations.push("pg_catalog.C:c:true");
  return collations;
}

function catalogCollation(key: CatalogKeyRow): string | null {
  if (
    key.collationSchema === null ||
    key.collationName === null ||
    key.collationProvider === null ||
    key.collationDeterministic === null
  ) {
    return null;
  }
  return `${key.collationSchema}.${key.collationName}:${key.collationProvider}:${String(key.collationDeterministic)}`;
}

function expectedCatalogOpclasses(definition: CompiledIndexDefinition): string[] {
  if (definition.kind === "gin_trigram") return ["runtime.gin_trgm_ops"];
  if (definition.kind === "gin_array") return ["pg_catalog.jsonb_path_ops"];
  const opclasses = [
    ...(definition.unique ? ["pg_catalog.uuid_ops", "pg_catalog.uuid_ops"] : []),
    ...definition.keys.map((key) => {
      switch (key.valueType) {
        case "string":
        case "enum":
          return "pg_catalog.text_ops";
        case "integer":
          return "pg_catalog.int8_ops";
        case "decimal":
          return "pg_catalog.numeric_ops";
        case "date":
          return "pg_catalog.date_ops";
        case "timestamp":
          return "pg_catalog.timestamptz_ops";
        case "boolean":
          return "pg_catalog.bool_ops";
        case "string[]":
        case "json":
          throw new ProjectionDdlExecutorError("DDL_PLAN_INVALID");
      }
    }),
  ];
  if (!definition.unique) opclasses.push("pg_catalog.text_ops");
  return opclasses;
}

function typedPropertyExpression(key: CompiledIndexDefinition["keys"][number]): string {
  const expression = propertyExpression(key);
  switch (key.valueType) {
    case "string":
    case "enum":
      return `${expression} COLLATE "C"`;
    case "integer":
      return `${expression}::bigint`;
    case "decimal":
      return `${expression}::numeric`;
    case "date":
      return `runtime.ontos_index_date(${expression})`;
    case "timestamp":
      return `runtime.ontos_index_timestamp(${expression})`;
    case "boolean":
      return `${expression}::boolean`;
    case "string[]":
    case "json":
      throw new ProjectionDdlExecutorError("DDL_PLAN_INVALID");
  }
}

function propertyExpression(key: CompiledIndexDefinition["keys"][number]): string {
  const property = quoteLiteral(`{values,${key.propertyId},value}`);
  if (key.jsonPath === undefined) return `(properties #>> ${property}::text[])`;
  const field = key.jsonPath.slice(2);
  return `(((properties #>> ${quoteLiteral(`{values,${key.propertyId},value,canonicalJson}`)}::text[]))::jsonb #>> ${quoteLiteral(`{${field}}`)}::text[])`;
}

function arrayPropertyExpression(propertyId: string): string {
  return `(properties #> ${quoteLiteral(`{values,${propertyId},value}`)}::text[])`;
}

function expectedPredicate(definition: CompiledIndexDefinition): string {
  return `object_type_resource_id = ${quoteLiteral(definition.resourceId)}::uuid
AND object_type_revision_id = ${quoteLiteral(definition.revisionId)}::uuid
AND lifecycle_state = 'active'::text`;
}

async function ensureSignatureComment(
  client: pg.Client,
  definition: CompiledIndexDefinition,
  comment: string | null,
): Promise<void> {
  if (comment === null) await client.query(commentSql(definition));
}

function commentSql(definition: CompiledIndexDefinition): string {
  return `COMMENT ON INDEX ${quoteIdentifier("runtime")}.${quoteIdentifier(definition.name)} IS ${quoteLiteral(`${signatureCommentPrefix}${definition.physicalSignature}`)}`;
}

async function markSucceeded(
  client: pg.Client,
  plan: RequestRow,
  catalogDigest: string,
  observedBytes: string,
  outcome: ProjectionDdlExecutionResult["outcome"],
): Promise<void> {
  await client.query("BEGIN");
  try {
    if (plan.action === "CREATE") {
      await client.query(
        `UPDATE runtime.index_inventory
         SET state = 'ready', catalog_digest = $3, observed_bytes = $4,
             last_result_code = 'DDL_READY', catalog_scanned_at = clock_timestamp(),
             changed_at = clock_timestamp()
         WHERE project_id = $1::uuid AND index_name = $2`,
        [plan.projectId, plan.indexName, catalogDigest, observedBytes],
      );
    } else {
      const revision = await client.query<{ readonly inventoryRevision: string }>(
        `UPDATE runtime.project_runtime_inventories
         SET inventory_revision = inventory_revision + 1,
             measurement_complete = false, inventory_digest = NULL,
             changed_at = clock_timestamp()
         WHERE project_id = $1::uuid
         RETURNING inventory_revision::text AS "inventoryRevision"`,
        [plan.projectId],
      );
      const nextRevision = required(revision.rows[0]).inventoryRevision;
      await client.query(
        `UPDATE runtime.index_inventory
         SET state = 'retired', inventory_revision = $3::bigint,
             catalog_digest = $4, observed_bytes = 0,
             last_result_code = $5, catalog_scanned_at = clock_timestamp(),
             changed_at = clock_timestamp()
         WHERE project_id = $1::uuid AND index_name = $2 AND state = 'ready'`,
        [plan.projectId, plan.indexName, nextRevision, catalogDigest, `DDL_${outcome}`],
      );
      await client.query(
        `UPDATE ops.gc_plans
         SET current_inventory_revision = $3::bigint, changed_at = clock_timestamp()
         WHERE project_id = $1::uuid AND gc_plan_id = $2::uuid
           AND state = 'waiting_for_index_ddl'`,
        [plan.projectId, plan.gcPlanId, nextRevision],
      );
    }
    await client.query(
      `UPDATE ops.projection_ddl_requests
       SET state = 'SUCCEEDED', last_result_code = $4,
           catalog_digest = $3, finished_at = clock_timestamp()
       WHERE project_id = $1::uuid AND request_id = $2::uuid`,
      [
        plan.projectId,
        plan.requestId,
        catalogDigest,
        plan.action === "CREATE" ? "DDL_READY" : `DDL_${outcome}`,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function markFailedQuietly(
  client: pg.Client,
  plan: RequestRow,
  code: ProjectionDdlErrorCode,
): Promise<void> {
  try {
    await client.query("BEGIN");
    if (plan.action === "CREATE") {
      await client.query(
        `UPDATE runtime.index_inventory
         SET state = 'failed', catalog_digest = NULL, observed_bytes = NULL,
             last_result_code = $3, catalog_scanned_at = clock_timestamp(),
             changed_at = clock_timestamp()
         WHERE project_id = $1::uuid AND index_name = $2`,
        [plan.projectId, plan.indexName, code],
      );
    }
    await client.query(
      `UPDATE ops.projection_ddl_requests
       SET state = 'FAILED', last_result_code = $3,
           catalog_digest = NULL,
           started_at = COALESCE(started_at, clock_timestamp()),
           finished_at = clock_timestamp()
       WHERE project_id = $1::uuid AND request_id = $2::uuid`,
      [plan.projectId, plan.requestId, code],
    );
    if (plan.action === "DROP" && code === "DDL_PLAN_STALE" && plan.gcPlanId !== null) {
      await client.query(
        `UPDATE ops.gc_plans SET state = 'stale', changed_at = clock_timestamp()
         WHERE project_id = $1::uuid AND gc_plan_id = $2::uuid
           AND state IN ('committing', 'waiting_for_index_ddl')`,
        [plan.projectId, plan.gcPlanId],
      );
      await client.query(
        `UPDATE ops.gc_runs AS run SET state = 'stale', result_code = 'GC_PLAN_STALE',
                changed_at = clock_timestamp()
         FROM ops.gc_plans AS gc_plan
         WHERE gc_plan.project_id = $1::uuid AND gc_plan.gc_plan_id = $2::uuid
           AND run.project_id = gc_plan.project_id AND run.gc_run_id = gc_plan.gc_run_id
           AND run.state IN ('committing', 'waiting_for_index_ddl')`,
        [plan.projectId, plan.gcPlanId],
      );
    }
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    // A killed connection intentionally leaves RUNNING/building for catalog-based replay.
  }
}

async function tryLock(client: pg.Client, name: string): Promise<boolean> {
  const result = await client.query<{ readonly locked: boolean }>(
    "SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked",
    [advisoryNamespace, name],
  );
  return result.rows[0]?.locked === true;
}

async function unlockQuietly(client: pg.Client, name: string): Promise<void> {
  await client
    .query("SELECT pg_advisory_unlock($1, hashtext($2))", [advisoryNamespace, name])
    .catch(() => undefined);
}

function digestDefinition(definition: CompiledIndexDefinition): string {
  return sha256(canonicalizeContractForDigest(definitionForPersistence(definition)));
}

function digestCatalog(plan: RequestRow, catalog: CatalogIndex): string {
  return sha256(
    canonicalizeContractForDigest({
      schemaVersion: 1,
      requestId: plan.requestId,
      planDigest: plan.planDigest,
      definitionDigest: plan.definitionDigest,
      indexName: catalog.row.indexName,
      accessMethod: catalog.row.accessMethod,
      unique: catalog.row.unique,
      valid: catalog.row.valid,
      ready: catalog.row.ready,
      predicate: normalizeSql(catalog.row.predicate ?? ""),
      keys: catalog.keys.map((key) => ({
        definition: normalizeSql(key.definition),
        opclass: `${key.opclassSchema}.${key.opclassName}`,
      })),
      signatureComment: catalog.row.signatureComment,
      observedBytes: catalog.row.observedBytes,
    }),
  );
}

function digestDroppedCatalog(plan: RequestRow, outcome: "DROPPED" | "ABSENT"): string {
  return sha256(
    canonicalizeContractForDigest({
      schemaVersion: 1,
      contractVersion: "projection-index-drop-v1",
      requestId: plan.requestId,
      gcPlanId: plan.gcPlanId,
      gcPlanDigest: plan.gcPlanDigest,
      indexPlanDigest: plan.planDigest,
      definitionDigest: plan.definitionDigest,
      physicalSignature: plan.physicalSignature,
      indexName: plan.indexName,
      outcome,
      catalogPresent: false,
      observedBytes: "0",
    }),
  );
}

function replayDrop(plan: RequestRow): ProjectionDdlExecutionResult {
  if (
    plan.catalogDigest === null ||
    (plan.lastResultCode !== "DDL_DROPPED" && plan.lastResultCode !== "DDL_ABSENT")
  ) {
    throw new ProjectionDdlExecutorError("DDL_PLAN_INVALID");
  }
  return Object.freeze({
    projectId: plan.projectId,
    requestId: plan.requestId,
    indexName: plan.indexName,
    outcome: plan.lastResultCode === "DDL_DROPPED" ? "DROPPED" : "ABSENT",
    attemptCount: plan.attemptCount,
    catalogDigest: plan.catalogDigest,
    observedBytes: 0n,
  });
}

function sha256(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}

function normalizeSql(value: string): string {
  return value
    .replaceAll(/\s+/gu, "")
    .replaceAll('"', "")
    .replaceAll(/[()]/gu, "")
    .replaceAll("pg_catalog.", "")
    .replaceAll("::text[]", "")
    .replaceAll("::text", "")
    .replaceAll("::uuid", "")
    .toLowerCase()
    .replaceAll("collatec", "")
    .replaceAll("runtime.gin_trgm_ops", "")
    .replaceAll("gin_trgm_ops", "")
    .replaceAll("jsonb_path_ops", "")
    .replace(/(?:asc|desc)(?:nullsfirst|nullslast)?$/u, "");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableError(error: unknown): ProjectionDdlExecutorError {
  if (error instanceof ProjectionDdlExecutorError) return error;
  if (
    isRecord(error) &&
    (error.code === "40001" || String(error.message).includes("GC_PLAN_STALE"))
  ) {
    return new ProjectionDdlExecutorError("DDL_PLAN_STALE", { cause: error });
  }
  return new ProjectionDdlExecutorError("DDL_EXECUTION_FAILED", { cause: error });
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new ProjectionDdlExecutorError("DDL_PLAN_INVALID");
  return value;
}
