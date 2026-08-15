import { createHash } from "node:crypto";

import { parseArtifactDigest } from "@ontos/contracts";
import {
  MATERIALIZATION_WORKER_STAGES,
  MaterializationStageError,
  type MaterializationJobCheckpoint,
  type MaterializationStageExecution,
  type MaterializationStageExecutor,
  type MaterializationWorkerStage,
} from "@ontos/materialization-application";

import { runMaterializationWorkerProcess } from "../../apps/worker/src/process.ts";

const pauseStage = optionalStage(process.env["ONTOS_WORKER_FIXTURE_PAUSE_STAGE"]);
const pausePosition = process.env["ONTOS_WORKER_FIXTURE_PAUSE_POSITION"];
const pauseMilliseconds = optionalPositiveInteger(
  process.env["ONTOS_WORKER_FIXTURE_PAUSE_MILLISECONDS"],
);
const failStage = optionalStage(process.env["ONTOS_WORKER_FIXTURE_FAIL_STAGE"]);
const failCategory = process.env["ONTOS_WORKER_FIXTURE_FAIL_CATEGORY"] ?? "dependency";
const fixtureShutdown = new AbortController();
process.once("SIGINT", () => fixtureShutdown.abort());
process.once("SIGTERM", () => fixtureShutdown.abort());

const executor: MaterializationStageExecutor = Object.freeze({
  async execute(input: MaterializationStageExecution) {
    writeEvent("stage_before", input.stage, input.sequence);
    if (pauseStage === input.stage && pausePosition === "before") {
      await pause(input.signal);
    }
    if (failStage === input.stage) {
      const permanent = failCategory === "permanent";
      throw new MaterializationStageError(
        {
          code: permanent ? "SNAPSHOT_CONTRACT_INVALID" : "S3_TEMPORARILY_UNAVAILABLE",
          category: permanent ? "permanent" : "dependency",
          retryable: !permanent,
          fingerprint: digest(`failure:${failCategory}:${input.stage}`),
        },
        [
          {
            reasonCode: permanent ? "CONTRACT_INVALID" : "DEPENDENCY_TIMEOUT",
            classification: permanent ? "validation" : "dependency",
            fingerprint: digest(`sample:${failCategory}:${input.stage}`),
          },
        ],
      );
    }
    const previousDigest = input.previousCheckpoint?.outputDigest ?? input.job.inputDigest;
    return Object.freeze({
      outputReferenceId: deterministicId(`${input.job.jobId}:${input.stage}`),
      outputDigest: digest(`${previousDigest}:${input.stage}`),
    });
  },
});

async function afterCheckpoint(checkpoint: MaterializationJobCheckpoint): Promise<void> {
  writeEvent("checkpoint_committed", checkpoint.stage, checkpoint.sequence);
  if (pauseStage === checkpoint.stage && pausePosition === "after") {
    await pause(fixtureShutdown.signal);
  }
}

async function pause(signal: AbortSignal): Promise<void> {
  if (pauseMilliseconds !== null) {
    await new Promise<void>((resolvePause, rejectPause) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolvePause();
      }, pauseMilliseconds);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        rejectPause(new Error("Fixture stage was aborted."));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return;
  }
  await new Promise<never>((_resolve, rejectPause) => {
    signal.addEventListener("abort", () => rejectPause(new Error("Fixture stage was aborted.")), {
      once: true,
    });
  });
}

function optionalStage(value: string | undefined): MaterializationWorkerStage | null {
  if (value === undefined || value.length === 0) return null;
  if (!MATERIALIZATION_WORKER_STAGES.includes(value as MaterializationWorkerStage)) {
    throw new Error("Fixture stage is invalid.");
  }
  return value as MaterializationWorkerStage;
}

function optionalPositiveInteger(value: string | undefined): number | null {
  if (value === undefined || value.length === 0) return null;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error("Fixture pause is invalid.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 60_000) {
    throw new Error("Fixture pause is invalid.");
  }
  return parsed;
}

function deterministicId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function digest(value: string) {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function writeEvent(kind: string, stage: MaterializationWorkerStage, sequence: number): void {
  process.stdout.write(`${JSON.stringify({ kind, stage, sequence })}\n`);
}

try {
  await runMaterializationWorkerProcess(executor, process.env, afterCheckpoint);
} catch {
  process.stderr.write("Ontos Worker fixture process failed.\n");
  process.exitCode = 1;
}
