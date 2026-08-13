import assert from "node:assert/strict";
import test from "node:test";

import { JobStateModel } from "./job.ts";
import { DurableWorkError, type FailureCause, type RetryPolicy } from "./shared.ts";

const policy: RetryPolicy = {
  maximumAttemptsPerCycle: 2,
  initialBackoffMs: 10,
  maximumBackoffMs: 100,
  leaseDurationMs: 20,
};

void test("Job enqueue is idempotent for the same digest and rejects key reuse", () => {
  const model = new JobStateModel(policy);
  const first = enqueue(model);
  const duplicate = model.enqueue({
    ...jobInput(),
    id: "ignored-id",
  });

  assert.equal(duplicate.id, first.id);
  assert.equal(Object.keys(model.snapshot().jobs).length, 1);
  assertWorkError(
    () => model.enqueue({ ...jobInput(), id: "conflicting-id", inputDigest: "sha256:other" }),
    "IDEMPOTENCY_CONFLICT",
  );
  model.assertInvariants();
});

void test("Job scheduling rejects non-finite or unsafe database time", () => {
  const model = new JobStateModel(policy);
  assertWorkError(
    () => model.enqueue({ ...jobInput(), availableAt: Number.POSITIVE_INFINITY }),
    "INVALID_ARGUMENT",
  );
  model.enqueue({ ...jobInput(), databaseNow: Number.MAX_SAFE_INTEGER - 10 });
  assertWorkError(
    () =>
      model.claimNext({
        workerId: "worker-a",
        attemptId: "attempt-overflow",
        databaseNow: Number.MAX_SAFE_INTEGER - 10,
      }),
    "INVALID_ARGUMENT",
  );
  assert.equal(model.get("job-1").state, "QUEUED");
  assert.equal(Object.keys(model.snapshot().attempts).length, 0);
});

void test("only a live, matching Lease can checkpoint or complete a Job", () => {
  const model = new JobStateModel(policy);
  enqueue(model);
  const claim = required(
    model.claimNext({ workerId: "worker-a", attemptId: "attempt-1", databaseNow: 0 }),
  );

  model.completeCheckpoint(
    claim.lease,
    { sequence: 1, name: "SCAN", outputRef: "s3://controlled/scan", outputDigest: "sha256:scan" },
    5,
  );
  assertWorkError(
    () => model.succeed({ ...claim.lease, workerId: "worker-b" }, "generation-1", 6),
    "LEASE_MISMATCH",
  );
  assertWorkError(() => model.succeed(claim.lease, "generation-1", 20), "LEASE_EXPIRED");
  assert.equal(model.get("job-1").state, "RUNNING");
  model.assertInvariants();
});

void test("heartbeat extends authority using database time, not a worker clock", () => {
  const model = new JobStateModel(policy);
  enqueue(model);
  const claim = required(
    model.claimNext({ workerId: "worker-a", attemptId: "attempt-1", databaseNow: 0 }),
  );
  model.heartbeat(claim.lease, 15);

  assertWorkError(() => model.succeed(claim.lease, "generation-1", 14), "DATABASE_TIME_REGRESSION");
  assert.equal(model.succeed(claim.lease, "generation-1", 34).state, "SUCCEEDED");
  model.assertInvariants();
});

void test("worker crash expires one attempt, preserves checkpoint, and fences the old worker", () => {
  const model = new JobStateModel(policy);
  enqueue(model);
  const first = required(
    model.claimNext({ workerId: "worker-a", attemptId: "attempt-1", databaseNow: 0 }),
  );
  model.completeCheckpoint(
    first.lease,
    { sequence: 1, name: "SCAN", outputRef: "s3://controlled/scan", outputDigest: "sha256:scan" },
    5,
  );

  const reclaimed = model.reclaimExpiredLeases(20);
  assert.equal(reclaimed[0]?.state, "RETRY_WAIT");
  assert.equal(
    model.claimNext({ workerId: "worker-b", attemptId: "too-early", databaseNow: 29 }),
    null,
  );
  const second = required(
    model.claimNext({ workerId: "worker-b", attemptId: "attempt-2", databaseNow: 30 }),
  );
  assert.equal(second.latestCheckpoint?.name, "SCAN");
  assert.ok(second.lease.fencingToken > first.lease.fencingToken);
  assertWorkError(() => model.succeed(first.lease, "stale-result", 31), "LEASE_MISMATCH");
  assert.equal(model.succeed(second.lease, "generation-1", 31).state, "SUCCEEDED");
  model.assertInvariants();
});

