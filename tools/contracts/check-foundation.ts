import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CORE_ERROR_CLASSIFICATIONS,
  ContractValidationError,
  parseArtifactDigest,
  parseCanonicalInstant,
  parseCorrelationContext,
  parseCorrelationId,
  parseErrorEnvelope,
  parseIdempotencyKey,
  parseIdentityDelegationSummary,
  parseOntosId,
  parseReleaseBinding,
  parseSchemaVersion,
} from "../../packages/contracts/src/index.ts";
import { PRIMARY_KEY_CODEC_VERSION } from "../../packages/value-codec/src/index.ts";
import { diffContractSchemas } from "./compatibility.ts";
import { diffErrorCodeCatalogs, readErrorCodeDefinitions } from "./error-code-compatibility.ts";
import { assertRuntimeSchemaAgreement } from "./runtime-schema-agreement.ts";
import { assertSupportedSchema, validateSchemaDefinition } from "./schema.ts";

export interface FoundationContractCheckResult {
  readonly goldenCaseCount: number;
  readonly foundationContractCount: number;
  readonly deferredFamilyCount: number;
  readonly errorCodeCount: number;
  readonly compatibilityFindingCount: number;
}

interface GoldenCase {
  readonly name: string;
  readonly contract: string;
  readonly classification: "boundary" | "rejected" | "valid";
  readonly value: unknown;
  readonly expectedErrorCode?: string;
}

const parsers: Readonly<Record<string, (value: unknown) => unknown>> = Object.freeze({
  SchemaVersion: (value) => parseSchemaVersion(value),
  OntosId: (value) => parseOntosId(value),
  CorrelationId: (value) => parseCorrelationId(value),
  ArtifactDigest: (value) => parseArtifactDigest(value),
  IdempotencyKey: (value) => parseIdempotencyKey(value),
  CanonicalInstant: (value) => parseCanonicalInstant(value),
  CorrelationContext: (value) => parseCorrelationContext(value),
  IdentityDelegationSummary: (value) => parseIdentityDelegationSummary(value),
  ReleaseBinding: (value) => parseReleaseBinding(value),
  ErrorEnvelope: (value) => parseErrorEnvelope(value),
});

export async function runFoundationContractChecks(
  repositoryRoot: string,
): Promise<FoundationContractCheckResult> {
  const currentSchema = await readJson(
    join(repositoryRoot, "packages/contracts/schemas/foundation.schema.json"),
  );
  const baselineSchema = await readJson(
    join(repositoryRoot, "tools/contracts/baseline/foundation.v1.schema.json"),
  );
  const currentErrorCodes = await readJson(
    join(repositoryRoot, "packages/contracts/error-codes.json"),
  );
  const baselineErrorCodes = await readJson(
    join(repositoryRoot, "tools/contracts/baseline/error-codes.v1.json"),
  );
  const catalog = requireRecord(
    await readJson(join(repositoryRoot, "packages/contracts/catalog.json")),
    "$catalog",
  );
  const golden = requireRecord(
    await readJson(join(repositoryRoot, "packages/contracts/fixtures/foundation-golden.json")),
    "$golden",
  );
  const valueCodecGolden = requireRecord(
    await readJson(join(repositoryRoot, "tools/value-codec/golden-vectors.json")),
    "$valueCodecGolden",
  );

  assertSupportedSchema(currentSchema);
  assertSupportedSchema(baselineSchema);
  assertRuntimeSchemaAgreement(currentSchema);
  const compatibility = diffContractSchemas(baselineSchema, currentSchema);
  const errorCompatibility = diffErrorCodeCatalogs(baselineErrorCodes, currentErrorCodes);
  const breaking = [...compatibility.findings, ...errorCompatibility.findings].filter(
    (finding) => finding.severity === "breaking",
  );
  if (breaking.length > 0) {
    throw new Error(
      `Foundation contract contains breaking changes:\n${breaking
        .map((finding) => `${finding.code} ${finding.path}`)
        .join("\n")}`,
    );
  }

  if (catalog.schemaVersion !== 1 || golden.schemaVersion !== 1) {
    throw new Error("Contract catalog and Golden Fixture must use schemaVersion 1.");
  }
  const foundationContracts = requireRecordArray(
    catalog.foundationContracts,
    "$catalog.foundationContracts",
  );
  const deferredFamilies = requireRecordArray(
    catalog.deferredModuleContracts,
    "$catalog.deferredModuleContracts",
  );
  const cases = parseGoldenCases(golden.cases);
  const schemaRoot = requireRecord(currentSchema, "$schema");
  const definitions = requireRecord(schemaRoot.$defs, "$schema.$defs");
  validateCatalog(foundationContracts, deferredFamilies, definitions);
  validateValueCodecGolden(valueCodecGolden);
  validateGoldenCases(cases, currentSchema, foundationContracts);
  const errorCodes = readErrorCodeDefinitions(currentErrorCodes);
  validateCoreErrorRuntimeAgreement(errorCodes);
  validateErrorFixtures(cases, errorCodes);

  return Object.freeze({
    goldenCaseCount: cases.length,
    foundationContractCount: foundationContracts.length,
    deferredFamilyCount: deferredFamilies.length,
    errorCodeCount: errorCodes.length,
    compatibilityFindingCount: compatibility.findings.length + errorCompatibility.findings.length,
  });
}

