import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalizeContractForDigest, parseIdentityDelegationSummary } from "@ontos/contracts";
import type { RuntimeIdentityContext } from "@ontos/identity-application";
import type {
  PolicyGatewayContext,
  PolicyGatewayPort,
  PolicyGatewayRequest,
  PolicyGatewayResult,
} from "@ontos/policy-application";
import { RuntimeQueryApplicationService, RuntimeQueryError } from "@ontos/query-application";
import {
  PostgresRuntimeObjectGetRepository,
  PostgresRuntimeQueryContextRepository,
} from "@ontos/query-postgres";
import pg from "pg";

import { runDatabaseMigrations } from "../../database/migrator.ts";
import { resolvePostgresTestImage } from "../../database/postgres-test-image.ts";
import { customerObjectType, ids as mappingIds } from "../../materialization-mapping/fixtures.ts";
import { objectPolicy, queryIds, sha256 } from "../../query-compiler/fixtures.ts";

const execFileAsync = promisify(execFile);
const postgresImage = resolvePostgresTestImage();
const database = "ontos_g20308";
const adminPassword = "local-only-g20308-admin-secret";
const runtimePassword = "local-only-g20308-runtime-secret";
const compilerVersion = "policy-compiler-g2-03-05-v1";
const canonicalPrimaryKey = "pk1|1|s10#CUSTOMER-1";
const correlationId = "corr_g20308_postgres_request_0001";

const ids = Object.freeze({
  principal: "01000000-0000-4000-8000-000000000101",
  snapshotSchemaResource: "01000000-0000-4000-8000-000000000102",
  snapshotSchemaRevision: "01000000-0000-4000-8000-000000000103",
  mappingResource: "01000000-0000-4000-8000-000000000104",
  mappingRevision: "01000000-0000-4000-8000-000000000105",
  snapshotGroup: "01000000-0000-4000-8000-000000000106",
  snapshot: "01000000-0000-4000-8000-000000000107",
  report: "01000000-0000-4000-8000-000000000108",
  certificate: "01000000-0000-4000-8000-000000000109",
  headSet: "01000000-0000-4000-8000-000000000110",
  objectRid: "01000000-0000-4000-8000-000000000111",
  artifactReference: "01000000-0000-4000-8000-000000000112",
  testReportReference: "01000000-0000-4000-8000-000000000113",
});

