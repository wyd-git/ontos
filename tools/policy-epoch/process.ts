import {
  MAX_POSTGRES_EPOCH,
  MAX_POLICY_CACHE_TTL_MS,
  PolicyHarnessError,
  actorFingerprint,
  assertDuration,
  assertIdentifier,
  copyIdentifierList,
  delegationFingerprint,
  encodeTuple,
  opaqueCorrelationRef,
  opaqueProjectRef,
  type AuthorizationSnapshot,
  type AuthorizationSnapshotReader,
  type Clock,
  type CompiledPolicyArtifact,
  type CompiledPolicyReader,
  type EpochNotification,
  type EpochNotificationBus,
  type IdentityType,
  type PolicyFailureCode,
} from "./model.ts";

export interface PolicyIdentityContext {
  subjectId: string;
  identityType: IdentityType;
  groupPrincipalIds: readonly string[];
}

export interface PolicyDecisionRequest {
  projectId: string;
  identity: PolicyIdentityContext;
  delegationChain: readonly string[];
  resourceId: string;
  permission: string;
  releaseId: string;
  policyRevision: string;
  compilerVersion: string;
  correlationId: string;
}

interface NormalizedPolicyDecisionRequest extends PolicyDecisionRequest {
  identity: PolicyIdentityContext;
  delegationChain: readonly string[];
}

export interface PolicyDecisionCacheKey {
  projectId: string;
  actorFingerprint: string;
  delegationFingerprint: string;
  resourceId: string;
  permission: string;
  releaseId: string;
  policyRevision: string;
  compilerVersion: string;
  epoch: string;
}

export type PolicyDecisionResult =
  | {
      decision: "ALLOW" | "DENY";
      source: "CACHE" | "FRESH";
      epoch: string;
      errorCode: null;
    }
  | {
      decision: "DENY";
      source: "FAIL_CLOSED";
      epoch: null;
      errorCode: PolicyFailureCode;
    };

export interface PolicyFailureObservation {
  eventName: "policy_decision_failed_closed";
  code: PolicyFailureCode;
  processId: string;
  projectRef: string;
  correlationRef: string;
}

interface CachedDecision {
  readonly key: Readonly<PolicyDecisionCacheKey>;
  readonly fullKey: string;
  readonly result: "ALLOW" | "DENY";
  readonly confirmedAtMonotonic: number;
  readonly expiresAtMonotonic: number;
  readonly observedDatabaseAt: number;
  readonly artifactDigest: string;
}

export interface PolicyDecisionProcessOptions {
  processId: string;
  cacheTtlMs?: number;
  monotonicClock: Clock;
  authorizationStore: AuthorizationSnapshotReader;
  compiledPolicies: CompiledPolicyReader;
  notifications: EpochNotificationBus;
  observeFailure?: (observation: PolicyFailureObservation) => void;
}

export class PolicyDecisionProcess {
  readonly #processId: string;
  readonly #cacheTtlMs: number;
  readonly #monotonicClock: Clock;
  readonly #authorizationStore: AuthorizationSnapshotReader;
  readonly #compiledPolicies: CompiledPolicyReader;
  readonly #observeFailure: ((observation: PolicyFailureObservation) => void) | undefined;
  readonly #cache = new Map<string, CachedDecision>();
  readonly #epochFloor = new Map<string, bigint>();
  readonly #unsubscribe: () => void;
  #lastMonotonic: number | null = null;
  #clockUnsafe = false;

