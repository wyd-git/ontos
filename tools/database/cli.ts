import { pathToFileURL } from "node:url";

import pg from "pg";

import { isDatabaseMigrationError } from "./errors.ts";
import { runDatabaseMigrations } from "./migrator.ts";

async function main(): Promise<void> {
  const connectionString = process.env["ONTOS_DB_MIGRATION_URL"]?.trim();
  if (!connectionString) {
    throw new Error("ONTOS_DB_MIGRATION_URL is required.");
  }

  const client = new pg.Client({
    connectionString,
    application_name: "ontos-db-migrator",
  });
  await client.connect();
  try {
    const result = await runDatabaseMigrations(client);
    process.stdout.write(
      result.noOp
        ? `DB-00 migrations: no-op (PostgreSQL ${result.serverVersionNum}).\n`
        : `DB-00 migrations: applied ${result.applied.map(({ fileName }) => fileName).join(", ")}.\n`,
    );
  } finally {
    await client.end();
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    await main();
  } catch (error) {
    if (isDatabaseMigrationError(error)) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
    } else {
      process.stderr.write("DB_MIGRATION_EXECUTION_FAILED: Database migration command failed.\n");
    }
    process.exitCode = 1;
  }
}
