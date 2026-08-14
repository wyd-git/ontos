SET LOCAL ROLE migration_owner;

ALTER TABLE meta.package_installation_changes
  ADD COLUMN operation text NOT NULL
    CHECK (operation IN ('install', 'upgrade', 'rollback')),
  ADD COLUMN previous_package_revision_id uuid,
  ADD COLUMN previous_release_id uuid,
  ADD COLUMN request_digest varchar(71) NOT NULL
    CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN input_bindings jsonb NOT NULL
    CHECK (jsonb_typeof(input_bindings) = 'array'),
  ADD COLUMN input_bindings_digest varchar(71) NOT NULL
    CHECK (input_bindings_digest ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN compatibility_report jsonb NOT NULL
    CHECK (jsonb_typeof(compatibility_report) = 'object'),
  ADD COLUMN created_by_principal_id uuid NOT NULL
    REFERENCES authz.principals(principal_id) ON DELETE RESTRICT,
  ADD CONSTRAINT package_installation_changes_previous_revision_fk
    FOREIGN KEY (package_id, previous_package_revision_id)
    REFERENCES meta.package_revisions(package_id, package_revision_id) ON DELETE RESTRICT,
  ADD CONSTRAINT package_installation_changes_previous_release_fk
    FOREIGN KEY (project_id, previous_release_id)
    REFERENCES meta.releases(project_id, release_id) ON DELETE RESTRICT,
  ADD CONSTRAINT package_installation_changes_operation_ck CHECK (
    (operation = 'install'
      AND previous_package_revision_id IS NULL
      AND previous_release_id IS NULL)
    OR (operation IN ('upgrade', 'rollback')
      AND previous_package_revision_id IS NOT NULL
      AND previous_release_id IS NOT NULL
      AND previous_package_revision_id <> target_package_revision_id
      AND previous_release_id <> target_release_id)
  ),
  ADD CONSTRAINT package_installation_changes_target_release_uq UNIQUE (target_release_id),
  ADD CONSTRAINT package_installation_changes_request_digest_uq
    UNIQUE (installation_id, request_digest);

CREATE UNIQUE INDEX package_installation_changes_pending_uq
  ON meta.package_installation_changes (installation_id)
  WHERE state = 'pending';

CREATE UNIQUE INDEX package_installation_changes_active_uq
  ON meta.package_installation_changes (installation_id)
  WHERE state = 'active';

CREATE FUNCTION ontos_migration.g20109_enforce_package_revision_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20109_package_revision_insert$
DECLARE
  package_namespace text;
  package_api_name text;
BEGIN
  SELECT package.namespace, package.api_name
  INTO package_namespace, package_api_name
  FROM meta.packages AS package
  WHERE package.package_id = NEW.package_id;

  IF NOT FOUND THEN RETURN NEW; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(NEW.manifest)) <> 9
    OR NEW.manifest ->> 'schemaVersion' <> '1'
    OR NEW.manifest ->> 'packageApiName' <> package_api_name
    OR NEW.manifest ->> 'namespace' <> package_namespace
    OR NEW.manifest ->> 'version' <> NEW.version
    OR NEW.manifest ->> 'kernelContractVersion' <> 'metadata-1'
    OR NEW.manifest ->> 'manifestDigest' <> NEW.manifest_digest
    OR jsonb_typeof(NEW.manifest -> 'resourceEntries') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.manifest -> 'resourceEntries') NOT BETWEEN 1 AND 512
    OR jsonb_typeof(NEW.manifest -> 'artifactDigests') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.manifest -> 'artifactDigests') > 128
    OR jsonb_typeof(NEW.manifest -> 'installInputs') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.manifest -> 'installInputs') > 64 THEN
    RAISE EXCEPTION 'G20109_PACKAGE_MANIFEST_FACT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(NEW.manifest -> 'artifactDigests') AS artifact(digest)
    WHERE artifact.digest !~ '^sha256:[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'G20109_PACKAGE_ARTIFACT_DIGEST_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$g20109_package_revision_insert$;

CREATE FUNCTION ontos_migration.g20109_enforce_package_change_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20109_package_change_insert$
DECLARE
  release_state text;
  release_project_id uuid;
  current_revision_id uuid;
  current_release_id uuid;
  candidate_manifest jsonb;
  candidate_digest text;
  previous_digest text;
  entry_count integer;
  matched_pin_count integer;
