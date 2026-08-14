import { createHash } from "node:crypto";

export const DEFAULT_DATASET_SEED = "seed-20260813";

export interface DatasetConfig {
  readonly seed: string;
  readonly objectCount: number;
  readonly linkCount: number;
}

export interface GeneratedObject {
  readonly objectType: string;
  readonly objectRid: string;
  readonly primaryKey: string;
  readonly properties: {
    readonly name: string;
    readonly status: string;
    readonly updatedAt: string;
    readonly amount: number;
    readonly active: boolean;
    readonly region: string;
    readonly sensitiveCode: string;
    readonly tags: readonly string[];
  };
  readonly sourceRowNumber: number;
}

export interface GeneratedLink {
  readonly linkType: string;
  readonly linkRid: string;
  readonly sourceObjectType: string;
  readonly sourceObjectRid: string;
  readonly targetObjectType: string;
  readonly targetObjectRid: string;
}

export const DATASET_PRESETS = Object.freeze({
  small: Object.freeze({
    seed: DEFAULT_DATASET_SEED,
    objectCount: 50,
    linkCount: 100,
  }),
  benchmark: Object.freeze({
    seed: DEFAULT_DATASET_SEED,
    objectCount: 100_000,
    linkCount: 1_000_000,
  }),
}) satisfies Readonly<Record<"small" | "benchmark", DatasetConfig>>;

const objectTypes = Object.freeze([
  Object.freeze({ objectType: "EntityA", keyPrefix: "EA" }),
  Object.freeze({ objectType: "EntityB", keyPrefix: "EB" }),
  Object.freeze({ objectType: "EntityC", keyPrefix: "EC" }),
  Object.freeze({ objectType: "EntityD", keyPrefix: "ED" }),
  Object.freeze({ objectType: "EntityE", keyPrefix: "EE" }),
]);

const linkTypes = Object.freeze([
  Object.freeze({ linkType: "LinkAB", sourceType: "EntityA", targetType: "EntityB" }),
  Object.freeze({ linkType: "LinkBC", sourceType: "EntityB", targetType: "EntityC" }),
  Object.freeze({ linkType: "LinkCD", sourceType: "EntityC", targetType: "EntityD" }),
  Object.freeze({ linkType: "LinkDE", sourceType: "EntityD", targetType: "EntityE" }),
  Object.freeze({ linkType: "LinkEA", sourceType: "EntityE", targetType: "EntityA" }),
]);

const statuses = Object.freeze(["OPEN", "IN_PROGRESS", "BLOCKED", "CLOSED"]);
const regions = Object.freeze(["EAST", "WEST", "NORTH", "SOUTH"]);

export function* generateObjects(config: DatasetConfig): IterableIterator<GeneratedObject> {
  assertConfig(config);
  const baseCount = Math.floor(config.objectCount / objectTypes.length);
  const remainder = config.objectCount % objectTypes.length;
  const offset = seedOffset(config.seed);

  for (const [typeIndex, fixture] of objectTypes.entries()) {
    const count = baseCount + (typeIndex < remainder ? 1 : 0);
    for (let sourceRowNumber = 1; sourceRowNumber <= count; sourceRowNumber += 1) {
      const logicalRowNumber = sourceRowNumber + offset;
      const objectSuffix = padIdentifier(sourceRowNumber);
      const minuteOffset = (logicalRowNumber * 37) % 525_600;
      const amount = ((logicalRowNumber * 7_919) % 10_000_000) / 100;
      yield {
        objectType: fixture.objectType,
        objectRid: `${fixture.objectType}:${objectSuffix}`,
        primaryKey: `${fixture.keyPrefix}-${objectSuffix}`,
        properties: {
          name: `${fixture.objectType} record ${sourceRowNumber}`,
          status: statuses[(logicalRowNumber - 1) % statuses.length] ?? "OPEN",
          updatedAt: timestampAtMinute(minuteOffset),
          amount,
          active: logicalRowNumber % 5 !== 0,
          region: regions[(logicalRowNumber - 1) % regions.length] ?? "EAST",
          sensitiveCode: `SC-${createHash("md5").update(`${fixture.objectType}:${logicalRowNumber}`).digest("hex")}`,
          tags: [`tag-${logicalRowNumber % 20}`, `bucket-${logicalRowNumber % 100}`],
        },
        sourceRowNumber,
      };
    }
  }
}

export function* generateLinks(config: DatasetConfig): IterableIterator<GeneratedLink> {
  assertConfig(config);
  const objectsPerType = Math.floor(config.objectCount / objectTypes.length);
  if (config.linkCount > 0 && objectsPerType === 0) {
    throw new Error("At least one object per type is required when generating links.");
  }
  const offset = seedOffset(config.seed);

  for (let id = 1; id <= config.linkCount; id += 1) {
    const fixture = linkTypes[(id - 1) % linkTypes.length];
    if (!fixture) throw new Error(`Missing link fixture for link ${id}.`);
    const logicalId = id + offset;
    const sourceNumber = ((logicalId * 17) % objectsPerType) + 1;
    const targetNumber =
      ((logicalId * 97 + Math.floor(logicalId / objectsPerType)) % objectsPerType) + 1;
    yield {
      linkType: fixture.linkType,
      linkRid: `${fixture.linkType}:${id}`,
      sourceObjectType: fixture.sourceType,
      sourceObjectRid: `${fixture.sourceType}:${padIdentifier(sourceNumber)}`,
      targetObjectType: fixture.targetType,
      targetObjectRid: `${fixture.targetType}:${padIdentifier(targetNumber)}`,
    };
  }
}

export function datasetDigest(config: DatasetConfig): string {
  const hash = createHash("sha256");
  hash.update(`seed:${config.seed}\nobjects:${config.objectCount}\nlinks:${config.linkCount}\n`);
  for (const object of generateObjects(config)) hash.update(`${JSON.stringify(object)}\n`);
  for (const link of generateLinks(config)) hash.update(`${JSON.stringify(link)}\n`);
  return `sha256:${hash.digest("hex")}`;
}

function seedOffset(seed: string): number {
  if (seed === DEFAULT_DATASET_SEED) return 0;
  return createHash("sha256").update(seed).digest().readUInt32BE(0) % 1_000_000;
}

function timestampAtMinute(minuteOffset: number): string {
  const milliseconds = Date.UTC(2025, 0, 1) + minuteOffset * 60_000;
  return new Date(milliseconds).toISOString().replace(".000Z", ".000000Z");
}

function padIdentifier(value: number): string {
  return String(value).padStart(6, "0");
}

function assertConfig(config: DatasetConfig): void {
  if (config.seed.length === 0) throw new Error("Dataset seed must not be empty.");
  if (!Number.isSafeInteger(config.objectCount) || config.objectCount < 0) {
    throw new Error("objectCount must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(config.linkCount) || config.linkCount < 0) {
    throw new Error("linkCount must be a non-negative safe integer.");
  }
}
