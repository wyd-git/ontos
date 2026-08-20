import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { writeFoundationEvidenceManifest } from "./foundation-evidence.ts";
import { writeG20301EvidenceManifest } from "./g2-03-01-evidence.ts";
import { writeG20302EvidenceManifest } from "./g2-03-02-evidence.ts";
import { writeG20303EvidenceManifest } from "./g2-03-03-evidence.ts";
import { writeG20304EvidenceManifest } from "./g2-03-04-evidence.ts";
import { writeG20305EvidenceManifest } from "./g2-03-05-evidence.ts";
import { writeG20306EvidenceManifest } from "./g2-03-06-evidence.ts";
import { writeMaterializationEvidenceManifest } from "./materialization-evidence.ts";
import { writeMetadataEvidenceManifest } from "./metadata-evidence.ts";
import {
  classifyChangedPaths,
  type ChangeRiskClassification,
  type GateProfile,
  isCommitSha,
  isTrustedFastGateEvent,
  routeDraftPullRequestProfile,
  unavailableRangeClassification,
} from "./change-risk.ts";

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
  readonly testCount: number | null;
  readonly outputTail: string;
}

interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

type NonQualifyingGateProfile = Exclude<GateProfile, "full">;

interface NonQualifyingEvidenceDefinition {
  readonly fileName: "fast-docs-evidence.json" | "preflight-evidence.json";
  readonly gate: "Foundation Gate" | "Foundation Preflight";
  readonly qualification: "FAST_DOCS_PASS" | "PREFLIGHT_PASS";
  readonly closesG2Gate: false;
  readonly statement: string;
}

