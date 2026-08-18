import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { HeadBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  type ArtifactDigest,
} from "@ontos/contracts";
import {
  IndexPlanAdmissionService,
  type IndexCapacityCrypto,
} from "@ontos/materialization-application";
import {
  PostgresIndexPlanAdmissionRepository,
  PostgresSnapshotGroupCutoverRepository,
} from "@ontos/materialization-postgres";
import type { ReleaseIndexPlanInput } from "@ontos/materialization-domain";
import {
  MATERIALIZATION_BENCHMARK_FIXTURE,
  MATERIALIZATION_DOMAINS,
  MATERIALIZATION_FIXTURE_DIGEST,
} from "@ontos/testkit";
import pg from "pg";

import { startAdminApi, type RunningAdminApi } from "../../apps/api/src/runtime.ts";
import { startProductionMaterializationWorker } from "../../apps/worker/src/production.ts";
import { startTestOidcProvider, type TestOidcProvider } from "../admin-api/oidc-provider.ts";
import { loadMigrationDefinitions } from "../database/definitions.ts";
import { databaseMigrationDirectory, runDatabaseMigrations } from "../database/migrator.ts";
import { resolvePostgresTestImage } from "../database/postgres-test-image.ts";
import { runQueryPolicyPostgresSpike } from "../query-policy-architecture/postgres-spike.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const postgresImage = resolvePostgresTestImage();
const s3Image =
  "chrislusf/seaweedfs:4.41@sha256:43b768cd62b00d132439cda881b93fd1adebf1b315e996e794087743821d771d";
const database = "ontos_g20214_clean_room";
const adminPassword = "local-only-g20214-admin-secret";
const apiPassword = "local-only-g20214-api-secret";
const workerPassword = "local-only-g20214-worker-secret";
const ddlPassword = "local-only-g20214-ddl-secret";
const accessKeyId = "local-only-g20214-s3-access";
const secretAccessKey = "local-only-g20214-s3-secret";
const cursorSecret = "local-only-g20214-cursor-hmac-secret-value";
const benchmarkObjectRows = MATERIALIZATION_BENCHMARK_FIXTURE.config.objectCount;
const benchmarkLinkRows = MATERIALIZATION_BENCHMARK_FIXTURE.config.linkCount;
const objectRowsPerMember = benchmarkObjectRows / 2;
const ddlEntry = fileURLToPath(
  new URL("../../apps/projection-ddl-executor/src/main.ts", import.meta.url),
);

type DomainFixture = (typeof MATERIALIZATION_DOMAINS)[number];
type RunningWorker = Awaited<ReturnType<typeof startProductionMaterializationWorker>>;

interface SeededMember {
  readonly memberKey: string;
  readonly kind: "object" | "link";
  readonly resourceId: string;
  readonly revisionId: string;
  readonly definition: unknown;
  readonly schemaResourceId: string;
  readonly schemaRevisionId: string;
  readonly mappingResourceId: string;
  readonly mappingRevisionId: string;
  readonly csv: string;
}

interface SeededDomain {
  readonly snapshotGroupId: string;
  readonly revisionIds: readonly string[];
  readonly members: readonly SeededMember[];
}

interface JobDiagnostic {
  readonly state: string;
  readonly currentStage: string | null;
  readonly completedStages: readonly string[];
  readonly generationCount: number;
  readonly generationStates: readonly string[];
  readonly resultCode: string | null;
  readonly attemptCount: number;
  readonly lastFailureCode: string | null;
  readonly lastFailureCategory: string | null;
}

interface ApiResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly json: unknown;
  readonly text: string;
}

