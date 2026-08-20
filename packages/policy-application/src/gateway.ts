import {
  POLICY_COMPILER_VERSION_PATTERN,
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseCanonicalInstant,
  parseCorrelationId,
  parseIdentityDelegationSummary,
  parseOntosId,
  parsePolicyArtifact,
  type ArtifactDigest,
  type CanonicalInstant,
  type CorrelationId,
  type IdentityType,
  type ManagementRoleValue,
  type PolicyActorAttributeSchema,
  type PolicyRule,
} from "@ontos/contracts";
import type { RuntimeIdentityContext } from "@ontos/identity-application";
import {
  decideIntersectedPermission,
  type MappedActorAttribute,
  type PrincipalPermissionGrant,
} from "@ontos/identity-domain";
import {
  POLICY_ARTIFACT_MAXIMUM_BYTES,
  POLICY_COMPILER_VERSION,
  policyGatewayPermissionsForRoles,
} from "@ontos/policy-domain";

export const MAX_POLICY_GATEWAY_CACHE_TTL_MS = 5_000;
export const DEFAULT_POLICY_GATEWAY_CACHE_ENTRIES = 10_000;
export const MAX_POLICY_GATEWAY_CACHE_ENTRIES = 100_000;
export const MAX_POLICY_GATEWAY_EPOCH = 9_223_372_036_854_775_807n;

export type PolicyGatewayFailureCode =
  | "POLICY_ARTIFACT_NOT_FOUND"
  | "POLICY_ARTIFACT_UNAVAILABLE"
  | "POLICY_EPOCH_UNAVAILABLE"
  | "POLICY_EPOCH_UNCONFIRMED"
  | "POLICY_INPUT_INVALID"
  | "POLICY_INTERNAL_FAILURE"
  | "POLICY_MONOTONIC_CLOCK_UNSAFE";

export type PolicyGatewayCacheOutcome = "HIT" | "MISS" | "FAIL_CLOSED";

export interface PolicyGatewayRequest {
  readonly projectId: string;
  readonly identity: RuntimeIdentityContext;
  readonly resourceId: string;
  readonly permission: string;
  readonly releaseId: string;
  readonly policyRevisionId: string;
  readonly compilerVersion: string;
  readonly correlationId: string;
}

export interface PolicyGatewaySnapshotPrincipal {
  readonly principalId: string;
  readonly identityType: IdentityType;
  readonly state: "active" | "disabled";
  readonly projectRole: ManagementRoleValue | null;
  readonly resourceRole: ManagementRoleValue | null;
  readonly resourceBindingPresent: boolean;
  readonly serviceProfileState: "active" | "revoked" | null;
  readonly serviceCapabilities: readonly string[] | null;
}

export interface PolicyGatewaySnapshot {
  readonly projectId: string;
  readonly resourceId: string;
  readonly resourceRevisionId: string;
  readonly releaseId: string;
  readonly policyResourceId: string;
  readonly policyRevisionId: string;
  readonly policyCompilationId: string;
  readonly compilerVersion: string;
  readonly artifactDigest: ArtifactDigest;
  readonly epoch: bigint;
  readonly observedDatabaseAt: CanonicalInstant;
  readonly principals: readonly PolicyGatewaySnapshotPrincipal[];
}

export interface PolicyGatewaySnapshotRepository {
  readPolicyGatewaySnapshot(input: {
    readonly projectId: string;
    readonly authorizationPrincipalIds: readonly string[];
    readonly resourceId: string;
    readonly permission: string;
    readonly releaseId: string;
    readonly policyRevisionId: string;
    readonly compilerVersion: string;
  }): Promise<PolicyGatewaySnapshot>;
}

export interface PolicyGatewayArtifactReader {
  readArtifact(input: { readonly kind: "ir"; readonly digest: ArtifactDigest }): Promise<string>;
}

export interface PolicyGatewayMonotonicClock {
  nowMilliseconds(): number;
}

export interface PolicyEpochNotification {
  readonly protocolVersion: 1;
  readonly projectId: string;
  readonly epoch: bigint;
}

export type PolicyEpochNotificationHandler = (notification: PolicyEpochNotification) => void;

export interface PolicyEpochNotificationSource {
  subscribe(handler: PolicyEpochNotificationHandler): () => void;
}

export interface PolicyGatewayObservation {
  readonly eventName: "policy_gateway_decision";
  readonly correlationRef: string;
  readonly projectRef: string;
  readonly decisionCode: "ALLOW" | "DENY" | PolicyGatewayFailureCode;
  readonly latencyMs: number;
  readonly cacheOutcome: PolicyGatewayCacheOutcome;
}

