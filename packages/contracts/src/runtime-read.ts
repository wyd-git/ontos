import { failContract } from "./error.ts";
import {
  IDENTITY_DELEGATION_SUMMARY_FIELDS,
  parseIdentityDelegationSummary,
  type IdentityDelegationSummary,
} from "./identity.ts";
import {
  cloneRestrictedJsonValue,
  requireArray,
  requireBoolean,
  requireObjectShape,
  requireOneOf,
  requirePlainRecord,
  requireString,
  type ContractJsonValue,
} from "./internal.ts";
import {
  API_NAME_PATTERN,
  PROPERTY_VALUE_TYPE_VALUES,
  type PropertyValueType,
} from "./metadata.ts";
import {
  QUERY_COMPARISON_OPERATOR_VALUES,
  QUERY_LINK_MAXIMUM_HOPS,
  QUERY_LINK_PAGE_MAXIMUM_SIZE,
  QUERY_PAGE_MAXIMUM_SIZE,
  QUERY_SELECT_MAXIMUM_ITEMS,
  type OpaqueCursor,
  type QueryComparisonOperator,
  type QuerySort,
  parseOpaqueCursor,
} from "./query.ts";
import {
  parseCanonicalInstant,
  parseCorrelationId,
  parseOntosId,
  parseSchemaVersion,
  type CanonicalInstant,
  type ContractSchemaVersion,
  type CorrelationId,
  type OntosId,
} from "./scalars.ts";

export type RuntimeIdentityContext = IdentityDelegationSummary;
export type RuntimeFilterOperator = QueryComparisonOperator | "isNull";

export const RUNTIME_PROPERTY_DISPOSITION_VALUES = Object.freeze([
  "allow",
  "mask",
  "restricted",
] as const);
export type RuntimePropertyDisposition = (typeof RUNTIME_PROPERTY_DISPOSITION_VALUES)[number];

export const RUNTIME_PROPERTY_STATE_VALUES = Object.freeze([
  "value",
  "null",
  "missing",
  "masked",
  "restricted",
] as const);
export type RuntimePropertyState = (typeof RUNTIME_PROPERTY_STATE_VALUES)[number];

export const RUNTIME_WARNING_CODE_PATTERN = "^[A-Z][A-Z0-9_]{2,63}$";
export const RUNTIME_WARNING_MAXIMUM_ITEMS = 32;
export const RUNTIME_WARNING_MESSAGE_MAXIMUM_LENGTH = 256;
export const RUNTIME_OBJECT_VERSION_PATTERN = "^[1-9][0-9]{0,18}$";
export const RUNTIME_COUNT_PATTERN = "^(?:0|[1-9][0-9]{0,18})$";
export const RUNTIME_PRIMARY_KEY_MAXIMUM_LENGTH = 1_024;
export const RUNTIME_PROPERTY_VALUE_MAXIMUM_BYTES = 16_384;
export const RUNTIME_PROPERTY_VALUE_MAXIMUM_DEPTH = 5;
export const RUNTIME_PROPERTY_VALUE_MAXIMUM_NODES = 512;
export const RUNTIME_METADATA_OBJECT_TYPE_MAXIMUM_ITEMS = 256;
export const RUNTIME_METADATA_PROPERTY_MAXIMUM_ITEMS = QUERY_SELECT_MAXIMUM_ITEMS;
export const RUNTIME_METADATA_LINK_MAXIMUM_ITEMS = 256;

const apiNameExpression = new RegExp(API_NAME_PATTERN, "u");
const warningCodeExpression = new RegExp(RUNTIME_WARNING_CODE_PATTERN, "u");
const objectVersionExpression = new RegExp(RUNTIME_OBJECT_VERSION_PATTERN, "u");
const countExpression = new RegExp(RUNTIME_COUNT_PATTERN, "u");
const propertyValueTypes = new Set<PropertyValueType>(PROPERTY_VALUE_TYPE_VALUES);
const propertyDispositions = new Set<RuntimePropertyDisposition>(
  RUNTIME_PROPERTY_DISPOSITION_VALUES,
);
const propertyStates = new Set<RuntimePropertyState>(RUNTIME_PROPERTY_STATE_VALUES);
const queryOperators = new Set<QueryComparisonOperator>(QUERY_COMPARISON_OPERATOR_VALUES);

