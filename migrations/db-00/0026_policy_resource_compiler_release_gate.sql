SET LOCAL ROLE migration_owner;

-- A Policy can reference the same immutable target from multiple Rules.  The
-- source JSON Pointer is part of the dependency identity, so every exact
-- reference remains reproducible instead of being collapsed into one edge.
ALTER TABLE meta.resource_dependencies
  DROP CONSTRAINT resource_dependencies_edge_uq,
  ADD CONSTRAINT resource_dependencies_edge_uq UNIQUE (
    source_revision_id, target_revision_id, dependency_type, source_path
  );

CREATE FUNCTION ontos_migration.g20305_policy_predicate_dependencies(
  p_predicate jsonb,
  p_path text
) RETURNS TABLE (
  dependency_type text,
  target_resource_id uuid,
  target_revision_id uuid,
  source_path text
)
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $g20305_policy_predicate_dependencies$
DECLARE
  child record;
BEGIN
  IF p_predicate ->> 'kind' = 'link_exists' THEN
    RETURN QUERY SELECT
      'policy_link_target'::text,
      (p_predicate ->> 'linkTypeResourceId')::uuid,
      (p_predicate ->> 'linkTypeRevisionId')::uuid,
      p_path || '/linkTypeRevisionId';
    RETURN QUERY SELECT
      'policy_object_target'::text,
      (p_predicate ->> 'targetObjectTypeResourceId')::uuid,
      (p_predicate ->> 'targetObjectTypeRevisionId')::uuid,
      p_path || '/targetObjectTypeRevisionId';
    RETURN QUERY SELECT *
      FROM ontos_migration.g20305_policy_predicate_dependencies(
        p_predicate -> 'predicate', p_path || '/predicate'
      );
  ELSIF p_predicate ->> 'kind' IN ('all', 'any') THEN
    FOR child IN
      SELECT value, ordinality
      FROM jsonb_array_elements(p_predicate -> 'predicates') WITH ORDINALITY
    LOOP
      RETURN QUERY SELECT *
        FROM ontos_migration.g20305_policy_predicate_dependencies(
          child.value,
          p_path || '/predicates/' || (child.ordinality - 1)::text
        );
    END LOOP;
  ELSIF p_predicate ->> 'kind' = 'not' THEN
    RETURN QUERY SELECT *
      FROM ontos_migration.g20305_policy_predicate_dependencies(
        p_predicate -> 'predicate', p_path || '/predicate'
      );
  END IF;
END
$g20305_policy_predicate_dependencies$;

CREATE FUNCTION ontos_migration.g20305_policy_expected_dependencies(
  p_content jsonb
) RETURNS TABLE (
  dependency_type text,
  target_resource_id uuid,
  target_revision_id uuid,
  source_path text
)
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $g20305_policy_expected_dependencies$
DECLARE
  item record;
  target jsonb;
  target_kind text;
  base_path text;
