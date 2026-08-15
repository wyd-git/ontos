import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCK_ORDER,
  MetadataControlPlaneError,
  PUBLISH_LOCK_PLAN,
  SNAPSHOT_CUTOVER_LOCK_PLAN,
  archiveRevision,
  assertLockPlan,
  assertMetadataControlPlaneInvariants,
  authorizeManagementRequest,
  createMetadataControlPlaneState,
  deprecateRevision,
  editImmutableRevision,
  patchDraftRevision,
  publishReleaseTransaction,
  publishRevision,
  replaceRoleBindingsTransaction,
  transitionPackageChange,
  transitionRelease,
  validateRevision,
  type FoundationIdentity,
  type MetadataControlPlaneErrorCode,
  type MetadataControlPlaneState,
  type ResourceRevision,
  type RoleBinding,
} from "./model.ts";

void test("Resource Revision transitions preserve immutable history and reject illegal mutation", () => {
  const draft = revision();
  const patched = patchDraftRevision(draft, 1, "digest-2");
  assert.deepEqual(patched, { ...draft, contentDigest: "digest-2", etag: 2 });
  assertModelError(() => patchDraftRevision(patched, 1, "digest-3"), "CONCURRENT_MODIFICATION");

  const validated = validateRevision(patched);
  const child = editImmutableRevision(validated, "revision-2", "digest-child");
  assert.deepEqual(validated, { ...patched, state: "VALIDATED" });
  assert.equal(child.parentRevisionId, validated.id);
  assert.equal(child.state, "DRAFT");
  assert.equal(child.etag, 1);

  const published = publishRevision(validated);
  const archived = archiveRevision(deprecateRevision(published));
  assert.equal(archived.state, "ARCHIVED");
  assertModelError(() => patchDraftRevision(published, 2, "tampered"), "INVALID_STATE");
  assertModelError(() => validateRevision(published), "INVALID_STATE");
  assert.equal(published.contentDigest, "digest-2");
});

void test("Release and Package state machines allow only forward terminal transitions", () => {
  const release = { id: "r1", projectId: "p1", manifestDigest: "m1", state: "DRAFT" as const };
  const ready = transitionRelease(transitionRelease(release, "STAGING"), "READY");
  const superseded = transitionRelease(transitionRelease(ready, "PUBLISHED"), "SUPERSEDED");
  assert.equal(superseded.state, "SUPERSEDED");
  assertModelError(() => transitionRelease(ready, "DRAFT"), "INVALID_STATE");
  const failed = transitionRelease(release, "FAILED");
  assertModelError(() => transitionRelease(failed, "STAGING"), "INVALID_STATE");

  const pending = {
    id: "c1",
    installationId: "i1",
    targetPackageRevisionId: "pkg-r1",
    targetReleaseId: "r1",
    state: "PENDING" as const,
  };
  const active = transitionPackageChange(pending, "ACTIVE");
  assert.equal(transitionPackageChange(active, "SUPERSEDED").state, "SUPERSEDED");
  assertModelError(() => transitionPackageChange(pending, "SUPERSEDED"), "INVALID_STATE");
  assertModelError(
    () => transitionPackageChange(transitionPackageChange(pending, "FAILED"), "ACTIVE"),
    "INVALID_STATE",
  );
});

void test("lock plans share one monotonic order and reject inversion", () => {
  assert.deepEqual(LOCK_ORDER, [
    "PROJECT_CONTROL",
    "RELEASE_CHANNEL",
    "RELEASE",
    "RELEASE_PINS",
    "SNAPSHOT_GROUP",
    "OBJECT_TYPE_CUTOVER",
    "GENERATION_INVENTORY",
    "SERVING_HEADS",
  ]);
  assert.doesNotThrow(() => assertLockPlan(PUBLISH_LOCK_PLAN));
  assert.doesNotThrow(() => assertLockPlan(SNAPSHOT_CUTOVER_LOCK_PLAN));
  assertModelError(() => assertLockPlan(["SERVING_HEADS", "PROJECT_CONTROL"]), "INVALID_INPUT");
});

void test("Package stays Pending until Release publish atomically switches every active pointer", () => {
  const before = packagePublishFixture();
  const next = publishReleaseTransaction(before, publishInput());

  assert.equal(next.releases.r2?.state, "PUBLISHED");
  assert.equal(next.releases.r1?.state, "SUPERSEDED");
  assert.deepEqual(next.channels["p1:production"], {
    projectId: "p1",
    channel: "production",
    releaseId: "r2",
    activationId: "a2",
  });
  assert.equal(next.servingHeads.r2?.activationId, "a2");
  assert.deepEqual(next.packageInstallations.i1, {
    id: "i1",
    projectId: "p1",
    activePackageRevisionId: "pkg-r2",
    activeReleaseId: "r2",
  });
  assert.equal(next.packageChanges.c1?.state, "SUPERSEDED");
  assert.equal(next.packageChanges.c2?.state, "ACTIVE");
  assert.equal(next.authorizationEpochs.p1, 8);
  assert.equal(next.controlRevision, 12);
  assertMetadataControlPlaneInvariants(next);

  assert.equal(before.releases.r2?.state, "READY");
  assert.equal(before.packageChanges.c2?.state, "PENDING");
  assert.equal(before.packageInstallations.i1?.activeReleaseId, "r1");

  const repeated = publishReleaseTransaction(next, {
    ...publishInput(),
    expectedControlRevision: 11,
  });
  assert.deepEqual(repeated, next);
});

