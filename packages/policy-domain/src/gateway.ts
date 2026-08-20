import { MANAGEMENT_ROLE_VALUES, type ManagementRoleValue } from "@ontos/contracts";

export const POLICY_GATEWAY_PERMISSION_VALUES = Object.freeze(["object.read"] as const);
export type PolicyGatewayPermission = (typeof POLICY_GATEWAY_PERMISSION_VALUES)[number];

export interface PolicyRoleAuthorizationFacts {
  readonly projectRole: ManagementRoleValue | null;
  readonly resourceRole: ManagementRoleValue | null;
  readonly resourceBindingPresent: boolean;
}

export class PolicyGatewayDomainError extends Error {
  constructor() {
    super("Policy Gateway authorization facts are invalid.");
    this.name = "PolicyGatewayDomainError";
  }
}

const roles: ReadonlySet<string> = new Set(MANAGEMENT_ROLE_VALUES);
const gatewayPermissions: Readonly<Record<ManagementRoleValue, ReadonlySet<string>>> =
  Object.freeze({
    owner: new Set<PolicyGatewayPermission>(POLICY_GATEWAY_PERMISSION_VALUES),
    editor: new Set<PolicyGatewayPermission>(POLICY_GATEWAY_PERMISSION_VALUES),
    viewer: new Set<PolicyGatewayPermission>(POLICY_GATEWAY_PERMISSION_VALUES),
    executor: new Set<PolicyGatewayPermission>(POLICY_GATEWAY_PERMISSION_VALUES),
    auditor: new Set<PolicyGatewayPermission>(),
  });

/**
 * Resource roles may only narrow the Project-level coarse permission. Business
 * Object/Property/Link visibility is still decided by the compiled Policy IR.
 */
export function policyGatewayPermissionsForRoles(
  facts: PolicyRoleAuthorizationFacts,
): readonly string[] {
  const projectRole = parseRole(facts.projectRole, true);
  const resourceRole = parseRole(facts.resourceRole, true);
  if (
    typeof facts.resourceBindingPresent !== "boolean" ||
    (facts.resourceBindingPresent && resourceRole === null) ||
    (!facts.resourceBindingPresent && resourceRole !== null)
  ) {
    throw new PolicyGatewayDomainError();
  }
  if (projectRole === null) return Object.freeze([]);

  const permissions = new Set(gatewayPermissions[projectRole]);
  if (facts.resourceBindingPresent && resourceRole !== null) {
    const resourcePermissions = gatewayPermissions[resourceRole];
    for (const permission of permissions) {
      if (!resourcePermissions.has(permission)) permissions.delete(permission);
    }
  }
  return Object.freeze([...permissions].sort(compareText));
}

function parseRole(value: unknown, nullable: boolean): ManagementRoleValue | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !roles.has(value)) throw new PolicyGatewayDomainError();
  return value as ManagementRoleValue;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