BEGIN
  FOR item IN
    SELECT value, ordinality
    FROM jsonb_array_elements(p_content -> 'rules') WITH ORDINALITY
  LOOP
    target := item.value -> 'target';
    target_kind := target ->> 'kind';
    base_path := '/rules/' || (item.ordinality - 1)::text;
    IF target_kind = 'object' THEN
      RETURN QUERY SELECT
        'policy_object_target'::text,
        (target ->> 'resourceId')::uuid,
        (target ->> 'resourceRevisionId')::uuid,
        base_path || '/target/resourceRevisionId';
    ELSIF target_kind = 'property' THEN
      RETURN QUERY SELECT
        'policy_property_target'::text,
        (target ->> 'resourceId')::uuid,
        (target ->> 'resourceRevisionId')::uuid,
        base_path || '/target/resourceRevisionId';
    ELSIF target_kind = 'link' THEN
      RETURN QUERY SELECT
        'policy_link_target'::text,
        (target ->> 'resourceId')::uuid,
        (target ->> 'resourceRevisionId')::uuid,
        base_path || '/target/resourceRevisionId';
    ELSIF target_kind = 'action_target' THEN
      RETURN QUERY SELECT
        'policy_action_target'::text,
        (target ->> 'resourceId')::uuid,
        (target ->> 'resourceRevisionId')::uuid,
        base_path || '/target/resourceRevisionId';
      RETURN QUERY SELECT
        'policy_object_target'::text,
        (target ->> 'targetObjectTypeResourceId')::uuid,
        (target ->> 'targetObjectTypeRevisionId')::uuid,
        base_path || '/target/targetObjectTypeRevisionId';
    ELSE
      RAISE EXCEPTION 'G20305_POLICY_TARGET_KIND_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN QUERY SELECT *
      FROM ontos_migration.g20305_policy_predicate_dependencies(
        item.value -> 'predicate', base_path || '/predicate'
      );
  END LOOP;
  FOR item IN
    SELECT value, ordinality
    FROM jsonb_array_elements(p_content -> 'testVectors') WITH ORDINALITY
  LOOP
    target := item.value -> 'target';
    target_kind := target ->> 'kind';
    base_path := '/testVectors/' || (item.ordinality - 1)::text || '/target';
    IF target_kind = 'object' THEN
      RETURN QUERY SELECT 'policy_object_target'::text,
        (target ->> 'resourceId')::uuid, (target ->> 'resourceRevisionId')::uuid,
        base_path || '/resourceRevisionId';
    ELSIF target_kind = 'property' THEN
      RETURN QUERY SELECT 'policy_property_target'::text,
        (target ->> 'resourceId')::uuid, (target ->> 'resourceRevisionId')::uuid,
        base_path || '/resourceRevisionId';
    ELSIF target_kind = 'link' THEN
      RETURN QUERY SELECT 'policy_link_target'::text,
        (target ->> 'resourceId')::uuid, (target ->> 'resourceRevisionId')::uuid,
        base_path || '/resourceRevisionId';
    ELSIF target_kind = 'action_target' THEN
      RETURN QUERY SELECT 'policy_action_target'::text,
        (target ->> 'resourceId')::uuid, (target ->> 'resourceRevisionId')::uuid,
        base_path || '/resourceRevisionId';
      RETURN QUERY SELECT 'policy_object_target'::text,
        (target ->> 'targetObjectTypeResourceId')::uuid,
        (target ->> 'targetObjectTypeRevisionId')::uuid,
        base_path || '/targetObjectTypeRevisionId';
    ELSE
      RAISE EXCEPTION 'G20305_POLICY_TARGET_KIND_INVALID' USING ERRCODE = '23514';
    END IF;
  END LOOP;
END
$g20305_policy_expected_dependencies$;

-- Extend the G2-01 insert guard itself.  Opening the dependency_type CHECK is
-- insufficient: every persisted Policy edge must also match the exact JSON
-- Pointer, Resource identity, Revision identity and expected target Family.
CREATE OR REPLACE FUNCTION ontos_migration.g20106_enforce_dependency_content() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20106_dependency_content$
DECLARE
  source_family text;
  source_content jsonb;
  source_project_id uuid;
  target_family text;
  target_state text;
  actual_target_resource_id uuid;
  target_resource_state text;
  target_project_id uuid;
  expected_target text;
  expected_path text;