function validateValueCodecGolden(golden: Readonly<Record<string, unknown>>): void {
  if (golden.schemaVersion !== 1) throw new Error("Value Codec Golden Vector must use version 1.");
  for (const group of [
    "positive",
    "invalid",
    "primaryKeys",
    "orderGroups",
    "collisions",
  ] as const) {
    if (!Array.isArray(golden[group]) || golden[group].length === 0) {
      throw new Error(`Value Codec Golden Vector group ${group} must not be empty.`);
    }
  }
}

function validateCoreErrorRuntimeAgreement(
  definitions: readonly Readonly<{
    code: string;
    httpStatus: number;
    category: string;
    retryable: boolean;
  }>[],
): void {
  const byCode = new Map(definitions.map((item) => [item.code, item]));
  const runtimeCodes = Object.keys(CORE_ERROR_CLASSIFICATIONS);
  if (byCode.size !== runtimeCodes.length) {
    throw new Error("Core error JSON catalog and runtime classification count disagree.");
  }
  for (const code of runtimeCodes) {
    const runtime = CORE_ERROR_CLASSIFICATIONS[code as keyof typeof CORE_ERROR_CLASSIFICATIONS];
    const definition = byCode.get(code);
    if (
      definition === undefined ||
      definition.httpStatus !== runtime.httpStatus ||
      definition.category !== runtime.category ||
      definition.retryable !== runtime.retryable
    ) {
      throw new Error(`Core error ${code} disagrees between JSON and runtime classification.`);
    }
  }
}

function validateErrorFixtures(
  cases: readonly GoldenCase[],
  definitions: readonly Readonly<{
    code: string;
    category: string;
    retryable: boolean;
  }>[],
): void {
  const byCode = new Map(definitions.map((item) => [item.code, item]));
  for (const fixture of cases.filter((item) => item.contract === "ErrorEnvelope")) {
    const envelope = requireRecord(fixture.value, `${fixture.name}.value`);
    const error = requireRecord(envelope.error, `${fixture.name}.value.error`);
    const code = requireString(error.code, `${fixture.name}.value.error.code`);
    const definition = byCode.get(code);
    if (definition === undefined)
      throw new Error(`${fixture.name} uses uncatalogued error ${code}.`);
    if (error.category !== definition.category || error.retryable !== definition.retryable) {
      throw new Error(`${fixture.name} contradicts the stable classification for ${code}.`);
    }
  }
}

