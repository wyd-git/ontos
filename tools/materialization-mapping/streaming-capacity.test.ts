import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./streaming-capacity-fixture.ts", import.meta.url));
const mebibyte = 1024 * 1024;

void test("100k Object / 1m Link Mapping stays bounded under a 128 MiB V8 heap", () => {
  const result = spawnSync(process.execPath, ["--expose-gc", "--max-old-space-size=128", fixture], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC", LANG: "C" },
    maxBuffer: 2 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const evidence = JSON.parse(result.stdout) as CapacityEvidence;

  assert.equal(evidence.fixtureSeed, "seed-20260813");
  assert.deepEqual(summaryCounts(evidence.objectSummary), {
    source: 100_000,
    accepted: 100_000,
    rejected: 0,
  });
  assert.deepEqual(summaryCounts(evidence.linkSummary), {
    source: 1_000_000,
    accepted: 1_000_000,
    rejected: 0,
  });
  assert.ok(evidence.memory.peakHeapUsed < 120 * mebibyte, JSON.stringify(evidence.memory));
  assert.ok(
    evidence.memory.retainedHeapGrowthBytes < 32 * mebibyte,
    JSON.stringify(evidence.memory),
  );
  assert.match(evidence.objectSummary.mappedStreamDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(evidence.linkSummary.mappedStreamDigest, /^sha256:[0-9a-f]{64}$/u);
  process.stdout.write(`\nMAPPING_CAPACITY ${JSON.stringify(evidence)}\n`);
});

interface SummaryEvidence {
  readonly sourceRowCount: number;
  readonly acceptedRowCount: number;
  readonly rejectedRowCount: number;
  readonly mappedStreamDigest: string;
}

interface CapacityEvidence {
  readonly fixtureSeed: string;
  readonly objectSummary: SummaryEvidence;
  readonly linkSummary: SummaryEvidence;
  readonly memory: {
    readonly peakHeapUsed: number;
    readonly retainedHeapGrowthBytes: number;
  };
  readonly durationMs: {
    readonly objects: number;
    readonly links: number;
    readonly total: number;
  };
}

function summaryCounts(summary: SummaryEvidence) {
  return {
    source: summary.sourceRowCount,
    accepted: summary.acceptedRowCount,
    rejected: summary.rejectedRowCount,
  };
}
