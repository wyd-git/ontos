import { parseArtifactDigest, parseOntosId, type ArtifactDigest } from "@ontos/contracts";
import type {
  MaterializationAttemptScope,
  ProductionMaterializationFile,
  ProductionMaterializationMember,
  ProductionMaterializationPipelineRepository,
} from "@ontos/materialization-application";
import type pg from "pg";

interface MemberKeyRow extends pg.QueryResultRow {
  readonly memberKey: string;
}

interface BuildMemberRow extends pg.QueryResultRow {
  readonly generationId: string;
  readonly generationState: string;
  readonly qualityState: string | null;
  readonly basePromoted: boolean;
  readonly memberKey: string;
  readonly memberKind: string;
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly targetDefinitionDigest: string;
  readonly targetDefinition: unknown;
  readonly sourceObjectResourceId: string | null;
  readonly sourceObjectRevisionId: string | null;
  readonly sourceObjectDefinitionDigest: string | null;
  readonly sourceObjectDefinition: unknown;
  readonly targetObjectResourceId: string | null;
  readonly targetObjectRevisionId: string | null;
  readonly targetObjectDefinitionDigest: string | null;
  readonly targetObjectDefinition: unknown;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly snapshotContentDigest: string;
  readonly snapshotRowCount: string;
  readonly snapshotByteCount: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: string;
  readonly snapshotGroupKey: string;
  readonly snapshotSchemaResourceId: string;
  readonly snapshotSchemaRevisionId: string;
  readonly snapshotSchemaDigest: string;
  readonly snapshotSchemaDefinition: unknown;
  readonly mappingResourceId: string;
  readonly mappingRevisionId: string;
  readonly mappingDigest: string;
  readonly mappingDefinition: unknown;
  readonly runtimePlanDigest: string;
  readonly indexPlanDigest: string;
  readonly fileId: string;
  readonly fileOrdinal: number;
  readonly objectKey: string;
  readonly objectVersion: string;
  readonly fileContentDigest: string;
  readonly fileByteCount: string;
  readonly fileRowCount: string;
  readonly mediaType: string;
}

interface RevisionRow extends pg.QueryResultRow {
  readonly inventoryRevision: string;
}

interface PresentRow extends pg.QueryResultRow {
  readonly present: boolean;
}

interface DigestRow extends pg.QueryResultRow {
  readonly digest: string;
}

const buildMemberProjection = `
  generation_id AS "generationId",
  generation_state AS "generationState",
  quality_state AS "qualityState",
  base_promoted AS "basePromoted",
  member_key AS "memberKey",
  member_kind AS "memberKind",
  target_resource_id AS "targetResourceId",
  target_revision_id AS "targetRevisionId",
  target_definition_digest AS "targetDefinitionDigest",
  target_definition AS "targetDefinition",
  source_object_resource_id AS "sourceObjectResourceId",
  source_object_revision_id AS "sourceObjectRevisionId",
  source_object_definition_digest AS "sourceObjectDefinitionDigest",
  source_object_definition AS "sourceObjectDefinition",
  target_object_resource_id AS "targetObjectResourceId",
  target_object_revision_id AS "targetObjectRevisionId",
  target_object_definition_digest AS "targetObjectDefinitionDigest",
  target_object_definition AS "targetObjectDefinition",
  snapshot_id AS "snapshotId",
  snapshot_digest AS "snapshotDigest",
  snapshot_content_digest AS "snapshotContentDigest",
  snapshot_row_count::text AS "snapshotRowCount",
  snapshot_byte_count::text AS "snapshotByteCount",
  snapshot_group_id AS "snapshotGroupId",
  group_version::text AS "groupVersion",
  snapshot_group_key AS "snapshotGroupKey",
  snapshot_schema_resource_id AS "snapshotSchemaResourceId",
  snapshot_schema_revision_id AS "snapshotSchemaRevisionId",
  snapshot_schema_digest AS "snapshotSchemaDigest",
  snapshot_schema_definition AS "snapshotSchemaDefinition",
  mapping_resource_id AS "mappingResourceId",
  mapping_revision_id AS "mappingRevisionId",
  mapping_digest AS "mappingDigest",
  mapping_definition AS "mappingDefinition",
  runtime_plan_digest AS "runtimePlanDigest",
  index_plan_digest AS "indexPlanDigest",
  file_id AS "fileId",
  file_ordinal AS "fileOrdinal",
  object_key AS "objectKey",
  object_version AS "objectVersion",
  file_content_digest AS "fileContentDigest",
  file_byte_count::text AS "fileByteCount",
  file_row_count::text AS "fileRowCount",
  media_type AS "mediaType"`;

