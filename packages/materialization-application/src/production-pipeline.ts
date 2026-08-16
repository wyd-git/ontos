import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseOntosId,
  type ArtifactDigest,
} from "@ontos/contracts";
import {
  ManagedCsvError,
  MappingCompileError,
  MappingExecutionError,
  compileMapping,
  executeManagedCsvMapping,
  type CompiledMappingPlan,
  type MappingAcceptedLinkRow,
  type MappingAcceptedObjectRow,
  type MappingRejectedRow,
  type MappingRowEvent,
} from "@ontos/materialization-domain";

import {
  MATERIALIZATION_BASE_BATCH_MAXIMUM_ROWS,
  MaterializationBaseError,
  type BaseBatchReceipt,
  type MaterializationAttemptScope,
  type MaterializationBaseService,
  type MaterializationGenerationBinding,
} from "./base.ts";
import {
  IndexCapacityApplicationError,
  type ProjectionCapacityAdmissionService,
} from "./index-capacity.ts";
import {
  CertifiedZeroOverlayProvider,
  OverlayCutoverError,
  catchUpOverlay,
  type OverlayProvider,
} from "./overlay.ts";
import {
  MATERIALIZATION_QUALITY_PAGE_SIZE,
  MaterializationQualityError,
  observationsFromMappingRejections,
  provenanceTemplatesFromPlan,
  type MaterializationQualityCrypto,
  type MaterializationQualityObservation,
  type MaterializationQualityService,
} from "./quality.ts";
import {
  MaterializationStageError,
  type MaterializationStageExecution,
  type MaterializationStageExecutor,
  type MaterializationStageResult,
  type MaterializationWorkerStage,
} from "./worker.ts";

export interface ProductionMaterializationFile {
  readonly fileId: string;
  readonly ordinal: number;
  readonly objectKey: string;
  readonly objectVersion: string;
  readonly contentDigest: ArtifactDigest;
  readonly byteCount: number;
  readonly rowCount: number;
  readonly mediaType: "text/csv";
}

export interface ProductionMaterializationMember {
  readonly generationId: string;
  readonly generationState: "building" | "ready" | "active";
  readonly qualityState: "passed" | "awaiting_confirmation" | "confirmed" | "failed" | null;
  readonly basePromoted: boolean;
  readonly memberKey: string;
  readonly memberKind: "object" | "link";
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly targetDefinitionDigest: ArtifactDigest;
  readonly targetDefinition: unknown;
  readonly sourceObject: {
    readonly resourceId: string;
    readonly revisionId: string;
    readonly definitionDigest: ArtifactDigest;
    readonly definition: unknown;
  } | null;
  readonly targetObject: {
    readonly resourceId: string;
    readonly revisionId: string;
    readonly definitionDigest: ArtifactDigest;
    readonly definition: unknown;
  } | null;
  readonly snapshotId: string;
  readonly snapshotDigest: ArtifactDigest;
  readonly snapshotContentDigest: ArtifactDigest;
  readonly snapshotRowCount: number;
  readonly snapshotByteCount: number;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
  readonly snapshotGroupKey: string;
  readonly snapshotSchemaResourceId: string;
  readonly snapshotSchemaRevisionId: string;
  readonly snapshotSchemaDigest: ArtifactDigest;
  readonly snapshotSchemaDefinition: unknown;
  readonly mappingResourceId: string;
  readonly mappingRevisionId: string;
  readonly mappingDigest: ArtifactDigest;
  readonly mappingDefinition: unknown;
  readonly runtimePlanDigest: ArtifactDigest;
  readonly indexPlanDigest: ArtifactDigest;
  readonly files: readonly ProductionMaterializationFile[];
}

