import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { invariant } from "../core/kernel-error.js";

export const DEFAULT_DATABASE_URL = "postgresql://ontology_spike:ontology_spike@127.0.0.1:55432/ontology_spike";

export function explainCompiled(compiled, {
  databaseUrl = process.env.ONTOLOGY_SPIKE_DATABASE_URL ?? DEFAULT_DATABASE_URL,
} = {}) {
  const args = compiled.values.map((value, index) => sqlLiteral(value, compiled.parameterTypes[index])).join(", ");
  const script = [
    "SET statement_timeout = '10s';",
    `PREPARE spike_query AS ${compiled.text};`,
    `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON) EXECUTE spike_query(${args});`,
    "DEALLOCATE spike_query;",
  ].join("\n");
  const output = runPsql(script, databaseUrl);
  const plan = parseJsonOutput(output);
  return {
    planningTimeMs: plan[0]["Planning Time"],
    executionTimeMs: plan[0]["Execution Time"],
    plan: plan[0],
  };
}

export function queryJson(sql, {
  databaseUrl = process.env.ONTOLOGY_SPIKE_DATABASE_URL ?? DEFAULT_DATABASE_URL,
} = {}) {
  const output = runPsql(sql, databaseUrl);
  return parseJsonOutput(output);
}

export function queryCompiled(compiled, {
  databaseUrl = process.env.ONTOLOGY_SPIKE_DATABASE_URL ?? DEFAULT_DATABASE_URL,
} = {}) {
  const literalSql = compiled.text.replace(/\$(\d+)/g, (match, rawIndex) => {
    const index = Number(rawIndex) - 1;
    invariant(index >= 0 && index < compiled.values.length, "PSQL_PARAMETER_INVALID", `Unknown SQL parameter ${match}`);
    return sqlLiteral(compiled.values[index], compiled.parameterTypes[index]);
  });
  return queryJson(`
    SELECT COALESCE(json_agg(row_to_json(result)), '[]'::json)
    FROM (
      ${literalSql}
    ) result;
  `, { databaseUrl });
}

export function executeSql(sql, {
  databaseUrl = process.env.ONTOLOGY_SPIKE_DATABASE_URL ?? DEFAULT_DATABASE_URL,
} = {}) {
  return runPsql(sql, databaseUrl);
}

export function executeCompiledAsync(compiled, {
  databaseUrl = process.env.ONTOLOGY_SPIKE_DATABASE_URL ?? DEFAULT_DATABASE_URL,
  statementTimeoutMs = 10_000,
} = {}) {
  const args = compiled.values.map((value, index) => sqlLiteral(value, compiled.parameterTypes[index])).join(", ");
  const script = [
    `SET statement_timeout = '${positiveInteger(statementTimeoutMs, "statementTimeoutMs")}ms';`,
    `PREPARE spike_query AS ${compiled.text};`,
    `EXECUTE spike_query(${args});`,
    "DEALLOCATE spike_query;",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn("psql", [
      databaseUrl,
      "-X",
      "-q",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      script,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let outputBytes = 0;
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const latencyMs = performance.now() - started;
      if (code !== 0) {
        const error = new Error(stderr.trim() || `psql exited with code ${code} signal ${signal ?? "none"}`);
        error.code = "PSQL_FAILED";
        error.latencyMs = latencyMs;
        reject(error);
        return;
      }
      resolve({ latencyMs, outputBytes });
    });
  });
}

function runPsql(sql, databaseUrl) {
  const result = spawnSync("psql", [
    databaseUrl,
    "-X",
    "-q",
    "-A",
    "-t",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  invariant(result.error === undefined, "PSQL_FAILED", `Could not execute psql: ${result.error?.message}`);
  invariant(result.status === 0, "PSQL_FAILED", result.stderr.trim() || "psql exited with a non-zero status");
  return result.stdout.trim();
}

function parseJsonOutput(output) {
  const first = output.indexOf("[");
  const last = output.lastIndexOf("]");
  invariant(first >= 0 && last >= first, "PSQL_OUTPUT_INVALID", "psql output did not contain JSON");
  return JSON.parse(output.slice(first, last + 1));
}

function sqlLiteral(value, type) {
  if (type.endsWith("[]")) {
    invariant(Array.isArray(value), "PSQL_PARAMETER_INVALID", `Expected array for ${type}`);
    const elementType = type.slice(0, -2);
    return `ARRAY[${value.map((item) => sqlLiteral(item, elementType)).join(", ")}]::${type}`;
  }
  if (value === null) {
    return `NULL::${type}`;
  }
  if (type === "boolean") {
    invariant(typeof value === "boolean", "PSQL_PARAMETER_INVALID", "Expected boolean parameter");
    return value ? "TRUE" : "FALSE";
  }
  if (["integer", "bigint", "numeric"].includes(type)) {
    invariant(/^-?\d+(\.\d+)?$/.test(String(value)), "PSQL_PARAMETER_INVALID", `Invalid numeric parameter: ${String(value)}`);
    return `${String(value)}::${type}`;
  }
  return `${quoteString(String(value))}::${type}`;
}

function quoteString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function positiveInteger(value, label) {
  invariant(Number.isSafeInteger(Number(value)) && Number(value) > 0, "PSQL_PARAMETER_INVALID", `${label} must be a positive integer`);
  return Number(value);
}