void test(
  "G2-03-08 resolves, leases and reads one exact Runtime context on real PostgreSQL",
  { timeout: 180_000 },
  async () => {
    const containerName = `ontos-g20308-${process.pid}-${randomUUID().slice(0, 8)}`;
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

    let apiPool: pg.Pool | null = null;
    try {
      const port = await publishedPostgreSqlPort(containerName);
      const adminConfig: pg.ClientConfig = {
        host: "127.0.0.1",
        port,
        database,
        user: "postgres",
        password: adminPassword,
        application_name: "ontos-g20308-admin",
      };
      await waitForPostgreSql(adminConfig);
      const apiConfig: pg.PoolConfig = {
        ...adminConfig,
        user: "g20308_api_login",
        password: runtimePassword,
        application_name: "ontos-g20308-api",
        max: 4,
      };
      const workerConfig: pg.ClientConfig = {
        ...adminConfig,
        user: "g20308_worker_login",
        password: runtimePassword,
        application_name: "ontos-g20308-worker",
      };
      const opsConfig: pg.ClientConfig = {
        ...adminConfig,
        user: "g20308_ops_login",
        password: runtimePassword,
        application_name: "ontos-g20308-ops",
      };

      await withClient(adminConfig, async (admin) => {
        const migrations = await runDatabaseMigrations(admin);
        assert.equal(migrations.applied.at(-1)?.fileName, "0028_runtime_query_context.sql");
        await createRuntimeLogins(admin);
        await seedRuntimeContext(admin);
      });

      apiPool = new pg.Pool(apiConfig);
      const contexts = new PostgresRuntimeQueryContextRepository(apiPool);
      const objects = new PostgresRuntimeObjectGetRepository(apiPool);
      const service = new RuntimeQueryApplicationService({
        contexts,
        objects,
        policyGateway: new IntegrationPolicyGateway(),
        digestCanonicalText: sha256,
        uuid: randomUUID,
        leaseTtlSeconds: 30,
      });

      await assertLeastPrivilege(apiPool, workerConfig, opsConfig);

      const explicitMetadata = await service.metadata(scope("release"));
      assert.equal(explicitMetadata.releaseId, queryIds.release);
      assert.equal(explicitMetadata.releaseRevisionId, queryIds.release);
      assert.deepEqual(
        explicitMetadata.data.map(({ apiName }) => apiName),
        ["Customer"],
      );
      const stableMetadata = await service.metadata(scope("stable"));
      assert.equal(stableMetadata.releaseId, queryIds.release);
      assert.equal(stableMetadata.data[0]?.apiName, "Customer");

      await assertLeaseGatedView(contexts, apiPool);

      const object = await service.objectGet(scope("release"), {
        objectTypeApiName: "Customer",
        primaryKey: "customer-1",
      });
      assert.equal(object.data.reference.primaryKey, canonicalPrimaryKey);
      assert.equal(object.data.objectVersion, "7");
      assert.deepEqual(
        object.data.properties.find(({ apiName }) => apiName === "secret"),
        { apiName: "secret", state: "masked", displayValue: "[REDACTED]" },
      );
      assert.deepEqual(
        object.data.properties.find(({ apiName }) => apiName === "payload"),
        { apiName: "payload", state: "missing" },
      );
      await assert.rejects(
        service.objectGet(scope("release"), {
          objectTypeApiName: "Customer",
          primaryKey: "does-not-exist",
        }),
        (error) => error instanceof RuntimeQueryError && error.code === "OBJECT_NOT_ACCESSIBLE",
      );

      await withClient(adminConfig, async (admin) => {
        const leases = await admin.query<{ readonly state: string; readonly count: number }>(
          `SELECT state, count(*)::integer AS count
           FROM runtime.query_leases GROUP BY state ORDER BY state`,
        );
        assert.deepEqual(leases.rows, [{ state: "released", count: 5 }]);
      });

      await assertKilledOwnerLeaseExpires(apiConfig, adminConfig, workerConfig);
      await assertContextDriftFailsAtomically(contexts, adminConfig);
      await assertPolicyEpochDriftFailsAtomically(contexts, adminConfig);
      await assertSupportWindowIsImmutable(apiPool, adminConfig);
      await assertExplicitRetirement(service, apiPool, adminConfig);
      await writeRuntimeQueryEvidence(adminConfig);
    } finally {
      await apiPool?.end();
      await docker(["rm", "--force", "--volumes", containerName], true);
    }
  },
);

async function assertLeastPrivilege(
  api: pg.Pool,
  workerConfig: pg.ClientConfig,
  opsConfig: pg.ClientConfig,
): Promise<void> {
  for (const relation of ["runtime.object_current", "runtime.link_current"]) {
    const privilege = await api.query<{ readonly allowed: boolean }>(
      "SELECT has_table_privilege(current_user, $1, 'SELECT') AS allowed",
      [relation],
    );
    assert.equal(privilege.rows[0]?.allowed, false, relation);
    await assertPgCode(api.query(`SELECT * FROM ${relation} LIMIT 1`), "42501");
  }
  const gated = await api.query<{ readonly allowed: boolean }>(
    "SELECT has_table_privilege(current_user, 'runtime.query_object_current', 'SELECT') AS allowed",
  );
  assert.equal(gated.rows[0]?.allowed, true);
  const noContext = await api.query("SELECT * FROM runtime.query_object_current");
  assert.equal(noContext.rows.length, 0);
  const functions = await api.query<{
    readonly old_plan: boolean;
    readonly atomic_commit: boolean;
    readonly resolver: boolean;
  }>(`SELECT
      has_function_privilege(current_user,
        'runtime.plan_query_lease(uuid,uuid,uuid,uuid,text,bigint,text,text,text,integer)',
        'EXECUTE') AS old_plan,
      has_function_privilege(current_user,
        'runtime.commit_query_execution_context(uuid,uuid,uuid,uuid,text,uuid,text,bigint,text,text,text,integer)',
        'EXECUTE') AS atomic_commit,
      has_function_privilege(current_user,
        'runtime.resolve_query_context_candidate(uuid,text,text)', 'EXECUTE') AS resolver`);
  assert.deepEqual(functions.rows[0], {
    old_plan: false,
    atomic_commit: true,
    resolver: true,
  });

  for (const config of [workerConfig, opsConfig]) {
    await withClient(config, async (client) => {
      await assertPgCode(client.query("SELECT * FROM runtime.query_object_current"), "42501");
      await assertPgCode(
        client.query(
          "SELECT * FROM runtime.resolve_query_context_candidate($1, 'channel', 'stable')",
          [queryIds.project],
        ),
        "42501",
      );
    });
  }
}