export interface RuntimePropertyMetadata {
  readonly apiName: string;
  readonly displayName: string;
  readonly valueType: PropertyValueType;
  readonly disposition: RuntimePropertyDisposition;
  readonly nullable: boolean;
  readonly filterOperators: readonly RuntimeFilterOperator[];
  readonly sortable: boolean;
  readonly searchable: boolean;
}

export interface RuntimeLinkMetadata {
  readonly apiName: string;
  readonly displayName: string;
  readonly targetObjectTypeApiName: string;
  readonly direction: "outgoing" | "incoming";
}

export interface RuntimeObjectTypeMetadata {
  readonly apiName: string;
  readonly displayName: string;
  readonly titlePropertyApiName: string | null;
  readonly defaultSearchProperties: readonly string[];
  readonly defaultSort: QuerySort | null;
  readonly properties: readonly RuntimePropertyMetadata[];
  readonly links: readonly RuntimeLinkMetadata[];
}

export interface RuntimeWarning {
  readonly code: string;
  readonly message: string;
}

export interface RuntimeObjectReference {
  readonly objectTypeApiName: string;
  readonly primaryKey: string;
}

export interface RuntimeValuePropertyResult {
  readonly apiName: string;
  readonly state: "value";
  readonly value: Exclude<ContractJsonValue, null>;
}

export interface RuntimeNullPropertyResult {
  readonly apiName: string;
  readonly state: "null";
  readonly value: null;
}

export interface RuntimeMissingPropertyResult {
  readonly apiName: string;
  readonly state: "missing";
}

export interface RuntimeMaskedPropertyResult {
  readonly apiName: string;
  readonly state: "masked";
  readonly displayValue: string;
}

export interface RuntimeRestrictedPropertyResult {
  readonly apiName: string;
  readonly state: "restricted";
}

export type RuntimePropertyResult =
  | RuntimeValuePropertyResult
  | RuntimeNullPropertyResult
  | RuntimeMissingPropertyResult
  | RuntimeMaskedPropertyResult
  | RuntimeRestrictedPropertyResult;

export interface RuntimeObject {
  readonly reference: RuntimeObjectReference;
  readonly objectVersion: string;
  readonly properties: readonly RuntimePropertyResult[];
}

export interface RuntimeResponseMetadata {
  readonly schemaVersion: ContractSchemaVersion;
  readonly releaseId: OntosId;
  readonly releaseRevisionId: OntosId;
  readonly readTimestamp: CanonicalInstant;
  readonly correlationId: CorrelationId;
  readonly warnings: readonly RuntimeWarning[];
}

export interface RuntimeMetadataResponse extends RuntimeResponseMetadata {
  readonly data: readonly RuntimeObjectTypeMetadata[];
}

export interface RuntimeObjectGetResponse extends RuntimeResponseMetadata {
  readonly data: RuntimeObject;
}

export interface RuntimeSearchResponse extends RuntimeResponseMetadata {
  readonly data: readonly RuntimeObject[];
  readonly nextCursor: OpaqueCursor | null;
}

export interface RuntimeCountResponse extends RuntimeResponseMetadata {
  readonly count: string;
}

export interface RuntimeResolvedLinkHop {
  readonly linkTypeApiName: string;
  readonly direction: "outgoing" | "incoming";
}

export interface RuntimeLinkSearchResponse extends RuntimeResponseMetadata {
  readonly resolvedPath: readonly RuntimeResolvedLinkHop[];
  readonly data: readonly RuntimeObject[];
  readonly nextCursor: OpaqueCursor | null;
}

