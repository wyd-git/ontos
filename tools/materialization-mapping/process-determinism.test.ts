import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./process-fixture.ts", import.meta.url));

void test("same Mapping is byte-identical across clean processes, locales, and timezones", () => {
  const utc = runFixture({ TZ: "UTC", LANG: "C" });
  const shanghai = runFixture({ TZ: "Asia/Shanghai", LANG: "zh_CN.UTF-8" });

  assert.equal(shanghai, utc);
  const parsed = JSON.parse(utc) as {
    readonly summary: { readonly acceptedRowCount: number; readonly mappedStreamDigest: string };
  };
  assert.equal(parsed.summary.acceptedRowCount, 3);
  assert.match(parsed.summary.mappedStreamDigest, /^sha256:[0-9a-f]{64}$/u);
});

function runFixture(overrides: Readonly<Record<string, string>>): string {
  const result = spawnSync(process.execPath, [fixture], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...overrides },
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}
