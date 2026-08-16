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

interface MutationCheck {
  readonly id: string;
  readonly source: string;
  readonly marker: string;
  readonly script: string;
  readonly routeToken: string;
  readonly requiredGate: string;
}

export interface MaterializationEvidencePolicy {
  readonly schemaVersion: 1;
  readonly gate: "G2-02";
  readonly baselineCommit: string;
  readonly requiredEvidence: readonly string[];
  readonly requiredReviews: readonly string[];
  readonly scope: {
    readonly allowedExactPaths: readonly string[];
    readonly allowedPrefixes: readonly string[];
    readonly forbiddenPrefixes: readonly string[];
  };
  readonly fixtures: {
    readonly digest: string;
    readonly domainCount: number;
    readonly memberCount: number;
    readonly negativeFixtureIds: readonly string[];
    readonly benchmarkObjectCount: number;
    readonly benchmarkLinkCount: number;
  };
  readonly productionStages: readonly string[];
  readonly mutationChecks: readonly MutationCheck[];
  readonly requiredGates: readonly string[];
  readonly owner: string;
  readonly residualRisks: readonly ResidualRisk[];
}

export interface MaterializationEvidenceSnapshot {
  readonly trackedFiles: readonly string[];
  readonly changedFiles: readonly string[];
  readonly documents: Readonly<Record<string, string | undefined>>;
  readonly foundationAcceptance: unknown;
  readonly metadataAcceptance: unknown;
  readonly fixtures: unknown;
  readonly production: unknown;
  readonly sourceTexts: Readonly<Record<string, string | undefined>>;
  readonly packageScripts: Readonly<Record<string, string>>;
}

export function evaluateMaterializationEvidenceSnapshot(
  snapshot: MaterializationEvidenceSnapshot,
  policy: MaterializationEvidencePolicy,
): readonly string[] {
  assertPolicy(policy);
  const violations: string[] = [];
  const tracked = new Set(snapshot.trackedFiles);

  for (const path of [...policy.requiredEvidence, ...policy.requiredReviews]) {
    if (!tracked.has(path)) violations.push(`Required G2-02 record is not Git tracked: ${path}.`);
    const contents = snapshot.documents[path];
    if (contents === undefined) violations.push(`Required G2-02 record is missing: ${path}.`);
    else if (!contents.includes("- 结论：**PASS"))
      violations.push(`Required G2-02 record is not PASS: ${path}.`);
  }

  for (const path of snapshot.changedFiles) {
    if (policy.scope.forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
      violations.push(`G2-02 scope forbids changed path ${path}.`);
      continue;
    }
    const allowed =
      policy.scope.allowedExactPaths.includes(path) ||
      policy.scope.allowedPrefixes.some((prefix) => path.startsWith(prefix));
    if (!allowed) violations.push(`G2-02 scope does not allow changed path ${path}.`);
  }

  validatePriorAcceptance(snapshot.foundationAcceptance, "Foundation", violations);
  validatePriorAcceptance(snapshot.metadataAcceptance, "Metadata", violations);
  validateFixtures(snapshot.fixtures, policy, violations);
  validateProduction(snapshot.production, policy, violations);
  validateMutations(snapshot, policy, tracked, violations);
  return violations;
}

export function materializationEvidenceManifest(
  report: Readonly<Record<string, unknown>>,
  acceptance: Readonly<Record<string, unknown>>,
  production: unknown,
): Readonly<Record<string, unknown>> {
  const steps = Array.isArray(report.steps) ? report.steps.filter(isRecord) : [];
  const requiredGates = stringArrayProperty(acceptance, "requiredGates");
  const gatesPassed = requiredGates.every(
    (gate) => steps.filter((step) => step.name === gate && step.status === "PASS").length === 1,
  );
  const productionPassed = isRecord(production) && production.status === "PASS";
  const status =
    report.status === "PASS" && acceptance.status === "PASS" && gatesPassed && productionPassed
      ? "PASS"
      : "FAIL";
  const cleanCheckout = report.dirty === false;
  return {
    schemaVersion: 1,
    gate: "G2-02-13",
    status,
    qualification:
      status === "PASS" && cleanCheckout
        ? "PRODUCTION_BOUNDARY_PASS"
        : status === "PASS"
          ? "WORKTREE_PASS"
          : "FAIL",
    commit: stringProperty(report, "commit"),
    cleanCheckout,
    command: "npm run verify",
    startedAt: stringProperty(report, "startedAt"),
    completedAt: stringProperty(report, "completedAt"),
    durationMs: numberProperty(report, "durationMs"),
    testCount: steps.reduce((sum, step) => sum + (numberProperty(step, "testCount") ?? 0), 0),
    environment: report.environment ?? null,
    postgres: report.postgres ?? null,
    inputs: report.inputs ?? null,
    results: steps.map(compactStep),
    artifactDigests: report.artifacts ?? [],
    artifactCounts: report.artifactCounts ?? null,
    evidence: acceptance.evidence ?? [],
    reviews: acceptance.reviews ?? [],
    fixtures: acceptance.fixtures ?? null,
    production,
    mutations: acceptance.mutations ?? null,
    scope: acceptance.scope ?? null,
    owner: acceptance.owner ?? null,
    unclosedRisks: acceptance.residualRisks ?? [],
  };
}

