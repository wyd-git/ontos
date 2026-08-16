SET LOCAL ROLE migration_owner;

-- A Snapshot Group definition binds stable Mapping resources. Release staging resolves
-- the exact Mapping revisions from immutable Release pins; the Stage request never owns
-- a Runtime member list or Runtime Plan digest.
ALTER TABLE runtime.snapshot_groups
  ADD COLUMN definition_member_count integer NOT NULL DEFAULT 0
    CHECK (definition_member_count BETWEEN 0 AND 256);

CREATE TABLE runtime.snapshot_group_definition_members (
  project_id uuid NOT NULL,
  snapshot_group_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 255),
  mapping_resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, snapshot_group_id, mapping_resource_id),
  CONSTRAINT snapshot_group_definition_members_ordinal_uq
    UNIQUE (project_id, snapshot_group_id, ordinal),
  CONSTRAINT snapshot_group_definition_members_mapping_uq
    UNIQUE (project_id, mapping_resource_id),
  CONSTRAINT snapshot_group_definition_members_group_fk
    FOREIGN KEY (project_id, snapshot_group_id)
    REFERENCES runtime.snapshot_groups(project_id, snapshot_group_id) ON DELETE RESTRICT,
  CONSTRAINT snapshot_group_definition_members_mapping_fk
    FOREIGN KEY (project_id, mapping_resource_id)
    REFERENCES meta.resources(project_id, resource_id) ON DELETE RESTRICT
);

CREATE FUNCTION ontos_migration.g20210_validate_group_definition_member() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20210_validate_group_definition_member$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM meta.resources AS resource
    WHERE resource.project_id = NEW.project_id
      AND resource.resource_id = NEW.mapping_resource_id
      AND resource.family = 'mapping'
      AND resource.state <> 'archived'
  ) THEN
    RAISE EXCEPTION 'G20210_GROUP_MAPPING_RESOURCE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$g20210_validate_group_definition_member$;

CREATE TRIGGER snapshot_group_definition_members_validate
BEFORE INSERT ON runtime.snapshot_group_definition_members
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20210_validate_group_definition_member();
CREATE TRIGGER snapshot_group_definition_members_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.snapshot_group_definition_members
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();

CREATE FUNCTION ontos_migration.g20210_validate_group_definition_complete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20210_validate_group_definition_complete$
DECLARE
  affected_project_id uuid := COALESCE(NEW.project_id, OLD.project_id);
  affected_group_id uuid := COALESCE(NEW.snapshot_group_id, OLD.snapshot_group_id);
  expected_count integer;
  actual_count integer;
BEGIN
  SELECT definition_member_count INTO expected_count
  FROM runtime.snapshot_groups
  WHERE project_id = affected_project_id AND snapshot_group_id = affected_group_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*)::integer INTO actual_count
  FROM runtime.snapshot_group_definition_members
  WHERE project_id = affected_project_id AND snapshot_group_id = affected_group_id;
  IF actual_count <> expected_count THEN
    RAISE EXCEPTION 'G20210_GROUP_DEFINITION_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$g20210_validate_group_definition_complete$;

CREATE CONSTRAINT TRIGGER snapshot_groups_definition_complete
AFTER INSERT ON runtime.snapshot_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20210_validate_group_definition_complete();
CREATE CONSTRAINT TRIGGER snapshot_group_definition_members_complete
AFTER INSERT ON runtime.snapshot_group_definition_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20210_validate_group_definition_complete();

-- Runtime Plans are Stage facts, not a second caller-controlled Release manifest. Besides
-- restricting the lifecycle point, this guard independently proves that every stored member
-- is the exact result of a pinned Mapping and a server-owned Snapshot Group definition.
CREATE FUNCTION ontos_migration.g20210_validate_runtime_plan_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20210_validate_runtime_plan_insert$
DECLARE
  release_state text;
  mapping_content jsonb;
  target_api_name text;
