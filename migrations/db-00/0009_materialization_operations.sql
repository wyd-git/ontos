SET LOCAL ROLE migration_owner;

CREATE TABLE runtime.project_runtime_inventories (
  project_id uuid PRIMARY KEY REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  state_revision bigint NOT NULL DEFAULT 1 CHECK (state_revision >= 1),
  inventory_revision bigint NOT NULL DEFAULT 1 CHECK (inventory_revision >= 1),
  measurement_complete boolean NOT NULL DEFAULT false,
  inventory_digest varchar(71)
    CHECK (inventory_digest IS NULL OR inventory_digest ~ '^sha256:[0-9a-f]{64}$'),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE runtime.index_plan_entries (
  project_id uuid NOT NULL,
  index_plan_id uuid NOT NULL,
  entry_key varchar(128) NOT NULL
    CHECK (entry_key ~ '^[A-Za-z][A-Za-z0-9._-]{0,127}$'),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
  recipe text NOT NULL CHECK (recipe IN (
    'BTREE_TEXT', 'BTREE_UUID', 'BTREE_BOOLEAN', 'BTREE_INTEGER', 'BTREE_DECIMAL',
    'BTREE_DATE', 'BTREE_TIMESTAMP', 'BTREE_ENUM', 'UNIQUE_BTREE',
    'TRIGRAM_GIN', 'ARRAY_GIN'
  )),
  property_api_name varchar(63) NOT NULL
    CHECK (property_api_name ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$'),
  physical_signature varchar(71) NOT NULL
    CHECK (physical_signature ~ '^sha256:[0-9a-f]{64}$'),
  definition_digest varchar(71) NOT NULL
    CHECK (definition_digest ~ '^sha256:[0-9a-f]{64}$'),
  evidence_refs jsonb NOT NULL CHECK (
    jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) BETWEEN 1 AND 64
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, index_plan_id, entry_key),
  CONSTRAINT index_plan_entries_plan_fk FOREIGN KEY (project_id, index_plan_id)
    REFERENCES runtime.index_plans(project_id, index_plan_id) ON DELETE RESTRICT,
  CONSTRAINT index_plan_entries_ordinal_uq UNIQUE (project_id, index_plan_id, ordinal),
  CONSTRAINT index_plan_entries_signature_uq
    UNIQUE (project_id, index_plan_id, physical_signature)
);

CREATE TABLE runtime.index_inventory (
  project_id uuid NOT NULL,
  index_inventory_id uuid NOT NULL,
  index_plan_id uuid NOT NULL,
  entry_key varchar(128) NOT NULL,
  index_name varchar(63) NOT NULL
    CHECK (index_name ~ '^ontos_idx_[a-z0-9_]{8,53}$'),
  physical_signature varchar(71) NOT NULL
    CHECK (physical_signature ~ '^sha256:[0-9a-f]{64}$'),
  catalog_digest varchar(71)
    CHECK (catalog_digest IS NULL OR catalog_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'planned'
    CHECK (state IN ('planned', 'building', 'ready', 'retired', 'failed')),
  inventory_revision bigint NOT NULL CHECK (inventory_revision >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, index_inventory_id),
  CONSTRAINT index_inventory_entry_fk FOREIGN KEY (
    project_id, index_plan_id, entry_key
  ) REFERENCES runtime.index_plan_entries(
    project_id, index_plan_id, entry_key
  ) ON DELETE RESTRICT,
  CONSTRAINT index_inventory_name_uq UNIQUE (project_id, index_name),
  CONSTRAINT index_inventory_signature_uq UNIQUE (project_id, physical_signature)
);

CREATE TABLE runtime.generation_measurements (
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  measurement_id uuid NOT NULL,
  object_row_count bigint NOT NULL CHECK (object_row_count >= 0),
  link_row_count bigint NOT NULL CHECK (link_row_count >= 0),
  heap_bytes bigint NOT NULL CHECK (heap_bytes >= 0),
  fixed_index_bytes bigint NOT NULL CHECK (fixed_index_bytes >= 0),
  dynamic_index_bytes bigint NOT NULL CHECK (dynamic_index_bytes >= 0),
  scanner_version varchar(128) NOT NULL CHECK (btrim(scanner_version) <> ''),
  inventory_revision bigint NOT NULL CHECK (inventory_revision >= 1),
  measurement_digest varchar(71) NOT NULL
    CHECK (measurement_digest ~ '^sha256:[0-9a-f]{64}$'),
  measured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, measurement_id),
  CONSTRAINT generation_measurements_generation_fk FOREIGN KEY (project_id, generation_id)
    REFERENCES runtime.generations(project_id, generation_id) ON DELETE RESTRICT,
  CONSTRAINT generation_measurements_generation_uq UNIQUE (project_id, generation_id),
  CONSTRAINT generation_measurements_digest_uq UNIQUE (project_id, measurement_digest)
);

CREATE TABLE runtime.capacity_approvals (
  project_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('release', 'project_steady', 'project_peak', 'index')),
  scope_id uuid,
  approved_limit_bytes bigint NOT NULL CHECK (approved_limit_bytes > 0),
  hard_limit_bytes bigint NOT NULL CHECK (hard_limit_bytes > 0),
  approved_by_principal_id uuid NOT NULL
    REFERENCES authz.principals(principal_id) ON DELETE RESTRICT,
  evidence_digest varchar(71) NOT NULL
    CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked', 'expired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, approval_id),
  CONSTRAINT capacity_approvals_project_fk FOREIGN KEY (project_id)
    REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  CONSTRAINT capacity_approvals_hard_limit_ck
    CHECK (approved_limit_bytes <= hard_limit_bytes),
  CONSTRAINT capacity_approvals_expiry_ck
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CONSTRAINT capacity_approvals_evidence_uq UNIQUE (project_id, evidence_digest)
);

