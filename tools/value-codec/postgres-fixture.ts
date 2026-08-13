import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

import {
  canonicalizePrimaryKey,
  type CanonicalPrimaryKey,
} from "../../packages/value-codec/src/index.ts";
import { loadLocalEnvironmentConfig, localEndpoints } from "../local-env/config.ts";
import {
  evaluateGoldenPrimaryKey,
  evaluateGoldenValue,
  loadGoldenVectors,
  type GoldenValueVector,
  type OrderGoldenVector,
} from "./golden.ts";

const sqlPath = fileURLToPath(new URL("./postgres-fixture.sql", import.meta.url));

export interface PostgreSqlFixtureResult {
  readonly positiveVectors: number;
  readonly primaryKeyVectors: number;
  readonly collisionVectors: number;
  readonly orderGroups: number;
  readonly postgresVersion: string;
}

export async function verifyPostgreSqlGoldenVectors(): Promise<PostgreSqlFixtureResult> {
  const environment = await loadLocalEnvironmentConfig();
  const client = new pg.Client({
    host: localEndpoints.postgres.host,
    port: localEndpoints.postgres.port,
    database: environment.postgres.database,
    user: environment.postgres.superuser,
    password: environment.postgres.superuserPassword,
    application_name: "ontos-value-codec-fixture",
  });
  const vectors = await loadGoldenVectors();

  await client.connect();
  try {
    await client.query("SET TIME ZONE 'UTC'");
    await client.query(await readFile(sqlPath, "utf8"));

    for (const vector of vectors.positive) {
      const expected = goldenValueAsText(vector, evaluateGoldenValue(vector));
      assert.equal(await evaluatePostgreSqlValue(client, vector), expected, vector.id);
    }
    for (const vector of vectors.primaryKeys) {
      const canonical = evaluateGoldenPrimaryKey(vector);
      const result = await client.query<{ canonical: string }>(
        "SELECT pg_temp.ontos_fixture_primary_key($1::text, $2::integer) AS canonical",
        [canonical, vector.definition.maximumBytes ?? 1_024],
      );
      assert.equal(singleCanonical(result.rows, vector.id), vector.expected, vector.id);
    }

    for (const vector of vectors.collisions) {
      const canonicalValues = vector.candidates.map((inputs) =>
        canonicalizePrimaryKey(inputs, vector.definition),
      );
      await assertPostgreSqlUniqueCollision(client, vector.id, canonicalValues);
    }
    for (const vector of vectors.orderGroups) {
      assert.deepEqual(
        await evaluatePostgreSqlOrder(client, vector),
        vector.expectedCanonicalOrder,
        vector.id,
      );
    }

    const version = await client.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version",
    );
    return {
      positiveVectors: vectors.positive.length,
      primaryKeyVectors: vectors.primaryKeys.length,
      collisionVectors: vectors.collisions.length,
      orderGroups: vectors.orderGroups.length,
      postgresVersion: requiredRow(version.rows, "PostgreSQL version").version,
    };
  } finally {
    await client.end();
  }
}

async function evaluatePostgreSqlValue(
  client: pg.Client,
  vector: GoldenValueVector,
): Promise<string> {
  let query: string;
  let parameters: readonly unknown[];
  switch (vector.kind) {
    case "uuid":
      query = "SELECT pg_temp.ontos_fixture_uuid($1::text) AS canonical";
      parameters = [vector.input];
      break;
    case "boolean":
      query = "SELECT $1::boolean::text AS canonical";
      parameters = [vector.input];
      break;
    case "integer":
      query = "SELECT pg_temp.ontos_fixture_integer($1::text) AS canonical";
      parameters = [vector.input];
      break;
    case "decimal":
      query =
        "SELECT pg_temp.ontos_fixture_decimal($1::text, $2::integer, $3::integer) AS canonical";
      parameters = [vector.input, vector.precision, vector.scale];
      break;
    case "date":
      query = "SELECT pg_temp.ontos_fixture_date($1::text) AS canonical";
      parameters = [vector.input];
      break;
    case "timestamp":
      query = "SELECT pg_temp.ontos_fixture_timestamp($1::text) AS canonical";
      parameters = [vector.input];
      break;
    case "enum":
      query = "SELECT pg_temp.ontos_fixture_enum($1::text, $2::text[]) AS canonical";
      parameters = [vector.input, vector.values ?? []];
      break;
    case "string":
      query = "SELECT pg_temp.ontos_fixture_string($1::text, $2::integer) AS canonical";
      parameters = [vector.input, vector.maximumBytes ?? 64 * 1_024];
      break;
    case "string[]":
      query = "SELECT pg_temp.ontos_fixture_string_array($1::text[], $2::integer) AS canonical";
      parameters = [vector.input, vector.maximumItems ?? 1_000];
      break;
    case "json":
      query = "SELECT pg_temp.ontos_fixture_json($1::jsonb) AS canonical";
      parameters = [JSON.stringify(vector.input)];
      break;
  }
  const result = await client.query<{ canonical: string }>(query, parameters as unknown[]);
  return singleCanonical(result.rows, vector.id);
}

