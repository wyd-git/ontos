import { mkdir, writeFile } from "node:fs/promises";
import { hostname, platform, release } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { executeSql, queryJson } from "../db/psql.js";
import { rebuildStagingProjection } from "./postgres-materializer.js";

const timestamp = new Date().toISOString().replaceAll(":", "");
const snapshotId = `spike-b-v2-${timestamp.replaceAll(/[^0-9A-Za-z]/g, "")}`;
const failedSnapshotId = `spike-b-failed-${timestamp.replaceAll(/[^0-9A-Za-z]/g, "")}`;
const evidenceDirectory = join("evidence", "raw", `${timestamp}-spike-b`);
await mkdir(evidenceDirectory, { recursive: true });

assertSafeIdentifier(snapshotId);
assertSafeIdentifier(failedSnapshotId);

const setupStarted = performance.now();
const staging = queryJson(`
  BEGIN;

  SELECT kernel.append_set_overlay(
    'EntityA', 'EntityA:000001', 'EA-000001', 'status', '"IN_PROGRESS"'::jsonb,
    'spike-b-action-1', 'actor-test', 1
  );
  SELECT kernel.append_set_overlay(
    'EntityA', 'EntityA:000002', 'EA-000002', 'status', '"IN_PROGRESS"'::jsonb,
    'spike-b-action-2', 'actor-test', 1
  );
  SELECT kernel.append_set_overlay(
    'EntityA', 'EntityA:000003', 'EA-000003', 'status', '"IN_PROGRESS"'::jsonb,
    'spike-b-action-3', 'actor-test', 1
  );
  SELECT kernel.append_create_overlay(
    'EntityA', 'EntityA:999999', 'EA-999999',
    '{"name":"operator-created","status":"IN_PROGRESS","region":"EAST","amount":10,"active":true,"tags":[]}'::jsonb,
    'spike-b-action-4', 'actor-test'
  );

  -- Exercise low-level merge operations. In production, Action validation
  -- decides whether CLEAR_PROPERTY is legal for the declared property schema.
  SELECT kernel.append_set_overlay(
    'EntityA', 'EntityA:000006', 'EA-000006', 'status', '"BLOCKED"'::jsonb,
    'spike-b-action-set-before-remove', 'actor-test', 1
  );
  INSERT INTO kernel.overlay_operations (
    object_type_id, object_rid, primary_key, operation_type, property_name,
    basis_snapshot_id, expected_object_version, action_execution_id, actor_id
  ) SELECT
    'EntityA', 'EntityA:000006', 'EA-000006', 'REMOVE_OVERRIDE', 'status',
    active_snapshot_id, 2, 'spike-b-action-remove-override', 'actor-test'
  FROM kernel.object_type_runtime WHERE object_type_id = 'EntityA';
  UPDATE kernel.object_current current_object
  SET
    properties = jsonb_set(current_object.properties, '{status}', base.properties -> 'status', true),
    object_version = current_object.object_version + 1
  FROM kernel.object_type_runtime runtime
  JOIN kernel.object_base base
    ON base.generation_id = runtime.active_generation_id
   AND base.object_type_id = runtime.object_type_id
   AND base.object_rid = 'EntityA:000006'
  WHERE runtime.object_type_id = 'EntityA'
    AND current_object.generation_id = runtime.active_generation_id
    AND current_object.object_type_id = runtime.object_type_id
    AND current_object.object_rid = base.object_rid;
  UPDATE kernel.object_heads
  SET object_version = object_version + 1
  WHERE object_type_id = 'EntityA' AND object_rid = 'EntityA:000006';

  INSERT INTO kernel.overlay_operations (
    object_type_id, object_rid, primary_key, operation_type, property_name,
    basis_snapshot_id, expected_object_version, action_execution_id, actor_id
  ) SELECT
    'EntityA', 'EntityA:000007', 'EA-000007', 'CLEAR_PROPERTY', 'updatedAt',
    active_snapshot_id, 1, 'spike-b-action-clear', 'actor-test'
  FROM kernel.object_type_runtime WHERE object_type_id = 'EntityA';
  UPDATE kernel.object_current current_object
  SET
    properties = jsonb_set(current_object.properties, '{updatedAt}', 'null'::jsonb, true),
    object_version = current_object.object_version + 1
  FROM kernel.object_type_runtime runtime
  WHERE runtime.object_type_id = 'EntityA'
    AND current_object.generation_id = runtime.active_generation_id
    AND current_object.object_type_id = runtime.object_type_id
    AND current_object.object_rid = 'EntityA:000007';
  UPDATE kernel.object_heads
  SET object_version = object_version + 1
  WHERE object_type_id = 'EntityA' AND object_rid = 'EntityA:000007';

  INSERT INTO kernel.overlay_operations (
    object_type_id, object_rid, primary_key, operation_type,
    basis_snapshot_id, expected_object_version, action_execution_id, actor_id
  ) SELECT
    'EntityA', 'EntityA:000008', 'EA-000008', 'TOMBSTONE_OBJECT',
    active_snapshot_id, 1, 'spike-b-action-tombstone', 'actor-test'
  FROM kernel.object_type_runtime WHERE object_type_id = 'EntityA';
  UPDATE kernel.object_current current_object
  SET lifecycle_state = 'tombstoned', object_version = object_version + 1
  FROM kernel.object_type_runtime runtime
  WHERE runtime.object_type_id = 'EntityA'
    AND current_object.generation_id = runtime.active_generation_id
    AND current_object.object_type_id = runtime.object_type_id
    AND current_object.object_rid = 'EntityA:000008';
  UPDATE kernel.object_heads
  SET lifecycle_state = 'tombstoned', object_version = object_version + 1
  WHERE object_type_id = 'EntityA' AND object_rid = 'EntityA:000008';

  INSERT INTO kernel.overlay_operations (
    object_type_id, object_rid, primary_key, operation_type,
    basis_snapshot_id, expected_object_version, action_execution_id, actor_id
  ) SELECT
    'EntityA', 'EntityA:000009', 'EA-000009', operation_type,
    active_snapshot_id, expected_version, action_execution_id, 'actor-test'
  FROM kernel.object_type_runtime
  CROSS JOIN (VALUES
    ('TOMBSTONE_OBJECT', 1, 'spike-b-action-tombstone-before-restore'),
    ('RESTORE_OBJECT', 2, 'spike-b-action-restore')
  ) operation(operation_type, expected_version, action_execution_id)
  WHERE object_type_id = 'EntityA';
  UPDATE kernel.object_current current_object
  SET lifecycle_state = 'active', object_version = object_version + 2
  FROM kernel.object_type_runtime runtime
  WHERE runtime.object_type_id = 'EntityA'
    AND current_object.generation_id = runtime.active_generation_id
    AND current_object.object_type_id = runtime.object_type_id
    AND current_object.object_rid = 'EntityA:000009';
  UPDATE kernel.object_heads
  SET lifecycle_state = 'active', object_version = object_version + 2
  WHERE object_type_id = 'EntityA' AND object_rid = 'EntityA:000009';

  INSERT INTO kernel.snapshot_generations (
    object_type_id, snapshot_id, status, based_on_generation_id,
    overlay_watermark, content_hash
  )
  SELECT
    'EntityA',
    '${snapshotId}',
    'staging',
    runtime.active_generation_id,
    (SELECT COALESCE(max(operation_seq), 0) FROM kernel.overlay_operations WHERE object_type_id = 'EntityA'),
    'spike-b-content-v2'
  FROM kernel.object_type_runtime runtime
  WHERE runtime.object_type_id = 'EntityA';

  INSERT INTO kernel.object_base (
    generation_id, object_type_id, object_rid, primary_key, properties, source_row_number
  )
  SELECT
    generation.generation_id,
    base.object_type_id,
    base.object_rid,
    base.primary_key,
    CASE base.primary_key
      WHEN 'EA-000001' THEN jsonb_set(base.properties, '{status}', '"CLOSED"'::jsonb)
      WHEN 'EA-000002' THEN jsonb_set(base.properties, '{name}', '"base-v2-renamed"'::jsonb)
      ELSE base.properties
    END,
    base.source_row_number
  FROM kernel.snapshot_generations generation
  JOIN kernel.object_type_runtime runtime
    ON runtime.object_type_id = generation.object_type_id
  JOIN kernel.object_base base
    ON base.generation_id = runtime.active_generation_id
   AND base.object_type_id = generation.object_type_id
  WHERE generation.snapshot_id = '${snapshotId}'
    AND base.primary_key NOT IN ('EA-000003', 'EA-000004');

  INSERT INTO kernel.object_base (
    generation_id, object_type_id, object_rid, primary_key, properties, source_row_number
  )
  SELECT
    generation_id,
    'EntityA',
    'EntityA:999999',
    'EA-999999',
    '{"name":"source-created","status":"OPEN","region":"WEST","amount":20,"active":true,"tags":[]}'::jsonb,
    999999
  FROM kernel.snapshot_generations
  WHERE snapshot_id = '${snapshotId}';

  COMMIT;

  SELECT json_build_array(json_build_object(
    'snapshotId', '${snapshotId}',
    'generationId', (SELECT generation_id FROM kernel.snapshot_generations WHERE snapshot_id = '${snapshotId}'),
    'previousGenerationId', (SELECT active_generation_id FROM kernel.object_type_runtime WHERE object_type_id = 'EntityA'),
    'watermarkW0', (SELECT overlay_watermark FROM kernel.snapshot_generations WHERE snapshot_id = '${snapshotId}')
  ));
`)[0];

