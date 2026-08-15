import pg from "pg";

import {
  executeProjectionDdlPlan,
  parseProjectionDdlCliArgs,
  ProjectionDdlError,
} from "./projection-ddl.ts";

await main();

async function main(): Promise<void> {
  let planId: string;
  try {
    planId = parseProjectionDdlCliArgs(process.argv.slice(2));
  } catch {
    writeFailure(
      null,
      "DDL_INPUT_INVALID",
      "Projection DDL Executor accepts only one persisted Plan ID.",
    );
    return;
  }
  const connectionString = process.env["ONTOS_PROJECTION_DDL_DATABASE_URL"];
  if (connectionString === undefined || connectionString.trim() === "") {
    writeFailure(
      planId,
      "DDL_INPUT_INVALID",
      "Dedicated Projection DDL database configuration is missing.",
    );
    return;
  }
  const client = new pg.Client({
    connectionString,
    application_name: "ontos-projection-ddl-executor",
  });
  try {
    await client.connect();
    const result = await executeProjectionDdlPlan(client, planId);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    const stable =
      error instanceof ProjectionDdlError
        ? error
        : new ProjectionDdlError(
            "DDL_EXECUTION_FAILED",
            "Projection DDL execution failed without exposing database or credential details.",
          );
    writeFailure(planId, stable.code, stable.message);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function writeFailure(planId: string | null, code: string, message: string): void {
  process.stdout.write(`${JSON.stringify({ ok: false, planId, code, message })}\n`);
  process.exitCode = 1;
}
