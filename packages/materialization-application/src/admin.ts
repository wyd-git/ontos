import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseCanonicalInstant,
  parseIdempotencyKey,
  parseOntosId,
  type ArtifactDigest,
  type CanonicalInstant,
} from "@ontos/contracts";
import { defaultCapacityPolicy } from "@ontos/materialization-domain";
import {
  parseVerifiedFoundationIdentity,
  type ManagementAuthorizationRequest,
  type ManagementAuthorizer,
  type PrincipalDirectory,
  type ResolvedFoundationIdentity,
  type VerifiedFoundationIdentity,
} from "@ontos/metadata-application";

type ManagementPermission = ManagementAuthorizationRequest["permission"];

import type { SnapshotGroupCutoverResult } from "./cutover.ts";
import type {
  GarbageCollectionBatchResult,
  GarbageCollectionDryRunRecord,
} from "./garbage-collection.ts";
import type { FinalizedQualityResult } from "./quality.ts";
import type { RuntimeRefreshPreparationResult } from "./runtime-plan.ts";

export type MaterializationAdminErrorCode =
  | "ADMIN_REQUEST_INVALID"
  | "DATA_BEARING_PROJECT_LIMIT_EXCEEDED"
  | "DEPENDENCY_UNAVAILABLE"
  | "FORBIDDEN"
  | "JOB_NOT_CANCELLABLE"
  | "OBJECT_NOT_ACCESSIBLE"
  | "OBJECT_VERSION_CONFLICT";

const adminErrorMessages = Object.freeze({
  ADMIN_REQUEST_INVALID: "The materialization administrator request is invalid.",
  DATA_BEARING_PROJECT_LIMIT_EXCEEDED:
    "The reference deployment already has a data-bearing Project.",
  DEPENDENCY_UNAVAILABLE: "A materialization administrator dependency is unavailable.",
  FORBIDDEN: "The materialization administrator operation is not permitted.",
  JOB_NOT_CANCELLABLE: "The materialization Job is not cancellable.",
  OBJECT_NOT_ACCESSIBLE: "The requested materialization resource is not accessible.",
  OBJECT_VERSION_CONFLICT: "The materialization resource version has changed.",
} satisfies Readonly<Record<MaterializationAdminErrorCode, string>>);

export class MaterializationAdminError extends Error {
  readonly code: MaterializationAdminErrorCode;

  constructor(code: MaterializationAdminErrorCode, options?: ErrorOptions) {
    super(adminErrorMessages[code], options);
    this.name = "MaterializationAdminError";
    this.code = code;
  }
}

export interface MaterializationSnapshotMemberSummary {
  readonly memberKey: string;
  readonly memberKind: "object" | "link";
  readonly snapshotId: string;
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly contentDigest: ArtifactDigest;
  readonly rowCount: number;
  readonly sourceLabel: string;
}

export interface MaterializationSnapshotGroupSummary {
  readonly projectId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
  readonly state:
    "registered" | "validated" | "materializing" | "ready" | "active" | "superseded" | "failed";
  readonly groupDigest: ArtifactDigest;
  readonly memberCount: number;
  readonly createdAt: CanonicalInstant;
  readonly members: readonly MaterializationSnapshotMemberSummary[];
}

export interface MaterializationSnapshotSummary extends MaterializationSnapshotMemberSummary {
  readonly projectId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
  readonly state:
    "registered" | "validated" | "materializing" | "ready" | "active" | "superseded" | "failed";
  readonly byteCount: number;
  readonly createdAt: CanonicalInstant;
}

export interface MaterializationJobStatusView {
  readonly projectId: string;
  readonly jobId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
  readonly state: "queued" | "running" | "retry_wait" | "succeeded" | "dead_letter" | "cancelled";
  readonly currentStage:
    | "scan"
    | "map"
    | "validate"
    | "build_stage"
    | "build_index"
    | "ready_for_activation"
    | "catch_up"
    | "activate"
    | null;
  readonly attemptCount: number;
  readonly cancelRequested: boolean;
  readonly resultCode: string | null;
  readonly createdAt: CanonicalInstant;
  readonly updatedAt: CanonicalInstant;
  /** Opaque strong-version value returned as the HTTP ETag. */
  readonly version: string;
  readonly reused?: boolean;
}

