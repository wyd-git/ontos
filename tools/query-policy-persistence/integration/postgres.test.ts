import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import pg from "pg";

import { isDatabaseMigrationError } from "../../database/errors.ts";
import { databaseMigrationDirectory, runDatabaseMigrations } from "../../database/migrator.ts";
import { resolvePostgresTestImage } from "../../database/postgres-test-image.ts";

const execFileAsync = promisify(execFile);
const postgresImage = resolvePostgresTestImage();
const database = "ontos_g20303";
const adminPassword = "local-only-g20303-admin-secret";
const runtimePassword = "local-only-g20303-runtime-secret";
const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const ids = {
  principal: "63000000-0000-4000-8000-000000000001",
  servicePrincipal: "63000000-0000-4000-8000-000000000002",
  otherPrincipal: "63000000-0000-4000-8000-000000000003",
  project: "63000000-0000-4000-8000-000000000101",
  otherProject: "63000000-0000-4000-8000-000000000102",
  binding: "63000000-0000-4000-8000-000000000201",
  serviceBinding: "63000000-0000-4000-8000-000000000202",
  rollbackBinding: "63000000-0000-4000-8000-000000000203",
  claimRevision1: "63000000-0000-4000-8000-000000000301",
  claimRevision2: "63000000-0000-4000-8000-000000000302",
  otherClaimRevision: "63000000-0000-4000-8000-000000000303",
  policyResource: "63000000-0000-4000-8000-000000000401",
  policyRevision: "63000000-0000-4000-8000-000000000402",
  policyValidation: "63000000-0000-4000-8000-000000000403",
  release: "63000000-0000-4000-8000-000000000501",
  compilation: "63000000-0000-4000-8000-000000000601",
  invalidCompilation: "63000000-0000-4000-8000-000000000602",
  artifact: "63000000-0000-4000-8000-000000000701",
  testReport: "63000000-0000-4000-8000-000000000702",
  invalidArtifact: "63000000-0000-4000-8000-000000000703",
  invalidTestReport: "63000000-0000-4000-8000-000000000704",
  lease: "63000000-0000-4000-8000-000000000801",
} as const;

