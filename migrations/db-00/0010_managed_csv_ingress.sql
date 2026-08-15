SET LOCAL ROLE migration_owner;

-- Registered Snapshot files carry only immutable managed-storage facts. Existing
-- DB-02 rows predate the ingress API and receive an explicit non-user label.
ALTER TABLE runtime.snapshot_files
  ADD COLUMN source_label varchar(128) NOT NULL DEFAULT 'legacy-managed-snapshot'
    CHECK (
      octet_length(source_label) BETWEEN 1 AND 128
      AND source_label !~ '[[:cntrl:]]'
      AND position('/' IN source_label) = 0
      AND position(E'\\' IN source_label) = 0
    ),
  ADD COLUMN scan_status text NOT NULL DEFAULT 'complete'
    CHECK (scan_status = 'complete');

ALTER TABLE runtime.snapshot_files
  ALTER COLUMN source_label DROP DEFAULT,
  ALTER COLUMN scan_status DROP DEFAULT;

CREATE TABLE runtime.snapshot_upload_sessions (
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  created_by_principal_id uuid NOT NULL,
  release_id uuid NOT NULL,
  snapshot_group_id uuid NOT NULL,
  group_version bigint NOT NULL CHECK (group_version >= 1),
  group_member_count integer NOT NULL CHECK (group_member_count BETWEEN 1 AND 256),
  member_key varchar(70) NOT NULL
    CHECK (member_key ~ '^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$'),
  member_kind text NOT NULL CHECK (member_kind IN ('object', 'link')),
  target_resource_id uuid NOT NULL,
  target_revision_id uuid NOT NULL,
  snapshot_schema_resource_id uuid NOT NULL,
  snapshot_schema_revision_id uuid NOT NULL,
  mapping_resource_id uuid NOT NULL,
  mapping_revision_id uuid NOT NULL,
  index_plan_digest varchar(71) NOT NULL
    CHECK (index_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  runtime_plan_digest varchar(71) NOT NULL
    CHECK (runtime_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  managed_artifact_id uuid NOT NULL,
  object_key varchar(128) NOT NULL
    CHECK (object_key ~ '^ingress/[0-9a-f]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]csv$'),
  allowed_media_type text NOT NULL CHECK (allowed_media_type = 'text/csv'),
  expected_byte_count bigint NOT NULL CHECK (
    expected_byte_count BETWEEN 1 AND 536870912
  ),
  max_byte_count bigint NOT NULL CHECK (
    max_byte_count BETWEEN 1 AND 536870912
    AND expected_byte_count <= max_byte_count
  ),
  source_label varchar(128) NOT NULL CHECK (
    octet_length(source_label) BETWEEN 1 AND 128
    AND source_label !~ '[[:cntrl:]]'
    AND position('/' IN source_label) = 0
    AND position(E'\\' IN source_label) = 0
  ),
  finalize_token_digest varchar(71) NOT NULL
    CHECK (finalize_token_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'created' CHECK (state IN (
    'created', 'uploaded', 'finalizing', 'finalized', 'failed', 'expired', 'cleaned'
  )),
  uploaded_object_version varchar(1024),
  uploaded_byte_count bigint CHECK (uploaded_byte_count >= 0),
  finalize_claim_id uuid,
  finalize_lease_expires_at timestamptz,
  snapshot_id uuid,
  object_cleanup_completed_at timestamptz,
  failure_code varchar(64) CHECK (failure_code IN (
    'SESSION_EXPIRED', 'UPLOAD_ABORTED', 'SNAPSHOT_SCHEMA_INVALID',
    'SNAPSHOT_CONTENT_MISMATCH', 'DEPENDENCY_UNAVAILABLE'
  )),
  expires_at timestamptz NOT NULL,
  cleanup_after timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, session_id),
  CONSTRAINT snapshot_upload_sessions_member_prefix_ck
    CHECK (split_part(member_key, ':', 1) = member_kind),
  CONSTRAINT snapshot_upload_sessions_lifetime_ck CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '15 minutes'
    AND cleanup_after >= expires_at
    AND cleanup_after <= expires_at + interval '24 hours'
  ),
  CONSTRAINT snapshot_upload_sessions_upload_pair_ck CHECK (
    (uploaded_object_version IS NULL) = (uploaded_byte_count IS NULL)
  ),
  CONSTRAINT snapshot_upload_sessions_state_facts_ck CHECK (
    (state = 'created'
      AND uploaded_object_version IS NULL
      AND finalize_claim_id IS NULL AND finalize_lease_expires_at IS NULL
      AND snapshot_id IS NULL AND failure_code IS NULL
      AND object_cleanup_completed_at IS NULL)
    OR (state = 'uploaded'
      AND uploaded_object_version IS NOT NULL
      AND uploaded_byte_count = expected_byte_count
      AND finalize_claim_id IS NULL AND finalize_lease_expires_at IS NULL
      AND snapshot_id IS NULL AND failure_code IS NULL
      AND object_cleanup_completed_at IS NULL)
    OR (state = 'finalizing'
      AND uploaded_object_version IS NOT NULL
      AND uploaded_byte_count = expected_byte_count
      AND finalize_claim_id IS NOT NULL AND finalize_lease_expires_at IS NOT NULL
      AND finalize_lease_expires_at > changed_at
      AND finalize_lease_expires_at <= changed_at + interval '5 minutes'
      AND snapshot_id IS NULL AND failure_code IS NULL
      AND object_cleanup_completed_at IS NULL)
    OR (state = 'finalized'
      AND uploaded_object_version IS NOT NULL
      AND uploaded_byte_count = expected_byte_count
      AND finalize_claim_id IS NULL AND finalize_lease_expires_at IS NULL
      AND snapshot_id IS NOT NULL AND failure_code IS NULL)
    OR (state IN ('failed', 'expired')
      AND finalize_claim_id IS NULL AND finalize_lease_expires_at IS NULL
      AND snapshot_id IS NULL AND failure_code IS NOT NULL
      AND object_cleanup_completed_at IS NULL)
    OR (state = 'cleaned'
      AND finalize_claim_id IS NULL AND finalize_lease_expires_at IS NULL
      AND snapshot_id IS NULL AND failure_code IS NOT NULL
      AND object_cleanup_completed_at IS NOT NULL)
  ),
  CONSTRAINT snapshot_upload_sessions_project_fk FOREIGN KEY (project_id)
    REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  CONSTRAINT snapshot_upload_sessions_principal_fk FOREIGN KEY (created_by_principal_id)
    REFERENCES authz.principals(principal_id) ON DELETE RESTRICT,
  CONSTRAINT snapshot_upload_sessions_release_fk FOREIGN KEY (project_id, release_id)
    REFERENCES meta.releases(project_id, release_id) ON DELETE RESTRICT,
  CONSTRAINT snapshot_upload_sessions_group_fk FOREIGN KEY (project_id, snapshot_group_id)
    REFERENCES runtime.snapshot_groups(project_id, snapshot_group_id) ON DELETE RESTRICT,
  CONSTRAINT snapshot_upload_sessions_plan_member_fk FOREIGN KEY (
    project_id, release_id, member_key, target_resource_id, target_revision_id,
    snapshot_schema_resource_id, snapshot_schema_revision_id,
    mapping_resource_id, mapping_revision_id, snapshot_group_id,
    index_plan_digest, runtime_plan_digest
  ) REFERENCES meta.release_runtime_plan_members (
    project_id, release_id, member_key, target_resource_id, target_revision_id,
    snapshot_schema_resource_id, snapshot_schema_revision_id,
    mapping_resource_id, mapping_revision_id, snapshot_group_id,
    index_plan_digest, runtime_plan_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT snapshot_upload_sessions_snapshot_fk FOREIGN KEY (project_id, snapshot_id)
    REFERENCES runtime.dataset_snapshots(project_id, snapshot_id) ON DELETE RESTRICT,
  CONSTRAINT snapshot_upload_sessions_object_key_uq UNIQUE (object_key),
  CONSTRAINT snapshot_upload_sessions_session_uq UNIQUE (session_id),
  CONSTRAINT snapshot_upload_sessions_artifact_uq UNIQUE (project_id, managed_artifact_id),
  CONSTRAINT snapshot_upload_sessions_snapshot_uq UNIQUE (project_id, snapshot_id)
);

CREATE INDEX snapshot_upload_sessions_cleanup_idx
  ON runtime.snapshot_upload_sessions (cleanup_after, project_id, session_id)
  WHERE state IN ('created', 'uploaded', 'failed', 'expired');

CREATE INDEX snapshot_upload_sessions_group_idx
  ON runtime.snapshot_upload_sessions (
    project_id, release_id, snapshot_group_id, group_version, member_key
  );

CREATE FUNCTION ontos_migration.g20204_validate_upload_session_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20204_validate_upload_session_insert$
DECLARE
  expected_group_version bigint;
  expected_member_count integer;
  schema_content jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM meta.releases AS release
    WHERE release.project_id = NEW.project_id
      AND release.release_id = NEW.release_id
      AND release.state IN ('ready', 'published')
  ) THEN
    RAISE EXCEPTION 'G20204_RELEASE_NOT_INGRESS_ELIGIBLE' USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM runtime.snapshot_groups AS snapshot_group
  WHERE snapshot_group.project_id = NEW.project_id
    AND snapshot_group.snapshot_group_id = NEW.snapshot_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20204_SNAPSHOT_GROUP_NOT_FOUND' USING ERRCODE = '23503';
  END IF;

  SELECT COALESCE(max(group_version), 0) + 1
  INTO expected_group_version
  FROM runtime.snapshot_group_versions
  WHERE project_id = NEW.project_id AND snapshot_group_id = NEW.snapshot_group_id;
  IF NEW.group_version <> expected_group_version THEN
    RAISE EXCEPTION 'G20204_GROUP_VERSION_NOT_NEXT' USING ERRCODE = '40001';
  END IF;

  SELECT count(*)::integer INTO expected_member_count
  FROM meta.release_runtime_plan_members
  WHERE project_id = NEW.project_id AND release_id = NEW.release_id
    AND snapshot_group_id = NEW.snapshot_group_id;
  IF NEW.group_member_count <> expected_member_count OR expected_member_count = 0 THEN
    RAISE EXCEPTION 'G20204_GROUP_MEMBER_COUNT_MISMATCH' USING ERRCODE = '23514';
  END IF;

  SELECT revision.content INTO schema_content
  FROM meta.resource_revisions AS revision
  WHERE revision.resource_id = NEW.snapshot_schema_resource_id
    AND revision.revision_id = NEW.snapshot_schema_revision_id
    AND revision.family = 'snapshot_schema';
  IF NOT FOUND
    OR schema_content #>> '{format}' <> 'csv_utf8'
    OR schema_content #>> '{headerRow}' <> 'true'
    OR jsonb_typeof(schema_content -> 'columns') <> 'array'
    OR jsonb_array_length(schema_content -> 'columns') NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'G20204_SNAPSHOT_SCHEMA_NOT_MANAGED_CSV' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$g20204_validate_upload_session_insert$;

CREATE FUNCTION ontos_migration.g20204_enforce_upload_session_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20204_enforce_upload_session_update$
DECLARE
  registered_file runtime.snapshot_files%ROWTYPE;
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
    OR NEW.release_id IS DISTINCT FROM OLD.release_id
    OR NEW.snapshot_group_id IS DISTINCT FROM OLD.snapshot_group_id
    OR NEW.group_version IS DISTINCT FROM OLD.group_version
    OR NEW.group_member_count IS DISTINCT FROM OLD.group_member_count
    OR NEW.member_key IS DISTINCT FROM OLD.member_key
    OR NEW.member_kind IS DISTINCT FROM OLD.member_kind
    OR NEW.target_resource_id IS DISTINCT FROM OLD.target_resource_id
    OR NEW.target_revision_id IS DISTINCT FROM OLD.target_revision_id
    OR NEW.snapshot_schema_resource_id IS DISTINCT FROM OLD.snapshot_schema_resource_id
    OR NEW.snapshot_schema_revision_id IS DISTINCT FROM OLD.snapshot_schema_revision_id
    OR NEW.mapping_resource_id IS DISTINCT FROM OLD.mapping_resource_id
    OR NEW.mapping_revision_id IS DISTINCT FROM OLD.mapping_revision_id
    OR NEW.index_plan_digest IS DISTINCT FROM OLD.index_plan_digest
    OR NEW.runtime_plan_digest IS DISTINCT FROM OLD.runtime_plan_digest
    OR NEW.managed_artifact_id IS DISTINCT FROM OLD.managed_artifact_id
    OR NEW.object_key IS DISTINCT FROM OLD.object_key
    OR NEW.allowed_media_type IS DISTINCT FROM OLD.allowed_media_type
    OR NEW.expected_byte_count IS DISTINCT FROM OLD.expected_byte_count
    OR NEW.max_byte_count IS DISTINCT FROM OLD.max_byte_count
    OR NEW.source_label IS DISTINCT FROM OLD.source_label
    OR NEW.finalize_token_digest IS DISTINCT FROM OLD.finalize_token_digest
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.cleanup_after IS DISTINCT FROM OLD.cleanup_after
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'G20204_UPLOAD_SESSION_FACT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF NEW.changed_at < OLD.changed_at THEN
    RAISE EXCEPTION 'G20204_UPLOAD_SESSION_TIME_REVERSED' USING ERRCODE = '22007';
  END IF;

  IF OLD.uploaded_object_version IS NOT NULL
    AND (NEW.uploaded_object_version IS DISTINCT FROM OLD.uploaded_object_version
      OR NEW.uploaded_byte_count IS DISTINCT FROM OLD.uploaded_byte_count) THEN
    RAISE EXCEPTION 'G20204_UPLOADED_VERSION_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id THEN
    RAISE EXCEPTION 'G20204_FINALIZED_SNAPSHOT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD.failure_code IS NOT NULL AND NEW.failure_code IS DISTINCT FROM OLD.failure_code THEN
    RAISE EXCEPTION 'G20204_FAILURE_CODE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF NOT (
    (OLD.state = 'created' AND NEW.state IN ('uploaded', 'failed', 'expired'))
    OR (OLD.state = 'uploaded' AND NEW.state IN ('finalizing', 'failed', 'expired'))
    OR (OLD.state = 'finalizing' AND NEW.state = 'finalizing'
      AND NEW.finalize_claim_id IS NOT DISTINCT FROM OLD.finalize_claim_id
      AND NEW.finalize_lease_expires_at >= OLD.finalize_lease_expires_at
      AND NEW.snapshot_id IS NOT DISTINCT FROM OLD.snapshot_id
      AND NEW.failure_code IS NOT DISTINCT FROM OLD.failure_code
      AND NEW.object_cleanup_completed_at IS NOT DISTINCT FROM OLD.object_cleanup_completed_at)
    OR (OLD.state = 'finalizing' AND NEW.state IN ('uploaded', 'finalized', 'failed', 'expired'))
    OR (OLD.state IN ('failed', 'expired') AND NEW.state = 'cleaned')
    OR (OLD.state = 'finalized' AND NEW.state = 'finalized'
      AND OLD.object_cleanup_completed_at IS NULL
      AND NEW.object_cleanup_completed_at IS NOT NULL
      AND NEW.uploaded_object_version IS NOT DISTINCT FROM OLD.uploaded_object_version
      AND NEW.uploaded_byte_count IS NOT DISTINCT FROM OLD.uploaded_byte_count
      AND NEW.finalize_claim_id IS NOT DISTINCT FROM OLD.finalize_claim_id
      AND NEW.finalize_lease_expires_at IS NOT DISTINCT FROM OLD.finalize_lease_expires_at
      AND NEW.snapshot_id IS NOT DISTINCT FROM OLD.snapshot_id
      AND NEW.failure_code IS NOT DISTINCT FROM OLD.failure_code)
  ) THEN
    RAISE EXCEPTION 'G20204_UPLOAD_SESSION_TRANSITION_INVALID:%:%', OLD.state, NEW.state
      USING ERRCODE = '55000';
  END IF;

  IF OLD.state = 'created' AND NEW.state = 'uploaded'
    AND clock_timestamp() >= OLD.expires_at THEN
    RAISE EXCEPTION 'G20204_UPLOAD_SESSION_EXPIRED' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'uploaded' AND NEW.state = 'finalizing'
    AND clock_timestamp() >= OLD.expires_at THEN
    RAISE EXCEPTION 'G20204_UPLOAD_SESSION_EXPIRED' USING ERRCODE = '55000';
  END IF;

  IF NEW.state = 'finalized' THEN
    SELECT file.* INTO registered_file
    FROM runtime.snapshot_files AS file
    JOIN runtime.dataset_snapshots AS snapshot
      ON snapshot.project_id = file.project_id AND snapshot.snapshot_id = file.snapshot_id
    WHERE file.project_id = NEW.project_id
      AND file.snapshot_id = NEW.snapshot_id
      AND file.managed_artifact_id = NEW.managed_artifact_id
      AND file.object_version = NEW.uploaded_object_version
      AND file.source_label = NEW.source_label
      AND file.scan_status = 'complete'
      AND snapshot.snapshot_group_id = NEW.snapshot_group_id
      AND snapshot.group_version = NEW.group_version
      AND snapshot.member_key = NEW.member_key
      AND snapshot.target_revision_id = NEW.target_revision_id
      AND snapshot.snapshot_schema_revision_id = NEW.snapshot_schema_revision_id
      AND snapshot.mapping_revision_id = NEW.mapping_revision_id
      AND snapshot.runtime_plan_digest = NEW.runtime_plan_digest;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'G20204_FINALIZED_SNAPSHOT_BINDING_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$g20204_enforce_upload_session_update$;

