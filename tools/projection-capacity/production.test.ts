import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseArtifactDigest, type ArtifactDigest } from "@ontos/contracts";
import {
  IndexPlanAdmissionService,
  ProjectionCapacityAdmissionService,
  type CapacityAdmissionSnapshot,
  type IndexCapacityCrypto,
  type IndexPlanAdmissionRepository,
  type PersistAdmittedIndexPlansInput,
  type PersistCapacityAdmissionInput,
} from "@ontos/materialization-application";
import {
  IndexPlanError,
  validateCompiledIndexDefinition,
  type ReleaseIndexPlanInput,
} from "@ontos/materialization-domain";

const projectId = "00000000-0000-4000-8000-000000000901";
const releaseId = "00000000-0000-4000-8000-000000000902";
const resourceId = "00000000-0000-4000-8000-000000000903";
const revisionId = "00000000-0000-4000-8000-000000000904";
const generationId = "00000000-0000-4000-8000-000000000905";

void test("production Index service compiles, admits and persists only canonical definitions", async () => {
  const crypto = deterministicCrypto();
  let persisted: PersistAdmittedIndexPlansInput | undefined;
  const repository: IndexPlanAdmissionRepository = {
    readIndexInventory() {
      return Promise.resolve({
        inventoryRevision: 7n,
        inventory: { complete: true, retainedPlans: [] },
      });
    },
    persistAdmittedIndexPlans(input) {
      persisted = input;
      return Promise.resolve(
        input.plans.map((item) => ({
          indexPlanId: item.indexPlanId,
          resourceId: item.plan.resourceId,
          revisionId: item.plan.revisionId,
          planDigest: item.plan.planDigest,
          reused: false,
        })),
      );
    },
  };
  const result = await new IndexPlanAdmissionService({ repository, crypto }).stageReleasePlan({
    plan: releasePlan(),
    at: 10,
  });

  assert.equal(result.admission.accepted, true);
  assert.equal(result.compiled.indexes.length, 4);
  assert.match(result.compiled.planDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(persisted?.inventoryRevision, 7n);
  for (const index of result.compiled.indexes) {
    assert.match(index.name, /^ok_oc_(?:bt|uq|trgm|arr)_/u);
    assert.match(index.physicalSignature, /^sha256:[0-9a-f]{64}$/u);
    assert.doesNotThrow(() =>
      validateCompiledIndexDefinition(index, (value) => crypto.digestCanonicalText(value)),
    );
  }
  const unique = result.compiled.indexes.find((index) => index.unique);
  assert.ok(unique);
  assert.throws(
    () =>
      validateCompiledIndexDefinition({ ...unique, recipe: "BTREE_TEXT" }, (value) =>
        crypto.digestCanonicalText(value),
      ),
    (error: unknown) => error instanceof IndexPlanError,
  );
});

void test("production Index service fails closed on an incomplete physical inventory", async () => {
  const repository: IndexPlanAdmissionRepository = {
    readIndexInventory() {
      return Promise.resolve({
        inventoryRevision: 1n,
        inventory: { complete: false, retainedPlans: [] },
      });
    },
    persistAdmittedIndexPlans() {
      assert.fail("an incomplete inventory must never be persisted");
    },
  };
  await assert.rejects(
    new IndexPlanAdmissionService({ repository, crypto: deterministicCrypto() }).stageReleasePlan({
      plan: releasePlan(),
      at: 1,
    }),
    (error: unknown) =>
      error instanceof IndexPlanError && error.code === "INDEX_INVENTORY_INCOMPLETE",
  );
});

void test("POSTBUILD capacity persists the larger project physical lower bound", async () => {
  const crypto = deterministicCrypto();
  let persisted: PersistCapacityAdmissionInput | undefined;
  const snapshot: CapacityAdmissionSnapshot = {
    inventoryRevision: 8n,
    indexPlanDigest: digest("index-plan"),
    sourceForecastDigest: digest("forecast"),
    physicalMeasurementDigest: digest("physical"),
    input: {
      projectId,
      at: 10,
      measurementComplete: true,
      observedProjectPhysicalBytes: 800_000_000n,
      generations: [
        {
          id: generationId,
          projectId,
          state: "STAGING",
          createdAt: 0,
          leftServingAt: null,
          derivedRecentSuccessful: false,
          objectTypes: [{ resourceId, rows: 100_000n, secondaryIndexUnitsPerRow: 8n }],
          linkRows: 1_000_000n,
          roots: [{ kind: "JOB", id: "job-1" }],
        },
      ],
      releaseServingSets: [],
    },
  };
  const repository = {
    readCapacityAdmissionSnapshot() {
      return Promise.resolve(snapshot);
    },
    persistCapacityAdmission(input: PersistCapacityAdmissionInput) {
      persisted = input;
      return Promise.resolve();
    },
  };
  const report = await new ProjectionCapacityAdmissionService({ repository, crypto }).admit({
    projectId,
    generationId,
    phase: "POSTBUILD",
  });
  assert.equal(report.measuredBytes >= 800_000_000n, true);
  assert.equal(report.reservedBytes >= report.measuredBytes, true);
  assert.equal(persisted?.phase, "POSTBUILD");
  assert.match(persisted?.reportDigest ?? "", /^sha256:[0-9a-f]{64}$/u);
});

function releasePlan(): ReleaseIndexPlanInput {
  return {
    projectId,
    releaseId,
    evidenceCatalog: ["query:status", "query:search", "query:tags", "constraint:code"],
    objectTypes: [
      {
        resourceId,
        revisionId,
        properties: [
          { propertyId: "id", type: "string", primaryKey: true },
          { propertyId: "status", type: "string", filterable: true, searchable: true },
          { propertyId: "tags", type: "string[]", filterable: true },
          { propertyId: "externalCode", type: "string", unique: true },
        ],
        indexes: [
          {
            kind: "btree",
            keys: [{ propertyId: "status" }],
            evidenceRefs: ["query:status"],
          },
          {
            kind: "gin_trigram",
            propertyId: "status",
            evidenceRefs: ["query:search"],
          },
          { kind: "gin_array", propertyId: "tags", evidenceRefs: ["query:tags"] },
          {
            kind: "btree",
            keys: [{ propertyId: "externalCode" }],
            unique: true,
            evidenceRefs: ["constraint:code"],
          },
        ],
      },
    ],
  };
}

function deterministicCrypto(): IndexCapacityCrypto {
  let next = 0x910;
  return {
    randomId() {
      const suffix = (next++).toString(16).padStart(12, "0");
      return `00000000-0000-4000-8000-${suffix}`;
    },
    digestCanonicalText: digest,
  };
}

function digest(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}
