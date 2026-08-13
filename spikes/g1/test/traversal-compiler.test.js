import test from "node:test";
import assert from "node:assert/strict";
import { benchmarkLinkPolicies, benchmarkPolicies, benchmarkRegistry } from "../src/fixtures/benchmark-schema.js";
import { compileTraversal } from "../src/query/traversal-compiler.js";

test("compiles one-hop traversal with policy on start and target", () => {
  const compiled = compileTraversal({
    registry: benchmarkRegistry,
    startObjectType: "EntityA",
    startPrimaryKey: "EA-000001",
    path: [{ linkType: "LinkAB", direction: "out" }],
    select: ["id", "name", "region"],
    policyByObjectType: { "*": benchmarkPolicies.actor_region_east },
    linkPolicyByLinkType: { "*": benchmarkLinkPolicies.allow_all },
  });
  assert.equal(compiled.finalObjectType, "EntityB");
  assert.match(compiled.text, /l1\.source_object_rid = o0\.object_rid/);
  assert.match(compiled.text, /l1\.source_object_type_id = o0\.object_type_id/);
  assert.match(compiled.text, /l1\.target_object_type_id = \$\d+::text/);
  assert.match(compiled.text, /o1\.properties ->> 'region'/);
  assert.deepEqual(compiled.values.slice(0, 4), ["EntityA", "EA-000001", "EAST", "LinkAB"]);
});

test("compiles two-hop traversal without domain-specific branches", () => {
  const compiled = compileTraversal({
    registry: benchmarkRegistry,
    startObjectType: "EntityA",
    startPrimaryKey: "EA-000004",
    path: [
      { linkType: "LinkAB", direction: "out" },
      { linkType: "LinkBC", direction: "out" },
    ],
    select: ["id", "status"],
    policyByObjectType: { "*": benchmarkPolicies.actor_all },
    linkPolicyByLinkType: { "*": benchmarkLinkPolicies.allow_all },
    pageSize: 100,
  });
  assert.equal(compiled.finalObjectType, "EntityC");
  assert.match(compiled.text, /l2\.source_object_rid = o1\.object_rid/);
  assert.match(compiled.text, /o2\.object_rid = l2\.target_object_rid/);
  assert.equal(compiled.values.at(-1), 101);
});

test("rejects invalid path direction and denied projection", () => {
  assert.throws(() => compileTraversal({
    registry: benchmarkRegistry,
    startObjectType: "EntityA",
    startPrimaryKey: "EA-1",
    path: [{ linkType: "LinkAB", direction: "in" }],
    policyByObjectType: { "*": benchmarkPolicies.actor_all },
    linkPolicyByLinkType: { "*": benchmarkLinkPolicies.allow_all },
  }), (error) => error.code === "INVALID_TRAVERSAL");

  assert.throws(() => compileTraversal({
    registry: benchmarkRegistry,
    startObjectType: "EntityA",
    startPrimaryKey: "EA-1",
    path: [{ linkType: "LinkAB", direction: "out" }],
    select: ["sensitiveCode"],
    policyByObjectType: { "*": benchmarkPolicies.actor_masked },
    linkPolicyByLinkType: { "*": benchmarkLinkPolicies.allow_all },
  }), (error) => error.code === "PROPERTY_DENIED");
});

test("fails closed when an explicit link policy is absent", () => {
  assert.throws(() => compileTraversal({
    registry: benchmarkRegistry,
    startObjectType: "EntityA",
    startPrimaryKey: "EA-1",
    path: [{ linkType: "LinkAB", direction: "out" }],
    policyByObjectType: { "*": benchmarkPolicies.actor_all },
  }), (error) => error.code === "POLICY_REQUIRED");
});
