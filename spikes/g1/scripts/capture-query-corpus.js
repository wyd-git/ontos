import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableHash } from "../src/core/stable-json.js";
import { benchmarkQueryCorpus } from "../src/bench/query-corpus.js";

const compiled = benchmarkQueryCorpus.map((item) => {
  const query = item.build();
  return {
    id: item.id,
    thresholdMs: item.thresholdMs,
    execution: {
      text: query.text,
      values: query.values,
      parameterTypes: query.parameterTypes,
    },
    policyContextHashes: query.policyContextHashes ?? null,
    linkPolicyContextHashes: query.linkPolicyContextHashes ?? null,
  };
});
const executionPayload = compiled.map(({ id, thresholdMs, execution }) => ({ id, thresholdMs, execution }));
const report = {
  queryCount: compiled.length,
  executionDigest: stableHash(executionPayload),
  compilerOutputDigest: stableHash(compiled),
  queries: compiled,
};

if (process.env.SPIKE_EVIDENCE_DIRECTORY) {
  const targetDirectory = process.env.SPIKE_EVIDENCE_DIRECTORY;
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(join(targetDirectory, "query-corpus.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify({
  queryCount: report.queryCount,
  executionDigest: report.executionDigest,
  compilerOutputDigest: report.compilerOutputDigest,
  evidenceDirectory: process.env.SPIKE_EVIDENCE_DIRECTORY ?? null,
}, null, 2)}\n`);
