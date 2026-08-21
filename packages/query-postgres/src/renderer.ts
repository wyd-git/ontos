import {
  QUERY_SQL_MAXIMUM_BYTES,
  QUERY_SQL_MAXIMUM_PARAMETERS,
  assertAuthenticQueryLogicalPlan,
  type LinkCandidateLogicalPlan,
  type ObjectCountLogicalPlan,
  type ObjectGetLogicalPlan,
  type ObjectSearchLogicalPlan,
  type QueryLogicalPlan,
  type QueryOperandValueType,
  type QueryPolicyPlan,
  type QueryPredicatePlan,
  type QueryPropertyAccessPlan,
  type QueryPropertySchema,
  type QuerySearchPlan,
  type QuerySortPlan,
  type QueryTypedOperand,
} from "@ontos/query-domain";

export type QueryStatementName =
  | "ontos_object_get_v1"
  | "ontos_runtime_object_get_v1"
  | "ontos_object_search_v1"
  | "ontos_object_count_v1"
  | "ontos_link_candidate_v1";

export type QueryCompositionStage =
  | "lease_context"
  | "current_generation"
  | "row_policy"
  | "property_policy"
  | "client_predicate"
  | "search"
  | "sort"
  | "limit";

export interface ParameterizedQueryStatement {
  readonly name: QueryStatementName;
  readonly operation: QueryLogicalPlan["operation"];
  readonly text: string;
  readonly values: readonly unknown[];
  readonly parameterTypes: readonly string[];
  readonly composition: readonly QueryCompositionStage[];
  readonly statementTimeoutMs: number;
  readonly maximumResultRows: number;
  readonly maximumResultBytes: number;
}

export interface RuntimeQueryReadAccess {
  readonly projectId: string;
  readonly queryLeaseId: string;
  readonly releaseId: string;
  readonly activationId: string;
  readonly identityContextHash: string;
  readonly policyContextHash: string;
  readonly queryHash: string;
}

const authenticStatements = new WeakSet<object>();

export function renderPostgresQuery(plan: QueryLogicalPlan): ParameterizedQueryStatement {
  assertAuthenticQueryLogicalPlan(plan);
  const parameters = new Parameters();
  const rendered = renderPlan(plan, parameters);
  return finalizeStatement(plan, rendered, parameters);
}

export function renderRuntimeObjectGet(
  plan: ObjectGetLogicalPlan,
  access: RuntimeQueryReadAccess,
): ParameterizedQueryStatement {
  assertAuthenticQueryLogicalPlan(plan);
  assertRuntimeReadAccess(plan, access);
  const parameters = new Parameters();
  const activation = `runtime.activate_query_read_context(
    ${parameters.add(access.projectId, "uuid", "project_id")},
    ${parameters.add(access.queryLeaseId, "uuid", "query_lease_id")},
    ${parameters.add(access.releaseId, "uuid", "release_id")},
    ${parameters.add(access.activationId, "uuid", "activation_id")},
    ${parameters.add(access.identityContextHash, "text", "identity_context_hash")},
    ${parameters.add(access.policyContextHash, "text", "policy_context_hash")},
    ${parameters.add(access.queryHash, "text", "query_hash")}
  )`;
  const rendered = renderObjectGet(plan, parameters, {
    name: "ontos_runtime_object_get_v1",
    objectRelation: "runtime.query_object_current",
    linkRelation: "runtime.query_link_current",
    projectionIncludesObjectVersion: true,
    prefix: `WITH read_context AS MATERIALIZED (
  SELECT ${activation} AS active
)`,
    activationBeforeRead: true,
    compositionPrefix: Object.freeze<QueryCompositionStage[]>(["lease_context"]),
  });
  return finalizeStatement(plan, rendered, parameters);
}

