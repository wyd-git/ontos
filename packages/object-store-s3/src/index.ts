import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";

import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  type ArtifactDigest,
} from "@ontos/contracts";
import type { PolicyArtifactKind, PolicyArtifactStore } from "@ontos/policy-application";
import { createHash } from "node:crypto";

export interface S3ManagedObjectStoreConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle?: boolean;
  readonly maxAttempts?: number;
}

export type ManagedObjectStoreErrorCode =
  | "CONFIGURATION_INVALID"
  | "CONTENT_LENGTH_MISMATCH"
  | "NOT_FOUND"
  | "VERSION_MISMATCH"
  | "UNAVAILABLE";

export class ManagedObjectStoreError extends Error {
  readonly code: ManagedObjectStoreErrorCode;

  constructor(code: ManagedObjectStoreErrorCode, options?: ErrorOptions) {
    super(objectStoreErrorMessage(code), options);
    this.name = "ManagedObjectStoreError";
    this.code = code;
  }
}

export interface ManagedObjectVersionMetadata {
  readonly versionId: string;
  readonly byteCount: number;
  readonly mediaType: string | null;
}

export interface ManagedObjectVersionBody extends ManagedObjectVersionMetadata {
  readonly body: AsyncIterable<Uint8Array>;
}

export interface ManagedObjectVersionEntry {
  readonly versionId: string;
  readonly deleteMarker: boolean;
}

export type ManagedObjectMediaType =
  | "text/csv"
  | "application/vnd.ontos.rejected-rows+json"
  | "application/vnd.ontos.policy-ir+json"
  | "application/vnd.ontos.policy-test+json";

const ingressObjectKeyPattern =
  /^ingress\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]csv$/u;
const rejectedObjectKeyPattern =
  /^rejected\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]jsonl$/u;
