import { failContract } from "./error.ts";
import {
  requireLiteral,
  requireObjectShape,
  requirePlainRecord,
  requireOneOf,
} from "./internal.ts";
import {
  parseArtifactDigest,
  parseCanonicalInstant,
  parseOntosId,
  parseSchemaVersion,
  type ArtifactDigest,
  type CanonicalInstant,
  type ContractSchemaVersion,
  type OntosId,
} from "./scalars.ts";

export type IdentityType = "human" | "service";

export interface PrincipalSummary {
  readonly principalId: OntosId;
  readonly identityType: IdentityType;
}

export interface IdentityDelegationSummary {
  readonly schemaVersion: ContractSchemaVersion;
  readonly actor: PrincipalSummary;
  readonly delegationChain: readonly PrincipalSummary[];
  readonly claimsFingerprint: ArtifactDigest;
  readonly authenticatedAt: CanonicalInstant;
  readonly authorizationMode: "intersection";
}

export const PRINCIPAL_SUMMARY_FIELDS = Object.freeze(["principalId", "identityType"] as const);
export const IDENTITY_DELEGATION_SUMMARY_FIELDS = Object.freeze([
  "schemaVersion",
  "actor",
  "delegationChain",
  "claimsFingerprint",
  "authenticatedAt",
  "authorizationMode",
] as const);
export const IDENTITY_TYPE_VALUES = Object.freeze(["human", "service"] as const);
export const DELEGATION_CHAIN_MAXIMUM_ITEMS = 16;

const identityTypes: ReadonlySet<IdentityType> = new Set(IDENTITY_TYPE_VALUES);

export function parseIdentityDelegationSummary(value: unknown): IdentityDelegationSummary {
  const record = requirePlainRecord(value, "$identity");
  requireObjectShape(
    record,
    IDENTITY_DELEGATION_SUMMARY_FIELDS,
    IDENTITY_DELEGATION_SUMMARY_FIELDS,
    "$identity",
  );
  if (!Array.isArray(record.delegationChain)) {
    failContract(
      "CONTRACT_TYPE_INVALID",
      "delegationChain must be an array.",
      "$identity.delegationChain",
    );
  }
  if (record.delegationChain.length > DELEGATION_CHAIN_MAXIMUM_ITEMS) {
    failContract(
      "CONTRACT_VALUE_OUT_OF_RANGE",
      `delegationChain exceeds ${DELEGATION_CHAIN_MAXIMUM_ITEMS} principals.`,
      "$identity.delegationChain",
    );
  }
  const actor = parsePrincipal(record.actor, "$identity.actor");
  const delegationChain = (record.delegationChain as unknown[]).map((item, index) =>
    parsePrincipal(item, `$identity.delegationChain[${index}]`),
  );
  const principalIds = [actor.principalId, ...delegationChain.map((item) => item.principalId)];
  if (new Set(principalIds).size !== principalIds.length) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Actor and Delegation principals must be unique.",
      "$identity.delegationChain",
    );
  }
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, "$identity.schemaVersion"),
    actor,
    delegationChain: Object.freeze(delegationChain),
    claimsFingerprint: parseArtifactDigest(record.claimsFingerprint, "$identity.claimsFingerprint"),
    authenticatedAt: parseCanonicalInstant(record.authenticatedAt, "$identity.authenticatedAt"),
    authorizationMode: requireLiteral(
      record.authorizationMode,
      "intersection",
      "$identity.authorizationMode",
    ),
  });
}

function parsePrincipal(value: unknown, path: string): PrincipalSummary {
  const record = requirePlainRecord(value, path);
  requireObjectShape(record, PRINCIPAL_SUMMARY_FIELDS, PRINCIPAL_SUMMARY_FIELDS, path);
  const identityType = requireOneOf(record.identityType, identityTypes, `${path}.identityType`);
  return Object.freeze({
    principalId: parseOntosId(record.principalId, `${path}.principalId`),
    identityType,
  });
}
