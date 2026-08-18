import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ContractValidationError,
  RESOURCE_FAMILY_REGISTRY,
  parseCompatibilityReport,
  parseLinkTypeDefinition,
  parseManagementRoleBinding,
  parseObjectTypeDefinition,
  parsePackageManifest,
  parseProjectContract,
  parsePropertyDefinition,
  parseReleaseManifest,
  parseResourceDependency,
  parseResourceEnvelope,
  parseResourceRevision,
  parseValidationReport,
} from "../../packages/contracts/src/index.ts";
import { diffContractSchemas } from "./compatibility.ts";
import { assertMetadataRuntimeSchemaAgreement } from "./metadata-runtime-schema-agreement.ts";
import { assertSupportedSchema, validateSchemaDefinition } from "./schema.ts";

export interface MetadataContractCheckResult {
  readonly metadataContractCount: number;
  readonly goldenCaseCount: number;
  readonly structuralRejectionCount: number;
  readonly semanticRejectionCount: number;
  readonly activeResourceFamilyCount: number;
  readonly deferredResourceFamilyCount: number;
  readonly compatibilityFindingCount: number;
}

interface MetadataGoldenCase {
  readonly name: string;
  readonly contract: string;
  readonly classification: "boundary" | "rejected" | "valid";
  readonly schemaDisposition: "accept" | "reject";
  readonly value: unknown;
  readonly expectedErrorCode?: string;
}

const parsers: Readonly<Record<string, (value: unknown) => unknown>> = Object.freeze({
  Project: parseProjectContract,
  ResourceEnvelope: parseResourceEnvelope,
  PropertyDefinition: parsePropertyDefinition,
  ObjectTypeDefinition: parseObjectTypeDefinition,
  LinkTypeDefinition: parseLinkTypeDefinition,
  ResourceRevision: parseResourceRevision,
  ResourceDependency: parseResourceDependency,
  ValidationReport: parseValidationReport,
  CompatibilityReport: parseCompatibilityReport,
  ReleaseManifest: parseReleaseManifest,
  PackageManifest: parsePackageManifest,
  ManagementRoleBinding: parseManagementRoleBinding,
});

export async function runMetadataContractChecks(
  repositoryRoot: string,
): Promise<MetadataContractCheckResult> {
  const [currentSchema, baselineSchema, catalogValue, goldenValue] = await Promise.all([
    readJson(join(repositoryRoot, "packages/contracts/schemas/metadata.schema.json")),
    readJson(join(repositoryRoot, "tools/contracts/baseline/metadata.v1.schema.json")),
    readJson(join(repositoryRoot, "packages/contracts/catalog.json")),
    readJson(join(repositoryRoot, "packages/contracts/fixtures/metadata-golden.json")),
  ]);
  assertSupportedSchema(currentSchema);
  assertSupportedSchema(baselineSchema);
  assertMetadataRuntimeSchemaAgreement(currentSchema);

  const compatibility = diffContractSchemas(baselineSchema, currentSchema);
  const breaking = compatibility.findings.filter((finding) => finding.severity === "breaking");
  if (breaking.length > 0) {
    throw new Error(
      `Metadata contract contains breaking changes:\n${breaking
        .map((finding) => `${finding.code} ${finding.path}`)
        .join("\n")}`,
    );
  }

  const catalog = requireRecord(catalogValue, "$catalog");
  const golden = requireRecord(goldenValue, "$golden");
  if (catalog.schemaVersion !== 1 || golden.schemaVersion !== 1) {
    throw new Error("Metadata Catalog and Golden Fixture must use schemaVersion 1.");
  }
  const metadataContracts = requireRecordArray(
    catalog.metadataContracts,
    "$catalog.metadataContracts",
  );
  validateMetadataCatalog(metadataContracts, catalog.deferredModuleContracts, currentSchema);
  const cases = parseGoldenCases(golden.cases);
  validateGoldenCoverage(cases, metadataContracts);
  const rejectionCounts = validateGoldenCases(cases, currentSchema);

  const registrations = Object.values(RESOURCE_FAMILY_REGISTRY);
  const activeResourceFamilyCount = registrations.filter(
    (registration) => registration.status === "active",
  ).length;
  const deferredResourceFamilyCount = registrations.length - activeResourceFamilyCount;
  if (activeResourceFamilyCount !== 4 || deferredResourceFamilyCount !== 6) {
    throw new Error("G2-02 Resource Family Registry activation boundary drifted.");
  }

  return Object.freeze({
    metadataContractCount: metadataContracts.length,
    goldenCaseCount: cases.length,
    structuralRejectionCount: rejectionCounts.structural,
    semanticRejectionCount: rejectionCounts.semantic,
    activeResourceFamilyCount,
    deferredResourceFamilyCount,
    compatibilityFindingCount: compatibility.findings.length,
  });
}

