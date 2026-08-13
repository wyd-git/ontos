import { fail } from "./error.ts";
import {
  canonicalizeRestrictedJson,
  parseCanonicalJson,
  type JsonValue,
  type RestrictedJsonOptions,
} from "./json.ts";
import {
  canonicalizeDate,
  canonicalizeDecimal,
  canonicalizeInteger,
  canonicalizeTimestamp,
  compareCanonicalDecimals,
  compareCanonicalIntegers,
  compareCanonicalTimestamps,
  type DecimalFormat,
} from "./scalars.ts";
import {
  DEFAULT_STRING_MAX_BYTES,
  assertUtf8ByteLimit,
  compareUtf8,
  requireString,
} from "./text.ts";

export interface BooleanDescriptor {
  readonly type: "boolean";
}

export interface IntegerDescriptor {
  readonly type: "integer";
}

export interface DecimalDescriptor extends DecimalFormat {
  readonly type: "decimal";
}

export interface DateDescriptor {
  readonly type: "date";
}

export interface TimestampDescriptor {
  readonly type: "timestamp";
}

export interface EnumDescriptor {
  readonly type: "enum";
  readonly values: readonly string[];
}

export interface StringDescriptor {
  readonly type: "string";
  readonly maximumBytes?: number;
}

export type ScalarValueDescriptor =
  | BooleanDescriptor
  | IntegerDescriptor
  | DecimalDescriptor
  | DateDescriptor
  | TimestampDescriptor
  | EnumDescriptor
  | StringDescriptor;

export interface StringArrayDescriptor {
  readonly type: "string[]";
  readonly maximumItems?: number;
  readonly itemMaximumBytes?: number;
}

export interface JsonDescriptor extends RestrictedJsonOptions {
  readonly type: "json";
}

export type PropertyDescriptor = (
  ScalarValueDescriptor | StringArrayDescriptor | JsonDescriptor
) & {
  readonly nullable?: boolean;
};

export type CanonicalScalarValue = boolean | string;
export type CanonicalPropertyValue = null | CanonicalScalarValue | readonly string[] | JsonValue;

export const DEFAULT_STRING_ARRAY_MAXIMUM_ITEMS = 1_000;

export function canonicalizeScalarValue(
  input: unknown,
  descriptor: ScalarValueDescriptor,
): CanonicalScalarValue {
  switch (descriptor.type) {
    case "boolean":
      if (typeof input !== "boolean") {
        fail("VALUE_TYPE_MISMATCH", "Boolean value must use a JSON boolean.");
      }
      return input;
    case "integer":
      return canonicalizeInteger(input);
    case "decimal":
      return canonicalizeDecimal(input, descriptor);
    case "date":
      return canonicalizeDate(input);
    case "timestamp":
      return canonicalizeTimestamp(input);
    case "enum":
      return canonicalizeEnum(input, descriptor.values);
    case "string": {
      const value = requireString(input);
      assertUtf8ByteLimit(value, descriptor.maximumBytes ?? DEFAULT_STRING_MAX_BYTES);
      return value;
    }
  }
}

export function canonicalizePropertyValue(
  input: unknown,
  descriptor: PropertyDescriptor,
): CanonicalPropertyValue {
  if (input === null) {
    if (descriptor.nullable === true) return null;
    fail("VALUE_TYPE_MISMATCH", "Property is not nullable.");
  }

  if (descriptor.type === "string[]") {
    return canonicalizeStringArray(input, descriptor);
  }
  if (descriptor.type === "json") {
    return parseCanonicalJson(canonicalizeRestrictedJson(input, descriptor));
  }
  return canonicalizeScalarValue(input, descriptor);
}

export function canonicalizeStringArray(
  input: unknown,
  descriptor: StringArrayDescriptor = { type: "string[]" },
): readonly string[] {
  if (!Array.isArray(input)) {
    fail("VALUE_TYPE_MISMATCH", "String array value must use a JSON array.");
  }
  const maximumItems = descriptor.maximumItems ?? DEFAULT_STRING_ARRAY_MAXIMUM_ITEMS;
  if (!Number.isSafeInteger(maximumItems) || maximumItems < 0) {
    fail("STRING_ARRAY_TOO_LARGE", "String array item limit must be non-negative.");
  }
  if (input.length > maximumItems) {
    fail(
      "STRING_ARRAY_TOO_LARGE",
      `String array has ${input.length} items; maximum is ${maximumItems}.`,
    );
  }
  const maximumBytes = descriptor.itemMaximumBytes ?? DEFAULT_STRING_MAX_BYTES;
  return input.map((item, index) => {
    const value = requireString(item, `$value[${index}]`);
    assertUtf8ByteLimit(value, maximumBytes, `$value[${index}]`);
    return value;
  });
}

export function canonicalizeEnum(input: unknown, values: readonly string[]): string {
  const value = requireString(input);
  validateEnumValues(values);
  if (!values.includes(value)) {
    fail("ENUM_VALUE_INVALID", "Enum value is not present in the immutable code list.");
  }
  return value;
}

export function compareScalarValues(
  leftInput: unknown,
  rightInput: unknown,
  descriptor: ScalarValueDescriptor,
): number {
  const left = canonicalizeScalarValue(leftInput, descriptor);
  const right = canonicalizeScalarValue(rightInput, descriptor);
  switch (descriptor.type) {
    case "boolean":
      return Number(left) - Number(right);
    case "integer":
      return compareCanonicalIntegers(
        left as ReturnType<typeof canonicalizeInteger>,
        right as ReturnType<typeof canonicalizeInteger>,
      );
    case "decimal":
      return compareCanonicalDecimals(
        left as ReturnType<typeof canonicalizeDecimal>,
        right as ReturnType<typeof canonicalizeDecimal>,
      );
    case "date":
      return left < right ? -1 : left > right ? 1 : 0;
    case "timestamp":
      return compareCanonicalTimestamps(
        left as ReturnType<typeof canonicalizeTimestamp>,
        right as ReturnType<typeof canonicalizeTimestamp>,
      );
    case "enum":
      return Math.sign(
        descriptor.values.indexOf(left as string) - descriptor.values.indexOf(right as string),
      );
    case "string":
      return compareUtf8(left as string, right as string);
  }
}

function validateEnumValues(values: readonly string[]): void {
  const seen = new Set<string>();
  for (const [index, candidate] of values.entries()) {
    const value = requireString(candidate, `$enum[${index}]`);
    if (seen.has(value)) {
      fail("ENUM_SCHEMA_INVALID", "Enum codes must be unique and ordered.", `$enum[${index}]`);
    }
    seen.add(value);
  }
}
