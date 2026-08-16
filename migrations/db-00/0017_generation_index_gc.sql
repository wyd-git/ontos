SET LOCAL ROLE migration_owner;

-- G2-02-12 completes the GC skeleton introduced by 0009. A plan is an
-- immutable, server-derived negative proof. Mutable columns below are only
-- progress cursors and the revisions advanced by that same plan.
ALTER TABLE ops.gc_runs
  ADD COLUMN idempotency_key_digest varchar(71)
    CHECK (idempotency_key_digest IS NULL OR idempotency_key_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN observed_at timestamptz,
  ADD COLUMN blocked_reasons jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(blocked_reasons) = 'array'),
  ADD COLUMN root_state_digest varchar(71)
    CHECK (root_state_digest IS NULL OR root_state_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN protected_root_digest varchar(71)
    CHECK (protected_root_digest IS NULL OR protected_root_digest ~ '^sha256:[0-9a-f]{64}$');

UPDATE ops.gc_runs
SET idempotency_key_digest = 'sha256:' || encode(sha256(convert_to(
      project_id::text || ':' || gc_run_id::text, 'UTF8')), 'hex'),
    observed_at = created_at,
    root_state_digest = 'sha256:' || repeat('0', 64),
    protected_root_digest = 'sha256:' || repeat('0', 64)
WHERE idempotency_key_digest IS NULL;

ALTER TABLE ops.gc_runs
  ALTER COLUMN idempotency_key_digest SET NOT NULL,
  ALTER COLUMN observed_at SET NOT NULL,
  ALTER COLUMN root_state_digest SET NOT NULL,
  ALTER COLUMN protected_root_digest SET NOT NULL,
  ADD CONSTRAINT gc_runs_idempotency_uq UNIQUE (project_id, idempotency_key_digest);

ALTER TABLE ops.gc_runs DROP CONSTRAINT gc_runs_state_check;
ALTER TABLE ops.gc_runs ADD CONSTRAINT gc_runs_state_ck CHECK (
  state IN ('scanning', 'blocked', 'planned', 'committing',
            'waiting_for_index_ddl', 'committed', 'stale', 'failed')
);

ALTER TABLE ops.gc_plans
  ADD COLUMN observed_at timestamptz,
  ADD COLUMN root_state_digest varchar(71)
    CHECK (root_state_digest IS NULL OR root_state_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN provider_registry_digest varchar(71)
    CHECK (provider_registry_digest IS NULL OR provider_registry_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN entry_count integer NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  ADD COLUMN reclaimable_bytes bigint NOT NULL DEFAULT 0 CHECK (reclaimable_bytes >= 0),
  ADD COLUMN current_state_revision bigint CHECK (current_state_revision IS NULL OR current_state_revision >= 1),
  ADD COLUMN current_inventory_revision bigint CHECK (current_inventory_revision IS NULL OR current_inventory_revision >= 1),
  ADD COLUMN phase text NOT NULL DEFAULT 'ORPHAN_UPLOAD' CHECK (phase IN (
    'ORPHAN_UPLOAD', 'HEAD_SET', 'PROVENANCE', 'CURRENT', 'BASE',
    'REPORT', 'ATTEMPT', 'GENERATION', 'INDEX_REQUEST', 'DONE'
  )),
  ADD COLUMN commit_started_at timestamptz,
  ADD COLUMN completed_at timestamptz;

UPDATE ops.gc_plans AS plan
SET observed_at = plan.created_at,
    root_state_digest = 'sha256:' || repeat('0', 64),
    provider_registry_digest = run.provider_registry_digest,
    current_state_revision = plan.state_revision,
    current_inventory_revision = plan.inventory_revision
FROM ops.gc_runs AS run
WHERE run.project_id = plan.project_id AND run.gc_run_id = plan.gc_run_id;

ALTER TABLE ops.gc_plans
  ALTER COLUMN observed_at SET NOT NULL,
  ALTER COLUMN root_state_digest SET NOT NULL,
  ALTER COLUMN provider_registry_digest SET NOT NULL,
  ALTER COLUMN current_state_revision SET NOT NULL,
  ALTER COLUMN current_inventory_revision SET NOT NULL;

ALTER TABLE ops.gc_plans DROP CONSTRAINT gc_plans_state_check;
ALTER TABLE ops.gc_plans ADD CONSTRAINT gc_plans_state_ck CHECK (
  state IN ('planned', 'committing', 'waiting_for_index_ddl',
            'committed', 'stale', 'failed', 'cancelled')
);

CREATE TABLE ops.gc_root_provider_registry (
  capability_key varchar(128) PRIMARY KEY
    CHECK (capability_key ~ '^[a-z][a-z0-9.-]{2,127}$'),
  capability_state text NOT NULL CHECK (capability_state IN ('ACTIVE', 'INACTIVE')),
  expected_version varchar(64) NOT NULL CHECK (btrim(expected_version) <> ''),
  root_kind text NOT NULL CHECK (root_kind IN (
    'CHANNEL', 'SERVING_HEAD', 'ACTIVE_JOB', 'CURRENT_HEAD_SET',
    'PREPARED_CUTOVER', 'PREFLIGHT_TOKEN', 'QUERY_LEASE',
    'INVESTIGATION_HOLD', 'HISTORICAL_ACTION', 'HISTORICAL_CHANGESET',
    'HISTORICAL_ARTIFACT', 'HISTORICAL_ACTIVATION'
  )),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE ops.gc_root_epochs (
  project_id uuid PRIMARY KEY,
  root_revision bigint NOT NULL DEFAULT 1 CHECK (root_revision >= 1),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT gc_root_epochs_project_fk FOREIGN KEY (project_id)
    REFERENCES meta.projects(project_id) ON DELETE RESTRICT
);
INSERT INTO ops.gc_root_epochs (project_id)
SELECT project_id FROM meta.projects;

INSERT INTO ops.gc_root_provider_registry (
  capability_key, capability_state, expected_version, root_kind
) VALUES
  ('materialization.channel', 'ACTIVE', 'v1', 'CHANNEL'),
  ('materialization.serving-head', 'ACTIVE', 'v1', 'SERVING_HEAD'),
  ('materialization.active-job', 'ACTIVE', 'v1', 'ACTIVE_JOB'),
  ('materialization.current-head-set', 'ACTIVE', 'v1', 'CURRENT_HEAD_SET'),
  ('materialization.prepared-cutover', 'ACTIVE', 'v1', 'PREPARED_CUTOVER'),
  ('materialization.activation-history', 'ACTIVE', 'v1', 'HISTORICAL_ACTIVATION'),
  ('runtime.preflight-token', 'INACTIVE', 'v1', 'PREFLIGHT_TOKEN'),
  ('runtime.query-lease', 'INACTIVE', 'v1', 'QUERY_LEASE'),
  ('runtime.investigation-hold', 'INACTIVE', 'v1', 'INVESTIGATION_HOLD'),
  ('runtime.historical-action', 'INACTIVE', 'v1', 'HISTORICAL_ACTION'),
  ('runtime.historical-changeset', 'INACTIVE', 'v1', 'HISTORICAL_CHANGESET'),
  ('runtime.historical-artifact', 'INACTIVE', 'v1', 'HISTORICAL_ARTIFACT');

CREATE TABLE ops.gc_root_provider_scans (
  project_id uuid NOT NULL,
  gc_run_id uuid NOT NULL,
  capability_key varchar(128) NOT NULL,
  status text NOT NULL CHECK (status IN (
    'COMPLETE', 'INACTIVE', 'MISSING', 'FAILED', 'VERSION_MISMATCH'
  )),
  provider_version varchar(64),
  root_count bigint NOT NULL CHECK (root_count >= 0),
  root_digest varchar(71)
    CHECK (root_digest IS NULL OR root_digest ~ '^sha256:[0-9a-f]{64}$'),
  scanned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, gc_run_id, capability_key),
  CONSTRAINT gc_root_provider_scans_run_fk FOREIGN KEY (project_id, gc_run_id)
    REFERENCES ops.gc_runs(project_id, gc_run_id) ON DELETE RESTRICT,
  CONSTRAINT gc_root_provider_scans_capability_fk FOREIGN KEY (capability_key)
    REFERENCES ops.gc_root_provider_registry(capability_key) ON DELETE RESTRICT
);

CREATE TABLE ops.gc_plan_entries (
  project_id uuid NOT NULL,
  gc_plan_id uuid NOT NULL,
  entry_kind text NOT NULL CHECK (entry_kind IN (
    'GENERATION', 'HEAD_SET', 'INDEX', 'ATTEMPT_STAGING', 'ORPHAN_UPLOAD'
  )),
  entry_key varchar(128) NOT NULL CHECK (btrim(entry_key) <> ''),
  disposition text NOT NULL CHECK (disposition IN ('CANDIDATE', 'RETAINED', 'PROTECTED')),
  reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) >= 1),
  estimated_bytes bigint NOT NULL CHECK (estimated_bytes >= 0),
  index_impact jsonb NOT NULL CHECK (jsonb_typeof(index_impact) = 'array'),
  completed_at timestamptz,
  affected_rows bigint NOT NULL DEFAULT 0 CHECK (affected_rows >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, gc_plan_id, entry_kind, entry_key),
  CONSTRAINT gc_plan_entries_plan_fk FOREIGN KEY (project_id, gc_plan_id)
    REFERENCES ops.gc_plans(project_id, gc_plan_id) ON DELETE RESTRICT,
  CONSTRAINT gc_plan_entries_key_shape_ck CHECK (
    (entry_kind IN ('GENERATION', 'HEAD_SET', 'ATTEMPT_STAGING', 'ORPHAN_UPLOAD')
      AND entry_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (entry_kind = 'INDEX' AND entry_key ~ '^sha256:[0-9a-f]{64}$')
  )
);
CREATE INDEX gc_plan_entries_pending_idx
  ON ops.gc_plan_entries(project_id, gc_plan_id, entry_kind, entry_key)
  WHERE disposition = 'CANDIDATE' AND completed_at IS NULL;

CREATE TABLE runtime.generation_collections (
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  gc_plan_id uuid NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, generation_id),
  CONSTRAINT generation_collections_generation_fk FOREIGN KEY (project_id, generation_id)
    REFERENCES runtime.generations(project_id, generation_id) ON DELETE RESTRICT,
  CONSTRAINT generation_collections_plan_fk FOREIGN KEY (project_id, gc_plan_id)
    REFERENCES ops.gc_plans(project_id, gc_plan_id) ON DELETE RESTRICT
);

CREATE TABLE runtime.head_set_collections (
  project_id uuid NOT NULL,
  head_set_id uuid NOT NULL,
  gc_plan_id uuid NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, head_set_id),
  CONSTRAINT head_set_collections_set_fk FOREIGN KEY (project_id, head_set_id)
    REFERENCES runtime.object_head_sets(project_id, head_set_id) ON DELETE RESTRICT,
  CONSTRAINT head_set_collections_plan_fk FOREIGN KEY (project_id, gc_plan_id)
    REFERENCES ops.gc_plans(project_id, gc_plan_id) ON DELETE RESTRICT
);

CREATE TABLE runtime.materialization_report_collections (
  project_id uuid NOT NULL,
  report_id uuid NOT NULL,
  gc_plan_id uuid NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, report_id),
  CONSTRAINT materialization_report_collections_report_fk FOREIGN KEY (project_id, report_id)
    REFERENCES runtime.materialization_reports(project_id, report_id) ON DELETE RESTRICT,
  CONSTRAINT materialization_report_collections_plan_fk FOREIGN KEY (project_id, gc_plan_id)
    REFERENCES ops.gc_plans(project_id, gc_plan_id) ON DELETE RESTRICT
);

CREATE TABLE ops.materialization_attempt_collections (
  project_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  gc_plan_id uuid NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, attempt_id),
  CONSTRAINT materialization_attempt_collections_attempt_fk FOREIGN KEY (project_id, attempt_id)
    REFERENCES ops.materialization_attempts(project_id, attempt_id) ON DELETE RESTRICT,
  CONSTRAINT materialization_attempt_collections_plan_fk FOREIGN KEY (project_id, gc_plan_id)
    REFERENCES ops.gc_plans(project_id, gc_plan_id) ON DELETE RESTRICT
);

CREATE TABLE ops.gc_orphan_deletions (
  project_id uuid NOT NULL,
  gc_plan_id uuid NOT NULL,
  session_id uuid NOT NULL,
  entry_kind text NOT NULL DEFAULT 'ORPHAN_UPLOAD' CHECK (entry_kind = 'ORPHAN_UPLOAD'),
  object_key varchar(128) NOT NULL,
  object_version varchar(1024) NOT NULL,
  state text NOT NULL DEFAULT 'CLAIMED' CHECK (state IN ('CLAIMED', 'DELETED')),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  PRIMARY KEY (project_id, gc_plan_id, session_id),
  CONSTRAINT gc_orphan_deletions_plan_fk FOREIGN KEY (project_id, gc_plan_id)
    REFERENCES ops.gc_plans(project_id, gc_plan_id) ON DELETE RESTRICT,
  CONSTRAINT gc_orphan_deletions_session_fk FOREIGN KEY (project_id, session_id)
    REFERENCES runtime.snapshot_upload_sessions(project_id, session_id) ON DELETE RESTRICT,
  CONSTRAINT gc_orphan_deletions_state_shape_ck CHECK (
    (state = 'CLAIMED' AND deleted_at IS NULL)
    OR (state = 'DELETED' AND deleted_at IS NOT NULL)
  )
);

