import assert from "node:assert/strict";
import test from "node:test";

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
    assert.match(statement.text, /IS TRUE AND NOT/u);
    const policyPosition = statement.text.indexOf("IS TRUE AND NOT");
    const orderPosition = statement.text.indexOf("ORDER BY");
    const limitPosition = statement.text.indexOf("LIMIT");
    if (orderPosition >= 0) assert.ok(policyPosition < orderPosition);
    if (limitPosition >= 0) assert.ok(policyPosition < limitPosition);
    assert.equal(statement.values.length, statement.parameterTypes.length);
  }
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
