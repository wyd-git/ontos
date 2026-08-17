import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  evaluateMaterializationEvidenceSnapshot,
  materializationEvidenceManifest,
  type MaterializationEvidencePolicy,
  type MaterializationEvidenceSnapshot,
} from "./materialization-evidence.ts";

const digest = `sha256:${"a".repeat(64)}`;
const repositoryPolicy = JSON.parse(
  await readFile(resolve("security/g2-02-evidence-policy.json"), "utf8"),
) as MaterializationEvidencePolicy;
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
  [
    "data_project_limit",
    "tools/materialization-clean-room/clean-room.test.ts",
    "PROJECT_LIMIT_MARKER",
    "cleanroom",
    "clean-room.test.ts",
    "cleanroom",
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
  requiredGates: ["admin", "cleanroom", "db", "oidc", "unit", "worker"],
  owner: "owner",
  residualRisks: [],
};

void test("accepts bounded scope, fixtures, production stages and nine mutation guards", () => {
  assert.deepEqual(evaluateMaterializationEvidenceSnapshot(validSnapshot(), policy), []);
});

void test("the repository policy preserves nine failure classes and every full gate exactly once", () => {
  assert.equal(repositoryPolicy.mutationChecks.length, 9);
  assert.equal(new Set(repositoryPolicy.mutationChecks.map(({ id }) => id)).size, 9);
  assert.equal(new Set(repositoryPolicy.requiredGates).size, repositoryPolicy.requiredGates.length);
  assert.ok(repositoryPolicy.requiredGates.includes("documentation-links"));
  assert.ok(repositoryPolicy.requiredGates.includes("materialization-clean-room"));
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

void test("fails closed when canonical cutover microseconds exceed the SLO", () => {
  const snapshot = validSnapshot();
  const cleanRoom = snapshot.cleanRoom as Readonly<Record<string, unknown>>;
  const performance = cleanRoom.performance as Readonly<Record<string, unknown>>;
  const violations = evaluateMaterializationEvidenceSnapshot(
    {
      ...snapshot,
      cleanRoom: {
        ...cleanRoom,
        performance: {
          ...performance,
          cutovers: { runs: 20, p95Microseconds: 1_000_000, maxMicroseconds: 2_000_000 },
        },
      },
    },
    policy,
  );
  assert.ok(violations.some((violation) => violation.includes("Cutover evidence")));
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
  const cleanRoom = cleanRoomEvidence();
  const manifest = materializationEvidenceManifest(report, acceptance, production, cleanRoom);
  assert.equal(manifest.status, "PASS");
  assert.equal(manifest.qualification, "CLEAN_ROOM_PASS");
  assert.equal(manifest.testCount, 7);

  assert.equal(
    materializationEvidenceManifest(
      report,
      { status: "PASS", requiredGates: ["unit", "postgres"] },
      production,
      cleanRoom,
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
    cleanRoom: cleanRoomEvidence(),
    sourceTexts,
    packageScripts,
  };
}

function cleanRoomEvidence(): Readonly<Record<string, unknown>> {
  return {
    gate: "G2-02-14",
    status: "PASS",
    qualification: "CLEAN_ROOM_PASS",
    commit: "c".repeat(40),
    cleanCheckout: true,
    reportSha256: digest,
    migrations: { restartRunNoOp: true },
    fixtures: { fixtureDigest: digest },
    lifecycle: {
      r1A0BeforeMaterialization: true,
      firstObjectLinkGroupReady: true,
      badVersionRejected: true,
      badVersionPreservedServingHead: true,
      goodRefreshReady: true,
      refreshObservedOnlyOldOrNew: true,
      idempotentJobAndRefresh: true,
    },
    performance: {
      objectRows: 100_000,
      linkRows: 1_000_000,
      coldEndToEndMilliseconds: 100_000,
      warmRefreshEndToEndMilliseconds: 90_000,
      cutovers: { runs: 20, p95Microseconds: 100_000, maxMicroseconds: 200_000 },
    },
    recovery: {
      wholeEnvironmentRestarted: true,
      stateManifestIdentical: true,
      stateManifestBefore: digest,
      stateManifestAfter: digest,
    },
    capacity: {
      overHardLimitRejected: true,
      approvalCreated: true,
      hardLimitBytes: "12884901888",
    },
    security: {
      invalidOidcRejected: true,
      unauthorizedProjectHidden: true,
      crossProjectHidden: true,
      uploadTraversalRejected: true,
      apiDirectTableDenied: true,
      workerAuthTableDenied: true,
      ddlMetadataTableDenied: true,
      sensitiveErrorsRedacted: true,
    },
    garbageCollection: { orphanObjectVersionReclaimed: true, finalState: "COMMITTED" },
    overlayBoundary: {
      productionProvider: "certified-zero-overlay-only",
      realPostgresOverlay: "DEFERRED_G2_04",
    },
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