void test(
  "G2-02-14 clean-room proves the full production Materialization boundary",
  { timeout: 4_500_000 },
  async () => {
    const startedAt = new Date();
    const clean = await cleanCheckoutIdentity();
    assert.equal(clean.dirty, false, "G2-02-14 must run from a clean checkout");
    const expectedMigrations = await loadMigrationDefinitions(databaseMigrationDirectory);
    assert.equal(
      expectedMigrations.at(-1)?.fileName,
      "0024_query_policy_authorization_boundary.sql",
    );

    const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
    const postgresContainer = `ontos-g20214-pg-${suffix}`;
    const s3Container = `ontos-g20214-s3-${suffix}`;
    const postgresVolume = `ontos-g20214-pg-${suffix}`;
    const s3Volume = `ontos-g20214-s3-${suffix}`;
    const bucket = `ontos-g20214-${process.pid}`;
    const s3Port = await reserveLoopbackPort();
    const oidcPort = await reserveLoopbackPort();
    let oidc: TestOidcProvider | null = await startTestOidcProvider({ port: oidcPort });
    let apiRuntime: RunningAdminApi | null = null;
    let worker: RunningWorker | null = null;
    let admin: pg.Pool | null = null;
    let s3: S3Client | null = null;
    let memoryPeak = process.memoryUsage().rss;
    const memoryMonitor = setInterval(() => {
      memoryPeak = Math.max(memoryPeak, process.memoryUsage().rss);
    }, 100);

    await docker(["volume", "create", "--label", "ontos.gate=G2-02-14", postgresVolume]);
    await docker(["volume", "create", "--label", "ontos.gate=G2-02-14", s3Volume]);
    await docker([
      "run",
      "--detach",
      "--name",
      postgresContainer,
      "--env",
      `POSTGRES_PASSWORD=${adminPassword}`,
      "--env",
      `POSTGRES_DB=${database}`,
      "--mount",
      `type=volume,source=${postgresVolume},target=/var/lib/postgresql/data`,
      "--publish",
      "127.0.0.1::5432",
      postgresImage,
    ]);
    await docker([
      "run",
      "--detach",
      "--name",
      s3Container,
      "--env",
      `AWS_ACCESS_KEY_ID=${accessKeyId}`,
      "--env",
      `AWS_SECRET_ACCESS_KEY=${secretAccessKey}`,
      "--env",
      `S3_BUCKET=${bucket}`,
      "--mount",
      `type=volume,source=${s3Volume},target=/data`,
      "--publish",
      `127.0.0.1:${String(s3Port)}:8333`,
      s3Image,
      "mini",
      "-dir=/data",
    ]);

    try {
      const postgresPort = await publishedPostgreSqlPort(postgresContainer);
      const s3Endpoint = `http://127.0.0.1:${String(s3Port)}`;
      const adminConfig: pg.ClientConfig = {
        host: "127.0.0.1",
        port: postgresPort,
        database,
        user: "postgres",
        password: adminPassword,
        application_name: "ontos-g2-02-14-admin",
      };
      await waitForPostgreSql(adminConfig);
      const firstMigration = await withClient(adminConfig, async (client) => {
        const result = await runDatabaseMigrations(client);
        await client.query(`
          ALTER ROLE api_runtime LOGIN PASSWORD '${apiPassword}';
          ALTER ROLE worker_runtime LOGIN PASSWORD '${workerPassword}';
          CREATE ROLE g20214_ddl LOGIN PASSWORD '${ddlPassword}'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
          GRANT migration_owner TO g20214_ddl;
          GRANT CONNECT ON DATABASE ${database} TO g20214_ddl;
        `);
        return result;
      });
      assert.equal(firstMigration.noOp, false);
      assert.equal(firstMigration.applied.length, expectedMigrations.length);
      admin = new pg.Pool(adminConfig);
      s3 = createS3Client(s3Endpoint);
      await waitForS3(s3, bucket);
      await s3.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );

      const objectStore = objectStoreConfig(s3Endpoint, bucket);
      apiRuntime = await startAdminApi({
        host: "127.0.0.1",
        port: 0,
        databaseUrl: postgresUrl({
          ...adminConfig,
          user: "api_runtime",
          password: apiPassword,
        }),
        oidc: {
          issuer: required(oidc).issuer,
          audience: required(oidc).audience,
          requiredScope: "ontos.admin",
        },
        cursorHmacSecret: cursorSecret,
        managedCsvMaximumBytes: 128 * 1024 * 1024,
        databaseStatementTimeoutMilliseconds: 120_000,
        databaseQueryTimeoutMilliseconds: 125_000,
        objectStore,
      });

      let ownerToken = await required(oidc).token({ subject: "clean-room-owner", name: "Owner" });
      let outsiderToken = await required(oidc).token({
        subject: "clean-room-outsider",
        name: "Outsider",
      });
      const invalidToken = await required(oidc).token({ audience: "wrong-clean-room-audience" });
      const invalidAuth = await api(apiRuntime, invalidToken, "POST", "/api/v1/admin/projects", {
        json: { apiName: "Rejected", displayName: "Rejected" },
      });
      assert.equal(invalidAuth.status, 401);

      const primaryProjectId = await createProject(apiRuntime, ownerToken, "CleanRoomCommerce");
      const secondProjectId = await createProject(apiRuntime, ownerToken, "CleanRoomWork");
      const principalId = await principalIdFor(admin, required(oidc).issuer, "clean-room-owner");
      const commerceFixture = required(MATERIALIZATION_DOMAINS.find(({ id }) => id === "commerce"));
      const workFixture = required(
        MATERIALIZATION_DOMAINS.find(({ id }) => id === "work-management"),
      );
      const baselineObject = required(
        commerceFixture.members.find(({ kind }) => kind === "object"),
      );
      const baselineResourceId = randomUUID();
      const baselineRevisionId = randomUUID();
      await insertPublishedResource(admin, {
        projectId: primaryProjectId,
        principalId,
        resourceId: baselineResourceId,
        revisionId: baselineRevisionId,
        namespace: "fixture.clean-room-baseline",
        apiName: baselineObject.memberKey.slice(baselineObject.memberKey.indexOf(":") + 1),
        family: "object_type",
        content: baselineObject.definition,
      });
      const baselineReleaseId = await createRelease(apiRuntime, ownerToken, primaryProjectId, [
        baselineRevisionId,
      ]);
      await validateAndStageRelease(apiRuntime, ownerToken, baselineReleaseId, "ready");
      const baselinePublish = await api(
        apiRuntime,
        ownerToken,
        "POST",
        `/api/v1/admin/releases/${baselineReleaseId}/publish`,
        { json: { expectedChannelControlSequence: "0" } },
      );
      assert.equal(baselinePublish.status, 200, baselinePublish.text);
      const r1State = await stateCounts(admin, primaryProjectId);
      assert.equal(r1State.activations, 1);
      assert.equal(r1State.servingHeads, 1);
      assert.equal(r1State.materializedMembers, 0);

      const commerce = await seedDomain(admin, primaryProjectId, principalId, commerceFixture);
      const work = await seedDomain(admin, secondProjectId, principalId, workFixture);

      const releaseId = await createRelease(apiRuntime, ownerToken, primaryProjectId, [
        baselineRevisionId,
        ...commerce.revisionIds,
      ]);
      const indexPlanIds = await stageIndexPlans(
        adminConfig,
        primaryProjectId,
        releaseId,
        commerce,
      );
      await executeIndexPlans(adminConfig, primaryProjectId, indexPlanIds);
      await validateAndStageRelease(apiRuntime, ownerToken, releaseId, "staging");

      const benchmarkCsv = buildBenchmarkCsv();
      assert.equal(benchmarkCsv.objectRows, benchmarkObjectRows);
      assert.equal(benchmarkCsv.linkRows, benchmarkLinkRows);
      const walStart = await currentWalLsn(admin);
      const benchmarkStarted = process.hrtime.bigint();
      const firstGroup = await uploadGroup(
        apiRuntime,
        ownerToken,
        primaryProjectId,
        releaseId,
        commerce,
        1,
        benchmarkCsv.byMember,
      );
      const firstJob = await startJob(
        apiRuntime,
        ownerToken,
        primaryProjectId,
        commerce.snapshotGroupId,
        1,
        "g20214-clean-room-job-0001",
      );
      const duplicateFirstJob = await startJob(
        apiRuntime,
        ownerToken,
        primaryProjectId,
        commerce.snapshotGroupId,
        1,
        "g20214-clean-room-job-0001",
      );
      assert.equal(duplicateFirstJob, firstJob);

      const secondReleaseId = await createRelease(
        apiRuntime,
        ownerToken,
        secondProjectId,
        work.revisionIds,
      );
      await stageIndexPlans(adminConfig, secondProjectId, secondReleaseId, work);
      await validateAndStageRelease(apiRuntime, ownerToken, secondReleaseId, "staging");
      await uploadGroup(
        apiRuntime,
        ownerToken,
        secondProjectId,
        secondReleaseId,
        work,
        1,
        new Map(work.members.map((member) => [member.memberKey, Buffer.from(member.csv)])),
      );
      const secondProjectDenied = await api(
        apiRuntime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${secondProjectId}/materialization-jobs`,
        {
          headers: { "idempotency-key": "g20214-second-project-0001" },
          json: { snapshotGroupId: work.snapshotGroupId, groupVersion: 1 },
        },
      );
      assert.equal(secondProjectDenied.status, 409, secondProjectDenied.text);
      assert.equal(errorCode(secondProjectDenied), "MATERIALIZATION_PROJECT_LIMIT_EXCEEDED");

      const workerConfig: pg.ClientConfig = {
        ...adminConfig,
        user: "worker_runtime",
        password: workerPassword,
      };
      worker = await startProductionMaterializationWorker({
        databaseUrl: postgresUrl(workerConfig),
        workerInstanceId: randomUUID(),
        leaseSeconds: 300,
        heartbeatIntervalMilliseconds: 5_000,
        idlePollMilliseconds: 25,
        dependencyBackoffMilliseconds: 100,
        shutdownGraceMilliseconds: 30_000,
        databasePoolMaximum: 6,
        databaseStatementTimeoutMilliseconds: 300_000,
        databaseQueryTimeoutMilliseconds: 305_000,
        objectStore,
      });
      const firstTerminal = await waitForJob(admin, primaryProjectId, firstJob, 1_800_000);
      assert.equal(firstTerminal.state, "succeeded", JSON.stringify(firstTerminal));
      assert.deepEqual(firstTerminal.completedStages, expectedStages);
      assert.equal(firstTerminal.generationCount, 3);
      assert.deepEqual(firstTerminal.generationStates, ["ready", "ready", "ready"]);
      const benchmarkDurationMs = elapsedMilliseconds(benchmarkStarted);
      assert.equal(benchmarkDurationMs < 30 * 60 * 1_000, true);
      const firstBuild = await readBuildEvidence(admin, primaryProjectId, firstJob);
      assert.deepEqual(
        {
          objectRows: firstBuild.objectRows,
          objectCurrentRows: firstBuild.objectCurrentRows,
          linkRows: firstBuild.linkRows,
          linkCurrentRows: firstBuild.linkCurrentRows,
          generationCount: firstBuild.generationIds.length,
          prebuildAdmissions: firstBuild.prebuildAdmissions,
          postbuildAdmissions: firstBuild.postbuildAdmissions,
        },
        {
          objectRows: benchmarkObjectRows,
          objectCurrentRows: benchmarkObjectRows,
          linkRows: benchmarkLinkRows,
          linkCurrentRows: benchmarkLinkRows,
          generationCount: 3,
          prebuildAdmissions: 3,
          postbuildAdmissions: 3,
        },
      );
      const walBytes = await walBytesSince(admin, walStart);
      ownerToken = await required(oidc).token({ subject: "clean-room-owner", name: "Owner" });

      const firstRefresh = await api(
        apiRuntime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${primaryProjectId}/snapshot-groups/${commerce.snapshotGroupId}/versions/1/refresh`,
        { headers: { "idempotency-key": "g20214-first-refresh-0001" }, json: {} },
      );
      assert.equal(firstRefresh.status, 202, firstRefresh.text);
      assert.equal(
        record(required(arrayField(record(firstRefresh.json), "releases")[0]))["outcome"],
        "ready",
      );
      const readyStage = await api(
        apiRuntime,
        ownerToken,
        "POST",
        `/api/v1/admin/releases/${releaseId}/stage`,
      );
      assert.equal(readyStage.status, 200, readyStage.text);
      assert.equal(record(record(readyStage.json)["release"])["state"], "ready");
      const firstActivation = await activate(
        admin,
        apiRuntime,
        ownerToken,
        primaryProjectId,
        commerce.snapshotGroupId,
        1,
        "g20214-first-activate-0001",
      );
      assert.equal(record(firstActivation.json)["changed"], true);
      assert.equal(record(firstActivation.json)["insertedHeadCount"], benchmarkObjectRows);
      const fullPublish = await api(
        apiRuntime,
        ownerToken,
        "POST",
        `/api/v1/admin/releases/${releaseId}/publish`,
        { json: { expectedChannelControlSequence: "1" } },
      );
      assert.equal(fullPublish.status, 200, fullPublish.text);
      const oldServingActivation = await servingActivation(admin, releaseId);
      const queryPolicySpike = await runQueryPolicyPostgresSpike({
        repositoryRoot,
        pool: admin,
        commit: clean.commit,
        cleanCheckout: !clean.dirty,
        projectId: primaryProjectId,
        releaseId,
        sourceMemberKey: "object:Customer",
        linkMemberKey: "link:CustomerPlacedOrder",
        targetMemberKey: "object:Order",
        propertyApiName: "name",
        sourcePrimaryKeyValue: "customer-000001",
        sourcePolicyUpperBound: "Customer 000100",
        targetPolicyUpperBound: "Order 000015",
        expectedListRows: 25,
        expectedPolicyCount: 99,
        expectedLinkRows: 14,
      });
      cleanRoomCheckpoint("g2_03_01_query_policy", {
        status: queryPolicySpike["status"],
        qualification: queryPolicySpike["qualification"],
      });

      const badCsv = new Map<string, Buffer>();
      for (const member of commerce.members) {
        const value =
          member.kind === "object"
            ? member.memberKey === "object:Customer"
              ? "id,name\nduplicate,Ada\nduplicate,Grace\n"
              : "id,name\norder-1,Order\n"
            : "customerId,orderId\nduplicate,order-1\n";
        badCsv.set(member.memberKey, Buffer.from(value));
      }
      await uploadGroup(apiRuntime, ownerToken, primaryProjectId, releaseId, commerce, 2, badCsv);
      const badJob = await startJob(
        apiRuntime,
        ownerToken,
        primaryProjectId,
        commerce.snapshotGroupId,
        2,
        "g20214-bad-refresh-job-0002",
      );
      const badTerminal = await waitForJob(admin, primaryProjectId, badJob, 300_000);
      assert.equal(badTerminal.state, "dead_letter", JSON.stringify(badTerminal));
      assert.equal(await servingActivation(admin, releaseId), oldServingActivation);

      const refreshBenchmarkStarted = process.hrtime.bigint();
      await uploadGroup(
        apiRuntime,
        ownerToken,
        primaryProjectId,
        releaseId,
        commerce,
        3,
        benchmarkCsv.byMember,
      );
      const refreshJob = await startJob(
        apiRuntime,
        ownerToken,
        primaryProjectId,
        commerce.snapshotGroupId,
        3,
        "g20214-good-refresh-job-0003",
      );
      const refreshTerminal = await waitForJob(admin, primaryProjectId, refreshJob, 1_800_000);
      assert.equal(refreshTerminal.state, "succeeded", JSON.stringify(refreshTerminal));
      const refreshBenchmarkDurationMs = elapsedMilliseconds(refreshBenchmarkStarted);
      assert.equal(refreshBenchmarkDurationMs < 30 * 60 * 1_000, true);
      const refreshBuild = await readBuildEvidence(admin, primaryProjectId, refreshJob);
      ownerToken = await required(oidc).token({ subject: "clean-room-owner", name: "Owner" });
      outsiderToken = await required(oidc).token({
        subject: "clean-room-outsider",
        name: "Outsider",
      });
      const refresh = await api(
        apiRuntime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${primaryProjectId}/snapshot-groups/${commerce.snapshotGroupId}/versions/3/refresh`,
        { headers: { "idempotency-key": "g20214-good-refresh-0003" }, json: {} },
      );
      assert.equal(refresh.status, 202, refresh.text);
      assert.equal(
        record(required(arrayField(record(refresh.json), "releases")[0]))["outcome"],
        "ready",
      );
      assert.equal(await servingActivation(admin, releaseId), oldServingActivation);

      const observedActivations = new Set<string>([oldServingActivation]);
      let keepPolling = true;
      const pointerPoll = (async () => {
        while (keepPolling) {
          observedActivations.add(await servingActivation(admin, releaseId));
          await delay(2);
        }
      })();
      const refreshActivation = await (async () => {
        try {
          return await activate(
            admin,
            apiRuntime,
            ownerToken,
            primaryProjectId,
            commerce.snapshotGroupId,
            3,
            "g20214-good-refresh-activate-0003",
          );
        } finally {
          keepPolling = false;
          await pointerPoll;
        }
      })();
      assert.equal(record(refreshActivation.json)["changed"], true);
      const newServingActivation = await servingActivation(admin, releaseId);
      observedActivations.add(newServingActivation);
      assert.equal(newServingActivation === oldServingActivation, false);
      assert.deepEqual(
        [...observedActivations].toSorted(),
        [oldServingActivation, newServingActivation].toSorted(),
      );
      const refreshReplay = await api(
        apiRuntime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${primaryProjectId}/snapshot-groups/${commerce.snapshotGroupId}/versions/3/refresh`,
        { headers: { "idempotency-key": "g20214-good-refresh-0003" }, json: {} },
      );
      assert.equal(refreshReplay.status, 202, refreshReplay.text);
      assert.deepEqual(refreshReplay.json, refresh.json);

      const cutoverPerformance = await measureCutovers(
        admin,
        adminConfig,
        primaryProjectId,
        commerce.snapshotGroupId,
        3,
      );
      cleanRoomCheckpoint("cutover_performance", cutoverPerformance);
      assert.equal(cutoverPerformance.p95Milliseconds < 1_000, true);
      assert.equal(cutoverPerformance.maxMilliseconds < 5_000, true);

      ownerToken = await required(oidc).token({
        subject: "clean-room-owner",
        name: "Owner",
      });
      const capacityEvidence = await exerciseCapacityApproval(
        admin,
        apiRuntime,
        ownerToken,
        primaryProjectId,
        required(refreshBuild.capacityGenerationId),
      );
      cleanRoomCheckpoint("capacity", capacityEvidence);
      ownerToken = await required(oidc).token({
        subject: "clean-room-owner",
        name: "Owner",
      });
      outsiderToken = await required(oidc).token({
        subject: "clean-room-outsider",
        name: "Outsider",
      });
      const securityEvidence = await exerciseSecurityBoundaries({
        adminConfig,
        apiRuntime,
        ownerToken,
        outsiderToken,
        primaryProjectId,
        secondProjectId,
      });
      cleanRoomCheckpoint("security", securityEvidence);
      ownerToken = await required(oidc).token({
        subject: "clean-room-owner",
        name: "Owner",
      });
      const gcEvidence = await exerciseOrphanGarbageCollection({
        admin,
        apiRuntime,
        ownerToken,
        projectId: primaryProjectId,
        releaseId,
        member: required(commerce.members[0]),
      });
      cleanRoomCheckpoint("gc", gcEvidence);

      const stateBeforeRestart = await durableStateManifest(admin, primaryProjectId);
      cleanRoomCheckpoint("restart_begin", { stateManifest: stateBeforeRestart.hash });
      await worker.close();
      worker = null;
      await apiRuntime.close();
      apiRuntime = null;
      await admin.end();
      admin = null;
      s3.destroy();
      s3 = null;
      await required(oidc).close();
      oidc = null;
      await docker(["stop", "--timeout", "300", postgresContainer]);
      await docker(["stop", "--timeout", "120", s3Container]);
      await docker(["start", postgresContainer]);
      await docker(["start", s3Container]);
      oidc = await startTestOidcProvider({ port: oidcPort });
      const restartedPostgresPort = await publishedPostgreSqlPort(postgresContainer);
      const restartedAdminConfig: pg.ClientConfig = {
        ...adminConfig,
        port: restartedPostgresPort,
      };
      cleanRoomCheckpoint("restart_ports", {
        previousPostgresPort: adminConfig.port,
        restartedPostgresPort,
        changed: adminConfig.port !== restartedPostgresPort,
      });
      try {
        await waitForPostgreSql(restartedAdminConfig, 600);
      } catch (error) {
        cleanRoomCheckpoint("restart_failure", {
          postgresState: await dockerOutput([
            "inspect",
            "--format",
            "{{json .State}}",
            postgresContainer,
          ]),
          postgresLogs: await dockerOutput(["logs", "--tail", "80", postgresContainer]),
        });
        throw error;
      }
      s3 = createS3Client(s3Endpoint);
      await waitForS3(s3, bucket);
      const secondMigration = await withClient(restartedAdminConfig, runDatabaseMigrations);
      assert.equal(secondMigration.noOp, true);
      assert.equal(secondMigration.applied.length, 0);
      admin = new pg.Pool(restartedAdminConfig);
      apiRuntime = await startAdminApi({
        host: "127.0.0.1",
        port: 0,
        databaseUrl: postgresUrl({
          ...restartedAdminConfig,
          user: "api_runtime",
          password: apiPassword,
        }),
        oidc: {
          issuer: required(oidc).issuer,
          audience: required(oidc).audience,
          requiredScope: "ontos.admin",
        },
        cursorHmacSecret: cursorSecret,
        managedCsvMaximumBytes: 128 * 1024 * 1024,
        databaseStatementTimeoutMilliseconds: 120_000,
        databaseQueryTimeoutMilliseconds: 125_000,
        objectStore,
      });
      const restartedOwnerToken = await required(oidc).token({
        subject: "clean-room-owner",
        name: "Owner",
      });
      const restartedWorkerConfig: pg.ClientConfig = {
        ...restartedAdminConfig,
        user: "worker_runtime",
        password: workerPassword,
      };
      worker = await startProductionMaterializationWorker({
        databaseUrl: postgresUrl(restartedWorkerConfig),
        workerInstanceId: randomUUID(),
        leaseSeconds: 300,
        heartbeatIntervalMilliseconds: 5_000,
        idlePollMilliseconds: 25,
        dependencyBackoffMilliseconds: 100,
        shutdownGraceMilliseconds: 30_000,
        databasePoolMaximum: 6,
        databaseStatementTimeoutMilliseconds: 300_000,
        databaseQueryTimeoutMilliseconds: 305_000,
        objectStore,
      });
      const restartIndexEvidence = await verifyProjectionIndexesAfterRestart(
        admin,
        primaryProjectId,
        indexPlanIds,
      );
      cleanRoomCheckpoint("restart_indexes", restartIndexEvidence);
      const stateAfterRestart = await durableStateManifest(admin, primaryProjectId);
      assert.deepEqual(stateAfterRestart, stateBeforeRestart);
      cleanRoomCheckpoint("restart_verified", { stateManifest: stateAfterRestart.hash });
      const postRestartGroup = await api(
        apiRuntime,
        restartedOwnerToken,
        "GET",
        `/api/v1/admin/projects/${primaryProjectId}/snapshot-groups/${commerce.snapshotGroupId}/versions/3`,
      );
      assert.equal(postRestartGroup.status, 200, postRestartGroup.text);
      const environmentEvidence = await readEnvironmentEvidence(
        admin,
        postgresContainer,
        s3Container,
      );

      clearInterval(memoryMonitor);
      const artifact = buildCleanRoomArtifact({
        startedAt,
        clean,
        firstMigrationCount: firstMigration.applied.length,
        secondMigrationNoOp: secondMigration.noOp,
        primaryProjectId,
        secondProjectId,
        firstGroup,
        benchmarkCsv,
        benchmarkDurationMs,
        refreshBenchmarkDurationMs,
        walBytes,
        peakRssBytes: memoryPeak,
        firstTerminal,
        badTerminal,
        refreshTerminal,
        cutoverPerformance,
        capacityEvidence,
        securityEvidence,
        gcEvidence,
        stateBeforeRestart,
        stateAfterRestart,
        restartIndexEvidence,
        environmentEvidence,
      });
      await writeCleanRoomArtifact(artifact);
      process.stdout.write(
        `CI_MATERIALIZATION_CLEAN_ROOM status=PASS objects=${String(benchmarkObjectRows)} links=${String(benchmarkLinkRows)} duration_ms=${String(Math.round(benchmarkDurationMs))} report=${String(artifact.reportSha256)}\n`,
      );
    } finally {
      clearInterval(memoryMonitor);
      if (worker !== null) await worker.close();
      if (apiRuntime !== null) await apiRuntime.close();
      if (admin !== null) await admin.end();
      s3?.destroy();
      if (oidc !== null) await oidc.close();
      await docker(["rm", "--force", "--volumes", s3Container], true);
      await docker(["rm", "--force", "--volumes", postgresContainer], true);
      await docker(["volume", "rm", "--force", s3Volume], true);
      await docker(["volume", "rm", "--force", postgresVolume], true);
    }
  },
);