export interface ProductionMaterializationPipelineRepository {
  discoverMemberKeys(scope: MaterializationAttemptScope): Promise<readonly string[]>;
  prepareBuild(input: {
    readonly scope: MaterializationAttemptScope;
    readonly candidates: readonly {
      readonly memberKey: string;
      readonly generationId: string;
      readonly forecastId: string;
    }[];
  }): Promise<readonly ProductionMaterializationMember[]>;
  readBuild(
    scope: MaterializationAttemptScope,
  ): Promise<readonly ProductionMaterializationMember[]>;
  readCurrentInventoryRevision(projectId: string): Promise<bigint>;
  hasCurrentCapacityAdmission(input: {
    readonly projectId: string;
    readonly generationId: string;
    readonly phase: "PREBUILD" | "POSTBUILD";
  }): Promise<boolean>;
  hasAnyCurrentPostbuildAdmission(input: {
    readonly projectId: string;
    readonly generationIds: readonly string[];
  }): Promise<boolean>;
  verifyIndexInventory(scope: MaterializationAttemptScope): Promise<ArtifactDigest>;
  rebindIndexAdmissions(scope: MaterializationAttemptScope): Promise<number>;
  finishBuild(scope: MaterializationAttemptScope): Promise<ArtifactDigest>;
}

export interface ProductionMaterializationObjectStore {
  headLatestVersion(objectKey: string): Promise<{
    readonly versionId: string;
    readonly byteCount: number;
    readonly mediaType: string | null;
  }>;
  readVersion(
    objectKey: string,
    versionId: string,
  ): Promise<{
    readonly versionId: string;
    readonly byteCount: number;
    readonly mediaType: string | null;
    readonly body: AsyncIterable<Uint8Array>;
  }>;
}

export interface ProductionMaterializationPipelineCrypto extends MaterializationQualityCrypto {
  randomId(): string;
  digestCanonicalText(value: string): ArtifactDigest;
}

export interface ProductionMaterializationStageExecutorOptions {
  readonly repository: ProductionMaterializationPipelineRepository;
  readonly objectStore: ProductionMaterializationObjectStore;
  readonly base: MaterializationBaseService;
  readonly quality: MaterializationQualityService;
  readonly capacity: ProjectionCapacityAdmissionService;
  readonly scanPhysicalInventory: (input: {
    readonly projectId: string;
    readonly expectedInventoryRevision: bigint;
  }) => Promise<{ readonly inventoryRevision: bigint; readonly measurementDigest: ArtifactDigest }>;
  readonly crypto: ProductionMaterializationPipelineCrypto;
  readonly overlays?: OverlayProvider;
}

/**
 * Production composition for the eight durable Worker stages. The last stage
 * closes the build as READY; it intentionally does not activate a Release or
 * move a serving pointer. Those privileged operations remain Admin/Owner only.
 */
export class ProductionMaterializationStageExecutor implements MaterializationStageExecutor {
  readonly #repository: ProductionMaterializationPipelineRepository;
  readonly #objectStore: ProductionMaterializationObjectStore;
  readonly #base: MaterializationBaseService;
  readonly #quality: MaterializationQualityService;
  readonly #capacity: ProjectionCapacityAdmissionService;
  readonly #scanPhysicalInventory: ProductionMaterializationStageExecutorOptions["scanPhysicalInventory"];
  readonly #crypto: ProductionMaterializationPipelineCrypto;
  readonly #overlays: OverlayProvider;

  constructor(options: ProductionMaterializationStageExecutorOptions) {
    this.#repository = options.repository;
    this.#objectStore = options.objectStore;
    this.#base = options.base;
    this.#quality = options.quality;
    this.#capacity = options.capacity;
    this.#scanPhysicalInventory = options.scanPhysicalInventory;
    this.#crypto = options.crypto;
    this.#overlays = options.overlays ?? new CertifiedZeroOverlayProvider();
  }