BEGIN
  SELECT release.state INTO release_state
  FROM meta.releases AS release
  WHERE release.project_id = NEW.project_id AND release.release_id = NEW.release_id
  FOR SHARE;
  IF NOT FOUND OR release_state NOT IN ('draft', 'staging') THEN
    RAISE EXCEPTION 'G20210_RUNTIME_PLAN_STAGE_ONLY' USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'release_runtime_plan_members' THEN
    SELECT revision.content INTO mapping_content
    FROM meta.release_pins AS pin
    JOIN meta.resource_revisions AS revision
      ON revision.resource_id = pin.resource_id
     AND revision.revision_id = pin.revision_id
     AND revision.state IN ('validated', 'published')
    WHERE pin.release_id = NEW.release_id
      AND pin.resource_id = NEW.mapping_resource_id
      AND pin.revision_id = NEW.mapping_revision_id
      AND pin.family = 'mapping';
    IF NOT FOUND
      OR mapping_content->>'targetKind' IS DISTINCT FROM NEW.member_kind
      OR mapping_content->>'targetResourceId' IS DISTINCT FROM NEW.target_resource_id::text
      OR mapping_content->>'targetRevisionId' IS DISTINCT FROM NEW.target_revision_id::text
      OR mapping_content->>'inputSchemaRevisionId'
           IS DISTINCT FROM NEW.snapshot_schema_revision_id::text THEN
      RAISE EXCEPTION 'G20210_RUNTIME_PLAN_NOT_SERVER_DERIVED' USING ERRCODE = '23514';
    END IF;

    SELECT resource.api_name INTO target_api_name
    FROM meta.release_pins AS pin
    JOIN meta.resources AS resource
      ON resource.resource_id = pin.resource_id
     AND resource.project_id = NEW.project_id
    JOIN meta.resource_revisions AS revision
      ON revision.resource_id = pin.resource_id
     AND revision.revision_id = pin.revision_id
     AND revision.state IN ('validated', 'published')
    WHERE pin.release_id = NEW.release_id
      AND pin.resource_id = NEW.target_resource_id
      AND pin.revision_id = NEW.target_revision_id
      AND pin.family = CASE NEW.member_kind
        WHEN 'object' THEN 'object_type'
        WHEN 'link' THEN 'link_type'
      END;
    IF NOT FOUND OR NEW.member_key IS DISTINCT FROM NEW.member_kind || ':' || target_api_name THEN
      RAISE EXCEPTION 'G20210_RUNTIME_PLAN_NOT_SERVER_DERIVED' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM meta.release_pins AS pin
      JOIN meta.resource_revisions AS revision
        ON revision.resource_id = pin.resource_id
       AND revision.revision_id = pin.revision_id
       AND revision.state IN ('validated', 'published')
      WHERE pin.release_id = NEW.release_id
        AND pin.resource_id = NEW.snapshot_schema_resource_id
        AND pin.revision_id = NEW.snapshot_schema_revision_id
        AND pin.family = 'snapshot_schema'
    ) OR NOT EXISTS (
      SELECT 1
      FROM runtime.snapshot_group_definition_members AS definition
      WHERE definition.project_id = NEW.project_id
        AND definition.snapshot_group_id = NEW.snapshot_group_id
        AND definition.mapping_resource_id = NEW.mapping_resource_id
    ) THEN
      RAISE EXCEPTION 'G20210_RUNTIME_PLAN_NOT_SERVER_DERIVED' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM runtime.index_plans AS plan
      WHERE plan.project_id = NEW.project_id
        AND plan.target_resource_id = NEW.target_resource_id
        AND plan.target_revision_id = NEW.target_revision_id
        AND plan.plan_digest = NEW.index_plan_digest
        AND (
          (
            NEW.member_kind = 'link'
            AND plan.entry_count = 0
            AND plan.compiler_version = 'g2-02-10-link-index-v1'
          )
          OR EXISTS (
            SELECT 1
            FROM runtime.index_plan_admissions AS admission
            JOIN runtime.project_runtime_inventories AS inventory
              ON inventory.project_id = admission.project_id
             AND inventory.inventory_revision = admission.inventory_revision
             AND inventory.measurement_complete
            WHERE admission.project_id = NEW.project_id
              AND admission.release_id = NEW.release_id
              AND admission.index_plan_id = plan.index_plan_id
              AND (
                admission.approval_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM runtime.capacity_approvals AS approval
                  WHERE approval.project_id = admission.project_id
                    AND approval.approval_id = admission.approval_id
                    AND approval.state = 'active'
                    AND approval.expires_at = admission.approval_expires_at
                    AND approval.expires_at > clock_timestamp()
                )
              )
          )
        )
    ) THEN
      RAISE EXCEPTION 'G20210_RUNTIME_PLAN_INDEX_NOT_ADMITTED' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$g20210_validate_runtime_plan_insert$;

CREATE TRIGGER release_runtime_plans_stage_only
BEFORE INSERT ON meta.release_runtime_plans
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20210_validate_runtime_plan_insert();
CREATE TRIGGER release_runtime_plan_members_server_derived
BEFORE INSERT ON meta.release_runtime_plan_members
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20210_validate_runtime_plan_insert();

CREATE FUNCTION ontos_migration.g20210_validate_runtime_plan_groups() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20210_validate_runtime_plan_groups$
DECLARE
  affected_release_id uuid := COALESCE(NEW.release_id, OLD.release_id);
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT member.project_id, member.snapshot_group_id,
             count(*)::integer AS actual_count
      FROM meta.release_runtime_plan_members AS member
      WHERE member.release_id = affected_release_id
      GROUP BY member.project_id, member.snapshot_group_id
    ) AS actual
    JOIN runtime.snapshot_groups AS snapshot_group
      ON snapshot_group.project_id = actual.project_id
     AND snapshot_group.snapshot_group_id = actual.snapshot_group_id
    WHERE actual.actual_count <> snapshot_group.definition_member_count
       OR EXISTS (
         SELECT 1
         FROM runtime.snapshot_group_definition_members AS definition
         WHERE definition.project_id = actual.project_id
           AND definition.snapshot_group_id = actual.snapshot_group_id
           AND NOT EXISTS (
             SELECT 1
             FROM meta.release_runtime_plan_members AS member
             WHERE member.release_id = affected_release_id
               AND member.snapshot_group_id = actual.snapshot_group_id
               AND member.mapping_resource_id = definition.mapping_resource_id
           )
       )
  ) THEN
    RAISE EXCEPTION 'G20210_RUNTIME_PLAN_GROUP_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$g20210_validate_runtime_plan_groups$;

CREATE CONSTRAINT TRIGGER release_runtime_plans_groups_complete
AFTER INSERT ON meta.release_runtime_plans
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20210_validate_runtime_plan_groups();
CREATE CONSTRAINT TRIGGER release_runtime_plan_members_groups_complete
AFTER INSERT ON meta.release_runtime_plan_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20210_validate_runtime_plan_groups();

-- Definition Publish must be able to materialize its first Snapshot while the Release is
-- still staging; requiring READY here would deadlock on the certificate that the Snapshot
-- is meant to produce. The immutable Plan Member remains the target and Draft Releases are
-- still ineligible.
CREATE OR REPLACE FUNCTION ontos_migration.g20204_validate_upload_session_insert()
RETURNS trigger
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
      AND (
        release.state IN ('ready', 'published')
        OR (
          release.state = 'staging'
          AND release.staged_validation_context_digest IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM meta.release_runtime_plans AS plan
            WHERE plan.project_id = release.project_id
              AND plan.release_id = release.release_id
          )
        )
      )
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

