import {
  MaterializationQualityError,
  type FinalizedQualityResult,
  type MaterializationQualityObservation,
  type MaterializationQualityRepository,
  type MaterializationQualityScopeRecord,
  type PreparedQualitySummary,
  type QualityObservationCursor,
  type QualityObservationPage,
  type RowCountConfirmationRecord,
  type RowCountConfirmationScope,
} from "@ontos/materialization-application";
import {
  parseArtifactDigest,
  type MappingQualityRules,
  type MaterializationReasonCode,
} from "@ontos/contracts";
import type pg from "pg";

interface QualityScopeRow extends pg.QueryResultRow {
  readonly projectId: string;
  readonly jobId: string;
  readonly generationId: string;
  readonly memberKind: "object" | "link";
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: string;
  readonly mappingRevisionId: string;
  readonly mappingRevisionDigest: string;
  readonly sourceRowCount: string;
  readonly previousAcceptedRows: string | null;
  readonly qualityRules: unknown;
  readonly linkDanglingDisposition: "required" | "optional";
  readonly publicationControlSequence: string;
}

interface PreparedQualityRow extends pg.QueryResultRow {
  readonly totalRows: string;
  readonly acceptedRows: string;
  readonly rejectedRows: string;
  readonly reasonCounts: unknown;
  readonly observationDigest: string;
  readonly currentDigest: string;
  readonly provenanceDigest: string;
}

interface ObservationRow extends pg.QueryResultRow {
  readonly fileId: string;
  readonly rowNumber: string;
  readonly reasonCode: MaterializationQualityObservation["reasonCode"];
  readonly fingerprint: string;
  readonly columnClassification: MaterializationQualityObservation["columnClassification"];
  readonly phase: MaterializationQualityObservation["phase"];
}

interface FinalizedQualityRow extends pg.QueryResultRow {
  readonly projectId: string;
  readonly generationId: string;
  readonly outcome: "passed" | "awaiting_confirmation" | "failed";
  readonly reportId: string;
  readonly reportDigest: string;
  readonly generationDigest: string;
  readonly qualityBindingDigest: string;
}

interface ConfirmationScopeRow extends pg.QueryResultRow {
  readonly projectId: string;
  readonly generationId: string;
  readonly snapshotDigest: string;
  readonly reportId: string;
  readonly reportDigest: string;
  readonly observedRows: string;
  readonly baselineRows: string;
  readonly thresholdBasisPoints: number;
  readonly publicationControlSequence: string;
  readonly state: "awaiting_confirmation";
}

