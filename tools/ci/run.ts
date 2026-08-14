import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface GateDefinition {
  readonly name: string;
  readonly command: string;
  readonly arguments: readonly string[];
  readonly touchesEnvironment?: true;
  readonly tearsDownEnvironment?: true;
}

interface GateResult {
  readonly name: string;
  readonly command: string;
  readonly status: "PASS" | "FAIL" | "SKIPPED";
  readonly exitCode: number | null;
  readonly startedAt: string | null;
  readonly durationMs: number | null;
  readonly outputTail: string;
}

interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

const gates: readonly GateDefinition[] = [
  { name: "lockfile-install", command: "npm", arguments: ["ci"] },
  { name: "toolchain", command: "npm", arguments: ["run", "check:toolchain"] },
  { name: "format", command: "npm", arguments: ["run", "format:check"] },
  { name: "lint", command: "npm", arguments: ["run", "lint"] },
  { name: "typecheck", command: "npm", arguments: ["run", "typecheck"] },
  { name: "unit", command: "npm", arguments: ["run", "test:unit"] },
  { name: "contract-golden-diff", command: "npm", arguments: ["run", "check:contracts"] },
  { name: "architecture-dependency", command: "npm", arguments: ["run", "check:architecture"] },
  { name: "testkit-provenance", command: "npm", arguments: ["run", "check:testkit-provenance"] },
  { name: "secret-private-key", command: "npm", arguments: ["run", "check:secrets"] },
  { name: "license-sbom-vulnerability", command: "npm", arguments: ["run", "check:supply-chain"] },
  { name: "postgres-integration", command: "npm", arguments: ["run", "test:database"] },
  {
    name: "production-boundary-up",
    command: "npm",
    arguments: ["run", "env:up"],
    touchesEnvironment: true,
  },
  { name: "production-boundary-smoke", command: "npm", arguments: ["run", "env:smoke"] },
  {
    name: "production-boundary-down",
    command: "npm",
    arguments: ["run", "env:down"],
    tearsDownEnvironment: true,
  },
];

export function redactOutput(value: string): string {
  return value
    .replaceAll(
      /((?:password|secret|token|private[_-]?key|access[_-]?key(?:[_-]?id)?)\s*[=:]\s*)\S+/giu,
      "$1[REDACTED]",
    )
    .replaceAll(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "[REDACTED_GITHUB_TOKEN]")
    .slice(-12_000);
}

async function runFoundationGate(repositoryRoot: string): Promise<void> {
  const outputDirectory = join(repositoryRoot, "generated/ci-report");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const startedAt = new Date();
  const commit = await captureValue("git", ["rev-parse", "HEAD"], repositoryRoot);
  const dirty = (await captureValue("git", ["status", "--porcelain"], repositoryRoot)).length > 0;
  const versions = {
    node: process.versions.node,
    npm: await captureValue("npm", ["--version"], repositoryRoot),
    docker: await captureValue("docker", ["--version"], repositoryRoot, true),
    dockerCompose: await captureValue(
      "docker",
      ["compose", "version", "--short"],
      repositoryRoot,
      true,
    ),
  };
  const stepResults: GateResult[] = [];
  let failure: Error | null = null;
  let environmentTouched = false;
  let environmentDown = false;

  for (const gate of gates) {
    if (failure !== null) {
      stepResults.push(skipped(gate));
      continue;
    }
    if (gate.touchesEnvironment === true) environmentTouched = true;
    const result = await executeGate(gate, repositoryRoot);
    stepResults.push(result);
    if (gate.tearsDownEnvironment === true && result.status === "PASS") environmentDown = true;
    if (result.status === "FAIL") failure = new Error(`${gate.name} failed.`);
  }

  if (environmentTouched && !environmentDown) {
    const teardown = gates.find((gate) => gate.tearsDownEnvironment === true);
    if (teardown === undefined) throw new Error("Environment teardown gate is not defined.");
    const cleanup = await executeGate(teardown, repositoryRoot);
    const index = stepResults.findIndex(({ name }) => name === teardown.name);
    if (index >= 0) stepResults[index] = cleanup;
    else stepResults.push(cleanup);
    if (cleanup.status === "FAIL") failure = new Error("Environment teardown failed.");
  }

  const completedAt = new Date();
  const artifacts = await describeArtifacts(outputDirectory);
  const artifactCounts = await readArtifactCounts(outputDirectory);
  const postgresOutput = stepResults.find(
    ({ name }) => name === "postgres-integration",
  )?.outputTail;
  const serverVersion = /CI_METADATA postgres\.server_version_num=(\d+)/u.exec(
    postgresOutput ?? "",
  )?.[1];
  const fixtureCatalog: unknown = JSON.parse(
    await readFile(join(repositoryRoot, "packages/testkit/fixtures/provenance.json"), "utf8"),
  );
  const report = {
    schemaVersion: 1,
    status: failure === null ? "PASS" : "FAIL",
    commit,
    dirty,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    environment: { platform: platform(), arch: arch(), versions },
    postgres: {
      image:
        "postgres:16.14-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8",
      serverVersionNum: serverVersion ?? null,
    },
    inputs: {
      packageLockSha256: await sha256File(join(repositoryRoot, "package-lock.json")),
      testkitFixtureDigest: fixtureDigest(fixtureCatalog),
    },
    steps: stepResults,
    artifacts,
    artifactCounts,
    failedGate: stepResults.find(({ status }) => status === "FAIL")?.name ?? null,
  };
  const summary = renderSummary(report);
  await writeFile(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outputDirectory, "summary.md"), summary);
  const githubSummary = process.env.GITHUB_STEP_SUMMARY;
  if (githubSummary !== undefined) await appendFile(githubSummary, summary);
  process.stdout.write(summary);
  if (failure !== null) throw failure;
}

