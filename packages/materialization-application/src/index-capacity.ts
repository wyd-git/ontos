import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseOntosId,
  type ArtifactDigest,
} from "@ontos/contracts";
import {
  admitIndexPlan,
  assertCapacityAccepted,
  compileReleaseIndexPlan,
  evaluateCapacity,
  INDEX_PLAN_COMPILER_VERSION,
  type CapacityEvaluationInput,
  type CapacityReport,
  type CompiledIndexDefinition,
  type CompiledObjectTypeIndexPlan,
  type CompiledReleaseIndexPlan,
  type IndexAdmissionReport,
  type IndexCapacityApproval,
  type ProjectIndexInventory,
  type ProjectionCapacityApproval,
  type ReleaseIndexPlanInput,
} from "@ontos/materialization-domain";

export type IndexCapacityApplicationErrorCode =
  | "INDEX_CAPACITY_DEPENDENCY_UNAVAILABLE"
  | "INDEX_CAPACITY_INPUT_INVALID"
  | "INDEX_CAPACITY_PROTOCOL_CONFLICT";

export class IndexCapacityApplicationError extends Error {
  readonly code: IndexCapacityApplicationErrorCode;

  constructor(code: IndexCapacityApplicationErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "IndexCapacityApplicationError";
    this.code = code;
  }
}

export interface IndexCapacityCrypto {
  randomId(): string;
  digestCanonicalText(canonicalText: string): ArtifactDigest;
}

export interface PreparedIndexPlanEntry {
  readonly entryKey: string;
  readonly ordinal: number;
  readonly definition: CompiledIndexDefinition;
  readonly definitionDigest: ArtifactDigest;
}

export interface PreparedObjectTypeIndexPlan {
  readonly indexPlanId: string;
  readonly admissionId: string;
  readonly plan: CompiledObjectTypeIndexPlan;
  readonly entries: readonly PreparedIndexPlanEntry[];
}

export interface PersistAdmittedIndexPlansInput {
  readonly projectId: string;
  readonly releaseId: string;
  readonly releasePlanDigest: ArtifactDigest;
  readonly inventoryRevision: bigint;
  readonly plans: readonly PreparedObjectTypeIndexPlan[];
  readonly admission: IndexAdmissionReport;
  readonly reportDigest: ArtifactDigest;
}

export interface PersistedIndexPlanReference {
  readonly indexPlanId: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly planDigest: ArtifactDigest;
  readonly reused: boolean;
}

export interface IndexPlanAdmissionRepository {
  readIndexInventory(projectId: string): Promise<{
    readonly inventoryRevision: bigint;
    readonly inventory: ProjectIndexInventory;
  }>;
  persistAdmittedIndexPlans(
    input: PersistAdmittedIndexPlansInput,
  ): Promise<readonly PersistedIndexPlanReference[]>;
}

export interface StageReleaseIndexPlanInput {
  readonly plan: ReleaseIndexPlanInput;
  readonly at: number;
  readonly approval?: IndexCapacityApproval;
}

export interface StageReleaseIndexPlanResult {
  readonly compiled: CompiledReleaseIndexPlan;
  readonly admission: IndexAdmissionReport;
  readonly persistedPlans: readonly PersistedIndexPlanReference[];
  readonly reportDigest: ArtifactDigest;
}

export class IndexPlanAdmissionService {
  readonly #repository: IndexPlanAdmissionRepository;
  readonly #crypto: IndexCapacityCrypto;

  constructor(options: {
    readonly repository: IndexPlanAdmissionRepository;
    readonly crypto: IndexCapacityCrypto;
  }) {
    this.#repository = options.repository;
    this.#crypto = options.crypto;
  }