export interface PolicyGatewayContext {
  readonly projectId: string;
  readonly resourceId: string;
  readonly resourceRevisionId: string;
  readonly releaseId: string;
  readonly policyResourceId: string;
  readonly policyRevisionId: string;
  readonly policyCompilationId: string;
  readonly compilerVersion: string;
  readonly artifactDigest: ArtifactDigest;
  readonly authorizationEpoch: string;
  readonly policyContextHash: ArtifactDigest;
  readonly policyRules: readonly PolicyRule[];
  readonly trustedActorAttributes: readonly MappedActorAttribute[];
}

export type PolicyGatewayResult =
  | {
      readonly decision: "ALLOW";
      readonly source: "CACHE" | "FRESH";
      readonly epoch: string;
      readonly errorCode: null;
      readonly context: PolicyGatewayContext;
    }
  | {
      readonly decision: "DENY";
      readonly source: "CACHE" | "FRESH";
      readonly epoch: string;
      readonly errorCode: null;
      readonly context: null;
    }
  | {
      readonly decision: "DENY";
      readonly source: "FAIL_CLOSED";
      readonly epoch: null;
      readonly errorCode: PolicyGatewayFailureCode;
      readonly context: null;
    };

export interface PolicyGatewayPort {
  authorize(request: PolicyGatewayRequest): Promise<PolicyGatewayResult>;
}

export interface PolicyGatewayCacheKey {
  readonly projectId: string;
  readonly identityFingerprint: ArtifactDigest;
  readonly delegationFingerprint: ArtifactDigest;
  readonly resourceId: string;
  readonly permission: string;
  readonly releaseId: string;
  readonly policyRevisionId: string;
  readonly compilerVersion: string;
  readonly epoch: string;
}

export type PolicyGatewayCacheKeyInput = Omit<PolicyGatewayCacheKey, "epoch">;

export interface ProductionPolicyGatewayOptions {
  readonly processId: string;
  readonly repository: PolicyGatewaySnapshotRepository;
  readonly artifacts: PolicyGatewayArtifactReader;
  readonly monotonicClock: PolicyGatewayMonotonicClock;
  readonly digestCanonicalText: (canonicalText: string) => ArtifactDigest;
  readonly notifications?: PolicyEpochNotificationSource;
  readonly cacheTtlMs?: number;
  readonly maximumCacheEntries?: number;
  readonly observe?: (observation: PolicyGatewayObservation) => void;
}

interface NormalizedPolicyGatewayRequest {
  readonly projectId: string;
  readonly identity: RuntimeIdentityContext;
  readonly identityFingerprint: ArtifactDigest;
  readonly delegationFingerprint: ArtifactDigest;
  readonly projectRef: ArtifactDigest;
  readonly resourceId: string;
  readonly permission: string;
  readonly releaseId: string;
  readonly policyRevisionId: string;
  readonly compilerVersion: typeof POLICY_COMPILER_VERSION;
  readonly correlationId: CorrelationId;
}

interface CachedPolicyGatewayDecision {
  readonly key: PolicyGatewayCacheKey;
  readonly decision: "ALLOW" | "DENY";
  readonly context: PolicyGatewayContext | null;
  readonly confirmedAtMonotonic: number;
  readonly expiresAtMonotonic: number;
}

interface LoadedArtifact {
  readonly rules: readonly PolicyRule[];
  readonly trustedActorAttributeSchema: readonly PolicyActorAttributeSchema[];
}

const permissionExpression = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const capabilityExpression = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const attributeExpression = /^[a-z][a-z0-9_]{0,62}$/u;
const compilerVersionExpression = new RegExp(POLICY_COMPILER_VERSION_PATTERN, "u");
const textEncoder = new TextEncoder();

export class ProductionPolicyGateway implements PolicyGatewayPort {
  readonly #repository: PolicyGatewaySnapshotRepository;
  readonly #artifacts: PolicyGatewayArtifactReader;
  readonly #monotonicClock: PolicyGatewayMonotonicClock;
  readonly #digestCanonicalText: (canonicalText: string) => ArtifactDigest;
  readonly #cacheTtlMs: number;
  readonly #maximumCacheEntries: number;
  readonly #observe: ((observation: PolicyGatewayObservation) => void) | undefined;
  readonly #cache = new Map<string, CachedPolicyGatewayDecision>();
  readonly #epochFloor = new Map<string, bigint>();
  readonly #unsubscribe: () => void;
  #lastMonotonic: number | null = null;
  #clockUnsafe = false;

