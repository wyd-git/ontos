import {
  canonicalizeContractForDigest,
  canonicalizeMaterializationContractForDigest,
  parseArtifactDigest,
  parseCanonicalInstant,
  parseMaterializationReport,
  parseOntosId,
  type ArtifactDigest,
  type CanonicalInstant,
  type MappingQualityRules,
  type MaterializationReasonCode,
  type MaterializationReportContract,
} from "@ontos/contracts";
import type { CompiledObjectMappingPlan, MappingRejectedRow } from "@ontos/materialization-domain";
import {
  parseVerifiedFoundationIdentity,
  type ManagementAuthorizer,
  type PrincipalDirectory,
  type ResolvedFoundationIdentity,
  type VerifiedFoundationIdentity,
} from "@ontos/metadata-application";

import type { MaterializationAttemptScope } from "./base.ts";

export const MATERIALIZATION_QUALITY_VALIDATOR_VERSION = "materialization-quality-v1";
export const MATERIALIZATION_QUALITY_PAGE_SIZE = 1_000;
export const MATERIALIZATION_REPORT_SAMPLE_LIMIT = 50;
export const REJECTED_ROW_ARTIFACT_MAXIMUM_BYTES = 256 * 1024 * 1024;
export const REJECTED_ROW_MEDIA_TYPE = "application/vnd.ontos.rejected-rows+json";

export type MaterializationQualityErrorCode =
  | "DEPENDENCY_UNAVAILABLE"
  | "FORBIDDEN"
  | "MATERIALIZATION_ATTEMPT_FENCED"
  | "PROVENANCE_INCOMPLETE"
  | "QUALITY_CONFIRMATION_INVALID"
  | "QUALITY_REQUEST_INVALID"
  | "REJECTED_ARTIFACT_TOO_LARGE"
  | "STAGING_CURRENT_CONFLICT"
  | "ZERO_OVERLAY_REQUIRED";

const qualityErrorMessages = Object.freeze({
  DEPENDENCY_UNAVAILABLE: "A materialization quality dependency is temporarily unavailable.",
  FORBIDDEN: "The materialization quality operation is not permitted.",
  MATERIALIZATION_ATTEMPT_FENCED: "The materialization Attempt no longer owns its lease.",
  PROVENANCE_INCOMPLETE: "The Current projection is missing required provenance.",
  QUALITY_CONFIRMATION_INVALID: "The row-count confirmation is stale or invalid.",
  QUALITY_REQUEST_INVALID: "The materialization quality request is invalid.",
  REJECTED_ARTIFACT_TOO_LARGE: "The rejected-row artifact exceeds its hard byte limit.",
  STAGING_CURRENT_CONFLICT: "The immutable Staging Current conflicts with this quality run.",
  ZERO_OVERLAY_REQUIRED: "The production materialization path requires a proven zero overlay.",
} satisfies Readonly<Record<MaterializationQualityErrorCode, string>>);

export class MaterializationQualityError extends Error {
  readonly code: MaterializationQualityErrorCode;

  constructor(code: MaterializationQualityErrorCode, options?: ErrorOptions) {
    super(qualityErrorMessages[code], options);
    this.name = "MaterializationQualityError";
    this.code = code;
  }
}

export type QualityColumnClassification =
  "identifier" | "internal" | "confidential" | "restricted" | "redacted";

/** A value-free row observation. Raw values, PKs and column names are forbidden. */
export interface MaterializationQualityObservation {
  readonly fileId: string;
  readonly rowNumber: number;
  readonly reasonCode: Exclude<MaterializationReasonCode, "ROW_COUNT_CONFIRMATION_REQUIRED">;
  readonly fingerprint: ArtifactDigest;
  readonly columnClassification: QualityColumnClassification;
  readonly phase: "mapping" | "identity_lookup" | "primary_key_collision" | "current_resolution";
}

export interface QualityObservationCursor {
  readonly fileId: string;
  readonly rowNumber: number;
  readonly reasonCode: Exclude<MaterializationReasonCode, "ROW_COUNT_CONFIRMATION_REQUIRED">;
  readonly fingerprint: ArtifactDigest;
}

export interface QualityObservationPage {
  readonly items: readonly MaterializationQualityObservation[];
  readonly nextCursor: QualityObservationCursor | null;
}

export interface PropertyProvenanceTemplate {
  readonly propertyApiName: string;
  readonly sourceIndex: number;
  readonly sourceKind: "column" | "constant";
  readonly inputColumnOrdinal: number | null;
  readonly sourceExpressionDigest: ArtifactDigest;
  readonly algorithmVersion: string;
}

export interface MaterializationQualityScopeRecord {
  readonly projectId: string;
  readonly jobId: string;
  readonly generationId: string;
  readonly memberKind: "object" | "link";
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly snapshotId: string;
  readonly snapshotDigest: ArtifactDigest;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
  readonly mappingRevisionId: string;
  readonly mappingRevisionDigest: ArtifactDigest;
  readonly sourceRowCount: number;
  readonly previousAcceptedRows: number | null;
  readonly qualityRules: MappingQualityRules;
  readonly linkDanglingDisposition: "required" | "optional";
  readonly publicationControlSequence: bigint;
}

export interface PreparedQualitySummary {
  readonly totalRows: number;
  readonly acceptedRows: number;
  readonly rejectedRows: number;
  readonly reasonCounts: readonly {
    readonly code: Exclude<MaterializationReasonCode, "ROW_COUNT_CONFIRMATION_REQUIRED">;
    readonly count: number;
  }[];
  readonly observationDigest: ArtifactDigest;
  readonly currentDigest: ArtifactDigest;
  readonly provenanceDigest: ArtifactDigest;
}