function validateCatalog(
  foundationContracts: readonly Readonly<Record<string, unknown>>[],
  deferredFamilies: readonly Readonly<Record<string, unknown>>[],
  definitions: Readonly<Record<string, unknown>>,
): void {
  const names = new Set<string>();
  for (const contract of foundationContracts) {
    const name = requireString(contract.name, "$catalog.foundationContracts[].name");
    if (names.has(name)) throw new Error(`Duplicate Foundation Contract ${name}.`);
    names.add(name);
    if (contract.status !== "frozen") throw new Error(`${name} is not frozen.`);
    requireString(contract.owner, `${name}.owner`);

    if (name === "PropertyValueCodec") {
      if (
        contract.externalContract !== "@ontos/value-codec" ||
        contract.contractVersion !== PRIMARY_KEY_CODEC_VERSION ||
        contract.goldenFixture !== "tools/value-codec/golden-vectors.json"
      ) {
        throw new Error("PropertyValueCodec catalog binding drifted from ADR-009 evidence.");
      }
      continue;
    }
    const definitionName = requireString(contract.schemaDefinition, `${name}.schemaDefinition`);
    const definition = requireRecord(definitions[definitionName], `$defs.${definitionName}`);
    if (contract.direction === "write") {
      if (contract.unknownFields !== "reject" || definition.additionalProperties !== false) {
        throw new Error(`${name} write contract must reject unknown fields.`);
      }
    }
    if (contract.direction === "read") {
      if (
        contract.producerUnknownFields !== "reject" ||
        contract.consumerUnknownFields !== "ignore"
      ) {
        throw new Error(`${name} read compatibility policy is incomplete.`);
      }
    }
  }

  const requiredFamilies = ["Query", "Snapshot", "Action", "Event"];
  for (const required of requiredFamilies) {
    if (!deferredFamilies.some((family) => String(family.family).includes(required))) {
      throw new Error(`Deferred module family ${required} is missing.`);
    }
  }
  for (const family of deferredFamilies) {
    const name = requireString(family.family, "$catalog.deferredModuleContracts[].family");
    requireString(family.owner, `${name}.owner`);
    const gate = requireString(family.latestFreezeGate, `${name}.latestFreezeGate`);
    if (!/^G2-0[1-4]$/u.test(gate)) throw new Error(`${name} has an invalid latest freeze Gate.`);
    const isActivatedMetadataFamily = name === "ResourceRevisionReleasePackage";
    if (family.fieldsFrozen !== isActivatedMetadataFamily) {
      throw new Error(
        `${name} fieldsFrozen must reflect whether its owning Gate has activated it.`,
      );
    }
    if (isActivatedMetadataFamily) {
      const activated = family.activatedDefinitions;
      const activatedDefinitions = Array.isArray(activated)
        ? activated.map((definition, index) =>
            requireString(definition, `${name}.activatedDefinitions[${index}]`),
          )
        : undefined;
      if (
        activatedDefinitions === undefined ||
        JSON.stringify([...activatedDefinitions].sort()) !==
          JSON.stringify(["LinkTypeDefinition", "ObjectTypeDefinition", "PropertyDefinition"])
      ) {
        throw new Error(`${name} activated Metadata definitions are incomplete.`);
      }
    }
    if (!Array.isArray(family.semanticInvariants) || family.semanticInvariants.length < 2) {
      throw new Error(`${name} must declare at least two semantic invariants.`);
    }
    for (const invariant of family.semanticInvariants as unknown[]) {
      requireString(invariant, `${name}.semanticInvariants[]`);
    }
  }
}

function validateGoldenCases(
  cases: readonly GoldenCase[],
  schema: unknown,
  foundationContracts: readonly Readonly<Record<string, unknown>>[],
): void {
  const publicSchemaContracts = foundationContracts
    .filter((contract) => typeof contract.schemaDefinition === "string")
    .map((contract) => String(contract.schemaDefinition));
  for (const contract of publicSchemaContracts) {
    const classifications = new Set(
      cases
        .filter((fixture) => fixture.contract === contract)
        .map((fixture) => fixture.classification),
    );
    for (const expected of ["valid", "boundary", "rejected"] as const) {
      if (!classifications.has(expected)) {
        throw new Error(`${contract} is missing a ${expected} Golden Fixture.`);
      }
    }
  }

  for (const fixture of cases) {
    const parser = parsers[fixture.contract];
    if (parser === undefined)
      throw new Error(`Golden Fixture parser ${fixture.contract} is missing.`);
    const schemaResult = validateSchemaDefinition(schema, fixture.contract, fixture.value);
    if (fixture.classification === "rejected") {
      if (schemaResult.valid) throw new Error(`${fixture.name} must be rejected by JSON Schema.`);
      try {
        parser(fixture.value);
      } catch (error) {
        if (
          !(error instanceof ContractValidationError) ||
          error.code !== fixture.expectedErrorCode
        ) {
          throw new Error(`${fixture.name} returned the wrong stable validation error.`, {
            cause: error,
          });
        }
        continue;
      }
      throw new Error(`${fixture.name} must be rejected by the runtime parser.`);
    }
    if (!schemaResult.valid) {
      throw new Error(`${fixture.name} failed JSON Schema: ${JSON.stringify(schemaResult.issues)}`);
    }
    parser(fixture.value);
  }
}

function parseGoldenCases(value: unknown): readonly GoldenCase[] {
  const records = requireRecordArray(value, "$golden.cases");
  const names = new Set<string>();
  return Object.freeze(
    records.map((record, index): GoldenCase => {
      const path = `$golden.cases[${index}]`;
      const name = requireString(record.name, `${path}.name`);
      if (names.has(name)) throw new Error(`Duplicate Golden Fixture ${name}.`);
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
      if (!Object.hasOwn(record, "value")) throw new Error(`${path}.value is missing.`);
      if (classification === "rejected") {
        return Object.freeze({
          name,
          contract,
          classification,
          value: record.value,
          expectedErrorCode: requireString(record.expectedErrorCode, `${path}.expectedErrorCode`),
        });
      }
      return Object.freeze({ name, contract, classification, value: record.value });
    }),
  );
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function requireRecordArray(
  value: unknown,
  path: string,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return (value as unknown[]).map((item, index) => requireRecord(item, `${path}[${index}]`));
}

function requireRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a string.`);
  return value;
}
