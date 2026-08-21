SET LOCAL ROLE migration_owner;

-- ADR-007 requires every Published Release to remain explicitly serviceable
-- for at least 90 days.  Earlier migrations had published_at but omitted the
-- durable support deadline, which made a safe Retire decision impossible.
ALTER TABLE meta.releases
  ADD COLUMN support_until timestamptz;

-- Install the invariant before the backfill so concurrent/new writes cannot
-- introduce another invalid row.  NOT VALID intentionally defers checking
-- the historical rows until the deterministic backfill below.
ALTER TABLE meta.releases
  ADD CONSTRAINT releases_support_window_ck CHECK (
    (state IN ('published', 'superseded')
      AND published_at IS NOT NULL
      AND support_until IS NOT NULL
      AND support_until >= published_at + interval '90 days')
    OR (state NOT IN ('published', 'superseded') AND support_until IS NULL)
  ) NOT VALID;

UPDATE meta.releases
SET support_until = published_at + interval '90 days'
WHERE state IN ('published', 'superseded');

-- Existing Release updates can queue deferred integrity-trigger work.  Flush
-- it before ALTER TABLE validation; otherwise a non-empty upgrade fails with
-- PostgreSQL 55006 even though the backfilled rows satisfy the new invariant.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE meta.releases
  VALIDATE CONSTRAINT releases_support_window_ck;

CREATE FUNCTION ontos_migration.g20308_enforce_release_support_window() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20308_release_support_window$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.state IN ('published', 'superseded')
    AND NEW.support_until IS DISTINCT FROM OLD.support_until THEN
    RAISE EXCEPTION 'G20308_RELEASE_SUPPORT_WINDOW_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF NEW.state IN ('published', 'superseded') THEN
    IF NEW.published_at IS NULL THEN
      RAISE EXCEPTION 'G20308_RELEASE_PUBLICATION_TIME_REQUIRED' USING ERRCODE = '55000';
    END IF;
    IF NEW.support_until IS NULL THEN
      NEW.support_until := NEW.published_at + interval '90 days';
    ELSIF NEW.support_until < NEW.published_at + interval '90 days' THEN
      RAISE EXCEPTION 'G20308_RELEASE_SUPPORT_WINDOW_TOO_SHORT' USING ERRCODE = '22023';
    END IF;
  ELSIF NEW.support_until IS NOT NULL THEN
    RAISE EXCEPTION 'G20308_UNPUBLISHED_RELEASE_SUPPORT_WINDOW_FORBIDDEN'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20308_release_support_window$;

CREATE TRIGGER releases_support_window_guard
BEFORE INSERT OR UPDATE ON meta.releases
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20308_enforce_release_support_window();

