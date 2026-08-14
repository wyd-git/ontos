import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface ResidualRisk {
  readonly id: string;
  readonly risk: string;
  readonly owner: string;
  readonly nextGate: string;
}

export interface MetadataEvidencePolicy {
  readonly schemaVersion: 1;
  readonly gate: "G2-01";
  readonly requiredEvidence: readonly string[];
  readonly protectedFoundationEvidence: Readonly<Record<string, string>>;
  readonly metadataFixtures: {
    readonly paths: readonly string[];
    readonly compatibilityVector: string;
  };
  readonly negativeFixtureIds: readonly string[];
  readonly requiredGates: readonly string[];
  readonly owner: string;
  readonly residualRisks: readonly ResidualRisk[];
}

export interface MetadataEvidenceSnapshot {
  readonly trackedFiles: readonly string[];
  readonly documents: Readonly<Record<string, string | undefined>>;
  readonly foundationEvidenceSha256: Readonly<Record<string, string | undefined>>;
  readonly foundationAcceptance: unknown;
  readonly metadataFixtures: unknown;
  readonly negativeFixtures: unknown;
}

export function evaluateMetadataEvidenceSnapshot(
  snapshot: MetadataEvidenceSnapshot,
  policy: MetadataEvidencePolicy,
): readonly string[] {
  assertPolicy(policy);
  const violations: string[] = [];
  const tracked = new Set(snapshot.trackedFiles);

  for (const path of policy.requiredEvidence) {
    if (!tracked.has(path)) violations.push(`Required G2-01 evidence is not Git tracked: ${path}.`);
    const contents = snapshot.documents[path];
    if (contents === undefined) violations.push(`Required G2-01 evidence is missing: ${path}.`);
    else if (!contents.includes("- 结论：**PASS")) {
      violations.push(`Required G2-01 evidence is not PASS: ${path}.`);
    }
  }

  for (const [path, expected] of Object.entries(policy.protectedFoundationEvidence)) {
    const actual = snapshot.foundationEvidenceSha256[path];
    if (!tracked.has(path))
      violations.push(`Protected Foundation evidence is not tracked: ${path}.`);
    if (actual !== expected) {
      violations.push(
        `Protected Foundation evidence drifted: ${path}; expected ${expected}, received ${actual ?? "missing"}.`,
      );
    }
  }

  for (const path of [
    ...policy.metadataFixtures.paths,
    policy.metadataFixtures.compatibilityVector,
  ]) {
    if (!tracked.has(path))
      violations.push(`Required Metadata fixture is not Git tracked: ${path}.`);
  }

  validateFoundation(snapshot.foundationAcceptance, violations);
  validateMetadataFixtures(snapshot.metadataFixtures, policy, violations);
  validateNegativeFixtures(snapshot.negativeFixtures, policy, violations);
  return violations;
}

export function metadataEvidenceManifest(
  report: Readonly<Record<string, unknown>>,
  acceptance: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const steps = Array.isArray(report.steps) ? report.steps : [];
  const requiredGates = stringArrayProperty(acceptance, "requiredGates");
  const stepRecords = steps.filter(isRecord);
  const gatesPassed = requiredGates.every(
    (gate) =>
      stepRecords.filter((step) => step.name === gate && step.status === "PASS").length === 1,
  );
  const reportPassed = report.status === "PASS";
  const acceptancePassed = acceptance.status === "PASS";
  const cleanCheckout = report.dirty === false;
  const status = reportPassed && acceptancePassed && gatesPassed ? "PASS" : "FAIL";
  const testCount = stepRecords.reduce(
    (sum, step) =>
      sum +
      (typeof step.testCount === "number" && Number.isFinite(step.testCount) ? step.testCount : 0),
    0,
  );
  return {
    schemaVersion: 1,
    gate: "G2-01",
    status,
    qualification:
      status === "PASS" && cleanCheckout
        ? "CLEAN_ROOM_PASS"
        : status === "PASS"
          ? "WORKTREE_PASS"
          : "FAIL",
    commit: stringProperty(report, "commit"),
    cleanCheckout,
    command: "npm run verify",
    startedAt: stringProperty(report, "startedAt"),
    completedAt: stringProperty(report, "completedAt"),
    durationMs: numberProperty(report, "durationMs"),
    testCount,
    environment: report.environment ?? null,
    postgres: report.postgres ?? null,
    inputs: report.inputs ?? null,
    results: stepRecords.map(compactStep),
    artifactDigests: report.artifacts ?? [],
    artifactCounts: report.artifactCounts ?? null,
    evidence: acceptance.evidence ?? [],
    protectedFoundationEvidence: acceptance.protectedFoundationEvidence ?? null,
    fixtures: acceptance.fixtures ?? null,
    negativeFixtures: acceptance.negativeFixtures ?? null,
    scope: acceptance.foundationScope ?? null,
    owner: acceptance.owner ?? null,
    unclosedRisks: acceptance.residualRisks ?? [],
  };
}

