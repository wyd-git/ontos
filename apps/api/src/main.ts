import { pathToFileURL } from "node:url";

import { loadAdminApiConfig } from "./config.ts";
import { startAdminApi } from "./runtime.ts";

export async function runAdminApi(): Promise<void> {
  const runtime = await startAdminApi(loadAdminApiConfig());
  process.stdout.write(`Ontos Admin API listening on ${runtime.origin}\n`);
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void runtime
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await runAdminApi();
  } catch {
    process.stderr.write("Ontos Admin API failed to start.\n");
    process.exitCode = 1;
  }
}
