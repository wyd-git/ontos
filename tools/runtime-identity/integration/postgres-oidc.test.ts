import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { canonicalizeContractForDigest, type ArtifactDigest } from "@ontos/contracts";
import {
  RuntimeIdentityApplicationService,
  RuntimeIdentityError,
} from "@ontos/identity-application";
import { canonicalClaimMapping, parseClaimMappingDefinition } from "@ontos/identity-domain";
import {
  nodeIdentityCryptography,
  PostgresRuntimeIdentityRepository,
} from "@ontos/identity-postgres";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";

import { RuntimeOidcAuthenticator } from "../../../apps/api/src/runtime-oidc.ts";
import { startTestOidcProvider, type TestTokenInput } from "../../admin-api/oidc-provider.ts";
import { runDatabaseMigrations } from "../../database/migrator.ts";
import { resolvePostgresTestImage } from "../../database/postgres-test-image.ts";

const execFileAsync = promisify(execFile);
const postgresImage = resolvePostgresTestImage();
const database = "ontos_g20304";
const adminPassword = "local-only-g20304-admin-secret";
const runtimePassword = "local-only-g20304-runtime-secret";
const runtimeUrl = "http://127.0.0.1/api/v1/runtime/objects";

const ids = {
  project: "65000000-0000-4000-8000-000000000001",
  human: "65000000-0000-4000-8000-000000000002",
  service: "65000000-0000-4000-8000-000000000003",
  unknown: "65000000-0000-4000-8000-000000000004",
  humanBinding: "65000000-0000-4000-8000-000000000011",
  serviceBinding: "65000000-0000-4000-8000-000000000012",
  humanMapping1: "65000000-0000-4000-8000-000000000021",
  humanMapping2: "65000000-0000-4000-8000-000000000022",
  serviceMapping: "65000000-0000-4000-8000-000000000023",
} as const;

const mapping1 = {
  schemaVersion: 1,
  attributes: [
    { claim: "region", attribute: "region", valueType: "string", required: true },
    { claim: "groups", attribute: "groups", valueType: "string_array", required: false },
  ],
} as const;
const mapping2 = {
  schemaVersion: 1,
  attributes: [
    { claim: "department", attribute: "department", valueType: "string", required: true },
  ],
} as const;