CREATE FUNCTION ontos_migration.g20204_reject_upload_session_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20204_reject_upload_session_delete$
BEGIN
  RAISE EXCEPTION 'G20204_UPLOAD_SESSION_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
END
$g20204_reject_upload_session_delete$;

CREATE TRIGGER snapshot_upload_sessions_validate_insert
BEFORE INSERT ON runtime.snapshot_upload_sessions
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20204_validate_upload_session_insert();

CREATE TRIGGER snapshot_upload_sessions_controlled_update
BEFORE UPDATE ON runtime.snapshot_upload_sessions
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20204_enforce_upload_session_update();

CREATE TRIGGER snapshot_upload_sessions_no_delete
BEFORE DELETE OR TRUNCATE ON runtime.snapshot_upload_sessions
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20204_reject_upload_session_delete();

CREATE VIEW ops.snapshot_ingress_status WITH (security_barrier = true) AS
SELECT project_id, session_id, release_id, snapshot_group_id, group_version,
       group_member_count, member_key, allowed_media_type, expected_byte_count,
       uploaded_byte_count, state, failure_code, expires_at, cleanup_after,
       object_cleanup_completed_at IS NOT NULL AS object_cleanup_complete,
       created_at, changed_at
FROM runtime.snapshot_upload_sessions;

