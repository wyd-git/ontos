import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMetadataEvidenceSnapshot,
  metadataEvidenceManifest,
  type MetadataEvidencePolicy,
  type MetadataEvidenceSnapshot,
} from "./metadata-evidence.ts";

const evidencePath = "docs/evidence/g2-01-01.md";
const historicalPath = "docs/evidence/g2-00-01.md";
const fixturePath = "packages/testkit/fixtures/metadata-packages/commerce.json";
const vectorPath = "packages/testkit/fixtures/vectors/compatibility.json";
const digest = `sha256:${"a".repeat(64)}`;

const policy: MetadataEvidencePolicy = {
  schemaVersion: 1,
  gate: "G2-01",
  requiredEvidence: [evidencePath],
  protectedFoundationEvidence: { [historicalPath]: digest },
  metadataFixtures: { paths: [fixturePath], compatibilityVector: vectorPath },
  negativeFixtureIds: ["breaking_upgrade"],
  requiredGates: ["unit"],
  owner: "owner",
  residualRisks: [{ id: "RISK-1", risk: "risk", owner: "owner", nextGate: "G2-02" }],
};

void test("accepts bound Foundation history, Metadata fixtures and negative cases", () => {
  assert.deepEqual(evaluateMetadataEvidenceSnapshot(validSnapshot(), policy), []);
});

void test("changing historical G2-00 evidence cannot forge a G2-01 pass", () => {
  const snapshot = validSnapshot();
  const violations = evaluateMetadataEvidenceSnapshot(
    {
      ...snapshot,
      foundationEvidenceSha256: { [historicalPath]: `sha256:${"b".repeat(64)}` },
    },
    policy,
  );
  assert.ok(violations.some((violation) => violation.includes("Foundation evidence drifted")));
});

void test("fails closed when fixture or negative evidence is incomplete", () => {
  const snapshot = validSnapshot();
  const violations = evaluateMetadataEvidenceSnapshot(
    {
      ...snapshot,
      metadataFixtures: { status: "PASS", fixtureCount: 0, fixtures: [] },
      negativeFixtures: { status: "PASS", coveredIds: [] },
    },
    policy,
  );
  assert.ok(violations.some((violation) => violation.includes("fixture count")));
  assert.ok(violations.some((violation) => violation.includes("negative fixture IDs")));
});

void test("the manifest requires every named gate and distinguishes clean checkout", () => {
  const report = {
    status: "PASS",
    commit: "c".repeat(40),
    dirty: false,
    durationMs: 42,
    steps: [
      {
        name: "unit",
        command: "npm run test:unit",
        status: "PASS",
        durationMs: 2,
        testCount: 9,
      },
    ],
  };
  const acceptance = { status: "PASS", requiredGates: ["unit"] };
  const manifest = metadataEvidenceManifest(report, acceptance);
  assert.equal(manifest.status, "PASS");
  assert.equal(manifest.qualification, "CLEAN_ROOM_PASS");
  assert.equal(manifest.testCount, 9);

  const missing = metadataEvidenceManifest(report, {
    status: "PASS",
    requiredGates: ["unit", "postgres-integration"],
  });
  assert.equal(missing.status, "FAIL");
  assert.equal(missing.qualification, "FAIL");
});

void test("the manifest fails closed when the required clean-room artifact is absent", () => {
  const report = {
    status: "PASS",
    commit: "c".repeat(40),
    dirty: false,
    steps: [
      {
        name: "metadata-clean-room",
        command: "npm run test:metadata-clean-room",
        status: "PASS",
        durationMs: 2,
        testCount: 1,
      },
    ],
  };
  const acceptance = { status: "PASS", requiredGates: ["metadata-clean-room"] };

  assert.equal(metadataEvidenceManifest(report, acceptance).status, "FAIL");
  const manifest = metadataEvidenceManifest(report, acceptance, {
    gate: "G2-01-12",
    status: "PASS",
    scenarioStepCount: 24,
  });
  assert.equal(manifest.status, "PASS");
  assert.deepEqual(manifest.cleanRoom, {
    gate: "G2-01-12",
    status: "PASS",
    scenarioStepCount: 24,
  });
});

function validSnapshot(): MetadataEvidenceSnapshot {
  return {
    trackedFiles: [evidencePath, historicalPath, fixturePath, vectorPath],
    documents: { [evidencePath]: "- 结论：**PASS（G2-01-01）**" },
    foundationEvidenceSha256: { [historicalPath]: digest },
    foundationAcceptance: { status: "PASS" },
    metadataFixtures: {
      status: "PASS",
      fixtureCount: 1,
      fixtureDigest: digest,
      compatibilityVectorSha256: digest,
      compatibilityCaseCount: 2,
      fixtures: [{ path: fixturePath }],
    },
    negativeFixtures: {
      status: "PASS",
      coveredIds: ["breaking_upgrade"],
      catalogSha256: digest,
      evidenceSha256: digest,
    },
  };
}