CREATE TABLE ops.gc_batch_events (
  project_id uuid NOT NULL,
  gc_plan_id uuid NOT NULL,
  batch_sequence bigint GENERATED ALWAYS AS IDENTITY,
  phase text NOT NULL,
  affected_rows bigint NOT NULL CHECK (affected_rows >= 0),
  state_revision bigint NOT NULL CHECK (state_revision >= 1),
  inventory_revision bigint NOT NULL CHECK (inventory_revision >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, gc_plan_id, batch_sequence),
  CONSTRAINT gc_batch_events_plan_fk FOREIGN KEY (project_id, gc_plan_id)
    REFERENCES ops.gc_plans(project_id, gc_plan_id) ON DELETE RESTRICT
);

CREATE TABLE ops.gc_execution_contexts (
  backend_pid integer NOT NULL,
  transaction_id bigint NOT NULL,
  project_id uuid NOT NULL,
  gc_plan_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (backend_pid, transaction_id),
  CONSTRAINT gc_execution_contexts_plan_fk FOREIGN KEY (project_id, gc_plan_id)
    REFERENCES ops.gc_plans(project_id, gc_plan_id) ON DELETE RESTRICT
);

ALTER TABLE ops.projection_ddl_requests
  ADD COLUMN gc_plan_id uuid,
  ADD COLUMN gc_plan_digest varchar(71)
    CHECK (gc_plan_digest IS NULL OR gc_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT projection_ddl_requests_gc_plan_fk FOREIGN KEY (project_id, gc_plan_id)
    REFERENCES ops.gc_plans(project_id, gc_plan_id) ON DELETE RESTRICT,
  ADD CONSTRAINT projection_ddl_requests_gc_shape_ck CHECK (
    (action = 'CREATE' AND gc_plan_id IS NULL AND gc_plan_digest IS NULL)
    OR (action = 'DROP' AND gc_plan_id IS NOT NULL AND gc_plan_digest IS NOT NULL)
  );

CREATE FUNCTION ontos_migration.g20212_registry_digest() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $g20212_registry_digest$
  SELECT 'sha256:' || encode(sha256(convert_to(COALESCE(string_agg(
    capability_key || '|' || capability_state || '|' || expected_version || '|' || root_kind,
    E'\n' ORDER BY capability_key COLLATE "C"
  ), '') || E'\n', 'UTF8')), 'hex')
  FROM ops.gc_root_provider_registry
$g20212_registry_digest$;

CREATE FUNCTION ontos_migration.g20212_root_state_digest(p_project_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $g20212_root_state_digest$
  WITH root_lines AS (
    SELECT 'root-revision|' || COALESCE((
      SELECT epoch.root_revision::text FROM ops.gc_root_epochs AS epoch
      WHERE epoch.project_id = p_project_id
    ), '0') AS line
    UNION ALL
    SELECT 'channel|' || channel.channel_name || '|' || member.generation_id::text
    FROM meta.release_channels AS channel
    JOIN meta.runtime_activation_members AS member
      ON member.release_id = channel.release_id
     AND member.activation_id = channel.activation_id
    WHERE channel.project_id = p_project_id
    UNION ALL
    SELECT 'serving|' || head.release_id::text || '|' || member.generation_id::text
    FROM meta.release_serving_heads AS head
    JOIN meta.releases AS release ON release.release_id = head.release_id
    JOIN meta.runtime_activation_members AS member
      ON member.release_id = head.release_id AND member.activation_id = head.activation_id
    WHERE release.project_id = p_project_id
      AND release.state IN ('ready', 'published', 'superseded')
    UNION ALL
    SELECT 'job|' || job.job_id::text || '|' || generation.generation_id::text || '|' || job.state
    FROM ops.materialization_jobs AS job
    JOIN runtime.generations AS generation
      ON generation.project_id = job.project_id
     AND generation.snapshot_group_id = job.snapshot_group_id
     AND generation.group_version = job.group_version
    WHERE job.project_id = p_project_id
      AND job.state IN ('queued', 'running', 'retry_wait')
    UNION ALL
    SELECT 'head|' || pointer.head_set_id::text || '|' || version.current_generation_id::text
    FROM runtime.project_object_head_pointers AS pointer
    JOIN runtime.object_head_versions AS version
      ON version.project_id = pointer.project_id AND version.head_set_id = pointer.head_set_id
    WHERE pointer.project_id = p_project_id
    UNION ALL
    SELECT 'inflight-head|' || head_set.head_set_id::text || '|' || version.current_generation_id::text
    FROM runtime.object_head_sets AS head_set
    JOIN runtime.object_head_versions AS version
      ON version.project_id = head_set.project_id AND version.head_set_id = head_set.head_set_id
    WHERE head_set.project_id = p_project_id AND head_set.state IN ('building', 'prepared')
    UNION ALL
    SELECT 'cutover|' || preparation.preparation_id::text || '|' || member.generation_id::text
    FROM runtime.snapshot_group_cutover_preparations AS preparation
    JOIN runtime.snapshot_group_cutover_member_candidates AS member
      ON member.project_id = preparation.project_id
     AND member.preparation_id = preparation.preparation_id
    WHERE preparation.project_id = p_project_id AND preparation.state IN ('preparing', 'prepared')
    UNION ALL
    SELECT 'activation|' || activation.activation_id::text || '|' || member.generation_id::text
    FROM meta.runtime_activations AS activation
    JOIN meta.releases AS activation_release
      ON activation_release.release_id = activation.release_id
    JOIN meta.runtime_activation_members AS member
      ON member.release_id = activation.release_id
     AND member.activation_id = activation.activation_id
    WHERE activation_release.project_id = p_project_id
    UNION ALL
    SELECT 'generation|' || generation.generation_id::text || '|' || generation.state || '|' ||
           extract(epoch FROM generation.changed_at)::text
    FROM runtime.generations AS generation
    WHERE generation.project_id = p_project_id
      AND NOT EXISTS (
        SELECT 1 FROM runtime.generation_collections AS collected
        WHERE collected.project_id = generation.project_id
          AND collected.generation_id = generation.generation_id
      )
    UNION ALL
    SELECT 'upload|' || session.session_id::text || '|' || session.state || '|' ||
           extract(epoch FROM session.changed_at)::text
    FROM runtime.snapshot_upload_sessions AS session
    WHERE session.project_id = p_project_id AND session.state <> 'cleaned'
  )
  SELECT 'sha256:' || encode(sha256(convert_to(COALESCE(string_agg(
    line, E'\n' ORDER BY line COLLATE "C"
  ), '') || E'\n', 'UTF8')), 'hex') FROM root_lines
$g20212_root_state_digest$;

-- Root mutations take the same Project advisory lock as the DDL Executor. A
-- DROP can therefore prove zero references, inspect the catalog and complete
-- without a Cutover or Job inserting a new reference in the middle.
CREATE FUNCTION ontos_migration.g20212_lock_gc_root_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20212_lock_gc_root_change$
DECLARE
  affected_project uuid;
BEGIN
  IF TG_TABLE_SCHEMA = 'meta'
    AND TG_TABLE_NAME IN ('release_serving_heads', 'runtime_activation_members') THEN
    SELECT release.project_id INTO affected_project
    FROM meta.releases AS release
    WHERE release.release_id = COALESCE(NEW.release_id, OLD.release_id);
  ELSE
    affected_project := COALESCE(NEW.project_id, OLD.project_id);
  END IF;
  IF affected_project IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(737217209, hashtext(affected_project::text));
    INSERT INTO ops.gc_root_epochs (project_id, root_revision, changed_at)
    VALUES (affected_project, 1, clock_timestamp())
    ON CONFLICT (project_id) DO UPDATE
    SET root_revision = ops.gc_root_epochs.root_revision + 1,
        changed_at = clock_timestamp();
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$g20212_lock_gc_root_change$;

CREATE TRIGGER release_channels_gc_serialization
BEFORE INSERT OR UPDATE OR DELETE ON meta.release_channels
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20212_lock_gc_root_change();
CREATE TRIGGER releases_gc_serialization
BEFORE INSERT OR UPDATE OR DELETE ON meta.releases
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20212_lock_gc_root_change();
CREATE TRIGGER release_serving_heads_gc_serialization
BEFORE INSERT OR UPDATE OR DELETE ON meta.release_serving_heads
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20212_lock_gc_root_change();
CREATE TRIGGER runtime_activation_members_gc_serialization
BEFORE INSERT OR UPDATE OR DELETE ON meta.runtime_activation_members
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20212_lock_gc_root_change();
CREATE TRIGGER materialization_jobs_gc_serialization
BEFORE INSERT OR UPDATE OR DELETE ON ops.materialization_jobs
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20212_lock_gc_root_change();
CREATE TRIGGER snapshot_upload_sessions_gc_serialization
BEFORE INSERT OR UPDATE OR DELETE ON runtime.snapshot_upload_sessions
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20212_lock_gc_root_change();
CREATE TRIGGER generations_gc_serialization
BEFORE INSERT OR UPDATE OR DELETE ON runtime.generations
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20212_lock_gc_root_change();
CREATE TRIGGER object_head_sets_gc_serialization
BEFORE INSERT OR UPDATE OR DELETE ON runtime.object_head_sets
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20212_lock_gc_root_change();
CREATE TRIGGER project_object_head_pointers_gc_serialization
BEFORE INSERT OR UPDATE OR DELETE ON runtime.project_object_head_pointers
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20212_lock_gc_root_change();
CREATE TRIGGER cutover_preparations_gc_serialization
BEFORE INSERT OR UPDATE OR DELETE ON runtime.snapshot_group_cutover_preparations
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20212_lock_gc_root_change();

CREATE FUNCTION ontos_migration.g20212_allow_gc_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20212_allow_gc_delete$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM ops.gc_execution_contexts AS context
    JOIN ops.gc_plans AS plan
      ON plan.project_id = context.project_id AND plan.gc_plan_id = context.gc_plan_id
    WHERE context.backend_pid = pg_backend_pid()
      AND context.transaction_id = txid_current()
      AND plan.state IN ('committing', 'waiting_for_index_ddl')
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'G20212_GC_MUTATION_FORBIDDEN:%', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$g20212_allow_gc_delete$;

-- Replace only the immutable triggers on physical/derived rows that GC owns.
DROP TRIGGER property_provenance_immutable ON runtime.property_provenance;
CREATE TRIGGER property_provenance_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.property_provenance
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER object_current_immutable ON runtime.object_current;
CREATE TRIGGER object_current_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.object_current
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER link_current_immutable ON runtime.link_current;
CREATE TRIGGER link_current_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.link_current
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER object_base_immutable ON runtime.object_base;
CREATE TRIGGER object_base_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.object_base
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER link_base_immutable ON runtime.link_base;
CREATE TRIGGER link_base_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.link_base
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER object_head_candidates_immutable ON runtime.object_head_candidates;
CREATE TRIGGER object_head_candidates_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.object_head_candidates
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER materialization_quality_observations_immutable ON ops.materialization_quality_observations;
CREATE TRIGGER materialization_quality_observations_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.materialization_quality_observations
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER materialization_provenance_templates_immutable ON ops.materialization_provenance_templates;
CREATE TRIGGER materialization_provenance_templates_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.materialization_provenance_templates
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER materialization_quality_preparations_immutable ON ops.materialization_quality_preparations;
CREATE TRIGGER materialization_quality_preparations_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.materialization_quality_preparations
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER object_base_staging_immutable ON ops.object_base_staging;
CREATE TRIGGER object_base_staging_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.object_base_staging
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER link_base_staging_immutable ON ops.link_base_staging;
CREATE TRIGGER link_base_staging_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.link_base_staging
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER materialization_generation_stage_batches_immutable ON ops.materialization_generation_stage_batches;
CREATE TRIGGER materialization_generation_stage_batches_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.materialization_generation_stage_batches
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER materialization_generation_stages_no_delete ON ops.materialization_generation_stages;
CREATE TRIGGER materialization_generation_stages_no_delete
BEFORE DELETE OR TRUNCATE ON ops.materialization_generation_stages
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER materialization_staged_batches_no_delete ON ops.materialization_staged_batches;
CREATE TRIGGER materialization_staged_batches_no_delete
BEFORE DELETE OR TRUNCATE ON ops.materialization_staged_batches
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER materialization_checkpoints_immutable ON ops.materialization_checkpoints;
CREATE TRIGGER materialization_checkpoints_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.materialization_checkpoints
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER materialization_job_error_samples_immutable ON ops.materialization_job_error_samples;
CREATE TRIGGER materialization_job_error_samples_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.materialization_job_error_samples
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER materialization_error_samples_immutable ON ops.materialization_error_samples;
CREATE TRIGGER materialization_error_samples_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.materialization_error_samples
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER rejected_row_sets_immutable ON runtime.rejected_row_sets;
CREATE TRIGGER rejected_row_sets_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.rejected_row_sets
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();
DROP TRIGGER materialization_report_reasons_immutable ON runtime.materialization_report_reasons;
CREATE TRIGGER materialization_report_reasons_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.materialization_report_reasons
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20212_allow_gc_delete();

CREATE VIEW ops.gc_provider_registry_status WITH (security_barrier = true) AS
SELECT capability_key, capability_state, expected_version, root_kind, changed_at,
       ontos_migration.g20212_registry_digest() AS registry_digest
FROM ops.gc_root_provider_registry;

CREATE VIEW ops.gc_generation_roots WITH (security_barrier = true) AS
SELECT DISTINCT channel.project_id, member.generation_id, 'CHANNEL'::text AS root_kind,
       channel.channel_name::text AS root_id,
       'materialization.channel'::text AS capability_key, NULL::timestamptz AS expires_at
FROM meta.release_channels AS channel
JOIN meta.runtime_activation_members AS member
  ON member.release_id = channel.release_id AND member.activation_id = channel.activation_id
UNION ALL
SELECT DISTINCT release.project_id, member.generation_id, 'SERVING_HEAD', head.release_id::text,
       'materialization.serving-head', NULL::timestamptz
FROM meta.release_serving_heads AS head
JOIN meta.releases AS release ON release.release_id = head.release_id
JOIN meta.runtime_activation_members AS member
  ON member.release_id = head.release_id AND member.activation_id = head.activation_id
WHERE release.state IN ('ready', 'published', 'superseded')
UNION ALL
SELECT DISTINCT job.project_id, generation.generation_id, 'ACTIVE_JOB', job.job_id::text,
       'materialization.active-job', NULL::timestamptz
FROM ops.materialization_jobs AS job
JOIN runtime.generations AS generation
  ON generation.project_id = job.project_id
 AND generation.snapshot_group_id = job.snapshot_group_id
 AND generation.group_version = job.group_version
WHERE job.state IN ('queued', 'running', 'retry_wait')
UNION ALL
SELECT DISTINCT pointer.project_id, version.current_generation_id, 'CURRENT_HEAD_SET',
       pointer.head_set_id::text, 'materialization.current-head-set', NULL::timestamptz
FROM runtime.project_object_head_pointers AS pointer
JOIN runtime.object_head_versions AS version
  ON version.project_id = pointer.project_id AND version.head_set_id = pointer.head_set_id
UNION ALL
SELECT DISTINCT head_set.project_id, version.current_generation_id, 'PREPARED_CUTOVER',
       head_set.head_set_id::text, 'materialization.prepared-cutover', NULL::timestamptz
FROM runtime.object_head_sets AS head_set
JOIN runtime.object_head_versions AS version
  ON version.project_id = head_set.project_id AND version.head_set_id = head_set.head_set_id
WHERE head_set.state IN ('building', 'prepared')
UNION ALL
SELECT DISTINCT preparation.project_id, member.generation_id, 'PREPARED_CUTOVER',
       preparation.preparation_id::text, 'materialization.prepared-cutover', NULL::timestamptz
FROM runtime.snapshot_group_cutover_preparations AS preparation
JOIN runtime.snapshot_group_cutover_member_candidates AS member
  ON member.project_id = preparation.project_id
 AND member.preparation_id = preparation.preparation_id
WHERE preparation.state IN ('preparing', 'prepared')
UNION ALL
SELECT DISTINCT activation_release.project_id, member.generation_id, 'HISTORICAL_ACTIVATION',
       activation.activation_id::text, 'materialization.activation-history', NULL::timestamptz
FROM meta.runtime_activations AS activation
JOIN meta.releases AS activation_release
  ON activation_release.release_id = activation.release_id
JOIN meta.runtime_activation_members AS member
  ON member.release_id = activation.release_id
 AND member.activation_id = activation.activation_id
WHERE activation_release.project_id IS NOT NULL;

CREATE VIEW ops.gc_live_provider_scans WITH (security_barrier = true) AS
SELECT project.project_id, registry.capability_key,
       CASE
         WHEN registry.capability_state = 'INACTIVE' THEN 'INACTIVE'
         WHEN registry.capability_key IN (
           'materialization.channel', 'materialization.serving-head',
           'materialization.active-job', 'materialization.current-head-set',
           'materialization.prepared-cutover', 'materialization.activation-history'
         ) THEN 'COMPLETE'
         ELSE 'MISSING'
       END AS status,
       CASE
         WHEN registry.capability_state = 'ACTIVE'
          AND registry.capability_key IN (
           'materialization.channel', 'materialization.serving-head',
           'materialization.active-job', 'materialization.current-head-set',
           'materialization.prepared-cutover', 'materialization.activation-history'
         ) THEN registry.expected_version
       END AS provider_version,
       CASE WHEN registry.capability_state = 'ACTIVE' THEN count(root.generation_id)
            ELSE 0 END::bigint AS root_count,
       CASE
         WHEN registry.capability_state = 'ACTIVE'
          AND registry.capability_key IN (
           'materialization.channel', 'materialization.serving-head',
           'materialization.active-job', 'materialization.current-head-set',
           'materialization.prepared-cutover', 'materialization.activation-history'
         ) THEN 'sha256:' || encode(sha256(convert_to(COALESCE(string_agg(
           root.root_kind || '|' || root.root_id || '|' || root.generation_id::text,
           E'\n' ORDER BY root.root_kind, root.root_id COLLATE "C", root.generation_id
         ), '') || E'\n', 'UTF8')), 'hex')
       END AS root_digest
FROM ops.gc_root_provider_registry AS registry
CROSS JOIN meta.projects AS project
LEFT JOIN ops.gc_generation_roots AS root
  ON root.project_id = project.project_id
 AND root.capability_key = registry.capability_key
GROUP BY project.project_id, registry.capability_key,
         registry.capability_state, registry.expected_version;

CREATE VIEW ops.gc_generation_inventory WITH (security_barrier = true) AS
SELECT generation.project_id, generation.generation_id, generation.member_key,
       CASE
         WHEN collected.generation_id IS NOT NULL THEN 'COLLECTED'
         WHEN generation.state = 'building' THEN 'STAGING'
         WHEN generation.state = 'failed' THEN 'FAILED_STAGING'
         ELSE upper(generation.state)
       END AS inventory_state,
       generation.created_at, generation.changed_at,
       CASE WHEN generation.state = 'retired' THEN generation.changed_at END AS left_serving_at,
       CASE
         WHEN measurement.generation_id IS NOT NULL
           THEN measurement.heap_bytes + measurement.fixed_index_bytes + measurement.dynamic_index_bytes
         WHEN generation.state IN ('building', 'failed') THEN COALESCE(physical.bytes, 0)
         ELSE NULL
       END AS measured_bytes,
       COALESCE(signatures.index_signatures, '[]'::jsonb) AS index_signatures
FROM runtime.generations AS generation
LEFT JOIN runtime.generation_collections AS collected
  ON collected.project_id = generation.project_id
 AND collected.generation_id = generation.generation_id
LEFT JOIN runtime.generation_measurements AS measurement
  ON measurement.project_id = generation.project_id
 AND measurement.generation_id = generation.generation_id
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

CREATE VIEW ops.gc_head_set_inventory WITH (security_barrier = true) AS
SELECT head_set.project_id, head_set.head_set_id,
       CASE WHEN collected.head_set_id IS NOT NULL THEN 'COLLECTED'
            ELSE upper(head_set.state) END AS inventory_state,
       head_set.created_at,
       COALESCE(sum(pg_column_size(version)), 0)::bigint AS measured_bytes,
       COALESCE(jsonb_agg(DISTINCT version.current_generation_id::text)
         FILTER (WHERE version.current_generation_id IS NOT NULL), '[]'::jsonb) AS generation_ids
FROM runtime.object_head_sets AS head_set
LEFT JOIN runtime.head_set_collections AS collected
  ON collected.project_id = head_set.project_id AND collected.head_set_id = head_set.head_set_id
LEFT JOIN runtime.object_head_versions AS version
  ON version.project_id = head_set.project_id AND version.head_set_id = head_set.head_set_id
GROUP BY head_set.project_id, head_set.head_set_id, head_set.state, head_set.created_at,
         collected.head_set_id;

CREATE VIEW ops.gc_index_inventory WITH (security_barrier = true) AS
SELECT project_id, physical_signature, index_name, upper(state) AS inventory_state,
       observed_bytes
FROM runtime.index_inventory;

CREATE VIEW ops.gc_attempt_inventory WITH (security_barrier = true) AS
SELECT attempt.project_id, attempt.attempt_id,
       CASE WHEN attempt.state = 'leased' THEN 'ACTIVE' ELSE 'TERMINAL' END AS inventory_state,
       attempt.finished_at,
       COALESCE(physical.measured_bytes, 0)::bigint AS measured_bytes,
       COALESCE(generations.generation_ids, '[]'::jsonb) AS generation_ids
FROM ops.materialization_attempts AS attempt
LEFT JOIN LATERAL (
  SELECT jsonb_agg(stage.generation_id::text ORDER BY stage.generation_id) AS generation_ids
  FROM ops.materialization_generation_stages AS stage
  WHERE stage.project_id = attempt.project_id AND stage.attempt_id = attempt.attempt_id
) AS generations ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(sum(bytes), 0)::bigint AS measured_bytes
  FROM (
    SELECT pg_column_size(row_value)::bigint AS bytes
    FROM ops.object_base_staging AS row_value
    WHERE row_value.project_id = attempt.project_id AND row_value.attempt_id = attempt.attempt_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM ops.link_base_staging AS row_value
    WHERE row_value.project_id = attempt.project_id AND row_value.attempt_id = attempt.attempt_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM ops.materialization_staged_batches AS row_value
    WHERE row_value.project_id = attempt.project_id AND row_value.attempt_id = attempt.attempt_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM ops.materialization_generation_stages AS row_value
    WHERE row_value.project_id = attempt.project_id AND row_value.attempt_id = attempt.attempt_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM ops.materialization_generation_stage_batches AS row_value
    WHERE row_value.project_id = attempt.project_id AND row_value.attempt_id = attempt.attempt_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM ops.materialization_checkpoints AS row_value
    WHERE row_value.project_id = attempt.project_id AND row_value.attempt_id = attempt.attempt_id
    UNION ALL
    SELECT pg_column_size(row_value)::bigint
    FROM ops.materialization_job_error_samples AS row_value
    WHERE row_value.project_id = attempt.project_id AND row_value.attempt_id = attempt.attempt_id
  ) AS attempt_rows
) AS physical ON true
WHERE NOT EXISTS (
  SELECT 1 FROM ops.materialization_attempt_collections AS collected
  WHERE collected.project_id = attempt.project_id AND collected.attempt_id = attempt.attempt_id
);

CREATE VIEW ops.gc_orphan_upload_inventory WITH (security_barrier = true) AS
SELECT session.project_id, session.session_id, upper(session.state) AS inventory_state,
       session.changed_at AS orphaned_at, session.cleanup_after,
       COALESCE(session.uploaded_byte_count, 0)::bigint AS measured_bytes,
       session.uploaded_object_version IS NOT NULL AS exact_version_known
FROM runtime.snapshot_upload_sessions AS session
WHERE session.state <> 'cleaned';

CREATE VIEW ops.gc_plan_status WITH (security_barrier = true) AS
SELECT plan.project_id, plan.gc_plan_id, plan.gc_run_id, plan.state,
       plan.state_revision, plan.inventory_revision,
       plan.current_state_revision, plan.current_inventory_revision,
       plan.protected_root_digest, plan.root_state_digest,
       plan.provider_registry_digest, plan.plan_digest, plan.phase,
       plan.entry_count, plan.reclaimable_bytes, plan.created_at,
       plan.commit_started_at, plan.completed_at
FROM ops.gc_plans AS plan;

CREATE VIEW ops.gc_plan_entry_status WITH (security_barrier = true) AS
SELECT project_id, gc_plan_id, entry_kind, entry_key, disposition,
       reasons, estimated_bytes, index_impact, completed_at, affected_rows
FROM ops.gc_plan_entries;

CREATE FUNCTION ontos_migration.g20212_phase_rank(p_phase text) RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $g20212_phase_rank$
  SELECT CASE p_phase
    WHEN 'ORPHAN_UPLOAD' THEN 1 WHEN 'HEAD_SET' THEN 2
    WHEN 'PROVENANCE' THEN 3 WHEN 'CURRENT' THEN 4
    WHEN 'BASE' THEN 5 WHEN 'REPORT' THEN 6
    WHEN 'ATTEMPT' THEN 7 WHEN 'GENERATION' THEN 8
    WHEN 'INDEX_REQUEST' THEN 9 WHEN 'DONE' THEN 10 ELSE 0 END
$g20212_phase_rank$;

CREATE OR REPLACE FUNCTION ontos_migration.g20203_enforce_gc_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20212_gc_update$
DECLARE
  allowed boolean := false;
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'G20212_GC_FACT_IMMUTABLE:%', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'gc_runs' THEN
    IF NEW.gc_run_id IS DISTINCT FROM OLD.gc_run_id
      OR NEW.expected_state_revision IS DISTINCT FROM OLD.expected_state_revision
      OR NEW.expected_inventory_revision IS DISTINCT FROM OLD.expected_inventory_revision
      OR NEW.provider_registry_digest IS DISTINCT FROM OLD.provider_registry_digest
      OR NEW.idempotency_key_digest IS DISTINCT FROM OLD.idempotency_key_digest
      OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
      OR NEW.blocked_reasons IS DISTINCT FROM OLD.blocked_reasons
      OR NEW.root_state_digest IS DISTINCT FROM OLD.root_state_digest
      OR NEW.protected_root_digest IS DISTINCT FROM OLD.protected_root_digest THEN
      RAISE EXCEPTION 'G20212_GC_FACT_IMMUTABLE:gc_runs' USING ERRCODE = '55000';
    END IF;
    allowed := NEW.state = OLD.state
      OR (OLD.state = 'planned' AND NEW.state IN ('committing', 'stale', 'failed'))
      OR (OLD.state = 'committing' AND NEW.state IN (
        'waiting_for_index_ddl', 'committed', 'stale', 'failed'))
      OR (OLD.state = 'waiting_for_index_ddl' AND NEW.state IN (
        'committing', 'committed', 'stale', 'failed'));
  ELSE
    IF NEW.gc_plan_id IS DISTINCT FROM OLD.gc_plan_id
      OR NEW.gc_run_id IS DISTINCT FROM OLD.gc_run_id
      OR NEW.state_revision IS DISTINCT FROM OLD.state_revision
      OR NEW.inventory_revision IS DISTINCT FROM OLD.inventory_revision
      OR NEW.protected_root_digest IS DISTINCT FROM OLD.protected_root_digest
      OR NEW.plan_digest IS DISTINCT FROM OLD.plan_digest
      OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
      OR NEW.provider_registry_digest IS DISTINCT FROM OLD.provider_registry_digest
      OR NEW.entry_count IS DISTINCT FROM OLD.entry_count
      OR NEW.reclaimable_bytes IS DISTINCT FROM OLD.reclaimable_bytes THEN
      RAISE EXCEPTION 'G20212_GC_FACT_IMMUTABLE:gc_plans' USING ERRCODE = '55000';
    END IF;
    allowed := NEW.state = OLD.state
      OR (OLD.state = 'planned' AND NEW.state IN ('committing', 'stale', 'failed', 'cancelled'))
      OR (OLD.state = 'committing' AND NEW.state IN (
        'waiting_for_index_ddl', 'committed', 'stale', 'failed'))
      OR (OLD.state = 'waiting_for_index_ddl' AND NEW.state IN (
        'committing', 'committed', 'stale', 'failed'));
    IF NEW.current_state_revision < OLD.current_state_revision
      OR NEW.current_inventory_revision < OLD.current_inventory_revision
      OR NEW.current_state_revision > OLD.current_state_revision + 1
      OR NEW.current_inventory_revision > OLD.current_inventory_revision + 1
      OR ontos_migration.g20212_phase_rank(NEW.phase)
         < ontos_migration.g20212_phase_rank(OLD.phase)
      OR (OLD.commit_started_at IS NOT NULL
          AND NEW.commit_started_at IS DISTINCT FROM OLD.commit_started_at)
      OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    THEN
      allowed := false;
    END IF;
  END IF;
  IF NOT allowed OR NEW.changed_at < OLD.changed_at THEN
    RAISE EXCEPTION 'G20212_GC_STATE_TRANSITION_INVALID:%', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20212_gc_update$;

CREATE OR REPLACE FUNCTION ontos_migration.g20209_enforce_ddl_request_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20212_ddl_request_update$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.action IS DISTINCT FROM OLD.action
    OR NEW.inventory_revision IS DISTINCT FROM OLD.inventory_revision
    OR NEW.index_plan_id IS DISTINCT FROM OLD.index_plan_id
    OR NEW.entry_key IS DISTINCT FROM OLD.entry_key
    OR NEW.gc_plan_id IS DISTINCT FROM OLD.gc_plan_id
    OR NEW.gc_plan_digest IS DISTINCT FROM OLD.gc_plan_digest
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NOT (
      (OLD.state IN ('APPROVED', 'FAILED', 'RUNNING') AND NEW.state = 'RUNNING')
      OR (OLD.state = 'RUNNING' AND NEW.state IN ('SUCCEEDED', 'FAILED'))
      OR (OLD.state = 'SUCCEEDED' AND NEW.state = 'FAILED')
    )
  THEN
    RAISE EXCEPTION 'G20212_DDL_REQUEST_MUTATION_FORBIDDEN' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20212_ddl_request_update$;

CREATE FUNCTION ontos_migration.g20212_assert_candidate_safety(
  p_project_id uuid,
  p_gc_plan_id uuid,
  p_at timestamptz
) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $g20212_assert_candidate_safety$
BEGIN
  -- Every Generation candidate must still be unrooted, outside the immutable
  -- seven-day floor and outside the two most recent successful inactive rows.
  IF EXISTS (
    WITH recent AS (
      SELECT generation_id, row_number() OVER (
        PARTITION BY member_key ORDER BY changed_at DESC, generation_id
      ) AS recency
      FROM runtime.generations AS generation
      WHERE generation.project_id = p_project_id
        AND generation.state IN ('ready', 'retired')
        AND NOT EXISTS (
          SELECT 1 FROM runtime.generation_collections AS collected
          WHERE collected.project_id = generation.project_id
            AND collected.generation_id = generation.generation_id
        )
    )
    SELECT 1
    FROM ops.gc_plan_entries AS entry
    LEFT JOIN runtime.generations AS generation
      ON generation.project_id = entry.project_id
     AND generation.generation_id::text = entry.entry_key
    LEFT JOIN recent ON recent.generation_id = generation.generation_id
    WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
      AND entry.entry_kind = 'GENERATION' AND entry.disposition = 'CANDIDATE'
      AND entry.completed_at IS NULL
      AND (
        generation.generation_id IS NULL
        OR generation.state = 'active'
        OR p_at - GREATEST(generation.created_at, generation.changed_at) < interval '7 days'
        OR recent.recency <= 2
        OR EXISTS (
          SELECT 1 FROM ops.gc_generation_roots AS root
          WHERE root.project_id = generation.project_id
            AND root.generation_id = generation.generation_id
        )
        OR EXISTS (
          SELECT 1 FROM runtime.object_head_versions AS version
          WHERE version.project_id = generation.project_id
            AND version.current_generation_id = generation.generation_id
            AND NOT EXISTS (
              SELECT 1 FROM ops.gc_plan_entries AS head_entry
              WHERE head_entry.project_id = entry.project_id
                AND head_entry.gc_plan_id = entry.gc_plan_id
                AND head_entry.entry_kind = 'HEAD_SET'
                AND head_entry.entry_key = version.head_set_id::text
                AND head_entry.disposition = 'CANDIDATE'
            )
        )
      )
  ) THEN
    RAISE EXCEPTION 'GC_PLAN_STALE' USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ops.gc_plan_entries AS entry
    LEFT JOIN runtime.object_head_sets AS head_set
      ON head_set.project_id = entry.project_id AND head_set.head_set_id::text = entry.entry_key
    WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
      AND entry.entry_kind = 'HEAD_SET' AND entry.disposition = 'CANDIDATE'
      AND entry.completed_at IS NULL
      AND (
        head_set.head_set_id IS NULL OR head_set.state <> 'retired'
        OR EXISTS (
          SELECT 1 FROM runtime.project_object_head_pointers AS pointer
          WHERE pointer.project_id = head_set.project_id AND pointer.head_set_id = head_set.head_set_id
        )
        OR EXISTS (
          SELECT 1 FROM runtime.object_head_versions AS version
          WHERE version.project_id = head_set.project_id AND version.head_set_id = head_set.head_set_id
            AND NOT EXISTS (
              SELECT 1 FROM runtime.generation_collections AS collected
              WHERE collected.project_id = version.project_id
                AND collected.generation_id = version.current_generation_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM ops.gc_plan_entries AS generation_entry
              WHERE generation_entry.project_id = entry.project_id
                AND generation_entry.gc_plan_id = entry.gc_plan_id
                AND generation_entry.entry_kind = 'GENERATION'
                AND generation_entry.entry_key = version.current_generation_id::text
                AND generation_entry.disposition = 'CANDIDATE'
            )
        )
      )
  ) THEN
    RAISE EXCEPTION 'GC_PLAN_STALE' USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ops.gc_plan_entries AS entry
    LEFT JOIN ops.materialization_attempts AS attempt
      ON attempt.project_id = entry.project_id AND attempt.attempt_id::text = entry.entry_key
    WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
      AND entry.entry_kind = 'ATTEMPT_STAGING' AND entry.disposition = 'CANDIDATE'
      AND entry.completed_at IS NULL
      AND (attempt.attempt_id IS NULL OR attempt.state = 'leased'
        OR attempt.finished_at IS NULL OR p_at - attempt.finished_at < interval '1 day'
        OR EXISTS (
          SELECT 1 FROM ops.materialization_generation_stages AS stage
          WHERE stage.project_id = attempt.project_id AND stage.attempt_id = attempt.attempt_id
            AND NOT EXISTS (
              SELECT 1 FROM runtime.generation_collections AS collected
              WHERE collected.project_id = stage.project_id
                AND collected.generation_id = stage.generation_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM ops.gc_plan_entries AS generation_entry
              WHERE generation_entry.project_id = entry.project_id
                AND generation_entry.gc_plan_id = entry.gc_plan_id
                AND generation_entry.entry_kind = 'GENERATION'
                AND generation_entry.entry_key = stage.generation_id::text
                AND generation_entry.disposition = 'CANDIDATE'
            )
        ))
  ) THEN
    RAISE EXCEPTION 'GC_PLAN_STALE' USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ops.gc_plan_entries AS entry
    LEFT JOIN runtime.snapshot_upload_sessions AS session
      ON session.project_id = entry.project_id AND session.session_id::text = entry.entry_key
    WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
      AND entry.entry_kind = 'ORPHAN_UPLOAD' AND entry.disposition = 'CANDIDATE'
      AND entry.completed_at IS NULL
      AND (session.session_id IS NULL OR session.state NOT IN ('failed', 'expired')
        OR session.uploaded_object_version IS NULL OR p_at < session.cleanup_after
        OR p_at - session.changed_at < interval '1 day')
  ) THEN
    RAISE EXCEPTION 'GC_PLAN_STALE' USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ops.gc_plan_entries AS entry
    LEFT JOIN runtime.index_inventory AS inventory
      ON inventory.project_id = entry.project_id
     AND inventory.physical_signature = entry.entry_key
    WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
      AND entry.entry_kind = 'INDEX' AND entry.disposition = 'CANDIDATE'
      AND entry.completed_at IS NULL
      AND (inventory.physical_signature IS NULL
        OR inventory.state NOT IN ('ready', 'retired')
        OR (inventory.state = 'retired' AND NOT EXISTS (
          SELECT 1 FROM ops.projection_ddl_requests AS request
          WHERE request.project_id = entry.project_id
            AND request.gc_plan_id = entry.gc_plan_id
            AND request.entry_key = inventory.entry_key
            AND request.action = 'DROP' AND request.state = 'SUCCEEDED'
        ))
        OR (inventory.state = 'ready' AND EXISTS (
          SELECT 1
          FROM runtime.generations AS generation
          JOIN runtime.index_plans AS plan
            ON plan.project_id = generation.project_id
           AND plan.plan_digest = generation.index_plan_digest
          JOIN runtime.index_plan_entries AS plan_entry
            ON plan_entry.project_id = plan.project_id
           AND plan_entry.index_plan_id = plan.index_plan_id
          WHERE generation.project_id = entry.project_id
            AND plan_entry.physical_signature = entry.entry_key
            AND NOT EXISTS (
              SELECT 1 FROM runtime.generation_collections AS collected
              WHERE collected.project_id = generation.project_id
                AND collected.generation_id = generation.generation_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM ops.gc_plan_entries AS generation_entry
              WHERE generation_entry.project_id = entry.project_id
                AND generation_entry.gc_plan_id = entry.gc_plan_id
                AND generation_entry.entry_kind = 'GENERATION'
                AND generation_entry.entry_key = generation.generation_id::text
                AND generation_entry.disposition = 'CANDIDATE'
            )
        )))
  ) THEN
    RAISE EXCEPTION 'GC_PLAN_STALE' USING ERRCODE = '40001';
  END IF;