-- A candidate is a bounded, immutable description read from one MVCC
-- snapshot.  It is not yet permission to read Current: the Application must
-- obtain a Policy Gateway decision and atomically revalidate it while
-- committing a Query Lease.
CREATE FUNCTION runtime.resolve_query_context_candidate(
  p_project_id uuid,
  p_selector_kind text,
  p_selector_value text
) RETURNS TABLE (
  resolution_status text,
  observed_database_at text,
  project_id uuid,
  release_id uuid,
  release_revision_id uuid,
  activation_id uuid,
  runtime_plan_digest text,
  generation_count integer,
  generation_set_digest text,
  policy_resource_id uuid,
  policy_revision_id uuid,
  policy_compilation_id uuid,
  policy_artifact_digest text,
  policy_compiler_version text,
  members jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $resolve_query_context_candidate$
DECLARE
  selected_project_id uuid;
  selected_release_id uuid;
  selected_release_state text;
  selected_published_at timestamptz;
  selected_support_until timestamptz;
  selected_activation_id uuid;
  selected_activation_member_count integer;
  selected_plan_digest text;
  policy_pin_count integer;
  policy_compilation_count integer;
  selected_policy_resource_id uuid;
  selected_policy_revision_id uuid;
  selected_policy_compilation_id uuid;
  selected_policy_artifact_digest text;
  selected_policy_compiler_version text;
  selected_generation_count integer;
  selected_generation_set_digest text;
  selected_members jsonb;
  observed text;
BEGIN
  IF p_project_id IS NULL
    OR p_selector_kind NOT IN ('release', 'channel')
    OR p_selector_value IS NULL
    OR octet_length(p_selector_value) NOT BETWEEN 1 AND 128
    OR (p_selector_kind = 'release'
      AND p_selector_value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (p_selector_kind = 'channel'
      AND p_selector_value !~ '^[a-z][a-z0-9_-]{0,62}$') THEN
    RAISE EXCEPTION 'G20308_QUERY_SELECTOR_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  observed := to_char(
    transaction_timestamp() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );

  IF p_selector_kind = 'release' THEN
    SELECT project.project_id, release.release_id, release.state,
           release.published_at, release.support_until,
           head.activation_id, activation.member_count
      INTO selected_project_id, selected_release_id, selected_release_state,
           selected_published_at, selected_support_until,
           selected_activation_id, selected_activation_member_count
    FROM meta.projects AS project
    JOIN meta.releases AS release ON release.project_id = project.project_id
    LEFT JOIN meta.release_serving_heads AS head ON head.release_id = release.release_id
    LEFT JOIN meta.runtime_activations AS activation
      ON activation.release_id = head.release_id
     AND activation.activation_id = head.activation_id
    WHERE project.project_id = p_project_id
      AND project.state = 'active'
      AND release.release_id = p_selector_value::uuid;

    IF NOT FOUND THEN
      RETURN QUERY SELECT 'not_serving', observed,
        p_project_id, NULL::uuid, NULL::uuid, NULL::uuid,
        NULL::text, NULL::integer, NULL::text,
        NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::jsonb;
      RETURN;
    END IF;
    IF selected_release_state IN ('published', 'superseded')
      AND selected_activation_id IS NULL THEN
      RETURN QUERY SELECT 'release_retired', observed,
        selected_project_id, selected_release_id, selected_release_id, NULL::uuid,
        NULL::text, NULL::integer, NULL::text,
        NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::jsonb;
      RETURN;
    END IF;
  ELSE
    SELECT project.project_id, release.release_id, release.state,
           release.published_at, release.support_until,
           channel.activation_id, activation.member_count
      INTO selected_project_id, selected_release_id, selected_release_state,
           selected_published_at, selected_support_until,
           selected_activation_id, selected_activation_member_count
    FROM meta.projects AS project
    JOIN meta.release_channels AS channel
      ON channel.project_id = project.project_id
     AND channel.channel_name = p_selector_value
    JOIN meta.releases AS release
      ON release.project_id = channel.project_id
     AND release.release_id = channel.release_id
    JOIN meta.release_serving_heads AS head
      ON head.release_id = release.release_id
     AND head.activation_id = channel.activation_id
    JOIN meta.runtime_activations AS activation
      ON activation.release_id = channel.release_id
     AND activation.activation_id = channel.activation_id
    WHERE project.project_id = p_project_id
      AND project.state = 'active'
      AND release.state = 'published';

    IF NOT FOUND THEN
      RETURN QUERY SELECT 'not_serving', observed,
        p_project_id, NULL::uuid, NULL::uuid, NULL::uuid,
        NULL::text, NULL::integer, NULL::text,
        NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::jsonb;
      RETURN;
    END IF;
  END IF;

  IF selected_release_state NOT IN ('published', 'superseded')
    OR selected_published_at IS NULL
    OR selected_support_until IS NULL
    OR selected_support_until < selected_published_at + interval '90 days'
    OR selected_activation_id IS NULL
    OR selected_activation_member_count NOT BETWEEN 1 AND 256 THEN
    RETURN QUERY SELECT 'context_unavailable', observed,
      selected_project_id, selected_release_id, selected_release_id,
      selected_activation_id, NULL::text, NULL::integer, NULL::text,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT plan.plan_digest INTO selected_plan_digest
  FROM meta.release_runtime_plans AS plan
  WHERE plan.project_id = selected_project_id
    AND plan.release_id = selected_release_id
    AND plan.member_count = selected_activation_member_count;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'context_unavailable', observed,
      selected_project_id, selected_release_id, selected_release_id,
      selected_activation_id, NULL::text, NULL::integer, NULL::text,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT count(*)::integer INTO policy_pin_count
  FROM meta.release_pins AS pin
  WHERE pin.release_id = selected_release_id AND pin.family = 'policy';

  SELECT count(*)::integer INTO policy_compilation_count
  FROM meta.release_pins AS pin
  JOIN meta.resource_revisions AS revision
    ON revision.resource_id = pin.resource_id
   AND revision.revision_id = pin.revision_id
  JOIN authz.policy_compilations AS compilation
    ON compilation.project_id = selected_project_id
   AND compilation.release_id = pin.release_id
   AND compilation.policy_resource_id = pin.resource_id
   AND compilation.policy_revision_id = pin.revision_id
   AND compilation.policy_content_digest = revision.content_digest
   AND compilation.status = 'passed'
  WHERE pin.release_id = selected_release_id
    AND pin.family = 'policy'
    AND revision.family = 'policy'
    AND revision.state IN ('published', 'deprecated')
    AND compilation.compiler_version = 'policy-compiler-g2-03-05-v1';

  -- The P0 Runtime has one Release-wide read Policy Artifact.  Multiple
  -- independent artifacts require an explicit composition contract and are
  -- rejected rather than silently ordered or partially applied.
  IF policy_pin_count <> 1 OR policy_compilation_count <> 1 THEN
    RETURN QUERY SELECT 'policy_unavailable', observed,
      selected_project_id, selected_release_id, selected_release_id,
      selected_activation_id, selected_plan_digest, NULL::integer, NULL::text,
      NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT compilation.policy_resource_id, compilation.policy_revision_id,
         compilation.policy_compilation_id, compilation.artifact_digest::text,
         compilation.compiler_version::text
    INTO selected_policy_resource_id, selected_policy_revision_id,
         selected_policy_compilation_id, selected_policy_artifact_digest,
         selected_policy_compiler_version
  FROM meta.release_pins AS pin
  JOIN meta.resource_revisions AS revision
    ON revision.resource_id = pin.resource_id
   AND revision.revision_id = pin.revision_id
  JOIN authz.policy_compilations AS compilation
    ON compilation.project_id = selected_project_id
   AND compilation.release_id = pin.release_id
   AND compilation.policy_resource_id = pin.resource_id
   AND compilation.policy_revision_id = pin.revision_id
   AND compilation.policy_content_digest = revision.content_digest
   AND compilation.status = 'passed'
  WHERE pin.release_id = selected_release_id
    AND pin.family = 'policy'
    AND revision.family = 'policy'
    AND revision.state IN ('published', 'deprecated')
    AND compilation.compiler_version = 'policy-compiler-g2-03-05-v1';

  SELECT count(*)::integer,
         'sha256:' || encode(sha256(convert_to(string_agg(
           member.member_key || '|' || member.generation_id::text,
           E'\n' ORDER BY member.member_key COLLATE "C", member.generation_id
         ) || E'\n', 'UTF8')), 'hex'),
         jsonb_agg(jsonb_build_object(
           'memberKey', member.member_key,
           'kind', generation.member_kind,
           'resourceId', generation.target_resource_id::text,
           'revisionId', generation.target_revision_id::text,
           'generationId', generation.generation_id::text,
           'definition', revision.content
         ) ORDER BY member.member_key COLLATE "C")
    INTO selected_generation_count, selected_generation_set_digest, selected_members
  FROM meta.runtime_activation_members AS member
  JOIN meta.release_runtime_plan_members AS plan_member
    ON plan_member.project_id = member.project_id
   AND plan_member.release_id = member.release_id
   AND plan_member.member_key = member.member_key
  JOIN runtime.generations AS generation
    ON generation.project_id = member.project_id
   AND generation.generation_id = member.generation_id
   AND generation.member_key = member.member_key
   AND generation.target_resource_id = plan_member.target_resource_id
   AND generation.target_revision_id = plan_member.target_revision_id
  JOIN meta.release_pins AS pin
    ON pin.release_id = member.release_id
   AND pin.resource_id = generation.target_resource_id
   AND pin.revision_id = generation.target_revision_id
  JOIN meta.resources AS resource
    ON resource.project_id = member.project_id
   AND resource.resource_id = generation.target_resource_id
  JOIN meta.resource_revisions AS revision
    ON revision.resource_id = generation.target_resource_id
   AND revision.revision_id = generation.target_revision_id
   AND revision.family = generation.member_kind || '_type'
  WHERE member.project_id = selected_project_id
    AND member.release_id = selected_release_id
    AND member.activation_id = selected_activation_id
    AND generation.state = 'active'
    AND resource.state IN ('active', 'deprecated')
    AND revision.state IN ('published', 'deprecated')
    AND NOT EXISTS (
      SELECT 1 FROM runtime.generation_collections AS collected
      WHERE collected.project_id = generation.project_id
        AND collected.generation_id = generation.generation_id
    );

  IF selected_generation_count IS DISTINCT FROM selected_activation_member_count
    OR selected_generation_count NOT BETWEEN 1 AND 256
    OR selected_generation_set_digest IS NULL
    OR selected_members IS NULL THEN
    RETURN QUERY SELECT 'context_unavailable', observed,
      selected_project_id, selected_release_id, selected_release_id,
      selected_activation_id, selected_plan_digest,
      selected_generation_count, selected_generation_set_digest,
      selected_policy_resource_id, selected_policy_revision_id,
      selected_policy_compilation_id, selected_policy_artifact_digest,
      selected_policy_compiler_version, NULL::jsonb;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'resolved', observed,
    selected_project_id, selected_release_id, selected_release_id,
    selected_activation_id, selected_plan_digest,
    selected_generation_count, selected_generation_set_digest,
    selected_policy_resource_id, selected_policy_revision_id,
    selected_policy_compilation_id, selected_policy_artifact_digest,
    selected_policy_compiler_version, selected_members;
END
$resolve_query_context_candidate$;

-- Plan + expected-context comparison + Commit are one database statement and
-- one transaction.  A Refresh between candidate resolution and this call can
-- only raise a serialization conflict; no planned Lease survives the error.
CREATE FUNCTION runtime.commit_query_execution_context(
  p_project_id uuid,
  p_query_lease_id uuid,
  p_release_id uuid,
  p_expected_activation_id uuid,
  p_expected_generation_set_digest text,
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
AS $commit_query_execution_context$
DECLARE
  planned runtime.query_leases%ROWTYPE;
  committed runtime.query_leases%ROWTYPE;
BEGIN
  IF p_expected_activation_id IS NULL
    OR p_expected_generation_set_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'G20308_QUERY_CONTEXT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO planned
  FROM runtime.plan_query_lease(
    p_project_id, p_query_lease_id, p_release_id, p_policy_compilation_id,
    p_identity_context_hash, p_authorization_epoch, p_policy_context_hash,
    p_query_hash, p_correlation_id, p_ttl_seconds
  );

  IF planned.activation_id <> p_expected_activation_id
    OR planned.generation_set_digest <> p_expected_generation_set_digest
    OR planned.policy_compilation_id <> p_policy_compilation_id THEN
    RAISE EXCEPTION 'G20308_QUERY_CONTEXT_CHANGED' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO committed
  FROM runtime.commit_query_lease(
    p_project_id, p_query_lease_id, planned.control_sequence
  );
  RETURN committed;
END
$commit_query_execution_context$;

-- Establish a transaction-local capability for the security-barrier Current
-- views.  The caller cannot activate an uncommitted, expired or differently
-- bound Lease.  transaction_timestamp() is stable for the complete read.
CREATE FUNCTION runtime.activate_query_read_context(
  p_project_id uuid,
  p_query_lease_id uuid,
  p_release_id uuid,
  p_activation_id uuid,
  p_identity_context_hash text,
  p_policy_context_hash text,
  p_query_hash text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $activate_query_read_context$
BEGIN
  IF p_project_id IS NULL OR p_query_lease_id IS NULL
    OR p_release_id IS NULL OR p_activation_id IS NULL
    OR p_identity_context_hash !~ '^sha256:[0-9a-f]{64}$'
    OR p_policy_context_hash !~ '^sha256:[0-9a-f]{64}$'
    OR p_query_hash !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'G20308_QUERY_READ_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM runtime.query_leases AS lease
    WHERE lease.project_id = p_project_id
      AND lease.query_lease_id = p_query_lease_id
      AND lease.release_id = p_release_id
      AND lease.activation_id = p_activation_id
      AND lease.identity_context_hash = p_identity_context_hash
      AND lease.policy_context_hash = p_policy_context_hash
      AND lease.query_hash = p_query_hash
      AND lease.state = 'committed'
      AND lease.expires_at > transaction_timestamp()
      AND lease.generation_count = (
        SELECT count(*) FROM runtime.query_lease_generations AS member
        WHERE member.project_id = lease.project_id
          AND member.query_lease_id = lease.query_lease_id
      )
  ) THEN
    RAISE EXCEPTION 'G20308_QUERY_LEASE_NOT_ACTIVE' USING ERRCODE = '40001';
  END IF;

  -- Existing forced RLS policies on Runtime and Query-Lease facts use the
  -- shared project context.  Set it only after the exact committed Lease has
  -- been proven above; the query-specific settings then narrow that project
  -- context to one immutable execution capability.
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  PERFORM set_config('ontos.query_project_id', p_project_id::text, true);
  PERFORM set_config('ontos.query_lease_id', p_query_lease_id::text, true);
  PERFORM set_config('ontos.query_release_id', p_release_id::text, true);
  PERFORM set_config('ontos.query_activation_id', p_activation_id::text, true);
  PERFORM set_config('ontos.query_identity_hash', p_identity_context_hash, true);
  PERFORM set_config('ontos.query_policy_hash', p_policy_context_hash, true);
  PERFORM set_config('ontos.query_hash', p_query_hash, true);
  RETURN true;
END
$activate_query_read_context$;

CREATE VIEW runtime.query_object_current
WITH (security_barrier = true) AS
SELECT current.project_id, current.generation_id,
       current.object_type_resource_id, current.object_type_revision_id,
       current.object_rid, current.canonical_primary_key, current.properties,
       current.base_value_digest, current.lifecycle_state, current.created_at,
       version.object_version
FROM runtime.object_current AS current
JOIN runtime.query_lease_generations AS member
  ON member.project_id = current.project_id
 AND member.generation_id = current.generation_id
JOIN runtime.query_leases AS lease
  ON lease.project_id = member.project_id
 AND lease.query_lease_id = member.query_lease_id
JOIN LATERAL (
  SELECT min(head.head_version)::text AS object_version
  FROM runtime.object_head_versions AS head
  WHERE head.project_id = current.project_id
    AND head.current_generation_id = current.generation_id
    AND head.object_type_resource_id = current.object_type_resource_id
    AND head.object_type_revision_id = current.object_type_revision_id
    AND head.object_rid = current.object_rid
    AND head.base_value_digest = current.base_value_digest
  HAVING count(*) > 0
) AS version ON true
WHERE lease.project_id = NULLIF(current_setting('ontos.query_project_id', true), '')::uuid
  AND lease.query_lease_id = NULLIF(current_setting('ontos.query_lease_id', true), '')::uuid
  AND lease.release_id = NULLIF(current_setting('ontos.query_release_id', true), '')::uuid
  AND lease.activation_id = NULLIF(current_setting('ontos.query_activation_id', true), '')::uuid
  AND lease.identity_context_hash = current_setting('ontos.query_identity_hash', true)
  AND lease.policy_context_hash = current_setting('ontos.query_policy_hash', true)
  AND lease.query_hash = current_setting('ontos.query_hash', true)
  AND lease.state = 'committed'
  AND lease.expires_at > transaction_timestamp();

CREATE VIEW runtime.query_link_current
WITH (security_barrier = true) AS
SELECT current.project_id, current.generation_id,
       current.link_type_resource_id, current.link_type_revision_id,
       current.link_rid, current.source_object_type_resource_id,
       current.source_object_rid, current.target_object_type_resource_id,
       current.target_object_rid, current.base_value_digest,
       current.created_at
FROM runtime.link_current AS current
JOIN runtime.query_lease_generations AS member
  ON member.project_id = current.project_id
 AND member.generation_id = current.generation_id
JOIN runtime.query_leases AS lease
  ON lease.project_id = member.project_id
 AND lease.query_lease_id = member.query_lease_id
WHERE lease.project_id = NULLIF(current_setting('ontos.query_project_id', true), '')::uuid
  AND lease.query_lease_id = NULLIF(current_setting('ontos.query_lease_id', true), '')::uuid
  AND lease.release_id = NULLIF(current_setting('ontos.query_release_id', true), '')::uuid
  AND lease.activation_id = NULLIF(current_setting('ontos.query_activation_id', true), '')::uuid
  AND lease.identity_context_hash = current_setting('ontos.query_identity_hash', true)
  AND lease.policy_context_hash = current_setting('ontos.query_policy_hash', true)
  AND lease.query_hash = current_setting('ontos.query_hash', true)
  AND lease.state = 'committed'
  AND lease.expires_at > transaction_timestamp();

-- Retire is an explicit control-plane operation.  It cannot run before the
-- durable support deadline, while any Channel points at the Release, or from a
-- stale Project/Serving-Head control sequence.
CREATE FUNCTION meta.retire_release_serving_head(
  p_project_id uuid,
  p_release_id uuid,
  p_expected_project_control_sequence bigint,
  p_expected_serving_control_sequence bigint
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $retire_release_serving_head$
DECLARE
  selected_support_until timestamptz;
  resulting_control_sequence bigint;
BEGIN
  IF p_project_id IS NULL OR p_release_id IS NULL
    OR p_expected_project_control_sequence < 0
    OR p_expected_serving_control_sequence < 0 THEN
    RAISE EXCEPTION 'G20308_RELEASE_RETIRE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(737217209, hashtext(p_project_id::text));
  PERFORM 1 FROM meta.projects AS project
  WHERE project.project_id = p_project_id
    AND project.publication_sequence = p_expected_project_control_sequence
    AND project.state = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20308_RELEASE_RETIRE_CONTROL_CONFLICT' USING ERRCODE = '40001';
  END IF;

  SELECT release.support_until INTO selected_support_until
  FROM meta.releases AS release
  WHERE release.project_id = p_project_id
    AND release.release_id = p_release_id
    AND release.state = 'superseded'
  FOR UPDATE;
  IF NOT FOUND OR selected_support_until IS NULL
    OR transaction_timestamp() < selected_support_until
    OR EXISTS (
      SELECT 1 FROM meta.release_channels AS channel
      WHERE channel.project_id = p_project_id
        AND channel.release_id = p_release_id
    ) THEN
    RAISE EXCEPTION 'G20308_RELEASE_NOT_RETIRABLE' USING ERRCODE = '55000';
  END IF;

  DELETE FROM meta.release_serving_heads AS head
  WHERE head.release_id = p_release_id
    AND head.control_sequence = p_expected_serving_control_sequence;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20308_RELEASE_RETIRE_CONTROL_CONFLICT' USING ERRCODE = '40001';
  END IF;

  UPDATE meta.projects AS project
  SET publication_sequence = publication_sequence + 1,
      changed_at = clock_timestamp()
  WHERE project.project_id = p_project_id
    AND project.publication_sequence = p_expected_project_control_sequence
  RETURNING project.publication_sequence INTO resulting_control_sequence;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20308_RELEASE_RETIRE_CONTROL_CONFLICT' USING ERRCODE = '40001';
  END IF;
  RETURN resulting_control_sequence;
END
$retire_release_serving_head$;

REVOKE ALL PRIVILEGES ON TABLE
  runtime.query_object_current,
  runtime.query_link_current
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

REVOKE ALL PRIVILEGES ON FUNCTION
  runtime.resolve_query_context_candidate(uuid, text, text),
  runtime.commit_query_execution_context(
    uuid, uuid, uuid, uuid, text, uuid, text, bigint, text, text, text, integer
  ),
  runtime.activate_query_read_context(uuid, uuid, uuid, uuid, text, text, text),
  meta.retire_release_serving_head(uuid, uuid, bigint, bigint),
  ontos_migration.g20308_enforce_release_support_window()
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

-- Force the Runtime Application to use the atomic G2-03-08 operation instead
-- of separately planning and committing a lease around a drifting candidate.
REVOKE EXECUTE ON FUNCTION
  runtime.plan_query_lease(uuid, uuid, uuid, uuid, text, bigint, text, text, text, integer),
  runtime.commit_query_lease(uuid, uuid, bigint)
FROM api_runtime;

GRANT EXECUTE ON FUNCTION
  runtime.resolve_query_context_candidate(uuid, text, text),
  runtime.commit_query_execution_context(
    uuid, uuid, uuid, uuid, text, uuid, text, bigint, text, text, text, integer
  ),
  runtime.activate_query_read_context(uuid, uuid, uuid, uuid, text, text, text),
  meta.retire_release_serving_head(uuid, uuid, bigint, bigint)
TO api_runtime;

GRANT SELECT ON TABLE
  runtime.query_object_current,
  runtime.query_link_current
TO api_runtime;

COMMENT ON COLUMN meta.releases.support_until IS
  'Immutable minimum explicit-service deadline, never earlier than published_at plus 90 days.';
COMMENT ON FUNCTION runtime.resolve_query_context_candidate(uuid, text, text) IS
  'Bounded one-snapshot Release/Channel, Activation, Runtime Plan, Generation, Definition and single P0 read-Policy candidate; not a Current read grant.';
COMMENT ON FUNCTION runtime.commit_query_execution_context(
  uuid, uuid, uuid, uuid, text, uuid, text, bigint, text, text, text, integer
) IS
  'Atomically revalidates the candidate Serving Activation/Generation set and commits its Query Lease.';
COMMENT ON VIEW runtime.query_object_current IS
  'Lease-gated Current Object rows for the Query PostgreSQL adapter; raw runtime.object_current remains ungranted.';
COMMENT ON VIEW runtime.query_link_current IS
  'Lease-gated Current Link rows used only by in-SQL Policy predicates; raw runtime.link_current remains ungranted.';
