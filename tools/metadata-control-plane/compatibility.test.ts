import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCompatibilityReport,
  parseOntosId,
  parsePackageManifest,
  type ArtifactDigest,
  type ResourceFamily,
} from "@ontos/contracts";
import {
  buildCompatibilityReport,
  comparePackageCompatibility,
  comparePinnedCompatibility,
  compareResourceCompatibility,
  type PinnedCompatibilityDependency,
  type PinnedCompatibilityRevision,
  type PackageCompatibilityPin,
} from "@ontos/metadata-domain";
import { loadTestkitAssets } from "@ontos/testkit";
import fc from "fast-check";

const firstObjectResourceId = "00000000-0000-4000-8000-000000000001";
const secondObjectResourceId = "00000000-0000-4000-8000-000000000002";
const linkResourceId = "00000000-0000-4000-8000-000000000003";
const baselineObjectRevisionId = "00000000-0000-4000-8000-000000000011";
const candidateObjectRevisionId = "00000000-0000-4000-8000-000000000012";
const secondObjectRevisionId = "00000000-0000-4000-8000-000000000013";
const baselineLinkRevisionId = "00000000-0000-4000-8000-000000000021";
const candidateLinkRevisionId = "00000000-0000-4000-8000-000000000022";

interface MutableProperty {
  schemaVersion: number;
  apiName: string;
  displayName: string;
  description: string;
  valueType: string;
  caseSensitive?: boolean | undefined;
  nullable: boolean;
  writeMode: string;
  unique: boolean;
  filterable: boolean;
  sortable: boolean;
  searchable: boolean;
  classification: string;
  enumValues?: string[];
  decimalPrecision?: number;
  decimalScale?: number;
}

interface MutableObjectType {
  schemaVersion: number;
  apiName: string;
  displayName: string;
  description: string;
  primaryKeyPropertyApiName: string;
  titlePropertyApiName: string;
  defaultSearchPropertyApiNames: string[];
  defaultSort: { propertyApiName: string; direction: string }[];
  defaultClassification: string;
  properties: MutableProperty[];
}

void test("PRD matrix classifies display, nullable and Enum widening as compatible", () => {
  const baseline = objectType();
  const candidate = structuredClone(baseline);
  candidate.displayName = "Order record";
  candidate.description = "Updated display copy.";
  candidate.properties.push(property("trackingNote", { nullable: true }));
  const status = candidate.properties.find(({ apiName }) => apiName === "status");
  assert.ok(status);
  status.enumValues = ["NEW", "CONFIRMED", "CANCELLED"];

  const result = compareResourceCompatibility({
    baselineFamily: "object_type",
    baselineContent: baseline,
    candidateFamily: "object_type",
    candidateContent: candidate,
  });

  assert.equal(result.outcome, "compatible");
  assert.deepEqual(
    result.findings.map(({ code, path }) => ({ code, path })),
    [
      { code: "DESCRIPTION_CHANGED", path: "/description" },
      { code: "DISPLAY_TEXT_CHANGED", path: "/displayName" },
      { code: "ENUM_WIDENED", path: "/properties/status/enumValues" },
      { code: "NULLABLE_PROPERTY_ADDED", path: "/properties/trackingNote" },
    ].map((item) =>
      item.code === "DESCRIPTION_CHANGED" ? { ...item, code: "DISPLAY_TEXT_CHANGED" } : item,
    ),
  );
});

