import { invariant } from "../core/kernel-error.js";
import { stableHash } from "../core/stable-json.js";
import { compareManifests, manifestDigest, validateManifest } from "./manifest.js";

export class PackageReleaseStore {
  #packages = new Map();
  #actionHistory = new Map();
  #nextRevision = 1;

  install(manifest) {
    const summary = validateManifest(manifest);
    invariant(!this.#packages.has(summary.packageApiName), "PACKAGE_ALREADY_INSTALLED", `Package ${summary.packageApiName} is already installed`);
    return this.#appendRelease(manifest, { kind: "install" });
  }

  upgrade(manifest) {
    const summary = validateManifest(manifest);
    const packageState = this.#packages.get(summary.packageApiName);
    invariant(packageState, "PACKAGE_NOT_INSTALLED", `Package ${summary.packageApiName} is not installed`);
    const previous = this.getActiveManifest(summary.packageApiName);
    invariant(compareSemver(manifest.version, previous.version) > 0, "INVALID_PACKAGE_UPGRADE", "Upgrade version must increase");
    const comparison = compareManifests(previous, manifest);
    invariant(comparison.compatible, "BREAKING_PACKAGE_UPGRADE", "Breaking package upgrade requires an explicit migration path", { changes: comparison.changes });
    return this.#appendRelease(manifest, { kind: "upgrade", comparison });
  }

  rollback(packageApiName, targetRevisionId) {
    const packageState = this.#packages.get(packageApiName);
    invariant(packageState, "PACKAGE_NOT_INSTALLED", `Package ${packageApiName} is not installed`);
    const target = packageState.releases.find((release) => release.revisionId === targetRevisionId);
    invariant(target, "PACKAGE_REVISION_NOT_FOUND", `Unknown package revision ${targetRevisionId}`);
    invariant(packageState.activeRevisionId !== targetRevisionId, "PACKAGE_REVISION_ALREADY_ACTIVE", "Target revision is already active");
    const rollback = this.#appendRelease(target.manifest, {
      kind: "rollback",
      rollbackOfRevisionId: packageState.activeRevisionId,
      restoredFromRevisionId: targetRevisionId,
      reuseVersion: true,
    });
    return rollback;
  }

  recordActionExecution({ executionId, packageApiName, actionApiName, payload = {} }) {
    invariant(typeof executionId === "string" && executionId.length > 0, "INVALID_ACTION_HISTORY", "executionId is required");
    invariant(!this.#actionHistory.has(executionId), "ACTION_EXECUTION_EXISTS", `Action execution ${executionId} already exists`);
    const release = this.getActiveRelease(packageApiName);
    const action = release.manifest.resources.actions.find((item) => item.apiName === actionApiName);
    invariant(action, "ACTION_NOT_FOUND", `Unknown action ${actionApiName}`);
    const record = Object.freeze({
      executionId,
      packageApiName,
      actionApiName,
      packageRevisionId: release.revisionId,
      packageManifestDigest: release.manifestDigest,
      packageVersion: release.manifest.version,
      handlerDigest: action.handlerDigest,
      payloadHash: stableHash(payload),
    });
    this.#actionHistory.set(executionId, record);
    return record;
  }

  resolveHistoricalAction(executionId) {
    const execution = this.#actionHistory.get(executionId);
    invariant(execution, "ACTION_EXECUTION_NOT_FOUND", `Unknown action execution ${executionId}`);
    const packageState = this.#packages.get(execution.packageApiName);
    const release = packageState.releases.find((item) => item.revisionId === execution.packageRevisionId);
    invariant(release, "PACKAGE_HISTORY_CORRUPT", `Missing pinned release ${execution.packageRevisionId}`);
    const action = release.manifest.resources.actions.find((item) => item.apiName === execution.actionApiName);
    invariant(action && action.handlerDigest === execution.handlerDigest, "PACKAGE_HISTORY_CORRUPT", "Pinned action revision does not match execution");
    return Object.freeze({ execution, release, action });
  }

  getActiveRelease(packageApiName) {
    const packageState = this.#packages.get(packageApiName);
    invariant(packageState, "PACKAGE_NOT_INSTALLED", `Package ${packageApiName} is not installed`);
    return packageState.releases.find((release) => release.revisionId === packageState.activeRevisionId);
  }

  getActiveManifest(packageApiName) {
    return this.getActiveRelease(packageApiName).manifest;
  }

  listReleases(packageApiName) {
    const packageState = this.#packages.get(packageApiName);
    invariant(packageState, "PACKAGE_NOT_INSTALLED", `Package ${packageApiName} is not installed`);
    return packageState.releases.map((release) => ({ ...release }));
  }

  #appendRelease(manifest, metadata) {
    validateManifest(manifest);
    const packageApiName = manifest.packageApiName;
    const packageState = this.#packages.get(packageApiName) ?? { activeRevisionId: null, releases: [] };
    const revisionId = `${packageApiName}:r${this.#nextRevision++}`;
    const release = Object.freeze({
      revisionId,
      kind: metadata.kind,
      parentRevisionId: packageState.activeRevisionId,
      rollbackOfRevisionId: metadata.rollbackOfRevisionId ?? null,
      restoredFromRevisionId: metadata.restoredFromRevisionId ?? null,
      manifestDigest: manifestDigest(manifest),
      manifest: deepFreeze(structuredClone(manifest)),
    });
    packageState.releases.push(release);
    packageState.activeRevisionId = revisionId;
    this.#packages.set(packageApiName, packageState);
    return release;
  }
}

function compareSemver(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