function finalizeStatement(
  plan: QueryLogicalPlan,
  rendered: RenderedPlan,
  parameters: Parameters,
): ParameterizedQueryStatement {
  const byteLength = new TextEncoder().encode(rendered.text).byteLength;
  if (
    parameters.values.length > QUERY_SQL_MAXIMUM_PARAMETERS ||
    byteLength > QUERY_SQL_MAXIMUM_BYTES
  ) {
    throw new PostgresQueryRenderError("QUERY_SQL_ENVELOPE_EXCEEDED");
  }
  const statement = Object.freeze({
    ...rendered,
    operation: plan.operation,
    values: Object.freeze([...parameters.values]),
    parameterTypes: Object.freeze([...parameters.types]),
    statementTimeoutMs: plan.statementTimeoutMs,
    maximumResultRows: plan.maximumResultRows,
    maximumResultBytes: plan.maximumResultBytes,
  });
  authenticStatements.add(statement);
  return statement;
}

const runtimeUuidExpression =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const runtimeDigestExpression = /^sha256:[0-9a-f]{64}$/u;

function assertRuntimeReadAccess(plan: ObjectGetLogicalPlan, access: RuntimeQueryReadAccess): void {
  if (
    plan.operation !== "object_get" ||
    access.projectId !== plan.binding.projectId ||
    access.releaseId !== plan.binding.releaseId ||
    access.activationId !== plan.binding.activationId ||
    access.queryHash !== plan.queryHash ||
    !runtimeUuidExpression.test(access.projectId) ||
    !runtimeUuidExpression.test(access.queryLeaseId) ||
    !runtimeUuidExpression.test(access.releaseId) ||
    !runtimeUuidExpression.test(access.activationId) ||
    !runtimeDigestExpression.test(access.identityContextHash) ||
    !runtimeDigestExpression.test(access.policyContextHash) ||
    !runtimeDigestExpression.test(access.queryHash)
  ) {
    throw new PostgresQueryRenderError("QUERY_STATEMENT_UNTRUSTED");
  }
}

export function assertAuthenticParameterizedQueryStatement(
  value: unknown,
): asserts value is ParameterizedQueryStatement {
  if (typeof value !== "object" || value === null || !authenticStatements.has(value)) {
    throw new PostgresQueryRenderError("QUERY_STATEMENT_UNTRUSTED");
  }
}

export type PostgresQueryRenderErrorCode =
  "QUERY_SQL_ENVELOPE_EXCEEDED" | "QUERY_STATEMENT_UNTRUSTED";

export class PostgresQueryRenderError extends Error {
  readonly code: PostgresQueryRenderErrorCode;

  constructor(code: PostgresQueryRenderErrorCode) {
    super("PostgreSQL Query rendering failed closed.");
    this.name = "PostgresQueryRenderError";
    this.code = code;
  }
}

interface RenderedPlan {
  readonly name: QueryStatementName;
  readonly text: string;
  readonly composition: readonly QueryCompositionStage[];
}

interface ObjectGetRenderOptions {
  readonly name: Extract<QueryStatementName, "ontos_object_get_v1" | "ontos_runtime_object_get_v1">;
  readonly objectRelation: string;
  readonly linkRelation: string;
  readonly projectionIncludesObjectVersion: boolean;
  readonly prefix: string;
  readonly activationBeforeRead: boolean;
  readonly compositionPrefix: readonly QueryCompositionStage[];
}

const baseObjectGetOptions: ObjectGetRenderOptions = Object.freeze({
  name: "ontos_object_get_v1",
  objectRelation: "runtime.object_current",
  linkRelation: "runtime.link_current",
  projectionIncludesObjectVersion: false,
  prefix: "",
  activationBeforeRead: false,
  compositionPrefix: Object.freeze([]),
});

class Parameters {
  readonly values: unknown[] = [];
  readonly types: string[] = [];

  add(value: unknown, pgType: string, semanticType: string): string {
    if (!SAFE_PG_TYPES.has(pgType)) throw new PostgresQueryRenderError("QUERY_STATEMENT_UNTRUSTED");
    this.values.push(value);
    this.types.push(semanticType);
    return `$${String(this.values.length)}::${pgType}`;
  }
}

const SAFE_PG_TYPES = new Set([
  "boolean",
  "boolean[]",
  "bigint",
  "bigint[]",
  "date",
  "date[]",
  "integer",
  "numeric",
  "numeric[]",
  "text",
  "text[]",
  "timestamptz",
  "timestamptz[]",
  "uuid",
]);

