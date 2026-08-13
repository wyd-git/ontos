import {
  DurableWorkError,
  addDatabaseDuration,
  assertDatabaseTime,
  assertRetryPolicy,
  assertValidLease,
  cloneRecord,
  defaultJobRetryPolicy,
  leaseHandle,
  observeDatabaseTime,
  requireAuditCode,
  requireNonEmpty,
  retryBackoffMs,
  validateFailure,
  type ActiveLease,
  type AuditRecord,
  type FailureCause,
  type LeaseHandle,
  type RetryPolicy,
  type WorkAttempt,
} from "./shared.ts";

export type JobState =
  "QUEUED" | "RUNNING" | "RETRY_WAIT" | "SUCCEEDED" | "DEAD_LETTER" | "CANCELLED";

export interface JobRecord {
  id: string;
  projectId: string;
  jobType: string;
  idempotencyKey: string;
  inputDigest: string;
  correlationId: string;
  priority: number;
  state: JobState;
  createdAt: number;
  availableAt: number;
  stateChangedAt: number;
  lastObservedDatabaseAt: number;
  lease: ActiveLease | null;
  nextFencingToken: number;
  replayCycle: number;
  replayCount: number;
  attemptsInCycle: number;
  totalAttempts: number;
  firstFailure: FailureCause | null;
  lastFailure: FailureCause | null;
  resultRef: string | null;
  cancellationReason: string | null;
}

export interface JobCheckpoint {
  jobId: string;
  sequence: number;
  name: string;
  outputRef: string;
  outputDigest: string;
  attemptId: string;
  completedAt: number;
}

export interface JobModelSnapshot {
  jobs: Record<string, JobRecord>;
  attempts: Record<string, WorkAttempt>;
  checkpoints: Record<string, JobCheckpoint[]>;
  audit: AuditRecord[];
}

export interface EnqueueJobInput {
  id: string;
  projectId: string;
  jobType: string;
  idempotencyKey: string;
  inputDigest: string;
  correlationId: string;
  databaseNow: number;
  priority?: number;
  availableAt?: number;
}

export interface ClaimJobInput {
  workerId: string;
  attemptId: string;
  databaseNow: number;
}

export interface ClaimedJob {
  job: JobRecord;
  lease: LeaseHandle;
  latestCheckpoint: JobCheckpoint | null;
}

export interface CompleteCheckpointInput {
  sequence: number;
  name: string;
  outputRef: string;
  outputDigest: string;
}

export class JobStateModel {
  readonly policy: RetryPolicy;
  readonly #jobs = new Map<string, JobRecord>();
  readonly #attempts = new Map<string, WorkAttempt>();
  readonly #checkpoints = new Map<string, JobCheckpoint[]>();
  readonly #idempotencyIndex = new Map<string, string>();
  readonly #audit: AuditRecord[] = [];

  constructor(policy: RetryPolicy = defaultJobRetryPolicy) {
    assertRetryPolicy(policy);
    this.policy = cloneRecord(policy);
  }

