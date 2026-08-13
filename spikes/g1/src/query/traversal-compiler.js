import { invariant } from "../core/kernel-error.js";
import { getObjectType, getProperty } from "../core/schema-registry.js";
import {
  compilePredicate,
  propertyExpression,
  SqlParameters,
} from "./compiler.js";

const MAX_HOPS = 2;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function compileTraversal({
  registry,
  startObjectType,
  startPrimaryKey,
  path,
  select,
  policyByObjectType,
  linkPolicyByLinkType,
  pageSize = DEFAULT_PAGE_SIZE,
}) {
  invariant(Array.isArray(path) && path.length >= 1 && path.length <= MAX_HOPS, "INVALID_TRAVERSAL", "Traversal path must contain one or two hops");
  invariant(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= MAX_PAGE_SIZE, "INVALID_TRAVERSAL", `pageSize must be 1-${MAX_PAGE_SIZE}`);
  const parameters = new SqlParameters();
  const joins = [];
  const where = [];
  const predicateState = { count: 0 };
  let currentTypeName = startObjectType;
  let currentAlias = "o0";

  const startType = getObjectType(registry, startObjectType);
  const startPolicy = resolvePolicy(policyByObjectType, startObjectType);
  invariant(startPolicy.allowObjectType, "RESOURCE_FORBIDDEN", `Object type ${startObjectType} is not visible`);
  const startTypeParameter = parameters.add(startObjectType, "text");
  const startKeyParameter = parameters.add(startPrimaryKey, "text");
  joins.push(
    "FROM kernel.object_current o0",
    "JOIN kernel.object_type_runtime r0",
    "  ON r0.object_type_id = o0.object_type_id",
    " AND r0.active_generation_id = o0.generation_id",
  );
  where.push(
    `o0.object_type_id = ${startTypeParameter}`,
    `o0.primary_key = ${startKeyParameter}`,
    "o0.lifecycle_state = 'active'",
  );
  if (startPolicy.rowPredicate) {
    where.push(compilePredicate(startPolicy.rowPredicate, {
      objectType: startType,
      policy: allowPolicyProperties(startPolicy),
      parameters,
      predicateState,
      purpose: "policy",
      alias: "o0",
    }));
  }

  for (const [index, step] of path.entries()) {
    invariant(step && typeof step.linkType === "string", "INVALID_TRAVERSAL", `Hop ${index + 1} requires linkType`);
    invariant(step.direction === "out" || step.direction === "in", "INVALID_TRAVERSAL", `Hop ${index + 1} direction must be out or in`);
    const linkType = registry.linkTypes[step.linkType];
    invariant(linkType, "LINK_TYPE_NOT_FOUND", `Unknown link type: ${step.linkType}`);
    const linkPolicy = resolveLinkPolicy(linkPolicyByLinkType, step.linkType);
    invariant(linkPolicy.allowLinkType, "RESOURCE_FORBIDDEN", `Link type ${step.linkType} is not visible`);

    const outward = step.direction === "out";
    const expectedCurrentType = outward ? linkType.sourceType : linkType.targetType;
    invariant(expectedCurrentType === currentTypeName, "INVALID_TRAVERSAL", `Link ${step.linkType} cannot be traversed ${step.direction} from ${currentTypeName}`);
    const nextTypeName = outward ? linkType.targetType : linkType.sourceType;
    const nextType = getObjectType(registry, nextTypeName);
    const nextPolicy = resolvePolicy(policyByObjectType, nextTypeName);
    invariant(nextPolicy.allowObjectType, "RESOURCE_FORBIDDEN", `Object type ${nextTypeName} is not visible`);

    const linkAlias = `l${index + 1}`;
    const linkRuntimeAlias = `lr${index + 1}`;
    const nextAlias = `o${index + 1}`;
    const nextRuntimeAlias = `r${index + 1}`;
    const linkParameter = parameters.add(step.linkType, "text");
    const nextTypeParameter = parameters.add(nextTypeName, "text");
    const currentRidColumn = outward ? "source_object_rid" : "target_object_rid";
    const nextRidColumn = outward ? "target_object_rid" : "source_object_rid";
    const currentTypeColumn = outward ? "source_object_type_id" : "target_object_type_id";
    const nextTypeColumn = outward ? "target_object_type_id" : "source_object_type_id";

    joins.push(
      `JOIN kernel.link_type_runtime ${linkRuntimeAlias}`,
      `  ON ${linkRuntimeAlias}.link_type_id = ${linkParameter}`,
      `JOIN kernel.link_current ${linkAlias}`,
      `  ON ${linkAlias}.link_type_id = ${linkRuntimeAlias}.link_type_id`,
      ` AND ${linkAlias}.generation_id = ${linkRuntimeAlias}.active_generation_id`,
      ` AND ${linkAlias}.lifecycle_state = 'active'`,
      ` AND ${linkAlias}.${currentTypeColumn} = ${currentAlias}.object_type_id`,
      ` AND ${linkAlias}.${nextTypeColumn} = ${nextTypeParameter}`,
      ` AND ${linkAlias}.${currentRidColumn} = ${currentAlias}.object_rid`,
      `JOIN kernel.object_current ${nextAlias}`,
      `  ON ${nextAlias}.object_type_id = ${nextTypeParameter}`,
      ` AND ${nextAlias}.object_rid = ${linkAlias}.${nextRidColumn}`,
      `JOIN kernel.object_type_runtime ${nextRuntimeAlias}`,
      `  ON ${nextRuntimeAlias}.object_type_id = ${nextAlias}.object_type_id`,
      ` AND ${nextRuntimeAlias}.active_generation_id = ${nextAlias}.generation_id`,
    );
    where.push(`${nextAlias}.lifecycle_state = 'active'`);
    if (nextPolicy.rowPredicate) {
      where.push(compilePredicate(nextPolicy.rowPredicate, {
        objectType: nextType,
        policy: allowPolicyProperties(nextPolicy),
        parameters,
        predicateState,
        purpose: "policy",
        alias: nextAlias,
      }));
    }

    currentTypeName = nextTypeName;
    currentAlias = nextAlias;
  }

  const finalType = getObjectType(registry, currentTypeName);
  const finalPolicy = resolvePolicy(policyByObjectType, currentTypeName);
  const requested = select ?? [finalType.primaryKey];
  invariant(Array.isArray(requested) && requested.length >= 1 && requested.length <= 50, "INVALID_TRAVERSAL", "select must contain 1-50 properties");
  const projection = requested.map((propertyName) => {
    const property = getProperty(finalType, propertyName);
    invariant(propertyDecision(finalPolicy, propertyName) === "allow", "PROPERTY_DENIED", `Property ${propertyName} is not readable`);
    return `${propertyExpression(property, currentAlias)} AS "${propertyName}"`;
  });
  const limitParameter = parameters.add(pageSize + 1, "integer");
  const sql = [
    `SELECT DISTINCT ${projection.join(", ")}`,
    ...joins,
    `WHERE ${where.join("\n  AND ")}`,
    `ORDER BY ${currentAlias}.primary_key ASC`,
    `LIMIT ${limitParameter}`,
  ].join("\n");

  return {
    text: sql,
    values: parameters.values,
    parameterTypes: parameters.types,
    pageSize,
    finalObjectType: currentTypeName,
    selectedProperties: requested,
    policyContextHashes: pathPolicyHashes(startObjectType, path, registry, policyByObjectType),
    linkPolicyContextHashes: path.map((step) => resolveLinkPolicy(linkPolicyByLinkType, step.linkType).contextHash),
  };
}

