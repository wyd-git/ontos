SET LOCAL ROLE migration_owner;

-- G2-03 preserves every G2-01 Principal as a human identity.  New service
-- identities must be explicit; a duplicate Issuer/Subject cannot be used to
-- manufacture a second identity with a different type.
ALTER TABLE authz.principals
  ADD COLUMN identity_type text NOT NULL DEFAULT 'human'
    CHECK (identity_type IN ('human', 'service'));

CREATE INDEX principals_type_state_idx
  ON authz.principals(identity_type, state, principal_id);

CREATE FUNCTION ontos_migration.g20303_enforce_principal_identity_type() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20303_principal_identity_type$
BEGIN
  IF NEW.identity_type IS DISTINCT FROM OLD.identity_type THEN
    RAISE EXCEPTION 'G20303_PRINCIPAL_IDENTITY_TYPE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20303_principal_identity_type$;

CREATE TRIGGER principals_identity_type_immutable
BEFORE UPDATE ON authz.principals
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20303_enforce_principal_identity_type();

-- G2-03-05 owns extraction of these edges.  The storage vocabulary is opened
-- now so Policy dependencies are deterministic facts rather than JSON scans.
ALTER TABLE meta.resource_dependencies
  DROP CONSTRAINT resource_dependencies_dependency_type_check,
  ADD CONSTRAINT resource_dependencies_dependency_type_ck CHECK (dependency_type IN (
    'property_reference', 'link_source', 'link_target',
    'policy_object_target', 'policy_property_target',
    'policy_link_target', 'policy_action_target'
  ));

-- G2-01 only activated Object Type and Link Type validation.  A Policy must
-- become a published, release-pinned Revision before it can be compiled, so
-- G2-03 activates a separate validator protocol without weakening the older
-- dependency checks.
CREATE OR REPLACE FUNCTION ontos_migration.g20106_enforce_revision_validation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20106_revision_validation$
DECLARE
  dependency_count integer;
  source_target uuid;
  target_target uuid;
  required_validator text;
