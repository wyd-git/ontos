SET LOCAL ROLE migration_owner;

-- Logical DB-02 starts here. 0001-0006 remain the immutable, single ledger history.

CREATE TABLE runtime.snapshot_groups (
  project_id uuid NOT NULL,
  snapshot_group_id uuid NOT NULL,
  group_key varchar(128) NOT NULL
    CHECK (group_key ~ '^[A-Za-z][A-Za-z0-9._-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, snapshot_group_id),
  CONSTRAINT snapshot_groups_project_fk FOREIGN KEY (project_id)
    REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  CONSTRAINT snapshot_groups_key_uq UNIQUE (project_id, group_key)
);

CREATE TABLE runtime.snapshot_group_versions (
  project_id uuid NOT NULL,
  snapshot_group_id uuid NOT NULL,
  group_version bigint NOT NULL CHECK (group_version >= 1),
  member_count integer NOT NULL CHECK (member_count BETWEEN 1 AND 256),
  state text NOT NULL DEFAULT 'registered' CHECK (state IN (
    'registered', 'validated', 'materializing', 'ready', 'active', 'superseded', 'failed'
  )),
  group_digest varchar(71) NOT NULL
    CHECK (group_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, snapshot_group_id, group_version),
  CONSTRAINT snapshot_group_versions_group_fk FOREIGN KEY (project_id, snapshot_group_id)
    REFERENCES runtime.snapshot_groups(project_id, snapshot_group_id) ON DELETE RESTRICT,
  CONSTRAINT snapshot_group_versions_digest_uq
    UNIQUE (project_id, snapshot_group_id, group_digest)
);

CREATE TABLE runtime.index_plans (
  project_id uuid NOT NULL,
  index_plan_id uuid NOT NULL,
  target_resource_id uuid NOT NULL,
  target_revision_id uuid NOT NULL,
  plan_digest varchar(71) NOT NULL
    CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  entry_count integer NOT NULL CHECK (entry_count BETWEEN 0 AND 64),
  compiler_version varchar(128) NOT NULL CHECK (btrim(compiler_version) <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, index_plan_id),
  CONSTRAINT index_plans_resource_fk FOREIGN KEY (project_id, target_resource_id)
    REFERENCES meta.resources(project_id, resource_id) ON DELETE RESTRICT,
  CONSTRAINT index_plans_revision_fk FOREIGN KEY (target_resource_id, target_revision_id)
    REFERENCES meta.resource_revisions(resource_id, revision_id) ON DELETE RESTRICT,
  CONSTRAINT index_plans_digest_uq UNIQUE (project_id, plan_digest),
  CONSTRAINT index_plans_target_digest_uq
    UNIQUE (project_id, target_resource_id, target_revision_id, plan_digest)
);

CREATE TABLE meta.release_runtime_plans (
  project_id uuid NOT NULL,
  release_id uuid NOT NULL,
  plan_digest varchar(71) NOT NULL
    CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  member_count integer NOT NULL CHECK (member_count BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (release_id),
  CONSTRAINT release_runtime_plans_release_fk FOREIGN KEY (project_id, release_id)
    REFERENCES meta.releases(project_id, release_id) ON DELETE RESTRICT,
  CONSTRAINT release_runtime_plans_context_uq
    UNIQUE (project_id, release_id, plan_digest)
);

CREATE TABLE meta.release_runtime_plan_members (
  project_id uuid NOT NULL,
  release_id uuid NOT NULL,
  runtime_plan_digest varchar(71) NOT NULL
    CHECK (runtime_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  member_key varchar(70) NOT NULL
    CHECK (member_key ~ '^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$'),
  member_kind text NOT NULL CHECK (member_kind IN ('object', 'link')),
  target_resource_id uuid NOT NULL,
  target_revision_id uuid NOT NULL,
  snapshot_schema_resource_id uuid NOT NULL,
  snapshot_schema_revision_id uuid NOT NULL,
  mapping_resource_id uuid NOT NULL,
  mapping_revision_id uuid NOT NULL,
  snapshot_group_id uuid NOT NULL,
  index_plan_digest varchar(71) NOT NULL
    CHECK (index_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (release_id, member_key),
  CONSTRAINT runtime_plan_member_prefix_ck
    CHECK (split_part(member_key, ':', 1) = member_kind),
  CONSTRAINT runtime_plan_member_plan_fk
    FOREIGN KEY (project_id, release_id, runtime_plan_digest)
    REFERENCES meta.release_runtime_plans(project_id, release_id, plan_digest)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_plan_member_target_resource_fk
    FOREIGN KEY (project_id, target_resource_id)
    REFERENCES meta.resources(project_id, resource_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_plan_member_target_revision_fk
    FOREIGN KEY (target_resource_id, target_revision_id)
    REFERENCES meta.resource_revisions(resource_id, revision_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_plan_member_schema_resource_fk
    FOREIGN KEY (project_id, snapshot_schema_resource_id)
    REFERENCES meta.resources(project_id, resource_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_plan_member_schema_revision_fk
    FOREIGN KEY (snapshot_schema_resource_id, snapshot_schema_revision_id)
    REFERENCES meta.resource_revisions(resource_id, revision_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_plan_member_mapping_resource_fk
    FOREIGN KEY (project_id, mapping_resource_id)
    REFERENCES meta.resources(project_id, resource_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_plan_member_mapping_revision_fk
    FOREIGN KEY (mapping_resource_id, mapping_revision_id)
    REFERENCES meta.resource_revisions(resource_id, revision_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_plan_member_group_fk
    FOREIGN KEY (project_id, snapshot_group_id)
    REFERENCES runtime.snapshot_groups(project_id, snapshot_group_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_plan_member_index_fk
    FOREIGN KEY (project_id, target_resource_id, target_revision_id, index_plan_digest)
    REFERENCES runtime.index_plans(project_id, target_resource_id, target_revision_id, plan_digest)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_plan_member_activation_uq
    UNIQUE (project_id, release_id, member_key),
  CONSTRAINT runtime_plan_member_context_uq UNIQUE (
    project_id, release_id, member_key, target_resource_id, target_revision_id,
    snapshot_schema_resource_id, snapshot_schema_revision_id,
    mapping_resource_id, mapping_revision_id, snapshot_group_id,
    index_plan_digest, runtime_plan_digest
  )
);

CREATE TABLE runtime.dataset_snapshots (
  project_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  snapshot_group_id uuid NOT NULL,
  group_version bigint NOT NULL CHECK (group_version >= 1),
  member_key varchar(70) NOT NULL
    CHECK (member_key ~ '^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$'),
  member_kind text NOT NULL CHECK (member_kind IN ('object', 'link')),
  target_resource_id uuid NOT NULL,
  target_revision_id uuid NOT NULL,
  snapshot_schema_resource_id uuid NOT NULL,
  snapshot_schema_revision_id uuid NOT NULL,
  mapping_resource_id uuid NOT NULL,
  mapping_revision_id uuid NOT NULL,
  runtime_plan_digest varchar(71) NOT NULL
    CHECK (runtime_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  content_digest varchar(71) NOT NULL
    CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  byte_count bigint NOT NULL CHECK (byte_count >= 0),
  row_count bigint NOT NULL CHECK (row_count >= 0),
  file_count integer NOT NULL CHECK (file_count BETWEEN 1 AND 1024),
  previous_snapshot_id uuid,
  state text NOT NULL DEFAULT 'registered' CHECK (state IN (
    'registered', 'validated', 'materializing', 'ready', 'active', 'superseded', 'failed'
  )),
  snapshot_digest varchar(71) NOT NULL
    CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, snapshot_id),
  CONSTRAINT dataset_snapshots_member_prefix_ck
    CHECK (split_part(member_key, ':', 1) = member_kind),
  CONSTRAINT dataset_snapshots_group_version_fk
    FOREIGN KEY (project_id, snapshot_group_id, group_version)
    REFERENCES runtime.snapshot_group_versions(project_id, snapshot_group_id, group_version)
    ON DELETE RESTRICT,
  CONSTRAINT dataset_snapshots_target_resource_fk
    FOREIGN KEY (project_id, target_resource_id)
    REFERENCES meta.resources(project_id, resource_id) ON DELETE RESTRICT,
  CONSTRAINT dataset_snapshots_target_revision_fk
    FOREIGN KEY (target_resource_id, target_revision_id)
    REFERENCES meta.resource_revisions(resource_id, revision_id) ON DELETE RESTRICT,
  CONSTRAINT dataset_snapshots_schema_resource_fk
    FOREIGN KEY (project_id, snapshot_schema_resource_id)
    REFERENCES meta.resources(project_id, resource_id) ON DELETE RESTRICT,
  CONSTRAINT dataset_snapshots_schema_revision_fk
    FOREIGN KEY (snapshot_schema_resource_id, snapshot_schema_revision_id)
    REFERENCES meta.resource_revisions(resource_id, revision_id) ON DELETE RESTRICT,
  CONSTRAINT dataset_snapshots_mapping_resource_fk
    FOREIGN KEY (project_id, mapping_resource_id)
    REFERENCES meta.resources(project_id, resource_id) ON DELETE RESTRICT,
  CONSTRAINT dataset_snapshots_mapping_revision_fk
    FOREIGN KEY (mapping_resource_id, mapping_revision_id)
    REFERENCES meta.resource_revisions(resource_id, revision_id) ON DELETE RESTRICT,
  CONSTRAINT dataset_snapshots_previous_fk
    FOREIGN KEY (project_id, previous_snapshot_id)
    REFERENCES runtime.dataset_snapshots(project_id, snapshot_id) ON DELETE RESTRICT,
  CONSTRAINT dataset_snapshots_not_self_previous_ck
    CHECK (previous_snapshot_id IS DISTINCT FROM snapshot_id),
  CONSTRAINT dataset_snapshots_group_member_uq
    UNIQUE (project_id, snapshot_group_id, group_version, member_key),
  CONSTRAINT dataset_snapshots_digest_uq
    UNIQUE (project_id, snapshot_digest),
  CONSTRAINT dataset_snapshots_group_binding_uq UNIQUE (
    project_id, snapshot_id, member_key, target_resource_id, target_revision_id,
    snapshot_group_id, group_version
  ),
  CONSTRAINT dataset_snapshots_generation_binding_uq UNIQUE (
    project_id, snapshot_id, member_key, target_resource_id, target_revision_id,
    snapshot_group_id, group_version, snapshot_schema_resource_id,
    snapshot_schema_revision_id, mapping_resource_id, mapping_revision_id,
    runtime_plan_digest
  )
);

CREATE TABLE runtime.snapshot_files (
  project_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  file_id uuid NOT NULL,
  managed_artifact_id uuid NOT NULL,
  object_version varchar(1024) NOT NULL CHECK (btrim(object_version) <> ''),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 1023),
  content_digest varchar(71) NOT NULL
    CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  byte_count bigint NOT NULL CHECK (byte_count >= 0),
  row_count bigint NOT NULL CHECK (row_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, snapshot_id, file_id),
  CONSTRAINT snapshot_files_snapshot_fk FOREIGN KEY (project_id, snapshot_id)
    REFERENCES runtime.dataset_snapshots(project_id, snapshot_id) ON DELETE RESTRICT,
  CONSTRAINT snapshot_files_ordinal_uq UNIQUE (project_id, snapshot_id, ordinal),
  CONSTRAINT snapshot_files_managed_version_uq
    UNIQUE (project_id, managed_artifact_id, object_version)
);

CREATE TABLE runtime.snapshot_group_members (
  project_id uuid NOT NULL,
  snapshot_group_id uuid NOT NULL,
  group_version bigint NOT NULL,
  member_key varchar(70) NOT NULL
    CHECK (member_key ~ '^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$'),
  member_kind text NOT NULL CHECK (member_kind IN ('object', 'link')),
  snapshot_id uuid NOT NULL,
  target_resource_id uuid NOT NULL,
  target_revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, snapshot_group_id, group_version, member_key),
  CONSTRAINT snapshot_group_members_prefix_ck
    CHECK (split_part(member_key, ':', 1) = member_kind),
  CONSTRAINT snapshot_group_members_version_fk
    FOREIGN KEY (project_id, snapshot_group_id, group_version)
    REFERENCES runtime.snapshot_group_versions(project_id, snapshot_group_id, group_version)
    ON DELETE RESTRICT,
  CONSTRAINT snapshot_group_members_snapshot_fk
    FOREIGN KEY (project_id, snapshot_id, member_key, target_resource_id, target_revision_id,
                 snapshot_group_id, group_version)
    REFERENCES runtime.dataset_snapshots(
      project_id, snapshot_id, member_key, target_resource_id, target_revision_id,
      snapshot_group_id, group_version
    ) ON DELETE RESTRICT
);

CREATE TABLE runtime.materialization_reports (
  project_id uuid NOT NULL,
  report_id uuid NOT NULL,
  snapshot_group_id uuid NOT NULL,
  group_version bigint NOT NULL,
  job_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('passed', 'awaiting_confirmation', 'failed')),
  total_rows bigint NOT NULL CHECK (total_rows >= 0),
  accepted_rows bigint NOT NULL CHECK (accepted_rows >= 0),
  rejected_rows bigint NOT NULL CHECK (rejected_rows >= 0),
  validator_version varchar(128) NOT NULL CHECK (btrim(validator_version) <> ''),
  report_digest varchar(71) NOT NULL
    CHECK (report_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, report_id),
  CONSTRAINT materialization_reports_totals_ck
    CHECK (accepted_rows + rejected_rows = total_rows),
  CONSTRAINT materialization_reports_group_fk
    FOREIGN KEY (project_id, snapshot_group_id, group_version)
    REFERENCES runtime.snapshot_group_versions(project_id, snapshot_group_id, group_version)
    ON DELETE RESTRICT,
  CONSTRAINT materialization_reports_digest_uq UNIQUE (project_id, report_digest),
  CONSTRAINT materialization_reports_generation_uq
    UNIQUE (project_id, report_id, report_digest)
);

CREATE TABLE runtime.materialization_report_reasons (
  project_id uuid NOT NULL,
  report_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN (
    'PRIMARY_KEY_NULL', 'PRIMARY_KEY_DUPLICATE', 'REQUIRED_PROPERTY_INVALID',
    'OPTIONAL_PROPERTY_INVALID', 'REQUIRED_LINK_DANGLING', 'OPTIONAL_LINK_DANGLING',
    'ROW_COUNT_CONFIRMATION_REQUIRED'
  )),
  reason_count bigint NOT NULL CHECK (reason_count >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, report_id, reason_code),
  CONSTRAINT materialization_report_reasons_report_fk FOREIGN KEY (project_id, report_id)
    REFERENCES runtime.materialization_reports(project_id, report_id) ON DELETE RESTRICT
);

CREATE TABLE runtime.generations (
  project_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  member_key varchar(70) NOT NULL
    CHECK (member_key ~ '^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$'),
  member_kind text NOT NULL CHECK (member_kind IN ('object', 'link')),
  target_resource_id uuid NOT NULL,
  target_revision_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  snapshot_group_id uuid NOT NULL,
  group_version bigint NOT NULL CHECK (group_version >= 1),
  snapshot_schema_resource_id uuid NOT NULL,
  snapshot_schema_revision_id uuid NOT NULL,
  mapping_resource_id uuid NOT NULL,
  mapping_revision_id uuid NOT NULL,
  runtime_plan_digest varchar(71) NOT NULL
    CHECK (runtime_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  index_plan_digest varchar(71) NOT NULL
    CHECK (index_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  report_id uuid NOT NULL,
  report_digest varchar(71) NOT NULL
    CHECK (report_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'building'
    CHECK (state IN ('building', 'ready', 'active', 'retired', 'failed')),
  generation_digest varchar(71) NOT NULL
    CHECK (generation_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, generation_id),
  CONSTRAINT generations_member_prefix_ck
    CHECK (split_part(member_key, ':', 1) = member_kind),
  CONSTRAINT generations_snapshot_fk FOREIGN KEY (
    project_id, snapshot_id, member_key, target_resource_id, target_revision_id,
    snapshot_group_id, group_version, snapshot_schema_resource_id,
    snapshot_schema_revision_id, mapping_resource_id, mapping_revision_id,
    runtime_plan_digest
  ) REFERENCES runtime.dataset_snapshots(
    project_id, snapshot_id, member_key, target_resource_id, target_revision_id,
    snapshot_group_id, group_version, snapshot_schema_resource_id,
    snapshot_schema_revision_id, mapping_resource_id, mapping_revision_id,
    runtime_plan_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT generations_index_plan_fk
    FOREIGN KEY (project_id, target_resource_id, target_revision_id, index_plan_digest)
    REFERENCES runtime.index_plans(project_id, target_resource_id, target_revision_id, plan_digest)
    ON DELETE RESTRICT,
  CONSTRAINT generations_report_fk
    FOREIGN KEY (project_id, report_id, report_digest)
    REFERENCES runtime.materialization_reports(project_id, report_id, report_digest)
    ON DELETE RESTRICT,
  CONSTRAINT generations_digest_uq UNIQUE (project_id, generation_digest),
  CONSTRAINT generations_projection_binding_uq
    UNIQUE (project_id, generation_id, target_resource_id, target_revision_id),
  CONSTRAINT generations_activation_binding_uq UNIQUE (
    project_id, generation_id, member_key, snapshot_id, snapshot_group_id, group_version
  ),
  CONSTRAINT generations_certificate_binding_uq UNIQUE (
    project_id, generation_id, generation_digest, member_key, target_resource_id,
    target_revision_id, snapshot_group_id, group_version,
    snapshot_schema_resource_id, snapshot_schema_revision_id,
    mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest
  )
);

CREATE TABLE runtime.compatibility_certificates (
  project_id uuid NOT NULL,
  certificate_id uuid NOT NULL,
  issuer text NOT NULL DEFAULT 'materialization-compatibility-verifier'
    CHECK (issuer = 'materialization-compatibility-verifier'),
  generation_id uuid NOT NULL,
  generation_digest varchar(71) NOT NULL
    CHECK (generation_digest ~ '^sha256:[0-9a-f]{64}$'),
  target_release_id uuid NOT NULL,
  target_member_key varchar(70) NOT NULL
    CHECK (target_member_key ~ '^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$'),
  target_resource_id uuid NOT NULL,
  target_revision_id uuid NOT NULL,
  snapshot_group_id uuid NOT NULL,
  group_version bigint NOT NULL CHECK (group_version >= 1),
  snapshot_schema_resource_id uuid NOT NULL,
  snapshot_schema_revision_id uuid NOT NULL,
  snapshot_schema_digest varchar(71) NOT NULL
    CHECK (snapshot_schema_digest ~ '^sha256:[0-9a-f]{64}$'),
  mapping_resource_id uuid NOT NULL,
  mapping_revision_id uuid NOT NULL,
  mapping_digest varchar(71) NOT NULL
    CHECK (mapping_digest ~ '^sha256:[0-9a-f]{64}$'),
  index_plan_digest varchar(71) NOT NULL
    CHECK (index_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  runtime_plan_digest varchar(71) NOT NULL
    CHECK (runtime_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('exact_pin', 'projection_equivalent')),
  validator_version varchar(128) NOT NULL CHECK (btrim(validator_version) <> ''),
  evidence_digest varchar(71) NOT NULL
    CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  certificate_digest varchar(71) NOT NULL
    CHECK (certificate_digest ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (project_id, certificate_id),
  CONSTRAINT compatibility_certificates_generation_fk FOREIGN KEY (
    project_id, generation_id, generation_digest, target_member_key,
    target_resource_id, target_revision_id, snapshot_group_id, group_version,
    snapshot_schema_resource_id, snapshot_schema_revision_id,
    mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest
  ) REFERENCES runtime.generations(
    project_id, generation_id, generation_digest, member_key,
    target_resource_id, target_revision_id, snapshot_group_id, group_version,
    snapshot_schema_resource_id, snapshot_schema_revision_id,
    mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT compatibility_certificates_plan_member_fk FOREIGN KEY (
    project_id, target_release_id, target_member_key, target_resource_id,
    target_revision_id, snapshot_schema_resource_id, snapshot_schema_revision_id,
    mapping_resource_id, mapping_revision_id, snapshot_group_id,
    index_plan_digest, runtime_plan_digest
  ) REFERENCES meta.release_runtime_plan_members(
    project_id, release_id, member_key, target_resource_id,
    target_revision_id, snapshot_schema_resource_id, snapshot_schema_revision_id,
    mapping_resource_id, mapping_revision_id, snapshot_group_id,
    index_plan_digest, runtime_plan_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT compatibility_certificates_digest_uq
    UNIQUE (project_id, certificate_digest),
  CONSTRAINT compatibility_certificates_activation_uq UNIQUE (
    project_id, certificate_id, generation_id, target_release_id,
    target_member_key, snapshot_group_id, group_version
  )
);

ALTER TABLE meta.runtime_activations
  DROP CONSTRAINT runtime_activations_member_count_check,
  ADD CONSTRAINT runtime_activations_member_count_ck
    CHECK (member_count BETWEEN 0 AND 256);

CREATE TABLE meta.runtime_activation_members (
  project_id uuid NOT NULL,
  release_id uuid NOT NULL,
  activation_id uuid NOT NULL,
  member_key varchar(70) NOT NULL
    CHECK (member_key ~ '^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$'),
  generation_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  snapshot_group_id uuid NOT NULL,
  group_version bigint NOT NULL CHECK (group_version >= 1),
  certificate_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (release_id, activation_id, member_key),
  CONSTRAINT runtime_activation_members_release_fk FOREIGN KEY (project_id, release_id)
    REFERENCES meta.releases(project_id, release_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_activation_members_activation_fk FOREIGN KEY (release_id, activation_id)
    REFERENCES meta.runtime_activations(release_id, activation_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_activation_members_plan_fk
    FOREIGN KEY (project_id, release_id, member_key)
    REFERENCES meta.release_runtime_plan_members(project_id, release_id, member_key)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_activation_members_generation_fk FOREIGN KEY (
    project_id, generation_id, member_key, snapshot_id, snapshot_group_id, group_version
  ) REFERENCES runtime.generations(
    project_id, generation_id, member_key, snapshot_id, snapshot_group_id, group_version
  ) ON DELETE RESTRICT,
  CONSTRAINT runtime_activation_members_certificate_fk FOREIGN KEY (
    project_id, certificate_id, generation_id, release_id,
    member_key, snapshot_group_id, group_version
  ) REFERENCES runtime.compatibility_certificates(
    project_id, certificate_id, generation_id, target_release_id,
    target_member_key, snapshot_group_id, group_version
  ) ON DELETE RESTRICT,
  CONSTRAINT runtime_activation_members_generation_uq
    UNIQUE (release_id, activation_id, generation_id)
);

CREATE FUNCTION ontos_migration.g20203_reject_fact_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_reject_fact_mutation$
BEGIN
  RAISE EXCEPTION 'G20203_IMMUTABLE_FACT:%', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$g20203_reject_fact_mutation$;

-- G2-02 activated the strict snapshot_schema and mapping parsers while preserving
-- the existing validator version and link dependency rules.
CREATE OR REPLACE FUNCTION ontos_migration.g20106_enforce_revision_validation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20106_revision_validation$
DECLARE
  dependency_count integer;
  source_target uuid;
  target_target uuid;
BEGIN
  IF OLD.state <> 'draft' OR NEW.state <> 'validated' THEN RETURN NEW; END IF;
  IF NEW.family NOT IN ('object_type', 'link_type', 'snapshot_schema', 'mapping') THEN
    RAISE EXCEPTION 'G20106_VALIDATOR_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM meta.validation_reports AS report
    WHERE report.subject_type = 'resource_revision'
      AND report.resource_revision_id = OLD.revision_id
      AND report.subject_digest = OLD.content_digest
      AND report.validator_version = 'metadata-g2-01-v1'
      AND report.valid = TRUE
  ) THEN
    RAISE EXCEPTION 'G20106_VALID_REPORT_REQUIRED' USING ERRCODE = '55000';
  END IF;

  SELECT count(*)::integer INTO dependency_count
  FROM meta.resource_dependencies WHERE source_revision_id = OLD.revision_id;
  IF NEW.family IN ('object_type', 'snapshot_schema', 'mapping') THEN
    IF dependency_count <> 0 THEN
      RAISE EXCEPTION 'G20106_RESOURCE_DEPENDENCIES_FORBIDDEN' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT target_revision_id INTO source_target
  FROM meta.resource_dependencies
  WHERE source_revision_id = OLD.revision_id AND dependency_type = 'link_source';
  SELECT target_revision_id INTO target_target
  FROM meta.resource_dependencies
  WHERE source_revision_id = OLD.revision_id AND dependency_type = 'link_target';
  IF dependency_count <> 2
    OR source_target IS DISTINCT FROM (NEW.content #>> '{source,objectTypeRevisionId}')::uuid
    OR target_target IS DISTINCT FROM (NEW.content #>> '{target,objectTypeRevisionId}')::uuid
    OR NOT EXISTS (
      SELECT 1 FROM meta.resource_dependencies
      WHERE source_revision_id = OLD.revision_id
        AND dependency_type = 'link_source'
        AND source_path = '/source/objectTypeRevisionId'
    ) OR NOT EXISTS (
      SELECT 1 FROM meta.resource_dependencies
      WHERE source_revision_id = OLD.revision_id
        AND dependency_type = 'link_target'
        AND source_path = '/target/objectTypeRevisionId'
    ) THEN
    RAISE EXCEPTION 'G20106_DEPENDENCY_SET_INCOMPLETE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20106_revision_validation$;

CREATE FUNCTION ontos_migration.g20203_enforce_lifecycle() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_enforce_lifecycle$
DECLARE
  allowed boolean := false;
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
      OR NEW.report_id IS DISTINCT FROM OLD.report_id
      OR NEW.report_digest IS DISTINCT FROM OLD.report_digest
      OR NEW.generation_digest IS DISTINCT FROM OLD.generation_digest
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
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
  RETURN NEW;
END
$g20203_enforce_lifecycle$;

CREATE FUNCTION ontos_migration.g20203_validate_revision_bindings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20203_validate_revision_bindings$
DECLARE
  expected_target_family text;
BEGIN
  expected_target_family := CASE NEW.member_kind WHEN 'object' THEN 'object_type' ELSE 'link_type' END;
  IF NOT EXISTS (
    SELECT 1 FROM meta.resource_revisions AS revision
    WHERE revision.resource_id = NEW.target_resource_id
      AND revision.revision_id = NEW.target_revision_id
      AND revision.family = expected_target_family
  ) OR NOT EXISTS (
    SELECT 1 FROM meta.resource_revisions AS revision
    WHERE revision.resource_id = NEW.snapshot_schema_resource_id
      AND revision.revision_id = NEW.snapshot_schema_revision_id
      AND revision.family = 'snapshot_schema'
  ) OR NOT EXISTS (
    SELECT 1 FROM meta.resource_revisions AS revision
    WHERE revision.resource_id = NEW.mapping_resource_id
      AND revision.revision_id = NEW.mapping_revision_id
      AND revision.family = 'mapping'
  ) THEN
    RAISE EXCEPTION 'G20203_REVISION_FAMILY_MISMATCH:%', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$g20203_validate_revision_bindings$;

CREATE FUNCTION ontos_migration.g20203_runtime_plan_digest(
  p_project_id uuid,
  p_release_id uuid
) RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $g20203_runtime_plan_digest$
  SELECT 'sha256:' || encode(sha256(convert_to(
    '{"contractVersion":"runtime-member-plan-v1","members":[' ||
    COALESCE(string_agg(
      '{"indexPlanDigest":' || to_json(member.index_plan_digest)::text ||
      ',"mappingRevisionId":' || to_json(member.mapping_revision_id::text)::text ||
      ',"memberKey":' || to_json(member.member_key)::text ||
      ',"memberKind":' || to_json(member.member_kind)::text ||
      ',"snapshotGroupId":' || to_json(member.snapshot_group_id::text)::text ||
      ',"snapshotSchemaRevisionId":' || to_json(member.snapshot_schema_revision_id::text)::text ||
      ',"targetResourceId":' || to_json(member.target_resource_id::text)::text ||
      ',"targetRevisionId":' || to_json(member.target_revision_id::text)::text || '}',
      ',' ORDER BY member.member_key COLLATE "C"
    ), '') || '],"projectId":' || to_json(p_project_id::text)::text ||
    ',"releaseId":' || to_json(p_release_id::text)::text || ',"schemaVersion":1}',
    'UTF8'
  )), 'hex')
  FROM meta.release_runtime_plan_members AS member
  WHERE member.project_id = p_project_id AND member.release_id = p_release_id
$g20203_runtime_plan_digest$;

CREATE FUNCTION ontos_migration.g20203_validate_runtime_plan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20203_validate_runtime_plan$
DECLARE
  affected_release_id uuid := COALESCE(NEW.release_id, OLD.release_id);
  plan meta.release_runtime_plans%ROWTYPE;
  actual_count integer;
BEGIN
  SELECT * INTO plan FROM meta.release_runtime_plans WHERE release_id = affected_release_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*)::integer INTO actual_count
  FROM meta.release_runtime_plan_members WHERE release_id = affected_release_id;
  IF actual_count <> plan.member_count
    OR ontos_migration.g20203_runtime_plan_digest(plan.project_id, plan.release_id) <> plan.plan_digest THEN
    RAISE EXCEPTION 'G20203_RUNTIME_PLAN_DIGEST_OR_COUNT_MISMATCH'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$g20203_validate_runtime_plan$;

CREATE FUNCTION ontos_migration.g20203_activation_digest(
  p_release_id uuid,
  p_activation_id uuid
) RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $g20203_activation_digest$
  SELECT 'sha256:' || encode(sha256(convert_to(
    '{"activationId":' || to_json(activation.activation_id::text)::text ||
    ',"contractVersion":"runtime-activation-v1","members":[' ||
    COALESCE(string_agg(
      '{"certificateId":' || to_json(member.certificate_id::text)::text ||
      ',"generationId":' || to_json(member.generation_id::text)::text ||
      ',"groupVersion":' || member.group_version::text ||
      ',"memberKey":' || to_json(member.member_key)::text ||
      ',"snapshotGroupId":' || to_json(member.snapshot_group_id::text)::text ||
      ',"snapshotId":' || to_json(member.snapshot_id::text)::text || '}',
      ',' ORDER BY member.member_key COLLATE "C"
    ), '') || '],"projectId":' || to_json(release.project_id::text)::text ||
    ',"releaseId":' || to_json(activation.release_id::text)::text ||
    ',"runtimePlanDigest":' || to_json(plan.plan_digest)::text || ',"schemaVersion":1}',
    'UTF8'
  )), 'hex')
  FROM meta.runtime_activations AS activation
  JOIN meta.releases AS release ON release.release_id = activation.release_id
  JOIN meta.release_runtime_plans AS plan ON plan.release_id = activation.release_id
  LEFT JOIN meta.runtime_activation_members AS member
    ON member.release_id = activation.release_id
   AND member.activation_id = activation.activation_id
  WHERE activation.release_id = p_release_id AND activation.activation_id = p_activation_id
  GROUP BY activation.activation_id, activation.release_id, release.project_id, plan.plan_digest
$g20203_activation_digest$;

CREATE FUNCTION ontos_migration.g20203_validate_activation_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20203_validate_activation_members$
DECLARE
  affected_release_id uuid := COALESCE(NEW.release_id, OLD.release_id);
  affected_activation_id uuid := COALESCE(NEW.activation_id, OLD.activation_id);
  activation meta.runtime_activations%ROWTYPE;
  plan meta.release_runtime_plans%ROWTYPE;
  actual_count integer;
BEGIN
  SELECT * INTO activation FROM meta.runtime_activations
  WHERE release_id = affected_release_id AND activation_id = affected_activation_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT count(*)::integer INTO actual_count FROM meta.runtime_activation_members
  WHERE release_id = affected_release_id AND activation_id = affected_activation_id;

  IF activation.member_count = 0 THEN
    IF actual_count <> 0 OR EXISTS (
      SELECT 1 FROM meta.release_runtime_plans WHERE release_id = affected_release_id
    ) THEN
      RAISE EXCEPTION 'G20203_EMPTY_ACTIVATION_PLAN_OR_MEMBER_MISMATCH'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  SELECT * INTO plan FROM meta.release_runtime_plans WHERE release_id = affected_release_id;
  IF NOT FOUND OR actual_count <> activation.member_count OR actual_count <> plan.member_count
    OR ontos_migration.g20203_activation_digest(
      affected_release_id, affected_activation_id
    ) <> activation.activation_digest
    OR EXISTS (
      SELECT 1
      FROM meta.runtime_activation_members AS member
      JOIN runtime.generations AS generation
        ON generation.project_id = member.project_id
       AND generation.generation_id = member.generation_id
      WHERE member.release_id = affected_release_id
        AND member.activation_id = affected_activation_id
        AND generation.state NOT IN ('ready', 'active')
    ) THEN
    RAISE EXCEPTION 'G20203_ACTIVATION_DIGEST_COUNT_OR_GENERATION_MISMATCH'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$g20203_validate_activation_members$;

CREATE FUNCTION ontos_migration.g20203_validate_snapshot_files() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20203_validate_snapshot_files$
DECLARE
  affected_project_id uuid := COALESCE(NEW.project_id, OLD.project_id);
  affected_snapshot_id uuid := COALESCE(NEW.snapshot_id, OLD.snapshot_id);
  snapshot runtime.dataset_snapshots%ROWTYPE;
  actual_files integer;
  actual_bytes numeric;
  actual_rows numeric;
BEGIN
  SELECT * INTO snapshot FROM runtime.dataset_snapshots
  WHERE project_id = affected_project_id AND snapshot_id = affected_snapshot_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*)::integer, COALESCE(sum(byte_count), 0), COALESCE(sum(row_count), 0)
  INTO actual_files, actual_bytes, actual_rows
  FROM runtime.snapshot_files
  WHERE project_id = affected_project_id AND snapshot_id = affected_snapshot_id;
  IF actual_files <> snapshot.file_count OR actual_bytes <> snapshot.byte_count
    OR actual_rows <> snapshot.row_count THEN
    RAISE EXCEPTION 'G20203_SNAPSHOT_FILE_TOTAL_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$g20203_validate_snapshot_files$;

CREATE FUNCTION ontos_migration.g20203_validate_group_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20203_validate_group_members$
DECLARE
  affected_project_id uuid := COALESCE(NEW.project_id, OLD.project_id);
  affected_group_id uuid := COALESCE(NEW.snapshot_group_id, OLD.snapshot_group_id);
  affected_version bigint := COALESCE(NEW.group_version, OLD.group_version);
  expected_count integer;
  actual_count integer;
BEGIN
  SELECT member_count INTO expected_count FROM runtime.snapshot_group_versions
  WHERE project_id = affected_project_id AND snapshot_group_id = affected_group_id
    AND group_version = affected_version;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*)::integer INTO actual_count FROM runtime.snapshot_group_members
  WHERE project_id = affected_project_id AND snapshot_group_id = affected_group_id
    AND group_version = affected_version;
  IF actual_count <> expected_count THEN
    RAISE EXCEPTION 'G20203_SNAPSHOT_GROUP_MEMBER_COUNT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$g20203_validate_group_members$;

CREATE FUNCTION ontos_migration.g20203_validate_report() RETURNS trigger
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
    OR (report.outcome = 'failed' AND NOT has_fatal) THEN
    RAISE EXCEPTION 'G20203_MATERIALIZATION_REPORT_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$g20203_validate_report$;

CREATE TRIGGER release_runtime_plans_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON meta.release_runtime_plans
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER release_runtime_plan_members_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON meta.release_runtime_plan_members
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER runtime_activation_members_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON meta.runtime_activation_members
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();

CREATE TRIGGER snapshot_groups_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.snapshot_groups
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER snapshot_group_versions_lifecycle
BEFORE UPDATE ON runtime.snapshot_group_versions
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_enforce_lifecycle();
CREATE TRIGGER snapshot_group_versions_no_delete
BEFORE DELETE OR TRUNCATE ON runtime.snapshot_group_versions
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER dataset_snapshots_lifecycle
BEFORE UPDATE ON runtime.dataset_snapshots
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_enforce_lifecycle();
CREATE TRIGGER dataset_snapshots_no_delete
BEFORE DELETE OR TRUNCATE ON runtime.dataset_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER generations_lifecycle
BEFORE UPDATE ON runtime.generations
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_enforce_lifecycle();
CREATE TRIGGER generations_no_delete
BEFORE DELETE OR TRUNCATE ON runtime.generations
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();

CREATE TRIGGER runtime_plan_member_revision_guard
BEFORE INSERT ON meta.release_runtime_plan_members
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_revision_bindings();
CREATE TRIGGER dataset_snapshot_revision_guard
BEFORE INSERT ON runtime.dataset_snapshots
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_revision_bindings();
CREATE TRIGGER generation_revision_guard
BEFORE INSERT ON runtime.generations
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_revision_bindings();

CREATE TRIGGER index_plans_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.index_plans
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER snapshot_files_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.snapshot_files
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER snapshot_group_members_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.snapshot_group_members
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER materialization_reports_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.materialization_reports
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER materialization_report_reasons_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.materialization_report_reasons
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER compatibility_certificates_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.compatibility_certificates
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();

CREATE CONSTRAINT TRIGGER release_runtime_plans_complete
AFTER INSERT ON meta.release_runtime_plans
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_runtime_plan();
CREATE CONSTRAINT TRIGGER release_runtime_plan_members_complete
AFTER INSERT ON meta.release_runtime_plan_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_runtime_plan();
CREATE CONSTRAINT TRIGGER runtime_activations_members_complete
AFTER INSERT ON meta.runtime_activations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_activation_members();
CREATE CONSTRAINT TRIGGER runtime_activation_members_complete
AFTER INSERT ON meta.runtime_activation_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_activation_members();
CREATE CONSTRAINT TRIGGER dataset_snapshots_files_complete
AFTER INSERT ON runtime.dataset_snapshots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_snapshot_files();
CREATE CONSTRAINT TRIGGER snapshot_files_snapshot_complete
AFTER INSERT ON runtime.snapshot_files
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_snapshot_files();
CREATE CONSTRAINT TRIGGER snapshot_group_versions_members_complete
AFTER INSERT ON runtime.snapshot_group_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_group_members();
CREATE CONSTRAINT TRIGGER snapshot_group_members_version_complete
AFTER INSERT ON runtime.snapshot_group_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_group_members();
CREATE CONSTRAINT TRIGGER materialization_reports_reasons_complete
AFTER INSERT ON runtime.materialization_reports
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_report();
CREATE CONSTRAINT TRIGGER materialization_report_reasons_report_complete
AFTER INSERT ON runtime.materialization_report_reasons
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20203_validate_report();

-- DB-01 considered every Activation insert an immediate publish. DB-02 permits an
-- unreferenced READY candidate; published Releases still require their complete pointers.
CREATE OR REPLACE FUNCTION ontos_migration.g20108_enforce_activation_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20108_activation_insert$
DECLARE
  release_state text;
BEGIN
  SELECT state INTO release_state
  FROM meta.releases
  WHERE release_id = NEW.release_id
  FOR UPDATE;
  IF release_state NOT IN ('ready', 'published', 'superseded') THEN
    RAISE EXCEPTION 'G20108_ACTIVATION_RELEASE_NOT_READY' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20108_activation_insert$;

CREATE OR REPLACE FUNCTION ontos_migration.g20108_assert_publication_integrity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20108_publication_integrity$
DECLARE
  affected_release_id uuid := NEW.release_id;
  release_state text;
BEGIN
  SELECT state INTO release_state FROM meta.releases WHERE release_id = affected_release_id;
  IF release_state IN ('published', 'superseded') AND NOT EXISTS (
    SELECT 1
    FROM meta.runtime_activations AS activation
    JOIN meta.release_serving_heads AS head
      ON head.release_id = activation.release_id
     AND head.activation_id = activation.activation_id
    WHERE activation.release_id = affected_release_id
  ) THEN
    RAISE EXCEPTION 'G20108_PUBLISHED_RELEASE_BINDING_INCOMPLETE' USING ERRCODE = '55000';
  END IF;
  IF release_state = 'published' AND NOT EXISTS (
    SELECT 1
    FROM meta.releases AS release
    JOIN meta.release_channels AS channel
      ON channel.project_id = release.project_id
     AND channel.channel_name = release.target_channel_name
     AND channel.release_id = release.release_id
    JOIN meta.release_serving_heads AS head
      ON head.release_id = channel.release_id
     AND head.activation_id = channel.activation_id
    WHERE release.release_id = affected_release_id
  ) THEN
    RAISE EXCEPTION 'G20108_PUBLISHED_RELEASE_CHANNEL_INCOMPLETE' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$g20108_publication_integrity$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA runtime
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON TABLE
  meta.release_runtime_plans,
  meta.release_runtime_plan_members,
  meta.runtime_activation_members
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON FUNCTION
  ontos_migration.g20203_reject_fact_mutation(),
  ontos_migration.g20203_enforce_lifecycle(),
  ontos_migration.g20203_validate_revision_bindings(),
  ontos_migration.g20203_runtime_plan_digest(uuid, uuid),
  ontos_migration.g20203_validate_runtime_plan(),
  ontos_migration.g20203_activation_digest(uuid, uuid),
  ontos_migration.g20203_validate_activation_members(),
  ontos_migration.g20203_validate_snapshot_files(),
  ontos_migration.g20203_validate_group_members(),
  ontos_migration.g20203_validate_report()
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
