import {
  GIB,
  applySafetyMargin,
  estimateLinkProjection,
  estimateObjectProjection,
  type ObjectProjectionEstimate,
} from "./projection-baseline.ts";

export const CAPACITY_DAY_IN_MS = 24 * 60 * 60 * 1_000;

export type CapacityErrorCode =
  | "CAPACITY_APPROVAL_INVALID"
  | "CAPACITY_DEPLOYMENT_PROJECT_LIMIT_EXCEEDED"
  | "CAPACITY_HARD_LIMIT_EXCEEDED"
  | "CAPACITY_HOLD_REVIEW_OVERDUE"
  | "CAPACITY_INVENTORY_INVALID"
  | "CAPACITY_MEASUREMENT_INCOMPLETE"
  | "CAPACITY_PEAK_BUDGET_EXCEEDED"
  | "CAPACITY_RELEASE_BUDGET_EXCEEDED"
  | "CAPACITY_STEADY_BUDGET_EXCEEDED"
  | "GC_PLAN_STALE"
  | "GC_REFERENCE_SCAN_INCOMPLETE";

export class ProjectionCapacityError extends Error {
  readonly code: CapacityErrorCode;

  constructor(code: CapacityErrorCode, message: string) {
    super(message);
    this.name = "ProjectionCapacityError";
    this.code = code;
  }
}

export type ReferenceRootKind =
  "CHANNEL" | "SERVING_HEAD" | "PREFLIGHT_TOKEN" | "QUERY" | "JOB" | "HOLD" | "HISTORICAL";

export interface GenerationReferenceRoot {
  kind: ReferenceRootKind;
  id: string;
  expiresAt?: number;
  ownerId?: string;
  reason?: string;
  reviewAt?: number;
  releaseId?: string;
}

export interface ObjectTypeFootprint {
  resourceId: string;
  rows: bigint;
  secondaryIndexUnitsPerRow: bigint;
}

export interface GenerationFootprintInput {
  id: string;
  projectId: string;
  state: "READY" | "STAGING" | "FAILED_STAGING" | "COLLECTED";
  createdAt: number;
  leftServingAt: number | null;
  derivedRecentSuccessful: boolean;
  objectTypes: readonly ObjectTypeFootprint[];
  linkRows: bigint;
  forecastMeasuredBytes?: bigint;
  observedMeasuredBytes?: bigint;
  roots: readonly GenerationReferenceRoot[];
}

export interface GenerationEstimate {
  id: string;
  projectId: string;
  state: GenerationFootprintInput["state"];
  measuredBytes: bigint;
  reservedBytes: bigint;
  objectBytes: bigint;
  linkBytes: bigint;
  maximumWriteAmplificationMilli: bigint;
  classification: "SERVING" | "RECENT_SUCCESS" | "PROTECTED" | "STAGING" | "ORPHAN";
  activeRootKinds: ReferenceRootKind[];
}

export interface ReleaseServingSet {
  releaseId: string;
  generationIds: readonly string[];
}

export interface CapacityPolicy {
  measurementSafetyBps: bigint;
  normalMaxReleaseServingBytes: bigint;
  hardMaxReleaseServingBytes: bigint;
  normalMaxProjectSteadyBytes: bigint;
  normalMaxProjectPeakBytes: bigint;
  hardMaxProjectPhysicalBytes: bigint;
  maximumApprovalMs: number;
  minimumGcGraceMs: number;
}

export const defaultCapacityPolicy: CapacityPolicy = {
  measurementSafetyBps: 15_000n,
  normalMaxReleaseServingBytes: 2n * GIB,
  hardMaxReleaseServingBytes: 3n * GIB,
  normalMaxProjectSteadyBytes: 8n * GIB,
  normalMaxProjectPeakBytes: 10n * GIB,
  hardMaxProjectPhysicalBytes: 12n * GIB,
  maximumApprovalMs: 30 * CAPACITY_DAY_IN_MS,
  minimumGcGraceMs: 7 * CAPACITY_DAY_IN_MS,
};

export const FOUNDATION_MAX_DATA_BEARING_PROJECTS = 1;

