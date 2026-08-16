import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_MATERIALIZATION_FIXTURE_DIGEST,
  auditMaterializationFixtures,
} from "./materialization-fixtures.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

void test("audits two materialization domains, negative vectors and the streaming benchmark", async () => {
  const audit = await auditMaterializationFixtures(repositoryRoot);

  assert.equal(audit.status, "PASS", audit.violations.join("\n"));
  assert.equal(audit.fixtureDigest, EXPECTED_MATERIALIZATION_FIXTURE_DIGEST);
  assert.equal(audit.domainCount, 2);
  assert.equal(audit.memberCount, 6);
  assert.equal(audit.validCsvRowCount, 12);
  assert.deepEqual(audit.negativeFixtureIds, [
    "bad_csv_unclosed_quote",
    "primary_key_collision",
    "quality_threshold_exceeded",
    "required_link_dangling",
  ]);
  assert.deepEqual(audit.benchmark, {
    objectCount: 100_000,
    linkCount: 1_000_000,
    datasetDigest: "sha256:4cf9491ef477c7c98c9fba693dd3028100cc7f419bf8f7c53eac1fd1d6328446",
  });
});

void test("fails closed when the materialization fixture digest is mutated", async () => {
  const audit = await auditMaterializationFixtures(repositoryRoot, `sha256:${"0".repeat(64)}`);

  assert.equal(audit.status, "FAIL");
  assert.ok(audit.violations.some((violation) => violation.includes("fixture digest drifted")));
});
