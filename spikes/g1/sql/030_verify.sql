\set ON_ERROR_STOP on

DO $$
DECLARE
  object_count bigint;
  link_count bigint;
  active_type_count bigint;
BEGIN
  SELECT count(*) INTO object_count
  FROM kernel.object_current current_object
  JOIN kernel.object_type_runtime runtime
    ON runtime.object_type_id = current_object.object_type_id
   AND runtime.active_generation_id = current_object.generation_id
  WHERE current_object.lifecycle_state = 'active';

  SELECT count(*) INTO link_count
  FROM kernel.link_current
  WHERE lifecycle_state = 'active';

  SELECT count(*) INTO active_type_count
  FROM kernel.object_type_runtime
  WHERE active_generation_id IS NOT NULL;

  IF object_count <> 100000 THEN
    RAISE EXCEPTION 'Expected 100000 active objects, got %', object_count;
  END IF;

  IF link_count <> 1000000 THEN
    RAISE EXCEPTION 'Expected 1000000 active links, got %', link_count;
  END IF;

  IF active_type_count <> 5 THEN
    RAISE EXCEPTION 'Expected 5 active object types, got %', active_type_count;
  END IF;
END
$$;

SELECT
  'fixture_verified' AS status,
  (SELECT count(*) FROM kernel.object_current) AS objects,
  (SELECT count(*) FROM kernel.link_current) AS links,
  (SELECT count(*) FROM pg_indexes WHERE schemaname = 'kernel') AS indexes;

