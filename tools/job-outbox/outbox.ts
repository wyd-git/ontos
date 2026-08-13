import {
  DurableWorkError,
  MAX_POSTGRES_BIGINT,
  addDatabaseDuration,
  assertDatabaseTime,
  assertRetryPolicy,
  assertValidLease,
  cloneRecord,
  defaultOutboxRetryPolicy,
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

export type OutboxState =
  "PENDING" | "LEASED" | "DELIVERING" | "RETRY_WAIT" | "DELIVERED" | "DEAD_LETTER";

export type ConsumerDisposition = "APPLIED" | "ALREADY_APPLIED";

export type ActionDeliveryStatus =
  "NOT_APPLICABLE" | "PENDING" | "PARTIAL" | "COMPLETE" | "DEAD_LETTER";

export interface OutboxEvent {
  id: string;
  projectId: string;
  businessTransactionId: string;
  actionExecutionId: string;
  changeSetId: string;
  changeSetSequence: bigint;
  eventOrdinal: number;
  objectRid: string;
  destinationId: string;
  eventType: string;
  payloadSchemaVersion: string;
  payloadDigest: string;
  actorId: string;
  correlationId: string;
  state: OutboxState;
  committedAt: number;
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
  deliveredAt: number | null;
  consumerDisposition: ConsumerDisposition | null;
}

export interface NewOutboxEvent {
  id: string;
  actionExecutionId: string;
  changeSetId: string;
  changeSetSequence: bigint;
  eventOrdinal: number;
  objectRid: string;
  destinationId: string;
  eventType: string;
  payloadSchemaVersion: string;
  payloadDigest: string;
  actorId: string;
}

export interface CommitBusinessTransactionInput {
  businessTransactionId: string;
  transactionDigest: string;
  projectId: string;
  correlationId: string;
  databaseNow: number;
  events: readonly NewOutboxEvent[];
}

export interface OutboxDeliveryAttempt extends WorkAttempt {
  deliveryStartedAt: number | null;
  acknowledgedAt: number | null;
  acknowledgedEventId: string | null;
  consumerId: string | null;
  consumerDisposition: ConsumerDisposition | null;
  deliveryObservation: "NOT_SENT" | "SENT_NO_ACK" | "ACKNOWLEDGED";
}

export interface ClaimedOutboxEvent {
  event: OutboxEvent;
  lease: LeaseHandle;
}

export interface ConsumerAcknowledgement {
  eventId: string;
  consumerId: string;
  disposition: ConsumerDisposition;
}

export interface OutboxHealth {
  pending: number;
  leased: number;
  delivering: number;
  retryWait: number;
  deadLetter: number;
  oldestUndeliveredLagMs: number;
  blockedStreams: number;
  retryAttempts: number;
}

interface BusinessTransactionRecord {
  id: string;
  transactionDigest: string;
  eventDefinitionSignature: string;
  eventIds: string[];
  committedAt: number;
}

export interface OutboxModelSnapshot {
  events: Record<string, OutboxEvent>;
  attempts: Record<string, OutboxDeliveryAttempt>;
  transactions: Record<string, BusinessTransactionRecord>;
  audit: AuditRecord[];
}

export class OutboxStateModel {
  readonly policy: RetryPolicy;
  readonly #events = new Map<string, OutboxEvent>();
  readonly #attempts = new Map<string, OutboxDeliveryAttempt>();
  readonly #transactions = new Map<string, BusinessTransactionRecord>();
  readonly #streamPositions = new Map<string, string>();
  readonly #audit: AuditRecord[] = [];

  constructor(policy: RetryPolicy = defaultOutboxRetryPolicy) {
    assertRetryPolicy(policy);
    this.policy = cloneRecord(policy);
  }

  commitBusinessTransaction(input: CommitBusinessTransactionInput): OutboxEvent[] {
    validateCommit(input);
    const definitionSignature = eventDefinitionSignature(input.events);
    const existingTransaction = this.#transactions.get(input.businessTransactionId);
    if (existingTransaction !== undefined) {
      if (
        existingTransaction.transactionDigest !== input.transactionDigest ||
        existingTransaction.eventDefinitionSignature !== definitionSignature
      ) {
        throw new DurableWorkError(
          "IDEMPOTENCY_CONFLICT",
          `Business transaction ${input.businessTransactionId} was reused with different content.`,
        );
      }
      return existingTransaction.eventIds.map((eventId) =>
        cloneRecord(this.#requiredEvent(eventId)),
      );
    }

    const batchIds = new Set<string>();
    const batchPositions = new Set<string>();
    for (const event of input.events) {
      validateNewEvent(event);
      if (batchIds.has(event.id) || this.#events.has(event.id)) {
        throw new DurableWorkError("ALREADY_EXISTS", `Outbox Event ${event.id} already exists.`);
      }
      batchIds.add(event.id);
      const position = streamPositionKey(input.projectId, event);
      if (batchPositions.has(position) || this.#streamPositions.has(position)) {
        throw new DurableWorkError(
          "SEQUENCE_CONFLICT",
          `Outbox stream position for Event ${event.id} already exists.`,
        );
      }
      const incomingStreamKey = streamKey({
        projectId: input.projectId,
        destinationId: event.destinationId,
        objectRid: event.objectRid,
      });
      const latePredecessor = [...this.#events.values()].find(
        (existing) =>
          streamKey(existing) === incomingStreamKey &&
          existing.changeSetSequence >= event.changeSetSequence,
      );
      if (latePredecessor !== undefined) {
        throw new DurableWorkError(
          "SEQUENCE_CONFLICT",
          `Outbox Event ${event.id} cannot be inserted before existing Event ${latePredecessor.id}.`,
        );
      }
      batchPositions.add(position);
    }

    const committed = input.events.map<OutboxEvent>((event) => ({
      ...cloneRecord(event),
      projectId: input.projectId,
      businessTransactionId: input.businessTransactionId,
      correlationId: input.correlationId,
      state: "PENDING",
      committedAt: input.databaseNow,
      availableAt: input.databaseNow,
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
      deliveredAt: null,
      consumerDisposition: null,
    }));
    const transaction: BusinessTransactionRecord = {
      id: input.businessTransactionId,
      transactionDigest: input.transactionDigest,
      eventDefinitionSignature: definitionSignature,
      eventIds: committed.map((event) => event.id),
      committedAt: input.databaseNow,
    };

    for (const event of committed) {
      this.#events.set(event.id, event);
      this.#streamPositions.set(streamPositionKey(event.projectId, event), event.id);
      this.#appendAudit(
        event,
        "OUTBOX_EVENT_COMMITTED",
        "SYSTEM",
        "business-transaction",
        null,
        input.databaseNow,
        {
          actionExecutionId: event.actionExecutionId,
          changeSetId: event.changeSetId,
        },
      );
    }
    this.#transactions.set(transaction.id, transaction);
    return cloneRecord(committed);
  }

  claimNext(input: {
    workerId: string;
    attemptId: string;
    databaseNow: number;
    destinationId?: string;
  }): ClaimedOutboxEvent | null {
    requireNonEmpty(input.workerId, "workerId");
    requireNonEmpty(input.attemptId, "attemptId");
    assertDatabaseTime(input.databaseNow);
    if (input.destinationId !== undefined) requireNonEmpty(input.destinationId, "destinationId");
    if (this.#attempts.has(input.attemptId)) {
      throw new DurableWorkError("ALREADY_EXISTS", `Attempt ${input.attemptId} already exists.`);
    }

    const candidate = [...this.#events.values()]
      .filter(
        (event) =>
          (event.state === "PENDING" || event.state === "RETRY_WAIT") &&
          event.availableAt <= input.databaseNow &&
          (input.destinationId === undefined || event.destinationId === input.destinationId) &&
          !this.#hasUndeliveredPredecessor(event),
      )
      .sort(compareEvents)[0];
    if (candidate === undefined) return null;
    observeDatabaseTime(candidate, input.databaseNow);

    const lease: ActiveLease = {
      workKind: "OUTBOX",
      workId: candidate.id,
      attemptId: input.attemptId,
      workerId: input.workerId,
      fencingToken: candidate.nextFencingToken,
      acquiredAt: input.databaseNow,
      heartbeatAt: input.databaseNow,
      expiresAt: addDatabaseDuration(input.databaseNow, this.policy.leaseDurationMs),
    };
    const attempt: OutboxDeliveryAttempt = {
      id: input.attemptId,
      workKind: "OUTBOX",
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
      deliveryStartedAt: null,
      acknowledgedAt: null,
      acknowledgedEventId: null,
      consumerId: null,
      consumerDisposition: null,
      deliveryObservation: "NOT_SENT",
    };
    candidate.state = "LEASED";
    candidate.stateChangedAt = input.databaseNow;
    candidate.lastObservedDatabaseAt = input.databaseNow;
    candidate.lease = lease;
    candidate.nextFencingToken += 1;
    candidate.attemptsInCycle += 1;
    candidate.totalAttempts += 1;
    this.#attempts.set(attempt.id, attempt);
    this.#appendAudit(
      candidate,
      "OUTBOX_EVENT_CLAIMED",
      "WORKER",
      input.workerId,
      attempt.id,
      input.databaseNow,
      {
        fencingToken: String(lease.fencingToken),
      },
    );
    return { event: cloneRecord(candidate), lease: leaseHandle(lease) };
  }

  heartbeat(handle: LeaseHandle, databaseNow: number): LeaseHandle {
    const event = this.#requiredEvent(handle.workId);
    this.#assertInFlight(event);
    const lease = assertValidLease(event, handle, databaseNow, "OUTBOX");
    lease.heartbeatAt = databaseNow;
    lease.expiresAt = addDatabaseDuration(databaseNow, this.policy.leaseDurationMs);
    event.lastObservedDatabaseAt = databaseNow;
    this.#requiredAttempt(lease.attemptId).lastHeartbeatAt = databaseNow;
    this.#appendAudit(
      event,
      "OUTBOX_HEARTBEAT",
      "WORKER",
      lease.workerId,
      lease.attemptId,
      databaseNow,
      {
        leaseExpiresAt: String(lease.expiresAt),
      },
    );
    return leaseHandle(lease);
  }

  startDelivery(handle: LeaseHandle, databaseNow: number): OutboxEvent {
    const event = this.#requiredEvent(handle.workId);
    if (event.state !== "LEASED") {
      throw new DurableWorkError("INVALID_STATE", `Outbox Event ${event.id} is not LEASED.`);
    }
    const lease = assertValidLease(event, handle, databaseNow, "OUTBOX");
    const attempt = this.#requiredAttempt(lease.attemptId);
    event.state = "DELIVERING";
    event.stateChangedAt = databaseNow;
    event.lastObservedDatabaseAt = databaseNow;
    attempt.deliveryStartedAt = databaseNow;
    attempt.deliveryObservation = "SENT_NO_ACK";
    this.#appendAudit(
      event,
      "OUTBOX_DELIVERY_STARTED",
      "WORKER",
      lease.workerId,
      attempt.id,
      databaseNow,
      {
        destinationId: event.destinationId,
        eventId: event.id,
      },
    );
    return cloneRecord(event);
  }

  acknowledgeDelivery(
    handle: LeaseHandle,
    acknowledgement: ConsumerAcknowledgement,
    databaseNow: number,
  ): OutboxEvent {
    validateAcknowledgement(acknowledgement);
    const event = this.#requiredEvent(handle.workId);
    if (event.state !== "DELIVERING") {
      throw new DurableWorkError("INVALID_STATE", `Outbox Event ${event.id} is not DELIVERING.`);
    }
    const lease = assertValidLease(event, handle, databaseNow, "OUTBOX");
    if (acknowledgement.eventId !== event.id) {
      throw new DurableWorkError(
        "IDEMPOTENCY_CONFLICT",
        `Consumer acknowledged ${acknowledgement.eventId} while delivering ${event.id}.`,
      );
    }
    if (acknowledgement.consumerId !== event.destinationId) {
      throw new DurableWorkError(
        "LEASE_MISMATCH",
        `Consumer ${acknowledgement.consumerId} is not destination ${event.destinationId}.`,
      );
    }
    const attempt = this.#requiredAttempt(lease.attemptId);
    attempt.finishedAt = databaseNow;
    attempt.outcome = "SUCCEEDED";
    attempt.acknowledgedAt = databaseNow;
    attempt.acknowledgedEventId = acknowledgement.eventId;
    attempt.consumerId = acknowledgement.consumerId;
    attempt.consumerDisposition = acknowledgement.disposition;
    attempt.deliveryObservation = "ACKNOWLEDGED";
    event.state = "DELIVERED";
    event.stateChangedAt = databaseNow;
    event.lastObservedDatabaseAt = databaseNow;
    event.lease = null;
    event.deliveredAt = databaseNow;
    event.consumerDisposition = acknowledgement.disposition;
    this.#appendAudit(
      event,
      "OUTBOX_DELIVERY_ACKNOWLEDGED",
      "WORKER",
      lease.workerId,
      attempt.id,
      databaseNow,
      {
        consumerDisposition: acknowledgement.disposition,
        consumerId: acknowledgement.consumerId,
        eventId: acknowledgement.eventId,
      },
    );
    return cloneRecord(event);
  }

  failDelivery(handle: LeaseHandle, failure: FailureCause, databaseNow: number): OutboxEvent {
    validateFailure(failure);
    const event = this.#requiredEvent(handle.workId);
    this.#assertInFlight(event);
    const lease = assertValidLease(event, handle, databaseNow, "OUTBOX");
    return cloneRecord(
      this.#finishFailure(
        event,
        this.#requiredAttempt(lease.attemptId),
        failure,
        databaseNow,
        "WORKER",
        lease.workerId,
      ),
    );
  }

  reclaimExpiredLeases(databaseNow: number): OutboxEvent[] {
    assertDatabaseTime(databaseNow);
    const reclaimed: OutboxEvent[] = [];
    for (const event of [...this.#events.values()].sort(compareEvents)) {
      if (
        (event.state !== "LEASED" && event.state !== "DELIVERING") ||
        event.lease === null ||
        event.lease.expiresAt > databaseNow
      ) {
        continue;
      }
      observeDatabaseTime(event, databaseNow);
      const attempt = this.#requiredAttempt(event.lease.attemptId);
      const wasSent = attempt.deliveryStartedAt !== null;
      const failure: FailureCause = {
        code: "LEASE_EXPIRED",
        category: "LEASE",
        retryable: true,
        fingerprint: wasSent
          ? "outbox-lease-expired-after-send"
          : "outbox-lease-expired-before-send",
      };
      this.#appendAudit(
        event,
        "OUTBOX_LEASE_EXPIRED",
        "SYSTEM",
        "lease-reaper",
        attempt.id,
        databaseNow,
        {
          deliveryMayHaveOccurred: String(wasSent),
          workerId: event.lease.workerId,
        },
      );
      this.#finishFailure(
        event,
        attempt,
        failure,
        databaseNow,
        "SYSTEM",
        "lease-reaper",
        "LEASE_EXPIRED",
      );
      reclaimed.push(cloneRecord(event));
    }
    return reclaimed;
  }

  replayDeadLetter(
    eventId: string,
    operatorId: string,
    reasonCode: string,
    databaseNow: number,
  ): OutboxEvent {
    requireNonEmpty(operatorId, "operatorId");
    requireAuditCode(reasonCode, "reasonCode");
    const event = this.#requiredEvent(eventId);
    observeDatabaseTime(event, databaseNow);
    if (event.state !== "DEAD_LETTER") {
      throw new DurableWorkError("INVALID_STATE", `Outbox Event ${event.id} is not DEAD_LETTER.`);
    }
    event.state = "PENDING";
    event.availableAt = databaseNow;
    event.stateChangedAt = databaseNow;
    event.lastObservedDatabaseAt = databaseNow;
    event.lease = null;
    event.replayCycle += 1;
    event.replayCount += 1;
    event.attemptsInCycle = 0;
    this.#appendAudit(
      event,
      "OUTBOX_MANUALLY_REPLAYED",
      "OPERATOR",
      operatorId,
      null,
      databaseNow,
      {
        reasonCode,
        replayCycle: String(event.replayCycle),
      },
    );
    return cloneRecord(event);
  }

  actionDeliveryStatus(actionExecutionId: string): ActionDeliveryStatus {
    const events = [...this.#events.values()].filter(
      (event) => event.actionExecutionId === actionExecutionId,
    );
    if (events.length === 0) return "NOT_APPLICABLE";
    if (events.some((event) => event.state === "DEAD_LETTER")) return "DEAD_LETTER";
    const delivered = events.filter((event) => event.state === "DELIVERED").length;
    if (delivered === events.length) return "COMPLETE";
    if (delivered > 0) return "PARTIAL";
    return "PENDING";
  }

  health(databaseNow: number): OutboxHealth {
    assertDatabaseTime(databaseNow);
    const events = [...this.#events.values()];
    const undelivered = events.filter((event) => event.state !== "DELIVERED");
    const blockedStreams = new Set(
      events
        .filter((event) => this.#hasUndeliveredPredecessor(event))
        .map((event) => streamKey(event)),
    ).size;
    return {
      pending: events.filter((event) => event.state === "PENDING").length,
      leased: events.filter((event) => event.state === "LEASED").length,
      delivering: events.filter((event) => event.state === "DELIVERING").length,
      retryWait: events.filter((event) => event.state === "RETRY_WAIT").length,
      deadLetter: events.filter((event) => event.state === "DEAD_LETTER").length,
      oldestUndeliveredLagMs:
        undelivered.length === 0
          ? 0
          : Math.max(0, databaseNow - Math.min(...undelivered.map((event) => event.committedAt))),
      blockedStreams,
      retryAttempts: [...this.#attempts.values()].filter(
        (attempt) => attempt.outcome === "RETRY_SCHEDULED" || attempt.outcome === "LEASE_EXPIRED",
      ).length,
    };
  }

  get(eventId: string): OutboxEvent {
    return cloneRecord(this.#requiredEvent(eventId));
  }

  snapshot(): OutboxModelSnapshot {
    return cloneRecord({
      events: Object.fromEntries(this.#events),
      attempts: Object.fromEntries(this.#attempts),
      transactions: Object.fromEntries(this.#transactions),
      audit: this.#audit,
    });
  }

  assertInvariants(): void {
    for (const event of this.#events.values()) {
      const attempts = [...this.#attempts.values()].filter(
        (attempt) => attempt.workKind === "OUTBOX" && attempt.workId === event.id,
      );
      const active = attempts.filter((attempt) => attempt.outcome === "ACTIVE");
      if (event.totalAttempts !== attempts.length) {
        throw new Error(`Outbox Event ${event.id} totalAttempts does not match attempt history.`);
      }
      if (event.state === "LEASED" || event.state === "DELIVERING") {
        if (
          event.lease === null ||
          active.length !== 1 ||
          active[0]?.id !== event.lease.attemptId
        ) {
          throw new Error(`In-flight Outbox Event ${event.id} must have one matching Lease.`);
        }
        const activeAttempt = active[0];
        if (
          activeAttempt === undefined ||
          (event.state === "LEASED" && activeAttempt.deliveryStartedAt !== null) ||
          (event.state === "DELIVERING" && activeAttempt.deliveryStartedAt === null)
        ) {
          throw new Error(`Outbox Event ${event.id} delivery phase disagrees with its Attempt.`);
        }
      } else if (event.lease !== null || active.length !== 0) {
        throw new Error(`Idle Outbox Event ${event.id} cannot have an active Lease or Attempt.`);
      }
      if (
        event.state === "DELIVERED" &&
        (event.deliveredAt === null || event.consumerDisposition === null)
      ) {
        throw new Error(`Delivered Outbox Event ${event.id} lacks consumer acknowledgement.`);
      }
      if (event.attemptsInCycle > this.policy.maximumAttemptsPerCycle) {
        throw new Error(`Outbox Event ${event.id} exceeded its automatic attempt limit.`);
      }
      if (this.#streamPositions.get(streamPositionKey(event.projectId, event)) !== event.id) {
        throw new Error(`Outbox Event ${event.id} stream position index is inconsistent.`);
      }
      const predecessors = this.#predecessors(event);
      if (
        (event.state === "LEASED" || event.state === "DELIVERING" || event.state === "DELIVERED") &&
        predecessors.some((predecessor) => predecessor.state !== "DELIVERED")
      ) {
        throw new Error(`Outbox Event ${event.id} advanced ahead of an undelivered predecessor.`);
      }
    }
    const inFlightStreams = new Set<string>();
    for (const event of this.#events.values()) {
      if (event.state !== "LEASED" && event.state !== "DELIVERING") continue;
      const key = streamKey(event);
      if (inFlightStreams.has(key))
        throw new Error(`Outbox stream ${key} has concurrent delivery.`);
      inFlightStreams.add(key);
    }
    for (const transaction of this.#transactions.values()) {
      for (const eventId of transaction.eventIds) {
        if (this.#events.get(eventId)?.businessTransactionId !== transaction.id) {
          throw new Error(`Business transaction ${transaction.id} event index is inconsistent.`);
        }
      }
    }
    this.#audit.forEach((record, index) => {
      if (record.sequence !== index + 1) throw new Error("Audit sequence is not contiguous.");
    });
  }

  #finishFailure(
    event: OutboxEvent,
    attempt: OutboxDeliveryAttempt,
    failure: FailureCause,
    databaseNow: number,
    actorType: AuditRecord["actorType"],
    actorId: string,
    attemptOutcome: WorkAttempt["outcome"] = "RETRY_SCHEDULED",
  ): OutboxEvent {
    const canRetry =
      failure.retryable && event.attemptsInCycle < this.policy.maximumAttemptsPerCycle;
    attempt.finishedAt = databaseNow;
    attempt.failure = cloneRecord(failure);
    attempt.outcome = canRetry ? attemptOutcome : "DEAD_LETTER";
    event.firstFailure ??= cloneRecord(failure);
    event.lastFailure = cloneRecord(failure);
    event.lease = null;
    event.stateChangedAt = databaseNow;
    event.lastObservedDatabaseAt = databaseNow;

    if (canRetry) {
      event.state = "RETRY_WAIT";
      event.availableAt = addDatabaseDuration(
        databaseNow,
        retryBackoffMs(event.attemptsInCycle, this.policy),
      );
      this.#appendAudit(
        event,
        "OUTBOX_RETRY_SCHEDULED",
        actorType,
        actorId,
        attempt.id,
        databaseNow,
        {
          deliveryMayHaveOccurred: String(attempt.deliveryStartedAt !== null),
          failureCode: failure.code,
          availableAt: String(event.availableAt),
        },
      );
    } else {
      event.state = "DEAD_LETTER";
      this.#appendAudit(
        event,
        "OUTBOX_DEAD_LETTERED",
        actorType,
        actorId,
        attempt.id,
        databaseNow,
        {
          deliveryMayHaveOccurred: String(attempt.deliveryStartedAt !== null),
          failureCode: failure.code,
          retryable: String(failure.retryable),
        },
      );
    }
    return event;
  }

  #hasUndeliveredPredecessor(event: OutboxEvent): boolean {
    return this.#predecessors(event).some((predecessor) => predecessor.state !== "DELIVERED");
  }

  #predecessors(event: OutboxEvent): OutboxEvent[] {
    return [...this.#events.values()].filter(
      (candidate) =>
        streamKey(candidate) === streamKey(event) && compareStreamPosition(candidate, event) < 0,
    );
  }

  #assertInFlight(event: OutboxEvent): void {
    if (event.state !== "LEASED" && event.state !== "DELIVERING") {
      throw new DurableWorkError("INVALID_STATE", `Outbox Event ${event.id} is not in flight.`);
    }
  }

  #requiredEvent(eventId: string): OutboxEvent {
    const event = this.#events.get(eventId);
    if (event === undefined) {
      throw new DurableWorkError("NOT_FOUND", `Outbox Event ${eventId} was not found.`);
    }
    return event;
  }

  #requiredAttempt(attemptId: string): OutboxDeliveryAttempt {
    const attempt = this.#attempts.get(attemptId);
    if (attempt === undefined) {
      throw new DurableWorkError("NOT_FOUND", `Attempt ${attemptId} was not found.`);
    }
    return attempt;
  }

  #appendAudit(
    event: OutboxEvent,
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
      workKind: "OUTBOX",
      workId: event.id,
      attemptId,
      actorType,
      actorId,
      correlationId: event.correlationId,
      databaseAt,
      details: cloneRecord(details),
    });
  }
}

