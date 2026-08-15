import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { MATERIALIZATION_WORKER_STAGES } from "@ontos/materialization-application";
import pg from "pg";

import { runDatabaseMigrations } from "../../database/migrator.ts";
import { resolvePostgresTestImage } from "../../database/postgres-test-image.ts";

const execFileAsync = promisify(execFile);
const postgresImage = resolvePostgresTestImage();
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const fixtureEntry = resolve(import.meta.dirname, "../fixture-process.ts");
const database = "ontos_g20208";
const adminPassword = "local-only-g20208-admin-secret";
const runtimePassword = "local-only-g20208-worker-secret";
const projectId = id(1);
const principalId = id(2);
const snapshotGroupId = id(3);
const targetResourceId = id(4);
const targetRevisionId = id(5);
const schemaResourceId = id(6);
const schemaRevisionId = id(7);
const mappingResourceId = id(8);
const mappingRevisionId = id(9);
const matrixJobId = id(10);
const cleanJobId = id(11);
const gracefulJobId = id(12);
const cancelJobId = id(13);
const retryJobId = id(14);
const permanentJobId = id(15);
const sampleBoundaryJobId = id(16);
const databaseOutageJobId = id(17);
const fairnessLowJobId = id(18);
const fairnessHighJobId = id(19);
const snapshotId = id(20);
const snapshotFileId = id(21);
const managedArtifactId = id(22);
const inputDigest = digest("1");

