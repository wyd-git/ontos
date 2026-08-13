import { createSchemaRegistry } from "../core/schema-registry.js";
import { stableHash } from "../core/stable-json.js";
import { intersectPolicies } from "../policy/intersection.js";

const commonProperties = {
  id: {
    type: "string",
    storage: "column",
    column: "primary_key",
    nullable: false,
    filterable: true,
    sortable: true,
  },
  name: {
    type: "string",
    storage: "json",
    jsonKey: "name",
    nullable: false,
    filterable: true,
    sortable: true,
    searchable: true,
  },
  status: {
    type: "enum",
    values: ["OPEN", "IN_PROGRESS", "BLOCKED", "CLOSED"],
    storage: "json",
    jsonKey: "status",
    nullable: false,
    filterable: true,
    sortable: true,
  },
  updatedAt: {
    type: "timestamp",
    storage: "json",
    jsonKey: "updatedAt",
    nullable: false,
    filterable: true,
    sortable: true,
  },
  amount: {
    type: "decimal",
    storage: "json",
    jsonKey: "amount",
    nullable: false,
    filterable: true,
    sortable: true,
  },
  active: {
    type: "boolean",
    storage: "json",
    jsonKey: "active",
    nullable: false,
    filterable: true,
    sortable: true,
  },
  region: {
    type: "enum",
    values: ["EAST", "WEST", "NORTH", "SOUTH"],
    storage: "json",
    jsonKey: "region",
    nullable: false,
    filterable: true,
    sortable: true,
  },
  sensitiveCode: {
    type: "string",
    storage: "json",
    jsonKey: "sensitiveCode",
    nullable: false,
    filterable: false,
    sortable: false,
    searchable: false,
  },
  tags: {
    type: "string[]",
    storage: "json",
    jsonKey: "tags",
    nullable: false,
    filterable: true,
    sortable: false,
  },
};

const objectTypes = Object.fromEntries(
  ["EntityA", "EntityB", "EntityC", "EntityD", "EntityE"].map((apiName) => [
    apiName,
    {
      apiName,
      primaryKey: "id",
      properties: commonProperties,
    },
  ]),
);

export const benchmarkRegistry = createSchemaRegistry({
  releaseRevision: "benchmark-r1",
  objectTypes,
  linkTypes: {
    LinkAB: { sourceType: "EntityA", targetType: "EntityB" },
    LinkBC: { sourceType: "EntityB", targetType: "EntityC" },
    LinkCD: { sourceType: "EntityC", targetType: "EntityD" },
    LinkDE: { sourceType: "EntityD", targetType: "EntityE" },
    LinkEA: { sourceType: "EntityE", targetType: "EntityA" },
  },
});

const actorAll = makePolicy("actor_all", null, {});
const actorRegionEast = makePolicy(
    "actor_region_east",
    { property: "region", op: "eq", value: "EAST" },
    {},
  );
const actorMasked = makePolicy("actor_masked", null, {
    amount: "mask",
    sensitiveCode: "deny",
  });
const serviceReader = makePolicy("service_reader", null, {}, { actionsAllowed: false });

export const benchmarkPolicies = Object.freeze({
  actor_all: actorAll,
  actor_region_east: actorRegionEast,
  actor_masked: actorMasked,
  service_reader: serviceReader,
  delegated_east: intersectPolicies(serviceReader, actorRegionEast, { id: "delegated_east" }),
});

const allowAllLinks = {
  id: "allow_all_links",
  allowLinkType: true,
};
export const benchmarkLinkPolicies = Object.freeze({
  allow_all: Object.freeze({
    ...allowAllLinks,
    contextHash: stableHash(allowAllLinks),
  }),
});

function makePolicy(id, rowPredicate, propertyDecisions, extra = {}) {
  const policy = {
    id,
    allowObjectType: true,
    rowPredicate,
    defaultPropertyDecision: "allow",
    propertyDecisions,
    ...extra,
  };

  return Object.freeze({
    ...policy,
    contextHash: stableHash(policy),
  });
}
