import {
  API_NAME_PATTERN,
  ARTIFACT_DIGEST_LENGTH,
  ARTIFACT_DIGEST_PATTERN,
  CANONICAL_INSTANT_LENGTH,
  CANONICAL_INSTANT_PATTERN,
  CLASSIFICATION_VALUES,
  COMPATIBILITY_FINDING_FIELDS,
  COMPATIBILITY_REPORT_FIELDS,
  FOUNDATION_SCHEMA_VERSION,
  JSON_POINTER_PATTERN,
  LINK_CARDINALITY_VALUES,
  LINK_ENDPOINT_FIELDS,
  LINK_TYPE_DEFINITION_FIELDS,
  MANAGEMENT_ROLE_BINDING_FIELDS,
  MANAGEMENT_ROLE_BINDING_REQUIRED_FIELDS,
  MANAGEMENT_ROLE_VALUES,
  NAMESPACE_PATTERN,
  OBJECT_SORT_DEFINITION_FIELDS,
  OBJECT_TYPE_DEFINITION_FIELDS,
  ONTOS_ID_LENGTH,
  ONTOS_ID_PATTERN,
  PACKAGE_INSTALL_INPUT_FIELDS,
  PACKAGE_MANIFEST_FIELDS,
  PACKAGE_RESOURCE_ENTRY_FIELDS,
  PROJECT_FIELDS,
  PROPERTY_DEFINITION_FIELDS,
  PROPERTY_DEFINITION_REQUIRED_FIELDS,
  PROPERTY_VALUE_TYPE_VALUES,
  PROPERTY_WRITE_MODE_VALUES,
  RELEASE_MANIFEST_FIELDS,
  RELEASE_PIN_FIELDS,
  RESOURCE_DEPENDENCY_FIELDS,
  RESOURCE_ENVELOPE_FIELDS,
  RESOURCE_FAMILY_VALUES,
  RESOURCE_REVISION_FIELDS,
  RESOURCE_REVISION_REQUIRED_FIELDS,
  SEMANTIC_VERSION_PATTERN,
  VALIDATION_ISSUE_FIELDS,
  VALIDATION_REPORT_FIELDS,
} from "../../packages/contracts/src/index.ts";

