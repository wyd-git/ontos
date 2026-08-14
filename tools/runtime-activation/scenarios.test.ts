import assert from "node:assert/strict";
import test from "node:test";

import {
  createActivation,
  createVersion,
  firstMember,
  fixtureChannel,
  fixtureMemberKeys,
  fixtureProjectId,
  publishFixtureRelease,
  registerGenerationMembers,
  registerRelease,
  registerSnapshotGroup,
  runtimePolicy,
} from "./fixtures.ts";
import {
  DAY_IN_MS,
  RuntimeActivationModel,
  RuntimeModelError,
  type ActivationMember,
} from "./model.ts";

void test("R1 publish atomically binds Channel and explicit Serving Head to one Activation", () => {
  const model = new RuntimeActivationModel();
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  const s1 = createVersion(model, { label: "s1-r1", releaseId: "r1", at: 0 });

  publishFixtureRelease(model, "r1", s1.activationId, 0);

  assert.deepEqual(
    model.resolve(channelSelector()),
    model.resolve({ kind: "release", releaseId: "r1" }),
  );
  assert.equal(model.resolve(channelSelector()).activationId, s1.activationId);
  model.assertInvariants(0);
});

void test("a metadata-only R1 stays immutable while R2 adds the first runtime member plan", () => {
  const model = new RuntimeActivationModel();
  registerRelease(model, {
    id: "r1-metadata-only",
    schemaHash: "unused",
    mappingHash: "unused",
    pins: [],
  });
  createActivation(model, {
    id: "a0-r1-empty",
    releaseId: "r1-metadata-only",
    members: {},
    at: 0,
  });
  publishFixtureRelease(model, "r1-metadata-only", "a0-r1-empty", 0);

  const r1Before = model.snapshot().releases["r1-metadata-only"];
  const a0Before = model.snapshot().activations["a0-r1-empty"];
  assert.ok(r1Before);
  assert.ok(a0Before);

  registerRelease(model, { id: "r2-runtime", schemaHash: "schema-2", mappingHash: "mapping-2" });
  const r2s1 = createVersion(model, { label: "r2-s1", releaseId: "r2-runtime", at: 1 });
  publishFixtureRelease(model, "r2-runtime", r2s1.activationId, 1);

  const r2BeforeRefresh = structuredClone(model.snapshot().releases["r2-runtime"]);
  const r2s1BeforeRefresh = structuredClone(model.snapshot().activations[r2s1.activationId]);
  const r2s2 = createVersion(model, { label: "r2-s2", releaseId: "r2-runtime", at: 2 });

  registerRelease(model, { id: "r3-concurrent", schemaHash: "schema-3", mappingHash: "mapping-3" });
  const r3s1 = createVersion(model, { label: "r3-s1", releaseId: "r3-concurrent", at: 2 });
  const plannedRevision = model.controlRevision;

  model.refresh({
    replacements: [{ releaseId: "r2-runtime", activationId: r2s2.activationId }],
    expectedControlRevision: plannedRevision,
    at: 3,
  });
  assertRuntimeError(
    () =>
      model.publish({
        releaseId: "r3-concurrent",
        channel: fixtureChannel,
        activationId: r3s1.activationId,
        expectedControlRevision: plannedRevision,
        at: 3,
        supportUntil: 90 * DAY_IN_MS,
      }),
    "CONCURRENT_MODIFICATION",
  );
  publishFixtureRelease(model, "r3-concurrent", r3s1.activationId, 4);

  const after = model.snapshot();
  assert.deepEqual(after.releases["r1-metadata-only"]?.pins, r1Before.pins);
  assert.equal(after.releases["r1-metadata-only"]?.manifestHash, r1Before.manifestHash);
  assert.deepEqual(after.activations["a0-r1-empty"]?.members, a0Before.members);
  assert.equal(after.activations["a0-r1-empty"]?.releaseManifestHash, a0Before.releaseManifestHash);
  assert.deepEqual(after.releases["r2-runtime"]?.pins, r2BeforeRefresh?.pins);
  assert.equal(after.releases["r2-runtime"]?.manifestHash, r2BeforeRefresh?.manifestHash);
  assert.deepEqual(after.activations[r2s1.activationId]?.members, r2s1BeforeRefresh?.members);
  assert.equal(
    model.resolve({ kind: "release", releaseId: "r1-metadata-only" }).activationId,
    "a0-r1-empty",
  );
  assert.equal(
    model.resolve({ kind: "release", releaseId: "r2-runtime" }).activationId,
    r2s2.activationId,
  );
  assert.equal(model.resolve(channelSelector()).releaseId, "r3-concurrent");
  model.assertInvariants(4);
});