CREATE TABLE ops.materialization_jobs (
  project_id uuid NOT NULL,
  job_id uuid NOT NULL,
  snapshot_group_id uuid NOT NULL,
  group_version bigint NOT NULL CHECK (group_version >= 1),
  idempotency_key varchar(128) NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$'),
  input_digest varchar(71) NOT NULL
    CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'retry_wait', 'succeeded', 'dead_letter', 'cancelled')),
  current_stage text CHECK (current_stage IS NULL OR current_stage IN (
    'scan', 'map', 'validate', 'build_stage', 'build_index',
    'ready_for_activation', 'catch_up', 'activate'
  )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000000),
  current_attempt_id uuid,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_owner_id uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  result_code varchar(128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, job_id),
  CONSTRAINT materialization_jobs_group_fk FOREIGN KEY (
    project_id, snapshot_group_id, group_version
  ) REFERENCES runtime.snapshot_group_versions(
    project_id, snapshot_group_id, group_version
  ) ON DELETE RESTRICT,
  CONSTRAINT materialization_jobs_idempotency_uq UNIQUE (project_id, idempotency_key),
  CONSTRAINT materialization_jobs_lease_shape_ck CHECK (
    (state = 'queued' AND attempt_count = 0 AND fencing_token = 0
      AND current_attempt_id IS NULL AND lease_owner_id IS NULL
      AND lease_expires_at IS NULL AND heartbeat_at IS NULL AND current_stage IS NULL)
    OR (state = 'running' AND attempt_count >= 1 AND fencing_token >= 1
      AND current_attempt_id IS NOT NULL AND lease_owner_id IS NOT NULL
      AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL)
    OR (state IN ('retry_wait', 'succeeded', 'dead_letter', 'cancelled')
      AND lease_owner_id IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT materialization_jobs_attempt_binding_uq
    UNIQUE (project_id, job_id, fencing_token, current_attempt_id)
);

CREATE INDEX materialization_jobs_claim_idx
  ON ops.materialization_jobs(state, lease_expires_at, created_at, project_id, job_id);

CREATE TABLE ops.materialization_attempts (
  project_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  job_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number >= 1),
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  worker_instance_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'leased'
    CHECK (state IN ('leased', 'completed', 'abandoned', 'failed')),
  leased_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  finished_at timestamptz,
  result_code varchar(128),
  PRIMARY KEY (project_id, attempt_id),
  CONSTRAINT materialization_attempts_job_fk FOREIGN KEY (project_id, job_id)
    REFERENCES ops.materialization_jobs(project_id, job_id) ON DELETE RESTRICT,
  CONSTRAINT materialization_attempts_number_uq
    UNIQUE (project_id, job_id, attempt_number),
  CONSTRAINT materialization_attempts_fencing_uq
    UNIQUE (project_id, job_id, fencing_token),
  CONSTRAINT materialization_attempts_write_binding_uq
    UNIQUE (project_id, attempt_id, job_id, fencing_token),
  CONSTRAINT materialization_attempts_finished_ck CHECK (
    (state = 'leased' AND finished_at IS NULL)
    OR (state <> 'leased' AND finished_at IS NOT NULL)
  )
);

CREATE TABLE ops.materialization_staged_batches (
  project_id uuid NOT NULL,
  job_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  fencing_token bigint NOT NULL,
  batch_sequence bigint NOT NULL CHECK (batch_sequence >= 1),
  batch_digest varchar(71) NOT NULL
    CHECK (batch_digest ~ '^sha256:[0-9a-f]{64}$'),
  row_count bigint NOT NULL CHECK (row_count >= 0),
  checkpoint_id uuid,
  checkpoint_sequence bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, attempt_id, batch_sequence),
  CONSTRAINT materialization_staged_batches_attempt_fk FOREIGN KEY (
    project_id, attempt_id, job_id, fencing_token
  ) REFERENCES ops.materialization_attempts(
    project_id, attempt_id, job_id, fencing_token
  ) ON DELETE RESTRICT,
  CONSTRAINT materialization_staged_batches_digest_uq
    UNIQUE (project_id, job_id, batch_digest),
  CONSTRAINT materialization_staged_batches_checkpoint_pair_ck
    CHECK ((checkpoint_id IS NULL) = (checkpoint_sequence IS NULL))
);

CREATE TABLE ops.materialization_checkpoints (
  project_id uuid NOT NULL,
  checkpoint_id uuid NOT NULL,
  job_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  fencing_token bigint NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 1),
  stage text NOT NULL CHECK (stage IN (
    'scan', 'map', 'validate', 'build_stage', 'build_index',
    'ready_for_activation', 'catch_up', 'activate'
  )),
  completed_batch_sequence bigint NOT NULL CHECK (completed_batch_sequence >= 1),
  output_digest varchar(71) NOT NULL
    CHECK (output_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, checkpoint_id),
  CONSTRAINT materialization_checkpoints_attempt_fk FOREIGN KEY (
    project_id, attempt_id, job_id, fencing_token
  ) REFERENCES ops.materialization_attempts(
    project_id, attempt_id, job_id, fencing_token
  ) ON DELETE RESTRICT,
  CONSTRAINT materialization_checkpoints_sequence_uq
    UNIQUE (project_id, job_id, sequence),
  CONSTRAINT materialization_checkpoints_output_uq
    UNIQUE (project_id, job_id, output_digest)
);

