SET LOCAL ROLE migration_owner;

-- A service Principal is bound to exactly one OAuth client per Project.  The
-- capability array is a server-owned allowlist, never copied from a token.
CREATE TABLE authz.service_identity_profiles (
  project_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  oidc_client_id varchar(255) NOT NULL CHECK (btrim(oidc_client_id) <> ''),
  capabilities text[] NOT NULL CHECK (
    cardinality(capabilities) BETWEEN 1 AND 16
    AND pg_column_size(capabilities) <= 4096
  ),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (project_id, principal_id),
  CONSTRAINT service_identity_profiles_project_fk FOREIGN KEY (project_id)
    REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  CONSTRAINT service_identity_profiles_principal_fk FOREIGN KEY (principal_id)
    REFERENCES authz.principals(principal_id) ON DELETE RESTRICT,
  CONSTRAINT service_identity_profiles_client_uq UNIQUE (project_id, oidc_client_id),
  CONSTRAINT service_identity_profiles_state_ck CHECK (
    (state = 'active' AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL)
  )
);

-- Only irreversible protocol fingerprints cross this persistence boundary.
-- The table is global by fingerprint so a credential cannot be replayed under
-- a second Project.  Project remains present for isolation and operations.
CREATE TABLE authz.delegation_replay_records (
  replay_fingerprint varchar(71) PRIMARY KEY
    CHECK (replay_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  project_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT delegation_replay_records_project_fk FOREIGN KEY (project_id)
    REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  CONSTRAINT delegation_replay_records_time_ck CHECK (expires_at > consumed_at)
);

CREATE INDEX delegation_replay_records_expiry_idx
  ON authz.delegation_replay_records(expires_at, replay_fingerprint);

-- This is an intentionally redacted audit event: it identifies immutable
-- Mapping facts and the resulting Epoch, but stores neither Issuer nor Mapping
-- JSON, claims, subjects, tokens or credentials.
CREATE TABLE audit.claim_mapping_activation_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL,
  identity_type text NOT NULL CHECK (identity_type IN ('human', 'service')),
  previous_claim_mapping_revision_id uuid,
  claim_mapping_revision_id uuid NOT NULL,
  mapping_digest varchar(71) NOT NULL
    CHECK (mapping_digest ~ '^sha256:[0-9a-f]{64}$'),
  control_sequence bigint NOT NULL CHECK (control_sequence >= 1),
  resulting_authorization_epoch bigint NOT NULL CHECK (resulting_authorization_epoch >= 2),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT claim_mapping_activation_events_project_fk FOREIGN KEY (project_id)
    REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  CONSTRAINT claim_mapping_activation_events_revision_fk FOREIGN KEY (
    project_id, claim_mapping_revision_id
  ) REFERENCES authz.claim_mapping_revisions(
    project_id, claim_mapping_revision_id
  ) ON DELETE RESTRICT,
  CONSTRAINT claim_mapping_activation_events_identity_uq UNIQUE (
    project_id, claim_mapping_revision_id, control_sequence
  )
);

CREATE INDEX claim_mapping_activation_events_time_idx
  ON audit.claim_mapping_activation_events(occurred_at, project_id);

CREATE FUNCTION ontos_migration.g20304_enforce_service_identity_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20304_service_profile$
DECLARE
  capability text;
  distinct_capability_count integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'G20304_SERVICE_PROFILE_INITIAL_STATE_INVALID' USING ERRCODE = '23514';
    END IF;
    SELECT count(DISTINCT candidate)::integer INTO distinct_capability_count
    FROM unnest(NEW.capabilities) AS candidate;
    IF distinct_capability_count <> cardinality(NEW.capabilities) THEN
      RAISE EXCEPTION 'G20304_SERVICE_CAPABILITY_DUPLICATE' USING ERRCODE = '23514';
    END IF;
    FOREACH capability IN ARRAY NEW.capabilities LOOP
      IF capability !~ '^[a-z][a-z0-9_.:-]{0,127}$' THEN
        RAISE EXCEPTION 'G20304_SERVICE_CAPABILITY_INVALID' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    IF NOT EXISTS (
      SELECT 1 FROM authz.principals AS principal
      WHERE principal.principal_id = NEW.principal_id
        AND principal.identity_type = 'service'
        AND principal.state = 'active'
    ) THEN
      RAISE EXCEPTION 'G20304_SERVICE_PRINCIPAL_INVALID' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM authz.role_bindings AS binding
      WHERE binding.project_id = NEW.project_id
        AND binding.principal_id = NEW.principal_id
        AND binding.state = 'active'
    ) THEN
      RAISE EXCEPTION 'G20304_SERVICE_PROJECT_BINDING_REQUIRED' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.oidc_client_id IS DISTINCT FROM OLD.oidc_client_id
    OR NEW.capabilities IS DISTINCT FROM OLD.capabilities
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.state <> 'active'
    OR NEW.state <> 'revoked'
    OR NEW.revoked_at IS NULL
    OR NEW.changed_at <= OLD.changed_at THEN
    RAISE EXCEPTION 'G20304_SERVICE_PROFILE_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20304_service_profile$;

