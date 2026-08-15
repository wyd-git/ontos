import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseLinkTypeDefinition,
  parseMappingDefinition,
  parseObjectTypeDefinition,
  parseOntosId,
  parseSnapshotSchemaDefinition,
  type ArtifactDigest,
  type LinkTypeDefinition,
  type MappingDefinition,
  type MappingExpression,
  type MappingQualityRules,
  type MaterializationReasonCode,
  type ObjectTypeDefinition,
  type OntosId,
  type PropertyDefinition,
  type PropertyValueType,
  type SnapshotColumnDefinition,
  type SnapshotSchemaDefinition,
} from "@ontos/contracts";
import {
  ValueCodecError,
  canonicalizePrimaryKey,
  canonicalizePropertyValue,
  canonicalizeRestrictedJson,
  type CanonicalPrimaryKey,
  type CanonicalPropertyValue,
  type PrimaryKeyComponentDescriptor,
  type PropertyDescriptor,
  type ValueCodecErrorCode,
} from "@ontos/value-codec";

export const MAPPING_COMPILER_VERSION = "mapping-compiler-v1" as const;
export const MAPPING_STREAM_DIGEST_VERSION = "mapping-stream-chain-v1" as const;

export type CanonicalTextDigester = (canonicalText: string) => ArtifactDigest;

export type MappingCompileErrorCode =
  | "MAPPING_CONTRACT_INVALID"
  | "MAPPING_BINDING_MISMATCH"
  | "MAPPING_DIGEST_MISMATCH"
  | "MAPPING_COLUMN_UNKNOWN"
  | "MAPPING_PROPERTY_UNKNOWN"
  | "MAPPING_PROPERTY_NOT_SOURCE_WRITABLE"
  | "MAPPING_PROPERTY_REQUIRED_MISSING"
  | "MAPPING_PROPERTY_REQUIRED_MISMATCH"
  | "MAPPING_EXPRESSION_TYPE_INVALID"
  | "MAPPING_ENDPOINT_INVALID";

export class MappingCompileError extends Error {
  readonly code: MappingCompileErrorCode;
  readonly path: string;

  constructor(
    code: MappingCompileErrorCode,
    message: string,
    path: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MappingCompileError";
    this.code = code;
    this.path = path;
  }
}

export type MappingExecutionErrorCode =
  | "MAPPING_EXECUTION_ALREADY_FINISHED"
  | "MAPPING_ROW_SEQUENCE_INVALID"
  | "MAPPING_ROW_WIDTH_INVALID"
  | "MAPPING_SOURCE_DIGEST_INVALID"
  | "MAPPING_EVENT_SINK_FAILED";

export class MappingExecutionError extends Error {
  readonly code: MappingExecutionErrorCode;

  constructor(code: MappingExecutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MappingExecutionError";
    this.code = code;
  }
}

export interface MappingDefinitionBinding {
  readonly mappingRevisionId: unknown;
  readonly mappingRevisionDigest: unknown;
  readonly mapping: unknown;
  readonly inputSchemaRevisionId: unknown;
  readonly inputSchemaDigest: unknown;
  readonly inputSchema: unknown;
}

export interface ObjectTypeBinding {
  readonly resourceId: unknown;
  readonly revisionId: unknown;
  readonly definitionDigest: unknown;
  readonly definition: unknown;
}

export interface ObjectMappingTargetBinding extends ObjectTypeBinding {
  readonly kind: "object";
}

export interface LinkMappingTargetBinding {
  readonly kind: "link";
  readonly resourceId: unknown;
  readonly revisionId: unknown;
  readonly definitionDigest: unknown;
  readonly definition: unknown;
  readonly sourceObject: ObjectTypeBinding;
  readonly targetObject: ObjectTypeBinding;
}

export interface CompileMappingInput extends MappingDefinitionBinding {
  readonly target: ObjectMappingTargetBinding | LinkMappingTargetBinding;
}

export interface CompiledMappingColumn {
  readonly ordinal: number;
  readonly columnApiName: string;
  readonly valueType: PropertyValueType;
  readonly required: boolean;
  readonly descriptor: PropertyDescriptor;
  readonly used: boolean;
  readonly usedByKey: boolean;
  readonly diagnosticNameAllowed: boolean;
}

interface CompiledExpressionBase {
  readonly valueType: PropertyValueType;
  readonly sourceColumnOrdinals: readonly number[];
}

export interface CompiledColumnExpression extends CompiledExpressionBase {
  readonly op: "column";
  readonly columnOrdinal: number;
  readonly columnApiName: string;
}

export interface CompiledConstantExpression extends CompiledExpressionBase {
  readonly op: "constant";
  readonly literal: string;
}

export interface CompiledCastExpression extends CompiledExpressionBase {
  readonly op: "cast";
  readonly input: CompiledMappingExpression;
  readonly targetDescriptor: PropertyDescriptor;
}

export interface CompiledConcatExpression extends CompiledExpressionBase {
  readonly op: "concat";
  readonly inputs: readonly CompiledMappingExpression[];
  readonly separator: string;
}

export type CompiledMappingExpression =
  | CompiledColumnExpression
  | CompiledConstantExpression
  | CompiledCastExpression
  | CompiledConcatExpression;

export interface CompiledPropertyMapping {
  readonly propertyApiName: string;
  readonly required: boolean;
  readonly nullPolicy: "allow" | "reject_row";
  readonly targetDescriptor: PropertyDescriptor;
  readonly sourceColumnOrdinals: readonly number[];
  readonly expression: CompiledMappingExpression;
}

export interface CompiledPrimaryKeyMapping {
  readonly propertyApiName: string;
  readonly propertyDescriptor: PropertyDescriptor;
  readonly keyDescriptor: PrimaryKeyComponentDescriptor;
  readonly sourceColumnOrdinals: readonly number[];
  readonly expression: CompiledMappingExpression;
}

export interface CompiledIdentityKeyMapping {
  readonly objectTypeResourceId: OntosId;
  readonly objectTypeRevisionId: OntosId;
  readonly objectTypeDefinitionDigest: ArtifactDigest;
  readonly keyDescriptor: PrimaryKeyComponentDescriptor;
  readonly sourceColumnOrdinals: readonly number[];
  readonly expression: CompiledMappingExpression;
}

interface CompiledMappingPlanBase {
  readonly schemaVersion: 1;
  readonly compilerVersion: typeof MAPPING_COMPILER_VERSION;
  readonly mappingVersion: "mapping-v1";
  readonly valueCodecVersion: "pk1";
  readonly mappingRevisionId: OntosId;
  readonly mappingRevisionDigest: ArtifactDigest;
  readonly inputSchemaRevisionId: OntosId;
  readonly inputSchemaDigest: ArtifactDigest;
  readonly targetResourceId: OntosId;
  readonly targetRevisionId: OntosId;
  readonly targetDefinitionDigest: ArtifactDigest;
  readonly qualityRules: MappingQualityRules;
  readonly columns: readonly CompiledMappingColumn[];
  readonly propertyMappings: readonly CompiledPropertyMapping[];
  readonly planDigest: ArtifactDigest;
}

