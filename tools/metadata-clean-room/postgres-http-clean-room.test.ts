import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  canonicalizeContractForDigest,
  canonicalizeManifestForDigest,
  parseErrorEnvelope,
} from "@ontos/contracts";
import pg from "pg";

import { startAdminApi, type RunningAdminApi } from "../../apps/api/src/runtime.ts";
import { loadMigrationDefinitions } from "../database/definitions.ts";
import { databaseMigrationDirectory, runDatabaseMigrations } from "../database/migrator.ts";
import { resolvePostgresTestImage } from "../database/postgres-test-image.ts";
import {
  buildMetadataPackageFixtures,
  type MetadataPackageFixture,
} from "../testkit/metadata-fixtures.ts";
import { startTestOidcProvider } from "../admin-api/oidc-provider.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const postgresImage = resolvePostgresTestImage();
const database = "ontos_g20112";
const adminPassword = "local-only-g20110-admin-secret";
const runtimePassword = "local-only-g20110-runtime-secret";
const cursorSecret = "local-only-g20110-cursor-hmac-secret-value";

void test(
  "G2-01-12 clean-room Metadata control plane closes the real HTTP production loop",
  { timeout: 240_000 },
  async () => {
    const containerName = `ontos-g20112-${process.pid}-${randomUUID().slice(0, 8)}`;
    const oidc = await startTestOidcProvider();
    let containerStarted = false;
    let runtime: RunningAdminApi | null = null;
    let admin: pg.Pool | null = null;
    try {
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
      containerStarted = true;
      const port = await publishedPostgreSqlPort(containerName);
      const adminConfig: pg.ClientConfig = {
        host: "127.0.0.1",
        port,
        database,
        user: "postgres",
        password: adminPassword,
        application_name: "ontos-g2-01-12-admin",
      };
      await waitForPostgreSql(adminConfig);
      const expectedMigrations = await loadMigrationDefinitions(databaseMigrationDirectory);
      const firstMigration = await withClient(adminConfig, async (client) => {
        const result = await runDatabaseMigrations(client);
        await client.query(`ALTER ROLE api_runtime LOGIN PASSWORD '${runtimePassword}'`);
        return result;
      });
      assert.equal(firstMigration.noOp, false);
      assert.deepEqual(
        firstMigration.applied.map(({ fileName }) => fileName),
        expectedMigrations.map(({ fileName }) => fileName),
      );
      assert.equal(firstMigration.serverVersionNum, 160_014);
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
      const invalidToken = await oidc.token({ audience: "wrong-clean-room-audience" });

      const invalidAuthentication = await api(
        runtime,
        invalidToken,
        "POST",
        "/api/v1/admin/projects",
        { body: { apiName: "Rejected", displayName: "Rejected" } },
      );
      assert.equal(invalidAuthentication.status, 401);
      assert.equal(errorCode(invalidAuthentication), "AUTHENTICATION_REQUIRED");
      assert.equal(await countRows(admin, "authz.principals"), 0);

      const projectResponse = await api(runtime, ownerToken, "POST", "/api/v1/admin/projects", {
        body: { apiName: "CleanRoom", displayName: "G2-01 Clean Room" },
      });
      assert.equal(projectResponse.status, 201);
      const projectId = stringField(record(record(projectResponse.json)["project"]), "projectId");
      assert.equal(projectResponse.headers.get("etag"), '"1"');

      for (const token of [editorToken, viewerToken]) {
        const denied = await api(runtime, token, "GET", `/api/v1/admin/projects/${projectId}`);
        assert.equal(denied.status, 404);
      }
      const principalIds = await principalIdsBySubject(admin, oidc.issuer, ["editor", "viewer"]);
      const editorId = requiredMap(principalIds, "editor");
      const viewerId = requiredMap(principalIds, "viewer");

      const editorBinding = await replaceRoleBinding(runtime, ownerToken, projectId, '"1"', {
        targetPrincipalId: editorId,
        role: "editor",
      });
      assert.equal(editorBinding.headers.get("etag"), '"2"');
      const viewerBinding = await replaceRoleBinding(runtime, ownerToken, projectId, '"2"', {
        targetPrincipalId: viewerId,
        role: "viewer",
      });
      assert.equal(viewerBinding.headers.get("etag"), '"3"');

      const baselineContent = objectTypeContent("Order", "Clean-room baseline.");
      const resourceResponse = await api(
        runtime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${projectId}/resources`,
        {
          body: {
            namespace: "clean.orders",
            apiName: "Order",
            family: "object_type",
            content: baselineContent,
          },
        },
      );
      assert.equal(resourceResponse.status, 201);
      const resourceId = stringField(
        record(record(resourceResponse.json)["resource"]),
        "resourceId",
      );
      const baselineRevisionId = stringField(
        record(record(resourceResponse.json)["initialDraft"]),
        "revisionId",
      );

      const resourceOwnerBinding = await replaceRoleBinding(runtime, ownerToken, projectId, '"3"', {
        targetPrincipalId: viewerId,
        role: "owner",
        resourceId,
      });
      assert.equal(resourceOwnerBinding.headers.get("etag"), '"4"');
      const viewerCannotElevate = await api(
        runtime,
        viewerToken,
        "PATCH",
        `/api/v1/admin/revisions/${baselineRevisionId}`,
        {
          headers: { "if-match": '"1"' },
          body: { content: objectTypeContent("Order", "Viewer must not elevate.") },
        },
      );
      assert.equal(viewerCannotElevate.status, 404);
      assert.equal(errorCode(viewerCannotElevate), "OBJECT_NOT_ACCESSIBLE");

      const patchedBaseline = await api(
        runtime,
        editorToken,
        "PATCH",
        `/api/v1/admin/revisions/${baselineRevisionId}`,
        {
          headers: { "if-match": '"1"' },
          body: { content: objectTypeContent("Order", "Validated clean-room baseline.") },
        },
      );
      assert.equal(patchedBaseline.status, 200);
      assert.equal(
        (
          await api(
            runtime,
            editorToken,
            "POST",
            `/api/v1/admin/revisions/${baselineRevisionId}/validate`,
          )
        ).status,
        200,
      );

      const baselineReleaseId = await createAndStageRelease(
        runtime,
        editorToken,
        projectId,
        baselineRevisionId,
        "compatible",
      );
      const editorPublishDenied = await publishRelease(runtime, editorToken, baselineReleaseId, 0);
      assert.equal(editorPublishDenied.status, 404);
      assert.equal(errorCode(editorPublishDenied), "OBJECT_NOT_ACCESSIBLE");
      const baselinePublication = await publishRelease(runtime, ownerToken, baselineReleaseId, 0);
      assert.equal(baselinePublication.status, 200);
      assert.equal(record(baselinePublication.json)["channelControlSequence"], "1");

      const privateProject = await api(runtime, ownerToken, "POST", "/api/v1/admin/projects", {
        body: { apiName: "Private", displayName: "Private Scope" },
      });
      const privateProjectId = stringField(
        record(record(privateProject.json)["project"]),
        "projectId",
      );
      const privateResource = await api(
        runtime,
        ownerToken,
        "POST",
        `/api/v1/admin/projects/${privateProjectId}/resources`,
        {
          body: {
            namespace: "private.records",
            apiName: "PrivateRecord",
            family: "object_type",
            content: objectTypeContent("PrivateRecord", "Invisible Resource."),
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
      assert.deepEqual(record(invisible.json)["error"], record(nonexistent.json)["error"]);

      const compatibleContent = objectTypeContent("Order", "Compatible description update.");
      const compatibleRevisionId = await createAndValidateChild(
        runtime,
        editorToken,
        resourceId,
        baselineRevisionId,
        compatibleContent,
      );
      const compatibleReleaseId = await createAndStageRelease(
        runtime,
        editorToken,
        projectId,
        compatibleRevisionId,
        "compatible",
      );

      const beforeSqlFault = await publicationWorld(admin, projectId, compatibleReleaseId);
      await installChannelFault(admin);
      try {
        const faulted = await publishRelease(runtime, ownerToken, compatibleReleaseId, 1);
        assert.equal(faulted.status, 503);
        assert.equal(errorCode(faulted), "DEPENDENCY_UNAVAILABLE");
        assert.doesNotMatch(faulted.text, /injected|trigger|release_channels/iu);
      } finally {
        await removeChannelFault(admin);
      }
      assert.deepEqual(
        await publicationWorld(admin, projectId, compatibleReleaseId),
        beforeSqlFault,
      );
      const compatiblePublication = await publishRelease(
        runtime,
        ownerToken,
        compatibleReleaseId,
        1,
      );
      assert.equal(compatiblePublication.status, 200);
      assert.equal(record(compatiblePublication.json)["channelControlSequence"], "2");

      const breakingContent = addRequiredProperty(compatibleContent, "requiredValue");
      const breakingRevisionId = await createAndValidateChild(
        runtime,
        editorToken,
        resourceId,
        compatibleRevisionId,
        breakingContent,
      );
      await assertBlockedRelease(runtime, editorToken, projectId, breakingRevisionId, "breaking");

      const conditionalContent = addIndexedNullableProperty(compatibleContent, "indexedNote");
      const conditionalRevisionId = await createAndValidateChild(
        runtime,
        editorToken,
        resourceId,
        compatibleRevisionId,
        conditionalContent,
      );
      await assertBlockedRelease(
        runtime,
        editorToken,
        projectId,
        conditionalRevisionId,
        "conditional",
      );
      assert.equal((await channelSnapshot(admin, projectId)).control_sequence, "2");

      const fixtures = await buildMetadataPackageFixtures(repositoryRoot);
      const commerceFixture = requireValue(fixtures["commerce"]);
      const workFixture = requireValue(fixtures["work-management"]);
      for (const fixture of [commerceFixture, workFixture]) {
        const validated = await api(
          runtime,
          ownerToken,
          "POST",
          "/api/v1/admin/packages/validate",
          {
            body: { projectId, ...packagePayload(fixture) },
          },
        );
        assert.equal(validated.status, 200);
        assert.equal(record(validated.json)["resourceCount"], 1);
      }

      const workInstall = await installPackage(
        runtime,
        ownerToken,
        projectId,
        workFixture,
        "g20112-work-install-0001",
      );
      await stageAndPublishChange(runtime, ownerToken, workInstall, 2);

      const commerceInstall = await installPackage(
        runtime,
        ownerToken,
        projectId,
        commerceFixture,
        "g20112-commerce-install-01",
      );
      await stageAndPublishChange(runtime, ownerToken, commerceInstall, 3);

      const compatibleCommerce = packageVariant(
        commerceFixture,
        "1.1.0",
        "10000000-0000-4000-8000-000000000012",
        (content) => ({ ...content, description: "Compatible Package description update." }),
      );
      const commerceUpgradeResponse = await api(
        runtime,
        ownerToken,
        "POST",
        `/api/v1/admin/package-installations/${commerceInstall.installationId}/upgrade`,
        {
          headers: { "idempotency-key": "g20112-commerce-upgrade-01" },
          body: { targetChannelName: "stable", ...compatibleCommerce },
        },
      );
      assert.equal(commerceUpgradeResponse.status, 202);
      assert.equal(record(commerceUpgradeResponse.json)["accepted"], true);
      const commerceUpgrade = packageChange(commerceUpgradeResponse);
      await stageAndPublishChange(runtime, ownerToken, commerceUpgrade, 4);

      const breakingCommerce = packageVariant(
        commerceFixture,
        "2.0.0",
        "10000000-0000-4000-8000-000000000013",
        (content) => addRequiredProperty(content, "requiredValue"),
      );
      const releaseCountBeforeBreakingPackage = await countRows(admin, "meta.releases");
      const installationBeforeBreaking = await installationSnapshot(
        admin,
        commerceInstall.installationId,
      );
      const breakingUpgrade = await api(
        runtime,
        ownerToken,
        "POST",
        `/api/v1/admin/package-installations/${commerceInstall.installationId}/upgrade`,
        {
          headers: { "idempotency-key": "g20112-commerce-breaking-1" },
          body: { targetChannelName: "stable", ...breakingCommerce },
        },
      );
      assert.equal(breakingUpgrade.status, 202);
      assert.equal(record(breakingUpgrade.json)["accepted"], false);
      assert.equal(record(record(breakingUpgrade.json)["compatibility"])["outcome"], "breaking");
      assert.equal(record(breakingUpgrade.json)["change"], null);
      assert.equal(await countRows(admin, "meta.releases"), releaseCountBeforeBreakingPackage);
      assert.deepEqual(
        await installationSnapshot(admin, commerceInstall.installationId),
        installationBeforeBreaking,
      );

      const immutableIds = {
        revisionIds: [
          baselineRevisionId,
          compatibleRevisionId,
          fixtureRevisionId(workFixture),
          fixtureRevisionId(commerceFixture),
          fixtureRevisionId(compatibleCommerce),
        ],
        releaseIds: [
          baselineReleaseId,
          compatibleReleaseId,
          workInstall.releaseId,
          commerceInstall.releaseId,
          commerceUpgrade.releaseId,
        ],
        packageRevisionIds: [
          workInstall.packageRevisionId,
          commerceInstall.packageRevisionId,
          commerceUpgrade.packageRevisionId,
        ],
      } as const;
      const immutableBeforeRollback = await immutableHashSnapshot(admin, immutableIds);

      const rollbackResponse = await api(
        runtime,
        ownerToken,
        "POST",
        `/api/v1/admin/package-installations/${commerceInstall.installationId}/rollback`,
        {
          headers: { "idempotency-key": "g20112-commerce-rollback-01" },
          body: {
            targetPackageRevisionId: commerceInstall.packageRevisionId,
            targetChannelName: "stable",
          },
        },
      );
      assert.equal(rollbackResponse.status, 202);
      assert.equal(record(rollbackResponse.json)["accepted"], true);
      const commerceRollback = packageChange(rollbackResponse);
      assert.notEqual(commerceRollback.releaseId, commerceInstall.releaseId);
      assert.notEqual(commerceRollback.releaseId, commerceUpgrade.releaseId);
      await stageAndPublishChange(runtime, ownerToken, commerceRollback, 5);
      const rolledBackInstallation = await installationSnapshot(
        admin,
        commerceInstall.installationId,
      );
      assert.equal(
        rolledBackInstallation.active_package_revision_id,
        commerceInstall.packageRevisionId,
      );
      assert.equal(rolledBackInstallation.active_release_id, commerceRollback.releaseId);
      const immutableAfterRollback = await immutableHashSnapshot(admin, immutableIds);
      assert.deepEqual(immutableAfterRollback, immutableBeforeRollback);

      await runtime.close();
      runtime = null;
      runtime = await startAdminApi(apiConfig, { objectStore: inertObjectStore });
      const recoveredProject = await api(
        runtime,
        viewerToken,
        "GET",
        `/api/v1/admin/projects/${projectId}`,
      );
      assert.equal(recoveredProject.status, 200);
      const recoveredRollback = await api(
        runtime,
        viewerToken,
        "GET",
        `/api/v1/admin/releases/${commerceRollback.releaseId}`,
      );
      assert.equal(recoveredRollback.status, 200);
      const immutableAfterRestart = await immutableHashSnapshot(admin, immutableIds);
      assert.deepEqual(immutableAfterRestart, immutableBeforeRollback);

      const secondMigration = await withClient(adminConfig, async (client) =>
        runDatabaseMigrations(client),
      );
      assert.equal(secondMigration.noOp, true);
      assert.equal(secondMigration.applied.length, 0);
      assert.equal(secondMigration.serverVersionNum, 160_014);
      const immutableAfterSecondMigration = await immutableHashSnapshot(admin, immutableIds);
      assert.deepEqual(immutableAfterSecondMigration, immutableBeforeRollback);

      const runtimeIdentity = await runtime.pool.query<{
        readonly current_user: string;
        readonly session_user: string;
      }>("SELECT current_user, session_user");
      assert.deepEqual(runtimeIdentity.rows[0], {
        current_user: "api_runtime",
        session_user: "api_runtime",
      });
      await assert.rejects(runtime.pool.query("SET ROLE migration_owner"), postgresError("42501"));
      await assert.rejects(
        runtime.pool.query("SELECT * FROM ontos_migration.schema_migrations"),
        postgresError("42501"),
      );
      const finalChannel = await channelSnapshot(admin, projectId);
      assert.equal(finalChannel.release_id, commerceRollback.releaseId);
      assert.equal(finalChannel.control_sequence, "6");

      const artifact = {
        schemaVersion: 1,
        gate: "G2-01-12",
        status: "PASS",
        database: { image: postgresImage, serverVersionNum: 160_014 },
        migrations: {
          emptyDatabaseApplied: firstMigration.applied.length,
          secondRunNoOp: secondMigration.noOp,
        },
        security: {
          invalidOidcRejectedBeforePrincipal: true,
          viewerWriteRejected: true,
          resourceRoleElevationRejected: true,
          editorPublishRejected: true,
          invisibleResourceIndistinguishable: true,
          runtimeRoleEscalationRejected: true,
        },
        releases: {
          compatiblePublished: true,
          breakingBlocked: true,
          conditionalBlocked: true,
          sqlFaultPreservedOldPointer: true,
          finalChannelControlSequence: finalChannel.control_sequence,
        },
        packages: {
          domains: ["fixture.commerce", "fixture.work"],
          installPublished: 2,
          compatibleUpgradePublished: true,
          breakingUpgradeBlocked: true,
          rollbackCreatedRelease: commerceRollback.releaseId,
        },
        immutableHashes: {
          beforeRollback: immutableBeforeRollback,
          afterRollback: immutableAfterRollback,
          afterRestart: immutableAfterRestart,
          afterSecondMigration: immutableAfterSecondMigration,
        },
        scenarioStepCount: 24,
      };
      const outputDirectory = join(repositoryRoot, "generated/ci-report");
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        join(outputDirectory, "metadata-clean-room.json"),
        `${JSON.stringify(artifact, null, 2)}\n`,
      );
      process.stdout.write(
        `CI_METADATA_CLEAN_ROOM status=PASS steps=24 hashes=${immutableBeforeRollback.combined}\n`,
      );
    } finally {
      if (runtime !== null) await runtime.close();
      if (admin !== null) await admin.end();
      if (containerStarted) {
        await docker(["rm", "--force", "--volumes", containerName], true);
      }
      await oidc.close();
    }
  },
);

const inertObjectStoreConfig = Object.freeze({
  endpoint: "http://127.0.0.1:1",
  region: "us-east-1",
  bucket: "clean-room-unused",
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

interface PackagePayload {
  readonly manifest: unknown;
  readonly resources: readonly unknown[];
  readonly installInputBindings: readonly unknown[];
}

interface PackageChangeSummary {
  readonly installationId: string;
  readonly packageRevisionId: string;
  readonly releaseId: string;
}

interface ImmutableIds {
  readonly revisionIds: readonly string[];
  readonly releaseIds: readonly string[];
  readonly packageRevisionIds: readonly string[];
}

interface ImmutableHashSnapshot {
  readonly revisions: string;
  readonly releases: string;
  readonly packages: string;
  readonly combined: string;
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
      "x-correlation-id": "corr_g20112-clean-room-0001",
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

async function replaceRoleBinding(
  runtime: RunningAdminApi,
  token: string,
  projectId: string,
  etag: string,
  body: Readonly<Record<string, unknown>>,
): Promise<ApiResponse> {
  const response = await api(
    runtime,
    token,
    "PUT",
    `/api/v1/admin/projects/${projectId}/role-bindings`,
    { headers: { "if-match": etag }, body },
  );
  assert.equal(response.status, 200);
  return response;
}

async function createAndValidateChild(
  runtime: RunningAdminApi,
  token: string,
  resourceId: string,
  sourceRevisionId: string,
  content: Readonly<Record<string, unknown>>,
): Promise<string> {
  const created = await api(
    runtime,
    token,
    "POST",
    `/api/v1/admin/resources/${resourceId}/revisions`,
    { body: { sourceRevisionId, content } },
  );
  assert.equal(created.status, 201);
  const revisionId = stringField(record(created.json), "revisionId");
  const validation = await api(
    runtime,
    token,
    "POST",
    `/api/v1/admin/revisions/${revisionId}/validate`,
  );
  assert.equal(validation.status, 200);
  assert.equal(record(record(validation.json)["report"])["valid"], true);
  return revisionId;
}

async function createAndStageRelease(
  runtime: RunningAdminApi,
  token: string,
  projectId: string,
  revisionId: string,
  expectedOutcome: "compatible",
): Promise<string> {
  const created = await api(
    runtime,
    token,
    "POST",
    `/api/v1/admin/projects/${projectId}/releases`,
    { body: { targetChannelName: "stable", revisionIds: [revisionId] } },
  );
  assert.equal(created.status, 201);
  const releaseId = stringField(record(created.json), "releaseId");
  const validation = await api(
    runtime,
    token,
    "POST",
    `/api/v1/admin/releases/${releaseId}/validate`,
  );
  assert.equal(validation.status, 200);
  assert.equal(record(record(validation.json)["compatibility"])["outcome"], expectedOutcome);
  const staged = await api(runtime, token, "POST", `/api/v1/admin/releases/${releaseId}/stage`);
  assert.equal(staged.status, 200);
  assert.equal(record(staged.json)["staged"], true);
  return releaseId;
}

async function assertBlockedRelease(
  runtime: RunningAdminApi,
  token: string,
  projectId: string,
  revisionId: string,
  expectedOutcome: "breaking" | "conditional",
): Promise<void> {
  const created = await api(
    runtime,
    token,
    "POST",
    `/api/v1/admin/projects/${projectId}/releases`,
    { body: { targetChannelName: "stable", revisionIds: [revisionId] } },
  );
  assert.equal(created.status, 201);
  const releaseId = stringField(record(created.json), "releaseId");
  const validation = await api(
    runtime,
    token,
    "POST",
    `/api/v1/admin/releases/${releaseId}/validate`,
  );
  assert.equal(validation.status, 200);
  assert.equal(record(record(validation.json)["compatibility"])["outcome"], expectedOutcome);
  const staged = await api(runtime, token, "POST", `/api/v1/admin/releases/${releaseId}/stage`);
  assert.equal(staged.status, 200);
  assert.equal(record(staged.json)["staged"], false);
}

function publishRelease(
  runtime: RunningAdminApi,
  token: string,
  releaseId: string,
  expectedSequence: number,
): Promise<ApiResponse> {
  return api(runtime, token, "POST", `/api/v1/admin/releases/${releaseId}/publish`, {
    body: { expectedChannelControlSequence: String(expectedSequence) },
  });
}

async function installPackage(
  runtime: RunningAdminApi,
  token: string,
  projectId: string,
  fixture: MetadataPackageFixture,
  requestKey: string,
): Promise<PackageChangeSummary> {
  const response = await api(
    runtime,
    token,
    "POST",
    `/api/v1/admin/projects/${projectId}/package-installations`,
    {
      headers: { "idempotency-key": requestKey },
      body: { targetChannelName: "stable", ...packagePayload(fixture) },
    },
  );
  assert.equal(response.status, 202);
  assert.equal(record(response.json)["accepted"], true);
  return packageChange(response);
}

function packageChange(response: ApiResponse): PackageChangeSummary {
  const change = record(record(response.json)["change"]);
  return {
    installationId: stringField(change, "installationId"),
    packageRevisionId: stringField(change, "packageRevisionId"),
    releaseId: stringField(change, "releaseId"),
  };
}

async function stageAndPublishChange(
  runtime: RunningAdminApi,
  token: string,
  change: PackageChangeSummary,
  expectedSequence: number,
): Promise<void> {
  const staged = await api(
    runtime,
    token,
    "POST",
    `/api/v1/admin/releases/${change.releaseId}/stage`,
  );
  assert.equal(staged.status, 200);
  assert.equal(record(staged.json)["staged"], true);
  const published = await publishRelease(runtime, token, change.releaseId, expectedSequence);
  assert.equal(published.status, 200);
  assert.equal(record(published.json)["channelControlSequence"], String(expectedSequence + 1));
}

function packagePayload(fixture: MetadataPackageFixture): PackagePayload {
  return {
    manifest: fixture.manifest,
    resources: fixture.resources,
    installInputBindings: fixture.installInputBindings,
  };
}

function packageVariant(
  fixture: MetadataPackageFixture,
  version: string,
  revisionId: string,
  mutateContent: (content: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
): PackagePayload {
  const manifest = mutableRecord(structuredClone(fixture.manifest));
  const resources = structuredClone(fixture.resources) as unknown[];
  assert.equal(resources.length, 1);
  const resource = mutableRecord(resources[0]);
  const content = mutateContent(record(resource["content"]));
  resource["revisionId"] = revisionId;
  resource["content"] = content;
  const entries = arrayField(manifest, "resourceEntries");
  assert.equal(entries.length, 1);
  const entry = mutableRecord(entries[0]);
  entry["revisionId"] = revisionId;
  entry["contentDigest"] = digestCanonical(content);
  manifest["version"] = version;
  manifest["manifestDigest"] = `sha256:${"0".repeat(64)}`;
  manifest["manifestDigest"] = digestText(canonicalizeManifestForDigest(manifest));
  return {
    manifest,
    resources,
    installInputBindings: structuredClone(fixture.installInputBindings),
  };
}

function fixtureRevisionId(fixture: MetadataPackageFixture | PackagePayload): string {
  const entries = arrayField(record(fixture.manifest), "resourceEntries");
  return stringField(record(entries[0]), "revisionId");
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
    properties: [propertyDefinition(primaryKey, false, true)],
  };
}

function addRequiredProperty(
  content: Readonly<Record<string, unknown>>,
  apiName: string,
): Readonly<Record<string, unknown>> {
  return {
    ...content,
    properties: [...arrayField(content, "properties"), propertyDefinition(apiName, false, false)],
  };
}

function addIndexedNullableProperty(
  content: Readonly<Record<string, unknown>>,
  apiName: string,
): Readonly<Record<string, unknown>> {
  return {
    ...content,
    properties: [...arrayField(content, "properties"), propertyDefinition(apiName, true, false)],
  };
}

function propertyDefinition(apiName: string, nullable: boolean, primaryKey: boolean) {
  return {
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `${apiName} clean-room property.`,
    valueType: "string",
    caseSensitive: true,
    nullable,
    writeMode: "source_only",
    unique: primaryKey,
    filterable: true,
    sortable: primaryKey,
    searchable: false,
    classification: "internal",
  };
}

async function installChannelFault(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE FUNCTION meta.g20112_fail_channel_update() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected clean-room channel fault' USING ERRCODE = 'XX000';
    END
    $$;
    CREATE TRIGGER g20112_fail_channel_update
    BEFORE UPDATE ON meta.release_channels
    FOR EACH ROW EXECUTE FUNCTION meta.g20112_fail_channel_update()`);
}

async function removeChannelFault(pool: pg.Pool): Promise<void> {
  await pool.query(`
    DROP TRIGGER IF EXISTS g20112_fail_channel_update ON meta.release_channels;
    DROP FUNCTION IF EXISTS meta.g20112_fail_channel_update()`);
}

async function publicationWorld(
  pool: pg.Pool,
  projectId: string,
  candidateReleaseId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const release = await pool.query<{ readonly state: string }>(
    "SELECT state FROM meta.releases WHERE release_id = $1",
    [candidateReleaseId],
  );
  const counts = await pool.query<{
    readonly activation_count: number;
    readonly serving_head_count: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM meta.runtime_activations WHERE release_id = $1)
         AS activation_count,
       (SELECT count(*)::integer FROM meta.release_serving_heads WHERE release_id = $1)
         AS serving_head_count`,
    [candidateReleaseId],
  );
  return {
    candidateState: requireValue(release.rows[0]).state,
    ...requireValue(counts.rows[0]),
    channel: await channelSnapshot(pool, projectId),
  };
}

async function channelSnapshot(pool: pg.Pool, projectId: string) {
  const result = await pool.query<{
    readonly release_id: string;
    readonly activation_id: string;
    readonly control_sequence: string;
  }>(
    `SELECT release_id, activation_id, control_sequence::text
     FROM meta.release_channels
     WHERE project_id = $1 AND channel_name = 'stable'`,
    [projectId],
  );
  return requireValue(result.rows[0]);
}

async function installationSnapshot(pool: pg.Pool, installationId: string) {
  const result = await pool.query<{
    readonly active_package_revision_id: string | null;
    readonly active_release_id: string | null;
    readonly control_sequence: string;
  }>(
    `SELECT active_package_revision_id, active_release_id, control_sequence::text
     FROM meta.package_installations
     WHERE installation_id = $1`,
    [installationId],
  );
  return requireValue(result.rows[0]);
}

async function immutableHashSnapshot(
  pool: pg.Pool,
  ids: ImmutableIds,
): Promise<ImmutableHashSnapshot> {
  const revisions = await pool.query<{
    readonly revision_id: string;
    readonly content_digest: string;
    readonly content: unknown;
  }>(
    `SELECT revision_id, content_digest, content
     FROM meta.resource_revisions
     WHERE revision_id = ANY($1::uuid[])
     ORDER BY revision_id`,
    [ids.revisionIds],
  );
  assert.equal(revisions.rows.length, ids.revisionIds.length);

  const releases = await pool.query<{
    readonly release_id: string;
    readonly manifest_digest: string;
    readonly pin_order: number;
    readonly resource_id: string;
    readonly revision_id: string;
    readonly content_digest: string;
  }>(
    `SELECT release.release_id, release.manifest_digest,
            pin.pin_order, pin.resource_id, pin.revision_id, pin.content_digest
     FROM meta.releases AS release
     JOIN meta.release_pins AS pin ON pin.release_id = release.release_id
     WHERE release.release_id = ANY($1::uuid[])
     ORDER BY release.release_id, pin.pin_order`,
    [ids.releaseIds],
  );
  assert.equal(
    new Set(releases.rows.map(({ release_id }) => release_id)).size,
    ids.releaseIds.length,
  );

  const packages = await pool.query<{
    readonly package_revision_id: string;
    readonly manifest_digest: string;
    readonly manifest: unknown;
  }>(
    `SELECT package_revision_id, manifest_digest, manifest
     FROM meta.package_revisions
     WHERE package_revision_id = ANY($1::uuid[])
     ORDER BY package_revision_id`,
    [ids.packageRevisionIds],
  );
  assert.equal(packages.rows.length, ids.packageRevisionIds.length);

  const snapshot = {
    revisions: digestJson(revisions.rows),
    releases: digestJson(releases.rows),
    packages: digestJson(packages.rows),
  };
  return { ...snapshot, combined: digestJson(snapshot) };
}

async function principalIdsBySubject(
  pool: pg.Pool,
  issuer: string,
  subjects: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const result = await pool.query<{
    readonly principal_id: string;
    readonly oidc_subject: string;
  }>(
    `SELECT principal_id, oidc_subject
     FROM authz.principals
     WHERE oidc_issuer = $1 AND oidc_subject = ANY($2::text[])`,
    [issuer, subjects],
  );
  return new Map(result.rows.map(({ oidc_subject, principal_id }) => [oidc_subject, principal_id]));
}

async function countRows(
  pool: pg.Pool,
  table: "authz.principals" | "meta.releases",
): Promise<number> {
  const result = await pool.query<{ readonly count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}`,
  );
  return Number(requireValue(result.rows[0]).count);
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

function mutableRecord(value: unknown): Record<string, unknown> {
  return record(value);
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  assert.equal(typeof field, "string");
  return field as string;
}

function arrayField(value: Readonly<Record<string, unknown>>, key: string): unknown[] {
  const field = value[key];
  assert.ok(Array.isArray(field));
  return field;
}

function requiredMap(map: ReadonlyMap<string, string>, key: string): string {
  return requireValue(map.get(key));
}

function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected value was not present.");
  return value;
}

function digestCanonical(value: unknown): string {
  return digestText(canonicalizeContractForDigest(value));
}

function digestJson(value: unknown): string {
  return digestText(JSON.stringify(value));
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
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
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw new Error("PostgreSQL clean-room container did not become ready.", { cause: lastError });
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
