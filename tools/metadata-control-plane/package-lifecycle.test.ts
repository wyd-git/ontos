import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalizeContractForDigest,
  canonicalizeManifestForDigest,
  parseArtifactDigest,
  parseCompatibilityReport,
  parsePackageManifest,
} from "@ontos/contracts";
import {
  MetadataApplicationError,
  PackageLifecycleApplicationService,
  parseVerifiedFoundationIdentity,
  type PackageChangeResult,
  type PackageLifecycleRepository,
  type PrincipalDirectory,
} from "@ontos/metadata-application";
import {
  PackageDomainError,
  assertPackageCandidateIntegrity,
  preparePackageCandidate,
} from "@ontos/metadata-domain";

const projectId = "00000000-0000-4000-8000-000000010001";
const resourceId = "00000000-0000-4000-8000-000000010101";
const revisionId = "00000000-0000-4000-8000-000000010201";
const installationId = "00000000-0000-4000-8000-000000010301";
const packageRevisionId = "00000000-0000-4000-8000-000000010401";

void test("Package preflight verifies canonical digests, bindings and the active family registry", () => {
  const bundle = packageBundle();
  const prepared = preparePackageCandidate(bundle);
  const integrity = assertPackageCandidateIntegrity(prepared, digestText);
  assert.equal(integrity.manifestDigest, bundle.manifest.manifestDigest);
  assert.equal(prepared.resources[0]?.family, "object_type");
  assert.deepEqual(prepared.installInputBindings, [{ apiName: "environment", value: "prod" }]);
  assert.ok(Object.isFrozen(prepared.resources));

  const badDigest = packageBundle();
  badDigest.manifest.manifestDigest = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => assertPackageCandidateIntegrity(preparePackageCandidate(badDigest), digestText),
    isPackageError("PACKAGE_DIGEST_MISMATCH"),
  );

  const missingInput = packageBundle();
  missingInput.installInputBindings = [];
  assert.throws(
    () => preparePackageCandidate(missingInput),
    isPackageError("PACKAGE_INPUT_INVALID"),
  );
});

void test("Package preflight rejects SQL, Kernel migrations, paths, fixed addresses and deferred families", () => {
  const forbidden = [
    { kernelMigrations: ["DROP SCHEMA kernel CASCADE"] },
    { rawSql: "UPDATE kernel.object_current SET properties = '{}'" },
    { filePath: "/etc/passwd" },
    { databaseUrl: "postgresql://fixed-host/database" },
    { secret: "committed-value" },
  ];
  for (const extension of forbidden) {
    const bundle = packageBundle();
    Object.assign(bundle.manifest, extension);
    assert.throws(
      () => preparePackageCandidate(bundle),
      isPackageError("PACKAGE_CAPABILITY_FORBIDDEN"),
    );
  }

  const sensitiveInput = packageBundle();
  sensitiveInput.manifest.installInputs[0] = {
    apiName: "apiToken",
    displayName: "API Token",
    description: "Secret-shaped input must stay unavailable in G2-01.",
    required: true,
  };
  sensitiveInput.installInputBindings[0] = { apiName: "apiToken", value: "opaque" };
  assert.throws(
    () => preparePackageCandidate(sensitiveInput),
    isPackageError("PACKAGE_CAPABILITY_FORBIDDEN"),
  );

  const deferred = packageBundle();
  const deferredEntry = deferred.manifest.resourceEntries[0];
  assert.ok(deferredEntry);
  deferred.manifest.resourceEntries[0] = {
    ...deferredEntry,
    family: "policy",
  };
  assert.throws(
    () => preparePackageCandidate(deferred),
    isPackageError("PACKAGE_CAPABILITY_FORBIDDEN"),
  );
});

void test("Package application boundary is strict and requires package.manage", async () => {
  const repository = new FakePackageRepository();
  const principals: PrincipalDirectory = {
    resolveVerifiedIdentity(identity) {
      return Promise.resolve({
        principalId: "00000000-0000-4000-8000-000000010501",
        issuer: identity.issuer,
        subject: identity.subject,
        displayName: identity.displayName,
        state: "active",
      });
    },
  };
  let allow = true;
  const service = new PackageLifecycleApplicationService({
    principals,
    packages: repository,
    authorizer: {
      authorize(_identity, request) {
        assert.equal(request.permission, "package.manage");
        return Promise.resolve(allow);
      },
    },
    digestCanonicalText: digestText,
  });
  const command = {
    projectId,
    targetChannelName: "stable",
    requestKey: "package-request-0001",
    ...packageBundle(),
  };
  const result = await service.installPackage(identity(), command);
  assert.equal(result.accepted, true);
  assert.equal(repository.installCalls, 1);

  allow = false;
  await assert.rejects(
    service.upgradePackage(identity(), command),
    isApplicationError("FORBIDDEN"),
  );
  assert.equal(repository.upgradeCalls, 0);

  await assert.rejects(
    service.installPackage(identity(), { ...command, unknown: true }),
    isApplicationError("INVALID_INPUT"),
  );
});