export function assertMetadataRuntimeSchemaAgreement(schemaValue: unknown): void {
  const schema = requireRecord(schemaValue, "$schema");
  const definitions = requireRecord(schema.$defs, "$schema.$defs");

  assertDefinition(definitions, "MetadataSchemaVersion", {
    type: "integer",
    const: FOUNDATION_SCHEMA_VERSION,
  });
  assertDefinition(definitions, "OntosId", {
    type: "string",
    minLength: ONTOS_ID_LENGTH,
    maxLength: ONTOS_ID_LENGTH,
    pattern: ONTOS_ID_PATTERN,
  });
  assertDefinition(definitions, "ArtifactDigest", {
    type: "string",
    minLength: ARTIFACT_DIGEST_LENGTH,
    maxLength: ARTIFACT_DIGEST_LENGTH,
    pattern: ARTIFACT_DIGEST_PATTERN,
  });
  assertDefinition(definitions, "CanonicalInstant", {
    type: "string",
    minLength: CANONICAL_INSTANT_LENGTH,
    maxLength: CANONICAL_INSTANT_LENGTH,
    pattern: CANONICAL_INSTANT_PATTERN,
    format: "ontos-canonical-instant",
  });
  assertDefinition(definitions, "ApiName", {
    type: "string",
    minLength: 1,
    maxLength: 63,
    pattern: API_NAME_PATTERN,
  });
  assertDefinition(definitions, "Namespace", {
    type: "string",
    minLength: 1,
    maxLength: 128,
    pattern: NAMESPACE_PATTERN,
  });
  assertDefinition(definitions, "SemanticVersion", {
    type: "string",
    minLength: 5,
    maxLength: 64,
    pattern: SEMANTIC_VERSION_PATTERN,
  });
  assertDefinition(definitions, "JsonPointer", {
    type: "string",
    minLength: 1,
    maxLength: 1_024,
    pattern: JSON_POINTER_PATTERN,
  });
  assertDefinition(definitions, "ResourceFamily", {
    type: "string",
    enum: RESOURCE_FAMILY_VALUES,
  });
  assertDefinition(definitions, "Classification", {
    type: "string",
    enum: CLASSIFICATION_VALUES,
  });
  assertDefinition(definitions, "PropertyValueType", {
    type: "string",
    enum: PROPERTY_VALUE_TYPE_VALUES,
  });
  assertDefinition(definitions, "PropertyWriteMode", {
    type: "string",
    enum: PROPERTY_WRITE_MODE_VALUES,
  });

  for (const [name, fields, required] of objectShapes) {
    assertObjectShape(definitions, name, fields, required);
  }

  assertReferences(definitions, "Project", {
    schemaVersion: "MetadataSchemaVersion",
    projectId: "OntosId",
    apiName: "ApiName",
    displayName: "DisplayName",
    createdAt: "CanonicalInstant",
  });
  assertEnum(definitions, "Project", "state", ["active", "archived"]);

  assertReferences(definitions, "ResourceEnvelope", {
    schemaVersion: "MetadataSchemaVersion",
    resourceId: "OntosId",
    projectId: "OntosId",
    namespace: "Namespace",
    apiName: "ApiName",
    family: "ResourceFamily",
  });
  assertEnum(definitions, "ResourceEnvelope", "state", ["active", "deprecated", "archived"]);

  assertReferences(definitions, "PropertyDefinition", {
    schemaVersion: "MetadataSchemaVersion",
    apiName: "ApiName",
    displayName: "DisplayName",
    description: "Description",
    valueType: "PropertyValueType",
    writeMode: "PropertyWriteMode",
    classification: "Classification",
  });
  for (const field of [
    "caseSensitive",
    "nullable",
    "unique",
    "filterable",
    "sortable",
    "searchable",
  ] as const) {
    assertProperty(definitions, "PropertyDefinition", field, { type: "boolean" });
  }
  assertProperty(definitions, "PropertyDefinition", "decimalPrecision", {
    type: "integer",
    minimum: 1,
    maximum: 38,
  });
  assertProperty(definitions, "PropertyDefinition", "decimalScale", {
    type: "integer",
    minimum: 0,
    maximum: 18,
  });
  assertArray(definitions, "PropertyDefinition", "enumValues", {
    minItems: 1,
    maxItems: 256,
    uniqueItems: true,
  });
  assertArray(definitions, "PropertyDefinition", "jsonFilterPaths", {
    minItems: 1,
    maxItems: 32,
    uniqueItems: true,
    itemRef: "JsonPointer",
  });

  assertReferences(definitions, "ObjectSortDefinition", { propertyApiName: "ApiName" });
  assertEnum(definitions, "ObjectSortDefinition", "direction", ["asc", "desc"]);
  assertReferences(definitions, "ObjectTypeDefinition", {
    schemaVersion: "MetadataSchemaVersion",
    apiName: "ApiName",
    displayName: "DisplayName",
    description: "Description",
    primaryKeyPropertyApiName: "ApiName",
    titlePropertyApiName: "ApiName",
    defaultClassification: "Classification",
  });
  assertArray(definitions, "ObjectTypeDefinition", "defaultSearchPropertyApiNames", {
    maxItems: 16,
    uniqueItems: true,
    itemRef: "ApiName",
  });
  assertArray(definitions, "ObjectTypeDefinition", "defaultSort", {
    maxItems: 8,
    itemRef: "ObjectSortDefinition",
  });
  assertArray(definitions, "ObjectTypeDefinition", "properties", {
    minItems: 1,
    maxItems: 128,
    itemRef: "PropertyDefinition",
  });

  assertReferences(definitions, "LinkEndpoint", {
    objectTypeRevisionId: "OntosId",
    apiName: "ApiName",
    displayName: "DisplayName",
  });
  assertReferences(definitions, "LinkTypeDefinition", {
    schemaVersion: "MetadataSchemaVersion",
    apiName: "ApiName",
    displayName: "DisplayName",
    description: "Description",
    source: "LinkEndpoint",
    target: "LinkEndpoint",
  });
  assertEnum(definitions, "LinkTypeDefinition", "cardinality", LINK_CARDINALITY_VALUES);
  assertEnum(definitions, "LinkTypeDefinition", "sourceKind", ["base", "overlay", "mixed"]);
  assertEnum(definitions, "LinkTypeDefinition", "deletionBehavior", [
    "restrict",
    "detach",
    "retain_history",
  ]);
  assertProperty(definitions, "LinkTypeDefinition", "actionCreateAllowed", { type: "boolean" });
  assertProperty(definitions, "LinkTypeDefinition", "actionDeleteAllowed", { type: "boolean" });

  assertReferences(definitions, "ResourceRevision", {
    schemaVersion: "MetadataSchemaVersion",
    revisionId: "OntosId",
    resourceId: "OntosId",
    parentRevisionId: "OntosId",
    family: "ResourceFamily",
    contentDigest: "ArtifactDigest",
    createdByPrincipalId: "OntosId",
    createdAt: "CanonicalInstant",
  });
  assertEnum(definitions, "ResourceRevision", "state", [
    "draft",
    "validated",
    "published",
    "deprecated",
    "archived",
  ]);
  assertProperty(definitions, "ResourceRevision", "etag", { type: "integer", minimum: 1 });

  assertReferences(definitions, "ResourceDependency", {
    schemaVersion: "MetadataSchemaVersion",
    dependencyId: "OntosId",
    sourceRevisionId: "OntosId",
    targetRevisionId: "OntosId",
    sourcePath: "JsonPointer",
  });
  assertEnum(definitions, "ResourceDependency", "dependencyType", [
    "property_reference",
    "link_source",
    "link_target",
  ]);

  assertReferences(definitions, "ValidationIssue", {
    code: "StableCode",
    resourceId: "OntosId",
    path: "JsonPointer",
  });
  assertEnum(definitions, "ValidationIssue", "severity", ["warning", "error"]);
  assertReferences(definitions, "ValidationReport", {
    schemaVersion: "MetadataSchemaVersion",
    reportId: "OntosId",
    subjectId: "OntosId",
    subjectDigest: "ArtifactDigest",
    validatorVersion: "VersionLabel",
  });
  assertProperty(definitions, "ValidationReport", "valid", { type: "boolean" });
  assertArray(definitions, "ValidationReport", "issues", {
    maxItems: 1_000,
    itemRef: "ValidationIssue",
  });

  assertReferences(definitions, "CompatibilityFinding", {
    code: "StableCode",
    path: "JsonPointer",
  });
  assertEnum(definitions, "CompatibilityFinding", "kind", [
    "compatible",
    "conditional",
    "breaking",
    "forbidden",
  ]);
  assertReferences(definitions, "CompatibilityReport", {
    schemaVersion: "MetadataSchemaVersion",
    reportId: "OntosId",
    baselineDigest: "ArtifactDigest",
    candidateDigest: "ArtifactDigest",
  });
  assertEnum(definitions, "CompatibilityReport", "outcome", [
    "compatible",
    "conditional",
    "breaking",
    "forbidden",
  ]);
  assertArray(definitions, "CompatibilityReport", "findings", {
    maxItems: 1_000,
    itemRef: "CompatibilityFinding",
  });

  assertReferences(definitions, "ReleasePin", {
    resourceId: "OntosId",
    revisionId: "OntosId",
    family: "ResourceFamily",
    contentDigest: "ArtifactDigest",
  });
  assertProperty(definitions, "ReleasePin", "order", { type: "integer", minimum: 0 });
  assertReferences(definitions, "ReleaseManifest", {
    schemaVersion: "MetadataSchemaVersion",
    releaseId: "OntosId",
    projectId: "OntosId",
    manifestDigest: "ArtifactDigest",
    createdAt: "CanonicalInstant",
  });
  assertProperty(definitions, "ReleaseManifest", "releaseNumber", {
    type: "integer",
    minimum: 1,
  });
  assertArray(definitions, "ReleaseManifest", "pins", {
    minItems: 1,
    maxItems: 512,
    itemRef: "ReleasePin",
  });

  assertReferences(definitions, "PackageResourceEntry", {
    namespace: "Namespace",
    apiName: "ApiName",
    family: "ResourceFamily",
    resourceId: "OntosId",
    revisionId: "OntosId",
    contentDigest: "ArtifactDigest",
  });
  assertReferences(definitions, "PackageInstallInput", {
    apiName: "ApiName",
    displayName: "DisplayName",
    description: "Description",
  });
  assertProperty(definitions, "PackageInstallInput", "required", { type: "boolean" });
  assertReferences(definitions, "PackageManifest", {
    schemaVersion: "MetadataSchemaVersion",
    packageApiName: "ApiName",
    version: "SemanticVersion",
    namespace: "Namespace",
    kernelContractVersion: "VersionLabel",
    manifestDigest: "ArtifactDigest",
  });
  assertArray(definitions, "PackageManifest", "resourceEntries", {
    minItems: 1,
    maxItems: 512,
    itemRef: "PackageResourceEntry",
  });
  assertArray(definitions, "PackageManifest", "artifactDigests", {
    maxItems: 128,
    uniqueItems: true,
    itemRef: "ArtifactDigest",
  });
  assertArray(definitions, "PackageManifest", "installInputs", {
    maxItems: 64,
    itemRef: "PackageInstallInput",
  });

  assertReferences(definitions, "ManagementRoleBinding", {
    schemaVersion: "MetadataSchemaVersion",
    bindingId: "OntosId",
    projectId: "OntosId",
    principalId: "OntosId",
    resourceId: "OntosId",
  });
  assertEnum(definitions, "ManagementRoleBinding", "scope", ["project", "resource"]);
  assertEnum(definitions, "ManagementRoleBinding", "role", MANAGEMENT_ROLE_VALUES);
  assertEnum(definitions, "ManagementRoleBinding", "state", ["active", "revoked"]);
}

