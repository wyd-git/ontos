import { canonicalizeContractForDigest } from "./canonical-json.ts";
import { failContract } from "./error.ts";
import {
  requireArray,
  requireBoolean,
  requireLiteral,
  requireObjectShape,
  requireOneOf,
  requirePlainRecord,
  requireSafeInteger,
  requireString,
} from "./internal.ts";
import {
  API_NAME_PATTERN,
  PROPERTY_VALUE_TYPE_VALUES,
  type PropertyValueType,
} from "./metadata.ts";
import {
  parseArtifactDigest,
  parseCanonicalInstant,
  parseIdempotencyKey,
  parseOntosId,
  parseSchemaVersion,
  type ArtifactDigest,
  type CanonicalInstant,
  type ContractSchemaVersion,
  type IdempotencyKey,
  type OntosId,
} from "./scalars.ts";

export const SNAPSHOT_SCHEMA_VERSION = "snapshot-schema-v1" as const;
export const MAPPING_LANGUAGE_VERSION = "mapping-v1" as const;
export const VALUE_CODEC_CONTRACT_VERSION = "pk1" as const;
export const MATERIALIZATION_IDEMPOTENCY_VERSION = "materialization-idempotency-v1" as const;

export const MATERIALIZATION_MEMBER_KEY_PATTERN = "^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$";
export const MATERIALIZATION_VERSION_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
export const POSITIVE_BIGINT_TEXT_PATTERN = "^[1-9][0-9]{0,18}$";

const apiNameExpression = new RegExp(API_NAME_PATTERN, "u");
const memberKeyExpression = new RegExp(MATERIALIZATION_MEMBER_KEY_PATTERN, "u");
const versionExpression = new RegExp(MATERIALIZATION_VERSION_PATTERN, "u");
const positiveBigintTextExpression = new RegExp(POSITIVE_BIGINT_TEXT_PATTERN, "u");
const propertyValueTypes = new Set<PropertyValueType>(PROPERTY_VALUE_TYPE_VALUES);

export const SNAPSHOT_STATE_VALUES = Object.freeze([
  "registered",
  "validated",
  "materializing",
  "ready",
  "active",
  "superseded",
  "failed",
] as const);
export type SnapshotState = (typeof SNAPSHOT_STATE_VALUES)[number];

export const SNAPSHOT_GROUP_STATE_VALUES = Object.freeze([
  "registered",
  "validated",
  "materializing",
  "ready",
  "active",
  "superseded",
  "failed",
] as const);
export type SnapshotGroupState = (typeof SNAPSHOT_GROUP_STATE_VALUES)[number];

export const MATERIALIZATION_JOB_STATE_VALUES = Object.freeze([
  "queued",
  "running",
  "retry_wait",
  "succeeded",
  "dead_letter",
  "cancelled",
] as const);
export type MaterializationJobState = (typeof MATERIALIZATION_JOB_STATE_VALUES)[number];

export const MATERIALIZATION_STAGE_VALUES = Object.freeze([
  "scan",
  "map",
  "validate",
  "build_stage",
  "build_index",
  "ready_for_activation",
  "catch_up",
  "activate",
] as const);
export type MaterializationStage = (typeof MATERIALIZATION_STAGE_VALUES)[number];

export const GENERATION_STATE_VALUES = Object.freeze([
  "building",
  "ready",
  "active",
  "retired",
  "failed",
] as const);
export type GenerationState = (typeof GENERATION_STATE_VALUES)[number];

export const RUNTIME_ACTIVATION_STATE_VALUES = Object.freeze([
  "building",
  "ready",
  "active",
  "retired",
  "failed",
] as const);
export type RuntimeActivationState = (typeof RUNTIME_ACTIVATION_STATE_VALUES)[number];

export const GC_PLAN_STATE_VALUES = Object.freeze([
  "planned",
  "committed",
  "stale",
  "failed",
  "cancelled",
] as const);
export type GcPlanState = (typeof GC_PLAN_STATE_VALUES)[number];

export const MATERIALIZATION_REASON_CODE_VALUES = Object.freeze([
  "PRIMARY_KEY_NULL",
  "PRIMARY_KEY_DUPLICATE",
  "REQUIRED_PROPERTY_INVALID",
  "OPTIONAL_PROPERTY_INVALID",
  "REQUIRED_LINK_DANGLING",
  "OPTIONAL_LINK_DANGLING",
  "ROW_COUNT_CONFIRMATION_REQUIRED",
] as const);
export type MaterializationReasonCode = (typeof MATERIALIZATION_REASON_CODE_VALUES)[number];

export const MATERIALIZATION_OPERATION_ERROR_CODE_VALUES = Object.freeze([
  "SNAPSHOT_CONTENT_MISMATCH",
  "SNAPSHOT_SCHEMA_INVALID",
  "MAPPING_CONTRACT_INVALID",
  "MATERIALIZATION_IDEMPOTENCY_CONFLICT",
  "MATERIALIZATION_VALIDATION_FAILED",
  "MATERIALIZATION_CONFIRMATION_REQUIRED",
  "MATERIALIZATION_JOB_FENCED",
  "GENERATION_COMPATIBILITY_INVALID",
  "RUNTIME_PLAN_MISMATCH",
  "CAPACITY_HARD_LIMIT_EXCEEDED",
  "GC_PLAN_STALE",
] as const);
export type MaterializationOperationErrorCode =
  (typeof MATERIALIZATION_OPERATION_ERROR_CODE_VALUES)[number];

const snapshotStates = new Set<SnapshotState>(SNAPSHOT_STATE_VALUES);
const snapshotGroupStates = new Set<SnapshotGroupState>(SNAPSHOT_GROUP_STATE_VALUES);
const materializationJobStates = new Set<MaterializationJobState>(MATERIALIZATION_JOB_STATE_VALUES);
const materializationStages = new Set<MaterializationStage>(MATERIALIZATION_STAGE_VALUES);
const generationStates = new Set<GenerationState>(GENERATION_STATE_VALUES);
const runtimeActivationStates = new Set<RuntimeActivationState>(RUNTIME_ACTIVATION_STATE_VALUES);
const gcPlanStates = new Set<GcPlanState>(GC_PLAN_STATE_VALUES);
const materializationReasonCodes = new Set<MaterializationReasonCode>(
  MATERIALIZATION_REASON_CODE_VALUES,
);

export interface SnapshotColumnDefinition {
  readonly ordinal: number;
  readonly columnApiName: string;
  readonly valueType: PropertyValueType;
  readonly required: boolean;
  readonly caseSensitive?: boolean;
  readonly enumValues?: readonly string[];
  readonly decimalPrecision?: number;
  readonly decimalScale?: number;
}

export const SNAPSHOT_COLUMN_FIELDS = Object.freeze([
  "ordinal",
  "columnApiName",
  "valueType",
  "required",
  "caseSensitive",
  "enumValues",
  "decimalPrecision",
  "decimalScale",
] as const);
export const SNAPSHOT_COLUMN_REQUIRED_FIELDS = Object.freeze([
  "ordinal",
  "columnApiName",
  "valueType",
  "required",
] as const);

export interface SnapshotSchemaDefinition {
  readonly schemaVersion: ContractSchemaVersion;
  readonly contractVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly format: "csv_utf8";
  readonly headerRow: true;
  readonly columns: readonly SnapshotColumnDefinition[];
}

export const SNAPSHOT_SCHEMA_DEFINITION_FIELDS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "format",
  "headerRow",
  "columns",
] as const);

export function parseSnapshotSchemaDefinition(value: unknown): SnapshotSchemaDefinition {
  const path = "$snapshotSchema";
  const record = strictRecord(
    value,
    path,
    SNAPSHOT_SCHEMA_DEFINITION_FIELDS,
    SNAPSHOT_SCHEMA_DEFINITION_FIELDS,
  );
  const columns = requireArray(record.columns, `${path}.columns`, {
    minimumItems: 1,
    maximumItems: 512,
  }).map((column, index) => parseSnapshotColumn(column, `${path}.columns[${index}]`));
  assertSequentialOrdinals(columns, `${path}.columns`);
  assertUnique(
    columns.map((column) => column.columnApiName),
    `${path}.columns`,
  );
  const headerRow = requireBoolean(record.headerRow, `${path}.headerRow`);
  if (!headerRow) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Managed CSV snapshots require a header row.",
      `${path}.headerRow`,
    );
  }
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    contractVersion: requireLiteral(
      record.contractVersion,
      SNAPSHOT_SCHEMA_VERSION,
      `${path}.contractVersion`,
    ),
    format: requireLiteral(record.format, "csv_utf8", `${path}.format`),
    headerRow: true,
    columns: Object.freeze(columns),
  });
}

function parseSnapshotColumn(value: unknown, path: string): SnapshotColumnDefinition {
  const record = strictRecord(value, path, SNAPSHOT_COLUMN_FIELDS, SNAPSHOT_COLUMN_REQUIRED_FIELDS);
  const valueType = requireOneOf(record.valueType, propertyValueTypes, `${path}.valueType`);
  const result: SnapshotColumnDefinition = {
    ordinal: requireSafeInteger(record.ordinal, `${path}.ordinal`, { minimum: 0, maximum: 511 }),
    columnApiName: parseApiName(record.columnApiName, `${path}.columnApiName`),
    valueType,
    required: requireBoolean(record.required, `${path}.required`),
    ...(record.caseSensitive === undefined
      ? {}
      : { caseSensitive: requireBoolean(record.caseSensitive, `${path}.caseSensitive`) }),
    ...(record.enumValues === undefined
      ? {}
      : {
          enumValues: parseSortedStrings(record.enumValues, `${path}.enumValues`, 1, 256),
        }),
    ...(record.decimalPrecision === undefined
      ? {}
      : {
          decimalPrecision: requireSafeInteger(
            record.decimalPrecision,
            `${path}.decimalPrecision`,
            { minimum: 1, maximum: 38 },
          ),
        }),
    ...(record.decimalScale === undefined
      ? {}
      : {
          decimalScale: requireSafeInteger(record.decimalScale, `${path}.decimalScale`, {
            minimum: 0,
            maximum: 38,
          }),
        }),
  };
  assertValueTypeOptions(result, path);
  return Object.freeze(result);
}

