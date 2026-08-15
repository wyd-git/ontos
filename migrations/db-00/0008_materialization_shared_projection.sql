SET LOCAL ROLE migration_owner;

CREATE TABLE runtime.object_identities (
  project_id uuid NOT NULL,
  object_type_resource_id uuid NOT NULL,
  object_rid uuid NOT NULL,
  canonical_primary_key text COLLATE "C" NOT NULL
    CHECK (octet_length(canonical_primary_key) BETWEEN 1 AND 1024),
  codec_version varchar(32) NOT NULL DEFAULT 'pk1' CHECK (codec_version = 'pk1'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, object_type_resource_id, object_rid),
  CONSTRAINT object_identities_resource_fk
    FOREIGN KEY (project_id, object_type_resource_id)
    REFERENCES meta.resources(project_id, resource_id) ON DELETE RESTRICT,
  CONSTRAINT object_identities_canonical_pk_uq
    UNIQUE (project_id, object_type_resource_id, canonical_primary_key),
  CONSTRAINT object_identities_project_rid_uq UNIQUE (project_id, object_rid),
  CONSTRAINT object_identities_full_binding_uq
    UNIQUE (project_id, object_type_resource_id, object_rid, canonical_primary_key)
);

CREATE TABLE runtime.object_base (
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  object_type_resource_id uuid NOT NULL,
  object_type_revision_id uuid NOT NULL,
  object_rid uuid NOT NULL,
  canonical_primary_key text COLLATE "C" NOT NULL
    CHECK (octet_length(canonical_primary_key) BETWEEN 1 AND 1024),
  properties jsonb NOT NULL CHECK (jsonb_typeof(properties) = 'object'),
  source_snapshot_id uuid NOT NULL,
  source_file_id uuid NOT NULL,
  source_row_number bigint NOT NULL CHECK (source_row_number >= 1),
  mapping_revision_id uuid NOT NULL,
  value_digest varchar(71) NOT NULL
    CHECK (value_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, generation_id, object_type_resource_id, object_rid),
  CONSTRAINT object_base_generation_fk FOREIGN KEY (
    project_id, generation_id, object_type_resource_id, object_type_revision_id
  ) REFERENCES runtime.generations(
    project_id, generation_id, target_resource_id, target_revision_id
  ) ON DELETE RESTRICT,
  CONSTRAINT object_base_identity_fk FOREIGN KEY (
    project_id, object_type_resource_id, object_rid, canonical_primary_key
  ) REFERENCES runtime.object_identities(
    project_id, object_type_resource_id, object_rid, canonical_primary_key
  ) ON DELETE RESTRICT,
  CONSTRAINT object_base_snapshot_file_fk FOREIGN KEY (
    project_id, source_snapshot_id, source_file_id
  ) REFERENCES runtime.snapshot_files(project_id, snapshot_id, file_id) ON DELETE RESTRICT,
  CONSTRAINT object_base_canonical_pk_uq
    UNIQUE (project_id, generation_id, object_type_resource_id, canonical_primary_key),
  CONSTRAINT object_base_current_binding_uq UNIQUE (
    project_id, generation_id, object_type_resource_id, object_type_revision_id,
    object_rid, canonical_primary_key, value_digest
  )
);

