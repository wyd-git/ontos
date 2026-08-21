import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluateG20308EvidenceSnapshot,
  g20308EvidenceManifest,
  type G20308EvidencePolicy,
  type G20308EvidenceSnapshot,
} from "./g2-03-08-evidence.ts";

const policy = JSON.parse(
  readFileSync(new URL("../../security/g2-03-08-evidence-policy.json", import.meta.url), "utf8"),
) as G20308EvidencePolicy;
const forwardExactPaths = [
  "docs/architecture/adr/026-runtime-query-context-metadata-object-get.md",
  "docs/evidence/g2-03-08-runtime-metadata-object-get.md",
  "docs/reviews/g2-03-08-intended-vs-implemented.md",
  "migrations/db-00/0028_runtime_query_context.sql",
  "security/g2-03-08-evidence-policy.json",
  "tools/ci/g2-03-08-evidence.test.ts",
  "tools/ci/g2-03-08-evidence.ts",
];
const forwardPrefixes = [
  "packages/query-application/",
  "packages/query-domain/",
  "packages/query-postgres/",
  "tools/runtime-query/",
];

function validSnapshot(): G20308EvidenceSnapshot {
  const forwardScope = {
    allowedExactPaths: forwardExactPaths,
    allowedPrefixes: forwardPrefixes,
  };
  return {
    currentCommit: "a".repeat(40),
    trackedFiles: [
      ...policy.requiredRecords.map(({ path }) => path),
      ...policy.requiredSourceMarkers.map(({ path }) => path),
    ],
    changedFiles: [
      "docs/architecture/adr/026-runtime-query-context-metadata-object-get.md",
      "migrations/db-00/0028_runtime_query_context.sql",
      "packages/query-application/src/runtime.ts",
      "packages/query-postgres/src/runtime-object.ts",
      "tools/runtime-query/integration/postgres.test.ts",
    ],
    documents: Object.fromEntries(
      policy.requiredRecords.map(({ path, marker }) => [path, `# Record\n\n${marker}\n`]),
    ),
    sourceTexts: Object.fromEntries(
      policy.requiredSourceMarkers.map(({ path, markers }) => [path, markers.join("\n")]),
    ),
    foundationPolicy: {
      scope: { allowedMigrationFiles: ["migrations/db-00/0028_runtime_query_context.sql"] },
    },
    priorPolicies: Object.fromEntries(
      [
        "g2-02",
        "g2-03-01",
        "g2-03-02",
        "g2-03-03",
        "g2-03-04",
        "g2-03-05",
        "g2-03-06",
        "g2-03-07",
      ].map((gate) => [gate, { scope: forwardScope }]),
    ),
    runtimeQueryArtifact: runtimeQueryArtifact(),
  };
}

function runtimeQueryArtifact(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    gate: "G2-03-08",
    status: "PASS",
    qualification: "REAL_POSTGRES_16_RUNTIME_METADATA_OBJECT_GET",
    commit: "a".repeat(40),
    cleanCheckout: true,
    postgres: {
      serverVersionNum: "160014",
      leaseStates: [
        { state: "expired", count: 1 },
        { state: "released", count: 5 },
      ],
      retiredServingHeadCount: 0,
    },
    executionContext: { selectorKinds: ["release", "channel"] },
    assertions: {
      candidateResolvedOncePerRequest: true,
      atomicContextRevalidationBeforeLeaseCommit: true,
      committedLeaseBeforeCurrentRead: true,
      leaseActivationOrderedBeforeCurrentRead: true,
      exactLeaseGatedCurrentView: true,
      metadataIsActorDiscoverable: true,
      canonicalPrimaryKeyAndExactRevisionGeneration: true,
      objectVersionStable: true,
      absentAndInvisibleShare404Boundary: true,
      propertyFiveStateSerializerDefense: true,
      servingHeadDriftFailsWithoutLease: true,
      authorizationEpochDriftFailsWithoutLease: true,
      killedOwnerLeaseExpiresAndDropsGcRoot: true,
      releaseSupportWindowImmutable: true,
      explicitRetirementHasNoStableFallback: true,
      apiHasNoRawCurrentGrant: true,
      workerAndOpsCannotUseQuerySurface: true,
    },
  };
}

void test("accepts complete G2-03-08 Runtime Query evidence", () => {
  assert.deepEqual(evaluateG20308EvidenceSnapshot(validSnapshot(), policy), []);
});

void test("rejects HTTP, UI and Action outside the Runtime Application scope", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20308EvidenceSnapshot(
    {
      ...snapshot,
      changedFiles: [
        "apps/api/src/runtime.ts",
        "apps/web/src/query.tsx",
        "packages/action/src/apply.ts",
      ],
    },
    policy,
  );
  assert.equal(
    violations.filter((value) => value.includes("does not allow changed path")).length,
    3,
  );
});

void test("rejects a historical scope or Foundation scope that cannot admit 0028", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20308EvidenceSnapshot(
    {
      ...snapshot,
      foundationPolicy: { scope: { allowedMigrationFiles: [] } },
      priorPolicies: {
        ...snapshot.priorPolicies,
        "g2-03-07": { scope: { allowedExactPaths: [], allowedPrefixes: [] } },
      },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("Foundation scope")),
    true,
  );
  assert.equal(
    violations.some((value) => value.includes("g2-03-07 forward scope")),
    true,
  );
});

void test("rejects unclean, live-Lease or incomplete PostgreSQL evidence", () => {
  const snapshot = validSnapshot();
  const artifact = runtimeQueryArtifact();
  const postgres = artifact.postgres as Readonly<Record<string, unknown>>;
  const violations = evaluateG20308EvidenceSnapshot(
    {
      ...snapshot,
      runtimeQueryArtifact: {
        ...artifact,
        cleanCheckout: false,
        postgres: {
          ...postgres,
          leaseStates: [{ state: "committed", count: 1 }],
        },
      },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("artifact is incomplete")),
    true,
  );
});

void test("manifest requires every gate and the same clean PostgreSQL artifact", () => {
  const steps = policy.requiredGates.map((name) => ({
    name,
    command: `npm run ${name}`,
    status: "PASS",
    durationMs: 1,
  }));
  const report = {
    status: "PASS",
    dirty: false,
    commit: "a".repeat(40),
    startedAt: "2026-08-21T00:00:00.000Z",
    completedAt: "2026-08-21T00:01:00.000Z",
    durationMs: 60_000,
    steps,
  };
  const acceptance = {
    status: "PASS",
    requiredGates: policy.requiredGates,
    records: [],
    residualRisks: [],
    owner: "wyd-git",
  };
  assert.equal(g20308EvidenceManifest(report, acceptance, runtimeQueryArtifact()).status, "PASS");
  assert.equal(
    g20308EvidenceManifest({ ...report, steps: steps.slice(1) }, acceptance, runtimeQueryArtifact())
      .status,
    "FAIL",
  );
  assert.equal(
    g20308EvidenceManifest(report, acceptance, {
      ...runtimeQueryArtifact(),
      commit: "b".repeat(40),
    }).status,
    "FAIL",
  );
});
