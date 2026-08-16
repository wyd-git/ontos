import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseArtifactDigest, type ArtifactDigest } from "@ontos/contracts";
import {
  GarbageCollectionApplicationError,
  GarbageCollectionService,
  type GarbageCollectionBatchResult,
  type GarbageCollectionDryRunPersistence,
  type GarbageCollectionDryRunRecord,
  type GarbageCollectionObjectStore,
  type GarbageCollectionObjectVersion,
  type GarbageCollectionRepository,
} from "@ontos/materialization-application";
import type { GarbageCollectionInventorySnapshot } from "@ontos/materialization-domain";

const projectId = "10000000-0000-4000-8000-000000000001";
const runId = "10000000-0000-4000-8000-000000000002";
const planId = "10000000-0000-4000-8000-000000000003";
const generationId = "10000000-0000-4000-8000-000000000004";
const sessionId = "10000000-0000-4000-8000-000000000005";

void test("dry-run derives candidates only from the repository inventory and binds a digest", async () => {
  const repository = new FakeRepository(inventory());
  const service = createService(repository);
  const result = await service.dryRun({
    projectId,
    idempotencyKey: "gc-dry-run-key-0001",
  });

  assert.equal(result.analysis.status, "READY");
  assert.deepEqual(
    result.analysis.candidates
      .filter((entry) => entry.kind === "GENERATION")
      .map((entry) => entry.key),
    [generationId],
  );
  assert.equal(result.planId, planId);
  assert.match(result.planDigest ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.equal(repository.persisted?.analysis, result.analysis);
  assert.equal("candidateGenerationIds" in repository.lastReadInput, false);
});

void test("an incomplete active Root Provider persists a blocked empty result", async () => {
  const blocked = inventory({
    capabilities: [
      ...capabilities(),
      { capabilityKey: "future.query", state: "ACTIVE", expectedVersion: "v1" },
    ],
    providerScans: [
      ...providerScans(),
      {
        capabilityKey: "future.query",
        status: "MISSING",
        providerVersion: null,
        rootCount: 0,
        rootDigest: null,
      },
    ],
  });
  const result = await createService(new FakeRepository(blocked)).dryRun({
    projectId,
    idempotencyKey: "gc-dry-run-key-0002",
  });
  assert.equal(result.analysis.status, "BLOCKED");
  assert.deepEqual(result.analysis.candidates, []);
  assert.equal(result.planId, null);
  assert.equal(result.planDigest, null);
});

void test("commit deletes only the exact server-derived object version before acknowledging it", async () => {
  const repository = new FakeRepository(inventory());
  repository.orphans = [
    { sessionId, objectKey: "ingress/aa/server-owned.csv", objectVersion: "exact-v7" },
  ];
  const deleted: string[] = [];
  const service = createService(repository, {
    deleteVersion(objectKey, objectVersion) {
      deleted.push(`${objectKey}:${objectVersion}`);
      return Promise.resolve();
    },
  });
  const result = await service.commitNext({ projectId, planId });
  assert.equal(result.phase, "ORPHAN_UPLOAD");
  assert.deepEqual(deleted, ["ingress/aa/server-owned.csv:exact-v7"]);
  assert.deepEqual(repository.acknowledged, [`${sessionId}:exact-v7`]);
  assert.equal(repository.relationalCalls, 0);
});

void test("commit advances one bounded relational batch and maps a stale plan", async () => {
  const repository = new FakeRepository(inventory());
  repository.batch = {
    projectId,
    planId,
    state: "COMMITTING",
    phase: "BASE",
    affectedRows: 17,
    remainingCandidates: 1,
    indexRequestIds: [],
  };
  const service = createService(repository);
  assert.equal((await service.commitNext({ projectId, planId })).affectedRows, 17);
  assert.equal(repository.lastBatchSize, 128);

  repository.batchError = Object.assign(new Error("stale"), { code: "GC_PLAN_STALE" });
  await assert.rejects(
    service.commitNext({ projectId, planId }),
    (error: unknown) =>
      error instanceof GarbageCollectionApplicationError && error.code === "GC_PLAN_STALE",
  );
});

class FakeRepository implements GarbageCollectionRepository {
  readonly snapshot: GarbageCollectionInventorySnapshot;
  lastReadInput: Record<string, never> = {};
  persisted: GarbageCollectionDryRunPersistence | null = null;
  orphans: GarbageCollectionObjectVersion[] = [];
  acknowledged: string[] = [];
  relationalCalls = 0;
  lastBatchSize = 0;
  batch: GarbageCollectionBatchResult = {
    projectId,
    planId,
    state: "COMMITTED",
    phase: "DONE",
    affectedRows: 0,
    remainingCandidates: 0,
    indexRequestIds: [],
  };
  batchError: Error | null = null;

  constructor(snapshot: GarbageCollectionInventorySnapshot) {
    this.snapshot = snapshot;
  }

  readInventory(projectId: string): Promise<GarbageCollectionInventorySnapshot> {
    assert.equal(projectId, this.snapshot.projectId);
    this.lastReadInput = {};
    return Promise.resolve(this.snapshot);
  }

  persistDryRun(input: GarbageCollectionDryRunPersistence): Promise<GarbageCollectionDryRunRecord> {
    this.persisted = input;
    return Promise.resolve({ ...input, replayed: false });
  }

  claimOrphanUploadBatch(): Promise<readonly GarbageCollectionObjectVersion[]> {
    const result = [...this.orphans];
    this.orphans = [];
    return Promise.resolve(result);
  }

  acknowledgeOrphanUpload(input: {
    readonly sessionId: string;
    readonly objectVersion: string;
  }): Promise<void> {
    this.acknowledged.push(`${input.sessionId}:${input.objectVersion}`);
    return Promise.resolve();
  }

  commitNextRelationalBatch(input: {
    readonly batchSize: number;
  }): Promise<GarbageCollectionBatchResult> {
    this.relationalCalls += 1;
    this.lastBatchSize = input.batchSize;
    if (this.batchError !== null) throw this.batchError;
    return Promise.resolve(this.batch);
  }
}

function createService(
  repository: GarbageCollectionRepository,
  objectStore: GarbageCollectionObjectStore = {
    deleteVersion: () => Promise.resolve(),
  },
) {
  const ids = [runId, planId];
  return new GarbageCollectionService({
    repository,
    objectStore,
    batchSize: 128,
    crypto: {
      randomId: () => ids.shift() ?? planId,
      digestCanonicalText: (value): ArtifactDigest =>
        parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`),
    },
  });
}

function inventory(
  overrides: Partial<GarbageCollectionInventorySnapshot> = {},
): GarbageCollectionInventorySnapshot {
  return {
    projectId,
    observedAt: 40 * 24 * 60 * 60 * 1_000,
    stateRevision: 3n,
    inventoryRevision: 5n,
    measurementComplete: true,
    classificationComplete: true,
    indexInventoryComplete: true,
    providerRegistryDigest: digest("registry"),
    capabilities: capabilities(),
    providerScans: providerScans(),
    generations: [
      {
        generationId,
        memberKey: "object:Order",
        state: "FAILED_STAGING",
        createdAt: 1,
        changedAt: 1,
        leftServingAt: null,
        measuredBytes: 123n,
        indexSignatures: [],
        roots: [],
      },
    ],
    headSets: [],
    indexes: [],
    attempts: [],
    orphanUploads: [],
    ...overrides,
  };
}

function capabilities() {
  return [
    { capabilityKey: "materialization.channel", state: "ACTIVE", expectedVersion: "v1" },
    { capabilityKey: "materialization.serving-head", state: "ACTIVE", expectedVersion: "v1" },
    { capabilityKey: "materialization.job", state: "ACTIVE", expectedVersion: "v1" },
  ] as const;
}

function providerScans() {
  return capabilities().map(({ capabilityKey, expectedVersion }) => ({
    capabilityKey,
    status: "COMPLETE" as const,
    providerVersion: expectedVersion,
    rootCount: 0,
    rootDigest: digest(capabilityKey),
  }));
}

function digest(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}