  constructor(options: ProductionPolicyGatewayOptions) {
    if (
      typeof options.processId !== "string" ||
      options.processId.length === 0 ||
      options.processId.length > 128
    ) {
      throw new Error("Policy Gateway process identity is invalid.");
    }
    const cacheTtlMs = options.cacheTtlMs ?? MAX_POLICY_GATEWAY_CACHE_TTL_MS;
    const maximumCacheEntries = options.maximumCacheEntries ?? DEFAULT_POLICY_GATEWAY_CACHE_ENTRIES;
    if (
      !Number.isSafeInteger(cacheTtlMs) ||
      cacheTtlMs < 1 ||
      cacheTtlMs > MAX_POLICY_GATEWAY_CACHE_TTL_MS ||
      !Number.isSafeInteger(maximumCacheEntries) ||
      maximumCacheEntries < 1 ||
      maximumCacheEntries > MAX_POLICY_GATEWAY_CACHE_ENTRIES
    ) {
      throw new Error("Policy Gateway cache configuration is invalid.");
    }
    this.#repository = options.repository;
    this.#artifacts = options.artifacts;
    this.#monotonicClock = options.monotonicClock;
    this.#digestCanonicalText = options.digestCanonicalText;
    this.#cacheTtlMs = cacheTtlMs;
    this.#maximumCacheEntries = maximumCacheEntries;
    this.#observe = options.observe;
    let unsubscribe = (): void => undefined;
    try {
      unsubscribe =
        options.notifications?.subscribe((notification) => {
          this.observeNotification(notification);
        }) ?? unsubscribe;
    } catch {
      // NOTIFY is only an early invalidation hint. Hard TTL remains authoritative.
    }
    this.#unsubscribe = unsubscribe;
  }

