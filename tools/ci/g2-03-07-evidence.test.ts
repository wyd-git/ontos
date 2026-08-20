import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MATERIALIZATION_FIXTURE_DIGEST } from "@ontos/testkit";

import {
  evaluateG20307EvidenceSnapshot,
  g20307EvidenceManifest,
  type G20307EvidencePolicy,
  type G20307EvidenceSnapshot,
} from "./g2-03-07-evidence.ts";

const policy = JSON.parse(
  readFileSync(new URL("../../security/g2-03-07-evidence-policy.json", import.meta.url), "utf8"),
) as G20307EvidencePolicy;
const forwardPrefixes = [
  "packages/query-application/",
  "packages/query-domain/",
  "packages/query-postgres/",
  "tools/query-compiler/",
];
const forwardExactPaths = [
  "docs/architecture/adr/025-typed-query-ast-parameterized-postgres-compiler.md",
  "docs/evidence/g2-03-07-typed-query-compiler.md",
  "docs/reviews/g2-03-07-intended-vs-implemented.md",
  "security/g2-03-07-evidence-policy.json",
  "tools/ci/g2-03-07-evidence.test.ts",
  "tools/ci/g2-03-07-evidence.ts",
];

function validSnapshot(): G20307EvidenceSnapshot {
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
      "docs/architecture/adr/025-typed-query-ast-parameterized-postgres-compiler.md",
      "packages/query-domain/src/compiler.ts",
      "packages/query-postgres/src/renderer.ts",
      "tools/query-compiler/postgres-evidence.ts",
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
          "packages/query-application",
          "packages/query-domain",
          "packages/query-postgres",
        ],
      },
    },
    priorPolicies: {
      "g2-02": { scope: forwardScope },
      "g2-03-01": { scope: forwardScope },
      "g2-03-02": { scope: forwardScope },
      "g2-03-03": { scope: forwardScope },
      "g2-03-04": { scope: forwardScope },
      "g2-03-05": { scope: forwardScope },
      "g2-03-06": { scope: forwardScope },
    },
    queryCompilerArtifact: queryCompilerArtifact(),
  };
}

function queryCompilerArtifact(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    gate: "G2-03-07",
    status: "PASS",
    qualification: "REAL_POSTGRES_16_TYPED_QUERY_COMPILER",
    commit: "a".repeat(40),
    cleanCheckout: true,
    postgres: { serverVersionNum: "160014" },
    provenance: {
      source: "packages/testkit/src/materialization.ts",
      fixtureDigest: MATERIALIZATION_FIXTURE_DIGEST,
      originalG1Sources: [
        "spikes/g1/packages/commerce/package.json",
        "spikes/g1/src/query/compiler.js",
      ],
      productionImportsFromG1: false,
    },
    executionContext: { resolution: "release-serving-head" },
    statements: ["get", "list", "policy_filter", "count", "link_candidate"].map((scenario) => ({
      scenario,
      statementName: `ontos_${scenario}`,
      sqlShape: "SELECT $1",
      parameterTypes: ["text"],
      indexes: [`idx_${scenario}`],
      publishedPlanIndexes: ["list", "policy_filter", "count"].includes(scenario)
        ? [`published_${scenario}`]
        : [],
      currentSequentialScans: 0,
    })),
    executionBoundaries: {
      statementTimeoutMs: 1,
      timeoutCancelledServerStatement: true,
      poolReusableAfterTimeout: true,
      backgroundLongStatements: 0,
      abortUnitGate: "query-compiler-unit",
      rowAndByteBoundaryUnitGate: "query-compiler-unit",
    },
    assertions: {
      typedAstBeforeExecution: true,
      publicValueCodec: true,
      allValuesParameterized: true,
      clientAndPolicySameWhere: true,
      propertyPolicyBeforeSortAndLimit: true,
      currentGenerationBound: true,
      unboundedCurrentTableSequentialScans: 0,
      timeoutCancelledServerStatement: true,
      poolReusableAfterTimeout: true,
    },
  };
}

void test("accepts complete G2-03-07 typed Query Compiler evidence", () => {
  assert.deepEqual(evaluateG20307EvidenceSnapshot(validSnapshot(), policy), []);
});

void test("rejects HTTP, migrations, Action and UI outside the compiler scope", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20307EvidenceSnapshot(
    {
      ...snapshot,
      changedFiles: [
        "apps/api/src/query.ts",
        "apps/web/src/query.tsx",
        "migrations/db-00/0028_query.sql",
        "packages/action/src/execute.ts",
      ],
    },
    policy,
  );
  assert.equal(violations.filter((value) => value.includes("forbids changed path")).length, 4);
});

void test("rejects a historical scope that cannot admit the compiler boundary", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20307EvidenceSnapshot(
    {
      ...snapshot,
      priorPolicies: {
        ...snapshot.priorPolicies,
        "g2-03-06": { scope: { allowedExactPaths: [], allowedPrefixes: [] } },
      },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("g2-03-06 forward scope")),
    true,
  );
});

void test("rejects unbound, sequential-scan or unclean PostgreSQL evidence", () => {
  const snapshot = validSnapshot();
  const artifact = queryCompilerArtifact();
  const statements = (artifact.statements as readonly Readonly<Record<string, unknown>>[]).map(
    (statement, index) =>
      index === 0 ? { ...statement, currentSequentialScans: 1, indexes: [] } : statement,
  );
  const violations = evaluateG20307EvidenceSnapshot(
    {
      ...snapshot,
      queryCompilerArtifact: { ...artifact, cleanCheckout: false, statements },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("Query Compiler artifact")),
    true,
  );
});

void test("manifest requires every gate and the same clean real PostgreSQL artifact", () => {
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
  assert.equal(g20307EvidenceManifest(report, acceptance, queryCompilerArtifact()).status, "PASS");
  assert.equal(
    g20307EvidenceManifest(
      { ...report, steps: steps.slice(1) },
      acceptance,
      queryCompilerArtifact(),
    ).status,
    "FAIL",
  );
  assert.equal(
    g20307EvidenceManifest(report, acceptance, {
      ...queryCompilerArtifact(),
      commit: "b".repeat(40),
    }).status,
    "FAIL",
  );
});
