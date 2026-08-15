import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { parseArtifactDigest, parseOntosId, type ArtifactDigest } from "@ontos/contracts";
import {
  MaterializationBaseError,
  MaterializationBaseService,
  type LinkBaseStageRow,
  type MaterializationBaseCrypto,
  type MaterializationBaseRepository,
  type ObjectBaseStageRow,
  type ObjectIdentityCandidate,
  type ObjectIdentityLookup,
  type ObjectIdentityResolution,
  type StageBaseBatchInput,
} from "@ontos/materialization-application";
import type {
  MappingAcceptedLinkRow,
  MappingAcceptedObjectRow,
} from "@ontos/materialization-domain";
import { canonicalizePrimaryKey } from "@ontos/value-codec";

const ids = Object.freeze({
  project: parseOntosId("aaaaaaaa-0000-4000-8000-000000000001"),
  otherProject: parseOntosId("aaaaaaaa-0000-4000-8000-000000000002"),
  job: parseOntosId("aaaaaaaa-0000-4000-8000-000000000003"),
  attempt: parseOntosId("aaaaaaaa-0000-4000-8000-000000000004"),
  customerType: parseOntosId("aaaaaaaa-0000-4000-8000-000000000005"),
  customerRevision: parseOntosId("aaaaaaaa-0000-4000-8000-000000000006"),
  orderType: parseOntosId("aaaaaaaa-0000-4000-8000-000000000007"),
  orderRevision: parseOntosId("aaaaaaaa-0000-4000-8000-000000000008"),
  linkType: parseOntosId("aaaaaaaa-0000-4000-8000-000000000009"),
  linkRevision: parseOntosId("aaaaaaaa-0000-4000-8000-00000000000a"),
  objectGeneration1: parseOntosId("aaaaaaaa-0000-4000-8000-00000000000b"),
  objectGeneration2: parseOntosId("aaaaaaaa-0000-4000-8000-00000000000c"),
  linkGeneration: parseOntosId("aaaaaaaa-0000-4000-8000-00000000000d"),
  snapshot1: parseOntosId("aaaaaaaa-0000-4000-8000-00000000000e"),
  snapshot2: parseOntosId("aaaaaaaa-0000-4000-8000-00000000000f"),
  file1: parseOntosId("aaaaaaaa-0000-4000-8000-000000000010"),
  file2: parseOntosId("aaaaaaaa-0000-4000-8000-000000000011"),
  mapping: parseOntosId("aaaaaaaa-0000-4000-8000-000000000012"),
});

