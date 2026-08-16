import type {
  GarbageCollectionBatchResult,
  GarbageCollectionDryRunPersistence,
  GarbageCollectionDryRunRecord,
  GarbageCollectionObjectVersion,
  GarbageCollectionRepository,
} from "@ontos/materialization-application";
import type {
  GarbageCollectionAttemptInventory,
  GarbageCollectionGenerationInventory,
  GarbageCollectionHeadSetInventory,
  GarbageCollectionIndexInventory,
  GarbageCollectionInventorySnapshot,
  GarbageCollectionOrphanUploadInventory,
  GarbageCollectionPlanAnalysis,
  GarbageCollectionPlanEntry,
  GarbageCollectionProviderScan,
  GarbageCollectionRoot,
  GarbageCollectionRootCapability,
} from "@ontos/materialization-domain";
import type pg from "pg";

interface InventoryHeaderRow extends pg.QueryResultRow {
  readonly state_revision: string;
  readonly inventory_revision: string;
  readonly measurement_complete: boolean;
  readonly observed_at: Date | string;
}

interface CapabilityRow extends pg.QueryResultRow {
  readonly capability_key: string;
  readonly capability_state: "ACTIVE" | "INACTIVE";
  readonly expected_version: string;
  readonly registry_digest: string;
}

interface ProviderScanRow extends pg.QueryResultRow {
  readonly capability_key: string;
  readonly status: GarbageCollectionProviderScan["status"];
  readonly provider_version: string | null;
  readonly root_count: string;
  readonly root_digest: string | null;
}

interface RootRow extends pg.QueryResultRow {
  readonly generation_id: string;
  readonly root_kind: GarbageCollectionRoot["kind"];
  readonly root_id: string;
  readonly capability_key: string;
  readonly expires_at: Date | string | null;
}

interface GenerationRow extends pg.QueryResultRow {
  readonly generation_id: string;
  readonly member_key: string;
  readonly inventory_state: GarbageCollectionGenerationInventory["state"];
  readonly created_at: Date | string;
  readonly changed_at: Date | string;
  readonly left_serving_at: Date | string | null;
  readonly measured_bytes: string | null;
  readonly index_signatures: unknown;
}

interface HeadSetRow extends pg.QueryResultRow {
  readonly head_set_id: string;
  readonly inventory_state: GarbageCollectionHeadSetInventory["state"];
  readonly created_at: Date | string;
  readonly measured_bytes: string | null;
  readonly generation_ids: unknown;
}

interface IndexRow extends pg.QueryResultRow {
  readonly physical_signature: string;
  readonly index_name: string;
  readonly inventory_state: GarbageCollectionIndexInventory["state"];
  readonly observed_bytes: string | null;
}

interface AttemptRow extends pg.QueryResultRow {
  readonly attempt_id: string;
  readonly inventory_state: GarbageCollectionAttemptInventory["state"];
  readonly finished_at: Date | string | null;
  readonly measured_bytes: string | null;
  readonly generation_ids: unknown;
}

interface OrphanRow extends pg.QueryResultRow {
  readonly session_id: string;
  readonly inventory_state: GarbageCollectionOrphanUploadInventory["state"];
  readonly orphaned_at: Date | string;
  readonly cleanup_after: Date | string;
  readonly measured_bytes: string | null;
  readonly exact_version_known: boolean;
}

interface PersistedRunRow extends pg.QueryResultRow {
  readonly gc_run_id: string;
  readonly gc_plan_id: string | null;
  readonly plan_digest: string | null;
  readonly run_state: string;
  readonly replayed: boolean;
}

interface GcStatusRow extends pg.QueryResultRow {
  readonly project_id: string;
  readonly gc_run_id: string;
  readonly gc_plan_id: string | null;
  readonly run_state: string;
  readonly plan_state: string | null;
  readonly expected_state_revision: string;
  readonly expected_inventory_revision: string;
  readonly provider_registry_digest: string;
  readonly idempotency_key_digest: string;
  readonly observed_at: Date | string;
  readonly blocked_reasons: unknown;
  readonly protected_root_digest: string | null;
  readonly plan_digest: string | null;
  readonly reclaimable_bytes: string | null;
}

interface PlanEntryRow extends pg.QueryResultRow {
  readonly entry_kind: GarbageCollectionPlanEntry["kind"];
  readonly entry_key: string;
  readonly disposition: GarbageCollectionPlanEntry["disposition"];
  readonly reasons: unknown;
  readonly estimated_bytes: string;
  readonly index_impact: unknown;
}