export interface RejectedArtifactBinding {
  readonly rejectedRowSetId: string;
  readonly managedArtifactId: string;
  readonly objectKey: string;
  readonly objectVersion: string;
  readonly byteCount: number;
  readonly contentDigest: ArtifactDigest;
  readonly rejectedRowCount: number;
  readonly mediaType: typeof REJECTED_ROW_MEDIA_TYPE;
}

export interface FinalizedQualityResult {
  readonly projectId: string;
  readonly generationId: string;
  readonly outcome: "passed" | "awaiting_confirmation" | "failed";
  readonly reportId: string;
  readonly reportDigest: ArtifactDigest;
  readonly generationDigest: ArtifactDigest;
  readonly qualityBindingDigest: ArtifactDigest;
}

export interface MaterializationQualityRepository {
  getGenerationQualityScope(input: {
    readonly scope: MaterializationAttemptScope;
    readonly generationId: string;
  }): Promise<MaterializationQualityScopeRecord>;
  stageQualityObservations(input: {
    readonly scope: MaterializationAttemptScope;
    readonly generationId: string;
    readonly observations: readonly MaterializationQualityObservation[];
  }): Promise<void>;
  prepareStagingCurrent(input: {
    readonly scope: MaterializationAttemptScope;
    readonly generationId: string;
    readonly provenanceTemplates: readonly PropertyProvenanceTemplate[];
  }): Promise<PreparedQualitySummary>;
  listRejectedObservations(input: {
    readonly projectId: string;
    readonly generationId: string;
    readonly after: QualityObservationCursor | null;
    readonly limit: number;
  }): Promise<QualityObservationPage>;
  finalizeGenerationQuality(input: {
    readonly scope: MaterializationAttemptScope;
    readonly generationId: string;
    readonly expectedObservationDigest: ArtifactDigest;
    readonly expectedCurrentDigest: ArtifactDigest;
    readonly expectedProvenanceDigest: ArtifactDigest;
    readonly report: MaterializationReportContract;
    readonly rejectedArtifact: RejectedArtifactBinding | null;
    readonly generationDigest: ArtifactDigest;
    readonly qualityBindingDigest: ArtifactDigest;
  }): Promise<FinalizedQualityResult>;
  getConfirmationScope(input: {
    readonly projectId: string;
    readonly generationId: string;
  }): Promise<RowCountConfirmationScope>;
  recordRowCountConfirmation(input: RowCountConfirmationRecord): Promise<FinalizedQualityResult>;
}

export interface ZeroOverlayInventoryPort {
  inspect(input: {
    readonly projectId: string;
    readonly snapshotGroupId: string;
    readonly groupVersion: number;
  }): Promise<{ readonly state: "known" | "unknown"; readonly rowCount: number | null }>;
}

export interface RejectedRowArtifactStore {
  putVersion(input: {
    readonly objectKey: string;
    readonly body: AsyncIterable<Uint8Array>;
    readonly expectedByteCount: number;
    readonly mediaType: typeof REJECTED_ROW_MEDIA_TYPE;
  }): Promise<{
    readonly versionId: string;
    readonly byteCount: number;
    readonly mediaType: string | null;
  }>;
}

export interface MaterializationQualityCrypto {
  randomId(): string;
  digestCanonicalText(value: string): ArtifactDigest;
  createStreamingDigest(): {
    update(chunk: Uint8Array): void;
    finish(): ArtifactDigest;
  };
}

export interface MaterializationQualityClock {
  now(): CanonicalInstant;
}

export interface MaterializationQualityServiceOptions {
  readonly repository: MaterializationQualityRepository;
  readonly overlays: ZeroOverlayInventoryPort;
  readonly artifacts: RejectedRowArtifactStore;
  readonly crypto: MaterializationQualityCrypto;
  readonly clock: MaterializationQualityClock;
  readonly maximumRejectedArtifactBytes?: number;
}

export interface BuildGenerationQualityInput {
  readonly scope: MaterializationAttemptScope;
  readonly generationId: string;
  readonly provenanceTemplates: readonly PropertyProvenanceTemplate[];
}

export class MaterializationQualityService {
  readonly #repository: MaterializationQualityRepository;
  readonly #overlays: ZeroOverlayInventoryPort;
  readonly #artifacts: RejectedRowArtifactStore;
  readonly #crypto: MaterializationQualityCrypto;
  readonly #clock: MaterializationQualityClock;
  readonly #maximumRejectedArtifactBytes: number;

  constructor(options: MaterializationQualityServiceOptions) {
    this.#repository = options.repository;
    this.#overlays = options.overlays;
    this.#artifacts = options.artifacts;
    this.#crypto = options.crypto;
    this.#clock = options.clock;
    this.#maximumRejectedArtifactBytes =
      options.maximumRejectedArtifactBytes ?? REJECTED_ROW_ARTIFACT_MAXIMUM_BYTES;
  }

  async stageObservations(input: {
    readonly scope: MaterializationAttemptScope;
    readonly generationId: string;
    readonly observations: readonly MaterializationQualityObservation[];
  }): Promise<void> {
    const parsed = parseBuildIdentity(input.scope, input.generationId);
    const observations = parseObservations(input.observations);
    await mapQualityFailure(() =>
      this.#repository.stageQualityObservations({ ...parsed, observations }),
    );
  }

