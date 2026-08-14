SET LOCAL ROLE migration_owner;

CREATE FUNCTION ontos_migration.g20105_enforce_revision_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20105_revision_insert$
DECLARE
  resource_family text;
  resource_state text;
  parent_number bigint;
  parent_state text;
BEGIN
  SELECT resource.family, resource.state
  INTO resource_family, resource_state
  FROM meta.resources AS resource
  WHERE resource.resource_id = NEW.resource_id
  FOR UPDATE;

  -- Let the declared FK produce the stable missing-parent/resource violation.
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF NEW.family <> resource_family THEN
    RAISE EXCEPTION 'G20105_REVISION_FAMILY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF resource_state <> 'active' THEN
    RAISE EXCEPTION 'G20105_RESOURCE_NOT_EDITABLE' USING ERRCODE = '55000';
  END IF;

  IF NEW.parent_revision_id IS NULL THEN
    IF NEW.revision_number <> 1 THEN
      RAISE EXCEPTION 'G20105_ROOT_REVISION_NUMBER_INVALID' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT parent.revision_number, parent.state
    INTO parent_number, parent_state
    FROM meta.resource_revisions AS parent
    WHERE parent.resource_id = NEW.resource_id
      AND parent.revision_id = NEW.parent_revision_id
    FOR UPDATE;

    -- The composite FK remains the source of truth for a missing/cross-resource parent.
    IF FOUND THEN
      IF parent_state NOT IN ('validated', 'published', 'deprecated') THEN
        RAISE EXCEPTION 'G20105_PARENT_REVISION_NOT_EDITABLE' USING ERRCODE = '55000';
      END IF;
      IF parent_number >= NEW.revision_number THEN
        RAISE EXCEPTION 'G20105_PARENT_REVISION_ORDER_INVALID' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$g20105_revision_insert$;

CREATE FUNCTION ontos_migration.g20105_enforce_dependency_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20105_dependency_insert$
DECLARE
  source_state text;
BEGIN
  SELECT revision.state
  INTO source_state
  FROM meta.resource_revisions AS revision
  WHERE revision.revision_id = NEW.source_revision_id
  FOR UPDATE;

  -- Let the declared FK report a source Revision that does not exist.
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF source_state <> 'draft' THEN
    RAISE EXCEPTION 'G20105_PUBLISHED_DEPENDENCIES_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20105_dependency_insert$;

CREATE FUNCTION ontos_migration.g20105_enforce_revision_update_resource_state() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20105_revision_update_resource$
DECLARE
  resource_state text;
BEGIN
  IF (OLD.state = 'draft' AND (
        NEW.content IS DISTINCT FROM OLD.content
        OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
        OR NEW.state = 'validated'
      ))
    OR (OLD.state = 'validated' AND NEW.state = 'published') THEN
    SELECT resource.state
    INTO resource_state
    FROM meta.resources AS resource
    WHERE resource.resource_id = OLD.resource_id
    FOR UPDATE;

    IF resource_state <> 'active' THEN
      RAISE EXCEPTION 'G20105_RESOURCE_NOT_EDITABLE' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$g20105_revision_update_resource$;

CREATE TRIGGER resource_revisions_insert_guard
BEFORE INSERT ON meta.resource_revisions
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20105_enforce_revision_insert();

CREATE TRIGGER resource_revisions_active_resource_guard
BEFORE UPDATE ON meta.resource_revisions
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20105_enforce_revision_update_resource_state();

CREATE TRIGGER resource_dependencies_insert_guard
BEFORE INSERT ON meta.resource_dependencies
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20105_enforce_dependency_insert();

REVOKE ALL PRIVILEGES ON FUNCTION
  ontos_migration.g20105_enforce_revision_insert(),
  ontos_migration.g20105_enforce_dependency_insert(),
  ontos_migration.g20105_enforce_revision_update_resource_state()
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
