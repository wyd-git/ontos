import {
  parseArtifactDigest,
  parseCanonicalInstant,
  parseDatasetSnapshot,
  parseSnapshotGroup,
  parseSnapshotSchemaDefinition,
  type DatasetSnapshotContract,
  type SnapshotGroupContract,
} from "@ontos/contracts";
import {
  MaterializationIngressError,
  type FinalizedSnapshotGroupResult,
  type FinalizedSnapshotRegistration,
  type SnapshotUploadSessionRecord,
  type SnapshotUploadSessionRepository,
  type SnapshotUploadSessionState,
} from "@ontos/materialization-application";
import type pg from "pg";

export * from "./base.ts";

interface SessionRow extends pg.QueryResultRow {
  readonly projectId: string;
  readonly sessionId: string;
  readonly createdByPrincipalId: string;
  readonly releaseId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: string;
  readonly groupMemberCount: number;
  readonly memberKey: string;
  readonly memberKind: "object" | "link";
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly snapshotSchemaResourceId: string;
  readonly snapshotSchemaRevisionId: string;
  readonly mappingResourceId: string;
  readonly mappingRevisionId: string;
  readonly indexPlanDigest: string;
  readonly runtimePlanDigest: string;
  readonly managedArtifactId: string;
  readonly objectKey: string;
  readonly allowedMediaType: "text/csv";
  readonly expectedByteCount: string;
  readonly maxByteCount: string;
  readonly sourceLabel: string;
  readonly finalizeTokenDigest: string;
  readonly state: SnapshotUploadSessionState;
  readonly uploadedObjectVersion: string | null;
  readonly uploadedByteCount: string | null;
  readonly finalizeClaimId: string | null;
  readonly finalizeLeaseExpired: boolean;
  readonly snapshotId: string | null;
  readonly expiresAt: Date | string;
  readonly cleanupAfter: Date | string;
  readonly isExpired: boolean;
  readonly schemaContent: unknown;
  readonly previousSnapshotId: string | null;
}

const sessionProjection = `
  session.project_id AS "projectId",
  session.session_id AS "sessionId",
  session.created_by_principal_id AS "createdByPrincipalId",
  session.release_id AS "releaseId",
  session.snapshot_group_id AS "snapshotGroupId",
  session.group_version::text AS "groupVersion",
  session.group_member_count AS "groupMemberCount",
  session.member_key AS "memberKey",
  session.member_kind AS "memberKind",
  session.target_resource_id AS "targetResourceId",
  session.target_revision_id AS "targetRevisionId",
  session.snapshot_schema_resource_id AS "snapshotSchemaResourceId",
  session.snapshot_schema_revision_id AS "snapshotSchemaRevisionId",
  session.mapping_resource_id AS "mappingResourceId",
  session.mapping_revision_id AS "mappingRevisionId",
  session.index_plan_digest AS "indexPlanDigest",
  session.runtime_plan_digest AS "runtimePlanDigest",
  session.managed_artifact_id AS "managedArtifactId",
  session.object_key AS "objectKey",
  session.allowed_media_type AS "allowedMediaType",
  session.expected_byte_count::text AS "expectedByteCount",
  session.max_byte_count::text AS "maxByteCount",
  session.source_label AS "sourceLabel",
  session.finalize_token_digest AS "finalizeTokenDigest",
  session.state,
  session.uploaded_object_version AS "uploadedObjectVersion",
  session.uploaded_byte_count::text AS "uploadedByteCount",
  session.finalize_claim_id AS "finalizeClaimId",
  COALESCE(session.finalize_lease_expires_at <= clock_timestamp(), false)
    AS "finalizeLeaseExpired",
  session.snapshot_id AS "snapshotId",
  session.expires_at AS "expiresAt",
  session.cleanup_after AS "cleanupAfter",
  session.expires_at <= clock_timestamp() AS "isExpired",
  schema_revision.content AS "schemaContent",
  (
    SELECT prior.snapshot_id
    FROM runtime.dataset_snapshots AS prior
    WHERE prior.project_id = session.project_id
      AND prior.snapshot_group_id = session.snapshot_group_id
      AND prior.member_key = session.member_key
      AND prior.group_version < session.group_version
    ORDER BY prior.group_version DESC
    LIMIT 1
  ) AS "previousSnapshotId"`;

