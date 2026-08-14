import assert from "node:assert/strict";
import test from "node:test";

import { parseArtifactDigest } from "@ontos/contracts";
import { evaluateReleaseGate, type ReleaseGatePin } from "@ontos/metadata-domain";

const projectId = "018f47a2-755b-7cc3-98c8-4d2fb871c100";
const orderResourceId = "018f47a2-755b-7cc3-98c8-4d2fb871c101";
const customerResourceId = "018f47a2-755b-7cc3-98c8-4d2fb871c102";
const linkResourceId = "018f47a2-755b-7cc3-98c8-4d2fb871c103";
const orderRevisionId = "018f47a2-755b-7cc3-98c8-4d2fb871c110";
const customerRevisionId = "018f47a2-755b-7cc3-98c8-4d2fb871c111";
const linkRevisionId = "018f47a2-755b-7cc3-98c8-4d2fb871c112";
const digest = parseArtifactDigest(`sha256:${"1".repeat(64)}`);

void test("Release Gate accepts a validated dependency-closed bootstrap Pin set", () => {
  const pins = [
    pin(0, orderResourceId, orderRevisionId, "object_type", objectType("Order")),
    pin(1, customerResourceId, customerRevisionId, "object_type", objectType("Customer")),
    pin(
      2,
      linkResourceId,
      linkRevisionId,
      "link_type",
      linkType(orderRevisionId, customerRevisionId),
    ),
  ];
  const evaluation = evaluateReleaseGate({
    releaseId: "018f47a2-755b-7cc3-98c8-4d2fb871c170",
    projectId,
    pins,
    dependencies: [
      {
        sourceRevisionId: linkRevisionId,
        targetRevisionId: orderRevisionId,
        dependencyType: "link_source",
        sourcePath: "/source/objectTypeRevisionId",
      },
      {
        sourceRevisionId: linkRevisionId,
        targetRevisionId: customerRevisionId,
        dependencyType: "link_target",
        sourcePath: "/target/objectTypeRevisionId",
      },
    ],
    baselinePins: [],
  });

  assert.equal(evaluation.valid, true);
  assert.equal(evaluation.compatibility.outcome, "compatible");
  assert.ok(evaluation.issues.every(({ severity }) => severity === "warning"));
});

void test("Release Gate blocks stale Pin facts, missing reports and open dependencies deterministically", () => {
  const candidate = {
    ...pin(
      0,
      linkResourceId,
      linkRevisionId,
      "link_type",
      linkType(orderRevisionId, customerRevisionId),
    ),
    storedContentDigest: parseArtifactDigest(`sha256:${"2".repeat(64)}`),
    hasCurrentValidationReport: false,
  } satisfies ReleaseGatePin;
  const input = {
    releaseId: "018f47a2-755b-7cc3-98c8-4d2fb871c170",
    projectId,
    pins: [candidate],
    dependencies: [
      {
        sourceRevisionId: linkRevisionId,
        targetRevisionId: orderRevisionId,
        dependencyType: "link_source",
        sourcePath: "/source/objectTypeRevisionId",
      },
    ],
    baselinePins: [],
  } as const;
  const first = evaluateReleaseGate(input);
  const second = evaluateReleaseGate(input);

  assert.deepEqual(first, second);
  assert.equal(first.valid, false);
  assert.deepEqual(
    first.issues.filter(({ severity }) => severity === "error").map(({ code }) => code),
    [
      "RELEASE_DEPENDENCY_NOT_PINNED",
      "RELEASE_PIN_FACT_MISMATCH",
      "RELEASE_PIN_VALIDATION_REPORT_MISSING",
      "COMPATIBILITY_DOWNSTREAM_PIN_REQUIRES_REPIN",
    ],
  );
});

void test("Release Gate preserves a blocking conclusion within the 1,000-Issue contract bound", () => {
  const pins = Array.from({ length: 512 }, (_, index) => {
    const resourceId = uuid(index + 1);
    const revisionId = uuid(index + 1_000);
    return {
      ...pin(index, resourceId, revisionId, "object_type", objectType(`Object${String(index)}`)),
      resourceState: "archived" as const,
      revisionState: "draft" as const,
      storedContentDigest: parseArtifactDigest(`sha256:${"2".repeat(64)}`),
      hasCurrentValidationReport: false,
    } satisfies ReleaseGatePin;
  });
  const evaluation = evaluateReleaseGate({
    releaseId: "018f47a2-755b-7cc3-98c8-4d2fb871c170",
    projectId,
    pins,
    dependencies: [],
    baselinePins: [],
  });

  assert.equal(evaluation.valid, false);
  assert.equal(evaluation.issues.length, 1_000);
  assert.ok(
    evaluation.issues.some(
      ({ code, severity }) => code === "RELEASE_GATE_ISSUES_TRUNCATED" && severity === "error",
    ),
  );
});

function pin(
  order: number,
  resourceId: string,
  revisionId: string,
  family: "object_type" | "link_type",
  content: unknown,
): ReleaseGatePin {
  return Object.freeze({
    order,
    resourceId,
    revisionId,
    projectId,
    family,
    storedFamily: family,
    content,
    storedContentDigest: digest,
    revisionContentDigest: digest,
    resourceState: "active",
    revisionState: "validated",
    hasCurrentValidationReport: true,
  });
}

function objectType(apiName: string) {
  return {
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `${apiName} definition`,
    primaryKeyPropertyApiName: "id",
    titlePropertyApiName: "id",
    defaultSearchPropertyApiNames: [],
    properties: [
      {
        apiName: "id",
        displayName: "ID",
        description: "Stable ID",
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

function linkType(sourceRevisionId: string, targetRevisionId: string) {
  return {
    schemaVersion: 1,
    apiName: "OrderToCustomer",
    displayName: "Order to Customer",
    description: "Validated Link definition.",
    source: {
      objectTypeRevisionId: sourceRevisionId,
      apiName: "order",
      displayName: "Order",
    },
    target: {
      objectTypeRevisionId: targetRevisionId,
      apiName: "customer",
      displayName: "Customer",
    },
    cardinality: "many_to_one",
    sourceKind: "base",
    deletionBehavior: "restrict",
    actionCreateAllowed: false,
    actionDeleteAllowed: false,
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}
