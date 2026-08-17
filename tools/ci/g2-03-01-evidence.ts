import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export interface G20301EvidencePolicy {
  readonly schemaVersion: 1;
  readonly gate: "G2-03-01";
  readonly baselineCommit: string;
  readonly requiredRecords: readonly RequiredRecord[];
  readonly scope: {
    readonly allowedExactPaths: readonly string[];
    readonly allowedPrefixes: readonly string[];
    readonly forbiddenPrefixes: readonly string[];
  };
  readonly requiredSourceMarkers: readonly SourceMarker[];
  readonly webStack: Readonly<Record<string, string>>;
  readonly requiredGates: readonly string[];
  readonly owner: string;
  readonly residualRisks: readonly ResidualRisk[];
}

export interface G20301EvidenceSnapshot {
  readonly currentCommit: string;
  readonly trackedFiles: readonly string[];
  readonly changedFiles: readonly string[];
  readonly documents: Readonly<Record<string, string | undefined>>;
  readonly sourceTexts: Readonly<Record<string, string | undefined>>;
  readonly packageManifest: unknown;
  readonly foundationPolicy: unknown;
  readonly materializationPolicy: unknown;
  readonly webArtifact: unknown;
  readonly postgresArtifact: unknown;
}

const commitPattern = /^[0-9a-f]{40}$/u;
const fixtureDomainPattern = /\b(?:Customer|Order|Worker|WorkItem)\b/u;

export function evaluateG20301EvidenceSnapshot(
  snapshot: G20301EvidenceSnapshot,
  policy: G20301EvidencePolicy,
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
    if (policy.scope.forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
      violations.push(`G2-03-01 forbids changed path ${path}.`);
      continue;
    }
    const allowed =
      policy.scope.allowedExactPaths.includes(path) ||
      policy.scope.allowedPrefixes.some((prefix) => path.startsWith(prefix));
    if (!allowed) violations.push(`G2-03-01 does not allow changed path ${path}.`);
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
    if (contents.includes("spikes/g1"))
      violations.push(`Production Spike source imports G1: ${source.path}.`);
    if (fixtureDomainPattern.test(contents)) {
      violations.push(`Production Spike source branches on a fixture API name: ${source.path}.`);
    }
  }

  validatePackageManifest(snapshot.packageManifest, policy, violations);
  validateForwardScopePolicies(
    snapshot.foundationPolicy,
    snapshot.materializationPolicy,
    violations,
  );
  validateWebArtifact(snapshot.webArtifact, policy, violations);
  validatePostgresArtifact(snapshot.postgresArtifact, snapshot.currentCommit, violations);
  return violations;
}

export function g20301EvidenceManifest(
  report: Readonly<Record<string, unknown>>,
  acceptance: Readonly<Record<string, unknown>>,
  webArtifact: unknown,
  postgresArtifact: unknown,
): Readonly<Record<string, unknown>> {
  const steps = Array.isArray(report.steps) ? report.steps.filter(isRecord) : [];
  const requiredGates = stringArrayProperty(acceptance, "requiredGates");
  const gatesPassed = requiredGates.every(
    (gate) => steps.filter((step) => step.name === gate && step.status === "PASS").length === 1,
  );
  const webPassed = isRecord(webArtifact) && webArtifact.status === "PASS";
  const postgresPassed =
    isRecord(postgresArtifact) &&
    postgresArtifact.status === "PASS" &&
    postgresArtifact.cleanCheckout === true &&
    postgresArtifact.commit === report.commit;
  const status =
    report.status === "PASS" &&
    acceptance.status === "PASS" &&
    gatesPassed &&
    webPassed &&
    postgresPassed
      ? "PASS"
      : "FAIL";
  const cleanCheckout = report.dirty === false;
  return {
    schemaVersion: 1,
    gate: "G2-03-01",
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
    web: webArtifact,
    postgres: postgresArtifact,
    owner: acceptance.owner ?? null,
    unclosedRisks: acceptance.residualRisks ?? [],
  };
}

