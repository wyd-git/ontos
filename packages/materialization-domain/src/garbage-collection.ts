export const GC_DAY_IN_MS = 24 * 60 * 60 * 1_000;

export const DEFAULT_GC_RETENTION_POLICY = Object.freeze({
  successfulGenerationMs: 7 * GC_DAY_IN_MS,
  failedGenerationMs: 7 * GC_DAY_IN_MS,
  stagingGenerationMs: 7 * GC_DAY_IN_MS,
  attemptStagingMs: GC_DAY_IN_MS,
  orphanUploadMs: GC_DAY_IN_MS,
});

export interface GarbageCollectionRetentionPolicy {
  readonly successfulGenerationMs: number;
  readonly failedGenerationMs: number;
  readonly stagingGenerationMs: number;
  readonly attemptStagingMs: number;
  readonly orphanUploadMs: number;
}

export type GarbageCollectionCapabilityState = "ACTIVE" | "INACTIVE";
export type GarbageCollectionProviderScanStatus =
  "COMPLETE" | "INACTIVE" | "MISSING" | "FAILED" | "VERSION_MISMATCH";

export interface GarbageCollectionRootCapability {
  readonly capabilityKey: string;
  readonly state: GarbageCollectionCapabilityState;
  readonly expectedVersion: string;
}

export interface GarbageCollectionProviderScan {
  readonly capabilityKey: string;
  readonly status: GarbageCollectionProviderScanStatus;
  readonly providerVersion: string | null;
  readonly rootCount: number;
  readonly rootDigest: string | null;
}

export type GarbageCollectionRootKind =
  | "CHANNEL"
  | "SERVING_HEAD"
  | "ACTIVE_JOB"
  | "CURRENT_HEAD_SET"
  | "PREPARED_CUTOVER"
  | "PREFLIGHT_TOKEN"
  | "QUERY_LEASE"
  | "INVESTIGATION_HOLD"
  | "HISTORICAL_ACTION"
  | "HISTORICAL_CHANGESET"
  | "HISTORICAL_ARTIFACT"
  | "HISTORICAL_ACTIVATION";

export interface GarbageCollectionRoot {
  readonly kind: GarbageCollectionRootKind;
  readonly rootId: string;
  readonly capabilityKey: string;
  readonly expiresAt?: number;
}

export type GarbageCollectionGenerationState =
  "READY" | "ACTIVE" | "RETIRED" | "STAGING" | "FAILED_STAGING" | "COLLECTED";

export interface GarbageCollectionGenerationInventory {
  readonly generationId: string;
  readonly memberKey: string;
  readonly state: GarbageCollectionGenerationState;
  readonly createdAt: number;
  readonly changedAt: number;
  readonly leftServingAt: number | null;
  readonly measuredBytes: bigint | null;
  readonly indexSignatures: readonly string[];
  readonly roots: readonly GarbageCollectionRoot[];
}

export interface GarbageCollectionHeadSetInventory {
  readonly headSetId: string;
  readonly state: "BUILDING" | "PREPARED" | "ACTIVE" | "RETIRED" | "COLLECTED";
  readonly createdAt: number;
  readonly measuredBytes: bigint | null;
  readonly generationIds: readonly string[];
}

export interface GarbageCollectionIndexInventory {
  readonly physicalSignature: string;
  readonly indexName: string;
  readonly state: "PLANNED" | "BUILDING" | "READY" | "FAILED" | "RETIRED";
  readonly observedBytes: bigint | null;
}

export interface GarbageCollectionAttemptInventory {
  readonly attemptId: string;
  readonly state: "ACTIVE" | "TERMINAL";
  readonly finishedAt: number | null;
  readonly measuredBytes: bigint | null;
  readonly generationIds: readonly string[];
}

export interface GarbageCollectionOrphanUploadInventory {
  readonly sessionId: string;
  readonly state: "CREATED" | "UPLOADED" | "FAILED" | "EXPIRED" | "FINALIZED" | "CLEANED";
  readonly orphanedAt: number;
  readonly cleanupAfter: number;
  readonly measuredBytes: bigint | null;
  readonly exactVersionKnown: boolean;
}

