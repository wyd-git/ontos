import {
  API_NAME_PATTERN,
  NAMESPACE_PATTERN,
  MANAGEMENT_ROLE_VALUES,
  RESOURCE_FAMILY_VALUES,
  canonicalizeContractForDigest,
  parseDirectResourceContent,
  type LinkTypeDefinition,
  type ManagementRoleValue,
  type ObjectTypeDefinition,
  type ResourceFamily,
} from "@ontos/contracts";

export type ManagementRole = ManagementRoleValue;

export const MANAGEMENT_PERMISSIONS = Object.freeze([
  "metadata.read",
  "metadata.edit",
  "release.publish",
  "package.manage",
  "role.manage",
] as const);

export type ManagementPermission = (typeof MANAGEMENT_PERMISSIONS)[number];

export type MetadataDomainErrorCode = "INVALID_INPUT" | "INVALID_STATE";

export class MetadataDomainError extends Error {
  readonly code: MetadataDomainErrorCode;

  constructor(code: MetadataDomainErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MetadataDomainError";
    this.code = code;
  }
}

export interface ManagementRoleSnapshot {
  readonly projectRole: ManagementRole | null;
  readonly resourceRole: ManagementRole | null;
}

const apiNameExpression = new RegExp(API_NAME_PATTERN, "u");
const namespaceExpression = new RegExp(NAMESPACE_PATTERN, "u");
const roles = new Set<ManagementRole>(MANAGEMENT_ROLE_VALUES);
const resourceFamilies = new Set<ResourceFamily>(RESOURCE_FAMILY_VALUES);
const childDraftSourceStates = new Set<ResourceRevisionState>([
  "validated",
  "published",
  "deprecated",
]);
const permissions = new Set<ManagementPermission>(MANAGEMENT_PERMISSIONS);
const grants: Readonly<Record<ManagementRole, ReadonlySet<ManagementPermission>>> = Object.freeze({
  owner: new Set<ManagementPermission>(MANAGEMENT_PERMISSIONS),
  editor: new Set<ManagementPermission>(["metadata.read", "metadata.edit"]),
  viewer: new Set<ManagementPermission>(["metadata.read"]),
  executor: new Set<ManagementPermission>(),
  auditor: new Set<ManagementPermission>(),
});

export function validateProjectApiName(value: unknown): string {
  if (typeof value !== "string" || !apiNameExpression.test(value)) {
    throw new MetadataDomainError("INVALID_INPUT", "Project apiName is invalid.");
  }
  return value;
}

export type ResourceState = "active" | "deprecated" | "archived";
export type ResourceRevisionState = "draft" | "validated" | "published" | "deprecated" | "archived";
export type DirectResourceContent = ObjectTypeDefinition | LinkTypeDefinition;

export interface PreparedResourceContent {
  readonly content: DirectResourceContent;
  readonly canonicalContent: string;
}

export function validateResourceNamespace(value: unknown): string {
  if (typeof value !== "string" || !namespaceExpression.test(value)) {
    throw new MetadataDomainError("INVALID_INPUT", "Resource namespace is invalid.");
  }
  return value;
}

export function validateResourceApiName(value: unknown): string {
  if (typeof value !== "string" || !apiNameExpression.test(value)) {
    throw new MetadataDomainError("INVALID_INPUT", "Resource apiName is invalid.");
  }
  return value;
}

export function validateResourceFamily(value: unknown): ResourceFamily {
  if (typeof value !== "string" || !resourceFamilies.has(value as ResourceFamily)) {
    throw new MetadataDomainError("INVALID_INPUT", "Resource family is invalid.");
  }
  return value as ResourceFamily;
}

/**
 * The strict family parser is applied before hashing or persistence. This makes
 * the canonical preimage a server-owned fact and rejects deferred families on
 * the direct Resource path.
 */
export function prepareDirectResourceContent(
  familyInput: unknown,
  contentInput: unknown,
): PreparedResourceContent {
  const family = validateResourceFamily(familyInput);
  try {
    const content = parseDirectResourceContent(family, contentInput);
    return Object.freeze({
      content,
      canonicalContent: canonicalizeContractForDigest(content),
    });
  } catch (error) {
    throw new MetadataDomainError(
      "INVALID_INPUT",
      "Resource content does not satisfy the active family contract.",
      { cause: error },
    );
  }
}

export function assertResourceStateTransition(current: ResourceState, target: ResourceState): void {
  if (current === target) return;
  const allowed: Readonly<Record<ResourceState, readonly ResourceState[]>> = {
    active: ["deprecated", "archived"],
    deprecated: ["archived"],
    archived: [],
  };
  if (!allowed[current].includes(target)) {
    throw new MetadataDomainError(
      "INVALID_STATE",
      `Resource cannot transition from ${current} to ${target}.`,
    );
  }
}

export function assertResourceRevisionStateTransition(
  current: ResourceRevisionState,
  target: ResourceRevisionState,
): void {
  if (current === target) return;
  const allowed: Readonly<Record<ResourceRevisionState, readonly ResourceRevisionState[]>> = {
    draft: ["validated"],
    validated: ["published"],
    published: ["deprecated"],
    deprecated: ["archived"],
    archived: [],
  };
  if (!allowed[current].includes(target)) {
    throw new MetadataDomainError(
      "INVALID_STATE",
      `Resource Revision cannot transition from ${current} to ${target}.`,
    );
  }
}

export function assertChildDraftSourceState(state: ResourceRevisionState): void {
  if (!childDraftSourceStates.has(state)) {
    throw new MetadataDomainError(
      "INVALID_STATE",
      "Only a Validated, Published or Deprecated Revision can create a child Draft.",
    );
  }
}

export function validateDisplayName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 160) {
    throw new MetadataDomainError("INVALID_INPUT", "displayName is invalid.");
  }
  return value;
}

export function validateManagementRole(value: unknown): ManagementRole {
  if (typeof value !== "string" || !roles.has(value as ManagementRole)) {
    throw new MetadataDomainError("INVALID_INPUT", "Management role is invalid.");
  }
  return value as ManagementRole;
}

export function validateManagementPermission(value: unknown): ManagementPermission {
  if (typeof value !== "string" || !permissions.has(value as ManagementPermission)) {
    throw new MetadataDomainError("INVALID_INPUT", "Management permission is invalid.");
  }
  return value as ManagementPermission;
}

/**
 * Resource bindings are optional narrowing facts. A missing resource binding
 * preserves the Project grant; a present binding is intersected with it.
 */
export function isManagementPermissionAllowed(
  snapshot: ManagementRoleSnapshot,
  permission: ManagementPermission,
  resourceScoped: boolean,
): boolean {
  if (snapshot.projectRole === null || !grants[snapshot.projectRole].has(permission)) {
    return false;
  }
  if (!resourceScoped || snapshot.resourceRole === null) return true;
  return grants[snapshot.resourceRole].has(permission);
}

export function permissionsForRole(role: ManagementRole): ReadonlySet<ManagementPermission> {
  return grants[role];
}