  async authorize(input: PolicyGatewayRequest): Promise<PolicyGatewayResult> {
    let request: NormalizedPolicyGatewayRequest;
    try {
      request = normalizeRequest(input, this.#digestCanonicalText);
    } catch {
      return this.#failClosed("POLICY_INPUT_INVALID", null, 0);
    }

    let startedAt: number;
    try {
      startedAt = this.#observeMonotonicClock();
    } catch {
      return this.#failClosed("POLICY_MONOTONIC_CLOCK_UNSAFE", request, 0);
    }

    try {
      return await this.#authorize(request, startedAt);
    } catch {
      return this.#failClosedSince("POLICY_INTERNAL_FAILURE", request, startedAt);
    }
  }

  async #authorize(
    request: NormalizedPolicyGatewayRequest,
    startedAt: number,
  ): Promise<PolicyGatewayResult> {
    const baseKey = createPolicyGatewayCacheBaseKey(request);
    const cached = this.#cache.get(baseKey);
    const floor = this.#epochFloor.get(request.projectId) ?? 1n;
    if (
      cached !== undefined &&
      startedAt < cached.expiresAtMonotonic &&
      BigInt(cached.key.epoch) >= floor
    ) {
      const result = cachedResult(cached);
      this.#observeDecision(request, result.decision, 0, "HIT");
      return result;
    }
    this.#cache.delete(baseKey);

    let snapshot: PolicyGatewaySnapshot;
    try {
      snapshot = await this.#repository.readPolicyGatewaySnapshot({
        projectId: request.projectId,
        authorizationPrincipalIds: request.identity.authorizationPrincipalIds,
        resourceId: request.resourceId,
        permission: request.permission,
        releaseId: request.releaseId,
        policyRevisionId: request.policyRevisionId,
        compilerVersion: request.compilerVersion,
      });
    } catch {
      return this.#failClosedSince("POLICY_EPOCH_UNAVAILABLE", request, startedAt);
    }
    const snapshotValidity = validateSnapshot(snapshot, request);
    if (snapshotValidity === "epoch") {
      return this.#failClosedSince("POLICY_EPOCH_UNAVAILABLE", request, startedAt);
    }
    if (snapshotValidity === "artifact") {
      return this.#failClosedSince("POLICY_ARTIFACT_UNAVAILABLE", request, startedAt);
    }
    if (snapshot.epoch < floor) {
      return this.#failClosedSince("POLICY_EPOCH_UNCONFIRMED", request, startedAt);
    }

    let artifact: LoadedArtifact;
    try {
      artifact = await this.#loadExactArtifact(snapshot, request);
    } catch (error) {
      const code = artifactFailureCode(error);
      return this.#failClosedSince(code, request, startedAt);
    }

    const finalFloor = this.#epochFloor.get(request.projectId) ?? 1n;
    if (snapshot.epoch < finalFloor) {
      return this.#failClosedSince("POLICY_EPOCH_UNCONFIRMED", request, startedAt);
    }

    let confirmedAt: number;
    try {
      confirmedAt = this.#observeMonotonicClock();
    } catch {
      return this.#failClosed("POLICY_MONOTONIC_CLOCK_UNSAFE", request, 0);
    }
    const expiresAt = confirmedAt + this.#cacheTtlMs;
    if (!Number.isFinite(expiresAt) || expiresAt > Number.MAX_SAFE_INTEGER) {
      this.#markClockUnsafe();
      return this.#failClosed("POLICY_MONOTONIC_CLOCK_UNSAFE", request, 0);
    }

    const key = createPolicyGatewayCacheKey(request, snapshot.epoch);
    const allowed = this.#isAllowed(request, snapshot);
    const context = allowed ? this.#createContext(request, snapshot, artifact, key) : null;
    const entry: CachedPolicyGatewayDecision = Object.freeze({
      key,
      decision: allowed ? "ALLOW" : "DENY",
      context,
      confirmedAtMonotonic: confirmedAt,
      expiresAtMonotonic: expiresAt,
    });
    this.#raiseEpochFloor(request.projectId, snapshot.epoch);
    this.#storeCacheEntry(baseKey, entry);
    const result: PolicyGatewayResult = allowed
      ? Object.freeze({
          decision: "ALLOW",
          source: "FRESH",
          epoch: snapshot.epoch.toString(),
          errorCode: null,
          context: requiredContext(context),
        })
      : Object.freeze({
          decision: "DENY",
          source: "FRESH",
          epoch: snapshot.epoch.toString(),
          errorCode: null,
          context: null,
        });
    this.#observeDecision(request, result.decision, Math.max(0, confirmedAt - startedAt), "MISS");
    return result;
  }

  observeNotification(notification: PolicyEpochNotification): void {
    if (
      typeof notification !== "object" ||
      notification === null ||
      notification.protocolVersion !== 1 ||
      typeof notification.epoch !== "bigint" ||
      notification.epoch < 1n ||
      notification.epoch > MAX_POLICY_GATEWAY_EPOCH
    ) {
      return;
    }
    let projectId: string;
    try {
      projectId = parseOntosId(notification.projectId);
    } catch {
      return;
    }
    const current = this.#epochFloor.get(projectId) ?? 1n;
    if (notification.epoch <= current) return;
    this.#epochFloor.set(projectId, notification.epoch);
    for (const [baseKey, entry] of this.#cache) {
      if (entry.key.projectId === projectId) this.#cache.delete(baseKey);
    }
  }

  dispose(): void {
    try {
      this.#unsubscribe();
    } finally {
      this.#cache.clear();
    }
  }

  get cacheSize(): number {
    return this.#cache.size;
  }

  epochFloor(projectIdInput: string): bigint {
    const projectId = parseOntosId(projectIdInput);
    return this.#epochFloor.get(projectId) ?? 1n;
  }

  async #loadExactArtifact(
    snapshot: PolicyGatewaySnapshot,
    request: NormalizedPolicyGatewayRequest,
  ): Promise<LoadedArtifact> {
    let bytes: string;
    try {
      bytes = await this.#artifacts.readArtifact({
        kind: "ir",
        digest: snapshot.artifactDigest,
      });
    } catch (error) {
      if (hasErrorCode(error, "NOT_FOUND")) throw new ArtifactLoadError("not_found");
      throw new ArtifactLoadError("unavailable");
    }
    if (
      typeof bytes !== "string" ||
      textEncoder.encode(bytes).byteLength > POLICY_ARTIFACT_MAXIMUM_BYTES
    ) {
      throw new ArtifactLoadError("unavailable");
    }
    let parsed: ReturnType<typeof parsePolicyArtifact>;
    try {
      const raw: unknown = JSON.parse(bytes);
      parsed = parsePolicyArtifact(raw);
    } catch {
      throw new ArtifactLoadError("unavailable");
    }
    const { artifactDigest: embeddedDigest, ...withoutDigest } = parsed;
    let recomputed: ArtifactDigest;
    try {
      recomputed = parseArtifactDigest(
        this.#digestCanonicalText(canonicalizeContractForDigest(withoutDigest)),
      );
    } catch {
      throw new ArtifactLoadError("unavailable");
    }
    if (
      canonicalizeContractForDigest(parsed) !== bytes ||
      embeddedDigest !== snapshot.artifactDigest ||
      recomputed !== snapshot.artifactDigest ||
      parsed.projectId !== request.projectId ||
      parsed.releaseId !== request.releaseId ||
      parsed.policyRevisionId !== request.policyRevisionId ||
      parsed.compilerVersion !== request.compilerVersion ||
      parsed.trustedActorAttributes === undefined ||
      !parsed.rules.some(
        ({ target }) =>
          target.resourceId === request.resourceId &&
          target.resourceRevisionId === snapshot.resourceRevisionId,
      )
    ) {
      throw new ArtifactLoadError("unavailable");
    }
    return Object.freeze({
      rules: parsed.rules,
      trustedActorAttributeSchema: parsed.trustedActorAttributes,
    });
  }

  #isAllowed(request: NormalizedPolicyGatewayRequest, snapshot: PolicyGatewaySnapshot): boolean {
    try {
      const hasService = snapshot.principals.some(({ identityType }) => identityType === "service");
      const capabilityAllows =
        !hasService || request.identity.capabilities.includes(request.permission);
      const grants: readonly PrincipalPermissionGrant[] = Object.freeze(
        snapshot.principals.map((principal) => {
          let permissions = policyGatewayPermissionsForRoles({
            projectRole: principal.projectRole,
            resourceRole: principal.resourceRole,
            resourceBindingPresent: principal.resourceBindingPresent,
          });
          if (principal.identityType === "service") {
            const serviceCapabilities = new Set(principal.serviceCapabilities ?? []);
            permissions = Object.freeze(
              permissions.filter((permission) => serviceCapabilities.has(permission)),
            );
          }
          return Object.freeze({ principalId: principal.principalId, permissions });
        }),
      );
      return (
        capabilityAllows &&
        decideIntersectedPermission(
          request.identity.authorizationPrincipalIds,
          grants,
          request.permission,
        ).decision === "ALLOW"
      );
    } catch {
      return false;
    }
  }

  #createContext(
    request: NormalizedPolicyGatewayRequest,
    snapshot: PolicyGatewaySnapshot,
    artifact: LoadedArtifact,
    key: PolicyGatewayCacheKey,
  ): PolicyGatewayContext {
    const trustedActorAttributes = selectTrustedActorAttributes(
      request.identity.attributes,
      artifact.trustedActorAttributeSchema,
    );
    const policyContextHash = parseArtifactDigest(
      this.#digestCanonicalText(
        canonicalizeContractForDigest({
          schemaVersion: 1,
          decisionKey: key,
          policyCompilationId: snapshot.policyCompilationId,
          artifactDigest: snapshot.artifactDigest,
          trustedActorAttributes,
        }),
      ),
    );
    return Object.freeze({
      projectId: request.projectId,
      resourceId: request.resourceId,
      resourceRevisionId: snapshot.resourceRevisionId,
      releaseId: request.releaseId,
      policyResourceId: snapshot.policyResourceId,
      policyRevisionId: request.policyRevisionId,
      policyCompilationId: snapshot.policyCompilationId,
      compilerVersion: request.compilerVersion,
      artifactDigest: snapshot.artifactDigest,
      authorizationEpoch: snapshot.epoch.toString(),
      policyContextHash,
      policyRules: artifact.rules,
      trustedActorAttributes,
    });
  }

  #storeCacheEntry(baseKey: string, entry: CachedPolicyGatewayDecision): void {
    while (this.#cache.size >= this.#maximumCacheEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    this.#cache.set(baseKey, entry);
  }

  #observeMonotonicClock(): number {
    if (this.#clockUnsafe) throw new Error("Policy Gateway monotonic clock is unsafe.");
    let now: number;
    try {
      now = this.#monotonicClock.nowMilliseconds();
    } catch {
      this.#markClockUnsafe();
      throw new Error("Policy Gateway monotonic clock is unsafe.");
    }
    if (
      !Number.isFinite(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER ||
      (this.#lastMonotonic !== null && now < this.#lastMonotonic)
    ) {
      this.#markClockUnsafe();
      throw new Error("Policy Gateway monotonic clock is unsafe.");
    }
    this.#lastMonotonic = now;
    return now;
  }

  #safeLatency(startedAt: number): number {
    try {
      return Math.max(0, this.#observeMonotonicClock() - startedAt);
    } catch {
      return 0;
    }
  }

  #failClosedSince(
    code: PolicyGatewayFailureCode,
    request: NormalizedPolicyGatewayRequest,
    startedAt: number,
  ): PolicyGatewayResult {
    const latencyMs = this.#safeLatency(startedAt);
    return this.#failClosed(
      this.#clockUnsafe ? "POLICY_MONOTONIC_CLOCK_UNSAFE" : code,
      request,
      latencyMs,
    );
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
    code: PolicyGatewayFailureCode,
    request: NormalizedPolicyGatewayRequest | null,
    latencyMs: number,
  ): PolicyGatewayResult {
    const result = Object.freeze({
      decision: "DENY" as const,
      source: "FAIL_CLOSED" as const,
      epoch: null,
      errorCode: code,
      context: null,
    });
    const observation: PolicyGatewayObservation = Object.freeze({
      eventName: "policy_gateway_decision",
      correlationRef: request?.correlationId ?? "invalid",
      projectRef: request?.projectRef ?? "invalid",
      decisionCode: code,
      latencyMs,
      cacheOutcome: "FAIL_CLOSED",
    });
    this.#emitObservation(observation);
    return result;
  }

  #observeDecision(
    request: NormalizedPolicyGatewayRequest,
    decision: "ALLOW" | "DENY",
    latencyMs: number,
    cacheOutcome: "HIT" | "MISS",
  ): void {
    this.#emitObservation(
      Object.freeze({
        eventName: "policy_gateway_decision",
        correlationRef: request.correlationId,
        projectRef: request.projectRef,
        decisionCode: decision,
        latencyMs,
        cacheOutcome,
      }),
    );
  }

  #emitObservation(observation: PolicyGatewayObservation): void {
    try {
      this.#observe?.(observation);
    } catch {
      // Telemetry is never part of the authorization or availability path.
    }
  }
}

