import { assertCoreErrorClassification } from "./core-error-codes.ts";
import {
  cloneRestrictedJsonObject,
  requireBoolean,
  requireObjectShape,
  requireOneOf,
  requirePlainRecord,
  requireString,
  type ContractJsonValue,
  type UnknownFieldMode,
} from "./internal.ts";
import {
  parseCorrelationId,
  parseSchemaVersion,
  type ContractSchemaVersion,
  type CorrelationId,
} from "./scalars.ts";

export type ErrorCategory =
  | "authentication"
  | "authorization"
  | "conflict"
  | "dependency"
  | "internal"
  | "not_found"
  | "rate_limit"
  | "unavailable"
  | "validation";

export interface ErrorEnvelope {
  readonly schemaVersion: ContractSchemaVersion;
  readonly error: Readonly<{
    code: string;
    message: string;
    category: ErrorCategory;
    retryable: boolean;
    details: Readonly<Record<string, ContractJsonValue>>;
    correlationId: CorrelationId;
  }>;
}

export const ERROR_DETAILS_MAXIMUM_BYTES = 16_384;
export const ERROR_DETAILS_MAXIMUM_DEPTH = 8;
export const ERROR_DETAILS_MAXIMUM_NODES = 1_000;
export const ERROR_MESSAGE_MAXIMUM_LENGTH = 2_048;
export const ERROR_MESSAGE_PATTERN = "^[^\\u0000-\\u001F\\u007F]+$";
export const ERROR_CODE_MINIMUM_LENGTH = 3;
export const ERROR_CODE_MAXIMUM_LENGTH = 128;
export const ERROR_CODE_PATTERN = "^[A-Z][A-Z0-9_]{2,127}$";
export const ERROR_ENVELOPE_FIELDS = Object.freeze(["schemaVersion", "error"] as const);
export const ERROR_RECORD_FIELDS = Object.freeze([
  "code",
  "message",
  "category",
  "retryable",
  "details",
  "correlationId",
] as const);
export const ERROR_CATEGORY_VALUES = Object.freeze([
  "authentication",
  "authorization",
  "conflict",
  "dependency",
  "internal",
  "not_found",
  "rate_limit",
  "unavailable",
  "validation",
] as const);

const errorCategories: ReadonlySet<ErrorCategory> = new Set(ERROR_CATEGORY_VALUES);
const errorCodePattern = new RegExp(ERROR_CODE_PATTERN, "u");

export function parseErrorEnvelope(value: unknown): ErrorEnvelope {
  return parseEnvelope(value, "reject");
}

/** Consumer-side reader: ignores additive unknown response fields but validates every known field. */
export function readErrorEnvelope(value: unknown): ErrorEnvelope {
  return parseEnvelope(value, "ignore");
}

function parseEnvelope(value: unknown, unknownFieldMode: UnknownFieldMode): ErrorEnvelope {
  const record = requirePlainRecord(value, "$envelope");
  requireObjectShape(
    record,
    ERROR_ENVELOPE_FIELDS,
    ERROR_ENVELOPE_FIELDS,
    "$envelope",
    unknownFieldMode,
  );
  const error = requirePlainRecord(record.error, "$envelope.error");
  requireObjectShape(
    error,
    ERROR_RECORD_FIELDS,
    ERROR_RECORD_FIELDS,
    "$envelope.error",
    unknownFieldMode,
  );
  const code = requireString(error.code, "$envelope.error.code", {
    minimumLength: ERROR_CODE_MINIMUM_LENGTH,
    maximumLength: ERROR_CODE_MAXIMUM_LENGTH,
    pattern: errorCodePattern,
  });
  const category = requireOneOf(error.category, errorCategories, "$envelope.error.category");
  const retryable = requireBoolean(error.retryable, "$envelope.error.retryable");
  assertCoreErrorClassification(code, category, retryable, "$envelope.error");
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, "$envelope.schemaVersion"),
    error: Object.freeze({
      code,
      message: requireString(error.message, "$envelope.error.message", {
        maximumLength: ERROR_MESSAGE_MAXIMUM_LENGTH,
      }),
      category,
      retryable,
      details: cloneRestrictedJsonObject(
        error.details,
        "$envelope.error.details",
        ERROR_DETAILS_MAXIMUM_BYTES,
        ERROR_DETAILS_MAXIMUM_DEPTH,
        ERROR_DETAILS_MAXIMUM_NODES,
      ),
      correlationId: parseCorrelationId(error.correlationId, "$envelope.error.correlationId"),
    }),
  });
}
