import { randomUUID } from "node:crypto";

import {
  MaterializationWorker,
  MaterializationWorkerError,
  type MaterializationJobCheckpoint,
  type MaterializationStageExecutor,
  type MaterializationWorkerRunResult,
} from "@ontos/materialization-application";
import { PostgresMaterializationJobRepository } from "@ontos/materialization-postgres";
import pg from "pg";

import type { MaterializationWorkerConfig } from "./config.ts";
import { assertWorkerRuntimeDatabaseBoundary } from "./database-boundary.ts";
import { abortableDelay, HeartbeatLeaseRuntime } from "./lease-runtime.ts";

export type MaterializationWorkerRuntimeEvent =
  | { readonly kind: "dependency_retry" }
  | {
      readonly kind: "job_result";
      readonly outcome: MaterializationWorkerRunResult["kind"];
    };

export interface MaterializationWorkerRuntimeDependencies {
  readonly executor?: MaterializationStageExecutor;
  readonly createExecutor?: (pool: pg.Pool) => MaterializationStageExecutor;
  readonly observe?: (event: MaterializationWorkerRuntimeEvent) => void;
  readonly afterCheckpoint?: (checkpoint: MaterializationJobCheckpoint) => Promise<void>;
}

export interface RunningMaterializationWorker {
  readonly pool: pg.Pool;
  readonly done: Promise<void>;
  close(): Promise<void>;
}

export async function startMaterializationWorker(
  config: MaterializationWorkerConfig,
  dependencies: MaterializationWorkerRuntimeDependencies,
): Promise<RunningMaterializationWorker> {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    application_name: "ontos-materialization-worker",
    max: config.databasePoolMaximum,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: config.databaseStatementTimeoutMilliseconds,
    query_timeout: config.databaseQueryTimeoutMilliseconds,
  });
  pool.on("error", () => {
    dependencies.observe?.(Object.freeze({ kind: "dependency_retry" }));
  });
  try {
    await assertWorkerRuntimeDatabaseBoundary(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }

  let worker: MaterializationWorker;
  try {
    if ((dependencies.executor === undefined) === (dependencies.createExecutor === undefined)) {
      throw new Error("Exactly one Worker stage executor source is required.");
    }
    const executor = dependencies.executor ?? dependencies.createExecutor?.(pool);
    if (executor === undefined) throw new Error("The Worker stage executor is unavailable.");
    worker = new MaterializationWorker({
      workerInstanceId: config.workerInstanceId,
      leaseSeconds: config.leaseSeconds,
      repository: new PostgresMaterializationJobRepository(pool),
      executor,
      leaseRuntime: new HeartbeatLeaseRuntime(config.heartbeatIntervalMilliseconds),
      crypto: { randomId: randomUUID },
      ...(dependencies.afterCheckpoint === undefined
        ? {}
        : { afterCheckpoint: dependencies.afterCheckpoint }),
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
  const controller = new AbortController();
  const done = runWorkerLoop(worker, config, controller.signal, dependencies.observe);
  let closing: Promise<void> | null = null;

  return Object.freeze({
    pool,
    done,
    close() {
      closing ??= closeWorker(pool, done, controller, config.shutdownGraceMilliseconds);
      return closing;
    },
  });
}

async function runWorkerLoop(
  worker: MaterializationWorker,
  config: MaterializationWorkerConfig,
  signal: AbortSignal,
  observe: ((event: MaterializationWorkerRuntimeEvent) => void) | undefined,
): Promise<void> {
  while (!signal.aborted) {
    let result: MaterializationWorkerRunResult;
    try {
      result = await worker.processNext(signal);
    } catch (error) {
      if (error instanceof MaterializationWorkerError && error.code === "DEPENDENCY_UNAVAILABLE") {
        observe?.(Object.freeze({ kind: "dependency_retry" }));
        await abortableDelay(config.dependencyBackoffMilliseconds, signal);
        continue;
      }
      throw error;
    }

    observe?.(Object.freeze({ kind: "job_result", outcome: result.kind }));
    if (result.kind === "stopped") return;
    if (result.kind === "idle") {
      await abortableDelay(config.idlePollMilliseconds, signal);
    }
  }
}

async function closeWorker(
  pool: pg.Pool,
  done: Promise<void>,
  controller: AbortController,
  graceMilliseconds: number,
): Promise<void> {
  controller.abort(new Error("Worker shutdown requested."));
  let loopFailure: Error | undefined;
  try {
    await withTimeout(done, graceMilliseconds);
  } catch (error) {
    loopFailure = error instanceof Error ? error : new Error("Worker loop failed.");
  }
  try {
    await pool.end();
  } catch (error) {
    loopFailure ??= error instanceof Error ? error : new Error("Worker pool close failed.");
  }
  if (loopFailure !== undefined) throw loopFailure;
}

async function withTimeout(operation: Promise<void>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Worker did not stop within the shutdown grace period.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