const sessionFrom = `
  FROM runtime.snapshot_upload_sessions AS session
  JOIN meta.resource_revisions AS schema_revision
    ON schema_revision.resource_id = session.snapshot_schema_resource_id
   AND schema_revision.revision_id = session.snapshot_schema_revision_id`;

export class PostgresSnapshotUploadSessionRepository implements SnapshotUploadSessionRepository {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async createUploadSession(
    input: Parameters<SnapshotUploadSessionRepository["createUploadSession"]>[0],
  ): Promise<SnapshotUploadSessionRecord> {
    return this.#transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO runtime.snapshot_upload_sessions (
           project_id, session_id, created_by_principal_id, release_id,
           snapshot_group_id, group_version, group_member_count,
           member_key, member_kind, target_resource_id, target_revision_id,
           snapshot_schema_resource_id, snapshot_schema_revision_id,
           mapping_resource_id, mapping_revision_id, index_plan_digest,
           runtime_plan_digest, managed_artifact_id, object_key,
           allowed_media_type, expected_byte_count, max_byte_count,
           source_label, finalize_token_digest, expires_at, cleanup_after
         )
         SELECT member.project_id, $1, $2, member.release_id,
                member.snapshot_group_id, $3,
                (SELECT count(*)::integer
                   FROM meta.release_runtime_plan_members AS grouped
                  WHERE grouped.project_id = member.project_id
                    AND grouped.release_id = member.release_id
                    AND grouped.snapshot_group_id = member.snapshot_group_id),
                member.member_key, member.member_kind,
                member.target_resource_id, member.target_revision_id,
                member.snapshot_schema_resource_id, member.snapshot_schema_revision_id,
                member.mapping_resource_id, member.mapping_revision_id,
                member.index_plan_digest, member.runtime_plan_digest,
                $4, $5, 'text/csv', $6, $7, $8, $9,
                statement_timestamp() + interval '14 minutes 59 seconds',
                statement_timestamp() + interval '24 hours'
           FROM meta.release_runtime_plan_members AS member
           JOIN meta.releases AS release
             ON release.project_id = member.project_id
            AND release.release_id = member.release_id
            AND release.state IN ('ready', 'published')
          WHERE member.project_id = $10 AND member.release_id = $11
            AND member.member_key = $12`,
        [
          input.sessionId,
          input.principalId,
          input.groupVersion,
          input.managedArtifactId,
          input.objectKey,
          input.expectedByteCount,
          input.maxByteCount,
          input.sourceLabel,
          input.finalizeTokenDigest,
          input.projectId,
          input.releaseId,
          input.memberKey,
        ],
      );
      if (inserted.rowCount !== 1) throw inaccessible();
      return this.#readSession(client, "session.session_id = $1", [input.sessionId]);
    });
  }

  async getUploadSession(input: {
    readonly sessionId: string;
    readonly principalId: string;
  }): Promise<SnapshotUploadSessionRecord> {
    return this.#withMappedErrors(() =>
      this.#readSession(
        this.#pool,
        "session.session_id = $1 AND session.created_by_principal_id = $2",
        [input.sessionId, input.principalId],
      ),
    );
  }

  async recordUploadedVersion(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly principalId: string;
    readonly objectVersion: string;
    readonly byteCount: number;
  }): Promise<SnapshotUploadSessionRecord> {
    return this.#transaction(async (client) => {
      const updated = await client.query(
        `UPDATE runtime.snapshot_upload_sessions
            SET state = 'uploaded', uploaded_object_version = $4,
                uploaded_byte_count = $5, changed_at = clock_timestamp()
          WHERE project_id = $1 AND session_id = $2
            AND created_by_principal_id = $3 AND state = 'created'
            AND expires_at > clock_timestamp()`,
        [input.projectId, input.sessionId, input.principalId, input.objectVersion, input.byteCount],
      );
      if (updated.rowCount !== 1) throw conflict();
      return this.#readSession(client, "session.session_id = $1", [input.sessionId]);
    });
  }

  async claimFinalizeGroup(
    input: Parameters<SnapshotUploadSessionRepository["claimFinalizeGroup"]>[0],
  ): Promise<
    | {
        readonly kind: "claimed";
        readonly sessions: readonly SnapshotUploadSessionRecord[];
      }
    | {
        readonly kind: "already_finalized";
        readonly result: FinalizedSnapshotGroupResult;
      }
  > {
    return this.#transaction(async (client) => {
      const ids = input.sessions.map((session) => session.sessionId);
      let rows = await this.#lockSessions(client, ids, input.projectId, input.principalId);
      assertClaimInput(rows, input.sessions);

      if (rows.every((row) => row.state === "finalized")) {
        return Object.freeze({
          kind: "already_finalized" as const,
          result: await loadFinalizedResult(client, rows),
        });
      }
      if (rows.some((row) => row.state === "finalized")) throw conflict();

      const expiredClaims = rows.filter(
        (row) => row.state === "finalizing" && row.finalizeLeaseExpired,
      );
      for (const row of expiredClaims) {
        await client.query(
          `UPDATE runtime.snapshot_upload_sessions
              SET state = 'uploaded', finalize_claim_id = NULL,
                  finalize_lease_expires_at = NULL, changed_at = clock_timestamp()
            WHERE project_id = $1 AND session_id = $2 AND state = 'finalizing'
              AND finalize_lease_expires_at <= clock_timestamp()`,
          [row.projectId, row.sessionId],
        );
      }
      if (expiredClaims.length > 0) {
        rows = await this.#lockSessions(client, ids, input.projectId, input.principalId);
      }
      if (rows.some((row) => row.state === "finalizing")) throw conflict();
      if (rows.some((row) => row.state !== "uploaded" || row.isExpired)) throw conflict();

      assertSameGroup(rows);
      const first = rows[0];
      if (first === undefined) throw inaccessible();
      const expectedMembers = await client.query<{ readonly memberKey: string }>(
        `SELECT member_key AS "memberKey"
           FROM meta.release_runtime_plan_members
          WHERE project_id = $1 AND release_id = $2 AND snapshot_group_id = $3
          ORDER BY member_key COLLATE "C"`,
        [first.projectId, first.releaseId, first.snapshotGroupId],
      );
      const actualKeys = rows.map((row) => row.memberKey).sort(compareText);
      assertSameStrings(
        expectedMembers.rows.map((row) => row.memberKey),
        actualKeys,
      );
      if (rows.length !== first.groupMemberCount) throw conflict();

      const claimed = await client.query(
        `UPDATE runtime.snapshot_upload_sessions
            SET state = 'finalizing', finalize_claim_id = $1,
                finalize_lease_expires_at = clock_timestamp() + interval '4 minutes 59 seconds',
                changed_at = clock_timestamp()
          WHERE project_id = $2 AND session_id = ANY($3::uuid[]) AND state = 'uploaded'`,
        [input.claimId, input.projectId, ids],
      );
      if (claimed.rowCount !== rows.length) throw conflict();
      return Object.freeze({
        kind: "claimed" as const,
        sessions: Object.freeze(rows.map(toSessionRecord)),
      });
    });
  }

  async completeFinalizeGroup(input: {
    readonly claimId: string;
    readonly group: SnapshotGroupContract;
    readonly snapshots: readonly FinalizedSnapshotRegistration[];
  }): Promise<FinalizedSnapshotGroupResult> {
    return this.#transaction(async (client) => {
      const locked = await client.query<SessionRow>(
        `SELECT ${sessionProjection} ${sessionFrom}
          WHERE session.finalize_claim_id = $1 AND session.state = 'finalizing'
          ORDER BY session.member_key COLLATE "C"
          FOR UPDATE OF session`,
        [input.claimId],
      );
      const rows = locked.rows;
      if (rows.length !== input.snapshots.length || rows.length < 1) throw conflict();
      const sessions = rows.map(toSessionRecord);
      assertSameGroup(rows);
      assertGroupMatchesSessions(input.group, sessions);

      await client.query(
        `INSERT INTO runtime.snapshot_group_versions
           (project_id, snapshot_group_id, group_version, member_count,
            state, group_digest, created_at, changed_at)
         VALUES ($1, $2, $3, $4, 'registered', $5, $6, $6)`,
        [
          input.group.projectId,
          input.group.snapshotGroupId,
          input.group.groupVersion,
          input.group.members.length,
          input.group.groupDigest,
          input.group.createdAt,
        ],
      );

      const registrationBySession = new Map(
        input.snapshots.map((registration) => [registration.sessionId, registration] as const),
      );
      for (const session of sessions) {
        const registration = registrationBySession.get(session.sessionId);
        if (registration === undefined) throw conflict();
        assertSnapshotMatchesSession(registration, session);
        const snapshot = registration.snapshot;
        const file = snapshot.files[0];
        if (
          file === undefined ||
          snapshot.files.length !== 1 ||
          file.fileId !== registration.fileId
        ) {
          throw conflict();
        }
        await client.query(
          `INSERT INTO runtime.dataset_snapshots (
             project_id, snapshot_id, snapshot_group_id, group_version,
             member_key, member_kind, target_resource_id, target_revision_id,
             snapshot_schema_resource_id, snapshot_schema_revision_id,
             mapping_resource_id, mapping_revision_id, runtime_plan_digest,
             content_digest, byte_count, row_count, file_count, previous_snapshot_id,
             state, snapshot_digest, registered_at, changed_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, 1, $17, 'registered', $18, $19, $19
           )`,
          [
            snapshot.projectId,
            snapshot.snapshotId,
            snapshot.snapshotGroupId,
            snapshot.groupVersion,
            snapshot.targetMemberKey,
            session.memberKind,
            session.targetResourceId,
            snapshot.targetRevisionId,
            session.snapshotSchemaResourceId,
            snapshot.snapshotSchemaRevisionId,
            session.mappingResourceId,
            snapshot.mappingRevisionId,
            snapshot.runtimePlanDigest,
            snapshot.contentDigest,
            snapshot.byteCount,
            snapshot.rowCount,
            snapshot.previousSnapshotId ?? null,
            snapshot.snapshotDigest,
            snapshot.registeredAt,
          ],
        );
        await client.query(
          `INSERT INTO runtime.snapshot_files (
             project_id, snapshot_id, file_id, managed_artifact_id, object_version,
             ordinal, content_digest, byte_count, row_count, source_label, scan_status
           ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, 'complete')`,
          [
            snapshot.projectId,
            snapshot.snapshotId,
            file.fileId,
            file.managedArtifactId,
            registration.objectVersion,
            file.contentDigest,
            file.byteCount,
            file.rowCount,
            registration.sourceLabel,
          ],
        );
        await client.query(
          `INSERT INTO runtime.snapshot_group_members (
             project_id, snapshot_group_id, group_version, member_key, member_kind,
             snapshot_id, target_resource_id, target_revision_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            input.group.projectId,
            input.group.snapshotGroupId,
            input.group.groupVersion,
            session.memberKey,
            session.memberKind,
            snapshot.snapshotId,
            session.targetResourceId,
            session.targetRevisionId,
          ],
        );
        const finalized = await client.query(
          `UPDATE runtime.snapshot_upload_sessions
              SET state = 'finalized', finalize_claim_id = NULL,
                  finalize_lease_expires_at = NULL, snapshot_id = $3,
                  changed_at = clock_timestamp()
            WHERE project_id = $1 AND session_id = $2
              AND state = 'finalizing' AND finalize_claim_id = $4`,
          [session.projectId, session.sessionId, snapshot.snapshotId, input.claimId],
        );
        if (finalized.rowCount !== 1) throw conflict();
      }
      return Object.freeze({
        group: input.group,
        snapshots: Object.freeze(input.snapshots.map((registration) => registration.snapshot)),
      });
    });
  }

  async renewFinalizeClaim(input: { readonly claimId: string }): Promise<void> {
    await this.#transaction(async (client) => {
      const locked = await client.query<{
        readonly state: SnapshotUploadSessionState;
        readonly leaseActive: boolean;
      }>(
        `SELECT state, finalize_lease_expires_at > clock_timestamp() AS "leaseActive"
           FROM runtime.snapshot_upload_sessions
          WHERE finalize_claim_id = $1
          FOR UPDATE`,
        [input.claimId],
      );
      if (
        locked.rows.length < 1 ||
        locked.rows.some((row) => row.state !== "finalizing" || !row.leaseActive)
      ) {
        throw conflict();
      }
      const renewed = await client.query(
        `UPDATE runtime.snapshot_upload_sessions
            SET finalize_lease_expires_at =
                  clock_timestamp() + interval '4 minutes 59 seconds',
                changed_at = clock_timestamp()
          WHERE finalize_claim_id = $1 AND state = 'finalizing'`,
        [input.claimId],
      );
      if (renewed.rowCount !== locked.rows.length) throw conflict();
    });
  }

  async finishFinalizeFailure(input: {
    readonly claimId: string;
    readonly failedSessionId: string | null;
    readonly failureCode:
      "DEPENDENCY_UNAVAILABLE" | "SNAPSHOT_CONTENT_MISMATCH" | "SNAPSHOT_SCHEMA_INVALID";
    readonly retryable: boolean;
  }): Promise<void> {
    await this.#transaction(async (client) => {
      if (input.retryable) {
        await client.query(
          `UPDATE runtime.snapshot_upload_sessions
              SET state = 'uploaded', finalize_claim_id = NULL,
                  finalize_lease_expires_at = NULL, changed_at = clock_timestamp()
            WHERE finalize_claim_id = $1 AND state = 'finalizing'`,
          [input.claimId],
        );
        return;
      }
      if (input.failedSessionId === null) throw conflict();
      const failed = await client.query(
        `UPDATE runtime.snapshot_upload_sessions
            SET state = 'failed', finalize_claim_id = NULL,
                finalize_lease_expires_at = NULL, failure_code = $3,
                changed_at = clock_timestamp()
          WHERE finalize_claim_id = $1 AND session_id = $2 AND state = 'finalizing'`,
        [input.claimId, input.failedSessionId, input.failureCode],
      );
      if (failed.rowCount !== 1) throw conflict();
      await client.query(
        `UPDATE runtime.snapshot_upload_sessions
            SET state = 'uploaded', finalize_claim_id = NULL,
                finalize_lease_expires_at = NULL, changed_at = clock_timestamp()
          WHERE finalize_claim_id = $1 AND state = 'finalizing'`,
        [input.claimId],
      );
    });
  }

  async listObjectCleanupCandidates(
    limit: number,
  ): Promise<readonly SnapshotUploadSessionRecord[]> {
    return this.#withMappedErrors(async () => {
      const result = await this.#pool.query<SessionRow>(
        `SELECT ${sessionProjection} ${sessionFrom}
          WHERE session.object_cleanup_completed_at IS NULL
            AND (
              session.state = 'finalized'
              OR (session.state IN ('created', 'uploaded', 'failed', 'expired')
                  AND session.cleanup_after <= clock_timestamp())
            )
          ORDER BY
            CASE WHEN session.state = 'finalized' THEN 0 ELSE 1 END,
            session.cleanup_after, session.project_id, session.session_id
          LIMIT $1`,
        [limit],
      );
      return Object.freeze(result.rows.map(toSessionRecord));
    });
  }

  async markObjectCleanupComplete(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly expectedState: SnapshotUploadSessionState;
  }): Promise<void> {
    await this.#transaction(async (client) => {
      if (input.expectedState === "finalized") {
        const result = await client.query(
          `UPDATE runtime.snapshot_upload_sessions
              SET object_cleanup_completed_at = clock_timestamp(),
                  changed_at = clock_timestamp()
            WHERE project_id = $1 AND session_id = $2 AND state = 'finalized'
              AND object_cleanup_completed_at IS NULL`,
          [input.projectId, input.sessionId],
        );
        if (result.rowCount !== 1) throw conflict();
        return;
      }
      if (input.expectedState === "created" || input.expectedState === "uploaded") {
        const expired = await client.query(
          `UPDATE runtime.snapshot_upload_sessions
              SET state = 'expired', failure_code = 'SESSION_EXPIRED',
                  changed_at = clock_timestamp()
            WHERE project_id = $1 AND session_id = $2 AND state = $3
              AND cleanup_after <= clock_timestamp()`,
          [input.projectId, input.sessionId, input.expectedState],
        );
        if (expired.rowCount !== 1) throw conflict();
      } else if (input.expectedState !== "failed" && input.expectedState !== "expired") {
        throw conflict();
      }
      const cleaned = await client.query(
        `UPDATE runtime.snapshot_upload_sessions
            SET state = 'cleaned', object_cleanup_completed_at = clock_timestamp(),
                changed_at = clock_timestamp()
          WHERE project_id = $1 AND session_id = $2 AND state IN ('failed', 'expired')
            AND object_cleanup_completed_at IS NULL`,
        [input.projectId, input.sessionId],
      );
      if (cleaned.rowCount !== 1) throw conflict();
    });
  }

  async #lockSessions(
    client: pg.PoolClient,
    ids: readonly string[],
    projectId: string,
    principalId: string,
  ): Promise<readonly SessionRow[]> {
    const result = await client.query<SessionRow>(
      `SELECT ${sessionProjection} ${sessionFrom}
        WHERE session.session_id = ANY($1::uuid[])
          AND session.project_id = $2 AND session.created_by_principal_id = $3
        ORDER BY session.session_id
        FOR UPDATE OF session`,
      [ids, projectId, principalId],
    );
    return result.rows;
  }

  async #readSession(
    queryable: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
    condition: string,
    parameters: readonly unknown[],
  ): Promise<SnapshotUploadSessionRecord> {
    const result = await queryable.query<SessionRow>(
      `SELECT ${sessionProjection} ${sessionFrom} WHERE ${condition}`,
      [...parameters],
    );
    const row = result.rows[0];
    if (row === undefined || result.rows.length !== 1) throw inaccessible();
    return toSessionRecord(row);
  }

  async #transaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.#withMappedErrors(async () => {
      const client = await this.#pool.connect();
      try {
        await client.query("BEGIN");
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async #withMappedErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapPostgresError(error);
    }
  }
}