  enqueue(input: EnqueueJobInput): JobRecord {
    validateEnqueue(input);
    const idempotencyScope = jobIdempotencyScope(input);
    const existingId = this.#idempotencyIndex.get(idempotencyScope);
    if (existingId !== undefined) {
      const existing = this.#requiredJob(existingId);
      if (existing.inputDigest !== input.inputDigest) {
        throw new DurableWorkError(
          "IDEMPOTENCY_CONFLICT",
          `Job idempotency key ${input.idempotencyKey} was reused with different input.`,
        );
      }
      return cloneRecord(existing);
    }
    if (this.#jobs.has(input.id)) {
      throw new DurableWorkError("ALREADY_EXISTS", `Job ${input.id} already exists.`);
    }

    const availableAt = input.availableAt ?? input.databaseNow;
    assertDatabaseTime(availableAt);
    if (availableAt < input.databaseNow) {
      throw new DurableWorkError("INVALID_ARGUMENT", "availableAt cannot precede databaseNow.");
    }
    const record: JobRecord = {
      id: input.id,
      projectId: input.projectId,
      jobType: input.jobType,
      idempotencyKey: input.idempotencyKey,
      inputDigest: input.inputDigest,
      correlationId: input.correlationId,
      priority: input.priority ?? 0,
      state: "QUEUED",
      createdAt: input.databaseNow,
      availableAt,
      stateChangedAt: input.databaseNow,
      lastObservedDatabaseAt: input.databaseNow,
      lease: null,
      nextFencingToken: 1,
      replayCycle: 0,
      replayCount: 0,
      attemptsInCycle: 0,
      totalAttempts: 0,
      firstFailure: null,
      lastFailure: null,
      resultRef: null,
      cancellationReason: null,
    };
    this.#jobs.set(record.id, record);
    this.#idempotencyIndex.set(idempotencyScope, record.id);
    this.#appendAudit(record, "JOB_ENQUEUED", "SYSTEM", "job-enqueue", null, input.databaseNow, {
      state: record.state,
    });
    return cloneRecord(record);
  }

  claimNext(input: ClaimJobInput): ClaimedJob | null {
    validateClaim(input);
    if (this.#attempts.has(input.attemptId)) {
      throw new DurableWorkError("ALREADY_EXISTS", `Attempt ${input.attemptId} already exists.`);
    }
    const candidate = [...this.#jobs.values()]
      .filter(
        (job) =>
          (job.state === "QUEUED" || job.state === "RETRY_WAIT") &&
          job.availableAt <= input.databaseNow,
      )
      .sort(compareJobs)[0];
    if (candidate === undefined) return null;
    observeDatabaseTime(candidate, input.databaseNow);

    const lease: ActiveLease = {
      workKind: "JOB",
      workId: candidate.id,
      attemptId: input.attemptId,
      workerId: input.workerId,
      fencingToken: candidate.nextFencingToken,
      acquiredAt: input.databaseNow,
      heartbeatAt: input.databaseNow,
      expiresAt: addDatabaseDuration(input.databaseNow, this.policy.leaseDurationMs),
    };
    const attempt: WorkAttempt = {
      id: input.attemptId,
      workKind: "JOB",
      workId: candidate.id,
      workerId: input.workerId,
      fencingToken: lease.fencingToken,
      replayCycle: candidate.replayCycle,
      attemptInCycle: candidate.attemptsInCycle + 1,
      totalAttempt: candidate.totalAttempts + 1,
      startedAt: input.databaseNow,
      lastHeartbeatAt: input.databaseNow,
      finishedAt: null,
      outcome: "ACTIVE",
      failure: null,
    };
    candidate.state = "RUNNING";
    candidate.stateChangedAt = input.databaseNow;
    candidate.lastObservedDatabaseAt = input.databaseNow;
    candidate.lease = lease;
    candidate.nextFencingToken += 1;
    candidate.attemptsInCycle += 1;
    candidate.totalAttempts += 1;
    this.#attempts.set(attempt.id, attempt);
    this.#appendAudit(
      candidate,
      "JOB_CLAIMED",
      "WORKER",
      input.workerId,
      attempt.id,
      input.databaseNow,
      { fencingToken: String(lease.fencingToken) },
    );
    return {
      job: cloneRecord(candidate),
      lease: leaseHandle(lease),
      latestCheckpoint: cloneRecord(this.#latestCheckpoint(candidate.id)),
    };
  }

  heartbeat(handle: LeaseHandle, databaseNow: number): LeaseHandle {
    const job = this.#requiredJob(handle.workId);
    if (job.state !== "RUNNING") {
      throw new DurableWorkError("INVALID_STATE", `Job ${job.id} is not RUNNING.`);
    }
    const lease = assertValidLease(job, handle, databaseNow, "JOB");
    lease.heartbeatAt = databaseNow;
    lease.expiresAt = addDatabaseDuration(databaseNow, this.policy.leaseDurationMs);
    job.lastObservedDatabaseAt = databaseNow;
    const attempt = this.#requiredAttempt(lease.attemptId);
    attempt.lastHeartbeatAt = databaseNow;
    this.#appendAudit(job, "JOB_HEARTBEAT", "WORKER", lease.workerId, attempt.id, databaseNow, {
      leaseExpiresAt: String(lease.expiresAt),
    });
    return leaseHandle(lease);
  }

  completeCheckpoint(
    handle: LeaseHandle,
    input: CompleteCheckpointInput,
    databaseNow: number,
  ): JobCheckpoint {
    validateCheckpoint(input);
    const job = this.#requiredJob(handle.workId);
    if (job.state !== "RUNNING") {
      throw new DurableWorkError("INVALID_STATE", `Job ${job.id} is not RUNNING.`);
    }
    const lease = assertValidLease(job, handle, databaseNow, "JOB");
    const checkpoints = this.#checkpoints.get(job.id) ?? [];
    const latest = checkpoints.at(-1);
    if (latest !== undefined && input.sequence < latest.sequence) {
      throw new DurableWorkError(
        "SEQUENCE_CONFLICT",
        `Checkpoint ${input.sequence} precedes completed checkpoint ${latest.sequence}.`,
      );
    }
    if (latest !== undefined && input.sequence === latest.sequence) {
      if (
        latest.name !== input.name ||
        latest.outputRef !== input.outputRef ||
        latest.outputDigest !== input.outputDigest
      ) {
        throw new DurableWorkError(
          "SEQUENCE_CONFLICT",
          `Checkpoint ${input.sequence} was reused with different output.`,
        );
      }
      return cloneRecord(latest);
    }
    const checkpoint: JobCheckpoint = {
      jobId: job.id,
      sequence: input.sequence,
      name: input.name,
      outputRef: input.outputRef,
      outputDigest: input.outputDigest,
      attemptId: lease.attemptId,
      completedAt: databaseNow,
    };
    checkpoints.push(checkpoint);
    this.#checkpoints.set(job.id, checkpoints);
    job.lastObservedDatabaseAt = databaseNow;
    this.#appendAudit(
      job,
      "JOB_CHECKPOINT_COMPLETED",
      "WORKER",
      lease.workerId,
      lease.attemptId,
      databaseNow,
      {
        checkpoint: input.name,
        sequence: String(input.sequence),
      },
    );
    return cloneRecord(checkpoint);
  }

  succeed(handle: LeaseHandle, resultRef: string, databaseNow: number): JobRecord {
    requireNonEmpty(resultRef, "resultRef");
    const job = this.#requiredJob(handle.workId);
    if (job.state !== "RUNNING") {
      throw new DurableWorkError("INVALID_STATE", `Job ${job.id} is not RUNNING.`);
    }
    const lease = assertValidLease(job, handle, databaseNow, "JOB");
    const attempt = this.#requiredAttempt(lease.attemptId);
    attempt.finishedAt = databaseNow;
    attempt.outcome = "SUCCEEDED";
    job.state = "SUCCEEDED";
    job.stateChangedAt = databaseNow;
    job.lastObservedDatabaseAt = databaseNow;
    job.lease = null;
    job.resultRef = resultRef;
    this.#appendAudit(job, "JOB_SUCCEEDED", "WORKER", lease.workerId, attempt.id, databaseNow, {
      resultRecorded: "true",
    });
    return cloneRecord(job);
  }

  fail(handle: LeaseHandle, failure: FailureCause, databaseNow: number): JobRecord {
    validateFailure(failure);
    const job = this.#requiredJob(handle.workId);
    if (job.state !== "RUNNING") {
      throw new DurableWorkError("INVALID_STATE", `Job ${job.id} is not RUNNING.`);
    }
    const lease = assertValidLease(job, handle, databaseNow, "JOB");
    return cloneRecord(
      this.#finishFailure(
        job,
        this.#requiredAttempt(lease.attemptId),
        failure,
        databaseNow,
        "WORKER",
        lease.workerId,
      ),
    );
  }

  reclaimExpiredLeases(databaseNow: number): JobRecord[] {
    assertDatabaseTime(databaseNow);
    const reclaimed: JobRecord[] = [];
    for (const job of [...this.#jobs.values()].sort(compareJobs)) {
      if (job.state !== "RUNNING" || job.lease === null || job.lease.expiresAt > databaseNow) {
        continue;
      }
      observeDatabaseTime(job, databaseNow);
      const attempt = this.#requiredAttempt(job.lease.attemptId);
      const failure: FailureCause = {
        code: "LEASE_EXPIRED",
        category: "LEASE",
        retryable: true,
        fingerprint: "job-lease-expired",
      };
      this.#appendAudit(
        job,
        "JOB_LEASE_EXPIRED",
        "SYSTEM",
        "lease-reaper",
        attempt.id,
        databaseNow,
        {
          workerId: job.lease.workerId,
        },
      );
      this.#finishFailure(
        job,
        attempt,
        failure,
        databaseNow,
        "SYSTEM",
        "lease-reaper",
        "LEASE_EXPIRED",
      );
      reclaimed.push(cloneRecord(job));
    }
    return reclaimed;
  }

  replayDeadLetter(
    jobId: string,
    operatorId: string,
    reasonCode: string,
    databaseNow: number,
  ): JobRecord {
    requireNonEmpty(operatorId, "operatorId");
    requireAuditCode(reasonCode, "reasonCode");
    const job = this.#requiredJob(jobId);
    observeDatabaseTime(job, databaseNow);
    if (job.state !== "DEAD_LETTER") {
      throw new DurableWorkError("INVALID_STATE", `Job ${job.id} is not DEAD_LETTER.`);
    }
    job.state = "QUEUED";
    job.availableAt = databaseNow;
    job.stateChangedAt = databaseNow;
    job.lastObservedDatabaseAt = databaseNow;
    job.lease = null;
    job.replayCycle += 1;
    job.replayCount += 1;
    job.attemptsInCycle = 0;
    this.#appendAudit(job, "JOB_MANUALLY_REPLAYED", "OPERATOR", operatorId, null, databaseNow, {
      reasonCode,
      replayCycle: String(job.replayCycle),
    });
    return cloneRecord(job);
  }

  cancel(jobId: string, operatorId: string, reasonCode: string, databaseNow: number): JobRecord {
    requireNonEmpty(operatorId, "operatorId");
    requireAuditCode(reasonCode, "reasonCode");
    const job = this.#requiredJob(jobId);
    observeDatabaseTime(job, databaseNow);
    if (job.state === "SUCCEEDED" || job.state === "CANCELLED") {
      throw new DurableWorkError("INVALID_STATE", `Job ${job.id} is terminal.`);
    }
    const attemptId = job.lease?.attemptId ?? null;
    if (attemptId !== null) {
      const attempt = this.#requiredAttempt(attemptId);
      attempt.finishedAt = databaseNow;
      attempt.outcome = "CANCELLED";
    }
    job.state = "CANCELLED";
    job.stateChangedAt = databaseNow;
    job.lastObservedDatabaseAt = databaseNow;
    job.lease = null;
    job.cancellationReason = reasonCode;
    this.#appendAudit(job, "JOB_CANCELLED", "OPERATOR", operatorId, attemptId, databaseNow, {
      reasonCode,
    });
    return cloneRecord(job);
  }

  get(jobId: string): JobRecord {
    return cloneRecord(this.#requiredJob(jobId));
  }

  snapshot(): JobModelSnapshot {
    return cloneRecord({
      jobs: Object.fromEntries(this.#jobs),
      attempts: Object.fromEntries(this.#attempts),
      checkpoints: Object.fromEntries(this.#checkpoints),
      audit: this.#audit,
    });
  }

  assertInvariants(): void {
    for (const job of this.#jobs.values()) {
      const attempts = [...this.#attempts.values()].filter(
        (attempt) => attempt.workKind === "JOB" && attempt.workId === job.id,
      );
      const active = attempts.filter((attempt) => attempt.outcome === "ACTIVE");
      if (job.totalAttempts !== attempts.length) {
        throw new Error(`Job ${job.id} totalAttempts does not match attempt history.`);
      }
      if (job.state === "RUNNING") {
        if (job.lease === null || active.length !== 1 || active[0]?.id !== job.lease.attemptId) {
          throw new Error(`RUNNING Job ${job.id} must have exactly one matching active Lease.`);
        }
      } else if (job.lease !== null || active.length !== 0) {
        throw new Error(`Non-running Job ${job.id} cannot have an active Lease or Attempt.`);
      }
      if (job.attemptsInCycle > this.policy.maximumAttemptsPerCycle) {
        throw new Error(`Job ${job.id} exceeded its automatic attempt limit.`);
      }
      const checkpoints = this.#checkpoints.get(job.id) ?? [];
      for (let index = 1; index < checkpoints.length; index += 1) {
        const previous = checkpoints[index - 1];
        const current = checkpoints[index];
        if (
          previous === undefined ||
          current === undefined ||
          previous.sequence >= current.sequence
        ) {
          throw new Error(`Job ${job.id} checkpoints are not strictly ordered.`);
        }
      }
      const indexedId = this.#idempotencyIndex.get(jobIdempotencyScope(job));
      if (indexedId !== job.id) {
        throw new Error(`Job ${job.id} idempotency index is inconsistent.`);
      }
    }
    this.#audit.forEach((record, index) => {
      if (record.sequence !== index + 1) throw new Error("Audit sequence is not contiguous.");
    });
  }

  #finishFailure(
    job: JobRecord,
    attempt: WorkAttempt,
    failure: FailureCause,
    databaseNow: number,
    actorType: AuditRecord["actorType"],
    actorId: string,
    attemptOutcome: WorkAttempt["outcome"] = "RETRY_SCHEDULED",
  ): JobRecord {
    const canRetry = failure.retryable && job.attemptsInCycle < this.policy.maximumAttemptsPerCycle;
    attempt.finishedAt = databaseNow;
    attempt.failure = cloneRecord(failure);
    attempt.outcome = canRetry ? attemptOutcome : "DEAD_LETTER";
    job.firstFailure ??= cloneRecord(failure);
    job.lastFailure = cloneRecord(failure);
    job.lease = null;
    job.stateChangedAt = databaseNow;
    job.lastObservedDatabaseAt = databaseNow;

    if (canRetry) {
      const delay = retryBackoffMs(job.attemptsInCycle, this.policy);
      job.state = "RETRY_WAIT";
      job.availableAt = addDatabaseDuration(databaseNow, delay);
      this.#appendAudit(job, "JOB_RETRY_SCHEDULED", actorType, actorId, attempt.id, databaseNow, {
        failureCode: failure.code,
        availableAt: String(job.availableAt),
      });
    } else {
      job.state = "DEAD_LETTER";
      this.#appendAudit(job, "JOB_DEAD_LETTERED", actorType, actorId, attempt.id, databaseNow, {
        failureCode: failure.code,
        retryable: String(failure.retryable),
      });
    }
    return job;
  }

  #latestCheckpoint(jobId: string): JobCheckpoint | null {
    return this.#checkpoints.get(jobId)?.at(-1) ?? null;
  }

  #requiredJob(jobId: string): JobRecord {
    const job = this.#jobs.get(jobId);
    if (job === undefined) throw new DurableWorkError("NOT_FOUND", `Job ${jobId} was not found.`);
    return job;
  }

  #requiredAttempt(attemptId: string): WorkAttempt {
    const attempt = this.#attempts.get(attemptId);
    if (attempt === undefined) {
      throw new DurableWorkError("NOT_FOUND", `Attempt ${attemptId} was not found.`);
    }
    return attempt;
  }

  #appendAudit(
    job: JobRecord,
    eventType: string,
    actorType: AuditRecord["actorType"],
    actorId: string,
    attemptId: string | null,
    databaseAt: number,
    details: Readonly<Record<string, string>>,
  ): void {
    this.#audit.push({
      sequence: this.#audit.length + 1,
      eventType,
      workKind: "JOB",
      workId: job.id,
      attemptId,
      actorType,
      actorId,
      correlationId: job.correlationId,
      databaseAt,
      details: cloneRecord(details),
    });
  }
}