export interface ProjectionCapacityApproval {
  id: string;
  projectId: string;
  approvedAt: number;
  expiresAt: number;
  maximumReleaseServingBytes: bigint;
  maximumProjectSteadyBytes: bigint;
  maximumProjectPeakBytes: bigint;
  retirementReleaseIds: readonly string[];
  supportUntilByReleaseId: Readonly<Record<string, number>>;
}

export interface CapacityViolation {
  code: CapacityErrorCode;
  scopeId: string;
  actualBytes: bigint;
  limitBytes: bigint;
  message: string;
}

export interface CapacityReport {
  accepted: boolean;
  projectId: string;
  at: number;
  measuredBytes: bigint;
  observedProjectPhysicalBytes: bigint;
  unattributedPhysicalBytes: bigint;
  reservedBytes: bigint;
  steadyReservedBytes: bigint;
  stagingReservedBytes: bigint;
  peakReservedBytes: bigint;
  bytesByClassification: Record<GenerationEstimate["classification"], bigint>;
  releaseServingBytes: Record<string, bigint>;
  generations: GenerationEstimate[];
  normalViolations: CapacityViolation[];
  hardViolations: CapacityViolation[];
  approvalId: string | null;
}

export interface CapacityChangeAdmissionReport {
  accepted: boolean;
  admissionMode: "WITHIN_NORMAL" | "NON_EXPANDING_OVERAGE" | "REJECTED";
  reasons: string[];
}

export interface CapacityEvaluationInput {
  projectId: string;
  at: number;
  measurementComplete: boolean;
  /** Complete project-wide pg_total_relation_size/catalog scan. */
  observedProjectPhysicalBytes?: bigint;
  generations: readonly GenerationFootprintInput[];
  releaseServingSets: readonly ReleaseServingSet[];
}

export interface GarbageCollectionInput {
  projectId: string;
  at: number;
  inventoryRevision: number;
  measurementComplete: boolean;
  referenceScanComplete: boolean;
  generations: readonly GenerationFootprintInput[];
}

export interface GarbageCollectionEntry {
  generationId: string;
  reservedBytes: bigint;
  reasons: string[];
}

export interface GarbageCollectionDryRun {
  status: "READY" | "BLOCKED";
  projectId: string;
  at: number;
  inventoryRevision: number;
  candidates: GarbageCollectionEntry[];
  retained: GarbageCollectionEntry[];
  protected: GarbageCollectionEntry[];
  reclaimableBytes: bigint;
  blockedReasons: string[];
}

export function estimateGeneration(
  input: GenerationFootprintInput,
  at: number,
  policy: CapacityPolicy = defaultCapacityPolicy,
): GenerationEstimate {
  validateGeneration(input);
  validateCapacityPolicy(policy);
  assertHoldGovernanceCurrent(input.roots, at);
  let objectBytes = 0n;
  let objectMeasuredBytes = 0n;
  let maximumWriteAmplificationMilli = 1_000n;
  for (const objectType of input.objectTypes) {
    const estimate: ObjectProjectionEstimate = estimateObjectProjection(
      objectType.rows,
      objectType.secondaryIndexUnitsPerRow,
      policy.measurementSafetyBps,
    );
    objectMeasuredBytes += estimate.measuredBytes;
    objectBytes += estimate.reservedBytes;
    if (estimate.estimatedWriteAmplificationMilli > maximumWriteAmplificationMilli) {
      maximumWriteAmplificationMilli = estimate.estimatedWriteAmplificationMilli;
    }
  }
  const links = estimateLinkProjection(input.linkRows, policy.measurementSafetyBps);
  const estimatedMeasuredBytes = objectMeasuredBytes + links.measuredBytes;
  const estimatedReservedBytes = objectBytes + links.reservedBytes;
  const measuredBytes = maxBigInt([
    estimatedMeasuredBytes,
    input.forecastMeasuredBytes ?? 0n,
    input.observedMeasuredBytes ?? 0n,
  ]);
  const reservedBytes = maxBigInt([
    estimatedReservedBytes,
    applySafetyMargin(measuredBytes, policy.measurementSafetyBps),
  ]);
  const activeRoots = activeReferenceRoots(input.roots, at);
  return {
    id: input.id,
    projectId: input.projectId,
    state: input.state,
    measuredBytes,
    reservedBytes,
    objectBytes,
    linkBytes: links.reservedBytes,
    maximumWriteAmplificationMilli,
    classification: classifyGeneration(input, activeRoots),
    activeRootKinds: [...new Set(activeRoots.map((root) => root.kind))].sort(),
  };
}

