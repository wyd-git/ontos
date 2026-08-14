import assert from "node:assert/strict";
import test from "node:test";

import {
  MetadataApplicationError,
  MetadataApplicationService,
  RoleMatrixManagementAuthorizer,
  parseVerifiedFoundationIdentity,
  type ManagementAuthorizationReader,
  type MetadataApplicationServiceOptions,
  type PrincipalRecord,
  type ProjectCreation,
  type RoleBindingReplacement,
} from "@ontos/metadata-application";

const identity = parseVerifiedFoundationIdentity({
  issuer: "https://issuer.example.test",
  subject: "user-1",
  displayName: "User One",
  claimsFingerprint: `sha256:${"1".repeat(64)}`,
  authenticatedAt: "2026-08-14T00:00:00.000000Z",
});
const principal: PrincipalRecord = {
  principalId: "00000000-0000-4000-8000-000000000001",
  issuer: identity.issuer,
  subject: identity.subject,
  displayName: identity.displayName,
  state: "active",
};

void test("verified identity is closed and rejects raw claims or client Principal IDs", () => {
  assert.deepEqual(parseVerifiedFoundationIdentity(identity), identity);
  for (const extra of [
    { claims: {} },
    { principalId: principal.principalId },
    { bearerToken: "x" },
  ]) {
    assert.throws(
      () => parseVerifiedFoundationIdentity({ ...identity, ...extra }),
      (error: unknown) =>
        error instanceof MetadataApplicationError && error.code === "INVALID_INPUT",
    );
  }
});

void test("Project creation derives the owner Principal and exposes no client ID override", async () => {
  let createInput: unknown;
  const creation = projectCreation();
  const service = serviceWith({
    projects: {
      createProjectWithOwner(input) {
        createInput = input;
        return Promise.resolve(creation);
      },
      getProjectWithEpoch() {
        return Promise.reject(new Error("unused"));
      },
      archiveProject() {
        return Promise.reject(new Error("unused"));
      },
    },
  });
  assert.deepEqual(
    await service.createProject(identity, { apiName: "Commerce", displayName: "Commerce" }),
    creation,
  );
  assert.deepEqual(createInput, {
    principalId: principal.principalId,
    apiName: "Commerce",
    displayName: "Commerce",
  });
  await assert.rejects(
    service.createProject(identity, {
      projectId: "client-value",
      apiName: "Commerce2",
      displayName: "Commerce",
    }),
    (error: unknown) => error instanceof MetadataApplicationError && error.code === "INVALID_INPUT",
  );
});

void test("a disabled Principal cannot create a new Project", async () => {
  const service = serviceWith({
    principals: {
      resolveVerifiedIdentity() {
        return Promise.resolve({ ...principal, state: "disabled" });
      },
    },
  });
  await assert.rejects(
    service.createProject(identity, { apiName: "Disabled", displayName: "Disabled" }),
    (error: unknown) => error instanceof MetadataApplicationError && error.code === "FORBIDDEN",
  );
});

void test("a Principal Directory cannot substitute another external identity", async () => {
  const service = serviceWith({
    principals: {
      resolveVerifiedIdentity() {
        return Promise.resolve({ ...principal, subject: "another-user" });
      },
    },
  });
  await assert.rejects(
    service.createProject(identity, { apiName: "Mismatch", displayName: "Mismatch" }),
    (error: unknown) =>
      error instanceof MetadataApplicationError && error.code === "STORAGE_FAILURE",
  );
});

void test("role changes require the unified authorizer and never duplicate its role matrix", async () => {
  let replacements = 0;
  const denied = serviceWith({
    authorizer: {
      authorize() {
        return Promise.resolve(false);
      },
    },
    roleBindings: {
      listRoleBindings() {
        return Promise.reject(new Error("unused"));
      },
      replaceRoleBinding(): Promise<RoleBindingReplacement> {
        replacements += 1;
        return Promise.resolve({ changed: true, authorizationEpoch: 2n, activeBinding: null });
      },
    },
  });
  await assert.rejects(
    denied.replaceRoleBinding(identity, {
      projectId: "project-1",
      targetPrincipalId: "principal-2",
      role: "viewer",
      expectedEpoch: 1n,
    }),
    (error: unknown) => error instanceof MetadataApplicationError && error.code === "FORBIDDEN",
  );
  assert.equal(replacements, 0);
});

void test("the role-matrix authorizer fails closed when its reader is unavailable", async () => {
  const reader: ManagementAuthorizationReader = {
    readAuthorizationRoles() {
      return Promise.reject(new Error("database unavailable"));
    },
  };
  const authorizer = new RoleMatrixManagementAuthorizer(reader);
  assert.equal(
    await authorizer.authorize(
      {
        principalId: principal.principalId,
        claimsFingerprint: identity.claimsFingerprint,
        authenticatedAt: identity.authenticatedAt,
      },
      { projectId: "project-1", permission: "metadata.read" },
    ),
    false,
  );
});

function serviceWith(
  overrides: Partial<MetadataApplicationServiceOptions>,
): MetadataApplicationService {
  const defaults: MetadataApplicationServiceOptions = {
    principals: {
      resolveVerifiedIdentity() {
        return Promise.resolve(principal);
      },
    },
    projects: {
      createProjectWithOwner() {
        return Promise.resolve(projectCreation());
      },
      getProjectWithEpoch() {
        return Promise.resolve({
          project: projectCreation().project,
          authorizationEpoch: 1n,
        });
      },
      archiveProject() {
        return Promise.reject(new Error("unused"));
      },
    },
    roleBindings: {
      listRoleBindings() {
        return Promise.resolve({ items: [], authorizationEpoch: 1n });
      },
      replaceRoleBinding() {
        return Promise.resolve({ changed: false, authorizationEpoch: 1n, activeBinding: null });
      },
    },
    authorizer: {
      authorize() {
        return Promise.resolve(true);
      },
    },
  };
  return new MetadataApplicationService({ ...defaults, ...overrides });
}

function projectCreation(): ProjectCreation {
  return {
    project: {
      projectId: "00000000-0000-4000-8000-000000000101",
      apiName: "Commerce",
      displayName: "Commerce",
      state: "active",
      createdAt: "2026-08-14T00:00:00.000Z",
    },
    ownerBinding: {
      bindingId: "00000000-0000-4000-8000-000000000201",
      projectId: "00000000-0000-4000-8000-000000000101",
      principalId: principal.principalId,
      resourceId: null,
      role: "owner",
      state: "active",
    },
    authorizationEpoch: 1n,
  };
}
