import {
  MATERIALIZATION_MEMBER_KEY_PATTERN,
  canonicalizeMaterializationContractForDigest,
  parseArtifactDigest,
  parseCanonicalInstant,
  parseDatasetSnapshot,
  parseOntosId,
  parseSnapshotGroup,
  type ArtifactDigest,
  type CanonicalInstant,
  type DatasetSnapshotContract,
  type SnapshotGroupContract,
  type SnapshotSchemaDefinition,
} from "@ontos/contracts";
import {
  MANAGED_CSV_HARD_LIMITS,
  ManagedCsvError,
  parseManagedCsvMediaType,
  parseManagedSourceLabel,
  scanManagedCsv,
} from "@ontos/materialization-domain";
import {
  parseVerifiedFoundationIdentity,
  type ManagementAuthorizer,
  type PrincipalDirectory,
  type ResolvedFoundationIdentity,
  type VerifiedFoundationIdentity,
} from "@ontos/metadata-application";

export * from "./base.ts";
export * from "./quality.ts";
export * from "./worker.ts";
export * from "./index-capacity.ts";
export * from "./runtime-plan.ts";

export type MaterializationIngressErrorCode =
  | "ADMIN_REQUEST_INVALID"
  | "DEPENDENCY_UNAVAILABLE"
  | "OBJECT_NOT_ACCESSIBLE"
  | "OBJECT_VERSION_CONFLICT"
  | "SNAPSHOT_CONTENT_MISMATCH"
  | "SNAPSHOT_SCHEMA_INVALID";

const ingressErrorMessages = Object.freeze({
  ADMIN_REQUEST_INVALID: "The managed Snapshot request is invalid.",
  DEPENDENCY_UNAVAILABLE: "A managed Snapshot dependency is temporarily unavailable.",
  OBJECT_NOT_ACCESSIBLE: "The managed Snapshot resource is not accessible.",
  OBJECT_VERSION_CONFLICT: "The managed Snapshot state changed concurrently.",
  SNAPSHOT_CONTENT_MISMATCH: "The managed Snapshot content does not match its upload session.",
  SNAPSHOT_SCHEMA_INVALID: "The managed CSV does not match its explicit Snapshot Schema.",
} satisfies Readonly<Record<MaterializationIngressErrorCode, string>>);

export class MaterializationIngressError extends Error {
  readonly code: MaterializationIngressErrorCode;

  constructor(code: MaterializationIngressErrorCode, options?: ErrorOptions) {
    super(ingressErrorMessages[code], options);
    this.name = "MaterializationIngressError";
    this.code = code;
  }
}

export type SnapshotUploadSessionState =
  "created" | "uploaded" | "finalizing" | "finalized" | "failed" | "expired" | "cleaned";

export interface SnapshotUploadSessionRecord {
  readonly projectId: string;
  readonly sessionId: string;
  readonly createdByPrincipalId: string;
  readonly releaseId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
  readonly groupMemberCount: number;
  readonly memberKey: string;
  readonly memberKind: "object" | "link";
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly snapshotSchemaResourceId: string;
  readonly snapshotSchemaRevisionId: string;
  readonly mappingResourceId: string;
  readonly mappingRevisionId: string;
  readonly indexPlanDigest: ArtifactDigest;
  readonly runtimePlanDigest: ArtifactDigest;
  readonly managedArtifactId: string;
  readonly objectKey: string;
  readonly allowedMediaType: "text/csv";
  readonly expectedByteCount: number;
  readonly maxByteCount: number;
  readonly sourceLabel: string;
  readonly finalizeTokenDigest: ArtifactDigest;
  readonly state: SnapshotUploadSessionState;
  readonly uploadedObjectVersion: string | null;
  readonly uploadedByteCount: number | null;
  readonly snapshotId: string | null;
  readonly expiresAt: CanonicalInstant;
  readonly cleanupAfter: CanonicalInstant;
  readonly snapshotSchema: SnapshotSchemaDefinition;
  readonly previousSnapshotId: string | null;
}

