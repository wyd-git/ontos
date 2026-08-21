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

export interface G20308EvidencePolicy {
  readonly schemaVersion: 1;
  readonly gate: "G2-03-08";
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

export interface G20308EvidenceSnapshot {
  readonly currentCommit: string;
  readonly trackedFiles: readonly string[];
  readonly changedFiles: readonly string[];
  readonly documents: Readonly<Record<string, string | undefined>>;
  readonly sourceTexts: Readonly<Record<string, string | undefined>>;
  readonly foundationPolicy: unknown;
  readonly priorPolicies: Readonly<Record<string, unknown>>;
  readonly runtimeQueryArtifact: unknown;
}

const commitPattern = /^[0-9a-f]{40}$/u;
const migrationPath = "migrations/db-00/0028_runtime_query_context.sql";
const forwardExactPaths = Object.freeze([
  "docs/architecture/adr/026-runtime-query-context-metadata-object-get.md",
  "docs/evidence/g2-03-08-runtime-metadata-object-get.md",
  "docs/reviews/g2-03-08-intended-vs-implemented.md",
  migrationPath,
  "security/g2-03-08-evidence-policy.json",
  "tools/ci/g2-03-08-evidence.test.ts",
  "tools/ci/g2-03-08-evidence.ts",
]);
const forwardPrefixes = Object.freeze([
  "packages/query-application/",
  "packages/query-domain/",
  "packages/query-postgres/",
  "tools/runtime-query/",
]);
const requiredAssertions = Object.freeze([
  "candidateResolvedOncePerRequest",
  "atomicContextRevalidationBeforeLeaseCommit",
  "committedLeaseBeforeCurrentRead",
  "leaseActivationOrderedBeforeCurrentRead",
  "exactLeaseGatedCurrentView",
  "metadataIsActorDiscoverable",
  "canonicalPrimaryKeyAndExactRevisionGeneration",
  "objectVersionStable",
  "absentAndInvisibleShare404Boundary",
  "propertyFiveStateSerializerDefense",
  "servingHeadDriftFailsWithoutLease",
  "authorizationEpochDriftFailsWithoutLease",
  "killedOwnerLeaseExpiresAndDropsGcRoot",
  "releaseSupportWindowImmutable",
  "explicitRetirementHasNoStableFallback",
  "apiHasNoRawCurrentGrant",
  "workerAndOpsCannotUseQuerySurface",
]);

export function evaluateG20308EvidenceSnapshot(
  snapshot: G20308EvidenceSnapshot,
  policy: G20308EvidencePolicy,
): readonly string[] {
  assertPolicy(policy);
  const violations: string[] = [];
  const tracked = new Set(snapshot.trackedFiles);
  if (!commitPattern.test(snapshot.currentCommit)) violations.push("Current commit is invalid.");

  for (const record of policy.requiredRecords) {
    if (!tracked.has(record.path))
      violations.push(`Required record is not tracked: ${record.path}.`);
    const contents = snapshot.documents[record.path];
    if (contents === undefined) violations.push(`Required record is missing: ${record.path}.`);
    else if (!contents.includes(record.marker)) {
      violations.push(`Required record marker is missing: ${record.path}.`);
    }
  }

  for (const path of snapshot.changedFiles) {
    const allowed =
      policy.scope.allowedExactPaths.includes(path) ||
      policy.scope.allowedPrefixes.some((prefix) => path.startsWith(prefix));
    if (!allowed) violations.push(`G2-03-08 does not allow changed path ${path}.`);
    else if (
      !policy.scope.allowedExactPaths.includes(path) &&
      policy.scope.forbiddenPrefixes.some((prefix) => path.startsWith(prefix))
    ) {
      violations.push(`G2-03-08 forbids changed path ${path}.`);
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
      if (!contents.includes(marker))
        violations.push(`Source marker missing: ${source.path}:${marker}.`);
    }
  }

  validateForwardPolicies(snapshot, violations);
  validateRuntimeQueryArtifact(snapshot.runtimeQueryArtifact, snapshot.currentCommit, violations);
  return violations;
}

export function g20308EvidenceManifest(
  report: Readonly<Record<string, unknown>>,
  acceptance: Readonly<Record<string, unknown>>,
  runtimeQueryArtifact: unknown,
): Readonly<Record<string, unknown>> {
  const steps = Array.isArray(report.steps) ? report.steps.filter(isRecord) : [];
  const requiredGates = stringArrayProperty(acceptance, "requiredGates");
  const gatesPassed = requiredGates.every(
    (gate) => steps.filter((step) => step.name === gate && step.status === "PASS").length === 1,
  );
  const artifactViolations: string[] = [];
  validateRuntimeQueryArtifact(
    runtimeQueryArtifact,
    stringProperty(report, "commit") ?? "",
    artifactViolations,
  );
  const cleanCheckout = report.dirty === false;
  const status =
    report.status === "PASS" &&
    acceptance.status === "PASS" &&
    gatesPassed &&
    artifactViolations.length === 0 &&
    cleanCheckout
      ? "PASS"
      : "FAIL";
  return {
    schemaVersion: 1,
    gate: "G2-03-08",
    status,
    qualification: status === "PASS" ? "CLEAN_ROOM_PASS" : "FAIL",
    commit: stringProperty(report, "commit"),
    cleanCheckout,
    command: "npm run verify",
    startedAt: stringProperty(report, "startedAt"),
    completedAt: stringProperty(report, "completedAt"),
    durationMs: numberProperty(report, "durationMs"),
    results: steps.map(compactStep),
    records: acceptance.records ?? [],
    scope: acceptance.scope ?? null,
    runtimeQuery: runtimeQueryArtifact,
    owner: acceptance.owner ?? null,
    unclosedRisks: acceptance.residualRisks ?? [],
  };
}

export async function writeG20308EvidenceManifest(
  outputDirectory: string,
  report: Readonly<Record<string, unknown>>,
): Promise<void> {
  const acceptance = parseRecord(
    await readFile(resolve(outputDirectory, "g2-03-08-acceptance.json"), "utf8"),
    "G2-03-08 acceptance",
  );
  const artifact = await readOptionalJson(resolve(outputDirectory, "g2-03-08-runtime-query.json"));
  const manifest = g20308EvidenceManifest(report, acceptance, artifact);
  await writeFile(
    resolve(outputDirectory, "g2-03-08-evidence-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (manifest.status !== "PASS") throw new Error("G2-03-08 evidence manifest is incomplete.");
}

async function checkG20308Evidence(repositoryRoot: string): Promise<void> {
  const policy = await loadPolicy(repositoryRoot);
  const snapshot = await loadSnapshot(repositoryRoot, policy);
  const violations = evaluateG20308EvidenceSnapshot(snapshot, policy);
  const outputDirectory = resolve(repositoryRoot, "generated/ci-report");
  await mkdir(outputDirectory, { recursive: true });
  const artifact = {
    schemaVersion: 1,
    gate: "G2-03-08",
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
    resolve(outputDirectory, "g2-03-08-acceptance.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  if (violations.length > 0) throw new Error(violations.join(" "));
  process.stdout.write(
    `g2-03-08 acceptance: PASS (${String(policy.requiredRecords.length)} records, ${String(policy.requiredGates.length)} gates)\n`,
  );
}

async function loadSnapshot(
  repositoryRoot: string,
  policy: G20308EvidencePolicy,
): Promise<G20308EvidenceSnapshot> {
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
  const documentEntries = await Promise.all(
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
  const priorPolicies = await Promise.all(
    [
      "g2-02",
      "g2-03-01",
      "g2-03-02",
      "g2-03-03",
      "g2-03-04",
      "g2-03-05",
      "g2-03-06",
      "g2-03-07",
    ].map(async (gate): Promise<readonly [string, unknown]> => [
      gate,
      await readOptionalJson(resolve(repositoryRoot, `security/${gate}-evidence-policy.json`)),
    ]),
  );
  return {
    currentCommit: commit.trim(),
    trackedFiles: tracked.split("\0").filter(Boolean),
    changedFiles: changed.split("\0").filter(Boolean),
    documents: Object.fromEntries(documentEntries),
    sourceTexts: Object.fromEntries(sourceEntries),
    foundationPolicy: await readOptionalJson(
      resolve(repositoryRoot, "security/g2-00-evidence-policy.json"),
    ),
    priorPolicies: Object.fromEntries(priorPolicies),
    runtimeQueryArtifact: await readOptionalJson(
      resolve(repositoryRoot, "generated/ci-report/g2-03-08-runtime-query.json"),
    ),
  };
}

function validateForwardPolicies(snapshot: G20308EvidenceSnapshot, violations: string[]): void {
  const foundationScope = nestedRecord(snapshot.foundationPolicy, "scope");
  const migrations = stringArrayProperty(foundationScope, "allowedMigrationFiles");
  if (!migrations.includes(migrationPath)) {
    violations.push("Foundation scope does not admit the G2-03-08 migration.");
  }
  for (const [gate, candidate] of Object.entries(snapshot.priorPolicies)) {
    const scope = nestedRecord(candidate, "scope");
    const exact = stringArrayProperty(scope, "allowedExactPaths");
    const prefixes = stringArrayProperty(scope, "allowedPrefixes");
    if (
      !forwardExactPaths.every((path) => exact.includes(path)) ||
      !forwardPrefixes.every((prefix) => prefixes.includes(prefix))
    ) {
      violations.push(`${gate} forward scope does not admit G2-03-08 Runtime Query work.`);
    }
  }
}

function validateRuntimeQueryArtifact(
  candidate: unknown,
  currentCommit: string,
  violations: string[],
): void {
  if (!isRecord(candidate)) {
    violations.push("G2-03-08 Runtime Query artifact is missing.");
    return;
  }
  const postgres = nestedRecord(candidate, "postgres");
  const assertions = nestedRecord(candidate, "assertions");
  const executionContext = nestedRecord(candidate, "executionContext");
  const leaseStates = Array.isArray(postgres.leaseStates)
    ? postgres.leaseStates.filter(isRecord)
    : [];
  const stateCount = (state: string, missing = -1): number => {
    const value = leaseStates.find((entry) => entry.state === state)?.count;
    return typeof value === "number" ? value : missing;
  };
  if (
    candidate.schemaVersion !== 1 ||
    candidate.gate !== "G2-03-08" ||
    candidate.status !== "PASS" ||
    candidate.qualification !== "REAL_POSTGRES_16_RUNTIME_METADATA_OBJECT_GET" ||
    candidate.commit !== currentCommit ||
    candidate.cleanCheckout !== true ||
    typeof postgres.serverVersionNum !== "string" ||
    !/^16[0-9]{4}$/u.test(postgres.serverVersionNum) ||
    stateCount("committed", 0) !== 0 ||
    stateCount("released") < 5 ||
    stateCount("expired") < 1 ||
    postgres.retiredServingHeadCount !== 0 ||
    !Array.isArray(executionContext.selectorKinds) ||
    executionContext.selectorKinds.join(",") !== "release,channel" ||
    !requiredAssertions.every((name) => assertions[name] === true)
  ) {
    violations.push("G2-03-08 Runtime Query artifact is incomplete.");
  }
}

function assertPolicy(value: unknown): asserts value is G20308EvidencePolicy {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.gate !== "G2-03-08" ||
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
    typeof value.owner !== "string" ||
    !Array.isArray(value.residualRisks) ||
    !value.residualRisks.every(isResidualRisk)
  ) {
    throw new Error("G2-03-08 evidence policy is invalid.");
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

function compactStep(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    name: stringProperty(value, "name"),
    command: stringProperty(value, "command"),
    status: stringProperty(value, "status"),
    durationMs: numberProperty(value, "durationMs"),
  };
}

function nestedRecord(value: unknown, key: string): Readonly<Record<string, unknown>> {
  return isRecord(value) && isRecord(value[key]) ? value[key] : {};
}

function stringArrayProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  return isStringArray(value[key]) ? value[key] : [];
}

function stringProperty(value: Readonly<Record<string, unknown>>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function numberProperty(value: Readonly<Record<string, unknown>>, key: string): number | null {
  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : null;
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
  const contents = await readOptionalText(path);
  return contents === undefined ? undefined : (JSON.parse(contents) as unknown);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function loadPolicy(repositoryRoot: string): Promise<G20308EvidencePolicy> {
  const value: unknown = JSON.parse(
    await readFile(resolve(repositoryRoot, "security/g2-03-08-evidence-policy.json"), "utf8"),
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
    await checkG20308Evidence(repositoryRoot);
  } catch (error) {
    process.stderr.write(`g2-03-08 acceptance: FAIL (${String(error)})\n`);
    process.exitCode = 1;
  }
}
