import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ContractValidationError,
  CursorContextChangedError,
  OPAQUE_CURSOR_MAXIMUM_LENGTH,
  assertCursorEnvelopeContext,
  parseCursorEnvelope,
  parsePolicyArtifact,
  parsePolicyDecision,
  parsePolicyPredicate,
  parseRuntimeIdentityContext,
  parseRuntimeMetadataResponse,
  parseRuntimeObjectGetResponse,
  parseRuntimePropertyResult,
  parseRuntimeSearchRequest,
  type CursorEnvelope,
  type CursorExpectedContext,
} from "../../packages/contracts/src/index.ts";
import { buildRuntimeReadSchema } from "./runtime-read-schema-source.ts";
import { assertRuntimeReadSchemaAgreement } from "./runtime-read-schema-agreement.ts";
import { CursorTokenError, sealCursorEnvelope, verifyCursorToken } from "./cursor-reference.ts";
import { assertOpenApiCompatible, runRuntimeReadContractChecks } from "./check-runtime-read.ts";
import { validateSchemaDefinition } from "./schema.ts";

const ids = Object.freeze({
  project: "018f47a2-755b-7cc3-98c8-4d2fb871c100",
  release: "018f47a2-755b-7cc3-98c8-4d2fb871c101",
  releaseRevision: "018f47a2-755b-7cc3-98c8-4d2fb871c102",
  activation: "018f47a2-755b-7cc3-98c8-4d2fb871c103",
  objectResource: "018f47a2-755b-7cc3-98c8-4d2fb871c104",
  objectRevision: "018f47a2-755b-7cc3-98c8-4d2fb871c105",
  linkResource: "018f47a2-755b-7cc3-98c8-4d2fb871c106",
  linkRevision: "018f47a2-755b-7cc3-98c8-4d2fb871c107",
  objectGeneration: "018f47a2-755b-7cc3-98c8-4d2fb871c108",
  linkGeneration: "018f47a2-755b-7cc3-98c8-4d2fb871c109",
  policyRevision: "018f47a2-755b-7cc3-98c8-4d2fb871c110",
});
const digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const otherDigest = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const correlationId = "corr_550e8400-e29b-41d4-a716-446655440000";

void test("Runtime Search parses the PRD shape, defaults paging, and keeps injection as data", () => {
  const parsed = parseRuntimeSearchRequest({
    schemaVersion: 1,
    select: ["id", "status"],
    searchText: "'; DROP TABLE runtime.object_current; --",
    where: {
      and: [
        { property: "status", op: "in", value: ["OPEN", "BLOCKED"] },
        { property: "updatedAt", op: "gte", value: "2026-01-01T00:00:00Z" },
      ],
    },
    orderBy: [{ property: "updatedAt", direction: "desc" }],
  });
  assert.equal(parsed.page.size, 50);
  assert.equal(parsed.page.cursor, null);
  assert.equal(parsed.searchText, "'; DROP TABLE runtime.object_current; --");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.select));
});

void test("Query limits and unknown fields fail before compilation", () => {
  assertContractError(
    () =>
      parseRuntimeSearchRequest({
        schemaVersion: 1,
        select: ["id"],
        page: { size: 501 },
      }),
    "CONTRACT_VALUE_OUT_OF_RANGE",
  );
  assertContractError(
    () =>
      parseRuntimeSearchRequest({
        schemaVersion: 1,
        select: ["id"],
        rawSql: "select * from runtime.object_current",
      }),
    "CONTRACT_UNKNOWN_FIELD",
  );
  assertContractError(
    () =>
      parseRuntimeSearchRequest({
        schemaVersion: 1,
        select: ["id"],
        where: nestedNot(6),
      }),
    "CONTRACT_VALUE_OUT_OF_RANGE",
  );
  assertContractError(
    () =>
      parseRuntimeSearchRequest({
        schemaVersion: 1,
        select: ["id"],
        where: {
          property: "status",
          op: "in",
          value: Array.from({ length: 501 }, (_, index) => `V${String(index)}`),
        },
      }),
    "CONTRACT_VALUE_OUT_OF_RANGE",
  );
});

