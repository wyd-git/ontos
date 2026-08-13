import { createHash } from "node:crypto";

export const MAX_POLICY_CACHE_TTL_MS = 5_000;
export const MAX_POSTGRES_EPOCH = 9_223_372_036_854_775_807n;

export type IdentityType = "human" | "service";

export type PolicyFailureCode =
  | "POLICY_ARTIFACT_NOT_FOUND"
  | "POLICY_ARTIFACT_UNAVAILABLE"
  | "POLICY_EPOCH_UNAVAILABLE"
  | "POLICY_EPOCH_UNCONFIRMED"
  | "POLICY_INPUT_INVALID"
  | "POLICY_INTERNAL_FAILURE"
  | "POLICY_MONOTONIC_CLOCK_UNSAFE";

export class PolicyHarnessError extends Error {
  readonly code: PolicyFailureCode;

  constructor(code: PolicyFailureCode, message: string) {
    super(message);
    this.name = "PolicyHarnessError";
    this.code = code;
  }
}

export interface Clock {
  now(): number;
}

export class ManualClock implements Clock {
  #now: number;

  constructor(initialNow = 0) {
    assertClockValue(initialNow, "initialNow");
    this.#now = initialNow;
  }

  now(): number {
    return this.#now;
  }

  set(value: number): void {
    assertClockValue(value, "clock value");
    this.#now = value;
  }

  advance(durationMs: number): void {
    assertDuration(durationMs, "durationMs", true);
    const next = this.#now + durationMs;
    assertClockValue(next, "advanced clock value");
    this.#now = next;
  }
}

export interface EpochNotification {
  protocolVersion: 1;
  projectId: string;
  epoch: bigint;
}

type EpochNotificationListener = (notification: EpochNotification) => void;

interface NotificationSubscription {
  enabled: boolean;
  listener: EpochNotificationListener;
}

export class EpochNotificationBus {
  readonly #subscriptions = new Map<string, NotificationSubscription>();

  subscribe(processId: string, listener: EpochNotificationListener): () => void {
    assertIdentifier(processId, "processId");
    if (this.#subscriptions.has(processId)) {
      throw new PolicyHarnessError("POLICY_INPUT_INVALID", "processId is already subscribed.");
    }
    this.#subscriptions.set(processId, { enabled: true, listener });
    return () => {
      this.#subscriptions.delete(processId);
    };
  }

  setDelivery(processId: string, enabled: boolean): void {
    const subscription = this.#subscriptions.get(processId);
    if (subscription === undefined) {
      throw new PolicyHarnessError("POLICY_INPUT_INVALID", "processId is not subscribed.");
    }
    subscription.enabled = enabled;
  }

  publish(notification: EpochNotification): void {
    assertNotification(notification);
    const frozen = Object.freeze({ ...notification });
    for (const subscription of this.#subscriptions.values()) {
      if (!subscription.enabled) continue;
      try {
        subscription.listener(frozen);
      } catch {
        // PostgreSQL NOTIFY is a best-effort acceleration hint. A broken listener
        // cannot roll back or alter the already committed authorization transaction.
      }
    }
  }
}

export interface AuthorizationBinding {
  principalId: string;
  resourceId: string;
  permission: string;
}

export interface AuthorizationSnapshotRequest {
  projectId: string;
  actorPrincipalIds: readonly string[];
  delegationChain: readonly string[];
  resourceId: string;
  permission: string;
}

export interface AuthorizationSnapshot {
  projectId: string;
  epoch: bigint;
  observedDatabaseAt: number;
  actorAllowed: boolean;
  delegationAllowed: readonly boolean[];
}

export interface AuthorizationCommit {
  projectId: string;
  epoch: bigint;
  changed: boolean;
  committedAt: number;
}

interface ProjectAuthorizationState {
  readonly projectId: string;
  readonly epoch: bigint;
  readonly bindings: ReadonlySet<string>;
  readonly changedAt: number;
}

export class AuthorizationDraft {
  readonly #bindings: Set<string>;
  #active = true;

  constructor(bindings: ReadonlySet<string>) {
    this.#bindings = new Set(bindings);
  }

