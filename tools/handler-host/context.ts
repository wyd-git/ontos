import type {
  ArtifactQuery,
  ArtifactQueryResult,
  RestrictedHandlerContext,
} from "./artifact-api.ts";
import type { RegisteredArtifact } from "./catalog.ts";
import {
  ProtocolValidationError,
  requireExactKeys,
  requireRecord,
  type HandlerErrorCode,
  type InvocationContextData,
  type JsonValue,
} from "./protocol.ts";

export class HandlerBoundaryError extends Error {
  readonly code: HandlerErrorCode;

  constructor(code: HandlerErrorCode, message: string) {
    super(message);
    this.name = "HandlerBoundaryError";
    this.code = code;
  }
}

export function createRestrictedContext(
  registration: RegisteredArtifact,
  contextData: InvocationContextData,
): RestrictedHandlerContext {
  const manifestQueries = new Set(registration.allowedQueries);
  const declaredQueries = new Set(contextData.declaredQueries);
  const maximumReads = Math.min(registration.maximumReads, contextData.maximumReads);
  let readCount = 0;

  function executeQuery(value: ArtifactQuery): ArtifactQueryResult {
    const request = parseArtifactQuery(value);
    if (!manifestQueries.has(request.queryName) || !declaredQueries.has(request.queryName)) {
      throw new HandlerBoundaryError(
        "QUERY_NOT_DECLARED",
        "Artifact attempted a Query that was not declared for this invocation.",
      );
    }
    const readSetEntry = contextData.readSet.find(
      (entry) => entry.queryName === request.queryName && entry.objectRid === request.objectRid,
    );
    if (readSetEntry === undefined) {
      throw new HandlerBoundaryError(
        "READ_SET_VIOLATION",
        "Artifact attempted to read an object outside the authorized Read Set.",
      );
    }
    const allowedProperties = new Set(readSetEntry.properties);
    if (request.properties.some((property) => !allowedProperties.has(property))) {
      throw new HandlerBoundaryError(
        "READ_SET_VIOLATION",
        "Artifact attempted to read a Property outside the authorized Read Set.",
      );
    }
    readCount += 1;
    if (readCount > maximumReads) {
      throw new HandlerBoundaryError(
        "QUERY_LIMIT_EXCEEDED",
        "Artifact exceeded its registered Query read budget.",
      );
    }
    const fixture = contextData.queryResults.find(
      (entry) => entry.queryName === request.queryName && entry.objectRid === request.objectRid,
    );
    if (fixture === undefined) {
      throw new HandlerBoundaryError(
        "READ_SET_VIOLATION",
        "Authorized Query Result is unavailable for this invocation.",
      );
    }
    const projectedProperties: Record<string, JsonValue> = {};
    for (const property of request.properties) {
      const propertyValue = fixture.properties[property];
      if (propertyValue === undefined) {
        throw new HandlerBoundaryError(
          "READ_SET_VIOLATION",
          "Authorized Query Result does not contain a requested Property.",
        );
      }
      projectedProperties[property] = cloneJson(propertyValue);
    }
    return deepFreeze({
      objectRid: fixture.objectRid,
      objectVersion: fixture.objectVersion,
      properties: projectedProperties,
    });
  }

  return Object.freeze({
    query(value: ArtifactQuery): Promise<ArtifactQueryResult> {
      return Promise.resolve().then(() => executeQuery(value));
    },
  });
}

function parseArtifactQuery(value: unknown): ArtifactQuery {
  try {
    const request = requireRecord(value, "Artifact Query");
    requireExactKeys(request, ["queryName", "objectRid", "properties"]);
    if (
      typeof request.queryName !== "string" ||
      request.queryName.length === 0 ||
      typeof request.objectRid !== "string" ||
      request.objectRid.length === 0 ||
      !Array.isArray(request.properties) ||
      request.properties.length === 0 ||
      request.properties.some(
        (property) => typeof property !== "string" || property.length === 0,
      ) ||
      new Set(request.properties).size !== request.properties.length
    ) {
      throw new ProtocolValidationError("Artifact Query fields are invalid.");
    }
    return {
      queryName: request.queryName,
      objectRid: request.objectRid,
      properties: request.properties as readonly string[],
    };
  } catch {
    throw new HandlerBoundaryError(
      "INVALID_INVOCATION",
      "Artifact supplied an invalid Query request.",
    );
  }
}

function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Readonly<Record<string, unknown>>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export function emptyInvocationContext(): InvocationContextData {
  return {
    declaredQueries: [],
    maximumReads: 1,
    readSet: [],
    queryResults: [],
  };
}
