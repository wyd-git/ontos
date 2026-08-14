import { randomUUID } from "node:crypto";

import { MetadataApplicationError } from "@ontos/metadata-application";
import type {
  AuthorizationRoleSnapshot,
  ManagementAuthorizationReader,
  PrincipalDirectory,
  PrincipalRecord,
  ProjectCreation,
  ProjectRecord,
  ProjectRepository,
  RoleBindingRecord,
  RoleBindingReplacement,
  RoleBindingRepository,
  VerifiedFoundationIdentity,
} from "@ontos/metadata-application";
import type { ManagementRole } from "@ontos/metadata-domain";
import type pg from "pg";

export type UuidFactory = () => string;

interface PrincipalRow {
  readonly principal_id: string;
  readonly oidc_issuer: string;
  readonly oidc_subject: string;
  readonly display_name: string;
  readonly state: "active" | "disabled";
}

interface ProjectRow {
  readonly project_id: string;
  readonly api_name: string;
  readonly display_name: string;
  readonly state: "active" | "archived";
  readonly created_at: Date | string;
}

interface BindingRow {
  readonly binding_id: string;
  readonly project_id: string;
  readonly principal_id: string;
  readonly resource_id: string | null;
  readonly role: ManagementRole;
  readonly state: "active" | "revoked";
}

interface EpochRow {
  readonly epoch: string;
}

interface AuthorizationRow extends EpochRow {
  readonly project_state: "active" | "archived";
  readonly principal_state: "active" | "disabled";
  readonly resource_exists: boolean;
  readonly project_role: ManagementRole | null;
  readonly resource_role: ManagementRole | null;
}