-- G2-02-09 validated approvals in memory but did not retain their expiry. New facts retain
-- it; legacy rows with an approval and no expiry fail closed in the compatibility verifier.
ALTER TABLE runtime.index_plan_admissions
  ADD COLUMN approval_expires_at timestamptz,
  ADD CONSTRAINT index_plan_admissions_approval_fk
    FOREIGN KEY (project_id, approval_id)
    REFERENCES runtime.capacity_approvals(project_id, approval_id) ON DELETE RESTRICT,
  ADD CONSTRAINT index_plan_admissions_approval_expiry_ck CHECK (
    (approval_id IS NULL AND approval_expires_at IS NULL)
    OR
    (approval_id IS NOT NULL AND (
      approval_expires_at IS NULL OR approval_expires_at > admitted_at
    ))
  );

ALTER TABLE runtime.capacity_admissions
  ADD COLUMN approval_expires_at timestamptz,
  DROP CONSTRAINT capacity_admissions_phase_uq,
  ADD CONSTRAINT capacity_admissions_approval_fk
    FOREIGN KEY (project_id, approval_id)
    REFERENCES runtime.capacity_approvals(project_id, approval_id) ON DELETE RESTRICT,
  ADD CONSTRAINT capacity_admissions_approval_expiry_ck CHECK (
    (approval_id IS NULL AND approval_expires_at IS NULL)
    OR
    (approval_id IS NOT NULL AND (
      approval_expires_at IS NULL OR approval_expires_at > admitted_at
    ))
  ),
  ADD CONSTRAINT capacity_admissions_phase_inventory_uq
    UNIQUE (project_id, generation_id, phase, inventory_revision);

-- The original FK made cross-Release reuse impossible because it required the Generation's
-- source Runtime Plan and revisions to equal the target Release plan. The Generation identity
-- remains a real FK; a trusted insert function verifies source facts and the existing target
-- Plan FK independently before issuing a certificate.
ALTER TABLE runtime.compatibility_certificates
  DROP CONSTRAINT compatibility_certificates_generation_fk,
  ADD COLUMN capacity_admission_id uuid,
  ADD COLUMN index_admission_id uuid,
  ADD CONSTRAINT compatibility_certificates_generation_identity_fk
    FOREIGN KEY (project_id, generation_id)
    REFERENCES runtime.generations(project_id, generation_id) ON DELETE RESTRICT,
  ADD CONSTRAINT compatibility_certificates_capacity_admission_fk
    FOREIGN KEY (project_id, capacity_admission_id)
    REFERENCES runtime.capacity_admissions(project_id, admission_id) ON DELETE RESTRICT,
  ADD CONSTRAINT compatibility_certificates_index_admission_fk
    FOREIGN KEY (project_id, index_admission_id)
    REFERENCES runtime.index_plan_admissions(project_id, admission_id) ON DELETE RESTRICT;

REVOKE EXECUTE ON FUNCTION
  runtime.issue_compatibility_certificate(uuid, uuid, uuid, uuid, text, text, text)
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
DROP FUNCTION runtime.issue_compatibility_certificate(uuid, uuid, uuid, uuid, text, text, text);

