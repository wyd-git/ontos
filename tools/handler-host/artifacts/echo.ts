import type { ArtifactHandler } from "../artifact-api.ts";

export const invoke: ArtifactHandler = (_context, parameters) => ({
  message: parameters.message ?? null,
});
