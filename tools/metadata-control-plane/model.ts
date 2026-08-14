export type MetadataControlPlaneErrorCode =
  | "ALREADY_EXISTS"
  | "CONCURRENT_MODIFICATION"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "INVALID_STATE"
  | "NOT_FOUND"
  | "TRANSACTION_ABORTED";

export class MetadataControlPlaneError extends Error {
  readonly code: MetadataControlPlaneErrorCode;

  constructor(code: MetadataControlPlaneErrorCode, message: string) {
    super(message);
    this.name = "MetadataControlPlaneError";
    this.code = code;
  }
}

export type ResourceRevisionState = "DRAFT" | "VALIDATED" | "PUBLISHED" | "DEPRECATED" | "ARCHIVED";

export interface ResourceRevision {
  id: string;
  resourceId: string;
  parentRevisionId: string | null;
  contentDigest: string;
  etag: number;
  state: ResourceRevisionState;
}

export function patchDraftRevision(
  revision: ResourceRevision,
  expectedEtag: number,
  contentDigest: string,
): ResourceRevision {
  requireState(revision.state, ["DRAFT"], "Only a Draft revision can be patched.");
  if (revision.etag !== expectedEtag) {
    throw new MetadataControlPlaneError(
      "CONCURRENT_MODIFICATION",
      "Revision etag no longer matches.",
    );
  }
  return {
    ...revision,
    contentDigest: required(contentDigest, "contentDigest"),
    etag: revision.etag + 1,
  };
}

export function validateRevision(revision: ResourceRevision): ResourceRevision {
  requireState(revision.state, ["DRAFT"], "Only a Draft revision can be validated.");
  return { ...revision, state: "VALIDATED" };
}

export function publishRevision(revision: ResourceRevision): ResourceRevision {
  requireState(revision.state, ["VALIDATED"], "Only a Validated revision can be published.");
  return { ...revision, state: "PUBLISHED" };
}

export function deprecateRevision(revision: ResourceRevision): ResourceRevision {
  requireState(revision.state, ["PUBLISHED"], "Only a Published revision can be deprecated.");
  return { ...revision, state: "DEPRECATED" };
}

export function archiveRevision(revision: ResourceRevision): ResourceRevision {
  requireState(revision.state, ["DEPRECATED"], "Only a Deprecated revision can be archived.");
  return { ...revision, state: "ARCHIVED" };
}

export function editImmutableRevision(
  revision: ResourceRevision,
  childId: string,
  contentDigest: string,
): ResourceRevision {
  requireState(
    revision.state,
    ["VALIDATED", "PUBLISHED", "DEPRECATED"],
    "Editing this revision does not create a child Draft.",
  );
  return {
    id: required(childId, "childId"),
    resourceId: revision.resourceId,
    parentRevisionId: revision.id,
    contentDigest: required(contentDigest, "contentDigest"),
    etag: 1,
    state: "DRAFT",
  };
}

export type ReleaseState = "DRAFT" | "STAGING" | "READY" | "FAILED" | "PUBLISHED" | "SUPERSEDED";

export interface ControlRelease {
  id: string;
  projectId: string;
  manifestDigest: string;
  state: ReleaseState;
}

export function transitionRelease(release: ControlRelease, target: ReleaseState): ControlRelease {
  const legal: Readonly<Record<ReleaseState, readonly ReleaseState[]>> = {
    DRAFT: ["STAGING", "FAILED"],
    STAGING: ["READY", "FAILED"],
    READY: ["PUBLISHED"],
    FAILED: [],
    PUBLISHED: ["SUPERSEDED"],
    SUPERSEDED: [],
  };
  if (!legal[release.state].includes(target)) {
    throw new MetadataControlPlaneError(
      "INVALID_STATE",
      `Release cannot transition from ${release.state} to ${target}.`,
    );
  }
  return { ...release, state: target };
}

export type PackageChangeState = "PENDING" | "ACTIVE" | "SUPERSEDED" | "FAILED";

export interface PackageInstallation {
  id: string;
  projectId: string;
  activePackageRevisionId: string | null;
  activeReleaseId: string | null;
}

