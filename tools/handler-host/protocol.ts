export const HANDLER_PROTOCOL = "ontos.handler-host" as const;
export const HANDLER_PROTOCOL_VERSION = 1 as const;
export const MAX_RPC_BYTES = 256 * 1024;
export const MAX_HANDLER_TIMEOUT_MS = 10_000;
export const MAX_HANDLER_READS = 1_000;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface ReadSetEntry {
  readonly queryName: string;
  readonly objectRid: string;
  readonly properties: readonly string[];
}

export interface QueryResultFixture {
  readonly queryName: string;
  readonly objectRid: string;
  readonly objectVersion: string;
  readonly properties: JsonObject;
}

export interface InvocationContextData {
  readonly declaredQueries: readonly string[];
  readonly maximumReads: number;
  readonly readSet: readonly ReadSetEntry[];
  readonly queryResults: readonly QueryResultFixture[];
}

export interface InvocationRequest {
  readonly artifactDigest: string;
  readonly artifactRevision: string;
  readonly releaseId: string;
  readonly correlationId: string;
  readonly timeoutMs: number;
  readonly parameters: JsonObject;
  readonly context: InvocationContextData;
}

export interface InvokeEnvelope {
  readonly protocol: typeof HANDLER_PROTOCOL;
  readonly version: typeof HANDLER_PROTOCOL_VERSION;
  readonly type: "INVOKE";
  readonly requestId: string;
  readonly request: InvocationRequest;
}

export interface ReadyEnvelope {
  readonly protocol: typeof HANDLER_PROTOCOL;
  readonly version: typeof HANDLER_PROTOCOL_VERSION;
  readonly type: "READY";
  readonly pid: number;
}

export type HandlerErrorCode =
  | "ARTIFACT_DIGEST_MISMATCH"
  | "ARTIFACT_NOT_REGISTERED"
  | "HANDLER_EXECUTION_FAILED"
  | "HANDLER_RESULT_INVALID"
  | "HANDLER_TIMEOUT"
  | "HOST_EXITED"
  | "INVALID_INVOCATION"
  | "NETWORK_ACCESS_DENIED"
  | "PROTOCOL_MISMATCH"
  | "QUERY_LIMIT_EXCEEDED"
  | "QUERY_NOT_DECLARED"
  | "READ_SET_VIOLATION"
  | "SYSTEM_CAPABILITY_DENIED";

export type ResultEnvelope =
  | {
      readonly protocol: typeof HANDLER_PROTOCOL;
      readonly version: typeof HANDLER_PROTOCOL_VERSION;
      readonly type: "RESULT";
      readonly requestId: string;
      readonly ok: true;
      readonly result: JsonValue;
      readonly durationMs: number;
    }
  | {
      readonly protocol: typeof HANDLER_PROTOCOL;
      readonly version: typeof HANDLER_PROTOCOL_VERSION;
      readonly type: "RESULT";
      readonly requestId: string;
      readonly ok: false;
      readonly error: {
        readonly code: HandlerErrorCode;
        readonly message: string;
      };
      readonly durationMs: number;
    };

export type HostEnvelope = ReadyEnvelope | ResultEnvelope;

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const errorCodes = new Set<HandlerErrorCode>([
  "ARTIFACT_DIGEST_MISMATCH",
  "ARTIFACT_NOT_REGISTERED",
  "HANDLER_EXECUTION_FAILED",
  "HANDLER_RESULT_INVALID",
  "HANDLER_TIMEOUT",
  "HOST_EXITED",
  "INVALID_INVOCATION",
  "NETWORK_ACCESS_DENIED",
  "PROTOCOL_MISMATCH",
  "QUERY_LIMIT_EXCEEDED",
  "QUERY_NOT_DECLARED",
  "READ_SET_VIOLATION",
  "SYSTEM_CAPABILITY_DENIED",
]);

export class ProtocolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

export class ProtocolMismatchError extends ProtocolValidationError {
  constructor() {
    super("Handler protocol or version does not match.");
    this.name = "ProtocolMismatchError";
  }
}

export function parseInvokeEnvelope(value: unknown): InvokeEnvelope {
  assertRpcSize(value);
  const envelope = requireRecord(value, "RPC envelope");
  requireExactKeys(envelope, ["protocol", "version", "type", "requestId", "request"]);
  if (envelope.protocol !== HANDLER_PROTOCOL || envelope.version !== HANDLER_PROTOCOL_VERSION) {
    throw new ProtocolMismatchError();
  }
  if (envelope.type !== "INVOKE") {
    throw new ProtocolValidationError("RPC message type must be INVOKE.");
  }
  return {
    protocol: HANDLER_PROTOCOL,
    version: HANDLER_PROTOCOL_VERSION,
    type: "INVOKE",
    requestId: requireIdentifier(envelope.requestId, "requestId"),
    request: parseInvocationRequest(envelope.request),
  };
}