  async build(input: BuildGenerationQualityInput): Promise<FinalizedQualityResult> {
    const parsed = parseBuildIdentity(input.scope, input.generationId);
    const templates = parseProvenanceTemplates(input.provenanceTemplates);
    const qualityScope = await mapQualityFailure(() =>
      this.#repository.getGenerationQualityScope(parsed),
    );
    assertScopeMatches(parsed, qualityScope);
    const overlay = await mapQualityFailure(() =>
      this.#overlays.inspect({
        projectId: qualityScope.projectId,
        snapshotGroupId: qualityScope.snapshotGroupId,
        groupVersion: qualityScope.groupVersion,
      }),
    );
    if (overlay.state !== "known" || overlay.rowCount !== 0) {
      throw new MaterializationQualityError("ZERO_OVERLAY_REQUIRED");
    }

    const summary = parsePreparedSummary(
      await mapQualityFailure(() =>
        this.#repository.prepareStagingCurrent({ ...parsed, provenanceTemplates: templates }),
      ),
    );
    if (summary.totalRows !== qualityScope.sourceRowCount) {
      throw new MaterializationQualityError("STAGING_CURRENT_CONFLICT");
    }

    const decision = decideQuality(qualityScope, summary);
    const reportId = generatedId(this.#crypto.randomId());
    const createdAt = parseCanonicalInstant(this.#clock.now());
    const samples = await this.#collectSamples(qualityScope, summary.rejectedRows);
    const report = createReport(
      this.#crypto,
      qualityScope,
      summary,
      decision,
      reportId,
      createdAt,
      samples,
    );
    const rejectedArtifact =
      summary.rejectedRows === 0
        ? null
        : await this.#uploadRejectedArtifact(qualityScope, reportId, summary);
    const generationDigest = digestValue(this.#crypto, {
      schemaVersion: 1,
      contractVersion: "quality-generation-binding-v1",
      projectId: qualityScope.projectId,
      generationId: qualityScope.generationId,
      snapshotDigest: qualityScope.snapshotDigest,
      mappingRevisionDigest: qualityScope.mappingRevisionDigest,
      reportDigest: report.reportDigest,
      currentDigest: summary.currentDigest,
      provenanceDigest: summary.provenanceDigest,
      observationDigest: summary.observationDigest,
      rejectedArtifactDigest: rejectedArtifact?.contentDigest ?? null,
    });
    const qualityBindingDigest = digestValue(this.#crypto, {
      schemaVersion: 1,
      contractVersion: "materialization-quality-binding-v1",
      projectId: qualityScope.projectId,
      generationId: qualityScope.generationId,
      outcome: decision.outcome,
      reportDigest: report.reportDigest,
      snapshotDigest: qualityScope.snapshotDigest,
      mappingRevisionDigest: qualityScope.mappingRevisionDigest,
      currentDigest: summary.currentDigest,
      provenanceDigest: summary.provenanceDigest,
      zeroOverlayRowCount: 0,
    });
    return mapQualityFailure(() =>
      this.#repository.finalizeGenerationQuality({
        ...parsed,
        expectedObservationDigest: summary.observationDigest,
        expectedCurrentDigest: summary.currentDigest,
        expectedProvenanceDigest: summary.provenanceDigest,
        report,
        rejectedArtifact,
        generationDigest,
        qualityBindingDigest,
      }),
    );
  }

  async #collectSamples(
    scope: MaterializationQualityScopeRecord,
    rejectedRows: number,
  ): Promise<MaterializationQualityObservation[]> {
    if (rejectedRows === 0) return [];
    const page = await mapQualityFailure(() =>
      this.#repository.listRejectedObservations({
        projectId: scope.projectId,
        generationId: scope.generationId,
        after: null,
        limit: MATERIALIZATION_REPORT_SAMPLE_LIMIT,
      }),
    );
    return parseObservations(page.items).slice(0, MATERIALIZATION_REPORT_SAMPLE_LIMIT);
  }

  async #uploadRejectedArtifact(
    scope: MaterializationQualityScopeRecord,
    reportId: string,
    summary: PreparedQualitySummary,
  ): Promise<RejectedArtifactBinding> {
    const firstPass = await measureRejectedArtifact(
      this.#repository,
      this.#crypto,
      scope.projectId,
      scope.generationId,
      this.#maximumRejectedArtifactBytes,
    );
    if (
      firstPass.rowCount !== summary.rejectedRows ||
      firstPass.contentDigest !== summary.observationDigest
    ) {
      throw new MaterializationQualityError("STAGING_CURRENT_CONFLICT");
    }
    const rejectedRowSetId = generatedId(this.#crypto.randomId());
    const managedArtifactId = generatedId(this.#crypto.randomId());
    const objectKey = rejectedObjectKey(managedArtifactId);
    const uploaded = await mapQualityFailure(() =>
      this.#artifacts.putVersion({
        objectKey,
        body: rejectedArtifactBody(
          this.#repository,
          scope.projectId,
          scope.generationId,
          firstPass.byteCount,
        ),
        expectedByteCount: firstPass.byteCount,
        mediaType: REJECTED_ROW_MEDIA_TYPE,
      }),
    );
    if (
      uploaded.byteCount !== firstPass.byteCount ||
      uploaded.mediaType !== REJECTED_ROW_MEDIA_TYPE ||
      uploaded.versionId.length < 1 ||
      uploaded.versionId.length > 1_024
    ) {
      throw new MaterializationQualityError("DEPENDENCY_UNAVAILABLE");
    }
    return Object.freeze({
      rejectedRowSetId,
      managedArtifactId,
      objectKey,
      objectVersion: uploaded.versionId,
      byteCount: firstPass.byteCount,
      contentDigest: firstPass.contentDigest,
      rejectedRowCount: firstPass.rowCount,
      mediaType: REJECTED_ROW_MEDIA_TYPE,
    });
  }
}

