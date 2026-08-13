import assert from "node:assert/strict";
import test from "node:test";

import {
  OutboxStateModel,
  type CommitBusinessTransactionInput,
  type NewOutboxEvent,
} from "./outbox.ts";
import { DurableWorkError, type FailureCause, type RetryPolicy } from "./shared.ts";

const policy: RetryPolicy = {
  maximumAttemptsPerCycle: 2,
  initialBackoffMs: 10,
  maximumBackoffMs: 100,
  leaseDurationMs: 20,
};

void test("commit-before-response retry returns the original transactional Outbox Events", () => {
  const model = new OutboxStateModel(policy);
  const input = transaction([event("event-1", "object-a", 1n)]);
  const first = model.commitBusinessTransaction(input);
  const afterLostResponse = model.commitBusinessTransaction({ ...input, databaseNow: 50 });

  assert.deepEqual(afterLostResponse, first);
  assert.equal(Object.keys(model.snapshot().events).length, 1);
  assertWorkError(
    () =>
      model.commitBusinessTransaction({
        ...input,
        databaseNow: 51,
        transactionDigest: "sha256:different-action",
      }),
    "IDEMPOTENCY_CONFLICT",
  );
  model.assertInvariants();
});

void test("a business transaction validates the full batch before appending any Event", () => {
  const model = new OutboxStateModel(policy);
  const events = [event("event-1", "object-a", 1n), event("event-2", "object-a", 1n)];

  assertWorkError(() => model.commitBusinessTransaction(transaction(events)), "SEQUENCE_CONFLICT");
  assert.equal(Object.keys(model.snapshot().events).length, 0);
  assert.equal(Object.keys(model.snapshot().transactions).length, 0);
});

void test("Outbox ChangeSet sequence must fit PostgreSQL bigint", () => {
  const model = new OutboxStateModel(policy);
  assertWorkError(
    () =>
      model.commitBusinessTransaction(
        transaction([event("event-overflow", "object-a", 2n ** 63n)]),
      ),
    "INVALID_ARGUMENT",
  );
  assert.equal(Object.keys(model.snapshot().events).length, 0);
});

void test("a stream rejects a late predecessor after a higher ChangeSet sequence was committed", () => {
  const model = new OutboxStateModel(policy);
  model.commitBusinessTransaction(transaction([event("event-2", "object-a", 2n)]));

  assertWorkError(
    () =>
      model.commitBusinessTransaction({
        ...transaction([event("event-1", "object-a", 1n)]),
        businessTransactionId: "transaction-2",
        transactionDigest: "sha256:earlier-event",
      }),
    "SEQUENCE_CONFLICT",
  );
  assert.equal(Object.keys(model.snapshot().events).length, 1);
  model.assertInvariants();
});

void test("a later transaction cannot append another Event to an existing ChangeSet sequence", () => {
  const model = new OutboxStateModel(policy);
  model.commitBusinessTransaction(transaction([event("event-1a", "object-a", 1n)]));

  assertWorkError(
    () =>
      model.commitBusinessTransaction({
        ...transaction([
          event("event-1b", "object-a", 1n, {
            eventOrdinal: 1,
          }),
        ]),
        businessTransactionId: "transaction-2",
        transactionDigest: "sha256:late-same-sequence",
      }),
    "SEQUENCE_CONFLICT",
  );
  model.assertInvariants();
});

void test("business transaction idempotency is insensitive to retry Event array order", () => {
  const model = new OutboxStateModel(policy);
  const first = event("event-a", "object-a", 1n);
  const second = event("event-b", "object-b", 1n);
  model.commitBusinessTransaction(transaction([first, second]));

  const retry = model.commitBusinessTransaction({
    ...transaction([second, first]),
    databaseNow: 10,
  });
  assert.deepEqual(
    retry.map((item) => item.id),
    ["event-a", "event-b"],
  );
  assert.equal(Object.keys(model.snapshot().events).length, 2);
  model.assertInvariants();
});