export async function writeMaterializationEvidenceManifest(
  outputDirectory: string,
  report: Readonly<Record<string, unknown>>,
): Promise<void> {
  const acceptance = parseRecord(
    await readFile(resolve(outputDirectory, "materialization-acceptance.json"), "utf8"),
    "Materialization acceptance artifact",
  );
  const production = await readOptionalJson(
    resolve(outputDirectory, "materialization-production.json"),
  );
  const manifest = materializationEvidenceManifest(report, acceptance, production);
  await writeFile(
    resolve(outputDirectory, "materialization-evidence-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (manifest.status !== "PASS") {
    throw new Error("Materialization evidence manifest is incomplete.");
  }
}

async function checkMaterializationEvidence(repositoryRoot: string): Promise<void> {
  const policy = await loadPolicy(repositoryRoot);
  const snapshot = await loadSnapshot(repositoryRoot, policy);
  const violations = evaluateMaterializationEvidenceSnapshot(snapshot, policy);
  const outputDirectory = resolve(repositoryRoot, "generated/ci-report");
  await mkdir(outputDirectory, { recursive: true });
  const fixtureRecord = isRecord(snapshot.fixtures) ? snapshot.fixtures : {};
  const productionRecord = isRecord(snapshot.production) ? snapshot.production : {};
  const mutationSources = Object.fromEntries(
    [...new Set(policy.mutationChecks.map(({ source }) => source))].map((path) => [
      path,
      digestText(snapshot.sourceTexts[path] ?? ""),
    ]),
  );
  const mutationArtifact = {
    schemaVersion: 1,
    gate: "G2-02-13",
    status: violations.some((violation) => violation.startsWith("Mutation ")) ? "FAIL" : "PASS",
    checks: policy.mutationChecks.map(({ id, source, requiredGate }) => ({
      id,
      source,
      requiredGate,
    })),
    sourceSha256: mutationSources,
  };
  await writeFile(
    resolve(outputDirectory, "materialization-mutations.json"),
    `${JSON.stringify(mutationArtifact, null, 2)}\n`,
  );
  const artifact = {
    schemaVersion: 1,
    gate: "G2-02-13",
    status: violations.length === 0 ? "PASS" : "FAIL",
    evidence: policy.requiredEvidence,
    reviews: policy.requiredReviews,
    scope: {
      baselineCommit: policy.baselineCommit,
      changedFiles: snapshot.changedFiles,
      forbiddenPrefixes: policy.scope.forbiddenPrefixes,
    },
    fixtures: {
      fixtureDigest: fixtureRecord.fixtureDigest ?? null,
      domainCount: fixtureRecord.domainCount ?? null,
      memberCount: fixtureRecord.memberCount ?? null,
      negativeFixtureIds: fixtureRecord.negativeFixtureIds ?? [],
      benchmark: fixtureRecord.benchmark ?? null,
    },
    production: {
      fixtureDigest: productionRecord.fixtureDigest ?? null,
      completedStages: productionRecord.completedStages ?? [],
      dependencies: productionRecord.dependencies ?? null,
      assertions: productionRecord.assertions ?? null,
    },
    mutations: mutationArtifact,
    requiredGates: policy.requiredGates,
    owner: policy.owner,
    residualRisks: policy.residualRisks,
    violations,
  };
  await writeFile(
    resolve(outputDirectory, "materialization-acceptance.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  if (violations.length > 0) throw new Error(violations.join(" "));
  process.stdout.write(
    `materialization acceptance: PASS (${String(policy.requiredEvidence.length)} evidence records, ${String(policy.mutationChecks.length)} mutation checks, ${String(policy.requiredGates.length)} required gates)\n`,
  );
}

async function loadPolicy(repositoryRoot: string): Promise<MaterializationEvidencePolicy> {
  const value: unknown = JSON.parse(
    await readFile(resolve(repositoryRoot, "security/g2-02-evidence-policy.json"), "utf8"),
  );
  assertPolicy(value);
  return value;
}

async function loadSnapshot(
  repositoryRoot: string,
  policy: MaterializationEvidencePolicy,
): Promise<MaterializationEvidenceSnapshot> {
  const [trackedResult, changedResult] = await Promise.all([
    run("git", ["ls-files", "-z"], repositoryRoot),
    run("git", ["diff", "--name-only", "-z", policy.baselineCommit, "--"], repositoryRoot),
  ]);
  if (trackedResult.exitCode !== 0) throw new Error(`git ls-files failed: ${trackedResult.stderr}`);
  if (changedResult.exitCode !== 0) {
    throw new Error(
      `git diff from G2-02-12 baseline failed; CI must use full history: ${changedResult.stderr}`,
    );
  }
  const trackedFiles = nulPaths(trackedResult.stdout);
  const changedFiles = nulPaths(changedResult.stdout);
  const documentPaths = [...policy.requiredEvidence, ...policy.requiredReviews];
  const documents = Object.fromEntries(
    await Promise.all(
      documentPaths.map(async (path) => [
        path,
        await readFile(resolve(repositoryRoot, path), "utf8").catch(() => undefined),
      ]),
    ),
  ) as Readonly<Record<string, string | undefined>>;
  const sourceTexts = Object.fromEntries(
    await Promise.all(
      [...new Set(policy.mutationChecks.map(({ source }) => source))].map(async (path) => [
        path,
        await readFile(resolve(repositoryRoot, path), "utf8").catch(() => undefined),
      ]),
    ),
  ) as Readonly<Record<string, string | undefined>>;
  const packageValue: unknown = JSON.parse(
    await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
  );
  const outputDirectory = resolve(repositoryRoot, "generated/ci-report");
  return {
    trackedFiles,
    changedFiles,
    documents,
    foundationAcceptance: await readOptionalJson(
      resolve(outputDirectory, "foundation-acceptance.json"),
    ),
    metadataAcceptance: await readOptionalJson(
      resolve(outputDirectory, "metadata-acceptance.json"),
    ),
    fixtures: await readOptionalJson(resolve(outputDirectory, "materialization-fixtures.json")),
    production: await readOptionalJson(resolve(outputDirectory, "materialization-production.json")),
    sourceTexts,
    packageScripts: readScripts(packageValue),
  };
}

function validatePriorAcceptance(value: unknown, name: string, violations: string[]): void {
  if (!isRecord(value) || value.status !== "PASS") {
    violations.push(`The same run must produce a PASS ${name} acceptance artifact.`);
  }
}

function validateFixtures(
  value: unknown,
  policy: MaterializationEvidencePolicy,
  violations: string[],
): void {
  if (!isRecord(value) || value.status !== "PASS") {
    violations.push("Materialization fixture audit must PASS.");
    return;
  }
  if (value.fixtureDigest !== policy.fixtures.digest)
    violations.push("Materialization fixture digest differs from policy.");
  if (value.domainCount !== policy.fixtures.domainCount)
    violations.push("Materialization fixture domain count differs from policy.");
  if (value.memberCount !== policy.fixtures.memberCount)
    violations.push("Materialization fixture member count differs from policy.");
  if (!sameStrings(value.negativeFixtureIds, policy.fixtures.negativeFixtureIds))
    violations.push("Materialization negative fixture IDs differ from policy.");
  const benchmark = isRecord(value.benchmark) ? value.benchmark : {};
  if (
    benchmark.objectCount !== policy.fixtures.benchmarkObjectCount ||
    benchmark.linkCount !== policy.fixtures.benchmarkLinkCount
  ) {
    violations.push("Materialization benchmark fixture must remain 100k Objects / 1m Links.");
  }
}

function validateProduction(
  value: unknown,
  policy: MaterializationEvidencePolicy,
  violations: string[],
): void {
  if (!isRecord(value) || value.status !== "PASS") {
    violations.push("Production Materialization boundary must PASS.");
    return;
  }
  if (value.fixtureDigest !== policy.fixtures.digest)
    violations.push("Production boundary is not bound to the approved fixture digest.");
  if (!sameStringsInOrder(value.completedStages, policy.productionStages))
    violations.push("Production Worker did not complete the exact eight-stage pipeline.");
  const assertions = isRecord(value.assertions) ? value.assertions : {};
  for (const key of [
    "oidcAdminHttp",
    "managedVersionedObjectStore",
    "productionWorker",
    "ddlExecutor",
    "ownerActivationChanged",
    "releasePublished",
  ]) {
    if (assertions[key] !== true) violations.push(`Production assertion ${key} must be true.`);
  }
  if (assertions.servingPointerBeforeOwner !== 0)
    violations.push("Serving pointer became visible before Owner activation.");
}

function validateMutations(
  snapshot: MaterializationEvidenceSnapshot,
  policy: MaterializationEvidencePolicy,
  tracked: ReadonlySet<string>,
  violations: string[],
): void {
  const expectedIds = [
    "capacity",
    "cutover_atomicity",
    "job_fencing",
    "migration",
    "oidc",
    "plan_digest",
    "scope",
    "staging_visibility",
  ];
  if (
    !sameStrings(
      policy.mutationChecks.map(({ id }) => id),
      expectedIds,
    )
  ) {
    violations.push("Mutation checks must cover exactly the eight G2-02-13 failure classes.");
  }
  for (const mutation of policy.mutationChecks) {
    if (!tracked.has(mutation.source))
      violations.push(`Mutation ${mutation.id} source is not Git tracked: ${mutation.source}.`);
    const source = snapshot.sourceTexts[mutation.source];
    const count = source === undefined ? 0 : source.split(mutation.marker).length - 1;
    if (count !== 1)
      violations.push(
        `Mutation ${mutation.id} marker must occur exactly once; found ${String(count)}.`,
      );
    const script = snapshot.packageScripts[mutation.script];
    if (script === undefined || !script.includes(mutation.routeToken)) {
      violations.push(`Mutation ${mutation.id} is not routed by npm script ${mutation.script}.`);
    }
    if (!policy.requiredGates.includes(mutation.requiredGate)) {
      violations.push(`Mutation ${mutation.id} required gate is absent from the unified gate.`);
    }
  }
}

function assertPolicy(value: unknown): asserts value is MaterializationEvidencePolicy {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.gate !== "G2-02" ||
    typeof value.baselineCommit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.baselineCommit) ||
    !isStringArray(value.requiredEvidence) ||
    !isStringArray(value.requiredReviews) ||
    !isRecord(value.scope) ||
    !isStringArray(value.scope.allowedExactPaths) ||
    !isStringArray(value.scope.allowedPrefixes) ||
    !isStringArray(value.scope.forbiddenPrefixes) ||
    !isRecord(value.fixtures) ||
    typeof value.fixtures.digest !== "string" ||
    !isStringArray(value.fixtures.negativeFixtureIds) ||
    !isStringArray(value.productionStages) ||
    !Array.isArray(value.mutationChecks) ||
    !isStringArray(value.requiredGates) ||
    typeof value.owner !== "string" ||
    !Array.isArray(value.residualRisks)
  ) {
    throw new Error("G2-02 evidence policy is invalid.");
  }
  for (const list of [
    value.requiredEvidence,
    value.requiredReviews,
    value.scope.allowedExactPaths,
    value.scope.allowedPrefixes,
    value.scope.forbiddenPrefixes,
    value.fixtures.negativeFixtureIds,
    value.productionStages,
    value.requiredGates,
  ]) {
    if (new Set(list).size !== list.length)
      throw new Error("G2-02 evidence policy has duplicates.");
  }
  for (const mutation of value.mutationChecks) {
    if (
      !isRecord(mutation) ||
      !["id", "source", "marker", "script", "routeToken", "requiredGate"].every(
        (key) => typeof mutation[key] === "string",
      )
    ) {
      throw new Error("G2-02 mutation policy is invalid.");
    }
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

function readScripts(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value) || !isRecord(value.scripts)) return {};
  return Object.fromEntries(
    Object.entries(value.scripts).flatMap(([key, command]) =>
      typeof command === "string" ? [[key, command]] : [],
    ),
  );
}

function nulPaths(value: string): string[] {
  return value.split("\0").filter(Boolean).sort();
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return false;
  return JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
}

function sameStringsInOrder(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected);
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function stringArrayProperty(value: Readonly<Record<string, unknown>>, key: string): string[] {
  const candidate = value[key];
  return isStringArray(candidate) ? [...candidate] : [];
}

function stringProperty(value: Readonly<Record<string, unknown>>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

function numberProperty(value: Readonly<Record<string, unknown>>, key: string): number | null {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(value: string, label: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error(`${label} must be an object.`);
  return parsed;
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
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
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ exitCode: code ?? 1, stdout, stderr }));
  });
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    await checkMaterializationEvidence(repositoryRoot);
  } catch (error) {
    process.stderr.write(`materialization evidence: FAIL (${String(error)})\n`);
    process.exitCode = 1;
  }
}