export interface MaterializationReportView {
  readonly projectId: string;
  readonly reportId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
  readonly jobId: string;
  readonly outcome: "passed" | "awaiting_confirmation" | "failed";
  readonly totalRows: number;
  readonly acceptedRows: number;
  readonly rejectedRows: number;
  readonly validatorVersion: string;
  readonly reportDigest: ArtifactDigest;
  readonly createdAt: CanonicalInstant;
  readonly reasons: readonly { readonly code: string; readonly count: number }[];
  readonly samples: readonly {
    readonly fileId: string;
    readonly rowNumber: number;
    readonly reasonCode: string;
    readonly fingerprint: ArtifactDigest;
  }[];
}

export interface MaterializationCapacityStatusView {
  readonly projectId: string;
  readonly generationId: string;
  readonly inventoryRevision: bigint;
  readonly phase: "PREBUILD" | "POSTBUILD" | null;
  readonly measuredBytes: bigint | null;
  readonly reservedBytes: bigint | null;
  readonly steadyReservedBytes: bigint | null;
  readonly peakReservedBytes: bigint | null;
  readonly reportDigest: ArtifactDigest | null;
  readonly approval: MaterializationCapacityApprovalView | null;
}

export interface MaterializationCapacityApprovalView {
  readonly approvalId: string;
  readonly scope: "release" | "project_steady" | "project_peak" | "index";
  readonly scopeId: string | null;
  readonly approvedLimitBytes: bigint;
  readonly hardLimitBytes: bigint;
  readonly evidenceDigest: ArtifactDigest;
  readonly state: "active" | "revoked" | "expired";
  readonly expiresAt: CanonicalInstant;
  readonly reused: boolean;
}

export interface MaterializationAdminRepository {
  getSnapshotGroup(input: {
    readonly projectId: string;
    readonly snapshotGroupId: string;
    readonly groupVersion: number;
  }): Promise<MaterializationSnapshotGroupSummary>;
  getSnapshot(input: {
    readonly projectId: string;
    readonly snapshotId: string;
  }): Promise<MaterializationSnapshotSummary>;
  enqueueJob(input: {
    readonly projectId: string;
    readonly snapshotGroupId: string;
    readonly groupVersion: number;
    readonly idempotencyKey: string;
    readonly jobId: string;
    readonly correlationId: string;
    readonly priority: number;
  }): Promise<MaterializationJobStatusView>;
  getJob(input: {
    readonly projectId: string;
    readonly jobId: string;
  }): Promise<MaterializationJobStatusView>;
  cancelJob(input: {
    readonly projectId: string;
    readonly jobId: string;
    readonly principalId: string;
    readonly expectedVersion: string;
  }): Promise<MaterializationJobStatusView>;
  getReport(input: {
    readonly projectId: string;
    readonly reportId: string;
  }): Promise<MaterializationReportView>;
  getCapacityStatus(input: {
    readonly projectId: string;
    readonly generationId: string;
  }): Promise<MaterializationCapacityStatusView>;
  approveCapacity(input: {
    readonly projectId: string;
    readonly approvalId: string;
    readonly principalId: string;
    readonly scope: "release" | "project_steady" | "project_peak" | "index";
    readonly scopeId: string | null;
    readonly approvedLimitBytes: bigint;
    readonly hardLimitBytes: bigint;
    readonly expectedInventoryRevision: bigint;
    readonly evidenceDigest: ArtifactDigest;
    readonly expiresAt: CanonicalInstant;
  }): Promise<MaterializationCapacityApprovalView>;
  assertGcPlanBinding(input: {
    readonly projectId: string;
    readonly planId: string;
    readonly expectedPlanDigest: ArtifactDigest;
  }): Promise<void>;
}

export interface MaterializationAdminActivationPort {
  activate(input: unknown): Promise<SnapshotGroupCutoverResult>;
}