  constructor(options: PolicyDecisionProcessOptions) {
    assertIdentifier(options.processId, "processId");
    const cacheTtlMs = options.cacheTtlMs ?? MAX_POLICY_CACHE_TTL_MS;
    assertDuration(cacheTtlMs, "cacheTtlMs");
    if (cacheTtlMs > MAX_POLICY_CACHE_TTL_MS) {
      throw new PolicyHarnessError(
        "POLICY_INPUT_INVALID",
        "cacheTtlMs exceeds the five second hard limit.",
      );
    }
    this.#processId = options.processId;
    this.#cacheTtlMs = cacheTtlMs;
    this.#monotonicClock = options.monotonicClock;
    this.#authorizationStore = options.authorizationStore;
    this.#compiledPolicies = options.compiledPolicies;
    this.#observeFailure = options.observeFailure;
    this.#unsubscribe = options.notifications.subscribe(options.processId, (notification) => {
      this.observeNotification(notification);
    });
  }

  decide(input: PolicyDecisionRequest): PolicyDecisionResult {
    let request: NormalizedPolicyDecisionRequest;
    try {
      request = normalizeDecisionRequest(input);
    } catch {
      return this.#failClosed("POLICY_INPUT_INVALID", null);
    }

    let lookupAt: number;
    try {
      lookupAt = this.#observeMonotonicClock();
    } catch {
      return this.#failClosed("POLICY_MONOTONIC_CLOCK_UNSAFE", request);
    }

    const baseKey = createPolicyCacheBaseKey(request);
    const cached = this.#cache.get(baseKey);
    const floor = this.#epochFloor.get(request.projectId) ?? 1n;
    if (
      cached !== undefined &&
      lookupAt < cached.expiresAtMonotonic &&
      BigInt(cached.key.epoch) >= floor
    ) {
      return Object.freeze({
        decision: cached.result,
        source: "CACHE",
        epoch: cached.key.epoch,
        errorCode: null,
      });
    }
    this.#cache.delete(baseKey);

    let snapshot: AuthorizationSnapshot;
    try {
      snapshot = this.#authorizationStore.readAuthorizationSnapshot({
        projectId: request.projectId,
        actorPrincipalIds: Object.freeze([
          request.identity.subjectId,
          ...request.identity.groupPrincipalIds,
        ]),
        delegationChain: request.delegationChain,
        resourceId: request.resourceId,
        permission: request.permission,
      });
    } catch {
      return this.#failClosed("POLICY_EPOCH_UNAVAILABLE", request);
    }
    if (!isConfirmedSnapshot(snapshot, request)) {
      return this.#failClosed("POLICY_EPOCH_UNAVAILABLE", request);
    }

    if (snapshot.epoch < floor) {
      return this.#failClosed("POLICY_EPOCH_UNCONFIRMED", request);
    }

    let artifact: CompiledPolicyArtifact;
    try {
      artifact = this.#compiledPolicies.getCompiledPolicy({
        projectId: request.projectId,
        releaseId: request.releaseId,
        policyRevision: request.policyRevision,
        compilerVersion: request.compilerVersion,
      });
    } catch (error) {
      const code =
        error instanceof PolicyHarnessError && error.code === "POLICY_ARTIFACT_NOT_FOUND"
          ? "POLICY_ARTIFACT_NOT_FOUND"
          : "POLICY_ARTIFACT_UNAVAILABLE";
      return this.#failClosed(code, request);
    }
    if (!isExactCompiledArtifact(artifact, request)) {
      return this.#failClosed("POLICY_ARTIFACT_UNAVAILABLE", request);
    }

    // A notification may arrive while dependencies are read. Never cache a
    // snapshot that is already below the process's new Epoch floor.
    const finalFloor = this.#epochFloor.get(request.projectId) ?? 1n;
    if (snapshot.epoch < finalFloor) {
      return this.#failClosed("POLICY_EPOCH_UNCONFIRMED", request);
    }
    if (artifact.evaluationContract !== "RESOURCE_PERMISSION_INTERSECTION_V1") {
      return this.#failClosed("POLICY_ARTIFACT_UNAVAILABLE", request);
    }

    let confirmedAt: number;
    try {
      confirmedAt = this.#observeMonotonicClock();
    } catch {
      return this.#failClosed("POLICY_MONOTONIC_CLOCK_UNSAFE", request);
    }
    const expiresAt = confirmedAt + this.#cacheTtlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      this.#markClockUnsafe();
      return this.#failClosed("POLICY_MONOTONIC_CLOCK_UNSAFE", request);
    }

    const decision =
      snapshot.actorAllowed && snapshot.delegationAllowed.every(Boolean) ? "ALLOW" : "DENY";
    const key = createPolicyDecisionCacheKey(request, snapshot.epoch);
    this.#raiseEpochFloor(request.projectId, snapshot.epoch);
    this.#cache.set(
      baseKey,
      Object.freeze({
        key,
        fullKey: serializePolicyDecisionCacheKey(key),
        result: decision,
        confirmedAtMonotonic: confirmedAt,
        expiresAtMonotonic: expiresAt,
        observedDatabaseAt: snapshot.observedDatabaseAt,
        artifactDigest: artifact.artifactDigest,
      }),
    );
    return Object.freeze({
      decision,
      source: "FRESH",
      epoch: snapshot.epoch.toString(),
      errorCode: null,
    });
  }

  observeNotification(notification: EpochNotification): void {
    if (
      notification.protocolVersion !== 1 ||
      typeof notification.projectId !== "string" ||
      notification.projectId.length === 0 ||
      notification.epoch < 1n ||
      notification.epoch > MAX_POSTGRES_EPOCH
    ) {
      return;
    }
    const current = this.#epochFloor.get(notification.projectId) ?? 1n;
    if (notification.epoch <= current) return;
    this.#epochFloor.set(notification.projectId, notification.epoch);
    for (const [baseKey, cached] of this.#cache) {
      if (cached.key.projectId === notification.projectId) this.#cache.delete(baseKey);
    }
  }

  dispose(): void {
    this.#unsubscribe();
    this.#cache.clear();
  }

  get cacheSize(): number {
    return this.#cache.size;
  }

  epochFloor(projectId: string): bigint {
    assertIdentifier(projectId, "projectId");
    return this.#epochFloor.get(projectId) ?? 1n;
  }

  inspectCacheForTest(): readonly Readonly<{
    key: Readonly<PolicyDecisionCacheKey>;
    fullKey: string;
    result: "ALLOW" | "DENY";
    confirmedAtMonotonic: number;
    expiresAtMonotonic: number;
    observedDatabaseAt: number;
    artifactDigest: string;
  }>[] {
    return Object.freeze(
      [...this.#cache.values()].map((entry) =>
        Object.freeze({
          key: entry.key,
          fullKey: entry.fullKey,
          result: entry.result,
          confirmedAtMonotonic: entry.confirmedAtMonotonic,
          expiresAtMonotonic: entry.expiresAtMonotonic,
          observedDatabaseAt: entry.observedDatabaseAt,
          artifactDigest: entry.artifactDigest,
        }),
      ),
    );
  }

  #observeMonotonicClock(): number {
    if (this.#clockUnsafe) {
      throw new PolicyHarnessError(
        "POLICY_MONOTONIC_CLOCK_UNSAFE",
        "The process monotonic clock is unsafe.",
      );
    }
    let now: number;
    try {
      now = this.#monotonicClock.now();
    } catch {
      this.#markClockUnsafe();
      throw new PolicyHarnessError(
        "POLICY_MONOTONIC_CLOCK_UNSAFE",
        "The process monotonic clock is unsafe.",
      );
    }
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      (this.#lastMonotonic !== null && now < this.#lastMonotonic)
    ) {
      this.#markClockUnsafe();
      throw new PolicyHarnessError(
        "POLICY_MONOTONIC_CLOCK_UNSAFE",
        "The process monotonic clock is unsafe.",
      );
    }
    this.#lastMonotonic = now;
    return now;
  }

  #markClockUnsafe(): void {
    this.#clockUnsafe = true;
    this.#cache.clear();
  }

  #raiseEpochFloor(projectId: string, epoch: bigint): void {
    const current = this.#epochFloor.get(projectId) ?? 1n;
    if (epoch > current) this.#epochFloor.set(projectId, epoch);
  }

  #failClosed(
    code: PolicyFailureCode,
    request: NormalizedPolicyDecisionRequest | null,
  ): PolicyDecisionResult {
    const observation: PolicyFailureObservation = Object.freeze({
      eventName: "policy_decision_failed_closed",
      code,
      processId: this.#processId,
      projectRef: request === null ? "invalid" : opaqueProjectRef(request.projectId),
      correlationRef: request === null ? "invalid" : opaqueCorrelationRef(request.correlationId),
    });
    try {
      this.#observeFailure?.(observation);
    } catch {
      // Telemetry is never part of the authorization decision or availability path.
    }
    return Object.freeze({
      decision: "DENY",
      source: "FAIL_CLOSED",
      epoch: null,
      errorCode: code,
    });
  }
}

