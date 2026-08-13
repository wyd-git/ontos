import { requireObjectShape, requirePlainRecord } from "./internal.ts";
import {
  parseArtifactDigest,
  parseOntosId,
  parseSchemaVersion,
  type ArtifactDigest,
  type ContractSchemaVersion,
  type OntosId,
} from "./scalars.ts";

export interface ReleaseBinding {
  readonly schemaVersion: ContractSchemaVersion;
  readonly projectId: OntosId;
  readonly releaseId: OntosId;
  readonly releaseRevisionId: OntosId;
  readonly activationId: OntosId;
  readonly manifestDigest: ArtifactDigest;
}

export const RELEASE_BINDING_FIELDS = Object.freeze([
  "schemaVersion",
  "projectId",
  "releaseId",
  "releaseRevisionId",
  "activationId",
  "manifestDigest",
] as const);

export function parseReleaseBinding(value: unknown): ReleaseBinding {
  const record = requirePlainRecord(value, "$releaseBinding");
  requireObjectShape(record, RELEASE_BINDING_FIELDS, RELEASE_BINDING_FIELDS, "$releaseBinding");
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, "$releaseBinding.schemaVersion"),
    projectId: parseOntosId(record.projectId, "$releaseBinding.projectId"),
    releaseId: parseOntosId(record.releaseId, "$releaseBinding.releaseId"),
    releaseRevisionId: parseOntosId(record.releaseRevisionId, "$releaseBinding.releaseRevisionId"),
    activationId: parseOntosId(record.activationId, "$releaseBinding.activationId"),
    manifestDigest: parseArtifactDigest(record.manifestDigest, "$releaseBinding.manifestDigest"),
  });
}
