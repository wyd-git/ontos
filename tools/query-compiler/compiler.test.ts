import assert from "node:assert/strict";
import test from "node:test";

import { parseOntosId, type PolicyRule } from "@ontos/contracts";
import { QueryDomainError, compileObjectGet, compileObjectSearch } from "@ontos/query-domain";

import { objectPolicy, queryRegistry, searchRequest, sha256 } from "./fixtures.ts";

const requestTime = "2026-08-20T04:00:00.000000Z";

void test("strict AST, type-specific Value Codec and Primary Key Codec reject deceptive input", () => {
  const context = { registry: queryRegistry(), requestTime, digestCanonicalText: sha256 };
  const policy = objectPolicy("Customer");
  for (const request of [
    searchRequest({ unexpected: true }),
    searchRequest({ where: { property: "count", op: "eq", value: 1.5 } }),
    searchRequest({ where: { property: "count", op: "eq", value: "01" } }),
    searchRequest({ where: { property: "amount", op: "eq", value: "1e3" } }),
    searchRequest({ searchText: "x".repeat(257) }),
  ]) {
    assert.throws(
      () => compileObjectSearch({ context, objectTypeApiName: "Customer", request, policy }),
      (error) => error instanceof QueryDomainError && error.code === "INVALID_QUERY_AST",
    );
  }
  assert.throws(
    () =>
      compileObjectGet({
        context,
        objectTypeApiName: "Customer",
        request: { primaryKey: "", select: ["id"] },
        policy,
      }),
    (error) => error instanceof QueryDomainError && error.code === "INVALID_QUERY_AST",
  );
});

void test("Query Hash is canonical across key/logical/list order and changes with semantics", () => {
  const context = { registry: queryRegistry(), requestTime, digestCanonicalText: sha256 };
  const policy = objectPolicy("Customer");
  const first = compileObjectSearch({
    context,
    objectTypeApiName: "Customer",
    policy,
    request: searchRequest({
      where: {
        and: [
          { property: "status", op: "in", value: ["INACTIVE", "ACTIVE"] },
          { property: "count", op: "gte", value: "10" },
        ],
      },
    }),
  });
  const second = compileObjectSearch({
    context,
    objectTypeApiName: "Customer",
    policy,
    request: {
      page: { cursor: null, size: 20 },
      orderBy: [{ direction: "asc", property: "status" }],
      where: {
        and: [
          { value: "10", op: "gte", property: "count" },
          { value: ["ACTIVE", "INACTIVE"], property: "status", op: "in" },
        ],
      },
      select: ["id", "displayName", "status"],
      schemaVersion: 1,
    },
  });
  const changed = compileObjectSearch({
    context,
    objectTypeApiName: "Customer",
    policy,
    request: searchRequest({
      where: {
        and: [
          { property: "status", op: "in", value: ["INACTIVE", "ACTIVE"] },
          { property: "count", op: "gt", value: "10" },
        ],
      },
    }),
  });
  assert.equal(first.queryHash, second.queryHash);
  assert.notEqual(first.queryHash, changed.queryHash);
});

void test("masked Properties are readable but cannot filter, sort or search", () => {
  const context = { registry: queryRegistry(), requestTime, digestCanonicalText: sha256 };
  const policy = objectPolicy("Customer", { secretAccess: "mask" });
  const read = compileObjectSearch({
    context,
    objectTypeApiName: "Customer",
    policy,
    request: searchRequest({
      select: ["id", "secret"],
      where: undefined,
      orderBy: [{ property: "id", direction: "asc" }],
    }),
  });
  assert.deepEqual(
    read.selectedProperties.map(({ apiName }) => apiName),
    ["id", "secret"],
  );
  assert.throws(
    () =>
      compileObjectSearch({
        context,
        objectTypeApiName: "Customer",
        policy,
        request: searchRequest({
          select: ["id"],
          where: { property: "secret", op: "eq", value: "classified" },
        }),
      }),
    (error) => error instanceof QueryDomainError && error.code === "PROPERTY_NOT_QUERYABLE",
  );
});

void test("weighted complexity rejects a trusted Policy corpus before SQL rendering", () => {
  const registry = queryRegistry();
  const customer = registry.requireObjectByApiName("Customer");
  const order = registry.requireObjectByApiName("Order");
  const link = registry.requireLinkByApiName("CustomerOrder");
  const expensiveRules: readonly PolicyRule[] = Object.freeze(
    Array.from({ length: 100 }, (_, index) =>
      Object.freeze({
        ruleId: `ALLOW_LINK_EXISTS_${String(index)}`,
        target: Object.freeze({
          kind: "object" as const,
          resourceId: parseOntosId(customer.resourceId),
          resourceRevisionId: parseOntosId(customer.revisionId),
        }),
        effect: "allow" as const,
        predicate: Object.freeze({
          kind: "link_exists" as const,
          linkTypeApiName: link.apiName,
          linkTypeResourceId: parseOntosId(link.resourceId),
          linkTypeRevisionId: parseOntosId(link.revisionId),
          targetObjectTypeApiName: order.apiName,
          targetObjectTypeResourceId: parseOntosId(order.resourceId),
          targetObjectTypeRevisionId: parseOntosId(order.revisionId),
          predicate: Object.freeze({ kind: "constant" as const, value: true }),
        }),
      }),
    ),
  );

  assert.throws(
    () =>
      compileObjectSearch({
        context: { registry, requestTime, digestCanonicalText: sha256 },
        objectTypeApiName: "Customer",
        request: searchRequest({ where: undefined }),
        policy: objectPolicy("Customer", { extraRules: expensiveRules }),
      }),
    (error) => error instanceof QueryDomainError && error.code === "QUERY_COMPLEXITY_EXCEEDED",
  );
});
