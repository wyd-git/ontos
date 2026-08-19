import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseClaimMappingDefinition } from "@ontos/identity-domain";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  RuntimeAuthenticationError,
  RuntimeOidcAuthenticator,
} from "../../apps/api/src/runtime-oidc.ts";
import { startTestOidcProvider } from "../admin-api/oidc-provider.ts";

const runtimeUrl = "http://127.0.0.1/api/v1/runtime/objects";

void test("Runtime OIDC verifies the dedicated trust envelope and exposes no raw credential", async () => {
  const provider = await startTestOidcProvider({ audience: "ontos-runtime" });
  try {
    const authenticator = await RuntimeOidcAuthenticator.discover({
      issuer: provider.issuer,
      audience: provider.audience,
      requiredScope: "ontos.runtime",
      algorithms: ["RS256"],
    });
    const token = await provider.token({
      tokenType: "at+jwt",
      scope: "openid ontos.runtime",
      subject: "human-subject",
      authorizedParty: "human-web",
      claims: { region: "east", untrusted_admin: true },
    });
    const credential = await authenticator.authenticateRequest({
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: runtimeUrl,
    });
    assert.equal(credential.protocol, "direct");
    assert.equal(credential.actorCount, 0);
    assert.deepEqual(
      credential.mapClaims(
        parseClaimMappingDefinition({
          schemaVersion: 1,
          attributes: [
            { claim: "region", attribute: "region", valueType: "string", required: true },
          ],
        }),
      ),
      [{ name: "region", value: "east" }],
    );
    assert.equal("token" in credential, false);
    assert.equal("claims" in credential, false);
    assert.equal("issuer" in credential, false);
    assert.equal("terminalSubject" in credential, false);
    assert.equal(JSON.stringify(credential).includes(token), false);
  } finally {
    await provider.close();
  }
});

void test("Runtime OIDC rejects issuer, audience, scope, time, type, size and identity headers uniformly", async () => {
  const provider = await startTestOidcProvider({ audience: "ontos-runtime" });
  try {
    const authenticator = await RuntimeOidcAuthenticator.discover({
      issuer: provider.issuer,
      audience: provider.audience,
      requiredScope: "ontos.runtime",
      algorithms: ["RS256"],
    });
    const inputs = [
      await provider.token(runtimeToken({ issuer: `${provider.issuer}/wrong` })),
      await provider.token(runtimeToken({ audience: "wrong" })),
      await provider.token(runtimeToken({ scope: "openid" })),
      await provider.token(runtimeToken({ expiresInSeconds: -10 })),
      await provider.token(runtimeToken({ notBeforeOffsetSeconds: 60 })),
      await provider.token(runtimeToken({ issuedAtOffsetSeconds: 60 })),
      await provider.token(runtimeToken({ tokenType: "JWT" })),
      await new SignJWT({ scope: "openid ontos.runtime", azp: "human-web" })
        .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
        .setIssuer(provider.issuer)
        .setAudience(provider.audience)
        .setSubject("human-subject")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(new TextEncoder().encode("wrong-algorithm-test-key-with-32-bytes")),
    ];
    for (const token of inputs) {
      await assertSameAuthenticationFailure(
        authenticator.authenticateRequest({
          headers: { authorization: `Bearer ${token}` },
          method: "GET",
          url: runtimeUrl,
        }),
      );
    }
    await assertSameAuthenticationFailure(
      authenticator.authenticateRequest({
        headers: { authorization: `Bearer ${"a".repeat(16 * 1024 + 1)}` },
        method: "GET",
        url: runtimeUrl,
      }),
    );
    const valid = await provider.token(runtimeToken());
    await assertSameAuthenticationFailure(
      authenticator.authenticateRequest({
        headers: {
          authorization: `Bearer ${valid}`,
          "x-ontos-delegation": "service-for-user",
        },
        method: "GET",
        url: runtimeUrl,
      }),
    );
  } finally {
    await provider.close();
  }
});

void test("Runtime OIDC discovery rejects insecure non-loopback issuers before network access", async () => {
  await assert.rejects(
    RuntimeOidcAuthenticator.discover({
      issuer: "http://identity.example.test",
      audience: "ontos-runtime",
      requiredScope: "ontos.runtime",
    }),
    /must use HTTPS outside loopback/u,
  );
});