export interface RowCountConfirmationScope {
  readonly projectId: string;
  readonly generationId: string;
  readonly snapshotDigest: ArtifactDigest;
  readonly reportId: string;
  readonly reportDigest: ArtifactDigest;
  readonly observedRows: number;
  readonly baselineRows: number;
  readonly thresholdBasisPoints: number;
  readonly publicationControlSequence: bigint;
  readonly state: "awaiting_confirmation";
}

export interface RowCountConfirmationRecord extends RowCountConfirmationScope {
  readonly confirmationId: string;
  readonly actorPrincipalId: string;
  readonly decision: "accepted" | "rejected";
  readonly expiresAt: CanonicalInstant;
  readonly confirmationDigest: ArtifactDigest;
}

export interface RowCountConfirmationServiceOptions {
  readonly principals: PrincipalDirectory;
  readonly authorizer: ManagementAuthorizer;
  readonly repository: MaterializationQualityRepository;
  readonly crypto: MaterializationQualityCrypto;
  readonly clock: MaterializationQualityClock;
  readonly confirmationLifetimeSeconds?: number;
}

export class RowCountConfirmationService {
  readonly #principals: PrincipalDirectory;
  readonly #authorizer: ManagementAuthorizer;
  readonly #repository: MaterializationQualityRepository;
  readonly #crypto: MaterializationQualityCrypto;
  readonly #clock: MaterializationQualityClock;
  readonly #confirmationLifetimeSeconds: number;

  constructor(options: RowCountConfirmationServiceOptions) {
    this.#principals = options.principals;
    this.#authorizer = options.authorizer;
    this.#repository = options.repository;
    this.#crypto = options.crypto;
    this.#clock = options.clock;
    this.#confirmationLifetimeSeconds = options.confirmationLifetimeSeconds ?? 900;
    if (
      !Number.isSafeInteger(this.#confirmationLifetimeSeconds) ||
      this.#confirmationLifetimeSeconds < 60 ||
      this.#confirmationLifetimeSeconds > 3_600
    ) {
      throw new MaterializationQualityError("QUALITY_REQUEST_INVALID");
    }
  }

  async confirm(
    identityInput: VerifiedFoundationIdentity,
    commandInput: {
      readonly projectId: string;
      readonly generationId: string;
      readonly expectedReportDigest: ArtifactDigest;
      readonly expectedPublicationControlSequence: bigint;
      readonly decision: "accepted" | "rejected";
    },
  ): Promise<FinalizedQualityResult> {
    const command = parseConfirmationCommand(commandInput);
    const identity = await this.#resolveOwner(identityInput, command.projectId);
    const current = await mapQualityFailure(() =>
      this.#repository.getConfirmationScope({
        projectId: command.projectId,
        generationId: command.generationId,
      }),
    );
    if (
      current.reportDigest !== command.expectedReportDigest ||
      current.publicationControlSequence !== command.expectedPublicationControlSequence
    ) {
      throw new MaterializationQualityError("QUALITY_CONFIRMATION_INVALID");
    }
    const confirmationId = generatedId(this.#crypto.randomId());
    const expiresAt = addSeconds(this.#clock.now(), this.#confirmationLifetimeSeconds);
    const confirmationPreimage = Object.freeze({
      schemaVersion: 1,
      contractVersion: "row-count-confirmation-v1",
      confirmationId,
      actorPrincipalId: identity.principalId,
      projectId: current.projectId,
      generationId: current.generationId,
      snapshotDigest: current.snapshotDigest,
      reportId: current.reportId,
      reportDigest: current.reportDigest,
      observedRows: current.observedRows,
      baselineRows: current.baselineRows,
      thresholdBasisPoints: current.thresholdBasisPoints,
      publicationControlSequence: current.publicationControlSequence.toString(),
      decision: command.decision,
      expiresAt,
    });
    const confirmationDigest = digestValue(this.#crypto, confirmationPreimage);
    return mapQualityFailure(() =>
      this.#repository.recordRowCountConfirmation({
        ...current,
        confirmationId,
        actorPrincipalId: identity.principalId,
        decision: command.decision,
        expiresAt,
        confirmationDigest,
      }),
    );
  }

  async #resolveOwner(
    identityInput: VerifiedFoundationIdentity,
    projectId: string,
  ): Promise<ResolvedFoundationIdentity> {
    try {
      const identity = parseVerifiedFoundationIdentity(identityInput);
      const principal = await this.#principals.resolveVerifiedIdentity(identity);
      if (
        principal.state !== "active" ||
        principal.issuer !== identity.issuer ||
        principal.subject !== identity.subject
      ) {
        throw new Error("identity mismatch");
      }
      const resolved = Object.freeze({
        principalId: parseOntosId(principal.principalId),
        claimsFingerprint: identity.claimsFingerprint,
        authenticatedAt: identity.authenticatedAt,
      });
      if (
        !(await this.#authorizer.authorize(resolved, {
          projectId,
          permission: "release.publish",
        }))
      ) {
        throw new Error("permission denied");
      }
      return resolved;
    } catch {
      throw new MaterializationQualityError("FORBIDDEN");
    }
  }
}