function toSessionRecord(row: SessionRow): SnapshotUploadSessionRecord {
  return Object.freeze({
    projectId: row.projectId,
    sessionId: row.sessionId,
    createdByPrincipalId: row.createdByPrincipalId,
    releaseId: row.releaseId,
    snapshotGroupId: row.snapshotGroupId,
    groupVersion: safeCount(row.groupVersion),
    groupMemberCount: row.groupMemberCount,
    memberKey: row.memberKey,
    memberKind: row.memberKind,
    targetResourceId: row.targetResourceId,
    targetRevisionId: row.targetRevisionId,
    snapshotSchemaResourceId: row.snapshotSchemaResourceId,
    snapshotSchemaRevisionId: row.snapshotSchemaRevisionId,
    mappingResourceId: row.mappingResourceId,
    mappingRevisionId: row.mappingRevisionId,
    indexPlanDigest: parseArtifactDigest(row.indexPlanDigest),
    runtimePlanDigest: parseArtifactDigest(row.runtimePlanDigest),
    managedArtifactId: row.managedArtifactId,
    objectKey: row.objectKey,
    allowedMediaType: row.allowedMediaType,
    expectedByteCount: safeCount(row.expectedByteCount),
    maxByteCount: safeCount(row.maxByteCount),
    sourceLabel: row.sourceLabel,
    finalizeTokenDigest: parseArtifactDigest(row.finalizeTokenDigest),
    state: row.state,
    uploadedObjectVersion: row.uploadedObjectVersion,
    uploadedByteCount: row.uploadedByteCount === null ? null : safeCount(row.uploadedByteCount),
    snapshotId: row.snapshotId,
    expiresAt: canonicalInstant(row.expiresAt),
    cleanupAfter: canonicalInstant(row.cleanupAfter),
    snapshotSchema: parseSnapshotSchemaDefinition(row.schemaContent),
    previousSnapshotId: row.previousSnapshotId,
  });
}

