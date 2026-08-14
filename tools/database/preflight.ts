import type pg from "pg";

import { DatabaseMigrationError } from "./errors.ts";

export const supportedPostgreSqlMajors = [16] as const;
export const defaultRequiredExtensions = ["plpgsql"] as const;

interface PreflightRow {
  readonly server_version_num: number;
  readonly current_user_name: string;
  readonly is_superuser: boolean;
  readonly can_create_role: boolean;
  readonly is_database_owner: boolean;
  readonly migration_owner_exists: boolean;
  readonly migration_ledger_exists: boolean;
  readonly can_assume_migration_owner: boolean;
}

interface ExtensionRow {
  readonly name: string;
  readonly installed_version: string | null;
}

export interface DatabasePreflight {
  readonly serverVersionNum: number;
  readonly currentUser: string;
  readonly migrationOwnerExists: boolean;
  readonly migrationLedgerExists: boolean;
  readonly installedExtensions: ReadonlySet<string>;
}

export interface PreflightOptions {
  readonly requiredExtensions?: readonly string[];
  readonly supportedMajors?: readonly number[];
}

export async function inspectDatabasePreflight(
  client: pg.Client,
  options: PreflightOptions = {},
): Promise<DatabasePreflight> {
  let row: PreflightRow;
  let extensions: readonly ExtensionRow[];
  try {
    const preflightResult = await client.query<PreflightRow>(`
      SELECT current_setting('server_version_num')::integer AS server_version_num,
             current_user AS current_user_name,
             current_role_entry.rolsuper AS is_superuser,
             current_role_entry.rolcreaterole AS can_create_role,
             current_database_entry.datdba = current_role_entry.oid AS is_database_owner,
             EXISTS (
               SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'migration_owner'
             ) AS migration_owner_exists,
             pg_catalog.to_regclass('ontos_migration.schema_migrations') IS NOT NULL
               AS migration_ledger_exists,
             CASE
               WHEN EXISTS (
                 SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'migration_owner'
               ) THEN pg_catalog.pg_has_role(current_user, 'migration_owner', 'MEMBER')
               ELSE false
             END AS can_assume_migration_owner
      FROM pg_catalog.pg_roles AS current_role_entry
      JOIN pg_catalog.pg_database AS current_database_entry
        ON current_database_entry.datname = current_database()
      WHERE current_role_entry.rolname = current_user`);
    row = requiredRow(preflightResult.rows, "database preflight");

    const extensionResult = await client.query<ExtensionRow>(`
      SELECT name, installed_version
      FROM pg_catalog.pg_available_extensions`);
    extensions = extensionResult.rows;
  } catch (cause) {
    throw new DatabaseMigrationError(
      "DB_MIGRATION_EXECUTION_FAILED",
      "Database migration preflight could not be completed.",
      { cause },
    );
  }

  const installedExtensions = new Set(
    extensions.filter((extension) => extension.installed_version !== null).map(({ name }) => name),
  );
  assertDatabasePreflight(row, installedExtensions, options);

  return {
    serverVersionNum: row.server_version_num,
    currentUser: row.current_user_name,
    migrationOwnerExists: row.migration_owner_exists,
    migrationLedgerExists: row.migration_ledger_exists,
    installedExtensions,
  };
}

export function assertDatabasePreflight(
  row: PreflightRow,
  installedExtensions: ReadonlySet<string>,
  options: PreflightOptions = {},
): void {
  const supportedMajors = options.supportedMajors ?? supportedPostgreSqlMajors;
  const major = Math.floor(row.server_version_num / 10_000);
  if (!supportedMajors.includes(major)) {
    throw new DatabaseMigrationError(
      "DB_VERSION_UNSUPPORTED",
      `PostgreSQL major ${major} has not been verified for this migration set.`,
    );
  }

  const requiredExtensions = options.requiredExtensions ?? defaultRequiredExtensions;
  const missingExtensions = requiredExtensions.filter(
    (extension) => !installedExtensions.has(extension),
  );
  if (missingExtensions.length > 0) {
    throw new DatabaseMigrationError(
      "DB_REQUIRED_EXTENSION_MISSING",
      `Required PostgreSQL extensions are not installed: ${missingExtensions.join(", ")}.`,
    );
  }

  if (
    !row.migration_ledger_exists &&
    !row.is_superuser &&
    !(row.can_create_role && row.is_database_owner)
  ) {
    throw new DatabaseMigrationError(
      "DB_MIGRATION_PRIVILEGE_REQUIRED",
      "Initial database bootstrap requires a database owner that can create roles.",
    );
  }

  if (row.migration_ledger_exists && !row.is_superuser && !row.can_assume_migration_owner) {
    throw new DatabaseMigrationError(
      "DB_MIGRATION_PRIVILEGE_REQUIRED",
      "The deployment identity cannot assume migration_owner.",
    );
  }
}

function requiredRow<T>(rows: readonly T[], label: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`${label} returned no row.`);
  return row;
}