function resolvePolicy(policyByObjectType, objectTypeName) {
  const policy = typeof policyByObjectType === "function"
    ? policyByObjectType(objectTypeName)
    : policyByObjectType[objectTypeName] ?? policyByObjectType["*"];
  invariant(policy && typeof policy.contextHash === "string", "POLICY_REQUIRED", `Policy is required for ${objectTypeName}`);
  return policy;
}

function propertyDecision(policy, propertyName) {
  return policy.propertyDecisions?.[propertyName] ?? policy.defaultPropertyDecision ?? "deny";
}

function resolveLinkPolicy(policyByLinkType, linkTypeName) {
  invariant(policyByLinkType !== undefined && policyByLinkType !== null, "POLICY_REQUIRED", `Link policy is required for ${linkTypeName}`);
  const policy = typeof policyByLinkType === "function"
    ? policyByLinkType(linkTypeName)
    : policyByLinkType[linkTypeName] ?? policyByLinkType["*"];
  invariant(policy && typeof policy.contextHash === "string", "POLICY_REQUIRED", `Link policy is required for ${linkTypeName}`);
  return policy;
}

function allowPolicyProperties(policy) {
  return { ...policy, defaultPropertyDecision: "allow", propertyDecisions: {} };
}

function pathPolicyHashes(startObjectType, path, registry, policyByObjectType) {
  const types = [startObjectType];
  let current = startObjectType;
  for (const step of path) {
    const link = registry.linkTypes[step.linkType];
    current = step.direction === "out" ? link.targetType : link.sourceType;
    types.push(current);
  }
  return types.map((objectType) => resolvePolicy(policyByObjectType, objectType).contextHash);
}
