import {
  canonicalizeMaterializationContractForDigest,
  parseArtifactDigest,
  parseMappingDefinition,
  parseOntosId,
  parseRuntimeMemberPlan,
  type ArtifactDigest,
  type ResourceFamily,
  type RuntimeMemberPlanContract,
} from "@ontos/contracts";

export const RUNTIME_MEMBER_PLAN_COMPILER_VERSION = "g2-02-10-v1";

export type RuntimePlanErrorCode =
  | "RUNTIME_PLAN_INPUT_INVALID"
  | "RUNTIME_PLAN_GROUP_INCOMPLETE"
  | "RUNTIME_PLAN_INDEX_UNAVAILABLE"
  | "RUNTIME_PLAN_PIN_MISMATCH";

export class RuntimePlanError extends Error {
  readonly code: RuntimePlanErrorCode;

  constructor(code: RuntimePlanErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimePlanError";
    this.code = code;
  }
}

export interface RuntimePlanPinnedResource {
  readonly resourceId: string;
  readonly revisionId: string;
  readonly family: ResourceFamily;
  readonly apiName: string;
  readonly contentDigest: ArtifactDigest;
  readonly content: unknown;
}

/**
 * A server-owned grouping definition. The definition binds stable Mapping resources,
 * never a caller-provided Release member list or Runtime Plan digest. Release staging
 * resolves the exact Mapping revisions from immutable Release pins.
 */
export interface RuntimePlanSnapshotGroupDefinition {
  readonly snapshotGroupId: string;
  readonly groupKey: string;
  readonly mappingResourceIds: readonly string[];
}

export interface RuntimePlanIndexReference {
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly indexPlanDigest: ArtifactDigest;
}

export interface CompileRuntimeMemberPlanInput {
  readonly projectId: string;
  readonly releaseId: string;
  readonly pins: readonly RuntimePlanPinnedResource[];
  readonly snapshotGroups: readonly RuntimePlanSnapshotGroupDefinition[];
  readonly indexPlans: readonly RuntimePlanIndexReference[];
}

export type RuntimePlanCanonicalDigester = (canonicalText: string) => ArtifactDigest;