function assertClaimInput(
  rows: readonly SessionRow[],
  inputs: readonly { readonly sessionId: string; readonly finalizeTokenDigest: string }[],
): void {
  if (rows.length !== inputs.length || rows.length < 1) throw inaccessible();
  const digestBySession = new Map(
    inputs.map((input) => [input.sessionId, input.finalizeTokenDigest]),
  );
  for (const row of rows) {
    if (digestBySession.get(row.sessionId) !== row.finalizeTokenDigest) throw inaccessible();
  }
}

function assertSameGroup(rows: readonly SessionRow[]): void {
  const first = rows[0];
  if (first === undefined) throw conflict();
  for (const row of rows) {
    if (
      row.projectId !== first.projectId ||
      row.releaseId !== first.releaseId ||
      row.snapshotGroupId !== first.snapshotGroupId ||
      row.groupVersion !== first.groupVersion ||
      row.groupMemberCount !== first.groupMemberCount ||
      row.runtimePlanDigest !== first.runtimePlanDigest
    ) {
      throw conflict();
    }
  }
}

function assertGroupMatchesSessions(
  group: SnapshotGroupContract,
  sessions: readonly SnapshotUploadSessionRecord[],
): void {
  const first = sessions[0];
  if (
    first === undefined ||
    group.projectId !== first.projectId ||
    group.snapshotGroupId !== first.snapshotGroupId ||
    group.groupVersion !== first.groupVersion ||
    group.members.length !== sessions.length
  ) {
    throw conflict();
  }
  assertSameStrings(
    group.members.map((member) => member.memberKey),
    sessions.map((session) => session.memberKey).sort(compareText),
  );
}