export const RUNTIME_IDENTITY_CONTEXT_FIELDS = IDENTITY_DELEGATION_SUMMARY_FIELDS;
export const RUNTIME_PROPERTY_METADATA_FIELDS = Object.freeze([
  "apiName",
  "displayName",
  "valueType",
  "disposition",
  "nullable",
  "filterOperators",
  "sortable",
  "searchable",
] as const);
export const RUNTIME_LINK_METADATA_FIELDS = Object.freeze([
  "apiName",
  "displayName",
  "targetObjectTypeApiName",
  "direction",
] as const);
export const RUNTIME_OBJECT_TYPE_METADATA_FIELDS = Object.freeze([
  "apiName",
  "displayName",
  "titlePropertyApiName",
  "defaultSearchProperties",
  "defaultSort",
  "properties",
  "links",
] as const);
export const RUNTIME_WARNING_FIELDS = Object.freeze(["code", "message"] as const);
export const RUNTIME_OBJECT_REFERENCE_FIELDS = Object.freeze([
  "objectTypeApiName",
  "primaryKey",
] as const);
export const RUNTIME_PROPERTY_RESULT_FIELDS = Object.freeze([
  "apiName",
  "state",
  "value",
  "displayValue",
] as const);
export const RUNTIME_PROPERTY_RESULT_REQUIRED_FIELDS = Object.freeze(["apiName", "state"] as const);
export const RUNTIME_OBJECT_FIELDS = Object.freeze([
  "reference",
  "objectVersion",
  "properties",
] as const);
export const RUNTIME_RESPONSE_METADATA_FIELDS = Object.freeze([
  "schemaVersion",
  "releaseId",
  "releaseRevisionId",
  "readTimestamp",
  "correlationId",
  "warnings",
] as const);
export const RUNTIME_METADATA_RESPONSE_FIELDS = Object.freeze([
  ...RUNTIME_RESPONSE_METADATA_FIELDS,
  "data",
] as const);
export const RUNTIME_OBJECT_GET_RESPONSE_FIELDS = Object.freeze([
  ...RUNTIME_RESPONSE_METADATA_FIELDS,
  "data",
] as const);
export const RUNTIME_SEARCH_RESPONSE_FIELDS = Object.freeze([
  ...RUNTIME_RESPONSE_METADATA_FIELDS,
  "data",
  "nextCursor",
] as const);
export const RUNTIME_COUNT_RESPONSE_FIELDS = Object.freeze([
  ...RUNTIME_RESPONSE_METADATA_FIELDS,
  "count",
] as const);
export const RUNTIME_RESOLVED_LINK_HOP_FIELDS = Object.freeze([
  "linkTypeApiName",
  "direction",
] as const);
export const RUNTIME_LINK_SEARCH_RESPONSE_FIELDS = Object.freeze([
  ...RUNTIME_RESPONSE_METADATA_FIELDS,
  "resolvedPath",
  "data",
  "nextCursor",
] as const);

export function parseRuntimeIdentityContext(value: unknown): RuntimeIdentityContext {
  return parseIdentityDelegationSummary(value);
}

export function parseRuntimeMetadataResponse(value: unknown): RuntimeMetadataResponse {
  const path = "$runtimeMetadataResponse";
  const record = strictRecord(
    value,
    path,
    RUNTIME_METADATA_RESPONSE_FIELDS,
    RUNTIME_METADATA_RESPONSE_FIELDS,
  );
  const metadata = parseResponseMetadata(record, path);
  const data = Object.freeze(
    requireArray(record.data, `${path}.data`, {
      maximumItems: RUNTIME_METADATA_OBJECT_TYPE_MAXIMUM_ITEMS,
    }).map((item, index) => parseObjectTypeMetadata(item, `${path}.data[${index}]`)),
  );
  assertUnique(
    data.map(({ apiName }) => apiName),
    `${path}.data`,
  );
  return Object.freeze({ ...metadata, data });
}

