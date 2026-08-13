import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CAPACITY_DAY_IN_MS,
  ProjectionCapacityError,
  admitCapacityChange,
  assertCapacityAccepted,
  assertFoundationDeploymentEnvelope,
  assertGarbageCollectionCommitAllowed,
  createGarbageCollectionDryRun,
  evaluateCapacity,
  type ProjectionCapacityApproval,
} from "./capacity.ts";
import { capacityProjectId, fullProjectionCohort, servingCohort } from "./fixtures.ts";
import { G1_INDEX_COST_BASELINE, GIB, MIB, estimateFullProjection } from "./g1-baseline.ts";

void test("G1 evidence produces an exact 497 MiB measured projection and 3.574x write ratio", () => {
  const estimate = estimateFullProjection(100_000n, 1_000_000n, 13n, 10_000n);
  assert.equal(estimate.measuredBytes, 497n * MIB);
  assert.equal(estimate.objects.estimatedWriteAmplificationMilli, 3_574n);
  assert.equal(G1_INDEX_COST_BASELINE.metadataWriteAmplificationMilli, 3_574n);

  const reserved = estimateFullProjection(100_000n, 1_000_000n);
  assert.equal(reserved.reservedBytes, 781_713_408n);
});

void test("G1 baseline hashes remain bound to the committed evidence and benchmark inputs", () => {
  const files = [
    ["../../spikes/g1/evidence/spike-a-summary.md", G1_INDEX_COST_BASELINE.summaryFileSha256],
    ["../../spikes/g1/src/bench/run-index-cost.js", G1_INDEX_COST_BASELINE.benchmarkFileSha256],
    ["../../spikes/g1/sql/001_schema.sql", G1_INDEX_COST_BASELINE.schemaFileSha256],
    ["../../spikes/g1/sql/020_indexes.sql", G1_INDEX_COST_BASELINE.indexesFileSha256],
  ] as const;
  for (const [relativePath, expected] of files) {
    const actual = createHash("sha256")
      .update(readFileSync(new URL(relativePath, import.meta.url)))
      .digest("hex");
    assert.equal(actual, expected, relativePath);
  }
});

void test("32 serving Releases sharing 8 physical cohorts + 2 recent + Staging fit defaults", () => {
  const releaseIds = Array.from({ length: 32 }, (_, index) => `r${index + 1}`);
  const serving = Array.from({ length: 8 }, (_, index) => {
    const cohortReleaseIds = releaseIds.filter((_, releaseIndex) => releaseIndex % 8 === index);
    return fullProjectionCohort(`serving-${index + 1}`, {
      roots: cohortReleaseIds.map((releaseId) => ({
        kind: "SERVING_HEAD",
        id: `head:${releaseId}`,
        releaseId,
      })),
    });
  });
  const releaseServingSets = releaseIds.map((releaseId, index) => ({
    releaseId,
    generationIds: required(serving[index % 8]).map((generation) => generation.id),
  }));
  const recent = [
    ...fullProjectionCohort("recent-1", { derivedRecentSuccessful: true }),
    ...fullProjectionCohort("recent-2", { derivedRecentSuccessful: true }),
  ];
  const staging = fullProjectionCohort("staging", {
    state: "STAGING",
    roots: [{ kind: "JOB", id: "materialization-job" }],
  });
  const report = evaluateCapacity({
    projectId: capacityProjectId,
    at: 10,
    measurementComplete: true,
    generations: [...serving.flat(), ...recent, ...staging],
    releaseServingSets,
  });

  assert.equal(report.accepted, true);
  assert.equal(report.steadyReservedBytes < 8n * GIB, true);
  assert.equal(report.peakReservedBytes < 10n * GIB, true);
  assert.equal(report.bytesByClassification.SERVING > 0n, true);
  assert.equal(report.bytesByClassification.RECENT_SUCCESS > 0n, true);
  assert.equal(report.bytesByClassification.STAGING > 0n, true);
});

void test("a Release Serving Set must be backed by that exact Release Head", () => {
  const r1 = servingCohort("r1");
  assertCapacityError(
    () =>
      evaluateCapacity({
        projectId: capacityProjectId,
        at: 0,
        measurementComplete: true,
        generations: r1.generations,
        releaseServingSets: [{ releaseId: "r2", generationIds: r1.servingSet.generationIds }],
      }),
    "CAPACITY_INVENTORY_INVALID",
  );
});

