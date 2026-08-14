import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { diffContractSchemas } from "./compatibility.ts";

void test("the frozen Foundation schema is compatible with its v1 baseline", async () => {
  const [baseline, candidate] = await Promise.all([
    readJson("tools/contracts/baseline/foundation.v1.schema.json"),
    readJson("packages/contracts/schemas/foundation.schema.json"),
  ]);
  assert.deepEqual(diffContractSchemas(baseline, candidate), {
    compatible: true,
    findings: [],
  });
});

void test("an optional property addition is an explicitly compatible change", async () => {
  const baseline = await readJson("tools/contracts/baseline/foundation.v1.schema.json");
  const candidate = structuredClone(baseline);
  definition(candidate, "CorrelationContext").properties = {
    ...requireRecord(definition(candidate, "CorrelationContext").properties),
    requestLabel: { type: "string", maxLength: 64 },
  };
  const report = diffContractSchemas(baseline, candidate);
  assert.equal(report.compatible, true);
  assert.ok(report.findings.some((finding) => finding.code === "OPTIONAL_PROPERTY_ADDED"));
});

void test("property deletion, rename, required addition, and type change are breaking", async () => {
  const baseline = await readJson("tools/contracts/baseline/foundation.v1.schema.json");

  const deleted = structuredClone(baseline);
  const deletedProperties = requireRecord(definition(deleted, "ReleaseBinding").properties);
  delete deletedProperties.releaseId;
  assertBreaking(baseline, deleted, "PROPERTY_REMOVED");

  const renamed = structuredClone(baseline);
  const renamedProperties = requireRecord(definition(renamed, "ReleaseBinding").properties);
  renamedProperties.release = renamedProperties.releaseId;
  delete renamedProperties.releaseId;
  assertBreaking(baseline, renamed, "PROPERTY_REMOVED");

  const required = structuredClone(baseline);
  const correlation = definition(required, "CorrelationContext");
  correlation.properties = {
    ...requireRecord(correlation.properties),
    requestLabel: { type: "string" },
  };
  correlation.required = [...requireStringArray(correlation.required), "requestLabel"];
  assertBreaking(baseline, required, "REQUIRED_PROPERTY_ADDED");

  const changedType = structuredClone(baseline);
  const errorRecord = definition(changedType, "ErrorRecord");
  requireRecord(requireRecord(errorRecord.properties).retryable).type = "string";
  assertBreaking(baseline, changedType, "TYPE_CHANGED");
});

void test("constraint tightening, enum drift, and unknown-field policy drift are breaking", async () => {
  const baseline = await readJson("tools/contracts/baseline/foundation.v1.schema.json");

  const tightened = structuredClone(baseline);
  definition(tightened, "OntosId").maxLength = 35;
  assertBreaking(baseline, tightened, "CONSTRAINT_TIGHTENED");

  const enumChanged = structuredClone(baseline);
  const category = requireRecord(
    requireRecord(definition(enumChanged, "ErrorRecord").properties).category,
  );
  category.enum = [...requireStringArray(category.enum), "future_category"];
  assertBreaking(baseline, enumChanged, "ENUM_CHANGED");

  const relaxed = structuredClone(baseline);
  definition(relaxed, "ReleaseBinding").additionalProperties = true;
  assertBreaking(baseline, relaxed, "UNKNOWN_FIELD_POLICY_CHANGED");
});

function assertBreaking(baseline: unknown, candidate: unknown, code: string): void {
  const report = diffContractSchemas(baseline, candidate);
  assert.equal(report.compatible, false);
  assert.ok(report.findings.some((finding) => finding.code === code));
}

function definition(schemaValue: unknown, name: string): Record<string, unknown> {
  const schema = requireRecord(schemaValue);
  return requireRecord(requireRecord(schema.$defs)[name]);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object.");
  }
  return value as Record<string, unknown>;
}

function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !(value as unknown[]).every((item) => typeof item === "string")) {
    throw new Error("Expected string array.");
  }
  return [...(value as string[])];
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
