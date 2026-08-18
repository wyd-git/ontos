import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluateG20302EvidenceSnapshot,
  g20302EvidenceManifest,
  type G20302EvidencePolicy,
  type G20302EvidenceSnapshot,
} from "./g2-03-02-evidence.ts";

const policy = JSON.parse(
  readFileSync(new URL("../../security/g2-03-02-evidence-policy.json", import.meta.url), "utf8"),
) as G20302EvidencePolicy;

function validSnapshot(): G20302EvidenceSnapshot {
  return {
    currentCommit: "a".repeat(40),
    trackedFiles: [
      ...policy.requiredRecords.map(({ path }) => path),
      ...policy.requiredSourceMarkers.map(({ path }) => path),
    ],
    changedFiles: [
      "packages/contracts/src/query.ts",
      "packages/runtime-read-client/generated/types.gen.ts",
    ],
    documents: Object.fromEntries(
      policy.requiredRecords.map(({ path, marker }) => [path, `# Record\n\n${marker}\n`]),
    ),
    sourceTexts: Object.fromEntries(
      policy.requiredSourceMarkers.map(({ path, markers }) => [path, markers.join("\n")]),
    ),
    rootPackageManifest: {
      scripts: {
        "generate:runtime-read": "node tools/contracts/runtime-read-generation.ts --write",
        "check:runtime-read-generation": "node tools/contracts/runtime-read-generation.ts",
      },
    },
    clientPackageManifest: {
      name: "@ontos/runtime-read-client",
      private: true,
      type: "module",
      exports: {
        ".": {
          types: "./dist/package.d.ts",
          import: "./dist/package.js",
        },
      },
    },
    foundationPolicy: {
      scope: { allowedWorkspacePackages: ["packages/runtime-read-client"] },
    },
    materializationPolicy: {
      scope: {
        allowedPrefixes: [
          "packages/contracts/",
          "packages/runtime-read-client/",
          "tools/contracts/",
        ],
      },
    },
    priorGatePolicy: {
      scope: {
        allowedExactPaths: [
          "docs/architecture/g2-03-ui-api-consumer-contract.md",
          "tools/ci/g2-03-02-evidence.test.ts",
          "tools/ci/g2-03-02-evidence.ts",
        ],
        allowedPrefixes: [
          "packages/contracts/",
          "packages/runtime-read-client/",
          "tools/contracts/",
        ],
      },
    },
    generationArtifact: generationArtifact(),
  };
}

function generationArtifact(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    gate: "G2-03-02",
    status: "PASS",
    qualification: "SINGLE_SOURCE_SCHEMA_OPENAPI_GENERATED_CLIENT",
    schemaSha256: "1".repeat(64),
    openApiSha256: "2".repeat(64),
    generatedSha256: "3".repeat(64),
    generatedFileCount: 17,
    distributionSha256: "4".repeat(64),
    distributionFileCount: 34,
    operationCount: 5,
    deterministic: true,
    generatedClientCompiled: true,
    strictPublicTypesCompiled: true,
    strictWebConsumerCompiled: true,
    distributionRuntimeImported: true,
    exactOptionalPropertyTypes: {
      publicTypes: true,
      generatedTransport: false,
      packagedWebConsumer: true,
    },
  };
}

void test("accepts the complete G2-03-02 contract evidence snapshot", () => {
  assert.deepEqual(evaluateG20302EvidenceSnapshot(validSnapshot(), policy), []);
});

void test("rejects Migration, Web, and formal Query implementation before G2-03-03", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20302EvidenceSnapshot(
    {
      ...snapshot,
      changedFiles: [
        "migrations/db-00/0022_query_policy.sql",
        "apps/web/src/main.tsx",
        "packages/query/src/compiler.ts",
      ],
    },
    policy,
  );
  assert.equal(violations.filter((value) => value.includes("forbids changed path")).length, 3);
});

void test("rejects a Generated Client that is no longer deterministic or private", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20302EvidenceSnapshot(
    {
      ...snapshot,
      clientPackageManifest: {
        name: "@ontos/runtime-read-client",
        private: false,
        type: "module",
      },
      generationArtifact: { ...generationArtifact(), deterministic: false },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("private Candidate")),
    true,
  );
  assert.equal(
    violations.some((value) => value.includes("generation artifact")),
    true,
  );
});

void test("rejects a package root that bypasses the compiled distribution", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20302EvidenceSnapshot(
    {
      ...snapshot,
      clientPackageManifest: {
        name: "@ontos/runtime-read-client",
        private: true,
        type: "module",
        exports: { ".": "./generated/index.ts" },
      },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("deterministic distribution boundary")),
    true,
  );
});

void test("rejects historical scope that does not forward-admit the contract package", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20302EvidenceSnapshot(
    { ...snapshot, priorGatePolicy: { scope: { allowedPrefixes: [] } } },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("G2-03-01 forward scope")),
    true,
  );
});

void test("rejects historical scope that omits exact downstream evidence paths", () => {
  const snapshot = validSnapshot();
  const prior = snapshot.priorGatePolicy as {
    scope: { allowedExactPaths: readonly string[]; allowedPrefixes: readonly string[] };
  };
  const violations = evaluateG20302EvidenceSnapshot(
    {
      ...snapshot,
      priorGatePolicy: {
        scope: {
          ...prior.scope,
          allowedExactPaths: prior.scope.allowedExactPaths.filter(
            (path) => path !== "tools/ci/g2-03-02-evidence.ts",
          ),
        },
      },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("G2-03-01 forward scope")),
    true,
  );
});

void test("manifest requires every named gate exactly once and the generation artifact", () => {
  const steps = policy.requiredGates.map((name) => ({ name, status: "PASS" }));
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
  assert.equal(g20302EvidenceManifest(report, acceptance, generationArtifact()).status, "PASS");
  assert.equal(
    g20302EvidenceManifest(
      { ...report, steps: steps.filter(({ name }) => name !== "runtime-read-contract-generation") },
      acceptance,
      generationArtifact(),
    ).status,
    "FAIL",
  );
});
