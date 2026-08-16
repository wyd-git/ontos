import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

import {
  CORE_ERROR_CLASSIFICATIONS,
  parseCorrelationId,
  parseErrorEnvelope,
  type CorrelationId,
  type ErrorCategory,
  type ErrorEnvelope,
} from "@ontos/contracts";
import { MetadataApplicationError } from "@ontos/metadata-application";
import {
  GarbageCollectionApplicationError,
  MaterializationAdminError,
  MaterializationIngressError,
  MaterializationQualityError,
  RuntimeCompatibilityError,
  SnapshotGroupCutoverError,
} from "@ontos/materialization-application";

import { RequestBodyError } from "./body.ts";
import { CursorError } from "./cursor.ts";
import { AuthenticationError } from "./oidc.ts";

export class HttpProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;

  constructor(input: {
    readonly status: number;
    readonly code: string;
    readonly message: string;
    readonly category: ErrorCategory;
    readonly retryable?: boolean;
  }) {
    super(input.message);
    this.name = "HttpProblem";
    this.status = input.status;
    this.code = input.code;
    this.category = input.category;
    this.retryable = input.retryable ?? false;
  }
}

export function correlationIdFromHeader(value: string | string[] | undefined): CorrelationId {
  if (typeof value === "string") {
    try {
      return parseCorrelationId(value);
    } catch {
      // Invalid client context is replaced rather than reflected.
    }
  }
  return parseCorrelationId(`corr_${randomUUID()}`);
}

export function writeErrorResponse(
  response: ServerResponse,
  correlationId: CorrelationId,
  error: unknown,
): void {
  const problem = mapProblem(error);
  const envelope = createEnvelope(problem, correlationId);
  writeJson(response, problem.status, envelope, correlationId);
}

export function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  correlationId: CorrelationId,
  headers: Readonly<Record<string, string>> = {},
): void {
  const body = JSON.stringify(value, (_key, candidate: unknown) =>
    typeof candidate === "bigint" ? candidate.toString() : candidate,
  );
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body).toString(),
    "x-correlation-id": correlationId,
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function createEnvelope(problem: HttpProblem, correlationId: CorrelationId): ErrorEnvelope {
  return parseErrorEnvelope({
    schemaVersion: 1,
    error: {
      code: problem.code,
      message: problem.message,
      category: problem.category,
      retryable: problem.retryable,
      details: {},
      correlationId,
    },
  });
}