export interface MaterializationAdminRefreshPort {
  prepareSnapshotGroupRefresh(input: unknown): Promise<RuntimeRefreshPreparationResult>;
}

export interface MaterializationAdminConfirmationPort {
  confirm(
    identity: VerifiedFoundationIdentity,
    input: {
      readonly projectId: string;
      readonly generationId: string;
      readonly expectedReportDigest: ArtifactDigest;
      readonly expectedPublicationControlSequence: bigint;
      readonly decision: "accepted" | "rejected";
    },
  ): Promise<FinalizedQualityResult>;
}

export interface MaterializationAdminGarbageCollectionPort {
  dryRun(input: {
    readonly projectId: string;
    readonly idempotencyKey: string;
  }): Promise<GarbageCollectionDryRunRecord>;
  commitNext(input: {
    readonly projectId: string;
    readonly planId: string;
  }): Promise<GarbageCollectionBatchResult>;
}

export interface MaterializationAdminCrypto {
  randomId(): string;
  digestCanonicalText(value: string): ArtifactDigest;
}

export interface MaterializationAdminClock {
  now(): CanonicalInstant;
}

export interface MaterializationAdminServiceOptions {
  readonly principals: PrincipalDirectory;
  readonly authorizer: ManagementAuthorizer;
  readonly repository: MaterializationAdminRepository;
  readonly activation: MaterializationAdminActivationPort;
  readonly refresh: MaterializationAdminRefreshPort;
  readonly confirmations: MaterializationAdminConfirmationPort;
  readonly garbageCollection: MaterializationAdminGarbageCollectionPort;
  readonly crypto: MaterializationAdminCrypto;
  readonly clock: MaterializationAdminClock;
}

export class MaterializationAdminService {
  readonly #principals: PrincipalDirectory;
  readonly #authorizer: ManagementAuthorizer;
  readonly #repository: MaterializationAdminRepository;
  readonly #activation: MaterializationAdminActivationPort;
  readonly #refresh: MaterializationAdminRefreshPort;
  readonly #confirmations: MaterializationAdminConfirmationPort;
  readonly #garbageCollection: MaterializationAdminGarbageCollectionPort;
  readonly #crypto: MaterializationAdminCrypto;
  readonly #clock: MaterializationAdminClock;

  constructor(options: MaterializationAdminServiceOptions) {
    this.#principals = options.principals;
    this.#authorizer = options.authorizer;
    this.#repository = options.repository;
    this.#activation = options.activation;
    this.#refresh = options.refresh;
    this.#confirmations = options.confirmations;
    this.#garbageCollection = options.garbageCollection;
    this.#crypto = options.crypto;
    this.#clock = options.clock;
  }

