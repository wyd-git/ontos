import {
  API_NAME_PATTERN,
  MANAGEMENT_ROLE_VALUES,
  type ManagementRoleValue,
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

export type MetadataDomainErrorCode = "INVALID_INPUT";

export class MetadataDomainError extends Error {
  readonly code: MetadataDomainErrorCode;

  constructor(code: MetadataDomainErrorCode, message: string) {
    super(message);
    this.name = "MetadataDomainError";
    this.code = code;
  }
}

export interface ManagementRoleSnapshot {
  readonly projectRole: ManagementRole | null;
  readonly resourceRole: ManagementRole | null;
}

const apiNameExpression = new RegExp(API_NAME_PATTERN, "u");
const roles = new Set<ManagementRole>(MANAGEMENT_ROLE_VALUES);
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
