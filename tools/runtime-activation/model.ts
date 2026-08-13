export const DAY_IN_MS = 24 * 60 * 60 * 1_000;

export const defaultRuntimePolicy: RuntimePolicy = {
  minimumReleaseSupportMs: 90 * DAY_IN_MS,
  normalMaxServingReleases: 32,
  hardMaxServingReleases: 64,
  normalMaxServingGenerationsPerMember: 8,
  hardMaxServingGenerationsPerMember: 16,
  inactiveGenerationRetentionCount: 2,
  minimumInactiveRetentionMs: 7 * DAY_IN_MS,
  maximumCapacityApprovalMs: 30 * DAY_IN_MS,
  maximumQueryLeaseMs: 5 * 60 * 1_000,
  maximumPreflightTtlMs: 15 * 60 * 1_000,
};

export type RuntimeErrorCode =
  | "ALREADY_EXISTS"
  | "CAPACITY_APPROVAL_INVALID"
  | "CAPACITY_HARD_LIMIT"
  | "CAPACITY_SOFT_LIMIT"
  | "CONCURRENT_MODIFICATION"
  | "CONTENT_COLLECTED"
  | "INVALID_STATE"
  | "NOT_FOUND"
  | "PIN_GENERATION_MISMATCH"
  | "PREFLIGHT_STALE"
  | "PREFLIGHT_TOKEN_EXPIRED"
  | "QUERY_LEASE_EXPIRED"
  | "RELEASE_NOT_SERVING"
  | "RELEASE_RETIRED"
  | "SNAPSHOT_GROUP_MISMATCH"
  | "SUPPORT_WINDOW_ACTIVE";

export class RuntimeModelError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeModelError";
    this.code = code;
  }
}

export interface RuntimePolicy {
  minimumReleaseSupportMs: number;
  normalMaxServingReleases: number;
  hardMaxServingReleases: number;
  normalMaxServingGenerationsPerMember: number;
  hardMaxServingGenerationsPerMember: number;
  inactiveGenerationRetentionCount: number;
  minimumInactiveRetentionMs: number;
  maximumCapacityApprovalMs: number;
  maximumQueryLeaseMs: number;
  maximumPreflightTtlMs: number;
}

export interface ReleasePin {
  memberKey: string;
  resourceRevisionId: string;
  schemaHash: string;
  mappingHash: string;
  snapshotGroupKey: string;
}

export interface ReleaseRecord {
  id: string;
  projectId: string;
  manifestHash: string;
  pins: Record<string, ReleasePin>;
  state: "STAGED" | "PUBLISHED" | "RETIRED" | "COLLECTED";
  rollbackOf: string | null;
  stagedAt: number;
  publishedAt: number | null;
  supportUntil: number | null;
  retiredAt: number | null;
}

export interface SnapshotRecord {
  id: string;
  projectId: string;
  groupKey: string;
  groupVersion: string;
  createdAt: number;
  lastServingAt: number | null;
  state: "READY" | "COLLECTED";
}

export interface GenerationCompatibilityProof {
  releaseId: string;
  pinFingerprint: string;
  schemaHash: string;
  mappingHash: string;
  certificateId: string;
}

export interface GenerationRecord {
  id: string;
  projectId: string;
  memberKey: string;
  snapshotId: string;
  buildReleaseId: string;
  buildPinFingerprint: string;
  compatibilityByPin: Record<string, GenerationCompatibilityProof>;
  createdAt: number;
  lastServingAt: number | null;
  state: "READY" | "COLLECTED";
}

export interface ActivationMember {
  generationId: string;
  snapshotId: string;
}

export interface ActivationRecord {
  id: string;
  projectId: string;
  sourceChannel: string;
  releaseId: string;
  releaseManifestHash: string;
  members: Record<string, ActivationMember>;
  createdAt: number;
  lastServingAt: number | null;
  state: "READY" | "COLLECTED";
}

export interface ChannelPointer {
  projectId: string;
  channel: string;
  activationId: string;
  updatedAt: number;
}

export interface ServingHead {
  releaseId: string;
  activationId: string;
  updatedAt: number;
}

export type RuntimeSelector =
  { kind: "channel"; projectId: string; channel: string } | { kind: "release"; releaseId: string };

export interface ContentReferences {
  releaseIds: string[];
  activationIds: string[];
  generationIds: string[];
  snapshotIds: string[];
}

export interface ContentReferencesInput {
  releaseIds?: readonly string[];
  activationIds?: readonly string[];
  generationIds?: readonly string[];
  snapshotIds?: readonly string[];
}

export interface QueryLease {
  id: string;
  selector: RuntimeSelector;
  activationId: string;
  resolutionCount: 1;
  startedAt: number;
  leaseUntil: number;
  state: "ACTIVE" | "ENDED";
}

export interface PreflightToken {
  id: string;
  selector: RuntimeSelector;
  activationId: string;
  issuedAt: number;
  expiresAt: number;
  state: "ACTIVE" | "USED" | "STALE";
}

export interface JobReference {
  id: string;
  references: ContentReferences;
  state: "ACTIVE" | "COMPLETED" | "CANCELLED";
}

export interface HoldReference {
  id: string;
  references: ContentReferences;
  reason: string;
  state: "ACTIVE" | "RELEASED";
}

export interface HistoricalReference {
  id: string;
  references: ContentReferences;
}

export interface CapacityApproval {
  id: string;
  projectId: string;
  approvedAt: number;
  expiresAt: number;
  maximumServingReleases: number;
  maximumServingGenerationsPerMember: number;
  retirementReleaseIds: string[];
}

export interface RuntimeState {
  controlRevision: number;
  stateRevision: number;
  releases: Record<string, ReleaseRecord>;
  snapshots: Record<string, SnapshotRecord>;
  generations: Record<string, GenerationRecord>;
  activations: Record<string, ActivationRecord>;
  channels: Record<string, ChannelPointer>;
  servingHeads: Record<string, ServingHead>;
  queries: Record<string, QueryLease>;
  preflightTokens: Record<string, PreflightToken>;
  jobs: Record<string, JobReference>;
  holds: Record<string, HoldReference>;
  historicalReferences: Record<string, HistoricalReference>;
  capacityApprovals: Record<string, CapacityApproval>;
}

