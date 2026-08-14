import { failContract } from "./error.ts";
import {
  requireArray,
  requireBoolean,
  requireObjectShape,
  requireOneOf,
  requirePlainRecord,
  requireSafeInteger,
  requireString,
} from "./internal.ts";
import {
  parseArtifactDigest,
  parseCanonicalInstant,
  parseOntosId,
  parseSchemaVersion,
  type ArtifactDigest,
  type CanonicalInstant,
  type ContractSchemaVersion,
  type OntosId,
} from "./scalars.ts";

export const API_NAME_PATTERN = "^[A-Za-z][A-Za-z0-9_]{0,62}$";
export const NAMESPACE_PATTERN = "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$";
export const SEMANTIC_VERSION_PATTERN =
  "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$";
export const JSON_POINTER_PATTERN = "^(?:/(?:[^~/]|~0|~1)*)+$";

const apiNameExpression = new RegExp(API_NAME_PATTERN, "u");
const namespaceExpression = new RegExp(NAMESPACE_PATTERN, "u");
const semanticVersionExpression = new RegExp(SEMANTIC_VERSION_PATTERN, "u");
const jsonPointerExpression = new RegExp(JSON_POINTER_PATTERN, "u");

export const RESOURCE_FAMILY_VALUES = Object.freeze([
  "object_type",
  "link_type",
  "interface",
  "mapping",
  "snapshot_schema",
  "policy",
  "function_type",
  "action_type",
  "object_view",
  "application_config",
] as const);
export type ResourceFamily = (typeof RESOURCE_FAMILY_VALUES)[number];
const resourceFamilies = new Set<ResourceFamily>(RESOURCE_FAMILY_VALUES);

export const PROPERTY_VALUE_TYPE_VALUES = Object.freeze([
  "string",
  "boolean",
  "integer",
  "decimal",
  "date",
  "timestamp",
  "enum",
  "string[]",
  "json",
] as const);
export type PropertyValueType = (typeof PROPERTY_VALUE_TYPE_VALUES)[number];
const propertyValueTypes = new Set<PropertyValueType>(PROPERTY_VALUE_TYPE_VALUES);

export const PROPERTY_WRITE_MODE_VALUES = Object.freeze([
  "source_only",
  "overlay_override",
  "overlay_only",
  "system_managed",
] as const);
export type PropertyWriteMode = (typeof PROPERTY_WRITE_MODE_VALUES)[number];
const propertyWriteModes = new Set<PropertyWriteMode>(PROPERTY_WRITE_MODE_VALUES);

export const CLASSIFICATION_VALUES = Object.freeze([
  "public",
  "internal",
  "confidential",
  "restricted",
] as const);
export type MetadataClassification = (typeof CLASSIFICATION_VALUES)[number];
const classifications = new Set<MetadataClassification>(CLASSIFICATION_VALUES);

export const LINK_CARDINALITY_VALUES = Object.freeze([
  "one_to_one",
  "one_to_many",
  "many_to_one",
  "many_to_many",
] as const);
export type LinkCardinality = (typeof LINK_CARDINALITY_VALUES)[number];
const linkCardinalities = new Set<LinkCardinality>(LINK_CARDINALITY_VALUES);

export const MANAGEMENT_ROLE_VALUES = Object.freeze([
  "owner",
  "editor",
  "viewer",
  "executor",
  "auditor",
] as const);
export type ManagementRoleValue = (typeof MANAGEMENT_ROLE_VALUES)[number];
const managementRoles = new Set<ManagementRoleValue>(MANAGEMENT_ROLE_VALUES);

export interface ProjectContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly projectId: OntosId;
  readonly apiName: string;
  readonly displayName: string;
  readonly state: "active" | "archived";
  readonly createdAt: CanonicalInstant;
}

export const PROJECT_FIELDS = Object.freeze([
  "schemaVersion",
  "projectId",
  "apiName",
  "displayName",
  "state",
  "createdAt",
] as const);

export function parseProjectContract(value: unknown): ProjectContract {
  const path = "$project";
  const record = strictRecord(value, path, PROJECT_FIELDS, PROJECT_FIELDS);
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    apiName: parseApiName(record.apiName, `${path}.apiName`),
    displayName: parseDisplayName(record.displayName, `${path}.displayName`),
    state: requireOneOf(record.state, new Set(["active", "archived"] as const), `${path}.state`),
    createdAt: parseCanonicalInstant(record.createdAt, `${path}.createdAt`),
  });
}

export interface ResourceEnvelopeContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly resourceId: OntosId;
  readonly projectId: OntosId;
  readonly namespace: string;
  readonly apiName: string;
  readonly family: ResourceFamily;
  readonly state: "active" | "deprecated" | "archived";
}

export const RESOURCE_ENVELOPE_FIELDS = Object.freeze([
  "schemaVersion",
  "resourceId",
  "projectId",
  "namespace",
  "apiName",
  "family",
  "state",
] as const);

