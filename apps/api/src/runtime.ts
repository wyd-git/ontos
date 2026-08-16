import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";

import { parseArtifactDigest, parseCanonicalInstant } from "@ontos/contracts";
import {
  GarbageCollectionService,
  MaterializationAdminService,
  MaterializationIngressService,
  RowCountConfirmationService,
  RuntimeCompatibilityCoordinator,
  SnapshotGroupCutoverCoordinator,
  type GarbageCollectionCrypto,
  type ManagedSnapshotObjectStore,
  type MaterializationAdminCrypto,
  type MaterializationIngressCrypto,
  type MaterializationQualityCrypto,
} from "@ontos/materialization-application";
import {
  PostgresGarbageCollectionRepository,
  PostgresMaterializationAdminRepository,
  PostgresMaterializationQualityRepository,
  PostgresRuntimeCompatibilityRepository,
  PostgresSnapshotGroupCutoverRepository,
  PostgresSnapshotUploadSessionRepository,
} from "@ontos/materialization-postgres";
import {
  MetadataApplicationService,
  PackageLifecycleApplicationService,
  ReleaseLifecycleApplicationService,
  ResourceLifecycleApplicationService,
  RoleMatrixManagementAuthorizer,
} from "@ontos/metadata-application";
import {
  PostgresMetadataControlPlane,
  PostgresPackageStore,
  PostgresReleaseStore,
  sha256CanonicalText,
} from "@ontos/metadata-postgres";
import pg from "pg";
import { S3ManagedObjectStore } from "@ontos/object-store-s3";

import type { AdminApiConfig } from "./config.ts";
import { AdminCursorCodec } from "./cursor.ts";
import { assertApiRuntimeDatabaseBoundary } from "./database-boundary.ts";
import { OidcAuthenticator } from "./oidc.ts";
import { createAdminRequestHandler } from "./router.ts";

