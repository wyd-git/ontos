import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";

import { loadTestkitAssets } from "./assets.ts";
import { DATASET_PRESETS, datasetDigest, generateLinks, generateObjects } from "./generator.ts";
import type { JsonObject, JsonValue } from "./assets.ts";
import type { GeneratedLink, GeneratedObject } from "./generator.ts";

void test("loads two full domain packages and all migrated vector groups without G1 runtime", async () => {
  const assets = await loadTestkitAssets();

  for (const manifest of [assets.commercePackage, assets.workManagementPackage]) {
    const resources = objectField(manifest, "resources");
    assert.equal(arrayField(resources, "objectTypes").length, 5);
    assert.equal(arrayField(resources, "linkTypes").length, 5);
    assert.equal(arrayField(resources, "actions").length, 3);
    assert.equal(arrayField(resources, "policies").length, 2);
    assert.equal(arrayField(resources, "views").length, 2);
  }

  assert.equal(arrayField(assets.queryCorpus, "cases").length, 10);
  assert.equal(arrayField(assets.overlayConflictVectors, "cases").length, 9);
  assert.equal(arrayField(assets.policyVectors, "cases").length, 8);
  assert.equal(arrayField(assets.packageCompatibilityVectors, "cases").length, 8);
  assert.deepEqual(Object.keys(objectField(assets.provenance, "groups")).sort(), [
    "compatibility",
    "generator",
    "metadataPackages",
    "overlay",
    "packages",
    "policy",
    "query",
  ]);
});

void test("preserves the frozen query and semantic vector identifiers", async () => {
  const assets = await loadTestkitAssets();
  assert.deepEqual(caseIds(assets.queryCorpus), [
    "primary-key-get",
    "status-time-list",
    "policy-region-list",
    "name-prefix",
    "name-contains",
    "amount-range",
    "tags-contains-any",
    "policy-aggregate",
    "one-hop",
    "two-hop",
  ]);
  assert.ok(caseIds(assets.overlayConflictVectors).includes("same-property-base-change"));
  assert.ok(caseIds(assets.policyVectors).includes("link-denial-precedes-execution"));
  assert.ok(
    caseIds(assets.packageCompatibilityVectors).includes("namespace-link-action-policy-breaking"),
  );
});

void test("generates the small preset deterministically with a frozen digest", () => {
  const firstObjects = [...generateObjects(DATASET_PRESETS.small)];
  const firstLinks = [...generateLinks(DATASET_PRESETS.small)];
  assert.equal(firstObjects.length, 50);
  assert.equal(firstLinks.length, 100);
  assert.deepEqual(firstObjects[0], {
    objectType: "EntityA",
    objectRid: "EntityA:000001",
    primaryKey: "EA-000001",
    properties: {
      name: "EntityA record 1",
      status: "OPEN",
      updatedAt: "2025-01-01T00:37:00.000000Z",
      amount: 79.19,
      active: true,
      region: "EAST",
      sensitiveCode: "SC-fb307c5b70ca324bba63ef482bf6e5cb",
      tags: ["tag-1", "bucket-1"],
    },
    sourceRowNumber: 1,
  });
  assert.deepEqual(firstLinks[0], {
    linkType: "LinkAB",
    linkRid: "LinkAB:1",
    sourceObjectType: "EntityA",
    sourceObjectRid: "EntityA:000008",
    targetObjectType: "EntityB",
    targetObjectRid: "EntityB:000008",
  });
  assert.equal(
    datasetDigest(DATASET_PRESETS.small),
    "sha256:c880db0bcab4a4bacff483928f3e6b6d58ade6cca4833c9220b5e3632f8d89f9",
  );
  assert.equal(datasetDigest(DATASET_PRESETS.small), datasetDigest(DATASET_PRESETS.small));
});

void test("streams the 100k object and 1m link benchmark preset without materializing it", () => {
  let objectCount = 0;
  let lastObject: GeneratedObject | undefined;
  for (const object of generateObjects(DATASET_PRESETS.benchmark)) {
    objectCount += 1;
    lastObject = object;
  }
  let linkCount = 0;
  let lastLink: GeneratedLink | undefined;
  for (const link of generateLinks(DATASET_PRESETS.benchmark)) {
    linkCount += 1;
    lastLink = link;
  }

  assert.equal(objectCount, 100_000);
  assert.equal(linkCount, 1_000_000);
  assert.equal(lastObject?.objectRid, "EntityE:020000");
  assert.deepEqual(lastLink, {
    linkType: "LinkEA",
    linkRid: "LinkEA:1000000",
    sourceObjectType: "EntityE",
    sourceObjectRid: "EntityE:000001",
    targetObjectType: "EntityA",
    targetObjectRid: "EntityA:000051",
  });
});

void test("uses the seed and rejects impossible generation configurations", () => {
  const alternative = { ...DATASET_PRESETS.small, seed: "seed-alternative" };
  assert.notEqual(datasetDigest(alternative), datasetDigest(DATASET_PRESETS.small));
  assert.throws(
    () => [...generateLinks({ seed: "seed", objectCount: 4, linkCount: 1 })],
    /At least one object per type/,
  );
  assert.throws(
    () => [...generateObjects({ seed: "", objectCount: 1, linkCount: 0 })],
    /seed must not be empty/,
  );
});

void test("keeps fixtures small and free from local credentials, ports, paths, and generated bulk data", async () => {
  let totalBytes = 0;
  const files = await listFixtureFiles(new URL("../fixtures/", import.meta.url));
  assert.equal(files.length, 10);
  for (const url of files) {
    const contents = await readFile(url, "utf8");
    totalBytes += (await stat(url)).size;
    assert.doesNotMatch(contents, /DATABASE_URL|localhost|\/Users\/|example-password|:543\d/);
  }
  assert.ok(
    totalBytes < 512 * 1024,
    `Testkit fixture assets unexpectedly total ${totalBytes} bytes.`,
  );
});

async function listFixtureFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: URL[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...(await listFixtureFiles(new URL(`${entry.name}/`, directory))));
    } else if (entry.isFile()) {
      files.push(new URL(entry.name, directory));
    }
  }
  return files.sort((left, right) => left.href.localeCompare(right.href));
}

function caseIds(asset: JsonObject): string[] {
  return arrayField(asset, "cases").map((candidate) => {
    const record = expectObject(candidate, "case");
    const id = record.id;
    if (typeof id !== "string") throw new Error("Vector case id must be a string.");
    return id;
  });
}

function objectField(record: JsonObject, key: string): JsonObject {
  return expectObject(record[key], key);
}

function arrayField(record: JsonObject, key: string): readonly JsonValue[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array.`);
  return value as readonly JsonValue[];
}

function expectObject(value: JsonValue | undefined, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}
