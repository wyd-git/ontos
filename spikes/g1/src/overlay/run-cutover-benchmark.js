import { mkdir, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, release } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { executeSql, queryJson } from "../db/psql.js";

const iterations = 20;
const p95ThresholdMs = 1_000;
const maximumThresholdMs = 5_000;
const timestamp = new Date().toISOString().replaceAll(":", "");
const evidenceDirectory = join("evidence", "raw", `${timestamp}-spike-b-cutover`);
await mkdir(evidenceDirectory, { recursive: true });

const objectPairs = queryJson(`
  SELECT json_agg(json_build_object(
    'objectType', runtime.object_type_id,
    'newGeneration', runtime.active_generation_id,
    'oldGeneration', active_generation.based_on_generation_id
  ) ORDER BY runtime.object_type_id)
  FROM kernel.object_type_runtime runtime
  JOIN kernel.snapshot_generations active_generation
    ON active_generation.generation_id = runtime.active_generation_id
   AND active_generation.object_type_id = runtime.object_type_id;
`);
if (objectPairs.length !== 5 || objectPairs.some((pair) => !positiveInteger(pair.newGeneration) || !positiveInteger(pair.oldGeneration))) {
  throw new Error(`Cutover benchmark requires five active generations with predecessors; observed ${JSON.stringify(objectPairs)}`);
}

const linkPair = queryJson(`
  WITH active AS (
    SELECT min(active_generation_id) AS generation_id,
           count(DISTINCT active_generation_id) AS distinct_generations
    FROM kernel.link_type_runtime
  ), candidates AS (
    SELECT link.generation_id, count(*) AS link_count
    FROM kernel.link_current link, active
    WHERE link.generation_id <> active.generation_id
    GROUP BY link.generation_id
    HAVING count(*) = 1000000
    ORDER BY link.generation_id DESC
    LIMIT 1
  )
  SELECT json_build_array(json_build_object(
    'newGeneration', active.generation_id,
    'oldGeneration', candidates.generation_id,
    'distinctActiveGenerations', active.distinct_generations
  ))
  FROM active CROSS JOIN candidates;
`)[0];
if (!positiveInteger(linkPair?.newGeneration) || !positiveInteger(linkPair?.oldGeneration) || Number(linkPair.distinctActiveGenerations) !== 1) {
  throw new Error(`Cutover benchmark requires one active and one complete alternate link generation; observed ${JSON.stringify(linkPair)}`);
}

const samples = [];
for (let index = 0; index < iterations; index += 1) {
  const useNew = index % 2 === 1;
  const objectTargets = objectPairs.map((pair) => Number(useNew ? pair.newGeneration : pair.oldGeneration));
  const linkTarget = Number(useNew ? linkPair.newGeneration : linkPair.oldGeneration);
  const started = performance.now();
  executeSql(`
    BEGIN;
    UPDATE kernel.snapshot_generations
    SET status = 'staging'
    WHERE generation_id IN (${objectTargets.join(", ")})
      AND status = 'superseded';
    ${objectTargets.map((generation) => `CALL kernel.cutover_generation(${generation});`).join("\n    ")}
    UPDATE kernel.link_type_runtime
    SET active_generation_id = ${linkTarget};
    COMMIT;
  `);
  samples.push(performance.now() - started);
}

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
  )
  SELECT json_build_array(json_build_object(
    'activeObjects', (SELECT count(*) FROM active_objects),
    'activeLinks', (SELECT count(*) FROM active_links),
    'danglingLinks', (
      SELECT count(*) FROM active_links link
      LEFT JOIN active_objects source_object
        ON source_object.object_type_id = link.source_object_type_id
       AND source_object.object_rid = link.source_object_rid
      LEFT JOIN active_objects target_object
        ON target_object.object_type_id = link.target_object_type_id
       AND target_object.object_rid = link.target_object_rid
      WHERE source_object.object_rid IS NULL OR target_object.object_rid IS NULL
    ),
    'newObjectGenerationsRestored', (
      SELECT count(*) FROM kernel.object_type_runtime runtime
      WHERE (runtime.object_type_id, runtime.active_generation_id) IN (
        ${objectPairs.map((pair) => `('${pair.objectType}', ${Number(pair.newGeneration)})`).join(", ")}
      )
    ),
    'newLinkGenerationRestored', (
      SELECT count(*) FROM kernel.link_type_runtime
      WHERE active_generation_id = ${Number(linkPair.newGeneration)}
    )
  ));
`)[0];

const sorted = [...samples].sort((left, right) => left - right);
const p95Ms = percentile(sorted, 0.95);
const maximumMs = sorted.at(-1);
const assertions = [
  assertion("twenty atomic group cutovers completed", samples.length === iterations, samples.length),
  assertion("cutover P95 remains below one second", p95Ms < p95ThresholdMs, { p95Ms, p95ThresholdMs }),
  assertion("maximum cutover remains below five seconds", maximumMs < maximumThresholdMs, { maximumMs, maximumThresholdMs }),
  assertion("even repetitions restore the new object generations", Number(validation.newObjectGenerationsRestored) === 5, validation.newObjectGenerationsRestored),
  assertion("even repetitions restore the new link generation", Number(validation.newLinkGenerationRestored) === 5, validation.newLinkGenerationRestored),
  assertion("active 100k objects and 1m links remain referentially complete", Number(validation.activeObjects) === 100_000 && Number(validation.activeLinks) === 1_000_000 && Number(validation.danglingLinks) === 0, validation),
];
const report = {
  status: assertions.every((item) => item.passed) ? "PASS" : "FAIL",
  scope: "twenty-atomic-five-object-type-one-million-link-generation-cutovers",
  iterations,
  p95ThresholdMs,
  maximumThresholdMs,
  minimumMs: sorted[0],
  medianMs: percentile(sorted, 0.5),
  p95Ms,
  maximumMs,
  samplesMs: samples,
  objectPairs,
  linkPair,
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
await writeFile(join(evidenceDirectory, "command.txt"), "npm run spike:b:cutover\n", "utf8");
process.stdout.write(`${JSON.stringify({ evidenceDirectory, ...report }, null, 2)}\n`);
if (report.status !== "PASS") process.exitCode = 1;

function positiveInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function assertion(name, passed, detail) {
  return { name, passed: Boolean(passed), detail };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
