import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseOntosId,
  type ArtifactDigest,
} from "@ontos/contracts";
import {
  analyzeGarbageCollectionInventory,
  type GarbageCollectionInventorySnapshot,
  type GarbageCollectionPlanAnalysis,
} from "@ontos/materialization-domain";

export type GarbageCollectionApplicationErrorCode =
  | "GC_DEPENDENCY_UNAVAILABLE"
  | "GC_INPUT_INVALID"
  | "GC_PLAN_STALE"
  | "GC_PROTOCOL_CONFLICT"
  | "GC_REFERENCE_SCAN_INCOMPLETE";

export class GarbageCollectionApplicationError extends Error {
  readonly code: GarbageCollectionApplicationErrorCode;

  constructor(code: GarbageCollectionApplicationErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "GarbageCollectionApplicationError";
    this.code = code;
  }
}

export interface GarbageCollectionCrypto {
  randomId(): string;
  digestCanonicalText(canonicalText: string): ArtifactDigest;
}

export interface GarbageCollectionDryRunPersistence {
  readonly projectId: string;
  readonly runId: string;
  readonly planId: string | null;
  readonly idempotencyKeyDigest: ArtifactDigest;
  readonly protectedRootDigest: ArtifactDigest;
  readonly planDigest: ArtifactDigest | null;
  readonly analysis: GarbageCollectionPlanAnalysis;
}

export interface GarbageCollectionDryRunRecord extends GarbageCollectionDryRunPersistence {
  readonly replayed: boolean;
}

export interface GarbageCollectionObjectVersion {
  readonly sessionId: string;
  readonly objectKey: string;
  readonly objectVersion: string;
}

export interface GarbageCollectionObjectStore {
  deleteVersion(objectKey: string, objectVersion: string): Promise<void>;
}

export interface GarbageCollectionBatchResult {
  readonly projectId: string;
  readonly planId: string;
  readonly state: "COMMITTING" | "WAITING_FOR_INDEX_DDL" | "COMMITTED";
  readonly phase:
    | "ORPHAN_UPLOAD"
    | "HEAD_SET"
    | "PROVENANCE"
    | "CURRENT"
    | "BASE"
    | "REPORT"
    | "ATTEMPT"
    | "GENERATION"
    | "INDEX_REQUEST"
    | "DONE";
  readonly affectedRows: number;
  readonly remainingCandidates: number;
  readonly indexRequestIds: readonly string[];
}

export interface GarbageCollectionRepository {
  readInventory(projectId: string): Promise<GarbageCollectionInventorySnapshot>;
  persistDryRun(input: GarbageCollectionDryRunPersistence): Promise<GarbageCollectionDryRunRecord>;
  claimOrphanUploadBatch(input: {
    readonly projectId: string;
    readonly planId: string;
    readonly batchSize: number;
  }): Promise<readonly GarbageCollectionObjectVersion[]>;
  acknowledgeOrphanUpload(input: {
    readonly projectId: string;
    readonly planId: string;
    readonly sessionId: string;
    readonly objectVersion: string;
  }): Promise<void>;
  commitNextRelationalBatch(input: {
    readonly projectId: string;
    readonly planId: string;
    readonly batchSize: number;
  }): Promise<GarbageCollectionBatchResult>;
}

export interface GarbageCollectionServiceOptions {
  readonly repository: GarbageCollectionRepository;
  readonly crypto: GarbageCollectionCrypto;
  readonly objectStore: GarbageCollectionObjectStore;
  readonly batchSize?: number;
}

export class GarbageCollectionService {
  readonly #repository: GarbageCollectionRepository;
  readonly #crypto: GarbageCollectionCrypto;
  readonly #objectStore: GarbageCollectionObjectStore;
  readonly #batchSize: number;