CREATE FUNCTION ops.ensure_runtime_refresh_job(
  p_project_id uuid,
  p_job_id uuid,
  p_snapshot_group_id uuid,
  p_group_version bigint,
  p_correlation_id uuid
) RETURNS TABLE (job_id uuid, state text, reused boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $ensure_runtime_refresh_job$
DECLARE
  group_row runtime.snapshot_group_versions%ROWTYPE;
  existing ops.materialization_jobs%ROWTYPE;
  input_preimage text;
  computed_input_digest text;
  computed_idempotency_key text;
BEGIN
  IF p_project_id IS NULL OR p_job_id IS NULL OR p_snapshot_group_id IS NULL
    OR p_correlation_id IS NULL OR p_group_version < 1 THEN
    RAISE EXCEPTION 'G20210_REFRESH_JOB_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT candidate.* INTO group_row
  FROM runtime.snapshot_group_versions AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.snapshot_group_id = p_snapshot_group_id
    AND candidate.group_version = p_group_version
    AND candidate.state IN ('registered', 'validated', 'materializing', 'ready', 'active')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20210_REFRESH_GROUP_STALE' USING ERRCODE = '40001';
  END IF;

  SELECT candidate.* INTO existing
  FROM ops.materialization_jobs AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.snapshot_group_id = p_snapshot_group_id
    AND candidate.group_version = p_group_version
  ORDER BY candidate.created_at DESC, candidate.job_id
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT existing.job_id, existing.state, true;
    RETURN;
  END IF;
  IF group_row.state IN ('ready', 'active') THEN
    RAISE EXCEPTION 'G20210_REFRESH_GROUP_STALE' USING ERRCODE = '40001';
  END IF;

  input_preimage := jsonb_build_object(
    'contractVersion', 'runtime-refresh-job-v1',
    'groupDigest', group_row.group_digest,
    'groupVersion', p_group_version,
    'projectId', p_project_id,
    'schemaVersion', 1,
    'snapshotGroupId', p_snapshot_group_id
  )::text;
  computed_input_digest := 'sha256:' ||
    encode(sha256(convert_to(input_preimage, 'UTF8')), 'hex');
  computed_idempotency_key := 'refresh-' ||
    substring(computed_input_digest FROM 8 FOR 40);

  INSERT INTO ops.materialization_jobs (
    project_id, job_id, snapshot_group_id, group_version,
    idempotency_key, input_digest, correlation_id, priority
  ) VALUES (
    p_project_id, p_job_id, p_snapshot_group_id, p_group_version,
    computed_idempotency_key, computed_input_digest, p_correlation_id, 0
  );
  RETURN QUERY SELECT p_job_id, 'queued'::text, false;
END
$ensure_runtime_refresh_job$;

CREATE FUNCTION ontos_migration.g20210_certificate_digest(
  certificate runtime.compatibility_certificates
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $g20210_certificate_digest$
  SELECT 'sha256:' || encode(sha256(convert_to(
    '{"contractVersion":"generation-compatibility-v1"' ||
    ',"decision":' || to_json(certificate.decision)::text ||
    ',"evidenceDigest":' || to_json(certificate.evidence_digest)::text ||
    ',"generationDigest":' || to_json(certificate.generation_digest)::text ||
    ',"generationId":' || to_json(certificate.generation_id::text)::text ||
    ',"groupVersion":' || certificate.group_version::text ||
    ',"indexPlanDigest":' || to_json(certificate.index_plan_digest)::text ||
    ',"issuer":"materialization-compatibility-verifier"' ||
    ',"mappingDigest":' || to_json(certificate.mapping_digest)::text ||
    ',"mappingRevisionId":' || to_json(certificate.mapping_revision_id::text)::text ||
    ',"projectId":' || to_json(certificate.project_id::text)::text ||
    ',"runtimePlanDigest":' || to_json(certificate.runtime_plan_digest)::text ||
    ',"schemaVersion":1' ||
    ',"snapshotGroupId":' || to_json(certificate.snapshot_group_id::text)::text ||
    ',"snapshotSchemaDigest":' || to_json(certificate.snapshot_schema_digest)::text ||
    ',"snapshotSchemaRevisionId":' ||
      to_json(certificate.snapshot_schema_revision_id::text)::text ||
    ',"targetMemberKey":' || to_json(certificate.target_member_key)::text ||
    ',"targetReleaseId":' || to_json(certificate.target_release_id::text)::text ||
    ',"targetRevisionId":' || to_json(certificate.target_revision_id::text)::text ||
    ',"validatorVersion":' || to_json(certificate.validator_version)::text || '}',
    'UTF8'
  )), 'hex')
$g20210_certificate_digest$;

CREATE FUNCTION runtime.issue_compatibility_certificate(
  p_certificate_id uuid,
  p_project_id uuid,
  p_generation_id uuid,
  p_target_release_id uuid
) RETURNS TABLE (certificate_id uuid, certificate_digest text, decision text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $issue_compatibility_certificate$
DECLARE
  generation runtime.generations%ROWTYPE;
  plan meta.release_runtime_plan_members%ROWTYPE;
  quality runtime.materialization_quality_bindings%ROWTYPE;
  capacity runtime.capacity_admissions%ROWTYPE;
  target_index_plan runtime.index_plans%ROWTYPE;
  index_admission runtime.index_plan_admissions%ROWTYPE;
  current_inventory_revision bigint;
  current_inventory_digest text;
  project_publication_sequence bigint;
  source_target_digest text;
  source_schema_digest text;
  source_mapping_digest text;
  target_target_digest text;
  target_schema_digest text;
  target_mapping_digest text;
  group_digest text;
  confirmation_digest text;
  computed_decision text;
  evidence_preimage text;
  computed_evidence_digest text;
  computed_certificate_digest text;
  persisted_certificate_id uuid;
  validator_version constant text := 'materialization-compatibility-g2-02-10-v1';
BEGIN
  IF p_certificate_id IS NULL OR p_project_id IS NULL OR p_generation_id IS NULL
    OR p_target_release_id IS NULL THEN
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT project.publication_sequence
  INTO project_publication_sequence
  FROM meta.projects AS project
  WHERE project.project_id = p_project_id AND project.state = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT candidate.* INTO generation
  FROM runtime.generations AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.generation_id = p_generation_id
    AND candidate.state IN ('ready', 'active')
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT member.* INTO plan
  FROM meta.release_runtime_plan_members AS member
  JOIN meta.releases AS release
    ON release.project_id = member.project_id
   AND release.release_id = member.release_id
   AND release.state IN ('staging', 'ready', 'published', 'superseded')
  WHERE member.project_id = p_project_id
    AND member.release_id = p_target_release_id
    AND member.member_key = generation.member_key
    AND member.snapshot_group_id = generation.snapshot_group_id
  FOR SHARE OF member, release;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT version.group_digest INTO group_digest
  FROM runtime.snapshot_group_versions AS version
  WHERE version.project_id = generation.project_id
    AND version.snapshot_group_id = generation.snapshot_group_id
    AND version.group_version = generation.group_version
    AND version.state IN ('ready', 'active')
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM meta.release_runtime_plan_members AS expected
    WHERE expected.project_id = plan.project_id
      AND expected.release_id = plan.release_id
      AND expected.snapshot_group_id = plan.snapshot_group_id
      AND NOT EXISTS (
        SELECT 1
        FROM runtime.snapshot_group_members AS actual
        WHERE actual.project_id = expected.project_id
          AND actual.snapshot_group_id = expected.snapshot_group_id
          AND actual.group_version = generation.group_version
          AND actual.member_key = expected.member_key
      )
  ) OR EXISTS (
    SELECT 1
    FROM runtime.snapshot_group_members AS actual
    WHERE actual.project_id = generation.project_id
      AND actual.snapshot_group_id = generation.snapshot_group_id
      AND actual.group_version = generation.group_version
      AND NOT EXISTS (
        SELECT 1
        FROM meta.release_runtime_plan_members AS expected
        WHERE expected.project_id = actual.project_id
          AND expected.release_id = plan.release_id
          AND expected.snapshot_group_id = actual.snapshot_group_id
          AND expected.member_key = actual.member_key
      )
  ) THEN
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT binding.* INTO quality
  FROM runtime.materialization_quality_bindings AS binding
  JOIN runtime.dataset_snapshots AS snapshot
    ON snapshot.project_id = generation.project_id
   AND snapshot.snapshot_id = generation.snapshot_id
   AND snapshot.snapshot_group_id = generation.snapshot_group_id
   AND snapshot.group_version = generation.group_version
   AND snapshot.snapshot_digest = binding.snapshot_digest
  JOIN meta.resource_revisions AS mapping
    ON mapping.resource_id = generation.mapping_resource_id
   AND mapping.revision_id = generation.mapping_revision_id
   AND mapping.content_digest = binding.mapping_revision_digest
  JOIN runtime.materialization_reports AS report
    ON report.project_id = binding.project_id
   AND report.report_id = binding.report_id
   AND report.report_digest = binding.report_digest
   AND report.snapshot_group_id = generation.snapshot_group_id
   AND report.group_version = generation.group_version
   AND report.total_rows = snapshot.row_count
  JOIN ops.materialization_jobs AS job
    ON job.project_id = report.project_id
   AND job.job_id = report.job_id
   AND job.snapshot_group_id = report.snapshot_group_id
   AND job.group_version = report.group_version
   AND job.state = 'succeeded'
  WHERE binding.project_id = generation.project_id
    AND binding.generation_id = generation.generation_id
    AND binding.report_id = generation.report_id
    AND binding.report_digest = generation.report_digest
    AND binding.state IN ('passed', 'confirmed')
    AND binding.zero_overlay_row_count = 0
    AND (
      (binding.state = 'passed' AND report.outcome = 'passed')
      OR
      (binding.state = 'confirmed' AND report.outcome = 'awaiting_confirmation')
    )
  FOR SHARE OF binding, report, job;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '23514';
  END IF;

  confirmation_digest := NULL;
  IF quality.state = 'confirmed' THEN
    SELECT confirmation.confirmation_digest
    INTO confirmation_digest
    FROM runtime.materialization_confirmations AS confirmation
    WHERE confirmation.project_id = generation.project_id
      AND confirmation.generation_id = generation.generation_id
      AND confirmation.report_id = generation.report_id
      AND confirmation.report_digest = generation.report_digest
      AND confirmation.decision = 'accepted'
      AND confirmation.expires_at > clock_timestamp()
      AND confirmation.publication_control_sequence = project_publication_sequence
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT inventory.inventory_revision, inventory.inventory_digest
  INTO current_inventory_revision, current_inventory_digest
  FROM runtime.project_runtime_inventories AS inventory
  WHERE inventory.project_id = generation.project_id
    AND inventory.measurement_complete
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAPACITY_INVENTORY_STALE' USING ERRCODE = '40001';
  END IF;

  SELECT candidate.* INTO target_index_plan
  FROM runtime.index_plans AS candidate
  WHERE candidate.project_id = plan.project_id
    AND candidate.target_resource_id = plan.target_resource_id
    AND candidate.target_revision_id = plan.target_revision_id
    AND candidate.plan_digest = plan.index_plan_digest
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '23514';
  END IF;

  IF plan.member_kind = 'object' THEN
    SELECT admission.* INTO index_admission
    FROM runtime.index_plan_admissions AS admission
    WHERE admission.project_id = plan.project_id
      AND admission.release_id = plan.release_id
      AND admission.index_plan_id = target_index_plan.index_plan_id
      AND admission.inventory_revision = current_inventory_revision
      AND (
        admission.approval_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM runtime.capacity_approvals AS approval
          WHERE approval.project_id = admission.project_id
            AND approval.approval_id = admission.approval_id
            AND approval.state = 'active'
            AND approval.expires_at = admission.approval_expires_at
            AND approval.expires_at > clock_timestamp()
        )
      )
    ORDER BY admission.admitted_at DESC, admission.admission_id
    LIMIT 1
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CAPACITY_INVENTORY_STALE' USING ERRCODE = '40001';
    END IF;
  ELSIF target_index_plan.entry_count <> 0
    OR target_index_plan.compiler_version <> 'g2-02-10-link-index-v1' THEN
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT admission.* INTO capacity
  FROM runtime.capacity_admissions AS admission
  WHERE admission.project_id = generation.project_id
    AND admission.generation_id = generation.generation_id
    AND admission.phase = 'POSTBUILD'
    AND admission.inventory_revision = current_inventory_revision
    AND admission.index_plan_digest = generation.index_plan_digest
    AND admission.physical_measurement_digest = current_inventory_digest
    AND admission.report->>'accepted' = 'true'
    AND (
      admission.approval_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM runtime.capacity_approvals AS approval
        WHERE approval.project_id = admission.project_id
          AND approval.approval_id = admission.approval_id
          AND approval.state = 'active'
          AND approval.expires_at = admission.approval_expires_at
          AND approval.expires_at > clock_timestamp()
      )
    )
  ORDER BY admission.admitted_at DESC, admission.admission_id
  LIMIT 1
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAPACITY_INVENTORY_STALE' USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM runtime.index_plans AS index_plan
    JOIN runtime.index_plan_entries AS entry
      ON entry.project_id = index_plan.project_id
     AND entry.index_plan_id = index_plan.index_plan_id
    LEFT JOIN runtime.index_inventory AS inventory
      ON inventory.project_id = entry.project_id
     AND inventory.index_plan_id = entry.index_plan_id
     AND inventory.entry_key = entry.entry_key
     AND inventory.physical_signature = entry.physical_signature
     AND inventory.index_name = entry.index_name
     AND inventory.state = 'ready'
    WHERE index_plan.project_id = plan.project_id
      AND index_plan.target_resource_id = plan.target_resource_id
      AND index_plan.target_revision_id = plan.target_revision_id
      AND index_plan.plan_digest = plan.index_plan_digest
      AND inventory.index_inventory_id IS NULL
  ) THEN
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT revision.content_digest INTO STRICT source_target_digest
  FROM meta.resource_revisions AS revision
  WHERE revision.resource_id = generation.target_resource_id
    AND revision.revision_id = generation.target_revision_id;
  SELECT revision.content_digest INTO STRICT source_schema_digest
  FROM meta.resource_revisions AS revision
  WHERE revision.resource_id = generation.snapshot_schema_resource_id
    AND revision.revision_id = generation.snapshot_schema_revision_id;
  SELECT revision.content_digest INTO STRICT source_mapping_digest
  FROM meta.resource_revisions AS revision
  WHERE revision.resource_id = generation.mapping_resource_id
    AND revision.revision_id = generation.mapping_revision_id;
  SELECT revision.content_digest INTO STRICT target_target_digest
  FROM meta.resource_revisions AS revision
  WHERE revision.resource_id = plan.target_resource_id
    AND revision.revision_id = plan.target_revision_id;
  SELECT revision.content_digest INTO STRICT target_schema_digest
  FROM meta.resource_revisions AS revision
  WHERE revision.resource_id = plan.snapshot_schema_resource_id
    AND revision.revision_id = plan.snapshot_schema_revision_id;
  SELECT revision.content_digest INTO STRICT target_mapping_digest
  FROM meta.resource_revisions AS revision
  WHERE revision.resource_id = plan.mapping_resource_id
    AND revision.revision_id = plan.mapping_revision_id;

  IF generation.target_resource_id = plan.target_resource_id
    AND generation.target_revision_id = plan.target_revision_id
    AND generation.snapshot_schema_resource_id = plan.snapshot_schema_resource_id
    AND generation.snapshot_schema_revision_id = plan.snapshot_schema_revision_id
    AND generation.mapping_resource_id = plan.mapping_resource_id
    AND generation.mapping_revision_id = plan.mapping_revision_id
    AND generation.index_plan_digest = plan.index_plan_digest THEN
    computed_decision := 'exact_pin';
  ELSIF generation.target_resource_id = plan.target_resource_id
    AND generation.target_revision_id = plan.target_revision_id
    AND generation.snapshot_schema_resource_id = plan.snapshot_schema_resource_id
    AND generation.mapping_resource_id = plan.mapping_resource_id
    AND generation.index_plan_digest = plan.index_plan_digest
    AND source_target_digest = target_target_digest
    AND source_schema_digest = target_schema_digest
    AND source_mapping_digest = target_mapping_digest THEN
    computed_decision := 'projection_equivalent';
  ELSE
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '23514';
  END IF;

  evidence_preimage := jsonb_build_object(
    'capacityAdmissionId', capacity.admission_id,
    'capacityApprovalExpiresAt', capacity.approval_expires_at,
    'capacityApprovalId', capacity.approval_id,
    'capacityReportDigest', capacity.report_digest,
    'confirmationDigest', confirmation_digest,
    'generationDigest', generation.generation_digest,
    'generationRuntimePlanDigest', generation.runtime_plan_digest,
    'groupDigest', group_digest,
    'groupVersion', generation.group_version,
    'indexAdmissionId', index_admission.admission_id,
    'indexApprovalExpiresAt', index_admission.approval_expires_at,
    'indexApprovalId', index_admission.approval_id,
    'indexAdmissionReportDigest', index_admission.report_digest,
    'indexAdmissionInventoryRevision', index_admission.inventory_revision,
    'inventoryDigest', current_inventory_digest,
    'inventoryRevision', current_inventory_revision,
    'qualityBindingDigest', quality.quality_binding_digest,
    'qualityReportDigest', generation.report_digest,
    'sourceIndexPlanDigest', generation.index_plan_digest,
    'sourceMappingDigest', source_mapping_digest,
    'sourceSnapshotSchemaDigest', source_schema_digest,
    'sourceTargetDigest', source_target_digest,
    'targetIndexPlanDigest', plan.index_plan_digest,
    'targetMappingDigest', target_mapping_digest,
    'targetRuntimePlanDigest', plan.runtime_plan_digest,
    'targetSnapshotSchemaDigest', target_schema_digest,
    'targetTargetDigest', target_target_digest,
    'validatorVersion', validator_version
  )::text;
  computed_evidence_digest := 'sha256:' ||
    encode(sha256(convert_to(evidence_preimage, 'UTF8')), 'hex');

  computed_certificate_digest := 'sha256:' || encode(sha256(convert_to(
    '{"contractVersion":"generation-compatibility-v1"' ||
    ',"decision":' || to_json(computed_decision)::text ||
    ',"evidenceDigest":' || to_json(computed_evidence_digest)::text ||
    ',"generationDigest":' || to_json(generation.generation_digest)::text ||
    ',"generationId":' || to_json(generation.generation_id::text)::text ||
    ',"groupVersion":' || generation.group_version::text ||
    ',"indexPlanDigest":' || to_json(plan.index_plan_digest)::text ||
    ',"issuer":"materialization-compatibility-verifier"' ||
    ',"mappingDigest":' || to_json(target_mapping_digest)::text ||
    ',"mappingRevisionId":' || to_json(plan.mapping_revision_id::text)::text ||
    ',"projectId":' || to_json(generation.project_id::text)::text ||
    ',"runtimePlanDigest":' || to_json(plan.runtime_plan_digest)::text ||
    ',"schemaVersion":1' ||
    ',"snapshotGroupId":' || to_json(generation.snapshot_group_id::text)::text ||
    ',"snapshotSchemaDigest":' || to_json(target_schema_digest)::text ||
    ',"snapshotSchemaRevisionId":' || to_json(plan.snapshot_schema_revision_id::text)::text ||
    ',"targetMemberKey":' || to_json(generation.member_key)::text ||
    ',"targetReleaseId":' || to_json(p_target_release_id::text)::text ||
    ',"targetRevisionId":' || to_json(plan.target_revision_id::text)::text ||
    ',"validatorVersion":' || to_json(validator_version)::text || '}',
    'UTF8'
  )), 'hex');

  INSERT INTO runtime.compatibility_certificates (
    project_id, certificate_id, generation_id, generation_digest,
    target_release_id, target_member_key, target_resource_id, target_revision_id,
    snapshot_group_id, group_version,
    snapshot_schema_resource_id, snapshot_schema_revision_id, snapshot_schema_digest,
    mapping_resource_id, mapping_revision_id, mapping_digest,
    index_plan_digest, runtime_plan_digest, decision, validator_version,
    evidence_digest, certificate_digest, capacity_admission_id, index_admission_id
  ) VALUES (
    generation.project_id, p_certificate_id, generation.generation_id,
    generation.generation_digest, p_target_release_id, generation.member_key,
    plan.target_resource_id, plan.target_revision_id,
    generation.snapshot_group_id, generation.group_version,
    plan.snapshot_schema_resource_id, plan.snapshot_schema_revision_id, target_schema_digest,
    plan.mapping_resource_id, plan.mapping_revision_id, target_mapping_digest,
    plan.index_plan_digest, plan.runtime_plan_digest, computed_decision, validator_version,
    computed_evidence_digest, computed_certificate_digest,
    capacity.admission_id, index_admission.admission_id
  ) ON CONFLICT ON CONSTRAINT compatibility_certificates_digest_uq DO NOTHING;

  SELECT certificate.certificate_id INTO persisted_certificate_id
  FROM runtime.compatibility_certificates AS certificate
  WHERE certificate.project_id = generation.project_id
    AND certificate.certificate_digest = computed_certificate_digest;
  IF persisted_certificate_id IS NULL THEN
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN QUERY
  SELECT persisted_certificate_id, computed_certificate_digest, computed_decision;
