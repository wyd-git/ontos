import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractValidationError,
  extractPolicyResourceDependencies,
  parseDirectResourceContent,
  parsePackageResourceContent,
  parsePolicyResourceDefinition,
} from "@ontos/contracts";
import {
  PolicyCompilerError,
  comparePolicyDefinitions,
  compilePolicy,
  evaluatePolicyRules,
} from "@ontos/policy-domain";

import { compileInput, policyDefinition, policyIds } from "./fixtures.ts";

void test("Direct and Package paths share the strict active Policy parser and exact extractor", () => {
  const definition = policyDefinition();
  assert.deepEqual(
    parseDirectResourceContent("policy", definition),
    parsePackageResourceContent("policy", definition),
  );
  const dependencies = extractPolicyResourceDependencies(policyIds.policyRevision, definition);
  assert.ok(dependencies.length >= 10);
  assert.ok(dependencies.some(({ dependencyType }) => dependencyType === "policy_object_target"));
  assert.ok(dependencies.some(({ dependencyType }) => dependencyType === "policy_property_target"));
  assert.ok(dependencies.some(({ dependencyType }) => dependencyType === "policy_link_target"));
  assert.ok(
    dependencies.every(
      ({ targetResourceId, targetRevisionId }) => targetResourceId !== targetRevisionId,
    ),
  );

  const forged = { ...(definition as object), compiled: true };
  assert.throws(
    () => parsePolicyResourceDefinition(forged),
    (error: unknown) =>
      error instanceof ContractValidationError && error.code === "CONTRACT_UNKNOWN_FIELD",
  );
});

void test("Compiler emits byte-stable bounded IR and every published vector passes", () => {
  const first = compilePolicy(compileInput());
  const second = compilePolicy({
    ...compileInput(),
    targets: [...compileInput().targets].reverse(),
    releaseRevisionIds: [...compileInput().releaseRevisionIds].reverse(),
  });
  assert.equal(first.artifactBytes, second.artifactBytes);
  assert.equal(first.artifactDigest, second.artifactDigest);
  assert.equal(first.testReportDigest, second.testReportDigest);
  assert.equal(first.testReport.status, "passed");
  assert.equal(first.testReport.passedVectorCount, first.testReport.vectorCount);
  assert.equal(first.artifact.compilerVersion, "policy-compiler-g2-03-05-v1");
  assert.ok(first.artifact.dependencyContextDigest?.startsWith("sha256:"));
  assert.deepEqual(first.artifact.trustedActorAttributes, [
    { apiName: "region", valueType: "string" },
  ]);
});

void test("Decision semantics are explicit deny > mask > allow with fail-closed missing values", () => {
  const compiled = compilePolicy(compileInput());
  for (const vector of compiled.artifact.testVectors) {
    const actual = evaluatePolicyRules(
      compiled.artifact.rules,
      vector.target,
      vector.facts,
      vector.requestTime,
    );
    assert.equal(actual.decision, vector.expectedDecision, vector.vectorId);
    assert.equal(actual.propertyDisposition, vector.expectedPropertyDisposition, vector.vectorId);
  }
  const objectTarget = compiled.artifact.rules[0]?.target;
  assert.ok(objectTarget !== undefined);
  assert.equal(
    evaluatePolicyRules(
      compiled.artifact.rules,
      objectTarget,
      [{ source: "object_property", apiName: "region", state: "missing" }],
      "2026-08-19T08:00:00.000000Z",
    ).decision,
    "deny",
  );

  const literalDefinition = structuredClone(policyDefinition()) as unknown as Record<
    string,
    unknown
  >;
  const literalRules = literalDefinition.rules as Record<string, unknown>[];
  const allowRule = literalRules[0];
  assert.ok(allowRule !== undefined);
  allowRule.predicate = {
    kind: "compare",
    left: { source: "object_property", apiName: "status" },
    op: "eq",
    right: { source: "constant", value: "missing" },
  };
  const literal = compilePolicy({ ...compileInput(), definition: literalDefinition });
  assert.equal(
    evaluatePolicyRules(
      literal.artifact.rules,
      objectTarget,
      [{ source: "object_property", apiName: "status", state: "value", value: "missing" }],
      "2026-08-19T08:00:00.000000Z",
    ).decision,
    "allow",
  );

  const collectionDefinition = structuredClone(policyDefinition()) as unknown as Record<
    string,
    unknown
  >;
  const collectionRules = collectionDefinition.rules as Record<string, unknown>[];
  const collectionAllow = collectionRules[0];
  assert.ok(collectionAllow !== undefined);
  collectionAllow.predicate = {
    kind: "compare",
    left: { source: "actor_attribute", apiName: "groups" },
    op: "containsAny",
    right: { source: "constant", value: ["admin"] },
  };
  const collectionVectors = collectionDefinition.testVectors as Record<string, unknown>[];
  const collectionAllowVector = collectionVectors[0];
  assert.ok(collectionAllowVector !== undefined);
  collectionAllowVector.facts = [
    { source: "actor_attribute", apiName: "groups", state: "value", values: ["admin"] },
    { source: "object_property", apiName: "status", state: "value", value: "OPEN" },
  ];
  const collection = compilePolicy({
    ...compileInput(),
    definition: collectionDefinition,
    trustedActorAttributes: [
      { apiName: "groups", valueType: "string_array" },
      { apiName: "region", valueType: "string" },
    ],
  });
  assert.equal(collection.testReport.status, "passed");
});