export function parseResourceEnvelope(value: unknown): ResourceEnvelopeContract {
  const path = "$resourceEnvelope";
  const record = strictRecord(value, path, RESOURCE_ENVELOPE_FIELDS, RESOURCE_ENVELOPE_FIELDS);
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    resourceId: parseOntosId(record.resourceId, `${path}.resourceId`),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    namespace: parseNamespace(record.namespace, `${path}.namespace`),
    apiName: parseApiName(record.apiName, `${path}.apiName`),
    family: requireOneOf(record.family, resourceFamilies, `${path}.family`),
    state: requireOneOf(
      record.state,
      new Set(["active", "deprecated", "archived"] as const),
      `${path}.state`,
    ),
  });
}

export interface PropertyDefinition {
  readonly schemaVersion: ContractSchemaVersion;
  readonly apiName: string;
  readonly displayName: string;
  readonly description: string;
  readonly valueType: PropertyValueType;
  readonly caseSensitive?: boolean;
  readonly nullable: boolean;
  readonly writeMode: PropertyWriteMode;
  readonly unique: boolean;
  readonly filterable: boolean;
  readonly sortable: boolean;
  readonly searchable: boolean;
  readonly classification?: MetadataClassification;
  readonly enumValues?: readonly string[];
  readonly decimalPrecision?: number;
  readonly decimalScale?: number;
  readonly jsonFilterPaths?: readonly string[];
}

export const PROPERTY_DEFINITION_FIELDS = Object.freeze([
  "schemaVersion",
  "apiName",
  "displayName",
  "description",
  "valueType",
  "caseSensitive",
  "nullable",
  "writeMode",
  "unique",
  "filterable",
  "sortable",
  "searchable",
  "classification",
  "enumValues",
  "decimalPrecision",
  "decimalScale",
  "jsonFilterPaths",
] as const);
export const PROPERTY_DEFINITION_REQUIRED_FIELDS = Object.freeze(
  PROPERTY_DEFINITION_FIELDS.filter(
    (field) =>
      field !== "enumValues" &&
      field !== "decimalPrecision" &&
      field !== "decimalScale" &&
      field !== "jsonFilterPaths" &&
      field !== "classification" &&
      field !== "caseSensitive",
  ),
);

export function parsePropertyDefinition(value: unknown, path = "$property"): PropertyDefinition {
  const record = strictRecord(
    value,
    path,
    PROPERTY_DEFINITION_FIELDS,
    PROPERTY_DEFINITION_REQUIRED_FIELDS,
  );
  const valueType = requireOneOf(record.valueType, propertyValueTypes, `${path}.valueType`);
  const result: PropertyDefinition = {
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    apiName: parseApiName(record.apiName, `${path}.apiName`),
    displayName: parseDisplayName(record.displayName, `${path}.displayName`),
    description: parseDescription(record.description, `${path}.description`),
    valueType,
    ...(record.caseSensitive === undefined
      ? {}
      : { caseSensitive: requireBoolean(record.caseSensitive, `${path}.caseSensitive`) }),
    nullable: requireBoolean(record.nullable, `${path}.nullable`),
    writeMode: requireOneOf(record.writeMode, propertyWriteModes, `${path}.writeMode`),
    unique: requireBoolean(record.unique, `${path}.unique`),
    filterable: requireBoolean(record.filterable, `${path}.filterable`),
    sortable: requireBoolean(record.sortable, `${path}.sortable`),
    searchable: requireBoolean(record.searchable, `${path}.searchable`),
    ...(record.classification === undefined
      ? {}
      : {
          classification: requireOneOf(
            record.classification,
            classifications,
            `${path}.classification`,
          ),
        }),
    ...(record.enumValues === undefined
      ? {}
      : {
          enumValues: parseStringSet(
            record.enumValues,
            `${path}.enumValues`,
            1,
            256,
            parseEnumCode,
          ),
        }),
    ...(record.decimalPrecision === undefined
      ? {}
      : {
          decimalPrecision: requireSafeInteger(
            record.decimalPrecision,
            `${path}.decimalPrecision`,
            {
              minimum: 1,
              maximum: 38,
            },
          ),
        }),
    ...(record.decimalScale === undefined
      ? {}
      : {
          decimalScale: requireSafeInteger(record.decimalScale, `${path}.decimalScale`, {
            minimum: 0,
            maximum: 18,
          }),
        }),
    ...(record.jsonFilterPaths === undefined
      ? {}
      : {
          jsonFilterPaths: parseStringSet(
            record.jsonFilterPaths,
            `${path}.jsonFilterPaths`,
            1,
            32,
            parseJsonPointer,
          ),
        }),
  };
  assertPropertySemantics(result, path);
  return Object.freeze(result);
}

export interface ObjectSortDefinition {
  readonly propertyApiName: string;
  readonly direction: "asc" | "desc";
}

export interface ObjectTypeDefinition {
  readonly schemaVersion: ContractSchemaVersion;
  readonly apiName: string;
  readonly displayName: string;
  readonly description: string;
  readonly primaryKeyPropertyApiName: string;
  readonly titlePropertyApiName: string;
  readonly defaultSearchPropertyApiNames: readonly string[];
  readonly defaultSort: readonly ObjectSortDefinition[];
  readonly defaultClassification: MetadataClassification;
  readonly properties: readonly PropertyDefinition[];
}

