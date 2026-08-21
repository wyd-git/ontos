import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseCanonicalInstant,
  parseRuntimeCountRequest,
  parseRuntimeLinkSearchRequest,
  parseRuntimeSearchRequest,
  type ArtifactDigest,
  type CanonicalInstant,
  type QueryComparisonOperator,
  type QueryPredicate,
  type RuntimeCountRequest,
  type RuntimeLinkSearchRequest,
  type RuntimeSearchRequest,
} from "@ontos/contracts";

import { failQuery } from "./error.ts";
import {
  QUERY_COMPILER_VERSION,
  QUERY_COMPLEXITY_MAXIMUM_UNITS,
  QUERY_RESULT_DEFAULT_MAXIMUM_BYTES,
  QUERY_STATEMENT_DEFAULT_TIMEOUT_MS,
  QUERY_STATEMENT_MAXIMUM_TIMEOUT_MS,
  registerQueryLogicalPlan,
  type LinkCandidateLogicalPlan,
  type ObjectCountLogicalPlan,
  type ObjectGetLogicalPlan,
  type ObjectSearchLogicalPlan,
  type QueryComplexityReport,
  type QueryLogicalPlan,
  type QueryParameterOperand,
  type QueryPlanBinding,
  type QueryPolicyPlan,
  type QueryPredicatePlan,
  type QueryPropertyAccessPlan,
  type QuerySearchPlan,
  type QuerySortPlan,
  type QueryTypedOperand,
} from "./model.ts";
import {
  compileLinkPolicyPlan,
  compileObjectPolicyPlan,
  propertyValueAllowedPredicate,
  requirePropertyAccess,
  requirePropertyReadAccess,
  type QueryPolicyContext,
} from "./policy-plan.ts";
import {
  requireQueryProperty,
  type QueryObjectTypeSchema,
  type QueryPropertySchema,
  type QuerySchemaRegistry,
} from "./schema-registry.ts";
import {
  canonicalizeClientCollectionParameter,
  canonicalizeClientParameter,
  canonicalizePrimaryKeyInput,
  canonicalizeStringArrayParameter,
} from "./value.ts";

export type QueryTextDigester = (canonicalText: string) => ArtifactDigest;

export interface QueryCompilerContext {
  readonly registry: QuerySchemaRegistry;
  readonly requestTime: string;
  readonly digestCanonicalText: QueryTextDigester;
  readonly statementTimeoutMs?: number;
  readonly maximumResultBytes?: number;
}

export interface ObjectGetCompileRequest {
  readonly primaryKey: unknown;
  readonly select: readonly string[];
}

export function compileObjectGet(input: {
  readonly context: QueryCompilerContext;
  readonly objectTypeApiName: string;
  readonly request: ObjectGetCompileRequest;
  readonly policy: QueryPolicyContext;
}): ObjectGetLogicalPlan {
  const common = compileCommon(input.context);
  const object = common.registry.requireObjectByApiName(input.objectTypeApiName);
  const policy = compileObjectPolicyPlan({
    registry: common.registry,
    object,
    context: input.policy,
    requestTime: common.requestTime,
  });
  const selectedProperties = compileGetSelection(object, input.request.select);
  const canonicalPrimaryKey = canonicalizePrimaryKeyInput(object, input.request.primaryKey);
  const hashInput = Object.freeze({
    schemaVersion: 1,
    compilerVersion: QUERY_COMPILER_VERSION,
    operation: "object_get",
    binding: common.binding,
    object: objectIdentity(object),
    primaryKey: canonicalPrimaryKey,
    select: selectedProperties.map(({ apiName }) => apiName),
  });
  const draft = {
    compilerVersion: QUERY_COMPILER_VERSION,
    operation: "object_get" as const,
    binding: common.binding,
    queryHash: digestQuery(common.digestCanonicalText, hashInput),
    requestTime: common.requestTime,
    complexity: emptyComplexity(),
    statementTimeoutMs: common.statementTimeoutMs,
    maximumResultRows: 2,
    maximumResultBytes: common.maximumResultBytes,
    object,
    canonicalPrimaryKey,
    selectedProperties: Object.freeze(selectedProperties),
    policy,
  };
  const complexity = analyzeComplexity(draft);
  return registerQueryLogicalPlan(Object.freeze({ ...draft, complexity }));
}

