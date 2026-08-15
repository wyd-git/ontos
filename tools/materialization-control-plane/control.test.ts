import assert from "node:assert/strict";
import test from "node:test";

import { assertLockPlan } from "../metadata-control-plane/model.ts";
import {
  assertMaterializationLockPlans,
  GC_COMMIT_LOCK_PLAN,
  MATERIALIZATION_CUTOVER_LOCK_PLAN,
  orderedObjectTypeCutoverKeys,
  RUNTIME_PUBLISH_LOCK_PLAN,
} from "./control.ts";

void test("Publish, Cutover and GC share the one monotonic lock order", () => {
  assert.doesNotThrow(assertMaterializationLockPlans);
  assert.deepEqual(RUNTIME_PUBLISH_LOCK_PLAN, [
    "PROJECT_CONTROL",
    "RELEASE_CHANNEL",
    "RELEASE",
    "RELEASE_PINS",
    "GENERATION_INVENTORY",
    "SERVING_HEADS",
  ]);
  assert.deepEqual(MATERIALIZATION_CUTOVER_LOCK_PLAN, [
    "PROJECT_CONTROL",
    "RELEASE_CHANNEL",
    "SNAPSHOT_GROUP",
    "OBJECT_TYPE_CUTOVER",
    "GENERATION_INVENTORY",
    "SERVING_HEADS",
  ]);
  assert.deepEqual(GC_COMMIT_LOCK_PLAN, ["PROJECT_CONTROL", "GENERATION_INVENTORY"]);
  assert.throws(
    () => assertLockPlan(["GENERATION_INVENTORY", "OBJECT_TYPE_CUTOVER"]),
    /global order/u,
  );
});

void test("Object Type locks are canonical, unique and byte ordered", () => {
  assert.deepEqual(
    orderedObjectTypeCutoverKeys([
      "00000000-0000-4000-8000-0000000000ff",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000010",
    ]),
    [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-0000000000ff",
    ],
  );
  assert.throws(
    () =>
      orderedObjectTypeCutoverKeys([
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000001",
      ]),
    /unique canonical UUIDs/u,
  );
  assert.throws(() => orderedObjectTypeCutoverKeys(["ObjectType"]), /canonical UUIDs/u);
});
