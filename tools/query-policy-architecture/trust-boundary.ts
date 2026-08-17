import { createHash } from "node:crypto";

export type IdentityType = "human" | "service";

export interface VerifiedTokenClaims {
  readonly verification: "signature-issuer-audience";
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly authenticatedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
  readonly tokenId: string;
  readonly actorSubject: string | null;
  readonly confirmationThumbprint: string | null;
}

export interface PrincipalRecord {
  readonly principalId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly identityType: IdentityType;
  readonly enabled: boolean;
  readonly permissions: readonly string[];
  readonly mayDelegateToPrincipalIds: readonly string[];
}

export interface DelegationReplayPort {
  consume(tokenId: string, expiresAtEpochSeconds: number): boolean;
}

export interface TrustedIdentityContext {
  readonly source: "server-verified";
  readonly actor: Readonly<{ principalId: string; identityType: IdentityType }>;
  readonly effectivePrincipal: Readonly<{ principalId: string; identityType: IdentityType }>;
  readonly delegationChain: readonly string[];
  readonly permissionMode: "intersection";
  readonly effectivePermissions: readonly string[];
  readonly authenticatedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
  readonly proofOfPossessionThumbprint: string | null;
  readonly fingerprint: string;
}

const clientAssertionHeaders = new Set([
  "x-ontos-principal",
  "x-ontos-identity-type",
  "x-ontos-delegation",
  "x-ontos-effective-user",
]);
const principalIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function rejectClientIdentityAssertions(headers: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(headers)) {
    if (clientAssertionHeaders.has(name.toLowerCase())) {
      throw new Error("IDENTITY_CLIENT_ASSERTION_FORBIDDEN");
    }
  }
}

export function establishHumanIdentity(
  claims: VerifiedTokenClaims,
  principal: PrincipalRecord,
  input: Readonly<{ issuer: string; audience: string; nowEpochSeconds: number }>,
): TrustedIdentityContext {
  assertVerifiedClaims(claims, input);
  assertPrincipalMatches(claims.issuer, claims.subject, principal, "human");
  if (claims.actorSubject !== null || claims.confirmationThumbprint !== null) {
    throw new Error("IDENTITY_HUMAN_DELEGATION_CLAIMS_FORBIDDEN");
  }
  return identityContext({
    actor: principal,
    effective: principal,
    delegationChain: [],
    permissions: principal.permissions,
    claims,
  });
}

export function establishDelegatedIdentity(
  claims: VerifiedTokenClaims,
  service: PrincipalRecord,
  effectiveHuman: PrincipalRecord,
  replay: DelegationReplayPort,
  input: Readonly<{
    issuer: string;
    audience: string;
    nowEpochSeconds: number;
    maximumDelegationSeconds: number;
  }>,
): TrustedIdentityContext {
  assertVerifiedClaims(claims, input);
  assertPrincipalMatches(claims.issuer, required(claims.actorSubject), service, "service");
  assertPrincipalMatches(claims.issuer, claims.subject, effectiveHuman, "human");
  if (
    !Number.isInteger(input.maximumDelegationSeconds) ||
    input.maximumDelegationSeconds < 1 ||
    claims.expiresAtEpochSeconds - claims.authenticatedAtEpochSeconds >
      input.maximumDelegationSeconds
  ) {
    throw new Error("IDENTITY_DELEGATION_TTL_INVALID");
  }
  if (
    claims.confirmationThumbprint === null ||
    claims.confirmationThumbprint.length < 16 ||
    !service.mayDelegateToPrincipalIds.includes(effectiveHuman.principalId)
  ) {
    throw new Error("IDENTITY_DELEGATION_NOT_AUTHORIZED");
  }
  if (!replay.consume(claims.tokenId, claims.expiresAtEpochSeconds)) {
    throw new Error("IDENTITY_DELEGATION_REPLAYED");
  }
  const effectivePermissions = service.permissions
    .filter((permission) => effectiveHuman.permissions.includes(permission))
    .toSorted((left, right) => left.localeCompare(right));
  return identityContext({
    actor: service,
    effective: effectiveHuman,
    delegationChain: [service.principalId, effectiveHuman.principalId],
    permissions: effectivePermissions,
    claims,
  });
}

function assertVerifiedClaims(
  claims: VerifiedTokenClaims,
  input: Readonly<{ issuer: string; audience: string; nowEpochSeconds: number }>,
): void {
  if (
    claims.verification !== "signature-issuer-audience" ||
    claims.issuer !== input.issuer ||
    claims.audience !== input.audience ||
    claims.subject.length === 0 ||
    claims.tokenId.length < 8 ||
    !Number.isInteger(claims.authenticatedAtEpochSeconds) ||
    !Number.isInteger(claims.expiresAtEpochSeconds) ||
    !Number.isInteger(input.nowEpochSeconds) ||
    claims.authenticatedAtEpochSeconds > input.nowEpochSeconds ||
    claims.expiresAtEpochSeconds <= input.nowEpochSeconds
  ) {
    throw new Error("IDENTITY_VERIFIED_CLAIMS_INVALID");
  }
}

function assertPrincipalMatches(
  issuer: string,
  subject: string,
  principal: PrincipalRecord,
  identityType: IdentityType,
): void {
  if (
    !principalIdPattern.test(principal.principalId) ||
    !principal.enabled ||
    principal.issuer !== issuer ||
    principal.subject !== subject ||
    principal.identityType !== identityType ||
    new Set(principal.permissions).size !== principal.permissions.length ||
    new Set(principal.mayDelegateToPrincipalIds).size !== principal.mayDelegateToPrincipalIds.length
  ) {
    throw new Error("IDENTITY_PRINCIPAL_DIRECTORY_MISMATCH");
  }
}

function identityContext(
  input: Readonly<{
    actor: PrincipalRecord;
    effective: PrincipalRecord;
    delegationChain: readonly string[];
    permissions: readonly string[];
    claims: VerifiedTokenClaims;
  }>,
): TrustedIdentityContext {
  const canonical = JSON.stringify([
    input.actor.principalId,
    input.actor.identityType,
    input.effective.principalId,
    input.effective.identityType,
    input.delegationChain,
    [...input.permissions].toSorted((left, right) => left.localeCompare(right)),
    input.claims.authenticatedAtEpochSeconds,
    input.claims.expiresAtEpochSeconds,
    input.claims.confirmationThumbprint,
  ]);
  return Object.freeze({
    source: "server-verified",
    actor: Object.freeze({
      principalId: input.actor.principalId,
      identityType: input.actor.identityType,
    }),
    effectivePrincipal: Object.freeze({
      principalId: input.effective.principalId,
      identityType: input.effective.identityType,
    }),
    delegationChain: Object.freeze([...input.delegationChain]),
    permissionMode: "intersection",
    effectivePermissions: Object.freeze(
      [...input.permissions].toSorted((left, right) => left.localeCompare(right)),
    ),
    authenticatedAtEpochSeconds: input.claims.authenticatedAtEpochSeconds,
    expiresAtEpochSeconds: input.claims.expiresAtEpochSeconds,
    proofOfPossessionThumbprint: input.claims.confirmationThumbprint,
    fingerprint: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
  });
}

function required(value: string | null): string {
  if (value === null || value.length === 0) throw new Error("IDENTITY_DELEGATION_ACTOR_REQUIRED");
  return value;
}
