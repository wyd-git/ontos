import { parseOntosId, type OntosId } from "@ontos/contracts";

import { IdentityDomainError } from "./claim-mapping.ts";

export interface PrincipalPermissionGrant {
  readonly principalId: string;
  readonly permissions: readonly string[];
}

export interface RuntimePermissionDecision {
  readonly decision: "ALLOW" | "DENY";
}

const permissionPattern = /^[a-z][a-z0-9_.:-]{0,127}$/u;

export function intersectPrincipalPermissions(
  authorizationPrincipalIds: readonly string[],
  grants: readonly PrincipalPermissionGrant[],
): readonly string[] {
  const expected = authorizationPrincipalIds.map((value) => parseOntosId(value));
  if (expected.length === 0 || new Set(expected).size !== expected.length)
    throw intersectionError();
  const byPrincipal = new Map<OntosId, ReadonlySet<string>>();
  for (const grant of grants) {
    const principalId = parseOntosId(grant.principalId);
    if (byPrincipal.has(principalId) || grant.permissions.length > 256) throw intersectionError();
    const permissions = new Set<string>();
    for (const permission of grant.permissions) {
      if (!permissionPattern.test(permission)) throw intersectionError();
      permissions.add(permission);
    }
    byPrincipal.set(principalId, permissions);
  }
  if (byPrincipal.size !== expected.length || expected.some((id) => !byPrincipal.has(id))) {
    throw intersectionError();
  }

  const [first, ...rest] = expected;
  const initial = first === undefined ? new Set<string>() : new Set(byPrincipal.get(first));
  for (const principalId of rest) {
    const allowed = byPrincipal.get(principalId);
    if (allowed === undefined) throw intersectionError();
    for (const permission of initial) {
      if (!allowed.has(permission)) initial.delete(permission);
    }
  }
  return Object.freeze([...initial].sort((left, right) => left.localeCompare(right, "en")));
}

export function decideIntersectedPermission(
  authorizationPrincipalIds: readonly string[],
  grants: readonly PrincipalPermissionGrant[],
  permission: string,
): RuntimePermissionDecision {
  if (!permissionPattern.test(permission)) throw intersectionError();
  const allowed = intersectPrincipalPermissions(authorizationPrincipalIds, grants).includes(
    permission,
  );
  return Object.freeze({ decision: allowed ? "ALLOW" : "DENY" });
}

function intersectionError(): IdentityDomainError {
  return new IdentityDomainError(
    "PERMISSION_INTERSECTION_INVALID",
    "Permission intersection input is incomplete or invalid.",
  );
}