END
$g20212_assert_candidate_safety$;

CREATE FUNCTION ops.persist_generation_gc_dry_run(
  p_project_id uuid,
  p_gc_run_id uuid,
  p_gc_plan_id uuid,
  p_idempotency_key_digest text,
  p_protected_root_digest text,
  p_plan_digest text,
  p_observed_at timestamptz,
  p_expected_state_revision bigint,
  p_expected_inventory_revision bigint,
  p_provider_registry_digest text,
  p_entries jsonb,
  p_provider_scans jsonb,
  p_blocked_reasons jsonb
) RETURNS TABLE (
  gc_run_id uuid,
  gc_plan_id uuid,
  plan_digest text,
  run_state text,
  replayed boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $persist_generation_gc_dry_run$
DECLARE
  inventory runtime.project_runtime_inventories%ROWTYPE;
  existing_run ops.gc_runs%ROWTYPE;
  existing_plan ops.gc_plans%ROWTYPE;
  live_registry_digest text;
  live_root_digest text;
  supplied_entry_count integer;
  supplied_reclaimable bigint;
BEGIN
  IF p_project_id IS NULL OR p_gc_run_id IS NULL
    OR p_idempotency_key_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_protected_root_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_provider_registry_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_observed_at > clock_timestamp() + interval '5 seconds'
    OR p_expected_state_revision < 1 OR p_expected_inventory_revision < 1
    OR jsonb_typeof(p_entries) <> 'array'
    OR jsonb_typeof(p_provider_scans) <> 'array'
    OR jsonb_typeof(p_blocked_reasons) <> 'array'
    OR ((p_gc_plan_id IS NULL) <> (p_plan_digest IS NULL))
    OR (p_plan_digest IS NOT NULL AND p_plan_digest !~ '^sha256:[0-9a-f]{64}$')
  THEN
    RAISE EXCEPTION 'G20212_GC_DRY_RUN_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(737217209, hashtext(p_project_id::text));
  SELECT run.* INTO existing_run
  FROM ops.gc_runs AS run
  WHERE run.project_id = p_project_id
    AND run.idempotency_key_digest = p_idempotency_key_digest;
  IF FOUND THEN
    SELECT plan.* INTO existing_plan
    FROM ops.gc_plans AS plan
    WHERE plan.project_id = existing_run.project_id AND plan.gc_run_id = existing_run.gc_run_id;
    RETURN QUERY SELECT existing_run.gc_run_id, existing_plan.gc_plan_id,
      existing_plan.plan_digest::text, existing_run.state, true;
    RETURN;
  END IF;

  SELECT candidate.* INTO inventory
  FROM runtime.project_runtime_inventories AS candidate
  WHERE candidate.project_id = p_project_id
  FOR UPDATE;
  IF NOT FOUND OR inventory.state_revision <> p_expected_state_revision
    OR inventory.inventory_revision <> p_expected_inventory_revision THEN
    RAISE EXCEPTION 'GC_PLAN_STALE' USING ERRCODE = '40001';
  END IF;

  live_registry_digest := ontos_migration.g20212_registry_digest();
  live_root_digest := ontos_migration.g20212_root_state_digest(p_project_id);
  IF live_registry_digest <> p_provider_registry_digest THEN
    RAISE EXCEPTION 'GC_REFERENCE_SCAN_INCOMPLETE' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ops.gc_root_provider_registry AS registry
    LEFT JOIN jsonb_to_recordset(p_provider_scans) AS scan(
      "capabilityKey" text, status text, "providerVersion" text,
      "rootCount" bigint, "rootDigest" text
    ) ON scan."capabilityKey" = registry.capability_key
    WHERE (registry.capability_state = 'ACTIVE' AND (
      scan."capabilityKey" IS NULL OR scan.status <> 'COMPLETE'
      OR scan."providerVersion" IS DISTINCT FROM registry.expected_version
      OR scan."rootCount" < 0 OR scan."rootDigest" !~ '^sha256:[0-9a-f]{64}$'
    )) OR (registry.capability_state = 'INACTIVE' AND (
      scan."capabilityKey" IS NULL OR scan.status <> 'INACTIVE'
      OR scan."providerVersion" IS NOT NULL OR scan."rootCount" <> 0
      OR scan."rootDigest" IS NOT NULL
    ))
  ) OR (SELECT count(*) FROM jsonb_to_recordset(p_provider_scans)
         AS scan("capabilityKey" text)) <>
       (SELECT count(*) FROM ops.gc_root_provider_registry)
     OR EXISTS (
       SELECT 1
       FROM ops.gc_live_provider_scans AS live
       LEFT JOIN jsonb_to_recordset(p_provider_scans) AS supplied(
         "capabilityKey" text, status text, "providerVersion" text,
         "rootCount" bigint, "rootDigest" text
       ) ON supplied."capabilityKey" = live.capability_key
       WHERE live.project_id = p_project_id
         AND (supplied."capabilityKey" IS NULL
           OR supplied.status IS DISTINCT FROM live.status
           OR supplied."providerVersion" IS DISTINCT FROM live.provider_version
           OR supplied."rootCount" IS DISTINCT FROM live.root_count
           OR supplied."rootDigest" IS DISTINCT FROM live.root_digest)
     )
  THEN
    IF p_gc_plan_id IS NOT NULL THEN
      RAISE EXCEPTION 'GC_REFERENCE_SCAN_INCOMPLETE' USING ERRCODE = '55000';
    END IF;
  END IF;

  IF p_gc_plan_id IS NULL THEN
    IF jsonb_array_length(p_entries) <> 0 OR jsonb_array_length(p_blocked_reasons) = 0 THEN
      RAISE EXCEPTION 'G20212_BLOCKED_PLAN_SHAPE_INVALID' USING ERRCODE = '22023';
    END IF;
    INSERT INTO ops.gc_runs (
      project_id, gc_run_id, expected_state_revision, expected_inventory_revision,
      provider_registry_digest, state, result_code, idempotency_key_digest,
      observed_at, blocked_reasons, root_state_digest, protected_root_digest
    ) VALUES (
      p_project_id, p_gc_run_id, p_expected_state_revision, p_expected_inventory_revision,
      p_provider_registry_digest, 'blocked', 'GC_REFERENCE_SCAN_INCOMPLETE',
      p_idempotency_key_digest, p_observed_at, p_blocked_reasons, live_root_digest,
      p_protected_root_digest
    );
  ELSE
    IF NOT inventory.measurement_complete OR jsonb_array_length(p_blocked_reasons) <> 0 THEN
      RAISE EXCEPTION 'GC_REFERENCE_SCAN_INCOMPLETE' USING ERRCODE = '55000';
    END IF;
    INSERT INTO ops.gc_runs (
      project_id, gc_run_id, expected_state_revision, expected_inventory_revision,
      provider_registry_digest, state, idempotency_key_digest,
      observed_at, blocked_reasons, root_state_digest, protected_root_digest
    ) VALUES (
      p_project_id, p_gc_run_id, p_expected_state_revision, p_expected_inventory_revision,
      p_provider_registry_digest, 'planned', p_idempotency_key_digest,
      p_observed_at, '[]'::jsonb, live_root_digest, p_protected_root_digest
    );
  END IF;

  INSERT INTO ops.gc_root_provider_scans (
    project_id, gc_run_id, capability_key, status, provider_version,
    root_count, root_digest, scanned_at
  )
  SELECT p_project_id, p_gc_run_id, scan."capabilityKey", scan.status,
         scan."providerVersion", scan."rootCount", scan."rootDigest", p_observed_at
  FROM jsonb_to_recordset(p_provider_scans) AS scan(
    "capabilityKey" text, status text, "providerVersion" text,
    "rootCount" bigint, "rootDigest" text
  );

  IF p_gc_plan_id IS NULL THEN
    RETURN QUERY SELECT p_gc_run_id, NULL::uuid, NULL::text, 'blocked'::text, false;
    RETURN;
  END IF;

  SELECT count(*)::integer,
         COALESCE(sum(CASE WHEN entry.disposition = 'CANDIDATE'
                           THEN entry."estimatedBytes"::bigint ELSE 0 END), 0)::bigint
  INTO supplied_entry_count, supplied_reclaimable
  FROM jsonb_to_recordset(p_entries) AS entry(
    "entryKind" text, "entryKey" text, disposition text,
    reasons jsonb, "estimatedBytes" text, "indexImpact" jsonb
  );

  INSERT INTO ops.gc_plans (
    project_id, gc_plan_id, gc_run_id, state_revision, inventory_revision,
    protected_root_digest, state, plan_digest, observed_at, root_state_digest,
    provider_registry_digest, entry_count, reclaimable_bytes,
    current_state_revision, current_inventory_revision
  ) VALUES (
    p_project_id, p_gc_plan_id, p_gc_run_id,
    p_expected_state_revision, p_expected_inventory_revision,
    p_protected_root_digest, 'planned', p_plan_digest, p_observed_at, live_root_digest,
    p_provider_registry_digest, supplied_entry_count, supplied_reclaimable,
    p_expected_state_revision, p_expected_inventory_revision
  );

  INSERT INTO ops.gc_plan_entries (
    project_id, gc_plan_id, entry_kind, entry_key, disposition,
    reasons, estimated_bytes, index_impact
  )
  SELECT p_project_id, p_gc_plan_id, entry."entryKind", entry."entryKey",
         entry.disposition, entry.reasons, entry."estimatedBytes"::bigint,
         entry."indexImpact"
  FROM jsonb_to_recordset(p_entries) AS entry(
    "entryKind" text, "entryKey" text, disposition text,
    reasons jsonb, "estimatedBytes" text, "indexImpact" jsonb
  );

  -- The application must describe the complete authoritative inventory, not
  -- merely a caller-selected deletion subset.
  IF EXISTS (
    WITH expected(entry_kind, entry_key, measured_bytes) AS (
      SELECT 'GENERATION', generation_id::text, measured_bytes
      FROM ops.gc_generation_inventory
      WHERE project_id = p_project_id AND inventory_state <> 'COLLECTED'
      UNION ALL
      SELECT 'HEAD_SET', head_set_id::text, measured_bytes
      FROM ops.gc_head_set_inventory
      WHERE project_id = p_project_id AND inventory_state <> 'COLLECTED'
      UNION ALL
      SELECT 'INDEX', physical_signature, observed_bytes
      FROM ops.gc_index_inventory
      WHERE project_id = p_project_id AND inventory_state <> 'RETIRED'
      UNION ALL
      SELECT 'ATTEMPT_STAGING', attempt_id::text, measured_bytes
      FROM ops.gc_attempt_inventory WHERE project_id = p_project_id
      UNION ALL
      SELECT 'ORPHAN_UPLOAD', session_id::text, measured_bytes
      FROM ops.gc_orphan_upload_inventory WHERE project_id = p_project_id
    ), supplied AS (
      SELECT persisted_entry.entry_kind, persisted_entry.entry_key,
             persisted_entry.estimated_bytes
      FROM ops.gc_plan_entries AS persisted_entry
      WHERE persisted_entry.project_id = p_project_id
        AND persisted_entry.gc_plan_id = p_gc_plan_id
    )
    SELECT 1
    FROM expected FULL JOIN supplied USING (entry_kind, entry_key)
    WHERE expected.entry_key IS NULL OR supplied.entry_key IS NULL
      OR expected.measured_bytes IS NULL
      OR expected.measured_bytes <> supplied.estimated_bytes
  ) OR EXISTS (
    SELECT 1 FROM ops.gc_index_inventory
    WHERE project_id = p_project_id
      AND inventory_state IN ('PLANNED', 'BUILDING', 'FAILED')
  ) THEN
    RAISE EXCEPTION 'GC_REFERENCE_SCAN_INCOMPLETE' USING ERRCODE = '55000';
  END IF;

  INSERT INTO ops.gc_plan_candidates (
    project_id, gc_plan_id, candidate_kind, candidate_key
  )
  SELECT persisted_entry.project_id, persisted_entry.gc_plan_id,
         CASE persisted_entry.entry_kind
           WHEN 'GENERATION' THEN 'generation' ELSE 'index' END,
         persisted_entry.entry_key
  FROM ops.gc_plan_entries AS persisted_entry
  WHERE persisted_entry.project_id = p_project_id
    AND persisted_entry.gc_plan_id = p_gc_plan_id
    AND persisted_entry.disposition = 'CANDIDATE'
    AND persisted_entry.entry_kind IN ('GENERATION', 'INDEX');

  PERFORM ontos_migration.g20212_assert_candidate_safety(
    p_project_id, p_gc_plan_id, p_observed_at
  );
  RETURN QUERY SELECT p_gc_run_id, p_gc_plan_id, p_plan_digest, 'planned'::text, false;