void test("Wrong closure, project, family, Resource identity, unindexed Property and unknown Actor Attribute fail uniformly", () => {
  const base = compileInput();
  const mutations = [
    { ...base, releaseRevisionIds: base.releaseRevisionIds.slice(1) },
    {
      ...base,
      targets: base.targets.map((target, index) =>
        index === 0 ? { ...target, projectId: "018f47a2-755b-7cc3-98c8-4d2fb871c399" } : target,
      ),
    },
    {
      ...base,
      targets: base.targets.map((target, index) =>
        index === 0 ? { ...target, family: "link_type" as const } : target,
      ),
    },
    {
      ...base,
      targets: base.targets.map((target, index) =>
        index === 0 ? { ...target, resourceId: "018f47a2-755b-7cc3-98c8-4d2fb871c398" } : target,
      ),
    },
  ];
  for (const mutation of mutations) {
    assert.throws(
      () => compilePolicy(mutation),
      (error: unknown) =>
        error instanceof PolicyCompilerError && error.code === "TARGET_UNAVAILABLE",
    );
  }

  const unindexed = structuredClone(policyDefinition()) as unknown as Record<string, unknown>;
  const rules = unindexed.rules as Record<string, unknown>[];
  const deny = rules[1];
  assert.ok(deny !== undefined);
  deny.predicate = {
    kind: "compare",
    left: { source: "object_property", apiName: "email" },
    op: "eq",
    right: { source: "constant", value: "x@example.test" },
  };
  assert.throws(
    () => compilePolicy({ ...base, definition: unindexed }),
    (error: unknown) =>
      error instanceof PolicyCompilerError && error.code === "PREDICATE_NOT_COMPILABLE",
  );

  assert.throws(
    () => compilePolicy({ ...base, trustedActorAttributes: [] }),
    (error: unknown) =>
      error instanceof PolicyCompilerError && error.code === "PREDICATE_NOT_COMPILABLE",
  );
});

void test("Raw SQL, missing exact Link bindings, recursive Link and mismatched tests never become a passed Artifact", () => {
  const base = structuredClone(policyDefinition()) as unknown as Record<string, unknown>;
  const rules = base.rules as Record<string, unknown>[];
  const first = rules[0];
  assert.ok(first !== undefined);
  first.rawSql = "TRUE";
  assert.throws(() => parsePolicyResourceDefinition(base), ContractValidationError);

  const missingBinding = structuredClone(policyDefinition()) as unknown as Record<string, unknown>;
  const missingRules = missingBinding.rules as Record<string, unknown>[];
  const allow = missingRules[0];
  assert.ok(allow !== undefined);
  const all = allow.predicate as { predicates: Record<string, unknown>[] };
  Reflect.deleteProperty(all.predicates[1] ?? {}, "linkTypeRevisionId");
  assert.throws(() => parsePolicyResourceDefinition(missingBinding), ContractValidationError);

  const mismatch = structuredClone(policyDefinition()) as unknown as Record<string, unknown>;
  const vectors = mismatch.testVectors as Record<string, unknown>[];
  const denied = vectors.find(({ vectorId }) => vectorId === "DENY_MISSING");
  assert.ok(denied !== undefined);
  denied.expectedDecision = "allow";
  const compiled = compilePolicy({ ...compileInput(), definition: mismatch });
  assert.equal(compiled.testReport.status, "failed");
  assert.equal(compiled.testReport.failedVectorCount, 1);
});

void test("Compatibility distinguishes tightening, widening and ambiguous semantic replacement", () => {
  const baseline = policyDefinition();
  const tightening = structuredClone(baseline) as unknown as Record<string, unknown>;
  const tighteningRules = tightening.rules as Record<string, unknown>[];
  tighteningRules.push({
    ruleId: "ZZ_DENY_ALL",
    target: (tighteningRules[0] as Record<string, unknown>).target,
    effect: "deny",
    predicate: { kind: "constant", value: true },
  });
  assert.equal(comparePolicyDefinitions(baseline, tightening), "tightening");

  const widening = structuredClone(baseline) as unknown as Record<string, unknown>;
  (widening.rules as Record<string, unknown>[]).splice(1, 1);
  assert.equal(comparePolicyDefinitions(baseline, widening), "widening");

  const ambiguous = structuredClone(baseline) as unknown as Record<string, unknown>;
  const ambiguousRule = (ambiguous.rules as Record<string, unknown>[])[0];
  assert.ok(ambiguousRule !== undefined);
  ambiguousRule.predicate = { kind: "constant", value: true };
  assert.equal(comparePolicyDefinitions(baseline, ambiguous), "ambiguous");
});