void test("Runtime Identity accepts only trusted bounded summaries", () => {
  const parsed = parseRuntimeIdentityContext(identity("018f47a2-755b-7cc3-98c8-4d2fb871c201"));
  assert.equal(parsed.authorizationMode, "intersection");
  assert.equal(Object.hasOwn(parsed, "bearer"), false);
  assertContractError(
    () =>
      parseRuntimeIdentityContext({
        ...identity("018f47a2-755b-7cc3-98c8-4d2fb871c201"),
        rawClaims: { groups: ["admin"] },
      }),
    "CONTRACT_UNKNOWN_FIELD",
  );
});

void test("Policy Artifact is bounded, deterministic, and requires release-test coverage", () => {
  const artifact = parsePolicyArtifact(policyArtifact());
  assert.equal(artifact.rules.length, 4);
  assert.equal(artifact.testVectors.length, 5);
  assert.equal(artifact.testVectors[0]?.requestTime, "2026-08-18T10:00:00.000000Z");
  const rawSql = structuredClone(policyArtifact()) as Record<string, unknown>;
  const rawRules = rawSql.rules as Record<string, unknown>[];
  rawRules[0] = { ...rawRules[0], rawSql: "TRUE" };
  assertContractError(() => parsePolicyArtifact(rawSql), "CONTRACT_UNKNOWN_FIELD");

  const unboundTime = structuredClone(policyArtifact()) as Record<string, unknown>;
  const timeVectors = unboundTime.testVectors as Record<string, unknown>[];
  const firstTimeVector = timeVectors.at(0);
  assert.ok(firstTimeVector !== undefined);
  Reflect.deleteProperty(firstTimeVector, "requestTime");
  assertContractError(() => parsePolicyArtifact(unboundTime), "CONTRACT_FIELD_MISSING");

  const nested = structuredClone(policyArtifact()) as Record<string, unknown>;
  const nestedRules = nested.rules as Record<string, unknown>[];
  nestedRules[0] = {
    ...nestedRules[0],
    predicate: {
      kind: "link_exists",
      linkTypeApiName: "Assignments",
      linkTypeResourceId: ids.linkResource,
      linkTypeRevisionId: ids.linkRevision,
      targetObjectTypeApiName: "Person",
      targetObjectTypeResourceId: ids.objectResource,
      targetObjectTypeRevisionId: ids.objectRevision,
      predicate: {
        kind: "link_exists",
        linkTypeApiName: "Manager",
        linkTypeResourceId: ids.linkResource,
        linkTypeRevisionId: ids.linkRevision,
        targetObjectTypeApiName: "Person",
        targetObjectTypeResourceId: ids.objectResource,
        targetObjectTypeRevisionId: ids.objectRevision,
        predicate: { kind: "constant", value: true },
      },
    },
  };
  assertContractError(() => parsePolicyArtifact(nested), "CONTRACT_VALUE_OUT_OF_RANGE");
  assert.doesNotThrow(() =>
    parsePolicyPredicate({
      kind: "all",
      predicates: [
        {
          kind: "link_exists",
          linkTypeApiName: "Assignments",
          linkTypeResourceId: ids.linkResource,
          linkTypeRevisionId: ids.linkRevision,
          targetObjectTypeApiName: "Person",
          targetObjectTypeResourceId: ids.objectResource,
          targetObjectTypeRevisionId: ids.objectRevision,
          predicate: { kind: "constant", value: true },
        },
        {
          kind: "link_exists",
          linkTypeApiName: "Reviewers",
          linkTypeResourceId: ids.linkResource,
          linkTypeRevisionId: ids.linkRevision,
          targetObjectTypeApiName: "Person",
          targetObjectTypeResourceId: ids.objectResource,
          targetObjectTypeRevisionId: ids.objectRevision,
          predicate: { kind: "constant", value: true },
        },
      ],
    }),
  );
  assertContractError(
    () =>
      parsePolicyPredicate({
        kind: "compare",
        left: { source: "object_property", apiName: "name" },
        op: "contains",
        right: { source: "actor_attribute", apiName: "needle" },
      }),
    "CONTRACT_TYPE_INVALID",
  );
  assertContractError(
    () =>
      parsePolicyPredicate({
        kind: "compare",
        left: { source: "object_property", apiName: "name" },
        op: "prefix",
        right: { source: "constant", value: 7 },
      }),
    "CONTRACT_TYPE_INVALID",
  );
});