export interface CompiledObjectMappingPlan extends CompiledMappingPlanBase {
  readonly targetKind: "object";
  readonly primaryKey: CompiledPrimaryKeyMapping;
}

export interface CompiledLinkMappingPlan extends CompiledMappingPlanBase {
  readonly targetKind: "link";
  readonly sourceKey: CompiledIdentityKeyMapping;
  readonly targetKey: CompiledIdentityKeyMapping;
}

export type CompiledMappingPlan = CompiledObjectMappingPlan | CompiledLinkMappingPlan;

export type MappingRowErrorCode =
  | "MAPPING_SOURCE_REQUIRED_NULL"
  | "MAPPING_SOURCE_VALUE_INVALID"
  | "MAPPING_PRIMARY_KEY_NULL"
  | "MAPPING_PRIMARY_KEY_INVALID"
  | "MAPPING_PROPERTY_NULL"
  | "MAPPING_PROPERTY_INVALID"
  | "MAPPING_LINK_KEY_NULL"
  | "MAPPING_LINK_KEY_INVALID";

export interface MappingRowError {
  readonly reasonCode: MaterializationReasonCode;
  readonly mappingCode: MappingRowErrorCode;
  readonly codecCode?: ValueCodecErrorCode;
  readonly columnApiName?: string;
}

export interface CanonicalJsonMappedValue {
  readonly kind: "canonical_json";
  readonly canonicalJson: string;
}

export type MappedPropertyValue =
  null | boolean | string | readonly string[] | CanonicalJsonMappedValue;

export interface MappedProperty {
  readonly propertyApiName: string;
  readonly valueType: PropertyValueType;
  readonly value: MappedPropertyValue;
  readonly sourceColumnApiNames: readonly string[];
}

export interface MappingAcceptedObjectRow {
  readonly kind: "object";
  readonly rowNumber: number;
  readonly targetResourceId: OntosId;
  readonly targetRevisionId: OntosId;
  readonly canonicalPrimaryKey: CanonicalPrimaryKey;
  readonly properties: readonly MappedProperty[];
}

export interface IdentityLookupCandidate {
  readonly objectTypeResourceId: OntosId;
  readonly objectTypeRevisionId: OntosId;
  readonly canonicalPrimaryKey: CanonicalPrimaryKey;
  readonly sourceColumnApiNames: readonly string[];
}

export interface MappingAcceptedLinkRow {
  readonly kind: "link";
  readonly rowNumber: number;
  readonly targetResourceId: OntosId;
  readonly targetRevisionId: OntosId;
  readonly sourceLookup: IdentityLookupCandidate;
  readonly targetLookup: IdentityLookupCandidate;
}

export interface MappingRejectedRow {
  readonly kind: "rejected";
  readonly rowNumber: number;
  readonly errors: readonly MappingRowError[];
}

export type MappingRowEvent =
  MappingAcceptedObjectRow | MappingAcceptedLinkRow | MappingRejectedRow;

export interface MappingErrorAggregate {
  readonly reasonCode: MaterializationReasonCode;
  readonly mappingCode: MappingRowErrorCode;
  readonly codecCode: ValueCodecErrorCode | null;
  readonly count: number;
}

export interface MappingExecutionSummary {
  readonly schemaVersion: 1;
  readonly streamDigestVersion: typeof MAPPING_STREAM_DIGEST_VERSION;
  readonly planDigest: ArtifactDigest;
  readonly sourceContentDigest: ArtifactDigest;
  readonly sourceRowCount: number;
  readonly acceptedRowCount: number;
  readonly rejectedRowCount: number;
  readonly errorAggregates: readonly MappingErrorAggregate[];
  readonly mappedStreamDigest: ArtifactDigest;
}

export interface MappingSourceRow {
  readonly rowNumber: number;
  readonly values: readonly string[];
}

export interface MappingEventSink {
  write(event: MappingRowEvent): void | Promise<void>;
}

export interface CreateMappingExecutionInput {
  readonly plan: CompiledMappingPlan;
  readonly sourceContentDigest: unknown;
  readonly digestCanonicalText: CanonicalTextDigester;
  readonly sink?: MappingEventSink;
}

export interface MappingExecutionSession {
  consumeRow(row: MappingSourceRow): Promise<void>;
  finish(): MappingExecutionSummary;
}

interface ResolvedColumn {
  readonly definition: SnapshotColumnDefinition;
  readonly descriptor: PropertyDescriptor;
}

interface ColumnUsage {
  used: boolean;
  usedByKey: boolean;
  sensitive: boolean;
}

interface PlanCommonInput {
  readonly mapping: MappingDefinition;
  readonly mappingRevisionId: OntosId;
  readonly mappingRevisionDigest: ArtifactDigest;
  readonly inputSchemaRevisionId: OntosId;
  readonly inputSchemaDigest: ArtifactDigest;
  readonly inputSchema: SnapshotSchemaDefinition;
  readonly targetResourceId: OntosId;
  readonly targetRevisionId: OntosId;
  readonly targetDefinitionDigest: ArtifactDigest;
  readonly resolvedColumns: readonly ResolvedColumn[];
  readonly columnsByName: ReadonlyMap<string, ResolvedColumn>;
  readonly usages: readonly ColumnUsage[];
}

interface ExpressionResult {
  readonly ok: true;
  readonly value: CanonicalPropertyValue;
}

interface ExpressionFailure {
  readonly ok: false;
  readonly codecCode: ValueCodecErrorCode;
}

type EvaluatedExpression = ExpressionResult | ExpressionFailure;

type ParsedCell = ExpressionResult | ExpressionFailure;

const scalarTypes = new Set<PropertyValueType>([
  "string",
  "boolean",
  "integer",
  "decimal",
  "date",
  "timestamp",
  "enum",
]);

export function compileMapping(
  input: CompileMappingInput,
  digestCanonicalText: CanonicalTextDigester,
): CompiledMappingPlan {
  try {
    return compileMappingInternal(input, digestCanonicalText);
  } catch (error) {
    if (error instanceof MappingCompileError) throw error;
    throw new MappingCompileError(
      "MAPPING_CONTRACT_INVALID",
      "Mapping compilation input does not satisfy the frozen contracts.",
      "$compile",
      { cause: error },
    );
  }
}