void test(
  "G2-02-08 real Worker PIDs fence, kill and resume every stage",
  { timeout: 180_000 },
  async () => {
    const containerName = `ontos-g20208-${process.pid}-${randomUUID().slice(0, 8)}`;
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

    const workers = new Set<FixtureWorker>();
    let admin: pg.Pool | null = null;
    try {
      const port = await publishedPostgreSqlPort(containerName);
      const adminConfig: pg.ClientConfig = {
        host: "127.0.0.1",
        port,
        database,
        user: "postgres",
        password: adminPassword,
        application_name: "ontos-g20208-admin",
      };
      await waitForPostgreSql(adminConfig);
      admin = new pg.Pool(adminConfig);
      admin.on("error", () => undefined);
      await withClient(adminConfig, async (client) => {
        await runDatabaseMigrations(client);
        await seedWorkerFixture(client);
      });

      const databaseUrls = [
        workerDatabaseUrl("g20208_worker_a_login", port),
        workerDatabaseUrl("g20208_worker_b_login", port),
      ] as const;
      await enqueueJob(admin, matrixJobId, "g20208-kill-resume-0001");
      const duplicate = await enqueueJob(admin, matrixJobId, "g20208-kill-resume-0001");
      assert.equal(duplicate.reused, true);
      assert.equal(await jobCount(admin, "g20208-kill-resume-0001"), 1);

      let processSequence = 0;
      const launch = (options: FixtureWorkerOptions): FixtureWorker => {
        const worker = spawnFixtureWorker({
          databaseUrl: databaseUrls[processSequence % databaseUrls.length] ?? databaseUrls[0],
          workerInstanceId: id(1_000 + processSequence),
          ...options,
        });
        processSequence += 1;
        workers.add(worker);
        return worker;
      };

      const first = launch({ pauseStage: "scan", pausePosition: "before" });
      const second = launch({ pauseStage: "scan", pausePosition: "before" });
      const firstEvent = await Promise.race([
        waitForEvent(first, "stage_before", "scan").then(() => first),
        waitForEvent(second, "stage_before", "scan").then(() => second),
      ]);
      const lease = await currentLease(admin, matrixJobId);
      assert.equal(lease.state, "running");
      assert.equal(lease.attemptCount, 1);
      assert.equal(lease.leasedAttempts, 1);
      assert.equal(lease.workerInstanceId, firstEvent.workerInstanceId);
      await Promise.all([stopWorker(first, "SIGKILL"), stopWorker(second, "SIGKILL")]);
      workers.delete(first);
      workers.delete(second);
      await reapAndRelease(admin, matrixJobId);
      assert.equal(await latestCheckpointSequence(admin, matrixJobId), 0);
      await assertStaleHeartbeatRejected(adminConfig, lease);

      for (const [index, stage] of MATERIALIZATION_WORKER_STAGES.entries()) {
        const sequence = index + 1;
        if (sequence > 1) {
          const before = launch({ pauseStage: stage, pausePosition: "before" });
          await waitForEvent(before, "stage_before", stage);
          assert.equal(await latestCheckpointSequence(admin, matrixJobId), sequence - 1);
          await stopWorker(before, "SIGKILL");
          workers.delete(before);
          await reapAndRelease(admin, matrixJobId);
          assert.equal(await latestCheckpointSequence(admin, matrixJobId), sequence - 1);
        }

        const after = launch({ pauseStage: stage, pausePosition: "after" });
        await waitForEvent(after, "checkpoint_committed", stage);
        assert.equal(await latestCheckpointSequence(admin, matrixJobId), sequence);
        if (stage === "activate") {
          await assertCutoverCannotBeCancelled(admin, matrixJobId);
        }
        await stopWorker(after, "SIGKILL");
        workers.delete(after);
        const state = await reapAndRelease(admin, matrixJobId);
        assert.equal(state, stage === "activate" ? "succeeded" : "ready");
      }

      const matrix = await completedJob(admin, matrixJobId);
      assert.equal(matrix.state, "succeeded");
      assert.equal(matrix.checkpointCount, 8);
      assert.equal(matrix.attemptCount, 16);
      assert.equal(matrix.replayCount, 3);
      assert.equal(matrix.completedAttempts, 1);
      assert.equal(matrix.abandonedAttempts, 15);

      await enqueueJob(admin, cleanJobId, "g20208-clean-control-0001");
      const cleanWorker = launch({});
      await waitForJobState(admin, cleanJobId, "succeeded");
      await stopWorker(cleanWorker, "SIGTERM");
      workers.delete(cleanWorker);
      const clean = await completedJob(admin, cleanJobId);
      assert.equal(clean.checkpointCount, 8);
      assert.equal(clean.attemptCount, 1);
      assert.equal(clean.resultDigest, matrix.resultDigest);

      await enqueueJob(admin, gracefulJobId, "g20208-graceful-stop-0001");
      const gracefulWorker = launch({ pauseStage: "map", pausePosition: "before" });
      await waitForEvent(gracefulWorker, "stage_before", "map");
      await stopWorker(gracefulWorker, "SIGTERM");
      workers.delete(gracefulWorker);
      const graceful = await jobRuntimeSnapshot(admin, gracefulJobId);
      assert.equal(graceful.state, "retry_wait");
      assert.equal(graceful.currentStage, "scan");
      assert.equal(graceful.checkpointCount, 1);
      assert.equal(graceful.lastFailureCode, "WORKER_SHUTDOWN");
      await requestCancel(admin, gracefulJobId, "STOPPED_BY_OPERATOR");
      assert.equal((await jobRuntimeSnapshot(admin, gracefulJobId)).state, "cancelled");

      await enqueueJob(admin, cancelJobId, "g20208-safe-cancel-0001");
      const cancelWorker = launch({
        pauseStage: "map",
        pausePosition: "before",
        pauseMilliseconds: 500,
      });
      await waitForEvent(cancelWorker, "stage_before", "map");
      await requestCancel(admin, cancelJobId, "USER_REQUESTED");
      await waitForJobState(admin, cancelJobId, "cancelled");
      await stopWorker(cancelWorker, "SIGTERM");
      workers.delete(cancelWorker);
      const cancelled = await jobRuntimeSnapshot(admin, cancelJobId);
      assert.equal(cancelled.checkpointCount, 2);
      assert.equal(cancelled.cancelledAttempts, 1);

      await enqueueJob(admin, retryJobId, "g20208-dependency-retry-0001");
      const dependencyWorker = launch({ failStage: "scan", failCategory: "dependency" });
      await waitForOutcome(dependencyWorker, "retry_wait");
      await stopWorker(dependencyWorker, "SIGTERM");
      workers.delete(dependencyWorker);
      const retrying = await jobRuntimeSnapshot(admin, retryJobId);
      assert.equal(retrying.state, "retry_wait");
      assert.equal(retrying.lastFailureCode, "S3_TEMPORARILY_UNAVAILABLE");
      assert.equal(retrying.errorSampleCount, 1);
      assert.equal(retrying.availableInFuture, true);
      await makeJobAvailable(admin, retryJobId);
      const retryRecovery = launch({});
      await waitForJobState(admin, retryJobId, "succeeded");
      await stopWorker(retryRecovery, "SIGTERM");
      workers.delete(retryRecovery);
      assert.equal((await completedJob(admin, retryJobId)).resultDigest, matrix.resultDigest);

      await enqueueJob(admin, permanentJobId, "g20208-permanent-stop-0001");
      const permanentWorker = launch({ failStage: "scan", failCategory: "permanent" });
      await waitForOutcome(permanentWorker, "dead_letter");
      await stopWorker(permanentWorker, "SIGTERM");
      workers.delete(permanentWorker);
      const permanent = await jobRuntimeSnapshot(admin, permanentJobId);
      assert.equal(permanent.state, "dead_letter");
      assert.equal(permanent.attemptCount, 1);
      assert.equal(permanent.lastFailureCode, "SNAPSHOT_CONTRACT_INVALID");
      assert.equal(permanent.errorSampleCount, 1);

      await enqueueJob(admin, sampleBoundaryJobId, "g20208-sample-boundary-0001");
      const sampleWorker = launch({
        pauseStage: "scan",
        pausePosition: "before",
        pauseMilliseconds: 500,
      });
      await waitForEvent(sampleWorker, "stage_before", "scan");
      const sampleLease = await currentLease(admin, sampleBoundaryJobId);
      await assertOversizedSamplesRejected(admin, sampleBoundaryJobId, sampleLease);
      await requestCancel(admin, sampleBoundaryJobId, "BOUNDARY_PROBE_COMPLETE");
      await waitForJobState(admin, sampleBoundaryJobId, "cancelled");
      await stopWorker(sampleWorker, "SIGTERM");
      workers.delete(sampleWorker);
      assert.equal((await jobRuntimeSnapshot(admin, sampleBoundaryJobId)).errorSampleCount, 0);

      await enqueueJob(admin, databaseOutageJobId, "g20208-database-outage-0001");
      const outageWorker = launch({ pauseStage: "map", pausePosition: "before" });
      await waitForEvent(outageWorker, "stage_before", "map");
      assert.equal(await latestCheckpointSequence(admin, databaseOutageJobId), 1);
      assert.ok((await terminateWorkerDatabaseConnections(admin)) >= 1);
      await waitForKind(outageWorker, "dependency_retry");
      await stopWorker(outageWorker, "SIGKILL");
      workers.delete(outageWorker);
      await reapAndRelease(admin, databaseOutageJobId);
      assert.equal(await latestCheckpointSequence(admin, databaseOutageJobId), 1);
      const outageRecovery = launch({});
      await waitForJobState(admin, databaseOutageJobId, "succeeded");
      await stopWorker(outageRecovery, "SIGTERM");
      workers.delete(outageRecovery);
      assert.equal(
        (await completedJob(admin, databaseOutageJobId)).resultDigest,
        matrix.resultDigest,
      );
      await assertFairClaimOrder(admin, adminConfig);
      process.stdout.write(
        `CI_METADATA g2_02_08.kill_points=16 attempts=${String(matrix.attemptCount)} replays=${String(matrix.replayCount)} graceful=PASS cancel=PASS retry=PASS permanent=PASS db_connection_outage=PASS\n`,
      );
    } finally {
      await Promise.all(
        [...workers].map(async (worker) => {
          await stopWorker(worker, "SIGKILL").catch(() => undefined);
        }),
      );
      if (admin !== null) await admin.end();
      await docker(["rm", "--force", "--volumes", containerName], true);
    }
  },
);