BEGIN
  IF OLD.state <> 'draft' OR NEW.state <> 'validated' THEN RETURN NEW; END IF;

  IF NEW.family = 'policy' THEN
    required_validator := 'policy-g2-03-v1';
  ELSIF NEW.family IN ('object_type', 'link_type', 'snapshot_schema', 'mapping') THEN
    required_validator := 'metadata-g2-01-v1';
  ELSE
    RAISE EXCEPTION 'G20106_VALIDATOR_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM meta.validation_reports AS report
    WHERE report.subject_type = 'resource_revision'
      AND report.resource_revision_id = OLD.revision_id
      AND report.subject_digest = OLD.content_digest
      AND report.validator_version = required_validator
      AND report.valid = TRUE
  ) THEN
    RAISE EXCEPTION 'G20106_VALID_REPORT_REQUIRED' USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)::integer
  INTO dependency_count
  FROM meta.resource_dependencies
  WHERE source_revision_id = OLD.revision_id;

  IF NEW.family = 'policy' THEN
    IF dependency_count <> 0 THEN
      RAISE EXCEPTION 'G20303_POLICY_DEPENDENCIES_NOT_ACTIVE' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  SELECT target_revision_id
  INTO source_target
  FROM meta.resource_dependencies
  WHERE source_revision_id = OLD.revision_id
    AND dependency_type = 'link_source';

  SELECT target_revision_id
  INTO target_target
  FROM meta.resource_dependencies
  WHERE source_revision_id = OLD.revision_id
    AND dependency_type = 'link_target';

  IF NEW.family IN ('object_type', 'snapshot_schema', 'mapping') THEN
    IF dependency_count <> 0 THEN
      RAISE EXCEPTION 'G20106_RESOURCE_DEPENDENCIES_FORBIDDEN' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF dependency_count <> 2
      OR source_target IS DISTINCT FROM (NEW.content #>> '{source,objectTypeRevisionId}')::uuid
      OR target_target IS DISTINCT FROM (NEW.content #>> '{target,objectTypeRevisionId}')::uuid
      OR NOT EXISTS (
        SELECT 1 FROM meta.resource_dependencies
        WHERE source_revision_id = OLD.revision_id
          AND dependency_type = 'link_source'
          AND source_path = '/source/objectTypeRevisionId'
      )
      OR NOT EXISTS (
        SELECT 1 FROM meta.resource_dependencies
        WHERE source_revision_id = OLD.revision_id
          AND dependency_type = 'link_target'
          AND source_path = '/target/objectTypeRevisionId'
      ) THEN
      RAISE EXCEPTION 'G20106_DEPENDENCY_SET_INCOMPLETE' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$g20106_revision_validation$;

ALTER TABLE meta.release_pins
  ADD CONSTRAINT release_pins_revision_identity_uq
    UNIQUE (release_id, resource_id, revision_id);

ALTER TABLE meta.artifact_references
  ADD CONSTRAINT artifact_references_id_digest_uq
    UNIQUE (artifact_reference_id, digest);

-- A missing/invalid context produces no row under RLS.  Runtime roles do not
-- receive direct table privileges; this is additional Project isolation for
-- future repository grants, not the public authorization mechanism.
CREATE FUNCTION authz.g20303_project_context() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $g20303_project_context$
  SELECT CASE
    WHEN current_setting('ontos.project_id', true) ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN current_setting('ontos.project_id', true)::uuid
    ELSE NULL::uuid
  END
$g20303_project_context$;

CREATE TABLE authz.claim_mapping_revisions (
  project_id uuid NOT NULL,
  claim_mapping_revision_id uuid NOT NULL,
  oidc_issuer varchar(2048) NOT NULL CHECK (btrim(oidc_issuer) <> ''),
  identity_type text NOT NULL CHECK (identity_type IN ('human', 'service')),
  revision_number bigint NOT NULL CHECK (revision_number >= 1),
  mapping_digest varchar(71) NOT NULL
    CHECK (mapping_digest ~ '^sha256:[0-9a-f]{64}$'),
  mapping jsonb NOT NULL CHECK (
    jsonb_typeof(mapping) = 'object'
    AND pg_column_size(mapping) <= 262144
  ),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, claim_mapping_revision_id),
  CONSTRAINT claim_mapping_revisions_project_fk FOREIGN KEY (project_id)
    REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  CONSTRAINT claim_mapping_revisions_creator_fk FOREIGN KEY (created_by_principal_id)
    REFERENCES authz.principals(principal_id) ON DELETE RESTRICT,
  CONSTRAINT claim_mapping_revisions_number_uq
    UNIQUE (project_id, oidc_issuer, identity_type, revision_number),
  CONSTRAINT claim_mapping_revisions_digest_uq
    UNIQUE (project_id, oidc_issuer, identity_type, mapping_digest),
  CONSTRAINT claim_mapping_revisions_pointer_identity_uq
    UNIQUE (project_id, oidc_issuer, identity_type, claim_mapping_revision_id)
);

CREATE TABLE authz.claim_mapping_heads (
  project_id uuid NOT NULL,
  oidc_issuer varchar(2048) NOT NULL CHECK (btrim(oidc_issuer) <> ''),
  identity_type text NOT NULL CHECK (identity_type IN ('human', 'service')),
  claim_mapping_revision_id uuid NOT NULL,
  control_sequence bigint NOT NULL CHECK (control_sequence >= 1),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, oidc_issuer, identity_type),
  CONSTRAINT claim_mapping_heads_revision_fk FOREIGN KEY (
    project_id, oidc_issuer, identity_type, claim_mapping_revision_id
  ) REFERENCES authz.claim_mapping_revisions(
    project_id, oidc_issuer, identity_type, claim_mapping_revision_id
  ) ON DELETE RESTRICT
);