export function parseRuntimeObjectGetResponse(value: unknown): RuntimeObjectGetResponse {
  const path = "$runtimeObjectGetResponse";
  const record = strictRecord(
    value,
    path,
    RUNTIME_OBJECT_GET_RESPONSE_FIELDS,
    RUNTIME_OBJECT_GET_RESPONSE_FIELDS,
  );
  return Object.freeze({
    ...parseResponseMetadata(record, path),
    data: parseRuntimeObject(record.data, `${path}.data`),
  });
}

export function parseRuntimeSearchResponse(value: unknown): RuntimeSearchResponse {
  const path = "$runtimeSearchResponse";
  const record = strictRecord(
    value,
    path,
    RUNTIME_SEARCH_RESPONSE_FIELDS,
    RUNTIME_SEARCH_RESPONSE_FIELDS,
  );
  return Object.freeze({
    ...parseResponseMetadata(record, path),
    data: parseObjectPage(record.data, `${path}.data`, QUERY_PAGE_MAXIMUM_SIZE),
    nextCursor:
      record.nextCursor === null
        ? null
        : parseOpaqueCursor(record.nextCursor, `${path}.nextCursor`),
  });
}

export function parseRuntimeCountResponse(value: unknown): RuntimeCountResponse {
  const path = "$runtimeCountResponse";
  const record = strictRecord(
    value,
    path,
    RUNTIME_COUNT_RESPONSE_FIELDS,
    RUNTIME_COUNT_RESPONSE_FIELDS,
  );
  return Object.freeze({
    ...parseResponseMetadata(record, path),
    count: requireString(record.count, `${path}.count`, {
      minimumLength: 1,
      maximumLength: 19,
      pattern: countExpression,
    }),
  });
}

export function parseRuntimeLinkSearchResponse(value: unknown): RuntimeLinkSearchResponse {
  const path = "$runtimeLinkSearchResponse";
  const record = strictRecord(
    value,
    path,
    RUNTIME_LINK_SEARCH_RESPONSE_FIELDS,
    RUNTIME_LINK_SEARCH_RESPONSE_FIELDS,
  );
  return Object.freeze({
    ...parseResponseMetadata(record, path),
    resolvedPath: Object.freeze(
      requireArray(record.resolvedPath, `${path}.resolvedPath`, {
        minimumItems: 1,
        maximumItems: QUERY_LINK_MAXIMUM_HOPS,
      }).map((item, index) => parseResolvedLinkHop(item, `${path}.resolvedPath[${index}]`)),
    ),
    data: parseObjectPage(record.data, `${path}.data`, QUERY_LINK_PAGE_MAXIMUM_SIZE),
    nextCursor:
      record.nextCursor === null
        ? null
        : parseOpaqueCursor(record.nextCursor, `${path}.nextCursor`),
  });
}