  constructor(options: GarbageCollectionServiceOptions) {
    this.#repository = options.repository;
    this.#crypto = options.crypto;
    this.#objectStore = options.objectStore;
    const batchSize = options.batchSize ?? 1_000;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new GarbageCollectionApplicationError("GC_INPUT_INVALID");
    }
    this.#batchSize = batchSize;
  }

  async dryRun(input: {
    readonly projectId: string;
    readonly idempotencyKey: string;
  }): Promise<GarbageCollectionDryRunRecord> {
    const projectId = parseId(input.projectId);
    const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
    const snapshot = await dependency(() => this.#repository.readInventory(projectId));
    if (snapshot.projectId !== projectId) {
      throw new GarbageCollectionApplicationError("GC_PROTOCOL_CONFLICT");
    }
    const analysis = analyzeGarbageCollectionInventory(snapshot);
    const idempotencyKeyDigest = digest(this.#crypto, {
      schemaVersion: 1,
      contractVersion: "gc-idempotency-v1",
      projectId,
      idempotencyKey,
    });
    const protectedRootDigest = digest(this.#crypto, protectedRootPreimage(snapshot));
    const runId = parseId(this.#crypto.randomId());
    const planId = analysis.status === "READY" ? parseId(this.#crypto.randomId()) : null;
    const planDigest =
      planId === null
        ? null
        : digest(this.#crypto, {
            schemaVersion: 1,
            contractVersion: "gc-plan-execution-v1",
            projectId,
            runId,
            planId,
            observedAt: analysis.observedAt,
            stateRevision: analysis.stateRevision.toString(),
            inventoryRevision: analysis.inventoryRevision.toString(),
            providerRegistryDigest: analysis.providerRegistryDigest,
            protectedRootDigest,
            entries: analysis.entries.map(entryForDigest),
            reclaimableBytes: analysis.reclaimableBytes.toString(),
          });
    const persisted = await dependency(() =>
      this.#repository.persistDryRun({
        projectId,
        runId,
        planId,
        idempotencyKeyDigest,
        protectedRootDigest,
        planDigest,
        analysis,
      }),
    );
    assertPersistedDryRun(persisted, { projectId, idempotencyKeyDigest, analysis });
    return persisted;
  }

  async commitNext(input: {
    readonly projectId: string;
    readonly planId: string;
  }): Promise<GarbageCollectionBatchResult> {
    const projectId = parseId(input.projectId);
    const planId = parseId(input.planId);
    const orphanBatch = await mappedCommitDependency(() =>
      this.#repository.claimOrphanUploadBatch({
        projectId,
        planId,
        batchSize: this.#batchSize,
      }),
    );
    if (orphanBatch.length > this.#batchSize) {
      throw new GarbageCollectionApplicationError("GC_PROTOCOL_CONFLICT");
    }
    if (orphanBatch.length > 0) {
      for (const item of orphanBatch) {
        parseId(item.sessionId);
        if (item.objectKey.trim() === "" || item.objectVersion.trim() === "") {
          throw new GarbageCollectionApplicationError("GC_PROTOCOL_CONFLICT");
        }
        await dependency(() => this.#objectStore.deleteVersion(item.objectKey, item.objectVersion));
        await mappedCommitDependency(() =>
          this.#repository.acknowledgeOrphanUpload({
            projectId,
            planId,
            sessionId: item.sessionId,
            objectVersion: item.objectVersion,
          }),
        );
      }
      return Object.freeze({
        projectId,
        planId,
        state: "COMMITTING",
        phase: "ORPHAN_UPLOAD",
        affectedRows: orphanBatch.length,
        remainingCandidates: orphanBatch.length,
        indexRequestIds: Object.freeze([]),
      });
    }
    const result = await mappedCommitDependency(() =>
      this.#repository.commitNextRelationalBatch({
        projectId,
        planId,
        batchSize: this.#batchSize,
      }),
    );
    if (
      result.projectId !== projectId ||
      result.planId !== planId ||
      !Number.isSafeInteger(result.affectedRows) ||
      result.affectedRows < 0 ||
      !Number.isSafeInteger(result.remainingCandidates) ||
      result.remainingCandidates < 0 ||
      result.indexRequestIds.some((requestId) => parseId(requestId) !== requestId)
    ) {
      throw new GarbageCollectionApplicationError("GC_PROTOCOL_CONFLICT");
    }
    return Object.freeze({
      ...result,
      indexRequestIds: Object.freeze([...result.indexRequestIds]),
    });
  }
}

