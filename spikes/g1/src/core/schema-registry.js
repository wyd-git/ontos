import { invariant } from "./kernel-error.js";

const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const PROPERTY_TYPES = new Set([
  "string",
  "boolean",
  "integer",
  "decimal",
  "date",
  "timestamp",
  "enum",
  "string[]",
  "json",
]);

export function createSchemaRegistry(definition) {
  invariant(definition && typeof definition === "object", "INVALID_SCHEMA", "Schema definition is required");
  invariant(definition.objectTypes && typeof definition.objectTypes === "object", "INVALID_SCHEMA", "objectTypes are required");

  const objectTypes = {};
  for (const [objectTypeName, objectType] of Object.entries(definition.objectTypes)) {
    assertApiName(objectTypeName, "object type");
    invariant(objectType.properties && typeof objectType.properties === "object", "INVALID_SCHEMA", `Properties are required for ${objectTypeName}`);

    const properties = {};
    for (const [propertyName, property] of Object.entries(objectType.properties)) {
      assertApiName(propertyName, "property");
      invariant(PROPERTY_TYPES.has(property.type), "INVALID_SCHEMA", `Unsupported type for ${objectTypeName}.${propertyName}`);
      invariant(["column", "json"].includes(property.storage), "INVALID_SCHEMA", `Invalid storage for ${objectTypeName}.${propertyName}`);

      if (property.storage === "column") {
        invariant(property.column === "primary_key", "INVALID_SCHEMA", "Only primary_key is exposed as a column in the spike");
      } else {
        assertApiName(property.jsonKey, "JSON key");
      }

      if (property.type === "enum") {
        invariant(Array.isArray(property.values) && property.values.length > 0, "INVALID_SCHEMA", `Enum values are required for ${objectTypeName}.${propertyName}`);
      }

      properties[propertyName] = Object.freeze({
        filterable: false,
        sortable: false,
        searchable: false,
        nullable: true,
        ...property,
      });
    }

    invariant(properties[objectType.primaryKey]?.storage === "column", "INVALID_SCHEMA", `Primary key is invalid for ${objectTypeName}`);
    objectTypes[objectTypeName] = Object.freeze({
      ...objectType,
      properties: Object.freeze(properties),
    });
  }

  const linkTypes = {};
  for (const [linkTypeName, linkType] of Object.entries(definition.linkTypes ?? {})) {
    assertApiName(linkTypeName, "link type");
    invariant(objectTypes[linkType.sourceType], "INVALID_SCHEMA", `Unknown source type for ${linkTypeName}`);
    invariant(objectTypes[linkType.targetType], "INVALID_SCHEMA", `Unknown target type for ${linkTypeName}`);
    linkTypes[linkTypeName] = Object.freeze({ ...linkType });
  }

  return Object.freeze({
    releaseRevision: definition.releaseRevision,
    objectTypes: Object.freeze(objectTypes),
    linkTypes: Object.freeze(linkTypes),
  });
}

export function getObjectType(registry, objectTypeName) {
  const objectType = registry.objectTypes[objectTypeName];
  invariant(objectType, "OBJECT_TYPE_NOT_FOUND", `Unknown object type: ${objectTypeName}`);
  return objectType;
}

export function getProperty(objectType, propertyName) {
  const property = objectType.properties[propertyName];
  invariant(property, "PROPERTY_NOT_FOUND", `Unknown property: ${propertyName}`);
  return property;
}

export function assertApiName(value, label = "API name") {
  invariant(typeof value === "string" && API_NAME.test(value), "INVALID_API_NAME", `Invalid ${label}: ${String(value)}`);
}
