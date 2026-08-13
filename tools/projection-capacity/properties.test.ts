import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import {
  CAPACITY_DAY_IN_MS,
  createGarbageCollectionDryRun,
  evaluateCapacity,
  type GenerationReferenceRoot,
  type ReferenceRootKind,
} from "./capacity.ts";
import { capacityProjectId, fullProjectionCohort, g1ShapedReleaseIndexPlan } from "./fixtures.ts";
import { estimateObjectProjection } from "./g1-baseline.ts";
import { compileReleaseIndexPlan } from "./index-plan.ts";

const parameters = { numRuns: 200, seed: 20_260_813 } as const;

void test("property: reserved bytes are monotonic in rows and secondary index units", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: 0, max: 30 }),
      fc.integer({ min: 0, max: 30 }),
      (rowsA, rowsB, unitsA, unitsB) => {
        const lowRows = BigInt(Math.min(rowsA, rowsB));
        const highRows = BigInt(Math.max(rowsA, rowsB));
        const lowUnits = BigInt(Math.min(unitsA, unitsB));
        const highUnits = BigInt(Math.max(unitsA, unitsB));
        assert.equal(
          estimateObjectProjection(lowRows, lowUnits).reservedBytes <=
            estimateObjectProjection(highRows, lowUnits).reservedBytes,
          true,
        );
        assert.equal(
          estimateObjectProjection(highRows, lowUnits).reservedBytes <=
            estimateObjectProjection(highRows, highUnits).reservedBytes,
          true,
        );
      },
    ),
    parameters,
  );
});

void test("property: every active root kind prevents GC", () => {
  const rootKind = fc.constantFrom<ReferenceRootKind>(
    "CHANNEL",
    "SERVING_HEAD",
    "PREFLIGHT_TOKEN",
    "QUERY",
    "JOB",
    "HOLD",
    "HISTORICAL",
  );
  fc.assert(
    fc.property(rootKind, fc.uuid(), (kind, id) => {
      const at = 20 * CAPACITY_DAY_IN_MS;
      const root: GenerationReferenceRoot =
        kind === "PREFLIGHT_TOKEN" || kind === "QUERY"
          ? { kind, id, expiresAt: at + 1 }
          : kind === "HOLD"
            ? {
                kind,
                id,
                ownerId: "property-test-owner",
                reason: "Prove that an active Hold prevents collection.",
                reviewAt: at + 1,
              }
            : kind === "SERVING_HEAD"
              ? { kind, id, releaseId: `release-${id}` }
              : { kind, id };
      const generations = fullProjectionCohort("protected", {
        createdAt: 0,
        roots: [root],
      });
      const report = createGarbageCollectionDryRun({
        projectId: capacityProjectId,
        at,
        inventoryRevision: 1,
        measurementComplete: true,
        referenceScanComplete: true,
        generations,
      });
      assert.equal(report.candidates.length, 0);
      assert.equal(report.protected.length, generations.length);
    }),
    parameters,
  );
});

void test("property: project hard capacity is finite and cannot be approved away", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 25 }), (cohortCount) => {
      const report = evaluateCapacity({
        projectId: capacityProjectId,
        at: 0,
        measurementComplete: true,
        generations: Array.from({ length: cohortCount }, (_, index) =>
          fullProjectionCohort(`cohort-${index}`),
        ).flat(),
        releaseServingSets: [],
      });
      if (report.peakReservedBytes > 12n * 1_024n * 1_024n * 1_024n) {
        assert.equal(report.accepted, false);
        assert.equal(report.hardViolations.length > 0, true);
      }
    }),
    parameters,
  );
});

void test("property: index names are deterministic, bounded, and independent of display labels", () => {
  fc.assert(
    fc.property(fc.uuid(), fc.uuid(), fc.string(), (resourceId, revisionId, displayName) => {
      const input = g1ShapedReleaseIndexPlan("r", "base", 1);
      const objectType = input.objectTypes[0];
      if (objectType === undefined) throw new Error("Index fixture is missing.");
      objectType.resourceId = resourceId;
      objectType.revisionId = revisionId;
      objectType.displayName = displayName;
      const first = compileReleaseIndexPlan(input);
      objectType.displayName = `${displayName}-changed`;
      const second = compileReleaseIndexPlan(input);
      assert.deepEqual(
        first.indexes.map((index) => index.name),
        second.indexes.map((index) => index.name),
      );
      assert.equal(
        first.indexes.every((index) => Buffer.byteLength(index.name) <= 63),
        true,
      );
    }),
    parameters,
  );
});
