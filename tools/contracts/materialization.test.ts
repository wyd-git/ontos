import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ContractValidationError,
  MATERIALIZATION_REASON_CODE_VALUES,
  MATERIALIZATION_OPERATION_ERROR_CODE_VALUES,
  assertMaterializationStateTransition,
  canonicalizeMaterializationContractForDigest,
  canonicalizeMaterializationIdempotencyInput,
  parseCompatibilityCertificate,
  parseDirectResourceContent,
  parseMappingDefinition,
  parsePackageResourceContent,
  parseSnapshotSchemaDefinition,
} from "../../packages/contracts/src/index.ts";
import { runMaterializationContractChecks } from "./check-materialization.ts";

void test("Materialization catalog, schema, parsers, baseline and Golden Fixtures agree", async () => {
  assert.deepEqual(await runMaterializationContractChecks(process.cwd()), {
    materializationContractCount: 12,
    goldenCaseCount: 20,
    structuralRejectionCount: 5,
    semanticRejectionCount: 0,
    stableReasonCodeCount: 7,
    stableOperationErrorCodeCount: 11,
    activeResourceFamilyCount: 4,
    deferredResourceFamilyCount: 6,
    compatibilityFindingCount: 0,
  });
});

void test("direct Resource and Package paths share the active Mapping and Snapshot Schema parsers", async () => {
  const fixture = await readGolden();
  for (const [family, caseName] of [
    ["mapping", "mapping-object-row-ast"],
    ["snapshot_schema", "snapshot-schema-object-csv"],
  ] as const) {
    const value = goldenValue(fixture, caseName);
    assert.deepEqual(
      parseDirectResourceContent(family, value),
      parsePackageResourceContent(family, value),
    );
  }
});

void test("Mapping v1 is a bounded row AST and rejects unactivated or infrastructure capabilities", async () => {
  const fixture = await readGolden();
  const mapping = record(structuredClone(goldenValue(fixture, "mapping-object-row-ast")));
  for (const op of ["join", "window", "aggregate", "function"]) {
    assertContractError(
      () => parseMappingDefinition({ ...mapping, primaryKeyExpression: { op } }),
      "CONTRACT_FORMAT_INVALID",
    );
  }
  for (const field of ["sql", "code", "path", "endpoint", "credential", "sourceUrl"]) {
    assertContractError(
      () => parseMappingDefinition({ ...mapping, [field]: "untrusted" }),
      "CONTRACT_UNKNOWN_FIELD",
    );
  }

  const properties = mapping.propertyMappings;
  if (!Array.isArray(properties)) throw new Error("Mapping Fixture has no Property Mappings.");
  const first = record(properties[0]);
  assertContractError(
    () =>
      parseMappingDefinition({
        ...mapping,
        propertyMappings: [
          { ...first, expression: { op: "column", columnApiName: "x", sql: "x" } },
        ],
      }),
    "CONTRACT_UNKNOWN_FIELD",
  );
});

void test("Snapshot Schema is fixed to managed UTF-8 CSV with explicit ordered columns", () => {
  const valid = {
    schemaVersion: 1,
    contractVersion: "snapshot-schema-v1",
    format: "csv_utf8",
    headerRow: true,
    columns: [{ ordinal: 0, columnApiName: "id", valueType: "string", required: true }],
  };
  assert.doesNotThrow(() => parseSnapshotSchemaDefinition(valid));
  assertContractError(
    () => parseSnapshotSchemaDefinition({ ...valid, headerRow: false }),
    "CONTRACT_FORMAT_INVALID",
  );
  assertContractError(
    () => parseSnapshotSchemaDefinition({ ...valid, format: "parquet" }),
    "CONTRACT_FORMAT_INVALID",
  );
  assertContractError(
    () => parseSnapshotSchemaDefinition({ ...valid, inferSchema: true }),
    "CONTRACT_UNKNOWN_FIELD",
  );
});