export interface GarbageCollectionInventorySnapshot {
  readonly projectId: string;
  readonly observedAt: number;
  readonly stateRevision: bigint;
  readonly inventoryRevision: bigint;
  readonly measurementComplete: boolean;
  readonly classificationComplete: boolean;
  readonly indexInventoryComplete: boolean;
  readonly providerRegistryDigest: string;
  readonly capabilities: readonly GarbageCollectionRootCapability[];
  readonly providerScans: readonly GarbageCollectionProviderScan[];
  readonly generations: readonly GarbageCollectionGenerationInventory[];
  readonly headSets: readonly GarbageCollectionHeadSetInventory[];
  readonly indexes: readonly GarbageCollectionIndexInventory[];
  readonly attempts: readonly GarbageCollectionAttemptInventory[];
  readonly orphanUploads: readonly GarbageCollectionOrphanUploadInventory[];
}

export type GarbageCollectionEntryKind =
  "GENERATION" | "HEAD_SET" | "INDEX" | "ATTEMPT_STAGING" | "ORPHAN_UPLOAD";

export type GarbageCollectionDisposition = "CANDIDATE" | "RETAINED" | "PROTECTED";

export interface GarbageCollectionPlanEntry {
  readonly kind: GarbageCollectionEntryKind;
  readonly key: string;
  readonly disposition: GarbageCollectionDisposition;
  readonly reasons: readonly string[];
  readonly estimatedBytes: bigint;
  readonly indexImpact: readonly string[];
}

export interface GarbageCollectionPlanAnalysis {
  readonly status: "READY" | "BLOCKED";
  readonly projectId: string;
  readonly observedAt: number;
  readonly stateRevision: bigint;
  readonly inventoryRevision: bigint;
  readonly providerRegistryDigest: string;
  readonly entries: readonly GarbageCollectionPlanEntry[];
  readonly candidates: readonly GarbageCollectionPlanEntry[];
  readonly retained: readonly GarbageCollectionPlanEntry[];
  readonly protected: readonly GarbageCollectionPlanEntry[];
  readonly reclaimableBytes: bigint;
  readonly blockedReasons: readonly string[];
}

export class GarbageCollectionInventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GarbageCollectionInventoryError";
  }
}

