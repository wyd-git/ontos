SET LOCAL ROLE migration_owner;

-- pg_trgm is a trusted PostgreSQL extension. Keeping it in runtime binds the
-- operator class used by the frozen P0 TRIGRAM_GIN recipe to the DB-02 owner.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA runtime;

-- PostgreSQL marks text -> date/timestamptz casts STABLE because they may depend on
-- session GUCs. The public codec emits strict ISO values, so the frozen recipes use
-- owner-defined wrappers with fixed DateStyle/TimeZone and an honest IMMUTABLE contract.
CREATE FUNCTION runtime.ontos_index_date(value text) RETURNS date
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET DateStyle = 'ISO, YMD'
AS $g20209_index_date$ SELECT value::date $g20209_index_date$;

CREATE FUNCTION runtime.ontos_index_timestamp(value text) RETURNS timestamptz
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET TimeZone = 'UTC'
SET DateStyle = 'ISO, YMD'
AS $g20209_index_timestamp$ SELECT value::timestamptz $g20209_index_timestamp$;

ALTER TABLE runtime.object_current
  ADD COLUMN lifecycle_state varchar(16) NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('active', 'inactive'));

DO $g20209_no_legacy_index_entries$
BEGIN
  IF EXISTS (SELECT 1 FROM runtime.index_plan_entries) THEN
    RAISE EXCEPTION 'G20209_LEGACY_INDEX_PLAN_REQUIRES_REBUILD' USING ERRCODE = '55000';
  END IF;
END
$g20209_no_legacy_index_entries$;

ALTER TABLE runtime.index_plan_entries
  ADD COLUMN index_name varchar(63) NOT NULL
    CHECK (index_name ~ '^ok_oc_(bt|uq|trgm|arr)_[0-9a-f]{10}_[0-9a-f]{8}_[0-9a-f]{12}$'),
  ADD COLUMN unit_cost integer NOT NULL CHECK (unit_cost BETWEEN 1 AND 13),
  ADD COLUMN definition jsonb NOT NULL CHECK (
    jsonb_typeof(definition) = 'object'
    AND definition->>'schemaVersion' = '1'
    AND definition->>'table' = 'runtime.object_current'
    AND definition ? 'keys'
    AND jsonb_typeof(definition->'keys') = 'array'
  );

ALTER TABLE runtime.index_plan_entries
  ADD CONSTRAINT index_plan_entries_name_uq UNIQUE (project_id, index_plan_id, index_name);

ALTER TABLE runtime.index_inventory
  DROP CONSTRAINT index_inventory_index_name_check;
ALTER TABLE runtime.index_inventory
  ADD CONSTRAINT index_inventory_index_name_ck CHECK (
    index_name ~ '^ok_oc_(bt|uq|trgm|arr)_[0-9a-f]{10}_[0-9a-f]{8}_[0-9a-f]{12}$'
  ),
  ADD COLUMN observed_bytes bigint CHECK (observed_bytes IS NULL OR observed_bytes >= 0),
  ADD COLUMN last_result_code varchar(128),
  ADD COLUMN catalog_scanned_at timestamptz;

CREATE TABLE runtime.source_forecasts (
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  forecast_id uuid NOT NULL,
  object_row_count bigint NOT NULL CHECK (object_row_count >= 0),
  link_row_count bigint NOT NULL CHECK (link_row_count >= 0),
  source_bytes bigint NOT NULL CHECK (source_bytes >= 0),
  projected_measured_bytes bigint NOT NULL CHECK (projected_measured_bytes >= 0),
  scanner_version varchar(128) NOT NULL CHECK (btrim(scanner_version) <> ''),
  forecast_digest varchar(71) NOT NULL
    CHECK (forecast_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, forecast_id),
  CONSTRAINT source_forecasts_generation_fk FOREIGN KEY (project_id, generation_id)
    REFERENCES runtime.generations(project_id, generation_id) ON DELETE RESTRICT,
  CONSTRAINT source_forecasts_generation_uq UNIQUE (project_id, generation_id),
  CONSTRAINT source_forecasts_digest_uq UNIQUE (project_id, forecast_digest)
);

