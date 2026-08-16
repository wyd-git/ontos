import { createHash } from "node:crypto";

import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseObjectTypeDefinition,
  parseOntosId,
  type ArtifactDigest,
  type ObjectTypeDefinition,
  type PropertyDefinition,
} from "@ontos/contracts";
import {
  capacityReportForPersistence,
  definitionForPersistence,
  IndexCapacityApplicationError,
  type CapacityAdmissionSnapshot,
  type IndexPlanAdmissionRepository,
  type PersistAdmittedIndexPlansInput,
  type PersistCapacityAdmissionInput,
  type PersistedIndexPlanReference,
  type ProjectionCapacityAdmissionRepository,
  type IndexCapacityCrypto,
} from "@ontos/materialization-application";
import type {
  CapacityEvaluationInput,
  CompiledIndexDefinition,
  CompiledObjectTypeIndexPlan,
  CompiledReleaseIndexPlan,
  GenerationFootprintInput,
  GenerationReferenceRoot,
  ProjectIndexInventory,
  ReleaseServingSet,
  RetainedIndexPlan,
} from "@ontos/materialization-domain";
import type pg from "pg";

const projectionInventoryAdvisoryNamespace = 737_217_209;
export const PROJECTION_PHYSICAL_SCANNER_VERSION = "g2-02-09-v1";

export interface ProjectPhysicalInventoryMeasurement {
  readonly projectId: string;
  readonly measurementId: string;
  readonly inventoryRevision: bigint;
  readonly heapBytes: bigint;
  readonly indexBytes: bigint;
  readonly toastBytes: bigint;
  readonly totalRelationBytes: bigint;
  readonly relationCount: number;
  readonly measurementDigest: ArtifactDigest;
}

interface InventoryRevisionRow extends pg.QueryResultRow {
  readonly inventoryRevision: string;
  readonly measurementComplete: boolean;
}

interface PersistedPlanEntryRow extends pg.QueryResultRow {
  readonly releaseId: string;
  readonly releasePlanDigest: string;
  readonly indexPlanId: string;
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly planDigest: string;
  readonly compilerVersion: string;
  readonly entryCount: number;
  readonly entryKey: string;
  readonly ordinal: number;
  readonly indexName: string;
  readonly physicalSignature: string;
  readonly definitionDigest: string;
  readonly definition: unknown;
}

interface PlanIdentityRow extends pg.QueryResultRow {
  readonly indexPlanId: string;
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly planDigest: string;
  readonly compilerVersion: string;
  readonly entryCount: number;
}

interface CapacityInventoryRow extends pg.QueryResultRow {
  readonly inventoryRevision: string;
  readonly measurementComplete: boolean;
  readonly totalRelationBytes: string | null;
  readonly measurementDigest: string | null;
}

interface CapacityGenerationRow extends pg.QueryResultRow {
  readonly generationId: string;
  readonly memberKind: "object" | "link";
  readonly resourceId: string;
  readonly state: "building" | "ready" | "active" | "retired" | "failed";
  readonly createdAt: string;
  readonly indexPlanDigest: string;
  readonly planEntryCount: number;
  readonly persistedEntryCount: number;
  readonly secondaryIndexUnits: string;
  readonly objectRows: string | null;
  readonly linkRows: string | null;
  readonly projectedMeasuredBytes: string | null;
  readonly forecastDigest: string | null;
  readonly observedMeasuredBytes: string | null;
}

interface CapacityServingRootRow extends pg.QueryResultRow {
  readonly generationId: string;
  readonly releaseId: string;
  readonly activationId: string;
}

interface CapacityChannelRootRow extends pg.QueryResultRow {
  readonly generationId: string;
  readonly channelName: string;
}

export interface ProjectionCapacitySnapshotLoaderOptions {
  readonly now?: () => number;
}

export class PostgresIndexPlanAdmissionRepository implements IndexPlanAdmissionRepository {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async readIndexInventory(projectIdInput: string): Promise<{
    readonly inventoryRevision: bigint;
    readonly inventory: ProjectIndexInventory;
  }> {
    const projectId = parseOntosId(projectIdInput);
    const client = await this.#pool.connect();
    try {
      const inventory = await client.query<InventoryRevisionRow>(
        `SELECT inventory.inventory_revision::text AS "inventoryRevision",
                inventory.measurement_complete AND NOT EXISTS (
                  SELECT 1 FROM runtime.index_inventory AS physical
                  WHERE physical.project_id = inventory.project_id
                    AND physical.state IN ('planned', 'building', 'failed')
                ) AS "measurementComplete"
         FROM runtime.project_runtime_inventories AS inventory
         WHERE inventory.project_id = $1::uuid`,
        [projectId],
      );
      const row = inventory.rows[0];
      if (row === undefined || inventory.rows.length !== 1) {
        throw new IndexCapacityApplicationError("INDEX_CAPACITY_PROTOCOL_CONFLICT");
      }
      const entries = await client.query<PersistedPlanEntryRow>(
        `WITH latest_admission AS (
           SELECT DISTINCT ON (admission.project_id, admission.release_id, admission.index_plan_id)
                  admission.project_id, admission.release_id, admission.release_plan_digest,
                  admission.index_plan_id
           FROM runtime.index_plan_admissions AS admission
           WHERE admission.project_id = $1::uuid
           ORDER BY admission.project_id, admission.release_id, admission.index_plan_id,
                    admission.inventory_revision DESC
         )
         SELECT admission.release_id AS "releaseId",
                admission.release_plan_digest AS "releasePlanDigest",
                plan.index_plan_id AS "indexPlanId",
                plan.target_resource_id AS "targetResourceId",
                plan.target_revision_id AS "targetRevisionId",
                plan.plan_digest AS "planDigest",
                plan.compiler_version AS "compilerVersion",
                plan.entry_count AS "entryCount",
                entry.entry_key AS "entryKey", entry.ordinal,
                entry.index_name AS "indexName",
                entry.physical_signature AS "physicalSignature",
                entry.definition_digest AS "definitionDigest",
                entry.definition
         FROM latest_admission AS admission
         JOIN runtime.index_plans AS plan
           ON plan.project_id = admission.project_id
          AND plan.index_plan_id = admission.index_plan_id
         LEFT JOIN runtime.index_plan_entries AS entry
           ON entry.project_id = plan.project_id
          AND entry.index_plan_id = plan.index_plan_id
         ORDER BY admission.release_id, plan.index_plan_id, entry.ordinal`,
        [projectId],
      );
      return Object.freeze({
        inventoryRevision: positiveBigInt(row.inventoryRevision),
        inventory: Object.freeze({
          complete: row.measurementComplete,
          retainedPlans: groupRetainedPlans(projectId, entries.rows),
        }),
      });
    } finally {
      client.release();
    }
  }

