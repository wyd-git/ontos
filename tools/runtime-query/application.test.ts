import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeContractForDigest,
  parseCanonicalInstant,
  parseIdentityDelegationSummary,
} from "@ontos/contracts";
import type { RuntimeIdentityContext } from "@ontos/identity-application";
import type {
  PolicyGatewayContext,
  PolicyGatewayPort,
  PolicyGatewayRequest,
  PolicyGatewayResult,
} from "@ontos/policy-application";
import {
  RuntimeQueryApplicationService,
  RuntimeQueryError,
  type CommittedRuntimeQueryLease,
  type RuntimeObjectGetRepository,
  type RuntimeQueryContextCandidate,
  type RuntimeQueryContextRepository,
} from "@ontos/query-application";

import {
  customerObjectType,
  ids as mappingIds,
  orderCustomerLinkType,
  orderObjectType,
} from "../materialization-mapping/fixtures.ts";
import { linkPolicy, objectPolicy, queryIds, sha256 } from "../query-compiler/fixtures.ts";

const correlationId = "corr_g20308_runtime_request_0001";
const compilerVersion = "policy-compiler-g2-03-05-v1";
const leaseId = "01000000-0000-4000-8000-000000000010";
const objectRid = "01000000-0000-4000-8000-000000000011";

void test("Runtime Metadata returns only discoverable Objects and bounded capabilities", async () => {
  const contexts = new MemoryContexts();
  const objects = new MemoryObjects("good");
  const gateway = new MemoryGateway("deny");
  const service = runtimeService(contexts, objects, gateway);

  const response = await service.metadata(scope());

  assert.equal(response.releaseId, queryIds.release);
  assert.deepEqual(
    response.data.map(({ apiName }) => apiName),
    ["Customer"],
  );
  const customer = required(response.data[0]);
  assert.equal(customer.displayName, "Customer");
  assert.deepEqual(customer.links, []);
  assert.equal(
    customer.properties.find(({ apiName }) => apiName === "secret")?.disposition,
    "restricted",
  );
  assert.deepEqual(
    customer.properties.find(({ apiName }) => apiName === "amount")?.filterOperators,
    ["eq", "ne", "lt", "lte", "gt", "gte", "in", "isNull"],
  );
  assert.equal(contexts.commits.length, 1);
  assert.equal(contexts.releases.length, 1);
  assert.equal(gateway.requests.length, 2);
  assert.ok(gateway.requests.every(({ permission }) => permission === "object.read"));
});

void test("Runtime Metadata requires an independent Gateway decision for discoverable Links", async () => {
  for (const linkAccess of ["allow", "deny"] as const) {
    const gateway = new MemoryGateway("deny", "allow", linkAccess);
    const response = await runtimeService(
      new MemoryContexts(),
      new MemoryObjects("good"),
      gateway,
    ).metadata(scope());

    assert.deepEqual(
      response.data.map(({ apiName }) => apiName),
      ["Customer", "Order"],
    );
    const customer = required(response.data.find(({ apiName }) => apiName === "Customer"));
    const order = required(response.data.find(({ apiName }) => apiName === "Order"));
    assert.deepEqual(
      customer.links.map(({ apiName, direction }) => ({ apiName, direction })),
      linkAccess === "allow" ? [{ apiName: "CustomerOrder", direction: "outgoing" }] : [],
    );
    assert.deepEqual(
      order.links.map(({ apiName, direction }) => ({ apiName, direction })),
      linkAccess === "allow" ? [{ apiName: "CustomerOrder", direction: "incoming" }] : [],
    );
    assert.equal(gateway.requests.length, 3);
    assert.equal(
      gateway.requests.filter(({ resourceId }) => resourceId === mappingIds.linkResource).length,
      1,
    );
  }
});

void test("Activation-aware Object Get preserves five-state output and always releases its Lease", async () => {
  const contexts = new MemoryContexts();
  const objects = new MemoryObjects("good");
  const service = runtimeService(contexts, objects, new MemoryGateway("deny"));

  const response = await service.objectGet(scope(), {
    objectTypeApiName: "Customer",
    primaryKey: "customer-1",
  });

  assert.equal(response.data.reference.primaryKey, objects.executions[0]?.plan.canonicalPrimaryKey);
  assert.equal(response.data.objectVersion, "1");
  assert.deepEqual(
    response.data.properties.find(({ apiName }) => apiName === "secret"),
    { apiName: "secret", state: "restricted" },
  );
  assert.equal(objects.executions.length, 1);
  assert.equal(contexts.commits[0]?.queryHash, objects.executions[0]?.plan.queryHash);
  assert.equal(contexts.releases.length, 1);
});

void test("Object absence and a Repository leak share a closed public boundary", async () => {
  for (const [mode, expectedCode] of [
    ["empty", "OBJECT_NOT_ACCESSIBLE"],
    ["leak", "QUERY_EXECUTION_FAILED"],
  ] as const) {
    const contexts = new MemoryContexts();
    const service = runtimeService(contexts, new MemoryObjects(mode), new MemoryGateway("deny"));
    await assert.rejects(
      service.objectGet(scope(), {
        objectTypeApiName: "Customer",
        primaryKey: "customer-1",
      }),
      (error) => error instanceof RuntimeQueryError && error.code === expectedCode,
    );
    assert.equal(contexts.releases.length, 1, `${mode} must release the committed Lease`);
  }
});