export class PostgresProductionMaterializationPipelineRepository implements ProductionMaterializationPipelineRepository {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async discoverMemberKeys(scope: MaterializationAttemptScope): Promise<readonly string[]> {
    try {
      const result = await this.#pool.query<MemberKeyRow>(
        `SELECT member_key AS "memberKey"
         FROM ops.discover_materialization_build_member_keys($1, $2, $3, $4)`,
        scopeParameters(scope),
      );
      if (result.rows.length < 1 || result.rows.length > 256) protocolConflict();
      const keys = result.rows.map((row) => row.memberKey);
      if (new Set(keys).size !== keys.length) protocolConflict();
      return Object.freeze(keys);
    } catch (error) {
      throw mapPipelinePostgresError(error);
    }
  }

  async prepareBuild(
    input: Parameters<ProductionMaterializationPipelineRepository["prepareBuild"]>[0],
  ): Promise<readonly ProductionMaterializationMember[]> {
    try {
      const result = await this.#pool.query<BuildMemberRow>(
        `SELECT ${buildMemberProjection}
         FROM ops.prepare_materialization_build($1, $2, $3, $4, $5::jsonb)`,
        [...scopeParameters(input.scope), JSON.stringify(input.candidates)],
      );
      return parseMembers(result.rows);
    } catch (error) {
      throw mapPipelinePostgresError(error);
    }
  }

  async readBuild(
    scope: MaterializationAttemptScope,
  ): Promise<readonly ProductionMaterializationMember[]> {
    try {
      const result = await this.#pool.query<BuildMemberRow>(
        `SELECT ${buildMemberProjection}
         FROM ops.read_materialization_build_members($1, $2, $3, $4)`,
        scopeParameters(scope),
      );
      return parseMembers(result.rows);
    } catch (error) {
      throw mapPipelinePostgresError(error);
    }
  }

  async readCurrentInventoryRevision(projectIdInput: string): Promise<bigint> {
    const projectId = parseOntosId(projectIdInput);
    try {
      const result = await this.#pool.query<RevisionRow>(
        `SELECT inventory_revision::text AS "inventoryRevision"
         FROM runtime.project_runtime_inventories
         WHERE project_id = $1::uuid AND measurement_complete`,
        [projectId],
      );
      if (result.rows.length !== 1) protocolConflict();
      return positiveBigInt(required(result.rows[0]).inventoryRevision);
    } catch (error) {
      throw mapPipelinePostgresError(error);
    }
  }

  async hasCurrentCapacityAdmission(
    input: Parameters<
      ProductionMaterializationPipelineRepository["hasCurrentCapacityAdmission"]
    >[0],
  ): Promise<boolean> {
    try {
      const result = await this.#pool.query<PresentRow>(
        `SELECT ops.has_current_materialization_capacity_admission(
           $1, $2, $3, $4, $5, $6
         ) AS present`,
        [...scopeParameters(input.scope), parseOntosId(input.generationId), input.phase],
      );
      return required(result.rows[0]).present;
    } catch (error) {
      throw mapPipelinePostgresError(error);
    }
  }

  async hasAnyCurrentPostbuildAdmission(
    input: Parameters<
      ProductionMaterializationPipelineRepository["hasAnyCurrentPostbuildAdmission"]
    >[0],
  ): Promise<boolean> {
    if (input.generationIds.length < 1 || input.generationIds.length > 256) protocolConflict();
    const generationIds = input.generationIds.map((value) => parseOntosId(value));
    try {
      const result = await this.#pool.query<PresentRow>(
        `SELECT ops.has_any_current_materialization_postbuild_admission(
           $1, $2, $3, $4, $5
         ) AS present`,
        [...scopeParameters(input.scope), generationIds],
      );
      return required(result.rows[0]).present;
    } catch (error) {
      throw mapPipelinePostgresError(error);
    }
  }

  async verifyIndexInventory(scope: MaterializationAttemptScope): Promise<ArtifactDigest> {
    try {
      const result = await this.#pool.query<DigestRow>(
        `SELECT ops.verify_materialization_index_inventory($1, $2, $3, $4) AS digest`,
        scopeParameters(scope),
      );
      return parseArtifactDigest(required(result.rows[0]).digest);
    } catch (error) {
      throw mapPipelinePostgresError(error);
    }
  }

  async rebindIndexAdmissions(scope: MaterializationAttemptScope): Promise<number> {
    try {
      const result = await this.#pool.query<{ readonly count: number }>(
        `SELECT runtime.rebind_materialization_index_admissions($1, $2, $3, $4) AS count`,
        scopeParameters(scope),
      );
      const count = required(result.rows[0]).count;
      if (!Number.isSafeInteger(count) || count < 0 || count > 256) protocolConflict();
      return count;
    } catch (error) {
      throw mapPipelinePostgresError(error);
    }
  }

  async finishBuild(scope: MaterializationAttemptScope): Promise<ArtifactDigest> {
    try {
      const result = await this.#pool.query<DigestRow>(
        `SELECT ops.finish_materialization_build($1, $2, $3, $4) AS digest`,
        scopeParameters(scope),
      );
      return parseArtifactDigest(required(result.rows[0]).digest);
    } catch (error) {
      throw mapPipelinePostgresError(error);
    }
  }
}

