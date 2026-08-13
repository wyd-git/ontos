import { invariant } from "../core/kernel-error.js";
import { stableHash } from "../core/stable-json.js";

const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const PACKAGE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const NAMESPACE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PROPERTY_TYPES = new Set(["string", "boolean", "integer", "decimal", "date", "timestamp", "enum", "string[]", "json"]);
const CARDINALITIES = new Set(["one_to_one", "one_to_many", "many_to_one", "many_to_many"]);
const TOP_LEVEL_KEYS = new Set(["packageApiName", "version", "namespace", "kernelContractVersion", "resources", "migrations"]);
const RESOURCE_KEYS = new Set(["objectTypes", "linkTypes", "actions", "policies", "views"]);
const FORBIDDEN_KEYS = new Set(["kernelMigrations", "databaseMigrations", "queryOperators", "endpoints", "rawSql"]);
const MIGRATION_KEYS = new Set(["fromVersion", "toVersion", "kind", "description"]);

export function validateManifest(manifest) {
  invariant(manifest && typeof manifest === "object" && !Array.isArray(manifest), "INVALID_PACKAGE", "Package manifest must be an object");
  rejectUnknownKeys(manifest, TOP_LEVEL_KEYS, "package");
  rejectForbiddenKeys(manifest);
  invariant(PACKAGE_NAME.test(manifest.packageApiName), "INVALID_PACKAGE", "Invalid packageApiName");
  invariant(SEMVER.test(manifest.version), "INVALID_PACKAGE", "Package version must be semantic version x.y.z");
  invariant(NAMESPACE.test(manifest.namespace), "INVALID_PACKAGE", "Invalid package namespace");
  invariant(manifest.kernelContractVersion === "1", "INCOMPATIBLE_KERNEL_CONTRACT", "Only Kernel Contract v1 is supported by this spike");
  invariant(manifest.resources && typeof manifest.resources === "object", "INVALID_PACKAGE", "resources are required");
  rejectUnknownKeys(manifest.resources, RESOURCE_KEYS, "resources");

  const objectTypes = requireArray(manifest.resources.objectTypes, "objectTypes", 5);
  const linkTypes = requireArray(manifest.resources.linkTypes, "linkTypes", 5);
  const actions = requireArray(manifest.resources.actions, "actions", 3);
  const policies = requireArray(manifest.resources.policies, "policies", 2);
  const views = requireArray(manifest.resources.views, "views", 2);
  const names = new Set();
  const objectTypeByName = new Map();

  for (const objectType of objectTypes) {
    assertResourceName(objectType.apiName, names);
    invariant(objectType.properties && typeof objectType.properties === "object", "INVALID_PACKAGE", `Properties required for ${objectType.apiName}`);
    invariant(objectType.properties[objectType.primaryKey], "INVALID_PACKAGE", `Primary key missing for ${objectType.apiName}`);
    invariant(objectType.properties[objectType.primaryKey].nullable === false, "INVALID_PACKAGE", `Primary key must be non-null for ${objectType.apiName}`);
    for (const [propertyName, property] of Object.entries(objectType.properties)) {
      invariant(API_NAME.test(propertyName), "INVALID_PACKAGE", `Invalid property name ${objectType.apiName}.${propertyName}`);
      invariant(PROPERTY_TYPES.has(property.type), "INVALID_PACKAGE", `Unsupported property type ${objectType.apiName}.${propertyName}`);
      invariant(typeof property.nullable === "boolean", "INVALID_PACKAGE", `nullable is required for ${objectType.apiName}.${propertyName}`);
      if (property.type === "enum") {
        invariant(Array.isArray(property.values) && property.values.length > 0, "INVALID_PACKAGE", `Enum values required for ${objectType.apiName}.${propertyName}`);
      }
    }
    objectTypeByName.set(objectType.apiName, objectType);
  }

  for (const link of linkTypes) {
    assertResourceName(link.apiName, names);
    invariant(objectTypeByName.has(link.sourceType) && objectTypeByName.has(link.targetType), "INVALID_PACKAGE", `Unknown link endpoint for ${link.apiName}`);
    invariant(CARDINALITIES.has(link.cardinality), "INVALID_PACKAGE", `Invalid cardinality for ${link.apiName}`);
  }

  const actionNames = new Set();
  for (const action of actions) {
    assertResourceName(action.apiName, names);
    invariant(objectTypeByName.has(action.targetType), "INVALID_PACKAGE", `Unknown action target for ${action.apiName}`);
    invariant(DIGEST.test(action.handlerDigest), "INVALID_PACKAGE", `Immutable handler digest required for ${action.apiName}`);
    invariant(["none", "required", "elevated"].includes(action.risk), "INVALID_PACKAGE", `Invalid risk for ${action.apiName}`);
    actionNames.add(action.apiName);
  }

  for (const policy of policies) {
    assertResourceName(policy.apiName, names);
    const objectType = objectTypeByName.get(policy.objectType);
    invariant(objectType, "INVALID_PACKAGE", `Unknown policy object type for ${policy.apiName}`);
    validatePredicateShape(policy.predicate, objectType);
  }

  for (const view of views) {
    assertResourceName(view.apiName, names);
    const objectType = objectTypeByName.get(view.objectType);
    invariant(objectType, "INVALID_PACKAGE", `Unknown view object type for ${view.apiName}`);
    invariant(Array.isArray(view.fields) && view.fields.length > 0, "INVALID_PACKAGE", `View fields required for ${view.apiName}`);
    for (const field of view.fields) {
      invariant(objectType.properties[field], "INVALID_PACKAGE", `Unknown view field ${view.apiName}.${field}`);
    }
    for (const actionName of view.actions ?? []) {
      invariant(actionNames.has(actionName), "INVALID_PACKAGE", `Unknown view action ${view.apiName}.${actionName}`);
    }
  }

  invariant(Array.isArray(manifest.migrations), "INVALID_PACKAGE", "migrations must be an array");
  for (const migration of manifest.migrations) {
    invariant(migration && typeof migration === "object" && !Array.isArray(migration), "INVALID_PACKAGE", "Migration metadata must be an object");
    rejectUnknownKeys(migration, MIGRATION_KEYS, "migration");
    invariant(SEMVER.test(migration.fromVersion) && SEMVER.test(migration.toVersion), "INVALID_PACKAGE", "Migration versions must be semantic versions");
    invariant(migration.kind === "declarative_definition", "PACKAGE_CAPABILITY_FORBIDDEN", "Only declarative definition migrations are allowed");
    invariant(typeof migration.description === "string" && migration.description.length >= 1 && migration.description.length <= 500, "INVALID_PACKAGE", "Migration description must contain 1-500 characters");
  }
  return {
    packageApiName: manifest.packageApiName,
    version: manifest.version,
    counts: {
      objectTypes: objectTypes.length,
      linkTypes: linkTypes.length,
      actions: actions.length,
      policies: policies.length,
      views: views.length,
    },
  };
}