export const OBJECT_TYPE_DEFINITION_FIELDS = Object.freeze([
  "schemaVersion",
  "apiName",
  "displayName",
  "description",
  "primaryKeyPropertyApiName",
  "titlePropertyApiName",
  "defaultSearchPropertyApiNames",
  "defaultSort",
  "defaultClassification",
  "properties",
] as const);
export const OBJECT_SORT_DEFINITION_FIELDS = Object.freeze([
  "propertyApiName",
  "direction",
] as const);

export function parseObjectTypeDefinition(value: unknown): ObjectTypeDefinition {
  const path = "$objectType";
  const record = strictRecord(
    value,
    path,
    OBJECT_TYPE_DEFINITION_FIELDS,
    OBJECT_TYPE_DEFINITION_FIELDS,
  );
  const properties = requireArray(record.properties, `${path}.properties`, {
    minimumItems: 1,
    maximumItems: 128,
  }).map((item, index) => parsePropertyDefinition(item, `${path}.properties[${index}]`));
  assertUnique(
    properties.map((property) => property.apiName),
    `${path}.properties`,
  );
  const byName = new Map(properties.map((property) => [property.apiName, property]));
  const primaryKeyPropertyApiName = parseApiName(
    record.primaryKeyPropertyApiName,
    `${path}.primaryKeyPropertyApiName`,
  );
  const titlePropertyApiName = parseApiName(
    record.titlePropertyApiName,
    `${path}.titlePropertyApiName`,
  );
  const primaryKey = byName.get(primaryKeyPropertyApiName);
  const title = byName.get(titlePropertyApiName);
  if (primaryKey === undefined || title === undefined) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Primary Key and Title must reference declared Properties.",
      path,
    );
  }
  if (
    primaryKey.nullable ||
    !primaryKey.unique ||
    !new Set<PropertyValueType>([
      "string",
      "boolean",
      "integer",
      "decimal",
      "date",
      "timestamp",
      "enum",
    ]).has(primaryKey.valueType)
  ) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Primary Key must be a unique, non-nullable stable scalar Property.",
      `${path}.primaryKeyPropertyApiName`,
    );
  }
  const defaultSearchPropertyApiNames = parseStringSet(
    record.defaultSearchPropertyApiNames,
    `${path}.defaultSearchPropertyApiNames`,
    0,
    16,
    parseApiName,
  );
  for (const propertyName of defaultSearchPropertyApiNames) {
    if (byName.get(propertyName)?.searchable !== true) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "Default search must reference a searchable Property.",
        `${path}.defaultSearchPropertyApiNames`,
      );
    }
  }
  const defaultSort = requireArray(record.defaultSort, `${path}.defaultSort`, {
    maximumItems: 8,
  }).map((item, index) => parseSortDefinition(item, `${path}.defaultSort[${index}]`));
  assertUnique(
    defaultSort.map((item) => item.propertyApiName),
    `${path}.defaultSort`,
  );
  for (const sort of defaultSort) {
    if (byName.get(sort.propertyApiName)?.sortable !== true) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "Default sort must reference a sortable Property.",
        `${path}.defaultSort`,
      );
    }
  }
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    apiName: parseApiName(record.apiName, `${path}.apiName`),
    displayName: parseDisplayName(record.displayName, `${path}.displayName`),
    description: parseDescription(record.description, `${path}.description`),
    primaryKeyPropertyApiName,
    titlePropertyApiName,
    defaultSearchPropertyApiNames,
    defaultSort: Object.freeze(defaultSort),
    defaultClassification: requireOneOf(
      record.defaultClassification,
      classifications,
      `${path}.defaultClassification`,
    ),
    properties: Object.freeze(properties),
  });
}

export interface LinkEndpointDefinition {
  readonly objectTypeRevisionId: OntosId;
  readonly apiName: string;
  readonly displayName: string;
}

export interface LinkTypeDefinition {
  readonly schemaVersion: ContractSchemaVersion;
  readonly apiName: string;
  readonly displayName: string;
  readonly description: string;
  readonly source: LinkEndpointDefinition;
  readonly target: LinkEndpointDefinition;
  readonly cardinality: LinkCardinality;
  readonly sourceKind: "base" | "overlay" | "mixed";
  readonly deletionBehavior: "restrict" | "detach" | "retain_history";
  readonly actionCreateAllowed: boolean;
  readonly actionDeleteAllowed: boolean;
}

export const LINK_ENDPOINT_FIELDS = Object.freeze([
  "objectTypeRevisionId",
  "apiName",
  "displayName",
] as const);
export const LINK_TYPE_DEFINITION_FIELDS = Object.freeze([
  "schemaVersion",
  "apiName",
  "displayName",
  "description",
  "source",
  "target",
  "cardinality",
  "sourceKind",
  "deletionBehavior",
  "actionCreateAllowed",
  "actionDeleteAllowed",
] as const);