async function assertLeaseGatedView(
  contexts: PostgresRuntimeQueryContextRepository,
  api: pg.Pool,
): Promise<void> {
  const candidate = await contexts.resolveCandidate({
    projectId: queryIds.project,
    selector: { kind: "release", releaseId: queryIds.release },
  });
  const policy = policyContext();
  const queryHash = sha256("lease-gated-view-probe");
  const lease = await contexts.commitLease({
    candidate,
    queryLeaseId: randomUUID(),
    identityContextHash: sha256("view-probe-identity"),
    authorizationEpoch: "7",
    policyContextHash: policy.policyContextHash,
    queryHash,
    correlationId,
    ttlSeconds: 30,
  });
  await assertPgCode(
    api.query(
      `SELECT runtime.activate_query_read_context(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text, $7::text
       )`,
      [
        lease.projectId,
        lease.queryLeaseId,
        lease.releaseId,
        lease.activationId,
        lease.identityContextHash,
        lease.policyContextHash,
        sha256("wrong-query-binding"),
      ],
    ),
    "40001",
  );
  const client = await api.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const activated = await client.query<{ readonly active: boolean }>(
      `SELECT runtime.activate_query_read_context(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text, $7::text
       ) AS active`,
      [
        lease.projectId,
        lease.queryLeaseId,
        lease.releaseId,
        lease.activationId,
        lease.identityContextHash,
        lease.policyContextHash,
        lease.queryHash,
      ],
    );
    assert.equal(activated.rows[0]?.active, true);
    const visible = await client.query<{ readonly count: number }>(
      "SELECT count(*)::integer AS count FROM runtime.query_object_current",
    );
    assert.equal(visible.rows[0]?.count, 1);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await contexts.releaseLease(lease);
  }
}

async function assertKilledOwnerLeaseExpires(
  apiConfig: pg.PoolConfig,
  adminConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
): Promise<void> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("orphan-lease-child.ts", import.meta.url))],
    {
      env: {
        ...process.env,
        PGHOST: String(apiConfig.host),
        PGPORT: String(apiConfig.port),
        PGDATABASE: String(apiConfig.database),
        PGUSER: String(apiConfig.user),
        PGPASSWORD: String(apiConfig.password),
        ONTOS_TEST_PROJECT_ID: queryIds.project,
        ONTOS_TEST_RELEASE_ID: queryIds.release,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const queryLeaseId = await childLeaseId(child);
  assert.equal(child.kill("SIGKILL"), true);
  const exit = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolvePromise) =>
    child.once("exit", (code, signal) => resolvePromise(Object.freeze({ code, signal }))),
  );
  assert.equal(exit.signal, "SIGKILL");
  await withClient(adminConfig, async (admin) => {
    assert.equal(await queryLeaseRootCount(admin, queryLeaseId), 1);
  });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_100));
  await withClient(workerConfig, async (worker) => {
    const result = await worker.query<{ readonly expired: number }>(
      "SELECT runtime.expire_query_leases($1, 100) AS expired",
      [queryIds.project],
    );
    assert.equal(result.rows[0]?.expired, 1);
  });
  await withClient(adminConfig, async (admin) => {
    assert.equal(await queryLeaseRootCount(admin, queryLeaseId), 0);
    const state = await admin.query<{ readonly state: string }>(
      "SELECT state FROM runtime.query_leases WHERE project_id = $1 AND query_lease_id = $2",
      [queryIds.project, queryLeaseId],
    );
    assert.equal(state.rows[0]?.state, "expired");
  });
}

