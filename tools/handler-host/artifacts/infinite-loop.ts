import type { ArtifactHandler } from "../artifact-api.ts";

export const invoke: ArtifactHandler = () => {
  for (;;) {
    // The parent process must enforce the deadline; this Artifact never cooperates.
  }
};
