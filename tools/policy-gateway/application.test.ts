import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeContractForDigest,
  parseCanonicalInstant,
  parseIdentityDelegationSummary,
  type ArtifactDigest,
  type IdentityType,
  type ManagementRoleValue,
} from "@ontos/contracts";
import type { RuntimeIdentityContext } from "@ontos/identity-application";
import {
  ProductionPolicyGateway,
  createPolicyGatewayCacheKey,
  serializePolicyGatewayCacheKey,
  type PolicyEpochNotification,
  type PolicyEpochNotificationHandler,
  type PolicyEpochNotificationSource,
  type PolicyGatewayArtifactReader,
  type PolicyGatewayMonotonicClock,
  type PolicyGatewayObservation,
  type PolicyGatewayRequest,
  type PolicyGatewaySnapshot,
  type PolicyGatewaySnapshotPrincipal,
  type PolicyGatewaySnapshotRepository,
} from "@ontos/policy-application";
import {
  POLICY_COMPILER_VERSION,
  compilePolicy,
  policyGatewayPermissionsForRoles,
} from "@ontos/policy-domain";
import fc from "fast-check";

import { compileInput, policyIds, sha256 } from "../policy-compiler/fixtures.ts";

const ids = Object.freeze({
  human: "018f47a2-755b-7cc3-98c8-4d2fb871c320",
  service: "018f47a2-755b-7cc3-98c8-4d2fb871c321",
  nestedService: "018f47a2-755b-7cc3-98c8-4d2fb871c322",
  compilation: "018f47a2-755b-7cc3-98c8-4d2fb871c323",
});
const observedAt = "2026-08-20T08:00:00.000000Z" as const;
const compiled = compilePolicy(compileInput());

void test("coarse Object Read roles can only be narrowed and unknown permissions deny", () => {
  assert.deepEqual(
    policyGatewayPermissionsForRoles({
      projectRole: "owner",
      resourceRole: "viewer",
      resourceBindingPresent: true,
    }),
    ["object.read"],
  );
  assert.deepEqual(
    policyGatewayPermissionsForRoles({
      projectRole: "owner",
      resourceRole: "auditor",
      resourceBindingPresent: true,
    }),
    [],
  );
  assert.deepEqual(
    policyGatewayPermissionsForRoles({
      projectRole: "auditor",
      resourceRole: "owner",
      resourceBindingPresent: true,
    }),
    [],
  );
  assert.throws(() =>
    policyGatewayPermissionsForRoles({
      projectRole: "viewer",
      resourceRole: null,
      resourceBindingPresent: true,
    }),
  );
});

void test("fresh Human authorization loads one exact snapshot/artifact and then uses the hard cache", async () => {
  const clock = new ManualClock();
  const repository = new MemorySnapshotRepository(humanContext());
  const artifacts = new MemoryArtifactReader();
  const observations: PolicyGatewayObservation[] = [];
  const gateway = makeGateway({ clock, repository, artifacts, observations });

  const fresh = await gateway.authorize(baseRequest(humanContext()));
  assert.equal(fresh.decision, "ALLOW");
  assert.equal(fresh.source, "FRESH");
  assert.equal(fresh.epoch, "1");
  assert.equal(fresh.context?.artifactDigest, compiled.artifactDigest);
  assert.equal(fresh.context?.policyRules.length, compiled.artifact.rules.length);
  assert.deepEqual(fresh.context?.trustedActorAttributes, [{ name: "region", value: "EU" }]);
  assert.equal(repository.readCount, 1);
  assert.equal(artifacts.readCount, 1);

  clock.set(4_999);
  const cached = await gateway.authorize(baseRequest(humanContext(), "corr_cached_policy_gateway"));
  assert.equal(cached.decision, "ALLOW");
  assert.equal(cached.source, "CACHE");
  assert.equal(repository.readCount, 1);
  assert.equal(artifacts.readCount, 1);
  assert.deepEqual(
    observations.map(({ decisionCode, cacheOutcome }) => ({ decisionCode, cacheOutcome })),
    [
      { decisionCode: "ALLOW", cacheOutcome: "MISS" },
      { decisionCode: "ALLOW", cacheOutcome: "HIT" },
    ],
  );
  gateway.dispose();
});

