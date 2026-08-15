import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { request } from "node:http";
import { createServer } from "node:net";
import test from "node:test";
import { promisify } from "node:util";

import {
  HeadBucketCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { canonicalizeMaterializationContractForDigest, parseErrorEnvelope } from "@ontos/contracts";
import pg from "pg";

import { startAdminApi, type RunningAdminApi } from "../../../apps/api/src/runtime.ts";
import { runDatabaseMigrations } from "../../database/migrator.ts";
import { resolvePostgresTestImage } from "../../database/postgres-test-image.ts";
import { startTestOidcProvider } from "../../admin-api/oidc-provider.ts";

const execFileAsync = promisify(execFile);
const postgresImage = resolvePostgresTestImage();
const s3Image =
  "chrislusf/seaweedfs:4.41@sha256:43b768cd62b00d132439cda881b93fd1adebf1b315e996e794087743821d771d";
const database = "ontos_g20204_http";
const adminPassword = "local-only-g20204-admin-secret";
const runtimePassword = "local-only-g20204-runtime-secret";
const accessKeyId = "local-only-g20204-s3-access";
const secretAccessKey = "local-only-g20204-s3-secret";
const cursorSecret = "local-only-g20204-cursor-hmac-secret-value";

void test(
  "G2-02-04 real OIDC, streaming HTTP, PostgreSQL, versioned S3, fault and restart closure",
  { timeout: 240_000 },
  async () => {
    const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
    const containerName = `ontos-g20204-pg-${suffix}`;
    const s3Container = `ontos-g20204-s3-${suffix}`;
    const bucket = `ontos-g20204-${process.pid}`;
    const s3HostPort = await reserveLoopbackPort();
    const oidc = await startTestOidcProvider();
    let runtime: RunningAdminApi | null = null;
    let admin: pg.Pool | null = null;
    let s3: S3Client | null = null;

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
      `127.0.0.1:${String(s3HostPort)}:8333`,
      s3Image,
      "mini",
      "-dir=/data",
    ]);

    try {
      const postgresPort = await publishedPort(containerName, "5432/tcp");
      const s3Endpoint = `http://127.0.0.1:${String(s3HostPort)}`;
      const adminConfig: pg.ClientConfig = {
        host: "127.0.0.1",
        port: postgresPort,
        database,
        user: "postgres",
        password: adminPassword,
        application_name: "ontos-g2-02-04-http-admin",
      };
      await waitForPostgreSql(adminConfig);
      await withClient(adminConfig, async (client) => {
        await runDatabaseMigrations(client);
        await client.query(`ALTER ROLE api_runtime LOGIN PASSWORD '${runtimePassword}'`);
      });
      admin = new pg.Pool(adminConfig);

      s3 = createS3Client(s3Endpoint, bucket);
      await waitForS3(s3, bucket);
      await s3.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );

      const apiConfig = {
        host: "127.0.0.1",
        port: 0,
        databaseUrl: `postgresql://api_runtime:${runtimePassword}@127.0.0.1:${String(postgresPort)}/${database}`,
        oidc: {
          issuer: oidc.issuer,
          audience: oidc.audience,
          requiredScope: "ontos.admin",
        },
        cursorHmacSecret: cursorSecret,
        managedCsvMaximumBytes: 10 * 1024 * 1024,
        objectStore: {
          endpoint: s3Endpoint,
          region: "us-east-1",
          bucket,
          accessKeyId,
          secretAccessKey,
          forcePathStyle: true,
          maxAttempts: 1,
        },
      } as const;
      runtime = await startAdminApi(apiConfig);
      const ownerToken = await oidc.token({ subject: "ingress-owner", name: "Ingress Owner" });
      const outsiderToken = await oidc.token({
        subject: "ingress-outsider",
        name: "Ingress Outsider",
      });

      const projectResponse = await api(runtime, ownerToken, "POST", "/api/v1/admin/projects", {
        json: { apiName: "IngressProject", displayName: "Ingress Project" },
      });
      assert.equal(projectResponse.status, 201);
      const projectId = stringField(record(record(projectResponse.json)["project"]), "projectId");
      const principal = await admin.query<{ readonly principal_id: string }>(
        `SELECT principal_id FROM authz.principals
          WHERE oidc_issuer = $1 AND oidc_subject = 'ingress-owner'`,
        [oidc.issuer],
      );
      const principalId = required(principal.rows[0]).principal_id;
      const fixture = await seedIngressRuntimePlan(admin, projectId, principalId);
      const csv = Buffer.from("id,name\n1,Ada\n2,Grace\n", "utf8");

      const hidden = await api(
        runtime,
        outsiderToken,
        "POST",
        "/api/v1/admin/snapshot-upload-sessions",
        { json: createSessionBody(fixture, projectId, csv.byteLength, "outsider.csv") },
      );
      assert.equal(hidden.status, 404);
      assert.equal(errorCode(hidden), "OBJECT_NOT_ACCESSIBLE");

      const injected = await api(
        runtime,
        ownerToken,
        "POST",
        "/api/v1/admin/snapshot-upload-sessions",
        {
          json: {
            ...createSessionBody(fixture, projectId, csv.byteLength, "injected.csv"),
            bucket,
          },
        },
      );
      assert.equal(injected.status, 400);
      assert.equal(errorCode(injected), "ADMIN_REQUEST_INVALID");

      const firstCreation = await api(
        runtime,
        ownerToken,
        "POST",
        "/api/v1/admin/snapshot-upload-sessions",
        { json: createSessionBody(fixture, projectId, csv.byteLength, "first.csv") },
      );
      assert.equal(firstCreation.status, 201);
      const firstSession = createdSession(firstCreation);
      assert.doesNotMatch(firstCreation.text, /objectKey|secretAccessKey|127\.0\.0\.1:|bucket/iu);
      const firstUpload = await api(runtime, ownerToken, "PUT", firstSession.uploadPath, {
        bytes: csv,
      });
      assert.equal(firstUpload.status, 200);
      const firstInternal = await internalSession(admin, firstSession.sessionId);
      assert.notEqual(firstInternal.finalize_token_digest, firstSession.finalizeToken);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: firstInternal.object_key,
          Body: Buffer.from("id,name\n999,Tampered\n", "utf8"),
          ContentType: "text/csv",
        }),
      );
      const mutatedFinalize = await api(runtime, ownerToken, "POST", "/api/v1/admin/snapshots", {
        json: {
          projectId,
          sessions: [
            {
              sessionId: firstSession.sessionId,
              finalizeToken: firstSession.finalizeToken,
            },
          ],
        },
      });
      assert.equal(mutatedFinalize.status, 422, mutatedFinalize.text);
      assert.equal(errorCode(mutatedFinalize), "SNAPSHOT_CONTENT_MISMATCH");

      const secondCreation = await api(
        runtime,
        ownerToken,
        "POST",
        "/api/v1/admin/snapshot-upload-sessions",
        { json: createSessionBody(fixture, projectId, csv.byteLength, "accepted.csv") },
      );
      assert.equal(secondCreation.status, 201);
      const secondSession = createdSession(secondCreation);

      await interruptUpload(runtime, ownerToken, secondSession.uploadPath, csv);
      const interruptedInternal = await internalSession(admin, secondSession.sessionId);
      assert.equal(interruptedInternal.state, "created");
      assert.deepEqual(await objectVersionIds(s3, bucket, interruptedInternal.object_key), []);

      await docker(["stop", s3Container]);
      const unavailableUpload = await api(runtime, ownerToken, "PUT", secondSession.uploadPath, {
        bytes: csv,
      });
      assert.equal(unavailableUpload.status, 503);
      assert.equal(errorCode(unavailableUpload), "DEPENDENCY_UNAVAILABLE");
      assert.doesNotMatch(unavailableUpload.text, /ECONNREFUSED|objectKey|127\.0\.0\.1/iu);
      await docker(["start", s3Container]);
      s3.destroy();
      s3 = createS3Client(s3Endpoint, bucket);
      await waitForS3(s3, bucket);
      await s3.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );

      const recoveredUpload = await api(runtime, ownerToken, "PUT", secondSession.uploadPath, {
        bytes: csv,
      });
      assert.equal(recoveredUpload.status, 200);
      const finalizeBody = {
        projectId,
        sessions: [
          {
            sessionId: secondSession.sessionId,
            finalizeToken: secondSession.finalizeToken,
            clientContentDigest: digestBytes(csv),
          },
        ],
      };
      const concurrent = await Promise.all([
        api(runtime, ownerToken, "POST", "/api/v1/admin/snapshots", { json: finalizeBody }),
        api(runtime, ownerToken, "POST", "/api/v1/admin/snapshots", { json: finalizeBody }),
      ]);
      assert.ok(concurrent.some((response) => response.status === 201));
      assert.ok(concurrent.every((response) => response.status === 201 || response.status === 409));
      const winner = required(concurrent.find((response) => response.status === 201));
      assert.doesNotMatch(
        winner.text,
        /objectKey|objectVersion|finalizeToken|secret|127\.0\.0\.1/iu,
      );
      const snapshotResult = record(winner.json);
      assert.equal(arrayField(snapshotResult, "snapshots").length, 1);
      const winningInternal = await internalSession(admin, secondSession.sessionId);
      assert.equal(winningInternal.state, "finalized");
      assert.ok(winningInternal.uploaded_object_version);
      assert.equal(await rowCount(admin, "runtime.dataset_snapshots"), 1);
      assert.equal(await rowCount(admin, "runtime.snapshot_group_versions"), 1);
      assert.equal(await rowCount(admin, "runtime.snapshot_files"), 1);

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: winningInternal.object_key,
          Body: Buffer.from("orphan-after-finalize", "utf8"),
          ContentType: "text/csv",
        }),
      );
      assert.equal((await objectVersionIds(s3, bucket, winningInternal.object_key)).length, 2);

      await runtime.close();
      runtime = null;
      runtime = await startAdminApi(apiConfig);
      await waitForCleanup(admin, secondSession.sessionId);
      assert.deepEqual(await objectVersionIds(s3, bucket, winningInternal.object_key), [
        required(winningInternal.uploaded_object_version),
      ]);
      const replay = await api(runtime, ownerToken, "POST", "/api/v1/admin/snapshots", {
        json: finalizeBody,
      });
      assert.equal(replay.status, 201);
      assert.deepEqual(replay.json, winner.json);

      const crashCreation = await api(
        runtime,
        ownerToken,
        "POST",
        "/api/v1/admin/snapshot-upload-sessions",
        {
          json: createSessionBody(fixture, projectId, csv.byteLength, "crash-recovery.csv", 2),
        },
      );
      assert.equal(crashCreation.status, 201);
      const crashSession = createdSession(crashCreation);
      assert.equal(
        (
          await api(runtime, ownerToken, "PUT", crashSession.uploadPath, {
            bytes: csv,
          })
        ).status,
        200,
      );
      await admin.query(
        `UPDATE runtime.snapshot_upload_sessions
            SET state = 'finalizing', finalize_claim_id = $2,
                finalize_lease_expires_at = clock_timestamp() + interval '100 milliseconds',
                changed_at = clock_timestamp()
          WHERE session_id = $1 AND state = 'uploaded'`,
        [crashSession.sessionId, randomUUID()],
      );
      await runtime.close();
      runtime = null;
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      runtime = await startAdminApi(apiConfig);
      const recoveredFinalize = await api(runtime, ownerToken, "POST", "/api/v1/admin/snapshots", {
        json: {
          projectId,
          sessions: [
            {
              sessionId: crashSession.sessionId,
              finalizeToken: crashSession.finalizeToken,
            },
          ],
        },
      });
      assert.equal(recoveredFinalize.status, 201, recoveredFinalize.text);
      assert.equal(record(record(recoveredFinalize.json)["group"])["groupVersion"], 2);
      assert.equal(await rowCount(admin, "runtime.dataset_snapshots"), 2);
      assert.equal(await rowCount(admin, "runtime.snapshot_group_versions"), 2);

      const states = await admin.query<{
        readonly state: string;
        readonly failure_code: string | null;
      }>(
        `SELECT state, failure_code FROM runtime.snapshot_upload_sessions
          ORDER BY created_at, session_id`,
      );
      assert.deepEqual(states.rows, [
        { state: "failed", failure_code: "SNAPSHOT_CONTENT_MISMATCH" },
        { state: "finalized", failure_code: null },
        { state: "finalized", failure_code: null },
      ]);
    } finally {
      if (runtime !== null) await runtime.close();
      if (admin !== null) await admin.end();
      s3?.destroy();
      await docker(["rm", "--force", "--volumes", s3Container], true);
      await docker(["rm", "--force", "--volumes", containerName], true);
      await oidc.close();
    }
  },
);