export type MappingExpression =
  | MappingColumnExpression
  | MappingConstantExpression
  | MappingCastExpression
  | MappingConcatExpression;

export interface MappingColumnExpression {
  readonly op: "column";
  readonly columnApiName: string;
}

export interface MappingConstantExpression {
  readonly op: "constant";
  readonly literal: string;
}

export interface MappingCastExpression {
  readonly op: "cast";
  readonly input: MappingExpression;
  readonly targetValueType: PropertyValueType;
  readonly codecVersion: typeof VALUE_CODEC_CONTRACT_VERSION;
}

export interface MappingConcatExpression {
  readonly op: "concat";
  readonly inputs: readonly MappingExpression[];
  readonly separator: string;
}

export const MAPPING_EXPRESSION_FIELDS = Object.freeze([
  "op",
  "columnApiName",
  "literal",
  "input",
  "targetValueType",
  "codecVersion",
  "inputs",
  "separator",
] as const);

export interface MappingPropertyDefinition {
  readonly propertyApiName: string;
  readonly required: boolean;
  readonly nullPolicy: "allow" | "reject_row";
  readonly expression: MappingExpression;
}

export const MAPPING_PROPERTY_FIELDS = Object.freeze([
  "propertyApiName",
  "required",
  "nullPolicy",
  "expression",
] as const);

export interface MappingKeyDefinition {
  readonly objectTypeRevisionId: OntosId;
  readonly expression: MappingExpression;
  readonly codecVersion: typeof VALUE_CODEC_CONTRACT_VERSION;
}

export const MAPPING_KEY_FIELDS = Object.freeze([
  "objectTypeRevisionId",
  "expression",
  "codecVersion",
] as const);

export interface MappingQualityRules {
  readonly primaryKeyNullMaximumCount: 0;
  readonly primaryKeyDuplicateMaximumCount: 0;
  readonly requiredPropertyFailureMaximumCount: 0;
  readonly requiredLinkDanglingMaximumCount: 0;
  readonly optionalPropertyFailureMaximumBasisPoints: number;
  readonly optionalLinkDanglingMaximumBasisPoints: number;
  readonly rowCountChangeConfirmationBasisPoints: number;
  readonly optionalFailureDisposition: "reject_row";
}

export const MAPPING_QUALITY_RULE_FIELDS = Object.freeze([
  "primaryKeyNullMaximumCount",
  "primaryKeyDuplicateMaximumCount",
  "requiredPropertyFailureMaximumCount",
  "requiredLinkDanglingMaximumCount",
  "optionalPropertyFailureMaximumBasisPoints",
  "optionalLinkDanglingMaximumBasisPoints",
  "rowCountChangeConfirmationBasisPoints",
  "optionalFailureDisposition",
] as const);

export interface MappingDefinition {
  readonly schemaVersion: ContractSchemaVersion;
  readonly mappingVersion: typeof MAPPING_LANGUAGE_VERSION;
  readonly targetKind: "object" | "link";
  readonly inputSchemaRevisionId: OntosId;
  readonly targetResourceId: OntosId;
  readonly targetRevisionId: OntosId;
  readonly valueCodecVersion: typeof VALUE_CODEC_CONTRACT_VERSION;
  readonly propertyMappings: readonly MappingPropertyDefinition[];
  readonly primaryKeyExpression?: MappingExpression;
  readonly sourceKeyMapping?: MappingKeyDefinition;
  readonly targetKeyMapping?: MappingKeyDefinition;
  /** Absent is the backwards-compatible required policy. */
  readonly linkDanglingDisposition?: "required" | "optional";
  readonly qualityRules: MappingQualityRules;
}

export const MAPPING_DEFINITION_FIELDS = Object.freeze([
  "schemaVersion",
  "mappingVersion",
  "targetKind",
  "inputSchemaRevisionId",
  "targetResourceId",
  "targetRevisionId",
  "valueCodecVersion",
  "propertyMappings",
  "primaryKeyExpression",
  "sourceKeyMapping",
  "targetKeyMapping",
  "linkDanglingDisposition",
  "qualityRules",
] as const);
export const MAPPING_DEFINITION_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "mappingVersion",
  "targetKind",
  "inputSchemaRevisionId",
  "targetResourceId",
  "targetRevisionId",
  "valueCodecVersion",
  "propertyMappings",
  "qualityRules",
] as const);

export function parseMappingDefinition(value: unknown): MappingDefinition {
  const path = "$mapping";
  const record = strictRecord(
    value,
    path,
    MAPPING_DEFINITION_FIELDS,
    MAPPING_DEFINITION_REQUIRED_FIELDS,
  );
  const targetKind = requireOneOf(
    record.targetKind,
    new Set(["object", "link"] as const),
    `${path}.targetKind`,
  );
  const budget = { remaining: 64 };
  const propertyMappings = requireArray(record.propertyMappings, `${path}.propertyMappings`, {
    maximumItems: 256,
  }).map((mapping, index) =>
    parseMappingProperty(mapping, `${path}.propertyMappings[${index}]`, budget),
  );
  assertSortedUnique(
    propertyMappings.map((mapping) => mapping.propertyApiName),
    `${path}.propertyMappings`,
  );
  const common = {
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    mappingVersion: requireLiteral(
      record.mappingVersion,
      MAPPING_LANGUAGE_VERSION,
      `${path}.mappingVersion`,
    ),
    targetKind,
    inputSchemaRevisionId: parseOntosId(
      record.inputSchemaRevisionId,
      `${path}.inputSchemaRevisionId`,
    ),
    targetResourceId: parseOntosId(record.targetResourceId, `${path}.targetResourceId`),
    targetRevisionId: parseOntosId(record.targetRevisionId, `${path}.targetRevisionId`),
    valueCodecVersion: requireLiteral(
      record.valueCodecVersion,
      VALUE_CODEC_CONTRACT_VERSION,
      `${path}.valueCodecVersion`,
    ),
    propertyMappings: Object.freeze(propertyMappings),
    qualityRules: parseMappingQualityRules(record.qualityRules, `${path}.qualityRules`),
  } as const;
  if (targetKind === "object") {
    requireAbsent(record.sourceKeyMapping, `${path}.sourceKeyMapping`);
    requireAbsent(record.targetKeyMapping, `${path}.targetKeyMapping`);
    requireAbsent(record.linkDanglingDisposition, `${path}.linkDanglingDisposition`);
    if (record.primaryKeyExpression === undefined) {
      failContract(
        "CONTRACT_FIELD_MISSING",
        "Object Mapping requires primaryKeyExpression.",
        `${path}.primaryKeyExpression`,
      );
    }
    return Object.freeze({
      ...common,
      primaryKeyExpression: parseMappingExpression(
        record.primaryKeyExpression,
        `${path}.primaryKeyExpression`,
        0,
        budget,
      ),
    });
  }
  requireAbsent(record.primaryKeyExpression, `${path}.primaryKeyExpression`);
  if (record.sourceKeyMapping === undefined || record.targetKeyMapping === undefined) {
    failContract(
      "CONTRACT_FIELD_MISSING",
      "Link Mapping requires both endpoint Key Mappings.",
      path,
    );
  }
  return Object.freeze({
    ...common,
    sourceKeyMapping: parseMappingKey(record.sourceKeyMapping, `${path}.sourceKeyMapping`, budget),
    targetKeyMapping: parseMappingKey(record.targetKeyMapping, `${path}.targetKeyMapping`, budget),
    ...(record.linkDanglingDisposition === undefined
      ? {}
      : {
          linkDanglingDisposition: requireOneOf(
            record.linkDanglingDisposition,
            new Set(["required", "optional"] as const),
            `${path}.linkDanglingDisposition`,
          ),
        }),
  });
}

function parseMappingExpression(
  value: unknown,
  path: string,
  depth: number,
  budget: { remaining: number },
): MappingExpression {
  budget.remaining -= 1;
  if (budget.remaining < 0 || depth > 8) {
    failContract("CONTRACT_VALUE_OUT_OF_RANGE", "Mapping expression exceeds its limit.", path);
  }
  const record = requirePlainRecord(value, path);
  const op = requireOneOf(
    record.op,
    new Set(["column", "constant", "cast", "concat"] as const),
    `${path}.op`,
  );
  if (op === "column") {
    requireObjectShape(record, ["op", "columnApiName"], ["op", "columnApiName"], path);
    return Object.freeze({
      op,
      columnApiName: parseApiName(record.columnApiName, `${path}.columnApiName`),
    });
  }
  if (op === "constant") {
    requireObjectShape(record, ["op", "literal"], ["op", "literal"], path);
    return Object.freeze({
      op,
      literal: requireString(record.literal, `${path}.literal`, {
        minimumLength: 0,
        maximumLength: 4096,
      }),
    });
  }
  if (op === "cast") {
    requireObjectShape(
      record,
      ["op", "input", "targetValueType", "codecVersion"],
      ["op", "input", "targetValueType", "codecVersion"],
      path,
    );
    return Object.freeze({
      op,
      input: parseMappingExpression(record.input, `${path}.input`, depth + 1, budget),
      targetValueType: requireOneOf(
        record.targetValueType,
        propertyValueTypes,
        `${path}.targetValueType`,
      ),
      codecVersion: requireLiteral(
        record.codecVersion,
        VALUE_CODEC_CONTRACT_VERSION,
        `${path}.codecVersion`,
      ),
    });
  }
  requireObjectShape(record, ["op", "inputs", "separator"], ["op", "inputs", "separator"], path);
  const inputs = requireArray(record.inputs, `${path}.inputs`, {
    minimumItems: 1,
    maximumItems: 16,
  }).map((input, index) =>
    parseMappingExpression(input, `${path}.inputs[${index}]`, depth + 1, budget),
  );
  return Object.freeze({
    op,
    inputs: Object.freeze(inputs),
    separator: requireString(record.separator, `${path}.separator`, {
      minimumLength: 0,
      maximumLength: 64,
    }),
  });
}

