SET LOCAL ROLE migration_owner;

GRANT USAGE ON SCHEMA meta TO read_only_ops;

CREATE TABLE meta.projects (
  project_id uuid PRIMARY KEY,
  api_name varchar(63) NOT NULL UNIQUE
    CHECK (api_name ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$'),
  display_name varchar(160) NOT NULL CHECK (btrim(display_name) <> ''),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  publication_sequence bigint NOT NULL DEFAULT 0 CHECK (publication_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE authz.principals (
  principal_id uuid PRIMARY KEY,
  oidc_issuer varchar(2048) NOT NULL CHECK (btrim(oidc_issuer) <> ''),
  oidc_subject varchar(512) NOT NULL CHECK (btrim(oidc_subject) <> ''),
  display_name varchar(160) NOT NULL CHECK (btrim(display_name) <> ''),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz,
  CONSTRAINT principals_external_identity_uq UNIQUE (oidc_issuer, oidc_subject),
  CONSTRAINT principals_disabled_state_ck CHECK (
    (state = 'active' AND disabled_at IS NULL)
    OR (state = 'disabled' AND disabled_at IS NOT NULL)
  )
);

CREATE TABLE meta.resources (
  resource_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  namespace varchar(253) NOT NULL
    CHECK (namespace ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$'),
  api_name varchar(63) NOT NULL
    CHECK (api_name ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$'),
  family text NOT NULL CHECK (family IN (
    'object_type', 'link_type', 'interface', 'mapping', 'snapshot_schema',
    'policy', 'function_type', 'action_type', 'object_view', 'application_config'
  )),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deprecated', 'archived')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT resources_api_name_tombstone_uq UNIQUE (project_id, namespace, api_name),
  CONSTRAINT resources_project_identity_uq UNIQUE (project_id, resource_id)
);

CREATE TABLE meta.resource_revisions (
  revision_id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES meta.resources(resource_id) ON DELETE RESTRICT,
  parent_revision_id uuid,
  revision_number bigint NOT NULL CHECK (revision_number >= 1),
  family text NOT NULL CHECK (family IN (
    'object_type', 'link_type', 'interface', 'mapping', 'snapshot_schema',
    'policy', 'function_type', 'action_type', 'object_view', 'application_config'
  )),
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'validated', 'published', 'deprecated', 'archived')),
  etag bigint NOT NULL DEFAULT 1 CHECK (etag >= 1),
  content_digest varchar(71) NOT NULL
    CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  created_by_principal_id uuid NOT NULL
    REFERENCES authz.principals(principal_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT resource_revisions_number_uq UNIQUE (resource_id, revision_number),
  CONSTRAINT resource_revisions_digest_uq UNIQUE (resource_id, content_digest),
  CONSTRAINT resource_revisions_resource_identity_uq UNIQUE (resource_id, revision_id),
  CONSTRAINT resource_revisions_parent_fk FOREIGN KEY (resource_id, parent_revision_id)
    REFERENCES meta.resource_revisions(resource_id, revision_id) ON DELETE RESTRICT,
  CONSTRAINT resource_revisions_not_self_parent_ck CHECK (parent_revision_id IS DISTINCT FROM revision_id)
);

CREATE TABLE meta.resource_dependencies (
  dependency_id uuid PRIMARY KEY,
  source_revision_id uuid NOT NULL
    REFERENCES meta.resource_revisions(revision_id) ON DELETE RESTRICT,
  target_revision_id uuid NOT NULL
    REFERENCES meta.resource_revisions(revision_id) ON DELETE RESTRICT,
  dependency_type text NOT NULL
    CHECK (dependency_type IN ('property_reference', 'link_source', 'link_target')),
  source_path varchar(1024) NOT NULL CHECK (source_path ~ '^(?:/(?:[^~/]|~0|~1)*)+$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT resource_dependencies_edge_uq
    UNIQUE (source_revision_id, target_revision_id, dependency_type),
  CONSTRAINT resource_dependencies_not_self_ck CHECK (source_revision_id <> target_revision_id)
);

CREATE TABLE meta.releases (
  release_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  rollback_of_release_id uuid,
  release_number bigint NOT NULL CHECK (release_number >= 1),
  manifest_digest varchar(71) NOT NULL
    CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'staging', 'ready', 'failed', 'published', 'superseded')),
  created_by_principal_id uuid NOT NULL
    REFERENCES authz.principals(principal_id) ON DELETE RESTRICT,
  published_by_principal_id uuid
    REFERENCES authz.principals(principal_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  CONSTRAINT releases_number_uq UNIQUE (project_id, release_number),
  CONSTRAINT releases_manifest_uq UNIQUE (project_id, manifest_digest),
  CONSTRAINT releases_project_identity_uq UNIQUE (project_id, release_id),
  CONSTRAINT releases_rollback_fk FOREIGN KEY (project_id, rollback_of_release_id)
    REFERENCES meta.releases(project_id, release_id) ON DELETE RESTRICT,
  CONSTRAINT releases_not_self_rollback_ck CHECK (rollback_of_release_id IS DISTINCT FROM release_id),
  CONSTRAINT releases_publication_ck CHECK (
    (state IN ('published', 'superseded') AND published_at IS NOT NULL
      AND published_by_principal_id IS NOT NULL)
    OR (state NOT IN ('published', 'superseded') AND published_at IS NULL
      AND published_by_principal_id IS NULL)
  )
);

CREATE TABLE meta.validation_reports (
  report_id uuid PRIMARY KEY,
  subject_type text NOT NULL CHECK (subject_type IN ('resource_revision', 'release')),
  subject_id uuid NOT NULL,
  resource_revision_id uuid
    REFERENCES meta.resource_revisions(revision_id) ON DELETE RESTRICT,
  release_id uuid REFERENCES meta.releases(release_id) ON DELETE RESTRICT,
  subject_digest varchar(71) NOT NULL
    CHECK (subject_digest ~ '^sha256:[0-9a-f]{64}$'),
  validator_version varchar(128) NOT NULL CHECK (btrim(validator_version) <> ''),
  valid boolean NOT NULL,
  issues jsonb NOT NULL CHECK (jsonb_typeof(issues) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT validation_reports_one_subject_ck CHECK (
    (subject_type = 'resource_revision' AND subject_id = resource_revision_id
      AND resource_revision_id IS NOT NULL AND release_id IS NULL)
    OR (subject_type = 'release' AND subject_id = release_id
      AND resource_revision_id IS NULL AND release_id IS NOT NULL)
  ),
  CONSTRAINT validation_reports_subject_uq
    UNIQUE (subject_type, subject_id, subject_digest, validator_version)
);

CREATE TABLE meta.release_pins (
  release_id uuid NOT NULL REFERENCES meta.releases(release_id) ON DELETE RESTRICT,
  resource_id uuid NOT NULL REFERENCES meta.resources(resource_id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL,
  pin_order integer NOT NULL CHECK (pin_order >= 0 AND pin_order < 512),
  family text NOT NULL CHECK (family IN (
    'object_type', 'link_type', 'interface', 'mapping', 'snapshot_schema',
    'policy', 'function_type', 'action_type', 'object_view', 'application_config'
  )),
  content_digest varchar(71) NOT NULL
    CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (release_id, resource_id),
  CONSTRAINT release_pins_order_uq UNIQUE (release_id, pin_order),
  CONSTRAINT release_pins_revision_fk FOREIGN KEY (resource_id, revision_id)
    REFERENCES meta.resource_revisions(resource_id, revision_id) ON DELETE RESTRICT
);

CREATE TABLE meta.runtime_activations (
  activation_id uuid PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES meta.releases(release_id) ON DELETE RESTRICT,
  activation_digest varchar(71) NOT NULL
    CHECK (activation_digest ~ '^sha256:[0-9a-f]{64}$'),
  member_count integer NOT NULL DEFAULT 0 CHECK (member_count = 0),
  state text NOT NULL DEFAULT 'ready' CHECK (state = 'ready'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT runtime_activations_digest_uq UNIQUE (release_id, activation_digest),
  CONSTRAINT runtime_activations_release_identity_uq UNIQUE (release_id, activation_id)
);

CREATE TABLE meta.release_channels (
  project_id uuid NOT NULL REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  channel_name varchar(63) NOT NULL
    CHECK (channel_name ~ '^[a-z][a-z0-9_-]{0,62}$'),
  release_id uuid NOT NULL,
  activation_id uuid NOT NULL,
  control_sequence bigint NOT NULL CHECK (control_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, channel_name),
  CONSTRAINT release_channels_release_fk FOREIGN KEY (project_id, release_id)
    REFERENCES meta.releases(project_id, release_id) ON DELETE RESTRICT,
  CONSTRAINT release_channels_activation_fk FOREIGN KEY (release_id, activation_id)
    REFERENCES meta.runtime_activations(release_id, activation_id) ON DELETE RESTRICT
);

CREATE TABLE meta.release_serving_heads (
  release_id uuid PRIMARY KEY REFERENCES meta.releases(release_id) ON DELETE RESTRICT,
  activation_id uuid NOT NULL,
  control_sequence bigint NOT NULL CHECK (control_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT release_serving_heads_activation_fk FOREIGN KEY (release_id, activation_id)
    REFERENCES meta.runtime_activations(release_id, activation_id) ON DELETE RESTRICT
);

CREATE TABLE meta.packages (
  package_id uuid PRIMARY KEY,
  namespace varchar(253) NOT NULL
    CHECK (namespace ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$'),
  api_name varchar(63) NOT NULL
    CHECK (api_name ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$'),
  created_by_principal_id uuid NOT NULL
    REFERENCES authz.principals(principal_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT packages_api_name_tombstone_uq UNIQUE (namespace, api_name)
);

CREATE TABLE meta.package_revisions (
  package_revision_id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES meta.packages(package_id) ON DELETE RESTRICT,
  version varchar(64) NOT NULL
    CHECK (version ~ '^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$'),
  manifest_digest varchar(71) NOT NULL UNIQUE
    CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  created_by_principal_id uuid NOT NULL
    REFERENCES authz.principals(principal_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT package_revisions_version_uq UNIQUE (package_id, version),
  CONSTRAINT package_revisions_package_identity_uq UNIQUE (package_id, package_revision_id)
);

CREATE TABLE meta.package_installations (
  installation_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  package_id uuid NOT NULL REFERENCES meta.packages(package_id) ON DELETE RESTRICT,
  active_package_revision_id uuid,
  active_release_id uuid,
  control_sequence bigint NOT NULL DEFAULT 0 CHECK (control_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT package_installations_project_package_uq UNIQUE (project_id, package_id),
  CONSTRAINT package_installations_context_identity_uq
    UNIQUE (installation_id, project_id, package_id),
  CONSTRAINT package_installations_revision_fk FOREIGN KEY (package_id, active_package_revision_id)
    REFERENCES meta.package_revisions(package_id, package_revision_id) ON DELETE RESTRICT,
  CONSTRAINT package_installations_release_fk FOREIGN KEY (project_id, active_release_id)
    REFERENCES meta.releases(project_id, release_id) ON DELETE RESTRICT,
  CONSTRAINT package_installations_active_pair_ck CHECK (
    (active_package_revision_id IS NULL) = (active_release_id IS NULL)
  )
);

CREATE TABLE meta.package_installation_changes (
  change_id uuid PRIMARY KEY,
  installation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  package_id uuid NOT NULL,
  request_key varchar(128) NOT NULL
    CHECK (request_key ~ '^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$'),
  target_package_revision_id uuid NOT NULL,
  target_release_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'active', 'superseded', 'failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT package_installation_changes_request_uq UNIQUE (installation_id, request_key),
  CONSTRAINT package_installation_changes_installation_fk
    FOREIGN KEY (installation_id, project_id, package_id)
    REFERENCES meta.package_installations(installation_id, project_id, package_id)
    ON DELETE RESTRICT,
  CONSTRAINT package_installation_changes_revision_fk
    FOREIGN KEY (package_id, target_package_revision_id)
    REFERENCES meta.package_revisions(package_id, package_revision_id) ON DELETE RESTRICT,
  CONSTRAINT package_installation_changes_release_fk FOREIGN KEY (project_id, target_release_id)
    REFERENCES meta.releases(project_id, release_id) ON DELETE RESTRICT
);

CREATE TABLE meta.artifact_references (
  artifact_reference_id uuid PRIMARY KEY,
  digest varchar(71) NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  media_type varchar(255) NOT NULL CHECK (media_type ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'),
  source_kind varchar(64) NOT NULL CHECK (source_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  source_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT artifact_references_source_uq UNIQUE (digest, media_type, source_kind, source_id)
);

CREATE TABLE authz.role_bindings (
  binding_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  principal_id uuid NOT NULL REFERENCES authz.principals(principal_id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (scope IN ('project', 'resource')),
  resource_id uuid,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer', 'executor', 'auditor')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CONSTRAINT role_bindings_resource_fk FOREIGN KEY (project_id, resource_id)
    REFERENCES meta.resources(project_id, resource_id) ON DELETE RESTRICT,
  CONSTRAINT role_bindings_scope_ck CHECK (
    (scope = 'project' AND resource_id IS NULL)
    OR (scope = 'resource' AND resource_id IS NOT NULL)
  ),
  CONSTRAINT role_bindings_revoked_state_ck CHECK (
    (state = 'active' AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX role_bindings_active_project_uq
  ON authz.role_bindings(project_id, principal_id)
  WHERE state = 'active' AND scope = 'project';

CREATE UNIQUE INDEX role_bindings_active_resource_uq
  ON authz.role_bindings(project_id, resource_id, principal_id)
  WHERE state = 'active' AND scope = 'resource';

CREATE TABLE authz.authorization_epochs (
  project_id uuid PRIMARY KEY REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch >= 1),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION ontos_migration.db01_reject_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $db01_reject_mutation$
BEGIN
  RAISE EXCEPTION 'DB01_IMMUTABLE:%', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$db01_reject_mutation$;

CREATE FUNCTION ontos_migration.db01_enforce_initial_state() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $db01_initial_state$
BEGIN
  IF TG_TABLE_SCHEMA = 'meta' AND TG_TABLE_NAME = 'projects' THEN
    IF NEW.state = 'active' AND NEW.publication_sequence = 0 THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_SCHEMA = 'meta' AND TG_TABLE_NAME = 'resources' THEN
    IF NEW.state = 'active' THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_SCHEMA = 'meta' AND TG_TABLE_NAME = 'resource_revisions' THEN
    IF NEW.state = 'draft' AND NEW.etag = 1 THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_SCHEMA = 'meta' AND TG_TABLE_NAME = 'releases' THEN
    IF NEW.state = 'draft' THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_SCHEMA = 'meta' AND TG_TABLE_NAME = 'package_installations' THEN
    IF NEW.active_package_revision_id IS NULL AND NEW.active_release_id IS NULL
      AND NEW.control_sequence = 0 THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_SCHEMA = 'meta' AND TG_TABLE_NAME = 'package_installation_changes' THEN
    IF NEW.state = 'pending' THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_SCHEMA = 'authz' AND TG_TABLE_NAME = 'principals' THEN
    IF NEW.state = 'active' THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_SCHEMA = 'authz' AND TG_TABLE_NAME = 'role_bindings' THEN
    IF NEW.state = 'active' THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_SCHEMA = 'authz' AND TG_TABLE_NAME = 'authorization_epochs' THEN
    IF NEW.epoch = 1 THEN RETURN NEW; END IF;
  ELSE
    RAISE EXCEPTION 'DB01_INITIAL_STATE_TRIGGER_MISCONFIGURED:%',
      TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;

  RAISE EXCEPTION 'DB01_INITIAL_STATE_INVALID:%', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$db01_initial_state$;

CREATE FUNCTION ontos_migration.db01_enforce_release_pin_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $db01_release_pin_insert$
DECLARE
  release_state text;
BEGIN
  SELECT state INTO release_state
  FROM meta.releases
  WHERE release_id = NEW.release_id
  FOR UPDATE;
  IF release_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'DB01_RELEASE_PINS_SEALED' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM meta.releases AS release
    JOIN meta.resources AS resource
      ON resource.project_id = release.project_id
     AND resource.resource_id = NEW.resource_id
    JOIN meta.resource_revisions AS revision
      ON revision.resource_id = NEW.resource_id
     AND revision.revision_id = NEW.revision_id
     AND revision.family = NEW.family
     AND revision.content_digest = NEW.content_digest
     AND revision.state IN ('validated', 'published', 'deprecated')
    WHERE release.release_id = NEW.release_id
  ) THEN
    RAISE EXCEPTION 'DB01_RELEASE_PIN_FACT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$db01_release_pin_insert$;

CREATE FUNCTION ontos_migration.db01_enforce_project_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $db01_project_update$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.api_name IS DISTINCT FROM OLD.api_name
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'DB01_PROJECT_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
    AND NOT (OLD.state = 'active' AND NEW.state = 'archived') THEN
    RAISE EXCEPTION 'DB01_PROJECT_STATE_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  IF NEW.publication_sequence <> OLD.publication_sequence
    AND NEW.publication_sequence <> OLD.publication_sequence + 1 THEN
    RAISE EXCEPTION 'DB01_PROJECT_SEQUENCE_MUST_INCREMENT_ONE' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$db01_project_update$;

CREATE FUNCTION ontos_migration.db01_enforce_resource_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $db01_resource_update$
BEGIN
  IF NEW.resource_id IS DISTINCT FROM OLD.resource_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.namespace IS DISTINCT FROM OLD.namespace
    OR NEW.api_name IS DISTINCT FROM OLD.api_name
    OR NEW.family IS DISTINCT FROM OLD.family
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'DB01_RESOURCE_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
    AND NOT ((OLD.state = 'active' AND NEW.state IN ('deprecated', 'archived'))
      OR (OLD.state = 'deprecated' AND NEW.state = 'archived')) THEN
    RAISE EXCEPTION 'DB01_RESOURCE_STATE_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$db01_resource_update$;

CREATE FUNCTION ontos_migration.db01_enforce_revision_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $db01_revision_update$
BEGIN
  IF NEW.revision_id IS DISTINCT FROM OLD.revision_id
    OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
    OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id
    OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
    OR NEW.family IS DISTINCT FROM OLD.family
    OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'DB01_REVISION_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  IF OLD.state = 'draft' THEN
    IF NEW.state NOT IN ('draft', 'validated') THEN
      RAISE EXCEPTION 'DB01_REVISION_STATE_TRANSITION_INVALID' USING ERRCODE = '55000';
    END IF;
    IF NEW.content IS DISTINCT FROM OLD.content
      OR NEW.content_digest IS DISTINCT FROM OLD.content_digest THEN
      IF NEW.state <> 'draft' OR NEW.etag <> OLD.etag + 1 THEN
        RAISE EXCEPTION 'DB01_REVISION_DRAFT_ETAG_INVALID' USING ERRCODE = '40001';
      END IF;
    ELSIF NEW.etag IS DISTINCT FROM OLD.etag THEN
      RAISE EXCEPTION 'DB01_REVISION_ETAG_WITHOUT_CONTENT_CHANGE' USING ERRCODE = '55000';
    END IF;
  ELSE
    IF NEW.content IS DISTINCT FROM OLD.content
      OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
      OR NEW.etag IS DISTINCT FROM OLD.etag THEN
      RAISE EXCEPTION 'DB01_REVISION_FACT_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state
      AND NOT ((OLD.state = 'validated' AND NEW.state = 'published')
        OR (OLD.state = 'published' AND NEW.state = 'deprecated')
        OR (OLD.state = 'deprecated' AND NEW.state = 'archived')) THEN
      RAISE EXCEPTION 'DB01_REVISION_STATE_TRANSITION_INVALID' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$db01_revision_update$;

CREATE FUNCTION ontos_migration.db01_enforce_release_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $db01_release_update$
BEGIN
  IF NEW.release_id IS DISTINCT FROM OLD.release_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.rollback_of_release_id IS DISTINCT FROM OLD.rollback_of_release_id
    OR NEW.release_number IS DISTINCT FROM OLD.release_number
    OR NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest
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
  IF OLD.state IN ('published', 'superseded')
    AND (NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.published_by_principal_id IS DISTINCT FROM OLD.published_by_principal_id) THEN
    RAISE EXCEPTION 'DB01_RELEASE_PUBLICATION_FACT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'ready' AND NEW.state = 'published' THEN
    IF NOT EXISTS (SELECT 1 FROM meta.release_pins WHERE release_id = OLD.release_id)
      OR NOT EXISTS (SELECT 1 FROM meta.runtime_activations WHERE release_id = OLD.release_id) THEN
      RAISE EXCEPTION 'DB01_RELEASE_NOT_ACTIVATABLE' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$db01_release_update$;

CREATE FUNCTION ontos_migration.db01_enforce_pointer_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $db01_pointer_update$
BEGIN
  IF NEW.control_sequence <> OLD.control_sequence + 1 THEN
    RAISE EXCEPTION 'DB01_POINTER_SEQUENCE_MUST_INCREMENT_ONE' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$db01_pointer_update$;

CREATE FUNCTION ontos_migration.db01_enforce_package_change_update() RETURNS trigger
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
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'DB01_PACKAGE_CHANGE_TARGET_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
    AND NOT ((OLD.state = 'pending' AND NEW.state IN ('active', 'failed'))
      OR (OLD.state = 'active' AND NEW.state = 'superseded')) THEN
    RAISE EXCEPTION 'DB01_PACKAGE_CHANGE_STATE_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$db01_package_change_update$;

CREATE FUNCTION ontos_migration.db01_enforce_principal_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $db01_principal_update$
BEGIN
  IF NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.oidc_issuer IS DISTINCT FROM OLD.oidc_issuer
    OR NEW.oidc_subject IS DISTINCT FROM OLD.oidc_subject
    OR NEW.display_name IS DISTINCT FROM OLD.display_name
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'DB01_PRINCIPAL_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
    AND NOT (OLD.state = 'active' AND NEW.state = 'disabled') THEN
    RAISE EXCEPTION 'DB01_PRINCIPAL_STATE_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$db01_principal_update$;

CREATE FUNCTION ontos_migration.db01_enforce_binding_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $db01_binding_update$
BEGIN
  IF NEW.binding_id IS DISTINCT FROM OLD.binding_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.scope IS DISTINCT FROM OLD.scope
    OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'DB01_ROLE_BINDING_FACT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
    AND NOT (OLD.state = 'active' AND NEW.state = 'revoked') THEN
    RAISE EXCEPTION 'DB01_ROLE_BINDING_STATE_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$db01_binding_update$;

CREATE FUNCTION ontos_migration.db01_enforce_epoch_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $db01_epoch_update$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'DB01_AUTHORIZATION_EPOCH_PROJECT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.epoch <> OLD.epoch + 1 THEN
    RAISE EXCEPTION 'DB01_AUTHORIZATION_EPOCH_MUST_INCREMENT_ONE' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$db01_epoch_update$;

CREATE TRIGGER projects_controlled_update
BEFORE UPDATE ON meta.projects
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_project_update();

CREATE TRIGGER projects_initial_state
BEFORE INSERT ON meta.projects
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_initial_state();

CREATE TRIGGER resources_controlled_update
BEFORE UPDATE ON meta.resources
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_resource_update();

CREATE TRIGGER resources_initial_state
BEFORE INSERT ON meta.resources
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_initial_state();

CREATE TRIGGER resource_revisions_controlled_update
BEFORE UPDATE ON meta.resource_revisions
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_revision_update();

CREATE TRIGGER resource_revisions_initial_state
BEFORE INSERT ON meta.resource_revisions
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_initial_state();

CREATE TRIGGER releases_controlled_update
BEFORE UPDATE ON meta.releases
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_release_update();

CREATE TRIGGER releases_initial_state
BEFORE INSERT ON meta.releases
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_initial_state();

CREATE TRIGGER release_pins_insert_only_while_draft
BEFORE INSERT ON meta.release_pins
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_release_pin_insert();

CREATE TRIGGER release_channels_controlled_update
BEFORE UPDATE ON meta.release_channels
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_pointer_update();

CREATE TRIGGER release_serving_heads_controlled_update
BEFORE UPDATE ON meta.release_serving_heads
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_pointer_update();

CREATE TRIGGER package_installations_controlled_update
BEFORE UPDATE ON meta.package_installations
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_pointer_update();

CREATE TRIGGER package_installations_initial_state
BEFORE INSERT ON meta.package_installations
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_initial_state();

CREATE TRIGGER package_installation_changes_controlled_update
BEFORE UPDATE ON meta.package_installation_changes
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_package_change_update();

CREATE TRIGGER package_installation_changes_initial_state
BEFORE INSERT ON meta.package_installation_changes
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_initial_state();

CREATE TRIGGER principals_controlled_update
BEFORE UPDATE ON authz.principals
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_principal_update();

CREATE TRIGGER principals_initial_state
BEFORE INSERT ON authz.principals
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_initial_state();

CREATE TRIGGER role_bindings_controlled_update
BEFORE UPDATE ON authz.role_bindings
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_binding_update();

CREATE TRIGGER role_bindings_initial_state
BEFORE INSERT ON authz.role_bindings
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_initial_state();

CREATE TRIGGER authorization_epochs_controlled_update
BEFORE UPDATE ON authz.authorization_epochs
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_epoch_update();

CREATE TRIGGER authorization_epochs_initial_state
BEFORE INSERT ON authz.authorization_epochs
FOR EACH ROW EXECUTE FUNCTION ontos_migration.db01_enforce_initial_state();

CREATE TRIGGER resource_dependencies_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON meta.resource_dependencies
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.db01_reject_mutation();

CREATE TRIGGER validation_reports_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON meta.validation_reports
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.db01_reject_mutation();

CREATE TRIGGER release_pins_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON meta.release_pins
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.db01_reject_mutation();

CREATE TRIGGER runtime_activations_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON meta.runtime_activations
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.db01_reject_mutation();

CREATE TRIGGER packages_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON meta.packages
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.db01_reject_mutation();

CREATE TRIGGER package_revisions_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON meta.package_revisions
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.db01_reject_mutation();

CREATE TRIGGER artifact_references_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON meta.artifact_references
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.db01_reject_mutation();

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA meta, authz
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ontos_migration
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT SELECT, INSERT ON TABLE
  meta.projects,
  meta.resources,
  meta.resource_revisions,
  meta.resource_dependencies,
  meta.validation_reports,
  meta.releases,
  meta.release_pins,
  meta.runtime_activations,
  meta.release_channels,
  meta.release_serving_heads,
  meta.packages,
  meta.package_revisions,
  meta.package_installations,
  meta.package_installation_changes,
  meta.artifact_references
TO api_runtime;

GRANT SELECT, INSERT ON TABLE
  authz.principals,
  authz.role_bindings,
  authz.authorization_epochs
TO api_runtime;

GRANT UPDATE (display_name, state, publication_sequence, changed_at)
  ON meta.projects TO api_runtime;
GRANT UPDATE (state, changed_at)
  ON meta.resources TO api_runtime;
GRANT UPDATE (content_digest, content, etag, state, changed_at)
  ON meta.resource_revisions TO api_runtime;
GRANT UPDATE (state, published_by_principal_id, published_at, changed_at)
  ON meta.releases TO api_runtime;
GRANT UPDATE (release_id, activation_id, control_sequence, changed_at)
  ON meta.release_channels TO api_runtime;
GRANT UPDATE (activation_id, control_sequence, changed_at)
  ON meta.release_serving_heads TO api_runtime;
GRANT UPDATE (active_package_revision_id, active_release_id, control_sequence, changed_at)
  ON meta.package_installations TO api_runtime;
GRANT UPDATE (state, changed_at)
  ON meta.package_installation_changes TO api_runtime;
GRANT UPDATE (state, disabled_at, changed_at)
  ON authz.principals TO api_runtime;
GRANT UPDATE (state, revoked_at, changed_at)
  ON authz.role_bindings TO api_runtime;
GRANT UPDATE (epoch, changed_at)
  ON authz.authorization_epochs TO api_runtime;

GRANT SELECT ON ALL TABLES IN SCHEMA meta TO worker_runtime, read_only_ops;
GRANT SELECT ON authz.authorization_epochs TO worker_runtime;