CREATE TABLE ops.materialization_error_samples (
  project_id uuid NOT NULL,
  error_sample_id uuid NOT NULL,
  report_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 49),
  reason_code text NOT NULL CHECK (reason_code IN (
    'PRIMARY_KEY_NULL', 'PRIMARY_KEY_DUPLICATE', 'REQUIRED_PROPERTY_INVALID',
    'OPTIONAL_PROPERTY_INVALID', 'REQUIRED_LINK_DANGLING', 'OPTIONAL_LINK_DANGLING'
  )),
  file_id uuid NOT NULL,
  row_number bigint NOT NULL CHECK (row_number >= 1),
  fingerprint varchar(71) NOT NULL
    CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, error_sample_id),
  CONSTRAINT materialization_error_samples_report_fk FOREIGN KEY (project_id, report_id)
    REFERENCES runtime.materialization_reports(project_id, report_id) ON DELETE RESTRICT,
  CONSTRAINT materialization_error_samples_report_ordinal_uq
    UNIQUE (project_id, report_id, ordinal),
  CONSTRAINT materialization_error_samples_report_fingerprint_uq
    UNIQUE (project_id, report_id, fingerprint)
);

ALTER TABLE runtime.materialization_reports
  ADD CONSTRAINT materialization_reports_job_fk FOREIGN KEY (project_id, job_id)
    REFERENCES ops.materialization_jobs(project_id, job_id) ON DELETE RESTRICT;

