import { randomUUID } from "node:crypto";

import {
  parseArtifactDigest,
  parseCompatibilityCertificate,
  parseOntosId,
  type CompatibilityCertificateContract,
} from "@ontos/contracts";
import {
  RuntimeCompatibilityError,
  parseRuntimeRefreshMember,
  type RuntimeCompatibilityRepository,
  type RuntimeGenerationCandidate,
  type RuntimeMaterializationJobStatus,
  type RuntimeRefreshTargetRelease,
} from "@ontos/materialization-application";
import type pg from "pg";

interface RefreshTargetRow extends pg.QueryResultRow {
  readonly releaseId: string;
  readonly releaseState: RuntimeRefreshTargetRelease["releaseState"];
  readonly snapshotGroupCompatible: boolean;
  readonly memberKey: string;
  readonly runtimePlanDigest: string;
}

interface GenerationCandidateRow extends pg.QueryResultRow {
  readonly generationId: string;
  readonly state: RuntimeGenerationCandidate["state"];
  readonly runtimePlanDigest: string;
}

interface JobRow extends pg.QueryResultRow {
  readonly jobId: string;
  readonly state: RuntimeMaterializationJobStatus["state"];
  readonly reused: boolean;
}

interface CertificateRow extends pg.QueryResultRow {
  readonly issuer: string;
  readonly certificateId: string;
  readonly projectId: string;
  readonly generationId: string;
  readonly generationDigest: string;
  readonly targetReleaseId: string;
  readonly targetMemberKey: string;
  readonly targetRevisionId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: string;
  readonly snapshotSchemaRevisionId: string;
  readonly snapshotSchemaDigest: string;
  readonly mappingRevisionId: string;
  readonly mappingDigest: string;
  readonly indexPlanDigest: string;
  readonly runtimePlanDigest: string;
  readonly decision: "exact_pin" | "projection_equivalent";
  readonly validatorVersion: string;
  readonly evidenceDigest: string;
  readonly issuedAt: string;
  readonly certificateDigest: string;
}

export interface PostgresRuntimeCompatibilityRepositoryOptions {
  readonly uuidFactory?: () => string;
}

export class PostgresRuntimeCompatibilityRepository implements RuntimeCompatibilityRepository {
  readonly #pool: pg.Pool;
  readonly #uuid: () => string;

  constructor(pool: pg.Pool, options: PostgresRuntimeCompatibilityRepositoryOptions = {}) {
    this.#pool = pool;
    this.#uuid = options.uuidFactory ?? randomUUID;
  }