export function evaluateCapacity(
  input: CapacityEvaluationInput,
  approval?: ProjectionCapacityApproval,
  policy: CapacityPolicy = defaultCapacityPolicy,
): CapacityReport {
  validateCapacityPolicy(policy);
  if (!input.measurementComplete) {
    fail(
      "CAPACITY_MEASUREMENT_INCOMPLETE",
      "Capacity admission fails closed when any Generation measurement or estimate is missing.",
    );
  }
  const generationById = validateInventory(input.projectId, input.generations);
  const estimates = input.generations
    .filter((generation) => generation.state !== "COLLECTED")
    .map((generation) => estimateGeneration(generation, input.at, policy));
  const estimateById = new Map(estimates.map((estimate) => [estimate.id, estimate]));
  const generationMeasuredBytes = sumBigInt(estimates.map((estimate) => estimate.measuredBytes));
  const generationReservedBytes = sumBigInt(estimates.map((estimate) => estimate.reservedBytes));
  const observedProjectPhysicalBytes = input.observedProjectPhysicalBytes ?? 0n;
  if (observedProjectPhysicalBytes < 0n) {
    fail("CAPACITY_INVENTORY_INVALID", "Observed Project physical bytes cannot be negative.");
  }
  const measuredBytes = maxBigInt([generationMeasuredBytes, observedProjectPhysicalBytes]);
  const projectPhysicalFloor = applySafetyMargin(
    observedProjectPhysicalBytes,
    policy.measurementSafetyBps,
  );
  const unattributedPhysicalBytes =
    projectPhysicalFloor > generationReservedBytes
      ? projectPhysicalFloor - generationReservedBytes
      : 0n;
  const reservedBytes = generationReservedBytes + unattributedPhysicalBytes;
  const stagingReservedBytes = sumBigInt(
    estimates
      .filter((estimate) => estimate.state === "STAGING" || estimate.state === "FAILED_STAGING")
      .map((estimate) => estimate.reservedBytes),
  );
  // Any project-wide bytes the Generation inventory cannot attribute are conservatively ORPHAN
  // steady bytes. This prevents a complete catalog scan from becoming a lower, unsafe estimate.
  const steadyReservedBytes = reservedBytes - stagingReservedBytes;
  const peakReservedBytes = reservedBytes;
  const bytesByClassification = emptyClassificationBytes();
  for (const estimate of estimates) {
    bytesByClassification[estimate.classification] += estimate.reservedBytes;
  }
  bytesByClassification.ORPHAN += unattributedPhysicalBytes;

  const releaseServingBytes: Record<string, bigint> = {};
  const releaseIds = new Set<string>();
  for (const releaseSet of input.releaseServingSets) {
    if (releaseIds.has(releaseSet.releaseId)) {
      fail("CAPACITY_INVENTORY_INVALID", `Release ${releaseSet.releaseId} appears twice.`);
    }
    releaseIds.add(releaseSet.releaseId);
    const ids = [...new Set(releaseSet.generationIds)];
    let bytes = 0n;
    for (const id of ids) {
      const generation = generationById.get(id);
      const estimate = estimateById.get(id);
      if (
        generation === undefined ||
        estimate === undefined ||
        generation.state !== "READY" ||
        !activeReferenceRoots(generation.roots, input.at).some(
          (root) => root.kind === "SERVING_HEAD" && root.releaseId === releaseSet.releaseId,
        )
      ) {
        fail(
          "CAPACITY_INVENTORY_INVALID",
          `Release ${releaseSet.releaseId} references non-serving Generation ${id}.`,
        );
      }
      bytes += estimate.reservedBytes;
    }
    releaseServingBytes[releaseSet.releaseId] = bytes;
  }

  const normalViolations: CapacityViolation[] = [];
  for (const [releaseId, bytes] of Object.entries(releaseServingBytes)) {
    if (bytes > policy.normalMaxReleaseServingBytes) {
      normalViolations.push(
        violation(
          "CAPACITY_RELEASE_BUDGET_EXCEEDED",
          releaseId,
          bytes,
          policy.normalMaxReleaseServingBytes,
        ),
      );
    }
  }
  if (steadyReservedBytes > policy.normalMaxProjectSteadyBytes) {
    normalViolations.push(
      violation(
        "CAPACITY_STEADY_BUDGET_EXCEEDED",
        input.projectId,
        steadyReservedBytes,
        policy.normalMaxProjectSteadyBytes,
      ),
    );
  }
  if (peakReservedBytes > policy.normalMaxProjectPeakBytes) {
    normalViolations.push(
      violation(
        "CAPACITY_PEAK_BUDGET_EXCEEDED",
        input.projectId,
        peakReservedBytes,
        policy.normalMaxProjectPeakBytes,
      ),
    );
  }

  const hardViolations: CapacityViolation[] = [];
  for (const [releaseId, bytes] of Object.entries(releaseServingBytes)) {
    if (bytes > policy.hardMaxReleaseServingBytes) {
      hardViolations.push(
        violation(
          "CAPACITY_HARD_LIMIT_EXCEEDED",
          releaseId,
          bytes,
          policy.hardMaxReleaseServingBytes,
        ),
      );
    }
  }
  if (peakReservedBytes > policy.hardMaxProjectPhysicalBytes) {
    hardViolations.push(
      violation(
        "CAPACITY_HARD_LIMIT_EXCEEDED",
        input.projectId,
        peakReservedBytes,
        policy.hardMaxProjectPhysicalBytes,
      ),
    );
  }

  let approvalId: string | null = null;
  let accepted = hardViolations.length === 0 && normalViolations.length === 0;
  if (hardViolations.length === 0 && normalViolations.length > 0 && approval !== undefined) {
    validateCapacityApproval(
      input,
      releaseServingBytes,
      steadyReservedBytes,
      peakReservedBytes,
      approval,
      policy,
    );
    accepted = true;
    approvalId = approval.id;
  }

  return {
    accepted,
    projectId: input.projectId,
    at: input.at,
    measuredBytes,
    observedProjectPhysicalBytes,
    unattributedPhysicalBytes,
    reservedBytes,
    steadyReservedBytes,
    stagingReservedBytes,
    peakReservedBytes,
    bytesByClassification,
    releaseServingBytes,
    generations: estimates,
    normalViolations,
    hardViolations,
    approvalId,
  };
}