function compileMappingInternal(
  input: CompileMappingInput,
  digestCanonicalText: CanonicalTextDigester,
): CompiledMappingPlan {
  if (typeof digestCanonicalText !== "function") {
    throw new MappingCompileError(
      "MAPPING_CONTRACT_INVALID",
      "Mapping compiler requires a canonical SHA-256 digester.",
      "$compile.digestCanonicalText",
    );
  }
  const mapping = parseMappingDefinition(input.mapping);
  const inputSchema = parseSnapshotSchemaDefinition(input.inputSchema);
  const mappingRevisionId = parseOntosId(input.mappingRevisionId, "$compile.mappingRevisionId");
  const inputSchemaRevisionId = parseOntosId(
    input.inputSchemaRevisionId,
    "$compile.inputSchemaRevisionId",
  );
  const mappingRevisionDigest = verifyDefinitionDigest(
    input.mappingRevisionDigest,
    mapping,
    "$compile.mappingRevisionDigest",
    digestCanonicalText,
  );
  const inputSchemaDigest = verifyDefinitionDigest(
    input.inputSchemaDigest,
    inputSchema,
    "$compile.inputSchemaDigest",
    digestCanonicalText,
  );

  if (mapping.inputSchemaRevisionId !== inputSchemaRevisionId) {
    bindingMismatch(
      "Mapping input Schema Revision does not match its immutable binding.",
      "$mapping",
    );
  }

  const resolvedColumns = inputSchema.columns.map((definition) =>
    Object.freeze({ definition, descriptor: descriptorFromSnapshotColumn(definition) }),
  );
  const columnsByName = new Map(
    resolvedColumns.map((column) => [column.definition.columnApiName, column]),
  );
  const usages = resolvedColumns.map<ColumnUsage>(() => ({
    used: false,
    usedByKey: false,
    sensitive: false,
  }));

  if (input.target.kind === "object") {
    if (mapping.targetKind !== "object") {
      bindingMismatch(
        "Object target binding cannot compile a Link Mapping.",
        "$compile.target.kind",
      );
    }
    const definition = parseObjectTypeDefinition(input.target.definition);
    const targetResourceId = parseOntosId(input.target.resourceId, "$compile.target.resourceId");
    const targetRevisionId = parseOntosId(input.target.revisionId, "$compile.target.revisionId");
    const targetDefinitionDigest = verifyDefinitionDigest(
      input.target.definitionDigest,
      definition,
      "$compile.target.definitionDigest",
      digestCanonicalText,
    );
    assertTargetBinding(mapping, targetResourceId, targetRevisionId);
    const common: PlanCommonInput = {
      mapping,
      mappingRevisionId,
      mappingRevisionDigest,
      inputSchemaRevisionId,
      inputSchemaDigest,
      inputSchema,
      targetResourceId,
      targetRevisionId,
      targetDefinitionDigest,
      resolvedColumns,
      columnsByName,
      usages,
    };
    return compileObjectPlan(common, definition, digestCanonicalText);
  }

  if (mapping.targetKind !== "link") {
    bindingMismatch(
      "Link target binding cannot compile an Object Mapping.",
      "$compile.target.kind",
    );
  }
  const linkDefinition = parseLinkTypeDefinition(input.target.definition);
  const targetResourceId = parseOntosId(input.target.resourceId, "$compile.target.resourceId");
  const targetRevisionId = parseOntosId(input.target.revisionId, "$compile.target.revisionId");
  const targetDefinitionDigest = verifyDefinitionDigest(
    input.target.definitionDigest,
    linkDefinition,
    "$compile.target.definitionDigest",
    digestCanonicalText,
  );
  assertTargetBinding(mapping, targetResourceId, targetRevisionId);
  const common: PlanCommonInput = {
    mapping,
    mappingRevisionId,
    mappingRevisionDigest,
    inputSchemaRevisionId,
    inputSchemaDigest,
    inputSchema,
    targetResourceId,
    targetRevisionId,
    targetDefinitionDigest,
    resolvedColumns,
    columnsByName,
    usages,
  };
  return compileLinkPlan(common, linkDefinition, input.target, digestCanonicalText);
}

function compileObjectPlan(
  common: PlanCommonInput,
  targetDefinition: ObjectTypeDefinition,
  digestCanonicalText: CanonicalTextDigester,
): CompiledObjectMappingPlan {
  const properties = new Map(
    targetDefinition.properties.map((property) => [property.apiName, property]),
  );
  const primaryKeyProperty = properties.get(targetDefinition.primaryKeyPropertyApiName);
  if (primaryKeyProperty === undefined || common.mapping.primaryKeyExpression === undefined) {
    throw new MappingCompileError(
      "MAPPING_PROPERTY_UNKNOWN",
      "Object Mapping Primary Key does not resolve to the target definition.",
      "$mapping.primaryKeyExpression",
    );
  }
  const primaryKeyDescriptor = descriptorFromProperty(primaryKeyProperty);
  const primaryKeyExpression = compileExpressionForTarget(
    common.mapping.primaryKeyExpression,
    primaryKeyDescriptor,
    common.columnsByName,
    "$mapping.primaryKeyExpression",
  );
  markUsage(common.usages, primaryKeyExpression.sourceColumnOrdinals, true, true);
  const primaryKey: CompiledPrimaryKeyMapping = Object.freeze({
    propertyApiName: primaryKeyProperty.apiName,
    propertyDescriptor: primaryKeyDescriptor,
    keyDescriptor: keyDescriptorFromProperty(primaryKeyProperty),
    sourceColumnOrdinals: primaryKeyExpression.sourceColumnOrdinals,
    expression: primaryKeyExpression,
  });

  const propertyMappings = common.mapping.propertyMappings.map((mapping, index) => {
    const path = `$mapping.propertyMappings[${String(index)}]`;
    const property = properties.get(mapping.propertyApiName);
    if (property === undefined) {
      throw new MappingCompileError(
        "MAPPING_PROPERTY_UNKNOWN",
        "Mapping Property does not exist in the target Object Type.",
        `${path}.propertyApiName`,
      );
    }
    if (property.apiName === primaryKeyProperty.apiName) {
      throw new MappingCompileError(
        "MAPPING_PROPERTY_NOT_SOURCE_WRITABLE",
        "Primary Key is owned by primaryKeyExpression and cannot be mapped twice.",
        `${path}.propertyApiName`,
      );
    }
    if (property.writeMode === "overlay_only" || property.writeMode === "system_managed") {
      throw new MappingCompileError(
        "MAPPING_PROPERTY_NOT_SOURCE_WRITABLE",
        "Mapping can write only source-backed target Properties.",
        `${path}.propertyApiName`,
      );
    }
    if (mapping.required !== !property.nullable) {
      throw new MappingCompileError(
        "MAPPING_PROPERTY_REQUIRED_MISMATCH",
        "Mapping required flag must match the target Property nullability.",
        `${path}.required`,
      );
    }
    const targetDescriptor = descriptorFromProperty(property);
    const expression = compileExpressionForTarget(
      mapping.expression,
      targetDescriptor,
      common.columnsByName,
      `${path}.expression`,
    );
    const sensitive =
      property.classification === "confidential" || property.classification === "restricted";
    markUsage(common.usages, expression.sourceColumnOrdinals, false, sensitive);
    return Object.freeze({
      propertyApiName: property.apiName,
      required: mapping.required,
      nullPolicy: mapping.nullPolicy,
      targetDescriptor,
      sourceColumnOrdinals: expression.sourceColumnOrdinals,
      expression,
    });
  });
  const mappedPropertyNames = new Set(propertyMappings.map((property) => property.propertyApiName));
  for (const property of targetDefinition.properties) {
    if (
      property.apiName !== primaryKeyProperty.apiName &&
      !property.nullable &&
      (property.writeMode === "source_only" || property.writeMode === "overlay_override") &&
      !mappedPropertyNames.has(property.apiName)
    ) {
      throw new MappingCompileError(
        "MAPPING_PROPERTY_REQUIRED_MISSING",
        "Every non-nullable Base Property requires one explicit Mapping.",
        "$mapping.propertyMappings",
      );
    }
  }

  const preimage = Object.freeze({
    ...planCommonPreimage(common, propertyMappings),
    targetKind: "object" as const,
    primaryKey,
  });
  const planDigest = digestValue(preimage, digestCanonicalText, "$plan.planDigest");
  return Object.freeze({ ...preimage, planDigest });
}

