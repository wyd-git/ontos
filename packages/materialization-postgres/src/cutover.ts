import { parseArtifactDigest, parseOntosId } from "@ontos/contracts";
import {
  SnapshotGroupCutoverError,
  type OverlayInventoryEvidence,
  type SnapshotGroupCutoverPreparation,
  type SnapshotGroupCutoverReleaseResult,
  type SnapshotGroupCutoverRepository,
  type SnapshotGroupCutoverResult,
} from "@ontos/materialization-application";
import type pg from "pg";

interface PreparationRow extends pg.QueryResultRow {
  readonly preparationId: string;
  readonly expectedControlRevision: string;
  readonly expectedStateRevision: string;
  readonly expectedInventoryRevision: string;
  readonly releaseCount: number;
  readonly memberCount: number;
  readonly objectHeadCount: string;
  readonly state: "prepared" | "committed";
  readonly reused: boolean;
}

interface CommitRow extends pg.QueryResultRow {
  readonly preparationId: string;
  readonly projectId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: string;
  readonly controlRevision: string;
  readonly stateRevision: string;
  readonly inventoryRevision: string;
  readonly changed: boolean;
  readonly reused: boolean;
  readonly createdActivationCount: number;
  readonly insertedHeadCount: string;
  readonly updatedHeadCount: string;
  readonly repointedHeadCount: string;
  readonly releases: unknown;
}

export class PostgresSnapshotGroupCutoverRepository implements SnapshotGroupCutoverRepository {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async prepareSnapshotGroupCutover(
    input: Parameters<SnapshotGroupCutoverRepository["prepareSnapshotGroupCutover"]>[0],
  ): Promise<SnapshotGroupCutoverPreparation> {
    const { command, overlayEvidence } = input;
    try {
      const result = await this.#pool.query<PreparationRow>(
        `SELECT preparation_id AS "preparationId",
                expected_control_revision::text AS "expectedControlRevision",
                expected_state_revision::text AS "expectedStateRevision",
                expected_inventory_revision::text AS "expectedInventoryRevision",
                release_count AS "releaseCount", member_count AS "memberCount",
                object_head_count::text AS "objectHeadCount", state, reused
         FROM runtime.prepare_snapshot_group_cutover(
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10
         )`,
        [
          command.projectId,
          command.snapshotGroupId,
          command.groupVersion,
          command.expectedControlRevision.toString(),
          command.idempotencyKey,
          overlayEvidence.providerId,
          overlayEvidence.providerVersion,
          overlayEvidence.watermark,
          overlayEvidence.deltaCount,
          overlayEvidence.digest,
        ],
      );
      const row = required(result.rows[0]);
      return Object.freeze({
        preparationId: parseOntosId(row.preparationId),
        projectId: command.projectId,
        snapshotGroupId: command.snapshotGroupId,
        groupVersion: command.groupVersion,
        expectedControlRevision: BigInt(row.expectedControlRevision),
        expectedStateRevision: BigInt(row.expectedStateRevision),
        expectedInventoryRevision: BigInt(row.expectedInventoryRevision),
        releaseCount: row.releaseCount,
        memberCount: row.memberCount,
        objectHeadCount: Number(row.objectHeadCount),
        overlayEvidence: parseOverlayEvidence(overlayEvidence),
        reused: row.reused,
      });
    } catch (error) {
      throw mapPostgresCutoverError(error);
    }
  }

  async commitSnapshotGroupCutover(
    input: Parameters<SnapshotGroupCutoverRepository["commitSnapshotGroupCutover"]>[0],
  ): Promise<SnapshotGroupCutoverResult> {
    const { preparation, overlayEvidence } = input;
    try {
      const result = await this.#pool.query<CommitRow>(
        `SELECT preparation_id AS "preparationId", project_id AS "projectId",
                snapshot_group_id AS "snapshotGroupId", group_version::text AS "groupVersion",
                control_revision::text AS "controlRevision",
                state_revision::text AS "stateRevision",
                inventory_revision::text AS "inventoryRevision",
                changed, reused,
                created_activation_count AS "createdActivationCount",
                inserted_head_count::text AS "insertedHeadCount",
                updated_head_count::text AS "updatedHeadCount",
                repointed_head_count::text AS "repointedHeadCount", releases
         FROM runtime.commit_snapshot_group_cutover(
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7
         )`,
        [
          preparation.projectId,
          preparation.preparationId,
          overlayEvidence.providerId,
          overlayEvidence.providerVersion,
          overlayEvidence.watermark,
          overlayEvidence.deltaCount,
          overlayEvidence.digest,
        ],
      );
      return resultFromRow(required(result.rows[0]));
    } catch (error) {
      throw mapPostgresCutoverError(error);
    }
  }
}

