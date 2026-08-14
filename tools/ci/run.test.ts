import assert from "node:assert/strict";
import test from "node:test";

import { redactOutput } from "./run.ts";

void test("CI report output redacts credential assignments and high-confidence tokens", () => {
  const token = ["ghp", "_", "A".repeat(40)].join("");
  const output = redactOutput(`password=do-not-report-this-value\ntoken=${token}\n`);

  assert.equal(output.includes("do-not-report-this-value"), false);
  assert.equal(output.includes(token), false);
  assert.match(output, /\[REDACTED/u);
});