void test("compatible R1/R2 pins reuse the same certified Generation without crossing manifests", () => {
  const model = new RuntimeActivationModel();
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  registerRelease(model, { id: "r2", schemaHash: "schema-1", mappingHash: "mapping-2" });
  const snapshots = registerSnapshotGroup(model, "s1-compatible", 0);
  const sharedMembers = registerGenerationMembers(model, {
    label: "s1-compatible",
    snapshots,
    buildReleaseId: "r2",
    compatibleReleaseIds: ["r1"],
    at: 0,
  });
  createActivation(model, { id: "a-r1-s1", releaseId: "r1", members: sharedMembers, at: 0 });
  createActivation(model, { id: "a-r2-s1", releaseId: "r2", members: sharedMembers, at: 0 });

  publishFixtureRelease(model, "r1", "a-r1-s1", 0);
  publishFixtureRelease(model, "r2", "a-r2-s1", 1);

  assert.equal(
    firstMember(model.snapshot().activations["a-r1-s1"]?.members ?? {}).generationId,
    firstMember(model.snapshot().activations["a-r2-s1"]?.members ?? {}).generationId,
  );
  assert.equal(model.resolve(channelSelector()).releaseId, "r2");
  assert.equal(model.resolve({ kind: "release", releaseId: "r1" }).releaseId, "r1");
  model.assertInvariants(1);
});

void test("data-only S2 refresh replaces compatible R1/R2 Serving Heads in one cutover", () => {
  const model = compatibleTwoReleaseModel();
  const snapshots = registerSnapshotGroup(model, "s2-compatible", 10);
  const sharedMembers = registerGenerationMembers(model, {
    label: "s2-compatible",
    snapshots,
    buildReleaseId: "r2",
    compatibleReleaseIds: ["r1"],
    at: 10,
  });
  createActivation(model, { id: "a-r1-s2", releaseId: "r1", members: sharedMembers, at: 10 });
  createActivation(model, { id: "a-r2-s2", releaseId: "r2", members: sharedMembers, at: 10 });

  model.refresh({
    replacements: [
      { releaseId: "r1", activationId: "a-r1-s2" },
      { releaseId: "r2", activationId: "a-r2-s2" },
    ],
    expectedControlRevision: model.controlRevision,
    at: 10,
  });

  assert.equal(model.resolve({ kind: "release", releaseId: "r1" }).activationId, "a-r1-s2");
  assert.equal(model.resolve({ kind: "release", releaseId: "r2" }).activationId, "a-r2-s2");
  assert.equal(model.resolve(channelSelector()).activationId, "a-r2-s2");
  model.assertInvariants(10);
});

void test("incompatible Mapping rejects reuse and requires a Release-specific Generation", () => {
  const model = new RuntimeActivationModel();
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  registerRelease(model, { id: "r2", schemaHash: "schema-2", mappingHash: "mapping-2-breaking" });
  const r1 = createVersion(model, { label: "s1-r1", releaseId: "r1", at: 0 });

  assertRuntimeError(
    () => createActivation(model, { id: "bad-r2", releaseId: "r2", members: r1.members, at: 1 }),
    "PIN_GENERATION_MISMATCH",
  );

  const r2 = createVersion(model, { label: "s1-r2", releaseId: "r2", at: 1 });
  publishFixtureRelease(model, "r1", r1.activationId, 0);
  publishFixtureRelease(model, "r2", r2.activationId, 1);
  assert.notEqual(firstMember(r1.members).generationId, firstMember(r2.members).generationId);
  model.assertInvariants(1);
});

void test("a Snapshot Group cannot mix S1 and S2 members", () => {
  const model = new RuntimeActivationModel();
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  const s1 = createVersion(model, { label: "s1", releaseId: "r1", at: 0 });
  const s2 = createVersion(model, { label: "s2", releaseId: "r1", at: 1 });
  const mixed: Record<string, ActivationMember> = {
    [fixtureMemberKeys[0]]: required(s1.members, fixtureMemberKeys[0]),
    [fixtureMemberKeys[1]]: required(s2.members, fixtureMemberKeys[1]),
  };

  assertRuntimeError(
    () => createActivation(model, { id: "mixed", releaseId: "r1", members: mixed, at: 2 }),
    "SNAPSHOT_GROUP_MISMATCH",
  );
});

