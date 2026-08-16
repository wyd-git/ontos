import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import { HeadBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { parseArtifactDigest, parseErrorEnvelope, type ArtifactDigest } from "@ontos/contracts";
import {
  IndexPlanAdmissionService,
  type IndexCapacityCrypto,
} from "@ontos/materialization-application";
import { PostgresIndexPlanAdmissionRepository } from "@ontos/materialization-postgres";
import type { ReleaseIndexPlanInput } from "@ontos/materialization-domain";
import pg from "pg";

import { startAdminApi, type RunningAdminApi } from "../../../apps/api/src/runtime.ts";
import { startProductionMaterializationWorker } from "../../../apps/worker/src/production.ts";
import { runDatabaseMigrations } from "../../database/migrator.ts";
import { resolvePostgresTestImage } from "../../database/postgres-test-image.ts";
import { startTestOidcProvider } from "../../admin-api/oidc-provider.ts";

const execFileAsync = promisify(execFile);
const postgresImage = resolvePostgresTestImage();
const s3Image =
  "chrislusf/seaweedfs:4.41@sha256:43b768cd62b00d132439cda881b93fd1adebf1b315e996e794087743821d771d";
const database = "ontos_g20213_production";
const adminPassword = "local-only-g20213-admin-secret";
const apiPassword = "local-only-g20213-api-secret";
const workerPassword = "local-only-g20213-worker-secret";
const ddlPassword = "local-only-g20213-ddl-secret";
const accessKeyId = "local-only-g20213-s3-access";
const secretAccessKey = "local-only-g20213-s3-secret";
const cursorSecret = "local-only-g20213-cursor-hmac-secret-value";
const ddlEntry = fileURLToPath(
  new URL("../../../apps/projection-ddl-executor/src/main.ts", import.meta.url),
);

void test(
  "G2-02-13 real Admin, OIDC, PostgreSQL, S3, DDL and production Worker close the loop",
  { timeout: 300_000 },
  async () => {
    const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
    const postgresContainer = `ontos-g20213-pg-${suffix}`;
    const s3Container = `ontos-g20213-s3-${suffix}`;
    const bucket = `ontos-g20213-${process.pid}`;
    const s3Port = await reserveLoopbackPort();
    const oidc = await startTestOidcProvider();
    let apiRuntime: RunningAdminApi | null = null;
    let admin: pg.Pool | null = null;
    let s3: S3Client | null = null;

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
      "/var/lib/postgresql/data:rw,noexec,nosuid,size=2g",
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
      const s3Endpoint = `http://127.0.0.1:${String(s3Port)}`;
      const adminConfig: pg.ClientConfig = {
        host: "127.0.0.1",
        port: postgresPort,
        database,
        user: "postgres",
        password: adminPassword,
        application_name: "ontos-g2-02-13-admin",
      };
      await waitForPostgreSql(adminConfig);
      await withClient(adminConfig, async (client) => {
        await runDatabaseMigrations(client);
        await client.query(`
          ALTER ROLE api_runtime LOGIN PASSWORD '${apiPassword}';
          ALTER ROLE worker_runtime LOGIN PASSWORD '${workerPassword}';
          CREATE ROLE g20213_ddl LOGIN PASSWORD '${ddlPassword}'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
          GRANT migration_owner TO g20213_ddl;
          GRANT CONNECT ON DATABASE ${database} TO g20213_ddl;
        `);
      });
      admin = new pg.Pool(adminConfig);
      s3 = createS3Client(s3Endpoint);
      await waitForS3(s3, bucket);
      await s3.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );

      const objectStore = {
        endpoint: s3Endpoint,
        region: "us-east-1",
        bucket,
        accessKeyId,
        secretAccessKey,
        forcePathStyle: true,
        maxAttempts: 1,
      } as const;
      apiRuntime = await startAdminApi({
        host: "127.0.0.1",
        port: 0,
        databaseUrl: postgresUrl({ ...adminConfig, user: "api_runtime", password: apiPassword }),
        oidc: {
          issuer: oidc.issuer,
          audience: oidc.audience,
          requiredScope: "ontos.admin",
        },
        cursorHmacSecret: cursorSecret,
        managedCsvMaximumBytes: 10 * 1024 * 1024,
        objectStore,
      });
      const ownerToken = await oidc.token({ subject: "production-owner", name: "Owner" });
      const projectResponse = await api(apiRuntime, ownerToken, "POST", "/api/v1/admin/projects", {
        json: { apiName: "ProductionLoop", displayName: "Production Loop" },
      });
      assert.equal(projectResponse.status, 201, projectResponse.text);
      const projectId = stringField(record(record(projectResponse.json)["project"]), "projectId");
      const principal = await admin.query<{ readonly principalId: string }>(
        `SELECT principal_id AS "principalId" FROM authz.principals
         WHERE oidc_issuer = $1 AND oidc_subject = 'production-owner'`,
        [oidc.issuer],
      );
      const fixture = await seedPublishedMaterializationResources(
        admin,
        projectId,
        required(principal.rows[0]).principalId,
      );

      const releaseResponse = await api(
        apiRuntime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/releases`,
        {
          json: {
            targetChannelName: "production",
            revisionIds: [
              fixture.objectRevisionId,
              fixture.schemaRevisionId,
              fixture.mappingRevisionId,
            ],
          },
        },
      );
      assert.equal(releaseResponse.status, 201, releaseResponse.text);
      const releaseId = stringField(record(releaseResponse.json), "releaseId");

      const apiPool = new pg.Pool({ ...adminConfig, user: "api_runtime", password: apiPassword });
      let indexPlanId: string;
      try {
        const staged = await new IndexPlanAdmissionService({
          repository: new PostgresIndexPlanAdmissionRepository(apiPool),
          crypto: productionCrypto,
        }).stageReleasePlan({
          plan: releaseIndexPlan(projectId, releaseId, fixture),
          at: Date.now(),
        });
        assert.equal(staged.persistedPlans.length, 1);
        indexPlanId = required(staged.persistedPlans[0]).indexPlanId;
      } finally {
        await apiPool.end();
      }

      const workerConfig: pg.ClientConfig = {
        ...adminConfig,
        user: "worker_runtime",
        password: workerPassword,
      };
      const requestIds = await queueProjectionIndexes(workerConfig, projectId, indexPlanId);
      assert.equal(requestIds.length > 0, true);
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
          user: "g20213_ddl",
          password: ddlPassword,
        });
        const executed = await execFileAsync(process.execPath, [ddlEntry, "--plan-id", requestId], {
          env: environment,
        });
        assert.match(executed.stdout, /"outcome":"(?:CREATED|REUSED)"/u);
        assert.doesNotMatch(executed.stdout + executed.stderr, /g20213-ddl-secret/u);
      }

      assert.equal(
        (await api(apiRuntime, ownerToken, "POST", `/api/v1/admin/releases/${releaseId}/validate`))
          .status,
        200,
      );
      const firstStage = await api(
        apiRuntime,
        ownerToken,
        "POST",
        `/api/v1/admin/releases/${releaseId}/stage`,
      );
      assert.equal(firstStage.status, 200, firstStage.text);
      assert.equal(record(record(firstStage.json)["release"])["state"], "staging");

      const csv = Buffer.from("id,name\n1,Ada\n2,Grace\n", "utf8");
      const sessionResponse = await api(
        apiRuntime,
        ownerToken,
        "POST",
        "/api/v1/admin/snapshot-upload-sessions",
        {
          json: {
            projectId,
            releaseId,
            targetMemberKey: "object:Customer",
            groupVersion: 1,
            expectedByteCount: csv.byteLength,
            sourceLabel: "customers.csv",
          },
        },
      );
      assert.equal(sessionResponse.status, 201, sessionResponse.text);
      const session = record(sessionResponse.json);
      const upload = await api(apiRuntime, ownerToken, "PUT", stringField(session, "uploadPath"), {
        bytes: csv,
      });
      assert.equal(upload.status, 200, upload.text);
      const finalized = await api(apiRuntime, ownerToken, "POST", "/api/v1/admin/snapshots", {
        json: {
          projectId,
          sessions: [
            {
              sessionId: stringField(session, "sessionId"),
              finalizeToken: stringField(session, "finalizeToken"),
              clientContentDigest: digestBytes(csv),
            },
          ],
        },
      });
      assert.equal(finalized.status, 201, finalized.text);

      const startJob = await api(
        apiRuntime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/materialization-jobs`,
        {
          headers: { "idempotency-key": "g20213-production-job-0001" },
          json: { snapshotGroupId: fixture.snapshotGroupId, groupVersion: 1 },
        },
      );
      assert.equal(startJob.status, 202, startJob.text);
      const jobId = stringField(record(startJob.json), "jobId");
      const worker = await startProductionMaterializationWorker({
        databaseUrl: postgresUrl(workerConfig),
        workerInstanceId: randomUUID(),
        leaseSeconds: 30,
        heartbeatIntervalMilliseconds: 5_000,
        idlePollMilliseconds: 25,
        dependencyBackoffMilliseconds: 100,
        shutdownGraceMilliseconds: 15_000,
        databasePoolMaximum: 4,
        objectStore,
      });
      let terminal: JobDiagnostic;
      try {
        terminal = await waitForJob(admin, projectId, jobId);
      } finally {
        await worker.close();
      }
      assert.equal(terminal.state, "succeeded", JSON.stringify(terminal));
      assert.equal(terminal.currentStage, "activate");

      const build = await readBuildEvidence(admin, projectId, jobId);
      assert.deepEqual(
        {
          generationState: build.generationState,
          snapshotState: build.snapshotState,
          groupState: build.groupState,
          objectRows: build.objectRows,
          currentRows: build.currentRows,
          qualityState: build.qualityState,
          prebuildAdmissions: build.prebuildAdmissions,
          postbuildAdmissions: build.postbuildAdmissions,
          servingHeadsBeforeOwner: build.servingHeads,
        },
        {
          generationState: "ready",
          snapshotState: "ready",
          groupState: "ready",
          objectRows: 2,
          currentRows: 2,
          qualityState: "passed",
          prebuildAdmissions: 1,
          postbuildAdmissions: 1,
          servingHeadsBeforeOwner: 0,
        },
      );
      const report = await api(
        apiRuntime,
        ownerToken,
        "GET",
        `/api/v1/admin/projects/${projectId}/materialization-reports/${build.reportId}`,
      );
      assert.equal(report.status, 200, report.text);
      assert.equal(record(report.json)["acceptedRows"], 2);
      const capacity = await api(
        apiRuntime,
        ownerToken,
        "GET",
        `/api/v1/admin/projects/${projectId}/generations/${build.generationId}/capacity`,
      );
      assert.equal(capacity.status, 200, capacity.text);
      assert.equal(record(capacity.json)["phase"], "POSTBUILD");

      const refresh = await api(
        apiRuntime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/snapshot-groups/${fixture.snapshotGroupId}/versions/1/refresh`,
        { headers: { "idempotency-key": "g20213-production-refresh-0001" }, json: {} },
      );
      assert.equal(refresh.status, 202, refresh.text);
      assert.equal(
        record(required(arrayField(record(refresh.json), "releases")[0]))["outcome"],
        "ready",
      );

      const secondStage = await api(
        apiRuntime,
        ownerToken,
        "POST",
        `/api/v1/admin/releases/${releaseId}/stage`,
      );
      assert.equal(secondStage.status, 200, secondStage.text);
      assert.equal(record(record(secondStage.json)["release"])["state"], "ready");
      const control = await admin.query<{ readonly publicationSequence: string }>(
        `SELECT publication_sequence::text AS "publicationSequence"
         FROM meta.projects WHERE project_id = $1`,
        [projectId],
      );
      const activation = await api(
        apiRuntime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/snapshot-groups/${fixture.snapshotGroupId}/versions/1/activate`,
        {
          headers: { "idempotency-key": "g20213-production-activate-0001" },
          json: {
            expectedControlRevision: required(control.rows[0]).publicationSequence,
          },
        },
      );
      assert.equal(activation.status, 200, activation.text);
      assert.equal(record(activation.json)["changed"], true);
      assert.equal(record(activation.json)["insertedHeadCount"], 2);

      const publication = await api(
        apiRuntime,
        ownerToken,
        "POST",
        `/api/v1/admin/releases/${releaseId}/publish`,
        { json: { expectedChannelControlSequence: "0" } },
      );
      assert.equal(publication.status, 200, publication.text);
      const finalState = await admin.query<{
        readonly releaseState: string;
        readonly groupState: string;
        readonly generationState: string;
        readonly servingHeads: number;
        readonly channelCount: number;
      }>(
        `SELECT
           (SELECT state FROM meta.releases WHERE release_id = $2) AS "releaseState",
           (SELECT state FROM runtime.snapshot_group_versions
             WHERE project_id = $1 AND snapshot_group_id = $3 AND group_version = 1) AS "groupState",
           (SELECT state FROM runtime.generations
             WHERE project_id = $1 AND generation_id = $4) AS "generationState",
           (SELECT count(*)::integer FROM meta.release_serving_heads
             WHERE project_id = $1 AND release_id = $2) AS "servingHeads",
           (SELECT count(*)::integer FROM meta.release_channels
             WHERE project_id = $1 AND release_id = $2 AND channel_name = 'production') AS "channelCount"`,
        [projectId, releaseId, fixture.snapshotGroupId, build.generationId],
      );
      assert.deepEqual(finalState.rows[0], {
        releaseState: "published",
        groupState: "active",
        generationState: "active",
        servingHeads: 1,
        channelCount: 1,
      });
    } finally {
      if (apiRuntime !== null) await apiRuntime.close();
      if (admin !== null) await admin.end();
      s3?.destroy();
      await docker(["rm", "--force", "--volumes", s3Container], true);
      await docker(["rm", "--force", "--volumes", postgresContainer], true);
      await oidc.close();
    }
  },
);