async function executeGate(gate: GateDefinition, cwd: string): Promise<GateResult> {
  const startedAt = new Date();
  process.stdout.write(`\n==> ${gate.name}\n`);
  try {
    const result = await runCommand(gate.command, gate.arguments, cwd, true);
    return {
      name: gate.name,
      command: [gate.command, ...gate.arguments].join(" "),
      status: result.exitCode === 0 ? "PASS" : "FAIL",
      exitCode: result.exitCode,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      outputTail: redactOutput(result.output),
    };
  } catch (error) {
    return {
      name: gate.name,
      command: [gate.command, ...gate.arguments].join(" "),
      status: "FAIL",
      exitCode: null,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      outputTail: redactOutput(String(error)),
    };
  }
}

function skipped(gate: GateDefinition): GateResult {
  return {
    name: gate.name,
    command: [gate.command, ...gate.arguments].join(" "),
    status: "SKIPPED",
    exitCode: null,
    startedAt: null,
    durationMs: null,
    outputTail: "Skipped because an earlier gate failed.",
  };
}

function runCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  stream: boolean,
): Promise<CommandResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...arguments_], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const receive = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      output = `${output}${text}`.slice(-100_000);
      if (stream) process.stdout.write(text);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (signal !== null) {
        rejectRun(new Error(`${command} ended with signal ${signal}.`));
        return;
      }
      resolveRun({ exitCode: code ?? 1, output });
    });
  });
}

async function captureValue(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  allowFailure = false,
): Promise<string> {
  try {
    const result = await runCommand(command, arguments_, cwd, false);
    if (result.exitCode !== 0) {
      if (allowFailure) return "unavailable";
      throw new Error(`${command} ${arguments_.join(" ")} failed.`);
    }
    return result.output.trim();
  } catch (error) {
    if (allowFailure) return "unavailable";
    throw error;
  }
}

async function describeArtifacts(
  outputDirectory: string,
): Promise<readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[]> {
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  const artifacts = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && !["report.json", "summary.md"].includes(entry.name))
      .map(async (entry) => {
        const path = join(outputDirectory, entry.name);
        const content = await readFile(path);
        return {
          path: `generated/ci-report/${entry.name}`,
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: content.length,
        };
      }),
  );
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

async function readArtifactCounts(outputDirectory: string): Promise<{
  readonly secrets: { readonly scannedFiles: number | null; readonly findings: number | null };
  readonly licenses: { readonly packages: number | null };
  readonly sbom: { readonly components: number | null; readonly dependencies: number | null };
  readonly vulnerabilities: { readonly findings: number | null };
}> {
  const secret = await readOptionalJson(join(outputDirectory, "secret-scan.json"));
  const supply = await readOptionalJson(join(outputDirectory, "supply-chain-artifacts.json"));
  const counts = recordProperty(supply, "counts");
  return {
    secrets: {
      scannedFiles: numberProperty(secret, "scannedFileCount"),
      findings: arrayLength(secret, "findings"),
    },
    licenses: { packages: numberProperty(counts, "licenses") },
    sbom: {
      components: numberProperty(counts, "sbomComponents"),
      dependencies: numberProperty(counts, "sbomDependencies"),
    },
    vulnerabilities: { findings: numberProperty(counts, "vulnerabilities") },
  };
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function recordProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  return (value as Readonly<Record<string, unknown>>)[key];
}

function numberProperty(value: unknown, key: string): number | null {
  const candidate = recordProperty(value, key);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function arrayLength(value: unknown, key: string): number | null {
  const candidate = recordProperty(value, key);
  return Array.isArray(candidate) ? candidate.length : null;
}

function fixtureDigest(candidate: unknown): string | null {
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "sourceFingerprint" in candidate &&
    typeof candidate.sourceFingerprint === "object" &&
    candidate.sourceFingerprint !== null &&
    "digest" in candidate.sourceFingerprint &&
    typeof candidate.sourceFingerprint.digest === "string"
  ) {
    return candidate.sourceFingerprint.digest;
  }
  return null;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function renderSummary(report: {
  readonly status: string;
  readonly commit: string;
  readonly durationMs: number;
  readonly steps: readonly GateResult[];
  readonly failedGate: string | null;
}): string {
  const rows = report.steps
    .map(
      (step) =>
        `| ${step.name} | ${step.status} | ${step.durationMs === null ? "-" : `${String(step.durationMs)} ms`} |`,
    )
    .join("\n");
  return `# Foundation Gate: ${report.status}\n\n- Commit: \`${report.commit}\`\n- Duration: ${String(report.durationMs)} ms\n- Failed gate: ${report.failedGate ?? "none"}\n\n| Gate | Status | Duration |\n| --- | --- | ---: |\n${rows}\n`;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    await runFoundationGate(repositoryRoot);
  } catch (error) {
    process.stderr.write(`foundation gate: FAIL (${String(error)})\n`);
    process.exitCode = 1;
  }
}