void test("duplicate attempt completion cannot overwrite the first terminal result", () => {
  const model = new JobStateModel(policy);
  enqueue(model);
  const claim = required(
    model.claimNext({ workerId: "worker-a", attemptId: "attempt-1", databaseNow: 0 }),
  );
  model.succeed(claim.lease, "generation-1", 1);

  assertWorkError(() => model.succeed(claim.lease, "generation-2", 2), "INVALID_STATE");
  assert.equal(model.get("job-1").resultRef, "generation-1");
  assert.equal(model.snapshot().attempts["attempt-1"]?.outcome, "SUCCEEDED");
  model.assertInvariants();
});

void test("retry exhaustion enters Dead Letter and manual replay keeps failure history", () => {
  const model = new JobStateModel(policy);
  enqueue(model);
  const first = required(
    model.claimNext({ workerId: "worker-a", attemptId: "attempt-1", databaseNow: 0 }),
  );
  model.fail(first.lease, transientFailure("first-timeout"), 1);
  const second = required(
    model.claimNext({ workerId: "worker-b", attemptId: "attempt-2", databaseNow: 11 }),
  );
  const dead = model.fail(second.lease, transientFailure("second-timeout"), 12);

  assert.equal(dead.state, "DEAD_LETTER");
  assert.equal(dead.firstFailure?.fingerprint, "first-timeout");
  assert.equal(dead.lastFailure?.fingerprint, "second-timeout");
  const replayed = model.replayDeadLetter("job-1", "operator-1", "DEPENDENCY_RECOVERED", 13);
  assert.equal(replayed.state, "QUEUED");
  assert.equal(replayed.attemptsInCycle, 0);
  assert.equal(replayed.totalAttempts, 2);
  assert.equal(replayed.firstFailure?.fingerprint, "first-timeout");
  assert.ok(model.snapshot().audit.some((entry) => entry.eventType === "JOB_MANUALLY_REPLAYED"));
  assertWorkError(
    () => model.replayDeadLetter("job-1", "operator-1", "free text may contain secrets", 14),
    "INVALID_ARGUMENT",
  );
  model.assertInvariants();
});

void test("permanent failure goes directly to Dead Letter", () => {
  const model = new JobStateModel(policy);
  enqueue(model);
  const claim = required(
    model.claimNext({ workerId: "worker-a", attemptId: "attempt-1", databaseNow: 0 }),
  );
  const failed = model.fail(
    claim.lease,
    {
      code: "INVALID_MAPPING",
      category: "PERMANENT",
      retryable: false,
      fingerprint: "invalid-map",
    },
    1,
  );

  assert.equal(failed.state, "DEAD_LETTER");
  assert.equal(failed.totalAttempts, 1);
  model.assertInvariants();
});

function jobInput() {
  return {
    id: "job-1",
    projectId: "project-1",
    jobType: "MATERIALIZE_SNAPSHOT",
    idempotencyKey: "snapshot-hash:mapping-revision:target",
    inputDigest: "sha256:input",
    correlationId: "correlation-1",
    databaseNow: 0,
  } as const;
}

function enqueue(model: JobStateModel) {
  return model.enqueue(jobInput());
}

function transientFailure(fingerprint: string): FailureCause {
  return {
    code: "DOWNSTREAM_TIMEOUT",
    category: "DEPENDENCY",
    retryable: true,
    fingerprint,
  };
}

function required<T>(value: T | null | undefined): T {
  assert.notEqual(value, null);
  assert.notEqual(value, undefined);
  return value as T;
}

function assertWorkError(action: () => unknown, code: DurableWorkError["code"]): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof DurableWorkError && error.code === code,
  );
}
