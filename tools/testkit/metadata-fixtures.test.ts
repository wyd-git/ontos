import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { preparePackageCandidate } from "@ontos/metadata-domain";

import {
  auditMetadataPackageFixtures,
  buildMetadataPackageFixtures,
  metadataFixtureCandidate,
} from "./metadata-fixtures.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

void test("two metadata-only Package fixtures are reproducible and accepted by the G2-01 parser", async () => {
  const fixtures = await buildMetadataPackageFixtures(repositoryRoot);
  assert.deepEqual(Object.keys(fixtures).sort(), ["commerce", "work-management"]);
  for (const fixture of Object.values(fixtures)) {
    const prepared = preparePackageCandidate(metadataFixtureCandidate(fixture));
    assert.equal(prepared.resources.length, 1);
    assert.ok(prepared.resources.every(({ family }) => family === "object_type"));
    const serialized = JSON.stringify(fixture);
    for (const forbidden of ["actions", "policies", "views", "migrations", "rawSql", "secret"]) {
      assert.equal(serialized.includes(`"${forbidden}"`), false);
    }
  }
});

void test("committed metadata-only Package bytes equal the deterministic builder", async () => {
  const audit = await auditMetadataPackageFixtures(repositoryRoot);
  assert.equal(audit.status, "PASS", audit.violations.join("\n"));
  assert.equal(audit.fixtureCount, 2);
  assert.match(audit.fixtureDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(audit.compatibilityCaseCount, 8);
  assert.match(audit.compatibilityVectorSha256, /^sha256:[0-9a-f]{64}$/u);
});
