SET LOCAL ROLE migration_owner;

-- G2-02-11 persists the expensive, immutable cutover candidate outside the
-- final pointer transaction. The final function consumes only these bounded
-- facts and revalidates every mutable dependency under the global lock order.
CREATE TABLE runtime.snapshot_group_cutover_preparations (
  project_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  snapshot_group_id uuid NOT NULL,
  group_version bigint NOT NULL CHECK (group_version >= 1),
  expected_control_revision bigint NOT NULL CHECK (expected_control_revision >= 0),
  expected_state_revision bigint NOT NULL CHECK (expected_state_revision >= 1),
  expected_inventory_revision bigint NOT NULL CHECK (expected_inventory_revision >= 1),
  expected_head_set_id uuid,
  candidate_head_set_id uuid,
  idempotency_key_digest varchar(71) NOT NULL
    CHECK (idempotency_key_digest ~ '^sha256:[0-9a-f]{64}$'),
  overlay_provider_id varchar(128) NOT NULL,
  overlay_provider_version varchar(64) NOT NULL,
  overlay_watermark bigint NOT NULL CHECK (overlay_watermark >= 0),
  overlay_delta_count bigint NOT NULL CHECK (overlay_delta_count >= 0),
  overlay_evidence_digest varchar(71) NOT NULL
    CHECK (overlay_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  release_count integer NOT NULL DEFAULT 0 CHECK (release_count BETWEEN 0 AND 256),
  member_count integer NOT NULL DEFAULT 0 CHECK (member_count BETWEEN 0 AND 65536),
  object_head_count bigint NOT NULL DEFAULT 0 CHECK (object_head_count >= 0),
  state text NOT NULL DEFAULT 'preparing'
    CHECK (state IN ('preparing', 'prepared', 'committed')),
  committed_control_revision bigint CHECK (committed_control_revision >= 0),
  committed_state_revision bigint CHECK (committed_state_revision >= 1),
  committed_inventory_revision bigint CHECK (committed_inventory_revision >= 1),
  committed_changed boolean,
  created_activation_count integer CHECK (
    created_activation_count IS NULL OR created_activation_count BETWEEN 0 AND 256
  ),
  inserted_head_count bigint CHECK (inserted_head_count >= 0),
  updated_head_count bigint CHECK (updated_head_count >= 0),
  repointed_head_count bigint CHECK (repointed_head_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_at timestamptz,
  PRIMARY KEY (project_id, preparation_id),
  CONSTRAINT snapshot_group_cutover_preparations_project_fk
    FOREIGN KEY (project_id) REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  CONSTRAINT snapshot_group_cutover_preparations_group_fk
    FOREIGN KEY (project_id, snapshot_group_id, group_version)
    REFERENCES runtime.snapshot_group_versions(
      project_id, snapshot_group_id, group_version
    ) ON DELETE RESTRICT,
  CONSTRAINT snapshot_group_cutover_preparations_idempotency_uq
    UNIQUE (project_id, idempotency_key_digest),
  CONSTRAINT snapshot_group_cutover_preparations_head_set_shape_ck CHECK (
    (state = 'preparing' AND candidate_head_set_id IS NULL)
    OR (state IN ('prepared', 'committed') AND candidate_head_set_id IS NOT NULL)
  ),
  CONSTRAINT snapshot_group_cutover_preparations_result_ck CHECK (
    (state IN ('preparing', 'prepared')
      AND committed_control_revision IS NULL
      AND committed_state_revision IS NULL
      AND committed_inventory_revision IS NULL
      AND committed_changed IS NULL
      AND created_activation_count IS NULL
      AND inserted_head_count IS NULL
      AND updated_head_count IS NULL
      AND repointed_head_count IS NULL
      AND committed_at IS NULL)
    OR
    (state = 'committed'
      AND committed_control_revision IS NOT NULL
      AND committed_state_revision IS NOT NULL
      AND committed_inventory_revision IS NOT NULL
      AND committed_changed IS NOT NULL
      AND created_activation_count IS NOT NULL
      AND inserted_head_count IS NOT NULL
      AND updated_head_count IS NOT NULL
      AND repointed_head_count IS NOT NULL
      AND committed_at IS NOT NULL)
  )
);

CREATE TABLE runtime.snapshot_group_cutover_release_candidates (
  project_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  release_id uuid NOT NULL,
  runtime_plan_digest varchar(71) NOT NULL
    CHECK (runtime_plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  activation_id uuid NOT NULL,
  activation_digest varchar(71),
  activation_content_digest varchar(71),
  expected_serving_activation_id uuid,
  expected_serving_control_sequence bigint
    CHECK (expected_serving_control_sequence IS NULL OR expected_serving_control_sequence >= 1),
  channel_name varchar(63) NOT NULL,
  expected_channel_release_id uuid,
  expected_channel_activation_id uuid,
  expected_channel_control_sequence bigint
    CHECK (expected_channel_control_sequence IS NULL OR expected_channel_control_sequence >= 1),
  resolved_activation_id uuid,
  serving_head_moved boolean,
  channel_moved boolean,
  committed_serving_control_sequence bigint
    CHECK (committed_serving_control_sequence IS NULL
      OR committed_serving_control_sequence >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, preparation_id, release_id),
  CONSTRAINT snapshot_group_cutover_release_candidates_preparation_fk
    FOREIGN KEY (project_id, preparation_id)
    REFERENCES runtime.snapshot_group_cutover_preparations(project_id, preparation_id)
    ON DELETE RESTRICT,
  CONSTRAINT snapshot_group_cutover_release_candidates_release_fk
    FOREIGN KEY (project_id, release_id)
    REFERENCES meta.releases(project_id, release_id) ON DELETE RESTRICT,
  CONSTRAINT snapshot_group_cutover_release_candidates_serving_shape_ck CHECK (
    (expected_serving_activation_id IS NULL
      AND expected_serving_control_sequence IS NULL)
    OR
    (expected_serving_activation_id IS NOT NULL
      AND expected_serving_control_sequence IS NOT NULL)
  ),
  CONSTRAINT snapshot_group_cutover_release_candidates_channel_shape_ck CHECK (
    (expected_channel_release_id IS NULL
      AND expected_channel_activation_id IS NULL
      AND expected_channel_control_sequence IS NULL)
    OR
    (expected_channel_release_id IS NOT NULL
      AND expected_channel_activation_id IS NOT NULL
      AND expected_channel_control_sequence IS NOT NULL)
  ),
  CONSTRAINT snapshot_group_cutover_release_candidates_digest_shape_ck CHECK (
    (activation_digest IS NULL AND activation_content_digest IS NULL)
    OR
    (activation_digest ~ '^sha256:[0-9a-f]{64}$'
      AND activation_content_digest ~ '^sha256:[0-9a-f]{64}$')
  ),
  CONSTRAINT snapshot_group_cutover_release_candidates_result_shape_ck CHECK (
    (resolved_activation_id IS NULL
      AND serving_head_moved IS NULL
      AND channel_moved IS NULL
      AND committed_serving_control_sequence IS NULL)
    OR
    resolved_activation_id IS NOT NULL
  )
);

CREATE TABLE runtime.snapshot_group_cutover_member_candidates (
  project_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  release_id uuid NOT NULL,
  member_key varchar(70) NOT NULL
    CHECK (member_key ~ '^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$'),
  generation_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  snapshot_group_id uuid NOT NULL,
  group_version bigint NOT NULL CHECK (group_version >= 1),
  certificate_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, preparation_id, release_id, member_key),
  CONSTRAINT snapshot_group_cutover_member_candidates_release_fk
    FOREIGN KEY (project_id, preparation_id, release_id)
    REFERENCES runtime.snapshot_group_cutover_release_candidates(
      project_id, preparation_id, release_id
    ) ON DELETE RESTRICT,
  CONSTRAINT snapshot_group_cutover_member_candidates_generation_fk
    FOREIGN KEY (
      project_id, generation_id, member_key, snapshot_id,
      snapshot_group_id, group_version
    ) REFERENCES runtime.generations(
      project_id, generation_id, member_key, snapshot_id,
      snapshot_group_id, group_version
    ) ON DELETE RESTRICT,
  CONSTRAINT snapshot_group_cutover_member_candidates_certificate_fk
    FOREIGN KEY (
      project_id, certificate_id, generation_id, release_id,
      member_key, snapshot_group_id, group_version
    ) REFERENCES runtime.compatibility_certificates(
      project_id, certificate_id, generation_id, target_release_id,
      target_member_key, snapshot_group_id, group_version
    ) ON DELETE RESTRICT
);

-- A Head now carries both the immutable Current-row digest used by its FK and
-- the semantic digest used for business versioning. A complete immutable Head
-- Set is built before Cutover; the short transaction CAS-switches one Project
-- pointer instead of rewriting every Object Head while locks are held.
ALTER TABLE runtime.object_heads
  ADD COLUMN base_value_digest varchar(71)
    CHECK (base_value_digest IS NULL OR base_value_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE runtime.object_heads DISABLE TRIGGER object_heads_controlled_update;
UPDATE runtime.object_heads SET base_value_digest = head_digest;
ALTER TABLE runtime.object_heads ENABLE TRIGGER object_heads_controlled_update;
ALTER TABLE runtime.object_heads ALTER COLUMN base_value_digest SET NOT NULL;
ALTER TABLE runtime.object_heads DROP CONSTRAINT object_heads_current_fk;
ALTER TABLE runtime.object_heads
  ADD CONSTRAINT object_heads_current_fk FOREIGN KEY (
    project_id, current_generation_id, object_type_resource_id,
    object_type_revision_id, object_rid, base_value_digest
  ) REFERENCES runtime.object_current(
    project_id, generation_id, object_type_resource_id,
    object_type_revision_id, object_rid, base_value_digest
  ) ON DELETE RESTRICT;

CREATE TABLE runtime.object_head_sets (
  project_id uuid NOT NULL,
  head_set_id uuid NOT NULL,
  head_set_digest varchar(71) NOT NULL
    CHECK (head_set_digest ~ '^sha256:[0-9a-f]{64}$'),
  origin_preparation_id uuid,
  state text NOT NULL CHECK (state IN ('building', 'prepared', 'active', 'retired')),
  head_count bigint NOT NULL CHECK (head_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, head_set_id),
  CONSTRAINT object_head_sets_project_fk
    FOREIGN KEY (project_id) REFERENCES meta.projects(project_id) ON DELETE RESTRICT,
  CONSTRAINT object_head_sets_origin_fk
    FOREIGN KEY (project_id, origin_preparation_id)
    REFERENCES runtime.snapshot_group_cutover_preparations(project_id, preparation_id)
    ON DELETE RESTRICT,
  CONSTRAINT object_head_sets_digest_uq UNIQUE (project_id, head_set_digest)
);

CREATE TABLE runtime.object_head_versions (
  project_id uuid NOT NULL,
  head_set_id uuid NOT NULL,
  object_type_resource_id uuid NOT NULL,
  object_rid uuid NOT NULL,
  current_generation_id uuid NOT NULL,
  object_type_revision_id uuid NOT NULL,
  head_version bigint NOT NULL CHECK (head_version >= 1),
  head_digest varchar(71) NOT NULL
    CHECK (head_digest ~ '^sha256:[0-9a-f]{64}$'),
  base_value_digest varchar(71) NOT NULL
    CHECK (base_value_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, head_set_id, object_type_resource_id, object_rid),
  CONSTRAINT object_head_versions_set_fk FOREIGN KEY (project_id, head_set_id)
    REFERENCES runtime.object_head_sets(project_id, head_set_id) ON DELETE RESTRICT
);
CREATE INDEX object_head_versions_current_generation_idx
  ON runtime.object_head_versions(project_id, current_generation_id);

CREATE TABLE runtime.project_object_head_pointers (
  project_id uuid PRIMARY KEY,
  head_set_id uuid NOT NULL,
  control_sequence bigint NOT NULL CHECK (control_sequence >= 1),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT project_object_head_pointers_set_fk FOREIGN KEY (project_id, head_set_id)
    REFERENCES runtime.object_head_sets(project_id, head_set_id) ON DELETE RESTRICT
);

WITH legacy_sets AS (
  SELECT head.project_id, gen_random_uuid() AS head_set_id,
         'sha256:' || encode(sha256(convert_to(string_agg(
           head.object_type_resource_id::text || '|' || head.object_rid::text || '|' ||
           head.current_generation_id::text || '|' || head.object_type_revision_id::text || '|' ||
           head.head_version::text || '|' || head.head_digest || '|' || head.base_value_digest,
           E'\n' ORDER BY head.object_type_resource_id, head.object_rid
         ) || E'\n', 'UTF8')), 'hex') AS head_set_digest,
         count(*)::bigint AS head_count
  FROM runtime.object_heads AS head
  GROUP BY head.project_id
)
INSERT INTO runtime.object_head_sets (
  project_id, head_set_id, head_set_digest, state, head_count
)
SELECT project_id, head_set_id, head_set_digest, 'active', head_count
FROM legacy_sets;
INSERT INTO runtime.object_head_versions (
  project_id, head_set_id, object_type_resource_id, object_rid,
  current_generation_id, object_type_revision_id, head_version,
  head_digest, base_value_digest, created_at, changed_at
)
SELECT head.project_id, head_set.head_set_id, head.object_type_resource_id,
       head.object_rid, head.current_generation_id, head.object_type_revision_id,
       head.head_version, head.head_digest, head.base_value_digest,
       head.created_at, head.changed_at
FROM runtime.object_heads AS head
JOIN runtime.object_head_sets AS head_set ON head_set.project_id = head.project_id;
INSERT INTO runtime.project_object_head_pointers (
  project_id, head_set_id, control_sequence
)
SELECT project_id, head_set_id, 1 FROM runtime.object_head_sets;

ALTER TABLE runtime.object_heads RENAME TO object_heads_legacy;
DROP TABLE runtime.object_heads_legacy;
CREATE VIEW runtime.object_heads
WITH (security_barrier = true) AS
SELECT version.project_id, version.object_type_resource_id, version.object_rid,
       version.current_generation_id, version.object_type_revision_id,
       version.head_version, version.head_digest, version.created_at,
       version.changed_at, version.base_value_digest
FROM runtime.project_object_head_pointers AS pointer
JOIN runtime.object_head_versions AS version
  ON version.project_id = pointer.project_id
 AND version.head_set_id = pointer.head_set_id;

ALTER TABLE runtime.snapshot_group_cutover_preparations
  ADD CONSTRAINT snapshot_group_cutover_preparations_expected_head_set_fk
    FOREIGN KEY (project_id, expected_head_set_id)
    REFERENCES runtime.object_head_sets(project_id, head_set_id) ON DELETE RESTRICT,
  ADD CONSTRAINT snapshot_group_cutover_preparations_candidate_head_set_fk
    FOREIGN KEY (project_id, candidate_head_set_id)
    REFERENCES runtime.object_head_sets(project_id, head_set_id) ON DELETE RESTRICT;

CREATE TABLE runtime.snapshot_group_cutover_head_candidates (
  project_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  object_type_resource_id uuid NOT NULL,
  object_rid uuid NOT NULL,
  candidate_generation_id uuid NOT NULL,
  candidate_object_type_revision_id uuid NOT NULL,
  candidate_base_value_digest varchar(71) NOT NULL
    CHECK (candidate_base_value_digest ~ '^sha256:[0-9a-f]{64}$'),
  candidate_head_digest varchar(71) NOT NULL
    CHECK (candidate_head_digest ~ '^sha256:[0-9a-f]{64}$'),
  candidate_head_version bigint NOT NULL CHECK (candidate_head_version >= 1),
  disposition text NOT NULL CHECK (disposition IN ('insert', 'update', 'repoint')),
  expected_generation_id uuid,
  expected_object_type_revision_id uuid,
  expected_base_value_digest varchar(71)
    CHECK (expected_base_value_digest IS NULL
      OR expected_base_value_digest ~ '^sha256:[0-9a-f]{64}$'),
  expected_head_digest varchar(71)
    CHECK (expected_head_digest IS NULL OR expected_head_digest ~ '^sha256:[0-9a-f]{64}$'),
  expected_head_version bigint CHECK (expected_head_version IS NULL OR expected_head_version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, preparation_id, object_type_resource_id, object_rid),
  CONSTRAINT snapshot_group_cutover_head_candidates_preparation_fk
    FOREIGN KEY (project_id, preparation_id)
    REFERENCES runtime.snapshot_group_cutover_preparations(project_id, preparation_id)
    ON DELETE RESTRICT,
  CONSTRAINT snapshot_group_cutover_head_candidates_current_fk FOREIGN KEY (
    project_id, candidate_generation_id, object_type_resource_id,
    candidate_object_type_revision_id, object_rid, candidate_base_value_digest
  ) REFERENCES runtime.object_current(
    project_id, generation_id, object_type_resource_id,
    object_type_revision_id, object_rid, base_value_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT snapshot_group_cutover_head_candidates_expected_shape_ck CHECK (
    (disposition = 'insert'
      AND expected_generation_id IS NULL
      AND expected_object_type_revision_id IS NULL
      AND expected_base_value_digest IS NULL
      AND expected_head_digest IS NULL
      AND expected_head_version IS NULL
      AND candidate_head_version = 1)
    OR
    (disposition IN ('update', 'repoint')
      AND expected_generation_id IS NOT NULL
      AND expected_object_type_revision_id IS NOT NULL
      AND expected_base_value_digest IS NOT NULL
      AND expected_head_digest IS NOT NULL
      AND expected_head_version IS NOT NULL
      AND candidate_head_version = expected_head_version
        + CASE WHEN disposition = 'update' THEN 1 ELSE 0 END
      AND (disposition <> 'update' OR candidate_head_digest <> expected_head_digest)
      AND (disposition <> 'repoint' OR candidate_head_digest = expected_head_digest))
  )
);

CREATE TABLE runtime.snapshot_group_cutover_object_type_locks (
  project_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  object_type_resource_id uuid NOT NULL,
  PRIMARY KEY (project_id, preparation_id, object_type_resource_id),
  CONSTRAINT snapshot_group_cutover_object_type_locks_preparation_fk
    FOREIGN KEY (project_id, preparation_id)
    REFERENCES runtime.snapshot_group_cutover_preparations(project_id, preparation_id)
    ON DELETE RESTRICT,
  CONSTRAINT snapshot_group_cutover_object_type_locks_resource_fk
    FOREIGN KEY (project_id, object_type_resource_id)
    REFERENCES meta.resources(project_id, resource_id) ON DELETE RESTRICT
);

-- Independent content identity makes Activate idempotent across different
-- request keys without weakening the historic Activation digest contract.
CREATE TABLE runtime.activation_content_bindings (
  project_id uuid NOT NULL,
  release_id uuid NOT NULL,
  activation_content_digest varchar(71) NOT NULL
    CHECK (activation_content_digest ~ '^sha256:[0-9a-f]{64}$'),
  activation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, release_id, activation_content_digest),
  CONSTRAINT activation_content_bindings_activation_uq
    UNIQUE (release_id, activation_id),
  CONSTRAINT activation_content_bindings_release_fk
    FOREIGN KEY (project_id, release_id)
    REFERENCES meta.releases(project_id, release_id) ON DELETE RESTRICT,
  CONSTRAINT activation_content_bindings_activation_fk
    FOREIGN KEY (release_id, activation_id)
    REFERENCES meta.runtime_activations(release_id, activation_id) ON DELETE RESTRICT
);

CREATE FUNCTION ontos_migration.g20211_activation_content_digest(
  p_project_id uuid,
  p_release_id uuid,
  p_runtime_plan_digest text,
  p_members jsonb
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $g20211_activation_content_digest$
  SELECT 'sha256:' || encode(sha256(convert_to(
    '{"contractVersion":"runtime-activation-content-v1","members":' ||
    p_members::text || ',"projectId":' || to_json(p_project_id::text)::text ||
    ',"releaseId":' || to_json(p_release_id::text)::text ||
    ',"runtimePlanDigest":' || to_json(p_runtime_plan_digest)::text ||
    ',"schemaVersion":1}', 'UTF8'
  )), 'hex')
$g20211_activation_content_digest$;

CREATE FUNCTION ontos_migration.g20211_candidate_members_json(
  p_project_id uuid,
  p_preparation_id uuid,
  p_release_id uuid
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $g20211_candidate_members_json$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'certificateId', member.certificate_id::text,
    'generationId', member.generation_id::text,
    'groupVersion', member.group_version,
    'memberKey', member.member_key,
    'snapshotGroupId', member.snapshot_group_id::text,
    'snapshotId', member.snapshot_id::text
  ) ORDER BY member.member_key COLLATE "C"), '[]'::jsonb)
  FROM runtime.snapshot_group_cutover_member_candidates AS member
  WHERE member.project_id = p_project_id
    AND member.preparation_id = p_preparation_id
    AND member.release_id = p_release_id
$g20211_candidate_members_json$;

CREATE FUNCTION ontos_migration.g20211_candidate_activation_digest(
  p_project_id uuid,
  p_preparation_id uuid,
  p_release_id uuid,
  p_activation_id uuid,
  p_runtime_plan_digest text
) RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $g20211_candidate_activation_digest$
  SELECT 'sha256:' || encode(sha256(convert_to(
    '{"activationId":' || to_json(p_activation_id::text)::text ||
    ',"contractVersion":"runtime-activation-v1","members":[' ||
    COALESCE(string_agg(
      '{"certificateId":' || to_json(member.certificate_id::text)::text ||
      ',"generationId":' || to_json(member.generation_id::text)::text ||
      ',"groupVersion":' || member.group_version::text ||
      ',"memberKey":' || to_json(member.member_key)::text ||
      ',"snapshotGroupId":' || to_json(member.snapshot_group_id::text)::text ||
      ',"snapshotId":' || to_json(member.snapshot_id::text)::text || '}',
      ',' ORDER BY member.member_key COLLATE "C"
    ), '') || '],"projectId":' || to_json(p_project_id::text)::text ||
    ',"releaseId":' || to_json(p_release_id::text)::text ||
    ',"runtimePlanDigest":' || to_json(p_runtime_plan_digest)::text ||
    ',"schemaVersion":1}', 'UTF8'
  )), 'hex')
  FROM runtime.snapshot_group_cutover_member_candidates AS member
  WHERE member.project_id = p_project_id
    AND member.preparation_id = p_preparation_id
    AND member.release_id = p_release_id
$g20211_candidate_activation_digest$;

CREATE FUNCTION ontos_migration.g20211_semantic_head_digest(
  p_base_value_digest text,
  p_lifecycle_state text,
  p_visible_link_digest text
) RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $g20211_semantic_head_digest$
BEGIN
  IF p_base_value_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_lifecycle_state NOT IN ('active', 'inactive')
    OR (p_visible_link_digest IS NOT NULL
      AND p_visible_link_digest !~ '^sha256:[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'G20211_SEMANTIC_HEAD_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_lifecycle_state = 'active' AND p_visible_link_digest IS NULL THEN
    RETURN p_base_value_digest;
  END IF;
  RETURN 'sha256:' || encode(sha256(convert_to(
    p_base_value_digest || '|' || p_lifecycle_state || '|' ||
    COALESCE(p_visible_link_digest, 'sha256:' || repeat('0', 64)), 'UTF8'
  )), 'hex');
END
$g20211_semantic_head_digest$;

CREATE FUNCTION runtime.prepare_snapshot_group_cutover(
  p_project_id uuid,
  p_snapshot_group_id uuid,
  p_group_version bigint,
  p_expected_control_revision bigint,
  p_idempotency_key text,
  p_overlay_provider_id text,
  p_overlay_provider_version text,
  p_overlay_watermark bigint,
  p_overlay_delta_count bigint,
  p_overlay_evidence_digest text
) RETURNS TABLE (
  preparation_id uuid,
  expected_control_revision bigint,
  expected_state_revision bigint,
  expected_inventory_revision bigint,
  release_count integer,
  member_count integer,
  object_head_count bigint,
  state text,
  reused boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $prepare_snapshot_group_cutover$
DECLARE
  key_digest text;
  existing runtime.snapshot_group_cutover_preparations%ROWTYPE;
  current_control_revision bigint;
  current_state_revision bigint;
  current_inventory_revision bigint;
  current_head_set_id uuid;
  built_head_set_id uuid;
  candidate_head_set_digest text;
  candidate_head_set_count bigint;
  inserted_head_set boolean;
  built_head_rows bigint;
  prepared_id uuid := gen_random_uuid();
  prepared_release_count integer;
  prepared_member_count integer;
  prepared_head_count bigint;
BEGIN
  IF p_project_id IS NULL OR p_snapshot_group_id IS NULL OR p_group_version < 1
    OR p_expected_control_revision < 0
    OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$'
    OR p_overlay_provider_id <> 'ontos.zero-overlay'
    OR p_overlay_provider_version <> '1'
    OR p_overlay_watermark <> 0 OR p_overlay_delta_count <> 0
    OR p_overlay_evidence_digest <> 'sha256:' || repeat('0', 64) THEN
    RAISE EXCEPTION 'G20211_CUTOVER_INPUT_OR_OVERLAY_INVALID' USING ERRCODE = '22023';
  END IF;
  key_digest := 'sha256:' || encode(sha256(convert_to(p_idempotency_key, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text || ':' || key_digest, 20211));

  SELECT candidate.* INTO existing
  FROM runtime.snapshot_group_cutover_preparations AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.idempotency_key_digest = key_digest;
  IF FOUND THEN
    IF existing.snapshot_group_id <> p_snapshot_group_id
      OR existing.group_version <> p_group_version
      OR existing.expected_control_revision <> p_expected_control_revision
      OR existing.overlay_provider_id <> p_overlay_provider_id
      OR existing.overlay_provider_version <> p_overlay_provider_version
      OR existing.overlay_watermark <> p_overlay_watermark
      OR existing.overlay_delta_count <> p_overlay_delta_count
      OR existing.overlay_evidence_digest <> p_overlay_evidence_digest THEN
      RAISE EXCEPTION 'G20211_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.preparation_id, existing.expected_control_revision,
      existing.expected_state_revision, existing.expected_inventory_revision,
      existing.release_count, existing.member_count, existing.object_head_count,
      existing.state, true;
    RETURN;
  END IF;

  SELECT project.publication_sequence, inventory.state_revision,
         inventory.inventory_revision
  INTO current_control_revision, current_state_revision, current_inventory_revision
  FROM meta.projects AS project
  JOIN runtime.project_runtime_inventories AS inventory
    ON inventory.project_id = project.project_id
   AND inventory.measurement_complete
  WHERE project.project_id = p_project_id AND project.state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20211_CUTOVER_INVENTORY_NOT_READY' USING ERRCODE = '55000';
  END IF;
  IF current_control_revision <> p_expected_control_revision THEN
    RAISE EXCEPTION 'G20211_CUTOVER_CONTROL_STALE' USING ERRCODE = '40001';
  END IF;
  SELECT pointer.head_set_id INTO current_head_set_id
  FROM runtime.project_object_head_pointers AS pointer
  WHERE pointer.project_id = p_project_id;
  IF NOT EXISTS (
    SELECT 1 FROM runtime.snapshot_group_versions AS group_version
    WHERE group_version.project_id = p_project_id
      AND group_version.snapshot_group_id = p_snapshot_group_id
      AND group_version.group_version = p_group_version
      AND group_version.state IN ('ready', 'active')
  ) THEN
    RAISE EXCEPTION 'G20211_SNAPSHOT_GROUP_NOT_READY' USING ERRCODE = '55000';
  END IF;

  INSERT INTO runtime.snapshot_group_cutover_preparations (
    project_id, preparation_id, snapshot_group_id, group_version,
    expected_control_revision, expected_state_revision, expected_inventory_revision,
    expected_head_set_id,
    idempotency_key_digest, overlay_provider_id, overlay_provider_version,
    overlay_watermark, overlay_delta_count, overlay_evidence_digest
  ) VALUES (
    p_project_id, prepared_id, p_snapshot_group_id, p_group_version,
    current_control_revision, current_state_revision, current_inventory_revision,
    current_head_set_id,
    key_digest, p_overlay_provider_id, p_overlay_provider_version,
    p_overlay_watermark, p_overlay_delta_count, p_overlay_evidence_digest
  );

  INSERT INTO runtime.snapshot_group_cutover_release_candidates (
    project_id, preparation_id, release_id, runtime_plan_digest, activation_id,
    expected_serving_activation_id, expected_serving_control_sequence,
    channel_name, expected_channel_release_id, expected_channel_activation_id,
    expected_channel_control_sequence
  )
  SELECT release.project_id, prepared_id, release.release_id, plan.plan_digest,
         gen_random_uuid(), serving.activation_id, serving.control_sequence,
         release.target_channel_name, channel.release_id, channel.activation_id,
         channel.control_sequence
  FROM meta.releases AS release
  JOIN meta.release_runtime_plans AS plan
    ON plan.project_id = release.project_id AND plan.release_id = release.release_id
  LEFT JOIN meta.release_serving_heads AS serving
    ON serving.release_id = release.release_id
  LEFT JOIN meta.release_channels AS channel
    ON channel.project_id = release.project_id
   AND channel.channel_name = release.target_channel_name
  WHERE release.project_id = p_project_id
    AND release.state IN ('ready', 'published', 'superseded')
    AND EXISTS (
      SELECT 1 FROM meta.release_runtime_plan_members AS member
      WHERE member.release_id = release.release_id
        AND member.snapshot_group_id = p_snapshot_group_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM meta.release_runtime_plan_members AS member
      WHERE member.release_id = release.release_id
        AND member.snapshot_group_id = p_snapshot_group_id
        AND NOT EXISTS (
          SELECT 1
          FROM runtime.current_compatibility_certificates AS certificate
          WHERE certificate.project_id = p_project_id
            AND certificate.target_release_id = release.release_id
            AND certificate.target_member_key = member.member_key
            AND certificate.snapshot_group_id = p_snapshot_group_id
            AND certificate.group_version = p_group_version
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM runtime.snapshot_group_members AS actual
      WHERE actual.project_id = p_project_id
        AND actual.snapshot_group_id = p_snapshot_group_id
        AND actual.group_version = p_group_version
        AND NOT EXISTS (
          SELECT 1 FROM meta.release_runtime_plan_members AS member
          WHERE member.release_id = release.release_id
            AND member.snapshot_group_id = p_snapshot_group_id
            AND member.member_key = actual.member_key
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM meta.release_runtime_plan_members AS member
      WHERE member.release_id = release.release_id
        AND member.snapshot_group_id <> p_snapshot_group_id
        AND NOT EXISTS (
          SELECT 1
          FROM runtime.current_compatibility_certificates AS certificate
          LEFT JOIN meta.runtime_activation_members AS old_member
            ON old_member.project_id = certificate.project_id
           AND old_member.release_id = certificate.target_release_id
           AND old_member.activation_id = serving.activation_id
           AND old_member.member_key = certificate.target_member_key
           AND old_member.certificate_id = certificate.certificate_id
          WHERE certificate.project_id = p_project_id
            AND certificate.target_release_id = release.release_id
            AND certificate.target_member_key = member.member_key
            AND (serving.activation_id IS NULL OR old_member.member_key IS NOT NULL)
        )
    )
  ORDER BY release.release_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20211_NO_RELEASE_READY_FOR_CUTOVER' USING ERRCODE = '55000';
  END IF;

  INSERT INTO runtime.snapshot_group_cutover_member_candidates (
    project_id, preparation_id, release_id, member_key, generation_id,
    snapshot_id, snapshot_group_id, group_version, certificate_id
  )
  SELECT candidate.project_id, candidate.preparation_id, candidate.release_id,
         plan_member.member_key, selected.generation_id, selected.snapshot_id,
         selected.snapshot_group_id, selected.group_version, selected.certificate_id
  FROM runtime.snapshot_group_cutover_release_candidates AS candidate
  JOIN meta.release_runtime_plan_members AS plan_member
    ON plan_member.project_id = candidate.project_id
   AND plan_member.release_id = candidate.release_id
  LEFT JOIN meta.runtime_activation_members AS old_member
    ON old_member.project_id = candidate.project_id
   AND old_member.release_id = candidate.release_id
   AND old_member.activation_id = candidate.expected_serving_activation_id
   AND old_member.member_key = plan_member.member_key
  CROSS JOIN LATERAL (
    SELECT certificate.generation_id, generation.snapshot_id,
           certificate.snapshot_group_id, certificate.group_version,
           certificate.certificate_id
    FROM runtime.current_compatibility_certificates AS certificate
    JOIN runtime.generations AS generation
      ON generation.project_id = certificate.project_id
     AND generation.generation_id = certificate.generation_id
    WHERE certificate.project_id = candidate.project_id
      AND certificate.target_release_id = candidate.release_id
      AND certificate.target_member_key = plan_member.member_key
      AND (
        (plan_member.snapshot_group_id = p_snapshot_group_id
          AND certificate.snapshot_group_id = p_snapshot_group_id
          AND certificate.group_version = p_group_version)
        OR
        (plan_member.snapshot_group_id <> p_snapshot_group_id
          AND (candidate.expected_serving_activation_id IS NULL
            OR certificate.certificate_id = old_member.certificate_id))
      )
    ORDER BY certificate.issued_at DESC, certificate.certificate_id
    LIMIT 1
  ) AS selected
  WHERE candidate.project_id = p_project_id
    AND candidate.preparation_id = prepared_id
  ORDER BY candidate.release_id, plan_member.member_key COLLATE "C";

  IF EXISTS (
    SELECT 1
    FROM runtime.snapshot_group_cutover_release_candidates AS candidate
    JOIN meta.release_runtime_plans AS plan ON plan.release_id = candidate.release_id
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS actual_count
      FROM runtime.snapshot_group_cutover_member_candidates AS member
      WHERE member.project_id = candidate.project_id
        AND member.preparation_id = candidate.preparation_id
        AND member.release_id = candidate.release_id
    ) AS actual ON true
    WHERE candidate.project_id = p_project_id
      AND candidate.preparation_id = prepared_id
      AND actual.actual_count <> plan.member_count
  ) THEN
    RAISE EXCEPTION 'G20211_CUTOVER_MEMBER_SET_INCOMPLETE' USING ERRCODE = '55000';
  END IF;

  UPDATE runtime.snapshot_group_cutover_release_candidates AS candidate
  SET activation_content_digest = ontos_migration.g20211_activation_content_digest(
        candidate.project_id, candidate.release_id, candidate.runtime_plan_digest,
        ontos_migration.g20211_candidate_members_json(
          candidate.project_id, candidate.preparation_id, candidate.release_id
        )
      ),
      activation_digest = ontos_migration.g20211_candidate_activation_digest(
        candidate.project_id, candidate.preparation_id, candidate.release_id,
        candidate.activation_id, candidate.runtime_plan_digest
      )
  WHERE candidate.project_id = p_project_id
    AND candidate.preparation_id = prepared_id;

  IF EXISTS (
    WITH selected_object_rows AS (
      SELECT DISTINCT current.object_type_resource_id, current.object_rid,
             current.generation_id, current.object_type_revision_id,
             current.base_value_digest, current.lifecycle_state
      FROM runtime.snapshot_group_cutover_member_candidates AS member
      JOIN runtime.generations AS generation
        ON generation.project_id = member.project_id
       AND generation.generation_id = member.generation_id
       AND generation.member_kind = 'object'
      JOIN runtime.object_current AS current
        ON current.project_id = generation.project_id
       AND current.generation_id = generation.generation_id
      WHERE member.project_id = p_project_id
        AND member.preparation_id = prepared_id
        AND member.snapshot_group_id = p_snapshot_group_id
        AND member.group_version = p_group_version
    )
    SELECT 1 FROM selected_object_rows
    GROUP BY object_type_resource_id, object_rid
    HAVING count(DISTINCT ROW(
      generation_id, object_type_revision_id, base_value_digest, lifecycle_state
    )) > 1
  ) THEN
    RAISE EXCEPTION 'G20211_RELEASE_GENERATION_CONFLICT' USING ERRCODE = '55000';
  END IF;

  INSERT INTO runtime.snapshot_group_cutover_head_candidates (
    project_id, preparation_id, object_type_resource_id, object_rid,
    candidate_generation_id, candidate_object_type_revision_id,
    candidate_base_value_digest, candidate_head_digest, candidate_head_version,
    disposition, expected_generation_id, expected_object_type_revision_id,
    expected_base_value_digest, expected_head_digest, expected_head_version
  )
  WITH selected_object_rows AS (
    SELECT DISTINCT current.object_type_resource_id, current.object_rid,
           current.generation_id, current.object_type_revision_id,
           current.base_value_digest, current.lifecycle_state
    FROM runtime.snapshot_group_cutover_member_candidates AS member
    JOIN runtime.generations AS generation
      ON generation.project_id = member.project_id
     AND generation.generation_id = member.generation_id
     AND generation.member_kind = 'object'
    JOIN runtime.object_current AS current
      ON current.project_id = generation.project_id
     AND current.generation_id = generation.generation_id
    WHERE member.project_id = p_project_id
      AND member.preparation_id = prepared_id
      AND member.snapshot_group_id = p_snapshot_group_id
      AND member.group_version = p_group_version
  ), selected_new_link_generations AS (
    SELECT DISTINCT member.generation_id
    FROM runtime.snapshot_group_cutover_member_candidates AS member
    JOIN runtime.generations AS generation
      ON generation.project_id = member.project_id
     AND generation.generation_id = member.generation_id
     AND generation.member_kind = 'link'
    WHERE member.project_id = p_project_id
      AND member.preparation_id = prepared_id
      AND member.snapshot_group_id = p_snapshot_group_id
      AND member.group_version = p_group_version
  ), selected_old_link_generations AS (
    SELECT DISTINCT old_member.generation_id
    FROM runtime.snapshot_group_cutover_release_candidates AS candidate
    JOIN meta.runtime_activation_members AS old_member
      ON old_member.project_id = candidate.project_id
     AND old_member.release_id = candidate.release_id
     AND old_member.activation_id = candidate.expected_serving_activation_id
     AND old_member.snapshot_group_id = p_snapshot_group_id
    JOIN runtime.generations AS generation
      ON generation.project_id = old_member.project_id
     AND generation.generation_id = old_member.generation_id
     AND generation.member_kind = 'link'
    WHERE candidate.project_id = p_project_id
      AND candidate.preparation_id = prepared_id
  ), affected_identities AS (
    SELECT object_type_resource_id, object_rid FROM selected_object_rows
    UNION
    SELECT link.source_object_type_resource_id, link.source_object_rid
    FROM runtime.link_current AS link
    WHERE link.project_id = p_project_id
      AND link.generation_id IN (
        SELECT generation_id FROM selected_new_link_generations
        UNION SELECT generation_id FROM selected_old_link_generations
      )
    UNION
    SELECT link.target_object_type_resource_id, link.target_object_rid
    FROM runtime.link_current AS link
    WHERE link.project_id = p_project_id
      AND link.generation_id IN (
        SELECT generation_id FROM selected_new_link_generations
        UNION SELECT generation_id FROM selected_old_link_generations
      )
  ), object_sources AS (
    SELECT identity.object_type_resource_id, identity.object_rid,
           COALESCE(new_row.generation_id, head.current_generation_id) AS generation_id,
           COALESCE(new_row.object_type_revision_id, head.object_type_revision_id)
             AS object_type_revision_id,
           COALESCE(new_row.base_value_digest, head.base_value_digest) AS base_value_digest,
           COALESCE(new_row.lifecycle_state, old_current.lifecycle_state) AS lifecycle_state
    FROM affected_identities AS identity
    LEFT JOIN selected_object_rows AS new_row
      ON new_row.object_type_resource_id = identity.object_type_resource_id
     AND new_row.object_rid = identity.object_rid
    LEFT JOIN runtime.object_heads AS head
      ON head.project_id = p_project_id
     AND head.object_type_resource_id = identity.object_type_resource_id
     AND head.object_rid = identity.object_rid
    LEFT JOIN runtime.object_current AS old_current
      ON old_current.project_id = head.project_id
     AND old_current.generation_id = head.current_generation_id
     AND old_current.object_type_resource_id = head.object_type_resource_id
     AND old_current.object_rid = head.object_rid
    WHERE new_row.generation_id IS NOT NULL OR head.current_generation_id IS NOT NULL
  ), visible_link_lines AS (
    SELECT link.source_object_type_resource_id AS object_type_resource_id,
           link.source_object_rid AS object_rid,
           link.link_type_resource_id::text || '|' || link.link_type_revision_id::text ||
           '|' || link.link_rid::text || '|source|' || link.source_object_rid::text ||
           '|' || link.target_object_rid::text || '|' || link.base_value_digest AS line
    FROM runtime.link_current AS link
    WHERE link.project_id = p_project_id
      AND link.generation_id IN (SELECT generation_id FROM selected_new_link_generations)
    UNION ALL
    SELECT link.target_object_type_resource_id, link.target_object_rid,
           link.link_type_resource_id::text || '|' || link.link_type_revision_id::text ||
           '|' || link.link_rid::text || '|target|' || link.source_object_rid::text ||
           '|' || link.target_object_rid::text || '|' || link.base_value_digest
    FROM runtime.link_current AS link
    WHERE link.project_id = p_project_id
      AND link.generation_id IN (SELECT generation_id FROM selected_new_link_generations)
  ), visible_links AS (
    SELECT object_type_resource_id, object_rid,
           'sha256:' || encode(sha256(convert_to(
             string_agg(line, E'\n' ORDER BY line COLLATE "C") || E'\n', 'UTF8'
           )), 'hex') AS link_digest
    FROM visible_link_lines
    GROUP BY object_type_resource_id, object_rid
  ), semantic AS (
    SELECT source.*,
      ontos_migration.g20211_semantic_head_digest(
        source.base_value_digest, source.lifecycle_state, visible.link_digest
      ) AS head_digest
    FROM object_sources AS source
    LEFT JOIN visible_links AS visible
      ON visible.object_type_resource_id = source.object_type_resource_id
     AND visible.object_rid = source.object_rid
  )
  SELECT p_project_id, prepared_id, semantic.object_type_resource_id,
         semantic.object_rid, semantic.generation_id,
         semantic.object_type_revision_id, semantic.base_value_digest,
         semantic.head_digest,
         CASE WHEN head.object_rid IS NULL THEN 1
              WHEN head.head_digest = semantic.head_digest THEN head.head_version
              ELSE head.head_version + 1 END,
         CASE WHEN head.object_rid IS NULL THEN 'insert'
              WHEN head.head_digest = semantic.head_digest THEN 'repoint'
              ELSE 'update' END,
         head.current_generation_id, head.object_type_revision_id,
         head.base_value_digest, head.head_digest, head.head_version
  FROM semantic
  LEFT JOIN runtime.object_heads AS head
    ON head.project_id = p_project_id
   AND head.object_type_resource_id = semantic.object_type_resource_id
   AND head.object_rid = semantic.object_rid
  WHERE head.object_rid IS NULL
     OR head.current_generation_id <> semantic.generation_id
     OR head.object_type_revision_id <> semantic.object_type_revision_id
     OR head.base_value_digest <> semantic.base_value_digest
     OR head.head_digest <> semantic.head_digest
  ORDER BY semantic.object_type_resource_id, semantic.object_rid;

  INSERT INTO runtime.snapshot_group_cutover_object_type_locks (
    project_id, preparation_id, object_type_resource_id
  )
  SELECT DISTINCT candidate.project_id, candidate.preparation_id,
         candidate.object_type_resource_id
  FROM runtime.snapshot_group_cutover_head_candidates AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.preparation_id = prepared_id
  ORDER BY candidate.object_type_resource_id;

  SELECT count(*)::integer INTO prepared_release_count
  FROM runtime.snapshot_group_cutover_release_candidates AS release_candidate_count
  WHERE release_candidate_count.project_id = p_project_id
    AND release_candidate_count.preparation_id = prepared_id;
  SELECT count(*)::integer INTO prepared_member_count
  FROM runtime.snapshot_group_cutover_member_candidates AS member_candidate_count
  WHERE member_candidate_count.project_id = p_project_id
    AND member_candidate_count.preparation_id = prepared_id;
  SELECT count(*)::bigint INTO prepared_head_count
  FROM runtime.snapshot_group_cutover_head_candidates AS head_candidate_count
  WHERE head_candidate_count.project_id = p_project_id
    AND head_candidate_count.preparation_id = prepared_id;

  -- Build the complete immutable target Head Set outside the final transaction.
  -- The digest deduplicates retries that describe the same physical Current rows.
  WITH target_heads AS (
    SELECT head.object_type_resource_id, head.object_rid,
           head.current_generation_id, head.object_type_revision_id,
           head.head_version, head.head_digest, head.base_value_digest
    FROM runtime.object_heads AS head
    WHERE head.project_id = p_project_id
      AND NOT EXISTS (
        SELECT 1
        FROM runtime.snapshot_group_cutover_head_candidates AS candidate
        WHERE candidate.project_id = p_project_id
          AND candidate.preparation_id = prepared_id
          AND candidate.object_type_resource_id = head.object_type_resource_id
          AND candidate.object_rid = head.object_rid
      )
    UNION ALL
    SELECT candidate.object_type_resource_id, candidate.object_rid,
           candidate.candidate_generation_id,
           candidate.candidate_object_type_revision_id,
           candidate.candidate_head_version, candidate.candidate_head_digest,
           candidate.candidate_base_value_digest
    FROM runtime.snapshot_group_cutover_head_candidates AS candidate
    WHERE candidate.project_id = p_project_id
      AND candidate.preparation_id = prepared_id
  )
  SELECT 'sha256:' || encode(sha256(convert_to(COALESCE(string_agg(
           target.object_type_resource_id::text || '|' || target.object_rid::text || '|' ||
           target.current_generation_id::text || '|' || target.object_type_revision_id::text ||
           '|' || target.head_version::text || '|' || target.head_digest || '|' ||
           target.base_value_digest,
           E'\n' ORDER BY target.object_type_resource_id, target.object_rid
         ) || E'\n', ''), 'UTF8')), 'hex'),
         count(*)::bigint
  INTO candidate_head_set_digest, candidate_head_set_count
  FROM target_heads AS target;

  built_head_set_id := gen_random_uuid();
  INSERT INTO runtime.object_head_sets (
    project_id, head_set_id, head_set_digest, origin_preparation_id, state, head_count
  ) VALUES (
    p_project_id, built_head_set_id, candidate_head_set_digest,
    prepared_id, 'building', candidate_head_set_count
  ) ON CONFLICT (project_id, head_set_digest) DO NOTHING;
  inserted_head_set := FOUND;
  IF inserted_head_set THEN
    INSERT INTO runtime.object_head_versions (
      project_id, head_set_id, object_type_resource_id, object_rid,
      current_generation_id, object_type_revision_id, head_version,
      head_digest, base_value_digest, created_at, changed_at
    )
    SELECT p_project_id, built_head_set_id, target.object_type_resource_id,
           target.object_rid, target.current_generation_id,
           target.object_type_revision_id, target.head_version,
           target.head_digest, target.base_value_digest,
           target.created_at, target.changed_at
    FROM (
      SELECT head.object_type_resource_id, head.object_rid,
             head.current_generation_id, head.object_type_revision_id,
             head.head_version, head.head_digest, head.base_value_digest,
             head.created_at, head.changed_at
      FROM runtime.object_heads AS head
      WHERE head.project_id = p_project_id
        AND NOT EXISTS (
          SELECT 1
          FROM runtime.snapshot_group_cutover_head_candidates AS candidate
          WHERE candidate.project_id = p_project_id
            AND candidate.preparation_id = prepared_id
            AND candidate.object_type_resource_id = head.object_type_resource_id
            AND candidate.object_rid = head.object_rid
        )
      UNION ALL
      SELECT candidate.object_type_resource_id, candidate.object_rid,
             candidate.candidate_generation_id,
             candidate.candidate_object_type_revision_id,
             candidate.candidate_head_version, candidate.candidate_head_digest,
             candidate.candidate_base_value_digest,
             COALESCE(head.created_at, clock_timestamp()), clock_timestamp()
      FROM runtime.snapshot_group_cutover_head_candidates AS candidate
      LEFT JOIN runtime.object_heads AS head
        ON head.project_id = candidate.project_id
       AND head.object_type_resource_id = candidate.object_type_resource_id
       AND head.object_rid = candidate.object_rid
      WHERE candidate.project_id = p_project_id
        AND candidate.preparation_id = prepared_id
    ) AS target
    ORDER BY target.object_type_resource_id, target.object_rid;
    GET DIAGNOSTICS built_head_rows = ROW_COUNT;
    IF built_head_rows <> candidate_head_set_count THEN
      RAISE EXCEPTION 'G20211_HEAD_SET_BUILD_INCOMPLETE' USING ERRCODE = '55000';
    END IF;
    UPDATE runtime.object_head_sets AS built
    SET state = 'prepared', changed_at = clock_timestamp()
    WHERE built.project_id = p_project_id
      AND built.head_set_id = built_head_set_id
      AND built.state = 'building';
  ELSE
    SELECT head_set.head_set_id INTO STRICT built_head_set_id
    FROM runtime.object_head_sets AS head_set
    WHERE head_set.project_id = p_project_id
      AND head_set.head_set_digest = candidate_head_set_digest
      AND head_set.state IN ('prepared', 'active', 'retired')
      AND head_set.head_count = candidate_head_set_count;
  END IF;

  UPDATE runtime.snapshot_group_cutover_preparations AS prepared
  SET release_count = prepared_release_count,
      member_count = prepared_member_count,
      object_head_count = prepared_head_count,
      candidate_head_set_id = built_head_set_id,
      state = 'prepared'
  WHERE prepared.project_id = p_project_id AND prepared.preparation_id = prepared_id;

  RETURN QUERY SELECT prepared_id, current_control_revision,
    current_state_revision, current_inventory_revision,
    prepared_release_count, prepared_member_count, prepared_head_count,
    'prepared'::text, false;
END
$prepare_snapshot_group_cutover$;

CREATE FUNCTION ontos_migration.g20211_commit_snapshot_group_cutover(
  p_project_id uuid,
  p_preparation_id uuid,
  p_overlay_provider_id text,
  p_overlay_provider_version text,
  p_overlay_watermark bigint,
  p_overlay_delta_count bigint,
  p_overlay_evidence_digest text,
  p_fault_point text DEFAULT NULL
) RETURNS TABLE (
  preparation_id uuid,
  project_id uuid,
  snapshot_group_id uuid,
  group_version bigint,
  control_revision bigint,
  state_revision bigint,
  inventory_revision bigint,
  changed boolean,
  reused boolean,
  created_activation_count integer,
  inserted_head_count bigint,
  updated_head_count bigint,
  repointed_head_count bigint,
  releases jsonb
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $commit_snapshot_group_cutover$
DECLARE
  preparation runtime.snapshot_group_cutover_preparations%ROWTYPE;
  release_candidate runtime.snapshot_group_cutover_release_candidates%ROWTYPE;
  resolved_activation uuid;
  current_control bigint;
  current_state bigint;
  current_inventory bigint;
  current_head_set uuid;
  pointer_found boolean;
  head_pointer_changed boolean := false;
  actual_rows bigint;
  expected_rows bigint;
  new_activation_count integer := 0;
  inserted_heads bigint := 0;
  updated_heads bigint := 0;
  repointed_heads bigint := 0;
  moved_serving_heads integer := 0;
  moved_channels integer := 0;
  lifecycle_changes integer := 0;
  did_change boolean := false;
  final_control bigint;
  final_state bigint;
  release_results jsonb;
BEGIN
  IF p_project_id IS NULL OR p_preparation_id IS NULL
    OR p_fault_point IS NOT NULL AND p_fault_point NOT IN (
      'after_locks', 'after_activations', 'after_heads', 'after_serving_heads',
      'after_channels', 'after_lifecycle', 'after_revisions', 'after_result'
    ) THEN
    RAISE EXCEPTION 'G20211_CUTOVER_COMMIT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT candidate.* INTO preparation
  FROM runtime.snapshot_group_cutover_preparations AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.preparation_id = p_preparation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20211_CUTOVER_PREPARATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF preparation.overlay_provider_id <> p_overlay_provider_id
    OR preparation.overlay_provider_version <> p_overlay_provider_version
    OR preparation.overlay_watermark <> p_overlay_watermark
    OR preparation.overlay_delta_count <> p_overlay_delta_count
    OR preparation.overlay_evidence_digest <> p_overlay_evidence_digest
    OR p_overlay_provider_id <> 'ontos.zero-overlay'
    OR p_overlay_provider_version <> '1'
    OR p_overlay_watermark <> 0 OR p_overlay_delta_count <> 0
    OR p_overlay_evidence_digest <> 'sha256:' || repeat('0', 64) THEN
    RAISE EXCEPTION 'G20211_OVERLAY_EVIDENCE_STALE' USING ERRCODE = '40001';
  END IF;

  IF preparation.state = 'committed' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'releaseId', candidate.release_id::text,
      'activationId', candidate.resolved_activation_id::text,
      'previousActivationId', candidate.expected_serving_activation_id::text,
      'servingHeadMoved', candidate.serving_head_moved,
      'servingHeadControlSequence', candidate.committed_serving_control_sequence::text,
      'channelMoved', candidate.channel_moved
    ) ORDER BY candidate.release_id), '[]'::jsonb)
    INTO release_results
    FROM runtime.snapshot_group_cutover_release_candidates AS candidate
    WHERE candidate.project_id = p_project_id
      AND candidate.preparation_id = p_preparation_id;
    RETURN QUERY SELECT preparation.preparation_id, preparation.project_id,
      preparation.snapshot_group_id, preparation.group_version,
      preparation.committed_control_revision, preparation.committed_state_revision,
      preparation.committed_inventory_revision, preparation.committed_changed, true,
      preparation.created_activation_count, preparation.inserted_head_count,
      preparation.updated_head_count, preparation.repointed_head_count, release_results;
    RETURN;
  END IF;
  IF preparation.state <> 'prepared' THEN
    RAISE EXCEPTION 'G20211_CUTOVER_PREPARATION_INCOMPLETE' USING ERRCODE = '55000';
  END IF;

  -- PROJECT_CONTROL
  SELECT project.publication_sequence INTO current_control
  FROM meta.projects AS project
  WHERE project.project_id = p_project_id AND project.state = 'active'
  FOR UPDATE;
  IF NOT FOUND OR current_control <> preparation.expected_control_revision THEN
    RAISE EXCEPTION 'G20211_CUTOVER_CONTROL_STALE' USING ERRCODE = '40001';
  END IF;

  -- RELEASE_CHANNEL (advisory key and row), then RELEASE.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_project_id::text || ':' || candidate.channel_name, 20108
  ))
  FROM runtime.snapshot_group_cutover_release_candidates AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.preparation_id = p_preparation_id
  ORDER BY candidate.channel_name COLLATE "C";
  PERFORM 1
  FROM meta.release_channels AS channel
  JOIN (
    SELECT DISTINCT channel_candidate.channel_name
    FROM runtime.snapshot_group_cutover_release_candidates AS channel_candidate
    WHERE channel_candidate.project_id = p_project_id
      AND channel_candidate.preparation_id = p_preparation_id
  ) AS candidate ON candidate.channel_name = channel.channel_name
  WHERE channel.project_id = p_project_id
  ORDER BY channel.channel_name COLLATE "C"
  FOR UPDATE OF channel;
  PERFORM 1
  FROM meta.releases AS release
  JOIN runtime.snapshot_group_cutover_release_candidates AS candidate
    ON candidate.project_id = release.project_id
   AND candidate.release_id = release.release_id
  WHERE candidate.project_id = p_project_id
    AND candidate.preparation_id = p_preparation_id
    AND release.state IN ('ready', 'published', 'superseded')
  ORDER BY release.release_id
  FOR UPDATE OF release;
  GET DIAGNOSTICS actual_rows = ROW_COUNT;
  IF actual_rows <> preparation.release_count THEN
    RAISE EXCEPTION 'G20211_CUTOVER_RELEASE_STALE' USING ERRCODE = '40001';
  END IF;

  -- SNAPSHOT_GROUP. Lock the definition and every live version/member in
  -- deterministic order so retirement is part of the same all-or-nothing cutover.
  PERFORM 1 FROM runtime.snapshot_groups AS snapshot_group
  WHERE snapshot_group.project_id = p_project_id
    AND snapshot_group.snapshot_group_id = preparation.snapshot_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20211_SNAPSHOT_GROUP_STALE' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM runtime.snapshot_group_versions AS group_version
  WHERE group_version.project_id = p_project_id
    AND group_version.snapshot_group_id = preparation.snapshot_group_id
    AND group_version.state IN ('ready', 'active')
  ORDER BY group_version.group_version
  FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM runtime.snapshot_group_versions AS target_group_version
    WHERE target_group_version.project_id = p_project_id
      AND target_group_version.snapshot_group_id = preparation.snapshot_group_id
      AND target_group_version.group_version = preparation.group_version
      AND target_group_version.state IN ('ready', 'active')
  ) THEN
    RAISE EXCEPTION 'G20211_SNAPSHOT_GROUP_STALE' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM runtime.generations AS generation_lock
  WHERE generation_lock.project_id = p_project_id
    AND generation_lock.snapshot_group_id = preparation.snapshot_group_id
    AND generation_lock.state IN ('ready', 'active')
  ORDER BY generation_lock.generation_id
  FOR UPDATE;
  PERFORM 1 FROM runtime.dataset_snapshots AS snapshot_lock
  WHERE snapshot_lock.project_id = p_project_id
    AND snapshot_lock.snapshot_group_id = preparation.snapshot_group_id
    AND snapshot_lock.state IN ('ready', 'active')
  ORDER BY snapshot_lock.snapshot_id
  FOR UPDATE;

  -- OBJECT_TYPE_CUTOVER
  PERFORM pg_advisory_xact_lock(hashtextextended(
    head_lock.object_type_resource_id::text, 20212
  ))
  FROM runtime.snapshot_group_cutover_object_type_locks AS head_lock
  WHERE head_lock.project_id = p_project_id
    AND head_lock.preparation_id = p_preparation_id
  ORDER BY head_lock.object_type_resource_id;

  SELECT pointer.head_set_id INTO current_head_set
  FROM runtime.project_object_head_pointers AS pointer
  WHERE pointer.project_id = p_project_id
  FOR UPDATE;
  pointer_found := FOUND;
  IF (preparation.expected_head_set_id IS NULL AND pointer_found)
    OR (preparation.expected_head_set_id IS NOT NULL AND (
      NOT pointer_found OR current_head_set <> preparation.expected_head_set_id
    )) THEN
    RAISE EXCEPTION 'G20211_OBJECT_HEAD_CAS_STALE' USING ERRCODE = '40001';
  END IF;
  PERFORM 1
  FROM runtime.object_head_sets AS candidate_set
  WHERE candidate_set.project_id = p_project_id
    AND candidate_set.head_set_id = preparation.candidate_head_set_id
    AND candidate_set.state IN ('prepared', 'active', 'retired')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20211_HEAD_SET_STALE' USING ERRCODE = '40001';
  END IF;

  -- GENERATION_INVENTORY
  SELECT inventory.state_revision, inventory.inventory_revision
  INTO current_state, current_inventory
  FROM runtime.project_runtime_inventories AS inventory
  WHERE inventory.project_id = p_project_id AND inventory.measurement_complete
  FOR UPDATE;
  IF NOT FOUND
    OR current_state <> preparation.expected_state_revision
    OR current_inventory <> preparation.expected_inventory_revision THEN
    RAISE EXCEPTION 'G20211_CUTOVER_INVENTORY_STALE' USING ERRCODE = '40001';
  END IF;

  -- SERVING_HEADS
  PERFORM 1
  FROM meta.release_serving_heads AS serving
  JOIN runtime.snapshot_group_cutover_release_candidates AS candidate
    ON candidate.release_id = serving.release_id
  WHERE candidate.project_id = p_project_id
    AND candidate.preparation_id = p_preparation_id
  ORDER BY serving.release_id
  FOR UPDATE OF serving;

  IF p_fault_point = 'after_locks' THEN
    RAISE EXCEPTION 'G20211_INJECTED_FAILURE:after_locks' USING ERRCODE = 'XX000';
  END IF;

  -- The candidate is valid only while every selected Certificate remains in
  -- the dynamic current view and every Plan member is represented exactly once.
  IF EXISTS (
    SELECT 1
    FROM runtime.snapshot_group_cutover_member_candidates AS member
    WHERE member.project_id = p_project_id
      AND member.preparation_id = p_preparation_id
      AND NOT EXISTS (
        SELECT 1 FROM runtime.current_compatibility_certificates AS certificate
        WHERE certificate.project_id = member.project_id
          AND certificate.certificate_id = member.certificate_id
          AND certificate.generation_id = member.generation_id
          AND certificate.target_release_id = member.release_id
          AND certificate.target_member_key = member.member_key
          AND certificate.snapshot_group_id = member.snapshot_group_id
          AND certificate.group_version = member.group_version
      )
  ) OR EXISTS (
    SELECT 1
    FROM runtime.snapshot_group_cutover_release_candidates AS candidate
    JOIN meta.release_runtime_plans AS plan
      ON plan.release_id = candidate.release_id
     AND plan.plan_digest = candidate.runtime_plan_digest
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS actual_count
      FROM runtime.snapshot_group_cutover_member_candidates AS member
      WHERE member.project_id = candidate.project_id
        AND member.preparation_id = candidate.preparation_id
        AND member.release_id = candidate.release_id
    ) AS actual ON true
    WHERE candidate.project_id = p_project_id
      AND candidate.preparation_id = p_preparation_id
      AND actual.actual_count <> plan.member_count
  ) THEN
    RAISE EXCEPTION 'G20211_CUTOVER_CERTIFICATE_OR_PLAN_STALE' USING ERRCODE = '40001';
  END IF;

  FOR release_candidate IN
    SELECT * FROM runtime.snapshot_group_cutover_release_candidates AS candidate
    WHERE candidate.project_id = p_project_id
      AND candidate.preparation_id = p_preparation_id
    ORDER BY candidate.release_id
  LOOP
    SELECT binding.activation_id INTO resolved_activation
    FROM runtime.activation_content_bindings AS binding
    WHERE binding.project_id = p_project_id
      AND binding.release_id = release_candidate.release_id
      AND binding.activation_content_digest = release_candidate.activation_content_digest;
    IF NOT FOUND THEN
      resolved_activation := release_candidate.activation_id;
      SELECT count(*)::integer INTO expected_rows
      FROM runtime.snapshot_group_cutover_member_candidates AS member
      WHERE member.project_id = p_project_id
        AND member.preparation_id = p_preparation_id
        AND member.release_id = release_candidate.release_id;
      INSERT INTO meta.runtime_activations (
        activation_id, release_id, activation_digest, member_count, state
      ) VALUES (
        resolved_activation, release_candidate.release_id,
        release_candidate.activation_digest, expected_rows, 'ready'
      );
      INSERT INTO meta.runtime_activation_members (
        project_id, release_id, activation_id, member_key, generation_id,
        snapshot_id, snapshot_group_id, group_version, certificate_id
      )
      SELECT member.project_id, member.release_id, resolved_activation,
             member.member_key, member.generation_id, member.snapshot_id,
             member.snapshot_group_id, member.group_version, member.certificate_id
      FROM runtime.snapshot_group_cutover_member_candidates AS member
      WHERE member.project_id = p_project_id
        AND member.preparation_id = p_preparation_id
        AND member.release_id = release_candidate.release_id
      ORDER BY member.member_key COLLATE "C";
      INSERT INTO runtime.activation_content_bindings (
        project_id, release_id, activation_content_digest, activation_id
      ) VALUES (
        p_project_id, release_candidate.release_id,
        release_candidate.activation_content_digest, resolved_activation
      );
      new_activation_count := new_activation_count + 1;
    ELSE
      IF EXISTS (
        (SELECT actual_member.member_key, actual_member.generation_id,
                actual_member.snapshot_id, actual_member.snapshot_group_id,
                actual_member.group_version, actual_member.certificate_id
         FROM meta.runtime_activation_members AS actual_member
         WHERE actual_member.release_id = release_candidate.release_id
           AND actual_member.activation_id = resolved_activation
         EXCEPT
         SELECT expected_member.member_key, expected_member.generation_id,
                expected_member.snapshot_id, expected_member.snapshot_group_id,
                expected_member.group_version, expected_member.certificate_id
         FROM runtime.snapshot_group_cutover_member_candidates AS expected_member
         WHERE expected_member.project_id = p_project_id
           AND expected_member.preparation_id = p_preparation_id
           AND expected_member.release_id = release_candidate.release_id)
        UNION ALL
        (SELECT expected_member.member_key, expected_member.generation_id,
                expected_member.snapshot_id, expected_member.snapshot_group_id,
                expected_member.group_version, expected_member.certificate_id
         FROM runtime.snapshot_group_cutover_member_candidates AS expected_member
         WHERE expected_member.project_id = p_project_id
           AND expected_member.preparation_id = p_preparation_id
           AND expected_member.release_id = release_candidate.release_id
         EXCEPT
         SELECT actual_member.member_key, actual_member.generation_id,
                actual_member.snapshot_id, actual_member.snapshot_group_id,
                actual_member.group_version, actual_member.certificate_id
         FROM meta.runtime_activation_members AS actual_member
         WHERE actual_member.release_id = release_candidate.release_id
           AND actual_member.activation_id = resolved_activation)
      ) THEN
        RAISE EXCEPTION 'G20211_ACTIVATION_CONTENT_COLLISION' USING ERRCODE = '23514';
      END IF;
    END IF;
    UPDATE runtime.snapshot_group_cutover_release_candidates AS resolved_candidate
    SET resolved_activation_id = resolved_activation
    WHERE resolved_candidate.project_id = p_project_id
      AND resolved_candidate.preparation_id = p_preparation_id
      AND resolved_candidate.release_id = release_candidate.release_id;
  END LOOP;
  IF p_fault_point = 'after_activations' THEN
    RAISE EXCEPTION 'G20211_INJECTED_FAILURE:after_activations' USING ERRCODE = 'XX000';
  END IF;

  SELECT count(*) INTO inserted_heads
  FROM runtime.snapshot_group_cutover_head_candidates AS insert_candidate_count
  WHERE insert_candidate_count.project_id = p_project_id
    AND insert_candidate_count.preparation_id = p_preparation_id
    AND insert_candidate_count.disposition = 'insert';
  SELECT count(*) INTO updated_heads
  FROM runtime.snapshot_group_cutover_head_candidates AS changed_candidate_count
  WHERE changed_candidate_count.project_id = p_project_id
    AND changed_candidate_count.preparation_id = p_preparation_id
    AND changed_candidate_count.disposition = 'update';
  SELECT count(*) INTO repointed_heads
  FROM runtime.snapshot_group_cutover_head_candidates AS repoint_candidate_count
  WHERE repoint_candidate_count.project_id = p_project_id
    AND repoint_candidate_count.preparation_id = p_preparation_id
    AND repoint_candidate_count.disposition = 'repoint';

  IF preparation.candidate_head_set_id IS DISTINCT FROM preparation.expected_head_set_id THEN
    IF preparation.expected_head_set_id IS NULL THEN
      INSERT INTO runtime.project_object_head_pointers (
        project_id, head_set_id, control_sequence
      ) VALUES (p_project_id, preparation.candidate_head_set_id, 1)
      ON CONFLICT ON CONSTRAINT project_object_head_pointers_pkey DO NOTHING;
    ELSE
      UPDATE runtime.project_object_head_pointers AS pointer
      SET head_set_id = preparation.candidate_head_set_id,
          control_sequence = pointer.control_sequence + 1,
          changed_at = clock_timestamp()
      WHERE pointer.project_id = p_project_id
        AND pointer.head_set_id = preparation.expected_head_set_id;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'G20211_OBJECT_HEAD_CAS_STALE' USING ERRCODE = '40001';
    END IF;
    UPDATE runtime.object_head_sets AS candidate_set
    SET state = 'active', changed_at = clock_timestamp()
    WHERE candidate_set.project_id = p_project_id
      AND candidate_set.head_set_id = preparation.candidate_head_set_id
      AND candidate_set.state IN ('prepared', 'retired');
    IF preparation.expected_head_set_id IS NOT NULL THEN
      UPDATE runtime.object_head_sets AS old_set
      SET state = 'retired', changed_at = clock_timestamp()
      WHERE old_set.project_id = p_project_id
        AND old_set.head_set_id = preparation.expected_head_set_id
        AND old_set.state = 'active';
    END IF;
    head_pointer_changed := true;
  END IF;

  IF p_fault_point = 'after_heads' THEN
    RAISE EXCEPTION 'G20211_INJECTED_FAILURE:after_heads' USING ERRCODE = 'XX000';
  END IF;

  FOR release_candidate IN
    SELECT * FROM runtime.snapshot_group_cutover_release_candidates AS candidate
    WHERE candidate.project_id = p_project_id
      AND candidate.preparation_id = p_preparation_id
    ORDER BY candidate.release_id
  LOOP
    resolved_activation := release_candidate.resolved_activation_id;
    IF release_candidate.expected_serving_activation_id IS NULL THEN
      UPDATE runtime.snapshot_group_cutover_release_candidates AS committed_candidate
      SET serving_head_moved = false,
          committed_serving_control_sequence = NULL
      WHERE committed_candidate.project_id = p_project_id
        AND committed_candidate.preparation_id = p_preparation_id
        AND committed_candidate.release_id = release_candidate.release_id;
    ELSIF resolved_activation = release_candidate.expected_serving_activation_id THEN
      UPDATE runtime.snapshot_group_cutover_release_candidates AS committed_candidate
      SET serving_head_moved = false,
          committed_serving_control_sequence = expected_serving_control_sequence
      WHERE committed_candidate.project_id = p_project_id
        AND committed_candidate.preparation_id = p_preparation_id
        AND committed_candidate.release_id = release_candidate.release_id;
    ELSE
      UPDATE meta.release_serving_heads AS serving
      SET activation_id = resolved_activation,
          control_sequence = control_sequence + 1,
          changed_at = clock_timestamp()
      WHERE serving.release_id = release_candidate.release_id
        AND serving.activation_id = release_candidate.expected_serving_activation_id
        AND serving.control_sequence = release_candidate.expected_serving_control_sequence;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'G20211_SERVING_HEAD_CAS_STALE' USING ERRCODE = '40001';
      END IF;
      moved_serving_heads := moved_serving_heads + 1;
      UPDATE runtime.snapshot_group_cutover_release_candidates AS committed_candidate
      SET serving_head_moved = true,
          committed_serving_control_sequence = expected_serving_control_sequence + 1
      WHERE committed_candidate.project_id = p_project_id
        AND committed_candidate.preparation_id = p_preparation_id
        AND committed_candidate.release_id = release_candidate.release_id;
    END IF;
  END LOOP;

  IF p_fault_point = 'after_serving_heads' THEN
    RAISE EXCEPTION 'G20211_INJECTED_FAILURE:after_serving_heads' USING ERRCODE = 'XX000';
  END IF;

  FOR release_candidate IN
    SELECT * FROM runtime.snapshot_group_cutover_release_candidates AS candidate
    WHERE candidate.project_id = p_project_id
      AND candidate.preparation_id = p_preparation_id
    ORDER BY candidate.release_id
  LOOP
    resolved_activation := release_candidate.resolved_activation_id;
    IF release_candidate.expected_channel_release_id = release_candidate.release_id
      AND release_candidate.expected_channel_activation_id
        = release_candidate.expected_serving_activation_id
      AND resolved_activation <> release_candidate.expected_channel_activation_id THEN
      UPDATE meta.release_channels AS channel
      SET activation_id = resolved_activation,
          control_sequence = control_sequence + 1,
          changed_at = clock_timestamp()
      WHERE channel.project_id = p_project_id
        AND channel.channel_name = release_candidate.channel_name
        AND channel.release_id = release_candidate.expected_channel_release_id
        AND channel.activation_id = release_candidate.expected_channel_activation_id
        AND channel.control_sequence = release_candidate.expected_channel_control_sequence;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'G20211_CHANNEL_CAS_STALE' USING ERRCODE = '40001';
      END IF;
      moved_channels := moved_channels + 1;
      UPDATE runtime.snapshot_group_cutover_release_candidates AS committed_candidate
      SET channel_moved = true
      WHERE committed_candidate.project_id = p_project_id
        AND committed_candidate.preparation_id = p_preparation_id
        AND committed_candidate.release_id = release_candidate.release_id;
    ELSIF release_candidate.expected_channel_release_id = release_candidate.release_id THEN
      IF NOT (
        (release_candidate.expected_channel_release_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM meta.release_channels AS current_channel
          WHERE current_channel.project_id = p_project_id
            AND current_channel.channel_name = release_candidate.channel_name
        ))
        OR EXISTS (
          SELECT 1 FROM meta.release_channels AS current_channel
          WHERE current_channel.project_id = p_project_id
            AND current_channel.channel_name = release_candidate.channel_name
            AND current_channel.release_id = release_candidate.expected_channel_release_id
            AND current_channel.activation_id = release_candidate.expected_channel_activation_id
            AND current_channel.control_sequence = release_candidate.expected_channel_control_sequence
        )
      ) THEN
        RAISE EXCEPTION 'G20211_CHANNEL_CAS_STALE' USING ERRCODE = '40001';
      END IF;
      UPDATE runtime.snapshot_group_cutover_release_candidates AS committed_candidate
      SET channel_moved = false
      WHERE committed_candidate.project_id = p_project_id
        AND committed_candidate.preparation_id = p_preparation_id
        AND committed_candidate.release_id = release_candidate.release_id;
    ELSE
      -- Several supported Releases can target one Channel. Only the Release
      -- that owned the Channel at preparation time may move or revalidate it;
      -- non-owning candidates are activation-only participants.
      UPDATE runtime.snapshot_group_cutover_release_candidates AS committed_candidate
      SET channel_moved = false
      WHERE committed_candidate.project_id = p_project_id
        AND committed_candidate.preparation_id = p_preparation_id
        AND committed_candidate.release_id = release_candidate.release_id;
    END IF;
  END LOOP;

  IF p_fault_point = 'after_channels' THEN
    RAISE EXCEPTION 'G20211_INJECTED_FAILURE:after_channels' USING ERRCODE = 'XX000';
  END IF;

  UPDATE runtime.generations AS generation
  SET state = 'active', changed_at = clock_timestamp()
  WHERE generation.project_id = p_project_id
    AND generation.state = 'ready'
    AND generation.generation_id IN (
      SELECT DISTINCT member.generation_id
      FROM runtime.snapshot_group_cutover_member_candidates AS member
      WHERE member.project_id = p_project_id
        AND member.preparation_id = p_preparation_id
        AND member.snapshot_group_id = preparation.snapshot_group_id
        AND member.group_version = preparation.group_version
    );
  GET DIAGNOSTICS lifecycle_changes = ROW_COUNT;
  UPDATE runtime.dataset_snapshots AS snapshot
  SET state = 'active', changed_at = clock_timestamp()
  WHERE snapshot.project_id = p_project_id
    AND snapshot.snapshot_group_id = preparation.snapshot_group_id
    AND snapshot.group_version = preparation.group_version
    AND snapshot.state = 'ready';
  GET DIAGNOSTICS actual_rows = ROW_COUNT;
  lifecycle_changes := lifecycle_changes + actual_rows;
  UPDATE runtime.snapshot_group_versions AS group_version_state
  SET state = 'active', changed_at = clock_timestamp()
  WHERE group_version_state.project_id = p_project_id
    AND group_version_state.snapshot_group_id = preparation.snapshot_group_id
    AND group_version_state.group_version = preparation.group_version
    AND group_version_state.state = 'ready';
  GET DIAGNOSTICS actual_rows = ROW_COUNT;
  lifecycle_changes := lifecycle_changes + actual_rows;

  -- Retire only facts that are no longer reachable from any current Serving
  -- Head. Historical Activations remain immutable and resolvable as evidence.
  UPDATE runtime.generations AS old_generation
  SET state = 'retired', changed_at = clock_timestamp()
  WHERE old_generation.project_id = p_project_id
    AND old_generation.snapshot_group_id = preparation.snapshot_group_id
    AND old_generation.group_version <> preparation.group_version
    AND old_generation.state = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM meta.release_serving_heads AS serving
      JOIN meta.runtime_activation_members AS live_member
        ON live_member.release_id = serving.release_id
       AND live_member.activation_id = serving.activation_id
      WHERE live_member.project_id = old_generation.project_id
        AND live_member.generation_id = old_generation.generation_id
    );
  GET DIAGNOSTICS actual_rows = ROW_COUNT;
  lifecycle_changes := lifecycle_changes + actual_rows;
  UPDATE runtime.dataset_snapshots AS old_snapshot
  SET state = 'superseded', changed_at = clock_timestamp()
  WHERE old_snapshot.project_id = p_project_id
    AND old_snapshot.snapshot_group_id = preparation.snapshot_group_id
    AND old_snapshot.group_version <> preparation.group_version
    AND old_snapshot.state = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM meta.release_serving_heads AS serving
      JOIN meta.runtime_activation_members AS live_member
        ON live_member.release_id = serving.release_id
       AND live_member.activation_id = serving.activation_id
      JOIN runtime.generations AS live_generation
        ON live_generation.project_id = live_member.project_id
       AND live_generation.generation_id = live_member.generation_id
      WHERE live_generation.project_id = old_snapshot.project_id
        AND live_generation.snapshot_id = old_snapshot.snapshot_id
    );
  GET DIAGNOSTICS actual_rows = ROW_COUNT;
  lifecycle_changes := lifecycle_changes + actual_rows;
  UPDATE runtime.snapshot_group_versions AS old_group_version
  SET state = 'superseded', changed_at = clock_timestamp()
  WHERE old_group_version.project_id = p_project_id
    AND old_group_version.snapshot_group_id = preparation.snapshot_group_id
    AND old_group_version.group_version <> preparation.group_version
    AND old_group_version.state = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM meta.release_serving_heads AS serving
      JOIN meta.runtime_activation_members AS live_member
        ON live_member.release_id = serving.release_id
       AND live_member.activation_id = serving.activation_id
      WHERE live_member.project_id = old_group_version.project_id
        AND live_member.snapshot_group_id = old_group_version.snapshot_group_id
        AND live_member.group_version = old_group_version.group_version
    );
  GET DIAGNOSTICS actual_rows = ROW_COUNT;
  lifecycle_changes := lifecycle_changes + actual_rows;

  IF p_fault_point = 'after_lifecycle' THEN
    RAISE EXCEPTION 'G20211_INJECTED_FAILURE:after_lifecycle' USING ERRCODE = 'XX000';
  END IF;

  did_change := new_activation_count > 0 OR inserted_heads > 0 OR updated_heads > 0
    OR repointed_heads > 0 OR moved_serving_heads > 0 OR moved_channels > 0
    OR lifecycle_changes > 0 OR head_pointer_changed;
  final_control := current_control;
  final_state := current_state;
  IF moved_serving_heads > 0 OR moved_channels > 0 THEN
    UPDATE meta.projects AS project_control
    SET publication_sequence = publication_sequence + 1,
        changed_at = clock_timestamp()
    WHERE project_control.project_id = p_project_id
      AND project_control.publication_sequence = current_control
    RETURNING project_control.publication_sequence INTO final_control;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'G20211_CUTOVER_CONTROL_STALE' USING ERRCODE = '40001';
    END IF;
  END IF;
  IF did_change THEN
    UPDATE runtime.project_runtime_inventories AS runtime_inventory
    SET state_revision = runtime_inventory.state_revision + 1,
        changed_at = clock_timestamp()
    WHERE runtime_inventory.project_id = p_project_id
      AND runtime_inventory.state_revision = current_state
      AND runtime_inventory.inventory_revision = current_inventory
    RETURNING runtime_inventory.state_revision INTO final_state;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'G20211_CUTOVER_INVENTORY_STALE' USING ERRCODE = '40001';
    END IF;
  END IF;

  IF p_fault_point = 'after_revisions' THEN
    RAISE EXCEPTION 'G20211_INJECTED_FAILURE:after_revisions' USING ERRCODE = 'XX000';
  END IF;

  UPDATE runtime.snapshot_group_cutover_preparations AS committed_preparation
  SET state = 'committed', committed_control_revision = final_control,
      committed_state_revision = final_state,
      committed_inventory_revision = current_inventory,
      committed_changed = did_change,
      created_activation_count = new_activation_count,
      inserted_head_count = inserted_heads,
      updated_head_count = updated_heads,
      repointed_head_count = repointed_heads,
      committed_at = clock_timestamp()
  WHERE committed_preparation.project_id = p_project_id
    AND committed_preparation.preparation_id = p_preparation_id
    AND committed_preparation.state = 'prepared';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'G20211_CUTOVER_PREPARATION_STALE' USING ERRCODE = '40001';
  END IF;

  IF p_fault_point = 'after_result' THEN
    RAISE EXCEPTION 'G20211_INJECTED_FAILURE:after_result' USING ERRCODE = 'XX000';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'releaseId', candidate.release_id::text,
    'activationId', candidate.resolved_activation_id::text,
    'previousActivationId', candidate.expected_serving_activation_id::text,
    'servingHeadMoved', candidate.serving_head_moved,
    'servingHeadControlSequence', candidate.committed_serving_control_sequence::text,
    'channelMoved', candidate.channel_moved
  ) ORDER BY candidate.release_id), '[]'::jsonb)
  INTO release_results
  FROM runtime.snapshot_group_cutover_release_candidates AS candidate
  WHERE candidate.project_id = p_project_id
    AND candidate.preparation_id = p_preparation_id;

  RETURN QUERY SELECT p_preparation_id, p_project_id,
    preparation.snapshot_group_id, preparation.group_version,
    final_control, final_state, current_inventory, did_change, false,
    new_activation_count, inserted_heads, updated_heads, repointed_heads,
    release_results;
