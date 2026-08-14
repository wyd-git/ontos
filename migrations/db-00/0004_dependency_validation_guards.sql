SET LOCAL ROLE migration_owner;

ALTER TABLE meta.validation_reports DISABLE TRIGGER validation_reports_immutable;

ALTER TABLE meta.validation_reports
  ADD COLUMN validation_context_digest varchar(71);

UPDATE meta.validation_reports
SET validation_context_digest = subject_digest
WHERE validation_context_digest IS NULL;

ALTER TABLE meta.validation_reports
  ALTER COLUMN validation_context_digest SET NOT NULL,
  ADD CONSTRAINT validation_reports_context_digest_ck
    CHECK (validation_context_digest ~ '^sha256:[0-9a-f]{64}$'),
  DROP CONSTRAINT validation_reports_subject_uq,
  ADD CONSTRAINT validation_reports_subject_context_uq
    UNIQUE (
      subject_type,
      subject_id,
      subject_digest,
      validation_context_digest,
      validator_version
    );

ALTER TABLE meta.validation_reports ENABLE TRIGGER validation_reports_immutable;

CREATE FUNCTION ontos_migration.g20106_enforce_dependency_content() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20106_dependency_content$
DECLARE
  source_family text;
  source_content jsonb;
  source_project_id uuid;
  target_family text;
  target_state text;
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

  SELECT target.family, target.state, target_resource.state, target_resource.project_id
  INTO target_family, target_state, target_resource_state, target_project_id
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

  IF source_family <> 'link_type' OR target_family <> 'object_type' THEN
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
END
$g20106_dependency_content$;

CREATE FUNCTION ontos_migration.g20106_enforce_revision_validation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20106_revision_validation$
DECLARE
  dependency_count integer;
  source_target uuid;
  target_target uuid;
BEGIN
  IF OLD.state <> 'draft' OR NEW.state <> 'validated' THEN RETURN NEW; END IF;

  IF NEW.family NOT IN ('object_type', 'link_type') THEN
    RAISE EXCEPTION 'G20106_VALIDATOR_NOT_ACTIVE' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM meta.validation_reports AS report
    WHERE report.subject_type = 'resource_revision'
      AND report.resource_revision_id = OLD.revision_id
      AND report.subject_digest = OLD.content_digest
      AND report.validator_version = 'metadata-g2-01-v1'
      AND report.valid = TRUE
  ) THEN
    RAISE EXCEPTION 'G20106_VALID_REPORT_REQUIRED' USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)::integer
  INTO dependency_count
  FROM meta.resource_dependencies
  WHERE source_revision_id = OLD.revision_id;

  SELECT target_revision_id
  INTO source_target
  FROM meta.resource_dependencies
  WHERE source_revision_id = OLD.revision_id
    AND dependency_type = 'link_source';

  SELECT target_revision_id
  INTO target_target
  FROM meta.resource_dependencies
  WHERE source_revision_id = OLD.revision_id
    AND dependency_type = 'link_target';

  IF NEW.family = 'object_type' THEN
    IF dependency_count <> 0 THEN
      RAISE EXCEPTION 'G20106_OBJECT_DEPENDENCIES_FORBIDDEN' USING ERRCODE = '23514';
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

CREATE TRIGGER resource_dependencies_content_guard
BEFORE INSERT ON meta.resource_dependencies
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20106_enforce_dependency_content();

CREATE TRIGGER resource_revisions_validation_guard
BEFORE UPDATE ON meta.resource_revisions
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20106_enforce_revision_validation();

REVOKE ALL PRIVILEGES ON FUNCTION
  ontos_migration.g20106_enforce_dependency_content(),
  ontos_migration.g20106_enforce_revision_validation()
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
