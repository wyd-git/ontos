import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface LicensePolicy {
  readonly schemaVersion: number;
  readonly allowedSpdxExpressions: readonly string[];
}

export interface LicenseEntry {
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  readonly resolved: string | null;
  readonly integrity: string | null;
  readonly scope: "runtime" | "dev" | "optional";
}

export interface LicenseReport {
  readonly schemaVersion: 1;
  readonly status: "PASS" | "FAIL";
  readonly packageCount: number;
  readonly entries: readonly LicenseEntry[];
  readonly violations: readonly string[];
}

interface VulnerabilityWaiver {
  readonly package: string;
  readonly severity: string;
  readonly advisoryUrls: readonly string[];
  readonly owner: string;
  readonly reason: string;
  readonly created: string;
  readonly expires: string;
}

export interface VulnerabilityPolicy {
  readonly schemaVersion: number;
  readonly blockingSeverities: readonly string[];
  readonly reportingSeverities: readonly string[];
  readonly maximumWaiverDays: number;
  readonly waivers: readonly VulnerabilityWaiver[];
}

export interface VulnerabilityFinding {
  readonly package: string;
  readonly severity: string;
  readonly advisoryUrls: readonly string[];
  readonly waived: boolean;
}

export interface VulnerabilityReport {
  readonly schemaVersion: 1;
  readonly status: "PASS" | "FAIL";
  readonly counts: Readonly<Record<string, number>>;
  readonly findings: readonly VulnerabilityFinding[];
  readonly errors: readonly string[];
}

interface CapturedCommand {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function createLicenseReport(
  packageLock: unknown,
  allowedSpdxExpressions: ReadonlySet<string>,
): LicenseReport {
  if (!isRecord(packageLock) || !isRecord(packageLock.packages)) {
    throw new Error("package-lock.json does not contain a packages map.");
  }
  const entries: LicenseEntry[] = [];
  const violations: string[] = [];
  for (const [path, candidate] of Object.entries(packageLock.packages)) {
    if (!path.includes("node_modules/") || !isRecord(candidate) || candidate.link === true)
      continue;
    const name = packageNameFromPath(path);
    const version = typeof candidate.version === "string" ? candidate.version : "";
    const license = typeof candidate.license === "string" ? candidate.license : null;
    const entry: LicenseEntry = {
      name,
      version,
      license,
      resolved: typeof candidate.resolved === "string" ? candidate.resolved : null,
      integrity: typeof candidate.integrity === "string" ? candidate.integrity : null,
      scope: candidate.optional === true ? "optional" : candidate.dev === true ? "dev" : "runtime",
    };
    entries.push(entry);
    if (version.length === 0) violations.push(`${name} has no locked version.`);
    if (license === null) violations.push(`${name}@${version || "unknown"} has no license.`);
    else if (!allowedSpdxExpressions.has(license)) {
      violations.push(`${name}@${version || "unknown"} uses unapproved license ${license}.`);
    }
  }
  entries.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
  violations.sort((left, right) => left.localeCompare(right));
  return {
    schemaVersion: 1,
    status: violations.length === 0 ? "PASS" : "FAIL",
    packageCount: entries.length,
    entries,
    violations,
  };
}

export function evaluateVulnerabilityReport(
  auditCandidate: unknown,
  policy: VulnerabilityPolicy,
  now = new Date(),
): VulnerabilityReport {
  const errors = validateVulnerabilityPolicy(policy, now);
  if (
    !isRecord(auditCandidate) ||
    isRecord(auditCandidate.error) ||
    !isRecord(auditCandidate.metadata) ||
    !isRecord(auditCandidate.metadata.vulnerabilities) ||
    !isRecord(auditCandidate.vulnerabilities)
  ) {
    errors.push("npm audit response is missing required vulnerability metadata.");
    return { schemaVersion: 1, status: "FAIL", counts: {}, findings: [], errors };
  }

  const counts: Record<string, number> = {};
  for (const [severity, count] of Object.entries(auditCandidate.metadata.vulnerabilities)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      errors.push(`npm audit count for ${severity} is invalid.`);
    } else {
      counts[severity] = count;
    }
  }

