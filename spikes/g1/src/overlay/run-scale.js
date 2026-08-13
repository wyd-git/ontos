import { mkdir, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, release } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { executeSql, queryJson } from "../db/psql.js";
import { rebuildStagingProjection } from "./postgres-materializer.js";

const objectTypes = ["EntityA", "EntityB", "EntityC", "EntityD", "EntityE"];
const timestamp = new Date().toISOString().replaceAll(":", "");
const runId = timestamp.replaceAll(/[^0-9A-Za-z]/g, "");
const evidenceDirectory = join("evidence", "raw", `${timestamp}-spike-b-scale`);
const thresholdMs = 30 * 60 * 1000;
await mkdir(evidenceDirectory, { recursive: true });

const baseline = queryJson(`
  WITH active_objects AS (
    SELECT count(*) AS count
    FROM kernel.object_current current_object
    JOIN kernel.object_type_runtime runtime
      ON runtime.object_type_id = current_object.object_type_id
     AND runtime.active_generation_id = current_object.generation_id
  ), active_links AS (
    SELECT count(*) AS count
    FROM kernel.link_current link
    JOIN kernel.link_type_runtime runtime
      ON runtime.link_type_id = link.link_type_id
     AND runtime.active_generation_id = link.generation_id
    WHERE link.lifecycle_state = 'active'
  )
  SELECT json_build_array(json_build_object(
    'objects', (SELECT count FROM active_objects),
    'links', (SELECT count FROM active_links),
    'objectTypes', (SELECT count(*) FROM kernel.object_type_runtime),
    'linkTypes', (SELECT count(*) FROM kernel.link_type_runtime)
  ));
`)[0];

if (Number(baseline.objects) !== 100_000 || Number(baseline.links) !== 1_000_000) {
  throw new Error(`Scale fixture must start at 100k active objects / 1m links; observed ${JSON.stringify(baseline)}`);
}

const totalStarted = performance.now();
const stageLoadStarted = performance.now();
const staged = queryJson(`
  BEGIN;

  INSERT INTO kernel.snapshot_generations (
    object_type_id,
    snapshot_id,
    status,
    based_on_generation_id,
    overlay_watermark,
    content_hash
  )
  SELECT
    runtime.object_type_id,
    'scale-v2-' || lower(runtime.object_type_id) || '-${runId}',
    'staging',
    runtime.active_generation_id,
    COALESCE((
      SELECT max(operation_seq)
      FROM kernel.overlay_operations operation
      WHERE operation.object_type_id = runtime.object_type_id
    ), 0),
    'scale-v2-${runId}'
  FROM kernel.object_type_runtime runtime
  ORDER BY runtime.object_type_id;

  INSERT INTO kernel.object_base (
    generation_id,
    object_type_id,
    object_rid,
    primary_key,
    properties,
    source_row_number
  )
  SELECT
    staging.generation_id,
    base.object_type_id,
    base.object_rid,
    base.primary_key,
    base.properties,
    base.source_row_number
  FROM kernel.snapshot_generations staging
  JOIN kernel.object_type_runtime runtime
    ON runtime.object_type_id = staging.object_type_id
  JOIN kernel.object_base base
    ON base.generation_id = runtime.active_generation_id
   AND base.object_type_id = runtime.object_type_id
  WHERE staging.content_hash = 'scale-v2-${runId}'
    AND staging.status = 'staging';

  COMMIT;

  SELECT json_agg(json_build_object(
    'objectType', staging.object_type_id,
    'generationId', staging.generation_id,
    'previousGenerationId', staging.based_on_generation_id,
    'watermark', staging.overlay_watermark,
    'baseObjects', (
      SELECT count(*) FROM kernel.object_base base
      WHERE base.generation_id = staging.generation_id
        AND base.object_type_id = staging.object_type_id
    )
  ) ORDER BY staging.object_type_id)
  FROM kernel.snapshot_generations staging
  WHERE staging.content_hash = 'scale-v2-${runId}';
`);
const stageLoadDurationMs = performance.now() - stageLoadStarted;