function renderPlan(plan: QueryLogicalPlan, parameters: Parameters): RenderedPlan {
  switch (plan.operation) {
    case "object_get":
      return renderObjectGet(plan, parameters);
    case "object_search":
      return renderObjectSearch(plan, parameters);
    case "object_count":
      return renderObjectCount(plan, parameters);
    case "link_candidate":
      return renderLinkCandidate(plan, parameters);
  }
}

function renderObjectGet(
  plan: ObjectGetLogicalPlan,
  parameters: Parameters,
  options: ObjectGetRenderOptions = baseObjectGetOptions,
): RenderedPlan {
  const aliases = aliasState(options.objectRelation, options.linkRelation);
  const current = "object_current";
  const where = [
    ...objectBindingPredicates(current, plan, plan.object, parameters),
    `${current}.canonical_primary_key = ${parameters.add(
      plan.canonicalPrimaryKey,
      "text",
      "canonical_primary_key",
    )}`,
    rowPolicyPredicate(current, plan.policy, plan, parameters, aliases),
  ];
  const limit = parameters.add(2, "integer", "row_limit");
  const prefix = options.prefix.length === 0 ? "" : `${options.prefix}\n`;
  const from = options.activationBeforeRead
    ? `read_context
CROSS JOIN LATERAL (
  SELECT *
  FROM ${options.objectRelation}
  WHERE read_context.active
  OFFSET 0
) AS ${current}`
    : `${options.objectRelation} AS ${current}`;
  return Object.freeze({
    name: options.name,
    text: `${prefix}SELECT ${objectProjection(current, plan.selectedProperties, plan.policy, plan, parameters, aliases, options.projectionIncludesObjectVersion)}
FROM ${from}
WHERE ${where.join("\n  AND ")}
LIMIT ${limit}`,
    composition: Object.freeze<QueryCompositionStage[]>([
      ...options.compositionPrefix,
      "current_generation",
      "row_policy",
      "property_policy",
      "limit",
    ]),
  });
}

function renderObjectSearch(plan: ObjectSearchLogicalPlan, parameters: Parameters): RenderedPlan {
  const aliases = aliasState();
  const current = "object_current";
  const where = [
    ...objectBindingPredicates(current, plan, plan.object, parameters),
    rowPolicyPredicate(current, plan.policy, plan, parameters, aliases),
  ];
  if (plan.clientPredicate !== null) {
    where.push(`(${renderPredicate(plan.clientPredicate, current, plan, parameters, aliases)})`);
  }
  if (plan.search !== null) {
    where.push(searchPredicate(plan.search, current, plan.policy, plan, parameters, aliases));
  }
  const limit = parameters.add(plan.pageSize, "integer", "row_limit");
  const composition: QueryCompositionStage[] = [
    "current_generation",
    "row_policy",
    "property_policy",
  ];
  if (plan.clientPredicate !== null) composition.push("client_predicate");
  if (plan.search !== null) composition.push("search");
  composition.push("sort", "limit");
  return Object.freeze({
    name: "ontos_object_search_v1",
    text: `SELECT ${objectProjection(current, plan.selectedProperties, plan.policy, plan, parameters, aliases)}
FROM runtime.object_current AS ${current}
WHERE ${where.join("\n  AND ")}
ORDER BY ${orderBy(current, plan.sort, parameters)}
LIMIT ${limit}`,
    composition: Object.freeze(composition),
  });
}

function renderObjectCount(plan: ObjectCountLogicalPlan, parameters: Parameters): RenderedPlan {
  const aliases = aliasState();
  const current = "object_current";
  const where = [
    ...objectBindingPredicates(current, plan, plan.object, parameters),
    rowPolicyPredicate(current, plan.policy, plan, parameters, aliases),
  ];
  if (plan.clientPredicate !== null) {
    where.push(`(${renderPredicate(plan.clientPredicate, current, plan, parameters, aliases)})`);
  }
  if (plan.search !== null) {
    where.push(searchPredicate(plan.search, current, plan.policy, plan, parameters, aliases));
  }
  const composition: QueryCompositionStage[] = ["current_generation", "row_policy"];
  if (plan.clientPredicate !== null) composition.push("property_policy", "client_predicate");
  if (plan.search !== null) composition.push("property_policy", "search");
  return Object.freeze({
    name: "ontos_object_count_v1",
    text: `SELECT count(*)::text AS "count"
FROM runtime.object_current AS ${current}
WHERE ${where.join("\n  AND ")}`,
    composition: Object.freeze([...new Set(composition)]),
  });
}