  grant(binding: AuthorizationBinding): void {
    this.#assertActive();
    this.#bindings.add(authorizationBindingKey(binding));
  }

  revoke(binding: AuthorizationBinding): void {
    this.#assertActive();
    this.#bindings.delete(authorizationBindingKey(binding));
  }

  close(): ReadonlySet<string> {
    this.#assertActive();
    this.#active = false;
    return new Set(this.#bindings);
  }

  abort(): void {
    this.#active = false;
  }

  #assertActive(): void {
    if (!this.#active) {
      throw new PolicyHarnessError(
        "POLICY_INTERNAL_FAILURE",
        "Authorization transaction is no longer active.",
      );
    }
  }
}

export interface AuthorizationSnapshotReader {
  readAuthorizationSnapshot(request: AuthorizationSnapshotRequest): AuthorizationSnapshot;
}

export class InMemoryAuthorizationStore implements AuthorizationSnapshotReader {
  readonly #projects = new Map<string, ProjectAuthorizationState>();
  readonly #databaseClock: Clock;
  readonly #notifications: EpochNotificationBus;
  #readFailure: Error | null = null;
  #readCount = 0;

  constructor(databaseClock: Clock, notifications: EpochNotificationBus) {
    this.#databaseClock = databaseClock;
    this.#notifications = notifications;
  }

  createProject(projectId: string): void {
    assertIdentifier(projectId, "projectId");
    if (this.#projects.has(projectId)) {
      throw new PolicyHarnessError("POLICY_INPUT_INVALID", "Project already exists.");
    }
    const databaseNow = this.#readDatabaseClock();
    this.#projects.set(
      projectId,
      freezeProjectState({
        projectId,
        epoch: 1n,
        bindings: new Set(),
        changedAt: databaseNow,
      }),
    );
  }

  transactAuthorizationChange(
    projectId: string,
    mutate: (draft: AuthorizationDraft) => void,
  ): AuthorizationCommit {
    assertIdentifier(projectId, "projectId");
    const current = this.#requireProject(projectId);
    const draft = new AuthorizationDraft(current.bindings);
    let nextBindings: ReadonlySet<string>;
    try {
      mutate(draft);
      nextBindings = draft.close();
    } catch (error) {
      draft.abort();
      throw error;
    }

    if (setEquals(current.bindings, nextBindings)) {
      return Object.freeze({
        projectId,
        epoch: current.epoch,
        changed: false,
        committedAt: current.changedAt,
      });
    }
    if (current.epoch >= MAX_POSTGRES_EPOCH) {
      throw new PolicyHarnessError("POLICY_INTERNAL_FAILURE", "Project Epoch is exhausted.");
    }

    const databaseNow = this.#readDatabaseClock();
    if (databaseNow < current.changedAt) {
      throw new PolicyHarnessError(
        "POLICY_INTERNAL_FAILURE",
        "Database time regressed during an authorization write.",
      );
    }
    const nextState = freezeProjectState({
      projectId,
      epoch: current.epoch + 1n,
      bindings: nextBindings,
      changedAt: databaseNow,
    });

    // State and Epoch become visible together before the best-effort notification.
    this.#projects.set(projectId, nextState);
    this.#notifications.publish({ protocolVersion: 1, projectId, epoch: nextState.epoch });
    return Object.freeze({
      projectId,
      epoch: nextState.epoch,
      changed: true,
      committedAt: databaseNow,
    });
  }

  readAuthorizationSnapshot(request: AuthorizationSnapshotRequest): AuthorizationSnapshot {
    if (this.#readFailure !== null) throw this.#readFailure;
    assertAuthorizationSnapshotRequest(request);
    this.#readCount += 1;
    const state = this.#requireProject(request.projectId);
    const observedDatabaseAt = this.#readDatabaseClock();
    const actorAllowed = request.actorPrincipalIds.some((principalId) =>
      state.bindings.has(
        authorizationBindingKey({
          principalId,
          resourceId: request.resourceId,
          permission: request.permission,
        }),
      ),
    );
    const delegationAllowed = request.delegationChain.map((principalId) =>
      state.bindings.has(
        authorizationBindingKey({
          principalId,
          resourceId: request.resourceId,
          permission: request.permission,
        }),
      ),
    );
    return Object.freeze({
      projectId: state.projectId,
      epoch: state.epoch,
      observedDatabaseAt,
      actorAllowed,
      delegationAllowed: Object.freeze(delegationAllowed),
    });
  }

  setReadFailure(error: Error | null): void {
    this.#readFailure = error;
  }

  get readCount(): number {
    return this.#readCount;
  }

  inspectProject(projectId: string): Readonly<{
    projectId: string;
    epoch: bigint;
    bindingCount: number;
    changedAt: number;
  }> {
    const state = this.#requireProject(projectId);
    return Object.freeze({
      projectId: state.projectId,
      epoch: state.epoch,
      bindingCount: state.bindings.size,
      changedAt: state.changedAt,
    });
  }

  #readDatabaseClock(): number {
    const value = this.#databaseClock.now();
    assertClockValue(value, "database clock");
    return value;
  }

  #requireProject(projectId: string): ProjectAuthorizationState {
    const state = this.#projects.get(projectId);
    if (state === undefined) {
      throw new PolicyHarnessError("POLICY_EPOCH_UNAVAILABLE", "Project Epoch is unavailable.");
    }
    return state;
  }
}