export function parseRuntimePropertyResult(
  value: unknown,
  path = "$runtimePropertyResult",
): RuntimePropertyResult {
  const record = strictRecord(
    value,
    path,
    RUNTIME_PROPERTY_RESULT_FIELDS,
    RUNTIME_PROPERTY_RESULT_REQUIRED_FIELDS,
  );
  const state = requireOneOf(record.state, propertyStates, `${path}.state`);
  const hasValue = Object.hasOwn(record, "value");
  const hasDisplayValue = Object.hasOwn(record, "displayValue");
  if (state === "value") {
    if (!hasValue || record.value === null || hasDisplayValue) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "Value state requires one non-null value and forbids displayValue.",
        path,
      );
    }
  } else if (state === "null") {
    if (!hasValue || record.value !== null || hasDisplayValue) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "Null state requires an explicit null and forbids displayValue.",
        path,
      );
    }
  } else if (state === "masked") {
    if (hasValue || !hasDisplayValue) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "Masked state requires displayValue and forbids the real value.",
        path,
      );
    }
  } else if (hasValue || hasDisplayValue) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Missing and restricted states cannot carry values.",
      path,
    );
  }
  const apiName = parseApiName(record.apiName, `${path}.apiName`);
  if (state === "value") {
    const parsedValue = cloneRestrictedJsonValue(
      record.value,
      `${path}.value`,
      RUNTIME_PROPERTY_VALUE_MAXIMUM_BYTES,
      RUNTIME_PROPERTY_VALUE_MAXIMUM_DEPTH,
      RUNTIME_PROPERTY_VALUE_MAXIMUM_NODES,
    );
    if (parsedValue === null) {
      failContract("CONTRACT_FORMAT_INVALID", "Value state cannot contain null.", `${path}.value`);
    }
    return Object.freeze({ apiName, state, value: parsedValue });
  }
  if (state === "null") return Object.freeze({ apiName, state, value: null });
  if (state === "masked") {
    return Object.freeze({
      apiName,
      state,
      displayValue: requireString(record.displayValue, `${path}.displayValue`, {
        minimumLength: 1,
        maximumLength: 256,
      }),
    });
  }
  return Object.freeze({ apiName, state });
}

function parseObjectTypeMetadata(value: unknown, path: string): RuntimeObjectTypeMetadata {
  const record = strictRecord(
    value,
    path,
    RUNTIME_OBJECT_TYPE_METADATA_FIELDS,
    RUNTIME_OBJECT_TYPE_METADATA_FIELDS,
  );
  const properties = Object.freeze(
    requireArray(record.properties, `${path}.properties`, {
      minimumItems: 1,
      maximumItems: RUNTIME_METADATA_PROPERTY_MAXIMUM_ITEMS,
    }).map((item, index) => parsePropertyMetadata(item, `${path}.properties[${index}]`)),
  );
  assertUnique(
    properties.map(({ apiName }) => apiName),
    `${path}.properties`,
  );
  const propertyByName = new Map(properties.map((property) => [property.apiName, property]));
  const titlePropertyApiName =
    record.titlePropertyApiName === null
      ? null
      : parseApiName(record.titlePropertyApiName, `${path}.titlePropertyApiName`);
  if (
    titlePropertyApiName !== null &&
    (propertyByName.get(titlePropertyApiName)?.disposition ?? "restricted") === "restricted"
  ) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "The title Property must be visible or null.",
      `${path}.titlePropertyApiName`,
    );
  }
  const defaultSearchProperties = parseApiNameArray(
    record.defaultSearchProperties,
    `${path}.defaultSearchProperties`,
    0,
    RUNTIME_METADATA_PROPERTY_MAXIMUM_ITEMS,
  );
  for (const property of defaultSearchProperties) {
    if (propertyByName.get(property)?.searchable !== true) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "Default search Properties must be visible and searchable.",
        `${path}.defaultSearchProperties`,
      );
    }
  }
  const defaultSort =
    record.defaultSort === null
      ? null
      : parseRuntimeSort(record.defaultSort, `${path}.defaultSort`);
  if (defaultSort !== null && propertyByName.get(defaultSort.property)?.sortable !== true) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "The default sort Property must be visible and sortable.",
      `${path}.defaultSort`,
    );
  }
  const links = Object.freeze(
    requireArray(record.links, `${path}.links`, {
      maximumItems: RUNTIME_METADATA_LINK_MAXIMUM_ITEMS,
    }).map((item, index) => parseLinkMetadata(item, `${path}.links[${index}]`)),
  );
  assertUnique(
    links.map(({ apiName }) => apiName),
    `${path}.links`,
  );
  return Object.freeze({
    apiName: parseApiName(record.apiName, `${path}.apiName`),
    displayName: parseDisplayName(record.displayName, `${path}.displayName`),
    titlePropertyApiName,
    defaultSearchProperties,
    defaultSort,
    properties,
    links,
  });
}