export function compileRuntimeMemberPlan(
  input: CompileRuntimeMemberPlanInput,
  digestCanonicalText: RuntimePlanCanonicalDigester,
): RuntimeMemberPlanContract {
  const projectId = parseId(input.projectId, "projectId");
  const releaseId = parseId(input.releaseId, "releaseId");
  const pins = parsePins(input.pins);
  const mappingPins = pins.filter((pin) => pin.family === "mapping");
  const groups = parseGroups(input.snapshotGroups);
  const indexes = parseIndexes(input.indexPlans);

  const mappingGroup = new Map<string, RuntimePlanSnapshotGroupDefinition>();
  for (const group of groups) {
    for (const mappingResourceId of group.mappingResourceIds) {
      if (mappingGroup.has(mappingResourceId)) {
        fail(
          "RUNTIME_PLAN_GROUP_INCOMPLETE",
          `Mapping resource ${mappingResourceId} belongs to more than one Snapshot Group.`,
        );
      }
      mappingGroup.set(mappingResourceId, group);
    }
  }

  const pinnedMappings = new Set(mappingPins.map((pin) => pin.resourceId));
  const usedGroups = new Set<string>();
  for (const mapping of mappingPins) {
    const group = mappingGroup.get(mapping.resourceId);
    if (group === undefined) {
      fail(
        "RUNTIME_PLAN_GROUP_INCOMPLETE",
        `Pinned Mapping ${mapping.resourceId} has no server-owned Snapshot Group definition.`,
      );
    }
    usedGroups.add(group.snapshotGroupId);
  }
  for (const group of groups) {
    if (!usedGroups.has(group.snapshotGroupId)) continue;
    const missing = group.mappingResourceIds.find((resourceId) => !pinnedMappings.has(resourceId));
    if (missing !== undefined) {
      fail(
        "RUNTIME_PLAN_GROUP_INCOMPLETE",
        `Snapshot Group ${group.groupKey} is only partially pinned; Mapping ${missing} is missing.`,
      );
    }
  }

  const pinByResourceRevision = new Map(
    pins.map((pin) => [`${pin.resourceId}:${pin.revisionId}`, pin] as const),
  );
  const pinByRevision = new Map<string, RuntimePlanPinnedResource>();
  for (const pin of pins) {
    if (pinByRevision.has(pin.revisionId)) {
      fail("RUNTIME_PLAN_INPUT_INVALID", `Revision ${pin.revisionId} is pinned more than once.`);
    }
    pinByRevision.set(pin.revisionId, pin);
  }
  const indexByTarget = new Map(
    indexes.map((plan) => [`${plan.targetResourceId}:${plan.targetRevisionId}`, plan] as const),
  );

  const members = mappingPins.map((mappingPin) => {
    let mapping;
    try {
      mapping = parseMappingDefinition(mappingPin.content);
    } catch (cause) {
      throw new RuntimePlanError(
        "RUNTIME_PLAN_PIN_MISMATCH",
        `Pinned Mapping revision ${mappingPin.revisionId} is not a valid Mapping definition.`,
        { cause },
      );
    }
    const target = pinByResourceRevision.get(
      `${mapping.targetResourceId}:${mapping.targetRevisionId}`,
    );
    const expectedTargetFamily = mapping.targetKind === "object" ? "object_type" : "link_type";
    if (target === undefined || target.family !== expectedTargetFamily) {
      fail(
        "RUNTIME_PLAN_PIN_MISMATCH",
        `Mapping ${mappingPin.revisionId} does not resolve to its exact pinned ${expectedTargetFamily}.`,
      );
    }
    const schema = pinByRevision.get(mapping.inputSchemaRevisionId);
    if (schema === undefined || schema.family !== "snapshot_schema") {
      fail(
        "RUNTIME_PLAN_PIN_MISMATCH",
        `Mapping ${mappingPin.revisionId} does not resolve to its exact pinned Snapshot Schema.`,
      );
    }
    const group = mappingGroup.get(mappingPin.resourceId);
    if (group === undefined) {
      fail("RUNTIME_PLAN_GROUP_INCOMPLETE", "A Mapping lost its Snapshot Group assignment.");
    }
    const index = indexByTarget.get(`${target.resourceId}:${target.revisionId}`);
    if (index === undefined) {
      fail(
        "RUNTIME_PLAN_INDEX_UNAVAILABLE",
        `Target revision ${target.revisionId} has no admitted deterministic Index Plan.`,
      );
    }
    return Object.freeze({
      memberKey: `${mapping.targetKind}:${target.apiName}`,
      memberKind: mapping.targetKind,
      targetResourceId: target.resourceId,
      targetRevisionId: target.revisionId,
      snapshotSchemaRevisionId: schema.revisionId,
      mappingRevisionId: mappingPin.revisionId,
      snapshotGroupId: group.snapshotGroupId,
      indexPlanDigest: index.indexPlanDigest,
    });
  });
  members.sort((left, right) => compareText(left.memberKey, right.memberKey));
  for (let index = 1; index < members.length; index += 1) {
    if (members[index - 1]?.memberKey === members[index]?.memberKey) {
      fail(
        "RUNTIME_PLAN_PIN_MISMATCH",
        `Runtime member ${members[index]?.memberKey} is duplicated.`,
      );
    }
  }

  const withoutDigest = {
    schemaVersion: 1,
    contractVersion: "runtime-member-plan-v1",
    projectId,
    releaseId,
    members,
    planDigest: zeroDigest(),
  } as const;
  const planDigest = parseArtifactDigest(
    digestCanonicalText(
      canonicalizeMaterializationContractForDigest("RuntimeMemberPlan", withoutDigest),
    ),
  );
  return parseRuntimeMemberPlan({ ...withoutDigest, planDigest });
}