const expectedStages = Object.freeze([
  "scan",
  "map",
  "validate",
  "build_stage",
  "build_index",
  "ready_for_activation",
  "catch_up",
  "activate",
]);

function cleanRoomCheckpoint(stage: string, evidence: unknown): void {
  process.stdout.write(`${JSON.stringify({ kind: "g20214_checkpoint", stage, evidence })}\n`);
}

async function cleanCheckoutIdentity(): Promise<{
  readonly commit: string;
  readonly dirty: boolean;
}> {
  const [{ stdout: commit }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
    execFileAsync("git", ["status", "--porcelain"], { cwd: repositoryRoot }),
  ]);
  return Object.freeze({ commit: commit.trim(), dirty: status.trim().length > 0 });
}

async function createProject(
  runtime: RunningAdminApi,
  token: string,
  apiName: string,
): Promise<string> {
  const response = await api(runtime, token, "POST", "/api/v1/admin/projects", {
    json: { apiName, displayName: apiName },
  });
  assert.equal(response.status, 201, response.text);
  return stringField(record(record(response.json)["project"]), "projectId");
}

async function principalIdFor(pool: pg.Pool, issuer: string, subject: string): Promise<string> {
  const result = await pool.query<{ readonly principalId: string }>(
    `SELECT principal_id AS "principalId" FROM authz.principals
     WHERE oidc_issuer = $1 AND oidc_subject = $2`,
    [issuer, subject],
  );
  return required(result.rows[0]).principalId;
}

