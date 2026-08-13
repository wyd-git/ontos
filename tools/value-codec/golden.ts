import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  ValueCodecError,
  canonicalizeDistinctPrimaryKeys,
  canonicalizePrimaryKey,
  canonicalizePropertyValue,
  canonicalizeRestrictedJson,
  canonicalizeScalarValue,
  canonicalizeUuid,
  compareScalarValues,
  compareUtf8,
  type PrimaryKeyDefinition,
  type ScalarValueDescriptor,
  type ValueCodecErrorCode,
} from "../../packages/value-codec/src/index.ts";

export type GoldenKind =
  | "boolean"
  | "date"
  | "decimal"
  | "enum"
  | "integer"
  | "json"
  | "string"
  | "string[]"
  | "timestamp"
  | "uuid";

export interface GoldenValueInput {
  readonly id: string;
  readonly kind: GoldenKind;
  readonly input: unknown;
  readonly precision?: number;
  readonly scale?: number;
  readonly values?: readonly string[];
  readonly maximumBytes?: number;
  readonly maximumItems?: number;
}

export interface GoldenValueVector extends GoldenValueInput {
  readonly expected: unknown;
}

export interface InvalidGoldenValueVector extends GoldenValueInput {
  readonly expectedError: ValueCodecErrorCode;
}

export interface PrimaryKeyGoldenVector {
  readonly id: string;
  readonly definition: PrimaryKeyDefinition;
  readonly inputs: readonly unknown[];
  readonly expected: string;
}

export interface CollisionGoldenVector {
  readonly id: string;
  readonly definition: PrimaryKeyDefinition;
  readonly candidates: readonly (readonly unknown[])[];
}

export interface OrderGoldenVector {
  readonly id: string;
  readonly kind: Exclude<GoldenKind, "json" | "string[]">;
  readonly inputs: readonly unknown[];
  readonly expectedCanonicalOrder: readonly string[];
  readonly precision?: number;
  readonly scale?: number;
  readonly values?: readonly string[];
  readonly maximumBytes?: number;
}

export interface GoldenVectorDocument {
  readonly schemaVersion: 1;
  readonly positive: readonly GoldenValueVector[];
  readonly invalid: readonly InvalidGoldenValueVector[];
  readonly primaryKeys: readonly PrimaryKeyGoldenVector[];
  readonly collisions: readonly CollisionGoldenVector[];
  readonly orderGroups: readonly OrderGoldenVector[];
}

const goldenVectorPath = fileURLToPath(new URL("./golden-vectors.json", import.meta.url));

export async function loadGoldenVectors(): Promise<GoldenVectorDocument> {
  const parsed: unknown = JSON.parse(await readFile(goldenVectorPath, "utf8"));
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error("Unsupported value-codec Golden Vector schema.");
  }
  return parsed as unknown as GoldenVectorDocument;
}

export function evaluateGoldenValue(vector: GoldenValueInput): unknown {
  if (vector.kind === "uuid") return canonicalizeUuid(vector.input);
  if (vector.kind === "json") return canonicalizeRestrictedJson(vector.input, vector);
  return canonicalizePropertyValue(vector.input, descriptorFor(vector));
}

export function evaluateGoldenPrimaryKey(vector: PrimaryKeyGoldenVector): string {
  return canonicalizePrimaryKey(vector.inputs, vector.definition);
}

export function assertGoldenCollision(vector: CollisionGoldenVector): void {
  try {
    canonicalizeDistinctPrimaryKeys(
      vector.candidates.map((values, index) => ({ candidateId: `candidate-${index}`, values })),
      vector.definition,
    );
  } catch (error) {
    if (error instanceof ValueCodecError && error.code === "PRIMARY_KEY_COLLISION") return;
    throw error;
  }
  throw new Error(`${vector.id} did not produce PRIMARY_KEY_COLLISION.`);
}

export function evaluateTypeScriptOrder(vector: OrderGoldenVector): readonly string[] {
  const inputs = [...vector.inputs];
  if (vector.kind === "uuid") {
    return inputs.map(canonicalizeUuid).sort(compareUtf8).map(String);
  }
  const descriptor = scalarDescriptorFor(vector);
  return inputs
    .sort((left, right) => compareScalarValues(left, right, descriptor))
    .map((input) => {
      const canonical = canonicalizeScalarValue(input, descriptor);
      return typeof canonical === "boolean" ? (canonical ? "true" : "false") : canonical;
    });
}

export function descriptorFor(
  vector: GoldenValueInput | OrderGoldenVector,
): ScalarValueDescriptor | { readonly type: "string[]"; readonly maximumItems?: number } {
  switch (vector.kind) {
    case "boolean":
    case "date":
    case "integer":
    case "timestamp":
      return { type: vector.kind };
    case "decimal":
      return {
        type: "decimal",
        precision: requiredNumber(vector.precision, "precision", vector.id),
        scale: requiredNumber(vector.scale, "scale", vector.id),
      };
    case "enum":
      return { type: "enum", values: vector.values ?? [] };
    case "string":
      return vector.maximumBytes === undefined
        ? { type: "string" }
        : { type: "string", maximumBytes: vector.maximumBytes };
    case "string[]":
      return vector.maximumItems === undefined
        ? { type: "string[]" }
        : { type: "string[]", maximumItems: vector.maximumItems };
    case "json":
    case "uuid":
      throw new Error(`${vector.id} does not use a Property descriptor.`);
  }
}

function scalarDescriptorFor(vector: OrderGoldenVector): ScalarValueDescriptor {
  const descriptor = descriptorFor(vector);
  if (descriptor.type === "string[]") {
    throw new Error(`${vector.id} is not a sortable scalar vector.`);
  }
  return descriptor;
}

function requiredNumber(value: number | undefined, label: string, id: string): number {
  if (value === undefined) throw new Error(`${id} is missing ${label}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
