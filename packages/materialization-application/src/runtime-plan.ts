import {
  parseArtifactDigest,
  parseCompatibilityCertificate,
  parseOntosId,
  type ArtifactDigest,
  type CompatibilityCertificateContract,
} from "@ontos/contracts";

export type RuntimeCompatibilityErrorCode =
  | "RUNTIME_COMPATIBILITY_DEPENDENCY_UNAVAILABLE"
  | "RUNTIME_COMPATIBILITY_INPUT_INVALID"
  | "RUNTIME_COMPATIBILITY_STALE"
  | "RUNTIME_GENERATION_INCOMPATIBLE";

export class RuntimeCompatibilityError extends Error {
  readonly code: RuntimeCompatibilityErrorCode;

  constructor(code: RuntimeCompatibilityErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "RuntimeCompatibilityError";
    this.code = code;
  }
}

export interface RuntimeRefreshTargetMember {
  readonly memberKey: string;
  readonly runtimePlanDigest: ArtifactDigest;
}

export interface RuntimeRefreshTargetRelease {
  readonly releaseId: string;
  readonly releaseState: "staging" | "ready" | "published" | "superseded";
  readonly snapshotGroupCompatible: boolean;
  readonly members: readonly RuntimeRefreshTargetMember[];
}

export interface RuntimeGenerationCandidate {
  readonly generationId: string;
  readonly state: "building" | "ready" | "active" | "retired" | "failed";
  readonly runtimePlanDigest: ArtifactDigest;
}

export interface RuntimeMaterializationJobStatus {
  readonly jobId: string;
  readonly state: "queued" | "running" | "retry_wait" | "succeeded" | "dead_letter" | "cancelled";
  readonly reused: boolean;
}

export interface RuntimeCompatibilityRepository {
  readRefreshTargets(input: {
    readonly projectId: string;
    readonly snapshotGroupId: string;
    readonly groupVersion: number;
  }): Promise<readonly RuntimeRefreshTargetRelease[]>;
  ensureMaterializationJob(input: {
    readonly projectId: string;
    readonly snapshotGroupId: string;
    readonly groupVersion: number;
  }): Promise<RuntimeMaterializationJobStatus>;
  readGenerationCandidates(input: {
    readonly projectId: string;
    readonly snapshotGroupId: string;
    readonly groupVersion: number;
    readonly memberKey: string;
  }): Promise<readonly RuntimeGenerationCandidate[]>;
  issueCompatibilityCertificate(input: {
    readonly projectId: string;
    readonly generationId: string;
    readonly targetReleaseId: string;
  }): Promise<CompatibilityCertificateContract>;
}

export type RuntimeRefreshReleaseOutcome = "pending" | "ready" | "reused" | "failed" | "stale";

export interface RuntimeRefreshReleaseResult {
  readonly releaseId: string;
  readonly outcome: RuntimeRefreshReleaseOutcome;
  readonly memberCount: number;
  readonly certifiedMemberCount: number;
  readonly certificates: readonly CompatibilityCertificateContract[];
}

export interface RuntimeRefreshPreparationResult {
  readonly projectId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
  readonly job: RuntimeMaterializationJobStatus;
  readonly releases: readonly RuntimeRefreshReleaseResult[];
}

/**
 * Coordinates build readiness and trusted compatibility independently per Release.
 * It intentionally does not create an Activation or move a Serving Head; G2-02-11
 * owns the short atomic cutover transaction.
 */
export class RuntimeCompatibilityCoordinator {
  readonly #repository: RuntimeCompatibilityRepository;

  constructor(repository: RuntimeCompatibilityRepository) {
    this.#repository = repository;
  }

