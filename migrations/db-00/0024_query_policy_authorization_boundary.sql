SET LOCAL ROLE migration_owner;

-- One durable marker per Project and PostgreSQL transaction deduplicates a
-- semantic change that touches multiple rows (for example revoke + replace a
-- Role Binding).  Runtime roles cannot forge or edit this marker.
CREATE TABLE ops.authorization_epoch_advances (
  project_id uuid NOT NULL,
  transaction_id xid8 NOT NULL,
  previous_epoch bigint NOT NULL CHECK (previous_epoch >= 1),
  resulting_epoch bigint NOT NULL CHECK (resulting_epoch = previous_epoch + 1),
  advanced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, transaction_id),
  CONSTRAINT authorization_epoch_advances_project_fk FOREIGN KEY (project_id)
    REFERENCES meta.projects(project_id) ON DELETE RESTRICT
);

CREATE INDEX authorization_epoch_advances_time_idx
  ON ops.authorization_epoch_advances(advanced_at, project_id);

CREATE TRIGGER authorization_epoch_advances_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.authorization_epoch_advances
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20303_reject_immutable_fact();

-- Metadata transactions still need the historical row-lock boundary, but the
-- Runtime role must not retain direct UPDATE privilege merely to acquire it.
CREATE FUNCTION authz.lock_authorization_epoch(
  p_project_id uuid
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $lock_authorization_epoch$
DECLARE
  current_epoch bigint;
BEGIN
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'G20303_AUTHORIZATION_EPOCH_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT epoch.epoch INTO current_epoch
  FROM authz.authorization_epochs AS epoch
  WHERE epoch.project_id = p_project_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20303_AUTHORIZATION_EPOCH_NOT_FOUND' USING ERRCODE = '23503';
  END IF;
  RETURN current_epoch;
END
$lock_authorization_epoch$;

CREATE FUNCTION authz.advance_authorization_epoch(
  p_project_id uuid,
  p_expected_epoch bigint DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $advance_authorization_epoch$
DECLARE
  transaction_key xid8;
  current_epoch bigint;
  prior_result bigint;
BEGIN
  IF p_project_id IS NULL OR (p_expected_epoch IS NOT NULL AND p_expected_epoch < 1) THEN
    RAISE EXCEPTION 'G20303_AUTHORIZATION_EPOCH_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  transaction_key := pg_current_xact_id();
  SELECT advance.resulting_epoch INTO prior_result
  FROM ops.authorization_epoch_advances AS advance
  WHERE advance.project_id = p_project_id
    AND advance.transaction_id = transaction_key;
  IF FOUND THEN
    RETURN prior_result;
  END IF;

  SELECT epoch.epoch INTO current_epoch
  FROM authz.authorization_epochs AS epoch
  WHERE epoch.project_id = p_project_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20303_AUTHORIZATION_EPOCH_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF p_expected_epoch IS NOT NULL AND current_epoch <> p_expected_epoch THEN
    RAISE EXCEPTION 'G20303_AUTHORIZATION_EPOCH_CONFLICT' USING ERRCODE = '40001';
  END IF;

  INSERT INTO ops.authorization_epoch_advances (
    project_id, transaction_id, previous_epoch, resulting_epoch
  ) VALUES (p_project_id, transaction_key, current_epoch, current_epoch + 1);
  UPDATE authz.authorization_epochs
  SET epoch = current_epoch + 1, changed_at = clock_timestamp()
  WHERE project_id = p_project_id;
  RETURN current_epoch + 1;
END
$advance_authorization_epoch$;

CREATE FUNCTION ontos_migration.g20303_notify_authorization_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20303_notify_authorization_epoch$
BEGIN
  PERFORM pg_notify(
    'ontos_authorization_epoch_v1',
    json_build_object(
      'protocolVersion', 1,
      'projectId', NEW.project_id,
      'epoch', NEW.epoch
    )::text
  );
  RETURN NEW;
END
$g20303_notify_authorization_epoch$;

CREATE TRIGGER authorization_epochs_notify
AFTER INSERT OR UPDATE OF epoch ON authz.authorization_epochs
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20303_notify_authorization_epoch();

CREATE FUNCTION ontos_migration.g20303_binding_advances_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20303_binding_advances_epoch$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.state = 'active')
    OR (TG_OP = 'UPDATE' AND NEW.state IS DISTINCT FROM OLD.state) THEN
    IF EXISTS (
      SELECT 1 FROM authz.authorization_epochs AS epoch
      WHERE epoch.project_id = NEW.project_id
    ) THEN
      PERFORM authz.advance_authorization_epoch(NEW.project_id, NULL);
    END IF;
  END IF;
  RETURN NEW;
END
$g20303_binding_advances_epoch$;

CREATE TRIGGER role_bindings_advance_epoch
AFTER INSERT OR UPDATE OF state ON authz.role_bindings
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20303_binding_advances_epoch();

CREATE FUNCTION ontos_migration.g20303_principal_disable_advances_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20303_principal_disable_advances_epoch$
DECLARE
  affected_project uuid;
BEGIN
  IF OLD.state = 'active' AND NEW.state = 'disabled' THEN
    FOR affected_project IN
      SELECT DISTINCT binding.project_id
      FROM authz.role_bindings AS binding
      WHERE binding.principal_id = NEW.principal_id
        AND binding.state = 'active'
      ORDER BY binding.project_id
    LOOP
      PERFORM authz.advance_authorization_epoch(affected_project, NULL);
    END LOOP;
  END IF;
  RETURN NEW;
END
$g20303_principal_disable_advances_epoch$;

CREATE TRIGGER principals_disable_advance_epoch
AFTER UPDATE OF state ON authz.principals
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20303_principal_disable_advances_epoch();

CREATE FUNCTION authz.register_claim_mapping_revision(
  p_project_id uuid,
  p_claim_mapping_revision_id uuid,
  p_oidc_issuer text,
  p_identity_type text,
  p_revision_number bigint,
  p_mapping_digest text,
  p_mapping jsonb,
  p_created_by_principal_id uuid
) RETURNS authz.claim_mapping_revisions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $register_claim_mapping_revision$
DECLARE
  result authz.claim_mapping_revisions%ROWTYPE;
BEGIN
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  INSERT INTO authz.claim_mapping_revisions (
    project_id, claim_mapping_revision_id, oidc_issuer, identity_type,
    revision_number, mapping_digest, mapping, created_by_principal_id
  ) VALUES (
    p_project_id, p_claim_mapping_revision_id, p_oidc_issuer, p_identity_type,
    p_revision_number, p_mapping_digest, p_mapping, p_created_by_principal_id
  ) RETURNING * INTO result;
  RETURN result;
END
$register_claim_mapping_revision$;

CREATE FUNCTION authz.activate_claim_mapping(
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
  PERFORM 1 FROM authz.claim_mapping_revisions AS revision
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
  PERFORM authz.advance_authorization_epoch(
    p_project_id, p_expected_authorization_epoch
  );
  RETURN result;
END
$activate_claim_mapping$;

CREATE FUNCTION authz.resolve_claim_mapping(
  p_project_id uuid,
  p_oidc_issuer text,
  p_identity_type text
) RETURNS authz.claim_mapping_revisions
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $resolve_claim_mapping$
DECLARE
  result authz.claim_mapping_revisions%ROWTYPE;
BEGIN
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  SELECT revision.* INTO result
  FROM authz.claim_mapping_heads AS head
  JOIN authz.claim_mapping_revisions AS revision
    ON revision.project_id = head.project_id
   AND revision.oidc_issuer = head.oidc_issuer
   AND revision.identity_type = head.identity_type
   AND revision.claim_mapping_revision_id = head.claim_mapping_revision_id
  WHERE head.project_id = p_project_id
    AND head.oidc_issuer = p_oidc_issuer
    AND head.identity_type = p_identity_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20303_CLAIM_MAPPING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN result;
END
$resolve_claim_mapping$;

CREATE FUNCTION authz.record_policy_compilation(
  p_project_id uuid,
  p_policy_compilation_id uuid,
  p_release_id uuid,
  p_policy_resource_id uuid,
  p_policy_revision_id uuid,
  p_policy_content_digest text,
  p_compiler_version text,
  p_artifact_reference_id uuid,
  p_artifact_digest text,
  p_test_report_reference_id uuid,
  p_test_report_digest text,
  p_test_vector_count integer,
  p_passed_vector_count integer,
  p_failed_vector_count integer,
  p_status text
) RETURNS authz.policy_compilations
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $record_policy_compilation$
DECLARE
  result authz.policy_compilations%ROWTYPE;
BEGIN
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  INSERT INTO meta.artifact_references (
    artifact_reference_id, digest, media_type, source_kind, source_id
  ) VALUES
    (p_artifact_reference_id, p_artifact_digest,
     'application/vnd.ontos.policy-ir+json', 'policy_compilation', p_policy_compilation_id),
    (p_test_report_reference_id, p_test_report_digest,
     'application/vnd.ontos.policy-test+json', 'policy_test_report', p_policy_compilation_id);
  INSERT INTO authz.policy_compilations (
    project_id, policy_compilation_id, release_id,
    policy_resource_id, policy_revision_id, policy_content_digest,
    compiler_version, artifact_reference_id, artifact_digest,
    test_report_reference_id, test_report_digest,
    test_vector_count, passed_vector_count, failed_vector_count, status
  ) VALUES (
    p_project_id, p_policy_compilation_id, p_release_id,
    p_policy_resource_id, p_policy_revision_id, p_policy_content_digest,
    p_compiler_version, p_artifact_reference_id, p_artifact_digest,
    p_test_report_reference_id, p_test_report_digest,
    p_test_vector_count, p_passed_vector_count, p_failed_vector_count, p_status
  ) RETURNING * INTO result;
  RETURN result;
END
$record_policy_compilation$;

CREATE FUNCTION authz.resolve_policy_compilation(
  p_project_id uuid,
  p_release_id uuid,
  p_policy_revision_id uuid
) RETURNS authz.policy_compilations
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $resolve_policy_compilation$
DECLARE
  result authz.policy_compilations%ROWTYPE;
BEGIN
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  SELECT compilation.* INTO result
  FROM authz.policy_compilations AS compilation
  WHERE compilation.project_id = p_project_id
    AND compilation.release_id = p_release_id
    AND compilation.policy_revision_id = p_policy_revision_id
    AND compilation.status = 'passed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20303_POLICY_COMPILATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN result;
END
$resolve_policy_compilation$;

CREATE VIEW ops.authorization_epoch_advance_status WITH (security_barrier = true) AS
SELECT advance.project_id, count(*)::bigint AS advance_count,
       max(advance.resulting_epoch) AS latest_epoch,
       max(advance.advanced_at) AS last_advanced_at
FROM ops.authorization_epoch_advances AS advance
GROUP BY advance.project_id;

REVOKE UPDATE (epoch, changed_at)
  ON authz.authorization_epochs FROM api_runtime;

REVOKE ALL PRIVILEGES ON TABLE
  ops.authorization_epoch_advances,
  ops.authorization_epoch_advance_status
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON FUNCTION
  authz.lock_authorization_epoch(uuid),
  authz.advance_authorization_epoch(uuid, bigint),
  authz.register_claim_mapping_revision(uuid, uuid, text, text, bigint, text, jsonb, uuid),
  authz.activate_claim_mapping(uuid, text, text, uuid, bigint, bigint),
  authz.resolve_claim_mapping(uuid, text, text),
  authz.record_policy_compilation(
    uuid, uuid, uuid, uuid, uuid, text, text, uuid, text, uuid, text,
    integer, integer, integer, text
  ),
  authz.resolve_policy_compilation(uuid, uuid, uuid),
  ontos_migration.g20303_notify_authorization_epoch(),
  ontos_migration.g20303_binding_advances_epoch(),
  ontos_migration.g20303_principal_disable_advances_epoch()
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT EXECUTE ON FUNCTION
  authz.lock_authorization_epoch(uuid),
  authz.advance_authorization_epoch(uuid, bigint),
  authz.register_claim_mapping_revision(uuid, uuid, text, text, bigint, text, jsonb, uuid),
  authz.activate_claim_mapping(uuid, text, text, uuid, bigint, bigint),
  authz.resolve_claim_mapping(uuid, text, text),
  authz.record_policy_compilation(
    uuid, uuid, uuid, uuid, uuid, text, text, uuid, text, uuid, text,
    integer, integer, integer, text
  ),
  authz.resolve_policy_compilation(uuid, uuid, uuid)
TO api_runtime;
GRANT SELECT ON TABLE ops.authorization_epoch_advance_status TO read_only_ops;

COMMENT ON TABLE ops.authorization_epoch_advances IS
  'Append-only proof that all effective authorization mutations in one Project transaction advance Epoch exactly once.';
COMMENT ON FUNCTION authz.lock_authorization_epoch(uuid) IS
  'Controlled replacement for Runtime SELECT FOR UPDATE on Authorization Epoch; returns but cannot mutate the current value.';
COMMENT ON FUNCTION authz.advance_authorization_epoch(uuid, bigint) IS
  'Only supported Runtime path for monotonic Authorization Epoch changes after G2-03-03.';