export interface PackageInstallationChange {
  id: string;
  installationId: string;
  targetPackageRevisionId: string;
  targetReleaseId: string;
  state: PackageChangeState;
}

export function transitionPackageChange(
  change: PackageInstallationChange,
  target: PackageChangeState,
): PackageInstallationChange {
  const legal: Readonly<Record<PackageChangeState, readonly PackageChangeState[]>> = {
    PENDING: ["ACTIVE", "FAILED"],
    ACTIVE: ["SUPERSEDED"],
    SUPERSEDED: [],
    FAILED: [],
  };
  if (!legal[change.state].includes(target)) {
    throw new MetadataControlPlaneError(
      "INVALID_STATE",
      `Package change cannot transition from ${change.state} to ${target}.`,
    );
  }
  return { ...change, state: target };
}

export type ManagementRole = "OWNER" | "EDITOR" | "VIEWER" | "EXECUTOR" | "AUDITOR";
export type ManagementPermission =
  "metadata.read" | "metadata.edit" | "release.publish" | "package.manage" | "role.manage";

export interface FoundationIdentity {
  principalId: string;
  authenticationTime: number;
  claimsFingerprint: string;
}

export interface ManagementAuthorizationRequest {
  principalId: string;
  projectId: string;
  resourceId?: string;
  permission: ManagementPermission;
}

export interface ManagementAuthorizer {
  authorize(identity: FoundationIdentity, request: ManagementAuthorizationRequest): boolean;
}

export interface RoleBinding {
  id: string;
  projectId: string;
  principalId: string;
  resourceId: string | null;
  role: ManagementRole;
  state: "ACTIVE" | "REVOKED";
}

const rolePermissions: Readonly<Record<ManagementRole, ReadonlySet<ManagementPermission>>> = {
  OWNER: new Set([
    "metadata.read",
    "metadata.edit",
    "release.publish",
    "package.manage",
    "role.manage",
  ]),
  EDITOR: new Set(["metadata.read", "metadata.edit"]),
  VIEWER: new Set(["metadata.read"]),
  EXECUTOR: new Set(),
  AUDITOR: new Set(),
};

export function authorizeManagementRequest(
  identity: FoundationIdentity,
  request: ManagementAuthorizationRequest,
  bindings: readonly RoleBinding[],
): boolean {
  assertExactKeys(identity, ["principalId", "authenticationTime", "claimsFingerprint"], "identity");
  assertExactKeys(
    request,
    request.resourceId === undefined
      ? ["principalId", "projectId", "permission"]
      : ["principalId", "projectId", "resourceId", "permission"],
    "authorization request",
  );
  if (required(identity.principalId, "identity.principalId") !== request.principalId) {
    throw new MetadataControlPlaneError("INVALID_INPUT", "Identity and request principal differ.");
  }
  required(identity.claimsFingerprint, "identity.claimsFingerprint");
  if (!Number.isFinite(identity.authenticationTime)) {
    throw new MetadataControlPlaneError("INVALID_INPUT", "authenticationTime must be finite.");
  }

  const active = bindings.filter(
    (binding) =>
      binding.state === "ACTIVE" &&
      binding.projectId === request.projectId &&
      binding.principalId === request.principalId,
  );
  const projectPermissions = permissionsFor(
    active.filter((binding) => binding.resourceId === null),
  );
  if (!projectPermissions.has(request.permission)) return false;
  if (request.resourceId === undefined) return true;

  const resourceBindings = active.filter((binding) => binding.resourceId === request.resourceId);
  if (resourceBindings.length === 0) return true;
  return permissionsFor(resourceBindings).has(request.permission);
}

export const LOCK_ORDER = [
  "PROJECT_CONTROL",
  "RELEASE_CHANNEL",
  "RELEASE",
  "RELEASE_PINS",
  "SNAPSHOT_GROUP",
  "SERVING_HEADS",
] as const;

export type LockDomain = (typeof LOCK_ORDER)[number];

export const PUBLISH_LOCK_PLAN: readonly LockDomain[] = [
  "PROJECT_CONTROL",
  "RELEASE_CHANNEL",
  "RELEASE",
  "RELEASE_PINS",
  "SERVING_HEADS",
];

