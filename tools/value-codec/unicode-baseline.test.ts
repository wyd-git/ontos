import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const expectedNode = "v24.18.0";
const expectedIcu = "78.3";
const expectedUnicode = "17.0";
const expectedMappingDigest = "04eac79fe1912c1c6257c3c085217a946ee2595d424099fec79ece773614b855";

void test("Primary Key Unicode normalization and case mapping baseline cannot drift silently", () => {
  assert.equal(process.version, expectedNode);
  assert.equal(process.versions.icu, expectedIcu);
  assert.equal(process.versions.unicode, expectedUnicode);

  const hash = createHash("sha256");
  for (let codePoint = 0; codePoint <= 0x10_ff_ff; codePoint += 1) {
    if (codePoint >= 0xd8_00 && codePoint <= 0xdf_ff) continue;
    const value = String.fromCodePoint(codePoint);
    hash.update(codePoint.toString(16));
    hash.update(":");
    hash.update(value.normalize("NFC").toUpperCase().normalize("NFC"));
    hash.update("\n");
  }

  assert.equal(hash.digest("hex"), expectedMappingDigest);
});
