import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseIdentityDelegationSummary,
  parseOntosId,
  type ArtifactDigest,
  type CanonicalInstant,
  type IdentityDelegationSummary,
  type IdentityType,
} from "@ontos/contracts";
import {
  canonicalClaimMapping,
  decideIntersectedPermission,
  parseClaimMappingDefinition,
  type ClaimMappingDefinition,
  type MappedActorAttribute,
  type PrincipalPermissionGrant,
  type RuntimePermissionDecision,
} from "@ontos/identity-domain";

export const RUNTIME_IDENTITY_LIMITS = Object.freeze({
  maximumDelegatingServices: 15,
  maximumCapabilities: 16,
  maximumDelegationTtlSeconds: 120,
});

export interface VerifiedRuntimeCredential {
  readonly protocol: "direct" | "delegated";
  readonly actorCount: number;
  readonly authorizedParty: string;
  readonly requestedCapabilities: readonly string[];
  readonly authenticatedAt: CanonicalInstant;
  readonly issuedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
  readonly replayFingerprint: ArtifactDigest | null;
  resolveSnapshot(
    repository: RuntimeIdentityFactsRepository,
    projectId: string,
  ): Promise<RuntimeIdentitySnapshot>;
  mapClaims(definition: ClaimMappingDefinition): readonly MappedActorAttribute[];
}

export interface ServiceIdentityProfileFacts {
  readonly clientId: string;
  readonly capabilities: readonly string[];
  readonly state: "active" | "revoked";
}

export interface RuntimePrincipalFacts {
  readonly principalId: string;
  readonly identityType: IdentityType;
  readonly state: "active" | "disabled";
  readonly projectBound: boolean;
  readonly serviceProfile: ServiceIdentityProfileFacts | null;
}

export interface ActiveClaimMappingFacts {
  readonly claimMappingRevisionId: string;
  readonly identityType: IdentityType;
  readonly mappingDigest: ArtifactDigest;
  readonly mapping: unknown;
}

export interface RuntimeIdentitySnapshot {
  readonly terminal: RuntimePrincipalFacts;
  readonly actors: readonly RuntimePrincipalFacts[];
  readonly claimMapping: ActiveClaimMappingFacts;
}

export interface RuntimeIdentityFactsRepository {
  resolveSnapshot(input: {
    readonly projectId: string;
    readonly issuer: string;
    readonly terminalSubject: string;
    readonly actorSubjects: readonly string[];
  }): Promise<RuntimeIdentitySnapshot>;
  consumeDelegationReplay(input: {
    readonly projectId: string;
    readonly replayFingerprint: ArtifactDigest;
    readonly expiresAtEpochSeconds: number;
  }): Promise<boolean>;
}

export interface IdentityCryptography {
  digestCanonicalText(canonicalText: string): ArtifactDigest;
}

export interface RuntimeIdentityContext {
  readonly identity: IdentityDelegationSummary;
  readonly attributes: readonly MappedActorAttribute[];
  readonly capabilities: readonly string[];
  readonly authorizationPrincipalIds: readonly string[];
}

export type RuntimeIdentityErrorCode = "AUTHENTICATION_FAILED";

export class RuntimeIdentityError extends Error {
  readonly code: RuntimeIdentityErrorCode = "AUTHENTICATION_FAILED";

  constructor() {
    super("Runtime identity could not be established.");
    this.name = "RuntimeIdentityError";
  }
}

export interface RuntimeIdentityApplicationServiceOptions {
  readonly repository: RuntimeIdentityFactsRepository;
  readonly cryptography: IdentityCryptography;
  readonly humanClientIds: readonly string[];
  readonly maximumDelegationTtlSeconds?: number;
}

export class RuntimeIdentityApplicationService {
  readonly #repository: RuntimeIdentityFactsRepository;
  readonly #cryptography: IdentityCryptography;
  readonly #humanClientIds: ReadonlySet<string>;
  readonly #maximumDelegationTtlSeconds: number;

