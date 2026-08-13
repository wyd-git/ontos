import assert from "node:assert/strict";
import test from "node:test";

import {
  EpochNotificationBus,
  InMemoryAuthorizationStore,
  InMemoryCompiledPolicyStore,
  ManualClock,
  type CompiledPolicyArtifact,
  type CompiledPolicyKey,
  type CompiledPolicyReader,
  type AuthorizationSnapshot,
  type AuthorizationSnapshotReader,
  type Clock,
} from "./model.ts";
import {
  PolicyDecisionProcess,
  createPolicyDecisionCacheKey,
  serializePolicyDecisionCacheKey,
  type PolicyDecisionRequest,
  type PolicyFailureObservation,
} from "./process.ts";

const projectId = "project-1";
const resourceId = "resource-customer";
const permission = "object.read";

void test("authorization facts and Project Epoch commit atomically", () => {
  const databaseClock = new ManualClock(100);
  const notifications = new EpochNotificationBus();
  const store = new InMemoryAuthorizationStore(databaseClock, notifications);
  const observedEpochs: bigint[] = [];
  notifications.subscribe("observer", (notification) => observedEpochs.push(notification.epoch));
  store.createProject(projectId);

  const committed = store.transactAuthorizationChange(projectId, (draft) => {
    draft.grant(binding("user-alice"));
  });
  assert.deepEqual(committed, {
    projectId,
    epoch: 2n,
    changed: true,
    committedAt: 100,
  });
  assert.deepEqual(store.inspectProject(projectId), {
    projectId,
    epoch: 2n,
    bindingCount: 1,
    changedAt: 100,
  });
  assert.deepEqual(observedEpochs, [2n]);

  assert.throws(() =>
    store.transactAuthorizationChange(projectId, (draft) => {
      draft.grant(binding("user-bob"));
      throw new Error("abort transaction");
    }),
  );
  assert.equal(store.inspectProject(projectId).epoch, 2n);
  assert.equal(store.inspectProject(projectId).bindingCount, 1);
  assert.deepEqual(observedEpochs, [2n]);

  const noOp = store.transactAuthorizationChange(projectId, (draft) => {
    draft.grant(binding("user-alice"));
  });
  assert.equal(noOp.changed, false);
  assert.equal(noOp.epoch, 2n);
  assert.deepEqual(observedEpochs, [2n]);
});

void test("cache key separates every authorization and execution dimension", () => {
  const base = request();
  const candidates = [
    createPolicyDecisionCacheKey(base, 2n),
    createPolicyDecisionCacheKey({ ...base, projectId: "project-2" }, 2n),
    createPolicyDecisionCacheKey(
      { ...base, identity: { ...base.identity, subjectId: "user-bob" } },
      2n,
    ),
    createPolicyDecisionCacheKey(
      { ...base, identity: { ...base.identity, identityType: "service" } },
      2n,
    ),
    createPolicyDecisionCacheKey(
      { ...base, identity: { ...base.identity, groupPrincipalIds: ["group-sales"] } },
      2n,
    ),
    createPolicyDecisionCacheKey({ ...base, delegationChain: ["user-bob"] }, 2n),
    createPolicyDecisionCacheKey({ ...base, resourceId: "resource-order" }, 2n),
    createPolicyDecisionCacheKey({ ...base, permission: "object.write" }, 2n),
    createPolicyDecisionCacheKey({ ...base, releaseId: "release-2" }, 2n),
    createPolicyDecisionCacheKey({ ...base, policyRevision: "policy-2" }, 2n),
    createPolicyDecisionCacheKey({ ...base, compilerVersion: "compiler-2" }, 2n),
    createPolicyDecisionCacheKey(base, 3n),
  ];
  const serialized = candidates.map(serializePolicyDecisionCacheKey);
  assert.equal(new Set(serialized).size, candidates.length);

  const delimiterA = createPolicyDecisionCacheKey(
    { ...base, projectId: "a", resourceId: "bc" },
    2n,
  );
  const delimiterB = createPolicyDecisionCacheKey(
    { ...base, projectId: "ab", resourceId: "c" },
    2n,
  );
  assert.notEqual(
    serializePolicyDecisionCacheKey(delimiterA),
    serializePolicyDecisionCacheKey(delimiterB),
  );
});