function renderLinkCandidate(plan: LinkCandidateLogicalPlan, parameters: Parameters): RenderedPlan {
  const aliases = aliasState();
  const source = "source_current";
  const link = "link_current";
  const target = "target_current";
  const sourceRid = plan.direction === "outgoing" ? "source_object_rid" : "target_object_rid";
  const targetRid = plan.direction === "outgoing" ? "target_object_rid" : "source_object_rid";
  const sourceType =
    plan.direction === "outgoing"
      ? "source_object_type_resource_id"
      : "target_object_type_resource_id";
  const targetType =
    plan.direction === "outgoing"
      ? "target_object_type_resource_id"
      : "source_object_type_resource_id";
  const where = [
    ...objectBindingPredicates(source, plan, plan.sourceObject, parameters),
    `${source}.canonical_primary_key = ${parameters.add(
      plan.sourceCanonicalPrimaryKey,
      "text",
      "canonical_primary_key",
    )}`,
    `${link}.generation_id = ${parameters.add(plan.link.generationId, "uuid", "generation_id")}`,
    `${link}.link_type_resource_id = ${parameters.add(
      plan.link.resourceId,
      "uuid",
      "link_type_resource_id",
    )}`,
    `${link}.link_type_revision_id = ${parameters.add(
      plan.link.revisionId,
      "uuid",
      "link_type_revision_id",
    )}`,
    `${link}.${sourceType} = ${parameters.add(
      plan.sourceObject.resourceId,
      "uuid",
      "source_object_type_resource_id",
    )}`,
    `${link}.${targetType} = ${parameters.add(
      plan.targetObject.resourceId,
      "uuid",
      "target_object_type_resource_id",
    )}`,
    ...objectBindingPredicates(target, plan, plan.targetObject, parameters),
    rowPolicyPredicate(source, plan.sourcePolicy, plan, parameters, aliases),
    rowPolicyPredicate(link, plan.linkPolicy, plan, parameters, aliases),
    rowPolicyPredicate(target, plan.targetPolicy, plan, parameters, aliases),
  ];
  if (plan.clientPredicate !== null) {
    where.push(`(${renderPredicate(plan.clientPredicate, target, plan, parameters, aliases)})`);
  }
  if (plan.search !== null) {
    where.push(searchPredicate(plan.search, target, plan.targetPolicy, plan, parameters, aliases));
  }
  const limit = parameters.add(plan.pageSize, "integer", "row_limit");
  const composition: QueryCompositionStage[] = [
    "current_generation",
    "row_policy",
    "property_policy",
  ];
  if (plan.clientPredicate !== null) composition.push("client_predicate");
  if (plan.search !== null) composition.push("search");
  composition.push("sort", "limit");
  return Object.freeze({
    name: "ontos_link_candidate_v1",
    text: `SELECT ${objectProjection(target, plan.selectedProperties, plan.targetPolicy, plan, parameters, aliases)}
FROM runtime.object_current AS ${source}
JOIN runtime.link_current AS ${link}
  ON ${link}.project_id = ${source}.project_id
 AND ${link}.${sourceRid} = ${source}.object_rid
JOIN runtime.object_current AS ${target}
  ON ${target}.project_id = ${link}.project_id
 AND ${target}.object_rid = ${link}.${targetRid}
WHERE ${where.join("\n  AND ")}
ORDER BY ${orderBy(target, plan.sort, parameters)}
LIMIT ${limit}`,
    composition: Object.freeze(composition),
  });
}

