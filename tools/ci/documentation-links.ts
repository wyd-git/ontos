import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface DocumentationLinkFinding {
  readonly source: string;
  readonly target: string;
  readonly reason: string;
}

export interface DocumentationLinkReport {
  readonly schemaVersion: 1;
  readonly status: "PASS" | "FAIL";
  readonly scannedFileCount: number;
  readonly localLinkCount: number;
  readonly findings: readonly DocumentationLinkFinding[];
}

export async function checkDocumentationLinks(
  repositoryRoot: string,
  markdownPaths: readonly string[],
): Promise<DocumentationLinkReport> {
  const findings: DocumentationLinkFinding[] = [];
  let localLinkCount = 0;

  for (const source of [...markdownPaths].sort()) {
    const sourcePath = resolve(repositoryRoot, source);
    const content = await readFile(sourcePath, "utf8");
    for (const rawTarget of extractMarkdownTargets(content)) {
      const target = localPathTarget(rawTarget);
      if (target === null) continue;
      localLinkCount += 1;
      let decoded: string;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        findings.push({
          source,
          target: rawTarget,
          reason: "The local link is not valid URI text.",
        });
        continue;
      }
      const destination = resolve(dirname(sourcePath), decoded);
      const repositoryRelative = relative(repositoryRoot, destination);
      if (
        repositoryRelative === ".." ||
        repositoryRelative.startsWith(`..${sep}`) ||
        repositoryRelative.startsWith(sep)
      ) {
        findings.push({
          source,
          target: rawTarget,
          reason: "The local link leaves the repository.",
        });
        continue;
      }
      try {
        await stat(destination);
      } catch {
        findings.push({
          source,
          target: rawTarget,
          reason: "The local link target does not exist.",
        });
      }
    }
  }

  return {
    schemaVersion: 1,
    status: findings.length === 0 ? "PASS" : "FAIL",
    scannedFileCount: markdownPaths.length,
    localLinkCount,
    findings,
  };
}

export function extractMarkdownTargets(content: string): readonly string[] {
  const inline = [...content.matchAll(/!?(?:\[[^\]\n]*\])\((<[^>\n]+>|[^)\n]+)\)/gu)].map(
    (match) => match[1] ?? "",
  );
  const references = [...content.matchAll(/^\s*\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gmu)].map(
    (match) => match[1] ?? "",
  );
  return [...inline, ...references];
}

function localPathTarget(rawTarget: string): string | null {
  const trimmed = rawTarget.trim();
  const destination = trimmed.startsWith("<")
    ? trimmed.slice(1, trimmed.indexOf(">"))
    : (trimmed.match(/^\S+/u)?.[0] ?? "");
  if (
    destination.length === 0 ||
    destination.startsWith("#") ||
    destination.startsWith("/") ||
    destination.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(destination)
  ) {
    return null;
  }
  const withoutFragment = destination.split("#", 1)[0] ?? "";
  const withoutQuery = withoutFragment.split("?", 1)[0] ?? "";
  return withoutQuery.length === 0 ? null : withoutQuery;
}

function trackedMarkdownPaths(repositoryRoot: string): readonly string[] {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.md"],
    {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const report = await checkDocumentationLinks(
    repositoryRoot,
    trackedMarkdownPaths(repositoryRoot),
  );
  const outputDirectory = resolve(repositoryRoot, "generated/ci-report");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    resolve(outputDirectory, "documentation-links.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (report.status === "PASS") {
    process.stdout.write(
      `documentation links: PASS (${String(report.scannedFileCount)} files, ${String(report.localLinkCount)} local links)\n`,
    );
    return;
  }
  for (const finding of report.findings) {
    process.stderr.write(`${finding.source}: ${finding.target}: ${finding.reason}\n`);
  }
  throw new Error(`documentation links: FAIL (${String(report.findings.length)} findings)`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}
