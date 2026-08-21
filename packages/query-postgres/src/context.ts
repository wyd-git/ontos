import {
  parseArtifactDigest,
  parseCanonicalInstant,
  parseOntosId,
  type ArtifactDigest,
} from "@ontos/contracts";
import {
  RuntimeQueryError,
  parseRuntimeQueryCandidate,
  type CommittedRuntimeQueryLease,
  type RuntimeQueryContextCandidate,
  type RuntimeQueryContextRepository,
} from "@ontos/query-application";
import type pg from "pg";

interface CandidateRow extends pg.QueryResultRow {
  readonly resolution_status: string;
  readonly observed_database_at: string;
  readonly project_id: string | null;
  readonly release_id: string | null;
  readonly release_revision_id: string | null;
  readonly activation_id: string | null;
  readonly runtime_plan_digest: string | null;
  readonly generation_count: number | null;
  readonly generation_set_digest: string | null;
  readonly policy_resource_id: string | null;
  readonly policy_revision_id: string | null;
  readonly policy_compilation_id: string | null;
  readonly policy_artifact_digest: string | null;
  readonly policy_compiler_version: string | null;
  readonly members: unknown;
}

interface LeaseRow extends pg.QueryResultRow {
  readonly project_id: string;
  readonly query_lease_id: string;
  readonly release_id: string;
  readonly activation_id: string;
  readonly policy_compilation_id: string;
  readonly policy_revision_id: string;
  readonly identity_context_hash: string;
  readonly authorization_epoch: string;
  readonly policy_context_hash: string;
  readonly policy_artifact_digest: string;
  readonly policy_compiler_version: string;
  readonly query_hash: string;
  readonly generation_count: number;
  readonly generation_set_digest: string;
  readonly state: string;
  readonly control_sequence: string;
  readonly expires_at: string;
}

interface RawMember {
  readonly memberKey: string;
  readonly kind: "object" | "link";
  readonly resourceId: string;
  readonly revisionId: string;
  readonly generationId: string;
  readonly definition: unknown;
}

