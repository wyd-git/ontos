import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { scanText } from "./secret-scan.ts";

void test("blocks reconstructed private keys and tokens without returning their values", () => {
  const privateKey = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  const token = ["ghp", "_", "A".repeat(40)].join("");
  const findings = scanText("fixture.txt", `${privateKey}\nTOKEN=${token}\n`, new Set());

  assert.deepEqual(
    findings.map(({ rule, path, line }) => ({ rule, path, line })),
    [
      { rule: "PRIVATE_KEY_HEADER", path: "fixture.txt", line: 1 },
      { rule: "GITHUB_TOKEN", path: "fixture.txt", line: 2 },
      { rule: "GENERIC_SECRET_ASSIGNMENT", path: "fixture.txt", line: 2 },
    ],
  );
  assert.equal(JSON.stringify(findings).includes(token), false);
  // G2_NEGATIVE:secret_material
});

void test("allows only the exact SHA-256 allowlisted public sample value", () => {
  const sample = "local-only-purpose-specific-secret";
  const allowlist = new Set([createHash("sha256").update(sample).digest("hex")]);

  assert.deepEqual(scanText(".env.example", `CLIENT_SECRET=${sample}\n`, allowlist), []);
  assert.equal(
    scanText(".env.example", `CLIENT_SECRET=${sample}-changed\n`, allowlist)[0]?.rule,
    "GENERIC_SECRET_ASSIGNMENT",
  );
});