const objectShapes: readonly (readonly [string, readonly string[], readonly string[]])[] = [
  ["Project", PROJECT_FIELDS, PROJECT_FIELDS],
  ["ResourceEnvelope", RESOURCE_ENVELOPE_FIELDS, RESOURCE_ENVELOPE_FIELDS],
  ["PropertyDefinition", PROPERTY_DEFINITION_FIELDS, PROPERTY_DEFINITION_REQUIRED_FIELDS],
  ["ObjectSortDefinition", OBJECT_SORT_DEFINITION_FIELDS, OBJECT_SORT_DEFINITION_FIELDS],
  ["ObjectTypeDefinition", OBJECT_TYPE_DEFINITION_FIELDS, OBJECT_TYPE_DEFINITION_FIELDS],
  ["LinkEndpoint", LINK_ENDPOINT_FIELDS, LINK_ENDPOINT_FIELDS],
  ["LinkTypeDefinition", LINK_TYPE_DEFINITION_FIELDS, LINK_TYPE_DEFINITION_FIELDS],
  ["ResourceRevision", RESOURCE_REVISION_FIELDS, RESOURCE_REVISION_REQUIRED_FIELDS],
  ["ResourceDependency", RESOURCE_DEPENDENCY_FIELDS, RESOURCE_DEPENDENCY_FIELDS],
  ["ValidationIssue", VALIDATION_ISSUE_FIELDS, VALIDATION_ISSUE_FIELDS],
  ["ValidationReport", VALIDATION_REPORT_FIELDS, VALIDATION_REPORT_FIELDS],
  ["CompatibilityFinding", COMPATIBILITY_FINDING_FIELDS, COMPATIBILITY_FINDING_FIELDS],
  ["CompatibilityReport", COMPATIBILITY_REPORT_FIELDS, COMPATIBILITY_REPORT_FIELDS],
  ["ReleasePin", RELEASE_PIN_FIELDS, RELEASE_PIN_FIELDS],
  ["ReleaseManifest", RELEASE_MANIFEST_FIELDS, RELEASE_MANIFEST_FIELDS],
  ["PackageResourceEntry", PACKAGE_RESOURCE_ENTRY_FIELDS, PACKAGE_RESOURCE_ENTRY_FIELDS],
  ["PackageInstallInput", PACKAGE_INSTALL_INPUT_FIELDS, PACKAGE_INSTALL_INPUT_FIELDS],
  ["PackageManifest", PACKAGE_MANIFEST_FIELDS, PACKAGE_MANIFEST_FIELDS],
  [
    "ManagementRoleBinding",
    MANAGEMENT_ROLE_BINDING_FIELDS,
    MANAGEMENT_ROLE_BINDING_REQUIRED_FIELDS,
  ],
];