function assertSnapshotMatchesSession(
  registration: FinalizedSnapshotRegistration,
  session: SnapshotUploadSessionRecord,
): void {
  const snapshot = registration.snapshot;
  if (
    snapshot.projectId !== session.projectId ||
    snapshot.snapshotGroupId !== session.snapshotGroupId ||
    snapshot.groupVersion !== session.groupVersion ||
    snapshot.targetMemberKey !== session.memberKey ||
    snapshot.targetRevisionId !== session.targetRevisionId ||
    snapshot.snapshotSchemaRevisionId !== session.snapshotSchemaRevisionId ||
    snapshot.mappingRevisionId !== session.mappingRevisionId ||
    snapshot.runtimePlanDigest !== session.runtimePlanDigest ||
    registration.objectVersion !== session.uploadedObjectVersion ||
    registration.sourceLabel !== session.sourceLabel
  ) {
    throw conflict();
  }
}

async function loadFinalizedResult(
  client: pg.PoolClient,
  sessionRows: readonly SessionRow[],
): Promise<FinalizedSnapshotGroupResult> {
  const first = sessionRows[0];
  if (first === undefined || sessionRows.some((row) => row.snapshotId === null)) throw conflict();
  const groupRow = await client.query<{
    readonly state: SnapshotGroupContract["state"];
    readonly groupDigest: string;
    readonly createdAt: Date | string;
  }>(
    `SELECT state, group_digest AS "groupDigest", created_at AS "createdAt"
       FROM runtime.snapshot_group_versions
      WHERE project_id = $1 AND snapshot_group_id = $2 AND group_version = $3`,
    [first.projectId, first.snapshotGroupId, first.groupVersion],
  );
  const groupFact = groupRow.rows[0];
  if (groupFact === undefined) throw conflict();
  const snapshots = await Promise.all(
    sessionRows.map((row) => loadSnapshot(client, row.projectId, row.snapshotId ?? "")),
  );
  snapshots.sort((left, right) => compareText(left.targetMemberKey, right.targetMemberKey));
  const group = parseSnapshotGroup({
    schemaVersion: 1,
    contractVersion: "snapshot-group-v1",
    snapshotGroupId: first.snapshotGroupId,
    projectId: first.projectId,
    groupVersion: safeCount(first.groupVersion),
    state: groupFact.state,
    members: snapshots.map((snapshot) => ({
      memberKey: snapshot.targetMemberKey,
      memberKind: snapshot.targetMemberKey.startsWith("object:") ? "object" : "link",
      snapshotId: snapshot.snapshotId,
      targetRevisionId: snapshot.targetRevisionId,
    })),
    groupDigest: groupFact.groupDigest,
    createdAt: canonicalInstant(groupFact.createdAt),
  });
  return Object.freeze({ group, snapshots: Object.freeze(snapshots) });
}

