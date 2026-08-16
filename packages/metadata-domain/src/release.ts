import type {
  ArtifactDigest,
  CompatibilityFindingContract,
  ResourceFamily,
  ValidationIssueContract,
} from "@ontos/contracts";
import { parseOntosId } from "@ontos/contracts";

import {
  compareReleaseCompatibility,
  type CompatibilityEvaluation,
  type PinnedCompatibilityDependency,
  type PinnedCompatibilityRevision,
} from "./compatibility.ts";

export const METADATA_RELEASE_VALIDATOR_VERSION = "metadata-release-g2-01-v1" as const;

const runtimePlanStageableCompatibilityCodes = new Set([
  "SNAPSHOT_SCHEMA_REMATERIALIZATION_REQUIRED",
  "MAPPING_REMATERIALIZATION_REQUIRED",
]);

export type ReleaseLifecycleState =
  "draft" | "staging" | "ready" | "failed" | "published" | "superseded";

export interface ReleaseGatePin extends PinnedCompatibilityRevision {
  readonly order: number;
  readonly projectId: string;
  readonly resourceState: "active" | "deprecated" | "archived";
  readonly revisionState: "draft" | "validated" | "published" | "deprecated" | "archived";
  readonly storedFamily: ResourceFamily;
  readonly storedContentDigest: ArtifactDigest;
  readonly revisionContentDigest: ArtifactDigest;
  readonly hasCurrentValidationReport: boolean;
}

export interface ReleaseBaselinePin extends PinnedCompatibilityRevision {
  readonly contentDigest: ArtifactDigest;
}

export interface ReleaseGateEvaluation {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssueContract[];
  readonly compatibility: CompatibilityEvaluation;
}

/**
 * Evaluates the complete immutable Release candidate. Storage adapters provide
 * both the sealed Pin facts and the current referenced facts so this function
 * can detect a stale/tampered Pin rather than trusting either side alone.
 */
export function evaluateReleaseGate(input: {
  readonly releaseId: string;
  readonly projectId: string;
  readonly pins: readonly ReleaseGatePin[];
  readonly dependencies: readonly PinnedCompatibilityDependency[];
  readonly baselinePins: readonly ReleaseBaselinePin[];
}): ReleaseGateEvaluation {
  const issues: ValidationIssueContract[] = [];
  const sortedPins = [...input.pins].sort(
    (left, right) => left.order - right.order || compareText(left.resourceId, right.resourceId),
  );
  const fallbackResourceId = sortedPins[0]?.resourceId ?? input.releaseId;

  if (sortedPins.length === 0) {
    issues.push(
      issue(
        "RELEASE_PIN_SET_EMPTY",
        fallbackResourceId,
        "/pins",
        "A Release must seal at least one Resource Revision.",
        "Add one or more validated Resource Revisions to a new Release Draft.",
      ),
    );
  }
  if (sortedPins.length > 512) {
    issues.push(
      issue(
        "RELEASE_PIN_SET_TOO_LARGE",
        fallbackResourceId,
        "/pins",
        "The Release exceeds the 512 Pin control-plane limit.",
        "Split the metadata change into bounded Releases.",
      ),
    );
  }

  const resourceIds = new Set<string>();
  const candidateRevisionIds = new Set(sortedPins.map(({ revisionId }) => revisionId));
  for (const [index, pin] of sortedPins.entries()) {
    const path = `/pins/${String(index)}`;
    if (pin.order !== index) {
      issues.push(
        issue(
          "RELEASE_PIN_ORDER_INVALID",
          pin.resourceId,
          `${path}/order`,
          "Release Pins are not in contiguous deterministic order.",
          "Recreate the Release Draft so the server can reseal its Pin order.",
        ),
      );
    }
    if (resourceIds.has(pin.resourceId)) {
      issues.push(
        issue(
          "RELEASE_PIN_RESOURCE_DUPLICATE",
          pin.resourceId,
          `${path}/resourceId`,
          "The Release contains more than one Pin for a Resource.",
          "Select exactly one Revision for each Resource.",
        ),
      );
    }
    resourceIds.add(pin.resourceId);
    if (pin.projectId !== input.projectId) {
      issues.push(
        issue(
          "RELEASE_PIN_CROSS_PROJECT",
          pin.resourceId,
          `${path}/resourceId`,
          "A Release Pin belongs to another Project.",
          "Use only Resource Revisions owned by the Release Project.",
        ),
      );
    }
    if (pin.family !== pin.storedFamily || pin.storedContentDigest !== pin.revisionContentDigest) {
      issues.push(
        issue(
          "RELEASE_PIN_FACT_MISMATCH",
          pin.resourceId,
          path,
          "A sealed Pin no longer matches the referenced immutable Revision fact.",
          "Discard the Release and create a new Draft from current Revision facts.",
        ),
      );
    }
    if (!new Set(["validated", "published", "deprecated"]).has(pin.revisionState)) {
      issues.push(
        issue(
          "RELEASE_PIN_REVISION_NOT_REUSABLE",
          pin.resourceId,
          `${path}/revisionId`,
          "A pinned Revision is not in a reusable validated state.",
          "Validate the Revision, or create a new Release without an archived Revision.",
        ),
      );
    }
    if (pin.resourceState === "archived") {
      issues.push(
        issue(
          "RELEASE_PIN_RESOURCE_ARCHIVED",
          pin.resourceId,
          `${path}/resourceId`,
          "A pinned Resource has been archived.",
          "Create a new Release that does not activate the archived Resource.",
        ),
      );
    }
    if (!pin.hasCurrentValidationReport) {
      issues.push(
        issue(
          "RELEASE_PIN_VALIDATION_REPORT_MISSING",
          pin.resourceId,
          `${path}/revisionId`,
          "The pinned Revision has no successful report for its current Digest.",
          "Validate the Revision with the active server Validator before staging.",
        ),
      );
    }
  }

  const resourceByRevision = new Map(sortedPins.map((pin) => [pin.revisionId, pin.resourceId]));
  for (const dependency of [...input.dependencies].sort(compareDependencies)) {
    if (!candidateRevisionIds.has(dependency.sourceRevisionId)) continue;
    if (candidateRevisionIds.has(dependency.targetRevisionId)) continue;
    const resourceId = resourceByRevision.get(dependency.sourceRevisionId) ?? fallbackResourceId;
    issues.push(
      issue(
        "RELEASE_DEPENDENCY_NOT_PINNED",
        resourceId,
        `/dependencies/${escapePointer(dependency.dependencyType)}${dependency.sourcePath}`,
        "The Release Pin set is not dependency closed.",
        "Pin the exact target Revision and recreate the Release Draft.",
      ),
    );
  }

  const compatibility = compareReleaseCompatibility({
    baselinePins: input.baselinePins,
    candidatePins: sortedPins,
    candidateDependencies: input.dependencies,
  });
  for (const finding of compatibility.findings) {
    const resourceId = resourceIdFromFinding(finding, resourceIds) ?? fallbackResourceId;
    issues.push(compatibilityIssue(finding, resourceId));
  }

  const stableIssues = sortIssues(issues);
  const boundedIssues = boundIssues(stableIssues, fallbackResourceId);
  return Object.freeze({
    valid: !stableIssues.some(({ severity }) => severity === "error"),
    issues: boundedIssues,
    compatibility,
  });
}

