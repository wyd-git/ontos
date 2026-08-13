import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const localComposeProject = "ontos-g2-local";
export const localComposeFile = resolve(repositoryRoot, "deploy/local/compose.yaml");
export const localEnvironmentFile = resolve(repositoryRoot, "deploy/local/.env.example");

export const localEndpoints = {
  postgres: { host: "127.0.0.1", port: 15_432 },
  oidc: {
    publicBaseUrl: "http://127.0.0.1:18080",
    managementHealthUrl: "http://127.0.0.1:19090/health/ready",
  },
  s3: { endpoint: "http://127.0.0.1:18333", region: "us-east-1" },
  telemetry: {
    healthUrl: "http://127.0.0.1:13133/",
    metricsUrl: "http://127.0.0.1:18888/metrics",
    otlpHttpTracesUrl: "http://127.0.0.1:14318/v1/traces",
  },
} as const;

const fixedLocalDatabaseRuntimePassword = "local-only-postgres-runtime-secret";

const requiredKeys = [
  "ONTOS_ENVIRONMENT",
  "ONTOS_POSTGRES_DB",
  "ONTOS_POSTGRES_SUPERUSER",
  "ONTOS_POSTGRES_SUPERUSER_PASSWORD",
  "ONTOS_DB_RUNTIME_USER",
  "ONTOS_DB_RUNTIME_PASSWORD",
  "ONTOS_OIDC_REALM",
  "ONTOS_OIDC_CLIENT_ID",
  "ONTOS_OIDC_CLIENT_SECRET",
  "ONTOS_OIDC_ISSUER",
  "ONTOS_OIDC_ADMIN_USERNAME",
  "ONTOS_OIDC_ADMIN_PASSWORD",
  "ONTOS_S3_ACCESS_KEY_ID",
  "ONTOS_S3_SECRET_ACCESS_KEY",
  "ONTOS_S3_BUCKET",
] as const;

const secretKeys = [
  "ONTOS_POSTGRES_SUPERUSER_PASSWORD",
  "ONTOS_DB_RUNTIME_PASSWORD",
  "ONTOS_OIDC_CLIENT_SECRET",
  "ONTOS_OIDC_ADMIN_PASSWORD",
  "ONTOS_S3_ACCESS_KEY_ID",
  "ONTOS_S3_SECRET_ACCESS_KEY",
] as const;

type EnvironmentName = "local" | "production";
type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export interface LocalEnvironmentConfig {
  readonly environment: EnvironmentName;
  readonly postgres: {
    readonly database: string;
    readonly superuser: string;
    readonly superuserPassword: string;
    readonly runtimeUser: string;
    readonly runtimePassword: string;
  };
  readonly oidc: {
    readonly realm: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly issuer: string;
    readonly adminUsername: string;
    readonly adminPassword: string;
  };
  readonly s3: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly bucket: string;
  };
}

export function parseEnvironmentFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [index, rawLine] of contents.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid environment entry on line ${index + 1}.`);
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) {
      throw new Error(`Invalid environment key ${JSON.stringify(key)} on line ${index + 1}.`);
    }
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }

  return result;
}

export async function loadLocalEnvironmentConfig(
  path = localEnvironmentFile,
): Promise<LocalEnvironmentConfig> {
  return validateEnvironment(parseEnvironmentFile(await readFile(path, "utf8")));
}

export function validateEnvironment(source: EnvironmentSource): LocalEnvironmentConfig {
  const values = new Map<string, string>();
  for (const key of requiredKeys) {
    const value = source[key]?.trim();
    if (!value) throw new Error(`Required configuration ${key} is missing.`);
    values.set(key, value);
  }

  const environmentValue = getRequired(values, "ONTOS_ENVIRONMENT");
  if (environmentValue !== "local" && environmentValue !== "production") {
    throw new Error("ONTOS_ENVIRONMENT must be either local or production.");
  }

  if (environmentValue === "production") {
    const unsafeKeys = secretKeys.filter((key) =>
      getRequired(values, key).toLowerCase().includes("local-only-"),
    );
    if (unsafeKeys.length > 0) {
      throw new Error(
        `Production configuration refuses public sample credentials: ${unsafeKeys.join(", ")}.`,
      );
    }
  }

  const realm = getRequired(values, "ONTOS_OIDC_REALM");
  const issuer = getRequired(values, "ONTOS_OIDC_ISSUER");
  const expectedLocalIssuer = `${localEndpoints.oidc.publicBaseUrl}/realms/${realm}`;
  if (environmentValue === "local" && issuer !== expectedLocalIssuer) {
    throw new Error(`Local OIDC issuer must be ${expectedLocalIssuer}.`);
  }

  const runtimeUser = getRequired(values, "ONTOS_DB_RUNTIME_USER");
  if (runtimeUser !== "ontos_smoke_runtime") {
    throw new Error("The local smoke environment requires the isolated ontos_smoke_runtime role.");
  }
  if (
    environmentValue === "local" &&
    getRequired(values, "ONTOS_DB_RUNTIME_PASSWORD") !== fixedLocalDatabaseRuntimePassword
  ) {
    throw new Error("The local database runtime password must match the disposable init fixture.");
  }

  return {
    environment: environmentValue,
    postgres: {
      database: getRequired(values, "ONTOS_POSTGRES_DB"),
      superuser: getRequired(values, "ONTOS_POSTGRES_SUPERUSER"),
      superuserPassword: getRequired(values, "ONTOS_POSTGRES_SUPERUSER_PASSWORD"),
      runtimeUser,
      runtimePassword: getRequired(values, "ONTOS_DB_RUNTIME_PASSWORD"),
    },
    oidc: {
      realm,
      clientId: getRequired(values, "ONTOS_OIDC_CLIENT_ID"),
      clientSecret: getRequired(values, "ONTOS_OIDC_CLIENT_SECRET"),
      issuer,
      adminUsername: getRequired(values, "ONTOS_OIDC_ADMIN_USERNAME"),
      adminPassword: getRequired(values, "ONTOS_OIDC_ADMIN_PASSWORD"),
    },
    s3: {
      accessKeyId: getRequired(values, "ONTOS_S3_ACCESS_KEY_ID"),
      secretAccessKey: getRequired(values, "ONTOS_S3_SECRET_ACCESS_KEY"),
      bucket: getRequired(values, "ONTOS_S3_BUCKET"),
    },
  };
}

export function assertLocalComposeConfiguration(config: LocalEnvironmentConfig): void {
  if (config.environment !== "local") {
    throw new Error("deploy/local/compose.yaml is local-only and refuses non-local startup.");
  }
}

function getRequired(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw new Error(`Internal configuration error for ${key}.`);
  return value;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    if (process.argv[2] !== "--guard") throw new Error("Expected --guard.");
    const config = validateEnvironment(process.env);
    assertLocalComposeConfiguration(config);
    process.stdout.write("Local configuration guard passed.\n");
  } catch (error) {
    process.stderr.write(`Local configuration guard failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
