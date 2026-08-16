export interface MaterializationWorkerConfig {
  readonly databaseUrl: string;
  readonly workerInstanceId: string;
  readonly leaseSeconds: number;
  readonly heartbeatIntervalMilliseconds: number;
  readonly idlePollMilliseconds: number;
  readonly dependencyBackoffMilliseconds: number;
  readonly shutdownGraceMilliseconds: number;
  readonly databasePoolMaximum: number;
  readonly databaseStatementTimeoutMilliseconds: number;
  readonly databaseQueryTimeoutMilliseconds: number;
}

export interface ProductionMaterializationWorkerConfig extends MaterializationWorkerConfig {
  readonly objectStore: {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
    readonly maxAttempts: number;
  };
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
  const databaseStatementTimeoutMilliseconds = boundedInteger(
    source["ONTOS_WORKER_DATABASE_STATEMENT_TIMEOUT_MILLISECONDS"] ?? "900000",
    "ONTOS_WORKER_DATABASE_STATEMENT_TIMEOUT_MILLISECONDS",
    1_000,
    1_795_000,
  );
  const databaseQueryTimeoutMilliseconds = boundedInteger(
    source["ONTOS_WORKER_DATABASE_QUERY_TIMEOUT_MILLISECONDS"] ?? "905000",
    "ONTOS_WORKER_DATABASE_QUERY_TIMEOUT_MILLISECONDS",
    1_001,
    1_800_000,
  );
  if (databaseQueryTimeoutMilliseconds <= databaseStatementTimeoutMilliseconds) {
    throw new Error(
      "ONTOS_WORKER_DATABASE_QUERY_TIMEOUT_MILLISECONDS must exceed the statement timeout.",
    );
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
    databaseStatementTimeoutMilliseconds,
    databaseQueryTimeoutMilliseconds,
  });
}

export function loadProductionMaterializationWorkerConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
): ProductionMaterializationWorkerConfig {
  const worker = loadMaterializationWorkerConfig(source);
  return Object.freeze({
    ...worker,
    objectStore: Object.freeze({
      endpoint: required(source, "ONTOS_S3_ENDPOINT"),
      region: required(source, "ONTOS_S3_REGION"),
      bucket: required(source, "ONTOS_S3_BUCKET"),
      accessKeyId: required(source, "ONTOS_S3_ACCESS_KEY_ID"),
      secretAccessKey: required(source, "ONTOS_S3_SECRET_ACCESS_KEY"),
      forcePathStyle: booleanValue(
        source["ONTOS_S3_FORCE_PATH_STYLE"] ?? "false",
        "ONTOS_S3_FORCE_PATH_STYLE",
      ),
      maxAttempts: boundedInteger(
        source["ONTOS_S3_MAX_ATTEMPTS"] ?? "2",
        "ONTOS_S3_MAX_ATTEMPTS",
        1,
        5,
      ),
    }),
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

function booleanValue(value: string, key: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${key} is invalid.`);
}