void test("every injected Publish failure leaves Release, Channel, Package and Epoch unchanged", () => {
  for (const failurePoint of [
    "after_release",
    "after_serving_head",
    "after_channel",
    "after_installations",
    "after_epoch",
  ] as const) {
    const before = packagePublishFixture();
    assertModelError(
      () => publishReleaseTransaction(before, { ...publishInput(), failurePoint }),
      "TRANSACTION_ABORTED",
    );
    assert.deepEqual(before, packagePublishFixture());
  }
});

void test("Publish rejects stale control revision and a torn Release/Activation pair", () => {
  const state = packagePublishFixture();
  assertModelError(
    () => publishReleaseTransaction(state, { ...publishInput(), expectedControlRevision: 10 }),
    "CONCURRENT_MODIFICATION",
  );
  const activation = state.activations.a2;
  assert.ok(activation);
  activation.manifestDigest = "wrong";
  assertModelError(() => publishReleaseTransaction(state, publishInput()), "INVALID_INPUT");
});

void test("metadata-only Release publishes a zero-member Activation without fake Generation", () => {
  const state = createMetadataControlPlaneState();
  state.releases.r1 = {
    id: "r1",
    projectId: "p1",
    manifestDigest: "metadata-m1",
    state: "READY",
  };
  state.activations.a0 = {
    id: "a0",
    releaseId: "r1",
    manifestDigest: "metadata-m1",
    memberIds: [],
  };
  state.authorizationEpochs.p1 = 1;

  const published = publishReleaseTransaction(state, {
    projectId: "p1",
    releaseId: "r1",
    activationId: "a0",
    channel: "production",
    expectedControlRevision: 0,
  });
  assert.deepEqual(published.activations.a0?.memberIds, []);
  assert.equal(published.channels["p1:production"]?.activationId, "a0");
});

void test("DB-01 rejects a non-empty Activation until DB-02 owns Runtime Members", () => {
  const state = createMetadataControlPlaneState();
  state.releases.r1 = {
    id: "r1",
    projectId: "p1",
    manifestDigest: "metadata-m1",
    state: "READY",
  };
  state.activations.a1 = {
    id: "a1",
    releaseId: "r1",
    manifestDigest: "metadata-m1",
    memberIds: ["generation-not-owned-by-db-01"],
  };
  state.authorizationEpochs.p1 = 1;

  assertModelError(
    () =>
      publishReleaseTransaction(state, {
        projectId: "p1",
        releaseId: "r1",
        activationId: "a1",
        channel: "production",
        expectedControlRevision: 0,
      }),
    "INVALID_STATE",
  );
  assert.equal(state.releases.r1?.state, "READY");
  assert.deepEqual(state.channels, {});
});

void test("ManagementAuthorizer consumes verified identity only and Resource scope cannot elevate", () => {
  const identity: FoundationIdentity = {
    principalId: "principal-1",
    authenticationTime: 10,
    claimsFingerprint: "sha256:trusted",
  };
  const bindings: RoleBinding[] = [
    binding("project-editor", "EDITOR", null),
    binding("resource-viewer", "VIEWER", "resource-1"),
  ];
  assert.equal(
    authorizeManagementRequest(
      identity,
      { principalId: "principal-1", projectId: "p1", permission: "metadata.edit" },
      bindings,
    ),
    true,
  );
  assert.equal(
    authorizeManagementRequest(
      identity,
      {
        principalId: "principal-1",
        projectId: "p1",
        resourceId: "resource-1",
        permission: "metadata.edit",
      },
      bindings,
    ),
    false,
  );
  assert.equal(
    authorizeManagementRequest(
      identity,
      {
        principalId: "principal-1",
        projectId: "p1",
        resourceId: "resource-1",
        permission: "metadata.read",
      },
      bindings,
    ),
    true,
  );
  assert.equal(
    authorizeManagementRequest(
      identity,
      { principalId: "principal-1", projectId: "p1", permission: "release.publish" },
      [binding("executor", "EXECUTOR", null), binding("auditor", "AUDITOR", null)],
    ),
    false,
  );

  const rawClaims = {
    principalId: "principal-1",
    authenticationTime: 10,
    claimsFingerprint: "sha256:trusted",
    rawClaims: ["untrusted-group"],
  };
  assertModelError(
    () =>
      authorizeManagementRequest(
        rawClaims,
        { principalId: "principal-1", projectId: "p1", permission: "metadata.read" },
        bindings,
      ),
    "INVALID_INPUT",
  );
});