void describe("permanent Object identity and immutable Base application service", () => {
  void it("rejects canonical Primary Key collisions before any repository write", async () => {
    const repository = new MemoryBaseRepository();
    const service = createService(repository);

    await assert.rejects(
      service.stageObjectBatch({
        scope: scope(ids.project),
        generation: objectGeneration(ids.objectGeneration1, ids.snapshot1, ids.file1),
        batchSequence: 1,
        rows: [objectRow(1, "customer-a"), objectRow(2, "CUSTOMER-A")],
      }),
      isBaseError("PRIMARY_KEY_COLLISION"),
    );
    assert.equal(repository.resolveCalls, 0);
    assert.equal(repository.objectBatches.length, 0);
  });

  void it("keeps one RID across Snapshots and Generations while isolating Project and Object Type", async () => {
    const repository = new MemoryBaseRepository();
    const service = createService(repository);
    const first = await service.stageObjectBatch({
      scope: scope(ids.project),
      generation: objectGeneration(ids.objectGeneration1, ids.snapshot1, ids.file1),
      batchSequence: 1,
      rows: [objectRow(1, "customer-a")],
    });
    const second = await service.stageObjectBatch({
      scope: scope(ids.project),
      generation: objectGeneration(ids.objectGeneration2, ids.snapshot2, ids.file2),
      batchSequence: 2,
      rows: [objectRow(1, "CUSTOMER-A")],
    });

    const firstFact = repository.objectBatches[0]?.rows[0];
    const secondFact = repository.objectBatches[1]?.rows[0];
    assert.ok(firstFact);
    assert.ok(secondFact);
    assert.equal(secondFact.objectRid, firstFact.objectRid);
    assert.equal(secondFact.valueDigest, firstFact.valueDigest);
    assert.notEqual(second.batchDigest, first.batchDigest);

    const otherType = await repository.resolveOrCreateObjectIdentities({
      projectId: ids.project,
      candidates: [candidate(0, ids.orderType, firstFact.canonicalPrimaryKey)],
    });
    const otherProject = await repository.resolveOrCreateObjectIdentities({
      projectId: ids.otherProject,
      candidates: [candidate(0, ids.customerType, firstFact.canonicalPrimaryKey)],
    });
    assert.notEqual(otherType[0]?.objectRid, firstFact.objectRid);
    assert.notEqual(otherProject[0]?.objectRid, firstFact.objectRid);
  });

  void it("returns dangling Link candidates without creating fake Object identities", async () => {
    const repository = new MemoryBaseRepository();
    const service = createService(repository);
    await service.stageObjectBatch({
      scope: scope(ids.project),
      generation: objectGeneration(ids.objectGeneration1, ids.snapshot1, ids.file1),
      batchSequence: 1,
      rows: [objectRow(1, "customer-a")],
    });
    const resolveCallsBeforeLink = repository.resolveCalls;

    const receipt = await service.stageLinkBatch({
      scope: scope(ids.project),
      generation: linkGeneration(),
      batchSequence: 2,
      rows: [linkRow(1, "customer-a", "missing-order")],
    });

    assert.equal(receipt.stagedRowCount, 0);
    assert.deepEqual(receipt.dangling[0]?.missingEndpoints, ["target"]);
    assert.equal(repository.resolveCalls, resolveCallsBeforeLink);
    assert.equal(repository.linkBatches[0]?.rows.length, 0);
    assert.doesNotMatch(JSON.stringify(receipt), /missing-order|pk1\|/u);
  });

  void it("derives byte-stable Link RIDs and Base digests across process-style restarts", async () => {
    const repository = new MemoryBaseRepository();
    await seedEndpoint(repository, ids.customerType, key("customer-a"));
    await seedEndpoint(repository, ids.orderType, key("order-1", true));

    const firstService = createService(repository);
    const first = await firstService.stageLinkBatch({
      scope: scope(ids.project),
      generation: linkGeneration(),
      batchSequence: 1,
      rows: [linkRow(1, "customer-a", "order-1")],
    });
    const firstFact = repository.linkBatches[0]?.rows[0];
    assert.ok(firstFact);

    repository.linkBatches.length = 0;
    const restartedService = createService(repository);
    const second = await restartedService.stageLinkBatch({
      scope: scope(ids.project),
      generation: linkGeneration(),
      batchSequence: 1,
      rows: [linkRow(1, "CUSTOMER-A", "order-1")],
    });
    const secondFact = repository.linkBatches[0]?.rows[0];
    assert.ok(secondFact);
    assert.equal(secondFact.linkRid, firstFact.linkRid);
    assert.equal(secondFact.valueDigest, firstFact.valueDigest);
    assert.equal(second.batchDigest, first.batchDigest);
  });

  void it("uses the same kernel path for two domain-shaped Object payloads and deterministic promotion", async () => {
    const repository = new MemoryBaseRepository();
    const service = createService(repository);
    const customer = await service.stageObjectBatch({
      scope: scope(ids.project),
      generation: objectGeneration(ids.objectGeneration1, ids.snapshot1, ids.file1),
      batchSequence: 7,
      rows: [objectRow(1, "customer-a")],
    });
    const orderGeneration = {
      ...objectGeneration(ids.objectGeneration2, ids.snapshot2, ids.file2),
      targetResourceId: ids.orderType,
      targetRevisionId: ids.orderRevision,
    };
    const order = await service.stageObjectBatch({
      scope: scope(ids.project),
      generation: orderGeneration,
      batchSequence: 8,
      rows: [orderRow(1, "order-1")],
    });
    const promotion = await service.promoteGenerationBase({
      scope: scope(ids.project),
      generationId: ids.objectGeneration1,
      expectedRowCount: 1,
      batchReceipts: [customer],
    });
    const replay = await createService(repository).promoteGenerationBase({
      scope: scope(ids.project),
      generationId: ids.objectGeneration1,
      expectedRowCount: 1,
      batchReceipts: [customer],
    });

    assert.equal(repository.objectBatches.length, 2);
    assert.equal(repository.objectBatches[0]?.rows[0]?.properties.schemaVersion, 1);
    assert.equal(repository.objectBatches[1]?.rows[0]?.properties.schemaVersion, 1);
    assert.notEqual(order.batchDigest, customer.batchDigest);
    assert.equal(replay.stageDigest, promotion.stageDigest);
    assert.equal(replay.reused, true);
  });

  void it("does not expose repository SQL or Primary Keys through its stable error surface", async () => {
    const repository = new MemoryBaseRepository();
    repository.failure = new Error("duplicate SQL INSERT pk1|1|s12#SECRET-VALUE");
    const service = createService(repository);
    await assert.rejects(
      service.stageObjectBatch({
        scope: scope(ids.project),
        generation: objectGeneration(ids.objectGeneration1, ids.snapshot1, ids.file1),
        batchSequence: 1,
        rows: [objectRow(1, "secret-value")],
      }),
      (error: unknown) => {
        assert.ok(error instanceof MaterializationBaseError);
        assert.equal(error.code, "DEPENDENCY_UNAVAILABLE");
        assert.doesNotMatch(error.message, /INSERT|SECRET|pk1/u);
        assert.doesNotMatch(JSON.stringify(error), /INSERT|SECRET|pk1/u);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  });
});

class MemoryBaseRepository implements MaterializationBaseRepository {
  readonly identities = new Map<string, string>();
  readonly objectBatches: StageBaseBatchInput<ObjectBaseStageRow>[] = [];
  readonly linkBatches: StageBaseBatchInput<LinkBaseStageRow>[] = [];
  readonly promotions = new Map<string, ArtifactDigest>();
  resolveCalls = 0;
  failure: Error | null = null;

  resolveOrCreateObjectIdentities(input: {
    readonly projectId: string;
    readonly candidates: readonly ObjectIdentityCandidate[];
  }): Promise<readonly ObjectIdentityResolution[]> {
    this.resolveCalls += 1;
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(
      input.candidates.map((item) => {
        const identityKey = identityMapKey(
          input.projectId,
          item.objectTypeResourceId,
          item.canonicalPrimaryKey,
        );
        const objectRid = this.identities.get(identityKey) ?? item.candidateObjectRid;
        this.identities.set(identityKey, objectRid);
        return Object.freeze({ ordinal: item.ordinal, objectRid });
      }),
    );
  }

  lookupObjectIdentities(input: {
    readonly projectId: string;
    readonly lookups: readonly ObjectIdentityLookup[];
  }): Promise<readonly ObjectIdentityResolution[]> {
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(
      input.lookups.flatMap((item) => {
        const objectRid = this.identities.get(
          identityMapKey(input.projectId, item.objectTypeResourceId, item.canonicalPrimaryKey),
        );
        return objectRid === undefined ? [] : [Object.freeze({ ordinal: item.ordinal, objectRid })];
      }),
    );
  }

  stageObjectBaseBatch(input: StageBaseBatchInput<ObjectBaseStageRow>): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure);
    this.objectBatches.push(input);
    return Promise.resolve();
  }

  stageLinkBaseBatch(input: StageBaseBatchInput<LinkBaseStageRow>): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure);
    this.linkBatches.push(input);
    return Promise.resolve();
  }

  promoteGenerationBase(input: {
    readonly scope: { readonly projectId: string };
    readonly generationId: string;
    readonly expectedRowCount: number;
    readonly expectedStageDigest: ArtifactDigest;
  }): Promise<{ rowCount: number; stageDigest: ArtifactDigest; reused: boolean }> {
    if (this.failure !== null) return Promise.reject(this.failure);
    const mapKey = `${input.scope.projectId}\u0000${input.generationId}`;
    const existing = this.promotions.get(mapKey);
    if (existing !== undefined && existing !== input.expectedStageDigest) {
      return Promise.reject(new MaterializationBaseError("MATERIALIZATION_BASE_CONFLICT"));
    }
    this.promotions.set(mapKey, input.expectedStageDigest);
    return Promise.resolve(
      Object.freeze({
        rowCount: input.expectedRowCount,
        stageDigest: input.expectedStageDigest,
        reused: existing !== undefined,
      }),
    );
  }
}

