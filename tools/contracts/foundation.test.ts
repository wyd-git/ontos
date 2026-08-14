import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractValidationError,
  parseCorrelationContext,
  parseErrorEnvelope,
  parseIdentityDelegationSummary,
  parseOntosId,
  readErrorEnvelope,
} from "../../packages/contracts/src/index.ts";
import { runFoundationContractChecks } from "./check-foundation.ts";
import { assertRuntimeSchemaAgreement } from "./runtime-schema-agreement.ts";

const id = "018f47a2-755b-7cc3-98c8-4d2fb871c100";
const correlationId = "corr_550e8400-e29b-41d4-a716-446655440000";

void test("Foundation catalog, JSON Schema, runtime parsers, and Golden Fixtures agree", async () => {
  const result = await runFoundationContractChecks(process.cwd());
  assert.deepEqual(result, {
    goldenCaseCount: 30,
    foundationContractCount: 11,
    deferredFamilyCount: 5,
    errorCodeCount: 16,
    compatibilityFindingCount: 0,
  });
});

void test("write contracts reject unknown fields while Error readers tolerate compatible additions", () => {
  assert.throws(
    () =>
      parseCorrelationContext({
        schemaVersion: 1,
        correlationId,
        futureField: "not accepted on write",
      }),
    (error: unknown) =>
      error instanceof ContractValidationError && error.code === "CONTRACT_UNKNOWN_FIELD",
  );

  const futureResponse = {
    schemaVersion: 1,
    responseMetadata: { future: true },
    error: {
      code: "RATE_LIMITED",
      message: "Retry later.",
      category: "rate_limit",
      retryable: true,
      details: {},
      correlationId,
      localizedMessageKey: "errors.rateLimited",
    },
  };
  assert.throws(
    () => parseErrorEnvelope(futureResponse),
    (error: unknown) =>
      error instanceof ContractValidationError && error.code === "CONTRACT_UNKNOWN_FIELD",
  );
  const read = readErrorEnvelope(futureResponse);
  assert.equal(read.error.code, "RATE_LIMITED");
  assert.equal(Object.hasOwn(read, "responseMetadata"), false);
  assert.equal(Object.hasOwn(read.error, "localizedMessageKey"), false);
});

void test("identity summary excludes raw claims and enforces delegation intersection metadata", () => {
  const parsed = parseIdentityDelegationSummary({
    schemaVersion: 1,
    actor: { principalId: id, identityType: "service" },
    delegationChain: [
      { principalId: "018f47a2-755b-7cc3-98c8-4d2fb871c101", identityType: "human" },
    ],
    claimsFingerprint: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    authenticatedAt: "2026-08-13T10:05:00.123456Z",
    authorizationMode: "intersection",
  });
  assert.equal(parsed.authorizationMode, "intersection");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.delegationChain));
  assert.throws(
    () =>
      parseIdentityDelegationSummary({
        ...parsed,
        rawClaims: { groups: ["admin"] },
      }),
    (error: unknown) =>
      error instanceof ContractValidationError && error.code === "CONTRACT_UNKNOWN_FIELD",
  );
});

void test("Error details preserve __proto__ as inert data and cannot mutate shared prototypes", () => {
  const envelope = JSON.parse(
    `{"schemaVersion":1,"error":{"code":"OBJECT_VERSION_CONFLICT","message":"Conflict.","category":"conflict","retryable":false,"details":{"__proto__":{"polluted":true}},"correlationId":"${correlationId}"}}`,
  ) as unknown;
  const parsed = parseErrorEnvelope(envelope);
  assert.equal(Object.getPrototypeOf(parsed.error.details), null);
  assert.equal(Object.hasOwn(parsed.error.details, "__proto__"), true);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.ok(Object.isFrozen(parsed.error.details));
});

void test("ID values are canonical opaque UUIDs", () => {
  assert.equal(parseOntosId(id), id);
  assert.throws(
    () => parseOntosId(id.toUpperCase()),
    (error: unknown) =>
      error instanceof ContractValidationError && error.code === "CONTRACT_FORMAT_INVALID",
  );
});

void test("Schema and runtime parser metadata cannot drift silently", async () => {
  const { readFile } = await import("node:fs/promises");
  const schema = JSON.parse(
    await readFile("packages/contracts/schemas/foundation.schema.json", "utf8"),
  ) as Record<string, unknown>;
  const candidate = structuredClone(schema);
  const definitions = candidate.$defs as Record<string, Record<string, unknown>>;
  const correlation = definitions.CorrelationContext as Record<string, unknown>;
  correlation.properties = {
    ...(correlation.properties as Record<string, unknown>),
    optionalButParserForgotIt: { type: "string" },
  };
  assert.throws(
    () => assertRuntimeSchemaAgreement(candidate),
    /disagrees with the runtime parser/u,
  );
});

void test("known core errors reject contradictory stable classifications", () => {
  assert.throws(
    () =>
      parseErrorEnvelope({
        schemaVersion: 1,
        error: {
          code: "RATE_LIMITED",
          message: "Wrong classification.",
          category: "internal",
          retryable: false,
          details: {},
          correlationId,
        },
      }),
    (error: unknown) =>
      error instanceof ContractValidationError && error.code === "CONTRACT_FORMAT_INVALID",
  );
});

void test("correlation and delegation semantic invariants reject cycles and duplicate principals", () => {
  assert.throws(
    () =>
      parseCorrelationContext({
        schemaVersion: 1,
        correlationId,
        parentCorrelationId: correlationId,
      }),
    (error: unknown) =>
      error instanceof ContractValidationError && error.code === "CONTRACT_FORMAT_INVALID",
  );
  assert.throws(
    () =>
      parseIdentityDelegationSummary({
        schemaVersion: 1,
        actor: { principalId: id, identityType: "human" },
        delegationChain: [{ principalId: id, identityType: "human" }],
        claimsFingerprint:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        authenticatedAt: "2026-08-13T10:05:00.123456Z",
        authorizationMode: "intersection",
      }),
    (error: unknown) =>
      error instanceof ContractValidationError && error.code === "CONTRACT_FORMAT_INVALID",
  );
});

void test("Error details enforce resource limits while future module codes remain extensible", () => {
  const parsed = parseErrorEnvelope({
    schemaVersion: 1,
    error: {
      code: "FUTURE_MODULE_ERROR",
      message: "A later module can add a code without changing the Envelope shape.",
      category: "validation",
      retryable: false,
      details: {},
      correlationId,
    },
  });
  assert.equal(parsed.error.code, "FUTURE_MODULE_ERROR");
  assert.throws(
    () =>
      parseErrorEnvelope({
        schemaVersion: 1,
        error: {
          code: "FUTURE_MODULE_ERROR",
          message: "Too much detail.",
          category: "validation",
          retryable: false,
          details: { value: "x".repeat(16_384) },
          correlationId,
        },
      }),
    (error: unknown) =>
      error instanceof ContractValidationError && error.code === "CONTRACT_VALUE_OUT_OF_RANGE",
  );
});
