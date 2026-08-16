import { createHash, randomUUID } from "node:crypto";

import { parseArtifactDigest, type ArtifactDigest } from "@ontos/contracts";
import { GarbageCollectionService } from "@ontos/materialization-application";
import { PostgresGarbageCollectionRepository } from "@ontos/materialization-postgres";
import pg from "pg";

const projectId = argument("--project-id");
const planId = argument("--plan-id");
const connectionString = process.env.ONTOS_GC_TEST_DATABASE_URL;
if (connectionString === undefined || connectionString.trim() === "") {
  throw new Error("GC test database URL is missing.");
}

const pool = new pg.Pool({
  connectionString,
  application_name: "ontos-gc-kill-probe",
  max: 1,
});
try {
  const result = await new GarbageCollectionService({
    repository: new PostgresGarbageCollectionRepository(pool),
    crypto: { randomId: randomUUID, digestCanonicalText: digest },
    objectStore: {
      deleteVersion: () =>
        Promise.reject(new Error("The relational kill probe cannot delete object-store versions.")),
    },
    batchSize: 1,
  }).commitNext({ projectId, planId });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await pool.end();
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || value === undefined || value.startsWith("--")) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function digest(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}