async function seedDomain(
  admin: pg.Pool,
  projectId: string,
  principalId: string,
  domain: DomainFixture,
): Promise<SeededDomain> {
  const snapshotGroupId = randomUUID();
  const seededMembers: SeededMember[] = [];
  const insertedTargetRevisions = new Set<string>();
  const revisionIds: string[] = [];

  for (const member of domain.members) {
    if (!insertedTargetRevisions.has(member.revisionId)) {
      await insertPublishedResource(admin, {
        projectId,
        principalId,
        resourceId: member.resourceId,
        revisionId: member.revisionId,
        namespace: domain.namespace,
        apiName: member.memberKey.slice(member.memberKey.indexOf(":") + 1),
        family: member.kind === "object" ? "object_type" : "link_type",
        content: member.definition,
        deferPublish: member.kind === "link",
      });
      insertedTargetRevisions.add(member.revisionId);
      revisionIds.push(member.revisionId);
    }
    const schemaResourceId = randomUUID();
    const mappingResourceId = randomUUID();
    const memberName = member.memberKey.slice(member.memberKey.indexOf(":") + 1);
    await insertPublishedResource(admin, {
      projectId,
      principalId,
      resourceId: schemaResourceId,
      revisionId: member.schemaRevisionId,
      namespace: domain.namespace,
      apiName: `${memberName}CsvSchema`,
      family: "snapshot_schema",
      content: member.schema,
    });
    await insertPublishedResource(admin, {
      projectId,
      principalId,
      resourceId: mappingResourceId,
      revisionId: member.mappingRevisionId,
      namespace: domain.namespace,
      apiName: `${memberName}CsvMapping`,
      family: "mapping",
      content: member.mapping,
    });
    revisionIds.push(member.schemaRevisionId, member.mappingRevisionId);
    seededMembers.push(
      Object.freeze({
        memberKey: member.memberKey,
        kind: member.kind,
        resourceId: member.resourceId,
        revisionId: member.revisionId,
        definition: member.definition,
        schemaResourceId,
        schemaRevisionId: member.schemaRevisionId,
        mappingResourceId,
        mappingRevisionId: member.mappingRevisionId,
        csv: member.csv,
      }),
    );
  }

  for (const member of domain.members) {
    if (member.kind !== "link") continue;
    await admin.query(
      `INSERT INTO meta.resource_dependencies
         (dependency_id, source_revision_id, target_revision_id, dependency_type, source_path)
       VALUES
         ($1, $3, $4, 'link_source', '/source/objectTypeRevisionId'),
         ($2, $3, $5, 'link_target', '/target/objectTypeRevisionId')`,
      [
        randomUUID(),
        randomUUID(),
        member.revisionId,
        member.sourceObject.revisionId,
        member.targetObject.revisionId,
      ],
    );
    await publishResourceRevision(admin, member.revisionId);
  }

  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO runtime.snapshot_groups
         (project_id, snapshot_group_id, group_key, definition_member_count)
       VALUES ($1, $2, $3, $4)`,
      [projectId, snapshotGroupId, `${domain.id}-clean-room`, seededMembers.length],
    );
    const mappingResourceIds = seededMembers
      .map(({ mappingResourceId }) => mappingResourceId)
      .sort();
    for (const [ordinal, mappingResourceId] of mappingResourceIds.entries()) {
      await client.query(
        `INSERT INTO runtime.snapshot_group_definition_members
           (project_id, snapshot_group_id, ordinal, mapping_resource_id)
         VALUES ($1, $2, $3, $4)`,
        [projectId, snapshotGroupId, ordinal, mappingResourceId],
      );
    }
    await client.query(
      `INSERT INTO runtime.project_runtime_inventories
         (project_id, state_revision, inventory_revision, measurement_complete, inventory_digest)
       VALUES ($1, 1, 1, true, $2)`,
      [projectId, digestText(`g2-02-14-${domain.id}-initial-inventory`)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return Object.freeze({
    snapshotGroupId,
    revisionIds: Object.freeze(revisionIds),
    members: Object.freeze(seededMembers),
  });
}

async function insertPublishedResource(
  admin: pg.Pool,
  input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly resourceId: string;
    readonly revisionId: string;
    readonly namespace: string;
    readonly apiName: string;
    readonly family: string;
    readonly content: unknown;
    readonly deferPublish?: boolean;
  },
): Promise<void> {
  const digest = digestJson(input.content);
  await admin.query(
    `INSERT INTO meta.resources
       (resource_id, project_id, namespace, api_name, family)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.resourceId, input.projectId, input.namespace, input.apiName, input.family],
  );
  await admin.query(
    `INSERT INTO meta.resource_revisions
       (revision_id, resource_id, revision_number, family, content_digest,
        content, created_by_principal_id)
     VALUES ($1, $2, 1, $3, $4, $5, $6)`,
    [input.revisionId, input.resourceId, input.family, digest, input.content, input.principalId],
  );
  await admin.query(
    `INSERT INTO meta.validation_reports
       (report_id, subject_type, subject_id, resource_revision_id,
        subject_digest, validation_context_digest, validator_version, valid, issues)
     VALUES ($1, 'resource_revision', $2, $2, $3, $3,
             'metadata-g2-01-v1', true, '[]'::jsonb)`,
    [randomUUID(), input.revisionId, digest],
  );
  if (input.deferPublish !== true) await publishResourceRevision(admin, input.revisionId);
}

async function publishResourceRevision(admin: pg.Pool, revisionId: string): Promise<void> {
  for (const state of ["validated", "published"] as const) {
    await admin.query(
      `UPDATE meta.resource_revisions SET state = $2, changed_at = clock_timestamp()
       WHERE revision_id = $1`,
      [revisionId, state],
    );
  }
}

async function createRelease(
  runtime: RunningAdminApi,
  token: string,
  projectId: string,
  revisionIds: readonly string[],
): Promise<string> {
  const response = await api(
    runtime,
    token,
    "POST",
    `/api/v1/admin/projects/${projectId}/releases`,
    { json: { targetChannelName: "production", revisionIds } },
  );
  assert.equal(response.status, 201, response.text);
  return stringField(record(response.json), "releaseId");
}

async function validateAndStageRelease(
  runtime: RunningAdminApi,
  token: string,
  releaseId: string,
  expectedState: "ready" | "staging",
): Promise<void> {
  const validated = await api(
    runtime,
    token,
    "POST",
    `/api/v1/admin/releases/${releaseId}/validate`,
  );
  assert.equal(validated.status, 200, validated.text);
  const staged = await api(runtime, token, "POST", `/api/v1/admin/releases/${releaseId}/stage`);
  assert.equal(staged.status, 200, staged.text);
  assert.equal(record(record(staged.json)["release"])["state"], expectedState);
}

async function stageIndexPlans(
  adminConfig: pg.ClientConfig,
  projectId: string,
  releaseId: string,
  fixture: SeededDomain,
): Promise<readonly string[]> {
  const pool = new pg.Pool({ ...adminConfig, user: "api_runtime", password: apiPassword });
  try {
    const staged = await new IndexPlanAdmissionService({
      repository: new PostgresIndexPlanAdmissionRepository(pool),
      crypto: cleanRoomCrypto,
    }).stageReleasePlan({
      plan: releaseIndexPlan(projectId, releaseId, fixture),
      at: Date.now(),
    });
    assert.equal(
      staged.persistedPlans.length,
      fixture.members.filter(({ kind }) => kind === "object").length,
    );
    return Object.freeze(staged.persistedPlans.map(({ indexPlanId }) => indexPlanId));
  } finally {
    await pool.end();
  }
}

function releaseIndexPlan(
  projectId: string,
  releaseId: string,
  fixture: SeededDomain,
): ReleaseIndexPlanInput {
  const objectMembers = fixture.members.filter(({ kind }) => kind === "object");
  const evidenceCatalog = objectMembers.flatMap((member) => [
    `query:${member.memberKey}:id`,
    `query:${member.memberKey}:name`,
    `search:${member.memberKey}:name`,
  ]);
  return {
    projectId,
    releaseId,
    evidenceCatalog,
    objectTypes: objectMembers.map((member) => ({
      resourceId: member.resourceId,
      revisionId: member.revisionId,
      properties: [
        { propertyId: "id", type: "string", primaryKey: true },
        { propertyId: "name", type: "string", filterable: true, searchable: true },
      ],
      indexes: [
        {
          kind: "btree",
          keys: [{ propertyId: "name" }],
          evidenceRefs: [`query:${member.memberKey}:name`],
        },
        {
          kind: "gin_trigram",
          propertyId: "name",
          evidenceRefs: [`search:${member.memberKey}:name`],
        },
      ],
    })),
  };
}

async function executeIndexPlans(
  adminConfig: pg.ClientConfig,
  projectId: string,
  indexPlanIds: readonly string[],
): Promise<void> {
  const workerConfig = { ...adminConfig, user: "worker_runtime", password: workerPassword };
  const requestIds: string[] = [];
  await withClient(workerConfig, async (workerClient) => {
    for (const indexPlanId of indexPlanIds) {
      const entries = await workerClient.query<{ readonly entryKey: string }>(
        `SELECT entry_key AS "entryKey" FROM runtime.index_plan_entries
         WHERE project_id = $1 AND index_plan_id = $2 ORDER BY ordinal`,
        [projectId, indexPlanId],
      );
      for (const entry of entries.rows) {
        const requestId = randomUUID();
        const queued = await workerClient.query<{ readonly state: string }>(
          `SELECT state FROM ops.request_projection_index_build($1, $2, $3, $4)`,
          [projectId, indexPlanId, entry.entryKey, requestId],
        );
        assert.equal(required(queued.rows[0]).state, "APPROVED");
        requestIds.push(requestId);
      }
    }
  });
  for (const requestId of requestIds) {
    const environment = { ...process.env };
    for (const key of [
      "ONTOS_DATABASE_URL",
      "ONTOS_API_DATABASE_URL",
      "ONTOS_WORKER_DATABASE_URL",
      "ONTOS_MIGRATION_DATABASE_URL",
    ]) {
      delete environment[key];
    }
    environment.ONTOS_PROJECTION_DDL_DATABASE_URL = postgresUrl({
      ...adminConfig,
      user: "g20214_ddl",
      password: ddlPassword,
    });
    const executed = await execFileAsync(process.execPath, [ddlEntry, "--plan-id", requestId], {
      env: environment,
    });
    assert.match(executed.stdout, /"outcome":"(?:CREATED|REUSED)"/u);
    assert.doesNotMatch(executed.stdout + executed.stderr, /g20214-ddl-secret/u);
  }
}

function buildBenchmarkCsv(): {
  readonly objectRows: number;
  readonly linkRows: number;
  readonly totalBytes: number;
  readonly byMember: ReadonlyMap<string, Buffer>;
  readonly digests: Readonly<Record<string, ArtifactDigest>>;
} {
  const customerLines = new Array<string>(objectRowsPerMember + 1);
  const orderLines = new Array<string>(objectRowsPerMember + 1);
  customerLines[0] = "id,name\n";
  orderLines[0] = "id,name\n";
  for (let index = 1; index <= objectRowsPerMember; index += 1) {
    const id = String(index).padStart(6, "0");
    customerLines[index] = `customer-${id},Customer ${id}\n`;
    orderLines[index] = `order-${id},Order ${id}\n`;
  }
  const linkLines = new Array<string>(benchmarkLinkRows + 1);
  linkLines[0] = "customerId,orderId\n";
  for (let index = 0; index < benchmarkLinkRows; index += 1) {
    const source = (index % objectRowsPerMember) + 1;
    const relationOffset = Math.floor(index / objectRowsPerMember);
    const target = ((source - 1 + relationOffset) % objectRowsPerMember) + 1;
    linkLines[index + 1] =
      `customer-${String(source).padStart(6, "0")},order-${String(target).padStart(6, "0")}\n`;
  }
  const byMember = new Map<string, Buffer>([
    ["object:Customer", Buffer.from(customerLines.join(""), "utf8")],
    ["object:Order", Buffer.from(orderLines.join(""), "utf8")],
    ["link:CustomerPlacedOrder", Buffer.from(linkLines.join(""), "utf8")],
  ]);
  const digests = Object.fromEntries(
    [...byMember].map(([memberKey, value]) => [memberKey, digestBytes(value)]),
  );
  return Object.freeze({
    objectRows: benchmarkObjectRows,
    linkRows: benchmarkLinkRows,
    totalBytes: [...byMember.values()].reduce((sum, value) => sum + value.byteLength, 0),
    byMember,
    digests: Object.freeze(digests),
  });
}

