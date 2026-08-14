import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MetadataDomainError,
  assertChildDraftSourceState,
  assertResourceRevisionStateTransition,
  assertResourceStateTransition,
  prepareDirectResourceContent,
} from "@ontos/metadata-domain";
import fc from "fast-check";

void test("canonical Resource content is key-order stable and changes with semantics", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 80 }), (description) => {
      const left = objectType(description);
      const right = reverseObjectKeys(left);
      const leftPrepared = prepareDirectResourceContent("object_type", left);
      const rightPrepared = prepareDirectResourceContent("object_type", right);
      assert.equal(digest(leftPrepared.canonicalContent), digest(rightPrepared.canonicalContent));

      const changed = prepareDirectResourceContent("object_type", {
        ...left,
        description: `${description} changed`,
      });
      assert.notEqual(digest(leftPrepared.canonicalContent), digest(changed.canonicalContent));
    }),
    { numRuns: 100 },
  );
});

void test("direct Resource creation rejects deferred families and unknown content fields", () => {
  assertDomainError(
    () => prepareDirectResourceContent("policy", objectType("deferred")),
    "INVALID_INPUT",
  );
  assertDomainError(
    () =>
      prepareDirectResourceContent("object_type", {
        ...objectType("strict"),
        clientControlledDigest: "sha256:untrusted",
      }),
    "INVALID_INPUT",
  );
  // G2_NEGATIVE:unknown_resource_field
});

void test("Resource and Revision lifecycle transitions are forward-only", () => {
  assert.doesNotThrow(() => assertResourceStateTransition("active", "deprecated"));
  assert.doesNotThrow(() => assertResourceStateTransition("active", "archived"));
  assert.doesNotThrow(() => assertResourceStateTransition("deprecated", "archived"));
  assertDomainError(() => assertResourceStateTransition("archived", "active"), "INVALID_STATE");

  assert.doesNotThrow(() => assertResourceRevisionStateTransition("draft", "validated"));
  assert.doesNotThrow(() => assertResourceRevisionStateTransition("validated", "published"));
  assert.doesNotThrow(() => assertResourceRevisionStateTransition("published", "deprecated"));
  assert.doesNotThrow(() => assertResourceRevisionStateTransition("deprecated", "archived"));
  assertDomainError(
    () => assertResourceRevisionStateTransition("published", "draft"),
    "INVALID_STATE",
  );
});

void test("only immutable editable Revisions can be parents of child Drafts", () => {
  for (const state of ["validated", "published", "deprecated"] as const) {
    assert.doesNotThrow(() => assertChildDraftSourceState(state));
  }
  for (const state of ["draft", "archived"] as const) {
    assertDomainError(() => assertChildDraftSourceState(state), "INVALID_STATE");
  }
});

export function objectType(description: string) {
  return {
    schemaVersion: 1,
    apiName: "Order",
    displayName: "Order",
    description,
    primaryKeyPropertyApiName: "orderId",
    titlePropertyApiName: "orderId",
    defaultSearchPropertyApiNames: [],
    defaultSort: [{ propertyApiName: "orderId", direction: "asc" }],
    defaultClassification: "internal",
    properties: [
      {
        schemaVersion: 1,
        apiName: "orderId",
        displayName: "Order ID",
        description: "Stable source identifier.",
        valueType: "string",
        caseSensitive: true,
        nullable: false,
        writeMode: "source_only",
        unique: true,
        filterable: true,
        sortable: true,
        searchable: false,
        classification: "internal",
      },
    ],
  };
}

function reverseObjectKeys(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).reverse());
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertDomainError(action: () => unknown, code: MetadataDomainError["code"]): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof MetadataDomainError && error.code === code,
  );
}
