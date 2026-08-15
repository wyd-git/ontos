import {
  COMPATIBILITY_CERTIFICATE_FIELDS,
  DATASET_SNAPSHOT_FIELDS,
  DATASET_SNAPSHOT_REQUIRED_FIELDS,
  GC_PLAN_FIELDS,
  GC_PLAN_STATE_VALUES,
  GENERATION_FIELDS,
  GENERATION_STATE_VALUES,
  INDEX_CAPACITY_FIELDS,
  INDEX_CAPACITY_REQUIRED_FIELDS,
  MAPPING_DEFINITION_FIELDS,
  MAPPING_DEFINITION_REQUIRED_FIELDS,
  MAPPING_EXPRESSION_FIELDS,
  MAPPING_KEY_FIELDS,
  MAPPING_PROPERTY_FIELDS,
  MAPPING_QUALITY_RULE_FIELDS,
  MATERIALIZATION_CHECKPOINT_FIELDS,
  MATERIALIZATION_ERROR_SAMPLE_FIELDS,
  MATERIALIZATION_JOB_FIELDS,
  MATERIALIZATION_JOB_REQUIRED_FIELDS,
  MATERIALIZATION_REASON_CODE_VALUES,
  MATERIALIZATION_REASON_COUNT_FIELDS,
  MATERIALIZATION_REPORT_FIELDS,
  MATERIALIZATION_STAGE_VALUES,
  MATERIALIZATION_JOB_STATE_VALUES,
  PROPERTY_VALUE_TYPE_VALUES,
  RUNTIME_ACTIVATION_FIELDS,
  RUNTIME_ACTIVATION_MEMBER_FIELDS,
  RUNTIME_ACTIVATION_STATE_VALUES,
  RUNTIME_MEMBER_PLAN_ENTRY_FIELDS,
  RUNTIME_MEMBER_PLAN_FIELDS,
  SNAPSHOT_COLUMN_FIELDS,
  SNAPSHOT_COLUMN_REQUIRED_FIELDS,
  SNAPSHOT_FILE_FIELDS,
  SNAPSHOT_GROUP_FIELDS,
  SNAPSHOT_GROUP_MEMBER_FIELDS,
  SNAPSHOT_GROUP_STATE_VALUES,
  SNAPSHOT_SCHEMA_DEFINITION_FIELDS,
  SNAPSHOT_STATE_VALUES,
} from "../../packages/contracts/src/index.ts";

interface DefinitionAgreement {
  readonly name: string;
  readonly fields: readonly string[];
  readonly required: readonly string[];
}

const agreements: readonly DefinitionAgreement[] = Object.freeze([
  agreement("SnapshotColumn", SNAPSHOT_COLUMN_FIELDS, SNAPSHOT_COLUMN_REQUIRED_FIELDS),
  agreement("MappingExpression", MAPPING_EXPRESSION_FIELDS, ["op"]),
  agreement("MappingProperty", MAPPING_PROPERTY_FIELDS),
  agreement("MappingKey", MAPPING_KEY_FIELDS),
  agreement("MappingQualityRules", MAPPING_QUALITY_RULE_FIELDS),
  agreement("SnapshotFile", SNAPSHOT_FILE_FIELDS),
  agreement("SnapshotGroupMember", SNAPSHOT_GROUP_MEMBER_FIELDS),
  agreement("MaterializationCheckpoint", MATERIALIZATION_CHECKPOINT_FIELDS),
  agreement("MaterializationReasonCount", MATERIALIZATION_REASON_COUNT_FIELDS),
  agreement("MaterializationErrorSample", MATERIALIZATION_ERROR_SAMPLE_FIELDS),
  agreement("RuntimeMemberPlanEntry", RUNTIME_MEMBER_PLAN_ENTRY_FIELDS),
  agreement("RuntimeActivationMember", RUNTIME_ACTIVATION_MEMBER_FIELDS),
  agreement("SnapshotSchemaDefinition", SNAPSHOT_SCHEMA_DEFINITION_FIELDS),
  agreement("MappingDefinition", MAPPING_DEFINITION_FIELDS, MAPPING_DEFINITION_REQUIRED_FIELDS),
  agreement("DatasetSnapshot", DATASET_SNAPSHOT_FIELDS, DATASET_SNAPSHOT_REQUIRED_FIELDS),
  agreement("SnapshotGroup", SNAPSHOT_GROUP_FIELDS),
  agreement("MaterializationJob", MATERIALIZATION_JOB_FIELDS, MATERIALIZATION_JOB_REQUIRED_FIELDS),
  agreement("MaterializationReport", MATERIALIZATION_REPORT_FIELDS),
  agreement("Generation", GENERATION_FIELDS),
  agreement("RuntimeMemberPlan", RUNTIME_MEMBER_PLAN_FIELDS),
  agreement("RuntimeActivation", RUNTIME_ACTIVATION_FIELDS),
  agreement("CompatibilityCertificate", COMPATIBILITY_CERTIFICATE_FIELDS),
  agreement("IndexCapacity", INDEX_CAPACITY_FIELDS, INDEX_CAPACITY_REQUIRED_FIELDS),
  agreement("GcPlan", GC_PLAN_FIELDS),
]);

