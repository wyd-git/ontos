\set ON_ERROR_STOP on
\timing on

TRUNCATE TABLE
  kernel.outbox_events,
  kernel.changesets,
  kernel.action_executions,
  kernel.object_conflicts,
  kernel.link_current,
  kernel.link_type_runtime,
  kernel.object_current,
  kernel.overlay_operations,
  kernel.object_heads,
  kernel.object_base,
  kernel.snapshot_generations,
  kernel.object_type_runtime,
  kernel.release_metadata
RESTART IDENTITY CASCADE;

INSERT INTO kernel.release_metadata (release_revision, schema_hash, status)
VALUES ('benchmark-r1', 'seed-20260813', 'published');

INSERT INTO kernel.object_type_runtime (object_type_id)
VALUES ('EntityA'), ('EntityB'), ('EntityC'), ('EntityD'), ('EntityE');

INSERT INTO kernel.snapshot_generations (
  object_type_id,
  snapshot_id,
  status,
  overlay_watermark,
  content_hash,
  activated_at
)
SELECT
  object_type_id,
  'seed-v1-' || lower(object_type_id),
  'active',
  0,
  'seed-20260813-' || lower(object_type_id),
  clock_timestamp()
FROM kernel.object_type_runtime
ORDER BY object_type_id;

UPDATE kernel.object_type_runtime runtime
SET
  active_generation_id = generation.generation_id,
  active_snapshot_id = generation.snapshot_id,
  updated_at = clock_timestamp()
FROM kernel.snapshot_generations generation
WHERE generation.object_type_id = runtime.object_type_id;

WITH type_fixture AS (
  SELECT * FROM (VALUES
    ('EntityA', 'EA'),
    ('EntityB', 'EB'),
    ('EntityC', 'EC'),
    ('EntityD', 'ED'),
    ('EntityE', 'EE')
  ) AS fixture(object_type_id, key_prefix)
), generated AS (
  SELECT
    generation.generation_id,
    fixture.object_type_id,
    fixture.object_type_id || ':' || lpad(series.id::text, 6, '0') AS object_rid,
    fixture.key_prefix || '-' || lpad(series.id::text, 6, '0') AS primary_key,
    jsonb_build_object(
      'name', fixture.object_type_id || ' record ' || series.id,
      'status', (ARRAY['OPEN', 'IN_PROGRESS', 'BLOCKED', 'CLOSED'])[((series.id - 1) % 4) + 1],
      'updatedAt', to_char(
        (timestamptz '2025-01-01 00:00:00+00' + ((series.id * 37) % 525600) * interval '1 minute') AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'amount', round((((series.id * 7919) % 10000000)::numeric / 100), 2),
      'active', (series.id % 5) <> 0,
      'region', (ARRAY['EAST', 'WEST', 'NORTH', 'SOUTH'])[((series.id - 1) % 4) + 1],
      'sensitiveCode', 'SC-' || md5(fixture.object_type_id || ':' || series.id)::text,
      'tags', jsonb_build_array(
        'tag-' || (series.id % 20),
        'bucket-' || (series.id % 100)
      )
    ) AS properties,
    series.id AS source_row_number
  FROM type_fixture fixture
  JOIN kernel.snapshot_generations generation
    ON generation.object_type_id = fixture.object_type_id
   AND generation.status = 'active'
  CROSS JOIN generate_series(1, 20000) AS series(id)
)
INSERT INTO kernel.object_base (
  generation_id,
  object_type_id,
  object_rid,
  primary_key,
  properties,
  source_row_number
)
SELECT
  generation_id,
  object_type_id,
  object_rid,
  primary_key,
  properties,
  source_row_number
FROM generated;

INSERT INTO kernel.object_heads (
  object_type_id,
  object_rid,
  primary_key,
  object_version,
  lifecycle_state
)
SELECT
  object_type_id,
  object_rid,
  primary_key,
  1,
  'active'
FROM kernel.object_base;

INSERT INTO kernel.object_current (
  generation_id,
  object_type_id,
  object_rid,
  primary_key,
  object_version,
  properties,
  lifecycle_state,
  provenance
)
SELECT
  base.generation_id,
  base.object_type_id,
  base.object_rid,
  base.primary_key,
  head.object_version,
  base.properties,
  head.lifecycle_state,
  jsonb_build_object(
    'base', jsonb_build_object(
      'source', 'base',
      'snapshotId', generation.snapshot_id,
      'sourceRow', base.source_row_number
    ),
    'propertyOverrides', '{}'::jsonb,
    'overlayWatermark', 0
  )
FROM kernel.object_base base
JOIN kernel.object_heads head
  ON head.object_type_id = base.object_type_id
 AND head.object_rid = base.object_rid
JOIN kernel.snapshot_generations generation
  ON generation.generation_id = base.generation_id;

INSERT INTO kernel.link_type_runtime (
  link_type_id,
  active_generation_id,
  source_object_type_id,
  target_object_type_id
)
VALUES
  ('LinkAB', 1, 'EntityA', 'EntityB'),
  ('LinkBC', 1, 'EntityB', 'EntityC'),
  ('LinkCD', 1, 'EntityC', 'EntityD'),
  ('LinkDE', 1, 'EntityD', 'EntityE'),
  ('LinkEA', 1, 'EntityE', 'EntityA');

WITH link_fixture AS (
  SELECT * FROM (VALUES
    (0, 'LinkAB', 'EntityA', 'EntityB'),
    (1, 'LinkBC', 'EntityB', 'EntityC'),
    (2, 'LinkCD', 'EntityC', 'EntityD'),
    (3, 'LinkDE', 'EntityD', 'EntityE'),
    (4, 'LinkEA', 'EntityE', 'EntityA')
  ) AS fixture(bucket, link_type_id, source_type, target_type)
), generated AS (
  SELECT
    1::bigint AS generation_id,
    fixture.link_type_id,
    fixture.link_type_id || ':' || series.id AS link_rid,
    fixture.source_type AS source_object_type_id,
    fixture.source_type || ':' || lpad((((series.id * 17) % 20000) + 1)::text, 6, '0') AS source_object_rid,
    fixture.target_type AS target_object_type_id,
    fixture.target_type || ':' || lpad((((series.id * 97 + series.id / 20000) % 20000) + 1)::text, 6, '0') AS target_object_rid
  FROM generate_series(1, 1000000) AS series(id)
  JOIN link_fixture fixture
    ON fixture.bucket = ((series.id - 1) % 5)
)
INSERT INTO kernel.link_current (
  generation_id,
  link_type_id,
  link_rid,
  source_object_type_id,
  source_object_rid,
  target_object_type_id,
  target_object_rid
)
SELECT
  generation_id,
  link_type_id,
  link_rid,
  source_object_type_id,
  source_object_rid,
  target_object_type_id,
  target_object_rid
FROM generated;

ANALYZE kernel.object_base;
ANALYZE kernel.object_heads;
ANALYZE kernel.object_current;
ANALYZE kernel.link_current;