function parseMappingProperty(
  value: unknown,
  path: string,
  budget: { remaining: number },
): MappingPropertyDefinition {
  const record = strictRecord(value, path, MAPPING_PROPERTY_FIELDS, MAPPING_PROPERTY_FIELDS);
  const required = requireBoolean(record.required, `${path}.required`);
  const nullPolicy = requireOneOf(
    record.nullPolicy,
    new Set(["allow", "reject_row"] as const),
    `${path}.nullPolicy`,
  );
  if (required && nullPolicy !== "reject_row") {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Required Property nulls must reject the whole row.",
      `${path}.nullPolicy`,
    );
  }
  return Object.freeze({
    propertyApiName: parseApiName(record.propertyApiName, `${path}.propertyApiName`),
    required,
    nullPolicy,
    expression: parseMappingExpression(record.expression, `${path}.expression`, 0, budget),
  });
}

function parseMappingKey(
  value: unknown,
  path: string,
  budget: { remaining: number },
): MappingKeyDefinition {
  const record = strictRecord(value, path, MAPPING_KEY_FIELDS, MAPPING_KEY_FIELDS);
  return Object.freeze({
    objectTypeRevisionId: parseOntosId(record.objectTypeRevisionId, `${path}.objectTypeRevisionId`),
    expression: parseMappingExpression(record.expression, `${path}.expression`, 0, budget),
    codecVersion: requireLiteral(
      record.codecVersion,
      VALUE_CODEC_CONTRACT_VERSION,
      `${path}.codecVersion`,
    ),
  });
}

function parseMappingQualityRules(value: unknown, path: string): MappingQualityRules {
  const record = strictRecord(
    value,
    path,
    MAPPING_QUALITY_RULE_FIELDS,
    MAPPING_QUALITY_RULE_FIELDS,
  );
  return Object.freeze({
    primaryKeyNullMaximumCount: requireZero(
      record.primaryKeyNullMaximumCount,
      `${path}.primaryKeyNullMaximumCount`,
    ),
    primaryKeyDuplicateMaximumCount: requireZero(
      record.primaryKeyDuplicateMaximumCount,
      `${path}.primaryKeyDuplicateMaximumCount`,
    ),
    requiredPropertyFailureMaximumCount: requireZero(
      record.requiredPropertyFailureMaximumCount,
      `${path}.requiredPropertyFailureMaximumCount`,
    ),
    requiredLinkDanglingMaximumCount: requireZero(
      record.requiredLinkDanglingMaximumCount,
      `${path}.requiredLinkDanglingMaximumCount`,
    ),
    optionalPropertyFailureMaximumBasisPoints: requireSafeInteger(
      record.optionalPropertyFailureMaximumBasisPoints,
      `${path}.optionalPropertyFailureMaximumBasisPoints`,
      { minimum: 0, maximum: 10_000 },
    ),
    optionalLinkDanglingMaximumBasisPoints: requireSafeInteger(
      record.optionalLinkDanglingMaximumBasisPoints,
      `${path}.optionalLinkDanglingMaximumBasisPoints`,
      { minimum: 0, maximum: 10_000 },
    ),
    rowCountChangeConfirmationBasisPoints: requireSafeInteger(
      record.rowCountChangeConfirmationBasisPoints,
      `${path}.rowCountChangeConfirmationBasisPoints`,
      { minimum: 1, maximum: 10_000 },
    ),
    optionalFailureDisposition: requireLiteral(
      record.optionalFailureDisposition,
      "reject_row",
      `${path}.optionalFailureDisposition`,
    ),
  });
}

export interface SnapshotFileContract {
  readonly fileId: OntosId;
  readonly managedArtifactId: OntosId;
  readonly ordinal: number;
  readonly contentDigest: ArtifactDigest;
  readonly byteCount: number;
  readonly rowCount: number;
}

export const SNAPSHOT_FILE_FIELDS = Object.freeze([
  "fileId",
  "managedArtifactId",
  "ordinal",
  "contentDigest",
  "byteCount",
  "rowCount",
] as const);

export interface DatasetSnapshotContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly contractVersion: "dataset-snapshot-v1";
  readonly snapshotId: OntosId;
  readonly projectId: OntosId;
  readonly snapshotGroupId: OntosId;
  readonly groupVersion: number;
  readonly targetMemberKey: string;
  readonly targetRevisionId: OntosId;
  readonly snapshotSchemaRevisionId: OntosId;
  readonly mappingRevisionId: OntosId;
  readonly runtimePlanDigest: ArtifactDigest;
  readonly contentDigest: ArtifactDigest;
  readonly byteCount: number;
  readonly rowCount: number;
  readonly files: readonly SnapshotFileContract[];
  readonly previousSnapshotId?: OntosId;
  readonly state: SnapshotState;
  readonly registeredAt: CanonicalInstant;
  readonly snapshotDigest: ArtifactDigest;
}

export const DATASET_SNAPSHOT_FIELDS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "snapshotId",
  "projectId",
  "snapshotGroupId",
  "groupVersion",
  "targetMemberKey",
  "targetRevisionId",
  "snapshotSchemaRevisionId",
  "mappingRevisionId",
  "runtimePlanDigest",
  "contentDigest",
  "byteCount",
  "rowCount",
  "files",
  "previousSnapshotId",
  "state",
  "registeredAt",
  "snapshotDigest",
] as const);
export const DATASET_SNAPSHOT_REQUIRED_FIELDS = Object.freeze(
  DATASET_SNAPSHOT_FIELDS.filter((field) => field !== "previousSnapshotId"),
);

export function parseDatasetSnapshot(value: unknown): DatasetSnapshotContract {
  const path = "$datasetSnapshot";
  const record = strictRecord(
    value,
    path,
    DATASET_SNAPSHOT_FIELDS,
    DATASET_SNAPSHOT_REQUIRED_FIELDS,
  );
  const files = requireArray(record.files, `${path}.files`, {
    minimumItems: 1,
    maximumItems: 1024,
  }).map((file, index) => parseSnapshotFile(file, `${path}.files[${index}]`));
  assertSequentialOrdinals(files, `${path}.files`);
  assertUnique(
    files.map((file) => file.fileId),
    `${path}.files`,
  );
  const byteCount = requireSafeInteger(record.byteCount, `${path}.byteCount`, { minimum: 0 });
  const rowCount = requireSafeInteger(record.rowCount, `${path}.rowCount`, { minimum: 0 });
  const fileByteCount = safeIntegerSum(
    files.map((file) => file.byteCount),
    `${path}.files`,
  );
  const fileRowCount = safeIntegerSum(
    files.map((file) => file.rowCount),
    `${path}.files`,
  );
  if (fileByteCount !== byteCount || fileRowCount !== rowCount) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Snapshot totals must equal the immutable file totals.",
      `${path}.files`,
    );
  }
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    contractVersion: requireLiteral(
      record.contractVersion,
      "dataset-snapshot-v1",
      `${path}.contractVersion`,
    ),
    snapshotId: parseOntosId(record.snapshotId, `${path}.snapshotId`),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    snapshotGroupId: parseOntosId(record.snapshotGroupId, `${path}.snapshotGroupId`),
    groupVersion: requireSafeInteger(record.groupVersion, `${path}.groupVersion`, {
      minimum: 1,
    }),
    targetMemberKey: parseMemberKey(record.targetMemberKey, `${path}.targetMemberKey`),
    targetRevisionId: parseOntosId(record.targetRevisionId, `${path}.targetRevisionId`),
    snapshotSchemaRevisionId: parseOntosId(
      record.snapshotSchemaRevisionId,
      `${path}.snapshotSchemaRevisionId`,
    ),
    mappingRevisionId: parseOntosId(record.mappingRevisionId, `${path}.mappingRevisionId`),
    runtimePlanDigest: parseArtifactDigest(record.runtimePlanDigest, `${path}.runtimePlanDigest`),
    contentDigest: parseArtifactDigest(record.contentDigest, `${path}.contentDigest`),
    byteCount,
    rowCount,
    files: Object.freeze(files),
    ...(record.previousSnapshotId === undefined
      ? {}
      : {
          previousSnapshotId: parseOntosId(record.previousSnapshotId, `${path}.previousSnapshotId`),
        }),
    state: requireOneOf(record.state, snapshotStates, `${path}.state`),
    registeredAt: parseCanonicalInstant(record.registeredAt, `${path}.registeredAt`),
    snapshotDigest: parseArtifactDigest(record.snapshotDigest, `${path}.snapshotDigest`),
  });
}

function parseSnapshotFile(value: unknown, path: string): SnapshotFileContract {
  const record = strictRecord(value, path, SNAPSHOT_FILE_FIELDS, SNAPSHOT_FILE_FIELDS);
  return Object.freeze({
    fileId: parseOntosId(record.fileId, `${path}.fileId`),
    managedArtifactId: parseOntosId(record.managedArtifactId, `${path}.managedArtifactId`),
    ordinal: requireSafeInteger(record.ordinal, `${path}.ordinal`, {
      minimum: 0,
      maximum: 1023,
    }),
    contentDigest: parseArtifactDigest(record.contentDigest, `${path}.contentDigest`),
    byteCount: requireSafeInteger(record.byteCount, `${path}.byteCount`, { minimum: 0 }),
    rowCount: requireSafeInteger(record.rowCount, `${path}.rowCount`, { minimum: 0 }),
  });
}

