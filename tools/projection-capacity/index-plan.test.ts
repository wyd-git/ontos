import assert from "node:assert/strict";
import test from "node:test";

import { capacityProjectId, g1ShapedReleaseIndexPlan } from "./fixtures.ts";
import {
  IndexPlanError,
  admitIndexPlan,
  compileReleaseIndexPlan,
  type IndexCapacityApproval,
  type ObjectTypeIndexPlanInput,
} from "./index-plan.ts";

const INDEX_DAY_IN_MS = 24 * 60 * 60 * 1_000;

void test("G1-shaped explicit capabilities compile below Release budget with stable names", () => {
  const input = g1ShapedReleaseIndexPlan("r1", "revision-a");
  const compiled = compileReleaseIndexPlan(input);
  const renamed = structuredClone(input);
  for (const objectType of renamed.objectTypes) objectType.displayName = "Renamed by a Builder";
  const compiledRenamed = compileReleaseIndexPlan(renamed);

  assert.equal(compiled.secondaryIndexUnits, 60);
  assert.equal(compiled.physicalIndexCount, 35);
  assert.deepEqual(
    compiled.indexes.map((index) => index.name),
    compiledRenamed.indexes.map((index) => index.name),
  );
  assert.equal(
    compiled.indexes.every((index) => Buffer.byteLength(index.name) <= 63),
    true,
  );
  assert.equal(
    compiled.indexes.some((index) => index.keys.some((key) => key.propertyId === "sensitiveCode")),
    false,
  );
  assert.equal(admitIndexPlan(compiled, completeInventory(), 0).accepted, true);
});

void test("declared query capabilities cannot be silently omitted from the Index Plan", () => {
  const input = g1ShapedReleaseIndexPlan("r1", "revision-a", 1);
  const original = required(input.objectTypes[0]);
  const objectType: ObjectTypeIndexPlanInput = {
    ...original,
    indexes: original.indexes.filter(
      (index) => !(index.kind === "btree" && index.keys[0]?.propertyId === "region"),
    ),
  };

  assertIndexError(
    () => compileReleaseIndexPlan({ ...input, objectTypes: [objectType] }),
    "INDEX_CAPABILITY_UNCOVERED",
  );
});

void test("a non-queryable Property and auto-index-all are both rejected", () => {
  const direct = g1ShapedReleaseIndexPlan("r1", "revision-a", 1);
  const directObjectType = required(direct.objectTypes[0]);
  assertIndexError(
    () =>
      compileReleaseIndexPlan({
        ...direct,
        evidenceCatalog: [...direct.evidenceCatalog, "query:should-not-exist"],
        objectTypes: [
          {
            ...directObjectType,
            indexes: [
              ...directObjectType.indexes,
              {
                kind: "btree",
                keys: [{ propertyId: "sensitiveCode" }],
                evidenceRefs: ["query:should-not-exist"],
              },
            ],
          },
        ],
      }),
    "INDEX_PLAN_PROPERTY_NOT_DECLARED",
  );

  const automatic = g1ShapedReleaseIndexPlan("r1", "revision-a", 1);
  automatic.autoIndexAllProperties = true;
  assertIndexError(() => compileReleaseIndexPlan(automatic), "INDEX_AUTO_PROPERTY_FORBIDDEN");
});

void test("json only allows registered top-level filter paths", () => {
  const objectType: ObjectTypeIndexPlanInput = {
    resourceId: "object-json",
    revisionId: "revision-json",
    properties: [
      { propertyId: "id", type: "string", primaryKey: true },
      {
        propertyId: "details",
        type: "json",
        registeredJsonPaths: [{ path: "$.category", valueType: "string", filterable: true }],
      },
    ],
    indexes: [
      {
        kind: "btree",
        keys: [{ propertyId: "details", jsonPath: "$.category" }],
        evidenceRefs: ["query:json-category"],
      },
    ],
  };
  assert.equal(
    compileReleaseIndexPlan({
      projectId: capacityProjectId,
      releaseId: "r-json",
      evidenceCatalog: ["query:json-category"],
      objectTypes: [objectType],
    }).secondaryIndexUnits,
    1,
  );

  const invalidObjectType: ObjectTypeIndexPlanInput = {
    ...objectType,
    indexes: [
      {
        kind: "btree",
        keys: [{ propertyId: "details", jsonPath: "$.unregistered" }],
        evidenceRefs: ["query:json-category"],
      },
    ],
  };
  assertIndexError(
    () =>
      compileReleaseIndexPlan({
        projectId: capacityProjectId,
        releaseId: "r-json",
        evidenceCatalog: ["query:json-category"],
        objectTypes: [invalidObjectType],
      }),
    "INDEX_DECLARATION_INVALID",
  );
});

