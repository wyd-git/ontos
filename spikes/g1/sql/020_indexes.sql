\set ON_ERROR_STOP on
\timing on

CREATE INDEX IF NOT EXISTS object_current_type_generation_pk_idx
  ON kernel.object_current (object_type_id, generation_id, primary_key)
  WHERE lifecycle_state = 'active';

CREATE INDEX IF NOT EXISTS object_current_status_updated_idx
  ON kernel.object_current (
    object_type_id,
    generation_id,
    (properties ->> 'status'),
    (properties ->> 'updatedAt') DESC,
    primary_key
  )
  WHERE lifecycle_state = 'active';

CREATE INDEX IF NOT EXISTS object_current_region_status_idx
  ON kernel.object_current (
    object_type_id,
    generation_id,
    (properties ->> 'region'),
    (properties ->> 'status'),
    primary_key
  )
  WHERE lifecycle_state = 'active';

CREATE INDEX IF NOT EXISTS object_current_amount_idx
  ON kernel.object_current (
    object_type_id,
    generation_id,
    ((properties ->> 'amount')::numeric),
    primary_key
  )
  WHERE lifecycle_state = 'active';

CREATE INDEX IF NOT EXISTS object_current_name_prefix_idx
  ON kernel.object_current (
    object_type_id,
    generation_id,
    lower(properties ->> 'name') text_pattern_ops,
    primary_key
  )
  WHERE lifecycle_state = 'active';

CREATE INDEX IF NOT EXISTS object_current_name_trgm_idx
  ON kernel.object_current
  USING gin (lower(properties ->> 'name') gin_trgm_ops)
  WHERE lifecycle_state = 'active';

CREATE INDEX IF NOT EXISTS object_current_tags_gin_idx
  ON kernel.object_current
  USING gin ((properties -> 'tags'))
  WHERE lifecycle_state = 'active';

CREATE INDEX IF NOT EXISTS link_current_source_idx
  ON kernel.link_current (
    link_type_id,
    generation_id,
    source_object_type_id,
    source_object_rid,
    target_object_rid
  )
  WHERE lifecycle_state = 'active';

CREATE INDEX IF NOT EXISTS link_current_target_idx
  ON kernel.link_current (
    link_type_id,
    generation_id,
    target_object_type_id,
    target_object_rid,
    source_object_rid
  )
  WHERE lifecycle_state = 'active';

CREATE INDEX IF NOT EXISTS overlay_operations_object_seq_idx
  ON kernel.overlay_operations (object_type_id, object_rid, operation_seq);

CREATE INDEX IF NOT EXISTS overlay_operations_property_latest_idx
  ON kernel.overlay_operations (object_type_id, object_rid, property_name, operation_seq DESC)
  WHERE property_name IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS object_conflicts_identity_idx
  ON kernel.object_conflicts (
    generation_id,
    object_type_id,
    object_rid,
    conflict_type,
    COALESCE(property_name, '')
  );

ANALYZE kernel.object_current;
ANALYZE kernel.link_current;