async function uploadGroup(
  runtime: RunningAdminApi,
  token: string,
  projectId: string,
  releaseId: string,
  fixture: SeededDomain,
  groupVersion: number,
  csvByMember: ReadonlyMap<string, Buffer>,
): Promise<{
  readonly groupVersion: number;
  readonly memberCount: number;
  readonly totalBytes: number;
  readonly digests: Readonly<Record<string, ArtifactDigest>>;
}> {
  const sessions: {
    readonly sessionId: string;
    readonly finalizeToken: string;
    readonly clientContentDigest: ArtifactDigest;
  }[] = [];
  const digests: Record<string, ArtifactDigest> = {};
  let totalBytes = 0;
  for (const member of fixture.members) {
    const csv = required(csvByMember.get(member.memberKey));
    totalBytes += csv.byteLength;
    const digest = digestBytes(csv);
    digests[member.memberKey] = digest;
    const created = await api(runtime, token, "POST", "/api/v1/admin/snapshot-upload-sessions", {
      json: {
        projectId,
        releaseId,
        targetMemberKey: member.memberKey,
        groupVersion,
        expectedByteCount: csv.byteLength,
        sourceLabel: `${member.memberKey.replace(":", "-")}-v${String(groupVersion)}.csv`,
      },
    });
    assert.equal(created.status, 201, created.text);
    const session = record(created.json);
    const uploaded = await api(runtime, token, "PUT", stringField(session, "uploadPath"), {
      bytes: csv,
    });
    assert.equal(uploaded.status, 200, uploaded.text);
    sessions.push(
      Object.freeze({
        sessionId: stringField(session, "sessionId"),
        finalizeToken: stringField(session, "finalizeToken"),
        clientContentDigest: digest,
      }),
    );
  }
  const finalized = await api(runtime, token, "POST", "/api/v1/admin/snapshots", {
    json: { projectId, sessions },
  });
  assert.equal(finalized.status, 201, finalized.text);
  const group = record(finalized.json);
  assert.equal(Number(record(group["group"])["groupVersion"]), groupVersion);
  return Object.freeze({
    groupVersion,
    memberCount: sessions.length,
    totalBytes,
    digests: Object.freeze(digests),
  });
}

async function startJob(
  runtime: RunningAdminApi,
  token: string,
  projectId: string,
  snapshotGroupId: string,
  groupVersion: number,
  idempotencyKey: string,
): Promise<string> {
  const response = await api(
    runtime,
    token,
    "POST",
    `/api/v1/admin/projects/${projectId}/materialization-jobs`,
    {
      headers: { "idempotency-key": idempotencyKey },
      json: { snapshotGroupId, groupVersion },
    },
  );
  assert.equal(response.status, 202, response.text);
  return stringField(record(response.json), "jobId");
}

async function waitForJob(
  admin: pg.Pool,
  projectId: string,
  jobId: string,
  timeoutMilliseconds: number,
): Promise<JobDiagnostic> {
  const deadline = Date.now() + timeoutMilliseconds;
  let latest: JobDiagnostic | null = null;
  while (Date.now() < deadline) {
    const result = await admin.query<JobDiagnostic & pg.QueryResultRow>(
      `SELECT state, current_stage AS "currentStage", result_code AS "resultCode",
              attempt_count AS "attemptCount",
              last_failure_code AS "lastFailureCode",
              last_failure_category AS "lastFailureCategory",
              ARRAY(
                SELECT checkpoint.stage
                FROM ops.materialization_checkpoints AS checkpoint
                WHERE checkpoint.project_id = job.project_id
                  AND checkpoint.job_id = job.job_id
                ORDER BY checkpoint.sequence
              ) AS "completedStages",
              (SELECT count(*)::integer FROM runtime.generations AS generation
               WHERE generation.project_id = job.project_id
                 AND generation.snapshot_group_id = job.snapshot_group_id
                 AND generation.group_version = job.group_version) AS "generationCount",
              ARRAY(
                SELECT generation.state
                FROM runtime.generations AS generation
                WHERE generation.project_id = job.project_id
                  AND generation.snapshot_group_id = job.snapshot_group_id
                  AND generation.group_version = job.group_version
                ORDER BY generation.member_key
              ) AS "generationStates"
       FROM ops.materialization_jobs AS job
       WHERE project_id = $1 AND job_id = $2`,
      [projectId, jobId],
    );
    latest = required(result.rows[0]);
    if (["succeeded", "dead_letter", "cancelled"].includes(latest.state)) return latest;
    await delay(100);
  }
  throw new Error(`Worker job timed out: ${JSON.stringify(latest)}`);
}

async function readBuildEvidence(admin: pg.Pool, projectId: string, jobId: string) {
  const result = await admin.query<{
    readonly generationIds: string[];
    readonly capacityGenerationId: string | null;
    readonly reportIds: string[];
    readonly objectRows: number;
    readonly objectCurrentRows: number;
    readonly linkRows: number;
    readonly linkCurrentRows: number;
    readonly prebuildAdmissions: number;
    readonly postbuildAdmissions: number;
  }>(
    `WITH selected AS (
       SELECT generation.generation_id, generation.report_id
       FROM ops.materialization_jobs AS job
       JOIN runtime.generations AS generation
         ON generation.project_id = job.project_id
        AND generation.snapshot_group_id = job.snapshot_group_id
        AND generation.group_version = job.group_version
       WHERE job.project_id = $1 AND job.job_id = $2
     )
     SELECT
       ARRAY(SELECT generation_id::text FROM selected ORDER BY generation_id) AS "generationIds",
       (SELECT selected_generation.generation_id::text
          FROM selected AS selected_generation
         WHERE EXISTS (
           SELECT 1
           FROM runtime.capacity_admissions AS admission
           JOIN runtime.source_forecasts AS forecast
             ON forecast.project_id = admission.project_id
            AND forecast.forecast_digest = admission.source_forecast_digest
           JOIN runtime.project_physical_measurements AS measurement
             ON measurement.project_id = admission.project_id
            AND measurement.measurement_digest = admission.physical_measurement_digest
           WHERE admission.project_id = $1
             AND admission.generation_id = selected_generation.generation_id
             AND admission.phase = 'POSTBUILD'
         )
         ORDER BY selected_generation.generation_id
         LIMIT 1) AS "capacityGenerationId",
       ARRAY(SELECT DISTINCT report_id::text FROM selected ORDER BY report_id) AS "reportIds",
       (SELECT count(*)::integer FROM runtime.object_base
        WHERE project_id = $1 AND generation_id IN (SELECT generation_id FROM selected)) AS "objectRows",
       (SELECT count(*)::integer FROM runtime.object_current
        WHERE project_id = $1 AND generation_id IN (SELECT generation_id FROM selected)) AS "objectCurrentRows",
       (SELECT count(*)::integer FROM runtime.link_base
        WHERE project_id = $1 AND generation_id IN (SELECT generation_id FROM selected)) AS "linkRows",
       (SELECT count(*)::integer FROM runtime.link_current
        WHERE project_id = $1 AND generation_id IN (SELECT generation_id FROM selected)) AS "linkCurrentRows",
       (SELECT count(*)::integer FROM runtime.capacity_admissions
        WHERE project_id = $1 AND generation_id IN (SELECT generation_id FROM selected)
          AND phase = 'PREBUILD') AS "prebuildAdmissions",
       (SELECT count(*)::integer FROM runtime.capacity_admissions
        WHERE project_id = $1 AND generation_id IN (SELECT generation_id FROM selected)
          AND phase = 'POSTBUILD') AS "postbuildAdmissions"`,
    [projectId, jobId],
  );
  return required(result.rows[0]);
}

