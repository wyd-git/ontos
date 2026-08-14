import { spawn } from "node:child_process";
import { extname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface FoundationDecision {
  readonly id: string;
  readonly path: string;
  readonly acceptedStatus: string;
  readonly evidence: string;
}

export interface FoundationPolicy {
  readonly schemaVersion: 1;
  readonly gate: "G2-00";
  readonly scope: {
    readonly allowedWorkspacePackages: readonly string[];
    readonly allowedMigrationFiles: readonly string[];
    readonly allowedCreatedTables: readonly string[];
    readonly forbiddenTrackedPrefixes: readonly string[];
    readonly forbiddenUiExtensions: readonly string[];
    readonly ignoredPrefixes: readonly string[];
  };
  readonly requiredDecisions: readonly FoundationDecision[];
  readonly requiredEvidence: readonly string[];
  readonly delivery: Readonly<Record<string, unknown>>;
  readonly residualRisks: readonly Readonly<Record<string, unknown>>[];
}

export interface FoundationRepositorySnapshot {
  readonly trackedFiles: readonly string[];
  readonly workspacePackages: readonly string[];
  readonly migrationFiles: readonly string[];
  readonly createdTables: readonly string[];
  readonly documents: Readonly<Record<string, string | undefined>>;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function evaluateFoundationSnapshot(
  snapshot: FoundationRepositorySnapshot,
  policy: FoundationPolicy,
): readonly string[] {
  assertPolicy(policy);
  const violations: string[] = [];
  compareExact(
    "workspace package",
    snapshot.workspacePackages,
    policy.scope.allowedWorkspacePackages,
    violations,
  );
  compareExact(
    "migration file",
    snapshot.migrationFiles,
    policy.scope.allowedMigrationFiles,
    violations,
  );
  compareExact(
    "created table",
    snapshot.createdTables,
    policy.scope.allowedCreatedTables,
    violations,
  );

  for (const path of snapshot.trackedFiles) {
    if (policy.scope.ignoredPrefixes.some((prefix) => path.startsWith(prefix))) continue;
    if (policy.scope.forbiddenTrackedPrefixes.some((prefix) => path.startsWith(prefix))) {
      violations.push(`Foundation scope forbids tracked path ${path}.`);
    }
    if (policy.scope.forbiddenUiExtensions.includes(extname(path).toLowerCase())) {
      violations.push(`Foundation scope forbids UI implementation ${path}.`);
    }
  }

  for (const decision of policy.requiredDecisions) {
    const contents = snapshot.documents[decision.path];
    if (contents === undefined) {
      violations.push(`Required decision document is missing: ${decision.path}.`);
      continue;
    }
    if (!contents.includes(`- 状态：${decision.acceptedStatus}`)) {
      violations.push(`${decision.id} is not ${decision.acceptedStatus}.`);
    }
    const evidence = snapshot.documents[decision.evidence];
    if (evidence === undefined || !evidence.includes("- 结论：**PASS")) {
      violations.push(`${decision.id} executable evidence is missing or not PASS.`);
    }
  }

  for (const path of policy.requiredEvidence) {
    const contents = snapshot.documents[path];
    if (contents === undefined) {
      violations.push(`Required Foundation evidence is missing: ${path}.`);
    } else if (!contents.includes("- 结论：**PASS")) {
      violations.push(`Required Foundation evidence is not PASS: ${path}.`);
    }
  }
  return violations;
}

export function foundationEvidenceManifest(
  report: Readonly<Record<string, unknown>>,
  acceptance: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const reportPassed = report.status === "PASS";
  const acceptancePassed = acceptance.status === "PASS";
  const cleanCheckout = report.dirty === false;
  const steps = Array.isArray(report.steps) ? report.steps : [];
  return {
    schemaVersion: 1,
    gate: "G2-00",
    status: reportPassed && acceptancePassed ? "PASS" : "FAIL",
    qualification:
      reportPassed && acceptancePassed && cleanCheckout
        ? "CLEAN_ROOM_PASS"
        : reportPassed && acceptancePassed
          ? "WORKTREE_PASS"
          : "FAIL",
    commit: stringProperty(report, "commit"),
    cleanCheckout,
    command: "npm run verify",
    startedAt: stringProperty(report, "startedAt"),
    completedAt: stringProperty(report, "completedAt"),
    environment: report.environment ?? null,
    postgres: report.postgres ?? null,
    inputs: report.inputs ?? null,
    results: steps.map((step) => compactStep(step)),
    artifactDigests: report.artifacts ?? [],
    artifactCounts: report.artifactCounts ?? null,
    decisions: acceptance.decisions ?? [],
    scope: acceptance.scope ?? null,
    delivery: acceptance.delivery ?? null,
    unclosedRisks: acceptance.residualRisks ?? [],
  };
}

export async function writeFoundationEvidenceManifest(
  outputDirectory: string,
  report: Readonly<Record<string, unknown>>,
): Promise<void> {
  const acceptance = parseRecord(
    await readFile(resolve(outputDirectory, "foundation-acceptance.json"), "utf8"),
    "Foundation acceptance artifact",
  );
  const manifest = foundationEvidenceManifest(report, acceptance);
  await writeFile(
    resolve(outputDirectory, "foundation-evidence-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function checkFoundation(repositoryRoot: string): Promise<void> {
  const policy = await loadPolicy(repositoryRoot);
  const snapshot = await loadSnapshot(repositoryRoot, policy);
  const violations = evaluateFoundationSnapshot(snapshot, policy);
  const outputDirectory = resolve(repositoryRoot, "generated/ci-report");
  await mkdir(outputDirectory, { recursive: true });
  const artifact = {
    schemaVersion: 1,
    gate: policy.gate,
    status: violations.length === 0 ? "PASS" : "FAIL",
    scope: {
      workspacePackages: snapshot.workspacePackages,
      migrationFiles: snapshot.migrationFiles,
      createdTables: snapshot.createdTables,
      businessApplications: snapshot.trackedFiles.filter((path) => path.startsWith("apps/")),
      uiImplementations: snapshot.trackedFiles.filter(
        (path) =>
          !policy.scope.ignoredPrefixes.some((prefix) => path.startsWith(prefix)) &&
          policy.scope.forbiddenUiExtensions.includes(extname(path).toLowerCase()),
      ),
    },
    decisions: policy.requiredDecisions.map(({ id, path, acceptedStatus, evidence }) => ({
      id,
      path,
      status: acceptedStatus,
      evidence,
    })),
    evidence: policy.requiredEvidence,
    delivery: policy.delivery,
    residualRisks: policy.residualRisks,
    violations,
  };
  await writeFile(
    resolve(outputDirectory, "foundation-acceptance.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  if (violations.length > 0) throw new Error(violations.join(" "));
  process.stdout.write(
    `foundation acceptance: PASS (${String(snapshot.workspacePackages.length)} packages, ${String(snapshot.migrationFiles.length)} DB-00 migration, ${String(policy.requiredDecisions.length)} accepted ADRs, ${String(policy.requiredEvidence.length)} evidence records, no business app/UI)\n`,
  );
}

async function loadPolicy(repositoryRoot: string): Promise<FoundationPolicy> {
  const value: unknown = JSON.parse(
    await readFile(resolve(repositoryRoot, "security/g2-00-evidence-policy.json"), "utf8"),
  );
  assertPolicy(value);
  return value;
}

async function loadSnapshot(
  repositoryRoot: string,
  policy: FoundationPolicy,
): Promise<FoundationRepositorySnapshot> {
  const tracked = await run("git", ["ls-files", "-z"], repositoryRoot);
  if (tracked.exitCode !== 0) throw new Error(`git ls-files failed: ${tracked.stderr.trim()}`);
  const trackedFiles = tracked.stdout
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
  const workspacePackages = trackedFiles
    .filter((path) => /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(path))
    .map((path) => path.slice(0, -"/package.json".length))
    .sort();
  const migrationFiles = trackedFiles.filter((path) => path.startsWith("migrations/")).sort();
  const createdTables = (
    await Promise.all(
      migrationFiles.map(async (path) =>
        createdTablesIn(await readFile(resolve(repositoryRoot, path), "utf8")),
      ),
    )
  )
    .flat()
    .sort();
  const documentPaths = [
    ...new Set([
      ...policy.requiredEvidence,
      ...policy.requiredDecisions.flatMap(({ path, evidence }) => [path, evidence]),
    ]),
  ];
  const documents = Object.fromEntries(
    await Promise.all(
      documentPaths.map(async (path) => {
        try {
          return [path, await readFile(resolve(repositoryRoot, path), "utf8")] as const;
        } catch {
          return [path, undefined] as const;
        }
      }),
    ),
  );
  return { trackedFiles, workspacePackages, migrationFiles, createdTables, documents };
}

function createdTablesIn(sql: string): readonly string[] {
  return [...sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)/giu)].map(
    (match) => (match[1] ?? "").replaceAll('"', "").toLowerCase(),
  );
}

function compareExact(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
  violations: string[],
): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((value, index) => value !== expectedSorted[index])
  ) {
    violations.push(
      `Foundation ${label} set differs: expected ${JSON.stringify(expectedSorted)}, received ${JSON.stringify(actualSorted)}.`,
    );
  }
}

function compactStep(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return { name: null, command: null, status: null, durationMs: null };
  return {
    name: stringProperty(value, "name"),
    command: stringProperty(value, "command"),
    status: stringProperty(value, "status"),
    durationMs:
      typeof value.durationMs === "number" && Number.isFinite(value.durationMs)
        ? value.durationMs
        : null,
  };
}

function parseRecord(contents: string, label: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(contents);
  if (!isRecord(value)) throw new Error(`${label} is not an object.`);
  return value;
}

function stringProperty(value: Readonly<Record<string, unknown>>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

function assertPolicy(value: unknown): asserts value is FoundationPolicy {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.gate !== "G2-00" ||
    !isRecord(value.scope) ||
    !isStringArray(value.scope.allowedWorkspacePackages) ||
    !isStringArray(value.scope.allowedMigrationFiles) ||
    !isStringArray(value.scope.allowedCreatedTables) ||
    !isStringArray(value.scope.forbiddenTrackedPrefixes) ||
    !isStringArray(value.scope.forbiddenUiExtensions) ||
    !isStringArray(value.scope.ignoredPrefixes) ||
    !Array.isArray(value.requiredDecisions) ||
    !value.requiredDecisions.every(isDecision) ||
    !isStringArray(value.requiredEvidence) ||
    !isRecord(value.delivery) ||
    !Array.isArray(value.residualRisks) ||
    !value.residualRisks.every(isRecord)
  ) {
    throw new Error("G2-00 evidence policy is invalid.");
  }
}

function isDecision(value: unknown): value is FoundationDecision {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    typeof value.acceptedStatus === "string" &&
    typeof value.evidence === "string"
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function run(command: string, arguments_: readonly string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...arguments_], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (signal !== null) {
        rejectRun(new Error(`${command} ended with signal ${signal}.`));
        return;
      }
      resolveRun({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  try {
    if (process.argv[2] !== "check") throw new Error("Usage: foundation-evidence.ts check.");
    await checkFoundation(repositoryRoot);
  } catch (error) {
    process.stderr.write(`foundation acceptance: FAIL (${String(error)})\n`);
    process.exitCode = 1;
  }
}