  async stageReleasePlan(input: StageReleaseIndexPlanInput): Promise<StageReleaseIndexPlanResult> {
    const projectId = parseOntosId(input.plan.projectId, "$indexPlan.projectId");
    parseOntosId(input.plan.releaseId, "$indexPlan.releaseId");
    if (!Number.isSafeInteger(input.at) || input.at < 0) {
      throw new IndexCapacityApplicationError("INDEX_CAPACITY_INPUT_INVALID");
    }
    const compiled = compileReleaseIndexPlan(input.plan, (value) =>
      parseArtifactDigest(this.#crypto.digestCanonicalText(value)),
    );
    const snapshot = await mapDependency(() => this.#repository.readIndexInventory(projectId));
    if (snapshot.inventoryRevision < 1n) {
      throw new IndexCapacityApplicationError("INDEX_CAPACITY_PROTOCOL_CONFLICT");
    }
    const admission = admitIndexPlan(compiled, snapshot.inventory, input.at, input.approval);
    const plans = compiled.objectTypes.map((plan) => this.#prepareObjectTypePlan(plan));
    const reportDigest = digestValue(this.#crypto, {
      schemaVersion: 1,
      contractVersion: "index-plan-admission-v1",
      compilerVersion: INDEX_PLAN_COMPILER_VERSION,
      projectId,
      releaseId: compiled.releaseId,
      inventoryRevision: snapshot.inventoryRevision.toString(),
      releasePlanDigest: compiled.planDigest,
      objectTypePlanDigests: plans.map((item) => item.plan.planDigest).sort(),
      admission,
    });
    const persistedPlans = await mapDependency(() =>
      this.#repository.persistAdmittedIndexPlans({
        projectId,
        releaseId: compiled.releaseId,
        releasePlanDigest: compiled.planDigest,
        inventoryRevision: snapshot.inventoryRevision,
        plans,
        admission,
        reportDigest,
      }),
    );
    if (persistedPlans.length !== plans.length) {
      throw new IndexCapacityApplicationError("INDEX_CAPACITY_PROTOCOL_CONFLICT");
    }
    return Object.freeze({ compiled, admission, persistedPlans, reportDigest });
  }

  #prepareObjectTypePlan(plan: CompiledObjectTypeIndexPlan): PreparedObjectTypeIndexPlan {
    const indexPlanId = parseOntosId(this.#crypto.randomId(), "$indexPlanId");
    const admissionId = parseOntosId(this.#crypto.randomId(), "$indexAdmissionId");
    const entries = [...plan.indexes]
      .sort((left, right) => left.physicalSignature.localeCompare(right.physicalSignature))
      .map((definition, ordinal) => {
        const entryKey = `entry_${definition.physicalSignature.slice("sha256:".length, 31)}`;
        return Object.freeze({
          entryKey,
          ordinal,
          definition,
          definitionDigest: digestValue(this.#crypto, definitionForPersistence(definition)),
        });
      });
    return Object.freeze({ indexPlanId, admissionId, plan, entries: Object.freeze(entries) });
  }
}

export interface CapacityAdmissionSnapshot {
  readonly input: CapacityEvaluationInput;
  readonly approval?: ProjectionCapacityApproval;
  readonly inventoryRevision: bigint;
  readonly indexPlanDigest: ArtifactDigest;
  readonly sourceForecastDigest: ArtifactDigest;
  readonly physicalMeasurementDigest?: ArtifactDigest;
}

export interface PersistCapacityAdmissionInput {
  readonly projectId: string;
  readonly generationId: string;
  readonly admissionId: string;
  readonly phase: "PREBUILD" | "POSTBUILD";
  readonly snapshot: CapacityAdmissionSnapshot;
  readonly report: CapacityReport;
  readonly reportDigest: ArtifactDigest;
}

export interface ProjectionCapacityAdmissionRepository {
  readCapacityAdmissionSnapshot(input: {
    readonly projectId: string;
    readonly generationId: string;
    readonly phase: "PREBUILD" | "POSTBUILD";
  }): Promise<CapacityAdmissionSnapshot>;
  persistCapacityAdmission(input: PersistCapacityAdmissionInput): Promise<void>;
}

export class ProjectionCapacityAdmissionService {
  readonly #repository: ProjectionCapacityAdmissionRepository;
  readonly #crypto: IndexCapacityCrypto;

  constructor(options: {
    readonly repository: ProjectionCapacityAdmissionRepository;
    readonly crypto: IndexCapacityCrypto;
  }) {
    this.#repository = options.repository;
    this.#crypto = options.crypto;
  }

  async admit(input: {
    readonly projectId: string;
    readonly generationId: string;
    readonly phase: "PREBUILD" | "POSTBUILD";
  }): Promise<CapacityReport> {
    const projectId = parseOntosId(input.projectId, "$capacity.projectId");
    const generationId = parseOntosId(input.generationId, "$capacity.generationId");
    const snapshot = await mapDependency(() =>
      this.#repository.readCapacityAdmissionSnapshot({ ...input, projectId, generationId }),
    );
    if (
      snapshot.inventoryRevision < 1n ||
      snapshot.input.projectId !== projectId ||
      (input.phase === "POSTBUILD" && snapshot.physicalMeasurementDigest === undefined) ||
      (input.phase === "PREBUILD" && snapshot.physicalMeasurementDigest !== undefined)
    ) {
      throw new IndexCapacityApplicationError("INDEX_CAPACITY_PROTOCOL_CONFLICT");
    }
    const report = evaluateCapacity(snapshot.input, snapshot.approval);
    assertCapacityAccepted(report);
    const admissionId = parseOntosId(this.#crypto.randomId(), "$capacityAdmissionId");
    const reportDigest = digestValue(this.#crypto, {
      schemaVersion: 1,
      contractVersion: "projection-capacity-admission-v1",
      projectId,
      generationId,
      phase: input.phase,
      inventoryRevision: snapshot.inventoryRevision.toString(),
      indexPlanDigest: snapshot.indexPlanDigest,
      sourceForecastDigest: snapshot.sourceForecastDigest,
      physicalMeasurementDigest: snapshot.physicalMeasurementDigest ?? null,
      report: capacityReportForPersistence(report),
    });
    await mapDependency(() =>
      this.#repository.persistCapacityAdmission({
        projectId,
        generationId,
        admissionId,
        phase: input.phase,
        snapshot,
        report,
        reportDigest,
      }),
    );
    return report;
  }
}

