import type {
  MaterializationJobCheckpoint,
  MaterializationStageExecutor,
} from "@ontos/materialization-application";

import { loadMaterializationWorkerConfig } from "./config.ts";
import { startMaterializationWorker } from "./runtime.ts";

export async function runMaterializationWorkerProcess(
  executor: MaterializationStageExecutor,
  source: Readonly<Record<string, string | undefined>> = process.env,
  afterCheckpoint?: (checkpoint: MaterializationJobCheckpoint) => Promise<void>,
): Promise<void> {
  const runtime = await startMaterializationWorker(loadMaterializationWorkerConfig(source), {
    executor,
    ...(afterCheckpoint === undefined ? {} : { afterCheckpoint }),
    observe(event) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    },
  });
  process.stdout.write('{"kind":"ready"}\n');
  const close = (): void => {
    void runtime.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await runtime.done;
  } finally {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    await runtime.close();
  }
}
