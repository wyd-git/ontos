import assert from "node:assert/strict";
import test from "node:test";

import { parseTestCount, redactOutput } from "./run.ts";

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
