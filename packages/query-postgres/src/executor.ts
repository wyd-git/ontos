import {
  QueryApplicationError,
  type QueryExecutionResult,
  type QueryExecutorPort,
} from "@ontos/query-application";
import type { QueryLogicalPlan } from "@ontos/query-domain";
import type pg from "pg";

import {
  assertAuthenticParameterizedQueryStatement,
  renderPostgresQuery,
  type ParameterizedQueryStatement,
} from "./renderer.ts";

export class PostgresQueryExecutor implements QueryExecutorPort {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async execute<Row extends Readonly<Record<string, unknown>>>(
    plan: QueryLogicalPlan,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<QueryExecutionResult<Row>> {
    const statement = renderPostgresQuery(plan);
    return this.executeStatement<Row>(statement, options);
  }

  async executeStatement<Row extends Readonly<Record<string, unknown>>>(
    statement: ParameterizedQueryStatement,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<QueryExecutionResult<Row>> {
    assertAuthenticParameterizedQueryStatement(statement);
    if (isAborted(options.signal)) {
      throw new QueryApplicationError({ cause: options.signal?.reason });
    }

    let client: pg.PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      throw new QueryApplicationError({ cause: error });
    }

    let destroy = false;
    let transactionStarted = false;
    try {
      if (isAborted(options.signal)) {
        destroy = true;
        throw new QueryApplicationError({ cause: options.signal?.reason });
      }
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      transactionStarted = true;
      await client.query("SET LOCAL plan_cache_mode = force_custom_plan");
      await client.query(
        "SELECT set_config('statement_timeout', $1::text, true), set_config('idle_in_transaction_session_timeout', $2::text, true)",
        [String(statement.statementTimeoutMs), String(statement.statementTimeoutMs + 1_000)],
      );
      const result = await client.query<pg.QueryResultRow>({
        text: statement.text,
        values: [...statement.values],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (result.rows.length > statement.maximumResultRows) {
        throw new PostgresQueryExecutionBoundaryError("QUERY_ROW_LIMIT_EXCEEDED");
      }
      const rows: Row[] = [];
      let byteCount = 0;
      for (const row of result.rows) {
        const frozen = Object.freeze({ ...row }) as Row;
        const json = JSON.stringify(frozen);
        if (json === undefined) {
          throw new PostgresQueryExecutionBoundaryError("QUERY_RESULT_INVALID");
        }
        byteCount += Buffer.byteLength(json, "utf8");
        if (byteCount > statement.maximumResultBytes) {
          throw new PostgresQueryExecutionBoundaryError("QUERY_BYTE_LIMIT_EXCEEDED");
        }
        rows.push(frozen);
      }
      await client.query("COMMIT");
      transactionStarted = false;
      return Object.freeze({
        rows: Object.freeze(rows),
        rowCount: rows.length,
        byteCount,
      });
    } catch (error) {
      destroy ||= isAborted(options.signal);
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroy = true;
        }
      }
      if (error instanceof QueryApplicationError) throw error;
      throw new QueryApplicationError({ cause: error });
    } finally {
      client.release(destroy);
    }
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export type PostgresQueryExecutionBoundaryErrorCode =
  "QUERY_BYTE_LIMIT_EXCEEDED" | "QUERY_RESULT_INVALID" | "QUERY_ROW_LIMIT_EXCEEDED";

export class PostgresQueryExecutionBoundaryError extends Error {
  readonly code: PostgresQueryExecutionBoundaryErrorCode;

  constructor(code: PostgresQueryExecutionBoundaryErrorCode) {
    super("PostgreSQL Query result exceeded a trusted execution boundary.");
    this.name = "PostgresQueryExecutionBoundaryError";
    this.code = code;
  }
}
