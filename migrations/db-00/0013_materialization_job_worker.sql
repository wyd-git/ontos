SET LOCAL ROLE migration_owner;

-- G2-02-08 extends the one DB-02 Job queue created by 0009. It does not
-- introduce a second scheduler or make Materialization stages public state.
ALTER TABLE ops.materialization_jobs
  ADD COLUMN job_type text NOT NULL DEFAULT 'materialize_snapshot'
    CHECK (job_type = 'materialize_snapshot'),
  ADD COLUMN correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN last_observed_database_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN replay_cycle integer NOT NULL DEFAULT 0 CHECK (replay_cycle >= 0),
  ADD COLUMN replay_count integer NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  ADD COLUMN attempts_in_cycle integer NOT NULL DEFAULT 0 CHECK (attempts_in_cycle >= 0),
  ADD COLUMN maximum_attempts_per_cycle smallint NOT NULL DEFAULT 5
    CHECK (maximum_attempts_per_cycle BETWEEN 1 AND 20),
  ADD COLUMN first_failure_code varchar(64),
  ADD COLUMN first_failure_category text,
  ADD COLUMN first_failure_fingerprint varchar(71),
  ADD COLUMN last_failure_code varchar(64),
  ADD COLUMN last_failure_category text,
  ADD COLUMN last_failure_fingerprint varchar(71),
  ADD COLUMN result_digest varchar(71),
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN cancel_requested_by_principal_id uuid,
  ADD COLUMN cancellation_reason_code varchar(64),
  ADD COLUMN cutover_started_at timestamptz,
  ADD COLUMN cutover_completed_at timestamptz,
  ADD COLUMN last_replayed_at timestamptz,
  ADD COLUMN last_replayed_by_principal_id uuid,
  ADD COLUMN last_replay_reason_code varchar(64),
  ADD CONSTRAINT materialization_jobs_failure_shape_ck CHECK (
    (first_failure_code IS NULL AND first_failure_category IS NULL
      AND first_failure_fingerprint IS NULL)
    OR (first_failure_code ~ '^[A-Z][A-Z0-9_]{1,63}$'
      AND first_failure_category IN ('dependency', 'internal', 'lease', 'permanent', 'throttled')
      AND first_failure_fingerprint ~ '^sha256:[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT materialization_jobs_last_failure_shape_ck CHECK (
    (last_failure_code IS NULL AND last_failure_category IS NULL
      AND last_failure_fingerprint IS NULL)
    OR (last_failure_code ~ '^[A-Z][A-Z0-9_]{1,63}$'
      AND last_failure_category IN ('dependency', 'internal', 'lease', 'permanent', 'throttled')
      AND last_failure_fingerprint ~ '^sha256:[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT materialization_jobs_result_digest_ck CHECK (
    result_digest IS NULL OR result_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT materialization_jobs_cancel_shape_ck CHECK (
    (cancel_requested_at IS NULL AND cancel_requested_by_principal_id IS NULL
      AND cancellation_reason_code IS NULL)
    OR (cancel_requested_at IS NOT NULL AND cancel_requested_by_principal_id IS NOT NULL
      AND cancellation_reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$')
  ),
  ADD CONSTRAINT materialization_jobs_cutover_shape_ck CHECK (
    (cutover_started_at IS NULL AND cutover_completed_at IS NULL)
    OR (cutover_started_at IS NOT NULL AND cutover_completed_at IS NOT NULL
      AND cutover_completed_at >= cutover_started_at)
  ),
  ADD CONSTRAINT materialization_jobs_replay_shape_ck CHECK (
    (last_replayed_at IS NULL AND last_replayed_by_principal_id IS NULL
      AND last_replay_reason_code IS NULL)
    OR (last_replayed_at IS NOT NULL AND last_replayed_by_principal_id IS NOT NULL
      AND last_replay_reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$')
  ),
  ADD CONSTRAINT materialization_jobs_cancel_principal_fk
    FOREIGN KEY (cancel_requested_by_principal_id)
    REFERENCES authz.principals(principal_id) ON DELETE RESTRICT,
  ADD CONSTRAINT materialization_jobs_replay_principal_fk
    FOREIGN KEY (last_replayed_by_principal_id)
    REFERENCES authz.principals(principal_id) ON DELETE RESTRICT;

UPDATE ops.materialization_jobs
SET available_at = created_at,
    last_observed_database_at = created_at;

ALTER TABLE ops.materialization_jobs
  DROP CONSTRAINT materialization_jobs_lease_shape_ck,
  ADD CONSTRAINT materialization_jobs_lease_shape_ck CHECK (
    (state = 'running'
      AND current_attempt_id IS NOT NULL AND lease_owner_id IS NOT NULL
      AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL
      AND attempt_count >= 1 AND fencing_token >= 1)
    OR (state <> 'running'
      AND lease_owner_id IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL)
  ),
  ADD CONSTRAINT materialization_jobs_terminal_shape_ck CHECK (
    (state = 'succeeded' AND result_digest IS NOT NULL AND result_code = 'SUCCEEDED')
    OR (state = 'cancelled' AND cancellation_reason_code IS NOT NULL
      AND result_digest IS NULL AND result_code = 'CANCELLED')
    OR (state NOT IN ('succeeded', 'cancelled') AND result_digest IS NULL)
  );

DROP INDEX ops.materialization_jobs_claim_idx;
CREATE INDEX materialization_jobs_claim_v2_idx
  ON ops.materialization_jobs(
    available_at, priority DESC, created_at, project_id, job_id
  )
  WHERE state IN ('queued', 'retry_wait');
CREATE INDEX materialization_jobs_expired_lease_idx
  ON ops.materialization_jobs(lease_expires_at, project_id, job_id)
  WHERE state = 'running';

ALTER TABLE ops.materialization_attempts
  ADD COLUMN replay_cycle integer NOT NULL DEFAULT 0 CHECK (replay_cycle >= 0),
  ADD COLUMN attempt_in_cycle integer NOT NULL DEFAULT 1 CHECK (attempt_in_cycle >= 1),
  ADD COLUMN total_attempt integer NOT NULL DEFAULT 1 CHECK (total_attempt >= 1),
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN failure_category text,
  ADD COLUMN failure_fingerprint varchar(71),
  ADD CONSTRAINT materialization_attempts_failure_shape_ck CHECK (
    (failure_category IS NULL AND failure_fingerprint IS NULL)
    OR (failure_category IN ('dependency', 'internal', 'lease', 'permanent', 'throttled')
      AND failure_fingerprint ~ '^sha256:[0-9a-f]{64}$')
  );

UPDATE ops.materialization_attempts SET heartbeat_at = leased_at;
ALTER TABLE ops.materialization_attempts
  ALTER COLUMN heartbeat_at SET NOT NULL,
  DROP CONSTRAINT materialization_attempts_state_check,
  ADD CONSTRAINT materialization_attempts_state_check CHECK (
    state IN ('leased', 'completed', 'abandoned', 'failed', 'cancelled')
  ),
  ADD CONSTRAINT materialization_attempts_job_identity_uq
    UNIQUE (project_id, attempt_id, job_id);

ALTER TABLE ops.materialization_checkpoints
  ADD COLUMN output_reference_id uuid;
ALTER TABLE ops.materialization_checkpoints
  DISABLE TRIGGER materialization_checkpoints_immutable;
UPDATE ops.materialization_checkpoints SET output_reference_id = checkpoint_id;
ALTER TABLE ops.materialization_checkpoints
  ENABLE TRIGGER materialization_checkpoints_immutable;
ALTER TABLE ops.materialization_checkpoints
  ALTER COLUMN output_reference_id SET NOT NULL,
  DROP CONSTRAINT materialization_checkpoints_output_uq;

CREATE TABLE ops.materialization_job_error_samples (
  project_id uuid NOT NULL,
  job_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 49),
  reason_code varchar(64) NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  classification text NOT NULL
    CHECK (classification IN ('dependency', 'internal', 'lease', 'validation')),
  fingerprint varchar(71) NOT NULL CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, job_id, attempt_id, ordinal),
  CONSTRAINT materialization_job_error_samples_attempt_fk
    FOREIGN KEY (project_id, attempt_id, job_id)
    REFERENCES ops.materialization_attempts(project_id, attempt_id, job_id) ON DELETE RESTRICT
);

CREATE FUNCTION ontos_migration.g20208_retry_backoff_seconds(p_attempt integer)
RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $g20208_retry_backoff_seconds$
  SELECT CASE
    WHEN p_attempt >= 7 THEN 300
    ELSE LEAST(300, (5 * power(2::numeric, p_attempt - 1))::integer)
  END
$g20208_retry_backoff_seconds$;

CREATE OR REPLACE FUNCTION ontos_migration.g20203_enforce_job_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_job_insert$
BEGIN
  IF NEW.state <> 'queued' OR NEW.current_stage IS NOT NULL
    OR NEW.attempt_count <> 0 OR NEW.attempts_in_cycle <> 0
    OR NEW.fencing_token <> 0 OR NEW.replay_cycle <> 0 OR NEW.replay_count <> 0
    OR NEW.current_attempt_id IS NOT NULL OR NEW.lease_owner_id IS NOT NULL
    OR NEW.lease_expires_at IS NOT NULL OR NEW.heartbeat_at IS NOT NULL
    OR NEW.result_code IS NOT NULL OR NEW.result_digest IS NOT NULL
    OR NEW.cancel_requested OR NEW.cancel_requested_at IS NOT NULL
    OR NEW.cutover_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'G20208_JOB_INITIAL_STATE_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20203_job_insert$;

CREATE OR REPLACE FUNCTION ontos_migration.g20203_enforce_job_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_job_update$
DECLARE
  state_allowed boolean;
  claim_transition boolean;
  replay_transition boolean;
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.job_type IS DISTINCT FROM OLD.job_type
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.snapshot_group_id IS DISTINCT FROM OLD.snapshot_group_id
    OR NEW.group_version IS DISTINCT FROM OLD.group_version
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.input_digest IS DISTINCT FROM OLD.input_digest
    OR NEW.priority IS DISTINCT FROM OLD.priority
    OR NEW.maximum_attempts_per_cycle IS DISTINCT FROM OLD.maximum_attempts_per_cycle
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'G20208_JOB_FACT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  state_allowed := NEW.state = OLD.state
    OR (OLD.state = 'queued' AND NEW.state IN ('running', 'cancelled'))
    OR (OLD.state = 'running' AND NEW.state IN (
      'retry_wait', 'succeeded', 'dead_letter', 'cancelled'
    ))
    OR (OLD.state = 'retry_wait' AND NEW.state IN ('running', 'cancelled'))
    OR (OLD.state = 'dead_letter' AND NEW.state IN ('queued', 'cancelled'));
  IF NOT state_allowed THEN
    RAISE EXCEPTION 'G20208_JOB_STATE_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;

  claim_transition := OLD.state IN ('queued', 'retry_wait') AND NEW.state = 'running';
  replay_transition := OLD.state = 'dead_letter' AND NEW.state = 'queued';
  IF claim_transition THEN
    IF NEW.fencing_token <> OLD.fencing_token + 1
      OR NEW.attempt_count <> OLD.attempt_count + 1
      OR NEW.attempts_in_cycle <> OLD.attempts_in_cycle + 1
      OR NEW.current_attempt_id IS NULL OR NEW.lease_owner_id IS NULL
      OR NEW.lease_expires_at IS NULL OR NEW.heartbeat_at IS NULL THEN
      RAISE EXCEPTION 'G20208_JOB_LEASE_TRANSITION_INVALID' USING ERRCODE = '55000';
    END IF;
  ELSIF replay_transition THEN
    IF NEW.fencing_token <> OLD.fencing_token
      OR NEW.attempt_count <> OLD.attempt_count
      OR NEW.current_attempt_id IS DISTINCT FROM OLD.current_attempt_id
      OR NEW.attempts_in_cycle <> 0
      OR NEW.replay_cycle <> OLD.replay_cycle + 1
      OR NEW.replay_count <> OLD.replay_count + 1 THEN
      RAISE EXCEPTION 'G20208_JOB_REPLAY_TRANSITION_INVALID' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.fencing_token <> OLD.fencing_token
    OR NEW.attempt_count <> OLD.attempt_count
    OR NEW.current_attempt_id IS DISTINCT FROM OLD.current_attempt_id
    OR NEW.attempts_in_cycle <> OLD.attempts_in_cycle
    OR NEW.replay_cycle <> OLD.replay_cycle
    OR NEW.replay_count <> OLD.replay_count THEN
    RAISE EXCEPTION 'G20208_JOB_FENCING_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;

  IF OLD.current_stage IS NOT NULL AND NEW.current_stage IS NOT NULL
    AND ontos_migration.g20203_stage_rank(NEW.current_stage)
      < ontos_migration.g20203_stage_rank(OLD.current_stage) THEN
    RAISE EXCEPTION 'G20208_JOB_STAGE_REGRESSION' USING ERRCODE = '55000';
  END IF;
  IF NEW.last_observed_database_at < OLD.last_observed_database_at
    OR NEW.updated_at < OLD.updated_at
    OR (NEW.state IN ('queued', 'retry_wait')
      AND NEW.available_at < NEW.last_observed_database_at) THEN
    RAISE EXCEPTION 'G20208_JOB_TIME_REGRESSION' USING ERRCODE = '55000';
  END IF;
  IF OLD.first_failure_code IS NOT NULL AND (
    NEW.first_failure_code IS DISTINCT FROM OLD.first_failure_code
    OR NEW.first_failure_category IS DISTINCT FROM OLD.first_failure_category
    OR NEW.first_failure_fingerprint IS DISTINCT FROM OLD.first_failure_fingerprint
  ) THEN
    RAISE EXCEPTION 'G20208_JOB_FIRST_FAILURE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD.cutover_started_at IS NOT NULL AND (
    NEW.cutover_started_at IS DISTINCT FROM OLD.cutover_started_at
    OR NEW.cutover_completed_at IS DISTINCT FROM OLD.cutover_completed_at
  ) THEN
    RAISE EXCEPTION 'G20208_JOB_CUTOVER_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.state IN ('succeeded', 'cancelled') AND NEW.state = OLD.state
    AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'G20208_JOB_TERMINAL_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20203_job_update$;

CREATE OR REPLACE FUNCTION ontos_migration.g20203_enforce_attempt_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20203_attempt_update$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
    OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token
    OR NEW.worker_instance_id IS DISTINCT FROM OLD.worker_instance_id
    OR NEW.replay_cycle IS DISTINCT FROM OLD.replay_cycle
    OR NEW.attempt_in_cycle IS DISTINCT FROM OLD.attempt_in_cycle
    OR NEW.total_attempt IS DISTINCT FROM OLD.total_attempt
    OR NEW.leased_at IS DISTINCT FROM OLD.leased_at THEN
    RAISE EXCEPTION 'G20208_ATTEMPT_FACT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
    AND NOT (OLD.state = 'leased'
      AND NEW.state IN ('completed', 'abandoned', 'failed', 'cancelled')) THEN
    RAISE EXCEPTION 'G20208_ATTEMPT_STATE_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> 'leased' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'G20208_ATTEMPT_TERMINAL_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.lease_expires_at < OLD.lease_expires_at OR NEW.heartbeat_at < OLD.heartbeat_at THEN
    RAISE EXCEPTION 'G20208_ATTEMPT_TIME_REGRESSION' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20203_attempt_update$;

CREATE FUNCTION ops.enqueue_materialization_job(
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
  inserted_count integer;
BEGIN
  IF p_project_id IS NULL OR p_job_id IS NULL OR p_snapshot_group_id IS NULL
    OR p_correlation_id IS NULL OR p_group_version < 1
    OR p_priority NOT BETWEEN -100 AND 100
    OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$'
    OR p_input_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'G20208_JOB_ENQUEUE_INPUT_INVALID' USING ERRCODE = '22023';
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

CREATE FUNCTION ops.reap_expired_materialization_jobs(p_limit integer DEFAULT 32)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $reap_expired_materialization_jobs$
DECLARE
  now_at timestamptz := clock_timestamp();
  candidate ops.materialization_jobs%ROWTYPE;
  next_state text;
  processed integer := 0;
  lease_fingerprint constant text :=
    'sha256:49840c9c065ce45b6c240b677fdcfb71d2e843863c0751e06e33befd31c801cb';
BEGIN
  IF p_limit NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'G20208_JOB_REAPER_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR candidate IN
    SELECT job.* FROM ops.materialization_jobs AS job
    WHERE job.state = 'running' AND job.lease_expires_at <= now_at
    ORDER BY job.lease_expires_at, job.project_id, job.job_id
    FOR UPDATE SKIP LOCKED LIMIT p_limit
  LOOP
    IF candidate.last_observed_database_at > now_at THEN
      RAISE EXCEPTION 'G20208_JOB_DATABASE_TIME_REGRESSION' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM ops.materialization_checkpoints AS checkpoint
      WHERE checkpoint.project_id = candidate.project_id
        AND checkpoint.job_id = candidate.job_id
        AND checkpoint.sequence = 8 AND checkpoint.stage = 'activate'
    ) THEN
      UPDATE ops.materialization_attempts AS attempt
      SET state = 'completed', finished_at = now_at, heartbeat_at = now_at,
          lease_expires_at = GREATEST(attempt.lease_expires_at, now_at),
          result_code = 'SUCCEEDED_RECOVERED'
      WHERE attempt.project_id = candidate.project_id
        AND attempt.attempt_id = candidate.current_attempt_id
        AND attempt.job_id = candidate.job_id AND attempt.state = 'leased';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'G20208_JOB_ATTEMPT_MISSING' USING ERRCODE = '55000';
      END IF;
      UPDATE ops.materialization_jobs AS job
      SET state = 'succeeded', lease_owner_id = NULL, lease_expires_at = NULL,
          heartbeat_at = NULL, result_code = 'SUCCEEDED',
          result_digest = (
            SELECT checkpoint.output_digest
            FROM ops.materialization_checkpoints AS checkpoint
            WHERE checkpoint.project_id = candidate.project_id
              AND checkpoint.job_id = candidate.job_id
              AND checkpoint.sequence = 8
          ),
          last_observed_database_at = now_at, updated_at = now_at
      WHERE job.project_id = candidate.project_id AND job.job_id = candidate.job_id;
      processed := processed + 1;
      CONTINUE;
    END IF;
    next_state := CASE
      WHEN candidate.attempts_in_cycle < candidate.maximum_attempts_per_cycle
        THEN 'retry_wait' ELSE 'dead_letter' END;
    UPDATE ops.materialization_attempts AS attempt
    SET state = 'abandoned', finished_at = now_at, heartbeat_at = now_at,
        lease_expires_at = GREATEST(attempt.lease_expires_at, now_at),
        result_code = 'LEASE_EXPIRED', failure_category = 'lease',
        failure_fingerprint = lease_fingerprint
    WHERE attempt.project_id = candidate.project_id
      AND attempt.attempt_id = candidate.current_attempt_id
      AND attempt.job_id = candidate.job_id AND attempt.state = 'leased';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'G20208_JOB_ATTEMPT_MISSING' USING ERRCODE = '55000';
    END IF;

    UPDATE ops.materialization_jobs AS job
    SET state = next_state,
        available_at = CASE WHEN next_state = 'retry_wait'
          THEN now_at + ontos_migration.g20208_retry_backoff_seconds(
            candidate.attempts_in_cycle
          ) * interval '1 second'
          ELSE now_at END,
        lease_owner_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
        first_failure_code = COALESCE(job.first_failure_code, 'LEASE_EXPIRED'),
        first_failure_category = COALESCE(job.first_failure_category, 'lease'),
        first_failure_fingerprint = COALESCE(job.first_failure_fingerprint, lease_fingerprint),
        last_failure_code = 'LEASE_EXPIRED', last_failure_category = 'lease',
        last_failure_fingerprint = lease_fingerprint,
        result_code = CASE WHEN next_state = 'retry_wait'
          THEN 'RETRY_SCHEDULED' ELSE 'DEAD_LETTER' END,
        last_observed_database_at = now_at, updated_at = now_at
    WHERE job.project_id = candidate.project_id AND job.job_id = candidate.job_id;
    processed := processed + 1;
  END LOOP;
  RETURN processed;
END
$reap_expired_materialization_jobs$;

CREATE FUNCTION ops.claim_materialization_job_v2(
  p_worker_instance_id uuid,
  p_attempt_id uuid,
  p_lease_seconds integer
) RETURNS TABLE (
  project_id uuid,
  job_id uuid,
  snapshot_group_id uuid,
  group_version bigint,
  input_digest text,
  attempt_number integer,
  attempt_id uuid,
  fencing_token bigint,
  lease_expires_at timestamptz,
  checkpoint_id uuid,
  checkpoint_sequence bigint,
  checkpoint_stage text,
  output_reference_id uuid,
  output_digest text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $claim_materialization_job_v2$
DECLARE
  now_at timestamptz := clock_timestamp();
  lease_deadline timestamptz;
  claimed ops.materialization_jobs%ROWTYPE;
  latest ops.materialization_checkpoints%ROWTYPE;
BEGIN
  IF p_worker_instance_id IS NULL OR p_attempt_id IS NULL
    OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'G20208_JOB_CLAIM_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT candidate.* INTO claimed
  FROM ops.materialization_jobs AS candidate
  WHERE candidate.state IN ('queued', 'retry_wait')
    AND candidate.available_at <= now_at
    AND candidate.last_observed_database_at <= now_at
    AND NOT candidate.cancel_requested
  -- Availability age is the first key so a continuous stream of newer
  -- high-priority work cannot starve an older eligible Job forever.
  ORDER BY candidate.available_at, candidate.priority DESC, candidate.created_at,
           candidate.project_id, candidate.job_id
  FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  lease_deadline := now_at + p_lease_seconds * interval '1 second';
  UPDATE ops.materialization_jobs AS job
  SET state = 'running', attempt_count = claimed.attempt_count + 1,
      attempts_in_cycle = claimed.attempts_in_cycle + 1,
      current_attempt_id = p_attempt_id,
      fencing_token = claimed.fencing_token + 1,
      lease_owner_id = p_worker_instance_id,
      lease_expires_at = lease_deadline, heartbeat_at = now_at,
      available_at = now_at, last_observed_database_at = now_at,
      result_code = NULL, updated_at = now_at
  WHERE job.project_id = claimed.project_id AND job.job_id = claimed.job_id;

  INSERT INTO ops.materialization_attempts (
    project_id, attempt_id, job_id, attempt_number, fencing_token,
    worker_instance_id, replay_cycle, attempt_in_cycle, total_attempt,
    leased_at, lease_expires_at, heartbeat_at
  ) VALUES (
    claimed.project_id, p_attempt_id, claimed.job_id, claimed.attempt_count + 1,
    claimed.fencing_token + 1, p_worker_instance_id, claimed.replay_cycle,
    claimed.attempts_in_cycle + 1, claimed.attempt_count + 1,
    now_at, lease_deadline, now_at
  );

  SELECT checkpoint.* INTO latest
  FROM ops.materialization_checkpoints AS checkpoint
  WHERE checkpoint.project_id = claimed.project_id
    AND checkpoint.job_id = claimed.job_id
  ORDER BY checkpoint.sequence DESC LIMIT 1;

  RETURN QUERY SELECT claimed.project_id, claimed.job_id, claimed.snapshot_group_id,
    claimed.group_version, claimed.input_digest::text, claimed.attempt_count + 1,
    p_attempt_id, claimed.fencing_token + 1, lease_deadline,
    latest.checkpoint_id, latest.sequence, latest.stage::text,
    latest.output_reference_id, latest.output_digest::text;
END
$claim_materialization_job_v2$;

CREATE FUNCTION ops.heartbeat_materialization_job(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_worker_instance_id uuid,
  p_fencing_token bigint,
  p_lease_seconds integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $heartbeat_materialization_job$
DECLARE
  now_at timestamptz := clock_timestamp();
  lease_deadline timestamptz;
BEGIN
  IF p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'G20208_JOB_HEARTBEAT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  lease_deadline := now_at + p_lease_seconds * interval '1 second';
  UPDATE ops.materialization_jobs AS job
  SET lease_expires_at = lease_deadline, heartbeat_at = now_at,
      last_observed_database_at = now_at, updated_at = now_at
  WHERE job.project_id = p_project_id AND job.job_id = p_job_id
    AND job.state = 'running' AND job.current_attempt_id = p_attempt_id
    AND job.lease_owner_id = p_worker_instance_id
    AND job.fencing_token = p_fencing_token
    AND job.lease_expires_at > now_at
    AND job.last_observed_database_at <= now_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_FENCED' USING ERRCODE = '55000';
  END IF;
  UPDATE ops.materialization_attempts AS attempt
  SET lease_expires_at = lease_deadline, heartbeat_at = now_at
  WHERE attempt.project_id = p_project_id AND attempt.attempt_id = p_attempt_id
    AND attempt.job_id = p_job_id AND attempt.worker_instance_id = p_worker_instance_id
    AND attempt.fencing_token = p_fencing_token AND attempt.state = 'leased';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20208_JOB_ATTEMPT_MISSING' USING ERRCODE = '55000';
  END IF;
END
$heartbeat_materialization_job$;

CREATE FUNCTION ops.read_materialization_job_control(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_worker_instance_id uuid,
  p_fencing_token bigint
) RETURNS TABLE (state text, cancel_requested boolean)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog
AS $read_materialization_job_control$
  SELECT job.state, job.cancel_requested
  FROM ops.materialization_jobs AS job
  CROSS JOIN LATERAL (SELECT clock_timestamp() AS now_at) AS db_clock
  WHERE job.project_id = p_project_id AND job.job_id = p_job_id
    AND job.state = 'running' AND job.current_attempt_id = p_attempt_id
    AND job.lease_owner_id = p_worker_instance_id
    AND job.fencing_token = p_fencing_token
    AND job.lease_expires_at > db_clock.now_at
    AND job.last_observed_database_at <= db_clock.now_at
$read_materialization_job_control$;

CREATE FUNCTION ops.complete_materialization_stage(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_worker_instance_id uuid,
  p_fencing_token bigint,
  p_checkpoint_id uuid,
  p_sequence bigint,
  p_stage text,
  p_output_reference_id uuid,
  p_output_digest text
) RETURNS TABLE (
  checkpoint_id uuid,
  sequence bigint,
  stage text,
  output_reference_id uuid,
  output_digest text
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $complete_materialization_stage$
DECLARE
  now_at timestamptz := clock_timestamp();
  job_row ops.materialization_jobs%ROWTYPE;
  existing ops.materialization_checkpoints%ROWTYPE;
  latest_sequence bigint;
BEGIN
  IF p_checkpoint_id IS NULL OR p_output_reference_id IS NULL
    OR p_sequence <> ontos_migration.g20203_stage_rank(p_stage)
    OR p_output_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'G20208_JOB_CHECKPOINT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT candidate.* INTO job_row
  FROM ops.materialization_jobs AS candidate
  WHERE candidate.project_id = p_project_id AND candidate.job_id = p_job_id
  FOR UPDATE;
  IF NOT FOUND OR job_row.state <> 'running'
    OR job_row.current_attempt_id <> p_attempt_id
    OR job_row.lease_owner_id <> p_worker_instance_id
    OR job_row.fencing_token <> p_fencing_token
    OR job_row.lease_expires_at <= now_at
    OR job_row.last_observed_database_at > now_at THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_FENCED' USING ERRCODE = '55000';
  END IF;

  SELECT checkpoint.* INTO existing
  FROM ops.materialization_checkpoints AS checkpoint
  WHERE checkpoint.project_id = p_project_id AND checkpoint.job_id = p_job_id
    AND checkpoint.sequence = p_sequence;
  IF FOUND THEN
    IF existing.checkpoint_id <> p_checkpoint_id OR existing.stage <> p_stage
      OR existing.output_reference_id <> p_output_reference_id
      OR existing.output_digest <> p_output_digest THEN
      RAISE EXCEPTION 'MATERIALIZATION_JOB_PROTOCOL_CONFLICT' USING ERRCODE = '40001';
    END IF;
    RETURN QUERY SELECT existing.checkpoint_id, existing.sequence, existing.stage::text,
      existing.output_reference_id, existing.output_digest::text;
    RETURN;
  END IF;

  SELECT COALESCE(max(checkpoint.sequence), 0) INTO latest_sequence
  FROM ops.materialization_checkpoints AS checkpoint
  WHERE checkpoint.project_id = p_project_id AND checkpoint.job_id = p_job_id;
  IF p_sequence <> latest_sequence + 1 THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_PROTOCOL_CONFLICT' USING ERRCODE = '40001';
  END IF;

  INSERT INTO ops.materialization_checkpoints (
    project_id, checkpoint_id, job_id, attempt_id, fencing_token,
    sequence, stage, completed_batch_sequence, output_reference_id, output_digest
  ) VALUES (
    p_project_id, p_checkpoint_id, p_job_id, p_attempt_id, p_fencing_token,
    p_sequence, p_stage, p_sequence, p_output_reference_id, p_output_digest
  ) RETURNING * INTO existing;

  UPDATE ops.materialization_jobs AS job
  SET current_stage = p_stage, heartbeat_at = now_at,
      last_observed_database_at = now_at, updated_at = now_at,
      cutover_started_at = CASE WHEN p_stage = 'activate' THEN now_at
        ELSE job.cutover_started_at END,
      cutover_completed_at = CASE WHEN p_stage = 'activate' THEN now_at
        ELSE job.cutover_completed_at END
  WHERE job.project_id = p_project_id AND job.job_id = p_job_id;

  RETURN QUERY SELECT existing.checkpoint_id, existing.sequence, existing.stage::text,
    existing.output_reference_id, existing.output_digest::text;
END
$complete_materialization_stage$;

CREATE FUNCTION ops.succeed_materialization_job(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_worker_instance_id uuid,
  p_fencing_token bigint,
  p_result_digest text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $succeed_materialization_job$
DECLARE
  now_at timestamptz := clock_timestamp();
  latest ops.materialization_checkpoints%ROWTYPE;
BEGIN
  IF p_result_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'G20208_JOB_SUCCESS_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM ops.materialization_jobs AS job
  WHERE job.project_id = p_project_id AND job.job_id = p_job_id
    AND job.state = 'running' AND job.current_attempt_id = p_attempt_id
    AND job.lease_owner_id = p_worker_instance_id
    AND job.fencing_token = p_fencing_token
    AND job.lease_expires_at > now_at
    AND job.last_observed_database_at <= now_at
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_FENCED' USING ERRCODE = '55000';
  END IF;
  SELECT checkpoint.* INTO latest
  FROM ops.materialization_checkpoints AS checkpoint
  WHERE checkpoint.project_id = p_project_id AND checkpoint.job_id = p_job_id
  ORDER BY checkpoint.sequence DESC LIMIT 1;
  IF NOT FOUND OR latest.sequence <> 8 OR latest.stage <> 'activate'
    OR latest.output_digest <> p_result_digest THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_PROTOCOL_CONFLICT' USING ERRCODE = '55000';
  END IF;
  UPDATE ops.materialization_attempts AS attempt
  SET state = 'completed', finished_at = now_at, heartbeat_at = now_at,
      lease_expires_at = GREATEST(attempt.lease_expires_at, now_at),
      result_code = 'SUCCEEDED'
  WHERE attempt.project_id = p_project_id AND attempt.attempt_id = p_attempt_id
    AND attempt.state = 'leased';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20208_JOB_ATTEMPT_MISSING' USING ERRCODE = '55000';
  END IF;
  UPDATE ops.materialization_jobs AS job
  SET state = 'succeeded', lease_owner_id = NULL, lease_expires_at = NULL,
      heartbeat_at = NULL, result_code = 'SUCCEEDED', result_digest = p_result_digest,
      last_observed_database_at = now_at, updated_at = now_at
  WHERE job.project_id = p_project_id AND job.job_id = p_job_id;
END
$succeed_materialization_job$;

CREATE FUNCTION ops.fail_materialization_job(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_worker_instance_id uuid,
  p_fencing_token bigint,
  p_failure_code text,
  p_failure_category text,
  p_retryable boolean,
  p_failure_fingerprint text,
  p_samples jsonb
) RETURNS TABLE (state text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $fail_materialization_job$
DECLARE
  now_at timestamptz := clock_timestamp();
  job_row ops.materialization_jobs%ROWTYPE;
  next_state text;
BEGIN
  IF p_failure_code !~ '^[A-Z][A-Z0-9_]{1,63}$'
    OR p_failure_category NOT IN ('dependency', 'internal', 'lease', 'permanent', 'throttled')
    OR (p_failure_category = 'permanent' AND p_retryable)
    OR p_failure_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    OR p_samples IS NULL OR jsonb_typeof(p_samples) <> 'array'
    OR jsonb_array_length(p_samples) > 50
    OR octet_length(p_samples::text) > 32768
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_samples) AS item(value)
      WHERE jsonb_typeof(item.value) <> 'object'
        OR item.value - ARRAY['reasonCode', 'classification', 'fingerprint']::text[] <> '{}'::jsonb
        OR item.value ->> 'reasonCode' IS NULL
        OR item.value ->> 'reasonCode' !~ '^[A-Z][A-Z0-9_]{1,63}$'
        OR item.value ->> 'classification' IS NULL
        OR item.value ->> 'classification'
          NOT IN ('dependency', 'internal', 'lease', 'validation')
        OR item.value ->> 'fingerprint' IS NULL
        OR item.value ->> 'fingerprint' !~ '^sha256:[0-9a-f]{64}$'
    ) THEN
    RAISE EXCEPTION 'G20208_JOB_FAILURE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT candidate.* INTO job_row
  FROM ops.materialization_jobs AS candidate
  WHERE candidate.project_id = p_project_id AND candidate.job_id = p_job_id
  FOR UPDATE;
  IF NOT FOUND OR job_row.state <> 'running'
    OR job_row.current_attempt_id <> p_attempt_id
    OR job_row.lease_owner_id <> p_worker_instance_id
    OR job_row.fencing_token <> p_fencing_token
    OR job_row.lease_expires_at <= now_at
    OR job_row.last_observed_database_at > now_at THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_FENCED' USING ERRCODE = '55000';
  END IF;
  next_state := CASE
    WHEN p_retryable AND p_failure_category <> 'permanent'
      AND job_row.attempts_in_cycle < job_row.maximum_attempts_per_cycle
      THEN 'retry_wait' ELSE 'dead_letter' END;

  UPDATE ops.materialization_attempts AS attempt
  SET state = 'failed', finished_at = now_at, heartbeat_at = now_at,
      lease_expires_at = GREATEST(attempt.lease_expires_at, now_at),
      result_code = p_failure_code, failure_category = p_failure_category,
      failure_fingerprint = p_failure_fingerprint
  WHERE attempt.project_id = p_project_id AND attempt.attempt_id = p_attempt_id
    AND attempt.job_id = p_job_id AND attempt.state = 'leased';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20208_JOB_ATTEMPT_MISSING' USING ERRCODE = '55000';
  END IF;

  INSERT INTO ops.materialization_job_error_samples (
    project_id, job_id, attempt_id, ordinal,
    reason_code, classification, fingerprint
  )
  SELECT p_project_id, p_job_id, p_attempt_id, (item.ordinality - 1)::smallint,
    item.value ->> 'reasonCode', item.value ->> 'classification',
    item.value ->> 'fingerprint'
  FROM jsonb_array_elements(p_samples) WITH ORDINALITY AS item(value, ordinality);

  UPDATE ops.materialization_jobs AS job
  SET state = next_state,
      available_at = CASE WHEN next_state = 'retry_wait'
        THEN now_at + ontos_migration.g20208_retry_backoff_seconds(
          job_row.attempts_in_cycle
        ) * interval '1 second'
        ELSE now_at END,
      lease_owner_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
      first_failure_code = COALESCE(job.first_failure_code, p_failure_code),
      first_failure_category = COALESCE(job.first_failure_category, p_failure_category),
      first_failure_fingerprint = COALESCE(job.first_failure_fingerprint, p_failure_fingerprint),
      last_failure_code = p_failure_code, last_failure_category = p_failure_category,
      last_failure_fingerprint = p_failure_fingerprint,
      result_code = CASE WHEN next_state = 'retry_wait'
        THEN 'RETRY_SCHEDULED' ELSE 'DEAD_LETTER' END,
      last_observed_database_at = now_at, updated_at = now_at
  WHERE job.project_id = p_project_id AND job.job_id = p_job_id;
  RETURN QUERY SELECT next_state;
END
$fail_materialization_job$;

CREATE FUNCTION ops.request_materialization_job_cancel(
  p_project_id uuid,
  p_job_id uuid,
  p_principal_id uuid,
  p_reason_code text
) RETURNS TABLE (state text, cancel_requested boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $request_materialization_job_cancel$
DECLARE
  now_at timestamptz := clock_timestamp();
  job_row ops.materialization_jobs%ROWTYPE;
BEGIN
  IF p_principal_id IS NULL OR p_reason_code !~ '^[A-Z][A-Z0-9_]{1,63}$' THEN
    RAISE EXCEPTION 'G20208_JOB_CANCEL_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT candidate.* INTO job_row FROM ops.materialization_jobs AS candidate
  WHERE candidate.project_id = p_project_id AND candidate.job_id = p_job_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_NOT_FOUND' USING ERRCODE = '02000';
  END IF;
  IF job_row.state IN ('succeeded', 'cancelled')
    OR job_row.cutover_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_NOT_CANCELLABLE' USING ERRCODE = '55000';
  END IF;
  IF job_row.last_observed_database_at > now_at THEN
    RAISE EXCEPTION 'G20208_JOB_DATABASE_TIME_REGRESSION' USING ERRCODE = '55000';
  END IF;
  IF job_row.state = 'running' THEN
    UPDATE ops.materialization_jobs AS job
    SET cancel_requested = true, cancel_requested_at = now_at,
        cancel_requested_by_principal_id = p_principal_id,
        cancellation_reason_code = p_reason_code,
        last_observed_database_at = now_at, updated_at = now_at
    WHERE job.project_id = p_project_id AND job.job_id = p_job_id;
    RETURN QUERY SELECT 'running'::text, true;
  ELSE
    UPDATE ops.materialization_jobs AS job
    SET state = 'cancelled', cancel_requested = true, cancel_requested_at = now_at,
        cancel_requested_by_principal_id = p_principal_id,
        cancellation_reason_code = p_reason_code, result_code = 'CANCELLED',
        available_at = now_at, last_observed_database_at = now_at, updated_at = now_at
    WHERE job.project_id = p_project_id AND job.job_id = p_job_id;
    RETURN QUERY SELECT 'cancelled'::text, true;
  END IF;
END
$request_materialization_job_cancel$;

CREATE FUNCTION ops.cancel_materialization_job_at_safe_point(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_worker_instance_id uuid,
  p_fencing_token bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $cancel_materialization_job_at_safe_point$
DECLARE
  now_at timestamptz := clock_timestamp();
BEGIN
  PERFORM 1 FROM ops.materialization_jobs AS job
  WHERE job.project_id = p_project_id AND job.job_id = p_job_id
    AND job.state = 'running' AND job.current_attempt_id = p_attempt_id
    AND job.lease_owner_id = p_worker_instance_id
    AND job.fencing_token = p_fencing_token AND job.lease_expires_at > now_at
    AND job.last_observed_database_at <= now_at
    AND job.cancel_requested AND job.cutover_started_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_NOT_CANCELLABLE' USING ERRCODE = '55000';
  END IF;
  UPDATE ops.materialization_attempts AS attempt
  SET state = 'cancelled', finished_at = now_at, heartbeat_at = now_at,
      lease_expires_at = GREATEST(attempt.lease_expires_at, now_at),
      result_code = 'CANCELLED'
  WHERE attempt.project_id = p_project_id AND attempt.attempt_id = p_attempt_id
    AND attempt.state = 'leased';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20208_JOB_ATTEMPT_MISSING' USING ERRCODE = '55000';
  END IF;
  UPDATE ops.materialization_jobs AS job
  SET state = 'cancelled', lease_owner_id = NULL, lease_expires_at = NULL,
      heartbeat_at = NULL, result_code = 'CANCELLED',
      last_observed_database_at = now_at, updated_at = now_at
  WHERE job.project_id = p_project_id AND job.job_id = p_job_id;
END
$cancel_materialization_job_at_safe_point$;

CREATE FUNCTION ops.replay_materialization_job(
  p_project_id uuid,
  p_job_id uuid,
  p_principal_id uuid,
  p_reason_code text
) RETURNS TABLE (state text, replay_cycle integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $replay_materialization_job$
DECLARE
  now_at timestamptz := clock_timestamp();
  job_row ops.materialization_jobs%ROWTYPE;
BEGIN
  IF p_principal_id IS NULL OR p_reason_code !~ '^[A-Z][A-Z0-9_]{1,63}$' THEN
    RAISE EXCEPTION 'G20208_JOB_REPLAY_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT candidate.* INTO job_row FROM ops.materialization_jobs AS candidate
  WHERE candidate.project_id = p_project_id AND candidate.job_id = p_job_id
  FOR UPDATE;
  IF NOT FOUND OR job_row.state <> 'dead_letter'
    OR job_row.cutover_started_at IS NOT NULL
    OR job_row.last_observed_database_at > now_at THEN
    RAISE EXCEPTION 'G20208_JOB_REPLAY_STATE_INVALID' USING ERRCODE = '55000';
  END IF;
  UPDATE ops.materialization_jobs AS job
  SET state = 'queued', available_at = now_at, attempts_in_cycle = 0,
      replay_cycle = job.replay_cycle + 1, replay_count = job.replay_count + 1,
      last_replayed_at = now_at, last_replayed_by_principal_id = p_principal_id,
      last_replay_reason_code = p_reason_code, result_code = 'MANUAL_REPLAY',
      last_observed_database_at = now_at, updated_at = now_at
  WHERE job.project_id = p_project_id AND job.job_id = p_job_id;
  RETURN QUERY SELECT 'queued'::text, job_row.replay_cycle + 1;
END
$replay_materialization_job$;

CREATE TRIGGER materialization_job_error_samples_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.materialization_job_error_samples
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();

CREATE OR REPLACE VIEW ops.materialization_job_status WITH (security_barrier = true) AS
SELECT project_id, job_id, snapshot_group_id, group_version, state, current_stage,
       attempt_count, fencing_token, lease_expires_at, cancel_requested,
       result_code, created_at, updated_at,
       priority, available_at, replay_cycle, replay_count, attempts_in_cycle,
       maximum_attempts_per_cycle, first_failure_code, first_failure_category,
       last_failure_code, last_failure_category, cutover_completed_at
FROM ops.materialization_jobs;

REVOKE INSERT ON TABLE ops.materialization_jobs FROM api_runtime;
REVOKE INSERT (
  project_id, job_id, snapshot_group_id, group_version, idempotency_key, input_digest
) ON ops.materialization_jobs FROM api_runtime;
REVOKE EXECUTE ON FUNCTION
  ops.claim_materialization_job(uuid, uuid, integer),
  ops.checkpoint_materialization_job(uuid, uuid, uuid, bigint, uuid, bigint, text, text, bigint)
FROM PUBLIC, worker_runtime;
REVOKE ALL PRIVILEGES ON TABLE ops.materialization_job_error_samples
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ops
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

-- Re-grant all previously supported safe DB-02 functions after the schema-wide
-- function revoke above, then add the G2-02-08 Worker surface.
GRANT EXECUTE ON FUNCTION
  ops.write_materialization_staged_batch(uuid, uuid, uuid, bigint, bigint, text, bigint),
  ops.stage_object_base_batch(uuid, uuid, uuid, bigint, bigint, text, uuid, uuid, uuid, uuid, uuid, jsonb),
  ops.stage_link_base_batch(uuid, uuid, uuid, bigint, bigint, text, uuid, uuid, uuid, uuid, uuid, jsonb),
  ops.promote_materialization_base(uuid, uuid, uuid, bigint, uuid, bigint, text),
  ops.get_materialization_quality_scope(uuid, uuid, uuid, bigint, uuid),
  ops.stage_materialization_quality_observations(uuid, uuid, uuid, bigint, uuid, jsonb),
  ops.prepare_materialization_staging_current(uuid, uuid, uuid, bigint, uuid, jsonb),
  ops.list_materialization_quality_observations(uuid, uuid, uuid, bigint, text, text, integer),
  ops.finalize_materialization_quality(
    uuid, uuid, uuid, bigint, uuid, text, text, text, jsonb, jsonb, text, text
  ),
  ops.reap_expired_materialization_jobs(integer),
  ops.claim_materialization_job_v2(uuid, uuid, integer),
  ops.heartbeat_materialization_job(uuid, uuid, uuid, uuid, bigint, integer),
  ops.read_materialization_job_control(uuid, uuid, uuid, uuid, bigint),
  ops.complete_materialization_stage(uuid, uuid, uuid, uuid, bigint, uuid, bigint, text, uuid, text),
  ops.succeed_materialization_job(uuid, uuid, uuid, uuid, bigint, text),
  ops.fail_materialization_job(uuid, uuid, uuid, uuid, bigint, text, text, boolean, text, jsonb),
  ops.cancel_materialization_job_at_safe_point(uuid, uuid, uuid, uuid, bigint)
TO worker_runtime;

GRANT EXECUTE ON FUNCTION
  ops.enqueue_materialization_job(uuid, uuid, uuid, bigint, text, text, uuid, integer),
  ops.request_materialization_job_cancel(uuid, uuid, uuid, text),
  ops.replay_materialization_job(uuid, uuid, uuid, text)
TO api_runtime;