function mapProblem(error: unknown): HttpProblem {
  if (error instanceof HttpProblem) return error;
  if (error instanceof AuthenticationError) {
    return coreProblem("AUTHENTICATION_REQUIRED", "Administrator authentication is required.");
  }
  if (error instanceof RequestBodyError || error instanceof CursorError) {
    return new HttpProblem({
      status: 400,
      code: "ADMIN_REQUEST_INVALID",
      message: "The administrator request is invalid.",
      category: "validation",
    });
  }
  if (error instanceof MaterializationAdminError) {
    switch (error.code) {
      case "ADMIN_REQUEST_INVALID":
        return invalidAdminRequest();
      case "FORBIDDEN":
      case "OBJECT_NOT_ACCESSIBLE":
        return coreProblem("OBJECT_NOT_ACCESSIBLE", "The requested resource is not accessible.");
      case "OBJECT_VERSION_CONFLICT":
        return coreProblem("OBJECT_VERSION_CONFLICT", "The resource version has changed.");
      case "JOB_NOT_CANCELLABLE":
        return conflictProblem(
          "MATERIALIZATION_JOB_NOT_CANCELLABLE",
          "The materialization Job cannot be cancelled in its current state.",
        );
      case "DEPENDENCY_UNAVAILABLE":
        return coreProblem(
          "DEPENDENCY_UNAVAILABLE",
          "A materialization dependency is temporarily unavailable.",
        );
    }
  }
  if (error instanceof SnapshotGroupCutoverError) {
    switch (error.code) {
      case "CUTOVER_INPUT_INVALID":
        return invalidAdminRequest();
      case "CUTOVER_CONCURRENT_MODIFICATION":
      case "CUTOVER_IDEMPOTENCY_CONFLICT":
        return coreProblem("OBJECT_VERSION_CONFLICT", "The activation context has changed.");
      case "CUTOVER_NOT_READY":
        return conflictProblem(
          "MATERIALIZATION_NOT_READY",
          "The Snapshot Group is not ready for activation.",
        );
      case "CUTOVER_DEPENDENCY_UNAVAILABLE":
        return coreProblem(
          "DEPENDENCY_UNAVAILABLE",
          "A materialization dependency is temporarily unavailable.",
        );
    }
  }
  if (error instanceof RuntimeCompatibilityError) {
    switch (error.code) {
      case "RUNTIME_COMPATIBILITY_INPUT_INVALID":
        return invalidAdminRequest();
      case "RUNTIME_COMPATIBILITY_STALE":
      case "RUNTIME_GENERATION_INCOMPATIBLE":
        return coreProblem("OBJECT_VERSION_CONFLICT", "The runtime compatibility context changed.");
      case "RUNTIME_COMPATIBILITY_DEPENDENCY_UNAVAILABLE":
        return coreProblem(
          "DEPENDENCY_UNAVAILABLE",
          "A materialization dependency is temporarily unavailable.",
        );
    }
  }
  if (error instanceof MaterializationQualityError) {
    switch (error.code) {
      case "FORBIDDEN":
        return coreProblem("OBJECT_NOT_ACCESSIBLE", "The requested resource is not accessible.");
      case "QUALITY_REQUEST_INVALID":
        return invalidAdminRequest();
      case "QUALITY_CONFIRMATION_INVALID":
      case "MATERIALIZATION_ATTEMPT_FENCED":
      case "STAGING_CURRENT_CONFLICT":
        return coreProblem("OBJECT_VERSION_CONFLICT", "The quality context has changed.");
      case "PROVENANCE_INCOMPLETE":
      case "REJECTED_ARTIFACT_TOO_LARGE":
      case "ZERO_OVERLAY_REQUIRED":
        return new HttpProblem({
          status: 422,
          code: "MATERIALIZATION_VALIDATION_FAILED",
          message: "The materialization quality gate did not pass.",
          category: "validation",
        });
      case "DEPENDENCY_UNAVAILABLE":
        return coreProblem(
          "DEPENDENCY_UNAVAILABLE",
          "A materialization dependency is temporarily unavailable.",
        );
    }
  }
  if (error instanceof GarbageCollectionApplicationError) {
    switch (error.code) {
      case "GC_INPUT_INVALID":
        return invalidAdminRequest();
      case "GC_PLAN_STALE":
      case "GC_PROTOCOL_CONFLICT":
        return coreProblem("OBJECT_VERSION_CONFLICT", "The garbage-collection plan has changed.");
      case "GC_REFERENCE_SCAN_INCOMPLETE":
        return conflictProblem(
          "GC_REFERENCE_SCAN_INCOMPLETE",
          "Garbage collection is blocked until every active reference provider is complete.",
        );
      case "GC_DEPENDENCY_UNAVAILABLE":
        return coreProblem(
          "DEPENDENCY_UNAVAILABLE",
          "A materialization dependency is temporarily unavailable.",
        );
    }
  }
  if (error instanceof MaterializationIngressError) {
    switch (error.code) {
      case "ADMIN_REQUEST_INVALID":
        return new HttpProblem({
          status: 400,
          code: error.code,
          message: error.message,
          category: "validation",
        });
      case "OBJECT_NOT_ACCESSIBLE":
        return coreProblem(error.code, error.message);
      case "OBJECT_VERSION_CONFLICT":
        return coreProblem(error.code, error.message);
      case "DEPENDENCY_UNAVAILABLE":
        return coreProblem(error.code, error.message);
      case "SNAPSHOT_CONTENT_MISMATCH":
      case "SNAPSHOT_SCHEMA_INVALID":
        return new HttpProblem({
          status: 422,
          code: error.code,
          message: error.message,
          category: "validation",
        });
    }
  }
  if (error instanceof MetadataApplicationError) {
    switch (error.code) {
      case "INVALID_INPUT":
        return new HttpProblem({
          status: 400,
          code: "ADMIN_REQUEST_INVALID",
          message: "The administrator request is invalid.",
          category: "validation",
        });
      case "FORBIDDEN":
      case "NOT_FOUND":
        return coreProblem("OBJECT_NOT_ACCESSIBLE", "The requested resource is not accessible.");
      case "CONCURRENT_MODIFICATION":
        return coreProblem("OBJECT_VERSION_CONFLICT", "The resource version has changed.");
      case "ALREADY_EXISTS":
      case "INVALID_STATE":
        return new HttpProblem({
          status: 409,
          code: "METADATA_STATE_CONFLICT",
          message: "The metadata operation conflicts with current state.",
          category: "conflict",
        });
      case "STORAGE_FAILURE":
        return coreProblem(
          "DEPENDENCY_UNAVAILABLE",
          "The metadata store is temporarily unavailable.",
        );
    }
  }
  return new HttpProblem({
    status: 500,
    code: "ADMIN_INTERNAL_ERROR",
    message: "The administrator request could not be completed.",
    category: "internal",
  });
}

function invalidAdminRequest(): HttpProblem {
  return new HttpProblem({
    status: 400,
    code: "ADMIN_REQUEST_INVALID",
    message: "The administrator request is invalid.",
    category: "validation",
  });
}

function conflictProblem(code: string, message: string): HttpProblem {
  return new HttpProblem({ status: 409, code, message, category: "conflict" });
}

function coreProblem(code: keyof typeof CORE_ERROR_CLASSIFICATIONS, message: string): HttpProblem {
  const classification = CORE_ERROR_CLASSIFICATIONS[code];
  return new HttpProblem({
    status: classification.httpStatus,
    code,
    message,
    category: classification.category,
    retryable: classification.retryable,
  });
}