const memberKeyExpression = /^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$/u;
const compilerVersionExpression = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export class PostgresRuntimeQueryContextRepository implements RuntimeQueryContextRepository {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async resolveCandidate(input: {
    readonly projectId: string;
    readonly selector:
      | { readonly kind: "release"; readonly releaseId: string }
      | { readonly kind: "channel"; readonly channelName: "stable" };
  }): Promise<RuntimeQueryContextCandidate> {
    const selectorValue =
      input.selector.kind === "release" ? input.selector.releaseId : input.selector.channelName;
    let result: pg.QueryResult<CandidateRow>;
    try {
      result = await this.#pool.query<CandidateRow>(
        `SELECT resolution_status, observed_database_at,
                project_id::text, release_id::text, release_revision_id::text,
                activation_id::text, runtime_plan_digest, generation_count,
                generation_set_digest, policy_resource_id::text,
                policy_revision_id::text, policy_compilation_id::text,
                policy_artifact_digest, policy_compiler_version, members
         FROM runtime.resolve_query_context_candidate($1::uuid, $2::text, $3::text)`,
        [input.projectId, input.selector.kind, selectorValue],
      );
    } catch (error) {
      throw new RuntimeQueryPostgresError({ cause: error });
    }
    if (result.rows.length !== 1) throw new RuntimeQueryPostgresError();
    const row = result.rows[0];
    if (row === undefined) throw new RuntimeQueryPostgresError();
    switch (row.resolution_status) {
      case "release_retired":
        throw new RuntimeQueryError("RELEASE_RETIRED");
      case "policy_unavailable":
        throw new RuntimeQueryError("POLICY_EVALUATION_UNAVAILABLE");
      case "not_serving":
        throw new RuntimeQueryError(
          input.selector.kind === "release" ? "RELEASE_RETIRED" : "QUERY_EXECUTION_FAILED",
        );
      case "context_unavailable":
        throw new RuntimeQueryError("QUERY_EXECUTION_FAILED");
      case "resolved":
        return parseResolvedCandidate(row);
      default:
        throw new RuntimeQueryPostgresError();
    }
  }

  async commitLease(input: {
    readonly candidate: RuntimeQueryContextCandidate;
    readonly queryLeaseId: string;
    readonly identityContextHash: ArtifactDigest;
    readonly authorizationEpoch: string;
    readonly policyContextHash: ArtifactDigest;
    readonly queryHash: ArtifactDigest;
    readonly correlationId: string;
    readonly ttlSeconds: number;
  }): Promise<CommittedRuntimeQueryLease> {
    let result: pg.QueryResult<LeaseRow>;
    try {
      result = await this.#pool.query<LeaseRow>(
        `SELECT committed.project_id::text, committed.query_lease_id::text,
                committed.release_id::text, committed.activation_id::text,
                committed.policy_compilation_id::text,
                committed.policy_revision_id::text,
                committed.identity_context_hash, committed.authorization_epoch::text,
                committed.policy_context_hash, committed.policy_artifact_digest,
                committed.policy_compiler_version, committed.query_hash,
                committed.generation_count, committed.generation_set_digest, committed.state,
                committed.control_sequence::text,
                to_char(committed.expires_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
         FROM runtime.commit_query_execution_context(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::uuid,
           $7::text, $8::bigint, $9::text, $10::text, $11::text, $12::integer
         ) AS committed`,
        [
          input.candidate.projectId,
          input.queryLeaseId,
          input.candidate.releaseId,
          input.candidate.activationId,
          input.candidate.generationSetDigest,
          input.candidate.policy.policyCompilationId,
          input.identityContextHash,
          input.authorizationEpoch,
          input.policyContextHash,
          input.queryHash,
          input.correlationId,
          input.ttlSeconds,
        ],
      );
    } catch (error) {
      if (isQueryContextConflict(error)) {
        throw new RuntimeQueryError("QUERY_CONTEXT_CHANGED", { cause: error });
      }
      throw new RuntimeQueryPostgresError({ cause: error });
    }
    const lease = parseCommittedLease(result.rows);
    const row = result.rows[0];
    if (
      row === undefined ||
      lease.projectId !== input.candidate.projectId ||
      lease.queryLeaseId !== input.queryLeaseId ||
      lease.releaseId !== input.candidate.releaseId ||
      lease.activationId !== input.candidate.activationId ||
      lease.identityContextHash !== input.identityContextHash ||
      lease.authorizationEpoch !== input.authorizationEpoch ||
      lease.policyContextHash !== input.policyContextHash ||
      lease.queryHash !== input.queryHash ||
      lease.generationSetDigest !== input.candidate.generationSetDigest ||
      row.policy_compilation_id !== input.candidate.policy.policyCompilationId ||
      row.policy_revision_id !== input.candidate.policy.policyRevisionId ||
      row.policy_artifact_digest !== input.candidate.policy.artifactDigest ||
      row.policy_compiler_version !== input.candidate.policy.compilerVersion ||
      row.generation_count !== input.candidate.members.length
    ) {
      throw new RuntimeQueryPostgresError();
    }
    return lease;
  }

  async releaseLease(lease: CommittedRuntimeQueryLease): Promise<void> {
    let result: pg.QueryResult<LeaseRow>;
    try {
      result = await this.#pool.query<LeaseRow>(
        `SELECT released.project_id::text, released.query_lease_id::text,
                released.release_id::text, released.activation_id::text,
                released.policy_compilation_id::text,
                released.policy_revision_id::text,
                released.identity_context_hash, released.authorization_epoch::text,
                released.policy_context_hash, released.policy_artifact_digest,
                released.policy_compiler_version, released.query_hash,
                released.generation_count, released.generation_set_digest, released.state,
                released.control_sequence::text,
                to_char(released.expires_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
         FROM runtime.release_query_lease($1::uuid, $2::uuid, $3::bigint) AS released`,
        [lease.projectId, lease.queryLeaseId, lease.controlSequence.toString()],
      );
    } catch (error) {
      throw new RuntimeQueryPostgresError({ cause: error });
    }
    const released = parseLeaseRow(result.rows, "released");
    if (
      released.projectId !== lease.projectId ||
      released.queryLeaseId !== lease.queryLeaseId ||
      released.releaseId !== lease.releaseId ||
      released.activationId !== lease.activationId ||
      released.controlSequence !== lease.controlSequence + 1n
    ) {
      throw new RuntimeQueryPostgresError();
    }
  }
}

export class RuntimeQueryPostgresError extends Error {
  constructor(options?: ErrorOptions) {
    super("Runtime Query persistence is unavailable.", options);
    this.name = "RuntimeQueryPostgresError";
  }
}

function parseResolvedCandidate(row: CandidateRow): RuntimeQueryContextCandidate {
  if (
    row.project_id === null ||
    row.release_id === null ||
    row.release_revision_id === null ||
    row.activation_id === null ||
    row.runtime_plan_digest === null ||
    row.generation_count === null ||
    row.generation_set_digest === null ||
    row.policy_resource_id === null ||
    row.policy_revision_id === null ||
    row.policy_compilation_id === null ||
    row.policy_artifact_digest === null ||
    row.policy_compiler_version === null ||
    !compilerVersionExpression.test(row.policy_compiler_version) ||
    !Number.isInteger(row.generation_count) ||
    row.generation_count < 1 ||
    row.generation_count > 256
  ) {
    throw new RuntimeQueryPostgresError();
  }
  const members = parseMembers(row.members, row.generation_count);
  return parseRuntimeQueryCandidate({
    projectId: row.project_id,
    releaseId: row.release_id,
    releaseRevisionId: row.release_revision_id,
    activationId: row.activation_id,
    runtimePlanDigest: parseArtifactDigest(row.runtime_plan_digest),
    generationSetDigest: parseArtifactDigest(row.generation_set_digest),
    observedDatabaseAt: parseCanonicalInstant(row.observed_database_at),
    policy: {
      policyResourceId: row.policy_resource_id,
      policyRevisionId: row.policy_revision_id,
      policyCompilationId: row.policy_compilation_id,
      artifactDigest: parseArtifactDigest(row.policy_artifact_digest),
      compilerVersion: row.policy_compiler_version,
    },
    members,
  });
}