export interface SnapshotUploadSessionRepository {
  createUploadSession(input: {
    readonly projectId: string;
    readonly releaseId: string;
    readonly memberKey: string;
    readonly groupVersion: number;
    readonly expectedByteCount: number;
    readonly maxByteCount: number;
    readonly sourceLabel: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly managedArtifactId: string;
    readonly objectKey: string;
    readonly finalizeTokenDigest: ArtifactDigest;
  }): Promise<SnapshotUploadSessionRecord>;
  getUploadSession(input: {
    readonly sessionId: string;
    readonly principalId: string;
  }): Promise<SnapshotUploadSessionRecord>;
  recordUploadedVersion(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly principalId: string;
    readonly objectVersion: string;
    readonly byteCount: number;
  }): Promise<SnapshotUploadSessionRecord>;
  claimFinalizeGroup(input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly claimId: string;
    readonly sessions: readonly {
      readonly sessionId: string;
      readonly finalizeTokenDigest: ArtifactDigest;
    }[];
  }): Promise<
    | {
        readonly kind: "claimed";
        readonly sessions: readonly SnapshotUploadSessionRecord[];
      }
    | {
        readonly kind: "already_finalized";
        readonly result: FinalizedSnapshotGroupResult;
      }
  >;
  renewFinalizeClaim(input: { readonly claimId: string }): Promise<void>;
  completeFinalizeGroup(input: {
    readonly claimId: string;
    readonly group: SnapshotGroupContract;
    readonly snapshots: readonly FinalizedSnapshotRegistration[];
  }): Promise<FinalizedSnapshotGroupResult>;
  finishFinalizeFailure(input: {
    readonly claimId: string;
    readonly failedSessionId: string | null;
    readonly failureCode:
      "DEPENDENCY_UNAVAILABLE" | "SNAPSHOT_CONTENT_MISMATCH" | "SNAPSHOT_SCHEMA_INVALID";
    readonly retryable: boolean;
  }): Promise<void>;
  listObjectCleanupCandidates(limit: number): Promise<readonly SnapshotUploadSessionRecord[]>;
  markObjectCleanupComplete(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly expectedState: SnapshotUploadSessionState;
  }): Promise<void>;
}

export interface FinalizedSnapshotRegistration {
  readonly sessionId: string;
  readonly objectVersion: string;
  readonly sourceLabel: string;
  readonly fileId: string;
  readonly snapshot: DatasetSnapshotContract;
}

export interface FinalizedSnapshotGroupResult {
  readonly group: SnapshotGroupContract;
  readonly snapshots: readonly DatasetSnapshotContract[];
}

export interface ManagedSnapshotObjectStore {
  assertVersioningEnabled(): Promise<void>;
  putVersion(input: {
    readonly objectKey: string;
    readonly body: AsyncIterable<Uint8Array>;
    readonly expectedByteCount: number;
    readonly mediaType: "text/csv";
  }): Promise<{
    readonly versionId: string;
    readonly byteCount: number;
    readonly mediaType: string | null;
  }>;
  headLatestVersion(objectKey: string): Promise<{
    readonly versionId: string;
    readonly byteCount: number;
    readonly mediaType: string | null;
  }>;
  readVersion(
    objectKey: string,
    versionId: string,
  ): Promise<{
    readonly versionId: string;
    readonly byteCount: number;
    readonly mediaType: string | null;
    readonly body: AsyncIterable<Uint8Array>;
  }>;
  deleteVersion(objectKey: string, versionId: string): Promise<void>;
  deleteUnregisteredVersions(
    objectKey: string,
    protectedVersionIds: ReadonlySet<string>,
  ): Promise<number>;
}

export interface StreamingDigestAccumulator {
  update(chunk: Uint8Array): void;
  finish(): ArtifactDigest;
}

export interface MaterializationIngressCrypto {
  randomId(): string;
  randomToken(): string;
  digestText(value: string): ArtifactDigest;
  createStreamingDigest(): StreamingDigestAccumulator;
}

export interface MaterializationIngressClock {
  now(): CanonicalInstant;
}

export interface MaterializationIngressMonotonicClock {
  nowMilliseconds(): number;
}

export interface MaterializationIngressServiceOptions {
  readonly principals: PrincipalDirectory;
  readonly authorizer: ManagementAuthorizer;
  readonly repository: SnapshotUploadSessionRepository;
  readonly objectStore: ManagedSnapshotObjectStore;
  readonly crypto: MaterializationIngressCrypto;
  readonly clock: MaterializationIngressClock;
  readonly monotonicClock: MaterializationIngressMonotonicClock;
  readonly maximumUploadBytes?: number;
}

