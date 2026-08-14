import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_NEGATIVE_FIXTURE_IDS,
  auditNegativeFixtures,
  evaluateNegativeFixtureCatalog,
  type NegativeFixtureCatalog,
} from "./metadata-negative-fixtures.ts";

void test("all required G2-01 negative fixtures bind to exactly one routed test", async () => {
  const report = await auditNegativeFixtures();
  assert.equal(report.status, "PASS", report.errors.join("\n"));
  assert.deepEqual(report.coveredIds, REQUIRED_NEGATIVE_FIXTURE_IDS);
  assert.equal(report.caseCount, 7);
});

void test("the negative fixture audit fails closed on a missing case or marker", () => {
  const baseCase = {
    id: "unknown_resource_field",
    requirement: "Unknown fields fail.",
    source: "tools/metadata-control-plane/resource-lifecycle.test.ts",
    marker: "G2_NEGATIVE:unknown_resource_field",
    execution: "unit" as const,
  };
  const incomplete: NegativeFixtureCatalog = {
    schemaVersion: 1,
    gate: "G2-01",
    cases: [baseCase],
  };
  const report = evaluateNegativeFixtureCatalog(
    incomplete,
    { [baseCase.source]: "no marker here" },
    { "test:unit": "node --test tools/metadata-control-plane/*.test.ts" },
  );
  assert.equal(report.status, "FAIL");
  assert.ok(report.errors.some((error) => error.includes("exactly")));
  assert.ok(report.errors.some((error) => error.includes("marker")));
});
