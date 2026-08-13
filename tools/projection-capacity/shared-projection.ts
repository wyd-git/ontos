export type SharedProjectionColumn =
  | "project_id"
  | "generation_id"
  | "object_type_resource_id"
  | "object_type_revision_id"
  | "object_rid"
  | "canonical_primary_key"
  | "link_type_resource_id"
  | "link_type_revision_id"
  | "link_rid"
  | "source_object_rid"
  | "target_object_rid";

export interface SharedProjectionTableContract {
  table: "runtime.object_current" | "runtime.link_current";
  tenancyColumn: "project_id";
  generationColumn: "generation_id";
  memberResourceColumn: "object_type_resource_id" | "link_type_resource_id";
  memberRevisionColumn: "object_type_revision_id" | "link_type_revision_id";
  primaryKey: readonly SharedProjectionColumn[];
  uniqueKeys: readonly (readonly SharedProjectionColumn[])[];
  forbiddenSelectors: readonly ["release_id", "channel_id", "display_name"];
}

/**
 * DB-02 must translate this contract into two shared physical tables. A Release or
 * display label is deliberately absent: an Activation resolves those mutable
 * selectors to immutable Generation IDs before a projection is queried.
 */
export const SHARED_PROJECTION_CONTRACT = {
  objectCurrent: {
    table: "runtime.object_current",
    tenancyColumn: "project_id",
    generationColumn: "generation_id",
    memberResourceColumn: "object_type_resource_id",
    memberRevisionColumn: "object_type_revision_id",
    primaryKey: ["project_id", "generation_id", "object_type_resource_id", "object_rid"],
    uniqueKeys: [
      ["project_id", "generation_id", "object_type_resource_id", "canonical_primary_key"],
    ],
    forbiddenSelectors: ["release_id", "channel_id", "display_name"],
  },
  linkCurrent: {
    table: "runtime.link_current",
    tenancyColumn: "project_id",
    generationColumn: "generation_id",
    memberResourceColumn: "link_type_resource_id",
    memberRevisionColumn: "link_type_revision_id",
    primaryKey: ["project_id", "generation_id", "link_type_resource_id", "link_rid"],
    uniqueKeys: [
      [
        "project_id",
        "generation_id",
        "link_type_resource_id",
        "source_object_rid",
        "target_object_rid",
      ],
    ],
    forbiddenSelectors: ["release_id", "channel_id", "display_name"],
  },
} as const satisfies Record<string, SharedProjectionTableContract>;

export function assertSharedProjectionContract(): void {
  assertTableContract(SHARED_PROJECTION_CONTRACT.objectCurrent, {
    identityColumn: "object_rid",
    canonicalKey: "canonical_primary_key",
  });
  assertTableContract(SHARED_PROJECTION_CONTRACT.linkCurrent, {
    identityColumn: "link_rid",
    endpointColumns: ["source_object_rid", "target_object_rid"],
  });
}

function assertTableContract(
  contract: SharedProjectionTableContract,
  requirement:
    | {
        identityColumn: "object_rid";
        canonicalKey: "canonical_primary_key";
      }
    | {
        identityColumn: "link_rid";
        endpointColumns: readonly ["source_object_rid", "target_object_rid"];
      },
): void {
  const requiredScope: SharedProjectionColumn[] = [
    contract.tenancyColumn,
    contract.generationColumn,
    contract.memberResourceColumn,
  ];
  if (
    requiredScope.some((column) => !contract.primaryKey.includes(column)) ||
    !contract.primaryKey.includes(requirement.identityColumn)
  ) {
    throw new Error(
      `${contract.table} primary key does not isolate Project, Generation and member.`,
    );
  }
  if (contract.primaryKey.includes(contract.memberRevisionColumn)) {
    throw new Error(`${contract.table} revision must be Generation metadata, not row identity.`);
  }
  const requiredUnique =
    "canonicalKey" in requirement
      ? [...requiredScope, requirement.canonicalKey]
      : [...requiredScope, ...requirement.endpointColumns];
  if (!contract.uniqueKeys.some((key) => sameColumns(key, requiredUnique))) {
    throw new Error(`${contract.table} is missing its logical uniqueness constraint.`);
  }
  const selectors = [...contract.primaryKey, ...contract.uniqueKeys.flat()];
  if (contract.forbiddenSelectors.some((selector) => selectors.includes(selector as never))) {
    throw new Error(`${contract.table} cannot key physical rows by mutable selectors.`);
  }
}

function sameColumns(
  actual: readonly SharedProjectionColumn[],
  expected: readonly SharedProjectionColumn[],
): boolean {
  return (
    actual.length === expected.length && actual.every((column, index) => column === expected[index])
  );
}