void test("investigation Holds count toward peak and need bounded approval above normal", () => {
  const serving = Array.from({ length: 8 }, (_, index) => servingCohort(`r${index + 1}`));
  const recent = [
    ...fullProjectionCohort("recent-1", { derivedRecentSuccessful: true }),
    ...fullProjectionCohort("recent-2", { derivedRecentSuccessful: true }),
  ];
  const holds = [1, 2, 3].flatMap((index) =>
    fullProjectionCohort(`hold-${index}`, {
      roots: [holdRoot(`investigation-${index}`, 1_000)],
    }),
  );
  const staging = fullProjectionCohort("staging", {
    state: "STAGING",
    roots: [{ kind: "JOB", id: "materialization-job" }],
  });
  const input = {
    projectId: capacityProjectId,
    at: 10,
    measurementComplete: true,
    generations: [...serving.flatMap((item) => item.generations), ...recent, ...holds, ...staging],
    releaseServingSets: serving.map((item) => item.servingSet),
  } as const;

  const rejected = evaluateCapacity(input);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.hardViolations.length, 0);
  assertCapacityError(() => assertCapacityAccepted(rejected), "CAPACITY_STEADY_BUDGET_EXCEEDED");

  const approval: ProjectionCapacityApproval = {
    id: "projection-approval",
    projectId: capacityProjectId,
    approvedAt: 0,
    expiresAt: 30 * CAPACITY_DAY_IN_MS,
    maximumReleaseServingBytes: 2n * GIB,
    maximumProjectSteadyBytes: 10n * GIB,
    maximumProjectPeakBytes: 11n * GIB,
    retirementReleaseIds: ["r1"],
    supportUntilByReleaseId: { r1: 20 * CAPACITY_DAY_IN_MS },
  };
  const accepted = evaluateCapacity(input, approval);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.approvalId, approval.id);
  assert.equal(accepted.bytesByClassification.PROTECTED > 0n, true);
});

void test("expired overage permits only a byte-for-byte non-expanding capacity change", () => {
  const serving = Array.from({ length: 8 }, (_, index) => servingCohort(`r${index + 1}`));
  const holds = [1, 2, 3].flatMap((index) =>
    fullProjectionCohort(`hold-${index}`, {
      roots: [holdRoot(`non-expanding-${index}`, 1_000)],
    }),
  );
  const generations = [...serving.flatMap((item) => item.generations), ...holds];
  const releaseServingSets = serving.map((item) => item.servingSet);
  const before = evaluateCapacity({
    projectId: capacityProjectId,
    at: 10,
    measurementComplete: true,
    generations,
    releaseServingSets,
  });
  const unchanged = evaluateCapacity({
    projectId: capacityProjectId,
    at: 11,
    measurementComplete: true,
    generations,
    releaseServingSets,
  });
  assert.equal(admitCapacityChange(before, unchanged).admissionMode, "NON_EXPANDING_OVERAGE");

  const expanded = evaluateCapacity({
    projectId: capacityProjectId,
    at: 11,
    measurementComplete: true,
    generations: [...generations, ...fullProjectionCohort("new-staging", { state: "STAGING" })],
    releaseServingSets,
  });
  assert.equal(admitCapacityChange(before, expanded).accepted, false);
});

void test("capacity above 12 GiB hard limit is never approvable", () => {
  const cohorts = Array.from({ length: 17 }, (_, index) =>
    fullProjectionCohort(`orphan-${index}`),
  ).flat();
  const report = evaluateCapacity({
    projectId: capacityProjectId,
    at: 10,
    measurementComplete: true,
    generations: cohorts,
    releaseServingSets: [],
  });
  assert.equal(report.accepted, false);
  assert.equal(
    report.hardViolations.some((violation) => violation.code === "CAPACITY_HARD_LIMIT_EXCEEDED"),
    true,
  );
});

void test("Foundation reference deployment cannot multiply the Project hard limit", () => {
  assert.doesNotThrow(() => assertFoundationDeploymentEnvelope([capacityProjectId]));
  assertCapacityError(
    () => assertFoundationDeploymentEnvelope([capacityProjectId, "second-data-project"]),
    "CAPACITY_DEPLOYMENT_PROJECT_LIMIT_EXCEEDED",
  );
});

void test("capacity admission fails closed when measurements are incomplete", () => {
  assertCapacityError(
    () =>
      evaluateCapacity({
        projectId: capacityProjectId,
        at: 0,
        measurementComplete: false,
        generations: fullProjectionCohort("unknown"),
        releaseServingSets: [],
      }),
    "CAPACITY_MEASUREMENT_INCOMPLETE",
  );
});