interface OrphanClaimRow extends pg.QueryResultRow {
  readonly session_id: string;
  readonly object_key: string;
  readonly object_version: string;
}

interface CommitRow extends pg.QueryResultRow {
  readonly plan_state: "committing" | "waiting_for_index_ddl" | "committed";
  readonly phase: GarbageCollectionBatchResult["phase"];
  readonly affected_rows: number;
  readonly remaining_candidates: number;
  readonly index_request_ids: readonly string[];
}

export class PostgresGarbageCollectionRepository implements GarbageCollectionRepository {
  readonly #pool: pg.Pool;
  readonly #latestScans = new Map<
    string,
    {
      readonly observedAt: number;
      readonly stateRevision: bigint;
      readonly inventoryRevision: bigint;
      readonly scans: readonly GarbageCollectionProviderScan[];
    }
  >();

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async readInventory(projectId: string): Promise<GarbageCollectionInventorySnapshot> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const header = await client.query<InventoryHeaderRow>(
        `SELECT state_revision::text, inventory_revision::text, measurement_complete,
                    transaction_timestamp() AS observed_at
             FROM ops.runtime_inventory_status WHERE project_id = $1::uuid`,
        [projectId],
      );
      const capabilities = await client.query<CapabilityRow>(
        `SELECT capability_key, capability_state, expected_version, registry_digest
             FROM ops.gc_provider_registry_status ORDER BY capability_key`,
      );
      const scans = await client.query<ProviderScanRow>(
        `SELECT capability_key, status, provider_version,
                    root_count::text, root_digest
             FROM ops.gc_live_provider_scans
             WHERE project_id = $1::uuid ORDER BY capability_key`,
        [projectId],
      );
      const rootRows = await client.query<RootRow>(
        `SELECT generation_id, root_kind, root_id, capability_key, expires_at
             FROM ops.gc_generation_roots
             WHERE project_id = $1::uuid
             ORDER BY generation_id, capability_key, root_kind, root_id`,
        [projectId],
      );
      const generations = await client.query<GenerationRow>(
        `SELECT generation_id, member_key, inventory_state, created_at, changed_at,
                    left_serving_at, measured_bytes::text, index_signatures
             FROM ops.gc_generation_inventory
             WHERE project_id = $1::uuid ORDER BY generation_id`,
        [projectId],
      );
      const headSets = await client.query<HeadSetRow>(
        `SELECT head_set_id, inventory_state, created_at,
                    measured_bytes::text, generation_ids
             FROM ops.gc_head_set_inventory
             WHERE project_id = $1::uuid ORDER BY head_set_id`,
        [projectId],
      );
      const indexes = await client.query<IndexRow>(
        `SELECT physical_signature, index_name, inventory_state, observed_bytes::text
             FROM ops.gc_index_inventory
             WHERE project_id = $1::uuid ORDER BY physical_signature`,
        [projectId],
      );
      const attempts = await client.query<AttemptRow>(
        `SELECT attempt_id, inventory_state, finished_at,
                    measured_bytes::text, generation_ids
             FROM ops.gc_attempt_inventory
             WHERE project_id = $1::uuid ORDER BY attempt_id`,
        [projectId],
      );
      const orphans = await client.query<OrphanRow>(
        `SELECT session_id, inventory_state, orphaned_at, cleanup_after,
                    measured_bytes::text, exact_version_known
             FROM ops.gc_orphan_upload_inventory
             WHERE project_id = $1::uuid ORDER BY session_id`,
        [projectId],
      );
      const inventory = required(header.rows[0], "GC inventory project was not found.");
      const registryDigest = required(
        capabilities.rows[0],
        "GC provider registry is empty.",
      ).registry_digest;
      if (capabilities.rows.some((row) => row.registry_digest !== registryDigest)) {
        throw new Error("GC provider registry digest is inconsistent.");
      }
      const rootsByGeneration = new Map<string, GarbageCollectionRoot[]>();
      for (const row of rootRows.rows) {
        const values = rootsByGeneration.get(row.generation_id) ?? [];
        values.push(
          Object.freeze({
            kind: row.root_kind,
            rootId: row.root_id,
            capabilityKey: row.capability_key,
            ...(row.expires_at === null ? {} : { expiresAt: instant(row.expires_at) }),
          }),
        );
        rootsByGeneration.set(row.generation_id, values);
      }
      const snapshot: GarbageCollectionInventorySnapshot = Object.freeze({
        projectId,
        observedAt: instant(inventory.observed_at),
        stateRevision: BigInt(inventory.state_revision),
        inventoryRevision: BigInt(inventory.inventory_revision),
        measurementComplete: inventory.measurement_complete,
        classificationComplete: true,
        indexInventoryComplete: indexes.rows.every(
          (row) =>
            !["PLANNED", "BUILDING", "FAILED"].includes(row.inventory_state) &&
            (row.inventory_state === "RETIRED" || row.observed_bytes !== null),
        ),
        providerRegistryDigest: registryDigest,
        capabilities: Object.freeze(
          capabilities.rows.map((row): GarbageCollectionRootCapability =>
            Object.freeze({
              capabilityKey: row.capability_key,
              state: row.capability_state,
              expectedVersion: row.expected_version,
            }),
          ),
        ),
        providerScans: Object.freeze(
          scans.rows.map((row): GarbageCollectionProviderScan =>
            Object.freeze({
              capabilityKey: row.capability_key,
              status: row.status,
              providerVersion: row.provider_version,
              rootCount: safeNumber(row.root_count),
              rootDigest: row.root_digest,
            }),
          ),
        ),
        generations: Object.freeze(
          generations.rows.map((row): GarbageCollectionGenerationInventory =>
            Object.freeze({
              generationId: row.generation_id,
              memberKey: row.member_key,
              state: row.inventory_state,
              createdAt: instant(row.created_at),
              changedAt: instant(row.changed_at),
              leftServingAt: row.left_serving_at === null ? null : instant(row.left_serving_at),
              measuredBytes: nullableBigInt(row.measured_bytes),
              indexSignatures: Object.freeze(stringArray(row.index_signatures)),
              roots: Object.freeze(rootsByGeneration.get(row.generation_id) ?? []),
            }),
          ),
        ),
        headSets: Object.freeze(
          headSets.rows.map((row): GarbageCollectionHeadSetInventory =>
            Object.freeze({
              headSetId: row.head_set_id,
              state: row.inventory_state,
              createdAt: instant(row.created_at),
              measuredBytes: nullableBigInt(row.measured_bytes),
              generationIds: Object.freeze(stringArray(row.generation_ids)),
            }),
          ),
        ),
        indexes: Object.freeze(
          indexes.rows.map((row): GarbageCollectionIndexInventory =>
            Object.freeze({
              physicalSignature: row.physical_signature,
              indexName: row.index_name,
              state: row.inventory_state,
              observedBytes: nullableBigInt(row.observed_bytes),
            }),
          ),
        ),
        attempts: Object.freeze(
          attempts.rows.map((row): GarbageCollectionAttemptInventory =>
            Object.freeze({
              attemptId: row.attempt_id,
              state: row.inventory_state,
              finishedAt: row.finished_at === null ? null : instant(row.finished_at),
              measuredBytes: nullableBigInt(row.measured_bytes),
              generationIds: Object.freeze(stringArray(row.generation_ids)),
            }),
          ),
        ),
        orphanUploads: Object.freeze(
          orphans.rows.map((row): GarbageCollectionOrphanUploadInventory =>
            Object.freeze({
              sessionId: row.session_id,
              state: row.inventory_state,
              orphanedAt: instant(row.orphaned_at),
              cleanupAfter: instant(row.cleanup_after),
              measuredBytes: nullableBigInt(row.measured_bytes),
              exactVersionKnown: row.exact_version_known,
            }),
          ),
        ),
      });
      await client.query("COMMIT");
      this.#latestScans.set(projectId, {
        observedAt: snapshot.observedAt,
        stateRevision: snapshot.stateRevision,
        inventoryRevision: snapshot.inventoryRevision,
        scans: snapshot.providerScans,
      });
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw mapGcError(error);
    } finally {
      client.release();
    }
  }

  async persistDryRun(
    input: GarbageCollectionDryRunPersistence,
  ): Promise<GarbageCollectionDryRunRecord> {
    const snapshot = this.#latestScans.get(input.projectId);
    if (
      snapshot === undefined ||
      snapshot.observedAt !== input.analysis.observedAt ||
      snapshot.stateRevision !== input.analysis.stateRevision ||
      snapshot.inventoryRevision !== input.analysis.inventoryRevision
    ) {
      throw new Error("GC inventory binding is missing or stale.");
    }
    return this.persistDryRunWithScans(input, snapshot.scans);
  }

  async claimOrphanUploadBatch(input: {
    readonly projectId: string;
    readonly planId: string;
    readonly batchSize: number;
  }): Promise<readonly GarbageCollectionObjectVersion[]> {
    try {
      const result = await this.#pool.query<OrphanClaimRow>(
        `SELECT session_id, object_key, object_version
         FROM ops.claim_gc_orphan_upload_batch($1::uuid, $2::uuid, $3::integer)`,
        [input.projectId, input.planId, input.batchSize],
      );
      return Object.freeze(
        result.rows.map((row) =>
          Object.freeze({
            sessionId: row.session_id,
            objectKey: row.object_key,
            objectVersion: row.object_version,
          }),
        ),
      );
    } catch (error) {
      throw mapGcError(error);
    }
  }

  async acknowledgeOrphanUpload(input: {
    readonly projectId: string;
    readonly planId: string;
    readonly sessionId: string;
    readonly objectVersion: string;
  }): Promise<void> {
    try {
      await this.#pool.query(
        `SELECT ops.acknowledge_gc_orphan_upload($1::uuid, $2::uuid, $3::uuid, $4::text)`,
        [input.projectId, input.planId, input.sessionId, input.objectVersion],
      );
    } catch (error) {
      throw mapGcError(error);
    }
  }

  async commitNextRelationalBatch(input: {
    readonly projectId: string;
    readonly planId: string;
    readonly batchSize: number;
  }): Promise<GarbageCollectionBatchResult> {
    try {
      const result = await this.#pool.query<CommitRow>(
        `SELECT plan_state, phase, affected_rows, remaining_candidates, index_request_ids
         FROM ops.commit_generation_gc_batch($1::uuid, $2::uuid, $3::integer)`,
        [input.projectId, input.planId, input.batchSize],
      );
      const row = required(result.rows[0], "GC batch did not return a result.");
      return Object.freeze({
        projectId: input.projectId,
        planId: input.planId,
        state:
          row.plan_state === "committed"
            ? "COMMITTED"
            : row.plan_state === "waiting_for_index_ddl"
              ? "WAITING_FOR_INDEX_DDL"
              : "COMMITTING",
        phase: row.phase,
        affectedRows: row.affected_rows,
        remainingCandidates: row.remaining_candidates,
        indexRequestIds: Object.freeze([...row.index_request_ids]),
      });
    } catch (error) {
      throw mapGcError(error);
    }
  }

  async persistDryRunWithScans(
    input: GarbageCollectionDryRunPersistence,
    providerScans: readonly GarbageCollectionProviderScan[],
  ): Promise<GarbageCollectionDryRunRecord> {
    try {
      const persisted = await this.#pool.query<PersistedRunRow>(
        `SELECT gc_run_id, gc_plan_id, plan_digest, run_state, replayed
         FROM ops.persist_generation_gc_dry_run(
           $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
           to_timestamp($7::double precision / 1000.0), $8::bigint, $9::bigint,
           $10::text, $11::jsonb, $12::jsonb, $13::jsonb
         )`,
        [
          input.projectId,
          input.runId,
          input.planId,
          input.idempotencyKeyDigest,
          input.protectedRootDigest,
          input.planDigest,
          input.analysis.observedAt,
          input.analysis.stateRevision.toString(),
          input.analysis.inventoryRevision.toString(),
          input.analysis.providerRegistryDigest,
          JSON.stringify(input.analysis.entries.map(entryForPersistence)),
          JSON.stringify(providerScans),
          JSON.stringify(input.analysis.blockedReasons),
        ],
      );
      return await this.#readPersisted(
        input.projectId,
        required(persisted.rows[0], "GC persistence did not return a result."),
        input.idempotencyKeyDigest,
      );
    } catch (error) {
      throw mapGcError(error);
    }
  }

  async #readPersisted(
    projectId: string,
    persisted: PersistedRunRow,
    expectedIdempotencyDigest: string,
  ): Promise<GarbageCollectionDryRunRecord> {
    const [statusResult, entryResult] = await Promise.all([
      this.#pool.query<GcStatusRow>(
        `SELECT project_id, gc_run_id, gc_plan_id, run_state, plan_state,
                expected_state_revision::text, expected_inventory_revision::text,
                provider_registry_digest, idempotency_key_digest, observed_at,
                blocked_reasons, protected_root_digest, plan_digest,
                reclaimable_bytes::text
         FROM ops.gc_status
         WHERE project_id = $1::uuid AND gc_run_id = $2::uuid`,
        [projectId, persisted.gc_run_id],
      ),
      this.#pool.query<PlanEntryRow>(
        `SELECT entry_kind, entry_key, disposition, reasons,
                estimated_bytes::text, index_impact
         FROM ops.gc_plan_entry_status
         WHERE project_id = $1::uuid AND gc_plan_id = $2::uuid
         ORDER BY entry_kind, entry_key`,
        [projectId, persisted.gc_plan_id],
      ),
    ]);
    const status = required(statusResult.rows[0], "Persisted GC run is missing.");
    if (status.idempotency_key_digest !== expectedIdempotencyDigest) {
      throw new Error("Persisted GC idempotency binding conflicts.");
    }
    const entries = Object.freeze(entryResult.rows.map(planEntry));
    const ready = status.gc_plan_id !== null;
    const analysis: GarbageCollectionPlanAnalysis = Object.freeze({
      status: ready ? "READY" : "BLOCKED",
      projectId: status.project_id,
      observedAt: instant(status.observed_at),
      stateRevision: BigInt(status.expected_state_revision),
      inventoryRevision: BigInt(status.expected_inventory_revision),
      providerRegistryDigest: status.provider_registry_digest,
      entries,
      candidates: Object.freeze(entries.filter((entry) => entry.disposition === "CANDIDATE")),
      retained: Object.freeze(entries.filter((entry) => entry.disposition === "RETAINED")),
      protected: Object.freeze(entries.filter((entry) => entry.disposition === "PROTECTED")),
      reclaimableBytes: BigInt(status.reclaimable_bytes ?? "0"),
      blockedReasons: Object.freeze(stringArray(status.blocked_reasons)),
    });
    return Object.freeze({
      projectId: status.project_id,
      runId: status.gc_run_id,
      planId: status.gc_plan_id,
      idempotencyKeyDigest:
        status.idempotency_key_digest as GarbageCollectionDryRunRecord["idempotencyKeyDigest"],
      protectedRootDigest: required(
        status.protected_root_digest ?? (ready ? undefined : `sha256:${"0".repeat(64)}`),
        "Persisted GC root digest is missing.",
      ) as GarbageCollectionDryRunRecord["protectedRootDigest"],
      planDigest: status.plan_digest as GarbageCollectionDryRunRecord["planDigest"],
      analysis,
      replayed: persisted.replayed,
    });
  }
}