void test("PRD matrix blocks removal, rename, type, Primary Key and Enum narrowing", () => {
  const baseline = objectType();
  const candidate = structuredClone(baseline);
  candidate.primaryKeyPropertyApiName = "externalId";
  candidate.titlePropertyApiName = "externalId";
  candidate.defaultSort = [{ propertyApiName: "externalId", direction: "asc" }];
  candidate.properties = candidate.properties.filter(({ apiName }) => apiName !== "orderId");
  candidate.properties.push(
    property("externalId", {
      nullable: false,
      unique: true,
      filterable: true,
      sortable: true,
    }),
  );
  const amount = candidate.properties.find(({ apiName }) => apiName === "amount");
  assert.ok(amount);
  amount.valueType = "integer";
  delete amount.decimalPrecision;
  delete amount.decimalScale;
  const status = candidate.properties.find(({ apiName }) => apiName === "status");
  assert.ok(status);
  status.enumValues = ["NEW"];

  const result = compareResourceCompatibility({
    baselineFamily: "object_type",
    baselineContent: baseline,
    candidateFamily: "object_type",
    candidateContent: candidate,
  });
  assert.equal(result.outcome, "forbidden");
  assertSubset(codes(result), [
    "PRIMARY_KEY_CHANGED",
    "PROPERTY_REMOVED",
    "REQUIRED_PROPERTY_ADDED",
    "PROPERTY_TYPE_CHANGED",
    "ENUM_NARROWED",
  ]);
});

void test("Link endpoint and cardinality changes are breaking while display text is compatible", () => {
  const baseline = linkType(baselineObjectRevisionId, secondObjectRevisionId);
  const displayCandidate = structuredClone(baseline);
  displayCandidate.displayName = "Updated relationship label";
  assert.equal(compare("link_type", baseline, displayCandidate).outcome, "compatible");

  const candidate = structuredClone(baseline);
  candidate.target.objectTypeRevisionId = candidateObjectRevisionId;
  candidate.cardinality = "one_to_one";
  const result = compare("link_type", baseline, candidate);
  assert.equal(result.outcome, "breaking");
  assertSubset(codes(result), ["LINK_TYPE_ENDPOINT_CHANGED", "LINK_TYPE_CARDINALITY_CHANGED"]);
});

void test("query and uniqueness changes remain conditional until G2-02 readiness exists", () => {
  const baseline = objectType();
  const candidate = structuredClone(baseline);
  const status = candidate.properties.find(({ apiName }) => apiName === "status");
  assert.ok(status);
  status.filterable = true;
  status.unique = true;
  status.classification = "restricted";
  candidate.defaultClassification = "confidential";
  const result = compare("object_type", baseline, candidate);
  assert.equal(result.outcome, "conditional");
  assertSubset(codes(result), [
    "PROPERTY_INDEX_REQUIRED",
    "PROPERTY_UNIQUENESS_VALIDATION_REQUIRED",
    "POLICY_SEMANTICS_REVIEW_REQUIRED",
  ]);
  assert.ok(result.findings.every(({ requiredNextStep }) => requiredNextStep.length > 0));
});

void test("Decimal compatibility preserves both integer range and fractional scale", () => {
  const baseline = objectType();
  const narrowed = structuredClone(baseline);
  const narrowedAmount = narrowed.properties.find(({ apiName }) => apiName === "amount");
  assert.ok(narrowedAmount);
  narrowedAmount.decimalScale = 4;
  assert.equal(compare("object_type", baseline, narrowed).outcome, "breaking");
  assert.ok(codes(compare("object_type", baseline, narrowed)).includes("DECIMAL_RANGE_NARROWED"));

  const widened = structuredClone(baseline);
  const widenedAmount = widened.properties.find(({ apiName }) => apiName === "amount");
  assert.ok(widenedAmount);
  widenedAmount.decimalPrecision = 20;
  widenedAmount.decimalScale = 4;
  assert.equal(compare("object_type", baseline, widened).outcome, "compatible");
  assert.ok(codes(compare("object_type", baseline, widened)).includes("DECIMAL_RANGE_WIDENED"));
});