function parsePins(
  input: readonly RuntimePlanPinnedResource[],
): readonly RuntimePlanPinnedResource[] {
  const pins: readonly RuntimePlanPinnedResource[] = input;
  if (!Array.isArray(input) || input.length === 0 || input.length > 2_048) {
    fail("RUNTIME_PLAN_INPUT_INVALID", "Runtime Plan pins are outside the supported envelope.");
  }
  const identities = new Set<string>();
  return Object.freeze(
    pins.map((pin) => {
      const resourceId = parseId(pin.resourceId, "pin.resourceId");
      const revisionId = parseId(pin.revisionId, "pin.revisionId");
      const identity = `${resourceId}:${revisionId}`;
      if (identities.has(identity)) {
        fail("RUNTIME_PLAN_INPUT_INVALID", `Pin ${identity} is duplicated.`);
      }
      identities.add(identity);
      if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/u.test(pin.apiName)) {
        fail("RUNTIME_PLAN_INPUT_INVALID", `Pin ${identity} has an invalid API Name.`);
      }
      return Object.freeze({
        ...pin,
        resourceId,
        revisionId,
        contentDigest: parseArtifactDigest(pin.contentDigest),
      });
    }),
  );
}

function parseGroups(
  input: readonly RuntimePlanSnapshotGroupDefinition[],
): readonly RuntimePlanSnapshotGroupDefinition[] {
  const groups: readonly RuntimePlanSnapshotGroupDefinition[] = input;
  if (!Array.isArray(input) || input.length > 256) {
    fail("RUNTIME_PLAN_INPUT_INVALID", "Snapshot Group definitions exceed the supported envelope.");
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  return Object.freeze(
    groups.map((group) => {
      const snapshotGroupId = parseId(group.snapshotGroupId, "snapshotGroupId");
      if (
        ids.has(snapshotGroupId) ||
        keys.has(group.groupKey) ||
        !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(group.groupKey) ||
        !Array.isArray(group.mappingResourceIds) ||
        group.mappingResourceIds.length < 1 ||
        group.mappingResourceIds.length > 256
      ) {
        fail("RUNTIME_PLAN_INPUT_INVALID", "Snapshot Group definition is invalid or duplicated.");
      }
      ids.add(snapshotGroupId);
      keys.add(group.groupKey);
      const mappingResourceIds = group.mappingResourceIds.map((id: string) =>
        parseId(id, "mappingResourceId"),
      );
      if (new Set(mappingResourceIds).size !== mappingResourceIds.length) {
        fail("RUNTIME_PLAN_INPUT_INVALID", `Snapshot Group ${group.groupKey} repeats a Mapping.`);
      }
      const sorted = [...mappingResourceIds].sort(compareText);
      if (sorted.some((value, index) => value !== mappingResourceIds[index])) {
        fail(
          "RUNTIME_PLAN_INPUT_INVALID",
          `Snapshot Group ${group.groupKey} Mapping resources are not deterministically ordered.`,
        );
      }
      return Object.freeze({
        snapshotGroupId,
        groupKey: group.groupKey,
        mappingResourceIds: sorted,
      });
    }),
  );
}

function parseIndexes(
  input: readonly RuntimePlanIndexReference[],
): readonly RuntimePlanIndexReference[] {
  const indexes: readonly RuntimePlanIndexReference[] = input;
  if (!Array.isArray(input) || input.length > 256) {
    fail("RUNTIME_PLAN_INPUT_INVALID", "Index Plan references exceed the supported envelope.");
  }
  const targets = new Set<string>();
  return Object.freeze(
    indexes.map((plan) => {
      const targetResourceId = parseId(plan.targetResourceId, "index.targetResourceId");
      const targetRevisionId = parseId(plan.targetRevisionId, "index.targetRevisionId");
      const identity = `${targetResourceId}:${targetRevisionId}`;
      if (targets.has(identity)) {
        fail("RUNTIME_PLAN_INPUT_INVALID", `Target ${identity} has more than one Index Plan.`);
      }
      targets.add(identity);
      return Object.freeze({
        targetResourceId,
        targetRevisionId,
        indexPlanDigest: parseArtifactDigest(plan.indexPlanDigest),
      });
    }),
  );
}

function parseId(value: string, label: string): string {
  try {
    return parseOntosId(value, `$runtimePlan.${label}`);
  } catch (cause) {
    throw new RuntimePlanError("RUNTIME_PLAN_INPUT_INVALID", `${label} is invalid.`, { cause });
  }
}

function zeroDigest(): ArtifactDigest {
  return parseArtifactDigest(`sha256:${"0".repeat(64)}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: RuntimePlanErrorCode, message: string): never {
  throw new RuntimePlanError(code, message);
}