export function createPostgresGarbageCollectionRepository(
  pool: pg.Pool,
): GarbageCollectionRepository {
  return new PostgresGarbageCollectionRepository(pool);
}

function entryForPersistence(entry: GarbageCollectionPlanEntry) {
  return {
    entryKind: entry.kind,
    entryKey: entry.key,
    disposition: entry.disposition,
    reasons: entry.reasons,
    estimatedBytes: entry.estimatedBytes.toString(),
    indexImpact: entry.indexImpact,
  };
}

function planEntry(row: PlanEntryRow): GarbageCollectionPlanEntry {
  return Object.freeze({
    kind: row.entry_kind,
    key: row.entry_key,
    disposition: row.disposition,
    reasons: Object.freeze(stringArray(row.reasons)),
    estimatedBytes: BigInt(row.estimated_bytes),
    indexImpact: Object.freeze(stringArray(row.index_impact)),
  });
}

function nullableBigInt(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function instant(value: Date | string): number {
  const result = new Date(value).getTime();
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("GC timestamp is invalid.");
  return result;
}

function safeNumber(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("GC count is invalid.");
  return result;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("GC JSON array is invalid.");
  }
  return value as string[];
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function mapGcError(error: unknown): Error {
  if (isRecord(error) && typeof error.message === "string") {
    const code = error.message.includes("GC_PLAN_STALE")
      ? "GC_PLAN_STALE"
      : error.message.includes("GC_REFERENCE_SCAN_INCOMPLETE")
        ? "GC_REFERENCE_SCAN_INCOMPLETE"
        : undefined;
    if (code !== undefined) return Object.assign(new Error(code, { cause: error }), { code });
  }
  return error instanceof Error ? error : new Error("GC database operation failed.");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
