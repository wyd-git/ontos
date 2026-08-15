import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

void test("API and Worker source cannot import the DDL Executor or its dedicated secret", async () => {
  const files = [
    ...(await sourceFiles(resolve(repositoryRoot, "apps/api"))),
    ...(await sourceFiles(resolve(repositoryRoot, "apps/worker"))),
  ];
  assert.ok(files.length > 0, "at least the API composition root must exist");
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    assert.equal(
      /ONTOS_PROJECTION_DDL_DATABASE_URL|materialization-control-plane\/projection-ddl|projection-ddl-cli/u.test(
        contents,
      ),
      false,
      file,
    );
  }
});

void test("the only API migration_owner reference is a fail-closed membership check", async () => {
  const files = await sourceFiles(resolve(repositoryRoot, "apps/api"));
  const references: { readonly file: string; readonly contents: string }[] = [];
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    if (contents.includes("migration_owner")) references.push({ file, contents });
  }
  assert.equal(references.length, 1);
  assert.equal(references[0]?.file.endsWith("/apps/api/src/database-boundary.ts"), true);
  assert.match(
    references[0]?.contents ?? "",
    /pg_has_role\(current_user, 'migration_owner', 'MEMBER'\)/u,
  );
  assert.match(references[0]?.contents ?? "", /migration_owner_member/u);
});

async function sourceFiles(directory: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(path)));
    else if ([".ts", ".tsx", ".js", ".mjs", ".json"].includes(extname(entry.name))) {
      result.push(path);
    }
  }
  return result.toSorted();
}