const policyObjectKeyPattern = /^policy\/(?:ir|test)\/[0-9a-f]{64}[.]json$/u;
const silentS3Logger = Object.freeze({
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

export class S3ManagedObjectStore {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(configInput: S3ManagedObjectStoreConfig) {
    const config = parseConfig(configInput);
    this.#bucket = config.bucket;
    this.#client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      maxAttempts: config.maxAttempts,
      // Dependency output can include endpoints, Keys, headers or request details.
      // The application emits its own bounded stable telemetry instead.
      logger: silentS3Logger,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async assertVersioningEnabled(): Promise<void> {
    try {
      const response = await this.#client.send(
        new GetBucketVersioningCommand({ Bucket: this.#bucket }),
      );
      if (response.Status !== "Enabled") {
        throw new ManagedObjectStoreError("CONFIGURATION_INVALID");
      }
    } catch (error) {
      throw mapObjectStoreError(error);
    }
  }

  async putVersion(input: {
    readonly objectKey: string;
    readonly body: AsyncIterable<Uint8Array>;
    readonly expectedByteCount: number;
    readonly mediaType: ManagedObjectMediaType;
  }): Promise<ManagedObjectVersionMetadata> {
    const objectKey = parseManagedObjectKey(input.objectKey);
    assertManagedMediaType(objectKey, input.mediaType);
    const expectedByteCount = parseByteCount(input.expectedByteCount);
    const uploadBody = new PassThrough();
    const abortController = new AbortController();
    const uploadPromise = this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        Body: uploadBody,
        ContentLength: expectedByteCount,
        ContentType: input.mediaType,
      }),
      { abortSignal: abortController.signal },
    );
    const pumpPromise = pumpExactLength(input.body, expectedByteCount, uploadBody);
    try {
      const [response] = await Promise.all([uploadPromise, pumpPromise]);
      const versionId = parseVersionId(response.VersionId);
      return Object.freeze({
        versionId,
        byteCount: expectedByteCount,
        mediaType: input.mediaType,
      });
    } catch (error) {
      abortController.abort();
      uploadBody.destroy();
      await Promise.allSettled([uploadPromise, pumpPromise]);
      throw mapObjectStoreError(error);
    } finally {
      uploadBody.destroy();
    }
  }

  async headLatestVersion(objectKeyInput: string): Promise<ManagedObjectVersionMetadata> {
    const objectKey = parseManagedObjectKey(objectKeyInput);
    try {
      const response = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
      );
      return Object.freeze({
        versionId: parseVersionId(response.VersionId),
        byteCount: parseByteCount(response.ContentLength),
        mediaType: response.ContentType ?? null,
      });
    } catch (error) {
      throw mapObjectStoreError(error);
    }
  }

  async readVersion(
    objectKeyInput: string,
    versionIdInput: string,
  ): Promise<ManagedObjectVersionBody> {
    const objectKey = parseManagedObjectKey(objectKeyInput);
    const versionId = parseVersionId(versionIdInput);
    try {
      const response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: objectKey, VersionId: versionId }),
      );
      if (parseVersionId(response.VersionId) !== versionId) {
        throw new ManagedObjectStoreError("VERSION_MISMATCH");
      }
      if (!isAsyncByteBody(response.Body)) {
        throw new ManagedObjectStoreError("UNAVAILABLE");
      }
      return Object.freeze({
        versionId,
        byteCount: parseByteCount(response.ContentLength),
        mediaType: response.ContentType ?? null,
        body: normalizeBody(response.Body),
      });
    } catch (error) {
      throw mapObjectStoreError(error);
    }
  }

  async listVersions(objectKeyInput: string): Promise<readonly ManagedObjectVersionEntry[]> {
    const objectKey = parseManagedObjectKey(objectKeyInput);
    const result: ManagedObjectVersionEntry[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    try {
      do {
        const response = await this.#client.send(
          new ListObjectVersionsCommand({
            Bucket: this.#bucket,
            Prefix: objectKey,
            ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
            ...(versionIdMarker === undefined ? {} : { VersionIdMarker: versionIdMarker }),
          }),
        );
        for (const version of response.Versions ?? []) {
          if (version.Key !== objectKey) continue;
          result.push(
            Object.freeze({ versionId: parseVersionId(version.VersionId), deleteMarker: false }),
          );
        }
        for (const marker of response.DeleteMarkers ?? []) {
          if (marker.Key !== objectKey) continue;
          result.push(
            Object.freeze({ versionId: parseVersionId(marker.VersionId), deleteMarker: true }),
          );
        }
        if (response.IsTruncated === true) {
          if (response.NextKeyMarker === undefined || response.NextVersionIdMarker === undefined) {
            throw new ManagedObjectStoreError("UNAVAILABLE");
          }
          keyMarker = response.NextKeyMarker;
          versionIdMarker = response.NextVersionIdMarker;
        } else {
          keyMarker = undefined;
          versionIdMarker = undefined;
        }
      } while (keyMarker !== undefined);
      return Object.freeze(result);
    } catch (error) {
      throw mapObjectStoreError(error);
    }
  }

  async deleteVersion(objectKeyInput: string, versionIdInput: string): Promise<void> {
    const objectKey = parseManagedObjectKey(objectKeyInput);
    const versionId = parseVersionId(versionIdInput);
    try {
      await this.#client.send(
        new DeleteObjectCommand({ Bucket: this.#bucket, Key: objectKey, VersionId: versionId }),
      );
    } catch (error) {
      throw mapObjectStoreError(error);
    }
  }

  async deleteUnregisteredVersions(
    objectKeyInput: string,
    protectedVersionIds: ReadonlySet<string>,
  ): Promise<number> {
    const objectKey = parseManagedObjectKey(objectKeyInput);
    let deleted = 0;
    for (const entry of await this.listVersions(objectKey)) {
      if (protectedVersionIds.has(entry.versionId)) continue;
      await this.deleteVersion(objectKey, entry.versionId);
      deleted += 1;
    }
    return deleted;
  }

  destroy(): void {
    this.#client.destroy();
  }
}

export class S3PolicyArtifactStore implements PolicyArtifactStore {
  readonly #store: PolicyManagedObjectStore;

  constructor(store: PolicyManagedObjectStore) {
    this.#store = store;
  }