  async readRefreshTargets(
    input: Parameters<RuntimeCompatibilityRepository["readRefreshTargets"]>[0],
  ): Promise<readonly RuntimeRefreshTargetRelease[]> {
    const command = parseRefreshIdentity(input);
    try {
      const result = await this.#pool.query<RefreshTargetRow>(
        `SELECT release.release_id AS "releaseId",
                release.state AS "releaseState",
                NOT EXISTS (
                  SELECT 1
                  FROM meta.release_runtime_plan_members AS expected
                  WHERE expected.project_id = member.project_id
                    AND expected.release_id = member.release_id
                    AND expected.snapshot_group_id = member.snapshot_group_id
                    AND NOT EXISTS (
                      SELECT 1
                      FROM runtime.snapshot_group_members AS actual
                      WHERE actual.project_id = expected.project_id
                        AND actual.snapshot_group_id = expected.snapshot_group_id
                        AND actual.group_version = $3
                        AND actual.member_key = expected.member_key
                    )
                ) AND NOT EXISTS (
                  SELECT 1
                  FROM runtime.snapshot_group_members AS actual
                  WHERE actual.project_id = member.project_id
                    AND actual.snapshot_group_id = member.snapshot_group_id
                    AND actual.group_version = $3
                    AND NOT EXISTS (
                      SELECT 1
                      FROM meta.release_runtime_plan_members AS expected
                      WHERE expected.project_id = actual.project_id
                        AND expected.release_id = member.release_id
                        AND expected.snapshot_group_id = actual.snapshot_group_id
                        AND expected.member_key = actual.member_key
                    )
                ) AS "snapshotGroupCompatible",
                member.member_key AS "memberKey",
                member.runtime_plan_digest AS "runtimePlanDigest"
         FROM meta.releases AS release
         JOIN meta.release_runtime_plan_members AS member
           ON member.project_id = release.project_id
          AND member.release_id = release.release_id
         WHERE release.project_id = $1::uuid
           AND release.state IN ('staging', 'ready', 'published', 'superseded')
           AND member.snapshot_group_id = $2::uuid
           AND EXISTS (
             SELECT 1
             FROM runtime.snapshot_group_versions AS version
             WHERE version.project_id = release.project_id
               AND version.snapshot_group_id = member.snapshot_group_id
               AND version.group_version = $3
               AND version.state IN (
                 'registered', 'validated', 'materializing', 'ready', 'active'
               )
           )
         ORDER BY release.release_id, member.member_key COLLATE "C"`,
        [command.projectId, command.snapshotGroupId, command.groupVersion],
      );
      const byRelease = new Map<string, RuntimeRefreshTargetRelease>();
      for (const row of result.rows) {
        const member = parseRuntimeRefreshMember({
          memberKey: row.memberKey,
          runtimePlanDigest: row.runtimePlanDigest,
        });
        const prior = byRelease.get(row.releaseId);
        if (prior === undefined) {
          byRelease.set(
            row.releaseId,
            Object.freeze({
              releaseId: parseOntosId(row.releaseId),
              releaseState: row.releaseState,
              snapshotGroupCompatible: row.snapshotGroupCompatible,
              members: Object.freeze([member]),
            }),
          );
        } else {
          byRelease.set(
            row.releaseId,
            Object.freeze({
              ...prior,
              snapshotGroupCompatible: prior.snapshotGroupCompatible && row.snapshotGroupCompatible,
              members: Object.freeze([...prior.members, member]),
            }),
          );
        }
      }
      return Object.freeze([...byRelease.values()]);
    } catch (error) {
      throw mapPostgresRuntimeError(error);
    }
  }

  async ensureMaterializationJob(
    input: Parameters<RuntimeCompatibilityRepository["ensureMaterializationJob"]>[0],
  ): Promise<RuntimeMaterializationJobStatus> {
    const command = parseRefreshIdentity(input);
    try {
      const ensured = await this.#pool.query<JobRow>(
        `SELECT job_id AS "jobId", state, reused
         FROM ops.ensure_runtime_refresh_job($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)`,
        [
          command.projectId,
          parseOntosId(this.#uuid()),
          command.snapshotGroupId,
          command.groupVersion,
          parseOntosId(this.#uuid()),
        ],
      );
      return parseJob(required(ensured.rows[0]));
    } catch (error) {
      throw mapPostgresRuntimeError(error);
    }
  }

  async readGenerationCandidates(
    input: Parameters<RuntimeCompatibilityRepository["readGenerationCandidates"]>[0],
  ): Promise<readonly RuntimeGenerationCandidate[]> {
    const command = parseRefreshMemberIdentity(input);
    try {
      const result = await this.#pool.query<GenerationCandidateRow>(
        `SELECT generation_id AS "generationId", state,
                runtime_plan_digest AS "runtimePlanDigest"
         FROM runtime.generations
         WHERE project_id = $1::uuid AND snapshot_group_id = $2::uuid
           AND group_version = $3 AND member_key = $4
         ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'ready' THEN 1
                            WHEN 'building' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
                  created_at DESC, generation_id`,
        [command.projectId, command.snapshotGroupId, command.groupVersion, command.memberKey],
      );
      return Object.freeze(
        result.rows.map((row) =>
          Object.freeze({
            generationId: parseOntosId(row.generationId),
            state: row.state,
            runtimePlanDigest: parseArtifactDigest(row.runtimePlanDigest),
          }),
        ),
      );
    } catch (error) {
      throw mapPostgresRuntimeError(error);
    }
  }

  async issueCompatibilityCertificate(
    input: Parameters<RuntimeCompatibilityRepository["issueCompatibilityCertificate"]>[0],
  ): Promise<CompatibilityCertificateContract> {
    const command = parseCertificateIdentity(input);
    try {
      const issued = await this.#pool.query<{ readonly certificateId: string }>(
        `SELECT certificate_id AS "certificateId"
         FROM runtime.issue_compatibility_certificate($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        [
          parseOntosId(this.#uuid()),
          command.projectId,
          command.generationId,
          command.targetReleaseId,
        ],
      );
      const certificateId = required(issued.rows[0]).certificateId;
      const result = await this.#pool.query<CertificateRow>(
        `SELECT issuer, certificate_id AS "certificateId", project_id AS "projectId",
                generation_id AS "generationId", generation_digest AS "generationDigest",
                target_release_id AS "targetReleaseId",
                target_member_key AS "targetMemberKey",
                target_revision_id AS "targetRevisionId",
                snapshot_group_id AS "snapshotGroupId", group_version::text AS "groupVersion",
                snapshot_schema_revision_id AS "snapshotSchemaRevisionId",
                snapshot_schema_digest AS "snapshotSchemaDigest",
                mapping_revision_id AS "mappingRevisionId", mapping_digest AS "mappingDigest",
                index_plan_digest AS "indexPlanDigest",
                runtime_plan_digest AS "runtimePlanDigest", decision,
                validator_version AS "validatorVersion", evidence_digest AS "evidenceDigest",
                to_char(issued_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "issuedAt",
                certificate_digest AS "certificateDigest"
         FROM runtime.compatibility_certificates
         WHERE project_id = $1::uuid AND certificate_id = $2::uuid`,
        [command.projectId, certificateId],
      );
      return certificateFromRow(required(result.rows[0]));
    } catch (error) {
      throw mapPostgresRuntimeError(error);
    }
  }
}

function certificateFromRow(row: CertificateRow): CompatibilityCertificateContract {
  return parseCompatibilityCertificate({
    schemaVersion: 1,
    contractVersion: "generation-compatibility-v1",
    issuer: row.issuer,
    certificateId: row.certificateId,
    projectId: row.projectId,
    generationId: row.generationId,
    generationDigest: row.generationDigest,
    targetReleaseId: row.targetReleaseId,
    targetMemberKey: row.targetMemberKey,
    targetRevisionId: row.targetRevisionId,
    snapshotGroupId: row.snapshotGroupId,
    groupVersion: Number(row.groupVersion),
    snapshotSchemaRevisionId: row.snapshotSchemaRevisionId,
    snapshotSchemaDigest: row.snapshotSchemaDigest,
    mappingRevisionId: row.mappingRevisionId,
    mappingDigest: row.mappingDigest,
    indexPlanDigest: row.indexPlanDigest,
    runtimePlanDigest: row.runtimePlanDigest,
    decision: row.decision,
    validatorVersion: row.validatorVersion,
    evidenceDigest: row.evidenceDigest,
    issuedAt: row.issuedAt,
    certificateDigest: row.certificateDigest,
  });
}

function parseRefreshIdentity(input: {
  readonly projectId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
}) {
  try {
    if (!Number.isSafeInteger(input.groupVersion) || input.groupVersion < 1) throw new TypeError();
    return Object.freeze({
      projectId: parseOntosId(input.projectId),
      snapshotGroupId: parseOntosId(input.snapshotGroupId),
      groupVersion: input.groupVersion,
    });
  } catch (cause) {
    throw new RuntimeCompatibilityError("RUNTIME_COMPATIBILITY_INPUT_INVALID", { cause });
  }
}

function parseRefreshMemberIdentity(input: {
  readonly projectId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
  readonly memberKey: string;
}) {
  const refresh = parseRefreshIdentity(input);
  const member = parseRuntimeRefreshMember({
    memberKey: input.memberKey,
    runtimePlanDigest: `sha256:${"0".repeat(64)}`,
  });
  return Object.freeze({ ...refresh, memberKey: member.memberKey });
}

function parseCertificateIdentity(input: {
  readonly projectId: string;
  readonly generationId: string;
  readonly targetReleaseId: string;
}) {
  try {
    return Object.freeze({
      projectId: parseOntosId(input.projectId),
      generationId: parseOntosId(input.generationId),
      targetReleaseId: parseOntosId(input.targetReleaseId),
    });
  } catch (cause) {
    throw new RuntimeCompatibilityError("RUNTIME_COMPATIBILITY_INPUT_INVALID", { cause });
  }
}

function parseJob(row: JobRow): RuntimeMaterializationJobStatus {
  return Object.freeze({
    jobId: parseOntosId(row.jobId),
    state: row.state,
    reused: row.reused,
  });
}

function mapPostgresRuntimeError(error: unknown): RuntimeCompatibilityError {
  if (error instanceof RuntimeCompatibilityError) return error;
  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  const message = typeof candidate.message === "string" ? candidate.message : "";
  if (candidate.code === "40001" || /CAPACITY_INVENTORY_STALE/u.test(message)) {
    return new RuntimeCompatibilityError("RUNTIME_COMPATIBILITY_STALE", { cause: error });
  }
  if (/GENERATION_COMPATIBILITY_INVALID/u.test(message)) {
    return new RuntimeCompatibilityError("RUNTIME_GENERATION_INCOMPATIBLE", { cause: error });
  }
  return new RuntimeCompatibilityError("RUNTIME_COMPATIBILITY_DEPENDENCY_UNAVAILABLE", {
    cause: error,
  });
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new RuntimeCompatibilityError("RUNTIME_COMPATIBILITY_DEPENDENCY_UNAVAILABLE");
  }
  return value;
}