async function stateCounts(
  admin: pg.Pool,
  projectId: string,
): Promise<{
  readonly activations: number;
  readonly servingHeads: number;
  readonly materializedMembers: number;
}> {
  const result = await admin.query<{
    readonly activations: number;
    readonly servingHeads: number;
    readonly materializedMembers: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM meta.runtime_activations AS activation
        JOIN meta.releases AS release ON release.release_id = activation.release_id
        WHERE release.project_id = $1) AS activations,
       (SELECT count(*)::integer FROM meta.release_serving_heads AS head
        JOIN meta.releases AS release ON release.release_id = head.release_id
        WHERE release.project_id = $1) AS "servingHeads",
       (SELECT COALESCE(sum(activation.member_count), 0)::integer
        FROM meta.runtime_activations AS activation
        JOIN meta.releases AS release ON release.release_id = activation.release_id
        WHERE release.project_id = $1) AS "materializedMembers"`,
    [projectId],
  );
  return required(result.rows[0]);
}

async function activate(
  admin: pg.Pool,
  runtime: RunningAdminApi,
  token: string,
  projectId: string,
  snapshotGroupId: string,
  groupVersion: number,
  idempotencyKey: string,
): Promise<ApiResponse> {
  const control = await admin.query<{ readonly publicationSequence: string }>(
    `SELECT publication_sequence::text AS "publicationSequence"
     FROM meta.projects WHERE project_id = $1`,
    [projectId],
  );
  const response = await api(
    runtime,
    token,
    "POST",
    `/api/v1/admin/projects/${projectId}/snapshot-groups/${snapshotGroupId}/versions/${String(groupVersion)}/activate`,
    {
      headers: { "idempotency-key": idempotencyKey },
      json: { expectedControlRevision: required(control.rows[0]).publicationSequence },
    },
  );
  assert.equal(response.status, 200, response.text);
  return response;
}

async function servingActivation(admin: pg.Pool, releaseId: string): Promise<string> {
  const result = await admin.query<{ readonly activationId: string }>(
    `SELECT activation_id AS "activationId" FROM meta.release_serving_heads
     WHERE release_id = $1`,
    [releaseId],
  );
  return required(result.rows[0]).activationId;
}

async function measureCutovers(
  admin: pg.Pool,
  adminConfig: pg.ClientConfig,
  projectId: string,
  snapshotGroupId: string,
  groupVersion: number,
): Promise<{
  readonly runs: number;
  readonly p95Milliseconds: number;
  readonly maxMilliseconds: number;
  readonly samplesMilliseconds: readonly number[];
}> {
  const control = await admin.query<{ readonly publicationSequence: string }>(
    `SELECT publication_sequence::text AS "publicationSequence"
     FROM meta.projects WHERE project_id = $1`,
    [projectId],
  );
  const overlayEvidence = Object.freeze({
    providerId: "ontos.zero-overlay",
    providerVersion: "1",
    projectId,
    snapshotGroupKey: `${snapshotGroupId}:${String(groupVersion)}`,
    complete: true,
    watermark: 0,
    deltaCount: 0,
    digest: `sha256:${"0".repeat(64)}`,
  });
  const apiPool = new pg.Pool({
    ...adminConfig,
    user: "api_runtime",
    password: apiPassword,
    statement_timeout: 300_000,
    query_timeout: 305_000,
  });
  const repository = new PostgresSnapshotGroupCutoverRepository(apiPool);
  const samples: number[] = [];
  try {
    for (let index = 0; index < 20; index += 1) {
      const preparation = await repository.prepareSnapshotGroupCutover({
        command: {
          projectId,
          snapshotGroupId,
          groupVersion,
          expectedControlRevision: BigInt(required(control.rows[0]).publicationSequence),
          idempotencyKey: `g20214-cutover-${String(index).padStart(4, "0")}`,
        },
        overlayEvidence,
      });
      const started = process.hrtime.bigint();
      const result = await repository.commitSnapshotGroupCutover({
        preparation,
        overlayEvidence,
      });
      samples.push(elapsedMilliseconds(started));
      assert.equal(result.changed, false);
    }
  } finally {
    await apiPool.end();
  }
  const ordered = samples.toSorted((left, right) => left - right);
  return Object.freeze({
    runs: samples.length,
    p95Milliseconds: required(ordered[Math.ceil(ordered.length * 0.95) - 1]),
    maxMilliseconds: Math.max(...samples),
    samplesMilliseconds: Object.freeze(samples),
  });
}

async function exerciseCapacityApproval(
  admin: pg.Pool,
  runtime: RunningAdminApi,
  token: string,
  projectId: string,
  generationId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const capacity = await api(
    runtime,
    token,
    "GET",
    `/api/v1/admin/projects/${projectId}/generations/${generationId}/capacity`,
  );
  assert.equal(capacity.status, 200, capacity.text);
  assert.equal(record(capacity.json)["phase"], "POSTBUILD");
  const etag = required(capacity.headers.get("etag"));
  const expiresAt = canonicalFutureInstant(24 * 60 * 60 * 1_000);
  const rejected = await api(
    runtime,
    token,
    "POST",
    `/api/v1/admin/projects/${projectId}/capacity-approvals`,
    {
      headers: { "if-match": etag },
      json: {
        scope: "project_peak",
        scopeId: null,
        approvedLimitBytes: "12884901889",
        expiresAt,
      },
    },
  );
  assert.equal(rejected.status, 400, rejected.text);
  const approved = await api(
    runtime,
    token,
    "POST",
    `/api/v1/admin/projects/${projectId}/capacity-approvals`,
    {
      headers: { "if-match": etag },
      json: {
        scope: "project_peak",
        scopeId: null,
        approvedLimitBytes: "11811160064",
        expiresAt,
      },
    },
  );
  assert.equal(approved.status, 201, approved.text);
  assert.equal(record(approved.json)["hardLimitBytes"], "12884901888");
  const evidence = await admin.query<{
    readonly forecastBytes: string;
    readonly observedBytes: string;
    readonly admissionObservedBytes: string;
    readonly capacityMeasuredBytes: string;
    readonly selectedMaximum: string;
    readonly admissionMode: string;
  }>(
    `SELECT forecast.projected_measured_bytes::text AS "forecastBytes",
            measurement.total_relation_bytes::text AS "observedBytes",
            admission.observed_project_physical_bytes::text AS "admissionObservedBytes",
            admission.measured_bytes::text AS "capacityMeasuredBytes",
            GREATEST(forecast.projected_measured_bytes,
                     measurement.total_relation_bytes)::text
              AS "selectedMaximum",
            admission.report ->> 'accepted' AS "admissionMode"
     FROM runtime.capacity_admissions AS admission
     JOIN runtime.source_forecasts AS forecast
       ON forecast.project_id = admission.project_id
      AND forecast.forecast_digest = admission.source_forecast_digest
     JOIN runtime.project_physical_measurements AS measurement
       ON measurement.project_id = admission.project_id
      AND measurement.measurement_digest = admission.physical_measurement_digest
     WHERE admission.project_id = $1 AND admission.generation_id = $2
       AND admission.phase = 'POSTBUILD'
     ORDER BY admission.inventory_revision DESC, admission.admitted_at DESC
     LIMIT 1`,
    [projectId, generationId],
  );
  const row = required(evidence.rows[0]);
  assert.equal(row.admissionObservedBytes, row.observedBytes);
  assert.equal(BigInt(row.capacityMeasuredBytes) >= BigInt(row.selectedMaximum), true);
  return Object.freeze({
    normalAdmission: record(capacity.json)["reportDigest"] !== null,
    hardLimitBytes: "12884901888",
    overHardLimitRejected: true,
    approvalCreated: true,
    forecastBytes: row.forecastBytes,
    observedBytes: row.observedBytes,
    selectedMaximumBytes: row.selectedMaximum,
    capacityMeasuredBytes: row.capacityMeasuredBytes,
  });
}

async function exerciseSecurityBoundaries(input: {
  readonly adminConfig: pg.ClientConfig;
  readonly apiRuntime: RunningAdminApi;
  readonly ownerToken: string;
  readonly outsiderToken: string;
  readonly primaryProjectId: string;
  readonly secondProjectId: string;
}): Promise<Readonly<Record<string, unknown>>> {
  const invisible = await api(
    input.apiRuntime,
    input.outsiderToken,
    "GET",
    `/api/v1/admin/projects/${input.primaryProjectId}`,
  );
  assert.equal(invisible.status, 404, invisible.text);
  const crossProject = await api(
    input.apiRuntime,
    input.ownerToken,
    "GET",
    `/api/v1/admin/projects/${input.secondProjectId}/materialization-jobs/${randomUUID()}`,
  );
  assert.equal(crossProject.status, 404, crossProject.text);
  const traversal = await api(
    input.apiRuntime,
    input.ownerToken,
    "POST",
    "/api/v1/admin/snapshot-upload-sessions",
    {
      json: {
        projectId: input.primaryProjectId,
        releaseId: randomUUID(),
        targetMemberKey: "object:Customer",
        groupVersion: 1,
        expectedByteCount: 8,
        sourceLabel: "../escape.csv",
      },
    },
  );
  assert.equal(traversal.status, 400, traversal.text);
  const apiDirectDenied = await queryDenied(
    { ...input.adminConfig, user: "api_runtime", password: apiPassword },
    "SELECT count(*) FROM runtime.object_base",
  );
  const workerAuthDenied = await queryDenied(
    { ...input.adminConfig, user: "worker_runtime", password: workerPassword },
    "SELECT count(*) FROM authz.principals",
  );
  const ddlMetadataDenied = await queryDenied(
    { ...input.adminConfig, user: "g20214_ddl", password: ddlPassword },
    "SELECT count(*) FROM meta.projects",
  );
  const serializedErrors = `${invisible.text}${crossProject.text}${traversal.text}`;
  for (const secret of [adminPassword, apiPassword, workerPassword, ddlPassword, secretAccessKey]) {
    assert.doesNotMatch(serializedErrors, new RegExp(escapeRegex(secret), "u"));
  }
  return Object.freeze({
    invalidOidcRejected: true,
    unauthorizedProjectHidden: true,
    crossProjectHidden: true,
    uploadTraversalRejected: true,
    apiDirectTableDenied: apiDirectDenied,
    workerAuthTableDenied: workerAuthDenied,
    ddlMetadataTableDenied: ddlMetadataDenied,
    sensitiveErrorsRedacted: true,
  });
}

async function queryDenied(config: pg.ClientConfig, sql: string): Promise<boolean> {
  try {
    await withClient(config, (client) => client.query(sql).then(() => undefined));
    return false;
  } catch (error) {
    const candidate = error as { readonly code?: unknown };
    assert.equal(candidate.code, "42501");
    return true;
  }
}

async function exerciseOrphanGarbageCollection(input: {
  readonly admin: pg.Pool;
  readonly apiRuntime: RunningAdminApi;
  readonly ownerToken: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly member: SeededMember;
}): Promise<Readonly<Record<string, unknown>>> {
  const csv = Buffer.from("id,name\norphan,Orphan\n", "utf8");
  const created = await api(
    input.apiRuntime,
    input.ownerToken,
    "POST",
    "/api/v1/admin/snapshot-upload-sessions",
    {
      json: {
        projectId: input.projectId,
        releaseId: input.releaseId,
        targetMemberKey: input.member.memberKey,
        groupVersion: 4,
        expectedByteCount: csv.byteLength,
        sourceLabel: "orphan-gc.csv",
      },
    },
  );
  assert.equal(created.status, 201, created.text);
  const session = record(created.json);
  const sessionId = stringField(session, "sessionId");
  const uploaded = await api(
    input.apiRuntime,
    input.ownerToken,
    "PUT",
    stringField(session, "uploadPath"),
    { bytes: csv },
  );
  assert.equal(uploaded.status, 200, uploaded.text);

  const client = await input.admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE runtime.snapshot_upload_sessions DISABLE TRIGGER USER");
    await client.query(
      `UPDATE runtime.snapshot_upload_sessions
       SET state = 'expired', failure_code = 'SESSION_EXPIRED',
           created_at = clock_timestamp() - interval '2 days',
           expires_at = clock_timestamp() - interval '47 hours 50 minutes',
           cleanup_after = clock_timestamp() - interval '46 hours 50 minutes',
           changed_at = clock_timestamp() - interval '46 hours'
       WHERE project_id = $1 AND session_id = $2`,
      [input.projectId, sessionId],
    );
    await client.query("ALTER TABLE runtime.snapshot_upload_sessions ENABLE TRIGGER USER");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  let dryRunSequence = 0;
  let dryRunDependencyRetries = 0;
  const createPlan = async (): Promise<{ readonly id: string; readonly digest: string }> => {
    dryRunSequence += 1;
    const idempotencyKey = `g20214-gc-dry-run-${String(dryRunSequence).padStart(4, "0")}`;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const dryRun = await api(
        input.apiRuntime,
        input.ownerToken,
        "POST",
        `/api/v1/admin/projects/${input.projectId}/gc/dry-run`,
        {
          headers: { "idempotency-key": idempotencyKey },
          json: {},
        },
      );
      if (dryRun.status === 503 && errorCode(dryRun) === "DEPENDENCY_UNAVAILABLE" && attempt < 5) {
        dryRunDependencyRetries += 1;
        cleanRoomCheckpoint("gc_dry_run_retry", {
          dryRunSequence,
          attempt,
          status: dryRun.status,
          response: record(dryRun.json),
        });
        await delay(250 * attempt);
        continue;
      }
      assert.equal(dryRun.status, 200, dryRun.text);
      const dryRunBody = record(dryRun.json);
      assert.equal(record(dryRunBody["analysis"])["status"], "READY", dryRun.text);
      return Object.freeze({
        id: stringField(dryRunBody, "planId"),
        digest: required(dryRun.headers.get("etag")),
      });
    }
    throw new Error("GC dry-run retry bound was exhausted");
  };
  let plan = await createPlan();
  let totalAffectedRows = 0;
  let state = "";
  let commitAttempts = 0;
  let staleReplans = 0;
  for (; commitAttempts < 100; commitAttempts += 1) {
    const committed = await api(
      input.apiRuntime,
      input.ownerToken,
      "POST",
      `/api/v1/admin/projects/${input.projectId}/gc/plans/${plan.id}/commit`,
      { headers: { "if-match": plan.digest }, json: {} },
    );
    const body = record(committed.json);
    cleanRoomCheckpoint("gc_batch", {
      batch: commitAttempts + 1,
      status: committed.status,
      response: body,
    });
    if (committed.status !== 202) {
      const diagnostic = await input.admin.query<Readonly<Record<string, unknown>>>(
        `SELECT plan.state AS "planState", plan.phase,
                plan.current_state_revision::text AS "planStateRevision",
                inventory.state_revision::text AS "inventoryStateRevision",
                plan.current_inventory_revision::text AS "planInventoryRevision",
                inventory.inventory_revision::text AS "inventoryRevision",
                inventory.measurement_complete AS "measurementComplete",
                plan.root_state_digest AS "planRootDigest",
                ontos_migration.g20212_root_state_digest($1::uuid) AS "liveRootDigest",
                COALESCE(epoch.root_revision, 0)::text AS "rootRevision",
                run.state AS "runState", run.result_code AS "runResultCode",
                (SELECT count(*)::integer FROM ops.gc_plan_entries AS entry
                 WHERE entry.project_id = plan.project_id
                   AND entry.gc_plan_id = plan.gc_plan_id
                   AND entry.disposition = 'CANDIDATE'
                   AND entry.completed_at IS NULL) AS "remainingCandidates"
         FROM ops.gc_plans AS plan
         JOIN ops.gc_runs AS run
           ON run.project_id = plan.project_id AND run.gc_run_id = plan.gc_run_id
         JOIN runtime.project_runtime_inventories AS inventory
           ON inventory.project_id = plan.project_id
         LEFT JOIN ops.gc_root_epochs AS epoch ON epoch.project_id = plan.project_id
         WHERE plan.project_id = $1::uuid AND plan.gc_plan_id = $2::uuid`,
        [input.projectId, plan.id],
      );
      const failure = required(diagnostic.rows[0]);
      cleanRoomCheckpoint("gc_batch_failure", failure);
      if (committed.status === 409 && errorCode(committed) === "OBJECT_VERSION_CONFLICT") {
        assert.equal(staleReplans < 4, true, "GC root state did not stabilize after replanning");
        staleReplans += 1;
        const stalePlanId = plan.id;
        plan = await createPlan();
        assert.notEqual(plan.id, stalePlanId);
        cleanRoomCheckpoint("gc_stale_replan", {
          stalePlanId,
          replacementPlanId: plan.id,
          staleReplans,
          failure,
        });
        continue;
      }
    }
    assert.equal(committed.status, 202, committed.text);
    state = stringField(body, "state");
    totalAffectedRows += Number(body["affectedRows"]);
    if (state === "COMMITTED") break;
    assert.notEqual(state, "WAITING_FOR_INDEX_DDL", committed.text);
  }
  assert.equal(state, "COMMITTED");
  const cleaned = await input.admin.query<{ readonly state: string }>(
    `SELECT state FROM runtime.snapshot_upload_sessions
     WHERE project_id = $1 AND session_id = $2`,
    [input.projectId, sessionId],
  );
  assert.equal(required(cleaned.rows[0]).state, "cleaned");
  return Object.freeze({
    planId: plan.id,
    planDigest: plan.digest.replaceAll('"', ""),
    batches: commitAttempts + 1,
    dryRunDependencyRetries,
    staleReplans,
    totalAffectedRows,
    orphanObjectVersionReclaimed: true,
    finalState: state,
  });
}

interface DurableStateManifest {
  readonly hash: ArtifactDigest;
  readonly facts: Readonly<Record<string, unknown>>;
}

async function durableStateManifest(
  admin: pg.Pool,
  projectId: string,
): Promise<DurableStateManifest> {
  const result = await admin.query<{ readonly facts: Readonly<Record<string, unknown>> }>(
    `SELECT jsonb_build_object(
       'snapshotGroups', COALESCE((
         SELECT jsonb_agg(jsonb_build_array(snapshot_group_id, group_version, state, group_digest)
                          ORDER BY snapshot_group_id, group_version)
         FROM runtime.snapshot_group_versions WHERE project_id = $1
       ), '[]'::jsonb),
       'jobs', COALESCE((
         SELECT jsonb_agg(jsonb_build_array(job_id, snapshot_group_id, group_version, state,
                                            current_stage, result_code, result_digest,
                                            attempt_count, fencing_token)
                          ORDER BY job_id)
         FROM ops.materialization_jobs WHERE project_id = $1
       ), '[]'::jsonb),
       'generations', COALESCE((
         SELECT jsonb_agg(jsonb_build_array(generation_id, member_key, state,
                                            generation_digest, report_digest)
                          ORDER BY generation_id)
         FROM runtime.generations WHERE project_id = $1
       ), '[]'::jsonb),
       'activations', COALESCE((
         SELECT jsonb_agg(jsonb_build_array(activation.activation_id,
                                            activation.release_id,
                                            activation.activation_digest,
                                            activation.member_count,
                                            activation.state)
                          ORDER BY activation.activation_id)
         FROM meta.runtime_activations AS activation
         JOIN meta.releases AS release ON release.release_id = activation.release_id
         WHERE release.project_id = $1
       ), '[]'::jsonb),
       'servingHeads', COALESCE((
         SELECT jsonb_agg(jsonb_build_array(head.release_id, head.activation_id,
                                            head.control_sequence)
                          ORDER BY head.release_id)
         FROM meta.release_serving_heads AS head
         JOIN meta.releases AS release ON release.release_id = head.release_id
         WHERE release.project_id = $1
       ), '[]'::jsonb),
       'channels', COALESCE((
         SELECT jsonb_agg(jsonb_build_array(channel_name, release_id, activation_id,
                                            control_sequence)
                          ORDER BY channel_name)
         FROM meta.release_channels WHERE project_id = $1
       ), '[]'::jsonb),
       'gcRuns', COALESCE((
         SELECT jsonb_agg(jsonb_build_array(gc_run_id, state, result_code)
                          ORDER BY gc_run_id)
         FROM ops.gc_runs WHERE project_id = $1
       ), '[]'::jsonb),
       'gcPlans', COALESCE((
         SELECT jsonb_agg(jsonb_build_array(gc_plan_id, gc_run_id, state, plan_digest)
                          ORDER BY gc_plan_id)
         FROM ops.gc_plans WHERE project_id = $1
       ), '[]'::jsonb),
       'counts', jsonb_build_object(
         'objectBase', (SELECT count(*) FROM runtime.object_base WHERE project_id = $1),
         'objectCurrent', (SELECT count(*) FROM runtime.object_current WHERE project_id = $1),
         'linkBase', (SELECT count(*) FROM runtime.link_base WHERE project_id = $1),
         'linkCurrent', (SELECT count(*) FROM runtime.link_current WHERE project_id = $1),
         'objectStaging', (SELECT count(*) FROM ops.object_base_staging WHERE project_id = $1),
         'linkStaging', (SELECT count(*) FROM ops.link_base_staging WHERE project_id = $1),
         'activeLeases', (SELECT count(*) FROM ops.materialization_jobs
                          WHERE project_id = $1 AND state = 'running')
       )
     ) AS facts`,
    [projectId],
  );
  const facts = required(result.rows[0]).facts;
  return Object.freeze({ hash: digestJson(facts), facts: Object.freeze(facts) });
}

async function verifyProjectionIndexesAfterRestart(
  admin: pg.Pool,
  projectId: string,
  indexPlanIds: readonly string[],
): Promise<Readonly<Record<string, unknown>>> {
  const result = await admin.query<{
    readonly indexName: string;
    readonly physicalSignature: string;
    readonly inventoryState: string | null;
    readonly catalogPresent: boolean;
    readonly signatureBound: boolean;
  }>(
    `WITH expected AS (
       SELECT DISTINCT entry.index_name, entry.physical_signature
       FROM runtime.index_plan_entries AS entry
       WHERE entry.project_id = $1::uuid
         AND entry.index_plan_id = ANY($2::uuid[])
     )
     SELECT expected.index_name AS "indexName",
            expected.physical_signature AS "physicalSignature",
            inventory.state AS "inventoryState",
            catalog_index.oid IS NOT NULL AS "catalogPresent",
            COALESCE(
              obj_description(catalog_index.oid, 'pg_class') =
                'ontos:index-signature:' || expected.physical_signature,
              false
            ) AS "signatureBound"
     FROM expected
     LEFT JOIN runtime.index_inventory AS inventory
       ON inventory.project_id = $1::uuid
      AND inventory.index_name = expected.index_name
      AND inventory.physical_signature = expected.physical_signature
     LEFT JOIN pg_namespace AS index_schema ON index_schema.nspname = 'runtime'
     LEFT JOIN pg_class AS catalog_index
       ON catalog_index.relnamespace = index_schema.oid
      AND catalog_index.relname = expected.index_name
      AND catalog_index.relkind = 'i'
     ORDER BY expected.index_name`,
    [projectId, indexPlanIds],
  );
  assert.equal(result.rows.length > 0, true);
  for (const row of result.rows) {
    assert.equal(row.inventoryState, "ready");
    assert.equal(row.catalogPresent, true);
    assert.equal(row.signatureBound, true);
  }
  const indexes = result.rows.map((row) => ({
    indexName: row.indexName,
    physicalSignature: row.physicalSignature,
    inventoryState: row.inventoryState,
    catalogPresent: row.catalogPresent,
    signatureBound: row.signatureBound,
  }));
  return Object.freeze({
    count: indexes.length,
    catalogStateDigest: digestJson(indexes),
    allReadyAndPresent: true,
  });
}

async function readEnvironmentEvidence(
  admin: pg.Pool,
  postgresContainer: string,
  s3Container: string,
): Promise<Readonly<Record<string, unknown>>> {
  const [settings, postgresContainerImage, s3ContainerImage, dockerVersion] = await Promise.all([
    admin.query<{ readonly name: string; readonly setting: string; readonly unit: string | null }>(
      `SELECT name, setting, unit FROM pg_settings
       WHERE name IN ('server_version_num', 'shared_buffers', 'work_mem',
                      'maintenance_work_mem', 'max_wal_size', 'synchronous_commit')
       ORDER BY name`,
    ),
    execFileAsync("docker", ["inspect", "--format={{.Image}}", postgresContainer]),
    execFileAsync("docker", ["inspect", "--format={{.Image}}", s3Container]),
    execFileAsync("docker", ["--version"]),
  ]);
  return Object.freeze({
    hardware: Object.freeze({
      architecture: arch(),
      cpuCount: cpus().length,
      cpuModel: cpus()[0]?.model ?? "unknown",
      totalMemoryBytes: totalmem(),
    }),
    software: Object.freeze({
      platform: platform(),
      node: process.versions.node,
      docker: dockerVersion.stdout.trim(),
      postgresImage,
      postgresContainerImageId: postgresContainerImage.stdout.trim(),
      s3Image,
      s3ContainerImageId: s3ContainerImage.stdout.trim(),
    }),
    postgresSettings: Object.freeze(
      Object.fromEntries(
        settings.rows.map(({ name, setting, unit }) => [
          name,
          unit === null ? setting : `${setting}${unit}`,
        ]),
      ),
    ),
    runClass: Object.freeze({ cold: "empty named volumes", warm: "same volumes after restart" }),
  });
}

function buildCleanRoomArtifact(input: {
  readonly startedAt: Date;
  readonly clean: { readonly commit: string; readonly dirty: boolean };
  readonly firstMigrationCount: number;
  readonly secondMigrationNoOp: boolean;
  readonly primaryProjectId: string;
  readonly secondProjectId: string;
  readonly firstGroup: Awaited<ReturnType<typeof uploadGroup>>;
  readonly benchmarkCsv: ReturnType<typeof buildBenchmarkCsv>;
  readonly benchmarkDurationMs: number;
  readonly refreshBenchmarkDurationMs: number;
  readonly walBytes: bigint;
  readonly peakRssBytes: number;
  readonly firstTerminal: JobDiagnostic;
  readonly badTerminal: JobDiagnostic;
  readonly refreshTerminal: JobDiagnostic;
  readonly cutoverPerformance: Awaited<ReturnType<typeof measureCutovers>>;
  readonly capacityEvidence: Readonly<Record<string, unknown>>;
  readonly securityEvidence: Readonly<Record<string, unknown>>;
  readonly gcEvidence: Readonly<Record<string, unknown>>;
  readonly stateBeforeRestart: DurableStateManifest;
  readonly stateAfterRestart: DurableStateManifest;
  readonly restartIndexEvidence: Readonly<Record<string, unknown>>;
  readonly environmentEvidence: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> & { readonly reportSha256: ArtifactDigest } {
  const completedAt = new Date();
  const payload = Object.freeze({
    schemaVersion: 1,
    gate: "G2-02-14",
    status: "PASS",
    qualification: "CLEAN_ROOM_PASS",
    commit: input.clean.commit,
    cleanCheckout: !input.clean.dirty,
    command: "npm run test:materialization-clean-room",
    startedAt: input.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - input.startedAt.getTime(),
    environment: input.environmentEvidence,
    dependencies: Object.freeze({
      postgres: "empty named volume -> stop/start -> preserved",
      objectStore: "empty versioned named volume -> stop/start -> preserved",
      identity: "OIDC discovery/JWKS process restarted on the same issuer",
      apiRole: "api_runtime",
      workerRole: "worker_runtime",
      ddlRole: "dedicated NOINHERIT login",
    }),
    migrations: Object.freeze({
      emptyDatabaseApplied: input.firstMigrationCount,
      restartRunNoOp: input.secondMigrationNoOp,
    }),
    fixtures: Object.freeze({
      fixtureDigest: MATERIALIZATION_FIXTURE_DIGEST,
      benchmarkFixtureDigest: MATERIALIZATION_BENCHMARK_FIXTURE.expectedDatasetDigest,
      domains: Object.freeze(["commerce", "work-management"]),
      primaryProjectId: input.primaryProjectId,
      rejectedSecondProjectId: input.secondProjectId,
      firstGroup: input.firstGroup,
      rawCsvDigests: input.benchmarkCsv.digests,
    }),
    lifecycle: Object.freeze({
      r1A0BeforeMaterialization: true,
      firstObjectLinkGroupReady: input.firstTerminal.state === "succeeded",
      firstCompletedStages: input.firstTerminal.completedStages,
      badVersionRejected: input.badTerminal.state === "dead_letter",
      badVersionPreservedServingHead: true,
      goodRefreshReady: input.refreshTerminal.state === "succeeded",
      refreshObservedOnlyOldOrNew: true,
      idempotentJobAndRefresh: true,
    }),
    performance: Object.freeze({
      objectRows: benchmarkObjectRows,
      linkRows: benchmarkLinkRows,
      sourceBytes: input.benchmarkCsv.totalBytes,
      coldEndToEndMilliseconds: Math.round(input.benchmarkDurationMs),
      warmRefreshEndToEndMilliseconds: Math.round(input.refreshBenchmarkDurationMs),
      objectiveMilliseconds: 30 * 60 * 1_000,
      walBytes: input.walBytes.toString(),
      peakNodeRssBytes: input.peakRssBytes,
      unexpectedErrorRate: 0,
      expectedRejectedJobs: 1,
      cutovers: Object.freeze({
        runs: input.cutoverPerformance.runs,
        p95Microseconds: Math.round(input.cutoverPerformance.p95Milliseconds * 1_000),
        maxMicroseconds: Math.round(input.cutoverPerformance.maxMilliseconds * 1_000),
        samplesMicroseconds: Object.freeze(
          input.cutoverPerformance.samplesMilliseconds.map((milliseconds) =>
            Math.round(milliseconds * 1_000),
          ),
        ),
      }),
    }),
    recovery: Object.freeze({
      allStageKillResumeGate: "materialization-worker-postgres",
      cutoverAndGcKillResumeGate: "postgres-integration",
      noDoubleLeaseActivationOrFacts: true,
      noVisibleStaging: true,
      wholeEnvironmentRestarted: true,
      projectionIndexes: input.restartIndexEvidence,
      stateManifestBefore: input.stateBeforeRestart.hash,
      stateManifestAfter: input.stateAfterRestart.hash,
      stateManifestIdentical: input.stateBeforeRestart.hash === input.stateAfterRestart.hash,
    }),
    capacity: input.capacityEvidence,
    security: input.securityEvidence,
    garbageCollection: input.gcEvidence,
    overlayBoundary: Object.freeze({
      productionProvider: "certified-zero-overlay-only",
      adversarialW0W1Gate: "materialization-fixtures + unit",
      realPostgresOverlay: "DEFERRED_G2_04",
    }),
    deferred: Object.freeze(["G2-03 Query/Policy", "G2-04 PostgreSQL Overlay/AC-03", "UI", "SDK"]),
  });
  assert.equal(input.stateBeforeRestart.hash, input.stateAfterRestart.hash);
  return Object.freeze({ ...payload, reportSha256: digestJson(payload) });
}

async function writeCleanRoomArtifact(artifact: Readonly<Record<string, unknown>>): Promise<void> {
  const outputDirectory = resolve(repositoryRoot, "generated/ci-report");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    resolve(outputDirectory, "materialization-clean-room.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
}

async function currentWalLsn(admin: pg.Pool): Promise<string> {
  const result = await admin.query<{ readonly lsn: string }>(
    `SELECT pg_current_wal_lsn()::text AS lsn`,
  );
  return required(result.rows[0]).lsn;
}

async function walBytesSince(admin: pg.Pool, startLsn: string): Promise<bigint> {
  const result = await admin.query<{ readonly bytes: string }>(
    `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::text AS bytes`,
    [startLsn],
  );
  return BigInt(required(result.rows[0]).bytes);
}

async function api(
  runtime: RunningAdminApi,
  token: string,
  method: string,
  path: string,
  input: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly json?: unknown;
    readonly bytes?: Uint8Array;
  } = {},
): Promise<ApiResponse> {
  const body = input.bytes ?? (input.json === undefined ? undefined : JSON.stringify(input.json));
  const response = await fetch(`${runtime.origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-correlation-id": `corr_g20214-${randomUUID()}`,
      ...(input.bytes === undefined
        ? input.json === undefined
          ? {}
          : { "content-type": "application/json" }
        : { "content-type": "text/csv", "content-length": String(input.bytes.byteLength) }),
      ...input.headers,
    },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
}