void test(
  "G2-03-03 upgrades G2-02 history and enforces Identity, Policy, Epoch and Lease boundaries",
  { timeout: 180_000 },
  async () => {
    const containerName = `ontos-g20303-${process.pid}-${randomUUID().slice(0, 8)}`;
    const prefix21 = await migrationPrefixDirectory(21);
    const prefix24 = await migrationPrefixDirectory(24);
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
      "--tmpfs",
      "/var/lib/postgresql/data:rw,noexec,nosuid,size=1g",
      "--publish",
      "127.0.0.1::5432",
      postgresImage,
    ]);

    try {
      const port = await publishedPostgreSqlPort(containerName);
      const adminConfig: pg.ClientConfig = {
        host: "127.0.0.1",
        port,
        database,
        user: "postgres",
        password: adminPassword,
        application_name: "ontos-g20303-admin",
      };
      await waitForPostgreSql(adminConfig);
      const apiConfig = {
        ...adminConfig,
        user: "g20303_api_login",
        password: runtimePassword,
        application_name: "ontos-g20303-api",
      };
      const workerConfig = {
        ...adminConfig,
        user: "g20303_worker_login",
        password: runtimePassword,
        application_name: "ontos-g20303-worker",
      };
      const opsConfig = {
        ...adminConfig,
        user: "g20303_ops_login",
        password: runtimePassword,
        application_name: "ontos-g20303-ops",
      };

      let prefixHistory: readonly LedgerRow[] = [];
      await withClient(adminConfig, async (admin) => {
        const baseline = await runDatabaseMigrations(admin, { directory: prefix21 });
        assert.equal(baseline.applied.length, 21);
        await createRuntimeLogins(admin);
      });
      await withClient(apiConfig, seedHistoricalIdentity);
      await withClient(adminConfig, async (admin) => {
        prefixHistory = await migrationLedger(admin, 21);
        const upgrade = await runDatabaseMigrations(admin, { directory: prefix24 });
        assert.deepEqual(
          upgrade.applied.map(({ version }) => version),
          [22, 23, 24],
        );
        assert.equal((await runDatabaseMigrations(admin, { directory: prefix24 })).noOp, true);
        assert.deepEqual(await migrationLedger(admin, 21), prefixHistory);
        await assertHistoricalPrincipalBackfill(admin);
        await assertCatalogAndRls(admin);
      });

      await assertFreshConcurrentMigration(adminConfig, prefix24);
      await assertEveryG20303MigrationRollsBack(adminConfig);

      const listener = new pg.Client(adminConfig);
      await listener.connect();
      await listener.query("LISTEN ontos_authorization_epoch_v1");
      try {
        await withClient(apiConfig, async (api) => {
          await exercisePrincipalTypeBoundary(api);
          await exerciseClaimMappingAndEpoch(api, listener);
          await exerciseBindingAndPrincipalEpoch(api, listener);
          await exercisePolicyArtifactBoundary(api);
          await assertQueryLeaseFailsClosedWithoutServingGeneration(api);
          await assertApiPrivileges(api);
        });
      } finally {
        await listener.end();
      }
      await withClient(workerConfig, assertWorkerPrivileges);
      await withClient(opsConfig, assertOpsPrivileges);
      await withClient(adminConfig, assertImmutableOwnerBoundary);

      const artifact = {
        schemaVersion: 1,
        gate: "G2-03-03",
        status: "PASS",
        qualification: "REAL_POSTGRES_16_FORWARD_MIGRATION_AND_NON_OWNER_THIN_SLICE",
        migrations: { historicalPrefix: 21, current: 24, applied: [22, 23, 24] },
        assertions: {
          historyHashesPreserved: true,
          concurrentRunnerSingleResult: true,
          everyNewMigrationRollsBack: true,
          oldPrincipalBackfilledHuman: true,
          serviceTypeExplicit: true,
          claimMappingVersionedAndProjectBound: true,
          policyArtifactPinnedAndImmutable: true,
          authorizationEpochTransactionalAndNotified: true,
          directEpochMutationDenied: true,
          queryLeaseRequiresRealServingGeneration: true,
          runtimeRolesLeastPrivilege: true,
          rlsForced: true,
        },
      };
      const [{ stdout: commit }, { stdout: status }] = await Promise.all([
        execFileAsync("git", ["rev-parse", "HEAD"]),
        execFileAsync("git", ["status", "--porcelain"]),
      ]);
      const durableArtifact = {
        ...artifact,
        commit: commit.trim(),
        cleanCheckout: status.trim().length === 0,
      };
      const outputDirectory = resolve("generated/ci-report");
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        resolve(outputDirectory, "g2-03-03-postgres-persistence.json"),
        `${JSON.stringify(durableArtifact, null, 2)}\n`,
      );
      process.stdout.write(`CI_G2_03_03 ${JSON.stringify(durableArtifact)}\n`);
    } finally {
      await rm(prefix21, { recursive: true, force: true });
      await rm(prefix24, { recursive: true, force: true });
      await docker(["rm", "--force", "--volumes", containerName], true);
    }
  },
);

interface LedgerRow {
  readonly version: string;
  readonly name: string;
  readonly sha256: string;
}