export function compareManifests(previous, next) {
  validateManifest(previous);
  validateManifest(next);
  invariant(previous.packageApiName === next.packageApiName, "INVALID_PACKAGE_UPGRADE", "Package identity cannot change");

  const changes = [];
  if (previous.namespace !== next.namespace) {
    changes.push({ kind: "forbidden", code: "NAMESPACE_CHANGED", path: "namespace" });
  }
  if (previous.kernelContractVersion !== next.kernelContractVersion) {
    changes.push({ kind: "forbidden", code: "KERNEL_CONTRACT_CHANGED", path: "kernelContractVersion" });
  }
  const previousTypes = byName(previous.resources.objectTypes);
  const nextTypes = byName(next.resources.objectTypes);
  for (const [typeName, previousType] of previousTypes) {
    const nextType = nextTypes.get(typeName);
    if (!nextType) {
      changes.push({ kind: "breaking", code: "OBJECT_TYPE_REMOVED", path: typeName });
      continue;
    }
    if (previousType.primaryKey !== nextType.primaryKey) {
      changes.push({ kind: "forbidden", code: "PRIMARY_KEY_CHANGED", path: typeName });
    }
    for (const [propertyName, previousProperty] of Object.entries(previousType.properties)) {
      const nextProperty = nextType.properties[propertyName];
      if (!nextProperty) {
        changes.push({ kind: "breaking", code: "PROPERTY_REMOVED", path: `${typeName}.${propertyName}` });
      } else if (previousProperty.type !== nextProperty.type) {
        changes.push({ kind: "breaking", code: "PROPERTY_TYPE_CHANGED", path: `${typeName}.${propertyName}` });
      }
    }
    for (const [propertyName, nextProperty] of Object.entries(nextType.properties)) {
      if (!previousType.properties[propertyName]) {
        changes.push({
          kind: nextProperty.nullable ? "compatible" : "breaking",
          code: nextProperty.nullable ? "NULLABLE_PROPERTY_ADDED" : "REQUIRED_PROPERTY_ADDED",
          path: `${typeName}.${propertyName}`,
        });
      }
    }
  }
  for (const typeName of nextTypes.keys()) {
    if (!previousTypes.has(typeName)) {
      changes.push({ kind: "compatible", code: "OBJECT_TYPE_ADDED", path: typeName });
    }
  }

  compareNamedResources({
    previous: previous.resources.linkTypes,
    next: next.resources.linkTypes,
    changes,
    resourceName: "LINK_TYPE",
    compare: (left, right) => {
      if (left.sourceType !== right.sourceType || left.targetType !== right.targetType) {
        return "ENDPOINT_CHANGED";
      }
      if (left.cardinality !== right.cardinality) return "CARDINALITY_CHANGED";
      return null;
    },
  });
  compareNamedResources({
    previous: previous.resources.actions,
    next: next.resources.actions,
    changes,
    resourceName: "ACTION",
    compare: (left, right) => {
      if (left.targetType !== right.targetType) return "TARGET_CHANGED";
      if (left.risk !== right.risk) return "RISK_CHANGED";
      if (left.handlerDigest !== right.handlerDigest) return { kind: "compatible", suffix: "HANDLER_CHANGED" };
      return null;
    },
  });
  compareNamedResources({
    previous: previous.resources.policies,
    next: next.resources.policies,
    changes,
    resourceName: "POLICY",
    compare: (left, right) => stableResource(left) === stableResource(right)
      ? null
      : { kind: "review", suffix: "SEMANTICS_CHANGED" },
  });
  compareNamedResources({
    previous: previous.resources.views,
    next: next.resources.views,
    changes,
    resourceName: "VIEW",
    compare: (left, right) => left.objectType === right.objectType ? null : "TARGET_CHANGED",
  });

  return {
    compatible: changes.every((change) => change.kind === "compatible"),
    changes,
  };
}

