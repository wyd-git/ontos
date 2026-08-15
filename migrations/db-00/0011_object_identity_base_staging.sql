SET LOCAL ROLE migration_owner;

-- Persist the exact endpoint Object Types on every Link fact. Earlier DB-02
-- migrations could only prove that each RID existed in the same Project; this
-- forward migration closes the wrong-Object-Type gap without rewriting history.
ALTER TABLE runtime.link_base
  ADD COLUMN source_object_type_resource_id uuid,
  ADD COLUMN target_object_type_resource_id uuid;

ALTER TABLE runtime.link_base DISABLE TRIGGER link_base_immutable;

UPDATE runtime.link_base AS link
SET source_object_type_resource_id = source_identity.object_type_resource_id,
    target_object_type_resource_id = target_identity.object_type_resource_id
FROM runtime.object_identities AS source_identity,
     runtime.object_identities AS target_identity
WHERE source_identity.project_id = link.project_id
  AND source_identity.object_rid = link.source_object_rid
  AND target_identity.project_id = link.project_id
  AND target_identity.object_rid = link.target_object_rid;

ALTER TABLE runtime.link_base
  ALTER COLUMN source_object_type_resource_id SET NOT NULL,
  ALTER COLUMN target_object_type_resource_id SET NOT NULL,
  DROP CONSTRAINT link_base_source_identity_fk,
  DROP CONSTRAINT link_base_target_identity_fk,
  ADD CONSTRAINT link_base_source_identity_fk FOREIGN KEY (
    project_id, source_object_type_resource_id, source_object_rid
  ) REFERENCES runtime.object_identities(
    project_id, object_type_resource_id, object_rid
  ) ON DELETE RESTRICT,
  ADD CONSTRAINT link_base_target_identity_fk FOREIGN KEY (
    project_id, target_object_type_resource_id, target_object_rid
  ) REFERENCES runtime.object_identities(
    project_id, object_type_resource_id, object_rid
  ) ON DELETE RESTRICT;

ALTER TABLE runtime.link_base ENABLE TRIGGER link_base_immutable;

ALTER TABLE runtime.link_current
  ADD COLUMN source_object_type_resource_id uuid,
  ADD COLUMN target_object_type_resource_id uuid;

ALTER TABLE runtime.link_current DISABLE TRIGGER link_current_immutable;

UPDATE runtime.link_current AS link
SET source_object_type_resource_id = source_identity.object_type_resource_id,
    target_object_type_resource_id = target_identity.object_type_resource_id
FROM runtime.object_identities AS source_identity,
     runtime.object_identities AS target_identity
WHERE source_identity.project_id = link.project_id
  AND source_identity.object_rid = link.source_object_rid
  AND target_identity.project_id = link.project_id
  AND target_identity.object_rid = link.target_object_rid;

ALTER TABLE runtime.link_current
  ALTER COLUMN source_object_type_resource_id SET NOT NULL,
  ALTER COLUMN target_object_type_resource_id SET NOT NULL,
  ADD CONSTRAINT link_current_source_identity_fk FOREIGN KEY (
    project_id, source_object_type_resource_id, source_object_rid
  ) REFERENCES runtime.object_identities(
    project_id, object_type_resource_id, object_rid
  ) ON DELETE RESTRICT,
  ADD CONSTRAINT link_current_target_identity_fk FOREIGN KEY (
    project_id, target_object_type_resource_id, target_object_rid
  ) REFERENCES runtime.object_identities(
    project_id, object_type_resource_id, object_rid
  ) ON DELETE RESTRICT;

ALTER TABLE runtime.link_current ENABLE TRIGGER link_current_immutable;

-- A retry is allowed to reproduce the same deterministic batch digest under a
-- new fenced Attempt. Idempotency remains strict within one Attempt.
ALTER TABLE ops.materialization_staged_batches
  DROP CONSTRAINT materialization_staged_batches_digest_uq,
  ADD CONSTRAINT materialization_staged_batches_attempt_digest_uq
    UNIQUE (project_id, attempt_id, batch_digest);