  async execute(input: MaterializationStageExecution): Promise<MaterializationStageResult> {
    try {
      throwIfAborted(input.signal);
      const scope = scopeFrom(input);
      switch (input.stage) {
        case "scan":
          return this.#scan(input, scope);
        case "map":
          return this.#map(input, scope);
        case "validate":
          return this.#validate(input, scope);
        case "build_stage":
          return this.#admitPrebuild(input, scope);
        case "build_index":
          return this.#verifyIndexes(input, scope);
        case "ready_for_activation":
          return this.#prepareReady(input, scope);
        case "catch_up":
          return this.#catchUp(input, scope);
        case "activate":
          return this.#finishReady(input, scope);
      }
    } catch (error) {
      if (error instanceof MaterializationStageError) throw error;
      throw stageFailure(input.stage, error, this.#crypto);
    }
  }

  async #scan(
    input: MaterializationStageExecution,
    scope: MaterializationAttemptScope,
  ): Promise<MaterializationStageResult> {
    const memberKeys = await this.#repository.discoverMemberKeys(scope);
    const members = await this.#repository.prepareBuild({
      scope,
      candidates: memberKeys.map((memberKey) => ({
        memberKey,
        generationId: parseOntosId(this.#crypto.randomId()),
        forecastId: parseOntosId(this.#crypto.randomId()),
      })),
    });
    for (const member of members) {
      for (const file of member.files) {
        throwIfAborted(input.signal);
        const actual = await this.#objectStore.headLatestVersion(file.objectKey);
        if (
          actual.versionId !== file.objectVersion ||
          actual.byteCount !== file.byteCount ||
          actual.mediaType?.split(";", 1)[0]?.trim().toLowerCase() !== "text/csv"
        ) {
          throw new PipelineProtocolError("SOURCE_OBJECT_VERSION_MISMATCH");
        }
      }
    }
    return stageResult(input, this.#crypto, {
      memberCount: members.length,
      members: members.map(memberEvidence),
    });
  }

  async #map(
    input: MaterializationStageExecution,
    scope: MaterializationAttemptScope,
  ): Promise<MaterializationStageResult> {
    const members = await this.#repository.readBuild(scope);
    let nextBatchSequence = 1;
    const outcomes: unknown[] = [];
    for (const member of members) {
      throwIfAborted(input.signal);
      if (member.basePromoted) {
        outcomes.push({ memberKey: member.memberKey, reused: true });
        continue;
      }
      const plan = compileMember(member, this.#crypto);
      const receipts: BaseBatchReceipt[] = [];
      let stagedRows = 0;
      for (const file of member.files) {
        const accepted: (MappingAcceptedObjectRow | MappingAcceptedLinkRow)[] = [];
        const rejected: MappingRejectedRow[] = [];
        const flushRejected = async (): Promise<void> => {
          if (rejected.length === 0) return;
          await this.#quality.stageObservations({
            scope,
            generationId: member.generationId,
            observations: observationsFromMappingRejections(
              { fileId: file.fileId, rejectedRows: rejected.splice(0) },
              this.#crypto,
            ),
          });
        };
        const flushAccepted = async (): Promise<void> => {
          if (accepted.length === 0) return;
          const batchSequence = nextBatchSequence;
          nextBatchSequence += 1;
          const rows = accepted.splice(0);
          const generation = generationBinding(member, file.fileId);
          if (plan.targetKind === "object") {
            const receipt = await this.#base.stageObjectBatch({
              scope,
              generation,
              batchSequence,
              rows: rows as MappingAcceptedObjectRow[],
            });
            receipts.push(receipt);
            stagedRows += receipt.stagedRowCount;
          } else {
            const receipt = await this.#base.stageLinkBatch({
              scope,
              generation,
              batchSequence,
              rows: rows as MappingAcceptedLinkRow[],
            });
            receipts.push(receipt);
            stagedRows += receipt.stagedRowCount;
            if (receipt.dangling.length > 0) {
              const disposition = plan.linkDanglingDisposition ?? "required";
              const observations: MaterializationQualityObservation[] = receipt.dangling.map(
                (dangling) =>
                  Object.freeze({
                    fileId: file.fileId,
                    rowNumber: dangling.rowNumber,
                    reasonCode:
                      disposition === "optional"
                        ? ("OPTIONAL_LINK_DANGLING" as const)
                        : ("REQUIRED_LINK_DANGLING" as const),
                    fingerprint: dangling.fingerprint,
                    columnClassification: "identifier" as const,
                    phase: "identity_lookup" as const,
                  }),
              );
              await this.#stageObservationPages(scope, member.generationId, observations);
            }
          }
        };
        const source = await this.#objectStore.readVersion(file.objectKey, file.objectVersion);
        if (
          source.versionId !== file.objectVersion ||
          source.byteCount !== file.byteCount ||
          source.mediaType?.split(";", 1)[0]?.trim().toLowerCase() !== "text/csv"
        ) {
          throw new PipelineProtocolError("SOURCE_OBJECT_VERSION_MISMATCH");
        }
        const result = await executeManagedCsvMapping({
          plan,
          sourceContentDigest: file.contentDigest,
          source: source.body,
          digestCanonicalText: (value) => this.#crypto.digestCanonicalText(value),
          sink: {
            async write(event: MappingRowEvent) {
              throwIfAborted(input.signal);
              if (event.kind === "rejected") {
                rejected.push(event);
                if (rejected.length >= MATERIALIZATION_QUALITY_PAGE_SIZE) await flushRejected();
              } else {
                accepted.push(event);
                if (accepted.length >= MATERIALIZATION_BASE_BATCH_MAXIMUM_ROWS) {
                  await flushAccepted();
                }
              }
            },
          },
        });
        await flushAccepted();
        await flushRejected();
        if (result.scan.byteCount !== file.byteCount || result.scan.rowCount !== file.rowCount) {
          throw new PipelineProtocolError("SOURCE_OBJECT_CONTENT_MISMATCH");
        }
      }
      const promoted = await this.#base.promoteGenerationBase({
        scope,
        generationId: member.generationId,
        expectedRowCount: stagedRows,
        batchReceipts: receipts,
      });
      outcomes.push({
        memberKey: member.memberKey,
        rowCount: promoted.rowCount,
        stageDigest: promoted.stageDigest,
        reused: promoted.reused,
      });
    }
    return stageResult(input, this.#crypto, { members: outcomes });
  }

  async #validate(
    input: MaterializationStageExecution,
    scope: MaterializationAttemptScope,
  ): Promise<MaterializationStageResult> {
    const members = await this.#repository.readBuild(scope);
    const results: unknown[] = [];
    for (const member of members) {
      throwIfAborted(input.signal);
      if (member.qualityState === "failed") {
        throw new PipelineProtocolError("MATERIALIZATION_QUALITY_FAILED");
      }
      if (member.qualityState === "awaiting_confirmation") {
        throw new PipelineProtocolError("ROW_COUNT_CONFIRMATION_REQUIRED");
      }
      if (member.qualityState === "passed" || member.qualityState === "confirmed") {
        results.push({ memberKey: member.memberKey, outcome: member.qualityState, reused: true });
        continue;
      }
      const plan = compileMember(member, this.#crypto);
      const result = await this.#quality.build({
        scope,
        generationId: member.generationId,
        provenanceTemplates:
          plan.targetKind === "object" ? provenanceTemplatesFromPlan(plan, this.#crypto) : [],
      });
      if (result.outcome === "failed") {
        throw new PipelineProtocolError("MATERIALIZATION_QUALITY_FAILED");
      }
      if (result.outcome === "awaiting_confirmation") {
        throw new PipelineProtocolError("ROW_COUNT_CONFIRMATION_REQUIRED");
      }
      results.push({
        memberKey: member.memberKey,
        outcome: result.outcome,
        reportDigest: result.reportDigest,
        generationDigest: result.generationDigest,
      });
    }
    return stageResult(input, this.#crypto, { members: results });
  }

  async #admitPrebuild(
    input: MaterializationStageExecution,
    scope: MaterializationAttemptScope,
  ): Promise<MaterializationStageResult> {
    const members = await this.#repository.readBuild(scope);
    const results: unknown[] = [];
    for (const member of members) {
      throwIfAborted(input.signal);
      const reused = await this.#repository.hasCurrentCapacityAdmission({
        projectId: scope.projectId,
        generationId: member.generationId,
        phase: "PREBUILD",
      });
      const report = reused
        ? null
        : await this.#capacity.admit({
            projectId: scope.projectId,
            generationId: member.generationId,
            phase: "PREBUILD",
          });
      results.push({
        memberKey: member.memberKey,
        reused,
        report: report === null ? null : capacityEvidence(report),
      });
    }
    return stageResult(input, this.#crypto, { members: results });
  }

  async #verifyIndexes(
    input: MaterializationStageExecution,
    scope: MaterializationAttemptScope,
  ): Promise<MaterializationStageResult> {
    const digest = await this.#repository.verifyIndexInventory(scope);
    return stageResult(input, this.#crypto, { inventoryDigest: digest });
  }

  async #prepareReady(
    input: MaterializationStageExecution,
    scope: MaterializationAttemptScope,
  ): Promise<MaterializationStageResult> {
    const members = await this.#repository.readBuild(scope);
    const generationIds = members.map((member) => member.generationId);
    const allCurrent = await Promise.all(
      generationIds.map((generationId) =>
        this.#repository.hasCurrentCapacityAdmission({
          projectId: scope.projectId,
          generationId,
          phase: "POSTBUILD",
        }),
      ),
    );
    let measurement: {
      readonly inventoryRevision: bigint;
      readonly measurementDigest: ArtifactDigest;
    } | null = null;
    if (!allCurrent.every(Boolean)) {
      const anyCurrent = await this.#repository.hasAnyCurrentPostbuildAdmission({
        projectId: scope.projectId,
        generationIds,
      });
      if (!anyCurrent) {
        const revision = await this.#repository.readCurrentInventoryRevision(scope.projectId);
        measurement = await this.#scanPhysicalInventory({
          projectId: scope.projectId,
          expectedInventoryRevision: revision,
        });
      }
      await this.#repository.rebindIndexAdmissions(scope);
      for (const member of members) {
        throwIfAborted(input.signal);
        if (
          !(await this.#repository.hasCurrentCapacityAdmission({
            projectId: scope.projectId,
            generationId: member.generationId,
            phase: "POSTBUILD",
          }))
        ) {
          await this.#capacity.admit({
            projectId: scope.projectId,
            generationId: member.generationId,
            phase: "POSTBUILD",
          });
        }
      }
    }
    return stageResult(input, this.#crypto, {
      generationCount: members.length,
      inventoryRevision:
        measurement?.inventoryRevision.toString() ??
        (await this.#repository.readCurrentInventoryRevision(scope.projectId)).toString(),
      measurementDigest: measurement?.measurementDigest ?? null,
    });
  }

  async #catchUp(
    input: MaterializationStageExecution,
    scope: MaterializationAttemptScope,
  ): Promise<MaterializationStageResult> {
    const member = (await this.#repository.readBuild(scope))[0];
    if (member === undefined) throw new PipelineProtocolError("BUILD_INPUT_INCOMPLETE");
    const result = await catchUpOverlay(
      {
        mode: "PRODUCTION_ZERO",
        projectId: scope.projectId,
        snapshotGroupKey: member.snapshotGroupKey,
        stagedHeads: Object.freeze({}),
      },
      this.#overlays,
    );
    return stageResult(input, this.#crypto, {
      providerId: result.finalEvidence.providerId,
      providerVersion: result.finalEvidence.providerVersion,
      watermark: result.finalWatermark,
      deltaCount: result.finalEvidence.deltaCount,
      evidenceDigest: result.finalEvidence.digest,
    });
  }

  async #finishReady(
    input: MaterializationStageExecution,
    scope: MaterializationAttemptScope,
  ): Promise<MaterializationStageResult> {
    const readinessDigest = await this.#repository.finishBuild(scope);
    return stageResult(input, this.#crypto, {
      readinessDigest,
      servingPointerMoved: false,
      ownerActivationRequired: true,
    });
  }

  async #stageObservationPages(
    scope: MaterializationAttemptScope,
    generationId: string,
    observations: readonly MaterializationQualityObservation[],
  ): Promise<void> {
    for (
      let offset = 0;
      offset < observations.length;
      offset += MATERIALIZATION_QUALITY_PAGE_SIZE
    ) {
      await this.#quality.stageObservations({
        scope,
        generationId,
        observations: observations.slice(offset, offset + MATERIALIZATION_QUALITY_PAGE_SIZE),
      });
    }
  }
}

