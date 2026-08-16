import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMaterializationEvidenceSnapshot,
  materializationEvidenceManifest,
  type MaterializationEvidencePolicy,
  type MaterializationEvidenceSnapshot,
} from "./materialization-evidence.ts";

const digest = `sha256:${"a".repeat(64)}`;
const evidencePath = "docs/evidence/g2-02-13.md";
const reviewPath = "docs/reviews/g2-02-13.md";
const mutations = [
  ["oidc", "tools/admin-api/oidc.test.ts", "OIDC_MARKER", "admin", "oidc.test.ts", "oidc"],
  ["migration", "tools/database/db.test.ts", "MIGRATION_MARKER", "db", "db.test.ts", "db"],
  [
    "job_fencing",
    "tools/worker/worker.test.ts",
    "FENCING_MARKER",
    "worker",
    "worker.test.ts",
    "worker",
  ],
  ["staging_visibility", "tools/database/db.test.ts", "STAGING_MARKER", "db", "db.test.ts", "db"],
  ["plan_digest", "tools/plan/plan.test.ts", "PLAN_MARKER", "unit", "plan.test.ts", "unit"],
  [
    "capacity",
    "tools/capacity/capacity.test.ts",
    "CAPACITY_MARKER",
    "unit",
    "capacity.test.ts",
    "unit",
  ],
  ["cutover_atomicity", "tools/database/db.test.ts", "CUTOVER_MARKER", "db", "db.test.ts", "db"],
  [
    "scope",
    "tools/ci/materialization-evidence.test.ts",
    "SCOPE_MARKER",
    "unit",
    "materialization-evidence.test.ts",
    "unit",
  ],
] as const;

const policy: MaterializationEvidencePolicy = {
  schemaVersion: 1,
  gate: "G2-02",
  baselineCommit: "b".repeat(40),
  requiredEvidence: [evidencePath],
  requiredReviews: [reviewPath],
  scope: {
    allowedExactPaths: ["package.json"],
    allowedPrefixes: ["tools/ci/"],
    forbiddenPrefixes: ["packages/query/"],
  },
  fixtures: {
    digest,
    domainCount: 2,
    memberCount: 6,
    negativeFixtureIds: [
      "bad_csv_unclosed_quote",
      "primary_key_collision",
      "quality_threshold_exceeded",
      "required_link_dangling",
    ],
    benchmarkObjectCount: 100_000,
    benchmarkLinkCount: 1_000_000,
  },
  productionStages: [
    "scan",
    "map",
    "validate",
    "build_stage",
    "build_index",
    "ready_for_activation",
    "catch_up",
    "activate",
  ],
  mutationChecks: mutations.map(([id, source, marker, script, routeFragment, requiredGate]) => ({
    id,
    source,
    marker,
    script,
    routeFragment,
    requiredGate,
  })),
  requiredGates: ["admin", "db", "oidc", "unit", "worker"],
  owner: "owner",
  residualRisks: [],
};

void test("accepts bounded scope, fixtures, production stages and eight mutation guards", () => {
  assert.deepEqual(evaluateMaterializationEvidenceSnapshot(validSnapshot(), policy), []);
});

void test("rejects an out-of-scope Query path mutation", () => {
  const snapshot = validSnapshot();
  const violations = evaluateMaterializationEvidenceSnapshot(
    { ...snapshot, changedFiles: [...snapshot.changedFiles, "packages/query/src/index.ts"] },
    policy,
  );
  assert.ok(violations.some((violation) => violation.includes("scope forbids")));
});

void test("fails closed when production skips a stage or exposes a serving pointer", () => {
  const snapshot = validSnapshot();
  const production = {
    ...(snapshot.production as Readonly<Record<string, unknown>>),
    completedStages: policy.productionStages.slice(1),
    assertions: { ...productionAssertions(), servingPointerBeforeOwner: 1 },
  };
  const violations = evaluateMaterializationEvidenceSnapshot({ ...snapshot, production }, policy);
  assert.ok(violations.some((violation) => violation.includes("eight-stage")));
  assert.ok(violations.some((violation) => violation.includes("before Owner")));
});

void test("fails closed when any mutation guard disappears from its routed test", () => {
  const snapshot = validSnapshot();
  const violations = evaluateMaterializationEvidenceSnapshot(
    {
      ...snapshot,
      sourceTexts: {
        ...snapshot.sourceTexts,
        "tools/admin-api/oidc.test.ts": "marker removed",
      },
    },
    policy,
  );
  assert.ok(violations.some((violation) => violation.includes("Mutation oidc marker")));
});

void test("the manifest requires every unified gate exactly once", () => {
  const report = {
    status: "PASS",
    dirty: false,
    commit: "c".repeat(40),
    steps: [{ name: "unit", status: "PASS", command: "npm run test:unit", testCount: 7 }],
  };
  const acceptance = { status: "PASS", requiredGates: ["unit"] };
  const production = { status: "PASS", cleanCheckout: true, commit: "c".repeat(40) };
  const manifest = materializationEvidenceManifest(report, acceptance, production);
  assert.equal(manifest.status, "PASS");
  assert.equal(manifest.qualification, "PRODUCTION_BOUNDARY_PASS");
  assert.equal(manifest.testCount, 7);

  assert.equal(
    materializationEvidenceManifest(
      report,
      { status: "PASS", requiredGates: ["unit", "postgres"] },
      production,
    ).status,
    "FAIL",
  );
});

function validSnapshot(): MaterializationEvidenceSnapshot {
  const sourceTexts: Record<string, string> = {};
  const trackedFiles = [evidencePath, reviewPath];
  const packageScripts: Record<string, string> = {};
  for (const [, source, marker, script, routeFragment] of mutations) {
    sourceTexts[source] = `${sourceTexts[source] ?? ""}\n${marker}`;
    trackedFiles.push(source);
    packageScripts[script] = `${packageScripts[script] ?? ""} ${routeFragment}`;
  }
  return {
    currentCommit: "c".repeat(40),
    trackedFiles,
    changedFiles: ["package.json", "tools/ci/materialization-evidence.ts"],
    documents: {
      [evidencePath]: "- 结论：**PASS（G2-02-13）**",
      [reviewPath]: "- 结论：**PASS（无 P1/P2）**",
    },
    foundationAcceptance: { status: "PASS" },
    metadataAcceptance: { status: "PASS" },
    fixtures: {
      status: "PASS",
      fixtureDigest: digest,
      domainCount: 2,
      memberCount: 6,
      negativeFixtureIds: policy.fixtures.negativeFixtureIds,
      benchmark: { objectCount: 100_000, linkCount: 1_000_000 },
    },
    production: {
      status: "PASS",
      commit: "c".repeat(40),
      cleanCheckout: true,
      fixtureDigest: digest,
      completedStages: policy.productionStages,
      assertions: productionAssertions(),
    },
    sourceTexts,
    packageScripts,
  };
}

function productionAssertions(): Readonly<Record<string, unknown>> {
  return {
    oidcAdminHttp: true,
    managedVersionedObjectStore: true,
    productionWorker: true,
    ddlExecutor: true,
    servingPointerBeforeOwner: 0,
    ownerActivationChanged: true,
    releasePublished: true,
  };
}