async function seedHistoricalIdentity(client: pg.Client): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO authz.principals
         (principal_id, oidc_issuer, oidc_subject, display_name)
       VALUES ($1, 'https://identity.example.test', 'historical-human', 'Historical Human')`,
      [ids.principal],
    );
    await client.query(
      `INSERT INTO meta.projects (project_id, api_name, display_name)
       VALUES ($1, 'QueryPolicyProject', 'Query Policy Project')`,
      [ids.project],
    );
    await client.query(
      `INSERT INTO authz.role_bindings
         (binding_id, project_id, principal_id, scope, role)
       VALUES ($1, $2, $3, 'project', 'owner')`,
      [ids.binding, ids.project, ids.principal],
    );
    await client.query("INSERT INTO authz.authorization_epochs (project_id) VALUES ($1)", [
      ids.project,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function assertHistoricalPrincipalBackfill(client: pg.Client): Promise<void> {
  const result = await client.query<{ readonly identity_type: string }>(
    "SELECT identity_type FROM authz.principals WHERE principal_id = $1",
    [ids.principal],
  );
  assert.equal(result.rows[0]?.identity_type, "human");
}

async function assertCatalogAndRls(client: pg.Client): Promise<void> {
  const tables = await client.query<{ readonly relation: string }>(`
    SELECT table_schema || '.' || table_name AS relation
    FROM information_schema.tables
    WHERE (table_schema, table_name) IN (
      ('authz', 'claim_mapping_revisions'),
      ('authz', 'claim_mapping_heads'),
      ('authz', 'policy_compilations'),
      ('runtime', 'query_leases'),
      ('runtime', 'query_lease_generations'),
      ('ops', 'authorization_epoch_advances')
    ) ORDER BY relation`);
  assert.deepEqual(
    tables.rows.map(({ relation }) => relation),
    [
      "authz.claim_mapping_heads",
      "authz.claim_mapping_revisions",
      "authz.policy_compilations",
      "ops.authorization_epoch_advances",
      "runtime.query_lease_generations",
      "runtime.query_leases",
    ],
  );
  const rls = await client.query<{
    readonly relation: string;
    readonly enabled: boolean;
    readonly forced: boolean;
  }>(`
    SELECT namespace.nspname || '.' || relation.relname AS relation,
           relation.relrowsecurity AS enabled, relation.relforcerowsecurity AS forced
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE (namespace.nspname, relation.relname) IN (
      ('authz', 'claim_mapping_revisions'),
      ('authz', 'claim_mapping_heads'),
      ('authz', 'policy_compilations'),
      ('runtime', 'query_leases'),
      ('runtime', 'query_lease_generations')
    ) ORDER BY relation`);
  assert.equal(rls.rows.length, 5);
  assert.equal(
    rls.rows.every(({ enabled, forced }) => enabled && forced),
    true,
  );
  const provider = await client.query<{
    readonly capability_state: string;
    readonly expected_version: string;
  }>(`
    SELECT capability_state, expected_version
    FROM ops.gc_root_provider_registry
    WHERE capability_key = 'runtime.query-lease'`);
  assert.deepEqual(provider.rows[0], { capability_state: "ACTIVE", expected_version: "v1" });
}

async function exercisePrincipalTypeBoundary(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO authz.principals
       (principal_id, oidc_issuer, oidc_subject, display_name, identity_type)
     VALUES ($1, 'https://service.example.test', 'runtime-service', 'Runtime Service', 'service')`,
    [ids.servicePrincipal],
  );
  await assertPgCode(
    client.query(
      `INSERT INTO authz.principals
         (principal_id, oidc_issuer, oidc_subject, display_name, identity_type)
       VALUES ($1, 'https://identity.example.test', 'historical-human', 'Forged', 'service')`,
      [ids.otherPrincipal],
    ),
    "23505",
  );
  await assertPgCode(
    client.query("UPDATE authz.principals SET identity_type = 'service' WHERE principal_id = $1", [
      ids.principal,
    ]),
    "42501",
  );
}