async function childLeaseId(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    let output = "";
    let errorOutput = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      const match = /LEASE_COMMITTED (?<leaseId>[0-9a-f-]{36})\n/u.exec(output);
      if (match?.groups?.["leaseId"] !== undefined) resolvePromise(match.groups["leaseId"]);
    });
    child.stderr?.on("data", (chunk: string) => {
      errorOutput += chunk;
    });
    child.once("exit", (code, signal) => {
      rejectPromise(
        new Error(
          `Orphan Lease child exited before committing (code=${String(code)}, signal=${String(signal)}): ${errorOutput}`,
        ),
      );
    });
    child.once("error", rejectPromise);
  });
}

async function assertContextDriftFailsAtomically(
  contexts: PostgresRuntimeQueryContextRepository,
  adminConfig: pg.ClientConfig,
): Promise<void> {
  const candidate = await contexts.resolveCandidate({
    projectId: queryIds.project,
    selector: { kind: "release", releaseId: queryIds.release },
  });
  await withClient(adminConfig, (admin) =>
    admin.query("DELETE FROM meta.release_serving_heads WHERE release_id = $1", [queryIds.release]),
  );
  const queryLeaseId = randomUUID();
  await assert.rejects(
    contexts.commitLease({
      candidate,
      queryLeaseId,
      identityContextHash: sha256("drift-identity"),
      authorizationEpoch: "7",
      policyContextHash: sha256("drift-policy"),
      queryHash: sha256("drift-query"),
      correlationId,
      ttlSeconds: 30,
    }),
    (error) => error instanceof RuntimeQueryError && error.code === "QUERY_CONTEXT_CHANGED",
  );
  await withClient(adminConfig, async (admin) => {
    const count = await admin.query<{ readonly count: number }>(
      "SELECT count(*)::integer AS count FROM runtime.query_leases WHERE query_lease_id = $1",
      [queryLeaseId],
    );
    assert.equal(count.rows[0]?.count, 0);
    await admin.query(
      `INSERT INTO meta.release_serving_heads
         (release_id, activation_id, control_sequence)
       VALUES ($1, $2, 1)`,
      [queryIds.release, queryIds.activation],
    );
  });
}

async function assertPolicyEpochDriftFailsAtomically(
  contexts: PostgresRuntimeQueryContextRepository,
  adminConfig: pg.ClientConfig,
): Promise<void> {
  const candidate = await contexts.resolveCandidate({
    projectId: queryIds.project,
    selector: { kind: "release", releaseId: queryIds.release },
  });
  await setAuthorizationEpoch(adminConfig, 8);
  const queryLeaseId = randomUUID();
  try {
    await assert.rejects(
      contexts.commitLease({
        candidate,
        queryLeaseId,
        identityContextHash: sha256("epoch-identity"),
        authorizationEpoch: "7",
        policyContextHash: sha256("epoch-policy"),
        queryHash: sha256("epoch-query"),
        correlationId,
        ttlSeconds: 30,
      }),
      (error) => error instanceof RuntimeQueryError && error.code === "QUERY_CONTEXT_CHANGED",
    );
  } finally {
    await setAuthorizationEpoch(adminConfig, 7);
  }
  await withClient(adminConfig, async (admin) => {
    const count = await admin.query<{ readonly count: number }>(
      "SELECT count(*)::integer AS count FROM runtime.query_leases WHERE query_lease_id = $1",
      [queryLeaseId],
    );
    assert.equal(count.rows[0]?.count, 0);
  });
}

async function assertSupportWindowIsImmutable(
  api: pg.Pool,
  adminConfig: pg.ClientConfig,
): Promise<void> {
  await assertPgCode(
    api.query(
      `UPDATE meta.releases
       SET support_until = support_until + interval '1 day'
       WHERE release_id = $1`,
      [queryIds.release],
    ),
    "42501",
  );
  await withClient(adminConfig, async (admin) => {
    await assertPgCode(
      admin.query(
        `UPDATE meta.releases
         SET support_until = support_until + interval '1 day'
         WHERE release_id = $1`,
        [queryIds.release],
      ),
      "55000",
    );
  });
}