export interface CompiledPolicyArtifact {
  projectId: string;
  releaseId: string;
  policyRevision: string;
  compilerVersion: string;
  artifactDigest: string;
  evaluationContract: "RESOURCE_PERMISSION_INTERSECTION_V1";
}

export interface CompiledPolicyKey {
  projectId: string;
  releaseId: string;
  policyRevision: string;
  compilerVersion: string;
}

export interface CompiledPolicyReader {
  getCompiledPolicy(key: CompiledPolicyKey): CompiledPolicyArtifact;
}

export class InMemoryCompiledPolicyStore implements CompiledPolicyReader {
  readonly #artifacts = new Map<string, CompiledPolicyArtifact>();
  #readFailure: Error | null = null;
  #readCount = 0;

  publish(artifact: CompiledPolicyArtifact): void {
    assertCompiledPolicyArtifact(artifact);
    const key = compiledPolicyKey(artifact);
    const existing = this.#artifacts.get(key);
    if (existing !== undefined && existing.artifactDigest !== artifact.artifactDigest) {
      throw new PolicyHarnessError(
        "POLICY_INPUT_INVALID",
        "A compiled Policy key is immutable and cannot be rebound to another Digest.",
      );
    }
    if (existing === undefined) this.#artifacts.set(key, Object.freeze({ ...artifact }));
  }

  getCompiledPolicy(key: CompiledPolicyKey): CompiledPolicyArtifact {
    if (this.#readFailure !== null) throw this.#readFailure;
    assertCompiledPolicyKey(key);
    this.#readCount += 1;
    const artifact = this.#artifacts.get(compiledPolicyKey(key));
    if (artifact === undefined) {
      throw new PolicyHarnessError(
        "POLICY_ARTIFACT_NOT_FOUND",
        "The exact compiled Policy artifact is unavailable.",
      );
    }
    return artifact;
  }

  setReadFailure(error: Error | null): void {
    this.#readFailure = error;
  }

  get readCount(): number {
    return this.#readCount;
  }
}

export function compiledPolicyKey(key: CompiledPolicyKey): string {
  assertCompiledPolicyKey(key);
  return encodeTuple([
    "compiled-policy-v1",
    key.projectId,
    key.releaseId,
    key.policyRevision,
    key.compilerVersion,
  ]);
}

export function actorFingerprint(input: {
  subjectId: string;
  identityType: IdentityType;
  groupPrincipalIds: readonly string[];
}): string {
  assertIdentifier(input.subjectId, "subjectId");
  if (input.identityType !== "human" && input.identityType !== "service") {
    throw new PolicyHarnessError("POLICY_INPUT_INVALID", "identityType is invalid.");
  }
  const canonicalGroups = copyIdentifierList(
    input.groupPrincipalIds,
    "groupPrincipalIds",
    128,
    false,
  ).sort();
  return digestTuple(["actor-v1", input.identityType, input.subjectId, ...canonicalGroups]);
}

export function delegationFingerprint(delegationChain: readonly string[]): string {
  const identifiers = copyIdentifierList(delegationChain, "delegationChain", 16, false);
  return digestTuple(["delegation-v1", ...identifiers]);
}

export function opaqueProjectRef(projectId: string): string {
  assertIdentifier(projectId, "projectId");
  return digestTuple(["project-ref-v1", projectId]).slice(0, 20);
}

export function opaqueCorrelationRef(correlationId: string): string {
  assertIdentifier(correlationId, "correlationId");
  return digestTuple(["correlation-ref-v1", correlationId]).slice(0, 20);
}

export function assertIdentifier(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw new PolicyHarnessError("POLICY_INPUT_INVALID", `${field} is invalid.`);
  }
}

