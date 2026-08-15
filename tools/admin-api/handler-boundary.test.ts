import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routerPath = new URL("../../apps/api/src/router.ts", import.meta.url);

void test("Admin HTTP handler contains no SQL, repository composition, JWT parsing or raw claims", async () => {
  const source = await readFile(routerPath, "utf8");
  for (const forbidden of [
    /\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/iu,
    /PostgresMetadata|PostgresRelease|PostgresPackage/u,
    /jwtVerify|createRemoteJWKSet/u,
    /rawClaims|bearerToken/u,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
  assert.match(source, /services\.metadata/u);
  assert.match(source, /services\.resources/u);
  assert.match(source, /services\.releases/u);
  assert.match(source, /services\.packages/u);
  assert.match(source, /services\.materialization/u);
  assert.doesNotMatch(source, /S3ManagedObjectStore|objectKey|accessKey|secretAccessKey/u);
});