void test(
  "G2-03-04 establishes human/service/delegated identity through real OIDC and PostgreSQL",
  { timeout: 180_000 },
  async () => {
    const containerName = `ontos-g20304-${process.pid}-${randomUUID().slice(0, 8)}`;
    const provider = await startTestOidcProvider({ audience: "ontos-runtime" });
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
      const adminConfig: pg.PoolConfig = {
        host: "127.0.0.1",
        port,
        database,
        user: "postgres",
        password: adminPassword,
        application_name: "ontos-g20304-admin",
      };
      await waitForPostgreSql(adminConfig);
      const admin = new pg.Pool(adminConfig);
      const apiConfig: pg.PoolConfig = {
        ...adminConfig,
        user: "g20304_api_login",
        password: runtimePassword,
        application_name: "ontos-g20304-api",
      };
      const opsConfig: pg.PoolConfig = {
        ...adminConfig,
        user: "g20304_ops_login",
        password: runtimePassword,
        application_name: "ontos-g20304-ops",
      };
      const workerConfig: pg.PoolConfig = {
        ...adminConfig,
        user: "g20304_worker_login",
        password: runtimePassword,
        application_name: "ontos-g20304-worker",
      };
      try {
        const migrated = await withClient(admin, (client) => runDatabaseMigrations(client));
        assert.ok(
          migrated.applied.some(({ version }) => version === 25),
          "the G2-03-04 Runtime Identity migration must remain in the forward history",
        );
        assert.ok(
          (migrated.applied.at(-1)?.version ?? 0) >= 25,
          "later migrations must remain forward-compatible with the Runtime Identity gate",
        );
        await createRuntimeLogins(admin);
        const api = new pg.Pool(apiConfig);
        try {
          await seedRuntimeIdentity(api, provider.issuer);
          await assertCatalogAndPrivileges(admin, api, opsConfig, workerConfig);

          const authenticator = await RuntimeOidcAuthenticator.discover({
            issuer: provider.issuer,
            audience: provider.audience,
            requiredScope: "ontos.runtime",
            algorithms: ["RS256"],
          });
          const service = identityService(api);
          const humanToken = await provider.token(
            runtimeToken({
              subject: "human-subject",
              authorizedParty: "human-web",
              claims: {
                region: "east",
                groups: ["readers", "operators"],
                department: "operations",
                untrusted_admin: true,
              },
            }),
          );
          const humanCredential = await authenticator.authenticateRequest({
            headers: { authorization: `Bearer ${humanToken}` },
            method: "GET",
            url: runtimeUrl,
          });
          const human = await service.establish({
            projectId: ids.project,
            credential: humanCredential,
          });
          assert.deepEqual(human.attributes, [
            { name: "groups", value: ["operators", "readers"] },
            { name: "region", value: "east" },
          ]);
          assert.equal(JSON.stringify(human).includes("untrusted_admin"), false);

          const serviceToken = await provider.token(
            runtimeToken({
              subject: "runtime-service",
              authorizedParty: "service-client",
              claims: { ontos_capabilities: ["object.read"], region: "service-east" },
            }),
          );
          const directService = await service.establish({
            projectId: ids.project,
            credential: await authenticator.authenticateRequest({
              headers: { authorization: `Bearer ${serviceToken}` },
              method: "GET",
              url: runtimeUrl,
            }),
          });
          assert.deepEqual(directService.identity.actor, {
            principalId: ids.service,
            identityType: "service",
          });
          assert.deepEqual(directService.capabilities, ["object.read"]);

          const dpop = await dpopKey();
          const delegationToken = await provider.token(
            runtimeToken({
              subject: "human-subject",
              authorizedParty: "service-client",
              jwtId: "delegation-jti-shared-across-processes",
              expiresInSeconds: 60,
              claims: {
                act: { sub: "runtime-service" },
                cnf: { jkt: dpop.thumbprint },
                ontos_capabilities: ["object.read"],
                region: "east",
              },
            }),
          );
          const proof = await dpop.proof(delegationToken, "GET", runtimeUrl, "shared-dpop-jti");
          const childInput: ApiProcessInput = {
            database: apiConfig,
            oidc: { issuer: provider.issuer, audience: provider.audience },
            projectId: ids.project,
            authorization: `Bearer ${delegationToken}`,
            dpop: proof,
            method: "GET",
            url: runtimeUrl,
          };
          const firstProcess = await runApiProcess(childInput);
          assert.equal(firstProcess.ok, true);
          assert.deepEqual(readIdentity(firstProcess.result), {
            actor: { principalId: ids.service, identityType: "service" },
            delegationChain: [{ principalId: ids.human, identityType: "human" }],
          });
          const secondProcess = await runApiProcess(childInput);
          assert.deepEqual(secondProcess, {
            ok: false,
            error: {
              code: "AUTHENTICATION_FAILED",
              message: "Runtime identity could not be established.",
            },
          });
          await assertReplayStorageIsRedacted(admin);

          const beforeMappingFingerprint = human.identity.claimsFingerprint;
          const beforeMappingEpoch = await epoch(api);
          const historicalMapping = await mappingRevisionCanonical(admin, ids.humanMapping1);
          await activateSecondMapping(api, provider.issuer);
          assert.equal(await epoch(api), beforeMappingEpoch + 1n);
          assert.equal(await mappingRevisionCanonical(admin, ids.humanMapping1), historicalMapping);
          await assertHistoricalMappingImmutable(admin);
          const remapped = await service.establish({
            projectId: ids.project,
            credential: humanCredential,
          });
          assert.deepEqual(remapped.attributes, [{ name: "department", value: "operations" }]);
          assert.notEqual(remapped.identity.claimsFingerprint, beforeMappingFingerprint);
          await assertRedactedMappingAudit(opsConfig, provider.issuer);

          const unknownBefore = await principalCount(api);
          const unknownToken = await provider.token(
            runtimeToken({ subject: "unknown-subject", authorizedParty: "human-web" }),
          );
          await assert.rejects(
            service.establish({
              projectId: ids.project,
              credential: await authenticator.authenticateRequest({
                headers: { authorization: `Bearer ${unknownToken}` },
                method: "GET",
                url: runtimeUrl,
              }),
            }),
            RuntimeIdentityError,
          );
          assert.equal(await principalCount(api), unknownBefore);

          await disablePrincipal(api, ids.human);
          await assert.rejects(
            service.establish({ projectId: ids.project, credential: humanCredential }),
            RuntimeIdentityError,
          );
          await revokeServiceProfile(api);
          await assert.rejects(
            service.establish({
              projectId: ids.project,
              credential: await authenticator.authenticateRequest({
                headers: { authorization: `Bearer ${serviceToken}` },
                method: "GET",
                url: runtimeUrl,
              }),
            }),
            RuntimeIdentityError,
          );
          await writeRuntimeIdentityArtifact(admin);
        } finally {
          await api.end();
        }
      } finally {
        await admin.end();
      }
    } finally {
      await Promise.allSettled([
        provider.close(),
        docker(["rm", "--force", "--volumes", containerName], true),
      ]);
    }
  },
);