void test("Policy Decision cannot disclose rule detail or contradict a Property disposition", () => {
  const parsed = parsePolicyDecision({
    schemaVersion: 1,
    target: propertyTarget("salary"),
    decision: "allow",
    propertyDisposition: "mask",
    mask: { kind: "redact", displayValue: "Restricted" },
    policyContextHash: digest,
    authorizationEpoch: "7",
    evaluatedAt: "2026-08-18T10:00:00.000000Z",
  });
  assert.equal(parsed.propertyDisposition, "mask");
  assertContractError(
    () =>
      parsePolicyDecision({
        ...parsed,
        ruleTrace: ["ALLOW_IF_REGION_MATCHES"],
      }),
    "CONTRACT_UNKNOWN_FIELD",
  );
});

void test("Runtime metadata removes query capabilities from masked and restricted Properties", () => {
  const response = runtimeMetadataResponse();
  const parsed = parseRuntimeMetadataResponse(response);
  assert.equal(parsed.data.length, 2);
  assertContractError(
    () =>
      parseRuntimeMetadataResponse({
        ...response,
        data: [
          {
            ...(response.data as Record<string, unknown>[])[0],
            properties: [
              {
                apiName: "secret",
                displayName: "Secret",
                valueType: "string",
                disposition: "mask",
                nullable: false,
                filterOperators: ["eq"],
                sortable: false,
                searchable: false,
              },
            ],
            titlePropertyApiName: null,
            defaultSearchProperties: [],
            defaultSort: null,
          },
        ],
      }),
    "CONTRACT_FORMAT_INVALID",
  );
});

void test("Runtime Object keeps value, null, missing, mask, and restricted states distinct", () => {
  const parsed = parseRuntimeObjectGetResponse(runtimeObjectGetResponse());
  assert.deepEqual(
    parsed.data.properties.map(({ state }) => state),
    ["value", "null", "missing", "masked", "restricted"],
  );
  const leaked = structuredClone(runtimeObjectGetResponse());
  const data = leaked.data as Record<string, unknown>;
  const properties = data.properties as Record<string, unknown>[];
  properties[3] = { ...properties[3], value: "real secret" };
  assertContractError(() => parseRuntimeObjectGetResponse(leaked), "CONTRACT_FORMAT_INVALID");

  const invalidValueState = { apiName: "title", state: "value", value: null };
  assertContractError(
    () => parseRuntimePropertyResult(invalidValueState),
    "CONTRACT_FORMAT_INVALID",
  );
  assert.equal(
    validateSchemaDefinition(buildRuntimeReadSchema(), "RuntimePropertyResult", invalidValueState)
      .valid,
    false,
  );
});