export interface SnapshotGroupMemberContract {
  readonly memberKey: string;
  readonly memberKind: "object" | "link";
  readonly snapshotId: OntosId;
  readonly targetRevisionId: OntosId;
}

export const SNAPSHOT_GROUP_MEMBER_FIELDS = Object.freeze([
  "memberKey",
  "memberKind",
  "snapshotId",
  "targetRevisionId",
] as const);

export interface SnapshotGroupContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly contractVersion: "snapshot-group-v1";
  readonly snapshotGroupId: OntosId;
  readonly projectId: OntosId;
  readonly groupVersion: number;
  readonly state: SnapshotGroupState;
  readonly members: readonly SnapshotGroupMemberContract[];
  readonly groupDigest: ArtifactDigest;
  readonly createdAt: CanonicalInstant;
}

export const SNAPSHOT_GROUP_FIELDS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "snapshotGroupId",
  "projectId",
  "groupVersion",
  "state",
  "members",
  "groupDigest",
  "createdAt",
] as const);

export function parseSnapshotGroup(value: unknown): SnapshotGroupContract {
  const path = "$snapshotGroup";
  const record = strictRecord(value, path, SNAPSHOT_GROUP_FIELDS, SNAPSHOT_GROUP_FIELDS);
  const members = requireArray(record.members, `${path}.members`, {
    minimumItems: 1,
    maximumItems: 256,
  }).map((member, index) => parseSnapshotGroupMember(member, `${path}.members[${index}]`));
  assertSortedUnique(
    members.map((member) => member.memberKey),
    `${path}.members`,
  );
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    contractVersion: requireLiteral(
      record.contractVersion,
      "snapshot-group-v1",
      `${path}.contractVersion`,
    ),
    snapshotGroupId: parseOntosId(record.snapshotGroupId, `${path}.snapshotGroupId`),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    groupVersion: requireSafeInteger(record.groupVersion, `${path}.groupVersion`, {
      minimum: 1,
    }),
    state: requireOneOf(record.state, snapshotGroupStates, `${path}.state`),
    members: Object.freeze(members),
    groupDigest: parseArtifactDigest(record.groupDigest, `${path}.groupDigest`),
    createdAt: parseCanonicalInstant(record.createdAt, `${path}.createdAt`),
  });
}

function parseSnapshotGroupMember(value: unknown, path: string): SnapshotGroupMemberContract {
  const record = strictRecord(
    value,
    path,
    SNAPSHOT_GROUP_MEMBER_FIELDS,
    SNAPSHOT_GROUP_MEMBER_FIELDS,
  );
  const memberKey = parseMemberKey(record.memberKey, `${path}.memberKey`);
  const memberKind = requireOneOf(
    record.memberKind,
    new Set(["object", "link"] as const),
    `${path}.memberKind`,
  );
  if (!memberKey.startsWith(`${memberKind}:`)) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Member Key prefix must match Member Kind.",
      `${path}.memberKey`,
    );
  }
  return Object.freeze({
    memberKey,
    memberKind,
    snapshotId: parseOntosId(record.snapshotId, `${path}.snapshotId`),
    targetRevisionId: parseOntosId(record.targetRevisionId, `${path}.targetRevisionId`),
  });
}

export interface MaterializationCheckpointContract {
  readonly attemptId: OntosId;
  readonly fencingToken: string;
  readonly sequence: number;
  readonly stage: MaterializationStage;
  readonly outputDigest: ArtifactDigest;
}

export const MATERIALIZATION_CHECKPOINT_FIELDS = Object.freeze([
  "attemptId",
  "fencingToken",
  "sequence",
  "stage",
  "outputDigest",
] as const);

export interface MaterializationJobContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly contractVersion: "materialization-job-v1";
  readonly jobId: OntosId;
  readonly projectId: OntosId;
  readonly snapshotGroupId: OntosId;
  readonly idempotencyKey: IdempotencyKey;
  readonly inputDigest: ArtifactDigest;
  readonly state: MaterializationJobState;
  readonly currentStage?: MaterializationStage;
  readonly attemptCount: number;
  readonly checkpoint?: MaterializationCheckpointContract;
  readonly createdAt: CanonicalInstant;
  readonly updatedAt: CanonicalInstant;
}

export const MATERIALIZATION_JOB_FIELDS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "jobId",
  "projectId",
  "snapshotGroupId",
  "idempotencyKey",
  "inputDigest",
  "state",
  "currentStage",
  "attemptCount",
  "checkpoint",
  "createdAt",
  "updatedAt",
] as const);
export const MATERIALIZATION_JOB_REQUIRED_FIELDS = Object.freeze(
  MATERIALIZATION_JOB_FIELDS.filter((field) => field !== "currentStage" && field !== "checkpoint"),
);

export function parseMaterializationJob(value: unknown): MaterializationJobContract {
  const path = "$materializationJob";
  const record = strictRecord(
    value,
    path,
    MATERIALIZATION_JOB_FIELDS,
    MATERIALIZATION_JOB_REQUIRED_FIELDS,
  );
  const state = requireOneOf(record.state, materializationJobStates, `${path}.state`);
  const currentStage =
    record.currentStage === undefined
      ? undefined
      : requireOneOf(record.currentStage, materializationStages, `${path}.currentStage`);
  const checkpoint =
    record.checkpoint === undefined
      ? undefined
      : parseMaterializationCheckpoint(record.checkpoint, `${path}.checkpoint`);
  const attemptCount = requireSafeInteger(record.attemptCount, `${path}.attemptCount`, {
    minimum: 0,
    maximum: 1_000_000,
  });
  const createdAt = parseCanonicalInstant(record.createdAt, `${path}.createdAt`);
  const updatedAt = parseCanonicalInstant(record.updatedAt, `${path}.updatedAt`);
  if (updatedAt < createdAt) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Materialization Job updatedAt cannot precede createdAt.",
      `${path}.updatedAt`,
    );
  }
  if (state === "queued" && (currentStage !== undefined || checkpoint !== undefined)) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "A queued Materialization Job cannot claim stage progress.",
      path,
    );
  }
  if (
    new Set<MaterializationJobState>(["running", "retry_wait", "succeeded", "dead_letter"]).has(
      state,
    ) &&
    (currentStage === undefined || attemptCount < 1)
  ) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "An attempted Materialization Job requires a current stage and attempt count.",
      path,
    );
  }
  if (checkpoint !== undefined) {
    if (attemptCount < 1 || currentStage === undefined) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "A Checkpoint requires an attempted Job and current stage.",
        `${path}.checkpoint`,
      );
    }
    if (
      MATERIALIZATION_STAGE_VALUES.indexOf(checkpoint.stage) >
      MATERIALIZATION_STAGE_VALUES.indexOf(currentStage)
    ) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "A Checkpoint cannot be ahead of the current Job stage.",
        `${path}.checkpoint.stage`,
      );
    }
  }
  if (state === "succeeded" && (currentStage !== "activate" || checkpoint?.stage !== "activate")) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "A succeeded Materialization Job requires an activate Checkpoint.",
      path,
    );
  }
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    contractVersion: requireLiteral(
      record.contractVersion,
      "materialization-job-v1",
      `${path}.contractVersion`,
    ),
    jobId: parseOntosId(record.jobId, `${path}.jobId`),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    snapshotGroupId: parseOntosId(record.snapshotGroupId, `${path}.snapshotGroupId`),
    idempotencyKey: parseIdempotencyKey(record.idempotencyKey, `${path}.idempotencyKey`),
    inputDigest: parseArtifactDigest(record.inputDigest, `${path}.inputDigest`),
    state,
    ...(currentStage === undefined ? {} : { currentStage }),
    attemptCount,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    createdAt,
    updatedAt,
  });
}

function parseMaterializationCheckpoint(
  value: unknown,
  path: string,
): MaterializationCheckpointContract {
  const record = strictRecord(
    value,
    path,
    MATERIALIZATION_CHECKPOINT_FIELDS,
    MATERIALIZATION_CHECKPOINT_FIELDS,
  );
  return Object.freeze({
    attemptId: parseOntosId(record.attemptId, `${path}.attemptId`),
    fencingToken: requireString(record.fencingToken, `${path}.fencingToken`, {
      pattern: positiveBigintTextExpression,
    }),
    sequence: requireSafeInteger(record.sequence, `${path}.sequence`, { minimum: 1 }),
    stage: requireOneOf(record.stage, materializationStages, `${path}.stage`),
    outputDigest: parseArtifactDigest(record.outputDigest, `${path}.outputDigest`),
  });
}

export interface MaterializationReasonCountContract {
  readonly code: MaterializationReasonCode;
  readonly count: number;
}

export const MATERIALIZATION_REASON_COUNT_FIELDS = Object.freeze(["code", "count"] as const);

export interface MaterializationErrorSampleContract {
  readonly code: MaterializationReasonCode;
  readonly fileId: OntosId;
  readonly rowNumber: number;
  readonly fingerprint: ArtifactDigest;
}

export const MATERIALIZATION_ERROR_SAMPLE_FIELDS = Object.freeze([
  "code",
  "fileId",
  "rowNumber",
  "fingerprint",
] as const);

