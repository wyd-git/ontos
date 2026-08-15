import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import {
  parseArtifactDigest,
  parseCanonicalInstant,
  parseSnapshotSchemaDefinition,
  type ArtifactDigest,
} from "@ontos/contracts";
import {
  MaterializationIngressError,
  MaterializationIngressService,
  type FinalizedSnapshotGroupResult,
  type ManagedSnapshotObjectStore,
  type MaterializationIngressCrypto,
  type MaterializationIngressMonotonicClock,
  type SnapshotUploadSessionRecord,
  type SnapshotUploadSessionRepository,
  type SnapshotUploadSessionState,
} from "@ontos/materialization-application";
import type {
  ManagementAuthorizer,
  PrincipalDirectory,
  VerifiedFoundationIdentity,
} from "@ontos/metadata-application";

const ids = Object.freeze({
  project: "00000000-0000-4000-8000-000000000001",
  principal: "00000000-0000-4000-8000-000000000002",
  release: "00000000-0000-4000-8000-000000000003",
  group: "00000000-0000-4000-8000-000000000004",
  target: "00000000-0000-4000-8000-000000000005",
  targetRevision: "00000000-0000-4000-8000-000000000006",
  schema: "00000000-0000-4000-8000-000000000007",
  schemaRevision: "00000000-0000-4000-8000-000000000008",
  mapping: "00000000-0000-4000-8000-000000000009",
  mappingRevision: "00000000-0000-4000-8000-00000000000a",
  sessionA: "10000000-0000-4000-8000-000000000001",
  sessionZ: "10000000-0000-4000-8000-000000000002",
  artifactA: "20000000-0000-4000-8000-000000000001",
  artifactZ: "20000000-0000-4000-8000-000000000002",
  claim: "30000000-0000-4000-8000-000000000001",
  snapshotA: "40000000-0000-4000-8000-000000000001",
  fileA: "50000000-0000-4000-8000-000000000001",
  snapshotZ: "40000000-0000-4000-8000-000000000002",
  fileZ: "50000000-0000-4000-8000-000000000002",
});

const tokenA = "A".repeat(43);
const tokenZ = "Z".repeat(43);
const now = parseCanonicalInstant("2026-08-15T10:00:00.000000Z");
const csvA = new TextEncoder().encode("id,name\n1,Ada\n");
const csvZ = new TextEncoder().encode("id,name\n2,Zoe\n");

void test("upload session creation exposes only the managed API handle and binds server facts", async () => {
  const repository = new FakeRepository();
  const objectStore = new FakeObjectStore();
  const crypto = new TestCrypto([ids.sessionA, ids.artifactA], tokenA);
  const service = makeService(repository, objectStore, crypto);

  const result = await service.createUploadSession(identity(), {
    projectId: ids.project,
    releaseId: ids.release,
    targetMemberKey: "object:Customer",
    groupVersion: 1,
    expectedByteCount: csvA.byteLength,
    sourceLabel: "customers.csv",
  });

  assert.equal(result.sessionId, ids.sessionA);
  assert.equal(result.finalizeToken, tokenA);
  assert.equal(result.uploadPath, `/api/v1/admin/snapshot-upload-sessions/${ids.sessionA}/content`);
  assert.equal(Object.hasOwn(result, "objectKey"), false);
  assert.equal(Object.hasOwn(result, "bucket"), false);
  assert.equal(repository.createdInputs.length, 1);
  assert.equal(repository.createdInputs[0]?.objectKey, `ingress/20/${ids.artifactA}.csv`);
  assert.equal(repository.createdInputs[0]?.finalizeTokenDigest, digest(tokenA));

  await assert.rejects(
    service.createUploadSession(identity(), {
      projectId: ids.project,
      releaseId: ids.release,
      targetMemberKey: "object:Customer",
      groupVersion: 1,
      expectedByteCount: csvA.byteLength,
      sourceLabel: "customers.csv",
      bucket: "client-controlled",
    }),
    ingressError("ADMIN_REQUEST_INVALID"),
  );
});

