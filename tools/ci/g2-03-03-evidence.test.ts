import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluateG20303EvidenceSnapshot,
  g20303EvidenceManifest,
  type G20303EvidencePolicy,
  type G20303EvidenceSnapshot,
} from "./g2-03-03-evidence.ts";

const policy = JSON.parse(
  readFileSync(new URL("../../security/g2-03-03-evidence-policy.json", import.meta.url), "utf8"),
) as G20303EvidencePolicy;

function validSnapshot(): G20303EvidenceSnapshot {
  const allowedMigrationFiles = [
    "migrations/db-00/0022_query_policy_identity_facts.sql",
    "migrations/db-00/0023_query_lease_gc_boundary.sql",
    "migrations/db-00/0024_query_policy_authorization_boundary.sql",
  ];
  const allowedCreatedTables = [
    "authz.claim_mapping_heads",
    "authz.claim_mapping_revisions",
    "authz.policy_compilations",
    "ops.authorization_epoch_advances",
    "runtime.query_lease_generations",
    "runtime.query_leases",
  ];
  const forwardScope = {
    allowedExactPaths: allowedMigrationFiles,
    allowedPrefixes: ["tools/query-policy-persistence/"],
  };
  return {
    currentCommit: "a".repeat(40),
    trackedFiles: [
      ...policy.requiredRecords.map(({ path }) => path),
      ...policy.requiredSourceMarkers.map(({ path }) => path),
    ],
    changedFiles: [
      "migrations/db-00/0022_query_policy_identity_facts.sql",
      "tools/query-policy-persistence/integration/postgres.test.ts",
    ],
    documents: Object.fromEntries(
      policy.requiredRecords.map(({ path, marker }) => [path, `# Record\n\n${marker}\n`]),
    ),
    sourceTexts: Object.fromEntries(
      policy.requiredSourceMarkers.map(({ path, markers }) => [path, markers.join("\n")]),
    ),
    foundationPolicy: { scope: { allowedMigrationFiles, allowedCreatedTables } },
    materializationPolicy: { scope: forwardScope },
    g20301Policy: { scope: forwardScope },
    g20302Policy: { scope: forwardScope },
    persistenceArtifact: persistenceArtifact(),
    queryLeaseArtifact: queryLeaseArtifact(),
  };
}

function persistenceArtifact(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    gate: "G2-03-03",
    status: "PASS",
    qualification: "REAL_POSTGRES_16_FORWARD_MIGRATION_AND_NON_OWNER_THIN_SLICE",
    commit: "a".repeat(40),
    cleanCheckout: true,
    migrations: { historicalPrefix: 21, current: 24, applied: [22, 23, 24] },
    assertions: {
      historyHashesPreserved: true,
      concurrentRunnerSingleResult: true,
      everyNewMigrationRollsBack: true,
      runtimeRolesLeastPrivilege: true,
    },
  };
}

function queryLeaseArtifact(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    gate: "G2-03-03",
    status: "PASS",
    qualification: "REAL_SERVING_GENERATION_QUERY_LEASE_GC_ROOT",
    commit: "a".repeat(40),
    cleanCheckout: true,
    postgres: { serverVersionNum: "160015" },
    generationCount: 3,
    assertions: {
      servingActivationResolved: true,
      activeLeaseRootedEveryGeneration: true,
      boundedHeartbeat: true,
      terminalRootsRemoved: true,
    },
  };
}

void test("accepts the complete G2-03-03 persistence evidence snapshot", () => {
  assert.deepEqual(evaluateG20303EvidenceSnapshot(validSnapshot(), policy), []);
});

void test("rejects an out-of-scope Runtime Endpoint or Policy implementation", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20303EvidenceSnapshot(
    {
      ...snapshot,
      changedFiles: ["apps/web/src/query.ts", "packages/policy/src/compiler.ts"],
    },
    policy,
  );
  assert.equal(violations.filter((value) => value.includes("forbids changed path")).length, 2);
});

void test("rejects a historical scope that does not admit the forward migrations", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20303EvidenceSnapshot(
    { ...snapshot, g20302Policy: { scope: { allowedExactPaths: [], allowedPrefixes: [] } } },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("G2-03-02 forward scope")),
    true,
  );
});

void test("rejects incomplete or unbound PostgreSQL artifacts", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20303EvidenceSnapshot(
    {
      ...snapshot,
      persistenceArtifact: {
        ...persistenceArtifact(),
        assertions: { historyHashesPreserved: false },
      },
      queryLeaseArtifact: { ...queryLeaseArtifact(), generationCount: 0 },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("persistence artifact")),
    true,
  );
  assert.equal(
    violations.some((value) => value.includes("Query Lease artifact")),
    true,
  );
});

void test("manifest requires every gate and both clean artifacts on the same commit", () => {
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
    startedAt: "2026-08-18T00:00:00.000Z",
    completedAt: "2026-08-18T00:01:00.000Z",
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
  assert.equal(
    g20303EvidenceManifest(report, acceptance, persistenceArtifact(), queryLeaseArtifact()).status,
    "PASS",
  );
  assert.equal(
    g20303EvidenceManifest(
      { ...report, steps: steps.slice(1) },
      acceptance,
      persistenceArtifact(),
      queryLeaseArtifact(),
    ).status,
    "FAIL",
  );
  assert.equal(
    g20303EvidenceManifest(
      report,
      acceptance,
      { ...persistenceArtifact(), cleanCheckout: false },
      queryLeaseArtifact(),
    ).status,
    "FAIL",
  );
});
