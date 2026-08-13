import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import {
  createActivation,
  createVersion,
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
  RuntimeActivationModel,
  RuntimeModelError,
  releasePinFingerprint,
  type RuntimeState,
} from "./model.ts";

const propertyParameters = { numRuns: 200, seed: 20_260_813 } as const;

void test("property: one Query keeps its first Activation through arbitrary Refresh counts", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 30 }),
      fc.array(fc.constantFrom(...fixtureMemberKeys), { minLength: 1, maxLength: 60 }),
      (refreshCount, reads) => {
        const model = new RuntimeActivationModel();
        registerRelease(model, {
          id: "r1",
          schemaHash: "schema-1",
          mappingHash: "mapping-1",
        });
        const initial = createVersion(model, { label: "s0", releaseId: "r1", at: 0 });
        publishFixtureRelease(model, "r1", initial.activationId, 0);
        const resolved = model.beginQuery({
          id: "query",
          selector: channelSelector(),
          startedAt: 1,
          leaseUntil: 299_999,
        });

        for (let index = 0; index < refreshCount; index += 1) {
          const at = index + 2;
          const version = createVersion(model, {
            label: `s${index + 1}`,
            releaseId: "r1",
            at,
          });
          model.refresh({
            replacements: [{ releaseId: "r1", activationId: version.activationId }],
            expectedControlRevision: model.controlRevision,
            at,
          });
          const memberKey = reads[index % reads.length];
          if (memberKey === undefined) throw new Error("Property read key is missing.");
          assert.deepEqual(
            model.readQueryMember("query", memberKey, at),
            required(initial.members, memberKey),
          );
          assert.equal(model.snapshot().queries.query?.resolutionCount, 1);
          assert.equal(resolved.activationId, initial.activationId);
          model.assertInvariants(at);
        }
      },
    ),
    propertyParameters,
  );
});

void test("property: a Generation is usable only for Release pins covered by an exact proof", () => {
  const definition = fc.record({
    schemaHash: fc.constantFrom("schema-a", "schema-b", "schema-c"),
    mappingHash: fc.constantFrom("mapping-a", "mapping-b", "mapping-c"),
  });

  fc.assert(
    fc.property(
      fc.array(definition, { minLength: 2, maxLength: 7 }),
      fc.nat(),
      fc.nat(),
      fc.boolean(),
      (definitions, buildSeed, targetSeed, certifyTarget) => {
        const buildIndex = buildSeed % definitions.length;
        let targetIndex = targetSeed % definitions.length;
        if (targetIndex === buildIndex) targetIndex = (targetIndex + 1) % definitions.length;
        const buildReleaseId = `r${buildIndex}`;
        const targetReleaseId = `r${targetIndex}`;
        const model = new RuntimeActivationModel();

        definitions.forEach((item, index) => {
          registerRelease(model, {
            id: `r${index}`,
            schemaHash: item.schemaHash,
            mappingHash: item.mappingHash,
          });
        });
        const snapshots = registerSnapshotGroup(model, "snapshot", 0);
        const members = registerGenerationMembers(model, {
          label: "generation",
          snapshots,
          buildReleaseId,
          compatibleReleaseIds: certifyTarget ? [targetReleaseId] : [],
          at: 0,
        });

        if (certifyTarget) {
          createActivation(model, {
            id: "target-activation",
            releaseId: targetReleaseId,
            members,
            at: 1,
          });
          assertIndependentPinBindings(model.snapshot());
          model.assertInvariants(1);
        } else {
          assert.throws(
            () =>
              createActivation(model, {
                id: "target-activation",
                releaseId: targetReleaseId,
                members,
                at: 1,
              }),
            (error: unknown) =>
              error instanceof RuntimeModelError && error.code === "PIN_GENERATION_MISMATCH",
          );
        }
      },
    ),
    propertyParameters,
  );
});

void test("property: arbitrary control/reference/GC sequences preserve all runtime invariants", () => {
  const eventArbitrary = fc.constantFrom(
    "refresh",
    "begin-query",
    "end-query",
    "issue-token",
    "apply-token",
    "start-job",
    "complete-job",
    "place-hold",
    "release-hold",
    "gc",
    "stale-control",
  );

  fc.assert(
    fc.property(fc.array(eventArbitrary, { minLength: 1, maxLength: 80 }), (events) => {
      const model = new RuntimeActivationModel(
        runtimePolicy({
          inactiveGenerationRetentionCount: 1,
          minimumInactiveRetentionMs: 1,
        }),
      );
      registerRelease(model, {
        id: "r1",
        schemaHash: "schema-1",
        mappingHash: "mapping-1",
      });
      const initial = createVersion(model, { label: "initial", releaseId: "r1", at: 0 });
      publishFixtureRelease(model, "r1", initial.activationId, 0);

      let serial = 0;
      let at = 1;
      for (const event of events) {
        serial += 1;
        at += 2;
        applyRandomEvent(model, event, serial, at);
        model.assertInvariants(at);
        assertIndependentPinBindings(model.snapshot());
      }
    }),
    propertyParameters,
  );
});

