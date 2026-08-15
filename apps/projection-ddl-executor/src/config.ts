export interface ProjectionDdlExecutorConfig {
  readonly databaseUrl: string;
}

const forbiddenDatabaseVariables = Object.freeze([
  "ONTOS_DATABASE_URL",
  "ONTOS_API_DATABASE_URL",
  "ONTOS_WORKER_DATABASE_URL",
  "ONTOS_MIGRATION_DATABASE_URL",
] as const);

export function loadProjectionDdlExecutorConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProjectionDdlExecutorConfig {
  const databaseUrl = environment.ONTOS_PROJECTION_DDL_DATABASE_URL;
  if (
    databaseUrl === undefined ||
    databaseUrl.trim() === "" ||
    forbiddenDatabaseVariables.some((name) => environment[name] !== undefined)
  ) {
    throw new Error("Projection DDL Executor configuration is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Projection DDL Executor configuration is invalid.");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.username === "" ||
    parsed.password === "" ||
    parsed.hostname === ""
  ) {
    throw new Error("Projection DDL Executor configuration is invalid.");
  }
  return Object.freeze({ databaseUrl });
}
