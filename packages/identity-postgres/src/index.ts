import { createHash } from "node:crypto";

import { parseArtifactDigest, type ArtifactDigest, type IdentityType } from "@ontos/contracts";
import type {
  ActiveClaimMappingFacts,
  IdentityCryptography,
  RuntimeIdentityFactsRepository,
  RuntimeIdentitySnapshot,
  RuntimePrincipalFacts,
  ServiceIdentityProfileFacts,
} from "@ontos/identity-application";
import type pg from "pg";

interface PrincipalRow extends pg.QueryResultRow {
  readonly ordinality: string;
  readonly principal_id: string;
  readonly identity_type: string;
  readonly principal_state: string;
  readonly project_bound: boolean;
  readonly service_client_id: string | null;
  readonly service_capabilities: unknown;
  readonly service_profile_state: string | null;
}

interface ClaimMappingRow extends pg.QueryResultRow {
  readonly claim_mapping_revision_id: string;
  readonly identity_type: string;
  readonly mapping_digest: string;
  readonly mapping: unknown;
}

interface BooleanRow extends pg.QueryResultRow {
  readonly consumed: boolean;
}

export class PostgresRuntimeIdentityRepository implements RuntimeIdentityFactsRepository {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async resolveSnapshot(input: {
    readonly projectId: string;
    readonly issuer: string;
    readonly terminalSubject: string;
    readonly actorSubjects: readonly string[];
  }): Promise<RuntimeIdentitySnapshot> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const subjects = [input.terminalSubject, ...input.actorSubjects];
      const principals = await client.query<PrincipalRow>(
        `SELECT subject_input.ordinality::text AS ordinality, resolved.*
         FROM unnest($3::text[]) WITH ORDINALITY AS subject_input(subject, ordinality)
         CROSS JOIN LATERAL authz.resolve_runtime_principal(
           $1::uuid, $2::text, subject_input.subject
         ) AS resolved
         ORDER BY subject_input.ordinality`,
        [input.projectId, input.issuer, subjects],
      );
      if (principals.rows.length !== subjects.length) {
        throw new Error("Runtime Principal resolution was incomplete.");
      }
      const terminal = principalFacts(principals.rows[0]);
      if (terminal === undefined) throw new Error("Runtime terminal Principal is missing.");
      const actors = principals.rows.slice(1).map((row) => requiredPrincipalFacts(row));
      const mappingResult = await client.query<ClaimMappingRow>(
        `SELECT claim_mapping_revision_id::text, identity_type, mapping_digest, mapping
         FROM authz.resolve_claim_mapping($1::uuid, $2::text, $3::text)`,
        [input.projectId, input.issuer, terminal.identityType],
      );
      const mapping = mappingFacts(mappingResult.rows[0]);
      await client.query("COMMIT");
      return Object.freeze({
        terminal,
        actors: Object.freeze(actors),
        claimMapping: mapping,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The public identity error deliberately hides dependency details.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeDelegationReplay(input: {
    readonly projectId: string;
    readonly replayFingerprint: ArtifactDigest;
    readonly expiresAtEpochSeconds: number;
  }): Promise<boolean> {
    const result = await this.#pool.query<BooleanRow>(
      `SELECT authz.consume_delegation_replay(
         $1::uuid, $2::text, to_timestamp($3::double precision)
       ) AS consumed`,
      [input.projectId, input.replayFingerprint, input.expiresAtEpochSeconds],
    );
    return result.rows[0]?.consumed === true;
  }
}

export const nodeIdentityCryptography: IdentityCryptography = Object.freeze({
  digestCanonicalText(canonicalText: string): ArtifactDigest {
    return parseArtifactDigest(
      `sha256:${createHash("sha256").update(canonicalText, "utf8").digest("hex")}`,
    );
  },
});

function requiredPrincipalFacts(row: PrincipalRow | undefined): RuntimePrincipalFacts {
  const facts = principalFacts(row);
  if (facts === undefined) throw new Error("Runtime Principal facts are invalid.");
  return facts;
}

function principalFacts(row: PrincipalRow | undefined): RuntimePrincipalFacts | undefined {
  if (
    row === undefined ||
    (row.identity_type !== "human" && row.identity_type !== "service") ||
    (row.principal_state !== "active" && row.principal_state !== "disabled")
  ) {
    return undefined;
  }
  const serviceProfile = profileFacts(row, row.identity_type);
  return Object.freeze({
    principalId: row.principal_id,
    identityType: row.identity_type,
    state: row.principal_state,
    projectBound: row.project_bound,
    serviceProfile,
  });
}

function profileFacts(
  row: PrincipalRow,
  identityType: IdentityType,
): ServiceIdentityProfileFacts | null {
  if (
    row.service_client_id === null &&
    row.service_capabilities === null &&
    row.service_profile_state === null
  ) {
    return null;
  }
  if (
    identityType !== "service" ||
    typeof row.service_client_id !== "string" ||
    !Array.isArray(row.service_capabilities) ||
    !row.service_capabilities.every((item) => typeof item === "string") ||
    (row.service_profile_state !== "active" && row.service_profile_state !== "revoked")
  ) {
    throw new Error("Service identity profile facts are invalid.");
  }
  return Object.freeze({
    clientId: row.service_client_id,
    capabilities: Object.freeze([...row.service_capabilities] as string[]),
    state: row.service_profile_state,
  });
}

function mappingFacts(row: ClaimMappingRow | undefined): ActiveClaimMappingFacts {
  if (row === undefined || (row.identity_type !== "human" && row.identity_type !== "service")) {
    throw new Error("Active Claim Mapping facts are invalid.");
  }
  return Object.freeze({
    claimMappingRevisionId: row.claim_mapping_revision_id,
    identityType: row.identity_type,
    mappingDigest: parseArtifactDigest(row.mapping_digest),
    mapping: row.mapping,
  });
}