CREATE TABLE ops.gc_runs (
  project_id uuid NOT NULL,
  gc_run_id uuid NOT NULL,
  expected_state_revision bigint NOT NULL CHECK (expected_state_revision >= 1),
  expected_inventory_revision bigint NOT NULL CHECK (expected_inventory_revision >= 1),
  provider_registry_digest varchar(71) NOT NULL
    CHECK (provider_registry_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'scanning'
    CHECK (state IN ('scanning', 'planned', 'committed', 'stale', 'failed')),
  result_code varchar(128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, gc_run_id),
  CONSTRAINT gc_runs_project_fk FOREIGN KEY (project_id)
    REFERENCES meta.projects(project_id) ON DELETE RESTRICT
);

CREATE TABLE ops.gc_plans (
  project_id uuid NOT NULL,
  gc_plan_id uuid NOT NULL,
  gc_run_id uuid NOT NULL,
  state_revision bigint NOT NULL CHECK (state_revision >= 1),
  inventory_revision bigint NOT NULL CHECK (inventory_revision >= 1),
  protected_root_digest varchar(71) NOT NULL
    CHECK (protected_root_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'planned'
    CHECK (state IN ('planned', 'committed', 'stale', 'failed', 'cancelled')),
  plan_digest varchar(71) NOT NULL
    CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, gc_plan_id),
  CONSTRAINT gc_plans_run_fk FOREIGN KEY (project_id, gc_run_id)
    REFERENCES ops.gc_runs(project_id, gc_run_id) ON DELETE RESTRICT,
  CONSTRAINT gc_plans_run_uq UNIQUE (project_id, gc_run_id),
  CONSTRAINT gc_plans_digest_uq UNIQUE (project_id, plan_digest)
);

CREATE TABLE ops.gc_plan_candidates (
  project_id uuid NOT NULL,
  gc_plan_id uuid NOT NULL,
  candidate_kind text NOT NULL CHECK (candidate_kind IN ('generation', 'index')),
  candidate_key varchar(71) NOT NULL CHECK (
    candidate_key ~ '^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|sha256:[0-9a-f]{64})$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, gc_plan_id, candidate_kind, candidate_key),
  CONSTRAINT gc_plan_candidates_plan_fk FOREIGN KEY (project_id, gc_plan_id)
    REFERENCES ops.gc_plans(project_id, gc_plan_id) ON DELETE RESTRICT,
  CONSTRAINT gc_plan_candidates_key_shape_ck CHECK (
    (candidate_kind = 'generation' AND candidate_key ~ '^[0-9a-f]{8}-')
    OR (candidate_kind = 'index' AND candidate_key ~ '^sha256:')
  )
);

CREATE FUNCTION ontos_migration.g20203_validate_index_plan_entries() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20203_validate_index_plan_entries$
DECLARE
  affected_project_id uuid := COALESCE(NEW.project_id, OLD.project_id);
  affected_plan_id uuid := COALESCE(NEW.index_plan_id, OLD.index_plan_id);
  expected_count integer;
  actual_count integer;
BEGIN
  SELECT entry_count INTO expected_count FROM runtime.index_plans
  WHERE project_id = affected_project_id AND index_plan_id = affected_plan_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*)::integer INTO actual_count FROM runtime.index_plan_entries
  WHERE project_id = affected_project_id AND index_plan_id = affected_plan_id;
  IF actual_count <> expected_count THEN
    RAISE EXCEPTION 'G20203_INDEX_PLAN_ENTRY_COUNT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$g20203_validate_index_plan_entries$;

CREATE FUNCTION ontos_migration.g20203_enforce_inventory_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_inventory_update$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.state_revision < OLD.state_revision
    OR NEW.inventory_revision < OLD.inventory_revision
    OR NEW.state_revision > OLD.state_revision + 1
    OR NEW.inventory_revision > OLD.inventory_revision + 1
    OR NEW.changed_at < OLD.changed_at THEN
    RAISE EXCEPTION 'G20203_INVENTORY_REVISION_INVALID' USING ERRCODE = '40001';
  END IF;
  IF NEW.state_revision = OLD.state_revision
    AND NEW.inventory_revision = OLD.inventory_revision THEN
    RAISE EXCEPTION 'G20203_INVENTORY_REVISION_REQUIRED' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$g20203_inventory_update$;

CREATE FUNCTION ontos_migration.g20203_enforce_index_inventory_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_index_inventory_update$
DECLARE
  allowed boolean;
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.index_inventory_id IS DISTINCT FROM OLD.index_inventory_id
    OR NEW.index_plan_id IS DISTINCT FROM OLD.index_plan_id
    OR NEW.entry_key IS DISTINCT FROM OLD.entry_key
    OR NEW.index_name IS DISTINCT FROM OLD.index_name
    OR NEW.physical_signature IS DISTINCT FROM OLD.physical_signature
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'G20203_INDEX_INVENTORY_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  allowed := NEW.state = OLD.state
    OR (OLD.state = 'planned' AND NEW.state IN ('building', 'failed'))
    OR (OLD.state = 'building' AND NEW.state IN ('ready', 'failed'))
    OR (OLD.state = 'ready' AND NEW.state = 'retired');
  IF NOT allowed OR NEW.inventory_revision < OLD.inventory_revision THEN
    RAISE EXCEPTION 'G20203_INDEX_INVENTORY_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20203_index_inventory_update$;

CREATE FUNCTION ontos_migration.g20203_enforce_capacity_approval_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_capacity_approval_update$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
    OR NEW.scope IS DISTINCT FROM OLD.scope
    OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
    OR NEW.approved_limit_bytes IS DISTINCT FROM OLD.approved_limit_bytes
    OR NEW.hard_limit_bytes IS DISTINCT FROM OLD.hard_limit_bytes
    OR NEW.approved_by_principal_id IS DISTINCT FROM OLD.approved_by_principal_id
    OR NEW.evidence_digest IS DISTINCT FROM OLD.evidence_digest
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'G20203_CAPACITY_APPROVAL_FACT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
    AND NOT (OLD.state = 'active' AND NEW.state IN ('revoked', 'expired')) THEN
    RAISE EXCEPTION 'G20203_CAPACITY_APPROVAL_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20203_capacity_approval_update$;

CREATE FUNCTION ontos_migration.g20203_stage_rank(p_stage text) RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $g20203_stage_rank$
  SELECT CASE p_stage
    WHEN 'scan' THEN 1 WHEN 'map' THEN 2 WHEN 'validate' THEN 3
    WHEN 'build_stage' THEN 4 WHEN 'build_index' THEN 5
    WHEN 'ready_for_activation' THEN 6 WHEN 'catch_up' THEN 7
    WHEN 'activate' THEN 8 ELSE 0 END
$g20203_stage_rank$;

CREATE FUNCTION ontos_migration.g20203_enforce_job_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_job_insert$
BEGIN
  IF NEW.state <> 'queued' OR NEW.current_stage IS NOT NULL
    OR NEW.attempt_count <> 0 OR NEW.fencing_token <> 0
    OR NEW.current_attempt_id IS NOT NULL OR NEW.lease_owner_id IS NOT NULL
    OR NEW.lease_expires_at IS NOT NULL OR NEW.heartbeat_at IS NOT NULL
    OR NEW.result_code IS NOT NULL THEN
    RAISE EXCEPTION 'G20203_JOB_INITIAL_STATE_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20203_job_insert$;

CREATE FUNCTION ontos_migration.g20203_enforce_job_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_job_update$
DECLARE
  state_allowed boolean;
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.snapshot_group_id IS DISTINCT FROM OLD.snapshot_group_id
    OR NEW.group_version IS DISTINCT FROM OLD.group_version
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.input_digest IS DISTINCT FROM OLD.input_digest
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'G20203_JOB_FACT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  state_allowed := NEW.state = OLD.state
    OR (OLD.state = 'queued' AND NEW.state IN ('running', 'cancelled'))
    OR (OLD.state = 'running' AND NEW.state IN (
      'retry_wait', 'succeeded', 'dead_letter', 'cancelled'
    ))
    OR (OLD.state = 'retry_wait' AND NEW.state IN ('running', 'cancelled'));
  IF NOT state_allowed THEN
    RAISE EXCEPTION 'G20203_JOB_STATE_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;

  IF NEW.fencing_token = OLD.fencing_token + 1 THEN
    IF NEW.state <> 'running' OR NEW.attempt_count <> OLD.attempt_count + 1
      OR NEW.current_attempt_id IS NULL OR NEW.lease_owner_id IS NULL
      OR NEW.lease_expires_at IS NULL OR NEW.heartbeat_at IS NULL THEN
      RAISE EXCEPTION 'G20203_JOB_LEASE_TRANSITION_INVALID' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.fencing_token <> OLD.fencing_token
    OR NEW.attempt_count <> OLD.attempt_count
    OR NEW.current_attempt_id IS DISTINCT FROM OLD.current_attempt_id THEN
    RAISE EXCEPTION 'G20203_JOB_FENCING_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;

  IF OLD.current_stage IS NOT NULL AND NEW.current_stage IS NOT NULL
    AND ontos_migration.g20203_stage_rank(NEW.current_stage)
      < ontos_migration.g20203_stage_rank(OLD.current_stage) THEN
    RAISE EXCEPTION 'G20203_JOB_STAGE_REGRESSION' USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'G20203_JOB_TIME_REGRESSION' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20203_job_update$;

CREATE FUNCTION ontos_migration.g20203_enforce_attempt_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_attempt_update$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
    OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token
    OR NEW.worker_instance_id IS DISTINCT FROM OLD.worker_instance_id
    OR NEW.leased_at IS DISTINCT FROM OLD.leased_at
    OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at THEN
    RAISE EXCEPTION 'G20203_ATTEMPT_FACT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
    AND NOT (OLD.state = 'leased' AND NEW.state IN ('completed', 'abandoned', 'failed')) THEN
    RAISE EXCEPTION 'G20203_ATTEMPT_STATE_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20203_attempt_update$;

CREATE FUNCTION ontos_migration.g20203_enforce_staged_batch_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_staged_batch_update$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token
    OR NEW.batch_sequence IS DISTINCT FROM OLD.batch_sequence
    OR NEW.batch_digest IS DISTINCT FROM OLD.batch_digest
    OR NEW.row_count IS DISTINCT FROM OLD.row_count
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.checkpoint_id IS NOT NULL
    OR NEW.checkpoint_id IS NULL
    OR NEW.checkpoint_sequence IS NULL THEN
    RAISE EXCEPTION 'G20203_STAGED_BATCH_MUTATION_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20203_staged_batch_update$;

CREATE FUNCTION ontos_migration.g20203_enforce_gc_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_gc_update$
DECLARE
  allowed boolean := false;
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'G20203_GC_FACT_IMMUTABLE:%', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'gc_runs' THEN
    IF NEW.gc_run_id IS DISTINCT FROM OLD.gc_run_id
      OR NEW.expected_state_revision IS DISTINCT FROM OLD.expected_state_revision
      OR NEW.expected_inventory_revision IS DISTINCT FROM OLD.expected_inventory_revision
      OR NEW.provider_registry_digest IS DISTINCT FROM OLD.provider_registry_digest THEN
      RAISE EXCEPTION 'G20203_GC_FACT_IMMUTABLE:gc_runs' USING ERRCODE = '55000';
    END IF;
    allowed := NEW.state = OLD.state
      OR (OLD.state = 'scanning' AND NEW.state IN ('planned', 'failed', 'stale'))
      OR (OLD.state = 'planned' AND NEW.state IN ('committed', 'failed', 'stale'));
  ELSE
    IF NEW.gc_plan_id IS DISTINCT FROM OLD.gc_plan_id
      OR NEW.gc_run_id IS DISTINCT FROM OLD.gc_run_id
      OR NEW.state_revision IS DISTINCT FROM OLD.state_revision
      OR NEW.inventory_revision IS DISTINCT FROM OLD.inventory_revision
      OR NEW.protected_root_digest IS DISTINCT FROM OLD.protected_root_digest
      OR NEW.plan_digest IS DISTINCT FROM OLD.plan_digest THEN
      RAISE EXCEPTION 'G20203_GC_FACT_IMMUTABLE:gc_plans' USING ERRCODE = '55000';
    END IF;
    allowed := NEW.state = OLD.state
      OR (OLD.state = 'planned' AND NEW.state IN ('committed', 'stale', 'failed', 'cancelled'));
  END IF;
  IF NOT allowed OR NEW.changed_at < OLD.changed_at THEN
    RAISE EXCEPTION 'G20203_GC_STATE_TRANSITION_INVALID:%', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20203_gc_update$;

CREATE FUNCTION ops.claim_materialization_job(
  p_worker_instance_id uuid,
  p_attempt_id uuid,
  p_lease_seconds integer
) RETURNS TABLE (
  job_id uuid,
  attempt_id uuid,
  fencing_token bigint,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $claim_materialization_job$
DECLARE
  claimed ops.materialization_jobs%ROWTYPE;
  lease_deadline timestamptz;
BEGIN
  IF p_worker_instance_id IS NULL OR p_attempt_id IS NULL
    OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'G20203_JOB_CLAIM_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT candidate.* INTO claimed
  FROM ops.materialization_jobs AS candidate
  WHERE candidate.state IN ('queued', 'retry_wait')
    OR (candidate.state = 'running' AND candidate.lease_expires_at <= clock_timestamp())
  ORDER BY candidate.created_at, candidate.project_id, candidate.job_id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  lease_deadline := clock_timestamp() + p_lease_seconds * interval '1 second';
  UPDATE ops.materialization_attempts AS prior_attempt
  SET state = 'abandoned', finished_at = clock_timestamp(), result_code = 'LEASE_EXPIRED'
  WHERE prior_attempt.project_id = claimed.project_id
    AND prior_attempt.job_id = claimed.job_id
    AND prior_attempt.state = 'leased';

  UPDATE ops.materialization_jobs
  SET state = 'running',
      attempt_count = claimed.attempt_count + 1,
      current_attempt_id = p_attempt_id,
      fencing_token = claimed.fencing_token + 1,
      lease_owner_id = p_worker_instance_id,
      lease_expires_at = lease_deadline,
      heartbeat_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE project_id = claimed.project_id AND materialization_jobs.job_id = claimed.job_id;

  INSERT INTO ops.materialization_attempts (
    project_id, attempt_id, job_id, attempt_number, fencing_token,
    worker_instance_id, leased_at, lease_expires_at
  ) VALUES (
    claimed.project_id, p_attempt_id, claimed.job_id, claimed.attempt_count + 1,
    claimed.fencing_token + 1, p_worker_instance_id, clock_timestamp(), lease_deadline
  );

  RETURN QUERY SELECT claimed.job_id, p_attempt_id,
    claimed.fencing_token + 1, lease_deadline;
END
$claim_materialization_job$;

CREATE FUNCTION ops.write_materialization_staged_batch(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_batch_sequence bigint,
  p_batch_digest text,
  p_row_count bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $write_materialization_staged_batch$
DECLARE
  existing ops.materialization_staged_batches%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ops.materialization_jobs AS job
    WHERE job.project_id = p_project_id AND job.job_id = p_job_id
      AND job.state = 'running' AND job.current_attempt_id = p_attempt_id
      AND job.fencing_token = p_fencing_token
      AND job.lease_expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_FENCED' USING ERRCODE = '55000';
  END IF;
  IF p_batch_sequence < 1 OR p_row_count < 0
    OR p_batch_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'G20203_STAGED_BATCH_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO existing FROM ops.materialization_staged_batches
  WHERE project_id = p_project_id AND attempt_id = p_attempt_id
    AND batch_sequence = p_batch_sequence;
  IF FOUND THEN
    IF existing.job_id <> p_job_id OR existing.fencing_token <> p_fencing_token
      OR existing.batch_digest <> p_batch_digest OR existing.row_count <> p_row_count THEN
      RAISE EXCEPTION 'MATERIALIZATION_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN;
  END IF;

  INSERT INTO ops.materialization_staged_batches (
    project_id, job_id, attempt_id, fencing_token,
    batch_sequence, batch_digest, row_count
  ) VALUES (
    p_project_id, p_job_id, p_attempt_id, p_fencing_token,
    p_batch_sequence, p_batch_digest, p_row_count
  );
END
$write_materialization_staged_batch$;

CREATE FUNCTION ops.checkpoint_materialization_job(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_checkpoint_id uuid,
  p_sequence bigint,
  p_stage text,
  p_output_digest text,
  p_completed_batch_sequence bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $checkpoint_materialization_job$
DECLARE
  prior_sequence bigint;
  batch_count bigint;
  batch_min bigint;
  batch_max bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ops.materialization_jobs AS job
    WHERE job.project_id = p_project_id AND job.job_id = p_job_id
      AND job.state = 'running' AND job.current_attempt_id = p_attempt_id
      AND job.fencing_token = p_fencing_token
      AND job.lease_expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_FENCED' USING ERRCODE = '55000';
  END IF;
  IF ontos_migration.g20203_stage_rank(p_stage) = 0 OR p_sequence < 1
    OR p_completed_batch_sequence < 1
    OR p_output_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'G20203_CHECKPOINT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(max(sequence), 0) INTO prior_sequence
  FROM ops.materialization_checkpoints
  WHERE project_id = p_project_id AND job_id = p_job_id;
  IF p_sequence <> prior_sequence + 1 THEN
    RAISE EXCEPTION 'G20203_CHECKPOINT_SEQUENCE_INVALID' USING ERRCODE = '40001';
  END IF;

  SELECT count(*), min(batch_sequence), max(batch_sequence)
  INTO batch_count, batch_min, batch_max
  FROM ops.materialization_staged_batches
  WHERE project_id = p_project_id AND job_id = p_job_id
    AND attempt_id = p_attempt_id AND fencing_token = p_fencing_token
    AND batch_sequence <= p_completed_batch_sequence;
  IF batch_count <> p_completed_batch_sequence OR batch_min <> 1
    OR batch_max <> p_completed_batch_sequence THEN
    RAISE EXCEPTION 'G20203_CHECKPOINT_BATCH_GAP' USING ERRCODE = '23514';
  END IF;

  INSERT INTO ops.materialization_checkpoints (
    project_id, checkpoint_id, job_id, attempt_id, fencing_token,
    sequence, stage, completed_batch_sequence, output_digest
  ) VALUES (
    p_project_id, p_checkpoint_id, p_job_id, p_attempt_id, p_fencing_token,
    p_sequence, p_stage, p_completed_batch_sequence, p_output_digest
  );
  UPDATE ops.materialization_staged_batches
  SET checkpoint_id = p_checkpoint_id, checkpoint_sequence = p_sequence
  WHERE project_id = p_project_id AND job_id = p_job_id
    AND attempt_id = p_attempt_id AND fencing_token = p_fencing_token
    AND batch_sequence <= p_completed_batch_sequence
    AND checkpoint_id IS NULL;
  UPDATE ops.materialization_jobs
  SET current_stage = p_stage, heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE project_id = p_project_id AND job_id = p_job_id;
END
$checkpoint_materialization_job$;

CREATE FUNCTION runtime.issue_compatibility_certificate(
  p_certificate_id uuid,
  p_project_id uuid,
  p_generation_id uuid,
  p_target_release_id uuid,
  p_decision text,
  p_validator_version text,
  p_evidence_digest text
) RETURNS TABLE (certificate_id uuid, certificate_digest text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $issue_compatibility_certificate$
DECLARE
  generation runtime.generations%ROWTYPE;
  schema_digest text;
  mapping_digest text;
  preimage text;
  computed_digest text;
BEGIN
  IF p_decision NOT IN ('exact_pin', 'projection_equivalent')
    OR p_validator_version IS NULL OR btrim(p_validator_version) = ''
    OR p_evidence_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT candidate.* INTO generation FROM runtime.generations AS candidate
  JOIN runtime.materialization_reports AS report
    ON report.project_id = candidate.project_id AND report.report_id = candidate.report_id
   AND report.report_digest = candidate.report_digest AND report.outcome = 'passed'
  JOIN meta.release_runtime_plan_members AS plan
    ON plan.project_id = candidate.project_id AND plan.release_id = p_target_release_id
   AND plan.member_key = candidate.member_key
   AND plan.target_resource_id = candidate.target_resource_id
   AND plan.target_revision_id = candidate.target_revision_id
   AND plan.snapshot_group_id = candidate.snapshot_group_id
   AND plan.snapshot_schema_revision_id = candidate.snapshot_schema_revision_id
   AND plan.mapping_revision_id = candidate.mapping_revision_id
   AND plan.index_plan_digest = candidate.index_plan_digest
   AND plan.runtime_plan_digest = candidate.runtime_plan_digest
  WHERE candidate.project_id = p_project_id AND candidate.generation_id = p_generation_id
    AND candidate.state IN ('ready', 'active');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT content_digest INTO STRICT schema_digest FROM meta.resource_revisions
  WHERE revision_id = generation.snapshot_schema_revision_id
    AND resource_id = generation.snapshot_schema_resource_id;
  SELECT content_digest INTO STRICT mapping_digest FROM meta.resource_revisions
  WHERE revision_id = generation.mapping_revision_id
    AND resource_id = generation.mapping_resource_id;

  preimage := '{"contractVersion":"generation-compatibility-v1"' ||
    ',"decision":' || to_json(p_decision)::text ||
    ',"evidenceDigest":' || to_json(p_evidence_digest)::text ||
    ',"generationDigest":' || to_json(generation.generation_digest)::text ||
    ',"generationId":' || to_json(generation.generation_id::text)::text ||
    ',"indexPlanDigest":' || to_json(generation.index_plan_digest)::text ||
    ',"issuer":"materialization-compatibility-verifier"' ||
    ',"mappingDigest":' || to_json(mapping_digest)::text ||
    ',"mappingRevisionId":' || to_json(generation.mapping_revision_id::text)::text ||
    ',"projectId":' || to_json(generation.project_id::text)::text ||
    ',"runtimePlanDigest":' || to_json(generation.runtime_plan_digest)::text ||
    ',"schemaVersion":1' ||
    ',"snapshotGroupId":' || to_json(generation.snapshot_group_id::text)::text ||
    ',"snapshotSchemaDigest":' || to_json(schema_digest)::text ||
    ',"snapshotSchemaRevisionId":' || to_json(generation.snapshot_schema_revision_id::text)::text ||
    ',"targetMemberKey":' || to_json(generation.member_key)::text ||
    ',"targetReleaseId":' || to_json(p_target_release_id::text)::text ||
    ',"targetRevisionId":' || to_json(generation.target_revision_id::text)::text ||
    ',"validatorVersion":' || to_json(p_validator_version)::text || '}';
  computed_digest := 'sha256:' || encode(sha256(convert_to(preimage, 'UTF8')), 'hex');

  INSERT INTO runtime.compatibility_certificates (
    project_id, certificate_id, generation_id, generation_digest,
    target_release_id, target_member_key, target_resource_id, target_revision_id,
    snapshot_group_id, group_version,
    snapshot_schema_resource_id, snapshot_schema_revision_id, snapshot_schema_digest,
    mapping_resource_id, mapping_revision_id, mapping_digest,
    index_plan_digest, runtime_plan_digest, decision, validator_version,
    evidence_digest, certificate_digest
  ) VALUES (
    generation.project_id, p_certificate_id, generation.generation_id,
    generation.generation_digest, p_target_release_id, generation.member_key,
    generation.target_resource_id, generation.target_revision_id,
    generation.snapshot_group_id, generation.group_version,
    generation.snapshot_schema_resource_id, generation.snapshot_schema_revision_id, schema_digest,
    generation.mapping_resource_id, generation.mapping_revision_id, mapping_digest,
    generation.index_plan_digest, generation.runtime_plan_digest, p_decision,
    p_validator_version, p_evidence_digest, computed_digest
  );
  RETURN QUERY SELECT p_certificate_id, computed_digest;
END
$issue_compatibility_certificate$;

CREATE VIEW ops.materialization_job_status WITH (security_barrier = true) AS
SELECT project_id, job_id, snapshot_group_id, group_version, state, current_stage,
       attempt_count, fencing_token, lease_expires_at, cancel_requested,
       result_code, created_at, updated_at
FROM ops.materialization_jobs;

CREATE VIEW ops.gc_status WITH (security_barrier = true) AS
SELECT run.project_id, run.gc_run_id, run.state AS run_state,
       plan.gc_plan_id, plan.state AS plan_state,
       run.expected_state_revision, run.expected_inventory_revision,
       run.result_code, run.created_at, run.changed_at
FROM ops.gc_runs AS run
LEFT JOIN ops.gc_plans AS plan
  ON plan.project_id = run.project_id AND plan.gc_run_id = run.gc_run_id;

CREATE VIEW ops.runtime_inventory_status WITH (security_barrier = true) AS
SELECT project_id, state_revision, inventory_revision, measurement_complete, changed_at
FROM runtime.project_runtime_inventories;

CREATE TRIGGER project_runtime_inventories_controlled_update
BEFORE UPDATE ON runtime.project_runtime_inventories
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_enforce_inventory_update();
CREATE TRIGGER project_runtime_inventories_no_delete
BEFORE DELETE OR TRUNCATE ON runtime.project_runtime_inventories
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER index_plan_entries_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.index_plan_entries
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER index_inventory_controlled_update
BEFORE UPDATE ON runtime.index_inventory
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_enforce_index_inventory_update();
CREATE TRIGGER index_inventory_no_delete
BEFORE DELETE OR TRUNCATE ON runtime.index_inventory
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER generation_measurements_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.generation_measurements
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER capacity_approvals_controlled_update
BEFORE UPDATE ON runtime.capacity_approvals
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_enforce_capacity_approval_update();
CREATE TRIGGER capacity_approvals_no_delete
BEFORE DELETE OR TRUNCATE ON runtime.capacity_approvals
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();

CREATE TRIGGER materialization_jobs_initial_state
BEFORE INSERT ON ops.materialization_jobs
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_enforce_job_insert();
CREATE TRIGGER materialization_jobs_controlled_update
BEFORE UPDATE ON ops.materialization_jobs
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_enforce_job_update();
CREATE TRIGGER materialization_jobs_no_delete
BEFORE DELETE OR TRUNCATE ON ops.materialization_jobs
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER materialization_attempts_controlled_update
BEFORE UPDATE ON ops.materialization_attempts
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_enforce_attempt_update();
CREATE TRIGGER materialization_attempts_no_delete
BEFORE DELETE OR TRUNCATE ON ops.materialization_attempts
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER materialization_staged_batches_no_delete
BEFORE DELETE OR TRUNCATE ON ops.materialization_staged_batches
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER materialization_staged_batches_controlled_update
BEFORE UPDATE ON ops.materialization_staged_batches
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_enforce_staged_batch_update();
CREATE TRIGGER materialization_checkpoints_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.materialization_checkpoints
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER materialization_error_samples_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.materialization_error_samples
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER gc_plan_candidates_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.gc_plan_candidates
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER gc_runs_controlled_update
BEFORE UPDATE ON ops.gc_runs
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_enforce_gc_update();
CREATE TRIGGER gc_runs_no_delete
BEFORE DELETE OR TRUNCATE ON ops.gc_runs
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER gc_plans_controlled_update
BEFORE UPDATE ON ops.gc_plans
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_enforce_gc_update();
CREATE TRIGGER gc_plans_no_delete
BEFORE DELETE OR TRUNCATE ON ops.gc_plans
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();

CREATE CONSTRAINT TRIGGER index_plans_entries_complete
AFTER INSERT ON runtime.index_plans
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_index_plan_entries();
CREATE CONSTRAINT TRIGGER index_plan_entries_plan_complete
AFTER INSERT ON runtime.index_plan_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_index_plan_entries();

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA runtime, ops
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ops, runtime
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ontos_migration
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT SELECT, INSERT ON TABLE
  meta.release_runtime_plans,
  meta.release_runtime_plan_members,
  meta.runtime_activation_members
TO api_runtime;

GRANT SELECT ON TABLE
  meta.release_runtime_plans,
  meta.release_runtime_plan_members,
  meta.runtime_activation_members
TO worker_runtime;

GRANT SELECT ON TABLE
  runtime.snapshot_groups,
  runtime.snapshot_group_versions,
  runtime.index_plans,
  runtime.index_plan_entries,
  runtime.dataset_snapshots,
  runtime.snapshot_files,
  runtime.snapshot_group_members,
  runtime.materialization_reports,
  runtime.materialization_report_reasons,
  runtime.generations,
  runtime.compatibility_certificates,
  runtime.project_runtime_inventories,
  runtime.index_inventory,
  runtime.generation_measurements
TO api_runtime, worker_runtime;

GRANT INSERT ON TABLE
  runtime.snapshot_groups,
  runtime.snapshot_group_versions,
  runtime.index_plans,
  runtime.index_plan_entries,
  runtime.dataset_snapshots,
  runtime.snapshot_files,
  runtime.snapshot_group_members
TO api_runtime;

GRANT SELECT ON TABLE ops.materialization_jobs TO api_runtime, worker_runtime;
GRANT INSERT (
  project_id, job_id, snapshot_group_id, group_version, idempotency_key, input_digest
) ON ops.materialization_jobs TO api_runtime;

GRANT SELECT ON TABLE
  ops.materialization_attempts,
  ops.materialization_staged_batches,
  ops.materialization_checkpoints
TO worker_runtime;

GRANT SELECT ON TABLE
  ops.materialization_job_status,
  ops.gc_status,
  ops.runtime_inventory_status
TO read_only_ops;

GRANT EXECUTE ON FUNCTION
  ops.claim_materialization_job(uuid, uuid, integer),
  ops.write_materialization_staged_batch(uuid, uuid, uuid, bigint, bigint, text, bigint),
  ops.checkpoint_materialization_job(uuid, uuid, uuid, bigint, uuid, bigint, text, text, bigint)
TO worker_runtime;

GRANT EXECUTE ON FUNCTION
  runtime.issue_compatibility_certificate(uuid, uuid, uuid, uuid, text, text, text)
TO api_runtime;
