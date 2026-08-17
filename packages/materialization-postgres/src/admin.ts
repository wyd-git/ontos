import { parseArtifactDigest, parseCanonicalInstant, parseOntosId } from "@ontos/contracts";
import {
  MaterializationAdminError,
  type MaterializationAdminRepository,
  type MaterializationCapacityApprovalView,
  type MaterializationCapacityStatusView,
  type MaterializationJobStatusView,
  type MaterializationReportView,
  type MaterializationSnapshotGroupSummary,
  type MaterializationSnapshotMemberSummary,
  type MaterializationSnapshotSummary,
} from "@ontos/materialization-application";
import type pg from "pg";

interface GroupRow extends pg.QueryResultRow {
  readonly projectId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: string;
  readonly state: string;
  readonly groupDigest: string;
  readonly memberCount: number;
  readonly createdAt: string;
}

interface SnapshotMemberRow extends pg.QueryResultRow {
  readonly projectId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: string;
  readonly memberKey: string;
  readonly memberKind: string;
  readonly snapshotId: string;
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly contentDigest: string;
  readonly rowCount: string;
  readonly byteCount: string;
  readonly state: string;
  readonly sourceLabel: string;
  readonly createdAt: string;
}

interface JobRow extends pg.QueryResultRow {
  readonly projectId: string;
  readonly jobId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: string;
  readonly state: string;
  readonly currentStage: string | null;
  readonly attemptCount: number;
  readonly cancelRequested: boolean;
  readonly resultCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: string;
}

interface EnqueueRow extends pg.QueryResultRow {
  readonly jobId: string;
  readonly state: string;
  readonly reused: boolean;
}

interface ReportRow extends pg.QueryResultRow {
  readonly projectId: string;
  readonly reportId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: string;
  readonly jobId: string;
  readonly outcome: string;
  readonly totalRows: string;
  readonly acceptedRows: string;
  readonly rejectedRows: string;
  readonly validatorVersion: string;
  readonly reportDigest: string;
  readonly createdAt: string;
}

interface ReasonRow extends pg.QueryResultRow {
  readonly code: string;
  readonly count: string;
}

interface SampleRow extends pg.QueryResultRow {
  readonly fileId: string;
  readonly rowNumber: string;
  readonly reasonCode: string;
  readonly fingerprint: string;
}

interface CapacityRow extends pg.QueryResultRow {
  readonly projectId: string;
  readonly generationId: string;
  readonly inventoryRevision: string;
  readonly phase: "PREBUILD" | "POSTBUILD" | null;
  readonly measuredBytes: string | null;
  readonly reservedBytes: string | null;
  readonly steadyReservedBytes: string | null;
  readonly peakReservedBytes: string | null;
  readonly reportDigest: string | null;
}

interface ApprovalRow extends pg.QueryResultRow {
  readonly approvalId: string;
  readonly scope: string;
  readonly scopeId: string | null;
  readonly approvedLimitBytes: string;
  readonly hardLimitBytes: string;
  readonly evidenceDigest: string;
  readonly state: string;
  readonly expiresAt: string;
  readonly reused?: boolean;
}

interface GcPlanRow extends pg.QueryResultRow {
  readonly planDigest: string;
}

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

