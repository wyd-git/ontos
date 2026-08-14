import {
  ARTIFACT_DIGEST_LENGTH,
  ARTIFACT_DIGEST_PATTERN,
  CANONICAL_INSTANT_LENGTH,
  CANONICAL_INSTANT_PATTERN,
  CORRELATION_CONTEXT_FIELDS,
  CORRELATION_CONTEXT_REQUIRED_FIELDS,
  CORRELATION_ID_MAXIMUM_LENGTH,
  CORRELATION_ID_MINIMUM_LENGTH,
  CORRELATION_ID_PATTERN,
  DELEGATION_CHAIN_MAXIMUM_ITEMS,
  ERROR_CATEGORY_VALUES,
  ERROR_CODE_MAXIMUM_LENGTH,
  ERROR_CODE_MINIMUM_LENGTH,
  ERROR_CODE_PATTERN,
  ERROR_ENVELOPE_FIELDS,
  ERROR_MESSAGE_MAXIMUM_LENGTH,
  ERROR_MESSAGE_PATTERN,
  ERROR_RECORD_FIELDS,
  FOUNDATION_SCHEMA_VERSION,
  IDEMPOTENCY_KEY_MAXIMUM_LENGTH,
  IDEMPOTENCY_KEY_MINIMUM_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  IDENTITY_DELEGATION_SUMMARY_FIELDS,
  IDENTITY_TYPE_VALUES,
  ONTOS_ID_LENGTH,
  ONTOS_ID_PATTERN,
  PRINCIPAL_SUMMARY_FIELDS,
  RELEASE_BINDING_FIELDS,
} from "../../packages/contracts/src/index.ts";

export function assertRuntimeSchemaAgreement(schemaValue: unknown): void {
  const schema = requireRecord(schemaValue, "$schema");
  const definitions = requireRecord(schema.$defs, "$schema.$defs");

  assertKeywords(definitions, "SchemaVersion", {
    type: "integer",
    const: FOUNDATION_SCHEMA_VERSION,
  });
  assertKeywords(definitions, "OntosId", {
    type: "string",
    minLength: ONTOS_ID_LENGTH,
    maxLength: ONTOS_ID_LENGTH,
    pattern: ONTOS_ID_PATTERN,
  });
  assertKeywords(definitions, "CorrelationId", {
    type: "string",
    minLength: CORRELATION_ID_MINIMUM_LENGTH,
    maxLength: CORRELATION_ID_MAXIMUM_LENGTH,
    pattern: CORRELATION_ID_PATTERN,
  });
  assertKeywords(definitions, "ArtifactDigest", {
    type: "string",
    minLength: ARTIFACT_DIGEST_LENGTH,
    maxLength: ARTIFACT_DIGEST_LENGTH,
    pattern: ARTIFACT_DIGEST_PATTERN,
  });
  assertKeywords(definitions, "IdempotencyKey", {
    type: "string",
    minLength: IDEMPOTENCY_KEY_MINIMUM_LENGTH,
    maxLength: IDEMPOTENCY_KEY_MAXIMUM_LENGTH,
    pattern: IDEMPOTENCY_KEY_PATTERN,
  });
  assertKeywords(definitions, "CanonicalInstant", {
    type: "string",
    minLength: CANONICAL_INSTANT_LENGTH,
    maxLength: CANONICAL_INSTANT_LENGTH,
    pattern: CANONICAL_INSTANT_PATTERN,
    format: "ontos-canonical-instant",
  });

  assertObjectShape(
    definitions,
    "PrincipalSummary",
    PRINCIPAL_SUMMARY_FIELDS,
    PRINCIPAL_SUMMARY_FIELDS,
  );
  assertKeywords(property(definitions, "PrincipalSummary", "principalId"), "$property", {
    $ref: "#/$defs/OntosId",
  });
  assertKeywords(property(definitions, "PrincipalSummary", "identityType"), "$property", {
    type: "string",
    enum: IDENTITY_TYPE_VALUES,
  });

  assertObjectShape(
    definitions,
    "CorrelationContext",
    CORRELATION_CONTEXT_FIELDS,
    CORRELATION_CONTEXT_REQUIRED_FIELDS,
  );
  assertKeywords(property(definitions, "CorrelationContext", "correlationId"), "$property", {
    $ref: "#/$defs/CorrelationId",
  });
  assertKeywords(property(definitions, "CorrelationContext", "parentCorrelationId"), "$property", {
    $ref: "#/$defs/CorrelationId",
  });
  assertPropertyReference(definitions, "CorrelationContext", "schemaVersion", "SchemaVersion");

  assertObjectShape(
    definitions,
    "IdentityDelegationSummary",
    IDENTITY_DELEGATION_SUMMARY_FIELDS,
    IDENTITY_DELEGATION_SUMMARY_FIELDS,
  );
  const chain = property(definitions, "IdentityDelegationSummary", "delegationChain");
  assertKeywords(chain, "$property", {
    type: "array",
    maxItems: DELEGATION_CHAIN_MAXIMUM_ITEMS,
    uniqueItems: true,
  });
  assertKeywords(requireRecord(chain.items, "$property.items"), "$property.items", {
    $ref: "#/$defs/PrincipalSummary",
  });
  assertKeywords(
    property(definitions, "IdentityDelegationSummary", "authorizationMode"),
    "$property",
    { type: "string", const: "intersection" },
  );
  assertPropertyReference(
    definitions,
    "IdentityDelegationSummary",
    "schemaVersion",
    "SchemaVersion",
  );
  assertPropertyReference(definitions, "IdentityDelegationSummary", "actor", "PrincipalSummary");
  assertPropertyReference(
    definitions,
    "IdentityDelegationSummary",
    "claimsFingerprint",
    "ArtifactDigest",
  );
  assertPropertyReference(
    definitions,
    "IdentityDelegationSummary",
    "authenticatedAt",
    "CanonicalInstant",
  );

  assertObjectShape(definitions, "ReleaseBinding", RELEASE_BINDING_FIELDS, RELEASE_BINDING_FIELDS);
  assertPropertyReference(definitions, "ReleaseBinding", "schemaVersion", "SchemaVersion");
  for (const field of ["projectId", "releaseId", "releaseRevisionId", "activationId"] as const) {
    assertPropertyReference(definitions, "ReleaseBinding", field, "OntosId");
  }
  assertPropertyReference(definitions, "ReleaseBinding", "manifestDigest", "ArtifactDigest");

  assertObjectShape(definitions, "ErrorRecord", ERROR_RECORD_FIELDS, ERROR_RECORD_FIELDS);
  assertKeywords(property(definitions, "ErrorRecord", "code"), "$property", {
    type: "string",
    minLength: ERROR_CODE_MINIMUM_LENGTH,
    maxLength: ERROR_CODE_MAXIMUM_LENGTH,
    pattern: ERROR_CODE_PATTERN,
  });
  assertKeywords(property(definitions, "ErrorRecord", "message"), "$property", {
    type: "string",
    minLength: 1,
    maxLength: ERROR_MESSAGE_MAXIMUM_LENGTH,
    pattern: ERROR_MESSAGE_PATTERN,
  });
  assertKeywords(property(definitions, "ErrorRecord", "category"), "$property", {
    type: "string",
    enum: ERROR_CATEGORY_VALUES,
  });
  assertKeywords(property(definitions, "ErrorRecord", "retryable"), "$property", {
    type: "boolean",
  });
  assertPropertyReference(definitions, "ErrorRecord", "details", "ErrorDetails");
  assertKeywords(property(definitions, "ErrorRecord", "correlationId"), "$property", {
    $ref: "#/$defs/CorrelationId",
  });
  assertObjectShape(definitions, "ErrorEnvelope", ERROR_ENVELOPE_FIELDS, ERROR_ENVELOPE_FIELDS);
  assertPropertyReference(definitions, "ErrorEnvelope", "schemaVersion", "SchemaVersion");
  assertPropertyReference(definitions, "ErrorEnvelope", "error", "ErrorRecord");
}

