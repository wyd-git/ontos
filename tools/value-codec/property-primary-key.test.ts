import assert from "node:assert/strict";
import test from "node:test";

import {
  ValueCodecError,
  canonicalizeDistinctPrimaryKeys,
  canonicalizePrimaryKey,
  canonicalizePropertyValue,
  canonicalizeRestrictedJson,
  canonicalizeStringArray,
  compareScalarValues,
  normalizePrimaryKeyString,
  type PrimaryKeyDefinition,
} from "../../packages/value-codec/src/index.ts";

void test("Property codec covers boolean, enum, string, string array, nullable, and restricted JSON", () => {
  assert.equal(canonicalizePropertyValue(true, { type: "boolean" }), true);
  assert.equal(
    canonicalizePropertyValue("ACTIVE", { type: "enum", values: ["NEW", "ACTIVE"] }),
    "ACTIVE",
  );
  assert.equal(canonicalizePropertyValue(null, { type: "string", nullable: true }), null);
  assert.deepEqual(canonicalizeStringArray(["甲", "b"]), ["甲", "b"]);
  assert.deepEqual(canonicalizePropertyValue({ z: [true, null], a: 1.25 }, { type: "json" }), {
    a: 1.25,
    z: [true, null],
  });

  assertCodecError(
    () => canonicalizePropertyValue("UNKNOWN", { type: "enum", values: ["NEW", "ACTIVE"] }),
    "ENUM_VALUE_INVALID",
  );
  assertCodecError(
    () => canonicalizePropertyValue(null, { type: "string" }),
    "VALUE_TYPE_MISMATCH",
  );
  assertCodecError(
    () => canonicalizeStringArray(["a", "b"], { type: "string[]", maximumItems: 1 }),
    "STRING_ARRAY_TOO_LARGE",
  );
});

void test("restricted JSON has deterministic UTF-8 key order and rejects lossy or cyclic input", () => {
  assert.equal(
    canonicalizeRestrictedJson({ 中文: true, b: 2, a: 1, nested: { y: 2, x: 1 } }),
    '{"a":1,"b":2,"nested":{"x":1,"y":2},"中文":true}',
  );
  assert.equal(canonicalizeRestrictedJson(-0), "0");

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assertCodecError(() => canonicalizeRestrictedJson(cyclic), "JSON_VALUE_INVALID");
  assertCodecError(() => canonicalizeRestrictedJson(9_007_199_254_740_992), "JSON_VALUE_INVALID");
  assertCodecError(() => canonicalizeRestrictedJson(1e-7), "JSON_VALUE_INVALID");
  assertCodecError(
    () => canonicalizeRestrictedJson({ value: "0123456789" }, { maximumBytes: 8 }),
    "JSON_VALUE_INVALID",
  );
});

void test("Primary Key uses NFC and a frozen locale-independent case rule", () => {
  assert.equal(normalizePrimaryKeyString("Cafe\u0301", true), "Café");
  assert.equal(normalizePrimaryKeyString("straße", false), "STRASSE");
  assert.equal(
    canonicalizePrimaryKey(["Cafe\u0301"], {
      components: [{ type: "string", caseSensitive: true }],
    }),
    "pk1|1|s5#Café",
  );
  assert.equal(
    canonicalizePrimaryKey(["tenant|north", "-0"], {
      components: [{ type: "string", caseSensitive: true }, { type: "integer" }],
    }),
    "pk1|2|s12#tenant|northi1#0",
  );
});

void test("Primary Key framing prevents delimiter and component-boundary ambiguity", () => {
  const definition: PrimaryKeyDefinition = {
    components: [
      { type: "string", caseSensitive: true },
      { type: "string", caseSensitive: true },
    ],
  };
  const left = canonicalizePrimaryKey(["ab", "c"], definition);
  const right = canonicalizePrimaryKey(["a", "bc"], definition);
  const delimiter = canonicalizePrimaryKey(["a#|", "bc"], definition);

  assert.notEqual(left, right);
  assert.notEqual(left, delimiter);
  assert.equal(left, "pk1|2|s2#abs1#c");
});

void test("Primary Key rejects oversize and reports normalization collisions before persistence", () => {
  assertCodecError(
    () =>
      canonicalizePrimaryKey(["0123456789"], {
        components: [{ type: "string", caseSensitive: true }],
        maximumBytes: 10,
      }),
    "PRIMARY_KEY_TOO_LARGE",
  );

  assertCodecError(
    () =>
      canonicalizeDistinctPrimaryKeys(
        [
          { candidateId: "row-1", values: ["Cafe\u0301"] },
          { candidateId: "row-2", values: ["Café"] },
        ],
        { components: [{ type: "string", caseSensitive: true }] },
      ),
    "PRIMARY_KEY_COLLISION",
  );
  assertCodecError(
    () =>
      canonicalizeDistinctPrimaryKeys(
        [
          { candidateId: "row-1", values: ["straße"] },
          { candidateId: "row-2", values: ["STRASSE"] },
        ],
        { components: [{ type: "string", caseSensitive: false }] },
      ),
    "PRIMARY_KEY_COLLISION",
  );
});

void test("scalar ordering follows numeric, enum declaration, and UTF-8 C-collation semantics", () => {
  assert.equal(compareScalarValues("10", "2", { type: "integer" }), 1);
  assert.equal(compareScalarValues("9.99", "10", { type: "decimal", precision: 5, scale: 2 }), -1);
  assert.equal(compareScalarValues("HIGH", "LOW", { type: "enum", values: ["LOW", "HIGH"] }), 1);
  assert.equal(compareScalarValues("z", "中文", { type: "string" }), -1);
});

function assertCodecError(action: () => unknown, code: ValueCodecError["code"]): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof ValueCodecError && error.code === code,
  );
}
