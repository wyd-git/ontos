SET LOCAL ROLE migration_owner;

-- G2-02-13 exposes the already-frozen Materialization control facts through
-- api_runtime without granting direct mutation rights. Every write below is
-- server-derived, idempotent or bound to an explicit compare-and-swap fact.

CREATE FUNCTION ops.enqueue_materialization_job_admin(
  p_project_id uuid,
  p_job_id uuid,
  p_snapshot_group_id uuid,
  p_group_version bigint,
  p_idempotency_key text,
  p_correlation_id uuid,
  p_priority integer DEFAULT 0
) RETURNS TABLE (job_id uuid, state text, reused boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $enqueue_materialization_job_admin$
DECLARE
  group_row runtime.snapshot_group_versions%ROWTYPE;
  input_preimage text;
  input_digest text;
BEGIN
  IF p_project_id IS NULL OR p_job_id IS NULL OR p_snapshot_group_id IS NULL
    OR p_correlation_id IS NULL OR p_group_version < 1
    OR p_priority NOT BETWEEN -100 AND 100
    OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$' THEN
    RAISE EXCEPTION 'G20213_JOB_START_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT candidate.* INTO group_row
  FROM runtime.snapshot_group_versions AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.snapshot_group_id = p_snapshot_group_id
    AND candidate.group_version = p_group_version
    AND candidate.state IN ('registered', 'validated', 'materializing', 'ready', 'active')
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATERIALIZATION_OBJECT_NOT_ACCESSIBLE' USING ERRCODE = '02000';
  END IF;

  input_preimage := jsonb_build_object(
    'contractVersion', 'materialization-admin-job-v1',
    'groupDigest', group_row.group_digest,
    'groupVersion', p_group_version,
    'projectId', p_project_id,
    'schemaVersion', 1,
    'snapshotGroupId', p_snapshot_group_id
  )::text;
  input_digest := 'sha256:' || encode(sha256(convert_to(input_preimage, 'UTF8')), 'hex');

  RETURN QUERY
  SELECT result.job_id, result.state, result.reused
  FROM ops.enqueue_materialization_job(
    p_project_id,
    p_job_id,
    p_snapshot_group_id,
    p_group_version,
    p_idempotency_key,
    input_digest,
    p_correlation_id,
    p_priority
  ) AS result;
END
$enqueue_materialization_job_admin$;

CREATE FUNCTION ops.request_materialization_job_cancel_v2(
  p_project_id uuid,
  p_job_id uuid,
  p_principal_id uuid,
  p_expected_updated_at timestamptz
) RETURNS TABLE (state text, cancel_requested boolean, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $request_materialization_job_cancel_v2$
DECLARE
  job_row ops.materialization_jobs%ROWTYPE;
BEGIN
  IF p_project_id IS NULL OR p_job_id IS NULL OR p_principal_id IS NULL
    OR p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'G20213_JOB_CANCEL_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT candidate.* INTO job_row
  FROM ops.materialization_jobs AS candidate
  WHERE candidate.project_id = p_project_id AND candidate.job_id = p_job_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATERIALIZATION_OBJECT_NOT_ACCESSIBLE' USING ERRCODE = '02000';
  END IF;
  IF job_row.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'MATERIALIZATION_OBJECT_VERSION_CONFLICT' USING ERRCODE = '40001';
  END IF;

  PERFORM response.state
  FROM ops.request_materialization_job_cancel(
    p_project_id, p_job_id, p_principal_id, 'ADMIN_CANCELLED'
  ) AS response;

  RETURN QUERY
  SELECT candidate.state, candidate.cancel_requested, candidate.updated_at
  FROM ops.materialization_jobs AS candidate
  WHERE candidate.project_id = p_project_id AND candidate.job_id = p_job_id;
END
$request_materialization_job_cancel_v2$;

CREATE FUNCTION runtime.approve_materialization_capacity(
  p_project_id uuid,
  p_approval_id uuid,
  p_scope text,
  p_scope_id uuid,
  p_approved_limit_bytes bigint,
  p_hard_limit_bytes bigint,
  p_approved_by_principal_id uuid,
  p_expected_inventory_revision bigint,
  p_evidence_digest text,
  p_expires_at timestamptz
) RETURNS TABLE (
  approval_id uuid,
  scope text,
  scope_id uuid,
  approved_limit_bytes bigint,
  hard_limit_bytes bigint,
  evidence_digest text,
  state text,
  expires_at timestamptz,
  reused boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $approve_materialization_capacity$
DECLARE
  now_at timestamptz := clock_timestamp();
  inventory runtime.project_runtime_inventories%ROWTYPE;
  existing runtime.capacity_approvals%ROWTYPE;
  inserted_count integer;
  required_hard_limit bigint;
BEGIN
  required_hard_limit := CASE p_scope
    WHEN 'release' THEN 3221225472::bigint
    WHEN 'project_steady' THEN 12884901888::bigint
    WHEN 'project_peak' THEN 12884901888::bigint
    WHEN 'index' THEN 12884901888::bigint
    ELSE NULL
  END;
  IF p_project_id IS NULL OR p_approval_id IS NULL OR p_approved_by_principal_id IS NULL
    OR p_expected_inventory_revision < 1 OR required_hard_limit IS NULL
    OR p_hard_limit_bytes <> required_hard_limit
    OR p_approved_limit_bytes <= 0 OR p_approved_limit_bytes > required_hard_limit
    OR p_evidence_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_expires_at <= now_at OR p_expires_at > now_at + interval '30 days'
    OR ((p_scope IN ('release', 'index')) IS DISTINCT FROM (p_scope_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'G20213_CAPACITY_APPROVAL_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT candidate.* INTO inventory
  FROM runtime.project_runtime_inventories AS candidate
  WHERE candidate.project_id = p_project_id
  FOR SHARE;
  IF NOT FOUND OR NOT inventory.measurement_complete
    OR inventory.inventory_revision <> p_expected_inventory_revision THEN
    RAISE EXCEPTION 'MATERIALIZATION_OBJECT_VERSION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF p_scope = 'release' AND NOT EXISTS (
    SELECT 1 FROM meta.releases AS release
    WHERE release.project_id = p_project_id AND release.release_id = p_scope_id
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_OBJECT_NOT_ACCESSIBLE' USING ERRCODE = '02000';
  END IF;
  IF p_scope = 'index' AND NOT EXISTS (
    SELECT 1 FROM runtime.index_plans AS plan
    WHERE plan.project_id = p_project_id AND plan.index_plan_id = p_scope_id
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_OBJECT_NOT_ACCESSIBLE' USING ERRCODE = '02000';
  END IF;

  INSERT INTO runtime.capacity_approvals (
    project_id, approval_id, scope, scope_id, approved_limit_bytes,
    hard_limit_bytes, approved_by_principal_id, evidence_digest, expires_at
  ) VALUES (
    p_project_id, p_approval_id, p_scope, p_scope_id, p_approved_limit_bytes,
    p_hard_limit_bytes, p_approved_by_principal_id, p_evidence_digest, p_expires_at
  ) ON CONFLICT ON CONSTRAINT capacity_approvals_evidence_uq DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  SELECT candidate.* INTO existing
  FROM runtime.capacity_approvals AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.evidence_digest = p_evidence_digest;
  IF NOT FOUND OR existing.scope <> p_scope
    OR existing.scope_id IS DISTINCT FROM p_scope_id
    OR existing.approved_limit_bytes <> p_approved_limit_bytes
    OR existing.hard_limit_bytes <> p_hard_limit_bytes
    OR existing.expires_at <> p_expires_at THEN
    RAISE EXCEPTION 'MATERIALIZATION_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;

  RETURN QUERY SELECT
    existing.approval_id, existing.scope, existing.scope_id,
    existing.approved_limit_bytes, existing.hard_limit_bytes,
    existing.evidence_digest::text, existing.state, existing.expires_at,
    inserted_count = 0;
END
$approve_materialization_capacity$;

CREATE VIEW ops.materialization_admin_report_samples
WITH (security_barrier = true) AS
SELECT project_id, report_id, file_id, row_number, reason_code, fingerprint, ordinal
FROM ops.materialization_error_samples;

CREATE VIEW runtime.materialization_admin_capacity_approvals
WITH (security_barrier = true) AS
SELECT project_id, approval_id, scope, scope_id, approved_limit_bytes,
       hard_limit_bytes, evidence_digest, state, expires_at, created_at
FROM runtime.capacity_approvals;

REVOKE ALL PRIVILEGES ON FUNCTION
  ops.enqueue_materialization_job_admin(uuid, uuid, uuid, bigint, text, uuid, integer),
  ops.request_materialization_job_cancel_v2(uuid, uuid, uuid, timestamptz),
  runtime.approve_materialization_capacity(
    uuid, uuid, text, uuid, bigint, bigint, uuid, bigint, text, timestamptz
  )
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

REVOKE ALL PRIVILEGES ON TABLE
  ops.materialization_admin_report_samples,
  runtime.materialization_admin_capacity_approvals
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT EXECUTE ON FUNCTION
  ops.enqueue_materialization_job_admin(uuid, uuid, uuid, bigint, text, uuid, integer),
  ops.request_materialization_job_cancel_v2(uuid, uuid, uuid, timestamptz),
  runtime.approve_materialization_capacity(
    uuid, uuid, text, uuid, bigint, bigint, uuid, bigint, text, timestamptz
  )
TO api_runtime;

GRANT SELECT ON TABLE
  ops.materialization_admin_report_samples,
  runtime.materialization_admin_capacity_approvals
TO api_runtime;

-- The production Worker is deliberately narrower than the API. It receives no
-- user bearer token and cannot write serving pointers. These functions expose
-- only the immutable build inputs bound to its live fenced lease, create the
-- server-bound Generation/forecast facts, and close a build at READY. Owner
-- Refresh + Activate remains the only path that can move a serving pointer.

CREATE TYPE ops.materialization_build_member_record AS (
  generation_id uuid,
  generation_state text,
  quality_state text,
  base_promoted boolean,
  member_key text,
  member_kind text,
  target_resource_id uuid,
  target_revision_id uuid,
  target_definition_digest text,
  target_definition jsonb,
  source_object_resource_id uuid,
  source_object_revision_id uuid,
  source_object_definition_digest text,
  source_object_definition jsonb,
  target_object_resource_id uuid,
  target_object_revision_id uuid,
  target_object_definition_digest text,
  target_object_definition jsonb,
  snapshot_id uuid,
  snapshot_digest text,
  snapshot_content_digest text,
  snapshot_row_count bigint,
  snapshot_byte_count bigint,
  snapshot_group_id uuid,
  group_version bigint,
  snapshot_group_key text,
  snapshot_schema_resource_id uuid,
  snapshot_schema_revision_id uuid,
  snapshot_schema_digest text,
  snapshot_schema_definition jsonb,
  mapping_resource_id uuid,
  mapping_revision_id uuid,
  mapping_digest text,
  mapping_definition jsonb,
  runtime_plan_digest text,
  index_plan_digest text,
  file_id uuid,
  file_ordinal integer,
  object_key text,
  object_version text,
  file_content_digest text,
  file_byte_count bigint,
  file_row_count bigint,
  media_type text
);

CREATE FUNCTION ops.discover_materialization_build_member_keys(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint
) RETURNS TABLE (member_key text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $discover_materialization_build_member_keys$
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
  RETURN QUERY
  SELECT member.member_key::text
  FROM ops.materialization_jobs AS job
  JOIN runtime.snapshot_group_members AS member
    ON member.project_id = job.project_id
   AND member.snapshot_group_id = job.snapshot_group_id
   AND member.group_version = job.group_version
  WHERE job.project_id = p_project_id AND job.job_id = p_job_id
  ORDER BY CASE member.member_kind WHEN 'object' THEN 0 ELSE 1 END,
           member.member_key COLLATE "C";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20213_BUILD_INPUT_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
END
$discover_materialization_build_member_keys$;

CREATE FUNCTION ops.read_materialization_build_members(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint
) RETURNS SETOF ops.materialization_build_member_record
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $read_materialization_build_members$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM ops.materialization_jobs AS job
    WHERE job.project_id = p_project_id
      AND job.job_id = p_job_id
      AND job.state = 'running'
      AND job.current_attempt_id = p_attempt_id
      AND job.fencing_token = p_fencing_token
      AND job.lease_expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_FENCED' USING ERRCODE = '55000';
  END IF;

  RETURN QUERY
  SELECT generation.generation_id,
         generation.state,
         quality.state,
         EXISTS (
           SELECT 1
           FROM ops.materialization_generation_stages AS stage
           WHERE stage.project_id = generation.project_id
             AND stage.generation_id = generation.generation_id
             AND stage.state = 'promoted'
         ),
         generation.member_key,
         generation.member_kind,
         generation.target_resource_id,
         generation.target_revision_id,
         target_revision.content_digest::text,
         target_revision.content,
         source_revision.resource_id,
         source_revision.revision_id,
         source_revision.content_digest::text,
         source_revision.content,
         endpoint_revision.resource_id,
         endpoint_revision.revision_id,
         endpoint_revision.content_digest::text,
         endpoint_revision.content,
         snapshot.snapshot_id,
         snapshot.snapshot_digest::text,
         snapshot.content_digest::text,
         snapshot.row_count,
         snapshot.byte_count,
         snapshot.snapshot_group_id,
         snapshot.group_version,
         snapshot_group.group_key::text,
         generation.snapshot_schema_resource_id,
         generation.snapshot_schema_revision_id,
         schema_revision.content_digest::text,
         schema_revision.content,
         generation.mapping_resource_id,
         generation.mapping_revision_id,
         mapping_revision.content_digest::text,
         mapping_revision.content,
         generation.runtime_plan_digest::text,
         generation.index_plan_digest::text,
         file.file_id,
         file.ordinal,
         upload.object_key::text,
         file.object_version::text,
         file.content_digest::text,
         file.byte_count,
         file.row_count,
         upload.allowed_media_type::text
  FROM ops.materialization_jobs AS job
  JOIN runtime.generations AS generation
    ON generation.project_id = job.project_id
   AND generation.snapshot_group_id = job.snapshot_group_id
   AND generation.group_version = job.group_version
   AND generation.state IN ('building', 'ready', 'active')
  JOIN runtime.dataset_snapshots AS snapshot
    ON snapshot.project_id = generation.project_id
   AND snapshot.snapshot_id = generation.snapshot_id
  JOIN runtime.snapshot_groups AS snapshot_group
    ON snapshot_group.project_id = snapshot.project_id
   AND snapshot_group.snapshot_group_id = snapshot.snapshot_group_id
  JOIN runtime.snapshot_files AS file
    ON file.project_id = snapshot.project_id
   AND file.snapshot_id = snapshot.snapshot_id
   AND file.scan_status = 'complete'
  JOIN runtime.snapshot_upload_sessions AS upload
    ON upload.project_id = file.project_id
   AND upload.snapshot_id = file.snapshot_id
   AND upload.managed_artifact_id = file.managed_artifact_id
   AND upload.uploaded_object_version = file.object_version
   AND upload.state = 'finalized'
  JOIN meta.resource_revisions AS target_revision
    ON target_revision.resource_id = generation.target_resource_id
   AND target_revision.revision_id = generation.target_revision_id
   AND target_revision.family = CASE generation.member_kind
     WHEN 'object' THEN 'object_type' ELSE 'link_type' END
   AND target_revision.state = 'published'
  JOIN meta.resource_revisions AS schema_revision
    ON schema_revision.resource_id = generation.snapshot_schema_resource_id
   AND schema_revision.revision_id = generation.snapshot_schema_revision_id
   AND schema_revision.family = 'snapshot_schema'
   AND schema_revision.state = 'published'
  JOIN meta.resource_revisions AS mapping_revision
    ON mapping_revision.resource_id = generation.mapping_resource_id
   AND mapping_revision.revision_id = generation.mapping_revision_id
   AND mapping_revision.family = 'mapping'
   AND mapping_revision.state = 'published'
  LEFT JOIN meta.resource_dependencies AS source_dependency
    ON source_dependency.source_revision_id = generation.target_revision_id
   AND source_dependency.dependency_type = 'link_source'
  LEFT JOIN meta.resource_revisions AS source_revision
    ON source_revision.revision_id = source_dependency.target_revision_id
   AND source_revision.family = 'object_type'
   AND source_revision.state = 'published'
  LEFT JOIN meta.resource_dependencies AS target_dependency
    ON target_dependency.source_revision_id = generation.target_revision_id
   AND target_dependency.dependency_type = 'link_target'
  LEFT JOIN meta.resource_revisions AS endpoint_revision
    ON endpoint_revision.revision_id = target_dependency.target_revision_id
   AND endpoint_revision.family = 'object_type'
   AND endpoint_revision.state = 'published'
  LEFT JOIN runtime.materialization_quality_bindings AS quality
    ON quality.project_id = generation.project_id
   AND quality.generation_id = generation.generation_id
  WHERE job.project_id = p_project_id
    AND job.job_id = p_job_id
    AND job.current_attempt_id = p_attempt_id
    AND job.fencing_token = p_fencing_token
  ORDER BY CASE generation.member_kind WHEN 'object' THEN 0 ELSE 1 END,
           generation.member_key COLLATE "C", file.ordinal;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20213_BUILD_INPUT_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
END
$read_materialization_build_members$;

CREATE FUNCTION ops.prepare_materialization_build(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_candidates jsonb
) RETURNS SETOF ops.materialization_build_member_record
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $prepare_materialization_build$
DECLARE
  job_row ops.materialization_jobs%ROWTYPE;
  candidate_count integer;
  member_count integer;
BEGIN
  IF p_candidates IS NULL OR jsonb_typeof(p_candidates) <> 'array' THEN
    RAISE EXCEPTION 'G20213_BUILD_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  candidate_count := jsonb_array_length(p_candidates);
  IF candidate_count NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'G20213_BUILD_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  BEGIN
    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_candidates) AS candidate(
        "memberKey" text, "generationId" text, "forecastId" text
      )
      WHERE candidate."memberKey" !~ '^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$'
        OR candidate."generationId"::uuid IS NULL
        OR candidate."forecastId"::uuid IS NULL
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_candidates) AS candidate(
        "memberKey" text, "generationId" text, "forecastId" text
      )
      GROUP BY candidate."memberKey" HAVING count(*) > 1
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_candidates) AS candidate(
        "memberKey" text, "generationId" text, "forecastId" text
      )
      GROUP BY candidate."generationId" HAVING count(*) > 1
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_candidates) AS candidate(
        "memberKey" text, "generationId" text, "forecastId" text
      )
      GROUP BY candidate."forecastId" HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'G20213_BUILD_INPUT_INVALID' USING ERRCODE = '22023';
    END IF;
  EXCEPTION WHEN invalid_text_representation OR data_exception THEN
    RAISE EXCEPTION 'G20213_BUILD_INPUT_INVALID' USING ERRCODE = '22023';
  END;

  SELECT candidate.* INTO job_row
  FROM ops.materialization_jobs AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.job_id = p_job_id
    AND candidate.state = 'running'
    AND candidate.current_attempt_id = p_attempt_id
    AND candidate.fencing_token = p_fencing_token
    AND candidate.lease_expires_at > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_FENCED' USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock(737213001, hashtext(p_project_id::text || ':' || p_job_id::text));
  SELECT count(*)::integer INTO member_count
  FROM runtime.snapshot_group_members AS member
  WHERE member.project_id = p_project_id
    AND member.snapshot_group_id = job_row.snapshot_group_id
    AND member.group_version = job_row.group_version;
  IF member_count <> candidate_count OR EXISTS (
    SELECT 1
    FROM runtime.snapshot_group_members AS member
    WHERE member.project_id = p_project_id
      AND member.snapshot_group_id = job_row.snapshot_group_id
      AND member.group_version = job_row.group_version
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(p_candidates) AS candidate(
          "memberKey" text, "generationId" text, "forecastId" text
        )
        WHERE candidate."memberKey" = member.member_key
      )
  ) THEN
    RAISE EXCEPTION 'G20213_BUILD_INPUT_INCOMPLETE' USING ERRCODE = '23514';
  END IF;

  -- These lifecycle changes are monotonic and retry-safe. A failed attempt may
  -- leave the immutable source in materializing so a later fenced replay can resume.
  UPDATE runtime.dataset_snapshots AS snapshot
  SET state = 'validated', changed_at = clock_timestamp()
  WHERE snapshot.project_id = p_project_id
    AND snapshot.snapshot_group_id = job_row.snapshot_group_id
    AND snapshot.group_version = job_row.group_version
    AND snapshot.state = 'registered';
  UPDATE runtime.snapshot_group_versions AS version
  SET state = 'validated', changed_at = clock_timestamp()
  WHERE version.project_id = p_project_id
    AND version.snapshot_group_id = job_row.snapshot_group_id
    AND version.group_version = job_row.group_version
    AND version.state = 'registered';
  UPDATE runtime.dataset_snapshots AS snapshot
  SET state = 'materializing', changed_at = clock_timestamp()
  WHERE snapshot.project_id = p_project_id
    AND snapshot.snapshot_group_id = job_row.snapshot_group_id
    AND snapshot.group_version = job_row.group_version
    AND snapshot.state = 'validated';
  UPDATE runtime.snapshot_group_versions AS version
  SET state = 'materializing', changed_at = clock_timestamp()
  WHERE version.project_id = p_project_id
    AND version.snapshot_group_id = job_row.snapshot_group_id
    AND version.group_version = job_row.group_version
    AND version.state = 'validated';

  INSERT INTO runtime.generations (
    project_id, generation_id, member_key, member_kind,
    target_resource_id, target_revision_id, snapshot_id,
    snapshot_group_id, group_version,
    snapshot_schema_resource_id, snapshot_schema_revision_id,
    mapping_resource_id, mapping_revision_id,
    runtime_plan_digest, index_plan_digest, state
  )
  SELECT snapshot.project_id,
         candidate."generationId"::uuid,
         snapshot.member_key,
         snapshot.member_kind,
         snapshot.target_resource_id,
         snapshot.target_revision_id,
         snapshot.snapshot_id,
         snapshot.snapshot_group_id,
         snapshot.group_version,
         snapshot.snapshot_schema_resource_id,
         snapshot.snapshot_schema_revision_id,
         snapshot.mapping_resource_id,
         snapshot.mapping_revision_id,
         snapshot.runtime_plan_digest,
         plan.index_plan_digest,
         'building'
  FROM runtime.dataset_snapshots AS snapshot
  JOIN jsonb_to_recordset(p_candidates) AS candidate(
    "memberKey" text, "generationId" text, "forecastId" text
  ) ON candidate."memberKey" = snapshot.member_key
  JOIN LATERAL (
    SELECT min(member.index_plan_digest)::text AS index_plan_digest
    FROM meta.release_runtime_plan_members AS member
    WHERE member.project_id = snapshot.project_id
      AND member.snapshot_group_id = snapshot.snapshot_group_id
      AND member.member_key = snapshot.member_key
      AND member.runtime_plan_digest = snapshot.runtime_plan_digest
    HAVING count(DISTINCT member.index_plan_digest) = 1
  ) AS plan ON true
  WHERE snapshot.project_id = p_project_id
    AND snapshot.snapshot_group_id = job_row.snapshot_group_id
    AND snapshot.group_version = job_row.group_version
    AND NOT EXISTS (
      SELECT 1 FROM runtime.generations AS existing
      WHERE existing.project_id = snapshot.project_id
        AND existing.snapshot_id = snapshot.snapshot_id
        AND existing.member_key = snapshot.member_key
        AND existing.state IN ('building', 'ready', 'active')
    );

  IF (
    SELECT count(*)
    FROM runtime.generations AS generation
    WHERE generation.project_id = p_project_id
      AND generation.snapshot_group_id = job_row.snapshot_group_id
      AND generation.group_version = job_row.group_version
      AND generation.state IN ('building', 'ready', 'active')
  ) <> member_count THEN
    RAISE EXCEPTION 'G20213_BUILD_INPUT_INCOMPLETE' USING ERRCODE = '23514';
  END IF;

  INSERT INTO runtime.source_forecasts (
    project_id, generation_id, forecast_id,
    object_row_count, link_row_count, source_bytes,
    projected_measured_bytes, scanner_version, forecast_digest
  )
  SELECT generation.project_id,
         generation.generation_id,
         candidate."forecastId"::uuid,
         CASE generation.member_kind WHEN 'object' THEN snapshot.row_count ELSE 0 END,
         CASE generation.member_kind WHEN 'link' THEN snapshot.row_count ELSE 0 END,
         snapshot.byte_count,
         CASE generation.member_kind
           WHEN 'object' THEN greatest(snapshot.byte_count * 4, snapshot.row_count * 1024)
           ELSE greatest(snapshot.byte_count * 3, snapshot.row_count * 256)
         END,
         'materialization-worker-g2-02-13-v1',
         'sha256:' || encode(sha256(convert_to(jsonb_build_object(
           'contractVersion', 'projection-source-forecast-v1',
           'generationId', generation.generation_id,
           'linkRows', CASE generation.member_kind WHEN 'link' THEN snapshot.row_count ELSE 0 END,
           'objectRows', CASE generation.member_kind WHEN 'object' THEN snapshot.row_count ELSE 0 END,
           'projectId', generation.project_id,
           'projectedMeasuredBytes', CASE generation.member_kind
             WHEN 'object' THEN greatest(snapshot.byte_count * 4, snapshot.row_count * 1024)
             ELSE greatest(snapshot.byte_count * 3, snapshot.row_count * 256)
           END,
           'scannerVersion', 'materialization-worker-g2-02-13-v1',
           'schemaVersion', 1,
           'sourceBytes', snapshot.byte_count
         )::text, 'UTF8')), 'hex')
  FROM runtime.generations AS generation
  JOIN runtime.dataset_snapshots AS snapshot
    ON snapshot.project_id = generation.project_id
   AND snapshot.snapshot_id = generation.snapshot_id
  JOIN jsonb_to_recordset(p_candidates) AS candidate(
    "memberKey" text, "generationId" text, "forecastId" text
  ) ON candidate."memberKey" = generation.member_key
  WHERE generation.project_id = p_project_id
    AND generation.snapshot_group_id = job_row.snapshot_group_id
    AND generation.group_version = job_row.group_version
    AND generation.state IN ('building', 'ready', 'active')
  ON CONFLICT (project_id, generation_id) DO NOTHING;

  RETURN QUERY SELECT * FROM ops.read_materialization_build_members(
    p_project_id, p_job_id, p_attempt_id, p_fencing_token
  );
END
$prepare_materialization_build$;

-- A fully rejected file has a legitimate zero-row Base. The original Base
-- protocol required at least one non-empty batch, making that safe result
-- impossible to finalize. This dedicated path creates no data row and still
-- binds the empty promotion to a live fenced attempt and deterministic digest.
CREATE FUNCTION ops.promote_empty_materialization_base(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_generation_id uuid,
  p_expected_stage_digest text
) RETURNS TABLE (row_count bigint, stage_digest text, reused boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $promote_empty_materialization_base$
DECLARE
  generation_kind text;
  prior ops.materialization_generation_stages%ROWTYPE;
  expected_digest text;
BEGIN
  IF p_expected_stage_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ops.materialization_jobs AS job
    WHERE job.project_id = p_project_id AND job.job_id = p_job_id
      AND job.state = 'running' AND job.current_attempt_id = p_attempt_id
      AND job.fencing_token = p_fencing_token
      AND job.lease_expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_FENCED' USING ERRCODE = '55000';
  END IF;
  SELECT generation.member_kind INTO generation_kind
  FROM runtime.generations AS generation
  JOIN ops.materialization_jobs AS job
    ON job.project_id = generation.project_id
   AND job.snapshot_group_id = generation.snapshot_group_id
   AND job.group_version = generation.group_version
  WHERE generation.project_id = p_project_id
    AND generation.generation_id = p_generation_id
    AND generation.state = 'building'
    AND job.job_id = p_job_id
  FOR SHARE OF generation;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM runtime.object_base AS base
    WHERE base.project_id = p_project_id AND base.generation_id = p_generation_id
    UNION ALL
    SELECT 1 FROM runtime.link_base AS base
    WHERE base.project_id = p_project_id AND base.generation_id = p_generation_id
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23514';
  END IF;
  expected_digest := 'sha256:' || encode(sha256(convert_to(
    '{"batches":[],"contractVersion":"base-stage-v1","generationId":' ||
    to_json(p_generation_id::text)::text || ',"schemaVersion":1}', 'UTF8'
  )), 'hex');
  IF expected_digest <> p_expected_stage_digest THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_INCOMPLETE' USING ERRCODE = '23514';
  END IF;

  SELECT stage.* INTO prior
  FROM ops.materialization_generation_stages AS stage
  WHERE stage.project_id = p_project_id
    AND stage.generation_id = p_generation_id
    AND stage.state = 'promoted'
  FOR SHARE;
  IF FOUND THEN
    IF prior.promoted_row_count <> 0 OR prior.stage_digest <> expected_digest
      OR prior.member_kind <> generation_kind THEN
      RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT 0::bigint, expected_digest, true;
    RETURN;
  END IF;

  INSERT INTO ops.materialization_generation_stages (
    project_id, attempt_id, generation_id, job_id, fencing_token,
    member_kind, state, promoted_row_count, stage_digest, promoted_at
  ) VALUES (
    p_project_id, p_attempt_id, p_generation_id, p_job_id, p_fencing_token,
    generation_kind, 'promoted', 0, expected_digest, clock_timestamp()
  );
  RETURN QUERY SELECT 0::bigint, expected_digest, false;
END
$promote_empty_materialization_base$;

-- Once Base has been atomically promoted it is no longer attempt-owned. A
-- later fenced attempt may therefore validate that immutable Base after a
-- checkpoint/restart without manufacturing a second promoted stage.
CREATE OR REPLACE FUNCTION ontos_migration.g20207_assert_live_quality(
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
    WHERE job.project_id = p_project_id
      AND job.job_id = p_job_id
      AND job.state = 'running'
      AND job.current_attempt_id = p_attempt_id
      AND job.fencing_token = p_fencing_token
      AND job.lease_expires_at > clock_timestamp()
      AND generation.generation_id = p_generation_id
      AND generation.state = 'building'
      AND EXISTS (
        SELECT 1
        FROM ops.materialization_generation_stages AS stage
        WHERE stage.project_id = generation.project_id
          AND stage.generation_id = generation.generation_id
          AND stage.state = 'promoted'
      )
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_FENCED' USING ERRCODE = '55000';
  END IF;
END
$g20207_assert_live_quality$;

CREATE FUNCTION ops.verify_materialization_index_inventory(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $verify_materialization_index_inventory$
DECLARE
  result_digest text;
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
  IF EXISTS (
    SELECT 1
    FROM runtime.generations AS generation
    JOIN ops.materialization_jobs AS job
      ON job.project_id = generation.project_id
     AND job.snapshot_group_id = generation.snapshot_group_id
     AND job.group_version = generation.group_version
    JOIN runtime.index_plans AS plan
      ON plan.project_id = generation.project_id
     AND plan.target_resource_id = generation.target_resource_id
     AND plan.target_revision_id = generation.target_revision_id
     AND plan.plan_digest = generation.index_plan_digest
    JOIN runtime.index_plan_entries AS entry
      ON entry.project_id = plan.project_id
     AND entry.index_plan_id = plan.index_plan_id
    LEFT JOIN runtime.index_inventory AS inventory
      ON inventory.project_id = entry.project_id
     AND inventory.index_plan_id = entry.index_plan_id
     AND inventory.entry_key = entry.entry_key
     AND inventory.index_name = entry.index_name
     AND inventory.physical_signature = entry.physical_signature
     AND inventory.state = 'ready'
    WHERE job.project_id = p_project_id
      AND job.job_id = p_job_id
      AND inventory.index_inventory_id IS NULL
  ) THEN
    RAISE EXCEPTION 'G20213_INDEX_INVENTORY_INCOMPLETE' USING ERRCODE = '55000';
  END IF;
  SELECT 'sha256:' || encode(sha256(convert_to(COALESCE(string_agg(
    generation.generation_id::text || ':' || generation.index_plan_digest,
    E'\n' ORDER BY generation.generation_id
  ) || E'\n', ''), 'UTF8')), 'hex')
  INTO result_digest
  FROM runtime.generations AS generation
  JOIN ops.materialization_jobs AS job
    ON job.project_id = generation.project_id
   AND job.snapshot_group_id = generation.snapshot_group_id
   AND job.group_version = generation.group_version
  WHERE job.project_id = p_project_id AND job.job_id = p_job_id
    AND generation.state IN ('building', 'ready', 'active');
  RETURN result_digest;
END
$verify_materialization_index_inventory$;

CREATE FUNCTION runtime.rebind_materialization_index_admissions(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $rebind_materialization_index_admissions$
DECLARE
  current_revision bigint;
  release_plan record;
  prior runtime.index_plan_admissions%ROWTYPE;
  current_release_units integer;
  current_union_units integer;
  current_physical_count integer;
  selected_mode text;
  selected_approval_id uuid;
  selected_approval_expires_at timestamptz;
  report_digest_value text;
  inserted_count integer := 0;
  changed integer;
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
  SELECT inventory.inventory_revision INTO current_revision
  FROM runtime.project_runtime_inventories AS inventory
  WHERE inventory.project_id = p_project_id AND inventory.measurement_complete
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAPACITY_INVENTORY_STALE' USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(sum(distinct_entry.unit_cost), 0)::integer,
         count(*)::integer
  INTO current_union_units, current_physical_count
  FROM (
    SELECT entry.physical_signature, max(entry.unit_cost) AS unit_cost
    FROM runtime.index_inventory AS inventory
    JOIN runtime.index_plan_entries AS entry
      ON entry.project_id = inventory.project_id
     AND entry.index_plan_id = inventory.index_plan_id
     AND entry.entry_key = inventory.entry_key
     AND entry.physical_signature = inventory.physical_signature
    WHERE inventory.project_id = p_project_id AND inventory.state = 'ready'
    GROUP BY entry.physical_signature
  ) AS distinct_entry;
  IF current_union_units > 240 OR current_physical_count > 160 THEN
    RAISE EXCEPTION 'INDEX_HARD_LIMIT_EXCEEDED' USING ERRCODE = '54000';
  END IF;

  FOR release_plan IN
    SELECT DISTINCT member.release_id, plan.index_plan_id
    FROM ops.materialization_jobs AS job
    JOIN meta.release_runtime_plan_members AS member
      ON member.project_id = job.project_id
     AND member.snapshot_group_id = job.snapshot_group_id
     AND member.member_kind = 'object'
    JOIN runtime.index_plans AS plan
      ON plan.project_id = member.project_id
     AND plan.target_resource_id = member.target_resource_id
     AND plan.target_revision_id = member.target_revision_id
     AND plan.plan_digest = member.index_plan_digest
    WHERE job.project_id = p_project_id AND job.job_id = p_job_id
    ORDER BY member.release_id, plan.index_plan_id
  LOOP
    IF EXISTS (
      SELECT 1 FROM runtime.index_plan_admissions AS admission
      WHERE admission.project_id = p_project_id
        AND admission.release_id = release_plan.release_id
        AND admission.index_plan_id = release_plan.index_plan_id
        AND admission.inventory_revision = current_revision
    ) THEN
      CONTINUE;
    END IF;
    SELECT admission.* INTO prior
    FROM runtime.index_plan_admissions AS admission
    WHERE admission.project_id = p_project_id
      AND admission.release_id = release_plan.release_id
      AND admission.index_plan_id = release_plan.index_plan_id
    ORDER BY admission.inventory_revision DESC, admission.admitted_at DESC
    LIMIT 1
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CAPACITY_INVENTORY_STALE' USING ERRCODE = '40001';
    END IF;
    SELECT COALESCE(sum(entry.unit_cost), 0)::integer INTO current_release_units
    FROM runtime.index_plan_entries AS entry
    WHERE entry.project_id = p_project_id
      AND entry.index_plan_id = release_plan.index_plan_id;
    IF current_release_units > 104 THEN
      RAISE EXCEPTION 'INDEX_HARD_LIMIT_EXCEEDED' USING ERRCODE = '54000';
    END IF;

    selected_approval_id := NULL;
    selected_approval_expires_at := NULL;
    IF current_release_units <= 80
      AND current_union_units <= 120
      AND current_physical_count <= 80 THEN
      selected_mode := 'WITHIN_NORMAL';
    ELSIF prior.admission_mode = 'NON_EXPANDING_OVERAGE'
      AND current_release_units <= prior.release_units
      AND current_union_units <= prior.project_union_units
      AND current_physical_count <= prior.project_physical_index_count THEN
      selected_mode := 'NON_EXPANDING_OVERAGE';
    ELSIF prior.approval_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM runtime.capacity_approvals AS approval
      WHERE approval.project_id = prior.project_id
        AND approval.approval_id = prior.approval_id
        AND approval.state = 'active'
        AND approval.expires_at = prior.approval_expires_at
        AND approval.expires_at > clock_timestamp()
    ) THEN
      selected_mode := 'APPROVED_OVERAGE';
      selected_approval_id := prior.approval_id;
      selected_approval_expires_at := prior.approval_expires_at;
    ELSE
      RAISE EXCEPTION 'INDEX_PROJECT_BUDGET_EXCEEDED' USING ERRCODE = '54000';
    END IF;

    report_digest_value := 'sha256:' || encode(sha256(convert_to(jsonb_build_object(
      'admissionMode', selected_mode,
      'approvalId', selected_approval_id,
      'contractVersion', 'index-plan-revalidation-v1',
      'indexPlanId', release_plan.index_plan_id,
      'inventoryRevision', current_revision,
      'projectId', p_project_id,
      'projectPhysicalIndexCount', current_physical_count,
      'projectUnionUnits', current_union_units,
      'releaseId', release_plan.release_id,
      'releasePlanDigest', prior.release_plan_digest,
      'releaseUnits', current_release_units,
      'schemaVersion', 1
    )::text, 'UTF8')), 'hex');
    INSERT INTO runtime.index_plan_admissions (
      project_id, admission_id, release_id, release_plan_digest,
      index_plan_id, inventory_revision, release_units, project_union_units,
      project_physical_index_count, admission_mode, approval_id,
      approval_expires_at, report_digest
    ) VALUES (
      p_project_id, gen_random_uuid(), release_plan.release_id,
      prior.release_plan_digest, release_plan.index_plan_id, current_revision,
      current_release_units, current_union_units, current_physical_count,
      selected_mode, selected_approval_id, selected_approval_expires_at,
      report_digest_value
    ) ON CONFLICT (project_id, release_id, index_plan_id, inventory_revision) DO NOTHING;
    GET DIAGNOSTICS changed = ROW_COUNT;
    inserted_count := inserted_count + changed;
  END LOOP;
  RETURN inserted_count;
END
$rebind_materialization_index_admissions$;

CREATE FUNCTION ops.finish_materialization_build(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $finish_materialization_build$
DECLARE
  job_row ops.materialization_jobs%ROWTYPE;
  inventory_revision bigint;
  inventory_digest text;
  result_digest text;
  expected_members integer;
BEGIN
  SELECT candidate.* INTO job_row
  FROM ops.materialization_jobs AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.job_id = p_job_id
    AND candidate.state = 'running'
    AND candidate.current_attempt_id = p_attempt_id
    AND candidate.fencing_token = p_fencing_token
    AND candidate.lease_expires_at > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_FENCED' USING ERRCODE = '55000';
  END IF;
  SELECT version.member_count INTO expected_members
  FROM runtime.snapshot_group_versions AS version
  WHERE version.project_id = p_project_id
    AND version.snapshot_group_id = job_row.snapshot_group_id
    AND version.group_version = job_row.group_version
  FOR UPDATE;
  SELECT inventory.inventory_revision, inventory.inventory_digest
  INTO inventory_revision, inventory_digest
  FROM runtime.project_runtime_inventories AS inventory
  WHERE inventory.project_id = p_project_id AND inventory.measurement_complete
  FOR SHARE;
  IF expected_members IS NULL OR inventory_revision IS NULL THEN
    RAISE EXCEPTION 'G20213_BUILD_NOT_READY' USING ERRCODE = '55000';
  END IF;
  IF (
    SELECT count(*)
    FROM runtime.generations AS generation
    JOIN runtime.materialization_quality_bindings AS quality
      ON quality.project_id = generation.project_id
     AND quality.generation_id = generation.generation_id
     AND quality.state IN ('passed', 'confirmed')
     AND quality.zero_overlay_row_count = 0
    JOIN runtime.capacity_admissions AS capacity
      ON capacity.project_id = generation.project_id
     AND capacity.generation_id = generation.generation_id
     AND capacity.phase = 'POSTBUILD'
     AND capacity.inventory_revision = inventory_revision
     AND capacity.physical_measurement_digest = inventory_digest
     AND capacity.report ->> 'accepted' = 'true'
     AND (
       capacity.approval_id IS NULL OR EXISTS (
         SELECT 1 FROM runtime.capacity_approvals AS approval
         WHERE approval.project_id = capacity.project_id
           AND approval.approval_id = capacity.approval_id
           AND approval.state = 'active'
           AND approval.expires_at = capacity.approval_expires_at
           AND approval.expires_at > clock_timestamp()
       )
     )
    WHERE generation.project_id = p_project_id
      AND generation.snapshot_group_id = job_row.snapshot_group_id
      AND generation.group_version = job_row.group_version
      AND generation.state IN ('building', 'ready', 'active')
  ) <> expected_members THEN
    RAISE EXCEPTION 'G20213_BUILD_NOT_READY' USING ERRCODE = '55000';
  END IF;
  PERFORM ops.verify_materialization_index_inventory(
    p_project_id, p_job_id, p_attempt_id, p_fencing_token
  );
  IF EXISTS (
    SELECT 1
    FROM runtime.generations AS generation
    JOIN meta.release_runtime_plan_members AS member
      ON member.project_id = generation.project_id
     AND member.snapshot_group_id = generation.snapshot_group_id
     AND member.member_key = generation.member_key
     AND member.member_kind = 'object'
    JOIN runtime.index_plans AS plan
      ON plan.project_id = member.project_id
     AND plan.target_resource_id = member.target_resource_id
     AND plan.target_revision_id = member.target_revision_id
     AND plan.plan_digest = member.index_plan_digest
    WHERE generation.project_id = p_project_id
      AND generation.snapshot_group_id = job_row.snapshot_group_id
      AND generation.group_version = job_row.group_version
      AND NOT EXISTS (
        SELECT 1 FROM runtime.index_plan_admissions AS admission
        WHERE admission.project_id = member.project_id
          AND admission.release_id = member.release_id
          AND admission.index_plan_id = plan.index_plan_id
          AND admission.inventory_revision = inventory_revision
      )
  ) THEN
    RAISE EXCEPTION 'CAPACITY_INVENTORY_STALE' USING ERRCODE = '40001';
  END IF;

  UPDATE runtime.generations AS generation
  SET state = 'ready', changed_at = clock_timestamp()
  WHERE generation.project_id = p_project_id
    AND generation.snapshot_group_id = job_row.snapshot_group_id
    AND generation.group_version = job_row.group_version
    AND generation.state = 'building';
  UPDATE runtime.dataset_snapshots AS snapshot
  SET state = 'ready', changed_at = clock_timestamp()
  WHERE snapshot.project_id = p_project_id
    AND snapshot.snapshot_group_id = job_row.snapshot_group_id
    AND snapshot.group_version = job_row.group_version
    AND snapshot.state = 'materializing';
  UPDATE runtime.snapshot_group_versions AS version
  SET state = 'ready', changed_at = clock_timestamp()
  WHERE version.project_id = p_project_id
    AND version.snapshot_group_id = job_row.snapshot_group_id
    AND version.group_version = job_row.group_version
    AND version.state = 'materializing';

  SELECT 'sha256:' || encode(sha256(convert_to(
    COALESCE(string_agg(
      generation.member_key || ':' || generation.generation_id::text || ':' ||
      generation.generation_digest,
      E'\n' ORDER BY generation.member_key COLLATE "C"
    ) || E'\n', ''), 'UTF8')), 'hex')
  INTO result_digest
  FROM runtime.generations AS generation
  WHERE generation.project_id = p_project_id
    AND generation.snapshot_group_id = job_row.snapshot_group_id
    AND generation.group_version = job_row.group_version
    AND generation.state IN ('ready', 'active');
  RETURN result_digest;
END
$finish_materialization_build$;

REVOKE ALL PRIVILEGES ON FUNCTION
  ops.discover_materialization_build_member_keys(uuid, uuid, uuid, bigint),
  ops.read_materialization_build_members(uuid, uuid, uuid, bigint),
  ops.prepare_materialization_build(uuid, uuid, uuid, bigint, jsonb),
  ops.promote_empty_materialization_base(uuid, uuid, uuid, bigint, uuid, text),
  ops.verify_materialization_index_inventory(uuid, uuid, uuid, bigint),
  runtime.rebind_materialization_index_admissions(uuid, uuid, uuid, bigint),
  ops.finish_materialization_build(uuid, uuid, uuid, bigint)
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT EXECUTE ON FUNCTION
  ops.discover_materialization_build_member_keys(uuid, uuid, uuid, bigint),
  ops.read_materialization_build_members(uuid, uuid, uuid, bigint),
  ops.prepare_materialization_build(uuid, uuid, uuid, bigint, jsonb),
  ops.promote_empty_materialization_base(uuid, uuid, uuid, bigint, uuid, text),
  ops.verify_materialization_index_inventory(uuid, uuid, uuid, bigint),
  runtime.rebind_materialization_index_admissions(uuid, uuid, uuid, bigint),
  ops.finish_materialization_build(uuid, uuid, uuid, bigint)
TO worker_runtime;