const nextLinkGeneration = Number(queryJson(`
  SELECT json_build_array(json_build_object(
    'generationId', COALESCE(max(generation_id), 0) + 1
  ))
  FROM kernel.link_current;
`)[0].generationId);
if (!Number.isSafeInteger(nextLinkGeneration) || nextLinkGeneration <= 1) {
  throw new Error(`Invalid staged link generation ${nextLinkGeneration}`);
}

const linkStageStarted = performance.now();
executeSql(`
  INSERT INTO kernel.link_current (
    generation_id,
    link_type_id,
    link_rid,
    source_object_type_id,
    source_object_rid,
    target_object_type_id,
    target_object_rid,
    lifecycle_state
  )
  SELECT
    ${nextLinkGeneration},
    link.link_type_id,
    link.link_rid,
    link.source_object_type_id,
    link.source_object_rid,
    link.target_object_type_id,
    link.target_object_rid,
    link.lifecycle_state
  FROM kernel.link_current link
  JOIN kernel.link_type_runtime runtime
    ON runtime.link_type_id = link.link_type_id
   AND runtime.active_generation_id = link.generation_id;
`);
const linkStageDurationMs = performance.now() - linkStageStarted;

const analyzeStarted = performance.now();
executeSql("ANALYZE kernel.object_base; ANALYZE kernel.link_current;");
const analyzeDurationMs = performance.now() - analyzeStarted;

const materializations = [];
for (const item of staged) {
  const timing = rebuildStagingProjection({
    generationId: Number(item.generationId),
    previousGenerationId: Number(item.previousGenerationId),
    watermark: Number(item.watermark),
    refreshStatistics: false,
  });
  materializations.push({ ...item, ...timing });
}

const stagedLinkValidation = queryJson(`
  WITH staged_objects AS (
    SELECT current_object.object_type_id, current_object.object_rid
    FROM kernel.object_current current_object
    JOIN kernel.snapshot_generations generation
      ON generation.generation_id = current_object.generation_id
     AND generation.object_type_id = current_object.object_type_id
    WHERE generation.content_hash = 'scale-v2-${runId}'
      AND generation.status = 'staging'
  )
  SELECT json_build_array(json_build_object(
    'stagedLinks', count(*),
    'danglingLinks', count(*) FILTER (
      WHERE source_object.object_rid IS NULL OR target_object.object_rid IS NULL
    )
  ))
  FROM kernel.link_current link
  LEFT JOIN staged_objects source_object
    ON source_object.object_type_id = link.source_object_type_id
   AND source_object.object_rid = link.source_object_rid
  LEFT JOIN staged_objects target_object
    ON target_object.object_type_id = link.target_object_type_id
   AND target_object.object_rid = link.target_object_rid
  WHERE link.generation_id = ${nextLinkGeneration};
`)[0];

const groupCutoverStarted = performance.now();
executeSql(`
  BEGIN;
  ${staged.map((item) => `CALL kernel.cutover_generation(${Number(item.generationId)});`).join("\n  ")}
  UPDATE kernel.link_type_runtime
  SET active_generation_id = ${nextLinkGeneration};
  COMMIT;
`);
const groupCutoverDurationMs = performance.now() - groupCutoverStarted;

