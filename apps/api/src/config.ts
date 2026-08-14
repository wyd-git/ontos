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
}

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
  });
}

function required(source: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = source[key]?.trim();
  if (value === undefined || value.length === 0)
    throw new Error(`Required configuration ${key} is missing.`);
  return value;
}
