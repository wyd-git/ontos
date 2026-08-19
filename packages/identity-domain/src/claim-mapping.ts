import { canonicalizeContractForDigest } from "@ontos/contracts";

export const CLAIM_MAPPING_LIMITS = Object.freeze({
  maximumAttributes: 32,
  maximumClaimNameBytes: 128,
  maximumAttributeNameBytes: 63,
  maximumStringValueBytes: 256,
  maximumArrayValues: 32,
  maximumMappedValues: 128,
  maximumMappedCanonicalBytes: 16 * 1024,
});

export const CLAIM_VALUE_TYPES = Object.freeze(["boolean", "string", "string_array"] as const);

export type ClaimValueType = (typeof CLAIM_VALUE_TYPES)[number];

export interface ClaimMappingEntry {
  readonly claim: string;
  readonly attribute: string;
  readonly valueType: ClaimValueType;
  readonly required: boolean;
}

export interface ClaimMappingDefinition {
  readonly schemaVersion: 1;
  readonly attributes: readonly ClaimMappingEntry[];
}

export type MappedAttributeValue = boolean | string | readonly string[];

export interface MappedActorAttribute {
  readonly name: string;
  readonly value: MappedAttributeValue;
}

export interface TrustedClaimReader {
  readClaim(name: string): unknown;
}

export type IdentityDomainErrorCode =
  "CLAIM_MAPPING_INVALID" | "CLAIM_VALUE_INVALID" | "PERMISSION_INTERSECTION_INVALID";

export class IdentityDomainError extends Error {
  readonly code: IdentityDomainErrorCode;

  constructor(code: IdentityDomainErrorCode, message: string) {
    super(message);
    this.name = "IdentityDomainError";
    this.code = code;
  }
}

const claimNamePattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const attributeNamePattern = /^[a-z][a-z0-9_]{0,62}$/u;
const valueTypes: ReadonlySet<string> = new Set(CLAIM_VALUE_TYPES);
const protocolClaims: ReadonlySet<string> = new Set([
  "act",
  "aud",
  "azp",
  "client_id",
  "cnf",
  "exp",
  "iat",
  "iss",
  "jti",
  "nbf",
  "ontos_capabilities",
  "scope",
  "sub",
]);
const textEncoder = new TextEncoder();

export function parseClaimMappingDefinition(value: unknown): ClaimMappingDefinition {
  const record = requireRecord(value, "Claim Mapping");
  requireExactFields(record, ["schemaVersion", "attributes"], "Claim Mapping");
  if (record["schemaVersion"] !== 1 || !Array.isArray(record["attributes"])) {
    throw mappingError("Claim Mapping must use schemaVersion 1 and an attributes array.");
  }
  if (
    record["attributes"].length === 0 ||
    record["attributes"].length > CLAIM_MAPPING_LIMITS.maximumAttributes
  ) {
    throw mappingError("Claim Mapping attribute count is outside the supported envelope.");
  }

  const seenClaims = new Set<string>();
  const seenAttributes = new Set<string>();
  const attributes = record["attributes"].map((candidate, index) => {
    const entry = requireRecord(candidate, `Claim Mapping attribute ${String(index)}`);
    requireExactFields(
      entry,
      ["claim", "attribute", "valueType", "required"],
      `Claim Mapping attribute ${String(index)}`,
    );
    const claim = entry["claim"];
    const attribute = entry["attribute"];
    const valueType = entry["valueType"];
    const required = entry["required"];
    if (
      typeof claim !== "string" ||
      !claimNamePattern.test(claim) ||
      byteLength(claim) > CLAIM_MAPPING_LIMITS.maximumClaimNameBytes ||
      protocolClaims.has(claim)
    ) {
      throw mappingError(`Claim Mapping attribute ${String(index)} has an invalid claim name.`);
    }
    if (
      typeof attribute !== "string" ||
      !attributeNamePattern.test(attribute) ||
      byteLength(attribute) > CLAIM_MAPPING_LIMITS.maximumAttributeNameBytes
    ) {
      throw mappingError(`Claim Mapping attribute ${String(index)} has an invalid attribute name.`);
    }
    if (typeof valueType !== "string" || !valueTypes.has(valueType)) {
      throw mappingError(`Claim Mapping attribute ${String(index)} has an invalid value type.`);
    }
    if (typeof required !== "boolean") {
      throw mappingError(`Claim Mapping attribute ${String(index)} must declare required.`);
    }
    if (seenClaims.has(claim) || seenAttributes.has(attribute)) {
      throw mappingError("Claim Mapping claim and attribute names must be unique.");
    }
    seenClaims.add(claim);
    seenAttributes.add(attribute);
    return Object.freeze({
      claim,
      attribute,
      valueType: valueType as ClaimValueType,
      required,
    });
  });

  attributes.sort((left, right) => left.attribute.localeCompare(right.attribute, "en"));
  return Object.freeze({ schemaVersion: 1, attributes: Object.freeze(attributes) });
}

