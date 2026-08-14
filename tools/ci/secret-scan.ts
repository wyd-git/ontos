import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface SecretPolicy {
  readonly schemaVersion: number;
  readonly allowedValueSha256: readonly string[];
}

export interface SecretFinding {
  readonly rule: string;
  readonly path: string;
  readonly line: number;
}

export interface SecretScanReport {
  readonly schemaVersion: 1;
  readonly status: "PASS" | "FAIL";
  readonly scannedFileCount: number;
  readonly findings: readonly SecretFinding[];
}

interface DetectionRule {
  readonly code: string;
  readonly expression: RegExp;
  readonly valueGroup?: number;
}

const privateKeyExpression = new RegExp(
  ["-----BEGIN ", "(?:RSA |EC |OPENSSH |DSA |PGP )?", "PRIVATE KEY(?: BLOCK)?-----"].join(""),
  "u",
);

const rules: readonly DetectionRule[] = [
  { code: "PRIVATE_KEY_HEADER", expression: privateKeyExpression },
  { code: "GITHUB_TOKEN", expression: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/u },
  {
    code: "AWS_ACCESS_KEY",
    expression: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/u,
  },
  { code: "GOOGLE_API_KEY", expression: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { code: "SLACK_TOKEN", expression: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/u },
  {
    code: "GENERIC_SECRET_ASSIGNMENT",
    expression:
      /\b[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY|ACCESS_KEY(?:_ID)?)[A-Z0-9_]*\s*=\s*['"]?([A-Za-z0-9+/_=:@.-]{16,})/u,
    valueGroup: 1,
  },
  {
    code: "GENERIC_SECRET_ASSIGNMENT",
    expression:
      /['"]?(?=[A-Za-z0-9_$]*[a-z])[A-Za-z0-9_$]*(?:password|Password|secret|Secret|token|Token|privateKey|PrivateKey|accessKey(?:Id)?|AccessKey(?:Id)?)[A-Za-z0-9_$]*['"]?\s*:\s*['"]([A-Za-z0-9+/_=:@.-]{16,})['"]/u,
    valueGroup: 1,
  },
];

export function scanText(
  path: string,
  text: string,
  allowedValueSha256: ReadonlySet<string>,
): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    for (const rule of rules) {
      const match = rule.expression.exec(line);
      if (match === null) continue;
      const value = rule.valueGroup === undefined ? undefined : match[rule.valueGroup];
      if (value !== undefined && allowedValueSha256.has(sha256(value))) continue;
      findings.push({ rule: rule.code, path, line: index + 1 });
    }
  }
  return findings;
}

export async function scanTrackedFiles(
  repositoryRoot: string,
  policy: SecretPolicy,
): Promise<SecretScanReport> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  const paths = stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const allowlist = new Set(policy.allowedValueSha256);
  const findings: SecretFinding[] = [];
  let scannedFileCount = 0;

  for (const path of paths) {
    const content = await readFile(join(repositoryRoot, path));
    if (content.includes(0)) continue;
    scannedFileCount += 1;
    findings.push(...scanText(path, content.toString("utf8"), allowlist));
  }

  return {
    schemaVersion: 1,
    status: findings.length === 0 ? "PASS" : "FAIL",
    scannedFileCount,
    findings,
  };
}

async function loadPolicy(repositoryRoot: string): Promise<SecretPolicy> {
  const candidate: unknown = JSON.parse(
    await readFile(join(repositoryRoot, "security/secret-scan-policy.json"), "utf8"),
  );
  if (
    !isRecord(candidate) ||
    candidate.schemaVersion !== 1 ||
    !Array.isArray(candidate.allowedValueSha256) ||
    !candidate.allowedValueSha256.every(isSha256)
  ) {
    throw new Error("Secret scan policy is invalid.");
  }
  return candidate as unknown as SecretPolicy;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const outputDirectory = join(repositoryRoot, "generated/ci-report");
  await mkdir(outputDirectory, { recursive: true });
  const report = await scanTrackedFiles(repositoryRoot, await loadPolicy(repositoryRoot));
  await writeFile(
    join(outputDirectory, "secret-scan.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(
    `secret scan: ${report.status} (${String(report.scannedFileCount)} tracked text files, ${String(report.findings.length)} findings)\n`,
  );
  if (report.status === "FAIL") process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`secret scan: FAIL (${String(error)})\n`);
    process.exitCode = 1;
  }
}