export function compileObjectSearch(input: {
  readonly context: QueryCompilerContext;
  readonly objectTypeApiName: string;
  readonly request: unknown;
  readonly policy: QueryPolicyContext;
}): ObjectSearchLogicalPlan {
  const common = compileCommon(input.context);
  const request = parseSearch(input.request);
  if (request.page.cursor !== null) {
    failQuery("INVALID_QUERY_AST", "Cursor seek compilation is activated by G2-03-09.");
  }
  const object = common.registry.requireObjectByApiName(input.objectTypeApiName);
  const policy = compileObjectPolicyPlan({
    registry: common.registry,
    object,
    context: input.policy,
    requestTime: common.requestTime,
  });
  const selectedProperties = compileSelection(object, request.select, policy);
  const client = compileClientWhere(object, request.where, policy);
  const search = compileSearch(object, request.searchText, policy);
  const sort = compileSort(object, request.orderBy, policy);
  const clientPredicate = combineQueryGuards(client.predicate, client.accesses, sort, policy);
  const hashInput = searchHashInput(
    "object_search",
    common.binding,
    object,
    selectedProperties,
    client.predicate,
    search,
    sort,
    request.page.size,
  );
  const draft = {
    compilerVersion: QUERY_COMPILER_VERSION,
    operation: "object_search" as const,
    binding: common.binding,
    queryHash: digestQuery(common.digestCanonicalText, hashInput),
    requestTime: common.requestTime,
    complexity: emptyComplexity(),
    statementTimeoutMs: common.statementTimeoutMs,
    maximumResultRows: request.page.size,
    maximumResultBytes: common.maximumResultBytes,
    object,
    selectedProperties: Object.freeze(selectedProperties),
    policy,
    clientPredicate,
    search,
    sort,
    pageSize: request.page.size,
  };
  const complexity = analyzeComplexity(draft);
  return registerQueryLogicalPlan(Object.freeze({ ...draft, complexity }));
}

export function compileObjectCount(input: {
  readonly context: QueryCompilerContext;
  readonly objectTypeApiName: string;
  readonly request: unknown;
  readonly policy: QueryPolicyContext;
}): ObjectCountLogicalPlan {
  const common = compileCommon(input.context);
  const request = parseCount(input.request);
  const object = common.registry.requireObjectByApiName(input.objectTypeApiName);
  const policy = compileObjectPolicyPlan({
    registry: common.registry,
    object,
    context: input.policy,
    requestTime: common.requestTime,
  });
  const client = compileClientWhere(object, request.where, policy);
  const search = compileSearch(object, request.searchText, policy);
  const clientPredicate = combineQueryGuards(client.predicate, client.accesses, null, policy);
  const hashInput = Object.freeze({
    schemaVersion: 1,
    compilerVersion: QUERY_COMPILER_VERSION,
    operation: "object_count",
    binding: common.binding,
    object: objectIdentity(object),
    where: predicateForHash(client.predicate),
    search: searchForHash(search),
  });
  const draft = {
    compilerVersion: QUERY_COMPILER_VERSION,
    operation: "object_count" as const,
    binding: common.binding,
    queryHash: digestQuery(common.digestCanonicalText, hashInput),
    requestTime: common.requestTime,
    complexity: emptyComplexity(),
    statementTimeoutMs: common.statementTimeoutMs,
    maximumResultRows: 1,
    maximumResultBytes: common.maximumResultBytes,
    object,
    policy,
    clientPredicate,
    search,
  };
  const complexity = analyzeComplexity(draft);
  return registerQueryLogicalPlan(Object.freeze({ ...draft, complexity }));
}