export function definitionForPersistence(
  definition: CompiledIndexDefinition,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    compilerVersion: INDEX_PLAN_COMPILER_VERSION,
    name: definition.name,
    physicalSignature: definition.physicalSignature,
    table: definition.table,
    resourceId: definition.resourceId,
    revisionId: definition.revisionId,
    predicate: definition.predicate,
    kind: definition.kind,
    recipe: definition.recipe,
    unique: definition.unique,
    unitCost: definition.unitCost,
    evidenceRefs: [...definition.evidenceRefs].sort(),
    keys: definition.keys,
  });
}

export function capacityReportForPersistence(
  report: CapacityReport,
): Readonly<Record<string, unknown>> {
  const bytes = (value: bigint) => value.toString();
  return Object.freeze({
    accepted: report.accepted,
    projectId: report.projectId,
    at: report.at,
    measuredBytes: bytes(report.measuredBytes),
    observedProjectPhysicalBytes: bytes(report.observedProjectPhysicalBytes),
    unattributedPhysicalBytes: bytes(report.unattributedPhysicalBytes),
    reservedBytes: bytes(report.reservedBytes),
    steadyReservedBytes: bytes(report.steadyReservedBytes),
    stagingReservedBytes: bytes(report.stagingReservedBytes),
    peakReservedBytes: bytes(report.peakReservedBytes),
    bytesByClassification: Object.fromEntries(
      Object.entries(report.bytesByClassification).map(([key, value]) => [key, bytes(value)]),
    ),
    releaseServingBytes: Object.fromEntries(
      Object.entries(report.releaseServingBytes).map(([key, value]) => [key, bytes(value)]),
    ),
    normalViolations: report.normalViolations.map(violationForPersistence),
    hardViolations: report.hardViolations.map(violationForPersistence),
    approvalId: report.approvalId,
  });
}

function violationForPersistence(violation: CapacityReport["normalViolations"][number]) {
  return {
    code: violation.code,
    scopeId: violation.scopeId,
    actualBytes: violation.actualBytes.toString(),
    limitBytes: violation.limitBytes.toString(),
  };
}

function digestValue(crypto: IndexCapacityCrypto, value: unknown): ArtifactDigest {
  return parseArtifactDigest(
    crypto.digestCanonicalText(canonicalizeContractForDigest(value)),
    "$indexCapacityDigest",
  );
}

async function mapDependency<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IndexCapacityApplicationError) throw error;
    throw new IndexCapacityApplicationError("INDEX_CAPACITY_DEPENDENCY_UNAVAILABLE", {
      cause: error,
    });
  }
}
