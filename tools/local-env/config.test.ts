import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { localEnvironmentFile, parseEnvironmentFile, validateEnvironment } from "./config.ts";

void test("the committed local sample is complete and accepted", async () => {
  const source = parseEnvironmentFile(await readFile(localEnvironmentFile, "utf8"));
  const config = validateEnvironment(source);

  assert.equal(config.environment, "local");
  assert.equal(config.postgres.runtimeUser, "ontos_smoke_runtime");
  assert.equal(config.oidc.issuer, "http://127.0.0.1:18080/realms/ontos-local");
});

void test("production mode rejects every public sample credential", async () => {
  const source = parseEnvironmentFile(await readFile(localEnvironmentFile, "utf8"));
  source.ONTOS_ENVIRONMENT = "production";

  assert.throws(
    () => validateEnvironment(source),
    /Production configuration refuses public sample credentials/u,
  );
});

void test("missing required configuration fails closed", async () => {
  const source = parseEnvironmentFile(await readFile(localEnvironmentFile, "utf8"));
  delete source.ONTOS_OIDC_CLIENT_SECRET;

  assert.throws(
    () => validateEnvironment(source),
    /Required configuration ONTOS_OIDC_CLIENT_SECRET is missing/u,
  );
});
