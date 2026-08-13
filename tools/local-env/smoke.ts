import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createRemoteJWKSet, jwtVerify } from "jose";
import pg, { type QueryResultRow } from "pg";

import {
  assertLocalComposeConfiguration,
  loadLocalEnvironmentConfig,
  localEndpoints,
  type LocalEnvironmentConfig,
} from "./config.ts";
import { assertEnvironmentHealthy, createS3Client } from "./health.ts";

const { Client } = pg;

interface RoleRow extends QueryResultRow {
  readonly current_user: string;
  readonly rolsuper: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
}

interface ContentRow extends QueryResultRow {
  readonly content: string;
}

interface SmokeSummary {
  readonly oidc: { readonly issuer: string; readonly audience: string };
  readonly s3: {
    readonly bucket: string;
    readonly objectRoundTrip: true;
    readonly invalidCredentialsDenied: true;
  };
  readonly postgres: { readonly role: string; readonly ownerEscalationDenied: true };
  readonly telemetry: { readonly traceId: string; readonly acceptedSpanDelta: number };
}

export async function runSmokeSuite(): Promise<SmokeSummary> {
  const config = await loadLocalEnvironmentConfig();
  assertLocalComposeConfiguration(config);
  await assertEnvironmentHealthy(config);

  const oidc = await smokeOidc(config);
  process.stdout.write("PASS OIDC token signature, issuer, and audience\n");

  const s3 = await smokeS3(config);
  process.stdout.write(
    "PASS S3 temporary object write, read, delete, and invalid-credential denial\n",
  );

  const postgres = await smokePostgres(config);
  process.stdout.write("PASS PostgreSQL non-owner access and privilege denial\n");

  const telemetry = await smokeTelemetry();
  process.stdout.write("PASS OpenTelemetry OTLP trace ingestion\n");

  return { oidc, s3, postgres, telemetry };
}

async function smokeOidc(config: LocalEnvironmentConfig): Promise<SmokeSummary["oidc"]> {
  const discoveryResponse = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!discoveryResponse.ok) {
    throw new Error(`OIDC discovery failed with HTTP ${discoveryResponse.status}.`);
  }
  const discovery: unknown = await discoveryResponse.json();
  if (!isRecord(discovery)) throw new Error("OIDC discovery response is not an object.");
  if (discovery.issuer !== config.oidc.issuer) throw new Error("OIDC discovery issuer mismatch.");
  if (typeof discovery.token_endpoint !== "string" || typeof discovery.jwks_uri !== "string") {
    throw new Error("OIDC discovery response lacks token_endpoint or jwks_uri.");
  }

  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!tokenResponse.ok) {
    throw new Error(`OIDC token request failed with HTTP ${tokenResponse.status}.`);
  }
  const tokenBody: unknown = await tokenResponse.json();
  if (!isRecord(tokenBody) || typeof tokenBody.access_token !== "string") {
    throw new Error("OIDC token response lacks access_token.");
  }

  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  const verified = await jwtVerify(tokenBody.access_token, jwks, {
    issuer: config.oidc.issuer,
    audience: config.oidc.clientId,
  });
  assert.notEqual(verified.protectedHeader.alg, "none");

  return { issuer: config.oidc.issuer, audience: config.oidc.clientId };
}

async function smokeS3(config: LocalEnvironmentConfig): Promise<SmokeSummary["s3"]> {
  const client = createS3Client(config);
  const key = `smoke/${randomUUID()}.txt`;
  const expected = `ontos-s3-smoke-${randomUUID()}`;
  let objectWritten = false;

  try {
    await client.send(new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, Body: expected }));
    objectWritten = true;
    const response = await client.send(
      new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
    );
    const actual = await response.Body?.transformToString();
    assert.equal(actual, expected);
    await expectS3CredentialsDenied(config);
  } finally {
    if (objectWritten) await deleteObject(client, config.s3.bucket, key);
    client.destroy();
  }

  return {
    bucket: config.s3.bucket,
    objectRoundTrip: true,
    invalidCredentialsDenied: true,
  };
}