export function createPolicyGatewayCacheKey(
  request: PolicyGatewayCacheKeyInput,
  epoch: bigint,
): PolicyGatewayCacheKey {
  if (epoch < 1n || epoch > MAX_POLICY_GATEWAY_EPOCH) {
    throw new Error("Policy Gateway Epoch is invalid.");
  }
  return Object.freeze({
    projectId: request.projectId,
    identityFingerprint: request.identityFingerprint,
    delegationFingerprint: request.delegationFingerprint,
    resourceId: request.resourceId,
    permission: request.permission,
    releaseId: request.releaseId,
    policyRevisionId: request.policyRevisionId,
    compilerVersion: request.compilerVersion,
    epoch: epoch.toString(),
  });
}

export function serializePolicyGatewayCacheKey(key: PolicyGatewayCacheKey): string {
  return encodeTuple([
    "policy-gateway-decision-v1",
    key.projectId,
    key.identityFingerprint,
    key.delegationFingerprint,
    key.resourceId,
    key.permission,
    key.releaseId,
    key.policyRevisionId,
    key.compilerVersion,
    key.epoch,
  ]);
}

function createPolicyGatewayCacheBaseKey(
  request: Pick<
    NormalizedPolicyGatewayRequest,
    | "projectId"
    | "identityFingerprint"
    | "delegationFingerprint"
    | "resourceId"
    | "permission"
    | "releaseId"
    | "policyRevisionId"
    | "compilerVersion"
  >,
): string {
  return encodeTuple([
    "policy-gateway-base-v1",
    request.projectId,
    request.identityFingerprint,
    request.delegationFingerprint,
    request.resourceId,
    request.permission,
    request.releaseId,
    request.policyRevisionId,
    request.compilerVersion,
  ]);
}