export function provenanceTemplatesFromPlan(
  plan: CompiledObjectMappingPlan,
  crypto: Pick<MaterializationQualityCrypto, "digestCanonicalText">,
): readonly PropertyProvenanceTemplate[] {
  const algorithmVersion = `${plan.compilerVersion}/${plan.mappingVersion}/${plan.valueCodecVersion}`;
  const templates: PropertyProvenanceTemplate[] = [];
  const appendExpression = (
    propertyApiName: string,
    sourceColumnOrdinals: readonly number[],
    expression: unknown,
  ): void => {
    const expressionDigest = digestValue(crypto, expression);
    if (sourceColumnOrdinals.length === 0) {
      templates.push(
        Object.freeze({
          propertyApiName,
          sourceIndex: 0,
          sourceKind: "constant" as const,
          inputColumnOrdinal: null,
          sourceExpressionDigest: expressionDigest,
          algorithmVersion,
        }),
      );
      return;
    }
    for (const [sourceIndex, ordinal] of [...sourceColumnOrdinals]
      .sort((left, right) => left - right)
      .entries()) {
      templates.push(
        Object.freeze({
          propertyApiName,
          sourceIndex,
          sourceKind: "column" as const,
          inputColumnOrdinal: ordinal,
          sourceExpressionDigest: expressionDigest,
          algorithmVersion,
        }),
      );
    }
  };
  appendExpression(
    plan.primaryKey.propertyApiName,
    plan.primaryKey.sourceColumnOrdinals,
    plan.primaryKey.expression,
  );
  for (const property of plan.propertyMappings) {
    appendExpression(property.propertyApiName, property.sourceColumnOrdinals, property.expression);
  }
  return parseProvenanceTemplates(templates);
}

export function observationsFromMappingRejections(
  input: {
    readonly fileId: string;
    readonly rejectedRows: readonly MappingRejectedRow[];
  },
  crypto: Pick<MaterializationQualityCrypto, "digestCanonicalText">,
): readonly MaterializationQualityObservation[] {
  const fileId = parseOntosId(input.fileId);
  return parseObservations(
    input.rejectedRows.map((row) => {
      const error = [...row.errors].sort(compareMappingError)[0];
      if (error === undefined) throw new MaterializationQualityError("QUALITY_REQUEST_INVALID");
      const reasonCode = error.reasonCode;
      if (reasonCode === "ROW_COUNT_CONFIRMATION_REQUIRED") {
        throw new MaterializationQualityError("QUALITY_REQUEST_INVALID");
      }
      return Object.freeze({
        fileId,
        rowNumber: row.rowNumber,
        reasonCode,
        fingerprint: digestValue(crypto, {
          schemaVersion: 1,
          contractVersion: "quality-observation-fingerprint-v1",
          fileId,
          rowNumber: row.rowNumber,
          reasonCode,
          mappingCode: error.mappingCode,
          codecCode: error.codecCode ?? null,
        }),
        columnClassification: "redacted" as const,
        phase: "mapping" as const,
      });
    }),
  );
}

interface QualityDecision {
  readonly outcome: "passed" | "awaiting_confirmation" | "failed";
  readonly rowCountConfirmationRequired: boolean;
}

function decideQuality(
  scope: MaterializationQualityScopeRecord,
  summary: PreparedQualitySummary,
): QualityDecision {
  const counts = new Map(summary.reasonCounts.map((entry) => [entry.code, entry.count]));
  const rules = scope.qualityRules;
  const failed =
    count(counts, "PRIMARY_KEY_NULL") > rules.primaryKeyNullMaximumCount ||
    count(counts, "PRIMARY_KEY_DUPLICATE") > rules.primaryKeyDuplicateMaximumCount ||
    count(counts, "REQUIRED_PROPERTY_INVALID") > rules.requiredPropertyFailureMaximumCount ||
    count(counts, "REQUIRED_LINK_DANGLING") > rules.requiredLinkDanglingMaximumCount ||
    exceedsBasisPoints(
      count(counts, "OPTIONAL_PROPERTY_INVALID"),
      summary.totalRows,
      rules.optionalPropertyFailureMaximumBasisPoints,
    ) ||
    exceedsBasisPoints(
      count(counts, "OPTIONAL_LINK_DANGLING"),
      summary.totalRows,
      rules.optionalLinkDanglingMaximumBasisPoints,
    );
  if (failed) return Object.freeze({ outcome: "failed", rowCountConfirmationRequired: false });
  const confirmation = rowCountChangeExceeds(
    summary.acceptedRows,
    scope.previousAcceptedRows,
    rules.rowCountChangeConfirmationBasisPoints,
  );
  return Object.freeze({
    outcome: confirmation ? "awaiting_confirmation" : "passed",
    rowCountConfirmationRequired: confirmation,
  });
}

function createReport(
  crypto: Pick<MaterializationQualityCrypto, "digestCanonicalText">,
  scope: MaterializationQualityScopeRecord,
  summary: PreparedQualitySummary,
  decision: QualityDecision,
  reportId: string,
  createdAt: CanonicalInstant,
  samples: readonly MaterializationQualityObservation[],
): MaterializationReportContract {
  const reasonCounts = [
    ...summary.reasonCounts,
    ...(decision.rowCountConfirmationRequired
      ? ([{ code: "ROW_COUNT_CONFIRMATION_REQUIRED" as const, count: 1 }] as const)
      : []),
  ].sort((left, right) => compareText(left.code, right.code));
  const withoutDigest = {
    schemaVersion: 1,
    contractVersion: "materialization-report-v1",
    reportId,
    projectId: scope.projectId,
    snapshotGroupId: scope.snapshotGroupId,
    jobId: scope.jobId,
    outcome: decision.outcome,
    totalRows: summary.totalRows,
    acceptedRows: summary.acceptedRows,
    rejectedRows: summary.rejectedRows,
    reasonCounts,
    errorSamples: samples.map((sample) => ({
      code: sample.reasonCode,
      fileId: sample.fileId,
      rowNumber: sample.rowNumber,
      fingerprint: sample.fingerprint,
    })),
    validatorVersion: MATERIALIZATION_QUALITY_VALIDATOR_VERSION,
    reportDigest: zeroDigest(),
    createdAt,
  } as const;
  const reportDigest = crypto.digestCanonicalText(
    canonicalizeMaterializationContractForDigest("MaterializationReport", withoutDigest),
  );
  return parseMaterializationReport({ ...withoutDigest, reportDigest });
}

