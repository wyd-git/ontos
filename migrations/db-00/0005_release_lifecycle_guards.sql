SET LOCAL ROLE migration_owner;

ALTER TABLE meta.releases
  ADD COLUMN target_channel_name varchar(63) NOT NULL DEFAULT 'stable'
    CHECK (target_channel_name ~ '^[a-z][a-z0-9_-]{0,62}$'),
  ADD COLUMN staged_from_release_id uuid,
  ADD COLUMN staged_from_activation_id uuid,
  ADD COLUMN staged_channel_control_sequence bigint,
  ADD COLUMN staged_validation_context_digest varchar(71),
  ADD COLUMN staged_at timestamptz,
  ADD CONSTRAINT releases_safe_number_ck
    CHECK (release_number <= 9007199254740991),
  ADD CONSTRAINT releases_staged_context_digest_ck
    CHECK (
      staged_validation_context_digest IS NULL
      OR staged_validation_context_digest ~ '^sha256:[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT releases_staged_channel_sequence_ck
    CHECK (
      staged_channel_control_sequence IS NULL
      OR staged_channel_control_sequence >= 0
    ),
  ADD CONSTRAINT releases_staged_pointer_pair_ck
    CHECK (
      (staged_channel_control_sequence IS NULL
        AND staged_from_release_id IS NULL
        AND staged_from_activation_id IS NULL)
      OR (staged_channel_control_sequence = 0
        AND staged_from_release_id IS NULL
        AND staged_from_activation_id IS NULL)
      OR (staged_channel_control_sequence >= 1
        AND staged_from_release_id IS NOT NULL
        AND staged_from_activation_id IS NOT NULL)
    ),
  ADD CONSTRAINT releases_stage_facts_ck
    CHECK (
      (state = 'draft'
        AND staged_channel_control_sequence IS NULL
        AND staged_validation_context_digest IS NULL
        AND staged_at IS NULL)
      OR (state IN ('staging', 'ready', 'published', 'superseded')
        AND staged_channel_control_sequence IS NOT NULL
        AND staged_validation_context_digest IS NOT NULL
        AND staged_at IS NOT NULL)
      OR state = 'failed'
    ),
  ADD CONSTRAINT releases_staged_release_fk
    FOREIGN KEY (project_id, staged_from_release_id)
    REFERENCES meta.releases(project_id, release_id) ON DELETE RESTRICT,
  ADD CONSTRAINT releases_staged_activation_fk
    FOREIGN KEY (staged_from_release_id, staged_from_activation_id)
    REFERENCES meta.runtime_activations(release_id, activation_id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION ontos_migration.db01_enforce_release_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $db01_release_update$
BEGIN
  IF NEW.release_id IS DISTINCT FROM OLD.release_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.rollback_of_release_id IS DISTINCT FROM OLD.rollback_of_release_id
    OR NEW.release_number IS DISTINCT FROM OLD.release_number
    OR NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest
    OR NEW.target_channel_name IS DISTINCT FROM OLD.target_channel_name
    OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'DB01_RELEASE_FACT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state
    AND NOT ((OLD.state = 'draft' AND NEW.state IN ('staging', 'failed'))
      OR (OLD.state = 'staging' AND NEW.state IN ('ready', 'failed'))
      OR (OLD.state = 'ready' AND NEW.state = 'published')
      OR (OLD.state = 'published' AND NEW.state = 'superseded')) THEN
    RAISE EXCEPTION 'DB01_RELEASE_STATE_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;

  IF OLD.state = 'draft' AND NEW.state = 'staging' THEN
    IF NEW.staged_channel_control_sequence IS NULL
      OR NEW.staged_validation_context_digest IS NULL
      OR NEW.staged_at IS NULL THEN
      RAISE EXCEPTION 'G20108_RELEASE_STAGE_FACTS_REQUIRED' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.staged_from_release_id IS DISTINCT FROM OLD.staged_from_release_id
    OR NEW.staged_from_activation_id IS DISTINCT FROM OLD.staged_from_activation_id
    OR NEW.staged_channel_control_sequence IS DISTINCT FROM OLD.staged_channel_control_sequence
    OR NEW.staged_validation_context_digest IS DISTINCT FROM OLD.staged_validation_context_digest
    OR NEW.staged_at IS DISTINCT FROM OLD.staged_at THEN
    RAISE EXCEPTION 'G20108_RELEASE_STAGE_FACTS_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF OLD.state IN ('published', 'superseded')
    AND (NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.published_by_principal_id IS DISTINCT FROM OLD.published_by_principal_id) THEN
    RAISE EXCEPTION 'DB01_RELEASE_PUBLICATION_FACT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF (OLD.state = 'draft' AND NEW.state = 'staging')
    OR (OLD.state = 'staging' AND NEW.state = 'ready') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM meta.validation_reports AS report
      WHERE report.subject_type = 'release'
        AND report.release_id = OLD.release_id
        AND report.subject_digest = OLD.manifest_digest
        AND report.validation_context_digest = NEW.staged_validation_context_digest
        AND report.validator_version = 'metadata-release-g2-01-v1'
        AND report.valid = TRUE
    ) THEN
      RAISE EXCEPTION 'G20108_RELEASE_VALID_REPORT_REQUIRED' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM meta.release_pins WHERE release_id = OLD.release_id)
      OR EXISTS (
        SELECT 1
        FROM meta.release_pins AS pin
        JOIN meta.resource_revisions AS revision
          ON revision.revision_id = pin.revision_id
         AND revision.resource_id = pin.resource_id
        JOIN meta.resources AS resource
          ON resource.resource_id = pin.resource_id
        WHERE pin.release_id = OLD.release_id
          AND (revision.family <> pin.family
            OR revision.content_digest <> pin.content_digest
            OR revision.state NOT IN ('validated', 'published', 'deprecated')
            OR resource.project_id <> OLD.project_id
            OR resource.state = 'archived')
      ) THEN
      RAISE EXCEPTION 'G20108_RELEASE_PIN_SET_NOT_READY' USING ERRCODE = '55000';
    END IF;
  END IF;

  IF OLD.state = 'ready' AND NEW.state = 'published' THEN
    IF NOT EXISTS (SELECT 1 FROM meta.release_pins WHERE release_id = OLD.release_id)
      OR NOT EXISTS (SELECT 1 FROM meta.runtime_activations WHERE release_id = OLD.release_id)
      OR NOT EXISTS (
        SELECT 1
        FROM meta.validation_reports AS report
        WHERE report.subject_type = 'release'
          AND report.release_id = OLD.release_id
          AND report.subject_digest = OLD.manifest_digest
          AND report.validation_context_digest = OLD.staged_validation_context_digest
          AND report.validator_version = 'metadata-release-g2-01-v1'
          AND report.valid = TRUE
      )
      OR EXISTS (
        SELECT 1
        FROM meta.release_pins AS pin
        JOIN meta.resource_revisions AS revision
          ON revision.revision_id = pin.revision_id
         AND revision.resource_id = pin.resource_id
        JOIN meta.resources AS resource
          ON resource.resource_id = pin.resource_id
        WHERE pin.release_id = OLD.release_id
          AND (revision.family <> pin.family
            OR revision.content_digest <> pin.content_digest
            OR revision.state NOT IN ('validated', 'published', 'deprecated')
            OR resource.project_id <> OLD.project_id
            OR resource.state = 'archived')
      ) THEN
      RAISE EXCEPTION 'DB01_RELEASE_NOT_ACTIVATABLE' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$db01_release_update$;

