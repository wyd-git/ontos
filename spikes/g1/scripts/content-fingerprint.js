import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
// Fingerprint executable inputs only. Reports and README files deliberately
// stay outside this set so a report can record this digest without creating a
// self-referential hash that changes when the digest is written into it.
const roots = ["src", "sql", "packages", "test", "scripts"];
const rootFiles = ["package.json", "compose.yaml"];
const paths = [...rootFiles.map((path) => join(projectDirectory, path))];
for (const root of roots) {
  paths.push(...await listFiles(join(projectDirectory, root)));
}
paths.sort((left, right) => relative(projectDirectory, left).localeCompare(relative(projectDirectory, right)));

const hash = createHash("sha256");
for (const path of paths) {
  const name = relative(projectDirectory, path);
  const contents = await readFile(path);
  hash.update(name);
  hash.update("\0");
  hash.update(contents);
  hash.update("\0");
}

process.stdout.write(`${JSON.stringify({
  algorithm: "sha256",
  digest: hash.digest("hex"),
  fileCount: paths.length,
}, null, 2)}\n`);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