function parseMembers(rows: readonly BuildMemberRow[]): readonly ProductionMaterializationMember[] {
  if (rows.length < 1 || rows.length > 256 * 1_024) protocolConflict();
  const grouped = new Map<
    string,
    { readonly first: BuildMemberRow; readonly files: BuildMemberRow[] }
  >();
  for (const row of rows) {
    const existing = grouped.get(row.generationId);
    if (existing === undefined) grouped.set(row.generationId, { first: row, files: [row] });
    else existing.files.push(row);
  }
  if (grouped.size < 1 || grouped.size > 256) protocolConflict();
  const members = [...grouped.values()].map(({ first, files }) => parseMember(first, files));
  members.sort((left, right) =>
    left.memberKind === right.memberKind
      ? compareText(left.memberKey, right.memberKey)
      : left.memberKind === "object"
        ? -1
        : 1,
  );
  return Object.freeze(members);
}

function parseMember(
  row: BuildMemberRow,
  fileRows: readonly BuildMemberRow[],
): ProductionMaterializationMember {
  const generationId = parseOntosId(row.generationId);
  const memberKind = parseMemberKind(row.memberKind);
  const files = fileRows.map(parseFile).sort((left, right) => left.ordinal - right.ordinal);
  if (
    new Set(files.map((file) => file.ordinal)).size !== files.length ||
    files.some((file, index) => file.ordinal !== index) ||
    fileRows.some((candidate) => !sameMemberRow(row, candidate)) ||
    files.reduce((sum, file) => sum + file.rowCount, 0) !== safeCount(row.snapshotRowCount) ||
    files.reduce((sum, file) => sum + file.byteCount, 0) !== safeCount(row.snapshotByteCount)
  ) {
    protocolConflict();
  }
  const sourceObject = endpoint(
    row.sourceObjectResourceId,
    row.sourceObjectRevisionId,
    row.sourceObjectDefinitionDigest,
    row.sourceObjectDefinition,
  );
  const targetObject = endpoint(
    row.targetObjectResourceId,
    row.targetObjectRevisionId,
    row.targetObjectDefinitionDigest,
    row.targetObjectDefinition,
  );
  if (
    (memberKind === "object" && (sourceObject !== null || targetObject !== null)) ||
    (memberKind === "link" && (sourceObject === null || targetObject === null))
  ) {
    protocolConflict();
  }
  return Object.freeze({
    generationId,
    generationState: parseGenerationState(row.generationState),
    qualityState: parseQualityState(row.qualityState),
    basePromoted: row.basePromoted,
    memberKey: parseMemberKey(row.memberKey, memberKind),
    memberKind,
    targetResourceId: parseOntosId(row.targetResourceId),
    targetRevisionId: parseOntosId(row.targetRevisionId),
    targetDefinitionDigest: parseArtifactDigest(row.targetDefinitionDigest),
    targetDefinition: row.targetDefinition,
    sourceObject,
    targetObject,
    snapshotId: parseOntosId(row.snapshotId),
    snapshotDigest: parseArtifactDigest(row.snapshotDigest),
    snapshotContentDigest: parseArtifactDigest(row.snapshotContentDigest),
    snapshotRowCount: safeCount(row.snapshotRowCount),
    snapshotByteCount: safeCount(row.snapshotByteCount),
    snapshotGroupId: parseOntosId(row.snapshotGroupId),
    groupVersion: positiveCount(row.groupVersion),
    snapshotGroupKey: parseGroupKey(row.snapshotGroupKey),
    snapshotSchemaResourceId: parseOntosId(row.snapshotSchemaResourceId),
    snapshotSchemaRevisionId: parseOntosId(row.snapshotSchemaRevisionId),
    snapshotSchemaDigest: parseArtifactDigest(row.snapshotSchemaDigest),
    snapshotSchemaDefinition: row.snapshotSchemaDefinition,
    mappingResourceId: parseOntosId(row.mappingResourceId),
    mappingRevisionId: parseOntosId(row.mappingRevisionId),
    mappingDigest: parseArtifactDigest(row.mappingDigest),
    mappingDefinition: row.mappingDefinition,
    runtimePlanDigest: parseArtifactDigest(row.runtimePlanDigest),
    indexPlanDigest: parseArtifactDigest(row.indexPlanDigest),
    files: Object.freeze(files),
  });
}