CREATE FUNCTION ontos_migration.g20108_enforce_activation_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20108_activation_insert$
DECLARE
  release_state text;
BEGIN
  SELECT state INTO release_state
  FROM meta.releases
  WHERE release_id = NEW.release_id
  FOR UPDATE;
  IF release_state IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'G20108_ACTIVATION_RELEASE_NOT_READY' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20108_activation_insert$;

CREATE FUNCTION ontos_migration.g20108_enforce_serving_head_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20108_serving_head_insert$
BEGIN
  IF NEW.control_sequence <> 1 THEN
    RAISE EXCEPTION 'G20108_SERVING_HEAD_INITIAL_SEQUENCE_INVALID' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$g20108_serving_head_insert$;

CREATE FUNCTION ontos_migration.g20108_enforce_channel_write() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20108_channel_write$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.control_sequence <> 1 THEN
    RAISE EXCEPTION 'G20108_CHANNEL_INITIAL_SEQUENCE_INVALID' USING ERRCODE = '40001';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.channel_name IS DISTINCT FROM OLD.channel_name
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'G20108_CHANNEL_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.release_id <> OLD.release_id AND NOT EXISTS (
    SELECT 1
    FROM meta.releases AS previous_release
    WHERE previous_release.release_id = OLD.release_id
      AND previous_release.project_id = OLD.project_id
      AND previous_release.state = 'superseded'
  ) THEN
    RAISE EXCEPTION 'G20108_PREVIOUS_RELEASE_NOT_SUPERSEDED' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM meta.releases AS release
    JOIN meta.release_serving_heads AS head
      ON head.release_id = release.release_id
     AND head.activation_id = NEW.activation_id
    WHERE release.project_id = NEW.project_id
      AND release.release_id = NEW.release_id
      AND release.target_channel_name = NEW.channel_name
      AND release.state = 'published'
  ) THEN
    RAISE EXCEPTION 'G20108_CHANNEL_BINDING_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20108_channel_write$;