export const SNAPSHOT_CUTOVER_LOCK_PLAN: readonly LockDomain[] = [
  "PROJECT_CONTROL",
  "SNAPSHOT_GROUP",
  "SERVING_HEADS",
];

export function assertLockPlan(plan: readonly LockDomain[]): void {
  let previous = -1;
  for (const lock of plan) {
    const rank = LOCK_ORDER.indexOf(lock);
    if (rank <= previous) {
      throw new MetadataControlPlaneError("INVALID_INPUT", "Lock plan violates the global order.");
    }
    previous = rank;
  }
}

export interface RuntimeActivationControl {
  id: string;
  releaseId: string;
  manifestDigest: string;
  memberIds: readonly string[];
}

export interface ChannelControlPointer {
  projectId: string;
  channel: string;
  releaseId: string;
  activationId: string;
}

export interface ServingHeadControlPointer {
  releaseId: string;
  activationId: string;
}

export interface MetadataControlPlaneState {
  controlRevision: number;
  releases: Record<string, ControlRelease>;
  activations: Record<string, RuntimeActivationControl>;
  channels: Record<string, ChannelControlPointer>;
  servingHeads: Record<string, ServingHeadControlPointer>;
  packageInstallations: Record<string, PackageInstallation>;
  packageChanges: Record<string, PackageInstallationChange>;
  roleBindings: Record<string, RoleBinding>;
  authorizationEpochs: Record<string, number>;
}

export function createMetadataControlPlaneState(): MetadataControlPlaneState {
  return {
    controlRevision: 0,
    releases: {},
    activations: {},
    channels: {},
    servingHeads: {},
    packageInstallations: {},
    packageChanges: {},
    roleBindings: {},
    authorizationEpochs: {},
  };
}

export type PublishFailurePoint =
  "after_release" | "after_serving_head" | "after_channel" | "after_installations" | "after_epoch";

export interface PublishReleaseInput {
  projectId: string;
  releaseId: string;
  activationId: string;
  channel: string;
  expectedControlRevision: number;
  packageChangeId?: string;
  failurePoint?: PublishFailurePoint;
}

/**
 * Pure PostgreSQL transaction model. It intentionally has no callback or port
 * through which network, object storage, OIDC, worker or materializer work can
 * enter the commit boundary.
 */
export function publishReleaseTransaction(
  state: MetadataControlPlaneState,
  input: PublishReleaseInput,
): MetadataControlPlaneState {
  assertLockPlan(PUBLISH_LOCK_PLAN);
  const currentRelease = requireRecord(state.releases, input.releaseId, "Release");
  const activation = requireRecord(state.activations, input.activationId, "Activation");
  const channelKey = `${input.projectId}:${input.channel}`;
  const existingChannel = state.channels[channelKey];

  if (
    currentRelease.state === "PUBLISHED" &&
    existingChannel?.releaseId === input.releaseId &&
    existingChannel.activationId === input.activationId &&
    state.servingHeads[input.releaseId]?.activationId === input.activationId &&
    packagePublishAlreadyApplied(state, input)
  ) {
    return structuredClone(state);
  }
  if (state.controlRevision !== input.expectedControlRevision) {
    throw new MetadataControlPlaneError(
      "CONCURRENT_MODIFICATION",
      "Control revision no longer matches.",
    );
  }
  requireState(currentRelease.state, ["READY"], "Release is not Ready.");
  if (
    currentRelease.projectId !== input.projectId ||
    activation.releaseId !== input.releaseId ||
    activation.manifestDigest !== currentRelease.manifestDigest
  ) {
    throw new MetadataControlPlaneError("INVALID_INPUT", "Release and Activation do not match.");
  }
  if (activation.memberIds.length !== 0) {
    throw new MetadataControlPlaneError(
      "INVALID_STATE",
      "DB-01 can publish only a zero-member Runtime Activation.",
    );
  }

  const next = structuredClone(state);
  next.releases[input.releaseId] = transitionRelease(
    requireRecord(next.releases, input.releaseId, "Release"),
    "PUBLISHED",
  );
  failAt(input.failurePoint, "after_release");

  next.servingHeads[input.releaseId] = {
    releaseId: input.releaseId,
    activationId: input.activationId,
  };
  failAt(input.failurePoint, "after_serving_head");

  if (existingChannel !== undefined && existingChannel.releaseId !== input.releaseId) {
    const old = next.releases[existingChannel.releaseId];
    if (old?.state === "PUBLISHED") next.releases[old.id] = transitionRelease(old, "SUPERSEDED");
  }
  next.channels[channelKey] = {
    projectId: input.projectId,
    channel: input.channel,
    releaseId: input.releaseId,
    activationId: input.activationId,
  };
  failAt(input.failurePoint, "after_channel");

  if (input.packageChangeId !== undefined)
    activatePackageChange(next, input.packageChangeId, input);
  failAt(input.failurePoint, "after_installations");

  next.authorizationEpochs[input.projectId] = (next.authorizationEpochs[input.projectId] ?? 0) + 1;
  failAt(input.failurePoint, "after_epoch");
  next.controlRevision += 1;
  assertMetadataControlPlaneInvariants(next);
  return next;
}