function identityService(pool: pg.Pool): RuntimeIdentityApplicationService {
  return new RuntimeIdentityApplicationService({
    repository: new PostgresRuntimeIdentityRepository(pool),
    cryptography: nodeIdentityCryptography,
    humanClientIds: ["human-web"],
  });
}

async function writeRuntimeIdentityArtifact(admin: pg.Pool): Promise<void> {
  const server = await admin.query<{ readonly server_version_num: string }>(
    "SELECT current_setting('server_version_num') AS server_version_num",
  );
  const [{ stdout: commit }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"]),
    execFileAsync("git", ["status", "--porcelain"]),
  ]);
  const artifact = {
    schemaVersion: 1,
    gate: "G2-03-04",
    status: "PASS",
    qualification: "REAL_OIDC_POSTGRES_DPOP_TWO_API_PROCESSES",
    commit: commit.trim(),
    cleanCheckout: status.trim().length === 0,
    migrations: { current: 25, applied: [25] },
    postgres: { serverVersionNum: server.rows[0]?.server_version_num ?? "" },
    assertions: {
      humanIdentityResolved: true,
      serviceIdentityClientBound: true,
      delegatedIdentityUsesRealDpop: true,
      twoApiProcessesShareReplayStore: true,
      claimMappingWhitelistAndFingerprint: true,
      claimMappingHistoryImmutable: true,
      claimMappingAuditRedacted: true,
      mappingChangeAdvancesEpoch: true,
      unknownPrincipalNotProvisioned: true,
      disabledPrincipalDenied: true,
      serviceProfileRevocationDenied: true,
      persistedCredentialsAbsent: true,
    },
  };
  const outputDirectory = resolve("generated/ci-report");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    resolve(outputDirectory, "g2-03-04-runtime-identity.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  process.stdout.write(`CI_G2_03_04 ${JSON.stringify(artifact)}\n`);
}

