import assert from "node:assert/strict";
import test from "node:test";

import { loadAdminApiConfig } from "../../apps/api/src/config.ts";

const valid = Object.freeze({
  ONTOS_ADMIN_API_HOST: "127.0.0.1",
  ONTOS_ADMIN_API_PORT: "3000",
  ONTOS_DATABASE_URL: "postgresql://api_runtime:test@127.0.0.1:5432/ontos",
  ONTOS_OIDC_ISSUER: "https://issuer.example.test",
  ONTOS_OIDC_AUDIENCE: "ontos-admin",
  ONTOS_OIDC_ADMIN_SCOPE: "ontos.admin",
  ONTOS_CURSOR_HMAC_SECRET: "a-secret-containing-at-least-32-bytes",
  ONTOS_MANAGED_CSV_MAXIMUM_BYTES: "1048576",
  ONTOS_S3_ENDPOINT: "http://127.0.0.1:8333",
  ONTOS_S3_REGION: "us-east-1",
  ONTOS_S3_BUCKET: "ontos-ingress",
  ONTOS_S3_ACCESS_KEY_ID: "test-access-key",
  ONTOS_S3_SECRET_ACCESS_KEY: "test-secret-key",
  ONTOS_S3_FORCE_PATH_STYLE: "true",
  ONTOS_S3_MAX_ATTEMPTS: "3",
});

void test("Admin API configuration closes and bounds the managed object-store surface", () => {
  const config = loadAdminApiConfig(valid);
  assert.equal(config.managedCsvMaximumBytes, 1_048_576);
  assert.deepEqual(config.objectStore, {
    endpoint: valid.ONTOS_S3_ENDPOINT,
    region: valid.ONTOS_S3_REGION,
    bucket: valid.ONTOS_S3_BUCKET,
    accessKeyId: valid.ONTOS_S3_ACCESS_KEY_ID,
    secretAccessKey: valid.ONTOS_S3_SECRET_ACCESS_KEY,
    forcePathStyle: true,
    maxAttempts: 3,
  });

  for (const source of [
    { ...valid, ONTOS_S3_ENDPOINT: "" },
    { ...valid, ONTOS_S3_FORCE_PATH_STYLE: "yes" },
    { ...valid, ONTOS_S3_MAX_ATTEMPTS: "6" },
    { ...valid, ONTOS_MANAGED_CSV_MAXIMUM_BYTES: "536870913" },
    { ...valid, ONTOS_MANAGED_CSV_MAXIMUM_BYTES: "0" },
  ]) {
    assert.throws(() => loadAdminApiConfig(source));
  }
});