export function compileLinkCandidate(input: {
  readonly context: QueryCompilerContext;
  readonly sourceObjectTypeApiName: string;
  readonly linkTypeApiName: string;
  readonly sourcePrimaryKey: unknown;
  readonly request: unknown;
  readonly sourcePolicy: QueryPolicyContext;
  readonly linkPolicy: QueryPolicyContext;
  readonly targetPolicy: QueryPolicyContext;
}): LinkCandidateLogicalPlan {
  const common = compileCommon(input.context);
  const request = parseLinkSearch(input.request);
  if (request.page.cursor !== null || request.secondHop !== undefined) {
    failQuery("INVALID_QUERY_AST", "Cursor and two-hop execution are activated by G2-03-09/10.");
  }
  const sourceObject = common.registry.requireObjectByApiName(input.sourceObjectTypeApiName);
  const link = common.registry.requireLinkByApiName(input.linkTypeApiName);
  const endpoint = resolveLinkEndpoint(common.registry, sourceObject, link, request.direction);
  const sourcePolicy = compileObjectPolicyPlan({
    registry: common.registry,
    object: sourceObject,
    context: input.sourcePolicy,
    requestTime: common.requestTime,
  });
  const linkPolicy = compileLinkPolicyPlan({
    registry: common.registry,
    link,
    context: input.linkPolicy,
    requestTime: common.requestTime,
  });
  const targetPolicy = compileObjectPolicyPlan({
    registry: common.registry,
    object: endpoint.target,
    context: input.targetPolicy,
    requestTime: common.requestTime,
  });
  const selectedProperties = compileSelection(endpoint.target, request.select, targetPolicy);
  const client = compileClientWhere(endpoint.target, request.where, targetPolicy);
  const search = compileSearch(endpoint.target, request.searchText, targetPolicy);
  const sort = compileSort(endpoint.target, request.orderBy, targetPolicy);
  const clientPredicate = combineQueryGuards(client.predicate, client.accesses, sort, targetPolicy);
  const sourceCanonicalPrimaryKey = canonicalizePrimaryKeyInput(
    sourceObject,
    input.sourcePrimaryKey,
  );
  const hashInput = Object.freeze({
    ...searchHashInput(
      "link_candidate",
      common.binding,
      endpoint.target,
      selectedProperties,
      client.predicate,
      search,
      sort,
      request.page.size,
    ),
    sourceObject: objectIdentity(sourceObject),
    link: Object.freeze({
      apiName: link.apiName,
      resourceId: link.resourceId,
      revisionId: link.revisionId,
      generationId: link.generationId,
    }),
    direction: request.direction,
    sourcePrimaryKey: sourceCanonicalPrimaryKey,
  });
  const draft = {
    compilerVersion: QUERY_COMPILER_VERSION,
    operation: "link_candidate" as const,
    binding: common.binding,
    queryHash: digestQuery(common.digestCanonicalText, hashInput),
    requestTime: common.requestTime,
    complexity: emptyComplexity(),
    statementTimeoutMs: common.statementTimeoutMs,
    maximumResultRows: request.page.size,
    maximumResultBytes: common.maximumResultBytes,
    sourceObject,
    link,
    targetObject: endpoint.target,
    direction: request.direction,
    sourceCanonicalPrimaryKey,
    selectedProperties: Object.freeze(selectedProperties),
    sourcePolicy,
    linkPolicy,
    targetPolicy,
    clientPredicate,
    search,
    sort,
    pageSize: request.page.size,
  };
  const complexity = analyzeComplexity(draft);
  return registerQueryLogicalPlan(Object.freeze({ ...draft, complexity }));
}

interface CompiledCommon {
  readonly registry: QuerySchemaRegistry;
  readonly binding: QueryPlanBinding;
  readonly requestTime: CanonicalInstant;
  readonly digestCanonicalText: QueryTextDigester;
  readonly statementTimeoutMs: number;
  readonly maximumResultBytes: number;
}