void test("streaming upload records one exact version and deletes a database-race loser", async () => {
  const repository = new FakeRepository();
  const objectStore = new FakeObjectStore();
  const session = sessionFixture({
    sessionId: ids.sessionA,
    managedArtifactId: ids.artifactA,
    objectKey: `ingress/20/${ids.artifactA}.csv`,
    expectedByteCount: csvA.byteLength,
  });
  repository.sessions.set(session.sessionId, session);
  const service = makeService(repository, objectStore, new TestCrypto([], tokenA));

  const result = await service.uploadSessionContent(identity(), {
    sessionId: session.sessionId,
    contentLength: csvA.byteLength,
    mediaType: "text/csv; charset=utf-8",
    contentEncoding: null,
    body: Readable.from([csvA]),
  });
  assert.deepEqual(result, {
    sessionId: session.sessionId,
    state: "uploaded",
    byteCount: csvA.byteLength,
  });
  assert.equal(repository.uploadedInputs[0]?.objectVersion, "version-1");
  assert.deepEqual(objectStore.bytes(session.objectKey, "version-1"), csvA);

  const losingSession = sessionFixture({
    sessionId: ids.sessionZ,
    managedArtifactId: ids.artifactZ,
    objectKey: `ingress/20/${ids.artifactZ}.csv`,
    expectedByteCount: csvZ.byteLength,
  });
  repository.sessions.set(losingSession.sessionId, losingSession);
  repository.failRecord = true;
  await assert.rejects(
    service.uploadSessionContent(identity(), {
      sessionId: losingSession.sessionId,
      contentLength: csvZ.byteLength,
      mediaType: "text/csv",
      contentEncoding: null,
      body: Readable.from([csvZ]),
    }),
    ingressError("OBJECT_VERSION_CONFLICT"),
  );
  assert.deepEqual(objectStore.deletedVersions, [
    { objectKey: losingSession.objectKey, versionId: "version-2" },
  ]);
});

void test("group Finalize scans exact versions and returns deterministic immutable Snapshot facts", async () => {
  const repository = new FakeRepository();
  const objectStore = new FakeObjectStore();
  const sessionZ = uploadedSession({
    sessionId: ids.sessionZ,
    managedArtifactId: ids.artifactZ,
    memberKey: "object:Zulu",
    objectKey: `ingress/20/${ids.artifactZ}.csv`,
    objectVersion: "z-version",
    bytes: csvZ,
  });
  const sessionA = uploadedSession({
    sessionId: ids.sessionA,
    managedArtifactId: ids.artifactA,
    memberKey: "object:Alpha",
    objectKey: `ingress/20/${ids.artifactA}.csv`,
    objectVersion: "a-version",
    bytes: csvA,
  });
  repository.sessions.set(sessionZ.sessionId, sessionZ);
  repository.sessions.set(sessionA.sessionId, sessionA);
  repository.claimedSessions = [sessionZ, sessionA];
  objectStore.seed(sessionZ.objectKey, "z-version", csvZ);
  objectStore.seed(sessionA.objectKey, "a-version", csvA);
  const crypto = new TestCrypto(
    [ids.claim, ids.snapshotZ, ids.fileZ, ids.snapshotA, ids.fileA],
    tokenA,
  );
  const service = makeService(
    repository,
    objectStore,
    crypto,
    true,
    advancingMonotonicClock(120_000),
  );

  const result = await service.finalizeSnapshotGroup(identity(), {
    projectId: ids.project,
    sessions: [
      { sessionId: ids.sessionZ, finalizeToken: tokenZ },
      {
        sessionId: ids.sessionA,
        finalizeToken: tokenA,
        clientContentDigest: digestBytes(csvA),
      },
    ],
  });

  assert.deepEqual(
    result.group.members.map((member) => member.memberKey),
    ["object:Alpha", "object:Zulu"],
  );
  assert.deepEqual(
    result.snapshots.map((snapshot) => snapshot.targetMemberKey),
    ["object:Alpha", "object:Zulu"],
  );
  assert.deepEqual(
    result.snapshots.map((snapshot) => snapshot.rowCount),
    [1, 1],
  );
  assert.deepEqual(
    result.snapshots.map((snapshot) => snapshot.contentDigest),
    [digestBytes(csvA), digestBytes(csvZ)],
  );
  assert.equal(repository.completed?.claimId, ids.claim);
  assert.deepEqual(
    repository.renewedClaims,
    Array.from({ length: 6 }, () => ids.claim),
  );
  assert.deepEqual(objectStore.reads, [
    { objectKey: sessionZ.objectKey, versionId: "z-version" },
    { objectKey: sessionA.objectKey, versionId: "a-version" },
  ]);
});