void test("same-object Events are delivered in ChangeSet order while other objects progress", () => {
  const model = new OutboxStateModel(policy);
  model.commitBusinessTransaction(
    transaction([
      event("event-a2", "object-a", 2n),
      event("event-a1", "object-a", 1n),
      event("event-b1", "object-b", 1n),
    ]),
  );

  const first = required(
    model.claimNext({ workerId: "worker-1", attemptId: "attempt-1", databaseNow: 0 }),
  );
  const second = required(
    model.claimNext({ workerId: "worker-2", attemptId: "attempt-2", databaseNow: 0 }),
  );
  assert.equal(first.event.id, "event-a1");
  assert.equal(second.event.id, "event-b1");
  assert.equal(
    model.claimNext({ workerId: "worker-3", attemptId: "attempt-3", databaseNow: 0 }),
    null,
  );

  deliver(model, first.lease, "event-a1", 1);
  const third = required(
    model.claimNext({ workerId: "worker-3", attemptId: "attempt-3", databaseNow: 2 }),
  );
  assert.equal(third.event.id, "event-a2");
  model.assertInvariants();
});

void test("only a matching live Lease and matching consumer eventId can complete delivery", () => {
  const model = oneEventModel();
  const claim = required(
    model.claimNext({ workerId: "worker-1", attemptId: "attempt-1", databaseNow: 0 }),
  );
  model.startDelivery(claim.lease, 1);

  assertWorkError(
    () =>
      model.acknowledgeDelivery(
        { ...claim.lease, fencingToken: 999 },
        { eventId: "event-1", consumerId: "consumer-1", disposition: "APPLIED" },
        2,
      ),
    "LEASE_MISMATCH",
  );
  assertWorkError(
    () =>
      model.acknowledgeDelivery(
        claim.lease,
        { eventId: "wrong-event", consumerId: "consumer-1", disposition: "APPLIED" },
        2,
      ),
    "IDEMPOTENCY_CONFLICT",
  );
  assertWorkError(
    () =>
      model.acknowledgeDelivery(
        claim.lease,
        { eventId: "event-1", consumerId: "consumer-1", disposition: "APPLIED" },
        20,
      ),
    "LEASE_EXPIRED",
  );
  assert.equal(model.get("event-1").state, "DELIVERING");
  model.assertInvariants();
});

void test("downstream timeout demonstrates at-least-once and records consumer eventId dedupe", () => {
  const model = oneEventModel();
  const first = required(
    model.claimNext({ workerId: "worker-1", attemptId: "attempt-1", databaseNow: 0 }),
  );
  model.startDelivery(first.lease, 1);
  model.failDelivery(first.lease, timeoutFailure(), 2);

  const second = required(
    model.claimNext({ workerId: "worker-2", attemptId: "attempt-2", databaseNow: 12 }),
  );
  model.startDelivery(second.lease, 13);
  const delivered = model.acknowledgeDelivery(
    second.lease,
    { eventId: "event-1", consumerId: "consumer-1", disposition: "ALREADY_APPLIED" },
    14,
  );

  assert.equal(delivered.state, "DELIVERED");
  assert.equal(delivered.consumerDisposition, "ALREADY_APPLIED");
  assert.equal(model.snapshot().attempts["attempt-1"]?.deliveryObservation, "SENT_NO_ACK");
  assert.equal(model.snapshot().attempts["attempt-2"]?.acknowledgedEventId, "event-1");
  assert.equal(model.snapshot().attempts["attempt-2"]?.consumerDisposition, "ALREADY_APPLIED");
  model.assertInvariants();
});

void test("Dead Letter blocks later same-object Events until audited manual replay succeeds", () => {
  const model = new OutboxStateModel(policy);
  model.commitBusinessTransaction(
    transaction([event("event-1", "object-a", 1n), event("event-2", "object-a", 2n)]),
  );
  const first = required(
    model.claimNext({ workerId: "worker-1", attemptId: "attempt-1", databaseNow: 0 }),
  );
  model.startDelivery(first.lease, 1);
  model.failDelivery(first.lease, timeoutFailure(), 2);
  const retry = required(
    model.claimNext({ workerId: "worker-2", attemptId: "attempt-2", databaseNow: 12 }),
  );
  model.startDelivery(retry.lease, 13);
  assert.equal(model.failDelivery(retry.lease, timeoutFailure(), 14).state, "DEAD_LETTER");
  assert.equal(
    model.claimNext({ workerId: "worker-3", attemptId: "blocked", databaseNow: 100 }),
    null,
  );
  assert.equal(model.health(100).blockedStreams, 1);

  model.replayDeadLetter("event-1", "operator-1", "CONSUMER_RECOVERED", 101);
  const replay = required(
    model.claimNext({ workerId: "worker-3", attemptId: "attempt-3", databaseNow: 101 }),
  );
  deliver(model, replay.lease, "event-1", 102);
  const next = required(
    model.claimNext({ workerId: "worker-4", attemptId: "attempt-4", databaseNow: 103 }),
  );
  assert.equal(next.event.id, "event-2");
  assert.ok(model.snapshot().audit.some((entry) => entry.eventType === "OUTBOX_MANUALLY_REPLAYED"));
  model.assertInvariants();
});