function compileLinkPlan(
  common: PlanCommonInput,
  linkDefinition: LinkTypeDefinition,
  targetBinding: LinkMappingTargetBinding,
  digestCanonicalText: CanonicalTextDigester,
): CompiledLinkMappingPlan {
  if (common.mapping.propertyMappings.length !== 0) {
    throw new MappingCompileError(
      "MAPPING_PROPERTY_NOT_SOURCE_WRITABLE",
      "Link Type v1 has no source-mapped Property surface.",
      "$mapping.propertyMappings",
    );
  }
  if (
    common.mapping.sourceKeyMapping === undefined ||
    common.mapping.targetKeyMapping === undefined
  ) {
    throw new MappingCompileError(
      "MAPPING_ENDPOINT_INVALID",
      "Link Mapping requires both endpoint Key Mappings.",
      "$mapping",
    );
  }
  const sourceKey = compileIdentityKey(
    "source",
    common.mapping.sourceKeyMapping.objectTypeRevisionId,
    common.mapping.sourceKeyMapping.expression,
    linkDefinition.source.objectTypeRevisionId,
    targetBinding.sourceObject,
    common.columnsByName,
    digestCanonicalText,
  );
  const targetKey = compileIdentityKey(
    "target",
    common.mapping.targetKeyMapping.objectTypeRevisionId,
    common.mapping.targetKeyMapping.expression,
    linkDefinition.target.objectTypeRevisionId,
    targetBinding.targetObject,
    common.columnsByName,
    digestCanonicalText,
  );
  markUsage(common.usages, sourceKey.sourceColumnOrdinals, true, true);
  markUsage(common.usages, targetKey.sourceColumnOrdinals, true, true);
  const propertyMappings = Object.freeze([]) as readonly CompiledPropertyMapping[];
  const preimage = Object.freeze({
    ...planCommonPreimage(common, propertyMappings),
    targetKind: "link" as const,
    sourceKey,
    targetKey,
  });
  const planDigest = digestValue(preimage, digestCanonicalText, "$plan.planDigest");
  return Object.freeze({ ...preimage, planDigest });
}

function compileIdentityKey(
  endpoint: "source" | "target",
  mappingRevisionId: OntosId,
  expressionInput: MappingExpression,
  linkRevisionId: OntosId,
  binding: ObjectTypeBinding,
  columnsByName: ReadonlyMap<string, ResolvedColumn>,
  digestCanonicalText: CanonicalTextDigester,
): CompiledIdentityKeyMapping {
  const path = `$compile.target.${endpoint}Object`;
  const objectTypeResourceId = parseOntosId(binding.resourceId, `${path}.resourceId`);
  const objectTypeRevisionId = parseOntosId(binding.revisionId, `${path}.revisionId`);
  if (mappingRevisionId !== objectTypeRevisionId || linkRevisionId !== objectTypeRevisionId) {
    throw new MappingCompileError(
      "MAPPING_ENDPOINT_INVALID",
      "Link endpoint Revision does not match Mapping and Link Type bindings.",
      path,
    );
  }
  const definition = parseObjectTypeDefinition(binding.definition);
  const objectTypeDefinitionDigest = verifyDefinitionDigest(
    binding.definitionDigest,
    definition,
    `${path}.definitionDigest`,
    digestCanonicalText,
  );
  const primaryKeyProperty = definition.properties.find(
    (property) => property.apiName === definition.primaryKeyPropertyApiName,
  );
  if (primaryKeyProperty === undefined) {
    throw new MappingCompileError(
      "MAPPING_ENDPOINT_INVALID",
      "Link endpoint Object Type has no resolvable Primary Key.",
      path,
    );
  }
  const propertyDescriptor = descriptorFromProperty(primaryKeyProperty);
  const expression = compileExpressionForTarget(
    expressionInput,
    propertyDescriptor,
    columnsByName,
    `$mapping.${endpoint}KeyMapping.expression`,
  );
  return Object.freeze({
    objectTypeResourceId,
    objectTypeRevisionId,
    objectTypeDefinitionDigest,
    keyDescriptor: keyDescriptorFromProperty(primaryKeyProperty),
    sourceColumnOrdinals: expression.sourceColumnOrdinals,
    expression,
  });
}