const initialMaterialization = rebuildStagingProjection({
  generationId: Number(staging.generationId),
  previousGenerationId: Number(staging.previousGenerationId),
  watermark: Number(staging.watermarkW0),
});

const beforeWorkerFault = stagingFingerprint(Number(staging.generationId));
executeSql(`
  DELETE FROM kernel.object_current
  WHERE generation_id = ${Number(staging.generationId)}
    AND object_type_id = 'EntityA'
    AND object_rid = 'EntityA:000010';
  DELETE FROM kernel.object_conflicts
  WHERE conflict_id = (
    SELECT min(conflict_id) FROM kernel.object_conflicts
    WHERE generation_id = ${Number(staging.generationId)}
  );
`);
const retryMaterialization = rebuildStagingProjection({
  generationId: Number(staging.generationId),
  previousGenerationId: Number(staging.previousGenerationId),
  watermark: Number(staging.watermarkW0),
});
const afterWorkerRecovery = stagingFingerprint(Number(staging.generationId));
const activeBeforeCutover = queryJson(`
  SELECT json_build_array(json_build_object(
    'generationId', active_generation_id,
    'snapshotId', active_snapshot_id,
    'updatedObjectProvenance', (
      SELECT current_object.provenance
      FROM kernel.object_current current_object
      WHERE current_object.generation_id = runtime.active_generation_id
        AND current_object.object_type_id = runtime.object_type_id
        AND current_object.object_rid = 'EntityA:000001'
    ),
    'createdObjectProvenance', (
      SELECT current_object.provenance
      FROM kernel.object_current current_object
      WHERE current_object.generation_id = runtime.active_generation_id
        AND current_object.object_type_id = runtime.object_type_id
        AND current_object.object_rid = 'EntityA:999999'
    )
  ))
  FROM kernel.object_type_runtime runtime
  WHERE runtime.object_type_id = 'EntityA';
`)[0];

