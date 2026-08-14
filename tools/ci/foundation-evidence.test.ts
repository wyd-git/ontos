import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFoundationSnapshot,
  foundationEvidenceManifest,
  type FoundationPolicy,
  type FoundationRepositorySnapshot,
} from "./foundation-evidence.ts";

const policy: FoundationPolicy = {
  schemaVersion: 1,
  gate: "G2-00",
  scope: {
    allowedWorkspacePackages: ["packages/contracts"],
    allowedMigrationFiles: ["migrations/db-00/0001_foundation.sql"],
    allowedCreatedTables: ["ontos_migration.schema_migrations"],
    forbiddenTrackedPrefixes: ["apps/"],
    forbiddenUiExtensions: [".tsx"],
    ignoredPrefixes: ["spikes/g1/"],
  },
  requiredDecisions: [
    {
      id: "ADR-007",
      path: "docs/architecture/adr/007.md",
      acceptedStatus: "Accepted for G2-00-03",
      evidence: "docs/evidence/g2-00-03.md",
    },
  ],
  requiredEvidence: ["docs/evidence/g2-00-01.md", "docs/evidence/g2-00-03.md"],
  delivery: { effectiveParallelLanes: 1 },
  residualRisks: [{ id: "RISK-1", owner: "Platform" }],
};

void test("accepts the exact Foundation-only repository snapshot", () => {
  assert.deepEqual(evaluateFoundationSnapshot(validSnapshot(), policy), []);
});

void test("rejects business code, UI, extra DB scope and non-accepted evidence", () => {
  const snapshot = validSnapshot();
  const invalid: FoundationRepositorySnapshot = {
    ...snapshot,
    trackedFiles: [...snapshot.trackedFiles, "apps/api/server.ts", "packages/contracts/view.tsx"],
    workspacePackages: [...snapshot.workspacePackages, "apps/api"],
    migrationFiles: [...snapshot.migrationFiles, "migrations/db-01/0001_business.sql"],
    createdTables: [...snapshot.createdTables, "meta.project"],
    documents: {
      ...snapshot.documents,
      "docs/architecture/adr/007.md": "- 状态：Proposed",
      "docs/evidence/g2-00-03.md": "- 结论：**FAIL**",
    },
  };

  const violations = evaluateFoundationSnapshot(invalid, policy);
  assert.equal(violations.length, 8);
  assert.ok(violations.some((value) => value.includes("apps/api/server.ts")));
  assert.ok(violations.some((value) => value.includes("packages/contracts/view.tsx")));
  assert.ok(violations.some((value) => value.includes("meta.project")));
  assert.ok(violations.some((value) => value.includes("ADR-007 is not Accepted")));
});

void test("builds a compact commit-bound clean-room manifest", () => {
  const manifest = foundationEvidenceManifest(
    {
      status: "PASS",
      commit: "a".repeat(40),
      dirty: false,
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:01:00.000Z",
      environment: { platform: "linux" },
      postgres: { serverVersionNum: "160014" },
      inputs: { testkitFixtureDigest: "sha256:test" },
      steps: [
        {
          name: "unit",
          command: "npm run test:unit",
          status: "PASS",
          durationMs: 1,
          outputTail: "must not be duplicated",
        },
      ],
      artifacts: [{ path: "report.json", sha256: "digest", bytes: 1 }],
      artifactCounts: { vulnerabilities: { findings: 0 } },
    },
    {
      status: "PASS",
      decisions: [{ id: "ADR-007" }],
      scope: { businessApplications: [] },
      delivery: policy.delivery,
      residualRisks: policy.residualRisks,
    },
  );

  assert.equal(manifest.status, "PASS");
  assert.equal(manifest.qualification, "CLEAN_ROOM_PASS");
  assert.equal(manifest.commit, "a".repeat(40));
  assert.deepEqual(manifest.results, [
    { name: "unit", command: "npm run test:unit", status: "PASS", durationMs: 1 },
  ]);
  assert.equal(JSON.stringify(manifest).includes("must not be duplicated"), false);
});

function validSnapshot(): FoundationRepositorySnapshot {
  return {
    trackedFiles: [
      "packages/contracts/package.json",
      "migrations/db-00/0001_foundation.sql",
      "spikes/g1/example.tsx",
    ],
    workspacePackages: ["packages/contracts"],
    migrationFiles: ["migrations/db-00/0001_foundation.sql"],
    createdTables: ["ontos_migration.schema_migrations"],
    documents: {
      "docs/architecture/adr/007.md": "- 状态：Accepted for G2-00-03",
      "docs/evidence/g2-00-01.md": "- 结论：**PASS（G2-00-01）**",
      "docs/evidence/g2-00-03.md": "- 结论：**PASS（G2-00-03）**",
    },
  };
}
