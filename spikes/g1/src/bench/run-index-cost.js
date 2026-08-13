import { mkdir, writeFile } from "node:fs/promises";
import { hostname, platform, release } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { executeSql, queryJson } from "../db/psql.js";

const rounds = 3;
const timestamp = new Date().toISOString().replaceAll(":", "");
const evidenceDirectory = join("evidence", "raw", `${timestamp}-spike-a-index-cost`);
await mkdir(evidenceDirectory, { recursive: true });

const fixture = queryJson(`
  WITH active_objects AS (
    SELECT count(*) AS count
    FROM kernel.object_current current_object
    JOIN kernel.object_type_runtime runtime
      ON runtime.object_type_id = current_object.object_type_id
     AND runtime.active_generation_id = current_object.generation_id
  )
  SELECT json_build_array(json_build_object(
    'activeObjects', (SELECT count FROM active_objects),
    'activeLinks', (
      SELECT count(*) FROM kernel.link_current link
      JOIN kernel.link_type_runtime runtime
        ON runtime.link_type_id = link.link_type_id
       AND runtime.active_generation_id = link.generation_id
      WHERE link.lifecycle_state = 'active'
    )
  ));
`)[0];
if (Number(fixture.activeObjects) !== 100_000 || Number(fixture.activeLinks) !== 1_000_000) {
  throw new Error(`Index cost fixture must be 100k/1m; observed ${JSON.stringify(fixture)}`);
}

const productionStorage = queryJson(`
  SELECT json_build_array(json_build_object(
    'objectCurrentPhysicalRows', (SELECT count(*) FROM kernel.object_current),
    'objectCurrentHeapBytes', pg_relation_size('kernel.object_current'),
    'objectCurrentTotalIndexBytes', pg_indexes_size('kernel.object_current'),
    'linkCurrentHeapBytes', pg_relation_size('kernel.link_current'),
    'linkCurrentTotalIndexBytes', pg_indexes_size('kernel.link_current'),
    'indexes', (
      SELECT json_agg(json_build_object(
        'name', index_class.relname,
        'table', table_class.relname,
        'bytes', pg_relation_size(index_class.oid)
      ) ORDER BY table_class.relname, index_class.relname)
      FROM pg_index index_definition
      JOIN pg_class index_class ON index_class.oid = index_definition.indexrelid
      JOIN pg_class table_class ON table_class.oid = index_definition.indrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = 'kernel'
        AND table_class.relname IN ('object_current', 'link_current')
    )
  ));
`)[0];

setupShadowTables();
const timings = { identityOnlyMs: [], metadataIndexedMs: [] };
try {
  for (let round = 0; round < rounds; round += 1) {
    const order = round % 2 === 0
      ? ["identityOnly", "metadataIndexed"]
      : ["metadataIndexed", "identityOnly"];
    for (const variant of order) {
      const table = variant === "identityOnly"
        ? "spike_write_identity_only"
        : "spike_write_metadata_indexed";
      executeSql(`TRUNCATE TABLE kernel.${table};`);
      const started = performance.now();
      executeSql(`
        INSERT INTO kernel.${table} (
          generation_id, object_type_id, object_rid, primary_key,
          object_version, properties, lifecycle_state, conflict_state, provenance
        )
        SELECT
          current_object.generation_id,
          current_object.object_type_id,
          current_object.object_rid,
          current_object.primary_key,
          current_object.object_version,
          current_object.properties,
          current_object.lifecycle_state,
          current_object.conflict_state,
          current_object.provenance
        FROM kernel.object_current current_object
        JOIN kernel.object_type_runtime runtime
          ON runtime.object_type_id = current_object.object_type_id
         AND runtime.active_generation_id = current_object.generation_id;
      `);
      timings[`${variant}Ms`].push(performance.now() - started);
    }
  }

  const shadowStorage = queryJson(`
    SELECT json_agg(json_build_object(
      'table', table_name,
      'rows', row_count,
      'heapBytes', heap_bytes,
      'indexBytes', index_bytes,
      'totalBytes', heap_bytes + index_bytes
    ) ORDER BY table_name)
    FROM (
      SELECT
        'spike_write_identity_only'::text AS table_name,
        (SELECT count(*) FROM kernel.spike_write_identity_only) AS row_count,
        pg_relation_size('kernel.spike_write_identity_only') AS heap_bytes,
        pg_indexes_size('kernel.spike_write_identity_only') AS index_bytes
      UNION ALL
      SELECT
        'spike_write_metadata_indexed'::text,
        (SELECT count(*) FROM kernel.spike_write_metadata_indexed),
        pg_relation_size('kernel.spike_write_metadata_indexed'),
        pg_indexes_size('kernel.spike_write_metadata_indexed')
    ) measured;
  `);
  const identityMedianMs = median(timings.identityOnlyMs);
  const metadataMedianMs = median(timings.metadataIndexedMs);
  const report = {
    status: "PASS",
    scope: "observational-index-storage-and-100k-write-amplification",
    fixture,
    rounds,
    productionStorage,
    shadowStorage,
    timings: {
      ...timings,
      identityMedianMs,
      metadataMedianMs,
      metadataWriteTimeRatio: metadataMedianMs / identityMedianMs,
    },
  };
  await writeJson(join(evidenceDirectory, "environment.json"), {
    timestamp,
    hostname: hostname(),
    platform: platform(),
    osRelease: release(),
    nodeVersion: process.version,
  });
  await writeJson(join(evidenceDirectory, "result.json"), report);
  await writeFile(join(evidenceDirectory, "command.txt"), "npm run spike:a:index-cost\n", "utf8");
  process.stdout.write(`${JSON.stringify({ evidenceDirectory, ...report }, null, 2)}\n`);
} finally {
  executeSql(`
    DROP TABLE IF EXISTS kernel.spike_write_identity_only;
    DROP TABLE IF EXISTS kernel.spike_write_metadata_indexed;
  `);
}