void test("Object Type write-amplification units have a non-approvable hard limit", () => {
  const input = g1ShapedReleaseIndexPlan("r1", "revision-a", 1);
  const original = required(input.objectTypes[0]);
  const objectType: ObjectTypeIndexPlanInput = {
    ...original,
    properties: [
      ...original.properties,
      {
        propertyId: "externalId",
        type: "string",
        filterable: true,
        unique: true,
      },
    ],
    indexes: [
      ...original.indexes,
      {
        kind: "btree",
        keys: [{ propertyId: "externalId" }],
        unique: true,
        evidenceRefs: ["constraint:external-id"],
      },
    ],
  };
  assertIndexError(
    () =>
      compileReleaseIndexPlan({
        ...input,
        evidenceCatalog: [...input.evidenceCatalog, "constraint:external-id"],
        objectTypes: [objectType],
      }),
    "INDEX_TYPE_BUDGET_EXCEEDED",
  );
});

void test("an Index evidence ref must resolve in the Release evidence catalog", () => {
  const input = g1ShapedReleaseIndexPlan("r1", "revision-a", 1);
  input.evidenceCatalog = input.evidenceCatalog.filter((item) => item !== "query:tags");
  assertIndexError(() => compileReleaseIndexPlan(input), "INDEX_EVIDENCE_REQUIRED");
});

void test("Release normal budget needs time-bounded capacity approval", () => {
  const compiled = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("r-new", "revision-new", 7));
  assert.equal(compiled.secondaryIndexUnits, 84);
  assertIndexError(
    () => admitIndexPlan(compiled, completeInventory(), 10),
    "INDEX_RELEASE_BUDGET_EXCEEDED",
  );

  const approval: IndexCapacityApproval = {
    id: "index-approval",
    projectId: capacityProjectId,
    approvedAt: 0,
    expiresAt: 30 * INDEX_DAY_IN_MS,
    maximumReleaseUnits: 90,
    maximumProjectUnionUnits: 180,
    maximumProjectPhysicalIndexes: 100,
    retirementReleaseIds: ["r-old"],
    supportUntilByReleaseId: { "r-old": 20 * INDEX_DAY_IN_MS },
  };
  const retiring = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("r-old", "revision-old"));
  assert.equal(
    admitIndexPlan(compiled, completeInventory(retiring), 10, approval).approvalId,
    approval.id,
  );
});

void test("Project union deduplicates compatible signatures and budgets incompatible revisions", () => {
  const r1 = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("r1", "revision-a"));
  const compatible = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("r2", "revision-a"));
  const incompatible1 = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("r3", "revision-b"));
  const incompatible2 = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("r4", "revision-c"));

  const shared = admitIndexPlan(compatible, completeInventory(r1), 10);
  assert.equal(shared.projectUnionUnits, 60);
  assert.equal(shared.projectPhysicalIndexCount, 35);

  assertIndexError(
    () => admitIndexPlan(incompatible2, completeInventory(r1, incompatible1), 10),
    "INDEX_PROJECT_BUDGET_EXCEEDED",
  );
  const approval: IndexCapacityApproval = {
    id: "project-index-approval",
    projectId: capacityProjectId,
    approvedAt: 0,
    expiresAt: 30 * INDEX_DAY_IN_MS,
    maximumReleaseUnits: 80,
    maximumProjectUnionUnits: 180,
    maximumProjectPhysicalIndexes: 110,
    retirementReleaseIds: ["r1"],
    supportUntilByReleaseId: { r1: 20 * INDEX_DAY_IN_MS },
  };
  const admitted = admitIndexPlan(
    incompatible2,
    completeInventory(r1, incompatible1),
    10,
    approval,
  );
  assert.equal(admitted.projectUnionUnits, 180);
  assert.equal(admitted.projectPhysicalIndexCount, 105);
});