const setup = queryJson(`
  SELECT json_build_array(json_build_object(
    'snapshotId', '${snapshotId}',
    'generationId', (SELECT generation_id FROM kernel.snapshot_generations WHERE snapshot_id = '${snapshotId}'),
    'watermarkW0', (SELECT overlay_watermark FROM kernel.snapshot_generations WHERE snapshot_id = '${snapshotId}'),
    'stagedObjects', (SELECT count(*) FROM kernel.object_current current_object JOIN kernel.snapshot_generations generation USING (generation_id) WHERE generation.snapshot_id = '${snapshotId}'),
    'stagedConflicts', (SELECT count(*) FROM kernel.object_conflicts conflict JOIN kernel.snapshot_generations generation USING (generation_id) WHERE generation.snapshot_id = '${snapshotId}')
  ));
`)[0];
const setupDurationMs = performance.now() - setupStarted;

const watermarkW1 = queryJson(`
  SELECT json_build_array(json_build_object(
    'operationSeq', kernel.append_set_overlay(
      'EntityA', 'EntityA:000005', 'EA-000005', 'status', '"BLOCKED"'::jsonb,
      'spike-b-action-during-build', 'actor-test', 1
    )
  ));
`)[0].operationSeq;

const cutoverStarted = performance.now();
queryJson(`
  DO $spike$
  DECLARE target_generation bigint;
  BEGIN
    SELECT generation_id INTO target_generation
    FROM kernel.snapshot_generations
    WHERE snapshot_id = '${snapshotId}';
    CALL kernel.cutover_generation(target_generation);
  END
  $spike$;
  SELECT json_build_array(json_build_object('status', 'cutover-complete'));
`);
const cutoverDurationMs = performance.now() - cutoverStarted;

