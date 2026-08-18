import { canonicalizeContractForDigest } from "./canonical-json.ts";
import { failContract } from "./error.ts";
import {
  requireArray,
  requireObjectShape,
  requireOneOf,
  requirePlainRecord,
  requireSafeInteger,
  requireString,
} from "./internal.ts";
import { API_NAME_PATTERN } from "./metadata.ts";
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

declare const opaqueCursorBrand: unique symbol;

export type OpaqueCursor = string & { readonly [opaqueCursorBrand]: true };
export type QueryScalar = string | number | boolean;
export type CursorScalar = QueryScalar | null;

export const QUERY_COMPARISON_OPERATOR_VALUES = Object.freeze([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "contains",
  "prefix",
  "containsAny",
] as const);
export type QueryComparisonOperator = (typeof QUERY_COMPARISON_OPERATOR_VALUES)[number];

export const QUERY_SORT_DIRECTION_VALUES = Object.freeze(["asc", "desc"] as const);
export type QuerySortDirection = (typeof QUERY_SORT_DIRECTION_VALUES)[number];

export const QUERY_LOGICAL_MAXIMUM_DEPTH = 5;
export const QUERY_PREDICATE_MAXIMUM_COUNT = 50;
export const QUERY_IN_MAXIMUM_ITEMS = 500;
export const QUERY_SELECT_MAXIMUM_ITEMS = 256;
export const QUERY_SEARCH_TEXT_MAXIMUM_LENGTH = 256;
export const QUERY_PAGE_DEFAULT_SIZE = 50;
export const QUERY_PAGE_MAXIMUM_SIZE = 500;
export const QUERY_LINK_PAGE_MAXIMUM_SIZE = 200;
export const QUERY_LINK_MAXIMUM_HOPS = 2;
export const QUERY_LINK_MAXIMUM_CANDIDATES = 5_000;
export const OPAQUE_CURSOR_MINIMUM_LENGTH = 16;
export const OPAQUE_CURSOR_MAXIMUM_LENGTH = 65_536;
export const OPAQUE_CURSOR_PATTERN = "^[A-Za-z0-9_-]+$";
export const CURSOR_KEY_VERSION_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
export const CURSOR_MAXIMUM_TTL_MILLISECONDS = 15 * 60 * 1_000;
export const CURSOR_CLOCK_SKEW_MILLISECONDS = 30 * 1_000;
export const CURSOR_GENERATION_MAXIMUM_ITEMS = 5;
export const CURSOR_SORT_MAXIMUM_ITEMS = 2;

const apiNameExpression = new RegExp(API_NAME_PATTERN, "u");
const cursorExpression = new RegExp(OPAQUE_CURSOR_PATTERN, "u");
const cursorKeyVersionExpression = new RegExp(CURSOR_KEY_VERSION_PATTERN, "u");
const comparisonOperators = new Set<QueryComparisonOperator>(QUERY_COMPARISON_OPERATOR_VALUES);
const listOperators = new Set<QueryComparisonOperator>(["in", "containsAny"]);
const stringOperators = new Set<QueryComparisonOperator>(["contains", "prefix"]);
const sortDirections = new Set<QuerySortDirection>(QUERY_SORT_DIRECTION_VALUES);

export interface QueryComparisonPredicate {
  readonly property: string;
  readonly op: QueryComparisonOperator;
  readonly value: QueryScalar | readonly QueryScalar[];
}

export interface QueryNullPredicate {
  readonly property: string;
  readonly op: "isNull";
}

export interface QueryAndPredicate {
  readonly and: readonly QueryPredicate[];
}

export interface QueryOrPredicate {
  readonly or: readonly QueryPredicate[];
}

export interface QueryNotPredicate {
  readonly not: QueryPredicate;
}

export type QueryPredicate =
  | QueryComparisonPredicate
  | QueryNullPredicate
  | QueryAndPredicate
  | QueryOrPredicate
  | QueryNotPredicate;

export interface QuerySort {
  readonly property: string;
  readonly direction: QuerySortDirection;
}

export interface QueryPage {
  readonly size: number;
  readonly cursor: OpaqueCursor | null;
}

export interface RuntimeSearchRequest {
  readonly schemaVersion: ContractSchemaVersion;
  readonly select: readonly string[];
  readonly searchText?: string;
  readonly where?: QueryPredicate;
  readonly orderBy: readonly QuerySort[];
  readonly page: QueryPage;
}

