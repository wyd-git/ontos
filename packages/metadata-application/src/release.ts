import {
  parseOntosId,
  type ArtifactDigest,
  type CompatibilityReportContract,
  type ReleaseBinding,
  type ReleaseManifestContract,
  type ValidationReportContract,
} from "@ontos/contracts";
import {
  METADATA_RELEASE_VALIDATOR_VERSION,
  type ReleaseLifecycleState,
} from "@ontos/metadata-domain";

import {
  MetadataApplicationError,
  parseVerifiedFoundationIdentity,
  type ManagementAuthorizer,
  type PrincipalDirectory,
  type ResolvedFoundationIdentity,
  type VerifiedFoundationIdentity,
} from "./index.ts";

export interface ReleaseRecord {
  readonly releaseId: string;
  readonly projectId: string;
  readonly rollbackOfReleaseId: string | null;
  readonly releaseNumber: bigint;
  readonly manifestDigest: ArtifactDigest;
  readonly state: ReleaseLifecycleState;
  readonly targetChannelName: string;
  readonly stagedFromReleaseId: string | null;
  readonly stagedFromActivationId: string | null;
  readonly stagedChannelControlSequence: bigint | null;
  readonly stagedValidationContextDigest: ArtifactDigest | null;
  readonly createdByPrincipalId: string;
  readonly publishedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly stagedAt: string | null;
  readonly publishedAt: string | null;
  readonly manifest: ReleaseManifestContract;
}

export interface ReleaseValidationResult {
  readonly release: ReleaseRecord;
  readonly report: ValidationReportContract;
  readonly compatibility: CompatibilityReportContract;
  readonly validationContextDigest: ArtifactDigest;
}

export interface ReleaseStageResult extends ReleaseValidationResult {
  readonly staged: boolean;
}

export interface PublishedReleaseBinding {
  readonly binding: ReleaseBinding;
  readonly channelName: string;
  readonly channelControlSequence: bigint;
  readonly projectPublicationSequence: bigint;
  readonly authorizationEpoch: bigint;
}

export interface ReleaseRollbackResult {
  readonly release: ReleaseRecord;
  readonly validation: ReleaseValidationResult;
  readonly publication: PublishedReleaseBinding;
}

export interface ReleaseLifecycleRepository {
  readReleaseScope(releaseId: string): Promise<{ readonly projectId: string }>;
  getRelease(releaseId: string): Promise<ReleaseRecord>;
  createReleaseDraft(input: {
    readonly projectId: string;
    readonly targetChannelName: string;
    readonly revisionIds: readonly string[];
    readonly createdByPrincipalId: string;
  }): Promise<ReleaseRecord>;
  validateReleaseDraft(input: {
    readonly releaseId: string;
    readonly validatorVersion: string;
  }): Promise<ReleaseValidationResult>;
  stageRelease(input: {
    readonly releaseId: string;
    readonly validatorVersion: string;
  }): Promise<ReleaseStageResult>;
  publishRelease(input: {
    readonly releaseId: string;
    readonly expectedChannelControlSequence: bigint;
    readonly publishedByPrincipalId: string;
  }): Promise<PublishedReleaseBinding>;
  createRollbackDraft(input: {
    readonly sourceReleaseId: string;
    readonly createdByPrincipalId: string;
  }): Promise<ReleaseRecord>;
}

export interface ReleaseLifecycleApplicationServiceOptions {
  readonly principals: PrincipalDirectory;
  readonly releases: ReleaseLifecycleRepository;
  readonly authorizer: ManagementAuthorizer;
}

export class ReleaseLifecycleApplicationService {
  readonly #principals: PrincipalDirectory;
  readonly #releases: ReleaseLifecycleRepository;
  readonly #authorizer: ManagementAuthorizer;

  constructor(options: ReleaseLifecycleApplicationServiceOptions) {
    this.#principals = options.principals;
    this.#releases = options.releases;
    this.#authorizer = options.authorizer;
  }

