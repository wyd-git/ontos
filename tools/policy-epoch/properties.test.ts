import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import {
  EpochNotificationBus,
  InMemoryAuthorizationStore,
  InMemoryCompiledPolicyStore,
  ManualClock,
} from "./model.ts";
import { PolicyDecisionProcess, type PolicyDecisionRequest } from "./process.ts";

const propertyParameters = { numRuns: 200, seed: 20_260_813 } as const;

void test("property: every configured TTL expires at its inclusive boundary", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 5_000 }), (ttlMs) => {
      const databaseClock = new ManualClock(1_000);
      const monotonicClock = new ManualClock(0);
      const notifications = new EpochNotificationBus();
      const authorizationStore = new InMemoryAuthorizationStore(databaseClock, notifications);
      const compiledPolicies = new InMemoryCompiledPolicyStore();
      authorizationStore.createProject("project-1");
      authorizationStore.transactAuthorizationChange("project-1", (draft) => {
        draft.grant({
          principalId: "user-alice",
          resourceId: "resource-1",
          permission: "object.read",
        });
      });
      compiledPolicies.publish({
        projectId: "project-1",
        releaseId: "release-1",
        policyRevision: "policy-1",
        compilerVersion: "compiler-1",
        artifactDigest: "sha256:fixture",
        evaluationContract: "RESOURCE_PERMISSION_INTERSECTION_V1",
      });
      const process = new PolicyDecisionProcess({
        processId: "api-a",
        cacheTtlMs: ttlMs,
        monotonicClock,
        authorizationStore,
        compiledPolicies,
        notifications,
      });
      const input = request();
      assert.equal(process.decide(input).source, "FRESH");
      const readsAfterInsert = authorizationStore.readCount;

      notifications.setDelivery("api-a", false);
      databaseClock.advance(1);
      authorizationStore.transactAuthorizationChange("project-1", (draft) => {
        draft.revoke({
          principalId: "user-alice",
          resourceId: "resource-1",
          permission: "object.read",
        });
      });

      monotonicClock.set(ttlMs - 1);
      assert.deepEqual(process.decide(input), {
        decision: "ALLOW",
        source: "CACHE",
        epoch: "2",
        errorCode: null,
      });
      assert.equal(authorizationStore.readCount, readsAfterInsert);

      monotonicClock.set(ttlMs);
      assert.deepEqual(process.decide(input), {
        decision: "DENY",
        source: "FRESH",
        epoch: "3",
        errorCode: null,
      });
      assert.equal(authorizationStore.readCount, readsAfterInsert + 1);
      process.dispose();
    }),
    propertyParameters,
  );
});

void test("property: notification loss never permits stale Allow after five seconds", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 4_999 }), (revokedAt) => {
      const databaseClock = new ManualClock(10_000);
      const monotonicClock = new ManualClock(0);
      const notifications = new EpochNotificationBus();
      const authorizationStore = new InMemoryAuthorizationStore(databaseClock, notifications);
      const compiledPolicies = new InMemoryCompiledPolicyStore();
      authorizationStore.createProject("project-1");
      authorizationStore.transactAuthorizationChange("project-1", (draft) => {
        draft.grant({
          principalId: "user-alice",
          resourceId: "resource-1",
          permission: "object.read",
        });
      });
      compiledPolicies.publish({
        projectId: "project-1",
        releaseId: "release-1",
        policyRevision: "policy-1",
        compilerVersion: "compiler-1",
        artifactDigest: "sha256:fixture",
        evaluationContract: "RESOURCE_PERMISSION_INTERSECTION_V1",
      });
      const process = new PolicyDecisionProcess({
        processId: "api-a",
        monotonicClock,
        authorizationStore,
        compiledPolicies,
        notifications,
      });
      const input = request();
      assert.equal(process.decide(input).decision, "ALLOW");
      notifications.setDelivery("api-a", false);

      monotonicClock.set(revokedAt);
      databaseClock.advance(revokedAt);
      authorizationStore.transactAuthorizationChange("project-1", (draft) => {
        draft.revoke({
          principalId: "user-alice",
          resourceId: "resource-1",
          permission: "object.read",
        });
      });
      monotonicClock.set(5_000);
      assert.deepEqual(process.decide(input), {
        decision: "DENY",
        source: "FRESH",
        epoch: "3",
        errorCode: null,
      });
      process.dispose();
    }),
    propertyParameters,
  );
});

function request(): PolicyDecisionRequest {
  return {
    projectId: "project-1",
    identity: { subjectId: "user-alice", identityType: "human", groupPrincipalIds: [] },
    delegationChain: [],
    resourceId: "resource-1",
    permission: "object.read",
    releaseId: "release-1",
    policyRevision: "policy-1",
    compilerVersion: "compiler-1",
    correlationId: "correlation-1",
  };
}
