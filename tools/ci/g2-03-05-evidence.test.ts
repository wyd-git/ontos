import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluateG20305EvidenceSnapshot,
  g20305EvidenceManifest,
  type G20305EvidencePolicy,
  type G20305EvidenceSnapshot,
} from "./g2-03-05-evidence.ts";

const policy = JSON.parse(
  readFileSync(new URL("../../security/g2-03-05-evidence-policy.json", import.meta.url), "utf8"),
) as G20305EvidencePolicy;

const migration = "migrations/db-00/0026_policy_resource_compiler_release_gate.sql";
const forwardPrefixes = [
  "packages/policy-application/",
  "packages/policy-domain/",
  "packages/policy-postgres/",
  "tools/policy-compiler/",
];

function validSnapshot(): G20305EvidenceSnapshot {
  const forwardScope = { allowedExactPaths: [migration], allowedPrefixes: forwardPrefixes };
  return {
    currentCommit: "a".repeat(40),
    trackedFiles: [
      ...policy.requiredRecords.map(({ path }) => path),
      ...policy.requiredSourceMarkers.map(({ path }) => path),
    ],
    changedFiles: [
      migration,
      "packages/policy-domain/src/index.ts",
      "tools/policy-compiler/integration/postgres-s3-release.test.ts",
    ],
    documents: Object.fromEntries(
      policy.requiredRecords.map(({ path, marker }) => [path, `# Record\n\n${marker}\n`]),
    ),
    sourceTexts: Object.fromEntries(
      policy.requiredSourceMarkers.map(({ path, markers }) => [path, markers.join("\n")]),
    ),
    foundationPolicy: {
      scope: {
        allowedWorkspacePackages: [
          "packages/policy-application",
          "packages/policy-domain",
          "packages/policy-postgres",
        ],
        allowedMigrationFiles: [migration],
      },
    },
    priorPolicies: {
      "g2-02": { scope: forwardScope },
      "g2-03-01": { scope: forwardScope },
      "g2-03-02": { scope: forwardScope },
      "g2-03-03": { scope: forwardScope },
      "g2-03-04": { scope: forwardScope },
    },
    policyCompilerArtifact: policyCompilerArtifact(),
  };
}

function policyCompilerArtifact(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    gate: "G2-03-05",
    status: "PASS",
    qualification: "REAL_POSTGRES_16_VERSIONED_S3_RELEASE_GATE",
    commit: "a".repeat(40),
    cleanCheckout: true,
    migrations: { historicalPrefix: 25, current: 26, applied: [26] },
    postgres: { serverVersionNum: "160014" },
    compilerVersion: "policy-compiler-g2-03-05-v1",
    testVectorCount: 6,
    assertions: {
      exactDependencies: true,
      missingCompilationBlocked: true,
      apiCompilationWriteDenied: true,
      directDatabaseBypassBlocked: true,
      forgedCompilationBlocked: true,
      wrongBindingCompilationBlocked: true,
      artifactsDigestVerified: true,
      migration26RollsBack: true,
      releasePublished: true,
      compilationImmutable: true,
    },
  };
}

void test("accepts the complete G2-03-05 Policy Compiler evidence snapshot", () => {
  assert.deepEqual(evaluateG20305EvidenceSnapshot(validSnapshot(), policy), []);
});

void test("rejects an out-of-scope Query, Action or UI implementation", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20305EvidenceSnapshot(
    {
      ...snapshot,
      changedFiles: [
        "apps/web/src/policy.tsx",
        "packages/action/src/execute.ts",
        "packages/query/src/compiler.ts",
      ],
    },
    policy,
  );
  assert.equal(violations.filter((value) => value.includes("forbids changed path")).length, 3);
});

void test("rejects historical policies that do not admit the forward Policy boundary", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20305EvidenceSnapshot(
    {
      ...snapshot,
      priorPolicies: {
        ...snapshot.priorPolicies,
        "g2-03-04": { scope: { allowedExactPaths: [], allowedPrefixes: [] } },
      },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("g2-03-04 forward scope")),
    true,
  );
});

void test("rejects an unbound or incomplete Policy Compiler artifact", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20305EvidenceSnapshot(
    {
      ...snapshot,
      policyCompilerArtifact: {
        ...policyCompilerArtifact(),
        cleanCheckout: false,
        assertions: { apiCompilationWriteDenied: false },
      },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("Policy Compiler artifact")),
    true,
  );
});

void test("manifest requires every gate and the clean Policy Compiler artifact", () => {
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
    startedAt: "2026-08-19T00:00:00.000Z",
    completedAt: "2026-08-19T00:01:00.000Z",
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
  assert.equal(g20305EvidenceManifest(report, acceptance, policyCompilerArtifact()).status, "PASS");
  assert.equal(
    g20305EvidenceManifest(
      { ...report, steps: steps.slice(1) },
      acceptance,
      policyCompilerArtifact(),
    ).status,
    "FAIL",
  );
  assert.equal(
    g20305EvidenceManifest(report, acceptance, {
      ...policyCompilerArtifact(),
      commit: "b".repeat(40),
    }).status,
    "FAIL",
  );
});
