import { parseArtifactDigest, parseOntosId, type ArtifactDigest } from "@ontos/contracts";

export const MATERIALIZATION_WORKER_STAGES = Object.freeze([
  "scan",
  "map",
  "validate",
  "build_stage",
  "build_index",
  "ready_for_activation",
  "catch_up",
  "activate",
] as const);

export type MaterializationWorkerStage = (typeof MATERIALIZATION_WORKER_STAGES)[number];

export type MaterializationJobState =
  "queued" | "running" | "retry_wait" | "succeeded" | "dead_letter" | "cancelled";

export type MaterializationFailureCategory =
  "dependency" | "internal" | "lease" | "permanent" | "throttled";

export type MaterializationWorkerErrorCode =
  | "DEPENDENCY_UNAVAILABLE"
  | "JOB_FENCED"
  | "JOB_NOT_CANCELLABLE"
  | "JOB_PROTOCOL_CONFLICT"
  | "WORKER_INPUT_INVALID";

const workerErrorMessages = Object.freeze({
  DEPENDENCY_UNAVAILABLE: "A materialization Worker dependency is temporarily unavailable.",
  JOB_FENCED: "The materialization Job lease is no longer owned by this Worker.",
  JOB_NOT_CANCELLABLE: "The materialization Job has entered its non-cancellable cutover boundary.",
  JOB_PROTOCOL_CONFLICT: "The persisted materialization Job protocol conflicts with this Worker.",
  WORKER_INPUT_INVALID: "The materialization Worker input is invalid.",
} satisfies Readonly<Record<MaterializationWorkerErrorCode, string>>);

export class MaterializationWorkerError extends Error {
  readonly code: MaterializationWorkerErrorCode;

  constructor(code: MaterializationWorkerErrorCode, options?: ErrorOptions) {
    super(workerErrorMessages[code], options);
    this.name = "MaterializationWorkerError";
    this.code = code;
  }
}

export interface MaterializationLease {
  readonly projectId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly workerInstanceId: string;
  readonly fencingToken: bigint;
}

export interface MaterializationJobCheckpoint {
  readonly checkpointId: string;
  readonly sequence: number;
  readonly stage: MaterializationWorkerStage;
  readonly outputReferenceId: string;
  readonly outputDigest: ArtifactDigest;
}

export interface ClaimedMaterializationJob {
  readonly projectId: string;
  readonly jobId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
  readonly inputDigest: ArtifactDigest;
  readonly attemptNumber: number;
  readonly lease: MaterializationLease;
  readonly latestCheckpoint: MaterializationJobCheckpoint | null;
}

export interface MaterializationJobControl {
  readonly cancelRequested: boolean;
  readonly state: MaterializationJobState;
}

export interface MaterializationFailure {
  readonly code: string;
  readonly category: MaterializationFailureCategory;
  readonly retryable: boolean;
  readonly fingerprint: ArtifactDigest;
}

export interface MaterializationErrorSample {
  readonly reasonCode: string;
  readonly classification: "dependency" | "internal" | "lease" | "validation";
  readonly fingerprint: ArtifactDigest;
}

export interface MaterializationStageResult {
  readonly outputReferenceId: string;
  readonly outputDigest: ArtifactDigest;
}

export interface MaterializationJobRepository {
  claimNext(input: {
    readonly workerInstanceId: string;
    readonly attemptId: string;
    readonly leaseSeconds: number;
  }): Promise<ClaimedMaterializationJob | null>;
  heartbeat(input: {
    readonly lease: MaterializationLease;
    readonly leaseSeconds: number;
  }): Promise<void>;
  readControl(lease: MaterializationLease): Promise<MaterializationJobControl>;
  completeStage(input: {
    readonly lease: MaterializationLease;
    readonly checkpointId: string;
    readonly sequence: number;
    readonly stage: MaterializationWorkerStage;
    readonly result: MaterializationStageResult;
  }): Promise<MaterializationJobCheckpoint>;
  succeed(input: {
    readonly lease: MaterializationLease;
    readonly resultDigest: ArtifactDigest;
  }): Promise<void>;
  fail(input: {
    readonly lease: MaterializationLease;
    readonly failure: MaterializationFailure;
    readonly samples: readonly MaterializationErrorSample[];
  }): Promise<MaterializationJobState>;
  cancelAtSafePoint(lease: MaterializationLease): Promise<void>;
}