void test("Cursor AEAD rejects tampering, expiry, and cross-context reuse", () => {
  const envelope = parseCursorEnvelope(cursorEnvelope(), {
    now: new Date("2026-08-18T10:05:00.000Z"),
    acceptedKeyVersions: new Set(["cursor-k1"]),
  });
  const expected = cursorExpectedContext(envelope);
  const nullableEnvelope = parseCursorEnvelope(
    { ...record(cursorEnvelope()), lastValues: [null, "WI-100"] },
    {
      now: new Date("2026-08-18T10:05:00.000Z"),
      acceptedKeyVersions: new Set(["cursor-k1"]),
    },
  );
  assert.equal(nullableEnvelope.lastValues[0], null);
  assertContractError(
    () =>
      parseCursorEnvelope({
        ...record(cursorEnvelope()),
        sort: [
          { property: "id", direction: "asc", nulls: "last", collation: "C" },
          { property: "id", direction: "desc", nulls: "first", collation: "C" },
        ],
      }),
    "CONTRACT_FORMAT_INVALID",
  );
  assert.doesNotThrow(() => assertCursorEnvelopeContext(envelope, expected));
  const reorderedExpected: CursorExpectedContext = {
    sort: expected.sort,
    identityContextHash: expected.identityContextHash,
    policyContextHash: expected.policyContextHash,
    queryHash: expected.queryHash,
    generations: expected.generations.map(({ generationId, memberKey, resourceRevisionId }) => ({
      generationId,
      memberKey,
      resourceRevisionId,
    })),
    objectTypeRevisionId: expected.objectTypeRevisionId,
    objectTypeResourceId: expected.objectTypeResourceId,
    activationId: expected.activationId,
    releaseRevisionId: expected.releaseRevisionId,
    releaseId: expected.releaseId,
    projectId: expected.projectId,
  };
  assert.doesNotThrow(() => assertCursorEnvelopeContext(envelope, reorderedExpected));
  assert.throws(
    () =>
      assertCursorEnvelopeContext(envelope, {
        ...expected,
        policyContextHash: otherDigest as typeof expected.policyContextHash,
      }),
    (error: unknown) => error instanceof CursorContextChangedError,
  );

  const key = Buffer.alloc(32, 7);
  const token = sealCursorEnvelope(envelope, { version: "cursor-k1", key });
  assert.ok(!Buffer.from(token, "base64url").toString("utf8").includes("WorkItem"));
  assert.equal(
    verifyCursorToken(
      token,
      new Map([["cursor-k1", key]]),
      expected,
      new Date("2026-08-18T10:05:00.000Z"),
    ).queryHash,
    digest,
  );
  const maximumEnvelope = parseCursorEnvelope({
    ...record(cursorEnvelope()),
    keyVersion: "k".repeat(64),
    generations: ["A", "B", "C", "D", "E"].map((suffix) => ({
      memberKey: `object:${suffix.repeat(63)}`,
      resourceRevisionId: ids.objectRevision,
      generationId: ids.objectGeneration,
    })),
    sort: [
      {
        property: "A".repeat(63),
        direction: "desc",
        nulls: "last",
        collation: "C".repeat(64),
      },
      {
        property: "B".repeat(63),
        direction: "desc",
        nulls: "last",
        collation: "C".repeat(64),
      },
    ],
    lastValues: ["😀".repeat(4_096), "😀".repeat(4_096)],
  });
  const maximumToken = sealCursorEnvelope(maximumEnvelope, {
    version: "k".repeat(64),
    key,
  });
  assert.ok(maximumToken.length <= OPAQUE_CURSOR_MAXIMUM_LENGTH);
  const encoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const ciphertext = String(encoded.c);
  const mutationIndex = Math.floor(ciphertext.length / 2);
  const replacement = ciphertext[mutationIndex] === "A" ? "B" : "A";
  encoded.c = `${ciphertext.slice(0, mutationIndex)}${replacement}${ciphertext.slice(
    mutationIndex + 1,
  )}`;
  const tampered = Buffer.from(JSON.stringify(encoded), "utf8").toString("base64url");
  assert.throws(
    () =>
      verifyCursorToken(
        tampered,
        new Map([["cursor-k1", key]]),
        expected,
        new Date("2026-08-18T10:05:00.000Z"),
      ),
    (error: unknown) => error instanceof CursorTokenError && error.code === "CURSOR_INVALID",
  );
  const malformedIv = Buffer.from(
    JSON.stringify({ ...encoded, c: ciphertext, i: "AA" }),
    "utf8",
  ).toString("base64url");
  assert.throws(
    () =>
      verifyCursorToken(
        malformedIv,
        new Map([["cursor-k1", key]]),
        expected,
        new Date("2026-08-18T10:05:00.000Z"),
      ),
    (error: unknown) => error instanceof CursorTokenError && error.code === "CURSOR_INVALID",
  );
  const structurallyInvalidToken = sealCursorEnvelope(
    { ...envelope, generations: [] },
    { version: "cursor-k1", key },
  );
  assert.throws(
    () =>
      verifyCursorToken(
        structurallyInvalidToken,
        new Map([["cursor-k1", key]]),
        expected,
        new Date("2026-08-18T10:05:00.000Z"),
      ),
    (error: unknown) => error instanceof CursorTokenError && error.code === "CURSOR_INVALID",
  );
  assert.throws(
    () =>
      verifyCursorToken(
        token,
        new Map([["cursor-k1", key]]),
        expected,
        new Date("2026-08-18T10:11:00.000Z"),
      ),
    (error: unknown) => error instanceof CursorTokenError && error.code === "CURSOR_EXPIRED",
  );
});