  async createRelease(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ReleaseRecord> {
    const command = parseCreateReleaseCommand(commandInput);
    const identity = await this.#resolveIdentity(identityInput);
    await this.#requirePermission(identity, command.projectId, "metadata.edit");
    return this.#releases.createReleaseDraft({
      ...command,
      createdByPrincipalId: identity.principalId,
    });
  }

  async getRelease(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ReleaseRecord> {
    const { releaseId } = parseReleaseIdentifierCommand(commandInput);
    const identity = await this.#resolveIdentity(identityInput);
    const scope = await this.#releases.readReleaseScope(releaseId);
    await this.#requirePermission(identity, scope.projectId, "metadata.read");
    return this.#releases.getRelease(releaseId);
  }

  async validateRelease(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ReleaseValidationResult> {
    const { releaseId } = parseReleaseIdentifierCommand(commandInput);
    const identity = await this.#resolveIdentity(identityInput);
    const scope = await this.#releases.readReleaseScope(releaseId);
    await this.#requirePermission(identity, scope.projectId, "metadata.edit");
    return this.#releases.validateReleaseDraft({
      releaseId,
      validatorVersion: METADATA_RELEASE_VALIDATOR_VERSION,
    });
  }

  async stageRelease(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ReleaseStageResult> {
    const { releaseId } = parseReleaseIdentifierCommand(commandInput);
    const identity = await this.#resolveIdentity(identityInput);
    const scope = await this.#releases.readReleaseScope(releaseId);
    await this.#requirePermission(identity, scope.projectId, "metadata.edit");
    return this.#releases.stageRelease({
      releaseId,
      validatorVersion: METADATA_RELEASE_VALIDATOR_VERSION,
    });
  }

  async publishRelease(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<PublishedReleaseBinding> {
    const command = parsePublishReleaseCommand(commandInput);
    const identity = await this.#resolveIdentity(identityInput);
    const scope = await this.#releases.readReleaseScope(command.releaseId);
    await this.#requirePermission(identity, scope.projectId, "release.publish");
    return this.#releases.publishRelease({
      ...command,
      publishedByPrincipalId: identity.principalId,
    });
  }

  async rollbackRelease(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ReleaseRollbackResult> {
    const command = parsePublishReleaseCommand(commandInput);
    const identity = await this.#resolveIdentity(identityInput);
    const scope = await this.#releases.readReleaseScope(command.releaseId);
    await this.#requirePermission(identity, scope.projectId, "release.publish");

    const draft = await this.#releases.createRollbackDraft({
      sourceReleaseId: command.releaseId,
      createdByPrincipalId: identity.principalId,
    });
    const stage = await this.#releases.stageRelease({
      releaseId: draft.releaseId,
      validatorVersion: METADATA_RELEASE_VALIDATOR_VERSION,
    });
    if (!stage.staged || !stage.report.valid) {
      throw new MetadataApplicationError(
        "INVALID_STATE",
        "The rollback Release did not pass its current validation and compatibility gate.",
      );
    }
    const publication = await this.#releases.publishRelease({
      releaseId: draft.releaseId,
      expectedChannelControlSequence: command.expectedChannelControlSequence,
      publishedByPrincipalId: identity.principalId,
    });
    return Object.freeze({
      release: stage.release,
      validation: stage,
      publication,
    });
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

  async #requirePermission(
    identity: ResolvedFoundationIdentity,
    projectId: string,
    permission: "metadata.read" | "metadata.edit" | "release.publish",
  ): Promise<void> {
    if (!(await this.#authorizer.authorize(identity, { projectId, permission }))) {
      throw new MetadataApplicationError("FORBIDDEN", "Management permission was denied.");
    }
  }
}

function parseCreateReleaseCommand(value: unknown): {
  readonly projectId: string;
  readonly targetChannelName: string;
  readonly revisionIds: readonly string[];
} {
  const record = strictRecord(value, ["projectId", "targetChannelName", "revisionIds"]);
  if (
    typeof record["targetChannelName"] !== "string" ||
    !/^[a-z][a-z0-9_-]{0,62}$/u.test(record["targetChannelName"])
  ) {
    throw new MetadataApplicationError("INVALID_INPUT", "targetChannelName is invalid.");
  }
  if (
    !Array.isArray(record["revisionIds"]) ||
    record["revisionIds"].length < 1 ||
    record["revisionIds"].length > 512
  ) {
    throw new MetadataApplicationError(
      "INVALID_INPUT",
      "revisionIds must contain between 1 and 512 entries.",
    );
  }
  const revisionIds = record["revisionIds"].map((value, index) =>
    ontosIdentifier(value, `revisionIds[${String(index)}]`),
  );
  if (new Set(revisionIds).size !== revisionIds.length) {
    throw new MetadataApplicationError("INVALID_INPUT", "revisionIds contains duplicates.");
  }
  return Object.freeze({
    projectId: ontosIdentifier(record["projectId"], "projectId"),
    targetChannelName: record["targetChannelName"],
    revisionIds: Object.freeze(revisionIds),
  });
}

function parseReleaseIdentifierCommand(value: unknown): { readonly releaseId: string } {
  const record = strictRecord(value, ["releaseId"]);
  return Object.freeze({ releaseId: ontosIdentifier(record["releaseId"], "releaseId") });
}

function parsePublishReleaseCommand(value: unknown): {
  readonly releaseId: string;
  readonly expectedChannelControlSequence: bigint;
} {
  const record = strictRecord(value, ["releaseId", "expectedChannelControlSequence"]);
  if (
    typeof record["expectedChannelControlSequence"] !== "bigint" ||
    record["expectedChannelControlSequence"] < 0n
  ) {
    throw new MetadataApplicationError(
      "INVALID_INPUT",
      "expectedChannelControlSequence must be a non-negative bigint.",
    );
  }
  return Object.freeze({
    releaseId: ontosIdentifier(record["releaseId"], "releaseId"),
    expectedChannelControlSequence: record["expectedChannelControlSequence"],
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