export interface RuntimeCountRequest {
  readonly schemaVersion: ContractSchemaVersion;
  readonly operation: "count";
  readonly searchText?: string;
  readonly where?: QueryPredicate;
}

export interface RuntimeLinkHop {
  readonly linkTypeApiName: string;
  readonly direction: "outgoing" | "incoming";
}

export interface RuntimeLinkSearchRequest {
  readonly schemaVersion: ContractSchemaVersion;
  readonly direction: "outgoing" | "incoming";
  readonly secondHop?: RuntimeLinkHop;
  readonly select: readonly string[];
  readonly searchText?: string;
  readonly where?: QueryPredicate;
  readonly orderBy: readonly QuerySort[];
  readonly page: QueryPage;
}

export const QUERY_COMPARISON_PREDICATE_FIELDS = Object.freeze([
  "property",
  "op",
  "value",
] as const);
export const QUERY_NULL_PREDICATE_FIELDS = Object.freeze(["property", "op"] as const);
export const QUERY_AND_PREDICATE_FIELDS = Object.freeze(["and"] as const);
export const QUERY_OR_PREDICATE_FIELDS = Object.freeze(["or"] as const);
export const QUERY_NOT_PREDICATE_FIELDS = Object.freeze(["not"] as const);
export const QUERY_SORT_FIELDS = Object.freeze(["property", "direction"] as const);
export const QUERY_PAGE_FIELDS = Object.freeze(["size", "cursor"] as const);
export const RUNTIME_SEARCH_REQUEST_FIELDS = Object.freeze([
  "schemaVersion",
  "select",
  "searchText",
  "where",
  "orderBy",
  "page",
] as const);
export const RUNTIME_SEARCH_REQUEST_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "select",
] as const);
export const RUNTIME_COUNT_REQUEST_FIELDS = Object.freeze([
  "schemaVersion",
  "operation",
  "searchText",
  "where",
] as const);
export const RUNTIME_COUNT_REQUEST_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "operation",
] as const);
export const RUNTIME_LINK_HOP_FIELDS = Object.freeze(["linkTypeApiName", "direction"] as const);
export const RUNTIME_LINK_SEARCH_REQUEST_FIELDS = Object.freeze([
  "schemaVersion",
  "direction",
  "secondHop",
  "select",
  "searchText",
  "where",
  "orderBy",
  "page",
] as const);
export const RUNTIME_LINK_SEARCH_REQUEST_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "direction",
  "select",
] as const);

export function parseRuntimeSearchRequest(value: unknown): RuntimeSearchRequest {
  const path = "$runtimeSearchRequest";
  const record = strictRecord(
    value,
    path,
    RUNTIME_SEARCH_REQUEST_FIELDS,
    RUNTIME_SEARCH_REQUEST_REQUIRED_FIELDS,
  );
  const state = predicateState();
  const where =
    record.where === undefined
      ? undefined
      : parseQueryPredicateNode(record.where, `${path}.where`, state, 0);
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    select: parseApiNameSet(record.select, `${path}.select`, 1, QUERY_SELECT_MAXIMUM_ITEMS),
    ...(record.searchText === undefined
      ? {}
      : { searchText: parseSearchText(record.searchText, `${path}.searchText`) }),
    ...(where === undefined ? {} : { where }),
    orderBy: parseOrderBy(record.orderBy, `${path}.orderBy`),
    page: parseQueryPage(record.page, `${path}.page`, QUERY_PAGE_MAXIMUM_SIZE),
  });
}

export function parseRuntimeCountRequest(value: unknown): RuntimeCountRequest {
  const path = "$runtimeCountRequest";
  const record = strictRecord(
    value,
    path,
    RUNTIME_COUNT_REQUEST_FIELDS,
    RUNTIME_COUNT_REQUEST_REQUIRED_FIELDS,
  );
  const state = predicateState();
  const where =
    record.where === undefined
      ? undefined
      : parseQueryPredicateNode(record.where, `${path}.where`, state, 0);
  if (record.operation !== "count") {
    failContract("CONTRACT_FORMAT_INVALID", "Only count is active in G2-03.", `${path}.operation`);
  }
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    operation: "count",
    ...(record.searchText === undefined
      ? {}
      : { searchText: parseSearchText(record.searchText, `${path}.searchText`) }),
    ...(where === undefined ? {} : { where }),
  });
}

