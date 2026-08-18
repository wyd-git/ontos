import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ContractValidationError,
  parseCursorEnvelope,
  parsePolicyArtifact,
  parsePolicyDecision,
  parseRuntimeCountRequest,
  parseRuntimeCountResponse,
  parseRuntimeIdentityContext,
  parseRuntimeLinkSearchRequest,
  parseRuntimeLinkSearchResponse,
  parseRuntimeMetadataResponse,
  parseRuntimeObjectGetResponse,
  parseRuntimeSearchRequest,
  parseRuntimeSearchResponse,
} from "../../packages/contracts/src/index.ts";
import { readErrorCodeDefinitions } from "./error-code-compatibility.ts";
import { diffContractSchemas } from "./compatibility.ts";
import { assertRuntimeReadSchemaAgreement } from "./runtime-read-schema-agreement.ts";
import { assertSupportedSchema, validateSchemaDefinition } from "./schema.ts";

export const RUNTIME_READ_CONTRACT_NAMES = Object.freeze([
  "RuntimeSearchRequest",
  "RuntimeCountRequest",
  "RuntimeLinkSearchRequest",
  "RuntimeIdentityContext",
  "PolicyArtifact",
  "PolicyDecision",
  "CursorEnvelope",
  "RuntimeMetadataResponse",
  "RuntimeObjectGetResponse",
  "RuntimeSearchResponse",
  "RuntimeCountResponse",
  "RuntimeLinkSearchResponse",
] as const);

export type RuntimeReadContractName = (typeof RUNTIME_READ_CONTRACT_NAMES)[number];

export const RUNTIME_READ_ERROR_CODES = Object.freeze([
  "INVALID_QUERY_AST",
  "QUERY_COMPLEXITY_EXCEEDED",
  "PROPERTY_NOT_QUERYABLE",
  "CURSOR_INVALID",
  "CURSOR_EXPIRED",
  "CURSOR_CONTEXT_CHANGED",
  "RELEASE_RETIRED",
  "POLICY_CONTRACT_INVALID",
  "POLICY_EVALUATION_UNAVAILABLE",
] as const);

const expectedOperationBindings = Object.freeze([
  {
    operation: "GET /api/v1/ontologies/{ontology}/metadata",
    operationId: "getRuntimeMetadata",
    parameters: ["Ontology"],
    request: null,
    response: "RuntimeMetadataResponse",
    errors: ["401", "403", "410", "503"],
  },
  {
    operation: "GET /api/v1/ontologies/{ontology}/objects/{objectType}/{primaryKey}",
    operationId: "getRuntimeObject",
    parameters: ["Ontology", "ObjectType", "PrimaryKey"],
    request: null,
    response: "RuntimeObjectGetResponse",
    errors: ["401", "403", "404", "410", "503"],
  },
  {
    operation: "POST /api/v1/ontologies/{ontology}/objects/{objectType}/aggregate",
    operationId: "countRuntimeObjects",
    parameters: ["Ontology", "ObjectType"],
    request: "RuntimeCountRequest",
    response: "RuntimeCountResponse",
    errors: ["400", "401", "403", "410", "429", "503"],
  },
  {
    operation: "POST /api/v1/ontologies/{ontology}/objects/{objectType}/search",
    operationId: "searchRuntimeObjects",
    parameters: ["Ontology", "ObjectType"],
    request: "RuntimeSearchRequest",
    response: "RuntimeSearchResponse",
    errors: ["400", "401", "403", "409", "410", "429", "503"],
  },
  {
    operation:
      "POST /api/v1/ontologies/{ontology}/objects/{objectType}/{primaryKey}/links/{linkType}/search",
    operationId: "searchRuntimeLinks",
    parameters: ["Ontology", "ObjectType", "PrimaryKey", "LinkType"],
    request: "RuntimeLinkSearchRequest",
    response: "RuntimeLinkSearchResponse",
    errors: ["400", "401", "403", "404", "409", "410", "429", "503"],
  },
] as const);

const expectedPaths = Object.freeze(expectedOperationBindings.map(({ operation }) => operation));

