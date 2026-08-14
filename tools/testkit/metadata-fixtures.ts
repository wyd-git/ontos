import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalizeContractForDigest,
  canonicalizeManifestForDigest,
  parseArtifactDigest,
  parsePackageManifest,
} from "@ontos/contracts";
import { assertPackageCandidateIntegrity, preparePackageCandidate } from "@ontos/metadata-domain";

interface FixtureDefinition {
  readonly key: "commerce" | "work-management";
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly packageApiName: string;
  readonly namespace: string;
  readonly resourceApiName: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly properties: readonly PropertyInput[];
}

interface PropertyInput {
  readonly apiName: string;
  readonly valueType: "string" | "enum" | "decimal";
  readonly nullable: boolean;
  readonly enumValues?: readonly string[];
  readonly decimalPrecision?: number;
  readonly decimalScale?: number;
}

export interface MetadataPackageFixture {
  readonly schemaVersion: 1;
  readonly provenance: {
    readonly sourcePath: string;
    readonly sourceSha256: string;
    readonly transform: "metadata-only-g2-01";
  };
  readonly manifest: unknown;
  readonly resources: readonly unknown[];
  readonly installInputBindings: readonly { readonly apiName: string; readonly value: string }[];
}

export interface MetadataFixtureAudit {
  readonly schemaVersion: 1;
  readonly status: "PASS" | "FAIL";
  readonly fixtureCount: number;
  readonly fixtureDigest: string;
  readonly compatibilityVectorSha256: string;
  readonly compatibilityCaseCount: number;
  readonly fixtures: readonly {
    readonly key: string;
    readonly path: string;
    readonly sha256: string;
    readonly resourceCount: number;
  }[];
  readonly violations: readonly string[];
}

const definitions: readonly FixtureDefinition[] = Object.freeze([
  {
    key: "commerce",
    sourcePath: "spikes/g1/packages/commerce/package.json",
    targetPath: "packages/testkit/fixtures/metadata-packages/commerce.metadata.v1.json",
    packageApiName: "CommerceMetadata",
    namespace: "fixture.commerce",
    resourceApiName: "Order",
    resourceId: "10000000-0000-4000-8000-000000000001",
    revisionId: "10000000-0000-4000-8000-000000000011",
    properties: [
      { apiName: "orderId", valueType: "string", nullable: false },
      {
        apiName: "status",
        valueType: "enum",
        nullable: false,
        enumValues: ["DRAFT", "CONFIRMED", "SHIPPED", "CANCELLED"],
      },
      {
        apiName: "total",
        valueType: "decimal",
        nullable: false,
        decimalPrecision: 18,
        decimalScale: 2,
      },
    ],
  },
  {
    key: "work-management",
    sourcePath: "spikes/g1/packages/work-management/package.json",
    targetPath: "packages/testkit/fixtures/metadata-packages/work-management.metadata.v1.json",
    packageApiName: "WorkMetadata",
    namespace: "fixture.work",
    resourceApiName: "WorkItem",
    resourceId: "20000000-0000-4000-8000-000000000001",
    revisionId: "20000000-0000-4000-8000-000000000011",
    properties: [
      { apiName: "workItemId", valueType: "string", nullable: false },
      { apiName: "title", valueType: "string", nullable: false },
      {
        apiName: "status",
        valueType: "enum",
        nullable: false,
        enumValues: ["OPEN", "ASSIGNED", "DONE"],
      },
    ],
  },
]);

export async function buildMetadataPackageFixtures(
  repositoryRoot: string,
): Promise<Readonly<Record<string, MetadataPackageFixture>>> {
  const fixtures: Record<string, MetadataPackageFixture> = {};
  for (const definition of definitions) {
    fixtures[definition.key] = await buildFixture(repositoryRoot, definition);
  }
  return Object.freeze(fixtures);
}

export async function auditMetadataPackageFixtures(
  repositoryRoot: string,
): Promise<MetadataFixtureAudit> {
  const expected = await buildMetadataPackageFixtures(repositoryRoot);
  const violations: string[] = [];
  const fixtures = [];
  const combined = createHash("sha256");
  for (const definition of definitions) {
    const expectedFixture = expected[definition.key];
    if (expectedFixture === undefined)
      throw new Error("Metadata fixture builder omitted a definition.");
    const expectedText = `${JSON.stringify(expectedFixture, null, 2)}\n`;
    let actualFixture: unknown;
    try {
      const actualText = await readFile(join(repositoryRoot, definition.targetPath), "utf8");
      actualFixture = JSON.parse(actualText) as unknown;
    } catch {
      violations.push(`${definition.targetPath} is missing.`);
    }
    if (JSON.stringify(actualFixture) !== JSON.stringify(expectedFixture)) {
      violations.push(`${definition.targetPath} is not the reproducible metadata-only fixture.`);
    }
    const digest = sha256(expectedText);
    combined.update(definition.targetPath).update("\0").update(expectedText).update("\0");
    const prepared = preparePackageCandidate(candidateInput(expectedFixture));
    assertPackageCandidateIntegrity(prepared, sha256Text);
    fixtures.push({
      key: definition.key,
      path: definition.targetPath,
      sha256: digest,
      resourceCount: prepared.resources.length,
    });
  }
  const compatibilityPath = join(
    repositoryRoot,
    "packages/testkit/fixtures/vectors/package-compatibility.v1.json",
  );
  const compatibilityText = await readFile(compatibilityPath, "utf8");
  const compatibilityValue: unknown = JSON.parse(compatibilityText);
  const compatibilityCaseCount = compatibilityCases(compatibilityValue).length;
  if (compatibilityCaseCount < 2) {
    violations.push("Package compatibility vectors must include compatible and breaking cases.");
  }
  return {
    schemaVersion: 1,
    status: violations.length === 0 ? "PASS" : "FAIL",
    fixtureCount: fixtures.length,
    fixtureDigest: `sha256:${combined.digest("hex")}`,
    compatibilityVectorSha256: `sha256:${sha256(compatibilityText)}`,
    compatibilityCaseCount,
    fixtures: Object.freeze(fixtures),
    violations: Object.freeze(violations),
  };
}

