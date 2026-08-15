import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { diffContractSchemas } from "./compatibility.ts";
import { assertMaterializationRuntimeSchemaAgreement } from "./materialization-runtime-schema-agreement.ts";

void test("the frozen Materialization schema is compatible with its v1 baseline", async () => {
  const [baseline, candidate] = await Promise.all([
    readJson("tools/contracts/baseline/materialization.v1.schema.json"),
    readJson("packages/contracts/schemas/materialization.schema.json"),
  ]);
  assert.deepEqual(diffContractSchemas(baseline, candidate), { compatible: true, findings: [] });
  assert.doesNotThrow(() => assertMaterializationRuntimeSchemaAgreement(candidate));
});

void test("Materialization removal, required additions and closed-enum drift break v1", async () => {
  const baseline = await readJson("tools/contracts/baseline/materialization.v1.schema.json");

  const removed = structuredClone(baseline);
  delete requireRecord(definition(removed, "Generation").properties).mappingRevisionId;
  assertBreaking(baseline, removed, "PROPERTY_REMOVED");

  const required = structuredClone(baseline);
  const snapshot = definition(required, "DatasetSnapshot");
  snapshot.properties = { ...requireRecord(snapshot.properties), displayName: { type: "string" } };
  snapshot.required = [...stringArray(snapshot.required), "displayName"];
  assertBreaking(baseline, required, "REQUIRED_PROPERTY_ADDED");

  const enumChanged = structuredClone(baseline);
  requireRecord(requireRecord(definition(enumChanged, "MappingExpression").properties).op).enum = [
    "column",
    "constant",
    "cast",
    "concat",
    "join",
  ];
  assertBreaking(baseline, enumChanged, "ENUM_CHANGED");

  const relaxedUnknown = structuredClone(baseline);
  definition(relaxedUnknown, "CompatibilityCertificate").additionalProperties = true;
  assertBreaking(baseline, relaxedUnknown, "UNKNOWN_FIELD_POLICY_CHANGED");
});

void test("runtime agreement blocks schema-only optional fields before parser deployment", async () => {
  const baseline = await readJson("tools/contracts/baseline/materialization.v1.schema.json");
  const candidate = structuredClone(baseline);
  const generation = definition(candidate, "Generation");
  generation.properties = {
    ...requireRecord(generation.properties),
    displayName: { type: "string" },
  };
  const report = diffContractSchemas(baseline, candidate);
  assert.equal(report.compatible, true);
  assert.ok(report.findings.some((finding) => finding.code === "OPTIONAL_PROPERTY_ADDED"));
  assert.throws(() => assertMaterializationRuntimeSchemaAgreement(candidate), /runtime contract/u);
});

function assertBreaking(baseline: unknown, candidate: unknown, code: string): void {
  const report = diffContractSchemas(baseline, candidate);
  assert.equal(report.compatible, false);
  assert.ok(report.findings.some((finding) => finding.code === code));
}

function definition(schemaValue: unknown, name: string): Record<string, unknown> {
  return requireRecord(requireRecord(requireRecord(schemaValue).$defs)[name]);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object.");
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Expected string array.");
  }
  return [...(value as string[])];
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
