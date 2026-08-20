import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluateG20306EvidenceSnapshot,
  g20306EvidenceManifest,
  type G20306EvidencePolicy,
  type G20306EvidenceSnapshot,
} from "./g2-03-06-evidence.ts";

const policy = JSON.parse(
  readFileSync(new URL("../../security/g2-03-06-evidence-policy.json", import.meta.url), "utf8"),
) as G20306EvidencePolicy;
const migration = "migrations/db-00/0027_policy_gateway_runtime.sql";
const forwardPrefixes = [
  "packages/policy-application/",
  "packages/policy-domain/",
  "packages/policy-postgres/",
  "tools/policy-compiler/",
  "tools/policy-gateway/",
];

function validSnapshot(): G20306EvidenceSnapshot {
  const forwardScope = { allowedExactPaths: [migration], allowedPrefixes: forwardPrefixes };
  return {
    currentCommit: "a".repeat(40),
    trackedFiles: [
      ...policy.requiredRecords.map(({ path }) => path),
      ...policy.requiredSourceMarkers.map(({ path }) => path),
    ],
    changedFiles: [
      migration,
      "packages/policy-application/src/gateway.ts",
      "tools/policy-gateway/application.test.ts",
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
      "g2-03-05": { scope: forwardScope },
    },
    policyGatewayArtifact: policyGatewayArtifact(),
  };
}

function policyGatewayArtifact(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    gate: "G2-03-06",
    status: "PASS",
    qualification: "REAL_POSTGRES_16_VERSIONED_S3_TWO_PROCESS_POLICY_GATEWAY",
    commit: "a".repeat(40),
    cleanCheckout: true,
    migrations: { historicalPrefix: 26, current: 27, applied: [27] },
    postgres: { serverVersionNum: "160014" },
    compilerVersion: "policy-compiler-g2-03-05-v1",
    cacheTtlMs: 5_000,
    gatewayProcesses: 2,
    assertions: {
      migration27RollsBack: true,
      sameSnapshotResolver: true,
      exactProjectReleasePolicyTargetBinding: true,
      duplicatePrincipalRejected: true,
      apiResolverAllowed: true,
      workerResolverDenied: true,
      opsResolverDenied: true,
      exactArtifactLoaded: true,
      humanServiceDelegatedConsistent: true,
      normalNotificationNextRequestDenied: true,
      lostNotificationBeforeBoundaryCached: true,
      lostNotificationAtBoundaryDenied: true,
      listenerReconnectedWithoutReset: true,
      serviceProfileRevocationDenied: true,
      humanBindingRevocationDenied: true,
      deletedArtifactFailedClosed: true,
    },
  };
}

void test("accepts the complete G2-03-06 production Policy Gateway evidence", () => {
  assert.deepEqual(evaluateG20306EvidenceSnapshot(validSnapshot(), policy), []);
});

void test("rejects Query, Endpoint, Action and UI work outside the Gateway scope", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20306EvidenceSnapshot(
    {
      ...snapshot,
      changedFiles: [
        "apps/web/src/query.tsx",
        "packages/query/src/compiler.ts",
        "packages/action/src/execute.ts",
      ],
    },
    policy,
  );
  assert.equal(violations.filter((value) => value.includes("forbids changed path")).length, 3);
});

void test("rejects a historical scope that does not admit the Gateway boundary", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20306EvidenceSnapshot(
    {
      ...snapshot,
      priorPolicies: {
        ...snapshot.priorPolicies,
        "g2-03-05": { scope: { allowedExactPaths: [], allowedPrefixes: [] } },
      },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("g2-03-05 forward scope")),
    true,
  );
});

void test("rejects an unbound or incomplete real Policy Gateway artifact", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20306EvidenceSnapshot(
    {
      ...snapshot,
      policyGatewayArtifact: {
        ...policyGatewayArtifact(),
        cleanCheckout: false,
        assertions: { sameSnapshotResolver: false },
      },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("Policy Gateway artifact")),
    true,
  );
});

void test("manifest requires every gate and the same clean Gateway artifact", () => {
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
    startedAt: "2026-08-20T00:00:00.000Z",
    completedAt: "2026-08-20T00:01:00.000Z",
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
  assert.equal(g20306EvidenceManifest(report, acceptance, policyGatewayArtifact()).status, "PASS");
  assert.equal(
    g20306EvidenceManifest(
      { ...report, steps: steps.slice(1) },
      acceptance,
      policyGatewayArtifact(),
    ).status,
    "FAIL",
  );
  assert.equal(
    g20306EvidenceManifest(report, acceptance, {
      ...policyGatewayArtifact(),
      commit: "b".repeat(40),
    }).status,
    "FAIL",
  );
});