function compileCommon(context: QueryCompilerContext): CompiledCommon {
  if (typeof context.digestCanonicalText !== "function") {
    failQuery("QUERY_BINDING_INVALID", "Query digester is unavailable.");
  }
  let requestTime: CanonicalInstant;
  try {
    requestTime = parseCanonicalInstant(context.requestTime);
  } catch (error) {
    failQuery("QUERY_BINDING_INVALID", "Query request time is invalid.", { cause: error });
  }
  const statementTimeoutMs = boundedInteger(
    context.statementTimeoutMs ?? QUERY_STATEMENT_DEFAULT_TIMEOUT_MS,
    1,
    QUERY_STATEMENT_MAXIMUM_TIMEOUT_MS,
    "Statement timeout",
  );
  const maximumResultBytes = boundedInteger(
    context.maximumResultBytes ?? QUERY_RESULT_DEFAULT_MAXIMUM_BYTES,
    1,
    QUERY_RESULT_DEFAULT_MAXIMUM_BYTES,
    "Result byte limit",
  );
  return Object.freeze({
    registry: context.registry,
    binding: Object.freeze({
      projectId: context.registry.projectId,
      releaseId: context.registry.releaseId,
      releaseRevisionId: context.registry.releaseRevisionId,
      activationId: context.registry.activationId,
    }),
    requestTime,
    digestCanonicalText: context.digestCanonicalText,
    statementTimeoutMs,
    maximumResultBytes,
  });
}

function parseSearch(input: unknown): RuntimeSearchRequest {
  try {
    return parseRuntimeSearchRequest(input);
  } catch (error) {
    failQuery("INVALID_QUERY_AST", "Runtime Search AST is invalid.", { cause: error });
  }
}

function parseCount(input: unknown): RuntimeCountRequest {
  try {
    return parseRuntimeCountRequest(input);
  } catch (error) {
    failQuery("INVALID_QUERY_AST", "Runtime Count AST is invalid.", { cause: error });
  }
}

function parseLinkSearch(input: unknown): RuntimeLinkSearchRequest {
  try {
    return parseRuntimeLinkSearchRequest(input);
  } catch (error) {
    failQuery("INVALID_QUERY_AST", "Runtime Link Search AST is invalid.", { cause: error });
  }
}

function compileSelection(
  object: QueryObjectTypeSchema,
  names: readonly string[],
  policy: ReturnType<typeof compileObjectPolicyPlan>,
): readonly QueryPropertySchema[] {
  if (names.length === 0 || names.length > 256 || new Set(names).size !== names.length) {
    failQuery("INVALID_QUERY_AST", "Property selection is outside the supported envelope.");
  }
  return names.map((name) => {
    const property = requireQueryProperty(object, name);
    requirePropertyReadAccess(policy, property);
    return property;
  });
}

function compileGetSelection(
  object: QueryObjectTypeSchema,
  names: readonly string[],
): readonly QueryPropertySchema[] {
  if (names.length === 0 || names.length > 256 || new Set(names).size !== names.length) {
    failQuery("INVALID_QUERY_AST", "Property selection is outside the supported envelope.");
  }
  // Object Get is the one public shape that must preserve the distinction
  // between restricted, masked, missing, null and value.  A restricted field
  // is safe to select because the SQL projection never emits its raw value;
  // Search/Filter/Sort keep the stricter readable/queryable checks below.
  return names.map((name) => requireQueryProperty(object, name));
}

interface ClientWhereResult {
  readonly predicate: QueryPredicatePlan | null;
  readonly accesses: readonly QueryPropertyAccessPlan[];
}