function validateEnqueue(input: EnqueueJobInput): void {
  for (const [field, value] of [
    ["id", input.id],
    ["projectId", input.projectId],
    ["jobType", input.jobType],
    ["idempotencyKey", input.idempotencyKey],
    ["inputDigest", input.inputDigest],
    ["correlationId", input.correlationId],
  ] as const) {
    requireNonEmpty(value, field);
  }
  assertDatabaseTime(input.databaseNow);
  if (input.priority !== undefined && !Number.isSafeInteger(input.priority)) {
    throw new DurableWorkError("INVALID_ARGUMENT", "priority must be a safe integer.");
  }
}

function validateClaim(input: ClaimJobInput): void {
  requireNonEmpty(input.workerId, "workerId");
  requireNonEmpty(input.attemptId, "attemptId");
  assertDatabaseTime(input.databaseNow);
}

function validateCheckpoint(input: CompleteCheckpointInput): void {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new DurableWorkError("INVALID_ARGUMENT", "checkpoint sequence must be positive.");
  }
  requireNonEmpty(input.name, "checkpoint.name");
  requireNonEmpty(input.outputRef, "checkpoint.outputRef");
  requireNonEmpty(input.outputDigest, "checkpoint.outputDigest");
}

function compareJobs(left: JobRecord, right: JobRecord): number {
  return (
    compareNumber(right.priority, left.priority) ||
    compareNumber(left.availableAt, right.availableAt) ||
    compareNumber(left.createdAt, right.createdAt) ||
    compareText(left.id, right.id)
  );
}

function jobIdempotencyScope(input: {
  projectId: string;
  jobType: string;
  idempotencyKey: string;
}): string {
  return JSON.stringify([input.projectId, input.jobType, input.idempotencyKey]);
}

function compareNumber(left: number, right: number): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