const requiredOutcomes = Object.freeze([
  "cursor-context-change",
  "cursor-expiry",
  "cursor-tamper",
  "denied",
  "empty-result",
  "injection-as-data",
  "masked",
  "missing",
  "null",
  "over-limit",
  "unknown-field",
]);

const parsers: Readonly<Record<RuntimeReadContractName, (value: unknown) => unknown>> =
  Object.freeze({
    RuntimeSearchRequest: parseRuntimeSearchRequest,
    RuntimeCountRequest: parseRuntimeCountRequest,
    RuntimeLinkSearchRequest: parseRuntimeLinkSearchRequest,
    RuntimeIdentityContext: parseRuntimeIdentityContext,
    PolicyArtifact: parsePolicyArtifact,
    PolicyDecision: parsePolicyDecision,
    CursorEnvelope: parseCursorEnvelope,
    RuntimeMetadataResponse: parseRuntimeMetadataResponse,
    RuntimeObjectGetResponse: parseRuntimeObjectGetResponse,
    RuntimeSearchResponse: parseRuntimeSearchResponse,
    RuntimeCountResponse: parseRuntimeCountResponse,
    RuntimeLinkSearchResponse: parseRuntimeLinkSearchResponse,
  });

export interface RuntimeReadContractCheckResult {
  readonly runtimeReadContractCount: number;
  readonly goldenCaseCount: number;
  readonly rejectedGoldenCaseCount: number;
  readonly domainCount: number;
  readonly actorCount: number;
  readonly stableErrorCodeCount: number;
  readonly operationCount: number;
  readonly compatibilityFindingCount: number;
}

interface GoldenCase {
  readonly name: string;
  readonly contract: RuntimeReadContractName;
  readonly classification: "boundary" | "rejected" | "valid";
  readonly schemaDisposition: "accept" | "reject";
  readonly value: unknown;
  readonly expectedErrorCode?: string;
}

export async function runRuntimeReadContractChecks(
  repositoryRoot: string,
): Promise<RuntimeReadContractCheckResult> {
  const [schema, baseline, openApi, openApiBaseline, catalogValue, goldenValue, errorsValue] =
    await Promise.all([
      readJson(join(repositoryRoot, "packages/contracts/schemas/runtime-read.schema.json")),
      readJson(join(repositoryRoot, "tools/contracts/baseline/runtime-read.v1.schema.json")),
      readJson(join(repositoryRoot, "packages/contracts/openapi/runtime-read.candidate.json")),
      readJson(
        join(repositoryRoot, "tools/contracts/baseline/runtime-read.openapi.candidate.v1.json"),
      ),
      readJson(join(repositoryRoot, "packages/contracts/catalog.json")),
      readJson(join(repositoryRoot, "packages/contracts/fixtures/runtime-read-golden.json")),
      readJson(join(repositoryRoot, "packages/contracts/error-codes.json")),
    ]);

  assertSupportedSchema(schema);
  assertSupportedSchema(baseline);
  assertRuntimeReadSchemaAgreement(schema);
  const compatibility = diffContractSchemas(baseline, schema);
  assertNoBreakingFindings(compatibility.findings, "Runtime Read Schema");
  assertOpenApiCompatible(openApiBaseline, openApi);

  const catalog = record(catalogValue, "$catalog");
  const contracts = records(catalog.runtimeReadContracts, "$catalog.runtimeReadContracts");
  validateCatalog(contracts, catalog.deferredModuleContracts, schema, errorsValue);

  const golden = record(goldenValue, "$golden");
  if (golden.schemaVersion !== 1) throw new Error("Runtime Read Golden must use schemaVersion 1.");
  const fixtures = record(golden.fixtures, "$golden.fixtures");
  const cases = parseGoldenCases(golden.cases, fixtures);
  validateGoldenCoverage(cases, golden.coverage, golden.behaviorEvidence, fixtures);
  const rejectedGoldenCaseCount = validateGoldenCases(cases, schema);
  const operationCount = validateOpenApi(openApi);

  const coverage = record(golden.coverage, "$golden.coverage");
  return Object.freeze({
    runtimeReadContractCount: contracts.length,
    goldenCaseCount: cases.length,
    rejectedGoldenCaseCount,
    domainCount: strings(coverage.domains, "$golden.coverage.domains").length,
    actorCount: strings(coverage.actorIds, "$golden.coverage.actorIds").length,
    stableErrorCodeCount: RUNTIME_READ_ERROR_CODES.length,
    operationCount,
    compatibilityFindingCount: compatibility.findings.length,
  });
}