function protectedRootPreimage(
  snapshot: GarbageCollectionInventorySnapshot,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    contractVersion: "gc-protected-roots-v1",
    projectId: snapshot.projectId,
    observedAt: snapshot.observedAt,
    providerRegistryDigest: snapshot.providerRegistryDigest,
    capabilities: [...snapshot.capabilities]
      .sort((left, right) => left.capabilityKey.localeCompare(right.capabilityKey))
      .map((capability) => ({ ...capability })),
    providerScans: [...snapshot.providerScans]
      .sort((left, right) => left.capabilityKey.localeCompare(right.capabilityKey))
      .map((scan) => ({ ...scan })),
    roots: snapshot.generations
      .flatMap((generation) =>
        generation.roots.map((root) => ({ generationId: generation.generationId, ...root })),
      )
      .sort(
        (left, right) =>
          left.generationId.localeCompare(right.generationId) ||
          left.capabilityKey.localeCompare(right.capabilityKey) ||
          left.kind.localeCompare(right.kind) ||
          left.rootId.localeCompare(right.rootId),
      ),
  };
}

function entryForDigest(entry: GarbageCollectionPlanAnalysis["entries"][number]) {
  return {
    kind: entry.kind,
    key: entry.key,
    disposition: entry.disposition,
    reasons: entry.reasons,
    estimatedBytes: entry.estimatedBytes.toString(),
    indexImpact: entry.indexImpact,
  };
}

function assertPersistedDryRun(
  persisted: GarbageCollectionDryRunRecord,
  expected: {
    readonly projectId: string;
    readonly idempotencyKeyDigest: ArtifactDigest;
    readonly analysis: GarbageCollectionPlanAnalysis;
  },
): void {
  if (
    persisted.projectId !== expected.projectId ||
    persisted.idempotencyKeyDigest !== expected.idempotencyKeyDigest ||
    persisted.analysis.status !== expected.analysis.status ||
    persisted.analysis.stateRevision !== expected.analysis.stateRevision ||
    persisted.analysis.inventoryRevision !== expected.analysis.inventoryRevision ||
    (persisted.analysis.status === "READY") !==
      (persisted.planId !== null && persisted.planDigest !== null)
  ) {
    throw new GarbageCollectionApplicationError("GC_PROTOCOL_CONFLICT");
  }
  if (persisted.planId !== null) parseId(persisted.planId);
  if (persisted.planDigest !== null) parseArtifactDigest(persisted.planDigest);
  parseId(persisted.runId);
  parseArtifactDigest(persisted.protectedRootDigest);
}

function digest(
  crypto: GarbageCollectionCrypto,
  value: Readonly<Record<string, unknown>>,
): ArtifactDigest {
  return parseArtifactDigest(crypto.digestCanonicalText(canonicalizeContractForDigest(value)));
}

function parseId(value: unknown): string {
  try {
    return parseOntosId(value);
  } catch (error) {
    throw new GarbageCollectionApplicationError("GC_INPUT_INVALID", { cause: error });
  }
}

function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/u.test(value)) {
    throw new GarbageCollectionApplicationError("GC_INPUT_INVALID");
  }
  return value;
}

async function dependency<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GarbageCollectionApplicationError) throw error;
    throw new GarbageCollectionApplicationError("GC_DEPENDENCY_UNAVAILABLE", { cause: error });
  }
}

async function mappedCommitDependency<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GarbageCollectionApplicationError) throw error;
    if (isRecord(error) && error.code === "GC_PLAN_STALE") {
      throw new GarbageCollectionApplicationError("GC_PLAN_STALE", { cause: error });
    }
    if (isRecord(error) && error.code === "GC_REFERENCE_SCAN_INCOMPLETE") {
      throw new GarbageCollectionApplicationError("GC_REFERENCE_SCAN_INCOMPLETE", {
        cause: error,
      });
    }
    throw new GarbageCollectionApplicationError("GC_DEPENDENCY_UNAVAILABLE", { cause: error });
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
