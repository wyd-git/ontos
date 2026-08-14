import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";

import {
  MetadataApplicationError,
  MetadataApplicationService,
  RoleMatrixManagementAuthorizer,
  parseVerifiedFoundationIdentity,
  type VerifiedFoundationIdentity,
} from "@ontos/metadata-application";
import { MANAGEMENT_PERMISSIONS, type ManagementRole } from "@ontos/metadata-domain";
import { PostgresMetadataControlPlane } from "@ontos/metadata-postgres";
import pg from "pg";

import { runDatabaseMigrations } from "../../database/migrator.ts";

const execFileAsync = promisify(execFile);
const postgresImage =
  "postgres:16.14-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8";
const database = "ontos_g20104";
const adminPassword = "local-only-g20104-admin-secret";
const runtimePassword = "local-only-g20104-runtime-secret";

void test(
  "G2-01-04 PostgreSQL Project, Principal, Role Binding and Epoch transactions",
  { timeout: 120_000 },
  async () => {
    const containerName = `ontos-g20104-${process.pid}-${randomUUID().slice(0, 8)}`;
    await docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--env",
      `POSTGRES_PASSWORD=${adminPassword}`,
      "--env",
      `POSTGRES_DB=${database}`,
      "--publish",
      "127.0.0.1::5432",
      postgresImage,
    ]);

    let pool: pg.Pool | null = null;
    try {
      const port = await publishedPostgreSqlPort(containerName);
      const adminConfig: pg.ClientConfig = {
        host: "127.0.0.1",
        port,
        database,
        user: "postgres",
        password: adminPassword,
        application_name: "ontos-g2-01-04-admin",
      };
      await waitForPostgreSql(adminConfig);
      await withClient(adminConfig, async (admin) => {
        await runDatabaseMigrations(admin);
        await admin.query(`ALTER ROLE api_runtime LOGIN PASSWORD '${runtimePassword}'`);
      });

      pool = new pg.Pool({
        ...adminConfig,
        user: "api_runtime",
        password: runtimePassword,
        application_name: "ontos-g2-01-04-runtime",
        max: 8,
      });
      const store = new PostgresMetadataControlPlane(pool);
      const authorizer = new RoleMatrixManagementAuthorizer(store);
      const application = new MetadataApplicationService({
        principals: store,
        projects: store,
        roleBindings: store,
        authorizer,
      });

      const ownerIdentity = identity("owner");
      const concurrentPrincipals = await Promise.all(
        Array.from({ length: 12 }, () => store.resolveVerifiedIdentity(ownerIdentity)),
      );
      assert.equal(new Set(concurrentPrincipals.map(({ principalId }) => principalId)).size, 1);
      const ownerPrincipal = concurrentPrincipals[0];
      assert.ok(ownerPrincipal);

      const creation = await application.createProject(ownerIdentity, {
        apiName: "Commerce",
        displayName: "Commerce Control Plane",
      });
      assert.equal(creation.ownerBinding.principalId, ownerPrincipal.principalId);
      assert.equal(creation.ownerBinding.role, "owner");
      assert.equal(creation.authorizationEpoch, 1n);
      await assertProjectCreationFacts(
        pool,
        creation.project.projectId,
        ownerPrincipal.principalId,
      );

      const failedProjectId = randomUUID();
      const collidingProjectStore = new PostgresMetadataControlPlane(
        pool,
        sequenceUuidFactory([failedProjectId, creation.ownerBinding.bindingId]),
      );
      await assert.rejects(
        collidingProjectStore.createProjectWithOwner({
          principalId: ownerPrincipal.principalId,
          apiName: "AtomicFailure",
          displayName: "Must Roll Back",
        }),
        isApplicationError("ALREADY_EXISTS"),
      );
      await assertNoProjectFacts(pool, failedProjectId);

      const disabledIdentity = identity("disabled");
      const disabledPrincipal = await store.resolveVerifiedIdentity(disabledIdentity);
      await pool.query(
        `UPDATE authz.principals
         SET state = 'disabled', disabled_at = clock_timestamp(), changed_at = clock_timestamp()
         WHERE principal_id = $1`,
        [disabledPrincipal.principalId],
      );
      await assert.rejects(
        application.createProject(disabledIdentity, {
          apiName: "DisabledProject",
          displayName: "Disabled Project",
        }),
        isApplicationError("FORBIDDEN"),
      );

      const identities = {
        editor: identity("editor"),
        viewer: identity("viewer"),
        executor: identity("executor"),
        auditor: identity("auditor"),
      } as const;
      const principals = {
        editor: await store.resolveVerifiedIdentity(identities.editor),
        viewer: await store.resolveVerifiedIdentity(identities.viewer),
        executor: await store.resolveVerifiedIdentity(identities.executor),
        auditor: await store.resolveVerifiedIdentity(identities.auditor),
      } as const;
      let epoch = creation.authorizationEpoch;
      const assignedBindings = new Map<ManagementRole, string>();
      for (const role of ["editor", "viewer", "executor", "auditor"] as const) {
        const replacement = await application.replaceRoleBinding(ownerIdentity, {
          projectId: creation.project.projectId,
          targetPrincipalId: principals[role].principalId,
          role,
          expectedEpoch: epoch,
        });
        assert.equal(replacement.changed, true);
        assert.equal(replacement.authorizationEpoch, epoch + 1n);
        assert.ok(replacement.activeBinding);
        assignedBindings.set(role, replacement.activeBinding.bindingId);
        epoch = replacement.authorizationEpoch;
      }

      const expectedByRole: Readonly<Record<ManagementRole, readonly string[]>> = {
        owner: [...MANAGEMENT_PERMISSIONS],
        editor: ["metadata.read", "metadata.edit"],
        viewer: ["metadata.read"],
        executor: [],
        auditor: [],
      };
      for (const role of ["owner", "editor", "viewer", "executor", "auditor"] as const) {
        const actorIdentity = role === "owner" ? ownerIdentity : identities[role];
        for (const permission of MANAGEMENT_PERMISSIONS) {
          assert.equal(
            await application.authorizeManagement(actorIdentity, {
              projectId: creation.project.projectId,
              permission,
            }),
            expectedByRole[role].includes(permission),
            `${role}:${permission}`,
          );
        }
      }

      const resourceId = randomUUID();
      await pool.query(
        `INSERT INTO meta.resources (resource_id, project_id, namespace, api_name, family)
         VALUES ($1, $2, 'commerce.orders', 'Order', 'object_type')`,
        [resourceId, creation.project.projectId],
      );
      for (const [role, resourceRole] of [
        ["editor", "viewer"],
        ["viewer", "owner"],
        ["executor", "owner"],
      ] as const) {
        const replacement = await application.replaceRoleBinding(ownerIdentity, {
          projectId: creation.project.projectId,
          targetPrincipalId: principals[role].principalId,
          resourceId,
          role: resourceRole,
          expectedEpoch: epoch,
        });
        epoch = replacement.authorizationEpoch;
      }
      assert.equal(
        await application.authorizeManagement(identities.editor, {
          projectId: creation.project.projectId,
          resourceId,
          permission: "metadata.read",
        }),
        true,
      );
      assert.equal(
        await application.authorizeManagement(identities.editor, {
          projectId: creation.project.projectId,
          resourceId,
          permission: "metadata.edit",
        }),
        false,
      );
      for (const actorIdentity of [identities.viewer, identities.executor]) {
        assert.equal(
          await application.authorizeManagement(actorIdentity, {
            projectId: creation.project.projectId,
            resourceId,
            permission: "metadata.edit",
          }),
          false,
        );
      }

      const foreignCreation = await application.createProject(identity("foreign-owner"), {
        apiName: "ForeignProject",
        displayName: "Foreign Project",
      });
      const foreignResourceId = randomUUID();
      await pool.query(
        `INSERT INTO meta.resources (resource_id, project_id, namespace, api_name, family)
         VALUES ($1, $2, 'foreign.resource', 'Foreign', 'object_type')`,
        [foreignResourceId, foreignCreation.project.projectId],
      );
      assert.equal(
        await application.authorizeManagement(ownerIdentity, {
          projectId: creation.project.projectId,
          resourceId: foreignResourceId,
          permission: "metadata.read",
        }),
        false,
      );

      const noOp = await application.replaceRoleBinding(ownerIdentity, {
        projectId: creation.project.projectId,
        targetPrincipalId: principals.editor.principalId,
        role: "editor",
        expectedEpoch: epoch,
      });
      assert.deepEqual(
        { changed: noOp.changed, authorizationEpoch: noOp.authorizationEpoch },
        { changed: false, authorizationEpoch: epoch },
      );

      await assert.rejects(
        application.replaceRoleBinding(ownerIdentity, {
          projectId: creation.project.projectId,
          targetPrincipalId: principals.auditor.principalId,
          role: "executor",
          expectedEpoch: epoch - 1n,
        }),
        isApplicationError("CONCURRENT_MODIFICATION"),
      );
      assert.equal(await readEpoch(pool, creation.project.projectId), epoch);

      const collidingBindingStore = new PostgresMetadataControlPlane(
        pool,
        () => creation.ownerBinding.bindingId,
      );
      await assert.rejects(
        collidingBindingStore.replaceRoleBinding({
          projectId: creation.project.projectId,
          targetPrincipalId: principals.editor.principalId,
          resourceId: null,
          role: "viewer",
          expectedEpoch: epoch,
        }),
        isApplicationError("ALREADY_EXISTS"),
      );
      assert.equal(await readEpoch(pool, creation.project.projectId), epoch);
      assert.equal(
        await readActiveRole(pool, creation.project.projectId, principals.editor.principalId, null),
        "editor",
      );

      const revoked = await application.replaceRoleBinding(ownerIdentity, {
        projectId: creation.project.projectId,
        targetPrincipalId: principals.editor.principalId,
        role: null,
        expectedEpoch: epoch,
      });
      assert.equal(revoked.authorizationEpoch, epoch + 1n);
      epoch = revoked.authorizationEpoch;
      assert.equal(
        await application.authorizeManagement(identities.editor, {
          projectId: creation.project.projectId,
          permission: "metadata.read",
        }),
        false,
      );

      const releaseId = randomUUID();
      await pool.query(
        `INSERT INTO meta.releases
           (release_id, project_id, release_number, manifest_digest, created_by_principal_id)
         VALUES ($1, $2, 1, $3, $4)`,
        [
          releaseId,
          creation.project.projectId,
          `sha256:${"a".repeat(64)}`,
          ownerPrincipal.principalId,
        ],
      );
      const archived = await application.archiveProject(ownerIdentity, {
        projectId: creation.project.projectId,
        expectedEpoch: epoch,
      });
      assert.equal(archived.project.state, "archived");
      assert.equal(archived.authorizationEpoch, epoch + 1n);
      assert.equal(await rowCount(pool, "meta.resources", "resource_id", resourceId), 1);
      assert.equal(await rowCount(pool, "meta.releases", "release_id", releaseId), 1);
      assert.equal(
        await application.authorizeManagement(ownerIdentity, {
          projectId: creation.project.projectId,
          permission: "metadata.read",
        }),
        false,
      );
      await assert.rejects(
        application.createProject(identity("replacement-owner"), {
          apiName: creation.project.apiName,
          displayName: "Cannot Reuse Tombstone",
        }),
        isApplicationError("ALREADY_EXISTS"),
      );

      assert.ok(assignedBindings.get("editor"));
    } finally {
      await pool?.end();
      await docker(["rm", "--force", containerName], true);
    }
  },
);

