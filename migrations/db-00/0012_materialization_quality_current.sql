SET LOCAL ROLE migration_owner;

-- A Generation is created before quality is known. Earlier migrations required
-- a synthetic Report at INSERT time; this forward repair permits only the real
-- build shape: both Report columns and the Generation digest are initially NULL,
-- then a controlled quality finalizer binds all three exactly once.
ALTER TABLE runtime.generations
  ALTER COLUMN report_id DROP NOT NULL,
  ALTER COLUMN report_digest DROP NOT NULL,
  ALTER COLUMN generation_digest DROP NOT NULL,
  ADD CONSTRAINT generations_quality_binding_shape_ck CHECK (
    (report_id IS NULL AND report_digest IS NULL AND generation_digest IS NULL)
    OR (report_id IS NOT NULL AND report_digest IS NOT NULL AND generation_digest IS NOT NULL)
  );

-- One Current Property may use many columns, or no column for a constant.
ALTER TABLE runtime.property_provenance
  DROP CONSTRAINT property_provenance_pkey,
  ADD COLUMN source_index integer NOT NULL DEFAULT 0
    CHECK (source_index BETWEEN 0 AND 4095),
  ADD COLUMN source_kind text NOT NULL DEFAULT 'column'
    CHECK (source_kind IN ('column', 'constant')),
  ADD COLUMN source_expression_digest varchar(71);

ALTER TABLE runtime.property_provenance DISABLE TRIGGER property_provenance_immutable;
UPDATE runtime.property_provenance
SET source_expression_digest = value_digest
WHERE source_expression_digest IS NULL;
ALTER TABLE runtime.property_provenance ENABLE TRIGGER property_provenance_immutable;

