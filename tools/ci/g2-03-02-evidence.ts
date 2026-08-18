import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface RequiredRecord {
  readonly path: string;
  readonly marker: string;
}

interface SourceMarker {
  readonly path: string;
  readonly markers: readonly string[];
}

interface ResidualRisk {
  readonly id: string;
  readonly risk: string;
  readonly owner: string;
  readonly nextGate: string;
}

export interface G20302EvidencePolicy {
  readonly schemaVersion: 1;
  readonly gate: "G2-03-02";
  readonly baselineCommit: string;
  readonly requiredRecords: readonly RequiredRecord[];
  readonly scope: {
    readonly allowedExactPaths: readonly string[];
    readonly allowedPrefixes: readonly string[];
    readonly forbiddenPrefixes: readonly string[];
  };
  readonly requiredSourceMarkers: readonly SourceMarker[];
  readonly requiredGates: readonly string[];
  readonly owner: string;
  readonly residualRisks: readonly ResidualRisk[];
}

export interface G20302EvidenceSnapshot {
  readonly currentCommit: string;
  readonly trackedFiles: readonly string[];
  readonly changedFiles: readonly string[];
  readonly documents: Readonly<Record<string, string | undefined>>;
  readonly sourceTexts: Readonly<Record<string, string | undefined>>;
  readonly rootPackageManifest: unknown;
  readonly clientPackageManifest: unknown;
  readonly foundationPolicy: unknown;
  readonly materializationPolicy: unknown;
  readonly priorGatePolicy: unknown;
  readonly generationArtifact: unknown;
}

const commitPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

export function evaluateG20302EvidenceSnapshot(
  snapshot: G20302EvidenceSnapshot,
  policy: G20302EvidencePolicy,
): readonly string[] {
  assertPolicy(policy);
  const violations: string[] = [];
  const tracked = new Set(snapshot.trackedFiles);
  if (!commitPattern.test(snapshot.currentCommit)) violations.push("Current commit is invalid.");

  for (const required of policy.requiredRecords) {
    if (!tracked.has(required.path)) {
      violations.push(`Required record is not tracked: ${required.path}.`);
    }
    const contents = snapshot.documents[required.path];
    if (contents === undefined) violations.push(`Required record is missing: ${required.path}.`);
    else if (!contents.includes(required.marker)) {
      violations.push(`Required record marker is missing: ${required.path}.`);
    }
  }

  for (const path of snapshot.changedFiles) {
    if (policy.scope.forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
      violations.push(`G2-03-02 forbids changed path ${path}.`);
      continue;
    }
    if (
      !policy.scope.allowedExactPaths.includes(path) &&
      !policy.scope.allowedPrefixes.some((prefix) => path.startsWith(prefix))
    ) {
      violations.push(`G2-03-02 does not allow changed path ${path}.`);
    }
  }

  for (const source of policy.requiredSourceMarkers) {
    if (!tracked.has(source.path))
      violations.push(`Required source is not tracked: ${source.path}.`);
    const contents = snapshot.sourceTexts[source.path];
    if (contents === undefined) {
      violations.push(`Required source is missing: ${source.path}.`);
      continue;
    }
    for (const marker of source.markers) {
      if (!contents.includes(marker)) {
        violations.push(`Source marker missing: ${source.path}:${marker}.`);
      }
    }
    if (contents.includes("spikes/g1")) {
      violations.push(`Formal Runtime Read source imports G1: ${source.path}.`);
    }
  }

  validatePackageBoundary(snapshot.rootPackageManifest, snapshot.clientPackageManifest, violations);
  validateForwardScopePolicies(
    snapshot.foundationPolicy,
    snapshot.materializationPolicy,
    snapshot.priorGatePolicy,
    violations,
  );
  validateGenerationArtifact(snapshot.generationArtifact, violations);
  return violations;
}