  constructor(options: RuntimeIdentityApplicationServiceOptions) {
    this.#repository = options.repository;
    this.#cryptography = options.cryptography;
    this.#humanClientIds = new Set(options.humanClientIds);
    this.#maximumDelegationTtlSeconds =
      options.maximumDelegationTtlSeconds ?? RUNTIME_IDENTITY_LIMITS.maximumDelegationTtlSeconds;
    if (
      this.#humanClientIds.size === 0 ||
      this.#maximumDelegationTtlSeconds < 1 ||
      this.#maximumDelegationTtlSeconds > RUNTIME_IDENTITY_LIMITS.maximumDelegationTtlSeconds
    ) {
      throw new Error("Runtime Identity service configuration is invalid.");
    }
  }

  async establish(input: {
    readonly projectId: string;
    readonly credential: VerifiedRuntimeCredential;
  }): Promise<RuntimeIdentityContext> {
    try {
      return await this.#establish(input.projectId, input.credential);
    } catch {
      throw new RuntimeIdentityError();
    }
  }

  decidePermission(
    context: RuntimeIdentityContext,
    grants: readonly PrincipalPermissionGrant[],
    permission: string,
  ): RuntimePermissionDecision {
    try {
      return decideIntersectedPermission(context.authorizationPrincipalIds, grants, permission);
    } catch {
      return Object.freeze({ decision: "DENY" });
    }
  }

  async #establish(
    projectIdInput: string,
    credential: VerifiedRuntimeCredential,
  ): Promise<RuntimeIdentityContext> {
    const projectId = parseOntosId(projectIdInput);
    assertCredentialEnvelope(credential, this.#maximumDelegationTtlSeconds);
    const snapshot = await credential.resolveSnapshot(this.#repository, projectId);
    validateSnapshot(snapshot, credential, this.#humanClientIds);

    const definition = parseClaimMappingDefinition(snapshot.claimMapping.mapping);
    const canonicalMapping = canonicalClaimMapping(definition);
    if (
      this.#cryptography.digestCanonicalText(canonicalMapping) !==
      snapshot.claimMapping.mappingDigest
    ) {
      throw new Error("Claim Mapping digest mismatch.");
    }
    const attributes = credential.mapClaims(definition);
    const claimsFingerprint = parseArtifactDigest(
      this.#cryptography.digestCanonicalText(
        canonicalizeContractForDigest({
          schemaVersion: 1,
          claimMappingRevisionId: parseOntosId(snapshot.claimMapping.claimMappingRevisionId),
          mappingDigest: snapshot.claimMapping.mappingDigest,
          attributes,
        }),
      ),
    );

    const principals = authorizationPrincipals(snapshot, credential.protocol);
    if (credential.protocol === "delegated") {
      const replayFingerprint = credential.replayFingerprint;
      if (
        replayFingerprint === null ||
        !(await this.#repository.consumeDelegationReplay({
          projectId,
          replayFingerprint,
          expiresAtEpochSeconds: credential.expiresAtEpochSeconds,
        }))
      ) {
        throw new Error("Delegation replay rejected.");
      }
    }

    const [actor, ...delegationChain] = principals;
    if (actor === undefined) throw new Error("Runtime identity has no actor.");
    const identity = parseIdentityDelegationSummary({
      schemaVersion: 1,
      actor: { principalId: actor.principalId, identityType: actor.identityType },
      delegationChain: delegationChain.map((principal) => ({
        principalId: principal.principalId,
        identityType: principal.identityType,
      })),
      claimsFingerprint,
      authenticatedAt: credential.authenticatedAt,
      authorizationMode: "intersection",
    });
    return Object.freeze({
      identity,
      attributes,
      capabilities: Object.freeze([...credential.requestedCapabilities]),
      authorizationPrincipalIds: Object.freeze(
        principals.map((principal) => principal.principalId),
      ),
    });
  }
}

