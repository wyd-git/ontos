import {
  parseIdempotencyKey,
  parseOntosId,
  type ArtifactDigest,
  type CompatibilityReportContract,
  type PackageManifestContract,
} from "@ontos/contracts";
import {
  PackageDomainError,
  assertPackageCandidateIntegrity,
  preparePackageCandidate,
  type CanonicalTextDigester,
  type PackageInstallInputBinding,
  type PreparedPackageCandidate,
} from "@ontos/metadata-domain";

import {
  MetadataApplicationError,
  parseVerifiedFoundationIdentity,
  type ManagementAuthorizer,
  type PrincipalDirectory,
  type ResolvedFoundationIdentity,
  type VerifiedFoundationIdentity,
} from "./index.ts";

export type PackageChangeOperation = "install" | "upgrade" | "rollback";
export type PackageChangeState = "pending" | "active" | "superseded" | "failed";

export interface PackageValidationResult {
  readonly manifest: PackageManifestContract;
  readonly manifestDigest: ArtifactDigest;
  readonly inputBindingsDigest: ArtifactDigest;
  readonly resourceCount: number;
  readonly artifactCount: number;
}

export interface PackageChangeRecord {
  readonly operation: PackageChangeOperation;
  readonly projectId: string;
  readonly packageId: string;
  readonly packageRevisionId: string;
  readonly installationId: string;
  readonly changeId: string;
  readonly releaseId: string;
  readonly targetChannelName: string;
  readonly requestKey: string;
  readonly requestDigest: ArtifactDigest;
  readonly inputBindings: readonly PackageInstallInputBinding[];
  readonly inputBindingsDigest: ArtifactDigest;
  readonly state: PackageChangeState;
  readonly manifest: PackageManifestContract;
  readonly compatibility: CompatibilityReportContract;
  readonly idempotent: boolean;
}

export interface PackageChangeResult {
  readonly accepted: boolean;
  readonly compatibility: CompatibilityReportContract;
  readonly change: PackageChangeRecord | null;
}

export interface PackageLifecycleRepository {
  readInstallationScope(installationId: string): Promise<{ readonly projectId: string }>;
  installPackage(input: {
    readonly projectId: string;
    readonly targetChannelName: string;
    readonly requestKey: string;
    readonly candidate: PreparedPackageCandidate;
    readonly manifestDigest: ArtifactDigest;
    readonly inputBindingsDigest: ArtifactDigest;
    readonly createdByPrincipalId: string;
  }): Promise<PackageChangeResult>;
  upgradePackage(input: {
    readonly installationId: string | null;
    readonly projectId: string;
    readonly targetChannelName: string;
    readonly requestKey: string;
    readonly candidate: PreparedPackageCandidate;
    readonly manifestDigest: ArtifactDigest;
    readonly inputBindingsDigest: ArtifactDigest;
    readonly createdByPrincipalId: string;
  }): Promise<PackageChangeResult>;
  rollbackPackage(input: {
    readonly installationId: string;
    readonly targetPackageRevisionId: string;
    readonly targetChannelName: string;
    readonly requestKey: string;
    readonly createdByPrincipalId: string;
  }): Promise<PackageChangeResult>;
}

export interface PackageLifecycleApplicationServiceOptions {
  readonly principals: PrincipalDirectory;
  readonly packages: PackageLifecycleRepository;
  readonly authorizer: ManagementAuthorizer;
  readonly digestCanonicalText: CanonicalTextDigester;
}

export class PackageLifecycleApplicationService {
  readonly #principals: PrincipalDirectory;
  readonly #packages: PackageLifecycleRepository;
  readonly #authorizer: ManagementAuthorizer;
  readonly #digest: CanonicalTextDigester;

  constructor(options: PackageLifecycleApplicationServiceOptions) {
    this.#principals = options.principals;
    this.#packages = options.packages;
    this.#authorizer = options.authorizer;
    this.#digest = options.digestCanonicalText;
  }