  async getSnapshotGroup(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<MaterializationSnapshotGroupSummary> {
    const command = parseGroupCommand(commandInput);
    await this.#authorize(identityInput, command.projectId, "metadata.read");
    return dependency(() => this.#repository.getSnapshotGroup(command));
  }

  async getSnapshot(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<MaterializationSnapshotSummary> {
    const command = parseSnapshotCommand(commandInput);
    await this.#authorize(identityInput, command.projectId, "metadata.read");
    return dependency(() => this.#repository.getSnapshot(command));
  }

  async startJob(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<MaterializationJobStatusView> {
    const command = parseStartJobCommand(commandInput);
    await this.#authorize(identityInput, command.projectId, "metadata.edit");
    return dependency(() =>
      this.#repository.enqueueJob({
        ...command,
        jobId: generatedId(this.#crypto.randomId()),
        correlationId: generatedId(this.#crypto.randomId()),
      }),
    );
  }

  async getJob(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<MaterializationJobStatusView> {
    const command = parseJobCommand(commandInput);
    await this.#authorize(identityInput, command.projectId, "metadata.read");
    return dependency(() => this.#repository.getJob(command));
  }

  async cancelJob(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<MaterializationJobStatusView> {
    const command = parseCancelJobCommand(commandInput);
    const identity = await this.#authorize(identityInput, command.projectId, "metadata.edit");
    return dependency(() =>
      this.#repository.cancelJob({
        ...command,
        principalId: identity.principalId,
      }),
    );
  }

  async getReport(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<MaterializationReportView> {
    const command = parseReportCommand(commandInput);
    await this.#authorize(identityInput, command.projectId, "metadata.read");
    return dependency(() => this.#repository.getReport(command));
  }

  async activate(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<SnapshotGroupCutoverResult> {
    const command = parseActivationCommand(commandInput);
    await this.#authorize(identityInput, command.projectId, "release.publish");
    return this.#activation.activate(command);
  }

  async refresh(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<RuntimeRefreshPreparationResult> {
    const command = parseRefreshAdminCommand(commandInput);
    await this.#authorize(identityInput, command.projectId, "release.publish");
    return this.#refresh.prepareSnapshotGroupRefresh({
      projectId: command.projectId,
      snapshotGroupId: command.snapshotGroupId,
      groupVersion: command.groupVersion,
    });
  }

  async confirmRowCount(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<FinalizedQualityResult> {
    const command = parseConfirmationCommand(commandInput);
    await this.#authorize(identityInput, command.projectId, "release.publish");
    return this.#confirmations.confirm(identityInput, command);
  }

  async getCapacityStatus(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<MaterializationCapacityStatusView> {
    const command = parseGenerationCommand(commandInput);
    await this.#authorize(identityInput, command.projectId, "metadata.read");
    return dependency(() => this.#repository.getCapacityStatus(command));
  }

  async approveCapacity(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<MaterializationCapacityApprovalView> {
    const command = parseCapacityApprovalCommand(commandInput, this.#clock.now());
    const identity = await this.#authorize(identityInput, command.projectId, "release.publish");
    const hardLimitBytes = hardLimitForScope(command.scope);
    if (command.approvedLimitBytes > hardLimitBytes) {
      throw new MaterializationAdminError("ADMIN_REQUEST_INVALID");
    }
    const approvalId = generatedId(this.#crypto.randomId());
    const evidenceDigest = this.#crypto.digestCanonicalText(
      canonicalizeContractForDigest({
        schemaVersion: 1,
        contractVersion: "materialization-capacity-approval-v1",
        projectId: command.projectId,
        scope: command.scope,
        scopeId: command.scopeId,
        approvedLimitBytes: command.approvedLimitBytes.toString(),
        hardLimitBytes: hardLimitBytes.toString(),
        expectedInventoryRevision: command.expectedInventoryRevision.toString(),
        expiresAt: command.expiresAt,
      }),
    );
    return dependency(() =>
      this.#repository.approveCapacity({
        ...command,
        approvalId,
        principalId: identity.principalId,
        hardLimitBytes,
        evidenceDigest,
      }),
    );
  }

  async dryRunGarbageCollection(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<GarbageCollectionDryRunRecord> {
    const command = parseGcDryRunCommand(commandInput);
    await this.#authorize(identityInput, command.projectId, "release.publish");
    return this.#garbageCollection.dryRun(command);
  }

  async commitGarbageCollection(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<GarbageCollectionBatchResult> {
    const command = parseGcCommitCommand(commandInput);
    await this.#authorize(identityInput, command.projectId, "release.publish");
    await dependency(() => this.#repository.assertGcPlanBinding(command));
    return this.#garbageCollection.commitNext({
      projectId: command.projectId,
      planId: command.planId,
    });
  }

  async #authorize(
    identityInput: VerifiedFoundationIdentity,
    projectId: string,
    permission: ManagementPermission,
  ): Promise<ResolvedFoundationIdentity> {
    try {
      const identity = parseVerifiedFoundationIdentity(identityInput);
      const principal = await this.#principals.resolveVerifiedIdentity(identity);
      if (
        principal.state !== "active" ||
        principal.issuer !== identity.issuer ||
        principal.subject !== identity.subject
      ) {
        throw new Error("identity mismatch");
      }
      const resolved = Object.freeze({
        principalId: parseOntosId(principal.principalId),
        claimsFingerprint: identity.claimsFingerprint,
        authenticatedAt: identity.authenticatedAt,
      });
      if (!(await this.#authorizer.authorize(resolved, { projectId, permission }))) {
        throw new Error("permission denied");
      }
      return resolved;
    } catch (cause) {
      throw new MaterializationAdminError("FORBIDDEN", { cause });
    }
  }
}

function parseGroupCommand(input: unknown) {
  const record = strictRecord(input, ["projectId", "snapshotGroupId", "groupVersion"]);
  return Object.freeze({
    projectId: id(record["projectId"]),
    snapshotGroupId: id(record["snapshotGroupId"]),
    groupVersion: positiveInteger(record["groupVersion"]),
  });
}

function parseSnapshotCommand(input: unknown) {
  const record = strictRecord(input, ["projectId", "snapshotId"]);
  return Object.freeze({
    projectId: id(record["projectId"]),
    snapshotId: id(record["snapshotId"]),
  });
}

function parseStartJobCommand(input: unknown) {
  const record = strictRecord(
    input,
    ["projectId", "snapshotGroupId", "groupVersion", "idempotencyKey"],
    ["priority"],
  );
  const priority = record["priority"] ?? 0;
  if (
    !Number.isSafeInteger(priority) ||
    (priority as number) < -100 ||
    (priority as number) > 100
  ) {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID");
  }
  return Object.freeze({
    projectId: id(record["projectId"]),
    snapshotGroupId: id(record["snapshotGroupId"]),
    groupVersion: positiveInteger(record["groupVersion"]),
    idempotencyKey: idempotencyKey(record["idempotencyKey"]),
    priority: priority as number,
  });
}

function parseJobCommand(input: unknown) {
  const record = strictRecord(input, ["projectId", "jobId"]);
  return Object.freeze({ projectId: id(record["projectId"]), jobId: id(record["jobId"]) });
}

function parseCancelJobCommand(input: unknown) {
  const record = strictRecord(input, ["projectId", "jobId", "expectedVersion"]);
  const expectedVersion = boundedText(record["expectedVersion"], 1, 128);
  return Object.freeze({
    projectId: id(record["projectId"]),
    jobId: id(record["jobId"]),
    expectedVersion,
  });
}

function parseReportCommand(input: unknown) {
  const record = strictRecord(input, ["projectId", "reportId"]);
  return Object.freeze({ projectId: id(record["projectId"]), reportId: id(record["reportId"]) });
}

function parseActivationCommand(input: unknown) {
  const record = strictRecord(input, [
    "projectId",
    "snapshotGroupId",
    "groupVersion",
    "expectedControlRevision",
    "idempotencyKey",
  ]);
  return Object.freeze({
    projectId: id(record["projectId"]),
    snapshotGroupId: id(record["snapshotGroupId"]),
    groupVersion: positiveInteger(record["groupVersion"]),
    expectedControlRevision: nonnegativeBigint(record["expectedControlRevision"]),
    idempotencyKey: idempotencyKey(record["idempotencyKey"]),
  });
}

function parseRefreshAdminCommand(input: unknown) {
  const record = strictRecord(input, [
    "projectId",
    "snapshotGroupId",
    "groupVersion",
    "idempotencyKey",
  ]);
  return Object.freeze({
    projectId: id(record["projectId"]),
    snapshotGroupId: id(record["snapshotGroupId"]),
    groupVersion: positiveInteger(record["groupVersion"]),
    idempotencyKey: idempotencyKey(record["idempotencyKey"]),
  });
}

function parseConfirmationCommand(input: unknown) {
  const record = strictRecord(input, [
    "projectId",
    "generationId",
    "expectedReportDigest",
    "expectedPublicationControlSequence",
    "decision",
  ]);
  if (record["decision"] !== "accepted" && record["decision"] !== "rejected") {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID");
  }
  return Object.freeze({
    projectId: id(record["projectId"]),
    generationId: id(record["generationId"]),
    expectedReportDigest: artifactDigest(record["expectedReportDigest"]),
    expectedPublicationControlSequence: nonnegativeBigint(
      record["expectedPublicationControlSequence"],
    ),
    decision: record["decision"],
  });
}

function parseGenerationCommand(input: unknown) {
  const record = strictRecord(input, ["projectId", "generationId"]);
  return Object.freeze({
    projectId: id(record["projectId"]),
    generationId: id(record["generationId"]),
  });
}

function parseCapacityApprovalCommand(input: unknown, nowInput: CanonicalInstant) {
  const record = strictRecord(input, [
    "projectId",
    "scope",
    "scopeId",
    "approvedLimitBytes",
    "expectedInventoryRevision",
    "expiresAt",
  ]);
  const scope = record["scope"];
  if (
    scope !== "release" &&
    scope !== "project_steady" &&
    scope !== "project_peak" &&
    scope !== "index"
  ) {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID");
  }
  const scopeId = record["scopeId"] === null ? null : id(record["scopeId"]);
  if ((scope === "release" || scope === "index") !== (scopeId !== null)) {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID");
  }
  const expiresAt = canonicalInstant(record["expiresAt"]);
  const now = Date.parse(parseCanonicalInstant(nowInput));
  const expiry = Date.parse(expiresAt);
  if (expiry <= now || expiry > now + defaultCapacityPolicy.maximumApprovalMs) {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID");
  }
  return Object.freeze({
    projectId: id(record["projectId"]),
    scope,
    scopeId,
    approvedLimitBytes: positiveBigint(record["approvedLimitBytes"]),
    expectedInventoryRevision: positiveBigint(record["expectedInventoryRevision"]),
    expiresAt,
  });
}

function parseGcDryRunCommand(input: unknown) {
  const record = strictRecord(input, ["projectId", "idempotencyKey"]);
  return Object.freeze({
    projectId: id(record["projectId"]),
    idempotencyKey: idempotencyKey(record["idempotencyKey"]),
  });
}

function parseGcCommitCommand(input: unknown) {
  const record = strictRecord(input, ["projectId", "planId", "expectedPlanDigest"]);
  return Object.freeze({
    projectId: id(record["projectId"]),
    planId: id(record["planId"]),
    expectedPlanDigest: artifactDigest(record["expectedPlanDigest"]),
  });
}

function hardLimitForScope(scope: "release" | "project_steady" | "project_peak" | "index"): bigint {
  switch (scope) {
    case "release":
      return defaultCapacityPolicy.hardMaxReleaseServingBytes;
    case "project_steady":
    case "project_peak":
      return defaultCapacityPolicy.hardMaxProjectPhysicalBytes;
    case "index":
      return defaultCapacityPolicy.hardMaxProjectPhysicalBytes;
  }
}

function strictRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID");
  }
  const record = input as Readonly<Record<string, unknown>>;
  const allowed = new Set([...required, ...optional]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID");
  }
  return record;
}

function id(value: unknown): string {
  try {
    return parseOntosId(value);
  } catch (cause) {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID", { cause });
  }
}

function generatedId(value: unknown): string {
  try {
    return parseOntosId(value);
  } catch (cause) {
    throw new MaterializationAdminError("DEPENDENCY_UNAVAILABLE", { cause });
  }
}

function idempotencyKey(value: unknown): string {
  try {
    return parseIdempotencyKey(value);
  } catch (cause) {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID", { cause });
  }
}

function artifactDigest(value: unknown): ArtifactDigest {
  try {
    return parseArtifactDigest(value);
  } catch (cause) {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID", { cause });
  }
}

function canonicalInstant(value: unknown): CanonicalInstant {
  try {
    return parseCanonicalInstant(value);
  } catch (cause) {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID", { cause });
  }
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID");
  }
  return value as number;
}

function positiveBigint(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID");
  }
  return BigInt(value);
}

function nonnegativeBigint(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID");
  }
  return BigInt(value);
}

function boundedText(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new MaterializationAdminError("ADMIN_REQUEST_INVALID");
  }
  return value;
}

async function dependency<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MaterializationAdminError) throw error;
    throw new MaterializationAdminError("DEPENDENCY_UNAVAILABLE", { cause: error });
  }
}
