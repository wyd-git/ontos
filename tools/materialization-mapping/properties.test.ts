import assert from "node:assert/strict";
import test from "node:test";

import {
  INTEGER_MAXIMUM,
  INTEGER_MINIMUM,
  canonicalizeTimestamp,
  decimalToUnscaled,
  timestampToEpochMicroseconds,
  type CanonicalDecimal,
  type CanonicalTimestamp,
} from "@ontos/value-codec";
import fc from "fast-check";

import {
  createMappingExecution,
  type MappingAcceptedObjectRow,
  type MappingRowEvent,
} from "@ontos/materialization-domain";

import { compileObjectFixture, digestCanonicalText, validObjectRow } from "./fixtures.ts";

const propertyParameters = { numRuns: 120, seed: 20_260_815 } as const;
const sourceContentDigest = digestCanonicalText("mapping-property-fixture");
const safeText = fc
  .array(fc.constantFrom(..."abcXYZ09#|é界"), { minLength: 1, maxLength: 20 })
  .map((characters) => characters.join(""));

void test("property: int64 and fixed-scale decimals survive Mapping without Number coercion", async () => {
  const decimalLimit = 10n ** 12n - 1n;
  await fc.assert(
    fc.asyncProperty(
      fc.bigInt({ min: INTEGER_MINIMUM, max: INTEGER_MAXIMUM }),
      fc.bigInt({ min: -decimalLimit, max: decimalLimit }),
      async (integer, unscaled) => {
        const row = [...validObjectRow()];
        row[3] = formatUnscaled(unscaled, 2);
        row[4] = integer.toString(10);
        const event = await accepted(row);
        const values = propertyValues(event);
        assert.equal(values.count, integer.toString(10));
        assert.equal(decimalToUnscaled(values.amount as CanonicalDecimal), unscaled);
        assert.equal((values.amount as string).split(".")[1]?.length, 2);
      },
    ),
    propertyParameters,
  );
});

void test("property: timezone inputs preserve the instant and normalize to UTC microseconds", async () => {
  await fc.assert(
    fc.asyncProperty(
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
      async (parts) => {
        const row = [...validObjectRow()];
        const input = timestampInput(parts);
        row[7] = input;
        const event = await accepted(row);
        const canonical = propertyValues(event).eventAt as CanonicalTimestamp;
        assert.match(canonical, /\.\d{6}Z$/u);
        const expected = canonicalizeTimestamp(input);
        assert.equal(canonical, expected);
        assert.equal(
          timestampToEpochMicroseconds(canonical),
          timestampToEpochMicroseconds(expected),
        );
        assert.deepEqual(await accepted(row), event);
      },
    ),
    propertyParameters,
  );
});

void test("property: Unicode identity normalization and case folding collide deterministically", async () => {
  const lowerAscii = fc
    .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 24 })
    .map((characters) => characters.join(""));
  await fc.assert(
    fc.asyncProperty(lowerAscii, async (value) => {
      const lower = await accepted(validObjectRow(`${value}-Cafe\u0301`));
      const upper = await accepted(validObjectRow(`${value.toUpperCase()}-CAFÉ`));
      assert.equal(lower.canonicalPrimaryKey, upper.canonicalPrimaryKey);
    }),
    propertyParameters,
  );
});

void test("property: concat framing preserves both source boundaries", async () => {
  await fc.assert(
    fc.asyncProperty(safeText, safeText, safeText, async (left, middle, right) => {
      const first = [...validObjectRow()];
      first[1] = left + middle;
      first[2] = right;
      const second = [...validObjectRow()];
      second[1] = left;
      second[2] = middle + right;
      const firstName = propertyValues(await accepted(first)).displayName;
      const secondName = propertyValues(await accepted(second)).displayName;
      assert.equal(firstName, `${left}${middle} ${right}`);
      assert.equal(secondName, `${left} ${middle}${right}`);
      assert.notEqual(firstName, secondName);
    }),
    propertyParameters,
  );
});

void test("property: optional blank CSV cells remain explicit nulls", async () => {
  await fc.assert(
    fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), async (amount, payload, tags) => {
      const row = [...validObjectRow()];
      if (amount) row[3] = "";
      if (payload) row[8] = "";
      if (tags) row[10] = "";
      const values = propertyValues(await accepted(row));
      assert.equal(values.amount, amount ? null : "123.40");
      assert.deepEqual(
        values.payload,
        payload ? null : { kind: "canonical_json", canonicalJson: '{"a":1.5,"b":2}' },
      );
      assert.deepEqual(values.tags, tags ? null : ["alpha", "界"]);
    }),
    propertyParameters,
  );
});

void test("property: Primary Key framing enforces the exact 1,024-byte boundary", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1_000, max: 1_020 }), async (inputBytes) => {
      const result = await mapOne(validObjectRow("a".repeat(inputBytes)));
      const acceptedAtBoundary = inputBytes <= 1_012;
      assert.equal(result.kind === "object", acceptedAtBoundary);
      if (result.kind === "object") {
        assert.equal(Buffer.byteLength(result.canonicalPrimaryKey), inputBytes + 12);
      } else {
        assert.equal(result.kind, "rejected");
        if (result.kind !== "rejected") throw new Error("Object Mapping cannot emit a Link row.");
        assert.equal(result.errors[0]?.codecCode, "PRIMARY_KEY_TOO_LARGE");
      }
    }),
    propertyParameters,
  );
});

async function accepted(values: readonly string[]): Promise<MappingAcceptedObjectRow> {
  const result = await mapOne(values);
  assert.equal(result.kind, "object");
  if (result.kind !== "object") throw new Error("Expected an accepted Object Mapping row.");
  return result;
}

async function mapOne(values: readonly string[]): Promise<MappingRowEvent> {
  let result: MappingRowEvent | undefined;
  const execution = createMappingExecution({
    plan: compileObjectFixture(),
    sourceContentDigest,
    digestCanonicalText,
    sink: {
      write(event) {
        result = event;
      },
    },
  });
  await execution.consumeRow({ rowNumber: 1, values });
  execution.finish();
  if (result === undefined) throw new Error("Expected one Mapping row event.");
  return result;
}

function propertyValues(event: MappingAcceptedObjectRow): Record<string, unknown> {
  return Object.fromEntries(
    event.properties.map(({ propertyApiName, value }) => [propertyApiName, value]),
  );
}

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
