import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";

import { parseErrorEnvelope } from "@ontos/contracts";
import pg from "pg";

import { startAdminApi, type RunningAdminApi } from "../../../apps/api/src/runtime.ts";
import { runDatabaseMigrations } from "../../database/migrator.ts";
import { startTestOidcProvider } from "../oidc-provider.ts";

const execFileAsync = promisify(execFile);
const postgresImage =
  "postgres:16.14-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8";
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
      } as const;
      runtime = await startAdminApi(apiConfig);

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
      runtime = await startAdminApi(apiConfig);
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
        startAdminApi({
          ...apiConfig,
          databaseUrl: `postgresql://postgres:${adminPassword}@127.0.0.1:${String(port)}/${database}`,
        }),
        /api_runtime least-privilege boundary/u,
      );
    } finally {
      if (runtime !== null) await runtime.close();
      if (admin !== null) await admin.end();
      await docker(["stop", containerName], true);
      await oidc.close();
    }
  },
);

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