export function parseInvocationRequest(value: unknown): InvocationRequest {
  const request = requireRecord(value, "invocation request");
  requireExactKeys(request, [
    "artifactDigest",
    "artifactRevision",
    "releaseId",
    "correlationId",
    "timeoutMs",
    "parameters",
    "context",
  ]);
  const artifactDigest = requireString(request.artifactDigest, "artifactDigest", 72);
  if (!digestPattern.test(artifactDigest)) {
    throw new ProtocolValidationError("artifactDigest must be a lowercase SHA-256 digest.");
  }
  return {
    artifactDigest,
    artifactRevision: requireIdentifier(request.artifactRevision, "artifactRevision"),
    releaseId: requireIdentifier(request.releaseId, "releaseId"),
    correlationId: requireIdentifier(request.correlationId, "correlationId"),
    timeoutMs: requireInteger(request.timeoutMs, "timeoutMs", 1, MAX_HANDLER_TIMEOUT_MS),
    parameters: requireJsonObject(request.parameters, "parameters"),
    context: parseContext(request.context),
  };
}

export function parseHostEnvelope(value: unknown): HostEnvelope {
  assertRpcSize(value);
  const envelope = requireRecord(value, "host envelope");
  if (envelope.protocol !== HANDLER_PROTOCOL || envelope.version !== HANDLER_PROTOCOL_VERSION) {
    throw new ProtocolMismatchError();
  }
  if (envelope.type === "READY") {
    requireExactKeys(envelope, ["protocol", "version", "type", "pid"]);
    return {
      protocol: HANDLER_PROTOCOL,
      version: HANDLER_PROTOCOL_VERSION,
      type: "READY",
      pid: requireInteger(envelope.pid, "pid", 1, Number.MAX_SAFE_INTEGER),
    };
  }
  if (envelope.type !== "RESULT") {
    throw new ProtocolValidationError("Host message type is unknown.");
  }
  const ok = envelope.ok;
  if (ok === true) {
    requireExactKeys(envelope, [
      "protocol",
      "version",
      "type",
      "requestId",
      "ok",
      "result",
      "durationMs",
    ]);
    return {
      protocol: HANDLER_PROTOCOL,
      version: HANDLER_PROTOCOL_VERSION,
      type: "RESULT",
      requestId: requireIdentifier(envelope.requestId, "requestId"),
      ok: true,
      result: requireJsonValue(envelope.result, "result"),
      durationMs: requireFiniteNumber(envelope.durationMs, "durationMs", 0),
    };
  }
  if (ok !== false) throw new ProtocolValidationError("Host result must contain boolean ok.");
  requireExactKeys(envelope, [
    "protocol",
    "version",
    "type",
    "requestId",
    "ok",
    "error",
    "durationMs",
  ]);
  const error = requireRecord(envelope.error, "error");
  requireExactKeys(error, ["code", "message"]);
  const code = requireString(error.code, "error.code", 64);
  if (!errorCodes.has(code as HandlerErrorCode)) {
    throw new ProtocolValidationError("Host returned an unknown error code.");
  }
  return {
    protocol: HANDLER_PROTOCOL,
    version: HANDLER_PROTOCOL_VERSION,
    type: "RESULT",
    requestId: requireIdentifier(envelope.requestId, "requestId"),
    ok: false,
    error: {
      code: code as HandlerErrorCode,
      message: requireString(error.message, "error.message", 256),
    },
    durationMs: requireFiniteNumber(envelope.durationMs, "durationMs", 0),
  };
}

export function requireJsonObject(value: unknown, label: string): JsonObject {
  requireRecord(value, label);
  return requireJsonValue(value, label, 0, new Set()) as JsonObject;
}

export function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ProtocolValidationError(
      `Unexpected fields; expected exactly ${wanted.join(", ") || "no fields"}.`,
    );
  }
}

export function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(`${label} must be an object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProtocolValidationError(`${label} must be a plain object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function requireString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new ProtocolValidationError(`${label} must be a non-empty bounded string.`);
  }
  return value;
}