function planCommonPreimage(
  common: PlanCommonInput,
  propertyMappings: readonly CompiledPropertyMapping[],
): Omit<CompiledMappingPlanBase, "planDigest"> {
  const columns = common.resolvedColumns.map((column, index) => {
    const usage = common.usages[index];
    if (usage === undefined) {
      throw new MappingCompileError(
        "MAPPING_CONTRACT_INVALID",
        "Mapping compiler column usage state is incomplete.",
        "$plan.columns",
      );
    }
    return Object.freeze({
      ordinal: column.definition.ordinal,
      columnApiName: column.definition.columnApiName,
      valueType: column.definition.valueType,
      required: column.definition.required,
      descriptor: column.descriptor,
      used: usage.used,
      usedByKey: usage.usedByKey,
      diagnosticNameAllowed: usage.used && !usage.sensitive,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    compilerVersion: MAPPING_COMPILER_VERSION,
    mappingVersion: common.mapping.mappingVersion,
    valueCodecVersion: common.mapping.valueCodecVersion,
    mappingRevisionId: common.mappingRevisionId,
    mappingRevisionDigest: common.mappingRevisionDigest,
    inputSchemaRevisionId: common.inputSchemaRevisionId,
    inputSchemaDigest: common.inputSchemaDigest,
    targetResourceId: common.targetResourceId,
    targetRevisionId: common.targetRevisionId,
    targetDefinitionDigest: common.targetDefinitionDigest,
    qualityRules: common.mapping.qualityRules,
    columns: Object.freeze(columns),
    propertyMappings: Object.freeze([...propertyMappings]),
  });
}

function compileExpressionForTarget(
  expression: MappingExpression,
  targetDescriptor: PropertyDescriptor,
  columnsByName: ReadonlyMap<string, ResolvedColumn>,
  path: string,
): CompiledMappingExpression {
  const compiled = compileExpression(expression, targetDescriptor, columnsByName, path);
  if (compiled.valueType !== targetDescriptor.type) {
    throw new MappingCompileError(
      "MAPPING_EXPRESSION_TYPE_INVALID",
      "Mapping expression type differs from its target; add an explicit cast.",
      path,
    );
  }
  if (compiled.op === "column") {
    const column = [...columnsByName.values()].find(
      (candidate) => candidate.definition.ordinal === compiled.columnOrdinal,
    );
    if (column === undefined || !descriptorsCompatible(column.descriptor, targetDescriptor)) {
      throw new MappingCompileError(
        "MAPPING_EXPRESSION_TYPE_INVALID",
        "Direct column Mapping requires identical immutable type options; add an explicit cast.",
        path,
      );
    }
  }
  return compiled;
}

function compileExpression(
  expression: MappingExpression,
  expectedDescriptor: PropertyDescriptor | undefined,
  columnsByName: ReadonlyMap<string, ResolvedColumn>,
  path: string,
): CompiledMappingExpression {
  if (expression.op === "column") {
    const column = columnsByName.get(expression.columnApiName);
    if (column === undefined) {
      throw new MappingCompileError(
        "MAPPING_COLUMN_UNKNOWN",
        "Mapping expression references a column outside the immutable Snapshot Schema.",
        `${path}.columnApiName`,
      );
    }
    return Object.freeze({
      op: "column",
      valueType: column.definition.valueType,
      columnOrdinal: column.definition.ordinal,
      columnApiName: column.definition.columnApiName,
      sourceColumnOrdinals: Object.freeze([column.definition.ordinal]),
    });
  }
  if (expression.op === "constant") {
    return Object.freeze({
      op: "constant",
      valueType: "string",
      literal: expression.literal,
      sourceColumnOrdinals: Object.freeze([]),
    });
  }
  if (expression.op === "concat") {
    const inputs = expression.inputs.map((input, index) =>
      compileExpression(input, undefined, columnsByName, `${path}.inputs[${String(index)}]`),
    );
    if (inputs.some((input) => input.valueType !== "string")) {
      throw new MappingCompileError(
        "MAPPING_EXPRESSION_TYPE_INVALID",
        "concat accepts only string inputs; add an explicit cast to string.",
        path,
      );
    }
    return Object.freeze({
      op: "concat",
      valueType: "string",
      inputs: Object.freeze(inputs),
      separator: expression.separator,
      sourceColumnOrdinals: mergeOrdinals(inputs.flatMap((input) => input.sourceColumnOrdinals)),
    });
  }

  const targetDescriptor = descriptorForCast(expression.targetValueType, expectedDescriptor, path);
  const input = compileExpression(expression.input, undefined, columnsByName, `${path}.input`);
  if (!castAllowed(input.valueType, targetDescriptor.type)) {
    throw new MappingCompileError(
      "MAPPING_EXPRESSION_TYPE_INVALID",
      "Mapping cast is outside the deterministic conversion allowlist.",
      path,
    );
  }
  return Object.freeze({
    op: "cast",
    valueType: targetDescriptor.type,
    input,
    targetDescriptor,
    sourceColumnOrdinals: input.sourceColumnOrdinals,
  });
}

function descriptorForCast(
  targetValueType: PropertyValueType,
  expectedDescriptor: PropertyDescriptor | undefined,
  path: string,
): PropertyDescriptor {
  if (expectedDescriptor?.type === targetValueType)
    return nonNullableDescriptor(expectedDescriptor);
  if (targetValueType === "decimal" || targetValueType === "enum") {
    throw new MappingCompileError(
      "MAPPING_EXPRESSION_TYPE_INVALID",
      "Decimal and Enum cast require the final target descriptor.",
      path,
    );
  }
  return genericDescriptor(targetValueType);
}

function castAllowed(source: PropertyValueType, target: PropertyValueType): boolean {
  return (
    source === target || source === "string" || (target === "string" && scalarTypes.has(source))
  );
}

function markUsage(
  usages: readonly ColumnUsage[],
  ordinals: readonly number[],
  key: boolean,
  sensitive: boolean,
): void {
  for (const ordinal of ordinals) {
    const usage = usages[ordinal];
    if (usage === undefined) {
      throw new MappingCompileError(
        "MAPPING_COLUMN_UNKNOWN",
        "Compiled Mapping column ordinal is outside the Snapshot Schema.",
        "$mapping",
      );
    }
    usage.used = true;
    usage.usedByKey ||= key;
    usage.sensitive ||= sensitive || key;
  }
}

function assertTargetBinding(
  mapping: MappingDefinition,
  targetResourceId: OntosId,
  targetRevisionId: OntosId,
): void {
  if (
    mapping.targetResourceId !== targetResourceId ||
    mapping.targetRevisionId !== targetRevisionId
  ) {
    bindingMismatch(
      "Mapping target does not match its immutable Resource Revision binding.",
      "$mapping",
    );
  }
}

function bindingMismatch(message: string, path: string): never {
  throw new MappingCompileError("MAPPING_BINDING_MISMATCH", message, path);
}

function verifyDefinitionDigest(
  suppliedInput: unknown,
  definition: unknown,
  path: string,
  digestCanonicalText: CanonicalTextDigester,
): ArtifactDigest {
  const supplied = parseArtifactDigest(suppliedInput, path);
  const actual = digestValue(definition, digestCanonicalText, path);
  if (supplied !== actual) {
    throw new MappingCompileError(
      "MAPPING_DIGEST_MISMATCH",
      "Definition content does not match its immutable digest binding.",
      path,
    );
  }
  return supplied;
}

function digestValue(
  value: unknown,
  digestCanonicalText: CanonicalTextDigester,
  path: string,
): ArtifactDigest {
  return parseArtifactDigest(digestCanonicalText(canonicalizeContractForDigest(value)), path);
}

function descriptorFromSnapshotColumn(column: SnapshotColumnDefinition): PropertyDescriptor {
  if (column.valueType === "decimal") {
    if (column.decimalPrecision === undefined || column.decimalScale === undefined) {
      throw new MappingCompileError(
        "MAPPING_CONTRACT_INVALID",
        "Decimal Snapshot column is missing its immutable format.",
        "$snapshotSchema.columns",
      );
    }
    return Object.freeze({
      type: "decimal",
      precision: column.decimalPrecision,
      scale: column.decimalScale,
      nullable: false,
    });
  }
  if (column.valueType === "enum") {
    if (column.enumValues === undefined) {
      throw new MappingCompileError(
        "MAPPING_CONTRACT_INVALID",
        "Enum Snapshot column is missing its immutable values.",
        "$snapshotSchema.columns",
      );
    }
    return Object.freeze({
      type: "enum",
      values: Object.freeze([...column.enumValues]),
      nullable: false,
    });
  }
  return genericDescriptor(column.valueType);
}

function descriptorFromProperty(property: PropertyDefinition): PropertyDescriptor {
  if (property.valueType === "decimal") {
    if (property.decimalPrecision === undefined || property.decimalScale === undefined) {
      throw new MappingCompileError(
        "MAPPING_CONTRACT_INVALID",
        "Decimal target Property is missing its immutable format.",
        "$target.properties",
      );
    }
    return Object.freeze({
      type: "decimal",
      precision: property.decimalPrecision,
      scale: property.decimalScale,
      nullable: property.nullable,
    });
  }
  if (property.valueType === "enum") {
    if (property.enumValues === undefined) {
      throw new MappingCompileError(
        "MAPPING_CONTRACT_INVALID",
        "Enum target Property is missing its immutable values.",
        "$target.properties",
      );
    }
    return Object.freeze({
      type: "enum",
      values: Object.freeze([...property.enumValues]),
      nullable: property.nullable,
    });
  }
  return Object.freeze({ ...genericDescriptor(property.valueType), nullable: property.nullable });
}

function genericDescriptor(valueType: PropertyValueType): PropertyDescriptor {
  switch (valueType) {
    case "string":
      return Object.freeze({ type: "string", nullable: false });
    case "boolean":
      return Object.freeze({ type: "boolean", nullable: false });
    case "integer":
      return Object.freeze({ type: "integer", nullable: false });
    case "date":
      return Object.freeze({ type: "date", nullable: false });
    case "timestamp":
      return Object.freeze({ type: "timestamp", nullable: false });
    case "string[]":
      return Object.freeze({ type: "string[]", nullable: false });
    case "json":
      return Object.freeze({ type: "json", nullable: false });
    case "decimal":
    case "enum":
      throw new MappingCompileError(
        "MAPPING_EXPRESSION_TYPE_INVALID",
        "Parameterized Value Type requires an immutable descriptor.",
        "$mapping",
      );
  }
}

function nonNullableDescriptor(descriptor: PropertyDescriptor): PropertyDescriptor {
  return Object.freeze({ ...descriptor, nullable: false });
}

function keyDescriptorFromProperty(property: PropertyDefinition): PrimaryKeyComponentDescriptor {
  if (property.valueType === "string") {
    if (property.caseSensitive === undefined) {
      throw new MappingCompileError(
        "MAPPING_CONTRACT_INVALID",
        "String Primary Key requires an immutable case rule.",
        "$target.primaryKeyPropertyApiName",
      );
    }
    return Object.freeze({ type: "string", caseSensitive: property.caseSensitive });
  }
  const descriptor = descriptorFromProperty(property);
  if (descriptor.type === "string[]" || descriptor.type === "json") {
    throw new MappingCompileError(
      "MAPPING_CONTRACT_INVALID",
      "Primary Key must use a stable scalar descriptor.",
      "$target.primaryKeyPropertyApiName",
    );
  }
  return nonNullableDescriptor(descriptor) as PrimaryKeyComponentDescriptor;
}

function descriptorsCompatible(left: PropertyDescriptor, right: PropertyDescriptor): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "decimal" && right.type === "decimal") {
    return left.precision === right.precision && left.scale === right.scale;
  }
  if (left.type === "enum" && right.type === "enum") {
    return (
      left.values.length === right.values.length &&
      left.values.every((value, index) => value === right.values[index])
    );
  }
  return true;
}

