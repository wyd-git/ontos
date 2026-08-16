import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";

import { parseErrorEnvelope } from "@ontos/contracts";
import pg from "pg";

import { startAdminApi, type RunningAdminApi } from "../../../apps/api/src/runtime.ts";
import { runDatabaseMigrations } from "../../database/migrator.ts";
import { resolvePostgresTestImage } from "../../database/postgres-test-image.ts";
import { startTestOidcProvider } from "../oidc-provider.ts";

const execFileAsync = promisify(execFile);
const postgresImage = resolvePostgresTestImage();
const database = "ontos_g20110";
const adminPassword = "local-only-g20110-admin-secret";
const runtimePassword = "local-only-g20110-runtime-secret";
const cursorSecret = "local-only-g20110-cursor-hmac-secret-value";

void test(
  "G2-01-10 real OIDC, HTTP, RBAC, PostgreSQL and restart boundary",
  { timeout: 180_000 },
  async () => {
    const containerName = `ontos-g20110-${process.pid}-${randomUUID().slice(0, 8)}`;
    const oidc = await startTestOidcProvider();
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

    let runtime: RunningAdminApi | null = null;
    let admin: pg.Pool | null = null;
    try {
      const port = await publishedPostgreSqlPort(containerName);
      const adminConfig: pg.ClientConfig = {
        host: "127.0.0.1",
        port,
        database,
        user: "postgres",
        password: adminPassword,
        application_name: "ontos-g2-01-10-admin",
      };
      await waitForPostgreSql(adminConfig);
      await withClient(adminConfig, async (client) => {
        await runDatabaseMigrations(client);
        await client.query(`ALTER ROLE api_runtime LOGIN PASSWORD '${runtimePassword}'`);
      });
      admin = new pg.Pool(adminConfig);
      const apiConfig = {
        host: "127.0.0.1",
        port: 0,
        databaseUrl: `postgresql://api_runtime:${runtimePassword}@127.0.0.1:${String(port)}/${database}`,
        oidc: {
          issuer: oidc.issuer,
          audience: oidc.audience,
          requiredScope: "ontos.admin",
        },
        cursorHmacSecret: cursorSecret,
        managedCsvMaximumBytes: 1_048_576,
        objectStore: inertObjectStoreConfig,
      } as const;
      runtime = await startAdminApi(apiConfig, { objectStore: inertObjectStore });

      const ownerToken = await oidc.token({ subject: "owner", name: "Project Owner" });
      const editorToken = await oidc.token({ subject: "editor", name: "Metadata Editor" });
      const viewerToken = await oidc.token({ subject: "viewer", name: "Metadata Viewer" });

      for (const invalidToken of [
        await oidc.token({ issuer: `${oidc.issuer}/wrong` }),
        await oidc.token({ audience: "wrong-audience" }),
        await oidc.token({ expiresInSeconds: -10 }),
        await oidc.token({ scope: "openid" }),
      ]) {
        const rejected = await api(runtime, invalidToken, "GET", "/api/v1/admin/projects/bad");
        assert.equal(rejected.status, 401);
        assert.equal(errorCode(rejected), "AUTHENTICATION_REQUIRED");
      }
      assert.equal(await countRows(admin, "authz.principals"), 0);

      const unknown = await api(runtime, ownerToken, "POST", "/api/v1/admin/projects", {
        body: { apiName: "Bad", displayName: "Bad", unexpected: true },
      });
      assert.equal(unknown.status, 400);
      assert.equal(errorCode(unknown), "ADMIN_REQUEST_INVALID");
      assert.doesNotMatch(unknown.text, /Bearer|SELECT|postgresql|secret|JWT/iu);

      const projectResponse = await api(runtime, ownerToken, "POST", "/api/v1/admin/projects", {
        body: { apiName: "Commerce", displayName: "Commerce Control Plane" },
      });
      assert.equal(projectResponse.status, 201);
      assert.equal(projectResponse.headers.get("etag"), '"1"');
      const project = record(record(projectResponse.json)["project"]);
      const projectId = stringField(project, "projectId");

      for (const token of [editorToken, viewerToken]) {
        const denied = await api(runtime, token, "GET", `/api/v1/admin/projects/${projectId}`);
        assert.equal(denied.status, 404);
        assert.equal(errorCode(denied), "OBJECT_NOT_ACCESSIBLE");
      }
      const principalRows = await admin.query<{
        readonly principal_id: string;
        readonly oidc_subject: string;
      }>(
        `SELECT principal_id, oidc_subject
         FROM authz.principals
         WHERE oidc_issuer = $1 AND oidc_subject = ANY($2::text[])`,
        [oidc.issuer, ["editor", "viewer"]],
      );
      const principalIds = new Map(
        principalRows.rows.map(({ oidc_subject, principal_id }) => [oidc_subject, principal_id]),
      );
      const editorId = requiredMap(principalIds, "editor");
      const viewerId = requiredMap(principalIds, "viewer");

      const noMatch = await api(
        runtime,
        ownerToken,
        "PUT",
        `/api/v1/admin/projects/${projectId}/role-bindings`,
        { body: { targetPrincipalId: editorId, role: "editor" } },
      );
      assert.equal(noMatch.status, 400);
      const editorBinding = await api(
        runtime,
        ownerToken,
        "PUT",
        `/api/v1/admin/projects/${projectId}/role-bindings`,
        {
          headers: { "if-match": '"1"' },
          body: { targetPrincipalId: editorId, role: "editor" },
        },
      );
      assert.equal(editorBinding.status, 200);
      assert.equal(editorBinding.headers.get("etag"), '"2"');
      const viewerBinding = await api(
        runtime,
        ownerToken,
        "PUT",
        `/api/v1/admin/projects/${projectId}/role-bindings`,
        {
          headers: { "if-match": '"2"' },
          body: { targetPrincipalId: viewerId, role: "viewer" },
        },
      );
      assert.equal(viewerBinding.status, 200);
      assert.equal(viewerBinding.headers.get("etag"), '"3"');
      const bindings = await api(
        runtime,
        ownerToken,
        "GET",
        `/api/v1/admin/projects/${projectId}/role-bindings`,
      );
      assert.equal(bindings.status, 200);
      assert.equal(record(bindings.json)["authorizationEpoch"], "3");
      const editorCannotManage = await api(
        runtime,
        editorToken,
        "GET",
        `/api/v1/admin/projects/${projectId}/role-bindings`,
      );
      assert.equal(editorCannotManage.status, 404);

      const createdResource = await api(
        runtime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/resources`,
        {
          body: {
            namespace: "commerce.orders",
            apiName: "Order",
            family: "object_type",
            content: objectTypeContent("Order", "Initial definition."),
          },
        },
      );
      assert.equal(createdResource.status, 201);
      assert.equal(createdResource.headers.get("etag"), '"1"');
      const resource = record(record(createdResource.json)["resource"]);
      const initialDraft = record(record(createdResource.json)["initialDraft"]);
      const resourceId = stringField(resource, "resourceId");
      const revisionId = stringField(initialDraft, "revisionId");

      const materializationFixture = await seedMaterializationAdminFixture(admin, {
        projectId,
        principalId: editorId,
        resourceId,
        revisionId,
      });
      const groupRead = await api(
        runtime,
        viewerToken,
        "GET",
        `/api/v1/admin/projects/${projectId}/snapshot-groups/${materializationFixture.snapshotGroupId}/versions/1`,
      );
      assert.equal(groupRead.status, 200);
      assert.equal(record(groupRead.json)["memberCount"], 1);
      const snapshotRead = await api(
        runtime,
        viewerToken,
        "GET",
        `/api/v1/admin/projects/${projectId}/snapshots/${materializationFixture.snapshotId}`,
      );
      assert.equal(snapshotRead.status, 200);
      assert.equal(record(snapshotRead.json)["sourceLabel"], "orders.csv");

      const viewerCannotStart = await api(
        runtime,
        viewerToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/materialization-jobs`,
        {
          headers: { "idempotency-key": "materialization-http-0001" },
          body: { snapshotGroupId: materializationFixture.snapshotGroupId, groupVersion: 1 },
        },
      );
      assert.equal(viewerCannotStart.status, 404);
      const startedJob = await api(
        runtime,
        editorToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/materialization-jobs`,
        {
          headers: { "idempotency-key": "materialization-http-0001" },
          body: { snapshotGroupId: materializationFixture.snapshotGroupId, groupVersion: 1 },
        },
      );
      assert.equal(startedJob.status, 202);
      assert.ok(startedJob.headers.get("etag"));
      const jobId = stringField(record(startedJob.json), "jobId");
      const replayedJob = await api(
        runtime,
        editorToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/materialization-jobs`,
        {
          headers: { "idempotency-key": "materialization-http-0001" },
          body: { snapshotGroupId: materializationFixture.snapshotGroupId, groupVersion: 1 },
        },
      );
      assert.equal(replayedJob.status, 202);
      assert.equal(stringField(record(replayedJob.json), "jobId"), jobId);
      assert.equal(record(replayedJob.json)["reused"], true);
      const viewerJobRead = await api(
        runtime,
        viewerToken,
        "GET",
        `/api/v1/admin/projects/${projectId}/materialization-jobs/${jobId}`,
      );
      assert.equal(viewerJobRead.status, 200);
      const jobVersion = viewerJobRead.headers.get("etag");
      assert.ok(jobVersion);
      const viewerCannotCancel = await api(
        runtime,
        viewerToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/materialization-jobs/${jobId}/cancel`,
        { headers: { "if-match": jobVersion }, body: {} },
      );
      assert.equal(viewerCannotCancel.status, 404);
      const cancelledJob = await api(
        runtime,
        editorToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/materialization-jobs/${jobId}/cancel`,
        { headers: { "if-match": jobVersion }, body: {} },
      );
      assert.equal(cancelledJob.status, 202);
      assert.equal(record(cancelledJob.json)["state"], "cancelled");
      const staleCancel = await api(
        runtime,
        editorToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/materialization-jobs/${jobId}/cancel`,
        { headers: { "if-match": jobVersion }, body: {} },
      );
      assert.equal(staleCancel.status, 409);
      assert.equal(errorCode(staleCancel), "OBJECT_VERSION_CONFLICT");

      const capacityExpiry = canonicalFutureInstant(24 * 60 * 60 * 1_000);
      const editorCannotApproveCapacity = await api(
        runtime,
        editorToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/capacity-approvals`,
        {
          headers: { "if-match": '"7"' },
          body: {
            scope: "project_peak",
            scopeId: null,
            approvedLimitBytes: "11811160064",
            expiresAt: capacityExpiry,
          },
        },
      );
      assert.equal(editorCannotApproveCapacity.status, 404);
      const hardLimitRejected = await api(
        runtime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/capacity-approvals`,
        {
          headers: { "if-match": '"7"' },
          body: {
            scope: "project_peak",
            scopeId: null,
            approvedLimitBytes: "12884901889",
            expiresAt: capacityExpiry,
          },
        },
      );
      assert.equal(hardLimitRejected.status, 400);
      const capacityApproval = await api(
        runtime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/capacity-approvals`,
        {
          headers: { "if-match": '"7"' },
          body: {
            scope: "project_peak",
            scopeId: null,
            approvedLimitBytes: "11811160064",
            expiresAt: capacityExpiry,
          },
        },
      );
      assert.equal(capacityApproval.status, 201);
      assert.equal(record(capacityApproval.json)["hardLimitBytes"], "12884901888");
      const replayedApproval = await api(
        runtime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/capacity-approvals`,
        {
          headers: { "if-match": '"7"' },
          body: {
            scope: "project_peak",
            scopeId: null,
            approvedLimitBytes: "11811160064",
            expiresAt: capacityExpiry,
          },
        },
      );
      assert.equal(replayedApproval.status, 201);
      assert.equal(record(replayedApproval.json)["reused"], true);
      const staleCapacityApproval = await api(
        runtime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/capacity-approvals`,
        {
          headers: { "if-match": '"6"' },
          body: {
            scope: "project_peak",
            scopeId: null,
            approvedLimitBytes: "11811160064",
            expiresAt: capacityExpiry,
          },
        },
      );
      assert.equal(staleCapacityApproval.status, 409);

      const secondResource = await api(
        runtime,
        editorToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/resources`,
        {
          body: {
            namespace: "commerce.customers",
            apiName: "Customer",
            family: "object_type",
            content: objectTypeContent("Customer", "Customer definition."),
          },
        },
      );
      assert.equal(secondResource.status, 201);
      const firstPage = await api(
        runtime,
        viewerToken,
        "GET",
        `/api/v1/admin/projects/${projectId}/resources?limit=1`,
      );
      assert.equal(firstPage.status, 200);
      const firstPageBody = record(firstPage.json);
      assert.equal(arrayField(firstPageBody, "items").length, 1);
      const cursor = stringField(firstPageBody, "nextCursor");
      const secondPage = await api(
        runtime,
        viewerToken,
        "GET",
        `/api/v1/admin/projects/${projectId}/resources?limit=1&cursor=${encodeURIComponent(cursor)}`,
      );
      assert.equal(secondPage.status, 200);
      assert.equal(arrayField(record(secondPage.json), "items").length, 1);
      const replayedCursor = await api(
        runtime,
        viewerToken,
        "GET",
        `/api/v1/admin/projects/00000000-0000-4000-8000-000000000999/resources?cursor=${encodeURIComponent(cursor)}`,
      );
      assert.equal(replayedCursor.status, 400);

      const viewerRead = await api(
        runtime,
        viewerToken,
        "GET",
        `/api/v1/admin/resources/${resourceId}`,
      );
      assert.equal(viewerRead.status, 200);
      const missingDraftMatch = await api(
        runtime,
        editorToken,
        "PATCH",
        `/api/v1/admin/revisions/${revisionId}`,
        { body: { content: objectTypeContent("Order", "Changed.") } },
      );
      assert.equal(missingDraftMatch.status, 400);
      const viewerWrite = await api(
        runtime,
        viewerToken,
        "PATCH",
        `/api/v1/admin/revisions/${revisionId}`,
        {
          headers: { "if-match": '"1"' },
          body: { content: objectTypeContent("Order", "Viewer change.") },
        },
      );
      assert.equal(viewerWrite.status, 404);
      const patched = await api(
        runtime,
        editorToken,
        "PATCH",
        `/api/v1/admin/revisions/${revisionId}`,
        {
          headers: { "if-match": '"1"' },
          body: { content: objectTypeContent("Order", "Validated definition.") },
        },
      );
      assert.equal(patched.status, 200);
      assert.equal(patched.headers.get("etag"), '"2"');
      const stalePatch = await api(
        runtime,
        editorToken,
        "PATCH",
        `/api/v1/admin/revisions/${revisionId}`,
        {
          headers: { "if-match": '"1"' },
          body: { content: objectTypeContent("Order", "Stale change.") },
        },
      );
      assert.equal(stalePatch.status, 409);
      assert.equal(errorCode(stalePatch), "OBJECT_VERSION_CONFLICT");

      const validation = await api(
        runtime,
        editorToken,
        "POST",
        `/api/v1/admin/revisions/${revisionId}/validate`,
      );
      assert.equal(validation.status, 200);
      assert.equal(record(record(validation.json)["report"])["valid"], true);
      const report = await api(
        runtime,
        viewerToken,
        "GET",
        `/api/v1/admin/revisions/${revisionId}/validation-report`,
      );
      assert.equal(report.status, 200);

      const releaseResponse = await api(
        runtime,
        editorToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/releases`,
        { body: { targetChannelName: "stable", revisionIds: [revisionId] } },
      );
      assert.equal(releaseResponse.status, 201);
      const releaseId = stringField(record(releaseResponse.json), "releaseId");
      assert.equal(
        (await api(runtime, editorToken, "POST", `/api/v1/admin/releases/${releaseId}/validate`))
          .status,
        200,
      );
      assert.equal(
        (await api(runtime, editorToken, "POST", `/api/v1/admin/releases/${releaseId}/stage`))
          .status,
        200,
      );
      const editorPublish = await api(
        runtime,
        editorToken,
        "POST",
        `/api/v1/admin/releases/${releaseId}/publish`,
        { body: { expectedChannelControlSequence: "0" } },
      );
      assert.equal(editorPublish.status, 404);
      const ownerPublish = await api(
        runtime,
        ownerToken,
        "POST",
        `/api/v1/admin/releases/${releaseId}/publish`,
        { body: { expectedChannelControlSequence: "0" } },
      );
      assert.equal(ownerPublish.status, 200);
      assert.equal(record(ownerPublish.json)["channelControlSequence"], "1");
      assert.equal(
        (await api(runtime, viewerToken, "GET", `/api/v1/admin/releases/${releaseId}`)).status,
        200,
      );

      const otherProject = await api(runtime, ownerToken, "POST", "/api/v1/admin/projects", {
        body: { apiName: "Private", displayName: "Private Project" },
      });
      const otherProjectId = stringField(record(record(otherProject.json)["project"]), "projectId");
      const crossProjectJob = await api(
        runtime,
        ownerToken,
        "GET",
        `/api/v1/admin/projects/${otherProjectId}/materialization-jobs/${jobId}`,
      );
      const missingProjectJob = await api(
        runtime,
        ownerToken,
        "GET",
        `/api/v1/admin/projects/${otherProjectId}/materialization-jobs/${randomUUID()}`,
      );
      assert.equal(crossProjectJob.status, 404);
      assert.equal(missingProjectJob.status, 404);
      assert.deepEqual(
        record(crossProjectJob.json)["error"],
        record(missingProjectJob.json)["error"],
      );
      const privateResource = await api(
        runtime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${otherProjectId}/resources`,
        {
          body: {
            namespace: "private.data",
            apiName: "PrivateRecord",
            family: "object_type",
            content: objectTypeContent("PrivateRecord", "Invisible definition."),
          },
        },
      );
      const privateResourceId = stringField(
        record(record(privateResource.json)["resource"]),
        "resourceId",
      );
      const invisible = await api(
        runtime,
        viewerToken,
        "GET",
        `/api/v1/admin/resources/${privateResourceId}`,
      );
      const nonexistent = await api(
        runtime,
        viewerToken,
        "GET",
        "/api/v1/admin/resources/00000000-0000-4000-8000-000000000999",
      );
      assert.equal(invisible.status, 404);
      assert.equal(nonexistent.status, 404);
      assert.equal(errorCode(invisible), errorCode(nonexistent));
      assert.deepEqual(record(invisible.json)["error"], record(nonexistent.json)["error"]);

      const deepBody = { apiName: "Deep", displayName: "Deep", nested: nested(40) };
      const deepRejected = await api(runtime, ownerToken, "POST", "/api/v1/admin/projects", {
        body: deepBody,
      });
      assert.equal(deepRejected.status, 400);

      const identity = await runtime.pool.query<{
        readonly current_user: string;
        readonly session_user: string;
      }>("SELECT current_user, session_user");
      assert.deepEqual(identity.rows[0], {
        current_user: "api_runtime",
        session_user: "api_runtime",
      });
      await assert.rejects(runtime.pool.query("SET ROLE migration_owner"), postgresError("42501"));
      await assert.rejects(
        runtime.pool.query("SELECT * FROM ontos_migration.schema_migrations"),
        postgresError("42501"),
      );

      await runtime.close();
      runtime = null;
      runtime = await startAdminApi(apiConfig, { objectStore: inertObjectStore });
      const afterRestart = await api(
        runtime,
        viewerToken,
        "GET",
        `/api/v1/admin/projects/${projectId}`,
      );
      assert.equal(afterRestart.status, 200);
      assert.equal(
        stringField(record(record(afterRestart.json)["project"]), "projectId"),
        projectId,
      );

      await assert.rejects(
        startAdminApi(
          {
            ...apiConfig,
            databaseUrl: `postgresql://postgres:${adminPassword}@127.0.0.1:${String(port)}/${database}`,
          },
          { objectStore: inertObjectStore },
        ),
        /api_runtime least-privilege boundary/u,
      );
    } finally {
      if (runtime !== null) await runtime.close();
      if (admin !== null) await admin.end();
      await docker(["rm", "--force", "--volumes", containerName], true);
      await oidc.close();
    }
  },
);