void test("two API processes reject on the next request when revocation notification arrives", () => {
  const harness = createHarness();
  grant(harness.authorizationStore, "user-alice");
  const nodeA = harness.createProcess("api-a", harness.clockA);
  const nodeB = harness.createProcess("api-b", harness.clockB);

  assertDecision(nodeA.decide(request()), "ALLOW", "FRESH", "2");
  assertDecision(nodeB.decide(request()), "ALLOW", "FRESH", "2");
  assert.equal(nodeA.cacheSize, 1);
  assert.equal(nodeB.cacheSize, 1);

  harness.databaseClock.advance(1);
  revoke(harness.authorizationStore, "user-alice");
  assert.equal(nodeA.cacheSize, 0);
  assert.equal(nodeB.cacheSize, 0);
  assert.equal(nodeA.epochFloor(projectId), 3n);
  assert.equal(nodeB.epochFloor(projectId), 3n);
  assertDecision(nodeA.decide(request()), "DENY", "FRESH", "3");
  assertDecision(nodeB.decide(request()), "DENY", "FRESH", "3");
});

void test("a process that loses notification rejects at the inclusive five second boundary", () => {
  const harness = createHarness();
  grant(harness.authorizationStore, "user-alice");
  const nodeA = harness.createProcess("api-a", harness.clockA);
  const nodeB = harness.createProcess("api-b", harness.clockB);
  assertDecision(nodeA.decide(request()), "ALLOW", "FRESH", "2");
  assertDecision(nodeB.decide(request()), "ALLOW", "FRESH", "2");

  harness.notifications.setDelivery("api-b", false);
  harness.databaseClock.advance(1);
  revoke(harness.authorizationStore, "user-alice");
  harness.clockA.set(1);
  assertDecision(nodeA.decide(request()), "DENY", "FRESH", "3");

  harness.clockB.set(4_999);
  assertDecision(nodeB.decide(request()), "ALLOW", "CACHE", "2");
  harness.clockB.set(5_000);
  assertDecision(nodeB.decide(request()), "DENY", "FRESH", "3");
});

void test("dependency failures cannot extend a confirmed cache entry", () => {
  const observations: PolicyFailureObservation[] = [];
  const harness = createHarness(observations);
  grant(harness.authorizationStore, "user-alice");
  const node = harness.createProcess("api-a", harness.clockA);
  assertDecision(node.decide(request()), "ALLOW", "FRESH", "2");

  harness.authorizationStore.setReadFailure(
    new Error("postgres password=SUPER_SECRET should never be observed"),
  );
  harness.compiledPolicies.setReadFailure(
    new Error("artifact token=SUPER_SECRET should never be observed"),
  );
  harness.clockA.set(4_999);
  assertDecision(node.decide(request()), "ALLOW", "CACHE", "2");
  harness.clockA.set(5_000);
  assert.deepEqual(node.decide(request()), {
    decision: "DENY",
    source: "FAIL_CLOSED",
    epoch: null,
    errorCode: "POLICY_EPOCH_UNAVAILABLE",
  });
  harness.clockA.set(9_999);
  assert.deepEqual(node.decide(request()), {
    decision: "DENY",
    source: "FAIL_CLOSED",
    epoch: null,
    errorCode: "POLICY_EPOCH_UNAVAILABLE",
  });
  assert.equal(node.cacheSize, 0);
  assert.doesNotMatch(JSON.stringify(observations), /SUPER_SECRET|password|token=/u);
});