export function analyzeGarbageCollectionInventory(
  snapshot: GarbageCollectionInventorySnapshot,
  policy: GarbageCollectionRetentionPolicy = DEFAULT_GC_RETENTION_POLICY,
): GarbageCollectionPlanAnalysis {
  validatePolicy(policy);
  validateSnapshot(snapshot);
  const blockedReasons = completenessViolations(snapshot);
  if (blockedReasons.length > 0) return blockedAnalysis(snapshot, blockedReasons);

  const entries: GarbageCollectionPlanEntry[] = [];
  const generationById = new Map(
    snapshot.generations.map((generation) => [generation.generationId, generation] as const),
  );
  const recentGenerationIds = deriveRecentSuccessfulGenerationIds(snapshot.generations);
  const candidateGenerationIds = new Set<string>();

  for (const generation of snapshot.generations) {
    if (generation.state === "COLLECTED") continue;
    const activeRoots = generation.roots
      .filter((root) => root.expiresAt === undefined || root.expiresAt > snapshot.observedAt)
      .sort(compareRoots);
    if (activeRoots.length > 0) {
      entries.push(
        entry(
          "GENERATION",
          generation.generationId,
          "PROTECTED",
          activeRoots.map((root) => root.kind),
          requiredBytes(generation.measuredBytes),
          generation.indexSignatures,
        ),
      );
      continue;
    }
    if (generation.state === "ACTIVE") {
      return blockedAnalysis(snapshot, [`ACTIVE_GENERATION_UNROOTED:${generation.generationId}`]);
    }
    const retentionReasons: string[] = [];
    if (recentGenerationIds.has(generation.generationId)) {
      retentionReasons.push("RECENT_SUCCESS");
    }
    const graceAnchor = Math.max(
      generation.createdAt,
      generation.changedAt,
      generation.leftServingAt ?? 0,
    );
    if (snapshot.observedAt - graceAnchor < generationRetentionMs(generation.state, policy)) {
      retentionReasons.push(generationGraceReason(generation.state));
    }
    if (retentionReasons.length > 0) {
      entries.push(
        entry(
          "GENERATION",
          generation.generationId,
          "RETAINED",
          retentionReasons,
          requiredBytes(generation.measuredBytes),
          generation.indexSignatures,
        ),
      );
      continue;
    }
    candidateGenerationIds.add(generation.generationId);
    entries.push(
      entry(
        "GENERATION",
        generation.generationId,
        "CANDIDATE",
        [
          generation.state === "FAILED_STAGING"
            ? "FAILED_GENERATION_RETENTION_ELAPSED"
            : generation.state === "STAGING"
              ? "ORPHAN_STAGING_RETENTION_ELAPSED"
              : "UNREFERENCED_GENERATION",
        ],
        requiredBytes(generation.measuredBytes),
        generation.indexSignatures,
      ),
    );
  }

  for (const headSet of snapshot.headSets) {
    if (headSet.state === "COLLECTED") continue;
    const active = headSet.state === "ACTIVE";
    const immutableInFlight = headSet.state === "BUILDING" || headSet.state === "PREPARED";
    const allCollectable = headSet.generationIds.every(
      (generationId) =>
        candidateGenerationIds.has(generationId) ||
        generationById.get(generationId)?.state === "COLLECTED",
    );
    entries.push(
      entry(
        "HEAD_SET",
        headSet.headSetId,
        active || immutableInFlight || !allCollectable ? "PROTECTED" : "CANDIDATE",
        active
          ? ["CURRENT_HEAD_SET"]
          : immutableInFlight
            ? ["IN_FLIGHT_HEAD_SET"]
            : allCollectable
              ? ["RETIRED_HEAD_SET"]
              : ["HEAD_SET_REFERENCES_RETAINED_GENERATION"],
        requiredBytes(headSet.measuredBytes),
        [],
      ),
    );
  }

  for (const attempt of snapshot.attempts) {
    if (attempt.state === "ACTIVE") {
      entries.push(
        entry(
          "ATTEMPT_STAGING",
          attempt.attemptId,
          "PROTECTED",
          ["ACTIVE_ATTEMPT"],
          requiredBytes(attempt.measuredBytes),
          [],
        ),
      );
      continue;
    }
    const allCollectable = attempt.generationIds.every(
      (generationId) =>
        candidateGenerationIds.has(generationId) ||
        generationById.get(generationId)?.state === "COLLECTED",
    );
    const graceElapsed =
      attempt.finishedAt !== null &&
      snapshot.observedAt - attempt.finishedAt >= policy.attemptStagingMs;
    entries.push(
      entry(
        "ATTEMPT_STAGING",
        attempt.attemptId,
        allCollectable && graceElapsed ? "CANDIDATE" : "RETAINED",
        !allCollectable
          ? ["ATTEMPT_REFERENCES_RETAINED_GENERATION"]
          : graceElapsed
            ? ["ATTEMPT_STAGING_RETENTION_ELAPSED"]
            : ["ATTEMPT_STAGING_GRACE_ACTIVE"],
        requiredBytes(attempt.measuredBytes),
        [],
      ),
    );
  }

  for (const upload of snapshot.orphanUploads) {
    if (upload.state === "CLEANED") continue;
    const orphan = upload.state === "FAILED" || upload.state === "EXPIRED";
    const retentionElapsed =
      snapshot.observedAt >= upload.cleanupAfter &&
      snapshot.observedAt - upload.orphanedAt >= policy.orphanUploadMs;
    const candidate = orphan && upload.exactVersionKnown && retentionElapsed;
    entries.push(
      entry(
        "ORPHAN_UPLOAD",
        upload.sessionId,
        candidate ? "CANDIDATE" : orphan ? "RETAINED" : "PROTECTED",
        candidate
          ? ["ORPHAN_UPLOAD_RETENTION_ELAPSED"]
          : !orphan
            ? ["REGISTERED_OR_IN_FLIGHT_UPLOAD"]
            : !upload.exactVersionKnown
              ? ["ORPHAN_VERSION_UNKNOWN"]
              : ["ORPHAN_UPLOAD_GRACE_ACTIVE"],
        requiredBytes(upload.measuredBytes),
        [],
      ),
    );
  }

  const nonCandidateGenerationSignatures = new Set(
    snapshot.generations
      .filter(
        (generation) =>
          generation.state !== "COLLECTED" && !candidateGenerationIds.has(generation.generationId),
      )
      .flatMap((generation) => generation.indexSignatures),
  );
  for (const index of snapshot.indexes) {
    if (index.state === "RETIRED") continue;
    const referenced = nonCandidateGenerationSignatures.has(index.physicalSignature);
    const candidate = index.state === "READY" && !referenced;
    entries.push(
      entry(
        "INDEX",
        index.physicalSignature,
        candidate ? "CANDIDATE" : "PROTECTED",
        candidate ? ["ZERO_REFERENCES_AFTER_PLAN"] : ["INDEX_STILL_REQUIRED"],
        requiredBytes(index.observedBytes),
        [index.indexName],
      ),
    );
  }

  return readyAnalysis(snapshot, entries);
}

