import test from "node:test";
import assert from "node:assert/strict";
import {
  catchUpReference,
  materializeReference,
  operation,
  snapshot,
} from "../src/overlay/reference-model.js";

const v1 = snapshot("v1", [
  entity("A-1", { name: "alpha", status: "OPEN", owner: "u1" }),
  entity("A-2", { name: "beta", status: "OPEN", owner: "u2" }),
  entity("A-3", { name: "gamma", status: "OPEN", owner: "u3" }),
]);

test("keeps an overlay when the new base changes a different property", () => {
  const v2 = snapshot("v2", [
    entity("A-1", { name: "alpha renamed", status: "OPEN", owner: "u1" }),
  ]);
  const operations = [operation({
    seq: 1,
    type: "SET_PROPERTY",
    primaryKey: "A-1",
    propertyName: "status",
    value: "IN_PROGRESS",
    basisSnapshotId: "v1",
  })];
  const result = run([v1, v2], "v2", operations);
  const object = result.objects.get("EntityA:A-1");
  assert.equal(object.properties.name, "alpha renamed");
  assert.equal(object.properties.status, "IN_PROGRESS");
  assert.equal(object.conflictState, null);
});

test("reports same-property base change and keeps overlay visible", () => {
  const v2 = snapshot("v2", [
    entity("A-1", { name: "alpha", status: "CLOSED", owner: "u1" }),
  ]);
  const operations = [operation({
    seq: 1,
    type: "SET_PROPERTY",
    primaryKey: "A-1",
    propertyName: "status",
    value: "IN_PROGRESS",
    basisSnapshotId: "v1",
  })];
  const result = run([v1, v2], "v2", operations);
  const object = result.objects.get("EntityA:A-1");
  assert.equal(object.properties.status, "IN_PROGRESS");
  assert.equal(object.conflictState, "BASE_CHANGED_UNDER_OVERRIDE");
  assert.deepEqual(object.conflicts[0], {
    type: "BASE_CHANGED_UNDER_OVERRIDE",
    propertyName: "status",
    basisSnapshotId: "v1",
    basisValue: "OPEN",
    incomingValue: "CLOSED",
    overlayValue: "IN_PROGRESS",
    operationSeq: 1,
  });
});

test("retains an orphan with overlay and removes a clean missing base object", () => {
  const v2 = snapshot("v2", [entity("A-3", { name: "gamma", status: "OPEN", owner: "u3" })]);
  const operations = [operation({
    seq: 1,
    type: "SET_PROPERTY",
    primaryKey: "A-1",
    propertyName: "status",
    value: "IN_PROGRESS",
    basisSnapshotId: "v1",
  })];
  const result = run([v1, v2], "v2", operations);
  const orphan = result.objects.get("EntityA:A-1");
  assert.equal(orphan.lifecycleState, "source_removed");
  assert.equal(orphan.conflictState, "BASE_OBJECT_REMOVED");
  assert.equal(orphan.properties.name, "alpha");
  assert.equal(orphan.properties.status, "IN_PROGRESS");
  assert.equal(result.objects.has("EntityA:A-2"), false);
});

test("distinguishes clear from remove override", () => {
  const operations = [
    operation({
      seq: 1,
      type: "CLEAR_PROPERTY",
      primaryKey: "A-1",
      propertyName: "owner",
      basisSnapshotId: "v1",
    }),
  ];
  const cleared = run([v1], "v1", operations);
  assert.equal(cleared.objects.get("EntityA:A-1").properties.owner, null);

  const removed = run([v1], "v1", [
    ...operations,
    operation({
      seq: 2,
      type: "REMOVE_OVERRIDE",
      primaryKey: "A-1",
      propertyName: "owner",
      basisSnapshotId: "v1",
    }),
  ]);
  assert.equal(removed.objects.get("EntityA:A-1").properties.owner, "u1");
});

