import { createHash, randomUUID } from "node:crypto";

import { parseArtifactDigest, parseCanonicalInstant } from "@ontos/contracts";
import {
  MaterializationBaseService,
  MaterializationQualityService,
  ProductionMaterializationStageExecutor,
  ProjectionCapacityAdmissionService,
  type MaterializationBaseCrypto,
  type MaterializationQualityCrypto,
  type ProductionMaterializationPipelineCrypto,
} from "@ontos/materialization-application";
import {
  PostgresMaterializationBaseRepository,
  PostgresMaterializationQualityRepository,
  PostgresProductionMaterializationPipelineRepository,
  PostgresProjectionCapacityAdmissionRepository,
  scanAndRecordProjectPhysicalInventory,
} from "@ontos/materialization-postgres";
import { S3ManagedObjectStore } from "@ontos/object-store-s3";

import {
  loadProductionMaterializationWorkerConfig,
  type ProductionMaterializationWorkerConfig,
} from "./config.ts";
import { startMaterializationWorker, type RunningMaterializationWorker } from "./runtime.ts";

interface RunningProductionMaterializationWorker extends RunningMaterializationWorker {
  readonly objectStore: S3ManagedObjectStore;
}

export async function startProductionMaterializationWorker(
  config: ProductionMaterializationWorkerConfig,
): Promise<RunningProductionMaterializationWorker> {
  const objectStore = new S3ManagedObjectStore(config.objectStore);
  try {
    await objectStore.assertVersioningEnabled();
    const runtime = await startMaterializationWorker(config, {
      createExecutor: (pool) =>
        new ProductionMaterializationStageExecutor({
          repository: new PostgresProductionMaterializationPipelineRepository(pool),
          objectStore,
          base: new MaterializationBaseService({
            repository: new PostgresMaterializationBaseRepository(pool),
            crypto: nodeProductionCrypto,
          }),
          quality: new MaterializationQualityService({
            repository: new PostgresMaterializationQualityRepository(pool),
            overlays: productionZeroQualityOverlay,
            artifacts: objectStore,
            crypto: nodeProductionCrypto,
            clock: { now: canonicalNow },
          }),
          capacity: new ProjectionCapacityAdmissionService({
            repository: new PostgresProjectionCapacityAdmissionRepository(pool),
            crypto: nodeProductionCrypto,
          }),
          scanPhysicalInventory: (input) =>
            scanAndRecordProjectPhysicalInventory(pool, nodeProductionCrypto, input),
          crypto: nodeProductionCrypto,
        }),
      observe(event) {
        if (event.kind !== "job_result" || event.outcome !== "idle") {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        }
      },
    });
    let closing: Promise<void> | null = null;
    return Object.freeze({
      pool: runtime.pool,
      done: runtime.done,
      objectStore,
      close() {
        closing ??= runtime.close().finally(() => objectStore.destroy());
        return closing;
      },
    });
  } catch (error) {
    objectStore.destroy();
    throw error;
  }
}

export async function runProductionMaterializationWorkerProcess(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await startProductionMaterializationWorker(
    loadProductionMaterializationWorkerConfig(source),
  );
  process.stdout.write('{"kind":"ready","pipeline":"production"}\n');
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

const productionZeroQualityOverlay = Object.freeze({
  inspect: () => Promise.resolve(Object.freeze({ state: "known" as const, rowCount: 0 })),
});

const nodeProductionCrypto: MaterializationBaseCrypto &
  MaterializationQualityCrypto &
  ProductionMaterializationPipelineCrypto = Object.freeze({
  randomId: randomUUID,
  digestCanonicalText: (value: string) =>
    parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`),
  createStreamingDigest: () => {
    const hash = createHash("sha256");
    let finished = false;
    return {
      update(chunk: Uint8Array) {
        if (finished) throw new Error("Materialization digest has already finished.");
        hash.update(chunk);
      },
      finish() {
        if (finished) throw new Error("Materialization digest has already finished.");
        finished = true;
        return parseArtifactDigest(`sha256:${hash.digest("hex")}`);
      },
    };
  },
});

function canonicalNow(): ReturnType<typeof parseCanonicalInstant> {
  return parseCanonicalInstant(new Date().toISOString().replace(/\.([0-9]{3})Z$/u, ".$1000Z"));
}
