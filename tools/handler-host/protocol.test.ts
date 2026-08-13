import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXTURE_ARTIFACT_DIGESTS,
  getRegisteredArtifact,
  listPublicArtifactDescriptors,
  validateArtifactInvocation,
  validateArtifactResult,
} from "./catalog.ts";
import { emptyInvocationContext } from "./context.ts";
import {
  HANDLER_PROTOCOL,
  HANDLER_PROTOCOL_VERSION,
  ProtocolMismatchError,
  ProtocolValidationError,
  parseInvokeEnvelope,
  requireJsonObject,
  type InvocationRequest,
} from "./protocol.ts";
import { loadRegisteredArtifact } from "./registry.ts";

void test("v1 RPC accepts the exact typed envelope and rejects executable selectors", () => {
  const valid = envelope(echoRequest());
  assert.deepEqual(parseInvokeEnvelope(valid), valid);

  for (const forbiddenField of ["code", "filePath", "moduleName", "packageName", "url"]) {
    assert.throws(
      () =>
        parseInvokeEnvelope({
          ...valid,
          request: { ...valid.request, [forbiddenField]: "../../arbitrary" },
        }),
      ProtocolValidationError,
    );
  }
  assert.throws(
    () => parseInvokeEnvelope({ ...valid, loaderOptions: { import: "arbitrary" } }),
    ProtocolValidationError,
  );
  assert.throws(
    () => parseInvokeEnvelope({ ...valid, version: HANDLER_PROTOCOL_VERSION + 1 }),
    ProtocolMismatchError,
  );
  assert.throws(
    () =>
      parseInvokeEnvelope({
        ...valid,
        request: { ...valid.request, artifactDigest: "../../not-a-digest" },
      }),
    ProtocolValidationError,
  );
  assert.throws(
    () => parseInvokeEnvelope({ ...valid, request: { ...valid.request, parameters: [] } }),
    ProtocolValidationError,
  );
});

void test("the public registry exposes no loader path and rejects unknown Digest or bad schema", () => {
  const descriptors = listPublicArtifactDescriptors();
  assert.equal(descriptors.length, 5);
  assert.ok(descriptors.every((descriptor) => !("sourceUrl" in descriptor)));
  const echoRegistration = getRegisteredArtifact(FIXTURE_ARTIFACT_DIGESTS.echo);
  assert.equal(echoRegistration?.artifactId, "fixture.echo");
  assert.equal(Object.isFrozen(echoRegistration), true);
  assert.equal(Object.isFrozen(echoRegistration?.allowedQueries), true);

  assert.throws(
    () =>
      validateArtifactInvocation({
        ...echoRequest(),
        artifactDigest: `sha256:${"0".repeat(64)}`,
      }),
    (error: unknown) => hasCode(error, "ARTIFACT_NOT_REGISTERED"),
  );
  assert.throws(
    () => validateArtifactInvocation({ ...echoRequest(), parameters: { message: 7 } }),
    (error: unknown) => hasCode(error, "INVALID_INVOCATION"),
  );
  assert.throws(
    () => validateArtifactInvocation({ ...echoRequest(), timeoutMs: 1_001 }),
    (error: unknown) => hasCode(error, "INVALID_INVOCATION"),
  );
  const queryRegistration = getRegisteredArtifact(FIXTURE_ARTIFACT_DIGESTS.queryObject);
  assert.notEqual(queryRegistration, undefined);
  assert.throws(
    () => validateArtifactResult(required(queryRegistration), { objectRid: "input-shape-only" }),
    (error: unknown) => hasCode(error, "HANDLER_RESULT_INVALID"),
  );
  const capabilityRegistration = getRegisteredArtifact(FIXTURE_ARTIFACT_DIGESTS.capabilityProbe);
  assert.notEqual(capabilityRegistration, undefined);
  assert.throws(
    () => validateArtifactResult(required(capabilityRegistration), { capability: "environment" }),
    (error: unknown) => hasCode(error, "HANDLER_RESULT_INVALID"),
  );
});

void test("JSON object parsing preserves __proto__ as data without prototype mutation", () => {
  const parsed: unknown = JSON.parse('{"__proto__":{"polluted":true},"safe":"value"}');
  const result = requireJsonObject(parsed, "fixture");
  assert.equal(Object.hasOwn(result, "__proto__"), true);
  assert.deepEqual(result.__proto__, { polluted: true });
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

void test("every registered Fixture file matches its immutable SHA-256 key", async () => {
  for (const digest of Object.values(FIXTURE_ARTIFACT_DIGESTS)) {
    const loaded = await loadRegisteredArtifact(digest);
    assert.equal(loaded.registration.digest, digest);
    assert.equal(typeof loaded.module.invoke, "function");
  }
});

function envelope(request: InvocationRequest) {
  return {
    protocol: HANDLER_PROTOCOL,
    version: HANDLER_PROTOCOL_VERSION,
    type: "INVOKE",
    requestId: "request-1",
    request,
  } as const;
}

function echoRequest(): InvocationRequest {
  return {
    artifactDigest: FIXTURE_ARTIFACT_DIGESTS.echo,
    artifactRevision: "rev-1",
    releaseId: "release-1",
    correlationId: "correlation-1",
    timeoutMs: 500,
    parameters: { message: "hello" },
    context: emptyInvocationContext(),
  };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected registered Artifact.");
  return value;
}
