import { createHash } from "node:crypto";

import type pg from "pg";

import { compileReleaseIndexPlan } from "../projection-capacity/index-plan.ts";

export type ProjectionDdlErrorCode =
  | "DDL_CATALOG_VERIFICATION_FAILED"
  | "DDL_EXECUTION_FAILED"
  | "DDL_INDEX_BUSY"
  | "DDL_INDEX_DEFINITION_MISMATCH"
  | "DDL_INDEX_REFERENCED"
  | "DDL_INPUT_INVALID"
  | "DDL_PLAN_DIGEST_MISMATCH"
  | "DDL_PLAN_INVALID"
  | "DDL_PLAN_NOT_FOUND"
  | "DDL_PLAN_STALE";

export class ProjectionDdlError extends Error {
  readonly code: ProjectionDdlErrorCode;

  constructor(code: ProjectionDdlErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectionDdlError";
    this.code = code;
  }
}

export type ProjectionDdlAction = "CREATE" | "DROP";
export type ProjectionDdlOutcome = "ABSENT" | "CREATED" | "DROPPED" | "REUSED";

export interface ProjectionDdlPlanImmutable {
  readonly requestId: string;
  readonly projectId: string;
  readonly action: ProjectionDdlAction;
  readonly inventoryRevision: string;
  readonly indexName: string;
  readonly targetTable: "runtime.object_current";
  readonly recipe: "BTREE_TEXT";
  readonly propertyKey: string;
  readonly objectTypeResourceId: string;
  readonly objectTypeRevisionId: string;
  readonly physicalSignature: string;
  readonly referenceCount: number;
}

export interface ProjectionDdlPlan extends ProjectionDdlPlanImmutable {
  readonly state: "APPROVED" | "FAILED" | "RUNNING" | "SUCCEEDED";
  readonly planDigest: string;
  readonly attemptCount: number;
}

export interface ProjectionDdlResult {
  readonly requestId: string;
  readonly outcome: ProjectionDdlOutcome;
  readonly attemptCount: number;
  readonly catalogDigest: string;
}

interface CatalogIndex {
  readonly index_schema: string;
  readonly index_name: string;
  readonly table_schema: string;
  readonly table_name: string;
  readonly access_method: string;
  readonly is_unique: boolean;
  readonly is_valid: boolean;
  readonly is_ready: boolean;
  readonly key_count: number;
  readonly key_one: string | null;
  readonly key_two: string | null;
  readonly key_one_collation: string | null;
  readonly key_two_collation: string | null;
  readonly key_one_collation_schema: string | null;
  readonly key_two_collation_schema: string | null;
  readonly key_one_collation_provider: string | null;
  readonly key_two_collation_provider: string | null;
  readonly key_one_collation_deterministic: boolean | null;
  readonly key_two_collation_deterministic: boolean | null;
  readonly key_one_opclass: string | null;
  readonly key_two_opclass: string | null;
  readonly key_one_opclass_schema: string | null;
  readonly key_two_opclass_schema: string | null;
  readonly key_one_options: number | null;
  readonly key_two_options: number | null;
  readonly predicate: string | null;
  readonly signature_comment: string | null;
}

interface ProjectionDdlRequestRow {
  readonly request_id: string;
  readonly project_id: string;
  readonly action: string;
  readonly state: string;
  readonly inventory_revision: string;
  readonly plan_digest: string;
  readonly index_name: string;
  readonly target_table: string;
  readonly recipe: string;
  readonly property_key: string;
  readonly object_type_resource_id: string;
  readonly object_type_revision_id: string;
  readonly physical_signature: string;
  readonly reference_count: number;
  readonly attempt_count: number;
}

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const indexNamePattern = /^ok_oc_bt_[0-9a-f]{10}_[0-9a-f]{8}_[0-9a-f]{12}$/u;
const propertyKeyPattern = /^[a-z][a-z0-9_]{0,62}$/u;
const signaturePattern = /^[0-9a-f]{64}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const executorAdvisoryNamespace = 737_217_202;
const signatureCommentPrefix = "ontos:index-signature:";