async function seedRuntimeIdentity(pool: pg.Pool, issuer: string): Promise<void> {
  await pool.query(
    `INSERT INTO authz.principals
       (principal_id, oidc_issuer, oidc_subject, display_name, identity_type)
     VALUES
       ($1, $3, 'human-subject', 'Runtime Human', 'human'),
       ($2, $3, 'runtime-service', 'Runtime Service', 'service')`,
    [ids.human, ids.service, issuer],
  );
  await pool.query(
    `INSERT INTO meta.projects (project_id, api_name, display_name)
     VALUES ($1, 'RuntimeIdentity', 'Runtime Identity')`,
    [ids.project],
  );
  await pool.query("INSERT INTO authz.authorization_epochs (project_id) VALUES ($1)", [
    ids.project,
  ]);
  await pool.query(
    `INSERT INTO authz.role_bindings
       (binding_id, project_id, principal_id, scope, role)
     VALUES
       ($1, $3, $4, 'project', 'viewer'),
       ($2, $3, $5, 'project', 'viewer')`,
    [ids.humanBinding, ids.serviceBinding, ids.project, ids.human, ids.service],
  );
  await registerMapping(pool, issuer, "human", ids.humanMapping1, 1, mapping1);
  await activateMapping(pool, issuer, "human", ids.humanMapping1, 0);
  await registerMapping(pool, issuer, "service", ids.serviceMapping, 1, mapping1);
  await activateMapping(pool, issuer, "service", ids.serviceMapping, 0);
  await pool.query(
    `SELECT * FROM authz.register_service_identity_profile(
       $1, $2, 'service-client', ARRAY['object.read']::text[], $3
     )`,
    [ids.project, ids.service, (await epoch(pool)).toString()],
  );
}

async function registerMapping(
  pool: pg.Pool,
  issuer: string,
  identityType: "human" | "service",
  revisionId: string,
  revisionNumber: number,
  mapping: unknown,
): Promise<void> {
  const definition = parseClaimMappingDefinition(mapping);
  const mappingDigest = digest(canonicalClaimMapping(definition));
  await pool.query(
    `SELECT * FROM authz.register_claim_mapping_revision(
       $1, $2, $3, $4, $5, $6, $7::jsonb, $8
     )`,
    [
      ids.project,
      revisionId,
      issuer,
      identityType,
      revisionNumber,
      mappingDigest,
      JSON.stringify(mapping),
      ids.human,
    ],
  );
}

async function activateMapping(
  pool: pg.Pool,
  issuer: string,
  identityType: "human" | "service",
  revisionId: string,
  expectedSequence: number,
): Promise<void> {
  await pool.query(`SELECT * FROM authz.activate_claim_mapping($1, $2, $3, $4, $5, $6)`, [
    ids.project,
    issuer,
    identityType,
    revisionId,
    expectedSequence,
    (await epoch(pool)).toString(),
  ]);
}

async function activateSecondMapping(pool: pg.Pool, issuer: string): Promise<void> {
  await registerMapping(pool, issuer, "human", ids.humanMapping2, 2, mapping2);
  await activateMapping(pool, issuer, "human", ids.humanMapping2, 1);
  const historical = await pool.query<{ readonly mapping: unknown }>(
    `SELECT mapping FROM authz.resolve_claim_mapping($1, $2, 'human')`,
    [ids.project, issuer],
  );
  assert.equal(
    canonicalizeContractForDigest(historical.rows[0]?.mapping),
    canonicalizeContractForDigest(mapping2),
  );
}

