import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { HeadBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import {
  canonicalizeContractForDigest,
  parseIdentityDelegationSummary,
  type ArtifactDigest,
  type IdentityType,
} from "@ontos/contracts";
import type { RuntimeIdentityContext } from "@ontos/identity-application";
import {
  MetadataApplicationService,
  ReleaseLifecycleApplicationService,
  ResourceLifecycleApplicationService,
  RoleMatrixManagementAuthorizer,
  parseVerifiedFoundationIdentity,
  type VerifiedFoundationIdentity,
} from "@ontos/metadata-application";
import { PostgresMetadataControlPlane, PostgresReleaseStore } from "@ontos/metadata-postgres";
import { S3ManagedObjectStore, S3PolicyArtifactStore } from "@ontos/object-store-s3";
import {
  PolicyCompilationApplicationService,
  ProductionPolicyGateway,
  type PolicyGatewayMonotonicClock,
  type PolicyGatewayRequest,
} from "@ontos/policy-application";
import {
  PostgresPolicyCompilationStore,
  PostgresPolicyEpochListener,
  PostgresPolicyGatewayRepository,
  sha256PolicyText,
} from "@ontos/policy-postgres";
import { canonicalClaimMapping, parseClaimMappingDefinition } from "@ontos/identity-domain";
import pg from "pg";

import { isDatabaseMigrationError } from "../../database/errors.ts";
import { databaseMigrationDirectory, runDatabaseMigrations } from "../../database/migrator.ts";
import { resolvePostgresTestImage } from "../../database/postgres-test-image.ts";

const execFileAsync = promisify(execFile);
const postgresImage = resolvePostgresTestImage();
const s3Image =
  "chrislusf/seaweedfs:4.41@sha256:43b768cd62b00d132439cda881b93fd1adebf1b315e996e794087743821d771d";
const database = "ontos_g20305";
const adminPassword = "local-only-g20305-admin-secret";
const runtimePassword = "local-only-g20305-runtime-secret";
const compilerPassword = "local-only-g20305-compiler-secret";
const accessKeyId = "local-only-g20305-s3-access";
const secretAccessKey = "local-only-g20305-s3-secret";

void test(
  "G2-03-05/06 compile an exact Policy and authorize it through two production Gateway processes",
  { timeout: 240_000 },
  async () => {
    const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
    const postgresContainer = `ontos-g20305-pg-${suffix}`;
    const s3Container = `ontos-g20305-s3-${suffix}`;
    const bucket = `ontos-g20305-${process.pid}`;
    const s3Port = await reserveLoopbackPort();
    const endpoint = `http://127.0.0.1:${String(s3Port)}`;
    let admin: pg.Pool | null = null;
    let api: pg.Pool | null = null;
    let compilerDatabase: pg.Pool | null = null;
    let rawS3: S3Client | null = null;
    let managedS3: S3ManagedObjectStore | null = null;

    await docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      postgresContainer,
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
    await docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      s3Container,
      "--env",
      `AWS_ACCESS_KEY_ID=${accessKeyId}`,
      "--env",
      `AWS_SECRET_ACCESS_KEY=${secretAccessKey}`,
      "--env",
      `S3_BUCKET=${bucket}`,
      "--tmpfs",
      "/data:rw,noexec,nosuid,size=1g",
      "--publish",
      `127.0.0.1:${String(s3Port)}:8333`,
      s3Image,
      "mini",
      "-dir=/data",
    ]);

    try {
      const postgresPort = await publishedPostgreSqlPort(postgresContainer);
      const adminConfig: pg.PoolConfig = {
        host: "127.0.0.1",
        port: postgresPort,
        database,
        user: "postgres",
        password: adminPassword,
        application_name: "ontos-g2-03-05-admin",
      };
      await waitForPostgreSql(adminConfig);
      await assertMigration26RollsBack(adminConfig);
      await assertMigration27RollsBack(adminConfig);
      admin = new pg.Pool(adminConfig);
      await withClient(adminConfig, async (client) => {
        await runDatabaseMigrations(client);
        await client.query(`
          ALTER ROLE api_runtime LOGIN PASSWORD '${runtimePassword}';
          CREATE ROLE g20305_policy_compiler_login LOGIN PASSWORD '${compilerPassword}'
            NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
          GRANT worker_runtime TO g20305_policy_compiler_login;
        `);
      });
      const apiConfig: pg.PoolConfig = {
        ...adminConfig,
        user: "api_runtime",
        password: runtimePassword,
        application_name: "ontos-g2-03-05-api",
        max: 8,
      };
      api = new pg.Pool(apiConfig);
      compilerDatabase = new pg.Pool({
        ...adminConfig,
        user: "g20305_policy_compiler_login",
        password: compilerPassword,
        application_name: "ontos-g2-03-05-policy-compiler",
        max: 4,
      });

      rawS3 = new S3Client({
        endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: { accessKeyId, secretAccessKey },
      });
      await waitForS3(rawS3, bucket);
      await rawS3.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );
      managedS3 = new S3ManagedObjectStore({
        endpoint,
        region: "us-east-1",
        bucket,
        accessKeyId,
        secretAccessKey,
        forcePathStyle: true,
        maxAttempts: 1,
      });
      await managedS3.assertVersioningEnabled();

      const metadataStore = new PostgresMetadataControlPlane(api);
      const releaseStore = new PostgresReleaseStore(api);
      const authorizer = new RoleMatrixManagementAuthorizer(metadataStore);
      const metadata = new MetadataApplicationService({
        principals: metadataStore,
        projects: metadataStore,
        roleBindings: metadataStore,
        authorizer,
      });
      const resources = new ResourceLifecycleApplicationService({
        principals: metadataStore,
        resources: metadataStore,
        authorizer,
      });
      const releases = new ReleaseLifecycleApplicationService({
        principals: metadataStore,
        releases: releaseStore,
        authorizer,
      });
      const owner = identity("policy-owner");
      const ownerPrincipal = await metadataStore.resolveVerifiedIdentity(owner);
      const project = await metadata.createProject(owner, {
        apiName: "PolicyGate",
        displayName: "Policy Gate",
      });
      await activateRegionClaimMapping(api, {
        projectId: project.project.projectId,
        principalId: ownerPrincipal.principalId,
      });

      const workItem = await resources.createResource(owner, {
        projectId: project.project.projectId,
        namespace: "policy.fixture",
        apiName: "WorkItem",
        family: "object_type",
        content: workItemDefinition(),
      });
      const person = await resources.createResource(owner, {
        projectId: project.project.projectId,
        namespace: "policy.fixture",
        apiName: "Person",
        family: "object_type",
        content: personDefinition(),
      });
      const workItemRevision = (
        await resources.validateRevision(owner, { revisionId: workItem.initialDraft.revisionId })
      ).revision;
      const personRevision = (
        await resources.validateRevision(owner, { revisionId: person.initialDraft.revisionId })
      ).revision;
      const assignments = await resources.createResource(owner, {
        projectId: project.project.projectId,
        namespace: "policy.fixture",
        apiName: "Assignments",
        family: "link_type",
        content: assignmentsDefinition(workItemRevision.revisionId, personRevision.revisionId),
      });
      const assignmentsRevision = (
        await resources.validateRevision(owner, {
          revisionId: assignments.initialDraft.revisionId,
        })
      ).revision;
      const policy = await resources.createResource(owner, {
        projectId: project.project.projectId,
        namespace: "policy.fixture",
        apiName: "WorkItemAccess",
        family: "policy",
        content: policyDefinition({
          workItemResourceId: workItem.resource.resourceId,
          workItemRevisionId: workItemRevision.revisionId,
          personResourceId: person.resource.resourceId,
          personRevisionId: personRevision.revisionId,
          linkResourceId: assignments.resource.resourceId,
          linkRevisionId: assignmentsRevision.revisionId,
        }),
      });
      const policyValidation = await resources.validateRevision(owner, {
        revisionId: policy.initialDraft.revisionId,
      });
      assert.equal(policyValidation.report.valid, true);
      assert.equal(policyValidation.revision.state, "validated");
      const dependencyCount = await admin.query<{ readonly count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM meta.resource_dependencies
         WHERE source_revision_id = $1`,
        [policyValidation.revision.revisionId],
      );
      assert.ok(Number(dependencyCount.rows[0]?.count ?? "0") >= 10);

      const release = await releases.createRelease(owner, {
        projectId: project.project.projectId,
        targetChannelName: "stable",
        revisionIds: [
          workItemRevision.revisionId,
          personRevision.revisionId,
          assignmentsRevision.revisionId,
          policyValidation.revision.revisionId,
        ],
      });
      const blocked = await releases.stageRelease(owner, { releaseId: release.releaseId });
      assert.equal(blocked.staged, false);
      assert.ok(
        blocked.report.issues.some(({ code }) => code === "RELEASE_POLICY_COMPILATION_REQUIRED"),
      );
      const forgedValidationContext = fixedDigest("e");
      await admin.query(
        `INSERT INTO meta.validation_reports
           (report_id, subject_type, subject_id, release_id, subject_digest,
            validation_context_digest, validator_version, valid, issues)
         VALUES ($1, 'release', $2, $2, $3, $4,
                 'metadata-release-g2-01-v1', TRUE, '[]'::jsonb)`,
        [randomUUID(), release.releaseId, release.manifestDigest, forgedValidationContext],
      );
      await assert.rejects(
        admin.query(
          `UPDATE meta.releases
           SET state = 'staging', staged_channel_control_sequence = 0,
               staged_validation_context_digest = $2, staged_at = clock_timestamp(),
               changed_at = clock_timestamp()
           WHERE release_id = $1`,
          [release.releaseId, forgedValidationContext],
        ),
        postgresError("55000", "G20305_POLICY_COMPILATION_REQUIRED"),
      );

      await assert.rejects(
        api.query(
          `SELECT authz.record_policy_compilation(
             $1, $2, $3, $4, $5, $6, 'policy-compiler-g2-03-05-v1',
             $7, $8, $9, $10, 6, 6, 0, 'passed'
           )`,
          [
            project.project.projectId,
            randomUUID(),
            release.releaseId,
            policy.resource.resourceId,
            policyValidation.revision.revisionId,
            policyValidation.revision.contentDigest,
            randomUUID(),
            fixedDigest("1"),
            randomUUID(),
            fixedDigest("2"),
          ],
        ),
        postgresError("42501"),
      );

      const policyPersistence = new PostgresPolicyCompilationStore(compilerDatabase);
      const forgedCompilationId = randomUUID();
      await assert.rejects(
        policyPersistence.recordCompilation({
          projectId: project.project.projectId,
          policyCompilationId: forgedCompilationId,
          releaseId: release.releaseId,
          policyResourceId: policy.resource.resourceId,
          policyRevisionId: policyValidation.revision.revisionId,
          policyContentDigest: policyValidation.revision.contentDigest,
          compilerVersion: "policy-compiler-g2-03-05-v1",
          artifactReferenceId: randomUUID(),
          artifactDigest: fixedDigest("a"),
          testReportReferenceId: randomUUID(),
          testReportDigest: fixedDigest("b"),
          testVectorCount: 999,
          passedVectorCount: 999,
          failedVectorCount: 0,
          status: "passed",
        }),
      );
      const forgedFacts = await admin.query<{ readonly count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM meta.artifact_references
         WHERE source_id = $1`,
        [forgedCompilationId],
      );
      assert.equal(forgedFacts.rows[0]?.count, "0");
      const wrongBindingCompilationId = randomUUID();
      await assert.rejects(
        policyPersistence.recordCompilation({
          projectId: project.project.projectId,
          policyCompilationId: wrongBindingCompilationId,
          releaseId: release.releaseId,
          policyResourceId: policy.resource.resourceId,
          policyRevisionId: policyValidation.revision.revisionId,
          policyContentDigest: fixedDigest("c"),
          compilerVersion: "policy-compiler-g2-03-05-v1",
          artifactReferenceId: randomUUID(),
          artifactDigest: fixedDigest("d"),
          testReportReferenceId: randomUUID(),
          testReportDigest: fixedDigest("f"),
          testVectorCount: 6,
          passedVectorCount: 6,
          failedVectorCount: 0,
          status: "passed",
        }),
      );
      const wrongBindingFacts = await admin.query<{ readonly count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM meta.artifact_references
         WHERE source_id = $1`,
        [wrongBindingCompilationId],
      );
      assert.equal(wrongBindingFacts.rows[0]?.count, "0");

      const artifacts = new S3PolicyArtifactStore(managedS3);
      const compiler = new PolicyCompilationApplicationService({
        source: policyPersistence,
        artifacts,
        recorder: policyPersistence,
        digest: sha256PolicyText,
        uuid: randomUUID,
      });
      const compiled = await compiler.compileReleasePolicy({
        projectId: project.project.projectId,
        releaseId: release.releaseId,
        policyRevisionId: policyValidation.revision.revisionId,
      });
      assert.equal(compiled.testReport.status, "passed");
      assert.equal(
        await artifacts.readArtifact({ kind: "ir", digest: compiled.artifactDigest }),
        compiled.artifactBytes,
      );
      assert.equal(
        await artifacts.readArtifact({ kind: "test", digest: compiled.testReportDigest }),
        compiled.testReportBytes,
      );

      const compiledFacts = await admin.query<{
        readonly compiler_version: string;
        readonly status: string;
        readonly failed_vector_count: number;
      }>(
        `SELECT compiler_version, status, failed_vector_count
         FROM authz.policy_compilations
         WHERE project_id = $1 AND release_id = $2`,
        [project.project.projectId, release.releaseId],
      );
      assert.deepEqual(compiledFacts.rows, [
        {
          compiler_version: "policy-compiler-g2-03-05-v1",
          status: "passed",
          failed_vector_count: 0,
        },
      ]);

      const staged = await releases.stageRelease(owner, { releaseId: release.releaseId });
      assert.equal(staged.staged, true);
      assert.equal(staged.report.valid, true);
      assert.equal(staged.release.state, "ready");
      const published = await releases.publishRelease(owner, {
        releaseId: release.releaseId,
        expectedChannelControlSequence: 0n,
      });
      assert.equal(published.binding.releaseId, release.releaseId);
      assert.equal(
        (await releases.getRelease(owner, { releaseId: release.releaseId })).state,
        "published",
      );
      await assert.rejects(
        admin.query(
          `UPDATE authz.policy_compilations SET status = 'failed'
           WHERE project_id = $1 AND release_id = $2`,
          [project.project.projectId, release.releaseId],
        ),
        postgresError("55000"),
      );

      const gatewayEvidence = await exerciseProductionPolicyGateway({
        adminConfig,
        apiConfig,
        admin,
        api,
        compilerDatabase,
        metadataStore,
        metadata,
        artifacts,
        managedS3,
        owner,
        ownerPrincipalId: ownerPrincipal.principalId,
        projectId: project.project.projectId,
        targetResourceId: workItem.resource.resourceId,
        otherResourceId: person.resource.resourceId,
        releaseId: release.releaseId,
        policyRevisionId: policyValidation.revision.revisionId,
        artifactDigest: compiled.artifactDigest,
        compilerVersion: compiled.artifact.compilerVersion,
      });

      const [{ stdout: commit }, { stdout: status }, postgresVersion] = await Promise.all([
        execFileAsync("git", ["rev-parse", "HEAD"]),
        execFileAsync("git", ["status", "--porcelain"]),
        admin.query<{ readonly server_version_num: string }>("SHOW server_version_num"),
      ]);
      const artifact = {
        schemaVersion: 1,
        gate: "G2-03-05",
        status: "PASS",
        qualification: "REAL_POSTGRES_16_VERSIONED_S3_RELEASE_GATE",
        commit: commit.trim(),
        cleanCheckout: status.trim().length === 0,
        migrations: { historicalPrefix: 25, current: 26, applied: [26] },
        postgres: { serverVersionNum: postgresVersion.rows[0]?.server_version_num ?? null },
        compilerVersion: compiled.artifact.compilerVersion,
        testVectorCount: compiled.testReport.vectorCount,
        assertions: {
          exactDependencies: true,
          missingCompilationBlocked: true,
          apiCompilationWriteDenied: true,
          directDatabaseBypassBlocked: true,
          forgedCompilationBlocked: true,
          wrongBindingCompilationBlocked: true,
          artifactsDigestVerified: true,
          migration26RollsBack: true,
          releasePublished: true,
          compilationImmutable: true,
        },
      };
      const outputDirectory = resolve("generated/ci-report");
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        resolve(outputDirectory, "g2-03-05-policy-compiler.json"),
        `${JSON.stringify(artifact, null, 2)}\n`,
      );
      const gatewayArtifact = {
        schemaVersion: 1,
        gate: "G2-03-06",
        status: "PASS",
        qualification: "REAL_POSTGRES_16_VERSIONED_S3_TWO_PROCESS_POLICY_GATEWAY",
        commit: commit.trim(),
        cleanCheckout: status.trim().length === 0,
        migrations: { historicalPrefix: 26, current: 27, applied: [27] },
        postgres: { serverVersionNum: postgresVersion.rows[0]?.server_version_num ?? null },
        compilerVersion: compiled.artifact.compilerVersion,
        cacheTtlMs: 5_000,
        gatewayProcesses: 2,
        assertions: gatewayEvidence,
      };
      await writeFile(
        resolve(outputDirectory, "g2-03-06-policy-gateway.json"),
        `${JSON.stringify(gatewayArtifact, null, 2)}\n`,
      );
      process.stdout.write(`CI_G2_03_05 ${JSON.stringify(artifact)}\n`);
      process.stdout.write(`CI_G2_03_06 ${JSON.stringify(gatewayArtifact)}\n`);
    } finally {
      managedS3?.destroy();
      rawS3?.destroy();
      await api?.end().catch(() => undefined);
      await compilerDatabase?.end().catch(() => undefined);
      await admin?.end().catch(() => undefined);
      await Promise.all([
        docker(["rm", "--force", "--volumes", postgresContainer], true),
        docker(["rm", "--force", "--volumes", s3Container], true),
      ]);
    }
  },
);

interface ProductionPolicyGatewayExerciseInput {
  readonly adminConfig: pg.PoolConfig;
  readonly apiConfig: pg.PoolConfig;
  readonly admin: pg.Pool;
  readonly api: pg.Pool;
  readonly compilerDatabase: pg.Pool;
  readonly metadataStore: PostgresMetadataControlPlane;
  readonly metadata: MetadataApplicationService;
  readonly artifacts: S3PolicyArtifactStore;
  readonly managedS3: S3ManagedObjectStore;
  readonly owner: VerifiedFoundationIdentity;
  readonly ownerPrincipalId: string;
  readonly projectId: string;
  readonly targetResourceId: string;
  readonly otherResourceId: string;
  readonly releaseId: string;
  readonly policyRevisionId: string;
  readonly artifactDigest: ArtifactDigest;
  readonly compilerVersion: string;
}

async function exerciseProductionPolicyGateway(
  input: ProductionPolicyGatewayExerciseInput,
): Promise<Readonly<Record<string, true>>> {
  const readerIdentity = identity("policy-runtime-reader");
  const readerPrincipal = await input.metadataStore.resolveVerifiedIdentity(readerIdentity);
  const servicePrincipalId = randomUUID();
  await input.admin.query(
    `INSERT INTO authz.principals
       (principal_id, oidc_issuer, oidc_subject, display_name, identity_type)
     VALUES ($1, 'https://identity.policy.test', 'policy-runtime-service',
             'Policy Runtime Service', 'service')`,
    [servicePrincipalId],
  );
  await replaceProjectRole(input, readerPrincipal.principalId, "viewer");
  await replaceProjectRole(input, servicePrincipalId, "viewer");
  const profileEpoch = await currentAuthorizationEpoch(input);
  await input.api.query(
    `SELECT * FROM authz.register_service_identity_profile(
       $1, $2, 'policy-runtime-client', ARRAY['object.read']::text[], $3
     )`,
    [input.projectId, servicePrincipalId, profileEpoch.toString()],
  );

  const human = gatewayIdentity({
    actor: { principalId: readerPrincipal.principalId, identityType: "human" },
  });
  const service = gatewayIdentity({
    actor: { principalId: servicePrincipalId, identityType: "service" },
    capabilities: ["object.read"],
  });
  const delegated = gatewayIdentity({
    actor: { principalId: servicePrincipalId, identityType: "service" },
    delegationChain: [{ principalId: readerPrincipal.principalId, identityType: "human" }],
    capabilities: ["object.read"],
  });
  const ownerContext = gatewayIdentity({
    actor: { principalId: input.ownerPrincipalId, identityType: "human" },
  });
  const repository = new PostgresPolicyGatewayRepository(input.api);
  const humanRequest = policyGatewayRequest(input, human, "corr_g20306_human_request_0001");
  const serviceRequest = policyGatewayRequest(input, service, "corr_g20306_service_request_0001");
  const delegatedRequest = policyGatewayRequest(
    input,
    delegated,
    "corr_g20306_delegated_request_01",
  );

  const snapshot = await repository.readPolicyGatewaySnapshot({
    projectId: input.projectId,
    authorizationPrincipalIds: human.authorizationPrincipalIds,
    resourceId: input.targetResourceId,
    permission: "object.read",
    releaseId: input.releaseId,
    policyRevisionId: input.policyRevisionId,
    compilerVersion: input.compilerVersion,
  });
  assert.equal(snapshot.projectId, input.projectId);
  assert.equal(snapshot.resourceId, input.targetResourceId);
  assert.equal(snapshot.releaseId, input.releaseId);
  assert.equal(snapshot.policyRevisionId, input.policyRevisionId);
  assert.equal(snapshot.artifactDigest, input.artifactDigest);
  assert.deepEqual(
    snapshot.principals.map(({ principalId, projectRole }) => ({ principalId, projectRole })),
    [{ principalId: readerPrincipal.principalId, projectRole: "viewer" }],
  );

  await assert.rejects(
    repository.readPolicyGatewaySnapshot({
      projectId: input.projectId,
      authorizationPrincipalIds: human.authorizationPrincipalIds,
      resourceId: input.otherResourceId,
      permission: "object.read",
      releaseId: input.releaseId,
      policyRevisionId: input.policyRevisionId,
      compilerVersion: input.compilerVersion,
    }),
  );
  await assert.rejects(
    repository.readPolicyGatewaySnapshot({
      projectId: input.projectId,
      authorizationPrincipalIds: human.authorizationPrincipalIds,
      resourceId: input.targetResourceId,
      permission: "object.read",
      releaseId: randomUUID(),
      policyRevisionId: input.policyRevisionId,
      compilerVersion: input.compilerVersion,
    }),
  );
  await assert.rejects(
    repository.readPolicyGatewaySnapshot({
      projectId: input.projectId,
      authorizationPrincipalIds: human.authorizationPrincipalIds,
      resourceId: input.targetResourceId,
      permission: "object.read",
      releaseId: input.releaseId,
      policyRevisionId: randomUUID(),
      compilerVersion: input.compilerVersion,
    }),
  );

  const resolverParameters = [
    input.projectId,
    human.authorizationPrincipalIds,
    input.targetResourceId,
    "object.read",
    input.releaseId,
    input.policyRevisionId,
    input.compilerVersion,
  ];
  await assert.rejects(
    input.compilerDatabase.query(policyGatewayResolverSql(), resolverParameters),
    postgresError("42501"),
  );
  await withClient(input.adminConfig, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE read_only_ops");
      await assert.rejects(
        client.query(policyGatewayResolverSql(), resolverParameters),
        postgresError("42501"),
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });
  await assert.rejects(
    input.api.query(policyGatewayResolverSql(), [
      input.projectId,
      [readerPrincipal.principalId, readerPrincipal.principalId],
      input.targetResourceId,
      "object.read",
      input.releaseId,
      input.policyRevisionId,
      input.compilerVersion,
    ]),
    postgresError("22023", "G20306_POLICY_GATEWAY_INPUT_INVALID"),
  );

  const listenerApplicationA = `ontos-g20306-listener-a-${randomUUID().slice(0, 8)}`;
  const listenerApplicationB = `ontos-g20306-listener-b-${randomUUID().slice(0, 8)}`;
  const listenerPoolA = new pg.Pool({
    ...input.apiConfig,
    application_name: listenerApplicationA,
    max: 1,
  });
  const listenerPoolB = new pg.Pool({
    ...input.apiConfig,
    application_name: listenerApplicationB,
    max: 1,
  });
  const listenerA = new PostgresPolicyEpochListener({ pool: listenerPoolA, reconnectDelayMs: 20 });
  const listenerB = new PostgresPolicyEpochListener({ pool: listenerPoolB, reconnectDelayMs: 20 });
  const clockA = new GatewayManualClock();
  const clockB = new GatewayManualClock();
  const gatewayA = new ProductionPolicyGateway({
    processId: "g20306-api-process-a",
    repository,
    artifacts: input.artifacts,
    monotonicClock: clockA,
    digestCanonicalText: sha256PolicyText,
    notifications: listenerA,
  });
  const gatewayB = new ProductionPolicyGateway({
    processId: "g20306-api-process-b",
    repository,
    artifacts: input.artifacts,
    monotonicClock: clockB,
    digestCanonicalText: sha256PolicyText,
    notifications: listenerB,
  });

  try {
    await Promise.all([listenerA.start(), listenerB.start()]);
    assert.equal(listenerA.connected, true);
    assert.equal(listenerB.connected, true);
    for (const request of [humanRequest, serviceRequest, delegatedRequest]) {
      const [decisionA, decisionB] = await Promise.all([
        gatewayA.authorize(request),
        gatewayB.authorize(request),
      ]);
      assert.equal(decisionA.decision, "ALLOW");
      assert.equal(decisionB.decision, "ALLOW");
      assert.equal(decisionA.context?.policyContextHash, decisionB.context?.policyContextHash);
      assert.equal(decisionA.context?.artifactDigest, input.artifactDigest);
    }

    await listenerB.stop();
    assert.equal(listenerB.connected, false);
    const serviceProfileExpectedEpoch = await currentAuthorizationEpoch(input);
    await input.api.query(`SELECT * FROM authz.revoke_service_identity_profile($1, $2, $3)`, [
      input.projectId,
      servicePrincipalId,
      serviceProfileExpectedEpoch.toString(),
    ]);
    const serviceRevocationEpoch = await currentAuthorizationEpoch(input);
    assert.equal(serviceRevocationEpoch, serviceProfileExpectedEpoch + 1n);
    await waitForCondition(
      () => gatewayA.epochFloor(input.projectId) >= serviceRevocationEpoch,
      "Process A did not observe Service revocation.",
    );
    for (const request of [serviceRequest, delegatedRequest]) {
      const denied = await gatewayA.authorize(withCorrelation(request, "a_revoked"));
      assert.equal(denied.decision, "DENY");
    }

    clockB.set(4_999);
    for (const request of [serviceRequest, delegatedRequest]) {
      const cached = await gatewayB.authorize(withCorrelation(request, "b_before_ttl"));
      assert.equal(cached.decision, "ALLOW");
      assert.equal(cached.source, "CACHE");
    }
    clockB.set(5_000);
    for (const request of [serviceRequest, delegatedRequest]) {
      const denied = await gatewayB.authorize(withCorrelation(request, "b_at_ttl"));
      assert.equal(denied.decision, "DENY");
      assert.equal(denied.source, "FAIL_CLOSED");
    }

    await listenerB.start();
    assert.equal(listenerB.connected, true);
    const [rewarmedA, rewarmedB] = await Promise.all([
      gatewayA.authorize(withCorrelation(humanRequest, "human_rewarm_a")),
      gatewayB.authorize(withCorrelation(humanRequest, "human_rewarm_b")),
    ]);
    assert.equal(rewarmedA.decision, "ALLOW");
    assert.equal(rewarmedB.decision, "ALLOW");

    const floorBeforeReconnect = gatewayB.epochFloor(input.projectId);
    const listenerBackendBeforeReconnect = await listenerBackendPid(
      input.admin,
      listenerApplicationB,
    );
    const terminated = await input.admin.query<{ readonly terminated: boolean }>(
      "SELECT pg_terminate_backend($1)::boolean AS terminated",
      [listenerBackendBeforeReconnect],
    );
    assert.equal(terminated.rows[0]?.terminated, true);
    await waitForListenerBackendReplacement(
      input.admin,
      listenerApplicationB,
      listenerBackendBeforeReconnect,
    );
    await waitForCondition(() => listenerB.connected, "Process B listener did not reconnect.");
    assert.equal(gatewayB.epochFloor(input.projectId), floorBeforeReconnect);

    const revokedHuman = await replaceProjectRole(input, readerPrincipal.principalId, null);
    await waitForCondition(
      () =>
        gatewayA.epochFloor(input.projectId) >= revokedHuman.authorizationEpoch &&
        gatewayB.epochFloor(input.projectId) >= revokedHuman.authorizationEpoch,
      "Both processes did not observe Human revocation.",
    );
    const [humanDeniedA, humanDeniedB] = await Promise.all([
      gatewayA.authorize(withCorrelation(humanRequest, "human_revoked_a")),
      gatewayB.authorize(withCorrelation(humanRequest, "human_revoked_b")),
    ]);
    assert.equal(humanDeniedA.decision, "DENY");
    assert.equal(humanDeniedB.decision, "DENY");
    assert.equal(humanDeniedA.source, "FRESH");
    assert.equal(humanDeniedB.source, "FRESH");
  } finally {
    gatewayA.dispose();
    gatewayB.dispose();
    await Promise.all([listenerA.close(), listenerB.close()]);
    await Promise.all([listenerPoolA.end(), listenerPoolB.end()]);
  }

  const ownerRequest = policyGatewayRequest(
    input,
    ownerContext,
    "corr_g20306_owner_exact_artifact_01",
  );
  const exactGateway = new ProductionPolicyGateway({
    processId: "g20306-exact-artifact",
    repository,
    artifacts: input.artifacts,
    monotonicClock: new GatewayManualClock(),
    digestCanonicalText: sha256PolicyText,
  });
  assert.equal((await exactGateway.authorize(ownerRequest)).decision, "ALLOW");
  exactGateway.dispose();

  const artifactKey = `policy/ir/${input.artifactDigest.slice("sha256:".length)}.json`;
  const artifactVersions = await input.managedS3.listVersions(artifactKey);
  assert.ok(artifactVersions.some(({ deleteMarker }) => !deleteMarker));
  for (const version of artifactVersions) {
    if (!version.deleteMarker) await input.managedS3.deleteVersion(artifactKey, version.versionId);
  }
  const missingArtifactGateway = new ProductionPolicyGateway({
    processId: "g20306-missing-artifact",
    repository,
    artifacts: input.artifacts,
    monotonicClock: new GatewayManualClock(),
    digestCanonicalText: sha256PolicyText,
  });
  const missingArtifact = await missingArtifactGateway.authorize(
    withCorrelation(ownerRequest, "artifact_deleted"),
  );
  assert.equal(missingArtifact.decision, "DENY");
  assert.equal(missingArtifact.source, "FAIL_CLOSED");
  assert.equal(missingArtifact.errorCode, "POLICY_ARTIFACT_NOT_FOUND");
  missingArtifactGateway.dispose();

  return Object.freeze({
    migration27RollsBack: true,
    sameSnapshotResolver: true,
    exactProjectReleasePolicyTargetBinding: true,
    duplicatePrincipalRejected: true,
    apiResolverAllowed: true,
    workerResolverDenied: true,
    opsResolverDenied: true,
    exactArtifactLoaded: true,
    humanServiceDelegatedConsistent: true,
    normalNotificationNextRequestDenied: true,
    lostNotificationBeforeBoundaryCached: true,
    lostNotificationAtBoundaryDenied: true,
    listenerReconnectedWithoutReset: true,
    serviceProfileRevocationDenied: true,
    humanBindingRevocationDenied: true,
    deletedArtifactFailedClosed: true,
  });
}

function policyGatewayResolverSql(): string {
  return `SELECT * FROM authz.resolve_policy_gateway_snapshot(
    $1::uuid, $2::uuid[], $3::uuid, $4::text,
    $5::uuid, $6::uuid, $7::text
  )`;
}

async function replaceProjectRole(
  input: Pick<ProductionPolicyGatewayExerciseInput, "metadata" | "owner" | "projectId">,
  principalId: string,
  role: "viewer" | null,
) {
  return input.metadata.replaceRoleBinding(input.owner, {
    projectId: input.projectId,
    targetPrincipalId: principalId,
    role,
    expectedEpoch: await currentAuthorizationEpoch(input),
  });
}

async function currentAuthorizationEpoch(
  input: Pick<ProductionPolicyGatewayExerciseInput, "metadata" | "owner" | "projectId">,
): Promise<bigint> {
  return (await input.metadata.getProject(input.owner, { projectId: input.projectId }))
    .authorizationEpoch;
}

function gatewayIdentity(input: {
  readonly actor: { readonly principalId: string; readonly identityType: IdentityType };
  readonly delegationChain?: readonly {
    readonly principalId: string;
    readonly identityType: IdentityType;
  }[];
  readonly capabilities?: readonly string[];
}): RuntimeIdentityContext {
  const attributes = Object.freeze([Object.freeze({ name: "region", value: "EU" })]);
  const identity = parseIdentityDelegationSummary({
    schemaVersion: 1,
    actor: input.actor,
    delegationChain: input.delegationChain ?? [],
    claimsFingerprint: sha256PolicyText(canonicalizeContractForDigest(attributes)),
    authenticatedAt: "2026-08-20T08:00:00.000000Z",
    authorizationMode: "intersection",
  });
  return Object.freeze({
    identity,
    attributes,
    capabilities: Object.freeze([...(input.capabilities ?? [])]),
    authorizationPrincipalIds: Object.freeze([
      identity.actor.principalId,
      ...identity.delegationChain.map(({ principalId }) => principalId),
    ]),
  });
}

function policyGatewayRequest(
  input: Pick<
    ProductionPolicyGatewayExerciseInput,
    "projectId" | "targetResourceId" | "releaseId" | "policyRevisionId" | "compilerVersion"
  >,
  runtimeIdentity: RuntimeIdentityContext,
  correlationId: string,
): PolicyGatewayRequest {
  return Object.freeze({
    projectId: input.projectId,
    identity: runtimeIdentity,
    resourceId: input.targetResourceId,
    permission: "object.read",
    releaseId: input.releaseId,
    policyRevisionId: input.policyRevisionId,
    compilerVersion: input.compilerVersion,
    correlationId,
  });
}

function withCorrelation(request: PolicyGatewayRequest, suffix: string): PolicyGatewayRequest {
  return Object.freeze({ ...request, correlationId: `corr_g20306_${suffix}_request_0001` });
}

class GatewayManualClock implements PolicyGatewayMonotonicClock {
  #now = 0;

  nowMilliseconds(): number {
    return this.#now;
  }

  set(value: number): void {
    this.#now = value;
  }
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(message);
}

async function listenerBackendPid(pool: pg.Pool, applicationName: string): Promise<number> {
  const result = await pool.query<{ readonly pid: number }>(
    `SELECT pid
     FROM pg_catalog.pg_stat_activity
     WHERE datname = current_database()
       AND application_name = $1
     ORDER BY pid`,
    [applicationName],
  );
  assert.equal(result.rows.length, 1);
  const pid = result.rows[0]?.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Policy Epoch listener backend PID is invalid.");
  }
  return pid;
}

async function waitForListenerBackendReplacement(
  pool: pg.Pool,
  applicationName: string,
  previousPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ readonly pid: number }>(
      `SELECT pid
       FROM pg_catalog.pg_stat_activity
       WHERE datname = current_database()
         AND application_name = $1
         AND pid <> $2
       ORDER BY pid`,
      [applicationName, previousPid],
    );
    if (result.rows.some(({ pid }) => Number.isSafeInteger(pid) && pid > 0)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("Policy Epoch listener backend was not replaced.");
}

async function activateRegionClaimMapping(
  pool: pg.Pool,
  input: { readonly projectId: string; readonly principalId: string },
): Promise<void> {
  const issuer = "https://identity.policy.test";
  const revisionId = randomUUID();
  const mapping = {
    schemaVersion: 1,
    attributes: [{ claim: "region", attribute: "region", valueType: "string", required: true }],
  } as const;
  const definition = parseClaimMappingDefinition(mapping);
  const digest = sha256PolicyText(canonicalClaimMapping(definition));
  await pool.query(
    `SELECT * FROM authz.register_claim_mapping_revision(
       $1, $2, $3, 'human', 1, $4, $5::jsonb, $6
     )`,
    [input.projectId, revisionId, issuer, digest, JSON.stringify(mapping), input.principalId],
  );
  const epoch = await pool.query<{ readonly epoch: string }>(
    `SELECT epoch::text FROM authz.authorization_epochs WHERE project_id = $1`,
    [input.projectId],
  );
  await pool.query(`SELECT * FROM authz.activate_claim_mapping($1, $2, 'human', $3, 0, $4)`, [
    input.projectId,
    issuer,
    revisionId,
    epoch.rows[0]?.epoch,
  ]);
}

function policyDefinition(input: {
  readonly workItemResourceId: string;
  readonly workItemRevisionId: string;
  readonly personResourceId: string;
  readonly personRevisionId: string;
  readonly linkResourceId: string;
  readonly linkRevisionId: string;
}) {
  const objectTarget = {
    kind: "object",
    resourceId: input.workItemResourceId,
    resourceRevisionId: input.workItemRevisionId,
  } as const;
  return {
    schemaVersion: 1,
    rules: [
      {
        ruleId: "ALLOW_OBJECT",
        target: objectTarget,
        effect: "allow",
        predicate: {
          kind: "all",
          predicates: [
            {
              kind: "compare",
              left: { source: "object_property", apiName: "region" },
              op: "eq",
              right: { source: "actor_attribute", apiName: "region" },
            },
            {
              kind: "link_exists",
              linkTypeApiName: "Assignments",
              linkTypeResourceId: input.linkResourceId,
              linkTypeRevisionId: input.linkRevisionId,
              targetObjectTypeApiName: "Person",
              targetObjectTypeResourceId: input.personResourceId,
              targetObjectTypeRevisionId: input.personRevisionId,
              predicate: {
                kind: "compare",
                left: { source: "object_property", apiName: "active" },
                op: "eq",
                right: { source: "constant", value: true },
              },
            },
          ],
        },
      },
      {
        ruleId: "DENY_OBJECT",
        target: objectTarget,
        effect: "deny",
        predicate: {
          kind: "compare",
          left: { source: "object_property", apiName: "status" },
          op: "eq",
          right: { source: "constant", value: "BLOCKED" },
        },
      },
      {
        ruleId: "DENY_PROPERTY",
        target: { ...objectTarget, kind: "property", propertyApiName: "salary" },
        effect: "deny",
        predicate: { kind: "constant", value: true },
      },
      {
        ruleId: "MASK_PROPERTY",
        target: { ...objectTarget, kind: "property", propertyApiName: "email" },
        effect: "mask",
        predicate: { kind: "constant", value: true },
        mask: { kind: "redact", displayValue: "Restricted" },
      },
    ],
    testVectors: [
      vector("ALLOW_OBJECT", objectTarget, "allow", [
        fact("object_property", "active", "value", true),
        fact("actor_attribute", "region", "value", "EU"),
        fact("link", "Assignments", "value", true),
        fact("object_property", "region", "value", "EU"),
        fact("object_property", "status", "value", "OPEN"),
      ]),
      vector(
        "DENY_LINK",
        {
          kind: "link",
          resourceId: input.linkResourceId,
          resourceRevisionId: input.linkRevisionId,
        },
        "deny",
        [fact("link", "Assignments", "missing")],
      ),
      vector("DENY_MISSING", objectTarget, "deny", [fact("object_property", "region", "missing")]),
      vector("DENY_NULL", objectTarget, "deny", [fact("object_property", "region", "null")]),
      {
        ...vector(
          "DENY_PROPERTY",
          { ...objectTarget, kind: "property", propertyApiName: "salary" },
          "deny",
          [],
        ),
        expectedPropertyDisposition: "deny",
      },
      {
        ...vector(
          "MASK_PROPERTY",
          { ...objectTarget, kind: "property", propertyApiName: "email" },
          "allow",
          [],
        ),
        expectedPropertyDisposition: "mask",
      },
    ],
  };
}

function workItemDefinition() {
  return objectType("WorkItem", [
    property("id", "string", true),
    property("region", "string", true),
    property("status", "string", true),
    property("email", "string", false),
    property("salary", "integer", false),
  ]);
}

function personDefinition() {
  return objectType("Person", [
    property("id", "string", true),
    property("active", "boolean", true),
  ]);
}

function objectType(apiName: string, properties: readonly ReturnType<typeof property>[]) {
  return {
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `${apiName} Policy fixture.`,
    primaryKeyPropertyApiName: "id",
    titlePropertyApiName: "id",
    defaultSearchPropertyApiNames: [],
    defaultSort: [{ propertyApiName: "id", direction: "asc" }],
    defaultClassification: "internal",
    properties,
  };
}

function property(
  apiName: string,
  valueType: "string" | "integer" | "boolean",
  filterable: boolean,
) {
  return {
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `${apiName} value.`,
    valueType,
    ...(valueType === "string" ? { caseSensitive: true } : {}),
    nullable: apiName !== "id",
    writeMode: "source_only",
    unique: apiName === "id",
    filterable,
    sortable: apiName === "id",
    searchable: false,
    classification: "internal",
  };
}

function assignmentsDefinition(sourceRevisionId: string, targetRevisionId: string) {
  return {
    schemaVersion: 1,
    apiName: "Assignments",
    displayName: "Assignments",
    description: "Work item assignment.",
    source: {
      objectTypeRevisionId: sourceRevisionId,
      apiName: "WorkItem",
      displayName: "Work item",
    },
    target: {
      objectTypeRevisionId: targetRevisionId,
      apiName: "Person",
      displayName: "Person",
    },
    cardinality: "many_to_many",
    sourceKind: "base",
    deletionBehavior: "detach",
    actionCreateAllowed: false,
    actionDeleteAllowed: false,
  };
}

function vector(
  vectorId: string,
  target: object,
  expectedDecision: "allow" | "deny",
  facts: readonly object[],
) {
  return {
    vectorId,
    identity: {
      schemaVersion: 1,
      actor: { principalId: deterministicUuid(vectorId), identityType: "human" },
      delegationChain: [],
      claimsFingerprint: sha256PolicyText(vectorId),
      authenticatedAt: "2026-08-19T08:00:00.000000Z",
      authorizationMode: "intersection",
    },
    requestTime: "2026-08-19T08:00:00.000000Z",
    target,
    facts,
    expectedDecision,
  };
}

function fact(
  source: "object_property" | "actor_attribute" | "link",
  apiName: string,
  state: "value" | "null" | "missing",
  value?: string | number | boolean,
) {
  return { source, apiName, state, ...(state === "value" ? { value } : {}) };
}

function identity(subject: string): VerifiedFoundationIdentity {
  return parseVerifiedFoundationIdentity({
    issuer: "https://identity.policy.test",
    subject,
    displayName: subject,
    claimsFingerprint: sha256PolicyText(subject),
    authenticatedAt: "2026-08-19T08:00:00.000000Z",
  });
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function fixedDigest(character: string) {
  return sha256PolicyText(character.repeat(64));
}

function postgresError(code: string, message?: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code &&
    (message === undefined || ("message" in error && String(error.message).includes(message)));
}

async function assertMigration26RollsBack(adminConfig: pg.ClientConfig): Promise<void> {
  const databaseName = `${database}_fault_26`;
  await withClient(adminConfig, (client) => client.query(`CREATE DATABASE ${databaseName}`));
  const prefix25 = await migrationPrefixDirectory(25);
  const fault26 = await faultingMigrationDirectory(26);
  try {
    await withClient({ ...adminConfig, database: databaseName }, async (client) => {
      await runDatabaseMigrations(client, { directory: prefix25 });
      await assert.rejects(
        runDatabaseMigrations(client, { directory: fault26 }),
        (error: unknown) =>
          isDatabaseMigrationError(error) && error.code === "DB_MIGRATION_EXECUTION_FAILED",
      );
      const state = await client.query<{
        readonly ledger_count: number;
        readonly compiler_resolver_exists: boolean;
      }>(
        `SELECT
           (SELECT count(*)::integer
            FROM ontos_migration.schema_migrations) AS ledger_count,
           pg_catalog.to_regprocedure(
             'authz.resolve_release_policy_compilations(uuid,uuid)'
           ) IS NOT NULL AS compiler_resolver_exists`,
      );
      assert.deepEqual(state.rows[0], {
        ledger_count: 25,
        compiler_resolver_exists: false,
      });
    });
  } finally {
    await rm(prefix25, { recursive: true, force: true });
    await rm(fault26, { recursive: true, force: true });
  }
}

async function assertMigration27RollsBack(adminConfig: pg.ClientConfig): Promise<void> {
  const databaseName = `${database}_fault_27`;
  await withClient(adminConfig, (client) => client.query(`CREATE DATABASE ${databaseName}`));
  const prefix26 = await migrationPrefixDirectory(26);
  const fault27 = await faultingMigrationDirectory(27);
  try {
    await withClient({ ...adminConfig, database: databaseName }, async (client) => {
      await runDatabaseMigrations(client, { directory: prefix26 });
      await assert.rejects(
        runDatabaseMigrations(client, { directory: fault27 }),
        (error: unknown) =>
          isDatabaseMigrationError(error) && error.code === "DB_MIGRATION_EXECUTION_FAILED",
      );
      const state = await client.query<{
        readonly ledger_count: number;
        readonly gateway_resolver_exists: boolean;
      }>(
        `SELECT
           (SELECT count(*)::integer
            FROM ontos_migration.schema_migrations) AS ledger_count,
           pg_catalog.to_regprocedure(
             'authz.resolve_policy_gateway_snapshot(uuid,uuid[],uuid,text,uuid,uuid,text)'
           ) IS NOT NULL AS gateway_resolver_exists`,
      );
      assert.deepEqual(state.rows[0], {
        ledger_count: 26,
        gateway_resolver_exists: false,
      });
    });
  } finally {
    await rm(prefix26, { recursive: true, force: true });
    await rm(fault27, { recursive: true, force: true });
  }
}

async function migrationPrefixDirectory(through: number): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), `ontos-g20305-prefix-${String(through)}-`));
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

async function waitForS3(client: S3Client, bucket: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("S3 integration container did not become ready.", { cause: lastError });
}

async function waitForPostgreSql(config: pg.ClientConfig): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await withClient(config, (client) => client.query("SELECT 1").then(() => undefined));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("PostgreSQL integration container did not become ready.", { cause: lastError });
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

async function publishedPostgreSqlPort(containerName: string): Promise<number> {
  const { stdout } = await execFileAsync("docker", ["port", containerName, "5432/tcp"]);
  const port = Number(/:(?<port>[0-9]+)\s*$/u.exec(stdout)?.groups?.["port"]);
  if (!Number.isInteger(port) || port <= 0) throw new Error("Invalid PostgreSQL port.");
  return port;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Port reservation failed.");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function docker(arguments_: readonly string[], tolerateFailure = false): Promise<void> {
  try {
    await execFileAsync("docker", [...arguments_]);
  } catch (error) {
    if (!tolerateFailure) throw error;
  }
}
