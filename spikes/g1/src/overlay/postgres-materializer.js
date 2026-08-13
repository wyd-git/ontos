import { executeSql } from "../db/psql.js";
import { invariant } from "../core/kernel-error.js";
import { performance } from "node:perf_hooks";

export function rebuildStagingProjection({
  generationId,
  previousGenerationId,
  watermark,
  refreshStatistics = true,
}) {
  const generation = positiveInteger(generationId, "generationId");
  const previous = positiveInteger(previousGenerationId, "previousGenerationId");
  const overlayWatermark = nonNegativeInteger(watermark, "watermark");

  const prepareStarted = performance.now();
  // A newly loaded generation changes the generation/type correlation sharply.
  // Refresh statistics before PostgreSQL plans the first bulk reconciliation.
  if (refreshStatistics) {
    executeSql("ANALYZE kernel.object_base;");
  }
  const prepareDurationMs = performance.now() - prepareStarted;

  const conflictsStarted = performance.now();
  executeSql(`
    BEGIN;
    SET LOCAL work_mem = '128MB';
    SET LOCAL jit = off;
    SET LOCAL enable_nestloop = off;

    DELETE FROM kernel.object_conflicts
    WHERE generation_id = ${generation};

    WITH detected_conflicts AS MATERIALIZED (
      SELECT *
      FROM kernel.detect_conflicts(${generation}, ${previous}, ${overlayWatermark}, NULL)
    )
    INSERT INTO kernel.object_conflicts (
      generation_id,
      object_type_id,
      object_rid,
      property_name,
      conflict_type,
      basis_snapshot_id,
      basis_value,
      incoming_value,
      overlay_value,
      operation_seq
    )
    SELECT
      ${generation},
      object_type_id,
      object_rid,
      property_name,
      conflict_type,
      basis_snapshot_id,
      basis_value,
      incoming_value,
      overlay_value,
      operation_seq
    FROM detected_conflicts;

    COMMIT;
  `);
  const conflictsDurationMs = performance.now() - conflictsStarted;

  // Staging is not query-visible until the active pointer switches. Keeping the
  // heavyweight projection build in its own idempotent transaction avoids the
  // generic nested plan PostgreSQL selected when conflict and projection writes
  // were combined, and a crash only leaves a rerunnable staging generation.
  const projectionStarted = performance.now();
  executeSql(`
    BEGIN;
    SET LOCAL work_mem = '128MB';
    SET LOCAL jit = off;
    SET LOCAL enable_nestloop = off;

    DELETE FROM kernel.object_current
    WHERE generation_id = ${generation};

    WITH materialized AS MATERIALIZED (
      SELECT *
      FROM kernel.materialized_rows(${generation}, ${previous}, ${overlayWatermark}, NULL)
    ), provenance_rows AS MATERIALIZED (
      SELECT *
      FROM kernel.materialized_provenance(${generation}, ${previous}, ${overlayWatermark}, NULL)
    ), conflict_state AS MATERIALIZED (
      SELECT
        object_type_id,
        object_rid,
        CASE min(
          CASE conflict_type
            WHEN 'IDENTITY_COLLISION' THEN 1
            WHEN 'BASE_OBJECT_REMOVED' THEN 2
            WHEN 'BASE_CHANGED_UNDER_OVERRIDE' THEN 3
          END
        )
          WHEN 1 THEN 'IDENTITY_COLLISION'
          WHEN 2 THEN 'BASE_OBJECT_REMOVED'
          WHEN 3 THEN 'BASE_CHANGED_UNDER_OVERRIDE'
          ELSE NULL
        END AS value
      FROM kernel.object_conflicts
      WHERE generation_id = ${generation}
      GROUP BY object_type_id, object_rid
    )
    INSERT INTO kernel.object_current (
      generation_id,
      object_type_id,
      object_rid,
      primary_key,
      object_version,
      properties,
      lifecycle_state,
      conflict_state,
      provenance
    )
    SELECT
      ${generation},
      materialized.object_type_id,
      materialized.object_rid,
      materialized.primary_key,
      CASE
        WHEN previous.object_rid IS NULL THEN 1
        WHEN previous.properties IS DISTINCT FROM materialized.properties
          OR previous.lifecycle_state IS DISTINCT FROM materialized.lifecycle_state
          OR previous.conflict_state IS DISTINCT FROM conflict_state.value
        THEN previous.object_version + 1
        ELSE previous.object_version
      END,
      materialized.properties,
      materialized.lifecycle_state,
      conflict_state.value,
      provenance_rows.provenance
    FROM materialized
    JOIN provenance_rows
      ON provenance_rows.object_type_id = materialized.object_type_id
     AND provenance_rows.object_rid = materialized.object_rid
    LEFT JOIN kernel.object_current previous
      ON previous.generation_id = ${previous}
     AND previous.object_type_id = materialized.object_type_id
     AND previous.object_rid = materialized.object_rid
    LEFT JOIN conflict_state
      ON conflict_state.object_type_id = materialized.object_type_id
     AND conflict_state.object_rid = materialized.object_rid;

    COMMIT;
  `);
  const projectionDurationMs = performance.now() - projectionStarted;

  const finalizeStarted = performance.now();
  executeSql(`
    BEGIN;
    UPDATE kernel.snapshot_generations
    SET overlay_watermark = ${overlayWatermark}
    WHERE generation_id = ${generation}
      AND status = 'staging';

    DO $verify$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM kernel.snapshot_generations
        WHERE generation_id = ${generation}
          AND status = 'staging'
          AND overlay_watermark = ${overlayWatermark}
      ) THEN
        RAISE EXCEPTION 'Staging generation changed during rebuild';
      END IF;
    END
    $verify$;

    COMMIT;
  `);
  const finalizeDurationMs = performance.now() - finalizeStarted;

  return {
    prepareDurationMs,
    conflictsDurationMs,
    projectionDurationMs,
    finalizeDurationMs,
    totalDurationMs: prepareDurationMs + conflictsDurationMs + projectionDurationMs + finalizeDurationMs,
  };
}

function positiveInteger(value, label) {
  invariant(Number.isSafeInteger(Number(value)) && Number(value) > 0, "INVALID_GENERATION", `${label} must be a positive integer`);
  return Number(value);
}

function nonNegativeInteger(value, label) {
  invariant(Number.isSafeInteger(Number(value)) && Number(value) >= 0, "INVALID_WATERMARK", `${label} must be a non-negative integer`);
  return Number(value);
}