async function assertCatalogAndPrivileges(
  admin: pg.Pool,
  api: pg.Pool,
  opsConfig: pg.PoolConfig,
  workerConfig: pg.PoolConfig,
): Promise<void> {
  const catalog = await admin.query<{
    readonly relation: string;
    readonly relrowsecurity: boolean;
    readonly relforcerowsecurity: boolean;
  }>(`
    SELECT namespace.nspname || '.' || relation.relname AS relation,
           relation.relrowsecurity, relation.relforcerowsecurity
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE (namespace.nspname, relation.relname) IN (
      ('authz', 'service_identity_profiles'),
      ('authz', 'delegation_replay_records'),
      ('audit', 'claim_mapping_activation_events')
    ) ORDER BY relation`);
  assert.deepEqual(
    catalog.rows.map((row) => [row.relation, row.relrowsecurity, row.relforcerowsecurity]),
    [
      ["audit.claim_mapping_activation_events", true, true],
      ["authz.delegation_replay_records", true, true],
      ["authz.service_identity_profiles", true, true],
    ],
  );
  for (const relation of [
    "authz.service_identity_profiles",
    "authz.delegation_replay_records",
    "audit.claim_mapping_activation_events",
  ]) {
    const privilege = await api.query<{ readonly allowed: boolean }>(
      "SELECT has_table_privilege(current_user, $1, 'SELECT') AS allowed",
      [relation],
    );
    assert.equal(privilege.rows[0]?.allowed, false, relation);
  }
  const ops = new pg.Pool(opsConfig);
  const worker = new pg.Pool(workerConfig);
  try {
    assert.equal(
      (
        await ops.query<{ readonly allowed: boolean }>(
          "SELECT has_table_privilege(current_user, 'audit.claim_mapping_activation_events', 'SELECT') AS allowed",
        )
      ).rows[0]?.allowed,
      true,
    );
    assert.equal(
      (
        await worker.query<{ readonly allowed: boolean }>(
          `SELECT has_function_privilege(
             current_user, 'authz.prune_delegation_replays(integer)', 'EXECUTE'
           ) AS allowed`,
        )
      ).rows[0]?.allowed,
      true,
    );
  } finally {
    await Promise.all([ops.end(), worker.end()]);
  }
}

async function assertReplayStorageIsRedacted(admin: pg.Pool): Promise<void> {
  const rows = await admin.query<{
    readonly replay_fingerprint: string;
    readonly column_names: string[];
  }>(`
    SELECT replay.replay_fingerprint,
           ARRAY(
             SELECT column_name::text FROM information_schema.columns
             WHERE table_schema = 'authz' AND table_name = 'delegation_replay_records'
             ORDER BY ordinal_position
           ) AS column_names
    FROM authz.delegation_replay_records AS replay`);
  assert.equal(rows.rows.length, 1);
  assert.match(rows.rows[0]?.replay_fingerprint ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(rows.rows[0]?.column_names, [
    "replay_fingerprint",
    "project_id",
    "consumed_at",
    "expires_at",
  ]);
}

async function assertRedactedMappingAudit(opsConfig: pg.PoolConfig, issuer: string): Promise<void> {
  const ops = new pg.Pool(opsConfig);
  try {
    const events = await ops.query<Readonly<Record<string, unknown>> & pg.QueryResultRow>(
      "SELECT * FROM audit.claim_mapping_activation_events ORDER BY event_id",
    );
    assert.equal(events.rows.length, 3);
    const serialized = JSON.stringify(events.rows);
    assert.equal(serialized.includes(issuer), false);
    assert.equal(serialized.includes("attributes"), false);
    assert.equal(serialized.includes("region"), false);
    assert.equal(Object.keys(events.rows[0] ?? {}).includes("mapping"), false);
  } finally {
    await ops.end();
  }
}

async function mappingRevisionCanonical(pool: pg.Pool, revisionId: string): Promise<string> {
  const result = await pool.query<{ readonly mapping: unknown }>(
    `SELECT mapping FROM authz.claim_mapping_revisions
     WHERE project_id = $1 AND claim_mapping_revision_id = $2`,
    [ids.project, revisionId],
  );
  return canonicalizeContractForDigest(result.rows[0]?.mapping);
}

async function assertHistoricalMappingImmutable(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE migration_owner");
    await assert.rejects(
      client.query(
        `UPDATE authz.claim_mapping_revisions
         SET mapping = '{"schemaVersion":1,"attributes":[]}'::jsonb
         WHERE project_id = $1 AND claim_mapping_revision_id = $2`,
        [ids.project, ids.humanMapping1],
      ),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "55000",
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function disablePrincipal(pool: pg.Pool, principalId: string): Promise<void> {
  await pool.query(
    `UPDATE authz.principals
     SET state = 'disabled', disabled_at = clock_timestamp(), changed_at = clock_timestamp()
     WHERE principal_id = $1`,
    [principalId],
  );
}

async function revokeServiceProfile(pool: pg.Pool): Promise<void> {
  await pool.query("SELECT * FROM authz.revoke_service_identity_profile($1, $2, $3)", [
    ids.project,
    ids.service,
    (await epoch(pool)).toString(),
  ]);
}

async function epoch(pool: pg.Pool): Promise<bigint> {
  const result = await pool.query<{ readonly epoch: string }>(
    "SELECT epoch::text FROM authz.authorization_epochs WHERE project_id = $1",
    [ids.project],
  );
  return BigInt(result.rows[0]?.epoch ?? "0");
}

async function principalCount(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ readonly count: number }>(
    "SELECT count(*)::integer AS count FROM authz.principals",
  );
  return result.rows[0]?.count ?? -1;
}

function runtimeToken(overrides: TestTokenInput = {}): TestTokenInput {
  return {
    tokenType: "at+jwt",
    scope: "openid ontos.runtime",
    subject: "human-subject",
    authorizedParty: "human-web",
    ...overrides,
  };
}

async function dpopKey(): Promise<{
  readonly thumbprint: string;
  proof(token: string, method: string, url: string, proofId: string): Promise<string>;
}> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const thumbprint = await calculateJwkThumbprint(publicJwk, "sha256");
  return {
    thumbprint,
    proof(token, method, url, proofId) {
      return new SignJWT({
        htm: method,
        htu: url,
        ath: createHash("sha256").update(token, "utf8").digest("base64url"),
      })
        .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: publicJwk })
        .setIssuedAt()
        .setJti(proofId)
        .sign(privateKey);
    },
  };
}

