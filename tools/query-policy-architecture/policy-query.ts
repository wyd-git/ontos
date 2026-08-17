export type MemberKind = "object" | "link";
export type PolicyScope = "object" | "source" | "link" | "target";

export interface ServingMember {
  readonly memberKey: string;
  readonly kind: MemberKind;
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly generationId: string;
}

export interface ServingContext {
  readonly resolution: "release-serving-head";
  readonly projectId: string;
  readonly releaseId: string;
  readonly activationId: string;
  readonly members: readonly ServingMember[];
}

export interface PropertyCapability {
  readonly apiName: string;
  readonly valueType: "string";
  readonly filterable: boolean;
  readonly sortable: boolean;
  readonly access: "allow" | "mask" | "deny";
  readonly policyUsable: boolean;
}

export type RowPolicy =
  | Readonly<{ kind: "allow" }>
  | Readonly<{
      kind: "compare";
      property: PropertyCapability;
      operator: "eq" | "lt" | "lte" | "gt" | "gte";
      value: string;
    }>;

export interface ClientFilter {
  readonly property: PropertyCapability;
  readonly operator: "eq" | "lt" | "lte" | "gt" | "gte";
  readonly value: string;
}

export type CompositionStage = Readonly<
  | { kind: "current-generation"; scope: PolicyScope }
  | { kind: "row-policy"; scope: PolicyScope }
  | { kind: "client-filter"; scope: PolicyScope }
  | { kind: "lookup"; scope: PolicyScope }
  | { kind: "order"; scope: PolicyScope }
  | { kind: "pagination"; scope: PolicyScope }
>;

export interface CompiledReadStatement {
  readonly name: "typed-get" | "object-list" | "policy-count" | "one-hop-link";
  readonly text: string;
  readonly values: readonly unknown[];
  readonly parameterTypes: readonly string[];
  readonly composition: readonly CompositionStage[];
}

const apiNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,62}$/u;
const memberKeyPattern = /^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const operators = Object.freeze({ eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" });

class Parameters {
  readonly values: unknown[] = [];
  readonly types: string[] = [];

  add(value: unknown, type: string): string {
    this.values.push(value);
    this.types.push(type);
    return `$${String(this.values.length)}`;
  }
}

export function compileTypedGet(
  context: ServingContext,
  input: Readonly<{
    memberKey: string;
    canonicalPrimaryKey: string;
    selectedProperties: readonly PropertyCapability[];
    policy: RowPolicy;
  }>,
): CompiledReadStatement {
  const member = requireMember(context, input.memberKey, "object");
  requireCanonicalPrimaryKey(input.canonicalPrimaryKey);
  const parameters = contextParameters(context, member);
  const canonicalKey = parameters.add(input.canonicalPrimaryKey, "canonical-primary-key");
  const policy = compilePolicy("current", input.policy, parameters);
  const composition = Object.freeze<CompositionStage[]>([
    { kind: "current-generation", scope: "object" },
    { kind: "row-policy", scope: "object" },
    { kind: "lookup", scope: "object" },
    { kind: "pagination", scope: "object" },
  ]);
  assertSafeComposition(composition, ["object"]);
  return statement(
    "typed-get",
    `SELECT current.object_rid::text AS "objectRid",
            current.canonical_primary_key AS "canonicalPrimaryKey",
            ${propertyProjection("current", input.selectedProperties)} AS properties
       FROM runtime.object_current AS current
      WHERE current.project_id = $1::uuid
        AND current.generation_id = $2::uuid
        AND current.object_type_resource_id = $3::uuid
        AND current.object_type_revision_id = $4::uuid
        AND current.lifecycle_state = 'active'
        AND current.canonical_primary_key = ${canonicalKey}
        AND (${policy})
      LIMIT 2`,
    parameters,
    composition,
  );
}

export function compileObjectList(
  context: ServingContext,
  input: Readonly<{
    memberKey: string;
    selectedProperties: readonly PropertyCapability[];
    policy: RowPolicy;
    filter?: ClientFilter;
    limit: number;
  }>,
): CompiledReadStatement {
  const member = requireMember(context, input.memberKey, "object");
  requireLimit(input.limit);
  const parameters = contextParameters(context, member);
  const policy = compilePolicy("current", input.policy, parameters);
  const filter =
    input.filter === undefined ? null : compileClientFilter("current", input.filter, parameters);
  const limit = parameters.add(input.limit, "limit");
  const composition: CompositionStage[] = [
    { kind: "current-generation", scope: "object" },
    { kind: "row-policy", scope: "object" },
  ];
  if (filter !== null) composition.push({ kind: "client-filter", scope: "object" });
  composition.push({ kind: "order", scope: "object" }, { kind: "pagination", scope: "object" });
  assertSafeComposition(composition, ["object"]);
  return statement(
    "object-list",
    `SELECT current.object_rid::text AS "objectRid",
            current.canonical_primary_key AS "canonicalPrimaryKey",
            ${propertyProjection("current", input.selectedProperties)} AS properties
       FROM runtime.object_current AS current
      WHERE current.project_id = $1::uuid
        AND current.generation_id = $2::uuid
        AND current.object_type_resource_id = $3::uuid
        AND current.object_type_revision_id = $4::uuid
        AND current.lifecycle_state = 'active'
        AND (${policy})${filter === null ? "" : `\n        AND (${filter})`}
      ORDER BY current.canonical_primary_key COLLATE "C" ASC
      LIMIT ${limit}::integer`,
    parameters,
    composition,
  );
}

export function compilePolicyCount(
  context: ServingContext,
  input: Readonly<{
    memberKey: string;
    policy: RowPolicy;
    filter?: ClientFilter;
  }>,
): CompiledReadStatement {
  const member = requireMember(context, input.memberKey, "object");
  const parameters = contextParameters(context, member);
  const policy = compilePolicy("current", input.policy, parameters);
  const filter =
    input.filter === undefined ? null : compileClientFilter("current", input.filter, parameters);
  const composition: CompositionStage[] = [
    { kind: "current-generation", scope: "object" },
    { kind: "row-policy", scope: "object" },
  ];
  if (filter !== null) composition.push({ kind: "client-filter", scope: "object" });
  assertSafeComposition(composition, ["object"]);
  return statement(
    "policy-count",
    `SELECT count(*)::bigint AS count
       FROM runtime.object_current AS current
      WHERE current.project_id = $1::uuid
        AND current.generation_id = $2::uuid
        AND current.object_type_resource_id = $3::uuid
        AND current.object_type_revision_id = $4::uuid
        AND current.lifecycle_state = 'active'
        AND (${policy})${filter === null ? "" : `\n        AND (${filter})`}`,
    parameters,
    composition,
  );
}

export function compileOneHopLink(
  context: ServingContext,
  input: Readonly<{
    sourceMemberKey: string;
    linkMemberKey: string;
    targetMemberKey: string;
    sourceCanonicalPrimaryKey: string;
    selectedTargetProperties: readonly PropertyCapability[];
    sourcePolicy: RowPolicy;
    linkPolicy: RowPolicy;
    targetPolicy: RowPolicy;
    limit: number;
  }>,
): CompiledReadStatement {
  const source = requireMember(context, input.sourceMemberKey, "object");
  const link = requireMember(context, input.linkMemberKey, "link");
  const target = requireMember(context, input.targetMemberKey, "object");
  requireCanonicalPrimaryKey(input.sourceCanonicalPrimaryKey);
  requireLimit(input.limit);
  const parameters = new Parameters();
  const project = parameters.add(context.projectId, "project-id");
  const linkGeneration = parameters.add(link.generationId, "link-generation-id");
  const linkResource = parameters.add(link.targetResourceId, "link-type-resource-id");
  const linkRevision = parameters.add(link.targetRevisionId, "link-type-revision-id");
  const sourceGeneration = parameters.add(source.generationId, "source-generation-id");
  const sourceResource = parameters.add(source.targetResourceId, "source-object-type-resource-id");
  const sourceRevision = parameters.add(source.targetRevisionId, "source-object-type-revision-id");
  const targetGeneration = parameters.add(target.generationId, "target-generation-id");
  const targetResource = parameters.add(target.targetResourceId, "target-object-type-resource-id");
  const targetRevision = parameters.add(target.targetRevisionId, "target-object-type-revision-id");
  const sourceKey = parameters.add(input.sourceCanonicalPrimaryKey, "canonical-primary-key");
  const sourcePolicy = compilePolicy("source_current", input.sourcePolicy, parameters);
  const linkPolicy = compilePolicy("link_current", input.linkPolicy, parameters);
  const targetPolicy = compilePolicy("target_current", input.targetPolicy, parameters);
  const limit = parameters.add(input.limit, "limit");
  const composition = Object.freeze<CompositionStage[]>([
    { kind: "current-generation", scope: "source" },
    { kind: "current-generation", scope: "link" },
    { kind: "current-generation", scope: "target" },
    { kind: "row-policy", scope: "source" },
    { kind: "row-policy", scope: "link" },
    { kind: "row-policy", scope: "target" },
    { kind: "lookup", scope: "source" },
    { kind: "order", scope: "target" },
    { kind: "pagination", scope: "target" },
  ]);
  assertSafeComposition(composition, ["source", "link", "target"]);
  return statement(
    "one-hop-link",
    `SELECT target_current.object_rid::text AS "objectRid",
            target_current.canonical_primary_key AS "canonicalPrimaryKey",
            ${propertyProjection("target_current", input.selectedTargetProperties)} AS properties
       FROM runtime.object_current AS source_current
       JOIN runtime.link_current AS link_current
         ON link_current.project_id = source_current.project_id
        AND link_current.source_object_rid = source_current.object_rid
       JOIN runtime.object_current AS target_current
         ON target_current.project_id = link_current.project_id
        AND target_current.object_rid = link_current.target_object_rid
      WHERE link_current.project_id = ${project}::uuid
        AND link_current.generation_id = ${linkGeneration}::uuid
        AND link_current.link_type_resource_id = ${linkResource}::uuid
        AND link_current.link_type_revision_id = ${linkRevision}::uuid
        AND source_current.generation_id = ${sourceGeneration}::uuid
        AND source_current.object_type_resource_id = ${sourceResource}::uuid
        AND source_current.object_type_revision_id = ${sourceRevision}::uuid
        AND source_current.lifecycle_state = 'active'
        AND target_current.generation_id = ${targetGeneration}::uuid
        AND target_current.object_type_resource_id = ${targetResource}::uuid
        AND target_current.object_type_revision_id = ${targetRevision}::uuid
        AND target_current.lifecycle_state = 'active'
        AND source_current.canonical_primary_key = ${sourceKey}
        AND (${sourcePolicy})
        AND (${linkPolicy})
        AND (${targetPolicy})
      ORDER BY target_current.canonical_primary_key COLLATE "C" ASC
      LIMIT ${limit}::integer`,
    parameters,
    composition,
  );
}

export function assertSafeComposition(
  composition: readonly CompositionStage[],
  requiredScopes: readonly PolicyScope[],
): void {
  for (const scope of requiredScopes) {
    const generationIndex = composition.findIndex(
      (stage) => stage.kind === "current-generation" && stage.scope === scope,
    );
    const policyIndex = composition.findIndex(
      (stage) => stage.kind === "row-policy" && stage.scope === scope,
    );
    const paginationIndex = composition.findIndex((stage) => stage.kind === "pagination");
    if (generationIndex < 0) throw new Error(`QUERY_CURRENT_GENERATION_REQUIRED:${scope}`);
    if (policyIndex < 0) throw new Error(`QUERY_ROW_POLICY_REQUIRED:${scope}`);
    if (policyIndex < generationIndex) throw new Error(`QUERY_POLICY_BEFORE_GENERATION:${scope}`);
    if (paginationIndex >= 0 && policyIndex > paginationIndex) {
      throw new Error(`QUERY_POLICY_AFTER_PAGINATION:${scope}`);
    }
  }
}

function contextParameters(context: ServingContext, member: ServingMember): Parameters {
  assertServingContext(context);
  const parameters = new Parameters();
  parameters.add(context.projectId, "project-id");
  parameters.add(member.generationId, "generation-id");
  parameters.add(member.targetResourceId, "object-type-resource-id");
  parameters.add(member.targetRevisionId, "object-type-revision-id");
  return parameters;
}

function requireMember(
  context: ServingContext,
  memberKey: string,
  kind: MemberKind,
): ServingMember {
  assertServingContext(context);
  if (!memberKeyPattern.test(memberKey)) throw new Error("QUERY_MEMBER_KEY_INVALID");
  const member = context.members.find((candidate) => candidate.memberKey === memberKey);
  if (member === undefined || member.kind !== kind) throw new Error("QUERY_MEMBER_NOT_SERVING");
  return member;
}

function assertServingContext(context: ServingContext): void {
  if (
    context.resolution !== "release-serving-head" ||
    !uuidPattern.test(context.projectId) ||
    !uuidPattern.test(context.releaseId) ||
    !uuidPattern.test(context.activationId) ||
    context.members.length === 0 ||
    new Set(context.members.map(({ memberKey }) => memberKey)).size !== context.members.length
  ) {
    throw new Error("QUERY_SERVING_CONTEXT_INVALID");
  }
  for (const member of context.members) {
    if (
      !memberKeyPattern.test(member.memberKey) ||
      member.memberKey.split(":", 1)[0] !== member.kind ||
      !uuidPattern.test(member.targetResourceId) ||
      !uuidPattern.test(member.targetRevisionId) ||
      !uuidPattern.test(member.generationId)
    ) {
      throw new Error("QUERY_SERVING_MEMBER_INVALID");
    }
  }
}

function compilePolicy(alias: string, policy: RowPolicy, parameters: Parameters): string {
  if (policy.kind === "allow") return "TRUE";
  assertProperty(policy.property);
  if (!policy.property.filterable || !policy.property.policyUsable) {
    throw new Error("POLICY_PROPERTY_NOT_USABLE");
  }
  const value = parameters.add(policy.value, `policy-${policy.property.valueType}`);
  return `${propertyExpression(alias, policy.property)} ${operators[policy.operator]} ${value}`;
}

function compileClientFilter(alias: string, filter: ClientFilter, parameters: Parameters): string {
  assertProperty(filter.property);
  if (!filter.property.filterable || filter.property.access !== "allow") {
    throw new Error("QUERY_PROPERTY_FILTER_FORBIDDEN");
  }
  const value = parameters.add(filter.value, `filter-${filter.property.valueType}`);
  return `${propertyExpression(alias, filter.property)} ${operators[filter.operator]} ${value}`;
}

function propertyProjection(alias: string, properties: readonly PropertyCapability[]): string {
  if (properties.length === 0 || properties.length > 64) {
    throw new Error("QUERY_PROPERTY_SELECTION_INVALID");
  }
  const names = new Set<string>();
  const entries: string[] = [];
  for (const property of properties) {
    assertProperty(property);
    if (names.has(property.apiName)) throw new Error("QUERY_PROPERTY_SELECTION_DUPLICATE");
    names.add(property.apiName);
    if (property.access !== "allow") throw new Error("QUERY_PROPERTY_SELECTION_FORBIDDEN");
    entries.push(
      `${quoteLiteral(property.apiName)}, to_jsonb(${propertyExpression(alias, property)})`,
    );
  }
  return `jsonb_build_object(${entries.join(", ")})`;
}

function propertyExpression(alias: string, property: PropertyCapability): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(alias)) throw new Error("QUERY_SQL_ALIAS_INVALID");
  return `(${alias}.properties #>> ${quoteLiteral(`{values,${property.apiName},value}`)}::text[]) COLLATE "C"`;
}

function assertProperty(property: PropertyCapability): void {
  if (!apiNamePattern.test(property.apiName) || property.valueType !== "string") {
    throw new Error("QUERY_PROPERTY_CAPABILITY_INVALID");
  }
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function requireCanonicalPrimaryKey(value: string): void {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > 1024) {
    throw new Error("QUERY_PRIMARY_KEY_INVALID");
  }
}

function requireLimit(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("QUERY_LIMIT_INVALID");
  }
}

function statement(
  name: CompiledReadStatement["name"],
  text: string,
  parameters: Parameters,
  composition: readonly CompositionStage[],
): CompiledReadStatement {
  return Object.freeze({
    name,
    text,
    values: Object.freeze([...parameters.values]),
    parameterTypes: Object.freeze([...parameters.types]),
    composition: Object.freeze([...composition]),
  });
}
