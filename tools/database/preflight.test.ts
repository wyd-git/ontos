import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DatabaseMigrationError } from "./errors.ts";
import { assertDatabasePreflight } from "./preflight.ts";

const validBootstrap = {
  server_version_num: 160_014,
  current_user_name: "postgres",
  is_superuser: true,
  can_create_role: true,
  is_database_owner: true,
  migration_owner_exists: false,
  migration_ledger_exists: false,
  can_assume_migration_owner: false,
} as const;

void describe("DB-00 migration preflight", () => {
  void it("accepts PostgreSQL 16 with installed required extensions", () => {
    assert.doesNotThrow(() => assertDatabasePreflight(validBootstrap, new Set(["plpgsql"])));
  });

  void it("rejects an unverified PostgreSQL major before migration", () => {
    assertPreflightError(
      { ...validBootstrap, server_version_num: 170_000 },
      new Set(["plpgsql"]),
      "DB_VERSION_UNSUPPORTED",
    );
  });

  void it("rejects a missing required extension before migration", () => {
    assertPreflightError(validBootstrap, new Set(), "DB_REQUIRED_EXTENSION_MISSING");
  });

  void it("requires both database ownership and role creation for bootstrap", () => {
    assertPreflightError(
      {
        ...validBootstrap,
        is_superuser: false,
        is_database_owner: true,
        can_create_role: false,
      },
      new Set(["plpgsql"]),
      "DB_MIGRATION_PRIVILEGE_REQUIRED",
    );
    assertPreflightError(
      {
        ...validBootstrap,
        is_superuser: false,
        is_database_owner: false,
        can_create_role: true,
      },
      new Set(["plpgsql"]),
      "DB_MIGRATION_PRIVILEGE_REQUIRED",
    );
  });

  void it("requires an existing deployment identity to assume migration_owner", () => {
    assertPreflightError(
      {
        ...validBootstrap,
        is_superuser: false,
        can_create_role: false,
        is_database_owner: false,
        migration_owner_exists: true,
        migration_ledger_exists: true,
        can_assume_migration_owner: false,
      },
      new Set(["plpgsql"]),
      "DB_MIGRATION_PRIVILEGE_REQUIRED",
    );
  });
});

function assertPreflightError(
  row: Parameters<typeof assertDatabasePreflight>[0],
  installedExtensions: ReadonlySet<string>,
  code: DatabaseMigrationError["code"],
): void {
  assert.throws(
    () => assertDatabasePreflight(row, installedExtensions),
    (error: unknown) => error instanceof DatabaseMigrationError && error.code === code,
  );
}