interface MaterializationFixture {
  readonly objectResourceId: string;
  readonly objectRevisionId: string;
  readonly schemaResourceId: string;
  readonly schemaRevisionId: string;
  readonly mappingResourceId: string;
  readonly mappingRevisionId: string;
  readonly snapshotGroupId: string;
  readonly objectType: Readonly<Record<string, unknown>>;
}

interface JobDiagnostic {
  readonly state: string;
  readonly currentStage: string | null;
  readonly resultCode: string | null;
  readonly attemptCount: number;
}

async function seedPublishedMaterializationResources(
  admin: pg.Pool,
  projectId: string,
  principalId: string,
): Promise<MaterializationFixture> {
  const objectResourceId = randomUUID();
  const objectRevisionId = randomUUID();
  const schemaResourceId = randomUUID();
  const schemaRevisionId = randomUUID();
  const mappingResourceId = randomUUID();
  const mappingRevisionId = randomUUID();
  const snapshotGroupId = randomUUID();
  const objectType = {
    schemaVersion: 1,
    apiName: "Customer",
    displayName: "Customer",
    description: "Production integration customer.",
    primaryKeyPropertyApiName: "id",
    titlePropertyApiName: "name",
    defaultSearchPropertyApiNames: ["name"],
    defaultSort: [{ propertyApiName: "id", direction: "asc" }],
    defaultClassification: "internal",
    properties: [
      property("id", { unique: true, filterable: true, sortable: true }),
      property("name", { filterable: true, sortable: true, searchable: true }),
    ],
  } as const;
  const schema = {
    schemaVersion: 1,
    contractVersion: "snapshot-schema-v1",
    format: "csv_utf8",
    headerRow: true,
    columns: [
      { ordinal: 0, columnApiName: "id", valueType: "string", required: true },
      { ordinal: 1, columnApiName: "name", valueType: "string", required: true },
    ],
  } as const;
  const mapping = {
    schemaVersion: 1,
    mappingVersion: "mapping-v1",
    targetKind: "object",
    inputSchemaRevisionId: schemaRevisionId,
    targetResourceId: objectResourceId,
    targetRevisionId: objectRevisionId,
    valueCodecVersion: "pk1",
    propertyMappings: [
      {
        propertyApiName: "name",
        required: true,
        nullPolicy: "reject_row",
        expression: { op: "column", columnApiName: "name" },
      },
    ],
    primaryKeyExpression: { op: "column", columnApiName: "id" },
    qualityRules: {
      primaryKeyNullMaximumCount: 0,
      primaryKeyDuplicateMaximumCount: 0,
      requiredPropertyFailureMaximumCount: 0,
      requiredLinkDanglingMaximumCount: 0,
      optionalPropertyFailureMaximumBasisPoints: 0,
      optionalLinkDanglingMaximumBasisPoints: 0,
      rowCountChangeConfirmationBasisPoints: 1000,
      optionalFailureDisposition: "reject_row",
    },
  } as const;
  for (const resource of [
    {
      resourceId: objectResourceId,
      revisionId: objectRevisionId,
      family: "object_type",
      apiName: "Customer",
      content: objectType,
    },
    {
      resourceId: schemaResourceId,
      revisionId: schemaRevisionId,
      family: "snapshot_schema",
      apiName: "CustomerCsvSchema",
      content: schema,
    },
    {
      resourceId: mappingResourceId,
      revisionId: mappingRevisionId,
      family: "mapping",
      apiName: "CustomerCsvMapping",
      content: mapping,
    },
  ] as const) {
    const contentDigest = digestJson(resource.content);
    await admin.query(
      `INSERT INTO meta.resources
         (resource_id, project_id, namespace, api_name, family)
       VALUES ($1, $2, 'production.integration', $3, $4)`,
      [resource.resourceId, projectId, resource.apiName, resource.family],
    );
    await admin.query(
      `INSERT INTO meta.resource_revisions
         (revision_id, resource_id, revision_number, family, content_digest,
          content, created_by_principal_id)
       VALUES ($1, $2, 1, $3, $4, $5, $6)`,
      [
        resource.revisionId,
        resource.resourceId,
        resource.family,
        contentDigest,
        resource.content,
        principalId,
      ],
    );
    await admin.query(
      `INSERT INTO meta.validation_reports
         (report_id, subject_type, subject_id, resource_revision_id,
          subject_digest, validation_context_digest, validator_version, valid, issues)
       VALUES ($1, 'resource_revision', $2, $2, $3, $3,
               'metadata-g2-01-v1', true, '[]'::jsonb)`,
      [randomUUID(), resource.revisionId, contentDigest],
    );
    await admin.query(
      `UPDATE meta.resource_revisions SET state = 'validated', changed_at = clock_timestamp()
       WHERE revision_id = $1`,
      [resource.revisionId],
    );
    await admin.query(
      `UPDATE meta.resource_revisions SET state = 'published', changed_at = clock_timestamp()
       WHERE revision_id = $1`,
      [resource.revisionId],
    );
  }
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO runtime.snapshot_groups
         (project_id, snapshot_group_id, group_key, definition_member_count)
       VALUES ($1, $2, 'customers', 1)`,
      [projectId, snapshotGroupId],
    );
    await client.query(
      `INSERT INTO runtime.snapshot_group_definition_members
         (project_id, snapshot_group_id, ordinal, mapping_resource_id)
       VALUES ($1, $2, 0, $3)`,
      [projectId, snapshotGroupId, mappingResourceId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await admin.query(
    `INSERT INTO runtime.project_runtime_inventories
       (project_id, state_revision, inventory_revision, measurement_complete, inventory_digest)
     VALUES ($1, 1, 1, true, $2)`,
    [projectId, digestText("g2-02-13-initial-inventory")],
  );
  return Object.freeze({
    objectResourceId,
    objectRevisionId,
    schemaResourceId,
    schemaRevisionId,
    mappingResourceId,
    mappingRevisionId,
    snapshotGroupId,
    objectType,
  });
}

function releaseIndexPlan(
  projectId: string,
  releaseId: string,
  fixture: MaterializationFixture,
): ReleaseIndexPlanInput {
  return {
    projectId,
    releaseId,
    evidenceCatalog: ["query:id", "query:name", "search:name"],
    objectTypes: [
      {
        resourceId: fixture.objectResourceId,
        revisionId: fixture.objectRevisionId,
        properties: [
          { propertyId: "id", type: "string", primaryKey: true },
          { propertyId: "name", type: "string", filterable: true, searchable: true },
        ],
        indexes: [
          { kind: "btree", keys: [{ propertyId: "name" }], evidenceRefs: ["query:name"] },
          { kind: "gin_trigram", propertyId: "name", evidenceRefs: ["search:name"] },
        ],
      },
    ],
  };
}

async function queueProjectionIndexes(
  workerConfig: pg.ClientConfig,
  projectId: string,
  indexPlanId: string,
): Promise<readonly string[]> {
  return withClient(workerConfig, async (worker) => {
    const entries = await worker.query<{ readonly entryKey: string }>(
      `SELECT entry_key AS "entryKey" FROM runtime.index_plan_entries
       WHERE project_id = $1 AND index_plan_id = $2 ORDER BY ordinal`,
      [projectId, indexPlanId],
    );
    const requests: string[] = [];
    for (const entry of entries.rows) {
      const requestId = randomUUID();
      const queued = await worker.query<{ readonly state: string }>(
        `SELECT state FROM ops.request_projection_index_build($1, $2, $3, $4)`,
        [projectId, indexPlanId, entry.entryKey, requestId],
      );
      assert.equal(required(queued.rows[0]).state, "APPROVED");
      requests.push(requestId);
    }
    return Object.freeze(requests);
  });
}

async function waitForJob(
  admin: pg.Pool,
  projectId: string,
  jobId: string,
): Promise<JobDiagnostic> {
  let latest: JobDiagnostic | null = null;
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const result = await admin.query<JobDiagnostic & pg.QueryResultRow>(
      `SELECT state, current_stage AS "currentStage", result_code AS "resultCode",
              attempt_count AS "attemptCount"
       FROM ops.materialization_jobs WHERE project_id = $1 AND job_id = $2`,
      [projectId, jobId],
    );
    latest = required(result.rows[0]);
    if (["succeeded", "dead_letter", "cancelled"].includes(latest.state)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Worker job did not finish: ${JSON.stringify(latest)}`);
}

