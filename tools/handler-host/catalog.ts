import {
  MAX_HANDLER_READS,
  MAX_HANDLER_TIMEOUT_MS,
  ProtocolValidationError,
  requireExactKeys,
  requireJsonObject,
  requireRecord,
  requireString,
  type InvocationRequest,
  type JsonValue,
} from "./protocol.ts";

export const FIXTURE_ARTIFACT_DIGESTS = {
  capabilityProbe: "sha256:5353a0c246fbcaf28f7f48e8a14f5a644ee16803fdfa3a16bec5e7c91d373bc6",
  echo: "sha256:f02bc21ee3da20745ccafb885224866ee4ba273b8e5e2ef1e6bd323310c52868",
  infiniteLoop: "sha256:983e78eeb8faf52ae6ba365954323d92d9891b6c43205622abf2936e4934faa4",
  queryObject: "sha256:59e0b77607f51778b3cef0dc206772c05d544010d5f8928980a40584fc5477ed",
  throwError: "sha256:bb7966b510d51fad222d463834266189724ea031a7f0426ba4e90c77f0d0384e",
} as const;

type ArtifactSchema =
  | "capability-probe-input.v1"
  | "capability-probe-output.v1"
  | "echo.v1"
  | "empty.v1"
  | "query-object-input.v1"
  | "query-object-output.v1";

export interface PublicArtifactDescriptor {
  readonly artifactId: string;
  readonly artifactRevision: string;
  readonly digest: string;
  readonly kind: "FUNCTION";
  readonly inputSchema: ArtifactSchema;
  readonly outputSchema: ArtifactSchema;
  readonly allowedQueries: readonly string[];
  readonly maximumReads: number;
  readonly maximumTimeoutMs: number;
}

export interface RegisteredArtifact extends PublicArtifactDescriptor {
  readonly sourceUrl: string;
}

const registrations: readonly RegisteredArtifact[] = [
  {
    artifactId: "fixture.capability-probe",
    artifactRevision: "rev-1",
    digest: FIXTURE_ARTIFACT_DIGESTS.capabilityProbe,
    kind: "FUNCTION",
    inputSchema: "capability-probe-input.v1",
    outputSchema: "capability-probe-output.v1",
    allowedQueries: [],
    maximumReads: 1,
    maximumTimeoutMs: 1_000,
    sourceUrl: new URL("./artifacts/capability-probe.ts", import.meta.url).href,
  },
  {
    artifactId: "fixture.echo",
    artifactRevision: "rev-1",
    digest: FIXTURE_ARTIFACT_DIGESTS.echo,
    kind: "FUNCTION",
    inputSchema: "echo.v1",
    outputSchema: "echo.v1",
    allowedQueries: [],
    maximumReads: 1,
    maximumTimeoutMs: 1_000,
    sourceUrl: new URL("./artifacts/echo.ts", import.meta.url).href,
  },
  {
    artifactId: "fixture.infinite-loop",
    artifactRevision: "rev-1",
    digest: FIXTURE_ARTIFACT_DIGESTS.infiniteLoop,
    kind: "FUNCTION",
    inputSchema: "empty.v1",
    outputSchema: "empty.v1",
    allowedQueries: [],
    maximumReads: 1,
    maximumTimeoutMs: 1_000,
    sourceUrl: new URL("./artifacts/infinite-loop.ts", import.meta.url).href,
  },
  {
    artifactId: "fixture.query-object",
    artifactRevision: "rev-1",
    digest: FIXTURE_ARTIFACT_DIGESTS.queryObject,
    kind: "FUNCTION",
    inputSchema: "query-object-input.v1",
    outputSchema: "query-object-output.v1",
    allowedQueries: ["object.get"],
    maximumReads: 2,
    maximumTimeoutMs: 1_000,
    sourceUrl: new URL("./artifacts/query-object.ts", import.meta.url).href,
  },
  {
    artifactId: "fixture.throw-error",
    artifactRevision: "rev-1",
    digest: FIXTURE_ARTIFACT_DIGESTS.throwError,
    kind: "FUNCTION",
    inputSchema: "empty.v1",
    outputSchema: "empty.v1",
    allowedQueries: [],
    maximumReads: 1,
    maximumTimeoutMs: 1_000,
    sourceUrl: new URL("./artifacts/throw-error.ts", import.meta.url).href,
  },
];

for (const registration of registrations) {
  Object.freeze(registration.allowedQueries);
  Object.freeze(registration);
}
Object.freeze(registrations);

const registrationsByDigest = new Map(
  registrations.map((registration) => [registration.digest, registration]),
);

export class ArtifactContractError extends Error {
  readonly code: "ARTIFACT_NOT_REGISTERED" | "HANDLER_RESULT_INVALID" | "INVALID_INVOCATION";

  constructor(
    code: "ARTIFACT_NOT_REGISTERED" | "HANDLER_RESULT_INVALID" | "INVALID_INVOCATION",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactContractError";
    this.code = code;
  }
}

export function getRegisteredArtifact(digest: string): RegisteredArtifact | undefined {
  return registrationsByDigest.get(digest);
}

export function listPublicArtifactDescriptors(): readonly PublicArtifactDescriptor[] {
  return registrations.map((registration) => ({
    artifactId: registration.artifactId,
    artifactRevision: registration.artifactRevision,
    digest: registration.digest,
    kind: registration.kind,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    allowedQueries: registration.allowedQueries,
    maximumReads: registration.maximumReads,
    maximumTimeoutMs: registration.maximumTimeoutMs,
  }));
}

