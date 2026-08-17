import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { parseTestCount, redactOutput } from "./run.ts";

const workflow = await readFile(resolve(".github/workflows/foundation-ci.yml"), "utf8");

void test("CI report output redacts credential assignments and high-confidence tokens", () => {
  const token = ["ghp", "_", "A".repeat(40)].join("");
  const output = redactOutput(`password=do-not-report-this-value\ntoken=${token}\n`);

  assert.equal(output.includes("do-not-report-this-value"), false);
  assert.equal(output.includes(token), false);
  assert.match(output, /\[REDACTED/u);
});

void test("extracts the final TAP test count for the evidence report", () => {
  assert.equal(parseTestCount("ℹ tests 7\nℹ pass 7\n"), 7);
  assert.equal(parseTestCount("no TAP summary"), null);
});

void test("GitHub CI reserves the full clean-room window and calls only the unified gate", () => {
  const timeout = /^\s*timeout-minutes:\s*(\d+)\s*$/mu.exec(workflow);
  assert.ok(timeout);
  assert.ok(Number(timeout[1]) >= 90);
  assert.equal((workflow.match(/^\s*run:\s*npm run verify\s*$/gmu) ?? []).length, 1);
  assert.equal((workflow.match(/^\s*run:/gmu) ?? []).length, 1);
  assert.equal(workflow.includes("test:materialization-clean-room"), false);
});