  async putArtifact(input: {
    readonly kind: PolicyArtifactKind;
    readonly digest: ArtifactDigest;
    readonly canonicalBytes: string;
  }): Promise<void> {
    const digest = parseArtifactDigest(input.digest);
    assertPolicyBytesDigest(input.kind, input.canonicalBytes, digest);
    const objectKey = policyArtifactKey(input.kind, digest);
    const mediaType = policyArtifactMediaType(input.kind);
    try {
      const existing = await this.#store.headLatestVersion(objectKey);
      if (existing.mediaType !== mediaType) throw new ManagedObjectStoreError("VERSION_MISMATCH");
      const body = await this.#store.readVersion(objectKey, existing.versionId);
      const bytes = await readUtf8Body(body.body, existing.byteCount);
      assertPolicyBytesDigest(input.kind, bytes, digest);
      return;
    } catch (error) {
      if (!(error instanceof ManagedObjectStoreError) || error.code !== "NOT_FOUND") throw error;
    }
    const bytes = new TextEncoder().encode(input.canonicalBytes);
    await this.#store.putVersion({
      objectKey,
      body: singleChunk(bytes),
      expectedByteCount: bytes.byteLength,
      mediaType,
    });
  }

  async readArtifact(input: {
    readonly kind: PolicyArtifactKind;
    readonly digest: ArtifactDigest;
  }): Promise<string> {
    const digest = parseArtifactDigest(input.digest);
    const objectKey = policyArtifactKey(input.kind, digest);
    const mediaType = policyArtifactMediaType(input.kind);
    const head = await this.#store.headLatestVersion(objectKey);
    if (head.mediaType !== mediaType) throw new ManagedObjectStoreError("VERSION_MISMATCH");
    const object = await this.#store.readVersion(objectKey, head.versionId);
    const bytes = await readUtf8Body(object.body, object.byteCount);
    assertPolicyBytesDigest(input.kind, bytes, digest);
    return bytes;
  }
}

export interface PolicyManagedObjectStore {
  headLatestVersion(objectKey: string): Promise<ManagedObjectVersionMetadata>;
  readVersion(objectKey: string, versionId: string): Promise<ManagedObjectVersionBody>;
  putVersion(input: {
    readonly objectKey: string;
    readonly body: AsyncIterable<Uint8Array>;
    readonly expectedByteCount: number;
    readonly mediaType: ManagedObjectMediaType;
  }): Promise<ManagedObjectVersionMetadata>;
}

async function pumpExactLength(
  source: AsyncIterable<Uint8Array>,
  expectedByteCount: number,
  destination: PassThrough,
): Promise<void> {
  let byteCount = 0;
  try {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) {
        throw new ManagedObjectStoreError("CONTENT_LENGTH_MISMATCH");
      }
      byteCount += chunk.byteLength;
      if (byteCount > expectedByteCount) {
        throw new ManagedObjectStoreError("CONTENT_LENGTH_MISMATCH");
      }
      if (chunk.byteLength > 0 && !destination.write(chunk)) {
        await once(destination, "drain");
      }
    }
    if (byteCount !== expectedByteCount) {
      throw new ManagedObjectStoreError("CONTENT_LENGTH_MISMATCH");
    }
    destination.end();
  } catch (error) {
    destination.destroy();
    if (error instanceof ManagedObjectStoreError) throw error;
    throw new ManagedObjectStoreError("UNAVAILABLE", { cause: error });
  }
}

async function* normalizeBody(body: AsyncIterable<unknown>): AsyncIterable<Uint8Array> {
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) {
      throw new ManagedObjectStoreError("UNAVAILABLE");
    }
    yield chunk;
  }
}

function isAsyncByteBody(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function parseConfig(value: S3ManagedObjectStoreConfig): Required<S3ManagedObjectStoreConfig> {
  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch (error) {
    throw new ManagedObjectStoreError("CONFIGURATION_INVALID", { cause: error });
  }
  const maxAttempts = value.maxAttempts ?? 2;
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    !boundedConfigString(value.region, 128) ||
    !/^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$/u.test(value.bucket) ||
    !boundedConfigString(value.accessKeyId, 256) ||
    !boundedConfigString(value.secretAccessKey, 1024) ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 5
  ) {
    throw new ManagedObjectStoreError("CONFIGURATION_INVALID");
  }
  return Object.freeze({
    endpoint: endpoint.href,
    region: value.region,
    bucket: value.bucket,
    accessKeyId: value.accessKeyId,
    secretAccessKey: value.secretAccessKey,
    forcePathStyle: value.forcePathStyle ?? false,
    maxAttempts,
  });
}

function parseManagedObjectKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    (!ingressObjectKeyPattern.test(value) &&
      !rejectedObjectKeyPattern.test(value) &&
      !policyObjectKeyPattern.test(value))
  ) {
    throw new ManagedObjectStoreError("CONFIGURATION_INVALID");
  }
  return value;
}