END
$commit_snapshot_group_cutover$;

CREATE FUNCTION runtime.commit_snapshot_group_cutover(
  p_project_id uuid,
  p_preparation_id uuid,
  p_overlay_provider_id text,
  p_overlay_provider_version text,
  p_overlay_watermark bigint,
  p_overlay_delta_count bigint,
  p_overlay_evidence_digest text
) RETURNS TABLE (
  preparation_id uuid,
  project_id uuid,
  snapshot_group_id uuid,
  group_version bigint,
  control_revision bigint,
  state_revision bigint,
  inventory_revision bigint,
  changed boolean,
  reused boolean,
  created_activation_count integer,
  inserted_head_count bigint,
  updated_head_count bigint,
  repointed_head_count bigint,
  releases jsonb
)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog
AS $commit_snapshot_group_cutover_public$
  SELECT * FROM ontos_migration.g20211_commit_snapshot_group_cutover(
    p_project_id, p_preparation_id, p_overlay_provider_id,
    p_overlay_provider_version, p_overlay_watermark, p_overlay_delta_count,
    p_overlay_evidence_digest, NULL
  )
$commit_snapshot_group_cutover_public$;

REVOKE ALL PRIVILEGES ON TABLE
  runtime.snapshot_group_cutover_preparations,
  runtime.snapshot_group_cutover_release_candidates,
  runtime.snapshot_group_cutover_member_candidates,
  runtime.snapshot_group_cutover_head_candidates,
  runtime.snapshot_group_cutover_object_type_locks,
  runtime.object_head_sets,
  runtime.object_head_versions,
  runtime.project_object_head_pointers,
  runtime.object_heads,
  runtime.activation_content_bindings
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON FUNCTION
  runtime.prepare_snapshot_group_cutover(
    uuid, uuid, bigint, bigint, text, text, text, bigint, bigint, text
  ),
  runtime.commit_snapshot_group_cutover(
    uuid, uuid, text, text, bigint, bigint, text
  ),
  ontos_migration.g20211_commit_snapshot_group_cutover(
    uuid, uuid, text, text, bigint, bigint, text, text
  ),
  ontos_migration.g20211_activation_content_digest(uuid, uuid, text, jsonb),
  ontos_migration.g20211_candidate_members_json(uuid, uuid, uuid),
  ontos_migration.g20211_candidate_activation_digest(uuid, uuid, uuid, uuid, text),
  ontos_migration.g20211_semantic_head_digest(text, text, text)
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT SELECT ON TABLE
  runtime.snapshot_group_cutover_preparations,
  runtime.snapshot_group_cutover_release_candidates
TO api_runtime;
GRANT EXECUTE ON FUNCTION
  runtime.prepare_snapshot_group_cutover(
    uuid, uuid, bigint, bigint, text, text, text, bigint, bigint, text
  ),
  runtime.commit_snapshot_group_cutover(
    uuid, uuid, text, text, bigint, bigint, text
  )
TO api_runtime;