async function measureRejectedArtifact(
  repository: MaterializationQualityRepository,
  crypto: MaterializationQualityCrypto,
  projectId: string,
  generationId: string,
  maximumBytes: number,
): Promise<{
  readonly byteCount: number;
  readonly rowCount: number;
  readonly contentDigest: ArtifactDigest;
}> {
  let byteCount = 0;
  let rowCount = 0;
  const digest = crypto.createStreamingDigest();
  for await (const chunk of rejectedArtifactChunks(repository, projectId, generationId)) {
    byteCount += chunk.byteLength;
    rowCount += 1;
    if (byteCount > maximumBytes) {
      throw new MaterializationQualityError("REJECTED_ARTIFACT_TOO_LARGE");
    }
    digest.update(chunk);
  }
  return Object.freeze({ byteCount, rowCount, contentDigest: digest.finish() });
}

async function* rejectedArtifactBody(
  repository: MaterializationQualityRepository,
  projectId: string,
  generationId: string,
  expectedByteCount: number,
): AsyncIterable<Uint8Array> {
  let byteCount = 0;
  for await (const chunk of rejectedArtifactChunks(repository, projectId, generationId)) {
    byteCount += chunk.byteLength;
    if (byteCount > expectedByteCount) {
      throw new MaterializationQualityError("STAGING_CURRENT_CONFLICT");
    }
    yield chunk;
  }
  if (byteCount !== expectedByteCount) {
    throw new MaterializationQualityError("STAGING_CURRENT_CONFLICT");
  }
}

async function* rejectedArtifactChunks(
  repository: MaterializationQualityRepository,
  projectId: string,
  generationId: string,
): AsyncIterable<Uint8Array> {
  let cursor: QualityObservationCursor | null = null;
  do {
    const page = await mapQualityFailure(() =>
      repository.listRejectedObservations({
        projectId,
        generationId,
        after: cursor,
        limit: MATERIALIZATION_QUALITY_PAGE_SIZE,
      }),
    );
    const items = parseObservations(page.items);
    if (items.length > MATERIALIZATION_QUALITY_PAGE_SIZE) {
      throw new MaterializationQualityError("DEPENDENCY_UNAVAILABLE");
    }
    for (const item of items) yield rejectedArtifactLine(item);
    const nextCursor = page.nextCursor === null ? null : parseObservationCursor(page.nextCursor);
    if (nextCursor !== null && items.length === 0) {
      throw new MaterializationQualityError("DEPENDENCY_UNAVAILABLE");
    }
    cursor = nextCursor;
  } while (cursor !== null);
}

function rejectedArtifactLine(observation: MaterializationQualityObservation): Uint8Array {
  const canonical = canonicalizeContractForDigest({
    schemaVersion: 1,
    fileId: observation.fileId,
    rowNumber: observation.rowNumber,
    reasonCode: observation.reasonCode,
    fingerprint: observation.fingerprint,
    columnClassification: observation.columnClassification,
  });
  const chunk = new TextEncoder().encode(`${canonical}\n`);
  if (chunk.byteLength > 768) {
    throw new MaterializationQualityError("DEPENDENCY_UNAVAILABLE");
  }
  return chunk;
}

function parseBuildIdentity(
  scopeInput: MaterializationAttemptScope,
  generationIdInput: string,
): { readonly scope: MaterializationAttemptScope; readonly generationId: string } {
  try {
    const fencingToken = BigInt(scopeInput.fencingToken);
    if (fencingToken < 1n) throw new Error("invalid fencing token");
    return Object.freeze({
      scope: Object.freeze({
        projectId: parseOntosId(scopeInput.projectId),
        jobId: parseOntosId(scopeInput.jobId),
        attemptId: parseOntosId(scopeInput.attemptId),
        fencingToken,
      }),
      generationId: parseOntosId(generationIdInput),
    });
  } catch {
    throw new MaterializationQualityError("QUALITY_REQUEST_INVALID");
  }
}

function assertScopeMatches(
  input: { readonly scope: MaterializationAttemptScope; readonly generationId: string },
  record: MaterializationQualityScopeRecord,
): void {
  try {
    if (
      parseOntosId(record.projectId) !== input.scope.projectId ||
      parseOntosId(record.jobId) !== input.scope.jobId ||
      parseOntosId(record.generationId) !== input.generationId ||
      !Number.isSafeInteger(record.groupVersion) ||
      record.groupVersion < 1 ||
      !Number.isSafeInteger(record.sourceRowCount) ||
      record.sourceRowCount < 0 ||
      (record.previousAcceptedRows !== null &&
        (!Number.isSafeInteger(record.previousAcceptedRows) || record.previousAcceptedRows < 0)) ||
      (record.memberKind !== "object" && record.memberKind !== "link") ||
      (record.linkDanglingDisposition !== "required" &&
        record.linkDanglingDisposition !== "optional") ||
      record.publicationControlSequence < 0n
    ) {
      throw new Error("scope mismatch");
    }
    parseOntosId(record.targetResourceId);
    parseOntosId(record.targetRevisionId);
    parseOntosId(record.snapshotId);
    parseOntosId(record.snapshotGroupId);
    parseOntosId(record.mappingRevisionId);
    parseArtifactDigest(record.snapshotDigest);
    parseArtifactDigest(record.mappingRevisionDigest);
    parseQualityRules(record.qualityRules);
  } catch {
    throw new MaterializationQualityError("DEPENDENCY_UNAVAILABLE");
  }
}