void test("concurrent Publish and Refresh use control CAS; retry cannot move Channel back", () => {
  const model = new RuntimeActivationModel();
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  const r1s1 = createVersion(model, { label: "r1-s1", releaseId: "r1", at: 0 });
  publishFixtureRelease(model, "r1", r1s1.activationId, 0);

  registerRelease(model, { id: "r2", schemaHash: "schema-2", mappingHash: "mapping-2" });
  const r2s1 = createVersion(model, { label: "r2-s1", releaseId: "r2", at: 1 });
  const r1s2 = createVersion(model, { label: "r1-s2", releaseId: "r1", at: 1 });
  const plannedRevision = model.controlRevision;

  model.refresh({
    replacements: [{ releaseId: "r1", activationId: r1s2.activationId }],
    expectedControlRevision: plannedRevision,
    at: 2,
  });
  assertRuntimeError(
    () =>
      model.publish({
        releaseId: "r2",
        channel: fixtureChannel,
        activationId: r2s1.activationId,
        expectedControlRevision: plannedRevision,
        at: 2,
        supportUntil: 90 * DAY_IN_MS,
      }),
    "CONCURRENT_MODIFICATION",
  );

  publishFixtureRelease(model, "r2", r2s1.activationId, 3);
  assert.equal(model.resolve(channelSelector()).releaseId, "r2");
  assert.equal(model.resolve({ kind: "release", releaseId: "r1" }).activationId, r1s2.activationId);
  model.assertInvariants(3);
});

void test("an in-flight Query resolves Activation exactly once across Refresh", () => {
  const model = new RuntimeActivationModel();
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  const s1 = createVersion(model, { label: "s1", releaseId: "r1", at: 0 });
  publishFixtureRelease(model, "r1", s1.activationId, 0);
  const resolved = model.beginQuery({
    id: "query-1",
    selector: channelSelector(),
    startedAt: 1,
    leaseUntil: 1_001,
  });

  const s2 = createVersion(model, { label: "s2", releaseId: "r1", at: 2 });
  model.refresh({
    replacements: [{ releaseId: "r1", activationId: s2.activationId }],
    expectedControlRevision: model.controlRevision,
    at: 3,
  });

  assert.equal(resolved.activationId, s1.activationId);
  assert.deepEqual(
    model.readQueryMember("query-1", fixtureMemberKeys[0], 4),
    required(s1.members, fixtureMemberKeys[0]),
  );
  assert.equal(model.snapshot().queries["query-1"]?.resolutionCount, 1);
  model.assertInvariants(4);
});

void test("Preflight bound to S1 becomes PREFLIGHT_STALE after S2 cutover", () => {
  const model = new RuntimeActivationModel();
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  const s1 = createVersion(model, { label: "s1", releaseId: "r1", at: 0 });
  publishFixtureRelease(model, "r1", s1.activationId, 0);
  model.issuePreflight({
    id: "token-1",
    selector: channelSelector(),
    issuedAt: 1,
    expiresAt: 10_001,
  });

  const s2 = createVersion(model, { label: "s2", releaseId: "r1", at: 2 });
  model.refresh({
    replacements: [{ releaseId: "r1", activationId: s2.activationId }],
    expectedControlRevision: model.controlRevision,
    at: 3,
  });

  assertRuntimeError(() => model.applyPreflight("token-1", 4), "PREFLIGHT_STALE");
  assert.equal(model.snapshot().preflightTokens["token-1"]?.state, "STALE");
  model.assertInvariants(4);
});

void test("Rollback publishes R3 from historical R1 pins and never rewinds old pointers", () => {
  const model = new RuntimeActivationModel();
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  const r1 = createVersion(model, { label: "r1-s1", releaseId: "r1", at: 0 });
  publishFixtureRelease(model, "r1", r1.activationId, 0);
  registerRelease(model, { id: "r2", schemaHash: "schema-2", mappingHash: "mapping-2" });
  const r2 = createVersion(model, { label: "r2-s1", releaseId: "r2", at: 1 });
  publishFixtureRelease(model, "r2", r2.activationId, 1);
  model.addHistoricalReference("action-on-r2", { releaseIds: ["r2"] });

  const r1Pins = Object.values(required(model.snapshot().releases, "r1").pins);
  registerRelease(model, {
    id: "r3",
    schemaHash: "unused",
    mappingHash: "unused",
    rollbackOf: "r1",
    pins: r1Pins,
    stagedAt: 2,
  });
  const r3 = createVersion(model, { label: "r3-s1", releaseId: "r3", at: 2 });
  publishFixtureRelease(model, "r3", r3.activationId, 3);

  assert.equal(model.resolve(channelSelector()).releaseId, "r3");
  assert.equal(model.resolve({ kind: "release", releaseId: "r1" }).releaseId, "r1");
  assert.equal(model.resolve({ kind: "release", releaseId: "r2" }).releaseId, "r2");
  assert.equal(model.snapshot().releases["r3"]?.rollbackOf, "r1");
  model.assertInvariants(3);
});

