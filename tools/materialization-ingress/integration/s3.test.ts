import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import { PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { ManagedObjectStoreError, S3ManagedObjectStore } from "@ontos/object-store-s3";

import { loadLocalEnvironmentConfig, localEndpoints } from "../../local-env/config.ts";

void test("managed object adapter requires versioning and preserves exact S3 versions", async () => {
  const environment = await loadLocalEnvironmentConfig();
  const rawClient = new S3Client({
    endpoint: localEndpoints.s3.endpoint,
    region: localEndpoints.s3.region,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: environment.s3.accessKeyId,
      secretAccessKey: environment.s3.secretAccessKey,
    },
  });
  const store = new S3ManagedObjectStore({
    endpoint: localEndpoints.s3.endpoint,
    region: localEndpoints.s3.region,
    bucket: environment.s3.bucket,
    accessKeyId: environment.s3.accessKeyId,
    secretAccessKey: environment.s3.secretAccessKey,
    forcePathStyle: true,
    maxAttempts: 1,
  });
  const objectKey = `ingress/aa/${randomUUID()}.csv`;

  try {
    await rawClient.send(
      new PutBucketVersioningCommand({
        Bucket: environment.s3.bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
    await store.assertVersioningEnabled();

    const firstBytes = new TextEncoder().encode("id,name\n1,A");
    const secondBytes = new TextEncoder().encode("id,name\n2,B");
    const first = await store.putVersion({
      objectKey,
      body: chunked(firstBytes, 2),
      expectedByteCount: firstBytes.byteLength,
      mediaType: "text/csv",
    });
    const second = await store.putVersion({
      objectKey,
      body: chunked(secondBytes, 3),
      expectedByteCount: secondBytes.byteLength,
      mediaType: "text/csv",
    });
    assert.notEqual(first.versionId, second.versionId);

    const latest = await store.headLatestVersion(objectKey);
    assert.equal(latest.versionId, second.versionId);
    assert.equal(latest.byteCount, secondBytes.byteLength);
    assert.equal(latest.mediaType, "text/csv");

    assert.deepEqual(
      await readAll((await store.readVersion(objectKey, first.versionId)).body),
      firstBytes,
    );
    assert.deepEqual(
      await readAll((await store.readVersion(objectKey, second.versionId)).body),
      secondBytes,
    );

    await assert.rejects(
      store.readVersion(objectKey, "missing-managed-version"),
      (error: unknown) =>
        error instanceof ManagedObjectStoreError &&
        error.code === "NOT_FOUND" &&
        !error.message.includes(objectKey),
    );
    await assert.rejects(
      store.putVersion({
        objectKey: `ingress/bb/${randomUUID()}.csv`,
        body: chunked(firstBytes, 2),
        expectedByteCount: 1,
        mediaType: "text/csv",
      }),
      (error: unknown) =>
        error instanceof ManagedObjectStoreError && error.code === "CONTENT_LENGTH_MISMATCH",
    );

    const beforeCleanup = await store.listVersions(objectKey);
    assert.deepEqual(
      new Set(beforeCleanup.filter((entry) => !entry.deleteMarker).map((entry) => entry.versionId)),
      new Set([first.versionId, second.versionId]),
    );
    assert.equal(
      await store.deleteUnregisteredVersions(objectKey, new Set([second.versionId])),
      beforeCleanup.length - 1,
    );
    assert.deepEqual(
      (await store.listVersions(objectKey)).map((entry) => entry.versionId),
      [second.versionId],
    );
  } finally {
    for (const entry of await store.listVersions(objectKey).catch(() => [])) {
      await store.deleteVersion(objectKey, entry.versionId).catch(() => undefined);
    }
    store.destroy();
    rawClient.destroy();
  }
});

function chunked(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  return Readable.from(
    (function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += size) {
        yield bytes.subarray(offset, Math.min(offset + size, bytes.byteLength));
      }
    })(),
  );
}

async function readAll(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    byteCount += chunk.byteLength;
  }
  const result = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