void test("Snapshot Schema and Mapping changes require a new trusted Generation", () => {
  const baselineSchema = snapshotSchema("orderId");
  const changedSchema = structuredClone(baselineSchema);
  changedSchema.columns.push({
    ordinal: 1,
    columnApiName: "displayName",
    valueType: "string",
    required: false,
  });
  const schemaResult = compare("snapshot_schema", baselineSchema, changedSchema);
  assert.equal(schemaResult.outcome, "conditional");
  assert.deepEqual(codes(schemaResult), ["SNAPSHOT_SCHEMA_REMATERIALIZATION_REQUIRED"]);

  const baselineMapping = objectMapping("orderId");
  const changedMapping = objectMapping("legacyOrderId");
  const mappingResult = compare("mapping", baselineMapping, changedMapping);
  assert.equal(mappingResult.outcome, "conditional");
  assert.deepEqual(codes(mappingResult), ["MAPPING_REMATERIALIZATION_REQUIRED"]);
});

void test("a deferred Resource family remains conditional even when unchanged or newly pinned", () => {
  const deferred = pin(
    "00000000-0000-4000-8000-000000000099",
    "00000000-0000-4000-8000-000000000098",
    "action_type",
    { opaque: "not interpreted in G2-01" },
  );
  for (const baselinePins of [[], [deferred]] as const) {
    const result = comparePinnedCompatibility({
      baselinePins,
      candidatePins: [deferred],
      candidateDependencies: [],
    });
    assert.equal(result.outcome, "conditional");
    assert.ok(codes(result).includes("RESOURCE_FAMILY_COMPATIBILITY_DEFERRED"));
  }
});

void test("Package comparison fixes identity and expansion while ignoring Semantic Version labels", () => {
  const baselineContent = objectType();
  const candidateContent = structuredClone(baselineContent);
  candidateContent.properties.push(property("note", { nullable: true }));
  const baselinePin = packagePin(
    firstObjectResourceId,
    baselineObjectRevisionId,
    "object_type",
    baselineContent,
    digest("a"),
  );
  const candidatePin = packagePin(
    firstObjectResourceId,
    candidateObjectRevisionId,
    "object_type",
    candidateContent,
    digest("b"),
  );
  const baselineManifest = packageManifest("1.0.0", "fixture.commerce", baselinePin);
  const candidateManifest = packageManifest("99.0.0", "fixture.commerce", candidatePin);
  const compatible = comparePackageCompatibility({
    baselineManifest,
    candidateManifest,
    baselinePins: [baselinePin],
    candidatePins: [candidatePin],
    candidateDependencies: [],
  });
  assert.equal(compatible.outcome, "compatible");
  assert.deepEqual(codes(compatible), ["NULLABLE_PROPERTY_ADDED"]);

  const movedNamespace = comparePackageCompatibility({
    baselineManifest,
    candidateManifest: packageManifest("2.0.0", "fixture.renamed", candidatePin),
    baselinePins: [baselinePin],
    candidatePins: [candidatePin],
    candidateDependencies: [],
  });
  assert.equal(movedNamespace.outcome, "forbidden");
  assert.ok(codes(movedNamespace).includes("NAMESPACE_CHANGED"));

  const forgedExpansion = comparePackageCompatibility({
    baselineManifest,
    candidateManifest,
    baselinePins: [baselinePin],
    candidatePins: [{ ...candidatePin, contentDigest: digest("f") }],
    candidateDependencies: [],
  });
  assert.equal(forgedExpansion.outcome, "forbidden");
  assert.ok(codes(forgedExpansion).includes("PACKAGE_RESOURCE_EXPANSION_MISMATCH"));
});

