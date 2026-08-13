import assert from "node:assert/strict";
import test from "node:test";

import { g1ShapedReleaseIndexPlan } from "./fixtures.ts";
import { compileReleaseIndexPlan } from "./index-plan.ts";
import { SHARED_PROJECTION_CONTRACT, assertSharedProjectionContract } from "./shared-projection.ts";

void test("shared Object and Link projections have Generation-scoped physical and logical keys", () => {
  assert.doesNotThrow(() => assertSharedProjectionContract());
  assert.deepEqual(SHARED_PROJECTION_CONTRACT.objectCurrent.primaryKey, [
    "project_id",
    "generation_id",
    "object_type_resource_id",
    "object_rid",
  ]);
  assert.deepEqual(SHARED_PROJECTION_CONTRACT.objectCurrent.uniqueKeys[0], [
    "project_id",
    "generation_id",
    "object_type_resource_id",
    "canonical_primary_key",
  ]);
  assert.deepEqual(SHARED_PROJECTION_CONTRACT.linkCurrent.uniqueKeys[0], [
    "project_id",
    "generation_id",
    "link_type_resource_id",
    "source_object_rid",
    "target_object_rid",
  ]);
});

void test("shared table identity never depends on Release, Channel or display labels", () => {
  for (const contract of Object.values(SHARED_PROJECTION_CONTRACT)) {
    const keyColumns = [...contract.primaryKey, ...contract.uniqueKeys.flat()];
    for (const forbidden of contract.forbiddenSelectors) {
      assert.equal(keyColumns.includes(forbidden as never), false);
    }
  }
});

void test("a compiled Property index is scoped to an immutable Object Type Revision", () => {
  const plan = compileReleaseIndexPlan(g1ShapedReleaseIndexPlan("release-a", "revision-a", 1));
  for (const index of plan.indexes) {
    assert.equal(index.table, "runtime.object_current");
    assert.equal(index.predicate.objectTypeResourceId, index.resourceId);
    assert.equal(index.predicate.objectTypeRevisionId, index.revisionId);
    assert.equal(index.predicate.lifecycleState, "active");
  }
});
