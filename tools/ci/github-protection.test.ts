import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { evaluateProtection, protectionRequest } from "./github-protection.ts";

const policy = JSON.parse(
  await readFile(resolve("security/main-branch-protection.json"), "utf8"),
) as Parameters<typeof protectionRequest>[0];

void test("builds the exact strict protection request with no permanent bypass", () => {
  assert.deepEqual(protectionRequest(policy), {
    required_status_checks: { strict: true, contexts: ["Foundation Gate"] },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 0,
      require_last_push_approval: false,
    },
    restrictions: null,
    required_linear_history: false,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: false,
    lock_branch: false,
    allow_fork_syncing: false,
  });
});

void test("accepts only an exact protected main response", () => {
  assert.deepEqual(evaluateProtection(protectedResponse(), policy), []);
});

void test("rejects non-strict checks, missing admin enforcement, force/delete and bypass", () => {
  const candidate = protectedResponse();
  candidate.required_status_checks.strict = false;
  candidate.enforce_admins.enabled = false;
  candidate.required_pull_request_reviews.bypass_pull_request_allowances.users.push({
    login: "owner",
  });
  candidate.allow_force_pushes.enabled = true;
  candidate.allow_deletions.enabled = true;

  assert.deepEqual(evaluateProtection(candidate, policy), [
    "Required status checks are not strict.",
    "Administrators are not subject to branch protection.",
    "Permanent pull-request bypass actors are configured.",
    "Force pushes are not disabled.",
    "Branch deletion is not disabled.",
  ]);
});

void test("rejects a missing PR rule or any required-check drift", () => {
  const missingPr: Record<string, unknown> = { ...protectedResponse() };
  missingPr.required_pull_request_reviews = null;
  const drift = protectedResponse();
  drift.required_status_checks.contexts = ["A similarly named check"];

  assert.deepEqual(evaluateProtection(missingPr, policy), ["Pull requests are not required."]);
  assert.deepEqual(evaluateProtection(drift, policy), [
    "Required status check contexts do not exactly match policy.",
  ]);
});

function protectedResponse() {
  return {
    required_status_checks: { strict: true, contexts: ["Foundation Gate"] },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {
      required_approving_review_count: 0,
      bypass_pull_request_allowances: {
        users: [] as Array<{ login: string }>,
        teams: [] as Array<{ slug: string }>,
        apps: [] as Array<{ slug: string }>,
      },
    },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
}
