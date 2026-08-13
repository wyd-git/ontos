import { performance } from "node:perf_hooks";

import {
  ArtifactContractError,
  validateArtifactInvocation,
  validateArtifactResult,
} from "./catalog.ts";
import { createRestrictedContext, HandlerBoundaryError } from "./context.ts";
import { installNetworkDeny } from "./network-guard.ts";
import {
  HANDLER_PROTOCOL,
  HANDLER_PROTOCOL_VERSION,
  ProtocolMismatchError,
  ProtocolValidationError,
  parseInvokeEnvelope,
  type HandlerErrorCode,
  type JsonValue,
} from "./protocol.ts";
import { ArtifactDigestMismatchError, loadRegisteredArtifact } from "./registry.ts";

installNetworkDeny();

let busy = false;

process.on("message", (message: unknown) => {
  void handleMessage(message);
});

send({
  protocol: HANDLER_PROTOCOL,
  version: HANDLER_PROTOCOL_VERSION,
  type: "READY",
  pid: process.pid,
});

async function handleMessage(message: unknown): Promise<void> {
  const startedAt = performance.now();
  const candidateRequestId = safeRequestId(message);
  if (busy) {
    sendFailure(candidateRequestId, "INVALID_INVOCATION", startedAt);
    return;
  }
  busy = true;
  try {
    const envelope = parseInvokeEnvelope(message);
    const registration = validateArtifactInvocation(envelope.request);
    const loaded = await loadRegisteredArtifact(envelope.request.artifactDigest);
    const context = createRestrictedContext(registration, envelope.request.context);
    const result = await loaded.module.invoke(context, envelope.request.parameters);
    sendSuccess(envelope.requestId, validateArtifactResult(registration, result), startedAt);
  } catch (error) {
    sendFailure(candidateRequestId, classifyError(error), startedAt);
  } finally {
    busy = false;
  }
}

function sendSuccess(requestId: string, result: JsonValue, startedAt: number): void {
  send({
    protocol: HANDLER_PROTOCOL,
    version: HANDLER_PROTOCOL_VERSION,
    type: "RESULT",
    requestId,
    ok: true,
    result,
    durationMs: elapsed(startedAt),
  });
}

function sendFailure(requestId: string, code: HandlerErrorCode, startedAt: number): void {
  send({
    protocol: HANDLER_PROTOCOL,
    version: HANDLER_PROTOCOL_VERSION,
    type: "RESULT",
    requestId,
    ok: false,
    error: { code, message: safeErrorMessage(code) },
    durationMs: elapsed(startedAt),
  });
}

function send(message: object): void {
  if (process.send === undefined) process.exit(70);
  process.send(message);
}

function classifyError(error: unknown): HandlerErrorCode {
  if (error instanceof HandlerBoundaryError) return error.code;
  if (error instanceof ArtifactContractError) return error.code;
  if (error instanceof ArtifactDigestMismatchError) return error.code;
  if (error instanceof ProtocolMismatchError) return "PROTOCOL_MISMATCH";
  if (error instanceof ProtocolValidationError) return "INVALID_INVOCATION";
  if (isNodePermissionError(error)) return "SYSTEM_CAPABILITY_DENIED";
  return "HANDLER_EXECUTION_FAILED";
}

function isNodePermissionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_ACCESS_DENIED"
  );
}

function safeRequestId(message: unknown): string {
  if (
    typeof message === "object" &&
    message !== null &&
    "requestId" in message &&
    typeof message.requestId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(message.requestId)
  ) {
    return message.requestId;
  }
  return "invalid-request";
}

function elapsed(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function safeErrorMessage(code: HandlerErrorCode): string {
  const messages: Record<HandlerErrorCode, string> = {
    ARTIFACT_DIGEST_MISMATCH: "Registered Artifact integrity verification failed.",
    ARTIFACT_NOT_REGISTERED: "Artifact Digest is not registered in this Host release.",
    HANDLER_EXECUTION_FAILED: "Artifact execution failed.",
    HANDLER_RESULT_INVALID: "Artifact result failed registered schema validation.",
    HANDLER_TIMEOUT: "Artifact exceeded its hard execution timeout.",
    HOST_EXITED: "Handler Host exited before returning a result.",
    INVALID_INVOCATION: "Handler invocation failed protocol or schema validation.",
    NETWORK_ACCESS_DENIED: "Handler Host network access is disabled.",
    PROTOCOL_MISMATCH: "Handler RPC protocol or version does not match.",
    QUERY_LIMIT_EXCEEDED: "Artifact exceeded its Query read budget.",
    QUERY_NOT_DECLARED: "Artifact attempted an undeclared Query.",
    READ_SET_VIOLATION: "Artifact attempted to read outside the authorized Read Set.",
    SYSTEM_CAPABILITY_DENIED: "Handler Host system capability is disabled.",
  };
  return messages[code];
}