void test("actual candidate Pins expose stale downstream Revision dependencies", () => {
  const baselineObject = objectType();
  const candidateObject = structuredClone(baselineObject);
  candidateObject.properties.push(property("trackingNote", { nullable: true }));
  const baselineLink = linkType(baselineObjectRevisionId, secondObjectRevisionId);
  const candidateLink = linkType(candidateObjectRevisionId, secondObjectRevisionId);
  const baselinePins = [
    pin(firstObjectResourceId, baselineObjectRevisionId, "object_type", baselineObject),
    pin(secondObjectResourceId, secondObjectRevisionId, "object_type", objectType("Customer")),
    pin(linkResourceId, baselineLinkRevisionId, "link_type", baselineLink),
  ];

  const staleCandidatePins = [
    pin(firstObjectResourceId, candidateObjectRevisionId, "object_type", candidateObject),
    baselinePins[1] as PinnedCompatibilityRevision,
    baselinePins[2] as PinnedCompatibilityRevision,
  ];
  const stale = comparePinnedCompatibility({
    baselinePins,
    candidatePins: staleCandidatePins,
    candidateDependencies: dependencies(baselineLinkRevisionId, baselineObjectRevisionId),
  });
  assert.equal(stale.outcome, "breaking");
  assert.ok(codes(stale).includes("DOWNSTREAM_PIN_REQUIRES_REPIN"));

  const closedCandidatePins = [
    staleCandidatePins[0] as PinnedCompatibilityRevision,
    staleCandidatePins[1] as PinnedCompatibilityRevision,
    pin(linkResourceId, candidateLinkRevisionId, "link_type", candidateLink),
  ];
  const closed = comparePinnedCompatibility({
    baselinePins,
    candidatePins: closedCandidatePins,
    candidateDependencies: dependencies(candidateLinkRevisionId, candidateObjectRevisionId),
  });
  assert.equal(closed.outcome, "compatible");
  assert.equal(codes(closed).includes("DOWNSTREAM_PIN_REQUIRES_REPIN"), false);
  assert.equal(codes(closed).includes("LINK_TYPE_ENDPOINT_CHANGED"), false);
});

void test("finding order and report envelope are stable across input order and repeat runs", () => {
  const baselinePins = [
    pin(firstObjectResourceId, baselineObjectRevisionId, "object_type", objectType()),
    pin(secondObjectResourceId, secondObjectRevisionId, "object_type", objectType("Customer")),
    pin(
      linkResourceId,
      baselineLinkRevisionId,
      "link_type",
      linkType(baselineObjectRevisionId, secondObjectRevisionId),
    ),
  ];
  const candidateObject = objectType();
  candidateObject.properties.push(property("note", { nullable: true }));
  const candidatePins = [
    pin(firstObjectResourceId, candidateObjectRevisionId, "object_type", candidateObject),
    baselinePins[1] as PinnedCompatibilityRevision,
    baselinePins[2] as PinnedCompatibilityRevision,
  ];
  const edges = dependencies(baselineLinkRevisionId, baselineObjectRevisionId);
  const expected = comparePinnedCompatibility({
    baselinePins,
    candidatePins,
    candidateDependencies: edges,
  });

  fc.assert(
    fc.property(
      fc.shuffledSubarray([...baselinePins], {
        minLength: baselinePins.length,
        maxLength: baselinePins.length,
      }),
      fc.shuffledSubarray([...candidatePins], {
        minLength: candidatePins.length,
        maxLength: candidatePins.length,
      }),
      fc.shuffledSubarray([...edges], { minLength: edges.length, maxLength: edges.length }),
      (shuffledBaseline, shuffledCandidate, shuffledEdges) => {
        assert.deepEqual(
          comparePinnedCompatibility({
            baselinePins: shuffledBaseline,
            candidatePins: shuffledCandidate,
            candidateDependencies: shuffledEdges,
          }),
          expected,
        );
      },
    ),
    { numRuns: 100 },
  );

  const report = buildCompatibilityReport({
    reportId: parseOntosId("00000000-0000-4000-8000-000000000099", "$test.reportId"),
    baselineDigest: digest("a"),
    candidateDigest: digest("b"),
    evaluation: expected,
  });
  assert.deepEqual(parseCompatibilityReport(report), report);
});