  async issueGenerationCertificate(input: unknown): Promise<CompatibilityCertificateContract> {
    const parsed = parseCertificateCommand(input);
    return mapDependency(() => this.#repository.issueCompatibilityCertificate(parsed));
  }

  async prepareSnapshotGroupRefresh(input: unknown): Promise<RuntimeRefreshPreparationResult> {
    const command = parseRefreshCommand(input);
    const [targets, job] = await Promise.all([
      mapDependency(() => this.#repository.readRefreshTargets(command)),
      mapDependency(() => this.#repository.ensureMaterializationJob(command)),
    ]);
    const releases: RuntimeRefreshReleaseResult[] = [];
    const jobFailed = job.state === "dead_letter" || job.state === "cancelled";
    for (const target of [...targets].sort((left, right) =>
      compareText(left.releaseId, right.releaseId),
    )) {
      releases.push(await this.#prepareRelease(command, target, jobFailed));
    }
    return Object.freeze({
      ...command,
      job,
      releases: Object.freeze(releases),
    });
  }

  async #prepareRelease(
    command: {
      readonly projectId: string;
      readonly snapshotGroupId: string;
      readonly groupVersion: number;
    },
    target: RuntimeRefreshTargetRelease,
    jobFailed: boolean,
  ): Promise<RuntimeRefreshReleaseResult> {
    if (!target.snapshotGroupCompatible) {
      return Object.freeze({
        releaseId: parseOntosId(target.releaseId),
        outcome: "stale" as const,
        memberCount: target.members.length,
        certifiedMemberCount: 0,
        certificates: Object.freeze([]),
      });
    }
    const certificates: CompatibilityCertificateContract[] = [];
    let reused = false;
    let sawFailed = false;
    let sawStale = false;
    const members = target.members
      .map((member) =>
        parseRuntimeRefreshMember({
          memberKey: member.memberKey,
          runtimePlanDigest: member.runtimePlanDigest,
        }),
      )
      .sort((left, right) => compareText(left.memberKey, right.memberKey));
    for (const member of members) {
      let candidates: readonly RuntimeGenerationCandidate[];
      try {
        candidates = await this.#repository.readGenerationCandidates({
          ...command,
          memberKey: member.memberKey,
        });
      } catch (error) {
        if (
          error instanceof RuntimeCompatibilityError &&
          error.code === "RUNTIME_COMPATIBILITY_STALE"
        ) {
          sawStale = true;
          continue;
        }
        throw mapRuntimeDependency(error);
      }
      sawFailed ||= candidates.some((candidate) => candidate.state === "failed");
      const eligible = candidates.filter(
        (candidate) => candidate.state === "ready" || candidate.state === "active",
      );
      let issued: CompatibilityCertificateContract | undefined;
      for (const candidate of eligible) {
        try {
          issued = await this.#repository.issueCompatibilityCertificate({
            projectId: command.projectId,
            generationId: candidate.generationId,
            targetReleaseId: target.releaseId,
          });
          reused ||= candidate.runtimePlanDigest !== member.runtimePlanDigest;
          break;
        } catch (error) {
          if (error instanceof RuntimeCompatibilityError) {
            if (error.code === "RUNTIME_COMPATIBILITY_STALE") sawStale = true;
            if (error.code === "RUNTIME_GENERATION_INCOMPATIBLE") continue;
            if (error.code === "RUNTIME_COMPATIBILITY_STALE") continue;
          }
          throw mapRuntimeDependency(error);
        }
      }
      if (issued !== undefined) certificates.push(parseCompatibilityCertificate(issued));
    }
    const complete = certificates.length === members.length;
    const outcome: RuntimeRefreshReleaseOutcome = complete
      ? reused
        ? "reused"
        : "ready"
      : sawStale
        ? "stale"
        : sawFailed || jobFailed
          ? "failed"
          : "pending";
    return Object.freeze({
      releaseId: parseOntosId(target.releaseId),
      outcome,
      memberCount: members.length,
      certifiedMemberCount: certificates.length,
      certificates: Object.freeze(
        certificates.sort((left, right) =>
          compareText(left.targetMemberKey, right.targetMemberKey),
        ),
      ),
    });
  }
}

function parseCertificateCommand(input: unknown) {
  try {
    const record = strictRecord(input, ["projectId", "generationId", "targetReleaseId"]);
    return Object.freeze({
      projectId: parseOntosId(record["projectId"]),
      generationId: parseOntosId(record["generationId"]),
      targetReleaseId: parseOntosId(record["targetReleaseId"]),
    });
  } catch (cause) {
    throw new RuntimeCompatibilityError("RUNTIME_COMPATIBILITY_INPUT_INVALID", { cause });
  }
}

function parseRefreshCommand(input: unknown) {
  try {
    const record = strictRecord(input, ["projectId", "snapshotGroupId", "groupVersion"]);
    const groupVersion = record["groupVersion"];
    if (!Number.isSafeInteger(groupVersion) || (groupVersion as number) < 1) throw new TypeError();
    return Object.freeze({
      projectId: parseOntosId(record["projectId"]),
      snapshotGroupId: parseOntosId(record["snapshotGroupId"]),
      groupVersion: groupVersion as number,
    });
  } catch (cause) {
    throw new RuntimeCompatibilityError("RUNTIME_COMPATIBILITY_INPUT_INVALID", { cause });
  }
}

async function mapDependency<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapRuntimeDependency(error);
  }
}

function mapRuntimeDependency(error: unknown): RuntimeCompatibilityError {
  if (error instanceof RuntimeCompatibilityError) return error;
  return new RuntimeCompatibilityError("RUNTIME_COMPATIBILITY_DEPENDENCY_UNAVAILABLE", {
    cause: error,
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function strictRecord(
  value: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError();
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort(compareText);
  const expected = [...fields].sort(compareText);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError();
  }
  return record;
}

export function parseRuntimeRefreshMember(input: {
  readonly memberKey: string;
  readonly runtimePlanDigest: string;
}): RuntimeRefreshTargetMember {
  if (!/^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$/u.test(input.memberKey)) {
    throw new RuntimeCompatibilityError("RUNTIME_COMPATIBILITY_INPUT_INVALID");
  }
  return Object.freeze({
    memberKey: input.memberKey,
    runtimePlanDigest: parseArtifactDigest(input.runtimePlanDigest),
  });
}
