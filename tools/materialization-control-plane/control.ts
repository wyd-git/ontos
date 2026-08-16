import {
  assertLockPlan,
  MetadataControlPlaneError,
  type LockDomain,
} from "../metadata-control-plane/model.ts";

export const RUNTIME_PUBLISH_LOCK_PLAN: readonly LockDomain[] = [
  "PROJECT_CONTROL",
  "RELEASE_CHANNEL",
  "RELEASE",
  "RELEASE_PINS",
  "GENERATION_INVENTORY",
  "SERVING_HEADS",
];

export const MATERIALIZATION_CUTOVER_LOCK_PLAN: readonly LockDomain[] = [
  "PROJECT_CONTROL",
  "RELEASE_CHANNEL",
  "RELEASE",
  "SNAPSHOT_GROUP",
  "OBJECT_TYPE_CUTOVER",
  "GENERATION_INVENTORY",
  "SERVING_HEADS",
];

export const GC_COMMIT_LOCK_PLAN: readonly LockDomain[] = [
  "PROJECT_CONTROL",
  "GENERATION_INVENTORY",
];

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function assertMaterializationLockPlans(): void {
  assertLockPlan(RUNTIME_PUBLISH_LOCK_PLAN);
  assertLockPlan(MATERIALIZATION_CUTOVER_LOCK_PLAN);
  assertLockPlan(GC_COMMIT_LOCK_PLAN);
}

export function orderedObjectTypeCutoverKeys(keys: readonly string[]): readonly string[] {
  const normalized = keys.map((key) => key.trim().toLowerCase());
  if (
    normalized.length === 0 ||
    normalized.some((key) => !canonicalUuidPattern.test(key)) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new MetadataControlPlaneError(
      "INVALID_INPUT",
      "Object Type cutover keys must be non-empty, unique canonical UUIDs.",
    );
  }
  return normalized.toSorted((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
}