export function parseRuntimeLinkSearchRequest(value: unknown): RuntimeLinkSearchRequest {
  const path = "$runtimeLinkSearchRequest";
  const record = strictRecord(
    value,
    path,
    RUNTIME_LINK_SEARCH_REQUEST_FIELDS,
    RUNTIME_LINK_SEARCH_REQUEST_REQUIRED_FIELDS,
  );
  const state = predicateState();
  const where =
    record.where === undefined
      ? undefined
      : parseQueryPredicateNode(record.where, `${path}.where`, state, 0);
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    direction: parseLinkDirection(record.direction, `${path}.direction`),
    ...(record.secondHop === undefined
      ? {}
      : { secondHop: parseRuntimeLinkHop(record.secondHop, `${path}.secondHop`) }),
    select: parseApiNameSet(record.select, `${path}.select`, 1, QUERY_SELECT_MAXIMUM_ITEMS),
    ...(record.searchText === undefined
      ? {}
      : { searchText: parseSearchText(record.searchText, `${path}.searchText`) }),
    ...(where === undefined ? {} : { where }),
    orderBy: parseOrderBy(record.orderBy, `${path}.orderBy`),
    page: parseQueryPage(record.page, `${path}.page`, QUERY_LINK_PAGE_MAXIMUM_SIZE),
  });
}

export function parseQueryPredicate(value: unknown): QueryPredicate {
  return parseQueryPredicateNode(value, "$queryPredicate", predicateState(), 0);
}

function parseQueryPredicateNode(
  value: unknown,
  path: string,
  state: { count: number },
  depth: number,
): QueryPredicate {
  if (depth > QUERY_LOGICAL_MAXIMUM_DEPTH) {
    failContract(
      "CONTRACT_VALUE_OUT_OF_RANGE",
      `Query logical nesting exceeds ${String(QUERY_LOGICAL_MAXIMUM_DEPTH)} levels.`,
      path,
    );
  }
  state.count += 1;
  if (state.count > QUERY_PREDICATE_MAXIMUM_COUNT) {
    failContract(
      "CONTRACT_VALUE_OUT_OF_RANGE",
      `Query contains more than ${String(QUERY_PREDICATE_MAXIMUM_COUNT)} predicates.`,
      path,
    );
  }
  const record = requirePlainRecord(value, path);
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === "and") {
    return Object.freeze({
      and: parsePredicateArray(record.and, `${path}.and`, state, depth + 1),
    });
  }
  if (keys.length === 1 && keys[0] === "or") {
    return Object.freeze({
      or: parsePredicateArray(record.or, `${path}.or`, state, depth + 1),
    });
  }
  if (keys.length === 1 && keys[0] === "not") {
    return Object.freeze({
      not: parseQueryPredicateNode(record.not, `${path}.not`, state, depth + 1),
    });
  }
  if (record.op === "isNull") {
    requireObjectShape(record, QUERY_NULL_PREDICATE_FIELDS, QUERY_NULL_PREDICATE_FIELDS, path);
    return Object.freeze({
      property: parseApiName(record.property, `${path}.property`),
      op: "isNull",
    });
  }
  requireObjectShape(
    record,
    QUERY_COMPARISON_PREDICATE_FIELDS,
    QUERY_COMPARISON_PREDICATE_FIELDS,
    path,
  );
  const op = requireOneOf(record.op, comparisonOperators, `${path}.op`);
  return Object.freeze({
    property: parseApiName(record.property, `${path}.property`),
    op,
    value: parseOperatorValue(op, record.value, `${path}.value`),
  });
}

function parsePredicateArray(
  value: unknown,
  path: string,
  state: { count: number },
  depth: number,
): readonly QueryPredicate[] {
  return Object.freeze(
    requireArray(value, path, { minimumItems: 1, maximumItems: QUERY_PREDICATE_MAXIMUM_COUNT }).map(
      (item, index) => parseQueryPredicateNode(item, `${path}[${index}]`, state, depth),
    ),
  );
}

function parseOperatorValue(
  operator: QueryComparisonOperator,
  value: unknown,
  path: string,
): QueryScalar | readonly QueryScalar[] {
  if (listOperators.has(operator)) {
    const parsed = requireArray(value, path, {
      minimumItems: 1,
      maximumItems: QUERY_IN_MAXIMUM_ITEMS,
    }).map((item, index) => parseQueryScalar(item, `${path}[${index}]`));
    if (new Set(parsed.map((item) => JSON.stringify(item))).size !== parsed.length) {
      failContract("CONTRACT_FORMAT_INVALID", "Query list values must be unique.", path);
    }
    return Object.freeze(parsed);
  }
  const scalar = parseQueryScalar(value, path);
  if (stringOperators.has(operator) && typeof scalar !== "string") {
    failContract("CONTRACT_TYPE_INVALID", `${operator} requires a string value.`, path);
  }
  return scalar;
}