function assertPropertyReference(
  definitions: Readonly<Record<string, unknown>>,
  definitionName: string,
  propertyName: string,
  referencedDefinition: string,
): void {
  assertKeywords(property(definitions, definitionName, propertyName), "$property", {
    $ref: `#/$defs/${referencedDefinition}`,
  });
}

function assertObjectShape(
  definitions: Readonly<Record<string, unknown>>,
  name: string,
  fields: readonly string[],
  requiredFields: readonly string[],
): void {
  const definition = requireRecord(definitions[name], `$defs.${name}`);
  assertKeywords(definition, `$defs.${name}`, {
    type: "object",
    additionalProperties: false,
  });
  const properties = requireRecord(definition.properties, `$defs.${name}.properties`);
  assertStringSet(Object.keys(properties), fields, `$defs.${name}.properties`);
  assertStringSet(
    requireStringArray(definition.required, `$defs.${name}.required`),
    requiredFields,
    `$defs.${name}.required`,
  );
}

function property(
  definitions: Readonly<Record<string, unknown>>,
  definitionName: string,
  propertyName: string,
): Readonly<Record<string, unknown>> {
  const definition = requireRecord(definitions[definitionName], `$defs.${definitionName}`);
  const properties = requireRecord(definition.properties, `$defs.${definitionName}.properties`);
  return requireRecord(
    properties[propertyName],
    `$defs.${definitionName}.properties.${propertyName}`,
  );
}

function assertKeywords(
  container: Readonly<Record<string, unknown>>,
  name: string,
  expected: Readonly<Record<string, unknown>>,
): void {
  const target = Object.hasOwn(container, name)
    ? requireRecord(container[name], `$defs.${name}`)
    : container;
  for (const [keyword, value] of Object.entries(expected)) {
    if (stableJson(target[keyword]) !== stableJson(value)) {
      throw new Error(`${name}.${keyword} disagrees with the runtime parser.`);
    }
  }
}

function assertStringSet(
  actual: readonly string[],
  expected: readonly string[],
  path: string,
): void {
  const normalizedActual = [...actual].sort();
  const normalizedExpected = [...expected].sort();
  if (stableJson(normalizedActual) !== stableJson(normalizedExpected)) {
    throw new Error(`${path} disagrees with the runtime parser.`);
  }
}

function requireStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be a string array.`);
  }
  return value as string[];
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function requireRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}