interface ApiResponse {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
}

interface IngressFixture {
  readonly releaseId: string;
  readonly memberKey: string;
}

interface CreatedSession {
  readonly sessionId: string;
  readonly uploadPath: string;
  readonly finalizeToken: string;
}

async function api(
  runtime: RunningAdminApi,
  token: string,
  method: string,
  path: string,
  input: { readonly json?: unknown; readonly bytes?: Uint8Array } = {},
): Promise<ApiResponse> {
  const body = input.bytes ?? (input.json === undefined ? undefined : JSON.stringify(input.json));
  const response = await fetch(`${runtime.origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(input.bytes === undefined
        ? input.json === undefined
          ? {}
          : { "content-type": "application/json" }
        : { "content-type": "text/csv", "content-length": String(input.bytes.byteLength) }),
    },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as unknown };
}

async function interruptUpload(
  runtime: RunningAdminApi,
  token: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const upload = request(`${runtime.origin}${path}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/csv",
        "content-length": String(bytes.byteLength),
      },
    });
    upload.on("response", (response) => {
      response.resume();
      response.on("end", resolve);
    });
    upload.on("error", resolve);
    upload.write(bytes.subarray(0, Math.max(1, Math.floor(bytes.byteLength / 2))));
    setTimeout(() => upload.destroy(new Error("intentional upload interruption")), 25);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function createSessionBody(
  fixture: IngressFixture,
  projectId: string,
  expectedByteCount: number,
  sourceLabel: string,
  groupVersion = 1,
) {
  return {
    projectId,
    releaseId: fixture.releaseId,
    targetMemberKey: fixture.memberKey,
    groupVersion,
    expectedByteCount,
    sourceLabel,
  };
}

