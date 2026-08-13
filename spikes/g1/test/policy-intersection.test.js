import test from "node:test";
import assert from "node:assert/strict";
import { intersectPolicies } from "../src/policy/intersection.js";

test("delegated policy is the strict intersection of service and user", () => {
  const delegated = intersectPolicies({
    id: "service",
    allowObjectType: true,
    rowPredicate: null,
    defaultPropertyDecision: "allow",
    propertyDecisions: { amount: "mask" },
    actionsAllowed: false,
  }, {
    id: "user",
    allowObjectType: true,
    rowPredicate: { property: "region", op: "eq", value: "EAST" },
    defaultPropertyDecision: "allow",
    propertyDecisions: { amount: "allow", sensitiveCode: "deny" },
    actionsAllowed: true,
  });

  assert.deepEqual(delegated.rowPredicate, { property: "region", op: "eq", value: "EAST" });
  assert.equal(delegated.propertyDecisions.amount, "mask");
  assert.equal(delegated.propertyDecisions.sensitiveCode, "deny");
  assert.equal(delegated.actionsAllowed, false);
  assert.deepEqual(delegated.delegation, ["service", "user"]);
});
