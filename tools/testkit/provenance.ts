import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface SourceRecord {
  readonly path: string;
  readonly sha256: string;
}

interface ProvenanceGroup {
  readonly groupDigest: string;
  readonly sources: readonly SourceRecord[];
  readonly targets: readonly SourceRecord[];
  readonly intentionalTransforms: readonly string[];
}

interface ProvenanceCatalog {
  readonly sourceRoot: string;
  readonly sourceFingerprint: {
    readonly digest: string;
    readonly fileCount: number;
  };
  readonly groups: Readonly<Record<string, ProvenanceGroup>>;
}

export interface ProvenanceAuditResult {
  readonly sourceDigest: string;
  readonly sourceFileCount: number;
  readonly groupCount: number;
  readonly violations: readonly string[];
}

const executableRoots = ["src", "sql", "packages", "test", "scripts"] as const;
const executableRootFiles = ["package.json", "compose.yaml"] as const;

export async function auditG1Provenance(repositoryRoot: string): Promise<ProvenanceAuditResult> {
  const root = resolve(repositoryRoot);
  const catalog = await loadCatalog(root);
  const sourceRoot = join(root, catalog.sourceRoot);
  const executableFiles: string[] = [...executableRootFiles];
  for (const directory of executableRoots) {
    executableFiles.push(...(await listRelativeFiles(sourceRoot, directory)));
  }
  executableFiles.sort((left, right) => left.localeCompare(right));

  const sourceDigest = await fingerprintFiles(sourceRoot, executableFiles);
  const violations: string[] = [];
  if (sourceDigest !== catalog.sourceFingerprint.digest) {
    violations.push(
      `G1 source fingerprint drifted: expected ${catalog.sourceFingerprint.digest}, received ${sourceDigest}.`,
    );
  }
  if (executableFiles.length !== catalog.sourceFingerprint.fileCount) {
    violations.push(
      `G1 executable file count drifted: expected ${catalog.sourceFingerprint.fileCount}, received ${executableFiles.length}.`,
    );
  }

  for (const [groupName, group] of Object.entries(catalog.groups)) {
    const paths = group.sources
      .map((source) => source.path)
      .sort((left, right) => left.localeCompare(right));
    const groupDigest = await fingerprintFiles(sourceRoot, paths);
    if (groupDigest !== group.groupDigest) {
      violations.push(
        `${groupName} group fingerprint drifted: expected ${group.groupDigest}, received ${groupDigest}.`,
      );
    }
    for (const source of group.sources) {
      const actual = createHash("sha256")
        .update(await readFile(join(sourceRoot, source.path)))
        .digest("hex");
      if (actual !== source.sha256) {
        violations.push(
          `${groupName} source ${source.path} drifted: expected ${source.sha256}, received ${actual}.`,
        );
      }
    }
    for (const target of group.targets) {
      const actual = createHash("sha256")
        .update(await readFile(join(root, "packages/testkit", target.path)))
        .digest("hex");
      if (actual !== target.sha256) {
        violations.push(
          `${groupName} formal target ${target.path} drifted: expected ${target.sha256}, received ${actual}.`,
        );
      }
    }
    if (group.targets.length === 0 || group.intentionalTransforms.length === 0) {
      violations.push(`${groupName} must record targets and intentional transforms.`);
    }
  }

  const packageGroup = catalog.groups.packages;
  if (packageGroup) {
    for (const [index, source] of packageGroup.sources.entries()) {
      const target = packageGroup.targets[index];
      if (!target) {
        violations.push(`packages target ${index} is missing.`);
        continue;
      }
      const sourceJson: unknown = JSON.parse(await readFile(join(sourceRoot, source.path), "utf8"));
      const targetJson: unknown = JSON.parse(
        await readFile(join(root, "packages/testkit", target.path), "utf8"),
      );
      if (JSON.stringify(sourceJson) !== JSON.stringify(targetJson)) {
        violations.push(`${source.path} and formal target ${target.path} are not JSON-equivalent.`);
      }
    }
  }

  return {
    sourceDigest,
    sourceFileCount: executableFiles.length,
    groupCount: Object.keys(catalog.groups).length,
    violations,
  };
}

export async function fingerprintFiles(root: string, paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [...paths].sort((left, right) => left.localeCompare(right))) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(join(root, path)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function loadCatalog(repositoryRoot: string): Promise<ProvenanceCatalog> {
  const candidate: unknown = JSON.parse(
    await readFile(join(repositoryRoot, "packages/testkit/fixtures/provenance.json"), "utf8"),
  );
  if (!isRecord(candidate) || typeof candidate.sourceRoot !== "string") {
    throw new Error("Testkit provenance catalog is invalid.");
  }
  return candidate as unknown as ProvenanceCatalog;
}

async function listRelativeFiles(root: string, directory: string): Promise<string[]> {
  const absoluteDirectory = join(root, directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listRelativeFiles(root, relative(root, absolutePath))));
    } else if (entry.isFile()) {
      result.push(relative(root, absolutePath));
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const result = await auditG1Provenance(repositoryRoot);
  if (result.violations.length > 0) {
    for (const violation of result.violations) console.error(violation);
    process.exitCode = 1;
    return;
  }
  console.log(
    `testkit provenance: PASS (${result.sourceFileCount} G1 inputs, ${result.groupCount} migrated groups, ${result.sourceDigest})`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