void test("Get keeps query-shape and Policy compiler failures distinct from object absence", async () => {
  const invalidInputContexts = new MemoryContexts();
  await assert.rejects(
    runtimeService(
      invalidInputContexts,
      new MemoryObjects("good"),
      new MemoryGateway("deny"),
    ).objectGet(scope(), { objectTypeApiName: "Customer", primaryKey: { unexpected: true } }),
    (error) => error instanceof RuntimeQueryError && error.code === "QUERY_EXECUTION_FAILED",
  );
  assert.equal(invalidInputContexts.commits.length, 0);

  const invalidPolicyContexts = new MemoryContexts();
  await assert.rejects(
    runtimeService(
      invalidPolicyContexts,
      new MemoryObjects("good"),
      new MemoryGateway("invalid"),
    ).objectGet(scope(), { objectTypeApiName: "Customer", primaryKey: "customer-1" }),
    (error) => error instanceof RuntimeQueryError && error.code === "POLICY_EVALUATION_UNAVAILABLE",
  );
  assert.equal(invalidPolicyContexts.commits.length, 0);
});

function runtimeService(
  contexts: RuntimeQueryContextRepository,
  objects: RuntimeObjectGetRepository,
  policyGateway: PolicyGatewayPort,
): RuntimeQueryApplicationService {
  return new RuntimeQueryApplicationService({
    contexts,
    objects,
    policyGateway,
    digestCanonicalText: sha256,
    uuid: () => leaseId,
  });
}

function scope() {
  return Object.freeze({
    projectId: queryIds.project,
    selector: Object.freeze({ kind: "release" as const, releaseId: queryIds.release }),
    identity: identity(),
    correlationId,
  });
}

function identity(): RuntimeIdentityContext {
  const attributes = Object.freeze([Object.freeze({ name: "region", value: "EU" })]);
  const summary = parseIdentityDelegationSummary({
    schemaVersion: 1,
    actor: {
      principalId: "01000000-0000-4000-8000-000000000012",
      identityType: "human",
    },
    delegationChain: [],
    claimsFingerprint: sha256(canonicalizeContractForDigest(attributes)),
    authenticatedAt: "2026-08-20T04:00:00.000000Z",
    authorizationMode: "intersection",
  });
  return Object.freeze({
    identity: summary,
    attributes,
    capabilities: Object.freeze([]),
    authorizationPrincipalIds: Object.freeze([summary.actor.principalId]),
  });
}

function candidate(): RuntimeQueryContextCandidate {
  return Object.freeze({
    projectId: queryIds.project,
    releaseId: queryIds.release,
    releaseRevisionId: queryIds.release,
    activationId: queryIds.activation,
    runtimePlanDigest: sha256("runtime-plan"),
    generationSetDigest: sha256("generation-set"),
    observedDatabaseAt: parseCanonicalInstant("2026-08-20T04:00:00.000000Z"),
    policy: Object.freeze({
      policyResourceId: queryIds.policyResource,
      policyRevisionId: queryIds.policyRevision,
      policyCompilationId: queryIds.policyCompilation,
      artifactDigest: sha256("query-policy-artifact"),
      compilerVersion,
    }),
    members: Object.freeze([
      Object.freeze({
        memberKey: "object:Customer",
        kind: "object" as const,
        resourceId: mappingIds.objectResource,
        revisionId: mappingIds.objectRevision,
        generationId: queryIds.customerGeneration,
        definition: customerObjectType,
      }),
      Object.freeze({
        memberKey: "object:Order",
        kind: "object" as const,
        resourceId: mappingIds.orderResource,
        revisionId: mappingIds.orderRevision,
        generationId: queryIds.orderGeneration,
        definition: orderObjectType,
      }),
      Object.freeze({
        memberKey: "link:CustomerOrder",
        kind: "link" as const,
        resourceId: mappingIds.linkResource,
        revisionId: mappingIds.linkRevision,
        generationId: queryIds.linkGeneration,
        definition: orderCustomerLinkType,
      }),
    ]),
  });
}

class MemoryContexts implements RuntimeQueryContextRepository {
  readonly commits: Parameters<RuntimeQueryContextRepository["commitLease"]>[0][] = [];
  readonly releases: CommittedRuntimeQueryLease[] = [];

  resolveCandidate(): Promise<RuntimeQueryContextCandidate> {
    return Promise.resolve(candidate());
  }

  commitLease(
    input: Parameters<RuntimeQueryContextRepository["commitLease"]>[0],
  ): Promise<CommittedRuntimeQueryLease> {
    this.commits.push(input);
    return Promise.resolve(
      Object.freeze({
        queryLeaseId: input.queryLeaseId,
        projectId: input.candidate.projectId,
        releaseId: input.candidate.releaseId,
        activationId: input.candidate.activationId,
        identityContextHash: input.identityContextHash,
        authorizationEpoch: input.authorizationEpoch,
        policyContextHash: input.policyContextHash,
        queryHash: input.queryHash,
        generationSetDigest: input.candidate.generationSetDigest,
        controlSequence: 1n,
        expiresAt: parseCanonicalInstant("2026-08-20T04:00:30.000000Z"),
      }),
    );
  }

