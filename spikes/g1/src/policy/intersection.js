import { invariant } from "../core/kernel-error.js";
import { stableHash } from "../core/stable-json.js";

const DECISION_RANK = Object.freeze({ deny: 0, mask: 1, allow: 2 });

export function intersectPolicies(servicePolicy, userPolicy, { id = "delegated" } = {}) {
  invariant(servicePolicy && userPolicy, "POLICY_REQUIRED", "Both service and user policies are required");
  const propertyNames = new Set([
    ...Object.keys(servicePolicy.propertyDecisions ?? {}),
    ...Object.keys(userPolicy.propertyDecisions ?? {}),
  ]);
  const defaultPropertyDecision = stricterDecision(
    servicePolicy.defaultPropertyDecision ?? "deny",
    userPolicy.defaultPropertyDecision ?? "deny",
  );
  const propertyDecisions = Object.fromEntries([...propertyNames].sort().map((propertyName) => [
    propertyName,
    stricterDecision(
      servicePolicy.propertyDecisions?.[propertyName] ?? servicePolicy.defaultPropertyDecision ?? "deny",
      userPolicy.propertyDecisions?.[propertyName] ?? userPolicy.defaultPropertyDecision ?? "deny",
    ),
  ]));
  const rowPredicates = [servicePolicy.rowPredicate, userPolicy.rowPredicate].filter(Boolean);
  const policy = {
    id,
    allowObjectType: Boolean(servicePolicy.allowObjectType && userPolicy.allowObjectType),
    rowPredicate: rowPredicates.length === 0
      ? null
      : rowPredicates.length === 1 ? rowPredicates[0] : { and: rowPredicates },
    defaultPropertyDecision,
    propertyDecisions,
    actionsAllowed: servicePolicy.actionsAllowed !== false && userPolicy.actionsAllowed !== false,
    delegation: [servicePolicy.id, userPolicy.id],
  };
  return Object.freeze({ ...policy, contextHash: stableHash(policy) });
}

function stricterDecision(left, right) {
  invariant(Object.hasOwn(DECISION_RANK, left) && Object.hasOwn(DECISION_RANK, right), "POLICY_INVALID", "Unknown property decision");
  return DECISION_RANK[left] <= DECISION_RANK[right] ? left : right;
}
