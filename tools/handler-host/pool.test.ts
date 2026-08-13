import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { FIXTURE_ARTIFACT_DIGESTS } from "./catalog.ts";
import { emptyInvocationContext } from "./context.ts";
import { buildHandlerHostEnvironment } from "./launch.ts";
import { HandlerHostError, HandlerHostPool } from "./pool.ts";
import type { InvocationContextData, InvocationRequest, JsonObject } from "./protocol.ts";

const sensitiveEnvironmentNames = [
  "DATABASE_URL",
  "PGPASSWORD",
  "ONTOS_POSTGRES_SUPERUSER_PASSWORD",
  "ONTOS_DB_RUNTIME_PASSWORD",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "ONTOS_S3_ACCESS_KEY_ID",
  "ONTOS_S3_SECRET_ACCESS_KEY",
  "ONTOS_OIDC_CLIENT_SECRET",
  "ONTOS_OIDC_ADMIN_PASSWORD",
  "REGISTRY_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "NODE_OPTIONS",
] as const;

void test(
  "independent Handler Host enforces credentials, Context, capabilities and lifecycle",
  { timeout: 20_000 },
  async (suite) => {
    const previousEnvironment = new Map(
      sensitiveEnvironmentNames.map((name) => [name, process.env[name]]),
    );
    for (const name of sensitiveEnvironmentNames) process.env[name] = `parent-secret-${name}`;
    const pool = new HandlerHostPool({ size: 1, startupTimeoutMs: 5_000, terminationGraceMs: 100 });
    await pool.start();
    suite.after(async () => {
      await pool.stop();
      for (const [name, previous] of previousEnvironment) {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    });

    await suite.test("normal typed Artifact and authorized Query succeed", async () => {
      const echo = await pool.invoke(request(FIXTURE_ARTIFACT_DIGESTS.echo, { message: "ok" }));
      assert.deepEqual(echo.result, { message: "ok" });

      const query = await pool.invoke(
        request(
          FIXTURE_ARTIFACT_DIGESTS.queryObject,
          { objectRid: "ri.ontos.object.work-item-1" },
          queryContext(),
        ),
      );
      assert.deepEqual(query.result, {
        objectRid: "ri.ontos.object.work-item-1",
        objectVersion: "version-7",
        properties: { priority: 3, status: "OPEN" },
      });
    });

    await suite.test("Host environment is a strict non-secret allowlist", async () => {
      assert.deepEqual(buildHandlerHostEnvironment(), {
        LANG: "C",
        LC_ALL: "C",
        ONTOS_HANDLER_HOST_PROTOCOL: "1",
        TZ: "UTC",
      });
      const result = await pool.invoke(
        request(FIXTURE_ARTIFACT_DIGESTS.capabilityProbe, { capability: "environment" }),
      );
      assert.deepEqual(result.result, { present: [] });
    });

    await suite.test("undeclared Query and Read Set expansion are rejected", async () => {
      await assertHostError(
        pool.invoke(
          request(
            FIXTURE_ARTIFACT_DIGESTS.queryObject,
            { objectRid: "ri.ontos.object.work-item-1" },
            emptyInvocationContext(),
          ),
        ),
        "QUERY_NOT_DECLARED",
      );
      await assertHostError(
        pool.invoke(
          request(
            FIXTURE_ARTIFACT_DIGESTS.queryObject,
            { objectRid: "ri.ontos.object.work-item-2" },
            queryContext(),
          ),
        ),
        "READ_SET_VIOLATION",
      );
      const propertyLimited = queryContext();
      await assertHostError(
        pool.invoke(
          request(
            FIXTURE_ARTIFACT_DIGESTS.queryObject,
            { objectRid: "ri.ontos.object.work-item-1" },
            {
              ...propertyLimited,
              readSet: [
                {
                  queryName: "object.get",
                  objectRid: "ri.ontos.object.work-item-1",
                  properties: ["status"],
                },
              ],
              queryResults: [
                {
                  queryName: "object.get",
                  objectRid: "ri.ontos.object.work-item-1",
                  objectVersion: "version-7",
                  properties: { status: "OPEN" },
                },
              ],
            },
          ),
        ),
        "READ_SET_VIOLATION",
      );
    });

    await suite.test("network, filesystem and process capabilities are denied", async () => {
      const pid = pool.workerPids[0];
      for (const capability of [
        "networkFetch",
        "networkHttp",
        "networkHttp2",
        "networkTcp",
        "networkTls",
        "networkUdp",
        "networkDns",
      ]) {
        await assertHostError(
          pool.invoke(request(FIXTURE_ARTIFACT_DIGESTS.capabilityProbe, { capability })),
          "NETWORK_ACCESS_DENIED",
        );
      }
      for (const capability of ["filesystemRead", "filesystemWrite", "childProcess", "worker"]) {
        await assertHostError(
          pool.invoke(request(FIXTURE_ARTIFACT_DIGESTS.capabilityProbe, { capability })),
          "SYSTEM_CAPABILITY_DENIED",
        );
      }
      assert.equal(pool.workerPids[0], pid);
      assert.deepEqual(
        (await pool.invoke(request(FIXTURE_ARTIFACT_DIGESTS.echo, { message: "still-ready" })))
          .result,
        { message: "still-ready" },
      );
    });

    await suite.test("raw Artifact exceptions are redacted", async () => {
      const error = await captureHostError(
        pool.invoke(request(FIXTURE_ARTIFACT_DIGESTS.throwError, {})),
      );
      assert.equal(error.code, "HANDLER_EXECUTION_FAILED");
      assert.equal(error.message, "Artifact execution failed.");
      assert.equal(String(error.stack).includes("RAW-HANDLER-SECRET"), false);
    });

    await suite.test(
      "an infinite loop is killed within timeout plus one second and replaced",
      async () => {
        const previousPid = pool.workerPids[0];
        const startedAt = performance.now();
        await assertHostError(
          pool.invoke(
            request(FIXTURE_ARTIFACT_DIGESTS.infiniteLoop, {}, emptyInvocationContext(), 100),
          ),
          "HANDLER_TIMEOUT",
        );
        const elapsedMs = performance.now() - startedAt;
        assert.ok(elapsedMs <= 1_100, `hard timeout took ${String(elapsedMs)}ms`);
        const after = await pool.invoke(
          request(FIXTURE_ARTIFACT_DIGESTS.echo, { message: "after-timeout" }),
        );
        assert.deepEqual(after.result, { message: "after-timeout" });
        assert.notEqual(after.hostPid, previousPid);
      },
    );

    await suite.test(
      "active Host kill rejects the call and replacement remains usable",
      async () => {
        const rejection = assertHostError(
          pool.invoke(
            request(FIXTURE_ARTIFACT_DIGESTS.infiniteLoop, {}, emptyInvocationContext(), 900),
          ),
          "HOST_EXITED",
        );
        await delay(50);
        const replacement = pool.killOneForTest();
        await rejection;
        const pids = await replacement;
        assert.notEqual(pids.previousPid, pids.replacementPid);
        assert.deepEqual(
          (await pool.invoke(request(FIXTURE_ARTIFACT_DIGESTS.echo, { message: "after-kill" })))
            .result,
          { message: "after-kill" },
        );
      },
    );

    await suite.test(
      "explicit Pool restart creates a new generation and accepts calls",
      async () => {
        const previousPid = pool.workerPids[0];
        await pool.restart();
        assert.notEqual(pool.workerPids[0], previousPid);
        assert.deepEqual(
          (await pool.invoke(request(FIXTURE_ARTIFACT_DIGESTS.echo, { message: "after-restart" })))
            .result,
          { message: "after-restart" },
        );
      },
    );
  },
);

function request(
  artifactDigest: string,
  parameters: JsonObject,
  context: InvocationContextData = emptyInvocationContext(),
  timeoutMs = 500,
): InvocationRequest {
  return {
    artifactDigest,
    artifactRevision: "rev-1",
    releaseId: "release-1",
    correlationId: "correlation-1",
    timeoutMs,
    parameters,
    context,
  };
}

function queryContext(): InvocationContextData {
  return {
    declaredQueries: ["object.get"],
    maximumReads: 2,
    readSet: [
      {
        queryName: "object.get",
        objectRid: "ri.ontos.object.work-item-1",
        properties: ["status", "priority"],
      },
    ],
    queryResults: [
      {
        queryName: "object.get",
        objectRid: "ri.ontos.object.work-item-1",
        objectVersion: "version-7",
        properties: { status: "OPEN", priority: 3 },
      },
    ],
  };
}

async function assertHostError(
  promise: Promise<unknown>,
  code: HandlerHostError["code"],
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof HandlerHostError && error.code === code,
  );
}

async function captureHostError(promise: Promise<unknown>): Promise<HandlerHostError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HandlerHostError) return error;
    throw error;
  }
  throw new Error("Expected HandlerHostError.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
