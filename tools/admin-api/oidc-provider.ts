import { createServer, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

export interface TestTokenInput {
  readonly subject?: string;
  readonly name?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly scope?: string;
  readonly expiresInSeconds?: number;
  readonly issuedAtOffsetSeconds?: number;
}

export interface TestOidcProvider {
  readonly issuer: string;
  readonly audience: string;
  token(input?: TestTokenInput): Promise<string>;
  close(): Promise<void>;
}

export interface TestOidcProviderOptions {
  readonly audience?: string;
  readonly port?: number;
}

export async function startTestOidcProvider(
  options: TestOidcProviderOptions = {},
): Promise<TestOidcProvider> {
  const audience = options.audience ?? "ontos-admin-test";
  const kid = randomUUID();
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await publicJwk(publicKey, kid);
  let issuer = "";
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/openid-configuration") {
      json(response, {
        issuer,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
      return;
    }
    if (request.url === "/jwks") {
      json(response, { keys: [jwk] });
      return;
    }
    response.writeHead(404).end();
  });
  await listen(server, options.port ?? 0);
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("OIDC fixture did not bind.");
  issuer = `http://127.0.0.1:${String(address.port)}`;

  return Object.freeze({
    issuer,
    audience,
    async token(input: TestTokenInput = {}) {
      const now = Math.floor(Date.now() / 1_000);
      const issuedAt = now + (input.issuedAtOffsetSeconds ?? 0);
      return new SignJWT({
        scope: input.scope ?? "openid ontos.admin",
        name: input.name ?? "Test Administrator",
      })
        .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
        .setIssuer(input.issuer ?? issuer)
        .setAudience(input.audience ?? audience)
        .setSubject(input.subject ?? "administrator")
        .setIssuedAt(issuedAt)
        .setExpirationTime(now + (input.expiresInSeconds ?? 300))
        .sign(privateKey);
    },
    close: () => close(server),
  });
}

async function publicJwk(
  key: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"],
  kid: string,
): Promise<JWK> {
  return { ...(await exportJWK(key)), kid, alg: "RS256", use: "sig" };
}

function json(response: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
    server.closeIdleConnections();
  });
}