function assertManagedMediaType(objectKey: string, mediaType: ManagedObjectMediaType): void {
  if (
    (ingressObjectKeyPattern.test(objectKey) && mediaType !== "text/csv") ||
    (rejectedObjectKeyPattern.test(objectKey) &&
      mediaType !== "application/vnd.ontos.rejected-rows+json") ||
    (objectKey.startsWith("policy/ir/") && mediaType !== "application/vnd.ontos.policy-ir+json") ||
    (objectKey.startsWith("policy/test/") && mediaType !== "application/vnd.ontos.policy-test+json")
  ) {
    throw new ManagedObjectStoreError("CONFIGURATION_INVALID");
  }
}

function policyArtifactKey(kind: PolicyArtifactKind, digest: ArtifactDigest): string {
  return `policy/${kind}/${digest.slice("sha256:".length)}.json`;
}

function policyArtifactMediaType(kind: PolicyArtifactKind): ManagedObjectMediaType {
  return kind === "ir"
    ? "application/vnd.ontos.policy-ir+json"
    : "application/vnd.ontos.policy-test+json";
}

function assertPolicyBytesDigest(
  kind: PolicyArtifactKind,
  bytes: string,
  expected: ArtifactDigest,
): void {
  let preimage = bytes;
  if (kind === "ir") {
    try {
      const parsed: unknown = JSON.parse(bytes);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("Policy Artifact must be an object.");
      }
      const { artifactDigest: embedded, ...withoutDigest } = parsed as Record<string, unknown>;
      if (embedded !== expected) throw new TypeError("Policy Artifact digest binding differs.");
      preimage = canonicalizeContractForDigest(withoutDigest);
    } catch (error) {
      throw new ManagedObjectStoreError("VERSION_MISMATCH", { cause: error });
    }
  }
  const actual = parseArtifactDigest(
    `sha256:${createHash("sha256").update(preimage, "utf8").digest("hex")}`,
  );
  if (actual !== expected) throw new ManagedObjectStoreError("VERSION_MISMATCH");
}

function singleChunk(value: Uint8Array): AsyncIterable<Uint8Array> {
  return Readable.from([value]);
}

async function readUtf8Body(
  body: AsyncIterable<Uint8Array>,
  expectedByteCount: number,
): Promise<string> {
  if (expectedByteCount > 64 * 1024 * 1024) {
    throw new ManagedObjectStoreError("CONTENT_LENGTH_MISMATCH");
  }
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  for await (const chunk of body) {
    byteCount += chunk.byteLength;
    if (byteCount > expectedByteCount) {
      throw new ManagedObjectStoreError("CONTENT_LENGTH_MISMATCH");
    }
    chunks.push(chunk);
  }
  if (byteCount !== expectedByteCount) {
    throw new ManagedObjectStoreError("CONTENT_LENGTH_MISMATCH");
  }
  const joined = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

function parseVersionId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) {
    throw new ManagedObjectStoreError("CONFIGURATION_INVALID");
  }
  return value;
}

function parseByteCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ManagedObjectStoreError("UNAVAILABLE");
  }
  return value as number;
}

function boundedConfigString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximumLength;
}

function mapObjectStoreError(error: unknown): ManagedObjectStoreError {
  if (error instanceof ManagedObjectStoreError) return error;
  if (isS3NotFound(error)) return new ManagedObjectStoreError("NOT_FOUND", { cause: error });
  return new ManagedObjectStoreError("UNAVAILABLE", { cause: error });
}

function isS3NotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Readonly<Record<string, unknown>>;
  if (record["name"] === "NoSuchKey" || record["name"] === "NoSuchVersion") return true;
  const metadata = record["$metadata"];
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as Readonly<Record<string, unknown>>)["httpStatusCode"] === 404
  );
}

function objectStoreErrorMessage(code: ManagedObjectStoreErrorCode): string {
  switch (code) {
    case "CONFIGURATION_INVALID":
      return "Managed object storage is not configured for versioned ingress.";
    case "CONTENT_LENGTH_MISMATCH":
      return "Managed object upload length does not match the session.";
    case "NOT_FOUND":
      return "The managed object version is not accessible.";
    case "VERSION_MISMATCH":
      return "The managed object version does not match the session.";
    case "UNAVAILABLE":
      return "Managed object storage is temporarily unavailable.";
  }
}