export class PostgresMaterializationQualityRepository implements MaterializationQualityRepository {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async getGenerationQualityScope(
    input: Parameters<MaterializationQualityRepository["getGenerationQualityScope"]>[0],
  ): Promise<MaterializationQualityScopeRecord> {
    try {
      const result = await this.#pool.query<QualityScopeRow>(
        `SELECT project_id AS "projectId", job_id AS "jobId",
                generation_id AS "generationId", member_kind AS "memberKind",
                target_resource_id AS "targetResourceId",
                target_revision_id AS "targetRevisionId",
                snapshot_id AS "snapshotId", snapshot_digest AS "snapshotDigest",
                snapshot_group_id AS "snapshotGroupId",
                group_version::text AS "groupVersion",
                mapping_revision_id AS "mappingRevisionId",
                mapping_revision_digest AS "mappingRevisionDigest",
                source_row_count::text AS "sourceRowCount",
                previous_accepted_rows::text AS "previousAcceptedRows",
                quality_rules AS "qualityRules",
                link_dangling_disposition AS "linkDanglingDisposition",
                publication_control_sequence::text AS "publicationControlSequence"
           FROM ops.get_materialization_quality_scope($1, $2, $3, $4, $5)`,
        scopeParameters(input.scope, input.generationId),
      );
      return parseQualityScope(singleRow(result.rows));
    } catch (error) {
      throw mapPostgresQualityError(error);
    }
  }

  async stageQualityObservations(
    input: Parameters<MaterializationQualityRepository["stageQualityObservations"]>[0],
  ): Promise<void> {
    try {
      await this.#pool.query(
        `SELECT ops.stage_materialization_quality_observations(
           $1, $2, $3, $4, $5, $6::jsonb
         )`,
        [...scopeParameters(input.scope, input.generationId), JSON.stringify(input.observations)],
      );
    } catch (error) {
      throw mapPostgresQualityError(error);
    }
  }

  async prepareStagingCurrent(
    input: Parameters<MaterializationQualityRepository["prepareStagingCurrent"]>[0],
  ): Promise<PreparedQualitySummary> {
    try {
      const result = await this.#pool.query<PreparedQualityRow>(
        `SELECT total_rows::text AS "totalRows",
                accepted_rows::text AS "acceptedRows",
                rejected_rows::text AS "rejectedRows",
                reason_counts AS "reasonCounts",
                observation_digest AS "observationDigest",
                current_digest AS "currentDigest",
                provenance_digest AS "provenanceDigest"
           FROM ops.prepare_materialization_staging_current(
             $1, $2, $3, $4, $5, $6::jsonb
           )`,
        [
          ...scopeParameters(input.scope, input.generationId),
          JSON.stringify(input.provenanceTemplates),
        ],
      );
      return parsePreparedQuality(singleRow(result.rows));
    } catch (error) {
      throw mapPostgresQualityError(error);
    }
  }

  async listRejectedObservations(
    input: Parameters<MaterializationQualityRepository["listRejectedObservations"]>[0],
  ): Promise<QualityObservationPage> {
    try {
      const after = input.after;
      const result = await this.#pool.query<ObservationRow>(
        `SELECT file_id AS "fileId", row_number::text AS "rowNumber",
                reason_code AS "reasonCode", fingerprint,
                column_classification AS "columnClassification", phase
           FROM ops.list_materialization_quality_observations(
             $1, $2, $3, $4, $5, $6, $7
           )`,
        [
          input.projectId,
          input.generationId,
          after?.fileId ?? null,
          after?.rowNumber ?? null,
          after?.reasonCode ?? null,
          after?.fingerprint ?? null,
          input.limit + 1,
        ],
      );
      const hasMore = result.rows.length > input.limit;
      const rows = result.rows.slice(0, input.limit).map(parseObservation);
      const last = rows.at(-1);
      return Object.freeze({
        items: Object.freeze(rows),
        nextCursor: hasMore && last !== undefined ? observationCursor(last) : null,
      });
    } catch (error) {
      throw mapPostgresQualityError(error);
    }
  }

  async finalizeGenerationQuality(
    input: Parameters<MaterializationQualityRepository["finalizeGenerationQuality"]>[0],
  ): Promise<FinalizedQualityResult> {
    try {
      const result = await this.#pool.query<FinalizedQualityRow>(
        `SELECT project_id AS "projectId", generation_id AS "generationId", outcome,
                report_id AS "reportId", report_digest AS "reportDigest",
                generation_digest AS "generationDigest",
                quality_binding_digest AS "qualityBindingDigest"
           FROM ops.finalize_materialization_quality(
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9::jsonb, $10::jsonb, $11, $12
           )`,
        [
          ...scopeParameters(input.scope, input.generationId),
          input.expectedObservationDigest,
          input.expectedCurrentDigest,
          input.expectedProvenanceDigest,
          JSON.stringify(input.report),
          input.rejectedArtifact === null ? null : JSON.stringify(input.rejectedArtifact),
          input.generationDigest,
          input.qualityBindingDigest,
        ],
      );
      return parseFinalizedQuality(singleRow(result.rows));
    } catch (error) {
      throw mapPostgresQualityError(error);
    }
  }

  async getConfirmationScope(
    input: Parameters<MaterializationQualityRepository["getConfirmationScope"]>[0],
  ): Promise<RowCountConfirmationScope> {
    try {
      const result = await this.#pool.query<ConfirmationScopeRow>(
        `SELECT project_id AS "projectId", generation_id AS "generationId",
                snapshot_digest AS "snapshotDigest", report_id AS "reportId",
                report_digest AS "reportDigest", observed_rows::text AS "observedRows",
                baseline_rows::text AS "baselineRows",
                threshold_basis_points AS "thresholdBasisPoints",
                publication_control_sequence::text AS "publicationControlSequence", state
           FROM runtime.get_row_count_confirmation_scope($1, $2)`,
        [input.projectId, input.generationId],
      );
      return parseConfirmationScope(singleRow(result.rows));
    } catch (error) {
      throw mapPostgresQualityError(error);
    }
  }

  async recordRowCountConfirmation(
    input: RowCountConfirmationRecord,
  ): Promise<FinalizedQualityResult> {
    try {
      const result = await this.#pool.query<FinalizedQualityRow>(
        `SELECT project_id AS "projectId", generation_id AS "generationId", outcome,
                report_id AS "reportId", report_digest AS "reportDigest",
                generation_digest AS "generationDigest",
                quality_binding_digest AS "qualityBindingDigest"
           FROM runtime.confirm_materialization_row_count(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
           )`,
        [
          input.projectId,
          input.generationId,
          input.confirmationId,
          input.actorPrincipalId,
          input.snapshotDigest,
          input.reportId,
          input.reportDigest,
          input.observedRows,
          input.baselineRows,
          input.thresholdBasisPoints,
          input.publicationControlSequence.toString(),
          input.decision,
          input.expiresAt,
          input.confirmationDigest,
        ],
      );
      return parseFinalizedQuality(singleRow(result.rows));
    } catch (error) {
      throw mapPostgresQualityError(error);
    }
  }
}