export function parseLinkTypeDefinition(value: unknown): LinkTypeDefinition {
  const path = "$linkType";
  const record = strictRecord(
    value,
    path,
    LINK_TYPE_DEFINITION_FIELDS,
    LINK_TYPE_DEFINITION_FIELDS,
  );
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    apiName: parseApiName(record.apiName, `${path}.apiName`),
    displayName: parseDisplayName(record.displayName, `${path}.displayName`),
    description: parseDescription(record.description, `${path}.description`),
    source: parseLinkEndpoint(record.source, `${path}.source`),
    target: parseLinkEndpoint(record.target, `${path}.target`),
    cardinality: requireOneOf(record.cardinality, linkCardinalities, `${path}.cardinality`),
    sourceKind: requireOneOf(
      record.sourceKind,
      new Set(["base", "overlay", "mixed"] as const),
      `${path}.sourceKind`,
    ),
    deletionBehavior: requireOneOf(
      record.deletionBehavior,
      new Set(["restrict", "detach", "retain_history"] as const),
      `${path}.deletionBehavior`,
    ),
    actionCreateAllowed: requireBoolean(record.actionCreateAllowed, `${path}.actionCreateAllowed`),
    actionDeleteAllowed: requireBoolean(record.actionDeleteAllowed, `${path}.actionDeleteAllowed`),
  });
}

export interface ResourceRevisionContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly revisionId: OntosId;
  readonly resourceId: OntosId;
  readonly parentRevisionId?: OntosId;
  readonly family: ResourceFamily;
  readonly state: "draft" | "validated" | "published" | "deprecated" | "archived";
  readonly etag: number;
  readonly contentDigest: ArtifactDigest;
  readonly createdByPrincipalId: OntosId;
  readonly createdAt: CanonicalInstant;
}

export const RESOURCE_REVISION_FIELDS = Object.freeze([
  "schemaVersion",
  "revisionId",
  "resourceId",
  "parentRevisionId",
  "family",
  "state",
  "etag",
  "contentDigest",
  "createdByPrincipalId",
  "createdAt",
] as const);
export const RESOURCE_REVISION_REQUIRED_FIELDS = Object.freeze(
  RESOURCE_REVISION_FIELDS.filter((field) => field !== "parentRevisionId"),
);

export function parseResourceRevision(value: unknown): ResourceRevisionContract {
  const path = "$resourceRevision";
  const record = strictRecord(
    value,
    path,
    RESOURCE_REVISION_FIELDS,
    RESOURCE_REVISION_REQUIRED_FIELDS,
  );
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    revisionId: parseOntosId(record.revisionId, `${path}.revisionId`),
    resourceId: parseOntosId(record.resourceId, `${path}.resourceId`),
    ...(record.parentRevisionId === undefined
      ? {}
      : { parentRevisionId: parseOntosId(record.parentRevisionId, `${path}.parentRevisionId`) }),
    family: requireOneOf(record.family, resourceFamilies, `${path}.family`),
    state: requireOneOf(
      record.state,
      new Set(["draft", "validated", "published", "deprecated", "archived"] as const),
      `${path}.state`,
    ),
    etag: requireSafeInteger(record.etag, `${path}.etag`, { minimum: 1 }),
    contentDigest: parseArtifactDigest(record.contentDigest, `${path}.contentDigest`),
    createdByPrincipalId: parseOntosId(record.createdByPrincipalId, `${path}.createdByPrincipalId`),
    createdAt: parseCanonicalInstant(record.createdAt, `${path}.createdAt`),
  });
}

export interface ResourceDependencyContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly dependencyId: OntosId;
  readonly sourceRevisionId: OntosId;
  readonly targetRevisionId: OntosId;
  readonly dependencyType: "property_reference" | "link_source" | "link_target";
  readonly sourcePath: string;
}

export const RESOURCE_DEPENDENCY_FIELDS = Object.freeze([
  "schemaVersion",
  "dependencyId",
  "sourceRevisionId",
  "targetRevisionId",
  "dependencyType",
  "sourcePath",
] as const);

export function parseResourceDependency(value: unknown): ResourceDependencyContract {
  const path = "$resourceDependency";
  const record = strictRecord(value, path, RESOURCE_DEPENDENCY_FIELDS, RESOURCE_DEPENDENCY_FIELDS);
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    dependencyId: parseOntosId(record.dependencyId, `${path}.dependencyId`),
    sourceRevisionId: parseOntosId(record.sourceRevisionId, `${path}.sourceRevisionId`),
    targetRevisionId: parseOntosId(record.targetRevisionId, `${path}.targetRevisionId`),
    dependencyType: requireOneOf(
      record.dependencyType,
      new Set(["property_reference", "link_source", "link_target"] as const),
      `${path}.dependencyType`,
    ),
    sourcePath: parseJsonPointer(record.sourcePath, `${path}.sourcePath`),
  });
}

export interface ValidationIssueContract {
  readonly code: string;
  readonly severity: "warning" | "error";
  readonly resourceId: OntosId;
  readonly path: string;
  readonly message: string;
  readonly remediation: string;
}

export interface ValidationReportContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly reportId: OntosId;
  readonly subjectId: OntosId;
  readonly subjectDigest: ArtifactDigest;
  readonly validatorVersion: string;
  readonly valid: boolean;
  readonly issues: readonly ValidationIssueContract[];
}