CREATE TABLE runtime.project_physical_measurements (
  project_id uuid NOT NULL,
  measurement_id uuid NOT NULL,
  inventory_revision bigint NOT NULL CHECK (inventory_revision >= 1),
  heap_bytes bigint NOT NULL CHECK (heap_bytes >= 0),
  index_bytes bigint NOT NULL CHECK (index_bytes >= 0),
  toast_bytes bigint NOT NULL CHECK (toast_bytes >= 0),
  total_relation_bytes bigint NOT NULL CHECK (
    total_relation_bytes >= heap_bytes + index_bytes + toast_bytes
  ),
  relation_count integer NOT NULL CHECK (relation_count >= 1),
  catalog_complete boolean NOT NULL CHECK (catalog_complete),
  scanner_version varchar(128) NOT NULL CHECK (btrim(scanner_version) <> ''),
  measurement_digest varchar(71) NOT NULL
    CHECK (measurement_digest ~ '^sha256:[0-9a-f]{64}$'),
  measured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, measurement_id),
  CONSTRAINT project_physical_measurements_project_fk FOREIGN KEY (project_id)
    REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  CONSTRAINT project_physical_measurements_inventory_fk FOREIGN KEY (project_id)
    REFERENCES runtime.project_runtime_inventories(project_id) ON DELETE RESTRICT,
  CONSTRAINT project_physical_measurements_revision_uq
    UNIQUE (project_id, inventory_revision),
  CONSTRAINT project_physical_measurements_digest_uq
    UNIQUE (project_id, measurement_digest)
);

CREATE TABLE runtime.index_plan_admissions (
  project_id uuid NOT NULL,
  admission_id uuid NOT NULL,
  release_id uuid NOT NULL,
  release_plan_digest varchar(71) NOT NULL
    CHECK (release_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  index_plan_id uuid NOT NULL,
  inventory_revision bigint NOT NULL CHECK (inventory_revision >= 1),
  release_units integer NOT NULL CHECK (release_units BETWEEN 0 AND 104),
  project_union_units integer NOT NULL CHECK (project_union_units BETWEEN 0 AND 240),
  project_physical_index_count integer NOT NULL
    CHECK (project_physical_index_count BETWEEN 0 AND 160),
  admission_mode text NOT NULL CHECK (
    admission_mode IN ('WITHIN_NORMAL', 'NON_EXPANDING_OVERAGE', 'APPROVED_OVERAGE')
  ),
  approval_id uuid,
  report_digest varchar(71) NOT NULL CHECK (report_digest ~ '^sha256:[0-9a-f]{64}$'),
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, admission_id),
  CONSTRAINT index_plan_admissions_plan_fk FOREIGN KEY (project_id, index_plan_id)
    REFERENCES runtime.index_plans(project_id, index_plan_id) ON DELETE RESTRICT,
  CONSTRAINT index_plan_admissions_release_fk FOREIGN KEY (project_id, release_id)
    REFERENCES meta.releases(project_id, release_id) ON DELETE RESTRICT,
  CONSTRAINT index_plan_admissions_inventory_fk FOREIGN KEY (project_id)
    REFERENCES runtime.project_runtime_inventories(project_id) ON DELETE RESTRICT,
  CONSTRAINT index_plan_admissions_plan_revision_uq
    UNIQUE (project_id, release_id, index_plan_id, inventory_revision)
);