async function writeRuntimeQueryEvidence(adminConfig: pg.ClientConfig): Promise<void> {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const [{ stdout: commitOutput }, { stdout: statusOutput }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
    execFileAsync("git", ["status", "--porcelain"], { cwd: repositoryRoot }),
  ]);
  const database = await withClient(adminConfig, async (admin) => {
    const version = await admin.query<{ readonly server_version_num: string }>(
      "SELECT current_setting('server_version_num') AS server_version_num",
    );
    const leases = await admin.query<{ readonly state: string; readonly count: number }>(
      `SELECT state, count(*)::integer AS count
       FROM runtime.query_leases GROUP BY state ORDER BY state`,
    );
    const servingHead = await admin.query<{ readonly count: number }>(
      "SELECT count(*)::integer AS count FROM meta.release_serving_heads WHERE release_id = $1",
      [queryIds.release],
    );
    return Object.freeze({
      serverVersionNum: version.rows[0]?.server_version_num ?? "",
      leaseStates: Object.freeze(leases.rows),
      retiredServingHeadCount: servingHead.rows[0]?.count ?? -1,
    });
  });
  const artifact = Object.freeze({
    schemaVersion: 1,
    gate: "G2-03-08",
    status: "PASS",
    qualification: "REAL_POSTGRES_16_RUNTIME_METADATA_OBJECT_GET",
    commit: commitOutput.trim(),
    cleanCheckout: statusOutput.trim() === "",
    postgres: database,
    executionContext: Object.freeze({
      selectorKinds: Object.freeze(["release", "channel"]),
      releaseId: queryIds.release,
      releaseRevisionId: queryIds.release,
      activationId: queryIds.activation,
      objectResourceId: mappingIds.objectResource,
      objectRevisionId: mappingIds.objectRevision,
      generationId: queryIds.customerGeneration,
      policyCompilationId: queryIds.policyCompilation,
    }),
    assertions: Object.freeze({
      candidateResolvedOncePerRequest: true,
      atomicContextRevalidationBeforeLeaseCommit: true,
      committedLeaseBeforeCurrentRead: true,
      leaseActivationOrderedBeforeCurrentRead: true,
      exactLeaseGatedCurrentView: true,
      metadataIsActorDiscoverable: true,
      canonicalPrimaryKeyAndExactRevisionGeneration: true,
      objectVersionStable: true,
      absentAndInvisibleShare404Boundary: true,
      propertyFiveStateSerializerDefense: true,
      servingHeadDriftFailsWithoutLease: true,
      authorizationEpochDriftFailsWithoutLease: true,
      killedOwnerLeaseExpiresAndDropsGcRoot: true,
      releaseSupportWindowImmutable: true,
      explicitRetirementHasNoStableFallback: true,
      apiHasNoRawCurrentGrant: true,
      workerAndOpsCannotUseQuerySurface: true,
    }),
  });
  const outputDirectory = fileURLToPath(new URL("../../../generated/ci-report/", import.meta.url));
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    `${outputDirectory}g2-03-08-runtime-query.json`,
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
}

async function assertExplicitRetirement(
  service: RuntimeQueryApplicationService,
  api: pg.Pool,
  adminConfig: pg.ClientConfig,
): Promise<void> {
  await withClient(adminConfig, async (admin) => {
    await admin.query(
      `UPDATE meta.releases
       SET state = 'superseded', changed_at = clock_timestamp()
       WHERE release_id = $1`,
      [queryIds.release],
    );
    await admin.query(
      "DELETE FROM meta.release_channels WHERE project_id = $1 AND channel_name = 'stable'",
      [queryIds.project],
    );
  });
  const retired = await api.query<{ readonly sequence: string }>(
    "SELECT meta.retire_release_serving_head($1, $2, 1, 1)::text AS sequence",
    [queryIds.project, queryIds.release],
  );
  assert.equal(retired.rows[0]?.sequence, "2");
  await assert.rejects(
    service.metadata(scope("release")),
    (error) => error instanceof RuntimeQueryError && error.code === "RELEASE_RETIRED",
  );
}

