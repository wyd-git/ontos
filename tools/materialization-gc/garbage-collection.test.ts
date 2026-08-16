import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GC_RETENTION_POLICY,
  GC_DAY_IN_MS,
  GarbageCollectionInventoryError,
  analyzeGarbageCollectionInventory,
  type GarbageCollectionGenerationInventory,
  type GarbageCollectionInventorySnapshot,
} from "@ontos/materialization-domain";

const day = GC_DAY_IN_MS;
const at = 40 * day;

void test("complete inventory classifies protected, recent, grace, candidates and zero-ref indexes", () => {
  const snapshot = baseSnapshot({
    generations: [
      generation("active", "member-a", "ACTIVE", 5, {
        roots: [
          {
            kind: "SERVING_HEAD",
            rootId: "serving-release",
            capabilityKey: "materialization.serving-head",
          },
        ],
        signatures: ["sha256:shared"],
      }),
      generation("recent-1", "member-a", "RETIRED", 30, {
        signatures: ["sha256:shared"],
      }),
      generation("recent-2", "member-a", "READY", 29, {
        signatures: ["sha256:shared"],
      }),
      generation("old", "member-a", "RETIRED", 2, { signatures: ["sha256:drop"] }),
      generation("grace", "member-b", "READY", 35, { signatures: ["sha256:shared"] }),
      generation("failed", "member-c", "FAILED_STAGING", 1),
      generation("staging", "member-d", "STAGING", 1),
    ],
    headSets: [
      {
        headSetId: "head-active",
        state: "ACTIVE",
        createdAt: day,
        measuredBytes: 10n,
        generationIds: ["active"],
      },
      {
        headSetId: "head-retired",
        state: "RETIRED",
        createdAt: day,
        measuredBytes: 20n,
        generationIds: ["old"],
      },
    ],
    indexes: [
      {
        physicalSignature: "sha256:shared",
        indexName: "shared_idx",
        state: "READY",
        observedBytes: 100n,
      },
      {
        physicalSignature: "sha256:drop",
        indexName: "drop_idx",
        state: "READY",
        observedBytes: 200n,
      },
    ],
    attempts: [
      {
        attemptId: "attempt-old",
        state: "TERMINAL",
        finishedAt: 10 * day,
        measuredBytes: 30n,
        generationIds: ["failed"],
      },
      {
        attemptId: "attempt-active",
        state: "ACTIVE",
        finishedAt: null,
        measuredBytes: 40n,
        generationIds: ["active"],
      },
    ],
    orphanUploads: [
      {
        sessionId: "orphan-old",
        state: "FAILED",
        orphanedAt: 10 * day,
        cleanupAfter: 11 * day,
        measuredBytes: 50n,
        exactVersionKnown: true,
      },
      {
        sessionId: "orphan-unknown",
        state: "EXPIRED",
        orphanedAt: 10 * day,
        cleanupAfter: 11 * day,
        measuredBytes: 60n,
        exactVersionKnown: false,
      },
    ],
  });

  const report = analyzeGarbageCollectionInventory(snapshot);
  assert.equal(report.status, "READY");
  assert.deepEqual(keys(report.candidates, "GENERATION"), ["failed", "old", "staging"]);
  assert.deepEqual(keys(report.candidates, "HEAD_SET"), ["head-retired"]);
  assert.deepEqual(keys(report.candidates, "INDEX"), ["sha256:drop"]);
  assert.deepEqual(keys(report.candidates, "ATTEMPT_STAGING"), ["attempt-old"]);
  assert.deepEqual(keys(report.candidates, "ORPHAN_UPLOAD"), ["orphan-old"]);
  assert.deepEqual(keys(report.protected, "GENERATION"), ["active"]);
  assert.deepEqual(keys(report.retained, "GENERATION"), ["grace", "recent-1", "recent-2"]);
  assert.equal(report.reclaimableBytes, 600n);
  assert.deepEqual(
    report.entries.map((entry) => `${entry.kind}:${entry.key}`),
    [...report.entries]
      .map((entry) => `${entry.kind}:${entry.key}`)
      .sort((left, right) => left.localeCompare(right)),
  );
});

void test("an active provider that is missing, failed or version-mismatched blocks every candidate", () => {
  for (const [status, version] of [
    ["MISSING", null],
    ["FAILED", "v1"],
    ["VERSION_MISMATCH", "v2"],
  ] as const) {
    const snapshot = baseSnapshot({
      generations: [generation("old", "member", "RETIRED", 1)],
      capabilities: [
        ...baseCapabilities(),
        { capabilityKey: "future.query", state: "ACTIVE", expectedVersion: "v1" },
      ],
      providerScans: [
        ...baseProviderScans(),
        {
          capabilityKey: "future.query",
          status,
          providerVersion: version,
          rootCount: 0,
          rootDigest: null,
        },
      ],
    });
    const report = analyzeGarbageCollectionInventory(snapshot);
    assert.equal(report.status, "BLOCKED");
    assert.deepEqual(report.candidates, []);
    assert.equal(
      report.blockedReasons.some((reason) => reason.includes("future.query")),
      true,
    );
  }
});