function assertReferences(
  definitions: Readonly<Record<string, unknown>>,
  definitionName: string,
  references: Readonly<Record<string, string>>,
): void {
  for (const [field, target] of Object.entries(references)) {
    assertProperty(definitions, definitionName, field, { $ref: `#/$defs/${target}` });
  }
}

function assertEnum(
  definitions: Readonly<Record<string, unknown>>,
  definitionName: string,
  field: string,
  values: readonly string[],
): void {
  assertProperty(definitions, definitionName, field, { type: "string", enum: values });
}

function assertArray(
  definitions: Readonly<Record<string, unknown>>,
  definitionName: string,
  field: string,
  expected: Readonly<{
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    itemRef?: string;
  }>,
): void {
  const property = getProperty(definitions, definitionName, field);
  assertKeywords(property, `${definitionName}.${field}`, {
    type: "array",
    ...(expected.minItems === undefined ? {} : { minItems: expected.minItems }),
    ...(expected.maxItems === undefined ? {} : { maxItems: expected.maxItems }),
    ...(expected.uniqueItems === undefined ? {} : { uniqueItems: expected.uniqueItems }),
  });
  if (expected.itemRef !== undefined) {
    assertKeywords(requireRecord(property.items, `${definitionName}.${field}.items`), "$items", {
      $ref: `#/$defs/${expected.itemRef}`,
    });
  }
}