  async persistAdmittedIndexPlans(
    input: PersistAdmittedIndexPlansInput,
  ): Promise<readonly PersistedIndexPlanReference[]> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
        projectionInventoryAdvisoryNamespace,
        input.projectId,
      ]);
      const revision = await client.query<InventoryRevisionRow>(
        `SELECT inventory.inventory_revision::text AS "inventoryRevision",
                inventory.measurement_complete AND NOT EXISTS (
                  SELECT 1 FROM runtime.index_inventory AS physical
                  WHERE physical.project_id = inventory.project_id
                    AND physical.state IN ('planned', 'building', 'failed')
                ) AS "measurementComplete"
         FROM runtime.project_runtime_inventories AS inventory
         WHERE inventory.project_id = $1::uuid`,
        [input.projectId],
      );
      const current = revision.rows[0];
      if (
        current === undefined ||
        !current.measurementComplete ||
        positiveBigInt(current.inventoryRevision) !== input.inventoryRevision
      ) {
        throw new IndexCapacityApplicationError("INDEX_CAPACITY_PROTOCOL_CONFLICT");
      }

      const persisted: PersistedIndexPlanReference[] = [];
      const release = await client.query<{ readonly state: string }>(
        `SELECT state FROM meta.releases
         WHERE project_id = $1::uuid AND release_id = $2::uuid
           AND state IN ('draft', 'staging', 'ready', 'published')`,
        [input.projectId, input.releaseId],
      );
      if (release.rows.length !== 1) protocolConflict();
      for (const prepared of input.plans) {
        const pin = await client.query<{ readonly content: unknown }>(
          `SELECT revision.content
           FROM meta.release_pins AS pin
           JOIN meta.resources AS resource
             ON resource.resource_id = pin.resource_id
            AND resource.project_id = $1::uuid
            AND resource.family = 'object_type'
           JOIN meta.resource_revisions AS revision
             ON revision.resource_id = pin.resource_id
            AND revision.revision_id = pin.revision_id
            AND revision.family = 'object_type'
            AND revision.state = 'published'
            AND revision.content_digest = pin.content_digest
           WHERE pin.release_id = $2::uuid
             AND pin.resource_id = $3::uuid
             AND pin.revision_id = $4::uuid
             AND pin.family = 'object_type'`,
          [input.projectId, input.releaseId, prepared.plan.resourceId, prepared.plan.revisionId],
        );
        if (pin.rows.length !== 1) protocolConflict();
        assertPlanMatchesPublishedObjectType(prepared.plan, required(pin.rows[0]).content);
        const inserted = await client.query<{ readonly indexPlanId: string }>(
          `INSERT INTO runtime.index_plans (
             project_id, index_plan_id, target_resource_id, target_revision_id,
             plan_digest, entry_count, compiler_version
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7)
           ON CONFLICT (project_id, plan_digest) DO NOTHING
           RETURNING index_plan_id AS "indexPlanId"`,
          [
            input.projectId,
            prepared.indexPlanId,
            prepared.plan.resourceId,
            prepared.plan.revisionId,
            prepared.plan.planDigest,
            prepared.entries.length,
            "g2-02-09-v1",
          ],
        );
        const reused = inserted.rows.length === 0;
        const identity = reused
          ? await loadPlanIdentity(client, input.projectId, prepared.plan.planDigest)
          : {
              indexPlanId: prepared.indexPlanId,
              targetResourceId: prepared.plan.resourceId,
              targetRevisionId: prepared.plan.revisionId,
              planDigest: prepared.plan.planDigest,
              compilerVersion: "g2-02-09-v1",
              entryCount: prepared.entries.length,
            };
        assertPlanIdentity(identity, prepared.plan, prepared.entries.length);

        if (!reused) {
          for (const entry of prepared.entries) {
            await client.query(
              `INSERT INTO runtime.index_plan_entries (
                 project_id, index_plan_id, entry_key, ordinal, recipe,
                 property_api_name, physical_signature, definition_digest,
                 evidence_refs, index_name, unit_cost, definition
               ) VALUES (
                 $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8,
                 $9::jsonb, $10, $11, $12::jsonb
               )`,
              [
                input.projectId,
                identity.indexPlanId,
                entry.entryKey,
                entry.ordinal,
                entry.definition.recipe,
                entry.definition.keys[0]?.propertyId,
                entry.definition.physicalSignature,
                entry.definitionDigest,
                JSON.stringify(entry.definition.evidenceRefs),
                entry.definition.name,
                entry.definition.unitCost,
                JSON.stringify(definitionForPersistence(entry.definition)),
              ],
            );
          }
        } else {
          await assertPersistedEntries(client, input.projectId, identity.indexPlanId, prepared);
        }

        await client.query(
          `INSERT INTO runtime.index_plan_admissions (
             project_id, admission_id, release_id, release_plan_digest,
             index_plan_id, inventory_revision,
             release_units, project_union_units, project_physical_index_count,
             admission_mode, approval_id, approval_expires_at, report_digest
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8, $9, $10,
             $11::uuid, $12::timestamptz, $13
           )
           ON CONFLICT (project_id, release_id, index_plan_id, inventory_revision) DO NOTHING`,
          [
            input.projectId,
            prepared.admissionId,
            input.releaseId,
            input.releasePlanDigest,
            identity.indexPlanId,
            input.inventoryRevision.toString(),
            input.admission.releaseUnits,
            input.admission.projectUnionUnits,
            input.admission.projectPhysicalIndexCount,
            input.admission.admissionMode,
            input.admission.approvalId,
            input.approval === undefined ? null : new Date(input.approval.expiresAt).toISOString(),
            input.reportDigest,
          ],
        );
        const admission = await client.query<{
          readonly releasePlanDigest: string;
          readonly releaseUnits: number;
          readonly projectUnionUnits: number;
          readonly projectPhysicalIndexCount: number;
          readonly admissionMode: string;
          readonly approvalId: string | null;
          readonly approvalExpiresAt: string | null;
          readonly reportDigest: string;
        }>(
          `SELECT release_plan_digest AS "releasePlanDigest",
                  release_units AS "releaseUnits",
                  project_union_units AS "projectUnionUnits",
                  project_physical_index_count AS "projectPhysicalIndexCount",
                  admission_mode AS "admissionMode", approval_id AS "approvalId",
                  CASE WHEN approval_expires_at IS NULL THEN NULL
                       ELSE floor(extract(epoch FROM approval_expires_at) * 1000)::bigint::text
                  END AS "approvalExpiresAt",
                  report_digest AS "reportDigest"
           FROM runtime.index_plan_admissions
           WHERE project_id = $1::uuid AND release_id = $2::uuid
             AND index_plan_id = $3::uuid AND inventory_revision = $4`,
          [
            input.projectId,
            input.releaseId,
            identity.indexPlanId,
            input.inventoryRevision.toString(),
          ],
        );
        const admitted = admission.rows[0];
        if (
          admission.rows.length !== 1 ||
          admitted === undefined ||
          admitted.releasePlanDigest !== input.releasePlanDigest ||
          admitted.releaseUnits !== input.admission.releaseUnits ||
          admitted.projectUnionUnits !== input.admission.projectUnionUnits ||
          admitted.projectPhysicalIndexCount !== input.admission.projectPhysicalIndexCount ||
          admitted.admissionMode !== input.admission.admissionMode ||
          admitted.approvalId !== input.admission.approvalId ||
          admitted.approvalExpiresAt !==
            (input.approval === undefined ? null : input.approval.expiresAt.toString()) ||
          admitted.reportDigest !== input.reportDigest
        ) {
          protocolConflict();
        }
        persisted.push(
          Object.freeze({
            indexPlanId: identity.indexPlanId,
            resourceId: prepared.plan.resourceId,
            revisionId: prepared.plan.revisionId,
            planDigest: prepared.plan.planDigest,
            reused,
          }),
        );
      }
      await client.query("COMMIT");
      return Object.freeze(persisted);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw mapPostgresError(error);
    } finally {
      client.release();
    }
  }
}