CREATE FUNCTION ontos_migration.g20304_service_profile_advances_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20304_service_profile_epoch$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM authz.advance_authorization_epoch(NEW.project_id, NULL);
  END IF;
  RETURN NEW;
END
$g20304_service_profile_epoch$;

CREATE TRIGGER service_identity_profiles_guard
BEFORE INSERT OR UPDATE ON authz.service_identity_profiles
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20304_enforce_service_identity_profile();
CREATE TRIGGER service_identity_profiles_no_delete
BEFORE DELETE OR TRUNCATE ON authz.service_identity_profiles
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20303_reject_immutable_fact();
CREATE TRIGGER service_identity_profiles_advance_epoch
AFTER INSERT OR UPDATE OF state ON authz.service_identity_profiles
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20304_service_profile_advances_epoch();

CREATE TRIGGER claim_mapping_activation_events_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON audit.claim_mapping_activation_events
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20303_reject_immutable_fact();

ALTER TABLE authz.service_identity_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE authz.service_identity_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE authz.delegation_replay_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE authz.delegation_replay_records FORCE ROW LEVEL SECURITY;
ALTER TABLE audit.claim_mapping_activation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.claim_mapping_activation_events FORCE ROW LEVEL SECURITY;

CREATE POLICY service_identity_profiles_project_isolation
  ON authz.service_identity_profiles
  USING (current_user = 'migration_owner' OR project_id = authz.g20303_project_context())
  WITH CHECK (current_user = 'migration_owner' OR project_id = authz.g20303_project_context());
CREATE POLICY delegation_replay_records_project_isolation
  ON authz.delegation_replay_records
  USING (current_user = 'migration_owner' OR project_id = authz.g20303_project_context())
  WITH CHECK (current_user = 'migration_owner' OR project_id = authz.g20303_project_context());
CREATE POLICY claim_mapping_activation_events_ops_isolation
  ON audit.claim_mapping_activation_events
  USING (
    current_user = 'migration_owner'
    OR pg_has_role(current_user, 'read_only_ops', 'USAGE')
    OR project_id = authz.g20303_project_context()
  );

CREATE FUNCTION authz.register_service_identity_profile(
  p_project_id uuid,
  p_principal_id uuid,
  p_oidc_client_id text,
  p_capabilities text[],
  p_expected_authorization_epoch bigint
) RETURNS authz.service_identity_profiles
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $register_service_identity_profile$
DECLARE
  current_epoch bigint;
  result authz.service_identity_profiles%ROWTYPE;
BEGIN
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  current_epoch := authz.lock_authorization_epoch(p_project_id);
  IF current_epoch <> p_expected_authorization_epoch THEN
    RAISE EXCEPTION 'G20304_AUTHORIZATION_EPOCH_CONFLICT' USING ERRCODE = '40001';
  END IF;
  INSERT INTO authz.service_identity_profiles (
    project_id, principal_id, oidc_client_id, capabilities
  ) VALUES (
    p_project_id, p_principal_id, p_oidc_client_id, p_capabilities
  ) RETURNING * INTO result;
  RETURN result;
END
$register_service_identity_profile$;

CREATE FUNCTION authz.revoke_service_identity_profile(
  p_project_id uuid,
  p_principal_id uuid,
  p_expected_authorization_epoch bigint
) RETURNS authz.service_identity_profiles
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $revoke_service_identity_profile$
DECLARE
  current_epoch bigint;
  result authz.service_identity_profiles%ROWTYPE;
BEGIN
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  current_epoch := authz.lock_authorization_epoch(p_project_id);
  IF current_epoch <> p_expected_authorization_epoch THEN
    RAISE EXCEPTION 'G20304_AUTHORIZATION_EPOCH_CONFLICT' USING ERRCODE = '40001';
  END IF;
  UPDATE authz.service_identity_profiles AS profile
  SET state = 'revoked', revoked_at = clock_timestamp(), changed_at = clock_timestamp()
  WHERE profile.project_id = p_project_id
    AND profile.principal_id = p_principal_id
    AND profile.state = 'active'
  RETURNING profile.* INTO result;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20304_SERVICE_PROFILE_NOT_ACTIVE' USING ERRCODE = 'P0002';
  END IF;
  RETURN result;