export const VALIDATION_ISSUE_FIELDS = Object.freeze([
  "code",
  "severity",
  "resourceId",
  "path",
  "message",
  "remediation",
] as const);
export const VALIDATION_REPORT_FIELDS = Object.freeze([
  "schemaVersion",
  "reportId",
  "subjectId",
  "subjectDigest",
  "validatorVersion",
  "valid",
  "issues",
] as const);

export function parseValidationReport(value: unknown): ValidationReportContract {
  const path = "$validationReport";
  const record = strictRecord(value, path, VALIDATION_REPORT_FIELDS, VALIDATION_REPORT_FIELDS);
  const issues = requireArray(record.issues, `${path}.issues`, { maximumItems: 1_000 }).map(
    (item, index) => parseValidationIssue(item, `${path}.issues[${index}]`),
  );
  const valid = requireBoolean(record.valid, `${path}.valid`);
  if (valid === issues.some((issue) => issue.severity === "error")) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Validation validity contradicts error Issues.",
      `${path}.valid`,
    );
  }
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    reportId: parseOntosId(record.reportId, `${path}.reportId`),
    subjectId: parseOntosId(record.subjectId, `${path}.subjectId`),
    subjectDigest: parseArtifactDigest(record.subjectDigest, `${path}.subjectDigest`),
    validatorVersion: parseVersionLabel(record.validatorVersion, `${path}.validatorVersion`),
    valid,
    issues: Object.freeze(issues),
  });
}

export interface CompatibilityFindingContract {
  readonly kind: "compatible" | "conditional" | "breaking" | "forbidden";
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly requiredNextStep: string;
}

export interface CompatibilityReportContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly reportId: OntosId;
  readonly baselineDigest: ArtifactDigest;
  readonly candidateDigest: ArtifactDigest;
  readonly outcome: "compatible" | "conditional" | "breaking" | "forbidden";
  readonly findings: readonly CompatibilityFindingContract[];
}

export const COMPATIBILITY_FINDING_FIELDS = Object.freeze([
  "kind",
  "code",
  "path",
  "message",
  "requiredNextStep",
] as const);
export const COMPATIBILITY_REPORT_FIELDS = Object.freeze([
  "schemaVersion",
  "reportId",
  "baselineDigest",
  "candidateDigest",
  "outcome",
  "findings",
] as const);

export function parseCompatibilityReport(value: unknown): CompatibilityReportContract {
  const path = "$compatibilityReport";
  const record = strictRecord(
    value,
    path,
    COMPATIBILITY_REPORT_FIELDS,
    COMPATIBILITY_REPORT_FIELDS,
  );
  const findings = requireArray(record.findings, `${path}.findings`, {
    maximumItems: 1_000,
  }).map((item, index) => parseCompatibilityFinding(item, `${path}.findings[${index}]`));
  const outcome = requireOneOf(
    record.outcome,
    new Set(["compatible", "conditional", "breaking", "forbidden"] as const),
    `${path}.outcome`,
  );
  if (maximumCompatibilityKind(findings) !== outcome) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Compatibility outcome contradicts its Findings.",
      `${path}.outcome`,
    );
  }
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    reportId: parseOntosId(record.reportId, `${path}.reportId`),
    baselineDigest: parseArtifactDigest(record.baselineDigest, `${path}.baselineDigest`),
    candidateDigest: parseArtifactDigest(record.candidateDigest, `${path}.candidateDigest`),
    outcome,
    findings: Object.freeze(findings),
  });
}

export interface ReleasePinContract {
  readonly order: number;
  readonly resourceId: OntosId;
  readonly revisionId: OntosId;
  readonly family: ResourceFamily;
  readonly contentDigest: ArtifactDigest;
}

export interface ReleaseManifestContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly releaseId: OntosId;
  readonly projectId: OntosId;
  readonly releaseNumber: number;
  readonly pins: readonly ReleasePinContract[];
  readonly manifestDigest: ArtifactDigest;
  readonly createdAt: CanonicalInstant;
}

export const RELEASE_PIN_FIELDS = Object.freeze([
  "order",
  "resourceId",
  "revisionId",
  "family",
  "contentDigest",
] as const);
export const RELEASE_MANIFEST_FIELDS = Object.freeze([
  "schemaVersion",
  "releaseId",
  "projectId",
  "releaseNumber",
  "pins",
  "manifestDigest",
  "createdAt",
] as const);

export function parseReleaseManifest(value: unknown): ReleaseManifestContract {
  const path = "$releaseManifest";
  const record = strictRecord(value, path, RELEASE_MANIFEST_FIELDS, RELEASE_MANIFEST_FIELDS);
  const pins = requireArray(record.pins, `${path}.pins`, {
    minimumItems: 1,
    maximumItems: 512,
  }).map((item, index) => parseReleasePin(item, `${path}.pins[${index}]`));
  assertUnique(
    pins.map((pin) => pin.resourceId),
    `${path}.pins`,
  );
  pins.forEach((pin, index) => {
    if (pin.order !== index) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "Release Pins must use contiguous deterministic order.",
        `${path}.pins[${index}].order`,
      );
    }
  });
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    releaseId: parseOntosId(record.releaseId, `${path}.releaseId`),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    releaseNumber: requireSafeInteger(record.releaseNumber, `${path}.releaseNumber`, {
      minimum: 1,
    }),
    pins: Object.freeze(pins),
    manifestDigest: parseArtifactDigest(record.manifestDigest, `${path}.manifestDigest`),
    createdAt: parseCanonicalInstant(record.createdAt, `${path}.createdAt`),
  });
}

