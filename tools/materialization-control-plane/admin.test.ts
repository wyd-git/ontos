import assert from "node:assert/strict";
import test from "node:test";

import { parseArtifactDigest, parseCanonicalInstant } from "@ontos/contracts";
import {
  MaterializationAdminError,
  MaterializationAdminService,
  type MaterializationAdminRepository,
  type MaterializationCapacityApprovalView,
  type MaterializationJobStatusView,
} from "@ontos/materialization-application";
import type {
  ManagementAuthorizationRequest,
  ManagementAuthorizer,
  PrincipalDirectory,
  VerifiedFoundationIdentity,
} from "@ontos/metadata-application";

const ids = Object.freeze({
  project: "11111111-1111-4111-8111-111111111111",
  group: "22222222-2222-4222-8222-222222222222",
  snapshot: "33333333-3333-4333-8333-333333333333",
  job: "44444444-4444-4444-8444-444444444444",
  correlation: "55555555-5555-4555-8555-555555555555",
  report: "66666666-6666-4666-8666-666666666666",
  generation: "77777777-7777-4777-8777-777777777777",
  plan: "88888888-8888-4888-8888-888888888888",
  approval: "99999999-9999-4999-8999-999999999999",
  principal: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  resource: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  revision: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});

const digest = parseArtifactDigest(`sha256:${"1".repeat(64)}`);
const secondDigest = parseArtifactDigest(`sha256:${"2".repeat(64)}`);
const now = parseCanonicalInstant("2026-08-17T00:00:00.000000Z");
const later = parseCanonicalInstant("2026-08-18T00:00:00.000000Z");
const identity: VerifiedFoundationIdentity = Object.freeze({
  issuer: "https://issuer.example.test",
  subject: "admin-subject",
  displayName: "Admin",
  claimsFingerprint: digest,
  authenticatedAt: now,
});

void test("Materialization Admin read and write paths use the unified authorizer", async () => {
  const fixture = createFixture(new Set(["metadata.read", "metadata.edit"]));

  const group = await fixture.service.getSnapshotGroup(identity, {
    projectId: ids.project,
    snapshotGroupId: ids.group,
    groupVersion: 1,
  });
  assert.equal(group.snapshotGroupId, ids.group);

  const job = await fixture.service.startJob(identity, {
    projectId: ids.project,
    snapshotGroupId: ids.group,
    groupVersion: 1,
    idempotencyKey: "materialization-job-0001",
    priority: 5,
  });
  assert.equal(job.jobId, ids.job);
  assert.deepEqual(
    fixture.permissions.map((request) => request.permission),
    ["metadata.read", "metadata.edit"],
  );
  assert.deepEqual(fixture.enqueued, {
    projectId: ids.project,
    snapshotGroupId: ids.group,
    groupVersion: 1,
    idempotencyKey: "materialization-job-0001",
    jobId: ids.job,
    correlationId: ids.correlation,
    priority: 5,
  });
});

void test("Viewer and implicit Executor/Auditor authority cannot reach admin writes", async () => {
  for (const allowed of [new Set(["metadata.read"]), new Set<string>()]) {
    const fixture = createFixture(allowed);
    await assert.rejects(
      fixture.service.startJob(identity, {
        projectId: ids.project,
        snapshotGroupId: ids.group,
        groupVersion: 1,
        idempotencyKey: "materialization-job-0002",
      }),
      (error: unknown) => error instanceof MaterializationAdminError && error.code === "FORBIDDEN",
    );
    assert.equal(fixture.enqueued, null);
  }
});

void test("Owner-only activation, capacity and GC bind server facts and CAS values", async () => {
  const fixture = createFixture(new Set(["release.publish"]));
  const activated = await fixture.service.activate(identity, {
    projectId: ids.project,
    snapshotGroupId: ids.group,
    groupVersion: 1,
    expectedControlRevision: "4",
    idempotencyKey: "activation-request-0001",
  });
  assert.equal(activated.projectId, ids.project);

  const approval = await fixture.service.approveCapacity(identity, {
    projectId: ids.project,
    scope: "project_peak",
    scopeId: null,
    approvedLimitBytes: String(11n * 1024n * 1024n * 1024n),
    expectedInventoryRevision: "7",
    expiresAt: later,
  });
  assert.equal(approval.hardLimitBytes, 12n * 1024n * 1024n * 1024n);
  assert.equal(fixture.approved?.principalId, ids.principal);
  assert.equal(fixture.approved?.evidenceDigest, secondDigest);

  await fixture.service.commitGarbageCollection(identity, {
    projectId: ids.project,
    planId: ids.plan,
    expectedPlanDigest: digest,
  });
  assert.deepEqual(fixture.gcBinding, {
    projectId: ids.project,
    planId: ids.plan,
    expectedPlanDigest: digest,
  });
  assert.deepEqual(fixture.gcCommit, { projectId: ids.project, planId: ids.plan });
  assert.deepEqual(
    fixture.permissions.map((request) => request.permission),
    ["release.publish", "release.publish", "release.publish"],
  );
});

