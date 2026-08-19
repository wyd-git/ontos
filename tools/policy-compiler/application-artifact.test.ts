import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import type { ArtifactDigest } from "@ontos/contracts";
import {
  PolicyApplicationError,
  PolicyCompilationApplicationService,
  type PolicyArtifactKind,
  type PolicyArtifactStore,
  type PolicyCompilationRecorder,
  type PolicyCompilationSource,
} from "@ontos/policy-application";
import { compilePolicy } from "@ontos/policy-domain";
import {
  ManagedObjectStoreError,
  S3PolicyArtifactStore,
  type ManagedObjectMediaType,
  type ManagedObjectVersionBody,
  type ManagedObjectVersionMetadata,
  type PolicyManagedObjectStore,
} from "@ontos/object-store-s3";

import { compileInput, policyDefinition, policyIds, sha256 } from "./fixtures.ts";

void test("Application stores IR and Test bytes before recording one immutable compilation", async () => {
  const source = sourceFixture(policyDefinition());
  const artifacts = new MemoryPolicyArtifacts();
  const recorder = new MemoryRecorder();
  let sequence = 0;
  const service = new PolicyCompilationApplicationService({
    source,
    artifacts,
    recorder,
    digest: sha256,
    uuid: () => `018f47a2-755b-7cc3-98c8-4d2fb871c${String(400 + sequence++).padStart(3, "0")}`,
  });
  const result = await service.compileReleasePolicy({
    projectId: policyIds.project,
    releaseId: policyIds.release,
    policyRevisionId: policyIds.policyRevision,
  });
  assert.equal(result.testReport.status, "passed");
  assert.equal(artifacts.values.size, 2);
  assert.equal(recorder.records.length, 1);
  assert.equal(recorder.records[0]?.status, "passed");
  assert.equal(recorder.records[0]?.artifactDigest, result.artifactDigest);
});

void test("A mismatched vector is durably recorded as failed and cannot masquerade as passed", async () => {
  const definition = structuredClone(policyDefinition()) as unknown as Record<string, unknown>;
  const vectors = definition.testVectors as Record<string, unknown>[];
  const denied = vectors.find(({ vectorId }) => vectorId === "DENY_MISSING");
  assert.ok(denied !== undefined);
  denied.expectedDecision = "allow";
  const artifacts = new MemoryPolicyArtifacts();
  const recorder = new MemoryRecorder();
  let sequence = 0;
  const service = new PolicyCompilationApplicationService({
    source: sourceFixture(definition),
    artifacts,
    recorder,
    digest: sha256,
    uuid: () => `018f47a2-755b-7cc3-98c8-4d2fb871c${String(500 + sequence++).padStart(3, "0")}`,
  });
  const result = await service.compileReleasePolicy({
    projectId: policyIds.project,
    releaseId: policyIds.release,
    policyRevisionId: policyIds.policyRevision,
  });
  assert.equal(result.testReport.status, "failed");
  assert.equal(recorder.records[0]?.status, "failed");
  assert.equal(recorder.records[0]?.failedVectorCount, 1);
});

void test("Artifact persistence failures are fail-closed storage errors and never record a Compilation", async () => {
  const recorder = new MemoryRecorder();
  const service = new PolicyCompilationApplicationService({
    source: sourceFixture(policyDefinition()),
    artifacts: {
      putArtifact() {
        return Promise.reject(new Error("object store unavailable"));
      },
      readArtifact() {
        return Promise.reject(new Error("object store unavailable"));
      },
    },
    recorder,
    digest: sha256,
    uuid: () => policyIds.policyResource,
  });
  await assert.rejects(
    service.compileReleasePolicy({
      projectId: policyIds.project,
      releaseId: policyIds.release,
      policyRevisionId: policyIds.policyRevision,
    }),
    (error: unknown) => error instanceof PolicyApplicationError && error.code === "STORAGE_FAILURE",
  );
  assert.equal(recorder.records.length, 0);
});