void test("Finalize makes bad CSV terminal but releases a dependency failure for retry", async () => {
  const badBytes = new TextEncoder().encode("wrong\n1\n");
  const badRepository = new FakeRepository();
  const badStore = new FakeObjectStore();
  const badSession = uploadedSession({
    sessionId: ids.sessionA,
    managedArtifactId: ids.artifactA,
    memberKey: "object:Alpha",
    objectKey: `ingress/20/${ids.artifactA}.csv`,
    objectVersion: "bad-version",
    bytes: badBytes,
  });
  badRepository.sessions.set(badSession.sessionId, badSession);
  badRepository.claimedSessions = [badSession];
  badStore.seed(badSession.objectKey, "bad-version", badBytes);
  await assert.rejects(
    makeService(
      badRepository,
      badStore,
      new TestCrypto([ids.claim, ids.snapshotA, ids.fileA], tokenA),
    ).finalizeSnapshotGroup(identity(), {
      projectId: ids.project,
      sessions: [{ sessionId: ids.sessionA, finalizeToken: tokenA }],
    }),
    ingressError("SNAPSHOT_SCHEMA_INVALID"),
  );
  assert.deepEqual(badRepository.failure, {
    claimId: ids.claim,
    failedSessionId: ids.sessionA,
    failureCode: "SNAPSHOT_SCHEMA_INVALID",
    retryable: false,
  });

  const retryRepository = new FakeRepository();
  const retryStore = new FakeObjectStore();
  const retrySession = uploadedSession({
    sessionId: ids.sessionA,
    managedArtifactId: ids.artifactA,
    memberKey: "object:Alpha",
    objectKey: `ingress/20/${ids.artifactA}.csv`,
    objectVersion: "retry-version",
    bytes: csvA,
  });
  retryRepository.sessions.set(retrySession.sessionId, retrySession);
  retryRepository.claimedSessions = [retrySession];
  retryStore.seed(retrySession.objectKey, "retry-version", csvA);
  retryStore.failRead = true;
  await assert.rejects(
    makeService(
      retryRepository,
      retryStore,
      new TestCrypto([ids.claim, ids.snapshotA, ids.fileA], tokenA),
    ).finalizeSnapshotGroup(identity(), {
      projectId: ids.project,
      sessions: [{ sessionId: ids.sessionA, finalizeToken: tokenA }],
    }),
    ingressError("DEPENDENCY_UNAVAILABLE"),
  );
  assert.deepEqual(retryRepository.failure, {
    claimId: ids.claim,
    failedSessionId: ids.sessionA,
    failureCode: "DEPENDENCY_UNAVAILABLE",
    retryable: true,
  });
});

void test("cleanup preserves a finalized exact version and removes every other version", async () => {
  const repository = new FakeRepository();
  const objectStore = new FakeObjectStore();
  const finalized = uploadedSession({
    sessionId: ids.sessionA,
    managedArtifactId: ids.artifactA,
    memberKey: "object:Alpha",
    objectKey: `ingress/20/${ids.artifactA}.csv`,
    objectVersion: "protected",
    bytes: csvA,
    state: "finalized",
  });
  objectStore.seed(finalized.objectKey, "protected", csvA);
  objectStore.seed(finalized.objectKey, "orphan", csvZ);
  repository.cleanupCandidates = [finalized];
  const result = await makeService(
    repository,
    objectStore,
    new TestCrypto([], tokenA),
  ).cleanupManagedObjects();

  assert.deepEqual(result, { examined: 1, completed: 1, deferred: 0, deletedVersions: 1 });
  assert.deepEqual(objectStore.versionIds(finalized.objectKey), ["protected"]);
  assert.deepEqual(repository.cleaned, [
    { projectId: ids.project, sessionId: ids.sessionA, expectedState: "finalized" },
  ]);
});