const fullGates: readonly GateDefinition[] = [
  { name: "lockfile-install", command: "npm", arguments: ["ci"] },
  { name: "toolchain", command: "npm", arguments: ["run", "check:toolchain"] },
  { name: "format", command: "npm", arguments: ["run", "format:check"] },
  {
    name: "documentation-links",
    command: "npm",
    arguments: ["run", "check:documentation"],
  },
  { name: "lint", command: "npm", arguments: ["run", "lint"] },
  { name: "typecheck", command: "npm", arguments: ["run", "typecheck"] },
  { name: "unit", command: "npm", arguments: ["run", "test:unit"] },
  {
    name: "g2-03-01-web-spike",
    command: "npm",
    arguments: ["run", "check:g2-03-01-web"],
  },
  {
    name: "runtime-read-contract-generation",
    command: "npm",
    arguments: ["run", "check:runtime-read-generation"],
  },
  {
    name: "g2-03-02-contract-evidence",
    command: "npm",
    arguments: ["run", "check:g2-03-02-evidence"],
  },
  {
    name: "materialization-mapping-capacity",
    command: "npm",
    arguments: ["run", "test:materialization-mapping:capacity"],
  },
  {
    name: "materialization-base-capacity",
    command: "npm",
    arguments: ["run", "test:materialization-base:capacity"],
  },
  { name: "admin-api-unit", command: "npm", arguments: ["run", "test:admin-api"] },
  { name: "contract-golden-diff", command: "npm", arguments: ["run", "check:contracts"] },
  { name: "architecture-dependency", command: "npm", arguments: ["run", "check:architecture"] },
  { name: "testkit-provenance", command: "npm", arguments: ["run", "check:testkit-provenance"] },
  { name: "metadata-fixtures", command: "npm", arguments: ["run", "check:metadata-fixtures"] },
  {
    name: "materialization-fixtures",
    command: "npm",
    arguments: ["run", "check:materialization-fixtures"],
  },
  {
    name: "metadata-negative-fixtures",
    command: "npm",
    arguments: ["run", "check:metadata-negative-fixtures"],
  },
  { name: "secret-private-key", command: "npm", arguments: ["run", "check:secrets"] },
  {
    name: "foundation-scope-evidence",
    command: "npm",
    arguments: ["run", "check:foundation"],
  },
  {
    name: "metadata-scope-evidence",
    command: "npm",
    arguments: ["run", "check:metadata-evidence"],
  },
  { name: "license-sbom-vulnerability", command: "npm", arguments: ["run", "check:supply-chain"] },
  {
    name: "materialization-ingress-integration",
    command: "npm",
    arguments: ["run", "test:materialization-ingress:integration"],
  },
  { name: "postgres-integration", command: "npm", arguments: ["run", "test:database"] },
  {
    name: "g2-03-03-persistence-evidence",
    command: "npm",
    arguments: ["run", "check:g2-03-03-evidence"],
  },
  {
    name: "runtime-identity-postgres",
    command: "npm",
    arguments: ["run", "test:runtime-identity:postgres"],
  },
  {
    name: "g2-03-04-identity-evidence",
    command: "npm",
    arguments: ["run", "check:g2-03-04-evidence"],
  },
  {
    name: "policy-compiler-postgres",
    command: "npm",
    arguments: ["run", "test:policy-compiler:integration"],
  },
  {
    name: "g2-03-05-policy-evidence",
    command: "npm",
    arguments: ["run", "check:g2-03-05-evidence"],
  },
  {
    name: "g2-03-06-policy-evidence",
    command: "npm",
    arguments: ["run", "check:g2-03-06-evidence"],
  },
  {
    name: "projection-ddl-production-postgres",
    command: "npm",
    arguments: ["run", "test:projection-ddl:production:postgres"],
  },
  {
    name: "projection-capacity-postgres-smoke",
    command: "npm",
    arguments: ["run", "test:projection-capacity:postgres:smoke"],
  },
  {
    name: "materialization-worker-postgres",
    command: "npm",
    arguments: ["run", "test:materialization-worker:postgres"],
  },
  {
    name: "admin-api-oidc-postgres",
    command: "npm",
    arguments: ["run", "test:admin-api:postgres"],
  },
  {
    name: "materialization-production",
    command: "npm",
    arguments: ["run", "test:materialization:production"],
  },
  {
    name: "materialization-clean-room",
    command: "npm",
    arguments: ["run", "test:materialization-clean-room"],
  },
  {
    name: "materialization-scope-evidence",
    command: "npm",
    arguments: ["run", "check:materialization-evidence"],
  },
  {
    name: "g2-03-01-architecture-evidence",
    command: "npm",
    arguments: ["run", "check:g2-03-01-evidence"],
  },
  {
    name: "metadata-clean-room",
    command: "npm",
    arguments: ["run", "test:metadata-clean-room"],
  },
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

const fastGateNames = new Set([
  "lockfile-install",
  "toolchain",
  "format",
  "documentation-links",
  "unit",
  "secret-private-key",
]);

const preflightExcludedGateNames = new Set([
  "materialization-clean-room",
  "materialization-scope-evidence",
  "g2-03-01-architecture-evidence",
]);

export function redactOutput(value: string): string {
  return value
    .replaceAll(
      /((?:password|secret|token|private[_-]?key|access[_-]?key(?:[_-]?id)?)\s*[=:]\s*)\S+/giu,
      "$1[REDACTED]",
    )
    .replaceAll(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "[REDACTED_GITHUB_TOKEN]")
    .slice(-12_000);
}

export function nonQualifyingEvidenceDefinition(
  profile: NonQualifyingGateProfile,
  githubActions: string | undefined,
  eventName: string | undefined,
  pullRequestDraft: string | undefined,
): NonQualifyingEvidenceDefinition {
  const draftCheck =
    profile === "preflight" ||
    (githubActions === "true" && eventName === "pull_request" && pullRequestDraft === "true");
  return profile === "fast-docs"
    ? {
        fileName: "fast-docs-evidence.json",
        gate: draftCheck ? "Foundation Preflight" : "Foundation Gate",
        qualification: "FAST_DOCS_PASS",
        closesG2Gate: false,
        statement:
          "This profile validates low-risk Markdown documentation only and does not regenerate or replace any clean-room evidence.",
      }
    : {
        fileName: "preflight-evidence.json",
        gate: "Foundation Preflight",
        qualification: "PREFLIGHT_PASS",
        closesG2Gate: false,
        statement:
          "This Draft/local preflight omits the Materialization clean-room and dependent qualification manifests. It cannot satisfy the protected Foundation Gate, close a G2 work item, or authorize merge.",
      };
}

async function runFoundationGate(repositoryRoot: string, localPreflight: boolean): Promise<void> {
  const changeRisk: ChangeRiskClassification = localPreflight
    ? {
        schemaVersion: 1,
        profile: "preflight",
        baseCommit: null,
        headCommit: null,
        changedFiles: [],
        fullGateFiles: [],
        reason:
          "An explicit local preflight validates the non-qualifying 37-gate profile; it cannot replace GitHub Foundation Gate qualification.",
      }
    : await classifyChangeRisk(repositoryRoot);
  const gates = gateDefinitionsForProfile(changeRisk.profile);
  const outputDirectory = join(repositoryRoot, "generated/ci-report");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    join(outputDirectory, "change-risk.json"),
    `${JSON.stringify(changeRisk, null, 2)}\n`,
  );
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
    const teardown = fullGates.find((gate) => gate.tearsDownEnvironment === true);
    if (teardown === undefined) throw new Error("Environment teardown gate is not defined.");
    const cleanup = await executeGate(teardown, repositoryRoot);
    const index = stepResults.findIndex(({ name }) => name === teardown.name);
    if (index >= 0) stepResults[index] = cleanup;
    else stepResults.push(cleanup);
    if (cleanup.status === "FAIL") failure = new Error("Environment teardown failed.");
  }

  const completedAt = new Date();
  if (changeRisk.profile !== "full") {
    const definition = nonQualifyingEvidenceDefinition(
      changeRisk.profile,
      process.env.GITHUB_ACTIONS,
      process.env.ONTOS_CI_EVENT_NAME?.trim(),
      process.env.ONTOS_CI_PR_DRAFT?.trim(),
    );
    await writeFile(
      join(outputDirectory, definition.fileName),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          gate: definition.gate,
          profile: changeRisk.profile,
          status: failure === null ? "PASS" : "FAIL",
          qualification:
            failure === null && !dirty
              ? definition.qualification
              : failure === null
                ? "WORKTREE_PASS"
                : "FAIL",
          commit,
          cleanCheckout: !dirty,
          changeRisk,
          results: stepResults.map(({ name, command, status, durationMs, testCount }) => ({
            name,
            command,
            status,
            durationMs,
            testCount,
          })),
          closesG2Gate: definition.closesG2Gate,
          statement: definition.statement,
        },
        null,
        2,
      )}\n`,
    );
  }
  const artifacts = await describeArtifacts(outputDirectory);
  const artifactCounts = await readArtifactCounts(outputDirectory);
  const postgresOutput = stepResults
    .filter(({ name }) => ["postgres-integration", "admin-api-oidc-postgres"].includes(name))
    .map(({ outputTail }) => outputTail)
    .join("\n");
  const serverVersion = /CI_METADATA postgres\.server_version_num=(\d+)/u.exec(
    postgresOutput ?? "",
  )?.[1];
  const fixtureCatalog: unknown = JSON.parse(
    await readFile(join(repositoryRoot, "packages/testkit/fixtures/provenance.json"), "utf8"),
  );
  const metadataFixtureArtifact = await readOptionalJson(
    join(outputDirectory, "metadata-fixtures.json"),
  );
  const negativeFixtureArtifact = await readOptionalJson(
    join(outputDirectory, "metadata-negative-fixtures.json"),
  );
  const metadataCleanRoomArtifact = await readOptionalJson(
    join(outputDirectory, "metadata-clean-room.json"),
  );
  const migrationPaths = await trackedPaths(repositoryRoot, ["migrations"]);
  const contractPaths = await trackedPaths(repositoryRoot, [
    "packages/contracts",
    "tools/contracts",
  ]);
  const report: Readonly<Record<string, unknown>> & {
    readonly profile: GateProfile;
    readonly changeRisk: ChangeRiskClassification;
    readonly status: string;
    readonly commit: string;
    readonly durationMs: number;
    readonly steps: readonly GateResult[];
    readonly failedGate: string | null;
  } = {
    schemaVersion: 1,
    profile: changeRisk.profile,
    changeRisk,
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
      metadataFixtureDigest: stringProperty(metadataFixtureArtifact, "fixtureDigest"),
      compatibilityVectorSha256: stringProperty(
        metadataFixtureArtifact,
        "compatibilityVectorSha256",
      ),
      negativeFixtureEvidenceSha256: stringProperty(negativeFixtureArtifact, "evidenceSha256"),
      metadataCleanRoomCombinedSha256: stringProperty(
        recordProperty(
          recordProperty(metadataCleanRoomArtifact, "immutableHashes"),
          "beforeRollback",
        ),
        "combined",
      ),
      migrationSha256: await fingerprintPaths(repositoryRoot, migrationPaths),
      contractSha256: await fingerprintPaths(repositoryRoot, contractPaths),
    },
    steps: stepResults,
    testCount: stepResults.reduce((sum, step) => sum + (step.testCount ?? 0), 0),
    artifacts,
    artifactCounts,
    failedGate: stepResults.find(({ status }) => status === "FAIL")?.name ?? null,
  };
  let evidenceFailure: string | null = null;
  if (changeRisk.profile === "full") {
    try {
      await writeFoundationEvidenceManifest(outputDirectory, report);
    } catch (error) {
      await writeUnavailableEvidenceManifest(outputDirectory, "G2-00", commit, error);
      evidenceFailure = "foundation-evidence-manifest";
      failure ??= new Error("Foundation evidence manifest could not be completed.");
    }
    try {
      await writeMetadataEvidenceManifest(outputDirectory, report);
    } catch (error) {
      await writeUnavailableEvidenceManifest(outputDirectory, "G2-01", commit, error);
      evidenceFailure ??= "metadata-evidence-manifest";
      failure ??= new Error("Metadata evidence manifest could not be completed.");
    }
    try {
      await writeMaterializationEvidenceManifest(outputDirectory, report);
    } catch (error) {
      await writeUnavailableEvidenceManifest(outputDirectory, "G2-02", commit, error);
      evidenceFailure ??= "materialization-evidence-manifest";
      failure ??= new Error("Materialization evidence manifest could not be completed.");
    }
    try {
      await writeG20301EvidenceManifest(outputDirectory, report);
    } catch (error) {
      await writeUnavailableEvidenceManifest(outputDirectory, "G2-03-01", commit, error);
      evidenceFailure ??= "g2-03-01-evidence-manifest";
      failure ??= new Error("G2-03-01 evidence manifest could not be completed.");
    }
    try {
      await writeG20302EvidenceManifest(outputDirectory, report);
    } catch (error) {
      await writeUnavailableEvidenceManifest(outputDirectory, "G2-03-02", commit, error);
      evidenceFailure ??= "g2-03-02-evidence-manifest";
      failure ??= new Error("G2-03-02 evidence manifest could not be completed.");
    }
    try {
      await writeG20303EvidenceManifest(outputDirectory, report);
    } catch (error) {
      await writeUnavailableEvidenceManifest(outputDirectory, "G2-03-03", commit, error);
      evidenceFailure ??= "g2-03-03-evidence-manifest";
      failure ??= new Error("G2-03-03 evidence manifest could not be completed.");
    }
    try {
      await writeG20304EvidenceManifest(outputDirectory, report);
    } catch (error) {
      await writeUnavailableEvidenceManifest(outputDirectory, "G2-03-04", commit, error);
      evidenceFailure ??= "g2-03-04-evidence-manifest";
      failure ??= new Error("G2-03-04 evidence manifest could not be completed.");
    }
    try {
      await writeG20305EvidenceManifest(outputDirectory, report);
    } catch (error) {
      await writeUnavailableEvidenceManifest(outputDirectory, "G2-03-05", commit, error);
      evidenceFailure ??= "g2-03-05-evidence-manifest";
      failure ??= new Error("G2-03-05 evidence manifest could not be completed.");
    }
    try {
      await writeG20306EvidenceManifest(outputDirectory, report);
    } catch (error) {
      await writeUnavailableEvidenceManifest(outputDirectory, "G2-03-06", commit, error);
      evidenceFailure ??= "g2-03-06-evidence-manifest";
      failure ??= new Error("G2-03-06 evidence manifest could not be completed.");
    }
  }
  const finalReport = {
    ...report,
    status: failure === null ? "PASS" : "FAIL",
    failedGate: report.failedGate ?? evidenceFailure,
    artifacts: await describeArtifacts(outputDirectory),
  };
  const summary = renderSummary(finalReport);
  await writeFile(
    join(outputDirectory, "report.json"),
    `${JSON.stringify(finalReport, null, 2)}\n`,
  );
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
      testCount: parseTestCount(result.output),
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
      testCount: null,
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
    testCount: null,
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

async function classifyChangeRisk(repositoryRoot: string): Promise<ChangeRiskClassification> {
  const eventName = process.env.ONTOS_CI_EVENT_NAME?.trim();
  const baseCommit = process.env.ONTOS_CI_BASE_SHA?.trim();
  const headCommit = process.env.ONTOS_CI_HEAD_SHA?.trim();
  const safeBase = isCommitSha(baseCommit) ? baseCommit : null;
  const safeHead = isCommitSha(headCommit) ? headCommit : null;
  if (!isTrustedFastGateEvent(process.env.GITHUB_ACTIONS, eventName)) {
    return unavailableRangeClassification(
      safeBase,
      safeHead,
      "Only a trusted GitHub pull_request or push event may select the fast profile; local, scheduled, and manual runs default to full.",
    );
  }
  if (safeBase === null || safeHead === null) {
    return unavailableRangeClassification(
      safeBase,
      safeHead,
      "A complete trusted Git comparison range was not provided, so the gate defaults to full.",
    );
  }
  try {
    const checkedOutCommit = await captureValue("git", ["rev-parse", "HEAD"], repositoryRoot);
    if (eventName === "push" && checkedOutCommit !== safeHead) {
      return unavailableRangeClassification(
        safeBase,
        safeHead,
        "The push Head does not equal the checked-out commit, so the gate defaults to full.",
      );
    }
    for (const commit of [safeBase, safeHead]) {
      const ancestry = await runCommand(
        "git",
        ["merge-base", "--is-ancestor", commit, checkedOutCommit],
        repositoryRoot,
        false,
      );
      if (ancestry.exitCode !== 0) {
        return unavailableRangeClassification(
          safeBase,
          safeHead,
          "The comparison range is not contained in the checked-out commit, so the gate defaults to full.",
        );
      }
    }
    return routeDraftPullRequestProfile(
      classifyChangedPaths(
        await captureChangedPaths(repositoryRoot, safeBase, safeHead),
        safeBase,
        safeHead,
      ),
      process.env.GITHUB_ACTIONS,
      eventName,
      process.env.ONTOS_CI_PR_DRAFT?.trim(),
    );
  } catch (error) {
    return unavailableRangeClassification(
      safeBase,
      safeHead,
      `The Git comparison could not be evaluated, so the gate defaults to full: ${redactOutput(String(error))}`,
    );
  }
}

function gateDefinitionsForProfile(profile: GateProfile): readonly GateDefinition[] {
  if (profile === "fast-docs") {
    return fullGates.filter(({ name }) => fastGateNames.has(name));
  }
  if (profile === "preflight") {
    return fullGates.filter(({ name }) => !preflightExcludedGateNames.has(name));
  }
  return fullGates;
}

export function gateNamesForProfile(profile: GateProfile): readonly string[] {
  return gateDefinitionsForProfile(profile).map(({ name }) => name);
}

function captureChangedPaths(
  repositoryRoot: string,
  baseCommit: string,
  headCommit: string,
): Promise<readonly string[]> {
  return new Promise((resolvePaths, rejectPaths) => {
    const child = spawn(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", baseCommit, headCommit, "--"],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    let errorOutput = "";
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) {
        overflow = true;
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput = `${errorOutput}${chunk.toString("utf8")}`.slice(-4_000);
    });
    child.once("error", rejectPaths);
    child.once("close", (code, signal) => {
      if (signal !== null) {
        rejectPaths(new Error(`git diff ended with signal ${signal}.`));
        return;
      }
      if (code !== 0) {
        rejectPaths(new Error(`git diff failed: ${errorOutput.trim()}`));
        return;
      }
      if (overflow) {
        rejectPaths(new Error("git diff path output exceeded the 4 MiB safety limit."));
        return;
      }
      resolvePaths(Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean));
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
  readonly metadataFixtures: {
    readonly packages: number | null;
    readonly compatibilityCases: number | null;
  };
  readonly negativeFixtures: { readonly cases: number | null };
  readonly metadataCleanRoom: {
    readonly scenarioSteps: number | null;
    readonly status: string | null;
  };
}> {
  const secret = await readOptionalJson(join(outputDirectory, "secret-scan.json"));
  const supply = await readOptionalJson(join(outputDirectory, "supply-chain-artifacts.json"));
  const metadata = await readOptionalJson(join(outputDirectory, "metadata-fixtures.json"));
  const negative = await readOptionalJson(join(outputDirectory, "metadata-negative-fixtures.json"));
  const cleanRoom = await readOptionalJson(join(outputDirectory, "metadata-clean-room.json"));
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
    metadataFixtures: {
      packages: numberProperty(metadata, "fixtureCount"),
      compatibilityCases: numberProperty(metadata, "compatibilityCaseCount"),
    },
    negativeFixtures: { cases: numberProperty(negative, "caseCount") },
    metadataCleanRoom: {
      scenarioSteps: numberProperty(cleanRoom, "scenarioStepCount"),
      status: stringProperty(cleanRoom, "status"),
    },
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

function stringProperty(value: unknown, key: string): string | null {
  const candidate = recordProperty(value, key);
  return typeof candidate === "string" ? candidate : null;
}

export function parseTestCount(output: string): number | null {
  const matches = [...output.matchAll(/(?:^|\n)ℹ tests (\d+)(?:\n|$)/gu)];
  const value = matches.at(-1)?.[1];
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
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

async function trackedPaths(
  repositoryRoot: string,
  prefixes: readonly string[],
): Promise<string[]> {
  const result = await runCommand(
    "git",
    ["ls-files", "-z", "--", ...prefixes],
    repositoryRoot,
    false,
  );
  if (result.exitCode !== 0) throw new Error(`git ls-files failed for ${prefixes.join(", ")}.`);
  return result.output.split("\0").filter(Boolean).sort();
}

async function fingerprintPaths(repositoryRoot: string, paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash
      .update(path)
      .update("\0")
      .update(await readFile(join(repositoryRoot, path)))
      .update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function writeUnavailableEvidenceManifest(
  outputDirectory: string,
  gate:
    | "G2-00"
    | "G2-01"
    | "G2-02"
    | "G2-03-01"
    | "G2-03-02"
    | "G2-03-03"
    | "G2-03-04"
    | "G2-03-05"
    | "G2-03-06",
  commit: string,
  error: unknown,
): Promise<void> {
  const name =
    gate === "G2-00"
      ? "foundation"
      : gate === "G2-01"
        ? "metadata"
        : gate === "G2-02"
          ? "materialization"
          : gate === "G2-03-01"
            ? "g2-03-01"
            : gate === "G2-03-02"
              ? "g2-03-02"
              : gate === "G2-03-03"
                ? "g2-03-03"
                : gate === "G2-03-04"
                  ? "g2-03-04"
                  : "g2-03-05";
  await writeFile(
    join(outputDirectory, `${name}-evidence-manifest.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        gate,
        status: "FAIL",
        qualification: "FAIL",
        commit,
        cleanCheckout: false,
        reason: "Acceptance artifact unavailable because a prior gate failed.",
        diagnostic: redactOutput(String(error)),
      },
      null,
      2,
    )}\n`,
  );
}

function renderSummary(report: {
  readonly profile: GateProfile;
  readonly changeRisk: ChangeRiskClassification;
  readonly status: string;
  readonly commit: string;
  readonly durationMs: number;
  readonly steps: readonly GateResult[];
  readonly failedGate: string | null;
}): string {
  const rows = report.steps
    .map(
      (step) =>
        `| ${step.name} | ${step.status} | ${step.testCount === null ? "-" : String(step.testCount)} | ${step.durationMs === null ? "-" : `${String(step.durationMs)} ms`} |`,
    )
    .join("\n");
  const testCount = report.steps.reduce((sum, step) => sum + (step.testCount ?? 0), 0);
  const title =
    report.profile === "full"
      ? "Foundation + Metadata + Materialization + Query Contract Gate"
      : report.profile === "preflight"
        ? "Draft Pull Request Preflight"
        : "Fast Documentation Gate";
  return `# ${title}: ${report.status}\n\n- Profile: \`${report.profile}\`\n- Reason: ${report.changeRisk.reason}\n- Changed files: ${String(report.changeRisk.changedFiles.length)}\n- Commit: \`${report.commit}\`\n- Tests: ${String(testCount)}\n- Duration: ${String(report.durationMs)} ms\n- Failed gate: ${report.failedGate ?? "none"}\n\n| Gate | Status | Tests | Duration |\n| --- | --- | ---: | ---: |\n${rows}\n`;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    const arguments_ = process.argv.slice(2);
    const localPreflight = arguments_.length === 1 && arguments_[0] === "--preflight";
    if (arguments_.length > 0 && !localPreflight) {
      throw new Error("Usage: run.ts [--preflight].");
    }
    if (localPreflight && process.env.GITHUB_ACTIONS === "true") {
      throw new Error(
        "The local --preflight override is forbidden in GitHub Actions; trusted Draft metadata must select preflight.",
      );
    }
    await runFoundationGate(repositoryRoot, localPreflight);
  } catch (error) {
    process.stderr.write(`foundation gate: FAIL (${String(error)})\n`);
    process.exitCode = 1;
  }
}
