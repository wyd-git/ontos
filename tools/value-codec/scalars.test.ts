import assert from "node:assert/strict";
import test from "node:test";

import {
  ValueCodecError,
  canonicalizeDate,
  canonicalizeDecimal,
  canonicalizeInteger,
  canonicalizeTimestamp,
  canonicalizeUuid,
  compareCanonicalDecimals,
  compareCanonicalIntegers,
  timestampToEpochMicroseconds,
} from "../../packages/value-codec/src/index.ts";

void test("integer preserves the full signed 64-bit range without JavaScript number", () => {
  const minimum = canonicalizeInteger("-9223372036854775808");
  const maximum = canonicalizeInteger("9223372036854775807");

  assert.equal(minimum, "-9223372036854775808");
  assert.equal(maximum, "9223372036854775807");
  assert.equal(compareCanonicalIntegers(minimum, maximum), -1);
  assertCodecError(() => canonicalizeInteger(9_007_199_254_740_992), "VALUE_TYPE_MISMATCH");
  assertCodecError(() => canonicalizeInteger("9223372036854775808"), "INTEGER_VALUE_OUT_OF_RANGE");
  assertCodecError(() => canonicalizeInteger("01"), "INTEGER_FORMAT_INVALID");
  assertCodecError(() => canonicalizeInteger("+1"), "INTEGER_FORMAT_INVALID");
});

void test("decimal validates precision and scale before producing fixed-scale text", () => {
  const format = { precision: 38, scale: 18 } as const;
  const low = canonicalizeDecimal("-99999999999999999999.999999999999999999", format);
  const zero = canonicalizeDecimal("-0", format);
  const high = canonicalizeDecimal("99999999999999999999.999999999999999999", format);

  assert.equal(low, "-99999999999999999999.999999999999999999");
  assert.equal(zero, "0.000000000000000000");
  assert.equal(high, "99999999999999999999.999999999999999999");
  assert.equal(compareCanonicalDecimals(low, zero), -1);
  assert.equal(compareCanonicalDecimals(zero, high), -1);
  assert.equal(
    compareCanonicalDecimals(
      canonicalizeDecimal("1.2", { precision: 3, scale: 1 }),
      canonicalizeDecimal("1.20", { precision: 3, scale: 2 }),
    ),
    0,
  );
  assert.equal(canonicalizeDecimal("1.2", { precision: 5, scale: 2 }), "1.20");
  assertCodecError(
    () => canonicalizeDecimal("1000.00", { precision: 5, scale: 2 }),
    "DECIMAL_VALUE_OUT_OF_RANGE",
  );
  assertCodecError(
    () => canonicalizeDecimal("1.234", { precision: 5, scale: 2 }),
    "DECIMAL_VALUE_OUT_OF_RANGE",
  );
  assertCodecError(
    () => canonicalizeDecimal("1e2", { precision: 5, scale: 2 }),
    "DECIMAL_FORMAT_INVALID",
  );
});

void test("date rejects rollover and accepts Gregorian leap days", () => {
  assert.equal(canonicalizeDate("2000-02-29"), "2000-02-29");
  assertCodecError(() => canonicalizeDate("1900-02-29"), "DATE_INVALID");
  assertCodecError(() => canonicalizeDate("2026-2-01"), "DATE_INVALID");
});

void test("timestamp normalizes offsets and preserves exactly six fractional digits", () => {
  const canonical = canonicalizeTimestamp("2026-08-13T16:01:02.123456+08:00");

  assert.equal(canonical, "2026-08-13T08:01:02.123456Z");
  assert.equal(canonicalizeTimestamp("2026-08-13T08:01:02Z"), "2026-08-13T08:01:02.000000Z");
  assert.equal(
    timestampToEpochMicroseconds(canonical),
    timestampToEpochMicroseconds(canonicalizeTimestamp("2026-08-13T10:01:02.123456+02:00")),
  );
  assert.equal(canonicalizeTimestamp("2026-01-01T00:30:00+01:00"), "2025-12-31T23:30:00.000000Z");
  assert.equal(canonicalizeTimestamp("0001-01-01T00:00:00Z"), "0001-01-01T00:00:00.000000Z");
  assert.equal(canonicalizeTimestamp("9999-12-31T23:59:59.999999Z"), "9999-12-31T23:59:59.999999Z");
});

void test("timestamp rejects ambiguous or lossy boundary values", () => {
  for (const value of [
    "2026-08-13 08:01:02Z",
    "2026-08-13T08:01:02",
    "2026-08-13T08:01:60Z",
    "2026-08-13T08:01:02.1234567Z",
    "2026-08-13T08:01:02-00:00",
    "2026-08-13T08:01:02+14:01",
    "0001-01-01T00:00:00+14:00",
  ]) {
    assertCodecError(() => canonicalizeTimestamp(value), "TIMESTAMP_INVALID");
  }
});

void test("UUID accepts hexadecimal case but emits one lowercase representation", () => {
  assert.equal(
    canonicalizeUuid("550E8400-E29B-41D4-A716-446655440000"),
    "550e8400-e29b-41d4-a716-446655440000",
  );
  assertCodecError(
    () => canonicalizeUuid("{550e8400-e29b-41d4-a716-446655440000}"),
    "UUID_INVALID",
  );
});

function assertCodecError(action: () => unknown, code: ValueCodecError["code"]): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof ValueCodecError && error.code === code,
  );
}