function scopeParameters(
  scope: {
    readonly projectId: string;
    readonly jobId: string;
    readonly attemptId: string;
    readonly fencingToken: bigint;
  },
  generationId: string,
): unknown[] {
  return [
    scope.projectId,
    scope.jobId,
    scope.attemptId,
    scope.fencingToken.toString(),
    generationId,
  ];
}

function parseQualityScope(row: QualityScopeRow): MaterializationQualityScopeRecord {
  return Object.freeze({
    projectId: row.projectId,
    jobId: row.jobId,
    generationId: row.generationId,
    memberKind: row.memberKind,
    targetResourceId: row.targetResourceId,
    targetRevisionId: row.targetRevisionId,
    snapshotId: row.snapshotId,
    snapshotDigest: parseArtifactDigest(row.snapshotDigest),
    snapshotGroupId: row.snapshotGroupId,
    groupVersion: safeCount(row.groupVersion),
    mappingRevisionId: row.mappingRevisionId,
    mappingRevisionDigest: parseArtifactDigest(row.mappingRevisionDigest),
    sourceRowCount: safeCount(row.sourceRowCount),
    previousAcceptedRows:
      row.previousAcceptedRows === null ? null : safeCount(row.previousAcceptedRows),
    qualityRules: parseQualityRules(row.qualityRules),
    linkDanglingDisposition: row.linkDanglingDisposition,
    publicationControlSequence: BigInt(row.publicationControlSequence),
  });
}

function parsePreparedQuality(row: PreparedQualityRow): PreparedQualitySummary {
  if (!Array.isArray(row.reasonCounts)) throw dependencyFailure();
  const reasonCounts = row.reasonCounts.map((value) => {
    const record = objectRecord(value);
    const code = record["code"];
    const count = record["count"];
    if (typeof code !== "string" || !rowReasonCodes.has(code) || typeof count !== "number") {
      throw dependencyFailure();
    }
    return Object.freeze({
      code: code as Exclude<MaterializationReasonCode, "ROW_COUNT_CONFIRMATION_REQUIRED">,
      count: safeCount(String(count)),
    });
  });
  return Object.freeze({
    totalRows: safeCount(row.totalRows),
    acceptedRows: safeCount(row.acceptedRows),
    rejectedRows: safeCount(row.rejectedRows),
    reasonCounts: Object.freeze(reasonCounts),
    observationDigest: parseArtifactDigest(row.observationDigest),
    currentDigest: parseArtifactDigest(row.currentDigest),
    provenanceDigest: parseArtifactDigest(row.provenanceDigest),
  });
}

function parseObservation(row: ObservationRow): MaterializationQualityObservation {
  return Object.freeze({
    fileId: row.fileId,
    rowNumber: safeCount(row.rowNumber),
    reasonCode: row.reasonCode,
    fingerprint: parseArtifactDigest(row.fingerprint),
    columnClassification: row.columnClassification,
    phase: row.phase,
  });
}

function observationCursor(value: MaterializationQualityObservation): QualityObservationCursor {
  return Object.freeze({
    fileId: value.fileId,
    rowNumber: value.rowNumber,
    reasonCode: value.reasonCode,
    fingerprint: value.fingerprint,
  });
}

function parseFinalizedQuality(row: FinalizedQualityRow): FinalizedQualityResult {
  return Object.freeze({
    projectId: row.projectId,
    generationId: row.generationId,
    outcome: row.outcome,
    reportId: row.reportId,
    reportDigest: parseArtifactDigest(row.reportDigest),
    generationDigest: parseArtifactDigest(row.generationDigest),
    qualityBindingDigest: parseArtifactDigest(row.qualityBindingDigest),
  });
}

