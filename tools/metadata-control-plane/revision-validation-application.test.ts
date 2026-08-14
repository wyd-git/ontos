import assert from "node:assert/strict";
import test from "node:test";

import { parseValidationReport } from "@ontos/contracts";
import {
  MetadataApplicationError,
  ResourceLifecycleApplicationService,
  parseVerifiedFoundationIdentity,
  type ResourceLifecycleRepository,
} from "@ontos/metadata-application";
import { METADATA_VALIDATOR_VERSION } from "@ontos/metadata-domain";

const projectId = "00000000-0000-4000-8000-000000000001";
const resourceId = "00000000-0000-4000-8000-000000000002";
const revisionId = "00000000-0000-4000-8000-000000000003";
const principalId = "00000000-0000-4000-8000-000000000004";
const digest = `sha256:${"1".repeat(64)}` as const;
const identity = parseVerifiedFoundationIdentity({
  issuer: "https://issuer.example.test",
  subject: "validator",
  displayName: "Validator",
  claimsFingerprint: `sha256:${"2".repeat(64)}`,
  authenticatedAt: "2026-08-14T00:00:00.000000Z",
});
const report = parseValidationReport({
  schemaVersion: 1,
  reportId: "00000000-0000-4000-8000-000000000005",
  subjectId: revisionId,
  subjectDigest: digest,
  validatorVersion: METADATA_VALIDATOR_VERSION,
  valid: true,
  issues: [],
});

void test("Revision validation requires metadata.edit and fixes the server validator version", async () => {
  let repositoryCalls = 0;
  let repositoryInput: unknown;
  const repository = resourceRepository({
    validateDraftRevision(input) {
      repositoryCalls += 1;
      repositoryInput = input;
      return Promise.resolve({ revision: revision(), report });
    },
  });
  const denied = service(repository, false);
  await assert.rejects(
    denied.validateRevision(identity, { revisionId }),
    (error: unknown) => error instanceof MetadataApplicationError && error.code === "FORBIDDEN",
  );
  assert.equal(repositoryCalls, 0);

  const allowed = service(repository, true);
  assert.deepEqual(await allowed.validateRevision(identity, { revisionId }), {
    revision: revision(),
    report,
  });
  assert.deepEqual(repositoryInput, { revisionId, validatorVersion: METADATA_VALIDATOR_VERSION });
  await assert.rejects(
    allowed.validateRevision(identity, {
      revisionId,
      validatorVersion: "client-controlled",
    }),
    (error: unknown) => error instanceof MetadataApplicationError && error.code === "INVALID_INPUT",
  );
});

void test("Validation Report reads require metadata.read and do not expose graph internals", async () => {
  let permission: string | null = null;
  const repository = resourceRepository({
    getRevisionValidationReport(input) {
      assert.deepEqual(input, { revisionId, validatorVersion: METADATA_VALIDATOR_VERSION });
      return Promise.resolve(report);
    },
  });
  const application = new ResourceLifecycleApplicationService({
    principals: principalDirectory(),
    resources: repository,
    authorizer: {
      authorize(_identity, request) {
        permission = request.permission;
        return Promise.resolve(true);
      },
    },
  });
  assert.deepEqual(await application.getRevisionValidationReport(identity, { revisionId }), report);
  assert.equal(permission, "metadata.read");
  assert.deepEqual(Object.keys(report).sort(), [
    "issues",
    "reportId",
    "schemaVersion",
    "subjectDigest",
    "subjectId",
    "valid",
    "validatorVersion",
  ]);
});

function service(repository: ResourceLifecycleRepository, allowed: boolean) {
  return new ResourceLifecycleApplicationService({
    principals: principalDirectory(),
    resources: repository,
    authorizer: {
      authorize(_identity, request) {
        assert.equal(request.projectId, projectId);
        assert.equal(request.resourceId, resourceId);
        assert.equal(request.permission, "metadata.edit");
        return Promise.resolve(allowed);
      },
    },
  });
}

function principalDirectory() {
  return {
    resolveVerifiedIdentity() {
      return Promise.resolve({
        principalId,
        issuer: identity.issuer,
        subject: identity.subject,
        displayName: identity.displayName,
        state: "active" as const,
      });
    },
  };
}

function resourceRepository(
  overrides: Partial<ResourceLifecycleRepository>,
): ResourceLifecycleRepository {
  const unused = (): never => {
    throw new Error("unused");
  };
  return {
    createResourceWithInitialDraft: unused,
    readResourceScope: unused,
    readRevisionScope() {
      return Promise.resolve({ projectId, resourceId, family: "object_type" });
    },
    getResource: unused,
    listResources: unused,
    getRevision: unused,
    listRevisions: unused,
    patchDraftRevision: unused,
    createChildDraft: unused,
    validateDraftRevision: unused,
    getRevisionValidationReport: unused,
    compareRevisionCompatibility: unused,
    transitionResourceState: unused,
    transitionRevisionState: unused,
    ...overrides,
  };
}

function revision() {
  return {
    revisionId,
    resourceId,
    parentRevisionId: null,
    revisionNumber: 1n,
    family: "object_type" as const,
    state: "validated" as const,
    etag: 1n,
    contentDigest: report.subjectDigest,
    content: {
      schemaVersion: 1 as const,
      apiName: "Order",
      displayName: "Order",
      description: "Order.",
      primaryKeyPropertyApiName: "orderId",
      titlePropertyApiName: "orderId",
      defaultSearchPropertyApiNames: [],
      defaultSort: [{ propertyApiName: "orderId", direction: "asc" as const }],
      defaultClassification: "internal" as const,
      properties: [
        {
          schemaVersion: 1 as const,
          apiName: "orderId",
          displayName: "Order ID",
          description: "ID.",
          valueType: "string" as const,
          caseSensitive: true,
          nullable: false,
          writeMode: "source_only" as const,
          unique: true,
          filterable: true,
          sortable: true,
          searchable: false,
          classification: "internal" as const,
        },
      ],
    },
    createdByPrincipalId: principalId,
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}