function parsePropertyMetadata(value: unknown, path: string): RuntimePropertyMetadata {
  const record = strictRecord(
    value,
    path,
    RUNTIME_PROPERTY_METADATA_FIELDS,
    RUNTIME_PROPERTY_METADATA_FIELDS,
  );
  const disposition = requireOneOf(record.disposition, propertyDispositions, `${path}.disposition`);
  const filterOperators = Object.freeze(
    requireArray(record.filterOperators, `${path}.filterOperators`, {
      maximumItems: QUERY_COMPARISON_OPERATOR_VALUES.length + 1,
    }).map((item, index) => {
      if (item === "isNull") return "isNull" as const;
      return requireOneOf(item, queryOperators, `${path}.filterOperators[${index}]`);
    }),
  );
  assertUnique(filterOperators, `${path}.filterOperators`);
  const sortable = requireBoolean(record.sortable, `${path}.sortable`);
  const searchable = requireBoolean(record.searchable, `${path}.searchable`);
  if (disposition !== "allow" && (filterOperators.length > 0 || sortable || searchable)) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Masked and restricted Properties cannot be queried.",
      path,
    );
  }
  return Object.freeze({
    apiName: parseApiName(record.apiName, `${path}.apiName`),
    displayName: parseDisplayName(record.displayName, `${path}.displayName`),
    valueType: requireOneOf(record.valueType, propertyValueTypes, `${path}.valueType`),
    disposition,
    nullable: requireBoolean(record.nullable, `${path}.nullable`),
    filterOperators,
    sortable,
    searchable,
  });
}

function parseLinkMetadata(value: unknown, path: string): RuntimeLinkMetadata {
  const record = strictRecord(
    value,
    path,
    RUNTIME_LINK_METADATA_FIELDS,
    RUNTIME_LINK_METADATA_FIELDS,
  );
  return Object.freeze({
    apiName: parseApiName(record.apiName, `${path}.apiName`),
    displayName: parseDisplayName(record.displayName, `${path}.displayName`),
    targetObjectTypeApiName: parseApiName(
      record.targetObjectTypeApiName,
      `${path}.targetObjectTypeApiName`,
    ),
    direction: parseDirection(record.direction, `${path}.direction`),
  });
}

function parseRuntimeObject(value: unknown, path: string): RuntimeObject {
  const record = strictRecord(value, path, RUNTIME_OBJECT_FIELDS, RUNTIME_OBJECT_FIELDS);
  const properties = Object.freeze(
    requireArray(record.properties, `${path}.properties`, {
      maximumItems: QUERY_SELECT_MAXIMUM_ITEMS,
    }).map((item, index) => parseRuntimePropertyResult(item, `${path}.properties[${index}]`)),
  );
  assertUnique(
    properties.map(({ apiName }) => apiName),
    `${path}.properties`,
  );
  return Object.freeze({
    reference: parseObjectReference(record.reference, `${path}.reference`),
    objectVersion: requireString(record.objectVersion, `${path}.objectVersion`, {
      minimumLength: 1,
      maximumLength: 19,
      pattern: objectVersionExpression,
    }),
    properties,
  });
}

function parseObjectReference(value: unknown, path: string): RuntimeObjectReference {
  const record = strictRecord(
    value,
    path,
    RUNTIME_OBJECT_REFERENCE_FIELDS,
    RUNTIME_OBJECT_REFERENCE_FIELDS,
  );
  return Object.freeze({
    objectTypeApiName: parseApiName(record.objectTypeApiName, `${path}.objectTypeApiName`),
    primaryKey: requireString(record.primaryKey, `${path}.primaryKey`, {
      minimumLength: 1,
      maximumLength: RUNTIME_PRIMARY_KEY_MAXIMUM_LENGTH,
    }),
  });
}

