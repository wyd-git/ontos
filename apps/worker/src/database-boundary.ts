import type pg from "pg";

interface WorkerBoundaryRow extends pg.QueryResultRow {
  readonly identityUnchanged: boolean;
  readonly workerMember: boolean;
  readonly apiMember: boolean;
  readonly migrationMember: boolean;
  readonly privilegedLogin: boolean;
  readonly databaseCreate: boolean;
  readonly opsCreate: boolean;
  readonly runtimeCreate: boolean;
  readonly migrationUsage: boolean;
  readonly servingWrite: boolean;
  readonly serverVersion: number;
}

export async function assertWorkerRuntimeDatabaseBoundary(pool: pg.Pool): Promise<void> {
  const result = await pool.query<WorkerBoundaryRow>(`
    SELECT
      current_user = session_user AS "identityUnchanged",
      pg_has_role(current_user, 'worker_runtime', 'member') AS "workerMember",
      pg_has_role(current_user, 'api_runtime', 'member') AS "apiMember",
      pg_has_role(current_user, 'migration_owner', 'member') AS "migrationMember",
      (SELECT role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
              OR role.rolreplication OR role.rolbypassrls
         FROM pg_roles AS role WHERE role.rolname = session_user) AS "privilegedLogin",
      has_database_privilege(current_user, current_database(), 'CREATE') AS "databaseCreate",
      has_schema_privilege(current_user, 'ops', 'CREATE') AS "opsCreate",
      has_schema_privilege(current_user, 'runtime', 'CREATE') AS "runtimeCreate",
      has_schema_privilege(current_user, 'ontos_migration', 'USAGE') AS "migrationUsage",
      has_table_privilege(
        current_user,
        'meta.runtime_activations',
        'INSERT,UPDATE,DELETE'
      ) AS "servingWrite",
      current_setting('server_version_num')::integer AS "serverVersion"
  `);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row === undefined ||
    !row.identityUnchanged ||
    !row.workerMember ||
    row.apiMember ||
    row.migrationMember ||
    row.privilegedLogin ||
    row.databaseCreate ||
    row.opsCreate ||
    row.runtimeCreate ||
    row.migrationUsage ||
    row.servingWrite ||
    row.serverVersion < 160_000
  ) {
    throw new Error("The database login does not satisfy the Worker runtime boundary.");
  }
}
