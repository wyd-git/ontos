import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeProjectionDdlRequest,
  parseProjectionDdlRequestId,
  ProjectionDdlExecutorError,
} from "@ontos/materialization-postgres";
import pg from "pg";

import { loadProjectionDdlExecutorConfig } from "./config.ts";

export async function runProjectionDdlExecutor(args: readonly string[]): Promise<void> {
  const requestId = parseProjectionDdlRequestId(args);
  const config = loadProjectionDdlExecutorConfig();
  const client = new pg.Client({
    connectionString: config.databaseUrl,
    application_name: "ontos-projection-ddl-executor-bootstrap",
    statement_timeout: 0,
    lock_timeout: 0,
    query_timeout: 0,
  });
  await client.connect();
  try {
    const result = await executeProjectionDdlRequest(client, requestId);
    process.stdout.write(
      `${JSON.stringify({
        requestId: result.requestId,
        indexName: result.indexName,
        outcome: result.outcome,
        attemptCount: result.attemptCount,
        catalogDigest: result.catalogDigest,
        observedBytes: result.observedBytes.toString(),
      })}\n`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runProjectionDdlExecutor(process.argv.slice(2)).catch((error: unknown) => {
    const code = error instanceof ProjectionDdlExecutorError ? error.code : "DDL_EXECUTION_FAILED";
    process.stderr.write(`${JSON.stringify({ code })}\n`);
    process.exitCode = 1;
  });
}
