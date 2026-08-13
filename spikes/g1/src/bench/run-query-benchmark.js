import { mkdir, writeFile } from "node:fs/promises";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { explainCompiled, queryJson } from "../db/psql.js";
import { benchmarkQueryCorpus } from "./query-corpus.js";

const iterations = integerEnvironment("SPIKE_ITERATIONS", 15, 3, 1000);
const warmups = integerEnvironment("SPIKE_WARMUPS", 3, 0, 100);
const timestamp = new Date().toISOString().replaceAll(":", "");
const evidenceDirectory = join("evidence", "raw", `${timestamp}-spike-a`);

const corpus = benchmarkQueryCorpus;

await mkdir(join(evidenceDirectory, "explain"), { recursive: true });
const fixture = queryJson(`
  WITH active_objects AS (
    SELECT count(*) AS count
    FROM kernel.object_current current_object
    JOIN kernel.object_type_runtime runtime
      ON runtime.object_type_id = current_object.object_type_id
     AND runtime.active_generation_id = current_object.generation_id
    WHERE current_object.lifecycle_state = 'active'
  )
  SELECT json_build_array(json_build_object(
    'serverVersion', current_setting('server_version'),
    'activeObjects', (SELECT count FROM active_objects),
    'physicalObjects', (SELECT count(*) FROM kernel.object_current),
    'activeLinks', (
      SELECT count(*) FROM kernel.link_current link
      JOIN kernel.link_type_runtime runtime
        ON runtime.link_type_id = link.link_type_id
       AND runtime.active_generation_id = link.generation_id
      WHERE link.lifecycle_state = 'active'
    ),
    'physicalLinks', (SELECT count(*) FROM kernel.link_current),
    'databaseSizeBytes', pg_database_size(current_database())
  ));
`)[0];
if (Number(fixture.activeObjects) !== 100_000 || Number(fixture.activeLinks) !== 1_000_000) {
  throw new Error(`Query benchmark fixture must be 100k active objects / 1m active links; observed ${JSON.stringify(fixture)}`);
}
const environment = {
  timestamp,
  hostname: hostname(),
  platform: platform(),
  osRelease: release(),
  cpuModel: cpus()[0]?.model,
  cpuCount: cpus().length,
  totalMemoryBytes: totalmem(),
  freeMemoryBytesAtStart: freemem(),
  nodeVersion: process.version,
  iterations,
  warmups,
  fixture,
};
await writeJson(join(evidenceDirectory, "environment.json"), environment);

const results = [];
for (const item of corpus) {
  const compiled = item.build();
  for (let index = 0; index < warmups; index += 1) {
    explainCompiled(compiled);
  }
  const samples = [];
  let representative;
  for (let index = 0; index < iterations; index += 1) {
    const explained = explainCompiled(compiled);
    samples.push(explained.executionTimeMs);
    representative ??= explained.plan;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const p95 = percentile(sorted, 0.95);
  const result = {
    id: item.id,
    thresholdMs: item.thresholdMs,
    status: p95 < item.thresholdMs ? "PASS" : "FAIL",
    minimumMs: sorted[0],
    medianMs: percentile(sorted, 0.5),
    p95Ms: p95,
    maximumMs: sorted.at(-1),
    samples,
    unexplainedSequentialScans: findUnexplainedSequentialScans(representative),
  };
  result.status = p95 < item.thresholdMs && result.unexplainedSequentialScans.length === 0 ? "PASS" : "FAIL";
  results.push(result);
  await writeJson(join(evidenceDirectory, "explain", `${item.id}.json`), representative);
  process.stdout.write(`${item.id}: p95=${p95.toFixed(3)}ms threshold=${item.thresholdMs}ms ${result.status}\n`);
}

const report = {
  status: results.every((result) => result.status === "PASS") ? "PASS" : "FAIL",
  scope: "explain-plan-and-p95-companion-to-sustained-gate",
  results,
};
await writeJson(join(evidenceDirectory, "result.json"), report);
await writeFile(join(evidenceDirectory, "command.txt"), `SPIKE_ITERATIONS=${iterations} SPIKE_WARMUPS=${warmups} npm run spike:a\n`, "utf8");
process.stdout.write(`${JSON.stringify({ evidenceDirectory, ...report }, null, 2)}\n`);

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function findUnexplainedSequentialScans(planDocument) {
  const allowedMetadataRelations = new Set([
    "object_type_runtime",
    "link_type_runtime",
    "snapshot_generations",
    "release_metadata",
  ]);
  const scans = [];
  walk(planDocument.Plan, (node) => {
    if (node["Node Type"] === "Seq Scan" && !allowedMetadataRelations.has(node["Relation Name"])) {
      scans.push({
        relation: node["Relation Name"],
        alias: node.Alias,
        planRows: node["Plan Rows"],
        actualRows: node["Actual Rows"],
        filter: node.Filter,
      });
    }
  });
  return scans;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

function integerEnvironment(name, fallback, minimum, maximum) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