function objectBindingPredicates(
  alias: string,
  plan: QueryLogicalPlan,
  object: ObjectGetLogicalPlan["object"],
  parameters: Parameters,
): readonly string[] {
  return [
    `${alias}.project_id = ${parameters.add(plan.binding.projectId, "uuid", "project_id")}`,
    `${alias}.generation_id = ${parameters.add(object.generationId, "uuid", "generation_id")}`,
    `${alias}.object_type_resource_id = ${parameters.add(
      object.resourceId,
      "uuid",
      "object_type_resource_id",
    )}`,
    `${alias}.object_type_revision_id = ${parameters.add(
      object.revisionId,
      "uuid",
      "object_type_revision_id",
    )}`,
    `${alias}.lifecycle_state = 'active'`,
  ];
}

function rowPolicyPredicate(
  alias: string,
  policy: QueryPolicyPlan,
  plan: QueryLogicalPlan,
  parameters: Parameters,
  aliases: AliasState,
): string {
  const allow = renderPredicate(policy.rowAllow, alias, plan, parameters, aliases);
  const deny = renderPredicate(policy.rowDeny, alias, plan, parameters, aliases);
  // A WHERE clause already accepts only TRUE.  Keeping the positive predicate
  // bare preserves SQL three-valued semantics while allowing PostgreSQL to
  // turn comparisons into Published Index conditions.  Deny remains explicit:
  // only TRUE denies, while FALSE and UNKNOWN do not widen the allow side.
  return `((${allow}) AND ((${deny}) IS NOT TRUE))`;
}

function renderPredicate(
  predicate: QueryPredicatePlan,
  currentAlias: string,
  plan: QueryLogicalPlan,
  parameters: Parameters,
  aliases: AliasState,
): string {
  if (predicate.kind === "constant") return predicate.value ? "TRUE" : "FALSE";
  if (predicate.kind === "compare") {
    return renderComparison(predicate, currentAlias, parameters);
  }
  if (predicate.kind === "is_null") {
    if (predicate.operand.kind === "missing") return "NULL::boolean";
    if (predicate.operand.kind === "parameter") return "FALSE";
    return `CASE WHEN ${propertyEnvelopeExpression(currentAlias, predicate.operand.property)} IS NULL THEN NULL::boolean ELSE ${propertyJsonExpression(currentAlias, predicate.operand.property)} = 'null'::jsonb END`;
  }
  if (predicate.kind === "all" || predicate.kind === "any") {
    const joiner = predicate.kind === "all" ? " AND " : " OR ";
    return `(${predicate.predicates
      .map((item) => `(${renderPredicate(item, currentAlias, plan, parameters, aliases)})`)
      .join(joiner)})`;
  }
  if (predicate.kind === "not") {
    return `NOT (${renderPredicate(predicate.predicate, currentAlias, plan, parameters, aliases)})`;
  }
  if (predicate.kind !== "link_exists") {
    throw new PostgresQueryRenderError("QUERY_STATEMENT_UNTRUSTED");
  }
  const ordinal = aliases.next++;
  const linkAlias = `policy_link_${String(ordinal)}`;
  const targetAlias = `policy_target_${String(ordinal)}`;
  const nested = renderPredicate(predicate.predicate, targetAlias, plan, parameters, aliases);
  return `EXISTS (
    SELECT 1
    FROM ${aliases.linkRelation} AS ${linkAlias}
    JOIN ${aliases.objectRelation} AS ${targetAlias}
      ON ${targetAlias}.project_id = ${linkAlias}.project_id
     AND ${targetAlias}.object_rid = ${linkAlias}.target_object_rid
    WHERE ${linkAlias}.project_id = ${parameters.add(plan.binding.projectId, "uuid", "project_id")}
      AND ${linkAlias}.generation_id = ${parameters.add(predicate.link.generationId, "uuid", "generation_id")}
      AND ${linkAlias}.link_type_resource_id = ${parameters.add(predicate.link.resourceId, "uuid", "link_type_resource_id")}
      AND ${linkAlias}.link_type_revision_id = ${parameters.add(predicate.link.revisionId, "uuid", "link_type_revision_id")}
      AND ${linkAlias}.source_object_type_resource_id = ${parameters.add(
        predicate.source.resourceId,
        "uuid",
        "source_object_type_resource_id",
      )}
      AND ${linkAlias}.target_object_type_resource_id = ${parameters.add(predicate.target.resourceId, "uuid", "target_object_type_resource_id")}
      AND ${linkAlias}.source_object_rid = ${currentAlias}.object_rid
      AND ${targetAlias}.generation_id = ${parameters.add(predicate.target.generationId, "uuid", "generation_id")}
      AND ${targetAlias}.object_type_resource_id = ${parameters.add(predicate.target.resourceId, "uuid", "object_type_resource_id")}
      AND ${targetAlias}.object_type_revision_id = ${parameters.add(predicate.target.revisionId, "uuid", "object_type_revision_id")}
      AND ${targetAlias}.lifecycle_state = 'active'
      AND (${nested})
  )`;
}

