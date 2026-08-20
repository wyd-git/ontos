import assert from "node:assert/strict";
import test from "node:test";

import { MAX_POLICY_GATEWAY_EPOCH } from "@ontos/policy-application";
import { parsePolicyEpochNotificationPayload } from "@ontos/policy-postgres";

const projectId = "018f47a2-755b-7cc3-98c8-4d2fb871c320";

void test("PostgreSQL Epoch notification parser accepts exact bounded payloads", () => {
  assert.deepEqual(
    parsePolicyEpochNotificationPayload(
      JSON.stringify({ protocolVersion: 1, projectId, epoch: 42 }),
    ),
    { protocolVersion: 1, projectId, epoch: 42n },
  );
  assert.deepEqual(
    parsePolicyEpochNotificationPayload(
      JSON.stringify({
        protocolVersion: 1,
        projectId,
        epoch: MAX_POLICY_GATEWAY_EPOCH.toString(),
      }),
    ),
    { protocolVersion: 1, projectId, epoch: MAX_POLICY_GATEWAY_EPOCH },
  );
});

void test("PostgreSQL Epoch notification parser ignores malformed and unsafe hints", () => {
  const invalidPayloads: readonly (string | undefined)[] = [
    undefined,
    "",
    "not-json",
    JSON.stringify([]),
    JSON.stringify({ protocolVersion: 2, projectId, epoch: 2 }),
    JSON.stringify({ protocolVersion: 1, projectId: "not-a-uuid", epoch: 2 }),
    JSON.stringify({ protocolVersion: 1, projectId, epoch: 0 }),
    JSON.stringify({ protocolVersion: 1, projectId, epoch: -1 }),
    JSON.stringify({ protocolVersion: 1, projectId, epoch: 1.5 }),
    JSON.stringify({ protocolVersion: 1, projectId, epoch: Number.MAX_SAFE_INTEGER + 1 }),
    JSON.stringify({ protocolVersion: 1, projectId, epoch: "01" }),
    JSON.stringify({
      protocolVersion: 1,
      projectId,
      epoch: (MAX_POLICY_GATEWAY_EPOCH + 1n).toString(),
    }),
    "x".repeat(513),
  ];
  for (const payload of invalidPayloads) {
    assert.equal(parsePolicyEpochNotificationPayload(payload), null, payload);
  }
});