export class PostgresProjectionCapacityAdmissionRepository implements ProjectionCapacityAdmissionRepository {
  readonly #pool: pg.Pool;
  readonly #loadSnapshot: (
    input: Parameters<ProjectionCapacityAdmissionRepository["readCapacityAdmissionSnapshot"]>[0],
  ) => Promise<CapacityAdmissionSnapshot>;

  constructor(
    pool: pg.Pool,
    loadSnapshot: (
      input: Parameters<ProjectionCapacityAdmissionRepository["readCapacityAdmissionSnapshot"]>[0],
    ) => Promise<CapacityAdmissionSnapshot> = (input) =>
      loadConservativeProjectionCapacitySnapshot(pool, input),
  ) {
    this.#pool = pool;
    this.#loadSnapshot = loadSnapshot;
  }

  readCapacityAdmissionSnapshot(
    input: Parameters<ProjectionCapacityAdmissionRepository["readCapacityAdmissionSnapshot"]>[0],
  ): Promise<CapacityAdmissionSnapshot> {
    return this.#loadSnapshot(input);
  }

  async persistCapacityAdmission(input: PersistCapacityAdmissionInput): Promise<void> {
    const report = capacityReportForPersistence(input.report);
    try {
      await this.#pool.query(
        `INSERT INTO runtime.capacity_admissions (
           project_id, admission_id, generation_id, phase, inventory_revision,
           index_plan_digest, source_forecast_digest, physical_measurement_digest,
           measured_bytes, observed_project_physical_bytes, reserved_bytes,
           steady_reserved_bytes, peak_reserved_bytes, approval_id, approval_expires_at,
           report, report_digest
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14::uuid, $15::timestamptz, $16::jsonb, $17
         )
         ON CONFLICT (project_id, generation_id, phase, inventory_revision) DO NOTHING`,
        [
          input.projectId,
          input.admissionId,
          input.generationId,
          input.phase,
          input.snapshot.inventoryRevision.toString(),
          input.snapshot.indexPlanDigest,
          input.snapshot.sourceForecastDigest,
          input.snapshot.physicalMeasurementDigest ?? null,
          input.report.measuredBytes.toString(),
          input.report.observedProjectPhysicalBytes.toString(),
          input.report.reservedBytes.toString(),
          input.report.steadyReservedBytes.toString(),
          input.report.peakReservedBytes.toString(),
          input.report.approvalId,
          input.approval === undefined ? null : new Date(input.approval.expiresAt).toISOString(),
          JSON.stringify(report),
          input.reportDigest,
        ],
      );
      const existing = await this.#pool.query<{
        readonly inventoryRevision: string;
        readonly indexPlanDigest: string;
        readonly sourceForecastDigest: string;
        readonly physicalMeasurementDigest: string | null;
        readonly measuredBytes: string;
        readonly observedProjectPhysicalBytes: string;
        readonly reservedBytes: string;
        readonly steadyReservedBytes: string;
        readonly peakReservedBytes: string;
        readonly approvalId: string | null;
        readonly approvalExpiresAt: string | null;
        readonly reportDigest: string;
      }>(
        `SELECT inventory_revision::text AS "inventoryRevision",
                index_plan_digest AS "indexPlanDigest",
                source_forecast_digest AS "sourceForecastDigest",
                physical_measurement_digest AS "physicalMeasurementDigest",
                measured_bytes::text AS "measuredBytes",
                observed_project_physical_bytes::text AS "observedProjectPhysicalBytes",
                reserved_bytes::text AS "reservedBytes",
                steady_reserved_bytes::text AS "steadyReservedBytes",
                peak_reserved_bytes::text AS "peakReservedBytes",
                approval_id AS "approvalId",
                CASE WHEN approval_expires_at IS NULL THEN NULL
                     ELSE floor(extract(epoch FROM approval_expires_at) * 1000)::bigint::text
                END AS "approvalExpiresAt",
                report_digest AS "reportDigest"
         FROM runtime.capacity_admissions
         WHERE project_id = $1::uuid AND generation_id = $2::uuid AND phase = $3
           AND inventory_revision = $4`,
        [
          input.projectId,
          input.generationId,
          input.phase,
          input.snapshot.inventoryRevision.toString(),
        ],
      );
      const persisted = existing.rows[0];
      if (
        existing.rows.length !== 1 ||
        persisted === undefined ||
        persisted.inventoryRevision !== input.snapshot.inventoryRevision.toString() ||
        persisted.indexPlanDigest !== input.snapshot.indexPlanDigest ||
        persisted.sourceForecastDigest !== input.snapshot.sourceForecastDigest ||
        persisted.physicalMeasurementDigest !==
          (input.snapshot.physicalMeasurementDigest ?? null) ||
        persisted.measuredBytes !== input.report.measuredBytes.toString() ||
        persisted.observedProjectPhysicalBytes !==
          input.report.observedProjectPhysicalBytes.toString() ||
        persisted.reservedBytes !== input.report.reservedBytes.toString() ||
        persisted.steadyReservedBytes !== input.report.steadyReservedBytes.toString() ||
        persisted.peakReservedBytes !== input.report.peakReservedBytes.toString() ||
        persisted.approvalId !== input.report.approvalId ||
        persisted.approvalExpiresAt !==
          (input.approval === undefined ? null : input.approval.expiresAt.toString()) ||
        persisted.reportDigest !== input.reportDigest
      ) {
        protocolConflict();
      }
    } catch (error) {
      throw mapPostgresError(error);
    }
  }
}

