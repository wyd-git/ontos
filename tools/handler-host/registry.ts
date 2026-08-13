import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  ArtifactContractError,
  getRegisteredArtifact,
  type RegisteredArtifact,
} from "./catalog.ts";
import type { ArtifactModule } from "./artifact-api.ts";

const moduleCache = new Map<string, Promise<ArtifactModule>>();

export class ArtifactDigestMismatchError extends Error {
  readonly code = "ARTIFACT_DIGEST_MISMATCH" as const;

  constructor() {
    super("Registered Artifact bytes do not match the expected Digest.");
    this.name = "ArtifactDigestMismatchError";
  }
}

export async function loadRegisteredArtifact(
  digest: string,
): Promise<{ readonly registration: RegisteredArtifact; readonly module: ArtifactModule }> {
  const registration = getRegisteredArtifact(digest);
  if (registration === undefined) {
    throw new ArtifactContractError(
      "ARTIFACT_NOT_REGISTERED",
      "The requested Artifact Digest is not registered in this Host release.",
    );
  }
  let modulePromise = moduleCache.get(digest);
  if (modulePromise === undefined) {
    modulePromise = verifyAndImport(registration);
    moduleCache.set(digest, modulePromise);
  }
  try {
    return { registration, module: await modulePromise };
  } catch (error) {
    moduleCache.delete(digest);
    throw error;
  }
}

async function verifyAndImport(registration: RegisteredArtifact): Promise<ArtifactModule> {
  const sourceUrl = new URL(registration.sourceUrl);
  const bytes = await readFile(sourceUrl);
  const actualDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actualDigest !== registration.digest) throw new ArtifactDigestMismatchError();
  const candidate: unknown = await import(registration.sourceUrl);
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("invoke" in candidate) ||
    typeof candidate.invoke !== "function"
  ) {
    throw new ArtifactDigestMismatchError();
  }
  return candidate as ArtifactModule;
}
