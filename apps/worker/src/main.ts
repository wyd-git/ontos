import { pathToFileURL } from "node:url";

import { runProductionMaterializationWorkerProcess } from "./production.ts";

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await runProductionMaterializationWorkerProcess();
  } catch {
    process.stderr.write("Ontos production Materialization Worker failed to start.\n");
    process.exitCode = 1;
  }
}
