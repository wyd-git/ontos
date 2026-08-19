import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluateG20304EvidenceSnapshot,
  g20304EvidenceManifest,
  type G20304EvidencePolicy,
  type G20304EvidenceSnapshot,
} from "./g2-03-04-evidence.ts";

const policy = JSON.parse(
  readFileSync(new URL("../../security/g2-03-04-evidence-policy.json", import.meta.url), "utf8"),
) as G20304EvidencePolicy;

function validSnapshot(): G20304EvidenceSnapshot {
  const migration = "migrations/db-00/0025_runtime_identity_boundary.sql";
  const forwardScope = {
    allowedExactPaths: [migration],
    allowedPrefixes: [
      "packages/identity-application/",
      "packages/identity-domain/",
      "packages/identity-postgres/",
      "tools/runtime-identity/",
    ],
  };
  return {
    currentCommit: "a".repeat(40),
    trackedFiles: [
      ...policy.requiredRecords.map(({ path }) => path),
      ...policy.requiredSourceMarkers.map(({ path }) => path),
    ],
    changedFiles: [
      migration,
      "packages/identity-domain/src/claim-mapping.ts",
      "tools/runtime-identity/integration/postgres-oidc.test.ts",
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
          "packages/identity-application",
          "packages/identity-domain",
          "packages/identity-postgres",
        ],
        allowedMigrationFiles: [migration],
        allowedCreatedTables: [
          "audit.claim_mapping_activation_events",
          "authz.delegation_replay_records",
          "authz.service_identity_profiles",
        ],
      },
    },
    priorPolicies: {
      "g2-02": { scope: forwardScope },
      "g2-03-01": { scope: forwardScope },
      "g2-03-02": { scope: forwardScope },
      "g2-03-03": { scope: forwardScope },
    },
    runtimeIdentityArtifact: runtimeIdentityArtifact(),
  };
}

function runtimeIdentityArtifact(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    gate: "G2-03-04",
    status: "PASS",
    qualification: "REAL_OIDC_POSTGRES_DPOP_TWO_API_PROCESSES",
    commit: "a".repeat(40),
    cleanCheckout: true,
    migrations: { current: 25, applied: [25] },
    postgres: { serverVersionNum: "160015" },
    assertions: {
      humanIdentityResolved: true,
      serviceIdentityClientBound: true,
      delegatedIdentityUsesRealDpop: true,
      twoApiProcessesShareReplayStore: true,
      claimMappingWhitelistAndFingerprint: true,
      claimMappingHistoryImmutable: true,
      claimMappingAuditRedacted: true,
      mappingChangeAdvancesEpoch: true,
      unknownPrincipalNotProvisioned: true,
      disabledPrincipalDenied: true,
      serviceProfileRevocationDenied: true,
      persistedCredentialsAbsent: true,
    },
  };
}

void test("accepts the complete G2-03-04 Runtime Identity evidence snapshot", () => {
  assert.deepEqual(evaluateG20304EvidenceSnapshot(validSnapshot(), policy), []);
});

void test("rejects an out-of-scope Query, Policy or UI implementation", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20304EvidenceSnapshot(
    {
      ...snapshot,
      changedFiles: [
        "apps/web/src/runtime.tsx",
        "packages/policy/src/compiler.ts",
        "packages/query/src/executor.ts",
      ],
    },
    policy,
  );
  assert.equal(violations.filter((value) => value.includes("forbids changed path")).length, 3);
});

void test("rejects historical policies that do not admit the forward identity boundary", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20304EvidenceSnapshot(
    {
      ...snapshot,
      priorPolicies: {
        ...snapshot.priorPolicies,
        "g2-03-03": { scope: { allowedExactPaths: [], allowedPrefixes: [] } },
      },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("g2-03-03 forward scope")),
    true,
  );
});

void test("rejects an unbound or incomplete Runtime Identity artifact", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20304EvidenceSnapshot(
    {
      ...snapshot,
      runtimeIdentityArtifact: {
        ...runtimeIdentityArtifact(),
        cleanCheckout: false,
        assertions: { persistedCredentialsAbsent: false },
      },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("Runtime Identity artifact")),
    true,
  );
});

void test("manifest requires every gate and the clean Runtime Identity artifact", () => {
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
  assert.equal(
    g20304EvidenceManifest(report, acceptance, runtimeIdentityArtifact()).status,
    "PASS",
  );
  assert.equal(
    g20304EvidenceManifest(
      { ...report, steps: steps.slice(1) },
      acceptance,
      runtimeIdentityArtifact(),
    ).status,
    "FAIL",
  );
  assert.equal(
    g20304EvidenceManifest(report, acceptance, {
      ...runtimeIdentityArtifact(),
      commit: "b".repeat(40),
    }).status,
    "FAIL",
  );
});
