import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalizeContractForDigest } from "@ontos/contracts";
import {
  analyzeDependencyGraph,
  extractResourceDependencies,
  validateDependencyTargets,
  validateRevisionDefinition,
  type DependencyGraphEdge,
} from "@ontos/metadata-domain";
import fc from "fast-check";

const projectId = "00000000-0000-4000-8000-000000000001";
const resourceId = "00000000-0000-4000-8000-000000000002";
const sourceRevisionId = "00000000-0000-4000-8000-000000000010";
const targetRevisionId = "00000000-0000-4000-8000-000000000011";
const secondTargetRevisionId = "00000000-0000-4000-8000-000000000012";

void test("Object semantic validation reports stable field paths", () => {
  const definition = objectType();
  const result = validateRevisionDefinition({
    revisionId: sourceRevisionId,
    resourceId,
    family: "object_type",
    content: {
      ...definition,
      primaryKeyPropertyApiName: "mutableId",
      properties: [
        ...definition.properties,
        {
          ...definition.properties[0],
          apiName: "mutableId",
          displayName: "Mutable ID",
          writeMode: "overlay_override",
        },
        {
          ...definition.properties[0],
          apiName: "payload",
          displayName: "Payload",
          valueType: "json",
          caseSensitive: undefined,
          nullable: true,
          unique: false,
          sortable: false,
          searchable: false,
          filterable: true,
          jsonFilterPaths: ["/nested/value"],
        },
      ],
    },
  });
  assert.deepEqual(
    result.issues.map(({ code, path }) => ({ code, path })),
    [
      {
        code: "PRIMARY_KEY_WRITE_MODE_INVALID",
        path: "/primaryKeyPropertyApiName",
      },
      {
        code: "JSON_FILTER_PATH_NOT_TOP_LEVEL",
        path: "/properties/2/jsonFilterPaths/0",
      },
    ],
  );
});

void test("Link extraction is server-owned and base-only Action mutation is rejected", () => {
  const content = linkType();
  const result = validateRevisionDefinition({
    revisionId: sourceRevisionId,
    resourceId,
    family: "link_type",
    content: { ...content, actionCreateAllowed: true },
  });
  assert.deepEqual(
    result.issues.map(({ code }) => code),
    ["LINK_BASE_ACTION_MUTATION_INVALID"],
  );
  assert.deepEqual(extractResourceDependencies(sourceRevisionId, "link_type", content), [
    {
      sourceRevisionId,
      targetRevisionId,
      dependencyType: "link_source",
      sourcePath: "/source/objectTypeRevisionId",
    },
    {
      sourceRevisionId,
      targetRevisionId: secondTargetRevisionId,
      dependencyType: "link_target",
      sourcePath: "/target/objectTypeRevisionId",
    },
  ]);
});

void test("dependency validation hides cross-Project existence and rejects invalid target state", () => {
  const dependencies = extractResourceDependencies(sourceRevisionId, "link_type", linkType());
  const issues = validateDependencyTargets({
    projectId,
    resourceId,
    dependencies,
    targets: [
      {
        revisionId: targetRevisionId,
        resourceId: "00000000-0000-4000-8000-000000000020",
        projectId: "00000000-0000-4000-8000-000000000099",
        family: "object_type",
        resourceState: "active",
        revisionState: "validated",
      },
      {
        revisionId: secondTargetRevisionId,
        resourceId: "00000000-0000-4000-8000-000000000021",
        projectId,
        family: "object_type",
        resourceState: "active",
        revisionState: "draft",
      },
    ],
  });
  assert.deepEqual(
    issues.map(({ code, resourceId: issueResourceId, path, message }) => ({
      code,
      issueResourceId,
      path,
      message,
    })),
    [
      {
        code: "DEPENDENCY_UNAVAILABLE",
        issueResourceId: resourceId,
        path: "/source/objectTypeRevisionId",
        message: "The referenced Revision is unavailable in this Project.",
      },
      {
        code: "DEPENDENCY_NOT_VALIDATED",
        issueResourceId: resourceId,
        path: "/target/objectTypeRevisionId",
        message: "The referenced Revision has not reached a reusable validated state.",
      },
    ],
  );
  assert.ok(issues.every(({ message }) => !message.includes("00000000")));
});

