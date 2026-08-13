\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS kernel;

CREATE TABLE IF NOT EXISTS kernel.object_type_runtime (
  object_type_id text PRIMARY KEY,
  active_generation_id bigint,
  active_snapshot_id text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (object_type_id ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$')
);

CREATE TABLE IF NOT EXISTS kernel.snapshot_generations (
  generation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  object_type_id text NOT NULL REFERENCES kernel.object_type_runtime(object_type_id),
  snapshot_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('staging', 'active', 'superseded', 'failed')),
  based_on_generation_id bigint REFERENCES kernel.snapshot_generations(generation_id),
  overlay_watermark bigint NOT NULL DEFAULT 0,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  UNIQUE (object_type_id, snapshot_id)
);

ALTER TABLE kernel.object_type_runtime
  DROP CONSTRAINT IF EXISTS object_type_runtime_active_generation_fk;

ALTER TABLE kernel.object_type_runtime
  ADD CONSTRAINT object_type_runtime_active_generation_fk
  FOREIGN KEY (active_generation_id)
  REFERENCES kernel.snapshot_generations(generation_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS kernel.object_base (
  generation_id bigint NOT NULL REFERENCES kernel.snapshot_generations(generation_id) ON DELETE RESTRICT,
  object_type_id text NOT NULL,
  object_rid text NOT NULL,
  primary_key text NOT NULL,
  properties jsonb NOT NULL CHECK (jsonb_typeof(properties) = 'object'),
  source_row_number bigint,
  PRIMARY KEY (generation_id, object_type_id, object_rid),
  UNIQUE (generation_id, object_type_id, primary_key)
);

CREATE TABLE IF NOT EXISTS kernel.object_heads (
  object_type_id text NOT NULL,
  object_rid text NOT NULL,
  primary_key text NOT NULL,
  object_version bigint NOT NULL DEFAULT 1 CHECK (object_version > 0),
  lifecycle_state text NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'tombstoned', 'source_removed')),
  conflict_state text CHECK (conflict_state IN ('BASE_CHANGED_UNDER_OVERRIDE', 'BASE_OBJECT_REMOVED', 'IDENTITY_COLLISION')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (object_type_id, object_rid),
  UNIQUE (object_type_id, primary_key)
);

CREATE TABLE IF NOT EXISTS kernel.overlay_operations (
  operation_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  object_type_id text NOT NULL,
  object_rid text NOT NULL,
  primary_key text NOT NULL,
  operation_type text NOT NULL CHECK (operation_type IN (
    'CREATE_OBJECT', 'SET_PROPERTY', 'CLEAR_PROPERTY', 'REMOVE_OVERRIDE',
    'TOMBSTONE_OBJECT', 'RESTORE_OBJECT'
  )),
  property_name text,
  value jsonb,
  basis_snapshot_id text,
  expected_object_version bigint,
  action_execution_id text NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (operation_type IN ('SET_PROPERTY', 'CLEAR_PROPERTY', 'REMOVE_OVERRIDE') AND property_name IS NOT NULL)
    OR
    (operation_type NOT IN ('SET_PROPERTY', 'CLEAR_PROPERTY', 'REMOVE_OVERRIDE') AND property_name IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS kernel.object_current (
  generation_id bigint NOT NULL REFERENCES kernel.snapshot_generations(generation_id) ON DELETE RESTRICT,
  object_type_id text NOT NULL,
  object_rid text NOT NULL,
  primary_key text NOT NULL,
  object_version bigint NOT NULL,
  properties jsonb NOT NULL CHECK (jsonb_typeof(properties) = 'object'),
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('active', 'tombstoned', 'source_removed')),
  conflict_state text CHECK (conflict_state IN ('BASE_CHANGED_UNDER_OVERRIDE', 'BASE_OBJECT_REMOVED', 'IDENTITY_COLLISION')),
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (generation_id, object_type_id, object_rid),
  UNIQUE (generation_id, object_type_id, primary_key)
);

CREATE TABLE IF NOT EXISTS kernel.object_conflicts (
  conflict_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  generation_id bigint NOT NULL REFERENCES kernel.snapshot_generations(generation_id) ON DELETE RESTRICT,
  object_type_id text NOT NULL,
  object_rid text NOT NULL,
  property_name text,
  conflict_type text NOT NULL CHECK (conflict_type IN ('BASE_CHANGED_UNDER_OVERRIDE', 'BASE_OBJECT_REMOVED', 'IDENTITY_COLLISION')),
  basis_snapshot_id text,
  basis_value jsonb,
  incoming_value jsonb,
  overlay_value jsonb,
  operation_seq bigint REFERENCES kernel.overlay_operations(operation_seq),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS kernel.link_type_runtime (
  link_type_id text PRIMARY KEY,
  active_generation_id bigint NOT NULL,
  source_object_type_id text NOT NULL,
  target_object_type_id text NOT NULL,
  CHECK (link_type_id ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$')
);

CREATE TABLE IF NOT EXISTS kernel.link_current (
  generation_id bigint NOT NULL,
  link_type_id text NOT NULL,
  link_rid text NOT NULL,
  source_object_type_id text NOT NULL,
  source_object_rid text NOT NULL,
  target_object_type_id text NOT NULL,
  target_object_rid text NOT NULL,
  lifecycle_state text NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'removed')),
  PRIMARY KEY (generation_id, link_type_id, link_rid)
);

CREATE TABLE IF NOT EXISTS kernel.release_metadata (
  release_revision text PRIMARY KEY,
  schema_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS kernel.action_executions (
  action_execution_id text PRIMARY KEY,
  action_type_id text NOT NULL,
  actor_id text NOT NULL,
  execution_status text NOT NULL CHECK (execution_status IN ('COMMITTED', 'REJECTED', 'CONFLICTED', 'FAILED_BEFORE_COMMIT')),
  delivery_status text NOT NULL CHECK (delivery_status IN ('NOT_APPLICABLE', 'PENDING', 'PARTIAL', 'COMPLETE', 'DEAD_LETTER')),
  idempotency_key text NOT NULL,
  parameters_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_id, action_type_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS kernel.changesets (
  changeset_id text PRIMARY KEY,
  action_execution_id text NOT NULL REFERENCES kernel.action_executions(action_execution_id),
  mutations jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS kernel.outbox_events (
  event_id text PRIMARY KEY,
  action_execution_id text NOT NULL REFERENCES kernel.action_executions(action_execution_id),
  changeset_id text NOT NULL REFERENCES kernel.changesets(changeset_id),
  object_rid text,
  object_sequence bigint,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  delivery_status text NOT NULL DEFAULT 'PENDING' CHECK (delivery_status IN ('PENDING', 'DELIVERING', 'COMPLETE', 'DEAD_LETTER')),
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