CREATE TABLE runtime.capacity_admissions (
  project_id uuid NOT NULL,
  admission_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('PREBUILD', 'POSTBUILD')),
  inventory_revision bigint NOT NULL CHECK (inventory_revision >= 1),
  index_plan_digest varchar(71) NOT NULL
    CHECK (index_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_forecast_digest varchar(71) NOT NULL
    CHECK (source_forecast_digest ~ '^sha256:[0-9a-f]{64}$'),
  physical_measurement_digest varchar(71)
    CHECK (
      (phase = 'PREBUILD' AND physical_measurement_digest IS NULL)
      OR
      (phase = 'POSTBUILD' AND physical_measurement_digest ~ '^sha256:[0-9a-f]{64}$')
    ),
  measured_bytes bigint NOT NULL CHECK (measured_bytes >= 0),
  observed_project_physical_bytes bigint NOT NULL
    CHECK (observed_project_physical_bytes >= 0),
  reserved_bytes bigint NOT NULL CHECK (reserved_bytes >= measured_bytes),
  steady_reserved_bytes bigint NOT NULL CHECK (steady_reserved_bytes >= 0),
  peak_reserved_bytes bigint NOT NULL CHECK (
    peak_reserved_bytes >= steady_reserved_bytes
    AND peak_reserved_bytes = reserved_bytes
  ),
  approval_id uuid,
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  report_digest varchar(71) NOT NULL CHECK (report_digest ~ '^sha256:[0-9a-f]{64}$'),
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, admission_id),
  CONSTRAINT capacity_admissions_generation_fk FOREIGN KEY (project_id, generation_id)
    REFERENCES runtime.generations(project_id, generation_id) ON DELETE RESTRICT,
  CONSTRAINT capacity_admissions_inventory_fk FOREIGN KEY (project_id)
    REFERENCES runtime.project_runtime_inventories(project_id) ON DELETE RESTRICT,
  CONSTRAINT capacity_admissions_phase_uq UNIQUE (project_id, generation_id, phase),
  CONSTRAINT capacity_admissions_digest_uq UNIQUE (project_id, report_digest)
);

CREATE TABLE ops.projection_ddl_requests (
  project_id uuid NOT NULL,
  request_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('CREATE', 'DROP')),
  state text NOT NULL DEFAULT 'APPROVED'
    CHECK (state IN ('APPROVED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  inventory_revision bigint NOT NULL CHECK (inventory_revision >= 1),
  index_plan_id uuid NOT NULL,
  entry_key varchar(128) NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000000),
  last_result_code varchar(128),
  catalog_digest varchar(71)
    CHECK (catalog_digest IS NULL OR catalog_digest ~ '^sha256:[0-9a-f]{64}$'),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, request_id),
  CONSTRAINT projection_ddl_requests_entry_fk FOREIGN KEY (
    project_id, index_plan_id, entry_key
  ) REFERENCES runtime.index_plan_entries(
    project_id, index_plan_id, entry_key
  ) ON DELETE RESTRICT,
  CONSTRAINT projection_ddl_requests_operation_uq UNIQUE (
    project_id, index_plan_id, entry_key, action, inventory_revision
  ),
  CONSTRAINT projection_ddl_requests_timestamps_ck CHECK (
    (state = 'APPROVED' AND started_at IS NULL AND finished_at IS NULL)
    OR (state = 'RUNNING' AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (state IN ('SUCCEEDED', 'FAILED') AND started_at IS NOT NULL AND finished_at IS NOT NULL)
  )
);

CREATE VIEW ops.projection_ddl_request_status AS
SELECT request_id, project_id, action, state, inventory_revision,
       index_plan_id, entry_key, attempt_count, last_result_code,
       catalog_digest, started_at, finished_at, created_at
FROM ops.projection_ddl_requests;

CREATE FUNCTION runtime.record_project_physical_measurement(
  measured_project_id uuid,
  expected_inventory_revision bigint,
  measured_measurement_id uuid,
  measured_heap_bytes bigint,
  measured_index_bytes bigint,
  measured_toast_bytes bigint,
  measured_total_relation_bytes bigint,
  measured_relation_count integer,
  measured_scanner_version varchar(128),
  measured_digest varchar(71)
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $g20209_record_physical_measurement$
DECLARE
  current_revision bigint;
  next_revision bigint;
BEGIN
  IF expected_inventory_revision < 1
    OR measured_heap_bytes < 0
    OR measured_index_bytes < 0
    OR measured_toast_bytes < 0
    OR measured_total_relation_bytes <
       measured_heap_bytes + measured_index_bytes + measured_toast_bytes
    OR measured_relation_count < 1
    OR btrim(measured_scanner_version) = ''
    OR measured_digest !~ '^sha256:[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'CAPACITY_MEASUREMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT inventory_revision INTO current_revision
  FROM runtime.project_runtime_inventories
  WHERE project_id = measured_project_id
  FOR UPDATE;
  IF current_revision IS NULL OR current_revision <> expected_inventory_revision THEN
    RAISE EXCEPTION 'CAPACITY_INVENTORY_STALE' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM runtime.index_inventory AS inventory
    WHERE inventory.project_id = measured_project_id
      AND inventory.state IN ('planned', 'building', 'failed')
  ) THEN
    RAISE EXCEPTION 'INDEX_INVENTORY_INCOMPLETE' USING ERRCODE = '55000';
  END IF;

  next_revision := current_revision + 1;
  INSERT INTO runtime.project_physical_measurements (
    project_id, measurement_id, inventory_revision,
    heap_bytes, index_bytes, toast_bytes, total_relation_bytes,
    relation_count, catalog_complete, scanner_version, measurement_digest
  ) VALUES (
    measured_project_id, measured_measurement_id, next_revision,
    measured_heap_bytes, measured_index_bytes, measured_toast_bytes,
    measured_total_relation_bytes, measured_relation_count, true,
    measured_scanner_version, measured_digest
  );
  UPDATE runtime.project_runtime_inventories
  SET inventory_revision = next_revision,
      measurement_complete = true,
      inventory_digest = measured_digest,
      changed_at = clock_timestamp()
  WHERE project_id = measured_project_id;
  RETURN next_revision;