export function projectionDdlPlanDigest(plan: ProjectionDdlPlanImmutable): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        1,
        plan.requestId,
        plan.projectId,
        plan.action,
        plan.inventoryRevision,
        plan.indexName,
        plan.targetTable,
        plan.recipe,
        plan.propertyKey,
        plan.objectTypeResourceId,
        plan.objectTypeRevisionId,
        plan.physicalSignature,
        plan.referenceCount,
      ]),
    )
    .digest("hex")}`;
}

export function validateProjectionDdlPlan(plan: ProjectionDdlPlan): void {
  if (
    !canonicalUuidPattern.test(plan.requestId) ||
    !canonicalUuidPattern.test(plan.projectId) ||
    !canonicalUuidPattern.test(plan.objectTypeResourceId) ||
    !canonicalUuidPattern.test(plan.objectTypeRevisionId) ||
    !/^(0|[1-9][0-9]*)$/u.test(plan.inventoryRevision) ||
    !indexNamePattern.test(plan.indexName) ||
    plan.targetTable !== "runtime.object_current" ||
    plan.recipe !== "BTREE_TEXT" ||
    !propertyKeyPattern.test(plan.propertyKey) ||
    plan.propertyKey === "canonical_primary_key" ||
    !signaturePattern.test(plan.physicalSignature) ||
    !Number.isSafeInteger(plan.referenceCount) ||
    plan.referenceCount < 0 ||
    !Number.isSafeInteger(plan.attemptCount) ||
    plan.attemptCount < 0 ||
    !["CREATE", "DROP"].includes(plan.action) ||
    !["APPROVED", "FAILED", "RUNNING", "SUCCEEDED"].includes(plan.state) ||
    !digestPattern.test(plan.planDigest)
  ) {
    throw new ProjectionDdlError(
      "DDL_PLAN_INVALID",
      "Projection DDL Plan contains a field outside the frozen contract.",
    );
  }

  const compiled = compileReleaseIndexPlan({
    projectId: plan.projectId,
    releaseId: plan.requestId,
    evidenceCatalog: ["ddl:projection-spike"],
    objectTypes: [
      {
        resourceId: plan.objectTypeResourceId,
        revisionId: plan.objectTypeRevisionId,
        properties: [
          { propertyId: "__ontos_primary_key", type: "string", primaryKey: true },
          { propertyId: plan.propertyKey, type: "string", filterable: true },
        ],
        indexes: [
          {
            kind: "btree",
            keys: [{ propertyId: plan.propertyKey, direction: "ASC" }],
            evidenceRefs: ["ddl:projection-spike"],
          },
        ],
      },
    ],
  }).indexes[0];
  if (
    compiled === undefined ||
    compiled.name !== plan.indexName ||
    compiled.physicalSignature !== plan.physicalSignature
  ) {
    throw new ProjectionDdlError(
      "DDL_PLAN_INVALID",
      "Projection DDL Plan name or signature does not match ADR-008 compilation.",
    );
  }
  if (projectionDdlPlanDigest(plan) !== plan.planDigest) {
    throw new ProjectionDdlError(
      "DDL_PLAN_DIGEST_MISMATCH",
      "Projection DDL Plan digest does not match its immutable fields.",
    );
  }
}

export function parseProjectionDdlCliArgs(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--plan-id" || !canonicalUuidPattern.test(args[1] ?? "")) {
    throw new ProjectionDdlError(
      "DDL_INPUT_INVALID",
      "Projection DDL Executor accepts only --plan-id followed by a canonical UUID.",
    );
  }
  return required(args[1]);
}

export async function executeProjectionDdlPlan(
  client: pg.Client,
  requestId: string,
): Promise<ProjectionDdlResult> {
  if (!canonicalUuidPattern.test(requestId)) {
    throw new ProjectionDdlError("DDL_INPUT_INVALID", "Projection DDL Plan ID is invalid.");
  }

  await client.query("SET application_name = 'ontos-projection-ddl-executor'");
  let plan: ProjectionDdlPlan | undefined;
  let lockHeld = false;
  try {
    plan = await claimPlan(client, requestId);
    lockHeld = await tryIndexLock(client, plan.indexName);
    if (!lockHeld) {
      throw new ProjectionDdlError(
        "DDL_INDEX_BUSY",
        "Another trusted Executor is reconciling this physical index.",
      );
    }

    plan = await reloadPlan(client, requestId);
    await assertInventoryRevision(client, plan);
    await assumeOwner(client);
    let execution: {
      readonly outcome: ProjectionDdlOutcome;
      readonly catalog: CatalogIndex | null;
    };
    try {
      execution =
        plan.action === "CREATE"
          ? await reconcileCreate(client, plan)
          : await reconcileDrop(client, plan);
    } finally {
      await resetOwner(client);
    }

    const catalogDigest = catalogStateDigest(plan, execution.catalog, execution.outcome);
    await markPlanSucceeded(client, plan.requestId, execution.outcome, catalogDigest);
    return {
      requestId: plan.requestId,
      outcome: execution.outcome,
      attemptCount: plan.attemptCount,
      catalogDigest,
    };
  } catch (cause) {
    const stable = stableDdlError(cause);
    await resetOwnerQuietly(client);
    await markPlanFailedQuietly(client, plan?.requestId ?? requestId, stable.code);
    throw stable;
  } finally {
    if (lockHeld && plan !== undefined) await unlockIndexQuietly(client, plan.indexName);
  }
}

async function claimPlan(client: pg.Client, requestId: string): Promise<ProjectionDdlPlan> {
  await client.query("BEGIN");
  try {
    const plan = await selectPlan(client, requestId, true);
    validateProjectionDdlPlan(plan);
    const updated = await client.query<{ readonly attempt_count: number }>(
      `UPDATE ops.projection_ddl_requests
       SET state = 'RUNNING', attempt_count = attempt_count + 1,
           last_result_code = NULL, catalog_digest = NULL,
           started_at = clock_timestamp(), finished_at = NULL
       WHERE request_id = $1::uuid
       RETURNING attempt_count`,
      [requestId],
    );
    await client.query("COMMIT");
    return { ...plan, state: "RUNNING", attemptCount: required(updated.rows[0]).attempt_count };
  } catch (cause) {
    await rollbackQuietly(client);
    throw cause;
  }
}

async function reloadPlan(client: pg.Client, requestId: string): Promise<ProjectionDdlPlan> {
  const plan = await selectPlan(client, requestId, false);
  validateProjectionDdlPlan(plan);
  return plan;
}

async function selectPlan(
  client: pg.Client,
  requestId: string,
  forUpdate: boolean,
): Promise<ProjectionDdlPlan> {
  const result = await client.query<ProjectionDdlRequestRow>(
    `SELECT request_id::text, project_id::text, action, state,
            inventory_revision::text, plan_digest, index_name::text,
            target_table, recipe, property_key,
            object_type_resource_id::text, object_type_revision_id::text,
            physical_signature, reference_count, attempt_count
     FROM ops.projection_ddl_requests
     WHERE request_id = $1::uuid${forUpdate ? " FOR UPDATE" : ""}`,
    [requestId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ProjectionDdlError("DDL_PLAN_NOT_FOUND", "Projection DDL Plan was not found.");
  }
  return rowToPlan(row);
}

function rowToPlan(row: ProjectionDdlRequestRow): ProjectionDdlPlan {
  return {
    requestId: row.request_id,
    projectId: row.project_id,
    action: row.action as ProjectionDdlAction,
    state: row.state as ProjectionDdlPlan["state"],
    inventoryRevision: row.inventory_revision,
    planDigest: row.plan_digest,
    indexName: row.index_name,
    targetTable: row.target_table as ProjectionDdlPlan["targetTable"],
    recipe: row.recipe as ProjectionDdlPlan["recipe"],
    propertyKey: row.property_key,
    objectTypeResourceId: row.object_type_resource_id,
    objectTypeRevisionId: row.object_type_revision_id,
    physicalSignature: row.physical_signature,
    referenceCount: row.reference_count,
    attemptCount: row.attempt_count,
  };
}

async function assertInventoryRevision(client: pg.Client, plan: ProjectionDdlPlan): Promise<void> {
  const result = await client.query<{ readonly inventory_revision: string }>(
    `SELECT inventory_revision::text
     FROM runtime.project_runtime_inventories
     WHERE project_id = $1::uuid`,
    [plan.projectId],
  );
  if (result.rows[0]?.inventory_revision !== plan.inventoryRevision) {
    throw new ProjectionDdlError(
      "DDL_PLAN_STALE",
      "Projection DDL Plan no longer matches the trusted physical inventory.",
    );
  }
}

async function tryIndexLock(client: pg.Client, indexName: string): Promise<boolean> {
  const result = await client.query<{ readonly locked: boolean }>(
    "SELECT pg_catalog.pg_try_advisory_lock($1, pg_catalog.hashtext($2)) AS locked",
    [executorAdvisoryNamespace, indexName],
  );
  return result.rows[0]?.locked === true;
}

async function unlockIndexQuietly(client: pg.Client, indexName: string): Promise<void> {
  try {
    await client.query("SELECT pg_catalog.pg_advisory_unlock($1, pg_catalog.hashtext($2))", [
      executorAdvisoryNamespace,
      indexName,
    ]);
  } catch {
    // The server releases session locks when a killed Executor connection disappears.
  }
}

async function assumeOwner(client: pg.Client): Promise<void> {
  await client.query("SET ROLE migration_owner");
  await client.query("SET search_path = pg_catalog");
  const role = await client.query<{ readonly current_user: string }>("SELECT current_user");
  if (role.rows[0]?.current_user !== "migration_owner") {
    throw new ProjectionDdlError(
      "DDL_EXECUTION_FAILED",
      "Trusted Projection DDL role could not be established.",
    );
  }
}

async function resetOwner(client: pg.Client): Promise<void> {
  await client.query("RESET ROLE");
  await client.query("RESET search_path");
}

async function resetOwnerQuietly(client: pg.Client): Promise<void> {
  try {
    await resetOwner(client);
  } catch {
    // Preserve the original stable error. A broken connection cannot retain a reusable role.
  }
}

async function reconcileCreate(
  client: pg.Client,
  plan: ProjectionDdlPlan,
): Promise<{ readonly outcome: "CREATED" | "REUSED"; readonly catalog: CatalogIndex }> {
  const existing = await inspectIndex(client, plan.indexName);
  if (existing !== null) {
    assertCatalogDefinition(plan, existing, true);
    if (existing.is_valid && existing.is_ready) {
      await ensureSignatureComment(client, plan, existing);
      const verified = await inspectIndex(client, plan.indexName);
      if (verified === null) {
        throw new ProjectionDdlError(
          "DDL_CATALOG_VERIFICATION_FAILED",
          "Reused Projection index disappeared during catalog verification.",
        );
      }
      assertCatalogDefinition(plan, verified, false);
      return { outcome: "REUSED", catalog: verified };
    }
    await dropIndexConcurrently(client, plan.indexName);
  }

  await client.query(createIndexSql(plan));
  await client.query(commentIndexSql(plan));
  const created = await inspectIndex(client, plan.indexName);
  if (created === null) {
    throw new ProjectionDdlError(
      "DDL_CATALOG_VERIFICATION_FAILED",
      "Created Projection index is missing from the trusted catalog.",
    );
  }
  assertCatalogDefinition(plan, created, false);
  return { outcome: "CREATED", catalog: created };
}

async function reconcileDrop(
  client: pg.Client,
  plan: ProjectionDdlPlan,
): Promise<{ readonly outcome: "ABSENT" | "DROPPED"; readonly catalog: null }> {
  if (plan.referenceCount !== 0) {
    throw new ProjectionDdlError(
      "DDL_INDEX_REFERENCED",
      "Projection index remains referenced by the trusted inventory.",
    );
  }
  const existing = await inspectIndex(client, plan.indexName);
  if (existing === null) return { outcome: "ABSENT", catalog: null };
  assertCatalogDefinition(plan, existing, true);
  await dropIndexConcurrently(client, plan.indexName);
  if ((await inspectIndex(client, plan.indexName)) !== null) {
    throw new ProjectionDdlError(
      "DDL_CATALOG_VERIFICATION_FAILED",
      "Dropped Projection index remains in the trusted catalog.",
    );
  }
  return { outcome: "DROPPED", catalog: null };
}

async function inspectIndex(client: pg.Client, indexName: string): Promise<CatalogIndex | null> {
  const result = await client.query<CatalogIndex>(
    `SELECT index_namespace.nspname AS index_schema,
            index_class.relname AS index_name,
            table_namespace.nspname AS table_schema,
            table_class.relname AS table_name,
            access_method.amname AS access_method,
            index_catalog.indisunique AS is_unique,
            index_catalog.indisvalid AS is_valid,
            index_catalog.indisready AS is_ready,
            index_catalog.indnkeyatts::integer AS key_count,
            pg_catalog.pg_get_indexdef(index_class.oid, 1, true) AS key_one,
            pg_catalog.pg_get_indexdef(index_class.oid, 2, true) AS key_two,
            key_one_collation.collname AS key_one_collation,
            key_two_collation.collname AS key_two_collation,
            key_one_collation_namespace.nspname AS key_one_collation_schema,
            key_two_collation_namespace.nspname AS key_two_collation_schema,
            key_one_collation.collprovider AS key_one_collation_provider,
            key_two_collation.collprovider AS key_two_collation_provider,
            key_one_collation.collisdeterministic AS key_one_collation_deterministic,
            key_two_collation.collisdeterministic AS key_two_collation_deterministic,
            key_one_opclass.opcname AS key_one_opclass,
            key_two_opclass.opcname AS key_two_opclass,
            key_one_opclass_namespace.nspname AS key_one_opclass_schema,
            key_two_opclass_namespace.nspname AS key_two_opclass_schema,
            index_catalog.indoption[0]::integer AS key_one_options,
            index_catalog.indoption[1]::integer AS key_two_options,
            pg_catalog.pg_get_expr(index_catalog.indpred, index_catalog.indrelid, true) AS predicate,
            pg_catalog.obj_description(index_class.oid, 'pg_class') AS signature_comment
     FROM pg_catalog.pg_class AS index_class
     JOIN pg_catalog.pg_namespace AS index_namespace
       ON index_namespace.oid = index_class.relnamespace
     JOIN pg_catalog.pg_index AS index_catalog
       ON index_catalog.indexrelid = index_class.oid
     JOIN pg_catalog.pg_class AS table_class
       ON table_class.oid = index_catalog.indrelid
     JOIN pg_catalog.pg_namespace AS table_namespace
       ON table_namespace.oid = table_class.relnamespace
     JOIN pg_catalog.pg_am AS access_method
       ON access_method.oid = index_class.relam
     LEFT JOIN pg_catalog.pg_collation AS key_one_collation
       ON key_one_collation.oid = index_catalog.indcollation[0]
     LEFT JOIN pg_catalog.pg_collation AS key_two_collation
       ON key_two_collation.oid = index_catalog.indcollation[1]
     LEFT JOIN pg_catalog.pg_namespace AS key_one_collation_namespace
       ON key_one_collation_namespace.oid = key_one_collation.collnamespace
     LEFT JOIN pg_catalog.pg_namespace AS key_two_collation_namespace
       ON key_two_collation_namespace.oid = key_two_collation.collnamespace
     LEFT JOIN pg_catalog.pg_opclass AS key_one_opclass
       ON key_one_opclass.oid = index_catalog.indclass[0]
     LEFT JOIN pg_catalog.pg_opclass AS key_two_opclass
       ON key_two_opclass.oid = index_catalog.indclass[1]
     LEFT JOIN pg_catalog.pg_namespace AS key_one_opclass_namespace
       ON key_one_opclass_namespace.oid = key_one_opclass.opcnamespace
     LEFT JOIN pg_catalog.pg_namespace AS key_two_opclass_namespace
       ON key_two_opclass_namespace.oid = key_two_opclass.opcnamespace
     WHERE index_namespace.nspname = 'runtime'
       AND index_class.relname = $1`,
    [indexName],
  );
  if (result.rows.length > 1) {
    throw new ProjectionDdlError(
      "DDL_CATALOG_VERIFICATION_FAILED",
      "Projection index catalog lookup was not unique.",
    );
  }
  return result.rows[0] ?? null;
}

function assertCatalogDefinition(
  plan: ProjectionDdlPlan,
  catalog: CatalogIndex,
  allowInvalid: boolean,
): void {
  const expectedComment = `${signatureCommentPrefix}${plan.physicalSignature}`;
  const structureMatches =
    catalog.index_schema === "runtime" &&
    catalog.index_name === plan.indexName &&
    catalog.table_schema === "runtime" &&
    catalog.table_name === "object_current" &&
    catalog.access_method === "btree" &&
    !catalog.is_unique &&
    catalog.key_count === 2 &&
    catalog.key_one !== null &&
    catalog.key_two !== null &&
    catalog.predicate !== null &&
    normalizeSql(catalog.key_one) === normalizeSql(`properties ->> '${plan.propertyKey}'::text`) &&
    normalizeSql(catalog.key_two) === normalizeSql(`canonical_primary_key`) &&
    catalog.key_one_collation === "C" &&
    catalog.key_two_collation === "C" &&
    catalog.key_one_collation_schema === "pg_catalog" &&
    catalog.key_two_collation_schema === "pg_catalog" &&
    catalog.key_one_collation_provider === "c" &&
    catalog.key_two_collation_provider === "c" &&
    catalog.key_one_collation_deterministic === true &&
    catalog.key_two_collation_deterministic === true &&
    catalog.key_one_opclass === "text_ops" &&
    catalog.key_two_opclass === "text_ops" &&
    catalog.key_one_opclass_schema === "pg_catalog" &&
    catalog.key_two_opclass_schema === "pg_catalog" &&
    catalog.key_one_options === 0 &&
    catalog.key_two_options === 0 &&
    normalizeSql(catalog.predicate) === normalizeSql(expectedPredicate(plan)) &&
    (catalog.signature_comment === null || catalog.signature_comment === expectedComment) &&
    (allowInvalid || (catalog.is_valid && catalog.is_ready));
  if (!structureMatches) {
    throw new ProjectionDdlError(
      "DDL_INDEX_DEFINITION_MISMATCH",
      "Existing index does not exactly match the persisted Projection DDL Plan.",
      {
        cause: new Error(
          JSON.stringify({
            scope: [
              catalog.index_schema,
              catalog.index_name,
              catalog.table_schema,
              catalog.table_name,
              catalog.access_method,
            ],
            flags: [
              catalog.is_unique,
              catalog.is_valid,
              catalog.is_ready,
              catalog.key_count,
              catalog.key_one_collation,
              catalog.key_two_collation,
              catalog.key_one_collation_schema,
              catalog.key_two_collation_schema,
              catalog.key_one_collation_provider,
              catalog.key_two_collation_provider,
              catalog.key_one_collation_deterministic,
              catalog.key_two_collation_deterministic,
              catalog.key_one_opclass,
              catalog.key_two_opclass,
              catalog.key_one_opclass_schema,
              catalog.key_two_opclass_schema,
              catalog.key_one_options,
              catalog.key_two_options,
            ],
            normalizedDefinition: [
              normalizeSqlNullable(catalog.key_one),
              normalizeSqlNullable(catalog.key_two),
              normalizeSqlNullable(catalog.predicate),
            ],
            expectedDefinition: [
              normalizeSql(`properties ->> '${plan.propertyKey}'::text`),
              normalizeSql(`canonical_primary_key`),
              normalizeSql(expectedPredicate(plan)),
            ],
            signatureCommentMatches:
              catalog.signature_comment === null || catalog.signature_comment === expectedComment,
          }),
        ),
      },
    );
  }
}

async function ensureSignatureComment(
  client: pg.Client,
  plan: ProjectionDdlPlan,
  catalog: CatalogIndex,
): Promise<void> {
  if (catalog.signature_comment === null) await client.query(commentIndexSql(plan));
}

function createIndexSql(plan: ProjectionDdlPlan): string {
  return `CREATE INDEX CONCURRENTLY ${quoteIdentifier(plan.indexName)}
