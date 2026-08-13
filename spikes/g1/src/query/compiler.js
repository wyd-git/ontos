import { invariant } from "../core/kernel-error.js";
import { getObjectType, getProperty } from "../core/schema-registry.js";
import { stableHash } from "../core/stable-json.js";
import { decodeCursor } from "./cursor.js";

const COMPARISON_OPERATORS = new Set(["eq", "ne", "lt", "lte", "gt", "gte"]);
const STRING_OPERATORS = new Set(["contains", "prefix"]);
const MAX_PREDICATE_DEPTH = 5;
const MAX_PREDICATES = 50;
const MAX_IN_VALUES = 500;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

export function compileSearch({
  registry,
  objectType: objectTypeName,
  query = {},
  policy,
  cursorSecret = "spike-cursor-secret-20260813",
}) {
  assertPolicy(policy);
  const objectType = getObjectType(registry, objectTypeName);
  invariant(policy.allowObjectType, "RESOURCE_FORBIDDEN", `Object type ${objectTypeName} is not visible`);

  const parameters = new SqlParameters();
  const objectTypeParameter = parameters.add(objectTypeName, "text");
  const selection = compileSelection(objectType, query.select, policy);
  const predicateState = { count: 0 };
  const clientPredicate = query.where
    ? compilePredicate(query.where, { objectType, policy, parameters, predicateState, purpose: "client" })
    : null;
  const policyPredicate = policy.rowPredicate
    ? compilePredicate(policy.rowPredicate, { objectType, policy: allowAllPropertyPolicy(policy), parameters, predicateState, purpose: "policy" })
    : null;
  const search = compileSearchText(query.searchText, { objectType, policy, parameters });
  const order = compileOrder(query.orderBy, { objectType, policy, search });
  const pageSize = validatePageSize(query.page?.size);
  const queryHash = stableHash({
    objectType: objectTypeName,
    select: selection.requested,
    searchText: query.searchText ?? null,
    where: query.where ?? null,
    orderBy: order.publicDefinition,
    pageSize,
  });

  const cursorPredicate = query.page?.cursor
    ? compileCursorPredicate({
      cursor: query.page.cursor,
      cursorSecret,
      registry,
      objectTypeName,
      policy,
      queryHash,
      order,
      parameters,
    })
    : null;

  const whereParts = [
    `oc.object_type_id = ${objectTypeParameter}`,
    "oc.generation_id = runtime.active_generation_id",
    "oc.lifecycle_state = 'active'",
    clientPredicate,
    policyPredicate,
    search?.predicate,
    cursorPredicate,
  ].filter(Boolean);

  const limitParameter = parameters.add(pageSize + 1, "integer");
  const sql = [
    `SELECT ${selection.sql.join(", ")}`,
    "FROM kernel.object_current oc",
    "JOIN kernel.object_type_runtime runtime",
    "  ON runtime.object_type_id = oc.object_type_id",
    `WHERE ${whereParts.join("\n  AND ")}`,
    `ORDER BY ${order.sql}`,
    `LIMIT ${limitParameter}`,
  ].join("\n");

  return {
    text: sql,
    values: parameters.values,
    parameterTypes: parameters.types,
    pageSize,
    queryHash,
    policyContextHash: policy.contextHash,
    selectedProperties: selection.requested,
    redactedProperties: selection.redactedProperties,
    order: order.publicDefinition,
  };
}

export function compileAggregate({ registry, objectType: objectTypeName, query = {}, policy }) {
  assertPolicy(policy);
  const objectType = getObjectType(registry, objectTypeName);
  invariant(policy.allowObjectType, "RESOURCE_FORBIDDEN", `Object type ${objectTypeName} is not visible`);

  const parameters = new SqlParameters();
  const objectTypeParameter = parameters.add(objectTypeName, "text");
  const predicateState = { count: 0 };
  const clientPredicate = query.where
    ? compilePredicate(query.where, { objectType, policy, parameters, predicateState, purpose: "client" })
    : null;
  const policyPredicate = policy.rowPredicate
    ? compilePredicate(policy.rowPredicate, { objectType, policy: allowAllPropertyPolicy(policy), parameters, predicateState, purpose: "policy" })
    : null;

  const group = query.groupBy
    ? compileGroupBy(query.groupBy, { objectType, policy })
    : null;
  invariant(Array.isArray(query.measures) && query.measures.length > 0 && query.measures.length <= 10, "INVALID_AGGREGATE", "One to ten measures are required");
  const measures = query.measures.map((measure, index) => compileMeasure(measure, index, { objectType, policy }));
  const select = [group?.select, ...measures].filter(Boolean).join(", ");
  const whereParts = [
    `oc.object_type_id = ${objectTypeParameter}`,
    "oc.generation_id = runtime.active_generation_id",
    "oc.lifecycle_state = 'active'",
    clientPredicate,
    policyPredicate,
  ].filter(Boolean);

  const sql = [
    `SELECT ${select}`,
    "FROM kernel.object_current oc",
    "JOIN kernel.object_type_runtime runtime",
    "  ON runtime.object_type_id = oc.object_type_id",
    `WHERE ${whereParts.join("\n  AND ")}`,
    group ? `GROUP BY ${group.expression}` : null,
    group ? `ORDER BY ${group.expression}` : null,
    group ? "LIMIT 1000" : null,
  ].filter(Boolean).join("\n");

  return {
    text: sql,
    values: parameters.values,
    parameterTypes: parameters.types,
    policyContextHash: policy.contextHash,
  };
}