void test("Runtime Read Schema is generated from parser fields and accepts the same public corpus", () => {
  const schema = buildRuntimeReadSchema();
  assert.doesNotThrow(() => assertRuntimeReadSchemaAgreement(schema));
  for (const [definition, value] of [
    ["RuntimeSearchRequest", { schemaVersion: 1, select: ["id"] }],
    ["RuntimeMetadataResponse", runtimeMetadataResponse()],
    ["RuntimeObjectGetResponse", runtimeObjectGetResponse()],
    ["PolicyArtifact", policyArtifact()],
    ["CursorEnvelope", cursorEnvelope()],
  ] as const) {
    const result = validateSchemaDefinition(schema, definition, value);
    assert.equal(result.valid, true, `${definition}: ${JSON.stringify(result.issues)}`);
  }
});

void test("Runtime Read catalog, baseline, OpenAPI, parsers, and Golden agree", async () => {
  assert.deepEqual(await runRuntimeReadContractChecks(process.cwd()), {
    runtimeReadContractCount: 12,
    goldenCaseCount: 15,
    rejectedGoldenCaseCount: 3,
    domainCount: 2,
    actorCount: 5,
    stableErrorCodeCount: 9,
    operationCount: 5,
    compatibilityFindingCount: 0,
  });
});

void test("required, enum, limit, and nullability drift cannot bypass single-source generation", () => {
  const mutations: ((schema: Record<string, unknown>) => void)[] = [
    (schema) => {
      definition(schema, "RuntimeSearchRequest").required = ["schemaVersion"];
    },
    (schema) => {
      const sort = definition(schema, "QuerySort");
      const direction = record(record(sort.properties).direction);
      direction.enum = ["asc"];
    },
    (schema) => {
      const page = definition(schema, "QueryPage");
      record(record(page.properties).size).maximum = 501;
    },
    (schema) => {
      const property = definition(schema, "RuntimeNullProperty");
      record(record(property.properties).value).type = "string";
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(buildRuntimeReadSchema()) as Record<string, unknown>;
    mutate(candidate);
    assert.throws(() => assertRuntimeReadSchemaAgreement(candidate), /disagrees/u);
  }
});

void test("OpenAPI operation removal or rename is a breaking change", async () => {
  const baseline = JSON.parse(
    await readFile("packages/contracts/openapi/runtime-read.candidate.json", "utf8"),
  ) as Record<string, unknown>;
  const candidate = structuredClone(baseline);
  delete record(candidate.paths)["/api/v1/ontologies/{ontology}/metadata"];
  assert.throws(
    () => assertOpenApiCompatible(baseline, candidate),
    /operation removed or renamed/u,
  );

  const rewired = structuredClone(baseline);
  const searchPath = record(
    record(rewired.paths)["/api/v1/ontologies/{ontology}/objects/{objectType}/search"],
  );
  const searchOperation = record(searchPath.post);
  const requestBody = record(searchOperation.requestBody);
  const content = record(requestBody.content);
  const media = record(content["application/json"]);
  record(media.schema).$ref = "#/components/schemas/RuntimeCountRequest";
  assert.throws(() => assertOpenApiCompatible(baseline, rewired), /operation binding changed/u);

  const missingRetiredResponse = structuredClone(baseline);
  const metadataPath = record(
    record(missingRetiredResponse.paths)["/api/v1/ontologies/{ontology}/metadata"],
  );
  const metadataResponses = record(record(metadataPath.get).responses);
  Reflect.deleteProperty(metadataResponses, "410");
  assert.throws(
    () => assertOpenApiCompatible(baseline, missingRetiredResponse),
    /operation binding changed/u,
  );
});

function nestedNot(depth: number): unknown {
  let predicate: unknown = { property: "status", op: "eq", value: "OPEN" };
  for (let index = 0; index < depth; index += 1) predicate = { not: predicate };
  return predicate;
}

function identity(
  principalId: string,
  identityType: "human" | "service" = "human",
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actor: { principalId, identityType },
    delegationChain: [],
    claimsFingerprint: digest,
    authenticatedAt: "2026-08-18T10:00:00.000000Z",
    authorizationMode: "intersection",
  };
}