function compileMember(
  member: ProductionMaterializationMember,
  crypto: Pick<ProductionMaterializationPipelineCrypto, "digestCanonicalText">,
): CompiledMappingPlan {
  const common = {
    mappingRevisionId: member.mappingRevisionId,
    mappingRevisionDigest: member.mappingDigest,
    mapping: member.mappingDefinition,
    inputSchemaRevisionId: member.snapshotSchemaRevisionId,
    inputSchemaDigest: member.snapshotSchemaDigest,
    inputSchema: member.snapshotSchemaDefinition,
  };
  return compileMapping(
    member.memberKind === "object"
      ? {
          ...common,
          target: {
            kind: "object",
            resourceId: member.targetResourceId,
            revisionId: member.targetRevisionId,
            definitionDigest: member.targetDefinitionDigest,
            definition: member.targetDefinition,
          },
        }
      : {
          ...common,
          target: {
            kind: "link",
            resourceId: member.targetResourceId,
            revisionId: member.targetRevisionId,
            definitionDigest: member.targetDefinitionDigest,
            definition: member.targetDefinition,
            sourceObject: requiredEndpoint(member.sourceObject),
            targetObject: requiredEndpoint(member.targetObject),
          },
        },
    (value) => crypto.digestCanonicalText(value),
  );
}