function validateMetadataCatalog(
  contracts: readonly Readonly<Record<string, unknown>>[],
  deferredValue: unknown,
  schemaValue: unknown,
): void {
  const schema = requireRecord(schemaValue, "$schema");
  const definitions = requireRecord(schema.$defs, "$schema.$defs");
  const expectedNames = Object.keys(parsers).sort();
  const actualNames: string[] = [];
  for (const contract of contracts) {
    const name = requireString(contract.name, "$catalog.metadataContracts[].name");
    actualNames.push(name);
    if (
      contract.status !== "frozen" ||
      contract.direction !== "write" ||
      contract.unknownFields !== "reject" ||
      contract.fieldsFrozen !== true
    ) {
      throw new Error(`${name} Metadata catalog policy is not frozen and strict.`);
    }
    requireString(contract.owner, `${name}.owner`);
    const schemaDefinition = requireString(contract.schemaDefinition, `${name}.schemaDefinition`);
    const definition = requireRecord(definitions[schemaDefinition], `$defs.${schemaDefinition}`);
    if (definition.additionalProperties !== false) {
      throw new Error(`${name} JSON Schema must reject unknown fields.`);
    }
  }
  assertStringSet(actualNames, expectedNames, "$catalog.metadataContracts");

  const families = requireRecordArray(deferredValue, "$catalog.deferredModuleContracts");
  for (const family of families) {
    const name = requireString(family.family, "$catalog.deferredModuleContracts[].family");
    const expectedFrozen =
      name === "ResourceRevisionReleasePackage" ||
      name === "SnapshotMappingValidationJob" ||
      name === "QueryPolicyCursor";
    if (family.fieldsFrozen !== expectedFrozen) {
      throw new Error(`${name} fieldsFrozen does not match the active Gate boundary.`);
    }
  }
}

function validateGoldenCoverage(
  cases: readonly MetadataGoldenCase[],
  contracts: readonly Readonly<Record<string, unknown>>[],
): void {
  for (const contract of contracts) {
    const name = requireString(contract.name, "$catalog.metadataContracts[].name");
    const classifications = new Set(
      cases.filter((fixture) => fixture.contract === name).map((fixture) => fixture.classification),
    );
    for (const expected of ["valid", "boundary", "rejected"] as const) {
      if (!classifications.has(expected)) {
        throw new Error(`${name} is missing a ${expected} Metadata Golden Fixture.`);
      }
    }
  }
}

function validateGoldenCases(
  cases: readonly MetadataGoldenCase[],
  schema: unknown,
): Readonly<{ structural: number; semantic: number }> {
  let structural = 0;
  let semantic = 0;
  for (const fixture of cases) {
    const parser = parsers[fixture.contract];
    if (parser === undefined) throw new Error(`${fixture.name} has no runtime parser.`);
    const schemaResult = validateSchemaDefinition(schema, fixture.contract, fixture.value);
    if (schemaResult.valid !== (fixture.schemaDisposition === "accept")) {
      throw new Error(
        `${fixture.name} JSON Schema disposition drifted: ${JSON.stringify(schemaResult.issues)}`,
      );
    }
    if (fixture.classification !== "rejected") {
      if (!schemaResult.valid) throw new Error(`${fixture.name} must pass JSON Schema.`);
      parser(fixture.value);
      continue;
    }
    if (schemaResult.valid) semantic += 1;
    else structural += 1;
    try {
      parser(fixture.value);
    } catch (error) {
      if (error instanceof ContractValidationError && error.code === fixture.expectedErrorCode) {
        continue;
      }
      throw new Error(`${fixture.name} returned the wrong stable validation error.`, {
        cause: error,
      });
    }
    throw new Error(`${fixture.name} must be rejected by the runtime parser.`);
  }
  return Object.freeze({ structural, semantic });
}

function parseGoldenCases(value: unknown): readonly MetadataGoldenCase[] {
  const records = requireRecordArray(value, "$golden.cases");
  const names = new Set<string>();
  return Object.freeze(
    records.map((record, index): MetadataGoldenCase => {
      const path = `$golden.cases[${index}]`;
      const name = requireString(record.name, `${path}.name`);
      if (names.has(name)) throw new Error(`Duplicate Metadata Golden Fixture ${name}.`);
      names.add(name);
      const contract = requireString(record.contract, `${path}.contract`);
      const classification = record.classification;
      if (
        classification !== "valid" &&
        classification !== "boundary" &&
        classification !== "rejected"
      ) {
        throw new Error(`${path}.classification is invalid.`);
      }
      const schemaDisposition = record.schemaDisposition;
      if (schemaDisposition !== "accept" && schemaDisposition !== "reject") {
        throw new Error(`${path}.schemaDisposition is invalid.`);
      }
      if (!Object.hasOwn(record, "value")) throw new Error(`${path}.value is missing.`);
      if (classification === "rejected") {
        return Object.freeze({
          name,
          contract,
          classification,
          schemaDisposition,
          value: record.value,
          expectedErrorCode: requireString(record.expectedErrorCode, `${path}.expectedErrorCode`),
        });
      }
      if (schemaDisposition !== "accept") {
        throw new Error(`${path} non-rejected Fixture must pass JSON Schema.`);
      }
      return Object.freeze({
        name,
        contract,
        classification,
        schemaDisposition,
        value: record.value,
      });
    }),
  );
}

function assertStringSet(
  actual: readonly string[],
  expected: readonly string[],
  path: string,
): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${path} does not match the runtime parser catalog.`);
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function requireRecordArray(
  value: unknown,
  path: string,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value.map((item, index) => requireRecord(item, `${path}[${index}]`));
}

function requireRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
}