void test("G1 compatibility vectors have explicit active or owning-Gate conclusions", async () => {
  const { packageCompatibilityVectors } = await loadTestkitAssets();
  const cases = packageCompatibilityVectors["cases"];
  assert.ok(Array.isArray(cases));
  const ids = cases.map((item) => {
    assert.ok(typeof item === "object" && item !== null && !Array.isArray(item));
    const id = (item as Record<string, unknown>)["id"];
    assert.equal(typeof id, "string");
    return id as string;
  });
  const dispositions: Readonly<Record<string, string>> = {
    "nullable-property-addition": "active:Object/Property compatibility",
    "primary-key-change-and-property-removal": "active:Object/Property compatibility",
    "raw-sql-and-kernel-migrations-forbidden": "G2-01-09:Package preflight",
    "release-history-pin-and-rollback": "G2-01-08/09:Release and Package rollback",
    "breaking-upgrade-not-published": "active:Object compatibility + G2-01-09 atomicity",
    "namespace-link-action-policy-breaking":
      "active:Link endpoint; G2-01-09 namespace; G2-03/04 deferred Policy/Action",
    "handler-digest-compatible-release": "G2-04 deferred Action semantics",
    "two-domains-one-runtime-bridge": "G2-01-09/G2-02 Package and runtime integration",
  };
  assert.deepEqual([...ids].sort(), Object.keys(dispositions).sort());

  const nullable = objectType("Shipment");
  const nullableCandidate = structuredClone(nullable);
  nullableCandidate.properties.push(property("trackingNote", { nullable: true }));
  assert.deepEqual(codes(compare("object_type", nullable, nullableCandidate)), [
    "NULLABLE_PROPERTY_ADDED",
  ]);

  const removalCandidate = structuredClone(objectType());
  removalCandidate.primaryKeyPropertyApiName = "newOrderId";
  removalCandidate.titlePropertyApiName = "newOrderId";
  removalCandidate.defaultSort = [{ propertyApiName: "newOrderId", direction: "asc" }];
  removalCandidate.properties = removalCandidate.properties.filter(
    ({ apiName }) => apiName !== "orderId" && apiName !== "status",
  );
  removalCandidate.properties.push(
    property("newOrderId", { nullable: false, unique: true, filterable: true, sortable: true }),
  );
  assertSubset(codes(compare("object_type", objectType(), removalCandidate)), [
    "PRIMARY_KEY_CHANGED",
    "PROPERTY_REMOVED",
  ]);
});

function compare(family: ResourceFamily, baselineContent: unknown, candidateContent: unknown) {
  return compareResourceCompatibility({
    baselineFamily: family,
    baselineContent,
    candidateFamily: family,
    candidateContent,
  });
}

function snapshotSchema(keyColumn: string) {
  return {
    schemaVersion: 1,
    contractVersion: "snapshot-schema-v1",
    format: "csv_utf8",
    headerRow: true,
    columns: [{ ordinal: 0, columnApiName: keyColumn, valueType: "string", required: true }],
  };
}

function objectMapping(keyColumn: string) {
  return {
    schemaVersion: 1,
    mappingVersion: "mapping-v1",
    targetKind: "object",
    inputSchemaRevisionId: baselineObjectRevisionId,
    targetResourceId: firstObjectResourceId,
    targetRevisionId: candidateObjectRevisionId,
    valueCodecVersion: "pk1",
    propertyMappings: [],
    primaryKeyExpression: { op: "column", columnApiName: keyColumn },
    qualityRules: {
      primaryKeyNullMaximumCount: 0,
      primaryKeyDuplicateMaximumCount: 0,
      requiredPropertyFailureMaximumCount: 0,
      requiredLinkDanglingMaximumCount: 0,
      optionalPropertyFailureMaximumBasisPoints: 0,
      optionalLinkDanglingMaximumBasisPoints: 0,
      rowCountChangeConfirmationBasisPoints: 5_000,
      optionalFailureDisposition: "reject_row",
    },
  };
}