CREATE TABLE runtime.object_current (
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  object_type_resource_id uuid NOT NULL,
  object_type_revision_id uuid NOT NULL,
  object_rid uuid NOT NULL,
  canonical_primary_key text COLLATE "C" NOT NULL
    CHECK (octet_length(canonical_primary_key) BETWEEN 1 AND 1024),
  properties jsonb NOT NULL CHECK (jsonb_typeof(properties) = 'object'),
  base_value_digest varchar(71) NOT NULL
    CHECK (base_value_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, generation_id, object_type_resource_id, object_rid),
  CONSTRAINT object_current_generation_fk FOREIGN KEY (
    project_id, generation_id, object_type_resource_id, object_type_revision_id
  ) REFERENCES runtime.generations(
    project_id, generation_id, target_resource_id, target_revision_id
  ) ON DELETE RESTRICT,
  CONSTRAINT object_current_base_fk FOREIGN KEY (
    project_id, generation_id, object_type_resource_id, object_type_revision_id,
    object_rid, canonical_primary_key, base_value_digest
  ) REFERENCES runtime.object_base(
    project_id, generation_id, object_type_resource_id, object_type_revision_id,
    object_rid, canonical_primary_key, value_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT object_current_canonical_pk_uq
    UNIQUE (project_id, generation_id, object_type_resource_id, canonical_primary_key),
  CONSTRAINT object_current_head_binding_uq UNIQUE (
    project_id, generation_id, object_type_resource_id, object_type_revision_id,
    object_rid, base_value_digest
  )
);

CREATE TABLE runtime.link_base (
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  link_type_resource_id uuid NOT NULL,
  link_type_revision_id uuid NOT NULL,
  link_rid uuid NOT NULL,
  source_object_rid uuid NOT NULL,
  target_object_rid uuid NOT NULL,
  source_snapshot_id uuid NOT NULL,
  source_file_id uuid NOT NULL,
  source_row_number bigint NOT NULL CHECK (source_row_number >= 1),
  mapping_revision_id uuid NOT NULL,
  value_digest varchar(71) NOT NULL
    CHECK (value_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, generation_id, link_type_resource_id, link_rid),
  CONSTRAINT link_base_generation_fk FOREIGN KEY (
    project_id, generation_id, link_type_resource_id, link_type_revision_id
  ) REFERENCES runtime.generations(
    project_id, generation_id, target_resource_id, target_revision_id
  ) ON DELETE RESTRICT,
  CONSTRAINT link_base_source_identity_fk FOREIGN KEY (project_id, source_object_rid)
    REFERENCES runtime.object_identities(project_id, object_rid) ON DELETE RESTRICT,
  CONSTRAINT link_base_target_identity_fk FOREIGN KEY (project_id, target_object_rid)
    REFERENCES runtime.object_identities(project_id, object_rid) ON DELETE RESTRICT,
  CONSTRAINT link_base_snapshot_file_fk FOREIGN KEY (
    project_id, source_snapshot_id, source_file_id
  ) REFERENCES runtime.snapshot_files(project_id, snapshot_id, file_id) ON DELETE RESTRICT,
  CONSTRAINT link_base_endpoints_uq UNIQUE (
    project_id, generation_id, link_type_resource_id,
    source_object_rid, target_object_rid
  ),
  CONSTRAINT link_base_current_binding_uq UNIQUE (
    project_id, generation_id, link_type_resource_id, link_type_revision_id,
    link_rid, source_object_rid, target_object_rid, value_digest
  )
);

CREATE TABLE runtime.link_current (
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  link_type_resource_id uuid NOT NULL,
  link_type_revision_id uuid NOT NULL,
  link_rid uuid NOT NULL,
  source_object_rid uuid NOT NULL,
  target_object_rid uuid NOT NULL,
  base_value_digest varchar(71) NOT NULL
    CHECK (base_value_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, generation_id, link_type_resource_id, link_rid),
  CONSTRAINT link_current_generation_fk FOREIGN KEY (
    project_id, generation_id, link_type_resource_id, link_type_revision_id
  ) REFERENCES runtime.generations(
    project_id, generation_id, target_resource_id, target_revision_id
  ) ON DELETE RESTRICT,
  CONSTRAINT link_current_base_fk FOREIGN KEY (
    project_id, generation_id, link_type_resource_id, link_type_revision_id,
    link_rid, source_object_rid, target_object_rid, base_value_digest
  ) REFERENCES runtime.link_base(
    project_id, generation_id, link_type_resource_id, link_type_revision_id,
    link_rid, source_object_rid, target_object_rid, value_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT link_current_endpoints_uq UNIQUE (
    project_id, generation_id, link_type_resource_id,
    source_object_rid, target_object_rid
  )
);

CREATE INDEX link_current_source_traversal_idx ON runtime.link_current (
  project_id, generation_id, link_type_resource_id, source_object_rid, target_object_rid
);
CREATE INDEX link_current_target_traversal_idx ON runtime.link_current (
  project_id, generation_id, link_type_resource_id, target_object_rid, source_object_rid
);

CREATE TABLE runtime.object_heads (
  project_id uuid NOT NULL,
  object_type_resource_id uuid NOT NULL,
  object_rid uuid NOT NULL,
  current_generation_id uuid NOT NULL,
  object_type_revision_id uuid NOT NULL,
  head_version bigint NOT NULL DEFAULT 1 CHECK (head_version >= 1),
  head_digest varchar(71) NOT NULL
    CHECK (head_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, object_type_resource_id, object_rid),
  CONSTRAINT object_heads_identity_fk FOREIGN KEY (
    project_id, object_type_resource_id, object_rid
  ) REFERENCES runtime.object_identities(
    project_id, object_type_resource_id, object_rid
  ) ON DELETE RESTRICT,
  CONSTRAINT object_heads_current_fk FOREIGN KEY (
    project_id, current_generation_id, object_type_resource_id,
    object_type_revision_id, object_rid, head_digest
  ) REFERENCES runtime.object_current(
    project_id, generation_id, object_type_resource_id,
    object_type_revision_id, object_rid, base_value_digest
  ) ON DELETE RESTRICT
);

CREATE TABLE runtime.property_provenance (
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  object_type_resource_id uuid NOT NULL,
  object_rid uuid NOT NULL,
  property_api_name varchar(63) NOT NULL
    CHECK (property_api_name ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$'),
  source_snapshot_id uuid NOT NULL,
  source_file_id uuid NOT NULL,
  source_row_number bigint NOT NULL CHECK (source_row_number >= 1),
  input_column_ordinal integer NOT NULL CHECK (input_column_ordinal BETWEEN 0 AND 4095),
  mapping_revision_id uuid NOT NULL,
  algorithm_version varchar(128) NOT NULL CHECK (btrim(algorithm_version) <> ''),
  value_digest varchar(71) NOT NULL
    CHECK (value_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    project_id, generation_id, object_type_resource_id, object_rid, property_api_name
  ),
  CONSTRAINT property_provenance_object_fk FOREIGN KEY (
    project_id, generation_id, object_type_resource_id, object_rid
  ) REFERENCES runtime.object_current(
    project_id, generation_id, object_type_resource_id, object_rid
  ) ON DELETE RESTRICT,
  CONSTRAINT property_provenance_snapshot_file_fk FOREIGN KEY (
    project_id, source_snapshot_id, source_file_id
  ) REFERENCES runtime.snapshot_files(project_id, snapshot_id, file_id) ON DELETE RESTRICT
);

CREATE TABLE runtime.rejected_row_sets (
  project_id uuid NOT NULL,
  rejected_row_set_id uuid NOT NULL,
  report_id uuid NOT NULL,
  managed_artifact_id uuid NOT NULL,
  content_digest varchar(71) NOT NULL
    CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  rejected_row_count bigint NOT NULL CHECK (rejected_row_count >= 1),
  media_type varchar(255) NOT NULL DEFAULT 'application/vnd.ontos.rejected-rows+json'
    CHECK (media_type = 'application/vnd.ontos.rejected-rows+json'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, rejected_row_set_id),
  CONSTRAINT rejected_row_sets_report_fk FOREIGN KEY (project_id, report_id)
    REFERENCES runtime.materialization_reports(project_id, report_id) ON DELETE RESTRICT,
  CONSTRAINT rejected_row_sets_digest_uq UNIQUE (project_id, content_digest)
);

CREATE FUNCTION ontos_migration.g20203_enforce_object_head_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_object_head_update$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.object_type_resource_id IS DISTINCT FROM OLD.object_type_resource_id
    OR NEW.object_rid IS DISTINCT FROM OLD.object_rid
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'G20203_OBJECT_HEAD_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.head_digest IS NOT DISTINCT FROM OLD.head_digest THEN
    RAISE EXCEPTION 'G20203_OBJECT_HEAD_NO_BUSINESS_CHANGE' USING ERRCODE = '55000';
  END IF;
  IF NEW.head_version <> OLD.head_version + 1 OR NEW.changed_at < OLD.changed_at THEN
    RAISE EXCEPTION 'G20203_OBJECT_HEAD_VERSION_INVALID' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$g20203_object_head_update$;

CREATE FUNCTION ontos_migration.g20203_validate_projection_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20203_validate_projection_fact$
DECLARE
  valid_binding boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'object_base' THEN
    SELECT EXISTS (
      SELECT 1 FROM runtime.generations AS generation
      WHERE generation.project_id = NEW.project_id
        AND generation.generation_id = NEW.generation_id
        AND generation.target_resource_id = NEW.object_type_resource_id
        AND generation.target_revision_id = NEW.object_type_revision_id
        AND generation.member_kind = 'object'
        AND generation.snapshot_id = NEW.source_snapshot_id
        AND generation.mapping_revision_id = NEW.mapping_revision_id
        AND generation.state = 'building'
    ) INTO valid_binding;
  ELSIF TG_TABLE_NAME = 'link_base' THEN
    SELECT EXISTS (
      SELECT 1 FROM runtime.generations AS generation
      WHERE generation.project_id = NEW.project_id
        AND generation.generation_id = NEW.generation_id
        AND generation.target_resource_id = NEW.link_type_resource_id
        AND generation.target_revision_id = NEW.link_type_revision_id
        AND generation.member_kind = 'link'
        AND generation.snapshot_id = NEW.source_snapshot_id
        AND generation.mapping_revision_id = NEW.mapping_revision_id
        AND generation.state = 'building'
    ) INTO valid_binding;
  END IF;
  IF NOT valid_binding THEN
    RAISE EXCEPTION 'G20203_PROJECTION_GENERATION_BINDING_INVALID:%', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$g20203_validate_projection_fact$;

CREATE FUNCTION ontos_migration.g20203_validate_object_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20203_validate_object_identity$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM meta.resources AS resource
    WHERE resource.project_id = NEW.project_id
      AND resource.resource_id = NEW.object_type_resource_id
      AND resource.family = 'object_type'
      AND resource.state <> 'archived'
  ) THEN
    RAISE EXCEPTION 'G20203_OBJECT_IDENTITY_TYPE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$g20203_validate_object_identity$;

CREATE TRIGGER object_identities_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.object_identities
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER object_identities_type_guard
BEFORE INSERT ON runtime.object_identities
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_object_identity();
CREATE TRIGGER object_base_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.object_base
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER object_base_generation_guard
BEFORE INSERT ON runtime.object_base
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_projection_fact();
CREATE TRIGGER object_current_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.object_current
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER link_base_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.link_base
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER link_base_generation_guard
BEFORE INSERT ON runtime.link_base
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_projection_fact();
CREATE TRIGGER link_current_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.link_current
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER property_provenance_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.property_provenance
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER rejected_row_sets_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.rejected_row_sets
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER object_heads_controlled_update
BEFORE UPDATE ON runtime.object_heads
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_enforce_object_head_update();
CREATE TRIGGER object_heads_no_delete
BEFORE DELETE OR TRUNCATE ON runtime.object_heads
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA runtime
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON FUNCTION
  ontos_migration.g20203_enforce_object_head_update(),
  ontos_migration.g20203_validate_projection_fact(),
  ontos_migration.g20203_validate_object_identity()
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