END
$g20209_record_physical_measurement$;

CREATE FUNCTION ops.request_projection_index_build(
  requested_project_id uuid,
  requested_plan_id uuid,
  requested_entry_key varchar(128),
  requested_request_id uuid
) RETURNS TABLE (request_id uuid, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $g20209_request_index_build$
DECLARE
  current_inventory_revision bigint;
  planned_name varchar(63);
  planned_signature varchar(71);
  existing_name varchar(63);
  existing_signature varchar(71);
BEGIN
  SELECT inventory.inventory_revision
  INTO current_inventory_revision
  FROM runtime.project_runtime_inventories AS inventory
  WHERE inventory.project_id = requested_project_id
    AND inventory.measurement_complete
  FOR UPDATE;
  IF current_inventory_revision IS NULL THEN
    RAISE EXCEPTION 'INDEX_INVENTORY_INCOMPLETE' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM runtime.index_plan_admissions AS admission
    WHERE admission.project_id = requested_project_id
      AND admission.index_plan_id = requested_plan_id
      AND admission.inventory_revision = current_inventory_revision
  ) THEN
    RAISE EXCEPTION 'INDEX_PLAN_NOT_ADMITTED' USING ERRCODE = '55000';
  END IF;

  SELECT entry.index_name, entry.physical_signature
  INTO planned_name, planned_signature
  FROM runtime.index_plan_entries AS entry
  WHERE entry.project_id = requested_project_id
    AND entry.index_plan_id = requested_plan_id
    AND entry.entry_key = requested_entry_key;
  IF planned_name IS NULL THEN
    RAISE EXCEPTION 'INDEX_PLAN_ENTRY_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  SELECT inventory.index_name, inventory.physical_signature
  INTO existing_name, existing_signature
  FROM runtime.index_inventory AS inventory
  WHERE inventory.project_id = requested_project_id
    AND (
      inventory.index_name = planned_name
      OR inventory.physical_signature = planned_signature
    )
  FOR UPDATE;
  IF existing_name IS NOT NULL AND (
    existing_name IS DISTINCT FROM planned_name
    OR existing_signature IS DISTINCT FROM planned_signature
  ) THEN
    RAISE EXCEPTION 'INDEX_NAME_OR_SIGNATURE_COLLISION' USING ERRCODE = '55000';
  END IF;

  IF existing_name IS NULL THEN
    INSERT INTO runtime.index_inventory (
      project_id, index_inventory_id, index_plan_id, entry_key,
      index_name, physical_signature, state, inventory_revision
    ) VALUES (
      requested_project_id, requested_request_id, requested_plan_id, requested_entry_key,
      planned_name, planned_signature, 'planned', current_inventory_revision
    );
  END IF;

  INSERT INTO ops.projection_ddl_requests (
    project_id, request_id, action, inventory_revision, index_plan_id, entry_key
  ) VALUES (
    requested_project_id, requested_request_id, 'CREATE', current_inventory_revision,
    requested_plan_id, requested_entry_key
  )
  ON CONFLICT (project_id, index_plan_id, entry_key, action, inventory_revision)
  DO NOTHING;

  RETURN QUERY
  SELECT request.request_id, request.state
  FROM ops.projection_ddl_requests AS request
  WHERE request.project_id = requested_project_id
    AND request.index_plan_id = requested_plan_id
    AND request.entry_key = requested_entry_key
    AND request.action = 'CREATE'
    AND request.inventory_revision = current_inventory_revision;