function identity(subject: string): VerifiedFoundationIdentity {
  return parseVerifiedFoundationIdentity({
    issuer: "https://issuer.example.test",
    subject,
    displayName: `Identity ${subject}`,
    claimsFingerprint: `sha256:${subject.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`,
    authenticatedAt: "2026-08-14T00:00:00.000000Z",
  });
}

function sequenceUuidFactory(values: readonly string[]): () => string {
  const remaining = [...values];
  return () => {
    const value = remaining.shift();
    if (value === undefined) throw new Error("UUID sequence exhausted.");
    return value;
  };
}

async function assertProjectCreationFacts(
  pool: pg.Pool,
  projectId: string,
  principalId: string,
): Promise<void> {
  const result = await pool.query<{
    readonly owner_count: string;
    readonly epoch: string;
  }>(
    `SELECT COUNT(binding.binding_id)::text AS owner_count, epoch.epoch::text
     FROM authz.authorization_epochs AS epoch
     LEFT JOIN authz.role_bindings AS binding
       ON binding.project_id = epoch.project_id
      AND binding.principal_id = $2
      AND binding.scope = 'project'
      AND binding.role = 'owner'
      AND binding.state = 'active'
     WHERE epoch.project_id = $1
     GROUP BY epoch.epoch`,
    [projectId, principalId],
  );
  assert.deepEqual(result.rows[0], { owner_count: "1", epoch: "1" });
}