async function loadSnapshot(
  client: pg.PoolClient,
  projectId: string,
  snapshotId: string,
): Promise<DatasetSnapshotContract> {
  const snapshot = await client.query<{
    readonly snapshotId: string;
    readonly projectId: string;
    readonly snapshotGroupId: string;
    readonly groupVersion: string;
    readonly memberKey: string;
    readonly targetRevisionId: string;
    readonly snapshotSchemaRevisionId: string;
    readonly mappingRevisionId: string;
    readonly runtimePlanDigest: string;
    readonly contentDigest: string;
    readonly byteCount: string;
    readonly rowCount: string;
    readonly previousSnapshotId: string | null;
    readonly state: DatasetSnapshotContract["state"];
    readonly snapshotDigest: string;
    readonly registeredAt: Date | string;
  }>(
    `SELECT snapshot_id AS "snapshotId", project_id AS "projectId",
            snapshot_group_id AS "snapshotGroupId", group_version::text AS "groupVersion",
            member_key AS "memberKey", target_revision_id AS "targetRevisionId",
            snapshot_schema_revision_id AS "snapshotSchemaRevisionId",
            mapping_revision_id AS "mappingRevisionId",
            runtime_plan_digest AS "runtimePlanDigest", content_digest AS "contentDigest",
            byte_count::text AS "byteCount", row_count::text AS "rowCount",
            previous_snapshot_id AS "previousSnapshotId", state,
            snapshot_digest AS "snapshotDigest", registered_at AS "registeredAt"
       FROM runtime.dataset_snapshots
      WHERE project_id = $1 AND snapshot_id = $2`,
    [projectId, snapshotId],
  );
  const fact = snapshot.rows[0];
  if (fact === undefined) throw conflict();
  const files = await client.query<{
    readonly fileId: string;
    readonly managedArtifactId: string;
    readonly ordinal: number;
    readonly contentDigest: string;
    readonly byteCount: string;
    readonly rowCount: string;
  }>(
    `SELECT file_id AS "fileId", managed_artifact_id AS "managedArtifactId",
            ordinal, content_digest AS "contentDigest", byte_count::text AS "byteCount",
            row_count::text AS "rowCount"
       FROM runtime.snapshot_files
      WHERE project_id = $1 AND snapshot_id = $2 ORDER BY ordinal`,
    [projectId, snapshotId],
  );
  return parseDatasetSnapshot({
    schemaVersion: 1,
    contractVersion: "dataset-snapshot-v1",
    snapshotId: fact.snapshotId,
    projectId: fact.projectId,
    snapshotGroupId: fact.snapshotGroupId,
    groupVersion: safeCount(fact.groupVersion),
    targetMemberKey: fact.memberKey,
    targetRevisionId: fact.targetRevisionId,
    snapshotSchemaRevisionId: fact.snapshotSchemaRevisionId,
    mappingRevisionId: fact.mappingRevisionId,
    runtimePlanDigest: fact.runtimePlanDigest,
    contentDigest: fact.contentDigest,
    byteCount: safeCount(fact.byteCount),
    rowCount: safeCount(fact.rowCount),
    files: files.rows.map((file) => ({
      fileId: file.fileId,
      managedArtifactId: file.managedArtifactId,
      ordinal: file.ordinal,
      contentDigest: file.contentDigest,
      byteCount: safeCount(file.byteCount),
      rowCount: safeCount(file.rowCount),
    })),
    ...(fact.previousSnapshotId === null ? {} : { previousSnapshotId: fact.previousSnapshotId }),
    state: fact.state,
    registeredAt: canonicalInstant(fact.registeredAt),
    snapshotDigest: fact.snapshotDigest,
  });
}

