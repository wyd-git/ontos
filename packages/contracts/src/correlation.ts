import { failContract } from "./error.ts";
import { requireObjectShape, requirePlainRecord } from "./internal.ts";
import {
  parseCorrelationId,
  parseSchemaVersion,
  type CorrelationId,
  type ContractSchemaVersion,
} from "./scalars.ts";

export interface CorrelationContext {
  readonly schemaVersion: ContractSchemaVersion;
  readonly correlationId: CorrelationId;
  readonly parentCorrelationId?: CorrelationId;
}

export const CORRELATION_CONTEXT_FIELDS = Object.freeze([
  "schemaVersion",
  "correlationId",
  "parentCorrelationId",
] as const);
export const CORRELATION_CONTEXT_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "correlationId",
] as const);

export function parseCorrelationContext(value: unknown): CorrelationContext {
  const record = requirePlainRecord(value, "$correlation");
  requireObjectShape(
    record,
    CORRELATION_CONTEXT_FIELDS,
    CORRELATION_CONTEXT_REQUIRED_FIELDS,
    "$correlation",
  );
  const correlationId = parseCorrelationId(record.correlationId, "$correlation.correlationId");
  const schemaVersion = parseSchemaVersion(record.schemaVersion, "$correlation.schemaVersion");
  const parentCorrelationId = Object.hasOwn(record, "parentCorrelationId")
    ? parseCorrelationId(record.parentCorrelationId, "$correlation.parentCorrelationId")
    : undefined;
  if (parentCorrelationId === correlationId) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Correlation parent cannot equal the current correlation ID.",
      "$correlation.parentCorrelationId",
    );
  }
  return parentCorrelationId === undefined
    ? Object.freeze({ schemaVersion, correlationId })
    : Object.freeze({
        schemaVersion,
        correlationId,
        parentCorrelationId,
      });
}
