import assert from "node:assert/strict";
import test from "node:test";

import { loadProjectionDdlExecutorConfig } from "../../apps/projection-ddl-executor/src/config.ts";
import {
  parseProjectionDdlRequestId,
  ProjectionDdlExecutorError,
} from "@ontos/materialization-postgres";

const requestId = "00000000-0000-4000-8000-000000000999";

void test("production DDL CLI accepts only one persisted request ID", () => {
  assert.equal(parseProjectionDdlRequestId(["--plan-id", requestId]), requestId);
  for (const args of [
    ["--sql", "DROP TABLE runtime.object_current"],
    ["--plan-id", requestId, "--name", "raw_index"],
    ["--plan-id", "not-a-uuid"],
  ]) {
    assert.throws(
      () => parseProjectionDdlRequestId(args),
      (error: unknown) =>
        error instanceof ProjectionDdlExecutorError && error.code === "DDL_INPUT_INVALID",
    );
  }
});

void test("production DDL process rejects shared API, Worker and migration URLs", () => {
  const dedicated = "postgresql://ddl:secret@127.0.0.1:5432/ontos";
  assert.deepEqual(
    loadProjectionDdlExecutorConfig({ ONTOS_PROJECTION_DDL_DATABASE_URL: dedicated }),
    {
      databaseUrl: dedicated,
    },
  );
  for (const forbidden of [
    "ONTOS_DATABASE_URL",
    "ONTOS_API_DATABASE_URL",
    "ONTOS_WORKER_DATABASE_URL",
    "ONTOS_MIGRATION_DATABASE_URL",
  ]) {
    assert.throws(() =>
      loadProjectionDdlExecutorConfig({
        ONTOS_PROJECTION_DDL_DATABASE_URL: dedicated,
        [forbidden]: "postgresql://shared:secret@127.0.0.1:5432/ontos",
      }),
    );
  }
});