interface ApiProcessInput {
  readonly database: pg.PoolConfig;
  readonly oidc: { readonly issuer: string; readonly audience: string };
  readonly projectId: string;
  readonly authorization: string;
  readonly dpop: string;
  readonly method: string;
  readonly url: string;
}

interface ApiProcessResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

function runApiProcess(input: ApiProcessInput): Promise<ApiProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = fork(resolve("tools/runtime-identity/integration/api-process.ts"), [], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Runtime API process timed out."));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("message", (message: unknown) => {
      clearTimeout(timeout);
      resolveResult(message as ApiProcessResult);
    });
    child.send(input);
  });
}

function readIdentity(value: unknown): {
  readonly actor: unknown;
  readonly delegationChain: unknown;
} {
  const context = value as {
    readonly identity?: { readonly actor?: unknown; readonly delegationChain?: unknown };
  };
  return {
    actor: context.identity?.actor,
    delegationChain: context.identity?.delegationChain,
  };
}

function digest(value: string): ArtifactDigest {
  return nodeIdentityCryptography.digestCanonicalText(value);
}

async function createRuntimeLogins(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE ROLE g20304_api_login LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    GRANT api_runtime TO g20304_api_login;
    CREATE ROLE g20304_ops_login LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    GRANT read_only_ops TO g20304_ops_login;
    CREATE ROLE g20304_worker_login LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    GRANT worker_runtime TO g20304_worker_login;
  `);
}

async function withClient<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

async function docker(args: readonly string[], ignoreFailure = false): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", [...args]);
    return stdout.trim();
  } catch (error) {
    if (!ignoreFailure) throw error;
    return "";
  }
}

async function publishedPostgreSqlPort(containerName: string): Promise<number> {
  const output = await docker(["port", containerName, "5432/tcp"]);
  const match = /:(?<port>[0-9]+)$/u.exec(output);
  const port = Number(match?.groups?.["port"]);
  if (!Number.isInteger(port) || port <= 0) throw new Error("PostgreSQL port is unavailable.");
  return port;
}

async function waitForPostgreSql(config: pg.PoolConfig): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const client = new pg.Client(config);
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error("PostgreSQL did not become ready.");
}