function compileClientWhere(
  object: QueryObjectTypeSchema,
  predicate: QueryPredicate | undefined,
  policy: ReturnType<typeof compileObjectPolicyPlan>,
): ClientWhereResult {
  if (predicate === undefined)
    return Object.freeze({ predicate: null, accesses: Object.freeze([]) });
  const accesses = new Map<string, QueryPropertyAccessPlan>();
  const compile = (node: QueryPredicate): QueryPredicatePlan => {
    if ("and" in node || "or" in node) {
      const kind = "and" in node ? "all" : "any";
      const children = "and" in node ? node.and : node.or;
      return normalizeCommutative(
        kind,
        children.map((child) => compile(child)),
      );
    }
    if ("not" in node) {
      return Object.freeze({ kind: "not", predicate: compile(node.not) });
    }
    const property = requireQueryProperty(object, node.property);
    if (!property.filterable) {
      failQuery("PROPERTY_NOT_QUERYABLE", "Property is not declared filterable.");
    }
    const access = requirePropertyAccess(policy, property);
    accesses.set(property.apiName, access);
    if (node.op === "isNull") {
      return Object.freeze({
        kind: "is_null",
        operand: Object.freeze({ kind: "property", scope: "root", property }),
      });
    }
    return compileClientComparison(property, node.op, node.value);
  };
  return Object.freeze({
    predicate: compile(predicate),
    accesses: Object.freeze([...accesses.values()]),
  });
}

function compileClientComparison(
  property: QueryPropertySchema,
  operator: QueryComparisonOperator,
  raw: boolean | string | number | readonly (boolean | string | number)[],
): QueryPredicatePlan {
  assertClientOperator(property, operator, raw);
  const right =
    operator === "in"
      ? canonicalizeClientCollectionParameter(property, requiredArray(raw))
      : operator === "containsAny"
        ? canonicalizeStringArrayParameter(property, raw)
        : canonicalizeClientParameter(property, raw);
  const normalizedRight = normalizeParameterCollection(right);
  return Object.freeze({
    kind: "compare",
    op: operator,
    left: Object.freeze({ kind: "property", scope: "root", property }),
    right: normalizedRight,
  });
}

function assertClientOperator(
  property: QueryPropertySchema,
  operator: QueryComparisonOperator,
  raw: unknown,
): void {
  if (operator === "containsAny") {
    if (property.valueType !== "string[]" || !Array.isArray(raw)) invalidOperator();
    return;
  }
  if (operator === "in") {
    if (property.valueType === "string[]" || property.valueType === "json" || !Array.isArray(raw)) {
      invalidOperator();
    }
    return;
  }
  if (operator === "contains" || operator === "prefix") {
    if (property.valueType !== "string" || typeof raw !== "string") invalidOperator();
    return;
  }
  if (property.valueType === "string[]" || property.valueType === "json" || Array.isArray(raw)) {
    invalidOperator();
  }
  if (
    (operator === "lt" || operator === "lte" || operator === "gt" || operator === "gte") &&
    property.valueType === "boolean"
  ) {
    invalidOperator();
  }
}

function invalidOperator(): never {
  failQuery("INVALID_QUERY_AST", "Query operator is incompatible with the Property type.");
}

function compileSearch(
  object: QueryObjectTypeSchema,
  text: string | undefined,
  policy: ReturnType<typeof compileObjectPolicyPlan>,
): QuerySearchPlan | null {
  if (text === undefined || text.length === 0) return null;
  const properties = object.defaultSearchPropertyApiNames.map((name) => {
    const property = requireQueryProperty(object, name);
    if (!property.searchable || property.valueType !== "string") {
      failQuery("QUERY_SCHEMA_INVALID", "Default Search Property is not searchable text.");
    }
    requirePropertyAccess(policy, property);
    return property;
  });
  if (properties.length === 0) {
    failQuery("PROPERTY_NOT_QUERYABLE", "Object Type has no searchable Property.");
  }
  return Object.freeze({ text, properties: Object.freeze(properties) });
}

