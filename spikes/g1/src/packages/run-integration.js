import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { hostname, platform, release } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PackageReleaseStore } from "./release-store.js";
import { compilePackageRuntimeProbe } from "./runtime-bridge.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(currentDirectory, "..", "..");
const timestamp = new Date().toISOString().replaceAll(":", "");
const evidenceDirectory = join(projectDirectory, "evidence", "raw", `${timestamp}-spike-d`);
await mkdir(evidenceDirectory, { recursive: true });

const work = await loadJson(join(projectDirectory, "packages", "work-management", "package.json"));
const commerce = await loadJson(join(projectDirectory, "packages", "commerce", "package.json"));
const store = new PackageReleaseStore();
const assertions = [];

const workRelease = store.install(work);
const commerceRelease = store.install(commerce);
check("both structurally different packages install through one loader", Boolean(workRelease && commerceRelease), {
  work: workRelease.revisionId,
  commerce: commerceRelease.revisionId,
});
const runtimeProbes = [work, commerce].map((manifest) => ({
  packageApiName: manifest.packageApiName,
  probe: compilePackageRuntimeProbe(manifest),
}));
check("both packages use the same view/search, link, policy, and action runtime bridge", runtimeProbes.every(({ probe }) => (
  probe.viewCompilations.length === 2
  && probe.linkCompilations.length === 5
  && probe.policyCompilations.length === 2
  && probe.actionPlans.length === 3
)), runtimeProbes.map(({ packageApiName, probe }) => ({
  packageApiName,
  releaseRevision: probe.releaseRevision,
  views: probe.viewCompilations.length,
  links: probe.linkCompilations.length,
  policies: probe.policyCompilations.length,
  actions: probe.actionPlans.length,
})));

const executionBeforeUpgrade = store.recordActionExecution({
  executionId: "commerce-confirm-before-upgrade",
  packageApiName: commerce.packageApiName,
  actionApiName: "confirmOrder",
  payload: { orderId: "ORDER-1", expectedVersion: 1 },
});
const compatible = structuredClone(commerce);
compatible.version = "1.1.0";
compatible.resources.objectTypes
  .find((objectType) => objectType.apiName === "Shipment")
  .properties.trackingNote = { type: "string", nullable: true };
const upgradeRelease = store.upgrade(compatible);
check("compatible upgrade publishes a new immutable revision", upgradeRelease.parentRevisionId === commerceRelease.revisionId && upgradeRelease.manifest.version === "1.1.0", upgradeRelease);

const breaking = structuredClone(compatible);
breaking.version = "2.0.0";
const order = breaking.resources.objectTypes.find((objectType) => objectType.apiName === "Order");
delete order.properties.total;
breaking.resources.views.find((view) => view.apiName === "orderConsole").fields = ["orderId", "status"];
const releasesBeforeBreaking = store.listReleases(commerce.packageApiName).length;
const breakingCode = captureError(() => store.upgrade(breaking));
check("breaking upgrade is blocked without mutating published releases", breakingCode === "BREAKING_PACKAGE_UPGRADE" && store.listReleases(commerce.packageApiName).length === releasesBeforeBreaking, { breakingCode });

const rollbackRelease = store.rollback(commerce.packageApiName, commerceRelease.revisionId);
check("definition rollback creates a new release and restores v1", rollbackRelease.kind === "rollback" && store.getActiveManifest(commerce.packageApiName).version === "1.0.0", rollbackRelease);
const historical = store.resolveHistoricalAction(executionBeforeUpgrade.executionId);
check("historical action still resolves original action and handler revision", historical.release.revisionId === commerceRelease.revisionId && historical.action.handlerDigest === executionBeforeUpgrade.handlerDigest, {
  execution: historical.execution,
  resolvedRevision: historical.release.revisionId,
});

const domainNames = [
  ...work.resources.objectTypes.map((item) => item.apiName),
  ...work.resources.linkTypes.map((item) => item.apiName),
  ...work.resources.actions.map((item) => item.apiName),
  ...commerce.resources.objectTypes.map((item) => item.apiName),
  ...commerce.resources.linkTypes.map((item) => item.apiName),
  ...commerce.resources.actions.map((item) => item.apiName),
];
const coreFiles = await listFiles(join(projectDirectory, "src"));
const forbiddenHits = [];
for (const path of coreFiles) {
  if (path === fileURLToPath(import.meta.url)) continue;
  const text = await readFile(path, "utf8");
  for (const name of domainNames) {
    const matcher = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
    if (matcher.test(text)) forbiddenHits.push({ file: relative(projectDirectory, path), name });
  }
}
check("kernel source contains no package domain API names", forbiddenHits.length === 0, forbiddenHits);

const packageCapabilityText = JSON.stringify({ work, commerce });
check("packages cannot ship raw SQL, endpoints, query operators, or kernel migrations", !/(rawSql|endpoints|queryOperators|kernelMigrations|databaseMigrations)/.test(packageCapabilityText), null);

const report = {
  status: assertions.every((item) => item.passed) ? "PASS" : "FAIL",
  scope: "two-package-install-upgrade-rollback-history-core-purity",
  packageCounts: {
    work: summarize(work),
    commerce: summarize(commerce),
  },
  releaseCounts: {
    work: store.listReleases(work.packageApiName).length,
    commerce: store.listReleases(commerce.packageApiName).length,
  },
  coreFilesScanned: coreFiles.length - 1,
  assertions,
};
await writeJson(join(evidenceDirectory, "environment.json"), {
  timestamp,
  hostname: hostname(),
  platform: platform(),
  osRelease: release(),
  nodeVersion: process.version,
});
await writeJson(join(evidenceDirectory, "result.json"), report);
await writeFile(join(evidenceDirectory, "command.txt"), "npm run spike:d\n", "utf8");
process.stdout.write(`${JSON.stringify({ evidenceDirectory: relative(projectDirectory, evidenceDirectory), ...report }, null, 2)}\n`);
if (report.status !== "PASS") process.exitCode = 1;

function summarize(manifest) {
  return Object.fromEntries(Object.entries(manifest.resources).map(([key, value]) => [key, value.length]));
}

function captureError(operation) {
  try {
    operation();
    return null;
  } catch (error) {
    return error.code ?? "UNKNOWN";
  }
}

function check(name, passed, detail) {
  assertions.push({ name, passed: Boolean(passed), detail });
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await listFiles(path));
    else if (entry.isFile() && extname(path) === ".js") paths.push(path);
  }
  return paths;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
