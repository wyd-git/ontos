export interface AdminApiConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly oidc: {
    readonly issuer: string;
    readonly audience: string;
    readonly requiredScope: string;
  };
  readonly cursorHmacSecret: string;
  readonly managedCsvMaximumBytes: number;
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

const managedCsvHardMaximumBytes = 512 * 1024 * 1024;

export function loadAdminApiConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
): AdminApiConfig {
  const portText = source["ONTOS_ADMIN_API_PORT"] ?? "3000";
  if (!/^[1-9][0-9]{0,4}$/u.test(portText)) throw new Error("ONTOS_ADMIN_API_PORT is invalid.");
  const port = Number(portText);
  if (port > 65_535) throw new Error("ONTOS_ADMIN_API_PORT is invalid.");
  const requiredScope = source["ONTOS_OIDC_ADMIN_SCOPE"] ?? "ontos.admin";
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(requiredScope)) {
    throw new Error("ONTOS_OIDC_ADMIN_SCOPE is invalid.");
  }
  const cursorHmacSecret = required(source, "ONTOS_CURSOR_HMAC_SECRET");
  if (Buffer.byteLength(cursorHmacSecret, "utf8") < 32) {
    throw new Error("ONTOS_CURSOR_HMAC_SECRET must contain at least 32 bytes.");
  }
  const managedCsvMaximumBytes = boundedInteger(
    source["ONTOS_MANAGED_CSV_MAXIMUM_BYTES"] ?? String(managedCsvHardMaximumBytes),
    "ONTOS_MANAGED_CSV_MAXIMUM_BYTES",
    1,
    managedCsvHardMaximumBytes,
  );
  const forcePathStyle = booleanValue(
    source["ONTOS_S3_FORCE_PATH_STYLE"] ?? "false",
    "ONTOS_S3_FORCE_PATH_STYLE",
  );
  const maxAttempts = boundedInteger(
    source["ONTOS_S3_MAX_ATTEMPTS"] ?? "2",
    "ONTOS_S3_MAX_ATTEMPTS",
    1,
    5,
  );
  return Object.freeze({
    host: source["ONTOS_ADMIN_API_HOST"] ?? "127.0.0.1",
    port,
    databaseUrl: required(source, "ONTOS_DATABASE_URL"),
    oidc: Object.freeze({
      issuer: required(source, "ONTOS_OIDC_ISSUER"),
      audience: required(source, "ONTOS_OIDC_AUDIENCE"),
      requiredScope,
    }),
    cursorHmacSecret,
    managedCsvMaximumBytes,
    objectStore: Object.freeze({
      endpoint: required(source, "ONTOS_S3_ENDPOINT"),
      region: required(source, "ONTOS_S3_REGION"),
      bucket: required(source, "ONTOS_S3_BUCKET"),
      accessKeyId: required(source, "ONTOS_S3_ACCESS_KEY_ID"),
      secretAccessKey: required(source, "ONTOS_S3_SECRET_ACCESS_KEY"),
      forcePathStyle,
      maxAttempts,
    }),
  });
}

function required(source: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = source[key]?.trim();
  if (value === undefined || value.length === 0)
    throw new Error(`Required configuration ${key} is missing.`);
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
