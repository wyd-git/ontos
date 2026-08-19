import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  gateNamesForProfile,
  nonQualifyingEvidenceDefinition,
  parseTestCount,
  redactOutput,
} from "./run.ts";

const workflow = await readFile(resolve(".github/workflows/foundation-ci.yml"), "utf8");

void test("CI report output redacts credential assignments and high-confidence tokens", () => {
  const token = ["ghp", "_", "A".repeat(40)].join("");
  const output = redactOutput(`password=do-not-report-this-value\ntoken=${token}\n`);

  assert.equal(output.includes("do-not-report-this-value"), false);
  assert.equal(output.includes(token), false);
  assert.match(output, /\[REDACTED/u);
});

void test("extracts the final TAP test count for the evidence report", () => {
  assert.equal(parseTestCount("ℹ tests 7\nℹ pass 7\n"), 7);
  assert.equal(parseTestCount("no TAP summary"), null);
});

void test("GitHub CI keeps one required gate and provides a trusted comparison range", () => {
  const timeout = /^\s*timeout-minutes:\s*(\d+)\s*$/mu.exec(workflow);
  assert.ok(timeout);
  assert.ok(Number(timeout[1]) >= 90);
  assert.equal((workflow.match(/^\s*run:\s*npm run verify\s*$/gmu) ?? []).length, 1);
  assert.equal((workflow.match(/^\s*run:/gmu) ?? []).length, 1);
  assert.equal(workflow.includes("test:materialization-clean-room"), false);
  assert.equal(workflow.includes("ONTOS_CI_BASE_SHA"), true);
  assert.equal(workflow.includes("github.event.pull_request.base.sha"), true);
  assert.equal(workflow.includes("github.event.before"), true);
  assert.equal(workflow.includes("ONTOS_CI_HEAD_SHA"), true);
  assert.equal(workflow.includes("ONTOS_CI_EVENT_NAME"), true);
  assert.equal(workflow.includes("ONTOS_CI_PR_DRAFT"), true);
  assert.equal(workflow.includes("ready_for_review"), true);
  assert.equal(workflow.includes("converted_to_draft"), true);
  assert.equal(workflow.includes("Foundation Preflight"), true);
  assert.equal(workflow.includes("npm run verify:preflight"), false);
  assert.match(workflow, /^\s*schedule:\s*$/mu);
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/mu);
});

void test("fast, preflight and full profiles preserve distinct qualification boundaries", () => {
  assert.deepEqual(gateNamesForProfile("fast-docs"), [
    "lockfile-install",
    "toolchain",
    "format",
    "documentation-links",
    "unit",
    "secret-private-key",
  ]);
  const full = gateNamesForProfile("full");
  const preflight = gateNamesForProfile("preflight");
  assert.equal(full.length, 38);
  assert.equal(preflight.length, 35);
  assert.deepEqual(
    full.filter((gate) => !preflight.includes(gate)),
    [
      "materialization-clean-room",
      "materialization-scope-evidence",
      "g2-03-01-architecture-evidence",
    ],
  );
  assert.ok(preflight.includes("postgres-integration"));
  assert.ok(preflight.includes("g2-03-03-persistence-evidence"));
  assert.ok(preflight.includes("metadata-clean-room"));
  assert.deepEqual(preflight.slice(-3), [
    "production-boundary-up",
    "production-boundary-smoke",
    "production-boundary-down",
  ]);
  assert.ok(full.includes("materialization-clean-room"));
  assert.ok(full.includes("metadata-clean-room"));
  assert.ok(full.includes("g2-03-01-web-spike"));
  assert.ok(full.includes("g2-03-01-architecture-evidence"));
  assert.ok(full.includes("runtime-read-contract-generation"));
  assert.ok(full.includes("g2-03-02-contract-evidence"));
  assert.ok(full.includes("g2-03-03-persistence-evidence"));
  assert.deepEqual(full.slice(-3), [
    "production-boundary-up",
    "production-boundary-smoke",
    "production-boundary-down",
  ]);
});

void test("non-qualifying artifacts cannot masquerade as the protected full gate", () => {
  const preflight = nonQualifyingEvidenceDefinition("preflight", "true", "pull_request", "true");
  assert.deepEqual(preflight, {
    fileName: "preflight-evidence.json",
    gate: "Foundation Preflight",
    qualification: "PREFLIGHT_PASS",
    closesG2Gate: false,
    statement:
      "This Draft/local preflight omits the Materialization clean-room and dependent qualification manifests. It cannot satisfy the protected Foundation Gate, close a G2 work item, or authorize merge.",
  });

  assert.equal(
    nonQualifyingEvidenceDefinition("fast-docs", "true", "pull_request", "true").gate,
    "Foundation Preflight",
  );
  assert.equal(
    nonQualifyingEvidenceDefinition("fast-docs", "true", "pull_request", "false").gate,
    "Foundation Gate",
  );
});