async function deleteObject(client: S3Client, bucket: string, key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function expectS3CredentialsDenied(config: LocalEnvironmentConfig): Promise<void> {
  const unauthorizedClient = new S3Client({
    endpoint: localEndpoints.s3.endpoint,
    region: localEndpoints.s3.region,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: "invalid-local-access-key",
      secretAccessKey: "invalid-local-secret-key",
    },
  });
  try {
    await unauthorizedClient.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
  } catch (error) {
    if (isRecord(error) && isRecord(error.$metadata) && error.$metadata.httpStatusCode === 403) {
      return;
    }
    throw error;
  } finally {
    unauthorizedClient.destroy();
  }
  throw new Error("S3 accepted invalid credentials.");
}

async function smokePostgres(config: LocalEnvironmentConfig): Promise<SmokeSummary["postgres"]> {
  const client = new Client({
    host: localEndpoints.postgres.host,
    port: localEndpoints.postgres.port,
    database: config.postgres.database,
    user: config.postgres.runtimeUser,
    password: config.postgres.runtimePassword,
    connectionTimeoutMillis: 5_000,
  });
  const objectId = randomUUID();
  const content = `ontos-db-smoke-${randomUUID()}`;

  try {
    await client.connect();
    const roleResult = await client.query<RoleRow>(
      `SELECT current_user, rolsuper, rolcreatedb, rolcreaterole
         FROM pg_roles
        WHERE rolname = current_user`,
    );
    const role = roleResult.rows[0];
    assert.ok(role);
    assert.equal(role.current_user, config.postgres.runtimeUser);
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolcreatedb, false);
    assert.equal(role.rolcreaterole, false);

    await client.query(
      "INSERT INTO ontos_smoke.object_probe (object_id, content) VALUES ($1, $2)",
      [objectId, content],
    );
    const contentResult = await client.query<ContentRow>(
      "SELECT content FROM ontos_smoke.object_probe WHERE object_id = $1",
      [objectId],
    );
    assert.equal(contentResult.rows[0]?.content, content);
    await client.query("DELETE FROM ontos_smoke.object_probe WHERE object_id = $1", [objectId]);

    await expectPermissionDenied(() => client.query("SET ROLE ontos_smoke_owner"));
    await expectPermissionDenied(() => client.query("CREATE SCHEMA ontos_smoke_forbidden"));

    return { role: role.current_user, ownerEscalationDenied: true };
  } finally {
    await client
      .query("DELETE FROM ontos_smoke.object_probe WHERE object_id = $1", [objectId])
      .catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function expectPermissionDenied(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (isRecord(error) && error.code === "42501") return;
    throw error;
  }
  throw new Error("A forbidden PostgreSQL operation unexpectedly succeeded.");
}

async function smokeTelemetry(): Promise<SmokeSummary["telemetry"]> {
  const baseline = await readAcceptedSpanCount();
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const start = BigInt(Date.now()) * 1_000_000n;
  const end = start + 1_000_000n;
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "ontos-local-smoke" } }],
        },
        scopeSpans: [
          {
            scope: { name: "ontos.local-environment-smoke" },
            spans: [
              {
                traceId,
                spanId,
                name: "local-production-boundary-smoke",
                kind: 1,
                startTimeUnixNano: start.toString(),
                endTimeUnixNano: end.toString(),
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };

  const response = await fetch(localEndpoints.telemetry.otlpHttpTracesUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`OTLP trace export failed with HTTP ${response.status}.`);

  const accepted = await waitForAcceptedSpanCount(baseline, 15_000);
  return { traceId, acceptedSpanDelta: accepted - baseline };
}

async function waitForAcceptedSpanCount(baseline: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let current = baseline;
  while (Date.now() <= deadline) {
    current = await readAcceptedSpanCount();
    if (current > baseline) return current;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(
    `Collector accepted-span metric did not increase (baseline ${baseline}, latest ${current}).`,
  );
}

async function readAcceptedSpanCount(): Promise<number> {
  const response = await fetch(localEndpoints.telemetry.metricsUrl, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Collector metrics failed with HTTP ${response.status}.`);
  const metrics = await response.text();
  let total = 0;
  for (const line of metrics.split("\n")) {
    const match =
      /^otelcol_receiver_accepted_spans(?:_total)?(?:\{[^}]*\})?\s+([0-9.eE+-]+)$/u.exec(line);
    if (match?.[1] !== undefined) total += Number(match[1]);
  }
  return total;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    const summary = await runSmokeSuite();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Local smoke suite failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