export function assertMaterializationRuntimeSchemaAgreement(schemaValue: unknown): void {
  const root = requireRecord(schemaValue, "$schema");
  const definitions = requireRecord(root.$defs, "$schema.$defs");
  for (const item of agreements) {
    const definition = requireRecord(definitions[item.name], `$defs.${item.name}`);
    if (definition.additionalProperties !== false) {
      throw new Error(`${item.name} JSON Schema must reject unknown fields.`);
    }
    const properties = requireRecord(definition.properties, `$defs.${item.name}.properties`);
    assertStringSet(Object.keys(properties), item.fields, `$defs.${item.name}.properties`);
    assertStringSet(stringArray(definition.required), item.required, `$defs.${item.name}.required`);
  }

  assertEnum(definitions, "PropertyValueType", undefined, PROPERTY_VALUE_TYPE_VALUES);
  assertEnum(definitions, "MappingExpression", "op", ["column", "constant", "cast", "concat"]);
  assertEnum(definitions, "MappingDefinition", "targetKind", ["object", "link"]);
  assertEnum(definitions, "DatasetSnapshot", "state", SNAPSHOT_STATE_VALUES);
  assertEnum(definitions, "SnapshotGroup", "state", SNAPSHOT_GROUP_STATE_VALUES);
  assertEnum(definitions, "MaterializationJob", "state", MATERIALIZATION_JOB_STATE_VALUES);
  assertEnum(definitions, "MaterializationCheckpoint", "stage", MATERIALIZATION_STAGE_VALUES);
  assertEnum(definitions, "MaterializationReasonCount", "code", MATERIALIZATION_REASON_CODE_VALUES);
  assertEnum(definitions, "MaterializationErrorSample", "code", MATERIALIZATION_REASON_CODE_VALUES);
  assertEnum(definitions, "Generation", "state", GENERATION_STATE_VALUES);
  assertEnum(definitions, "RuntimeActivation", "state", RUNTIME_ACTIVATION_STATE_VALUES);
  assertEnum(definitions, "GcPlan", "state", GC_PLAN_STATE_VALUES);

  assertConst(definitions, "SnapshotSchemaDefinition", "contractVersion", "snapshot-schema-v1");
  assertConst(definitions, "SnapshotSchemaDefinition", "format", "csv_utf8");
  assertConst(definitions, "SnapshotSchemaDefinition", "headerRow", true);
  assertConst(definitions, "MappingDefinition", "mappingVersion", "mapping-v1");
  assertConst(definitions, "MappingDefinition", "valueCodecVersion", "pk1");
  assertConst(
    definitions,
    "CompatibilityCertificate",
    "issuer",
    "materialization-compatibility-verifier",
  );
  if (property(definitions, "CompatibilityCertificate", "compatible") !== undefined) {
    throw new Error("CompatibilityCertificate cannot expose a client compatible boolean.");
  }
}

function agreement(
  name: string,
  fields: readonly string[],
  required: readonly string[] = fields,
): DefinitionAgreement {
  return Object.freeze({ name, fields, required });
}

function assertEnum(
  definitions: Readonly<Record<string, unknown>>,
  definitionName: string,
  propertyName: string | undefined,
  expected: readonly string[],
): void {
  const schema =
    propertyName === undefined
      ? requireRecord(definitions[definitionName], `$defs.${definitionName}`)
      : requireRecord(
          property(definitions, definitionName, propertyName),
          `$defs.${definitionName}.properties.${propertyName}`,
        );
  assertStringSet(stringArray(schema.enum), expected, `$defs.${definitionName}.enum`);
}

function assertConst(
  definitions: Readonly<Record<string, unknown>>,
  definitionName: string,
  propertyName: string,
  expected: unknown,
): void {
  const schema = requireRecord(
    property(definitions, definitionName, propertyName),
    `$defs.${definitionName}.properties.${propertyName}`,
  );
  if (JSON.stringify(schema.const) !== JSON.stringify(expected)) {
    throw new Error(`${definitionName}.${propertyName} const drifted from the runtime parser.`);
  }
}

function property(
  definitions: Readonly<Record<string, unknown>>,
  definitionName: string,
  propertyName: string,
): unknown {
  const definition = requireRecord(definitions[definitionName], `$defs.${definitionName}`);
  const properties = requireRecord(definition.properties, `$defs.${definitionName}.properties`);
  return properties[propertyName];
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Expected a string array in Materialization JSON Schema.");
  }
  return value as readonly string[];
}

function assertStringSet(
  actual: readonly string[],
  expected: readonly string[],
  path: string,
): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(
      `${path} does not match the runtime contract: ${JSON.stringify({ left, right })}`,
    );
  }
}

function requireRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}
