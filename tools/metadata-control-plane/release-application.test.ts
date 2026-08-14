import assert from "node:assert/strict";
import test from "node:test";

import {
  MetadataApplicationError,
  ReleaseLifecycleApplicationService,
  parseVerifiedFoundationIdentity,
  type ReleaseLifecycleRepository,
} from "@ontos/metadata-application";

const releaseId = "018f47a2-755b-7cc3-98c8-4d2fb871c170";
const projectId = "018f47a2-755b-7cc3-98c8-4d2fb871c100";

void test("Release use cases close the verified identity and command boundary", async () => {
  let repositoryCalls = 0;
  const application = service(
    repository({
      createReleaseDraft() {
        repositoryCalls += 1;
        throw new Error("must not be called");
      },
    }),
  );
  const identity = { ...verifiedIdentity(), rawClaims: { role: "owner" } };

  await assert.rejects(
    application.createRelease(identity, {
      projectId,
      targetChannelName: "stable",
      revisionIds: ["018f47a2-755b-7cc3-98c8-4d2fb871c110"],
    }),
    isApplicationError("INVALID_INPUT"),
  );
  await assert.rejects(
    application.createRelease(verifiedIdentity(), {
      projectId,
      targetChannelName: "stable",
      revisionIds: ["018f47a2-755b-7cc3-98c8-4d2fb871c110"],
      semanticVersion: "99.0.0",
    }),
    isApplicationError("INVALID_INPUT"),
  );
  assert.equal(repositoryCalls, 0);
});

void test("Release Publish requires the unified release.publish authorization before Store access", async () => {
  let published = false;
  const application = service(
    repository({
      publishRelease() {
        published = true;
        throw new Error("must not be called");
      },
    }),
    false,
  );

  await assert.rejects(
    application.publishRelease(verifiedIdentity(), {
      releaseId,
      expectedChannelControlSequence: 0n,
    }),
    isApplicationError("FORBIDDEN"),
  );
  assert.equal(published, false);
});

function service(releases: ReleaseLifecycleRepository, allowed = true) {
  return new ReleaseLifecycleApplicationService({
    principals: {
      resolveVerifiedIdentity(identity) {
        return Promise.resolve({
          principalId: "018f47a2-755b-7cc3-98c8-4d2fb871c180",
          issuer: identity.issuer,
          subject: identity.subject,
          displayName: identity.displayName,
          state: "active",
        });
      },
    },
    releases,
    authorizer: {
      authorize() {
        return Promise.resolve(allowed);
      },
    },
  });
}

function repository(overrides: Partial<ReleaseLifecycleRepository>): ReleaseLifecycleRepository {
  return {
    readReleaseScope() {
      return Promise.resolve({ projectId });
    },
    createReleaseDraft() {
      return Promise.reject(new Error("not implemented"));
    },
    validateReleaseDraft() {
      return Promise.reject(new Error("not implemented"));
    },
    stageRelease() {
      return Promise.reject(new Error("not implemented"));
    },
    publishRelease() {
      return Promise.reject(new Error("not implemented"));
    },
    createRollbackDraft() {
      return Promise.reject(new Error("not implemented"));
    },
    ...overrides,
  };
}

function verifiedIdentity() {
  return parseVerifiedFoundationIdentity({
    issuer: "https://issuer.release.test",
    subject: "release-user",
    displayName: "Release User",
    claimsFingerprint: `sha256:${"c".repeat(64)}`,
    authenticatedAt: "2026-08-15T00:00:00.000000Z",
  });
}

function isApplicationError(code: MetadataApplicationError["code"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof MetadataApplicationError && error.code === code;
}