function createdSession(response: ApiResponse): CreatedSession {
  const value = record(response.json);
  return {
    sessionId: stringField(value, "sessionId"),
    uploadPath: stringField(value, "uploadPath"),
    finalizeToken: stringField(value, "finalizeToken"),
  };
}

async function seedIngressRuntimePlan(
  admin: pg.Pool,
  projectId: string,
  principalId: string,
): Promise<IngressFixture> {
  const objectResourceId = randomUUID();
  const objectRevisionId = randomUUID();
  const schemaResourceId = randomUUID();
  const schemaRevisionId = randomUUID();
  const mappingResourceId = randomUUID();
  const mappingRevisionId = randomUUID();
  const releaseId = randomUUID();
  const snapshotGroupId = randomUUID();
  const indexPlanId = randomUUID();
  const memberKey = "object:Customer";
  const schema = {
    schemaVersion: 1,
    contractVersion: "snapshot-schema-v1",
    format: "csv_utf8",
    headerRow: true,
    columns: [
      { ordinal: 0, columnApiName: "id", valueType: "string", required: true },
      { ordinal: 1, columnApiName: "name", valueType: "string", required: true },
    ],
  };
  const objectType = objectTypeContent();
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
  };

  await createPublishedResource(admin, {
    projectId,
    principalId,
    resourceId: objectResourceId,
    revisionId: objectRevisionId,
    family: "object_type",
    apiName: "Customer",
    content: objectType,
  });
  await createPublishedResource(admin, {
    projectId,
    principalId,
    resourceId: schemaResourceId,
    revisionId: schemaRevisionId,
    family: "snapshot_schema",
    apiName: "CustomerCsvSchema",
    content: schema,
  });
  await createPublishedResource(admin, {
    projectId,
    principalId,
    resourceId: mappingResourceId,
    revisionId: mappingRevisionId,
    family: "mapping",
    apiName: "CustomerCsvMapping",
    content: mapping,
  });

  const pins = [
    {
      resourceId: objectResourceId,
      revisionId: objectRevisionId,
      family: "object_type",
      content: objectType,
    },
    {
      resourceId: schemaResourceId,
      revisionId: schemaRevisionId,
      family: "snapshot_schema",
      content: schema,
    },
    {
      resourceId: mappingResourceId,
      revisionId: mappingRevisionId,
      family: "mapping",
      content: mapping,
    },
  ] as const;
  const manifestDigest = digestText("g2-02-04-release");
  const validationContextDigest = digestText("g2-02-04-release-context");
  await admin.query(
    `INSERT INTO meta.releases
       (release_id, project_id, release_number, manifest_digest,
        target_channel_name, created_by_principal_id)
     VALUES ($1, $2, 1, $3, 'production', $4)`,
    [releaseId, projectId, manifestDigest, principalId],
  );
  for (const [index, pin] of pins.entries()) {
    await admin.query(
      `INSERT INTO meta.release_pins
         (release_id, resource_id, revision_id, pin_order, family, content_digest)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [releaseId, pin.resourceId, pin.revisionId, index, pin.family, digestJson(pin.content)],
    );
  }
  await admin.query(
    `INSERT INTO meta.validation_reports
       (report_id, subject_type, subject_id, release_id, subject_digest,
        validation_context_digest, validator_version, valid, issues)
     VALUES ($1, 'release', $2, $2, $3, $4,
             'metadata-release-g2-01-v1', TRUE, '[]'::jsonb)`,
    [randomUUID(), releaseId, manifestDigest, validationContextDigest],
  );
  await admin.query(
    `UPDATE meta.releases
        SET state = 'staging', staged_channel_control_sequence = 0,
            staged_validation_context_digest = $2, staged_at = clock_timestamp(),
            changed_at = clock_timestamp()
      WHERE release_id = $1`,
    [releaseId, validationContextDigest],
  );
  await admin.query(
    `UPDATE meta.releases SET state = 'ready', changed_at = clock_timestamp()
      WHERE release_id = $1`,
    [releaseId],
  );
  await admin.query(
    `INSERT INTO runtime.snapshot_groups
       (project_id, snapshot_group_id, group_key) VALUES ($1, $2, 'customers')`,
    [projectId, snapshotGroupId],
  );
  const indexPlanDigest = digestText("g2-02-04-index-plan");
  await admin.query(
    `INSERT INTO runtime.index_plans
       (project_id, index_plan_id, target_resource_id, target_revision_id,
        plan_digest, entry_count, compiler_version)
     VALUES ($1, $2, $3, $4, $5, 0, 'index-plan-g2-02-v1')`,
    [projectId, indexPlanId, objectResourceId, objectRevisionId, indexPlanDigest],
  );
  const runtimePlanDigest = digestText(
    canonicalizeMaterializationContractForDigest("RuntimeMemberPlan", {
      schemaVersion: 1,
      contractVersion: "runtime-member-plan-v1",
      projectId,
      releaseId,
      members: [
        {
          memberKey,
          memberKind: "object",
          targetResourceId: objectResourceId,
          targetRevisionId: objectRevisionId,
          snapshotSchemaRevisionId: schemaRevisionId,
          mappingRevisionId,
          snapshotGroupId,
          indexPlanDigest,
        },
      ],
      planDigest: digestText("placeholder"),
    }),
  );
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO meta.release_runtime_plans
         (project_id, release_id, plan_digest, member_count) VALUES ($1, $2, $3, 1)`,
      [projectId, releaseId, runtimePlanDigest],
    );
    await client.query(
      `INSERT INTO meta.release_runtime_plan_members (
         project_id, release_id, runtime_plan_digest, member_key, member_kind,
         target_resource_id, target_revision_id,
         snapshot_schema_resource_id, snapshot_schema_revision_id,
         mapping_resource_id, mapping_revision_id, snapshot_group_id, index_plan_digest
       ) VALUES ($1, $2, $3, $4, 'object', $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        projectId,
        releaseId,
        runtimePlanDigest,
        memberKey,
        objectResourceId,
        objectRevisionId,
        schemaResourceId,
        schemaRevisionId,
        mappingResourceId,
        mappingRevisionId,
        snapshotGroupId,
        indexPlanDigest,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { releaseId, memberKey };
}

async function createPublishedResource(
  admin: pg.Pool,
  input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly resourceId: string;
    readonly revisionId: string;
    readonly family: "object_type" | "snapshot_schema" | "mapping";
    readonly apiName: string;
    readonly content: unknown;
  },
): Promise<void> {
  const contentDigest = digestJson(input.content);
  await admin.query(
    `INSERT INTO meta.resources
       (resource_id, project_id, namespace, api_name, family)
     VALUES ($1, $2, 'ingress.test', $3, $4)`,
    [input.resourceId, input.projectId, input.apiName, input.family],
  );
  await admin.query(
    `INSERT INTO meta.resource_revisions
       (revision_id, resource_id, revision_number, family, content_digest,
        content, created_by_principal_id)
     VALUES ($1, $2, 1, $3, $4, $5, $6)`,
    [
      input.revisionId,
      input.resourceId,
      input.family,
      contentDigest,
      input.content,
      input.principalId,
    ],
  );
  await admin.query(
    `INSERT INTO meta.validation_reports
       (report_id, subject_type, subject_id, resource_revision_id,
        subject_digest, validation_context_digest, validator_version, valid, issues)
     VALUES ($1, 'resource_revision', $2, $2, $3, $3,
             'metadata-g2-01-v1', TRUE, '[]'::jsonb)`,
    [randomUUID(), input.revisionId, contentDigest],
  );
  await admin.query(
    `UPDATE meta.resource_revisions
        SET state = 'validated', changed_at = clock_timestamp()
      WHERE revision_id = $1`,
    [input.revisionId],
  );
  await admin.query(
    `UPDATE meta.resource_revisions
        SET state = 'published', changed_at = clock_timestamp()
      WHERE revision_id = $1`,
    [input.revisionId],
  );
}

function objectTypeContent() {
  return {
    schemaVersion: 1,
    apiName: "Customer",
    displayName: "Customer",
    description: "Ingress integration fixture.",
    primaryKeyPropertyApiName: "id",
    titlePropertyApiName: "name",
    defaultSearchPropertyApiNames: ["name"],
    defaultSort: [{ propertyApiName: "id", direction: "asc" }],
    defaultClassification: "internal",
    properties: [
      {
        schemaVersion: 1,
        apiName: "id",
        displayName: "ID",
        description: "Stable source ID.",
        valueType: "string",
        caseSensitive: true,
        nullable: false,
        writeMode: "source_only",
        unique: true,
        filterable: true,
        sortable: true,
        searchable: false,
        classification: "internal",
      },
      {
        schemaVersion: 1,
        apiName: "name",
        displayName: "Name",
        description: "Customer name.",
        valueType: "string",
        caseSensitive: true,
        nullable: false,
        writeMode: "source_only",
        unique: false,
        filterable: true,
        sortable: true,
        searchable: true,
        classification: "internal",
      },
    ],
  };
}

async function internalSession(admin: pg.Pool, sessionId: string) {
  const result = await admin.query<{
    readonly state: string;
    readonly object_key: string;
    readonly finalize_token_digest: string;
    readonly uploaded_object_version: string | null;
  }>(
    `SELECT state, object_key, finalize_token_digest, uploaded_object_version
       FROM runtime.snapshot_upload_sessions WHERE session_id = $1`,
    [sessionId],
  );
  return required(result.rows[0]);
}

async function waitForCleanup(admin: pg.Pool, sessionId: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await admin.query<{ readonly complete: boolean }>(
      `SELECT object_cleanup_completed_at IS NOT NULL AS complete
         FROM runtime.snapshot_upload_sessions WHERE session_id = $1`,
      [sessionId],
    );
    last = result.rows[0];
    if (result.rows[0]?.complete === true) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Finalized object cleanup did not complete.", { cause: last });
}

async function objectVersionIds(
  s3: S3Client,
  bucket: string,
  objectKey: string,
): Promise<readonly string[]> {
  const response = await s3.send(
    new ListObjectVersionsCommand({ Bucket: bucket, Prefix: objectKey }),
  );
  return (response.Versions ?? [])
    .filter((entry) => entry.Key === objectKey && entry.VersionId !== undefined)
    .map((entry) => required(entry.VersionId));
}

function createS3Client(endpoint: string, bucket: string): S3Client {
  void bucket;
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
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw new Error("S3 integration container did not become ready.", { cause: lastError });
}

async function rowCount(pool: pg.Pool, table: string): Promise<number> {
  const result = await pool.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM ${table}`,
  );
  return Number(required(result.rows[0]).count);
}

function digestJson(value: unknown): string {
  return digestText(JSON.stringify(value));
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function errorCode(response: ApiResponse): string {
  return parseErrorEnvelope(response.json).error.code;
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
  assert.ok(Array.isArray(field));
  return field;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required fixture value is missing.");
  return value;
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
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw new Error("PostgreSQL integration container did not become ready.", {
    cause: lastError,
  });
}

async function publishedPort(containerName: string, privatePort: string): Promise<number> {
  const { stdout } = await execFileAsync("docker", ["port", containerName, privatePort]);
  const match = /:(?<port>[0-9]+)\s*$/u.exec(stdout);
  const port = Number(match?.groups?.["port"]);
  if (!Number.isInteger(port) || port <= 0) throw new Error("Docker published port is invalid.");
  return port;
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not reserve a loopback port."));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolvePort(address.port);
        else rejectPort(error);
      });
    });
  });
}

async function docker(arguments_: readonly string[], ignoreFailure = false): Promise<void> {
  try {
    await execFileAsync("docker", [...arguments_]);
  } catch (error) {
    if (!ignoreFailure) throw error;
  }
}
