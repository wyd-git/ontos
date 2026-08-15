import { parseArtifactDigest } from "@ontos/contracts";
import {
  MaterializationWorkerError,
  type ClaimedMaterializationJob,
  type MaterializationJobCheckpoint,
  type MaterializationJobControl,
  type MaterializationJobRepository,
  type MaterializationJobState,
  type MaterializationLease,
  type MaterializationWorkerStage,
} from "@ontos/materialization-application";
import type pg from "pg";

interface ClaimRow extends pg.QueryResultRow {
  readonly projectId: string;
  readonly jobId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: string;
  readonly inputDigest: string;
  readonly attemptNumber: number;
  readonly attemptId: string;
  readonly fencingToken: string;
  readonly checkpointId: string | null;
  readonly checkpointSequence: string | null;
  readonly checkpointStage: MaterializationWorkerStage | null;
  readonly outputReferenceId: string | null;
  readonly outputDigest: string | null;
}

interface ControlRow extends pg.QueryResultRow {
  readonly state: MaterializationJobState;
  readonly cancelRequested: boolean;
}

interface CheckpointRow extends pg.QueryResultRow {
  readonly checkpointId: string;
  readonly sequence: string;
  readonly stage: MaterializationWorkerStage;
  readonly outputReferenceId: string;
  readonly outputDigest: string;
}

interface StateRow extends pg.QueryResultRow {
  readonly state: MaterializationJobState;
}

export class PostgresMaterializationJobRepository implements MaterializationJobRepository {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async claimNext(
    input: Parameters<MaterializationJobRepository["claimNext"]>[0],
  ): Promise<ClaimedMaterializationJob | null> {
    try {
      await this.#pool.query(`SELECT ops.reap_expired_materialization_jobs(32)`);
      const result = await this.#pool.query<ClaimRow>(
        `SELECT project_id AS "projectId", job_id AS "jobId",
                snapshot_group_id AS "snapshotGroupId", group_version::text AS "groupVersion",
                input_digest AS "inputDigest", attempt_number AS "attemptNumber",
                attempt_id AS "attemptId", fencing_token::text AS "fencingToken",
                checkpoint_id AS "checkpointId",
                checkpoint_sequence::text AS "checkpointSequence",
                checkpoint_stage AS "checkpointStage",
                output_reference_id AS "outputReferenceId",
                output_digest AS "outputDigest"
           FROM ops.claim_materialization_job_v2($1, $2, $3)`,
        [input.workerInstanceId, input.attemptId, input.leaseSeconds],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      if (result.rows.length !== 1) throw new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT");
      const lease = Object.freeze({
        projectId: row.projectId,
        jobId: row.jobId,
        attemptId: row.attemptId,
        workerInstanceId: input.workerInstanceId,
        fencingToken: parsePositiveBigInt(row.fencingToken),
      });
      return Object.freeze({
        projectId: row.projectId,
        jobId: row.jobId,
        snapshotGroupId: row.snapshotGroupId,
        groupVersion: parsePositiveNumber(row.groupVersion),
        inputDigest: parseArtifactDigest(row.inputDigest),
        attemptNumber: row.attemptNumber,
        lease,
        latestCheckpoint: checkpointFromClaim(row),
      });
    } catch (error) {
      throw mapWorkerPostgresError(error);
    }
  }