async function readBuildEvidence(admin: pg.Pool, projectId: string, jobId: string) {
  const result = await admin.query<{
    readonly generationId: string;
    readonly reportId: string;
    readonly generationState: string;
    readonly snapshotState: string;
    readonly groupState: string;
    readonly qualityState: string;
    readonly objectRows: number;
    readonly currentRows: number;
    readonly prebuildAdmissions: number;
    readonly postbuildAdmissions: number;
    readonly servingHeads: number;
  }>(
    `SELECT generation.generation_id AS "generationId",
            generation.report_id AS "reportId",
            generation.state AS "generationState",
            snapshot.state AS "snapshotState",
            version.state AS "groupState",
            quality.state AS "qualityState",
            (SELECT count(*)::integer FROM runtime.object_base AS base
              WHERE base.project_id = generation.project_id
                AND base.generation_id = generation.generation_id) AS "objectRows",
            (SELECT count(*)::integer FROM runtime.object_current AS current
              WHERE current.project_id = generation.project_id
                AND current.generation_id = generation.generation_id) AS "currentRows",
            (SELECT count(*)::integer FROM runtime.capacity_admissions AS admission
              WHERE admission.project_id = generation.project_id
                AND admission.generation_id = generation.generation_id
                AND admission.phase = 'PREBUILD') AS "prebuildAdmissions",
            (SELECT count(*)::integer FROM runtime.capacity_admissions AS admission
              WHERE admission.project_id = generation.project_id
                AND admission.generation_id = generation.generation_id
                AND admission.phase = 'POSTBUILD') AS "postbuildAdmissions",
            (SELECT count(*)::integer FROM meta.release_serving_heads AS head
              WHERE head.project_id = generation.project_id) AS "servingHeads"
     FROM ops.materialization_jobs AS job
     JOIN runtime.generations AS generation
       ON generation.project_id = job.project_id
      AND generation.snapshot_group_id = job.snapshot_group_id
      AND generation.group_version = job.group_version
     JOIN runtime.dataset_snapshots AS snapshot
       ON snapshot.project_id = generation.project_id
      AND snapshot.snapshot_id = generation.snapshot_id
     JOIN runtime.snapshot_group_versions AS version
       ON version.project_id = generation.project_id
      AND version.snapshot_group_id = generation.snapshot_group_id
      AND version.group_version = generation.group_version
     JOIN runtime.materialization_quality_bindings AS quality
       ON quality.project_id = generation.project_id
      AND quality.generation_id = generation.generation_id
     WHERE job.project_id = $1 AND job.job_id = $2`,
    [projectId, jobId],
  );
  return required(result.rows[0]);
}

