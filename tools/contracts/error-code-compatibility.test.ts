import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { diffErrorCodeCatalogs } from "./error-code-compatibility.ts";

void test("the stable core error catalog matches its v1 baseline", async () => {
  const baseline = await readJson("tools/contracts/baseline/error-codes.v1.json");
  const current = await readJson("packages/contracts/error-codes.json");
  assert.deepEqual(diffErrorCodeCatalogs(baseline, current), {
    compatible: true,
    findings: [],
  });
});

void test("adding an error code is compatible", async () => {
  const baseline = await readJson("tools/contracts/baseline/error-codes.v1.json");
  const candidate = structuredClone(baseline) as Record<string, unknown>;
  const errors = candidate.errors as unknown[];
  errors.push({
    code: "NEW_STABLE_ERROR",
    httpStatus: 400,
    category: "validation",
    retryable: false,
    meaning: "New meaning.",
    clientAction: "Correct the input.",
  });
  const report = diffErrorCodeCatalogs(baseline, candidate);
  assert.equal(report.compatible, true);
  assert.ok(report.findings.some((item) => item.code === "ERROR_CODE_ADDED"));
});

void test("removing or changing error semantics is breaking", async () => {
  const baseline = await readJson("tools/contracts/baseline/error-codes.v1.json");
  const removed = structuredClone(baseline) as Record<string, unknown>;
  (removed.errors as unknown[]).shift();
  assertBreaking(baseline, removed, "ERROR_CODE_REMOVED");

  const changed = structuredClone(baseline) as Record<string, unknown>;
  ((changed.errors as Record<string, unknown>[])[0] as Record<string, unknown>).retryable = true;
  assertBreaking(baseline, changed, "ERROR_CODE_SEMANTICS_CHANGED");
});

function assertBreaking(baseline: unknown, candidate: unknown, code: string): void {
  const report = diffErrorCodeCatalogs(baseline, candidate);
  assert.equal(report.compatible, false);
  assert.ok(report.findings.some((item) => item.code === code));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