void test("notification loss never extends Allow beyond the inclusive five-second boundary", async () => {
  const clock = new ManualClock();
  const context = humanContext();
  const repository = new MemorySnapshotRepository(context);
  const gateway = makeGateway({ clock, repository });

  assert.equal((await gateway.authorize(baseRequest(context))).decision, "ALLOW");
  repository.epoch = 2n;
  repository.projectRole = null;

  clock.set(4_999);
  assert.equal(
    (await gateway.authorize(baseRequest(context, "corr_before_ttl_boundary"))).decision,
    "ALLOW",
  );
  clock.set(5_000);
  const denied = await gateway.authorize(baseRequest(context, "corr_at_ttl_boundary_0"));
  assert.equal(denied.decision, "DENY");
  assert.equal(denied.source, "FRESH");
  assert.equal(denied.epoch, "2");
  assert.equal(repository.readCount, 2);
  gateway.dispose();
});

void test("every configured hard TTL expires inclusively without sliding", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 5_000 }), async (cacheTtlMs) => {
      const clock = new ManualClock();
      const context = humanContext();
      const repository = new MemorySnapshotRepository(context);
      const gateway = makeGateway({ clock, repository, cacheTtlMs });

      assert.equal((await gateway.authorize(baseRequest(context))).decision, "ALLOW");
      repository.epoch = 2n;
      repository.projectRole = null;
      const suffix = String(cacheTtlMs).padStart(4, "0");
      clock.set(cacheTtlMs - 1);
      const before = await gateway.authorize(
        baseRequest(context, `corr_ttl_before_bound_${suffix}`),
      );
      assert.equal(before.source, "CACHE", JSON.stringify(before));
      clock.set(cacheTtlMs);
      const expired = await gateway.authorize(baseRequest(context, `corr_ttl_at_bound_${suffix}`));
      assert.equal(expired.decision, "DENY", JSON.stringify(expired));
      assert.equal(expired.source, "FRESH", JSON.stringify(expired));
      assert.equal(repository.readCount, 2, JSON.stringify({ before, expired }));
      gateway.dispose();
    }),
    { numRuns: 64 },
  );
});

void test("duplicate, out-of-order and jumping notifications only raise the Project floor", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 100 }),
      (epochs) => {
        const gateway = makeGateway();
        for (const epoch of epochs) {
          gateway.observeNotification({
            protocolVersion: 1,
            projectId: policyIds.project,
            epoch: BigInt(epoch),
          });
        }
        assert.equal(gateway.epochFloor(policyIds.project), BigInt(Math.max(1, ...epochs)));
        gateway.dispose();
      },
    ),
    { numRuns: 100 },
  );
});

void test("two processes invalidate on the next request while a listener-free process remains TTL-safe", async () => {
  const bus = new NotificationBus();
  const context = humanContext();
  const repoA = new MemorySnapshotRepository(context);
  const repoB = new MemorySnapshotRepository(context);
  const clockA = new ManualClock();
  const clockB = new ManualClock();
  const processA = makeGateway({ clock: clockA, repository: repoA, notifications: bus });
  const processB = makeGateway({ clock: clockB, repository: repoB, notifications: bus });
  const processWithoutListener = makeGateway({
    clock: new ManualClock(),
    repository: new MemorySnapshotRepository(context),
  });

  assert.equal((await processA.authorize(baseRequest(context))).decision, "ALLOW");
  assert.equal((await processB.authorize(baseRequest(context))).decision, "ALLOW");
  assert.equal((await processWithoutListener.authorize(baseRequest(context))).decision, "ALLOW");
  for (const repository of [repoA, repoB]) {
    repository.epoch = 2n;
    repository.projectRole = null;
  }
  bus.publish({ protocolVersion: 1, projectId: policyIds.project, epoch: 2n });
  assert.equal(
    (await processA.authorize(baseRequest(context, "corr_process_a_revoked"))).decision,
    "DENY",
  );
  assert.equal(
    (await processB.authorize(baseRequest(context, "corr_process_b_revoked"))).decision,
    "DENY",
  );
  assert.equal(repoA.readCount, 2);
  assert.equal(repoB.readCount, 2);
  assert.equal(
    (await processWithoutListener.authorize(baseRequest(context, "corr_listener_free_cached")))
      .decision,
    "ALLOW",
  );
  processA.dispose();
  processB.dispose();
  processWithoutListener.dispose();
});

