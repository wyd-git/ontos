import test from "node:test";
import assert from "node:assert/strict";
import { benchmarkLinkPolicies, benchmarkPolicies, benchmarkRegistry } from "../src/fixtures/benchmark-schema.js";
import { createPolicyAwareAdapters, ENTRY_POINTS } from "../src/policy/adapters.js";
import { PolicyGateway } from "../src/policy/gateway.js";

test("all adapters compile through one policy gateway and return identical data", async () => {
  const executions = [];
  const audits = [];
  const gateway = makeGateway({ executions, audits });
  const adapters = createPolicyAwareAdapters(gateway);
  const request = {
    actor: { id: "actor_region_east" },
    objectType: "EntityA",
    query: {
      select: ["id", "name", "region"],
      where: { property: "status", op: "eq", value: "OPEN" },
    },
  };

  const results = await Promise.all(ENTRY_POINTS.map((entryPoint) => adapters[entryPoint].search(request)));
  for (const result of results) {
    assert.deepEqual(result.rows, [{ id: "EA-000001", name: "record", region: "EAST" }]);
    assert.equal(result.policyContextHash, benchmarkPolicies.actor_region_east.contextHash);
  }
  assert.equal(new Set(executions.map((item) => item.compiled.text)).size, 1);
  assert.equal(audits.length, ENTRY_POINTS.length);
  assert.deepEqual(new Set(audits.map((item) => item.entryPoint)), new Set(ENTRY_POINTS));
  assert.equal(audits.every((item) => item.outcome === "allow"), true);
});

test("defense-in-depth sanitizer removes deny data and marks masks as non-business null", async () => {
  const audits = [];
  const gateway = makeGateway({ audits });
  const adapter = createPolicyAwareAdapters(gateway).aiToolAdapter;
  const result = await adapter.search({
    actor: { id: "actor_masked" },
    objectType: "EntityA",
    query: { select: ["id", "name", "amount"] },
  });

  assert.deepEqual(result.rows, [{
    id: "EA-000001",
    name: "record",
    amount: null,
  }]);
  assert.equal(Object.hasOwn(result.rows[0], "sensitiveCode"), false);
  assert.deepEqual(result.redactedProperties, ["amount"]);
  assert.equal(JSON.stringify(audits).includes("SECRET-RAW"), false);
});

test("action target loading cannot bypass row policy by guessed primary key", async () => {
  const gateway = new PolicyGateway({
    registry: benchmarkRegistry,
    resolvePolicy: ({ actor }) => benchmarkPolicies[actor.id],
    resolveLinkPolicy: async () => benchmarkLinkPolicies.allow_all,
    execute: async () => ({ rows: [], rowCount: 0 }),
  });
  const adapter = createPolicyAwareAdapters(gateway).actionTarget;
  await assert.rejects(
    adapter.loadActionTarget({
      actor: { id: "actor_region_east" },
      objectType: "EntityA",
      primaryKey: "EA-999999",
    }),
    (error) => error.code === "OBJECT_NOT_ACCESSIBLE",
  );
});

test("all adapters use the same object and link policy path for traversal", async () => {
  const executions = [];
  const audits = [];
  const gateway = makeGateway({ executions, audits });
  const adapters = createPolicyAwareAdapters(gateway);
  const request = {
    actor: { id: "actor_region_east" },
    startObjectType: "EntityA",
    startPrimaryKey: "EA-000273",
    path: [{ linkType: "LinkAB", direction: "out" }],
    select: ["id", "name", "region"],
  };

  const results = await Promise.all(ENTRY_POINTS.map((entryPoint) => adapters[entryPoint].traverse(request)));
  assert.equal(results.every((result) => JSON.stringify(result.rows) === JSON.stringify(results[0].rows)), true);
  assert.equal(new Set(executions.map((item) => item.compiled.text)).size, 1);
  assert.equal(audits.every((item) => item.operation === "traverse" && item.outcome === "allow"), true);
});

test("link policy denial happens before query execution", async () => {
  let executed = false;
  const gateway = new PolicyGateway({
    registry: benchmarkRegistry,
    resolvePolicy: ({ actor }) => benchmarkPolicies[actor.id],
    resolveLinkPolicy: async () => ({ allowLinkType: false, contextHash: "deny-link" }),
    execute: async () => {
      executed = true;
      return { rows: [] };
    },
  });

  await assert.rejects(
    gateway.traverse({
      actor: { id: "actor_all" },
      startObjectType: "EntityA",
      startPrimaryKey: "EA-000273",
      path: [{ linkType: "LinkAB", direction: "out" }],
      entryPoint: "objectApi",
    }),
    (error) => error.code === "RESOURCE_FORBIDDEN",
  );
  assert.equal(executed, false);
});

test("gateway requires an explicit link-policy resolver", () => {
  assert.throws(() => new PolicyGateway({
    registry: benchmarkRegistry,
    resolvePolicy: ({ actor }) => benchmarkPolicies[actor.id],
    execute: async () => ({ rows: [] }),
  }), (error) => error.code === "INVALID_GATEWAY");
});

test("traversal removes the sentinel row and reports the next page", async () => {
  const gateway = new PolicyGateway({
    registry: benchmarkRegistry,
    resolvePolicy: ({ actor }) => benchmarkPolicies[actor.id],
    resolveLinkPolicy: async () => benchmarkLinkPolicies.allow_all,
    execute: async () => ({
      rows: [
        { id: "EB-1", name: "one", region: "EAST" },
        { id: "EB-2", name: "two", region: "EAST" },
        { id: "EB-3", name: "sentinel", region: "EAST" },
      ],
      rowCount: 3,
    }),
  });
  const result = await gateway.traverse({
    actor: { id: "actor_all" },
    startObjectType: "EntityA",
    startPrimaryKey: "EA-1",
    path: [{ linkType: "LinkAB", direction: "out" }],
    select: ["id", "name", "region"],
    pageSize: 2,
    entryPoint: "objectApi",
  });

  assert.deepEqual(result.rows.map((row) => row.id), ["EB-1", "EB-2"]);
  assert.equal(result.rowCount, 2);
  assert.equal(result.hasNextPage, true);
});

function makeGateway({ executions = [], audits = [] }) {
  return new PolicyGateway({
    registry: benchmarkRegistry,
    resolvePolicy: ({ actor }) => benchmarkPolicies[actor.id],
    resolveLinkPolicy: async () => benchmarkLinkPolicies.allow_all,
    execute: async (request) => {
      executions.push(request);
      return {
        rows: [{
          id: "EA-000001",
          name: "record",
          status: "OPEN",
          updatedAt: "2025-01-01T00:00:00Z",
          amount: "100.00",
          active: true,
          region: "EAST",
          sensitiveCode: "SECRET-RAW",
          tags: ["tag-1"],
        }],
        rowCount: 1,
      };
    },
    audit: (event) => audits.push(event),
  });
}
