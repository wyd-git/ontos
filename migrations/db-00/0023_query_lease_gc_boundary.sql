SET LOCAL ROLE migration_owner;

CREATE TABLE runtime.query_leases (
  project_id uuid NOT NULL,
  query_lease_id uuid NOT NULL,
  release_id uuid NOT NULL,
  activation_id uuid NOT NULL,
  policy_compilation_id uuid NOT NULL,
  policy_revision_id uuid NOT NULL,
  identity_context_hash varchar(71) NOT NULL
    CHECK (identity_context_hash ~ '^sha256:[0-9a-f]{64}$'),
  authorization_epoch bigint NOT NULL CHECK (authorization_epoch >= 1),
  policy_context_hash varchar(71) NOT NULL
    CHECK (policy_context_hash ~ '^sha256:[0-9a-f]{64}$'),
  policy_artifact_digest varchar(71) NOT NULL
    CHECK (policy_artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  policy_compiler_version varchar(64) NOT NULL
    CHECK (policy_compiler_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  query_hash varchar(71) NOT NULL CHECK (query_hash ~ '^sha256:[0-9a-f]{64}$'),
  correlation_id varchar(128) NOT NULL CHECK (btrim(correlation_id) <> ''),
  generation_count integer NOT NULL CHECK (generation_count BETWEEN 1 AND 256),
  generation_set_digest varchar(71) NOT NULL
    CHECK (generation_set_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'planned'
    CHECK (state IN ('planned', 'committed', 'released', 'expired')),
  control_sequence bigint NOT NULL DEFAULT 0 CHECK (control_sequence >= 0),
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  max_expires_at timestamptz NOT NULL,
  released_at timestamptz,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, query_lease_id),
  CONSTRAINT query_leases_project_fk FOREIGN KEY (project_id)
    REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  CONSTRAINT query_leases_release_fk FOREIGN KEY (project_id, release_id)
    REFERENCES meta.releases(project_id, release_id) ON DELETE RESTRICT,
  CONSTRAINT query_leases_activation_fk FOREIGN KEY (release_id, activation_id)
    REFERENCES meta.runtime_activations(release_id, activation_id) ON DELETE RESTRICT,
  CONSTRAINT query_leases_policy_compilation_fk FOREIGN KEY (
    project_id, release_id, policy_compilation_id,
    policy_artifact_digest, policy_compiler_version
  ) REFERENCES authz.policy_compilations(
    project_id, release_id, policy_compilation_id,
    artifact_digest, compiler_version
  ) ON DELETE RESTRICT,
  CONSTRAINT query_leases_time_ck CHECK (
    acquired_at <= heartbeat_at
    AND heartbeat_at <= expires_at
    AND expires_at <= max_expires_at
    AND max_expires_at <= acquired_at + interval '120 seconds'
  ),
  CONSTRAINT query_leases_terminal_ck CHECK (
    (state IN ('planned', 'committed') AND released_at IS NULL)
    OR (state = 'released' AND released_at IS NOT NULL
      AND released_at >= acquired_at AND released_at <= changed_at)
    OR (state = 'expired' AND released_at IS NULL)
  )
);

CREATE TABLE runtime.query_lease_generations (
  project_id uuid NOT NULL,
  query_lease_id uuid NOT NULL,
  release_id uuid NOT NULL,
  activation_id uuid NOT NULL,
  member_key varchar(70) NOT NULL
    CHECK (member_key ~ '^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$'),
  generation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, query_lease_id, generation_id),
  CONSTRAINT query_lease_generations_lease_fk FOREIGN KEY (project_id, query_lease_id)
    REFERENCES runtime.query_leases(project_id, query_lease_id) ON DELETE RESTRICT,
  CONSTRAINT query_lease_generations_member_uq
    UNIQUE (project_id, query_lease_id, member_key)
);

CREATE INDEX query_leases_active_expiry_idx
  ON runtime.query_leases(project_id, expires_at, query_lease_id)
  WHERE state = 'committed';
CREATE INDEX query_leases_policy_idx
  ON runtime.query_leases(project_id, release_id, policy_revision_id, acquired_at DESC);
CREATE INDEX query_lease_generations_root_idx
  ON runtime.query_lease_generations(project_id, generation_id, query_lease_id);

CREATE FUNCTION ontos_migration.g20303_enforce_query_lease_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20303_query_lease_update$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.query_lease_id IS DISTINCT FROM OLD.query_lease_id
    OR NEW.release_id IS DISTINCT FROM OLD.release_id
    OR NEW.activation_id IS DISTINCT FROM OLD.activation_id
    OR NEW.policy_compilation_id IS DISTINCT FROM OLD.policy_compilation_id
    OR NEW.policy_revision_id IS DISTINCT FROM OLD.policy_revision_id
    OR NEW.identity_context_hash IS DISTINCT FROM OLD.identity_context_hash
    OR NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch
    OR NEW.policy_context_hash IS DISTINCT FROM OLD.policy_context_hash
    OR NEW.policy_artifact_digest IS DISTINCT FROM OLD.policy_artifact_digest
    OR NEW.policy_compiler_version IS DISTINCT FROM OLD.policy_compiler_version
    OR NEW.query_hash IS DISTINCT FROM OLD.query_hash
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.generation_count IS DISTINCT FROM OLD.generation_count
    OR NEW.generation_set_digest IS DISTINCT FROM OLD.generation_set_digest
    OR NEW.acquired_at IS DISTINCT FROM OLD.acquired_at
    OR NEW.max_expires_at IS DISTINCT FROM OLD.max_expires_at THEN
    RAISE EXCEPTION 'G20303_QUERY_LEASE_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.control_sequence <> OLD.control_sequence + 1
    OR NEW.changed_at <= OLD.changed_at THEN
    RAISE EXCEPTION 'G20303_QUERY_LEASE_SEQUENCE_INVALID' USING ERRCODE = '40001';
  END IF;

  IF OLD.state = 'planned' AND NEW.state = 'committed' THEN
    IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR NEW.heartbeat_at < OLD.heartbeat_at
      OR NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'G20303_QUERY_LEASE_COMMIT_INVALID' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.state = 'committed' AND NEW.state = 'committed' THEN
    IF NEW.expires_at < OLD.expires_at
      OR NEW.heartbeat_at <= OLD.heartbeat_at
      OR NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'G20303_QUERY_LEASE_HEARTBEAT_INVALID' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.state = 'committed' AND NEW.state = 'released' THEN
    IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR NEW.heartbeat_at IS DISTINCT FROM OLD.heartbeat_at
      OR NEW.released_at IS NULL THEN
      RAISE EXCEPTION 'G20303_QUERY_LEASE_RELEASE_INVALID' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.state IN ('planned', 'committed') AND NEW.state = 'expired' THEN
    IF OLD.expires_at > clock_timestamp()
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR NEW.heartbeat_at IS DISTINCT FROM OLD.heartbeat_at
      OR NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'G20303_QUERY_LEASE_EXPIRY_INVALID' USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'G20303_QUERY_LEASE_STATE_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20303_query_lease_update$;

CREATE TRIGGER query_leases_controlled_update
BEFORE UPDATE ON runtime.query_leases
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20303_enforce_query_lease_update();
CREATE TRIGGER query_leases_no_delete
BEFORE DELETE OR TRUNCATE ON runtime.query_leases
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20303_reject_immutable_fact();
CREATE TRIGGER query_lease_generations_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON runtime.query_lease_generations
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20303_reject_immutable_fact();
CREATE TRIGGER query_leases_gc_serialization
BEFORE INSERT OR UPDATE OR DELETE ON runtime.query_leases
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20212_lock_gc_root_change();

ALTER TABLE runtime.query_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.query_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE runtime.query_lease_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.query_lease_generations FORCE ROW LEVEL SECURITY;

CREATE POLICY query_leases_project_isolation
  ON runtime.query_leases
  USING (
    current_user = 'migration_owner'
    OR pg_has_role(current_user, 'read_only_ops', 'USAGE')
    OR project_id = authz.g20303_project_context()
  )
  WITH CHECK (
    current_user = 'migration_owner'
    OR project_id = authz.g20303_project_context()
  );
CREATE POLICY query_lease_generations_project_isolation
  ON runtime.query_lease_generations
  USING (
    current_user = 'migration_owner'
    OR pg_has_role(current_user, 'read_only_ops', 'USAGE')
    OR project_id = authz.g20303_project_context()
  )
  WITH CHECK (
    current_user = 'migration_owner'
    OR project_id = authz.g20303_project_context()
  );

CREATE FUNCTION runtime.plan_query_lease(
  p_project_id uuid,
  p_query_lease_id uuid,
  p_release_id uuid,
  p_policy_compilation_id uuid,
  p_identity_context_hash text,
  p_authorization_epoch bigint,
  p_policy_context_hash text,
  p_query_hash text,
  p_correlation_id text,
  p_ttl_seconds integer
) RETURNS runtime.query_leases
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $plan_query_lease$
DECLARE
  selected_activation_id uuid;
  selected_activation_member_count integer;
  selected_policy authz.policy_compilations%ROWTYPE;
  selected_epoch bigint;
  member_count integer;
  member_digest text;
  acquired timestamptz;
  result runtime.query_leases%ROWTYPE;
BEGIN
  IF p_project_id IS NULL OR p_query_lease_id IS NULL OR p_release_id IS NULL
    OR p_policy_compilation_id IS NULL
    OR p_identity_context_hash !~ '^sha256:[0-9a-f]{64}$'
    OR p_authorization_epoch < 1
    OR p_policy_context_hash !~ '^sha256:[0-9a-f]{64}$'
    OR p_query_hash !~ '^sha256:[0-9a-f]{64}$'
    OR p_correlation_id IS NULL OR btrim(p_correlation_id) = ''
    OR length(p_correlation_id) > 128
    OR p_ttl_seconds NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'G20303_QUERY_LEASE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(737217209, hashtext(p_project_id::text));
  PERFORM set_config('ontos.project_id', p_project_id::text, true);

  SELECT head.activation_id, activation.member_count
    INTO selected_activation_id, selected_activation_member_count
  FROM meta.releases AS release
  JOIN meta.release_serving_heads AS head ON head.release_id = release.release_id
  JOIN meta.runtime_activations AS activation
    ON activation.release_id = head.release_id
   AND activation.activation_id = head.activation_id
  WHERE release.project_id = p_project_id
    AND release.release_id = p_release_id
    AND release.state IN ('published', 'superseded')
  FOR SHARE OF release, head;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20303_QUERY_SERVING_ACTIVATION_REQUIRED' USING ERRCODE = '55000';
  END IF;

  SELECT compilation.* INTO selected_policy
  FROM authz.policy_compilations AS compilation
  WHERE compilation.project_id = p_project_id
    AND compilation.release_id = p_release_id
    AND compilation.policy_compilation_id = p_policy_compilation_id
    AND compilation.status = 'passed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20303_QUERY_POLICY_ARTIFACT_REQUIRED' USING ERRCODE = '55000';
  END IF;

  SELECT epoch.epoch INTO selected_epoch
  FROM authz.authorization_epochs AS epoch
  WHERE epoch.project_id = p_project_id
  FOR SHARE;
  IF selected_epoch IS DISTINCT FROM p_authorization_epoch THEN
    RAISE EXCEPTION 'G20303_QUERY_AUTHORIZATION_EPOCH_STALE' USING ERRCODE = '40001';
  END IF;

  SELECT count(*)::integer,
         'sha256:' || encode(sha256(convert_to(string_agg(
           member.member_key || '|' || member.generation_id::text,
           E'\n' ORDER BY member.member_key COLLATE "C", member.generation_id
         ) || E'\n', 'UTF8')), 'hex')
    INTO member_count, member_digest
  FROM meta.runtime_activation_members AS member
  JOIN runtime.generations AS generation
    ON generation.project_id = member.project_id
   AND generation.generation_id = member.generation_id
  WHERE member.project_id = p_project_id
    AND member.release_id = p_release_id
    AND member.activation_id = selected_activation_id
    AND generation.state = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM runtime.generation_collections AS collected
      WHERE collected.project_id = generation.project_id
        AND collected.generation_id = generation.generation_id
    );
  IF member_count NOT BETWEEN 1 AND 256
    OR member_count IS DISTINCT FROM selected_activation_member_count
    OR member_digest IS NULL THEN
    RAISE EXCEPTION 'G20303_QUERY_GENERATION_SET_INVALID' USING ERRCODE = '55000';
  END IF;

  acquired := clock_timestamp();
  INSERT INTO runtime.query_leases (
    project_id, query_lease_id, release_id, activation_id,
    policy_compilation_id, policy_revision_id, identity_context_hash,
    authorization_epoch, policy_context_hash, policy_artifact_digest,
    policy_compiler_version, query_hash, correlation_id,
    generation_count, generation_set_digest, acquired_at, heartbeat_at,
    expires_at, max_expires_at, changed_at
  ) VALUES (
    p_project_id, p_query_lease_id, p_release_id, selected_activation_id,
    p_policy_compilation_id, selected_policy.policy_revision_id,
    p_identity_context_hash, p_authorization_epoch, p_policy_context_hash,
    selected_policy.artifact_digest, selected_policy.compiler_version,
    p_query_hash, p_correlation_id, member_count, member_digest,
    acquired, acquired, acquired + make_interval(secs => p_ttl_seconds),
    acquired + interval '120 seconds', acquired
  ) RETURNING * INTO result;

  INSERT INTO runtime.query_lease_generations (
    project_id, query_lease_id, release_id, activation_id, member_key, generation_id
  )
  SELECT member.project_id, p_query_lease_id, member.release_id,
         member.activation_id, member.member_key, member.generation_id
  FROM meta.runtime_activation_members AS member
  JOIN runtime.generations AS generation
    ON generation.project_id = member.project_id
   AND generation.generation_id = member.generation_id
  WHERE member.project_id = p_project_id
    AND member.release_id = p_release_id
    AND member.activation_id = selected_activation_id
    AND generation.state = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM runtime.generation_collections AS collected
      WHERE collected.project_id = generation.project_id
        AND collected.generation_id = generation.generation_id
    );

  IF (SELECT count(*) FROM runtime.query_lease_generations AS member
      WHERE member.project_id = p_project_id
        AND member.query_lease_id = p_query_lease_id) <> member_count THEN
    RAISE EXCEPTION 'G20303_QUERY_GENERATION_SET_CHANGED' USING ERRCODE = '40001';
  END IF;
  RETURN result;