function parsePreparedSummary(value: PreparedQualitySummary): PreparedQualitySummary {
  try {
    if (
      !Number.isSafeInteger(value.totalRows) ||
      !Number.isSafeInteger(value.acceptedRows) ||
      !Number.isSafeInteger(value.rejectedRows) ||
      value.totalRows < 0 ||
      value.acceptedRows < 0 ||
      value.rejectedRows < 0 ||
      value.acceptedRows + value.rejectedRows !== value.totalRows
    ) {
      throw new Error("invalid totals");
    }
    const reasonCounts = [...value.reasonCounts]
      .map((entry) => {
        if (
          !qualityRowReasons.has(entry.code) ||
          !Number.isSafeInteger(entry.count) ||
          entry.count < 1
        ) {
          throw new Error("invalid reason");
        }
        return Object.freeze({ code: entry.code, count: entry.count });
      })
      .sort((left, right) => compareText(left.code, right.code));
    if (
      new Set(reasonCounts.map((entry) => entry.code)).size !== reasonCounts.length ||
      reasonCounts.reduce((sum, entry) => sum + entry.count, 0) !== value.rejectedRows
    ) {
      throw new Error("invalid reason totals");
    }
    return Object.freeze({
      totalRows: value.totalRows,
      acceptedRows: value.acceptedRows,
      rejectedRows: value.rejectedRows,
      reasonCounts: Object.freeze(reasonCounts),
      observationDigest: parseArtifactDigest(value.observationDigest),
      currentDigest: parseArtifactDigest(value.currentDigest),
      provenanceDigest: parseArtifactDigest(value.provenanceDigest),
    });
  } catch {
    throw new MaterializationQualityError("DEPENDENCY_UNAVAILABLE");
  }
}

function parseObservations(
  values: readonly MaterializationQualityObservation[],
): readonly MaterializationQualityObservation[] {
  if (values.length > MATERIALIZATION_QUALITY_PAGE_SIZE) {
    throw new MaterializationQualityError("QUALITY_REQUEST_INVALID");
  }
  const candidates: readonly MaterializationQualityObservation[] = values;
  const parsed = candidates.map((value) => {
    try {
      if (
        !Number.isSafeInteger(value.rowNumber) ||
        value.rowNumber < 1 ||
        !qualityRowReasons.has(value.reasonCode) ||
        !qualityColumnClassifications.has(value.columnClassification) ||
        !qualityObservationPhases.has(value.phase)
      ) {
        throw new Error("invalid observation");
      }
      return Object.freeze({
        fileId: parseOntosId(value.fileId),
        rowNumber: value.rowNumber,
        reasonCode: value.reasonCode,
        fingerprint: parseArtifactDigest(value.fingerprint),
        columnClassification: value.columnClassification,
        phase: value.phase,
      });
    } catch {
      throw new MaterializationQualityError("QUALITY_REQUEST_INVALID");
    }
  });
  return Object.freeze(parsed);
}

function parseObservationCursor(value: QualityObservationCursor): QualityObservationCursor {
  const [parsed] = parseObservations([
    {
      ...value,
      columnClassification: "redacted",
      phase: "mapping",
    },
  ]);
  if (parsed === undefined) throw new MaterializationQualityError("DEPENDENCY_UNAVAILABLE");
  return Object.freeze({
    fileId: parsed.fileId,
    rowNumber: parsed.rowNumber,
    reasonCode: parsed.reasonCode,
    fingerprint: parsed.fingerprint,
  });
}

function parseProvenanceTemplates(
  values: readonly PropertyProvenanceTemplate[],
): readonly PropertyProvenanceTemplate[] {
  if (values.length > 4_096) {
    throw new MaterializationQualityError("QUALITY_REQUEST_INVALID");
  }
  const candidates: readonly PropertyProvenanceTemplate[] = values;
  const parsed = candidates.map((value) => {
    if (
      !propertyNamePattern.test(value.propertyApiName) ||
      !Number.isSafeInteger(value.sourceIndex) ||
      value.sourceIndex < 0 ||
      value.sourceIndex > 4_095 ||
      !algorithmVersionPattern.test(value.algorithmVersion) ||
      (value.sourceKind !== "column" && value.sourceKind !== "constant") ||
      (value.sourceKind === "column" &&
        (!Number.isSafeInteger(value.inputColumnOrdinal) ||
          (value.inputColumnOrdinal as number) < 0 ||
          (value.inputColumnOrdinal as number) > 4_095)) ||
      (value.sourceKind === "constant" && value.inputColumnOrdinal !== null)
    ) {
      throw new MaterializationQualityError("QUALITY_REQUEST_INVALID");
    }
    return Object.freeze({
      propertyApiName: value.propertyApiName,
      sourceIndex: value.sourceIndex,
      sourceKind: value.sourceKind,
      inputColumnOrdinal: value.inputColumnOrdinal,
      sourceExpressionDigest: parseArtifactDigest(value.sourceExpressionDigest),
      algorithmVersion: value.algorithmVersion,
    });
  });
  parsed.sort(
    (left, right) =>
      compareText(left.propertyApiName, right.propertyApiName) ||
      left.sourceIndex - right.sourceIndex,
  );
  const keys = parsed.map((value) => `${value.propertyApiName}\u0000${String(value.sourceIndex)}`);
  if (new Set(keys).size !== keys.length) {
    throw new MaterializationQualityError("QUALITY_REQUEST_INVALID");
  }
  return Object.freeze(parsed);
}

