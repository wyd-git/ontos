import { failContract } from "./error.ts";
import type { ErrorCategory } from "./error-envelope.ts";

export interface CoreErrorClassification {
  readonly httpStatus: number;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
}

export const CORE_ERROR_CLASSIFICATIONS = Object.freeze({
  INVALID_QUERY_AST: Object.freeze({
    httpStatus: 400,
    category: "validation",
    retryable: false,
  }),
  PROPERTY_NOT_QUERYABLE: Object.freeze({
    httpStatus: 400,
    category: "validation",
    retryable: false,
  }),
  ACTION_PARAMETER_INVALID: Object.freeze({
    httpStatus: 400,
    category: "validation",
    retryable: false,
  }),
  AUTHENTICATION_REQUIRED: Object.freeze({
    httpStatus: 401,
    category: "authentication",
    retryable: false,
  }),
  RESOURCE_FORBIDDEN: Object.freeze({
    httpStatus: 403,
    category: "authorization",
    retryable: false,
  }),
  OBJECT_NOT_ACCESSIBLE: Object.freeze({
    httpStatus: 404,
    category: "not_found",
    retryable: false,
  }),
  OBJECT_VERSION_CONFLICT: Object.freeze({
    httpStatus: 409,
    category: "conflict",
    retryable: false,
  }),
  PREFLIGHT_STALE: Object.freeze({
    httpStatus: 409,
    category: "conflict",
    retryable: false,
  }),
  IDEMPOTENCY_KEY_REUSED: Object.freeze({
    httpStatus: 409,
    category: "conflict",
    retryable: false,
  }),
  CURSOR_CONTEXT_CHANGED: Object.freeze({
    httpStatus: 409,
    category: "conflict",
    retryable: false,
  }),
  ONTOLOGY_COMPATIBILITY_ERROR: Object.freeze({
    httpStatus: 409,
    category: "conflict",
    retryable: false,
  }),
  SUBMISSION_CRITERIA_FAILED: Object.freeze({
    httpStatus: 422,
    category: "validation",
    retryable: false,
  }),
  MATERIALIZATION_VALIDATION_FAILED: Object.freeze({
    httpStatus: 422,
    category: "validation",
    retryable: false,
  }),
  RATE_LIMITED: Object.freeze({
    httpStatus: 429,
    category: "rate_limit",
    retryable: true,
  }),
  SNAPSHOT_CUTOVER_IN_PROGRESS: Object.freeze({
    httpStatus: 503,
    category: "unavailable",
    retryable: true,
  }),
  DEPENDENCY_UNAVAILABLE: Object.freeze({
    httpStatus: 503,
    category: "dependency",
    retryable: true,
  }),
} as const satisfies Readonly<Record<string, CoreErrorClassification>>);

export type CoreErrorCode = keyof typeof CORE_ERROR_CLASSIFICATIONS;

export function assertCoreErrorClassification(
  code: string,
  category: ErrorCategory,
  retryable: boolean,
  path: string,
): void {
  if (!Object.hasOwn(CORE_ERROR_CLASSIFICATIONS, code)) return;
  const expected = CORE_ERROR_CLASSIFICATIONS[code as CoreErrorCode];
  if (category !== expected.category || retryable !== expected.retryable) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Core error classification does not match its stable contract.",
      path,
    );
  }
}
