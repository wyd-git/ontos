import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyChangedPaths,
  isCommitSha,
  isFastDocumentationPath,
  isTrustedFastGateEvent,
} from "./change-risk.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);

void test("routes ordinary Markdown documentation through the fast profile", () => {
  const result = classifyChangedPaths(
    [
      "docs/product/ontology-kernel-implementation-blueprint.md",
      "README.md",
      "docs/architecture/core-database-design.md",
      "docs/operations/query-runtime.md",
      "docs/delivery/g2-03-query-policy-task-pack.md",
    ],
    base,
    head,
  );

  assert.equal(result.profile, "fast-docs");
  assert.deepEqual(result.fullGateFiles, []);
  assert.equal(result.changedFiles.length, 5);
});

void test("routes code, migrations, dependencies and machine policy through the full profile", () => {
  for (const path of [
    "apps/api/src/main.ts",
    "migrations/db-00/0022_query_policy.sql",
    "package-lock.json",
    ".github/workflows/foundation-ci.yml",
    "security/g2-02-evidence-policy.json",
    "docs/architecture/query.png",
  ]) {
    const result = classifyChangedPaths([path], base, head);
    assert.equal(result.profile, "full", path);
    assert.deepEqual(result.fullGateFiles, [path]);
  }
});

void test("keeps accepted ADR, evidence and review decisions on the full profile", () => {
  for (const path of [
    "docs/architecture/adr/020-query-policy-runtime.md",
    "docs/evidence/g2-03-01-query-policy-architecture.md",
    "docs/reviews/g2-03-01-red-team.md",
  ]) {
    assert.equal(isFastDocumentationPath(path), false, path);
  }
});

void test("a mixed or suspicious diff always fails closed to the full profile", () => {
  const mixed = classifyChangedPaths(
    ["docs/operations/query-runtime.md", "packages/query/src/index.ts"],
    base,
    head,
  );
  assert.equal(mixed.profile, "full");
  assert.deepEqual(mixed.fullGateFiles, ["packages/query/src/index.ts"]);

  for (const path of ["", "/docs/readme.md", "docs/../README.md", "docs\\readme.md"]) {
    assert.equal(isFastDocumentationPath(path), false, path);
  }
  assert.equal(classifyChangedPaths([], base, head).profile, "full");
});

void test("accepts only complete lowercase SHA-1 comparison identifiers", () => {
  assert.equal(isCommitSha("c".repeat(40)), true);
  assert.equal(isCommitSha("C".repeat(40)), false);
  assert.equal(isCommitSha("c".repeat(39)), false);
  assert.equal(isCommitSha(undefined), false);
});

void test("only trusted pull request and push events may select the fast profile", () => {
  assert.equal(isTrustedFastGateEvent("true", "pull_request"), true);
  assert.equal(isTrustedFastGateEvent("true", "push"), true);
  assert.equal(isTrustedFastGateEvent("true", "schedule"), false);
  assert.equal(isTrustedFastGateEvent("true", "workflow_dispatch"), false);
  assert.equal(isTrustedFastGateEvent(undefined, "pull_request"), false);
  assert.equal(isTrustedFastGateEvent("false", "push"), false);
});