function validateCatalog(
  contracts: readonly Readonly<Record<string, unknown>>[],
  familyValue: unknown,
  schemaValue: unknown,
  errorsValue: unknown,
): void {
  const definitions = record(record(schemaValue, "$schema").$defs, "$schema.$defs");
  const actualNames: string[] = [];
  for (const contract of contracts) {
    const name = string(contract.name, "$catalog.runtimeReadContracts[].name");
    actualNames.push(name);
    if (contract.status !== "frozen" || contract.fieldsFrozen !== true) {
      throw new Error(`${name} Runtime Read contract must be frozen.`);
    }
    string(contract.owner, `${name}.owner`);
    const definitionName = string(contract.schemaDefinition, `${name}.schemaDefinition`);
    if (definitionName !== name || !Object.hasOwn(definitions, definitionName)) {
      throw new Error(`${name} has no matching Runtime Read Schema definition.`);
    }
    if (
      record(definitions[definitionName], `$defs.${definitionName}`).additionalProperties !== false
    ) {
      throw new Error(`${name} must reject unknown fields at its top-level boundary.`);
    }
    if (contract.direction === "read") {
      if (
        contract.producerUnknownFields !== "reject" ||
        contract.consumerUnknownFields !== "ignore"
      ) {
        throw new Error(`${name} response compatibility policy is incomplete.`);
      }
    } else if (
      !["write", "internal", "server-issued"].includes(String(contract.direction)) ||
      contract.unknownFields !== "reject"
    ) {
      throw new Error(`${name} non-response boundary must reject unknown fields.`);
    }
  }
  equalStringSets(actualNames, RUNTIME_READ_CONTRACT_NAMES, "$catalog.runtimeReadContracts");

  const families = records(familyValue, "$catalog.deferredModuleContracts");
  const family = families.find(({ family: name }) => name === "QueryPolicyCursor");
  if (family === undefined || family.fieldsFrozen !== true || family.latestFreezeGate !== "G2-03") {
    throw new Error("QueryPolicyCursor must be frozen at G2-03.");
  }
  equalStringSets(
    strings(family.activatedDefinitions, "QueryPolicyCursor.activatedDefinitions"),
    RUNTIME_READ_CONTRACT_NAMES,
    "QueryPolicyCursor.activatedDefinitions",
  );
  equalStringSets(
    strings(family.stableErrorCodes, "QueryPolicyCursor.stableErrorCodes"),
    RUNTIME_READ_ERROR_CODES,
    "QueryPolicyCursor.stableErrorCodes",
  );
  const cataloguedErrors = new Set(readErrorCodeDefinitions(errorsValue).map(({ code }) => code));
  for (const code of RUNTIME_READ_ERROR_CODES) {
    if (!cataloguedErrors.has(code))
      throw new Error(`Runtime Read error ${code} is not catalogued.`);
  }
}

function validateGoldenCases(cases: readonly GoldenCase[], schema: unknown): number {
  let rejected = 0;
  for (const fixture of cases) {
    const result = validateSchemaDefinition(schema, fixture.contract, fixture.value);
    if (result.valid !== (fixture.schemaDisposition === "accept")) {
      throw new Error(
        `${fixture.name} JSON Schema disposition drifted: ${JSON.stringify(result.issues)}`,
      );
    }
    const parser = parsers[fixture.contract];
    if (fixture.classification !== "rejected") {
      parser(fixture.value);
      continue;
    }
    rejected += 1;
    try {
      parser(fixture.value);
    } catch (error) {
      if (error instanceof ContractValidationError && error.code === fixture.expectedErrorCode) {
        continue;
      }
      throw new Error(`${fixture.name} returned the wrong stable parser error.`, { cause: error });
    }
    throw new Error(`${fixture.name} must be rejected by the runtime parser.`);
  }
  return rejected;
}