void test("Release retirement preserves the 90-day promise and returns RELEASE_RETIRED", () => {
  const model = new RuntimeActivationModel();
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  const r1 = createVersion(model, { label: "r1-s1", releaseId: "r1", at: 0 });
  publishFixtureRelease(model, "r1", r1.activationId, 0);
  registerRelease(model, { id: "r2", schemaHash: "schema-2", mappingHash: "mapping-2" });
  const r2 = createVersion(model, { label: "r2-s1", releaseId: "r2", at: DAY_IN_MS });
  publishFixtureRelease(model, "r2", r2.activationId, DAY_IN_MS);

  assertRuntimeError(
    () => model.retireRelease("r1", model.controlRevision, 90 * DAY_IN_MS - 1),
    "SUPPORT_WINDOW_ACTIVE",
  );
  model.retireRelease("r1", model.controlRevision, 90 * DAY_IN_MS);
  assertRuntimeError(() => model.resolve({ kind: "release", releaseId: "r1" }), "RELEASE_RETIRED");
  model.assertInvariants(90 * DAY_IN_MS);
});

void test("temporary capacity approval is bounded and cannot cross the hard limit", () => {
  const model = new RuntimeActivationModel(
    runtimePolicy({
      normalMaxServingReleases: 1,
      hardMaxServingReleases: 2,
      normalMaxServingGenerationsPerMember: 1,
      hardMaxServingGenerationsPerMember: 2,
    }),
  );
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  const r1 = createVersion(model, { label: "r1-s1", releaseId: "r1", at: 0 });
  publishFixtureRelease(model, "r1", r1.activationId, 0);
  registerRelease(model, { id: "r2", schemaHash: "schema-2", mappingHash: "mapping-2" });
  const r2 = createVersion(model, { label: "r2-s1", releaseId: "r2", at: 70 * DAY_IN_MS });

  assertRuntimeError(
    () => publishFixtureRelease(model, "r2", r2.activationId, 70 * DAY_IN_MS),
    "CAPACITY_SOFT_LIMIT",
  );
  model.registerCapacityApproval({
    id: "approval-1",
    projectId: fixtureProjectId,
    approvedAt: 70 * DAY_IN_MS,
    expiresAt: 90 * DAY_IN_MS + 1,
    maximumServingReleases: 2,
    maximumServingGenerationsPerMember: 2,
    retirementReleaseIds: ["r1"],
  });
  publishFixtureRelease(model, "r2", r2.activationId, 70 * DAY_IN_MS, "approval-1");

  registerRelease(model, { id: "r3", schemaHash: "schema-3", mappingHash: "mapping-3" });
  const r3 = createVersion(model, { label: "r3-s1", releaseId: "r3", at: 71 * DAY_IN_MS });
  assertRuntimeError(
    () =>
      model.publish({
        releaseId: "r3",
        channel: fixtureChannel,
        activationId: r3.activationId,
        expectedControlRevision: model.controlRevision,
        at: 71 * DAY_IN_MS,
        supportUntil: 161 * DAY_IN_MS,
        capacityApprovalId: "approval-1",
      }),
    "CAPACITY_HARD_LIMIT",
  );

  model.retireRelease("r1", model.controlRevision, 90 * DAY_IN_MS);
  assert.equal(model.capacity(fixtureProjectId).servingReleases, 1);
  model.assertInvariants(90 * DAY_IN_MS);
});