async function exerciseClaimMappingAndEpoch(client: pg.Client, listener: pg.Client): Promise<void> {
  const issuer = "https://identity.example.test";
  await registerClaimMapping(client, ids.project, ids.claimRevision1, issuer, 1, digest("1"));
  const initialEpoch = await epoch(client, ids.project);
  const notification1 = nextNotification(listener);
  const activated1 = await client.query<{ control_sequence: string }>(
    `SELECT control_sequence::text
     FROM authz.activate_claim_mapping($1, $2, 'human', $3, 0, $4)`,
    [ids.project, issuer, ids.claimRevision1, initialEpoch.toString()],
  );
  assert.equal(activated1.rows[0]?.control_sequence, "1");
  assertNotification(await notification1, ids.project, initialEpoch + 1n);

  await registerClaimMapping(client, ids.project, ids.claimRevision2, issuer, 2, digest("2"));
  const beforeRollback = await epoch(client, ids.project);
  await client.query("BEGIN");
  try {
    await client.query("SELECT * FROM authz.activate_claim_mapping($1, $2, 'human', $3, 1, $4)", [
      ids.project,
      issuer,
      ids.claimRevision2,
      beforeRollback.toString(),
    ]);
    await assertPgCode(client.query("SELECT 1 / 0"), "22012");
  } finally {
    await client.query("ROLLBACK");
  }
  assert.equal(await epoch(client, ids.project), beforeRollback);
  const stillFirst = await client.query<{ claim_mapping_revision_id: string }>(
    "SELECT claim_mapping_revision_id::text FROM authz.resolve_claim_mapping($1, $2, 'human')",
    [ids.project, issuer],
  );
  assert.equal(stillFirst.rows[0]?.claim_mapping_revision_id, ids.claimRevision1);

  const notification2 = nextNotification(listener);
  await client.query("SELECT * FROM authz.activate_claim_mapping($1, $2, 'human', $3, 1, $4)", [
    ids.project,
    issuer,
    ids.claimRevision2,
    beforeRollback.toString(),
  ]);
  assertNotification(await notification2, ids.project, beforeRollback + 1n);

  await createOtherProject(client);
  await registerClaimMapping(
    client,
    ids.otherProject,
    ids.otherClaimRevision,
    issuer,
    1,
    digest("3"),
  );
  await assertPgCode(
    client.query("SELECT * FROM authz.activate_claim_mapping($1, $2, 'human', $3, 2, $4)", [
      ids.project,
      issuer,
      ids.otherClaimRevision,
      (beforeRollback + 1n).toString(),
    ]),
    "23503",
  );
  await assertPgCode(client.query("SELECT * FROM authz.claim_mapping_revisions"), "42501");
}

async function exerciseBindingAndPrincipalEpoch(
  client: pg.Client,
  listener: pg.Client,
): Promise<void> {
  const beforeBinding = await epoch(client, ids.project);
  const bindingNotification = nextNotification(listener);
  await client.query(
    `INSERT INTO authz.role_bindings
       (binding_id, project_id, principal_id, scope, role)
     VALUES ($1, $2, $3, 'project', 'viewer')`,
    [ids.serviceBinding, ids.project, ids.servicePrincipal],
  );
  assert.equal(await epoch(client, ids.project), beforeBinding + 1n);
  assertNotification(await bindingNotification, ids.project, beforeBinding + 1n);

  const beforeFailure = await epoch(client, ids.project);
  await client.query("BEGIN");
  try {
    await client.query(
      `UPDATE authz.role_bindings
       SET state = 'revoked', revoked_at = clock_timestamp(), changed_at = clock_timestamp()
       WHERE binding_id = $1`,
      [ids.serviceBinding],
    );
    await client
      .query(
        `INSERT INTO authz.role_bindings
         (binding_id, project_id, principal_id, scope, role)
       VALUES ($1, $2, $3, 'resource', 'viewer')`,
        [ids.rollbackBinding, ids.project, ids.servicePrincipal],
      )
      .catch(() => undefined);
    throw new Error("ROLLBACK_PROBE");
  } catch {
    await client.query("ROLLBACK");
  }
  assert.equal(await epoch(client, ids.project), beforeFailure);
  const binding = await client.query<{ state: string }>(
    "SELECT state FROM authz.role_bindings WHERE binding_id = $1",
    [ids.serviceBinding],
  );
  assert.equal(binding.rows[0]?.state, "active");

  const beforeDisable = await epoch(client, ids.project);
  const disableNotification = nextNotification(listener);
  await client.query(
    `UPDATE authz.principals
     SET state = 'disabled', disabled_at = clock_timestamp(), changed_at = clock_timestamp()
     WHERE principal_id = $1`,
    [ids.servicePrincipal],
  );
  assert.equal(await epoch(client, ids.project), beforeDisable + 1n);
  assertNotification(await disableNotification, ids.project, beforeDisable + 1n);
  await assertPgCode(
    client.query("UPDATE authz.authorization_epochs SET epoch = epoch + 1 WHERE project_id = $1", [
      ids.project,
    ]),
    "42501",
  );
}