  async heartbeat(input: Parameters<MaterializationJobRepository["heartbeat"]>[0]): Promise<void> {
    await this.#call(
      `SELECT ops.heartbeat_materialization_job($1, $2, $3, $4, $5, $6)`,
      leaseParameters(input.lease, input.leaseSeconds),
    );
  }

  async readControl(lease: MaterializationLease): Promise<MaterializationJobControl> {
    try {
      const result = await this.#pool.query<ControlRow>(
        `SELECT state, cancel_requested AS "cancelRequested"
           FROM ops.read_materialization_job_control($1, $2, $3, $4, $5)`,
        leaseParameters(lease),
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || row === undefined) {
        throw new MaterializationWorkerError("JOB_FENCED");
      }
      return Object.freeze({ state: row.state, cancelRequested: row.cancelRequested });
    } catch (error) {
      throw mapWorkerPostgresError(error);
    }
  }

  async completeStage(
    input: Parameters<MaterializationJobRepository["completeStage"]>[0],
  ): Promise<MaterializationJobCheckpoint> {
    try {
      const result = await this.#pool.query<CheckpointRow>(
        `SELECT checkpoint_id AS "checkpointId", sequence::text, stage,
                output_reference_id AS "outputReferenceId", output_digest AS "outputDigest"
           FROM ops.complete_materialization_stage(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
           )`,
        [
          ...leaseParameters(input.lease),
          input.checkpointId,
          input.sequence,
          input.stage,
          input.result.outputReferenceId,
          input.result.outputDigest,
        ],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || row === undefined) {
        throw new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT");
      }
      return checkpointFromRow(row);
    } catch (error) {
      throw mapWorkerPostgresError(error);
    }
  }

  async succeed(input: Parameters<MaterializationJobRepository["succeed"]>[0]): Promise<void> {
    await this.#call(`SELECT ops.succeed_materialization_job($1, $2, $3, $4, $5, $6)`, [
      ...leaseParameters(input.lease),
      input.resultDigest,
    ]);
  }

  async fail(
    input: Parameters<MaterializationJobRepository["fail"]>[0],
  ): Promise<MaterializationJobState> {
    try {
      const result = await this.#pool.query<StateRow>(
        `SELECT state
           FROM ops.fail_materialization_job(
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
           )`,
        [
          ...leaseParameters(input.lease),
          input.failure.code,
          input.failure.category,
          input.failure.retryable,
          input.failure.fingerprint,
          JSON.stringify(input.samples),
        ],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || row === undefined) {
        throw new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT");
      }
      return row.state;
    } catch (error) {
      throw mapWorkerPostgresError(error);
    }
  }

  async cancelAtSafePoint(lease: MaterializationLease): Promise<void> {
    await this.#call(
      `SELECT ops.cancel_materialization_job_at_safe_point($1, $2, $3, $4, $5)`,
      leaseParameters(lease),
    );
  }

  async #call(statement: string, parameters: unknown[]): Promise<void> {
    try {
      await this.#pool.query(statement, parameters);
    } catch (error) {
      throw mapWorkerPostgresError(error);
    }
  }
}

function checkpointFromClaim(row: ClaimRow): MaterializationJobCheckpoint | null {
  if (
    row.checkpointId === null &&
    row.checkpointSequence === null &&
    row.checkpointStage === null &&
    row.outputReferenceId === null &&
    row.outputDigest === null
  ) {
    return null;
  }
  if (
    row.checkpointId === null ||
    row.checkpointSequence === null ||
    row.checkpointStage === null ||
    row.outputReferenceId === null ||
    row.outputDigest === null
  ) {
    throw new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT");
  }
  return Object.freeze({
    checkpointId: row.checkpointId,
    sequence: parsePositiveNumber(row.checkpointSequence),
    stage: row.checkpointStage,
    outputReferenceId: row.outputReferenceId,
    outputDigest: parseArtifactDigest(row.outputDigest),
  });
}

function checkpointFromRow(row: CheckpointRow): MaterializationJobCheckpoint {
  return Object.freeze({
    checkpointId: row.checkpointId,
    sequence: parsePositiveNumber(row.sequence),
    stage: row.stage,
    outputReferenceId: row.outputReferenceId,
    outputDigest: parseArtifactDigest(row.outputDigest),
  });
}

function leaseParameters(lease: MaterializationLease, trailing?: unknown): unknown[] {
  const parameters: unknown[] = [
    lease.projectId,
    lease.jobId,
    lease.attemptId,
    lease.workerInstanceId,
    lease.fencingToken.toString(),
  ];
  if (trailing !== undefined) parameters.push(trailing);
  return parameters;
}

function parsePositiveBigInt(value: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 1n) throw new Error("non-positive");
    return parsed;
  } catch (error) {
    throw new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT", { cause: error });
  }
}

function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT");
  }
  return parsed;
}

function mapWorkerPostgresError(error: unknown): MaterializationWorkerError {
  if (error instanceof MaterializationWorkerError) return error;
  const message = postgresMessage(error);
  if (message.includes("MATERIALIZATION_JOB_FENCED")) {
    return new MaterializationWorkerError("JOB_FENCED", { cause: error });
  }
  if (message.includes("MATERIALIZATION_JOB_NOT_CANCELLABLE")) {
    return new MaterializationWorkerError("JOB_NOT_CANCELLABLE", { cause: error });
  }
  if (
    message.includes("MATERIALIZATION_JOB_PROTOCOL_CONFLICT") ||
    message.includes("G20208_JOB_")
  ) {
    return new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT", { cause: error });
  }
  return new MaterializationWorkerError("DEPENDENCY_UNAVAILABLE", { cause: error });
}

function postgresMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const message: unknown = (error as Readonly<Record<string, unknown>>).message;
  return typeof message === "string" ? message : "";
}
