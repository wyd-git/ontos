export const SECOND_IN_MS = 1_000;
export const MINUTE_IN_MS = 60 * SECOND_IN_MS;
export const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

export type DurableWorkErrorCode =
  | "ALREADY_EXISTS"
  | "DATABASE_TIME_REGRESSION"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_ARGUMENT"
  | "INVALID_STATE"
  | "LEASE_EXPIRED"
  | "LEASE_MISMATCH"
  | "NOT_FOUND"
  | "SEQUENCE_CONFLICT";

export class DurableWorkError extends Error {
  readonly code: DurableWorkErrorCode;

  constructor(code: DurableWorkErrorCode, message: string) {
    super(message);
    this.name = "DurableWorkError";
    this.code = code;
  }
}

export interface RetryPolicy {
  /** Includes the first attempt; 5 attempts means at most 4 automatic retries. */
  maximumAttemptsPerCycle: number;
  initialBackoffMs: number;
  maximumBackoffMs: number;
  leaseDurationMs: number;
}

export const defaultJobRetryPolicy: RetryPolicy = {
  maximumAttemptsPerCycle: 5,
  initialBackoffMs: 5 * SECOND_IN_MS,
  maximumBackoffMs: 5 * MINUTE_IN_MS,
  leaseDurationMs: 30 * SECOND_IN_MS,
};

export const defaultOutboxRetryPolicy: RetryPolicy = {
  maximumAttemptsPerCycle: 8,
  initialBackoffMs: SECOND_IN_MS,
  maximumBackoffMs: 15 * MINUTE_IN_MS,
  leaseDurationMs: 30 * SECOND_IN_MS,
};

export interface FailureCause {
  code: string;
  category: "DEPENDENCY" | "INTERNAL" | "LEASE" | "PERMANENT" | "THROTTLED";
  retryable: boolean;
  /** Stable, non-sensitive grouping key; never a raw stack or downstream response body. */
  fingerprint: string;
}

export interface LeaseHandle {
  workKind: "JOB" | "OUTBOX";
  workId: string;
  attemptId: string;
  workerId: string;
  fencingToken: number;
}

export interface ActiveLease extends LeaseHandle {
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export type AttemptOutcome =
  "ACTIVE" | "SUCCEEDED" | "RETRY_SCHEDULED" | "DEAD_LETTER" | "LEASE_EXPIRED" | "CANCELLED";

export interface WorkAttempt {
  id: string;
  workKind: "JOB" | "OUTBOX";
  workId: string;
  workerId: string;
  fencingToken: number;
  replayCycle: number;
  attemptInCycle: number;
  totalAttempt: number;
  startedAt: number;
  lastHeartbeatAt: number;
  finishedAt: number | null;
  outcome: AttemptOutcome;
  failure: FailureCause | null;
}

export interface AuditRecord {
  sequence: number;
  eventType: string;
  workKind: "JOB" | "OUTBOX";
  workId: string;
  attemptId: string | null;
  actorType: "SYSTEM" | "WORKER" | "OPERATOR";
  actorId: string;
  correlationId: string;
  databaseAt: number;
  details: Readonly<Record<string, string>>;
}

export interface LeaseProtectedRecord {
  id: string;
  stateChangedAt: number;
  lastObservedDatabaseAt: number;
  lease: ActiveLease | null;
}

export function assertRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isSafeInteger(policy.maximumAttemptsPerCycle) || policy.maximumAttemptsPerCycle < 1) {
    throw new DurableWorkError(
      "INVALID_ARGUMENT",
      "maximumAttemptsPerCycle must be a positive safe integer.",
    );
  }
  for (const [name, value] of [
    ["initialBackoffMs", policy.initialBackoffMs],
    ["maximumBackoffMs", policy.maximumBackoffMs],
    ["leaseDurationMs", policy.leaseDurationMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new DurableWorkError("INVALID_ARGUMENT", `${name} must be a positive safe integer.`);
    }
  }
  if (policy.maximumBackoffMs < policy.initialBackoffMs) {
    throw new DurableWorkError(
      "INVALID_ARGUMENT",
      "maximumBackoffMs cannot be smaller than initialBackoffMs.",
    );
  }
}

export function retryBackoffMs(attemptInCycle: number, policy: RetryPolicy): number {
  if (!Number.isSafeInteger(attemptInCycle) || attemptInCycle < 1) {
    throw new DurableWorkError("INVALID_ARGUMENT", "attemptInCycle must be positive.");
  }
  const exponent = Math.min(attemptInCycle - 1, 52);
  return Math.min(policy.maximumBackoffMs, policy.initialBackoffMs * 2 ** exponent);
}

export function assertDatabaseTime(databaseNow: number): void {
  if (!Number.isSafeInteger(databaseNow) || databaseNow < 0) {
    throw new DurableWorkError(
      "INVALID_ARGUMENT",
      "databaseNow must be a non-negative safe integer supplied by PostgreSQL.",
    );
  }
}

export function addDatabaseDuration(databaseNow: number, durationMs: number): number {
  assertDatabaseTime(databaseNow);
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new DurableWorkError(
      "INVALID_ARGUMENT",
      "durationMs must be a non-negative safe integer.",
    );
  }
  const result = databaseNow + durationMs;
  if (!Number.isSafeInteger(result)) {
    throw new DurableWorkError(
      "INVALID_ARGUMENT",
      "database time plus duration exceeds safe range.",
    );
  }
  return result;
}

export function observeDatabaseTime(record: LeaseProtectedRecord, databaseNow: number): void {
  assertDatabaseTime(databaseNow);
  if (databaseNow < record.lastObservedDatabaseAt) {
    throw new DurableWorkError(
      "DATABASE_TIME_REGRESSION",
      `Database time regressed for ${record.id}; the transition fails closed.`,
    );
  }
}

export function assertValidLease(
  record: LeaseProtectedRecord,
  handle: LeaseHandle,
  databaseNow: number,
  expectedKind: LeaseHandle["workKind"],
): ActiveLease {
  observeDatabaseTime(record, databaseNow);
  const lease = record.lease;
  if (
    lease === null ||
    handle.workKind !== expectedKind ||
    handle.workId !== record.id ||
    handle.attemptId !== lease.attemptId ||
    handle.workerId !== lease.workerId ||
    handle.fencingToken !== lease.fencingToken
  ) {
    throw new DurableWorkError(
      "LEASE_MISMATCH",
      `Lease does not own ${expectedKind} ${record.id}.`,
    );
  }
  if (databaseNow >= lease.expiresAt) {
    throw new DurableWorkError("LEASE_EXPIRED", `Lease for ${expectedKind} ${record.id} expired.`);
  }
  return lease;
}

export function leaseHandle(lease: ActiveLease): LeaseHandle {
  return {
    workKind: lease.workKind,
    workId: lease.workId,
    attemptId: lease.attemptId,
    workerId: lease.workerId,
    fencingToken: lease.fencingToken,
  };
}

export function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new DurableWorkError("INVALID_ARGUMENT", `${field} cannot be empty.`);
  }
}

export function requireAuditCode(value: string, field: string): void {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(value)) {
    throw new DurableWorkError(
      "INVALID_ARGUMENT",
      `${field} must be a 2-64 character uppercase audit code.`,
    );
  }
}

export function validateFailure(failure: FailureCause): void {
  requireNonEmpty(failure.code, "failure.code");
  requireNonEmpty(failure.fingerprint, "failure.fingerprint");
}

export function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}