EXCEPTION
  WHEN no_data_found OR too_many_rows THEN
    RAISE EXCEPTION 'GENERATION_COMPATIBILITY_INVALID' USING ERRCODE = '23514';
END
$issue_compatibility_certificate$;

CREATE VIEW runtime.current_compatibility_certificates
WITH (security_barrier = true) AS
SELECT certificate.*
FROM runtime.compatibility_certificates AS certificate
JOIN runtime.generations AS generation
  ON generation.project_id = certificate.project_id
 AND generation.generation_id = certificate.generation_id
 AND generation.generation_digest = certificate.generation_digest
 AND generation.member_key = certificate.target_member_key
 AND generation.snapshot_group_id = certificate.snapshot_group_id
 AND generation.group_version = certificate.group_version
 AND generation.state IN ('ready', 'active')
JOIN runtime.snapshot_group_versions AS group_version
  ON group_version.project_id = generation.project_id
 AND group_version.snapshot_group_id = generation.snapshot_group_id
 AND group_version.group_version = generation.group_version
 AND group_version.state IN ('ready', 'active')
JOIN runtime.materialization_quality_bindings AS quality
  ON quality.project_id = generation.project_id
 AND quality.generation_id = generation.generation_id
 AND quality.report_id = generation.report_id
 AND quality.report_digest = generation.report_digest
 AND quality.state IN ('passed', 'confirmed')
 AND quality.zero_overlay_row_count = 0
