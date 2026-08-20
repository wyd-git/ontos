import {
  parseLinkTypeDefinition,
  parseObjectTypeDefinition,
  parseOntosId,
  type LinkTypeDefinition,
  type ObjectTypeDefinition,
  type PropertyDefinition,
} from "@ontos/contracts";
import type { PropertyDescriptor } from "@ontos/value-codec";

import { failQuery } from "./error.ts";

export interface QueryObjectTypeSnapshot {
  readonly memberKey: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly generationId: string;
  readonly definition: unknown;
}

export interface QueryLinkTypeSnapshot {
  readonly memberKey: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly generationId: string;
  readonly definition: unknown;
}

export interface QuerySchemaRegistryInput {
  readonly projectId: string;
  readonly releaseId: string;
  readonly releaseRevisionId: string;
  readonly activationId: string;
  readonly objects: readonly QueryObjectTypeSnapshot[];
  readonly links: readonly QueryLinkTypeSnapshot[];
}

export interface QueryPropertySchema {
  readonly apiName: string;
  readonly valueType: PropertyDefinition["valueType"];
  readonly nullable: boolean;
  readonly caseSensitive: boolean;
  readonly filterable: boolean;
  readonly sortable: boolean;
  readonly searchable: boolean;
  readonly enumValues: readonly string[] | null;
  readonly decimalPrecision: number | null;
  readonly decimalScale: number | null;
  readonly descriptor: PropertyDescriptor;
}

export interface QueryObjectTypeSchema {
  readonly memberKey: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly generationId: string;
  readonly apiName: string;
  readonly primaryKeyPropertyApiName: string;
  readonly defaultSearchPropertyApiNames: readonly string[];
  readonly defaultSort: ObjectTypeDefinition["defaultSort"];
  readonly properties: readonly QueryPropertySchema[];
}

export interface QueryLinkTypeSchema {
  readonly memberKey: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly generationId: string;
  readonly apiName: string;
  readonly sourceObjectTypeRevisionId: string;
  readonly targetObjectTypeRevisionId: string;
}

const memberKeyPattern = /^(object|link):([A-Za-z][A-Za-z0-9_]{0,62})$/u;

export class QuerySchemaRegistry {
  readonly projectId: string;
  readonly releaseId: string;
  readonly releaseRevisionId: string;
  readonly activationId: string;
  readonly objects: readonly QueryObjectTypeSchema[];
  readonly links: readonly QueryLinkTypeSchema[];

  readonly #objectsByApiName: ReadonlyMap<string, QueryObjectTypeSchema>;
  readonly #objectsByRevision: ReadonlyMap<string, QueryObjectTypeSchema>;
  readonly #linksByApiName: ReadonlyMap<string, QueryLinkTypeSchema>;
  readonly #linksByRevision: ReadonlyMap<string, QueryLinkTypeSchema>;

  constructor(input: QuerySchemaRegistryInput) {
    try {
      this.projectId = parseOntosId(input.projectId);
      this.releaseId = parseOntosId(input.releaseId);
      this.releaseRevisionId = parseOntosId(input.releaseRevisionId);
      this.activationId = parseOntosId(input.activationId);
    } catch (error) {
      failQuery("QUERY_SCHEMA_INVALID", "Query Registry binding is invalid.", { cause: error });
    }
    if (input.objects.length === 0 || input.objects.length > 256 || input.links.length > 256) {
      failQuery("QUERY_SCHEMA_INVALID", "Query Registry member count is outside the envelope.");
    }
    const objects = input.objects.map(parseObjectSnapshot);
    const links = input.links.map(parseLinkSnapshot);
    assertUnique(objects, "apiName");
    assertUnique(objects, "resourceId");
    assertUnique(objects, "revisionId");
    assertUnique(objects, "memberKey");
    assertUnique(links, "apiName");
    assertUnique(links, "resourceId");
    assertUnique(links, "revisionId");
    assertUnique(links, "memberKey");
    const objectsByRevision = new Map(objects.map((object) => [object.revisionId, object]));
    for (const link of links) {
      if (
        !objectsByRevision.has(link.sourceObjectTypeRevisionId) ||
        !objectsByRevision.has(link.targetObjectTypeRevisionId)
      ) {
        failQuery(
          "QUERY_SCHEMA_INVALID",
          "Query Link endpoints must resolve inside the same Release Registry.",
        );
      }
    }
    this.objects = Object.freeze(objects);
    this.links = Object.freeze(links);
    this.#objectsByApiName = new Map(objects.map((object) => [object.apiName, object]));
    this.#objectsByRevision = objectsByRevision;
    this.#linksByApiName = new Map(links.map((link) => [link.apiName, link]));
    this.#linksByRevision = new Map(links.map((link) => [link.revisionId, link]));
    Object.freeze(this);
  }

  requireObjectByApiName(apiName: string): QueryObjectTypeSchema {
    const object = this.#objectsByApiName.get(apiName);
    if (object === undefined)
      failQuery("QUERY_SCHEMA_INVALID", "Object Type is not present in the bound Registry.");
    return object;
  }

  requireObjectByRevision(revisionId: string): QueryObjectTypeSchema {
    const object = this.#objectsByRevision.get(revisionId);
    if (object === undefined)
      failQuery("QUERY_SCHEMA_INVALID", "Object Type Revision is not present in the Registry.");
    return object;
  }

  requireLinkByApiName(apiName: string): QueryLinkTypeSchema {
    const link = this.#linksByApiName.get(apiName);
    if (link === undefined)
      failQuery("QUERY_SCHEMA_INVALID", "Link Type is not present in the bound Registry.");
    return link;
  }