export interface MaterializationStageExecution {
  readonly job: ClaimedMaterializationJob;
  readonly stage: MaterializationWorkerStage;
  readonly sequence: number;
  readonly previousCheckpoint: MaterializationJobCheckpoint | null;
  readonly signal: AbortSignal;
}

export interface MaterializationStageExecutor {
  execute(input: MaterializationStageExecution): Promise<MaterializationStageResult>;
}

export interface MaterializationLeaseRuntime {
  run<T>(input: {
    readonly signal: AbortSignal;
    readonly heartbeat: () => Promise<void>;
    readonly operation: (signal: AbortSignal) => Promise<T>;
  }): Promise<T>;
}

export interface MaterializationWorkerCrypto {
  randomId(): string;
}

export interface MaterializationWorkerOptions {
  readonly workerInstanceId: string;
  readonly leaseSeconds?: number;
  readonly repository: MaterializationJobRepository;
  readonly executor: MaterializationStageExecutor;
  readonly leaseRuntime: MaterializationLeaseRuntime;
  readonly crypto: MaterializationWorkerCrypto;
  readonly afterCheckpoint?: (checkpoint: MaterializationJobCheckpoint) => Promise<void>;
}

export type MaterializationWorkerRunResult =
  | { readonly kind: "idle" }
  | { readonly kind: "stopped" }
  | {
      readonly kind: "cancelled" | "dead_letter" | "fenced" | "retry_wait" | "succeeded";
      readonly jobId: string;
    };

export class MaterializationStageError extends Error {
  readonly failure: MaterializationFailure;
  readonly samples: readonly MaterializationErrorSample[];

  constructor(
    failure: MaterializationFailure,
    samples: readonly MaterializationErrorSample[] = [],
    options?: ErrorOptions,
  ) {
    super("The materialization stage failed with a controlled classification.", options);
    this.name = "MaterializationStageError";
    this.failure = parseFailure(failure);
    this.samples = parseSamples(samples);
  }
}

export class MaterializationWorker {
  readonly #workerInstanceId: string;
  readonly #leaseSeconds: number;
  readonly #repository: MaterializationJobRepository;
  readonly #executor: MaterializationStageExecutor;
  readonly #leaseRuntime: MaterializationLeaseRuntime;
  readonly #crypto: MaterializationWorkerCrypto;
  readonly #afterCheckpoint:
    ((checkpoint: MaterializationJobCheckpoint) => Promise<void>) | undefined;

  constructor(options: MaterializationWorkerOptions) {
    this.#workerInstanceId = parseOntosId(options.workerInstanceId, "$workerInstanceId");
    this.#leaseSeconds = parseLeaseSeconds(options.leaseSeconds ?? 30);
    this.#repository = options.repository;
    this.#executor = options.executor;
    this.#leaseRuntime = options.leaseRuntime;
    this.#crypto = options.crypto;
    this.#afterCheckpoint = options.afterCheckpoint;
  }