function parseFile(row: BuildMemberRow): ProductionMaterializationFile {
  if (row.mediaType !== "text/csv") protocolConflict();
  if (!Number.isSafeInteger(row.fileOrdinal) || row.fileOrdinal < 0 || row.fileOrdinal > 1_023) {
    protocolConflict();
  }
  if (!/^ingress\/[0-9a-f]{2}\/[0-9a-f-]{36}[.]csv$/u.test(row.objectKey)) protocolConflict();
  if (row.objectVersion.trim().length < 1 || row.objectVersion.length > 1_024) protocolConflict();
  return Object.freeze({
    fileId: parseOntosId(row.fileId),
    ordinal: row.fileOrdinal,
    objectKey: row.objectKey,
    objectVersion: row.objectVersion,
    contentDigest: parseArtifactDigest(row.fileContentDigest),
    byteCount: safeCount(row.fileByteCount),
    rowCount: safeCount(row.fileRowCount),
    mediaType: "text/csv",
  });
}

function endpoint(
  resourceId: string | null,
  revisionId: string | null,
  definitionDigest: string | null,
  definition: unknown,
): ProductionMaterializationMember["sourceObject"] {
  if (
    resourceId === null ||
    revisionId === null ||
    definitionDigest === null ||
    definition === null
  ) {
    if (
      resourceId !== null ||
      revisionId !== null ||
      definitionDigest !== null ||
      definition !== null
    ) {
      protocolConflict();
    }
    return null;
  }
  return Object.freeze({
    resourceId: parseOntosId(resourceId),
    revisionId: parseOntosId(revisionId),
    definitionDigest: parseArtifactDigest(definitionDigest),
    definition,
  });
}

function sameMemberRow(left: BuildMemberRow, right: BuildMemberRow): boolean {
  const ignored = new Set<keyof BuildMemberRow>([
    "fileId",
    "fileOrdinal",
    "objectKey",
    "objectVersion",
    "fileContentDigest",
    "fileByteCount",
    "fileRowCount",
  ]);
  for (const key of Object.keys(left) as (keyof BuildMemberRow)[]) {
    if (!ignored.has(key) && JSON.stringify(left[key]) !== JSON.stringify(right[key])) return false;
  }
  return true;
}

function scopeParameters(scope: MaterializationAttemptScope): unknown[] {
  return [scope.projectId, scope.jobId, scope.attemptId, scope.fencingToken.toString()];
}

function parseMemberKind(value: string): "object" | "link" {
  if (value !== "object" && value !== "link") protocolConflict();
  return value;
}

function parseGenerationState(value: string): "building" | "ready" | "active" {
  if (value !== "building" && value !== "ready" && value !== "active") protocolConflict();
  return value;
}

function parseQualityState(value: string | null): ProductionMaterializationMember["qualityState"] {
  if (
    value !== null &&
    value !== "passed" &&
    value !== "awaiting_confirmation" &&
    value !== "confirmed" &&
    value !== "failed"
  ) {
    protocolConflict();
  }
  return value;
}

function parseMemberKey(value: string, kind: "object" | "link"): string {
  if (
    !/^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$/u.test(value) ||
    !value.startsWith(`${kind}:`)
  ) {
    protocolConflict();
  }
  return value;
}

function parseGroupKey(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value)) protocolConflict();
  return value;
}

function safeCount(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) protocolConflict();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) protocolConflict();
  return parsed;
}

function positiveCount(value: string): number {
  const parsed = safeCount(value);
  if (parsed < 1) protocolConflict();
  return parsed;
}

function positiveBigInt(value: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) protocolConflict();
  return BigInt(value);
}

class PostgresProductionPipelineError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "PostgresProductionPipelineError";
    this.code = code;
  }
}

function mapPipelinePostgresError(error: unknown): PostgresProductionPipelineError {
  if (error instanceof PostgresProductionPipelineError) return error;
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { readonly message: unknown }).message)
      : "";
  const known = [
    "MATERIALIZATION_JOB_FENCED",
    "CAPACITY_INVENTORY_STALE",
    "INDEX_HARD_LIMIT_EXCEEDED",
    "INDEX_PROJECT_BUDGET_EXCEEDED",
    "G20213_BUILD_INPUT_INVALID",
    "G20213_BUILD_INPUT_INCOMPLETE",
    "G20213_INDEX_INVENTORY_INCOMPLETE",
    "G20213_BUILD_NOT_READY",
  ].find((candidate) => message.includes(candidate));
  if (known !== undefined) return new PostgresProductionPipelineError(known, { cause: error });
  const sqlState =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return new PostgresProductionPipelineError(
    typeof sqlState === "string" && /^(?:08|53|57P)/u.test(sqlState)
      ? "DEPENDENCY_UNAVAILABLE"
      : "MATERIALIZATION_PIPELINE_CONFLICT",
    { cause: error },
  );
}

function protocolConflict(): never {
  throw new PostgresProductionPipelineError("MATERIALIZATION_PIPELINE_CONFLICT");
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) protocolConflict();
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
