import { fail } from "./error.ts";
import { canonicalizeScalarValue, type ScalarValueDescriptor } from "./property.ts";
import { canonicalizeUuid } from "./scalars.ts";
import { requireString, utf8ByteLength } from "./text.ts";

declare const canonicalPrimaryKeyBrand: unique symbol;

export type CanonicalPrimaryKey = string & { readonly [canonicalPrimaryKeyBrand]: true };

export interface PrimaryKeyStringDescriptor {
  readonly type: "string";
  readonly caseSensitive: boolean;
}

export interface PrimaryKeyUuidDescriptor {
  readonly type: "uuid";
}

export type PrimaryKeyComponentDescriptor =
  | PrimaryKeyStringDescriptor
  | PrimaryKeyUuidDescriptor
  | Exclude<ScalarValueDescriptor, { readonly type: "string" }>;

export interface PrimaryKeyDefinition {
  readonly components: readonly PrimaryKeyComponentDescriptor[];
  readonly maximumBytes?: number;
}

export interface PrimaryKeyCandidate {
  readonly candidateId: string;
  readonly values: readonly unknown[];
}

export interface CanonicalPrimaryKeyCandidate {
  readonly candidateId: string;
  readonly canonicalPrimaryKey: CanonicalPrimaryKey;
}

export const DEFAULT_PRIMARY_KEY_MAX_BYTES = 1_024;
export const PRIMARY_KEY_CODEC_VERSION = "pk1";

const componentTags: Readonly<Record<PrimaryKeyComponentDescriptor["type"], string>> = {
  boolean: "b",
  date: "d",
  decimal: "n",
  enum: "e",
  integer: "i",
  string: "s",
  timestamp: "t",
  uuid: "u",
};

export function canonicalizePrimaryKey(
  values: readonly unknown[],
  definition: PrimaryKeyDefinition,
): CanonicalPrimaryKey {
  const maximumBytes = definition.maximumBytes ?? DEFAULT_PRIMARY_KEY_MAX_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    fail("PRIMARY_KEY_INVALID", "Primary Key byte limit must be a positive safe integer.");
  }
  if (definition.components.length === 0) {
    fail("PRIMARY_KEY_INVALID", "Primary Key must declare at least one component.");
  }
  if (values.length !== definition.components.length) {
    fail(
      "PRIMARY_KEY_INVALID",
      `Primary Key expects ${definition.components.length} components but received ${values.length}.`,
    );
  }

  const encodedComponents = definition.components.map((descriptor, index) => {
    if (typeof values[index] === "string" && utf8ByteLength(values[index]) > maximumBytes) {
      fail(
        "PRIMARY_KEY_TOO_LARGE",
        `Primary Key component ${index} exceeds the ${maximumBytes}-byte total limit.`,
        `$key[${index}]`,
      );
    }
    const value = canonicalizePrimaryKeyComponent(values[index], descriptor, index);
    const tag = componentTags[descriptor.type];
    return `${tag}${utf8ByteLength(value)}#${value}`;
  });
  const canonical = `${PRIMARY_KEY_CODEC_VERSION}|${definition.components.length}|${encodedComponents.join("")}`;
  const actualBytes = utf8ByteLength(canonical);
  if (actualBytes > maximumBytes) {
    fail(
      "PRIMARY_KEY_TOO_LARGE",
      `Canonical Primary Key is ${actualBytes} UTF-8 bytes; maximum is ${maximumBytes}.`,
    );
  }
  return canonical as CanonicalPrimaryKey;
}

export function canonicalizeDistinctPrimaryKeys(
  candidates: readonly PrimaryKeyCandidate[],
  definition: PrimaryKeyDefinition,
): readonly CanonicalPrimaryKeyCandidate[] {
  const seen = new Map<CanonicalPrimaryKey, string>();
  return candidates.map((candidate) => {
    const canonicalPrimaryKey = canonicalizePrimaryKey(candidate.values, definition);
    const existingCandidate = seen.get(canonicalPrimaryKey);
    if (existingCandidate !== undefined) {
      fail(
        "PRIMARY_KEY_COLLISION",
        `Primary Key candidates ${JSON.stringify(existingCandidate)} and ${JSON.stringify(
          candidate.candidateId,
        )} normalize to the same identity.`,
      );
    }
    seen.set(canonicalPrimaryKey, candidate.candidateId);
    return { candidateId: candidate.candidateId, canonicalPrimaryKey };
  });
}

export function normalizePrimaryKeyString(input: unknown, caseSensitive: boolean): string {
  const value = requireString(input);
  if (value.length === 0) {
    fail("PRIMARY_KEY_INVALID", "Primary Key string component cannot be empty.");
  }
  const normalized = value.normalize("NFC");
  return caseSensitive ? normalized : normalized.toUpperCase().normalize("NFC");
}

function canonicalizePrimaryKeyComponent(
  input: unknown,
  descriptor: PrimaryKeyComponentDescriptor,
  index: number,
): string {
  if (input === null || input === undefined) {
    fail(
      "PRIMARY_KEY_INVALID",
      "Primary Key components cannot be null or missing.",
      `$key[${index}]`,
    );
  }
  if (descriptor.type === "string") {
    return normalizePrimaryKeyString(input, descriptor.caseSensitive);
  }
  if (descriptor.type === "uuid") return canonicalizeUuid(input);
  const value = canonicalizeScalarValue(input, descriptor);
  return typeof value === "boolean" ? String(value) : value;
}