void test("archived endpoints and non-Object Link targets are rejected", () => {
  const issues = validateDependencyTargets({
    projectId,
    resourceId,
    dependencies: extractResourceDependencies(sourceRevisionId, "link_type", linkType()),
    targets: [
      {
        revisionId: targetRevisionId,
        resourceId: "00000000-0000-4000-8000-000000000020",
        projectId,
        family: "object_type",
        resourceState: "archived",
        revisionState: "validated",
      },
      {
        revisionId: secondTargetRevisionId,
        resourceId: "00000000-0000-4000-8000-000000000021",
        projectId,
        family: "link_type",
        resourceState: "active",
        revisionState: "published",
      },
    ],
  });
  assert.deepEqual(
    issues.map(({ code, path }) => ({ code, path })),
    [
      { code: "DEPENDENCY_ARCHIVED", path: "/source/objectTypeRevisionId" },
      { code: "LINK_ENDPOINT_FAMILY_INVALID", path: "/target/objectTypeRevisionId" },
    ],
  );
});

void test("topological order, cycle path and graph digest ignore insertion order", () => {
  const edges: readonly DependencyGraphEdge[] = [
    edge("a", "b", "/b"),
    edge("a", "c", "/c"),
    edge("b", "d", "/d"),
    edge("c", "d", "/d"),
  ];
  fc.assert(
    fc.property(
      fc.shuffledSubarray([...edges], { minLength: edges.length, maxLength: edges.length }),
      (shuffled) => {
        const analysis = analyzeDependencyGraph({
          roots: ["a"],
          revisionIds: ["d", "b", "a", "c"],
          edges: shuffled,
        });
        assert.deepEqual(analysis.topologicalRevisionIds, ["d", "b", "c", "a"]);
        assert.equal(
          digest(canonicalizeContractForDigest(analysis)),
          digest(
            canonicalizeContractForDigest(
              analyzeDependencyGraph({
                roots: ["a"],
                revisionIds: ["a", "b", "c", "d"],
                edges,
              }),
            ),
          ),
        );
      },
    ),
    { numRuns: 100 },
  );

  const cycle = analyzeDependencyGraph({
    roots: ["c"],
    revisionIds: ["c", "a", "b"],
    edges: [edge("c", "a", "/a"), edge("a", "b", "/b"), edge("b", "c", "/c")],
  });
  assert.deepEqual(cycle.cyclePath, ["a", "b", "c", "a"]);
  assert.deepEqual(cycle.topologicalRevisionIds, []);
  // G2_NEGATIVE:dependency_cycle
});

function objectType() {
  return {
    schemaVersion: 1,
    apiName: "Order",
    displayName: "Order",
    description: "Order definition.",
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
  } as const;
}

function linkType() {
  return {
    schemaVersion: 1,
    apiName: "OrderToCustomer",
    displayName: "Order to Customer",
    description: "Owning customer.",
    source: {
      objectTypeRevisionId: targetRevisionId,
      apiName: "order",
      displayName: "Order",
    },
    target: {
      objectTypeRevisionId: secondTargetRevisionId,
      apiName: "customer",
      displayName: "Customer",
    },
    cardinality: "many_to_one",
    sourceKind: "base",
    deletionBehavior: "restrict",
    actionCreateAllowed: false,
    actionDeleteAllowed: false,
  } as const;
}

function edge(
  sourceRevision: string,
  targetRevision: string,
  sourcePath: string,
): DependencyGraphEdge {
  return {
    sourceRevisionId: sourceRevision,
    targetRevisionId: targetRevision,
    dependencyType: "property_reference",
    sourcePath,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
