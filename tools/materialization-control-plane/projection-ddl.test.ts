import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { compileReleaseIndexPlan } from "../projection-capacity/index-plan.ts";
import {
  parseProjectionDdlCliArgs,
  projectionDdlPlanDigest,
  ProjectionDdlError,
  validateProjectionDdlPlan,
  type ProjectionDdlPlan,
  type ProjectionDdlPlanImmutable,
} from "./projection-ddl.ts";

void test("DDL Plan digest is deterministic and binds every immutable execution field", () => {
  const immutable = planImmutable();
  assert.equal(
    projectionDdlPlanDigest(immutable),
    projectionDdlPlanDigest(structuredClone(immutable)),
  );
  assert.notEqual(
    projectionDdlPlanDigest({ ...immutable, inventoryRevision: "8" }),
    projectionDdlPlanDigest(immutable),
  );
  assert.notEqual(
    projectionDdlPlanDigest({ ...immutable, action: "DROP" }),
    projectionDdlPlanDigest(immutable),
  );
});

void test("DDL Plan must match the ADR-008 compiler and never carries Raw SQL", () => {
  const immutable = planImmutable();
  const plan: ProjectionDdlPlan = {
    ...immutable,
    state: "APPROVED",
    attemptCount: 0,
    planDigest: projectionDdlPlanDigest(immutable),
  };
  assert.doesNotThrow(() => validateProjectionDdlPlan(plan));
  assert.equal("sql" in plan, false);

  assertDdlError(
    () => validateProjectionDdlPlan({ ...plan, propertyKey: "status; DROP TABLE meta.projects" }),
    "DDL_PLAN_INVALID",
  );
  assertDdlError(
    () => validateProjectionDdlPlan({ ...plan, physicalSignature: "f".repeat(64) }),
    "DDL_PLAN_INVALID",
  );
  assertDdlError(
    () => validateProjectionDdlPlan({ ...plan, planDigest: `sha256:${"f".repeat(64)}` }),
    "DDL_PLAN_DIGEST_MISMATCH",
  );
});

void test("CLI accepts one persisted Plan ID and rejects SQL, URLs and extra flags", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(parseProjectionDdlCliArgs(["--plan-id", id]), id);
  assertDdlError(
    () => parseProjectionDdlCliArgs(["--sql", "DROP TABLE meta.projects"]),
    "DDL_INPUT_INVALID",
  );
  assertDdlError(
    () => parseProjectionDdlCliArgs(["--plan-id", id, "--database-url", "secret"]),
    "DDL_INPUT_INVALID",
  );
});

void test("CLI rejects arbitrary input without echoing it or requiring a database", () => {
  const cliPath = fileURLToPath(new URL("./projection-ddl-cli.ts", import.meta.url));
  const marker = "raw-sql-secret-marker";
  const result = spawnSync(process.execPath, [cliPath, "--sql", `DROP TABLE ${marker}`], {
    encoding: "utf8",
    env: {},
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes(marker), false);
  assert.equal(result.stderr.includes(marker), false);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    ok: false,
    planId: null,
    code: "DDL_INPUT_INVALID",
    message: "Projection DDL Executor accepts only one persisted Plan ID.",
  });
});

function planImmutable(): ProjectionDdlPlanImmutable {
  const requestId = "00000000-0000-4000-8000-000000000001";
  const projectId = "00000000-0000-4000-8000-000000000002";
  const objectTypeResourceId = "00000000-0000-4000-8000-000000000003";
  const objectTypeRevisionId = "00000000-0000-4000-8000-000000000004";
  const compiled = compileReleaseIndexPlan({
    projectId,
    releaseId: requestId,
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
    requestId,
    projectId,
    action: "CREATE",
    inventoryRevision: "7",
    indexName: compiled.name,
    targetTable: "runtime.object_current",
    recipe: "BTREE_TEXT",
    propertyKey: "status",
    objectTypeResourceId,
    objectTypeRevisionId,
    physicalSignature: compiled.physicalSignature,
    referenceCount: 1,
  };
}

function assertDdlError(action: () => unknown, code: string): void {
  assert.throws(action, (error) => error instanceof ProjectionDdlError && error.code === code);
}
