import assert from "node:assert/strict";
import test from "node:test";

import {
  SnapshotGroupCutoverCoordinator,
  SnapshotGroupCutoverError,
  type SnapshotGroupCutoverPreparation,
  type SnapshotGroupCutoverRepository,
} from "@ontos/materialization-application";

const projectId = "00000000-0000-4000-8000-000000000001";
const snapshotGroupId = "00000000-0000-4000-8000-000000000002";
const preparationId = "00000000-0000-4000-8000-000000000003";

void test("cutover accepts a strict command and forwards certified zero evidence", async () => {
  let prepared: SnapshotGroupCutoverPreparation | undefined;
  const repository = fixtureRepository({
    onPrepare(value) {
      prepared = value;
    },
  });
  const result = await new SnapshotGroupCutoverCoordinator(repository).activate(command());
  assert.equal(prepared?.overlayEvidence.providerId, "ontos.zero-overlay");
  assert.equal(prepared?.overlayEvidence.watermark, 0);
  assert.equal(result.preparationId, preparationId);
  assert.equal(result.controlRevision, 8n);
});

void test("cutover rejects unknown fields, unsafe revisions and short idempotency keys", async () => {
  const coordinator = new SnapshotGroupCutoverCoordinator(fixtureRepository());
  for (const invalid of [
    { ...command(), unexpected: true },
    { ...command(), expectedControlRevision: 7 },
    { ...command(), idempotencyKey: "short" },
    { ...command(), groupVersion: 0 },
  ]) {
    await assert.rejects(
      coordinator.activate(invalid),
      (error: unknown) =>
        error instanceof SnapshotGroupCutoverError && error.code === "CUTOVER_INPUT_INVALID",
    );
  }
});

void test("repository result must remain bound to the exact command and evidence", async () => {
  const repository = fixtureRepository({
    mutatePreparation(value) {
      return { ...value, snapshotGroupId: "00000000-0000-4000-8000-000000000099" };
    },
  });
  await assert.rejects(
    new SnapshotGroupCutoverCoordinator(repository).activate(command()),
    (error: unknown) =>
      error instanceof SnapshotGroupCutoverError && error.code === "CUTOVER_DEPENDENCY_UNAVAILABLE",
  );
});

function command() {
  return {
    projectId,
    snapshotGroupId,
    groupVersion: 2,
    expectedControlRevision: "7",
    idempotencyKey: "cutover-fixture-0001",
  } as const;
}

function fixtureRepository(
  options: {
    readonly onPrepare?: (value: SnapshotGroupCutoverPreparation) => void;
    readonly mutatePreparation?: (
      value: SnapshotGroupCutoverPreparation,
    ) => SnapshotGroupCutoverPreparation;
  } = {},
): SnapshotGroupCutoverRepository {
  return {
    prepareSnapshotGroupCutover(input) {
      const value: SnapshotGroupCutoverPreparation = Object.freeze({
        preparationId,
        projectId: input.command.projectId,
        snapshotGroupId: input.command.snapshotGroupId,
        groupVersion: input.command.groupVersion,
        expectedControlRevision: input.command.expectedControlRevision,
        expectedStateRevision: 3n,
        expectedInventoryRevision: 5n,
        releaseCount: 1,
        memberCount: 2,
        objectHeadCount: 1,
        overlayEvidence: input.overlayEvidence,
        reused: false,
      });
      const result = options.mutatePreparation?.(value) ?? value;
      options.onPrepare?.(result);
      return Promise.resolve(result);
    },
    commitSnapshotGroupCutover(input) {
      return Promise.resolve({
        preparationId: input.preparation.preparationId,
        projectId,
        snapshotGroupId,
        groupVersion: 2,
        controlRevision: 8n,
        stateRevision: 4n,
        inventoryRevision: 5n,
        changed: true,
        reused: false,
        insertedHeadCount: 1,
        updatedHeadCount: 0,
        repointedHeadCount: 0,
        releases: [],
      });
    },
  };
}
