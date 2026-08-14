import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface ProtectionPolicy {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly branch: string;
  readonly requiredStatusChecks: {
    readonly strict: true;
    readonly contexts: readonly string[];
  };
  readonly enforceAdmins: true;
  readonly requirePullRequest: true;
  readonly requiredApprovingReviewCount: number;
  readonly bypassActors: readonly string[];
  readonly allowForcePushes: false;
  readonly allowDeletions: false;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function protectionRequest(policy: ProtectionPolicy): Readonly<Record<string, unknown>> {
  assertPolicy(policy);
  return {
    required_status_checks: {
      strict: policy.requiredStatusChecks.strict,
      contexts: [...policy.requiredStatusChecks.contexts],
    },
    enforce_admins: policy.enforceAdmins,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: policy.requiredApprovingReviewCount,
      require_last_push_approval: false,
    },
    restrictions: null,
    required_linear_history: false,
    allow_force_pushes: policy.allowForcePushes,
    allow_deletions: policy.allowDeletions,
    block_creations: false,
    required_conversation_resolution: false,
    lock_branch: false,
    allow_fork_syncing: false,
  };
}

export function evaluateProtection(
  candidate: unknown,
  policy: ProtectionPolicy,
): readonly string[] {
  assertPolicy(policy);
  if (!isRecord(candidate)) return ["Branch protection response is not an object."];
  const violations: string[] = [];
  const statusChecks = recordProperty(candidate, "required_status_checks");
  if (booleanProperty(statusChecks, "strict") !== true) {
    violations.push("Required status checks are not strict.");
  }
  const actualContexts = stringArrayProperty(statusChecks, "contexts");
  if (!sameStrings(actualContexts, policy.requiredStatusChecks.contexts)) {
    violations.push("Required status check contexts do not exactly match policy.");
  }

  if (booleanProperty(recordProperty(candidate, "enforce_admins"), "enabled") !== true) {
    violations.push("Administrators are not subject to branch protection.");
  }
  const reviews = recordProperty(candidate, "required_pull_request_reviews");
  if (!isRecord(reviews)) {
    violations.push("Pull requests are not required.");
  } else {
    if (
      numberProperty(reviews, "required_approving_review_count") !==
      policy.requiredApprovingReviewCount
    ) {
      violations.push("Required approving review count differs from policy.");
    }
    const bypass = recordProperty(reviews, "bypass_pull_request_allowances");
    const bypassCount = ["users", "teams", "apps"].reduce(
      (count, key) => count + arrayLength(bypass, key),
      0,
    );
    if (bypassCount !== policy.bypassActors.length) {
      violations.push("Permanent pull-request bypass actors are configured.");
    }
  }
  if (booleanProperty(recordProperty(candidate, "allow_force_pushes"), "enabled") !== false) {
    violations.push("Force pushes are not disabled.");
  }
  if (booleanProperty(recordProperty(candidate, "allow_deletions"), "enabled") !== false) {
    violations.push("Branch deletion is not disabled.");
  }
  return violations;
}

async function main(repositoryRoot: string): Promise<void> {
  const action = process.argv[2];
  if (action !== "verify" && action !== "apply") {
    throw new Error("Usage: github-protection.ts <verify|apply>.");
  }
  const policy = JSON.parse(
    await readFile(join(repositoryRoot, "security/main-branch-protection.json"), "utf8"),
  ) as unknown;
  assertPolicy(policy);
  const endpoint = `repos/${policy.repository}/branches/${policy.branch}/protection`;
  if (action === "apply") {
    const applied = await runGh(
      ["api", "--method", "PUT", endpoint, "--input", "-"],
      `${JSON.stringify(protectionRequest(policy))}\n`,
    );
    assertGhSucceeded(applied, "apply");
  }
  const fetched = await runGh(["api", endpoint]);
  assertGhSucceeded(fetched, "read");
  const response: unknown = JSON.parse(fetched.stdout);
  const violations = evaluateProtection(response, policy);
  if (violations.length > 0) throw new Error(violations.join(" "));
  process.stdout.write(
    `github protection: PASS (${policy.repository} ${policy.branch}, strict ${policy.requiredStatusChecks.contexts.join(", ")}, admins enforced, no bypass/force/delete)\n`,
  );
}

function assertPolicy(value: unknown): asserts value is ProtectionPolicy {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository) ||
    typeof value.branch !== "string" ||
    value.branch.length === 0 ||
    !isRecord(value.requiredStatusChecks) ||
    value.requiredStatusChecks.strict !== true ||
    !isStringArray(value.requiredStatusChecks.contexts) ||
    value.requiredStatusChecks.contexts.length === 0 ||
    value.enforceAdmins !== true ||
    value.requirePullRequest !== true ||
    !Number.isInteger(value.requiredApprovingReviewCount) ||
    typeof value.requiredApprovingReviewCount !== "number" ||
    value.requiredApprovingReviewCount < 0 ||
    !isStringArray(value.bypassActors) ||
    value.bypassActors.length !== 0 ||
    value.allowForcePushes !== false ||
    value.allowDeletions !== false
  ) {
    throw new Error("Main branch protection policy is invalid or weaker than Foundation policy.");
  }
}

function runGh(arguments_: readonly string[], input?: string): Promise<CommandResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("gh", [...arguments_], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
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
        rejectRun(new Error(`gh ended with signal ${signal}.`));
        return;
      }
      resolveRun({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function assertGhSucceeded(result: CommandResult, operation: string): void {
  if (result.exitCode === 0) return;
  const message = result.stderr.trim().slice(-1_000);
  throw new Error(`GitHub protection ${operation} failed: ${message || "unknown gh error"}`);
}

function recordProperty(value: unknown, key: string): unknown {
  if (!isRecord(value)) return null;
  return value[key];
}

function booleanProperty(value: unknown, key: string): boolean | null {
  const candidate = recordProperty(value, key);
  return typeof candidate === "boolean" ? candidate : null;
}

function numberProperty(value: unknown, key: string): number | null {
  const candidate = recordProperty(value, key);
  return typeof candidate === "number" ? candidate : null;
}

function stringArrayProperty(value: unknown, key: string): readonly string[] {
  const candidate = recordProperty(value, key);
  return isStringArray(candidate) ? candidate : [];
}

function arrayLength(value: unknown, key: string): number {
  const candidate = recordProperty(value, key);
  return Array.isArray(candidate) ? candidate.length : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort((a, b) => a.localeCompare(b));
  const sortedRight = [...right].sort((a, b) => a.localeCompare(b));
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    await main(repositoryRoot);
  } catch (error) {
    process.stderr.write(`github protection: FAIL (${String(error)})\n`);
    process.exitCode = 1;
  }
}