BEGIN
  SELECT source.family, source.content, source_resource.project_id
  INTO source_family, source_content, source_project_id
  FROM meta.resource_revisions AS source
  JOIN meta.resources AS source_resource
    ON source_resource.resource_id = source.resource_id
  WHERE source.revision_id = NEW.source_revision_id;

  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT target.family, target.state, target.resource_id,
         target_resource.state, target_resource.project_id
  INTO target_family, target_state, actual_target_resource_id,
       target_resource_state, target_project_id
  FROM meta.resource_revisions AS target
  JOIN meta.resources AS target_resource
    ON target_resource.resource_id = target.resource_id
  WHERE target.revision_id = NEW.target_revision_id
  FOR KEY SHARE OF target, target_resource;

  IF NOT FOUND THEN RETURN NEW; END IF;
  IF source_project_id <> target_project_id THEN
    RAISE EXCEPTION 'G20106_DEPENDENCY_CROSS_PROJECT' USING ERRCODE = '23514';
  END IF;
  IF target_resource_state = 'archived' OR target_state = 'archived' THEN
    RAISE EXCEPTION 'G20106_DEPENDENCY_ARCHIVED' USING ERRCODE = '55000';
  END IF;
  IF target_state NOT IN ('validated', 'published', 'deprecated') THEN
    RAISE EXCEPTION 'G20106_DEPENDENCY_NOT_VALIDATED' USING ERRCODE = '55000';
  END IF;

  IF source_family = 'link_type' THEN
    IF target_family <> 'object_type' THEN
      RAISE EXCEPTION 'G20106_DEPENDENCY_FAMILY_INVALID' USING ERRCODE = '23514';
    END IF;
    IF NEW.dependency_type = 'link_source' THEN
      expected_target := source_content #>> '{source,objectTypeRevisionId}';
      expected_path := '/source/objectTypeRevisionId';
    ELSIF NEW.dependency_type = 'link_target' THEN
      expected_target := source_content #>> '{target,objectTypeRevisionId}';
      expected_path := '/target/objectTypeRevisionId';
    ELSE
      RAISE EXCEPTION 'G20106_DEPENDENCY_TYPE_NOT_ACTIVE' USING ERRCODE = '55000';
    END IF;
    IF expected_target IS NULL
      OR expected_target::uuid <> NEW.target_revision_id
      OR expected_path <> NEW.source_path THEN
      RAISE EXCEPTION 'G20106_DEPENDENCY_CONTENT_MISMATCH' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF source_family = 'policy' THEN
    IF (NEW.dependency_type IN ('policy_object_target', 'policy_property_target')
        AND target_family <> 'object_type')
      OR (NEW.dependency_type = 'policy_link_target' AND target_family <> 'link_type')
      OR (NEW.dependency_type = 'policy_action_target' AND target_family <> 'action_type')
      OR NEW.dependency_type NOT IN (
        'policy_object_target', 'policy_property_target',
        'policy_link_target', 'policy_action_target'
      ) THEN
      RAISE EXCEPTION 'G20106_DEPENDENCY_FAMILY_INVALID' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM ontos_migration.g20305_policy_expected_dependencies(source_content) AS expected
      WHERE expected.dependency_type = NEW.dependency_type
        AND expected.target_resource_id = actual_target_resource_id
        AND expected.target_revision_id = NEW.target_revision_id
        AND expected.source_path = NEW.source_path
    ) THEN
      RAISE EXCEPTION 'G20106_DEPENDENCY_CONTENT_MISMATCH' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'G20106_DEPENDENCY_FAMILY_INVALID' USING ERRCODE = '23514';
END
$g20106_dependency_content$;

CREATE OR REPLACE FUNCTION ontos_migration.g20106_enforce_revision_validation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20106_revision_validation$
DECLARE
  dependency_count integer;
  source_target uuid;
  target_target uuid;
  required_validator text;