void test("capacity approval rejects ghost retirement and Collected references", () => {
  const serving = Array.from({ length: 8 }, (_, index) => servingCohort(`r${index + 1}`));
  const holds = [1, 2, 3].flatMap((index) =>
    fullProjectionCohort(`held-${index}`, {
      roots: [holdRoot(`hold-${index}`, 1_000)],
    }),
  );
  const input = {
    projectId: capacityProjectId,
    at: 10,
    measurementComplete: true,
    generations: [...serving.flatMap((item) => item.generations), ...holds],
    releaseServingSets: serving.map((item) => item.servingSet),
  } as const;
  const ghostApproval: ProjectionCapacityApproval = {
    id: "ghost-retirement",
    projectId: capacityProjectId,
    approvedAt: 0,
    expiresAt: 30 * CAPACITY_DAY_IN_MS,
    maximumReleaseServingBytes: 2n * GIB,
    maximumProjectSteadyBytes: 9n * GIB,
    maximumProjectPeakBytes: 9n * GIB,
    retirementReleaseIds: ["ghost"],
    supportUntilByReleaseId: { ghost: 20 * CAPACITY_DAY_IN_MS },
  };
  assertCapacityError(() => evaluateCapacity(input, ghostApproval), "CAPACITY_APPROVAL_INVALID");

  const collectedWithHold = {
    ...required(fullProjectionCohort("collected")[0]),
    state: "COLLECTED" as const,
    roots: [holdRoot("still-needed", 1_000)],
  };
  assertCapacityError(
    () =>
      evaluateCapacity({
        projectId: capacityProjectId,
        at: 10,
        measurementComplete: true,
        generations: [collectedWithHold],
        releaseServingSets: [],
      }),
    "CAPACITY_INVENTORY_INVALID",
  );
});

void test("post-Staging observed bytes override a lower G1 estimate before cutover", () => {
  const [generation] = fullProjectionCohort("observed-larger");
  const observedMeasuredBytes = 900n * MIB;
  const report = evaluateCapacity({
    projectId: capacityProjectId,
    at: 0,
    measurementComplete: true,
    generations: [{ ...required(generation), observedMeasuredBytes }],
    releaseServingSets: [],
  });

  assert.equal(report.measuredBytes, observedMeasuredBytes);
  assert.equal(report.reservedBytes, (observedMeasuredBytes * 15_000n) / 10_000n);
});

void test("investigation Holds require governance metadata and a current review", () => {
  const generation = required(fullProjectionCohort("held")[0]);
  assertCapacityError(
    () =>
      evaluateCapacity({
        projectId: capacityProjectId,
        at: 10,
        measurementComplete: true,
        generations: [{ ...generation, roots: [{ kind: "HOLD", id: "missing-owner" }] }],
        releaseServingSets: [],
      }),
    "CAPACITY_INVENTORY_INVALID",
  );
  assertCapacityError(
    () =>
      evaluateCapacity({
        projectId: capacityProjectId,
        at: 10,
        measurementComplete: true,
        generations: [{ ...generation, roots: [holdRoot("overdue", 10)] }],
        releaseServingSets: [],
      }),
    "CAPACITY_HOLD_REVIEW_OVERDUE",
  );
  assertCapacityError(
    () =>
      evaluateCapacity({
        projectId: capacityProjectId,
        at: 10,
        measurementComplete: true,
        generations: [
          {
            ...generation,
            roots: [{ ...holdRoot("auto-expiring", 20), expiresAt: 20 }],
          },
        ],
        releaseServingSets: [],
      }),
    "CAPACITY_INVENTORY_INVALID",
  );
  const blockedGc = createGarbageCollectionDryRun({
    projectId: capacityProjectId,
    at: 10,
    inventoryRevision: 1,
    measurementComplete: true,
    referenceScanComplete: true,
    generations: [{ ...generation, roots: [holdRoot("overdue", 10)] }],
  });
  assert.equal(blockedGc.status, "BLOCKED");
  assert.deepEqual(blockedGc.candidates, []);
  assert.equal(blockedGc.blockedReasons.includes("HOLD_REVIEW_OVERDUE:overdue"), true);
});

void test("wide-row source forecast can reject a Build before Staging consumes hard capacity", () => {
  const [generation] = fullProjectionCohort("wide-source", { state: "STAGING" });
  const report = evaluateCapacity({
    projectId: capacityProjectId,
    at: 0,
    measurementComplete: true,
    generations: [{ ...required(generation), forecastMeasuredBytes: 9n * GIB }],
    releaseServingSets: [],
  });

  assert.equal(report.accepted, false);
  assert.equal(report.hardViolations[0]?.code, "CAPACITY_HARD_LIMIT_EXCEEDED");
});

