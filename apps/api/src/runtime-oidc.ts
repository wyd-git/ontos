import { createHash } from "node:crypto";

import {
  parseArtifactDigest,
  parseCanonicalInstant,
  type ArtifactDigest,
  type CanonicalInstant,
} from "@ontos/contracts";
import type { VerifiedRuntimeCredential } from "@ontos/identity-application";
import {
  mapTrustedClaims,
  type ClaimMappingDefinition,
  type MappedActorAttribute,
} from "@ontos/identity-domain";
import {
  calculateJwkThumbprint,
  createRemoteJWKSet,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from "jose";

export const RUNTIME_OIDC_LIMITS = Object.freeze({
  maximumBearerBytes: 16 * 1024,
  maximumDpopBytes: 8 * 1024,
  maximumVerifiedClaimsBytes: 12 * 1024,
  maximumActorChain: 15,
  maximumCapabilities: 16,
  dpopClockToleranceSeconds: 5,
});

export interface RuntimeOidcAuthenticatorConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly requiredScope: string;
  readonly algorithms?: readonly ("ES256" | "RS256")[];
  readonly discoveryTimeoutMs?: number;
}

export interface RuntimeAuthenticationRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly method: string;
  readonly url: string;
}

export class RuntimeAuthenticationError extends Error {
  readonly code = "AUTHENTICATION_FAILED" as const;

  constructor() {
    super("Runtime identity could not be established.");
    this.name = "RuntimeAuthenticationError";
  }
}

const forbiddenIdentityHeaders = new Set([
  "x-ontos-delegation",
  "x-ontos-effective-user",
  "x-ontos-identity-type",
  "x-ontos-principal-id",
]);
const capabilityPattern = /^[a-z][a-z0-9_.:-]{0,127}$/u;

