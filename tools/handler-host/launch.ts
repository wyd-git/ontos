import { fork, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const handlerHostDirectory = dirname(fileURLToPath(import.meta.url));
const hostEntryPath = fileURLToPath(new URL("./host-entry.ts", import.meta.url));
const rootPackagePath = fileURLToPath(new URL("../../package.json", import.meta.url));

export function buildHandlerHostEnvironment(): NodeJS.ProcessEnv {
  return {
    LANG: "C",
    LC_ALL: "C",
    ONTOS_HANDLER_HOST_PROTOCOL: "1",
    TZ: "UTC",
  };
}

export function launchHandlerHost(): ChildProcess {
  return fork(hostEntryPath, [], {
    cwd: handlerHostDirectory,
    detached: false,
    env: buildHandlerHostEnvironment(),
    execArgv: [
      "--permission",
      `--allow-fs-read=${handlerHostDirectory}`,
      `--allow-fs-read=${rootPackagePath}`,
    ],
    serialization: "json",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}
