import assert from "node:assert/strict";
import test from "node:test";

import { ValueCodecError } from "../../packages/value-codec/src/index.ts";
import {
  assertGoldenCollision,
  evaluateGoldenPrimaryKey,
  evaluateGoldenValue,
  evaluateTypeScriptOrder,
  loadGoldenVectors,
} from "./golden.ts";

const vectors = await loadGoldenVectors();

void test("every public value type matches the shared positive Golden Vectors", () => {
  for (const vector of vectors.positive) {
    assert.deepEqual(evaluateGoldenValue(vector), vector.expected, vector.id);
  }
});

void test("Snapshot, Action, Query, and SDK consume the same Golden Vector contract", () => {
  const boundaries = ["Snapshot", "Action", "Query", "SDK"] as const;
  for (const vector of vectors.positive) {
    const results = boundaries.map(() => evaluateGoldenValue(vector));
    for (const [index, result] of results.entries()) {
      assert.deepEqual(result, vector.expected, `${boundaries[index]}:${vector.id}`);
    }
  }
});

void test("invalid public values fail with the stable Golden Vector error", () => {
  for (const vector of vectors.invalid) {
    assert.throws(
      () => evaluateGoldenValue(vector),
      (error: unknown) => error instanceof ValueCodecError && error.code === vector.expectedError,
      vector.id,
    );
  }
});

void test("canonical Primary Keys match versioned Golden Vectors", () => {
  for (const vector of vectors.primaryKeys) {
    assert.equal(evaluateGoldenPrimaryKey(vector), vector.expected, vector.id);
  }
});

void test("different source values that share an identity are reported as collisions", () => {
  for (const vector of vectors.collisions) assertGoldenCollision(vector);
});

void test("TypeScript sorting matches the canonical order vectors", () => {
  for (const vector of vectors.orderGroups) {
    assert.deepEqual(evaluateTypeScriptOrder(vector), vector.expectedCanonicalOrder, vector.id);
  }
});

void test("integer and decimal wire JSON are strings instead of JavaScript numbers", () => {
  const exactNumericVectors = vectors.positive.filter(
    (vector) => vector.kind === "integer" || vector.kind === "decimal",
  );
  for (const vector of exactNumericVectors) {
    const encoded = JSON.stringify({ value: evaluateGoldenValue(vector) });
    const parsed: unknown = JSON.parse(encoded);
    assert.ok(isRecord(parsed), vector.id);
    assert.equal(typeof parsed.value, "string", vector.id);
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
