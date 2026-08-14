import assert from "node:assert/strict";
import test from "node:test";

import { AuthenticationError, OidcAuthenticator } from "../../apps/api/src/oidc.ts";
import { startTestOidcProvider } from "./oidc-provider.ts";

void test("OIDC adapter verifies signature, issuer, audience, expiry and admin scope", async () => {
  const provider = await startTestOidcProvider();
  try {
    const authenticator = await OidcAuthenticator.discover({
      issuer: provider.issuer,
      audience: provider.audience,
      requiredScope: "ontos.admin",
    });
    const valid = await provider.token({ subject: "owner", name: "Owner" });
    const identity = await authenticator.authenticateAuthorizationHeader(`Bearer ${valid}`);
    assert.equal(identity.issuer, provider.issuer);
    assert.equal(identity.subject, "owner");
    assert.equal(identity.displayName, "Owner");
    assert.match(identity.claimsFingerprint, /^sha256:[0-9a-f]{64}$/u);
    assert.equal("scope" in identity, false);

    for (const token of [
      await provider.token({ issuer: `${provider.issuer}/wrong` }),
      await provider.token({ audience: "wrong" }),
      await provider.token({ expiresInSeconds: -10 }),
      await provider.token({ scope: "openid" }),
      await provider.token({ issuedAtOffsetSeconds: 60 }),
    ]) {
      await assert.rejects(
        authenticator.authenticateAuthorizationHeader(`Bearer ${token}`),
        AuthenticationError,
      );
    }
  } finally {
    await provider.close();
  }
});