export interface PackageResourceEntryContract {
  readonly namespace: string;
  readonly apiName: string;
  readonly family: ResourceFamily;
  readonly resourceId: OntosId;
  readonly revisionId: OntosId;
  readonly contentDigest: ArtifactDigest;
}

export interface PackageInstallInputContract {
  readonly apiName: string;
  readonly displayName: string;
  readonly description: string;
  readonly required: boolean;
}

export interface PackageManifestContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly packageApiName: string;
  readonly version: string;
  readonly namespace: string;
  readonly kernelContractVersion: string;
  readonly resourceEntries: readonly PackageResourceEntryContract[];
  readonly artifactDigests: readonly ArtifactDigest[];
  readonly installInputs: readonly PackageInstallInputContract[];
  readonly manifestDigest: ArtifactDigest;
}

export const PACKAGE_RESOURCE_ENTRY_FIELDS = Object.freeze([
  "namespace",
  "apiName",
  "family",
  "resourceId",
  "revisionId",
  "contentDigest",
] as const);
export const PACKAGE_INSTALL_INPUT_FIELDS = Object.freeze([
  "apiName",
  "displayName",
  "description",
  "required",
] as const);
export const PACKAGE_MANIFEST_FIELDS = Object.freeze([
  "schemaVersion",
  "packageApiName",
  "version",
  "namespace",
  "kernelContractVersion",
  "resourceEntries",
  "artifactDigests",
  "installInputs",
  "manifestDigest",
] as const);

export function parsePackageManifest(value: unknown): PackageManifestContract {
  const path = "$packageManifest";
  const record = strictRecord(value, path, PACKAGE_MANIFEST_FIELDS, PACKAGE_MANIFEST_FIELDS);
  const resourceEntries = requireArray(record.resourceEntries, `${path}.resourceEntries`, {
    minimumItems: 1,
    maximumItems: 512,
  }).map((item, index) => parsePackageResourceEntry(item, `${path}.resourceEntries[${index}]`));
  const resourceKeys = resourceEntries.map(
    (entry) => `${entry.namespace}\u0000${entry.apiName}\u0000${entry.family}`,
  );
  assertUnique(resourceKeys, `${path}.resourceEntries`);
  assertSorted(resourceKeys, `${path}.resourceEntries`);
  const artifactDigests = parseStringSet(
    record.artifactDigests,
    `${path}.artifactDigests`,
    0,
    128,
    parseArtifactDigest,
  );
  assertSorted(artifactDigests, `${path}.artifactDigests`);
  const installInputs = requireArray(record.installInputs, `${path}.installInputs`, {
    maximumItems: 64,
  }).map((item, index) => parsePackageInstallInput(item, `${path}.installInputs[${index}]`));
  assertUnique(
    installInputs.map((item) => item.apiName),
    `${path}.installInputs`,
  );
  assertSorted(
    installInputs.map((item) => item.apiName),
    `${path}.installInputs`,
  );
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    packageApiName: parseApiName(record.packageApiName, `${path}.packageApiName`),
    version: parseSemanticVersion(record.version, `${path}.version`),
    namespace: parseNamespace(record.namespace, `${path}.namespace`),
    kernelContractVersion: parseVersionLabel(
      record.kernelContractVersion,
      `${path}.kernelContractVersion`,
    ),
    resourceEntries: Object.freeze(resourceEntries),
    artifactDigests,
    installInputs: Object.freeze(installInputs),
    manifestDigest: parseArtifactDigest(record.manifestDigest, `${path}.manifestDigest`),
  });
}

export interface ManagementRoleBindingContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly bindingId: OntosId;
  readonly projectId: OntosId;
  readonly principalId: OntosId;
  readonly scope: "project" | "resource";
  readonly resourceId?: OntosId;
  readonly role: ManagementRoleValue;
  readonly state: "active" | "revoked";
}

export const MANAGEMENT_ROLE_BINDING_FIELDS = Object.freeze([
  "schemaVersion",
  "bindingId",
  "projectId",
  "principalId",
  "scope",
  "resourceId",
  "role",
  "state",
] as const);
export const MANAGEMENT_ROLE_BINDING_REQUIRED_FIELDS = Object.freeze(
  MANAGEMENT_ROLE_BINDING_FIELDS.filter((field) => field !== "resourceId"),
);