function codes(result: ReturnType<typeof compareResourceCompatibility>): string[] {
  return result.findings.map(({ code }) => code);
}

function assertSubset(actual: readonly string[], expected: readonly string[]): void {
  for (const code of expected)
    assert.ok(actual.includes(code), `${code} missing from ${actual.join(",")}`);
}

function objectType(apiName = "Order"): MutableObjectType {
  return {
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `${apiName} definition.`,
    primaryKeyPropertyApiName: "orderId",
    titlePropertyApiName: "orderId",
    defaultSearchPropertyApiNames: [],
    defaultSort: [{ propertyApiName: "orderId", direction: "asc" }],
    defaultClassification: "internal",
    properties: [
      property("orderId", {
        nullable: false,
        unique: true,
        filterable: true,
        sortable: true,
        caseSensitive: true,
      }),
      {
        ...property("status", { nullable: false }),
        valueType: "enum",
        caseSensitive: undefined,
        enumValues: ["NEW", "CONFIRMED"],
      },
      {
        ...property("amount", { nullable: false }),
        valueType: "decimal",
        caseSensitive: undefined,
        decimalPrecision: 18,
        decimalScale: 2,
      },
    ],
  };
}

function property(
  apiName: string,
  overrides: Partial<{
    nullable: boolean;
    unique: boolean;
    filterable: boolean;
    sortable: boolean;
    searchable: boolean;
    caseSensitive: boolean;
  }> = {},
): MutableProperty {
  return {
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `${apiName} property.`,
    valueType: "string",
    caseSensitive: overrides.caseSensitive ?? true,
    nullable: overrides.nullable ?? true,
    writeMode: "source_only",
    unique: overrides.unique ?? false,
    filterable: overrides.filterable ?? false,
    sortable: overrides.sortable ?? false,
    searchable: overrides.searchable ?? false,
    classification: "internal",
  };
}

function linkType(sourceRevisionId: string, targetRevisionId: string) {
  return {
    schemaVersion: 1,
    apiName: "OrderToCustomer",
    displayName: "Order to Customer",
    description: "Owning customer.",
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

function pin(
  resourceId: string,
  revisionId: string,
  family: ResourceFamily,
  content: unknown,
): PinnedCompatibilityRevision {
  return { resourceId, revisionId, family, content };
}

function packagePin(
  resourceId: string,
  revisionId: string,
  family: ResourceFamily,
  content: unknown,
  contentDigest: ArtifactDigest,
): PackageCompatibilityPin {
  return {
    resourceId,
    revisionId,
    family,
    content,
    namespace: "fixture.commerce",
    apiName: "Order",
    contentDigest,
  };
}

function packageManifest(version: string, namespace: string, resource: PackageCompatibilityPin) {
  return parsePackageManifest({
    schemaVersion: 1,
    packageApiName: "commerce_fixture",
    version,
    namespace,
    kernelContractVersion: "1",
    resourceEntries: [
      {
        namespace: resource.namespace,
        apiName: resource.apiName,
        family: resource.family,
        resourceId: resource.resourceId,
        revisionId: resource.revisionId,
        contentDigest: resource.contentDigest,
      },
    ],
    artifactDigests: [],
    installInputs: [],
    manifestDigest: digest("e"),
  });
}

function dependencies(
  sourceRevisionId: string,
  targetRevisionId: string,
): readonly PinnedCompatibilityDependency[] {
  return [
    {
      sourceRevisionId,
      targetRevisionId,
      dependencyType: "link_source",
      sourcePath: "/source/objectTypeRevisionId",
    },
    {
      sourceRevisionId,
      targetRevisionId: secondObjectRevisionId,
      dependencyType: "link_target",
      sourcePath: "/target/objectTypeRevisionId",
    },
  ];
}

function digest(character: string): ArtifactDigest {
  return `sha256:${character.repeat(64)}` as ArtifactDigest;
}