function objectTarget(): Record<string, unknown> {
  return {
    kind: "object",
    resourceId: ids.objectResource,
    resourceRevisionId: ids.objectRevision,
  };
}

function linkTarget(): Record<string, unknown> {
  return {
    kind: "link",
    resourceId: ids.linkResource,
    resourceRevisionId: ids.linkRevision,
  };
}

function propertyTarget(propertyApiName: string): Record<string, unknown> {
  return {
    kind: "property",
    resourceId: ids.objectResource,
    resourceRevisionId: ids.objectRevision,
    propertyApiName,
  };
}

function policyArtifact(): unknown {
  const actorIds = [
    "018f47a2-755b-7cc3-98c8-4d2fb871c201",
    "018f47a2-755b-7cc3-98c8-4d2fb871c202",
    "018f47a2-755b-7cc3-98c8-4d2fb871c203",
    "018f47a2-755b-7cc3-98c8-4d2fb871c204",
    "018f47a2-755b-7cc3-98c8-4d2fb871c205",
  ] as const;
  return {
    schemaVersion: 1,
    projectId: ids.project,
    releaseId: ids.release,
    policyRevisionId: ids.policyRevision,
    compilerVersion: "policy-ir-v1",
    artifactDigest: digest,
    rules: [
      {
        ruleId: "ALLOW_OBJECT",
        target: objectTarget(),
        effect: "allow",
        predicate: {
          kind: "compare",
          left: { source: "object_property", apiName: "region" },
          op: "eq",
          right: { source: "actor_attribute", apiName: "region" },
        },
      },
      {
        ruleId: "DENY_LINK",
        target: linkTarget(),
        effect: "deny",
        predicate: { kind: "constant", value: false },
      },
      {
        ruleId: "DENY_PROPERTY",
        target: propertyTarget("salary"),
        effect: "deny",
        predicate: { kind: "constant", value: true },
      },
      {
        ruleId: "MASK_PROPERTY",
        target: propertyTarget("email"),
        effect: "mask",
        predicate: { kind: "constant", value: true },
        mask: { kind: "redact", displayValue: "Restricted" },
      },
    ],
    testVectors: [
      {
        vectorId: "ALLOW_HUMAN",
        identity: identity(actorIds[0]),
        requestTime: "2026-08-18T10:00:00.000000Z",
        target: objectTarget(),
        facts: [
          { source: "object_property", apiName: "region", state: "value", value: "EU" },
          { source: "actor_attribute", apiName: "region", state: "value", value: "EU" },
        ],
        expectedDecision: "allow",
      },
      {
        vectorId: "DENY_HUMAN",
        identity: identity(actorIds[1]),
        requestTime: "2026-08-18T10:00:00.000000Z",
        target: objectTarget(),
        facts: [{ source: "object_property", apiName: "region", state: "null" }],
        expectedDecision: "deny",
      },
      {
        vectorId: "DENY_LINK",
        identity: identity(actorIds[2], "service"),
        requestTime: "2026-08-18T10:00:00.000000Z",
        target: linkTarget(),
        facts: [{ source: "link", apiName: "Assignments", state: "missing" }],
        expectedDecision: "deny",
      },
      {
        vectorId: "DENY_PROPERTY",
        identity: identity(actorIds[3]),
        requestTime: "2026-08-18T10:00:00.000000Z",
        target: propertyTarget("salary"),
        facts: [],
        expectedDecision: "deny",
        expectedPropertyDisposition: "deny",
      },
      {
        vectorId: "MASK_PROPERTY",
        identity: identity(actorIds[4]),
        requestTime: "2026-08-18T10:00:00.000000Z",
        target: propertyTarget("email"),
        facts: [],
        expectedDecision: "allow",
        expectedPropertyDisposition: "mask",
      },
    ],
  };
}

