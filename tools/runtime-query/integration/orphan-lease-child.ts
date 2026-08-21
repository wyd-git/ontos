import { createHash, randomUUID } from "node:crypto";

import { parseArtifactDigest } from "@ontos/contracts";
import { PostgresRuntimeQueryContextRepository } from "@ontos/query-postgres";
import pg from "pg";

const requiredEnvironment = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "ONTOS_TEST_PROJECT_ID",
  "ONTOS_TEST_RELEASE_ID",
] as const;

for (const name of requiredEnvironment) {
  if (process.env[name]?.trim() === "") throw new Error(`${name} is required.`);
  if (process.env[name] === undefined) throw new Error(`${name} is required.`);
}

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  application_name: "ontos-g20308-orphan-owner",
  max: 1,
});
const contexts = new PostgresRuntimeQueryContextRepository(pool);
const candidate = await contexts.resolveCandidate({
  projectId: required("ONTOS_TEST_PROJECT_ID"),
  selector: { kind: "release", releaseId: required("ONTOS_TEST_RELEASE_ID") },
});
const lease = await contexts.commitLease({
  candidate,
  queryLeaseId: randomUUID(),
  identityContextHash: digest("g20308-killed-owner-identity"),
  authorizationEpoch: "7",
  policyContextHash: digest("g20308-killed-owner-policy"),
  queryHash: digest("g20308-killed-owner-query"),
  correlationId: "corr_g20308_killed_owner_0001",
  ttlSeconds: 1,
});

process.stdout.write(`LEASE_COMMITTED ${lease.queryLeaseId}\n`);
setInterval(() => undefined, 60_000);

function digest(value: string) {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required.`);
  return value;
}