function completenessViolations(snapshot: GarbageCollectionInventorySnapshot): string[] {
  const reasons: string[] = [];
  if (!snapshot.measurementComplete) reasons.push("MEASUREMENT_INCOMPLETE");
  if (!snapshot.classificationComplete) reasons.push("CLASSIFICATION_INCOMPLETE");
  if (!snapshot.indexInventoryComplete) reasons.push("INDEX_INVENTORY_INCOMPLETE");
  for (const capability of snapshot.capabilities) {
    const scan = snapshot.providerScans.find(
      (candidate) => candidate.capabilityKey === capability.capabilityKey,
    );
    if (capability.state === "INACTIVE") {
      if (scan === undefined || scan.status !== "INACTIVE") {
        reasons.push(`INACTIVE_PROVIDER_STATE_INVALID:${capability.capabilityKey}`);
      }
      continue;
    }
    if (scan === undefined || scan.status === "MISSING") {
      reasons.push(`PROVIDER_MISSING:${capability.capabilityKey}`);
    } else if (scan.status === "FAILED") {
      reasons.push(`PROVIDER_FAILED:${capability.capabilityKey}`);
    } else if (
      scan.status === "VERSION_MISMATCH" ||
      scan.status !== "COMPLETE" ||
      scan.providerVersion !== capability.expectedVersion
    ) {
      reasons.push(`PROVIDER_VERSION_MISMATCH:${capability.capabilityKey}`);
    } else if (scan.rootDigest === null || scan.rootCount < 0) {
      reasons.push(`PROVIDER_SCAN_INVALID:${capability.capabilityKey}`);
    }
  }
  const indexSignatures = new Set(snapshot.indexes.map((index) => index.physicalSignature));
  for (const generation of snapshot.generations) {
    if (generation.state !== "COLLECTED" && generation.measuredBytes === null) {
      reasons.push(`GENERATION_MEASUREMENT_MISSING:${generation.generationId}`);
    }
    for (const signature of generation.indexSignatures) {
      if (!indexSignatures.has(signature)) reasons.push(`INDEX_INVENTORY_MISSING:${signature}`);
    }
  }
  for (const item of [...snapshot.headSets, ...snapshot.attempts, ...snapshot.orphanUploads]) {
    if (item.measuredBytes === null) reasons.push(`ITEM_MEASUREMENT_MISSING:${inventoryKey(item)}`);
  }
  for (const index of snapshot.indexes) {
    if (index.state !== "RETIRED" && index.observedBytes === null) {
      reasons.push(`INDEX_MEASUREMENT_MISSING:${index.physicalSignature}`);
    }
  }
  return uniqueSorted(reasons);
}