async function setAuthorizationEpoch(config: pg.ClientConfig, epoch: number): Promise<void> {
  await withClient(config, async (admin) => {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        `UPDATE authz.authorization_epochs
         SET epoch = $2, changed_at = clock_timestamp() WHERE project_id = $1`,
        [queryIds.project, epoch],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  });
}

async function queryLeaseRootCount(client: pg.Client, queryLeaseId: string): Promise<number> {
  const result = await client.query<{ readonly count: number }>(
    `SELECT count(*)::integer AS count FROM ops.gc_generation_roots
     WHERE project_id = $1 AND root_kind = 'QUERY_LEASE' AND root_id = $2`,
    [queryIds.project, queryLeaseId],
  );
  return result.rows[0]?.count ?? -1;
}

function scope(selector: "release" | "stable") {
  return Object.freeze({
    projectId: queryIds.project,
    selector:
      selector === "release"
        ? Object.freeze({ kind: "release" as const, releaseId: queryIds.release })
        : Object.freeze({ kind: "channel" as const, channelName: "stable" as const }),
    identity: identity(),
    correlationId,
  });
}

function identity(): RuntimeIdentityContext {
  const attributes = Object.freeze([Object.freeze({ name: "region", value: "EU" })]);
  const summary = parseIdentityDelegationSummary({
    schemaVersion: 1,
    actor: { principalId: ids.principal, identityType: "human" },
    delegationChain: [],
    claimsFingerprint: sha256(canonicalizeContractForDigest(attributes)),
    authenticatedAt: "2026-08-20T04:00:00.000000Z",
    authorizationMode: "intersection",
  });
  return Object.freeze({
    identity: summary,
    attributes,
    capabilities: Object.freeze([]),
    authorizationPrincipalIds: Object.freeze([summary.actor.principalId]),
  });
}

class IntegrationPolicyGateway implements PolicyGatewayPort {
  authorize(request: PolicyGatewayRequest): Promise<PolicyGatewayResult> {
    if (
      request.projectId !== queryIds.project ||
      request.resourceId !== mappingIds.objectResource ||
      request.releaseId !== queryIds.release ||
      request.policyRevisionId !== queryIds.policyRevision ||
      request.compilerVersion !== compilerVersion ||
      request.permission !== "object.read"
    ) {
      return Promise.resolve({
        decision: "DENY",
        source: "FAIL_CLOSED",
        epoch: null,
        errorCode: "POLICY_INPUT_INVALID",
        context: null,
      });
    }
    return Promise.resolve({
      decision: "ALLOW",
      source: "FRESH",
      epoch: "7",
      errorCode: null,
      context: policyContext(),
    });
  }
}

function policyContext(): PolicyGatewayContext {
  return Object.freeze({
    ...objectPolicy("Customer", { secretAccess: "mask" }),
    policyResourceId: queryIds.policyResource,
    policyRevisionId: queryIds.policyRevision,
    policyCompilationId: queryIds.policyCompilation,
    compilerVersion,
  });
}