function assertSameStrings(expected: readonly string[], actual: readonly string[]): void {
  if (expected.length !== actual.length) throw conflict();
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]) throw conflict();
  }
}

function safeCount(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw dependencyFailure();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw dependencyFailure();
  return result;
}

function canonicalInstant(value: Date | string): ReturnType<typeof parseCanonicalInstant> {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw dependencyFailure();
  return parseCanonicalInstant(date.toISOString().replace(/\.([0-9]{3})Z$/u, ".$1000Z"));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mapPostgresError(error: unknown): MaterializationIngressError {
  if (error instanceof MaterializationIngressError) return error;
  const code = postgresCode(error);
  if (code === "23503") return inaccessible(error);
  if (code === "23505" || code === "40001" || code === "55000") {
    return conflict(error);
  }
  if (code === "22003" || code === "22007" || code === "23514") {
    return new MaterializationIngressError("ADMIN_REQUEST_INVALID", { cause: error });
  }
  return dependencyFailure(error);
}

function postgresCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Readonly<Record<string, unknown>>)["code"];
  return typeof code === "string" ? code : null;
}

function inaccessible(cause?: unknown): MaterializationIngressError {
  return new MaterializationIngressError("OBJECT_NOT_ACCESSIBLE", causeOption(cause));
}

function conflict(cause?: unknown): MaterializationIngressError {
  return new MaterializationIngressError("OBJECT_VERSION_CONFLICT", causeOption(cause));
}

function dependencyFailure(cause?: unknown): MaterializationIngressError {
  return new MaterializationIngressError("DEPENDENCY_UNAVAILABLE", causeOption(cause));
}

function causeOption(cause: unknown): ErrorOptions | undefined {
  return cause === undefined ? undefined : { cause };
}