export function parseQueryScalar(value: unknown, path = "$queryScalar"): QueryScalar {
  if (typeof value === "string") {
    return requireString(value, path, { minimumLength: 0, maximumLength: 4_096 });
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      failContract("CONTRACT_VALUE_OUT_OF_RANGE", "Integer query values must be safe.", path);
    }
    return value;
  }
  failContract(
    "CONTRACT_TYPE_INVALID",
    "Query values must be finite strings, numbers, or booleans; use isNull for null.",
    path,
  );
}

function parseOrderBy(value: unknown, path: string): readonly QuerySort[] {
  if (value === undefined) return Object.freeze([]);
  return Object.freeze(
    requireArray(value, path, { maximumItems: 1 }).map((item, index) => {
      const itemPath = `${path}[${index}]`;
      const record = strictRecord(item, itemPath, QUERY_SORT_FIELDS, QUERY_SORT_FIELDS);
      return Object.freeze({
        property: parseApiName(record.property, `${itemPath}.property`),
        direction: requireOneOf(record.direction, sortDirections, `${itemPath}.direction`),
      });
    }),
  );
}

function parseQueryPage(value: unknown, path: string, maximumSize: number): QueryPage {
  if (value === undefined) {
    return Object.freeze({ size: QUERY_PAGE_DEFAULT_SIZE, cursor: null });
  }
  const record = strictRecord(value, path, QUERY_PAGE_FIELDS, []);
  return Object.freeze({
    size:
      record.size === undefined
        ? QUERY_PAGE_DEFAULT_SIZE
        : requireSafeInteger(record.size, `${path}.size`, { minimum: 1, maximum: maximumSize }),
    cursor:
      record.cursor === undefined || record.cursor === null
        ? null
        : parseOpaqueCursor(record.cursor, `${path}.cursor`),
  });
}

export function parseOpaqueCursor(value: unknown, path = "$cursor"): OpaqueCursor {
  return requireString(value, path, {
    minimumLength: OPAQUE_CURSOR_MINIMUM_LENGTH,
    maximumLength: OPAQUE_CURSOR_MAXIMUM_LENGTH,
    pattern: cursorExpression,
  }) as OpaqueCursor;
}

function parseSearchText(value: unknown, path: string): string {
  return requireString(value, path, {
    minimumLength: 0,
    maximumLength: QUERY_SEARCH_TEXT_MAXIMUM_LENGTH,
  });
}

function parseApiNameSet(
  value: unknown,
  path: string,
  minimumItems: number,
  maximumItems: number,
): readonly string[] {
  const parsed = requireArray(value, path, { minimumItems, maximumItems }).map((item, index) =>
    parseApiName(item, `${path}[${index}]`),
  );
  if (new Set(parsed).size !== parsed.length) {
    failContract("CONTRACT_FORMAT_INVALID", "API names must be unique.", path);
  }
  return Object.freeze(parsed);
}

function parseApiName(value: unknown, path: string): string {
  return requireString(value, path, {
    minimumLength: 1,
    maximumLength: 63,
    pattern: apiNameExpression,
  });
}

function parseLinkDirection(value: unknown, path: string): "outgoing" | "incoming" {
  return requireOneOf(value, new Set(["outgoing", "incoming"] as const), path);
}

function parseRuntimeLinkHop(value: unknown, path: string): RuntimeLinkHop {
  const record = strictRecord(value, path, RUNTIME_LINK_HOP_FIELDS, RUNTIME_LINK_HOP_FIELDS);
  return Object.freeze({
    linkTypeApiName: parseApiName(record.linkTypeApiName, `${path}.linkTypeApiName`),
    direction: parseLinkDirection(record.direction, `${path}.direction`),
  });
}

function predicateState(): { count: number } {
  return { count: 0 };
}

export interface CursorGenerationBinding {
  readonly memberKey: string;
  readonly resourceRevisionId: OntosId;
  readonly generationId: OntosId;
}

export interface CursorSortBinding {
  readonly property: string;
  readonly direction: QuerySortDirection;
  readonly nulls: "first" | "last";
  readonly collation: string;
}