const inertObjectStoreConfig = Object.freeze({
  endpoint: "http://127.0.0.1:1",
  region: "us-east-1",
  bucket: "integration-unused",
  accessKeyId: "unused",
  secretAccessKey: "unused",
  forcePathStyle: true,
  maxAttempts: 1,
});

const inertObjectStore = Object.freeze({
  assertVersioningEnabled: () => Promise.resolve(),
  putVersion: () => Promise.reject(new Error("unused")),
  headLatestVersion: () => Promise.reject(new Error("unused")),
  readVersion: () => Promise.reject(new Error("unused")),
  deleteVersion: () => Promise.reject(new Error("unused")),
  deleteUnregisteredVersions: () => Promise.reject(new Error("unused")),
  destroy: () => undefined,
});

interface ApiResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly json: unknown;
  readonly text: string;
}

async function api(
  runtime: RunningAdminApi,
  token: string,
  method: string,
  path: string,
  options: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  } = {},
): Promise<ApiResponse> {
  const response = await fetch(`${runtime.origin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-correlation-id": "corr_g20110-integration-0001",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: JSON.parse(text) as unknown,
  };
}

function errorCode(response: ApiResponse): string {
  return parseErrorEnvelope(response.json).error.code;
}

function objectTypeContent(apiName: string, description: string) {
  const primaryKey = `${apiName.slice(0, 1).toLowerCase()}${apiName.slice(1)}Id`;
  return {
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description,
    primaryKeyPropertyApiName: primaryKey,
    titlePropertyApiName: primaryKey,
    defaultSearchPropertyApiNames: [],
    defaultSort: [{ propertyApiName: primaryKey, direction: "asc" }],
    defaultClassification: "internal",
    properties: [
      {
        schemaVersion: 1,
        apiName: primaryKey,
        displayName: `${apiName} ID`,
        description: "Stable source identifier.",
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
    ],
  };
}

function nested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

async function seedMaterializationAdminFixture(
  admin: pg.Pool,
  input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly resourceId: string;
    readonly revisionId: string;
  },
): Promise<{ readonly snapshotGroupId: string; readonly snapshotId: string }> {
  const snapshotGroupId = randomUUID();
  const snapshotId = randomUUID();
  const fileId = randomUUID();
  const managedArtifactId = randomUUID();
  const schemaResourceId = randomUUID();
  const schemaRevisionId = randomUUID();
  const mappingResourceId = randomUUID();
  const mappingRevisionId = randomUUID();
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO runtime.project_runtime_inventories (
         project_id, state_revision, inventory_revision, measurement_complete, inventory_digest
       ) VALUES ($1::uuid, 7, 7, true, $2)`,
      [input.projectId, digestFor("1")],
    );
    await client.query(
      `INSERT INTO meta.resources (resource_id, project_id, namespace, api_name, family)
       VALUES
         ($1::uuid, $3::uuid, 'admin.http.fixture', 'OrderCsvSchema', 'snapshot_schema'),
         ($2::uuid, $3::uuid, 'admin.http.fixture', 'OrderCsvMapping', 'mapping')`,
      [schemaResourceId, mappingResourceId, input.projectId],
    );
    await client.query(
      `INSERT INTO meta.resource_revisions (
         revision_id, resource_id, revision_number, family, content_digest, content,
         created_by_principal_id
       ) VALUES
         ($1::uuid, $2::uuid, 1, 'snapshot_schema', $5, '{}'::jsonb, $7::uuid),
         ($3::uuid, $4::uuid, 1, 'mapping', $6, '{}'::jsonb, $7::uuid)`,
      [
        schemaRevisionId,
        schemaResourceId,
        mappingRevisionId,
        mappingResourceId,
        digestFor("6"),
        digestFor("7"),
        input.principalId,
      ],
    );
    await client.query(
      `INSERT INTO runtime.snapshot_groups (project_id, snapshot_group_id, group_key)
       VALUES ($1::uuid, $2::uuid, 'admin-http-orders')`,
      [input.projectId, snapshotGroupId],
    );
    await client.query(
      `INSERT INTO runtime.snapshot_group_versions (
         project_id, snapshot_group_id, group_version, member_count, state, group_digest
       ) VALUES ($1::uuid, $2::uuid, 1, 1, 'registered', $3)`,
      [input.projectId, snapshotGroupId, digestFor("2")],
    );
    await client.query(
      `INSERT INTO runtime.dataset_snapshots (
         project_id, snapshot_id, snapshot_group_id, group_version, member_key, member_kind,
         target_resource_id, target_revision_id,
         snapshot_schema_resource_id, snapshot_schema_revision_id,
         mapping_resource_id, mapping_revision_id, runtime_plan_digest,
         content_digest, byte_count, row_count, file_count, state, snapshot_digest
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 1, 'object:Order', 'object',
         $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10,
         $11, 32, 1, 1, 'registered', $12
       )`,
      [
        input.projectId,
        snapshotId,
        snapshotGroupId,
        input.resourceId,
        input.revisionId,
        schemaResourceId,
        schemaRevisionId,
        mappingResourceId,
        mappingRevisionId,
        digestFor("3"),
        digestFor("4"),
        digestFor("5"),
      ],
    );
    await client.query(
      `INSERT INTO runtime.snapshot_files (
         project_id, snapshot_id, file_id, managed_artifact_id, object_version, ordinal,
         content_digest, byte_count, row_count, source_label, scan_status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'fixture-version-1', 0,
                 $5, 32, 1, 'orders.csv', 'complete')`,
      [input.projectId, snapshotId, fileId, managedArtifactId, digestFor("4")],
    );
    await client.query(
      `INSERT INTO runtime.snapshot_group_members (
         project_id, snapshot_group_id, group_version, member_key, member_kind,
         snapshot_id, target_resource_id, target_revision_id
       ) VALUES ($1::uuid, $2::uuid, 1, 'object:Order', 'object', $3::uuid, $4::uuid, $5::uuid)`,
      [input.projectId, snapshotGroupId, snapshotId, input.resourceId, input.revisionId],
    );
    await client.query("COMMIT");
    return Object.freeze({ snapshotGroupId, snapshotId });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function digestFor(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function canonicalFutureInstant(offsetMilliseconds: number): string {
  return new Date(Date.now() + offsetMilliseconds).toISOString().replace(/Z$/u, "000Z");
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

function requiredMap(map: ReadonlyMap<string, string>, key: string): string {
  const value = map.get(key);
  assert.ok(value);
  return value;
}

async function countRows(pool: pg.Pool, table: "authz.principals"): Promise<number> {
  const result = await pool.query<{ readonly count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

function postgresError(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === code;
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
  if (!Number.isInteger(port) || port <= 0) throw new Error("Docker did not publish a valid port.");
  return port;
}

async function docker(arguments_: readonly string[], ignoreFailure = false): Promise<void> {
  try {
    await execFileAsync("docker", [...arguments_]);
  } catch (error) {
    if (!ignoreFailure) throw error;
  }
}