  async validatePackage(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<PackageValidationResult> {
    const command = parseValidatePackageCommand(commandInput);
    const identity = await this.#resolveIdentity(identityInput);
    await this.#requirePackagePermission(identity, command.projectId);
    const prepared = prepareCandidate(command);
    const integrity = assertPreparedIntegrity(prepared, this.#digest);
    return Object.freeze({
      manifest: prepared.manifest,
      manifestDigest: integrity.manifestDigest,
      inputBindingsDigest: integrity.inputBindingsDigest,
      resourceCount: prepared.resources.length,
      artifactCount: prepared.manifest.artifactDigests.length,
    });
  }

  async installPackage(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<PackageChangeResult> {
    return this.#preparePackageChange("install", identityInput, commandInput);
  }

  async upgradePackage(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<PackageChangeResult> {
    return this.#preparePackageChange("upgrade", identityInput, commandInput, null);
  }

  async upgradePackageInstallation(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<PackageChangeResult> {
    const command = parseUpgradePackageInstallationCommand(commandInput);
    const identity = await this.#resolveIdentity(identityInput);
    const scope = await this.#packages.readInstallationScope(command.installationId);
    await this.#requirePackagePermission(identity, scope.projectId);
    const candidate = prepareCandidate(command);
    const integrity = assertPreparedIntegrity(candidate, this.#digest);
    return this.#packages.upgradePackage({
      installationId: command.installationId,
      projectId: scope.projectId,
      targetChannelName: command.targetChannelName,
      requestKey: command.requestKey,
      candidate,
      ...integrity,
      createdByPrincipalId: identity.principalId,
    });
  }

  async rollbackPackage(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<PackageChangeResult> {
    const command = parseRollbackPackageCommand(commandInput);
    const identity = await this.#resolveIdentity(identityInput);
    const scope = await this.#packages.readInstallationScope(command.installationId);
    await this.#requirePackagePermission(identity, scope.projectId);
    return this.#packages.rollbackPackage({
      ...command,
      createdByPrincipalId: identity.principalId,
    });
  }

  async #preparePackageChange(
    operation: "install" | "upgrade",
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
    installationId?: string | null,
  ): Promise<PackageChangeResult> {
    const command = parsePreparePackageCommand(commandInput);
    const identity = await this.#resolveIdentity(identityInput);
    await this.#requirePackagePermission(identity, command.projectId);
    const candidate = prepareCandidate(command);
    const integrity = assertPreparedIntegrity(candidate, this.#digest);
    const input = {
      projectId: command.projectId,
      targetChannelName: command.targetChannelName,
      requestKey: command.requestKey,
      candidate,
      ...integrity,
      createdByPrincipalId: identity.principalId,
    };
    return operation === "install"
      ? this.#packages.installPackage(input)
      : this.#packages.upgradePackage({ ...input, installationId: installationId ?? null });
  }

  async #resolveIdentity(
    identityInput: VerifiedFoundationIdentity,
  ): Promise<ResolvedFoundationIdentity> {
    const identity = parseVerifiedFoundationIdentity(identityInput);
    const principal = await this.#principals.resolveVerifiedIdentity(identity);
    if (principal.issuer !== identity.issuer || principal.subject !== identity.subject) {
      throw new MetadataApplicationError(
        "STORAGE_FAILURE",
        "Principal Directory returned a mismatched external identity.",
      );
    }
    if (principal.state !== "active") {
      throw new MetadataApplicationError("FORBIDDEN", "Principal is disabled.");
    }
    return Object.freeze({
      principalId: principal.principalId,
      claimsFingerprint: identity.claimsFingerprint,
      authenticatedAt: identity.authenticatedAt,
    });
  }

  async #requirePackagePermission(
    identity: ResolvedFoundationIdentity,
    projectId: string,
  ): Promise<void> {
    if (
      !(await this.#authorizer.authorize(identity, { projectId, permission: "package.manage" }))
    ) {
      throw new MetadataApplicationError("FORBIDDEN", "Package management permission was denied.");
    }
  }
}

interface CandidatePayload {
  readonly manifest: unknown;
  readonly resources: unknown;
  readonly installInputBindings: unknown;
}

interface CandidateCommand extends CandidatePayload {
  readonly projectId: string;
}

interface PrepareCommand extends CandidateCommand {
  readonly targetChannelName: string;
  readonly requestKey: string;
}

function parseValidatePackageCommand(value: unknown): CandidateCommand {
  const record = strictRecord(value, [
    "projectId",
    "manifest",
    "resources",
    "installInputBindings",
  ]);
  return Object.freeze({
    projectId: ontosIdentifier(record["projectId"], "projectId"),
    manifest: record["manifest"],
    resources: record["resources"],
    installInputBindings: record["installInputBindings"],
  });
}

function parsePreparePackageCommand(value: unknown): PrepareCommand {
  const record = strictRecord(value, [
    "projectId",
    "targetChannelName",
    "requestKey",
    "manifest",
    "resources",
    "installInputBindings",
  ]);
  return Object.freeze({
    projectId: ontosIdentifier(record["projectId"], "projectId"),
    targetChannelName: channelName(record["targetChannelName"]),
    requestKey: idempotencyKey(record["requestKey"]),
    manifest: record["manifest"],
    resources: record["resources"],
    installInputBindings: record["installInputBindings"],
  });
}

function parseUpgradePackageInstallationCommand(value: unknown): CandidatePayload & {
  readonly installationId: string;
  readonly targetChannelName: string;
  readonly requestKey: string;
} {
  const record = strictRecord(value, [
    "installationId",
    "targetChannelName",
    "requestKey",
    "manifest",
    "resources",
    "installInputBindings",
  ]);
  return Object.freeze({
    installationId: ontosIdentifier(record["installationId"], "installationId"),
    targetChannelName: channelName(record["targetChannelName"]),
    requestKey: idempotencyKey(record["requestKey"]),
    manifest: record["manifest"],
    resources: record["resources"],
    installInputBindings: record["installInputBindings"],
  });
}

function parseRollbackPackageCommand(value: unknown): {
  readonly installationId: string;
  readonly targetPackageRevisionId: string;
  readonly targetChannelName: string;
  readonly requestKey: string;
} {
  const record = strictRecord(value, [
    "installationId",
    "targetPackageRevisionId",
    "targetChannelName",
    "requestKey",
  ]);
  return Object.freeze({
    installationId: ontosIdentifier(record["installationId"], "installationId"),
    targetPackageRevisionId: ontosIdentifier(
      record["targetPackageRevisionId"],
      "targetPackageRevisionId",
    ),
    targetChannelName: channelName(record["targetChannelName"]),
    requestKey: idempotencyKey(record["requestKey"]),
  });
}

function prepareCandidate(command: CandidatePayload): PreparedPackageCandidate {
  try {
    return preparePackageCandidate(command);
  } catch (error) {
    throw mapPackageDomainError(error);
  }
}

function assertPreparedIntegrity(
  candidate: PreparedPackageCandidate,
  digest: CanonicalTextDigester,
) {
  try {
    return assertPackageCandidateIntegrity(candidate, digest);
  } catch (error) {
    throw mapPackageDomainError(error);
  }
}

function mapPackageDomainError(error: unknown): MetadataApplicationError {
  if (error instanceof PackageDomainError) {
    return new MetadataApplicationError("INVALID_INPUT", `${error.code}: ${error.message}`, {
      cause: error,
    });
  }
  return new MetadataApplicationError("INVALID_INPUT", "Package input is invalid.", {
    cause: error,
  });
}

function strictRecord(
  value: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MetadataApplicationError("INVALID_INPUT", "Input must be an object.");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MetadataApplicationError("INVALID_INPUT", "Input must be a plain object.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new MetadataApplicationError(
      "INVALID_INPUT",
      "Input contains missing or unsupported fields.",
    );
  }
  return record;
}

function ontosIdentifier(value: unknown, field: string): string {
  try {
    return parseOntosId(value, `$command.${field}`);
  } catch (error) {
    throw new MetadataApplicationError("INVALID_INPUT", `${field} is invalid.`, { cause: error });
  }
}

function idempotencyKey(value: unknown): string {
  try {
    return parseIdempotencyKey(value, "$command.requestKey");
  } catch (error) {
    throw new MetadataApplicationError("INVALID_INPUT", "requestKey is invalid.", { cause: error });
  }
}

function channelName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,62}$/u.test(value)) {
    throw new MetadataApplicationError("INVALID_INPUT", "targetChannelName is invalid.");
  }
  return value;
}
