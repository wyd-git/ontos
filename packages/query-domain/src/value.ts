import {
  canonicalizePrimaryKey,
  canonicalizePropertyValue,
  type CanonicalPropertyValue,
  type PrimaryKeyComponentDescriptor,
} from "@ontos/value-codec";

import { failQuery } from "./error.ts";
import type {
  QueryCanonicalParameter,
  QueryCanonicalScalar,
  QueryOperandValueType,
  QueryParameterOperand,
} from "./model.ts";
import type { QueryObjectTypeSchema, QueryPropertySchema } from "./schema-registry.ts";

export function queryOperandValueType(property: QueryPropertySchema): QueryOperandValueType {
  return property.valueType === "string[]" ? "string_array" : property.valueType;
}

export function canonicalizeClientParameter(
  property: QueryPropertySchema,
  input: unknown,
): QueryParameterOperand {
  return parameterFromProperty(property, input, false);
}

export function canonicalizeTrustedPolicyParameter(
  property: QueryPropertySchema,
  input: unknown,
): QueryParameterOperand {
  return parameterFromProperty(property, normalizeTrustedLegacyNumber(property, input), false);
}

export function canonicalizeClientCollectionParameter(
  property: QueryPropertySchema,
  input: readonly unknown[],
): QueryParameterOperand {
  if (property.valueType === "string[]" || property.valueType === "json") {
    failQuery("INVALID_QUERY_AST", "This Property does not accept an IN collection.");
  }
  const values = input.map((value) => canonicalizeScalar(property, value));
  return Object.freeze({
    kind: "parameter",
    valueType: queryOperandValueType(property),
    collection: true,
    value: Object.freeze(values),
  });
}

export function canonicalizeTrustedPolicyCollectionParameter(
  property: QueryPropertySchema,
  input: readonly unknown[],
): QueryParameterOperand {
  if (property.valueType === "string[]" || property.valueType === "json") {
    failQuery("POLICY_EVALUATION_UNAVAILABLE", "Policy IN collection type is invalid.");
  }
  const values = input.map((value) =>
    canonicalizeScalar(property, normalizeTrustedLegacyNumber(property, value)),
  );
  return Object.freeze({
    kind: "parameter",
    valueType: queryOperandValueType(property),
    collection: true,
    value: Object.freeze(values),
  });
}

export function canonicalizeStringArrayParameter(
  property: QueryPropertySchema,
  input: unknown,
): QueryParameterOperand {
  if (property.valueType !== "string[]") {
    failQuery("INVALID_QUERY_AST", "containsAny requires a string-array Property.");
  }
  const value = canonicalizeNonNull(property, input, true);
  if (!Array.isArray(value)) {
    failQuery("INVALID_QUERY_AST", "containsAny requires a string array.");
  }
  const values = value.map((item: unknown) => {
    if (typeof item !== "string") {
      failQuery("INVALID_QUERY_AST", "containsAny contains a non-string value.");
    }
    return item;
  });
  return Object.freeze({
    kind: "parameter",
    valueType: "string_array",
    collection: true,
    value: Object.freeze(values),
  });
}

export function canonicalizeActorParameter(input: unknown): QueryParameterOperand {
  if (typeof input === "boolean") {
    return Object.freeze({
      kind: "parameter",
      valueType: "boolean",
      collection: false,
      value: input,
    });
  }
  if (typeof input === "string") {
    return Object.freeze({
      kind: "parameter",
      valueType: "string",
      collection: false,
      value: input,
    });
  }
  if (Array.isArray(input) && input.length > 0) {
    const values = input.map((value: unknown) => {
      if (typeof value !== "string") {
        failQuery("POLICY_EVALUATION_UNAVAILABLE", "Actor Attribute array is invalid.");
      }
      return value;
    });
    return Object.freeze({
      kind: "parameter",
      valueType: "string_array",
      collection: true,
      value: Object.freeze(values),
    });
  }
  failQuery("POLICY_EVALUATION_UNAVAILABLE", "Trusted Actor Attribute value is invalid.");
}

export function canonicalizeRequestTimeParameter(input: string): QueryParameterOperand {
  const property = syntheticTimestampProperty();
  return parameterFromProperty(property, input, false);
}

