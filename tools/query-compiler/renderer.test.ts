import assert from "node:assert/strict";
import test from "node:test";

import { parseOntosId, type PolicyRule } from "@ontos/contracts";
import {
  compileLinkCandidate,
  compileObjectCount,
  compileObjectGet,
  compileObjectSearch,
} from "@ontos/query-domain";
import {
  PostgresQueryRenderError,
  assertAuthenticParameterizedQueryStatement,
  renderPostgresQuery,
  renderRuntimeObjectGet,
} from "@ontos/query-postgres";

import { linkPolicy, objectPolicy, queryRegistry, searchRequest, sha256 } from "./fixtures.ts";

const context = {
  registry: queryRegistry(),
  requestTime: "2026-08-20T04:00:00.000000Z",
  digestCanonicalText: sha256,
};

void test("Get/List/Count render Current binding, policy and client predicate before sort/limit", () => {
  const policy = objectPolicy("Customer");
  const injection = "x%' OR TRUE --";
  const plans = [
    compileObjectGet({
      context,
      objectTypeApiName: "Customer",
      request: { primaryKey: "customer-1", select: ["id", "secret"] },
      policy,
    }),
    compileObjectSearch({
      context,
      objectTypeApiName: "Customer",
      request: searchRequest({
        where: { property: "displayName", op: "contains", value: injection },
      }),
      policy,
    }),
    compileObjectCount({
      context,
      objectTypeApiName: "Customer",
      request: {
        schemaVersion: 1,
        operation: "count",
        where: { property: "displayName", op: "prefix", value: injection },
      },
      policy,
    }),
  ];
  for (const plan of plans) {
    const statement = renderPostgresQuery(plan);
    assert.doesNotMatch(statement.text, /x%' OR TRUE/u);
    if (plan.operation !== "object_get") assert.ok(statement.values.includes(injection));
    assert.match(statement.text, /runtime\.object_current/u);
    assert.match(statement.text, /generation_id = \$\d+::uuid/u);
    assert.match(statement.text, /IS NOT TRUE/u);
    const policyPosition = statement.text.indexOf("IS NOT TRUE");
    const orderPosition = statement.text.indexOf("ORDER BY");
    const limitPosition = statement.text.indexOf("LIMIT");
    if (orderPosition >= 0) assert.ok(policyPosition < orderPosition);
    if (limitPosition >= 0) assert.ok(policyPosition < limitPosition);
    assert.equal(statement.values.length, statement.parameterTypes.length);
  }
});

void test("WHERE predicates preserve three-valued policy semantics without hiding index conditions", () => {
  const basePolicy = objectPolicy("Customer");
  const policy = Object.freeze({
    ...basePolicy,
    policyRules: Object.freeze(
      basePolicy.policyRules.map((rule) =>
        rule.target.kind === "object"
          ? Object.freeze({
              ...rule,
              predicate: Object.freeze({
                kind: "compare" as const,
                left: Object.freeze({
                  source: "object_property" as const,
                  apiName: "displayName",
                }),
                op: "lt" as const,
                right: Object.freeze({ source: "constant" as const, value: "Customer 100" }),
              }),
            })
          : rule,
      ),
    ),
  });
  const statement = renderPostgresQuery(
    compileObjectSearch({
      context,
      objectTypeApiName: "Customer",
      request: searchRequest({
        where: { property: "displayName", op: "prefix", value: "Customer 0" },
        orderBy: [{ property: "displayName", direction: "asc" }],
      }),
      policy,
    }),
  );

  assert.match(statement.text, /COLLATE "C" < \$\d+::text/u);
  assert.match(statement.text, /COLLATE "C" LIKE replace/u);
  assert.doesNotMatch(statement.text, /COLLATE "C" < \$\d+::text\) IS TRUE/u);
  assert.doesNotMatch(statement.text, /ESCAPE '\\\\'\)\) IS TRUE/u);
  assert.match(statement.text, /\(FALSE\) IS NOT TRUE/u);
});