  async processNext(signal: AbortSignal): Promise<MaterializationWorkerRunResult> {
    if (signal.aborted) return Object.freeze({ kind: "stopped" });
    const attemptId = parseOntosId(this.#crypto.randomId(), "$attemptId");
    const claimed = await this.#repository.claimNext({
      workerInstanceId: this.#workerInstanceId,
      attemptId,
      leaseSeconds: this.#leaseSeconds,
    });
    if (claimed === null) return Object.freeze({ kind: "idle" });
    const job = parseClaim(claimed, this.#workerInstanceId);
    try {
      return await this.#leaseRuntime.run({
        signal,
        heartbeat: () =>
          this.#repository.heartbeat({ lease: job.lease, leaseSeconds: this.#leaseSeconds }),
        operation: (leaseSignal) => this.#processClaim(job, leaseSignal),
      });
    } catch (error) {
      if (isFenced(error)) return Object.freeze({ kind: "fenced", jobId: job.jobId });
      throw error;
    }
  }

  async #processClaim(
    job: ClaimedMaterializationJob,
    signal: AbortSignal,
  ): Promise<MaterializationWorkerRunResult> {
    let latest = job.latestCheckpoint;
    if (latest?.stage === "activate") {
      await this.#repository.succeed({ lease: job.lease, resultDigest: latest.outputDigest });
      return Object.freeze({ kind: "succeeded", jobId: job.jobId });
    }

    for (
      let index = latest?.sequence ?? 0;
      index < MATERIALIZATION_WORKER_STAGES.length;
      index += 1
    ) {
      const stage = MATERIALIZATION_WORKER_STAGES[index];
      if (stage === undefined) throw new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT");
      const control = await this.#repository.readControl(job.lease);
      if (control.state !== "running") throw new MaterializationWorkerError("JOB_FENCED");
      if (control.cancelRequested) {
        await this.#repository.cancelAtSafePoint(job.lease);
        return Object.freeze({ kind: "cancelled", jobId: job.jobId });
      }
      if (signal.aborted) {
        throwLeaseAbort(signal);
        return await this.#releaseForShutdown(job.lease, job.jobId);
      }

      let result: MaterializationStageResult;
      try {
        result = parseStageResult(
          await this.#executor.execute({
            job,
            stage,
            sequence: index + 1,
            previousCheckpoint: latest,
            signal,
          }),
        );
      } catch (error) {
        if (signal.aborted) {
          throwLeaseAbort(signal);
          return await this.#releaseForShutdown(job.lease, job.jobId);
        }
        return await this.#recordFailure(job.lease, job.jobId, error);
      }

      latest = await this.#repository.completeStage({
        lease: job.lease,
        checkpointId: parseOntosId(this.#crypto.randomId(), "$checkpointId"),
        sequence: index + 1,
        stage,
        result,
      });
      await this.#afterCheckpoint?.(latest);
      if (signal.aborted && stage !== "activate") {
        throwLeaseAbort(signal);
        return await this.#releaseForShutdown(job.lease, job.jobId);
      }
    }

    if (latest?.stage !== "activate") {
      throw new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT");
    }
    await this.#repository.succeed({ lease: job.lease, resultDigest: latest.outputDigest });
    return Object.freeze({ kind: "succeeded", jobId: job.jobId });
  }

  async #recordFailure(
    lease: MaterializationLease,
    jobId: string,
    error: unknown,
  ): Promise<MaterializationWorkerRunResult> {
    const controlled =
      error instanceof MaterializationStageError
        ? error
        : new MaterializationStageError({
            code: "WORKER_INTERNAL_ERROR",
            category: "internal",
            retryable: true,
            fingerprint: parseArtifactDigest(
              "sha256:778952611601930186749a0608688d4a6c47a390321395398b936075433614fa",
            ),
          });
    const state = await this.#repository.fail({
      lease,
      failure: controlled.failure,
      samples: controlled.samples,
    });
    if (state !== "retry_wait" && state !== "dead_letter") {
      throw new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT");
    }
    return Object.freeze({ kind: state, jobId });
  }

  async #releaseForShutdown(
    lease: MaterializationLease,
    jobId: string,
  ): Promise<MaterializationWorkerRunResult> {
    const state = await this.#repository.fail({
      lease,
      failure: {
        code: "WORKER_SHUTDOWN",
        category: "internal",
        retryable: true,
        fingerprint: parseArtifactDigest(
          "sha256:0ac63c1d743640949796a3b4e6c676b81306d63a7f254165b225dbaa5e2cbc18",
        ),
      },
      samples: [],
    });
    if (state !== "retry_wait" && state !== "dead_letter") {
      throw new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT");
    }
    return Object.freeze({ kind: state, jobId });
  }
}

export function materializationStageRank(stage: MaterializationWorkerStage): number {
  return MATERIALIZATION_WORKER_STAGES.indexOf(stage) + 1;
}