export interface CursorEnvelope {
  readonly schemaVersion: ContractSchemaVersion;
  readonly keyVersion: string;
  readonly issuedAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
  readonly projectId: OntosId;
  readonly releaseId: OntosId;
  readonly releaseRevisionId: OntosId;
  readonly activationId: OntosId;
  readonly objectTypeResourceId: OntosId;
  readonly objectTypeRevisionId: OntosId;
  readonly generations: readonly CursorGenerationBinding[];
  readonly queryHash: ArtifactDigest;
  readonly policyContextHash: ArtifactDigest;
  readonly identityContextHash: ArtifactDigest;
  readonly sort: readonly CursorSortBinding[];
  readonly lastValues: readonly CursorScalar[];
}

export interface CursorExpectedContext {
  readonly projectId: OntosId;
  readonly releaseId: OntosId;
  readonly releaseRevisionId: OntosId;
  readonly activationId: OntosId;
  readonly objectTypeResourceId: OntosId;
  readonly objectTypeRevisionId: OntosId;
  readonly generations: readonly CursorGenerationBinding[];
  readonly queryHash: ArtifactDigest;
  readonly policyContextHash: ArtifactDigest;
  readonly identityContextHash: ArtifactDigest;
  readonly sort: readonly CursorSortBinding[];
}

export class CursorContextChangedError extends Error {
  readonly code = "CURSOR_CONTEXT_CHANGED" as const;

  constructor() {
    super("Cursor context no longer matches the current Runtime read context.");
    this.name = "CursorContextChangedError";
  }
}

export const CURSOR_GENERATION_BINDING_FIELDS = Object.freeze([
  "memberKey",
  "resourceRevisionId",
  "generationId",
] as const);
export const CURSOR_SORT_BINDING_FIELDS = Object.freeze([
  "property",
  "direction",
  "nulls",
  "collation",
] as const);
export const CURSOR_ENVELOPE_FIELDS = Object.freeze([
  "schemaVersion",
  "keyVersion",
  "issuedAt",
  "expiresAt",
  "projectId",
  "releaseId",
  "releaseRevisionId",
  "activationId",
  "objectTypeResourceId",
  "objectTypeRevisionId",
  "generations",
  "queryHash",
  "policyContextHash",
  "identityContextHash",
  "sort",
  "lastValues",
] as const);

export function parseCursorEnvelope(
  value: unknown,
  options: Readonly<{
    now?: Date;
    acceptedKeyVersions?: ReadonlySet<string>;
  }> = {},
): CursorEnvelope {
  const path = "$cursorEnvelope";
  const record = strictRecord(value, path, CURSOR_ENVELOPE_FIELDS, CURSOR_ENVELOPE_FIELDS);
  const keyVersion = requireString(record.keyVersion, `${path}.keyVersion`, {
    minimumLength: 1,
    maximumLength: 64,
    pattern: cursorKeyVersionExpression,
  });
  if (options.acceptedKeyVersions !== undefined && !options.acceptedKeyVersions.has(keyVersion)) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Cursor key version is not accepted.",
      `${path}.keyVersion`,
    );
  }
  const issuedAt = parseCanonicalInstant(record.issuedAt, `${path}.issuedAt`);
  const expiresAt = parseCanonicalInstant(record.expiresAt, `${path}.expiresAt`);
  const issuedMilliseconds = Date.parse(issuedAt);
  const expiresMilliseconds = Date.parse(expiresAt);
  if (
    expiresMilliseconds <= issuedMilliseconds ||
    expiresMilliseconds - issuedMilliseconds > CURSOR_MAXIMUM_TTL_MILLISECONDS
  ) {
    failContract("CONTRACT_VALUE_OUT_OF_RANGE", "Cursor lifetime is invalid.", `${path}.expiresAt`);
  }
  if (options.now !== undefined) {
    const now = options.now.getTime();
    if (!Number.isFinite(now)) {
      failContract("CONTRACT_FORMAT_INVALID", "Cursor verification time is invalid.", path);
    }
    if (issuedMilliseconds > now + CURSOR_CLOCK_SKEW_MILLISECONDS) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "Cursor was issued in the future.",
        `${path}.issuedAt`,
      );
    }
    if (expiresMilliseconds <= now) {
      failContract("CONTRACT_VALUE_OUT_OF_RANGE", "Cursor is expired.", `${path}.expiresAt`);
    }
  }
  const generations = Object.freeze(
    requireArray(record.generations, `${path}.generations`, {
      minimumItems: 1,
      maximumItems: CURSOR_GENERATION_MAXIMUM_ITEMS,
    }).map((item, index) => parseCursorGeneration(item, `${path}.generations[${index}]`)),
  );
  const memberKeys = generations.map(({ memberKey }) => memberKey);
  if (new Set(memberKeys).size !== memberKeys.length || !isSorted(memberKeys)) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Cursor generation bindings must be unique and sorted.",
      `${path}.generations`,
    );
  }
  const sort = Object.freeze(
    requireArray(record.sort, `${path}.sort`, {
      minimumItems: 1,
      maximumItems: CURSOR_SORT_MAXIMUM_ITEMS,
    }).map((item, index) => parseCursorSort(item, `${path}.sort[${index}]`)),
  );
  const sortProperties = sort.map(({ property }) => property);
  if (new Set(sortProperties).size !== sortProperties.length) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Cursor sort Properties must be unique.",
      `${path}.sort`,
    );
  }
  const lastValues = Object.freeze(
    requireArray(record.lastValues, `${path}.lastValues`, {
      minimumItems: 1,
      maximumItems: CURSOR_SORT_MAXIMUM_ITEMS,
    }).map((item, index) => parseCursorScalar(item, `${path}.lastValues[${index}]`)),
  );
  if (sort.length !== lastValues.length) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Cursor sort and lastValues must have the same length.",
      `${path}.lastValues`,
    );
  }
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    keyVersion,
    issuedAt,
    expiresAt,
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    releaseId: parseOntosId(record.releaseId, `${path}.releaseId`),
    releaseRevisionId: parseOntosId(record.releaseRevisionId, `${path}.releaseRevisionId`),
    activationId: parseOntosId(record.activationId, `${path}.activationId`),
    objectTypeResourceId: parseOntosId(record.objectTypeResourceId, `${path}.objectTypeResourceId`),
    objectTypeRevisionId: parseOntosId(record.objectTypeRevisionId, `${path}.objectTypeRevisionId`),
    generations,
    queryHash: parseArtifactDigest(record.queryHash, `${path}.queryHash`),
    policyContextHash: parseArtifactDigest(record.policyContextHash, `${path}.policyContextHash`),
    identityContextHash: parseArtifactDigest(
      record.identityContextHash,
      `${path}.identityContextHash`,
    ),
    sort,
    lastValues,
  });
}