ON ${quoteIdentifier("runtime")}.${quoteIdentifier("object_current")} USING btree
(((properties ->> ${quoteLiteral(plan.propertyKey)}) COLLATE "C"),
 (canonical_primary_key COLLATE "C"))
WHERE ${expectedPredicate(plan)}`;
}

function expectedPredicate(plan: ProjectionDdlPlan): string {
  return `object_type_resource_id = ${quoteLiteral(plan.objectTypeResourceId)}::uuid
AND object_type_revision_id = ${quoteLiteral(plan.objectTypeRevisionId)}::uuid
AND lifecycle_state = 'active'::text`;
}

function commentIndexSql(plan: ProjectionDdlPlan): string {
  return `COMMENT ON INDEX ${quoteIdentifier("runtime")}.${quoteIdentifier(plan.indexName)} IS ${quoteLiteral(`${signatureCommentPrefix}${plan.physicalSignature}`)}`;
}

async function dropIndexConcurrently(client: pg.Client, indexName: string): Promise<void> {
  await client.query(
    `DROP INDEX CONCURRENTLY ${quoteIdentifier("runtime")}.${quoteIdentifier(indexName)}`,
  );
}

function normalizeSql(value: string): string {
  return value
    .replaceAll(/\s+/gu, "")
    .replaceAll(/[()]/gu, "")
    .replaceAll(/::(?:text|uuid)/giu, "")
    .toLowerCase();
}

function normalizeSqlNullable(value: string | null): string | null {
  return value === null ? null : normalizeSql(value);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function catalogStateDigest(
  plan: ProjectionDdlPlan,
  catalog: CatalogIndex | null,
  outcome: ProjectionDdlOutcome,
): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        1,
        plan.requestId,
        plan.planDigest,
        outcome,
        catalog === null
          ? null
          : [
              catalog.index_schema,
              catalog.index_name,
              catalog.table_schema,
              catalog.table_name,
              catalog.access_method,
              catalog.is_unique,
              catalog.is_valid,
              catalog.is_ready,
              catalog.key_count,
              catalog.key_one_collation,
              catalog.key_two_collation,
              catalog.key_one_collation_schema,
              catalog.key_two_collation_schema,
              catalog.key_one_collation_provider,
              catalog.key_two_collation_provider,
              catalog.key_one_collation_deterministic,
              catalog.key_two_collation_deterministic,
              catalog.key_one_opclass,
              catalog.key_two_opclass,
              catalog.key_one_opclass_schema,
              catalog.key_two_opclass_schema,
              catalog.key_one_options,
              catalog.key_two_options,
              normalizeSqlNullable(catalog.key_one),
              normalizeSqlNullable(catalog.key_two),
              normalizeSqlNullable(catalog.predicate),
              catalog.signature_comment,
            ],
      ]),
    )
    .digest("hex")}`;
}