function parseObjectPage(
  value: unknown,
  path: string,
  maximumItems: number,
): readonly RuntimeObject[] {
  return Object.freeze(
    requireArray(value, path, { maximumItems }).map((item, index) =>
      parseRuntimeObject(item, `${path}[${index}]`),
    ),
  );
}

function parseResponseMetadata(
  record: Readonly<Record<string, unknown>>,
  path: string,
): RuntimeResponseMetadata {
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    releaseId: parseOntosId(record.releaseId, `${path}.releaseId`),
    releaseRevisionId: parseOntosId(record.releaseRevisionId, `${path}.releaseRevisionId`),
    readTimestamp: parseCanonicalInstant(record.readTimestamp, `${path}.readTimestamp`),
    correlationId: parseCorrelationId(record.correlationId, `${path}.correlationId`),
    warnings: Object.freeze(
      requireArray(record.warnings, `${path}.warnings`, {
        maximumItems: RUNTIME_WARNING_MAXIMUM_ITEMS,
      }).map((item, index) => parseRuntimeWarning(item, `${path}.warnings[${index}]`)),
    ),
  });
}

function parseRuntimeWarning(value: unknown, path: string): RuntimeWarning {
  const record = strictRecord(value, path, RUNTIME_WARNING_FIELDS, RUNTIME_WARNING_FIELDS);
  return Object.freeze({
    code: requireString(record.code, `${path}.code`, {
      minimumLength: 3,
      maximumLength: 64,
      pattern: warningCodeExpression,
    }),
    message: requireString(record.message, `${path}.message`, {
      minimumLength: 1,
      maximumLength: RUNTIME_WARNING_MESSAGE_MAXIMUM_LENGTH,
    }),
  });
}

function parseRuntimeSort(value: unknown, path: string): QuerySort {
  const record = strictRecord(value, path, ["property", "direction"], ["property", "direction"]);
  return Object.freeze({
    property: parseApiName(record.property, `${path}.property`),
    direction: requireOneOf(
      record.direction,
      new Set(["asc", "desc"] as const),
      `${path}.direction`,
    ),
  });
}

function parseResolvedLinkHop(value: unknown, path: string): RuntimeResolvedLinkHop {
  const record = strictRecord(
    value,
    path,
    RUNTIME_RESOLVED_LINK_HOP_FIELDS,
    RUNTIME_RESOLVED_LINK_HOP_FIELDS,
  );
  return Object.freeze({
    linkTypeApiName: parseApiName(record.linkTypeApiName, `${path}.linkTypeApiName`),
    direction: parseDirection(record.direction, `${path}.direction`),
  });
}

function parseDirection(value: unknown, path: string): "outgoing" | "incoming" {
  return requireOneOf(value, new Set(["outgoing", "incoming"] as const), path);
}

function parseApiNameArray(
  value: unknown,
  path: string,
  minimumItems: number,
  maximumItems: number,
): readonly string[] {
  const values = requireArray(value, path, { minimumItems, maximumItems }).map((item, index) =>
    parseApiName(item, `${path}[${index}]`),
  );
  assertUnique(values, path);
  return Object.freeze(values);
}

function parseApiName(value: unknown, path: string): string {
  return requireString(value, path, {
    minimumLength: 1,
    maximumLength: 63,
    pattern: apiNameExpression,
  });
}

function parseDisplayName(value: unknown, path: string): string {
  return requireString(value, path, { minimumLength: 1, maximumLength: 128 });
}

function assertUnique(values: readonly unknown[], path: string): void {
  if (new Set(values.map((value) => JSON.stringify(value))).size !== values.length) {
    failContract("CONTRACT_FORMAT_INVALID", "Entries must be unique.", path);
  }
}

function strictRecord(
  value: unknown,
  path: string,
  fields: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  const record = requirePlainRecord(value, path);
  requireObjectShape(record, fields, required, path);
  return record;
}
