import { createHash } from "node:crypto";

import { parseArtifactDigest, parseCanonicalInstant } from "@ontos/contracts";
import type { VerifiedFoundationIdentity } from "@ontos/metadata-application";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface OidcAuthenticatorConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly requiredScope: string;
  readonly discoveryTimeoutMs?: number;
}

export interface FoundationAuthenticator {
  authenticateAuthorizationHeader(
    value: string | string[] | undefined,
  ): Promise<VerifiedFoundationIdentity>;
}

export class AuthenticationError extends Error {
  constructor(message = "A valid administrator access token is required.", options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthenticationError";
  }
}

export class OidcAuthenticator implements FoundationAuthenticator {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #requiredScope: string;
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  private constructor(config: OidcAuthenticatorConfig, jwksUri: URL) {
    this.#issuer = config.issuer;
    this.#audience = config.audience;
    this.#requiredScope = config.requiredScope;
    this.#jwks = createRemoteJWKSet(jwksUri, {
      timeoutDuration: config.discoveryTimeoutMs ?? 5_000,
      cooldownDuration: 5_000,
      cacheMaxAge: 600_000,
    });
  }

  static async discover(config: OidcAuthenticatorConfig): Promise<OidcAuthenticator> {
    const timeout = config.discoveryTimeoutMs ?? 5_000;
    const discoveryUrl = new URL(
      `${config.issuer.endsWith("/") ? config.issuer : `${config.issuer}/`}.well-known/openid-configuration`,
    );
    let response: Response;
    try {
      response = await fetch(discoveryUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new Error("OIDC discovery is unavailable.", { cause: error });
    }
    if (!response.ok) throw new Error("OIDC discovery is unavailable.");
    const candidate: unknown = await response.json();
    if (!isPlainRecord(candidate)) throw new Error("OIDC discovery response is invalid.");
    if (candidate["issuer"] !== config.issuer || typeof candidate["jwks_uri"] !== "string") {
      throw new Error("OIDC discovery response does not match the configured issuer.");
    }
    const jwksUri = new URL(candidate["jwks_uri"]);
    assertSecureProviderUrl(jwksUri);
    return new OidcAuthenticator(config, jwksUri);
  }

  async authenticateAuthorizationHeader(
    value: string | string[] | undefined,
  ): Promise<VerifiedFoundationIdentity> {
    if (typeof value !== "string") throw new AuthenticationError();
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(value);
    const token = match?.[1];
    if (token === undefined || token.length > 16_384) throw new AuthenticationError();

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.#jwks, {
        issuer: this.#issuer,
        audience: this.#audience,
        algorithms: ["RS256", "ES256"],
        requiredClaims: ["sub", "iat", "exp"],
        clockTolerance: 5,
      }));
    } catch (error) {
      throw new AuthenticationError(undefined, { cause: error });
    }
    if (!hasScope(payload, this.#requiredScope)) throw new AuthenticationError();
    const subject = payload.sub;
    const issuedAt = payload.iat;
    if (typeof subject !== "string" || subject.length === 0 || subject.length > 512) {
      throw new AuthenticationError();
    }
    if (typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      throw new AuthenticationError();
    }
    if (issuedAt > Math.floor(Date.now() / 1_000) + 5) throw new AuthenticationError();
    const displayName = identityDisplayName(payload, subject);
    return Object.freeze({
      issuer: this.#issuer,
      subject,
      displayName,
      claimsFingerprint: parseArtifactDigest(
        `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`,
      ),
      authenticatedAt: parseCanonicalInstant(canonicalInstant(issuedAt)),
    });
  }
}

function hasScope(payload: JWTPayload, required: string): boolean {
  return (
    typeof payload.scope === "string" &&
    payload.scope.split(/\s+/u).filter(Boolean).includes(required)
  );
}

function identityDisplayName(payload: JWTPayload, subject: string): string {
  for (const candidate of [payload.name, payload.preferred_username, subject]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.length <= 160 ? candidate : candidate.slice(0, 160);
    }
  }
  throw new AuthenticationError();
}

function canonicalInstant(epochSeconds: number): string {
  const iso = new Date(epochSeconds * 1_000).toISOString();
  if (!iso.endsWith("Z")) throw new AuthenticationError();
  return `${iso.slice(0, -1).replace(/\.[0-9]{3}$/u, (value) => `${value}000`)}Z`;
}

function assertSecureProviderUrl(url: URL): void {
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("OIDC JWKS must use HTTPS outside loopback development.");
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
