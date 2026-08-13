\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION kernel.materialized_rows(
  p_generation_id bigint,
  p_previous_generation_id bigint,
  p_watermark bigint,
  p_affected_object_rids text[] DEFAULT NULL
)
RETURNS TABLE (
  object_type_id text,
  object_rid text,
  primary_key text,
  properties jsonb,
  lifecycle_state text
)
LANGUAGE sql
STABLE
AS $$
  WITH generation AS (
    SELECT object_type_id
    FROM kernel.snapshot_generations
    WHERE generation_id = p_generation_id
  ),
  incoming_base AS (
    SELECT base.*
    FROM kernel.object_base base
    JOIN generation USING (object_type_id)
    WHERE base.generation_id = p_generation_id
      AND (p_affected_object_rids IS NULL OR base.object_rid = ANY(p_affected_object_rids))
  ),
  previous_current AS (
    SELECT current_object.*
    FROM kernel.object_current current_object
    JOIN generation USING (object_type_id)
    WHERE current_object.generation_id = p_previous_generation_id
      AND (p_affected_object_rids IS NULL OR current_object.object_rid = ANY(p_affected_object_rids))
  ),
  operations AS (
    SELECT operation.*
    FROM kernel.overlay_operations operation
    JOIN generation USING (object_type_id)
    WHERE operation.operation_seq <= p_watermark
      AND (p_affected_object_rids IS NULL OR operation.object_rid = ANY(p_affected_object_rids))
  ),
  latest_create AS (
    SELECT DISTINCT ON (object_rid)
      object_type_id,
      object_rid,
      primary_key,
      value AS create_properties,
      operation_seq,
      basis_snapshot_id
    FROM operations
    WHERE operation_type = 'CREATE_OBJECT'
    ORDER BY object_rid, operation_seq DESC
  ),
  latest_property AS (
    SELECT DISTINCT ON (object_rid, property_name)
      object_type_id,
      object_rid,
      primary_key,
      property_name,
      operation_type,
      value,
      operation_seq,
      basis_snapshot_id
    FROM operations
    WHERE operation_type IN ('SET_PROPERTY', 'CLEAR_PROPERTY', 'REMOVE_OVERRIDE')
    ORDER BY object_rid, property_name, operation_seq DESC
  ),
  active_property AS (
    SELECT *
    FROM latest_property
    WHERE operation_type <> 'REMOVE_OVERRIDE'
  ),
  property_patch AS (
    SELECT
      object_type_id,
      object_rid,
      min(primary_key) AS primary_key,
      jsonb_object_agg(
        property_name,
        CASE WHEN operation_type = 'CLEAR_PROPERTY' THEN 'null'::jsonb ELSE value END
      ) AS patch
    FROM active_property
    GROUP BY object_type_id, object_rid
  ),
  latest_lifecycle AS (
    SELECT DISTINCT ON (object_rid)
      object_type_id,
      object_rid,
      primary_key,
      operation_type,
      operation_seq,
      basis_snapshot_id
    FROM operations
    WHERE operation_type IN ('TOMBSTONE_OBJECT', 'RESTORE_OBJECT')
    ORDER BY object_rid, operation_seq DESC
  ),
  active_tombstone AS (
    SELECT * FROM latest_lifecycle WHERE operation_type = 'TOMBSTONE_OBJECT'
  ),
  identities AS (
    SELECT object_type_id, object_rid, primary_key FROM incoming_base
    UNION
    SELECT object_type_id, object_rid, primary_key FROM latest_create
    UNION
    SELECT object_type_id, object_rid, primary_key FROM active_property
    UNION
    SELECT object_type_id, object_rid, primary_key FROM active_tombstone
  )
  SELECT
    identity.object_type_id,
    identity.object_rid,
    identity.primary_key,
    (
      CASE
        WHEN create_operation.object_rid IS NOT NULL THEN create_operation.create_properties
        WHEN incoming.object_rid IS NOT NULL THEN incoming.properties
        ELSE previous.properties
      END
      || COALESCE(patch.patch, '{}'::jsonb)
    ) AS properties,
    CASE
      WHEN tombstone.object_rid IS NOT NULL THEN 'tombstoned'
      WHEN incoming.object_rid IS NULL AND create_operation.object_rid IS NULL THEN 'source_removed'
      ELSE 'active'
    END AS lifecycle_state
  FROM identities identity
  LEFT JOIN incoming_base incoming USING (object_type_id, object_rid, primary_key)
  LEFT JOIN previous_current previous USING (object_type_id, object_rid, primary_key)
  LEFT JOIN latest_create create_operation USING (object_type_id, object_rid, primary_key)
  LEFT JOIN property_patch patch USING (object_type_id, object_rid, primary_key)
  LEFT JOIN active_tombstone tombstone USING (object_type_id, object_rid, primary_key)
  WHERE incoming.object_rid IS NOT NULL
     OR create_operation.object_rid IS NOT NULL
     OR previous.object_rid IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION kernel.materialized_provenance(
  p_generation_id bigint,
  p_previous_generation_id bigint,
  p_watermark bigint,
  p_affected_object_rids text[] DEFAULT NULL
)
RETURNS TABLE (
  object_type_id text,
  object_rid text,
  provenance jsonb
)
LANGUAGE sql
STABLE
AS $$
  WITH generation AS (
    SELECT object_type_id, snapshot_id
    FROM kernel.snapshot_generations
    WHERE generation_id = p_generation_id
  ),
  materialized AS MATERIALIZED (
    SELECT *
    FROM kernel.materialized_rows(
      p_generation_id,
      p_previous_generation_id,
      p_watermark,
      p_affected_object_rids
    )
  ),
  operations AS (
    SELECT operation.*
    FROM kernel.overlay_operations operation
    JOIN generation USING (object_type_id)
    WHERE operation.operation_seq <= p_watermark
      AND (p_affected_object_rids IS NULL OR operation.object_rid = ANY(p_affected_object_rids))
  ),
  latest_property AS (
    SELECT DISTINCT ON (object_type_id, object_rid, property_name)
      object_type_id,
      object_rid,
      property_name,
      operation_type,
      operation_seq,
      basis_snapshot_id
    FROM operations
    WHERE operation_type IN ('SET_PROPERTY', 'CLEAR_PROPERTY', 'REMOVE_OVERRIDE')
    ORDER BY object_type_id, object_rid, property_name, operation_seq DESC
  ),
  property_provenance AS (
    SELECT
      object_type_id,
      object_rid,
      jsonb_object_agg(
        property_name,
        jsonb_strip_nulls(jsonb_build_object(
          'source', 'overlay',
          'operationType', operation_type,
          'operationSeq', operation_seq,
          'basisSnapshotId', basis_snapshot_id
        ))
      ) AS value
    FROM latest_property
    WHERE operation_type <> 'REMOVE_OVERRIDE'
    GROUP BY object_type_id, object_rid
  ),
  latest_create AS (
    SELECT DISTINCT ON (object_type_id, object_rid)
      object_type_id,
      object_rid,
      operation_seq,
      basis_snapshot_id
    FROM operations
    WHERE operation_type = 'CREATE_OBJECT'
    ORDER BY object_type_id, object_rid, operation_seq DESC
  ),
  latest_lifecycle AS (
    SELECT DISTINCT ON (object_type_id, object_rid)
      object_type_id,
      object_rid,
      operation_type,
      operation_seq,
      basis_snapshot_id
    FROM operations
    WHERE operation_type IN ('TOMBSTONE_OBJECT', 'RESTORE_OBJECT')
    ORDER BY object_type_id, object_rid, operation_seq DESC
  )
  SELECT
    materialized.object_type_id,
    materialized.object_rid,
    jsonb_strip_nulls(jsonb_build_object(
      'base', CASE
        WHEN incoming.object_rid IS NOT NULL THEN jsonb_build_object(
          'source', 'base',
          'snapshotId', generation.snapshot_id,
          'sourceRow', incoming.source_row_number
        )
        WHEN previous.provenance ? 'base' THEN previous.provenance -> 'base'
        WHEN previous.provenance ? 'snapshotId' THEN
          jsonb_strip_nulls(jsonb_build_object(
            'source', 'previous_base_orphan',
            'snapshotId', previous.provenance ->> 'snapshotId',
            'sourceRow', previous.provenance -> 'sourceRow'
          ))
        ELSE NULL
      END,
      'overlayCreate', CASE WHEN create_operation.object_rid IS NOT NULL THEN
        jsonb_strip_nulls(jsonb_build_object(
          'source', 'overlay_create',
          'operationSeq', create_operation.operation_seq,
          'basisSnapshotId', create_operation.basis_snapshot_id
        ))
      END,
      'propertyOverrides', COALESCE(property_source.value, '{}'::jsonb),
      'lifecycleOperation', CASE WHEN lifecycle.object_rid IS NOT NULL THEN
        jsonb_strip_nulls(jsonb_build_object(
          'source', 'overlay_lifecycle',
          'operationType', lifecycle.operation_type,
          'operationSeq', lifecycle.operation_seq,
          'basisSnapshotId', lifecycle.basis_snapshot_id
        ))
      END,
      'overlayWatermark', p_watermark
    )) AS provenance
  FROM materialized
  JOIN generation USING (object_type_id)
  LEFT JOIN kernel.object_base incoming
    ON incoming.generation_id = p_generation_id
   AND incoming.object_type_id = materialized.object_type_id
   AND incoming.object_rid = materialized.object_rid
  LEFT JOIN kernel.object_current previous
    ON previous.generation_id = p_previous_generation_id
   AND previous.object_type_id = materialized.object_type_id
   AND previous.object_rid = materialized.object_rid
  LEFT JOIN property_provenance property_source
    ON property_source.object_type_id = materialized.object_type_id
   AND property_source.object_rid = materialized.object_rid
  LEFT JOIN latest_create create_operation
    ON create_operation.object_type_id = materialized.object_type_id
   AND create_operation.object_rid = materialized.object_rid
  LEFT JOIN latest_lifecycle lifecycle
    ON lifecycle.object_type_id = materialized.object_type_id
   AND lifecycle.object_rid = materialized.object_rid;