void test("missing, unavailable, and mismatched compiled artifacts fail closed", () => {
  const observations: PolicyFailureObservation[] = [];
  const harness = createHarness(observations);
  grant(harness.authorizationStore, "user-alice");
  const node = harness.createProcess("api-a", harness.clockA);

  assert.deepEqual(node.decide({ ...request(), policyRevision: "missing" }), {
    decision: "DENY",
    source: "FAIL_CLOSED",
    epoch: null,
    errorCode: "POLICY_ARTIFACT_NOT_FOUND",
  });
  harness.compiledPolicies.setReadFailure(new Error("raw compiler stack SECRET_VALUE"));
  assert.deepEqual(node.decide(request()), {
    decision: "DENY",
    source: "FAIL_CLOSED",
    epoch: null,
    errorCode: "POLICY_ARTIFACT_UNAVAILABLE",
  });
  assert.doesNotMatch(JSON.stringify(observations), /SECRET_VALUE|raw compiler stack/u);
  assert.ok(observations.every((event) => event.projectRef !== projectId));
  assert.ok(observations.every((event) => event.correlationRef !== "correlation-1"));

  const wrongArtifactReader: CompiledPolicyReader = {
    getCompiledPolicy() {
      return { ...policyArtifact(), projectId: "project-other" };
    },
  };
  const mismatchedNode = new PolicyDecisionProcess({
    processId: "api-mismatched-artifact",
    monotonicClock: new ManualClock(0),
    authorizationStore: harness.authorizationStore,
    compiledPolicies: wrongArtifactReader,
    notifications: harness.notifications,
  });
  harness.compiledPolicies.setReadFailure(null);
  assert.equal(mismatchedNode.decide(request()).errorCode, "POLICY_ARTIFACT_UNAVAILABLE");
});

void test("compiled Policy keys are immutable", () => {
  const store = new InMemoryCompiledPolicyStore();
  store.publish(policyArtifact());
  store.publish(policyArtifact());
  assert.throws(
    () => store.publish({ ...policyArtifact(), artifactDigest: "sha256:different" }),
    /immutable/u,
  );
  assert.equal(
    store.getCompiledPolicy(policyArtifact()).artifactDigest,
    "sha256:policy-fixture-v1",
  );
});

void test("Gateway rejects malformed authorization snapshots returned by an Adapter", () => {
  const harness = createHarness();
  const malformedStore: AuthorizationSnapshotReader = {
    readAuthorizationSnapshot(): AuthorizationSnapshot {
      return {
        projectId: "project-other",
        epoch: 2n,
        observedDatabaseAt: 100,
        actorAllowed: true,
        delegationAllowed: [],
      };
    },
  };
  const node = new PolicyDecisionProcess({
    processId: "api-malformed-snapshot",
    monotonicClock: harness.clockA,
    authorizationStore: malformedStore,
    compiledPolicies: harness.compiledPolicies,
    notifications: harness.notifications,
  });
  assert.equal(node.decide(request()).errorCode, "POLICY_EPOCH_UNAVAILABLE");
  assert.equal(node.cacheSize, 0);
});

void test("stale notification cannot roll Epoch back and an ahead notification fails closed", () => {
  const harness = createHarness();
  grant(harness.authorizationStore, "user-alice");
  const node = harness.createProcess("api-a", harness.clockA);
  assertDecision(node.decide(request()), "ALLOW", "FRESH", "2");

  node.observeNotification({ protocolVersion: 1, projectId, epoch: 1n });
  assert.equal(node.epochFloor(projectId), 2n);
  assertDecision(node.decide(request()), "ALLOW", "CACHE", "2");

  node.observeNotification({ protocolVersion: 1, projectId, epoch: 99n });
  assert.equal(node.cacheSize, 0);
  assert.deepEqual(node.decide(request()), {
    decision: "DENY",
    source: "FAIL_CLOSED",
    epoch: null,
    errorCode: "POLICY_EPOCH_UNCONFIRMED",
  });
  node.observeNotification({ protocolVersion: 1, projectId, epoch: 2n });
  assert.equal(node.epochFloor(projectId), 99n);
});

void test("a revocation racing dependency reads cannot insert a stale Allow", () => {
  const harness = createHarness();
  grant(harness.authorizationStore, "user-alice");
  const racingReader = new RacingCompiledPolicyReader(harness.compiledPolicies, () => {
    harness.databaseClock.advance(1);
    revoke(harness.authorizationStore, "user-alice");
  });
  const node = new PolicyDecisionProcess({
    processId: "api-race",
    monotonicClock: harness.clockA,
    authorizationStore: harness.authorizationStore,
    compiledPolicies: racingReader,
    notifications: harness.notifications,
  });

  assert.deepEqual(node.decide(request()), {
    decision: "DENY",
    source: "FAIL_CLOSED",
    epoch: null,
    errorCode: "POLICY_EPOCH_UNCONFIRMED",
  });
  assert.equal(node.cacheSize, 0);
});