function parseClaim(
  value: ClaimedMaterializationJob,
  workerInstanceId: string,
): ClaimedMaterializationJob {
  const projectId = parseOntosId(value.projectId, "$claim.projectId");
  const jobId = parseOntosId(value.jobId, "$claim.jobId");
  const snapshotGroupId = parseOntosId(value.snapshotGroupId, "$claim.snapshotGroupId");
  const groupVersion = parsePositiveSafeInteger(value.groupVersion);
  const attemptNumber = parsePositiveSafeInteger(value.attemptNumber);
  const lease = parseLease(value.lease, projectId, jobId, workerInstanceId);
  const latestCheckpoint =
    value.latestCheckpoint === null ? null : parseCheckpoint(value.latestCheckpoint);
  if (
    latestCheckpoint !== null &&
    (latestCheckpoint.sequence > MATERIALIZATION_WORKER_STAGES.length ||
      materializationStageRank(latestCheckpoint.stage) !== latestCheckpoint.sequence)
  ) {
    throw new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT");
  }
  return Object.freeze({
    projectId,
    jobId,
    snapshotGroupId,
    groupVersion,
    inputDigest: parseArtifactDigest(value.inputDigest),
    attemptNumber,
    lease,
    latestCheckpoint,
  });
}

function parseLease(
  value: MaterializationLease,
  projectId: string,
  jobId: string,
  workerInstanceId: string,
): MaterializationLease {
  if (
    value.projectId !== projectId ||
    value.jobId !== jobId ||
    value.workerInstanceId !== workerInstanceId ||
    typeof value.fencingToken !== "bigint" ||
    value.fencingToken < 1n
  ) {
    throw new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT");
  }
  return Object.freeze({
    projectId,
    jobId,
    attemptId: parseOntosId(value.attemptId, "$claim.lease.attemptId"),
    workerInstanceId,
    fencingToken: value.fencingToken,
  });
}

function parseCheckpoint(value: MaterializationJobCheckpoint): MaterializationJobCheckpoint {
  if (!MATERIALIZATION_WORKER_STAGES.includes(value.stage)) {
    throw new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT");
  }
  return Object.freeze({
    checkpointId: parseOntosId(value.checkpointId, "$checkpoint.checkpointId"),
    sequence: parsePositiveSafeInteger(value.sequence),
    stage: value.stage,
    outputReferenceId: parseOntosId(value.outputReferenceId, "$checkpoint.outputReferenceId"),
    outputDigest: parseArtifactDigest(value.outputDigest),
  });
}

function parseStageResult(value: MaterializationStageResult): MaterializationStageResult {
  return Object.freeze({
    outputReferenceId: parseOntosId(value.outputReferenceId, "$stage.outputReferenceId"),
    outputDigest: parseArtifactDigest(value.outputDigest),
  });
}

function parseFailure(value: MaterializationFailure): MaterializationFailure {
  if (
    !/^[A-Z][A-Z0-9_]{1,63}$/u.test(value.code) ||
    !["dependency", "internal", "lease", "permanent", "throttled"].includes(value.category) ||
    (value.category === "permanent" && value.retryable)
  ) {
    throw new MaterializationWorkerError("WORKER_INPUT_INVALID");
  }
  return Object.freeze({
    code: value.code,
    category: value.category,
    retryable: value.retryable,
    fingerprint: parseArtifactDigest(value.fingerprint),
  });
}

function parseSamples(
  samples: readonly MaterializationErrorSample[],
): readonly MaterializationErrorSample[] {
  if (samples.length > 50) throw new MaterializationWorkerError("WORKER_INPUT_INVALID");
  return Object.freeze(
    samples.map((sample) => {
      if (
        !/^[A-Z][A-Z0-9_]{1,63}$/u.test(sample.reasonCode) ||
        !["dependency", "internal", "lease", "validation"].includes(sample.classification)
      ) {
        throw new MaterializationWorkerError("WORKER_INPUT_INVALID");
      }
      return Object.freeze({
        reasonCode: sample.reasonCode,
        classification: sample.classification,
        fingerprint: parseArtifactDigest(sample.fingerprint),
      });
    }),
  );
}

function parseLeaseSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300) {
    throw new MaterializationWorkerError("WORKER_INPUT_INVALID");
  }
  return value;
}

function parsePositiveSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MaterializationWorkerError("JOB_PROTOCOL_CONFLICT");
  }
  return value;
}

function isFenced(error: unknown): boolean {
  return error instanceof MaterializationWorkerError && error.code === "JOB_FENCED";
}

function throwLeaseAbort(signal: AbortSignal): void {
  const reason: unknown = signal.reason;
  if (
    reason instanceof MaterializationWorkerError &&
    (reason.code === "JOB_FENCED" || reason.code === "DEPENDENCY_UNAVAILABLE")
  ) {
    throw reason;
  }
}