export class PostgresMetadataControlPlane
  implements
    PrincipalDirectory,
    ProjectRepository,
    RoleBindingRepository,
    ManagementAuthorizationReader
{
  readonly #pool: pg.Pool;
  readonly #uuid: UuidFactory;

  constructor(pool: pg.Pool, uuidFactory: UuidFactory = randomUUID) {
    this.#pool = pool;
    this.#uuid = uuidFactory;
  }

  async resolveVerifiedIdentity(identity: VerifiedFoundationIdentity): Promise<PrincipalRecord> {
    return this.#transaction(async (client) => {
      await client.query(
        `INSERT INTO authz.principals
           (principal_id, oidc_issuer, oidc_subject, display_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (oidc_issuer, oidc_subject) DO NOTHING`,
        [this.#uuid(), identity.issuer, identity.subject, identity.displayName],
      );
      const result = await client.query<PrincipalRow>(
        `SELECT principal_id, oidc_issuer, oidc_subject, display_name, state
         FROM authz.principals
         WHERE oidc_issuer = $1 AND oidc_subject = $2`,
        [identity.issuer, identity.subject],
      );
      const row = requireRow(result.rows[0], "Principal mapping was not visible.");
      return principalRecord(row);
    });
  }

  async createProjectWithOwner(input: {
    readonly principalId: string;
    readonly apiName: string;
    readonly displayName: string;
  }): Promise<ProjectCreation> {
    const projectId = this.#uuid();
    const bindingId = this.#uuid();
    return this.#transaction(async (client) => {
      const projectResult = await client.query<ProjectRow>(
        `INSERT INTO meta.projects (project_id, api_name, display_name)
         VALUES ($1, $2, $3)
         RETURNING project_id, api_name, display_name, state, created_at`,
        [projectId, input.apiName, input.displayName],
      );
      const bindingResult = await client.query<BindingRow>(
        `INSERT INTO authz.role_bindings
           (binding_id, project_id, principal_id, scope, resource_id, role)
         VALUES ($1, $2, $3, 'project', NULL, 'owner')
         RETURNING binding_id, project_id, principal_id, resource_id, role, state`,
        [bindingId, projectId, input.principalId],
      );
      const epochResult = await client.query<EpochRow>(
        `INSERT INTO authz.authorization_epochs (project_id)
         VALUES ($1)
         RETURNING epoch::text`,
        [projectId],
      );
      return Object.freeze({
        project: projectRecord(
          requireRow(projectResult.rows[0], "Project insert returned no row."),
        ),
        ownerBinding: bindingRecord(
          requireRow(bindingResult.rows[0], "Owner Binding insert returned no row."),
        ),
        authorizationEpoch: BigInt(
          requireRow(epochResult.rows[0], "Authorization Epoch insert returned no row.").epoch,
        ),
      });
    });
  }

  async replaceRoleBinding(input: {
    readonly projectId: string;
    readonly targetPrincipalId: string;
    readonly resourceId: string | null;
    readonly role: ManagementRole | null;
    readonly expectedEpoch: bigint;
  }): Promise<RoleBindingReplacement> {
    return this.#transaction(async (client) => {
      const epoch = await lockEpoch(client, input.projectId);
      assertExpectedEpoch(epoch, input.expectedEpoch);
      const scope = input.resourceId === null ? "project" : "resource";
      const currentResult = await client.query<BindingRow>(
        `SELECT binding_id, project_id, principal_id, resource_id, role, state
         FROM authz.role_bindings
         WHERE project_id = $1
           AND principal_id = $2
           AND scope = $3
           AND resource_id IS NOT DISTINCT FROM $4::uuid
           AND state = 'active'
         FOR UPDATE`,
        [input.projectId, input.targetPrincipalId, scope, input.resourceId],
      );
      const current = currentResult.rows[0];
      if ((current?.role ?? null) === input.role) {
        return Object.freeze({
          changed: false,
          authorizationEpoch: epoch,
          activeBinding: current === undefined ? null : bindingRecord(current),
        });
      }

      if (current !== undefined) {
        await client.query(
          `UPDATE authz.role_bindings
           SET state = 'revoked', revoked_at = clock_timestamp(), changed_at = clock_timestamp()
           WHERE binding_id = $1`,
          [current.binding_id],
        );
      }

      let activeBinding: RoleBindingRecord | null = null;
      if (input.role !== null) {
        const inserted = await client.query<BindingRow>(
          `INSERT INTO authz.role_bindings
             (binding_id, project_id, principal_id, scope, resource_id, role)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING binding_id, project_id, principal_id, resource_id, role, state`,
          [
            this.#uuid(),
            input.projectId,
            input.targetPrincipalId,
            scope,
            input.resourceId,
            input.role,
          ],
        );
        activeBinding = bindingRecord(
          requireRow(inserted.rows[0], "Role Binding insert returned no row."),
        );
      }

      const nextEpoch = await incrementEpoch(client, input.projectId);
      return Object.freeze({ changed: true, authorizationEpoch: nextEpoch, activeBinding });
    });
  }

  async archiveProject(input: {
    readonly projectId: string;
    readonly expectedEpoch: bigint;
  }): Promise<{ readonly project: ProjectRecord; readonly authorizationEpoch: bigint }> {
    return this.#transaction(async (client) => {
      const epoch = await lockEpoch(client, input.projectId);
      assertExpectedEpoch(epoch, input.expectedEpoch);
      const currentResult = await client.query<ProjectRow>(
        `SELECT project_id, api_name, display_name, state, created_at
         FROM meta.projects
         WHERE project_id = $1
         FOR UPDATE`,
        [input.projectId],
      );
      const current = requireRow(currentResult.rows[0], "Project does not exist.", "NOT_FOUND");
      if (current.state === "archived") {
        return Object.freeze({ project: projectRecord(current), authorizationEpoch: epoch });
      }
      const updatedResult = await client.query<ProjectRow>(
        `UPDATE meta.projects
         SET state = 'archived', changed_at = clock_timestamp()
         WHERE project_id = $1
         RETURNING project_id, api_name, display_name, state, created_at`,
        [input.projectId],
      );
      const nextEpoch = await incrementEpoch(client, input.projectId);
      return Object.freeze({
        project: projectRecord(
          requireRow(updatedResult.rows[0], "Project archive returned no row."),
        ),
        authorizationEpoch: nextEpoch,
      });
    });
  }

  async readAuthorizationRoles(input: {
    readonly principalId: string;
    readonly projectId: string;
    readonly resourceId: string | null;
  }): Promise<AuthorizationRoleSnapshot> {
    try {
      const result = await this.#pool.query<AuthorizationRow>(
        `SELECT epoch.epoch::text,
                project.state AS project_state,
                principal.state AS principal_state,
                CASE WHEN $3::uuid IS NULL THEN TRUE ELSE EXISTS (
                  SELECT 1
                  FROM meta.resources AS resource
                  WHERE resource.project_id = epoch.project_id
                    AND resource.resource_id = $3::uuid
                ) END AS resource_exists,
                (
                  SELECT binding.role
                  FROM authz.role_bindings AS binding
                  WHERE binding.project_id = epoch.project_id
                    AND binding.principal_id = principal.principal_id
                    AND binding.scope = 'project'
                    AND binding.state = 'active'
                ) AS project_role,
                CASE WHEN $3::uuid IS NULL THEN NULL ELSE (
                  SELECT binding.role
                  FROM authz.role_bindings AS binding
                  WHERE binding.project_id = epoch.project_id
                    AND binding.principal_id = principal.principal_id
                    AND binding.scope = 'resource'
                    AND binding.resource_id = $3::uuid
                    AND binding.state = 'active'
                ) END AS resource_role
         FROM authz.authorization_epochs AS epoch
         JOIN meta.projects AS project ON project.project_id = epoch.project_id
         JOIN authz.principals AS principal ON principal.principal_id = $2
         WHERE epoch.project_id = $1`,
        [input.projectId, input.principalId, input.resourceId],
      );
      const row = requireRow(result.rows[0], "Authorization state is unavailable.", "NOT_FOUND");
      const enabled =
        row.project_state === "active" && row.principal_state === "active" && row.resource_exists;
      return Object.freeze({
        authorizationEpoch: BigInt(row.epoch),
        projectRole: enabled ? row.project_role : null,
        resourceRole: enabled ? row.resource_role : null,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async #transaction<T>(action: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      throw mapStorageError(error);
    }
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      const value = await action(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError =
          rollbackError instanceof Error ? rollbackError : new Error("Rollback failed.");
      }
      throw mapStorageError(error);
    } finally {
      client.release(releaseError);
    }
  }
}

