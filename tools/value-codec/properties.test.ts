import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import {
  INTEGER_MAXIMUM,
  INTEGER_MINIMUM,
  ValueCodecError,
  canonicalizeDecimal,
  canonicalizeDistinctPrimaryKeys,
  canonicalizeInteger,
  canonicalizePrimaryKey,
  canonicalizeTimestamp,
  decimalToUnscaled,
  timestampToEpochMicroseconds,
} from "../../packages/value-codec/src/index.ts";

const propertyParameters = { numRuns: 300, seed: 20_260_813 } as const;

void test("property: every signed 64-bit integer round-trips exactly as text", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: INTEGER_MINIMUM, max: INTEGER_MAXIMUM }), (value) => {
      const canonical = canonicalizeInteger(value.toString(10));
      assert.equal(BigInt(canonical), value);
      assert.equal(canonicalizeInteger(canonical), canonical);
    }),
    propertyParameters,
  );
});

void test("property: fixed-scale decimal round-trips through an unscaled bigint", () => {
  const format = { precision: 18, scale: 6 } as const;
  const limit = 10n ** 18n - 1n;
  fc.assert(
    fc.property(fc.bigInt({ min: -limit, max: limit }), (unscaled) => {
      const input = formatUnscaled(unscaled, format.scale);
      const canonical = canonicalizeDecimal(input, format);
      assert.equal(decimalToUnscaled(canonical), unscaled);
      assert.equal(canonicalizeDecimal(canonical, format), canonical);
    }),
    propertyParameters,
  );
});

void test("property: RFC3339 normalization is idempotent and preserves the microsecond instant", () => {
  fc.assert(
    fc.property(
      fc.record({
        year: fc.integer({ min: 2, max: 9_998 }),
        month: fc.integer({ min: 1, max: 12 }),
        day: fc.integer({ min: 1, max: 28 }),
        hour: fc.integer({ min: 0, max: 23 }),
        minute: fc.integer({ min: 0, max: 59 }),
        second: fc.integer({ min: 0, max: 59 }),
        microsecond: fc.integer({ min: 0, max: 999_999 }),
        offsetMinutes: fc.integer({ min: -840, max: 840 }),
      }),
      (parts) => {
        const input = timestampInput(parts);
        const canonical = canonicalizeTimestamp(input);
        assert.equal(canonicalizeTimestamp(canonical), canonical);
        assert.equal(
          timestampToEpochMicroseconds(canonicalizeTimestamp(input)),
          timestampToEpochMicroseconds(canonical),
        );
      },
    ),
    propertyParameters,
  );
});

void test("property: Primary Key framing cannot confuse adjacent component boundaries", () => {
  const text = fc
    .array(fc.constantFrom("a", "b", "c", "#", "|", "é", "中"), {
      minLength: 1,
      maxLength: 8,
    })
    .map((characters) => characters.join(""));
  const definition = {
    components: [
      { type: "string", caseSensitive: true },
      { type: "string", caseSensitive: true },
    ],
  } as const;

  fc.assert(
    fc.property(text, text, text, (left, middle, right) => {
      assert.notEqual(
        canonicalizePrimaryKey([left + middle, right], definition),
        canonicalizePrimaryKey([left, middle + right], definition),
      );
    }),
    propertyParameters,
  );
});

void test("property: case variants collide before a database write", () => {
  const lowerAscii = fc
    .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 24 })
    .map((characters) => characters.join(""));
  const definition = {
    components: [{ type: "string", caseSensitive: false }],
  } as const;

  fc.assert(
    fc.property(lowerAscii, (value) => {
      assert.throws(
        () =>
          canonicalizeDistinctPrimaryKeys(
            [
              { candidateId: "lower", values: [value] },
              { candidateId: "upper", values: [value.toUpperCase()] },
            ],
            definition,
          ),
        (error: unknown) =>
          error instanceof ValueCodecError && error.code === "PRIMARY_KEY_COLLISION",
      );
    }),
    propertyParameters,
  );
});

function formatUnscaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString(10).padStart(scale + 1, "0");
  const split = digits.length - scale;
  return `${negative ? "-" : ""}${digits.slice(0, split)}.${digits.slice(split)}`;
}

function timestampInput(parts: {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly microsecond: number;
  readonly offsetMinutes: number;
}): string {
  const absoluteOffset = Math.abs(parts.offsetMinutes);
  const zone =
    parts.offsetMinutes === 0
      ? "Z"
      : `${parts.offsetMinutes < 0 ? "-" : "+"}${pad(Math.floor(absoluteOffset / 60), 2)}:${pad(
          absoluteOffset % 60,
          2,
        )}`;
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}T${pad(
    parts.hour,
    2,
  )}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}.${pad(parts.microsecond, 6)}${zone}`;
}

function pad(value: number, width: number): string {
  return value.toString(10).padStart(width, "0");
}