  requireLinkByRevision(revisionId: string): QueryLinkTypeSchema {
    const link = this.#linksByRevision.get(revisionId);
    if (link === undefined)
      failQuery("QUERY_SCHEMA_INVALID", "Link Type Revision is not present in the Registry.");
    return link;
  }
}

export function requireQueryProperty(
  object: QueryObjectTypeSchema,
  apiName: string,
): QueryPropertySchema {
  const property = object.properties.find((candidate) => candidate.apiName === apiName);
  if (property === undefined)
    failQuery("PROPERTY_NOT_QUERYABLE", "Property is not present in the bound Object Type.");
  return property;
}

function parseObjectSnapshot(snapshot: QueryObjectTypeSnapshot): QueryObjectTypeSchema {
  let definition: ObjectTypeDefinition;
  let resourceId: string;
  let revisionId: string;
  let generationId: string;
  try {
    definition = parseObjectTypeDefinition(snapshot.definition);
    resourceId = parseOntosId(snapshot.resourceId);
    revisionId = parseOntosId(snapshot.revisionId);
    generationId = parseOntosId(snapshot.generationId);
  } catch (error) {
    failQuery("QUERY_SCHEMA_INVALID", "Object Type Registry snapshot is invalid.", {
      cause: error,
    });
  }
  const member = parseMemberKey(snapshot.memberKey, "object");
  if (member.apiName !== definition.apiName) {
    failQuery("QUERY_SCHEMA_INVALID", "Object member identity does not match its definition.");
  }
  return Object.freeze({
    memberKey: snapshot.memberKey,
    resourceId,
    revisionId,
    generationId,
    apiName: definition.apiName,
    primaryKeyPropertyApiName: definition.primaryKeyPropertyApiName,
    defaultSearchPropertyApiNames: Object.freeze([...definition.defaultSearchPropertyApiNames]),
    defaultSort: Object.freeze([...definition.defaultSort]),
    properties: Object.freeze(definition.properties.map(propertySchema)),
  });
}

function parseLinkSnapshot(snapshot: QueryLinkTypeSnapshot): QueryLinkTypeSchema {
  let definition: LinkTypeDefinition;
  let resourceId: string;
  let revisionId: string;
  let generationId: string;
  try {
    definition = parseLinkTypeDefinition(snapshot.definition);
    resourceId = parseOntosId(snapshot.resourceId);
    revisionId = parseOntosId(snapshot.revisionId);
    generationId = parseOntosId(snapshot.generationId);
  } catch (error) {
    failQuery("QUERY_SCHEMA_INVALID", "Link Type Registry snapshot is invalid.", { cause: error });
  }
  const member = parseMemberKey(snapshot.memberKey, "link");
  if (member.apiName !== definition.apiName) {
    failQuery("QUERY_SCHEMA_INVALID", "Link member identity does not match its definition.");
  }
  return Object.freeze({
    memberKey: snapshot.memberKey,
    resourceId,
    revisionId,
    generationId,
    apiName: definition.apiName,
    sourceObjectTypeRevisionId: definition.source.objectTypeRevisionId,
    targetObjectTypeRevisionId: definition.target.objectTypeRevisionId,
  });
}

function propertySchema(property: PropertyDefinition): QueryPropertySchema {
  return Object.freeze({
    apiName: property.apiName,
    valueType: property.valueType,
    nullable: property.nullable,
    caseSensitive: property.caseSensitive ?? true,
    filterable: property.filterable,
    sortable: property.sortable,
    searchable: property.searchable,
    enumValues: property.enumValues === undefined ? null : Object.freeze([...property.enumValues]),
    decimalPrecision: property.decimalPrecision ?? null,
    decimalScale: property.decimalScale ?? null,
    descriptor: descriptorFromProperty(property),
  });
}

function descriptorFromProperty(property: PropertyDefinition): PropertyDescriptor {
  const nullable = property.nullable;
  switch (property.valueType) {
    case "boolean":
    case "integer":
    case "date":
    case "timestamp":
    case "string[]":
    case "json":
      return Object.freeze({ type: property.valueType, nullable });
    case "string":
      return Object.freeze({ type: "string", nullable });
    case "enum":
      if (property.enumValues === undefined)
        failQuery("QUERY_SCHEMA_INVALID", "Enum Property is missing its immutable Code List.");
      return Object.freeze({ type: "enum", values: property.enumValues, nullable });
    case "decimal":
      if (property.decimalPrecision === undefined || property.decimalScale === undefined) {
        failQuery("QUERY_SCHEMA_INVALID", "Decimal Property is missing its immutable format.");
      }
      return Object.freeze({
        type: "decimal",
        precision: property.decimalPrecision,
        scale: property.decimalScale,
        nullable,
      });
  }
}

function parseMemberKey(
  value: string,
  expectedKind: "object" | "link",
): { readonly apiName: string } {
  const match = memberKeyPattern.exec(value);
  if (match?.[1] !== expectedKind || match[2] === undefined) {
    failQuery("QUERY_SCHEMA_INVALID", "Runtime member key is invalid.");
  }
  return { apiName: match[2] };
}

function assertUnique<K extends PropertyKey, T extends Record<K, string>>(
  values: readonly T[],
  key: K,
): void {
  if (new Set(values.map((value) => value[key])).size !== values.length) {
    failQuery("QUERY_SCHEMA_INVALID", `Query Registry ${String(key)} values must be unique.`);
  }
}