void test("Service and Delegated authorization use current capability plus every Principal intersection", async () => {
  const service = serviceContext();
  const serviceRepository = new MemorySnapshotRepository(service);
  const serviceGateway = makeGateway({ repository: serviceRepository });
  assert.equal((await serviceGateway.authorize(baseRequest(service))).decision, "ALLOW");
  serviceRepository.serviceCapabilities = [];
  serviceRepository.epoch = 2n;
  serviceGateway.observeNotification({
    protocolVersion: 1,
    projectId: policyIds.project,
    epoch: 2n,
  });
  assert.equal(
    (await serviceGateway.authorize(baseRequest(service, "corr_service_revoked"))).decision,
    "DENY",
  );

  const delegated = delegatedContext();
  const delegatedRepository = new MemorySnapshotRepository(delegated);
  const delegatedGateway = makeGateway({ repository: delegatedRepository });
  assert.equal((await delegatedGateway.authorize(baseRequest(delegated))).decision, "ALLOW");
  delegatedRepository.deniedPrincipalId = ids.human;
  delegatedRepository.epoch = 2n;
  delegatedGateway.observeNotification({
    protocolVersion: 1,
    projectId: policyIds.project,
    epoch: 2n,
  });
  assert.equal(
    (await delegatedGateway.authorize(baseRequest(delegated, "corr_delegated_intersection")))
      .decision,
    "DENY",
  );
  serviceGateway.dispose();
  delegatedGateway.dispose();
});

void test("every decision-key dimension is length-delimited and independently changes the key", () => {
  const base = {
    projectId: policyIds.project,
    identityFingerprint: sha256("identity-a"),
    delegationFingerprint: sha256("delegation-a"),
    resourceId: policyIds.workItemResource,
    permission: "object.read",
    releaseId: policyIds.release,
    policyRevisionId: policyIds.policyRevision,
    compilerVersion: POLICY_COMPILER_VERSION,
  } as const;
  const baseline = serializePolicyGatewayCacheKey(createPolicyGatewayCacheKey(base, 1n));
  const mutations = [
    { ...base, projectId: "018f47a2-755b-7cc3-98c8-4d2fb871c330" },
    { ...base, identityFingerprint: sha256("identity-b") },
    { ...base, delegationFingerprint: sha256("delegation-b") },
    { ...base, resourceId: policyIds.personResource },
    { ...base, permission: "object.write" },
    { ...base, releaseId: "018f47a2-755b-7cc3-98c8-4d2fb871c331" },
    { ...base, policyRevisionId: "018f47a2-755b-7cc3-98c8-4d2fb871c332" },
    { ...base, compilerVersion: "policy-compiler-future-v2" },
  ];
  for (const mutation of mutations) {
    assert.notEqual(
      serializePolicyGatewayCacheKey(createPolicyGatewayCacheKey(mutation, 1n)),
      baseline,
    );
  }
  assert.notEqual(serializePolicyGatewayCacheKey(createPolicyGatewayCacheKey(base, 2n)), baseline);
});

