import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import { HeadBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { ManagedObjectStoreError, S3ManagedObjectStore } from "@ontos/object-store-s3";

const execFileAsync = promisify(execFile);
const s3Image =
  "chrislusf/seaweedfs:4.41@sha256:43b768cd62b00d132439cda881b93fd1adebf1b315e996e794087743821d771d";
const accessKeyId = "local-only-g20204-adapter-access";
const secretAccessKey = "local-only-g20204-adapter-secret";

void test(
  "managed object adapter requires versioning and preserves exact S3 versions",
  { timeout: 120_000 },
  async () => {
    const containerName = `ontos-g20204-s3-adapter-${process.pid}-${randomUUID().slice(0, 8)}`;
    const bucket = `ontos-g20204-adapter-${process.pid}`;
    const hostPort = await reserveLoopbackPort();
    const endpoint = `http://127.0.0.1:${String(hostPort)}`;
    const objectKey = `ingress/aa/${randomUUID()}.csv`;
    const rejectedObjectKey = `rejected/bb/${randomUUID()}.jsonl`;
    let rawClient: S3Client | null = null;
    let store: S3ManagedObjectStore | null = null;

    await docker([
      "run",
      "--detach",
      "--name",
      containerName,
      "--env",
      `AWS_ACCESS_KEY_ID=${accessKeyId}`,
      "--env",
      `AWS_SECRET_ACCESS_KEY=${secretAccessKey}`,
      "--env",
      `S3_BUCKET=${bucket}`,
      "--tmpfs",
      "/data:rw,noexec,nosuid,size=1g",
      "--publish",
      `127.0.0.1:${String(hostPort)}:8333`,
      s3Image,
      "mini",
      "-dir=/data",
    ]);

    try {
      rawClient = new S3Client({
        endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: { accessKeyId, secretAccessKey },
      });
      store = new S3ManagedObjectStore({
        endpoint,
        region: "us-east-1",
        bucket,
        accessKeyId,
        secretAccessKey,
        forcePathStyle: true,
        maxAttempts: 1,
      });
      await waitForS3(rawClient, bucket);
      await rawClient.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
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
        new Set(
          beforeCleanup.filter((entry) => !entry.deleteMarker).map((entry) => entry.versionId),
        ),
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

      const rejectedBytes = new TextEncoder().encode(
        '{"columnClassification":"redacted","reasonCode":"OPTIONAL_PROPERTY_INVALID"}\n',
      );
      const rejected = await store.putVersion({
        objectKey: rejectedObjectKey,
        body: chunked(rejectedBytes, 7),
        expectedByteCount: rejectedBytes.byteLength,
        mediaType: "application/vnd.ontos.rejected-rows+json",
      });
      const rejectedHead = await store.headLatestVersion(rejectedObjectKey);
      assert.deepEqual(rejectedHead, {
        versionId: rejected.versionId,
        byteCount: rejectedBytes.byteLength,
        mediaType: "application/vnd.ontos.rejected-rows+json",
      });
      const rejectedVersion = await store.readVersion(rejectedObjectKey, rejected.versionId);
      assert.equal(rejectedVersion.versionId, rejected.versionId);
      assert.equal(rejectedVersion.mediaType, "application/vnd.ontos.rejected-rows+json");
      assert.deepEqual(await readAll(rejectedVersion.body), rejectedBytes);
      await assert.rejects(
        store.putVersion({
          objectKey: rejectedObjectKey,
          body: chunked(rejectedBytes, 7),
          expectedByteCount: rejectedBytes.byteLength,
          mediaType: "text/csv",
        }),
        (error: unknown) =>
          error instanceof ManagedObjectStoreError && error.code === "CONFIGURATION_INVALID",
      );
    } finally {
      if (store !== null) {
        for (const key of [objectKey, rejectedObjectKey]) {
          for (const entry of await store.listVersions(key).catch(() => [])) {
            await store.deleteVersion(key, entry.versionId).catch(() => undefined);
          }
        }
      }
      store?.destroy();
      rawClient?.destroy();
      await docker(["rm", "--force", "--volumes", containerName], true);
    }
  },
);

async function waitForS3(client: S3Client, bucket: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("S3 integration container did not become ready.", { cause: lastError });
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error("Loopback port reservation failed.");
  }
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
  return port;
}

async function docker(arguments_: readonly string[], tolerateFailure = false): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", [...arguments_]);
    return stdout.trim();
  } catch (error) {
    if (tolerateFailure) return "";
    throw error;
  }
}

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