class FakePackageRepository implements PackageLifecycleRepository {
  installCalls = 0;
  upgradeCalls = 0;

  readInstallationScope() {
    return Promise.resolve({ projectId });
  }

  installPackage(input: Parameters<PackageLifecycleRepository["installPackage"]>[0]) {
    this.installCalls += 1;
    return Promise.resolve(acceptedFixture(input.candidate.manifest));
  }

  upgradePackage(input: Parameters<PackageLifecycleRepository["upgradePackage"]>[0]) {
    this.upgradeCalls += 1;
    return Promise.resolve(acceptedFixture(input.candidate.manifest));
  }

  rollbackPackage() {
    return Promise.resolve(acceptedFixture(packageBundle().manifest));
  }
}

function acceptedFixture(manifestInput: unknown): PackageChangeResult {
  const manifest = parsePackageManifest(manifestInput);
  const compatibility = parseCompatibilityReport({
    schemaVersion: 1,
    reportId: "00000000-0000-4000-8000-000000010601",
    baselineDigest: `sha256:${"0".repeat(64)}`,
    candidateDigest: manifest.manifestDigest,
    outcome: "compatible",
    findings: [],
  });
  return Object.freeze({
    accepted: true,
    compatibility,
    change: Object.freeze({
      operation: "install",
      projectId,
      packageId: "00000000-0000-4000-8000-000000010701",
      packageRevisionId,
      installationId,
      changeId: "00000000-0000-4000-8000-000000010801",
      releaseId: "00000000-0000-4000-8000-000000010901",
      targetChannelName: "stable",
      requestKey: "package-request-0001",
      requestDigest: parseArtifactDigest(`sha256:${"1".repeat(64)}`),
      inputBindings: [{ apiName: "environment", value: "prod" }],
      inputBindingsDigest: parseArtifactDigest(`sha256:${"2".repeat(64)}`),
      state: "pending",
      manifest,
      compatibility,
      idempotent: false,
    }),
  });
}

function packageBundle(marker = "baseline") {
  const content = objectType(marker);
  const contentDigest = digestText(canonicalizeContractForDigest(content));
  const manifest = {
    schemaVersion: 1,
    packageApiName: "CommerceCore",
    version: "1.0.0",
    namespace: "fixture.commerce",
    kernelContractVersion: "metadata-1",
    resourceEntries: [
      {
        namespace: "fixture.commerce",
        apiName: "Order",
        family: "object_type",
        resourceId,
        revisionId,
        contentDigest,
      },
    ],
    artifactDigests: [] as string[],
    installInputs: [
      {
        apiName: "environment",
        displayName: "Environment",
        description: "Target environment label.",
        required: true,
      },
    ],
    manifestDigest: `sha256:${"0".repeat(64)}`,
  };
  manifest.manifestDigest = digestText(canonicalizeManifestForDigest(manifest));
  return {
    manifest,
    resources: [{ resourceId, revisionId, content }],
    installInputBindings: [{ apiName: "environment", value: "prod" }],
  };
}

function objectType(marker: string) {
  return {
    schemaVersion: 1,
    apiName: "Order",
    displayName: "Order",
    description: `Package ${marker}`,
    primaryKeyPropertyApiName: "id",
    titlePropertyApiName: "id",
    defaultSearchPropertyApiNames: [],
    defaultSort: [{ propertyApiName: "id", direction: "asc" }],
    defaultClassification: "internal",
    properties: [
      {
        schemaVersion: 1,
        apiName: "id",
        displayName: "ID",
        description: "Stable identifier.",
        valueType: "string",
        caseSensitive: true,
        nullable: false,
        writeMode: "source_only",
        unique: true,
        filterable: true,
        sortable: true,
        searchable: false,
        classification: "internal",
      },
    ],
  };
}

function identity() {
  return parseVerifiedFoundationIdentity({
    issuer: "https://issuer.package.test",
    subject: "package-owner",
    displayName: "Package Owner",
    claimsFingerprint: `sha256:${"c".repeat(64)}`,
    authenticatedAt: "2026-08-15T00:00:00.000000Z",
  });
}

function digestText(value: string) {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}

function isPackageError(code: PackageDomainError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof PackageDomainError && error.code === code;
}

function isApplicationError(code: MetadataApplicationError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof MetadataApplicationError && error.code === code;
}