function validateCommit(input: CommitBusinessTransactionInput): void {
  requireNonEmpty(input.businessTransactionId, "businessTransactionId");
  requireNonEmpty(input.transactionDigest, "transactionDigest");
  requireNonEmpty(input.projectId, "projectId");
  requireNonEmpty(input.correlationId, "correlationId");
  assertDatabaseTime(input.databaseNow);
}

function validateNewEvent(event: NewOutboxEvent): void {
  for (const [field, value] of [
    ["id", event.id],
    ["actionExecutionId", event.actionExecutionId],
    ["changeSetId", event.changeSetId],
    ["objectRid", event.objectRid],
    ["destinationId", event.destinationId],
    ["eventType", event.eventType],
    ["payloadSchemaVersion", event.payloadSchemaVersion],
    ["payloadDigest", event.payloadDigest],
    ["actorId", event.actorId],
  ] as const) {
    requireNonEmpty(value, field);
  }
  if (event.changeSetSequence < 0n || event.changeSetSequence > MAX_POSTGRES_BIGINT) {
    throw new DurableWorkError(
      "INVALID_ARGUMENT",
      "changeSetSequence must fit a non-negative PostgreSQL bigint.",
    );
  }
  if (!Number.isSafeInteger(event.eventOrdinal) || event.eventOrdinal < 0) {
    throw new DurableWorkError("INVALID_ARGUMENT", "eventOrdinal must be a non-negative integer.");
  }
}

