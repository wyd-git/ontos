import {
  DAY_IN_MS,
  defaultRuntimePolicy,
  type ActivationMember,
  type ReleasePin,
  type RuntimeActivationModel,
  type RuntimePolicy,
} from "./model.ts";

export const fixtureProjectId = "project-1";
export const fixtureChannel = "stable";
export const fixtureMemberKeys = ["object:asset", "link:asset-work"] as const;

export function runtimePolicy(overrides: Partial<RuntimePolicy> = {}): RuntimePolicy {
  return { ...defaultRuntimePolicy, ...overrides };
}

export function releasePins(
  releaseId: string,
  schemaHash: string,
  mappingHash: string,
): ReleasePin[] {
  return fixtureMemberKeys.map((memberKey) => ({
    memberKey,
    resourceRevisionId: `${releaseId}:${memberKey}:revision`,
    schemaHash,
    mappingHash,
    snapshotGroupKey: "operations",
  }));
}

export function registerRelease(
  model: RuntimeActivationModel,
  input: {
    id: string;
    schemaHash: string;
    mappingHash: string;
    stagedAt?: number;
    rollbackOf?: string;
    pins?: readonly ReleasePin[];
  },
): void {
  const base = {
    id: input.id,
    projectId: fixtureProjectId,
    manifestHash: `manifest:${input.id}`,
    pins: input.pins ?? releasePins(input.id, input.schemaHash, input.mappingHash),
    stagedAt: input.stagedAt ?? 0,
  };
  model.registerRelease(
    input.rollbackOf === undefined ? base : { ...base, rollbackOf: input.rollbackOf },
  );
}

export function registerSnapshotGroup(
  model: RuntimeActivationModel,
  label: string,
  at: number,
): Record<string, string> {
  const snapshots: Record<string, string> = {};
  for (const memberKey of fixtureMemberKeys) {
    const id = `${label}:snapshot:${memberKey}`;
    model.registerSnapshot({
      id,
      projectId: fixtureProjectId,
      groupKey: "operations",
      groupVersion: label,
      createdAt: at,
    });
    snapshots[memberKey] = id;
  }
  return snapshots;
}

export function registerGenerationMembers(
  model: RuntimeActivationModel,
  input: {
    label: string;
    snapshots: Readonly<Record<string, string>>;
    buildReleaseId: string;
    compatibleReleaseIds?: readonly string[];
    at: number;
  },
): Record<string, ActivationMember> {
  const members: Record<string, ActivationMember> = {};
  for (const memberKey of fixtureMemberKeys) {
    const snapshotId = required(input.snapshots, memberKey);
    const generationId = `${input.label}:generation:${memberKey}`;
    const compatibleReleaseIds = input.compatibleReleaseIds ?? [];
    model.registerGeneration({
      id: generationId,
      projectId: fixtureProjectId,
      memberKey,
      snapshotId,
      buildReleaseId: input.buildReleaseId,
      compatibleReleaseIds,
      certificateByReleaseId: Object.fromEntries(
        compatibleReleaseIds.map((releaseId) => [
          releaseId,
          `certificate:${input.buildReleaseId}:${releaseId}:${memberKey}`,
        ]),
      ),
      createdAt: input.at,
    });
    members[memberKey] = { generationId, snapshotId };
  }
  return members;
}

export function createActivation(
  model: RuntimeActivationModel,
  input: {
    id: string;
    releaseId: string;
    members: Readonly<Record<string, ActivationMember>>;
    at: number;
  },
): void {
  model.createActivation({
    id: input.id,
    projectId: fixtureProjectId,
    sourceChannel: fixtureChannel,
    releaseId: input.releaseId,
    members: input.members,
    createdAt: input.at,
  });
}

export function createVersion(
  model: RuntimeActivationModel,
  input: {
    label: string;
    releaseId: string;
    buildReleaseId?: string;
    compatibleReleaseIds?: readonly string[];
    at: number;
  },
): { activationId: string; members: Record<string, ActivationMember> } {
  const snapshots = registerSnapshotGroup(model, input.label, input.at);
  const generationInput = {
    label: input.label,
    snapshots,
    buildReleaseId: input.buildReleaseId ?? input.releaseId,
    at: input.at,
  };
  const members = registerGenerationMembers(
    model,
    input.compatibleReleaseIds === undefined
      ? generationInput
      : { ...generationInput, compatibleReleaseIds: input.compatibleReleaseIds },
  );
  const activationId = `${input.label}:activation:${input.releaseId}`;
  createActivation(model, { id: activationId, releaseId: input.releaseId, members, at: input.at });
  return { activationId, members };
}

export function publishFixtureRelease(
  model: RuntimeActivationModel,
  releaseId: string,
  activationId: string,
  at: number,
  capacityApprovalId?: string,
): void {
  const base = {
    releaseId,
    channel: fixtureChannel,
    activationId,
    expectedControlRevision: model.controlRevision,
    at,
    supportUntil: at + 90 * DAY_IN_MS,
  };
  model.publish(capacityApprovalId === undefined ? base : { ...base, capacityApprovalId });
}

export function firstMember(members: Readonly<Record<string, ActivationMember>>): ActivationMember {
  return required(members, fixtureMemberKeys[0]);
}

function required<T>(record: Readonly<Record<string, T>>, key: string): T {
  const value = record[key];
  if (value === undefined) throw new Error(`Fixture value ${key} is missing.`);
  return value;
}