export function assertCapacityAccepted(report: CapacityReport): void {
  if (report.accepted) return;
  const first = report.hardViolations[0] ?? report.normalViolations[0];
  if (first === undefined) {
    fail("CAPACITY_INVENTORY_INVALID", "Rejected capacity report has no violation.");
  }
  fail(first.code, first.message);
}

export function assertFoundationDeploymentEnvelope(
  dataBearingProjectIds: readonly string[],
  maximumProjects = FOUNDATION_MAX_DATA_BEARING_PROJECTS,
): void {
  if (!Number.isSafeInteger(maximumProjects) || maximumProjects <= 0) {
    fail("CAPACITY_INVENTORY_INVALID", "Deployment Project limit must be a positive integer.");
  }
  const projects = new Set(dataBearingProjectIds);
  if (projects.size !== dataBearingProjectIds.length || projects.has("")) {
    fail("CAPACITY_INVENTORY_INVALID", "Deployment Project inventory is invalid.");
  }
  if (projects.size > maximumProjects) {
    fail(
      "CAPACITY_DEPLOYMENT_PROJECT_LIMIT_EXCEEDED",
      `Reference deployment allows ${maximumProjects} data-bearing Project; observed ${projects.size}.`,
    );
  }
}

export function admitCapacityChange(
  before: CapacityReport,
  after: CapacityReport,
): CapacityChangeAdmissionReport {
  if (before.projectId !== after.projectId || after.at < before.at) {
    fail("CAPACITY_INVENTORY_INVALID", "Capacity change reports are not comparable.");
  }
  if (after.hardViolations.length > 0) {
    return {
      accepted: false,
      admissionMode: "REJECTED",
      reasons: after.hardViolations.map((violation) => violation.code),
    };
  }
  if (after.normalViolations.length === 0) {
    return { accepted: true, admissionMode: "WITHIN_NORMAL", reasons: [] };
  }

  const violationDoesNotExpand = after.normalViolations.every((violation) => {
    const previous = before.normalViolations.find(
      (item) => item.code === violation.code && item.scopeId === violation.scopeId,
    );
    return previous !== undefined && violation.actualBytes <= previous.actualBytes;
  });
  const totalsDoNotExpand =
    after.reservedBytes <= before.reservedBytes &&
    after.steadyReservedBytes <= before.steadyReservedBytes &&
    after.peakReservedBytes <= before.peakReservedBytes;
  if (violationDoesNotExpand && totalsDoNotExpand) {
    return {
      accepted: true,
      admissionMode: "NON_EXPANDING_OVERAGE",
      reasons: [],
    };
  }
  return {
    accepted: false,
    admissionMode: "REJECTED",
    reasons: ["CAPACITY_OVERAGE_EXPANDED"],
  };
}

