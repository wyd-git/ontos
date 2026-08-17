import type { ServingContext } from "./policy-query.ts";

export interface PlannedQueryLease {
  readonly phase: "planned";
  readonly leaseId: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly activationId: string;
  readonly generationIds: readonly string[];
  readonly acquiredAtEpochMilliseconds: number;
  readonly expiresAtEpochMilliseconds: number;
}

export interface CommittedQueryLease extends Omit<PlannedQueryLease, "phase"> {
  readonly phase: "committed";
}

export interface ReleasedQueryLease extends Omit<PlannedQueryLease, "phase"> {
  readonly phase: "released";
  readonly releasedAtEpochMilliseconds: number;
}

export type QueryLease = PlannedQueryLease | CommittedQueryLease | ReleasedQueryLease;

export interface ExecutionContextCandidate {
  readonly source: "resolved-once-per-request";
  readonly projectId: string;
  readonly releaseId: string;
  readonly activationId: string;
  readonly generationIds: readonly string[];
  readonly identityFingerprint: string;
  readonly authorizationEpoch: string;
  readonly policyArtifactDigest: string;
  readonly policyCompilerVersion: string;
  readonly readTimestamp: string;
  readonly queryLeaseId: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export function planQueryLease(
  input: Readonly<{
    leaseId: string;
    serving: ServingContext;
    acquiredAtEpochMilliseconds: number;
    ttlMilliseconds: number;
  }>,
): PlannedQueryLease {
  if (
    !uuidPattern.test(input.leaseId) ||
    input.serving.resolution !== "release-serving-head" ||
    !Number.isSafeInteger(input.acquiredAtEpochMilliseconds) ||
    !Number.isInteger(input.ttlMilliseconds) ||
    input.ttlMilliseconds < 1_000 ||
    input.ttlMilliseconds > 120_000
  ) {
    throw new Error("QUERY_LEASE_INPUT_INVALID");
  }
  const generationIds = [
    ...new Set(input.serving.members.map(({ generationId }) => generationId)),
  ].toSorted((left, right) => left.localeCompare(right));
  if (generationIds.length === 0 || generationIds.some((id) => !uuidPattern.test(id))) {
    throw new Error("QUERY_LEASE_GENERATIONS_INVALID");
  }
  return Object.freeze({
    phase: "planned",
    leaseId: input.leaseId,
    projectId: input.serving.projectId,
    releaseId: input.serving.releaseId,
    activationId: input.serving.activationId,
    generationIds: Object.freeze(generationIds),
    acquiredAtEpochMilliseconds: input.acquiredAtEpochMilliseconds,
    expiresAtEpochMilliseconds: input.acquiredAtEpochMilliseconds + input.ttlMilliseconds,
  });
}

export function commitQueryLease(lease: PlannedQueryLease): CommittedQueryLease {
  return Object.freeze({ ...lease, phase: "committed" });
}

export function releaseQueryLease(
  lease: CommittedQueryLease,
  releasedAtEpochMilliseconds: number,
): ReleasedQueryLease {
  if (
    !Number.isSafeInteger(releasedAtEpochMilliseconds) ||
    releasedAtEpochMilliseconds < lease.acquiredAtEpochMilliseconds
  ) {
    throw new Error("QUERY_LEASE_RELEASE_TIME_INVALID");
  }
  return Object.freeze({ ...lease, phase: "released", releasedAtEpochMilliseconds });
}

export function assertReadMayStart(
  lease: QueryLease,
  databaseNowEpochMilliseconds: number,
): asserts lease is CommittedQueryLease {
  if (
    lease.phase !== "committed" ||
    !Number.isSafeInteger(databaseNowEpochMilliseconds) ||
    databaseNowEpochMilliseconds < lease.acquiredAtEpochMilliseconds ||
    databaseNowEpochMilliseconds >= lease.expiresAtEpochMilliseconds
  ) {
    throw new Error("QUERY_LEASE_NOT_ACTIVE");
  }
}

export function generationRootsFromLeases(
  leases: readonly QueryLease[],
  databaseNowEpochMilliseconds: number,
): readonly string[] {
  const roots = new Set<string>();
  for (const lease of leases) {
    if (
      lease.phase === "committed" &&
      lease.acquiredAtEpochMilliseconds <= databaseNowEpochMilliseconds &&
      databaseNowEpochMilliseconds < lease.expiresAtEpochMilliseconds
    ) {
      for (const generationId of lease.generationIds) roots.add(generationId);
    }
  }
  return Object.freeze([...roots].toSorted((left, right) => left.localeCompare(right)));
}

export function buildExecutionContextCandidate(
  input: Readonly<{
    serving: ServingContext;
    lease: CommittedQueryLease;
    identityFingerprint: string;
    authorizationEpoch: string;
    policyArtifactDigest: string;
    policyCompilerVersion: string;
    readTimestamp: string;
    databaseNowEpochMilliseconds: number;
  }>,
): ExecutionContextCandidate {
  assertReadMayStart(input.lease, input.databaseNowEpochMilliseconds);
  const servingGenerationIds = [
    ...new Set(input.serving.members.map(({ generationId }) => generationId)),
  ].toSorted((left, right) => left.localeCompare(right));
  if (
    input.serving.resolution !== "release-serving-head" ||
    input.lease.projectId !== input.serving.projectId ||
    input.lease.releaseId !== input.serving.releaseId ||
    input.lease.activationId !== input.serving.activationId ||
    servingGenerationIds.join("\0") !== input.lease.generationIds.join("\0") ||
    !digestPattern.test(input.identityFingerprint) ||
    !/^[1-9][0-9]*$/u.test(input.authorizationEpoch) ||
    !digestPattern.test(input.policyArtifactDigest) ||
    input.policyCompilerVersion.length === 0 ||
    Number.isNaN(Date.parse(input.readTimestamp))
  ) {
    throw new Error("QUERY_EXECUTION_CONTEXT_INVALID");
  }
  return Object.freeze({
    source: "resolved-once-per-request",
    projectId: input.serving.projectId,
    releaseId: input.serving.releaseId,
    activationId: input.serving.activationId,
    generationIds: Object.freeze(servingGenerationIds),
    identityFingerprint: input.identityFingerprint,
    authorizationEpoch: input.authorizationEpoch,
    policyArtifactDigest: input.policyArtifactDigest,
    policyCompilerVersion: input.policyCompilerVersion,
    readTimestamp: input.readTimestamp,
    queryLeaseId: input.lease.leaseId,
  });
}