export interface CreatedSnapshotUploadSession {
  readonly sessionId: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
  readonly targetMemberKey: string;
  readonly mediaType: "text/csv";
  readonly expectedByteCount: number;
  readonly maximumByteCount: number;
  readonly expiresAt: CanonicalInstant;
  readonly uploadPath: string;
  readonly finalizeToken: string;
}

export interface UploadedSnapshotSession {
  readonly sessionId: string;
  readonly state: "uploaded";
  readonly byteCount: number;
}

export interface CleanupSummary {
  readonly examined: number;
  readonly completed: number;
  readonly deferred: number;
  readonly deletedVersions: number;
}

const memberKeyExpression = new RegExp(MATERIALIZATION_MEMBER_KEY_PATTERN, "u");
const finalizeTokenExpression = /^[A-Za-z0-9_-]{43}$/u;
const finalizeLeaseRenewalIntervalMilliseconds = 60_000;

export class MaterializationIngressService {
  readonly #principals: PrincipalDirectory;
  readonly #authorizer: ManagementAuthorizer;
  readonly #repository: SnapshotUploadSessionRepository;
  readonly #objectStore: ManagedSnapshotObjectStore;
  readonly #crypto: MaterializationIngressCrypto;
  readonly #clock: MaterializationIngressClock;
  readonly #monotonicClock: MaterializationIngressMonotonicClock;
  readonly #maximumUploadBytes: number;