  const knownSeverities = new Set([...policy.blockingSeverities, ...policy.reportingSeverities]);
  const findings: VulnerabilityFinding[] = [];
  for (const [packageName, candidate] of Object.entries(auditCandidate.vulnerabilities)) {
    if (!isRecord(candidate) || typeof candidate.severity !== "string") {
      errors.push(`npm audit finding for ${packageName} is invalid.`);
      continue;
    }
    const severity = candidate.severity;
    if (!knownSeverities.has(severity)) {
      errors.push(`npm audit returned unknown severity ${severity} for ${packageName}.`);
    }
    const advisoryUrls = collectAdvisoryUrls(candidate.via);
    const waiver = policy.waivers.find(
      (candidateWaiver) =>
        candidateWaiver.package === packageName &&
        candidateWaiver.severity === severity &&
        sameStrings(candidateWaiver.advisoryUrls, advisoryUrls) &&
        activeOn(candidateWaiver, now),
    );
    const waived = waiver !== undefined;
    findings.push({ package: packageName, severity, advisoryUrls, waived });
    if (policy.blockingSeverities.includes(severity) && !waived) {
      errors.push(`${packageName} has an unwaived ${severity} vulnerability.`);
    }
  }

  for (const waiver of policy.waivers) {
    const matches = findings.some(
      (finding) =>
        finding.package === waiver.package &&
        finding.severity === waiver.severity &&
        sameStrings(finding.advisoryUrls, waiver.advisoryUrls),
    );
    if (!matches)
      errors.push(`Waiver for ${waiver.package} does not exactly match a current finding.`);
  }
  findings.sort((left, right) => left.package.localeCompare(right.package));
  return {
    schemaVersion: 1,
    status: errors.length === 0 ? "PASS" : "FAIL",
    counts,
    findings,
    errors,
  };
}

async function runSupplyChain(repositoryRoot: string): Promise<void> {
  const outputDirectory = join(repositoryRoot, "generated/ci-report");
  await mkdir(outputDirectory, { recursive: true });
  const licensePolicy = await readJson<LicensePolicy>(
    join(repositoryRoot, "security/license-policy.json"),
  );
  if (
    licensePolicy.schemaVersion !== 1 ||
    !Array.isArray(licensePolicy.allowedSpdxExpressions) ||
    !licensePolicy.allowedSpdxExpressions.every((value) => typeof value === "string")
  ) {
    throw new Error("License policy is invalid.");
  }
  const packageLock: unknown = await readJson(join(repositoryRoot, "package-lock.json"));
  const licenseReport = createLicenseReport(
    packageLock,
    new Set(licensePolicy.allowedSpdxExpressions),
  );
  const licensePath = join(outputDirectory, "licenses.json");
  await writeJson(licensePath, licenseReport);

  const sbomCommand = await capture("npm", ["sbom", "--sbom-format", "cyclonedx"], repositoryRoot);
  if (sbomCommand.exitCode !== 0) {
    throw new Error(`npm sbom failed: ${safeTail(sbomCommand.stderr)}`);
  }
  const sbom: unknown = parseJson(sbomCommand.stdout, "npm sbom");
  assertCycloneDx(sbom);
  const sbomPath = join(outputDirectory, "sbom.cdx.json");
  await writeJson(sbomPath, sbom);

  const auditCommand = await capture("npm", ["audit", "--json"], repositoryRoot);
  const audit: unknown = parseJson(auditCommand.stdout, "npm audit");
  const auditPath = join(outputDirectory, "npm-audit.json");
  await writeJson(auditPath, audit);
  const vulnerabilityPolicy = await readJson<VulnerabilityPolicy>(
    join(repositoryRoot, "security/vulnerability-policy.json"),
  );
  const vulnerabilityReport = evaluateVulnerabilityReport(audit, vulnerabilityPolicy);
  const vulnerabilityPath = join(outputDirectory, "vulnerability-report.json");
  await writeJson(vulnerabilityPath, vulnerabilityReport);

  const artifactPaths = [licensePath, sbomPath, auditPath, vulnerabilityPath];
  const artifactManifest = {
    schemaVersion: 1,
    artifacts: await Promise.all(
      artifactPaths.map(async (path) => ({
        path: path.slice(repositoryRoot.length + 1),
        sha256: await sha256File(path),
      })),
    ),
    counts: {
      licenses: licenseReport.packageCount,
      sbomComponents: sbom.components.length,
      sbomDependencies: sbom.dependencies.length,
      vulnerabilities: vulnerabilityReport.findings.length,
    },
  };
  await writeJson(join(outputDirectory, "supply-chain-artifacts.json"), artifactManifest);

  const failures: string[] = [];
  if (licenseReport.status === "FAIL") failures.push(...licenseReport.violations);
  if (vulnerabilityReport.status === "FAIL") failures.push(...vulnerabilityReport.errors);
  if (failures.length > 0) throw new Error(failures.join(" "));
  process.stdout.write(
    `supply chain: PASS (${String(licenseReport.packageCount)} packages, ${String(sbom.components.length)} SBOM components, ${String(vulnerabilityReport.findings.length)} vulnerabilities)\n`,
  );
}

