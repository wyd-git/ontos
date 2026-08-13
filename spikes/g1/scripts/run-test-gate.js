import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname, platform, release } from "node:os";
import { join } from "node:path";

const timestamp = new Date().toISOString().replaceAll(":", "");
const evidenceDirectory = join("evidence", "raw", `${timestamp}-unit-tests`);
await mkdir(evidenceDirectory, { recursive: true });

const child = spawn(process.execPath, ["--test"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
let standardOutput = "";
let standardError = "";
child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  standardOutput += text;
  process.stdout.write(text);
});
child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  standardError += text;
  process.stderr.write(text);
});
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => resolve(code ?? 1));
});

await writeFile(join(evidenceDirectory, "command.txt"), "npm run gate:tests\n", "utf8");
await writeFile(join(evidenceDirectory, "stdout.txt"), standardOutput, "utf8");
await writeFile(join(evidenceDirectory, "stderr.txt"), standardError, "utf8");
await writeFile(join(evidenceDirectory, "environment.json"), `${JSON.stringify({
  timestamp,
  hostname: hostname(),
  platform: platform(),
  osRelease: release(),
  nodeVersion: process.version,
}, null, 2)}\n`, "utf8");
await writeFile(join(evidenceDirectory, "result.json"), `${JSON.stringify({
  status: exitCode === 0 ? "PASS" : "FAIL",
  exitCode,
}, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({ evidenceDirectory, status: exitCode === 0 ? "PASS" : "FAIL", exitCode }, null, 2)}\n`);
process.exitCode = exitCode;