export function validateArtifactInvocation(request: InvocationRequest): RegisteredArtifact {
  const registration = getRegisteredArtifact(request.artifactDigest);
  if (registration === undefined) {
    throw new ArtifactContractError(
      "ARTIFACT_NOT_REGISTERED",
      "The requested Artifact Digest is not registered in this Host release.",
    );
  }
  if (request.artifactRevision !== registration.artifactRevision) {
    throw new ArtifactContractError(
      "INVALID_INVOCATION",
      "Artifact Revision does not match the registered Digest.",
    );
  }
  if (
    request.timeoutMs > registration.maximumTimeoutMs ||
    request.timeoutMs > MAX_HANDLER_TIMEOUT_MS
  ) {
    throw new ArtifactContractError(
      "INVALID_INVOCATION",
      "Invocation timeout exceeds the registered Artifact budget.",
    );
  }
  if (
    request.context.maximumReads > registration.maximumReads ||
    request.context.maximumReads > MAX_HANDLER_READS
  ) {
    throw new ArtifactContractError(
      "INVALID_INVOCATION",
      "Invocation read budget exceeds the registered Artifact budget.",
    );
  }
  const allowedQueries = new Set(registration.allowedQueries);
  if (request.context.declaredQueries.some((queryName) => !allowedQueries.has(queryName))) {
    throw new ArtifactContractError(
      "INVALID_INVOCATION",
      "Invocation declares a Query outside the registered Artifact capability.",
    );
  }
  const declaredQueries = new Set(request.context.declaredQueries);
  if (
    request.context.readSet.some((entry) => !declaredQueries.has(entry.queryName)) ||
    request.context.queryResults.some((entry) => !declaredQueries.has(entry.queryName))
  ) {
    throw new ArtifactContractError(
      "INVALID_INVOCATION",
      "Read Set and Query Results must use a declared Query.",
    );
  }
  validateResultCoverage(request);
  try {
    validateSchema(registration.inputSchema, request.parameters);
  } catch (error) {
    throw new ArtifactContractError(
      "INVALID_INVOCATION",
      error instanceof Error ? error.message : "Artifact parameters are invalid.",
    );
  }
  return registration;
}

export function validateArtifactResult(
  registration: RegisteredArtifact,
  value: unknown,
): JsonValue {
  try {
    const jsonValue = requireJsonValueForResult(value);
    validateSchema(registration.outputSchema, jsonValue);
    return jsonValue;
  } catch {
    throw new ArtifactContractError(
      "HANDLER_RESULT_INVALID",
      "Artifact result does not match its registered output schema.",
    );
  }
}

function validateSchema(schema: ArtifactSchema, value: unknown): void {
  const record = requireRecord(value, schema);
  switch (schema) {
    case "echo.v1": {
      requireExactKeys(record, ["message"]);
      requireString(record.message, "message", 256);
      return;
    }
    case "empty.v1":
      requireExactKeys(record, []);
      return;
    case "query-object-input.v1":
      requireExactKeys(record, ["objectRid"]);
      requireString(record.objectRid, "objectRid", 128);
      return;
    case "query-object-output.v1":
      requireExactKeys(record, ["objectRid", "objectVersion", "properties"]);
      requireString(record.objectRid, "objectRid", 128);
      requireString(record.objectVersion, "objectVersion", 128);
      requireJsonObject(record.properties, "properties");
      return;
    case "capability-probe-input.v1":
      validateCapabilityProbeInput(record);
      return;
    case "capability-probe-output.v1":
      validateCapabilityProbeOutput(record);
  }
}

function validateCapabilityProbeInput(record: Readonly<Record<string, unknown>>): void {
  requireExactKeys(record, ["capability"]);
  if (
    record.capability !== "environment" &&
    record.capability !== "networkFetch" &&
    record.capability !== "networkHttp" &&
    record.capability !== "networkHttp2" &&
    record.capability !== "networkTcp" &&
    record.capability !== "networkTls" &&
    record.capability !== "networkUdp" &&
    record.capability !== "networkDns" &&
    record.capability !== "filesystemRead" &&
    record.capability !== "filesystemWrite" &&
    record.capability !== "childProcess" &&
    record.capability !== "worker"
  ) {
    throw new ProtocolValidationError("capability is not registered.");
  }
}

function validateCapabilityProbeOutput(record: Readonly<Record<string, unknown>>): void {
  if (Object.keys(record).includes("present")) {
    requireExactKeys(record, ["present"]);
    if (
      !Array.isArray(record.present) ||
      record.present.some((entry) => typeof entry !== "string")
    ) {
      throw new ProtocolValidationError("present must be a string array.");
    }
    return;
  }
  for (const flag of ["read", "reached", "spawnedWorker", "wrote"] as const) {
    if (Object.keys(record).includes(flag)) {
      requireExactKeys(record, [flag]);
      if (record[flag] !== true) throw new ProtocolValidationError(`${flag} must be true.`);
      return;
    }
  }
  requireExactKeys(record, ["exitCode"]);
  if (!Number.isSafeInteger(record.exitCode)) {
    throw new ProtocolValidationError("exitCode must be a safe integer.");
  }
}

function validateResultCoverage(request: InvocationRequest): void {
  for (const result of request.context.queryResults) {
    const readSetEntry = request.context.readSet.find(
      (entry) => entry.queryName === result.queryName && entry.objectRid === result.objectRid,
    );
    if (readSetEntry === undefined) {
      throw new ArtifactContractError(
        "INVALID_INVOCATION",
        "Query Results cannot exceed the authorized Read Set.",
      );
    }
    const allowedProperties = new Set(readSetEntry.properties);
    if (Object.keys(result.properties).some((property) => !allowedProperties.has(property))) {
      throw new ArtifactContractError(
        "INVALID_INVOCATION",
        "Query Results contain a Property outside the authorized Read Set.",
      );
    }
  }
}

function requireJsonValueForResult(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => requireJsonValueForResult(entry));
  return requireJsonObject(value, "result");
}
