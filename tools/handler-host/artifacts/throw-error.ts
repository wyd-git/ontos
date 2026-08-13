import type { ArtifactHandler } from "../artifact-api.ts";

export const invoke: ArtifactHandler = () => {
  throw new Error("RAW-HANDLER-SECRET must never cross the RPC boundary");
};