export function g20302EvidenceManifest(
  report: Readonly<Record<string, unknown>>,
  acceptance: Readonly<Record<string, unknown>>,
  generationArtifact: unknown,
): Readonly<Record<string, unknown>> {
  const steps = Array.isArray(report.steps) ? report.steps.filter(isRecord) : [];
  const requiredGates = stringArrayProperty(acceptance, "requiredGates");
  const gatesPassed = requiredGates.every(
    (gate) => steps.filter((step) => step.name === gate && step.status === "PASS").length === 1,
  );
  const generationPassed =
    isRecord(generationArtifact) &&
    generationArtifact.status === "PASS" &&
    generationArtifact.deterministic === true &&
    generationArtifact.generatedClientCompiled === true &&
    generationArtifact.strictPublicTypesCompiled === true &&
    generationArtifact.strictWebConsumerCompiled === true &&
    generationArtifact.distributionRuntimeImported === true;
  const status =
    report.status === "PASS" && acceptance.status === "PASS" && gatesPassed && generationPassed
      ? "PASS"
      : "FAIL";
  const cleanCheckout = report.dirty === false;
  return {
    schemaVersion: 1,
    gate: "G2-03-02",
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
    results: steps.map(compactStep),
    records: acceptance.records ?? [],
    scope: acceptance.scope ?? null,
    generation: generationArtifact,
    owner: acceptance.owner ?? null,
    unclosedRisks: acceptance.residualRisks ?? [],
  };
}