ALTER TABLE runtime.property_provenance
  ALTER COLUMN input_column_ordinal DROP NOT NULL,
  ALTER COLUMN source_index DROP DEFAULT,
  ALTER COLUMN source_kind DROP DEFAULT,
  ALTER COLUMN source_expression_digest SET NOT NULL,
  ADD CONSTRAINT property_provenance_source_expression_digest_ck CHECK (
    source_expression_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT property_provenance_source_shape_ck CHECK (
    (source_kind = 'column' AND input_column_ordinal BETWEEN 0 AND 4095)
    OR (source_kind = 'constant' AND input_column_ordinal IS NULL)
  ),
  ADD PRIMARY KEY (
    project_id, generation_id, object_type_resource_id, object_rid,
    property_api_name, source_index
  );

-- Legacy rows remain readable. New G2-02-07 finalization requires every exact
-- version field below to be non-NULL through its controlled function.
ALTER TABLE runtime.rejected_row_sets
  ADD COLUMN object_key varchar(512),
  ADD COLUMN object_version varchar(1024),
  ADD COLUMN byte_count bigint CHECK (byte_count IS NULL OR byte_count >= 1),
  ADD COLUMN orphaned boolean NOT NULL DEFAULT false;

CREATE TABLE runtime.object_head_candidates (
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  object_type_resource_id uuid NOT NULL,
  object_type_revision_id uuid NOT NULL,
  object_rid uuid NOT NULL,
  previous_head_version bigint CHECK (previous_head_version IS NULL OR previous_head_version >= 1),
  previous_head_digest varchar(71) CHECK (
    previous_head_digest IS NULL OR previous_head_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  candidate_head_version bigint NOT NULL CHECK (candidate_head_version >= 1),
  candidate_head_digest varchar(71) NOT NULL
    CHECK (candidate_head_digest ~ '^sha256:[0-9a-f]{64}$'),
  disposition text NOT NULL CHECK (disposition IN ('insert', 'unchanged', 'update')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, generation_id, object_type_resource_id, object_rid),
  CONSTRAINT object_head_candidates_current_fk FOREIGN KEY (
    project_id, generation_id, object_type_resource_id, object_type_revision_id,
    object_rid, candidate_head_digest
  ) REFERENCES runtime.object_current(
    project_id, generation_id, object_type_resource_id, object_type_revision_id,
    object_rid, base_value_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT object_head_candidates_previous_shape_ck CHECK (
    (previous_head_version IS NULL AND previous_head_digest IS NULL
      AND candidate_head_version = 1 AND disposition = 'insert')
    OR (previous_head_version IS NOT NULL AND previous_head_digest IS NOT NULL
      AND ((disposition = 'unchanged'
        AND candidate_head_version = previous_head_version
        AND candidate_head_digest = previous_head_digest)
      OR (disposition = 'update'
        AND candidate_head_version = previous_head_version + 1
        AND candidate_head_digest <> previous_head_digest)))
  )
);

CREATE TABLE runtime.materialization_quality_bindings (
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  report_id uuid NOT NULL,
  report_digest varchar(71) NOT NULL
    CHECK (report_digest ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_digest varchar(71) NOT NULL
    CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  mapping_revision_digest varchar(71) NOT NULL
    CHECK (mapping_revision_digest ~ '^sha256:[0-9a-f]{64}$'),
  observation_digest varchar(71) NOT NULL
    CHECK (observation_digest ~ '^sha256:[0-9a-f]{64}$'),
  current_digest varchar(71) NOT NULL
    CHECK (current_digest ~ '^sha256:[0-9a-f]{64}$'),
  provenance_digest varchar(71) NOT NULL
    CHECK (provenance_digest ~ '^sha256:[0-9a-f]{64}$'),
  zero_overlay_row_count bigint NOT NULL CHECK (zero_overlay_row_count = 0),
  state text NOT NULL CHECK (state IN ('passed', 'awaiting_confirmation', 'confirmed', 'failed')),
  quality_binding_digest varchar(71) NOT NULL
    CHECK (quality_binding_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, generation_id),
  CONSTRAINT materialization_quality_bindings_generation_fk
    FOREIGN KEY (project_id, generation_id)
    REFERENCES runtime.generations(project_id, generation_id) ON DELETE RESTRICT,
  CONSTRAINT materialization_quality_bindings_report_fk
    FOREIGN KEY (project_id, report_id, report_digest)
    REFERENCES runtime.materialization_reports(project_id, report_id, report_digest)
    ON DELETE RESTRICT,
  CONSTRAINT materialization_quality_bindings_digest_uq
    UNIQUE (project_id, quality_binding_digest)
);

CREATE TABLE runtime.materialization_confirmations (
  project_id uuid NOT NULL,
  confirmation_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  actor_principal_id uuid NOT NULL,
  snapshot_digest varchar(71) NOT NULL
    CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  report_id uuid NOT NULL,
  report_digest varchar(71) NOT NULL
    CHECK (report_digest ~ '^sha256:[0-9a-f]{64}$'),
  observed_rows bigint NOT NULL CHECK (observed_rows >= 0),
  baseline_rows bigint NOT NULL CHECK (baseline_rows >= 0),
  threshold_basis_points integer NOT NULL CHECK (threshold_basis_points BETWEEN 0 AND 10000),
  publication_control_sequence bigint NOT NULL CHECK (publication_control_sequence >= 0),
  decision text NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  expires_at timestamptz NOT NULL,
  confirmation_digest varchar(71) NOT NULL
    CHECK (confirmation_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, confirmation_id),
  CONSTRAINT materialization_confirmations_generation_uq UNIQUE (project_id, generation_id),
  CONSTRAINT materialization_confirmations_generation_fk
    FOREIGN KEY (project_id, generation_id)
    REFERENCES runtime.generations(project_id, generation_id) ON DELETE RESTRICT,
  CONSTRAINT materialization_confirmations_principal_fk
    FOREIGN KEY (actor_principal_id)
    REFERENCES authz.principals(principal_id) ON DELETE RESTRICT,
  CONSTRAINT materialization_confirmations_report_fk
    FOREIGN KEY (project_id, report_id, report_digest)
    REFERENCES runtime.materialization_reports(project_id, report_id, report_digest)
    ON DELETE RESTRICT,
  CONSTRAINT materialization_confirmations_digest_uq UNIQUE (project_id, confirmation_digest),
  CONSTRAINT materialization_confirmations_expiry_ck CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '1 hour'
  )
);

CREATE TABLE ops.materialization_quality_observations (
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  job_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  snapshot_id uuid NOT NULL,
  file_id uuid NOT NULL,
  row_number bigint NOT NULL CHECK (row_number >= 1),
  reason_code text NOT NULL CHECK (reason_code IN (
    'PRIMARY_KEY_NULL', 'PRIMARY_KEY_DUPLICATE', 'REQUIRED_PROPERTY_INVALID',
    'OPTIONAL_PROPERTY_INVALID', 'REQUIRED_LINK_DANGLING', 'OPTIONAL_LINK_DANGLING'
  )),
  fingerprint varchar(71) NOT NULL
    CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  column_classification text NOT NULL CHECK (column_classification IN (
    'identifier', 'internal', 'confidential', 'restricted', 'redacted'
  )),
  phase text NOT NULL CHECK (phase IN (
    'mapping', 'identity_lookup', 'primary_key_collision', 'current_resolution'
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, generation_id, file_id, row_number),
  CONSTRAINT materialization_quality_observations_generation_fk
    FOREIGN KEY (project_id, generation_id)
    REFERENCES runtime.generations(project_id, generation_id) ON DELETE RESTRICT,
  CONSTRAINT materialization_quality_observations_attempt_fk FOREIGN KEY (
    project_id, attempt_id, job_id, fencing_token
  ) REFERENCES ops.materialization_attempts(
    project_id, attempt_id, job_id, fencing_token
  ) ON DELETE RESTRICT,
  CONSTRAINT materialization_quality_observations_file_fk FOREIGN KEY (
    project_id, snapshot_id, file_id
  ) REFERENCES runtime.snapshot_files(project_id, snapshot_id, file_id) ON DELETE RESTRICT
);

CREATE INDEX materialization_quality_observations_page_idx
  ON ops.materialization_quality_observations(
    project_id, generation_id, file_id, row_number, reason_code, fingerprint
  );

CREATE TABLE ops.materialization_provenance_templates (
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  mapping_revision_id uuid NOT NULL,
  property_api_name varchar(63) NOT NULL
    CHECK (property_api_name ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$'),
  source_index integer NOT NULL CHECK (source_index BETWEEN 0 AND 4095),
  source_kind text NOT NULL CHECK (source_kind IN ('column', 'constant')),
  input_column_ordinal integer,
  source_expression_digest varchar(71) NOT NULL
    CHECK (source_expression_digest ~ '^sha256:[0-9a-f]{64}$'),
  algorithm_version varchar(128) NOT NULL CHECK (
    algorithm_version ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, generation_id, property_api_name, source_index),
  CONSTRAINT materialization_provenance_templates_generation_fk
    FOREIGN KEY (project_id, generation_id)
    REFERENCES runtime.generations(project_id, generation_id) ON DELETE RESTRICT,
  CONSTRAINT materialization_provenance_templates_mapping_fk
    FOREIGN KEY (mapping_revision_id)
    REFERENCES meta.resource_revisions(revision_id) ON DELETE RESTRICT,
  CONSTRAINT materialization_provenance_templates_source_shape_ck CHECK (
    (source_kind = 'column' AND input_column_ordinal BETWEEN 0 AND 4095)
    OR (source_kind = 'constant' AND input_column_ordinal IS NULL)
  )
);

CREATE TABLE ops.materialization_quality_preparations (
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  prepared_by_attempt_id uuid NOT NULL,
  total_rows bigint NOT NULL CHECK (total_rows >= 0),
  accepted_rows bigint NOT NULL CHECK (accepted_rows >= 0),
  rejected_rows bigint NOT NULL CHECK (rejected_rows >= 0),
  observation_digest varchar(71) NOT NULL
    CHECK (observation_digest ~ '^sha256:[0-9a-f]{64}$'),
  current_digest varchar(71) NOT NULL
    CHECK (current_digest ~ '^sha256:[0-9a-f]{64}$'),
  provenance_digest varchar(71) NOT NULL
    CHECK (provenance_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, generation_id),
  CONSTRAINT materialization_quality_preparations_total_ck
    CHECK (accepted_rows + rejected_rows = total_rows),
  CONSTRAINT materialization_quality_preparations_generation_fk
    FOREIGN KEY (project_id, generation_id)
    REFERENCES runtime.generations(project_id, generation_id) ON DELETE RESTRICT,
  CONSTRAINT materialization_quality_preparations_attempt_fk
    FOREIGN KEY (project_id, prepared_by_attempt_id)
    REFERENCES ops.materialization_attempts(project_id, attempt_id) ON DELETE RESTRICT
);

CREATE FUNCTION ontos_migration.g20207_assert_live_quality(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_generation_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20207_assert_live_quality$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM ops.materialization_jobs AS job
    JOIN runtime.generations AS generation
      ON generation.project_id = job.project_id
     AND generation.snapshot_group_id = job.snapshot_group_id
     AND generation.group_version = job.group_version
    JOIN ops.materialization_generation_stages AS stage
      ON stage.project_id = generation.project_id
     AND stage.generation_id = generation.generation_id
     AND stage.attempt_id = p_attempt_id
     AND stage.job_id = job.job_id
     AND stage.fencing_token = p_fencing_token
     AND stage.state = 'promoted'
    WHERE job.project_id = p_project_id
      AND job.job_id = p_job_id
      AND job.state = 'running'
      AND job.current_attempt_id = p_attempt_id
      AND job.fencing_token = p_fencing_token
      AND job.lease_expires_at > clock_timestamp()
      AND generation.generation_id = p_generation_id
      AND generation.state = 'building'
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_FENCED' USING ERRCODE = '55000';
  END IF;
END
$g20207_assert_live_quality$;

CREATE FUNCTION ontos_migration.g20207_observation_line(
  p_file_id uuid,
  p_row_number bigint,
  p_reason_code text,
  p_fingerprint text,
  p_column_classification text
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $g20207_observation_line$
  SELECT '{"columnClassification":' || to_json(p_column_classification)::text ||
    ',"fileId":' || to_json(p_file_id::text)::text ||
    ',"fingerprint":' || to_json(p_fingerprint)::text ||
    ',"reasonCode":' || to_json(p_reason_code)::text ||
    ',"rowNumber":' || p_row_number::text ||
    ',"schemaVersion":1}'
$g20207_observation_line$;

CREATE FUNCTION ontos_migration.g20207_observation_digest(
  p_project_id uuid,
  p_generation_id uuid
) RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $g20207_observation_digest$
  SELECT 'sha256:' || encode(sha256(convert_to(
    COALESCE(string_agg(
      ontos_migration.g20207_observation_line(
        observation.file_id, observation.row_number, observation.reason_code,
        observation.fingerprint, observation.column_classification
      ), E'\n' ORDER BY observation.file_id, observation.row_number,
        observation.reason_code COLLATE "C", observation.fingerprint COLLATE "C"
    ) || E'\n', ''), 'UTF8'
  )), 'hex')
  FROM ops.materialization_quality_observations AS observation
  WHERE observation.project_id = p_project_id
    AND observation.generation_id = p_generation_id
$g20207_observation_digest$;

CREATE FUNCTION ontos_migration.g20207_current_digest(
  p_project_id uuid,
  p_generation_id uuid,
  p_member_kind text
) RETURNS text
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog
AS $g20207_current_digest$
DECLARE
  preimage text;
BEGIN
  IF p_member_kind = 'object' THEN
    SELECT COALESCE(string_agg(
      row.object_type_resource_id::text || ':' || row.object_rid::text || ':' ||
      row.base_value_digest,
      E'\n' ORDER BY row.object_type_resource_id, row.object_rid
    ) || E'\n', '') INTO preimage
    FROM runtime.object_current AS row
    WHERE row.project_id = p_project_id AND row.generation_id = p_generation_id;
  ELSIF p_member_kind = 'link' THEN
    SELECT COALESCE(string_agg(
      row.link_type_resource_id::text || ':' || row.link_rid::text || ':' ||
      row.source_object_type_resource_id::text || ':' || row.source_object_rid::text || ':' ||
      row.target_object_type_resource_id::text || ':' || row.target_object_rid::text || ':' ||
      row.base_value_digest,
      E'\n' ORDER BY row.link_type_resource_id, row.link_rid
    ) || E'\n', '') INTO preimage
    FROM runtime.link_current AS row
    WHERE row.project_id = p_project_id AND row.generation_id = p_generation_id;
  ELSE
    RAISE EXCEPTION 'G20207_QUALITY_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN 'sha256:' || encode(sha256(convert_to(preimage, 'UTF8')), 'hex');
END
$g20207_current_digest$;

CREATE FUNCTION ontos_migration.g20207_provenance_digest(
  p_project_id uuid,
  p_generation_id uuid
) RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $g20207_provenance_digest$
  SELECT 'sha256:' || encode(sha256(convert_to(COALESCE(string_agg(
    provenance.object_type_resource_id::text || ':' || provenance.object_rid::text || ':' ||
    provenance.property_api_name || ':' || provenance.source_index::text || ':' ||
    provenance.source_kind || ':' || COALESCE(provenance.input_column_ordinal::text, '-') || ':' ||
    provenance.source_snapshot_id::text || ':' || provenance.source_file_id::text || ':' ||
    provenance.source_row_number::text || ':' || provenance.mapping_revision_id::text || ':' ||
    provenance.algorithm_version || ':' || provenance.source_expression_digest || ':' ||
    provenance.value_digest,
    E'\n' ORDER BY provenance.object_type_resource_id, provenance.object_rid,
      provenance.property_api_name COLLATE "C", provenance.source_index
  ) || E'\n', ''), 'UTF8')), 'hex')
  FROM runtime.property_provenance AS provenance
  WHERE provenance.project_id = p_project_id
    AND provenance.generation_id = p_generation_id
$g20207_provenance_digest$;

CREATE OR REPLACE FUNCTION ontos_migration.g20203_validate_report() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20203_validate_report$
DECLARE
  affected_project_id uuid := COALESCE(NEW.project_id, OLD.project_id);
  affected_report_id uuid := COALESCE(NEW.report_id, OLD.report_id);
  report runtime.materialization_reports%ROWTYPE;
  rejected_reason_rows numeric;
  has_fatal boolean;
  has_confirmation boolean;
BEGIN
  SELECT * INTO report FROM runtime.materialization_reports
  WHERE project_id = affected_project_id AND report_id = affected_report_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(reason_count) FILTER (
      WHERE reason_code <> 'ROW_COUNT_CONFIRMATION_REQUIRED'
    ), 0),
    COALESCE(bool_or(reason_code IN (
      'PRIMARY_KEY_NULL', 'PRIMARY_KEY_DUPLICATE',
      'REQUIRED_PROPERTY_INVALID', 'REQUIRED_LINK_DANGLING'
    )), false),
    COALESCE(bool_or(reason_code = 'ROW_COUNT_CONFIRMATION_REQUIRED'), false)
  INTO rejected_reason_rows, has_fatal, has_confirmation
  FROM runtime.materialization_report_reasons
  WHERE project_id = affected_project_id AND report_id = affected_report_id;
  IF rejected_reason_rows <> report.rejected_rows
    OR (report.outcome = 'passed' AND (has_fatal OR has_confirmation))
    OR (report.outcome = 'awaiting_confirmation' AND (NOT has_confirmation OR has_fatal))
    OR (report.outcome = 'failed' AND report.rejected_rows = 0) THEN
    RAISE EXCEPTION 'G20203_MATERIALIZATION_REPORT_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$g20203_validate_report$;

CREATE OR REPLACE FUNCTION ontos_migration.g20203_enforce_lifecycle() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_enforce_lifecycle$
DECLARE
  allowed boolean := false;
  quality_late_binding boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'dataset_snapshots' THEN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
      OR NEW.snapshot_group_id IS DISTINCT FROM OLD.snapshot_group_id
      OR NEW.group_version IS DISTINCT FROM OLD.group_version
      OR NEW.member_key IS DISTINCT FROM OLD.member_key
      OR NEW.member_kind IS DISTINCT FROM OLD.member_kind
      OR NEW.target_resource_id IS DISTINCT FROM OLD.target_resource_id
      OR NEW.target_revision_id IS DISTINCT FROM OLD.target_revision_id
      OR NEW.snapshot_schema_resource_id IS DISTINCT FROM OLD.snapshot_schema_resource_id
      OR NEW.snapshot_schema_revision_id IS DISTINCT FROM OLD.snapshot_schema_revision_id
      OR NEW.mapping_resource_id IS DISTINCT FROM OLD.mapping_resource_id
      OR NEW.mapping_revision_id IS DISTINCT FROM OLD.mapping_revision_id
      OR NEW.runtime_plan_digest IS DISTINCT FROM OLD.runtime_plan_digest
      OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
      OR NEW.byte_count IS DISTINCT FROM OLD.byte_count
      OR NEW.row_count IS DISTINCT FROM OLD.row_count
      OR NEW.file_count IS DISTINCT FROM OLD.file_count
      OR NEW.previous_snapshot_id IS DISTINCT FROM OLD.previous_snapshot_id
      OR NEW.snapshot_digest IS DISTINCT FROM OLD.snapshot_digest
      OR NEW.registered_at IS DISTINCT FROM OLD.registered_at THEN
      RAISE EXCEPTION 'G20203_LIFECYCLE_FACT_IMMUTABLE:dataset_snapshots'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'snapshot_group_versions' THEN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.snapshot_group_id IS DISTINCT FROM OLD.snapshot_group_id
      OR NEW.group_version IS DISTINCT FROM OLD.group_version
      OR NEW.member_count IS DISTINCT FROM OLD.member_count
      OR NEW.group_digest IS DISTINCT FROM OLD.group_digest
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'G20203_LIFECYCLE_FACT_IMMUTABLE:snapshot_group_versions'
        USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'generations' THEN
    quality_late_binding := OLD.state = 'building'
      AND OLD.report_id IS NULL AND OLD.report_digest IS NULL AND OLD.generation_digest IS NULL
      AND NEW.report_id IS NOT NULL AND NEW.report_digest IS NOT NULL
      AND NEW.generation_digest IS NOT NULL;
    IF NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
      OR NEW.member_key IS DISTINCT FROM OLD.member_key
      OR NEW.member_kind IS DISTINCT FROM OLD.member_kind
      OR NEW.target_resource_id IS DISTINCT FROM OLD.target_resource_id
      OR NEW.target_revision_id IS DISTINCT FROM OLD.target_revision_id
      OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
      OR NEW.snapshot_group_id IS DISTINCT FROM OLD.snapshot_group_id
      OR NEW.group_version IS DISTINCT FROM OLD.group_version
      OR NEW.snapshot_schema_resource_id IS DISTINCT FROM OLD.snapshot_schema_resource_id
      OR NEW.snapshot_schema_revision_id IS DISTINCT FROM OLD.snapshot_schema_revision_id
      OR NEW.mapping_resource_id IS DISTINCT FROM OLD.mapping_resource_id
      OR NEW.mapping_revision_id IS DISTINCT FROM OLD.mapping_revision_id
      OR NEW.runtime_plan_digest IS DISTINCT FROM OLD.runtime_plan_digest
      OR NEW.index_plan_digest IS DISTINCT FROM OLD.index_plan_digest
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR ((NEW.report_id IS DISTINCT FROM OLD.report_id
        OR NEW.report_digest IS DISTINCT FROM OLD.report_digest
        OR NEW.generation_digest IS DISTINCT FROM OLD.generation_digest)
        AND NOT quality_late_binding) THEN
      RAISE EXCEPTION 'G20203_LIFECYCLE_FACT_IMMUTABLE:generations'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'G20203_LIFECYCLE_TRIGGER_MISCONFIGURED:%', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;

  IF NEW.state = OLD.state THEN
    allowed := true;
  ELSIF TG_TABLE_NAME IN ('dataset_snapshots', 'snapshot_group_versions') THEN
    allowed := (OLD.state = 'registered' AND NEW.state IN ('validated', 'failed'))
      OR (OLD.state = 'validated' AND NEW.state IN ('materializing', 'failed'))
      OR (OLD.state = 'materializing' AND NEW.state IN ('ready', 'failed'))
      OR (OLD.state = 'ready' AND NEW.state IN ('active', 'failed'))
      OR (OLD.state = 'active' AND NEW.state = 'superseded');
  ELSIF TG_TABLE_NAME = 'generations' THEN
    allowed := (OLD.state = 'building' AND NEW.state IN ('ready', 'failed'))
      OR (OLD.state = 'ready' AND NEW.state IN ('active', 'failed'))
      OR (OLD.state = 'active' AND NEW.state = 'retired');
  END IF;
  IF NOT allowed THEN
    RAISE EXCEPTION 'G20203_STATE_TRANSITION_INVALID:%:%:%',
      TG_TABLE_NAME, OLD.state, NEW.state USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'generations' THEN
    IF NEW.state = 'ready' AND NOT EXISTS (
      SELECT 1
      FROM runtime.materialization_quality_bindings AS binding
      JOIN runtime.materialization_reports AS report
        ON report.project_id = binding.project_id
       AND report.report_id = binding.report_id
       AND report.report_digest = binding.report_digest
      WHERE binding.project_id = NEW.project_id
        AND binding.generation_id = NEW.generation_id
        AND binding.report_id = NEW.report_id
        AND binding.report_digest = NEW.report_digest
        AND binding.state IN ('passed', 'confirmed')
        AND binding.zero_overlay_row_count = 0
        AND report.accepted_rows = CASE NEW.member_kind
          WHEN 'object' THEN (
            SELECT count(*) FROM runtime.object_current AS current
            WHERE current.project_id = NEW.project_id
              AND current.generation_id = NEW.generation_id
              AND current.object_type_resource_id = NEW.target_resource_id
              AND current.object_type_revision_id = NEW.target_revision_id
          )
          ELSE (
            SELECT count(*) FROM runtime.link_current AS current
            WHERE current.project_id = NEW.project_id
              AND current.generation_id = NEW.generation_id
              AND current.link_type_resource_id = NEW.target_resource_id
              AND current.link_type_revision_id = NEW.target_revision_id
          )
        END
    ) THEN
      RAISE EXCEPTION 'G20207_QUALITY_BINDING_REQUIRED' USING ERRCODE = '55000';
    END IF;
    IF NEW.state = 'ready' AND NEW.member_kind = 'object' AND EXISTS (
        SELECT 1
        FROM runtime.object_current AS current
        CROSS JOIN LATERAL jsonb_object_keys(current.properties -> 'values') AS property(api_name)
        WHERE current.project_id = NEW.project_id
          AND current.generation_id = NEW.generation_id
          AND NOT EXISTS (
            SELECT 1 FROM runtime.property_provenance AS provenance
            WHERE provenance.project_id = current.project_id
              AND provenance.generation_id = current.generation_id
              AND provenance.object_type_resource_id = current.object_type_resource_id
              AND provenance.object_rid = current.object_rid
              AND provenance.property_api_name = property.api_name
          )
      ) THEN
      RAISE EXCEPTION 'G20207_PROVENANCE_INCOMPLETE' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$g20203_enforce_lifecycle$;

CREATE FUNCTION ops.get_materialization_quality_scope(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_generation_id uuid
) RETURNS TABLE (
  project_id uuid,
  job_id uuid,
  generation_id uuid,
  member_kind text,
  target_resource_id uuid,
  target_revision_id uuid,
  snapshot_id uuid,
  snapshot_digest text,
  snapshot_group_id uuid,
  group_version bigint,
  mapping_revision_id uuid,
  mapping_revision_digest text,
  source_row_count bigint,
  previous_accepted_rows bigint,
  quality_rules jsonb,
  link_dangling_disposition text,
  publication_control_sequence bigint
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $get_materialization_quality_scope$
BEGIN
  PERFORM ontos_migration.g20207_assert_live_quality(
    p_project_id, p_job_id, p_attempt_id, p_fencing_token, p_generation_id
  );
  RETURN QUERY
  SELECT generation.project_id, p_job_id, generation.generation_id,
         generation.member_kind, generation.target_resource_id,
         generation.target_revision_id, generation.snapshot_id,
         snapshot.snapshot_digest::text, generation.snapshot_group_id,
         generation.group_version, generation.mapping_revision_id,
         mapping.content_digest::text, snapshot.row_count,
         prior.accepted_rows,
         mapping.content -> 'qualityRules',
         CASE
           WHEN generation.member_kind = 'link'
             AND mapping.content ->> 'linkDanglingDisposition' = 'optional'
           THEN 'optional'
           ELSE 'required'
         END,
         project.publication_sequence
  FROM runtime.generations AS generation
  JOIN runtime.dataset_snapshots AS snapshot
    ON snapshot.project_id = generation.project_id
   AND snapshot.snapshot_id = generation.snapshot_id
  JOIN meta.resource_revisions AS mapping
    ON mapping.revision_id = generation.mapping_revision_id
   AND mapping.resource_id = generation.mapping_resource_id
   AND mapping.family = 'mapping'
   AND mapping.state = 'published'
  JOIN meta.projects AS project ON project.project_id = generation.project_id
  LEFT JOIN LATERAL (
    SELECT report.accepted_rows
    FROM runtime.dataset_snapshots AS old_snapshot
    JOIN runtime.generations AS old_generation
      ON old_generation.project_id = old_snapshot.project_id
     AND old_generation.snapshot_id = old_snapshot.snapshot_id
     AND old_generation.member_key = old_snapshot.member_key
    JOIN runtime.materialization_quality_bindings AS old_binding
      ON old_binding.project_id = old_generation.project_id
     AND old_binding.generation_id = old_generation.generation_id
     AND old_binding.state IN ('passed', 'confirmed')
    JOIN runtime.materialization_reports AS report
      ON report.project_id = old_binding.project_id
     AND report.report_id = old_binding.report_id
    WHERE old_snapshot.project_id = generation.project_id
      AND old_snapshot.snapshot_group_id = generation.snapshot_group_id
      AND old_snapshot.member_key = generation.member_key
      AND old_snapshot.group_version < generation.group_version
    ORDER BY old_snapshot.group_version DESC
    LIMIT 1
  ) AS prior ON true
  WHERE generation.project_id = p_project_id
    AND generation.generation_id = p_generation_id
    AND generation.state = 'building';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20207_QUALITY_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;
END
$get_materialization_quality_scope$;

CREATE FUNCTION ops.stage_materialization_quality_observations(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_generation_id uuid,
  p_observations jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $stage_materialization_quality_observations$
DECLARE
  source_snapshot_id uuid;
  item_count integer;
BEGIN
  IF p_observations IS NULL OR jsonb_typeof(p_observations) <> 'array' THEN
    RAISE EXCEPTION 'G20207_QUALITY_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  item_count := jsonb_array_length(p_observations);
  IF item_count > 1000 THEN
    RAISE EXCEPTION 'G20207_QUALITY_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM ontos_migration.g20207_assert_live_quality(
    p_project_id, p_job_id, p_attempt_id, p_fencing_token, p_generation_id
  );
  IF EXISTS (
    SELECT 1 FROM ops.materialization_quality_preparations
    WHERE project_id = p_project_id AND generation_id = p_generation_id
  ) OR EXISTS (
    SELECT 1 FROM runtime.materialization_quality_bindings
    WHERE project_id = p_project_id AND generation_id = p_generation_id
  ) THEN
    RAISE EXCEPTION 'G20207_STAGING_CURRENT_CONFLICT' USING ERRCODE = '23505';
  END IF;
  SELECT snapshot_id INTO source_snapshot_id
  FROM runtime.generations
  WHERE project_id = p_project_id AND generation_id = p_generation_id;
  IF item_count = 0 THEN RETURN; END IF;

  BEGIN
    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_observations) AS item(
        "fileId" text, "rowNumber" bigint, "reasonCode" text,
        "fingerprint" text, "columnClassification" text, "phase" text
      )
      WHERE item."fileId" IS NULL OR item."rowNumber" < 1
        OR item."reasonCode" NOT IN (
          'PRIMARY_KEY_NULL', 'PRIMARY_KEY_DUPLICATE', 'REQUIRED_PROPERTY_INVALID',
          'OPTIONAL_PROPERTY_INVALID', 'REQUIRED_LINK_DANGLING', 'OPTIONAL_LINK_DANGLING'
        ) OR item."fingerprint" !~ '^sha256:[0-9a-f]{64}$'
        OR item."columnClassification" NOT IN (
          'identifier', 'internal', 'confidential', 'restricted', 'redacted'
        ) OR item."phase" NOT IN ('mapping', 'identity_lookup', 'primary_key_collision')
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_observations) AS item(
        "fileId" text, "rowNumber" bigint, "reasonCode" text,
        "fingerprint" text, "columnClassification" text, "phase" text
      )
      GROUP BY item."fileId", item."rowNumber" HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'G20207_QUALITY_REQUEST_INVALID' USING ERRCODE = '22023';
    END IF;

    INSERT INTO ops.materialization_quality_observations (
      project_id, generation_id, job_id, attempt_id, fencing_token,
      snapshot_id, file_id, row_number, reason_code, fingerprint,
      column_classification, phase
    )
    SELECT p_project_id, p_generation_id, p_job_id, p_attempt_id, p_fencing_token,
           source_snapshot_id, item."fileId"::uuid, item."rowNumber",
           item."reasonCode", item."fingerprint", item."columnClassification", item."phase"
    FROM jsonb_to_recordset(p_observations) AS item(
      "fileId" text, "rowNumber" bigint, "reasonCode" text,
      "fingerprint" text, "columnClassification" text, "phase" text
    )
    ON CONFLICT (project_id, generation_id, file_id, row_number) DO NOTHING;

    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_observations) AS item(
        "fileId" text, "rowNumber" bigint, "reasonCode" text,
        "fingerprint" text, "columnClassification" text, "phase" text
      )
      LEFT JOIN ops.materialization_quality_observations AS stored
        ON stored.project_id = p_project_id
       AND stored.generation_id = p_generation_id
       AND stored.file_id = item."fileId"::uuid
       AND stored.row_number = item."rowNumber"
      WHERE stored.reason_code IS DISTINCT FROM item."reasonCode"
        OR stored.fingerprint IS DISTINCT FROM item."fingerprint"
        OR stored.column_classification IS DISTINCT FROM item."columnClassification"
        OR stored.phase IS DISTINCT FROM item."phase"
    ) THEN
      RAISE EXCEPTION 'G20207_QUALITY_OBSERVATION_CONFLICT' USING ERRCODE = '23505';
    END IF;
  EXCEPTION WHEN invalid_text_representation OR foreign_key_violation OR check_violation THEN
    RAISE EXCEPTION 'G20207_QUALITY_REQUEST_INVALID' USING ERRCODE = '22023';
  END;
END
$stage_materialization_quality_observations$;

CREATE FUNCTION ops.prepare_materialization_staging_current(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_generation_id uuid,
  p_provenance_templates jsonb
) RETURNS TABLE (
  total_rows bigint,
  accepted_rows bigint,
  rejected_rows bigint,
  reason_counts jsonb,
  observation_digest text,
  current_digest text,
  provenance_digest text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $prepare_materialization_staging_current$
DECLARE
  generation runtime.generations%ROWTYPE;
  snapshot runtime.dataset_snapshots%ROWTYPE;
  mapping_content jsonb;
  snapshot_schema_content jsonb;
  target_content jsonb;
  endpoint_source_resource_id uuid;
  endpoint_source_revision_id uuid;
  endpoint_target_resource_id uuid;
  endpoint_target_revision_id uuid;
  dangling_reason text;
  actual_current_rows bigint;
  actual_rejected_rows bigint;
  computed_observation_digest text;
  computed_current_digest text;
  computed_provenance_digest text;
  computed_reason_counts jsonb;
  existing ops.materialization_quality_preparations%ROWTYPE;
BEGIN
  IF p_provenance_templates IS NULL
    OR jsonb_typeof(p_provenance_templates) <> 'array'
    OR jsonb_array_length(p_provenance_templates) > 4096 THEN
    RAISE EXCEPTION 'G20207_QUALITY_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM ontos_migration.g20207_assert_live_quality(
    p_project_id, p_job_id, p_attempt_id, p_fencing_token, p_generation_id
  );
  SELECT * INTO generation FROM runtime.generations
  WHERE project_id = p_project_id AND generation_id = p_generation_id
  FOR UPDATE;
  SELECT * INTO snapshot FROM runtime.dataset_snapshots
  WHERE project_id = generation.project_id AND snapshot_id = generation.snapshot_id;
  SELECT mapping.content INTO mapping_content
  FROM meta.resource_revisions AS mapping
  WHERE mapping.revision_id = generation.mapping_revision_id
    AND mapping.resource_id = generation.mapping_resource_id
    AND mapping.family = 'mapping' AND mapping.state = 'published';
  SELECT schema_revision.content INTO snapshot_schema_content
  FROM meta.resource_revisions AS schema_revision
  WHERE schema_revision.revision_id = generation.snapshot_schema_revision_id
    AND schema_revision.resource_id = generation.snapshot_schema_resource_id
    AND schema_revision.family = 'snapshot_schema'
    AND schema_revision.state = 'published';
  IF generation.member_kind = 'object' THEN
    SELECT target.content INTO target_content
    FROM meta.resource_revisions AS target
    WHERE target.revision_id = generation.target_revision_id
      AND target.resource_id = generation.target_resource_id
      AND target.family = 'object_type'
      AND target.state = 'published';
  END IF;
  IF mapping_content IS NULL OR snapshot_schema_content IS NULL
    OR snapshot.snapshot_id IS NULL
    OR (generation.member_kind = 'object' AND target_content IS NULL)
    OR generation.report_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM runtime.materialization_quality_bindings
      WHERE project_id = p_project_id AND generation_id = p_generation_id
    ) THEN
    RAISE EXCEPTION 'G20207_STAGING_CURRENT_CONFLICT' USING ERRCODE = '23505';
  END IF;

  IF generation.member_kind = 'object' THEN
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(p_provenance_templates) AS item(
          "propertyApiName" text, "sourceIndex" integer, "sourceKind" text,
          "inputColumnOrdinal" integer, "sourceExpressionDigest" text,
          "algorithmVersion" text
        )
        WHERE item."propertyApiName" !~ '^[A-Za-z][A-Za-z0-9_]{0,62}$'
          OR item."sourceIndex" NOT BETWEEN 0 AND 4095
          OR item."sourceKind" NOT IN ('column', 'constant')
          OR (item."sourceKind" = 'column' AND item."inputColumnOrdinal" NOT BETWEEN 0 AND 4095)
          OR (item."sourceKind" = 'constant' AND item."inputColumnOrdinal" IS NOT NULL)
          OR item."sourceExpressionDigest" !~ '^sha256:[0-9a-f]{64}$'
          OR item."algorithmVersion" !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$'
      ) OR EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(p_provenance_templates) AS item(
          "propertyApiName" text, "sourceIndex" integer, "sourceKind" text,
          "inputColumnOrdinal" integer, "sourceExpressionDigest" text,
          "algorithmVersion" text
        ) GROUP BY item."propertyApiName", item."sourceIndex" HAVING count(*) > 1
      ) OR EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(p_provenance_templates) AS item(
          "propertyApiName" text, "sourceIndex" integer, "sourceKind" text,
          "inputColumnOrdinal" integer, "sourceExpressionDigest" text,
          "algorithmVersion" text
        )
        WHERE (item."propertyApiName" <> target_content ->> 'primaryKeyPropertyApiName'
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(mapping_content -> 'propertyMappings') AS property(value)
            WHERE property.value ->> 'propertyApiName' = item."propertyApiName"
          )) OR (item."sourceKind" = 'column' AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(snapshot_schema_content -> 'columns') AS column_definition(value)
          WHERE (column_definition.value ->> 'ordinal')::integer = item."inputColumnOrdinal"
        ))
      ) OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(mapping_content -> 'propertyMappings') AS property(value)
        WHERE NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset(p_provenance_templates) AS item(
            "propertyApiName" text, "sourceIndex" integer, "sourceKind" text,
            "inputColumnOrdinal" integer, "sourceExpressionDigest" text,
            "algorithmVersion" text
          )
          WHERE item."propertyApiName" = property.value ->> 'propertyApiName'
        )
      ) OR NOT EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(p_provenance_templates) AS item(
          "propertyApiName" text, "sourceIndex" integer, "sourceKind" text,
          "inputColumnOrdinal" integer, "sourceExpressionDigest" text,
          "algorithmVersion" text
        )
        WHERE item."propertyApiName" = target_content ->> 'primaryKeyPropertyApiName'
      ) THEN
        RAISE EXCEPTION 'G20207_QUALITY_REQUEST_INVALID' USING ERRCODE = '22023';
      END IF;
      INSERT INTO ops.materialization_provenance_templates (
        project_id, generation_id, mapping_revision_id, property_api_name,
        source_index, source_kind, input_column_ordinal,
        source_expression_digest, algorithm_version
      )
      SELECT p_project_id, p_generation_id, generation.mapping_revision_id,
             item."propertyApiName", item."sourceIndex", item."sourceKind",
             item."inputColumnOrdinal", item."sourceExpressionDigest", item."algorithmVersion"
      FROM jsonb_to_recordset(p_provenance_templates) AS item(
        "propertyApiName" text, "sourceIndex" integer, "sourceKind" text,
        "inputColumnOrdinal" integer, "sourceExpressionDigest" text,
        "algorithmVersion" text
      )
      ON CONFLICT DO NOTHING;
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE EXCEPTION 'G20207_QUALITY_REQUEST_INVALID' USING ERRCODE = '22023';
    END;

    INSERT INTO runtime.object_current (
      project_id, generation_id, object_type_resource_id, object_type_revision_id,
      object_rid, canonical_primary_key, properties, base_value_digest
    )
    SELECT base.project_id, base.generation_id, base.object_type_resource_id,
           base.object_type_revision_id, base.object_rid, base.canonical_primary_key,
           base.properties, base.value_digest
    FROM runtime.object_base AS base
    WHERE base.project_id = p_project_id AND base.generation_id = p_generation_id
      AND NOT EXISTS (
        SELECT 1 FROM ops.materialization_quality_observations AS observation
        WHERE observation.project_id = base.project_id
          AND observation.generation_id = base.generation_id
          AND observation.file_id = base.source_file_id
          AND observation.row_number = base.source_row_number
      )
    ORDER BY base.object_type_resource_id, base.object_rid
    ON CONFLICT DO NOTHING;

    INSERT INTO runtime.property_provenance (
      project_id, generation_id, object_type_resource_id, object_rid,
      property_api_name, source_snapshot_id, source_file_id, source_row_number,
      input_column_ordinal, mapping_revision_id, algorithm_version,
      value_digest, source_index, source_kind, source_expression_digest
    )
    SELECT current.project_id, current.generation_id, current.object_type_resource_id,
           current.object_rid, template.property_api_name,
           base.source_snapshot_id, base.source_file_id, base.source_row_number,
           template.input_column_ordinal, base.mapping_revision_id,
           template.algorithm_version, current.base_value_digest,
           template.source_index, template.source_kind, template.source_expression_digest
    FROM runtime.object_current AS current
    JOIN runtime.object_base AS base
      ON base.project_id = current.project_id
     AND base.generation_id = current.generation_id
     AND base.object_type_resource_id = current.object_type_resource_id
     AND base.object_rid = current.object_rid
    JOIN ops.materialization_provenance_templates AS template
      ON template.project_id = current.project_id
     AND template.generation_id = current.generation_id
    WHERE current.project_id = p_project_id AND current.generation_id = p_generation_id
    ORDER BY current.object_type_resource_id, current.object_rid,
             template.property_api_name COLLATE "C", template.source_index
    ON CONFLICT DO NOTHING;

    IF EXISTS (
      SELECT 1
      FROM runtime.object_current AS current
      CROSS JOIN LATERAL jsonb_object_keys(current.properties -> 'values') AS property(api_name)
      WHERE current.project_id = p_project_id AND current.generation_id = p_generation_id
        AND NOT EXISTS (
          SELECT 1 FROM runtime.property_provenance AS provenance
          WHERE provenance.project_id = current.project_id
            AND provenance.generation_id = current.generation_id
            AND provenance.object_type_resource_id = current.object_type_resource_id
            AND provenance.object_rid = current.object_rid
            AND provenance.property_api_name = property.api_name
        )
    ) THEN
      RAISE EXCEPTION 'G20207_PROVENANCE_INCOMPLETE' USING ERRCODE = '23514';
    END IF;

    INSERT INTO runtime.object_head_candidates (
      project_id, generation_id, object_type_resource_id, object_type_revision_id,
      object_rid, previous_head_version, previous_head_digest,
      candidate_head_version, candidate_head_digest, disposition
    )
    SELECT current.project_id, current.generation_id, current.object_type_resource_id,
           current.object_type_revision_id, current.object_rid,
           head.head_version, head.head_digest,
           CASE WHEN head.object_rid IS NULL THEN 1
                WHEN head.head_digest = current.base_value_digest THEN head.head_version
                ELSE head.head_version + 1 END,
           current.base_value_digest,
           CASE WHEN head.object_rid IS NULL THEN 'insert'
                WHEN head.head_digest = current.base_value_digest THEN 'unchanged'
                ELSE 'update' END
    FROM runtime.object_current AS current
    LEFT JOIN runtime.object_heads AS head
      ON head.project_id = current.project_id
     AND head.object_type_resource_id = current.object_type_resource_id
     AND head.object_rid = current.object_rid
    WHERE current.project_id = p_project_id AND current.generation_id = p_generation_id
    ORDER BY current.object_type_resource_id, current.object_rid
    ON CONFLICT DO NOTHING;
  ELSE
    IF jsonb_array_length(p_provenance_templates) <> 0 THEN
      RAISE EXCEPTION 'G20207_QUALITY_REQUEST_INVALID' USING ERRCODE = '22023';
    END IF;
    SELECT source_revision.resource_id, source_revision.revision_id,
           target_revision.resource_id, target_revision.revision_id
    INTO endpoint_source_resource_id, endpoint_source_revision_id,
         endpoint_target_resource_id, endpoint_target_revision_id
    FROM meta.resource_revisions AS link_revision
    JOIN meta.resource_revisions AS source_revision
      ON source_revision.revision_id = (link_revision.content #>> '{source,objectTypeRevisionId}')::uuid
     AND source_revision.family = 'object_type'
    JOIN meta.resource_revisions AS target_revision
      ON target_revision.revision_id = (link_revision.content #>> '{target,objectTypeRevisionId}')::uuid
     AND target_revision.family = 'object_type'
    WHERE link_revision.revision_id = generation.target_revision_id
      AND link_revision.resource_id = generation.target_resource_id
      AND link_revision.family = 'link_type';
    IF NOT FOUND OR NOT EXISTS (
      SELECT 1 FROM runtime.generations AS object_generation
      JOIN runtime.materialization_quality_bindings AS quality
        ON quality.project_id = object_generation.project_id
       AND quality.generation_id = object_generation.generation_id
       AND quality.state IN ('passed', 'confirmed')
      WHERE object_generation.project_id = p_project_id
        AND object_generation.snapshot_group_id = generation.snapshot_group_id
        AND object_generation.group_version = generation.group_version
        AND object_generation.target_resource_id = endpoint_source_resource_id
        AND object_generation.target_revision_id = endpoint_source_revision_id
    ) OR NOT EXISTS (
      SELECT 1 FROM runtime.generations AS object_generation
      JOIN runtime.materialization_quality_bindings AS quality
        ON quality.project_id = object_generation.project_id
       AND quality.generation_id = object_generation.generation_id
       AND quality.state IN ('passed', 'confirmed')
      WHERE object_generation.project_id = p_project_id
        AND object_generation.snapshot_group_id = generation.snapshot_group_id
        AND object_generation.group_version = generation.group_version
        AND object_generation.target_resource_id = endpoint_target_resource_id
        AND object_generation.target_revision_id = endpoint_target_revision_id
    ) THEN
      RAISE EXCEPTION 'G20207_OBJECT_DEPENDENCY_INCOMPLETE' USING ERRCODE = '55000';
    END IF;
    dangling_reason := CASE
      WHEN mapping_content ->> 'linkDanglingDisposition' = 'optional'
      THEN 'OPTIONAL_LINK_DANGLING'
      ELSE 'REQUIRED_LINK_DANGLING'
    END;

    INSERT INTO ops.materialization_quality_observations (
      project_id, generation_id, job_id, attempt_id, fencing_token,
      snapshot_id, file_id, row_number, reason_code, fingerprint,
      column_classification, phase
    )
    SELECT base.project_id, base.generation_id, p_job_id, p_attempt_id, p_fencing_token,
           base.source_snapshot_id, base.source_file_id, base.source_row_number,
           dangling_reason,
           'sha256:' || encode(sha256(convert_to(
             base.source_file_id::text || ':' || base.source_row_number::text || ':' ||
             dangling_reason || ':' ||
             CASE WHEN source_current.object_rid IS NULL THEN 'source' ELSE '' END || ':' ||
             CASE WHEN target_current.object_rid IS NULL THEN 'target' ELSE '' END,
             'UTF8'
           )), 'hex'),
           'identifier', 'current_resolution'
    FROM runtime.link_base AS base
    LEFT JOIN runtime.generations AS source_generation
      ON source_generation.project_id = base.project_id
     AND source_generation.snapshot_group_id = generation.snapshot_group_id
     AND source_generation.group_version = generation.group_version
     AND source_generation.target_resource_id = endpoint_source_resource_id
     AND source_generation.target_revision_id = endpoint_source_revision_id
    LEFT JOIN runtime.materialization_quality_bindings AS source_quality
      ON source_quality.project_id = source_generation.project_id
     AND source_quality.generation_id = source_generation.generation_id
     AND source_quality.state IN ('passed', 'confirmed')
    LEFT JOIN runtime.object_current AS source_current
      ON source_current.project_id = base.project_id
     AND source_current.generation_id = source_generation.generation_id
     AND source_current.object_type_resource_id = endpoint_source_resource_id
     AND source_current.object_type_revision_id = endpoint_source_revision_id
     AND source_current.object_rid = base.source_object_rid
    LEFT JOIN runtime.generations AS target_generation
      ON target_generation.project_id = base.project_id
     AND target_generation.snapshot_group_id = generation.snapshot_group_id
     AND target_generation.group_version = generation.group_version
     AND target_generation.target_resource_id = endpoint_target_resource_id
     AND target_generation.target_revision_id = endpoint_target_revision_id
    LEFT JOIN runtime.materialization_quality_bindings AS target_quality
      ON target_quality.project_id = target_generation.project_id
     AND target_quality.generation_id = target_generation.generation_id
     AND target_quality.state IN ('passed', 'confirmed')
    LEFT JOIN runtime.object_current AS target_current
      ON target_current.project_id = base.project_id
     AND target_current.generation_id = target_generation.generation_id
     AND target_current.object_type_resource_id = endpoint_target_resource_id
     AND target_current.object_type_revision_id = endpoint_target_revision_id
     AND target_current.object_rid = base.target_object_rid
    WHERE base.project_id = p_project_id AND base.generation_id = p_generation_id
      AND (source_current.object_rid IS NULL OR target_current.object_rid IS NULL)
    ORDER BY base.source_file_id, base.source_row_number
    ON CONFLICT DO NOTHING;

    INSERT INTO runtime.link_current (
      project_id, generation_id, link_type_resource_id, link_type_revision_id,
      link_rid, source_object_type_resource_id, source_object_rid,
      target_object_type_resource_id, target_object_rid, base_value_digest
    )
    SELECT base.project_id, base.generation_id, base.link_type_resource_id,
           base.link_type_revision_id, base.link_rid,
           base.source_object_type_resource_id, base.source_object_rid,
           base.target_object_type_resource_id, base.target_object_rid,
           base.value_digest
    FROM runtime.link_base AS base
    WHERE base.project_id = p_project_id AND base.generation_id = p_generation_id
      AND NOT EXISTS (
        SELECT 1 FROM ops.materialization_quality_observations AS observation
        WHERE observation.project_id = base.project_id
          AND observation.generation_id = base.generation_id
          AND observation.file_id = base.source_file_id
          AND observation.row_number = base.source_row_number
      )
    ORDER BY base.link_type_resource_id, base.link_rid
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT count(*) INTO actual_rejected_rows
  FROM ops.materialization_quality_observations
  WHERE project_id = p_project_id AND generation_id = p_generation_id;
  IF generation.member_kind = 'object' THEN
    SELECT count(*) INTO actual_current_rows FROM runtime.object_current
    WHERE project_id = p_project_id AND generation_id = p_generation_id;
  ELSE
    SELECT count(*) INTO actual_current_rows FROM runtime.link_current
    WHERE project_id = p_project_id AND generation_id = p_generation_id;
  END IF;
  IF actual_current_rows + actual_rejected_rows <> snapshot.row_count THEN
    RAISE EXCEPTION 'G20207_STAGING_CURRENT_COUNT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'code', reason.reason_code, 'count', reason.reason_count
  ) ORDER BY reason.reason_code COLLATE "C"), '[]'::jsonb)
  INTO computed_reason_counts
  FROM (
    SELECT reason_code, count(*) AS reason_count
    FROM ops.materialization_quality_observations
    WHERE project_id = p_project_id AND generation_id = p_generation_id
    GROUP BY reason_code
  ) AS reason;
  computed_observation_digest := ontos_migration.g20207_observation_digest(
    p_project_id, p_generation_id
  );
  computed_current_digest := ontos_migration.g20207_current_digest(
    p_project_id, p_generation_id, generation.member_kind
  );
  computed_provenance_digest := ontos_migration.g20207_provenance_digest(
    p_project_id, p_generation_id
  );

  INSERT INTO ops.materialization_quality_preparations (
    project_id, generation_id, prepared_by_attempt_id,
    total_rows, accepted_rows, rejected_rows,
    observation_digest, current_digest, provenance_digest
  ) VALUES (
    p_project_id, p_generation_id, p_attempt_id,
    snapshot.row_count, actual_current_rows, actual_rejected_rows,
    computed_observation_digest, computed_current_digest, computed_provenance_digest
  ) ON CONFLICT DO NOTHING;
  SELECT * INTO existing FROM ops.materialization_quality_preparations
  WHERE project_id = p_project_id AND generation_id = p_generation_id;
  IF existing.total_rows <> snapshot.row_count
    OR existing.accepted_rows <> actual_current_rows
    OR existing.rejected_rows <> actual_rejected_rows
    OR existing.observation_digest <> computed_observation_digest
    OR existing.current_digest <> computed_current_digest
    OR existing.provenance_digest <> computed_provenance_digest THEN
    RAISE EXCEPTION 'G20207_STAGING_CURRENT_CONFLICT' USING ERRCODE = '23505';
  END IF;

  RETURN QUERY SELECT snapshot.row_count, actual_current_rows, actual_rejected_rows,
    computed_reason_counts, computed_observation_digest,
    computed_current_digest, computed_provenance_digest;
