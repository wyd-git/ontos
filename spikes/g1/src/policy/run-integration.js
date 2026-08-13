import { mkdir, writeFile } from "node:fs/promises";
import { hostname, platform, release } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { benchmarkPolicies, benchmarkRegistry } from "../fixtures/benchmark-schema.js";
import { queryCompiled, queryJson } from "../db/psql.js";
import { createPolicyAwareAdapters, ENTRY_POINTS } from "./adapters.js";
import { PolicyGateway } from "./gateway.js";

const timestamp = new Date().toISOString().replaceAll(":", "");
const evidenceDirectory = join("evidence", "raw", `${timestamp}-spike-c`);
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
  throw new Error(`Policy integration fixture must be 100k/1m; observed ${JSON.stringify(fixture)}`);
}

const policyStore = new Map(Object.entries(benchmarkPolicies));
const audits = [];
const executions = [];
const allowLinkPolicy = Object.freeze({ allowLinkType: true, contextHash: "link-allow-r1" });
const gateway = new PolicyGateway({
  registry: benchmarkRegistry,
  resolvePolicy: async ({ actor }) => policyStore.get(actor.id),
  resolveLinkPolicy: async () => allowLinkPolicy,
  execute: async ({ compiled, operation, objectType }) => {
    const rows = queryCompiled(compiled);
    executions.push({ operation, objectType, sql: compiled.text, values: compiled.values });
    return { rows, rowCount: rows.length };
  },
  audit: (event) => audits.push(event),
});
const adapters = createPolicyAwareAdapters(gateway);
const assertions = [];

const eastSearchRequest = {
  actor: { id: "actor_region_east" },
  objectType: "EntityA",
  query: {
    select: ["id", "name", "status", "region"],
    where: { property: "status", op: "eq", value: "OPEN" },
    page: { size: 10 },
  },
};
const eastSearches = await acrossEntries((adapter) => adapter.search(eastSearchRequest));
check("search result identical across every entry", allJsonEqual(eastSearches), summarizeRows(eastSearches));
check("row policy is applied in database result", eastSearches[0].rows.length > 0 && eastSearches[0].rows.every((row) => row.region === "EAST"), eastSearches[0].rows);
check("row policy predicate appears in SQL", executions.slice(0, ENTRY_POINTS.length).every((item) => item.sql.includes("properties ->> 'region'") && item.values.includes("EAST")), executions.slice(0, ENTRY_POINTS.length));

const aggregateRequest = {
  actor: { id: "actor_region_east" },
  objectType: "EntityA",
  query: { measures: [{ op: "count", as: "objects" }] },
};
const eastAggregates = await acrossEntries((adapter) => adapter.aggregate(aggregateRequest));
check("aggregate identical across every entry", allJsonEqual(eastAggregates), eastAggregates);
check("aggregate excludes invisible rows", Number(eastAggregates[0].rows[0]?.objects) === 5_000, eastAggregates[0]);

const maskedResults = await acrossEntries((adapter) => adapter.search({
  actor: { id: "actor_masked" },
  objectType: "EntityA",
  query: { select: ["id", "name", "amount"], page: { size: 3 } },
}));
check("masked result identical across every entry", allJsonEqual(maskedResults), summarizeRows(maskedResults));
check("masked property is non-business null", maskedResults.every((result) => result.rows.every((row) => row.amount === null)), maskedResults[0]);
check("denied property absent from tool result", !JSON.stringify(maskedResults).includes("sensitiveCode"), maskedResults[0]);

const deniedOperations = await Promise.all([
  captureError(() => adapters.aiToolAdapter.search({
    actor: { id: "actor_masked" },
    objectType: "EntityA",
    query: { select: ["id", "sensitiveCode"] },
  })),
  captureError(() => adapters.exportAdapter.search({
    actor: { id: "actor_masked" },
    objectType: "EntityA",
    query: { where: { property: "amount", op: "gte", value: 10 } },
  })),
  captureError(() => adapters.objectApi.aggregate({
    actor: { id: "actor_masked" },
    objectType: "EntityA",
    query: { measures: [{ op: "sum", property: "amount", as: "total" }] },
  })),
]);
check("deny and mask cannot be selected, filtered, or aggregated", deniedOperations.every((code) => ["PROPERTY_DENIED", "PROPERTY_NOT_QUERYABLE"].includes(code)), deniedOperations);