async function markPlanSucceeded(
  client: pg.Client,
  requestId: string,
  outcome: ProjectionDdlOutcome,
  catalogDigest: string,
): Promise<void> {
  await client.query(
    `UPDATE ops.projection_ddl_requests
     SET state = 'SUCCEEDED', last_result_code = $2,
         catalog_digest = $3, finished_at = clock_timestamp()
     WHERE request_id = $1::uuid`,
    [requestId, `DDL_${outcome}`, catalogDigest],
  );
}

async function markPlanFailedQuietly(
  client: pg.Client,
  requestId: string,
  code: ProjectionDdlErrorCode,
): Promise<void> {
  try {
    await client.query(
      `UPDATE ops.projection_ddl_requests
       SET state = 'FAILED', last_result_code = $2,
           catalog_digest = NULL, finished_at = clock_timestamp()
       WHERE request_id = $1::uuid`,
      [requestId, code],
    );
  } catch {
    // A killed or broken Executor intentionally leaves RUNNING for catalog-based replay.
  }
}

function stableDdlError(cause: unknown): ProjectionDdlError {
  if (cause instanceof ProjectionDdlError) return cause;
  return new ProjectionDdlError(
    "DDL_EXECUTION_FAILED",
    "Projection DDL execution failed without exposing database or credential details.",
    { cause },
  );
}

async function rollbackQuietly(client: pg.Client): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original stable error.
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new ProjectionDdlError(
      "DDL_EXECUTION_FAILED",
      "Projection DDL Executor received an incomplete trusted result.",
    );
  }
  return value;
}