void test("all lifecycle machines allow declared edges and reject resurrection from terminal states", () => {
  const legal = [
    ["snapshot", "registered", "validated"],
    ["snapshot_group", "ready", "active"],
    ["job", "running", "retry_wait"],
    ["job", "dead_letter", "queued"],
    ["generation", "ready", "active"],
    ["activation", "active", "retired"],
    ["gc_plan", "planned", "committed"],
  ] as const;
  for (const [kind, from, to] of legal) {
    assert.doesNotThrow(() => assertMaterializationStateTransition(kind, from, to));
  }

  const illegal = [
    ["snapshot", "failed", "registered"],
    ["snapshot_group", "superseded", "active"],
    ["job", "succeeded", "running"],
    ["job", "cancelled", "queued"],
    ["generation", "retired", "active"],
    ["activation", "failed", "building"],
    ["gc_plan", "committed", "planned"],
  ] as const;
  for (const [kind, from, to] of illegal) {
    assertContractError(
      () => assertMaterializationStateTransition(kind, from, to),
      "CONTRACT_STATE_TRANSITION_INVALID",
    );
  }
});

void test("idempotency preimage contains only content, Mapping revision, target member and Runtime Plan", () => {
  const input = {
    idempotencyVersion: "materialization-idempotency-v1",
    contentDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    mappingRevisionId: "44444444-4444-4444-4444-444444444444",
    targetMemberKey: "object:Customer",
    runtimePlanDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const reordered = {
    runtimePlanDigest: input.runtimePlanDigest,
    targetMemberKey: input.targetMemberKey,
    mappingRevisionId: input.mappingRevisionId,
    contentDigest: input.contentDigest,
    idempotencyVersion: input.idempotencyVersion,
  };
  assert.equal(
    canonicalizeMaterializationIdempotencyInput(input),
    canonicalizeMaterializationIdempotencyInput(reordered),
  );
  for (const excluded of ["displayName", "uploadedAt", "databaseOrder"]) {
    assertContractError(
      () => canonicalizeMaterializationIdempotencyInput({ ...input, [excluded]: "ignored" }),
      "CONTRACT_UNKNOWN_FIELD",
    );
  }
  assert.notEqual(
    canonicalizeMaterializationIdempotencyInput(input),
    canonicalizeMaterializationIdempotencyInput({
      ...input,
      mappingRevisionId: "44444444-4444-4444-4444-444444444445",
    }),
  );
});

void test("canonical Generation digest ignores self-digest and lifecycle metadata but binds material inputs", async () => {
  const fixture = await readGolden();
  const generation = record(structuredClone(goldenValue(fixture, "generation-ready-invisible")));
  const canonical = canonicalizeMaterializationContractForDigest("Generation", generation);
  assert.equal(
    canonical,
    canonicalizeMaterializationContractForDigest("Generation", {
      ...generation,
      state: "active",
      generationDigest: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
      createdAt: "2026-08-15T10:00:00.000000Z",
    }),
  );
  assert.notEqual(
    canonical,
    canonicalizeMaterializationContractForDigest("Generation", {
      ...generation,
      mappingRevisionId: "44444444-4444-4444-4444-444444444445",
    }),
  );
});

void test("Snapshot, Group, Job, Activation and GC digests exclude only declared mutable metadata", async () => {
  const fixture = await readGolden();
  const cases = [
    {
      contract: "DatasetSnapshot" as const,
      fixture: "dataset-snapshot-managed-file",
      mutable: {
        state: "active",
        registeredAt: "2026-08-15T11:00:00.000000Z",
        snapshotDigest: "sha256:9191919191919191919191919191919191919191919191919191919191919191",
      },
      material: { mappingRevisionId: "44444444-4444-4444-4444-444444444445" },
    },
    {
      contract: "SnapshotGroup" as const,
      fixture: "snapshot-group-object-and-link",
      mutable: {
        state: "active",
        createdAt: "2026-08-15T11:00:00.000000Z",
        groupDigest: "sha256:9292929292929292929292929292929292929292929292929292929292929292",
      },
      material: { groupVersion: 2 },
    },
    {
      contract: "MaterializationJob" as const,
      fixture: "materialization-job-queued",
      mutable: {
        state: "cancelled",
        attemptCount: 3,
        updatedAt: "2026-08-15T11:00:00.000000Z",
      },
      material: {
        inputDigest: "sha256:9393939393939393939393939393939393939393939393939393939393939393",
      },
    },
    {
      contract: "RuntimeActivation" as const,
      fixture: "runtime-activation-composite",
      mutable: {
        state: "retired",
        createdAt: "2026-08-15T11:00:00.000000Z",
        activationDigest: "sha256:9494949494949494949494949494949494949494949494949494949494949494",
      },
      material: {
        runtimePlanDigest:
          "sha256:9595959595959595959595959595959595959595959595959595959595959595",
      },
    },
    {
      contract: "GcPlan" as const,
      fixture: "gc-plan-empty-safe-set",
      mutable: {
        gcPlanId: "acacacac-acac-acac-acac-acacacacacac",
        state: "stale",
        createdAt: "2026-08-15T11:00:00.000000Z",
        planDigest: "sha256:9696969696969696969696969696969696969696969696969696969696969696",
      },
      material: { inventoryRevision: "4" },
    },
  ];
  for (const item of cases) {
    const base = record(structuredClone(goldenValue(fixture, item.fixture)));
    const canonical = canonicalizeMaterializationContractForDigest(item.contract, base);
    assert.equal(
      canonical,
      canonicalizeMaterializationContractForDigest(item.contract, {
        ...base,
        ...item.mutable,
      }),
      item.contract,
    );
    assert.notEqual(
      canonical,
      canonicalizeMaterializationContractForDigest(item.contract, {
        ...base,
        ...item.material,
      }),
      item.contract,
    );
  }
});

void test("Materialization contract versions fail closed instead of using a loose reader", async () => {
  const fixture = await readGolden();
  const schema = record(goldenValue(fixture, "snapshot-schema-object-csv"));
  assertContractError(
    () => parseSnapshotSchemaDefinition({ ...schema, contractVersion: "snapshot-schema-v2" }),
    "CONTRACT_FORMAT_INVALID",
  );
  const mapping = record(goldenValue(fixture, "mapping-object-row-ast"));
  assertContractError(
    () => parseMappingDefinition({ ...mapping, mappingVersion: "mapping-v2" }),
    "CONTRACT_FORMAT_INVALID",
  );
});

void test("Compatibility Certificate is server-issued evidence and never accepts a compatible boolean", async () => {
  const fixture = await readGolden();
  const certificate = record(
    structuredClone(goldenValue(fixture, "compatibility-certificate-server-issued")),
  );
  assert.doesNotThrow(() => parseCompatibilityCertificate(certificate));
  assertContractError(
    () => parseCompatibilityCertificate({ ...certificate, compatible: true }),
    "CONTRACT_UNKNOWN_FIELD",
  );
  assertContractError(
    () => parseCompatibilityCertificate({ ...certificate, issuer: "client" }),
    "CONTRACT_FORMAT_INVALID",
  );
});

void test("Golden Fixture freezes every materialization reason and operation error code", async () => {
  const fixture = await readGolden();
  assert.deepEqual(fixture.stableReasonCodes, MATERIALIZATION_REASON_CODE_VALUES);
  assert.deepEqual(fixture.stableOperationErrorCodes, MATERIALIZATION_OPERATION_ERROR_CODE_VALUES);
});

interface GoldenFixture {
  readonly stableReasonCodes: readonly string[];
  readonly stableOperationErrorCodes: readonly string[];
  readonly cases: readonly Readonly<Record<string, unknown>>[];
}

async function readGolden(): Promise<GoldenFixture> {
  return JSON.parse(
    await readFile("packages/contracts/fixtures/materialization-golden.json", "utf8"),
  ) as GoldenFixture;
}

function goldenValue(fixture: GoldenFixture, name: string): unknown {
  const found = fixture.cases.find((item) => item.name === name);
  if (found === undefined) throw new Error(`Golden Fixture ${name} is missing.`);
  return found.value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object.");
  }
  return value as Record<string, unknown>;
}

function assertContractError(operation: () => unknown, code: string): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof ContractValidationError && error.code === code,
  );
}