function compileSelection(objectType, requestedSelection, policy) {
  const requested = requestedSelection ?? Object.keys(objectType.properties).filter((propertyName) => {
    return propertyDecision(policy, propertyName) !== "deny";
  });
  invariant(Array.isArray(requested) && requested.length > 0, "INVALID_QUERY_AST", "select must contain at least one property");
  invariant(requested.length <= 50, "QUERY_TOO_COMPLEX", "select contains too many properties");

  const seen = new Set();
  const redactedProperties = [];
  const sql = requested.map((propertyName) => {
    invariant(typeof propertyName === "string" && !seen.has(propertyName), "INVALID_QUERY_AST", `Duplicate or invalid selected property: ${String(propertyName)}`);
    seen.add(propertyName);
    const property = getProperty(objectType, propertyName);
    const decision = propertyDecision(policy, propertyName);
    invariant(decision !== "deny", "PROPERTY_DENIED", `Property ${propertyName} is not readable`);

    if (decision === "mask") {
      redactedProperties.push(propertyName);
      return `NULL::${sqlType(property.type)} AS ${quoteIdentifier(propertyName)}`;
    }

    return `${propertyExpression(property)} AS ${quoteIdentifier(propertyName)}`;
  });

  return { requested, sql, redactedProperties };
}

export function compilePredicate(node, context, depth = 1) {
  invariant(node && typeof node === "object" && !Array.isArray(node), "INVALID_QUERY_AST", "Predicate must be an object");
  invariant(depth <= MAX_PREDICATE_DEPTH, "QUERY_TOO_COMPLEX", `Predicate depth exceeds ${MAX_PREDICATE_DEPTH}`);

  const logicalKeys = ["and", "or", "not"].filter((key) => node[key] !== undefined);
  if (logicalKeys.length > 0) {
    invariant(logicalKeys.length === 1, "INVALID_QUERY_AST", "Predicate must contain exactly one logical operator");
    invariant(Object.keys(node).length === 1, "INVALID_QUERY_AST", "Logical predicate cannot contain leaf fields");
  }

  if (Array.isArray(node.and) || Array.isArray(node.or)) {
    const operator = Array.isArray(node.and) ? "AND" : "OR";
    const children = node.and ?? node.or;
    invariant(children.length >= 1 && children.length <= MAX_PREDICATES, "QUERY_TOO_COMPLEX", `${operator} must contain 1-${MAX_PREDICATES} predicates`);
    return `(${children.map((child) => compilePredicate(child, context, depth + 1)).join(` ${operator} `)})`;
  }

  if (node.not !== undefined) {
    return `(NOT ${compilePredicate(node.not, context, depth + 1)})`;
  }

  context.predicateState.count += 1;
  invariant(context.predicateState.count <= MAX_PREDICATES, "QUERY_TOO_COMPLEX", `Predicate count exceeds ${MAX_PREDICATES}`);
  invariant(Object.keys(node).every((key) => ["property", "op", "value"].includes(key)), "INVALID_QUERY_AST", "Leaf predicate contains unknown fields");
  invariant(typeof node.property === "string" && typeof node.op === "string", "INVALID_QUERY_AST", "Leaf predicate requires property and op");

  const property = getProperty(context.objectType, node.property);
  invariant(property.filterable, "PROPERTY_NOT_QUERYABLE", `Property ${node.property} is not filterable`);
  if (context.purpose === "client") {
    invariant(propertyDecision(context.policy, node.property) === "allow", "PROPERTY_NOT_QUERYABLE", `Property ${node.property} cannot be used in a client predicate`);
  }

  const expression = propertyExpression(property, context.alias);
  if (node.op === "isNull") {
    invariant(node.value === undefined, "INVALID_QUERY_AST", "isNull does not accept value");
    return `(${expression} IS NULL)`;
  }

  if (node.op === "in") {
    invariant(property.type !== "string[]", "INVALID_QUERY_AST", "Use containsAny for string[] properties");
    invariant(Array.isArray(node.value) && node.value.length > 0 && node.value.length <= MAX_IN_VALUES, "INVALID_QUERY_AST", `in requires 1-${MAX_IN_VALUES} values`);
    const values = node.value.map((value) => normalizeValue(property, value));
    const parameter = context.parameters.add(values, `${parameterType(property.type)}[]`);
    return `(${expression} = ANY(${parameter}))`;
  }

  if (node.op === "containsAny") {
    invariant(property.type === "string[]", "INVALID_QUERY_AST", "containsAny requires string[] property");
    invariant(Array.isArray(node.value) && node.value.length > 0 && node.value.length <= MAX_IN_VALUES, "INVALID_QUERY_AST", `containsAny requires 1-${MAX_IN_VALUES} values`);
    const values = node.value.map((value) => normalizeString(value));
    const parameter = context.parameters.add(values, "text[]");
    return `(${expression} ?| ${parameter})`;
  }

  if (STRING_OPERATORS.has(node.op)) {
    invariant(property.type === "string" || property.type === "enum", "INVALID_QUERY_AST", `${node.op} requires string or enum property`);
    const value = escapeLike(normalizeString(node.value));
    const pattern = node.op === "contains" ? `%${value}%` : `${value}%`;
    const parameter = context.parameters.add(pattern, "text");
    return `(lower(${expression}) LIKE lower(${parameter}) ESCAPE '\\')`;
  }

  invariant(COMPARISON_OPERATORS.has(node.op), "INVALID_QUERY_AST", `Unsupported operator: ${node.op}`);
  invariant(node.value !== null && node.value !== undefined, "INVALID_QUERY_AST", `${node.op} requires a non-null value; use isNull`);
  const value = normalizeValue(property, node.value);
  const parameter = context.parameters.add(value, parameterType(property.type));
  const sqlOperator = {
    eq: "=",
    ne: "<>",
    lt: "<",
    lte: "<=",
    gt: ">",
    gte: ">=",
  }[node.op];
  return `(${expression} ${sqlOperator} ${parameter})`;
}

