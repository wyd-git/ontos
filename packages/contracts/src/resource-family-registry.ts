import {
  parseLinkTypeDefinition,
  parseObjectTypeDefinition,
  type LinkTypeDefinition,
  type ObjectTypeDefinition,
  type ResourceFamily,
} from "./metadata.ts";
import {
  parseMappingDefinition,
  parseSnapshotSchemaDefinition,
  type MappingDefinition,
  type SnapshotSchemaDefinition,
} from "./materialization.ts";
import { parsePolicyResourceDefinition, type PolicyResourceDefinition } from "./policy.ts";

export type PublishableResourceContent =
  | ObjectTypeDefinition
  | LinkTypeDefinition
  | MappingDefinition
  | SnapshotSchemaDefinition
  | PolicyResourceDefinition;

export type ResourceFamilyGate = "G2-01" | "G2-02" | "G2-03" | "G2-04" | "G2-05";
export type ResourceFamilyStatus = "active" | "deferred";

export interface ResourceFamilyRegistration {
  readonly family: ResourceFamily;
  readonly status: ResourceFamilyStatus;
  readonly freezeGate: ResourceFamilyGate;
  readonly parser?: (value: unknown) => PublishableResourceContent;
}

export type ResourceFamilyRegistryErrorCode = "CAPABILITY_NOT_ACTIVE" | "RESOURCE_FAMILY_UNKNOWN";

export class ResourceFamilyRegistryError extends Error {
  readonly code: ResourceFamilyRegistryErrorCode;
  readonly family: string;
  readonly freezeGate: ResourceFamilyGate | undefined;

  constructor(
    code: ResourceFamilyRegistryErrorCode,
    family: string,
    message: string,
    freezeGate?: ResourceFamilyGate,
  ) {
    super(message);
    this.name = "ResourceFamilyRegistryError";
    this.code = code;
    this.family = family;
    this.freezeGate = freezeGate;
  }
}

export const RESOURCE_FAMILY_REGISTRY: Readonly<
  Record<ResourceFamily, ResourceFamilyRegistration>
> = Object.freeze({
  object_type: Object.freeze({
    family: "object_type",
    status: "active",
    freezeGate: "G2-01",
    parser: parseObjectTypeDefinition,
  }),
  link_type: Object.freeze({
    family: "link_type",
    status: "active",
    freezeGate: "G2-01",
    parser: parseLinkTypeDefinition,
  }),
  interface: deferred("interface", "G2-05"),
  mapping: Object.freeze({
    family: "mapping",
    status: "active",
    freezeGate: "G2-02",
    parser: parseMappingDefinition,
  }),
  snapshot_schema: Object.freeze({
    family: "snapshot_schema",
    status: "active",
    freezeGate: "G2-02",
    parser: parseSnapshotSchemaDefinition,
  }),
  policy: Object.freeze({
    family: "policy",
    status: "active",
    freezeGate: "G2-03",
    parser: parsePolicyResourceDefinition,
  }),
  function_type: deferred("function_type", "G2-04"),
  action_type: deferred("action_type", "G2-04"),
  object_view: deferred("object_view", "G2-05"),
  application_config: deferred("application_config", "G2-05"),
});

export function parsePublishableResourceContent(
  family: string,
  value: unknown,
): PublishableResourceContent {
  const registration = (
    RESOURCE_FAMILY_REGISTRY as Readonly<Record<string, ResourceFamilyRegistration>>
  )[family];
  if (registration === undefined) {
    throw new ResourceFamilyRegistryError(
      "RESOURCE_FAMILY_UNKNOWN",
      family,
      "Resource family is not registered.",
    );
  }
  if (registration.status !== "active" || registration.parser === undefined) {
    throw new ResourceFamilyRegistryError(
      "CAPABILITY_NOT_ACTIVE",
      family,
      "Resource family cannot enter VALIDATED or READY in the current Gate.",
      registration.freezeGate,
    );
  }
  return registration.parser(value);
}

export function parseDirectResourceContent(
  family: string,
  value: unknown,
): PublishableResourceContent {
  return parsePublishableResourceContent(family, value);
}

export function parsePackageResourceContent(
  family: string,
  value: unknown,
): PublishableResourceContent {
  return parsePublishableResourceContent(family, value);
}

function deferred(
  family: ResourceFamily,
  freezeGate: ResourceFamilyGate,
): ResourceFamilyRegistration {
  return Object.freeze({ family, status: "deferred", freezeGate });
}
