import type pg from "pg";

interface RuntimeBoundaryRow {
  readonly current_user: string;
  readonly session_user: string;
  readonly migration_owner_member: boolean;
  readonly migration_schema_usage: boolean;
}

export async function assertApiRuntimeDatabaseBoundary(pool: pg.Pool): Promise<void> {
  const result = await pool.query<RuntimeBoundaryRow>(
    `SELECT current_user,
            session_user,
            pg_has_role(current_user, 'migration_owner', 'MEMBER') AS migration_owner_member,
            has_schema_privilege(current_user, 'ontos_migration', 'USAGE') AS migration_schema_usage`,
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    row.current_user !== "api_runtime" ||
    row.session_user !== "api_runtime" ||
    row.migration_owner_member ||
    row.migration_schema_usage
  ) {
    throw new Error(
      "Admin API database identity violates the api_runtime least-privilege boundary.",
    );
  }
}