void test("Role Binding replacement and Epoch commit atomically; rows are never reactivated", () => {
  const state = createMetadataControlPlaneState();
  state.authorizationEpochs.p1 = 4;
  state.roleBindings.old = binding("old", "VIEWER", null);
  const desiredBinding = {
    id: "new",
    projectId: "p1",
    principalId: "principal-1",
    resourceId: null,
    role: "EDITOR" as const,
  };
  const desired = [desiredBinding];
  const committed = replaceRoleBindingsTransaction(state, {
    projectId: "p1",
    expectedEpoch: 4,
    desired,
  });
  assert.equal(committed.roleBindings.old?.state, "REVOKED");
  assert.equal(committed.roleBindings.new?.state, "ACTIVE");
  assert.equal(committed.authorizationEpochs.p1, 5);
  assert.equal(state.roleBindings.old?.state, "ACTIVE");

  const unchanged = replaceRoleBindingsTransaction(committed, {
    projectId: "p1",
    expectedEpoch: 5,
    desired: [{ ...desiredBinding, id: "a-different-request-id" }],
  });
  assert.deepEqual(unchanged, committed);

  assertModelError(
    () =>
      replaceRoleBindingsTransaction(state, {
        projectId: "p1",
        expectedEpoch: 4,
        desired,
        failurePoint: "after_bindings",
      }),
    "TRANSACTION_ABORTED",
  );
  assert.deepEqual(state.roleBindings, { old: binding("old", "VIEWER", null) });
  assertModelError(
    () =>
      replaceRoleBindingsTransaction(committed, {
        projectId: "p1",
        expectedEpoch: 5,
        desired: [{ ...desiredBinding, id: "old", role: "OWNER" }],
      }),
    "ALREADY_EXISTS",
  );
  assertModelError(
    () =>
      replaceRoleBindingsTransaction(state, {
        projectId: "p1",
        expectedEpoch: 4,
        desired: [desiredBinding, { ...desiredBinding, id: "duplicate" }],
      }),
    "INVALID_INPUT",
  );
});

function revision(): ResourceRevision {
  return {
    id: "revision-1",
    resourceId: "resource-1",
    parentRevisionId: null,
    contentDigest: "digest-1",
    etag: 1,
    state: "DRAFT",
  };
}

function binding(id: string, role: RoleBinding["role"], resourceId: string | null): RoleBinding {
  return {
    id,
    projectId: "p1",
    principalId: "principal-1",
    resourceId,
    role,
    state: "ACTIVE",
  };
}

function packagePublishFixture(): MetadataControlPlaneState {
  const state = createMetadataControlPlaneState();
  state.controlRevision = 11;
  state.releases.r1 = { id: "r1", projectId: "p1", manifestDigest: "m1", state: "PUBLISHED" };
  state.releases.r2 = { id: "r2", projectId: "p1", manifestDigest: "m2", state: "READY" };
  state.activations.a1 = { id: "a1", releaseId: "r1", manifestDigest: "m1", memberIds: [] };
  state.activations.a2 = { id: "a2", releaseId: "r2", manifestDigest: "m2", memberIds: [] };
  state.channels["p1:production"] = {
    projectId: "p1",
    channel: "production",
    releaseId: "r1",
    activationId: "a1",
  };
  state.servingHeads.r1 = { releaseId: "r1", activationId: "a1" };
  state.packageInstallations.i1 = {
    id: "i1",
    projectId: "p1",
    activePackageRevisionId: "pkg-r1",
    activeReleaseId: "r1",
  };
  state.packageChanges.c1 = {
    id: "c1",
    installationId: "i1",
    targetPackageRevisionId: "pkg-r1",
    targetReleaseId: "r1",
    state: "ACTIVE",
  };
  state.packageChanges.c2 = {
    id: "c2",
    installationId: "i1",
    targetPackageRevisionId: "pkg-r2",
    targetReleaseId: "r2",
    state: "PENDING",
  };
  state.authorizationEpochs.p1 = 7;
  return state;
}

function publishInput() {
  return {
    projectId: "p1",
    releaseId: "r2",
    activationId: "a2",
    channel: "production",
    expectedControlRevision: 11,
    packageChangeId: "c2",
  } as const;
}

function assertModelError(operation: () => unknown, code: MetadataControlPlaneErrorCode): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof MetadataControlPlaneError);
    assert.equal(error.code, code);
    return true;
  });
}