CREATE FUNCTION ontos_migration.g20108_enforce_serving_head_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20108_serving_head_update$
BEGIN
  IF NEW.release_id IS DISTINCT FROM OLD.release_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'G20108_SERVING_HEAD_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20108_serving_head_update$;

CREATE FUNCTION ontos_migration.g20108_assert_publication_integrity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20108_publication_integrity$
DECLARE
  affected_release_id uuid;
  release_state text;
BEGIN
  affected_release_id := NEW.release_id;
  SELECT state INTO release_state
  FROM meta.releases
  WHERE release_id = affected_release_id;

  IF release_state IN ('published', 'superseded') AND NOT EXISTS (
    SELECT 1
    FROM meta.runtime_activations AS activation
    JOIN meta.release_serving_heads AS head
      ON head.release_id = activation.release_id
     AND head.activation_id = activation.activation_id
    WHERE activation.release_id = affected_release_id
  ) THEN
    RAISE EXCEPTION 'G20108_PUBLISHED_RELEASE_BINDING_INCOMPLETE' USING ERRCODE = '55000';
  END IF;

  IF release_state = 'published' AND NOT EXISTS (
    SELECT 1
    FROM meta.releases AS release
    JOIN meta.release_channels AS channel
      ON channel.project_id = release.project_id
     AND channel.channel_name = release.target_channel_name
     AND channel.release_id = release.release_id
    JOIN meta.release_serving_heads AS head
      ON head.release_id = channel.release_id
     AND head.activation_id = channel.activation_id
    WHERE release.release_id = affected_release_id
  ) THEN
    RAISE EXCEPTION 'G20108_PUBLISHED_RELEASE_CHANNEL_INCOMPLETE' USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'runtime_activations' AND release_state NOT IN ('published', 'superseded') THEN
    RAISE EXCEPTION 'G20108_ORPHAN_ACTIVATION' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$g20108_publication_integrity$;

CREATE TRIGGER runtime_activations_release_guard
BEFORE INSERT ON meta.runtime_activations
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20108_enforce_activation_insert();

CREATE TRIGGER release_serving_heads_insert_guard
BEFORE INSERT ON meta.release_serving_heads
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20108_enforce_serving_head_insert();

CREATE TRIGGER release_serving_heads_identity_guard
BEFORE UPDATE ON meta.release_serving_heads
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20108_enforce_serving_head_update();

CREATE TRIGGER release_channels_binding_guard
BEFORE INSERT OR UPDATE ON meta.release_channels
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20108_enforce_channel_write();

CREATE CONSTRAINT TRIGGER releases_publication_integrity
AFTER INSERT OR UPDATE ON meta.releases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20108_assert_publication_integrity();

CREATE CONSTRAINT TRIGGER runtime_activations_publication_integrity
AFTER INSERT ON meta.runtime_activations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20108_assert_publication_integrity();

CREATE CONSTRAINT TRIGGER release_serving_heads_publication_integrity
AFTER INSERT OR UPDATE ON meta.release_serving_heads
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20108_assert_publication_integrity();

CREATE CONSTRAINT TRIGGER release_channels_publication_integrity
AFTER INSERT OR UPDATE ON meta.release_channels
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20108_assert_publication_integrity();

GRANT UPDATE (
  state,
  staged_from_release_id,
  staged_from_activation_id,
  staged_channel_control_sequence,
  staged_validation_context_digest,
  staged_at,
  published_by_principal_id,
  published_at,
  changed_at
) ON meta.releases TO api_runtime;

REVOKE ALL PRIVILEGES ON FUNCTION
  ontos_migration.g20108_enforce_activation_insert(),
  ontos_migration.g20108_enforce_serving_head_insert(),
  ontos_migration.g20108_enforce_channel_write(),
  ontos_migration.g20108_enforce_serving_head_update(),
  ontos_migration.g20108_assert_publication_integrity()
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