function compileSort(
  object: QueryObjectTypeSchema,
  requested: RuntimeSearchRequest["orderBy"],
  policy: ReturnType<typeof compileObjectPolicyPlan>,
): QuerySortPlan {
  const declared = requested.length > 0 ? requested : object.defaultSort;
  if (declared.length > 1) {
    failQuery("QUERY_SCHEMA_INVALID", "P0 Query Runtime supports one business sort Property.");
  }
  const item = declared[0];
  if (item === undefined) {
    return Object.freeze({ kind: "canonical_primary_key", direction: "asc" });
  }
  const propertyName = "property" in item ? item.property : item.propertyApiName;
  const property = requireQueryProperty(object, propertyName);
  if (!property.sortable || property.valueType === "string[]" || property.valueType === "json") {
    failQuery("PROPERTY_NOT_QUERYABLE", "Property is not declared sortable.");
  }
  requirePropertyAccess(policy, property);
  if (property.apiName === object.primaryKeyPropertyApiName) {
    return Object.freeze({ kind: "canonical_primary_key", direction: item.direction });
  }
  return Object.freeze({
    kind: "property",
    property,
    direction: item.direction,
    enumDeclarationOrder: property.enumValues,
  });
}

function combineQueryGuards(
  predicate: QueryPredicatePlan | null,
  accesses: readonly QueryPropertyAccessPlan[],
  sort: QuerySortPlan | null,
  policy: ReturnType<typeof compileObjectPolicyPlan>,
): QueryPredicatePlan | null {
  const byName = new Map(accesses.map((access) => [access.property.apiName, access]));
  if (sort?.kind === "property") {
    const access = requirePropertyAccess(policy, sort.property);
    byName.set(access.property.apiName, access);
  }
  const guards = [...byName.values()]
    .sort((left, right) => compareText(left.property.apiName, right.property.apiName))
    .map(propertyValueAllowedPredicate);
  if (predicate !== null) guards.push(predicate);
  if (guards.length === 0) return null;
  return normalizeCommutative("all", guards);
}

function resolveLinkEndpoint(
  registry: QuerySchemaRegistry,
  source: QueryObjectTypeSchema,
  link: ReturnType<QuerySchemaRegistry["requireLinkByApiName"]>,
  direction: "outgoing" | "incoming",
): { readonly target: QueryObjectTypeSchema } {
  const expectedSourceRevision =
    direction === "outgoing" ? link.sourceObjectTypeRevisionId : link.targetObjectTypeRevisionId;
  const targetRevision =
    direction === "outgoing" ? link.targetObjectTypeRevisionId : link.sourceObjectTypeRevisionId;
  if (source.revisionId !== expectedSourceRevision) {
    failQuery(
      "QUERY_BINDING_INVALID",
      "Link direction does not start at the requested Object Type.",
    );
  }
  return Object.freeze({ target: registry.requireObjectByRevision(targetRevision) });
}

interface ComplexityPlan {
  readonly operation: QueryLogicalPlan["operation"];
  readonly selectedProperties?: readonly QueryPropertySchema[];
  readonly search?: QuerySearchPlan | null;
  readonly clientPredicate?: QueryPredicatePlan | null;
  readonly policy?: QueryPolicyPlan;
  readonly sourcePolicy?: QueryPolicyPlan;
  readonly linkPolicy?: QueryPolicyPlan;
  readonly targetPolicy?: QueryPolicyPlan;
}

function analyzeComplexity(plan: ComplexityPlan): QueryComplexityReport {
  const clientPredicates = countPredicate(plan.clientPredicate ?? null);
  const policies =
    plan.operation === "link_candidate"
      ? [required(plan.sourcePolicy), required(plan.linkPolicy), required(plan.targetPolicy)]
      : [required(plan.policy)];
  const policyPredicates = policies.reduce((total, policy) => {
    const all = [policy.rowAllow, policy.rowDeny];
    for (const access of policy.propertyAccess) {
      all.push(access.allow, access.deny, ...access.masks.map(({ predicate }) => predicate));
    }
    return addCounts(
      total,
      all.reduce((sum, predicate) => addCounts(sum, countPredicate(predicate)), counts()),
    );
  }, counts());
  const selectedProperties = plan.selectedProperties?.length ?? 0;
  const searchableProperties = plan.search?.properties.length ?? 0;
  const units =
    (clientPredicates.nodes + policyPredicates.nodes) * 10 +
    (clientPredicates.collectionItems + policyPredicates.collectionItems) +
    (clientPredicates.linkExists + policyPredicates.linkExists) * 100 +
    selectedProperties * 2 +
    searchableProperties * 5;
  if (units > QUERY_COMPLEXITY_MAXIMUM_UNITS) {
    failQuery("QUERY_COMPLEXITY_EXCEEDED", "Query exceeds the compiled complexity budget.");
  }
  return Object.freeze({
    units,
    clientPredicateNodes: clientPredicates.nodes,
    policyPredicateNodes: policyPredicates.nodes,
    collectionItems: clientPredicates.collectionItems + policyPredicates.collectionItems,
    linkExistsPredicates: clientPredicates.linkExists + policyPredicates.linkExists,
    selectedProperties,
    searchableProperties,
  });
}