interface FixtureWorkerEvent {
  readonly kind: string;
  readonly stage?: string;
  readonly sequence?: number;
  readonly outcome?: string;
}

interface FixtureWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly workerInstanceId: string;
  readonly events: FixtureWorkerEvent[];
  readonly completion: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  readonly diagnostic: () => string;
}

interface FixtureWorkerOptions {
  readonly pauseStage?: string;
  readonly pausePosition?: "before" | "after";
  readonly pauseMilliseconds?: number;
  readonly failStage?: string;
  readonly failCategory?: "dependency" | "permanent";
}

function spawnFixtureWorker(
  options: FixtureWorkerOptions & {
    readonly databaseUrl: string;
    readonly workerInstanceId: string;
  },
): FixtureWorker {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ONTOS_DATABASE_URL: options.databaseUrl,
    ONTOS_WORKER_INSTANCE_ID: options.workerInstanceId,
    ONTOS_WORKER_LEASE_SECONDS: "1",
    ONTOS_WORKER_HEARTBEAT_MILLISECONDS: "200",
    ONTOS_WORKER_IDLE_POLL_MILLISECONDS: "25",
    ONTOS_WORKER_DEPENDENCY_BACKOFF_MILLISECONDS: "100",
    ONTOS_WORKER_SHUTDOWN_GRACE_MILLISECONDS: "5000",
    ONTOS_WORKER_DATABASE_POOL_MAXIMUM: "2",
    ...(options.pauseStage === undefined
      ? {}
      : { ONTOS_WORKER_FIXTURE_PAUSE_STAGE: options.pauseStage }),
    ...(options.pausePosition === undefined
      ? {}
      : { ONTOS_WORKER_FIXTURE_PAUSE_POSITION: options.pausePosition }),
    ...(options.pauseMilliseconds === undefined
      ? {}
      : { ONTOS_WORKER_FIXTURE_PAUSE_MILLISECONDS: String(options.pauseMilliseconds) }),
    ...(options.failStage === undefined
      ? {}
      : { ONTOS_WORKER_FIXTURE_FAIL_STAGE: options.failStage }),
    ...(options.failCategory === undefined
      ? {}
      : { ONTOS_WORKER_FIXTURE_FAIL_CATEGORY: options.failCategory }),
  };
  for (const key of [
    "ONTOS_ADMIN_BEARER_TOKEN",
    "ONTOS_WORKER_BEARER_TOKEN",
    "ONTOS_OIDC_CLIENT_SECRET",
    "ONTOS_MIGRATION_DATABASE_URL",
    "ONTOS_DDL_EXECUTOR_DATABASE_URL",
  ]) {
    delete environment[key];
  }
  const child = spawn(process.execPath, [fixtureEntry], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: FixtureWorkerEvent[] = [];
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`;
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const candidate: unknown = JSON.parse(line);
        if (isWorkerEvent(candidate)) events.push(candidate);
      } catch {
        // The process protocol ignores non-JSON diagnostics.
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });
  const completion = new Promise<{ readonly code: number | null; readonly signal: string | null }>(
    (resolveCompletion, rejectCompletion) => {
      child.once("error", rejectCompletion);
      child.once("close", (code, signal) => resolveCompletion({ code, signal }));
    },
  );
  return Object.freeze({
    child,
    workerInstanceId: options.workerInstanceId,
    events,
    completion,
    diagnostic: () => stderr,
  });
}

async function waitForEvent(
  worker: FixtureWorker,
  kind: string,
  stage: string,
): Promise<FixtureWorkerEvent> {
  return await waitUntil(
    () => {
      const event = worker.events.find(
        (candidate) => candidate.kind === kind && candidate.stage === stage,
      );
      if (event !== undefined) return event;
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
        throw new Error(`Worker exited before ${kind}/${stage}: ${worker.diagnostic()}`);
      }
      return null;
    },
    10_000,
    `Worker did not emit ${kind}/${stage}.`,
  );
}

async function waitForOutcome(worker: FixtureWorker, outcome: string): Promise<void> {
  await waitUntil(
    () => {
      if (
        worker.events.some(
          (candidate) => candidate.kind === "job_result" && candidate.outcome === outcome,
        )
      ) {
        return true;
      }
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
        throw new Error(`Worker exited before ${outcome}: ${worker.diagnostic()}`);
      }
      return null;
    },
    10_000,
    `Worker did not report ${outcome}.`,
  );
}

async function waitForKind(worker: FixtureWorker, kind: string): Promise<void> {
  await waitUntil(
    () => {
      if (worker.events.some((candidate) => candidate.kind === kind)) return true;
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
        throw new Error(`Worker exited before ${kind}: ${worker.diagnostic()}`);
      }
      return null;
    },
    10_000,
    `Worker did not report ${kind}.`,
  );
}

async function stopWorker(worker: FixtureWorker, signal: "SIGKILL" | "SIGTERM"): Promise<void> {
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.kill(signal);
  }
  const outcome = await worker.completion;
  if (signal === "SIGTERM") {
    assert.equal(outcome.code, 0, worker.diagnostic());
  } else {
    assert.equal(outcome.signal, "SIGKILL", worker.diagnostic());
  }
}

async function seedWorkerFixture(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE ROLE g20208_worker_a_login LOGIN PASSWORD '${runtimePassword}';
    CREATE ROLE g20208_worker_b_login LOGIN PASSWORD '${runtimePassword}';
    GRANT worker_runtime TO g20208_worker_a_login, g20208_worker_b_login;
  `);
  await client.query(
    `INSERT INTO authz.principals
       (principal_id, oidc_issuer, oidc_subject, display_name)
     VALUES ($1, 'https://issuer.g20208.test', 'operator', 'G2-02-08 Operator')`,
    [principalId],
  );
  await client.query(
    `INSERT INTO meta.projects (project_id, api_name, display_name)
     VALUES ($1, 'G20208Project', 'G2-02-08 Project')`,
    [projectId],
  );
  await client.query(
    `INSERT INTO meta.resources (resource_id, project_id, namespace, api_name, family)
     VALUES
       ($1, $4, 'g20208.fixture', 'ObjectType', 'object_type'),
       ($2, $4, 'g20208.fixture', 'SnapshotSchema', 'snapshot_schema'),
       ($3, $4, 'g20208.fixture', 'Mapping', 'mapping')`,
    [targetResourceId, schemaResourceId, mappingResourceId, projectId],
  );
  await client.query(
    `INSERT INTO meta.resource_revisions
       (revision_id, resource_id, revision_number, family, content_digest, content,
        created_by_principal_id)
     VALUES
       ($1, $2, 1, 'object_type', $7, '{}'::jsonb, $8),
       ($3, $4, 1, 'snapshot_schema', $7, '{}'::jsonb, $8),
       ($5, $6, 1, 'mapping', $7, '{}'::jsonb, $8)`,
    [
      targetRevisionId,
      targetResourceId,
      schemaRevisionId,
      schemaResourceId,
      mappingRevisionId,
      mappingResourceId,
      digest("3"),
      principalId,
    ],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_groups (project_id, snapshot_group_id, group_key)
     VALUES ($1, $2, 'g20208.group')`,
    [projectId, snapshotGroupId],
  );
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO runtime.snapshot_group_versions
       (project_id, snapshot_group_id, group_version, member_count, group_digest)
     VALUES ($1, $2, 1, 1, $3)`,
    [projectId, snapshotGroupId, digest("2")],
  );
  await client.query(
    `INSERT INTO runtime.dataset_snapshots (
       project_id, snapshot_id, snapshot_group_id, group_version,
       member_key, member_kind, target_resource_id, target_revision_id,
       snapshot_schema_resource_id, snapshot_schema_revision_id,
       mapping_resource_id, mapping_revision_id, runtime_plan_digest,
       content_digest, byte_count, row_count, file_count, snapshot_digest
     ) VALUES (
       $1, $2, $3, 1, 'object:Fixture', 'object', $4, $5, $6, $7, $8, $9,
       $10, $11, 0, 0, 1, $12
     )`,
    [
      projectId,
      snapshotId,
      snapshotGroupId,
      targetResourceId,
      targetRevisionId,
      schemaResourceId,
      schemaRevisionId,
      mappingResourceId,
      mappingRevisionId,
      digest("4"),
      digest("5"),
      digest("6"),
    ],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_files (
       project_id, snapshot_id, file_id, managed_artifact_id, object_version,
       ordinal, content_digest, byte_count, row_count, source_label, scan_status
     ) VALUES ($1, $2, $3, $4, 'fixture-version-1', 0, $5, 0, 0,
               'G2-02-08 fixture', 'complete')`,
    [projectId, snapshotId, snapshotFileId, managedArtifactId, digest("5")],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_group_members (
       project_id, snapshot_group_id, group_version, member_key, member_kind,
       snapshot_id, target_resource_id, target_revision_id
     ) VALUES ($1, $2, 1, 'object:Fixture', 'object', $3, $4, $5)`,
    [projectId, snapshotGroupId, snapshotId, targetResourceId, targetRevisionId],
  );
  await client.query("COMMIT");
}

