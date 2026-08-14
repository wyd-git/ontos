import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DatabaseMigrationError } from "./errors.ts";

const migrationFilePattern = /^(?<version>[0-9]{4})_(?<name>[a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/u;

export interface MigrationSource {
  readonly fileName: string;
  readonly contents: Uint8Array;
}

export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
}

export async function loadMigrationDefinitions(
  directory: string,
): Promise<readonly MigrationDefinition[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources: MigrationSource[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    sources.push({
      fileName: entry.name,
      contents: await readFile(resolve(directory, entry.name)),
    });
  }

  return compileMigrationDefinitions(sources);
}

export function compileMigrationDefinitions(
  sources: readonly MigrationSource[],
): readonly MigrationDefinition[] {
  if (sources.length === 0) {
    throw definitionError("At least one database migration is required.");
  }

  const definitions = sources.map((source) => {
    const match = migrationFilePattern.exec(source.fileName);
    if (match?.groups === undefined) {
      throw definitionError(
        `Migration file ${JSON.stringify(source.fileName)} must match NNNN_lower_snake_case.sql.`,
      );
    }

    const versionText = match.groups["version"];
    const name = match.groups["name"];
    if (versionText === undefined || name === undefined) {
      throw definitionError(`Migration file ${JSON.stringify(source.fileName)} is invalid.`);
    }

    const version = Number(versionText);
    const sql = Buffer.from(source.contents).toString("utf8");
    assertNoTransactionControl(sql, source.fileName);
    return {
      version,
      name,
      fileName: source.fileName,
      sha256: createHash("sha256").update(source.contents).digest("hex"),
      sql,
    };
  });

  definitions.sort((left, right) => left.version - right.version);
  for (const [index, definition] of definitions.entries()) {
    const expectedVersion = index + 1;
    if (definition.version !== expectedVersion) {
      throw definitionError(
        `Migration versions must be consecutive from 0001; expected ${formatVersion(expectedVersion)} but found ${formatVersion(definition.version)}.`,
      );
    }
  }

  return definitions;
}

export function assertMigrationHistory(
  definitions: readonly MigrationDefinition[],
  applied: readonly AppliedMigration[],
): void {
  if (applied.length > definitions.length) {
    throw historyError("Database migration history is ahead of this repository.");
  }

  for (const [index, row] of applied.entries()) {
    const definition = definitions[index];
    if (
      definition === undefined ||
      row.version !== index + 1 ||
      row.version !== definition.version ||
      row.name !== definition.name ||
      row.sha256 !== definition.sha256
    ) {
      throw historyError(`Database migration history diverged at version ${row.version}.`);
    }
  }
}

function definitionError(message: string): DatabaseMigrationError {
  return new DatabaseMigrationError("DB_MIGRATION_DEFINITION_INVALID", message);
}

function historyError(message: string): DatabaseMigrationError {
  return new DatabaseMigrationError("DB_MIGRATION_HISTORY_DIVERGED", message);
}

function formatVersion(version: number): string {
  return String(version).padStart(4, "0");
}

function assertNoTransactionControl(sql: string, fileName: string): void {
  const statements = topLevelStatementWords(sql);
  for (const words of statements) {
    const first = words[0];
    const second = words[1];
    const isDirectControl =
      first !== undefined &&
      ["ABORT", "BEGIN", "COMMIT", "END", "RELEASE", "ROLLBACK", "SAVEPOINT"].includes(first);
    const isCompoundControl =
      (first === "START" || first === "PREPARE") && second === "TRANSACTION";
    if (isDirectControl || isCompoundControl) {
      throw definitionError(
        `Migration file ${JSON.stringify(fileName)} contains forbidden transaction control; the runner owns transaction boundaries.`,
      );
    }
  }
}

function topLevelStatementWords(sql: string): readonly (readonly string[])[] {
  const statements: string[][] = [];
  let words: string[] = [];
  let index = 0;

  const finishStatement = (): void => {
    if (words.length > 0) statements.push(words);
    words = [];
  };

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === ";") {
      finishStatement();
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      index = skipLineComment(sql, index + 2);
      continue;
    }
    if (character === "/" && next === "*") {
      index = skipBlockComment(sql, index + 2);
      continue;
    }
    if (character === "'") {
      index = skipQuoted(sql, index + 1, "'");
      continue;
    }
    if (character === '"') {
      index = skipQuoted(sql, index + 1, '"');
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteDelimiter(sql, index);
      if (delimiter !== undefined) {
        const closing = sql.indexOf(delimiter, index + delimiter.length);
        if (closing < 0) {
          throw definitionError("Migration contains an unterminated dollar-quoted string.");
        }
        index = closing + delimiter.length;
        continue;
      }
    }
    if (character !== undefined && /[A-Za-z_]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/u.test(sql[index] ?? "")) index += 1;
      if (words.length < 2) words.push(sql.slice(start, index).toUpperCase());
      continue;
    }
    index += 1;
  }
  finishStatement();
  return statements;
}

function skipLineComment(sql: string, index: number): number {
  const newline = sql.indexOf("\n", index);
  return newline < 0 ? sql.length : newline + 1;
}

function skipBlockComment(sql: string, index: number): number {
  let depth = 1;
  while (index < sql.length && depth > 0) {
    if (sql[index] === "/" && sql[index + 1] === "*") {
      depth += 1;
      index += 2;
    } else if (sql[index] === "*" && sql[index + 1] === "/") {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  if (depth > 0) throw definitionError("Migration contains an unterminated block comment.");
  return index;
}

function skipQuoted(sql: string, index: number, quote: "'" | '"'): number {
  while (index < sql.length) {
    if (sql[index] !== quote) {
      index += 1;
      continue;
    }
    if (sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  throw definitionError("Migration contains an unterminated quoted value.");
}

function dollarQuoteDelimiter(sql: string, index: number): string | undefined {
  const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(index));
  return match?.[0];
}
