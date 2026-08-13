import assert from "node:assert/strict";
import test from "node:test";

import { validateToolchain } from "./check-versions.mjs";

const expected = { expectedNode: "24.18.0", expectedNpm: "11.16.0" };

test("accepts the exact pinned Node.js and npm versions", () => {
  assert.deepEqual(
    validateToolchain({
      ...expected,
      nodeVersion: "24.18.0",
      npmUserAgent: "npm/11.16.0 node/v24.18.0 darwin arm64",
    }),
    [],
  );
});

test("rejects a different Node.js patch release", () => {
  assert.match(
    validateToolchain({
      ...expected,
      nodeVersion: "24.17.0",
      npmUserAgent: "npm/11.16.0 node/v24.17.0 darwin arm64",
    })[0],
    /Node\.js 24\.18\.0 is required/,
  );
});

test("rejects a different or undiscoverable package manager", () => {
  const wrongVersion = validateToolchain({
    ...expected,
    nodeVersion: "24.18.0",
    npmUserAgent: "npm/12.0.2 node/v24.18.0 darwin arm64",
  });
  const unknownClient = validateToolchain({
    ...expected,
    nodeVersion: "24.18.0",
    npmUserAgent: undefined,
  });

  assert.match(wrongVersion[0], /npm 11\.16\.0 is required/);
  assert.match(unknownClient[0], /unknown\/non-npm client/);
});