interface ApiResponse {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
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
      "x-correlation-id": "corr_g20213-production-0001",
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
  return { status: response.status, text, json: JSON.parse(text) as unknown };
}

function property(
  apiName: string,
  capabilities: {
    readonly unique?: boolean;
    readonly filterable?: boolean;
    readonly sortable?: boolean;
    readonly searchable?: boolean;
  },
) {
  return {
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `${apiName} property.`,
    valueType: "string",
    caseSensitive: true,
    nullable: false,
    writeMode: "source_only",
    unique: capabilities.unique ?? false,
    filterable: capabilities.filterable ?? false,
    sortable: capabilities.sortable ?? false,
    searchable: capabilities.searchable ?? false,
    classification: "internal",
  } as const;
}

const productionCrypto: IndexCapacityCrypto = Object.freeze({
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("S3 did not become ready.", { cause: lastError });
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (address === null || typeof address === "string") throw new Error("Port reservation failed.");
  return address.port;
}

async function waitForPostgreSql(config: pg.ClientConfig): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await withClient(config, (client) => client.query("SELECT 1").then(() => undefined));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
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

async function docker(arguments_: readonly string[], ignoreFailure = false): Promise<void> {
  try {
    await execFileAsync("docker", [...arguments_]);
  } catch (error) {
    if (!ignoreFailure) throw error;
  }
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
  return digestText(JSON.stringify(value));
}

function digestText(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Readonly<Record<string, unknown>>;
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  assert.equal(typeof field, "string");
  return field as string;
}

function arrayField(value: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
  const field = value[key];
  assert.equal(Array.isArray(field), true);
  return field as readonly unknown[];
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required fixture value is absent.");
  return value;
}

void parseErrorEnvelope;
