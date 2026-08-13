import { localComposeFile, localComposeProject, localEnvironmentFile } from "./config.ts";

export type LocalComposeAction = "up" | "status" | "restart" | "stop" | "down" | "reset";

const managedServices = ["postgres", "s3", "oidc", "telemetry"] as const;

const composePrefix = [
  "compose",
  "--ansi",
  "never",
  "--project-name",
  localComposeProject,
  "--env-file",
  localEnvironmentFile,
  "--file",
  localComposeFile,
] as const;

export function composeArguments(action: LocalComposeAction): readonly string[] {
  switch (action) {
    case "up":
      return [...composePrefix, "up", "--detach", "--remove-orphans"];
    case "status":
      return [...composePrefix, "ps"];
    case "restart":
      return [...composePrefix, "restart", ...managedServices];
    case "stop":
      return [...composePrefix, "stop", ...managedServices];
    case "down":
      return [...composePrefix, "down", "--remove-orphans"];
    case "reset": {
      const plan = [...composePrefix, "down", "--volumes", "--remove-orphans"];
      assertProjectScopedReset(plan);
      return plan;
    }
  }
}

export function composeConfigArguments(): readonly string[] {
  return [...composePrefix, "config", "--quiet"];
}

export function assertProjectScopedReset(arguments_: readonly string[]): void {
  const expected = [...composePrefix, "down", "--volumes", "--remove-orphans"];
  if (JSON.stringify(arguments_) !== JSON.stringify(expected)) {
    throw new Error("Refusing a reset that is not exactly scoped to the ontos-g2-local project.");
  }
}

export function parseAction(candidate: string | undefined): LocalComposeAction {
  if (
    candidate === "up" ||
    candidate === "status" ||
    candidate === "restart" ||
    candidate === "stop" ||
    candidate === "down" ||
    candidate === "reset"
  ) {
    return candidate;
  }
  throw new Error("Expected one of: up, status, restart, stop, down, reset.");
}