async function exercisePolicyArtifactBoundary(client: pg.Client): Promise<void> {
  const contentDigest = digest("4");
  await client.query(
    `INSERT INTO meta.resources
       (resource_id, project_id, namespace, api_name, family)
     VALUES ($1, $2, 'security.runtime', 'DefaultReadPolicy', 'policy')`,
    [ids.policyResource, ids.project],
  );
  await client.query(
    `INSERT INTO meta.resource_revisions
       (revision_id, resource_id, revision_number, family, content_digest,
        content, created_by_principal_id)
     VALUES ($1, $2, 1, 'policy', $3, '{"schemaVersion":1}'::jsonb, $4)`,
    [ids.policyRevision, ids.policyResource, contentDigest, ids.principal],
  );
  await client.query(
    `INSERT INTO meta.validation_reports
       (report_id, subject_type, subject_id, resource_revision_id,
        subject_digest, validation_context_digest, validator_version, valid, issues)
     VALUES ($1, 'resource_revision', $2, $2, $3, $3,
             'policy-g2-03-v1', true, '[]'::jsonb)`,
    [ids.policyValidation, ids.policyRevision, contentDigest],
  );
  for (const state of ["validated", "published"] as const) {
    await client.query(
      "UPDATE meta.resource_revisions SET state = $2, changed_at = clock_timestamp() WHERE revision_id = $1",
      [ids.policyRevision, state],
    );
  }
  await client.query(
    `INSERT INTO meta.releases
       (release_id, project_id, release_number, manifest_digest, created_by_principal_id)
     VALUES ($1, $2, 1, $3, $4)`,
    [ids.release, ids.project, digest("5"), ids.principal],
  );
  await client.query(
    `INSERT INTO meta.release_pins
       (release_id, resource_id, revision_id, pin_order, family, content_digest)
     VALUES ($1, $2, $3, 0, 'policy', $4)`,
    [ids.release, ids.policyResource, ids.policyRevision, contentDigest],
  );
  const recorded = await client.query<{ status: string; compiler_version: string }>(
    `SELECT status, compiler_version
     FROM authz.record_policy_compilation(
       $1, $2, $3, $4, $5, $6, 'policy-sql-v1',
       $7, $8, $9, $10, 4, 4, 0, 'passed'
     )`,
    [
      ids.project,
      ids.compilation,
      ids.release,
      ids.policyResource,
      ids.policyRevision,
      contentDigest,
      ids.artifact,
      digest("6"),
      ids.testReport,
      digest("7"),
    ],
  );
  assert.deepEqual(recorded.rows[0], { status: "passed", compiler_version: "policy-sql-v1" });
  const resolved = await client.query<{ policy_compilation_id: string }>(
    "SELECT policy_compilation_id::text FROM authz.resolve_policy_compilation($1, $2, $3)",
    [ids.project, ids.release, ids.policyRevision],
  );
  assert.equal(resolved.rows[0]?.policy_compilation_id, ids.compilation);

  await assertPgCode(
    client.query(
      `SELECT * FROM authz.record_policy_compilation(
         $1, $2, $3, $4, $5, $6, 'policy-sql-v2',
         $7, $8, $9, $10, 4, 4, 0, 'passed'
       )`,
      [
        ids.project,
        ids.invalidCompilation,
        ids.release,
        ids.policyResource,
        ids.policyRevision,
        digest("8"),
        ids.invalidArtifact,
        digest("9"),
        ids.invalidTestReport,
        digest("a"),
      ],
    ),
    "23514",
  );
  await assertPgCode(client.query("SELECT * FROM authz.policy_compilations"), "42501");
  await assertPgCode(
    client.query(
      "UPDATE authz.policy_compilations SET status = 'failed' WHERE policy_compilation_id = $1",
      [ids.compilation],
    ),
    "42501",
  );
}

