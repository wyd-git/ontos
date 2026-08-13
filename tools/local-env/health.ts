import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

import { localEndpoints, type LocalEnvironmentConfig } from "./config.ts";

const { Client } = pg;

interface ProbeResult {
  readonly name: string;
  readonly healthy: boolean;
  readonly detail: string;
}

interface WaitOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

export async function probeEnvironment(
  config: LocalEnvironmentConfig,
): Promise<readonly ProbeResult[]> {
  const probes: ReadonlyArray<readonly [string, () => Promise<void>]> = [
    ["PostgreSQL", () => probePostgres(config)],
    ["S3", () => probeS3(config)],
    ["OIDC discovery", () => probeOidc(config)],
    ["OIDC health", probeOidcHealth],
    ["OpenTelemetry", probeTelemetry],
  ];

  return Promise.all(
    probes.map(async ([name, probe]) => {
      try {
        await probe();
        return { name, healthy: true, detail: "ready" };
      } catch (error) {
        return { name, healthy: false, detail: errorMessage(error) };
      }
    }),
  );
}

export async function waitForEnvironment(
  config: LocalEnvironmentConfig,
  options: WaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let latest: readonly ProbeResult[] = [];

  while (Date.now() <= deadline) {
    latest = await probeEnvironment(config);
    if (latest.every((result) => result.healthy)) {
      printProbeResults(latest);
      return;
    }
    await delay(intervalMs);
  }

  printProbeResults(latest);
  throw new Error(`Local dependencies did not become healthy within ${timeoutMs} ms.`);
}

export async function assertEnvironmentHealthy(config: LocalEnvironmentConfig): Promise<void> {
  const results = await probeEnvironment(config);
  printProbeResults(results);
  const failed = results.filter((result) => !result.healthy);
  if (failed.length > 0) {
    throw new Error(`Unhealthy local dependencies: ${failed.map((item) => item.name).join(", ")}.`);
  }
}

async function probePostgres(config: LocalEnvironmentConfig): Promise<void> {
  const client = new Client({
    host: localEndpoints.postgres.host,
    port: localEndpoints.postgres.port,
    database: config.postgres.database,
    user: config.postgres.runtimeUser,
    password: config.postgres.runtimePassword,
    connectionTimeoutMillis: 2_000,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function probeS3(config: LocalEnvironmentConfig): Promise<void> {
  const client = createS3Client(config);
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
  } finally {
    client.destroy();
  }
}

async function probeOidc(config: LocalEnvironmentConfig): Promise<void> {
  const response = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const discovery: unknown = await response.json();
  if (!isRecord(discovery) || discovery.issuer !== config.oidc.issuer) {
    throw new Error("issuer mismatch");
  }
  if (typeof discovery.jwks_uri !== "string") throw new Error("jwks_uri missing");
}

async function probeOidcHealth(): Promise<void> {
  const response = await fetch(localEndpoints.oidc.managementHealthUrl, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

async function probeTelemetry(): Promise<void> {
  const response = await fetch(localEndpoints.telemetry.healthUrl, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export function createS3Client(config: LocalEnvironmentConfig): S3Client {
  return new S3Client({
    endpoint: localEndpoints.s3.endpoint,
    region: localEndpoints.s3.region,
    forcePathStyle: true,
    maxAttempts: 1,
    requestHandler: { requestTimeout: 2_000, connectionTimeout: 2_000 },
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
  });
}

function printProbeResults(results: readonly ProbeResult[]): void {
  for (const result of results) {
    process.stdout.write(`${result.healthy ? "PASS" : "FAIL"} ${result.name}: ${result.detail}\n`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