END
$plan_query_lease$;

CREATE FUNCTION runtime.commit_query_lease(
  p_project_id uuid,
  p_query_lease_id uuid,
  p_expected_control_sequence bigint
) RETURNS runtime.query_leases
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $commit_query_lease$
DECLARE
  result runtime.query_leases%ROWTYPE;
BEGIN
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  UPDATE runtime.query_leases AS lease
  SET state = 'committed', control_sequence = control_sequence + 1,
      heartbeat_at = clock_timestamp(), changed_at = clock_timestamp()
  WHERE lease.project_id = p_project_id
    AND lease.query_lease_id = p_query_lease_id
    AND lease.state = 'planned'
    AND lease.control_sequence = p_expected_control_sequence
    AND lease.expires_at > clock_timestamp()
    AND lease.generation_count = (
      SELECT count(*) FROM runtime.query_lease_generations AS member
      WHERE member.project_id = lease.project_id
        AND member.query_lease_id = lease.query_lease_id
    )
  RETURNING lease.* INTO result;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20303_QUERY_LEASE_COMMIT_CONFLICT' USING ERRCODE = '40001';
  END IF;
  RETURN result;
END
$commit_query_lease$;

CREATE FUNCTION runtime.heartbeat_query_lease(
  p_project_id uuid,
  p_query_lease_id uuid,
  p_expected_control_sequence bigint,
  p_extension_seconds integer
) RETURNS runtime.query_leases
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $heartbeat_query_lease$
DECLARE
  result runtime.query_leases%ROWTYPE;