export function createGarbageCollectionDryRun(
  input: GarbageCollectionInput,
  policy: CapacityPolicy = defaultCapacityPolicy,
): GarbageCollectionDryRun {
  validateCapacityPolicy(policy);
  const blockedReasons: string[] = [];
  if (!input.measurementComplete) blockedReasons.push("MEASUREMENT_INCOMPLETE");
  if (!input.referenceScanComplete) blockedReasons.push("REFERENCE_SCAN_INCOMPLETE");
  for (const generation of input.generations) {
    for (const root of generation.roots) {
      if (root.kind === "HOLD" && root.reviewAt !== undefined && root.reviewAt <= input.at) {
        blockedReasons.push(`HOLD_REVIEW_OVERDUE:${root.id}`);
      }
    }
  }
  if (blockedReasons.length > 0) {
    return {
      status: "BLOCKED",
      projectId: input.projectId,
      at: input.at,
      inventoryRevision: input.inventoryRevision,
      candidates: [],
      retained: [],
      protected: [],
      reclaimableBytes: 0n,
      blockedReasons,
    };
  }

  validateInventory(input.projectId, input.generations);
  const candidates: GarbageCollectionEntry[] = [];
  const retained: GarbageCollectionEntry[] = [];
  const protectedEntries: GarbageCollectionEntry[] = [];
  for (const generation of input.generations) {
    if (generation.state === "COLLECTED") continue;
    const estimate = estimateGeneration(generation, input.at, policy);
    const roots = activeReferenceRoots(generation.roots, input.at);
    if (roots.length > 0) {
      protectedEntries.push({
        generationId: generation.id,
        reservedBytes: estimate.reservedBytes,
        reasons: [...new Set(roots.map((root) => root.kind))].sort(),
      });
      continue;
    }
    const graceAnchor = Math.max(
      generation.createdAt,
      generation.leftServingAt ?? generation.createdAt,
    );
    const retentionReasons: string[] = [];
    if (generation.derivedRecentSuccessful) retentionReasons.push("RECENT_SUCCESS");
    if (input.at - graceAnchor < policy.minimumGcGraceMs) retentionReasons.push("GC_GRACE_ACTIVE");
    if (retentionReasons.length > 0) {
      retained.push({
        generationId: generation.id,
        reservedBytes: estimate.reservedBytes,
        reasons: retentionReasons,
      });
      continue;
    }
    candidates.push({
      generationId: generation.id,
      reservedBytes: estimate.reservedBytes,
      reasons: [generation.state === "READY" ? "UNREFERENCED" : "ORPHAN_STAGING"],
    });
  }

  return {
    status: "READY",
    projectId: input.projectId,
    at: input.at,
    inventoryRevision: input.inventoryRevision,
    candidates: candidates.sort((left, right) =>
      left.generationId.localeCompare(right.generationId),
    ),
    retained: retained.sort((left, right) => left.generationId.localeCompare(right.generationId)),
    protected: protectedEntries.sort((left, right) =>
      left.generationId.localeCompare(right.generationId),
    ),
    reclaimableBytes: sumBigInt(candidates.map((candidate) => candidate.reservedBytes)),
    blockedReasons: [],
  };
}

