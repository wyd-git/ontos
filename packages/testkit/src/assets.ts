import { readFile } from "node:fs/promises";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface TestkitAssets {
  readonly commercePackage: JsonObject;
  readonly workManagementPackage: JsonObject;
  readonly queryCorpus: JsonObject;
  readonly overlayConflictVectors: JsonObject;
  readonly policyVectors: JsonObject;
  readonly packageCompatibilityVectors: JsonObject;
  readonly provenance: JsonObject;
}

export async function loadTestkitAssets(): Promise<TestkitAssets> {
  const [
    commercePackage,
    workManagementPackage,
    queryCorpus,
    overlayConflictVectors,
    policyVectors,
    packageCompatibilityVectors,
    provenance,
  ] = await Promise.all([
    loadJson("packages/commerce.v1.json"),
    loadJson("packages/work-management.v1.json"),
    loadJson("vectors/query-corpus.v1.json"),
    loadJson("vectors/overlay-conflict.v1.json"),
    loadJson("vectors/policy.v1.json"),
    loadJson("vectors/package-compatibility.v1.json"),
    loadJson("provenance.json"),
  ]);

  return {
    commercePackage,
    workManagementPackage,
    queryCorpus,
    overlayConflictVectors,
    policyVectors,
    packageCompatibilityVectors,
    provenance,
  };
}

async function loadJson(relativePath: string): Promise<JsonObject> {
  const candidate: unknown = JSON.parse(
    await readFile(new URL(`../fixtures/${relativePath}`, import.meta.url), "utf8"),
  );
  if (!isJsonObject(candidate))
    throw new Error(`Testkit asset ${relativePath} must be a JSON object.`);
  return candidate;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