BEGIN
  IF p_extension_seconds NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'G20303_QUERY_LEASE_HEARTBEAT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  UPDATE runtime.query_leases AS lease
  SET expires_at = least(lease.max_expires_at,
                         greatest(lease.expires_at,
                                  clock_timestamp() + make_interval(secs => p_extension_seconds))),
      heartbeat_at = clock_timestamp(), control_sequence = control_sequence + 1,
      changed_at = clock_timestamp()
  WHERE lease.project_id = p_project_id
    AND lease.query_lease_id = p_query_lease_id
    AND lease.state = 'committed'
    AND lease.control_sequence = p_expected_control_sequence
    AND lease.expires_at > clock_timestamp()
    AND lease.max_expires_at > clock_timestamp()
  RETURNING lease.* INTO result;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20303_QUERY_LEASE_HEARTBEAT_CONFLICT' USING ERRCODE = '40001';
  END IF;
  RETURN result;
END
$heartbeat_query_lease$;

CREATE FUNCTION runtime.release_query_lease(
  p_project_id uuid,
  p_query_lease_id uuid,
  p_expected_control_sequence bigint
) RETURNS runtime.query_leases
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $release_query_lease$
DECLARE
  result runtime.query_leases%ROWTYPE;
  released timestamptz;
BEGIN
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  released := clock_timestamp();
  UPDATE runtime.query_leases AS lease
  SET state = 'released', released_at = released,
      control_sequence = control_sequence + 1, changed_at = released
  WHERE lease.project_id = p_project_id
    AND lease.query_lease_id = p_query_lease_id
    AND lease.state = 'committed'
    AND lease.control_sequence = p_expected_control_sequence
  RETURNING lease.* INTO result;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20303_QUERY_LEASE_RELEASE_CONFLICT' USING ERRCODE = '40001';
  END IF;
  RETURN result;