void test("inactive future capabilities are explicit and safe without pretending to scan them", () => {
  const snapshot = baseSnapshot({
    generations: [
      generation("old-1", "member", "RETIRED", 1),
      generation("old-2", "member", "RETIRED", 2),
      generation("old-3", "member", "RETIRED", 3),
    ],
    capabilities: [
      ...baseCapabilities(),
      { capabilityKey: "future.history", state: "INACTIVE", expectedVersion: "future-v1" },
    ],
    providerScans: [
      ...baseProviderScans(),
      {
        capabilityKey: "future.history",
        status: "INACTIVE",
        providerVersion: null,
        rootCount: 0,
        rootDigest: null,
      },
    ],
  });
  const report = analyzeGarbageCollectionInventory(snapshot);
  assert.equal(report.status, "READY");
  assert.deepEqual(keys(report.candidates, "GENERATION"), ["old-1"]);
});

void test("missing measurements, classification, physical indexes, or an unrooted active generation fail closed", () => {
  const cases: GarbageCollectionInventorySnapshot[] = [
    baseSnapshot({ measurementComplete: false }),
    baseSnapshot({ classificationComplete: false }),
    baseSnapshot({ indexInventoryComplete: false }),
    baseSnapshot({
      generations: [
        {
          ...generation("missing", "member", "RETIRED", 1),
          measuredBytes: null,
        },
      ],
    }),
    baseSnapshot({ generations: [generation("unrooted", "member", "ACTIVE", 1)] }),
  ];
  for (const snapshot of cases) {
    const report = analyzeGarbageCollectionInventory(snapshot);
    assert.equal(report.status, "BLOCKED");
    assert.equal(report.candidates.length, 0);
  }
});

void test("Generation grace cannot be configured below seven days", () => {
  assert.throws(
    () =>
      analyzeGarbageCollectionInventory(baseSnapshot(), {
        ...DEFAULT_GC_RETENTION_POLICY,
        successfulGenerationMs: 6 * day,
      }),
    (error: unknown) => error instanceof GarbageCollectionInventoryError,
  );
});

function baseSnapshot(
  overrides: Partial<GarbageCollectionInventorySnapshot> = {},
): GarbageCollectionInventorySnapshot {
  return {
    projectId: "project",
    observedAt: at,
    stateRevision: 7n,
    inventoryRevision: 9n,
    measurementComplete: true,
    classificationComplete: true,
    indexInventoryComplete: true,
    providerRegistryDigest: "sha256:registry",
    capabilities: baseCapabilities(),
    providerScans: baseProviderScans(),
    generations: [],
    headSets: [],
    indexes: [],
    attempts: [],
    orphanUploads: [],
    ...overrides,
  };
}

function baseCapabilities() {
  return [
    { capabilityKey: "materialization.channel", state: "ACTIVE", expectedVersion: "v1" },
    { capabilityKey: "materialization.serving-head", state: "ACTIVE", expectedVersion: "v1" },
    { capabilityKey: "materialization.job", state: "ACTIVE", expectedVersion: "v1" },
  ] as const;
}

function baseProviderScans() {
  return baseCapabilities().map(({ capabilityKey, expectedVersion }) => ({
    capabilityKey,
    status: "COMPLETE" as const,
    providerVersion: expectedVersion,
    rootCount: 0,
    rootDigest: `sha256:${capabilityKey}`,
  }));
}

function generation(
  generationId: string,
  memberKey: string,
  state: GarbageCollectionGenerationInventory["state"],
  changedDay: number,
  options: {
    readonly roots?: GarbageCollectionGenerationInventory["roots"];
    readonly signatures?: readonly string[];
  } = {},
): GarbageCollectionGenerationInventory {
  return {
    generationId,
    memberKey,
    state,
    createdAt: changedDay * day,
    changedAt: changedDay * day,
    leftServingAt: state === "RETIRED" ? changedDay * day : null,
    measuredBytes: 100n,
    indexSignatures: options.signatures ?? [],
    roots: options.roots ?? [],
  };
}

function keys(
  entries: readonly { readonly kind: string; readonly key: string }[],
  kind: string,
): string[] {
  return entries
    .filter((entry) => entry.kind === kind)
    .map((entry) => entry.key)
    .sort();
}