/**
 * Loads the complete, conservative Project capacity inventory used by the production adapter.
 *
 * The loader intentionally retains every successful Generation, even when no current serving
 * root exists. G2-02-11/12 may classify additional short-lived roots and garbage-collection
 * candidates, but an incomplete root scan must never make G2-02-09 under-count admission bytes.
 */
export async function loadConservativeProjectionCapacitySnapshot(
  pool: pg.Pool,
  input: Parameters<ProjectionCapacityAdmissionRepository["readCapacityAdmissionSnapshot"]>[0],
  options: ProjectionCapacitySnapshotLoaderOptions = {},
): Promise<CapacityAdmissionSnapshot> {
  const projectId = parseOntosId(input.projectId);
  const generationId = parseOntosId(input.generationId, "$capacity.generationId");
  if (input.phase !== "PREBUILD" && input.phase !== "POSTBUILD") protocolConflict();
  const at = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(at) || at < 0) protocolConflict();

  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const projectCount = await client.query<{ readonly count: number }>(
      `SELECT count(DISTINCT project_id)::integer AS count FROM runtime.generations`,
    );
    if ((projectCount.rows[0]?.count ?? 0) > 1) protocolConflict();

    const inventory = await client.query<CapacityInventoryRow>(
      `SELECT inventory.inventory_revision::text AS "inventoryRevision",
              inventory.measurement_complete
                AND measurement.catalog_complete
                AND NOT EXISTS (
                  SELECT 1 FROM runtime.index_inventory AS index_inventory
                  WHERE index_inventory.project_id = inventory.project_id
                    AND index_inventory.state IN ('planned', 'building', 'failed')
                ) AS "measurementComplete",
              measurement.total_relation_bytes::text AS "totalRelationBytes",
              measurement.measurement_digest AS "measurementDigest"
       FROM runtime.project_runtime_inventories AS inventory
       LEFT JOIN runtime.project_physical_measurements AS measurement
         ON measurement.project_id = inventory.project_id
        AND measurement.inventory_revision = inventory.inventory_revision
       WHERE inventory.project_id = $1::uuid`,
      [projectId],
    );
    const inventoryRow = inventory.rows[0];
    if (
      inventory.rows.length !== 1 ||
      inventoryRow === undefined ||
      inventoryRow.totalRelationBytes === null ||
      inventoryRow.measurementDigest === null
    ) {
      protocolConflict();
    }

    const generationResult = await client.query<CapacityGenerationRow>(
      `SELECT generation.generation_id AS "generationId",
              generation.member_kind AS "memberKind",
              generation.target_resource_id AS "resourceId",
              generation.state,
              floor(extract(epoch FROM generation.created_at) * 1000)::bigint::text
                AS "createdAt",
              generation.index_plan_digest AS "indexPlanDigest",
              plan.entry_count AS "planEntryCount",
              entries.entry_count AS "persistedEntryCount",
              entries.secondary_index_units::text AS "secondaryIndexUnits",
              forecast.object_row_count::text AS "objectRows",
              forecast.link_row_count::text AS "linkRows",
              forecast.projected_measured_bytes::text AS "projectedMeasuredBytes",
              forecast.forecast_digest AS "forecastDigest",
              CASE WHEN measurement.measurement_id IS NULL THEN NULL
                   ELSE (measurement.heap_bytes + measurement.fixed_index_bytes
                         + measurement.dynamic_index_bytes)::text
              END AS "observedMeasuredBytes"
       FROM runtime.generations AS generation
       JOIN runtime.index_plans AS plan
         ON plan.project_id = generation.project_id
        AND plan.target_resource_id = generation.target_resource_id
        AND plan.target_revision_id = generation.target_revision_id
        AND plan.plan_digest = generation.index_plan_digest
       LEFT JOIN LATERAL (
         SELECT count(entry.entry_key)::integer AS entry_count,
                COALESCE(sum(entry.unit_cost), 0)::bigint AS secondary_index_units
         FROM runtime.index_plan_entries AS entry
         WHERE entry.project_id = plan.project_id
           AND entry.index_plan_id = plan.index_plan_id
       ) AS entries ON true
       LEFT JOIN runtime.source_forecasts AS forecast
         ON forecast.project_id = generation.project_id
        AND forecast.generation_id = generation.generation_id
       LEFT JOIN runtime.generation_measurements AS measurement
         ON measurement.project_id = generation.project_id
        AND measurement.generation_id = generation.generation_id
       WHERE generation.project_id = $1::uuid
       ORDER BY generation.generation_id`,
      [projectId],
    );
    if (generationResult.rows.length === 0) protocolConflict();

    const servingResult = await client.query<CapacityServingRootRow>(
      `SELECT member.generation_id AS "generationId",
              member.release_id AS "releaseId",
              member.activation_id AS "activationId"
       FROM meta.runtime_activation_members AS member
       JOIN meta.release_serving_heads AS head
         ON head.release_id = member.release_id
        AND head.activation_id = member.activation_id
       WHERE member.project_id = $1::uuid
       ORDER BY member.release_id, member.generation_id`,
      [projectId],
    );
    const channelResult = await client.query<CapacityChannelRootRow>(
      `SELECT member.generation_id AS "generationId",
              channel.channel_name AS "channelName"
       FROM meta.runtime_activation_members AS member
       JOIN meta.release_channels AS channel
         ON channel.project_id = member.project_id
        AND channel.release_id = member.release_id
        AND channel.activation_id = member.activation_id
       WHERE member.project_id = $1::uuid
       ORDER BY channel.channel_name, member.generation_id`,
      [projectId],
    );
    await client.query("COMMIT");

    const rootsByGeneration = new Map<string, GenerationReferenceRoot[]>();
    const generationsByRelease = new Map<string, Set<string>>();
    for (const root of servingResult.rows) {
      const releaseId = parseOntosId(root.releaseId);
      const rootGenerationId = parseOntosId(root.generationId);
      const activationId = parseOntosId(root.activationId);
      appendRoot(rootsByGeneration, rootGenerationId, {
        kind: "SERVING_HEAD",
        id: activationId,
        releaseId,
      });
      const generationIds = generationsByRelease.get(releaseId) ?? new Set<string>();
      generationIds.add(rootGenerationId);
      generationsByRelease.set(releaseId, generationIds);
    }
    for (const root of channelResult.rows) {
      appendRoot(rootsByGeneration, parseOntosId(root.generationId), {
        kind: "CHANNEL",
        id: root.channelName,
      });
    }

    let target: CapacityGenerationRow | undefined;
    const generations: GenerationFootprintInput[] = generationResult.rows.map((row) => {
      if (
        row.objectRows === null ||
        row.linkRows === null ||
        row.projectedMeasuredBytes === null ||
        row.forecastDigest === null ||
        row.planEntryCount !== row.persistedEntryCount
      ) {
        protocolConflict();
      }
      const parsedGenerationId = parseOntosId(row.generationId);
      const objectRows = nonNegativeBigInt(row.objectRows);
      const linkRows = nonNegativeBigInt(row.linkRows);
      const secondaryIndexUnits = nonNegativeBigInt(row.secondaryIndexUnits);
      if (
        (row.memberKind === "object" && linkRows !== 0n) ||
        (row.memberKind === "link" && (objectRows !== 0n || secondaryIndexUnits !== 0n))
      ) {
        protocolConflict();
      }
      parseArtifactDigest(row.indexPlanDigest);
      parseArtifactDigest(row.forecastDigest);
      if (parsedGenerationId === generationId) target = row;
      const successful = row.state === "ready" || row.state === "active" || row.state === "retired";
      return Object.freeze({
        id: parsedGenerationId,
        projectId,
        state: capacityGenerationState(row.state),
        createdAt: safeEpochMilliseconds(row.createdAt),
        leftServingAt: null,
        // Until GC has its complete historical-root scanner, retaining every successful
        // Generation is intentionally conservative and cannot lower admission bytes.
        derivedRecentSuccessful: successful,
        objectTypes:
          row.memberKind === "object"
            ? Object.freeze([
                Object.freeze({
                  resourceId: parseOntosId(row.resourceId),
                  rows: objectRows,
                  secondaryIndexUnitsPerRow: secondaryIndexUnits,
                }),
              ])
            : Object.freeze([]),
        linkRows,
        forecastMeasuredBytes: nonNegativeBigInt(row.projectedMeasuredBytes),
        ...(row.observedMeasuredBytes === null
          ? {}
          : { observedMeasuredBytes: nonNegativeBigInt(row.observedMeasuredBytes) }),
        roots: Object.freeze(
          [...(rootsByGeneration.get(parsedGenerationId) ?? [])].sort((left, right) =>
            `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
          ),
        ),
      });
    });
    if (target === undefined || target.forecastDigest === null) protocolConflict();

    const releaseServingSets: ReleaseServingSet[] = [...generationsByRelease.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([releaseId, generationIds]) =>
        Object.freeze({
          releaseId,
          generationIds: Object.freeze([...generationIds].sort()),
        }),
      );
    const capacityInput: CapacityEvaluationInput = Object.freeze({
      projectId,
      at,
      measurementComplete: inventoryRow.measurementComplete,
      observedProjectPhysicalBytes: nonNegativeBigInt(inventoryRow.totalRelationBytes),
      generations: Object.freeze(generations),
      releaseServingSets: Object.freeze(releaseServingSets),
    });
    return Object.freeze({
      input: capacityInput,
      inventoryRevision: positiveBigInt(inventoryRow.inventoryRevision),
      indexPlanDigest: parseArtifactDigest(target.indexPlanDigest),
      sourceForecastDigest: parseArtifactDigest(target.forecastDigest),
      ...(input.phase === "POSTBUILD"
        ? { physicalMeasurementDigest: parseArtifactDigest(inventoryRow.measurementDigest) }
        : {}),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw mapPostgresError(error);
  } finally {
    client.release();
  }
}

export async function scanAndRecordProjectPhysicalInventory(
  pool: pg.Pool,
  crypto: IndexCapacityCrypto,
  input: { readonly projectId: string; readonly expectedInventoryRevision: bigint },
): Promise<ProjectPhysicalInventoryMeasurement> {
  const projectId = parseOntosId(input.projectId);
  if (input.expectedInventoryRevision < 1n) protocolConflict();
  const measurementId = parseOntosId(crypto.randomId(), "$physicalMeasurementId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
      projectionInventoryAdvisoryNamespace,
      projectId,
    ]);
    const dataProjects = await client.query<{ readonly projectCount: number }>(`
      SELECT count(DISTINCT project_id)::integer AS "projectCount"
      FROM runtime.generations`);
    if ((dataProjects.rows[0]?.projectCount ?? 0) > 1) {
      protocolConflict();
    }
    const catalog = await client.query<{
      readonly indexName: string;
      readonly physicalSignature: string;
      readonly state: string;
      readonly catalogName: string | null;
      readonly valid: boolean | null;
      readonly ready: boolean | null;
      readonly comment: string | null;
    }>(
      `SELECT inventory.index_name AS "indexName",
              inventory.physical_signature AS "physicalSignature", inventory.state,
              index_class.relname AS "catalogName", index_catalog.indisvalid AS valid,
              index_catalog.indisready AS ready,
              obj_description(index_class.oid, 'pg_class') AS comment
       FROM runtime.index_inventory AS inventory
       LEFT JOIN pg_class AS index_class
         ON index_class.relname = inventory.index_name
        AND index_class.relnamespace = to_regnamespace('runtime')
       LEFT JOIN pg_index AS index_catalog ON index_catalog.indexrelid = index_class.oid
       WHERE inventory.project_id = $1::uuid
       ORDER BY inventory.index_name`,
      [projectId],
    );
    if (
      catalog.rows.some(
        (row) =>
          row.state !== "ready" ||
          row.catalogName !== row.indexName ||
          row.valid !== true ||
          row.ready !== true ||
          row.comment !== `${"ontos:index-signature:"}${row.physicalSignature}`,
      )
    ) {
      protocolConflict();
    }
    const untracked = await client.query<{ readonly present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_class AS index_class
         JOIN pg_namespace AS namespace ON namespace.oid = index_class.relnamespace
         WHERE namespace.nspname = 'runtime'
           AND index_class.relkind = 'i'
           AND index_class.relname LIKE 'ok_oc_%'
           AND NOT EXISTS (
             SELECT 1 FROM runtime.index_inventory AS inventory
             WHERE inventory.project_id = $1::uuid
               AND inventory.index_name = index_class.relname
           )
       ) AS present`,
      [projectId],
    );
    if (untracked.rows[0]?.present !== false) protocolConflict();

    const sizes = await client.query<{
      readonly heapBytes: string;
      readonly indexBytes: string;
      readonly toastBytes: string;
      readonly totalRelationBytes: string;
      readonly relationCount: number;
    }>(`
      SELECT COALESCE(sum(pg_relation_size(class.oid)), 0)::text AS "heapBytes",
             COALESCE(sum(pg_indexes_size(class.oid)), 0)::text AS "indexBytes",
             COALESCE(sum(
               pg_total_relation_size(class.oid)
               - pg_relation_size(class.oid)
               - pg_indexes_size(class.oid)
             ), 0)::text AS "toastBytes",
             COALESCE(sum(pg_total_relation_size(class.oid)), 0)::text AS "totalRelationBytes",
             count(*)::integer AS "relationCount"
      FROM pg_class AS class
      JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
      WHERE class.relkind IN ('r', 'p')
        AND (
          namespace.nspname = 'runtime'
          OR (
            namespace.nspname = 'ops'
            AND class.relname IN ('object_base_staging', 'link_base_staging')
          )
        )`);
    const size = required(sizes.rows[0]);
    const measurement = {
      projectId,
      measurementId,
      inventoryRevision: input.expectedInventoryRevision + 1n,
      heapBytes: nonNegativeBigInt(size.heapBytes),
      indexBytes: nonNegativeBigInt(size.indexBytes),
      toastBytes: nonNegativeBigInt(size.toastBytes),
      totalRelationBytes: nonNegativeBigInt(size.totalRelationBytes),
      relationCount: size.relationCount,
    };
    if (
      !Number.isSafeInteger(measurement.relationCount) ||
      measurement.relationCount < 1 ||
      measurement.totalRelationBytes <
        measurement.heapBytes + measurement.indexBytes + measurement.toastBytes
    ) {
      protocolConflict();
    }
    const measurementDigest = parseArtifactDigest(
      crypto.digestCanonicalText(
        canonicalizeContractForDigest({
          schemaVersion: 1,
          contractVersion: "project-physical-measurement-v1",
          scannerVersion: PROJECTION_PHYSICAL_SCANNER_VERSION,
          ...measurement,
          inventoryRevision: measurement.inventoryRevision.toString(),
          heapBytes: measurement.heapBytes.toString(),
          indexBytes: measurement.indexBytes.toString(),
          toastBytes: measurement.toastBytes.toString(),
          totalRelationBytes: measurement.totalRelationBytes.toString(),
        }),
      ),
    );
    const recorded = await client.query<{ readonly inventoryRevision: string }>(
      `SELECT runtime.record_project_physical_measurement(
         $1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10
       )::text AS "inventoryRevision"`,
      [
        projectId,
        input.expectedInventoryRevision.toString(),
        measurementId,
        measurement.heapBytes.toString(),
        measurement.indexBytes.toString(),
        measurement.toastBytes.toString(),
        measurement.totalRelationBytes.toString(),
        measurement.relationCount,
        PROJECTION_PHYSICAL_SCANNER_VERSION,
        measurementDigest,
      ],
    );
    if (
      positiveBigInt(required(recorded.rows[0]).inventoryRevision) !== measurement.inventoryRevision
    ) {
      protocolConflict();
    }
    await client.query("COMMIT");
    return Object.freeze({ ...measurement, measurementDigest });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw mapPostgresError(error);
  } finally {
    client.release();
  }
}

function groupRetainedPlans(
  projectId: string,
  rows: readonly PersistedPlanEntryRow[],
): readonly RetainedIndexPlan[] {
  const releases = new Map<string, PersistedPlanEntryRow[]>();
  for (const row of rows) {
    const group = releases.get(row.releaseId) ?? [];
    group.push(row);
    releases.set(row.releaseId, group);
  }
  return [...releases.entries()].map(([releaseId, releaseRows]) => {
    const release = required(releaseRows[0]);
    if (releaseRows.some((row) => row.releasePlanDigest !== release.releasePlanDigest)) {
      protocolConflict();
    }
    const plans = new Map<string, PersistedPlanEntryRow[]>();
    for (const row of releaseRows) {
      const group = plans.get(row.indexPlanId) ?? [];
      group.push(row);
      plans.set(row.indexPlanId, group);
    }
    const objectTypes = [...plans.values()].map((planRows) => {
      const first = required(planRows[0]);
      const indexes = planRows
        .filter((row) => row.entryKey !== null)
        .map((row) => parsePersistedDefinition(row, first));
      if (indexes.length !== first.entryCount) protocolConflict();
      return Object.freeze({
        resourceId: parseOntosId(first.targetResourceId),
        revisionId: parseOntosId(first.targetRevisionId),
        planDigest: parseArtifactDigest(first.planDigest),
        secondaryIndexUnits: indexes.reduce((sum, entry) => sum + entry.unitCost, 0),
        indexes,
      }) satisfies CompiledObjectTypeIndexPlan;
    });
    const indexes = objectTypes.flatMap((objectType) => objectType.indexes);
    const plan: CompiledReleaseIndexPlan = Object.freeze({
      projectId,
      releaseId: parseOntosId(releaseId),
      planDigest: parseArtifactDigest(release.releasePlanDigest),
      secondaryIndexUnits: objectTypes.reduce(
        (sum, objectType) => sum + objectType.secondaryIndexUnits,
        0,
      ),
      physicalIndexCount: indexes.length,
      objectTypes,
      indexes,
    });
    return Object.freeze({ plan, reasons: Object.freeze(["PROTECTED"] as const) });
  });
}

function parsePersistedDefinition(
  row: PersistedPlanEntryRow,
  plan: PersistedPlanEntryRow,
): CompiledIndexDefinition {
  if (!isRecord(row.definition)) protocolConflict();
  const definition = row.definition as unknown as CompiledIndexDefinition;
  const canonical = canonicalizeContractForDigest(definitionForPersistence(definition));
  const actualDigest = sha256(canonical);
  if (
    row.definitionDigest !== actualDigest ||
    definition.name !== row.indexName ||
    definition.physicalSignature !== row.physicalSignature ||
    definition.resourceId !== plan.targetResourceId ||
    definition.revisionId !== plan.targetRevisionId ||
    definition.table !== "runtime.object_current" ||
    !Array.isArray(definition.keys) ||
    definition.keys.length < 1
  ) {
    protocolConflict();
  }
  parseArtifactDigest(definition.physicalSignature);
  return Object.freeze(definition);
}

function assertPlanMatchesPublishedObjectType(
  plan: CompiledObjectTypeIndexPlan,
  content: unknown,
): void {
  let definition: ObjectTypeDefinition;
  try {
    definition = parseObjectTypeDefinition(content);
  } catch {
    protocolConflict();
  }
  const properties = new Map(definition.properties.map((property) => [property.apiName, property]));
  for (const index of plan.indexes) {
    for (const key of index.keys) {
      const property = properties.get(key.propertyId);
      if (property === undefined || !indexKeyMatchesPublishedProperty(key, property)) {
        protocolConflict();
      }
    }
    const firstKey = required(index.keys[0]);
    const firstProperty = required(properties.get(firstKey.propertyId));
    if (
      (index.recipe === "TRIGRAM_GIN" &&
        (firstProperty.valueType !== "string" || !firstProperty.searchable)) ||
      (index.recipe === "ARRAY_GIN" &&
        (firstProperty.valueType !== "string[]" || !firstProperty.filterable)) ||
      (index.recipe === "UNIQUE_BTREE" && !firstProperty.unique) ||
      (!new Set(["TRIGRAM_GIN", "ARRAY_GIN", "UNIQUE_BTREE"]).has(index.recipe) &&
        !firstProperty.filterable &&
        !firstProperty.sortable)
    ) {
      protocolConflict();
    }
  }
  for (const property of definition.properties) {
    if (property.apiName === definition.primaryKeyPropertyApiName) continue;
    if (
      property.searchable &&
      !plan.indexes.some(
        (index) => index.recipe === "TRIGRAM_GIN" && index.keys[0]?.propertyId === property.apiName,
      )
    ) {
      protocolConflict();
    }
    if (
      property.unique &&
      !plan.indexes.some(
        (index) =>
          index.recipe === "UNIQUE_BTREE" && index.keys[0]?.propertyId === property.apiName,
      )
    ) {
      protocolConflict();
    }
    if (
      property.valueType === "string[]" &&
      property.filterable &&
      !plan.indexes.some(
        (index) => index.recipe === "ARRAY_GIN" && index.keys[0]?.propertyId === property.apiName,
      )
    ) {
      protocolConflict();
    }
    if (property.valueType === "json") {
      for (const path of property.jsonFilterPaths ?? []) {
        if (
          !plan.indexes.some(
            (index) =>
              index.kind === "btree" &&
              index.keys[0]?.propertyId === property.apiName &&
              index.keys[0]?.jsonPath === jsonPathFromPointer(path),
          )
        ) {
          protocolConflict();
        }
      }
      continue;
    }
    if (
      property.valueType !== "string[]" &&
      (property.filterable || property.sortable) &&
      !plan.indexes.some(
        (index) => index.kind === "btree" && index.keys[0]?.propertyId === property.apiName,
      )
    ) {
      protocolConflict();
    }
  }
}

function indexKeyMatchesPublishedProperty(
  key: CompiledIndexDefinition["keys"][number],
  property: PropertyDefinition,
): boolean {
  if (property.valueType === "json") {
    return (
      key.jsonPath !== undefined &&
      (property.jsonFilterPaths ?? []).some((path) => jsonPathFromPointer(path) === key.jsonPath)
    );
  }
  return key.jsonPath === undefined && key.valueType === property.valueType;
}

function jsonPathFromPointer(path: string): string {
  if (!/^\/[A-Za-z][A-Za-z0-9_]*$/u.test(path)) protocolConflict();
  return `$.${path.slice(1)}`;
}

async function loadPlanIdentity(
  client: pg.PoolClient,
  projectId: string,
  planDigest: ArtifactDigest,
): Promise<PlanIdentityRow> {
  const result = await client.query<PlanIdentityRow>(
    `SELECT index_plan_id AS "indexPlanId", target_resource_id AS "targetResourceId",
            target_revision_id AS "targetRevisionId", plan_digest AS "planDigest",
            compiler_version AS "compilerVersion", entry_count AS "entryCount"
     FROM runtime.index_plans
     WHERE project_id = $1::uuid AND plan_digest = $2`,
    [projectId, planDigest],
  );
  if (result.rows.length !== 1) protocolConflict();
  return required(result.rows[0]);
}

function assertPlanIdentity(
  identity: PlanIdentityRow,
  plan: CompiledObjectTypeIndexPlan,
  entryCount: number,
): void {
  if (
    identity.targetResourceId !== plan.resourceId ||
    identity.targetRevisionId !== plan.revisionId ||
    identity.planDigest !== plan.planDigest ||
    identity.compilerVersion !== "g2-02-09-v1" ||
    identity.entryCount !== entryCount
  ) {
    protocolConflict();
  }
}

async function assertPersistedEntries(
  client: pg.PoolClient,
  projectId: string,
  indexPlanId: string,
  prepared: PersistAdmittedIndexPlansInput["plans"][number],
): Promise<void> {
  const result = await client.query<PersistedPlanEntryRow>(
    `SELECT plan.index_plan_id AS "indexPlanId",
            plan.target_resource_id AS "targetResourceId",
            plan.target_revision_id AS "targetRevisionId",
            plan.plan_digest AS "planDigest", plan.compiler_version AS "compilerVersion",
            plan.entry_count AS "entryCount", entry.entry_key AS "entryKey", entry.ordinal,
            entry.index_name AS "indexName", entry.physical_signature AS "physicalSignature",
            entry.definition_digest AS "definitionDigest", entry.definition
     FROM runtime.index_plans AS plan
     JOIN runtime.index_plan_entries AS entry
       ON entry.project_id = plan.project_id AND entry.index_plan_id = plan.index_plan_id
     WHERE plan.project_id = $1::uuid AND plan.index_plan_id = $2::uuid
     ORDER BY entry.ordinal`,
    [projectId, indexPlanId],
  );
  if (result.rows.length !== prepared.entries.length) protocolConflict();
  for (const [ordinal, row] of result.rows.entries()) {
    const expected = prepared.entries[ordinal];
    if (
      expected === undefined ||
      row.entryKey !== expected.entryKey ||
      row.ordinal !== expected.ordinal ||
      row.definitionDigest !== expected.definitionDigest
    ) {
      protocolConflict();
    }
    parsePersistedDefinition(row, row);
  }
}

function sha256(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveBigInt(value: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) protocolConflict();
  return BigInt(value);
}

function nonNegativeBigInt(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) protocolConflict();
  return BigInt(value);
}

function safeEpochMilliseconds(value: string): number {
  const parsed = nonNegativeBigInt(value);
  const result = Number(parsed);
  if (!Number.isSafeInteger(result)) protocolConflict();
  return result;
}

function capacityGenerationState(
  state: CapacityGenerationRow["state"],
): GenerationFootprintInput["state"] {
  if (state === "building") return "STAGING";
  if (state === "failed") return "FAILED_STAGING";
  if (state === "ready" || state === "active" || state === "retired") return "READY";
  protocolConflict();
}

function appendRoot(
  rootsByGeneration: Map<string, GenerationReferenceRoot[]>,
  generationId: string,
  root: GenerationReferenceRoot,
): void {
  const roots = rootsByGeneration.get(generationId) ?? [];
  if (roots.some((candidate) => candidate.kind === root.kind && candidate.id === root.id)) {
    protocolConflict();
  }
  roots.push(Object.freeze(root));
  rootsByGeneration.set(generationId, roots);
}

function protocolConflict(): never {
  throw new IndexCapacityApplicationError("INDEX_CAPACITY_PROTOCOL_CONFLICT");
}

function required<T>(value: T | undefined): T {
  if (value === undefined) protocolConflict();
  return value;
}

function mapPostgresError(error: unknown): IndexCapacityApplicationError {
  if (error instanceof IndexCapacityApplicationError) return error;
  return new IndexCapacityApplicationError("INDEX_CAPACITY_DEPENDENCY_UNAVAILABLE", {
    cause: error,
  });
}