END
$prepare_materialization_staging_current$;

CREATE FUNCTION ops.list_materialization_quality_observations(
  p_project_id uuid,
  p_generation_id uuid,
  p_after_file_id uuid,
  p_after_row_number bigint,
  p_after_reason_code text,
  p_after_fingerprint text,
  p_limit integer
) RETURNS TABLE (
  file_id uuid,
  row_number bigint,
  reason_code text,
  fingerprint text,
  column_classification text,
  phase text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $list_materialization_quality_observations$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1001
    OR ((p_after_file_id IS NULL) <> (p_after_row_number IS NULL))
    OR ((p_after_file_id IS NULL) <> (p_after_reason_code IS NULL))
    OR ((p_after_file_id IS NULL) <> (p_after_fingerprint IS NULL)) THEN
    RAISE EXCEPTION 'G20207_QUALITY_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT observation.file_id, observation.row_number, observation.reason_code,
         observation.fingerprint::text,
         observation.column_classification, observation.phase
  FROM ops.materialization_quality_observations AS observation
  WHERE observation.project_id = p_project_id
    AND observation.generation_id = p_generation_id
    AND (p_after_file_id IS NULL OR (
      observation.file_id, observation.row_number,
      observation.reason_code, observation.fingerprint
    ) > (
      p_after_file_id, p_after_row_number,
      p_after_reason_code, p_after_fingerprint
    ))
  ORDER BY observation.file_id, observation.row_number,
           observation.reason_code COLLATE "C", observation.fingerprint COLLATE "C"
  LIMIT p_limit;
END
$list_materialization_quality_observations$;

CREATE FUNCTION ontos_migration.g20207_report_digest(
  p_report_id uuid,
  p_project_id uuid,
  p_snapshot_group_id uuid,
  p_job_id uuid,
  p_outcome text,
  p_total_rows bigint,
  p_accepted_rows bigint,
  p_rejected_rows bigint,
  p_reason_counts jsonb,
  p_error_samples jsonb,
  p_validator_version text
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $g20207_report_digest$
  SELECT 'sha256:' || encode(sha256(convert_to(
    '{"acceptedRows":' || p_accepted_rows::text ||
    ',"contractVersion":"materialization-report-v1"' ||
    ',"errorSamples":[' || COALESCE((
      SELECT string_agg(
        '{"code":' || to_json(sample.value ->> 'code')::text ||
        ',"fileId":' || to_json(sample.value ->> 'fileId')::text ||
        ',"fingerprint":' || to_json(sample.value ->> 'fingerprint')::text ||
        ',"rowNumber":' || (sample.value ->> 'rowNumber') || '}',
        ',' ORDER BY sample.ordinality
      ) FROM jsonb_array_elements(p_error_samples) WITH ORDINALITY AS sample(value, ordinality)
    ), '') || ']' ||
    ',"jobId":' || to_json(p_job_id::text)::text ||
    ',"outcome":' || to_json(p_outcome)::text ||
    ',"projectId":' || to_json(p_project_id::text)::text ||
    ',"reasonCounts":[' || COALESCE((
      SELECT string_agg(
        '{"code":' || to_json(reason.value ->> 'code')::text ||
        ',"count":' || (reason.value ->> 'count') || '}',
        ',' ORDER BY reason.ordinality
      ) FROM jsonb_array_elements(p_reason_counts) WITH ORDINALITY AS reason(value, ordinality)
    ), '') || ']' ||
    ',"rejectedRows":' || p_rejected_rows::text ||
    ',"reportId":' || to_json(p_report_id::text)::text ||
    ',"schemaVersion":1' ||
    ',"snapshotGroupId":' || to_json(p_snapshot_group_id::text)::text ||
    ',"totalRows":' || p_total_rows::text ||
    ',"validatorVersion":' || to_json(p_validator_version)::text || '}',
    'UTF8'
  )), 'hex')
$g20207_report_digest$;

CREATE FUNCTION ops.finalize_materialization_quality(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_generation_id uuid,
  p_expected_observation_digest text,
  p_expected_current_digest text,
  p_expected_provenance_digest text,
  p_report jsonb,
  p_rejected_artifact jsonb,
  p_generation_digest text,
  p_quality_binding_digest text
) RETURNS TABLE (
  project_id uuid,
  generation_id uuid,
  outcome text,
  report_id uuid,
  report_digest text,
  generation_digest text,
  quality_binding_digest text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $finalize_materialization_quality$
DECLARE
  generation runtime.generations%ROWTYPE;
  preparation ops.materialization_quality_preparations%ROWTYPE;
  snapshot runtime.dataset_snapshots%ROWTYPE;
  mapping_content jsonb;
  existing runtime.materialization_quality_bindings%ROWTYPE;
  computed_reasons jsonb;
  expected_reasons jsonb;
  computed_samples jsonb;
  expected_outcome text;
  computed_report_digest text;
  report_identifier uuid;
  report_digest_value text;
  report_created_at timestamptz;
  optional_property_count bigint := 0;
  optional_link_count bigint := 0;
  fatal_count bigint := 0;
  previous_accepted_rows bigint;
  row_count_confirmation boolean := false;
  artifact_identifier uuid;
  rejected_set_identifier uuid;
BEGIN
  IF p_report IS NULL OR jsonb_typeof(p_report) <> 'object'
    OR (p_rejected_artifact IS NOT NULL AND jsonb_typeof(p_rejected_artifact) <> 'object')
    OR p_expected_observation_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_expected_current_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_expected_provenance_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_generation_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_quality_binding_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'G20207_QUALITY_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT binding.* INTO existing
  FROM runtime.materialization_quality_bindings AS binding
  WHERE binding.project_id = p_project_id
    AND binding.generation_id = p_generation_id;
  IF FOUND THEN
    SELECT candidate.* INTO generation
    FROM runtime.generations AS candidate
    WHERE candidate.project_id = p_project_id
      AND candidate.generation_id = p_generation_id;
    IF existing.observation_digest <> p_expected_observation_digest
      OR existing.current_digest <> p_expected_current_digest
      OR existing.provenance_digest <> p_expected_provenance_digest
      OR existing.quality_binding_digest <> p_quality_binding_digest
      OR generation.generation_digest <> p_generation_digest
      OR existing.report_digest <> p_report ->> 'reportDigest' THEN
      RAISE EXCEPTION 'G20207_STAGING_CURRENT_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.project_id, existing.generation_id,
      CASE WHEN existing.state = 'confirmed' THEN 'passed' ELSE existing.state END,
      existing.report_id, existing.report_digest::text,
      generation.generation_digest::text, existing.quality_binding_digest::text;
    RETURN;
  END IF;

  PERFORM ontos_migration.g20207_assert_live_quality(
    p_project_id, p_job_id, p_attempt_id, p_fencing_token, p_generation_id
  );
  SELECT candidate.* INTO generation
  FROM runtime.generations AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.generation_id = p_generation_id
  FOR UPDATE;
  SELECT staged.* INTO preparation
  FROM ops.materialization_quality_preparations AS staged
  WHERE staged.project_id = p_project_id
    AND staged.generation_id = p_generation_id;
  SELECT source.* INTO snapshot
  FROM runtime.dataset_snapshots AS source
  WHERE source.project_id = p_project_id
    AND source.snapshot_id = generation.snapshot_id;
  SELECT mapping.content INTO mapping_content
  FROM meta.resource_revisions AS mapping
  WHERE mapping.revision_id = generation.mapping_revision_id
    AND mapping.resource_id = generation.mapping_resource_id
    AND mapping.family = 'mapping' AND mapping.state = 'published';
  IF preparation.generation_id IS NULL OR snapshot.snapshot_id IS NULL OR NOT FOUND
    OR preparation.observation_digest <> p_expected_observation_digest
    OR preparation.current_digest <> p_expected_current_digest
    OR preparation.provenance_digest <> p_expected_provenance_digest
    OR ontos_migration.g20207_observation_digest(p_project_id, p_generation_id)
      <> p_expected_observation_digest
    OR ontos_migration.g20207_current_digest(
      p_project_id, p_generation_id, generation.member_kind
    ) <> p_expected_current_digest
    OR ontos_migration.g20207_provenance_digest(p_project_id, p_generation_id)
      <> p_expected_provenance_digest THEN
    RAISE EXCEPTION 'G20207_STAGING_CURRENT_CONFLICT' USING ERRCODE = '23505';
  END IF;

  SELECT COALESCE(sum(reason_count) FILTER (WHERE reason_code IN (
           'PRIMARY_KEY_NULL', 'PRIMARY_KEY_DUPLICATE',
           'REQUIRED_PROPERTY_INVALID', 'REQUIRED_LINK_DANGLING'
         )), 0),
         COALESCE(sum(reason_count) FILTER (
           WHERE reason_code = 'OPTIONAL_PROPERTY_INVALID'
         ), 0),
         COALESCE(sum(reason_count) FILTER (
           WHERE reason_code = 'OPTIONAL_LINK_DANGLING'
         ), 0),
         COALESCE(jsonb_agg(jsonb_build_object(
           'code', reason_code, 'count', reason_count
         ) ORDER BY reason_code COLLATE "C"), '[]'::jsonb)
  INTO fatal_count, optional_property_count, optional_link_count, computed_reasons
  FROM (
    SELECT observation.reason_code, count(*) AS reason_count
    FROM ops.materialization_quality_observations AS observation
    WHERE observation.project_id = p_project_id
      AND observation.generation_id = p_generation_id
    GROUP BY observation.reason_code
  ) AS reason;

  IF fatal_count > 0
    OR optional_property_count * 10000 > preparation.total_rows *
      (mapping_content #>> '{qualityRules,optionalPropertyFailureMaximumBasisPoints}')::bigint
    OR optional_link_count * 10000 > preparation.total_rows *
      (mapping_content #>> '{qualityRules,optionalLinkDanglingMaximumBasisPoints}')::bigint THEN
    expected_outcome := 'failed';
  ELSE
    SELECT report.accepted_rows INTO previous_accepted_rows
    FROM runtime.dataset_snapshots AS old_snapshot
    JOIN runtime.generations AS old_generation
      ON old_generation.project_id = old_snapshot.project_id
     AND old_generation.snapshot_id = old_snapshot.snapshot_id
     AND old_generation.member_key = old_snapshot.member_key
    JOIN runtime.materialization_quality_bindings AS old_binding
      ON old_binding.project_id = old_generation.project_id
     AND old_binding.generation_id = old_generation.generation_id
     AND old_binding.state IN ('passed', 'confirmed')
    JOIN runtime.materialization_reports AS report
      ON report.project_id = old_binding.project_id
     AND report.report_id = old_binding.report_id
    WHERE old_snapshot.project_id = generation.project_id
      AND old_snapshot.snapshot_group_id = generation.snapshot_group_id
      AND old_snapshot.member_key = generation.member_key
      AND old_snapshot.group_version < generation.group_version
    ORDER BY old_snapshot.group_version DESC
    LIMIT 1;
    IF FOUND THEN
      row_count_confirmation := CASE
        WHEN previous_accepted_rows = 0 THEN preparation.accepted_rows <> 0
        ELSE abs(preparation.accepted_rows - previous_accepted_rows) * 10000 >
          previous_accepted_rows *
          (mapping_content #>> '{qualityRules,rowCountChangeConfirmationBasisPoints}')::bigint
      END;
    END IF;
    expected_outcome := CASE WHEN row_count_confirmation
      THEN 'awaiting_confirmation' ELSE 'passed' END;
  END IF;
  expected_reasons := computed_reasons;
  IF expected_outcome = 'awaiting_confirmation' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY item ->> 'code'), '[]'::jsonb)
    INTO expected_reasons
    FROM (
      SELECT value AS item FROM jsonb_array_elements(computed_reasons)
      UNION ALL
      SELECT jsonb_build_object('code', 'ROW_COUNT_CONFIRMATION_REQUIRED', 'count', 1)
    ) AS combined;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'code', sample.reason_code,
    'fileId', sample.file_id::text,
    'rowNumber', sample.row_number,
    'fingerprint', sample.fingerprint
  ) ORDER BY sample.file_id, sample.row_number,
    sample.reason_code COLLATE "C", sample.fingerprint COLLATE "C"), '[]'::jsonb)
  INTO computed_samples
  FROM (
    SELECT observation.*
    FROM ops.materialization_quality_observations AS observation
    WHERE observation.project_id = p_project_id
      AND observation.generation_id = p_generation_id
    ORDER BY observation.file_id, observation.row_number,
      observation.reason_code COLLATE "C", observation.fingerprint COLLATE "C"
    LIMIT 50
  ) AS sample;

  BEGIN
    report_identifier := (p_report ->> 'reportId')::uuid;
    report_digest_value := p_report ->> 'reportDigest';
    report_created_at := (p_report ->> 'createdAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'G20207_QUALITY_REQUEST_INVALID' USING ERRCODE = '22023';
  END;
  IF p_report ->> 'contractVersion' <> 'materialization-report-v1'
    OR p_report ->> 'validatorVersion' <> 'materialization-quality-v1'
    OR p_report ->> 'projectId' <> p_project_id::text
    OR p_report ->> 'snapshotGroupId' <> generation.snapshot_group_id::text
    OR p_report ->> 'jobId' <> p_job_id::text
    OR p_report ->> 'outcome' <> expected_outcome
    OR (p_report ->> 'totalRows')::bigint <> preparation.total_rows
    OR (p_report ->> 'acceptedRows')::bigint <> preparation.accepted_rows
    OR (p_report ->> 'rejectedRows')::bigint <> preparation.rejected_rows
    OR p_report -> 'reasonCounts' IS DISTINCT FROM expected_reasons
    OR p_report -> 'errorSamples' IS DISTINCT FROM computed_samples
    OR report_digest_value !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'G20207_MATERIALIZATION_REPORT_INVALID' USING ERRCODE = '23514';
  END IF;
  computed_report_digest := ontos_migration.g20207_report_digest(
    report_identifier, p_project_id, generation.snapshot_group_id, p_job_id,
    expected_outcome, preparation.total_rows, preparation.accepted_rows,
    preparation.rejected_rows, expected_reasons, computed_samples,
    'materialization-quality-v1'
  );
  IF computed_report_digest <> report_digest_value THEN
    RAISE EXCEPTION 'G20207_MATERIALIZATION_REPORT_INVALID' USING ERRCODE = '23514';
  END IF;

  IF preparation.rejected_rows = 0 THEN
    IF p_rejected_artifact IS NOT NULL THEN
      RAISE EXCEPTION 'G20207_REJECTED_ARTIFACT_INVALID' USING ERRCODE = '23514';
    END IF;
  ELSE
    BEGIN
      rejected_set_identifier := (p_rejected_artifact ->> 'rejectedRowSetId')::uuid;
      artifact_identifier := (p_rejected_artifact ->> 'managedArtifactId')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'G20207_REJECTED_ARTIFACT_INVALID' USING ERRCODE = '23514';
    END;
    IF p_rejected_artifact IS NULL
      OR p_rejected_artifact ->> 'contentDigest' <> preparation.observation_digest
      OR (p_rejected_artifact ->> 'rejectedRowCount')::bigint <> preparation.rejected_rows
      OR (p_rejected_artifact ->> 'byteCount')::bigint NOT BETWEEN 1 AND 268435456
      OR p_rejected_artifact ->> 'mediaType'
        <> 'application/vnd.ontos.rejected-rows+json'
      OR p_rejected_artifact ->> 'objectVersion' IS NULL
      OR octet_length(p_rejected_artifact ->> 'objectVersion') NOT BETWEEN 1 AND 1024
      OR p_rejected_artifact ->> 'objectKey'
        !~ '^rejected/[0-9a-f]{2}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]jsonl$' THEN
      RAISE EXCEPTION 'G20207_REJECTED_ARTIFACT_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO runtime.materialization_reports (
    project_id, report_id, snapshot_group_id, group_version, job_id, outcome,
    total_rows, accepted_rows, rejected_rows, validator_version,
    report_digest, created_at
  ) VALUES (
    p_project_id, report_identifier, generation.snapshot_group_id,
    generation.group_version, p_job_id, expected_outcome,
    preparation.total_rows, preparation.accepted_rows, preparation.rejected_rows,
    'materialization-quality-v1', report_digest_value, report_created_at
  );
  INSERT INTO runtime.materialization_report_reasons (
    project_id, report_id, reason_code, reason_count
  )
  SELECT p_project_id, report_identifier, reason.value ->> 'code',
         (reason.value ->> 'count')::bigint
  FROM jsonb_array_elements(expected_reasons) AS reason(value);
  INSERT INTO ops.materialization_error_samples (
    project_id, error_sample_id, report_id, ordinal,
    reason_code, file_id, row_number, fingerprint
  )
  SELECT p_project_id, gen_random_uuid(), report_identifier,
         (sample.ordinality - 1)::integer, sample.value ->> 'code',
         (sample.value ->> 'fileId')::uuid,
         (sample.value ->> 'rowNumber')::bigint,
         sample.value ->> 'fingerprint'
  FROM jsonb_array_elements(computed_samples) WITH ORDINALITY AS sample(value, ordinality);
  IF preparation.rejected_rows > 0 THEN
    INSERT INTO runtime.rejected_row_sets (
      project_id, rejected_row_set_id, report_id, managed_artifact_id,
      content_digest, rejected_row_count, media_type,
      object_key, object_version, byte_count, orphaned
    ) VALUES (
      p_project_id, rejected_set_identifier, report_identifier, artifact_identifier,
      preparation.observation_digest, preparation.rejected_rows,
      'application/vnd.ontos.rejected-rows+json',
      p_rejected_artifact ->> 'objectKey', p_rejected_artifact ->> 'objectVersion',
      (p_rejected_artifact ->> 'byteCount')::bigint, false
    );
  END IF;

  INSERT INTO runtime.materialization_quality_bindings (
    project_id, generation_id, report_id, report_digest,
    snapshot_digest, mapping_revision_digest, observation_digest,
    current_digest, provenance_digest, zero_overlay_row_count,
    state, quality_binding_digest
  )
  SELECT p_project_id, p_generation_id, report_identifier, report_digest_value,
         snapshot.snapshot_digest, mapping.content_digest,
         preparation.observation_digest, preparation.current_digest,
         preparation.provenance_digest, 0, expected_outcome,
         p_quality_binding_digest
  FROM meta.resource_revisions AS mapping
  WHERE mapping.revision_id = generation.mapping_revision_id
    AND mapping.resource_id = generation.mapping_resource_id;
  UPDATE runtime.generations AS candidate
  SET report_id = report_identifier, report_digest = report_digest_value,
      generation_digest = p_generation_digest,
      state = CASE WHEN expected_outcome = 'failed' THEN 'failed' ELSE state END,
      changed_at = clock_timestamp()
  WHERE candidate.project_id = p_project_id
    AND candidate.generation_id = p_generation_id;

  RETURN QUERY SELECT p_project_id, p_generation_id, expected_outcome,
    report_identifier, report_digest_value, p_generation_digest,
    p_quality_binding_digest;
END
$finalize_materialization_quality$;

CREATE FUNCTION runtime.get_row_count_confirmation_scope(
  p_project_id uuid,
  p_generation_id uuid
) RETURNS TABLE (
  project_id uuid,
  generation_id uuid,
  snapshot_digest text,
  report_id uuid,
  report_digest text,
  observed_rows bigint,
  baseline_rows bigint,
  threshold_basis_points integer,
  publication_control_sequence bigint,
  state text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $get_row_count_confirmation_scope$
BEGIN
  RETURN QUERY
  SELECT generation.project_id, generation.generation_id,
         snapshot.snapshot_digest::text, report.report_id, report.report_digest::text,
         report.accepted_rows, prior.accepted_rows,
         (mapping.content #>> '{qualityRules,rowCountChangeConfirmationBasisPoints}')::integer,
         project.publication_sequence, 'awaiting_confirmation'::text
  FROM runtime.generations AS generation
  JOIN runtime.dataset_snapshots AS snapshot
    ON snapshot.project_id = generation.project_id
   AND snapshot.snapshot_id = generation.snapshot_id
  JOIN runtime.materialization_quality_bindings AS binding
    ON binding.project_id = generation.project_id
   AND binding.generation_id = generation.generation_id
   AND binding.state = 'awaiting_confirmation'
  JOIN runtime.materialization_reports AS report
    ON report.project_id = binding.project_id
   AND report.report_id = binding.report_id
   AND report.outcome = 'awaiting_confirmation'
  JOIN meta.resource_revisions AS mapping
    ON mapping.revision_id = generation.mapping_revision_id
   AND mapping.resource_id = generation.mapping_resource_id
  JOIN meta.projects AS project ON project.project_id = generation.project_id
  JOIN LATERAL (
    SELECT old_report.accepted_rows
    FROM runtime.dataset_snapshots AS old_snapshot
    JOIN runtime.generations AS old_generation
      ON old_generation.project_id = old_snapshot.project_id
     AND old_generation.snapshot_id = old_snapshot.snapshot_id
     AND old_generation.member_key = old_snapshot.member_key
    JOIN runtime.materialization_quality_bindings AS old_binding
      ON old_binding.project_id = old_generation.project_id
     AND old_binding.generation_id = old_generation.generation_id
     AND old_binding.state IN ('passed', 'confirmed')
    JOIN runtime.materialization_reports AS old_report
      ON old_report.project_id = old_binding.project_id
     AND old_report.report_id = old_binding.report_id
    WHERE old_snapshot.project_id = generation.project_id
      AND old_snapshot.snapshot_group_id = generation.snapshot_group_id
      AND old_snapshot.member_key = generation.member_key
      AND old_snapshot.group_version < generation.group_version
    ORDER BY old_snapshot.group_version DESC
    LIMIT 1
  ) AS prior ON true
  WHERE generation.project_id = p_project_id
    AND generation.generation_id = p_generation_id
    AND generation.state = 'building';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20207_CONFIRMATION_INVALID' USING ERRCODE = '55000';
  END IF;
END
$get_row_count_confirmation_scope$;

CREATE FUNCTION ontos_migration.g20207_enforce_quality_binding_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20207_enforce_quality_binding_update$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
    OR NEW.report_id IS DISTINCT FROM OLD.report_id
    OR NEW.report_digest IS DISTINCT FROM OLD.report_digest
    OR NEW.snapshot_digest IS DISTINCT FROM OLD.snapshot_digest
    OR NEW.mapping_revision_digest IS DISTINCT FROM OLD.mapping_revision_digest
    OR NEW.observation_digest IS DISTINCT FROM OLD.observation_digest
    OR NEW.current_digest IS DISTINCT FROM OLD.current_digest
    OR NEW.provenance_digest IS DISTINCT FROM OLD.provenance_digest
    OR NEW.zero_overlay_row_count IS DISTINCT FROM OLD.zero_overlay_row_count
    OR NEW.quality_binding_digest IS DISTINCT FROM OLD.quality_binding_digest
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.changed_at < OLD.changed_at
    OR NOT (OLD.state = 'awaiting_confirmation' AND NEW.state IN ('confirmed', 'failed')) THEN
    RAISE EXCEPTION 'G20207_QUALITY_BINDING_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20207_enforce_quality_binding_update$;

CREATE FUNCTION runtime.confirm_materialization_row_count(
  p_project_id uuid,
  p_generation_id uuid,
  p_confirmation_id uuid,
  p_actor_principal_id uuid,
  p_snapshot_digest text,
  p_report_id uuid,
  p_report_digest text,
  p_observed_rows bigint,
  p_baseline_rows bigint,
  p_threshold_basis_points integer,
  p_publication_control_sequence bigint,
  p_decision text,
  p_expires_at timestamptz,
  p_confirmation_digest text
) RETURNS TABLE (
  project_id uuid,
  generation_id uuid,
  outcome text,
  report_id uuid,
  report_digest text,
  generation_digest text,
  quality_binding_digest text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $confirm_materialization_row_count$
DECLARE
  scope_record record;
  binding runtime.materialization_quality_bindings%ROWTYPE;
  generation runtime.generations%ROWTYPE;
  existing runtime.materialization_confirmations%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('accepted', 'rejected')
    OR p_observed_rows < 0 OR p_baseline_rows < 0
    OR p_threshold_basis_points NOT BETWEEN 0 AND 10000
    OR p_publication_control_sequence < 0
    OR p_snapshot_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_report_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_confirmation_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_expires_at <= clock_timestamp()
    OR p_expires_at > clock_timestamp() + interval '1 hour' THEN
    RAISE EXCEPTION 'G20207_CONFIRMATION_INVALID' USING ERRCODE = '55000';
  END IF;
  -- Serialize confirmation with Release publish/refresh, which advances this
  -- same Project row.  Reading the scope before taking this lock would allow
  -- an old publication sequence to be accepted during a concurrent commit.
  PERFORM 1
  FROM meta.projects AS project
  WHERE project.project_id = p_project_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20207_CONFIRMATION_INVALID' USING ERRCODE = '55000';
  END IF;
  SELECT confirmation.* INTO existing
  FROM runtime.materialization_confirmations AS confirmation
  WHERE confirmation.project_id = p_project_id
    AND confirmation.confirmation_id = p_confirmation_id;
  IF FOUND THEN
    IF existing.confirmation_digest <> p_confirmation_digest
      OR existing.generation_id <> p_generation_id
      OR existing.actor_principal_id <> p_actor_principal_id
      OR existing.snapshot_digest <> p_snapshot_digest
      OR existing.report_id <> p_report_id
      OR existing.report_digest <> p_report_digest
      OR existing.observed_rows <> p_observed_rows
      OR existing.baseline_rows <> p_baseline_rows
      OR existing.threshold_basis_points <> p_threshold_basis_points
      OR existing.publication_control_sequence <> p_publication_control_sequence
      OR existing.decision <> p_decision
      OR existing.expires_at <> p_expires_at THEN
      RAISE EXCEPTION 'G20207_CONFIRMATION_INVALID' USING ERRCODE = '55000';
    END IF;
    SELECT quality.* INTO binding
    FROM runtime.materialization_quality_bindings AS quality
    WHERE quality.project_id = p_project_id
      AND quality.generation_id = p_generation_id;
    SELECT candidate.* INTO generation
    FROM runtime.generations AS candidate
    WHERE candidate.project_id = p_project_id
      AND candidate.generation_id = p_generation_id;
    RETURN QUERY SELECT p_project_id, p_generation_id,
      CASE WHEN binding.state = 'confirmed' THEN 'passed' ELSE 'failed' END,
      binding.report_id, binding.report_digest::text, generation.generation_digest::text,
      binding.quality_binding_digest::text;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM authz.principals AS principal
    JOIN authz.role_bindings AS role
      ON role.principal_id = principal.principal_id
     AND role.project_id = p_project_id
     AND role.scope = 'project' AND role.resource_id IS NULL
     AND role.role = 'owner' AND role.state = 'active'
    WHERE principal.principal_id = p_actor_principal_id
      AND principal.state = 'active'
  ) THEN
    RAISE EXCEPTION 'G20207_CONFIRMATION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO scope_record
  FROM runtime.get_row_count_confirmation_scope(p_project_id, p_generation_id);
  IF NOT FOUND
    OR scope_record.snapshot_digest <> p_snapshot_digest
    OR scope_record.report_id <> p_report_id
    OR scope_record.report_digest <> p_report_digest
    OR scope_record.observed_rows <> p_observed_rows
    OR scope_record.baseline_rows <> p_baseline_rows
    OR scope_record.threshold_basis_points <> p_threshold_basis_points
    OR scope_record.publication_control_sequence <> p_publication_control_sequence THEN
    RAISE EXCEPTION 'G20207_CONFIRMATION_INVALID' USING ERRCODE = '55000';
  END IF;
  SELECT quality.* INTO binding
  FROM runtime.materialization_quality_bindings AS quality
  WHERE quality.project_id = p_project_id
    AND quality.generation_id = p_generation_id
  FOR UPDATE;
  SELECT candidate.* INTO generation
  FROM runtime.generations AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.generation_id = p_generation_id
  FOR UPDATE;

  INSERT INTO runtime.materialization_confirmations (
    project_id, confirmation_id, generation_id, actor_principal_id,
    snapshot_digest, report_id, report_digest, observed_rows, baseline_rows,
    threshold_basis_points, publication_control_sequence,
    decision, expires_at, confirmation_digest
  ) VALUES (
    p_project_id, p_confirmation_id, p_generation_id, p_actor_principal_id,
    p_snapshot_digest, p_report_id, p_report_digest, p_observed_rows, p_baseline_rows,
    p_threshold_basis_points, p_publication_control_sequence,
    p_decision, p_expires_at, p_confirmation_digest
  );
  UPDATE runtime.materialization_quality_bindings AS quality
  SET state = CASE WHEN p_decision = 'accepted' THEN 'confirmed' ELSE 'failed' END,
      changed_at = clock_timestamp()
  WHERE quality.project_id = p_project_id
    AND quality.generation_id = p_generation_id;
  IF p_decision = 'rejected' THEN
    UPDATE runtime.generations AS candidate
    SET state = 'failed', changed_at = clock_timestamp()
    WHERE candidate.project_id = p_project_id
      AND candidate.generation_id = p_generation_id;
  END IF;
  SELECT quality.* INTO binding
  FROM runtime.materialization_quality_bindings AS quality
  WHERE quality.project_id = p_project_id
    AND quality.generation_id = p_generation_id;
  RETURN QUERY SELECT p_project_id, p_generation_id,
    CASE WHEN binding.state = 'confirmed' THEN 'passed' ELSE 'failed' END,
    binding.report_id, binding.report_digest::text, generation.generation_digest::text,
    binding.quality_binding_digest::text;
END
$confirm_materialization_row_count$;

CREATE FUNCTION runtime.read_object_current_candidate(
  p_project_id uuid,
  p_generation_id uuid,
  p_object_type_resource_id uuid,
  p_object_type_revision_id uuid,
  p_after_object_rid uuid,
  p_limit integer
) RETURNS TABLE (
  object_rid uuid,
  canonical_primary_key text,
  properties jsonb,
  base_value_digest text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $read_object_current_candidate$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1000 OR NOT EXISTS (
    SELECT 1 FROM runtime.generations AS generation
    JOIN runtime.materialization_quality_bindings AS quality
      ON quality.project_id = generation.project_id
     AND quality.generation_id = generation.generation_id
     AND quality.state IN ('passed', 'confirmed')
    WHERE generation.project_id = p_project_id
      AND generation.generation_id = p_generation_id
      AND generation.target_resource_id = p_object_type_resource_id
      AND generation.target_revision_id = p_object_type_revision_id
      AND generation.member_kind = 'object'
      AND generation.state = 'building'
  ) THEN
    RAISE EXCEPTION 'G20207_CANDIDATE_NOT_ACCESSIBLE' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT current.object_rid, current.canonical_primary_key::text,
    current.properties, current.base_value_digest::text
  FROM runtime.object_current AS current
  WHERE current.project_id = p_project_id
    AND current.generation_id = p_generation_id
    AND current.object_type_resource_id = p_object_type_resource_id
    AND current.object_type_revision_id = p_object_type_revision_id
    AND (p_after_object_rid IS NULL OR current.object_rid > p_after_object_rid)
  ORDER BY current.object_rid
  LIMIT p_limit;
END
$read_object_current_candidate$;

CREATE FUNCTION runtime.read_link_current_candidate(
  p_project_id uuid,
  p_generation_id uuid,
  p_link_type_resource_id uuid,
  p_link_type_revision_id uuid,
  p_after_link_rid uuid,
  p_limit integer
) RETURNS TABLE (
  link_rid uuid,
  source_object_type_resource_id uuid,
  source_object_rid uuid,
  target_object_type_resource_id uuid,
  target_object_rid uuid,
  base_value_digest text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $read_link_current_candidate$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1000 OR NOT EXISTS (
    SELECT 1 FROM runtime.generations AS generation
    JOIN runtime.materialization_quality_bindings AS quality
      ON quality.project_id = generation.project_id
     AND quality.generation_id = generation.generation_id
     AND quality.state IN ('passed', 'confirmed')
    WHERE generation.project_id = p_project_id
      AND generation.generation_id = p_generation_id
      AND generation.target_resource_id = p_link_type_resource_id
      AND generation.target_revision_id = p_link_type_revision_id
      AND generation.member_kind = 'link'
      AND generation.state = 'building'
  ) THEN
    RAISE EXCEPTION 'G20207_CANDIDATE_NOT_ACCESSIBLE' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT current.link_rid,
    current.source_object_type_resource_id, current.source_object_rid,
    current.target_object_type_resource_id, current.target_object_rid,
    current.base_value_digest::text
  FROM runtime.link_current AS current
  WHERE current.project_id = p_project_id
    AND current.generation_id = p_generation_id
    AND current.link_type_resource_id = p_link_type_resource_id
    AND current.link_type_revision_id = p_link_type_revision_id
    AND (p_after_link_rid IS NULL OR current.link_rid > p_after_link_rid)
  ORDER BY current.link_rid
  LIMIT p_limit;
END
$read_link_current_candidate$;

CREATE TRIGGER object_head_candidates_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.object_head_candidates
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER materialization_quality_bindings_controlled_update
BEFORE UPDATE ON runtime.materialization_quality_bindings
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20207_enforce_quality_binding_update();
CREATE TRIGGER materialization_quality_bindings_no_delete
BEFORE DELETE OR TRUNCATE ON runtime.materialization_quality_bindings
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER materialization_confirmations_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.materialization_confirmations
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER materialization_quality_observations_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.materialization_quality_observations
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER materialization_provenance_templates_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.materialization_provenance_templates
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER materialization_quality_preparations_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.materialization_quality_preparations
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();

REVOKE ALL PRIVILEGES ON TABLE
  runtime.object_head_candidates,
  runtime.materialization_quality_bindings,
  runtime.materialization_confirmations,
  ops.materialization_quality_observations,
  ops.materialization_provenance_templates,
  ops.materialization_quality_preparations
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

REVOKE ALL PRIVILEGES ON FUNCTION
  ontos_migration.g20207_assert_live_quality(uuid, uuid, uuid, bigint, uuid),
  ontos_migration.g20207_observation_line(uuid, bigint, text, text, text),
  ontos_migration.g20207_observation_digest(uuid, uuid),
  ontos_migration.g20207_current_digest(uuid, uuid, text),
  ontos_migration.g20207_provenance_digest(uuid, uuid),
  ontos_migration.g20207_report_digest(
    uuid, uuid, uuid, uuid, text, bigint, bigint, bigint, jsonb, jsonb, text
  ),
  ontos_migration.g20207_enforce_quality_binding_update(),
  ops.get_materialization_quality_scope(uuid, uuid, uuid, bigint, uuid),
  ops.stage_materialization_quality_observations(uuid, uuid, uuid, bigint, uuid, jsonb),
  ops.prepare_materialization_staging_current(uuid, uuid, uuid, bigint, uuid, jsonb),
  ops.list_materialization_quality_observations(
    uuid, uuid, uuid, bigint, text, text, integer
  ),
  ops.finalize_materialization_quality(
    uuid, uuid, uuid, bigint, uuid, text, text, text, jsonb, jsonb, text, text
  ),
  runtime.get_row_count_confirmation_scope(uuid, uuid),
  runtime.confirm_materialization_row_count(
    uuid, uuid, uuid, uuid, text, uuid, text, bigint, bigint, integer,
    bigint, text, timestamptz, text
  ),
  runtime.read_object_current_candidate(uuid, uuid, uuid, uuid, uuid, integer),
  runtime.read_link_current_candidate(uuid, uuid, uuid, uuid, uuid, integer)
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT SELECT ON TABLE
  runtime.materialization_quality_bindings,
  runtime.object_head_candidates
TO worker_runtime;

GRANT EXECUTE ON FUNCTION
  ops.get_materialization_quality_scope(uuid, uuid, uuid, bigint, uuid),
  ops.stage_materialization_quality_observations(uuid, uuid, uuid, bigint, uuid, jsonb),
  ops.prepare_materialization_staging_current(uuid, uuid, uuid, bigint, uuid, jsonb),
  ops.list_materialization_quality_observations(
    uuid, uuid, uuid, bigint, text, text, integer
  ),
  ops.finalize_materialization_quality(
    uuid, uuid, uuid, bigint, uuid, text, text, text, jsonb, jsonb, text, text
  ),
  runtime.read_object_current_candidate(uuid, uuid, uuid, uuid, uuid, integer),
  runtime.read_link_current_candidate(uuid, uuid, uuid, uuid, uuid, integer)
TO worker_runtime;

GRANT EXECUTE ON FUNCTION
  runtime.get_row_count_confirmation_scope(uuid, uuid),
  runtime.confirm_materialization_row_count(
    uuid, uuid, uuid, uuid, text, uuid, text, bigint, bigint, integer,
    bigint, text, timestamptz, text
  )
TO api_runtime;