export function assertGarbageCollectionCommitAllowed(
  plan: GarbageCollectionDryRun,
  current: GarbageCollectionInput,
  policy: CapacityPolicy = defaultCapacityPolicy,
): void {
  if (!current.referenceScanComplete || !current.measurementComplete) {
    fail(
      "GC_REFERENCE_SCAN_INCOMPLETE",
      "GC commit requires complete reference and measurement scans.",
    );
  }
  if (
    plan.status !== "READY" ||
    plan.projectId !== current.projectId ||
    plan.inventoryRevision !== current.inventoryRevision
  ) {
    fail("GC_PLAN_STALE", "GC plan no longer matches the current inventory revision.");
  }
  const refreshed = createGarbageCollectionDryRun(current, policy);
  const refreshedIds = new Set(refreshed.candidates.map((candidate) => candidate.generationId));
  if (plan.candidates.some((candidate) => !refreshedIds.has(candidate.generationId))) {
    fail("GC_PLAN_STALE", "A planned GC candidate gained a reference or retention reason.");
  }
}

function validateCapacityApproval(
  input: CapacityEvaluationInput,
  releaseServingBytes: Readonly<Record<string, bigint>>,
  steadyBytes: bigint,
  peakBytes: bigint,
  approval: ProjectionCapacityApproval,
  policy: CapacityPolicy,
): void {
  const maximumRelease = maxBigInt([0n, ...Object.values(releaseServingBytes)]);
  if (
    approval.projectId !== input.projectId ||
    input.at < approval.approvedAt ||
    input.at >= approval.expiresAt ||
    approval.expiresAt - approval.approvedAt > policy.maximumApprovalMs ||
    approval.maximumReleaseServingBytes > policy.hardMaxReleaseServingBytes ||
    approval.maximumProjectPeakBytes > policy.hardMaxProjectPhysicalBytes ||
    approval.maximumProjectSteadyBytes > approval.maximumProjectPeakBytes ||
    approval.maximumReleaseServingBytes < maximumRelease ||
    approval.maximumProjectSteadyBytes < steadyBytes ||
    approval.maximumProjectPeakBytes < peakBytes ||
    approval.retirementReleaseIds.length === 0
  ) {
    fail("CAPACITY_APPROVAL_INVALID", `Projection capacity approval ${approval.id} is invalid.`);
  }
  for (const releaseId of new Set(approval.retirementReleaseIds)) {
    const supportUntil = approval.supportUntilByReleaseId[releaseId];
    const servingRelease = input.releaseServingSets.find(
      (releaseSet) => releaseSet.releaseId === releaseId,
    );
    if (
      supportUntil === undefined ||
      supportUntil + policy.minimumGcGraceMs > approval.expiresAt ||
      servingRelease === undefined
    ) {
      fail(
        "CAPACITY_APPROVAL_INVALID",
        `Release ${releaseId} is not reclaimable before approval ${approval.id} expires.`,
      );
    }
  }
}

function validateInventory(
  projectId: string,
  generations: readonly GenerationFootprintInput[],
): Map<string, GenerationFootprintInput> {
  const result = new Map<string, GenerationFootprintInput>();
  for (const generation of generations) {
    validateGeneration(generation);
    if (generation.projectId !== projectId) {
      fail("CAPACITY_INVENTORY_INVALID", "Capacity inventory cannot span projects.");
    }
    if (result.has(generation.id)) {
      fail("CAPACITY_INVENTORY_INVALID", `Generation ${generation.id} appears twice.`);
    }
    result.set(generation.id, generation);
  }
  return result;
}