export function assertReleaseStateTransition(
  current: ReleaseLifecycleState,
  target: ReleaseLifecycleState,
): void {
  if (current === target) return;
  const allowed: Readonly<Record<ReleaseLifecycleState, readonly ReleaseLifecycleState[]>> = {
    draft: ["staging", "failed"],
    staging: ["ready", "failed"],
    ready: ["published"],
    failed: [],
    published: ["superseded"],
    superseded: [],
  };
  if (!allowed[current].includes(target)) {
    throw new TypeError(`Release cannot transition from ${current} to ${target}.`);
  }
}

function compatibilityIssue(
  finding: CompatibilityFindingContract,
  resourceId: string,
): ValidationIssueContract {
  return Object.freeze({
    code: `COMPATIBILITY_${finding.code}`,
    severity:
      finding.kind === "compatible" ||
      (finding.kind === "conditional" && runtimePlanStageableCompatibilityCodes.has(finding.code))
        ? "warning"
        : "error",
    resourceId: parseOntosId(resourceId, "$releaseGate.issue.resourceId"),
    path: finding.path,
    message: finding.message,
    remediation: finding.requiredNextStep,
  });
}

function resourceIdFromFinding(
  finding: CompatibilityFindingContract,
  resourceIds: ReadonlySet<string>,
): string | null {
  const match = /^\/resources\/([^/]+)/u.exec(finding.path);
  if (match?.[1] === undefined) return null;
  const candidate = match[1].replaceAll("~1", "/").replaceAll("~0", "~");
  return resourceIds.has(candidate) ? candidate : null;
}

function issue(
  code: string,
  resourceId: string,
  path: string,
  message: string,
  remediation: string,
): ValidationIssueContract {
  return Object.freeze({
    code,
    severity: "error",
    resourceId: parseOntosId(resourceId, "$releaseGate.issue.resourceId"),
    path,
    message,
    remediation,
  });
}

function sortIssues(
  issues: readonly ValidationIssueContract[],
): readonly ValidationIssueContract[] {
  const unique = new Map<string, ValidationIssueContract>();
  for (const item of issues) {
    unique.set(
      [item.resourceId, item.path, item.code, item.severity, item.message, item.remediation].join(
        "\u0000",
      ),
      item,
    );
  }
  return Object.freeze([...unique.values()].sort(compareIssues));
}

function boundIssues(
  issues: readonly ValidationIssueContract[],
  fallbackResourceId: string,
): readonly ValidationIssueContract[] {
  if (issues.length <= 1_000) return issues;
  const omitted = issues.slice(999);
  const summary = Object.freeze({
    code: "RELEASE_GATE_ISSUES_TRUNCATED",
    severity: omitted.some(({ severity }) => severity === "error") ? "error" : "warning",
    resourceId: parseOntosId(fallbackResourceId, "$releaseGate.issue.resourceId"),
    path: "/",
    message: "The Release Gate produced more Issues than the public report limit.",
    remediation: "Resolve the reported Issues in smaller Release batches, then validate again.",
  }) satisfies ValidationIssueContract;
  return Object.freeze([...issues.slice(0, 999), summary].sort(compareIssues));
}

function compareIssues(left: ValidationIssueContract, right: ValidationIssueContract): number {
  return (
    compareText(left.resourceId, right.resourceId) ||
    compareText(left.path, right.path) ||
    compareText(left.code, right.code) ||
    compareText(left.severity, right.severity) ||
    compareText(left.message, right.message) ||
    compareText(left.remediation, right.remediation)
  );
}

function compareDependencies(
  left: PinnedCompatibilityDependency,
  right: PinnedCompatibilityDependency,
): number {
  return (
    compareText(left.sourceRevisionId, right.sourceRevisionId) ||
    compareText(left.targetRevisionId, right.targetRevisionId) ||
    compareText(left.dependencyType, right.dependencyType) ||
    compareText(left.sourcePath, right.sourcePath)
  );
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
