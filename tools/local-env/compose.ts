import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertLocalComposeConfiguration,
  loadLocalEnvironmentConfig,
  localComposeProject,
} from "./config.ts";
import {
  composeArguments,
  composeConfigArguments,
  parseAction,
  type LocalComposeAction,
} from "./compose-plan.ts";
import { assertEnvironmentHealthy, waitForEnvironment } from "./health.ts";

export async function runLocalComposeAction(action: LocalComposeAction): Promise<void> {
  const config = await loadLocalEnvironmentConfig();
  assertLocalComposeConfiguration(config);
  await runDocker(composeConfigArguments());

  switch (action) {
    case "up":
      await runDocker(composeArguments(action));
      await waitForEnvironment(config);
      process.stdout.write("Local production-boundary dependencies are ready.\n");
      return;
    case "status":
      await runDocker(composeArguments(action));
      await assertEnvironmentHealthy(config);
      return;
    case "restart":
      await runDocker(composeArguments(action));
      await waitForEnvironment(config);
      process.stdout.write("Persistent local dependencies restarted with volumes preserved.\n");
      return;
    case "stop":
      await runDocker(composeArguments(action));
      process.stdout.write("Local dependencies stopped; project volumes remain.\n");
      return;
    case "down":
      await runDocker(composeArguments(action));
      process.stdout.write("Local containers and network removed; project volumes remain.\n");
      return;
    case "reset":
      await runDocker(composeArguments(action));
      process.stdout.write(
        `Removed containers, network, and only volumes owned by Compose project ${localComposeProject}.\n`,
      );
      return;
  }
}

function runDocker(arguments_: readonly string[]): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("docker", [...arguments_], { stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `docker ${arguments_.join(" ")} failed with ${signal === null ? `exit code ${String(code)}` : `signal ${signal}`}.`,
        ),
      );
    });
  });
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    await runLocalComposeAction(parseAction(process.argv[2]));
  } catch (error) {
    process.stderr.write(`Local environment command failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