  releaseLease(lease: CommittedRuntimeQueryLease): Promise<void> {
    this.releases.push(lease);
    return Promise.resolve();
  }
}

class MemoryObjects implements RuntimeObjectGetRepository {
  readonly executions: Parameters<RuntimeObjectGetRepository["executeObjectGet"]>[0][] = [];
  readonly #mode: "good" | "empty" | "leak";

  constructor(mode: "good" | "empty" | "leak") {
    this.#mode = mode;
  }

  executeObjectGet(input: Parameters<RuntimeObjectGetRepository["executeObjectGet"]>[0]) {
    this.executions.push(input);
    if (this.#mode === "empty") {
      return Promise.resolve(Object.freeze({ rows: Object.freeze([]), rowCount: 0, byteCount: 0 }));
    }
    const properties = Object.fromEntries(
      input.plan.selectedProperties.map(({ apiName }) => [
        apiName,
        apiName === "secret"
          ? this.#mode === "leak"
            ? { state: "value", value: "classified" }
            : { state: "restricted" }
          : { state: "missing" },
      ]),
    );
    const row = Object.freeze({
      objectRid,
      canonicalPrimaryKey: input.plan.canonicalPrimaryKey,
      objectVersion: "1",
      properties,
    });
    return Promise.resolve(
      Object.freeze({ rows: Object.freeze([row]), rowCount: 1, byteCount: 512 }),
    );
  }
}

class MemoryGateway implements PolicyGatewayPort {
  readonly requests: PolicyGatewayRequest[] = [];
  readonly #secretAccess: "deny" | "mask" | "invalid";
  readonly #orderAccess: "allow" | "deny";
  readonly #linkAccess: "allow" | "deny";

  constructor(
    secretAccess: "deny" | "mask" | "invalid",
    orderAccess: "allow" | "deny" = "deny",
    linkAccess: "allow" | "deny" = "deny",
  ) {
    this.#secretAccess = secretAccess;
    this.#orderAccess = orderAccess;
    this.#linkAccess = linkAccess;
  }

  authorize(request: PolicyGatewayRequest): Promise<PolicyGatewayResult> {
    this.requests.push(request);
    if (request.resourceId === mappingIds.orderResource) {
      if (this.#orderAccess === "allow") {
        return Promise.resolve({
          decision: "ALLOW",
          source: "FRESH",
          epoch: "7",
          errorCode: null,
          context: orderGatewayContext(),
        });
      }
      return Promise.resolve({
        decision: "DENY",
        source: "FRESH",
        epoch: "7",
        errorCode: null,
        context: null,
      });
    }
    if (request.resourceId === mappingIds.linkResource) {
      if (this.#linkAccess === "allow") {
        return Promise.resolve({
          decision: "ALLOW",
          source: "FRESH",
          epoch: "7",
          errorCode: null,
          context: linkGatewayContext(),
        });
      }
      return Promise.resolve({
        decision: "DENY",
        source: "FRESH",
        epoch: "7",
        errorCode: null,
        context: null,
      });
    }
    if (request.resourceId !== mappingIds.objectResource) {
      return Promise.resolve({
        decision: "DENY",
        source: "FAIL_CLOSED",
        epoch: null,
        errorCode: "POLICY_INPUT_INVALID",
        context: null,
      });
    }
    const context = gatewayContext(this.#secretAccess === "invalid" ? "deny" : this.#secretAccess);
    return Promise.resolve({
      decision: "ALLOW",
      source: "FRESH",
      epoch: "7",
      errorCode: null,
      context:
        this.#secretAccess === "invalid"
          ? Object.freeze({
              ...context,
              trustedActorAttributes: Object.freeze([
                Object.freeze({ name: "region", value: "EU" }),
                Object.freeze({ name: "region", value: "US" }),
              ]),
            })
          : context,
    });
  }
}

function gatewayContext(secretAccess: "deny" | "mask"): PolicyGatewayContext {
  const policy = objectPolicy("Customer", { secretAccess });
  return Object.freeze({
    ...policy,
    policyResourceId: queryIds.policyResource,
    policyRevisionId: queryIds.policyRevision,
    policyCompilationId: queryIds.policyCompilation,
    compilerVersion,
  });
}

function orderGatewayContext(): PolicyGatewayContext {
  return Object.freeze({
    ...objectPolicy("Order"),
    policyResourceId: queryIds.policyResource,
    policyRevisionId: queryIds.policyRevision,
    policyCompilationId: queryIds.policyCompilation,
    compilerVersion,
  });
}

function linkGatewayContext(): PolicyGatewayContext {
  return Object.freeze({
    ...linkPolicy(),
    policyResourceId: queryIds.policyResource,
    policyRevisionId: queryIds.policyRevision,
    policyCompilationId: queryIds.policyCompilation,
    compilerVersion,
  });
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected test value is missing.");
  return value;
}