interface PredicateCounts {
  readonly nodes: number;
  readonly collectionItems: number;
  readonly linkExists: number;
}

function countPredicate(predicate: QueryPredicatePlan | null): PredicateCounts {
  if (predicate === null) return counts();
  if (predicate.kind === "compare") {
    const collectionItems =
      predicate.right.kind === "parameter" &&
      predicate.right.collection &&
      Array.isArray(predicate.right.value)
        ? predicate.right.value.length
        : 0;
    return { nodes: 1, collectionItems, linkExists: 0 };
  }
  if (predicate.kind === "all" || predicate.kind === "any") {
    return predicate.predicates.reduce((sum, item) => addCounts(sum, countPredicate(item)), {
      nodes: 1,
      collectionItems: 0,
      linkExists: 0,
    });
  }
  if (predicate.kind === "not") {
    return addCounts(
      { nodes: 1, collectionItems: 0, linkExists: 0 },
      countPredicate(predicate.predicate),
    );
  }
  if (predicate.kind === "link_exists") {
    return addCounts(
      { nodes: 1, collectionItems: 0, linkExists: 1 },
      countPredicate(predicate.predicate),
    );
  }
  return { nodes: 1, collectionItems: 0, linkExists: 0 };
}

function counts(): PredicateCounts {
  return { nodes: 0, collectionItems: 0, linkExists: 0 };
}

function addCounts(left: PredicateCounts, right: PredicateCounts): PredicateCounts {
  return {
    nodes: left.nodes + right.nodes,
    collectionItems: left.collectionItems + right.collectionItems,
    linkExists: left.linkExists + right.linkExists,
  };
}

function emptyComplexity(): QueryComplexityReport {
  return Object.freeze({
    units: 0,
    clientPredicateNodes: 0,
    policyPredicateNodes: 0,
    collectionItems: 0,
    linkExistsPredicates: 0,
    selectedProperties: 0,
    searchableProperties: 0,
  });
}

function normalizeCommutative(
  kind: "all" | "any",
  predicates: readonly QueryPredicatePlan[],
): QueryPredicatePlan {
  if (predicates.length === 0) {
    return Object.freeze({ kind: "constant", value: kind === "all" });
  }
  if (predicates.length === 1) return required(predicates[0]);
  return Object.freeze({
    kind,
    predicates: Object.freeze(
      [...predicates].sort((left, right) =>
        compareText(
          canonicalizeContractForDigest(predicateForHash(left)),
          canonicalizeContractForDigest(predicateForHash(right)),
        ),
      ),
    ),
  });
}

function searchHashInput(
  operation: "object_search" | "link_candidate",
  binding: QueryPlanBinding,
  object: QueryObjectTypeSchema,
  selected: readonly QueryPropertySchema[],
  predicate: QueryPredicatePlan | null,
  search: QuerySearchPlan | null,
  sort: QuerySortPlan,
  pageSize: number,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    compilerVersion: QUERY_COMPILER_VERSION,
    operation,
    binding,
    object: objectIdentity(object),
    select: selected.map(({ apiName }) => apiName),
    where: predicateForHash(predicate),
    search: searchForHash(search),
    sort: sortForHash(sort),
    pageSize,
  });
}