CREATE TABLE ops.materialization_generation_stages (
  project_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  job_id uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  member_kind text NOT NULL CHECK (member_kind IN ('object', 'link')),
  state text NOT NULL DEFAULT 'staging' CHECK (state IN ('staging', 'promoted')),
  promoted_row_count bigint CHECK (promoted_row_count >= 0),
  stage_digest varchar(71) CHECK (
    stage_digest IS NULL OR stage_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  promoted_at timestamptz,
  PRIMARY KEY (project_id, attempt_id, generation_id),
  CONSTRAINT materialization_generation_stages_attempt_fk FOREIGN KEY (
    project_id, attempt_id, job_id, fencing_token
  ) REFERENCES ops.materialization_attempts(
    project_id, attempt_id, job_id, fencing_token
  ) ON DELETE RESTRICT,
  CONSTRAINT materialization_generation_stages_generation_fk
    FOREIGN KEY (project_id, generation_id)
    REFERENCES runtime.generations(project_id, generation_id) ON DELETE RESTRICT,
  CONSTRAINT materialization_generation_stages_result_ck CHECK (
    (state = 'staging' AND promoted_row_count IS NULL
      AND stage_digest IS NULL AND promoted_at IS NULL)
    OR (state = 'promoted' AND promoted_row_count IS NOT NULL
      AND stage_digest IS NOT NULL AND promoted_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX materialization_generation_stages_promoted_uq
  ON ops.materialization_generation_stages(project_id, generation_id)
  WHERE state = 'promoted';

CREATE TABLE ops.materialization_generation_stage_batches (
  project_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  batch_sequence bigint NOT NULL CHECK (batch_sequence >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, attempt_id, generation_id, batch_sequence),
  CONSTRAINT materialization_generation_stage_batches_owner_fk FOREIGN KEY (
    project_id, attempt_id, generation_id
  ) REFERENCES ops.materialization_generation_stages(
    project_id, attempt_id, generation_id
  ) ON DELETE RESTRICT,
  CONSTRAINT materialization_generation_stage_batches_batch_fk FOREIGN KEY (
    project_id, attempt_id, batch_sequence
  ) REFERENCES ops.materialization_staged_batches(
    project_id, attempt_id, batch_sequence
  ) ON DELETE RESTRICT,
  CONSTRAINT materialization_generation_stage_batches_attempt_sequence_uq
    UNIQUE (project_id, attempt_id, batch_sequence)
);

CREATE TABLE ops.object_base_staging (
  project_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  batch_sequence bigint NOT NULL,
  object_type_resource_id uuid NOT NULL,
  object_type_revision_id uuid NOT NULL,
  object_rid uuid NOT NULL,
  canonical_primary_key text COLLATE "C" NOT NULL
    CHECK (octet_length(canonical_primary_key) BETWEEN 1 AND 1024),
  properties jsonb NOT NULL CHECK (jsonb_typeof(properties) = 'object'),
  source_snapshot_id uuid NOT NULL,
  source_file_id uuid NOT NULL,
  source_row_number bigint NOT NULL CHECK (source_row_number >= 1),
  mapping_revision_id uuid NOT NULL,
  value_digest varchar(71) NOT NULL
    CHECK (value_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, attempt_id, generation_id, object_type_resource_id, object_rid),
  CONSTRAINT object_base_staging_owner_fk FOREIGN KEY (
    project_id, attempt_id, generation_id
  ) REFERENCES ops.materialization_generation_stages(
    project_id, attempt_id, generation_id
  ) ON DELETE RESTRICT,
  CONSTRAINT object_base_staging_batch_fk FOREIGN KEY (
    project_id, attempt_id, generation_id, batch_sequence
  ) REFERENCES ops.materialization_generation_stage_batches(
    project_id, attempt_id, generation_id, batch_sequence
  ) ON DELETE RESTRICT,
  CONSTRAINT object_base_staging_generation_fk FOREIGN KEY (
    project_id, generation_id, object_type_resource_id, object_type_revision_id
  ) REFERENCES runtime.generations(
    project_id, generation_id, target_resource_id, target_revision_id
  ) ON DELETE RESTRICT,
  CONSTRAINT object_base_staging_identity_fk FOREIGN KEY (
    project_id, object_type_resource_id, object_rid, canonical_primary_key
  ) REFERENCES runtime.object_identities(
    project_id, object_type_resource_id, object_rid, canonical_primary_key
  ) ON DELETE RESTRICT,
  CONSTRAINT object_base_staging_snapshot_file_fk FOREIGN KEY (
    project_id, source_snapshot_id, source_file_id
  ) REFERENCES runtime.snapshot_files(project_id, snapshot_id, file_id) ON DELETE RESTRICT,
  CONSTRAINT object_base_staging_canonical_pk_uq UNIQUE (
    project_id, attempt_id, generation_id, object_type_resource_id, canonical_primary_key
  )
);

CREATE TABLE ops.link_base_staging (
  project_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  batch_sequence bigint NOT NULL,
  link_type_resource_id uuid NOT NULL,
  link_type_revision_id uuid NOT NULL,
  link_rid uuid NOT NULL,
  source_object_type_resource_id uuid NOT NULL,
  source_object_type_revision_id uuid NOT NULL,
  source_object_rid uuid NOT NULL,
  target_object_type_resource_id uuid NOT NULL,
  target_object_type_revision_id uuid NOT NULL,
  target_object_rid uuid NOT NULL,
  source_snapshot_id uuid NOT NULL,
  source_file_id uuid NOT NULL,
  source_row_number bigint NOT NULL CHECK (source_row_number >= 1),
  mapping_revision_id uuid NOT NULL,
  value_digest varchar(71) NOT NULL
    CHECK (value_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, attempt_id, generation_id, link_type_resource_id, link_rid),
  CONSTRAINT link_base_staging_owner_fk FOREIGN KEY (
    project_id, attempt_id, generation_id
  ) REFERENCES ops.materialization_generation_stages(
    project_id, attempt_id, generation_id
  ) ON DELETE RESTRICT,
  CONSTRAINT link_base_staging_batch_fk FOREIGN KEY (
    project_id, attempt_id, generation_id, batch_sequence
  ) REFERENCES ops.materialization_generation_stage_batches(
    project_id, attempt_id, generation_id, batch_sequence
  ) ON DELETE RESTRICT,
  CONSTRAINT link_base_staging_generation_fk FOREIGN KEY (
    project_id, generation_id, link_type_resource_id, link_type_revision_id
  ) REFERENCES runtime.generations(
    project_id, generation_id, target_resource_id, target_revision_id
  ) ON DELETE RESTRICT,
  CONSTRAINT link_base_staging_source_identity_fk FOREIGN KEY (
    project_id, source_object_type_resource_id, source_object_rid
  ) REFERENCES runtime.object_identities(
    project_id, object_type_resource_id, object_rid
  ) ON DELETE RESTRICT,
  CONSTRAINT link_base_staging_target_identity_fk FOREIGN KEY (
    project_id, target_object_type_resource_id, target_object_rid
  ) REFERENCES runtime.object_identities(
    project_id, object_type_resource_id, object_rid
  ) ON DELETE RESTRICT,
  CONSTRAINT link_base_staging_source_revision_fk FOREIGN KEY (
    source_object_type_resource_id, source_object_type_revision_id
  ) REFERENCES meta.resource_revisions(resource_id, revision_id) ON DELETE RESTRICT,
  CONSTRAINT link_base_staging_target_revision_fk FOREIGN KEY (
    target_object_type_resource_id, target_object_type_revision_id
  ) REFERENCES meta.resource_revisions(resource_id, revision_id) ON DELETE RESTRICT,
  CONSTRAINT link_base_staging_snapshot_file_fk FOREIGN KEY (
    project_id, source_snapshot_id, source_file_id
  ) REFERENCES runtime.snapshot_files(project_id, snapshot_id, file_id) ON DELETE RESTRICT,
  CONSTRAINT link_base_staging_endpoints_uq UNIQUE (
    project_id, attempt_id, generation_id, link_type_resource_id,
    source_object_rid, target_object_rid
  )
);

CREATE FUNCTION ontos_migration.g20206_enforce_generation_stage_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $g20206_generation_stage_update$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token
    OR NEW.member_kind IS DISTINCT FROM OLD.member_kind
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'G20206_GENERATION_STAGE_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NOT (OLD.state = 'staging' AND NEW.state = 'promoted') THEN
    RAISE EXCEPTION 'G20206_GENERATION_STAGE_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$g20206_generation_stage_update$;

CREATE FUNCTION ontos_migration.g20206_assert_live_stage(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_generation_id uuid,
  p_target_resource_id uuid,
  p_target_revision_id uuid,
  p_source_snapshot_id uuid,
  p_source_file_id uuid
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $g20206_assert_live_stage$
DECLARE
  stage_kind text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ops.materialization_jobs AS job
    WHERE job.project_id = p_project_id AND job.job_id = p_job_id
      AND job.state = 'running' AND job.current_attempt_id = p_attempt_id
      AND job.fencing_token = p_fencing_token
      AND job.lease_expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_FENCED' USING ERRCODE = '55000';
  END IF;

  SELECT generation.member_kind INTO stage_kind
  FROM runtime.generations AS generation
  JOIN ops.materialization_jobs AS job
    ON job.project_id = generation.project_id
   AND job.snapshot_group_id = generation.snapshot_group_id
   AND job.group_version = generation.group_version
  WHERE generation.project_id = p_project_id
    AND generation.generation_id = p_generation_id
    AND generation.target_resource_id = p_target_resource_id
    AND generation.target_revision_id = p_target_revision_id
    AND generation.snapshot_id = p_source_snapshot_id
    AND generation.state = 'building'
    AND job.job_id = p_job_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM runtime.snapshot_files AS file
    WHERE file.project_id = p_project_id
      AND file.snapshot_id = p_source_snapshot_id
      AND file.file_id = p_source_file_id
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23514';
  END IF;
  RETURN stage_kind;
END
$g20206_assert_live_stage$;

CREATE FUNCTION runtime.resolve_or_create_object_identities(
  p_project_id uuid,
  p_candidates jsonb
) RETURNS TABLE (ordinal integer, object_rid uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $resolve_or_create_object_identities$
DECLARE
  candidate_count integer;
  resolved_count integer;
BEGIN
  IF p_project_id IS NULL OR p_candidates IS NULL OR jsonb_typeof(p_candidates) <> 'array' THEN
    RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  candidate_count := jsonb_array_length(p_candidates);
  IF candidate_count NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;

  BEGIN
    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_candidates) AS item(
        "ordinal" integer,
        "objectTypeResourceId" text,
        "canonicalPrimaryKey" text,
        "candidateObjectRid" text
      )
      WHERE item."ordinal" IS NULL OR item."ordinal" < 0
        OR item."objectTypeResourceId" IS NULL
        OR item."candidateObjectRid" IS NULL
        OR octet_length(item."canonicalPrimaryKey") NOT BETWEEN 1 AND 1024
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_candidates) AS item(
        "ordinal" integer,
        "objectTypeResourceId" text,
        "canonicalPrimaryKey" text,
        "candidateObjectRid" text
      )
      GROUP BY item."ordinal" HAVING count(*) > 1
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_candidates) AS item(
        "ordinal" integer,
        "objectTypeResourceId" text,
        "canonicalPrimaryKey" text,
        "candidateObjectRid" text
      )
      GROUP BY item."objectTypeResourceId", item."canonicalPrimaryKey" HAVING count(*) > 1
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_candidates) AS item(
        "ordinal" integer,
        "objectTypeResourceId" text,
        "canonicalPrimaryKey" text,
        "candidateObjectRid" text
      )
      LEFT JOIN meta.resources AS resource
        ON resource.project_id = p_project_id
       AND resource.resource_id = item."objectTypeResourceId"::uuid
       AND resource.family = 'object_type'
       AND resource.state <> 'archived'
      WHERE resource.resource_id IS NULL
    ) THEN
      RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
    END IF;
  EXCEPTION WHEN invalid_text_representation OR data_exception THEN
    RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
  END;

  BEGIN
    INSERT INTO runtime.object_identities (
      project_id, object_type_resource_id, object_rid, canonical_primary_key
    )
    SELECT p_project_id,
           item."objectTypeResourceId"::uuid,
           item."candidateObjectRid"::uuid,
           item."canonicalPrimaryKey"
    FROM jsonb_to_recordset(p_candidates) AS item(
      "ordinal" integer,
      "objectTypeResourceId" text,
      "canonicalPrimaryKey" text,
      "candidateObjectRid" text
    )
    ORDER BY item."objectTypeResourceId" COLLATE "C", item."canonicalPrimaryKey" COLLATE "C"
    ON CONFLICT (project_id, object_type_resource_id, canonical_primary_key) DO NOTHING;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'MATERIALIZATION_IDENTITY_CONFLICT' USING ERRCODE = '23505';
  END;

  RETURN QUERY
  SELECT item."ordinal", identity.object_rid
  FROM jsonb_to_recordset(p_candidates) AS item(
    "ordinal" integer,
    "objectTypeResourceId" text,
    "canonicalPrimaryKey" text,
    "candidateObjectRid" text
  )
  JOIN runtime.object_identities AS identity
    ON identity.project_id = p_project_id
   AND identity.object_type_resource_id = item."objectTypeResourceId"::uuid
   AND identity.canonical_primary_key = item."canonicalPrimaryKey"
  ORDER BY item."ordinal";
  GET DIAGNOSTICS resolved_count = ROW_COUNT;
  IF resolved_count <> candidate_count THEN
    RAISE EXCEPTION 'MATERIALIZATION_IDENTITY_CONFLICT' USING ERRCODE = '23505';
  END IF;
END
$resolve_or_create_object_identities$;

CREATE FUNCTION runtime.lookup_object_identities(
  p_project_id uuid,
  p_lookups jsonb
) RETURNS TABLE (ordinal integer, object_rid uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $lookup_object_identities$
DECLARE
  lookup_count integer;
BEGIN
  IF p_project_id IS NULL OR p_lookups IS NULL OR jsonb_typeof(p_lookups) <> 'array' THEN
    RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  lookup_count := jsonb_array_length(p_lookups);
  IF lookup_count NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;

  BEGIN
    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_lookups) AS item(
        "ordinal" integer,
        "objectTypeResourceId" text,
        "objectTypeRevisionId" text,
        "canonicalPrimaryKey" text
      )
      LEFT JOIN meta.resource_revisions AS revision
        ON revision.resource_id = item."objectTypeResourceId"::uuid
       AND revision.revision_id = item."objectTypeRevisionId"::uuid
       AND revision.family = 'object_type'
       AND revision.state IN ('validated', 'published', 'deprecated')
      LEFT JOIN meta.resources AS resource
        ON resource.project_id = p_project_id
       AND resource.resource_id = item."objectTypeResourceId"::uuid
       AND resource.family = 'object_type'
       AND resource.state <> 'archived'
      WHERE item."ordinal" IS NULL OR item."ordinal" < 0
        OR octet_length(item."canonicalPrimaryKey") NOT BETWEEN 1 AND 1024
        OR revision.revision_id IS NULL OR resource.resource_id IS NULL
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_lookups) AS item(
        "ordinal" integer,
        "objectTypeResourceId" text,
        "objectTypeRevisionId" text,
        "canonicalPrimaryKey" text
      ) GROUP BY item."ordinal" HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'MATERIALIZATION_LINK_ENDPOINT_TYPE_INVALID' USING ERRCODE = '23514';
    END IF;
  EXCEPTION WHEN invalid_text_representation OR data_exception THEN
    RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
  END;

  RETURN QUERY
  SELECT item."ordinal", identity.object_rid
  FROM jsonb_to_recordset(p_lookups) AS item(
    "ordinal" integer,
    "objectTypeResourceId" text,
    "objectTypeRevisionId" text,
    "canonicalPrimaryKey" text
  )
  JOIN runtime.object_identities AS identity
    ON identity.project_id = p_project_id
   AND identity.object_type_resource_id = item."objectTypeResourceId"::uuid
   AND identity.canonical_primary_key = item."canonicalPrimaryKey"
  ORDER BY item."ordinal";