export interface MaterializationReportContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly contractVersion: "materialization-report-v1";
  readonly reportId: OntosId;
  readonly projectId: OntosId;
  readonly snapshotGroupId: OntosId;
  readonly jobId: OntosId;
  readonly outcome: "passed" | "awaiting_confirmation" | "failed";
  readonly totalRows: number;
  readonly acceptedRows: number;
  readonly rejectedRows: number;
  readonly reasonCounts: readonly MaterializationReasonCountContract[];
  readonly errorSamples: readonly MaterializationErrorSampleContract[];
  readonly validatorVersion: string;
  readonly reportDigest: ArtifactDigest;
  readonly createdAt: CanonicalInstant;
}

export const MATERIALIZATION_REPORT_FIELDS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "reportId",
  "projectId",
  "snapshotGroupId",
  "jobId",
  "outcome",
  "totalRows",
  "acceptedRows",
  "rejectedRows",
  "reasonCounts",
  "errorSamples",
  "validatorVersion",
  "reportDigest",
  "createdAt",
] as const);

export function parseMaterializationReport(value: unknown): MaterializationReportContract {
  const path = "$materializationReport";
  const record = strictRecord(
    value,
    path,
    MATERIALIZATION_REPORT_FIELDS,
    MATERIALIZATION_REPORT_FIELDS,
  );
  const totalRows = requireSafeInteger(record.totalRows, `${path}.totalRows`, { minimum: 0 });
  const acceptedRows = requireSafeInteger(record.acceptedRows, `${path}.acceptedRows`, {
    minimum: 0,
  });
  const rejectedRows = requireSafeInteger(record.rejectedRows, `${path}.rejectedRows`, {
    minimum: 0,
  });
  if (safeIntegerSum([acceptedRows, rejectedRows], path) !== totalRows) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Accepted and rejected rows must equal total rows.",
      path,
    );
  }
  const reasonCounts = requireArray(record.reasonCounts, `${path}.reasonCounts`, {
    maximumItems: MATERIALIZATION_REASON_CODE_VALUES.length,
  }).map((entry, index) => parseReasonCount(entry, `${path}.reasonCounts[${index}]`));
  assertSortedUnique(
    reasonCounts.map((entry) => entry.code),
    `${path}.reasonCounts`,
  );
  const rejectedReasonCount = safeIntegerSum(
    reasonCounts
      .filter((entry) => entry.code !== "ROW_COUNT_CONFIRMATION_REQUIRED")
      .map((entry) => entry.count),
    `${path}.reasonCounts`,
  );
  if (rejectedReasonCount !== rejectedRows) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Row-rejection reason counts must equal rejected rows.",
      `${path}.reasonCounts`,
    );
  }
  const errorSamples = requireArray(record.errorSamples, `${path}.errorSamples`, {
    maximumItems: 50,
  }).map((entry, index) => parseErrorSample(entry, `${path}.errorSamples[${index}]`));
  const outcome = requireOneOf(
    record.outcome,
    new Set(["passed", "awaiting_confirmation", "failed"] as const),
    `${path}.outcome`,
  );
  const codes = new Set(reasonCounts.map((entry) => entry.code));
  const fatalCodes = new Set<MaterializationReasonCode>([
    "PRIMARY_KEY_NULL",
    "PRIMARY_KEY_DUPLICATE",
    "REQUIRED_PROPERTY_INVALID",
    "REQUIRED_LINK_DANGLING",
  ]);
  const hasFatalReason = reasonCounts.some((entry) => fatalCodes.has(entry.code));
  if (outcome === "passed" && (hasFatalReason || codes.has("ROW_COUNT_CONFIRMATION_REQUIRED"))) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "A passed Report cannot contain a fatal or confirmation reason.",
      `${path}.outcome`,
    );
  }
  if (outcome === "awaiting_confirmation" && !codes.has("ROW_COUNT_CONFIRMATION_REQUIRED")) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Awaiting confirmation requires the row-count reason.",
      `${path}.outcome`,
    );
  }
  if (outcome === "awaiting_confirmation" && hasFatalReason) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "A fatal data-quality reason must fail rather than await confirmation.",
      `${path}.outcome`,
    );
  }
  const hasRowRejection = reasonCounts.some(
    (entry) => entry.code !== "ROW_COUNT_CONFIRMATION_REQUIRED",
  );
  if (outcome === "failed" && !hasRowRejection) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "A failed Report requires a stable row-rejection reason.",
      `${path}.reasonCounts`,
    );
  }
  for (const [index, sample] of errorSamples.entries()) {
    if (!codes.has(sample.code) || sample.code === "ROW_COUNT_CONFIRMATION_REQUIRED") {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "Every error sample must reference a row-level aggregated reason.",
        `${path}.errorSamples[${index}].code`,
      );
    }
  }
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    contractVersion: requireLiteral(
      record.contractVersion,
      "materialization-report-v1",
      `${path}.contractVersion`,
    ),
    reportId: parseOntosId(record.reportId, `${path}.reportId`),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    snapshotGroupId: parseOntosId(record.snapshotGroupId, `${path}.snapshotGroupId`),
    jobId: parseOntosId(record.jobId, `${path}.jobId`),
    outcome,
    totalRows,
    acceptedRows,
    rejectedRows,
    reasonCounts: Object.freeze(reasonCounts),
    errorSamples: Object.freeze(errorSamples),
    validatorVersion: parseVersion(record.validatorVersion, `${path}.validatorVersion`),
    reportDigest: parseArtifactDigest(record.reportDigest, `${path}.reportDigest`),
    createdAt: parseCanonicalInstant(record.createdAt, `${path}.createdAt`),
  });
}

function parseReasonCount(value: unknown, path: string): MaterializationReasonCountContract {
  const record = strictRecord(
    value,
    path,
    MATERIALIZATION_REASON_COUNT_FIELDS,
    MATERIALIZATION_REASON_COUNT_FIELDS,
  );
  return Object.freeze({
    code: requireOneOf(record.code, materializationReasonCodes, `${path}.code`),
    count: requireSafeInteger(record.count, `${path}.count`, { minimum: 1 }),
  });
}

function parseErrorSample(value: unknown, path: string): MaterializationErrorSampleContract {
  const record = strictRecord(
    value,
    path,
    MATERIALIZATION_ERROR_SAMPLE_FIELDS,
    MATERIALIZATION_ERROR_SAMPLE_FIELDS,
  );
  return Object.freeze({
    code: requireOneOf(record.code, materializationReasonCodes, `${path}.code`),
    fileId: parseOntosId(record.fileId, `${path}.fileId`),
    rowNumber: requireSafeInteger(record.rowNumber, `${path}.rowNumber`, { minimum: 1 }),
    fingerprint: parseArtifactDigest(record.fingerprint, `${path}.fingerprint`),
  });
}

export interface GenerationContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly contractVersion: "generation-v1";
  readonly generationId: OntosId;
  readonly projectId: OntosId;
  readonly memberKey: string;
  readonly targetRevisionId: OntosId;
  readonly snapshotGroupId: OntosId;
  readonly groupVersion: number;
  readonly snapshotSchemaRevisionId: OntosId;
  readonly mappingRevisionId: OntosId;
  readonly runtimePlanDigest: ArtifactDigest;
  readonly indexPlanDigest: ArtifactDigest;
  readonly reportDigest: ArtifactDigest;
  readonly state: GenerationState;
  readonly generationDigest: ArtifactDigest;
  readonly createdAt: CanonicalInstant;
}

export const GENERATION_FIELDS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "generationId",
  "projectId",
  "memberKey",
  "targetRevisionId",
  "snapshotGroupId",
  "groupVersion",
  "snapshotSchemaRevisionId",
  "mappingRevisionId",
  "runtimePlanDigest",
  "indexPlanDigest",
  "reportDigest",
  "state",
  "generationDigest",
  "createdAt",
] as const);

export function parseGeneration(value: unknown): GenerationContract {
  const path = "$generation";
  const record = strictRecord(value, path, GENERATION_FIELDS, GENERATION_FIELDS);
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    contractVersion: requireLiteral(
      record.contractVersion,
      "generation-v1",
      `${path}.contractVersion`,
    ),
    generationId: parseOntosId(record.generationId, `${path}.generationId`),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    memberKey: parseMemberKey(record.memberKey, `${path}.memberKey`),
    targetRevisionId: parseOntosId(record.targetRevisionId, `${path}.targetRevisionId`),
    snapshotGroupId: parseOntosId(record.snapshotGroupId, `${path}.snapshotGroupId`),
    groupVersion: requireSafeInteger(record.groupVersion, `${path}.groupVersion`, {
      minimum: 1,
    }),
    snapshotSchemaRevisionId: parseOntosId(
      record.snapshotSchemaRevisionId,
      `${path}.snapshotSchemaRevisionId`,
    ),
    mappingRevisionId: parseOntosId(record.mappingRevisionId, `${path}.mappingRevisionId`),
    runtimePlanDigest: parseArtifactDigest(record.runtimePlanDigest, `${path}.runtimePlanDigest`),
    indexPlanDigest: parseArtifactDigest(record.indexPlanDigest, `${path}.indexPlanDigest`),
    reportDigest: parseArtifactDigest(record.reportDigest, `${path}.reportDigest`),
    state: requireOneOf(record.state, generationStates, `${path}.state`),
    generationDigest: parseArtifactDigest(record.generationDigest, `${path}.generationDigest`),
    createdAt: parseCanonicalInstant(record.createdAt, `${path}.createdAt`),
  });
}

export interface RuntimeMemberPlanEntryContract {
  readonly memberKey: string;
  readonly memberKind: "object" | "link";
  readonly targetResourceId: OntosId;
  readonly targetRevisionId: OntosId;
  readonly snapshotSchemaRevisionId: OntosId;
  readonly mappingRevisionId: OntosId;
  readonly snapshotGroupId: OntosId;
  readonly indexPlanDigest: ArtifactDigest;
}