async function assertQueryLeaseFailsClosedWithoutServingGeneration(
  client: pg.Client,
): Promise<void> {
  await assertPgCode(
    client.query(
      `SELECT * FROM runtime.plan_query_lease(
         $1, $2, $3, $4, $5, $6, $7, $8, 'corr_g20303_no_generation', 60
       )`,
      [
        ids.project,
        ids.lease,
        ids.release,
        ids.compilation,
        digest("b"),
        (await epoch(client, ids.project)).toString(),
        digest("c"),
        digest("d"),
      ],
    ),
    "55000",
  );
}

async function assertApiPrivileges(client: pg.Client): Promise<void> {
  for (const relation of [
    "authz.claim_mapping_revisions",
    "authz.claim_mapping_heads",
    "authz.policy_compilations",
    "runtime.query_leases",
    "runtime.query_lease_generations",
    "ops.authorization_epoch_advances",
    "runtime.object_base",
    "runtime.object_current",
    "ops.gc_plans",
  ]) {
    for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const) {
      const result = await client.query<{ allowed: boolean }>(
        "SELECT has_table_privilege(current_user, $1, $2) AS allowed",
        [relation, privilege],
      );
      assert.equal(result.rows[0]?.allowed, false, `${relation}:${privilege}`);
    }
  }
  const epochUpdate = await client.query<{ allowed: boolean }>(
    "SELECT has_column_privilege(current_user, 'authz.authorization_epochs', 'epoch', 'UPDATE') AS allowed",
  );
  assert.equal(epochUpdate.rows[0]?.allowed, false);
  await assertPgCode(
    client.query("SELECT epoch FROM authz.authorization_epochs WHERE project_id = $1 FOR UPDATE", [
      ids.project,
    ]),
    "42501",
  );
  const controlledLock = await client.query<{ epoch: string }>(
    "SELECT authz.lock_authorization_epoch($1)::text AS epoch",
    [ids.project],
  );
  assert.equal(BigInt(controlledLock.rows[0]?.epoch ?? "0") >= 1n, true);
  await assertPgCode(client.query("SET ROLE migration_owner"), "42501");
}

async function assertWorkerPrivileges(client: pg.Client): Promise<void> {
  for (const relation of [
    "authz.claim_mapping_revisions",
    "authz.claim_mapping_heads",
    "authz.policy_compilations",
    "runtime.query_leases",
    "runtime.query_lease_generations",
  ]) {
    const result = await client.query<{ allowed: boolean }>(
      "SELECT has_table_privilege(current_user, $1, 'SELECT') AS allowed",
      [relation],
    );
    assert.equal(result.rows[0]?.allowed, false, relation);
  }
  const canExpire = await client.query<{ allowed: boolean }>(
    `SELECT has_function_privilege(
       current_user, 'runtime.expire_query_leases(uuid,integer)', 'EXECUTE'
     ) AS allowed`,
  );
  assert.equal(canExpire.rows[0]?.allowed, true);
}

async function assertOpsPrivileges(client: pg.Client): Promise<void> {
  const status = await client.query("SELECT * FROM ops.authorization_epoch_advance_status");
  assert.equal(status.rows.length >= 1, true);
  await assertPgCode(client.query("SELECT * FROM authz.policy_compilations"), "42501");
  await assertPgCode(client.query("SELECT * FROM runtime.object_current"), "42501");
}

