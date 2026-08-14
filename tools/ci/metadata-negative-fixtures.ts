import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalizeContractForDigest } from "@ontos/contracts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultCatalogPath = join(
  repositoryRoot,
  "packages/testkit/fixtures/metadata/g2-01-negative.v1.json",
);
const outputPath = join(repositoryRoot, "generated/ci-report/metadata-negative-fixtures.json");

export const REQUIRED_NEGATIVE_FIXTURE_IDS = [
  "breaking_upgrade",
  "dependency_cycle",
  "partial_publish",
  "published_update",
  "role_overreach",
  "secret_material",
  "unknown_resource_field",
] as const;

export interface NegativeFixtureCase {
  readonly id: string;
  readonly requirement: string;
  readonly source: string;
  readonly marker: string;
  readonly execution: "unit" | "postgres-integration";
}

export interface NegativeFixtureCatalog {
  readonly schemaVersion: number;
  readonly gate: string;
  readonly cases: readonly NegativeFixtureCase[];
}

export interface NegativeFixtureEvaluation {
  readonly status: "PASS" | "FAIL";
  readonly caseCount: number;
  readonly coveredIds: readonly string[];
  readonly catalogSha256: string;
  readonly evidenceSha256: string;
  readonly sourceSha256: Readonly<Record<string, string>>;
  readonly errors: readonly string[];
}

export function evaluateNegativeFixtureCatalog(
  catalogValue: unknown,
  sourceTexts: Readonly<Record<string, string>>,
  packageScripts: Readonly<Record<string, string>>,
): NegativeFixtureEvaluation {
  const errors: string[] = [];
  const catalog = parseCatalog(catalogValue, errors);
  const cases = catalog?.cases ?? [];
  const ids = cases.map(({ id }) => id).sort();
  const requiredIds = [...REQUIRED_NEGATIVE_FIXTURE_IDS];

  if (new Set(ids).size !== ids.length) errors.push("Negative fixture IDs must be unique.");
  if (JSON.stringify(ids) !== JSON.stringify(requiredIds)) {
    errors.push(`Negative fixture IDs must be exactly: ${requiredIds.join(", ")}.`);
  }

  const sourceSha256: Record<string, string> = {};
  for (const fixture of cases) {
    if (!isRepositoryRelativePath(fixture.source)) {
      errors.push(`${fixture.id}: source must be a safe repository-relative path.`);
      continue;
    }
    if (fixture.marker !== `G2_NEGATIVE:${fixture.id}`) {
      errors.push(`${fixture.id}: marker must bind to the fixture ID.`);
    }
    const source = sourceTexts[fixture.source];
    if (source === undefined) {
      errors.push(`${fixture.id}: source is missing: ${fixture.source}.`);
      continue;
    }
    const markerCount = source.split(fixture.marker).length - 1;
    if (markerCount !== 1) {
      errors.push(`${fixture.id}: marker must occur exactly once; found ${String(markerCount)}.`);
    }
    if (!isRoutedByGate(fixture, packageScripts)) {
      errors.push(`${fixture.id}: source is not routed through ${fixture.execution}.`);
    }
    sourceSha256[fixture.source] = sha256(source);
  }

  const catalogSha256 = sha256(canonicalizeContractForDigest(catalogValue));
  const evidenceSha256 = sha256(
    canonicalizeContractForDigest({
      cases: cases.map(({ id, execution, marker, source }) => ({ id, execution, marker, source })),
      sourceSha256,
    }),
  );
  return {
    status: errors.length === 0 ? "PASS" : "FAIL",
    caseCount: cases.length,
    coveredIds: ids,
    catalogSha256: `sha256:${catalogSha256}`,
    evidenceSha256: `sha256:${evidenceSha256}`,
    sourceSha256: Object.fromEntries(
      Object.entries(sourceSha256).map(([path, digest]) => [path, `sha256:${digest}`]),
    ),
    errors,
  };
}

export async function auditNegativeFixtures(
  catalogPath = defaultCatalogPath,
): Promise<NegativeFixtureEvaluation> {
  const catalogValue: unknown = JSON.parse(await readFile(catalogPath, "utf8"));
  const sourcePaths = catalogSourcePaths(catalogValue);
  const sourceEntries = await Promise.all(
    [...new Set(sourcePaths)].map(async (source) => {
      const contents = await readFile(join(repositoryRoot, source), "utf8").catch(() => "");
      return [source, contents] as const;
    }),
  );
  const sourceTexts: Record<string, string> = Object.fromEntries(sourceEntries);
  const packageValue: unknown = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const scripts = readScripts(packageValue);
  const report = evaluateNegativeFixtureCatalog(catalogValue, sourceTexts, scripts);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        ...report,
        catalog: relative(repositoryRoot, catalogPath),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return report;
}

function catalogSourcePaths(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value["cases"])) return [];
  const sources: string[] = [];
  for (const entry of value["cases"] as unknown[]) {
    if (isRecord(entry) && typeof entry["source"] === "string") {
      sources.push(entry["source"]);
    }
  }
  return sources;
}

function parseCatalog(value: unknown, errors: string[]): NegativeFixtureCatalog | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push("Negative fixture catalog must be an object.");
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) errors.push("Negative fixture schemaVersion must be 1.");
  if (record.gate !== "G2-01") errors.push("Negative fixture gate must be G2-01.");
  if (!Array.isArray(record.cases)) {
    errors.push("Negative fixture cases must be an array.");
    return null;
  }
  const cases: NegativeFixtureCase[] = [];
  for (const [index, valueCase] of record.cases.entries()) {
    if (typeof valueCase !== "object" || valueCase === null || Array.isArray(valueCase)) {
      errors.push(`Negative fixture case ${String(index)} must be an object.`);
      continue;
    }
    const candidate = valueCase as Record<string, unknown>;
    const execution = candidate.execution;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.requirement !== "string" ||
      typeof candidate.source !== "string" ||
      typeof candidate.marker !== "string" ||
      (execution !== "unit" && execution !== "postgres-integration")
    ) {
      errors.push(`Negative fixture case ${String(index)} has invalid fields.`);
      continue;
    }
    cases.push({
      id: candidate.id,
      requirement: candidate.requirement,
      source: candidate.source,
      marker: candidate.marker,
      execution,
    });
  }
  return { schemaVersion: 1, gate: "G2-01", cases };
}

function readScripts(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const scripts = (value as Record<string, unknown>).scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return {};
  return Object.fromEntries(
    Object.entries(scripts).flatMap(([name, command]) =>
      typeof command === "string" ? [[name, command]] : [],
    ),
  );
}

function isRoutedByGate(
  fixture: NegativeFixtureCase,
  scripts: Readonly<Record<string, string>>,
): boolean {
  if (fixture.execution === "postgres-integration") {
    return (scripts["test:database"] ?? "").includes(fixture.source);
  }
  const unit = scripts["test:unit"] ?? "";
  if (fixture.source.startsWith("tools/metadata-control-plane/")) {
    return unit.includes("tools/metadata-control-plane/*.test.ts");
  }
  if (fixture.source.startsWith("tools/ci/")) return unit.includes("tools/ci/*.test.ts");
  return unit.includes(fixture.source);
}

function isRepositoryRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const report = await auditNegativeFixtures();
  const message = `metadata negative fixtures: ${report.status} (${String(report.caseCount)} cases, ${report.evidenceSha256})\n`;
  if (report.status === "PASS") process.stdout.write(message);
  else {
    process.stderr.write(message);
    for (const error of report.errors) process.stderr.write(`- ${error}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
