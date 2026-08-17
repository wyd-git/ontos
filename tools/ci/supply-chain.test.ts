import assert from "node:assert/strict";
import test from "node:test";

import {
  createLicenseReport,
  evaluateVulnerabilityReport,
  type VulnerabilityPolicy,
} from "./supply-chain.ts";

const advisoryUrl = "https://github.com/advisories/GHSA-test-test-test";
const emptyWaiverPolicy: VulnerabilityPolicy = {
  schemaVersion: 1,
  blockingSeverities: ["critical", "high"],
  reportingSeverities: ["moderate", "low", "info"],
  maximumWaiverDays: 30,
  waivers: [],
};

void test("license gate covers external locks and blocks missing or unapproved licenses", () => {
  const report = createLicenseReport(
    {
      packages: {
        "": { name: "root" },
        "packages/local": { link: true },
        "node_modules/allowed": { version: "1.0.0", license: "MIT", dev: true },
        "node_modules/blocked": { version: "2.0.0", license: "GPL-3.0-only" },
        "node_modules/missing": { version: "3.0.0" },
      },
    },
    new Set(["MIT"]),
  );

  assert.equal(report.packageCount, 3);
  assert.equal(report.status, "FAIL");
  assert.equal(report.violations.length, 2);
});

void test("a package license approval is exact, auditable and cannot widen the SPDX allowlist", () => {
  const lock = {
    packages: {
      "node_modules/build-only": {
        version: "1.2.3",
        license: "MPL-2.0",
        dev: true,
      },
    },
  };
  const approval = {
    name: "build-only",
    version: "1.2.3",
    license: "MPL-2.0",
    scope: "dev" as const,
    owner: "platform-security",
    reason: "Pinned build-time dependency reviewed for this exact lock entry.",
  };

  const approved = createLicenseReport(lock, new Set(["MIT"]), [approval]);
  assert.equal(approved.status, "PASS");
  assert.deepEqual(approved.entries[0]?.policyApproval, {
    owner: approval.owner,
    reason: approval.reason,
  });

  const wrongVersion = createLicenseReport(lock, new Set(["MIT"]), [
    { ...approval, version: "1.2.4" },
  ]);
  assert.equal(wrongVersion.status, "FAIL");
  assert.equal(
    wrongVersion.violations.some((violation) => violation.includes("unapproved license")),
    true,
  );
  assert.equal(
    wrongVersion.violations.some((violation) => violation.includes("does not exactly match")),
    true,
  );
});

void test("high vulnerabilities block while moderate vulnerabilities remain report-only", () => {
  const high = evaluateVulnerabilityReport(audit("high"), emptyWaiverPolicy);
  const moderate = evaluateVulnerabilityReport(audit("moderate"), emptyWaiverPolicy);

  assert.equal(high.status, "FAIL");
  assert.match(high.errors[0] ?? "", /unwaived high/u);
  assert.equal(moderate.status, "PASS");
  assert.equal(moderate.findings[0]?.severity, "moderate");
});

void test("only an active exact advisory waiver can release a blocking finding", () => {
  const policy: VulnerabilityPolicy = {
    ...emptyWaiverPolicy,
    waivers: [
      {
        package: "fixture-package",
        severity: "high",
        advisoryUrls: [advisoryUrl],
        owner: "platform-security",
        reason: "Upgrade is being validated.",
        created: "2026-08-01",
        expires: "2026-08-20",
      },
    ],
  };

  assert.equal(
    evaluateVulnerabilityReport(audit("high"), policy, new Date("2026-08-14T00:00:00Z")).status,
    "PASS",
  );
  const expired = evaluateVulnerabilityReport(
    audit("high"),
    policy,
    new Date("2026-08-21T00:00:00Z"),
  );
  assert.equal(expired.status, "FAIL");
  assert.ok(expired.errors.some((error) => error.includes("expired")));
});

void test("malformed or network-error-shaped audit output fails closed", () => {
  assert.equal(evaluateVulnerabilityReport({}, emptyWaiverPolicy).status, "FAIL");
  assert.equal(
    evaluateVulnerabilityReport({ error: { summary: "network unavailable" } }, emptyWaiverPolicy)
      .status,
    "FAIL",
  );
});

function audit(severity: string): unknown {
  return {
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: severity === "moderate" ? 1 : 0,
        high: severity === "high" ? 1 : 0,
        critical: 0,
        total: 1,
      },
    },
    vulnerabilities: {
      "fixture-package": {
        severity,
        via: [{ url: advisoryUrl, severity }],
        effects: [],
        range: "<1.0.0",
        nodes: ["node_modules/fixture-package"],
        fixAvailable: true,
      },
    },
  };
}