function deriveRecentSuccessfulGenerationIds(
  generations: readonly GarbageCollectionGenerationInventory[],
): ReadonlySet<string> {
  const byMember = new Map<string, GarbageCollectionGenerationInventory[]>();
  for (const generation of generations) {
    if (generation.state !== "READY" && generation.state !== "RETIRED") continue;
    const values = byMember.get(generation.memberKey) ?? [];
    values.push(generation);
    byMember.set(generation.memberKey, values);
  }
  const result = new Set<string>();
  for (const values of byMember.values()) {
    values
      .sort(
        (left, right) =>
          right.changedAt - left.changedAt || left.generationId.localeCompare(right.generationId),
      )
      .slice(0, 2)
      .forEach((generation) => result.add(generation.generationId));
  }
  return result;
}

function readyAnalysis(
  snapshot: GarbageCollectionInventorySnapshot,
  values: readonly GarbageCollectionPlanEntry[],
): GarbageCollectionPlanAnalysis {
  const entries = Object.freeze(
    [...values].sort(
      (left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key),
    ),
  );
  const candidates = Object.freeze(entries.filter((item) => item.disposition === "CANDIDATE"));
  const retained = Object.freeze(entries.filter((item) => item.disposition === "RETAINED"));
  const protectedEntries = Object.freeze(
    entries.filter((item) => item.disposition === "PROTECTED"),
  );
  return Object.freeze({
    status: "READY",
    projectId: snapshot.projectId,
    observedAt: snapshot.observedAt,
    stateRevision: snapshot.stateRevision,
    inventoryRevision: snapshot.inventoryRevision,
    providerRegistryDigest: snapshot.providerRegistryDigest,
    entries,
    candidates,
    retained,
    protected: protectedEntries,
    reclaimableBytes: candidates.reduce((sum, item) => sum + item.estimatedBytes, 0n),
    blockedReasons: Object.freeze([]),
  });
}

function blockedAnalysis(
  snapshot: GarbageCollectionInventorySnapshot,
  reasons: readonly string[],
): GarbageCollectionPlanAnalysis {
  return Object.freeze({
    status: "BLOCKED",
    projectId: snapshot.projectId,
    observedAt: snapshot.observedAt,
    stateRevision: snapshot.stateRevision,
    inventoryRevision: snapshot.inventoryRevision,
    providerRegistryDigest: snapshot.providerRegistryDigest,
    entries: Object.freeze([]),
    candidates: Object.freeze([]),
    retained: Object.freeze([]),
    protected: Object.freeze([]),
    reclaimableBytes: 0n,
    blockedReasons: Object.freeze(uniqueSorted(reasons)),
  });
}

function entry(
  kind: GarbageCollectionEntryKind,
  key: string,
  disposition: GarbageCollectionDisposition,
  reasons: readonly string[],
  estimatedBytes: bigint,
  indexImpact: readonly string[],
): GarbageCollectionPlanEntry {
  return Object.freeze({
    kind,
    key,
    disposition,
    reasons: Object.freeze(uniqueSorted(reasons)),
    estimatedBytes,
    indexImpact: Object.freeze(uniqueSorted(indexImpact)),
  });
}

function generationRetentionMs(
  state: GarbageCollectionGenerationState,
  policy: GarbageCollectionRetentionPolicy,
): number {
  if (state === "FAILED_STAGING") return policy.failedGenerationMs;
  if (state === "STAGING") return policy.stagingGenerationMs;
  return policy.successfulGenerationMs;
}

