SET LOCAL ROLE migration_owner;

-- G2-02-14 closes the reference-deployment promise that at most one Project
-- may own data-bearing Materialization state. The singleton claim is durable
-- and transactionally acquired by the same function that enqueues the first
-- Job, so two Projects cannot both pass a check-then-insert race.

CREATE TABLE runtime.data_bearing_project_guard (
  singleton smallint PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  project_id uuid NOT NULL REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $backfill_data_bearing_project_guard$
DECLARE
  existing_projects integer;
BEGIN
  SELECT count(*) INTO existing_projects
  FROM (
    SELECT project_id FROM runtime.generations
    UNION
    SELECT project_id FROM ops.materialization_jobs
  ) AS bearing_projects;
  IF existing_projects > 1 THEN
    RAISE EXCEPTION 'G20214_EXISTING_DATA_BEARING_PROJECT_LIMIT_EXCEEDED'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO runtime.data_bearing_project_guard (singleton, project_id)
  SELECT 1, project_id
  FROM (
    SELECT project_id FROM runtime.generations
    UNION
    SELECT project_id FROM ops.materialization_jobs
  ) AS bearing_projects
  ORDER BY project_id::text
  LIMIT 1;
END
$backfill_data_bearing_project_guard$;

CREATE OR REPLACE FUNCTION ops.enqueue_materialization_job(
  p_project_id uuid,
  p_job_id uuid,
  p_snapshot_group_id uuid,
  p_group_version bigint,
  p_idempotency_key text,
  p_input_digest text,
  p_correlation_id uuid,
  p_priority integer DEFAULT 0
) RETURNS TABLE (job_id uuid, state text, reused boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $enqueue_materialization_job$
DECLARE
  existing ops.materialization_jobs%ROWTYPE;
  claimed_project_id uuid;
  inserted_count integer;
BEGIN
  IF p_project_id IS NULL OR p_job_id IS NULL OR p_snapshot_group_id IS NULL
    OR p_correlation_id IS NULL OR p_group_version < 1
    OR p_priority NOT BETWEEN -100 AND 100
    OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$'
    OR p_input_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'G20208_JOB_ENQUEUE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO runtime.data_bearing_project_guard (singleton, project_id)
  VALUES (1, p_project_id)
  ON CONFLICT (singleton) DO NOTHING;
  SELECT guard.project_id INTO claimed_project_id
  FROM runtime.data_bearing_project_guard AS guard
  WHERE guard.singleton = 1
  FOR UPDATE;
  IF claimed_project_id IS DISTINCT FROM p_project_id THEN
    RAISE EXCEPTION 'G20214_DATA_BEARING_PROJECT_LIMIT_EXCEEDED'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO ops.materialization_jobs (
    project_id, job_id, snapshot_group_id, group_version,
    idempotency_key, input_digest, correlation_id, priority
  ) VALUES (
    p_project_id, p_job_id, p_snapshot_group_id, p_group_version,
    p_idempotency_key, p_input_digest, p_correlation_id, p_priority
  ) ON CONFLICT (project_id, idempotency_key) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  SELECT candidate.* INTO existing
  FROM ops.materialization_jobs AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.idempotency_key = p_idempotency_key;
  IF NOT FOUND OR existing.snapshot_group_id <> p_snapshot_group_id
    OR existing.group_version <> p_group_version
    OR existing.input_digest <> p_input_digest
    OR existing.job_type <> 'materialize_snapshot' THEN
    RAISE EXCEPTION 'MATERIALIZATION_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN QUERY SELECT existing.job_id, existing.state, inserted_count = 0;
END
$enqueue_materialization_job$;

ALTER TABLE runtime.data_bearing_project_guard OWNER TO migration_owner;

REVOKE ALL PRIVILEGES ON TABLE runtime.data_bearing_project_guard
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

REVOKE ALL PRIVILEGES ON FUNCTION
  ops.enqueue_materialization_job(uuid, uuid, uuid, bigint, text, text, uuid, integer)
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT EXECUTE ON FUNCTION
  ops.enqueue_materialization_job(uuid, uuid, uuid, bigint, text, text, uuid, integer)
TO api_runtime;
