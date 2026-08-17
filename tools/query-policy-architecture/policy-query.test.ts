import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafeComposition,
  compileObjectList,
  compileOneHopLink,
  compilePolicyCount,
  compileTypedGet,
  type CompositionStage,
  type PropertyCapability,
  type ServingContext,
} from "./policy-query.ts";

const ids = Object.freeze({
  project: "41000000-0000-4000-8000-000000000001",
  release: "41000000-0000-4000-8000-000000000002",
  activation: "41000000-0000-4000-8000-000000000003",
  sourceResource: "41000000-0000-4000-8000-000000000011",
  sourceRevision: "41000000-0000-4000-8000-000000000012",
  sourceGeneration: "41000000-0000-4000-8000-000000000013",
  targetResource: "41000000-0000-4000-8000-000000000021",
  targetRevision: "41000000-0000-4000-8000-000000000022",
  targetGeneration: "41000000-0000-4000-8000-000000000023",
  linkResource: "41000000-0000-4000-8000-000000000031",
  linkRevision: "41000000-0000-4000-8000-000000000032",
  linkGeneration: "41000000-0000-4000-8000-000000000033",
});

const context: ServingContext = Object.freeze({
  resolution: "release-serving-head",
  projectId: ids.project,
  releaseId: ids.release,
  activationId: ids.activation,
  members: Object.freeze([
    Object.freeze({
      memberKey: "object:EntityAlpha",
      kind: "object" as const,
      targetResourceId: ids.sourceResource,
      targetRevisionId: ids.sourceRevision,
      generationId: ids.sourceGeneration,
    }),
    Object.freeze({
      memberKey: "object:EntityBeta",
      kind: "object" as const,
      targetResourceId: ids.targetResource,
      targetRevisionId: ids.targetRevision,
      generationId: ids.targetGeneration,
    }),
    Object.freeze({
      memberKey: "link:AlphaRelatedBeta",
      kind: "link" as const,
      targetResourceId: ids.linkResource,
      targetRevisionId: ids.linkRevision,
      generationId: ids.linkGeneration,
    }),
  ]),
});

const label: PropertyCapability = Object.freeze({
  apiName: "label",
  valueType: "string",
  filterable: true,
  sortable: true,
  access: "allow",
  policyUsable: true,
});

const hidden: PropertyCapability = Object.freeze({
  ...label,
  apiName: "internalRegion",
  access: "deny",
});

const policy = Object.freeze({
  kind: "compare" as const,
  property: label,
  operator: "lt" as const,
  value: "visible-boundary",
});

void test("typed Get, list and Count bind Current Generation and parameterize policy values", () => {
  const get = compileTypedGet(context, {
    memberKey: "object:EntityAlpha",
    canonicalPrimaryKey: "pk1:fixture",
    selectedProperties: [label],
    policy,
  });
  const list = compileObjectList(context, {
    memberKey: "object:EntityAlpha",
    selectedProperties: [label],
    policy,
    limit: 25,
  });
  const count = compilePolicyCount(context, {
    memberKey: "object:EntityAlpha",
    policy,
  });

  for (const statement of [get, list, count]) {
    assert.match(statement.text, /generation_id = \$2::uuid/u);
    assert.doesNotMatch(statement.text, /visible-boundary/u);
    assert.equal(statement.values.includes("visible-boundary"), true);
    assert.equal(
      statement.composition.some(({ kind }) => kind === "row-policy"),
      true,
    );
  }
});

void test("one-hop Link binds source, link and target serving Generations before pagination", () => {
  const statement = compileOneHopLink(context, {
    sourceMemberKey: "object:EntityAlpha",
    linkMemberKey: "link:AlphaRelatedBeta",
    targetMemberKey: "object:EntityBeta",
    sourceCanonicalPrimaryKey: "pk1:fixture",
    selectedTargetProperties: [label],
    sourcePolicy: policy,
    linkPolicy: { kind: "allow" },
    targetPolicy: policy,
    limit: 20,
  });
  assert.match(statement.text, /JOIN runtime\.link_current/u);
  assert.match(statement.text, /source_current\.generation_id = \$5::uuid/u);
  assert.match(statement.text, /target_current\.generation_id = \$8::uuid/u);
  assert.equal(statement.composition.filter(({ kind }) => kind === "row-policy").length, 3);
});

void test("mutation: removing the Policy Resolver is rejected", () => {
  const mutated: readonly CompositionStage[] = [
    { kind: "current-generation", scope: "object" },
    { kind: "order", scope: "object" },
    { kind: "pagination", scope: "object" },
  ];
  assert.throws(() => assertSafeComposition(mutated, ["object"]), /QUERY_ROW_POLICY_REQUIRED/u);
});

void test("mutation: moving the Policy predicate after LIMIT is rejected", () => {
  const mutated: readonly CompositionStage[] = [
    { kind: "current-generation", scope: "object" },
    { kind: "pagination", scope: "object" },
    { kind: "row-policy", scope: "object" },
  ];
  assert.throws(() => assertSafeComposition(mutated, ["object"]), /QUERY_POLICY_AFTER_PAGINATION/u);
});

void test("mutation: a denied Property cannot be used as a client Filter", () => {
  assert.throws(
    () =>
      compileObjectList(context, {
        memberKey: "object:EntityAlpha",
        selectedProperties: [label],
        policy,
        filter: { property: hidden, operator: "eq", value: "secret" },
        limit: 25,
      }),
    /QUERY_PROPERTY_FILTER_FORBIDDEN/u,
  );
});

void test("Property names cannot become SQL injection", () => {
  const malicious: PropertyCapability = { ...label, apiName: "label') OR TRUE --" };
  assert.throws(
    () =>
      compileObjectList(context, {
        memberKey: "object:EntityAlpha",
        selectedProperties: [malicious],
        policy,
        limit: 25,
      }),
    /QUERY_PROPERTY_CAPABILITY_INVALID/u,
  );
});
