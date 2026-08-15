import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import test from "node:test";

const postgresImageMarker = "postgres:16.14-bookworm@sha256:";
const postgresDataTmpfs = "/var/lib/postgresql/data:rw,noexec,nosuid,size=1g";
const volumeSafeCleanup =
  /docker\(\["rm",\s*"--force",\s*"--volumes",\s*containerName\],\s*true\)/u;

void test("PostgreSQL Docker tests cannot leak anonymous data volumes", async () => {
  const postgresTests: string[] = [];

  for await (const path of glob("tools/**/*.test.ts")) {
    if (path === "tools/ci/docker-volume-hygiene.test.ts") continue;
    const source = await readFile(path, "utf8");
    if (!source.includes(postgresImageMarker)) continue;

    postgresTests.push(path);
    assert.equal(
      source.includes(postgresDataTmpfs),
      true,
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