function parseMembers(value: unknown, expectedCount: number): readonly RawMember[] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new RuntimeQueryPostgresError();
  }
  const memberKeys = new Set<string>();
  const generationIds = new Set<string>();
  const members = value.map((item) => {
    if (!isPlainRecord(item) || !hasExactKeys(item, MEMBER_FIELDS)) {
      throw new RuntimeQueryPostgresError();
    }
    const { memberKey, kind, resourceId, revisionId, generationId, definition } = item;
    if (
      typeof memberKey !== "string" ||
      !memberKeyExpression.test(memberKey) ||
      (kind !== "object" && kind !== "link") ||
      !memberKey.startsWith(`${kind}:`) ||
      memberKeys.has(memberKey) ||
      typeof generationId !== "string" ||
      generationIds.has(generationId)
    ) {
      throw new RuntimeQueryPostgresError();
    }
    memberKeys.add(memberKey);
    generationIds.add(generationId);
    const normalizedKind: "object" | "link" = kind;
    return Object.freeze({
      memberKey,
      kind: normalizedKind,
      resourceId: parseOntosId(resourceId),
      revisionId: parseOntosId(revisionId),
      generationId: parseOntosId(generationId),
      definition,
    });
  });
  return Object.freeze(members);
}

const MEMBER_FIELDS = Object.freeze([
  "memberKey",
  "kind",
  "resourceId",
  "revisionId",
  "generationId",
  "definition",
] as const);

function parseCommittedLease(rows: readonly LeaseRow[]): CommittedRuntimeQueryLease {
  return parseLeaseRow(rows, "committed");
}

function parseLeaseRow(
  rows: readonly LeaseRow[],
  expectedState: "committed" | "released",
): CommittedRuntimeQueryLease {
  if (rows.length !== 1) throw new RuntimeQueryPostgresError();
  const row = rows[0];
  if (row === undefined || row.state !== expectedState) throw new RuntimeQueryPostgresError();
  let controlSequence: bigint;
  try {
    controlSequence = BigInt(row.control_sequence);
  } catch (error) {
    throw new RuntimeQueryPostgresError({ cause: error });
  }
  if (controlSequence < 0n || !/^[1-9][0-9]*$/u.test(row.authorization_epoch)) {
    throw new RuntimeQueryPostgresError();
  }
  try {
    return Object.freeze({
      queryLeaseId: parseOntosId(row.query_lease_id),
      projectId: parseOntosId(row.project_id),
      releaseId: parseOntosId(row.release_id),
      activationId: parseOntosId(row.activation_id),
      identityContextHash: parseArtifactDigest(row.identity_context_hash),
      authorizationEpoch: row.authorization_epoch,
      policyContextHash: parseArtifactDigest(row.policy_context_hash),
      queryHash: parseArtifactDigest(row.query_hash),
      generationSetDigest: parseArtifactDigest(row.generation_set_digest),
      controlSequence,
      expiresAt: parseCanonicalInstant(row.expires_at),
    });
  } catch (error) {
    throw new RuntimeQueryPostgresError({ cause: error });
  }
}

function isQueryContextConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  // The legacy Lease planner uses 55000 for a Serving Head or immutable
  // runtime fact disappearing between candidate resolution and commit.  At
  // this adapter boundary both 40001 and that object-state class mean the
  // pre-authorized execution context was not committed and must be retried.
  if (code === "40001" || code === "55000") return true;
  const message = "message" in error ? error.message : undefined;
  if (typeof message !== "string") return false;
  return [
    "G20303_QUERY_SERVING_ACTIVATION_REQUIRED",
    "G20303_QUERY_POLICY_ARTIFACT_REQUIRED",
    "G20303_QUERY_GENERATION_SET_INVALID",
    "G20303_QUERY_GENERATION_SET_CHANGED",
    "G20308_QUERY_CONTEXT_CHANGED",
  ].some((code) => message.includes(code));
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): boolean {
  const actual = Object.keys(record).toSorted(compareText);
  const expected = [...fields].toSorted(compareText);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
