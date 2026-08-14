import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { diffContractSchemas } from "./compatibility.ts";
import { assertMetadataRuntimeSchemaAgreement } from "./metadata-runtime-schema-agreement.ts";

void test("the frozen Metadata schema is compatible with its v1 baseline", async () => {
  const [baseline, candidate] = await Promise.all([
    readJson("tools/contracts/baseline/metadata.v1.schema.json"),
    readJson("packages/contracts/schemas/metadata.schema.json"),
  ]);
  assert.deepEqual(diffContractSchemas(baseline, candidate), { compatible: true, findings: [] });
  assert.doesNotThrow(() => assertMetadataRuntimeSchemaAgreement(candidate));
});

void test("optional additions are compatible only after the runtime parser is deployed", async () => {
  const baseline = await readJson("tools/contracts/baseline/metadata.v1.schema.json");
  const candidate = structuredClone(baseline);
  definition(candidate, "Project").properties = {
    ...requireRecord(definition(candidate, "Project").properties),
    description: { $ref: "#/$defs/Description" },
  };
  const report = diffContractSchemas(baseline, candidate);
  assert.equal(report.compatible, true);
  assert.ok(report.findings.some((finding) => finding.code === "OPTIONAL_PROPERTY_ADDED"));
  assert.throws(
    () => assertMetadataRuntimeSchemaAgreement(candidate),
    /disagrees with the runtime parser/u,
  );
});

void test("Metadata removal, required addition, type, enum, bounds and unknown policy drift break v1", async () => {
  const baseline = await readJson("tools/contracts/baseline/metadata.v1.schema.json");

  const removed = structuredClone(baseline);
  delete requireRecord(definition(removed, "ObjectTypeDefinition").properties).titlePropertyApiName;
  assertBreaking(baseline, removed, "PROPERTY_REMOVED");

  const required = structuredClone(baseline);
  const project = definition(required, "Project");
  project.properties = { ...requireRecord(project.properties), description: { type: "string" } };
  project.required = [...requireStringArray(project.required), "description"];
  assertBreaking(baseline, required, "REQUIRED_PROPERTY_ADDED");

  const changedType = structuredClone(baseline);
  requireRecord(
    requireRecord(definition(changedType, "ReleaseManifest").properties).releaseNumber,
  ).type = "string";
  assertBreaking(baseline, changedType, "TYPE_CHANGED");

  const changedEnum = structuredClone(baseline);
  definition(changedEnum, "ResourceFamily").enum = [
    ...requireStringArray(definition(changedEnum, "ResourceFamily").enum),
    "future_family",
  ];
  assertBreaking(baseline, changedEnum, "ENUM_CHANGED");

  const tightened = structuredClone(baseline);
  requireRecord(requireRecord(definition(tightened, "ResourceRevision").properties).etag).minimum =
    2;
  assertBreaking(baseline, tightened, "CONSTRAINT_TIGHTENED");

  const relaxedUnknownFields = structuredClone(baseline);
  definition(relaxedUnknownFields, "PackageManifest").additionalProperties = true;
  assertBreaking(baseline, relaxedUnknownFields, "UNKNOWN_FIELD_POLICY_CHANGED");
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

function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Expected string array.");
  }
  return [...(value as string[])];
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
