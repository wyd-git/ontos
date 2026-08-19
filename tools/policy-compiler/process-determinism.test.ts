import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

void test("Policy compilation is byte-stable across Locale, Timezone and process", async () => {
  const outputs = await Promise.all([
    run({ TZ: "UTC", LANG: "C", LC_ALL: "C" }),
    run({ TZ: "Asia/Shanghai", LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8" }),
    run({ TZ: "America/Los_Angeles", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }),
  ]);
  assert.equal(new Set(outputs).size, 1);
});

async function run(environment: Readonly<Record<string, string>>): Promise<string> {
  const child = spawn(process.execPath, ["tools/policy-compiler/process-fixture.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  return stdout;
}