function parseConfirmationCommand(value: {
  readonly projectId: string;
  readonly generationId: string;
  readonly expectedReportDigest: ArtifactDigest;
  readonly expectedPublicationControlSequence: bigint;
  readonly decision: "accepted" | "rejected";
}): typeof value {
  try {
    if (
      (value.decision !== "accepted" && value.decision !== "rejected") ||
      typeof value.expectedPublicationControlSequence !== "bigint" ||
      value.expectedPublicationControlSequence < 0n
    ) {
      throw new Error("invalid command");
    }
    return Object.freeze({
      projectId: parseOntosId(value.projectId),
      generationId: parseOntosId(value.generationId),
      expectedReportDigest: parseArtifactDigest(value.expectedReportDigest),
      expectedPublicationControlSequence: value.expectedPublicationControlSequence,
      decision: value.decision,
    });
  } catch {
    throw new MaterializationQualityError("QUALITY_REQUEST_INVALID");
  }
}

function parseQualityRules(value: MappingQualityRules): MappingQualityRules {
  const basisPoints = [
    value.optionalPropertyFailureMaximumBasisPoints,
    value.optionalLinkDanglingMaximumBasisPoints,
    value.rowCountChangeConfirmationBasisPoints,
  ];
  if (
    value.primaryKeyNullMaximumCount !== 0 ||
    value.primaryKeyDuplicateMaximumCount !== 0 ||
    value.requiredPropertyFailureMaximumCount !== 0 ||
    value.requiredLinkDanglingMaximumCount !== 0 ||
    value.optionalFailureDisposition !== "reject_row" ||
    basisPoints.some(
      (candidate) => !Number.isSafeInteger(candidate) || candidate < 0 || candidate > 10_000,
    )
  ) {
    throw new MaterializationQualityError("DEPENDENCY_UNAVAILABLE");
  }
  return value;
}

function compareMappingError(
  left: MappingRejectedRow["errors"][number],
  right: MappingRejectedRow["errors"][number],
): number {
  return (
    reasonPriority(left.reasonCode) - reasonPriority(right.reasonCode) ||
    compareText(left.mappingCode, right.mappingCode) ||
    compareText(left.codecCode ?? "", right.codecCode ?? "")
  );
}

function reasonPriority(code: MaterializationReasonCode): number {
  return reasonOrder.indexOf(code);
}

function count(
  counts: ReadonlyMap<MaterializationReasonCode, number>,
  code: MaterializationReasonCode,
): number {
  return counts.get(code) ?? 0;
}

function exceedsBasisPoints(countValue: number, total: number, basisPoints: number): boolean {
  if (total === 0) return countValue > 0;
  return BigInt(countValue) * 10_000n > BigInt(total) * BigInt(basisPoints);
}

function rowCountChangeExceeds(
  observed: number,
  baseline: number | null,
  basisPoints: number,
): boolean {
  if (baseline === null) return false;
  if (baseline === 0) return observed !== 0;
  return BigInt(Math.abs(observed - baseline)) * 10_000n > BigInt(baseline) * BigInt(basisPoints);
}

function rejectedObjectKey(managedArtifactId: string): string {
  return `rejected/${managedArtifactId.slice(0, 2)}/${managedArtifactId}.jsonl`;
}

function generatedId(value: string): string {
  try {
    return parseOntosId(value);
  } catch {
    throw new MaterializationQualityError("DEPENDENCY_UNAVAILABLE");
  }
}

function digestValue(
  crypto: Pick<MaterializationQualityCrypto, "digestCanonicalText">,
  value: unknown,
): ArtifactDigest {
  return parseArtifactDigest(crypto.digestCanonicalText(canonicalizeContractForDigest(value)));
}

function zeroDigest(): ArtifactDigest {
  return parseArtifactDigest(`sha256:${"0".repeat(64)}`);
}

function addSeconds(value: CanonicalInstant, seconds: number): CanonicalInstant {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new MaterializationQualityError("DEPENDENCY_UNAVAILABLE");
  }
  const iso = new Date(milliseconds + seconds * 1_000).toISOString();
  return parseCanonicalInstant(iso.replace(/Z$/u, "000Z"));
}

async function mapQualityFailure<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MaterializationQualityError) throw error;
    throw new MaterializationQualityError("DEPENDENCY_UNAVAILABLE");
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const propertyNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,62}$/u;
const algorithmVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$/u;
const reasonOrder: readonly MaterializationReasonCode[] = Object.freeze([
  "PRIMARY_KEY_NULL",
  "PRIMARY_KEY_DUPLICATE",
  "REQUIRED_PROPERTY_INVALID",
  "REQUIRED_LINK_DANGLING",
  "OPTIONAL_PROPERTY_INVALID",
  "OPTIONAL_LINK_DANGLING",
  "ROW_COUNT_CONFIRMATION_REQUIRED",
]);
const qualityRowReasons = new Set<MaterializationReasonCode>(reasonOrder.slice(0, -1));
const qualityColumnClassifications = new Set<QualityColumnClassification>([
  "identifier",
  "internal",
  "confidential",
  "restricted",
  "redacted",
]);
const qualityObservationPhases = new Set<MaterializationQualityObservation["phase"]>([
  "mapping",
  "identity_lookup",
  "primary_key_collision",
  "current_resolution",
]);
