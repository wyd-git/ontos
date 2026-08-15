import assert from "node:assert/strict";
import test from "node:test";

import {
  createActivation,
  createVersion,
  fixtureChannel,
  fixtureProjectId,
  publishFixtureRelease,
  registerRelease,
} from "../runtime-activation/fixtures.ts";
import {
  DAY_IN_MS,
  RuntimeActivationModel,
  RuntimeModelError,
} from "../runtime-activation/model.ts";

void test("R1/A0 remains immutable through R2 first members, R2 refresh and concurrent R3 publish", () => {
  const model = new RuntimeActivationModel();
  registerRelease(model, {
    id: "r1-metadata-only",
    schemaHash: "unused",
    mappingHash: "unused",
    pins: [],
  });
  createActivation(model, {
    id: "a0-empty",
    releaseId: "r1-metadata-only",
    members: {},
    at: 0,
  });
  publishFixtureRelease(model, "r1-metadata-only", "a0-empty", 0);
  const r1Published = structuredClone(model.snapshot().releases["r1-metadata-only"]);
  const a0Published = structuredClone(model.snapshot().activations["a0-empty"]);

  registerRelease(model, { id: "r2-members", schemaHash: "schema-2", mappingHash: "mapping-2" });
  const a1 = createVersion(model, { label: "r2-a1", releaseId: "r2-members", at: 1 });
  publishFixtureRelease(model, "r2-members", a1.activationId, 1);
  const r2Published = structuredClone(model.snapshot().releases["r2-members"]);
  const a1Published = structuredClone(model.snapshot().activations[a1.activationId]);

  const a2 = createVersion(model, { label: "r2-a2", releaseId: "r2-members", at: 2 });
  registerRelease(model, { id: "r3-concurrent", schemaHash: "schema-3", mappingHash: "mapping-3" });
  const r3 = createVersion(model, { label: "r3-a1", releaseId: "r3-concurrent", at: 2 });
  const sharedControlRevision = model.controlRevision;

  model.publish({
    releaseId: "r3-concurrent",
    channel: fixtureChannel,
    activationId: r3.activationId,
    expectedControlRevision: sharedControlRevision,
    at: 3,
    supportUntil: 3 + 90 * DAY_IN_MS,
  });
  assertRuntimeError(
    () =>
      model.refresh({
        replacements: [{ releaseId: "r2-members", activationId: a2.activationId }],
        expectedControlRevision: sharedControlRevision,
        at: 3,
      }),
    "CONCURRENT_MODIFICATION",
  );
  model.refresh({
    replacements: [{ releaseId: "r2-members", activationId: a2.activationId }],
    expectedControlRevision: model.controlRevision,
    at: 4,
  });

  const after = model.snapshot();
  assert.deepEqual(after.releases["r1-metadata-only"], r1Published);
  assert.deepEqual(after.activations["a0-empty"], a0Published);
  assert.deepEqual(after.releases["r2-members"]?.pins, r2Published?.pins);
  assert.equal(after.releases["r2-members"]?.manifestHash, r2Published?.manifestHash);
  assert.deepEqual(after.activations[a1.activationId]?.members, a1Published?.members);
  assert.equal(
    after.activations[a1.activationId]?.releaseManifestHash,
    a1Published?.releaseManifestHash,
  );
  assert.equal(after.activations[a1.activationId]?.createdAt, a1Published?.createdAt);
  assert.equal(after.activations[a1.activationId]?.state, a1Published?.state);
  assert.equal(
    model.resolve({ kind: "release", releaseId: "r2-members" }).activationId,
    a2.activationId,
  );
  assert.equal(
    model.resolve({ kind: "channel", projectId: fixtureProjectId, channel: fixtureChannel })
      .releaseId,
    "r3-concurrent",
  );
  model.assertInvariants(4);
});

void test("two Refresh plans from one control revision cannot silently overwrite each other", () => {
  const model = new RuntimeActivationModel();
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  const a1 = createVersion(model, { label: "a1", releaseId: "r1", at: 0 });
  publishFixtureRelease(model, "r1", a1.activationId, 0);
  const a2 = createVersion(model, { label: "a2", releaseId: "r1", at: 1 });
  const a3 = createVersion(model, { label: "a3", releaseId: "r1", at: 1 });
  const sharedControlRevision = model.controlRevision;

  model.refresh({
    replacements: [{ releaseId: "r1", activationId: a2.activationId }],
    expectedControlRevision: sharedControlRevision,
    at: 2,
  });
  assertRuntimeError(
    () =>
      model.refresh({
        replacements: [{ releaseId: "r1", activationId: a3.activationId }],
        expectedControlRevision: sharedControlRevision,
        at: 2,
      }),
    "CONCURRENT_MODIFICATION",
  );
  assert.equal(model.resolve({ kind: "release", releaseId: "r1" }).activationId, a2.activationId);
});

void test("a Cutover invalidates a GC plan made from the previous state revision", () => {
  const model = new RuntimeActivationModel();
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  const a1 = createVersion(model, { label: "gc-a1", releaseId: "r1", at: 0 });
  publishFixtureRelease(model, "r1", a1.activationId, 0);
  const a2 = createVersion(model, { label: "gc-a2", releaseId: "r1", at: 1 });
  const plan = model.planGarbageCollection(30 * DAY_IN_MS);
  const plannedStateRevision = plan.plannedAtStateRevision;

  model.refresh({
    replacements: [{ releaseId: "r1", activationId: a2.activationId }],
    expectedControlRevision: model.controlRevision,
    at: 2,
  });
  assert.ok(model.stateRevision > plannedStateRevision);
  assertRuntimeError(() => model.commitGarbageCollection(plan), "CONCURRENT_MODIFICATION");
  assert.equal(model.resolve({ kind: "release", releaseId: "r1" }).activationId, a2.activationId);
  model.assertInvariants(2);
});

function assertRuntimeError(action: () => unknown, code: string): void {
  assert.throws(action, (error) => error instanceof RuntimeModelError && error.code === code);
}