function parseConfirmationScope(row: ConfirmationScopeRow): RowCountConfirmationScope {
  return Object.freeze({
    projectId: row.projectId,
    generationId: row.generationId,
    snapshotDigest: parseArtifactDigest(row.snapshotDigest),
    reportId: row.reportId,
    reportDigest: parseArtifactDigest(row.reportDigest),
    observedRows: safeCount(row.observedRows),
    baselineRows: safeCount(row.baselineRows),
    thresholdBasisPoints: safeCount(String(row.thresholdBasisPoints)),
    publicationControlSequence: BigInt(row.publicationControlSequence),
    state: row.state,
  });
}

function parseQualityRules(value: unknown): MappingQualityRules {
  const record = objectRecord(value);
  const zeroFields = [
    "primaryKeyNullMaximumCount",
    "primaryKeyDuplicateMaximumCount",
    "requiredPropertyFailureMaximumCount",
    "requiredLinkDanglingMaximumCount",
  ] as const;
  const basisFields = [
    "optionalPropertyFailureMaximumBasisPoints",
    "optionalLinkDanglingMaximumBasisPoints",
    "rowCountChangeConfirmationBasisPoints",
  ] as const;
  if (
    zeroFields.some((field) => record[field] !== 0) ||
    record["optionalFailureDisposition"] !== "reject_row"
  ) {
    throw dependencyFailure();
  }
  for (const field of basisFields) {
    const candidate = record[field];
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < 0 ||
      (candidate as number) > 10_000
    ) {
      throw dependencyFailure();
    }
  }
  return Object.freeze({
    primaryKeyNullMaximumCount: 0,
    primaryKeyDuplicateMaximumCount: 0,
    requiredPropertyFailureMaximumCount: 0,
    requiredLinkDanglingMaximumCount: 0,
    optionalPropertyFailureMaximumBasisPoints: record[
      "optionalPropertyFailureMaximumBasisPoints"
    ] as number,
    optionalLinkDanglingMaximumBasisPoints: record[
      "optionalLinkDanglingMaximumBasisPoints"
    ] as number,
    rowCountChangeConfirmationBasisPoints: record[
      "rowCountChangeConfirmationBasisPoints"
    ] as number,
    optionalFailureDisposition: "reject_row",
  });
}

function safeCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw dependencyFailure();
  return parsed;
}

function singleRow<Row>(rows: readonly Row[]): Row {
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) throw dependencyFailure();
  return row;
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw dependencyFailure();
  return value as Readonly<Record<string, unknown>>;
}

function mapPostgresQualityError(error: unknown): MaterializationQualityError {
  if (error instanceof MaterializationQualityError) return error;
  const code = postgresField(error, "code");
  const message = postgresField(error, "message");
  if (message.includes("MATERIALIZATION_JOB_FENCED")) {
    return new MaterializationQualityError("MATERIALIZATION_ATTEMPT_FENCED");
  }
  if (message.includes("G20207_PROVENANCE_INCOMPLETE")) {
    return new MaterializationQualityError("PROVENANCE_INCOMPLETE");
  }
  if (message.includes("G20207_CONFIRMATION_FORBIDDEN") || code === "42501") {
    return new MaterializationQualityError("FORBIDDEN");
  }
  if (message.includes("G20207_CONFIRMATION_INVALID")) {
    return new MaterializationQualityError("QUALITY_CONFIRMATION_INVALID");
  }
  if (
    message.includes("G20207_STAGING_CURRENT") ||
    message.includes("G20207_QUALITY_OBSERVATION_CONFLICT") ||
    code === "23505"
  ) {
    return new MaterializationQualityError("STAGING_CURRENT_CONFLICT");
  }
  if (message.includes("G20207_QUALITY_REQUEST_INVALID") || code === "22023") {
    return new MaterializationQualityError("QUALITY_REQUEST_INVALID");
  }
  return dependencyFailure(error);
}

function dependencyFailure(cause?: unknown): MaterializationQualityError {
  return new MaterializationQualityError("DEPENDENCY_UNAVAILABLE", { cause });
}

function postgresField(error: unknown, field: "code" | "message"): string {
  if (typeof error !== "object" || error === null) return "";
  const value: unknown = (error as Readonly<Record<string, unknown>>)[field];
  return typeof value === "string" ? value : "";
}

const rowReasonCodes = new Set<string>([
  "PRIMARY_KEY_NULL",
  "PRIMARY_KEY_DUPLICATE",
  "REQUIRED_PROPERTY_INVALID",
  "OPTIONAL_PROPERTY_INVALID",
  "REQUIRED_LINK_DANGLING",
  "OPTIONAL_LINK_DANGLING",
]);