void test("database wall-clock rollback cannot extend TTL", () => {
  const harness = createHarness();
  grant(harness.authorizationStore, "user-alice");
  const node = harness.createProcess("api-a", harness.clockA);
  assertDecision(node.decide(request()), "ALLOW", "FRESH", "2");
  const readsBeforeExpiry = harness.authorizationStore.readCount;

  harness.databaseClock.set(1);
  harness.clockA.set(4_999);
  assertDecision(node.decide(request()), "ALLOW", "CACHE", "2");
  assert.equal(harness.authorizationStore.readCount, readsBeforeExpiry);
  harness.clockA.set(5_000);
  assertDecision(node.decide(request()), "ALLOW", "FRESH", "2");
  assert.equal(harness.authorizationStore.readCount, readsBeforeExpiry + 1);
});

void test("monotonic clock rollback clears cache and permanently fails the process closed", () => {
  const harness = createHarness();
  grant(harness.authorizationStore, "user-alice");
  harness.clockA.set(100);
  const node = harness.createProcess("api-a", harness.clockA);
  assertDecision(node.decide(request()), "ALLOW", "FRESH", "2");

  harness.clockA.set(99);
  assert.deepEqual(node.decide(request()), {
    decision: "DENY",
    source: "FAIL_CLOSED",
    epoch: null,
    errorCode: "POLICY_MONOTONIC_CLOCK_UNSAFE",
  });
  assert.equal(node.cacheSize, 0);
  harness.clockA.set(101);
  assert.equal(node.decide(request()).errorCode, "POLICY_MONOTONIC_CLOCK_UNSAFE");

  const replacementClock = new ManualClock(101);
  const replacement = harness.createProcess("api-a-replacement", replacementClock);
  assertDecision(replacement.decide(request()), "ALLOW", "FRESH", "2");
});

void test("a throwing monotonic clock permanently fails the process closed", () => {
  const harness = createHarness();
  let shouldThrow = false;
  const throwingClock: Clock = {
    now() {
      if (shouldThrow) throw new Error("clock secret");
      return 0;
    },
  };
  grant(harness.authorizationStore, "user-alice");
  const node = new PolicyDecisionProcess({
    processId: "api-throwing-clock",
    monotonicClock: throwingClock,
    authorizationStore: harness.authorizationStore,
    compiledPolicies: harness.compiledPolicies,
    notifications: harness.notifications,
  });
  assert.equal(node.decide(request()).decision, "ALLOW");
  shouldThrow = true;
  assert.equal(node.decide(request()).errorCode, "POLICY_MONOTONIC_CLOCK_UNSAFE");
  shouldThrow = false;
  assert.equal(node.decide(request()).errorCode, "POLICY_MONOTONIC_CLOCK_UNSAFE");
});

void test("delegation is an intersection and Group Claims form a separate Actor cache key", () => {
  const harness = createHarness();
  grant(harness.authorizationStore, "service-automation");
  grant(harness.authorizationStore, "group-operators");
  const node = harness.createProcess("api-a", harness.clockA);
  const delegated = request({
    identity: {
      subjectId: "service-automation",
      identityType: "service",
      groupPrincipalIds: [],
    },
    delegationChain: ["user-alice"],
  });
  assertDecision(node.decide(delegated), "DENY", "FRESH", "3");

  harness.databaseClock.advance(1);
  grant(harness.authorizationStore, "user-alice");
  assertDecision(node.decide(delegated), "ALLOW", "FRESH", "4");

  const directWithoutGroup = request({
    identity: { subjectId: "user-charlie", identityType: "human", groupPrincipalIds: [] },
  });
  const directWithGroup = request({
    identity: {
      subjectId: "user-charlie",
      identityType: "human",
      groupPrincipalIds: ["group-operators"],
    },
  });
  assertDecision(node.decide(directWithoutGroup), "DENY", "FRESH", "4");
  assertDecision(node.decide(directWithGroup), "ALLOW", "FRESH", "4");
});

void test("cache TTL configuration cannot exceed five seconds", () => {
  const harness = createHarness();
  assert.throws(
    () =>
      new PolicyDecisionProcess({
        processId: "api-invalid",
        cacheTtlMs: 5_001,
        monotonicClock: harness.clockA,
        authorizationStore: harness.authorizationStore,
        compiledPolicies: harness.compiledPolicies,
        notifications: harness.notifications,
      }),
    /five second hard limit/u,
  );
});