void test("Admin commands reject unknown fields, stale ETags and hard-limit escalation", async () => {
  const fixture = createFixture(new Set(["metadata.edit", "release.publish"]));
  await assert.rejects(
    fixture.service.startJob(identity, {
      projectId: ids.project,
      snapshotGroupId: ids.group,
      groupVersion: 1,
      idempotencyKey: "materialization-job-0003",
      sql: "select 1",
    }),
    invalidRequest,
  );
  await assert.rejects(
    fixture.service.cancelJob(identity, {
      projectId: ids.project,
      jobId: ids.job,
      expectedVersion: "stale-version",
    }),
    (error: unknown) =>
      error instanceof MaterializationAdminError && error.code === "OBJECT_VERSION_CONFLICT",
  );
  await assert.rejects(
    fixture.service.approveCapacity(identity, {
      projectId: ids.project,
      scope: "project_peak",
      scopeId: null,
      approvedLimitBytes: String(13n * 1024n * 1024n * 1024n),
      expectedInventoryRevision: "7",
      expiresAt: later,
    }),
    invalidRequest,
  );
});

function invalidRequest(error: unknown): boolean {
  return error instanceof MaterializationAdminError && error.code === "ADMIN_REQUEST_INVALID";
}

function createFixture(allowed: ReadonlySet<string>) {
  const permissions: ManagementAuthorizationRequest[] = [];
  let enqueued: Parameters<MaterializationAdminRepository["enqueueJob"]>[0] | null = null;
  let approved: Parameters<MaterializationAdminRepository["approveCapacity"]>[0] | null = null;
  let gcBinding: Parameters<MaterializationAdminRepository["assertGcPlanBinding"]>[0] | null = null;
  let gcCommit: { readonly projectId: string; readonly planId: string } | null = null;
  const principals: PrincipalDirectory = Object.freeze({
    resolveVerifiedIdentity() {
      return Promise.resolve(
        Object.freeze({
          principalId: ids.principal,
          issuer: identity.issuer,
          subject: identity.subject,
          displayName: identity.displayName,
          state: "active" as const,
        }),
      );
    },
  });
  const authorizer: ManagementAuthorizer = Object.freeze({
    authorize(
      _resolved: Parameters<ManagementAuthorizer["authorize"]>[0],
      request: ManagementAuthorizationRequest,
    ) {
      permissions.push(request);
      return Promise.resolve(allowed.has(request.permission));
    },
  });
  const job = jobStatus();
  const repository: MaterializationAdminRepository = Object.freeze({
    getSnapshotGroup() {
      return Promise.resolve(
        Object.freeze({
          projectId: ids.project,
          snapshotGroupId: ids.group,
          groupVersion: 1,
          state: "registered" as const,
          groupDigest: digest,
          memberCount: 1,
          createdAt: now,
          members: Object.freeze([snapshotMember()]),
        }),
      );
    },
    getSnapshot() {
      return Promise.resolve(
        Object.freeze({
          ...snapshotMember(),
          projectId: ids.project,
          snapshotGroupId: ids.group,
          groupVersion: 1,
          state: "registered" as const,
          byteCount: 42,
          createdAt: now,
        }),
      );
    },
    enqueueJob(input: Parameters<MaterializationAdminRepository["enqueueJob"]>[0]) {
      enqueued = input;
      return Promise.resolve(job);
    },
    getJob() {
      return Promise.resolve(job);
    },
    cancelJob(input: Parameters<MaterializationAdminRepository["cancelJob"]>[0]) {
      if (input.expectedVersion !== job.version) {
        return Promise.reject(new MaterializationAdminError("OBJECT_VERSION_CONFLICT"));
      }
      return Promise.resolve(Object.freeze({ ...job, state: "cancelled" as const }));
    },
    getReport() {
      return Promise.resolve(
        Object.freeze({
          projectId: ids.project,
          reportId: ids.report,
          snapshotGroupId: ids.group,
          groupVersion: 1,
          jobId: ids.job,
          outcome: "passed" as const,
          totalRows: 1,
          acceptedRows: 1,
          rejectedRows: 0,
          validatorVersion: "quality-v1",
          reportDigest: digest,
          createdAt: now,
          reasons: Object.freeze([]),
          samples: Object.freeze([]),
        }),
      );
    },
    getCapacityStatus() {
      return Promise.resolve(
        Object.freeze({
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
        }),
      );
    },
    approveCapacity(input: Parameters<MaterializationAdminRepository["approveCapacity"]>[0]) {
      approved = input;
      return Promise.resolve(capacityApproval(input));
    },
    assertGcPlanBinding(
      input: Parameters<MaterializationAdminRepository["assertGcPlanBinding"]>[0],
    ) {
      gcBinding = input;
      return Promise.resolve();
    },
  });
  const generated = [ids.job, ids.correlation, ids.approval];
  const service = new MaterializationAdminService({
    principals,
    authorizer,
    repository,
    activation: {
      activate(input) {
        const command = input as { readonly projectId: string };
        return Promise.resolve(
          Object.freeze({
            projectId: command.projectId,
            snapshotGroupId: ids.group,
            groupVersion: 1,
            preparationId: ids.plan,
            controlRevision: 5n,
            stateRevision: 8n,
            inventoryRevision: 9n,
            changed: true,
            reused: false,
            insertedHeadCount: 1,
            updatedHeadCount: 0,
            repointedHeadCount: 0,
            releases: Object.freeze([]),
          }),
        );
      },
    },
    refresh: {
      prepareSnapshotGroupRefresh() {
        return Promise.resolve(
          Object.freeze({
            projectId: ids.project,
            snapshotGroupId: ids.group,
            groupVersion: 1,
            job: Object.freeze({ jobId: ids.job, state: "queued" as const, reused: false }),
            releases: Object.freeze([]),
          }),
        );
      },
    },
    confirmations: {
      confirm() {
        return Promise.resolve(
          Object.freeze({
            projectId: ids.project,
            generationId: ids.generation,
            outcome: "passed" as const,
            reportId: ids.report,
            reportDigest: digest,
            generationDigest: digest,
            qualityBindingDigest: digest,
          }),
        );
      },
    },
    garbageCollection: {
      dryRun() {
        return Promise.reject(new Error("not exercised"));
      },
      commitNext(input: { readonly projectId: string; readonly planId: string }) {
        gcCommit = input;
        return Promise.resolve(
          Object.freeze({
            projectId: input.projectId,
            planId: input.planId,
            state: "COMMITTED" as const,
            phase: "DONE" as const,
            affectedRows: 0,
            remainingCandidates: 0,
            indexRequestIds: Object.freeze([]),
          }),
        );
      },
    },
    crypto: {
      randomId() {
        const value = generated.shift();
        if (value === undefined) throw new Error("fixture id exhausted");
        return value;
      },
      digestCanonicalText() {
        return secondDigest;
      },
    },
    clock: { now: () => now },
  });
  return {
    service,
    permissions,
    get enqueued() {
      return enqueued;
    },
    get approved() {
      return approved;
    },
    get gcBinding() {
      return gcBinding;
    },
    get gcCommit() {
      return gcCommit;
    },
  };
}

function snapshotMember() {
  return Object.freeze({
    memberKey: "object:Task",
    memberKind: "object" as const,
    snapshotId: ids.snapshot,
    targetResourceId: ids.resource,
    targetRevisionId: ids.revision,
    contentDigest: digest,
    rowCount: 1,
    sourceLabel: "tasks.csv",
  });
}

function jobStatus(): MaterializationJobStatusView {
  return Object.freeze({
    projectId: ids.project,
    jobId: ids.job,
    snapshotGroupId: ids.group,
    groupVersion: 1,
    state: "queued",
    currentStage: null,
    attemptCount: 0,
    cancelRequested: false,
    resultCode: null,
    createdAt: now,
    updatedAt: now,
    version: now,
    reused: false,
  });
}

function capacityApproval(
  input: Parameters<MaterializationAdminRepository["approveCapacity"]>[0],
): MaterializationCapacityApprovalView {
  return Object.freeze({
    approvalId: input.approvalId,
    scope: input.scope,
    scopeId: input.scopeId,
    approvedLimitBytes: input.approvedLimitBytes,
    hardLimitBytes: input.hardLimitBytes,
    evidenceDigest: input.evidenceDigest,
    state: "active",
    expiresAt: input.expiresAt,
    reused: false,
  });
}