async function enqueueJob(
  pool: pg.Pool,
  jobId: string,
  idempotencyKey: string,
  priority = 0,
): Promise<{ readonly reused: boolean }> {
  const result = await pool.query<{ readonly reused: boolean }>(
    `SELECT reused FROM ops.enqueue_materialization_job($1, $2, $3, 1, $4, $5, $6, $7)`,
    [projectId, jobId, snapshotGroupId, idempotencyKey, inputDigest, randomUUID(), priority],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Job enqueue returned no row.");
  return row;
}

async function assertFairClaimOrder(pool: pg.Pool, adminConfig: pg.ClientConfig): Promise<void> {
  await enqueueJob(pool, fairnessLowJobId, "g20208-fairness-low-0001", -100);
  await enqueueJob(pool, fairnessHighJobId, "g20208-fairness-high-0001", 100);
  const workerInstanceId = id(9_001);
  const attemptId = id(9_002);
  await withClient(
    { ...adminConfig, user: "g20208_worker_a_login", password: runtimePassword },
    async (worker) => {
      const claim = await worker.query<{ readonly jobId: string; readonly fencingToken: string }>(
        `SELECT job_id AS "jobId", fencing_token::text AS "fencingToken"
           FROM ops.claim_materialization_job_v2($1, $2, 30)`,
        [workerInstanceId, attemptId],
      );
      assert.equal(claim.rows[0]?.jobId, fairnessLowJobId);
      await requestCancel(pool, fairnessLowJobId, "FAIRNESS_PROBE_COMPLETE");
      await worker.query(
        `SELECT ops.cancel_materialization_job_at_safe_point($1, $2, $3, $4, $5)`,
        [projectId, fairnessLowJobId, attemptId, workerInstanceId, claim.rows[0]?.fencingToken],
      );
    },
  );
  await requestCancel(pool, fairnessHighJobId, "FAIRNESS_PROBE_COMPLETE");
  assert.equal((await jobRuntimeSnapshot(pool, fairnessHighJobId)).state, "cancelled");
}

async function jobCount(pool: pg.Pool, idempotencyKey: string): Promise<number> {
  const result = await pool.query<{ readonly count: number }>(
    `SELECT count(*)::integer AS count FROM ops.materialization_jobs
     WHERE project_id = $1 AND idempotency_key = $2`,
    [projectId, idempotencyKey],
  );
  return result.rows[0]?.count ?? -1;
}

interface LeaseSnapshot {
  readonly state: string;
  readonly attemptId: string;
  readonly workerInstanceId: string;
  readonly fencingToken: string;
  readonly attemptCount: number;
  readonly leasedAttempts: number;
}

async function currentLease(pool: pg.Pool, jobId: string): Promise<LeaseSnapshot> {
  return await waitUntil(
    async () => {
      const result = await pool.query<LeaseSnapshot>(
        `SELECT job.state, job.current_attempt_id AS "attemptId",
                job.lease_owner_id AS "workerInstanceId",
                job.fencing_token::text AS "fencingToken",
                job.attempt_count AS "attemptCount",
                (SELECT count(*)::integer FROM ops.materialization_attempts AS attempt
                  WHERE attempt.project_id = job.project_id AND attempt.job_id = job.job_id
                    AND attempt.state = 'leased') AS "leasedAttempts"
           FROM ops.materialization_jobs AS job
          WHERE job.project_id = $1 AND job.job_id = $2 AND job.state = 'running'`,
        [projectId, jobId],
      );
      return result.rows[0] ?? null;
    },
    5_000,
    "Job did not acquire a lease.",
  );
}

async function assertStaleHeartbeatRejected(
  adminConfig: pg.ClientConfig,
  lease: LeaseSnapshot,
): Promise<void> {
  const workerConfig = {
    ...adminConfig,
    user: "g20208_worker_a_login",
    password: runtimePassword,
  };
  await withClient(workerConfig, async (worker) => {
    await assert.rejects(
      worker.query(`SELECT ops.heartbeat_materialization_job($1, $2, $3, $4, $5, 1)`, [
        projectId,
        matrixJobId,
        lease.attemptId,
        lease.workerInstanceId,
        lease.fencingToken,
      ]),
      (error: unknown) => postgresCode(error) === "55000",
    );
  });
}

async function reapAndRelease(pool: pg.Pool, jobId: string): Promise<"ready" | "succeeded"> {
  return await waitUntil(
    async () => {
      await pool.query(`SELECT ops.reap_expired_materialization_jobs(32)`);
      const result = await pool.query<{
        readonly state: string;
        readonly replayCycle: number;
      }>(
        `SELECT state, replay_cycle AS "replayCycle"
           FROM ops.materialization_jobs WHERE project_id = $1 AND job_id = $2`,
        [projectId, jobId],
      );
      const row = result.rows[0];
      if (row === undefined || row.state === "running") return null;
      if (row.state === "succeeded") return "succeeded" as const;
      if (row.state === "dead_letter") {
        await pool.query(`SELECT * FROM ops.replay_materialization_job($1, $2, $3, $4)`, [
          projectId,
          jobId,
          principalId,
          "KILL_MATRIX_REPLAY",
        ]);
        return "ready" as const;
      }
      if (row.state === "retry_wait") {
        await pool.query(
          `UPDATE ops.materialization_jobs
              SET available_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE project_id = $1 AND job_id = $2`,
          [projectId, jobId],
        );
        return "ready" as const;
      }
      throw new Error(`Unexpected job state after reaper: ${row.state}`);
    },
    5_000,
    "Expired Worker lease was not reaped.",
  );
}

async function latestCheckpointSequence(pool: pg.Pool, jobId: string): Promise<number> {
  const result = await pool.query<{ readonly sequence: number }>(
    `SELECT COALESCE(max(sequence), 0)::integer AS sequence
       FROM ops.materialization_checkpoints WHERE project_id = $1 AND job_id = $2`,
    [projectId, jobId],
  );
  return result.rows[0]?.sequence ?? -1;
}

async function assertCutoverCannotBeCancelled(pool: pg.Pool, jobId: string): Promise<void> {
  await assert.rejects(
    pool.query(`SELECT * FROM ops.request_materialization_job_cancel($1, $2, $3, $4)`, [
      projectId,
      jobId,
      principalId,
      "TOO_LATE",
    ]),
    (error: unknown) =>
      postgresCode(error) === "55000" &&
      postgresMessage(error).includes("MATERIALIZATION_JOB_NOT_CANCELLABLE"),
  );
}

interface JobRuntimeSnapshot {
  readonly state: string;
  readonly currentStage: string | null;
  readonly attemptCount: number;
  readonly lastFailureCode: string | null;
  readonly availableInFuture: boolean;
  readonly checkpointCount: number;
  readonly cancelledAttempts: number;
  readonly errorSampleCount: number;
}

async function jobRuntimeSnapshot(pool: pg.Pool, jobId: string): Promise<JobRuntimeSnapshot> {
  const result = await pool.query<JobRuntimeSnapshot>(
    `SELECT job.state, job.current_stage AS "currentStage",
            job.attempt_count AS "attemptCount",
            job.last_failure_code AS "lastFailureCode",
            job.available_at > job.last_observed_database_at AS "availableInFuture",
            (SELECT count(*)::integer FROM ops.materialization_checkpoints AS checkpoint
              WHERE checkpoint.project_id = job.project_id AND checkpoint.job_id = job.job_id)
              AS "checkpointCount",
            (SELECT count(*)::integer FROM ops.materialization_attempts AS attempt
              WHERE attempt.project_id = job.project_id AND attempt.job_id = job.job_id
                AND attempt.state = 'cancelled') AS "cancelledAttempts",
            (SELECT count(*)::integer FROM ops.materialization_job_error_samples AS sample
              WHERE sample.project_id = job.project_id AND sample.job_id = job.job_id)
              AS "errorSampleCount"
       FROM ops.materialization_jobs AS job
      WHERE job.project_id = $1 AND job.job_id = $2`,
    [projectId, jobId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Job runtime snapshot was not found.");
  return row;
}

async function requestCancel(pool: pg.Pool, jobId: string, reason: string): Promise<void> {
  await pool.query(`SELECT * FROM ops.request_materialization_job_cancel($1, $2, $3, $4)`, [
    projectId,
    jobId,
    principalId,
    reason,
  ]);
}

async function makeJobAvailable(pool: pg.Pool, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE ops.materialization_jobs
        SET available_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE project_id = $1 AND job_id = $2 AND state = 'retry_wait'`,
    [projectId, jobId],
  );
}

async function assertOversizedSamplesRejected(
  pool: pg.Pool,
  jobId: string,
  lease: LeaseSnapshot,
): Promise<void> {
  const samples = Array.from({ length: 51 }, () => ({
    reasonCode: "VALUE_INVALID",
    classification: "validation",
    fingerprint: digest("9"),
  }));
  await assert.rejects(
    pool.query(
      `SELECT * FROM ops.fail_materialization_job(
         $1, $2, $3, $4, $5, $6, $7, false, $8, $9::jsonb
       )`,
      [
        projectId,
        jobId,
        lease.attemptId,
        lease.workerInstanceId,
        lease.fencingToken,
        "VALIDATION_FAILED",
        "permanent",
        digest("8"),
        JSON.stringify(samples),
      ],
    ),
    (error: unknown) => postgresCode(error) === "22023",
  );
}

async function terminateWorkerDatabaseConnections(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ readonly terminated: boolean }>(
    `SELECT pg_terminate_backend(pid) AS terminated
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = 'ontos-materialization-worker'
        AND pid <> pg_backend_pid()`,
  );
  return result.rows.filter(({ terminated }) => terminated).length;
}

interface CompletedJob {
  readonly state: string;
  readonly resultDigest: string;
  readonly attemptCount: number;
  readonly replayCount: number;
  readonly checkpointCount: number;
  readonly completedAttempts: number;
  readonly abandonedAttempts: number;
}

async function completedJob(pool: pg.Pool, jobId: string): Promise<CompletedJob> {
  const result = await pool.query<CompletedJob>(
    `SELECT job.state, job.result_digest AS "resultDigest",
            job.attempt_count AS "attemptCount", job.replay_count AS "replayCount",
            (SELECT count(*)::integer FROM ops.materialization_checkpoints AS checkpoint
              WHERE checkpoint.project_id = job.project_id AND checkpoint.job_id = job.job_id)
              AS "checkpointCount",
            (SELECT count(*)::integer FROM ops.materialization_attempts AS attempt
              WHERE attempt.project_id = job.project_id AND attempt.job_id = job.job_id
                AND attempt.state = 'completed') AS "completedAttempts",
            (SELECT count(*)::integer FROM ops.materialization_attempts AS attempt
              WHERE attempt.project_id = job.project_id AND attempt.job_id = job.job_id
                AND attempt.state = 'abandoned') AS "abandonedAttempts"
       FROM ops.materialization_jobs AS job
      WHERE job.project_id = $1 AND job.job_id = $2`,
    [projectId, jobId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Completed job was not found.");
  return row;
}

async function waitForJobState(pool: pg.Pool, jobId: string, state: string): Promise<void> {
  await waitUntil(
    async () => {
      const result = await pool.query<{ readonly state: string }>(
        `SELECT state FROM ops.materialization_jobs WHERE project_id = $1 AND job_id = $2`,
        [projectId, jobId],
      );
      return result.rows[0]?.state === state ? true : null;
    },
    10_000,
    `Job did not reach ${state}.`,
  );
}

async function waitUntil<T>(
  probe: () => T | null | Promise<T | null>,
  timeoutMilliseconds: number,
  message: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(message);
}

function workerDatabaseUrl(user: string, port: number): string {
  return `postgresql://${user}:${runtimePassword}@127.0.0.1:${String(port)}/${database}`;
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
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
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
    await execFileAsync("docker", [...arguments_]);
  } catch (error) {
    if (!ignoreFailure) throw error;
  }
}

function isWorkerEvent(value: unknown): value is FixtureWorkerEvent {
  return (
    typeof value === "object" && value !== null && "kind" in value && typeof value.kind === "string"
  );
}

function postgresCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  return typeof value.code === "string" ? value.code : undefined;
}

function postgresMessage(value: unknown): string {
  if (typeof value !== "object" || value === null || !("message" in value)) return "";
  return typeof value.message === "string" ? value.message : "";
}

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