void test("S3 adapter uses deterministic content-addressed keys and rejects altered latest bytes", async () => {
  const compiled = compilePolicy(compileInput());
  const managed = new FakeManagedStore();
  const store = new S3PolicyArtifactStore(managed);
  await store.putArtifact({
    kind: "ir",
    digest: compiled.artifactDigest,
    canonicalBytes: compiled.artifactBytes,
  });
  assert.equal(
    await store.readArtifact({ kind: "ir", digest: compiled.artifactDigest }),
    compiled.artifactBytes,
  );
  assert.match(managed.lastKey ?? "", /^policy\/ir\/[0-9a-f]{64}[.]json$/u);
  await store.putArtifact({
    kind: "ir",
    digest: compiled.artifactDigest,
    canonicalBytes: compiled.artifactBytes,
  });
  assert.equal(managed.putCount, 1);
  managed.tamper();
  await assert.rejects(
    store.readArtifact({ kind: "ir", digest: compiled.artifactDigest }),
    (error: unknown) =>
      error instanceof ManagedObjectStoreError && error.code === "VERSION_MISMATCH",
  );
});

function sourceFixture(definition: unknown): PolicyCompilationSource {
  const input = compileInput();
  return {
    loadCompilationInput() {
      return Promise.resolve(
        Object.freeze({
          projectId: input.projectId,
          releaseId: input.releaseId,
          policyResourceId: policyIds.policyResource,
          policyRevisionId: input.policyRevisionId,
          policyContentDigest: sha256(JSON.stringify(definition)),
          definition,
          releaseRevisionIds: input.releaseRevisionIds,
          targets: input.targets,
          trustedActorAttributes: input.trustedActorAttributes,
        }),
      );
    },
  };
}

class MemoryPolicyArtifacts implements PolicyArtifactStore {
  readonly values = new Map<string, string>();

  putArtifact(input: {
    readonly kind: PolicyArtifactKind;
    readonly digest: ArtifactDigest;
    readonly canonicalBytes: string;
  }): Promise<void> {
    this.values.set(`${input.kind}:${input.digest}`, input.canonicalBytes);
    return Promise.resolve();
  }

  readArtifact(input: {
    readonly kind: PolicyArtifactKind;
    readonly digest: ArtifactDigest;
  }): Promise<string> {
    const value = this.values.get(`${input.kind}:${input.digest}`);
    return value === undefined ? Promise.reject(new Error("missing")) : Promise.resolve(value);
  }
}

class MemoryRecorder implements PolicyCompilationRecorder {
  readonly records: Parameters<PolicyCompilationRecorder["recordCompilation"]>[0][] = [];

  recordCompilation(
    input: Parameters<PolicyCompilationRecorder["recordCompilation"]>[0],
  ): Promise<void> {
    this.records.push(input);
    return Promise.resolve();
  }
}

class FakeManagedStore implements PolicyManagedObjectStore {
  lastKey: string | null = null;
  putCount = 0;
  #body: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #mediaType: ManagedObjectMediaType | null = null;

  headLatestVersion(objectKey: string): Promise<ManagedObjectVersionMetadata> {
    if (this.lastKey !== objectKey || this.#mediaType === null) {
      return Promise.reject(new ManagedObjectStoreError("NOT_FOUND"));
    }
    return Promise.resolve({
      versionId: "v1",
      byteCount: this.#body.byteLength,
      mediaType: this.#mediaType,
    });
  }

  async readVersion(objectKey: string, versionId: string): Promise<ManagedObjectVersionBody> {
    const metadata = await this.headLatestVersion(objectKey);
    assert.equal(versionId, metadata.versionId);
    const body = this.#body;
    return { ...metadata, body: chunks(body) };
  }

  async putVersion(input: {
    readonly objectKey: string;
    readonly body: AsyncIterable<Uint8Array>;
    readonly expectedByteCount: number;
    readonly mediaType: ManagedObjectMediaType;
  }): Promise<ManagedObjectVersionMetadata> {
    const parts: Uint8Array[] = [];
    for await (const part of input.body) parts.push(part);
    this.#body = parts[0] ?? new Uint8Array();
    assert.equal(this.#body.byteLength, input.expectedByteCount);
    this.lastKey = input.objectKey;
    this.#mediaType = input.mediaType;
    this.putCount += 1;
    return { versionId: "v1", byteCount: this.#body.byteLength, mediaType: input.mediaType };
  }

  tamper(): void {
    this.#body = new TextEncoder().encode('{"tampered":true}');
  }
}

function chunks(value: Uint8Array): AsyncIterable<Uint8Array> {
  return Readable.from([value]);
}