function requiredEndpoint(
  value: ProductionMaterializationMember["sourceObject"],
): NonNullable<ProductionMaterializationMember["sourceObject"]> {
  if (value === null) throw new PipelineProtocolError("BUILD_INPUT_INCOMPLETE");
  return value;
}

function generationBinding(
  member: ProductionMaterializationMember,
  fileId: string,
): MaterializationGenerationBinding {
  return Object.freeze({
    generationId: member.generationId,
    targetResourceId: member.targetResourceId,
    targetRevisionId: member.targetRevisionId,
    sourceSnapshotId: member.snapshotId,
    sourceFileId: fileId,
    mappingRevisionId: member.mappingRevisionId,
  });
}

function scopeFrom(input: MaterializationStageExecution): MaterializationAttemptScope {
  return Object.freeze({
    projectId: input.job.projectId,
    jobId: input.job.jobId,
    attemptId: input.job.lease.attemptId,
    fencingToken: input.job.lease.fencingToken,
  });
}

function memberEvidence(
  member: ProductionMaterializationMember,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    generationId: member.generationId,
    memberKey: member.memberKey,
    snapshotDigest: member.snapshotDigest,
    runtimePlanDigest: member.runtimePlanDigest,
    indexPlanDigest: member.indexPlanDigest,
    files: member.files.map((file) => ({
      fileId: file.fileId,
      ordinal: file.ordinal,
      contentDigest: file.contentDigest,
      byteCount: file.byteCount,
      rowCount: file.rowCount,
      objectVersion: file.objectVersion,
    })),
  });
}