const observed = queryJson(`
  WITH active AS (
    SELECT active_generation_id, active_snapshot_id
    FROM kernel.object_type_runtime
    WHERE object_type_id = 'EntityA'
  ), selected AS (
    SELECT
      current_object.primary_key,
      current_object.properties,
      current_object.object_version,
      current_object.lifecycle_state,
      current_object.conflict_state,
      current_object.provenance
    FROM kernel.object_current current_object
    JOIN active ON active.active_generation_id = current_object.generation_id
    WHERE current_object.primary_key IN (
      'EA-000001', 'EA-000002', 'EA-000003', 'EA-000004', 'EA-000005',
      'EA-000006', 'EA-000007', 'EA-000008', 'EA-000009', 'EA-999999'
    )
  )
  SELECT json_build_array(json_build_object(
    'activeSnapshotId', (SELECT active_snapshot_id FROM active),
    'activeGenerationId', (SELECT active_generation_id FROM active),
    'overlayWatermark', (
      SELECT generation.overlay_watermark
      FROM kernel.snapshot_generations generation
      JOIN active ON active.active_generation_id = generation.generation_id
    ),
    'objects', COALESCE((
      SELECT json_object_agg(primary_key, json_build_object(
        'name', properties ->> 'name',
        'status', properties ->> 'status',
        'updatedAtCleared', properties -> 'updatedAt' = 'null'::jsonb,
        'version', object_version,
        'lifecycle', lifecycle_state,
        'conflict', conflict_state,
        'provenance', provenance
      ) ORDER BY primary_key)
      FROM selected
    ), '{}'::json),
    'conflicts', COALESCE((
      SELECT json_agg(json_build_object(
        'primaryKey', current_object.primary_key,
        'type', conflict.conflict_type,
        'property', conflict.property_name,
        'basis', conflict.basis_value,
        'incoming', conflict.incoming_value,
        'overlay', conflict.overlay_value
      ) ORDER BY current_object.primary_key, conflict.conflict_type)
      FROM kernel.object_conflicts conflict
      JOIN active ON active.active_generation_id = conflict.generation_id
      JOIN kernel.object_current current_object
        ON current_object.generation_id = conflict.generation_id
       AND current_object.object_type_id = conflict.object_type_id
       AND current_object.object_rid = conflict.object_rid
    ), '[]'::json),
    'overlayCountThroughW1', (
      SELECT count(*) FROM kernel.overlay_operations
      WHERE object_type_id = 'EntityA' AND operation_seq <= ${Number(watermarkW1)}
    )
  ));
`)[0];

