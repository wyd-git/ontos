import { buildRuntimeReadSchema } from "./runtime-read-schema-source.ts";

export function assertRuntimeReadSchemaAgreement(schemaValue: unknown): void {
  if (stableJson(schemaValue) !== stableJson(buildRuntimeReadSchema())) {
    throw new Error("Runtime Read JSON Schema disagrees with runtime parser field sources.");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