void test("telemetry failure cannot change a fail-closed decision", () => {
  const harness = createHarness();
  const node = new PolicyDecisionProcess({
    processId: "api-observer-failure",
    monotonicClock: harness.clockA,
    authorizationStore: harness.authorizationStore,
    compiledPolicies: harness.compiledPolicies,
    notifications: harness.notifications,
    observeFailure() {
      throw new Error("telemetry unavailable");
    },
  });
  harness.authorizationStore.setReadFailure(new Error("database unavailable"));
  assert.deepEqual(node.decide(request()), {
    decision: "DENY",
    source: "FAIL_CLOSED",
    epoch: null,
    errorCode: "POLICY_EPOCH_UNAVAILABLE",
  });
});

interface Harness {
  databaseClock: ManualClock;
  clockA: ManualClock;
  clockB: ManualClock;
  notifications: EpochNotificationBus;
  authorizationStore: InMemoryAuthorizationStore;
  compiledPolicies: InMemoryCompiledPolicyStore;
  createProcess(processId: string, clock: ManualClock): PolicyDecisionProcess;
}

function createHarness(observations: PolicyFailureObservation[] = []): Harness {
  const databaseClock = new ManualClock(100);
  const clockA = new ManualClock(0);
  const clockB = new ManualClock(0);
  const notifications = new EpochNotificationBus();
  const authorizationStore = new InMemoryAuthorizationStore(databaseClock, notifications);
  const compiledPolicies = new InMemoryCompiledPolicyStore();
  authorizationStore.createProject(projectId);
  compiledPolicies.publish(policyArtifact());
  return {
    databaseClock,
    clockA,
    clockB,
    notifications,
    authorizationStore,
    compiledPolicies,
    createProcess(processId, clock) {
      return new PolicyDecisionProcess({
        processId,
        monotonicClock: clock,
        authorizationStore,
        compiledPolicies,
        notifications,
        observeFailure(observation) {
          observations.push(observation);
        },
      });
    },
  };
}

class RacingCompiledPolicyReader implements CompiledPolicyReader {
  readonly #delegate: CompiledPolicyReader;
  readonly #race: () => void;
  #didRace = false;

  constructor(delegate: CompiledPolicyReader, race: () => void) {
    this.#delegate = delegate;
    this.#race = race;
  }

  getCompiledPolicy(key: CompiledPolicyKey): CompiledPolicyArtifact {
    const artifact = this.#delegate.getCompiledPolicy(key);
    if (!this.#didRace) {
      this.#didRace = true;
      this.#race();
    }
    return artifact;
  }
}

function grant(store: InMemoryAuthorizationStore, principalId: string): void {
  store.transactAuthorizationChange(projectId, (draft) => draft.grant(binding(principalId)));
}

function revoke(store: InMemoryAuthorizationStore, principalId: string): void {
  store.transactAuthorizationChange(projectId, (draft) => draft.revoke(binding(principalId)));
}

function binding(principalId: string): {
  principalId: string;
  resourceId: string;
  permission: string;
} {
  return { principalId, resourceId, permission };
}

function policyArtifact(): CompiledPolicyArtifact {
  return {
    projectId,
    releaseId: "release-1",
    policyRevision: "policy-1",
    compilerVersion: "compiler-1",
    artifactDigest: "sha256:policy-fixture-v1",
    evaluationContract: "RESOURCE_PERMISSION_INTERSECTION_V1",
  };
}

function request(overrides: Partial<PolicyDecisionRequest> = {}): PolicyDecisionRequest {
  const base: PolicyDecisionRequest = {
    projectId,
    identity: { subjectId: "user-alice", identityType: "human", groupPrincipalIds: [] },
    delegationChain: [],
    resourceId,
    permission,
    releaseId: "release-1",
    policyRevision: "policy-1",
    compilerVersion: "compiler-1",
    correlationId: "correlation-1",
  };
  return { ...base, ...overrides };
}

function assertDecision(
  actual: ReturnType<PolicyDecisionProcess["decide"]>,
  decision: "ALLOW" | "DENY",
  source: "CACHE" | "FRESH",
  epoch: string,
): void {
  assert.deepEqual(actual, { decision, source, epoch, errorCode: null });
}
