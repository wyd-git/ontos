import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseCanonicalInstant,
  type ArtifactDigest,
} from "@ontos/contracts";
import {
  RuntimeIdentityApplicationService,
  RuntimeIdentityError,
  type RuntimeIdentityFactsRepository,
  type RuntimeIdentitySnapshot,
  type VerifiedRuntimeCredential,
} from "@ontos/identity-application";
import {
  canonicalClaimMapping,
  decideIntersectedPermission,
  mapTrustedClaims,
  parseClaimMappingDefinition,
} from "@ontos/identity-domain";

const ids = {
  project: "64000000-0000-4000-8000-000000000001",
  human: "64000000-0000-4000-8000-000000000002",
  service: "64000000-0000-4000-8000-000000000003",
  mapping: "64000000-0000-4000-8000-000000000004",
} as const;

const mapping = {
  schemaVersion: 1,
  attributes: [
    { claim: "region", attribute: "region", valueType: "string", required: true },
    { claim: "groups", attribute: "groups", valueType: "string_array", required: false },
    { claim: "employee", attribute: "employee", valueType: "boolean", required: false },
  ],
} as const;

void test("Claim Mapping reads only a bounded whitelist and canonicalizes set-like values", () => {
  const definition = parseClaimMappingDefinition(mapping);
  const reads: string[] = [];
  const claims: Readonly<Record<string, unknown>> = {
    region: "east",
    groups: ["operators", "readers"],
    employee: true,
    untrusted_admin: true,
  };
  const mapped = mapTrustedClaims(definition, {
    readClaim(name) {
      reads.push(name);
      return claims[name];
    },
  });
  assert.deepEqual(reads.sort(), ["employee", "groups", "region"]);
  assert.equal(reads.includes("untrusted_admin"), false);
  assert.deepEqual(mapped, [
    { name: "employee", value: true },
    { name: "groups", value: ["operators", "readers"] },
    { name: "region", value: "east" },
  ]);
  assert.equal(Object.isFrozen(mapped), true);
  assert.equal(canonicalClaimMapping(definition), canonicalizeContractForDigest(definition));
});

void test("Claim Mapping rejects protocol claims, duplicate names, wrong types and oversized values", () => {
  for (const candidate of [
    {
      schemaVersion: 1,
      attributes: [{ claim: "sub", attribute: "subject", valueType: "string", required: true }],
    },
    {
      schemaVersion: 1,
      attributes: [
        { claim: "region", attribute: "region", valueType: "string", required: true },
        { claim: "region", attribute: "area", valueType: "string", required: false },
      ],
    },
  ]) {
    assert.throws(() => parseClaimMappingDefinition(candidate), { code: "CLAIM_MAPPING_INVALID" });
  }
  const definition = parseClaimMappingDefinition(mapping);
  assert.throws(
    () =>
      mapTrustedClaims(definition, {
        readClaim(name) {
          return name === "region" ? "x".repeat(257) : undefined;
        },
      }),
    { code: "CLAIM_VALUE_INVALID" },
  );
});

void test("Runtime Identity builds compact human and delegated contexts with fail-closed intersection", async () => {
  const humanSnapshot = snapshot("human");
  const replay = new Set<string>();
  const repository = repositoryFor(humanSnapshot, replay);
  const service = application(repository);
  const human = await service.establish({
    projectId: ids.project,
    credential: credential(),
  });
  assert.deepEqual(human.identity.actor, { principalId: ids.human, identityType: "human" });
  assert.deepEqual(human.identity.delegationChain, []);
  assert.deepEqual(human.attributes, [
    { name: "employee", value: true },
    { name: "groups", value: ["operators", "readers"] },
    { name: "region", value: "east" },
  ]);
  assert.equal("issuer" in human, false);
  assert.equal("subject" in human, false);
  assert.equal("claims" in human, false);

  const delegatedService = application(repositoryFor(snapshot("delegated"), replay));
  const delegatedCredential = credential({
    protocol: "delegated",
    actorCount: 1,
    authorizedParty: "service-client",
    requestedCapabilities: ["object.read"],
    replayFingerprint: digest("one-use-delegation"),
    expiresAtEpochSeconds: 1_800_000_060,
  });
  const delegated = await delegatedService.establish({
    projectId: ids.project,
    credential: delegatedCredential,
  });
  assert.deepEqual(delegated.identity.actor, {
    principalId: ids.service,
    identityType: "service",
  });
  assert.deepEqual(delegated.identity.delegationChain, [
    { principalId: ids.human, identityType: "human" },
  ]);
  assert.deepEqual(
    delegatedService.decidePermission(
      delegated,
      [
        { principalId: ids.service, permissions: ["object.read", "object.write"] },
        { principalId: ids.human, permissions: ["object.read"] },
      ],
      "object.read",
    ),
    { decision: "ALLOW" },
  );
  assert.deepEqual(
    delegatedService.decidePermission(
      delegated,
      [
        { principalId: ids.service, permissions: ["object.read", "object.write"] },
        { principalId: ids.human, permissions: ["object.read"] },
      ],
      "object.write",
    ),
    { decision: "DENY" },
  );
  assert.deepEqual(
    delegatedService.decidePermission(
      delegated,
      [{ principalId: ids.service, permissions: ["object.read"] }],
      "object.read",
    ),
    { decision: "DENY" },
  );
  await assert.rejects(
    delegatedService.establish({ projectId: ids.project, credential: delegatedCredential }),
    RuntimeIdentityError,
  );
});