function applyRandomEvent(
  model: RuntimeActivationModel,
  event: string,
  serial: number,
  at: number,
): void {
  if (event === "refresh") {
    const version = createVersion(model, { label: `refresh-${serial}`, releaseId: "r1", at });
    model.refresh({
      replacements: [{ releaseId: "r1", activationId: version.activationId }],
      expectedControlRevision: model.controlRevision,
      at,
    });
    return;
  }

  if (event === "begin-query") {
    model.beginQuery({
      id: `query-${serial}`,
      selector: channelSelector(),
      startedAt: at,
      leaseUntil: at + 1_000,
    });
    return;
  }
  if (event === "end-query") {
    const query = Object.values(model.snapshot().queries).find((item) => item.state === "ACTIVE");
    if (query !== undefined) model.endQuery(query.id);
    return;
  }

  if (event === "issue-token") {
    model.issuePreflight({
      id: `token-${serial}`,
      selector: channelSelector(),
      issuedAt: at,
      expiresAt: at + 1_000,
    });
    return;
  }
  if (event === "apply-token") {
    const token = Object.values(model.snapshot().preflightTokens).find(
      (item) => item.state === "ACTIVE" && item.expiresAt > at,
    );
    if (token !== undefined) {
      try {
        model.applyPreflight(token.id, at);
      } catch (error) {
        if (!(error instanceof RuntimeModelError) || error.code !== "PREFLIGHT_STALE") throw error;
      }
    }
    return;
  }

  if (event === "start-job") {
    model.startJob(`job-${serial}`, {
      activationIds: [model.resolve(channelSelector()).activationId],
    });
    return;
  }
  if (event === "complete-job") {
    const job = Object.values(model.snapshot().jobs).find((item) => item.state === "ACTIVE");
    if (job !== undefined) model.completeJob(job.id);
    return;
  }

  if (event === "place-hold") {
    model.placeHold(
      `hold-${serial}`,
      { activationIds: [model.resolve(channelSelector()).activationId] },
      "property sequence",
    );
    return;
  }
  if (event === "release-hold") {
    const hold = Object.values(model.snapshot().holds).find((item) => item.state === "ACTIVE");
    if (hold !== undefined) model.releaseHold(hold.id);
    return;
  }

  if (event === "gc") {
    model.commitGarbageCollection(model.planGarbageCollection(at));
    return;
  }

  if (event === "stale-control") {
    const before = model.snapshot();
    assert.throws(
      () =>
        model.refresh({
          replacements: [
            {
              releaseId: "r1",
              activationId: model.resolve({ kind: "release", releaseId: "r1" }).activationId,
            },
          ],
          expectedControlRevision: model.controlRevision - 1,
          at,
        }),
      (error: unknown) =>
        error instanceof RuntimeModelError && error.code === "CONCURRENT_MODIFICATION",
    );
    assert.deepEqual(model.snapshot(), before);
    return;
  }

  throw new Error(`Unknown property event ${event}.`);
}

function assertIndependentPinBindings(state: RuntimeState): void {
  for (const activation of Object.values(state.activations)) {
    if (activation.state !== "READY") continue;
    const release = required(state.releases, activation.releaseId);
    for (const [memberKey, member] of Object.entries(activation.members)) {
      const pin = required(release.pins, memberKey);
      const generation = required(state.generations, member.generationId);
      const proof = required(generation.compatibilityByPin, releasePinFingerprint(pin));
      assert.equal(proof.schemaHash, pin.schemaHash);
      assert.equal(proof.mappingHash, pin.mappingHash);
      assert.equal(proof.pinFingerprint, releasePinFingerprint(pin));
    }
  }
  for (const query of Object.values(state.queries)) assert.equal(query.resolutionCount, 1);
}

function channelSelector() {
  return { kind: "channel", projectId: fixtureProjectId, channel: fixtureChannel } as const;
}

function required<T>(record: Readonly<Record<string, T>>, key: string): T {
  const value = record[key];
  if (value === undefined) throw new Error(`Property value ${key} is missing.`);
  return value;
}