export interface RegisterReleaseInput {
  id: string;
  projectId: string;
  manifestHash: string;
  pins: readonly ReleasePin[];
  stagedAt: number;
  rollbackOf?: string;
}

export interface RegisterGenerationInput {
  id: string;
  projectId: string;
  memberKey: string;
  snapshotId: string;
  buildReleaseId: string;
  compatibleReleaseIds?: readonly string[];
  certificateByReleaseId?: Readonly<Record<string, string>>;
  createdAt: number;
}

export interface CreateActivationInput {
  id: string;
  projectId: string;
  sourceChannel: string;
  releaseId: string;
  members: Readonly<Record<string, ActivationMember>>;
  createdAt: number;
}

export interface PublishInput {
  releaseId: string;
  channel: string;
  activationId: string;
  expectedControlRevision: number;
  at: number;
  supportUntil?: number;
  capacityApprovalId?: string;
}

export interface RefreshInput {
  replacements: readonly { releaseId: string; activationId: string }[];
  expectedControlRevision: number;
  at: number;
  capacityApprovalId?: string;
}

export interface ResolvedActivation {
  activationId: string;
  releaseId: string;
  releaseManifestHash: string;
}

export interface GarbageCollectionPlan {
  plannedAtStateRevision: number;
  at: number;
  releaseIds: string[];
  activationIds: string[];
  generationIds: string[];
  snapshotIds: string[];
}

interface ProtectedIds {
  releaseIds: Set<string>;
  activationIds: Set<string>;
  generationIds: Set<string>;
  snapshotIds: Set<string>;
}

interface CapacitySnapshot {
  servingReleases: number;
  generationsPerMember: Record<string, number>;
}

export function releasePinFingerprint(pin: ReleasePin): string {
  return JSON.stringify([
    pin.memberKey,
    pin.resourceRevisionId,
    pin.schemaHash,
    pin.mappingHash,
    pin.snapshotGroupKey,
  ]);
}

export class RuntimeActivationModel {
  readonly policy: RuntimePolicy;
  #state: RuntimeState;

  constructor(policy: RuntimePolicy = defaultRuntimePolicy) {
    assertPolicy(policy);
    this.policy = structuredClone(policy);
    this.#state = emptyState();
  }

  get controlRevision(): number {
    return this.#state.controlRevision;
  }

  get stateRevision(): number {
    return this.#state.stateRevision;
  }