function cursorEnvelope(): unknown {
  return {
    schemaVersion: 1,
    keyVersion: "cursor-k1",
    issuedAt: "2026-08-18T10:00:00.000000Z",
    expiresAt: "2026-08-18T10:10:00.000000Z",
    projectId: ids.project,
    releaseId: ids.release,
    releaseRevisionId: ids.releaseRevision,
    activationId: ids.activation,
    objectTypeResourceId: ids.objectResource,
    objectTypeRevisionId: ids.objectRevision,
    generations: [
      {
        memberKey: "link:Assignments",
        resourceRevisionId: ids.linkRevision,
        generationId: ids.linkGeneration,
      },
      {
        memberKey: "object:WorkItem",
        resourceRevisionId: ids.objectRevision,
        generationId: ids.objectGeneration,
      },
    ],
    queryHash: digest,
    policyContextHash: digest,
    identityContextHash: otherDigest,
    sort: [
      { property: "updatedAt", direction: "desc", nulls: "last", collation: "C" },
      { property: "canonicalPrimaryKey", direction: "asc", nulls: "last", collation: "C" },
    ],
    lastValues: ["2026-08-18T09:59:00Z", "WI-100"],
  };
}

function cursorExpectedContext(envelope: CursorEnvelope): CursorExpectedContext {
  return Object.freeze({
    projectId: envelope.projectId,
    releaseId: envelope.releaseId,
    releaseRevisionId: envelope.releaseRevisionId,
    activationId: envelope.activationId,
    objectTypeResourceId: envelope.objectTypeResourceId,
    objectTypeRevisionId: envelope.objectTypeRevisionId,
    generations: envelope.generations,
    queryHash: envelope.queryHash,
    policyContextHash: envelope.policyContextHash,
    identityContextHash: envelope.identityContextHash,
    sort: envelope.sort,
  });
}

function runtimeMetadataResponse(): Record<string, unknown> {
  const property = (
    apiName: string,
    disposition: "allow" | "mask" | "restricted",
    options: Readonly<{ sortable?: boolean; searchable?: boolean }> = {},
  ): Record<string, unknown> => ({
    apiName,
    displayName: apiName,
    valueType: "string",
    disposition,
    nullable: true,
    filterOperators: disposition === "allow" ? ["eq", "isNull"] : [],
    sortable: disposition === "allow" && options.sortable === true,
    searchable: disposition === "allow" && options.searchable === true,
  });
  return {
    ...responseMetadata(),
    data: [
      {
        apiName: "WorkItem",
        displayName: "Work Item",
        titlePropertyApiName: "name",
        defaultSearchProperties: ["name"],
        defaultSort: { property: "name", direction: "asc" },
        properties: [
          property("name", "allow", { sortable: true, searchable: true }),
          property("secret", "mask"),
        ],
        links: [
          {
            apiName: "Assignments",
            displayName: "Assignments",
            targetObjectTypeApiName: "Person",
            direction: "outgoing",
          },
        ],
      },
      {
        apiName: "Order",
        displayName: "Order",
        titlePropertyApiName: "number",
        defaultSearchProperties: ["number"],
        defaultSort: { property: "number", direction: "asc" },
        properties: [property("number", "allow", { sortable: true, searchable: true })],
        links: [],
      },
    ],
  };
}

function runtimeObjectGetResponse(): Record<string, unknown> {
  return {
    ...responseMetadata(),
    data: {
      reference: { objectTypeApiName: "WorkItem", primaryKey: "WI-100" },
      objectVersion: "7",
      properties: [
        { apiName: "name", state: "value", value: "Fix incident" },
        { apiName: "owner", state: "null", value: null },
        { apiName: "notes", state: "missing" },
        { apiName: "secret", state: "masked", displayValue: "Restricted" },
        { apiName: "salary", state: "restricted" },
      ],
    },
  };
}

function responseMetadata(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    releaseId: ids.release,
    releaseRevisionId: ids.releaseRevision,
    readTimestamp: "2026-08-18T10:00:00.000000Z",
    correlationId,
    warnings: [],
  };
}

function assertContractError(
  operation: () => unknown,
  code: ContractValidationError["code"],
): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof ContractValidationError && error.code === code,
  );
}

function definition(schema: Record<string, unknown>, name: string): Record<string, unknown> {
  return record(record(schema.$defs)[name]);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object.");
  }
  return value as Record<string, unknown>;
}