export class RuntimeOidcAuthenticator {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #requiredScope: string;
  readonly #algorithms: readonly ("ES256" | "RS256")[];
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  private constructor(config: RuntimeOidcAuthenticatorConfig, jwksUri: URL) {
    this.#issuer = config.issuer;
    this.#audience = config.audience;
    this.#requiredScope = config.requiredScope;
    this.#algorithms = Object.freeze([...(config.algorithms ?? ["RS256"])]);
    if (
      this.#algorithms.length === 0 ||
      new Set(this.#algorithms).size !== this.#algorithms.length
    ) {
      throw new Error("Runtime OIDC algorithm allowlist is invalid.");
    }
    this.#jwks = createRemoteJWKSet(jwksUri, {
      timeoutDuration: config.discoveryTimeoutMs ?? 5_000,
      cooldownDuration: 5_000,
      cacheMaxAge: 600_000,
    });
  }

  static async discover(config: RuntimeOidcAuthenticatorConfig): Promise<RuntimeOidcAuthenticator> {
    const timeout = config.discoveryTimeoutMs ?? 5_000;
    const issuerUrl = new URL(config.issuer);
    assertSecureProviderUrl(issuerUrl);
    if (issuerUrl.search !== "" || issuerUrl.hash !== "") {
      throw new Error("Runtime OIDC issuer URL is invalid.");
    }
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
      throw new Error("Runtime OIDC discovery is unavailable.", { cause: error });
    }
    if (!response.ok) throw new Error("Runtime OIDC discovery is unavailable.");
    const candidate: unknown = await response.json();
    if (!isPlainRecord(candidate)) throw new Error("Runtime OIDC discovery response is invalid.");
    if (candidate["issuer"] !== config.issuer || typeof candidate["jwks_uri"] !== "string") {
      throw new Error("Runtime OIDC discovery response does not match the configured issuer.");
    }
    const jwksUri = new URL(candidate["jwks_uri"]);
    assertSecureProviderUrl(jwksUri);
    return new RuntimeOidcAuthenticator(config, jwksUri);
  }

  async authenticateRequest(
    request: RuntimeAuthenticationRequest,
  ): Promise<VerifiedRuntimeCredential> {
    try {
      return await this.#authenticateRequest(request);
    } catch {
      throw new RuntimeAuthenticationError();
    }
  }

  async #authenticateRequest(
    request: RuntimeAuthenticationRequest,
  ): Promise<VerifiedRuntimeCredential> {
    assertNoIdentityOverrideHeaders(request.headers);
    const authorization = singleHeader(request.headers, "authorization");
    const match =
      authorization === undefined ? null : /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(authorization);
    const token = match?.[1];
    if (token === undefined || Buffer.byteLength(token) > RUNTIME_OIDC_LIMITS.maximumBearerBytes) {
      throw new Error("Bearer envelope is invalid.");
    }

    const verified = await jwtVerify(token, this.#jwks, {
      issuer: this.#issuer,
      audience: this.#audience,
      algorithms: [...this.#algorithms],
      requiredClaims: ["sub", "iat", "exp"],
      clockTolerance: 5,
    });
    if (verified.protectedHeader.typ !== "at+jwt")
      throw new Error("Runtime token type is invalid.");
    const payload = verified.payload;
    if (
      Buffer.byteLength(JSON.stringify(payload), "utf8") >
      RUNTIME_OIDC_LIMITS.maximumVerifiedClaimsBytes
    ) {
      throw new Error("Runtime token claims exceed the supported envelope.");
    }
    if (!hasScope(payload, this.#requiredScope)) throw new Error("Runtime scope is missing.");
    const terminalSubject = boundedProtocolString(payload.sub, 512);
    const issuedAt = safeEpoch(payload.iat);
    const expiresAt = safeEpoch(payload.exp);
    const now = Math.floor(Date.now() / 1_000);
    if (issuedAt > now + 5 || expiresAt <= issuedAt)
      throw new Error("Runtime token time is invalid.");
    const authorizedParty = authorizedPartyClaim(payload);
    const actorSubjects = parseActorChain(payload["act"], terminalSubject);
    const capabilities = parseCapabilities(payload["ontos_capabilities"]);
    const delegated = actorSubjects.length > 0;
    let replayFingerprint: ArtifactDigest | null = null;

    const dpopHeader = singleHeader(request.headers, "dpop");
    if (delegated) {
      const tokenId = boundedProtocolString(payload.jti, 128);
      const confirmationThumbprint = confirmationClaim(payload["cnf"]);
      const proof = await verifyDpopProof({
        proof: dpopHeader,
        accessToken: token,
        method: request.method,
        url: request.url,
        confirmationThumbprint,
      });
      replayFingerprint = digestProtocolTuple([
        "delegation-replay-v1",
        this.#issuer,
        tokenId,
        proof.proofId,
        proof.keyThumbprint,
      ]);
    } else if (dpopHeader !== undefined || payload["cnf"] !== undefined) {
      throw new Error("Direct Runtime credentials do not accept delegation proof fields.");
    }

    const verifiedIssuer = this.#issuer;
    const mapClaims = (definition: ClaimMappingDefinition): readonly MappedActorAttribute[] =>
      mapTrustedClaims(definition, {
        readClaim(name: string): unknown {
          return copyMappedClaim(payload[name]);
        },
      });
    const credential: VerifiedRuntimeCredential = {
      protocol: delegated ? "delegated" : "direct",
      actorCount: actorSubjects.length,
      authorizedParty,
      requestedCapabilities: capabilities,
      authenticatedAt: canonicalInstant(issuedAt),
      issuedAtEpochSeconds: issuedAt,
      expiresAtEpochSeconds: expiresAt,
      replayFingerprint,
      resolveSnapshot(repository, projectId) {
        return repository.resolveSnapshot({
          projectId,
          issuer: verifiedIssuer,
          terminalSubject,
          actorSubjects,
        });
      },
      mapClaims,
    };
    return Object.freeze(credential);
  }
}

interface VerifiedDpopProof {
  readonly proofId: string;
  readonly keyThumbprint: string;
}

async function verifyDpopProof(input: {
  readonly proof: string | undefined;
  readonly accessToken: string;
  readonly method: string;
  readonly url: string;
  readonly confirmationThumbprint: string;
}): Promise<VerifiedDpopProof> {
  if (
    input.proof === undefined ||
    Buffer.byteLength(input.proof, "utf8") > RUNTIME_OIDC_LIMITS.maximumDpopBytes
  ) {
    throw new Error("DPoP proof is missing or oversized.");
  }
  const protectedHeader = decodeProtectedHeader(input.proof);
  const candidateJwk = protectedHeader.jwk;
  if (
    protectedHeader.alg !== "ES256" ||
    protectedHeader.typ !== "dpop+jwt" ||
    !isPublicP256Jwk(candidateJwk)
  ) {
    throw new Error("DPoP protected header is invalid.");
  }
  const key = await importJWK(candidateJwk, "ES256");
  const { payload } = await jwtVerify(input.proof, key, {
    algorithms: ["ES256"],
    typ: "dpop+jwt",
    requiredClaims: ["iat", "jti"],
    clockTolerance: RUNTIME_OIDC_LIMITS.dpopClockToleranceSeconds,
  });
  const proofId = boundedProtocolString(payload.jti, 128);
  const issuedAt = safeEpoch(payload.iat);
  const now = Math.floor(Date.now() / 1_000);
  if (Math.abs(now - issuedAt) > RUNTIME_OIDC_LIMITS.dpopClockToleranceSeconds) {
    throw new Error("DPoP proof time is invalid.");
  }
  if (payload["htm"] !== input.method.toUpperCase()) throw new Error("DPoP method mismatch.");
  if (payload["htu"] !== normalizedRequestUri(input.url)) throw new Error("DPoP URI mismatch.");
  const accessTokenHash = createHash("sha256")
    .update(input.accessToken, "utf8")
    .digest("base64url");
  if (payload["ath"] !== accessTokenHash) throw new Error("DPoP access-token binding mismatch.");
  const keyThumbprint = await calculateJwkThumbprint(candidateJwk, "sha256");
  if (keyThumbprint !== input.confirmationThumbprint) throw new Error("DPoP key mismatch.");
  return Object.freeze({ proofId, keyThumbprint });
}

function parseActorChain(value: unknown, terminalSubject: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const subjects: string[] = [];
  let current: unknown = value;
  while (current !== undefined) {
    if (subjects.length >= RUNTIME_OIDC_LIMITS.maximumActorChain) {
      throw new Error("Delegation actor chain is too long.");
    }
    const actor = requireExactRecord(current, ["sub", "act"]);
    const subject = boundedProtocolString(actor["sub"], 512);
    subjects.push(subject);
    current = actor["act"];
  }
  if (new Set([terminalSubject, ...subjects]).size !== subjects.length + 1) {
    throw new Error("Delegation actor chain contains a cycle.");
  }
  return Object.freeze(subjects);
}

function parseCapabilities(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > RUNTIME_OIDC_LIMITS.maximumCapabilities ||
    !value.every((item) => typeof item === "string" && capabilityPattern.test(item))
  ) {
    throw new Error("Runtime Service Capability claim is invalid.");
  }
  const capabilities = value as string[];
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error("Runtime Service Capability claim contains duplicates.");
  }
  return Object.freeze([...capabilities].sort((left, right) => left.localeCompare(right, "en")));
}

