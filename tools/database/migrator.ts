import { fileURLToPath } from "node:url";

import type pg from "pg";

import {
  assertMigrationHistory,
  loadMigrationDefinitions,
  type AppliedMigration,
  type MigrationDefinition,
} from "./definitions.ts";
import { DatabaseMigrationError, isDatabaseMigrationError } from "./errors.ts";
import { inspectDatabasePreflight, type PreflightOptions } from "./preflight.ts";

export const db00MigrationDirectory = fileURLToPath(
  new URL("../../migrations/db-00/", import.meta.url),
);

export interface MigrationRunOptions extends PreflightOptions {
  readonly directory?: string;
}

export interface MigrationRunResult {
  readonly applied: readonly MigrationDefinition[];
  readonly noOp: boolean;
  readonly serverVersionNum: number;
}

const advisoryLockNamespace = 737_217;
const advisoryLockKey = 1;

export async function runDatabaseMigrations(
  client: pg.Client,
  options: MigrationRunOptions = {},
): Promise<MigrationRunResult> {
  const definitions = await loadMigrationDefinitions(options.directory ?? db00MigrationDirectory);
  const preflight = await inspectDatabasePreflight(client, options);
  const applied: MigrationDefinition[] = [];

  await acquireMigrationLock(client);
  try {
    while (true) {
      const next = await applyNextMigration(client, definitions);
      if (next === undefined) break;
      applied.push(next);
    }
  } finally {
    await releaseMigrationLock(client);
  }

  return {
    applied,
    noOp: applied.length === 0,
    serverVersionNum: preflight.serverVersionNum,
  };
}

async function applyNextMigration(
  client: pg.Client,
  definitions: readonly MigrationDefinition[],
): Promise<MigrationDefinition | undefined> {
  await client.query("BEGIN");
  try {
    if (await migrationLedgerExists(client)) {
      await client.query("SET LOCAL ROLE migration_owner");
    }

    const history = await readMigrationHistory(client);
    assertMigrationHistory(definitions, history);
    const next = definitions[history.length];
    if (next === undefined) {
      await client.query("COMMIT");
      return undefined;
    }

    await client.query(next.sql);
    await client.query(
      `INSERT INTO ontos_migration.schema_migrations
         (version, name, sha256, applied_by, applied_role, server_version_num)
       VALUES ($1, $2, $3, session_user, current_user,
               current_setting('server_version_num')::integer)`,
      [next.version, next.name, next.sha256],
    );
    await client.query("COMMIT");
    return next;
  } catch (cause) {
    await rollbackQuietly(client);
    if (isDatabaseMigrationError(cause)) throw cause;
    throw new DatabaseMigrationError(
      "DB_MIGRATION_EXECUTION_FAILED",
      "Database migration transaction failed and was rolled back.",
      { cause },
    );
  }
}

async function acquireMigrationLock(client: pg.Client): Promise<void> {
  await client.query("SELECT pg_catalog.pg_advisory_lock($1, $2)", [
    advisoryLockNamespace,
    advisoryLockKey,
  ]);
}

async function releaseMigrationLock(client: pg.Client): Promise<void> {
  await client.query("SELECT pg_catalog.pg_advisory_unlock($1, $2)", [
    advisoryLockNamespace,
    advisoryLockKey,
  ]);
}

async function readMigrationHistory(client: pg.Client): Promise<readonly AppliedMigration[]> {
  if (!(await migrationLedgerExists(client))) return [];

  const result = await client.query<AppliedMigration>(`
    SELECT version::integer, name, sha256
    FROM ontos_migration.schema_migrations
    ORDER BY version`);
  return result.rows;
}

async function migrationLedgerExists(client: pg.Client): Promise<boolean> {
  const relation = await client.query<{ readonly exists: boolean }>(`
    SELECT pg_catalog.to_regclass('ontos_migration.schema_migrations') IS NOT NULL AS exists`);
  return relation.rows[0]?.exists === true;
}

async function rollbackQuietly(client: pg.Client): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Keep the original stable migration error if rollback itself cannot be reported.
  }
}
