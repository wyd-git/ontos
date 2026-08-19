import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ContractValidationError,
  MATERIALIZATION_CONTRACT_NAMES,
  MATERIALIZATION_OPERATION_ERROR_CODE_VALUES,
  MATERIALIZATION_REASON_CODE_VALUES,
  RESOURCE_FAMILY_REGISTRY,
  parseMaterializationContract,
  type MaterializationContractName,
} from "../../packages/contracts/src/index.ts";
import { diffContractSchemas } from "./compatibility.ts";
import { assertMaterializationRuntimeSchemaAgreement } from "./materialization-runtime-schema-agreement.ts";
import { assertSupportedSchema, validateSchemaDefinition } from "./schema.ts";

export interface MaterializationContractCheckResult {
  readonly materializationContractCount: number;
  readonly goldenCaseCount: number;
  readonly structuralRejectionCount: number;
  readonly semanticRejectionCount: number;
  readonly stableReasonCodeCount: number;
  readonly stableOperationErrorCodeCount: number;
  readonly activeResourceFamilyCount: number;
  readonly deferredResourceFamilyCount: number;
  readonly compatibilityFindingCount: number;
}

interface MaterializationGoldenCase {
  readonly name: string;
  readonly contract: string;
  readonly classification: "boundary" | "rejected" | "valid";
  readonly schemaDisposition: "accept" | "reject";
  readonly value: unknown;
  readonly expectedErrorCode?: string;
}

const requiredSecurityFixtures = Object.freeze([
  "mapping-rejects-raw-sql",
  "mapping-rejects-join-op",
  "snapshot-rejects-arbitrary-path",
  "snapshot-rejects-loose-date",
  "certificate-rejects-client-compatible-flag",
]);

export async function runMaterializationContractChecks(
  repositoryRoot: string,
): Promise<MaterializationContractCheckResult> {
  const [currentSchema, baselineSchema, catalogValue, goldenValue] = await Promise.all([
    readJson(join(repositoryRoot, "packages/contracts/schemas/materialization.schema.json")),
    readJson(join(repositoryRoot, "tools/contracts/baseline/materialization.v1.schema.json")),
    readJson(join(repositoryRoot, "packages/contracts/catalog.json")),
    readJson(join(repositoryRoot, "packages/contracts/fixtures/materialization-golden.json")),
  ]);
  assertSupportedSchema(currentSchema);
  assertSupportedSchema(baselineSchema);
  assertMaterializationRuntimeSchemaAgreement(currentSchema);

  const compatibility = diffContractSchemas(baselineSchema, currentSchema);
  const breaking = compatibility.findings.filter((finding) => finding.severity === "breaking");
  if (breaking.length > 0) {
    throw new Error(
      `Materialization contract contains breaking changes:\n${breaking
        .map((finding) => `${finding.code} ${finding.path}`)
        .join("\n")}`,
    );
  }

  const catalog = requireRecord(catalogValue, "$catalog");
  const golden = requireRecord(goldenValue, "$golden");
  if (catalog.schemaVersion !== 1 || golden.schemaVersion !== 1) {
    throw new Error("Materialization Catalog and Golden Fixture must use schemaVersion 1.");
  }
  const contracts = requireRecordArray(
    catalog.materializationContracts,
    "$catalog.materializationContracts",
  );
  validateCatalog(contracts, catalog.deferredModuleContracts, currentSchema);
  const cases = parseGoldenCases(golden.cases);
  validateCoverage(cases, contracts);
  validateStableReasonCodes(golden.stableReasonCodes);
  validateStableOperationErrorCodes(golden.stableOperationErrorCodes);
  const rejectionCounts = validateGoldenCases(cases, currentSchema);

  const registrations = Object.values(RESOURCE_FAMILY_REGISTRY);
  const activeResourceFamilyCount = registrations.filter(
    (registration) => registration.status === "active",
  ).length;
  const deferredResourceFamilyCount = registrations.length - activeResourceFamilyCount;
  if (
    activeResourceFamilyCount !== 5 ||
    deferredResourceFamilyCount !== 5 ||
    RESOURCE_FAMILY_REGISTRY.mapping.status !== "active" ||
    RESOURCE_FAMILY_REGISTRY.mapping.freezeGate !== "G2-02" ||
    RESOURCE_FAMILY_REGISTRY.snapshot_schema.status !== "active" ||
    RESOURCE_FAMILY_REGISTRY.snapshot_schema.freezeGate !== "G2-02"
  ) {
    throw new Error("G2-03 Resource Family Registry activation boundary drifted.");
  }

  return Object.freeze({
    materializationContractCount: contracts.length,
    goldenCaseCount: cases.length,
    structuralRejectionCount: rejectionCounts.structural,
    semanticRejectionCount: rejectionCounts.semantic,
    stableReasonCodeCount: MATERIALIZATION_REASON_CODE_VALUES.length,
    stableOperationErrorCodeCount: MATERIALIZATION_OPERATION_ERROR_CODE_VALUES.length,
    activeResourceFamilyCount,
    deferredResourceFamilyCount,
    compatibilityFindingCount: compatibility.findings.length,
  });
}