BEGIN
  SELECT release.state, release.project_id
  INTO release_state, release_project_id
  FROM meta.releases AS release
  WHERE release.release_id = NEW.target_release_id
  FOR UPDATE;

  SELECT installation.active_package_revision_id, installation.active_release_id
  INTO current_revision_id, current_release_id
  FROM meta.package_installations AS installation
  WHERE installation.installation_id = NEW.installation_id
  FOR UPDATE;

  SELECT revision.manifest, revision.manifest_digest
  INTO candidate_manifest, candidate_digest
  FROM meta.package_revisions AS revision
  WHERE revision.package_id = NEW.package_id
    AND revision.package_revision_id = NEW.target_package_revision_id;

  IF release_state IS DISTINCT FROM 'draft'
    OR release_project_id IS DISTINCT FROM NEW.project_id
    OR candidate_manifest IS NULL THEN
    RAISE EXCEPTION 'G20109_PACKAGE_CHANGE_TARGET_INVALID' USING ERRCODE = '55000';
  END IF;
  IF NEW.operation = 'install' THEN
    IF current_revision_id IS NOT NULL OR current_release_id IS NOT NULL THEN
      RAISE EXCEPTION 'G20109_PACKAGE_ALREADY_INSTALLED' USING ERRCODE = '55000';
    END IF;
    previous_digest := repeat('0', 64);
    previous_digest := 'sha256:' || previous_digest;
  ELSE
    IF current_revision_id IS DISTINCT FROM NEW.previous_package_revision_id
      OR current_release_id IS DISTINCT FROM NEW.previous_release_id THEN
      RAISE EXCEPTION 'G20109_PACKAGE_ACTIVE_POINTER_STALE' USING ERRCODE = '40001';
    END IF;
    SELECT manifest_digest INTO previous_digest
    FROM meta.package_revisions
    WHERE package_id = NEW.package_id
      AND package_revision_id = NEW.previous_package_revision_id;
  END IF;
  IF NEW.compatibility_report ->> 'outcome' <> 'compatible'
    OR NEW.compatibility_report ->> 'candidateDigest' <> candidate_digest
    OR NEW.compatibility_report ->> 'baselineDigest' <> previous_digest THEN
    RAISE EXCEPTION 'G20109_PACKAGE_COMPATIBILITY_REPORT_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT jsonb_array_length(candidate_manifest -> 'resourceEntries') INTO entry_count;
  SELECT count(*)::integer INTO matched_pin_count
  FROM jsonb_array_elements(candidate_manifest -> 'resourceEntries') AS entry(value)
  JOIN meta.release_pins AS pin
    ON pin.release_id = NEW.target_release_id
   AND pin.resource_id = (entry.value ->> 'resourceId')::uuid
   AND pin.revision_id = (entry.value ->> 'revisionId')::uuid
   AND pin.family = entry.value ->> 'family'
   AND pin.content_digest = entry.value ->> 'contentDigest';
  IF matched_pin_count <> entry_count THEN
    RAISE EXCEPTION 'G20109_PACKAGE_RELEASE_EXPANSION_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$g20109_package_change_insert$;

CREATE OR REPLACE FUNCTION ontos_migration.db01_enforce_package_change_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $db01_package_change_update$
BEGIN
  IF NEW.change_id IS DISTINCT FROM OLD.change_id
    OR NEW.installation_id IS DISTINCT FROM OLD.installation_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.package_id IS DISTINCT FROM OLD.package_id
    OR NEW.request_key IS DISTINCT FROM OLD.request_key
    OR NEW.target_package_revision_id IS DISTINCT FROM OLD.target_package_revision_id
    OR NEW.target_release_id IS DISTINCT FROM OLD.target_release_id
    OR NEW.operation IS DISTINCT FROM OLD.operation
    OR NEW.previous_package_revision_id IS DISTINCT FROM OLD.previous_package_revision_id
    OR NEW.previous_release_id IS DISTINCT FROM OLD.previous_release_id
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.input_bindings IS DISTINCT FROM OLD.input_bindings
    OR NEW.input_bindings_digest IS DISTINCT FROM OLD.input_bindings_digest
    OR NEW.compatibility_report IS DISTINCT FROM OLD.compatibility_report
    OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'DB01_PACKAGE_CHANGE_TARGET_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
    AND NOT ((OLD.state = 'pending' AND NEW.state IN ('active', 'failed'))
      OR (OLD.state = 'active' AND NEW.state = 'superseded')) THEN
    RAISE EXCEPTION 'DB01_PACKAGE_CHANGE_STATE_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'pending' AND NEW.state = 'active' AND NOT EXISTS (
    SELECT 1
    FROM meta.package_installations AS installation
    JOIN meta.releases AS release
      ON release.project_id = installation.project_id
     AND release.release_id = NEW.target_release_id
    JOIN meta.release_channels AS channel
      ON channel.project_id = release.project_id
     AND channel.channel_name = release.target_channel_name
     AND channel.release_id = release.release_id
    WHERE installation.installation_id = NEW.installation_id
      AND installation.active_package_revision_id = NEW.target_package_revision_id
      AND installation.active_release_id = NEW.target_release_id
      AND release.state = 'published'
  ) THEN
    RAISE EXCEPTION 'G20109_PACKAGE_CHANGE_NOT_ACTIVATED_BY_RELEASE' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'active' AND NEW.state = 'superseded' AND EXISTS (
    SELECT 1 FROM meta.package_installations AS installation
    WHERE installation.installation_id = NEW.installation_id
      AND installation.active_package_revision_id = NEW.target_package_revision_id
      AND installation.active_release_id = NEW.target_release_id
  ) THEN
    RAISE EXCEPTION 'G20109_ACTIVE_PACKAGE_CHANGE_STILL_REFERENCED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$db01_package_change_update$;