function normalizeRequest(
  input: PolicyGatewayRequest,
  digestCanonicalText: (canonicalText: string) => ArtifactDigest,
): NormalizedPolicyGatewayRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Policy Gateway request is invalid.");
  }
  const projectId = parseOntosId(input.projectId);
  const resourceId = parseOntosId(input.resourceId);
  const releaseId = parseOntosId(input.releaseId);
  const policyRevisionId = parseOntosId(input.policyRevisionId);
  const correlationId = parseCorrelationId(input.correlationId);
  if (
    typeof input.permission !== "string" ||
    !permissionExpression.test(input.permission) ||
    typeof input.compilerVersion !== "string" ||
    !compilerVersionExpression.test(input.compilerVersion) ||
    input.compilerVersion !== POLICY_COMPILER_VERSION
  ) {
    throw new Error("Policy Gateway request version or permission is invalid.");
  }

  const identitySummary = parseIdentityDelegationSummary(input.identity.identity);
  const attributes = normalizeAttributes(input.identity.attributes);
  const capabilities = normalizeCapabilities(input.identity.capabilities);
  const expectedPrincipals = Object.freeze([
    identitySummary.actor.principalId,
    ...identitySummary.delegationChain.map(({ principalId }) => principalId),
  ]);
  const authorizationPrincipalIds = Object.freeze(
    input.identity.authorizationPrincipalIds.map((value) => parseOntosId(value)),
  );
  if (
    authorizationPrincipalIds.length !== expectedPrincipals.length ||
    authorizationPrincipalIds.some((value, index) => value !== expectedPrincipals[index])
  ) {
    throw new Error("Runtime identity Principal ordering is invalid.");
  }
  const identities = [identitySummary.actor, ...identitySummary.delegationChain];
  const serviceCount = identities.filter(({ identityType }) => identityType === "service").length;
  if (
    (identitySummary.delegationChain.length > 0 &&
      (identitySummary.actor.identityType !== "service" ||
        identitySummary.delegationChain.at(-1)?.identityType !== "human" ||
        identitySummary.delegationChain
          .slice(0, -1)
          .some(({ identityType }) => identityType !== "service"))) ||
    (serviceCount === 0 && capabilities.length !== 0) ||
    (serviceCount > 0 && capabilities.length === 0)
  ) {
    throw new Error("Runtime identity delegation shape is invalid.");
  }

  const identity: RuntimeIdentityContext = Object.freeze({
    identity: identitySummary,
    attributes,
    capabilities,
    authorizationPrincipalIds,
  });
  const identityFingerprint = parseArtifactDigest(
    digestCanonicalText(
      canonicalizeContractForDigest({
        schemaVersion: 1,
        kind: "policy-identity-v1",
        actor: identitySummary.actor,
        claimsFingerprint: identitySummary.claimsFingerprint,
        authenticatedAt: identitySummary.authenticatedAt,
        attributes,
        capabilities,
      }),
    ),
  );
  const delegationFingerprint = parseArtifactDigest(
    digestCanonicalText(
      canonicalizeContractForDigest({
        schemaVersion: 1,
        kind: "policy-delegation-v1",
        delegationChain: identitySummary.delegationChain,
        authorizationMode: identitySummary.authorizationMode,
      }),
    ),
  );
  const projectRef = parseArtifactDigest(
    digestCanonicalText(
      canonicalizeContractForDigest({
        schemaVersion: 1,
        kind: "policy-project-ref-v1",
        projectId,
      }),
    ),
  );
  return Object.freeze({
    projectId,
    identity,
    identityFingerprint,
    delegationFingerprint,
    projectRef,
    resourceId,
    permission: input.permission,
    releaseId,
    policyRevisionId,
    compilerVersion: POLICY_COMPILER_VERSION,
    correlationId,
  });
}