CREATE TABLE authz.policy_compilations (
  project_id uuid NOT NULL,
  policy_compilation_id uuid NOT NULL,
  release_id uuid NOT NULL,
  policy_resource_id uuid NOT NULL,
  policy_revision_id uuid NOT NULL,
  policy_content_digest varchar(71) NOT NULL
    CHECK (policy_content_digest ~ '^sha256:[0-9a-f]{64}$'),
  compiler_version varchar(64) NOT NULL
    CHECK (compiler_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  artifact_reference_id uuid NOT NULL,
  artifact_digest varchar(71) NOT NULL
    CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  test_report_reference_id uuid NOT NULL,
  test_report_digest varchar(71) NOT NULL
    CHECK (test_report_digest ~ '^sha256:[0-9a-f]{64}$'),
  test_vector_count integer NOT NULL CHECK (test_vector_count BETWEEN 1 AND 1000),
  passed_vector_count integer NOT NULL CHECK (passed_vector_count BETWEEN 0 AND 1000),
  failed_vector_count integer NOT NULL CHECK (failed_vector_count BETWEEN 0 AND 1000),
  status text NOT NULL CHECK (status IN ('passed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, policy_compilation_id),
  CONSTRAINT policy_compilations_project_fk FOREIGN KEY (project_id)
    REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  CONSTRAINT policy_compilations_release_fk FOREIGN KEY (project_id, release_id)
    REFERENCES meta.releases(project_id, release_id) ON DELETE RESTRICT,
  CONSTRAINT policy_compilations_resource_fk FOREIGN KEY (project_id, policy_resource_id)
    REFERENCES meta.resources(project_id, resource_id) ON DELETE RESTRICT,
  CONSTRAINT policy_compilations_revision_fk FOREIGN KEY (policy_resource_id, policy_revision_id)
    REFERENCES meta.resource_revisions(resource_id, revision_id) ON DELETE RESTRICT,
  CONSTRAINT policy_compilations_release_pin_fk FOREIGN KEY (
    release_id, policy_resource_id, policy_revision_id
  ) REFERENCES meta.release_pins(release_id, resource_id, revision_id) ON DELETE RESTRICT,
  CONSTRAINT policy_compilations_artifact_fk FOREIGN KEY (
    artifact_reference_id, artifact_digest
  ) REFERENCES meta.artifact_references(artifact_reference_id, digest) ON DELETE RESTRICT,
  CONSTRAINT policy_compilations_test_report_fk FOREIGN KEY (
    test_report_reference_id, test_report_digest
  ) REFERENCES meta.artifact_references(artifact_reference_id, digest) ON DELETE RESTRICT,
  CONSTRAINT policy_compilations_result_ck CHECK (
    passed_vector_count + failed_vector_count = test_vector_count
    AND (
      (status = 'passed' AND passed_vector_count = test_vector_count AND failed_vector_count = 0)
      OR (status = 'failed' AND failed_vector_count > 0)
    )
  ),
  CONSTRAINT policy_compilations_artifact_distinct_ck
    CHECK (artifact_reference_id <> test_report_reference_id),
  CONSTRAINT policy_compilations_input_uq UNIQUE (
    project_id, release_id, policy_revision_id, compiler_version
  ),
  CONSTRAINT policy_compilations_runtime_identity_uq UNIQUE (
    project_id, release_id, policy_compilation_id, artifact_digest, compiler_version
  )
);

CREATE INDEX claim_mapping_heads_revision_idx
  ON authz.claim_mapping_heads(project_id, claim_mapping_revision_id);
CREATE INDEX policy_compilations_runtime_lookup_idx
  ON authz.policy_compilations(project_id, release_id, policy_revision_id, status);

CREATE FUNCTION ontos_migration.g20303_reject_immutable_fact() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20303_reject_immutable_fact$
BEGIN
  RAISE EXCEPTION 'G20303_IMMUTABLE_FACT:%', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$g20303_reject_immutable_fact$;

CREATE FUNCTION ontos_migration.g20303_enforce_claim_mapping_head() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20303_claim_mapping_head$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.oidc_issuer IS DISTINCT FROM OLD.oidc_issuer
    OR NEW.identity_type IS DISTINCT FROM OLD.identity_type THEN
    RAISE EXCEPTION 'G20303_CLAIM_MAPPING_HEAD_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.claim_mapping_revision_id IS NOT DISTINCT FROM OLD.claim_mapping_revision_id
    OR NEW.control_sequence <> OLD.control_sequence + 1
    OR NEW.changed_at <= OLD.changed_at THEN
    RAISE EXCEPTION 'G20303_CLAIM_MAPPING_HEAD_TRANSITION_INVALID' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$g20303_claim_mapping_head$;

CREATE FUNCTION ontos_migration.g20303_enforce_policy_compilation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20303_policy_compilation$
DECLARE
  revision_family text;
  revision_digest text;
  artifact_source_kind text;
  artifact_source_id uuid;
  report_source_kind text;
  report_source_id uuid;
BEGIN
  SELECT revision.family, revision.content_digest
    INTO revision_family, revision_digest
  FROM meta.resource_revisions AS revision
  WHERE revision.resource_id = NEW.policy_resource_id
    AND revision.revision_id = NEW.policy_revision_id;
  IF revision_family IS DISTINCT FROM 'policy'
    OR revision_digest IS DISTINCT FROM NEW.policy_content_digest THEN
    RAISE EXCEPTION 'G20303_POLICY_REVISION_BINDING_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT reference.source_kind, reference.source_id
    INTO artifact_source_kind, artifact_source_id
  FROM meta.artifact_references AS reference
  WHERE reference.artifact_reference_id = NEW.artifact_reference_id
    AND reference.digest = NEW.artifact_digest;
  SELECT reference.source_kind, reference.source_id
    INTO report_source_kind, report_source_id
  FROM meta.artifact_references AS reference
  WHERE reference.artifact_reference_id = NEW.test_report_reference_id
    AND reference.digest = NEW.test_report_digest;
  IF artifact_source_kind IS DISTINCT FROM 'policy_compilation'
    OR artifact_source_id IS DISTINCT FROM NEW.policy_compilation_id
    OR report_source_kind IS DISTINCT FROM 'policy_test_report'
    OR report_source_id IS DISTINCT FROM NEW.policy_compilation_id THEN
    RAISE EXCEPTION 'G20303_POLICY_ARTIFACT_SOURCE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$g20303_policy_compilation$;

CREATE TRIGGER claim_mapping_revisions_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON authz.claim_mapping_revisions
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20303_reject_immutable_fact();
CREATE TRIGGER claim_mapping_heads_controlled_update
BEFORE UPDATE ON authz.claim_mapping_heads
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20303_enforce_claim_mapping_head();
CREATE TRIGGER claim_mapping_heads_no_delete
BEFORE DELETE OR TRUNCATE ON authz.claim_mapping_heads
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20303_reject_immutable_fact();
CREATE TRIGGER policy_compilations_insert_guard
BEFORE INSERT ON authz.policy_compilations
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20303_enforce_policy_compilation();
CREATE TRIGGER policy_compilations_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON authz.policy_compilations
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20303_reject_immutable_fact();

ALTER TABLE authz.claim_mapping_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE authz.claim_mapping_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE authz.claim_mapping_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE authz.claim_mapping_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE authz.policy_compilations ENABLE ROW LEVEL SECURITY;
ALTER TABLE authz.policy_compilations FORCE ROW LEVEL SECURITY;

CREATE POLICY claim_mapping_revisions_project_isolation
  ON authz.claim_mapping_revisions
  USING (current_user = 'migration_owner' OR project_id = authz.g20303_project_context())
  WITH CHECK (current_user = 'migration_owner' OR project_id = authz.g20303_project_context());
CREATE POLICY claim_mapping_heads_project_isolation
  ON authz.claim_mapping_heads
  USING (current_user = 'migration_owner' OR project_id = authz.g20303_project_context())
  WITH CHECK (current_user = 'migration_owner' OR project_id = authz.g20303_project_context());
CREATE POLICY policy_compilations_project_isolation
  ON authz.policy_compilations
  USING (current_user = 'migration_owner' OR project_id = authz.g20303_project_context())
  WITH CHECK (current_user = 'migration_owner' OR project_id = authz.g20303_project_context());

REVOKE ALL PRIVILEGES ON TABLE
  authz.claim_mapping_revisions,
  authz.claim_mapping_heads,
  authz.policy_compilations
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON FUNCTION
  authz.g20303_project_context(),
  ontos_migration.g20303_enforce_principal_identity_type(),
  ontos_migration.g20303_reject_immutable_fact(),
  ontos_migration.g20303_enforce_claim_mapping_head(),
  ontos_migration.g20303_enforce_policy_compilation()
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT EXECUTE ON FUNCTION authz.g20303_project_context()
TO api_runtime;

COMMENT ON COLUMN authz.principals.identity_type IS
  'Server-owned immutable Runtime identity type; pre-G2-03 Principals are human.';
COMMENT ON TABLE authz.claim_mapping_revisions IS
  'Immutable, bounded, versioned OIDC claim mapping facts; activation is separate.';
COMMENT ON TABLE authz.policy_compilations IS
  'Immutable Policy compiler and test result bound to a Project, Release and pinned Policy Revision.';