test("tombstone remains hidden across base changes and restore reads latest base", () => {
  const v2 = snapshot("v2", [entity("A-1", { name: "new alpha", status: "CLOSED", owner: "u9" })]);
  const tombstoned = run([v1, v2], "v2", [
    operation({ seq: 1, type: "TOMBSTONE_OBJECT", primaryKey: "A-1", basisSnapshotId: "v1" }),
  ]);
  assert.equal(tombstoned.objects.get("EntityA:A-1").lifecycleState, "tombstoned");
  assert.equal(tombstoned.objects.get("EntityA:A-1").conflictState, null);

  const restored = run([v1, v2], "v2", [
    operation({ seq: 1, type: "TOMBSTONE_OBJECT", primaryKey: "A-1", basisSnapshotId: "v1" }),
    operation({ seq: 2, type: "RESTORE_OBJECT", primaryKey: "A-1", basisSnapshotId: "v2" }),
  ]);
  assert.equal(restored.objects.get("EntityA:A-1").lifecycleState, "active");
  assert.equal(restored.objects.get("EntityA:A-1").properties.name, "new alpha");
});

test("overlay-created object becomes identity collision when base later supplies key", () => {
  const empty = snapshot("empty", []);
  const v2 = snapshot("v2", [entity("A-9", { name: "source", status: "OPEN" })]);
  const operations = [operation({
    seq: 1,
    type: "CREATE_OBJECT",
    primaryKey: "A-9",
    value: { name: "operator", status: "IN_PROGRESS" },
    basisSnapshotId: "empty",
  })];

  const initial = run([empty], "empty", operations);
  assert.equal(initial.objects.get("EntityA:A-9").conflictState, null);

  const collision = materializeReference({
    snapshots: new Map([["empty", empty], ["v2", v2]]),
    incomingSnapshotId: "v2",
    operations,
    watermark: 1,
    previousProjection: initial.objects,
  });
  assert.equal(collision.objects.get("EntityA:A-9").conflictState, "IDENTITY_COLLISION");
  assert.equal(collision.objects.get("EntityA:A-9").properties.name, "operator");
});

test("high-watermark catch-up includes operations committed during staging", () => {
  const v2 = snapshot("v2", [
    entity("A-1", { name: "alpha", status: "OPEN", owner: "u1" }),
    entity("A-2", { name: "beta", status: "OPEN", owner: "u2" }),
  ]);
  const operations = [
    operation({ seq: 1, type: "SET_PROPERTY", primaryKey: "A-1", propertyName: "status", value: "IN_PROGRESS", basisSnapshotId: "v1" }),
    operation({ seq: 2, type: "SET_PROPERTY", primaryKey: "A-2", propertyName: "owner", value: "u9", basisSnapshotId: "v1" }),
  ];
  const snapshots = new Map([["v1", v1], ["v2", v2]]);
  const staged = materializeReference({ snapshots, incomingSnapshotId: "v2", operations, watermark: 1 });
  assert.equal(staged.objects.get("EntityA:A-2").properties.owner, "u2");

  const caughtUp = catchUpReference({ staged, snapshots, operations, watermark: 2 });
  assert.equal(caughtUp.objects.get("EntityA:A-1").properties.status, "IN_PROGRESS");
  assert.equal(caughtUp.objects.get("EntityA:A-2").properties.owner, "u9");
  assert.equal(caughtUp.overlayWatermark, 2);
});

test("does not increment business version for provenance-only snapshot change", () => {
  const v2 = snapshot("v2", [
    entity("A-1", { name: "alpha", status: "OPEN", owner: "u1" }),
    entity("A-2", { name: "beta", status: "OPEN", owner: "u2" }),
    entity("A-3", { name: "gamma", status: "OPEN", owner: "u3" }),
  ]);
  const first = run([v1], "v1", []);
  const second = materializeReference({
    snapshots: new Map([["v1", v1], ["v2", v2]]),
    incomingSnapshotId: "v2",
    operations: [],
    previousProjection: first.objects,
  });
  assert.equal(first.objects.get("EntityA:A-1").objectVersion, 1);
  assert.equal(second.objects.get("EntityA:A-1").objectVersion, 1);
  assert.equal(second.objects.get("EntityA:A-1").provenance.name.snapshotId, "v2");
});

function run(snapshotList, incomingSnapshotId, operations) {
  return materializeReference({
    snapshots: new Map(snapshotList.map((item) => [item.id, item])),
    incomingSnapshotId,
    operations,
    watermark: operations.at(-1)?.seq ?? 0,
  });
}

function entity(primaryKey, properties) {
  return { objectType: "EntityA", primaryKey, properties };
}