function renderComparison(
  predicate: Extract<QueryPredicatePlan, { readonly kind: "compare" }>,
  currentAlias: string,
  parameters: Parameters,
): string {
  if (predicate.left.kind === "missing" || predicate.right.kind === "missing") {
    return "NULL::boolean";
  }
  if (predicate.op === "containsAny") {
    const left = propertyOrOperand(predicate.left, currentAlias, parameters);
    if (predicate.right.kind !== "parameter" || !Array.isArray(predicate.right.value)) {
      throw new PostgresQueryRenderError("QUERY_STATEMENT_UNTRUSTED");
    }
    const clauses = predicate.right.value.map((value) => {
      const item = parameters.add(value, "text", "string_array_item");
      return `${left} @> to_jsonb(ARRAY[${item}]::text[])`;
    });
    return clauses.length === 0 ? "FALSE" : `(${clauses.join(" OR ")})`;
  }
  if (predicate.op === "in") {
    const left = propertyOrOperand(predicate.left, currentAlias, parameters);
    const right = parameterExpression(predicate.right, parameters, true);
    return `${left} = ANY(${right})`;
  }
  const left = propertyOrOperand(predicate.left, currentAlias, parameters);
  const right = propertyOrOperand(predicate.right, currentAlias, parameters);
  if (predicate.op === "contains" || predicate.op === "prefix") {
    const prefix = predicate.op === "contains" ? "'%' || " : "";
    const suffix = " || '%'";
    return `${left} LIKE ${prefix}${escapedLikeExpression(right)}${suffix} ESCAPE '\\'`;
  }
  if (
    (predicate.op === "lt" ||
      predicate.op === "lte" ||
      predicate.op === "gt" ||
      predicate.op === "gte") &&
    predicate.left.kind === "property" &&
    predicate.left.property.valueType === "enum"
  ) {
    const order = predicate.left.property.enumValues;
    if (order === null) throw new PostgresQueryRenderError("QUERY_STATEMENT_UNTRUSTED");
    const enumOrder = parameters.add(order, "text[]", "enum_declaration_order");
    return `array_position(${enumOrder}, ${left}) ${comparisonOperator(predicate.op)} array_position(${enumOrder}, ${right})`;
  }
  return `${left} ${comparisonOperator(predicate.op)} ${right}`;
}

function propertyOrOperand(
  operand: QueryTypedOperand,
  currentAlias: string,
  parameters: Parameters,
): string {
  if (operand.kind === "property") {
    return typedPropertyExpression(currentAlias, operand.property);
  }
  if (operand.kind === "missing") return `NULL::${pgScalarType(operand.valueType)}`;
  return parameterExpression(operand, parameters, false);
}

function parameterExpression(
  operand: QueryTypedOperand,
  parameters: Parameters,
  forceArray: boolean,
): string {
  if (operand.kind !== "parameter") {
    throw new PostgresQueryRenderError("QUERY_STATEMENT_UNTRUSTED");
  }
  const array = forceArray || operand.collection;
  const pgType = array ? `${pgScalarType(operand.valueType)}[]` : pgScalarType(operand.valueType);
  return parameters.add(operand.value, pgType, operand.valueType);
}