async function assertImmutableOwnerBoundary(client: pg.Client): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE migration_owner");
    await client.query("SAVEPOINT principal_identity_probe");
    await assertPgCode(
      client.query(
        "UPDATE authz.principals SET identity_type = 'service' WHERE principal_id = $1",
        [ids.principal],
      ),
      "55000",
    );
    await client.query("ROLLBACK TO SAVEPOINT principal_identity_probe");
    await client.query("SAVEPOINT policy_compilation_probe");
    await assertPgCode(
      client.query(
        "UPDATE authz.policy_compilations SET status = 'failed' WHERE policy_compilation_id = $1",
        [ids.compilation],
      ),
      "55000",
    );
    await client.query("ROLLBACK TO SAVEPOINT policy_compilation_probe");
    await client.query("SAVEPOINT epoch_advance_probe");
    await assertPgCode(
      client.query(
        "UPDATE ops.authorization_epoch_advances SET advanced_at = clock_timestamp() WHERE project_id = $1",
        [ids.project],
      ),
      "55000",
    );
    await client.query("ROLLBACK TO SAVEPOINT epoch_advance_probe");
  } finally {
    await client.query("ROLLBACK");
  }
}

async function registerClaimMapping(
  client: pg.Client,
  projectId: string,
  revisionId: string,
  issuer: string,
  revisionNumber: number,
  mappingDigest: string,
): Promise<void> {
  await client.query(
    `SELECT * FROM authz.register_claim_mapping_revision(
       $1, $2, $3, 'human', $4, $5,
       '{"schemaVersion":1,"claims":["region"]}'::jsonb, $6
     )`,
    [projectId, revisionId, issuer, revisionNumber, mappingDigest, ids.principal],
  );
}

async function createOtherProject(client: pg.Client): Promise<void> {
  await client.query(
    "INSERT INTO meta.projects (project_id, api_name, display_name) VALUES ($1, 'OtherPolicy', 'Other Policy')",
    [ids.otherProject],
  );
  await client.query("INSERT INTO authz.authorization_epochs (project_id) VALUES ($1)", [
    ids.otherProject,
  ]);
}

async function epoch(client: pg.Client, projectId: string): Promise<bigint> {
  const result = await client.query<{ readonly epoch: string }>(
    "SELECT epoch::text FROM authz.authorization_epochs WHERE project_id = $1",
    [projectId],
  );
  const value = result.rows[0]?.epoch;
  if (value === undefined) throw new Error("Authorization Epoch is missing.");
  return BigInt(value);
}

function nextNotification(client: pg.Client): Promise<pg.Notification> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      client.off("notification", onNotification);
      reject(new Error("Authorization Epoch notification timed out."));
    }, 5_000);
    const onNotification = (notification: pg.Notification): void => {
      if (notification.channel !== "ontos_authorization_epoch_v1") return;
      clearTimeout(timeout);
      client.off("notification", onNotification);
      resolvePromise(notification);
    };
    client.on("notification", onNotification);
  });
}

function assertNotification(
  notification: pg.Notification,
  projectId: string,
  expectedEpoch: bigint,
): void {
  const payload = JSON.parse(notification.payload ?? "null") as unknown;
  assert.deepEqual(payload, {
    protocolVersion: 1,
    projectId,
    epoch: Number(expectedEpoch),
  });
}

async function assertFreshConcurrentMigration(
  adminConfig: pg.ClientConfig,
  directory: string,
): Promise<void> {
  await withClient(adminConfig, (admin) => admin.query("CREATE DATABASE ontos_g20303_fresh"));
  const config = { ...adminConfig, database: "ontos_g20303_fresh" };
  const [left, right] = await Promise.all([
    withClient(config, (client) => runMigrationsWithCause(client, directory)),
    withClient(config, (client) => runMigrationsWithCause(client, directory)),
  ]);
  assert.equal(left.applied.length + right.applied.length, 24);
  assert.equal(Number(left.noOp) + Number(right.noOp), 1);
}