export interface RunningAdminApi {
  readonly origin: string;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export interface AdminApiRuntimeDependencies {
  readonly objectStore?: ManagedSnapshotObjectStore & { destroy(): void };
}

export async function startAdminApi(
  config: AdminApiConfig,
  dependencies: AdminApiRuntimeDependencies = {},
): Promise<RunningAdminApi> {
  const authenticator = await OidcAuthenticator.discover({
    issuer: config.oidc.issuer,
    audience: config.oidc.audience,
    requiredScope: config.oidc.requiredScope,
  });
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    application_name: "ontos-admin-api",
    max: 12,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
  });
  try {
    await assertApiRuntimeDatabaseBoundary(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }

  const metadataStore = new PostgresMetadataControlPlane(pool);
  const releaseStore = new PostgresReleaseStore(pool);
  const packageStore = new PostgresPackageStore(pool);
  const authorizer = new RoleMatrixManagementAuthorizer(metadataStore);
  let objectStore: ManagedSnapshotObjectStore & { destroy(): void };
  try {
    objectStore =
      dependencies.objectStore ??
      new S3ManagedObjectStore({
        endpoint: config.objectStore.endpoint,
        region: config.objectStore.region,
        bucket: config.objectStore.bucket,
        accessKeyId: config.objectStore.accessKeyId,
        secretAccessKey: config.objectStore.secretAccessKey,
        forcePathStyle: config.objectStore.forcePathStyle,
        maxAttempts: config.objectStore.maxAttempts,
      });
  } catch (error) {
    await pool.end();
    throw error;
  }
  const materialization = new MaterializationIngressService({
    principals: metadataStore,
    authorizer,
    repository: new PostgresSnapshotUploadSessionRepository(pool),
    objectStore,
    crypto: nodeMaterializationCrypto,
    clock: { now: canonicalNow },
    monotonicClock: { nowMilliseconds: () => performance.now() },
    maximumUploadBytes: config.managedCsvMaximumBytes,
  });
  const materializationAdmin = new MaterializationAdminService({
    principals: metadataStore,
    authorizer,
    repository: new PostgresMaterializationAdminRepository(pool),
    activation: new SnapshotGroupCutoverCoordinator(
      new PostgresSnapshotGroupCutoverRepository(pool),
    ),
    refresh: new RuntimeCompatibilityCoordinator(new PostgresRuntimeCompatibilityRepository(pool)),
    confirmations: new RowCountConfirmationService({
      principals: metadataStore,
      authorizer,
      repository: new PostgresMaterializationQualityRepository(pool),
      crypto: nodeMaterializationCrypto,
      clock: { now: canonicalNow },
    }),
    garbageCollection: new GarbageCollectionService({
      repository: new PostgresGarbageCollectionRepository(pool),
      crypto: nodeMaterializationCrypto,
      objectStore,
    }),
    crypto: nodeMaterializationCrypto,
    clock: { now: canonicalNow },
  });
  try {
    await materialization.assertReady();
  } catch (error) {
    objectStore.destroy();
    await pool.end();
    throw error;
  }
  const handler = createAdminRequestHandler({
    authenticator,
    cursors: new AdminCursorCodec(config.cursorHmacSecret),
    services: {
      metadata: new MetadataApplicationService({
        principals: metadataStore,
        projects: metadataStore,
        roleBindings: metadataStore,
        authorizer,
      }),
      resources: new ResourceLifecycleApplicationService({
        principals: metadataStore,
        resources: metadataStore,
        authorizer,
      }),
      releases: new ReleaseLifecycleApplicationService({
        principals: metadataStore,
        releases: releaseStore,
        authorizer,
      }),
      packages: new PackageLifecycleApplicationService({
        principals: metadataStore,
        packages: packageStore,
        authorizer,
        digestCanonicalText: sha256CanonicalText,
      }),
      materialization,
      materializationAdmin,
    },
  });
  const server = createServer(handler);
  configureServer(server);
  try {
    await listen(server, config.host, config.port);
  } catch (error) {
    objectStore.destroy();
    await pool.end();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    objectStore.destroy();
    await pool.end();
    throw new Error("Admin API did not bind a TCP address.");
  }
  const cleanup = startCleanupLoop(materialization);
  const originHost = address.address.includes(":") ? `[${address.address}]` : address.address;
  return Object.freeze({
    origin: `http://${originHost}:${String(address.port)}`,
    pool,
    async close() {
      await cleanup.stop();
      try {
        await closeServer(server);
      } finally {
        objectStore.destroy();
        await pool.end();
      }
    },
  });
}

function configureServer(server: Server): void {
  server.requestTimeout = 300_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
}

const nodeMaterializationCrypto: MaterializationIngressCrypto &
  MaterializationAdminCrypto &
  MaterializationQualityCrypto &
  GarbageCollectionCrypto = Object.freeze({
  randomId: randomUUID,
  randomToken: () => randomBytes(32).toString("base64url"),
  digestText: (value: string) =>
    parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`),
  digestCanonicalText: (value: string) =>
    parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`),
  createStreamingDigest: () => {
    const hash = createHash("sha256");
    let finished = false;
    return {
      update(chunk: Uint8Array) {
        if (finished) throw new Error("Managed Snapshot digest has already finished.");
        hash.update(chunk);
      },
      finish() {
        if (finished) throw new Error("Managed Snapshot digest has already finished.");
        finished = true;
        return parseArtifactDigest(`sha256:${hash.digest("hex")}`);
      },
    };
  },
});

function canonicalNow(): ReturnType<typeof parseCanonicalInstant> {
  return parseCanonicalInstant(new Date().toISOString().replace(/\.([0-9]{3})Z$/u, ".$1000Z"));
}

function startCleanupLoop(service: MaterializationIngressService): { stop(): Promise<void> } {
  let current: Promise<void> | null = null;
  let stopped = false;
  const run = (): void => {
    if (current !== null || stopped) return;
    current = service
      .cleanupManagedObjects()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        current = null;
      });
  };
  const timer = setInterval(run, 60_000);
  timer.unref();
  run();
  return Object.freeze({
    async stop() {
      stopped = true;
      clearInterval(timer);
      await current;
    },
  });
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen({ host, port }, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
    server.closeIdleConnections();
  });
}