function validateVulnerabilityPolicy(policy: VulnerabilityPolicy, now: Date): string[] {
  const errors: string[] = [];
  if (!isVulnerabilityPolicy(policy)) {
    return ["Vulnerability policy is invalid."];
  }
  for (const waiver of policy.waivers) {
    const created = parseDate(waiver.created);
    const expires = parseDate(waiver.expires);
    if (
      waiver.package.length === 0 ||
      waiver.severity.length === 0 ||
      waiver.owner.length === 0 ||
      waiver.reason.length === 0 ||
      waiver.advisoryUrls.length === 0 ||
      waiver.advisoryUrls.some((url) => !/^https:\/\//u.test(url)) ||
      created === null ||
      expires === null
    ) {
      errors.push(`Waiver for ${waiver.package || "unknown package"} is incomplete.`);
      continue;
    }
    const durationDays = (expires.getTime() - created.getTime()) / 86_400_000;
    if (durationDays < 0 || durationDays > policy.maximumWaiverDays) {
      errors.push(`Waiver for ${waiver.package} exceeds the maximum duration.`);
    }
    if (now.getTime() > expires.getTime() + 86_399_999) {
      errors.push(`Waiver for ${waiver.package} is expired.`);
    }
  }
  return errors;
}

function activeOn(waiver: VulnerabilityWaiver, now: Date): boolean {
  const created = parseDate(waiver.created);
  const expires = parseDate(waiver.expires);
  return (
    created !== null &&
    expires !== null &&
    created.getTime() <= now.getTime() &&
    now.getTime() <= expires.getTime() + 86_399_999
  );
}

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function collectAdvisoryUrls(via: unknown): readonly string[] {
  if (!Array.isArray(via)) return [];
  return via
    .flatMap((entry) => (isRecord(entry) && typeof entry.url === "string" ? [entry.url] : []))
    .sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort((a, b) => a.localeCompare(b));
  const sortedRight = [...right].sort((a, b) => a.localeCompare(b));
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function packageNameFromPath(path: string): string {
  const marker = "node_modules/";
  return path.slice(path.lastIndexOf(marker) + marker.length);
}

function assertCycloneDx(candidate: unknown): asserts candidate is {
  readonly bomFormat: "CycloneDX";
  readonly specVersion: string;
  readonly components: readonly unknown[];
  readonly dependencies: readonly unknown[];
} {
  if (
    !isRecord(candidate) ||
    candidate.bomFormat !== "CycloneDX" ||
    typeof candidate.specVersion !== "string" ||
    !Array.isArray(candidate.components) ||
    candidate.components.length === 0 ||
    !Array.isArray(candidate.dependencies) ||
    candidate.dependencies.length === 0
  ) {
    throw new Error("npm sbom did not return a valid non-empty CycloneDX document.");
  }
}

function capture(
  command: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<CapturedCommand> {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(command, [...arguments_], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectCapture);
    child.once("close", (code, signal) => {
      if (signal !== null) {
        rejectCapture(new Error(`${command} ended with signal ${signal}.`));
        return;
      }
      resolveCapture({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new Error(`${label} did not return JSON.`, { cause });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function safeTail(value: string): string {
  return value
    .trim()
    .slice(-1_000)
    .replaceAll(/(token|password|secret)=\S+/giu, "$1=[REDACTED]");
}

function isVulnerabilityPolicy(value: unknown): value is VulnerabilityPolicy {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isStringArray(value.blockingSeverities) ||
    !isStringArray(value.reportingSeverities) ||
    !Number.isInteger(value.maximumWaiverDays) ||
    typeof value.maximumWaiverDays !== "number" ||
    value.maximumWaiverDays <= 0 ||
    !Array.isArray(value.waivers)
  ) {
    return false;
  }
  return value.waivers.every(
    (waiver) =>
      isRecord(waiver) &&
      typeof waiver.package === "string" &&
      typeof waiver.severity === "string" &&
      isStringArray(waiver.advisoryUrls) &&
      typeof waiver.owner === "string" &&
      typeof waiver.reason === "string" &&
      typeof waiver.created === "string" &&
      typeof waiver.expires === "string",
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    await runSupplyChain(repositoryRoot);
  } catch (error) {
    process.stderr.write(`supply chain: FAIL (${String(error)})\n`);
    process.exitCode = 1;
  }
}