END
$release_query_lease$;

CREATE FUNCTION runtime.expire_query_leases(
  p_project_id uuid,
  p_batch_size integer
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $expire_query_leases$
DECLARE
  changed integer;
BEGIN
  IF p_batch_size NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'G20303_QUERY_LEASE_EXPIRY_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  WITH candidate AS (
    SELECT lease.project_id, lease.query_lease_id
    FROM runtime.query_leases AS lease
    WHERE lease.project_id = p_project_id
      AND lease.state IN ('planned', 'committed')
      AND lease.expires_at <= clock_timestamp()
    ORDER BY lease.expires_at, lease.query_lease_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE runtime.query_leases AS lease
  SET state = 'expired', control_sequence = control_sequence + 1,
      changed_at = clock_timestamp()
  FROM candidate
  WHERE lease.project_id = candidate.project_id
    AND lease.query_lease_id = candidate.query_lease_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$expire_query_leases$;

-- Activate the reserved provider only after the durable tables and procedures
-- exist.  Registry and root epochs change in this same migration transaction.
UPDATE ops.gc_root_provider_registry
SET capability_state = 'ACTIVE', expected_version = 'v1', changed_at = clock_timestamp()
WHERE capability_key = 'runtime.query-lease';

UPDATE ops.gc_root_epochs
SET root_revision = root_revision + 1, changed_at = clock_timestamp();

CREATE OR REPLACE FUNCTION ontos_migration.g20212_root_state_digest(p_project_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $g20212_root_state_digest$
  WITH root_lines AS (
    SELECT 'root-revision|' || COALESCE((
      SELECT epoch.root_revision::text FROM ops.gc_root_epochs AS epoch
      WHERE epoch.project_id = p_project_id
    ), '0') AS line
    UNION ALL
    SELECT 'channel|' || channel.channel_name || '|' || member.generation_id::text
    FROM meta.release_channels AS channel
    JOIN meta.runtime_activation_members AS member
      ON member.release_id = channel.release_id
     AND member.activation_id = channel.activation_id
    WHERE channel.project_id = p_project_id
    UNION ALL
    SELECT 'serving|' || head.release_id::text || '|' || member.generation_id::text
    FROM meta.release_serving_heads AS head
    JOIN meta.releases AS release ON release.release_id = head.release_id
    JOIN meta.runtime_activation_members AS member
      ON member.release_id = head.release_id AND member.activation_id = head.activation_id
    WHERE release.project_id = p_project_id
      AND release.state IN ('ready', 'published', 'superseded')
    UNION ALL
    SELECT 'job|' || job.job_id::text || '|' || generation.generation_id::text || '|' || job.state
    FROM ops.materialization_jobs AS job
    JOIN runtime.generations AS generation
      ON generation.project_id = job.project_id
     AND generation.snapshot_group_id = job.snapshot_group_id
     AND generation.group_version = job.group_version
    WHERE job.project_id = p_project_id
      AND job.state IN ('queued', 'running', 'retry_wait')
    UNION ALL
    SELECT 'head|' || pointer.head_set_id::text || '|' || version.current_generation_id::text
    FROM runtime.project_object_head_pointers AS pointer
    JOIN runtime.object_head_versions AS version
      ON version.project_id = pointer.project_id AND version.head_set_id = pointer.head_set_id
    WHERE pointer.project_id = p_project_id
    UNION ALL
    SELECT 'inflight-head|' || head_set.head_set_id::text || '|' || version.current_generation_id::text
    FROM runtime.object_head_sets AS head_set
    JOIN runtime.object_head_versions AS version
      ON version.project_id = head_set.project_id AND version.head_set_id = head_set.head_set_id
    WHERE head_set.project_id = p_project_id AND head_set.state IN ('building', 'prepared')
    UNION ALL
    SELECT 'cutover|' || preparation.preparation_id::text || '|' || member.generation_id::text
    FROM runtime.snapshot_group_cutover_preparations AS preparation
    JOIN runtime.snapshot_group_cutover_member_candidates AS member
      ON member.project_id = preparation.project_id
     AND member.preparation_id = preparation.preparation_id
    WHERE preparation.project_id = p_project_id AND preparation.state IN ('preparing', 'prepared')
    UNION ALL
    SELECT 'activation|' || activation.activation_id::text || '|' || member.generation_id::text
    FROM meta.runtime_activations AS activation
    JOIN meta.releases AS activation_release
      ON activation_release.release_id = activation.release_id
    JOIN meta.runtime_activation_members AS member
      ON member.release_id = activation.release_id
     AND member.activation_id = activation.activation_id
    WHERE activation_release.project_id = p_project_id
    UNION ALL
    SELECT 'query-lease|' || lease.query_lease_id::text || '|' || member.generation_id::text
    FROM runtime.query_leases AS lease
    JOIN runtime.query_lease_generations AS member
      ON member.project_id = lease.project_id
     AND member.query_lease_id = lease.query_lease_id
    WHERE lease.project_id = p_project_id
      AND lease.state = 'committed'
      AND lease.expires_at > clock_timestamp()
    UNION ALL
    SELECT 'generation|' || generation.generation_id::text || '|' || generation.state || '|' ||
           extract(epoch FROM generation.changed_at)::text
    FROM runtime.generations AS generation
    WHERE generation.project_id = p_project_id
      AND NOT EXISTS (
        SELECT 1 FROM runtime.generation_collections AS collected
        WHERE collected.project_id = generation.project_id
          AND collected.generation_id = generation.generation_id
      )
    UNION ALL
    SELECT 'upload|' || session.session_id::text || '|' || session.state || '|' ||
           extract(epoch FROM session.changed_at)::text
    FROM runtime.snapshot_upload_sessions AS session
    WHERE session.project_id = p_project_id AND session.state <> 'cleaned'
  )
  SELECT 'sha256:' || encode(sha256(convert_to(COALESCE(string_agg(
    line, E'\n' ORDER BY line COLLATE "C"
  ), '') || E'\n', 'UTF8')), 'hex') FROM root_lines
$g20212_root_state_digest$;

CREATE OR REPLACE VIEW ops.gc_generation_roots WITH (security_barrier = true) AS
SELECT DISTINCT channel.project_id, member.generation_id, 'CHANNEL'::text AS root_kind,
       channel.channel_name::text AS root_id,
       'materialization.channel'::text AS capability_key, NULL::timestamptz AS expires_at
FROM meta.release_channels AS channel
JOIN meta.runtime_activation_members AS member
  ON member.release_id = channel.release_id AND member.activation_id = channel.activation_id
UNION ALL
SELECT DISTINCT release.project_id, member.generation_id, 'SERVING_HEAD', head.release_id::text,
       'materialization.serving-head', NULL::timestamptz
FROM meta.release_serving_heads AS head
JOIN meta.releases AS release ON release.release_id = head.release_id
JOIN meta.runtime_activation_members AS member
  ON member.release_id = head.release_id AND member.activation_id = head.activation_id
WHERE release.state IN ('ready', 'published', 'superseded')
UNION ALL
SELECT DISTINCT job.project_id, generation.generation_id, 'ACTIVE_JOB', job.job_id::text,
       'materialization.active-job', NULL::timestamptz
FROM ops.materialization_jobs AS job
JOIN runtime.generations AS generation
  ON generation.project_id = job.project_id
 AND generation.snapshot_group_id = job.snapshot_group_id
 AND generation.group_version = job.group_version
WHERE job.state IN ('queued', 'running', 'retry_wait')
UNION ALL
SELECT DISTINCT pointer.project_id, version.current_generation_id, 'CURRENT_HEAD_SET',
       pointer.head_set_id::text, 'materialization.current-head-set', NULL::timestamptz
FROM runtime.project_object_head_pointers AS pointer
JOIN runtime.object_head_versions AS version
  ON version.project_id = pointer.project_id AND version.head_set_id = pointer.head_set_id
UNION ALL
SELECT DISTINCT head_set.project_id, version.current_generation_id, 'PREPARED_CUTOVER',
       head_set.head_set_id::text, 'materialization.prepared-cutover', NULL::timestamptz
FROM runtime.object_head_sets AS head_set
JOIN runtime.object_head_versions AS version
  ON version.project_id = head_set.project_id AND version.head_set_id = head_set.head_set_id
WHERE head_set.state IN ('building', 'prepared')
UNION ALL
SELECT DISTINCT preparation.project_id, member.generation_id, 'PREPARED_CUTOVER',
       preparation.preparation_id::text, 'materialization.prepared-cutover', NULL::timestamptz
FROM runtime.snapshot_group_cutover_preparations AS preparation
JOIN runtime.snapshot_group_cutover_member_candidates AS member
  ON member.project_id = preparation.project_id
 AND member.preparation_id = preparation.preparation_id
WHERE preparation.state IN ('preparing', 'prepared')
UNION ALL
SELECT DISTINCT activation_release.project_id, member.generation_id, 'HISTORICAL_ACTIVATION',
       activation.activation_id::text, 'materialization.activation-history', NULL::timestamptz
FROM meta.runtime_activations AS activation
JOIN meta.releases AS activation_release
  ON activation_release.release_id = activation.release_id
JOIN meta.runtime_activation_members AS member
  ON member.release_id = activation.release_id
 AND member.activation_id = activation.activation_id
WHERE activation_release.project_id IS NOT NULL
UNION ALL
SELECT DISTINCT lease.project_id, member.generation_id, 'QUERY_LEASE',
       lease.query_lease_id::text, 'runtime.query-lease', lease.expires_at
FROM runtime.query_leases AS lease
JOIN runtime.query_lease_generations AS member
  ON member.project_id = lease.project_id
 AND member.query_lease_id = lease.query_lease_id
WHERE lease.state = 'committed' AND lease.expires_at > clock_timestamp();

CREATE OR REPLACE VIEW ops.gc_live_provider_scans WITH (security_barrier = true) AS
SELECT project.project_id, registry.capability_key,
       CASE
         WHEN registry.capability_state = 'INACTIVE' THEN 'INACTIVE'
         WHEN registry.capability_key IN (
           'materialization.channel', 'materialization.serving-head',
           'materialization.active-job', 'materialization.current-head-set',
           'materialization.prepared-cutover', 'materialization.activation-history',
           'runtime.query-lease'
         ) THEN 'COMPLETE'
         ELSE 'MISSING'
       END AS status,
       CASE
         WHEN registry.capability_state = 'ACTIVE'
          AND registry.capability_key IN (
           'materialization.channel', 'materialization.serving-head',
           'materialization.active-job', 'materialization.current-head-set',
           'materialization.prepared-cutover', 'materialization.activation-history',
           'runtime.query-lease'
         ) THEN registry.expected_version
       END AS provider_version,
       CASE WHEN registry.capability_state = 'ACTIVE' THEN count(root.generation_id)
            ELSE 0 END::bigint AS root_count,
       CASE
         WHEN registry.capability_state = 'ACTIVE'
          AND registry.capability_key IN (
           'materialization.channel', 'materialization.serving-head',
           'materialization.active-job', 'materialization.current-head-set',
           'materialization.prepared-cutover', 'materialization.activation-history',
           'runtime.query-lease'
         ) THEN 'sha256:' || encode(sha256(convert_to(COALESCE(string_agg(
           root.root_kind || '|' || root.root_id || '|' || root.generation_id::text,
           E'\n' ORDER BY root.root_kind, root.root_id COLLATE "C", root.generation_id
         ), '') || E'\n', 'UTF8')), 'hex')
       END AS root_digest
FROM ops.gc_root_provider_registry AS registry
CROSS JOIN meta.projects AS project
LEFT JOIN ops.gc_generation_roots AS root
  ON root.project_id = project.project_id
 AND root.capability_key = registry.capability_key
GROUP BY project.project_id, registry.capability_key,
         registry.capability_state, registry.expected_version;

CREATE VIEW ops.query_lease_status WITH (security_barrier = true) AS
SELECT lease.project_id, lease.state,
       count(*)::bigint AS lease_count,
       min(lease.expires_at) AS earliest_expiry,
       max(lease.expires_at) AS latest_expiry
FROM runtime.query_leases AS lease
GROUP BY lease.project_id, lease.state;

REVOKE ALL PRIVILEGES ON TABLE
  runtime.query_leases,
  runtime.query_lease_generations,
  ops.query_lease_status
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON FUNCTION
  runtime.plan_query_lease(uuid, uuid, uuid, uuid, text, bigint, text, text, text, integer),
  runtime.commit_query_lease(uuid, uuid, bigint),
  runtime.heartbeat_query_lease(uuid, uuid, bigint, integer),
  runtime.release_query_lease(uuid, uuid, bigint),
  runtime.expire_query_leases(uuid, integer),
  ontos_migration.g20303_enforce_query_lease_update()
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT EXECUTE ON FUNCTION
  runtime.plan_query_lease(uuid, uuid, uuid, uuid, text, bigint, text, text, text, integer),
  runtime.commit_query_lease(uuid, uuid, bigint),
  runtime.heartbeat_query_lease(uuid, uuid, bigint, integer),
  runtime.release_query_lease(uuid, uuid, bigint)
TO api_runtime;
GRANT EXECUTE ON FUNCTION runtime.expire_query_leases(uuid, integer)
TO worker_runtime;
GRANT EXECUTE ON FUNCTION authz.g20303_project_context()
TO read_only_ops;
GRANT SELECT ON TABLE ops.query_lease_status TO read_only_ops;

COMMENT ON TABLE runtime.query_leases IS
  'Bounded request lease protecting one immutable serving Activation and its complete Generation set.';
COMMENT ON TABLE runtime.query_lease_generations IS
  'Historical Generation identities copied from the serving Activation when a Query Lease is planned.';