function validateGeneration(generation: GenerationFootprintInput): void {
  if (!Number.isSafeInteger(generation.createdAt) || generation.createdAt < 0) {
    fail("CAPACITY_INVENTORY_INVALID", `Generation ${generation.id} has invalid createdAt.`);
  }
  if (
    generation.leftServingAt !== null &&
    (!Number.isSafeInteger(generation.leftServingAt) ||
      generation.leftServingAt < generation.createdAt)
  ) {
    fail("CAPACITY_INVENTORY_INVALID", `Generation ${generation.id} has invalid leftServingAt.`);
  }
  if (generation.objectTypes.length === 0 && generation.linkRows === 0n) {
    fail("CAPACITY_INVENTORY_INVALID", `Generation ${generation.id} has no projection rows.`);
  }
  if (generation.state !== "READY" && generation.derivedRecentSuccessful) {
    fail(
      "CAPACITY_INVENTORY_INVALID",
      `Generation ${generation.id} cannot be recent-successful in state ${generation.state}.`,
    );
  }
  if (generation.state === "COLLECTED" && generation.roots.length > 0) {
    fail(
      "CAPACITY_INVENTORY_INVALID",
      `Collected Generation ${generation.id} cannot retain active references.`,
    );
  }
  if (
    (generation.state === "STAGING" || generation.state === "FAILED_STAGING") &&
    generation.leftServingAt !== null
  ) {
    fail(
      "CAPACITY_INVENTORY_INVALID",
      `Staging Generation ${generation.id} cannot have leftServingAt.`,
    );
  }
  const resourceIds = new Set<string>();
  for (const objectType of generation.objectTypes) {
    if (
      objectType.rows < 0n ||
      objectType.secondaryIndexUnitsPerRow < 0n ||
      resourceIds.has(objectType.resourceId)
    ) {
      fail("CAPACITY_INVENTORY_INVALID", `Generation ${generation.id} has invalid Object rows.`);
    }
    resourceIds.add(objectType.resourceId);
  }
  if (generation.linkRows < 0n) {
    fail("CAPACITY_INVENTORY_INVALID", `Generation ${generation.id} has invalid Link rows.`);
  }
  if (generation.forecastMeasuredBytes !== undefined && generation.forecastMeasuredBytes < 0n) {
    fail(
      "CAPACITY_INVENTORY_INVALID",
      `Generation ${generation.id} has invalid forecast measured bytes.`,
    );
  }
  if (generation.observedMeasuredBytes !== undefined && generation.observedMeasuredBytes < 0n) {
    fail(
      "CAPACITY_INVENTORY_INVALID",
      `Generation ${generation.id} has invalid observed measured bytes.`,
    );
  }
  const rootIds = new Set<string>();
  for (const root of generation.roots) {
    const key = `${root.kind}:${root.id}`;
    if (rootIds.has(key)) {
      fail("CAPACITY_INVENTORY_INVALID", `Generation ${generation.id} repeats root ${key}.`);
    }
    rootIds.add(key);
    if (
      (root.kind === "PREFLIGHT_TOKEN" || root.kind === "QUERY") &&
      (root.expiresAt === undefined || !Number.isSafeInteger(root.expiresAt))
    ) {
      fail("CAPACITY_INVENTORY_INVALID", `${root.kind} ${root.id} needs an expiry.`);
    }
    if (root.kind !== "PREFLIGHT_TOKEN" && root.kind !== "QUERY" && root.expiresAt !== undefined) {
      fail(
        "CAPACITY_INVENTORY_INVALID",
        `${root.kind} ${root.id} cannot disappear through a generic expiry.`,
      );
    }
    if (root.kind === "SERVING_HEAD" && root.releaseId?.trim() === "") {
      fail("CAPACITY_INVENTORY_INVALID", `SERVING_HEAD ${root.id} needs a Release ID.`);
    }
    if (root.kind === "SERVING_HEAD" && root.releaseId === undefined) {
      fail("CAPACITY_INVENTORY_INVALID", `SERVING_HEAD ${root.id} needs a Release ID.`);
    }
    if (root.kind !== "SERVING_HEAD" && root.releaseId !== undefined) {
      fail(
        "CAPACITY_INVENTORY_INVALID",
        `${root.kind} ${root.id} cannot impersonate a Release Serving Head.`,
      );
    }
    if (
      root.kind === "HOLD" &&
      (root.ownerId?.trim() === "" ||
        root.ownerId === undefined ||
        root.reason?.trim() === "" ||
        root.reason === undefined ||
        root.reviewAt === undefined ||
        !Number.isSafeInteger(root.reviewAt))
    ) {
      fail(
        "CAPACITY_INVENTORY_INVALID",
        `HOLD ${root.id} needs an Owner, Reason and safe reviewAt.`,
      );
    }
  }
}