export async function writeG20302EvidenceManifest(
  outputDirectory: string,
  report: Readonly<Record<string, unknown>>,
): Promise<void> {
  const acceptance = parseRecord(
    await readFile(resolve(outputDirectory, "g2-03-02-acceptance.json"), "utf8"),
    "G2-03-02 acceptance",
  );
  const generation = await readOptionalJson(
    resolve(outputDirectory, "g2-03-02-runtime-read-generation.json"),
  );
  const manifest = g20302EvidenceManifest(report, acceptance, generation);
  await writeFile(
    resolve(outputDirectory, "g2-03-02-evidence-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (manifest.status !== "PASS") throw new Error("G2-03-02 evidence manifest is incomplete.");
}

async function checkG20302Evidence(repositoryRoot: string): Promise<void> {
  const policy = await loadPolicy(repositoryRoot);
  const snapshot = await loadSnapshot(repositoryRoot, policy);
  const violations = evaluateG20302EvidenceSnapshot(snapshot, policy);
  const outputDirectory = resolve(repositoryRoot, "generated/ci-report");
  await mkdir(outputDirectory, { recursive: true });
  const artifact = {
    schemaVersion: 1,
    gate: "G2-03-02",
    status: violations.length === 0 ? "PASS" : "FAIL",
    records: policy.requiredRecords.map(({ path }) => path),
    scope: {
      baselineCommit: policy.baselineCommit,
      changedFiles: snapshot.changedFiles,
      forbiddenPrefixes: policy.scope.forbiddenPrefixes,
    },
    requiredGates: policy.requiredGates,
    owner: policy.owner,
    residualRisks: policy.residualRisks,
    violations,
  };
  await writeFile(
    resolve(outputDirectory, "g2-03-02-acceptance.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  if (violations.length > 0) throw new Error(violations.join(" "));
  process.stdout.write(
    `g2-03-02 acceptance: PASS (${String(policy.requiredRecords.length)} records, ${String(policy.requiredGates.length)} gates)\n`,
  );
}

async function loadSnapshot(
  repositoryRoot: string,
  policy: G20302EvidencePolicy,
): Promise<G20302EvidenceSnapshot> {
  const [commit, tracked, changed] = await Promise.all([
    git(repositoryRoot, ["rev-parse", "HEAD"]),
    git(repositoryRoot, ["ls-files", "-z"]),
    git(repositoryRoot, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      policy.baselineCommit,
      "HEAD",
      "--",
    ]),
  ]);
  const recordEntries = await Promise.all(
    policy.requiredRecords.map(async ({ path }): Promise<readonly [string, string | undefined]> => [
      path,
      await readOptionalText(resolve(repositoryRoot, path)),
    ]),
  );
  const sourceEntries = await Promise.all(
    policy.requiredSourceMarkers.map(
      async ({ path }): Promise<readonly [string, string | undefined]> => [
        path,
        await readOptionalText(resolve(repositoryRoot, path)),
      ],
    ),
  );
  return {
    currentCommit: commit.trim(),
    trackedFiles: tracked.split("\0").filter(Boolean),
    changedFiles: changed.split("\0").filter(Boolean),
    documents: Object.fromEntries(recordEntries),
    sourceTexts: Object.fromEntries(sourceEntries),
    rootPackageManifest: await readOptionalJson(resolve(repositoryRoot, "package.json")),
    clientPackageManifest: await readOptionalJson(
      resolve(repositoryRoot, "packages/runtime-read-client/package.json"),
    ),
    foundationPolicy: await readOptionalJson(
      resolve(repositoryRoot, "security/g2-00-evidence-policy.json"),
    ),
    materializationPolicy: await readOptionalJson(
      resolve(repositoryRoot, "security/g2-02-evidence-policy.json"),
    ),
    priorGatePolicy: await readOptionalJson(
      resolve(repositoryRoot, "security/g2-03-01-evidence-policy.json"),
    ),
    generationArtifact: await readOptionalJson(
      resolve(repositoryRoot, "generated/ci-report/g2-03-02-runtime-read-generation.json"),
    ),
  };
}

function validatePackageBoundary(
  rootValue: unknown,
  clientValue: unknown,
  violations: string[],
): void {
  if (!isRecord(rootValue) || !isRecord(rootValue.scripts)) {
    violations.push("Root package manifest is unavailable.");
  } else if (
    rootValue.scripts["generate:runtime-read"] !==
      "node tools/contracts/runtime-read-generation.ts --write" ||
    rootValue.scripts["check:runtime-read-generation"] !==
      "node tools/contracts/runtime-read-generation.ts"
  ) {
    violations.push("Runtime Read generation commands are not reproducibly pinned.");
  }
  if (
    !isRecord(clientValue) ||
    clientValue.name !== "@ontos/runtime-read-client" ||
    clientValue.private !== true ||
    clientValue.type !== "module"
  ) {
    violations.push("Generated Runtime Read Client must remain a private Candidate package.");
  } else {
    const rootExport = isRecord(clientValue.exports) ? clientValue.exports["."] : undefined;
    if (
      !isRecord(rootExport) ||
      rootExport.types !== "./dist/package.d.ts" ||
      rootExport.import !== "./dist/package.js"
    ) {
      violations.push(
        "Runtime Read Client root must expose only the deterministic distribution boundary.",
      );
    }
  }
}

function validateForwardScopePolicies(
  foundationValue: unknown,
  materializationValue: unknown,
  priorGateValue: unknown,
  violations: string[],
): void {
  if (
    !isRecord(foundationValue) ||
    !isRecord(foundationValue.scope) ||
    !isStringArray(foundationValue.scope.allowedWorkspacePackages) ||
    !foundationValue.scope.allowedWorkspacePackages.includes("packages/runtime-read-client")
  ) {
    violations.push("Foundation scope does not admit the Runtime Read Client package.");
  }
  if (
    !hasAllowedPrefixes(materializationValue, [
      "packages/contracts/",
      "packages/runtime-read-client/",
      "tools/contracts/",
    ])
  ) {
    violations.push("G2-02 forward scope does not admit the formal Runtime Read contracts.");
  }
  if (
    !hasAllowedPrefixes(priorGateValue, [
      "packages/contracts/",
      "packages/runtime-read-client/",
      "tools/contracts/",
    ])
  ) {
    violations.push("G2-03-01 forward scope does not admit G2-03-02 contract artifacts.");
  }
}

function validateGenerationArtifact(candidate: unknown, violations: string[]): void {
  if (!isRecord(candidate)) {
    violations.push("Runtime Read generation artifact is missing.");
    return;
  }
  if (
    candidate.status !== "PASS" ||
    candidate.qualification !== "SINGLE_SOURCE_SCHEMA_OPENAPI_GENERATED_CLIENT" ||
    candidate.operationCount !== 5 ||
    candidate.generatedFileCount !== 17 ||
    candidate.distributionFileCount !== 34 ||
    candidate.deterministic !== true ||
    candidate.generatedClientCompiled !== true ||
    candidate.strictPublicTypesCompiled !== true ||
    candidate.strictWebConsumerCompiled !== true ||
    candidate.distributionRuntimeImported !== true ||
    typeof candidate.schemaSha256 !== "string" ||
    !sha256Pattern.test(candidate.schemaSha256) ||
    typeof candidate.openApiSha256 !== "string" ||
    !sha256Pattern.test(candidate.openApiSha256) ||
    typeof candidate.generatedSha256 !== "string" ||
    !sha256Pattern.test(candidate.generatedSha256) ||
    typeof candidate.distributionSha256 !== "string" ||
    !sha256Pattern.test(candidate.distributionSha256)
  ) {
    violations.push("Runtime Read generation artifact is incomplete.");
  }
  const optional = isRecord(candidate.exactOptionalPropertyTypes)
    ? candidate.exactOptionalPropertyTypes
    : null;
  if (
    optional?.publicTypes !== true ||
    optional.generatedTransport !== false ||
    optional.packagedWebConsumer !== true
  ) {
    violations.push("Generated transport strict-optional isolation is not explicitly evidenced.");
  }
}

function hasAllowedPrefixes(value: unknown, required: readonly string[]): boolean {
  if (!isRecord(value) || !isRecord(value.scope)) return false;
  const prefixes = value.scope.allowedPrefixes;
  return isStringArray(prefixes) && required.every((prefix) => prefixes.includes(prefix));
}

function assertPolicy(value: unknown): asserts value is G20302EvidencePolicy {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.gate !== "G2-03-02" ||
    typeof value.baselineCommit !== "string" ||
    !commitPattern.test(value.baselineCommit) ||
    !Array.isArray(value.requiredRecords) ||
    !value.requiredRecords.every(isRequiredRecord) ||
    !isRecord(value.scope) ||
    !isStringArray(value.scope.allowedExactPaths) ||
    !isStringArray(value.scope.allowedPrefixes) ||
    !isStringArray(value.scope.forbiddenPrefixes) ||
    !Array.isArray(value.requiredSourceMarkers) ||
    !value.requiredSourceMarkers.every(isSourceMarker) ||
    !isStringArray(value.requiredGates) ||
    new Set(value.requiredGates).size !== value.requiredGates.length ||
    typeof value.owner !== "string" ||
    !Array.isArray(value.residualRisks) ||
    !value.residualRisks.every(isResidualRisk)
  ) {
    throw new Error("G2-03-02 evidence policy is invalid.");
  }
}

function isRequiredRecord(value: unknown): value is RequiredRecord {
  return isRecord(value) && typeof value.path === "string" && typeof value.marker === "string";
}

function isSourceMarker(value: unknown): value is SourceMarker {
  return isRecord(value) && typeof value.path === "string" && isStringArray(value.markers);
}

function isResidualRisk(value: unknown): value is ResidualRisk {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.risk === "string" &&
    typeof value.owner === "string" &&
    typeof value.nextGate === "string"
  );
}

function compactStep(step: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    name: step.name ?? null,
    command: step.command ?? null,
    status: step.status ?? null,
    durationMs: step.durationMs ?? null,
    testCount: step.testCount ?? null,
  };
}

function stringArrayProperty(value: Readonly<Record<string, unknown>>, key: string): string[] {
  return isStringArray(value[key]) ? [...value[key]] : [];
}

function stringProperty(value: Readonly<Record<string, unknown>>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function numberProperty(value: Readonly<Record<string, unknown>>, key: string): number | null {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function parseRecord(text: string, label: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolveGit, rejectGit) => {
    const child = spawn("git", [...arguments_], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
    });
    child.once("error", rejectGit);
    child.once("close", (code, signal) => {
      if (signal !== null) rejectGit(new Error(`git ended with ${signal}.`));
      else if (code !== 0) rejectGit(new Error(`git failed: ${stderr}`));
      else resolveGit(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function loadPolicy(repositoryRoot: string): Promise<G20302EvidencePolicy> {
  const value: unknown = JSON.parse(
    await readFile(resolve(repositoryRoot, "security/g2-03-02-evidence-policy.json"), "utf8"),
  );
  assertPolicy(value);
  return value;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    await checkG20302Evidence(repositoryRoot);
  } catch (error) {
    process.stderr.write(`g2-03-02 acceptance: FAIL (${String(error)})\n`);
    process.exitCode = 1;
  }
}