function mergeOrdinals(ordinals: readonly number[]): readonly number[] {
  return Object.freeze([...new Set(ordinals)].sort((left, right) => left - right));
}

export function createMappingExecution(
  input: CreateMappingExecutionInput,
): MappingExecutionSession {
  return new DeterministicMappingExecution(input);
}

export async function executeMappingRows(
  input: CreateMappingExecutionInput & { readonly rows: AsyncIterable<MappingSourceRow> },
): Promise<MappingExecutionSummary> {
  const execution = createMappingExecution(input);
  for await (const row of input.rows) await execution.consumeRow(row);
  return execution.finish();
}

class DeterministicMappingExecution implements MappingExecutionSession {
  readonly #plan: CompiledMappingPlan;
  readonly #sourceContentDigest: ArtifactDigest;
  readonly #digestCanonicalText: CanonicalTextDigester;
  readonly #sink: MappingEventSink | undefined;
  readonly #aggregates = new Map<
    string,
    Omit<MappingErrorAggregate, "count"> & { count: number }
  >();

  #streamDigest: ArtifactDigest;
  #sourceRowCount = 0;
  #acceptedRowCount = 0;
  #rejectedRowCount = 0;
  #finished = false;

  constructor(input: CreateMappingExecutionInput) {
    this.#plan = input.plan;
    this.#digestCanonicalText = input.digestCanonicalText;
    try {
      this.#sourceContentDigest = parseArtifactDigest(
        input.sourceContentDigest,
        "$execution.sourceContentDigest",
      );
      this.#streamDigest = digestValue(
        {
          streamDigestVersion: MAPPING_STREAM_DIGEST_VERSION,
          planDigest: input.plan.planDigest,
          sourceContentDigest: this.#sourceContentDigest,
        },
        this.#digestCanonicalText,
        "$execution.mappedStreamDigest",
      );
    } catch (error) {
      throw new MappingExecutionError(
        "MAPPING_SOURCE_DIGEST_INVALID",
        "Mapping execution source digest or digest adapter is invalid.",
        { cause: error },
      );
    }
    this.#sink = input.sink;
  }

  async consumeRow(row: MappingSourceRow): Promise<void> {
    if (this.#finished) {
      throw new MappingExecutionError(
        "MAPPING_EXECUTION_ALREADY_FINISHED",
        "Mapping execution cannot consume rows after finish.",
      );
    }
    const expectedRowNumber = this.#sourceRowCount + 1;
    if (!Number.isSafeInteger(row.rowNumber) || row.rowNumber !== expectedRowNumber) {
      throw new MappingExecutionError(
        "MAPPING_ROW_SEQUENCE_INVALID",
        "Mapping rows must be contiguous and ordered from one.",
      );
    }
    if (
      !Array.isArray(row.values) ||
      row.values.length !== this.#plan.columns.length ||
      row.values.some((value) => typeof value !== "string")
    ) {
      throw new MappingExecutionError(
        "MAPPING_ROW_WIDTH_INVALID",
        "Mapping row does not match the compiled Snapshot Schema width.",
      );
    }

    const event = evaluateMappingRow(this.#plan, row);
    this.#sourceRowCount += 1;
    if (event.kind === "rejected") {
      this.#rejectedRowCount += 1;
      for (const error of event.errors) this.#recordError(error);
    } else {
      this.#acceptedRowCount += 1;
    }
    this.#streamDigest = digestValue(
      {
        streamDigestVersion: MAPPING_STREAM_DIGEST_VERSION,
        previousDigest: this.#streamDigest,
        event,
      },
      this.#digestCanonicalText,
      "$execution.mappedStreamDigest",
    );
    try {
      await this.#sink?.write(event);
    } catch (error) {
      this.#finished = true;
      throw new MappingExecutionError(
        "MAPPING_EVENT_SINK_FAILED",
        "Mapping event sink failed; this execution cannot continue.",
        { cause: error },
      );
    }
  }

  finish(): MappingExecutionSummary {
    if (this.#finished) {
      throw new MappingExecutionError(
        "MAPPING_EXECUTION_ALREADY_FINISHED",
        "Mapping execution can be finished only once.",
      );
    }
    this.#finished = true;
    const errorAggregates = [...this.#aggregates.values()]
      .sort((left, right) => compareText(aggregateKey(left), aggregateKey(right)))
      .map((aggregate) => Object.freeze({ ...aggregate }));
    return Object.freeze({
      schemaVersion: 1,
      streamDigestVersion: MAPPING_STREAM_DIGEST_VERSION,
      planDigest: this.#plan.planDigest,
      sourceContentDigest: this.#sourceContentDigest,
      sourceRowCount: this.#sourceRowCount,
      acceptedRowCount: this.#acceptedRowCount,
      rejectedRowCount: this.#rejectedRowCount,
      errorAggregates: Object.freeze(errorAggregates),
      mappedStreamDigest: this.#streamDigest,
    });
  }

  #recordError(error: MappingRowError): void {
    const aggregate = {
      reasonCode: error.reasonCode,
      mappingCode: error.mappingCode,
      codecCode: error.codecCode ?? null,
    };
    const key = aggregateKey(aggregate);
    const existing = this.#aggregates.get(key);
    if (existing === undefined) this.#aggregates.set(key, { ...aggregate, count: 1 });
    else existing.count += 1;
  }
}