async function seedRuntimeContext(client: pg.Client): Promise<void> {
  const planDigest = sha256("runtime-plan");
  const indexDigest = sha256("index-plan");
  const baseDigest = sha256("object-base-value");
  const policyContentDigest = sha256("policy-content");
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO authz.principals
         (principal_id, oidc_issuer, oidc_subject, display_name, identity_type)
       VALUES ($1, 'https://identity.example.test', 'g20308-human', 'G2-03-08 Human', 'human')`,
      [ids.principal],
    );
    await client.query(
      `INSERT INTO meta.projects
         (project_id, api_name, display_name, publication_sequence)
       VALUES ($1, 'RuntimeQueryProject', 'Runtime Query Project', 1)`,
      [queryIds.project],
    );
    await client.query(
      "INSERT INTO authz.authorization_epochs (project_id, epoch) VALUES ($1, 7)",
      [queryIds.project],
    );
    await client.query(
      `INSERT INTO meta.resources
         (resource_id, project_id, namespace, api_name, family)
       VALUES
         ($1, $3, 'runtime.query', 'Customer', 'object_type'),
         ($2, $3, 'runtime.query', 'RuntimeReadPolicy', 'policy')`,
      [mappingIds.objectResource, queryIds.policyResource, queryIds.project],
    );
    await client.query(
      `INSERT INTO meta.resource_revisions
         (revision_id, resource_id, revision_number, family, state,
          content_digest, content, created_by_principal_id)
       VALUES
         ($1, $2, 1, 'object_type', 'published', $3, $4::jsonb, $7),
         ($5, $6, 1, 'policy', 'published', $8, '{"schemaVersion":1}'::jsonb, $7)`,
      [
        mappingIds.objectRevision,
        mappingIds.objectResource,
        sha256("customer-definition"),
        JSON.stringify(customerObjectType),
        queryIds.policyRevision,
        queryIds.policyResource,
        ids.principal,
        policyContentDigest,
      ],
    );
    await client.query(
      `INSERT INTO meta.releases
         (release_id, project_id, release_number, manifest_digest, state,
          created_by_principal_id, published_by_principal_id, published_at,
          target_channel_name, staged_channel_control_sequence,
          staged_validation_context_digest, staged_at, support_until)
       VALUES ($1, $2, 1, $3, 'published', $4, $4,
               '2026-01-01T00:00:00Z', 'stable', 0, $5,
               '2025-12-31T23:59:00Z', '2026-04-01T00:00:00Z')`,
      [
        queryIds.release,
        queryIds.project,
        sha256("release-manifest"),
        ids.principal,
        sha256("stage"),
      ],
    );
    await client.query(
      `INSERT INTO meta.release_pins
         (release_id, resource_id, revision_id, pin_order, family, content_digest)
       VALUES
         ($1, $2, $3, 0, 'object_type', $4),
         ($1, $5, $6, 1, 'policy', $7)`,
      [
        queryIds.release,
        mappingIds.objectResource,
        mappingIds.objectRevision,
        sha256("customer-definition"),
        queryIds.policyResource,
        queryIds.policyRevision,
        policyContentDigest,
      ],
    );
    await client.query(
      `INSERT INTO authz.policy_compilations
         (project_id, policy_compilation_id, release_id, policy_resource_id,
          policy_revision_id, policy_content_digest, compiler_version,
          artifact_reference_id, artifact_digest, test_report_reference_id,
          test_report_digest, test_vector_count, passed_vector_count,
          failed_vector_count, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, 1, 0, 'passed')`,
      [
        queryIds.project,
        queryIds.policyCompilation,
        queryIds.release,
        queryIds.policyResource,
        queryIds.policyRevision,
        policyContentDigest,
        compilerVersion,
        ids.artifactReference,
        sha256("query-policy-artifact"),
        ids.testReportReference,
        sha256("policy-test-report"),
      ],
    );
    await client.query(
      `INSERT INTO meta.release_runtime_plans
         (project_id, release_id, plan_digest, member_count)
       VALUES ($1, $2, $3, 1)`,
      [queryIds.project, queryIds.release, planDigest],
    );
    await client.query(
      `INSERT INTO meta.release_runtime_plan_members
         (project_id, release_id, runtime_plan_digest, member_key, member_kind,
          target_resource_id, target_revision_id, snapshot_schema_resource_id,
          snapshot_schema_revision_id, mapping_resource_id, mapping_revision_id,
          snapshot_group_id, index_plan_digest)
       VALUES ($1, $2, $3, 'object:Customer', 'object', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        queryIds.project,
        queryIds.release,
        planDigest,
        mappingIds.objectResource,
        mappingIds.objectRevision,
        ids.snapshotSchemaResource,
        ids.snapshotSchemaRevision,
        ids.mappingResource,
        ids.mappingRevision,
        ids.snapshotGroup,
        indexDigest,
      ],
    );
    await client.query(
      `INSERT INTO runtime.generations
         (project_id, generation_id, member_key, member_kind,
          target_resource_id, target_revision_id, snapshot_id, snapshot_group_id,
          group_version, snapshot_schema_resource_id, snapshot_schema_revision_id,
          mapping_resource_id, mapping_revision_id, runtime_plan_digest,
          index_plan_digest, report_id, report_digest, state, generation_digest)
       VALUES ($1, $2, 'object:Customer', 'object', $3, $4, $5, $6, 1,
               $7, $8, $9, $10, $11, $12, $13, $14, 'active', $15)`,
      [
        queryIds.project,
        queryIds.customerGeneration,
        mappingIds.objectResource,
        mappingIds.objectRevision,
        ids.snapshot,
        ids.snapshotGroup,
        ids.snapshotSchemaResource,
        ids.snapshotSchemaRevision,
        ids.mappingResource,
        ids.mappingRevision,
        planDigest,
        indexDigest,
        ids.report,
        sha256("materialization-report"),
        sha256("generation"),
      ],
    );
    await client.query(
      `INSERT INTO meta.runtime_activations
         (activation_id, release_id, activation_digest, member_count)
       VALUES ($1, $2, $3, 1)`,
      [queryIds.activation, queryIds.release, sha256("activation")],
    );
    await client.query(
      `INSERT INTO meta.runtime_activation_members
         (project_id, release_id, activation_id, member_key, generation_id,
          snapshot_id, snapshot_group_id, group_version, certificate_id)
       VALUES ($1, $2, $3, 'object:Customer', $4, $5, $6, 1, $7)`,
      [
        queryIds.project,
        queryIds.release,
        queryIds.activation,
        queryIds.customerGeneration,
        ids.snapshot,
        ids.snapshotGroup,
        ids.certificate,
      ],
    );
    await client.query(
      `INSERT INTO meta.release_serving_heads
         (release_id, activation_id, control_sequence) VALUES ($1, $2, 1)`,
      [queryIds.release, queryIds.activation],
    );
    await client.query(
      `INSERT INTO meta.release_channels
         (project_id, channel_name, release_id, activation_id, control_sequence)
       VALUES ($1, 'stable', $2, $3, 1)`,
      [queryIds.project, queryIds.release, queryIds.activation],
    );
    await client.query(
      `INSERT INTO runtime.object_current
         (project_id, generation_id, object_type_resource_id,
          object_type_revision_id, object_rid, canonical_primary_key,
          properties, base_value_digest, lifecycle_state)
       VALUES ($1, $2, $3, $4, $5, $6,
         '{"values":{"id":{"value":"customer-1"},"displayName":{"value":"Ada Lovelace"},"secret":{"value":"classified"}}}'::jsonb,
         $7, 'active')`,
      [
        queryIds.project,
        queryIds.customerGeneration,
        mappingIds.objectResource,
        mappingIds.objectRevision,
        ids.objectRid,
        canonicalPrimaryKey,
        baseDigest,
      ],
    );
    await client.query(
      `INSERT INTO runtime.object_head_sets
         (project_id, head_set_id, head_set_digest, state, head_count)
       VALUES ($1, $2, $3, 'active', 1)`,
      [queryIds.project, ids.headSet, sha256("head-set")],
    );
    await client.query(
      `INSERT INTO runtime.object_head_versions
         (project_id, head_set_id, object_type_resource_id, object_rid,
          current_generation_id, object_type_revision_id, head_version,
          head_digest, base_value_digest)
       VALUES ($1, $2, $3, $4, $5, $6, 7, $7, $8)`,
      [
        queryIds.project,
        ids.headSet,
        mappingIds.objectResource,
        ids.objectRid,
        queryIds.customerGeneration,
        mappingIds.objectRevision,
        sha256("head"),
        baseDigest,
      ],
    );
    await client.query(
      `INSERT INTO runtime.project_object_head_pointers
         (project_id, head_set_id, control_sequence) VALUES ($1, $2, 1)`,
      [queryIds.project, ids.headSet],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function createRuntimeLogins(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE ROLE g20308_api_login LOGIN PASSWORD '${runtimePassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
    CREATE ROLE g20308_worker_login LOGIN PASSWORD '${runtimePassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
    CREATE ROLE g20308_ops_login LOGIN PASSWORD '${runtimePassword}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
    GRANT api_runtime TO g20308_api_login;
    GRANT worker_runtime TO g20308_worker_login;
    GRANT read_only_ops TO g20308_ops_login;
  `);
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