function validateAcknowledgement(acknowledgement: ConsumerAcknowledgement): void {
  requireNonEmpty(acknowledgement.eventId, "acknowledgement.eventId");
  requireNonEmpty(acknowledgement.consumerId, "acknowledgement.consumerId");
}

function compareEvents(left: OutboxEvent, right: OutboxEvent): number {
  return (
    compareNumber(left.availableAt, right.availableAt) ||
    compareNumber(left.committedAt, right.committedAt) ||
    compareText(streamKey(left), streamKey(right)) ||
    compareStreamPosition(left, right)
  );
}

function compareStreamPosition(
  left: Pick<OutboxEvent, "changeSetSequence" | "eventOrdinal" | "id">,
  right: Pick<OutboxEvent, "changeSetSequence" | "eventOrdinal" | "id">,
): number {
  if (left.changeSetSequence < right.changeSetSequence) return -1;
  if (left.changeSetSequence > right.changeSetSequence) return 1;
  return compareNumber(left.eventOrdinal, right.eventOrdinal) || compareText(left.id, right.id);
}

function streamKey(event: Pick<OutboxEvent, "projectId" | "destinationId" | "objectRid">): string {
  return JSON.stringify([event.projectId, event.destinationId, event.objectRid]);
}

function streamPositionKey(
  projectId: string,
  event: Pick<NewOutboxEvent, "destinationId" | "objectRid" | "changeSetSequence" | "eventOrdinal">,
): string {
  return JSON.stringify([
    projectId,
    event.destinationId,
    event.objectRid,
    event.changeSetSequence.toString(),
    event.eventOrdinal,
  ]);
}

function eventDefinitionSignature(events: readonly NewOutboxEvent[]): string {
  const encodedEvents = events.map((event) =>
    JSON.stringify([
      event.id,
      event.actionExecutionId,
      event.changeSetId,
      event.changeSetSequence.toString(),
      String(event.eventOrdinal),
      event.objectRid,
      event.destinationId,
      event.eventType,
      event.payloadSchemaVersion,
      event.payloadDigest,
      event.actorId,
    ]),
  );
  encodedEvents.sort(compareText);
  return JSON.stringify(encodedEvents);
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
