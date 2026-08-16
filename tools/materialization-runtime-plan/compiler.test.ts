import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { parseArtifactDigest, type ArtifactDigest } from "@ontos/contracts";
import {
  RuntimePlanError,
  compileRuntimeMemberPlan,
  type CompileRuntimeMemberPlanInput,
} from "@ontos/materialization-domain";

const ids = Object.freeze({
  project: "10000000-0000-4000-8000-000000000001",
  release: "10000000-0000-4000-8000-000000000002",
  object: "10000000-0000-4000-8000-000000000003",
  objectRevision: "10000000-0000-4000-8000-000000000004",
  link: "10000000-0000-4000-8000-000000000005",
  linkRevision: "10000000-0000-4000-8000-000000000006",
  schema: "10000000-0000-4000-8000-000000000007",
  schemaRevision: "10000000-0000-4000-8000-000000000008",
  objectMapping: "10000000-0000-4000-8000-000000000009",
  objectMappingRevision: "10000000-0000-4000-8000-000000000010",
  linkMapping: "10000000-0000-4000-8000-000000000011",
  linkMappingRevision: "10000000-0000-4000-8000-000000000012",
  group: "10000000-0000-4000-8000-000000000013",
});

void describe("server-derived Runtime Member Plan", () => {
  void it("derives a deterministic object/link group without accepting member or digest input", () => {
    const first = compileRuntimeMemberPlan(input(), digest);
    const second = compileRuntimeMemberPlan(input(), digest);

    assert.deepEqual(second, first);
    assert.deepEqual(
      first.members.map((member) => member.memberKey),
      ["link:CustomerOrders", "object:Customer"],
    );
    assert.equal(
      first.members.every((member) => member.snapshotGroupId === ids.group),
      true,
    );
    assert.match(first.planDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  void it("keeps metadata-only Releases legal and makes their empty plan deterministic", () => {
    const candidate = input();
    const plan = compileRuntimeMemberPlan(
      {
        ...candidate,
        pins: candidate.pins.filter((pin) => pin.family === "object_type"),
        snapshotGroups: [],
        indexPlans: [],
      },
      digest,
    );
    assert.deepEqual(plan.members, []);
    assert.match(plan.planDigest, /^sha256:[0-9a-f]{64}$/u);
  });

  void it("rejects a partial group, missing server assignment, and missing admitted Index Plan", () => {
    const candidate = input();
    assertCode(
      () =>
        compileRuntimeMemberPlan(
          {
            ...candidate,
            pins: candidate.pins.filter((pin) => pin.resourceId !== ids.linkMapping),
          },
          digest,
        ),
      "RUNTIME_PLAN_GROUP_INCOMPLETE",
    );
    assertCode(
      () => compileRuntimeMemberPlan({ ...candidate, snapshotGroups: [] }, digest),
      "RUNTIME_PLAN_GROUP_INCOMPLETE",
    );
    assertCode(
      () =>
        compileRuntimeMemberPlan(
          { ...candidate, indexPlans: candidate.indexPlans.slice(1) },
          digest,
        ),
      "RUNTIME_PLAN_INDEX_UNAVAILABLE",
    );
  });

  void it("rejects Mapping drift away from exact target and Snapshot Schema pins", () => {
    const candidate = input();
    const mappingIndex = candidate.pins.findIndex((pin) => pin.resourceId === ids.objectMapping);
    const mapping = required(candidate.pins[mappingIndex]);
    const pins = [...candidate.pins];
    pins[mappingIndex] = {
      ...mapping,
      content: { ...(mapping.content as object), targetRevisionId: ids.linkRevision },
    };
    assertCode(
      () => compileRuntimeMemberPlan({ ...candidate, pins }, digest),
      "RUNTIME_PLAN_PIN_MISMATCH",
    );
  });
});

function input(): CompileRuntimeMemberPlanInput {
  return {
    projectId: ids.project,
    releaseId: ids.release,
    pins: [
      pin(ids.object, ids.objectRevision, "object_type", "Customer", {}),
      pin(ids.link, ids.linkRevision, "link_type", "CustomerOrders", {}),
      pin(ids.schema, ids.schemaRevision, "snapshot_schema", "CustomerCsv", {}),
      pin(
        ids.objectMapping,
        ids.objectMappingRevision,
        "mapping",
        "CustomerMapping",
        mapping("object", ids.object, ids.objectRevision),
      ),
      pin(
        ids.linkMapping,
        ids.linkMappingRevision,
        "mapping",
        "CustomerOrdersMapping",
        mapping("link", ids.link, ids.linkRevision),
      ),
    ],
    snapshotGroups: [
      {
        snapshotGroupId: ids.group,
        groupKey: "customer-graph",
        mappingResourceIds: [ids.objectMapping, ids.linkMapping].sort(),
      },
    ],
    indexPlans: [
      {
        targetResourceId: ids.object,
        targetRevisionId: ids.objectRevision,
        indexPlanDigest: digest("object-index"),
      },
      {
        targetResourceId: ids.link,
        targetRevisionId: ids.linkRevision,
        indexPlanDigest: digest("link-index"),
      },
    ],
  };
}

function pin(
  resourceId: string,
  revisionId: string,
  family: "object_type" | "link_type" | "snapshot_schema" | "mapping",
  apiName: string,
  content: unknown,
) {
  return {
    resourceId,
    revisionId,
    family,
    apiName,
    contentDigest: digest(`${resourceId}:${revisionId}`),
    content,
  } as const;
}

function mapping(
  targetKind: "object" | "link",
  targetResourceId: string,
  targetRevisionId: string,
) {
  const common = {
    schemaVersion: 1,
    mappingVersion: "mapping-v1",
    targetKind,
    inputSchemaRevisionId: ids.schemaRevision,
    targetResourceId,
    targetRevisionId,
    valueCodecVersion: "pk1",
    propertyMappings: [],
    qualityRules: {
      primaryKeyNullMaximumCount: 0,
      primaryKeyDuplicateMaximumCount: 0,
      requiredPropertyFailureMaximumCount: 0,
      requiredLinkDanglingMaximumCount: 0,
      optionalPropertyFailureMaximumBasisPoints: 10,
      optionalLinkDanglingMaximumBasisPoints: 10,
      rowCountChangeConfirmationBasisPoints: 1_000,
      optionalFailureDisposition: "reject_row",
    },
  } as const;
  return targetKind === "object"
    ? { ...common, primaryKeyExpression: { op: "column", columnApiName: "customer_id" } }
    : {
        ...common,
        sourceKeyMapping: {
          objectTypeRevisionId: ids.objectRevision,
          expression: { op: "column", columnApiName: "customer_id" },
          codecVersion: "pk1",
        },
        targetKeyMapping: {
          objectTypeRevisionId: ids.objectRevision,
          expression: { op: "column", columnApiName: "order_id" },
          codecVersion: "pk1",
        },
      };
}

function digest(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function assertCode(operation: () => unknown, code: RuntimePlanError["code"]): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof RuntimePlanError && error.code === code,
  );
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Fixture value is missing.");
  return value;
}
