import { performance } from "node:perf_hooks";

import { DATASET_PRESETS, generateLinks, generateObjects } from "@ontos/testkit";
import {
  createMappingExecution,
  type MappingExecutionSummary,
} from "@ontos/materialization-domain";

import {
  compileLinkFixture,
  compileObjectFixture,
  digestCanonicalText,
  validObjectRow,
} from "./fixtures.ts";

const mebibyte = 1024 * 1024;
const runtime = globalThis as typeof globalThis & { gc?: () => void };

runtime.gc?.();
const baselineHeapUsed = process.memoryUsage().heapUsed;
let peakHeapUsed = baselineHeapUsed;
const startedAt = performance.now();

const objectSummary = await runObjects();
const afterObjectsMs = performance.now();
const linkSummary = await runLinks();
const completedAt = performance.now();

runtime.gc?.();
const retainedHeapUsed = process.memoryUsage().heapUsed;

process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    fixtureSeed: DATASET_PRESETS.benchmark.seed,
    objectSummary,
    linkSummary,
    memory: {
      baselineHeapUsed,
      peakHeapUsed,
      retainedHeapUsed,
      retainedHeapGrowthBytes: retainedHeapUsed - baselineHeapUsed,
      peakHeapMebibytes: Number((peakHeapUsed / mebibyte).toFixed(2)),
    },
    durationMs: {
      objects: Math.round(afterObjectsMs - startedAt),
      links: Math.round(completedAt - afterObjectsMs),
      total: Math.round(completedAt - startedAt),
    },
  }),
);

async function runObjects(): Promise<MappingExecutionSummary> {
  const execution = createMappingExecution({
    plan: compileObjectFixture(),
    sourceContentDigest: digestCanonicalText("benchmark-100k-objects"),
    digestCanonicalText,
    sink: { write() {} },
  });
  let rowNumber = 0;
  for (const object of generateObjects(DATASET_PRESETS.benchmark)) {
    rowNumber += 1;
    await execution.consumeRow({ rowNumber, values: validObjectRow(object.primaryKey) });
    sampleMemory(rowNumber);
  }
  return execution.finish();
}

async function runLinks(): Promise<MappingExecutionSummary> {
  const execution = createMappingExecution({
    plan: compileLinkFixture(),
    sourceContentDigest: digestCanonicalText("benchmark-1m-links"),
    digestCanonicalText,
    sink: { write() {} },
  });
  let rowNumber = 0;
  for (const link of generateLinks(DATASET_PRESETS.benchmark)) {
    rowNumber += 1;
    await execution.consumeRow({
      rowNumber,
      values: [link.sourceObjectRid, link.targetObjectRid],
    });
    sampleMemory(rowNumber);
  }
  return execution.finish();
}

function sampleMemory(rowNumber: number): void {
  if (rowNumber % 10_000 !== 0) return;
  peakHeapUsed = Math.max(peakHeapUsed, process.memoryUsage().heapUsed);
}