function evaluateMappingRow(plan: CompiledMappingPlan, row: MappingSourceRow): MappingRowEvent {
  const parsed = plan.columns.map((column, index) =>
    parseSourceCell(row.values[index] ?? "", column),
  );
  const sourceErrors: MappingRowError[] = [];
  for (const [index, cell] of parsed.entries()) {
    const column = plan.columns[index];
    if (column === undefined) continue;
    if (!cell.ok) {
      sourceErrors.push(
        mappingRowError(
          column.required ? "REQUIRED_PROPERTY_INVALID" : "OPTIONAL_PROPERTY_INVALID",
          "MAPPING_SOURCE_VALUE_INVALID",
          cell.codecCode,
          column.diagnosticNameAllowed ? column.columnApiName : undefined,
        ),
      );
    } else if (cell.value === null && column.required && !column.usedByKey) {
      sourceErrors.push(
        mappingRowError(
          "REQUIRED_PROPERTY_INVALID",
          "MAPPING_SOURCE_REQUIRED_NULL",
          undefined,
          column.diagnosticNameAllowed ? column.columnApiName : undefined,
        ),
      );
    }
  }
  if (sourceErrors.length > 0) return rejectedRow(row.rowNumber, sourceErrors);
  return plan.targetKind === "object"
    ? evaluateObjectRow(plan, row.rowNumber, parsed)
    : evaluateLinkRow(plan, row.rowNumber, parsed);
}

function evaluateObjectRow(
  plan: CompiledObjectMappingPlan,
  rowNumber: number,
  parsed: readonly ParsedCell[],
): MappingRowEvent {
  const errors: MappingRowError[] = [];
  const primaryResult = evaluateExpression(plan.primaryKey.expression, parsed);
  let canonicalPrimaryKey: CanonicalPrimaryKey | null = null;
  let primaryValue: CanonicalPropertyValue | null = null;
  if (!primaryResult.ok) {
    errors.push(
      mappingRowError(
        "REQUIRED_PROPERTY_INVALID",
        "MAPPING_PRIMARY_KEY_INVALID",
        primaryResult.codecCode,
      ),
    );
  } else if (primaryResult.value === null) {
    errors.push(mappingRowError("PRIMARY_KEY_NULL", "MAPPING_PRIMARY_KEY_NULL"));
  } else {
    try {
      primaryValue = canonicalizePropertyValue(
        primaryResult.value,
        nonNullableDescriptor(plan.primaryKey.propertyDescriptor),
      );
      canonicalPrimaryKey = canonicalizePrimaryKey([primaryValue], {
        components: [plan.primaryKey.keyDescriptor],
      });
    } catch (error) {
      if (!(error instanceof ValueCodecError)) throw error;
      errors.push(
        mappingRowError("REQUIRED_PROPERTY_INVALID", "MAPPING_PRIMARY_KEY_INVALID", error.code),
      );
    }
  }

  const mappedProperties: MappedProperty[] = [];
  for (const property of plan.propertyMappings) {
    const evaluated = evaluateExpression(property.expression, parsed);
    if (!evaluated.ok) {
      errors.push(
        mappingRowError(
          property.required ? "REQUIRED_PROPERTY_INVALID" : "OPTIONAL_PROPERTY_INVALID",
          "MAPPING_PROPERTY_INVALID",
          evaluated.codecCode,
          diagnosticColumn(plan, property.sourceColumnOrdinals),
        ),
      );
      continue;
    }
    if (evaluated.value === null) {
      if (property.required || property.nullPolicy === "reject_row") {
        errors.push(
          mappingRowError(
            property.required ? "REQUIRED_PROPERTY_INVALID" : "OPTIONAL_PROPERTY_INVALID",
            "MAPPING_PROPERTY_NULL",
            undefined,
            diagnosticColumn(plan, property.sourceColumnOrdinals),
          ),
        );
      } else {
        mappedProperties.push(mappedProperty(plan, property, null));
      }
      continue;
    }
    try {
      const value = canonicalizePropertyValue(evaluated.value, property.targetDescriptor);
      mappedProperties.push(mappedProperty(plan, property, value));
    } catch (error) {
      if (!(error instanceof ValueCodecError)) throw error;
      errors.push(
        mappingRowError(
          property.required ? "REQUIRED_PROPERTY_INVALID" : "OPTIONAL_PROPERTY_INVALID",
          "MAPPING_PROPERTY_INVALID",
          error.code,
          diagnosticColumn(plan, property.sourceColumnOrdinals),
        ),
      );
    }
  }
  if (errors.length > 0 || canonicalPrimaryKey === null || primaryValue === null) {
    return rejectedRow(rowNumber, errors);
  }
  mappedProperties.push(
    Object.freeze({
      propertyApiName: plan.primaryKey.propertyApiName,
      valueType: plan.primaryKey.propertyDescriptor.type,
      value: mappedValue(primaryValue, plan.primaryKey.propertyDescriptor),
      sourceColumnApiNames: sourceColumnNames(plan, plan.primaryKey.sourceColumnOrdinals),
    }),
  );
  mappedProperties.sort((left, right) => compareText(left.propertyApiName, right.propertyApiName));
  return Object.freeze({
    kind: "object",
    rowNumber,
    targetResourceId: plan.targetResourceId,
    targetRevisionId: plan.targetRevisionId,
    canonicalPrimaryKey,
    properties: Object.freeze(mappedProperties),
  });
}

function evaluateLinkRow(
  plan: CompiledLinkMappingPlan,
  rowNumber: number,
  parsed: readonly ParsedCell[],
): MappingRowEvent {
  const errors: MappingRowError[] = [];
  const sourceLookup = evaluateIdentityLookup(plan, plan.sourceKey, parsed, errors);
  const targetLookup = evaluateIdentityLookup(plan, plan.targetKey, parsed, errors);
  if (errors.length > 0 || sourceLookup === null || targetLookup === null) {
    return rejectedRow(rowNumber, errors);
  }
  return Object.freeze({
    kind: "link",
    rowNumber,
    targetResourceId: plan.targetResourceId,
    targetRevisionId: plan.targetRevisionId,
    sourceLookup,
    targetLookup,
  });
}

