import assert from "node:assert/strict";
import test from "node:test";

import {
  establishDelegatedIdentity,
  establishHumanIdentity,
  rejectClientIdentityAssertions,
  type DelegationReplayPort,
  type PrincipalRecord,
  type VerifiedTokenClaims,
} from "./trust-boundary.ts";

const now = 1_800_000_000;
const issuer = "https://identity.example.test";
const audience = "ontos-runtime";
const human: PrincipalRecord = Object.freeze({
  principalId: "42000000-0000-4000-8000-000000000001",
  issuer,
  subject: "human-subject",
  identityType: "human",
  enabled: true,
  permissions: Object.freeze(["object:read", "object:export"]),
  mayDelegateToPrincipalIds: Object.freeze([]),
});
const service: PrincipalRecord = Object.freeze({
  principalId: "42000000-0000-4000-8000-000000000002",
  issuer,
  subject: "service-subject",
  identityType: "service",
  enabled: true,
  permissions: Object.freeze(["object:read", "object:admin"]),
  mayDelegateToPrincipalIds: Object.freeze([human.principalId]),
});

function claims(overrides: Partial<VerifiedTokenClaims> = {}): VerifiedTokenClaims {
  return {
    verification: "signature-issuer-audience",
    issuer,
    audience,
    subject: human.subject,
    authenticatedAtEpochSeconds: now - 1,
    expiresAtEpochSeconds: now + 120,
    tokenId: "token-id-0001",
    actorSubject: null,
    confirmationThumbprint: null,
    ...overrides,
  };
}

function replayPort(): DelegationReplayPort {
  const consumed = new Set<string>();
  return {
    consume(tokenId) {
      if (consumed.has(tokenId)) return false;
      consumed.add(tokenId);
      return true;
    },
  };
}

void test("human identity comes from verified claims plus the server Principal directory", () => {
  const context = establishHumanIdentity(claims(), human, {
    issuer,
    audience,
    nowEpochSeconds: now,
  });
  assert.equal(context.source, "server-verified");
  assert.equal(context.actor.identityType, "human");
  assert.deepEqual(context.effectivePermissions, ["object:export", "object:read"]);
  assert.match(context.fingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.equal("token" in context, false);
});

void test("forged Principal, Identity Type and Delegation headers are rejected", () => {
  for (const name of [
    "X-Ontos-Principal",
    "x-ontos-identity-type",
    "x-ontos-delegation",
    "x-ontos-effective-user",
  ]) {
    assert.throws(
      () => rejectClientIdentityAssertions({ [name]: "attacker-controlled" }),
      /IDENTITY_CLIENT_ASSERTION_FORBIDDEN/u,
    );
  }
});

void test("wrong issuer, audience, expiry and disabled directory state fail closed", () => {
  assert.throws(
    () =>
      establishHumanIdentity(claims({ issuer: "https://evil.test" }), human, {
        issuer,
        audience,
        nowEpochSeconds: now,
      }),
    /IDENTITY_VERIFIED_CLAIMS_INVALID/u,
  );
  assert.throws(
    () =>
      establishHumanIdentity(claims({ audience: "other" }), human, {
        issuer,
        audience,
        nowEpochSeconds: now,
      }),
    /IDENTITY_VERIFIED_CLAIMS_INVALID/u,
  );
  assert.throws(
    () =>
      establishHumanIdentity(claims({ expiresAtEpochSeconds: now }), human, {
        issuer,
        audience,
        nowEpochSeconds: now,
      }),
    /IDENTITY_VERIFIED_CLAIMS_INVALID/u,
  );
  assert.throws(
    () =>
      establishHumanIdentity(
        claims(),
        { ...human, enabled: false },
        { issuer, audience, nowEpochSeconds: now },
      ),
    /IDENTITY_PRINCIPAL_DIRECTORY_MISMATCH/u,
  );
});

void test("delegation requires Token Exchange actor, PoP, allowlist, short TTL and replay protection", () => {
  const replay = replayPort();
  const delegated = claims({
    actorSubject: service.subject,
    confirmationThumbprint: "dpop-thumbprint-0001",
  });
  const context = establishDelegatedIdentity(delegated, service, human, replay, {
    issuer,
    audience,
    nowEpochSeconds: now,
    maximumDelegationSeconds: 300,
  });
  assert.deepEqual(context.delegationChain, [service.principalId, human.principalId]);
  assert.deepEqual(context.effectivePermissions, ["object:read"]);
  assert.equal(context.effectivePermissions.includes("object:admin"), false);
  assert.throws(
    () =>
      establishDelegatedIdentity(delegated, service, human, replay, {
        issuer,
        audience,
        nowEpochSeconds: now,
        maximumDelegationSeconds: 300,
      }),
    /IDENTITY_DELEGATION_REPLAYED/u,
  );
});

void test("service elevation, missing PoP and overlong Delegation fail closed", () => {
  assert.throws(
    () =>
      establishDelegatedIdentity(
        claims({ actorSubject: service.subject }),
        service,
        human,
        replayPort(),
        { issuer, audience, nowEpochSeconds: now, maximumDelegationSeconds: 300 },
      ),
    /IDENTITY_DELEGATION_NOT_AUTHORIZED/u,
  );
  assert.throws(
    () =>
      establishDelegatedIdentity(
        claims({
          actorSubject: service.subject,
          confirmationThumbprint: "dpop-thumbprint-0002",
          expiresAtEpochSeconds: now + 301,
        }),
        service,
        human,
        replayPort(),
        { issuer, audience, nowEpochSeconds: now, maximumDelegationSeconds: 300 },
      ),
    /IDENTITY_DELEGATION_TTL_INVALID/u,
  );
  assert.throws(
    () =>
      establishDelegatedIdentity(
        claims({ actorSubject: service.subject, confirmationThumbprint: "dpop-thumbprint-0003" }),
        { ...service, mayDelegateToPrincipalIds: [] },
        human,
        replayPort(),
        { issuer, audience, nowEpochSeconds: now, maximumDelegationSeconds: 300 },
      ),
    /IDENTITY_DELEGATION_NOT_AUTHORIZED/u,
  );
});