function capacityEvidence(report: {
  readonly accepted: boolean;
  readonly measuredBytes: bigint;
  readonly reservedBytes: bigint;
  readonly peakReservedBytes: bigint;
  readonly approvalId: string | null;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    accepted: report.accepted,
    measuredBytes: report.measuredBytes.toString(),
    reservedBytes: report.reservedBytes.toString(),
    peakReservedBytes: report.peakReservedBytes.toString(),
    approvalId: report.approvalId,
  });
}

function stageResult(
  input: MaterializationStageExecution,
  crypto: Pick<ProductionMaterializationPipelineCrypto, "digestCanonicalText">,
  evidence: unknown,
): MaterializationStageResult {
  const outputDigest = parseArtifactDigest(
    crypto.digestCanonicalText(
      canonicalizeContractForDigest({
        schemaVersion: 1,
        contractVersion: "materialization-production-stage-v1",
        projectId: input.job.projectId,
        jobId: input.job.jobId,
        snapshotGroupId: input.job.snapshotGroupId,
        groupVersion: input.job.groupVersion,
        inputDigest: input.job.inputDigest,
        stage: input.stage,
        sequence: input.sequence,
        evidence,
      }),
    ),
  );
  return Object.freeze({
    outputReferenceId: uuidFromDigest(outputDigest),
    outputDigest,
  });
}