void test("GC dry-run protects every root and reports retained and reclaimable bytes", () => {
  const old = 20 * CAPACITY_DAY_IN_MS;
  const at = 40 * CAPACITY_DAY_IN_MS;
  const rootedKinds = ["CHANNEL", "SERVING_HEAD", "JOB", "HOLD", "HISTORICAL"] as const;
  const protectedItems = rootedKinds.flatMap((kind) =>
    fullProjectionCohort(`protected-${kind}`, {
      createdAt: old,
      roots: [rootForKind(kind, `root-${kind}`, at + 1)],
    }),
  );
  protectedItems.push(
    ...fullProjectionCohort("protected-token", {
      createdAt: old,
      roots: [{ kind: "PREFLIGHT_TOKEN", id: "token", expiresAt: at + 1 }],
    }),
    ...fullProjectionCohort("protected-query", {
      createdAt: old,
      roots: [{ kind: "QUERY", id: "query", expiresAt: at + 1 }],
    }),
  );
  const expired = fullProjectionCohort("expired-token", {
    createdAt: old,
    roots: [{ kind: "PREFLIGHT_TOKEN", id: "expired", expiresAt: at - 1 }],
  });
  const recent = fullProjectionCohort("recent", {
    createdAt: old,
    derivedRecentSuccessful: true,
  });
  const grace = fullProjectionCohort("grace", {
    createdAt: 0,
    leftServingAt: at - CAPACITY_DAY_IN_MS,
  });
  const orphan = fullProjectionCohort("orphan", { createdAt: old });
  const orphanStaging = fullProjectionCohort("orphan-staging", {
    state: "FAILED_STAGING",
    createdAt: old,
  });

  const report = createGarbageCollectionDryRun({
    projectId: capacityProjectId,
    at,
    inventoryRevision: 7,
    measurementComplete: true,
    referenceScanComplete: true,
    generations: [...protectedItems, ...expired, ...recent, ...grace, ...orphan, ...orphanStaging],
  });
  const candidateIds = new Set(report.candidates.map((entry) => entry.generationId));
  assert.equal(report.status, "READY");
  assert.equal(report.protected.length, protectedItems.length);
  assert.equal(report.retained.length, recent.length + grace.length);
  for (const generation of [...expired, ...orphan, ...orphanStaging]) {
    assert.equal(candidateIds.has(generation.id), true);
  }
  assert.equal(report.reclaimableBytes > 0n, true);
});

void test("GC blocks incomplete scans and stale plans before deletion", () => {
  const generations = fullProjectionCohort("orphan", { createdAt: 0 });
  const blocked = createGarbageCollectionDryRun({
    projectId: capacityProjectId,
    at: 20 * CAPACITY_DAY_IN_MS,
    inventoryRevision: 1,
    measurementComplete: true,
    referenceScanComplete: false,
    generations,
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.deepEqual(blocked.candidates, []);

  const readyInput = {
    projectId: capacityProjectId,
    at: 20 * CAPACITY_DAY_IN_MS,
    inventoryRevision: 1,
    measurementComplete: true,
    referenceScanComplete: true,
    generations,
  } as const;
  const plan = createGarbageCollectionDryRun(readyInput);
  assert.equal(plan.candidates.length, generations.length);
  assertCapacityError(
    () =>
      assertGarbageCollectionCommitAllowed(plan, {
        ...readyInput,
        inventoryRevision: 2,
        generations: generations.map((generation) => ({
          ...generation,
          roots: [holdRoot("late-hold", readyInput.at + 1)],
        })),
      }),
    "GC_PLAN_STALE",
  );
});

function assertCapacityError(
  operation: () => unknown,
  code: ProjectionCapacityError["code"],
): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof ProjectionCapacityError && error.code === code,
  );
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Capacity fixture value is missing.");
  return value;
}

function holdRoot(id: string, reviewAt: number) {
  return {
    kind: "HOLD" as const,
    id,
    ownerId: "investigation-owner",
    reason: "Preserve evidence while the investigation is open.",
    reviewAt,
  };
}

function rootForKind(
  kind: "CHANNEL" | "SERVING_HEAD" | "JOB" | "HOLD" | "HISTORICAL",
  id: string,
  reviewAt: number,
) {
  if (kind === "HOLD") return holdRoot(id, reviewAt);
  if (kind === "SERVING_HEAD") return { kind, id, releaseId: "protected-release" };
  return { kind, id };
}