JOIN runtime.dataset_snapshots AS snapshot
  ON snapshot.project_id = generation.project_id
 AND snapshot.snapshot_id = generation.snapshot_id
 AND snapshot.snapshot_group_id = generation.snapshot_group_id
 AND snapshot.group_version = generation.group_version
 AND snapshot.snapshot_digest = quality.snapshot_digest
JOIN meta.resource_revisions AS mapping
  ON mapping.resource_id = generation.mapping_resource_id
 AND mapping.revision_id = generation.mapping_revision_id
 AND mapping.content_digest = quality.mapping_revision_digest
JOIN runtime.materialization_reports AS report
  ON report.project_id = quality.project_id
 AND report.report_id = quality.report_id
 AND report.report_digest = quality.report_digest
 AND report.snapshot_group_id = generation.snapshot_group_id
 AND report.group_version = generation.group_version
 AND report.total_rows = snapshot.row_count
JOIN ops.materialization_jobs AS job
  ON job.project_id = report.project_id
 AND job.job_id = report.job_id
 AND job.snapshot_group_id = report.snapshot_group_id
 AND job.group_version = report.group_version
 AND job.state = 'succeeded'
JOIN runtime.project_runtime_inventories AS project_inventory
  ON project_inventory.project_id = generation.project_id
 AND project_inventory.measurement_complete
