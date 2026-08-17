SET LOCAL ROLE migration_owner;

-- runtime.object_heads is intentionally a security-barrier view. During a
-- refresh, object_current rows are created in the same transaction and are not
-- represented in planner statistics yet. PostgreSQL can therefore estimate a
-- single current row and rescan the complete active Head Set once per object.
-- Keep the security boundary and constrain only the two controlled build
-- functions that join the view to same-transaction rows. The setting is
-- restored automatically when each function returns.
ALTER FUNCTION ops.prepare_materialization_staging_current(
  uuid, uuid, uuid, bigint, uuid, jsonb
) SET enable_nestloop = off;

ALTER FUNCTION runtime.prepare_snapshot_group_cutover(
  uuid, uuid, bigint, bigint, text, text, text, bigint, bigint, text
) SET enable_nestloop = off;
