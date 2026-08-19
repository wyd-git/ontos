import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseArtifactDigest } from "@ontos/contracts";
import {
  MATERIALIZATION_WORKER_STAGES,
  MaterializationStageError,
  MaterializationWorker,
  MaterializationWorkerError,
  ProductionMaterializationStageExecutor,
  type ClaimedMaterializationJob,
  type MaterializationBaseService,
  type MaterializationFailure,
  type MaterializationJobCheckpoint,
  type MaterializationJobControl,
  type MaterializationJobRepository,
  type MaterializationJobState,
  type MaterializationLeaseRuntime,
  type MaterializationQualityService,
  type MaterializationStageExecution,
  type MaterializationStageResult,
  type ProductionMaterializationObjectStore,
  type ProductionMaterializationPipelineRepository,
  type ProjectionCapacityAdmissionService,
} from "@ontos/materialization-application";

const projectId = id(1);
const jobId = id(2);
const snapshotGroupId = id(3);
const workerInstanceId = id(4);

void test("runs all eight stages in order and commits the final digest", async () => {
  const repository = new FakeRepository();
  const executions: MaterializationStageExecution[] = [];
  const worker = createWorker(repository, (execution) => {
    executions.push(execution);
    return Promise.resolve(stageResult(execution.sequence));
  });

  assert.deepEqual(await worker.processNext(new AbortController().signal), {
    kind: "succeeded",
    jobId,
  });
  assert.deepEqual(
    executions.map(({ stage }) => stage),
    MATERIALIZATION_WORKER_STAGES,
  );
  assert.deepEqual(
    repository.completed.map(({ sequence }) => sequence),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(repository.succeededDigest, digest("stage-8"));
});

void test("resumes after the last complete checkpoint instead of replaying prior stages", async () => {
  const repository = new FakeRepository(checkpoint(2));
  const executed: string[] = [];
  const worker = createWorker(repository, (execution) => {
    executed.push(execution.stage);
    assert.equal(execution.previousCheckpoint?.sequence, execution.sequence - 1);
    return Promise.resolve(stageResult(execution.sequence));
  });

  assert.equal((await worker.processNext(new AbortController().signal)).kind, "succeeded");
  assert.deepEqual(executed, [
    "validate",
    "build_stage",
    "build_index",
    "ready_for_activation",
    "catch_up",
    "activate",
  ]);
  assert.equal(repository.completed[0]?.sequence, 3);
});

void test("cancels only at a stage boundary without executing more work", async () => {
  const repository = new FakeRepository();
  repository.control = { state: "running", cancelRequested: true };
  let executed = false;
  const worker = createWorker(repository, () => {
    executed = true;
    return Promise.resolve(stageResult(1));
  });

  assert.deepEqual(await worker.processNext(new AbortController().signal), {
    kind: "cancelled",
    jobId,
  });
  assert.equal(executed, false);
  assert.equal(repository.cancelled, true);
});

void test("persists a controlled retryable failure and bounded redacted samples", async () => {
  const repository = new FakeRepository();
  const failure: MaterializationFailure = {
    code: "S3_TEMPORARILY_UNAVAILABLE",
    category: "dependency",
    retryable: true,
    fingerprint: digest("s3-failure"),
  };
  const worker = createWorker(repository, () => {
    throw new MaterializationStageError(failure, [
      {
        reasonCode: "DEPENDENCY_TIMEOUT",
        classification: "dependency",
        fingerprint: digest("sample"),
      },
    ]);
  });

  assert.deepEqual(await worker.processNext(new AbortController().signal), {
    kind: "retry_wait",
    jobId,
  });
  assert.equal(repository.failed?.failure.code, failure.code);
  assert.equal(repository.failed?.samples.length, 1);
});

void test("classifies transient transport and PostgreSQL interruptions as retryable dependencies", async () => {
  for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT", "08006", "57P01"]) {
    const failure = await productionScanFailure(
      Object.assign(new Error("redacted dependency interruption"), { code }),
    );
    assert.equal(failure.category, "dependency", code);
    assert.equal(failure.retryable, true, code);
  }

  assert.equal(
    (await productionScanFailure(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).code,
    "ECONNRESET",
  );
  assert.equal(
    (await productionScanFailure(Object.assign(new Error("postgres"), { code: "08006" }))).code,
    "POSTGRES_CONNECTION_INTERRUPTED",
  );
});

void test("keeps protocol and unknown production failures fail-closed", async () => {
  assert.deepEqual(
    await productionScanFailure(
      Object.assign(new Error("source changed"), { code: "SOURCE_OBJECT_VERSION_MISMATCH" }),
    ),
    {
      code: "SOURCE_OBJECT_VERSION_MISMATCH",
      category: "permanent",
      retryable: false,
    },
  );
  assert.deepEqual(await productionScanFailure(new Error("unknown")), {
    code: "PIPELINE_STAGE_FAILED",
    category: "permanent",
    retryable: false,
  });
  assert.deepEqual(
    await productionScanFailure(Object.assign(new Error("unknown"), { code: "08_NOT_SQLSTATE" })),
    {
      code: "PIPELINE_STAGE_FAILED",
      category: "permanent",
      retryable: false,
    },
  );
});

void test("does not retry a permanent input failure", async () => {
  const repository = new FakeRepository();
  const worker = createWorker(repository, () => {
    throw new MaterializationStageError({
      code: "SNAPSHOT_CONTRACT_INVALID",
      category: "permanent",
      retryable: false,
      fingerprint: digest("permanent"),
    });
  });

  assert.equal((await worker.processNext(new AbortController().signal)).kind, "dead_letter");
  assert.equal(repository.failed?.failure.retryable, false);
});

void test("turns graceful shutdown into a persisted retry after the current checkpoint", async () => {
  const repository = new FakeRepository();
  const controller = new AbortController();
  const worker = createWorker(repository, (execution) => {
    controller.abort();
    return Promise.resolve(stageResult(execution.sequence));
  });

  assert.equal((await worker.processNext(controller.signal)).kind, "retry_wait");
  assert.equal(repository.completed.length, 1);
  assert.equal(repository.failed?.failure.code, "WORKER_SHUTDOWN");
});

void test("returns fenced when the lease runtime loses ownership", async () => {
  const repository = new FakeRepository();
  const worker = createWorker(repository, () => Promise.resolve(stageResult(1)), {
    run() {
      throw new MaterializationWorkerError("JOB_FENCED");
    },
  });

  assert.deepEqual(await worker.processNext(new AbortController().signal), {
    kind: "fenced",
    jobId,
  });
});

void test("does not misclassify an internal heartbeat outage as graceful shutdown", async () => {
  const repository = new FakeRepository();
  const dependency = new MaterializationWorkerError("DEPENDENCY_UNAVAILABLE");
  const worker = createWorker(repository, () => Promise.resolve(stageResult(1)), {
    async run(input) {
      const controller = new AbortController();
      controller.abort(dependency);
      return await input.operation(controller.signal);
    },
  });

  await assert.rejects(worker.processNext(new AbortController().signal), dependency);
  assert.equal(repository.failed, undefined);
});

void test("rejects oversized error sample collections before repository persistence", () => {
  assert.throws(
    () =>
      new MaterializationStageError(
        {
          code: "VALIDATION_FAILED",
          category: "permanent",
          retryable: false,
          fingerprint: digest("failure"),
        },
        Array.from({ length: 51 }, () => ({
          reasonCode: "VALUE_INVALID",
          classification: "validation" as const,
          fingerprint: digest("sample"),
        })),
      ),
    (error: unknown) =>
      error instanceof MaterializationWorkerError && error.code === "WORKER_INPUT_INVALID",
  );
});

class FakeRepository implements MaterializationJobRepository {
  readonly completed: MaterializationJobCheckpoint[] = [];
  control: MaterializationJobControl = { state: "running", cancelRequested: false };
  cancelled = false;
  succeededDigest: string | null = null;
  failed: Parameters<MaterializationJobRepository["fail"]>[0] | undefined;
  readonly #initialCheckpoint: MaterializationJobCheckpoint | null;

  constructor(initialCheckpoint: MaterializationJobCheckpoint | null = null) {
    this.#initialCheckpoint = initialCheckpoint;
  }

  claimNext(
    input: Parameters<MaterializationJobRepository["claimNext"]>[0],
  ): Promise<ClaimedMaterializationJob> {
    return Promise.resolve({
      projectId,
      jobId,
      snapshotGroupId,
      groupVersion: 1,
      inputDigest: digest("input"),
      attemptNumber: 1,
      lease: {
        projectId,
        jobId,
        attemptId: input.attemptId,
        workerInstanceId: input.workerInstanceId,
        fencingToken: 1n,
      },
      latestCheckpoint: this.#initialCheckpoint,
    });
  }

  heartbeat(): Promise<void> {
    return Promise.resolve();
  }

  readControl(): Promise<MaterializationJobControl> {
    return Promise.resolve(this.control);
  }

  completeStage(
    input: Parameters<MaterializationJobRepository["completeStage"]>[0],
  ): Promise<MaterializationJobCheckpoint> {
    const complete = Object.freeze({
      checkpointId: input.checkpointId,
      sequence: input.sequence,
      stage: input.stage,
      outputReferenceId: input.result.outputReferenceId,
      outputDigest: input.result.outputDigest,
    });
    this.completed.push(complete);
    return Promise.resolve(complete);
  }

  succeed(input: Parameters<MaterializationJobRepository["succeed"]>[0]): Promise<void> {
    this.succeededDigest = input.resultDigest;
    return Promise.resolve();
  }

  fail(
    input: Parameters<MaterializationJobRepository["fail"]>[0],
  ): Promise<MaterializationJobState> {
    this.failed = input;
    return Promise.resolve(input.failure.retryable ? "retry_wait" : "dead_letter");
  }

  cancelAtSafePoint(): Promise<void> {
    this.cancelled = true;
    return Promise.resolve();
  }
}

function createWorker(
  repository: MaterializationJobRepository,
  execute: (input: MaterializationStageExecution) => Promise<MaterializationStageResult>,
  leaseRuntime: MaterializationLeaseRuntime = directLeaseRuntime,
): MaterializationWorker {
  let generated = 10;
  return new MaterializationWorker({
    workerInstanceId,
    repository,
    executor: { execute },
    leaseRuntime,
    crypto: { randomId: () => id(generated++) },
  });
}

const directLeaseRuntime: MaterializationLeaseRuntime = Object.freeze({
  run: async <T>(input: {
    readonly operation: (signal: AbortSignal) => Promise<T>;
    readonly signal: AbortSignal;
  }) => await input.operation(input.signal),
});

function checkpoint(sequence: number): MaterializationJobCheckpoint {
  const stage = MATERIALIZATION_WORKER_STAGES[sequence - 1];
  if (stage === undefined) throw new Error("Fixture stage is invalid.");
  return Object.freeze({
    checkpointId: id(100 + sequence),
    sequence,
    stage,
    ...stageResult(sequence),
  });
}

function stageResult(sequence: number): MaterializationStageResult {
  return Object.freeze({
    outputReferenceId: id(200 + sequence),
    outputDigest: digest(`stage-${String(sequence)}`),
  });
}

async function productionScanFailure(
  error: Error,
): Promise<Omit<MaterializationFailure, "fingerprint">> {
  const executor = new ProductionMaterializationStageExecutor({
    repository: {
      discoverMemberKeys: () => Promise.reject(error),
    } as unknown as ProductionMaterializationPipelineRepository,
    objectStore: {} as ProductionMaterializationObjectStore,
    base: {} as MaterializationBaseService,
    quality: {} as MaterializationQualityService,
    capacity: {} as ProjectionCapacityAdmissionService,
    scanPhysicalInventory: () => Promise.reject(new Error("not reached")),
    crypto: {
      randomId: () => id(999),
      digestCanonicalText: digest,
      createStreamingDigest: () => {
        throw new Error("not reached");
      },
    },
  });
  try {
    await executor.execute({
      job: {
        projectId,
        jobId,
        snapshotGroupId,
        groupVersion: 1,
        inputDigest: digest("input"),
        attemptNumber: 1,
        lease: {
          projectId,
          jobId,
          attemptId: id(998),
          workerInstanceId,
          fencingToken: 1n,
        },
        latestCheckpoint: null,
      },
      stage: "scan",
      sequence: 1,
      previousCheckpoint: null,
      signal: new AbortController().signal,
    });
  } catch (caught) {
    assert.ok(caught instanceof MaterializationStageError);
    return {
      code: caught.failure.code,
      category: caught.failure.category,
      retryable: caught.failure.retryable,
    };
  }
  throw new Error("Expected the production scan to fail.");
}

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function digest(value: string) {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}