$$;

CREATE OR REPLACE FUNCTION kernel.detect_conflicts(
  p_generation_id bigint,
  p_previous_generation_id bigint,
  p_watermark bigint,
  p_affected_object_rids text[] DEFAULT NULL
)
RETURNS TABLE (
  object_type_id text,
  object_rid text,
  property_name text,
  conflict_type text,
  basis_snapshot_id text,
  basis_value jsonb,
  incoming_value jsonb,
  overlay_value jsonb,
  operation_seq bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH generation AS (
    SELECT object_type_id
    FROM kernel.snapshot_generations
    WHERE generation_id = p_generation_id
  ),
  incoming_base AS (
    SELECT base.*
    FROM kernel.object_base base
    JOIN generation USING (object_type_id)
    WHERE base.generation_id = p_generation_id
      AND (p_affected_object_rids IS NULL OR base.object_rid = ANY(p_affected_object_rids))
  ),
  previous_current AS (
    SELECT current_object.*
    FROM kernel.object_current current_object
    JOIN generation USING (object_type_id)
    WHERE current_object.generation_id = p_previous_generation_id
      AND (p_affected_object_rids IS NULL OR current_object.object_rid = ANY(p_affected_object_rids))
  ),
  operations AS (
    SELECT operation.*
    FROM kernel.overlay_operations operation
    JOIN generation USING (object_type_id)
    WHERE operation.operation_seq <= p_watermark
      AND (p_affected_object_rids IS NULL OR operation.object_rid = ANY(p_affected_object_rids))
  ),
  latest_create AS (
    SELECT DISTINCT ON (object_rid) *
    FROM operations
    WHERE operation_type = 'CREATE_OBJECT'
    ORDER BY object_rid, operation_seq DESC
  ),
  latest_property AS (
    SELECT DISTINCT ON (object_rid, property_name) *
    FROM operations
    WHERE operation_type IN ('SET_PROPERTY', 'CLEAR_PROPERTY', 'REMOVE_OVERRIDE')
    ORDER BY object_rid, property_name, operation_seq DESC
  ),
  active_property AS (
    SELECT * FROM latest_property WHERE operation_type <> 'REMOVE_OVERRIDE'
  ),
  property_conflicts AS (
    SELECT
      operation.object_type_id,
      operation.object_rid,
      operation.property_name,
      'BASE_CHANGED_UNDER_OVERRIDE'::text AS conflict_type,
      operation.basis_snapshot_id,
      basis.properties -> operation.property_name AS basis_value,
      incoming.properties -> operation.property_name AS incoming_value,
      CASE WHEN operation.operation_type = 'CLEAR_PROPERTY' THEN 'null'::jsonb ELSE operation.value END AS overlay_value,
      operation.operation_seq
    FROM active_property operation
    JOIN kernel.snapshot_generations basis_generation
      ON basis_generation.object_type_id = operation.object_type_id
     AND basis_generation.snapshot_id = operation.basis_snapshot_id
    JOIN kernel.object_base basis
      ON basis.generation_id = basis_generation.generation_id
     AND basis.object_type_id = operation.object_type_id
     AND basis.object_rid = operation.object_rid
    JOIN incoming_base incoming
      ON incoming.object_type_id = operation.object_type_id
     AND incoming.object_rid = operation.object_rid
    WHERE (basis.properties -> operation.property_name)
      IS DISTINCT FROM (incoming.properties -> operation.property_name)
  ),
  removed_conflicts AS (
    SELECT
      operation.object_type_id,
      operation.object_rid,
      NULL::text AS property_name,
      'BASE_OBJECT_REMOVED'::text AS conflict_type,
      operation.basis_snapshot_id,
      previous.properties AS basis_value,
      NULL::jsonb AS incoming_value,
      jsonb_build_object(operation.property_name,
        CASE WHEN operation.operation_type = 'CLEAR_PROPERTY' THEN 'null'::jsonb ELSE operation.value END
      ) AS overlay_value,
      operation.operation_seq
    FROM active_property operation
    JOIN previous_current previous
      ON previous.object_type_id = operation.object_type_id
     AND previous.object_rid = operation.object_rid
    LEFT JOIN incoming_base incoming
      ON incoming.object_type_id = operation.object_type_id
     AND incoming.object_rid = operation.object_rid
    LEFT JOIN latest_create create_operation
      ON create_operation.object_type_id = operation.object_type_id
     AND create_operation.object_rid = operation.object_rid
    WHERE incoming.object_rid IS NULL
      AND create_operation.object_rid IS NULL
  ),
  identity_conflicts AS (
    SELECT
      create_operation.object_type_id,
      create_operation.object_rid,
      NULL::text AS property_name,
      'IDENTITY_COLLISION'::text AS conflict_type,
      create_operation.basis_snapshot_id,
      NULL::jsonb AS basis_value,
      incoming.properties AS incoming_value,
      create_operation.value AS overlay_value,
      create_operation.operation_seq
    FROM latest_create create_operation
    JOIN incoming_base incoming
      ON incoming.object_type_id = create_operation.object_type_id
     AND incoming.object_rid = create_operation.object_rid
    LEFT JOIN kernel.snapshot_generations basis_generation
      ON basis_generation.object_type_id = create_operation.object_type_id
     AND basis_generation.snapshot_id = create_operation.basis_snapshot_id
    LEFT JOIN kernel.object_base basis
      ON basis.generation_id = basis_generation.generation_id
     AND basis.object_type_id = create_operation.object_type_id
     AND basis.object_rid = create_operation.object_rid
    WHERE basis.object_rid IS NULL
  )
  SELECT * FROM identity_conflicts
  UNION ALL
  SELECT * FROM removed_conflicts
  UNION ALL
  SELECT * FROM property_conflicts;
$$;

CREATE OR REPLACE PROCEDURE kernel.rebuild_generation(
  p_generation_id bigint,
  p_previous_generation_id bigint,
  p_watermark bigint,
  p_affected_object_rids text[] DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_affected_object_rids IS NULL THEN
    RAISE EXCEPTION
      'Full generation rebuild must be orchestrated by the Materializer Worker';
  END IF;

  -- Generation size and affected-set cardinality differ by orders of magnitude.
  -- This database procedure is deliberately restricted to the small catch-up
  -- set captured while the worker was building an invisible staging generation.
  -- Force a value-aware plan for each catch-up invocation.
  PERFORM set_config('plan_cache_mode', 'force_custom_plan', true);

  IF NOT EXISTS (
    SELECT 1 FROM kernel.snapshot_generations
    WHERE generation_id = p_generation_id AND status = 'staging'
  ) THEN
    RAISE EXCEPTION 'Generation % is not staging', p_generation_id;
  END IF;

  DELETE FROM kernel.object_conflicts conflict
  WHERE conflict.generation_id = p_generation_id
    AND (p_affected_object_rids IS NULL OR conflict.object_rid = ANY(p_affected_object_rids));

  DELETE FROM kernel.object_current current_object
  WHERE current_object.generation_id = p_generation_id
    AND (p_affected_object_rids IS NULL OR current_object.object_rid = ANY(p_affected_object_rids));

  -- Use server-generated numeric IDs and a quoted text[] literal in dynamic SQL.
  -- This prevents PostgreSQL from caching a generic nested-loop plan for calls
  -- whose affected cardinality ranges from one object to a full generation.
  EXECUTE format($query$
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
      %1$s,
      conflict.object_type_id,
      conflict.object_rid,
      conflict.property_name,
      conflict.conflict_type,
      conflict.basis_snapshot_id,
      conflict.basis_value,
      conflict.incoming_value,
      conflict.overlay_value,
      conflict.operation_seq
    FROM kernel.detect_conflicts(
      %1$s,
      %2$s,
      %3$s,
      %4$L::text[]
    ) conflict
  $query$,
    p_generation_id,
    p_previous_generation_id,
    p_watermark,
    p_affected_object_rids
  );

  EXECUTE format($query$
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
      %1$s,
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
      provenance_source.provenance
    FROM kernel.materialized_rows(
      %1$s,
      %2$s,
      %3$s,
      %4$L::text[]
    ) materialized
    JOIN kernel.materialized_provenance(
      %1$s,
      %2$s,
      %3$s,
      %4$L::text[]
    ) provenance_source
      ON provenance_source.object_type_id = materialized.object_type_id
     AND provenance_source.object_rid = materialized.object_rid
    LEFT JOIN kernel.object_current previous
      ON previous.generation_id = %2$s
     AND previous.object_type_id = materialized.object_type_id
     AND previous.object_rid = materialized.object_rid
    LEFT JOIN (
      SELECT
        conflict.generation_id,
        conflict.object_type_id,
        conflict.object_rid,
        CASE min(
          CASE conflict.conflict_type
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
      FROM kernel.object_conflicts conflict
      WHERE conflict.generation_id = %1$s
      GROUP BY conflict.generation_id, conflict.object_type_id, conflict.object_rid
    ) conflict_state
      ON conflict_state.generation_id = %1$s
     AND conflict_state.object_type_id = materialized.object_type_id
     AND conflict_state.object_rid = materialized.object_rid
  $query$,
    p_generation_id,
    p_previous_generation_id,
    p_watermark,
    p_affected_object_rids
  );

  UPDATE kernel.snapshot_generations
  SET overlay_watermark = p_watermark
  WHERE generation_id = p_generation_id;
END;
$$;

CREATE OR REPLACE FUNCTION kernel.append_set_overlay(
  p_object_type_id text,
  p_object_rid text,
  p_primary_key text,
  p_property_name text,
  p_value jsonb,
  p_action_execution_id text,
  p_actor_id text,
  p_expected_object_version bigint DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  active_generation bigint;
  active_snapshot text;
  current_version bigint;
  new_sequence bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('snapshot:' || p_object_type_id, 0));

  SELECT runtime.active_generation_id, runtime.active_snapshot_id
  INTO active_generation, active_snapshot
  FROM kernel.object_type_runtime runtime
  WHERE runtime.object_type_id = p_object_type_id
  FOR UPDATE;

  SELECT current_object.object_version
  INTO current_version
  FROM kernel.object_current current_object
  WHERE current_object.generation_id = active_generation
    AND current_object.object_type_id = p_object_type_id
    AND current_object.object_rid = p_object_rid
    AND current_object.lifecycle_state <> 'tombstoned'
  FOR UPDATE;

  IF current_version IS NULL THEN
    RAISE EXCEPTION 'Object % is not accessible in active generation', p_object_rid;
  END IF;

  IF p_expected_object_version IS NOT NULL AND current_version <> p_expected_object_version THEN
    RAISE EXCEPTION 'OBJECT_VERSION_CONFLICT expected %, actual %', p_expected_object_version, current_version;
  END IF;

  INSERT INTO kernel.overlay_operations (
    object_type_id,
    object_rid,
    primary_key,
    operation_type,
    property_name,
    value,
    basis_snapshot_id,
    expected_object_version,
    action_execution_id,
    actor_id
  ) VALUES (
    p_object_type_id,
    p_object_rid,
    p_primary_key,
    'SET_PROPERTY',
    p_property_name,
    p_value,
    active_snapshot,
    current_version,
    p_action_execution_id,
    p_actor_id
  )
  RETURNING operation_seq INTO new_sequence;

  UPDATE kernel.object_current
  SET
    properties = jsonb_set(properties, ARRAY[p_property_name], p_value, true),
    object_version = object_version + 1,
    provenance = provenance || jsonb_build_object(
      'propertyOverrides',
      COALESCE(provenance -> 'propertyOverrides', '{}'::jsonb) || jsonb_build_object(
        p_property_name,
        jsonb_build_object(
          'source', 'overlay',
          'operationType', 'SET_PROPERTY',
          'operationSeq', new_sequence,
          'basisSnapshotId', active_snapshot
        )
      ),
      'overlayWatermark', new_sequence
    )
  WHERE generation_id = active_generation
    AND object_type_id = p_object_type_id
    AND object_rid = p_object_rid;

  UPDATE kernel.object_heads
  SET object_version = current_version + 1, updated_at = clock_timestamp()
  WHERE object_type_id = p_object_type_id
    AND object_rid = p_object_rid;

  RETURN new_sequence;
END;
$$;

CREATE OR REPLACE FUNCTION kernel.append_create_overlay(
  p_object_type_id text,
  p_object_rid text,
  p_primary_key text,
  p_properties jsonb,
  p_action_execution_id text,
  p_actor_id text
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  active_generation bigint;
  active_snapshot text;
  new_sequence bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('snapshot:' || p_object_type_id, 0));

  SELECT active_generation_id, active_snapshot_id
  INTO active_generation, active_snapshot
  FROM kernel.object_type_runtime
  WHERE object_type_id = p_object_type_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM kernel.object_heads
    WHERE object_type_id = p_object_type_id AND primary_key = p_primary_key
  ) THEN
    RAISE EXCEPTION 'IDENTITY_COLLISION for primary key %', p_primary_key;
  END IF;

  INSERT INTO kernel.overlay_operations (
    object_type_id,
    object_rid,
    primary_key,
    operation_type,
    value,
    basis_snapshot_id,
    action_execution_id,
    actor_id
  ) VALUES (
    p_object_type_id,
    p_object_rid,
    p_primary_key,
    'CREATE_OBJECT',
    p_properties,
    active_snapshot,
    p_action_execution_id,
    p_actor_id
  )
  RETURNING operation_seq INTO new_sequence;

  INSERT INTO kernel.object_heads (
    object_type_id,
    object_rid,
    primary_key,
    object_version,
    lifecycle_state
  ) VALUES (
    p_object_type_id,
    p_object_rid,
    p_primary_key,
    1,
    'active'
  );

  INSERT INTO kernel.object_current (
    generation_id,
    object_type_id,
    object_rid,
    primary_key,
    object_version,
    properties,
    lifecycle_state,
    provenance
  ) VALUES (
    active_generation,
    p_object_type_id,
    p_object_rid,
    p_primary_key,
    1,
    p_properties,
    'active',
    jsonb_build_object(
      'overlayCreate', jsonb_build_object(
        'source', 'overlay_create',
        'operationSeq', new_sequence,
        'basisSnapshotId', active_snapshot
      ),
      'propertyOverrides', '{}'::jsonb,
      'overlayWatermark', new_sequence
    )
  );

  RETURN new_sequence;
END;
$$;

CREATE OR REPLACE PROCEDURE kernel.cutover_generation(p_generation_id bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  target_object_type text;
  previous_generation bigint;
  watermark_before bigint;
  watermark_after bigint;
  affected text[];
BEGIN
  SELECT generation.object_type_id, generation.overlay_watermark
  INTO target_object_type, watermark_before
  FROM kernel.snapshot_generations generation
  WHERE generation.generation_id = p_generation_id
    AND generation.status = 'staging';

  IF target_object_type IS NULL THEN
    RAISE EXCEPTION 'Generation % is not staging', p_generation_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('snapshot:' || target_object_type, 0));

  SELECT active_generation_id
  INTO previous_generation
  FROM kernel.object_type_runtime
  WHERE object_type_id = target_object_type
  FOR UPDATE;

  SELECT COALESCE(max(operation_seq), 0)
  INTO watermark_after
  FROM kernel.overlay_operations
  WHERE object_type_id = target_object_type;

  SELECT array_agg(DISTINCT object_rid ORDER BY object_rid)
  INTO affected
  FROM kernel.overlay_operations
  WHERE object_type_id = target_object_type
    AND operation_seq > watermark_before
    AND operation_seq <= watermark_after;

  IF affected IS NOT NULL THEN
    CALL kernel.rebuild_generation(
      p_generation_id,
      previous_generation,
      watermark_after,
      affected
    );
  ELSE
    UPDATE kernel.snapshot_generations
    SET overlay_watermark = watermark_after
    WHERE generation_id = p_generation_id;
  END IF;

  UPDATE kernel.snapshot_generations
  SET status = 'superseded'
  WHERE generation_id = previous_generation;

  UPDATE kernel.snapshot_generations
  SET status = 'active', activated_at = clock_timestamp()
  WHERE generation_id = p_generation_id;

  UPDATE kernel.object_type_runtime runtime
  SET
    active_generation_id = p_generation_id,
    active_snapshot_id = generation.snapshot_id,
    updated_at = clock_timestamp()
  FROM kernel.snapshot_generations generation
  WHERE runtime.object_type_id = target_object_type
    AND generation.generation_id = p_generation_id;

  INSERT INTO kernel.object_heads (
    object_type_id,
    object_rid,
    primary_key,
    object_version,
    lifecycle_state,
    conflict_state,
    updated_at
  )
  SELECT
    current_object.object_type_id,
    current_object.object_rid,
    current_object.primary_key,
    current_object.object_version,
    current_object.lifecycle_state,
    current_object.conflict_state,
    clock_timestamp()
  FROM kernel.object_current current_object
  WHERE current_object.generation_id = p_generation_id
  ON CONFLICT (object_type_id, object_rid) DO UPDATE SET
    object_version = EXCLUDED.object_version,
    lifecycle_state = EXCLUDED.lifecycle_state,
    conflict_state = EXCLUDED.conflict_state,
    updated_at = EXCLUDED.updated_at
  WHERE (
    object_heads.object_version,
    object_heads.lifecycle_state,
    object_heads.conflict_state
  ) IS DISTINCT FROM (
    EXCLUDED.object_version,
    EXCLUDED.lifecycle_state,
    EXCLUDED.conflict_state
  );
END;
$$;