function uuidFromDigest(digest: ArtifactDigest): string {
  const source = digest.slice("sha256:".length, "sha256:".length + 32).split("");
  source[12] = "5";
  const variant = Number.parseInt(source[16] ?? "0", 16);
  source[16] = ((variant & 0x3) | 0x8).toString(16);
  const value = source.join("");
  return parseOntosId(
    `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`,
  );
}

class PipelineProtocolError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "PipelineProtocolError";
    this.code = code;
  }
}

function stageFailure(
  stage: MaterializationWorkerStage,
  error: unknown,
  crypto: Pick<ProductionMaterializationPipelineCrypto, "digestCanonicalText">,
): MaterializationStageError {
  const sourceCode = errorCode(error);
  const confirmation = sourceCode === "ROW_COUNT_CONFIRMATION_REQUIRED";
  const fenced = /FENCED|LEASE/u.test(sourceCode);
  const dependency =
    /DEPENDENCY|UNAVAILABLE|CONNECTION|TIMEOUT/u.test(sourceCode) ||
    sourceCode === "CAPACITY_INVENTORY_STALE";
  const retryable = confirmation || fenced || dependency;
  const category = confirmation
    ? ("throttled" as const)
    : fenced
      ? ("lease" as const)
      : dependency
        ? ("dependency" as const)
        : ("permanent" as const);
  const stableCode = /^[A-Z][A-Z0-9_]{1,63}$/u.test(sourceCode)
    ? sourceCode
    : "PIPELINE_STAGE_FAILED";
  return new MaterializationStageError(
    {
      code: stableCode,
      category,
      retryable,
      fingerprint: parseArtifactDigest(
        crypto.digestCanonicalText(
          canonicalizeContractForDigest({
            schemaVersion: 1,
            contractVersion: "materialization-stage-failure-v1",
            stage,
            code: stableCode,
            category,
          }),
        ),
      ),
    },
    [],
    { cause: error },
  );
}

function errorCode(error: unknown): string {
  if (
    error instanceof PipelineProtocolError ||
    error instanceof MaterializationBaseError ||
    error instanceof MaterializationQualityError ||
    error instanceof IndexCapacityApplicationError ||
    error instanceof ManagedCsvError ||
    error instanceof MappingCompileError ||
    error instanceof MappingExecutionError ||
    error instanceof OverlayCutoverError
  ) {
    return error.code;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "PIPELINE_STAGE_FAILED";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new PipelineProtocolError("MATERIALIZATION_JOB_FENCED");
}
