import { createServer, type Server } from "node:http";

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

export async function startAdminApi(config: AdminApiConfig): Promise<RunningAdminApi> {
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
    },
  });
  const server = createServer(handler);
  configureServer(server);
  try {
    await listen(server, config.host, config.port);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    await pool.end();
    throw new Error("Admin API did not bind a TCP address.");
  }
  const originHost = address.address.includes(":") ? `[${address.address}]` : address.address;
  return Object.freeze({
    origin: `http://${originHost}:${String(address.port)}`,
    pool,
    async close() {
      await closeServer(server);
      await pool.end();
    },
  });
}

function configureServer(server: Server): void {
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
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