function typedPropertyExpression(alias: string, property: QueryPropertySchema): string {
  const text = propertyTextExpression(alias, property);
  switch (property.valueType) {
    case "string":
    case "enum":
      return `${text} COLLATE "C"`;
    case "integer":
      return `${text}::bigint`;
    case "decimal":
      return `${text}::numeric`;
    case "date":
      return `runtime.ontos_index_date(${text})`;
    case "timestamp":
      return `runtime.ontos_index_timestamp(${text})`;
    case "boolean":
      return `${text}::boolean`;
    case "string[]":
    case "json":
      return propertyJsonExpression(alias, property);
  }
}

function propertyTextExpression(alias: string, property: QueryPropertySchema): string {
  return `(${alias}.properties #>> ${quoteTrustedLiteral(propertyPath(property))}::text[])`;
}

function propertyJsonExpression(alias: string, property: QueryPropertySchema): string {
  return `(${alias}.properties #> ${quoteTrustedLiteral(propertyPath(property))}::text[])`;
}

function propertyEnvelopeExpression(alias: string, property: QueryPropertySchema): string {
  return `(${alias}.properties #> ${quoteTrustedLiteral(`{values,${property.apiName}}`)}::text[])`;
}

function propertyPath(property: QueryPropertySchema): string {
  return `{values,${property.apiName},value}`;
}

function objectProjection(
  alias: string,
  selected: readonly QueryPropertySchema[],
  policy: QueryPolicyPlan,
  plan: QueryLogicalPlan,
  parameters: Parameters,
  aliases: AliasState,
  includeObjectVersion = false,
): string {
  const properties = selected.map((property) => {
    const access = requiredAccess(policy, property);
    const name = parameters.add(property.apiName, "text", "property_api_name");
    return `jsonb_build_object(${name}, ${propertyProjection(alias, property, access, plan, parameters, aliases)})`;
  });
  const propertyObject = properties.length === 0 ? "'{}'::jsonb" : properties.join(" || ");
  const objectVersion = includeObjectVersion
    ? `\n       ${alias}.object_version AS "objectVersion",`
    : "";
  return `${alias}.object_rid::text AS "objectRid",
       ${alias}.canonical_primary_key AS "canonicalPrimaryKey",${objectVersion}
       (${propertyObject}) AS "properties"`;
}

function propertyProjection(
  alias: string,
  property: QueryPropertySchema,
  access: QueryPropertyAccessPlan,
  plan: QueryLogicalPlan,
  parameters: Parameters,
  aliases: AliasState,
): string {
  const deny = renderPredicate(access.deny, alias, plan, parameters, aliases);
  const allow = renderPredicate(access.allow, alias, plan, parameters, aliases);
  const maskCases = access.masks
    .map((mask) => {
      const predicate = renderPredicate(mask.predicate, alias, plan, parameters, aliases);
      const display = parameters.add(mask.displayValue, "text", "mask_display_value");
      return `WHEN (${predicate}) IS TRUE THEN jsonb_build_object('state', 'masked', 'displayValue', ${display})`;
    })
    .join("\n         ");
  const envelope = propertyEnvelopeExpression(alias, property);
  const value = propertyJsonExpression(alias, property);
  return `CASE
         WHEN (${deny}) IS TRUE THEN jsonb_build_object('state', 'restricted')
         ${maskCases}
         WHEN (${allow}) IS TRUE THEN
           CASE
             WHEN ${envelope} IS NULL THEN jsonb_build_object('state', 'missing')
             WHEN ${value} = 'null'::jsonb THEN jsonb_build_object('state', 'null')
             ELSE jsonb_build_object('state', 'value', 'value', ${value})
           END
         ELSE jsonb_build_object('state', 'restricted')
       END`;
}

function searchPredicate(
  search: QuerySearchPlan,
  alias: string,
  policy: QueryPolicyPlan,
  plan: QueryLogicalPlan,
  parameters: Parameters,
  aliases: AliasState,
): string {
  const needle = parameters.add(search.text, "text", "search_text");
  const escaped = escapedLikeExpression(needle);
  const branches = search.properties.map((property) => {
    const access = requiredAccess(policy, property);
    const allowed = propertyAllowedPredicate(access, alias, plan, parameters, aliases);
    const operator = property.caseSensitive ? "LIKE" : "ILIKE";
    return `((${allowed}) AND ${typedPropertyExpression(alias, property)} ${operator} '%' || ${escaped} || '%' ESCAPE '\\')`;
  });
  return `(${branches.join(" OR ")})`;
}

