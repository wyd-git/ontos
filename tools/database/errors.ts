export type DatabaseMigrationErrorCode =
  | "DB_MIGRATION_DEFINITION_INVALID"
  | "DB_MIGRATION_EXECUTION_FAILED"
  | "DB_MIGRATION_HISTORY_DIVERGED"
  | "DB_MIGRATION_PRIVILEGE_REQUIRED"
  | "DB_REQUIRED_EXTENSION_MISSING"
  | "DB_VERSION_UNSUPPORTED";

export class DatabaseMigrationError extends Error {
  readonly code: DatabaseMigrationErrorCode;

  constructor(code: DatabaseMigrationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatabaseMigrationError";
    this.code = code;
  }
}

export function isDatabaseMigrationError(value: unknown): value is DatabaseMigrationError {
  return value instanceof DatabaseMigrationError;
}