JOIN runtime.capacity_admissions AS capacity
  ON capacity.project_id = generation.project_id
 AND capacity.admission_id = certificate.capacity_admission_id
 AND capacity.generation_id = generation.generation_id
 AND capacity.phase = 'POSTBUILD'
 AND capacity.inventory_revision = project_inventory.inventory_revision
 AND capacity.index_plan_digest = generation.index_plan_digest
 AND capacity.physical_measurement_digest = project_inventory.inventory_digest
 AND capacity.report->>'accepted' = 'true'
WHERE certificate.validator_version = 'materialization-compatibility-g2-02-10-v1'
  AND certificate.certificate_digest =
      ontos_migration.g20210_certificate_digest(certificate)
  AND (
    capacity.approval_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM runtime.capacity_approvals AS approval
      WHERE approval.project_id = capacity.project_id
        AND approval.approval_id = capacity.approval_id
        AND approval.state = 'active'
        AND approval.expires_at = capacity.approval_expires_at
        AND approval.expires_at > clock_timestamp()
    )
  )
  AND EXISTS (
    SELECT 1
    FROM runtime.index_plans AS target_index_plan
    WHERE target_index_plan.project_id = certificate.project_id
      AND target_index_plan.target_resource_id = certificate.target_resource_id
      AND target_index_plan.target_revision_id = certificate.target_revision_id
      AND target_index_plan.plan_digest = certificate.index_plan_digest
      AND (
        (
          split_part(certificate.target_member_key, ':', 1) = 'link'
          AND certificate.index_admission_id IS NULL
          AND target_index_plan.entry_count = 0
          AND target_index_plan.compiler_version = 'g2-02-10-link-index-v1'
        )
        OR EXISTS (
          SELECT 1
          FROM runtime.index_plan_admissions AS index_admission
          WHERE index_admission.project_id = certificate.project_id
            AND index_admission.admission_id = certificate.index_admission_id
            AND index_admission.release_id = certificate.target_release_id
            AND index_admission.index_plan_id = target_index_plan.index_plan_id
            AND index_admission.inventory_revision = project_inventory.inventory_revision
            AND (
              index_admission.approval_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM runtime.capacity_approvals AS approval
                WHERE approval.project_id = index_admission.project_id
                  AND approval.approval_id = index_admission.approval_id
                  AND approval.state = 'active'
                  AND approval.expires_at = index_admission.approval_expires_at
                  AND approval.expires_at > clock_timestamp()
              )
            )
        )
      )
  )
  AND (
    (quality.state = 'passed' AND report.outcome = 'passed')
    OR (quality.state = 'confirmed' AND report.outcome = 'awaiting_confirmation' AND EXISTS (
      SELECT 1
      FROM runtime.materialization_confirmations AS confirmation
      JOIN meta.projects AS project
        ON project.project_id = confirmation.project_id
       AND project.publication_sequence = confirmation.publication_control_sequence
      WHERE confirmation.project_id = generation.project_id
        AND confirmation.generation_id = generation.generation_id
        AND confirmation.report_id = generation.report_id
        AND confirmation.report_digest = generation.report_digest
        AND confirmation.decision = 'accepted'
        AND confirmation.expires_at > clock_timestamp()
    ))
  );