async function lockEpoch(client: pg.PoolClient, projectId: string): Promise<bigint> {
  const result = await client.query<EpochRow>(
    `SELECT epoch::text
     FROM authz.authorization_epochs
     WHERE project_id = $1
     FOR UPDATE`,
    [projectId],
  );
  return BigInt(
    requireRow(result.rows[0], "Authorization Epoch does not exist.", "NOT_FOUND").epoch,
  );
}

async function incrementEpoch(client: pg.PoolClient, projectId: string): Promise<bigint> {
  const result = await client.query<EpochRow>(
    `UPDATE authz.authorization_epochs
     SET epoch = epoch + 1, changed_at = clock_timestamp()
     WHERE project_id = $1
     RETURNING epoch::text`,
    [projectId],
  );
  return BigInt(requireRow(result.rows[0], "Authorization Epoch update returned no row.").epoch);
}

function assertExpectedEpoch(actual: bigint, expected: bigint): void {
  if (actual !== expected) {
    throw new MetadataApplicationError(
      "CONCURRENT_MODIFICATION",
      "Authorization Epoch changed before the write.",
    );
  }
}

function principalRecord(row: PrincipalRow): PrincipalRecord {
  return Object.freeze({
    principalId: row.principal_id,
    issuer: row.oidc_issuer,
    subject: row.oidc_subject,
    displayName: row.display_name,
    state: row.state,
  });
}

function projectRecord(row: ProjectRow): ProjectRecord {
  return Object.freeze({
    projectId: row.project_id,
    apiName: row.api_name,
    displayName: row.display_name,
    state: row.state,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  });
}

function bindingRecord(row: BindingRow): RoleBindingRecord {
  return Object.freeze({
    bindingId: row.binding_id,
    projectId: row.project_id,
    principalId: row.principal_id,
    resourceId: row.resource_id,
    role: row.role,
    state: row.state,
  });
}

function requireRow<T>(
  row: T | undefined,
  message: string,
  code: "NOT_FOUND" | "STORAGE_FAILURE" = "STORAGE_FAILURE",
): T {
  if (row === undefined) throw new MetadataApplicationError(code, message);
  return row;
}

function mapStorageError(error: unknown): MetadataApplicationError {
  if (error instanceof MetadataApplicationError) return error;
  const postgresCode = postgreSqlErrorCode(error);
  if (postgresCode === "23505") {
    return new MetadataApplicationError(
      "ALREADY_EXISTS",
      "A unique metadata fact already exists.",
      {
        cause: error,
      },
    );
  }
  if (postgresCode === "23503") {
    return new MetadataApplicationError("NOT_FOUND", "A referenced metadata fact does not exist.", {
      cause: error,
    });
  }
  if (postgresCode === "22P02" || postgresCode === "23514") {
    return new MetadataApplicationError("INVALID_INPUT", "The metadata write is invalid.", {
      cause: error,
    });
  }
  if (postgresCode === "40001" || postgresCode === "40P01") {
    return new MetadataApplicationError(
      "CONCURRENT_MODIFICATION",
      "The metadata transaction must be retried from a fresh read.",
      { cause: error },
    );
  }
  return new MetadataApplicationError("STORAGE_FAILURE", "The metadata store operation failed.", {
    cause: error,
  });
}

function postgreSqlErrorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("code" in value)) return null;
  return typeof value.code === "string" ? value.code : null;
}
