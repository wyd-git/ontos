import assert from "node:assert/strict";
import test from "node:test";

import { QueryApplicationError } from "@ontos/query-application";
import { compileObjectSearch } from "@ontos/query-domain";
import { PostgresQueryExecutor, renderPostgresQuery } from "@ontos/query-postgres";
import type pg from "pg";

import { objectPolicy, queryRegistry, searchRequest, sha256 } from "./fixtures.ts";

void test("executor applies timeout, row and byte limits inside a read-only transaction", async () => {
  const pool = new FakePool();
  const executor = new PostgresQueryExecutor(pool as unknown as pg.Pool);
  const plan = compileObjectSearch({
    context: {
      registry: queryRegistry(),
      requestTime: "2026-08-20T04:00:00.000000Z",
      digestCanonicalText: sha256,
      statementTimeoutMs: 321,
      maximumResultBytes: 64,
    },
    objectTypeApiName: "Customer",
    request: searchRequest({ page: { size: 1, cursor: null } }),
    policy: objectPolicy("Customer"),
  });
  pool.rows = [{ objectRid: "one", properties: {} }];
  const result = await executor.execute(plan);
  assert.equal(result.rowCount, 1);
  const first = required(pool.clients[0]);
  assert.equal(first.commands[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(first.commands[1], "SET LOCAL plan_cache_mode = force_custom_plan");
  assert.deepEqual(first.timeoutValues, ["321", "1321"]);
  assert.equal(first.commands.at(-1), "COMMIT");
  assert.deepEqual(first.releaseArguments, [false]);

  pool.rows = [
    { objectRid: "one", properties: {} },
    { objectRid: "two", properties: {} },
  ];
  await assert.rejects(
    executor.execute(plan),
    (error) =>
      error instanceof QueryApplicationError &&
      error.cause instanceof Error &&
      error.cause.message.includes("trusted execution boundary"),
  );
  const second = required(pool.clients[1]);
  assert.equal(second.commands.at(-1), "ROLLBACK");
  assert.deepEqual(second.releaseArguments, [false]);

  pool.rows = [{ objectRid: "one", properties: { huge: "x".repeat(100) } }];
  await assert.rejects(executor.execute(plan), QueryApplicationError);
  assert.equal(required(pool.clients[2]).commands.at(-1), "ROLLBACK");
});

void test("Abort destroys the active connection, stops its statement and leaves the pool reusable", async () => {
  const pool = new FakePool();
  const executor = new PostgresQueryExecutor(pool as unknown as pg.Pool);
  const plan = compileObjectSearch({
    context: {
      registry: queryRegistry(),
      requestTime: "2026-08-20T04:00:00.000000Z",
      digestCanonicalText: sha256,
    },
    objectTypeApiName: "Customer",
    request: searchRequest({ page: { size: 1, cursor: null } }),
    policy: objectPolicy("Customer"),
  });
  pool.blockUntilAbort = true;
  const controller = new AbortController();
  const pending = executor.execute(plan, { signal: controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(pending, QueryApplicationError);
  const aborted = required(pool.clients[0]);
  assert.equal(aborted.statementSettled, true);
  assert.deepEqual(aborted.releaseArguments, [true]);

  pool.blockUntilAbort = false;
  pool.rows = [{ objectRid: "after-abort", properties: {} }];
  const recovered = await executor.execute(plan);
  assert.equal(recovered.rows[0]?.objectRid, "after-abort");
  assert.deepEqual(required(pool.clients[1]).releaseArguments, [false]);
});

void test("executor does not accept a caller-forged SQL statement", async () => {
  const executor = new PostgresQueryExecutor(new FakePool() as unknown as pg.Pool);
  await assert.rejects(
    executor.executeStatement({ text: "SELECT pg_sleep(60)" } as never),
    (error) =>
      error instanceof Error && error.message === "PostgreSQL Query rendering failed closed.",
  );
  const statement = renderPostgresQuery(
    compileObjectSearch({
      context: {
        registry: queryRegistry(),
        requestTime: "2026-08-20T04:00:00.000000Z",
        digestCanonicalText: sha256,
      },
      objectTypeApiName: "Customer",
      request: searchRequest(),
      policy: objectPolicy("Customer"),
    }),
  );
  assert.notEqual(statement.text, "SELECT pg_sleep(60)");
});

class FakePool {
  readonly clients: FakeClient[] = [];
  rows: readonly Readonly<Record<string, unknown>>[] = [];
  blockUntilAbort = false;

  connect(): Promise<FakeClient> {
    const client = new FakeClient(this);
    this.clients.push(client);
    return Promise.resolve(client);
  }
}

class FakeClient {
  readonly commands: string[] = [];
  readonly releaseArguments: boolean[] = [];
  timeoutValues: readonly unknown[] | null = null;
  statementSettled = false;
  readonly #pool: FakePool;

  constructor(pool: FakePool) {
    this.#pool = pool;
  }

  async query(
    query: string | { readonly text: string; readonly signal?: AbortSignal },
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Readonly<Record<string, unknown>>[] }> {
    if (typeof query === "string") {
      this.commands.push(query);
      if (query.startsWith("SELECT set_config")) this.timeoutValues = values ?? null;
      return { rows: [] };
    }
    this.commands.push(query.text);
    if (!this.#pool.blockUntilAbort) {
      this.statementSettled = true;
      return { rows: this.#pool.rows };
    }
    return new Promise((resolve, reject) => {
      const signal = query.signal;
      if (signal === undefined) {
        reject(new Error("test expected an AbortSignal"));
        return;
      }
      const abort = (): void => {
        this.statementSettled = true;
        reject(signal.reason instanceof Error ? signal.reason : new Error("Query aborted."));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      void resolve;
    });
  }

  release(destroy = false): void {
    this.releaseArguments.push(destroy);
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test value.");
  return value;
}