function resultFromRow(row: CommitRow): SnapshotGroupCutoverResult {
  const releases = parseReleaseResults(row.releases);
  return Object.freeze({
    preparationId: parseOntosId(row.preparationId),
    projectId: parseOntosId(row.projectId),
    snapshotGroupId: parseOntosId(row.snapshotGroupId),
    groupVersion: safePositiveInteger(row.groupVersion),
    controlRevision: BigInt(row.controlRevision),
    stateRevision: BigInt(row.stateRevision),
    inventoryRevision: BigInt(row.inventoryRevision),
    changed: row.changed,
    reused: row.reused,
    insertedHeadCount: safeNonnegativeInteger(row.insertedHeadCount),
    updatedHeadCount: safeNonnegativeInteger(row.updatedHeadCount),
    repointedHeadCount: safeNonnegativeInteger(row.repointedHeadCount),
    releases,
  });
}

function parseReleaseResults(value: unknown): readonly SnapshotGroupCutoverReleaseResult[] {
  if (!Array.isArray(value)) throw new TypeError("Cutover release result is not an array.");
  return Object.freeze(
    value.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) throw new TypeError();
      const row = item as Record<string, unknown>;
      if (
        typeof row["servingHeadMoved"] !== "boolean" ||
        typeof row["channelMoved"] !== "boolean"
      ) {
        throw new TypeError();
      }
      const previous = row["previousActivationId"];
      const sequence = row["servingHeadControlSequence"];
      return Object.freeze({
        releaseId: parseOntosId(row["releaseId"]),
        activationId: parseOntosId(row["activationId"]),
        previousActivationId: previous === null ? null : parseOntosId(previous),
        servingHeadMoved: row["servingHeadMoved"],
        servingHeadControlSequence: sequence === null ? null : BigInt(requiredString(sequence)),
        channelMoved: row["channelMoved"],
      });
    }),
  );
}

function parseOverlayEvidence(value: OverlayInventoryEvidence): OverlayInventoryEvidence {
  return Object.freeze({
    providerId: requiredString(value.providerId),
    providerVersion: requiredString(value.providerVersion),
    projectId: parseOntosId(value.projectId),
    snapshotGroupKey: requiredString(value.snapshotGroupKey),
    complete: value.complete,
    watermark: safeNonnegativeInteger(value.watermark),
    deltaCount: safeNonnegativeInteger(value.deltaCount),
    digest: parseArtifactDigest(value.digest),
  });
}

function mapPostgresCutoverError(error: unknown): SnapshotGroupCutoverError {
  if (error instanceof SnapshotGroupCutoverError) return error;
  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  const message = typeof candidate.message === "string" ? candidate.message : "";
  if (/G20211_IDEMPOTENCY_CONFLICT/u.test(message)) {
    return new SnapshotGroupCutoverError("CUTOVER_IDEMPOTENCY_CONFLICT", { cause: error });
  }
  if (candidate.code === "22023" || /G20211_CUTOVER_INPUT/u.test(message)) {
    return new SnapshotGroupCutoverError("CUTOVER_INPUT_INVALID", { cause: error });
  }
  if (candidate.code === "40001" || /_STALE|_CAS_/u.test(message)) {
    return new SnapshotGroupCutoverError("CUTOVER_CONCURRENT_MODIFICATION", { cause: error });
  }
  if (/NOT_READY|INCOMPLETE|NO_RELEASE_READY/u.test(message)) {
    return new SnapshotGroupCutoverError("CUTOVER_NOT_READY", { cause: error });
  }
  return new SnapshotGroupCutoverError("CUTOVER_DEPENDENCY_UNAVAILABLE", { cause: error });
}

function safePositiveInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError();
  return parsed;
}

function safeNonnegativeInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError();
  return parsed;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new TypeError();
  return value;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("PostgreSQL returned no cutover row.");
  return value;
}
