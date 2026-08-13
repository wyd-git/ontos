import { failContract } from "./error.ts";
import { requireString } from "./internal.ts";

declare const ontosIdBrand: unique symbol;
declare const correlationIdBrand: unique symbol;
declare const artifactDigestBrand: unique symbol;
declare const idempotencyKeyBrand: unique symbol;
declare const canonicalInstantBrand: unique symbol;

export type OntosId = string & { readonly [ontosIdBrand]: true };
export type CorrelationId = string & { readonly [correlationIdBrand]: true };
export type ArtifactDigest = string & { readonly [artifactDigestBrand]: true };
export type IdempotencyKey = string & { readonly [idempotencyKeyBrand]: true };
export type CanonicalInstant = string & { readonly [canonicalInstantBrand]: true };
export type ContractSchemaVersion = 1;

export const FOUNDATION_SCHEMA_VERSION: ContractSchemaVersion = 1;
export const ONTOS_ID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
export const CORRELATION_ID_PATTERN = "^corr_[A-Za-z0-9][A-Za-z0-9._~-]{15,122}$";
export const ARTIFACT_DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";
export const IDEMPOTENCY_KEY_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$";
export const CANONICAL_INSTANT_PATTERN =
  "^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{6}Z$";
export const ONTOS_ID_LENGTH = 36;
export const CORRELATION_ID_MINIMUM_LENGTH = 21;
export const CORRELATION_ID_MAXIMUM_LENGTH = 128;
export const ARTIFACT_DIGEST_LENGTH = 71;
export const IDEMPOTENCY_KEY_MINIMUM_LENGTH = 16;
export const IDEMPOTENCY_KEY_MAXIMUM_LENGTH = 128;
export const CANONICAL_INSTANT_LENGTH = 27;

const ontosIdRegex = new RegExp(ONTOS_ID_PATTERN, "u");
const correlationIdRegex = new RegExp(CORRELATION_ID_PATTERN, "u");
const artifactDigestRegex = new RegExp(ARTIFACT_DIGEST_PATTERN, "u");
const idempotencyKeyRegex = new RegExp(IDEMPOTENCY_KEY_PATTERN, "u");
const canonicalInstantRegex = new RegExp(CANONICAL_INSTANT_PATTERN, "u");

export function parseSchemaVersion(
  value: unknown,
  path = "$.schemaVersion",
): ContractSchemaVersion {
  if (value !== FOUNDATION_SCHEMA_VERSION) {
    failContract(
      "CONTRACT_SCHEMA_VERSION_UNSUPPORTED",
      "Foundation schemaVersion is unsupported.",
      path,
    );
  }
  return FOUNDATION_SCHEMA_VERSION;
}

export function parseOntosId(value: unknown, path = "$id"): OntosId {
  return requireString(value, path, {
    minimumLength: ONTOS_ID_LENGTH,
    maximumLength: ONTOS_ID_LENGTH,
    pattern: ontosIdRegex,
  }) as OntosId;
}

export function parseCorrelationId(value: unknown, path = "$correlationId"): CorrelationId {
  return requireString(value, path, {
    minimumLength: CORRELATION_ID_MINIMUM_LENGTH,
    maximumLength: CORRELATION_ID_MAXIMUM_LENGTH,
    pattern: correlationIdRegex,
  }) as CorrelationId;
}

export function parseArtifactDigest(value: unknown, path = "$digest"): ArtifactDigest {
  return requireString(value, path, {
    minimumLength: ARTIFACT_DIGEST_LENGTH,
    maximumLength: ARTIFACT_DIGEST_LENGTH,
    pattern: artifactDigestRegex,
  }) as ArtifactDigest;
}

export function parseIdempotencyKey(value: unknown, path = "$idempotencyKey"): IdempotencyKey {
  return requireString(value, path, {
    minimumLength: IDEMPOTENCY_KEY_MINIMUM_LENGTH,
    maximumLength: IDEMPOTENCY_KEY_MAXIMUM_LENGTH,
    pattern: idempotencyKeyRegex,
  }) as IdempotencyKey;
}

export function parseCanonicalInstant(value: unknown, path = "$instant"): CanonicalInstant {
  const instant = requireString(value, path, {
    minimumLength: CANONICAL_INSTANT_LENGTH,
    maximumLength: CANONICAL_INSTANT_LENGTH,
    pattern: canonicalInstantRegex,
  });
  const year = Number(instant.slice(0, 4));
  const month = Number(instant.slice(5, 7));
  const day = Number(instant.slice(8, 10));
  if (year < 1 || day > daysInMonth(year, month)) {
    failContract("CONTRACT_FORMAT_INVALID", "Instant is not a Gregorian date.", path);
  }
  return instant as CanonicalInstant;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return new Set([4, 6, 9, 11]).has(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