export function manifestDigest(manifest) {
  validateManifest(manifest);
  return `sha256:${stableHash(manifest)}`;
}

function validatePredicateShape(predicate, objectType) {
  invariant(predicate && typeof predicate === "object", "INVALID_PACKAGE", "Policy predicate is required");
  invariant(objectType.properties[predicate.property], "INVALID_PACKAGE", `Unknown policy property ${predicate.property}`);
  invariant(typeof predicate.op === "string", "INVALID_PACKAGE", "Policy operator is required");
}

function rejectForbiddenKeys(value, path = "$") {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    invariant(!FORBIDDEN_KEYS.has(key), "PACKAGE_CAPABILITY_FORBIDDEN", `Forbidden package capability at ${path}.${key}`);
    rejectForbiddenKeys(child, `${path}.${key}`);
  }
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    invariant(allowed.has(key), "INVALID_PACKAGE", `Unknown ${label} key: ${key}`);
  }
}

function requireArray(value, label, minimum) {
  invariant(Array.isArray(value) && value.length >= minimum, "INVALID_PACKAGE", `${label} requires at least ${minimum} entries`);
  return value;
}

function assertResourceName(value, names) {
  invariant(API_NAME.test(value), "INVALID_PACKAGE", `Invalid resource API name: ${String(value)}`);
  invariant(!names.has(value), "INVALID_PACKAGE", `Duplicate resource API name: ${value}`);
  names.add(value);
}

function byName(resources) {
  return new Map(resources.map((resource) => [resource.apiName, resource]));
}

function compareNamedResources({ previous, next, changes, resourceName, compare }) {
  const previousByName = byName(previous);
  const nextByName = byName(next);
  for (const [apiName, previousResource] of previousByName) {
    const nextResource = nextByName.get(apiName);
    if (!nextResource) {
      changes.push({ kind: "breaking", code: `${resourceName}_REMOVED`, path: apiName });
      continue;
    }
    const difference = compare(previousResource, nextResource);
    if (difference) {
      const normalized = typeof difference === "string"
        ? { kind: "breaking", suffix: difference }
        : difference;
      changes.push({ kind: normalized.kind, code: `${resourceName}_${normalized.suffix}`, path: apiName });
    }
  }
  for (const apiName of nextByName.keys()) {
    if (!previousByName.has(apiName)) {
      changes.push({ kind: "compatible", code: `${resourceName}_ADDED`, path: apiName });
    }
  }
}

function stableResource(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableResource).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stableResource(child)}`).join(",")}}`;
}