export function parseManagementRoleBinding(value: unknown): ManagementRoleBindingContract {
  const path = "$managementRoleBinding";
  const record = strictRecord(
    value,
    path,
    MANAGEMENT_ROLE_BINDING_FIELDS,
    MANAGEMENT_ROLE_BINDING_REQUIRED_FIELDS,
  );
  const scope = requireOneOf(
    record.scope,
    new Set(["project", "resource"] as const),
    `${path}.scope`,
  );
  if ((scope === "resource") !== (record.resourceId !== undefined)) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Resource scope requires resourceId and Project scope forbids it.",
      `${path}.resourceId`,
    );
  }
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    bindingId: parseOntosId(record.bindingId, `${path}.bindingId`),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    principalId: parseOntosId(record.principalId, `${path}.principalId`),
    scope,
    ...(record.resourceId === undefined
      ? {}
      : { resourceId: parseOntosId(record.resourceId, `${path}.resourceId`) }),
    role: requireOneOf(record.role, managementRoles, `${path}.role`),
    state: requireOneOf(record.state, new Set(["active", "revoked"] as const), `${path}.state`),
  });
}

function parseLinkEndpoint(value: unknown, path: string): LinkEndpointDefinition {
  const record = strictRecord(value, path, LINK_ENDPOINT_FIELDS, LINK_ENDPOINT_FIELDS);
  return Object.freeze({
    objectTypeRevisionId: parseOntosId(record.objectTypeRevisionId, `${path}.objectTypeRevisionId`),
    apiName: parseApiName(record.apiName, `${path}.apiName`),
    displayName: parseDisplayName(record.displayName, `${path}.displayName`),
  });
}

function parseSortDefinition(value: unknown, path: string): ObjectSortDefinition {
  const record = strictRecord(
    value,
    path,
    OBJECT_SORT_DEFINITION_FIELDS,
    OBJECT_SORT_DEFINITION_FIELDS,
  );
  return Object.freeze({
    propertyApiName: parseApiName(record.propertyApiName, `${path}.propertyApiName`),
    direction: requireOneOf(
      record.direction,
      new Set(["asc", "desc"] as const),
      `${path}.direction`,
    ),
  });
}

function parseValidationIssue(value: unknown, path: string): ValidationIssueContract {
  const record = strictRecord(value, path, VALIDATION_ISSUE_FIELDS, VALIDATION_ISSUE_FIELDS);
  return Object.freeze({
    code: parseStableCode(record.code, `${path}.code`),
    severity: requireOneOf(
      record.severity,
      new Set(["warning", "error"] as const),
      `${path}.severity`,
    ),
    resourceId: parseOntosId(record.resourceId, `${path}.resourceId`),
    path: parseJsonPointer(record.path, `${path}.path`),
    message: requireString(record.message, `${path}.message`, { maximumLength: 1_024 }),
    remediation: requireString(record.remediation, `${path}.remediation`, { maximumLength: 1_024 }),
  });
}

function parseCompatibilityFinding(value: unknown, path: string): CompatibilityFindingContract {
  const record = strictRecord(
    value,
    path,
    COMPATIBILITY_FINDING_FIELDS,
    COMPATIBILITY_FINDING_FIELDS,
  );
  return Object.freeze({
    kind: requireOneOf(
      record.kind,
      new Set(["compatible", "conditional", "breaking", "forbidden"] as const),
      `${path}.kind`,
    ),
    code: parseStableCode(record.code, `${path}.code`),
    path: parseJsonPointer(record.path, `${path}.path`),
    message: requireString(record.message, `${path}.message`, { maximumLength: 1_024 }),
    requiredNextStep: requireString(record.requiredNextStep, `${path}.requiredNextStep`, {
      maximumLength: 1_024,
    }),
  });
}

function parseReleasePin(value: unknown, path: string): ReleasePinContract {
  const record = strictRecord(value, path, RELEASE_PIN_FIELDS, RELEASE_PIN_FIELDS);
  return Object.freeze({
    order: requireSafeInteger(record.order, `${path}.order`, { minimum: 0, maximum: 511 }),
    resourceId: parseOntosId(record.resourceId, `${path}.resourceId`),
    revisionId: parseOntosId(record.revisionId, `${path}.revisionId`),
    family: requireOneOf(record.family, resourceFamilies, `${path}.family`),
    contentDigest: parseArtifactDigest(record.contentDigest, `${path}.contentDigest`),
  });
}

function parsePackageResourceEntry(value: unknown, path: string): PackageResourceEntryContract {
  const record = strictRecord(
    value,
    path,
    PACKAGE_RESOURCE_ENTRY_FIELDS,
    PACKAGE_RESOURCE_ENTRY_FIELDS,
  );
  return Object.freeze({
    namespace: parseNamespace(record.namespace, `${path}.namespace`),
    apiName: parseApiName(record.apiName, `${path}.apiName`),
    family: requireOneOf(record.family, resourceFamilies, `${path}.family`),
    resourceId: parseOntosId(record.resourceId, `${path}.resourceId`),
    revisionId: parseOntosId(record.revisionId, `${path}.revisionId`),
    contentDigest: parseArtifactDigest(record.contentDigest, `${path}.contentDigest`),
  });
}

function parsePackageInstallInput(value: unknown, path: string): PackageInstallInputContract {
  const record = strictRecord(
    value,
    path,
    PACKAGE_INSTALL_INPUT_FIELDS,
    PACKAGE_INSTALL_INPUT_FIELDS,
  );
  return Object.freeze({
    apiName: parseApiName(record.apiName, `${path}.apiName`),
    displayName: parseDisplayName(record.displayName, `${path}.displayName`),
    description: parseDescription(record.description, `${path}.description`),
    required: requireBoolean(record.required, `${path}.required`),
  });
}