void test("delegation rejects excessive actor depth before any identity context exists", async () => {
  const provider = await startTestOidcProvider({ audience: "ontos-runtime" });
  try {
    const authenticator = await RuntimeOidcAuthenticator.discover({
      issuer: provider.issuer,
      audience: provider.audience,
      requiredScope: "ontos.runtime",
    });
    let act: Readonly<Record<string, unknown>> = { sub: "service-15" };
    for (let index = 14; index >= 0; index -= 1) {
      act = { sub: `service-${String(index)}`, act };
    }
    const token = await provider.token(
      runtimeToken({
        jwtId: "too-deep",
        authorizedParty: "service-client",
        claims: { act, ontos_capabilities: ["object.read"] },
      }),
    );
    await assertSameAuthenticationFailure(
      authenticator.authenticateRequest({
        headers: { authorization: `Bearer ${token}` },
        method: "GET",
        url: runtimeUrl,
      }),
    );
  } finally {
    await provider.close();
  }
});

void test("delegation requires a signed actor chain, short-lived token binding and real DPoP", async () => {
  const provider = await startTestOidcProvider({ audience: "ontos-runtime" });
  try {
    const authenticator = await RuntimeOidcAuthenticator.discover({
      issuer: provider.issuer,
      audience: provider.audience,
      requiredScope: "ontos.runtime",
    });
    const dpop = await dpopKey();
    const token = await provider.token(
      runtimeToken({
        subject: "human-subject",
        authorizedParty: "service-client",
        jwtId: "delegation-token-one",
        expiresInSeconds: 60,
        claims: {
          act: { sub: "runtime-service" },
          cnf: { jkt: dpop.thumbprint },
          ontos_capabilities: ["object.read"],
          region: "east",
        },
      }),
    );
    const proof = await dpop.proof(token, "GET", runtimeUrl, "proof-one");
    const credential = await authenticator.authenticateRequest({
      headers: { authorization: `Bearer ${token}`, dpop: proof },
      method: "GET",
      url: runtimeUrl,
    });
    assert.equal(credential.protocol, "delegated");
    assert.equal(credential.actorCount, 1);
    assert.deepEqual(credential.requestedCapabilities, ["object.read"]);
    assert.match(credential.replayFingerprint ?? "", /^sha256:[0-9a-f]{64}$/u);

    await assertSameAuthenticationFailure(
      authenticator.authenticateRequest({
        headers: { authorization: `Bearer ${token}` },
        method: "GET",
        url: runtimeUrl,
      }),
    );
    const wrongUriProof = await dpop.proof(token, "GET", "http://127.0.0.1/wrong", "proof-two");
    await assertSameAuthenticationFailure(
      authenticator.authenticateRequest({
        headers: { authorization: `Bearer ${token}`, dpop: wrongUriProof },
        method: "GET",
        url: runtimeUrl,
      }),
    );
    const wrongSchemeProof = await dpop.proof(
      token,
      "GET",
      "ftp://127.0.0.1/runtime",
      "proof-three",
    );
    await assertSameAuthenticationFailure(
      authenticator.authenticateRequest({
        headers: { authorization: `Bearer ${token}`, dpop: wrongSchemeProof },
        method: "GET",
        url: "ftp://127.0.0.1/runtime",
      }),
    );
  } finally {
    await provider.close();
  }
});

function runtimeToken(
  overrides: Parameters<Awaited<ReturnType<typeof startTestOidcProvider>>["token"]>[0] = {},
): NonNullable<Parameters<Awaited<ReturnType<typeof startTestOidcProvider>>["token"]>[0]> {
  return {
    tokenType: "at+jwt",
    scope: "openid ontos.runtime",
    subject: "human-subject",
    authorizedParty: "human-web",
    ...overrides,
  };
}

async function dpopKey(): Promise<{
  readonly thumbprint: string;
  proof(token: string, method: string, url: string, proofId: string): Promise<string>;
}> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const thumbprint = await calculateJwkThumbprint(publicJwk, "sha256");
  return {
    thumbprint,
    proof(token, method, url, proofId) {
      return new SignJWT({
        htm: method,
        htu: url,
        ath: createHash("sha256").update(token, "utf8").digest("base64url"),
      })
        .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: publicJwk })
        .setIssuedAt()
        .setJti(proofId)
        .sign(privateKey);
    },
  };
}

async function assertSameAuthenticationFailure(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof RuntimeAuthenticationError &&
      error.code === "AUTHENTICATION_FAILED" &&
      error.message === "Runtime identity could not be established.",
  );
}