END
$g20209_request_index_build$;

CREATE FUNCTION ontos_migration.g20209_enforce_ddl_request_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20209_enforce_ddl_request_update$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.action IS DISTINCT FROM OLD.action
    OR NEW.inventory_revision IS DISTINCT FROM OLD.inventory_revision
    OR NEW.index_plan_id IS DISTINCT FROM OLD.index_plan_id
    OR NEW.entry_key IS DISTINCT FROM OLD.entry_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NOT (
      (OLD.state IN ('APPROVED', 'FAILED', 'RUNNING') AND NEW.state = 'RUNNING')
      OR (OLD.state = 'RUNNING' AND NEW.state IN ('SUCCEEDED', 'FAILED'))
      OR (OLD.state = 'SUCCEEDED' AND NEW.state = 'FAILED')
    )
  THEN
    RAISE EXCEPTION 'G20209_DDL_REQUEST_MUTATION_FORBIDDEN' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20209_enforce_ddl_request_update$;

CREATE OR REPLACE FUNCTION ontos_migration.g20203_enforce_index_inventory_update() RETURNS trigger
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
    OR (OLD.state = 'failed' AND NEW.state = 'building')
    OR (OLD.state = 'ready' AND NEW.state IN ('retired', 'failed'));
  IF NOT allowed OR NEW.inventory_revision < OLD.inventory_revision THEN
    RAISE EXCEPTION 'G20203_INDEX_INVENTORY_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20203_index_inventory_update$;

CREATE TRIGGER source_forecasts_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.source_forecasts
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER project_physical_measurements_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.project_physical_measurements
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER index_plan_admissions_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.index_plan_admissions
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER capacity_admissions_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.capacity_admissions
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER projection_ddl_requests_controlled_update
BEFORE UPDATE ON ops.projection_ddl_requests
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20209_enforce_ddl_request_update();
CREATE TRIGGER projection_ddl_requests_no_delete
BEFORE DELETE OR TRUNCATE ON ops.projection_ddl_requests
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();

REVOKE ALL PRIVILEGES ON TABLE
  runtime.source_forecasts,
  runtime.project_physical_measurements,
  runtime.index_plan_admissions,
  runtime.capacity_admissions,
  ops.projection_ddl_requests,
  ops.projection_ddl_request_status
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON FUNCTION
  ops.request_projection_index_build(uuid, uuid, varchar, uuid),
  runtime.record_project_physical_measurement(
    uuid, bigint, uuid, bigint, bigint, bigint, bigint, integer, varchar, varchar
  )
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON FUNCTION
  runtime.ontos_index_date(text),
  runtime.ontos_index_timestamp(text)
FROM PUBLIC, read_only_ops;

GRANT SELECT ON TABLE
  runtime.source_forecasts,
  runtime.project_physical_measurements,
  runtime.index_plan_admissions,
  runtime.capacity_admissions,
  ops.projection_ddl_request_status
TO api_runtime, worker_runtime;
GRANT SELECT ON TABLE ops.projection_ddl_request_status TO read_only_ops;
GRANT INSERT ON TABLE
  runtime.source_forecasts,
  runtime.capacity_admissions
TO worker_runtime;
GRANT INSERT ON TABLE runtime.index_plan_admissions TO api_runtime;
GRANT EXECUTE ON FUNCTION
  ops.request_projection_index_build(uuid, uuid, varchar, uuid)
TO worker_runtime;
GRANT EXECUTE ON FUNCTION
  runtime.ontos_index_date(text),
  runtime.ontos_index_timestamp(text)
TO api_runtime, worker_runtime;
GRANT EXECUTE ON FUNCTION
  runtime.record_project_physical_measurement(
    uuid, bigint, uuid, bigint, bigint, bigint, bigint, integer, varchar, varchar
  )
TO worker_runtime;