void test("snapshot, Artifact, ahead Epoch and dependency failures always fail closed", async () => {
  const context = humanContext();
  const cases: readonly {
    readonly expected: string;
    readonly configure: (
      repository: MemorySnapshotRepository,
      artifacts: MemoryArtifactReader,
      gateway: ProductionPolicyGateway,
    ) => void;
  }[] = [
    {
      expected: "POLICY_EPOCH_UNAVAILABLE",
      configure: (repository) => {
        repository.failure = new Error("secret database detail");
      },
    },
    {
      expected: "POLICY_ARTIFACT_NOT_FOUND",
      configure: (_repository, artifacts) => {
        artifacts.failure = Object.assign(new Error("missing"), { code: "NOT_FOUND" });
      },
    },
    {
      expected: "POLICY_ARTIFACT_UNAVAILABLE",
      configure: (_repository, artifacts) => {
        artifacts.failure = new Error("secret object store detail");
      },
    },
    {
      expected: "POLICY_ARTIFACT_UNAVAILABLE",
      configure: (_repository, artifacts) => {
        artifacts.bytes = `${compiled.artifactBytes}\n`;
      },
    },
    {
      expected: "POLICY_EPOCH_UNCONFIRMED",
      configure: (_repository, _artifacts, gateway) => {
        gateway.observeNotification({
          protocolVersion: 1,
          projectId: policyIds.project,
          epoch: 99n,
        });
      },
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    const repository = new MemorySnapshotRepository(context);
    const artifacts = new MemoryArtifactReader();
    const gateway = makeGateway({ repository, artifacts });
    scenario.configure(repository, artifacts, gateway);
    const result = await gateway.authorize(
      baseRequest(context, `corr_failure_case_${String(index).padStart(16, "0")}`),
    );
    assert.equal(result.decision, "DENY");
    assert.equal(result.source, "FAIL_CLOSED");
    assert.equal(result.errorCode, scenario.expected);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    gateway.dispose();
  }
});

void test("dependency errors never extend an existing entry and clock rollback permanently closes the process", async () => {
  const context = humanContext();
  const clock = new ManualClock();
  const repository = new MemorySnapshotRepository(context);
  const gateway = makeGateway({ context, clock, repository });
  assert.equal((await gateway.authorize(baseRequest(context))).decision, "ALLOW");
  repository.failure = new Error("database unavailable");
  clock.set(4_999);
  assert.equal(
    (await gateway.authorize(baseRequest(context, "corr_dependency_before_ttl"))).decision,
    "ALLOW",
  );
  clock.set(5_000);
  assert.equal(
    (await gateway.authorize(baseRequest(context, "corr_dependency_at_ttl"))).errorCode,
    "POLICY_EPOCH_UNAVAILABLE",
  );
  clock.set(4_000);
  assert.equal(
    (await gateway.authorize(baseRequest(context, "corr_clock_rollback_detected"))).errorCode,
    "POLICY_MONOTONIC_CLOCK_UNSAFE",
  );
  clock.set(6_000);
  assert.equal(
    (await gateway.authorize(baseRequest(context, "corr_clock_process_stays_closed"))).errorCode,
    "POLICY_MONOTONIC_CLOCK_UNSAFE",
  );
  assert.equal(gateway.cacheSize, 0);
  gateway.dispose();
});

void test("Telemetry has an exact safe field set and observer failure cannot change decisions", async () => {
  const observations: PolicyGatewayObservation[] = [];
  const context = humanContext();
  const gateway = makeGateway({
    context,
    observations,
    observe: (observation) => {
      observations.push(observation);
      throw new Error("telemetry unavailable");
    },
  });
  const result = await gateway.authorize(baseRequest(context));
  assert.equal(result.decision, "ALLOW");
  const observation = observations[0];
  assert.ok(observation !== undefined);
  assert.deepEqual(Object.keys(observation).sort(), [
    "cacheOutcome",
    "correlationRef",
    "decisionCode",
    "eventName",
    "latencyMs",
    "projectRef",
  ]);
  const serialized = JSON.stringify(observation);
  for (const forbidden of [ids.human, "EU", "region", "object_property", "SELECT", "token"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.ok(observation.projectRef.startsWith("sha256:"));
  gateway.dispose();
});

function makeGateway(
  options: {
    readonly context?: RuntimeIdentityContext;
    readonly clock?: ManualClock;
    readonly repository?: MemorySnapshotRepository;
    readonly artifacts?: MemoryArtifactReader;
    readonly notifications?: PolicyEpochNotificationSource;
    readonly observations?: PolicyGatewayObservation[];
    readonly observe?: (observation: PolicyGatewayObservation) => void;
    readonly cacheTtlMs?: number;
  } = {},
): ProductionPolicyGateway {
  const context = options.context ?? humanContext();
  const observations = options.observations ?? [];
  return new ProductionPolicyGateway({
    processId: "policy-test-process",
    repository: options.repository ?? new MemorySnapshotRepository(context),
    artifacts: options.artifacts ?? new MemoryArtifactReader(),
    monotonicClock: options.clock ?? new ManualClock(),
    digestCanonicalText: sha256,
    ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
    ...(options.notifications === undefined ? {} : { notifications: options.notifications }),
    observe: options.observe ?? ((observation) => observations.push(observation)),
  });
}

function baseRequest(
  identity: RuntimeIdentityContext,
  correlationId = "corr_policy_gateway_request_0001",
): PolicyGatewayRequest {
  return Object.freeze({
    projectId: policyIds.project,
    identity,
    resourceId: policyIds.workItemResource,
    permission: "object.read",
    releaseId: policyIds.release,
    policyRevisionId: policyIds.policyRevision,
    compilerVersion: POLICY_COMPILER_VERSION,
    correlationId,
  });
}

function humanContext(): RuntimeIdentityContext {
  return runtimeIdentity({
    actor: { principalId: ids.human, identityType: "human" },
    delegationChain: [],
    attributes: [{ name: "region", value: "EU" }],
    capabilities: [],
  });
}

function serviceContext(): RuntimeIdentityContext {
  return runtimeIdentity({
    actor: { principalId: ids.service, identityType: "service" },
    delegationChain: [],
    attributes: [{ name: "region", value: "EU" }],
    capabilities: ["object.read"],
  });
}

function delegatedContext(): RuntimeIdentityContext {
  return runtimeIdentity({
    actor: { principalId: ids.service, identityType: "service" },
    delegationChain: [{ principalId: ids.human, identityType: "human" }],
    attributes: [{ name: "region", value: "EU" }],
    capabilities: ["object.read"],
  });
}

function runtimeIdentity(input: {
  readonly actor: { readonly principalId: string; readonly identityType: IdentityType };
  readonly delegationChain: readonly {
    readonly principalId: string;
    readonly identityType: IdentityType;
  }[];
  readonly attributes: readonly { readonly name: string; readonly value: string }[];
  readonly capabilities: readonly string[];
}): RuntimeIdentityContext {
  const identity = parseIdentityDelegationSummary({
    schemaVersion: 1,
    actor: input.actor,
    delegationChain: input.delegationChain,
    claimsFingerprint: sha256(canonicalizeContractForDigest(input.attributes)),
    authenticatedAt: observedAt,
    authorizationMode: "intersection",
  });
  return Object.freeze({
    identity,
    attributes: Object.freeze(input.attributes.map((attribute) => Object.freeze(attribute))),
    capabilities: Object.freeze([...input.capabilities]),
    authorizationPrincipalIds: Object.freeze([
      identity.actor.principalId,
      ...identity.delegationChain.map(({ principalId }) => principalId),
    ]),
  });
}

class ManualClock implements PolicyGatewayMonotonicClock {
  #now = 0;

  nowMilliseconds(): number {
    return this.#now;
  }

  set(value: number): void {
    this.#now = value;
  }
}

class MemorySnapshotRepository implements PolicyGatewaySnapshotRepository {
  readonly #context: RuntimeIdentityContext;
  readCount = 0;
  epoch = 1n;
  projectRole: ManagementRoleValue | null = "viewer";
  resourceRole: ManagementRoleValue | null = null;
  resourceBindingPresent = false;
  serviceCapabilities: readonly string[] = ["object.read"];
  deniedPrincipalId: string | null = null;
  failure: Error | null = null;

  constructor(context: RuntimeIdentityContext) {
    this.#context = context;
  }

  readPolicyGatewaySnapshot(input: {
    readonly projectId: string;
    readonly authorizationPrincipalIds: readonly string[];
    readonly resourceId: string;
    readonly permission: string;
    readonly releaseId: string;
    readonly policyRevisionId: string;
    readonly compilerVersion: string;
  }): Promise<PolicyGatewaySnapshot> {
    this.readCount += 1;
    if (this.failure !== null) return Promise.reject(this.failure);
    const identities = [this.#context.identity.actor, ...this.#context.identity.delegationChain];
    const principals: readonly PolicyGatewaySnapshotPrincipal[] = Object.freeze(
      input.authorizationPrincipalIds.map((principalId, index) => {
        const identity = identities[index];
        assert.ok(identity !== undefined);
        const allowed = principalId !== this.deniedPrincipalId;
        return Object.freeze({
          principalId,
          identityType: identity.identityType,
          state: "active" as const,
          projectRole: allowed ? this.projectRole : null,
          resourceRole: allowed ? this.resourceRole : null,
          resourceBindingPresent: allowed && this.resourceBindingPresent,
          serviceProfileState: identity.identityType === "service" ? ("active" as const) : null,
          serviceCapabilities:
            identity.identityType === "service"
              ? Object.freeze([...this.serviceCapabilities])
              : null,
        });
      }),
    );
    return Promise.resolve(
      Object.freeze({
        projectId: input.projectId,
        resourceId: input.resourceId,
        resourceRevisionId: policyIds.workItemRevision,
        releaseId: input.releaseId,
        policyResourceId: policyIds.policyResource,
        policyRevisionId: input.policyRevisionId,
        policyCompilationId: ids.compilation,
        compilerVersion: input.compilerVersion,
        artifactDigest: compiled.artifactDigest,
        epoch: this.epoch,
        observedDatabaseAt: parseCanonicalInstant(observedAt),
        principals,
      }),
    );
  }
}

class MemoryArtifactReader implements PolicyGatewayArtifactReader {
  readCount = 0;
  bytes = compiled.artifactBytes;
  failure: Error | null = null;

  readArtifact(input: { readonly kind: "ir"; readonly digest: ArtifactDigest }): Promise<string> {
    this.readCount += 1;
    assert.equal(input.kind, "ir");
    assert.equal(input.digest, compiled.artifactDigest);
    return this.failure === null ? Promise.resolve(this.bytes) : Promise.reject(this.failure);
  }
}

class NotificationBus implements PolicyEpochNotificationSource {
  readonly #handlers = new Set<PolicyEpochNotificationHandler>();

  subscribe(handler: PolicyEpochNotificationHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  publish(notification: PolicyEpochNotification): void {
    for (const handler of this.#handlers) handler(notification);
  }
}