function setupShadowTables() {
  executeSql(`
    DROP TABLE IF EXISTS kernel.spike_write_identity_only;
    DROP TABLE IF EXISTS kernel.spike_write_metadata_indexed;

    CREATE UNLOGGED TABLE kernel.spike_write_identity_only
      (LIKE kernel.object_current INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
    CREATE UNIQUE INDEX spike_write_identity_only_rid_idx
      ON kernel.spike_write_identity_only (generation_id, object_type_id, object_rid);
    CREATE UNIQUE INDEX spike_write_identity_only_pk_idx
      ON kernel.spike_write_identity_only (generation_id, object_type_id, primary_key);

    CREATE UNLOGGED TABLE kernel.spike_write_metadata_indexed
      (LIKE kernel.object_current INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
    CREATE UNIQUE INDEX spike_write_metadata_indexed_rid_idx
      ON kernel.spike_write_metadata_indexed (generation_id, object_type_id, object_rid);
    CREATE UNIQUE INDEX spike_write_metadata_indexed_pk_idx
      ON kernel.spike_write_metadata_indexed (generation_id, object_type_id, primary_key);
    CREATE INDEX spike_write_metadata_status_updated_idx
      ON kernel.spike_write_metadata_indexed (
        object_type_id, generation_id,
        (properties ->> 'status'), (properties ->> 'updatedAt') DESC, primary_key
      ) WHERE lifecycle_state = 'active';
    CREATE INDEX spike_write_metadata_region_status_idx
      ON kernel.spike_write_metadata_indexed (
        object_type_id, generation_id,
        (properties ->> 'region'), (properties ->> 'status'), primary_key
      ) WHERE lifecycle_state = 'active';
    CREATE INDEX spike_write_metadata_amount_idx
      ON kernel.spike_write_metadata_indexed (
        object_type_id, generation_id,
        ((properties ->> 'amount')::numeric), primary_key
      ) WHERE lifecycle_state = 'active';
    CREATE INDEX spike_write_metadata_name_prefix_idx
      ON kernel.spike_write_metadata_indexed (
        object_type_id, generation_id,
        lower(properties ->> 'name') text_pattern_ops, primary_key
      ) WHERE lifecycle_state = 'active';
    CREATE INDEX spike_write_metadata_name_trgm_idx
      ON kernel.spike_write_metadata_indexed
      USING gin (lower(properties ->> 'name') gin_trgm_ops)
      WHERE lifecycle_state = 'active';
    CREATE INDEX spike_write_metadata_tags_gin_idx
      ON kernel.spike_write_metadata_indexed
      USING gin ((properties -> 'tags'))
      WHERE lifecycle_state = 'active';
  `);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