export const RUNTIME_MEMBER_PLAN_ENTRY_FIELDS = Object.freeze([
  "memberKey",
  "memberKind",
  "targetResourceId",
  "targetRevisionId",
  "snapshotSchemaRevisionId",
  "mappingRevisionId",
  "snapshotGroupId",
  "indexPlanDigest",
] as const);

export interface RuntimeMemberPlanContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly contractVersion: "runtime-member-plan-v1";
  readonly projectId: OntosId;
  readonly releaseId: OntosId;
  readonly members: readonly RuntimeMemberPlanEntryContract[];
  readonly planDigest: ArtifactDigest;
}

export const RUNTIME_MEMBER_PLAN_FIELDS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "projectId",
  "releaseId",
  "members",
  "planDigest",
] as const);

export function parseRuntimeMemberPlan(value: unknown): RuntimeMemberPlanContract {
  const path = "$runtimeMemberPlan";
  const record = strictRecord(value, path, RUNTIME_MEMBER_PLAN_FIELDS, RUNTIME_MEMBER_PLAN_FIELDS);
  const members = requireArray(record.members, `${path}.members`, {
    maximumItems: 256,
  }).map((member, index) => parseRuntimeMemberPlanEntry(member, `${path}.members[${index}]`));
  assertSortedUnique(
    members.map((member) => member.memberKey),
    `${path}.members`,
  );
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    contractVersion: requireLiteral(
      record.contractVersion,
      "runtime-member-plan-v1",
      `${path}.contractVersion`,
    ),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    releaseId: parseOntosId(record.releaseId, `${path}.releaseId`),
    members: Object.freeze(members),
    planDigest: parseArtifactDigest(record.planDigest, `${path}.planDigest`),
  });
}

function parseRuntimeMemberPlanEntry(value: unknown, path: string): RuntimeMemberPlanEntryContract {
  const record = strictRecord(
    value,
    path,
    RUNTIME_MEMBER_PLAN_ENTRY_FIELDS,
    RUNTIME_MEMBER_PLAN_ENTRY_FIELDS,
  );
  const memberKey = parseMemberKey(record.memberKey, `${path}.memberKey`);
  const memberKind = requireOneOf(
    record.memberKind,
    new Set(["object", "link"] as const),
    `${path}.memberKind`,
  );
  if (!memberKey.startsWith(`${memberKind}:`)) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Member Key prefix must match Member Kind.",
      `${path}.memberKey`,
    );
  }
  return Object.freeze({
    memberKey,
    memberKind,
    targetResourceId: parseOntosId(record.targetResourceId, `${path}.targetResourceId`),
    targetRevisionId: parseOntosId(record.targetRevisionId, `${path}.targetRevisionId`),
    snapshotSchemaRevisionId: parseOntosId(
      record.snapshotSchemaRevisionId,
      `${path}.snapshotSchemaRevisionId`,
    ),
    mappingRevisionId: parseOntosId(record.mappingRevisionId, `${path}.mappingRevisionId`),
    snapshotGroupId: parseOntosId(record.snapshotGroupId, `${path}.snapshotGroupId`),
    indexPlanDigest: parseArtifactDigest(record.indexPlanDigest, `${path}.indexPlanDigest`),
  });
}

export interface RuntimeActivationMemberContract {
  readonly memberKey: string;
  readonly generationId: OntosId;
  readonly snapshotId: OntosId;
  readonly snapshotGroupId: OntosId;
  readonly groupVersion: number;
  readonly certificateId: OntosId;
}

export const RUNTIME_ACTIVATION_MEMBER_FIELDS = Object.freeze([
  "memberKey",
  "generationId",
  "snapshotId",
  "snapshotGroupId",
  "groupVersion",
  "certificateId",
] as const);

export interface RuntimeActivationContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly contractVersion: "runtime-activation-v1";
  readonly activationId: OntosId;
  readonly projectId: OntosId;
  readonly releaseId: OntosId;
  readonly runtimePlanDigest: ArtifactDigest;
  readonly state: RuntimeActivationState;
  readonly members: readonly RuntimeActivationMemberContract[];
  readonly activationDigest: ArtifactDigest;
  readonly createdAt: CanonicalInstant;
}

export const RUNTIME_ACTIVATION_FIELDS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "activationId",
  "projectId",
  "releaseId",
  "runtimePlanDigest",
  "state",
  "members",
  "activationDigest",
  "createdAt",
] as const);

export function parseRuntimeActivation(value: unknown): RuntimeActivationContract {
  const path = "$runtimeActivation";
  const record = strictRecord(value, path, RUNTIME_ACTIVATION_FIELDS, RUNTIME_ACTIVATION_FIELDS);
  const members = requireArray(record.members, `${path}.members`, {
    maximumItems: 256,
  }).map((member, index) => parseRuntimeActivationMember(member, `${path}.members[${index}]`));
  assertSortedUnique(
    members.map((member) => member.memberKey),
    `${path}.members`,
  );
  assertGroupVersions(members, `${path}.members`);
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    contractVersion: requireLiteral(
      record.contractVersion,
      "runtime-activation-v1",
      `${path}.contractVersion`,
    ),
    activationId: parseOntosId(record.activationId, `${path}.activationId`),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    releaseId: parseOntosId(record.releaseId, `${path}.releaseId`),
    runtimePlanDigest: parseArtifactDigest(record.runtimePlanDigest, `${path}.runtimePlanDigest`),
    state: requireOneOf(record.state, runtimeActivationStates, `${path}.state`),
    members: Object.freeze(members),
    activationDigest: parseArtifactDigest(record.activationDigest, `${path}.activationDigest`),
    createdAt: parseCanonicalInstant(record.createdAt, `${path}.createdAt`),
  });
}

function parseRuntimeActivationMember(
  value: unknown,
  path: string,
): RuntimeActivationMemberContract {
  const record = strictRecord(
    value,
    path,
    RUNTIME_ACTIVATION_MEMBER_FIELDS,
    RUNTIME_ACTIVATION_MEMBER_FIELDS,
  );
  return Object.freeze({
    memberKey: parseMemberKey(record.memberKey, `${path}.memberKey`),
    generationId: parseOntosId(record.generationId, `${path}.generationId`),
    snapshotId: parseOntosId(record.snapshotId, `${path}.snapshotId`),
    snapshotGroupId: parseOntosId(record.snapshotGroupId, `${path}.snapshotGroupId`),
    groupVersion: requireSafeInteger(record.groupVersion, `${path}.groupVersion`, {
      minimum: 1,
    }),
    certificateId: parseOntosId(record.certificateId, `${path}.certificateId`),
  });
}

export interface CompatibilityCertificateContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly contractVersion: "generation-compatibility-v1";
  readonly issuer: "materialization-compatibility-verifier";
  readonly certificateId: OntosId;
  readonly projectId: OntosId;
  readonly generationId: OntosId;
  readonly generationDigest: ArtifactDigest;
  readonly targetReleaseId: OntosId;
  readonly targetMemberKey: string;
  readonly targetRevisionId: OntosId;
  readonly snapshotGroupId: OntosId;
  readonly groupVersion: number;
  readonly snapshotSchemaRevisionId: OntosId;
  readonly snapshotSchemaDigest: ArtifactDigest;
  readonly mappingRevisionId: OntosId;
  readonly mappingDigest: ArtifactDigest;
  readonly indexPlanDigest: ArtifactDigest;
  readonly runtimePlanDigest: ArtifactDigest;
  readonly decision: "exact_pin" | "projection_equivalent";
  readonly validatorVersion: string;
  readonly evidenceDigest: ArtifactDigest;
  readonly issuedAt: CanonicalInstant;
  readonly certificateDigest: ArtifactDigest;
}

export const COMPATIBILITY_CERTIFICATE_FIELDS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "issuer",
  "certificateId",
  "projectId",
  "generationId",
  "generationDigest",
  "targetReleaseId",
  "targetMemberKey",
  "targetRevisionId",
  "snapshotGroupId",
  "groupVersion",
  "snapshotSchemaRevisionId",
  "snapshotSchemaDigest",
  "mappingRevisionId",
  "mappingDigest",
  "indexPlanDigest",
  "runtimePlanDigest",
  "decision",
  "validatorVersion",
  "evidenceDigest",
  "issuedAt",
  "certificateDigest",
] as const);

export function parseCompatibilityCertificate(value: unknown): CompatibilityCertificateContract {
  const path = "$compatibilityCertificate";
  const record = strictRecord(
    value,
    path,
    COMPATIBILITY_CERTIFICATE_FIELDS,
    COMPATIBILITY_CERTIFICATE_FIELDS,
  );
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    contractVersion: requireLiteral(
      record.contractVersion,
      "generation-compatibility-v1",
      `${path}.contractVersion`,
    ),
    issuer: requireLiteral(
      record.issuer,
      "materialization-compatibility-verifier",
      `${path}.issuer`,
    ),
    certificateId: parseOntosId(record.certificateId, `${path}.certificateId`),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    generationId: parseOntosId(record.generationId, `${path}.generationId`),
    generationDigest: parseArtifactDigest(record.generationDigest, `${path}.generationDigest`),
    targetReleaseId: parseOntosId(record.targetReleaseId, `${path}.targetReleaseId`),
    targetMemberKey: parseMemberKey(record.targetMemberKey, `${path}.targetMemberKey`),
    targetRevisionId: parseOntosId(record.targetRevisionId, `${path}.targetRevisionId`),
    snapshotGroupId: parseOntosId(record.snapshotGroupId, `${path}.snapshotGroupId`),
    groupVersion: requireSafeInteger(record.groupVersion, `${path}.groupVersion`, {
      minimum: 1,
    }),
    snapshotSchemaRevisionId: parseOntosId(
      record.snapshotSchemaRevisionId,
      `${path}.snapshotSchemaRevisionId`,
    ),
    snapshotSchemaDigest: parseArtifactDigest(
      record.snapshotSchemaDigest,
      `${path}.snapshotSchemaDigest`,
    ),
    mappingRevisionId: parseOntosId(record.mappingRevisionId, `${path}.mappingRevisionId`),
    mappingDigest: parseArtifactDigest(record.mappingDigest, `${path}.mappingDigest`),
    indexPlanDigest: parseArtifactDigest(record.indexPlanDigest, `${path}.indexPlanDigest`),
    runtimePlanDigest: parseArtifactDigest(record.runtimePlanDigest, `${path}.runtimePlanDigest`),
    decision: requireOneOf(
      record.decision,
      new Set(["exact_pin", "projection_equivalent"] as const),
      `${path}.decision`,
    ),
    validatorVersion: parseVersion(record.validatorVersion, `${path}.validatorVersion`),
    evidenceDigest: parseArtifactDigest(record.evidenceDigest, `${path}.evidenceDigest`),
    issuedAt: parseCanonicalInstant(record.issuedAt, `${path}.issuedAt`),
    certificateDigest: parseArtifactDigest(record.certificateDigest, `${path}.certificateDigest`),
  });
}

