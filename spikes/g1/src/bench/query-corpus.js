import { benchmarkLinkPolicies, benchmarkPolicies, benchmarkRegistry } from "../fixtures/benchmark-schema.js";
import { compileAggregate, compileSearch } from "../query/compiler.js";
import { compileTraversal } from "../query/traversal-compiler.js";

export const benchmarkQueryCorpus = [
  {
    id: "primary-key-get",
    thresholdMs: 300,
    build: () => compileSearch({
      registry: benchmarkRegistry,
      objectType: "EntityA",
      policy: benchmarkPolicies.actor_all,
      query: { select: ["id", "name", "status"], where: { property: "id", op: "eq", value: "EA-010000" }, page: { size: 1 } },
    }),
  },
  {
    id: "status-time-list",
    thresholdMs: 1000,
    build: () => compileSearch({
      registry: benchmarkRegistry,
      objectType: "EntityA",
      policy: benchmarkPolicies.actor_all,
      query: {
        select: ["id", "name", "status", "updatedAt"],
        where: { and: [
          { property: "status", op: "in", value: ["OPEN", "BLOCKED"] },
          { property: "updatedAt", op: "gte", value: "2025-06-01T00:00:00Z" },
        ] },
        orderBy: [{ property: "updatedAt", direction: "desc" }],
        page: { size: 50 },
      },
    }),
  },
  {
    id: "policy-region-list",
    thresholdMs: 1000,
    build: () => compileSearch({
      registry: benchmarkRegistry,
      objectType: "EntityD",
      policy: benchmarkPolicies.actor_region_east,
      query: {
        select: ["id", "status", "region"],
        where: { property: "status", op: "eq", value: "OPEN" },
        page: { size: 50 },
      },
    }),
  },
  {
    id: "name-prefix",
    thresholdMs: 1000,
    build: () => compileSearch({
      registry: benchmarkRegistry,
      objectType: "EntityC",
      policy: benchmarkPolicies.actor_all,
      query: {
        select: ["id", "name"],
        where: { property: "name", op: "prefix", value: "EntityC record 19" },
        orderBy: [{ property: "id", direction: "asc" }],
        page: { size: 50 },
      },
    }),
  },
  {
    id: "name-contains",
    thresholdMs: 1000,
    build: () => compileSearch({
      registry: benchmarkRegistry,
      objectType: "EntityC",
      policy: benchmarkPolicies.actor_all,
      query: {
        select: ["id", "name"],
        where: { property: "name", op: "contains", value: "record 199" },
        page: { size: 50 },
      },
    }),
  },
  {
    id: "amount-range",
    thresholdMs: 1000,
    build: () => compileSearch({
      registry: benchmarkRegistry,
      objectType: "EntityB",
      policy: benchmarkPolicies.actor_all,
      query: {
        select: ["id", "amount"],
        where: { and: [
          { property: "amount", op: "gte", value: "10000" },
          { property: "amount", op: "lt", value: "10500" },
        ] },
        orderBy: [{ property: "amount", direction: "asc" }],
        page: { size: 50 },
      },
    }),
  },
  {
    id: "tags-contains-any",
    thresholdMs: 1000,
    build: () => compileSearch({
      registry: benchmarkRegistry,
      objectType: "EntityE",
      policy: benchmarkPolicies.actor_all,
      query: {
        select: ["id", "tags"],
        where: { property: "tags", op: "containsAny", value: ["tag-7"] },
        page: { size: 50 },
      },
    }),
  },
  {
    id: "policy-aggregate",
    thresholdMs: 2000,
    build: () => compileAggregate({
      registry: benchmarkRegistry,
      objectType: "EntityB",
      policy: benchmarkPolicies.actor_region_east,
      query: {
        groupBy: "status",
        measures: [
          { op: "count", as: "objects" },
          { op: "avg", property: "amount", as: "averageAmount" },
        ],
      },
    }),
  },
  {
    id: "one-hop",
    thresholdMs: 300,
    build: () => compileTraversal({
      registry: benchmarkRegistry,
      startObjectType: "EntityA",
      startPrimaryKey: "EA-010003",
      path: [{ linkType: "LinkAB", direction: "out" }],
      select: ["id", "name", "status"],
      policyByObjectType: { "*": benchmarkPolicies.actor_all },
      linkPolicyByLinkType: { "*": benchmarkLinkPolicies.allow_all },
      pageSize: 50,
    }),
  },
  {
    id: "two-hop",
    thresholdMs: 1500,
    build: () => compileTraversal({
      registry: benchmarkRegistry,
      startObjectType: "EntityA",
      startPrimaryKey: "EA-010003",
      path: [
        { linkType: "LinkAB", direction: "out" },
        { linkType: "LinkBC", direction: "out" },
      ],
      select: ["id", "name", "status"],
      policyByObjectType: { "*": benchmarkPolicies.actor_all },
      linkPolicyByLinkType: { "*": benchmarkLinkPolicies.allow_all },
      pageSize: 50,
    }),
  },
];