export function copyIdentifierList(
  value: unknown,
  field: string,
  maximumLength: number,
  requireOne: boolean,
): string[] {
  if (!Array.isArray(value) || (requireOne && value.length === 0) || value.length > maximumLength) {
    throw new PolicyHarnessError("POLICY_INPUT_INVALID", `${field} is invalid.`);
  }
  const identifiers: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "string") {
      throw new PolicyHarnessError("POLICY_INPUT_INVALID", `${field} is invalid.`);
    }
    assertIdentifier(item, field);
    identifiers.push(item);
  }
  if (new Set(identifiers).size !== identifiers.length) {
    throw new PolicyHarnessError("POLICY_INPUT_INVALID", `${field} contains duplicates.`);
  }
  return identifiers;
}

export function assertDuration(value: number, field: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new PolicyHarnessError("POLICY_INPUT_INVALID", `${field} is invalid.`);
  }
}

export function encodeTuple(parts: readonly string[]): string {
  return parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("");
}

function digestTuple(parts: readonly string[]): string {
  return createHash("sha256").update(encodeTuple(parts)).digest("hex");
}

function authorizationBindingKey(binding: AuthorizationBinding): string {
  assertIdentifier(binding.principalId, "principalId");
  assertIdentifier(binding.resourceId, "resourceId");
  assertIdentifier(binding.permission, "permission");
  return encodeTuple([binding.principalId, binding.resourceId, binding.permission]);
}

function assertAuthorizationSnapshotRequest(request: AuthorizationSnapshotRequest): void {
  assertIdentifier(request.projectId, "projectId");
  copyIdentifierList(request.actorPrincipalIds, "actorPrincipalIds", 129, true);
  copyIdentifierList(request.delegationChain, "delegationChain", 16, false);
  assertIdentifier(request.resourceId, "resourceId");
  assertIdentifier(request.permission, "permission");
}

function assertCompiledPolicyKey(key: CompiledPolicyKey): void {
  assertIdentifier(key.projectId, "projectId");
  assertIdentifier(key.releaseId, "releaseId");
  assertIdentifier(key.policyRevision, "policyRevision");
  assertIdentifier(key.compilerVersion, "compilerVersion");
}

function assertCompiledPolicyArtifact(artifact: CompiledPolicyArtifact): void {
  assertCompiledPolicyKey(artifact);
  assertIdentifier(artifact.artifactDigest, "artifactDigest");
  if (artifact.evaluationContract !== "RESOURCE_PERMISSION_INTERSECTION_V1") {
    throw new PolicyHarnessError("POLICY_INPUT_INVALID", "evaluationContract is invalid.");
  }
}

function assertNotification(notification: EpochNotification): void {
  if (notification.protocolVersion !== 1) {
    throw new PolicyHarnessError("POLICY_INPUT_INVALID", "notification version is invalid.");
  }
  assertIdentifier(notification.projectId, "projectId");
  if (notification.epoch < 1n || notification.epoch > MAX_POSTGRES_EPOCH) {
    throw new PolicyHarnessError("POLICY_INPUT_INVALID", "notification Epoch is invalid.");
  }
}

function assertClockValue(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PolicyHarnessError("POLICY_INPUT_INVALID", `${field} is invalid.`);
  }
}

function freezeProjectState(state: ProjectAuthorizationState): ProjectAuthorizationState {
  return Object.freeze({
    projectId: state.projectId,
    epoch: state.epoch,
    bindings: new Set(state.bindings),
    changedAt: state.changedAt,
  });
}

function setEquals(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}