const guessedTargetErrors = await acrossEntries((adapter) => captureError(() => adapter.loadActionTarget({
  actor: { id: "actor_region_east" },
  objectType: "EntityA",
  primaryKey: "EA-000002",
})));
check("guessed invisible action target denied across every entry", guessedTargetErrors.every((code) => code === "OBJECT_NOT_ACCESSIBLE"), guessedTargetErrors);

const traversalRequest = {
  actor: { id: "actor_region_east" },
  startObjectType: "EntityA",
  startPrimaryKey: "EA-000273",
  path: [{ linkType: "LinkAB", direction: "out" }],
  select: ["id", "name", "region"],
  pageSize: 20,
};
const traversals = await acrossEntries((adapter) => adapter.traverse(traversalRequest));
check("link traversal identical across every entry", allJsonEqual(traversals), summarizeRows(traversals));
check("link target policy prevents count leakage", traversals[0].rows.length > 0 && traversals[0].rows.every((row) => row.region === "EAST"), traversals[0]);

const delegated = await adapters.objectApi.aggregate({
  actor: { id: "delegated_east" },
  objectType: "EntityA",
  query: { measures: [{ op: "count", as: "objects" }] },
});
const service = await adapters.objectApi.aggregate({
  actor: { id: "service_reader" },
  objectType: "EntityA",
  query: { measures: [{ op: "count", as: "objects" }] },
});
check("on-behalf-of uses intersection, never service union", Number(delegated.rows[0]?.objects) === 5_000 && Number(service.rows[0]?.objects) === 20_000, { delegated, service });
check("delegated action capability remains denied", benchmarkPolicies.delegated_east.actionsAllowed === false, benchmarkPolicies.delegated_east);

policyStore.set("revocable_actor", benchmarkPolicies.actor_all);
await adapters.objectApi.search({
  actor: { id: "revocable_actor" },
  objectType: "EntityA",
  query: { select: ["id"], page: { size: 1 } },
});
const revokedAt = performance.now();
policyStore.delete("revocable_actor");
const revocationError = await captureError(() => adapters.objectApi.search({
  actor: { id: "revocable_actor" },
  objectType: "EntityA",
  query: { select: ["id"], page: { size: 1 } },
}));
const revocationLatencyMs = performance.now() - revokedAt;
check("revocation is effective within five seconds", revocationError === "RESOURCE_FORBIDDEN" && revocationLatencyMs < 5_000, { revocationError, revocationLatencyMs });

const auditText = JSON.stringify(audits);
check("audit contains no raw sensitive value or denied property name", !auditText.includes("SC-") && !auditText.includes("sensitiveCode"), { auditEvents: audits.length });
check("all configured entries produced audit evidence", new Set(audits.map((item) => item.entryPoint)).size === ENTRY_POINTS.length, [...new Set(audits.map((item) => item.entryPoint))]);

const report = {
  status: assertions.every((item) => item.passed) ? "PASS" : "FAIL",
  scope: "database-backed-shared-policy-vectors",
  fixture,
  entryPoints: ENTRY_POINTS,
  executionCount: executions.length,
  auditEventCount: audits.length,
  assertions,
};
await writeJson(join(evidenceDirectory, "environment.json"), {
  timestamp,
  hostname: hostname(),
  platform: platform(),
  osRelease: release(),
  nodeVersion: process.version,
});
await writeJson(join(evidenceDirectory, "result.json"), report);
await writeJson(join(evidenceDirectory, "audit-sanitized.json"), audits);
await writeFile(join(evidenceDirectory, "command.txt"), "npm run spike:c\n", "utf8");
process.stdout.write(`${JSON.stringify({ evidenceDirectory, ...report }, null, 2)}\n`);
if (report.status !== "PASS") {
  process.exitCode = 1;
}

async function acrossEntries(operation) {
  return Promise.all(ENTRY_POINTS.map((entryPoint) => operation(adapters[entryPoint])));
}

async function captureError(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return error.code ?? "UNKNOWN";
  }
}

function allJsonEqual(values) {
  return values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]));
}

function summarizeRows(values) {
  return values.map((value, index) => ({ entryPoint: ENTRY_POINTS[index], rowCount: value.rows.length }));
}

function check(name, passed, detail) {
  assertions.push({ name, passed: Boolean(passed), detail });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