export function assertCursorEnvelopeContext(
  envelope: CursorEnvelope,
  expected: CursorExpectedContext,
): void {
  const actual = {
    projectId: envelope.projectId,
    releaseId: envelope.releaseId,
    releaseRevisionId: envelope.releaseRevisionId,
    activationId: envelope.activationId,
    objectTypeResourceId: envelope.objectTypeResourceId,
    objectTypeRevisionId: envelope.objectTypeRevisionId,
    generations: envelope.generations,
    queryHash: envelope.queryHash,
    policyContextHash: envelope.policyContextHash,
    identityContextHash: envelope.identityContextHash,
    sort: envelope.sort,
  };
  if (canonicalizeContractForDigest(actual) !== canonicalizeContractForDigest(expected)) {
    throw new CursorContextChangedError();
  }
}

function parseCursorGeneration(value: unknown, path: string): CursorGenerationBinding {
  const record = strictRecord(
    value,
    path,
    CURSOR_GENERATION_BINDING_FIELDS,
    CURSOR_GENERATION_BINDING_FIELDS,
  );
  return Object.freeze({
    memberKey: requireString(record.memberKey, `${path}.memberKey`, {
      minimumLength: 1,
      maximumLength: 128,
      pattern: /^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$/u,
    }),
    resourceRevisionId: parseOntosId(record.resourceRevisionId, `${path}.resourceRevisionId`),
    generationId: parseOntosId(record.generationId, `${path}.generationId`),
  });
}

function parseCursorSort(value: unknown, path: string): CursorSortBinding {
  const record = strictRecord(value, path, CURSOR_SORT_BINDING_FIELDS, CURSOR_SORT_BINDING_FIELDS);
  return Object.freeze({
    property: parseApiName(record.property, `${path}.property`),
    direction: requireOneOf(record.direction, sortDirections, `${path}.direction`),
    nulls: requireOneOf(record.nulls, new Set(["first", "last"] as const), `${path}.nulls`),
    collation: requireString(record.collation, `${path}.collation`, {
      minimumLength: 1,
      maximumLength: 64,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,
    }),
  });
}

function parseCursorScalar(value: unknown, path: string): CursorScalar {
  return value === null ? null : parseQueryScalar(value, path);
}

function isSorted(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values.at(index - 1);
    const current = values.at(index);
    if (previous === undefined || current === undefined || previous >= current) {
      return false;
    }
  }
  return true;
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