CREATE FUNCTION ontos_migration.g20210_release_runtime_ready_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20210_release_runtime_ready_guard$
BEGIN
  IF OLD.state = 'staging' AND NEW.state = 'ready'
    AND EXISTS (
      SELECT 1 FROM meta.release_runtime_plans AS plan
      WHERE plan.release_id = NEW.release_id
    )
    AND EXISTS (
      SELECT 1
      FROM (
        SELECT member.snapshot_group_id, count(*)::integer AS expected_count
        FROM meta.release_runtime_plan_members AS member
        WHERE member.release_id = NEW.release_id
        GROUP BY member.snapshot_group_id
      ) AS expected
      WHERE NOT EXISTS (
        SELECT 1
        FROM runtime.current_compatibility_certificates AS certificate
        WHERE certificate.target_release_id = NEW.release_id
          AND certificate.snapshot_group_id = expected.snapshot_group_id
        GROUP BY certificate.group_version
        HAVING count(DISTINCT certificate.target_member_key) = expected.expected_count
      )
    ) THEN
    RAISE EXCEPTION 'G20210_RELEASE_RUNTIME_MEMBERS_NOT_READY' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20210_release_runtime_ready_guard$;

CREATE TRIGGER release_runtime_ready_guard
BEFORE UPDATE ON meta.releases
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20210_release_runtime_ready_guard();

REVOKE ALL PRIVILEGES ON TABLE
  runtime.snapshot_group_definition_members,
  runtime.current_compatibility_certificates
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON FUNCTION
  runtime.issue_compatibility_certificate(uuid, uuid, uuid, uuid),
  ops.ensure_runtime_refresh_job(uuid, uuid, uuid, bigint, uuid),
  ontos_migration.g20204_validate_upload_session_insert(),
  ontos_migration.g20210_certificate_digest(runtime.compatibility_certificates),
  ontos_migration.g20210_validate_group_definition_member(),
  ontos_migration.g20210_validate_group_definition_complete(),
  ontos_migration.g20210_validate_runtime_plan_insert(),
  ontos_migration.g20210_validate_runtime_plan_groups(),
  ontos_migration.g20210_release_runtime_ready_guard()
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT SELECT, INSERT ON TABLE runtime.snapshot_group_definition_members TO api_runtime;
GRANT SELECT ON TABLE runtime.snapshot_group_definition_members TO worker_runtime;
GRANT SELECT ON TABLE runtime.current_compatibility_certificates TO api_runtime, worker_runtime;
GRANT SELECT (project_id, approval_id, state, expires_at)
ON TABLE runtime.capacity_approvals TO api_runtime;
GRANT EXECUTE ON FUNCTION
  ontos_migration.g20210_certificate_digest(runtime.compatibility_certificates)
TO api_runtime, worker_runtime;
GRANT EXECUTE ON FUNCTION
  runtime.issue_compatibility_certificate(uuid, uuid, uuid, uuid)
TO api_runtime;
GRANT EXECUTE ON FUNCTION
  ops.ensure_runtime_refresh_job(uuid, uuid, uuid, bigint, uuid)
TO api_runtime;