void test("Every identity failure has one public shape without the rejecting Principal", async () => {
  const disabled = snapshot("human");
  const broken: RuntimeIdentitySnapshot = Object.freeze({
    ...disabled,
    terminal: Object.freeze({ ...disabled.terminal, state: "disabled" }),
  });
  const error = await captureError(
    application(repositoryFor(broken, new Set())).establish({
      projectId: ids.project,
      credential: credential(),
    }),
  );
  assert.deepEqual(
    { name: error.name, code: error.code, message: error.message },
    {
      name: "RuntimeIdentityError",
      code: "AUTHENTICATION_FAILED",
      message: "Runtime identity could not be established.",
    },
  );
  const serialized = JSON.stringify(error);
  assert.equal(serialized.includes(ids.human), false);
  assert.equal(serialized.includes("human-subject"), false);
});

void test("delegation fails closed on excess TTL, client mismatch and capability escalation", async () => {
  const snapshotValue = snapshot("delegated");
  for (const overrides of [
    { expiresAtEpochSeconds: 1_800_000_300 },
    { authorizedParty: "forged-service-client" },
    { requestedCapabilities: Object.freeze(["object.write"]) },
  ]) {
    const candidate = credential({
      protocol: "delegated",
      actorCount: 1,
      authorizedParty: "service-client",
      requestedCapabilities: ["object.read"],
      replayFingerprint: digest(`delegation-${JSON.stringify(overrides)}`),
      expiresAtEpochSeconds: 1_800_000_060,
      ...overrides,
    });
    await assert.rejects(
      application(repositoryFor(snapshotValue, new Set())).establish({
        projectId: ids.project,
        credential: candidate,
      }),
      RuntimeIdentityError,
    );
  }
});

void test("permission intersection is commutative and never reports the denying link", () => {
  const left = decideIntersectedPermission(
    [ids.service, ids.human],
    [
      { principalId: ids.service, permissions: ["object.read"] },
      { principalId: ids.human, permissions: [] },
    ],
    "object.read",
  );
  const right = decideIntersectedPermission(
    [ids.human, ids.service],
    [
      { principalId: ids.human, permissions: [] },
      { principalId: ids.service, permissions: ["object.read"] },
    ],
    "object.read",
  );
  assert.deepEqual(left, { decision: "DENY" });
  assert.deepEqual(right, left);
  assert.deepEqual(Object.keys(left), ["decision"]);
});

function application(
  repository: RuntimeIdentityFactsRepository,
): RuntimeIdentityApplicationService {
  return new RuntimeIdentityApplicationService({
    repository,
    cryptography: { digestCanonicalText: digest },
    humanClientIds: ["human-web"],
  });
}

function repositoryFor(
  current: RuntimeIdentitySnapshot,
  replay: Set<string>,
): RuntimeIdentityFactsRepository {
  return {
    resolveSnapshot: () => Promise.resolve(current),
    consumeDelegationReplay(input) {
      if (replay.has(input.replayFingerprint)) return Promise.resolve(false);
      replay.add(input.replayFingerprint);
      return Promise.resolve(true);
    },
  };
}

function snapshot(kind: "human" | "delegated"): RuntimeIdentitySnapshot {
  const definition = parseClaimMappingDefinition(mapping);
  return Object.freeze({
    terminal: Object.freeze({
      principalId: ids.human,
      identityType: "human" as const,
      state: "active" as const,
      projectBound: true,
      serviceProfile: null,
    }),
    actors: Object.freeze(
      kind === "delegated"
        ? [
            Object.freeze({
              principalId: ids.service,
              identityType: "service" as const,
              state: "active" as const,
              projectBound: true,
              serviceProfile: Object.freeze({
                clientId: "service-client",
                capabilities: Object.freeze(["object.read"]),
                state: "active" as const,
              }),
            }),
          ]
        : [],
    ),
    claimMapping: Object.freeze({
      claimMappingRevisionId: ids.mapping,
      identityType: "human" as const,
      mappingDigest: digest(canonicalClaimMapping(definition)),
      mapping,
    }),
  });
}

function credential(overrides: Partial<VerifiedRuntimeCredential> = {}): VerifiedRuntimeCredential {
  const claims: Readonly<Record<string, unknown>> = {
    region: "east",
    groups: ["readers", "operators"],
    employee: true,
    untrusted_admin: true,
  };
  const actorCount = overrides.actorCount ?? 0;
  return Object.freeze({
    protocol: "direct" as const,
    actorCount: 0,
    authorizedParty: "human-web",
    requestedCapabilities: Object.freeze([]),
    authenticatedAt: parseCanonicalInstant("2027-01-15T08:00:00.000000Z"),
    issuedAtEpochSeconds: 1_800_000_000,
    expiresAtEpochSeconds: 1_800_000_300,
    replayFingerprint: null,
    resolveSnapshot(
      repository: Parameters<VerifiedRuntimeCredential["resolveSnapshot"]>[0],
      projectId: Parameters<VerifiedRuntimeCredential["resolveSnapshot"]>[1],
    ) {
      return repository.resolveSnapshot({
        projectId,
        issuer: "https://identity.example.test",
        terminalSubject: "human-subject",
        actorSubjects: actorCount === 0 ? [] : ["runtime-service"],
      });
    },
    mapClaims(definition: Parameters<VerifiedRuntimeCredential["mapClaims"]>[0]) {
      return mapTrustedClaims(definition, {
        readClaim(name: string): unknown {
          return claims[name];
        },
      });
    },
    ...overrides,
  });
}

function digest(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}

async function captureError(promise: Promise<unknown>): Promise<RuntimeIdentityError> {
  try {
    await promise;
  } catch (error) {
    assert.equal(error instanceof RuntimeIdentityError, true);
    return error as RuntimeIdentityError;
  }
  throw new Error("Expected Runtime Identity failure.");
}