const assertions = [];
check("staging worker retry restores identical projection and conflicts", JSON.stringify(beforeWorkerFault) === JSON.stringify(afterWorkerRecovery), { beforeWorkerFault, afterWorkerRecovery });
check("partial staging failure never changed active pointer", Number(activeBeforeCutover.generationId) === Number(staging.previousGenerationId), activeBeforeCutover);
check("immediate property write uses canonical provenance shape", Boolean(activeBeforeCutover.updatedObjectProvenance?.base?.snapshotId) && Number.isSafeInteger(Number(activeBeforeCutover.updatedObjectProvenance?.propertyOverrides?.status?.operationSeq)), activeBeforeCutover.updatedObjectProvenance);
check("immediate object create uses canonical provenance shape", Number.isSafeInteger(Number(activeBeforeCutover.createdObjectProvenance?.overlayCreate?.operationSeq)), activeBeforeCutover.createdObjectProvenance);
check("active snapshot switched", observed.activeSnapshotId === snapshotId, { actual: observed.activeSnapshotId, expected: snapshotId });
check("watermark caught up", Number(observed.overlayWatermark) === Number(watermarkW1), { actual: observed.overlayWatermark, expected: watermarkW1 });
check("same-property overlay retained", observed.objects["EA-000001"]?.status === "IN_PROGRESS", observed.objects["EA-000001"]);
check("same-property conflict recorded", observed.objects["EA-000001"]?.conflict === "BASE_CHANGED_UNDER_OVERRIDE", observed.objects["EA-000001"]);
check("different base field and overlay merged", observed.objects["EA-000002"]?.name === "base-v2-renamed" && observed.objects["EA-000002"]?.status === "IN_PROGRESS", observed.objects["EA-000002"]);
check("removed base with overlay retained", observed.objects["EA-000003"]?.lifecycle === "source_removed" && observed.objects["EA-000003"]?.conflict === "BASE_OBJECT_REMOVED", observed.objects["EA-000003"]);
check("removed clean base disappears", !Object.hasOwn(observed.objects, "EA-000004"), observed.objects["EA-000004"]);
check("operation during staging replayed", observed.objects["EA-000005"]?.status === "BLOCKED", observed.objects["EA-000005"]);
check("remove override exposes incoming base value", observed.objects["EA-000006"]?.status === "IN_PROGRESS" && !Object.hasOwn(observed.objects["EA-000006"]?.provenance?.propertyOverrides ?? {}, "status"), observed.objects["EA-000006"]);
check("clear property remains distinct from remove override", observed.objects["EA-000007"]?.updatedAtCleared === true && observed.objects["EA-000007"]?.provenance?.propertyOverrides?.updatedAt?.operationType === "CLEAR_PROPERTY", observed.objects["EA-000007"]);
check("tombstone survives base refresh", observed.objects["EA-000008"]?.lifecycle === "tombstoned" && observed.objects["EA-000008"]?.provenance?.lifecycleOperation?.operationType === "TOMBSTONE_OBJECT", observed.objects["EA-000008"]);
check("restore reverses the latest tombstone", observed.objects["EA-000009"]?.lifecycle === "active" && observed.objects["EA-000009"]?.provenance?.lifecycleOperation?.operationType === "RESTORE_OBJECT", observed.objects["EA-000009"]);
check("identity collision keeps overlay current", observed.objects["EA-999999"]?.name === "operator-created" && observed.objects["EA-999999"]?.conflict === "IDENTITY_COLLISION", observed.objects["EA-999999"]);
check("expected conflict count", observed.conflicts.length === 3, observed.conflicts);
check("same-property value traces to base and overlay operation", Boolean(observed.objects["EA-000001"]?.provenance?.base?.snapshotId) && Number.isSafeInteger(Number(observed.objects["EA-000001"]?.provenance?.propertyOverrides?.status?.operationSeq)), observed.objects["EA-000001"]?.provenance);
check("catch-up value retains its operation provenance", Number.isSafeInteger(Number(observed.objects["EA-000005"]?.provenance?.propertyOverrides?.status?.operationSeq)), observed.objects["EA-000005"]?.provenance);
check("overlay-created collision retains create provenance", Number.isSafeInteger(Number(observed.objects["EA-999999"]?.provenance?.overlayCreate?.operationSeq)), observed.objects["EA-999999"]?.provenance);