export function createPolicyDecisionCacheKey(
  input: PolicyDecisionRequest,
  epoch: bigint,
): Readonly<PolicyDecisionCacheKey> {
  const request = normalizeDecisionRequest(input);
  if (epoch < 1n || epoch > MAX_POSTGRES_EPOCH) {
    throw new PolicyHarnessError("POLICY_INPUT_INVALID", "epoch is invalid.");
  }
  return Object.freeze({
    projectId: request.projectId,
    actorFingerprint: actorFingerprint(request.identity),
    delegationFingerprint: delegationFingerprint(request.delegationChain),
    resourceId: request.resourceId,
    permission: request.permission,
    releaseId: request.releaseId,
    policyRevision: request.policyRevision,
    compilerVersion: request.compilerVersion,
    epoch: epoch.toString(),
  });
}

export function serializePolicyDecisionCacheKey(key: PolicyDecisionCacheKey): string {
  return encodeTuple([
    "policy-decision-v1",
    key.projectId,
    key.actorFingerprint,
    key.delegationFingerprint,
    key.resourceId,
    key.permission,
    key.releaseId,
    key.policyRevision,
    key.compilerVersion,
    key.epoch,
  ]);
}

function createPolicyCacheBaseKey(request: NormalizedPolicyDecisionRequest): string {
  return encodeTuple([
    "policy-decision-base-v1",
    request.projectId,
    actorFingerprint(request.identity),
    delegationFingerprint(request.delegationChain),
    request.resourceId,
    request.permission,
    request.releaseId,
    request.policyRevision,
    request.compilerVersion,
  ]);
}