REVOKE ALL PRIVILEGES ON TABLE runtime.snapshot_upload_sessions
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE INSERT ON TABLE runtime.snapshot_files FROM api_runtime;
REVOKE ALL PRIVILEGES ON TABLE ops.snapshot_ingress_status
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON FUNCTION
  ontos_migration.g20204_validate_upload_session_insert(),
  ontos_migration.g20204_enforce_upload_session_update(),
  ontos_migration.g20204_reject_upload_session_delete()
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT SELECT ON TABLE runtime.snapshot_upload_sessions TO api_runtime;
GRANT INSERT (
  project_id, session_id, created_by_principal_id, release_id,
  snapshot_group_id, group_version, group_member_count, member_key, member_kind,
  target_resource_id, target_revision_id,
  snapshot_schema_resource_id, snapshot_schema_revision_id,
  mapping_resource_id, mapping_revision_id, index_plan_digest, runtime_plan_digest,
  managed_artifact_id, object_key, allowed_media_type,
  expected_byte_count, max_byte_count, source_label, finalize_token_digest,
  expires_at, cleanup_after
) ON runtime.snapshot_upload_sessions TO api_runtime;
GRANT UPDATE (
  state, uploaded_object_version, uploaded_byte_count,
  finalize_claim_id, finalize_lease_expires_at,
  snapshot_id, object_cleanup_completed_at, failure_code, changed_at
) ON runtime.snapshot_upload_sessions TO api_runtime;

GRANT INSERT (
  project_id, snapshot_id, file_id, managed_artifact_id, object_version,
  ordinal, content_digest, byte_count, row_count, source_label, scan_status
) ON runtime.snapshot_files TO api_runtime;

GRANT SELECT ON TABLE ops.snapshot_ingress_status TO read_only_ops;
