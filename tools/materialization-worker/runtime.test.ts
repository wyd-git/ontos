import assert from "node:assert/strict";
import test from "node:test";

import {
  loadMaterializationWorkerConfig,
  loadProductionMaterializationWorkerConfig,
} from "../../apps/worker/src/config.ts";
import { HeartbeatLeaseRuntime } from "../../apps/worker/src/lease-runtime.ts";

const minimumConfig = Object.freeze({
  ONTOS_DATABASE_URL: "postgres://worker:secret@127.0.0.1/ontos",
  ONTOS_WORKER_INSTANCE_ID: "00000000-0000-4000-8000-000000000001",
});

void test("loads a bounded Worker-only runtime configuration", () => {
  assert.deepEqual(loadMaterializationWorkerConfig(minimumConfig), {
    databaseUrl: minimumConfig.ONTOS_DATABASE_URL,
    workerInstanceId: minimumConfig.ONTOS_WORKER_INSTANCE_ID,
    leaseSeconds: 30,
    heartbeatIntervalMilliseconds: 5000,
    idlePollMilliseconds: 250,
    dependencyBackoffMilliseconds: 1000,
    shutdownGraceMilliseconds: 15000,
    databasePoolMaximum: 4,
    databaseStatementTimeoutMilliseconds: 900000,
    databaseQueryTimeoutMilliseconds: 905000,
  });
});

void test("loads the production Worker object-store boundary without Admin credentials", () => {
  const source = {
    ...minimumConfig,
    ONTOS_S3_ENDPOINT: "http://127.0.0.1:9000",
    ONTOS_S3_REGION: "us-east-1",
    ONTOS_S3_BUCKET: "ontos-materialization",
    ONTOS_S3_ACCESS_KEY_ID: "worker-access",
    ONTOS_S3_SECRET_ACCESS_KEY: "worker-secret",
    ONTOS_S3_FORCE_PATH_STYLE: "true",
    ONTOS_S3_MAX_ATTEMPTS: "3",
  };
  assert.deepEqual(loadProductionMaterializationWorkerConfig(source), {
    ...loadMaterializationWorkerConfig(source),
    objectStore: {
      endpoint: source.ONTOS_S3_ENDPOINT,
      region: source.ONTOS_S3_REGION,
      bucket: source.ONTOS_S3_BUCKET,
      accessKeyId: source.ONTOS_S3_ACCESS_KEY_ID,
      secretAccessKey: source.ONTOS_S3_SECRET_ACCESS_KEY,
      forcePathStyle: true,
      maxAttempts: 3,
    },
  });
  assert.throws(() => loadProductionMaterializationWorkerConfig(minimumConfig));
});

void test("rejects bearer, OIDC, migration and DDL credentials from the Worker process", () => {
  for (const key of [
    "ONTOS_ADMIN_BEARER_TOKEN",
    "ONTOS_WORKER_BEARER_TOKEN",
    "ONTOS_OIDC_CLIENT_SECRET",
    "ONTOS_MIGRATION_DATABASE_URL",
    "ONTOS_DDL_EXECUTOR_DATABASE_URL",
  ]) {
    assert.throws(() => loadMaterializationWorkerConfig({ ...minimumConfig, [key]: "present" }));
  }
});

void test("rejects a heartbeat interval that cannot renew safely before lease expiry", () => {
  assert.throws(() =>
    loadMaterializationWorkerConfig({
      ...minimumConfig,
      ONTOS_WORKER_LEASE_SECONDS: "2",
      ONTOS_WORKER_HEARTBEAT_MILLISECONDS: "1000",
    }),
  );
});

void test("loads bounded database timeouts and requires the client timeout to exceed PostgreSQL", () => {
  assert.deepEqual(
    loadMaterializationWorkerConfig({
      ...minimumConfig,
      ONTOS_WORKER_DATABASE_STATEMENT_TIMEOUT_MILLISECONDS: "600000",
      ONTOS_WORKER_DATABASE_QUERY_TIMEOUT_MILLISECONDS: "605000",
    }),
    {
      ...loadMaterializationWorkerConfig(minimumConfig),
      databaseStatementTimeoutMilliseconds: 600000,
      databaseQueryTimeoutMilliseconds: 605000,
    },
  );
  assert.throws(() =>
    loadMaterializationWorkerConfig({
      ...minimumConfig,
      ONTOS_WORKER_DATABASE_STATEMENT_TIMEOUT_MILLISECONDS: "600000",
      ONTOS_WORKER_DATABASE_QUERY_TIMEOUT_MILLISECONDS: "600000",
    }),
  );
});

void test("heartbeats while a stage is running", async () => {
  const runtime = new HeartbeatLeaseRuntime(5);
  let heartbeats = 0;
  let resolveTwoHeartbeats: (() => void) | undefined;
  const twoHeartbeats = new Promise<void>((resolve) => {
    resolveTwoHeartbeats = resolve;
  });
  const result = await runtime.run({
    signal: new AbortController().signal,
    heartbeat() {
      heartbeats += 1;
      if (heartbeats >= 2) resolveTwoHeartbeats?.();
      return Promise.resolve();
    },
    async operation() {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          twoHeartbeats,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("Heartbeat was not observed.")), 2000);
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      return "complete";
    },
  });
  assert.equal(result, "complete");
  assert.ok(heartbeats >= 2);
});

void test("aborts stage work and preserves the heartbeat fencing error", async () => {
  const runtime = new HeartbeatLeaseRuntime(5);
  const fenced = new Error("fenced");
  let stageAborted = false;
  await assert.rejects(
    runtime.run({
      signal: new AbortController().signal,
      heartbeat: () => Promise.reject(fenced),
      operation: async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              stageAborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    }),
    fenced,
  );
  assert.equal(stageAborted, true);
});