const validationStarted = performance.now();
const validation = queryJson(`
  WITH active_objects AS (
    SELECT current_object.object_type_id, current_object.object_rid
    FROM kernel.object_current current_object
    JOIN kernel.object_type_runtime runtime
      ON runtime.object_type_id = current_object.object_type_id
     AND runtime.active_generation_id = current_object.generation_id
  ), active_links AS (
    SELECT link.*
    FROM kernel.link_current link
    JOIN kernel.link_type_runtime runtime
      ON runtime.link_type_id = link.link_type_id
     AND runtime.active_generation_id = link.generation_id
    WHERE link.lifecycle_state = 'active'
  ), link_validation AS (
    SELECT count(*) FILTER (
      WHERE source_object.object_rid IS NULL OR target_object.object_rid IS NULL
    ) AS dangling_links
    FROM active_links link
    LEFT JOIN active_objects source_object
      ON source_object.object_type_id = link.source_object_type_id
     AND source_object.object_rid = link.source_object_rid
    LEFT JOIN active_objects target_object
      ON target_object.object_type_id = link.target_object_type_id
     AND target_object.object_rid = link.target_object_rid
  )
  SELECT json_build_array(json_build_object(
    'activeObjects', (SELECT count(*) FROM active_objects),
    'activeLinks', (SELECT count(*) FROM active_links),
    'physicalLinks', (SELECT count(*) FROM kernel.link_current),
    'danglingLinks', (SELECT dangling_links FROM link_validation),
    'stagingGenerations', (
      SELECT count(*) FROM kernel.snapshot_generations
      WHERE content_hash = 'scale-v2-${runId}' AND status <> 'active'
    ),
    'activeGenerationPointers', (
      SELECT count(*) FROM kernel.object_type_runtime runtime
      JOIN kernel.snapshot_generations generation
        ON generation.generation_id = runtime.active_generation_id
       AND generation.object_type_id = runtime.object_type_id
       AND generation.status = 'active'
      WHERE generation.content_hash = 'scale-v2-${runId}'
    ),
    'activeLinkGenerationPointers', (
      SELECT count(*) FROM kernel.link_type_runtime
      WHERE active_generation_id = ${nextLinkGeneration}
    )
  ));
`)[0];
const validationDurationMs = performance.now() - validationStarted;
const totalDurationMs = performance.now() - totalStarted;

const assertions = [
  assertion("100k active objects retained", Number(validation.activeObjects) === 100_000, validation.activeObjects),
  assertion("1m links staged", Number(stagedLinkValidation.stagedLinks) === 1_000_000, stagedLinkValidation.stagedLinks),
  assertion("1m staged links activated", Number(validation.activeLinks) === 1_000_000, validation.activeLinks),
  assertion("staged link endpoints resolve before cutover", Number(stagedLinkValidation.danglingLinks) === 0, stagedLinkValidation.danglingLinks),
  assertion("all link endpoints resolve", Number(validation.danglingLinks) === 0, validation.danglingLinks),
  assertion("all five generation pointers active", Number(validation.activeGenerationPointers) === 5, validation.activeGenerationPointers),
  assertion("all five link generation pointers active", Number(validation.activeLinkGenerationPointers) === 5, validation.activeLinkGenerationPointers),
  assertion("no scale generation left staging", Number(validation.stagingGenerations) === 0, validation.stagingGenerations),
  assertion("materialization completes under 30 minutes", totalDurationMs < thresholdMs, { totalDurationMs, thresholdMs }),
  assertion("atomic object and link group cutover remains under five seconds", groupCutoverDurationMs < 5_000, groupCutoverDurationMs),
];

const report = {
  status: assertions.every((item) => item.passed) ? "PASS" : "FAIL",
  scope: "100k-object-1m-link-full-staging-and-atomic-group-cutover",
  thresholdMs,
  totalDurationMs,
  stageLoadDurationMs,
  linkStageDurationMs,
  analyzeDurationMs,
  groupCutoverDurationMs,
  validationDurationMs,
  baseline,
  materializations,
  stagedLinkGeneration: nextLinkGeneration,
  stagedLinkValidation,
  validation,
  assertions,
};

await writeJson(join(evidenceDirectory, "environment.json"), {
  timestamp,
  hostname: hostname(),
  platform: platform(),
  osRelease: release(),
  cpuModel: cpus()[0]?.model,
  cpuCount: cpus().length,
  nodeVersion: process.version,
});
await writeJson(join(evidenceDirectory, "result.json"), report);
await writeFile(join(evidenceDirectory, "command.txt"), "npm run spike:b:scale\n", "utf8");
process.stdout.write(`${JSON.stringify({ evidenceDirectory, ...report }, null, 2)}\n`);
if (report.status !== "PASS") {
  process.exitCode = 1;
}

function assertion(name, passed, detail) {
  return { name, passed: Boolean(passed), detail };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