function predicateForHash(predicate: QueryPredicatePlan | null): unknown {
  if (predicate === null) return null;
  if (predicate.kind === "constant") return { kind: predicate.kind, value: predicate.value };
  if (predicate.kind === "compare") {
    return {
      kind: predicate.kind,
      op: predicate.op,
      left: operandForHash(predicate.left),
      right: operandForHash(predicate.right),
    };
  }
  if (predicate.kind === "is_null") {
    return { kind: predicate.kind, operand: operandForHash(predicate.operand) };
  }
  if (predicate.kind === "all" || predicate.kind === "any") {
    return { kind: predicate.kind, predicates: predicate.predicates.map(predicateForHash) };
  }
  if (predicate.kind === "not") {
    return { kind: predicate.kind, predicate: predicateForHash(predicate.predicate) };
  }
  if (predicate.kind !== "link_exists") {
    throw new TypeError("Unsupported compiled Query predicate.");
  }
  return {
    kind: predicate.kind,
    source: predicate.source.apiName,
    sourceRevisionId: predicate.source.revisionId,
    sourceGenerationId: predicate.source.generationId,
    link: predicate.link.apiName,
    linkRevisionId: predicate.link.revisionId,
    linkGenerationId: predicate.link.generationId,
    target: predicate.target.apiName,
    targetRevisionId: predicate.target.revisionId,
    targetGenerationId: predicate.target.generationId,
    predicate: predicateForHash(predicate.predicate),
  };
}

function operandForHash(operand: QueryTypedOperand): unknown {
  return operandHash(operand);
}

function operandHash(operand: QueryTypedOperand): unknown {
  if (operand.kind === "property") {
    return {
      kind: operand.kind,
      scope: operand.scope,
      property: operand.property.apiName,
      valueType: operand.property.valueType,
    };
  }
  if (operand.kind === "missing") return { kind: operand.kind, valueType: operand.valueType };
  return {
    kind: operand.kind,
    valueType: operand.valueType,
    collection: operand.collection,
    value: operand.value,
  };
}

function searchForHash(search: QuerySearchPlan | null): unknown {
  return search === null
    ? null
    : {
        text: search.text,
        properties: search.properties.map(({ apiName }) => apiName),
      };
}

function sortForHash(sort: QuerySortPlan): unknown {
  return sort.kind === "property"
    ? {
        kind: sort.kind,
        property: sort.property.apiName,
        direction: sort.direction,
        enumDeclarationOrder: sort.enumDeclarationOrder,
      }
    : sort;
}

function objectIdentity(object: QueryObjectTypeSchema): Readonly<Record<string, string>> {
  return Object.freeze({
    apiName: object.apiName,
    resourceId: object.resourceId,
    revisionId: object.revisionId,
    generationId: object.generationId,
  });
}

function digestQuery(digester: QueryTextDigester, value: unknown): ArtifactDigest {
  try {
    return parseArtifactDigest(digester(canonicalizeContractForDigest(value)));
  } catch (error) {
    failQuery("QUERY_BINDING_INVALID", "Query Hash could not be produced.", { cause: error });
  }
}

function normalizeParameterCollection(parameter: QueryParameterOperand): QueryParameterOperand {
  if (!parameter.collection || !Array.isArray(parameter.value)) return parameter;
  if (parameter.value.every((value): value is boolean => typeof value === "boolean")) {
    return Object.freeze({
      ...parameter,
      value: Object.freeze(
        [...parameter.value].sort((left, right) => Number(left) - Number(right)),
      ),
    });
  }
  if (parameter.value.every((value): value is string => typeof value === "string")) {
    return Object.freeze({
      ...parameter,
      value: Object.freeze(
        [...parameter.value].sort((left, right) =>
          compareText(canonicalizeContractForDigest(left), canonicalizeContractForDigest(right)),
        ),
      ),
    });
  }
  failQuery("INVALID_QUERY_AST", "Query collection contains mixed value types.");
}

function requiredArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalidOperator();
  return value;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("Expected a compiled Query value.");
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    failQuery("QUERY_BINDING_INVALID", `${label} is outside the supported envelope.`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