function createService(repository: MaterializationBaseRepository): MaterializationBaseService {
  let sequence = 1;
  const crypto: MaterializationBaseCrypto = {
    randomId() {
      const suffix = sequence.toString(16).padStart(12, "0");
      sequence += 1;
      return `bbbbbbbb-0000-4000-8000-${suffix}`;
    },
    digestCanonicalText(value) {
      return parseArtifactDigest(`sha256:${createHash("sha256").update(value).digest("hex")}`);
    },
  };
  return new MaterializationBaseService({ repository, crypto });
}

function scope(projectId: string) {
  return Object.freeze({
    projectId,
    jobId: ids.job,
    attemptId: ids.attempt,
    fencingToken: 1n,
  });
}

function objectGeneration(generationId: string, sourceSnapshotId: string, sourceFileId: string) {
  return Object.freeze({
    generationId,
    targetResourceId: ids.customerType,
    targetRevisionId: ids.customerRevision,
    sourceSnapshotId,
    sourceFileId,
    mappingRevisionId: ids.mapping,
  });
}

function linkGeneration() {
  return Object.freeze({
    generationId: ids.linkGeneration,
    targetResourceId: ids.linkType,
    targetRevisionId: ids.linkRevision,
    sourceSnapshotId: ids.snapshot2,
    sourceFileId: ids.file2,
    mappingRevisionId: ids.mapping,
  });
}