function makeService(
  repository: FakeRepository,
  objectStore: FakeObjectStore,
  crypto: MaterializationIngressCrypto,
  allowed = true,
  monotonicClock: MaterializationIngressMonotonicClock = { nowMilliseconds: () => 0 },
): MaterializationIngressService {
  const principals: PrincipalDirectory = {
    resolveVerifiedIdentity(value) {
      return Promise.resolve({
        principalId: ids.principal,
        issuer: value.issuer,
        subject: value.subject,
        displayName: value.displayName,
        state: "active",
      });
    },
  };
  const authorizer: ManagementAuthorizer = {
    authorize(_resolved, request) {
      assert.equal(request.permission, "metadata.edit");
      return Promise.resolve(allowed);
    },
  };
  return new MaterializationIngressService({
    principals,
    authorizer,
    repository,
    objectStore,
    crypto,
    clock: { now: () => now },
    monotonicClock,
  });
}

class FakeRepository implements SnapshotUploadSessionRepository {
  readonly sessions = new Map<string, SnapshotUploadSessionRecord>();
  readonly createdInputs: Parameters<SnapshotUploadSessionRepository["createUploadSession"]>[0][] =
    [];
  readonly uploadedInputs: Parameters<
    SnapshotUploadSessionRepository["recordUploadedVersion"]
  >[0][] = [];
  readonly cleaned: Parameters<SnapshotUploadSessionRepository["markObjectCleanupComplete"]>[0][] =
    [];
  readonly renewedClaims: string[] = [];
  claimedSessions: readonly SnapshotUploadSessionRecord[] | null = null;
  cleanupCandidates: readonly SnapshotUploadSessionRecord[] = [];
  completed: Parameters<SnapshotUploadSessionRepository["completeFinalizeGroup"]>[0] | null = null;
  failure: Parameters<SnapshotUploadSessionRepository["finishFinalizeFailure"]>[0] | null = null;
  failRecord = false;

  createUploadSession(
    input: Parameters<SnapshotUploadSessionRepository["createUploadSession"]>[0],
  ): Promise<SnapshotUploadSessionRecord> {
    this.createdInputs.push(input);
    const session = sessionFixture({
      sessionId: input.sessionId,
      managedArtifactId: input.managedArtifactId,
      memberKey: input.memberKey,
      objectKey: input.objectKey,
      expectedByteCount: input.expectedByteCount,
      sourceLabel: input.sourceLabel,
      finalizeTokenDigest: input.finalizeTokenDigest,
    });
    this.sessions.set(session.sessionId, session);
    return Promise.resolve(session);
  }

  getUploadSession(input: {
    readonly sessionId: string;
    readonly principalId: string;
  }): Promise<SnapshotUploadSessionRecord> {
    assert.equal(input.principalId, ids.principal);
    const session = this.sessions.get(input.sessionId);
    return session === undefined
      ? Promise.reject(new MaterializationIngressError("OBJECT_NOT_ACCESSIBLE"))
      : Promise.resolve(session);
  }

  recordUploadedVersion(
    input: Parameters<SnapshotUploadSessionRepository["recordUploadedVersion"]>[0],
  ): Promise<SnapshotUploadSessionRecord> {
    this.uploadedInputs.push(input);
    if (this.failRecord)
      return Promise.reject(new MaterializationIngressError("OBJECT_VERSION_CONFLICT"));
    const current = this.sessions.get(input.sessionId);
    if (current === undefined)
      return Promise.reject(new MaterializationIngressError("OBJECT_NOT_ACCESSIBLE"));
    const updated = Object.freeze({
      ...current,
      state: "uploaded" as const,
      uploadedObjectVersion: input.objectVersion,
      uploadedByteCount: input.byteCount,
    });
    this.sessions.set(input.sessionId, updated);
    return Promise.resolve(updated);
  }

  claimFinalizeGroup(): Promise<{
    readonly kind: "claimed";
    readonly sessions: readonly SnapshotUploadSessionRecord[];
  }> {
    return Promise.resolve({ kind: "claimed", sessions: this.claimedSessions ?? [] });
  }

  renewFinalizeClaim(input: { readonly claimId: string }): Promise<void> {
    this.renewedClaims.push(input.claimId);
    return Promise.resolve();
  }

  completeFinalizeGroup(
    input: Parameters<SnapshotUploadSessionRepository["completeFinalizeGroup"]>[0],
  ): Promise<FinalizedSnapshotGroupResult> {
    this.completed = input;
    return Promise.resolve({
      group: input.group,
      snapshots: Object.freeze(input.snapshots.map((value) => value.snapshot)),
    });
  }