export interface IndexCapacityContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly contractVersion: "index-capacity-v1";
  readonly projectId: OntosId;
  readonly runtimePlanDigest: ArtifactDigest;
  readonly indexPlanDigest: ArtifactDigest;
  readonly sourceForecastDigest: ArtifactDigest;
  readonly measurementDigest: ArtifactDigest;
  readonly measuredBytes: number;
  readonly reservedBytes: number;
  readonly projectedPeakBytes: number;
  readonly hardLimitBytes: number;
  readonly inventoryRevision: string;
  readonly admission: "accepted" | "approval_required" | "rejected";
  readonly approvalDigest?: ArtifactDigest;
  readonly capacityDigest: ArtifactDigest;
}

export const INDEX_CAPACITY_FIELDS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "projectId",
  "runtimePlanDigest",
  "indexPlanDigest",
  "sourceForecastDigest",
  "measurementDigest",
  "measuredBytes",
  "reservedBytes",
  "projectedPeakBytes",
  "hardLimitBytes",
  "inventoryRevision",
  "admission",
  "approvalDigest",
  "capacityDigest",
] as const);
export const INDEX_CAPACITY_REQUIRED_FIELDS = Object.freeze(
  INDEX_CAPACITY_FIELDS.filter((field) => field !== "approvalDigest"),
);

export function parseIndexCapacity(value: unknown): IndexCapacityContract {
  const path = "$indexCapacity";
  const record = strictRecord(value, path, INDEX_CAPACITY_FIELDS, INDEX_CAPACITY_REQUIRED_FIELDS);
  const measuredBytes = parseBytes(record.measuredBytes, `${path}.measuredBytes`);
  const reservedBytes = parseBytes(record.reservedBytes, `${path}.reservedBytes`);
  const projectedPeakBytes = parseBytes(record.projectedPeakBytes, `${path}.projectedPeakBytes`);
  const hardLimitBytes = parseBytes(record.hardLimitBytes, `${path}.hardLimitBytes`);
  const admission = requireOneOf(
    record.admission,
    new Set(["accepted", "approval_required", "rejected"] as const),
    `${path}.admission`,
  );
  const approvalDigest =
    record.approvalDigest === undefined
      ? undefined
      : parseArtifactDigest(record.approvalDigest, `${path}.approvalDigest`);
  if (projectedPeakBytes > hardLimitBytes && admission !== "rejected") {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "The hard capacity limit cannot be approved away.",
      `${path}.admission`,
    );
  }
  if (projectedPeakBytes < measuredBytes || projectedPeakBytes < reservedBytes) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Projected peak bytes cannot be below measured or reserved bytes.",
      `${path}.projectedPeakBytes`,
    );
  }
  if (admission === "approval_required" && approvalDigest !== undefined) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "A pending approval cannot already carry approval evidence.",
      `${path}.approvalDigest`,
    );
  }
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    contractVersion: requireLiteral(
      record.contractVersion,
      "index-capacity-v1",
      `${path}.contractVersion`,
    ),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    runtimePlanDigest: parseArtifactDigest(record.runtimePlanDigest, `${path}.runtimePlanDigest`),
    indexPlanDigest: parseArtifactDigest(record.indexPlanDigest, `${path}.indexPlanDigest`),
    sourceForecastDigest: parseArtifactDigest(
      record.sourceForecastDigest,
      `${path}.sourceForecastDigest`,
    ),
    measurementDigest: parseArtifactDigest(record.measurementDigest, `${path}.measurementDigest`),
    measuredBytes,
    reservedBytes,
    projectedPeakBytes,
    hardLimitBytes,
    inventoryRevision: requireString(record.inventoryRevision, `${path}.inventoryRevision`, {
      pattern: positiveBigintTextExpression,
    }),
    admission,
    ...(approvalDigest === undefined ? {} : { approvalDigest }),
    capacityDigest: parseArtifactDigest(record.capacityDigest, `${path}.capacityDigest`),
  });
}

export interface GcPlanContract {
  readonly schemaVersion: ContractSchemaVersion;
  readonly contractVersion: "gc-plan-v1";
  readonly gcPlanId: OntosId;
  readonly projectId: OntosId;
  readonly stateRevision: string;
  readonly inventoryRevision: string;
  readonly candidateGenerationIds: readonly OntosId[];
  readonly candidateIndexDigests: readonly ArtifactDigest[];
  readonly protectedRootDigest: ArtifactDigest;
  readonly state: GcPlanState;
  readonly planDigest: ArtifactDigest;
  readonly createdAt: CanonicalInstant;
}

export const GC_PLAN_FIELDS = Object.freeze([
  "schemaVersion",
  "contractVersion",
  "gcPlanId",
  "projectId",
  "stateRevision",
  "inventoryRevision",
  "candidateGenerationIds",
  "candidateIndexDigests",
  "protectedRootDigest",
  "state",
  "planDigest",
  "createdAt",
] as const);

export function parseGcPlan(value: unknown): GcPlanContract {
  const path = "$gcPlan";
  const record = strictRecord(value, path, GC_PLAN_FIELDS, GC_PLAN_FIELDS);
  const candidateGenerationIds = requireArray(
    record.candidateGenerationIds,
    `${path}.candidateGenerationIds`,
    { maximumItems: 10_000 },
  ).map((id, index) => parseOntosId(id, `${path}.candidateGenerationIds[${index}]`));
  const candidateIndexDigests = requireArray(
    record.candidateIndexDigests,
    `${path}.candidateIndexDigests`,
    { maximumItems: 10_000 },
  ).map((digest, index) => parseArtifactDigest(digest, `${path}.candidateIndexDigests[${index}]`));
  assertSortedUnique(candidateGenerationIds, `${path}.candidateGenerationIds`);
  assertSortedUnique(candidateIndexDigests, `${path}.candidateIndexDigests`);
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    contractVersion: requireLiteral(
      record.contractVersion,
      "gc-plan-v1",
      `${path}.contractVersion`,
    ),
    gcPlanId: parseOntosId(record.gcPlanId, `${path}.gcPlanId`),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    stateRevision: requireString(record.stateRevision, `${path}.stateRevision`, {
      pattern: positiveBigintTextExpression,
    }),
    inventoryRevision: requireString(record.inventoryRevision, `${path}.inventoryRevision`, {
      pattern: positiveBigintTextExpression,
    }),
    candidateGenerationIds: Object.freeze(candidateGenerationIds),
    candidateIndexDigests: Object.freeze(candidateIndexDigests),
    protectedRootDigest: parseArtifactDigest(
      record.protectedRootDigest,
      `${path}.protectedRootDigest`,
    ),
    state: requireOneOf(record.state, gcPlanStates, `${path}.state`),
    planDigest: parseArtifactDigest(record.planDigest, `${path}.planDigest`),
    createdAt: parseCanonicalInstant(record.createdAt, `${path}.createdAt`),
  });
}

export interface MaterializationIdempotencyInput {
  readonly idempotencyVersion: typeof MATERIALIZATION_IDEMPOTENCY_VERSION;
  readonly contentDigest: ArtifactDigest;
  readonly mappingRevisionId: OntosId;
  readonly targetMemberKey: string;
  readonly runtimePlanDigest: ArtifactDigest;
}

export const MATERIALIZATION_IDEMPOTENCY_FIELDS = Object.freeze([
  "idempotencyVersion",
  "contentDigest",
  "mappingRevisionId",
  "targetMemberKey",
  "runtimePlanDigest",
] as const);

export function parseMaterializationIdempotencyInput(
  value: unknown,
): MaterializationIdempotencyInput {
  const path = "$materializationIdempotency";
  const record = strictRecord(
    value,
    path,
    MATERIALIZATION_IDEMPOTENCY_FIELDS,
    MATERIALIZATION_IDEMPOTENCY_FIELDS,
  );
  return Object.freeze({
    idempotencyVersion: requireLiteral(
      record.idempotencyVersion,
      MATERIALIZATION_IDEMPOTENCY_VERSION,
      `${path}.idempotencyVersion`,
    ),
    contentDigest: parseArtifactDigest(record.contentDigest, `${path}.contentDigest`),
    mappingRevisionId: parseOntosId(record.mappingRevisionId, `${path}.mappingRevisionId`),
    targetMemberKey: parseMemberKey(record.targetMemberKey, `${path}.targetMemberKey`),
    runtimePlanDigest: parseArtifactDigest(record.runtimePlanDigest, `${path}.runtimePlanDigest`),
  });
}

export function canonicalizeMaterializationIdempotencyInput(value: unknown): string {
  return canonicalizeContractForDigest(parseMaterializationIdempotencyInput(value));
}