function assertCredentialEnvelope(
  credential: VerifiedRuntimeCredential,
  maximumDelegationTtlSeconds: number,
): void {
  if (
    !Number.isSafeInteger(credential.actorCount) ||
    credential.actorCount < 0 ||
    credential.authorizedParty.length === 0 ||
    credential.authorizedParty.length > 255 ||
    !Number.isSafeInteger(credential.issuedAtEpochSeconds) ||
    !Number.isSafeInteger(credential.expiresAtEpochSeconds) ||
    credential.expiresAtEpochSeconds <= credential.issuedAtEpochSeconds ||
    credential.actorCount > RUNTIME_IDENTITY_LIMITS.maximumDelegatingServices ||
    credential.requestedCapabilities.length > RUNTIME_IDENTITY_LIMITS.maximumCapabilities
  ) {
    throw new Error("Verified credential envelope is invalid.");
  }
  if (credential.protocol === "direct") {
    if (credential.actorCount !== 0 || credential.replayFingerprint !== null) {
      throw new Error("Direct credential shape is invalid.");
    }
  } else if (
    credential.actorCount === 0 ||
    credential.replayFingerprint === null ||
    credential.expiresAtEpochSeconds - credential.issuedAtEpochSeconds > maximumDelegationTtlSeconds
  ) {
    throw new Error("Delegated credential shape is invalid.");
  }
}

function validateSnapshot(
  snapshot: RuntimeIdentitySnapshot,
  credential: VerifiedRuntimeCredential,
  humanClientIds: ReadonlySet<string>,
): void {
  if (
    snapshot.actors.length !== credential.actorCount ||
    snapshot.claimMapping.identityType !== snapshot.terminal.identityType
  ) {
    throw new Error("Runtime identity snapshot is incomplete.");
  }
  for (const principal of [snapshot.terminal, ...snapshot.actors]) {
    parseOntosId(principal.principalId);
    if (principal.state !== "active" || !principal.projectBound) {
      throw new Error("Runtime Principal is not active in the Project.");
    }
  }

  if (credential.protocol === "direct") {
    if (snapshot.terminal.identityType === "human") {
      if (
        !humanClientIds.has(credential.authorizedParty) ||
        credential.requestedCapabilities.length !== 0 ||
        snapshot.terminal.serviceProfile !== null
      ) {
        throw new Error("Human client binding is invalid.");
      }
    } else {
      validateServicePrincipal(snapshot.terminal, credential);
    }
    return;
  }

  if (snapshot.terminal.identityType !== "human" || snapshot.terminal.serviceProfile !== null) {
    throw new Error("Delegation terminal subject must be human.");
  }
  if (credential.requestedCapabilities.length === 0) {
    throw new Error("Delegation requires a Service Capability.");
  }
  for (const actor of snapshot.actors) validateServicePrincipal(actor, credential);
  const immediateActor = snapshot.actors[0];
  if (immediateActor?.serviceProfile?.clientId !== credential.authorizedParty) {
    throw new Error("Delegation client binding is invalid.");
  }
}

function validateServicePrincipal(
  principal: RuntimePrincipalFacts,
  credential: VerifiedRuntimeCredential,
): void {
  const profile = principal.serviceProfile;
  if (
    principal.identityType !== "service" ||
    profile === null ||
    profile.state !== "active" ||
    (credential.protocol === "direct" && profile.clientId !== credential.authorizedParty) ||
    credential.requestedCapabilities.length === 0 ||
    credential.requestedCapabilities.some(
      (capability) => !profile.capabilities.includes(capability),
    )
  ) {
    throw new Error("Service identity profile is invalid.");
  }
}

function authorizationPrincipals(
  snapshot: RuntimeIdentitySnapshot,
  protocol: VerifiedRuntimeCredential["protocol"],
): readonly RuntimePrincipalFacts[] {
  if (protocol === "direct") return Object.freeze([snapshot.terminal]);
  return Object.freeze([...snapshot.actors, snapshot.terminal]);
}