function validateGoldenCoverage(
  cases: readonly GoldenCase[],
  coverageValue: unknown,
  behaviorEvidenceValue: unknown,
  fixtures: Readonly<Record<string, unknown>>,
): void {
  const coveredContracts = new Set(cases.map(({ contract }) => contract));
  for (const name of RUNTIME_READ_CONTRACT_NAMES) {
    if (!coveredContracts.has(name)) throw new Error(`${name} is missing a Golden case.`);
  }
  const coverage = record(coverageValue, "$golden.coverage");
  equalStringSets(
    strings(coverage.domains, "$golden.coverage.domains"),
    ["Order", "WorkItem"],
    "$golden.coverage.domains",
  );
  const actorIds = strings(coverage.actorIds, "$golden.coverage.actorIds");
  if (actorIds.length !== 5 || new Set(actorIds).size !== 5) {
    throw new Error("Runtime Read Golden must cover exactly five distinct actors.");
  }
  equalStringSets(
    strings(coverage.requiredOutcomes, "$golden.coverage.requiredOutcomes"),
    requiredOutcomes,
    "$golden.coverage.requiredOutcomes",
  );
  const policy = record(fixtures.policyArtifact, "$golden.fixtures.policyArtifact");
  const vectors = records(policy.testVectors, "$golden.fixtures.policyArtifact.testVectors");
  equalStringSets(
    vectors.map((vector, index) => {
      const identity = record(
        vector.identity,
        `$golden.fixtures.policyArtifact.testVectors[${String(index)}].identity`,
      );
      return string(
        record(identity.actor, `${String(index)}.actor`).principalId,
        `${String(index)}.principalId`,
      );
    }),
    actorIds,
    "$golden policy actors",
  );
  const evidence = records(behaviorEvidenceValue, "$golden.behaviorEvidence");
  const evidenceOutcomes = new Set(
    evidence.map((item) => string(item.outcome, "behaviorEvidence.outcome")),
  );
  for (const outcome of [
    "cursor-context-change",
    "cursor-tamper",
    "cursor-expiry",
    "masked",
    "denied",
  ]) {
    if (!evidenceOutcomes.has(outcome))
      throw new Error(`${outcome} has no executable behavior evidence.`);
  }
}

function validateOpenApi(value: unknown): number {
  const openApi = record(value, "$openapi");
  const info = record(openApi.info, "$openapi.info");
  if (
    !String(info.version).endsWith("-candidate") ||
    !String(info.description).includes("not a published SDK")
  ) {
    throw new Error("Runtime Read OpenAPI must remain explicitly Candidate, not a published SDK.");
  }
  const operations = openApiOperations(openApi);
  equalStringSets(operations, expectedPaths, "$openapi.paths");
  if (stableJson(openApi.security) !== stableJson([{ oidc: ["runtime.read"] }])) {
    throw new Error("Runtime Read OpenAPI must require the runtime.read OIDC scope.");
  }
  for (const expected of expectedOperationBindings) {
    const actual = operationBindingSignature(openApi, expected.operation);
    const expectedSignature = {
      operationId: expected.operationId,
      parameters: expected.parameters.map((name) => `#/components/parameters/${name}`),
      request:
        expected.request === null
          ? null
          : {
              required: true,
              schema: `#/components/schemas/${expected.request}`,
            },
      response: `#/components/schemas/${expected.response}`,
      errors: Object.fromEntries(
        expected.errors.map((status) => [status, "#/components/responses/RuntimeError"]),
      ),
    };
    if (stableJson(actual) !== stableJson(expectedSignature)) {
      throw new Error(`Runtime Read OpenAPI operation binding drifted: ${expected.operation}.`);
    }
  }
  const components = record(openApi.components, "$openapi.components");
  const securitySchemes = record(components.securitySchemes, "$openapi.components.securitySchemes");
  const oidc = record(securitySchemes.oidc, "$openapi.components.securitySchemes.oidc");
  if (
    oidc.type !== "openIdConnect" ||
    typeof oidc.openIdConnectUrl !== "string" ||
    !oidc.openIdConnectUrl.startsWith("https://")
  ) {
    throw new Error("Runtime Read OpenAPI OIDC security scheme is invalid.");
  }
  const schemas = record(components.schemas, "$openapi.components.schemas");
  for (const internal of [
    "RuntimeIdentityContext",
    "PolicyArtifact",
    "PolicyDecision",
    "CursorEnvelope",
  ]) {
    if (Object.hasOwn(schemas, internal)) {
      throw new Error(`Internal contract ${internal} must not be published in Runtime OpenAPI.`);
    }
  }
  return operations.length;
}

