import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { parseArtifactDigest, parseCanonicalInstant } from "@ontos/contracts";
import type { MaterializationAdminService } from "@ontos/materialization-application";
import type { VerifiedFoundationIdentity } from "@ontos/metadata-application";

import { AdminCursorCodec } from "../../apps/api/src/cursor.ts";
import { createAdminRequestHandler, type AdminApiServices } from "../../apps/api/src/router.ts";

const ids = Object.freeze({
  project: "11111111-1111-4111-8111-111111111111",
  group: "22222222-2222-4222-8222-222222222222",
  snapshot: "33333333-3333-4333-8333-333333333333",
  job: "44444444-4444-4444-8444-444444444444",
  report: "55555555-5555-4555-8555-555555555555",
  generation: "66666666-6666-4666-8666-666666666666",
  plan: "77777777-7777-4777-8777-777777777777",
});
const digest = parseArtifactDigest(`sha256:${"a".repeat(64)}`);
const now = parseCanonicalInstant("2026-08-17T00:00:00.000000Z");
const identity: VerifiedFoundationIdentity = Object.freeze({
  issuer: "https://issuer.example.test",
  subject: "admin",
  displayName: "Admin",
  claimsFingerprint: digest,
  authenticatedAt: now,
});

void test("Materialization Admin HTTP exposes the bounded G2-02-13 surface with CAS", async () => {
  const calls: { readonly name: string; readonly command: unknown }[] = [];
  const admin = materializationAdmin(calls);
  const services: AdminApiServices = {
    metadata: {} as AdminApiServices["metadata"],
    resources: {} as AdminApiServices["resources"],
    releases: {} as AdminApiServices["releases"],
    packages: {} as AdminApiServices["packages"],
    materialization: {} as AdminApiServices["materialization"],
    materializationAdmin: admin,
  };
  const server = createServer(
    createAdminRequestHandler({
      authenticator: {
        authenticateAuthorizationHeader: () => Promise.resolve(identity),
      },
      cursors: new AdminCursorCodec("x".repeat(32)),
      services,
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${String(address.port)}/api/v1/admin/projects/${ids.project}`;
  try {
    await expectStatus(`${origin}/snapshot-groups/${ids.group}/versions/1`, { method: "GET" }, 200);
    await expectStatus(`${origin}/snapshots/${ids.snapshot}`, { method: "GET" }, 200);
    const started = await expectStatus(
      `${origin}/materialization-jobs`,
      jsonRequest(
        "POST",
        { snapshotGroupId: ids.group, groupVersion: 1 },
        {
          "idempotency-key": "materialization-job-0001",
        },
      ),
      202,
    );
    assert.equal(started.headers.get("etag"), `"${now}"`);
    await expectStatus(`${origin}/materialization-jobs/${ids.job}`, { method: "GET" }, 200);
    await expectStatus(
      `${origin}/materialization-jobs/${ids.job}/cancel`,
      jsonRequest("POST", {}, { "if-match": `"${now}"` }),
      202,
    );
    await expectStatus(`${origin}/materialization-reports/${ids.report}`, { method: "GET" }, 200);
    await expectStatus(
      `${origin}/snapshot-groups/${ids.group}/versions/1/activate`,
      jsonRequest(
        "POST",
        { expectedControlRevision: "0" },
        {
          "idempotency-key": "materialization-activate-0001",
        },
      ),
      200,
    );
    await expectStatus(
      `${origin}/snapshot-groups/${ids.group}/versions/1/refresh`,
      jsonRequest("POST", {}, { "idempotency-key": "materialization-refresh-0001" }),
      202,
    );
    await expectStatus(
      `${origin}/generations/${ids.generation}/row-count-confirmation`,
      jsonRequest("POST", {
        expectedReportDigest: digest,
        expectedPublicationControlSequence: "0",
        decision: "accepted",
      }),
      200,
    );
    const capacity = await expectStatus(
      `${origin}/generations/${ids.generation}/capacity`,
      { method: "GET" },
      200,
    );
    assert.equal(capacity.headers.get("etag"), '"7"');
    await expectStatus(
      `${origin}/capacity-approvals`,
      jsonRequest(
        "POST",
        {
          scope: "project_peak",
          scopeId: null,
          approvedLimitBytes: "11811160064",
          expiresAt: "2026-08-18T00:00:00.000000Z",
        },
        { "if-match": '"7"' },
      ),
      201,
    );
    const dryRun = await expectStatus(
      `${origin}/gc/dry-run`,
      jsonRequest("POST", {}, { "idempotency-key": "materialization-gc-dry-0001" }),
      200,
    );
    assert.equal(dryRun.headers.get("etag"), `"${digest}"`);
    await expectStatus(
      `${origin}/gc/plans/${ids.plan}/commit`,
      jsonRequest("POST", {}, { "if-match": `"${digest}"` }),
      202,
    );

    assert.deepEqual(
      calls.map((call) => call.name),
      [
        "getSnapshotGroup",
        "getSnapshot",
        "startJob",
        "getJob",
        "cancelJob",
        "getReport",
        "activate",
        "refresh",
        "confirmRowCount",
        "getCapacityStatus",
        "approveCapacity",
        "dryRunGarbageCollection",
        "commitGarbageCollection",
      ],
    );
    assert.deepEqual(calls[2]?.command, {
      projectId: ids.project,
      snapshotGroupId: ids.group,
      groupVersion: 1,
      idempotencyKey: "materialization-job-0001",
    });
    assert.deepEqual(calls[4]?.command, {
      projectId: ids.project,
      jobId: ids.job,
      expectedVersion: now,
    });
    assert.deepEqual(calls[12]?.command, {
      projectId: ids.project,
      planId: ids.plan,
      expectedPlanDigest: digest,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

void test("Materialization Admin HTTP rejects unknown JSON and missing concurrency headers", async () => {
  const calls: { readonly name: string; readonly command: unknown }[] = [];
  const services: AdminApiServices = {
    metadata: {} as AdminApiServices["metadata"],
    resources: {} as AdminApiServices["resources"],
    releases: {} as AdminApiServices["releases"],
    packages: {} as AdminApiServices["packages"],
    materialization: {} as AdminApiServices["materialization"],
    materializationAdmin: materializationAdmin(calls),
  };
  const server = createServer(
    createAdminRequestHandler({
      authenticator: { authenticateAuthorizationHeader: () => Promise.resolve(identity) },
      cursors: new AdminCursorCodec("y".repeat(32)),
      services,
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${String(address.port)}/api/v1/admin/projects/${ids.project}`;
  try {
    await expectStatus(
      `${origin}/materialization-jobs`,
      jsonRequest(
        "POST",
        { snapshotGroupId: ids.group, groupVersion: 1, objectKey: "forbidden" },
        { "idempotency-key": "materialization-job-0002" },
      ),
      400,
    );
    await expectStatus(
      `${origin}/materialization-jobs/${ids.job}/cancel`,
      jsonRequest("POST", {}),
      400,
    );
    await expectStatus(`${origin}/gc/plans/${ids.plan}/commit`, jsonRequest("POST", {}), 400);
    assert.equal(calls.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

function materializationAdmin(
  calls: { readonly name: string; readonly command: unknown }[],
): AdminApiServices["materializationAdmin"] {
  const record = (name: string, command: unknown): void => {
    calls.push(Object.freeze({ name, command }));
  };
  const job = Object.freeze({
    projectId: ids.project,
    jobId: ids.job,
    snapshotGroupId: ids.group,
    groupVersion: 1,
    state: "queued" as const,
    currentStage: null,
    attemptCount: 0,
    cancelRequested: false,
    resultCode: null,
    createdAt: now,
    updatedAt: now,
    version: now,
  });
  return {
    getSnapshotGroup(_identity, command) {
      record("getSnapshotGroup", command);
      return Promise.resolve({
        projectId: ids.project,
        snapshotGroupId: ids.group,
        groupVersion: 1,
        state: "registered",
        groupDigest: digest,
        memberCount: 0,
        createdAt: now,
        members: [],
      });
    },
    getSnapshot(_identity, command) {
      record("getSnapshot", command);
      return Promise.resolve({
        projectId: ids.project,
        snapshotGroupId: ids.group,
        groupVersion: 1,
        memberKey: "object:Task",
        memberKind: "object",
        snapshotId: ids.snapshot,
        targetResourceId: ids.snapshot,
        targetRevisionId: ids.snapshot,
        contentDigest: digest,
        rowCount: 1,
        sourceLabel: "tasks.csv",
        state: "registered",
        byteCount: 1,
        createdAt: now,
      });
    },
    startJob(_identity, command) {
      record("startJob", command);
      return Promise.resolve(job);
    },
    getJob(_identity, command) {
      record("getJob", command);
      return Promise.resolve(job);
    },
    cancelJob(_identity, command) {
      record("cancelJob", command);
      return Promise.resolve({ ...job, state: "cancelled" });
    },
    getReport(_identity, command) {
      record("getReport", command);
      return Promise.resolve({
        projectId: ids.project,
        reportId: ids.report,
        snapshotGroupId: ids.group,
        groupVersion: 1,
        jobId: ids.job,
        outcome: "passed",
        totalRows: 1,
        acceptedRows: 1,
        rejectedRows: 0,
        validatorVersion: "quality-v1",
        reportDigest: digest,
        createdAt: now,
        reasons: [],
        samples: [],
      });
    },
    activate(_identity, command) {
      record("activate", command);
      return Promise.resolve({
        preparationId: ids.plan,
        projectId: ids.project,
        snapshotGroupId: ids.group,
        groupVersion: 1,
        controlRevision: 1n,
        stateRevision: 1n,
        inventoryRevision: 7n,
        changed: true,
        reused: false,
        insertedHeadCount: 0,
        updatedHeadCount: 0,
        repointedHeadCount: 0,
        releases: [],
      });
    },
    refresh(_identity, command) {
      record("refresh", command);
      return Promise.resolve({
        projectId: ids.project,
        snapshotGroupId: ids.group,
        groupVersion: 1,
        job: { jobId: ids.job, state: "queued", reused: false },
        releases: [],
      });
    },
    confirmRowCount(_identity, command) {
      record("confirmRowCount", command);
      return Promise.resolve({
        projectId: ids.project,
        generationId: ids.generation,
        outcome: "passed",
        reportId: ids.report,
        reportDigest: digest,
        generationDigest: digest,
        qualityBindingDigest: digest,
      });
    },
    getCapacityStatus(_identity, command) {
      record("getCapacityStatus", command);
      return Promise.resolve({
        projectId: ids.project,
        generationId: ids.generation,
        inventoryRevision: 7n,
        phase: null,
        measuredBytes: null,
        reservedBytes: null,
        steadyReservedBytes: null,
        peakReservedBytes: null,
        reportDigest: null,
        approval: null,
      });
    },
    approveCapacity(_identity, command) {
      record("approveCapacity", command);
      return Promise.resolve({
        approvalId: ids.plan,
        scope: "project_peak",
        scopeId: null,
        approvedLimitBytes: 11n,
        hardLimitBytes: 12n,
        evidenceDigest: digest,
        state: "active",
        expiresAt: now,
        reused: false,
      });
    },
    dryRunGarbageCollection(_identity, command) {
      record("dryRunGarbageCollection", command);
      return Promise.resolve({
        planDigest: digest,
      } as Awaited<ReturnType<MaterializationAdminService["dryRunGarbageCollection"]>>);
    },
    commitGarbageCollection(_identity, command) {
      record("commitGarbageCollection", command);
      return Promise.resolve({
        projectId: ids.project,
        planId: ids.plan,
        state: "COMMITTED",
        phase: "DONE",
        affectedRows: 0,
        remainingCandidates: 0,
        indexRequestIds: [],
      });
    },
  };
}

function jsonRequest(
  method: string,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  };
}

async function expectStatus(url: string, init: RequestInit, status: number): Promise<Response> {
  const response = await fetch(url, init);
  assert.equal(response.status, status, await response.text());
  return response;
}