export async function writeG20301EvidenceManifest(
  outputDirectory: string,
  report: Readonly<Record<string, unknown>>,
): Promise<void> {
  const acceptance = parseRecord(
    await readFile(resolve(outputDirectory, "g2-03-01-acceptance.json"), "utf8"),
    "G2-03-01 acceptance",
  );
  const webArtifact = await readOptionalJson(resolve(outputDirectory, "g2-03-01-web-spike.json"));
  const postgresArtifact = await readOptionalJson(
    resolve(outputDirectory, "g2-03-01-postgres-query-spike.json"),
  );
  const manifest = g20301EvidenceManifest(report, acceptance, webArtifact, postgresArtifact);
  await writeFile(
    resolve(outputDirectory, "g2-03-01-evidence-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (manifest.status !== "PASS") throw new Error("G2-03-01 evidence manifest is incomplete.");
}

async function checkG20301Evidence(repositoryRoot: string): Promise<void> {
  const policy = await loadPolicy(repositoryRoot);
  const snapshot = await loadSnapshot(repositoryRoot, policy);
  const violations = evaluateG20301EvidenceSnapshot(snapshot, policy);
  const outputDirectory = resolve(repositoryRoot, "generated/ci-report");
  await mkdir(outputDirectory, { recursive: true });
  const artifact = {
    schemaVersion: 1,
    gate: "G2-03-01",
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
    resolve(outputDirectory, "g2-03-01-acceptance.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  if (violations.length > 0) throw new Error(violations.join(" "));
  process.stdout.write(
    `g2-03-01 acceptance: PASS (${String(policy.requiredRecords.length)} records, ${String(policy.requiredGates.length)} gates)\n`,
  );
}

async function loadSnapshot(
  repositoryRoot: string,
  policy: G20301EvidencePolicy,
): Promise<G20301EvidenceSnapshot> {
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
  const recordPaths = policy.requiredRecords.map(({ path }) => path);
  const sourcePaths = policy.requiredSourceMarkers.map(({ path }) => path);
  const documentEntries: Array<readonly [string, string | undefined]> = await Promise.all(
    recordPaths.map(async (path): Promise<readonly [string, string | undefined]> => [
      path,
      await readOptionalText(resolve(repositoryRoot, path)),
    ]),
  );
  const sourceEntries: Array<readonly [string, string | undefined]> = await Promise.all(
    sourcePaths.map(async (path): Promise<readonly [string, string | undefined]> => [
      path,
      await readOptionalText(resolve(repositoryRoot, path)),
    ]),
  );
  const documents: Readonly<Record<string, string | undefined>> =
    Object.fromEntries(documentEntries);
  const sourceTexts: Readonly<Record<string, string | undefined>> =
    Object.fromEntries(sourceEntries);
  return {
    currentCommit: commit.trim(),
    trackedFiles: tracked.split("\0").filter(Boolean),
    changedFiles: changed.split("\0").filter(Boolean),
    documents,
    sourceTexts,
    packageManifest: await readOptionalJson(resolve(repositoryRoot, "package.json")),
    foundationPolicy: await readOptionalJson(
      resolve(repositoryRoot, "security/g2-00-evidence-policy.json"),
    ),
    materializationPolicy: await readOptionalJson(
      resolve(repositoryRoot, "security/g2-02-evidence-policy.json"),
    ),
    webArtifact: await readOptionalJson(
      resolve(repositoryRoot, "generated/ci-report/g2-03-01-web-spike.json"),
    ),
    postgresArtifact: await readOptionalJson(
      resolve(repositoryRoot, "generated/ci-report/g2-03-01-postgres-query-spike.json"),
    ),
  };
}

async function loadPolicy(repositoryRoot: string): Promise<G20301EvidencePolicy> {
  const value: unknown = JSON.parse(
    await readFile(resolve(repositoryRoot, "security/g2-03-01-evidence-policy.json"), "utf8"),
  );
  assertPolicy(value);
  return value;
}

function validatePackageManifest(
  candidate: unknown,
  policy: G20301EvidencePolicy,
  violations: string[],
): void {
  if (!isRecord(candidate) || !isRecord(candidate.devDependencies)) {
    violations.push("package.json devDependencies are unavailable.");
    return;
  }
  for (const [name, version] of Object.entries(policy.webStack)) {
    if (candidate.devDependencies[name] !== version) {
      violations.push(`Web stack version mismatch for ${name}.`);
    }
  }
  if (!isRecord(candidate.overrides) || candidate.overrides["js-yaml"] !== "4.3.1") {
    violations.push("The js-yaml 4.3.1 security override is missing.");
  }
}

function validateForwardScopePolicies(
  foundationCandidate: unknown,
  materializationCandidate: unknown,
  violations: string[],
): void {
  if (
    !isRecord(foundationCandidate) ||
    !isRecord(foundationCandidate.scope) ||
    !isStringArray(foundationCandidate.scope.ignoredPrefixes) ||
    !foundationCandidate.scope.ignoredPrefixes.includes("spikes/g2-03-01/")
  ) {
    violations.push("Foundation scope does not explicitly isolate the G2-03-01 Spike.");
  }
  if (
    !isRecord(materializationCandidate) ||
    !isRecord(materializationCandidate.scope) ||
    !isStringArray(materializationCandidate.scope.allowedPrefixes) ||
    !materializationCandidate.scope.allowedPrefixes.includes("spikes/g2-03-01/") ||
    !materializationCandidate.scope.allowedPrefixes.includes("tools/query-policy-architecture/")
  ) {
    violations.push("G2-02 forward scope does not explicitly admit the G2-03-01 Spike.");
  }
}

function validateWebArtifact(
  candidate: unknown,
  policy: G20301EvidencePolicy,
  violations: string[],
): void {
  if (!isRecord(candidate)) {
    violations.push("G2-03-01 Web artifact is missing.");
    return;
  }
  const input = recordProperty(candidate, "input");
  const generated = recordProperty(candidate, "generated");
  const consumer = recordProperty(candidate, "consumer");
  const versions = recordProperty(candidate, "versions");
  if (
    candidate.status !== "PASS" ||
    candidate.qualification !== "OPENAPI_GENERATED_CLIENT_CONSUMER_COMPILE" ||
    input.operationCount !== 3 ||
    generated.deterministicRegeneration !== true ||
    typeof generated.fileCount !== "number" ||
    generated.fileCount < 1 ||
    consumer.typecheck !== true ||
    consumer.productionBuild !== true ||
    consumer.generatedClientOnly !== true ||
    consumer.workspaceInternalImports !== 0 ||
    consumer.domainSpecificFields !== 0
  ) {
    violations.push("G2-03-01 Web artifact is incomplete.");
  }
  const mutations = Array.isArray(candidate.mutations) ? candidate.mutations.filter(isRecord) : [];
  const expectedMutations = ["required", "enum", "nullability"];
  if (
    mutations.length !== expectedMutations.length ||
    !expectedMutations.every((id) =>
      mutations.some(
        (mutation) =>
          mutation.id === id &&
          mutation.generated === true &&
          mutation.consumerCompileRejected === true,
      ),
    )
  ) {
    violations.push("Spec to Client to Consumer mutation evidence is incomplete.");
  }
  for (const [name, version] of Object.entries(policy.webStack)) {
    const artifactKey = webArtifactVersionKey(name);
    if (versions[artifactKey] !== version)
      violations.push(`Web artifact version mismatch for ${name}.`);
  }
}

function validatePostgresArtifact(
  candidate: unknown,
  currentCommit: string,
  violations: string[],
): void {
  if (!isRecord(candidate)) {
    violations.push("G2-03-01 PostgreSQL artifact is missing.");
    return;
  }
  const postgres = recordProperty(candidate, "postgres");
  const context = recordProperty(candidate, "executionContext");
  const assertions = recordProperty(candidate, "assertions");
  if (
    candidate.status !== "PASS" ||
    candidate.qualification !== "REAL_POSTGRES_16_POLICY_QUERY_SPIKE" ||
    candidate.commit !== currentCommit ||
    candidate.cleanCheckout !== true ||
    typeof postgres.serverVersionNum !== "string" ||
    !/^16[0-9]{4}$/u.test(postgres.serverVersionNum) ||
    context.source !== "release-serving-head" ||
    context.memberCount !== 3 ||
    context.generationCount !== 3 ||
    assertions.currentGenerationResolvedOnce !== true ||
    assertions.policyBeforePagination !== true ||
    assertions.allValuesParameterized !== true ||
    assertions.fixtureApiBranching !== false ||
    assertions.productionG1Imports !== false ||
    assertions.unboundedCurrentTableSequentialScans !== 0
  ) {
    violations.push("G2-03-01 PostgreSQL artifact is incomplete.");
  }
  const statements = Array.isArray(candidate.statements)
    ? candidate.statements.filter(isRecord)
    : [];
  const requiredNames = ["typed-get", "object-list", "policy-count", "one-hop-link"];
  if (
    statements.length !== requiredNames.length ||
    !requiredNames.every((name) =>
      statements.some(
        (statement) =>
          statement.name === name &&
          typeof statement.sqlShape === "string" &&
          statement.sqlShape.includes("$") &&
          Array.isArray(statement.parameterTypes) &&
          statement.parameterTypes.length > 0 &&
          Array.isArray(statement.indexes) &&
          statement.indexes.length > 0 &&
          isRecord(statement.explainAnalyzeBuffers),
      ),
    )
  ) {
    violations.push("PostgreSQL typed Get/List/Count/one-hop Explain evidence is incomplete.");
  }
}

function webArtifactVersionKey(packageName: string): string {
  const mapping: Readonly<Record<string, string>> = {
    "@hey-api/openapi-ts": "openapiGenerator",
    "@playwright/test": "browserTest",
    "@tanstack/react-query": "query",
    "@tanstack/react-table": "table",
    "@vitejs/plugin-react": "reactPlugin",
    "oidc-client-ts": "oidc",
    react: "react",
    "react-dom": "reactDom",
    "react-router": "reactRouter",
    vite: "vite",
  };
  const key = mapping[packageName];
  if (key === undefined) throw new Error(`Unknown Web stack package ${packageName}.`);
  return key;
}

function assertPolicy(value: unknown): asserts value is G20301EvidencePolicy {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.gate !== "G2-03-01" ||
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
    !isRecord(value.webStack) ||
    !Object.values(value.webStack).every((item) => typeof item === "string") ||
    !isStringArray(value.requiredGates) ||
    typeof value.owner !== "string" ||
    !Array.isArray(value.residualRisks) ||
    !value.residualRisks.every(isResidualRisk)
  ) {
    throw new Error("G2-03-01 evidence policy is invalid.");
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
  return contents === undefined ? null : (JSON.parse(contents) as unknown);
}

function compactStep(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    name: stringProperty(value, "name"),
    command: stringProperty(value, "command"),
    status: stringProperty(value, "status"),
    durationMs: numberProperty(value, "durationMs"),
  };
}

function parseRecord(contents: string, label: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(contents);
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function recordProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const candidate = value[key];
  return isRecord(candidate) ? candidate : {};
}

function stringArrayProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const candidate = value[key];
  return isStringArray(candidate) ? candidate : [];
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

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await checkG20301Evidence(repositoryRoot);
}