function normalizeDecisionRequest(input: PolicyDecisionRequest): NormalizedPolicyDecisionRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PolicyHarnessError("POLICY_INPUT_INVALID", "Policy request is invalid.");
  }
  assertIdentifier(input.projectId, "projectId");
  if (typeof input.identity !== "object" || input.identity === null) {
    throw new PolicyHarnessError("POLICY_INPUT_INVALID", "identity is invalid.");
  }
  assertIdentifier(input.identity.subjectId, "subjectId");
  if (input.identity.identityType !== "human" && input.identity.identityType !== "service") {
    throw new PolicyHarnessError("POLICY_INPUT_INVALID", "identityType is invalid.");
  }
  const groupPrincipalIds = copyIdentifierList(
    input.identity.groupPrincipalIds,
    "groupPrincipalIds",
    128,
    false,
  );
  actorFingerprint({
    subjectId: input.identity.subjectId,
    identityType: input.identity.identityType,
    groupPrincipalIds,
  });
  if (groupPrincipalIds.includes(input.identity.subjectId)) {
    throw new PolicyHarnessError(
      "POLICY_INPUT_INVALID",
      "subjectId cannot be repeated as a Group Principal.",
    );
  }
  const delegationChain = copyIdentifierList(input.delegationChain, "delegationChain", 16, false);
  delegationFingerprint(delegationChain);
  assertIdentifier(input.resourceId, "resourceId");
  assertIdentifier(input.permission, "permission");
  assertIdentifier(input.releaseId, "releaseId");
  assertIdentifier(input.policyRevision, "policyRevision");
  assertIdentifier(input.compilerVersion, "compilerVersion");
  assertIdentifier(input.correlationId, "correlationId");
  return Object.freeze({
    projectId: input.projectId,
    identity: Object.freeze({
      subjectId: input.identity.subjectId,
      identityType: input.identity.identityType,
      groupPrincipalIds: Object.freeze(groupPrincipalIds.sort()),
    }),
    delegationChain: Object.freeze(delegationChain),
    resourceId: input.resourceId,
    permission: input.permission,
    releaseId: input.releaseId,
    policyRevision: input.policyRevision,
    compilerVersion: input.compilerVersion,
    correlationId: input.correlationId,
  });
}

function isConfirmedSnapshot(
  snapshot: AuthorizationSnapshot,
  request: NormalizedPolicyDecisionRequest,
): boolean {
  return (
    typeof snapshot === "object" &&
    snapshot !== null &&
    snapshot.projectId === request.projectId &&
    typeof snapshot.epoch === "bigint" &&
    snapshot.epoch >= 1n &&
    snapshot.epoch <= MAX_POSTGRES_EPOCH &&
    Number.isSafeInteger(snapshot.observedDatabaseAt) &&
    snapshot.observedDatabaseAt >= 0 &&
    typeof snapshot.actorAllowed === "boolean" &&
    Array.isArray(snapshot.delegationAllowed) &&
    snapshot.delegationAllowed.length === request.delegationChain.length &&
    snapshot.delegationAllowed.every((allowed) => typeof allowed === "boolean")
  );
}

function isExactCompiledArtifact(
  artifact: CompiledPolicyArtifact,
  request: NormalizedPolicyDecisionRequest,
): boolean {
  return (
    typeof artifact === "object" &&
    artifact !== null &&
    artifact.projectId === request.projectId &&
    artifact.releaseId === request.releaseId &&
    artifact.policyRevision === request.policyRevision &&
    artifact.compilerVersion === request.compilerVersion &&
    typeof artifact.artifactDigest === "string" &&
    artifact.artifactDigest.length > 0 &&
    artifact.evaluationContract === "RESOURCE_PERMISSION_INTERSECTION_V1"
  );
}