export function canonicalizePrimaryKeyInput(object: QueryObjectTypeSchema, input: unknown): string {
  const property = object.properties.find(
    (candidate) => candidate.apiName === object.primaryKeyPropertyApiName,
  );
  if (property === undefined) {
    failQuery("QUERY_SCHEMA_INVALID", "Primary Key Property is missing from the Object Type.");
  }
  if (property.valueType === "string[]" || property.valueType === "json") {
    failQuery("QUERY_SCHEMA_INVALID", "Primary Key Property must be scalar.");
  }
  const descriptor = primaryKeyDescriptor(property);
  try {
    return canonicalizePrimaryKey([input], { components: [descriptor] });
  } catch (error) {
    failQuery("INVALID_QUERY_AST", "Primary Key value is invalid.", { cause: error });
  }
}

function canonicalizeScalar(property: QueryPropertySchema, input: unknown): QueryCanonicalScalar {
  const value = canonicalizeNonNull(property, input, false);
  if (typeof value !== "boolean" && typeof value !== "string") {
    failQuery("INVALID_QUERY_AST", "Query scalar did not normalize to a public scalar value.");
  }
  return value;
}

function primaryKeyDescriptor(property: QueryPropertySchema): PrimaryKeyComponentDescriptor {
  switch (property.valueType) {
    case "string":
      return Object.freeze({ type: "string", caseSensitive: property.caseSensitive });
    case "boolean":
      return Object.freeze({ type: "boolean" });
    case "integer":
      return Object.freeze({ type: "integer" });
    case "decimal":
      if (property.decimalPrecision === null || property.decimalScale === null) {
        failQuery("QUERY_SCHEMA_INVALID", "Primary Key Decimal format is unavailable.");
      }
      return Object.freeze({
        type: "decimal",
        precision: property.decimalPrecision,
        scale: property.decimalScale,
      });
    case "date":
      return Object.freeze({ type: "date" });
    case "timestamp":
      return Object.freeze({ type: "timestamp" });
    case "enum":
      if (property.enumValues === null) {
        failQuery("QUERY_SCHEMA_INVALID", "Primary Key Enum codes are unavailable.");
      }
      return Object.freeze({ type: "enum", values: property.enumValues });
    case "string[]":
    case "json":
      failQuery("QUERY_SCHEMA_INVALID", "Primary Key Property must be scalar.");
  }
}

function parameterFromProperty(
  property: QueryPropertySchema,
  input: unknown,
  collection: boolean,
): QueryParameterOperand {
  const value = canonicalizeNonNull(property, input, true);
  return Object.freeze({
    kind: "parameter",
    valueType: queryOperandValueType(property),
    collection,
    value: value as QueryCanonicalParameter,
  });
}

function canonicalizeNonNull(
  property: QueryPropertySchema,
  input: unknown,
  allowStringArray: boolean,
): Exclude<CanonicalPropertyValue, null> {
  if (input === null) {
    failQuery("INVALID_QUERY_AST", "Query values cannot be null; use isNull.");
  }
  if (property.valueType === "json") {
    failQuery("PROPERTY_NOT_QUERYABLE", "Whole-JSON comparison is not supported.");
  }
  if (property.valueType === "string[]" && !allowStringArray) {
    failQuery("INVALID_QUERY_AST", "String-array value is not valid for this operator.");
  }
  try {
    const value = canonicalizePropertyValue(input, property.descriptor);
    if (value === null) {
      failQuery("INVALID_QUERY_AST", "Query values cannot be null; use isNull.");
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.name === "QueryDomainError") throw error;
    failQuery("INVALID_QUERY_AST", "Query value does not match the Property type.", {
      cause: error,
    });
  }
}

function normalizeTrustedLegacyNumber(property: QueryPropertySchema, input: unknown): unknown {
  if (
    typeof input === "number" &&
    (property.valueType === "integer" || property.valueType === "decimal")
  ) {
    if (!Number.isSafeInteger(input) || Object.is(input, -0)) {
      failQuery(
        "POLICY_EVALUATION_UNAVAILABLE",
        "Policy numeric value is not losslessly representable by the public Value Codec.",
      );
    }
    return String(input);
  }
  return input;
}

function syntheticTimestampProperty(): QueryPropertySchema {
  return Object.freeze({
    apiName: "request_time",
    displayName: "Request time",
    valueType: "timestamp",
    nullable: false,
    caseSensitive: true,
    filterable: true,
    sortable: false,
    searchable: false,
    enumValues: null,
    decimalPrecision: null,
    decimalScale: null,
    descriptor: Object.freeze({ type: "timestamp", nullable: false }),
  });
}