void test("worker crash after send is observable as possible duplicate and fences stale acknowledgement", () => {
  const model = oneEventModel();
  const first = required(
    model.claimNext({ workerId: "worker-1", attemptId: "attempt-1", databaseNow: 0 }),
  );
  model.startDelivery(first.lease, 1);
  model.reclaimExpiredLeases(20);
  assert.equal(
    model.snapshot().attempts["attempt-1"]?.failure?.fingerprint,
    "outbox-lease-expired-after-send",
  );
  const second = required(
    model.claimNext({ workerId: "worker-2", attemptId: "attempt-2", databaseNow: 30 }),
  );
  assertWorkError(
    () =>
      model.acknowledgeDelivery(
        first.lease,
        { eventId: "event-1", consumerId: "consumer-1", disposition: "APPLIED" },
        31,
      ),
    "INVALID_STATE",
  );
  model.startDelivery(second.lease, 31);
  model.acknowledgeDelivery(
    second.lease,
    { eventId: "event-1", consumerId: "consumer-1", disposition: "ALREADY_APPLIED" },
    32,
  );
  model.assertInvariants();
});

void test("Action delivery status remains orthogonal to the committed business result", () => {
  const model = new OutboxStateModel(policy);
  assert.equal(model.actionDeliveryStatus("action-none"), "NOT_APPLICABLE");
  model.commitBusinessTransaction(
    transaction([
      event("event-a", "object-a", 1n, { actionExecutionId: "action-1" }),
      event("event-b", "object-b", 1n, { actionExecutionId: "action-1" }),
    ]),
  );
  assert.equal(model.actionDeliveryStatus("action-1"), "PENDING");
  const first = required(
    model.claimNext({ workerId: "worker-1", attemptId: "attempt-1", databaseNow: 0 }),
  );
  deliver(model, first.lease, first.event.id, 1);
  assert.equal(model.actionDeliveryStatus("action-1"), "PARTIAL");
  const second = required(
    model.claimNext({ workerId: "worker-2", attemptId: "attempt-2", databaseNow: 2 }),
  );
  deliver(model, second.lease, second.event.id, 3);
  assert.equal(model.actionDeliveryStatus("action-1"), "COMPLETE");
  model.assertInvariants();
});

function oneEventModel(): OutboxStateModel {
  const model = new OutboxStateModel(policy);
  model.commitBusinessTransaction(transaction([event("event-1", "object-a", 1n)]));
  return model;
}

function transaction(events: readonly NewOutboxEvent[]): CommitBusinessTransactionInput {
  return {
    businessTransactionId: "transaction-1",
    transactionDigest: "sha256:action-and-events",
    projectId: "project-1",
    correlationId: "correlation-1",
    databaseNow: 0,
    events,
  };
}

function event(
  id: string,
  objectRid: string,
  sequence: bigint,
  overrides: Partial<NewOutboxEvent> = {},
): NewOutboxEvent {
  return {
    id,
    actionExecutionId: "action-1",
    changeSetId: `changeset-${sequence.toString()}`,
    changeSetSequence: sequence,
    eventOrdinal: 0,
    objectRid,
    destinationId: "consumer-1",
    eventType: "OBJECT_CHANGED",
    payloadSchemaVersion: "1",
    payloadDigest: `sha256:${id}`,
    actorId: "actor-1",
    ...overrides,
  };
}

function deliver(
  model: OutboxStateModel,
  lease: Parameters<OutboxStateModel["startDelivery"]>[0],
  eventId: string,
  at: number,
): void {
  model.startDelivery(lease, at);
  model.acknowledgeDelivery(
    lease,
    { eventId, consumerId: "consumer-1", disposition: "APPLIED" },
    at + 1,
  );
}

function timeoutFailure(): FailureCause {
  return {
    code: "DOWNSTREAM_TIMEOUT",
    category: "DEPENDENCY",
    retryable: true,
    fingerprint: "consumer-timeout",
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
