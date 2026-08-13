import assert from "node:assert/strict";
import test from "node:test";

import { localComposeFile, localComposeProject, localEnvironmentFile } from "./config.ts";
import { assertProjectScopedReset, composeArguments } from "./compose-plan.ts";

void test("reset is pinned to one compose file, env file, and project", () => {
  assert.deepEqual(composeArguments("reset"), [
    "compose",
    "--ansi",
    "never",
    "--project-name",
    localComposeProject,
    "--env-file",
    localEnvironmentFile,
    "--file",
    localComposeFile,
    "down",
    "--volumes",
    "--remove-orphans",
  ]);
});

void test("reset guard rejects a broadened command", () => {
  assert.throws(
    () => assertProjectScopedReset(["compose", "down", "--volumes"]),
    /not exactly scoped/u,
  );
});

void test("persistent restart excludes the one-shot guard and never removes volumes", () => {
  const arguments_ = composeArguments("restart");

  assert.deepEqual(arguments_.slice(-5), ["restart", "postgres", "s3", "oidc", "telemetry"]);
  assert.equal(arguments_.includes("--volumes"), false);
});
