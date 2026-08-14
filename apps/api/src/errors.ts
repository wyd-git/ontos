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