function generationGraceReason(state: GarbageCollectionGenerationState): string {
  if (state === "FAILED_STAGING") return "FAILED_GENERATION_GRACE_ACTIVE";
  if (state === "STAGING") return "STAGING_GENERATION_GRACE_ACTIVE";
  return "GENERATION_GRACE_ACTIVE";
}

function validatePolicy(policy: GarbageCollectionRetentionPolicy): void {
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < GC_DAY_IN_MS) {
      throw new GarbageCollectionInventoryError(`${key} is below the one-day hard floor.`);
    }
  }
  if (
    policy.successfulGenerationMs < 7 * GC_DAY_IN_MS ||
    policy.failedGenerationMs < 7 * GC_DAY_IN_MS ||
    policy.stagingGenerationMs < 7 * GC_DAY_IN_MS
  ) {
    throw new GarbageCollectionInventoryError(
      "Generation retention cannot be shorter than 7 days.",
    );
  }
}

function validateSnapshot(snapshot: GarbageCollectionInventorySnapshot): void {
  if (
    snapshot.projectId.trim() === "" ||
    !Number.isSafeInteger(snapshot.observedAt) ||
    snapshot.observedAt < 0 ||
    snapshot.stateRevision < 1n ||
    snapshot.inventoryRevision < 1n ||
    snapshot.providerRegistryDigest.trim() === ""
  ) {
    throw new GarbageCollectionInventoryError("GC inventory header is invalid.");
  }
  assertUnique(
    snapshot.capabilities.map((value) => value.capabilityKey),
    "capability",
  );
  assertUnique(
    snapshot.providerScans.map((value) => value.capabilityKey),
    "provider scan",
  );
  assertUnique(
    snapshot.generations.map((value) => value.generationId),
    "generation",
  );
  assertUnique(
    snapshot.headSets.map((value) => value.headSetId),
    "head set",
  );
  assertUnique(
    snapshot.indexes.map((value) => value.physicalSignature),
    "index",
  );
  assertUnique(
    snapshot.attempts.map((value) => value.attemptId),
    "attempt",
  );
  assertUnique(
    snapshot.orphanUploads.map((value) => value.sessionId),
    "orphan upload",
  );
  for (const generation of snapshot.generations) {
    if (
      generation.memberKey.trim() === "" ||
      !safeInstant(generation.createdAt) ||
      !safeInstant(generation.changedAt) ||
      generation.changedAt < generation.createdAt ||
      (generation.leftServingAt !== null &&
        (!safeInstant(generation.leftServingAt) ||
          generation.leftServingAt < generation.createdAt)) ||
      (generation.measuredBytes !== null && generation.measuredBytes < 0n)
    ) {
      throw new GarbageCollectionInventoryError(
        `Generation ${generation.generationId} is invalid.`,
      );
    }
    assertUnique(generation.indexSignatures, `generation ${generation.generationId} index`);
    assertUnique(
      generation.roots.map((root) => `${root.capabilityKey}:${root.kind}:${root.rootId}`),
      `generation ${generation.generationId} root`,
    );
  }
}

function compareRoots(left: GarbageCollectionRoot, right: GarbageCollectionRoot): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.capabilityKey.localeCompare(right.capabilityKey) ||
    left.rootId.localeCompare(right.rootId)
  );
}

function inventoryKey(
  value:
    | GarbageCollectionHeadSetInventory
    | GarbageCollectionAttemptInventory
    | GarbageCollectionOrphanUploadInventory,
): string {
  if ("headSetId" in value) return value.headSetId;
  if ("attemptId" in value) return value.attemptId;
  return value.sessionId;
}

function requiredBytes(value: bigint | null): bigint {
  if (value === null)
    throw new GarbageCollectionInventoryError("Incomplete bytes reached planning.");
  return value;
}

function safeInstant(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertUnique(values: readonly string[], label: string): void {
  if (values.some((value) => value.trim() === "") || new Set(values).size !== values.length) {
    throw new GarbageCollectionInventoryError(`GC ${label} inventory is not unique.`);
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