export function assertOpenApiCompatible(baselineValue: unknown, candidateValue: unknown): void {
  const baseline = record(baselineValue, "$openapiBaseline");
  const candidate = record(candidateValue, "$openapiCandidate");
  const candidateOperations = new Set(openApiOperations(candidate));
  for (const operation of openApiOperations(baseline)) {
    if (!candidateOperations.has(operation)) {
      throw new Error(
        `Runtime Read OpenAPI breaking change: operation removed or renamed: ${operation}`,
      );
    }
    if (
      stableJson(operationBindingSignature(baseline, operation)) !==
      stableJson(operationBindingSignature(candidate, operation))
    ) {
      throw new Error(
        `Runtime Read OpenAPI breaking change: operation binding changed: ${operation}`,
      );
    }
  }
  if (stableJson(baseline.security) !== stableJson(candidate.security)) {
    throw new Error("Runtime Read OpenAPI breaking change: global security changed.");
  }
  const baselineComponents = record(baseline.components, "$baseline.components");
  const candidateComponents = record(candidate.components, "$candidate.components");
  for (const key of ["parameters", "securitySchemes"] as const) {
    if (stableJson(baselineComponents[key]) !== stableJson(candidateComponents[key])) {
      throw new Error(`Runtime Read OpenAPI breaking change: component ${key} changed.`);
    }
  }
  const baselineSchemas = record(baselineComponents.schemas, "$baseline.components.schemas");
  const candidateSchemas = record(candidateComponents.schemas, "$candidate.components.schemas");
  const report = diffContractSchemas({ $defs: baselineSchemas }, { $defs: candidateSchemas });
  assertNoBreakingFindings(report.findings, "Runtime Read OpenAPI Schema");
}