function compileSearchText(searchText, context) {
  if (searchText === undefined || searchText === null || searchText === "") {
    return null;
  }

  invariant(typeof searchText === "string" && [...searchText].length <= 256, "INVALID_QUERY_AST", "searchText must contain at most 256 characters");
  const searchable = Object.entries(context.objectType.properties).filter(([propertyName, property]) => {
    return property.searchable && propertyDecision(context.policy, propertyName) === "allow";
  });
  invariant(searchable.length > 0, "PROPERTY_NOT_QUERYABLE", "No searchable property is visible");
  const parameter = context.parameters.add(searchText, "text");
  const expressions = searchable.map(([, property]) => propertyExpression(property));
  const predicate = `(${expressions.map((expression) => `lower(${expression}) % lower(${parameter})`).join(" OR ")})`;
  const rank = expressions.length === 1
    ? `similarity(lower(${expressions[0]}), lower(${parameter}))`
    : `GREATEST(${expressions.map((expression) => `similarity(lower(${expression}), lower(${parameter}))`).join(", ")})`;
  return { predicate, rank };
}

function compileOrder(orderBy, context) {
  invariant(orderBy === undefined || (Array.isArray(orderBy) && orderBy.length <= 1), "INVALID_QUERY_AST", "V1 supports at most one orderBy item");

  if ((!orderBy || orderBy.length === 0) && context.search) {
    return {
      expression: context.search.rank,
      direction: "desc",
      nullable: false,
      propertyName: "__relevance__",
      isPrimaryKey: false,
      tieDirection: "asc",
      sql: `${context.search.rank} DESC, oc.primary_key ASC`,
      publicDefinition: [{ property: "__relevance__", direction: "desc" }],
    };
  }

  const item = orderBy?.[0] ?? { property: context.objectType.primaryKey, direction: "asc" };
  invariant(item && typeof item.property === "string", "INVALID_QUERY_AST", "orderBy property is required");
  invariant(item.direction === "asc" || item.direction === "desc", "INVALID_QUERY_AST", "orderBy direction must be asc or desc");
  const property = getProperty(context.objectType, item.property);
  invariant(property.sortable, "PROPERTY_NOT_QUERYABLE", `Property ${item.property} is not sortable`);
  invariant(propertyDecision(context.policy, item.property) === "allow", "PROPERTY_NOT_QUERYABLE", `Property ${item.property} cannot be used for sorting`);
  const expression = propertyExpression(property);
  const direction = item.direction.toUpperCase();
  const tieDirection = item.property === context.objectType.primaryKey ? "" : `, oc.primary_key ${direction}`;
  return {
    expression,
    direction: item.direction,
    nullable: property.nullable,
    propertyName: item.property,
    isPrimaryKey: item.property === context.objectType.primaryKey,
    tieDirection: item.direction,
    property,
    sql: `${expression} ${direction} NULLS LAST${tieDirection}`,
    publicDefinition: [{ property: item.property, direction: item.direction }],
  };
}

