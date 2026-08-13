import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateManifest } from "./manifest.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(currentDirectory, "..", "..");
const manifestPaths = [
  join(projectDirectory, "packages", "work-management", "package.json"),
  join(projectDirectory, "packages", "commerce", "package.json"),
];

const results = [];
for (const manifestPath of manifestPaths) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  results.push(validateManifest(manifest));
}

process.stdout.write(`${JSON.stringify({ status: "PASS", packages: results }, null, 2)}\n`);

