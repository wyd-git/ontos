import assert from "node:assert/strict";
import test from "node:test";

import { AdminCursorCodec, CursorError } from "../../apps/api/src/cursor.ts";

const codec = new AdminCursorCodec("test-only-cursor-hmac-secret-with-32-bytes");

void test("Admin cursors round-trip collection facts but remain opaque", () => {
  const resource = {
    namespace: "commerce.orders",
    apiName: "Order",
    resourceId: "00000000-0000-4000-8000-000000000001",
  };
  const token = codec.encodeResource("project-1", resource);
  assert.deepEqual(codec.decodeResource("project-1", token), resource);
  assert.equal(token.includes("commerce.orders"), false);

  const revision = {
    revisionNumber: 9n,
    revisionId: "00000000-0000-4000-8000-000000000002",
  };
  assert.deepEqual(
    codec.decodeRevision("resource-1", codec.encodeRevision("resource-1", revision)),
    revision,
  );
});

void test("Admin cursors reject tampering and collection replay", () => {
  const token = codec.encodeResource("project-1", {
    namespace: "commerce.orders",
    apiName: "Order",
    resourceId: "00000000-0000-4000-8000-000000000001",
  });
  assert.throws(() => codec.decodeResource("project-2", token), CursorError);
  const changed = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => codec.decodeResource("project-1", changed), CursorError);
});