function evaluateIdentityLookup(
  plan: CompiledLinkMappingPlan,
  key: CompiledIdentityKeyMapping,
  parsed: readonly ParsedCell[],
  errors: MappingRowError[],
): IdentityLookupCandidate | null {
  const result = evaluateExpression(key.expression, parsed);
  if (!result.ok) {
    errors.push(
      mappingRowError("REQUIRED_PROPERTY_INVALID", "MAPPING_LINK_KEY_INVALID", result.codecCode),
    );
    return null;
  }
  if (result.value === null) {
    errors.push(mappingRowError("REQUIRED_PROPERTY_INVALID", "MAPPING_LINK_KEY_NULL"));
    return null;
  }
  try {
    const canonicalPrimaryKey = canonicalizePrimaryKey([result.value], {
      components: [key.keyDescriptor],
    });
    return Object.freeze({
      objectTypeResourceId: key.objectTypeResourceId,
      objectTypeRevisionId: key.objectTypeRevisionId,
      canonicalPrimaryKey,
      sourceColumnApiNames: sourceColumnNames(plan, key.sourceColumnOrdinals),
    });
  } catch (error) {
    if (!(error instanceof ValueCodecError)) throw error;
    errors.push(
      mappingRowError("REQUIRED_PROPERTY_INVALID", "MAPPING_LINK_KEY_INVALID", error.code),
    );
    return null;
  }
}

function parseSourceCell(value: string, column: CompiledMappingColumn): ParsedCell {
  if (value.length === 0) return { ok: true, value: null };
  try {
    return {
      ok: true,
      value: canonicalizePropertyValue(textCandidate(value, column.descriptor), column.descriptor),
    };
  } catch (error) {
    if (!(error instanceof ValueCodecError)) throw error;
    return { ok: false, codecCode: error.code };
  }
}

function evaluateExpression(
  expression: CompiledMappingExpression,
  parsed: readonly ParsedCell[],
): EvaluatedExpression {
  if (expression.op === "column") {
    const cell = parsed[expression.columnOrdinal];
    if (cell === undefined) {
      throw new MappingExecutionError(
        "MAPPING_ROW_WIDTH_INVALID",
        "Compiled Mapping column is outside the source row.",
      );
    }
    return cell;
  }
  if (expression.op === "constant") return { ok: true, value: expression.literal };
  if (expression.op === "concat") {
    const values: string[] = [];
    for (const input of expression.inputs) {
      const result = evaluateExpression(input, parsed);
      if (!result.ok) return result;
      if (result.value === null) return { ok: true, value: null };
      if (typeof result.value !== "string") {
        throw new MappingExecutionError(
          "MAPPING_ROW_WIDTH_INVALID",
          "Compiled concat received a non-string value.",
        );
      }
      values.push(result.value);
    }
    return { ok: true, value: values.join(expression.separator) };
  }
  const input = evaluateExpression(expression.input, parsed);
  if (!input.ok || input.value === null) return input;
  try {
    return {
      ok: true,
      value: castValue(input.value, expression.input.valueType, expression.targetDescriptor),
    };
  } catch (error) {
    if (!(error instanceof ValueCodecError)) throw error;
    return { ok: false, codecCode: error.code };
  }
}

function castValue(
  value: Exclude<CanonicalPropertyValue, null>,
  sourceType: PropertyValueType,
  targetDescriptor: PropertyDescriptor,
): CanonicalPropertyValue {
  if (targetDescriptor.type === "string") {
    if (typeof value !== "string" && typeof value !== "boolean") {
      throw new ValueCodecError(
        "VALUE_TYPE_MISMATCH",
        "Only deterministic scalar values can cast to string.",
      );
    }
    return canonicalizePropertyValue(String(value), targetDescriptor);
  }
  if (sourceType === "string") {
    if (typeof value !== "string") {
      throw new ValueCodecError("VALUE_TYPE_MISMATCH", "String cast input is invalid.");
    }
    return canonicalizePropertyValue(textCandidate(value, targetDescriptor), targetDescriptor);
  }
  if (sourceType === targetDescriptor.type) {
    return canonicalizePropertyValue(value, targetDescriptor);
  }
  throw new ValueCodecError(
    "VALUE_TYPE_MISMATCH",
    "Cast is outside the deterministic conversion allowlist.",
  );
}

function textCandidate(value: string, descriptor: PropertyDescriptor): unknown {
  if (descriptor.type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new ValueCodecError(
      "VALUE_TYPE_MISMATCH",
      "Boolean CSV text must be exactly true or false.",
    );
  }
  if (descriptor.type === "string[]" || descriptor.type === "json") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new ValueCodecError("JSON_VALUE_INVALID", "CSV JSON text is invalid.", "$value");
    }
  }
  return value;
}

function mappedProperty(
  plan: CompiledObjectMappingPlan,
  property: CompiledPropertyMapping,
  value: CanonicalPropertyValue,
): MappedProperty {
  return Object.freeze({
    propertyApiName: property.propertyApiName,
    valueType: property.targetDescriptor.type,
    value: mappedValue(value, property.targetDescriptor),
    sourceColumnApiNames: sourceColumnNames(plan, property.sourceColumnOrdinals),
  });
}

function mappedValue(
  value: CanonicalPropertyValue,
  descriptor: PropertyDescriptor,
): MappedPropertyValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (descriptor.type === "string[]") {
    if (!isStringArray(value)) {
      throw new MappingExecutionError(
        "MAPPING_ROW_WIDTH_INVALID",
        "Compiled string array produced an invalid canonical value.",
      );
    }
    return Object.freeze(value.map((item) => item));
  }
  if (descriptor.type === "json") {
    return Object.freeze({
      kind: "canonical_json",
      canonicalJson: canonicalizeRestrictedJson(value),
    });
  }
  throw new MappingExecutionError(
    "MAPPING_ROW_WIDTH_INVALID",
    "Compiled Property produced an invalid canonical value.",
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function mappingRowError(
  reasonCode: MaterializationReasonCode,
  mappingCode: MappingRowErrorCode,
  codecCode?: ValueCodecErrorCode,
  columnApiName?: string,
): MappingRowError {
  return Object.freeze({
    reasonCode,
    mappingCode,
    ...(codecCode === undefined ? {} : { codecCode }),
    ...(columnApiName === undefined ? {} : { columnApiName }),
  });
}

function rejectedRow(rowNumber: number, errors: readonly MappingRowError[]): MappingRejectedRow {
  return Object.freeze({
    kind: "rejected",
    rowNumber,
    errors: Object.freeze([...errors]),
  });
}

function diagnosticColumn(
  plan: CompiledMappingPlan,
  ordinals: readonly number[],
): string | undefined {
  if (ordinals.length !== 1) return undefined;
  const column = plan.columns[ordinals[0] ?? -1];
  return column?.diagnosticNameAllowed === true ? column.columnApiName : undefined;
}

function sourceColumnNames(
  plan: CompiledMappingPlan,
  ordinals: readonly number[],
): readonly string[] {
  return Object.freeze(
    ordinals.map((ordinal) => {
      const column = plan.columns[ordinal];
      if (column === undefined) {
        throw new MappingExecutionError(
          "MAPPING_ROW_WIDTH_INVALID",
          "Compiled Mapping provenance column is outside the source Schema.",
        );
      }
      return column.columnApiName;
    }),
  );
}

function aggregateKey(
  aggregate: Pick<MappingErrorAggregate, "reasonCode" | "mappingCode" | "codecCode">,
): string {
  return `${aggregate.reasonCode}\u0000${aggregate.mappingCode}\u0000${aggregate.codecCode ?? ""}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