END
$revoke_service_identity_profile$;

-- This is the only Runtime identity lookup.  It never auto-provisions an
-- unknown Principal and never accepts client-supplied Principal ID or type.
CREATE FUNCTION authz.resolve_runtime_principal(
  p_project_id uuid,
  p_oidc_issuer text,
  p_oidc_subject text
) RETURNS TABLE (
  principal_id uuid,
  identity_type text,
  principal_state text,
  project_bound boolean,
  service_client_id text,
  service_capabilities text[],
  service_profile_state text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $resolve_runtime_principal$
  SELECT principal.principal_id,
         principal.identity_type,
         principal.state,
         EXISTS (
           SELECT 1 FROM authz.role_bindings AS binding
           WHERE binding.project_id = p_project_id
             AND binding.principal_id = principal.principal_id
             AND binding.state = 'active'
         ) AS project_bound,
         profile.oidc_client_id,
         profile.capabilities,
         profile.state
  FROM authz.principals AS principal
  LEFT JOIN authz.service_identity_profiles AS profile
    ON profile.project_id = p_project_id
   AND profile.principal_id = principal.principal_id
  WHERE principal.oidc_issuer = p_oidc_issuer
    AND principal.oidc_subject = p_oidc_subject
$resolve_runtime_principal$;

CREATE FUNCTION authz.consume_delegation_replay(
  p_project_id uuid,
  p_replay_fingerprint text,
  p_expires_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $consume_delegation_replay$
DECLARE
  now_at timestamptz := clock_timestamp();
  inserted_count integer;
BEGIN
  IF p_project_id IS NULL
    OR p_replay_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    OR p_expires_at <= now_at
    OR p_expires_at > now_at + interval '120 seconds' THEN
    RETURN FALSE;
  END IF;
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  DELETE FROM authz.delegation_replay_records AS replay
  WHERE replay.replay_fingerprint IN (
    SELECT expired.replay_fingerprint
    FROM authz.delegation_replay_records AS expired
    WHERE expired.expires_at <= now_at
    ORDER BY expired.expires_at, expired.replay_fingerprint
    LIMIT 128
  );
  INSERT INTO authz.delegation_replay_records (
    replay_fingerprint, project_id, consumed_at, expires_at
  ) VALUES (
    p_replay_fingerprint, p_project_id, now_at, p_expires_at
  ) ON CONFLICT (replay_fingerprint) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count = 1;
END
$consume_delegation_replay$;

CREATE FUNCTION authz.prune_delegation_replays(
  p_limit integer
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $prune_delegation_replays$
DECLARE
  deleted_count integer;
BEGIN
  IF p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'G20304_REPLAY_PRUNE_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  DELETE FROM authz.delegation_replay_records AS replay
  WHERE replay.replay_fingerprint IN (
    SELECT expired.replay_fingerprint
    FROM authz.delegation_replay_records AS expired
    WHERE expired.expires_at <= clock_timestamp()
    ORDER BY expired.expires_at, expired.replay_fingerprint
    LIMIT p_limit
  );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END
$prune_delegation_replays$;

-- Forward repair of the existing controlled activation function.  Semantics
-- stay unchanged except that each real head change now appends one redacted
-- audit event after the transactional Epoch advance.
CREATE OR REPLACE FUNCTION authz.activate_claim_mapping(
  p_project_id uuid,
  p_oidc_issuer text,
  p_identity_type text,
  p_claim_mapping_revision_id uuid,
  p_expected_control_sequence bigint,
  p_expected_authorization_epoch bigint
) RETURNS authz.claim_mapping_heads
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $activate_claim_mapping$
DECLARE
  current_head authz.claim_mapping_heads%ROWTYPE;
  result authz.claim_mapping_heads%ROWTYPE;
  mapping_digest_value text;
  resulting_epoch bigint;
BEGIN
  IF p_expected_control_sequence < 0 OR p_expected_authorization_epoch < 1 THEN
    RAISE EXCEPTION 'G20303_CLAIM_MAPPING_ACTIVATION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  PERFORM 1 FROM authz.authorization_epochs AS epoch
  WHERE epoch.project_id = p_project_id AND epoch.epoch = p_expected_authorization_epoch
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20303_AUTHORIZATION_EPOCH_CONFLICT' USING ERRCODE = '40001';
  END IF;
  SELECT revision.mapping_digest INTO mapping_digest_value
  FROM authz.claim_mapping_revisions AS revision
  WHERE revision.project_id = p_project_id
    AND revision.oidc_issuer = p_oidc_issuer
    AND revision.identity_type = p_identity_type
    AND revision.claim_mapping_revision_id = p_claim_mapping_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20303_CLAIM_MAPPING_REVISION_MISMATCH' USING ERRCODE = '23503';
  END IF;

  SELECT head.* INTO current_head
  FROM authz.claim_mapping_heads AS head
  WHERE head.project_id = p_project_id
    AND head.oidc_issuer = p_oidc_issuer
    AND head.identity_type = p_identity_type
  FOR UPDATE;
  IF FOUND AND current_head.claim_mapping_revision_id = p_claim_mapping_revision_id THEN
    IF current_head.control_sequence <> p_expected_control_sequence THEN
      RAISE EXCEPTION 'G20303_CLAIM_MAPPING_CONTROL_CONFLICT' USING ERRCODE = '40001';
    END IF;
    RETURN current_head;
  END IF;

  IF NOT FOUND THEN
    IF p_expected_control_sequence <> 0 THEN
      RAISE EXCEPTION 'G20303_CLAIM_MAPPING_CONTROL_CONFLICT' USING ERRCODE = '40001';
    END IF;
    INSERT INTO authz.claim_mapping_heads (
      project_id, oidc_issuer, identity_type,
      claim_mapping_revision_id, control_sequence
    ) VALUES (
      p_project_id, p_oidc_issuer, p_identity_type,
      p_claim_mapping_revision_id, 1
    ) RETURNING * INTO result;
  ELSE
    IF current_head.control_sequence <> p_expected_control_sequence THEN
      RAISE EXCEPTION 'G20303_CLAIM_MAPPING_CONTROL_CONFLICT' USING ERRCODE = '40001';
    END IF;
    UPDATE authz.claim_mapping_heads AS head
    SET claim_mapping_revision_id = p_claim_mapping_revision_id,
        control_sequence = control_sequence + 1,
        changed_at = clock_timestamp()
    WHERE head.project_id = p_project_id
      AND head.oidc_issuer = p_oidc_issuer
      AND head.identity_type = p_identity_type
    RETURNING head.* INTO result;
  END IF;
  resulting_epoch := authz.advance_authorization_epoch(
    p_project_id, p_expected_authorization_epoch
  );
  INSERT INTO audit.claim_mapping_activation_events (
    project_id, identity_type, previous_claim_mapping_revision_id,
    claim_mapping_revision_id, mapping_digest, control_sequence,
    resulting_authorization_epoch
  ) VALUES (
    p_project_id, p_identity_type, current_head.claim_mapping_revision_id,
    p_claim_mapping_revision_id, mapping_digest_value, result.control_sequence,
    resulting_epoch
  );
  RETURN result;
END
$activate_claim_mapping$;

REVOKE ALL PRIVILEGES ON TABLE
  authz.service_identity_profiles,
  authz.delegation_replay_records,
  audit.claim_mapping_activation_events
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON SEQUENCE audit.claim_mapping_activation_events_event_id_seq
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON FUNCTION
  authz.register_service_identity_profile(uuid, uuid, text, text[], bigint),
  authz.revoke_service_identity_profile(uuid, uuid, bigint),
  authz.resolve_runtime_principal(uuid, text, text),
  authz.consume_delegation_replay(uuid, text, timestamptz),
  authz.prune_delegation_replays(integer),
  authz.activate_claim_mapping(uuid, text, text, uuid, bigint, bigint),
  ontos_migration.g20304_enforce_service_identity_profile(),
  ontos_migration.g20304_service_profile_advances_epoch()
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT EXECUTE ON FUNCTION
  authz.register_service_identity_profile(uuid, uuid, text, text[], bigint),
  authz.revoke_service_identity_profile(uuid, uuid, bigint),
  authz.resolve_runtime_principal(uuid, text, text),
  authz.consume_delegation_replay(uuid, text, timestamptz),
  authz.activate_claim_mapping(uuid, text, text, uuid, bigint, bigint)
TO api_runtime;
GRANT EXECUTE ON FUNCTION authz.prune_delegation_replays(integer) TO worker_runtime;
GRANT SELECT ON TABLE audit.claim_mapping_activation_events TO read_only_ops;

COMMENT ON TABLE authz.service_identity_profiles IS
  'Server-owned immutable OAuth client binding and capability allowlist for one service Principal in one Project.';
COMMENT ON TABLE authz.delegation_replay_records IS
  'Bounded-lifetime irreversible fingerprints consumed atomically across every API process.';
COMMENT ON TABLE audit.claim_mapping_activation_events IS
  'Redacted append-only Claim Mapping activation audit; contains no Issuer, Mapping JSON, Subject or credential.';
COMMENT ON FUNCTION authz.resolve_runtime_principal(uuid, text, text) IS
  'Fail-closed Runtime lookup; never provisions Principal or trusts client Principal ID/type.';