function confirmationClaim(value: unknown): string {
  const record = requireExactRecord(value, ["jkt"]);
  const thumbprint = record["jkt"];
  if (typeof thumbprint !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(thumbprint)) {
    throw new Error("Delegation confirmation claim is invalid.");
  }
  return thumbprint;
}

function authorizedPartyClaim(payload: JWTPayload): string {
  const azp = payload["azp"];
  const clientId = payload["client_id"];
  if (azp !== undefined && clientId !== undefined && azp !== clientId) {
    throw new Error("Runtime authorized-party claims disagree.");
  }
  return boundedProtocolString(azp ?? clientId, 255);
}

function assertNoIdentityOverrideHeaders(headers: RuntimeAuthenticationRequest["headers"]): void {
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (forbiddenIdentityHeaders.has(normalized) || normalized.startsWith("x-ontos-delegated-")) {
      throw new Error("Client identity override header is forbidden.");
    }
  }
}

function singleHeader(
  headers: RuntimeAuthenticationRequest["headers"],
  requestedName: string,
): string | undefined {
  const matches = Object.entries(headers).filter(
    ([name, value]) => name.toLowerCase() === requestedName && value !== undefined,
  );
  if (matches.length === 0) return undefined;
  if (matches.length !== 1 || typeof matches[0]?.[1] !== "string") {
    throw new Error("Security-sensitive header must have one value.");
  }
  return matches[0][1];
}

function hasScope(payload: JWTPayload, required: string): boolean {
  return (
    typeof payload.scope === "string" &&
    payload.scope.split(/\s+/u).filter(Boolean).includes(required)
  );
}

function safeEpoch(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("JWT NumericDate is invalid.");
  }
  return value;
}

function boundedProtocolString(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new Error("JWT protocol string is invalid.");
  }
  return value;
}

function canonicalInstant(epochSeconds: number): CanonicalInstant {
  const iso = new Date(epochSeconds * 1_000).toISOString();
  return parseCanonicalInstant(`${iso.slice(0, -1).replace(/\.[0-9]{3}$/u, "$&000")}Z`);
}

function normalizedRequestUri(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Runtime request URI must use HTTPS outside loopback.");
  }
  if (url.username !== "" || url.password !== "")
    throw new Error("Runtime request URI is invalid.");
  url.hash = "";
  url.search = "";
  return `${url.origin}${url.pathname}`;
}

function digestProtocolTuple(values: readonly string[]): ArtifactDigest {
  return parseArtifactDigest(
    `sha256:${createHash("sha256").update(JSON.stringify(values), "utf8").digest("hex")}`,
  );
}

function copyMappedClaim(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((item: unknown): unknown => item));
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  return value === undefined ? undefined : Object.freeze({ unsupported: true });
}

function requireExactRecord(
  value: unknown,
  allowedFields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) throw new Error("JWT structured claim is invalid.");
  const actual = Object.keys(value);
  if (actual.some((field) => !allowedFields.includes(field))) {
    throw new Error("JWT structured claim contains unsupported fields.");
  }
  return value;
}

function isPublicP256Jwk(value: unknown): value is JWK {
  return (
    isPlainRecord(value) &&
    value["kty"] === "EC" &&
    value["crv"] === "P-256" &&
    typeof value["x"] === "string" &&
    typeof value["y"] === "string" &&
    value["d"] === undefined
  );
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSecureProviderUrl(url: URL): void {
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Runtime OIDC provider URLs must use HTTPS outside loopback development.");
  }
}