async function assertEveryG20303MigrationRollsBack(adminConfig: pg.ClientConfig): Promise<void> {
  const probes = new Map<number, string>([
    [22, "authz.claim_mapping_revisions"],
    [23, "runtime.query_leases"],
    [24, "ops.authorization_epoch_advances"],
  ]);
  for (const [version, relation] of probes) {
    const databaseName = `ontos_g20303_fault_${String(version)}`;
    await withClient(adminConfig, (admin) => admin.query(`CREATE DATABASE ${databaseName}`));
    const directory = await faultingMigrationDirectory(version);
    try {
      const config = { ...adminConfig, database: databaseName };
      await withClient(config, async (client) => {
        await assert.rejects(
          runDatabaseMigrations(client, { directory }),
          (error: unknown) =>
            isDatabaseMigrationError(error) && error.code === "DB_MIGRATION_EXECUTION_FAILED",
        );
        const state = await client.query<{ relation_exists: boolean; ledger_count: number }>(
          `SELECT to_regclass($1) IS NOT NULL AS relation_exists,
                  (SELECT count(*)::integer
                   FROM ontos_migration.schema_migrations) AS ledger_count`,
          [relation],
        );
        assert.deepEqual(state.rows[0], {
          relation_exists: false,
          ledger_count: version - 1,
        });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function migrationPrefixDirectory(through: number): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), `ontos-g20303-prefix-${String(through)}-`));
  for (const file of (await readdir(databaseMigrationDirectory)).sort()) {
    const version = Number(file.slice(0, 4));
    if (Number.isInteger(version) && version <= through && file.endsWith(".sql")) {
      await copyFile(resolve(databaseMigrationDirectory, file), resolve(directory, file));
    }
  }
  return directory;
}

async function faultingMigrationDirectory(version: number): Promise<string> {
  const directory = await migrationPrefixDirectory(version);
  const prefix = String(version).padStart(4, "0");
  const file = (await readdir(directory)).find((candidate) => candidate.startsWith(`${prefix}_`));
  if (file === undefined) throw new Error(`Missing migration ${prefix}.`);
  const path = resolve(directory, file);
  await writeFile(path, `${await readFile(path, "utf8")}\nSELECT 1 / 0;\n`);
  return directory;
}

async function migrationLedger(client: pg.Client, through: number): Promise<readonly LedgerRow[]> {
  const result = await client.query<LedgerRow>(
    `SELECT version::text, name, sha256
     FROM ontos_migration.schema_migrations
     WHERE version <= $1 ORDER BY version`,
    [through],
  );
  return result.rows;
}

async function createRuntimeLogins(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE ROLE g20303_api_login LOGIN PASSWORD '${runtimePassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
    CREATE ROLE g20303_worker_login LOGIN PASSWORD '${runtimePassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
    CREATE ROLE g20303_ops_login LOGIN PASSWORD '${runtimePassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
    GRANT api_runtime TO g20303_api_login;
    GRANT worker_runtime TO g20303_worker_login;
    GRANT read_only_ops TO g20303_ops_login;
  `);
}

async function runMigrationsWithCause(client: pg.Client, directory: string) {
  try {
    return await runDatabaseMigrations(client, { directory });
  } catch (error) {
    if (isDatabaseMigrationError(error) && error.cause instanceof Error) throw error.cause;
    throw error;
  }
}

async function assertPgCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === code,
  );
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
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await withClient(config, (client) => client.query("SELECT 1").then(() => undefined));
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw new Error("PostgreSQL did not become ready.");
}

async function publishedPostgreSqlPort(containerName: string): Promise<number> {
  const { stdout } = await execFileAsync("docker", ["port", containerName, "5432/tcp"]);
  const match = /:(?<port>[0-9]+)\s*$/u.exec(stdout.trim());
  const port = Number(match?.groups?.["port"]);
  if (!Number.isInteger(port) || port < 1) throw new Error("PostgreSQL port is invalid.");
  return port;
}

async function docker(arguments_: readonly string[], ignoreFailure = false): Promise<void> {
  try {
    await execFileAsync("docker", [...arguments_]);
  } catch (error) {
    if (!ignoreFailure) throw error;
  }
}
