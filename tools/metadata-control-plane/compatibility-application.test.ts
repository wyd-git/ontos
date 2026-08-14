import assert from "node:assert/strict";
import test from "node:test";

import { parseCompatibilityReport } from "@ontos/contracts";
import {
  MetadataApplicationError,
  ResourceLifecycleApplicationService,
  parseVerifiedFoundationIdentity,
  type ResourceLifecycleRepository,
} from "@ontos/metadata-application";

const projectId = "00000000-0000-4000-8000-000000000001";
const resourceId = "00000000-0000-4000-8000-000000000002";
const candidateRevisionId = "00000000-0000-4000-8000-000000000003";
const baselineRevisionId = "00000000-0000-4000-8000-000000000004";
const principalId = "00000000-0000-4000-8000-000000000005";
const identity = parseVerifiedFoundationIdentity({
  issuer: "https://issuer.example.test",
  subject: "compatibility-reader",
  displayName: "Compatibility Reader",
  claimsFingerprint: `sha256:${"a".repeat(64)}`,
  authenticatedAt: "2026-08-15T00:00:00.000000Z",
});
const report = parseCompatibilityReport({
  schemaVersion: 1,
  reportId: "00000000-0000-4000-8000-000000000006",
  baselineDigest: `sha256:${"b".repeat(64)}`,
  candidateDigest: `sha256:${"c".repeat(64)}`,
  outcome: "compatible",
  findings: [],
});

void test("Revision diff authorizes the candidate Resource and delegates the fixed baseline pair", async () => {
  let compareInput: unknown;
  let scopeReads = 0;
  const repository = resourceRepository({
    readRevisionScope(revisionId) {
      scopeReads += 1;
      assert.equal(revisionId, candidateRevisionId);
      return Promise.resolve({ projectId, resourceId, family: "object_type" });
    },
    compareRevisionCompatibility(input) {
      compareInput = input;
      return Promise.resolve(report);
    },
  });
  const application = service(repository, true);
  assert.deepEqual(
    await application.compareRevisionCompatibility(identity, {
      revisionId: candidateRevisionId,
      againstRevisionId: baselineRevisionId,
    }),
    report,
  );
  assert.equal(scopeReads, 1);
  assert.deepEqual(compareInput, {
    baselineRevisionId,
    candidateRevisionId,
  });
});

void test("Revision diff fails closed before repository comparison when metadata.read is denied", async () => {
  let compared = false;
  const repository = resourceRepository({
    readRevisionScope() {
      return Promise.resolve({ projectId, resourceId, family: "object_type" });
    },
    compareRevisionCompatibility() {
      compared = true;
      return Promise.resolve(report);
    },
  });
  await assert.rejects(
    service(repository, false).compareRevisionCompatibility(identity, {
      revisionId: candidateRevisionId,
      againstRevisionId: baselineRevisionId,
    }),
    (error: unknown) => error instanceof MetadataApplicationError && error.code === "FORBIDDEN",
  );
  assert.equal(compared, false);
});

void test("Revision diff rejects client compatibility overrides and Semantic Version hints", async () => {
  let compared = false;
  const repository = resourceRepository({
    compareRevisionCompatibility() {
      compared = true;
      return Promise.resolve(report);
    },
  });
  await assert.rejects(
    service(repository, true).compareRevisionCompatibility(identity, {
      revisionId: candidateRevisionId,
      againstRevisionId: baselineRevisionId,
      semanticVersion: "99.0.0",
    }),
    (error: unknown) => error instanceof MetadataApplicationError && error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    service(repository, true).compareRevisionCompatibility(identity, {
      revisionId: candidateRevisionId,
      againstRevisionId: baselineRevisionId,
      baselineContent: {},
    }),
    (error: unknown) => error instanceof MetadataApplicationError && error.code === "INVALID_INPUT",
  );
  assert.equal(compared, false);
});

function service(repository: ResourceLifecycleRepository, allowed: boolean) {
  return new ResourceLifecycleApplicationService({
    principals: {
      resolveVerifiedIdentity() {
        return Promise.resolve({
          principalId,
          issuer: identity.issuer,
          subject: identity.subject,
          displayName: identity.displayName,
          state: "active" as const,
        });
      },
    },
    resources: repository,
    authorizer: {
      authorize(_resolved, request) {
        assert.deepEqual(request, {
          projectId,
          resourceId,
          family: "object_type",
          permission: "metadata.read",
        });
        return Promise.resolve(allowed);
      },
    },
  });
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
    readRevisionScope: unused,
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
