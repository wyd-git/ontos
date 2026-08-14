import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertMigrationHistory,
  compileMigrationDefinitions,
  type MigrationSource,
} from "./definitions.ts";
import { DatabaseMigrationError } from "./errors.ts";

void describe("DB-00 migration definitions", () => {
  void it("orders consecutive files and hashes their raw bytes", () => {
    const definitions = compileMigrationDefinitions([
      source("0002_second.sql", "SELECT 2;\n"),
      source("0001_first.sql", "SELECT 1;\n"),
    ]);

    assert.deepEqual(
      definitions.map(({ version, name }) => ({ version, name })),
      [
        { version: 1, name: "first" },
        { version: 2, name: "second" },
      ],
    );
    assert.match(definitions[0]?.sha256 ?? "", /^[0-9a-f]{64}$/u);
  });

  void it("rejects gaps and invalid names with a stable definition error", () => {
    assertMigrationError(
      () => compileMigrationDefinitions([source("0002_gap.sql", "SELECT 2;")]),
      "DB_MIGRATION_DEFINITION_INVALID",
    );
    assertMigrationError(
      () => compileMigrationDefinitions([source("0001-Bad.sql", "SELECT 1;")]),
      "DB_MIGRATION_DEFINITION_INVALID",
    );
  });

  void it("rejects top-level transaction control but allows procedural blocks and literals", () => {
    assertMigrationError(
      () => compileMigrationDefinitions([source("0001_bad_transaction.sql", "SELECT 1; COMMIT;")]),
      "DB_MIGRATION_DEFINITION_INVALID",
    );
    assert.doesNotThrow(() =>
      compileMigrationDefinitions([
        source(
          "0001_safe_block.sql",
          "DO $$ BEGIN RAISE NOTICE 'COMMIT'; END $$; SELECT 'ROLLBACK';",
        ),
      ]),
    );
  });

  void it("accepts an exact prefix and rejects changed or database-ahead history", () => {
    const definitions = compileMigrationDefinitions([
      source("0001_first.sql", "SELECT 1;\n"),
      source("0002_second.sql", "SELECT 2;\n"),
    ]);
    const first = definitions[0];
    const second = definitions[1];
    assert.ok(first);
    assert.ok(second);

    assert.doesNotThrow(() => assertMigrationHistory(definitions, [first]));
    assertMigrationError(
      () => assertMigrationHistory(definitions, [{ ...first, sha256: "0".repeat(64) }]),
      "DB_MIGRATION_HISTORY_DIVERGED",
    );
    assertMigrationError(
      () =>
        assertMigrationHistory(definitions, [
          first,
          second,
          { version: 3, name: "ahead", sha256: "0".repeat(64) },
        ]),
      "DB_MIGRATION_HISTORY_DIVERGED",
    );
  });
});

function source(fileName: string, sql: string): MigrationSource {
  return { fileName, contents: Buffer.from(sql) };
}

function assertMigrationError(action: () => unknown, code: DatabaseMigrationError["code"]): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof DatabaseMigrationError && error.code === code,
  );
}