const beforeFault = observed.activeGenerationId;
let injectedFailureObserved = false;
try {
  executeSql(`
    INSERT INTO kernel.snapshot_generations (
      object_type_id, snapshot_id, status, based_on_generation_id, overlay_watermark, content_hash
    ) VALUES (
      'EntityA', '${failedSnapshotId}', 'staging', ${Number(beforeFault)}, ${Number(watermarkW1)}, 'fault-injection'
    );
    BEGIN;
    UPDATE kernel.object_type_runtime
    SET active_generation_id = (
      SELECT generation_id FROM kernel.snapshot_generations WHERE snapshot_id = '${failedSnapshotId}'
    ), active_snapshot_id = '${failedSnapshotId}'
    WHERE object_type_id = 'EntityA';
    DO \$\$ BEGIN RAISE EXCEPTION 'injected cutover failure'; END \$\$;
    COMMIT;
  `);
} catch (error) {
  injectedFailureObserved = error.code === "PSQL_FAILED";
}
const afterFault = queryJson(`
  SELECT json_build_array(json_build_object(
    'generationId', active_generation_id,
    'snapshotId', active_snapshot_id
  ))
  FROM kernel.object_type_runtime
  WHERE object_type_id = 'EntityA';
`)[0];
check("fault injection raised", injectedFailureObserved, { injectedFailureObserved });
check("failed pointer update rolled back", Number(afterFault.generationId) === Number(beforeFault) && afterFault.snapshotId === snapshotId, afterFault);
executeSql(`
  UPDATE kernel.snapshot_generations
  SET status = 'failed'
  WHERE snapshot_id = '${failedSnapshotId}' AND status = 'staging';
`);

const report = {
  status: assertions.every((assertion) => assertion.passed) ? "PASS" : "FAIL",
  scope: "postgresql-conflict-provenance-catchup-recovery-and-cutover",
  setupDurationMs,
  cutoverDurationMs,
  materialization: {
    initial: initialMaterialization,
    recoveryRetry: retryMaterialization,
  },
  setup,
  watermarkW1,
  observed,
  assertions,
};
await writeJson(join(evidenceDirectory, "environment.json"), {
  timestamp,
  hostname: hostname(),
  platform: platform(),
  osRelease: release(),
  nodeVersion: process.version,
  snapshotId,
});
await writeJson(join(evidenceDirectory, "result.json"), report);
await writeFile(join(evidenceDirectory, "command.txt"), "npm run spike:b\n", "utf8");
process.stdout.write(`${JSON.stringify({ evidenceDirectory, ...report }, null, 2)}\n`);
if (report.status !== "PASS") {
  process.exitCode = 1;
}

function check(name, passed, detail) {
  assertions.push({ name, passed: Boolean(passed), detail });
}

function assertSafeIdentifier(value) {
  if (!/^[A-Za-z0-9-]+$/.test(value)) {
    throw new Error(`Unsafe generated identifier: ${value}`);
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stagingFingerprint(generationId) {
  return queryJson(`
    SELECT json_build_array(json_build_object(
      'objects', (
        SELECT count(*) FROM kernel.object_current
        WHERE generation_id = ${generationId}
      ),
      'objectChecksum', (
        SELECT md5(string_agg(
          object_type_id || '|' || object_rid || '|' || primary_key || '|'
          || object_version || '|' || properties::text || '|' || lifecycle_state || '|'
          || COALESCE(conflict_state, '') || '|' || provenance::text,
          E'\\n' ORDER BY object_type_id, object_rid
        ))
        FROM kernel.object_current
        WHERE generation_id = ${generationId}
      ),
      'conflicts', (
        SELECT count(*) FROM kernel.object_conflicts
        WHERE generation_id = ${generationId}
      ),
      'conflictChecksum', (
        SELECT md5(COALESCE(string_agg(
          object_type_id || '|' || object_rid || '|' || COALESCE(property_name, '') || '|'
          || conflict_type || '|' || COALESCE(basis_value::text, '') || '|'
          || COALESCE(incoming_value::text, '') || '|' || COALESCE(overlay_value::text, ''),
          E'\\n' ORDER BY object_type_id, object_rid, conflict_type, property_name
        ), ''))
        FROM kernel.object_conflicts
        WHERE generation_id = ${generationId}
      )
    ));
  `)[0];
}