function assertHoldGovernanceCurrent(roots: readonly GenerationReferenceRoot[], at: number): void {
  const overdue = roots.find(
    (root) => root.kind === "HOLD" && root.reviewAt !== undefined && root.reviewAt <= at,
  );
  if (overdue !== undefined) {
    fail(
      "CAPACITY_HOLD_REVIEW_OVERDUE",
      `HOLD ${overdue.id} must be reviewed before capacity admission can continue.`,
    );
  }
}

function validateCapacityPolicy(policy: CapacityPolicy): void {
  const byteValues = [
    policy.measurementSafetyBps,
    policy.normalMaxReleaseServingBytes,
    policy.hardMaxReleaseServingBytes,
    policy.normalMaxProjectSteadyBytes,
    policy.normalMaxProjectPeakBytes,
    policy.hardMaxProjectPhysicalBytes,
  ];
  if (byteValues.some((value) => value <= 0n) || policy.measurementSafetyBps < 10_000n) {
    fail("CAPACITY_INVENTORY_INVALID", "Capacity byte policy values are invalid.");
  }
  if (
    policy.normalMaxReleaseServingBytes > policy.hardMaxReleaseServingBytes ||
    policy.normalMaxProjectSteadyBytes > policy.normalMaxProjectPeakBytes ||
    policy.normalMaxProjectPeakBytes > policy.hardMaxProjectPhysicalBytes ||
    !Number.isSafeInteger(policy.maximumApprovalMs) ||
    policy.maximumApprovalMs <= 0 ||
    !Number.isSafeInteger(policy.minimumGcGraceMs) ||
    policy.minimumGcGraceMs <= 0
  ) {
    fail("CAPACITY_INVENTORY_INVALID", "Capacity policy limits are inconsistent.");
  }
}

function activeReferenceRoots(
  roots: readonly GenerationReferenceRoot[],
  at: number,
): GenerationReferenceRoot[] {
  return roots.filter((root) => root.expiresAt === undefined || root.expiresAt > at);
}

function classifyGeneration(
  generation: GenerationFootprintInput,
  activeRoots: readonly GenerationReferenceRoot[],
): GenerationEstimate["classification"] {
  if (generation.state === "STAGING" || generation.state === "FAILED_STAGING") return "STAGING";
  if (activeRoots.some((root) => root.kind === "CHANNEL" || root.kind === "SERVING_HEAD")) {
    return "SERVING";
  }
  if (activeRoots.length > 0) return "PROTECTED";
  if (generation.derivedRecentSuccessful) return "RECENT_SUCCESS";
  return "ORPHAN";
}

function emptyClassificationBytes(): Record<GenerationEstimate["classification"], bigint> {
  return {
    SERVING: 0n,
    RECENT_SUCCESS: 0n,
    PROTECTED: 0n,
    STAGING: 0n,
    ORPHAN: 0n,
  };
}

function violation(
  code: CapacityErrorCode,
  scopeId: string,
  actualBytes: bigint,
  limitBytes: bigint,
): CapacityViolation {
  return {
    code,
    scopeId,
    actualBytes,
    limitBytes,
    message: `${scopeId} uses ${actualBytes} reserved bytes; limit is ${limitBytes}.`,
  };
}

function sumBigInt(values: readonly bigint[]): bigint {
  return values.reduce((sum, value) => sum + value, 0n);
}

function maxBigInt(values: readonly bigint[]): bigint {
  return values.reduce((maximum, value) => (value > maximum ? value : maximum), 0n);
}

function fail(code: CapacityErrorCode, message: string): never {
  throw new ProjectionCapacityError(code, message);
}