END
$persist_generation_gc_dry_run$;

CREATE FUNCTION ontos_migration.g20212_assert_plan_current(
  p_project_id uuid,
  p_gc_plan_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20212_assert_plan_current$
DECLARE
  plan ops.gc_plans%ROWTYPE;
  inventory runtime.project_runtime_inventories%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(737217209, hashtext(p_project_id::text));
  SELECT candidate.* INTO plan
  FROM ops.gc_plans AS candidate
  WHERE candidate.project_id = p_project_id AND candidate.gc_plan_id = p_gc_plan_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20212_GC_PLAN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF plan.state NOT IN ('planned', 'committing', 'waiting_for_index_ddl') THEN
    IF plan.state = 'committed' THEN RETURN; END IF;
    RAISE EXCEPTION 'GC_PLAN_STALE' USING ERRCODE = '40001';
  END IF;
  SELECT candidate.* INTO inventory
  FROM runtime.project_runtime_inventories AS candidate
  WHERE candidate.project_id = p_project_id
  FOR UPDATE;
  IF NOT FOUND
    OR inventory.state_revision <> plan.current_state_revision
    OR inventory.inventory_revision <> plan.current_inventory_revision
    OR ontos_migration.g20212_registry_digest() <> plan.provider_registry_digest
    OR ontos_migration.g20212_root_state_digest(p_project_id) <> plan.root_state_digest
    OR EXISTS (
      SELECT 1
      FROM ops.gc_root_provider_registry AS registry
      LEFT JOIN ops.gc_root_provider_scans AS scan
        ON scan.project_id = p_project_id AND scan.gc_run_id = plan.gc_run_id
       AND scan.capability_key = registry.capability_key
      WHERE (registry.capability_state = 'ACTIVE' AND (
        scan.capability_key IS NULL OR scan.status <> 'COMPLETE'
        OR scan.provider_version IS DISTINCT FROM registry.expected_version
      )) OR (registry.capability_state = 'INACTIVE' AND scan.status <> 'INACTIVE')
    )
  THEN
    RAISE EXCEPTION 'GC_PLAN_STALE' USING ERRCODE = '40001';
  END IF;
  PERFORM ontos_migration.g20212_assert_candidate_safety(
    p_project_id, p_gc_plan_id, clock_timestamp()
  );
END
$g20212_assert_plan_current$;

CREATE FUNCTION ontos_migration.g20212_record_gc_batch(
  p_project_id uuid,
  p_gc_plan_id uuid,
  p_phase text,
  p_affected_rows bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20212_record_gc_batch$
DECLARE
  next_state bigint;
  next_inventory bigint;
BEGIN
  IF p_affected_rows <= 0 THEN RETURN; END IF;
  UPDATE runtime.project_runtime_inventories AS inventory
  SET state_revision = inventory.state_revision + 1,
      inventory_revision = inventory.inventory_revision + 1,
      measurement_complete = false,
      inventory_digest = NULL,
      changed_at = clock_timestamp()
  WHERE inventory.project_id = p_project_id
  RETURNING inventory.state_revision, inventory.inventory_revision
  INTO next_state, next_inventory;

  UPDATE ops.gc_plans AS plan
  SET current_state_revision = next_state,
      current_inventory_revision = next_inventory,
      root_state_digest = ontos_migration.g20212_root_state_digest(p_project_id),
      changed_at = clock_timestamp()
  WHERE plan.project_id = p_project_id AND plan.gc_plan_id = p_gc_plan_id;

  INSERT INTO ops.gc_batch_events (
    project_id, gc_plan_id, phase, affected_rows, state_revision, inventory_revision
  ) VALUES (
    p_project_id, p_gc_plan_id, p_phase, p_affected_rows, next_state, next_inventory
  );
END
$g20212_record_gc_batch$;

CREATE FUNCTION ops.claim_gc_orphan_upload_batch(
  p_project_id uuid,
  p_gc_plan_id uuid,
  p_batch_size integer
) RETURNS TABLE (session_id uuid, object_key text, object_version text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $claim_gc_orphan_upload_batch$
DECLARE
  plan_state text;
BEGIN
  IF p_batch_size NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'G20212_GC_BATCH_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM ontos_migration.g20212_assert_plan_current(p_project_id, p_gc_plan_id);
  SELECT state INTO plan_state FROM ops.gc_plans
  WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id;
  IF plan_state = 'committed' THEN RETURN; END IF;

  UPDATE ops.gc_plans SET state = 'committing',
      commit_started_at = COALESCE(commit_started_at, clock_timestamp()),
      changed_at = clock_timestamp()
  WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id
    AND state IN ('planned', 'waiting_for_index_ddl');
  UPDATE ops.gc_runs SET state = 'committing', changed_at = clock_timestamp()
  WHERE project_id = p_project_id
    AND gc_run_id = (SELECT gc_run_id FROM ops.gc_plans
      WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id)
    AND state IN ('planned', 'waiting_for_index_ddl');

  INSERT INTO ops.gc_orphan_deletions (
    project_id, gc_plan_id, session_id, object_key, object_version
  )
  SELECT session.project_id, p_gc_plan_id, session.session_id,
         session.object_key, session.uploaded_object_version
  FROM ops.gc_plan_entries AS entry
  JOIN runtime.snapshot_upload_sessions AS session
    ON session.project_id = entry.project_id AND session.session_id::text = entry.entry_key
  WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
    AND entry.entry_kind = 'ORPHAN_UPLOAD' AND entry.disposition = 'CANDIDATE'
    AND entry.completed_at IS NULL AND session.state IN ('failed', 'expired')
    AND session.uploaded_object_version IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM ops.gc_orphan_deletions AS claimed
      WHERE claimed.project_id = entry.project_id
        AND claimed.gc_plan_id = entry.gc_plan_id
        AND claimed.session_id = session.session_id
    )
  ORDER BY session.session_id
  LIMIT p_batch_size;

  RETURN QUERY
  SELECT claimed.session_id, claimed.object_key::text, claimed.object_version::text
  FROM ops.gc_orphan_deletions AS claimed
  WHERE claimed.project_id = p_project_id AND claimed.gc_plan_id = p_gc_plan_id
    AND claimed.state = 'CLAIMED'
  ORDER BY claimed.session_id
  LIMIT p_batch_size;
END
$claim_gc_orphan_upload_batch$;

CREATE FUNCTION ops.acknowledge_gc_orphan_upload(
  p_project_id uuid,
  p_gc_plan_id uuid,
  p_session_id uuid,
  p_object_version text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $acknowledge_gc_orphan_upload$
DECLARE
  claimed ops.gc_orphan_deletions%ROWTYPE;
  plan ops.gc_plans%ROWTYPE;
  inventory runtime.project_runtime_inventories%ROWTYPE;
  changed integer := 0;
  was_stale boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(737217209, hashtext(p_project_id::text));
  SELECT candidate.* INTO plan FROM ops.gc_plans AS candidate
  WHERE candidate.project_id = p_project_id AND candidate.gc_plan_id = p_gc_plan_id
  FOR UPDATE;
  SELECT candidate.* INTO inventory FROM runtime.project_runtime_inventories AS candidate
  WHERE candidate.project_id = p_project_id FOR UPDATE;
  IF plan.gc_plan_id IS NULL OR plan.state NOT IN ('committing', 'waiting_for_index_ddl') THEN
    RAISE EXCEPTION 'GC_PLAN_STALE' USING ERRCODE = '40001';
  END IF;
  was_stale := inventory.project_id IS NULL
    OR inventory.state_revision <> plan.current_state_revision
    OR inventory.inventory_revision <> plan.current_inventory_revision
    OR ontos_migration.g20212_registry_digest() <> plan.provider_registry_digest
    OR ontos_migration.g20212_root_state_digest(p_project_id) <> plan.root_state_digest;
  SELECT candidate.* INTO claimed
  FROM ops.gc_orphan_deletions AS candidate
  WHERE candidate.project_id = p_project_id AND candidate.gc_plan_id = p_gc_plan_id
    AND candidate.session_id = p_session_id
  FOR UPDATE;
  IF NOT FOUND OR claimed.object_version <> p_object_version THEN
    RAISE EXCEPTION 'G20212_GC_ORPHAN_CLAIM_INVALID' USING ERRCODE = '55000';
  END IF;
  IF claimed.state = 'DELETED' THEN RETURN; END IF;

  UPDATE runtime.snapshot_upload_sessions AS session
  SET state = 'cleaned', object_cleanup_completed_at = clock_timestamp(),
      changed_at = clock_timestamp()
  WHERE session.project_id = p_project_id AND session.session_id = p_session_id
    AND session.state IN ('failed', 'expired')
    AND session.uploaded_object_version = p_object_version;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'GC_PLAN_STALE' USING ERRCODE = '40001';
  END IF;
  UPDATE ops.gc_orphan_deletions
  SET state = 'DELETED', deleted_at = clock_timestamp()
  WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id
    AND session_id = p_session_id;
  UPDATE ops.gc_plan_entries AS entry
  SET completed_at = clock_timestamp(), affected_rows = entry.affected_rows + 1
  WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
    AND entry.entry_kind = 'ORPHAN_UPLOAD' AND entry.entry_key = p_session_id::text
    AND entry.completed_at IS NULL;
  IF was_stale THEN
    UPDATE runtime.project_runtime_inventories AS runtime_inventory
    SET state_revision = runtime_inventory.state_revision + 1,
        inventory_revision = runtime_inventory.inventory_revision + 1,
        measurement_complete = false, inventory_digest = NULL,
        changed_at = clock_timestamp()
    WHERE runtime_inventory.project_id = p_project_id;
    UPDATE ops.gc_plans SET state = 'stale', changed_at = clock_timestamp()
    WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id;
    UPDATE ops.gc_runs SET state = 'stale', result_code = 'GC_PLAN_STALE',
        changed_at = clock_timestamp()
    WHERE project_id = p_project_id AND gc_run_id = plan.gc_run_id;
  ELSE
    PERFORM ontos_migration.g20212_record_gc_batch(
      p_project_id, p_gc_plan_id, 'ORPHAN_UPLOAD', 1
    );
  END IF;
END
$acknowledge_gc_orphan_upload$;

CREATE FUNCTION ontos_migration.g20212_finish_gc_batch(
  p_project_id uuid,
  p_gc_plan_id uuid,
  p_phase text,
  p_affected_rows integer
) RETURNS TABLE (
  plan_state text,
  current_phase text,
  remaining_candidates integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20212_finish_gc_batch$
BEGIN
  PERFORM ontos_migration.g20212_record_gc_batch(
    p_project_id, p_gc_plan_id, p_phase, p_affected_rows
  );
  DELETE FROM ops.gc_execution_contexts
  WHERE backend_pid = pg_backend_pid() AND transaction_id = txid_current();
  RETURN QUERY
  SELECT plan.state, plan.phase,
         (SELECT count(*)::integer FROM ops.gc_plan_entries AS entry
          WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
            AND entry.disposition = 'CANDIDATE' AND entry.completed_at IS NULL)
  FROM ops.gc_plans AS plan
  WHERE plan.project_id = p_project_id AND plan.gc_plan_id = p_gc_plan_id;
END
$g20212_finish_gc_batch$;

CREATE FUNCTION ops.commit_generation_gc_batch(
  p_project_id uuid,
  p_gc_plan_id uuid,
  p_batch_size integer
) RETURNS TABLE (
  plan_state text,
  phase text,
  affected_rows integer,
  remaining_candidates integer,
  index_request_ids uuid[]
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $commit_generation_gc_batch$
DECLARE
  plan ops.gc_plans%ROWTYPE;
  changed integer := 0;
  result_state text;
  result_phase text;
  result_remaining integer;
  request_id uuid;
  pending_request ops.projection_ddl_requests%ROWTYPE;
BEGIN
  IF p_batch_size NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'G20212_GC_BATCH_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM ontos_migration.g20212_assert_plan_current(p_project_id, p_gc_plan_id);
  SELECT candidate.* INTO plan FROM ops.gc_plans AS candidate
  WHERE candidate.project_id = p_project_id AND candidate.gc_plan_id = p_gc_plan_id
  FOR UPDATE;
  IF plan.state = 'committed' THEN
    RETURN QUERY SELECT 'committed'::text, 'DONE'::text, 0, 0, ARRAY[]::uuid[];
    RETURN;
  END IF;

  UPDATE ops.gc_plans SET state = 'committing',
      commit_started_at = COALESCE(commit_started_at, clock_timestamp()),
      changed_at = clock_timestamp()
  WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id
    AND state IN ('planned', 'waiting_for_index_ddl');
  UPDATE ops.gc_runs SET state = 'committing', changed_at = clock_timestamp()
  WHERE project_id = p_project_id AND gc_run_id = plan.gc_run_id
    AND state IN ('planned', 'waiting_for_index_ddl');

  INSERT INTO ops.gc_execution_contexts (
    backend_pid, transaction_id, project_id, gc_plan_id
  ) VALUES (pg_backend_pid(), txid_current(), p_project_id, p_gc_plan_id)
  ON CONFLICT (backend_pid, transaction_id) DO UPDATE
  SET project_id = EXCLUDED.project_id, gc_plan_id = EXCLUDED.gc_plan_id;

  -- Orphan object deletion is deliberately outside SQL. Do not advance until
  -- every exact, server-derived version has been acknowledged.
  IF plan.phase = 'ORPHAN_UPLOAD' THEN
    IF EXISTS (
      SELECT 1 FROM ops.gc_plan_entries AS entry
      WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
        AND entry.entry_kind = 'ORPHAN_UPLOAD' AND entry.disposition = 'CANDIDATE'
        AND entry.completed_at IS NULL
    ) THEN
      DELETE FROM ops.gc_execution_contexts
      WHERE backend_pid = pg_backend_pid() AND transaction_id = txid_current();
      RETURN QUERY SELECT 'committing'::text, 'ORPHAN_UPLOAD'::text, 0,
        (SELECT count(*)::integer FROM ops.gc_plan_entries AS entry
         WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
           AND entry.disposition = 'CANDIDATE' AND entry.completed_at IS NULL),
        ARRAY[]::uuid[];
      RETURN;
    END IF;
    UPDATE ops.gc_plans SET phase = 'HEAD_SET', changed_at = clock_timestamp()
    WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id;
    plan.phase := 'HEAD_SET';
  END IF;

  IF plan.phase = 'HEAD_SET' THEN
    WITH target AS (
      SELECT version.ctid
      FROM runtime.object_head_versions AS version
      JOIN ops.gc_plan_entries AS entry
        ON entry.project_id = version.project_id
       AND entry.entry_key = version.head_set_id::text
      WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
        AND entry.entry_kind = 'HEAD_SET' AND entry.disposition = 'CANDIDATE'
      ORDER BY version.head_set_id, version.object_type_resource_id, version.object_rid
      LIMIT p_batch_size
    )
    DELETE FROM runtime.object_head_versions AS version
    WHERE version.ctid IN (SELECT ctid FROM target);
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed = 0 THEN
      WITH candidate AS (
        SELECT entry.entry_key::uuid AS head_set_id
        FROM ops.gc_plan_entries AS entry
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'HEAD_SET' AND entry.disposition = 'CANDIDATE'
          AND entry.completed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM runtime.object_head_versions AS version
            WHERE version.project_id = entry.project_id
              AND version.head_set_id::text = entry.entry_key
          )
        ORDER BY entry.entry_key LIMIT 1
      ), inserted AS (
        INSERT INTO runtime.head_set_collections (project_id, head_set_id, gc_plan_id)
        SELECT p_project_id, candidate.head_set_id, p_gc_plan_id FROM candidate
        ON CONFLICT (project_id, head_set_id) DO NOTHING
        RETURNING head_set_id
      )
      UPDATE ops.gc_plan_entries AS entry
      SET completed_at = clock_timestamp(), affected_rows = entry.affected_rows + 1
      WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
        AND entry.entry_kind = 'HEAD_SET'
        AND entry.entry_key IN (SELECT head_set_id::text FROM candidate);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed > 0 THEN
      SELECT finish.plan_state, finish.current_phase, finish.remaining_candidates
      INTO result_state, result_phase, result_remaining
      FROM ontos_migration.g20212_finish_gc_batch(
        p_project_id, p_gc_plan_id, 'HEAD_SET', changed
      ) AS finish;
      RETURN QUERY SELECT result_state, result_phase, changed, result_remaining, ARRAY[]::uuid[];
      RETURN;
    END IF;
    UPDATE ops.gc_plans SET phase = 'PROVENANCE', changed_at = clock_timestamp()
    WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id;
    plan.phase := 'PROVENANCE';
  END IF;

  IF plan.phase = 'PROVENANCE' THEN
    WITH target AS (
      SELECT provenance.ctid
      FROM runtime.property_provenance AS provenance
      JOIN ops.gc_plan_entries AS entry
        ON entry.project_id = provenance.project_id
       AND entry.entry_key = provenance.generation_id::text
      WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
        AND entry.entry_kind = 'GENERATION' AND entry.disposition = 'CANDIDATE'
      ORDER BY provenance.generation_id, provenance.object_type_resource_id,
               provenance.object_rid, provenance.property_api_name, provenance.source_index
      LIMIT p_batch_size
    ) DELETE FROM runtime.property_provenance AS provenance
      WHERE provenance.ctid IN (SELECT ctid FROM target);
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed = 0 THEN
      WITH target AS (
        SELECT observation.ctid
        FROM ops.materialization_quality_observations AS observation
        JOIN ops.gc_plan_entries AS entry
          ON entry.project_id = observation.project_id
         AND entry.entry_key = observation.generation_id::text
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'GENERATION' AND entry.disposition = 'CANDIDATE'
        ORDER BY observation.generation_id, observation.file_id, observation.row_number
        LIMIT p_batch_size
      ) DELETE FROM ops.materialization_quality_observations AS observation
        WHERE observation.ctid IN (SELECT ctid FROM target);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed = 0 THEN
      WITH target AS (
        SELECT template.ctid
        FROM ops.materialization_provenance_templates AS template
        JOIN ops.gc_plan_entries AS entry
          ON entry.project_id = template.project_id
         AND entry.entry_key = template.generation_id::text
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'GENERATION' AND entry.disposition = 'CANDIDATE'
        ORDER BY template.generation_id, template.property_api_name, template.source_index
        LIMIT p_batch_size
      ) DELETE FROM ops.materialization_provenance_templates AS template
        WHERE template.ctid IN (SELECT ctid FROM target);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed = 0 THEN
      WITH target AS (
        SELECT preparation.ctid
        FROM ops.materialization_quality_preparations AS preparation
        JOIN ops.gc_plan_entries AS entry
          ON entry.project_id = preparation.project_id
         AND entry.entry_key = preparation.generation_id::text
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'GENERATION' AND entry.disposition = 'CANDIDATE'
        ORDER BY preparation.generation_id LIMIT p_batch_size
      ) DELETE FROM ops.materialization_quality_preparations AS preparation
        WHERE preparation.ctid IN (SELECT ctid FROM target);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed > 0 THEN
      SELECT finish.plan_state, finish.current_phase, finish.remaining_candidates
      INTO result_state, result_phase, result_remaining
      FROM ontos_migration.g20212_finish_gc_batch(
        p_project_id, p_gc_plan_id, 'PROVENANCE', changed
      ) AS finish;
      RETURN QUERY SELECT result_state, result_phase, changed, result_remaining, ARRAY[]::uuid[];
      RETURN;
    END IF;
    UPDATE ops.gc_plans SET phase = 'CURRENT', changed_at = clock_timestamp()
    WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id;
    plan.phase := 'CURRENT';
  END IF;

  IF plan.phase = 'CURRENT' THEN
    WITH target AS (
      SELECT candidate.ctid
      FROM runtime.object_head_candidates AS candidate
      JOIN ops.gc_plan_entries AS entry
        ON entry.project_id = candidate.project_id
       AND entry.entry_key = candidate.generation_id::text
      WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
        AND entry.entry_kind = 'GENERATION' AND entry.disposition = 'CANDIDATE'
      ORDER BY candidate.generation_id, candidate.object_type_resource_id, candidate.object_rid
      LIMIT p_batch_size
    ) DELETE FROM runtime.object_head_candidates AS candidate
      WHERE candidate.ctid IN (SELECT ctid FROM target);
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed = 0 THEN
      WITH target AS (
        SELECT candidate.ctid
        FROM runtime.snapshot_group_cutover_head_candidates AS candidate
        JOIN runtime.snapshot_group_cutover_preparations AS preparation
          ON preparation.project_id = candidate.project_id
         AND preparation.preparation_id = candidate.preparation_id
        JOIN ops.gc_plan_entries AS entry
          ON entry.project_id = candidate.project_id
         AND entry.entry_key = candidate.candidate_generation_id::text
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'GENERATION' AND entry.disposition = 'CANDIDATE'
          AND preparation.state = 'committed'
        ORDER BY candidate.preparation_id, candidate.object_type_resource_id, candidate.object_rid
        LIMIT p_batch_size
      ) DELETE FROM runtime.snapshot_group_cutover_head_candidates AS candidate
        WHERE candidate.ctid IN (SELECT ctid FROM target);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed = 0 THEN
      WITH target AS (
        SELECT current.ctid
        FROM runtime.object_current AS current
        JOIN ops.gc_plan_entries AS entry
          ON entry.project_id = current.project_id
         AND entry.entry_key = current.generation_id::text
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'GENERATION' AND entry.disposition = 'CANDIDATE'
        ORDER BY current.generation_id, current.object_type_resource_id, current.object_rid
        LIMIT p_batch_size
      ) DELETE FROM runtime.object_current AS current
        WHERE current.ctid IN (SELECT ctid FROM target);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed = 0 THEN
      WITH target AS (
        SELECT current.ctid
        FROM runtime.link_current AS current
        JOIN ops.gc_plan_entries AS entry
          ON entry.project_id = current.project_id
         AND entry.entry_key = current.generation_id::text
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'GENERATION' AND entry.disposition = 'CANDIDATE'
        ORDER BY current.generation_id, current.link_type_resource_id, current.link_rid
        LIMIT p_batch_size
      ) DELETE FROM runtime.link_current AS current
        WHERE current.ctid IN (SELECT ctid FROM target);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed > 0 THEN
      SELECT finish.plan_state, finish.current_phase, finish.remaining_candidates
      INTO result_state, result_phase, result_remaining
      FROM ontos_migration.g20212_finish_gc_batch(
        p_project_id, p_gc_plan_id, 'CURRENT', changed
      ) AS finish;
      RETURN QUERY SELECT result_state, result_phase, changed, result_remaining, ARRAY[]::uuid[];
      RETURN;
    END IF;
    UPDATE ops.gc_plans SET phase = 'BASE', changed_at = clock_timestamp()
    WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id;
    plan.phase := 'BASE';
  END IF;

  IF plan.phase = 'BASE' THEN
    WITH target AS (
      SELECT base.ctid
      FROM runtime.object_base AS base
      JOIN ops.gc_plan_entries AS entry
        ON entry.project_id = base.project_id AND entry.entry_key = base.generation_id::text
      WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
        AND entry.entry_kind = 'GENERATION' AND entry.disposition = 'CANDIDATE'
      ORDER BY base.generation_id, base.object_type_resource_id, base.object_rid
      LIMIT p_batch_size
    ) DELETE FROM runtime.object_base AS base WHERE base.ctid IN (SELECT ctid FROM target);
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed = 0 THEN
      WITH target AS (
        SELECT base.ctid
        FROM runtime.link_base AS base
        JOIN ops.gc_plan_entries AS entry
          ON entry.project_id = base.project_id AND entry.entry_key = base.generation_id::text
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'GENERATION' AND entry.disposition = 'CANDIDATE'
        ORDER BY base.generation_id, base.link_type_resource_id, base.link_rid
        LIMIT p_batch_size
      ) DELETE FROM runtime.link_base AS base WHERE base.ctid IN (SELECT ctid FROM target);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed > 0 THEN
      SELECT finish.plan_state, finish.current_phase, finish.remaining_candidates
      INTO result_state, result_phase, result_remaining
      FROM ontos_migration.g20212_finish_gc_batch(
        p_project_id, p_gc_plan_id, 'BASE', changed
      ) AS finish;
      RETURN QUERY SELECT result_state, result_phase, changed, result_remaining, ARRAY[]::uuid[];
      RETURN;
    END IF;
    UPDATE ops.gc_plans SET phase = 'REPORT', changed_at = clock_timestamp()
    WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id;
    plan.phase := 'REPORT';
  END IF;

  IF plan.phase = 'REPORT' THEN
    WITH candidate_reports AS (
      SELECT DISTINCT generation.report_id
      FROM runtime.generations AS generation
      JOIN ops.gc_plan_entries AS entry
        ON entry.project_id = generation.project_id
       AND entry.entry_key = generation.generation_id::text
      WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
        AND entry.entry_kind = 'GENERATION' AND entry.disposition = 'CANDIDATE'
        AND generation.report_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM runtime.generations AS other
          WHERE other.project_id = generation.project_id AND other.report_id = generation.report_id
            AND NOT EXISTS (
              SELECT 1 FROM runtime.generation_collections AS collected
              WHERE collected.project_id = other.project_id
                AND collected.generation_id = other.generation_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM ops.gc_plan_entries AS other_entry
              WHERE other_entry.project_id = entry.project_id
                AND other_entry.gc_plan_id = entry.gc_plan_id
                AND other_entry.entry_kind = 'GENERATION'
                AND other_entry.entry_key = other.generation_id::text
                AND other_entry.disposition = 'CANDIDATE'
            )
        )
      ORDER BY generation.report_id LIMIT p_batch_size
    )
    INSERT INTO runtime.materialization_report_collections (project_id, report_id, gc_plan_id)
    SELECT p_project_id, report_id, p_gc_plan_id FROM candidate_reports
    ON CONFLICT (project_id, report_id) DO NOTHING;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed > 0 THEN
      SELECT finish.plan_state, finish.current_phase, finish.remaining_candidates
      INTO result_state, result_phase, result_remaining
      FROM ontos_migration.g20212_finish_gc_batch(
        p_project_id, p_gc_plan_id, 'REPORT', changed
      ) AS finish;
      RETURN QUERY SELECT result_state, result_phase, changed, result_remaining, ARRAY[]::uuid[];
      RETURN;
    END IF;
    UPDATE ops.gc_plans SET phase = 'ATTEMPT', changed_at = clock_timestamp()
    WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id;
    plan.phase := 'ATTEMPT';
  END IF;

  IF plan.phase = 'ATTEMPT' THEN
    WITH target AS (
      SELECT staging.ctid
      FROM ops.object_base_staging AS staging
      JOIN ops.gc_plan_entries AS entry
        ON entry.project_id = staging.project_id AND entry.entry_key = staging.attempt_id::text
      WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
        AND entry.entry_kind = 'ATTEMPT_STAGING' AND entry.disposition = 'CANDIDATE'
      ORDER BY staging.attempt_id, staging.generation_id,
               staging.object_type_resource_id, staging.object_rid LIMIT p_batch_size
    ) DELETE FROM ops.object_base_staging AS staging
      WHERE staging.ctid IN (SELECT ctid FROM target);
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed = 0 THEN
      WITH target AS (
        SELECT staging.ctid
        FROM ops.link_base_staging AS staging
        JOIN ops.gc_plan_entries AS entry
          ON entry.project_id = staging.project_id AND entry.entry_key = staging.attempt_id::text
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'ATTEMPT_STAGING' AND entry.disposition = 'CANDIDATE'
        ORDER BY staging.attempt_id, staging.generation_id,
                 staging.link_type_resource_id, staging.link_rid LIMIT p_batch_size
      ) DELETE FROM ops.link_base_staging AS staging
        WHERE staging.ctid IN (SELECT ctid FROM target);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed = 0 THEN
      WITH target AS (
        SELECT batch.ctid
        FROM ops.materialization_generation_stage_batches AS batch
        JOIN ops.gc_plan_entries AS entry
          ON entry.project_id = batch.project_id AND entry.entry_key = batch.attempt_id::text
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'ATTEMPT_STAGING' AND entry.disposition = 'CANDIDATE'
        ORDER BY batch.attempt_id, batch.generation_id, batch.batch_sequence LIMIT p_batch_size
      ) DELETE FROM ops.materialization_generation_stage_batches AS batch
        WHERE batch.ctid IN (SELECT ctid FROM target);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed = 0 THEN
      WITH target AS (
        SELECT stage.ctid
        FROM ops.materialization_generation_stages AS stage
        JOIN ops.gc_plan_entries AS entry
          ON entry.project_id = stage.project_id AND entry.entry_key = stage.attempt_id::text
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'ATTEMPT_STAGING' AND entry.disposition = 'CANDIDATE'
        ORDER BY stage.attempt_id, stage.generation_id LIMIT p_batch_size
      ) DELETE FROM ops.materialization_generation_stages AS stage
        WHERE stage.ctid IN (SELECT ctid FROM target);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed = 0 THEN
      WITH target AS (
        SELECT checkpoint.ctid
        FROM ops.materialization_checkpoints AS checkpoint
        JOIN ops.gc_plan_entries AS entry
          ON entry.project_id = checkpoint.project_id
         AND entry.entry_key = checkpoint.attempt_id::text
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'ATTEMPT_STAGING' AND entry.disposition = 'CANDIDATE'
        ORDER BY checkpoint.attempt_id, checkpoint.sequence LIMIT p_batch_size
      ) DELETE FROM ops.materialization_checkpoints AS checkpoint
        WHERE checkpoint.ctid IN (SELECT ctid FROM target);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed = 0 THEN
      WITH target AS (
        SELECT sample.ctid
        FROM ops.materialization_job_error_samples AS sample
        JOIN ops.gc_plan_entries AS entry
          ON entry.project_id = sample.project_id AND entry.entry_key = sample.attempt_id::text
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'ATTEMPT_STAGING' AND entry.disposition = 'CANDIDATE'
        ORDER BY sample.attempt_id, sample.ordinal LIMIT p_batch_size
      ) DELETE FROM ops.materialization_job_error_samples AS sample
        WHERE sample.ctid IN (SELECT ctid FROM target);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed = 0 THEN
      WITH target AS (
        SELECT batch.ctid
        FROM ops.materialization_staged_batches AS batch
        JOIN ops.gc_plan_entries AS entry
          ON entry.project_id = batch.project_id AND entry.entry_key = batch.attempt_id::text
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'ATTEMPT_STAGING' AND entry.disposition = 'CANDIDATE'
        ORDER BY batch.attempt_id, batch.batch_sequence LIMIT p_batch_size
      ) DELETE FROM ops.materialization_staged_batches AS batch
        WHERE batch.ctid IN (SELECT ctid FROM target);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed = 0 THEN
      WITH candidate AS (
        SELECT entry.entry_key::uuid AS attempt_id
        FROM ops.gc_plan_entries AS entry
        WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
          AND entry.entry_kind = 'ATTEMPT_STAGING' AND entry.disposition = 'CANDIDATE'
          AND entry.completed_at IS NULL
        ORDER BY entry.entry_key LIMIT 1
      ), inserted AS (
        INSERT INTO ops.materialization_attempt_collections (project_id, attempt_id, gc_plan_id)
        SELECT p_project_id, candidate.attempt_id, p_gc_plan_id FROM candidate
        ON CONFLICT (project_id, attempt_id) DO NOTHING RETURNING attempt_id
      )
      UPDATE ops.gc_plan_entries AS entry
      SET completed_at = clock_timestamp(), affected_rows = entry.affected_rows + 1
      WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
        AND entry.entry_kind = 'ATTEMPT_STAGING'
        AND entry.entry_key IN (SELECT attempt_id::text FROM candidate);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF changed > 0 THEN
      SELECT finish.plan_state, finish.current_phase, finish.remaining_candidates
      INTO result_state, result_phase, result_remaining
      FROM ontos_migration.g20212_finish_gc_batch(
        p_project_id, p_gc_plan_id, 'ATTEMPT', changed
      ) AS finish;
      RETURN QUERY SELECT result_state, result_phase, changed, result_remaining, ARRAY[]::uuid[];
      RETURN;
    END IF;
    UPDATE ops.gc_plans SET phase = 'GENERATION', changed_at = clock_timestamp()
    WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id;
    plan.phase := 'GENERATION';
  END IF;

  IF plan.phase = 'GENERATION' THEN
    WITH candidate AS (
      SELECT entry.entry_key::uuid AS generation_id
      FROM ops.gc_plan_entries AS entry
      WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
        AND entry.entry_kind = 'GENERATION' AND entry.disposition = 'CANDIDATE'
        AND entry.completed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM runtime.object_current AS row_value
          WHERE row_value.project_id = entry.project_id
            AND row_value.generation_id::text = entry.entry_key)
        AND NOT EXISTS (SELECT 1 FROM runtime.link_current AS row_value
          WHERE row_value.project_id = entry.project_id
            AND row_value.generation_id::text = entry.entry_key)
        AND NOT EXISTS (SELECT 1 FROM runtime.object_base AS row_value
          WHERE row_value.project_id = entry.project_id
            AND row_value.generation_id::text = entry.entry_key)
        AND NOT EXISTS (SELECT 1 FROM runtime.link_base AS row_value
          WHERE row_value.project_id = entry.project_id
            AND row_value.generation_id::text = entry.entry_key)
      ORDER BY entry.entry_key LIMIT p_batch_size
    ), inserted AS (
      INSERT INTO runtime.generation_collections (project_id, generation_id, gc_plan_id)
      SELECT p_project_id, candidate.generation_id, p_gc_plan_id FROM candidate
      ON CONFLICT (project_id, generation_id) DO NOTHING RETURNING generation_id
    )
    UPDATE ops.gc_plan_entries AS entry
    SET completed_at = clock_timestamp(), affected_rows = entry.affected_rows + 1
    WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
      AND entry.entry_kind = 'GENERATION'
      AND entry.entry_key IN (SELECT generation_id::text FROM candidate);
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed > 0 THEN
      SELECT finish.plan_state, finish.current_phase, finish.remaining_candidates
      INTO result_state, result_phase, result_remaining
      FROM ontos_migration.g20212_finish_gc_batch(
        p_project_id, p_gc_plan_id, 'GENERATION', changed
      ) AS finish;
      RETURN QUERY SELECT result_state, result_phase, changed, result_remaining, ARRAY[]::uuid[];
      RETURN;
    END IF;
    IF EXISTS (
      SELECT 1 FROM ops.gc_plan_entries AS entry
      WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
        AND entry.entry_kind = 'GENERATION' AND entry.disposition = 'CANDIDATE'
        AND entry.completed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'GC_PLAN_STALE' USING ERRCODE = '40001';
    END IF;
    UPDATE ops.gc_plans SET phase = 'INDEX_REQUEST', changed_at = clock_timestamp()
    WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id;
    plan.phase := 'INDEX_REQUEST';
  END IF;

  IF plan.phase = 'INDEX_REQUEST' THEN
    SELECT request.* INTO pending_request
    FROM ops.projection_ddl_requests AS request
    WHERE request.project_id = p_project_id AND request.gc_plan_id = p_gc_plan_id
      AND request.action = 'DROP' AND request.state <> 'SUCCEEDED'
    ORDER BY request.created_at, request.request_id LIMIT 1;
    IF FOUND THEN
      UPDATE ops.gc_plans SET state = 'waiting_for_index_ddl', changed_at = clock_timestamp()
      WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id;
      UPDATE ops.gc_runs SET state = 'waiting_for_index_ddl', changed_at = clock_timestamp()
      WHERE project_id = p_project_id AND gc_run_id = plan.gc_run_id;
      DELETE FROM ops.gc_execution_contexts
      WHERE backend_pid = pg_backend_pid() AND transaction_id = txid_current();
      RETURN QUERY SELECT 'waiting_for_index_ddl'::text, 'INDEX_REQUEST'::text, 0,
        (SELECT count(*)::integer FROM ops.gc_plan_entries AS entry
         WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
           AND entry.disposition = 'CANDIDATE' AND entry.completed_at IS NULL),
        ARRAY[pending_request.request_id]::uuid[];
      RETURN;
    END IF;

    WITH completed AS (
      SELECT request.entry_key
      FROM ops.projection_ddl_requests AS request
      WHERE request.project_id = p_project_id AND request.gc_plan_id = p_gc_plan_id
        AND request.action = 'DROP' AND request.state = 'SUCCEEDED'
    )
    UPDATE ops.gc_plan_entries AS entry
    SET completed_at = COALESCE(entry.completed_at, clock_timestamp()),
        affected_rows = CASE WHEN entry.completed_at IS NULL
          THEN entry.affected_rows + 1 ELSE entry.affected_rows END
    FROM runtime.index_inventory AS inventory
    JOIN completed ON completed.entry_key = inventory.entry_key
    WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
      AND entry.entry_kind = 'INDEX' AND entry.disposition = 'CANDIDATE'
      AND entry.entry_key = inventory.physical_signature
      AND inventory.project_id = entry.project_id AND inventory.state = 'retired';

    SELECT gen_random_uuid() INTO request_id
    FROM ops.gc_plan_entries AS entry
    WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
      AND entry.entry_kind = 'INDEX' AND entry.disposition = 'CANDIDATE'
      AND entry.completed_at IS NULL
    ORDER BY entry.entry_key LIMIT 1;
    IF request_id IS NOT NULL THEN
      INSERT INTO ops.projection_ddl_requests (
        project_id, request_id, action, inventory_revision,
        index_plan_id, entry_key, gc_plan_id, gc_plan_digest
      )
      SELECT p_project_id, request_id, 'DROP', plan.current_inventory_revision,
             inventory.index_plan_id, inventory.entry_key, p_gc_plan_id, plan.plan_digest
      FROM ops.gc_plan_entries AS entry
      JOIN runtime.index_inventory AS inventory
        ON inventory.project_id = entry.project_id
       AND inventory.physical_signature = entry.entry_key
      WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
        AND entry.entry_kind = 'INDEX' AND entry.disposition = 'CANDIDATE'
        AND entry.completed_at IS NULL
      ORDER BY entry.entry_key LIMIT 1;
      UPDATE ops.gc_plans SET state = 'waiting_for_index_ddl', changed_at = clock_timestamp()
      WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id;
      UPDATE ops.gc_runs SET state = 'waiting_for_index_ddl', changed_at = clock_timestamp()
      WHERE project_id = p_project_id AND gc_run_id = plan.gc_run_id;
      DELETE FROM ops.gc_execution_contexts
      WHERE backend_pid = pg_backend_pid() AND transaction_id = txid_current();
      RETURN QUERY SELECT 'waiting_for_index_ddl'::text, 'INDEX_REQUEST'::text, 0,
        (SELECT count(*)::integer FROM ops.gc_plan_entries AS entry
         WHERE entry.project_id = p_project_id AND entry.gc_plan_id = p_gc_plan_id
           AND entry.disposition = 'CANDIDATE' AND entry.completed_at IS NULL),
        ARRAY[request_id]::uuid[];
      RETURN;
    END IF;

    UPDATE ops.gc_plans SET state = 'committed', phase = 'DONE',
        completed_at = clock_timestamp(), changed_at = clock_timestamp()
    WHERE project_id = p_project_id AND gc_plan_id = p_gc_plan_id;
    UPDATE ops.gc_runs SET state = 'committed', result_code = 'GC_COMMITTED',
        changed_at = clock_timestamp()
    WHERE project_id = p_project_id AND gc_run_id = plan.gc_run_id;
    DELETE FROM ops.gc_execution_contexts
    WHERE backend_pid = pg_backend_pid() AND transaction_id = txid_current();
    RETURN QUERY SELECT 'committed'::text, 'DONE'::text, 0, 0, ARRAY[]::uuid[];
    RETURN;
  END IF;

  RAISE EXCEPTION 'G20212_GC_PHASE_INVALID:%', plan.phase USING ERRCODE = '55000';
END
$commit_generation_gc_batch$;

CREATE VIEW ops.gc_provider_scan_status WITH (security_barrier = true) AS
SELECT project_id, gc_run_id, capability_key, status, provider_version,
       root_count, root_digest, scanned_at
FROM ops.gc_root_provider_scans;

CREATE OR REPLACE VIEW ops.gc_status WITH (security_barrier = true) AS
SELECT run.project_id, run.gc_run_id, run.state AS run_state,
       plan.gc_plan_id, plan.state AS plan_state,
       run.expected_state_revision, run.expected_inventory_revision,
       run.result_code, run.created_at, run.changed_at,
       run.idempotency_key_digest, run.observed_at, run.blocked_reasons,
       run.provider_registry_digest, run.protected_root_digest,
       plan.plan_digest, plan.phase, plan.entry_count, plan.reclaimable_bytes,
       plan.current_state_revision, plan.current_inventory_revision
FROM ops.gc_runs AS run
LEFT JOIN ops.gc_plans AS plan
  ON plan.project_id = run.project_id AND plan.gc_run_id = run.gc_run_id;

REVOKE ALL PRIVILEGES ON TABLE
  ops.gc_root_provider_registry,
  ops.gc_root_epochs,
  ops.gc_root_provider_scans,
  ops.gc_plan_entries,
  ops.gc_orphan_deletions,
  ops.gc_batch_events,
  ops.gc_execution_contexts,
  ops.materialization_attempt_collections,
  runtime.generation_collections,
  runtime.head_set_collections,
  runtime.materialization_report_collections,
  ops.gc_provider_registry_status,
  ops.gc_live_provider_scans,
  ops.gc_provider_scan_status,
  ops.gc_generation_roots,
  ops.gc_generation_inventory,
  ops.gc_head_set_inventory,
  ops.gc_index_inventory,
  ops.gc_attempt_inventory,
  ops.gc_orphan_upload_inventory,
  ops.gc_plan_status,
  ops.gc_plan_entry_status
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

REVOKE ALL PRIVILEGES ON FUNCTION
  ops.persist_generation_gc_dry_run(
    uuid, uuid, uuid, text, text, text, timestamptz, bigint, bigint,
    text, jsonb, jsonb, jsonb
  ),
  ops.claim_gc_orphan_upload_batch(uuid, uuid, integer),
  ops.acknowledge_gc_orphan_upload(uuid, uuid, uuid, text),
  ops.commit_generation_gc_batch(uuid, uuid, integer),
  ontos_migration.g20212_registry_digest(),
  ontos_migration.g20212_root_state_digest(uuid),
  ontos_migration.g20212_lock_gc_root_change(),
  ontos_migration.g20212_allow_gc_delete(),
  ontos_migration.g20212_phase_rank(text),
  ontos_migration.g20212_assert_candidate_safety(uuid, uuid, timestamptz),
  ontos_migration.g20212_assert_plan_current(uuid, uuid),
  ontos_migration.g20212_record_gc_batch(uuid, uuid, text, bigint),
  ontos_migration.g20212_finish_gc_batch(uuid, uuid, text, integer)
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT SELECT ON TABLE
  ops.gc_provider_registry_status,
  ops.gc_live_provider_scans,
  ops.gc_provider_scan_status,
  ops.gc_generation_roots,
  ops.gc_generation_inventory,
  ops.gc_head_set_inventory,
  ops.gc_index_inventory,
  ops.gc_attempt_inventory,
  ops.gc_orphan_upload_inventory,
  ops.gc_plan_status,
  ops.gc_plan_entry_status,
  ops.gc_status,
  ops.runtime_inventory_status
TO api_runtime;

GRANT SELECT ON TABLE
  ops.gc_provider_registry_status,
  ops.gc_provider_scan_status,
  ops.gc_plan_status,
  ops.gc_plan_entry_status,
  ops.gc_status
TO read_only_ops;

GRANT EXECUTE ON FUNCTION
  ops.persist_generation_gc_dry_run(
    uuid, uuid, uuid, text, text, text, timestamptz, bigint, bigint,
    text, jsonb, jsonb, jsonb
  ),
  ops.claim_gc_orphan_upload_batch(uuid, uuid, integer),
  ops.acknowledge_gc_orphan_upload(uuid, uuid, uuid, text),
  ops.commit_generation_gc_batch(uuid, uuid, integer),
  ontos_migration.g20212_registry_digest()
TO api_runtime;
