SET LOCAL ROLE migration_owner;

-- Runtime authorization must not assemble Epoch, Principal/Delegation roles,
-- Service capability and Policy Compilation from independent transactions.
-- This resolver returns the complete bounded input from one caller snapshot.
CREATE FUNCTION authz.resolve_policy_gateway_snapshot(
  p_project_id uuid,
  p_principal_ids uuid[],
  p_resource_id uuid,
  p_permission text,
  p_release_id uuid,
  p_policy_revision_id uuid,
  p_compiler_version text
) RETURNS TABLE (
  observed_database_at text,
  authorization_epoch bigint,
  resource_revision_id uuid,
  policy_resource_id uuid,
  policy_compilation_id uuid,
  artifact_digest text,
  principal_ordinality integer,
  principal_id uuid,
  identity_type text,
  principal_state text,
  project_role text,
  resource_role text,
  resource_binding_present boolean,
  service_profile_state text,
  service_capabilities text[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $resolve_policy_gateway_snapshot$
BEGIN
  IF p_project_id IS NULL
    OR p_principal_ids IS NULL
    OR cardinality(p_principal_ids) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1
      FROM unnest(p_principal_ids) AS requested(principal_id)
      WHERE requested.principal_id IS NULL
    )
    OR (
      SELECT count(*) <> count(DISTINCT requested.principal_id)
      FROM unnest(p_principal_ids) AS requested(principal_id)
    )
    OR p_resource_id IS NULL
    OR p_permission IS DISTINCT FROM 'object.read'
    OR p_release_id IS NULL
    OR p_policy_revision_id IS NULL
    OR p_compiler_version IS DISTINCT FROM 'policy-compiler-g2-03-05-v1' THEN
    RAISE EXCEPTION 'G20306_POLICY_GATEWAY_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('ontos.project_id', p_project_id::text, true);
  RETURN QUERY
    WITH requested_principal AS MATERIALIZED (
      SELECT requested.principal_id, requested.ordinality::integer AS ordinality
      FROM unnest(p_principal_ids) WITH ORDINALITY AS requested(principal_id, ordinality)
    ), gateway_context AS MATERIALIZED (
      SELECT to_char(
               transaction_timestamp() AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ) AS observed_database_at,
             epoch.epoch AS authorization_epoch,
             target_pin.revision_id AS resource_revision_id,
             policy_pin.resource_id AS policy_resource_id,
             compilation.policy_compilation_id,
             compilation.artifact_digest::text
      FROM meta.projects AS project
      JOIN authz.authorization_epochs AS epoch
        ON epoch.project_id = project.project_id
      JOIN meta.resources AS target_resource
        ON target_resource.project_id = project.project_id
       AND target_resource.resource_id = p_resource_id
      JOIN meta.releases AS release
        ON release.project_id = project.project_id
       AND release.release_id = p_release_id
      JOIN meta.release_pins AS target_pin
        ON target_pin.release_id = release.release_id
       AND target_pin.resource_id = target_resource.resource_id
       AND target_pin.family = 'object_type'
      JOIN meta.resource_revisions AS target_revision
        ON target_revision.resource_id = target_pin.resource_id
       AND target_revision.revision_id = target_pin.revision_id
       AND target_revision.family = 'object_type'
      JOIN meta.release_pins AS policy_pin
        ON policy_pin.release_id = release.release_id
       AND policy_pin.revision_id = p_policy_revision_id
       AND policy_pin.family = 'policy'
      JOIN meta.resource_revisions AS policy_revision
        ON policy_revision.resource_id = policy_pin.resource_id
       AND policy_revision.revision_id = policy_pin.revision_id
       AND policy_revision.family = 'policy'
      JOIN authz.policy_compilations AS compilation
        ON compilation.project_id = project.project_id
       AND compilation.release_id = release.release_id
       AND compilation.policy_resource_id = policy_pin.resource_id
       AND compilation.policy_revision_id = policy_pin.revision_id
       AND compilation.policy_content_digest = policy_revision.content_digest
       AND compilation.compiler_version = p_compiler_version
       AND compilation.status = 'passed'
      WHERE project.project_id = p_project_id
        AND project.state = 'active'
        AND target_resource.state IN ('active', 'deprecated')
        AND target_revision.state IN ('published', 'deprecated')
        AND policy_revision.state IN ('published', 'deprecated')
        AND release.state IN ('published', 'superseded')
        AND EXISTS (
          SELECT 1
          FROM meta.resource_dependencies AS target_dependency
          WHERE target_dependency.source_revision_id = policy_pin.revision_id
            AND target_dependency.target_revision_id = target_pin.revision_id
            AND target_dependency.dependency_type IN (
              'policy_object_target', 'policy_property_target'
            )
            AND target_dependency.source_path ~
              '^/rules/[0-9]+/target/resourceRevisionId$'
        )
    )
    SELECT context.observed_database_at,
           context.authorization_epoch,
           context.resource_revision_id,
           context.policy_resource_id,
           context.policy_compilation_id,
           context.artifact_digest,
           requested.ordinality,
           requested.principal_id,
           principal.identity_type,
           principal.state,
           project_binding.role,
           resource_binding.role,
           resource_binding.binding_id IS NOT NULL,
           service_profile.state,
           service_profile.capabilities
    FROM gateway_context AS context
    CROSS JOIN requested_principal AS requested
    LEFT JOIN authz.principals AS principal
      ON principal.principal_id = requested.principal_id
    LEFT JOIN LATERAL (
      SELECT binding.binding_id, binding.role
      FROM authz.role_bindings AS binding
      WHERE binding.project_id = p_project_id
        AND binding.principal_id = requested.principal_id
        AND binding.scope = 'project'
        AND binding.state = 'active'
    ) AS project_binding ON true
    LEFT JOIN LATERAL (
      SELECT binding.binding_id, binding.role
      FROM authz.role_bindings AS binding
      WHERE binding.project_id = p_project_id
        AND binding.principal_id = requested.principal_id
        AND binding.scope = 'resource'
        AND binding.resource_id = p_resource_id
        AND binding.state = 'active'
    ) AS resource_binding ON true
    LEFT JOIN authz.service_identity_profiles AS service_profile
      ON service_profile.project_id = p_project_id
     AND service_profile.principal_id = requested.principal_id
    ORDER BY requested.ordinality;
END
$resolve_policy_gateway_snapshot$;

REVOKE ALL PRIVILEGES ON FUNCTION authz.resolve_policy_gateway_snapshot(
  uuid, uuid[], uuid, text, uuid, uuid, text
) FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT EXECUTE ON FUNCTION authz.resolve_policy_gateway_snapshot(
  uuid, uuid[], uuid, text, uuid, uuid, text
) TO api_runtime;

COMMENT ON FUNCTION authz.resolve_policy_gateway_snapshot(
  uuid, uuid[], uuid, text, uuid, uuid, text
) IS
  'Only api_runtime Policy Gateway snapshot: bounded Principal/Role/Service/Epoch and exact directly-targeted Published Policy Compilation facts from one MVCC snapshot.';