END
$lookup_object_identities$;

CREATE FUNCTION ops.stage_object_base_batch(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_batch_sequence bigint,
  p_batch_digest text,
  p_generation_id uuid,
  p_target_resource_id uuid,
  p_target_revision_id uuid,
  p_source_snapshot_id uuid,
  p_source_file_id uuid,
  p_rows jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $stage_object_base_batch$
DECLARE
  stage_kind text;
  row_count integer;
  mapping_revision uuid;
  existing ops.materialization_staged_batches%ROWTYPE;
  staged_count integer;
BEGIN
  IF p_batch_sequence < 1 OR p_batch_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  row_count := jsonb_array_length(p_rows);
  IF row_count NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  stage_kind := ontos_migration.g20206_assert_live_stage(
    p_project_id, p_job_id, p_attempt_id, p_fencing_token,
    p_generation_id, p_target_resource_id, p_target_revision_id,
    p_source_snapshot_id, p_source_file_id
  );
  IF stage_kind <> 'object' THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23514';
  END IF;
  SELECT generation.mapping_revision_id INTO STRICT mapping_revision
  FROM runtime.generations AS generation
  WHERE generation.project_id = p_project_id AND generation.generation_id = p_generation_id;

  BEGIN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS item(
        "objectRid" text,
        "canonicalPrimaryKey" text,
        "properties" jsonb,
        "sourceRowNumber" bigint,
        "valueDigest" text
      )
      WHERE item."objectRid" IS NULL
        OR octet_length(item."canonicalPrimaryKey") NOT BETWEEN 1 AND 1024
        OR jsonb_typeof(item."properties") <> 'object'
        OR item."sourceRowNumber" < 1
        OR item."valueDigest" !~ '^sha256:[0-9a-f]{64}$'
    ) OR EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS item(
        "objectRid" text,
        "canonicalPrimaryKey" text,
        "properties" jsonb,
        "sourceRowNumber" bigint,
        "valueDigest" text
      ) GROUP BY item."objectRid" HAVING count(*) > 1
    ) OR EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS item(
        "objectRid" text,
        "canonicalPrimaryKey" text,
        "properties" jsonb,
        "sourceRowNumber" bigint,
        "valueDigest" text
      ) GROUP BY item."canonicalPrimaryKey" HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
    END IF;
  EXCEPTION WHEN invalid_text_representation OR data_exception THEN
    RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
  END;

  INSERT INTO ops.materialization_generation_stages (
    project_id, attempt_id, generation_id, job_id, fencing_token, member_kind
  ) VALUES (
    p_project_id, p_attempt_id, p_generation_id, p_job_id, p_fencing_token, 'object'
  ) ON CONFLICT (project_id, attempt_id, generation_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM ops.materialization_generation_stages AS stage
    WHERE stage.project_id = p_project_id AND stage.attempt_id = p_attempt_id
      AND stage.generation_id = p_generation_id AND stage.job_id = p_job_id
      AND stage.fencing_token = p_fencing_token AND stage.member_kind = 'object'
      AND stage.state = 'staging'
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO existing FROM ops.materialization_staged_batches AS batch
  WHERE batch.project_id = p_project_id AND batch.attempt_id = p_attempt_id
    AND batch.batch_sequence = p_batch_sequence;
  IF FOUND THEN
    SELECT count(*)::integer INTO staged_count FROM ops.object_base_staging AS stage
    WHERE stage.project_id = p_project_id AND stage.attempt_id = p_attempt_id
      AND stage.generation_id = p_generation_id
      AND stage.batch_sequence = p_batch_sequence;
    IF existing.job_id <> p_job_id OR existing.fencing_token <> p_fencing_token
      OR existing.batch_digest <> p_batch_digest OR existing.row_count <> row_count
      OR staged_count <> row_count
      OR NOT EXISTS (
        SELECT 1 FROM ops.materialization_generation_stage_batches AS binding
        WHERE binding.project_id = p_project_id AND binding.attempt_id = p_attempt_id
          AND binding.generation_id = p_generation_id
          AND binding.batch_sequence = p_batch_sequence
      ) THEN
      RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN;
  END IF;

  PERFORM ops.write_materialization_staged_batch(
    p_project_id, p_job_id, p_attempt_id, p_fencing_token,
    p_batch_sequence, p_batch_digest, row_count
  );
  INSERT INTO ops.materialization_generation_stage_batches (
    project_id, attempt_id, generation_id, batch_sequence
  ) VALUES (p_project_id, p_attempt_id, p_generation_id, p_batch_sequence);
  BEGIN
    INSERT INTO ops.object_base_staging (
      project_id, attempt_id, generation_id, batch_sequence,
      object_type_resource_id, object_type_revision_id, object_rid,
      canonical_primary_key, properties, source_snapshot_id, source_file_id,
      source_row_number, mapping_revision_id, value_digest
    )
    SELECT p_project_id, p_attempt_id, p_generation_id, p_batch_sequence,
           p_target_resource_id, p_target_revision_id, item."objectRid"::uuid,
           item."canonicalPrimaryKey", item."properties", p_source_snapshot_id,
           p_source_file_id, item."sourceRowNumber", mapping_revision, item."valueDigest"
    FROM jsonb_to_recordset(p_rows) AS item(
      "objectRid" text,
      "canonicalPrimaryKey" text,
      "properties" jsonb,
      "sourceRowNumber" bigint,
      "valueDigest" text
    );
  EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23505';
  END;
END
$stage_object_base_batch$;

CREATE FUNCTION ops.stage_link_base_batch(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_batch_sequence bigint,
  p_batch_digest text,
  p_generation_id uuid,
  p_target_resource_id uuid,
  p_target_revision_id uuid,
  p_source_snapshot_id uuid,
  p_source_file_id uuid,
  p_rows jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $stage_link_base_batch$
DECLARE
  stage_kind text;
  row_count integer;
  mapping_revision uuid;
  existing ops.materialization_staged_batches%ROWTYPE;
  staged_count integer;
BEGIN
  IF p_batch_sequence < 1 OR p_batch_digest !~ '^sha256:[0-9a-f]{64}$'
    OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  row_count := jsonb_array_length(p_rows);
  IF row_count NOT BETWEEN 0 AND 5000 THEN
    RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  stage_kind := ontos_migration.g20206_assert_live_stage(
    p_project_id, p_job_id, p_attempt_id, p_fencing_token,
    p_generation_id, p_target_resource_id, p_target_revision_id,
    p_source_snapshot_id, p_source_file_id
  );
  IF stage_kind <> 'link' THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23514';
  END IF;
  SELECT generation.mapping_revision_id INTO STRICT mapping_revision
  FROM runtime.generations AS generation
  WHERE generation.project_id = p_project_id AND generation.generation_id = p_generation_id;

  BEGIN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS item(
        "linkRid" text,
        "sourceObjectTypeResourceId" text,
        "sourceObjectTypeRevisionId" text,
        "sourceObjectRid" text,
        "targetObjectTypeResourceId" text,
        "targetObjectTypeRevisionId" text,
        "targetObjectRid" text,
        "sourceRowNumber" bigint,
        "valueDigest" text
      )
      WHERE item."linkRid" IS NULL OR item."sourceObjectRid" IS NULL
        OR item."targetObjectRid" IS NULL OR item."sourceRowNumber" < 1
        OR item."valueDigest" !~ '^sha256:[0-9a-f]{64}$'
    ) OR EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS item(
        "linkRid" text,
        "sourceObjectTypeResourceId" text,
        "sourceObjectTypeRevisionId" text,
        "sourceObjectRid" text,
        "targetObjectTypeResourceId" text,
        "targetObjectTypeRevisionId" text,
        "targetObjectRid" text,
        "sourceRowNumber" bigint,
        "valueDigest" text
      ) GROUP BY item."linkRid" HAVING count(*) > 1
    ) OR EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS item(
        "linkRid" text,
        "sourceObjectTypeResourceId" text,
        "sourceObjectTypeRevisionId" text,
        "sourceObjectRid" text,
        "targetObjectTypeResourceId" text,
        "targetObjectTypeRevisionId" text,
        "targetObjectRid" text,
        "sourceRowNumber" bigint,
        "valueDigest" text
      ) GROUP BY item."sourceObjectRid", item."targetObjectRid" HAVING count(*) > 1
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_rows) AS item(
        "linkRid" text,
        "sourceObjectTypeResourceId" text,
        "sourceObjectTypeRevisionId" text,
        "sourceObjectRid" text,
        "targetObjectTypeResourceId" text,
        "targetObjectTypeRevisionId" text,
        "targetObjectRid" text,
        "sourceRowNumber" bigint,
        "valueDigest" text
      )
      WHERE NOT EXISTS (
        SELECT 1 FROM meta.resource_dependencies AS dependency
        JOIN meta.resource_revisions AS endpoint
          ON endpoint.revision_id = dependency.target_revision_id
         AND endpoint.resource_id = item."sourceObjectTypeResourceId"::uuid
        WHERE dependency.source_revision_id = p_target_revision_id
          AND dependency.dependency_type = 'link_source'
          AND dependency.target_revision_id = item."sourceObjectTypeRevisionId"::uuid
      ) OR NOT EXISTS (
        SELECT 1 FROM meta.resource_dependencies AS dependency
        JOIN meta.resource_revisions AS endpoint
          ON endpoint.revision_id = dependency.target_revision_id
         AND endpoint.resource_id = item."targetObjectTypeResourceId"::uuid
        WHERE dependency.source_revision_id = p_target_revision_id
          AND dependency.dependency_type = 'link_target'
          AND dependency.target_revision_id = item."targetObjectTypeRevisionId"::uuid
      )
    ) THEN
      RAISE EXCEPTION 'MATERIALIZATION_LINK_ENDPOINT_TYPE_INVALID' USING ERRCODE = '23514';
    END IF;
  EXCEPTION WHEN invalid_text_representation OR data_exception THEN
    RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
  END;

  INSERT INTO ops.materialization_generation_stages (
    project_id, attempt_id, generation_id, job_id, fencing_token, member_kind
  ) VALUES (
    p_project_id, p_attempt_id, p_generation_id, p_job_id, p_fencing_token, 'link'
  ) ON CONFLICT (project_id, attempt_id, generation_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM ops.materialization_generation_stages AS stage
    WHERE stage.project_id = p_project_id AND stage.attempt_id = p_attempt_id
      AND stage.generation_id = p_generation_id AND stage.job_id = p_job_id
      AND stage.fencing_token = p_fencing_token AND stage.member_kind = 'link'
      AND stage.state = 'staging'
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO existing FROM ops.materialization_staged_batches AS batch
  WHERE batch.project_id = p_project_id AND batch.attempt_id = p_attempt_id
    AND batch.batch_sequence = p_batch_sequence;
  IF FOUND THEN
    SELECT count(*)::integer INTO staged_count FROM ops.link_base_staging AS stage
    WHERE stage.project_id = p_project_id AND stage.attempt_id = p_attempt_id
      AND stage.generation_id = p_generation_id
      AND stage.batch_sequence = p_batch_sequence;
    IF existing.job_id <> p_job_id OR existing.fencing_token <> p_fencing_token
      OR existing.batch_digest <> p_batch_digest OR existing.row_count <> row_count
      OR staged_count <> row_count
      OR NOT EXISTS (
        SELECT 1 FROM ops.materialization_generation_stage_batches AS binding
        WHERE binding.project_id = p_project_id AND binding.attempt_id = p_attempt_id
          AND binding.generation_id = p_generation_id
          AND binding.batch_sequence = p_batch_sequence
      ) THEN
      RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN;
  END IF;

  PERFORM ops.write_materialization_staged_batch(
    p_project_id, p_job_id, p_attempt_id, p_fencing_token,
    p_batch_sequence, p_batch_digest, row_count
  );
  INSERT INTO ops.materialization_generation_stage_batches (
    project_id, attempt_id, generation_id, batch_sequence
  ) VALUES (p_project_id, p_attempt_id, p_generation_id, p_batch_sequence);
  BEGIN
    INSERT INTO ops.link_base_staging (
      project_id, attempt_id, generation_id, batch_sequence,
      link_type_resource_id, link_type_revision_id, link_rid,
      source_object_type_resource_id, source_object_type_revision_id, source_object_rid,
      target_object_type_resource_id, target_object_type_revision_id, target_object_rid,
      source_snapshot_id, source_file_id, source_row_number,
      mapping_revision_id, value_digest
    )
    SELECT p_project_id, p_attempt_id, p_generation_id, p_batch_sequence,
           p_target_resource_id, p_target_revision_id, item."linkRid"::uuid,
           item."sourceObjectTypeResourceId"::uuid,
           item."sourceObjectTypeRevisionId"::uuid, item."sourceObjectRid"::uuid,
           item."targetObjectTypeResourceId"::uuid,
           item."targetObjectTypeRevisionId"::uuid, item."targetObjectRid"::uuid,
           p_source_snapshot_id, p_source_file_id, item."sourceRowNumber",
           mapping_revision, item."valueDigest"
    FROM jsonb_to_recordset(p_rows) AS item(
      "linkRid" text,
      "sourceObjectTypeResourceId" text,
      "sourceObjectTypeRevisionId" text,
      "sourceObjectRid" text,
      "targetObjectTypeResourceId" text,
      "targetObjectTypeRevisionId" text,
      "targetObjectRid" text,
      "sourceRowNumber" bigint,
      "valueDigest" text
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23505';
  WHEN foreign_key_violation OR check_violation THEN
    RAISE EXCEPTION 'MATERIALIZATION_LINK_ENDPOINT_TYPE_INVALID' USING ERRCODE = '23514';
  END;
END
$stage_link_base_batch$;

CREATE FUNCTION ops.promote_materialization_base(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_fencing_token bigint,
  p_generation_id uuid,
  p_expected_row_count bigint,
  p_expected_stage_digest text
) RETURNS TABLE (row_count bigint, stage_digest text, reused boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $promote_materialization_base$
DECLARE
  owner ops.materialization_generation_stages%ROWTYPE;
  prior ops.materialization_generation_stages%ROWTYPE;
  computed_row_count bigint;
  actual_row_count bigint;
  computed_stage_digest text;
  digest_preimage text;
  inserted_count bigint;
BEGIN
  IF p_expected_row_count < 0
    OR p_expected_stage_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'G20206_BASE_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ops.materialization_jobs AS job
    WHERE job.project_id = p_project_id AND job.job_id = p_job_id
      AND job.state = 'running' AND job.current_attempt_id = p_attempt_id
      AND job.fencing_token = p_fencing_token
      AND job.lease_expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_JOB_FENCED' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO owner FROM ops.materialization_generation_stages AS stage
  WHERE stage.project_id = p_project_id AND stage.attempt_id = p_attempt_id
    AND stage.generation_id = p_generation_id AND stage.job_id = p_job_id
    AND stage.fencing_token = p_fencing_token
  FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM runtime.generations AS generation
    WHERE generation.project_id = p_project_id
      AND generation.generation_id = p_generation_id
      AND generation.member_kind = owner.member_kind
      AND generation.state = 'building'
  ) THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23514';
  END IF;
  IF owner.state = 'promoted' THEN
    IF owner.promoted_row_count <> p_expected_row_count
      OR owner.stage_digest <> p_expected_stage_digest THEN
      RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT p_expected_row_count, p_expected_stage_digest, true;
    RETURN;
  END IF;

  SELECT COALESCE(sum(batch.row_count), 0),
         '{"batches":[' || string_agg(
           '{"batchDigest":' || to_json(batch.batch_digest)::text ||
           ',"batchSequence":' || batch.batch_sequence::text ||
           ',"rowCount":' || batch.row_count::text || '}',
           ',' ORDER BY batch.batch_sequence
         ) || '],"contractVersion":"base-stage-v1","generationId":' ||
         to_json(p_generation_id::text)::text || ',"schemaVersion":1}'
  INTO computed_row_count, digest_preimage
  FROM ops.materialization_generation_stage_batches AS binding
  JOIN ops.materialization_staged_batches AS batch
    ON batch.project_id = binding.project_id
   AND batch.attempt_id = binding.attempt_id
   AND batch.batch_sequence = binding.batch_sequence
  WHERE binding.project_id = p_project_id AND binding.attempt_id = p_attempt_id
    AND binding.generation_id = p_generation_id;
  IF digest_preimage IS NULL THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
  computed_stage_digest := 'sha256:' || encode(sha256(convert_to(digest_preimage, 'UTF8')), 'hex');
  IF computed_row_count <> p_expected_row_count
    OR computed_stage_digest <> p_expected_stage_digest THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_INCOMPLETE' USING ERRCODE = '23514';
  END IF;

  IF owner.member_kind = 'object' THEN
    SELECT count(*) INTO actual_row_count FROM ops.object_base_staging AS stage
    WHERE stage.project_id = p_project_id AND stage.attempt_id = p_attempt_id
      AND stage.generation_id = p_generation_id;
  ELSE
    SELECT count(*) INTO actual_row_count FROM ops.link_base_staging AS stage
    WHERE stage.project_id = p_project_id AND stage.attempt_id = p_attempt_id
      AND stage.generation_id = p_generation_id;
  END IF;
  IF actual_row_count <> p_expected_row_count THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_INCOMPLETE' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO prior FROM ops.materialization_generation_stages AS stage
  WHERE stage.project_id = p_project_id AND stage.generation_id = p_generation_id
    AND stage.state = 'promoted'
  FOR KEY SHARE;
  IF FOUND THEN
    IF prior.promoted_row_count <> p_expected_row_count
      OR prior.stage_digest <> p_expected_stage_digest
      OR prior.member_kind <> owner.member_kind THEN
      RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT p_expected_row_count, p_expected_stage_digest, true;
    RETURN;
  END IF;

  BEGIN
    IF owner.member_kind = 'object' THEN
      INSERT INTO runtime.object_base (
        project_id, generation_id, object_type_resource_id, object_type_revision_id,
        object_rid, canonical_primary_key, properties, source_snapshot_id,
        source_file_id, source_row_number, mapping_revision_id, value_digest
      )
      SELECT stage.project_id, stage.generation_id, stage.object_type_resource_id,
             stage.object_type_revision_id, stage.object_rid, stage.canonical_primary_key,
             stage.properties, stage.source_snapshot_id, stage.source_file_id,
             stage.source_row_number, stage.mapping_revision_id, stage.value_digest
      FROM ops.object_base_staging AS stage
      WHERE stage.project_id = p_project_id AND stage.attempt_id = p_attempt_id
        AND stage.generation_id = p_generation_id
      ORDER BY stage.object_type_resource_id, stage.canonical_primary_key COLLATE "C";
    ELSE
      INSERT INTO runtime.link_base (
        project_id, generation_id, link_type_resource_id, link_type_revision_id,
        link_rid, source_object_type_resource_id, source_object_rid,
        target_object_type_resource_id, target_object_rid,
        source_snapshot_id, source_file_id, source_row_number,
        mapping_revision_id, value_digest
      )
      SELECT stage.project_id, stage.generation_id, stage.link_type_resource_id,
             stage.link_type_revision_id, stage.link_rid,
             stage.source_object_type_resource_id, stage.source_object_rid,
             stage.target_object_type_resource_id, stage.target_object_rid,
             stage.source_snapshot_id, stage.source_file_id, stage.source_row_number,
             stage.mapping_revision_id, stage.value_digest
      FROM ops.link_base_staging AS stage
      WHERE stage.project_id = p_project_id AND stage.attempt_id = p_attempt_id
        AND stage.generation_id = p_generation_id
      ORDER BY stage.link_type_resource_id, stage.source_object_rid, stage.target_object_rid;
    END IF;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
  EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_CONFLICT' USING ERRCODE = '23505';
  END;
  IF inserted_count <> p_expected_row_count THEN
    RAISE EXCEPTION 'MATERIALIZATION_BASE_INCOMPLETE' USING ERRCODE = '23514';
  END IF;

  UPDATE ops.materialization_generation_stages
  SET state = 'promoted', promoted_row_count = p_expected_row_count,
      stage_digest = p_expected_stage_digest, promoted_at = clock_timestamp()
  WHERE project_id = p_project_id AND attempt_id = p_attempt_id
    AND generation_id = p_generation_id AND state = 'staging';
  RETURN QUERY SELECT p_expected_row_count, p_expected_stage_digest, false;
END
$promote_materialization_base$;

CREATE TRIGGER materialization_generation_stages_controlled_update
BEFORE UPDATE ON ops.materialization_generation_stages
FOR EACH ROW EXECUTE FUNCTION ontos_migration.g20206_enforce_generation_stage_update();
CREATE TRIGGER materialization_generation_stages_no_delete
BEFORE DELETE OR TRUNCATE ON ops.materialization_generation_stages
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER materialization_generation_stage_batches_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.materialization_generation_stage_batches
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER object_base_staging_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.object_base_staging
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();
CREATE TRIGGER link_base_staging_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON ops.link_base_staging
FOR EACH STATEMENT EXECUTE FUNCTION ontos_migration.g20203_reject_fact_mutation();

REVOKE ALL PRIVILEGES ON TABLE
  ops.materialization_generation_stages,
  ops.materialization_generation_stage_batches,
  ops.object_base_staging,
  ops.link_base_staging
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;
REVOKE ALL PRIVILEGES ON FUNCTION
  ontos_migration.g20206_enforce_generation_stage_update(),
  ontos_migration.g20206_assert_live_stage(uuid, uuid, uuid, bigint, uuid, uuid, uuid, uuid, uuid),
  runtime.resolve_or_create_object_identities(uuid, jsonb),
  runtime.lookup_object_identities(uuid, jsonb),
  ops.stage_object_base_batch(uuid, uuid, uuid, bigint, bigint, text, uuid, uuid, uuid, uuid, uuid, jsonb),
  ops.stage_link_base_batch(uuid, uuid, uuid, bigint, bigint, text, uuid, uuid, uuid, uuid, uuid, jsonb),
  ops.promote_materialization_base(uuid, uuid, uuid, bigint, uuid, bigint, text)
FROM PUBLIC, api_runtime, worker_runtime, read_only_ops;

GRANT SELECT ON TABLE
  ops.materialization_generation_stages,
  ops.materialization_generation_stage_batches,
  ops.object_base_staging,
  ops.link_base_staging
TO worker_runtime;

GRANT EXECUTE ON FUNCTION
  runtime.resolve_or_create_object_identities(uuid, jsonb),
  runtime.lookup_object_identities(uuid, jsonb),
  ops.stage_object_base_batch(uuid, uuid, uuid, bigint, bigint, text, uuid, uuid, uuid, uuid, uuid, jsonb),
  ops.stage_link_base_batch(uuid, uuid, uuid, bigint, bigint, text, uuid, uuid, uuid, uuid, uuid, jsonb),
  ops.promote_materialization_base(uuid, uuid, uuid, bigint, uuid, bigint, text)
TO worker_runtime;