function parseContext(value: unknown): InvocationContextData {
  const context = requireRecord(value, "context");
  requireExactKeys(context, ["declaredQueries", "maximumReads", "readSet", "queryResults"]);
  const declaredQueries = requireUniqueStringArray(context.declaredQueries, "declaredQueries", 32);
  const readSet = requireArray(context.readSet, "readSet", MAX_HANDLER_READS).map((entry) =>
    parseReadSetEntry(entry),
  );
  assertUniqueComposite(
    readSet.map((entry) => [entry.queryName, entry.objectRid]),
    "readSet",
  );
  const queryResults = requireArray(context.queryResults, "queryResults", MAX_HANDLER_READS).map(
    (entry) => parseQueryResult(entry),
  );
  assertUniqueComposite(
    queryResults.map((entry) => [entry.queryName, entry.objectRid]),
    "queryResults",
  );
  return {
    declaredQueries,
    maximumReads: requireInteger(context.maximumReads, "maximumReads", 1, MAX_HANDLER_READS),
    readSet,
    queryResults,
  };
}

function parseReadSetEntry(value: unknown): ReadSetEntry {
  const entry = requireRecord(value, "readSet entry");
  requireExactKeys(entry, ["queryName", "objectRid", "properties"]);
  return {
    queryName: requireIdentifier(entry.queryName, "readSet.queryName"),
    objectRid: requireIdentifier(entry.objectRid, "readSet.objectRid"),
    properties: requireUniqueStringArray(entry.properties, "readSet.properties", 256),
  };
}

function parseQueryResult(value: unknown): QueryResultFixture {
  const entry = requireRecord(value, "query result");
  requireExactKeys(entry, ["queryName", "objectRid", "objectVersion", "properties"]);
  return {
    queryName: requireIdentifier(entry.queryName, "queryResult.queryName"),
    objectRid: requireIdentifier(entry.objectRid, "queryResult.objectRid"),
    objectVersion: requireIdentifier(entry.objectVersion, "queryResult.objectVersion"),
    properties: requireJsonObject(entry.properties, "queryResult.properties"),
  };
}

function requireJsonValue(
  value: unknown,
  label: string,
  depth = 0,
  ancestors = new Set<object>(),
): JsonValue {
  if (depth > 20) throw new ProtocolValidationError(`${label} exceeds maximum JSON depth.`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new ProtocolValidationError(`${label} contains non-finite number.`);
    return value;
  }
  if (typeof value !== "object") {
    throw new ProtocolValidationError(`${label} must contain JSON values only.`);
  }
  if (ancestors.has(value)) throw new ProtocolValidationError(`${label} contains a cycle.`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 2_000) throw new ProtocolValidationError(`${label} array is too large.`);
      return value.map((item, index) =>
        requireJsonValue(item, `${label}[${String(index)}]`, depth + 1, ancestors),
      );
    }
    const record = requireRecord(value, label);
    const keys = Object.keys(record);
    if (keys.length > 2_000) throw new ProtocolValidationError(`${label} object is too large.`);
    const result: Record<string, JsonValue> = {};
    for (const key of keys) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: requireJsonValue(record[key], `${label}.${key}`, depth + 1, ancestors),
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function requireIdentifier(value: unknown, label: string): string {
  const candidate = requireString(value, label, 128);
  if (!identifierPattern.test(candidate)) {
    throw new ProtocolValidationError(`${label} contains unsupported characters.`);
  }
  return candidate;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ProtocolValidationError(`${label} must be a safe integer in range.`);
  }
  return value as number;
}

function requireFiniteNumber(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new ProtocolValidationError(`${label} must be a finite number.`);
  }
  return value;
}

function requireArray(value: unknown, label: string, maximumLength: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw new ProtocolValidationError(`${label} must be a bounded array.`);
  }
  return value;
}

function requireUniqueStringArray(
  value: unknown,
  label: string,
  maximumLength: number,
): readonly string[] {
  const result = requireArray(value, label, maximumLength).map((entry) =>
    requireIdentifier(entry, label),
  );
  if (new Set(result).size !== result.length) {
    throw new ProtocolValidationError(`${label} must not contain duplicates.`);
  }
  return result;
}

function assertUniqueComposite(values: readonly (readonly string[])[], label: string): void {
  const encoded = values.map((value) => JSON.stringify(value));
  if (new Set(encoded).size !== encoded.length) {
    throw new ProtocolValidationError(`${label} must not contain duplicate entries.`);
  }
}

function assertRpcSize(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ProtocolValidationError("RPC message must be JSON serializable.");
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_RPC_BYTES) {
    throw new ProtocolValidationError("RPC message exceeds the 256 KiB limit.");
  }
}