function assertPropertySemantics(property: PropertyDefinition, path: string): void {
  if (property.valueType === "string") {
    if (property.caseSensitive === undefined) {
      failContract(
        "CONTRACT_FIELD_MISSING",
        "String Property requires an explicit caseSensitive rule.",
        `${path}.caseSensitive`,
      );
    }
  } else if (property.caseSensitive !== undefined) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "caseSensitive is valid only for string.",
      `${path}.caseSensitive`,
    );
  }
  if (property.valueType === "enum") {
    if (property.enumValues === undefined) {
      failContract(
        "CONTRACT_FIELD_MISSING",
        "Enum Property requires enumValues.",
        `${path}.enumValues`,
      );
    }
  } else if (property.enumValues !== undefined) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "enumValues is valid only for enum.",
      `${path}.enumValues`,
    );
  }
  if (property.valueType === "decimal") {
    if (property.decimalPrecision === undefined || property.decimalScale === undefined) {
      failContract(
        "CONTRACT_FIELD_MISSING",
        "Decimal Property requires precision and scale.",
        path,
      );
    }
    if (property.decimalScale > property.decimalPrecision) {
      failContract(
        "CONTRACT_VALUE_OUT_OF_RANGE",
        "Decimal scale cannot exceed precision.",
        `${path}.decimalScale`,
      );
    }
  } else if (property.decimalPrecision !== undefined || property.decimalScale !== undefined) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Decimal precision and scale are valid only for decimal.",
      path,
    );
  }
  if (property.valueType === "json") {
    if (property.sortable || property.searchable || property.unique) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "JSON Property cannot be sortable, searchable or unique.",
        path,
      );
    }
    if (property.filterable !== (property.jsonFilterPaths !== undefined)) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "Filterable JSON requires registered top-level paths and non-filterable JSON forbids them.",
        `${path}.jsonFilterPaths`,
      );
    }
  } else if (property.jsonFilterPaths !== undefined) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "jsonFilterPaths is valid only for JSON.",
      `${path}.jsonFilterPaths`,
    );
  }
  if (property.searchable && property.valueType !== "string") {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Only string Property can be searchable in G2-01.",
      `${path}.searchable`,
    );
  }
}

function maximumCompatibilityKind(
  findings: readonly CompatibilityFindingContract[],
): CompatibilityReportContract["outcome"] {
  const rank: Readonly<Record<CompatibilityFindingContract["kind"], number>> = {
    compatible: 0,
    conditional: 1,
    breaking: 2,
    forbidden: 3,
  };
  let outcome: CompatibilityReportContract["outcome"] = "compatible";
  for (const finding of findings) {
    if (rank[finding.kind] > rank[outcome]) outcome = finding.kind;
  }
  return outcome;
}

function strictRecord(
  value: unknown,
  path: string,
  fields: readonly string[],
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = requirePlainRecord(value, path);
  requireObjectShape(record, fields, required, path);
  return record;
}

function parseApiName(value: unknown, path: string): string {
  return requireString(value, path, { maximumLength: 63, pattern: apiNameExpression });
}

function parseNamespace(value: unknown, path: string): string {
  return requireString(value, path, { maximumLength: 128, pattern: namespaceExpression });
}

function parseDisplayName(value: unknown, path: string): string {
  return requireString(value, path, { maximumLength: 256 });
}

function parseDescription(value: unknown, path: string): string {
  return requireString(value, path, { minimumLength: 0, maximumLength: 4_096 });
}

function parseVersionLabel(value: unknown, path: string): string {
  return requireString(value, path, {
    maximumLength: 64,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,
  });
}

function parseSemanticVersion(value: unknown, path: string): string {
  return requireString(value, path, { maximumLength: 64, pattern: semanticVersionExpression });
}

function parseStableCode(value: unknown, path: string): string {
  return requireString(value, path, { maximumLength: 128, pattern: /^[A-Z][A-Z0-9_]{2,127}$/u });
}

function parseEnumCode(value: unknown, path: string): string {
  return requireString(value, path, { maximumLength: 128, pattern: /^[A-Z][A-Z0-9_]{0,127}$/u });
}

function parseJsonPointer(value: unknown, path: string): string {
  return requireString(value, path, { maximumLength: 1_024, pattern: jsonPointerExpression });
}

function parseStringSet<T extends string>(
  value: unknown,
  path: string,
  minimumItems: number,
  maximumItems: number,
  parse: (value: unknown, path: string) => T,
): readonly T[] {
  const parsed = requireArray(value, path, { minimumItems, maximumItems }).map((item, index) =>
    parse(item, `${path}[${index}]`),
  );
  assertUnique(parsed, path);
  return Object.freeze(parsed);
}

function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    failContract("CONTRACT_FORMAT_INVALID", "Values must be unique.", path);
  }
}

function assertSorted(values: readonly string[], path: string): void {
  const sorted = [...values].sort(compareCodeUnits);
  if (values.some((value, index) => value !== sorted[index])) {
    failContract("CONTRACT_FORMAT_INVALID", "Values must use deterministic order.", path);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