BEGIN
  IF OLD.state <> 'draft' OR NEW.state <> 'validated' THEN RETURN NEW; END IF;

  IF NEW.family = 'policy' THEN
    required_validator := 'policy-g2-03-v1';
  ELSIF NEW.family IN ('object_type', 'link_type', 'snapshot_schema', 'mapping') THEN
    required_validator := 'metadata-g2-01-v1';
  ELSE
    RAISE EXCEPTION 'G20106_VALIDATOR_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM meta.validation_reports AS report
    WHERE report.subject_type = 'resource_revision'
      AND report.resource_revision_id = OLD.revision_id
      AND report.subject_digest = OLD.content_digest
      AND report.validator_version = required_validator
      AND report.valid = TRUE
  ) THEN
    RAISE EXCEPTION 'G20106_VALID_REPORT_REQUIRED' USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)::integer INTO dependency_count
  FROM meta.resource_dependencies
  WHERE source_revision_id = OLD.revision_id;

  IF NEW.family = 'policy' THEN
    IF dependency_count = 0 OR EXISTS (
      WITH expected AS (
        SELECT * FROM ontos_migration.g20305_policy_expected_dependencies(NEW.content)
      ), actual AS (
        SELECT dependency.dependency_type,
               target.resource_id AS target_resource_id,
               dependency.target_revision_id,
               dependency.source_path
        FROM meta.resource_dependencies AS dependency
        JOIN meta.resource_revisions AS target
          ON target.revision_id = dependency.target_revision_id
        WHERE dependency.source_revision_id = OLD.revision_id
      ), difference AS (
        (SELECT * FROM expected EXCEPT SELECT * FROM actual)
        UNION ALL
        (SELECT * FROM actual EXCEPT SELECT * FROM expected)
      )
      SELECT 1 FROM difference
    ) THEN
      RAISE EXCEPTION 'G20305_POLICY_DEPENDENCY_SET_INCOMPLETE' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM meta.resource_dependencies AS dependency
      JOIN meta.resource_revisions AS target_revision
        ON target_revision.revision_id = dependency.target_revision_id
      JOIN meta.resources AS target_resource
        ON target_resource.resource_id = target_revision.resource_id
      JOIN meta.resources AS policy_resource
        ON policy_resource.resource_id = NEW.resource_id
      WHERE dependency.source_revision_id = OLD.revision_id
        AND (
          target_resource.project_id <> policy_resource.project_id
          OR target_resource.state = 'archived'
          OR target_revision.state NOT IN ('validated', 'published', 'deprecated')
          OR (dependency.dependency_type IN ('policy_object_target', 'policy_property_target')
              AND target_revision.family <> 'object_type')
          OR (dependency.dependency_type = 'policy_link_target'
              AND target_revision.family <> 'link_type')
          OR (dependency.dependency_type = 'policy_action_target'
              AND target_revision.family <> 'action_type')
        )
    ) THEN
      RAISE EXCEPTION 'G20305_POLICY_TARGET_UNAVAILABLE' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  SELECT target_revision_id INTO source_target
  FROM meta.resource_dependencies
  WHERE source_revision_id = OLD.revision_id AND dependency_type = 'link_source';
  SELECT target_revision_id INTO target_target
  FROM meta.resource_dependencies
  WHERE source_revision_id = OLD.revision_id AND dependency_type = 'link_target';

  IF NEW.family IN ('object_type', 'snapshot_schema', 'mapping') THEN
    IF dependency_count <> 0 THEN
      RAISE EXCEPTION 'G20106_RESOURCE_DEPENDENCIES_FORBIDDEN' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF dependency_count <> 2
      OR source_target IS DISTINCT FROM (NEW.content #>> '{source,objectTypeRevisionId}')::uuid
      OR target_target IS DISTINCT FROM (NEW.content #>> '{target,objectTypeRevisionId}')::uuid
      OR NOT EXISTS (
        SELECT 1 FROM meta.resource_dependencies
        WHERE source_revision_id = OLD.revision_id
          AND dependency_type = 'link_source'
          AND source_path = '/source/objectTypeRevisionId'
      )
      OR NOT EXISTS (
        SELECT 1 FROM meta.resource_dependencies
        WHERE source_revision_id = OLD.revision_id
          AND dependency_type = 'link_target'
          AND source_path = '/target/objectTypeRevisionId'
      ) THEN
      RAISE EXCEPTION 'G20106_DEPENDENCY_SET_INCOMPLETE' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$g20106_revision_validation$;

CREATE FUNCTION authz.resolve_policy_actor_attribute_schema(
  p_project_id uuid
) RETURNS TABLE(attribute_name text, value_type text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $resolve_policy_actor_attribute_schema$
BEGIN
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  IF EXISTS (
    WITH attributes AS (
      SELECT item ->> 'attribute' AS attribute_name,
             item ->> 'valueType' AS value_type
      FROM authz.claim_mapping_heads AS head
      JOIN authz.claim_mapping_revisions AS revision
        ON revision.project_id = head.project_id
       AND revision.oidc_issuer = head.oidc_issuer
       AND revision.identity_type = head.identity_type
       AND revision.claim_mapping_revision_id = head.claim_mapping_revision_id
      CROSS JOIN LATERAL jsonb_array_elements(revision.mapping -> 'attributes') AS item
      WHERE head.project_id = p_project_id
    )
    SELECT 1 FROM attributes
    GROUP BY attributes.attribute_name
    HAVING COUNT(DISTINCT attributes.value_type) <> 1
  ) THEN
    RAISE EXCEPTION 'G20305_ACTOR_ATTRIBUTE_SCHEMA_CONFLICT' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY
    WITH attributes AS (
      SELECT item ->> 'attribute' AS mapped_attribute_name,
             item ->> 'valueType' AS mapped_value_type
      FROM authz.claim_mapping_heads AS head
      JOIN authz.claim_mapping_revisions AS revision
        ON revision.project_id = head.project_id
       AND revision.oidc_issuer = head.oidc_issuer
       AND revision.identity_type = head.identity_type
       AND revision.claim_mapping_revision_id = head.claim_mapping_revision_id
      CROSS JOIN LATERAL jsonb_array_elements(revision.mapping -> 'attributes') AS item
      WHERE head.project_id = p_project_id
    )
    SELECT attributes.mapped_attribute_name,
           MIN(attributes.mapped_value_type)
    FROM attributes
    GROUP BY attributes.mapped_attribute_name
    ORDER BY attributes.mapped_attribute_name COLLATE "C";
END
$resolve_policy_actor_attribute_schema$;

CREATE FUNCTION authz.resolve_release_policy_compilations(
  p_project_id uuid,
  p_release_id uuid
) RETURNS TABLE (
  policy_revision_id uuid,
  policy_compilation_id uuid,
  policy_content_digest text,
  compiler_version text,
  artifact_digest text,
  test_report_digest text,
  test_vector_count integer,
  passed_vector_count integer,
  failed_vector_count integer,
  status text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $resolve_release_policy_compilations$
BEGIN
  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  RETURN QUERY
    SELECT compilation.policy_revision_id,
           compilation.policy_compilation_id,
           compilation.policy_content_digest::text,
           compilation.compiler_version::text,
           compilation.artifact_digest::text,
           compilation.test_report_digest::text,
           compilation.test_vector_count,
           compilation.passed_vector_count,
           compilation.failed_vector_count,
           compilation.status
    FROM authz.policy_compilations AS compilation
    WHERE compilation.project_id = p_project_id
      AND compilation.release_id = p_release_id
      AND compilation.compiler_version = 'policy-compiler-g2-03-05-v1';
END
$resolve_release_policy_compilations$;

CREATE OR REPLACE FUNCTION ontos_migration.g20303_enforce_policy_compilation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20303_policy_compilation$
DECLARE
  revision_family text;
  revision_digest text;
  revision_content jsonb;
  release_state text;
  artifact_source_kind text;
  artifact_source_id uuid;
  report_source_kind text;
  report_source_id uuid;
BEGIN
  SELECT revision.family, revision.content_digest, revision.content
    INTO revision_family, revision_digest, revision_content
  FROM meta.resource_revisions AS revision
  WHERE revision.resource_id = NEW.policy_resource_id
    AND revision.revision_id = NEW.policy_revision_id;
  IF revision_family IS DISTINCT FROM 'policy'
    OR revision_digest IS DISTINCT FROM NEW.policy_content_digest
    OR NEW.compiler_version IS DISTINCT FROM 'policy-compiler-g2-03-05-v1'
    OR NEW.test_vector_count IS DISTINCT FROM jsonb_array_length(revision_content -> 'testVectors') THEN
    RAISE EXCEPTION 'G20305_POLICY_COMPILATION_BINDING_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT release.state INTO release_state
  FROM meta.releases AS release
  WHERE release.project_id = NEW.project_id
    AND release.release_id = NEW.release_id;
  IF release_state NOT IN ('draft', 'staging') OR EXISTS (
    SELECT 1
    FROM meta.resource_dependencies AS dependency
    WHERE dependency.source_revision_id = NEW.policy_revision_id
      AND NOT EXISTS (
        SELECT 1 FROM meta.release_pins AS target_pin
        WHERE target_pin.release_id = NEW.release_id
          AND target_pin.revision_id = dependency.target_revision_id
      )
  ) THEN
    RAISE EXCEPTION 'G20305_POLICY_RELEASE_CLOSURE_INVALID' USING ERRCODE = '55000';
  END IF;

  SELECT reference.source_kind, reference.source_id
    INTO artifact_source_kind, artifact_source_id
  FROM meta.artifact_references AS reference
  WHERE reference.artifact_reference_id = NEW.artifact_reference_id
    AND reference.digest = NEW.artifact_digest;
  SELECT reference.source_kind, reference.source_id
    INTO report_source_kind, report_source_id
  FROM meta.artifact_references AS reference
  WHERE reference.artifact_reference_id = NEW.test_report_reference_id
    AND reference.digest = NEW.test_report_digest;
  IF artifact_source_kind IS DISTINCT FROM 'policy_compilation'
    OR artifact_source_id IS DISTINCT FROM NEW.policy_compilation_id
    OR report_source_kind IS DISTINCT FROM 'policy_test_report'
    OR report_source_id IS DISTINCT FROM NEW.policy_compilation_id THEN
    RAISE EXCEPTION 'G20303_POLICY_ARTIFACT_SOURCE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$g20303_policy_compilation$;

CREATE FUNCTION ontos_migration.g20305_enforce_release_policy_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20305_release_policy_gate$
BEGIN
  IF NEW.state NOT IN ('staging', 'ready', 'published') THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1
    FROM meta.release_pins AS pin
    JOIN meta.resource_revisions AS revision
      ON revision.resource_id = pin.resource_id
     AND revision.revision_id = pin.revision_id
    WHERE pin.release_id = NEW.release_id
      AND pin.family = 'policy'
      AND NOT EXISTS (
        SELECT 1
        FROM authz.policy_compilations AS compilation
        WHERE compilation.project_id = NEW.project_id
          AND compilation.release_id = NEW.release_id
          AND compilation.policy_resource_id = pin.resource_id
          AND compilation.policy_revision_id = pin.revision_id
          AND compilation.policy_content_digest = revision.content_digest
          AND compilation.compiler_version = 'policy-compiler-g2-03-05-v1'
          AND compilation.status = 'passed'
          AND compilation.failed_vector_count = 0
          AND compilation.passed_vector_count = compilation.test_vector_count
      )
  ) THEN
    RAISE EXCEPTION 'G20305_POLICY_COMPILATION_REQUIRED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20305_release_policy_gate$;

CREATE TRIGGER releases_policy_compilation_gate
BEFORE UPDATE OF state ON meta.releases
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20305_enforce_release_policy_gate();

REVOKE ALL PRIVILEGES ON FUNCTION
  authz.resolve_policy_actor_attribute_schema(uuid),
  authz.resolve_release_policy_compilations(uuid, uuid),
  ontos_migration.g20305_policy_predicate_dependencies(jsonb, text),
  ontos_migration.g20305_policy_expected_dependencies(jsonb),
  ontos_migration.g20305_enforce_release_policy_gate()
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

-- The browser-facing API may validate and publish only server-recorded facts.
-- Compilation output is written by the trusted Worker/Compiler identity so a
-- caller with API credentials cannot submit a forged "passed" boolean.
REVOKE EXECUTE ON FUNCTION authz.record_policy_compilation(
  uuid, uuid, uuid, uuid, uuid, text, text, uuid, text, uuid, text,
  integer, integer, integer, text
) FROM api_runtime;

GRANT EXECUTE ON FUNCTION authz.resolve_release_policy_compilations(uuid, uuid)
TO api_runtime;
GRANT EXECUTE ON FUNCTION
  authz.resolve_policy_actor_attribute_schema(uuid),
  authz.record_policy_compilation(
    uuid, uuid, uuid, uuid, uuid, text, text, uuid, text, uuid, text,
    integer, integer, integer, text
  )
TO worker_runtime;

COMMENT ON FUNCTION authz.resolve_policy_actor_attribute_schema(uuid) IS
  'Returns only the bounded active Claim Mapping attribute names/types needed by the Policy Compiler; no Issuer, Subject, Claim name or value is exposed.';
COMMENT ON FUNCTION authz.record_policy_compilation(
  uuid, uuid, uuid, uuid, uuid, text, text, uuid, text, uuid, text,
  integer, integer, integer, text
) IS
  'Trusted Worker/Compiler-only append path; api_runtime can consume but cannot forge Policy compilation results.';
COMMENT ON FUNCTION ontos_migration.g20305_policy_expected_dependencies(jsonb) IS
  'Database backstop that reproduces exact Policy Rule and one-hop Link dependency identities from strict Policy JSON.';