export async function writeMetadataEvidenceManifest(
  outputDirectory: string,
  report: Readonly<Record<string, unknown>>,
): Promise<void> {
  const acceptance = parseRecord(
    await readFile(resolve(outputDirectory, "metadata-acceptance.json"), "utf8"),
    "Metadata acceptance artifact",
  );
  const manifest = metadataEvidenceManifest(report, acceptance);
  await writeFile(
    resolve(outputDirectory, "metadata-evidence-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function checkMetadataEvidence(repositoryRoot: string): Promise<void> {
  const policy = await loadPolicy(repositoryRoot);
  const snapshot = await loadSnapshot(repositoryRoot, policy);
  const violations = evaluateMetadataEvidenceSnapshot(snapshot, policy);
  const outputDirectory = resolve(repositoryRoot, "generated/ci-report");
  await mkdir(outputDirectory, { recursive: true });
  const fixtureRecord = isRecord(snapshot.metadataFixtures) ? snapshot.metadataFixtures : {};
  const negativeRecord = isRecord(snapshot.negativeFixtures) ? snapshot.negativeFixtures : {};
  const foundationRecord = isRecord(snapshot.foundationAcceptance)
    ? snapshot.foundationAcceptance
    : {};
  const artifact = {
    schemaVersion: 1,
    gate: policy.gate,
    status: violations.length === 0 ? "PASS" : "FAIL",
    evidence: policy.requiredEvidence,
    protectedFoundationEvidence: snapshot.foundationEvidenceSha256,
    fixtures: {
      paths: policy.metadataFixtures.paths,
      fixtureCount: fixtureRecord.fixtureCount ?? null,
      fixtureDigest: fixtureRecord.fixtureDigest ?? null,
      compatibilityVector: policy.metadataFixtures.compatibilityVector,
      compatibilityVectorSha256: fixtureRecord.compatibilityVectorSha256 ?? null,
      compatibilityCaseCount: fixtureRecord.compatibilityCaseCount ?? null,
    },
    negativeFixtures: {
      coveredIds: negativeRecord.coveredIds ?? [],
      catalogSha256: negativeRecord.catalogSha256 ?? null,
      evidenceSha256: negativeRecord.evidenceSha256 ?? null,
    },
    foundationScope: foundationRecord.scope ?? null,
    requiredGates: policy.requiredGates,
    owner: policy.owner,
    residualRisks: policy.residualRisks,
    violations,
  };
  await writeFile(
    resolve(outputDirectory, "metadata-acceptance.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  if (violations.length > 0) throw new Error(violations.join(" "));
  process.stdout.write(
    `metadata acceptance: PASS (${String(policy.requiredEvidence.length)} evidence records, ${String(policy.metadataFixtures.paths.length)} packages, ${String(policy.negativeFixtureIds.length)} negative fixtures, ${String(policy.requiredGates.length)} required gates)\n`,
  );
}

async function loadPolicy(repositoryRoot: string): Promise<MetadataEvidencePolicy> {
  const value: unknown = JSON.parse(
    await readFile(resolve(repositoryRoot, "security/g2-01-evidence-policy.json"), "utf8"),
  );
  assertPolicy(value);
  return value;
}

async function loadSnapshot(
  repositoryRoot: string,
  policy: MetadataEvidencePolicy,
): Promise<MetadataEvidenceSnapshot> {
  const trackedResult = await run("git", ["ls-files", "-z"], repositoryRoot);
  if (trackedResult.exitCode !== 0) throw new Error(`git ls-files failed: ${trackedResult.stderr}`);
  const trackedFiles = trackedResult.stdout.split("\0").filter(Boolean).sort();
  const documentEntries = await Promise.all(
    policy.requiredEvidence.map(async (path) => {
      const contents = await readFile(resolve(repositoryRoot, path), "utf8").catch(() => undefined);
      return [path, contents] as const;
    }),
  );
  const documents: Record<string, string | undefined> = Object.fromEntries(documentEntries);
  const foundationEntries = await Promise.all(
    Object.keys(policy.protectedFoundationEvidence).map(async (path) => {
      const bytes = await readFile(resolve(repositoryRoot, path)).catch(() => undefined);
      return [path, bytes === undefined ? undefined : `sha256:${sha256(bytes)}`] as const;
    }),
  );
  const foundationEvidenceSha256: Record<string, string | undefined> =
    Object.fromEntries(foundationEntries);
  const outputDirectory = resolve(repositoryRoot, "generated/ci-report");
  return {
    trackedFiles,
    documents,
    foundationEvidenceSha256,
    foundationAcceptance: await readOptionalJson(
      resolve(outputDirectory, "foundation-acceptance.json"),
    ),
    metadataFixtures: await readOptionalJson(resolve(outputDirectory, "metadata-fixtures.json")),
    negativeFixtures: await readOptionalJson(
      resolve(outputDirectory, "metadata-negative-fixtures.json"),
    ),
  };
}

function validateFoundation(value: unknown, violations: string[]): void {
  if (!isRecord(value) || value.status !== "PASS") {
    violations.push("The same run must produce a PASS Foundation acceptance artifact.");
  }
}

function validateMetadataFixtures(
  value: unknown,
  policy: MetadataEvidencePolicy,
  violations: string[],
): void {
  if (!isRecord(value) || value.status !== "PASS") {
    violations.push("Metadata fixture audit must PASS.");
    return;
  }
  if (value.fixtureCount !== policy.metadataFixtures.paths.length) {
    violations.push(
      `Metadata fixture count must be ${String(policy.metadataFixtures.paths.length)}.`,
    );
  }
  const fixtures = Array.isArray(value.fixtures) ? value.fixtures.filter(isRecord) : [];
  const paths = fixtures
    .flatMap((fixture) => (typeof fixture.path === "string" ? [fixture.path] : []))
    .sort();
  if (JSON.stringify(paths) !== JSON.stringify([...policy.metadataFixtures.paths].sort())) {
    violations.push("Metadata fixture paths differ from the evidence policy.");
  }
  if (!isSha256(value.fixtureDigest) || !isSha256(value.compatibilityVectorSha256)) {
    violations.push("Metadata fixture and compatibility vector digests must be SHA-256.");
  }
  if (typeof value.compatibilityCaseCount !== "number" || value.compatibilityCaseCount < 2) {
    violations.push("Metadata compatibility vectors must include at least two cases.");
  }
}

function validateNegativeFixtures(
  value: unknown,
  policy: MetadataEvidencePolicy,
  violations: string[],
): void {
  if (!isRecord(value) || value.status !== "PASS") {
    violations.push("Metadata negative fixture audit must PASS.");
    return;
  }
  const coveredIds = Array.isArray(value.coveredIds)
    ? value.coveredIds.filter((id): id is string => typeof id === "string").sort()
    : [];
  if (JSON.stringify(coveredIds) !== JSON.stringify([...policy.negativeFixtureIds].sort())) {
    violations.push("Metadata negative fixture IDs differ from the evidence policy.");
  }
  if (!isSha256(value.catalogSha256) || !isSha256(value.evidenceSha256)) {
    violations.push("Metadata negative fixture digests must be SHA-256.");
  }
}

function compactStep(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    name: stringProperty(value, "name"),
    command: stringProperty(value, "command"),
    status: stringProperty(value, "status"),
    durationMs: numberProperty(value, "durationMs"),
    testCount: numberProperty(value, "testCount"),
  };
}

function assertPolicy(value: unknown): asserts value is MetadataEvidencePolicy {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.gate !== "G2-01" ||
    !isStringArray(value.requiredEvidence) ||
    !isRecord(value.protectedFoundationEvidence) ||
    !Object.values(value.protectedFoundationEvidence).every(isSha256) ||
    !isRecord(value.metadataFixtures) ||
    !isStringArray(value.metadataFixtures.paths) ||
    typeof value.metadataFixtures.compatibilityVector !== "string" ||
    !isStringArray(value.negativeFixtureIds) ||
    !isStringArray(value.requiredGates) ||
    typeof value.owner !== "string" ||
    !Array.isArray(value.residualRisks)
  ) {
    throw new Error("G2-01 evidence policy is invalid.");
  }
  for (const list of [
    value.requiredEvidence,
    value.metadataFixtures.paths,
    value.negativeFixtureIds,
    value.requiredGates,
  ]) {
    if (new Set(list).size !== list.length) throw new Error("G2-01 evidence policy is invalid.");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function stringArrayProperty(value: Readonly<Record<string, unknown>>, key: string): string[] {
  const candidate = value[key];
  return Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string")
    : [];
}

function stringProperty(value: Readonly<Record<string, unknown>>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

function numberProperty(value: Readonly<Record<string, unknown>>, key: string): number | null {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function parseRecord(contents: string, label: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(contents);
  if (!isRecord(value)) throw new Error(`${label} is not an object.`);
  return value;
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...arguments_], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ exitCode: code ?? 1, stdout, stderr }));
  });
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    await checkMetadataEvidence(repositoryRoot);
  } catch (error) {
    process.stderr.write(`metadata acceptance: FAIL (${String(error)})\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