function assertProperty(
  definitions: Readonly<Record<string, unknown>>,
  definitionName: string,
  field: string,
  expected: Readonly<Record<string, unknown>>,
): void {
  assertKeywords(
    getProperty(definitions, definitionName, field),
    `${definitionName}.${field}`,
    expected,
  );
}

function assertDefinition(
  definitions: Readonly<Record<string, unknown>>,
  name: string,
  expected: Readonly<Record<string, unknown>>,
): void {
  assertKeywords(requireRecord(definitions[name], `$defs.${name}`), `$defs.${name}`, expected);
}

function assertObjectShape(
  definitions: Readonly<Record<string, unknown>>,
  name: string,
  fields: readonly string[],
  requiredFields: readonly string[],
): void {
  const definition = requireRecord(definitions[name], `$defs.${name}`);
  assertKeywords(definition, `$defs.${name}`, { type: "object", additionalProperties: false });
  const properties = requireRecord(definition.properties, `$defs.${name}.properties`);
  assertStringSet(Object.keys(properties), fields, `$defs.${name}.properties`);
  assertStringSet(
    requireStringArray(definition.required, `$defs.${name}.required`),
    requiredFields,
    `$defs.${name}.required`,
  );
}

function getProperty(
  definitions: Readonly<Record<string, unknown>>,
  definitionName: string,
  field: string,
): Readonly<Record<string, unknown>> {
  const definition = requireRecord(definitions[definitionName], `$defs.${definitionName}`);
  const properties = requireRecord(definition.properties, `$defs.${definitionName}.properties`);
  return requireRecord(properties[field], `$defs.${definitionName}.properties.${field}`);
}

function assertKeywords(
  target: Readonly<Record<string, unknown>>,
  path: string,
  expected: Readonly<Record<string, unknown>>,
): void {
  for (const [keyword, value] of Object.entries(expected)) {
    if (stableJson(target[keyword]) !== stableJson(value)) {
      throw new Error(`${path}.${keyword} disagrees with the runtime parser.`);
    }
  }
}

function assertStringSet(
  actual: readonly string[],
  expected: readonly string[],
  path: string,
): void {
  if (stableJson([...actual].sort()) !== stableJson([...expected].sort())) {
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
