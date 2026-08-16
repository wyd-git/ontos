import {
  MaterializationBaseError,
  type LinkBaseStageRow,
  type MaterializationBasePromotion,
  type MaterializationBaseRepository,
  type ObjectBaseStageRow,
  type ObjectIdentityResolution,
  type StageBaseBatchInput,
} from "@ontos/materialization-application";
import { parseArtifactDigest } from "@ontos/contracts";
import type pg from "pg";

interface IdentityResolutionRow extends pg.QueryResultRow {
  readonly ordinal: number;
  readonly objectRid: string;
}

interface PromotionRow extends pg.QueryResultRow {
  readonly rowCount: string;
  readonly stageDigest: string;
  readonly reused: boolean;
}

export class PostgresMaterializationBaseRepository implements MaterializationBaseRepository {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async resolveOrCreateObjectIdentities(
    input: Parameters<MaterializationBaseRepository["resolveOrCreateObjectIdentities"]>[0],
  ): Promise<readonly ObjectIdentityResolution[]> {
    try {
      const result = await this.#pool.query<IdentityResolutionRow>(
        `SELECT ordinal, object_rid AS "objectRid"
           FROM runtime.resolve_or_create_object_identities($1, $2::jsonb)
          ORDER BY ordinal`,
        [input.projectId, JSON.stringify(input.candidates)],
      );
      return Object.freeze(result.rows.map(toIdentityResolution));
    } catch (error) {
      throw mapPostgresBaseError(error, "identity");
    }
  }

  async lookupObjectIdentities(
    input: Parameters<MaterializationBaseRepository["lookupObjectIdentities"]>[0],
  ): Promise<readonly ObjectIdentityResolution[]> {
    try {
      const result = await this.#pool.query<IdentityResolutionRow>(
        `SELECT ordinal, object_rid AS "objectRid"
           FROM runtime.lookup_object_identities($1, $2::jsonb)
          ORDER BY ordinal`,
        [input.projectId, JSON.stringify(input.lookups)],
      );
      return Object.freeze(result.rows.map(toIdentityResolution));
    } catch (error) {
      throw mapPostgresBaseError(error, "lookup");
    }
  }

  async stageObjectBaseBatch(input: StageBaseBatchInput<ObjectBaseStageRow>): Promise<void> {
    try {
      await this.#pool.query(
        `SELECT ops.stage_object_base_batch(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
         )`,
        stageParameters(input),
      );
    } catch (error) {
      throw mapPostgresBaseError(error, "base");
    }
  }

  async stageLinkBaseBatch(input: StageBaseBatchInput<LinkBaseStageRow>): Promise<void> {
    try {
      await this.#pool.query(
        `SELECT ops.stage_link_base_batch(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
         )`,
        stageParameters(input),
      );
    } catch (error) {
      throw mapPostgresBaseError(error, "base");
    }
  }

  async promoteGenerationBase(
    input: Parameters<MaterializationBaseRepository["promoteGenerationBase"]>[0],
  ): Promise<MaterializationBasePromotion> {
    try {
      const result = await this.#pool.query<PromotionRow>(
        input.expectedRowCount === 0
          ? `SELECT row_count::text AS "rowCount", stage_digest AS "stageDigest", reused
               FROM ops.promote_empty_materialization_base($1, $2, $3, $4, $5, $6)`
          : `SELECT row_count::text AS "rowCount", stage_digest AS "stageDigest", reused
               FROM ops.promote_materialization_base($1, $2, $3, $4, $5, $6, $7)`,
        input.expectedRowCount === 0
          ? [
              input.scope.projectId,
              input.scope.jobId,
              input.scope.attemptId,
              input.scope.fencingToken.toString(),
              input.generationId,
              input.expectedStageDigest,
            ]
          : [
              input.scope.projectId,
              input.scope.jobId,
              input.scope.attemptId,
              input.scope.fencingToken.toString(),
              input.generationId,
              input.expectedRowCount,
              input.expectedStageDigest,
            ],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || row === undefined) {
        throw new MaterializationBaseError("DEPENDENCY_UNAVAILABLE");
      }
      const rowCount = Number(row.rowCount);
      if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
        throw new MaterializationBaseError("DEPENDENCY_UNAVAILABLE");
      }
      return Object.freeze({
        rowCount,
        stageDigest: parseArtifactDigest(row.stageDigest),
        reused: row.reused,
      });
    } catch (error) {
      throw mapPostgresBaseError(error, "base");
    }
  }
}

function stageParameters<Row extends ObjectBaseStageRow | LinkBaseStageRow>(
  input: StageBaseBatchInput<Row>,
): unknown[] {
  return [
    input.scope.projectId,
    input.scope.jobId,
    input.scope.attemptId,
    input.scope.fencingToken.toString(),
    input.batchSequence,
    input.batchDigest,
    input.generation.generationId,
    input.generation.targetResourceId,
    input.generation.targetRevisionId,
    input.generation.sourceSnapshotId,
    input.generation.sourceFileId,
    JSON.stringify(input.rows),
  ];
}

function toIdentityResolution(row: IdentityResolutionRow): ObjectIdentityResolution {
  return Object.freeze({ ordinal: row.ordinal, objectRid: row.objectRid });
}

function mapPostgresBaseError(
  error: unknown,
  operation: "identity" | "lookup" | "base",
): MaterializationBaseError {
  if (error instanceof MaterializationBaseError) return error;
  const code = postgresField(error, "code");
  const message = postgresField(error, "message");
  if (message.includes("MATERIALIZATION_JOB_FENCED")) {
    return new MaterializationBaseError("MATERIALIZATION_ATTEMPT_FENCED");
  }
  if (message.includes("MATERIALIZATION_LINK_ENDPOINT_TYPE_INVALID")) {
    return new MaterializationBaseError("LINK_ENDPOINT_TYPE_INVALID");
  }
  if (
    message.includes("MATERIALIZATION_IDENTITY_CONFLICT") ||
    (code === "23505" && operation === "identity")
  ) {
    return new MaterializationBaseError("OBJECT_IDENTITY_CONFLICT");
  }
  if (
    message.includes("MATERIALIZATION_BASE_CONFLICT") ||
    message.includes("MATERIALIZATION_BASE_INCOMPLETE") ||
    (code === "23505" && operation === "base")
  ) {
    return new MaterializationBaseError("MATERIALIZATION_BASE_CONFLICT");
  }
  if (message.includes("G20206_BASE_REQUEST_INVALID") || code === "22023") {
    return new MaterializationBaseError("BASE_REQUEST_INVALID");
  }
  if (operation === "lookup" && code === "23514") {
    return new MaterializationBaseError("LINK_ENDPOINT_TYPE_INVALID");
  }
  return new MaterializationBaseError("DEPENDENCY_UNAVAILABLE");
}

function postgresField(error: unknown, field: "code" | "message"): string {
  if (typeof error !== "object" || error === null) return "";
  const value: unknown = (error as Readonly<Record<string, unknown>>)[field];
  return typeof value === "string" ? value : "";
}
