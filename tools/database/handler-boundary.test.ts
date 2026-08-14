import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const handlerHostDirectory = fileURLToPath(new URL("../handler-host/", import.meta.url));
const databaseClientPattern = /(?:from\s+["']pg["']|require\(["']pg["']\))/u;
const databaseIdentityPattern = /(?:DATABASE_URL|ONTOS_DB_|connectionString)/u;

void test("Handler Host source has no database client or database identity", async () => {
  const files = await collectTypeScriptFiles(handlerHostDirectory);
  const clientViolations: string[] = [];
  const identityViolations: string[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (databaseClientPattern.test(source)) clientViolations.push(file);
    if (
      !file.endsWith(".test.ts") &&
      !file.endsWith("/artifacts/capability-probe.ts") &&
      databaseIdentityPattern.test(source)
    ) {
      identityViolations.push(file);
    }
  }

  assert.deepEqual(clientViolations, []);
  assert.deepEqual(identityViolations, []);
});

async function collectTypeScriptFiles(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTypeScriptFiles(path)));
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}