function compatibilityCases(value: unknown): readonly unknown[] {
  if (!isRecord(value) || value["schemaVersion"] !== 1 || !Array.isArray(value["cases"])) {
    return [];
  }
  return value["cases"];
}

async function buildFixture(
  repositoryRoot: string,
  definition: FixtureDefinition,
): Promise<MetadataPackageFixture> {
  const source = await readFile(join(repositoryRoot, definition.sourcePath));
  const sourceJson: unknown = JSON.parse(source.toString("utf8"));
  if (!isRecord(sourceJson) || sourceJson["namespace"] !== definition.namespace) {
    throw new Error(`${definition.sourcePath} no longer has the expected namespace.`);
  }
  const primaryKey = definition.properties[0];
  if (primaryKey === undefined) throw new Error("Metadata fixture requires a Primary Key.");
  const content = {
    schemaVersion: 1,
    apiName: definition.resourceApiName,
    displayName: definition.resourceApiName,
    description: `${definition.resourceApiName} metadata-only G2-01 fixture.`,
    primaryKeyPropertyApiName: primaryKey.apiName,
    titlePropertyApiName: primaryKey.apiName,
    defaultSearchPropertyApiNames: [],
    defaultSort: [{ propertyApiName: primaryKey.apiName, direction: "asc" }],
    defaultClassification: "internal",
    properties: definition.properties.map((property, index) =>
      propertyDefinition(property, index === 0),
    ),
  };
  const contentDigest = sha256Text(canonicalizeContractForDigest(content));
  const resources = [
    {
      resourceId: definition.resourceId,
      revisionId: definition.revisionId,
      content,
    },
  ];
  const manifestInput = {
    schemaVersion: 1,
    packageApiName: definition.packageApiName,
    version: "1.0.0",
    namespace: definition.namespace,
    kernelContractVersion: "metadata-1",
    resourceEntries: resources.map(({ resourceId, revisionId }) => ({
      namespace: definition.namespace,
      apiName: definition.resourceApiName,
      family: "object_type",
      resourceId,
      revisionId,
      contentDigest,
    })),
    artifactDigests: [],
    installInputs: [
      {
        apiName: "environment",
        displayName: "Environment",
        description: "Non-secret deployment label.",
        required: true,
      },
    ],
    manifestDigest: `sha256:${"0".repeat(64)}`,
  };
  const manifest = parsePackageManifest({
    ...manifestInput,
    manifestDigest: sha256Text(canonicalizeManifestForDigest(manifestInput)),
  });
  return Object.freeze({
    schemaVersion: 1,
    provenance: Object.freeze({
      sourcePath: definition.sourcePath,
      sourceSha256: sha256(source),
      transform: "metadata-only-g2-01" as const,
    }),
    manifest,
    resources: Object.freeze(resources),
    installInputBindings: Object.freeze([{ apiName: "environment", value: "test" }]),
  });
}

function propertyDefinition(
  input: PropertyInput,
  primaryKey: boolean,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    apiName: input.apiName,
    displayName: input.apiName,
    description: `${input.apiName} fixture property.`,
    valueType: input.valueType,
    ...(input.valueType === "string" ? { caseSensitive: true } : {}),
    ...(input.enumValues === undefined ? {} : { enumValues: input.enumValues }),
    ...(input.decimalPrecision === undefined ? {} : { decimalPrecision: input.decimalPrecision }),
    ...(input.decimalScale === undefined ? {} : { decimalScale: input.decimalScale }),
    nullable: input.nullable,
    writeMode: "source_only",
    unique: primaryKey,
    filterable: true,
    sortable: true,
    searchable: input.valueType === "string",
    classification: "internal",
  });
}

export function metadataFixtureCandidate(fixture: MetadataPackageFixture) {
  return candidateInput(fixture);
}

function candidateInput(fixture: MetadataPackageFixture) {
  return {
    manifest: fixture.manifest,
    resources: fixture.resources,
    installInputBindings: fixture.installInputBindings,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string) {
  return parseArtifactDigest(`sha256:${sha256(value)}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const key = process.argv[2];
  if (key === "print-commerce" || key === "print-work-management") {
    const fixtures = await buildMetadataPackageFixtures(repositoryRoot);
    const fixture = fixtures[key === "print-commerce" ? "commerce" : "work-management"];
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
    return;
  }
  const result = await auditMetadataPackageFixtures(repositoryRoot);
  const outputDirectory = join(repositoryRoot, "generated/ci-report");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    join(outputDirectory, "metadata-fixtures.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(
    `metadata fixtures: ${result.status} (${String(result.fixtureCount)} packages, ${result.fixtureDigest})\n`,
  );
  if (result.status === "FAIL") process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
