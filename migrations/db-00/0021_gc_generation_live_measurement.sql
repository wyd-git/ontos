SET LOCAL ROLE migration_owner;

-- A Generation measurement written before an Activation cannot include the
-- immutable Cutover candidate rows created by that Activation.  GC therefore
-- derives its per-Generation reclaimable bytes from the authoritative live
-- row inventory at Dry-run time.  The project-level measurement_complete gate
-- remains controlled by the trusted physical scanner, and index bytes remain
-- bound separately by ops.gc_index_inventory.
CREATE OR REPLACE VIEW ops.gc_generation_inventory WITH (security_barrier = true) AS
SELECT generation.project_id, generation.generation_id, generation.member_key,
       CASE
         WHEN collected.generation_id IS NOT NULL THEN 'COLLECTED'
         WHEN generation.state = 'building' THEN 'STAGING'
         WHEN generation.state = 'failed' THEN 'FAILED_STAGING'
         ELSE upper(generation.state)
       END AS inventory_state,
       generation.created_at, generation.changed_at,
       CASE WHEN generation.state = 'retired' THEN generation.changed_at END AS left_serving_at,
       COALESCE(physical.bytes, 0)::bigint AS measured_bytes,
       COALESCE(signatures.index_signatures, '[]'::jsonb) AS index_signatures
FROM runtime.generations AS generation
LEFT JOIN runtime.generation_collections AS collected
  ON collected.project_id = generation.project_id
 AND collected.generation_id = generation.generation_id
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(bytes), 0)::bigint AS bytes
  FROM (
    SELECT pg_column_size(row_value)::bigint AS bytes
    FROM runtime.object_base AS row_value
    WHERE row_value.project_id = generation.project_id
      AND row_value.generation_id = generation.generation_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM runtime.link_base AS row_value
    WHERE row_value.project_id = generation.project_id
      AND row_value.generation_id = generation.generation_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM runtime.object_current AS row_value
    WHERE row_value.project_id = generation.project_id
      AND row_value.generation_id = generation.generation_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM runtime.link_current AS row_value
    WHERE row_value.project_id = generation.project_id
      AND row_value.generation_id = generation.generation_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM runtime.property_provenance AS row_value
    WHERE row_value.project_id = generation.project_id
      AND row_value.generation_id = generation.generation_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM runtime.object_head_candidates AS row_value
    WHERE row_value.project_id = generation.project_id
      AND row_value.generation_id = generation.generation_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM runtime.snapshot_group_cutover_head_candidates AS row_value
    WHERE row_value.project_id = generation.project_id
      AND row_value.candidate_generation_id = generation.generation_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM ops.materialization_quality_observations AS row_value
    WHERE row_value.project_id = generation.project_id
      AND row_value.generation_id = generation.generation_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM ops.materialization_provenance_templates AS row_value
    WHERE row_value.project_id = generation.project_id
      AND row_value.generation_id = generation.generation_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM ops.materialization_quality_preparations AS row_value
    WHERE row_value.project_id = generation.project_id
      AND row_value.generation_id = generation.generation_id
  ) AS physical_rows
) AS physical ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(entry.physical_signature ORDER BY entry.physical_signature) AS index_signatures
  FROM runtime.index_plans AS plan
  JOIN runtime.index_plan_entries AS entry
    ON entry.project_id = plan.project_id AND entry.index_plan_id = plan.index_plan_id
  WHERE plan.project_id = generation.project_id
    AND plan.plan_digest = generation.index_plan_digest
) AS signatures ON true;

COMMENT ON VIEW ops.gc_generation_inventory IS
  'Authoritative live per-Generation row inventory for fail-closed GC planning; dynamic index bytes are inventoried separately.';