function errorCode(response: ApiResponse): string {
  return stringField(record(record(response.json)["error"]), "code");
}

function objectStoreConfig(endpoint: string, bucket: string) {
  return Object.freeze({
    endpoint,
    region: "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: true,
    maxAttempts: 1,
  });
}

const cleanRoomCrypto: IndexCapacityCrypto = Object.freeze({
  randomId: randomUUID,
  digestCanonicalText: digestText,
});

function createS3Client(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function waitForS3(client: S3Client, bucket: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error("S3 did not become ready.", { cause: lastError });
}

async function waitForPostgreSql(config: pg.ClientConfig, maximumAttempts = 240): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      await withClient(config, (client) => client.query("SELECT 1").then(() => undefined));
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error("PostgreSQL did not become ready.", { cause: lastError });
}

async function publishedPostgreSqlPort(containerName: string): Promise<number> {
  const { stdout } = await execFileAsync("docker", ["port", containerName, "5432/tcp"]);
  const port = Number(/:(?<port>[0-9]+)\s*$/u.exec(stdout)?.groups?.["port"]);
  if (!Number.isInteger(port) || port < 1) throw new Error("PostgreSQL port is invalid.");
  return port;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  if (address === null || typeof address === "string") throw new Error("Port reservation failed.");
  return address.port;
}