  constructor(options: MaterializationIngressServiceOptions) {
    this.#principals = options.principals;
    this.#authorizer = options.authorizer;
    this.#repository = options.repository;
    this.#objectStore = options.objectStore;
    this.#crypto = options.crypto;
    this.#clock = options.clock;
    this.#monotonicClock = options.monotonicClock;
    const maximum = options.maximumUploadBytes ?? MANAGED_CSV_HARD_LIMITS.maximumFileBytes;
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > MANAGED_CSV_HARD_LIMITS.maximumFileBytes
    ) {
      throw new MaterializationIngressError("ADMIN_REQUEST_INVALID");
    }
    this.#maximumUploadBytes = maximum;
  }

  async assertReady(): Promise<void> {
    try {
      await this.#objectStore.assertVersioningEnabled();
    } catch (error) {
      throw asIngressDependencyError(error);
    }
  }

  async createUploadSession(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<CreatedSnapshotUploadSession> {
    const command = parseCreateSessionCommand(commandInput, this.#maximumUploadBytes);
    const principal = await this.#resolveEditor(identityInput, command.projectId);
    const sessionId = parseGeneratedId(this.#crypto.randomId());
    const managedArtifactId = parseGeneratedId(this.#crypto.randomId());
    const finalizeToken = parseGeneratedFinalizeToken(this.#crypto.randomToken());
    const objectKey = `ingress/${managedArtifactId.slice(0, 2)}/${managedArtifactId}.csv`;
    try {
      const session = await this.#repository.createUploadSession({
        ...command,
        maxByteCount: this.#maximumUploadBytes,
        principalId: principal.principalId,
        sessionId,
        managedArtifactId,
        objectKey,
        finalizeTokenDigest: this.#crypto.digestText(finalizeToken),
      });
      return Object.freeze({
        sessionId: session.sessionId,
        projectId: session.projectId,
        releaseId: session.releaseId,
        snapshotGroupId: session.snapshotGroupId,
        groupVersion: session.groupVersion,
        targetMemberKey: session.memberKey,
        mediaType: session.allowedMediaType,
        expectedByteCount: session.expectedByteCount,
        maximumByteCount: session.maxByteCount,
        expiresAt: session.expiresAt,
        uploadPath: `/api/v1/admin/snapshot-upload-sessions/${session.sessionId}/content`,
        finalizeToken,
      });
    } catch (error) {
      throw mapIngressFailure(error);
    }
  }

  async uploadSessionContent(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<UploadedSnapshotSession> {
    const command = parseUploadContentCommand(commandInput);
    const identity = parseTrustedIdentity(identityInput);
    let session: SnapshotUploadSessionRecord;
    try {
      const principal = await this.#principals.resolveVerifiedIdentity(identity);
      session = await this.#repository.getUploadSession({
        sessionId: command.sessionId,
        principalId: principal.principalId,
      });
      await this.#requireEditor(
        resolvedIdentity(identity, principal.principalId),
        session.projectId,
      );
    } catch (error) {
      throw mapIngressFailure(error, "OBJECT_NOT_ACCESSIBLE");
    }
    if (
      session.state !== "created" ||
      command.contentLength !== session.expectedByteCount ||
      command.contentLength > session.maxByteCount
    ) {
      throw new MaterializationIngressError(
        session.state === "created" ? "SNAPSHOT_CONTENT_MISMATCH" : "OBJECT_VERSION_CONFLICT",
      );
    }

    let uploadedVersion: string | null = null;
    try {
      const uploaded = await this.#objectStore.putVersion({
        objectKey: session.objectKey,
        body: command.body,
        expectedByteCount: session.expectedByteCount,
        mediaType: command.mediaType,
      });
      uploadedVersion = uploaded.versionId;
      const recorded = await this.#repository.recordUploadedVersion({
        projectId: session.projectId,
        sessionId: session.sessionId,
        principalId: session.createdByPrincipalId,
        objectVersion: uploaded.versionId,
        byteCount: uploaded.byteCount,
      });
      return Object.freeze({
        sessionId: recorded.sessionId,
        state: "uploaded",
        byteCount: recorded.uploadedByteCount ?? uploaded.byteCount,
      });
    } catch (error) {
      if (uploadedVersion !== null) {
        await this.#objectStore
          .deleteVersion(session.objectKey, uploadedVersion)
          .catch(() => undefined);
      }
      throw mapIngressFailure(error);
    }
  }

  async finalizeSnapshotGroup(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<FinalizedSnapshotGroupResult> {
    const command = parseFinalizeCommand(commandInput);
    const principal = await this.#resolveEditor(identityInput, command.projectId);
    const claimId = parseGeneratedId(this.#crypto.randomId());
    let claim:
      | {
          readonly kind: "claimed";
          readonly sessions: readonly SnapshotUploadSessionRecord[];
        }
      | {
          readonly kind: "already_finalized";
          readonly result: FinalizedSnapshotGroupResult;
        };
    try {
      claim = await this.#repository.claimFinalizeGroup({
        projectId: command.projectId,
        principalId: principal.principalId,
        claimId,
        sessions: command.sessions.map((session) => ({
          sessionId: session.sessionId,
          finalizeTokenDigest: this.#crypto.digestText(session.finalizeToken),
        })),
      });
    } catch (error) {
      throw mapIngressFailure(error);
    }
    if (claim.kind === "already_finalized") return claim.result;

    let currentSessionId: string | null = null;
    try {
      const registrations: FinalizedSnapshotRegistration[] = [];
      const commandBySession = new Map(
        command.sessions.map((session) => [session.sessionId, session] as const),
      );
      for (const session of claim.sessions) {
        currentSessionId = session.sessionId;
        const finalizeInput = commandBySession.get(session.sessionId);
        if (finalizeInput === undefined)
          throw new MaterializationIngressError("ADMIN_REQUEST_INVALID");
        registrations.push(
          await this.#scanAndBuildSnapshot(session, finalizeInput.clientDigest, claimId),
        );
      }
      registrations.sort((left, right) =>
        compareCodePoints(left.snapshot.targetMemberKey, right.snapshot.targetMemberKey),
      );
      const group = this.#buildGroup(registrations);
      return await this.#repository.completeFinalizeGroup({
        claimId,
        group,
        snapshots: Object.freeze(registrations),
      });
    } catch (error) {
      const failure = classifyFinalizeFailure(error);
      await this.#repository
        .finishFinalizeFailure({
          claimId,
          failedSessionId: currentSessionId,
          failureCode: failure.failureCode,
          retryable: failure.retryable,
        })
        .catch(() => undefined);
      throw failure.error;
    }
  }

  async cleanupManagedObjects(limitInput = 100): Promise<CleanupSummary> {
    const limit = parseCleanupLimit(limitInput);
    let candidates: readonly SnapshotUploadSessionRecord[];
    try {
      candidates = await this.#repository.listObjectCleanupCandidates(limit);
    } catch (error) {
      throw asIngressDependencyError(error);
    }
    let completed = 0;
    let deferred = 0;
    let deletedVersions = 0;
    for (const session of candidates) {
      try {
        const protectedVersions =
          session.state === "finalized" && session.uploadedObjectVersion !== null
            ? new Set([session.uploadedObjectVersion])
            : new Set<string>();
        deletedVersions += await this.#objectStore.deleteUnregisteredVersions(
          session.objectKey,
          protectedVersions,
        );
        await this.#repository.markObjectCleanupComplete({
          projectId: session.projectId,
          sessionId: session.sessionId,
          expectedState: session.state,
        });
        completed += 1;
      } catch {
        deferred += 1;
      }
    }
    return Object.freeze({
      examined: candidates.length,
      completed,
      deferred,
      deletedVersions,
    });
  }

  async #scanAndBuildSnapshot(
    session: SnapshotUploadSessionRecord,
    clientDigest: ArtifactDigest | null,
    claimId: string,
  ): Promise<FinalizedSnapshotRegistration> {
    if (session.uploadedObjectVersion === null || session.uploadedByteCount === null) {
      throw new MaterializationIngressError("OBJECT_VERSION_CONFLICT");
    }
    await this.#renewFinalizeClaim(claimId);
    let lastMonotonicTime = this.#monotonicNow();
    let nextLeaseRenewalAt = lastMonotonicTime + finalizeLeaseRenewalIntervalMilliseconds;
    const renewLeaseWhenDue = async (): Promise<void> => {
      const currentTime = this.#monotonicNow();
      if (currentTime < lastMonotonicTime) {
        throw new MaterializationIngressError("DEPENDENCY_UNAVAILABLE");
      }
      lastMonotonicTime = currentTime;
      if (currentTime < nextLeaseRenewalAt) return;
      await this.#renewFinalizeClaim(claimId);
      nextLeaseRenewalAt = currentTime + finalizeLeaseRenewalIntervalMilliseconds;
    };

    const before = await this.#objectStore.headLatestVersion(session.objectKey);
    assertObjectMetadata(session, before);
    const stored = await this.#objectStore.readVersion(
      session.objectKey,
      session.uploadedObjectVersion,
    );
    assertObjectMetadata(session, stored);
    const digest = this.#crypto.createStreamingDigest();
    const scan = await scanManagedCsv(
      digestingBody(stored.body, digest, renewLeaseWhenDue),
      session.snapshotSchema.columns.map((column) => column.columnApiName),
    );
    await this.#renewFinalizeClaim(claimId);
    const after = await this.#objectStore.headLatestVersion(session.objectKey);
    assertObjectMetadata(session, after);
    const contentDigest = digest.finish();
    if (
      scan.byteCount !== session.expectedByteCount ||
      scan.byteCount !== session.uploadedByteCount ||
      (clientDigest !== null && clientDigest !== contentDigest)
    ) {
      throw new MaterializationIngressError("SNAPSHOT_CONTENT_MISMATCH");
    }

    const snapshotId = parseGeneratedId(this.#crypto.randomId());
    const fileId = parseGeneratedId(this.#crypto.randomId());
    const registeredAt = parseCanonicalInstant(this.#clock.now());
    const withoutDigest = {
      schemaVersion: 1,
      contractVersion: "dataset-snapshot-v1",
      snapshotId,
      projectId: session.projectId,
      snapshotGroupId: session.snapshotGroupId,
      groupVersion: session.groupVersion,
      targetMemberKey: session.memberKey,
      targetRevisionId: session.targetRevisionId,
      snapshotSchemaRevisionId: session.snapshotSchemaRevisionId,
      mappingRevisionId: session.mappingRevisionId,
      runtimePlanDigest: session.runtimePlanDigest,
      contentDigest,
      byteCount: scan.byteCount,
      rowCount: scan.rowCount,
      files: [
        {
          fileId,
          managedArtifactId: session.managedArtifactId,
          ordinal: 0,
          contentDigest,
          byteCount: scan.byteCount,
          rowCount: scan.rowCount,
        },
      ],
      ...(session.previousSnapshotId === null
        ? {}
        : { previousSnapshotId: session.previousSnapshotId }),
      state: "registered",
      registeredAt,
      snapshotDigest: zeroDigest(),
    } as const;
    const snapshotDigest = this.#crypto.digestText(
      canonicalizeMaterializationContractForDigest("DatasetSnapshot", withoutDigest),
    );
    const snapshot = parseDatasetSnapshot({ ...withoutDigest, snapshotDigest });
    return Object.freeze({
      sessionId: session.sessionId,
      objectVersion: session.uploadedObjectVersion,
      sourceLabel: session.sourceLabel,
      fileId,
      snapshot,
    });
  }

  async #renewFinalizeClaim(claimId: string): Promise<void> {
    try {
      await this.#repository.renewFinalizeClaim({ claimId });
    } catch (error) {
      throw mapIngressFailure(error);
    }
  }

  #monotonicNow(): number {
    const value = this.#monotonicClock.nowMilliseconds();
    if (!Number.isFinite(value) || value < 0) {
      throw new MaterializationIngressError("DEPENDENCY_UNAVAILABLE");
    }
    return value;
  }

  #buildGroup(registrations: readonly FinalizedSnapshotRegistration[]): SnapshotGroupContract {
    const ordered = [...registrations].sort((left, right) =>
      compareCodePoints(left.snapshot.targetMemberKey, right.snapshot.targetMemberKey),
    );
    const first = ordered[0];
    if (first === undefined) throw new MaterializationIngressError("ADMIN_REQUEST_INVALID");
    const createdAt = parseCanonicalInstant(this.#clock.now());
    const withoutDigest = {
      schemaVersion: 1,
      contractVersion: "snapshot-group-v1",
      snapshotGroupId: first.snapshot.snapshotGroupId,
      projectId: first.snapshot.projectId,
      groupVersion: first.snapshot.groupVersion,
      state: "registered",
      members: ordered.map((registration) => ({
        memberKey: registration.snapshot.targetMemberKey,
        memberKind: registration.snapshot.targetMemberKey.startsWith("object:")
          ? ("object" as const)
          : ("link" as const),
        snapshotId: registration.snapshot.snapshotId,
        targetRevisionId: registration.snapshot.targetRevisionId,
      })),
      groupDigest: zeroDigest(),
      createdAt,
    } as const;
    const groupDigest = this.#crypto.digestText(
      canonicalizeMaterializationContractForDigest("SnapshotGroup", withoutDigest),
    );
    return parseSnapshotGroup({ ...withoutDigest, groupDigest });
  }

  async #resolveEditor(
    identityInput: VerifiedFoundationIdentity,
    projectId: string,
  ): Promise<ResolvedFoundationIdentity> {
    const identity = parseTrustedIdentity(identityInput);
    try {
      const principal = await this.#principals.resolveVerifiedIdentity(identity);
      const resolved = resolvedIdentity(identity, principal.principalId);
      await this.#requireEditor(resolved, projectId);
      return resolved;
    } catch (error) {
      throw mapIngressFailure(error, "OBJECT_NOT_ACCESSIBLE");
    }
  }

  async #requireEditor(identity: ResolvedFoundationIdentity, projectId: string): Promise<void> {
    if (
      !(await this.#authorizer.authorize(identity, {
        projectId,
        permission: "metadata.edit",
      }))
    ) {
      throw new MaterializationIngressError("OBJECT_NOT_ACCESSIBLE");
    }
  }
}