function objectRow(rowNumber: number, identity: string): MappingAcceptedObjectRow {
  return Object.freeze({
    kind: "object",
    rowNumber,
    targetResourceId: ids.customerType,
    targetRevisionId: ids.customerRevision,
    canonicalPrimaryKey: key(identity),
    properties: Object.freeze([
      Object.freeze({
        propertyApiName: "customerId",
        valueType: "string",
        value: identity.toUpperCase(),
        sourceColumnApiNames: Object.freeze(["customerId"]),
      }),
      Object.freeze({
        propertyApiName: "creditLimit",
        valueType: "decimal",
        value: "1500.00",
        sourceColumnApiNames: Object.freeze(["creditLimit"]),
      }),
    ]),
  });
}

function orderRow(rowNumber: number, identity: string): MappingAcceptedObjectRow {
  return Object.freeze({
    kind: "object",
    rowNumber,
    targetResourceId: ids.orderType,
    targetRevisionId: ids.orderRevision,
    canonicalPrimaryKey: key(identity, true),
    properties: Object.freeze([
      Object.freeze({
        propertyApiName: "orderId",
        valueType: "string",
        value: identity,
        sourceColumnApiNames: Object.freeze(["orderId"]),
      }),
      Object.freeze({
        propertyApiName: "lineCount",
        valueType: "integer",
        value: "3",
        sourceColumnApiNames: Object.freeze(["lineCount"]),
      }),
    ]),
  });
}

function linkRow(rowNumber: number, customer: string, order: string): MappingAcceptedLinkRow {
  return Object.freeze({
    kind: "link",
    rowNumber,
    targetResourceId: ids.linkType,
    targetRevisionId: ids.linkRevision,
    sourceLookup: Object.freeze({
      objectTypeResourceId: ids.customerType,
      objectTypeRevisionId: ids.customerRevision,
      canonicalPrimaryKey: key(customer),
      sourceColumnApiNames: Object.freeze(["customerId"]),
    }),
    targetLookup: Object.freeze({
      objectTypeResourceId: ids.orderType,
      objectTypeRevisionId: ids.orderRevision,
      canonicalPrimaryKey: key(order, true),
      sourceColumnApiNames: Object.freeze(["orderId"]),
    }),
  });
}

function key(value: string, caseSensitive = false) {
  return canonicalizePrimaryKey([value], {
    components: [{ type: "string", caseSensitive }],
  });
}

function candidate(
  ordinal: number,
  objectTypeResourceId: string,
  canonicalPrimaryKey: string,
): ObjectIdentityCandidate {
  return Object.freeze({
    ordinal,
    objectTypeResourceId,
    canonicalPrimaryKey,
    candidateObjectRid: parseOntosId(
      `cccccccc-0000-4000-8000-${(ordinal + 1).toString().padStart(12, "0")}`,
    ),
  });
}

async function seedEndpoint(
  repository: MemoryBaseRepository,
  objectTypeResourceId: string,
  canonicalPrimaryKey: string,
): Promise<void> {
  await repository.resolveOrCreateObjectIdentities({
    projectId: ids.project,
    candidates: [candidate(0, objectTypeResourceId, canonicalPrimaryKey)],
  });
}

function identityMapKey(
  projectId: string,
  objectTypeResourceId: string,
  canonicalPrimaryKey: string,
) {
  return `${projectId}\u0000${objectTypeResourceId}\u0000${canonicalPrimaryKey}`;
}

function isBaseError(code: MaterializationBaseError["code"]) {
  return (error: unknown): boolean =>
    error instanceof MaterializationBaseError && error.code === code;
}