export type RoleBindingFailurePoint = "after_bindings" | "after_epoch";

export interface ReplaceRoleBindingsInput {
  projectId: string;
  expectedEpoch: number;
  desired: readonly Omit<RoleBinding, "state">[];
  failurePoint?: RoleBindingFailurePoint;
}

export function replaceRoleBindingsTransaction(
  state: MetadataControlPlaneState,
  input: ReplaceRoleBindingsInput,
): MetadataControlPlaneState {
  const currentEpoch = state.authorizationEpochs[input.projectId];
  if (currentEpoch === undefined) {
    throw new MetadataControlPlaneError("NOT_FOUND", "Authorization epoch does not exist.");
  }
  if (currentEpoch !== input.expectedEpoch) {
    throw new MetadataControlPlaneError("CONCURRENT_MODIFICATION", "Authorization epoch changed.");
  }
  for (const binding of input.desired) {
    if (binding.projectId !== input.projectId) {
      throw new MetadataControlPlaneError("INVALID_INPUT", "Binding belongs to another Project.");
    }
  }
  const desiredCanonicalKeys = input.desired.map(canonicalBinding);
  if (new Set(desiredCanonicalKeys).size !== desiredCanonicalKeys.length) {
    throw new MetadataControlPlaneError(
      "INVALID_INPUT",
      "Desired Role Bindings contain duplicates.",
    );
  }

  const current = Object.values(state.roleBindings).filter(
    (binding) => binding.projectId === input.projectId && binding.state === "ACTIVE",
  );
  if (canonicalBindings(current) === canonicalBindings(input.desired))
    return structuredClone(state);

  const next = structuredClone(state);
  for (const binding of Object.values(next.roleBindings)) {
    if (binding.projectId === input.projectId && binding.state === "ACTIVE") {
      binding.state = "REVOKED";
    }
  }
  for (const binding of input.desired) {
    if (next.roleBindings[binding.id] !== undefined) {
      throw new MetadataControlPlaneError(
        "ALREADY_EXISTS",
        "A Role Binding row is immutable and its id cannot be reactivated.",
      );
    }
    next.roleBindings[binding.id] = { ...binding, state: "ACTIVE" };
  }
  failAt(input.failurePoint, "after_bindings");
  next.authorizationEpochs[input.projectId] = currentEpoch + 1;
  failAt(input.failurePoint, "after_epoch");
  next.controlRevision += 1;
  return next;
}

export function assertMetadataControlPlaneInvariants(state: MetadataControlPlaneState): void {
  assertLockPlan(PUBLISH_LOCK_PLAN);
  assertLockPlan(SNAPSHOT_CUTOVER_LOCK_PLAN);
  for (const channel of Object.values(state.channels)) {
    const release = requireRecord(state.releases, channel.releaseId, "Release");
    const activation = requireRecord(state.activations, channel.activationId, "Activation");
    if (release.state !== "PUBLISHED" || activation.releaseId !== release.id) {
      throw new MetadataControlPlaneError("INVALID_STATE", "Channel has a torn Release binding.");
    }
    if (state.servingHeads[release.id]?.activationId !== activation.id) {
      throw new MetadataControlPlaneError("INVALID_STATE", "Channel and Serving Head diverged.");
    }
  }
  for (const installation of Object.values(state.packageInstallations)) {
    if (installation.activeReleaseId === null) {
      if (installation.activePackageRevisionId !== null) {
        throw new MetadataControlPlaneError(
          "INVALID_STATE",
          "Installation has a partial active pointer.",
        );
      }
      continue;
    }
    const active = Object.values(state.packageChanges).filter(
      (change) => change.installationId === installation.id && change.state === "ACTIVE",
    );
    if (
      active.length !== 1 ||
      active[0]?.targetReleaseId !== installation.activeReleaseId ||
      active[0].targetPackageRevisionId !== installation.activePackageRevisionId
    ) {
      throw new MetadataControlPlaneError("INVALID_STATE", "Installation active pointer diverged.");
    }
  }
}