  finishFinalizeFailure(
    input: Parameters<SnapshotUploadSessionRepository["finishFinalizeFailure"]>[0],
  ): Promise<void> {
    this.failure = input;
    return Promise.resolve();
  }

  listObjectCleanupCandidates(): Promise<readonly SnapshotUploadSessionRecord[]> {
    return Promise.resolve(this.cleanupCandidates);
  }

  markObjectCleanupComplete(
    input: Parameters<SnapshotUploadSessionRepository["markObjectCleanupComplete"]>[0],
  ): Promise<void> {
    this.cleaned.push(input);
    return Promise.resolve();
  }
}

class FakeObjectStore implements ManagedSnapshotObjectStore {
  readonly #objects = new Map<
    string,
    { versionId: string; bytes: Uint8Array; mediaType: string }[]
  >();
  readonly reads: { readonly objectKey: string; readonly versionId: string }[] = [];
  readonly deletedVersions: { readonly objectKey: string; readonly versionId: string }[] = [];
  failRead = false;
  #nextVersion = 1;

  assertVersioningEnabled(): Promise<void> {
    return Promise.resolve();
  }

  async putVersion(input: Parameters<ManagedSnapshotObjectStore["putVersion"]>[0]): Promise<{
    readonly versionId: string;
    readonly byteCount: number;
    readonly mediaType: string;
  }> {
    const bytes = await readAll(input.body);
    if (bytes.byteLength !== input.expectedByteCount) {
      throw Object.assign(new Error("bounded"), { code: "CONTENT_LENGTH_MISMATCH" });
    }
    const versionId = `version-${this.#nextVersion++}`;
    this.seed(input.objectKey, versionId, bytes, input.mediaType);
    return { versionId, byteCount: bytes.byteLength, mediaType: input.mediaType };
  }

  headLatestVersion(objectKey: string) {
    const version = this.#objects.get(objectKey)?.at(-1);
    if (version === undefined)
      return Promise.reject(Object.assign(new Error("bounded"), { code: "NOT_FOUND" }));
    return Promise.resolve({
      versionId: version.versionId,
      byteCount: version.bytes.byteLength,
      mediaType: version.mediaType,
    });
  }

  readVersion(objectKey: string, versionId: string) {
    this.reads.push({ objectKey, versionId });
    if (this.failRead)
      return Promise.reject(Object.assign(new Error("bounded"), { code: "UNAVAILABLE" }));
    const version = this.#objects
      .get(objectKey)
      ?.find((candidate) => candidate.versionId === versionId);
    if (version === undefined)
      return Promise.reject(Object.assign(new Error("bounded"), { code: "NOT_FOUND" }));
    return Promise.resolve({
      versionId,
      byteCount: version.bytes.byteLength,
      mediaType: version.mediaType,
      body: Readable.from([version.bytes]),
    });
  }

  deleteVersion(objectKey: string, versionId: string): Promise<void> {
    this.deletedVersions.push({ objectKey, versionId });
    const versions = this.#objects.get(objectKey) ?? [];
    this.#objects.set(
      objectKey,
      versions.filter((candidate) => candidate.versionId !== versionId),
    );
    return Promise.resolve();
  }

  async deleteUnregisteredVersions(
    objectKey: string,
    protectedVersionIds: ReadonlySet<string>,
  ): Promise<number> {
    const deleted = (this.#objects.get(objectKey) ?? []).filter(
      (candidate) => !protectedVersionIds.has(candidate.versionId),
    );
    for (const version of deleted) await this.deleteVersion(objectKey, version.versionId);
    return deleted.length;
  }

  seed(objectKey: string, versionId: string, bytes: Uint8Array, mediaType = "text/csv"): void {
    const versions = this.#objects.get(objectKey) ?? [];
    versions.push({ versionId, bytes: Uint8Array.from(bytes), mediaType });
    this.#objects.set(objectKey, versions);
  }

  bytes(objectKey: string, versionId: string): Uint8Array | undefined {
    return this.#objects.get(objectKey)?.find((candidate) => candidate.versionId === versionId)
      ?.bytes;
  }

  versionIds(objectKey: string): readonly string[] {
    return (this.#objects.get(objectKey) ?? []).map((value) => value.versionId);
  }
}