CREATE FUNCTION ontos_migration.g20109_enforce_installation_activation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20109_installation_activation$
BEGIN
  IF NEW.active_package_revision_id IS NOT DISTINCT FROM OLD.active_package_revision_id
    AND NEW.active_release_id IS NOT DISTINCT FROM OLD.active_release_id THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM meta.package_installation_changes AS change
    JOIN meta.releases AS release
      ON release.project_id = change.project_id
     AND release.release_id = change.target_release_id
    JOIN meta.release_channels AS channel
      ON channel.project_id = release.project_id
     AND channel.channel_name = release.target_channel_name
     AND channel.release_id = release.release_id
    WHERE change.installation_id = OLD.installation_id
      AND change.project_id = OLD.project_id
      AND change.package_id = OLD.package_id
      AND change.target_package_revision_id = NEW.active_package_revision_id
      AND change.target_release_id = NEW.active_release_id
      AND change.state = 'pending'
      AND release.state = 'published'
  ) THEN
    RAISE EXCEPTION 'G20109_INSTALLATION_POINTER_REQUIRES_PUBLISHED_CHANGE'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20109_installation_activation$;

CREATE FUNCTION ontos_migration.g20109_assert_package_publication_integrity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20109_package_integrity$
DECLARE
  affected_release_id uuid;
  affected_installation_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'releases' THEN
    affected_release_id := NEW.release_id;
  ELSIF TG_TABLE_NAME = 'package_installation_changes' THEN
    affected_release_id := NEW.target_release_id;
    affected_installation_id := NEW.installation_id;
  ELSE
    affected_release_id := NEW.active_release_id;
    affected_installation_id := NEW.installation_id;
  END IF;

  IF affected_release_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM meta.releases
      WHERE release_id = affected_release_id AND state IN ('published', 'superseded')
    )
    AND EXISTS (
      SELECT 1
      FROM meta.package_installation_changes AS change
      WHERE change.target_release_id = affected_release_id
        AND (
          change.state IN ('pending', 'failed')
          OR (change.state = 'active' AND NOT EXISTS (
              SELECT 1
              FROM meta.package_installations AS installation
              WHERE installation.installation_id = change.installation_id
                AND installation.active_package_revision_id = change.target_package_revision_id
                AND installation.active_release_id = change.target_release_id
            ))
          OR (change.state = 'superseded' AND EXISTS (
              SELECT 1
              FROM meta.package_installations AS installation
              WHERE installation.installation_id = change.installation_id
                AND installation.active_package_revision_id = change.target_package_revision_id
                AND installation.active_release_id = change.target_release_id
            ))
        )
    ) THEN
    RAISE EXCEPTION 'G20109_PUBLISHED_PACKAGE_CHANGE_INCOMPLETE' USING ERRCODE = '55000';
  END IF;

  IF affected_installation_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM meta.package_installations AS installation
    WHERE installation.installation_id = affected_installation_id
      AND installation.active_package_revision_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM meta.package_installation_changes AS change
        JOIN meta.releases AS release ON release.release_id = change.target_release_id
        WHERE change.installation_id = installation.installation_id
          AND change.target_package_revision_id = installation.active_package_revision_id
          AND change.target_release_id = installation.active_release_id
          AND change.state = 'active'
          AND release.state IN ('published', 'superseded')
      )
  ) THEN
    RAISE EXCEPTION 'G20109_INSTALLATION_ACTIVE_CHANGE_INCOMPLETE' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$g20109_package_integrity$;

CREATE TRIGGER package_revisions_manifest_guard
BEFORE INSERT ON meta.package_revisions
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20109_enforce_package_revision_insert();

CREATE TRIGGER package_installation_changes_target_guard
BEFORE INSERT ON meta.package_installation_changes
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20109_enforce_package_change_insert();

CREATE TRIGGER package_installations_activation_guard
BEFORE UPDATE ON meta.package_installations
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20109_enforce_installation_activation();

CREATE CONSTRAINT TRIGGER releases_package_publication_integrity
AFTER INSERT OR UPDATE ON meta.releases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20109_assert_package_publication_integrity();

CREATE CONSTRAINT TRIGGER package_changes_publication_integrity
AFTER INSERT OR UPDATE ON meta.package_installation_changes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20109_assert_package_publication_integrity();

CREATE CONSTRAINT TRIGGER package_installations_publication_integrity
AFTER INSERT OR UPDATE ON meta.package_installations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20109_assert_package_publication_integrity();

REVOKE ALL PRIVILEGES ON FUNCTION
  ontos_migration.g20109_enforce_package_revision_insert(),
  ontos_migration.g20109_enforce_package_change_insert(),
  ontos_migration.g20109_enforce_installation_activation(),
  ontos_migration.g20109_assert_package_publication_integrity()
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