function parseCreateSessionCommand(
  value: unknown,
  maximumUploadBytes: number,
): {
  readonly projectId: string;
  readonly releaseId: string;
  readonly memberKey: string;
  readonly groupVersion: number;
  readonly expectedByteCount: number;
  readonly sourceLabel: string;
} {
  try {
    const record = strictRecord(value, [
      "projectId",
      "releaseId",
      "targetMemberKey",
      "groupVersion",
      "expectedByteCount",
      "sourceLabel",
    ]);
    const memberKey = record["targetMemberKey"];
    const groupVersion = record["groupVersion"];
    const expectedByteCount = record["expectedByteCount"];
    if (typeof memberKey !== "string" || !memberKeyExpression.test(memberKey)) throw new Error();
    if (!Number.isSafeInteger(groupVersion) || (groupVersion as number) < 1) throw new Error();
    if (
      !Number.isSafeInteger(expectedByteCount) ||
      (expectedByteCount as number) < 1 ||
      (expectedByteCount as number) > maximumUploadBytes
    ) {
      throw new Error();
    }
    return Object.freeze({
      projectId: parseOntosId(record["projectId"]),
      releaseId: parseOntosId(record["releaseId"]),
      memberKey,
      groupVersion: groupVersion as number,
      expectedByteCount: expectedByteCount as number,
      sourceLabel: parseManagedSourceLabel(record["sourceLabel"]),
    });
  } catch (error) {
    throw new MaterializationIngressError("ADMIN_REQUEST_INVALID", { cause: error });
  }
}

