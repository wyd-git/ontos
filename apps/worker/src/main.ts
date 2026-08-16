import { pathToFileURL } from "node:url";

// G2-02-08 owns the durable process and recovery protocol; G2-02-09 through
// G2-02-11 own the production stage use cases. G2-02-13 owns their final
// process composition with Admin HTTP and the unified integration gate.
// Starting an empty pipeline would incorrectly mark data as materialized, so
// this entrypoint remains fail-closed until that composition exists.
export function reportUncomposedWorker(): void {
  process.stderr.write(
    "Ontos Worker stage pipeline is not composed; complete G2-02-13 production composition before start.\n",
  );
  process.exitCode = 78;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  reportUncomposedWorker();
}