async function assertNoProjectFacts(pool: pg.Pool, projectId: string): Promise<void> {
  const result = await pool.query<{
    readonly projects: string;
    readonly bindings: string;
    readonly epochs: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM meta.projects WHERE project_id = $1)::text AS projects,
       (SELECT COUNT(*) FROM authz.role_bindings WHERE project_id = $1)::text AS bindings,
       (SELECT COUNT(*) FROM authz.authorization_epochs WHERE project_id = $1)::text AS epochs`,
    [projectId],
  );
  assert.deepEqual(result.rows[0], { projects: "0", bindings: "0", epochs: "0" });
}

async function readEpoch(pool: pg.Pool, projectId: string): Promise<bigint> {
  const result = await pool.query<{ readonly epoch: string }>(
    "SELECT epoch::text FROM authz.authorization_epochs WHERE project_id = $1",
    [projectId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return BigInt(row.epoch);
}

async function readActiveRole(
  pool: pg.Pool,
  projectId: string,
  principalId: string,
  resourceId: string | null,
): Promise<string | null> {
  const result = await pool.query<{ readonly role: string }>(
    `SELECT role
     FROM authz.role_bindings
     WHERE project_id = $1 AND principal_id = $2
       AND resource_id IS NOT DISTINCT FROM $3::uuid AND state = 'active'`,
    [projectId, principalId, resourceId],
  );
  return result.rows[0]?.role ?? null;
}

async function rowCount(
  pool: pg.Pool,
  table: "meta.resources" | "meta.releases",
  column: "resource_id" | "release_id",
  id: string,
): Promise<number> {
  const result = await pool.query<{ readonly count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${column} = $1`,
    [id],
  );
  return Number(result.rows[0]?.count ?? "0");
}

function isApplicationError(code: MetadataApplicationError["code"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof MetadataApplicationError && error.code === code;
}

async function withClient<T>(
  config: pg.ClientConfig,
  action: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client(config);
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}

async function waitForPostgreSql(config: pg.ClientConfig): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await withClient(config, async (client) => {
        await client.query("SELECT 1");
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("PostgreSQL integration container did not become ready.", { cause: lastError });
}

async function publishedPostgreSqlPort(containerName: string): Promise<number> {
  const { stdout } = await execFileAsync("docker", ["port", containerName, "5432/tcp"]);
  const match = /:(?<port>[0-9]+)\s*$/u.exec(stdout);
  const port = Number(match?.groups?.["port"]);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Docker did not publish a valid PostgreSQL port.");
  }
  return port;
}

async function docker(arguments_: readonly string[], ignoreFailure = false): Promise<void> {
  try {
    await execFileAsync("docker", arguments_);
  } catch (error) {
    if (!ignoreFailure) throw error;
  }
}
