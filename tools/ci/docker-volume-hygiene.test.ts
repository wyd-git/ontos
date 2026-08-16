import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import test from "node:test";

import {
  pinnedPostgresTestImage,
  resolvePostgresTestImage,
} from "../database/postgres-test-image.ts";

const postgresContainerMarker = "POSTGRES_DB=";
const boundedPostgresDataTmpfs = /\/var\/lib\/postgresql\/data:rw,noexec,nosuid,size=(?:1|2)g/u;
const volumeSafeCleanup =
  /docker\(\["rm",\s*"--force",\s*"--volumes",\s*containerName\],\s*true\)/u;

void test("PostgreSQL Docker tests cannot leak anonymous data volumes", async () => {
  const postgresTests: string[] = [];

  for await (const path of glob("tools/**/*.test.ts")) {
    if (path === "tools/ci/docker-volume-hygiene.test.ts") continue;
    const source = await readFile(path, "utf8");
    if (!source.includes(postgresContainerMarker)) continue;

    postgresTests.push(path);
    assert.equal(
      source.includes("resolvePostgresTestImage()"),
      true,
      `${path} must use the immutable PostgreSQL image resolver`,
    );
    assert.match(
      source,
      boundedPostgresDataTmpfs,
      `${path} must mount PostgreSQL data on a bounded tmpfs`,
    );
    assert.match(
      source,
      volumeSafeCleanup,
      `${path} must remove the container and any anonymous volumes`,
    );
  }

  assert.ok(postgresTests.length > 0, "expected at least one PostgreSQL Docker test");
});

void test("PostgreSQL image override remains immutable", () => {
  assert.equal(resolvePostgresTestImage({}), pinnedPostgresTestImage);

  const imageId = `sha256:${"a".repeat(64)}`;
  const digestReference = `registry.example.test/postgres@sha256:${"b".repeat(64)}`;
  assert.equal(resolvePostgresTestImage({ ONTOS_TEST_POSTGRES_IMAGE: imageId }), imageId);
  assert.equal(
    resolvePostgresTestImage({ ONTOS_TEST_POSTGRES_IMAGE: digestReference }),
    digestReference,
  );

  for (const mutableReference of ["postgres:16.14-bookworm", "latest", " sha256:bad"] as const) {
    assert.throws(
      () => resolvePostgresTestImage({ ONTOS_TEST_POSTGRES_IMAGE: mutableReference }),
      /must be an immutable sha256 image ID or digest reference/u,
    );
  }
});