function compileCursorPredicate({
  cursor,
  cursorSecret,
  registry,
  objectTypeName,
  policy,
  queryHash,
  order,
  parameters,
}) {
  const payload = decodeCursor(cursor, cursorSecret);
  const expected = {
    releaseRevision: registry.releaseRevision,
    objectType: objectTypeName,
    queryHash,
    policyContextHash: policy.contextHash,
    order: order.publicDefinition,
  };

  for (const [key, value] of Object.entries(expected)) {
    invariant(stableHash(payload[key]) === stableHash(value), "CURSOR_CONTEXT_CHANGED", `Cursor ${key} no longer matches the request`);
  }

  invariant(typeof payload.primaryKey === "string", "INVALID_CURSOR", "Cursor primary key is missing");
  const primaryKeyParameter = parameters.add(payload.primaryKey, "text");

  if (order.isPrimaryKey) {
    const comparison = order.direction === "asc" ? ">" : "<";
    return `(oc.primary_key ${comparison} ${primaryKeyParameter})`;
  }

  invariant(Object.hasOwn(payload, "sortValue"), "INVALID_CURSOR", "Cursor sort value is missing");
  if (payload.sortValue === null) {
    const primaryComparison = order.tieDirection === "asc" ? ">" : "<";
    return `(${order.expression} IS NULL AND oc.primary_key ${primaryComparison} ${primaryKeyParameter})`;
  }

  const type = order.property ? parameterType(order.property.type) : "numeric";
  const sortValue = order.property ? normalizeValue(order.property, payload.sortValue) : normalizeNumber(payload.sortValue);
  const sortParameter = parameters.add(sortValue, type);
  const comparison = order.direction === "asc" ? ">" : "<";
  const primaryComparison = order.tieDirection === "asc" ? ">" : "<";
  return `(
    ${order.expression} ${comparison} ${sortParameter}
    OR (${order.expression} = ${sortParameter} AND oc.primary_key ${primaryComparison} ${primaryKeyParameter})
    OR ${order.expression} IS NULL
  )`;
}

function compileGroupBy(propertyName, context) {
  invariant(typeof propertyName === "string", "INVALID_AGGREGATE", "groupBy must be a property name");
  const property = getProperty(context.objectType, propertyName);
  invariant(property.filterable, "PROPERTY_NOT_QUERYABLE", `Property ${propertyName} cannot be grouped`);
  invariant(propertyDecision(context.policy, propertyName) === "allow", "PROPERTY_NOT_QUERYABLE", `Property ${propertyName} cannot be grouped`);
  invariant(["enum", "boolean", "string", "date", "timestamp"].includes(property.type), "INVALID_AGGREGATE", `Property ${propertyName} has unsupported group type`);
  const expression = propertyExpression(property);
  return {
    expression,
    select: `${expression} AS ${quoteIdentifier(propertyName)}`,
  };
}

function compileMeasure(measure, index, context) {
  invariant(measure && typeof measure.op === "string", "INVALID_AGGREGATE", "Measure op is required");
  const alias = quoteIdentifier(measure.as ?? `measure${index + 1}`);
  if (measure.op === "count") {
    invariant(measure.property === undefined, "INVALID_AGGREGATE", "count does not accept property in V1");
    return `count(*)::bigint AS ${alias}`;
  }

  invariant(["sum", "avg", "min", "max"].includes(measure.op), "INVALID_AGGREGATE", `Unsupported aggregate: ${measure.op}`);
  const property = getProperty(context.objectType, measure.property);
  invariant(propertyDecision(context.policy, measure.property) === "allow", "PROPERTY_NOT_QUERYABLE", `Property ${measure.property} cannot be aggregated`);
  if (["sum", "avg"].includes(measure.op)) {
    invariant(["integer", "decimal"].includes(property.type), "INVALID_AGGREGATE", `${measure.op} requires numeric property`);
  }
  invariant(["integer", "decimal", "date", "timestamp"].includes(property.type), "INVALID_AGGREGATE", `${measure.op} does not support ${property.type}`);
  return `${measure.op}(${propertyExpression(property)}) AS ${alias}`;
}