function normalizeAttributes(
  value: readonly MappedActorAttribute[],
): readonly MappedActorAttribute[] {
  if (value.length > 32) throw new Error("Actor attributes are invalid.");
  const names = new Set<string>();
  let totalValues = 0;
  const result = value.map((attribute) => {
    if (
      typeof attribute !== "object" ||
      attribute === null ||
      typeof attribute.name !== "string" ||
      !attributeExpression.test(attribute.name) ||
      names.has(attribute.name)
    ) {
      throw new Error("Actor attribute is invalid.");
    }
    names.add(attribute.name);
    let normalized: boolean | string | readonly string[];
    if (typeof attribute.value === "boolean") {
      normalized = attribute.value;
      totalValues += 1;
    } else if (typeof attribute.value === "string") {
      if (textEncoder.encode(attribute.value).byteLength > 256) {
        throw new Error("Actor attribute is invalid.");
      }
      normalized = attribute.value;
      totalValues += 1;
    } else if (
      isStringArray(attribute.value) &&
      attribute.value.length > 0 &&
      attribute.value.length <= 32 &&
      attribute.value.every((item) => textEncoder.encode(item).byteLength <= 256) &&
      new Set(attribute.value).size === attribute.value.length
    ) {
      normalized = Object.freeze([...attribute.value].sort(compareText));
      totalValues += attribute.value.length;
    } else {
      throw new Error("Actor attribute is invalid.");
    }
    if (totalValues > 128) throw new Error("Actor attributes are invalid.");
    return Object.freeze({ name: attribute.name, value: normalized });
  });
  result.sort((left, right) => compareText(left.name, right.name));
  if (textEncoder.encode(canonicalizeContractForDigest(result)).byteLength > 16 * 1024) {
    throw new Error("Actor attributes are invalid.");
  }
  return Object.freeze(result);
}

