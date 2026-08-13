import test from "node:test";
import assert from "node:assert/strict";
import { benchmarkPolicies, benchmarkRegistry } from "../src/fixtures/benchmark-schema.js";
import { KernelError } from "../src/core/kernel-error.js";
import { compileAggregate, compileSearch } from "../src/query/compiler.js";
import { encodeCursor } from "../src/query/cursor.js";

const cursorSecret = "test-cursor-secret-20260813";

test("compiles a typed search with policy predicate before execution", () => {
  const compiled = compileSearch({
    registry: benchmarkRegistry,
    objectType: "EntityA",
    policy: benchmarkPolicies.actor_region_east,
    query: {
      select: ["id", "name", "status", "updatedAt"],
      where: {
        and: [
          { property: "status", op: "in", value: ["OPEN", "BLOCKED"] },
          { property: "updatedAt", op: "gte", value: "2025-06-01T00:00:00Z" },
        ],
      },
      orderBy: [{ property: "updatedAt", direction: "desc" }],
      page: { size: 50 },
    },
  });

  assert.match(compiled.text, /oc\.properties ->> 'region'/);
  assert.match(compiled.text, /= ANY\(\$2::text\[\]\)/);
  assert.match(compiled.text, /ORDER BY .*updatedAt.* DESC NULLS LAST, oc\.primary_key DESC/s);
  assert.deepEqual(compiled.values, ["EntityA", ["OPEN", "BLOCKED"], "2025-06-01T00:00:00.000000Z", "EAST", 51]);
  assert.equal(compiled.pageSize, 50);
});

test("keeps untrusted values out of SQL text", () => {
  const payload = "OPEN'); DROP TABLE kernel.object_current; --";
  assert.throws(() => compileSearch({
    registry: benchmarkRegistry,
    objectType: "EntityA",
    policy: benchmarkPolicies.actor_all,
    query: {
      select: ["id"],
      where: { property: "status", op: "eq", value: payload },
    },
  }), (error) => error instanceof KernelError && error.code === "INVALID_QUERY_VALUE");

  const textPayload = "record%_' OR true --";
  const compiled = compileSearch({
    registry: benchmarkRegistry,
    objectType: "EntityA",
    policy: benchmarkPolicies.actor_all,
    query: {
      select: ["id"],
      where: { property: "name", op: "contains", value: textPayload },
    },
  });
  assert.equal(compiled.text.includes(textPayload), false);
  assert.equal(compiled.values[1], "%record\\%\\_' OR true --%");
});

test("rejects unknown or non-queryable properties", () => {
  assertKernelCode("PROPERTY_NOT_FOUND", () => compileSearch({
    registry: benchmarkRegistry,
    objectType: "EntityA",
    policy: benchmarkPolicies.actor_all,
    query: { where: { property: "unknownField", op: "eq", value: "x" } },
  }));

  assertKernelCode("PROPERTY_NOT_QUERYABLE", () => compileSearch({
    registry: benchmarkRegistry,
    objectType: "EntityA",
    policy: benchmarkPolicies.actor_all,
    query: { where: { property: "sensitiveCode", op: "eq", value: "x" } },
  }));
});

test("masks selected properties and denies sensitive properties", () => {
  const masked = compileSearch({
    registry: benchmarkRegistry,
    objectType: "EntityA",
    policy: benchmarkPolicies.actor_masked,
    query: { select: ["id", "amount"] },
  });
  assert.match(masked.text, /NULL::numeric AS "amount"/);
  assert.deepEqual(masked.redactedProperties, ["amount"]);

  assertKernelCode("PROPERTY_DENIED", () => compileSearch({
    registry: benchmarkRegistry,
    objectType: "EntityA",
    policy: benchmarkPolicies.actor_masked,
    query: { select: ["id", "sensitiveCode"] },
  }));

  assertKernelCode("PROPERTY_NOT_QUERYABLE", () => compileSearch({
    registry: benchmarkRegistry,
    objectType: "EntityA",
    policy: benchmarkPolicies.actor_masked,
    query: { where: { property: "amount", op: "gte", value: "100" } },
  }));
});

test("enforces query complexity limits", () => {
  const nested = { property: "status", op: "eq", value: "OPEN" };
  let current = nested;
  for (let index = 0; index < 6; index += 1) {
    current = { not: current };
  }

  assertKernelCode("QUERY_TOO_COMPLEX", () => compileSearch({
    registry: benchmarkRegistry,
    objectType: "EntityA",
    policy: benchmarkPolicies.actor_all,
    query: { where: current },
  }));
});

test("binds cursors to release, query, policy, and order context", () => {
  const first = compileSearch({
    registry: benchmarkRegistry,
    objectType: "EntityA",
    policy: benchmarkPolicies.actor_all,
    cursorSecret,
    query: {
      select: ["id", "updatedAt"],
      orderBy: [{ property: "updatedAt", direction: "asc" }],
      page: { size: 20 },
    },
  });
  const cursor = encodeCursor({
    releaseRevision: benchmarkRegistry.releaseRevision,
    objectType: "EntityA",
    queryHash: first.queryHash,
    policyContextHash: benchmarkPolicies.actor_all.contextHash,
    order: first.order,
    sortValue: "2025-06-01T00:00:00Z",
    primaryKey: "EA-000100",
  }, cursorSecret);

  const next = compileSearch({
    registry: benchmarkRegistry,
    objectType: "EntityA",
    policy: benchmarkPolicies.actor_all,
    cursorSecret,
    query: {
      select: ["id", "updatedAt"],
      orderBy: [{ property: "updatedAt", direction: "asc" }],
      page: { size: 20, cursor },
    },
  });
  assert.match(next.text, /oc\.primary_key > \$\d+::text/);

  assertKernelCode("CURSOR_CONTEXT_CHANGED", () => compileSearch({
    registry: benchmarkRegistry,
    objectType: "EntityA",
    policy: benchmarkPolicies.actor_region_east,
    cursorSecret,
    query: {
      select: ["id", "updatedAt"],
      orderBy: [{ property: "updatedAt", direction: "asc" }],
      page: { size: 20, cursor },
    },
  }));
});

test("compiles policy-aware aggregate and rejects masked measures", () => {
  const compiled = compileAggregate({
    registry: benchmarkRegistry,
    objectType: "EntityB",
    policy: benchmarkPolicies.actor_region_east,
    query: {
      where: { property: "active", op: "eq", value: true },
      groupBy: "status",
      measures: [
        { op: "count", as: "objects" },
        { op: "avg", property: "amount", as: "averageAmount" },
      ],
    },
  });
  assert.match(compiled.text, /GROUP BY/);
  assert.match(compiled.text, /avg\(/);
  assert.equal(compiled.values.includes("EAST"), true);

  assertKernelCode("PROPERTY_NOT_QUERYABLE", () => compileAggregate({
    registry: benchmarkRegistry,
    objectType: "EntityB",
    policy: benchmarkPolicies.actor_masked,
    query: { measures: [{ op: "sum", property: "amount" }] },
  }));
});

function assertKernelCode(code, callback) {
  assert.throws(callback, (error) => error instanceof KernelError && error.code === code);
}