class TestCrypto implements MaterializationIngressCrypto {
  readonly #ids: string[];
  readonly #token: string;

  constructor(idsInput: readonly string[], token: string) {
    this.#ids = [...idsInput];
    this.#token = token;
  }

  randomId(): string {
    const value = this.#ids.shift();
    if (value === undefined) throw new Error("No deterministic ID remains.");
    return value;
  }

  randomToken(): string {
    return this.#token;
  }

  digestText(value: string): ArtifactDigest {
    return digest(value);
  }

  createStreamingDigest() {
    const hash = createHash("sha256");
    return {
      update: (chunk: Uint8Array) => hash.update(chunk),
      finish: () => parseArtifactDigest(`sha256:${hash.digest("hex")}`),
    };
  }
}

function sessionFixture(
  overrides: Partial<SnapshotUploadSessionRecord> = {},
): SnapshotUploadSessionRecord {
  return Object.freeze({
    projectId: ids.project,
    sessionId: ids.sessionA,
    createdByPrincipalId: ids.principal,
    releaseId: ids.release,
    snapshotGroupId: ids.group,
    groupVersion: 1,
    groupMemberCount: 1,
    memberKey: "object:Customer",
    memberKind: "object",
    targetResourceId: ids.target,
    targetRevisionId: ids.targetRevision,
    snapshotSchemaResourceId: ids.schema,
    snapshotSchemaRevisionId: ids.schemaRevision,
    mappingResourceId: ids.mapping,
    mappingRevisionId: ids.mappingRevision,
    indexPlanDigest: digest("index-plan"),
    runtimePlanDigest: digest("runtime-plan"),
    managedArtifactId: ids.artifactA,
    objectKey: `ingress/20/${ids.artifactA}.csv`,
    allowedMediaType: "text/csv",
    expectedByteCount: csvA.byteLength,
    maxByteCount: 512 * 1024 * 1024,
    sourceLabel: "managed.csv",
    finalizeTokenDigest: digest(tokenA),
    state: "created",
    uploadedObjectVersion: null,
    uploadedByteCount: null,
    snapshotId: null,
    expiresAt: parseCanonicalInstant("2026-08-15T10:14:59.000000Z"),
    cleanupAfter: parseCanonicalInstant("2026-08-16T10:00:00.000000Z"),
    snapshotSchema: parseSnapshotSchemaDefinition({
      schemaVersion: 1,
      contractVersion: "snapshot-schema-v1",
      format: "csv_utf8",
      headerRow: true,
      columns: [
        { ordinal: 0, columnApiName: "id", valueType: "string", required: true },
        { ordinal: 1, columnApiName: "name", valueType: "string", required: true },
      ],
    }),
    previousSnapshotId: null,
    ...overrides,
  });
}

function uploadedSession(input: {
  readonly sessionId: string;
  readonly managedArtifactId: string;
  readonly memberKey: string;
  readonly objectKey: string;
  readonly objectVersion: string;
  readonly bytes: Uint8Array;
  readonly state?: SnapshotUploadSessionState;
}): SnapshotUploadSessionRecord {
  return sessionFixture({
    sessionId: input.sessionId,
    managedArtifactId: input.managedArtifactId,
    memberKey: input.memberKey,
    objectKey: input.objectKey,
    expectedByteCount: input.bytes.byteLength,
    state: input.state ?? "uploaded",
    uploadedObjectVersion: input.objectVersion,
    uploadedByteCount: input.bytes.byteLength,
    ...(input.state === "finalized" ? { snapshotId: ids.snapshotA } : {}),
  });
}

function identity(): VerifiedFoundationIdentity {
  return Object.freeze({
    issuer: "https://issuer.example.test",
    subject: "managed-ingress-test",
    displayName: "Managed Ingress Test",
    claimsFingerprint: digest("claims"),
    authenticatedAt: now,
  });
}

function advancingMonotonicClock(stepMilliseconds: number): MaterializationIngressMonotonicClock {
  let current = 0;
  return {
    nowMilliseconds() {
      const value = current;
      current += stepMilliseconds;
      return value;
    },
  };
}

function digest(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}

function digestBytes(value: Uint8Array): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

async function readAll(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function ingressError(code: MaterializationIngressError["code"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof MaterializationIngressError && error.code === code;
}