function openApiOperations(openApi: Readonly<Record<string, unknown>>): string[] {
  const paths = record(openApi.paths, "$openapi.paths");
  const result: string[] = [];
  for (const [path, pathValue] of Object.entries(paths)) {
    const pathRecord = record(pathValue, `$openapi.paths.${path}`);
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      if (Object.hasOwn(pathRecord, method)) result.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return result.toSorted();
}

function operationBindingSignature(
  openApi: Readonly<Record<string, unknown>>,
  operationKey: string,
): Readonly<Record<string, unknown>> {
  const separator = operationKey.indexOf(" ");
  if (separator < 1) throw new Error(`Invalid OpenAPI operation key ${operationKey}.`);
  const method = operationKey.slice(0, separator).toLowerCase();
  const path = operationKey.slice(separator + 1);
  const paths = record(openApi.paths, "$openapi.paths");
  const pathRecord = record(paths[path], `$openapi.paths.${path}`);
  const operation = record(pathRecord[method], `$openapi.paths.${path}.${method}`);
  const parameters = records(
    operation.parameters,
    `$openapi.paths.${path}.${method}.parameters`,
  ).map((parameter, index) =>
    string(parameter.$ref, `$openapi.paths.${path}.${method}.parameters[${String(index)}].$ref`),
  );
  const request =
    operation.requestBody === undefined
      ? null
      : {
          required:
            record(operation.requestBody, `$openapi.paths.${path}.${method}.requestBody`)
              .required === true,
          schema: mediaSchemaReference(
            operation.requestBody,
            `$openapi.paths.${path}.${method}.requestBody`,
          ),
        };
  const responses = record(operation.responses, `$openapi.paths.${path}.${method}.responses`);
  const errors = Object.fromEntries(
    Object.keys(responses)
      .filter((status) => status !== "200")
      .toSorted()
      .map((status) => [
        status,
        string(
          record(responses[status], `$openapi.paths.${path}.${method}.responses.${status}`).$ref,
          `$openapi.paths.${path}.${method}.responses.${status}.$ref`,
        ),
      ]),
  );
  return Object.freeze({
    operationId: string(operation.operationId, `$openapi.paths.${path}.${method}.operationId`),
    parameters,
    request,
    response: mediaSchemaReference(
      responses["200"],
      `$openapi.paths.${path}.${method}.responses.200`,
    ),
    errors,
  });
}

function mediaSchemaReference(value: unknown, path: string): string {
  const content = record(record(value, path).content, `${path}.content`);
  const media = record(content["application/json"], `${path}.content.application/json`);
  return string(
    record(media.schema, `${path}.content.application/json.schema`).$ref,
    `${path}.$ref`,
  );
}

function assertNoBreakingFindings(
  findings: readonly Readonly<{ severity: string; code: string; path: string }>[],
  label: string,
): void {
  const breaking = findings.filter(({ severity }) => severity === "breaking");
  if (breaking.length > 0) {
    throw new Error(
      `${label} contains breaking changes:\n${breaking.map(({ code, path }) => `${code} ${path}`).join("\n")}`,
    );
  }
}

function parseGoldenCases(
  value: unknown,
  fixtures: Readonly<Record<string, unknown>>,
): readonly GoldenCase[] {
  const names = new Set<string>();
  return Object.freeze(
    records(value, "$golden.cases").map((item, index): GoldenCase => {
      const path = `$golden.cases[${String(index)}]`;
      const name = string(item.name, `${path}.name`);
      if (names.has(name)) throw new Error(`Duplicate Runtime Read Golden case ${name}.`);
      names.add(name);
      const contract = string(item.contract, `${path}.contract`);
      if (!(RUNTIME_READ_CONTRACT_NAMES as readonly string[]).includes(contract)) {
        throw new Error(`${path}.contract is not active.`);
      }
      const classification = item.classification;
      if (!["valid", "boundary", "rejected"].includes(String(classification))) {
        throw new Error(`${path}.classification is invalid.`);
      }
      const schemaDisposition = item.schemaDisposition;
      if (schemaDisposition !== "accept" && schemaDisposition !== "reject") {
        throw new Error(`${path}.schemaDisposition is invalid.`);
      }
      const hasValue = Object.hasOwn(item, "value");
      const hasFixture = Object.hasOwn(item, "fixture");
      if (hasValue === hasFixture) throw new Error(`${path} must select exactly one value source.`);
      const resolvedValue = hasFixture
        ? fixtures[string(item.fixture, `${path}.fixture`)]
        : item.value;
      if (resolvedValue === undefined) throw new Error(`${path} references a missing Fixture.`);
      return Object.freeze({
        name,
        contract: contract as RuntimeReadContractName,
        classification: classification as GoldenCase["classification"],
        schemaDisposition,
        value: resolvedValue,
        ...(classification === "rejected"
          ? { expectedErrorCode: string(item.expectedErrorCode, `${path}.expectedErrorCode`) }
          : {}),
      });
    }),
  );
}

function equalStringSets(
  actual: readonly string[],
  expected: readonly string[],
  path: string,
): void {
  const normalizedActual = [...actual].toSorted();
  const normalizedExpected = [...expected].toSorted();
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    throw new Error(
      `${path} mismatch: ${normalizedActual.join(",")} != ${normalizedExpected.join(",")}`,
    );
  }
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function records(value: unknown, path: string): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value.map((item, index) => record(item, `${path}[${String(index)}]`));
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be a string array.`);
  return value.map((item, index) => string(item, `${path}[${String(index)}]`));
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a string.`);
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const candidate = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(candidate)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(candidate[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