function validateCatalog(
  contracts: readonly Readonly<Record<string, unknown>>[],
  deferredValue: unknown,
  schemaValue: unknown,
): void {
  const schema = requireRecord(schemaValue, "$schema");
  const definitions = requireRecord(schema.$defs, "$schema.$defs");
  const actualNames: string[] = [];
  for (const contract of contracts) {
    const name = requireString(contract.name, "$catalog.materializationContracts[].name");
    actualNames.push(name);
    if (
      contract.status !== "frozen" ||
      (contract.direction !== "internal" && contract.direction !== "server-issued") ||
      contract.unknownFields !== "reject" ||
      contract.fieldsFrozen !== true
    ) {
      throw new Error(`${name} Materialization catalog policy is not frozen and strict.`);
    }
    requireString(contract.owner, `${name}.owner`);
    const schemaDefinition = requireString(contract.schemaDefinition, `${name}.schemaDefinition`);
    const definition = requireRecord(definitions[schemaDefinition], `$defs.${schemaDefinition}`);
    if (definition.additionalProperties !== false) {
      throw new Error(`${name} JSON Schema must reject unknown fields.`);
    }
  }
  assertStringSet(actualNames, MATERIALIZATION_CONTRACT_NAMES, "$catalog.materializationContracts");

  const families = requireRecordArray(deferredValue, "$catalog.deferredModuleContracts");
  const moduleFamily = families.find((family) => family.family === "SnapshotMappingValidationJob");
  if (moduleFamily === undefined || moduleFamily.fieldsFrozen !== true) {
    throw new Error("SnapshotMappingValidationJob must be frozen at G2-02.");
  }
  assertStringSet(
    stringArray(moduleFamily.activatedDefinitions),
    MATERIALIZATION_CONTRACT_NAMES,
    "$catalog.deferredModuleContracts.SnapshotMappingValidationJob.activatedDefinitions",
  );
  assertStringSet(
    stringArray(moduleFamily.stableErrorCodes),
    MATERIALIZATION_OPERATION_ERROR_CODE_VALUES,
    "$catalog.deferredModuleContracts.SnapshotMappingValidationJob.stableErrorCodes",
  );
}

function validateCoverage(
  cases: readonly MaterializationGoldenCase[],
  contracts: readonly Readonly<Record<string, unknown>>[],
): void {
  for (const contract of contracts) {
    const name = requireString(contract.name, "$catalog.materializationContracts[].name");
    if (
      !cases.some((fixture) => fixture.contract === name && fixture.classification !== "rejected")
    ) {
      throw new Error(`${name} is missing an accepted Materialization Golden Fixture.`);
    }
  }
  const names = new Set(cases.map((fixture) => fixture.name));
  for (const fixture of requiredSecurityFixtures) {
    if (!names.has(fixture)) throw new Error(`Required security Fixture ${fixture} is missing.`);
  }
}

function validateStableReasonCodes(value: unknown): void {
  assertStringSet(
    stringArray(value),
    MATERIALIZATION_REASON_CODE_VALUES,
    "$golden.stableReasonCodes",
  );
}

function validateStableOperationErrorCodes(value: unknown): void {
  assertStringSet(
    stringArray(value),
    MATERIALIZATION_OPERATION_ERROR_CODE_VALUES,
    "$golden.stableOperationErrorCodes",
  );
}

function validateGoldenCases(
  cases: readonly MaterializationGoldenCase[],
  schema: unknown,
): Readonly<{ structural: number; semantic: number }> {
  let structural = 0;
  let semantic = 0;
  for (const fixture of cases) {
    if (!isMaterializationContractName(fixture.contract)) {
      throw new Error(`${fixture.name} has no runtime parser.`);
    }
    const schemaResult = validateSchemaDefinition(schema, fixture.contract, fixture.value);
    if (schemaResult.valid !== (fixture.schemaDisposition === "accept")) {
      throw new Error(
        `${fixture.name} JSON Schema disposition drifted: ${JSON.stringify(schemaResult.issues)}`,
      );
    }
    if (fixture.classification !== "rejected") {
      if (!schemaResult.valid) throw new Error(`${fixture.name} must pass JSON Schema.`);
      parseMaterializationContract(fixture.contract, fixture.value);
      continue;
    }
    if (schemaResult.valid) semantic += 1;
    else structural += 1;
    try {
      parseMaterializationContract(fixture.contract, fixture.value);
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

function isMaterializationContractName(value: string): value is MaterializationContractName {
  return (MATERIALIZATION_CONTRACT_NAMES as readonly string[]).includes(value);
}

function parseGoldenCases(value: unknown): readonly MaterializationGoldenCase[] {
  const records = requireRecordArray(value, "$golden.cases");
  const names = new Set<string>();
  return Object.freeze(
    records.map((record, index): MaterializationGoldenCase => {
      const path = `$golden.cases[${index}]`;
      const name = requireString(record.name, `${path}.name`);
      if (names.has(name)) throw new Error(`Duplicate Materialization Golden Fixture ${name}.`);
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
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${path} does not match the frozen Materialization contract.`);
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Expected a string array.");
  }
  return value as readonly string[];
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
