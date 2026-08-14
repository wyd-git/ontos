import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditG1Provenance, fingerprintFiles } from "./provenance.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

void test("independently reproduces the frozen G1 source and migration-group fingerprints", async () => {
  const result = await auditG1Provenance(repositoryRoot);
  assert.deepEqual(result.violations, []);
  assert.equal(result.sourceFileCount, 47);
  assert.equal(result.groupCount, 7);
  assert.equal(
    result.sourceDigest,
    "sha256:dff360ddb4c6683ab0481eb6d3d5f122aea6ad4e8039c51e57634ba894bd4aa1",
  );
});

void test("fingerprints paths and bytes so either kind of provenance drift is visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "ontos-testkit-fingerprint-"));
  try {
    await writeFile(join(root, "a.txt"), "same bytes");
    await writeFile(join(root, "b.txt"), "same bytes");
    const first = await fingerprintFiles(root, ["a.txt"]);
    const renamed = await fingerprintFiles(root, ["b.txt"]);
    await writeFile(join(root, "a.txt"), "changed bytes");
    const changed = await fingerprintFiles(root, ["a.txt"]);

    assert.notEqual(first, renamed);
    assert.notEqual(first, changed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