function normalizeCapabilities(value: readonly string[]): readonly string[] {
  if (
    value.length > 16 ||
    !value.every((item) => typeof item === "string" && capabilityExpression.test(item)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Runtime capabilities are invalid.");
  }
  return Object.freeze([...value].sort(compareText));
}

function validateSnapshot(
  snapshot: PolicyGatewaySnapshot,
  request: NormalizedPolicyGatewayRequest,
): "epoch" | "artifact" | null {
  try {
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      snapshot.projectId !== request.projectId ||
      snapshot.resourceId !== request.resourceId ||
      typeof snapshot.epoch !== "bigint" ||
      snapshot.epoch < 1n ||
      snapshot.epoch > MAX_POLICY_GATEWAY_EPOCH ||
      parseCanonicalInstant(snapshot.observedDatabaseAt) !== snapshot.observedDatabaseAt ||
      snapshot.principals.length !== request.identity.authorizationPrincipalIds.length
    ) {
      return "epoch";
    }
    for (const [index, principal] of snapshot.principals.entries()) {
      const expectedId = request.identity.authorizationPrincipalIds[index];
      const expectedIdentity = [
        request.identity.identity.actor,
        ...request.identity.identity.delegationChain,
      ][index];
      if (
        principal.principalId !== expectedId ||
        principal.identityType !== expectedIdentity?.identityType ||
        principal.state !== "active" ||
        (principal.identityType === "human" &&
          (principal.serviceProfileState !== null || principal.serviceCapabilities !== null)) ||
        (principal.identityType === "service" &&
          (principal.serviceProfileState !== "active" ||
            !validCapabilities(principal.serviceCapabilities)))
      ) {
        return "epoch";
      }
      policyGatewayPermissionsForRoles({
        projectRole: principal.projectRole,
        resourceRole: principal.resourceRole,
        resourceBindingPresent: principal.resourceBindingPresent,
      });
    }
  } catch {
    return "epoch";
  }

  try {
    if (
      parseOntosId(snapshot.resourceRevisionId) !== snapshot.resourceRevisionId ||
      snapshot.releaseId !== request.releaseId ||
      parseOntosId(snapshot.policyResourceId) !== snapshot.policyResourceId ||
      snapshot.policyRevisionId !== request.policyRevisionId ||
      parseOntosId(snapshot.policyCompilationId) !== snapshot.policyCompilationId ||
      snapshot.compilerVersion !== request.compilerVersion ||
      parseArtifactDigest(snapshot.artifactDigest) !== snapshot.artifactDigest
    ) {
      return "artifact";
    }
  } catch {
    return "artifact";
  }
  return null;
}

function validCapabilities(value: readonly string[] | null): value is readonly string[] {
  return (
    value !== null &&
    value.length > 0 &&
    value.length <= 16 &&
    value.every((item: unknown) => typeof item === "string" && capabilityExpression.test(item)) &&
    new Set(value).size === value.length
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function selectTrustedActorAttributes(
  attributes: readonly MappedActorAttribute[],
  schema: readonly PolicyActorAttributeSchema[],
): readonly MappedActorAttribute[] {
  const byName = new Map(attributes.map((attribute) => [attribute.name, attribute] as const));
  const selected: MappedActorAttribute[] = [];
  for (const item of schema) {
    const attribute = byName.get(item.apiName);
    if (attribute === undefined) continue;
    const valid =
      (item.valueType === "boolean" && typeof attribute.value === "boolean") ||
      (item.valueType === "string" && typeof attribute.value === "string") ||
      (item.valueType === "string_array" &&
        Array.isArray(attribute.value) &&
        attribute.value.every((value) => typeof value === "string"));
    if (!valid) throw new Error("Actor attribute type differs from the compiled Policy schema.");
    selected.push(attribute);
  }
  selected.sort((left, right) => compareText(left.name, right.name));
  return Object.freeze(selected);
}

function cachedResult(entry: CachedPolicyGatewayDecision): PolicyGatewayResult {
  if (entry.decision === "ALLOW") {
    return Object.freeze({
      decision: "ALLOW",
      source: "CACHE",
      epoch: entry.key.epoch,
      errorCode: null,
      context: requiredContext(entry.context),
    });
  }
  return Object.freeze({
    decision: "DENY",
    source: "CACHE",
    epoch: entry.key.epoch,
    errorCode: null,
    context: null,
  });
}

function requiredContext(value: PolicyGatewayContext | null): PolicyGatewayContext {
  if (value === null) throw new Error("Allowed Policy Gateway cache entry has no context.");
  return value;
}

function encodeTuple(parts: readonly string[]): string {
  return parts.map((part) => `${String(textEncoder.encode(part).byteLength)}:${part}`).join("");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

class ArtifactLoadError extends Error {
  readonly kind: "not_found" | "unavailable";

  constructor(kind: "not_found" | "unavailable") {
    super("Policy Artifact could not be confirmed.");
    this.name = "ArtifactLoadError";
    this.kind = kind;
  }
}

function artifactFailureCode(error: unknown): PolicyGatewayFailureCode {
  return error instanceof ArtifactLoadError && error.kind === "not_found"
    ? "POLICY_ARTIFACT_NOT_FOUND"
    : "POLICY_ARTIFACT_UNAVAILABLE";
}