  snapshot(): RuntimeState {
    return structuredClone(this.#state);
  }

  registerRelease(input: RegisterReleaseInput): void {
    assertUnusedId(this.#state.releases, input.id, "Release");
    if (input.pins.length === 0) fail("INVALID_STATE", "A Release needs at least one pin.");
    if (input.rollbackOf !== undefined) {
      const source = requireRecord(this.#state.releases, input.rollbackOf, "Release");
      if (source.state === "COLLECTED") {
        fail("CONTENT_COLLECTED", "A collected Release cannot be used as a rollback source.");
      }
      if (source.projectId !== input.projectId) {
        fail("INVALID_STATE", "Rollback source and new Release must belong to one project.");
      }
    }

    const pins: Record<string, ReleasePin> = {};
    for (const pin of input.pins) {
      if (pin.memberKey in pins) {
        fail("INVALID_STATE", `Duplicate Release pin member ${pin.memberKey}.`);
      }
      pins[pin.memberKey] = structuredClone(pin);
    }

    this.#state.releases[input.id] = {
      id: input.id,
      projectId: input.projectId,
      manifestHash: input.manifestHash,
      pins,
      state: "STAGED",
      rollbackOf: input.rollbackOf ?? null,
      stagedAt: input.stagedAt,
      publishedAt: null,
      supportUntil: null,
      retiredAt: null,
    };
    this.#bumpState();
  }

  registerSnapshot(input: Omit<SnapshotRecord, "state" | "lastServingAt">): void {
    assertUnusedId(this.#state.snapshots, input.id, "Snapshot");
    this.#state.snapshots[input.id] = {
      ...structuredClone(input),
      lastServingAt: null,
      state: "READY",
    };
    this.#bumpState();
  }

  registerGeneration(input: RegisterGenerationInput): void {
    assertUnusedId(this.#state.generations, input.id, "Generation");
    const snapshot = this.#requireReadySnapshot(input.snapshotId);
    if (snapshot.projectId !== input.projectId) {
      fail("INVALID_STATE", "Generation and Snapshot must belong to one project.");
    }

    const buildRelease = this.#requireUsableRelease(input.buildReleaseId);
    if (buildRelease.projectId !== input.projectId) {
      fail("INVALID_STATE", "Generation and build Release must belong to one project.");
    }
    const buildPin = requireRecord(buildRelease.pins, input.memberKey, "Release pin");
    if (buildPin.snapshotGroupKey !== snapshot.groupKey) {
      fail("SNAPSHOT_GROUP_MISMATCH", "Build pin and Snapshot use different groups.");
    }

    const releaseIds = unique([input.buildReleaseId, ...(input.compatibleReleaseIds ?? [])]);
    const compatibilityByPin: Record<string, GenerationCompatibilityProof> = {};
    const buildFingerprint = releasePinFingerprint(buildPin);

    for (const releaseId of releaseIds) {
      const release = this.#requireUsableRelease(releaseId);
      const pin = requireRecord(release.pins, input.memberKey, "Release pin");
      if (release.projectId !== input.projectId || pin.snapshotGroupKey !== snapshot.groupKey) {
        fail(
          "SNAPSHOT_GROUP_MISMATCH",
          "Compatible Release pin does not target this Snapshot group.",
        );
      }

      const fingerprint = releasePinFingerprint(pin);
      const exact = fingerprint === buildFingerprint;
      const certificateId = exact ? "exact-pin" : input.certificateByReleaseId?.[releaseId]?.trim();
      if (!certificateId) {
        fail(
          "PIN_GENERATION_MISMATCH",
          `Generation ${input.id} needs an explicit compatibility certificate for Release ${releaseId}.`,
        );
      }
      compatibilityByPin[fingerprint] = {
        releaseId,
        pinFingerprint: fingerprint,
        schemaHash: pin.schemaHash,
        mappingHash: pin.mappingHash,
        certificateId,
      };
    }

    this.#state.generations[input.id] = {
      id: input.id,
      projectId: input.projectId,
      memberKey: input.memberKey,
      snapshotId: input.snapshotId,
      buildReleaseId: input.buildReleaseId,
      buildPinFingerprint: buildFingerprint,
      compatibilityByPin,
      createdAt: input.createdAt,
      lastServingAt: null,
      state: "READY",
    };
    this.#bumpState();
  }

  createActivation(input: CreateActivationInput): void {
    assertUnusedId(this.#state.activations, input.id, "Activation");
    const release = this.#requireUsableRelease(input.releaseId);
    if (release.projectId !== input.projectId) {
      fail("INVALID_STATE", "Activation and Release must belong to one project.");
    }

    const activation: ActivationRecord = {
      id: input.id,
      projectId: input.projectId,
      sourceChannel: input.sourceChannel,
      releaseId: input.releaseId,
      releaseManifestHash: release.manifestHash,
      members: structuredClone(input.members),
      createdAt: input.createdAt,
      lastServingAt: null,
      state: "READY",
    };
    this.#validateActivation(activation, true);
    this.#state.activations[input.id] = activation;
    this.#bumpState();
  }

  registerCapacityApproval(input: CapacityApproval): void {
    assertUnusedId(this.#state.capacityApprovals, input.id, "Capacity approval");
    if (
      input.expiresAt <= input.approvedAt ||
      input.expiresAt - input.approvedAt > this.policy.maximumCapacityApprovalMs
    ) {
      fail("CAPACITY_APPROVAL_INVALID", "Capacity approval expiry exceeds its allowed window.");
    }
    const releaseLimitRaised = input.maximumServingReleases > this.policy.normalMaxServingReleases;
    const generationLimitRaised =
      input.maximumServingGenerationsPerMember > this.policy.normalMaxServingGenerationsPerMember;
    if (
      input.maximumServingReleases < this.policy.normalMaxServingReleases ||
      input.maximumServingReleases > this.policy.hardMaxServingReleases ||
      input.maximumServingGenerationsPerMember < this.policy.normalMaxServingGenerationsPerMember ||
      input.maximumServingGenerationsPerMember > this.policy.hardMaxServingGenerationsPerMember ||
      (!releaseLimitRaised && !generationLimitRaised)
    ) {
      fail(
        "CAPACITY_APPROVAL_INVALID",
        "Capacity approval must raise at least one normal limit and stay at hard limits or below.",
      );
    }
    if (input.retirementReleaseIds.length === 0) {
      fail(
        "CAPACITY_APPROVAL_INVALID",
        "Capacity approval must name at least one Release to retire.",
      );
    }
    for (const releaseId of unique(input.retirementReleaseIds)) {
      const release = requireRecord(this.#state.releases, releaseId, "Release");
      if (
        release.projectId !== input.projectId ||
        release.state !== "PUBLISHED" ||
        release.supportUntil === null ||
        release.supportUntil > input.expiresAt
      ) {
        fail(
          "CAPACITY_APPROVAL_INVALID",
          `Release ${releaseId} cannot be retired by the approval deadline without violating support.`,
        );
      }
    }

    this.#state.capacityApprovals[input.id] = {
      ...structuredClone(input),
      retirementReleaseIds: unique(input.retirementReleaseIds),
    };
    this.#bumpState();
  }

  publish(input: PublishInput): void {
    this.#assertControlRevision(input.expectedControlRevision);
    const release = requireRecord(this.#state.releases, input.releaseId, "Release");
    if (release.state !== "STAGED") {
      fail("INVALID_STATE", `Release ${release.id} is not STAGED.`);
    }
    const activation = this.#requireReadyActivation(input.activationId);
    if (activation.releaseId !== release.id || activation.projectId !== release.projectId) {
      fail("INVALID_STATE", "Publish Activation does not bind the target Release.");
    }
    this.#validateActivation(activation, true);

    const supportUntil = input.supportUntil ?? input.at + this.policy.minimumReleaseSupportMs;
    if (supportUntil < input.at + this.policy.minimumReleaseSupportMs) {
      fail("INVALID_STATE", "Published Release support window is shorter than the policy minimum.");
    }

    const proposedHeads = { ...this.#currentHeadActivations(), [release.id]: activation.id };
    this.#assertCapacity(release.projectId, proposedHeads, input.at, input.capacityApprovalId);

    const previouslyServing = this.#servingContentIds();
    release.state = "PUBLISHED";
    release.publishedAt = input.at;
    release.supportUntil = supportUntil;
    this.#state.servingHeads[release.id] = {
      releaseId: release.id,
      activationId: activation.id,
      updatedAt: input.at,
    };
    this.#state.channels[channelKey(release.projectId, input.channel)] = {
      projectId: release.projectId,
      channel: input.channel,
      activationId: activation.id,
      updatedAt: input.at,
    };
    this.#recordServingTransitions(previouslyServing, input.at);
    this.#bumpControl();
  }

  refresh(input: RefreshInput): void {
    this.#assertControlRevision(input.expectedControlRevision);
    if (input.replacements.length === 0) {
      fail("INVALID_STATE", "Refresh requires at least one Serving Head replacement.");
    }

    const replacementByRelease: Record<string, string> = {};
    let projectId: string | undefined;
    for (const replacement of input.replacements) {
      if (replacement.releaseId in replacementByRelease) {
        fail("INVALID_STATE", `Duplicate refresh replacement for ${replacement.releaseId}.`);
      }
      const release = requireRecord(this.#state.releases, replacement.releaseId, "Release");
      if (release.state !== "PUBLISHED") {
        fail("RELEASE_NOT_SERVING", `Release ${release.id} is not published.`);
      }
      requireRecord(this.#state.servingHeads, release.id, "Serving Head");
      const activation = this.#requireReadyActivation(replacement.activationId);
      if (activation.releaseId !== release.id || activation.projectId !== release.projectId) {
        fail("INVALID_STATE", "Refresh Activation does not bind its target Release.");
      }
      this.#validateActivation(activation, true);
      if (projectId !== undefined && projectId !== release.projectId) {
        fail("INVALID_STATE", "One refresh transaction cannot span projects.");
      }
      projectId = release.projectId;
      replacementByRelease[release.id] = activation.id;
    }
    if (projectId === undefined) fail("INVALID_STATE", "Refresh project is missing.");

    const proposedHeads = { ...this.#currentHeadActivations(), ...replacementByRelease };
    this.#assertCapacity(projectId, proposedHeads, input.at, input.capacityApprovalId);

    const previouslyServing = this.#servingContentIds();
    for (const [releaseId, activationId] of Object.entries(replacementByRelease)) {
      this.#state.servingHeads[releaseId] = { releaseId, activationId, updatedAt: input.at };
    }
    for (const pointer of Object.values(this.#state.channels)) {
      const currentActivation = this.#requireReadyActivation(pointer.activationId);
      const replacementId = replacementByRelease[currentActivation.releaseId];
      if (replacementId !== undefined) {
        pointer.activationId = replacementId;
        pointer.updatedAt = input.at;
      }
    }
    this.#recordServingTransitions(previouslyServing, input.at);
    this.#bumpControl();
  }

  retireRelease(releaseId: string, expectedControlRevision: number, at: number): void {
    this.#assertControlRevision(expectedControlRevision);
    const release = requireRecord(this.#state.releases, releaseId, "Release");
    if (release.state !== "PUBLISHED" || release.supportUntil === null) {
      fail("RELEASE_NOT_SERVING", `Release ${releaseId} is not published.`);
    }
    if (at < release.supportUntil) {
      fail(
        "SUPPORT_WINDOW_ACTIVE",
        `Release ${releaseId} remains supported until ${release.supportUntil}.`,
      );
    }
    for (const pointer of Object.values(this.#state.channels)) {
      const activation = this.#requireReadyActivation(pointer.activationId);
      if (activation.releaseId === releaseId) {
        fail("INVALID_STATE", `Channel ${pointer.channel} still points at Release ${releaseId}.`);
      }
    }

    const previouslyServing = this.#servingContentIds();
    delete this.#state.servingHeads[releaseId];
    release.state = "RETIRED";
    release.retiredAt = at;
    this.#recordServingTransitions(previouslyServing, at);
    this.#bumpControl();
  }

  resolve(selector: RuntimeSelector): ResolvedActivation {
    const activation = this.#resolveActivation(selector);
    return {
      activationId: activation.id,
      releaseId: activation.releaseId,
      releaseManifestHash: activation.releaseManifestHash,
    };
  }

  beginQuery(input: {
    id: string;
    selector: RuntimeSelector;
    startedAt: number;
    leaseUntil: number;
  }): ResolvedActivation {
    assertUnusedId(this.#state.queries, input.id, "Query");
    if (
      input.leaseUntil <= input.startedAt ||
      input.leaseUntil - input.startedAt > this.policy.maximumQueryLeaseMs
    ) {
      fail("INVALID_STATE", "Query lease is outside the allowed duration.");
    }
    const activation = this.#resolveActivation(input.selector);
    this.#state.queries[input.id] = {
      id: input.id,
      selector: structuredClone(input.selector),
      activationId: activation.id,
      resolutionCount: 1,
      startedAt: input.startedAt,
      leaseUntil: input.leaseUntil,
      state: "ACTIVE",
    };
    this.#bumpState();
    return {
      activationId: activation.id,
      releaseId: activation.releaseId,
      releaseManifestHash: activation.releaseManifestHash,
    };
  }

  renewQueryLease(queryId: string, at: number, leaseUntil: number): void {
    const query = requireRecord(this.#state.queries, queryId, "Query");
    if (query.state !== "ACTIVE" || query.leaseUntil <= at) {
      fail("QUERY_LEASE_EXPIRED", `Query ${queryId} is no longer active.`);
    }
    if (leaseUntil <= at || leaseUntil - at > this.policy.maximumQueryLeaseMs) {
      fail("INVALID_STATE", "Renewed Query lease is outside the allowed duration.");
    }
    query.leaseUntil = leaseUntil;
    this.#bumpState();
  }

  readQueryMember(queryId: string, memberKey: string, at: number): ActivationMember {
    const query = requireRecord(this.#state.queries, queryId, "Query");
    if (query.state !== "ACTIVE" || query.leaseUntil <= at) {
      fail("QUERY_LEASE_EXPIRED", `Query ${queryId} is no longer active.`);
    }
    const activation = this.#requireReadyActivation(query.activationId);
    return structuredClone(requireRecord(activation.members, memberKey, "Activation member"));
  }

  endQuery(queryId: string): void {
    const query = requireRecord(this.#state.queries, queryId, "Query");
    if (query.state !== "ACTIVE") fail("INVALID_STATE", `Query ${queryId} already ended.`);
    query.state = "ENDED";
    this.#bumpState();
  }

  issuePreflight(input: {
    id: string;
    selector: RuntimeSelector;
    issuedAt: number;
    expiresAt: number;
  }): ResolvedActivation {
    assertUnusedId(this.#state.preflightTokens, input.id, "Preflight token");
    if (
      input.expiresAt <= input.issuedAt ||
      input.expiresAt - input.issuedAt > this.policy.maximumPreflightTtlMs
    ) {
      fail("INVALID_STATE", "Preflight token TTL is outside the allowed duration.");
    }
    const activation = this.#resolveActivation(input.selector);
    this.#state.preflightTokens[input.id] = {
      id: input.id,
      selector: structuredClone(input.selector),
      activationId: activation.id,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      state: "ACTIVE",
    };
    this.#bumpState();
    return {
      activationId: activation.id,
      releaseId: activation.releaseId,
      releaseManifestHash: activation.releaseManifestHash,
    };
  }

  applyPreflight(tokenId: string, at: number): ResolvedActivation {
    const token = requireRecord(this.#state.preflightTokens, tokenId, "Preflight token");
    if (token.state !== "ACTIVE") {
      fail("INVALID_STATE", `Preflight token ${tokenId} is ${token.state}.`);
    }
    if (token.expiresAt <= at) {
      fail("PREFLIGHT_TOKEN_EXPIRED", `Preflight token ${tokenId} expired.`);
    }

    let current: ActivationRecord;
    try {
      current = this.#resolveActivation(token.selector);
    } catch (error) {
      if (error instanceof RuntimeModelError) {
        token.state = "STALE";
        this.#bumpState();
        fail("PREFLIGHT_STALE", `Preflight token ${tokenId} no longer resolves its Activation.`);
      }
      throw error;
    }
    if (current.id !== token.activationId) {
      token.state = "STALE";
      this.#bumpState();
      fail("PREFLIGHT_STALE", `Preflight token ${tokenId} binds an old Activation.`);
    }

    token.state = "USED";
    this.#bumpState();
    return {
      activationId: current.id,
      releaseId: current.releaseId,
      releaseManifestHash: current.releaseManifestHash,
    };
  }

  startJob(id: string, references: ContentReferencesInput): void {
    assertUnusedId(this.#state.jobs, id, "Job");
    const normalized = normalizeReferences(references);
    this.#assertReferencesAvailable(normalized);
    this.#state.jobs[id] = { id, references: normalized, state: "ACTIVE" };
    this.#bumpState();
  }

  completeJob(id: string, state: "COMPLETED" | "CANCELLED" = "COMPLETED"): void {
    const job = requireRecord(this.#state.jobs, id, "Job");
    if (job.state !== "ACTIVE") fail("INVALID_STATE", `Job ${id} is already terminal.`);
    job.state = state;
    this.#bumpState();
  }

  placeHold(id: string, references: ContentReferencesInput, reason: string): void {
    assertUnusedId(this.#state.holds, id, "Hold");
    const normalized = normalizeReferences(references);
    this.#assertReferencesAvailable(normalized);
    if (reason.trim().length === 0) fail("INVALID_STATE", "Hold reason is required.");
    this.#state.holds[id] = { id, references: normalized, reason, state: "ACTIVE" };
    this.#bumpState();
  }

  releaseHold(id: string): void {
    const hold = requireRecord(this.#state.holds, id, "Hold");
    if (hold.state !== "ACTIVE") fail("INVALID_STATE", `Hold ${id} is already released.`);
    hold.state = "RELEASED";
    this.#bumpState();
  }

  addHistoricalReference(id: string, references: ContentReferencesInput): void {
    assertUnusedId(this.#state.historicalReferences, id, "Historical reference");
    const normalized = normalizeReferences(references);
    this.#assertReferencesAvailable(normalized);
    this.#state.historicalReferences[id] = { id, references: normalized };
    this.#bumpState();
  }

  planGarbageCollection(at: number): GarbageCollectionPlan {
    const protectedIds = this.#protectedIds(at, true);
    return {
      plannedAtStateRevision: this.#state.stateRevision,
      at,
      releaseIds: Object.values(this.#state.releases)
        .filter(
          (release) => release.state === "RETIRED" && !protectedIds.releaseIds.has(release.id),
        )
        .map((release) => release.id)
        .sort(),
      activationIds: Object.values(this.#state.activations)
        .filter(
          (activation) =>
            activation.state === "READY" && !protectedIds.activationIds.has(activation.id),
        )
        .map((activation) => activation.id)
        .sort(),
      generationIds: Object.values(this.#state.generations)
        .filter(
          (generation) =>
            generation.state === "READY" && !protectedIds.generationIds.has(generation.id),
        )
        .map((generation) => generation.id)
        .sort(),
      snapshotIds: Object.values(this.#state.snapshots)
        .filter(
          (snapshot) => snapshot.state === "READY" && !protectedIds.snapshotIds.has(snapshot.id),
        )
        .map((snapshot) => snapshot.id)
        .sort(),
    };
  }

  commitGarbageCollection(plan: GarbageCollectionPlan): void {
    if (plan.plannedAtStateRevision !== this.#state.stateRevision) {
      fail("CONCURRENT_MODIFICATION", "GC plan is stale because state or references changed.");
    }
    const protectedIds = this.#protectedIds(plan.at, true);
    assertNoIntersection(plan.releaseIds, protectedIds.releaseIds, "Release");
    assertNoIntersection(plan.activationIds, protectedIds.activationIds, "Activation");
    assertNoIntersection(plan.generationIds, protectedIds.generationIds, "Generation");
    assertNoIntersection(plan.snapshotIds, protectedIds.snapshotIds, "Snapshot");

    const count =
      plan.releaseIds.length +
      plan.activationIds.length +
      plan.generationIds.length +
      plan.snapshotIds.length;
    if (count === 0) return;

    for (const id of plan.releaseIds)
      requireRecord(this.#state.releases, id, "Release").state = "COLLECTED";
    for (const id of plan.activationIds) {
      requireRecord(this.#state.activations, id, "Activation").state = "COLLECTED";
    }
    for (const id of plan.generationIds) {
      requireRecord(this.#state.generations, id, "Generation").state = "COLLECTED";
    }
    for (const id of plan.snapshotIds) {
      requireRecord(this.#state.snapshots, id, "Snapshot").state = "COLLECTED";
    }
    this.#bumpState();
  }

  capacity(projectId: string): CapacitySnapshot {
    return this.#capacityForHeads(projectId, this.#currentHeadActivations());
  }

  assertInvariants(at: number): void {
    for (const pointer of Object.values(this.#state.channels)) {
      const activation = this.#requireReadyActivation(pointer.activationId);
      const release = requireRecord(this.#state.releases, activation.releaseId, "Release");
      if (release.state !== "PUBLISHED" || release.projectId !== pointer.projectId) {
        fail("INVALID_STATE", `Channel ${pointer.channel} does not target a published Release.`);
      }
      this.#validateActivation(activation, true);
    }

    for (const head of Object.values(this.#state.servingHeads)) {
      const release = requireRecord(this.#state.releases, head.releaseId, "Release");
      const activation = this.#requireReadyActivation(head.activationId);
      if (release.state !== "PUBLISHED" || activation.releaseId !== release.id) {
        fail("INVALID_STATE", `Serving Head ${head.releaseId} crosses a Release boundary.`);
      }
      this.#validateActivation(activation, true);
    }

    for (const release of Object.values(this.#state.releases)) {
      const hasHead = release.id in this.#state.servingHeads;
      if ((release.state === "PUBLISHED") !== hasHead) {
        fail("INVALID_STATE", `Release ${release.id} and its Serving Head disagree.`);
      }
      if (
        release.state === "PUBLISHED" &&
        (release.publishedAt === null ||
          release.supportUntil === null ||
          release.supportUntil - release.publishedAt < this.policy.minimumReleaseSupportMs)
      ) {
        fail("INVALID_STATE", `Release ${release.id} violates its minimum support window.`);
      }
    }

    for (const activation of Object.values(this.#state.activations)) {
      if (activation.state === "READY") this.#validateActivation(activation, true);
    }

    for (const query of Object.values(this.#state.queries)) {
      if (query.resolutionCount !== 1) {
        fail("INVALID_STATE", `Query ${query.id} resolved more than once.`);
      }
    }

    const protectedIds = this.#protectedIds(at, false);
    this.#assertProtectedContentReady(protectedIds);
    for (const projectId of unique(
      Object.values(this.#state.releases).map((release) => release.projectId),
    )) {
      const capacity = this.capacity(projectId);
      if (capacity.servingReleases > this.policy.hardMaxServingReleases) {
        fail("CAPACITY_HARD_LIMIT", `Project ${projectId} exceeds the hard Release limit.`);
      }
      for (const count of Object.values(capacity.generationsPerMember)) {
        if (count > this.policy.hardMaxServingGenerationsPerMember) {
          fail("CAPACITY_HARD_LIMIT", `Project ${projectId} exceeds the hard Generation limit.`);
        }
      }
    }
  }

  #resolveActivation(selector: RuntimeSelector): ActivationRecord {
    if (selector.kind === "channel") {
      const pointer = requireRecord(
        this.#state.channels,
        channelKey(selector.projectId, selector.channel),
        "Channel",
      );
      return this.#requireReadyActivation(pointer.activationId);
    }

    const release = requireRecord(this.#state.releases, selector.releaseId, "Release");
    if (release.state === "RETIRED" || release.state === "COLLECTED") {
      fail("RELEASE_RETIRED", `Release ${release.id} is retired.`);
    }
    if (release.state !== "PUBLISHED") {
      fail("RELEASE_NOT_SERVING", `Release ${release.id} is not serving.`);
    }
    const head = requireRecord(this.#state.servingHeads, release.id, "Serving Head");
    return this.#requireReadyActivation(head.activationId);
  }

  #validateActivation(activation: ActivationRecord, requireReadyContent: boolean): void {
    const release = requireRecord(this.#state.releases, activation.releaseId, "Release");
    if (
      release.state === "COLLECTED" ||
      activation.projectId !== release.projectId ||
      activation.releaseManifestHash !== release.manifestHash
    ) {
      fail(
        "PIN_GENERATION_MISMATCH",
        `Activation ${activation.id} has the wrong Release manifest.`,
      );
    }

    const pinKeys = Object.keys(release.pins).sort();
    const memberKeys = Object.keys(activation.members).sort();
    if (JSON.stringify(pinKeys) !== JSON.stringify(memberKeys)) {
      fail(
        "PIN_GENERATION_MISMATCH",
        `Activation ${activation.id} does not contain every Release pin.`,
      );
    }

    const groupVersions: Record<string, string> = {};
    for (const memberKey of pinKeys) {
      const pin = requireRecord(release.pins, memberKey, "Release pin");
      const member = requireRecord(activation.members, memberKey, "Activation member");
      const generation = requireRecord(this.#state.generations, member.generationId, "Generation");
      const snapshot = requireRecord(this.#state.snapshots, member.snapshotId, "Snapshot");
      if (
        generation.projectId !== activation.projectId ||
        generation.memberKey !== memberKey ||
        generation.snapshotId !== snapshot.id ||
        member.snapshotId !== snapshot.id
      ) {
        fail(
          "PIN_GENERATION_MISMATCH",
          `Activation ${activation.id} has a crossed Generation member.`,
        );
      }
      if (requireReadyContent && (generation.state !== "READY" || snapshot.state !== "READY")) {
        fail("CONTENT_COLLECTED", `Activation ${activation.id} uses collected content.`);
      }
      if (snapshot.groupKey !== pin.snapshotGroupKey) {
        fail("SNAPSHOT_GROUP_MISMATCH", `Activation ${activation.id} crosses Snapshot groups.`);
      }
      const existingVersion = groupVersions[snapshot.groupKey];
      if (existingVersion !== undefined && existingVersion !== snapshot.groupVersion) {
        fail(
          "SNAPSHOT_GROUP_MISMATCH",
          `Activation ${activation.id} mixes Snapshot group versions.`,
        );
      }
      groupVersions[snapshot.groupKey] = snapshot.groupVersion;

      const fingerprint = releasePinFingerprint(pin);
      const proof = generation.compatibilityByPin[fingerprint];
      if (
        proof === undefined ||
        proof.pinFingerprint !== fingerprint ||
        proof.schemaHash !== pin.schemaHash ||
        proof.mappingHash !== pin.mappingHash
      ) {
        fail(
          "PIN_GENERATION_MISMATCH",
          `Release ${release.id} pin ${memberKey} is not certified for Generation ${generation.id}.`,
        );
      }
    }
  }

  #requireUsableRelease(id: string): ReleaseRecord {
    const release = requireRecord(this.#state.releases, id, "Release");
    if (release.state === "RETIRED" || release.state === "COLLECTED") {
      fail("RELEASE_RETIRED", `Release ${id} cannot build new runtime content.`);
    }
    return release;
  }

  #requireReadySnapshot(id: string): SnapshotRecord {
    const snapshot = requireRecord(this.#state.snapshots, id, "Snapshot");
    if (snapshot.state !== "READY") fail("CONTENT_COLLECTED", `Snapshot ${id} was collected.`);
    return snapshot;
  }

  #requireReadyActivation(id: string): ActivationRecord {
    const activation = requireRecord(this.#state.activations, id, "Activation");
    if (activation.state !== "READY") fail("CONTENT_COLLECTED", `Activation ${id} was collected.`);
    return activation;
  }

  #assertReferencesAvailable(references: ContentReferences): void {
    const count =
      references.releaseIds.length +
      references.activationIds.length +
      references.generationIds.length +
      references.snapshotIds.length;
    if (count === 0) fail("INVALID_STATE", "At least one content reference is required.");

    for (const id of references.releaseIds) {
      const record = requireRecord(this.#state.releases, id, "Release");
      if (record.state === "COLLECTED") fail("CONTENT_COLLECTED", `Release ${id} was collected.`);
    }
    for (const id of references.activationIds) this.#requireReadyActivation(id);
    for (const id of references.generationIds) {
      const record = requireRecord(this.#state.generations, id, "Generation");
      if (record.state !== "READY") fail("CONTENT_COLLECTED", `Generation ${id} was collected.`);
    }
    for (const id of references.snapshotIds) this.#requireReadySnapshot(id);
  }

  #assertControlRevision(expected: number): void {
    if (expected !== this.#state.controlRevision) {
      fail(
        "CONCURRENT_MODIFICATION",
        `Expected control revision ${expected}, current ${this.#state.controlRevision}.`,
      );
    }
  }

  #assertCapacity(
    projectId: string,
    proposedHeads: Readonly<Record<string, string>>,
    at: number,
    capacityApprovalId: string | undefined,
  ): void {
    const current = this.#capacityForHeads(projectId, this.#currentHeadActivations());
    const proposed = this.#capacityForHeads(projectId, proposedHeads);
    if (
      proposed.servingReleases > this.policy.hardMaxServingReleases ||
      Object.values(proposed.generationsPerMember).some(
        (count) => count > this.policy.hardMaxServingGenerationsPerMember,
      )
    ) {
      fail("CAPACITY_HARD_LIMIT", `Project ${projectId} would exceed a hard serving limit.`);
    }

    const expandsReleaseOverage =
      proposed.servingReleases > this.policy.normalMaxServingReleases &&
      proposed.servingReleases > current.servingReleases;
    const expandsGenerationOverage = Object.entries(proposed.generationsPerMember).some(
      ([memberKey, count]) =>
        count > this.policy.normalMaxServingGenerationsPerMember &&
        count > (current.generationsPerMember[memberKey] ?? 0),
    );
    if (!expandsReleaseOverage && !expandsGenerationOverage) return;
    if (capacityApprovalId === undefined) {
      fail("CAPACITY_SOFT_LIMIT", `Project ${projectId} needs approved temporary capacity.`);
    }

    const approval = requireRecord(
      this.#state.capacityApprovals,
      capacityApprovalId,
      "Capacity approval",
    );
    const maxGenerationCount = Math.max(0, ...Object.values(proposed.generationsPerMember));
    if (
      approval.projectId !== projectId ||
      at < approval.approvedAt ||
      at >= approval.expiresAt ||
      proposed.servingReleases > approval.maximumServingReleases ||
      maxGenerationCount > approval.maximumServingGenerationsPerMember
    ) {
      fail(
        "CAPACITY_APPROVAL_INVALID",
        `Capacity approval ${approval.id} does not cover this cutover.`,
      );
    }
  }

  #capacityForHeads(projectId: string, heads: Readonly<Record<string, string>>): CapacitySnapshot {
    let servingReleases = 0;
    const generationsByMember: Record<string, Set<string>> = {};
    for (const [releaseId, activationId] of Object.entries(heads)) {
      const release = this.#state.releases[releaseId];
      if (
        release === undefined ||
        release.projectId !== projectId ||
        release.state === "COLLECTED"
      ) {
        continue;
      }
      const activation = requireRecord(this.#state.activations, activationId, "Activation");
      servingReleases += 1;
      for (const [memberKey, member] of Object.entries(activation.members)) {
        (generationsByMember[memberKey] ??= new Set<string>()).add(member.generationId);
      }
    }
    return {
      servingReleases,
      generationsPerMember: Object.fromEntries(
        Object.entries(generationsByMember).map(([memberKey, ids]) => [memberKey, ids.size]),
      ),
    };
  }

  #currentHeadActivations(): Record<string, string> {
    return Object.fromEntries(
      Object.values(this.#state.servingHeads).map((head) => [head.releaseId, head.activationId]),
    );
  }

  #protectedIds(at: number, includeRetention: boolean): ProtectedIds {
    const protectedIds: ProtectedIds = {
      releaseIds: new Set<string>(),
      activationIds: new Set<string>(),
      generationIds: new Set<string>(),
      snapshotIds: new Set<string>(),
    };

    for (const pointer of Object.values(this.#state.channels)) {
      protectedIds.activationIds.add(pointer.activationId);
    }
    for (const head of Object.values(this.#state.servingHeads)) {
      protectedIds.releaseIds.add(head.releaseId);
      protectedIds.activationIds.add(head.activationId);
    }
    for (const query of Object.values(this.#state.queries)) {
      if (query.state === "ACTIVE" && query.leaseUntil > at) {
        protectedIds.activationIds.add(query.activationId);
      }
    }
    for (const token of Object.values(this.#state.preflightTokens)) {
      if (token.state === "ACTIVE" && token.expiresAt > at) {
        protectedIds.activationIds.add(token.activationId);
      }
    }
    for (const job of Object.values(this.#state.jobs)) {
      if (job.state === "ACTIVE") addReferences(protectedIds, job.references);
    }
    for (const hold of Object.values(this.#state.holds)) {
      if (hold.state === "ACTIVE") addReferences(protectedIds, hold.references);
    }
    for (const reference of Object.values(this.#state.historicalReferences)) {
      addReferences(protectedIds, reference.references);
    }

    this.#expandProtectedGraph(protectedIds);
    if (!includeRetention) return protectedIds;

    const cutoff = at - this.policy.minimumInactiveRetentionMs;
    const baseProtectedGenerationIds = new Set(protectedIds.generationIds);
    const inactiveGenerationsByMember: Record<string, GenerationRecord[]> = {};
    for (const generation of Object.values(this.#state.generations)) {
      if (generation.state !== "READY" || baseProtectedGenerationIds.has(generation.id)) continue;
      const key = JSON.stringify([generation.projectId, generation.memberKey]);
      (inactiveGenerationsByMember[key] ??= []).push(generation);
    }
    for (const generations of Object.values(inactiveGenerationsByMember)) {
      generations
        .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
        .slice(0, this.policy.inactiveGenerationRetentionCount)
        .forEach((generation) => protectedIds.generationIds.add(generation.id));
    }

    for (const release of Object.values(this.#state.releases)) {
      if (
        release.state === "STAGED" ||
        (release.retiredAt !== null && release.retiredAt > cutoff)
      ) {
        protectedIds.releaseIds.add(release.id);
      }
    }
    for (const activation of Object.values(this.#state.activations)) {
      if (
        activation.state === "READY" &&
        Math.max(activation.createdAt, activation.lastServingAt ?? activation.createdAt) > cutoff
      ) {
        protectedIds.activationIds.add(activation.id);
      }
    }
    for (const snapshot of Object.values(this.#state.snapshots)) {
      if (
        snapshot.state === "READY" &&
        Math.max(snapshot.createdAt, snapshot.lastServingAt ?? snapshot.createdAt) > cutoff
      ) {
        protectedIds.snapshotIds.add(snapshot.id);
      }
    }

    for (const generation of Object.values(this.#state.generations)) {
      if (generation.state !== "READY") continue;
      if (
        Math.max(generation.createdAt, generation.lastServingAt ?? generation.createdAt) > cutoff
      ) {
        protectedIds.generationIds.add(generation.id);
      }
    }
    this.#expandProtectedGraph(protectedIds);
    return protectedIds;
  }

  #expandProtectedGraph(protectedIds: ProtectedIds): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const activationId of [...protectedIds.activationIds]) {
        const activation = this.#state.activations[activationId];
        if (activation === undefined) continue;
        changed = addToSet(protectedIds.releaseIds, activation.releaseId) || changed;
        for (const member of Object.values(activation.members)) {
          changed = addToSet(protectedIds.generationIds, member.generationId) || changed;
          changed = addToSet(protectedIds.snapshotIds, member.snapshotId) || changed;
        }
      }
      for (const generationId of [...protectedIds.generationIds]) {
        const generation = this.#state.generations[generationId];
        if (generation !== undefined) {
          changed = addToSet(protectedIds.snapshotIds, generation.snapshotId) || changed;
        }
      }
    }
  }

  #servingContentIds(): {
    activationIds: Set<string>;
    generationIds: Set<string>;
    snapshotIds: Set<string>;
  } {
    const result = {
      activationIds: new Set<string>(),
      generationIds: new Set<string>(),
      snapshotIds: new Set<string>(),
    };
    for (const head of Object.values(this.#state.servingHeads)) {
      const activation = this.#state.activations[head.activationId];
      if (activation === undefined || activation.state !== "READY") continue;
      result.activationIds.add(activation.id);
      for (const member of Object.values(activation.members)) {
        result.generationIds.add(member.generationId);
        result.snapshotIds.add(member.snapshotId);
      }
    }
    return result;
  }

  #recordServingTransitions(
    previouslyServing: {
      activationIds: ReadonlySet<string>;
      generationIds: ReadonlySet<string>;
      snapshotIds: ReadonlySet<string>;
    },
    at: number,
  ): void {
    const currentlyServing = this.#servingContentIds();
    for (const id of previouslyServing.activationIds) {
      if (!currentlyServing.activationIds.has(id)) {
        requireRecord(this.#state.activations, id, "Activation").lastServingAt = at;
      }
    }
    for (const id of previouslyServing.generationIds) {
      if (!currentlyServing.generationIds.has(id)) {
        requireRecord(this.#state.generations, id, "Generation").lastServingAt = at;
      }
    }
    for (const id of previouslyServing.snapshotIds) {
      if (!currentlyServing.snapshotIds.has(id)) {
        requireRecord(this.#state.snapshots, id, "Snapshot").lastServingAt = at;
      }
    }
  }

  #assertProtectedContentReady(protectedIds: ProtectedIds): void {
    for (const id of protectedIds.releaseIds) {
      const record = requireRecord(this.#state.releases, id, "Release");
      if (record.state === "COLLECTED")
        fail("CONTENT_COLLECTED", `Protected Release ${id} was collected.`);
    }
    for (const id of protectedIds.activationIds) this.#requireReadyActivation(id);
    for (const id of protectedIds.generationIds) {
      const record = requireRecord(this.#state.generations, id, "Generation");
      if (record.state !== "READY")
        fail("CONTENT_COLLECTED", `Protected Generation ${id} was collected.`);
    }
    for (const id of protectedIds.snapshotIds) this.#requireReadySnapshot(id);
  }

  #bumpState(): void {
    this.#state.stateRevision += 1;
  }

  #bumpControl(): void {
    this.#state.controlRevision += 1;
    this.#state.stateRevision += 1;
  }
}

function emptyState(): RuntimeState {
  return {
    controlRevision: 0,
    stateRevision: 0,
    releases: {},
    snapshots: {},
    generations: {},
    activations: {},
    channels: {},
    servingHeads: {},
    queries: {},
    preflightTokens: {},
    jobs: {},
    holds: {},
    historicalReferences: {},
    capacityApprovals: {},
  };
}

function assertPolicy(policy: RuntimePolicy): void {
  const values = Object.values(policy);
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    fail("INVALID_STATE", "Runtime policy values must be positive safe integers.");
  }
  if (
    policy.normalMaxServingReleases >= policy.hardMaxServingReleases ||
    policy.normalMaxServingGenerationsPerMember >= policy.hardMaxServingGenerationsPerMember
  ) {
    fail("INVALID_STATE", "Normal capacity limits must be lower than hard limits.");
  }
}

function channelKey(projectId: string, channel: string): string {
  return JSON.stringify([projectId, channel]);
}

function normalizeReferences(input: ContentReferencesInput): ContentReferences {
  return {
    releaseIds: unique(input.releaseIds ?? []),
    activationIds: unique(input.activationIds ?? []),
    generationIds: unique(input.generationIds ?? []),
    snapshotIds: unique(input.snapshotIds ?? []),
  };
}

function addReferences(target: ProtectedIds, references: ContentReferences): void {
  references.releaseIds.forEach((id) => target.releaseIds.add(id));
  references.activationIds.forEach((id) => target.activationIds.add(id));
  references.generationIds.forEach((id) => target.generationIds.add(id));
  references.snapshotIds.forEach((id) => target.snapshotIds.add(id));
}

function addToSet(set: Set<string>, value: string): boolean {
  const size = set.size;
  set.add(value);
  return set.size !== size;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function requireRecord<T>(record: Readonly<Record<string, T>>, id: string, kind: string): T {
  const value = record[id];
  if (value === undefined) fail("NOT_FOUND", `${kind} ${id} was not found.`);
  return value;
}

function assertUnusedId<T>(record: Readonly<Record<string, T>>, id: string, kind: string): void {
  if (id in record) fail("ALREADY_EXISTS", `${kind} ${id} already exists.`);
}

function assertNoIntersection(
  ids: readonly string[],
  protectedIds: ReadonlySet<string>,
  kind: string,
): void {
  const protectedId = ids.find((id) => protectedIds.has(id));
  if (protectedId !== undefined) {
    fail("INVALID_STATE", `GC plan contains protected ${kind} ${protectedId}.`);
  }
}

function fail(code: RuntimeErrorCode, message: string): never {
  throw new RuntimeModelError(code, message);
}
