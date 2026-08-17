import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluateG20301EvidenceSnapshot,
  type G20301EvidencePolicy,
  type G20301EvidenceSnapshot,
} from "./g2-03-01-evidence.ts";

const policy = JSON.parse(
  readFileSync(new URL("../../security/g2-03-01-evidence-policy.json", import.meta.url), "utf8"),
) as G20301EvidencePolicy;
const commit = "5".repeat(40);

function validSnapshot(): G20301EvidenceSnapshot {
  const documents = Object.fromEntries(
    policy.requiredRecords.map(({ path, marker }) => [path, `# record\n\n${marker}\n`]),
  );
  const sourceTexts = Object.fromEntries(
    policy.requiredSourceMarkers.map(({ path, markers }) => [path, markers.join("\n")]),
  );
  return {
    currentCommit: commit,
    trackedFiles: [
      ...policy.requiredRecords.map(({ path }) => path),
      ...policy.requiredSourceMarkers.map(({ path }) => path),
    ],
    changedFiles: ["tools/query-policy-architecture/policy-query.ts"],
    documents,
    sourceTexts,
    packageManifest: {
      devDependencies: policy.webStack,
      overrides: { "js-yaml": "4.3.1" },
    },
    foundationPolicy: { scope: { ignoredPrefixes: ["spikes/g1/", "spikes/g2-03-01/"] } },
    materializationPolicy: {
      scope: {
        allowedPrefixes: ["spikes/g2-03-01/", "tools/query-policy-architecture/"],
      },
    },
    webArtifact: {
      status: "PASS",
      qualification: "OPENAPI_GENERATED_CLIENT_CONSUMER_COMPILE",
      input: { operationCount: 3 },
      generated: { deterministicRegeneration: true, fileCount: 16 },
      consumer: {
        typecheck: true,
        productionBuild: true,
        generatedClientOnly: true,
        workspaceInternalImports: 0,
        domainSpecificFields: 0,
      },
      mutations: ["required", "enum", "nullability"].map((id) => ({
        id,
        generated: true,
        consumerCompileRejected: true,
      })),
      versions: {
        openapiGenerator: policy.webStack["@hey-api/openapi-ts"],
        browserTest: policy.webStack["@playwright/test"],
        query: policy.webStack["@tanstack/react-query"],
        table: policy.webStack["@tanstack/react-table"],
        reactPlugin: policy.webStack["@vitejs/plugin-react"],
        oidc: policy.webStack["oidc-client-ts"],
        react: policy.webStack["react"],
        reactDom: policy.webStack["react-dom"],
        reactRouter: policy.webStack["react-router"],
        vite: policy.webStack["vite"],
      },
    },
    postgresArtifact: {
      status: "PASS",
      qualification: "REAL_POSTGRES_16_POLICY_QUERY_SPIKE",
      commit,
      cleanCheckout: true,
      postgres: { serverVersionNum: "160014" },
      executionContext: {
        source: "release-serving-head",
        memberCount: 3,
        generationCount: 3,
      },
      assertions: {
        currentGenerationResolvedOnce: true,
        policyBeforePagination: true,
        allValuesParameterized: true,
        fixtureApiBranching: false,
        productionG1Imports: false,
        unboundedCurrentTableSequentialScans: 0,
      },
      statements: ["typed-get", "object-list", "policy-count", "one-hop-link"].map((name) => ({
        name,
        sqlShape: "SELECT $1",
        parameterTypes: ["uuid"],
        indexes: ["index_name"],
        explainAnalyzeBuffers: { Plan: {} },
      })),
    },
  };
}

void test("accepts the complete G2-03-01 architecture evidence snapshot", () => {
  assert.deepEqual(evaluateG20301EvidenceSnapshot(validSnapshot(), policy), []);
});

void test("rejects a Migration or formal Web application before G2-03-01 passes", () => {
  const snapshot = validSnapshot();
  const violations = evaluateG20301EvidenceSnapshot(
    {
      ...snapshot,
      changedFiles: ["migrations/db-00/0022_query_policy.sql", "apps/web/src/main.tsx"],
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("forbids changed path migrations/")),
    true,
  );
  assert.equal(
    violations.some((value) => value.includes("forbids changed path apps/web/")),
    true,
  );
});

void test("rejects a Spec mutation that still compiles in the consumer", () => {
  const snapshot = validSnapshot();
  const web = snapshot.webArtifact as { mutations: Array<Record<string, unknown>> };
  const violations = evaluateG20301EvidenceSnapshot(
    {
      ...snapshot,
      webArtifact: {
        ...(snapshot.webArtifact as Record<string, unknown>),
        mutations: web.mutations.map((mutation) =>
          mutation["id"] === "nullability"
            ? { ...mutation, consumerCompileRejected: false }
            : mutation,
        ),
      },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("Spec to Client to Consumer mutation")),
    true,
  );
});

void test("rejects a PostgreSQL Spike that bypasses Current Generation", () => {
  const snapshot = validSnapshot();
  const postgres = snapshot.postgresArtifact as Record<string, unknown>;
  const assertions = postgres["assertions"] as Record<string, unknown>;
  const violations = evaluateG20301EvidenceSnapshot(
    {
      ...snapshot,
      postgresArtifact: {
        ...postgres,
        assertions: { ...assertions, currentGenerationResolvedOnce: false },
      },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("PostgreSQL artifact")),
    true,
  );
});

void test("rejects fixture API-name branching in the production Spike source", () => {
  const snapshot = validSnapshot();
  const path = "tools/query-policy-architecture/policy-query.ts";
  const violations = evaluateG20301EvidenceSnapshot(
    {
      ...snapshot,
      sourceTexts: { ...snapshot.sourceTexts, [path]: `${snapshot.sourceTexts[path]}\nCustomer` },
    },
    policy,
  );
  assert.equal(
    violations.some((value) => value.includes("fixture API name")),
    true,
  );
});
