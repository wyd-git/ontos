import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAPPING_COMPILER_VERSION,
  MappingCompileError,
  compileMapping,
} from "@ontos/materialization-domain";

import {
  definitionDigest,
  digestCanonicalText,
  ids,
  linkCompileInput,
  linkMapping,
  objectCompileInput,
  objectMapping,
} from "./fixtures.ts";

void describe("deterministic Mapping compiler", () => {
  void it("binds immutable inputs and emits the same canonical plan every time", () => {
    const first = compileMapping(objectCompileInput(), digestCanonicalText);
    const second = compileMapping(objectCompileInput(), digestCanonicalText);

    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
    assert.equal(first.compilerVersion, MAPPING_COMPILER_VERSION);
    assert.equal(first.mappingRevisionId, ids.mappingRevision);
    assert.equal(first.inputSchemaRevisionId, ids.schemaRevision);
    assert.equal(first.targetRevisionId, ids.objectRevision);
    assert.deepEqual(first.qualityRules, objectMapping.qualityRules);
    assert.match(first.planDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.columns));
    assert.ok(Object.isFrozen(first.propertyMappings));
    assert.doesNotMatch(JSON.stringify(first), /displayName":"Customer|rawSql|SELECT/iu);
  });

  void it("rejects unallowlisted AST and SQL through one stable compiler error", () => {
    const unallowlisted = {
      ...objectMapping,
      primaryKeyExpression: { op: "join", columnApiName: "id" },
    };
    assertCompileError(
      () => compileMapping(objectCompileInput({ mapping: unallowlisted }), digestCanonicalText),
      "MAPPING_CONTRACT_INVALID",
    );

    const sql = { ...objectMapping, rawSql: "SELECT * FROM source" };
    assertCompileError(
      () => compileMapping(objectCompileInput({ mapping: sql }), digestCanonicalText),
      "MAPPING_CONTRACT_INVALID",
    );
  });

  void it("rejects unknown columns and implicit type conversion", () => {
    const unknownColumn = {
      ...objectMapping,
      propertyMappings: objectMapping.propertyMappings.map((mapping) =>
        mapping.propertyApiName === "amount"
          ? {
              ...mapping,
              expression: {
                op: "cast",
                input: { op: "column", columnApiName: "missingColumn" },
                targetValueType: "decimal",
                codecVersion: "pk1",
              },
            }
          : mapping,
      ),
    };
    assertCompileError(
      () =>
        compileMapping(
          objectCompileInput({
            mapping: unknownColumn,
            mappingRevisionDigest: definitionDigest(unknownColumn),
          }),
          digestCanonicalText,
        ),
      "MAPPING_COLUMN_UNKNOWN",
    );

    const implicitCast = {
      ...objectMapping,
      propertyMappings: objectMapping.propertyMappings.map((mapping) =>
        mapping.propertyApiName === "amount"
          ? {
              ...mapping,
              expression: { op: "column", columnApiName: "amountText" },
            }
          : mapping,
      ),
    };
    assertCompileError(
      () =>
        compileMapping(
          objectCompileInput({
            mapping: implicitCast,
            mappingRevisionDigest: definitionDigest(implicitCast),
          }),
          digestCanonicalText,
        ),
      "MAPPING_EXPRESSION_TYPE_INVALID",
    );
  });

  void it("rejects an omitted non-nullable Base Property", () => {
    const missingRequired = {
      ...objectMapping,
      propertyMappings: objectMapping.propertyMappings.filter(
        ({ propertyApiName }) => propertyApiName !== "displayName",
      ),
    };
    assertCompileError(
      () =>
        compileMapping(
          objectCompileInput({
            mapping: missingRequired,
            mappingRevisionDigest: definitionDigest(missingRequired),
          }),
          digestCanonicalText,
        ),
      "MAPPING_PROPERTY_REQUIRED_MISSING",
    );
  });

  void it("fails closed on digest and target binding drift", () => {
    assertCompileError(
      () =>
        compileMapping(
          objectCompileInput({ mappingRevisionDigest: `sha256:${"0".repeat(64)}` }),
          digestCanonicalText,
        ),
      "MAPPING_DIGEST_MISMATCH",
    );
    const input = objectCompileInput();
    assertCompileError(
      () =>
        compileMapping(
          {
            ...input,
            target: { ...input.target, revisionId: ids.linkRevision },
          },
          digestCanonicalText,
        ),
      "MAPPING_BINDING_MISMATCH",
    );
  });

  void it("compiles Link endpoints only from exact Object Revision bindings", () => {
    const plan = compileMapping(linkCompileInput(), digestCanonicalText);
    assert.equal(plan.targetKind, "link");
    if (plan.targetKind !== "link") return;
    assert.equal(plan.linkDanglingDisposition, undefined);
    assert.deepEqual(
      {
        sourceResource: plan.sourceKey.objectTypeResourceId,
        sourceRevision: plan.sourceKey.objectTypeRevisionId,
        targetResource: plan.targetKey.objectTypeResourceId,
        targetRevision: plan.targetKey.objectTypeRevisionId,
      },
      {
        sourceResource: ids.objectResource,
        sourceRevision: ids.objectRevision,
        targetResource: ids.orderResource,
        targetRevision: ids.orderRevision,
      },
    );

    const badEndpoint = {
      ...linkMapping,
      sourceKeyMapping: {
        ...linkMapping.sourceKeyMapping,
        objectTypeRevisionId: ids.orderRevision,
      },
    };
    assertCompileError(
      () =>
        compileMapping(
          linkCompileInput({
            mapping: badEndpoint,
            mappingRevisionDigest: definitionDigest(badEndpoint),
          }),
          digestCanonicalText,
        ),
      "MAPPING_ENDPOINT_INVALID",
    );

    const optional = { ...linkMapping, linkDanglingDisposition: "optional" as const };
    const optionalPlan = compileMapping(
      linkCompileInput({
        mapping: optional,
        mappingRevisionDigest: definitionDigest(optional),
      }),
      digestCanonicalText,
    );
    assert.equal(optionalPlan.targetKind, "link");
    if (optionalPlan.targetKind === "link") {
      assert.equal(optionalPlan.linkDanglingDisposition, "optional");
      assert.notEqual(optionalPlan.planDigest, plan.planDigest);
    }
  });
});

function assertCompileError(operation: () => unknown, code: MappingCompileError["code"]): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof MappingCompileError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /SELECT \*|missingColumn|sha256:0/u);
    return true;
  });
}