function propertyAllowedPredicate(
  access: QueryPropertyAccessPlan,
  alias: string,
  plan: QueryLogicalPlan,
  parameters: Parameters,
  aliases: AliasState,
): string {
  const allow = renderPredicate(access.allow, alias, plan, parameters, aliases);
  const deny = renderPredicate(access.deny, alias, plan, parameters, aliases);
  const masks = access.masks.map((mask) =>
    renderPredicate(mask.predicate, alias, plan, parameters, aliases),
  );
  return `((${allow}) AND ((${deny}) IS NOT TRUE)${masks
    .map((mask) => ` AND ((${mask}) IS NOT TRUE)`)
    .join("")})`;
}

function orderBy(alias: string, sort: QuerySortPlan, parameters: Parameters): string {
  const primaryKey = `${alias}.canonical_primary_key COLLATE "C"`;
  if (sort.kind === "canonical_primary_key") return `${primaryKey} ${sort.direction.toUpperCase()}`;
  if (sort.kind === "relevance") {
    throw new PostgresQueryRenderError("QUERY_STATEMENT_UNTRUSTED");
  }
  const direction = sort.direction.toUpperCase();
  if (sort.property.valueType === "enum") {
    if (sort.enumDeclarationOrder === null) {
      throw new PostgresQueryRenderError("QUERY_STATEMENT_UNTRUSTED");
    }
    const declarationOrder = parameters.add(
      sort.enumDeclarationOrder,
      "text[]",
      "enum_declaration_order",
    );
    return `array_position(${declarationOrder}, ${typedPropertyExpression(alias, sort.property)}) ${direction} NULLS LAST, ${primaryKey} ASC`;
  }
  return `${typedPropertyExpression(alias, sort.property)} ${direction} NULLS LAST, ${primaryKey} ASC`;
}

function requiredAccess(
  policy: QueryPolicyPlan,
  property: QueryPropertySchema,
): QueryPropertyAccessPlan {
  const access = policy.propertyAccess.find(
    (candidate) => candidate.property.apiName === property.apiName,
  );
  if (access === undefined) throw new PostgresQueryRenderError("QUERY_STATEMENT_UNTRUSTED");
  return access;
}

function comparisonOperator(operator: string): string {
  switch (operator) {
    case "eq":
      return "=";
    case "ne":
      return "<>";
    case "lt":
      return "<";
    case "lte":
      return "<=";
    case "gt":
      return ">";
    case "gte":
      return ">=";
    default:
      throw new PostgresQueryRenderError("QUERY_STATEMENT_UNTRUSTED");
  }
}

function pgScalarType(valueType: QueryOperandValueType): string {
  switch (valueType) {
    case "boolean":
      return "boolean";
    case "integer":
      return "bigint";
    case "decimal":
      return "numeric";
    case "date":
      return "date";
    case "timestamp":
      return "timestamptz";
    case "enum":
    case "string":
    case "string_array":
      return "text";
    case "json":
      throw new PostgresQueryRenderError("QUERY_STATEMENT_UNTRUSTED");
  }
}

function escapedLikeExpression(expression: string): string {
  return `replace(replace(replace(${expression}, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;
}

function quoteTrustedLiteral(value: string): string {
  if (!/^\{values,[A-Za-z][A-Za-z0-9_]{0,62}(?:,value)?\}$/u.test(value)) {
    throw new PostgresQueryRenderError("QUERY_STATEMENT_UNTRUSTED");
  }
  return `'${value}'`;
}

interface AliasState {
  next: number;
  readonly objectRelation: string;
  readonly linkRelation: string;
}

function aliasState(
  objectRelation = "runtime.object_current",
  linkRelation = "runtime.link_current",
): AliasState {
  return { next: 1, objectRelation, linkRelation };
}
