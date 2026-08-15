export interface MaterializationWorkerConfig {
  readonly databaseUrl: string;
  readonly workerInstanceId: string;
  readonly leaseSeconds: number;
  readonly heartbeatIntervalMilliseconds: number;
  readonly idlePollMilliseconds: number;
  readonly dependencyBackoffMilliseconds: number;
  readonly shutdownGraceMilliseconds: number;
  readonly databasePoolMaximum: number;
}

const forbiddenCredentialKeys = Object.freeze([
  "ONTOS_ADMIN_BEARER_TOKEN",
  "ONTOS_WORKER_BEARER_TOKEN",
  "ONTOS_OIDC_CLIENT_SECRET",
  "ONTOS_MIGRATION_DATABASE_URL",
  "ONTOS_DDL_EXECUTOR_DATABASE_URL",
] as const);

export function loadMaterializationWorkerConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
): MaterializationWorkerConfig {
  for (const key of forbiddenCredentialKeys) {
    if ((source[key]?.trim().length ?? 0) > 0) {
      throw new Error(`Forbidden Worker credential ${key} is present.`);
    }
  }

  const leaseSeconds = boundedInteger(
    source["ONTOS_WORKER_LEASE_SECONDS"] ?? "30",
    "ONTOS_WORKER_LEASE_SECONDS",
    1,
    300,
  );
  const heartbeatIntervalMilliseconds = boundedInteger(
    source["ONTOS_WORKER_HEARTBEAT_MILLISECONDS"] ?? "5000",
    "ONTOS_WORKER_HEARTBEAT_MILLISECONDS",
    100,
    60_000,
  );
  if (heartbeatIntervalMilliseconds * 2 >= leaseSeconds * 1000) {
    throw new Error("ONTOS_WORKER_HEARTBEAT_MILLISECONDS must be less than half the lease.");
  }

  return Object.freeze({
    databaseUrl: required(source, "ONTOS_DATABASE_URL"),
    workerInstanceId: required(source, "ONTOS_WORKER_INSTANCE_ID"),
    leaseSeconds,
    heartbeatIntervalMilliseconds,
    idlePollMilliseconds: boundedInteger(
      source["ONTOS_WORKER_IDLE_POLL_MILLISECONDS"] ?? "250",
      "ONTOS_WORKER_IDLE_POLL_MILLISECONDS",
      25,
      30_000,
    ),
    dependencyBackoffMilliseconds: boundedInteger(
      source["ONTOS_WORKER_DEPENDENCY_BACKOFF_MILLISECONDS"] ?? "1000",
      "ONTOS_WORKER_DEPENDENCY_BACKOFF_MILLISECONDS",
      100,
      60_000,
    ),
    shutdownGraceMilliseconds: boundedInteger(
      source["ONTOS_WORKER_SHUTDOWN_GRACE_MILLISECONDS"] ?? "15000",
      "ONTOS_WORKER_SHUTDOWN_GRACE_MILLISECONDS",
      1_000,
      120_000,
    ),
    databasePoolMaximum: boundedInteger(
      source["ONTOS_WORKER_DATABASE_POOL_MAXIMUM"] ?? "4",
      "ONTOS_WORKER_DATABASE_POOL_MAXIMUM",
      1,
      16,
    ),
  });
}

function required(source: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = source[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Required configuration ${key} is missing.`);
  }
  return value;
}

function boundedInteger(value: string, key: string, minimum: number, maximum: number): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${key} is invalid.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${key} is invalid.`);
  }
  return parsed;
}