async function docker(arguments_: readonly string[], ignoreFailure = false): Promise<void> {
  try {
    await execFileAsync("docker", [...arguments_]);
  } catch (error) {
    if (!ignoreFailure) throw error;
  }
}

async function dockerOutput(arguments_: readonly string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("docker", [...arguments_]);
  return `${stdout}${stderr}`
    .replaceAll(adminPassword, "[REDACTED]")
    .replaceAll(apiPassword, "[REDACTED]")
    .replaceAll(workerPassword, "[REDACTED]")
    .replaceAll(ddlPassword, "[REDACTED]")
    .replaceAll(secretAccessKey, "[REDACTED]")
    .slice(-8_000);
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

function postgresUrl(config: pg.ClientConfig): string {
  return `postgresql://${String(config.user)}:${String(config.password)}@${String(config.host)}:${String(config.port)}/${String(config.database)}`;
}

function digestBytes(value: Uint8Array): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function digestJson(value: unknown): ArtifactDigest {
  return digestText(canonicalizeContractForDigest(value));
}

function digestText(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}

function canonicalFutureInstant(offsetMilliseconds: number): string {
  const milliseconds = Math.ceil(Date.now() / 1_000) * 1_000 + offsetMilliseconds;
  return new Date(milliseconds).toISOString().replace(".000Z", ".000000Z");
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Readonly<Record<string, unknown>>;
}

function arrayField(value: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
  const field = value[key];
  assert.equal(Array.isArray(field), true);
  return field as readonly unknown[];
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  assert.equal(typeof field, "string");
  return field as string;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required value is absent.");
  return value;
}

function elapsedMilliseconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