const timestampExpression = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export class PostgresMaterializationAdminRepository implements MaterializationAdminRepository {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async getSnapshotGroup(
    input: Parameters<MaterializationAdminRepository["getSnapshotGroup"]>[0],
  ): Promise<MaterializationSnapshotGroupSummary> {
    try {
      const group = await this.#pool.query<GroupRow>(
        `SELECT project_id AS "projectId", snapshot_group_id AS "snapshotGroupId",
                group_version::text AS "groupVersion", state,
                group_digest AS "groupDigest", member_count AS "memberCount",
                ${timestampExpression("created_at")} AS "createdAt"
         FROM runtime.snapshot_group_versions
         WHERE project_id = $1::uuid AND snapshot_group_id = $2::uuid
           AND group_version = $3`,
        [input.projectId, input.snapshotGroupId, input.groupVersion],
      );
      const groupRow = accessible(group.rows[0]);
      const members = await this.#readSnapshotMembers(this.#pool, input);
      if (members.length !== groupRow.memberCount) {
        throw new MaterializationAdminError("DEPENDENCY_UNAVAILABLE");
      }
      return Object.freeze({
        projectId: parseOntosId(groupRow.projectId),
        snapshotGroupId: parseOntosId(groupRow.snapshotGroupId),
        groupVersion: positiveInteger(groupRow.groupVersion),
        state: groupState(groupRow.state),
        groupDigest: parseArtifactDigest(groupRow.groupDigest),
        memberCount: boundedInteger(groupRow.memberCount, 1, 256),
        createdAt: parseCanonicalInstant(groupRow.createdAt),
        members,
      });
    } catch (error) {
      throw mapAdminDatabaseError(error);
    }
  }

  async getSnapshot(
    input: Parameters<MaterializationAdminRepository["getSnapshot"]>[0],
  ): Promise<MaterializationSnapshotSummary> {
    try {
      const result = await this.#pool.query<SnapshotMemberRow>(
        `${snapshotMemberSelect()}
         WHERE snapshot.project_id = $1::uuid AND snapshot.snapshot_id = $2::uuid`,
        [input.projectId, input.snapshotId],
      );
      return snapshotFromRow(accessible(result.rows[0]));
    } catch (error) {
      throw mapAdminDatabaseError(error);
    }
  }

  async enqueueJob(
    input: Parameters<MaterializationAdminRepository["enqueueJob"]>[0],
  ): Promise<MaterializationJobStatusView> {
    try {
      const result = await this.#pool.query<EnqueueRow>(
        `SELECT job_id AS "jobId", state, reused
         FROM ops.enqueue_materialization_job_admin(
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7
         )`,
        [
          input.projectId,
          input.jobId,
          input.snapshotGroupId,
          input.groupVersion,
          input.idempotencyKey,
          input.correlationId,
          input.priority,
        ],
      );
      const enqueued = required(result.rows[0]);
      const job = await this.#readJob(this.#pool, input.projectId, enqueued.jobId);
      return Object.freeze({ ...job, reused: enqueued.reused });
    } catch (error) {
      throw mapAdminDatabaseError(error);
    }
  }

  async getJob(
    input: Parameters<MaterializationAdminRepository["getJob"]>[0],
  ): Promise<MaterializationJobStatusView> {
    try {
      return await this.#readJob(this.#pool, input.projectId, input.jobId);
    } catch (error) {
      throw mapAdminDatabaseError(error);
    }
  }

  async cancelJob(
    input: Parameters<MaterializationAdminRepository["cancelJob"]>[0],
  ): Promise<MaterializationJobStatusView> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT state, cancel_requested, updated_at
         FROM ops.request_materialization_job_cancel_v2($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)`,
        [input.projectId, input.jobId, input.principalId, input.expectedVersion],
      );
      const job = await this.#readJob(client, input.projectId, input.jobId);
      await client.query("COMMIT");
      return job;
    } catch (error) {
      await rollbackQuietly(client);
      throw mapAdminDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async getReport(
    input: Parameters<MaterializationAdminRepository["getReport"]>[0],
  ): Promise<MaterializationReportView> {
    try {
      const [report, reasons, samples] = await Promise.all([
        this.#pool.query<ReportRow>(
          `SELECT project_id AS "projectId", report_id AS "reportId",
                  snapshot_group_id AS "snapshotGroupId",
                  group_version::text AS "groupVersion", job_id AS "jobId", outcome,
                  total_rows::text AS "totalRows", accepted_rows::text AS "acceptedRows",
                  rejected_rows::text AS "rejectedRows",
                  validator_version AS "validatorVersion", report_digest AS "reportDigest",
                  ${timestampExpression("created_at")} AS "createdAt"
           FROM runtime.materialization_reports
           WHERE project_id = $1::uuid AND report_id = $2::uuid`,
          [input.projectId, input.reportId],
        ),
        this.#pool.query<ReasonRow>(
          `SELECT reason_code AS code, reason_count::text AS count
           FROM runtime.materialization_report_reasons
           WHERE project_id = $1::uuid AND report_id = $2::uuid
           ORDER BY reason_code COLLATE "C"`,
          [input.projectId, input.reportId],
        ),
        this.#pool.query<SampleRow>(
          `SELECT file_id AS "fileId", row_number::text AS "rowNumber",
                  reason_code AS "reasonCode", fingerprint
           FROM ops.materialization_admin_report_samples
           WHERE project_id = $1::uuid AND report_id = $2::uuid
           ORDER BY ordinal
           LIMIT 50`,
          [input.projectId, input.reportId],
        ),
      ]);
      const row = accessible(report.rows[0]);
      return Object.freeze({
        projectId: parseOntosId(row.projectId),
        reportId: parseOntosId(row.reportId),
        snapshotGroupId: parseOntosId(row.snapshotGroupId),
        groupVersion: positiveInteger(row.groupVersion),
        jobId: parseOntosId(row.jobId),
        outcome: reportOutcome(row.outcome),
        totalRows: nonnegativeInteger(row.totalRows),
        acceptedRows: nonnegativeInteger(row.acceptedRows),
        rejectedRows: nonnegativeInteger(row.rejectedRows),
        validatorVersion: boundedText(row.validatorVersion, 1, 128),
        reportDigest: parseArtifactDigest(row.reportDigest),
        createdAt: parseCanonicalInstant(row.createdAt),
        reasons: Object.freeze(
          reasons.rows.map((reason) =>
            Object.freeze({ code: stableCode(reason.code), count: positiveInteger(reason.count) }),
          ),
        ),
        samples: Object.freeze(
          samples.rows.map((sample) =>
            Object.freeze({
              fileId: parseOntosId(sample.fileId),
              rowNumber: positiveInteger(sample.rowNumber),
              reasonCode: stableCode(sample.reasonCode),
              fingerprint: parseArtifactDigest(sample.fingerprint),
            }),
          ),
        ),
      });
    } catch (error) {
      throw mapAdminDatabaseError(error);
    }
  }

  async getCapacityStatus(
    input: Parameters<MaterializationAdminRepository["getCapacityStatus"]>[0],
  ): Promise<MaterializationCapacityStatusView> {
    try {
      const status = await this.#pool.query<CapacityRow>(
        `SELECT generation.project_id AS "projectId",
                generation.generation_id AS "generationId",
                inventory.inventory_revision::text AS "inventoryRevision",
                admission.phase, admission.measured_bytes::text AS "measuredBytes",
                admission.reserved_bytes::text AS "reservedBytes",
                admission.steady_reserved_bytes::text AS "steadyReservedBytes",
                admission.peak_reserved_bytes::text AS "peakReservedBytes",
                admission.report_digest AS "reportDigest"
         FROM runtime.generations AS generation
         JOIN runtime.project_runtime_inventories AS inventory
           ON inventory.project_id = generation.project_id
         LEFT JOIN LATERAL (
           SELECT candidate.* FROM runtime.capacity_admissions AS candidate
           WHERE candidate.project_id = generation.project_id
             AND candidate.generation_id = generation.generation_id
           ORDER BY CASE candidate.phase WHEN 'POSTBUILD' THEN 0 ELSE 1 END,
                    candidate.admitted_at DESC
           LIMIT 1
         ) AS admission ON true
         WHERE generation.project_id = $1::uuid AND generation.generation_id = $2::uuid`,
        [input.projectId, input.generationId],
      );
      const approval = await this.#pool.query<ApprovalRow>(
        `SELECT approval_id AS "approvalId", scope, scope_id AS "scopeId",
                approved_limit_bytes::text AS "approvedLimitBytes",
                hard_limit_bytes::text AS "hardLimitBytes", evidence_digest AS "evidenceDigest",
                state, ${timestampExpression("expires_at")} AS "expiresAt"
         FROM runtime.materialization_admin_capacity_approvals
         WHERE project_id = $1::uuid AND state = 'active' AND expires_at > clock_timestamp()
         ORDER BY created_at DESC, approval_id
         LIMIT 1`,
        [input.projectId],
      );
      return capacityFromRows(accessible(status.rows[0]), approval.rows[0]);
    } catch (error) {
      throw mapAdminDatabaseError(error);
    }
  }

  async approveCapacity(
    input: Parameters<MaterializationAdminRepository["approveCapacity"]>[0],
  ): Promise<MaterializationCapacityApprovalView> {
    try {
      const result = await this.#pool.query<ApprovalRow>(
        `SELECT approval_id AS "approvalId", scope, scope_id AS "scopeId",
                approved_limit_bytes::text AS "approvedLimitBytes",
                hard_limit_bytes::text AS "hardLimitBytes", evidence_digest AS "evidenceDigest",
                state, ${timestampExpression("expires_at")} AS "expiresAt", reused
         FROM runtime.approve_materialization_capacity(
           $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7::uuid, $8, $9, $10::timestamptz
         )`,
        [
          input.projectId,
          input.approvalId,
          input.scope,
          input.scopeId,
          input.approvedLimitBytes.toString(),
          input.hardLimitBytes.toString(),
          input.principalId,
          input.expectedInventoryRevision.toString(),
          input.evidenceDigest,
          input.expiresAt,
        ],
      );
      return approvalFromRow(required(result.rows[0]));
    } catch (error) {
      throw mapAdminDatabaseError(error);
    }
  }

  async assertGcPlanBinding(
    input: Parameters<MaterializationAdminRepository["assertGcPlanBinding"]>[0],
  ): Promise<void> {
    try {
      const result = await this.#pool.query<GcPlanRow>(
        `SELECT plan_digest AS "planDigest"
         FROM ops.gc_plan_status
         WHERE project_id = $1::uuid AND gc_plan_id = $2::uuid`,
        [input.projectId, input.planId],
      );
      const row = accessible(result.rows[0]);
      if (parseArtifactDigest(row.planDigest) !== input.expectedPlanDigest) {
        throw new MaterializationAdminError("OBJECT_VERSION_CONFLICT");
      }
    } catch (error) {
      throw mapAdminDatabaseError(error);
    }
  }

  async #readSnapshotMembers(
    queryable: Queryable,
    input: {
      readonly projectId: string;
      readonly snapshotGroupId: string;
      readonly groupVersion: number;
    },
  ): Promise<readonly MaterializationSnapshotMemberSummary[]> {
    const result = await queryable.query<SnapshotMemberRow>(
      `${snapshotMemberSelect()}
       WHERE snapshot.project_id = $1::uuid
         AND snapshot.snapshot_group_id = $2::uuid AND snapshot.group_version = $3
       ORDER BY snapshot.member_key COLLATE "C"`,
      [input.projectId, input.snapshotGroupId, input.groupVersion],
    );
    return Object.freeze(result.rows.map(snapshotMemberFromRow));
  }

  async #readJob(
    queryable: Queryable,
    projectId: string,
    jobId: string,
  ): Promise<MaterializationJobStatusView> {
    const result = await queryable.query<JobRow>(
      `SELECT project_id AS "projectId", job_id AS "jobId",
              snapshot_group_id AS "snapshotGroupId", group_version::text AS "groupVersion",
              state, current_stage AS "currentStage", attempt_count AS "attemptCount",
              cancel_requested AS "cancelRequested", result_code AS "resultCode",
              ${timestampExpression("created_at")} AS "createdAt",
              ${timestampExpression("updated_at")} AS "updatedAt",
              ${timestampExpression("updated_at")} AS version
       FROM ops.materialization_jobs
       WHERE project_id = $1::uuid AND job_id = $2::uuid`,
      [projectId, jobId],
    );
    return jobFromRow(accessible(result.rows[0]));
  }
}

function snapshotMemberSelect(): string {
  return `SELECT snapshot.project_id AS "projectId",
                 snapshot.snapshot_group_id AS "snapshotGroupId",
                 snapshot.group_version::text AS "groupVersion",
                 snapshot.member_key AS "memberKey", snapshot.member_kind AS "memberKind",
                 snapshot.snapshot_id AS "snapshotId",
                 snapshot.target_resource_id AS "targetResourceId",
                 snapshot.target_revision_id AS "targetRevisionId",
                 snapshot.content_digest AS "contentDigest", snapshot.row_count::text AS "rowCount",
                 snapshot.byte_count::text AS "byteCount", snapshot.state,
                 file.source_label AS "sourceLabel",
                 ${timestampExpression("snapshot.registered_at")} AS "createdAt"
          FROM runtime.dataset_snapshots AS snapshot
          JOIN LATERAL (
            SELECT candidate.source_label
            FROM runtime.snapshot_files AS candidate
            WHERE candidate.project_id = snapshot.project_id
              AND candidate.snapshot_id = snapshot.snapshot_id
            ORDER BY candidate.ordinal
            LIMIT 1
          ) AS file ON true`;
}

function snapshotMemberFromRow(row: SnapshotMemberRow): MaterializationSnapshotMemberSummary {
  return Object.freeze({
    memberKey: memberKey(row.memberKey),
    memberKind: memberKind(row.memberKind),
    snapshotId: parseOntosId(row.snapshotId),
    targetResourceId: parseOntosId(row.targetResourceId),
    targetRevisionId: parseOntosId(row.targetRevisionId),
    contentDigest: parseArtifactDigest(row.contentDigest),
    rowCount: nonnegativeInteger(row.rowCount),
    sourceLabel: boundedText(row.sourceLabel, 1, 128),
  });
}

function snapshotFromRow(row: SnapshotMemberRow): MaterializationSnapshotSummary {
  return Object.freeze({
    ...snapshotMemberFromRow(row),
    projectId: parseOntosId(row.projectId),
    snapshotGroupId: parseOntosId(row.snapshotGroupId),
    groupVersion: positiveInteger(row.groupVersion),
    state: snapshotState(row.state),
    byteCount: nonnegativeInteger(row.byteCount),
    createdAt: parseCanonicalInstant(row.createdAt),
  });
}

function jobFromRow(row: JobRow): MaterializationJobStatusView {
  return Object.freeze({
    projectId: parseOntosId(row.projectId),
    jobId: parseOntosId(row.jobId),
    snapshotGroupId: parseOntosId(row.snapshotGroupId),
    groupVersion: positiveInteger(row.groupVersion),
    state: jobState(row.state),
    currentStage: workerStage(row.currentStage),
    attemptCount: nonnegativeInteger(row.attemptCount),
    cancelRequested: row.cancelRequested,
    resultCode: row.resultCode === null ? null : stableCode(row.resultCode),
    createdAt: parseCanonicalInstant(row.createdAt),
    updatedAt: parseCanonicalInstant(row.updatedAt),
    version: parseCanonicalInstant(row.version),
  });
}

function capacityFromRows(
  row: CapacityRow,
  approval: ApprovalRow | undefined,
): MaterializationCapacityStatusView {
  return Object.freeze({
    projectId: parseOntosId(row.projectId),
    generationId: parseOntosId(row.generationId),
    inventoryRevision: BigInt(row.inventoryRevision),
    phase: row.phase,
    measuredBytes: nullableBigint(row.measuredBytes),
    reservedBytes: nullableBigint(row.reservedBytes),
    steadyReservedBytes: nullableBigint(row.steadyReservedBytes),
    peakReservedBytes: nullableBigint(row.peakReservedBytes),
    reportDigest: row.reportDigest === null ? null : parseArtifactDigest(row.reportDigest),
    approval: approval === undefined ? null : approvalFromRow(approval),
  });
}

function approvalFromRow(row: ApprovalRow): MaterializationCapacityApprovalView {
  return Object.freeze({
    approvalId: parseOntosId(row.approvalId),
    scope: approvalScope(row.scope),
    scopeId: row.scopeId === null ? null : parseOntosId(row.scopeId),
    approvedLimitBytes: BigInt(row.approvedLimitBytes),
    hardLimitBytes: BigInt(row.hardLimitBytes),
    evidenceDigest: parseArtifactDigest(row.evidenceDigest),
    state: approvalState(row.state),
    expiresAt: parseCanonicalInstant(row.expiresAt),
    reused: row.reused ?? false,
  });
}

function mapAdminDatabaseError(error: unknown): MaterializationAdminError {
  if (error instanceof MaterializationAdminError) return error;
  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  const message = typeof candidate.message === "string" ? candidate.message : "";
  if (/MATERIALIZATION_OBJECT_NOT_ACCESSIBLE|_NOT_FOUND/u.test(message)) {
    return new MaterializationAdminError("OBJECT_NOT_ACCESSIBLE", { cause: error });
  }
  if (candidate.code === "40001" || /OBJECT_VERSION_CONFLICT|_STALE|_CAS_/u.test(message)) {
    return new MaterializationAdminError("OBJECT_VERSION_CONFLICT", { cause: error });
  }
  if (/JOB_NOT_CANCELLABLE/u.test(message)) {
    return new MaterializationAdminError("JOB_NOT_CANCELLABLE", { cause: error });
  }
  if (/G20214_DATA_BEARING_PROJECT_LIMIT_EXCEEDED/u.test(message)) {
    return new MaterializationAdminError("DATA_BEARING_PROJECT_LIMIT_EXCEEDED", { cause: error });
  }
  if (candidate.code === "22023" || /_INPUT_INVALID/u.test(message)) {
    return new MaterializationAdminError("ADMIN_REQUEST_INVALID", { cause: error });
  }
  if (candidate.code === "23505" || /IDEMPOTENCY_CONFLICT/u.test(message)) {
    return new MaterializationAdminError("OBJECT_VERSION_CONFLICT", { cause: error });
  }
  return new MaterializationAdminError("DEPENDENCY_UNAVAILABLE", { cause: error });
}

function accessible<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new MaterializationAdminError("OBJECT_NOT_ACCESSIBLE");
  return value;
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new MaterializationAdminError("DEPENDENCY_UNAVAILABLE");
  return value;
}

function positiveInteger(value: string | number): number {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

function nonnegativeInteger(value: string | number): number {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: string | number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new TypeError();
  return parsed;
}

function nullableBigint(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function boundedText(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new TypeError();
  }
  return value;
}

function stableCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{1,127}$/u.test(value)) {
    throw new TypeError();
  }
  return value;
}

function memberKey(value: unknown): string {
  if (typeof value !== "string" || !/^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$/u.test(value)) {
    throw new TypeError();
  }
  return value;
}

function memberKind(value: unknown): "object" | "link" {
  if (value !== "object" && value !== "link") throw new TypeError();
  return value;
}

function groupState(value: unknown): MaterializationSnapshotGroupSummary["state"] {
  if (
    value !== "registered" &&
    value !== "validated" &&
    value !== "materializing" &&
    value !== "ready" &&
    value !== "active" &&
    value !== "superseded" &&
    value !== "failed"
  ) {
    throw new TypeError();
  }
  return value;
}

function snapshotState(value: unknown): MaterializationSnapshotSummary["state"] {
  return groupState(value);
}

function jobState(value: unknown): MaterializationJobStatusView["state"] {
  if (
    value !== "queued" &&
    value !== "running" &&
    value !== "retry_wait" &&
    value !== "succeeded" &&
    value !== "dead_letter" &&
    value !== "cancelled"
  ) {
    throw new TypeError();
  }
  return value;
}

function workerStage(value: unknown): MaterializationJobStatusView["currentStage"] {
  if (value === null) return null;
  if (
    value !== "scan" &&
    value !== "map" &&
    value !== "validate" &&
    value !== "build_stage" &&
    value !== "build_index" &&
    value !== "ready_for_activation" &&
    value !== "catch_up" &&
    value !== "activate"
  ) {
    throw new TypeError();
  }
  return value;
}

function reportOutcome(value: unknown): MaterializationReportView["outcome"] {
  if (value !== "passed" && value !== "awaiting_confirmation" && value !== "failed") {
    throw new TypeError();
  }
  return value;
}

function approvalScope(value: unknown): MaterializationCapacityApprovalView["scope"] {
  if (
    value !== "release" &&
    value !== "project_steady" &&
    value !== "project_peak" &&
    value !== "index"
  ) {
    throw new TypeError();
  }
  return value;
}

function approvalState(value: unknown): MaterializationCapacityApprovalView["state"] {
  if (value !== "active" && value !== "revoked" && value !== "expired") throw new TypeError();
  return value;
}

async function rollbackQuietly(client: pg.PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original database error remains authoritative.
  }
}
