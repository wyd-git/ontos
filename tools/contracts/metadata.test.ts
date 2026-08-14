import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ContractValidationError,
  RESOURCE_FAMILY_REGISTRY,
  ResourceFamilyRegistryError,
  canonicalizeContractForDigest,
  canonicalizeManifestForDigest,
  parseCompatibilityReport,
  parseDirectResourceContent,
  parseManagementRoleBinding,
  parseObjectTypeDefinition,
  parsePackageManifest,
  parsePackageResourceContent,
  parsePropertyDefinition,
  parseReleaseManifest,
  parseValidationReport,
} from "../../packages/contracts/src/index.ts";
import { runMetadataContractChecks } from "./check-metadata.ts";

const digestA = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const digestB = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const projectId = "018f47a2-755b-7cc3-98c8-4d2fb871c100";
const resourceId = "018f47a2-755b-7cc3-98c8-4d2fb871c101";
const revisionId = "018f47a2-755b-7cc3-98c8-4d2fb871c120";

void test("Metadata catalog, schema, parsers, baseline and Golden Fixtures agree", async () => {
  assert.deepEqual(await runMetadataContractChecks(process.cwd()), {
    metadataContractCount: 12,
    goldenCaseCount: 36,
    structuralRejectionCount: 7,
    semanticRejectionCount: 5,
    activeResourceFamilyCount: 2,
    deferredResourceFamilyCount: 8,
    compatibilityFindingCount: 0,
  });
});

void test("Object, Property and Link content rejects unknown and contradictory declarations", () => {
  const objectType = objectFixture();
  const baseProperty = objectType.properties[0];
  if (baseProperty === undefined) throw new Error("Object Fixture must contain a Property.");
  const parsed = parseObjectTypeDefinition(objectType);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.properties));

  assertContractError(
    () =>
      parseObjectTypeDefinition({
        ...objectType,
        properties: [{ ...baseProperty, databaseColumn: "shipment_id" }],
      }),
    "CONTRACT_UNKNOWN_FIELD",
  );
  assertContractError(
    () => parseObjectTypeDefinition({ ...objectType, primaryKeyPropertyApiName: "missing" }),
    "CONTRACT_FORMAT_INVALID",
  );
  assertContractError(
    () =>
      parseObjectTypeDefinition({
        ...objectType,
        properties: [{ ...baseProperty, unique: false }],
      }),
    "CONTRACT_FORMAT_INVALID",
  );
  assertContractError(
    () =>
      parseObjectTypeDefinition({
        ...objectType,
        defaultSearchPropertyApiNames: ["shipmentId"],
      }),
    "CONTRACT_FORMAT_INVALID",
  );
  assertContractError(
    () =>
      parsePropertyDefinition({
        ...baseProperty,
        valueType: "json",
        unique: true,
        jsonFilterPaths: ["/source"],
      }),
    "CONTRACT_FORMAT_INVALID",
  );
  assertContractError(
    () =>
      parsePropertyDefinition({
        ...baseProperty,
        valueType: "decimal",
        caseSensitive: undefined,
        decimalPrecision: 4,
        decimalScale: 5,
      }),
    "CONTRACT_VALUE_OUT_OF_RANGE",
  );
  assertContractError(() => {
    const withoutCaseRule: Record<string, unknown> = { ...baseProperty };
    delete withoutCaseRule.caseSensitive;
    return parsePropertyDefinition(withoutCaseRule);
  }, "CONTRACT_FIELD_MISSING");
  assert.doesNotThrow(() =>
    parseObjectTypeDefinition({
      ...objectType,
      properties: [
        {
          ...baseProperty,
          valueType: "date",
          caseSensitive: undefined,
        },
      ],
    }),
  );
});

void test("direct Resource API and Package expansion share one Resource Family Registry", () => {
  const objectType = objectFixture();
  assert.deepEqual(
    parseDirectResourceContent("object_type", objectType),
    parsePackageResourceContent("object_type", objectType),
  );

  const expectedGates: Readonly<Record<string, string>> = {
    interface: "G2-05",
    mapping: "G2-02",
    snapshot_schema: "G2-02",
    policy: "G2-03",
    function_type: "G2-04",
    action_type: "G2-04",
    object_view: "G2-05",
    application_config: "G2-05",
  };
  for (const [family, freezeGate] of Object.entries(expectedGates)) {
    for (const entryPoint of [parseDirectResourceContent, parsePackageResourceContent]) {
      assert.throws(
        () => entryPoint(family, {}),
        (error: unknown) =>
          error instanceof ResourceFamilyRegistryError &&
          error.code === "CAPABILITY_NOT_ACTIVE" &&
          error.freezeGate === freezeGate,
      );
    }
  }
  assert.equal(Object.keys(RESOURCE_FAMILY_REGISTRY).length, 10);
  assert.throws(
    () => parseDirectResourceContent("future_family", {}),
    (error: unknown) =>
      error instanceof ResourceFamilyRegistryError && error.code === "RESOURCE_FAMILY_UNKNOWN",
  );
});

void test("canonical Metadata preimages ignore object key order and JSON whitespace", () => {
  const left = { z: [3, { b: true, a: "x" }], a: 1 };
  const right = JSON.parse(' { "a" : 1, "z" : [3, { "a" : "x", "b" : true }] } ') as unknown;
  const leftCanonical = canonicalizeContractForDigest(left);
  const rightCanonical = canonicalizeContractForDigest(right);
  assert.equal(leftCanonical, rightCanonical);
  assert.equal(hash(leftCanonical), hash(rightCanonical));
  assert.notEqual(hash(leftCanonical), hash(canonicalizeContractForDigest({ ...left, a: 2 })));
  assertContractError(
    () => canonicalizeContractForDigest({ value: -0 }),
    "CONTRACT_FORMAT_INVALID",
  );
  assertContractError(
    () => canonicalizeContractForDigest({ value: Number.MAX_SAFE_INTEGER + 1 }),
    "CONTRACT_FORMAT_INVALID",
  );
  assertContractError(
    () => canonicalizeContractForDigest({ value: undefined }),
    "CONTRACT_TYPE_INVALID",
  );
});