export const MATERIALIZATION_CONTRACT_NAMES = Object.freeze([
  "SnapshotSchemaDefinition",
  "MappingDefinition",
  "DatasetSnapshot",
  "SnapshotGroup",
  "MaterializationJob",
  "MaterializationReport",
  "Generation",
  "RuntimeMemberPlan",
  "RuntimeActivation",
  "CompatibilityCertificate",
  "IndexCapacity",
  "GcPlan",
] as const);
export type MaterializationContractName = (typeof MATERIALIZATION_CONTRACT_NAMES)[number];

export function parseMaterializationContract(
  name: MaterializationContractName,
  value: unknown,
): unknown {
  if (name === "SnapshotSchemaDefinition") return parseSnapshotSchemaDefinition(value);
  if (name === "MappingDefinition") return parseMappingDefinition(value);
  if (name === "DatasetSnapshot") return parseDatasetSnapshot(value);
  if (name === "SnapshotGroup") return parseSnapshotGroup(value);
  if (name === "MaterializationJob") return parseMaterializationJob(value);
  if (name === "MaterializationReport") return parseMaterializationReport(value);
  if (name === "Generation") return parseGeneration(value);
  if (name === "RuntimeMemberPlan") return parseRuntimeMemberPlan(value);
  if (name === "RuntimeActivation") return parseRuntimeActivation(value);
  if (name === "CompatibilityCertificate") return parseCompatibilityCertificate(value);
  if (name === "IndexCapacity") return parseIndexCapacity(value);
  return parseGcPlan(value);
}

export function canonicalizeMaterializationContractForDigest(
  name: MaterializationContractName,
  value: unknown,
): string {
  const parsed = parseMaterializationContract(name, value);
  return canonicalizeContractForDigest(materializationDigestValue(name, parsed));
}

function materializationDigestValue(
  name: MaterializationContractName,
  value: unknown,
): Readonly<Record<string, unknown>> {
  const record = { ...(value as Readonly<Record<string, unknown>>) };
  if (name === "DatasetSnapshot") removeFields(record, ["state", "registeredAt", "snapshotDigest"]);
  else if (name === "SnapshotGroup") removeFields(record, ["state", "createdAt", "groupDigest"]);
  else if (name === "MaterializationJob") {
    removeFields(record, ["state", "currentStage", "attemptCount", "checkpoint", "updatedAt"]);
  } else if (name === "MaterializationReport") removeFields(record, ["createdAt", "reportDigest"]);
  else if (name === "Generation") removeFields(record, ["state", "createdAt", "generationDigest"]);
  else if (name === "RuntimeMemberPlan") removeFields(record, ["planDigest"]);
  else if (name === "RuntimeActivation") {
    removeFields(record, ["state", "createdAt", "activationDigest"]);
  } else if (name === "CompatibilityCertificate") {
    removeFields(record, ["certificateId", "issuedAt", "certificateDigest"]);
  } else if (name === "IndexCapacity") removeFields(record, ["capacityDigest"]);
  else if (name === "GcPlan") {
    removeFields(record, ["gcPlanId", "state", "createdAt", "planDigest"]);
  }
  return Object.freeze(record);
}

export type MaterializationStateKind =
  "snapshot" | "snapshot_group" | "job" | "generation" | "activation" | "gc_plan";

const stateTransitions: Readonly<
  Record<MaterializationStateKind, Readonly<Record<string, readonly string[]>>>
> = Object.freeze({
  snapshot: Object.freeze({
    registered: Object.freeze(["validated", "failed"]),
    validated: Object.freeze(["materializing", "failed"]),
    materializing: Object.freeze(["ready", "failed"]),
    ready: Object.freeze(["active", "failed"]),
    active: Object.freeze(["superseded"]),
    superseded: Object.freeze([]),
    failed: Object.freeze([]),
  }),
  snapshot_group: Object.freeze({
    registered: Object.freeze(["validated", "failed"]),
    validated: Object.freeze(["materializing", "failed"]),
    materializing: Object.freeze(["ready", "failed"]),
    ready: Object.freeze(["active", "failed"]),
    active: Object.freeze(["superseded"]),
    superseded: Object.freeze([]),
    failed: Object.freeze([]),
  }),
  job: Object.freeze({
    queued: Object.freeze(["running", "cancelled"]),
    running: Object.freeze(["retry_wait", "succeeded", "dead_letter", "cancelled"]),
    retry_wait: Object.freeze(["running", "cancelled"]),
    succeeded: Object.freeze([]),
    dead_letter: Object.freeze(["queued"]),
    cancelled: Object.freeze([]),
  }),
  generation: Object.freeze({
    building: Object.freeze(["ready", "failed"]),
    ready: Object.freeze(["active", "retired", "failed"]),
    active: Object.freeze(["retired"]),
    retired: Object.freeze([]),
    failed: Object.freeze([]),
  }),
  activation: Object.freeze({
    building: Object.freeze(["ready", "failed"]),
    ready: Object.freeze(["active", "failed"]),
    active: Object.freeze(["retired"]),
    retired: Object.freeze([]),
    failed: Object.freeze([]),
  }),
  gc_plan: Object.freeze({
    planned: Object.freeze(["committed", "stale", "failed", "cancelled"]),
    committed: Object.freeze([]),
    stale: Object.freeze([]),
    failed: Object.freeze([]),
    cancelled: Object.freeze([]),
  }),
});

export function assertMaterializationStateTransition(
  kind: MaterializationStateKind,
  from: string,
  to: string,
): void {
  const transitions = stateTransitions[kind][from];
  if (transitions === undefined || (from !== to && !transitions.includes(to))) {
    failContract(
      "CONTRACT_STATE_TRANSITION_INVALID",
      `Illegal ${kind} state transition.`,
      "$stateTransition",
    );
  }
}

function assertValueTypeOptions(value: SnapshotColumnDefinition, path: string): void {
  if (value.valueType === "enum") {
    if (value.enumValues === undefined) {
      failContract("CONTRACT_FIELD_MISSING", "Enum values are required.", `${path}.enumValues`);
    }
  } else if (value.enumValues !== undefined) {
    failContract("CONTRACT_FORMAT_INVALID", "Enum values require enum type.", `${path}.enumValues`);
  }
  if (value.valueType === "decimal") {
    if (value.decimalPrecision === undefined || value.decimalScale === undefined) {
      failContract("CONTRACT_FIELD_MISSING", "Decimal precision and scale are required.", path);
    }
    if (value.decimalScale > value.decimalPrecision) {
      failContract(
        "CONTRACT_VALUE_OUT_OF_RANGE",
        "Decimal scale cannot exceed precision.",
        `${path}.decimalScale`,
      );
    }
  } else if (value.decimalPrecision !== undefined || value.decimalScale !== undefined) {
    failContract("CONTRACT_FORMAT_INVALID", "Decimal options require decimal type.", path);
  }
  if (
    value.caseSensitive !== undefined &&
    value.valueType !== "string" &&
    value.valueType !== "string[]"
  ) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Case sensitivity applies only to string types.",
      `${path}.caseSensitive`,
    );
  }
}

function assertSequentialOrdinals(
  values: readonly Readonly<{ ordinal: number }>[],
  path: string,
): void {
  values.forEach((value, index) => {
    if (value.ordinal !== index) {
      failContract("CONTRACT_FORMAT_INVALID", "Ordinals must be consecutive from zero.", path);
    }
  });
}

function assertGroupVersions(
  members: readonly RuntimeActivationMemberContract[],
  path: string,
): void {
  const versions = new Map<string, number>();
  for (const member of members) {
    const previous = versions.get(member.snapshotGroupId);
    if (previous !== undefined && previous !== member.groupVersion) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "One Snapshot Group cannot mix Group Versions.",
        path,
      );
    }
    versions.set(member.snapshotGroupId, member.groupVersion);
  }
}

function parseSortedStrings(
  value: unknown,
  path: string,
  minimumItems: number,
  maximumItems: number,
): readonly string[] {
  const result = requireArray(value, path, { minimumItems, maximumItems }).map((item, index) =>
    requireString(item, `${path}[${index}]`, { maximumLength: 128 }),
  );
  assertSortedUnique(result, path);
  return Object.freeze(result);
}

function assertSortedUnique(values: readonly string[], path: string): void {
  for (let index = 0; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous !== undefined && current !== undefined && previous >= current) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "Values must be unique and sorted by code point.",
        path,
      );
    }
  }
}

function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    failContract("CONTRACT_FORMAT_INVALID", "Values must be unique.", path);
  }
}

function parseApiName(value: unknown, path: string): string {
  return requireString(value, path, { pattern: apiNameExpression, maximumLength: 63 });
}

function parseMemberKey(value: unknown, path: string): string {
  return requireString(value, path, { pattern: memberKeyExpression, maximumLength: 70 });
}

function parseVersion(value: unknown, path: string): string {
  return requireString(value, path, { pattern: versionExpression, maximumLength: 128 });
}

function parseBytes(value: unknown, path: string): number {
  return requireSafeInteger(value, path, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
}

function safeIntegerSum(values: readonly number[], path: string): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      failContract("CONTRACT_VALUE_OUT_OF_RANGE", "Integer total exceeds its contract.", path);
    }
  }
  return total;
}

function requireZero(value: unknown, path: string): 0 {
  const parsed = requireSafeInteger(value, path, { minimum: 0, maximum: 0 });
  return parsed as 0;
}

function requireAbsent(value: unknown, path: string): void {
  if (value !== undefined) {
    failContract("CONTRACT_FORMAT_INVALID", "Field is forbidden for this variant.", path);
  }
}

function strictRecord(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  const record = requirePlainRecord(value, path);
  requireObjectShape(record, allowed, required, path);
  return record;
}

function removeFields(record: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) delete record[field];
}