export function canonicalClaimMapping(definition: ClaimMappingDefinition): string {
  return canonicalizeContractForDigest(definition);
}

export function mapTrustedClaims(
  definition: ClaimMappingDefinition,
  reader: TrustedClaimReader,
): readonly MappedActorAttribute[] {
  const mapped: MappedActorAttribute[] = [];
  let mappedValueCount = 0;

  for (const entry of definition.attributes) {
    const raw = reader.readClaim(entry.claim);
    if (raw === undefined || raw === null) {
      if (entry.required) throw claimValueError(entry.attribute);
      continue;
    }
    const value = parseMappedValue(raw, entry.valueType, entry.attribute);
    mappedValueCount += Array.isArray(value) ? value.length : 1;
    if (mappedValueCount > CLAIM_MAPPING_LIMITS.maximumMappedValues) {
      throw claimValueError(entry.attribute);
    }
    mapped.push(Object.freeze({ name: entry.attribute, value }));
  }

  const canonical = canonicalizeContractForDigest(mapped);
  if (byteLength(canonical) > CLAIM_MAPPING_LIMITS.maximumMappedCanonicalBytes) {
    throw new IdentityDomainError(
      "CLAIM_VALUE_INVALID",
      "Mapped claims exceed the supported canonical byte envelope.",
    );
  }
  return Object.freeze(mapped);
}

function parseMappedValue(
  raw: unknown,
  valueType: ClaimValueType,
  attribute: string,
): MappedAttributeValue {
  if (valueType === "boolean") {
    if (typeof raw !== "boolean") throw claimValueError(attribute);
    return raw;
  }
  if (valueType === "string") return boundedString(raw, attribute);
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > CLAIM_MAPPING_LIMITS.maximumArrayValues
  ) {
    throw claimValueError(attribute);
  }
  const values = raw.map((item) => boundedString(item, attribute));
  if (new Set(values).size !== values.length) throw claimValueError(attribute);
  values.sort((left, right) => left.localeCompare(right, "en"));
  return Object.freeze(values);
}

function boundedString(value: unknown, attribute: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    byteLength(value) > CLAIM_MAPPING_LIMITS.maximumStringValueBytes
  ) {
    throw claimValueError(attribute);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw mappingError(`${label} must be an object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw mappingError(`${label} must be a plain object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireExactFields(
  record: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw mappingError(`${label} has unsupported or missing fields.`);
  }
}

function mappingError(message: string): IdentityDomainError {
  return new IdentityDomainError("CLAIM_MAPPING_INVALID", message);
}

function claimValueError(attribute: string): IdentityDomainError {
  return new IdentityDomainError(
    "CLAIM_VALUE_INVALID",
    `Mapped attribute ${attribute} does not match the published Claim Mapping.`,
  );
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}