void test("Index approval rejects a ghost or too-late retirement plan", () => {
  const candidate = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("candidate", "revision-b", 6));
  const serving = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("serving", "revision-a"));
  const approval: IndexCapacityApproval = {
    id: "invalid-retirement",
    projectId: capacityProjectId,
    approvedAt: 0,
    expiresAt: 30 * INDEX_DAY_IN_MS,
    maximumReleaseUnits: 80,
    maximumProjectUnionUnits: 180,
    maximumProjectPhysicalIndexes: 100,
    retirementReleaseIds: ["ghost"],
    supportUntilByReleaseId: { ghost: 20 * INDEX_DAY_IN_MS },
  };
  assertIndexError(
    () => admitIndexPlan(candidate, completeInventory(serving), 10, approval),
    "INDEX_PROJECT_BUDGET_EXCEEDED",
  );

  approval.retirementReleaseIds = ["serving"];
  approval.supportUntilByReleaseId = { serving: 24 * INDEX_DAY_IN_MS };
  assertIndexError(
    () => admitIndexPlan(candidate, completeInventory(serving), 10, approval),
    "INDEX_PROJECT_BUDGET_EXCEEDED",
  );
});

void test("expired Index overage permits an identical plan but no new over-budget Release", () => {
  const existing = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("existing", "revision-a", 7));
  const unchanged = admitIndexPlan(existing, completeInventory(existing), 10);
  assert.equal(unchanged.admissionMode, "NON_EXPANDING_OVERAGE");

  const newRelease = compileReleaseIndexPlan(
    g1ShapedReleaseIndexPlan("new-release", "revision-a", 7),
  );
  assertIndexError(
    () => admitIndexPlan(newRelease, completeInventory(existing), 10),
    "INDEX_RELEASE_BUDGET_EXCEEDED",
  );
});

void test("an immutable Release cannot replace its retained physical Index Plan", () => {
  const retained = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("same-release", "revision-a"));
  const changed = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("same-release", "revision-b"));
  assertIndexError(
    () => admitIndexPlan(changed, completeInventory(retained), 10),
    "INDEX_DECLARATION_INVALID",
  );
});

void test("neither Release nor Project approval can cross a hard Index limit", () => {
  assertIndexError(
    () => compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("r-hard", "revision-hard", 9)),
    "INDEX_HARD_LIMIT_EXCEEDED",
  );

  const plans = ["a", "b", "c", "d", "e"].map((revision, index) =>
    compileReleaseIndexPlan(g1ShapedReleaseIndexPlan(`r${index}`, revision)),
  );
  assertIndexError(
    () => admitIndexPlan(required(plans[4]), completeInventory(...plans.slice(0, 4)), 10),
    "INDEX_HARD_LIMIT_EXCEEDED",
  );
});

void test("Project Index admission counts protected plans and fails closed on partial inventory", () => {
  const candidate = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("candidate", "revision-c"));
  const serving = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("serving", "revision-a"));
  const held = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("held", "revision-b"));

  assertIndexError(
    () =>
      admitIndexPlan(
        candidate,
        {
          complete: false,
          retainedPlans: [{ plan: serving, reasons: ["SERVING"] }],
        },
        10,
      ),
    "INDEX_INVENTORY_INCOMPLETE",
  );
  assertIndexError(
    () =>
      admitIndexPlan(
        candidate,
        {
          complete: true,
          retainedPlans: [
            { plan: serving, reasons: ["SERVING"] },
            { plan: held, reasons: ["PROTECTED"] },
          ],
        },
        10,
      ),
    "INDEX_PROJECT_BUDGET_EXCEEDED",
  );
});

function assertIndexError(operation: () => unknown, code: IndexPlanError["code"]): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof IndexPlanError && error.code === code,
  );
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Test fixture value is missing.");
  return value;
}

function completeInventory(
  ...plans: Parameters<typeof admitIndexPlan>[1]["retainedPlans"][number]["plan"][]
) {
  return {
    complete: true,
    retainedPlans: plans.map((plan) => ({ plan, reasons: ["SERVING" as const] })),
  };
}