void test("GC protects Serving Head, valid Token, active Job, Hold and in-flight Query", () => {
  const model = new RuntimeActivationModel(
    runtimePolicy({
      inactiveGenerationRetentionCount: 1,
      minimumInactiveRetentionMs: DAY_IN_MS,
      maximumPreflightTtlMs: 30 * DAY_IN_MS,
      maximumQueryLeaseMs: 30 * DAY_IN_MS,
    }),
  );
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  const orphan = createVersion(model, { label: "orphan-old", releaseId: "r1", at: 0 });
  createVersion(model, { label: "orphan-retained", releaseId: "r1", at: 0.5 });
  const s0 = createVersion(model, { label: "s0", releaseId: "r1", at: 1 });
  publishFixtureRelease(model, "r1", s0.activationId, 1);
  model.issuePreflight({
    id: "token-s0",
    selector: channelSelector(),
    issuedAt: 2,
    expiresAt: 20 * DAY_IN_MS,
  });

  const s1 = refreshOne(model, "s1", 3);
  model.startJob("job-s1", { activationIds: [s1.activationId] });
  const s2 = refreshOne(model, "s2", 4);
  model.placeHold("hold-s2", { activationIds: [s2.activationId] }, "investigation");
  const s3 = refreshOne(model, "s3", 5);
  model.beginQuery({
    id: "query-s3",
    selector: channelSelector(),
    startedAt: 6,
    leaseUntil: 20 * DAY_IN_MS,
  });
  const s4 = refreshOne(model, "s4", 7);

  const firstPlan = model.planGarbageCollection(10 * DAY_IN_MS);
  for (const protectedActivation of [
    s0.activationId,
    s1.activationId,
    s2.activationId,
    s3.activationId,
    s4.activationId,
  ]) {
    assert.equal(firstPlan.activationIds.includes(protectedActivation), false);
  }
  assert.equal(firstPlan.activationIds.includes(orphan.activationId), true);

  model.placeHold("late-hold", { activationIds: [orphan.activationId] }, "GC race");
  assertRuntimeError(() => model.commitGarbageCollection(firstPlan), "CONCURRENT_MODIFICATION");
  assert.equal(
    model.planGarbageCollection(10 * DAY_IN_MS).activationIds.includes(orphan.activationId),
    false,
  );

  model.releaseHold("late-hold");
  model.completeJob("job-s1");
  model.releaseHold("hold-s2");
  model.endQuery("query-s3");
  const finalPlan = model.planGarbageCollection(31 * DAY_IN_MS);
  model.commitGarbageCollection(finalPlan);

  assert.equal(model.resolve(channelSelector()).activationId, s4.activationId);
  assert.equal(model.snapshot().activations[s4.activationId]?.state, "READY");
  assert.equal(model.snapshot().activations[orphan.activationId]?.state, "COLLECTED");
  model.assertInvariants(31 * DAY_IN_MS);
});

void test("GC grace starts when old content leaves its Serving Head, not when it was created", () => {
  const model = new RuntimeActivationModel(
    runtimePolicy({
      inactiveGenerationRetentionCount: 1,
      minimumInactiveRetentionMs: 7 * DAY_IN_MS,
    }),
  );
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  const old = createVersion(model, { label: "old", releaseId: "r1", at: 0 });
  publishFixtureRelease(model, "r1", old.activationId, 0);
  refreshOne(model, "newer", 100 * DAY_IN_MS);
  refreshOne(model, "newest", 101 * DAY_IN_MS);

  const insideGrace = model.planGarbageCollection(106 * DAY_IN_MS);
  assert.equal(insideGrace.activationIds.includes(old.activationId), false);
  assert.equal(insideGrace.generationIds.includes(firstMember(old.members).generationId), false);

  const afterGrace = model.planGarbageCollection(108 * DAY_IN_MS);
  assert.equal(afterGrace.activationIds.includes(old.activationId), true);
  assert.equal(afterGrace.generationIds.includes(firstMember(old.members).generationId), true);
});

function compatibleTwoReleaseModel(): RuntimeActivationModel {
  const model = new RuntimeActivationModel();
  registerRelease(model, { id: "r1", schemaHash: "schema-1", mappingHash: "mapping-1" });
  registerRelease(model, { id: "r2", schemaHash: "schema-1", mappingHash: "mapping-2" });
  const snapshots = registerSnapshotGroup(model, "s1-compatible", 0);
  const members = registerGenerationMembers(model, {
    label: "s1-compatible",
    snapshots,
    buildReleaseId: "r2",
    compatibleReleaseIds: ["r1"],
    at: 0,
  });
  createActivation(model, { id: "a-r1-s1", releaseId: "r1", members, at: 0 });
  createActivation(model, { id: "a-r2-s1", releaseId: "r2", members, at: 0 });
  publishFixtureRelease(model, "r1", "a-r1-s1", 0);
  publishFixtureRelease(model, "r2", "a-r2-s1", 1);
  return model;
}

function refreshOne(
  model: RuntimeActivationModel,
  label: string,
  at: number,
): { activationId: string; members: Record<string, ActivationMember> } {
  const version = createVersion(model, { label, releaseId: "r1", at });
  model.refresh({
    replacements: [{ releaseId: "r1", activationId: version.activationId }],
    expectedControlRevision: model.controlRevision,
    at,
  });
  return version;
}

function channelSelector() {
  return { kind: "channel", projectId: fixtureProjectId, channel: fixtureChannel } as const;
}

function assertRuntimeError(operation: () => unknown, code: RuntimeModelError["code"]): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof RuntimeModelError && error.code === code,
  );
}

function required<T>(record: Readonly<Record<string, T>>, key: string): T {
  const value = record[key];
  if (value === undefined) throw new Error(`Test value ${key} is missing.`);
  return value;
}
