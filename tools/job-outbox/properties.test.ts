import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { JobStateModel } from "./job.ts";
import { OutboxStateModel, type NewOutboxEvent } from "./outbox.ts";
import { DurableWorkError, retryBackoffMs, type FailureCause, type RetryPolicy } from "./shared.ts";

const propertyParameters = { numRuns: 200, seed: 20_260_813 } as const;

const policy: RetryPolicy = {
  maximumAttemptsPerCycle: 5,
  initialBackoffMs: 4,
  maximumBackoffMs: 32,
  leaseDurationMs: 10,
};

void test("property: retry backoff is monotonic and capped for every positive attempt", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 1_000 }), (attempt) => {
      const delay = retryBackoffMs(attempt, policy);
      const nextDelay = retryBackoffMs(attempt + 1, policy);
      assert.ok(delay >= policy.initialBackoffMs);
      assert.ok(delay <= policy.maximumBackoffMs);
      assert.ok(nextDelay >= delay);
      assert.ok(nextDelay <= policy.maximumBackoffMs);
    }),
    propertyParameters,
  );
});

void test("property: any crashed Job attempt is fenced after lease reclaim", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 1_000_000 }), (startedAt) => {
      const model = new JobStateModel(policy);
      model.enqueue({
        id: "job-1",
        projectId: "project-1",
        jobType: "MATERIALIZE",
        idempotencyKey: "stable-key",
        inputDigest: "sha256:input",
        correlationId: "correlation-1",
        databaseNow: startedAt,
      });
      const first = required(
        model.claimNext({ workerId: "worker-a", attemptId: "attempt-a", databaseNow: startedAt }),
      );
      const expiredAt = startedAt + policy.leaseDurationMs;
      model.reclaimExpiredLeases(expiredAt);
      const retryAt = expiredAt + policy.initialBackoffMs;
      const second = required(
        model.claimNext({ workerId: "worker-b", attemptId: "attempt-b", databaseNow: retryAt }),
      );

      assert.throws(
        () => model.succeed(first.lease, "stale", retryAt + 1),
        (error: unknown) =>
          error instanceof DurableWorkError &&
          (error.code === "LEASE_MISMATCH" || error.code === "INVALID_STATE"),
      );
      model.succeed(second.lease, "current", retryAt + 1);
      assert.equal(model.get("job-1").resultRef, "current");
      model.assertInvariants();
    }),
    propertyParameters,
  );
});

void test("property: same-object Outbox delivery order follows sequence regardless of commit array order", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 30 }),
      fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 30 }),
      (rawSequences, objectChoices) => {
        const model = new OutboxStateModel(policy);
        const events = rawSequences.map((sequence, index) =>
          event(
            `event-${index}`,
            `object-${objectChoices[index % objectChoices.length]}`,
            BigInt(sequence),
          ),
        );
        model.commitBusinessTransaction({
          businessTransactionId: "transaction-1",
          transactionDigest: "sha256:events",
          projectId: "project-1",
          correlationId: "correlation-1",
          databaseNow: 0,
          events,
        });

        const deliveredByObject = new Map<string, bigint[]>();
        for (let serial = 0; serial < events.length; serial += 1) {
          const at = serial * 2;
          const claim = required(
            model.claimNext({
              workerId: `worker-${serial}`,
              attemptId: `attempt-${serial}`,
              databaseNow: at,
            }),
          );
          model.startDelivery(claim.lease, at);
          model.acknowledgeDelivery(
            claim.lease,
            {
              eventId: claim.event.id,
              consumerId: "consumer-1",
              disposition: "APPLIED",
            },
            at + 1,
          );
          const observed = deliveredByObject.get(claim.event.objectRid) ?? [];
          observed.push(claim.event.changeSetSequence);
          deliveredByObject.set(claim.event.objectRid, observed);
          model.assertInvariants();
        }

        for (const sequences of deliveredByObject.values()) {
          assert.deepEqual(sequences, [...sequences].sort(compareBigInt));
        }
      },
    ),
    propertyParameters,
  );
});

void test("property: Outbox never exceeds the automatic attempt limit before Dead Letter", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 8 }), (maximumAttempts) => {
      const boundedPolicy = { ...policy, maximumAttemptsPerCycle: maximumAttempts };
      const model = new OutboxStateModel(boundedPolicy);
      model.commitBusinessTransaction({
        businessTransactionId: "transaction-1",
        transactionDigest: "sha256:event",
        projectId: "project-1",
        correlationId: "correlation-1",
        databaseNow: 0,
        events: [event("event-1", "object-1", 1n)],
      });

      let databaseNow = 0;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        const claim = required(
          model.claimNext({
            workerId: `worker-${attempt}`,
            attemptId: `attempt-${attempt}`,
            databaseNow,
          }),
        );
        model.startDelivery(claim.lease, databaseNow);
        const failed = model.failDelivery(claim.lease, timeoutFailure(), databaseNow + 1);
        model.assertInvariants();
        if (attempt < maximumAttempts) {
          assert.equal(failed.state, "RETRY_WAIT");
          databaseNow = failed.availableAt;
        } else {
          assert.equal(failed.state, "DEAD_LETTER");
        }
      }
      assert.equal(model.get("event-1").totalAttempts, maximumAttempts);
    }),
    propertyParameters,
  );
});

function event(id: string, objectRid: string, sequence: bigint): NewOutboxEvent {
  return {
    id,
    actionExecutionId: "action-1",
    changeSetId: `changeset-${id}`,
    changeSetSequence: sequence,
    eventOrdinal: 0,
    objectRid,
    destinationId: "consumer-1",
    eventType: "OBJECT_CHANGED",
    payloadSchemaVersion: "1",
    payloadDigest: `sha256:${id}`,
    actorId: "actor-1",
  };
}

function timeoutFailure(): FailureCause {
  return {
    code: "DOWNSTREAM_TIMEOUT",
    category: "DEPENDENCY",
    retryable: true,
    fingerprint: "consumer-timeout",
  };
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function required<T>(value: T | null | undefined): T {
  assert.notEqual(value, null);
  assert.notEqual(value, undefined);
  return value as T;
}
