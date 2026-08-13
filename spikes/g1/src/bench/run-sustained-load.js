import { mkdir, writeFile } from "node:fs/promises";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { stableHash } from "../core/stable-json.js";
import { executeCompiledAsync, queryJson } from "../db/psql.js";
import { benchmarkQueryCorpus } from "./query-corpus.js";

const durationSeconds = integerEnvironment("SPIKE_DURATION_SECONDS", 60, 10, 7_200);
const targetRps = integerEnvironment("SPIKE_TARGET_RPS", 20, 1, 200);
const maximumInFlight = integerEnvironment("SPIKE_MAX_IN_FLIGHT", 16, 1, 200);
const timestamp = new Date().toISOString().replaceAll(":", "");
const evidenceDirectory = join("evidence", "raw", `${timestamp}-spike-a-sustained`);
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
    'serverVersion', current_setting('server_version'),
    'activeObjects', (SELECT count FROM active_objects),
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
  throw new Error(`Sustained fixture must be 100k active objects / 1m links; observed ${JSON.stringify(fixture)}`);
}

const compiledCorpus = benchmarkQueryCorpus.map((item) => ({ ...item, compiled: item.build() }));
const queryExecutionCorpus = compiledCorpus.map((item) => ({
  id: item.id,
  thresholdMs: item.thresholdMs,
  execution: {
    text: item.compiled.text,
    values: item.compiled.values,
    parameterTypes: item.compiled.parameterTypes,
  },
}));
await writeJson(join(evidenceDirectory, "query-corpus.json"), {
  queryCount: queryExecutionCorpus.length,
  executionDigest: stableHash(queryExecutionCorpus),
  queries: queryExecutionCorpus,
});
const samples = new Map(compiledCorpus.map((item) => [item.id, []]));
const errors = [];
const inFlight = new Set();
const intervalMs = 1_000 / targetRps;
const started = performance.now();
const deadline = started + durationSeconds * 1_000;
let nextLaunchAt = started;
let scheduled = 0;
let peakInFlight = 0;

while (nextLaunchAt < deadline) {
  const delayMs = nextLaunchAt - performance.now();
  if (delayMs > 0) {
    await delay(delayMs);
  }
  while (inFlight.size >= maximumInFlight) {
    await Promise.race(inFlight);
  }

  const item = compiledCorpus[scheduled % compiledCorpus.length];
  const task = executeCompiledAsync(item.compiled)
    .then(({ latencyMs }) => samples.get(item.id).push(latencyMs))
    .catch((error) => {
      errors.push({
        queryId: item.id,
        code: error.code ?? "UNKNOWN",
        message: String(error.message).slice(0, 500),
        latencyMs: error.latencyMs,
      });
    })
    .finally(() => inFlight.delete(task));
  inFlight.add(task);
  peakInFlight = Math.max(peakInFlight, inFlight.size);
  scheduled += 1;
  nextLaunchAt = started + scheduled * intervalMs;
}
await Promise.all(inFlight);
const elapsedMs = performance.now() - started;

const results = compiledCorpus.map((item) => {
  const sorted = [...samples.get(item.id)].sort((left, right) => left - right);
  const p95Ms = percentile(sorted, 0.95);
  return {
    id: item.id,
    thresholdMs: item.thresholdMs,
    successfulRequests: sorted.length,
    minimumMs: sorted[0] ?? null,
    medianMs: percentile(sorted, 0.5),
    p95Ms,
    maximumMs: sorted.at(-1) ?? null,
    status: sorted.length > 0 && p95Ms < item.thresholdMs ? "PASS" : "FAIL",
  };
});
const errorRate = scheduled === 0 ? 1 : errors.length / scheduled;
const achievedRps = scheduled / (elapsedMs / 1_000);
const assertions = [
  assertion("all query latency classes pass", results.every((item) => item.status === "PASS"), results),
  assertion("error rate below 0.1%", errorRate < 0.001, { errorRate, errors: errors.length, scheduled }),
  assertion("at least 95% target throughput scheduled", achievedRps >= targetRps * 0.95, { achievedRps, targetRps }),
];
const report = {
  status: assertions.every((item) => item.passed) ? "PASS" : "FAIL",
  scope: durationSeconds >= 1_800
    ? "30-minute-20-rps-gate"
    : "smoke-not-30-minute-gate",
  durationSeconds,
  targetRps,
  achievedRps,
  scheduledRequests: scheduled,
  successfulRequests: scheduled - errors.length,
  errors: errors.slice(0, 100),
  errorRate,
  peakInFlight,
  elapsedMs,
  results,
  assertions,
};

await writeJson(join(evidenceDirectory, "environment.json"), {
  timestamp,
  hostname: hostname(),
  platform: platform(),
  osRelease: release(),
  cpuModel: cpus()[0]?.model,
  cpuCount: cpus().length,
  totalMemoryBytes: totalmem(),
  freeMemoryBytesAtStart: freemem(),
  nodeVersion: process.version,
  fixture,
  durationSeconds,
  targetRps,
  maximumInFlight,
  clientMode: "one-local-psql-process-per-request-no-connection-pool",
});
await writeJson(join(evidenceDirectory, "result.json"), report);
await writeFile(
  join(evidenceDirectory, "command.txt"),
  `SPIKE_DURATION_SECONDS=${durationSeconds} SPIKE_TARGET_RPS=${targetRps} SPIKE_MAX_IN_FLIGHT=${maximumInFlight} npm run spike:a:sustained\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify({ evidenceDirectory, ...report }, null, 2)}\n`);
if (report.status !== "PASS") {
  process.exitCode = 1;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function assertion(name, passed, detail) {
  return { name, passed: Boolean(passed), detail };
}

function integerEnvironment(name, fallback, minimum, maximum) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