export function propertyExpression(property, alias = "oc") {
  if (property.storage === "column") {
    return `${alias}.${property.column}`;
  }

  const json = `${alias}.properties ->> '${property.jsonKey}'`;
  if (property.type === "string[]" || property.type === "json") {
    return `${alias}.properties -> '${property.jsonKey}'`;
  }

  const type = sqlType(property.type);
  return type === "text" ? `(${json})` : `((${json})::${type})`;
}

function propertyDecision(policy, propertyName) {
  return policy.propertyDecisions?.[propertyName] ?? policy.defaultPropertyDecision ?? "deny";
}

function allowAllPropertyPolicy(policy) {
  return {
    ...policy,
    defaultPropertyDecision: "allow",
    propertyDecisions: {},
  };
}

function assertPolicy(policy) {
  invariant(policy && typeof policy === "object" && typeof policy.contextHash === "string", "POLICY_REQUIRED", "A versioned policy context is required");
}

function validatePageSize(value) {
  const size = value ?? DEFAULT_PAGE_SIZE;
  invariant(Number.isInteger(size) && size >= 1 && size <= MAX_PAGE_SIZE, "INVALID_QUERY_AST", `page.size must be 1-${MAX_PAGE_SIZE}`);
  return size;
}

function normalizeValue(property, value) {
  switch (property.type) {
    case "string":
      return normalizeString(value);
    case "enum":
      invariant(typeof value === "string" && property.values.includes(value), "INVALID_QUERY_VALUE", `Invalid enum value: ${String(value)}`);
      return value;
    case "boolean":
      invariant(typeof value === "boolean", "INVALID_QUERY_VALUE", "Expected boolean value");
      return value;
    case "integer":
      invariant((typeof value === "number" && Number.isSafeInteger(value)) || /^-?\d+$/.test(String(value)), "INVALID_QUERY_VALUE", "Expected 64-bit integer value");
      return String(value);
    case "decimal":
      invariant(/^-?\d+(\.\d+)?$/.test(String(value)), "INVALID_QUERY_VALUE", "Expected decimal value");
      return String(value);
    case "timestamp": {
      invariant(typeof value === "string" && !Number.isNaN(Date.parse(value)), "INVALID_QUERY_VALUE", "Expected RFC 3339 timestamp");
      return new Date(value).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
    }
    case "date":
      invariant(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), "INVALID_QUERY_VALUE", "Expected ISO date");
      return value;
    case "string[]":
      invariant(Array.isArray(value), "INVALID_QUERY_VALUE", "Expected string array");
      return value.map(normalizeString);
    default:
      throw new Error(`Unhandled property type: ${property.type}`);
  }
}

function normalizeString(value) {
  invariant(typeof value === "string" && Buffer.byteLength(value, "utf8") <= 65536, "INVALID_QUERY_VALUE", "Expected string value up to 64 KiB");
  return value;
}

function normalizeNumber(value) {
  invariant(typeof value === "number" && Number.isFinite(value), "INVALID_CURSOR", "Cursor relevance must be numeric");
  return value;
}

function escapeLike(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function parameterType(propertyType) {
  return {
    string: "text",
    enum: "text",
    boolean: "boolean",
    integer: "bigint",
    decimal: "numeric",
    date: "date",
    timestamp: "text",
    "string[]": "text[]",
    json: "jsonb",
  }[propertyType];
}

export function sqlType(propertyType) {
  if (propertyType === "string[]" || propertyType === "json") {
    return "jsonb";
  }
  return parameterType(propertyType);
}

function quoteIdentifier(identifier) {
  invariant(typeof identifier === "string" && /^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(identifier), "INVALID_API_NAME", `Invalid SQL alias: ${String(identifier)}`);
  return `"${identifier}"`;
}

export class SqlParameters {
  values = [];
  types = [];

  add(value, type) {
    this.values.push(value);
    this.types.push(type);
    return `$${this.values.length}::${type}`;
  }
}
