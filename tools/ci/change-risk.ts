export type GateProfile = "fast-docs" | "preflight" | "full";

export interface ChangeRiskClassification {
  readonly schemaVersion: 1;
  readonly profile: GateProfile;
  readonly baseCommit: string | null;
  readonly headCommit: string | null;
  readonly changedFiles: readonly string[];
  readonly fullGateFiles: readonly string[];
  readonly reason: string;
}

const fastDocumentationExactPaths = new Set(["README.md", "docs/README.md"]);
const governedDocumentationPrefixes = [
  "docs/architecture/adr/",
  "docs/evidence/",
  "docs/reviews/",
] as const;

export function classifyChangedPaths(
  changedPaths: readonly string[],
  baseCommit: string | null,
  headCommit: string | null,
): ChangeRiskClassification {
  const changedFiles = [...new Set(changedPaths)].sort();
  const fullGateFiles = changedFiles.filter((path) => !isFastDocumentationPath(path));

  if (changedFiles.length === 0) {
    return {
      schemaVersion: 1,
      profile: "full",
      baseCommit,
      headCommit,
      changedFiles,
      fullGateFiles,
      reason: "The comparison contains no changed files, so the gate fails closed to full.",
    };
  }

  if (fullGateFiles.length > 0) {
    return {
      schemaVersion: 1,
      profile: "full",
      baseCommit,
      headCommit,
      changedFiles,
      fullGateFiles,
      reason:
        "At least one changed path can affect runtime, governance, evidence, or build behavior.",
    };
  }

  return {
    schemaVersion: 1,
    profile: "fast-docs",
    baseCommit,
    headCommit,
    changedFiles,
    fullGateFiles,
    reason: "Every changed path is low-risk Markdown documentation.",
  };
}

export function unavailableRangeClassification(
  baseCommit: string | null,
  headCommit: string | null,
  reason: string,
): ChangeRiskClassification {
  return {
    schemaVersion: 1,
    profile: "full",
    baseCommit,
    headCommit,
    changedFiles: [],
    fullGateFiles: [],
    reason,
  };
}

export function routeDraftPullRequestProfile(
  classification: ChangeRiskClassification,
  githubActions: string | undefined,
  eventName: string | undefined,
  pullRequestDraft: string | undefined,
): ChangeRiskClassification {
  if (
    classification.profile !== "full" ||
    !isCommitSha(classification.baseCommit ?? undefined) ||
    !isCommitSha(classification.headCommit ?? undefined) ||
    classification.changedFiles.length === 0 ||
    classification.fullGateFiles.length === 0 ||
    githubActions !== "true" ||
    eventName !== "pull_request" ||
    pullRequestDraft !== "true"
  ) {
    return classification;
  }

  return {
    ...classification,
    profile: "preflight",
    reason:
      "A trusted Draft pull request with runtime-affecting changes receives non-qualifying preflight coverage; converting it to Ready triggers the complete Foundation Gate.",
  };
}

export function isCommitSha(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{40}$/u.test(value);
}

export function isTrustedFastGateEvent(
  githubActions: string | undefined,
  eventName: string | undefined,
): eventName is "pull_request" | "push" {
  return githubActions === "true" && (eventName === "pull_request" || eventName === "push");
}

export function isFastDocumentationPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return false;
  }
  if (fastDocumentationExactPaths.has(path)) return true;
  if (!path.startsWith("docs/") || !path.endsWith(".md")) return false;
  return !governedDocumentationPrefixes.some((prefix) => path.startsWith(prefix));
}