function parseUploadContentCommand(value: unknown): {
  readonly sessionId: string;
  readonly contentLength: number;
  readonly mediaType: "text/csv";
  readonly body: AsyncIterable<Uint8Array>;
} {
  try {
    const record = strictRecord(value, [
      "sessionId",
      "contentLength",
      "mediaType",
      "contentEncoding",
      "body",
    ]);
    if (record["contentEncoding"] !== null) throw new Error();
    const contentLength = record["contentLength"];
    if (!Number.isSafeInteger(contentLength) || (contentLength as number) < 1) throw new Error();
    const body = record["body"];
    if (!isAsyncByteBody(body)) throw new Error();
    return Object.freeze({
      sessionId: parseOntosId(record["sessionId"]),
      contentLength: contentLength as number,
      mediaType: parseManagedCsvMediaType(record["mediaType"]),
      body,
    });
  } catch (error) {
    throw new MaterializationIngressError("ADMIN_REQUEST_INVALID", { cause: error });
  }
}

function parseFinalizeCommand(value: unknown): {
  readonly projectId: string;
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly finalizeToken: string;
    readonly clientDigest: ArtifactDigest | null;
  }[];
} {
  try {
    const record = strictRecord(value, ["projectId", "sessions"]);
    if (
      !Array.isArray(record["sessions"]) ||
      record["sessions"].length < 1 ||
      record["sessions"].length > 256
    ) {
      throw new Error();
    }
    const sessions = record["sessions"].map((candidate) => {
      const item = strictRecord(candidate, ["sessionId", "finalizeToken"], ["clientContentDigest"]);
      return Object.freeze({
        sessionId: parseOntosId(item["sessionId"]),
        finalizeToken: parseFinalizeToken(item["finalizeToken"]),
        clientDigest:
          item["clientContentDigest"] === undefined
            ? null
            : parseArtifactDigest(item["clientContentDigest"]),
      });
    });
    if (new Set(sessions.map((session) => session.sessionId)).size !== sessions.length)
      throw new Error();
    sessions.sort((left, right) => compareCodePoints(left.sessionId, right.sessionId));
    return Object.freeze({
      projectId: parseOntosId(record["projectId"]),
      sessions: Object.freeze(sessions),
    });
  } catch (error) {
    if (error instanceof MaterializationIngressError) throw error;
    throw new MaterializationIngressError("ADMIN_REQUEST_INVALID", { cause: error });
  }
}

function strictRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const record = value as Readonly<Record<string, unknown>>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new TypeError();
  if (required.some((key) => !Object.hasOwn(record, key))) throw new TypeError();
  return record;
}

function parseTrustedIdentity(value: VerifiedFoundationIdentity): VerifiedFoundationIdentity {
  try {
    return parseVerifiedFoundationIdentity(value);
  } catch (error) {
    throw new MaterializationIngressError("OBJECT_NOT_ACCESSIBLE", { cause: error });
  }
}

function resolvedIdentity(
  identity: VerifiedFoundationIdentity,
  principalId: string,
): ResolvedFoundationIdentity {
  return Object.freeze({
    principalId: parseOntosId(principalId),
    claimsFingerprint: identity.claimsFingerprint,
    authenticatedAt: identity.authenticatedAt,
  });
}

function parseGeneratedId(value: unknown): string {
  try {
    return parseOntosId(value);
  } catch (error) {
    throw new MaterializationIngressError("DEPENDENCY_UNAVAILABLE", { cause: error });
  }
}

function parseFinalizeToken(value: unknown): string {
  if (typeof value !== "string" || !finalizeTokenExpression.test(value)) {
    throw new MaterializationIngressError("ADMIN_REQUEST_INVALID");
  }
  return value;
}

function parseGeneratedFinalizeToken(value: unknown): string {
  try {
    return parseFinalizeToken(value);
  } catch (error) {
    throw new MaterializationIngressError("DEPENDENCY_UNAVAILABLE", { cause: error });
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertObjectMetadata(
  session: SnapshotUploadSessionRecord,
  metadata: {
    readonly versionId: string;
    readonly byteCount: number;
    readonly mediaType: string | null;
  },
): void {
  if (
    metadata.versionId !== session.uploadedObjectVersion ||
    metadata.byteCount !== session.expectedByteCount ||
    metadata.mediaType !== session.allowedMediaType
  ) {
    throw new MaterializationIngressError("SNAPSHOT_CONTENT_MISMATCH");
  }
}

async function* digestingBody(
  body: AsyncIterable<Uint8Array>,
  digest: StreamingDigestAccumulator,
  onChunk: () => Promise<void>,
): AsyncIterable<Uint8Array> {
  for await (const chunk of body) {
    await onChunk();
    digest.update(chunk);
    yield chunk;
  }
}

function classifyFinalizeFailure(error: unknown): {
  readonly failureCode:
    "DEPENDENCY_UNAVAILABLE" | "SNAPSHOT_CONTENT_MISMATCH" | "SNAPSHOT_SCHEMA_INVALID";
  readonly retryable: boolean;
  readonly error: MaterializationIngressError;
} {
  if (error instanceof ManagedCsvError) {
    return Object.freeze({
      failureCode: "SNAPSHOT_SCHEMA_INVALID",
      retryable: false,
      error: new MaterializationIngressError("SNAPSHOT_SCHEMA_INVALID", { cause: error }),
    });
  }
  const mapped = mapIngressFailure(error);
  if (mapped.code === "SNAPSHOT_SCHEMA_INVALID") {
    return Object.freeze({ failureCode: mapped.code, retryable: false, error: mapped });
  }
  if (mapped.code === "SNAPSHOT_CONTENT_MISMATCH" || mapped.code === "OBJECT_NOT_ACCESSIBLE") {
    return Object.freeze({
      failureCode: "SNAPSHOT_CONTENT_MISMATCH",
      retryable: false,
      error:
        mapped.code === "OBJECT_NOT_ACCESSIBLE"
          ? new MaterializationIngressError("SNAPSHOT_CONTENT_MISMATCH", { cause: mapped })
          : mapped,
    });
  }
  return Object.freeze({
    failureCode: "DEPENDENCY_UNAVAILABLE",
    retryable: true,
    error:
      mapped.code === "DEPENDENCY_UNAVAILABLE"
        ? mapped
        : new MaterializationIngressError("DEPENDENCY_UNAVAILABLE", { cause: mapped }),
  });
}

function mapIngressFailure(
  error: unknown,
  fallback: MaterializationIngressErrorCode = "DEPENDENCY_UNAVAILABLE",
): MaterializationIngressError {
  if (error instanceof MaterializationIngressError) return error;
  if (isObjectStoreError(error)) {
    switch (error.code) {
      case "CONTENT_LENGTH_MISMATCH":
      case "VERSION_MISMATCH":
        return new MaterializationIngressError("SNAPSHOT_CONTENT_MISMATCH", { cause: error });
      case "NOT_FOUND":
        return new MaterializationIngressError("OBJECT_NOT_ACCESSIBLE", { cause: error });
      case "CONFIGURATION_INVALID":
      case "UNAVAILABLE":
        return new MaterializationIngressError("DEPENDENCY_UNAVAILABLE", { cause: error });
    }
  }
  return new MaterializationIngressError(fallback, { cause: error });
}

function asIngressDependencyError(error: unknown): MaterializationIngressError {
  const mapped = mapIngressFailure(error);
  return mapped.code === "DEPENDENCY_UNAVAILABLE"
    ? mapped
    : new MaterializationIngressError("DEPENDENCY_UNAVAILABLE", { cause: mapped });
}

function isObjectStoreError(value: unknown): value is { readonly code: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof (value as Readonly<Record<string, unknown>>)["code"] === "string"
  );
}

function isAsyncByteBody(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function parseCleanupLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000) {
    throw new MaterializationIngressError("ADMIN_REQUEST_INVALID");
  }
  return value as number;
}

function zeroDigest(): ArtifactDigest {
  return parseArtifactDigest(`sha256:${"0".repeat(64)}`);
}