function activatePackageChange(
  state: MetadataControlPlaneState,
  packageChangeId: string,
  input: PublishReleaseInput,
): void {
  const change = requireRecord(state.packageChanges, packageChangeId, "Package change");
  const installation = requireRecord(
    state.packageInstallations,
    change.installationId,
    "Package installation",
  );
  if (installation.projectId !== input.projectId || change.targetReleaseId !== input.releaseId) {
    throw new MetadataControlPlaneError(
      "INVALID_INPUT",
      "Package change does not match the Release.",
    );
  }
  requireState(change.state, ["PENDING"], "Package change is not Pending.");
  for (const existing of Object.values(state.packageChanges)) {
    if (existing.installationId === installation.id && existing.state === "ACTIVE") {
      state.packageChanges[existing.id] = transitionPackageChange(existing, "SUPERSEDED");
    }
  }
  state.packageChanges[change.id] = transitionPackageChange(change, "ACTIVE");
  state.packageInstallations[installation.id] = {
    ...installation,
    activePackageRevisionId: change.targetPackageRevisionId,
    activeReleaseId: change.targetReleaseId,
  };
}

function packagePublishAlreadyApplied(
  state: MetadataControlPlaneState,
  input: PublishReleaseInput,
): boolean {
  if (input.packageChangeId === undefined) return true;
  const change = state.packageChanges[input.packageChangeId];
  if (change?.state !== "ACTIVE") return false;
  const installation = state.packageInstallations[change.installationId];
  return (
    installation?.activePackageRevisionId === change.targetPackageRevisionId &&
    installation.activeReleaseId === change.targetReleaseId
  );
}

function permissionsFor(bindings: readonly RoleBinding[]): Set<ManagementPermission> {
  const permissions = new Set<ManagementPermission>();
  for (const binding of bindings) {
    for (const permission of rolePermissions[binding.role]) permissions.add(permission);
  }
  return permissions;
}

function canonicalBindings(
  bindings: readonly (RoleBinding | Omit<RoleBinding, "state">)[],
): string {
  return bindings.map(canonicalBinding).sort().join("\n");
}

function canonicalBinding(binding: RoleBinding | Omit<RoleBinding, "state">): string {
  return JSON.stringify([binding.projectId, binding.principalId, binding.resourceId, binding.role]);
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const requiredKeys = [...expected].sort();
  if (
    actual.length !== requiredKeys.length ||
    actual.some((key, index) => key !== requiredKeys[index])
  ) {
    throw new MetadataControlPlaneError(
      "INVALID_INPUT",
      `${label} contains an unexpected field or is missing a required field.`,
    );
  }
}

function requireState<T extends string>(state: T, allowed: readonly T[], message: string): void {
  if (!allowed.includes(state)) throw new MetadataControlPlaneError("INVALID_STATE", message);
}

function requireRecord<T>(records: Record<string, T>, id: string, label: string): T {
  const value = records[id];
  if (value === undefined) throw new MetadataControlPlaneError("NOT_FOUND", `${label} not found.`);
  return value;
}

function failAt<T extends string>(actual: T | undefined, expected: T): void {
  if (actual === expected) {
    throw new MetadataControlPlaneError("TRANSACTION_ABORTED", `Injected failure at ${expected}.`);
  }
}

function required(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new MetadataControlPlaneError("INVALID_INPUT", `${label} is required.`);
  }
  return value;
}