async function evaluatePostgreSqlOrder(
  client: pg.Client,
  vector: OrderGoldenVector,
): Promise<readonly string[]> {
  let query: string;
  let parameters: readonly unknown[];
  switch (vector.kind) {
    case "uuid":
      query = `
        SELECT pg_temp.ontos_fixture_uuid(value) AS canonical
        FROM unnest($1::text[]) AS inputs(value)
        ORDER BY pg_temp.ontos_fixture_uuid(value)::uuid`;
      parameters = [vector.inputs];
      break;
    case "boolean":
      query = `
        SELECT value::text AS canonical
        FROM unnest($1::boolean[]) AS inputs(value)
        ORDER BY value`;
      parameters = [vector.inputs];
      break;
    case "integer":
      query = `
        SELECT pg_temp.ontos_fixture_integer(value) AS canonical
        FROM unnest($1::text[]) AS inputs(value)
        ORDER BY pg_temp.ontos_fixture_integer(value)::bigint`;
      parameters = [vector.inputs];
      break;
    case "decimal":
      query = `
        SELECT pg_temp.ontos_fixture_decimal(value, $2::integer, $3::integer) AS canonical
        FROM unnest($1::text[]) AS inputs(value)
        ORDER BY pg_temp.ontos_fixture_decimal(value, $2::integer, $3::integer)::numeric`;
      parameters = [vector.inputs, vector.precision, vector.scale];
      break;
    case "date":
      query = `
        SELECT pg_temp.ontos_fixture_date(value) AS canonical
        FROM unnest($1::text[]) AS inputs(value)
        ORDER BY pg_temp.ontos_fixture_date(value)::date`;
      parameters = [vector.inputs];
      break;
    case "timestamp":
      query = `
        SELECT pg_temp.ontos_fixture_timestamp(value) AS canonical
        FROM unnest($1::text[]) AS inputs(value)
        ORDER BY pg_temp.ontos_fixture_timestamp(value)::timestamptz`;
      parameters = [vector.inputs];
      break;
    case "enum":
      query = `
        SELECT pg_temp.ontos_fixture_enum(value, $2::text[]) AS canonical
        FROM unnest($1::text[]) AS inputs(value)
        ORDER BY array_position($2::text[], value)`;
      parameters = [vector.inputs, vector.values ?? []];
      break;
    case "string":
      query = `
        SELECT pg_temp.ontos_fixture_string(value, $2::integer) AS canonical
        FROM unnest($1::text[]) AS inputs(value)
        ORDER BY pg_temp.ontos_fixture_string(value, $2::integer) COLLATE "C"`;
      parameters = [vector.inputs, vector.maximumBytes ?? 64 * 1_024];
      break;
  }
  const result = await client.query<{ canonical: string }>(query, parameters as unknown[]);
  return result.rows.map((row) => row.canonical);
}

async function assertPostgreSqlUniqueCollision(
  client: pg.Client,
  id: string,
  canonicalValues: readonly CanonicalPrimaryKey[],
): Promise<void> {
  await client.query(
    'CREATE TEMP TABLE IF NOT EXISTS value_codec_identity (canonical text COLLATE "C" PRIMARY KEY)',
  );
  await client.query("TRUNCATE pg_temp.value_codec_identity");
  let collided = false;
  for (const canonical of canonicalValues) {
    try {
      await client.query("INSERT INTO pg_temp.value_codec_identity (canonical) VALUES ($1)", [
        canonical,
      ]);
    } catch (error) {
      if (isPostgreSqlError(error) && error.code === "23505") {
        collided = true;
        continue;
      }
      throw error;
    }
  }
  assert.equal(collided, true, `${id} did not violate PostgreSQL uniqueness.`);
}

function goldenValueAsText(vector: GoldenValueVector, value: unknown): string {
  if (vector.kind === "string[]") return JSON.stringify(value);
  if (vector.kind === "boolean") return value === true ? "true" : "false";
  return String(value);
}

function singleCanonical(rows: readonly { readonly canonical: string }[], id: string): string {
  return requiredRow(rows, id).canonical;
}

function requiredRow<T>(rows: readonly T[], label: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`${label} returned no PostgreSQL row.`);
  return row;
}

function isPostgreSqlError(value: unknown): value is { readonly code: string } {
  return typeof value === "object" && value !== null && "code" in value;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    const result = await verifyPostgreSqlGoldenVectors();
    process.stdout.write(
      `value-codec PostgreSQL fixture: PASS (${result.positiveVectors} values, ${result.primaryKeyVectors} Primary Keys, ${result.collisionVectors} collisions, ${result.orderGroups} order groups; PostgreSQL ${result.postgresVersion})\n`,
    );
  } catch (error) {
    process.stderr.write(`value-codec PostgreSQL fixture: FAIL (${String(error)})\n`);
    process.exitCode = 1;
  }
}