void test("Release and Package manifest digests exclude only the self-referential digest field", () => {
  const manifest = releaseManifestFixture();
  assert.equal(
    canonicalizeManifestForDigest(manifest),
    canonicalizeManifestForDigest({ ...manifest, manifestDigest: digestB }),
  );
  assert.notEqual(
    canonicalizeManifestForDigest(manifest),
    canonicalizeManifestForDigest({ ...manifest, releaseNumber: 2 }),
  );
  assertContractError(
    () => canonicalizeManifestForDigest({ releaseId: manifest.releaseId }),
    "CONTRACT_FIELD_MISSING",
  );
});

void test("Reports, manifests and Role Bindings enforce cross-field invariants", () => {
  assertContractError(
    () =>
      parseValidationReport({
        schemaVersion: 1,
        reportId: revisionId,
        subjectId: resourceId,
        subjectDigest: digestA,
        validatorVersion: "v1",
        valid: true,
        issues: [validationIssue("error")],
      }),
    "CONTRACT_FORMAT_INVALID",
  );
  assertContractError(
    () =>
      parseCompatibilityReport({
        schemaVersion: 1,
        reportId: revisionId,
        baselineDigest: digestA,
        candidateDigest: digestB,
        outcome: "compatible",
        findings: [
          {
            kind: "breaking",
            code: "PROPERTY_REMOVED",
            path: "/properties/name",
            message: "Removed.",
            requiredNextStep: "Migrate.",
          },
        ],
      }),
    "CONTRACT_FORMAT_INVALID",
  );
  assertContractError(
    () =>
      parseReleaseManifest({
        ...releaseManifestFixture(),
        pins: [{ ...releaseManifestFixture().pins[0], order: 1 }],
      }),
    "CONTRACT_FORMAT_INVALID",
  );
  assertContractError(
    () => parseManagementRoleBinding({ ...roleBindingFixture(), resourceId }),
    "CONTRACT_FORMAT_INVALID",
  );
});

void test("Package manifests require deterministic, duplicate-free resource and input ordering", () => {
  const entryA = packageEntry("Alpha", resourceId, revisionId);
  const entryB = packageEntry(
    "Beta",
    "018f47a2-755b-7cc3-98c8-4d2fb871c102",
    "018f47a2-755b-7cc3-98c8-4d2fb871c121",
  );
  const base = {
    schemaVersion: 1,
    packageApiName: "SupplyStarter",
    version: "1.0.0",
    namespace: "supply.starter",
    kernelContractVersion: "metadata-1",
    resourceEntries: [entryA, entryB],
    artifactDigests: [digestA, digestB],
    installInputs: [
      {
        apiName: "environment",
        displayName: "Environment",
        description: "Target.",
        required: true,
      },
    ],
    manifestDigest: digestA,
  };
  assert.ok(Object.isFrozen(parsePackageManifest(base)));
  assertContractError(
    () => parsePackageManifest({ ...base, resourceEntries: [entryB, entryA] }),
    "CONTRACT_FORMAT_INVALID",
  );
  assertContractError(
    () => parsePackageManifest({ ...base, artifactDigests: [digestB, digestA] }),
    "CONTRACT_FORMAT_INVALID",
  );
});

function objectFixture() {
  return {
    schemaVersion: 1,
    apiName: "Shipment",
    displayName: "Shipment",
    description: "A tracked shipment.",
    primaryKeyPropertyApiName: "shipmentId",
    titlePropertyApiName: "shipmentId",
    defaultSearchPropertyApiNames: [],
    defaultSort: [{ propertyApiName: "shipmentId", direction: "asc" }],
    defaultClassification: "internal",
    properties: [
      {
        schemaVersion: 1,
        apiName: "shipmentId",
        displayName: "Shipment ID",
        description: "Stable identifier.",
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

function releaseManifestFixture() {
  return {
    schemaVersion: 1,
    releaseId: "018f47a2-755b-7cc3-98c8-4d2fb871c170",
    projectId,
    releaseNumber: 1,
    pins: [{ order: 0, resourceId, revisionId, family: "object_type", contentDigest: digestA }],
    manifestDigest: digestA,
    createdAt: "2026-08-14T01:00:00.000000Z",
  };
}

function roleBindingFixture() {
  return {
    schemaVersion: 1,
    bindingId: "018f47a2-755b-7cc3-98c8-4d2fb871c180",
    projectId,
    principalId: "018f47a2-755b-7cc3-98c8-4d2fb871c130",
    scope: "project",
    role: "owner",
    state: "active",
  };
}

function validationIssue(severity: "error" | "warning") {
  return {
    code: "DEPENDENCY_MISSING",
    severity,
    resourceId,
    path: "/target",
    message: "Missing.",
    remediation: "Add it.",
  };
}

function packageEntry(apiName: string, entryResourceId: string, entryRevisionId: string) {
  return {
    namespace: "supply.core",
    apiName,
    family: "object_type",
    resourceId: entryResourceId,
    revisionId: entryRevisionId,
    contentDigest: digestA,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertContractError(action: () => unknown, code: string): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof ContractValidationError && error.code === code,
  );
}