void test("Property projection places raw value only in the allow CASE and parameterizes masks", () => {
  const plan = compileObjectSearch({
    context,
    objectTypeApiName: "Customer",
    request: searchRequest({
      select: ["id", "secret"],
      where: undefined,
      orderBy: [{ property: "id", direction: "asc" }],
    }),
    policy: objectPolicy("Customer", { secretAccess: "mask" }),
  });
  const statement = renderPostgresQuery(plan);
  assert.match(statement.text, /WHEN \(TRUE\) IS TRUE THEN jsonb_build_object\('state', 'masked'/u);
  assert.doesNotMatch(statement.text, /\[REDACTED\]/u);
  assert.ok(statement.values.includes("[REDACTED]"));
  assert.match(statement.text, /ELSE jsonb_build_object\('state', 'restricted'\)/u);
});

void test("one-hop candidate binds source/link/target generations and all three row policies", () => {
  const plan = compileLinkCandidate({
    context,
    sourceObjectTypeApiName: "Customer",
    linkTypeApiName: "CustomerOrder",
    sourcePrimaryKey: "customer-1",
    request: {
      schemaVersion: 1,
      direction: "outgoing",
      select: ["orderId"],
      orderBy: [{ property: "orderId", direction: "asc" }],
      page: { size: 10, cursor: null },
    },
    sourcePolicy: objectPolicy("Customer"),
    linkPolicy: linkPolicy(),
    targetPolicy: objectPolicy("Order"),
  });
  const statement = renderPostgresQuery(plan);
  assert.match(statement.text, /JOIN runtime\.link_current/u);
  assert.match(statement.text, /JOIN runtime\.object_current AS target_current/u);
  assert.equal(statement.composition.includes("row_policy"), true);
  for (const generation of [
    plan.sourceObject.generationId,
    plan.link.generationId,
    plan.targetObject.generationId,
  ]) {
    assert.ok(statement.values.includes(generation));
  }
});

void test("Policy link_exists uses exact Registry revisions and generations", () => {
  const registry = queryRegistry();
  const customer = registry.requireObjectByApiName("Customer");
  const order = registry.requireObjectByApiName("Order");
  const link = registry.requireLinkByApiName("CustomerOrder");
  const rule: PolicyRule = Object.freeze({
    ruleId: "ALLOW_CUSTOMER_WITH_ORDER",
    target: Object.freeze({
      kind: "object",
      resourceId: parseOntosId(customer.resourceId),
      resourceRevisionId: parseOntosId(customer.revisionId),
    }),
    effect: "allow",
    predicate: Object.freeze({
      kind: "link_exists",
      linkTypeApiName: link.apiName,
      linkTypeResourceId: parseOntosId(link.resourceId),
      linkTypeRevisionId: parseOntosId(link.revisionId),
      targetObjectTypeApiName: order.apiName,
      targetObjectTypeResourceId: parseOntosId(order.resourceId),
      targetObjectTypeRevisionId: parseOntosId(order.revisionId),
      predicate: Object.freeze({ kind: "constant", value: true }),
    }),
  });
  const plan = compileObjectSearch({
    context: { ...context, registry },
    objectTypeApiName: "Customer",
    request: searchRequest({ where: undefined }),
    policy: objectPolicy("Customer", { extraRules: [rule] }),
  });
  const statement = renderPostgresQuery(plan);
  for (const binding of [
    link.resourceId,
    link.revisionId,
    link.generationId,
    order.resourceId,
    order.revisionId,
    order.generationId,
  ]) {
    assert.ok(statement.values.includes(binding));
  }
  assert.match(statement.text, /EXISTS \(\s*SELECT 1\s*FROM runtime\.link_current/u);
});

void test("renderer and executor boundary reject forged plans/statements", () => {
  assert.throws(
    () => renderPostgresQuery({ operation: "object_count" } as never),
    (error) => error instanceof TypeError && error.message === "QUERY_LOGICAL_PLAN_UNTRUSTED",
  );
  assert.throws(
    () => assertAuthenticParameterizedQueryStatement({ text: "SELECT 1" }),
    (error) =>
      error instanceof PostgresQueryRenderError && error.code === "QUERY_STATEMENT_UNTRUSTED",
  );
});

void test("Runtime Get activates a bound Lease and never names raw Current relations", () => {
  const plan = compileObjectGet({
    context,
    objectTypeApiName: "Customer",
    request: { primaryKey: "customer-1", select: ["id", "secret"] },
    policy: objectPolicy("Customer", { secretAccess: "deny" }),
  });
  const statement = renderRuntimeObjectGet(plan, {
    projectId: plan.binding.projectId,
    queryLeaseId: "01000000-0000-4000-8000-000000000010",
    releaseId: plan.binding.releaseId,
    activationId: plan.binding.activationId,
    identityContextHash: sha256("runtime-identity"),
    policyContextHash: plan.policy.policyContextHash,
    queryHash: plan.queryHash,
  });
  assert.equal(statement.name, "ontos_runtime_object_get_v1");
  assert.equal(statement.composition[0], "lease_context");
  assert.match(statement.text, /runtime\.activate_query_read_context/u);
  assert.match(statement.text, /runtime\.query_object_current/u);
  assert.match(statement.text, /CROSS JOIN LATERAL/u);
  assert.match(statement.text, /WHERE read_context\.active\s+OFFSET 0/u);
  assert.match(statement.text, /AS "objectVersion"/u);
  assert.doesNotMatch(statement.text, /runtime\.object_current/u);
  assert.doesNotMatch(statement.text, /runtime\.link_current/u);
  assert.ok(statement.values.includes(plan.queryHash));

  assert.throws(
    () =>
      renderRuntimeObjectGet(plan, {
        projectId: plan.binding.projectId,
        queryLeaseId: "01000000-0000-4000-8000-000000000010",
        releaseId: plan.binding.releaseId,
        activationId: plan.binding.activationId,
        identityContextHash: sha256("runtime-identity"),
        policyContextHash: plan.policy.policyContextHash,
        queryHash: sha256("wrong-query"),
      }),
    (error) =>
      error instanceof PostgresQueryRenderError && error.code === "QUERY_STATEMENT_UNTRUSTED",
  );
});
