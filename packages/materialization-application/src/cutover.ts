import { parseOntosId } from "@ontos/contracts";

import {
  CertifiedZeroOverlayProvider,
  OverlayCutoverError,
  catchUpOverlay,
  type OverlayInventoryEvidence,
  type OverlayProvider,
} from "./overlay.ts";

export type SnapshotGroupCutoverErrorCode =
  | "CUTOVER_CONCURRENT_MODIFICATION"
  | "CUTOVER_DEPENDENCY_UNAVAILABLE"
  | "CUTOVER_IDEMPOTENCY_CONFLICT"
  | "CUTOVER_INPUT_INVALID"
  | "CUTOVER_NOT_READY";

export class SnapshotGroupCutoverError extends Error {
  readonly code: SnapshotGroupCutoverErrorCode;

  constructor(code: SnapshotGroupCutoverErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "SnapshotGroupCutoverError";
    this.code = code;
  }
}

export interface SnapshotGroupCutoverCommand {
  readonly projectId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
  readonly expectedControlRevision: bigint;
  readonly idempotencyKey: string;
}

export interface SnapshotGroupCutoverPreparation {
  readonly preparationId: string;
  readonly projectId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
  readonly expectedControlRevision: bigint;
  readonly expectedStateRevision: bigint;
  readonly expectedInventoryRevision: bigint;
  readonly releaseCount: number;
  readonly memberCount: number;
  readonly objectHeadCount: number;
  readonly overlayEvidence: OverlayInventoryEvidence;
  readonly reused: boolean;
}

export interface SnapshotGroupCutoverReleaseResult {
  readonly releaseId: string;
  readonly activationId: string;
  readonly previousActivationId: string | null;
  readonly servingHeadMoved: boolean;
  readonly servingHeadControlSequence: bigint | null;
  readonly channelMoved: boolean;
}

export interface SnapshotGroupCutoverResult {
  readonly preparationId: string;
  readonly projectId: string;
  readonly snapshotGroupId: string;
  readonly groupVersion: number;
  readonly controlRevision: bigint;
  readonly stateRevision: bigint;
  readonly inventoryRevision: bigint;
  readonly changed: boolean;
  readonly reused: boolean;
  readonly insertedHeadCount: number;
  readonly updatedHeadCount: number;
  readonly repointedHeadCount: number;
  readonly releases: readonly SnapshotGroupCutoverReleaseResult[];
}

export interface SnapshotGroupCutoverRepository {
  prepareSnapshotGroupCutover(input: {
    readonly command: SnapshotGroupCutoverCommand;
    readonly overlayEvidence: OverlayInventoryEvidence;
  }): Promise<SnapshotGroupCutoverPreparation>;
  commitSnapshotGroupCutover(input: {
    readonly preparation: SnapshotGroupCutoverPreparation;
    readonly overlayEvidence: OverlayInventoryEvidence;
  }): Promise<SnapshotGroupCutoverResult>;
}

export interface SnapshotGroupCutoverCoordinatorOptions {
  readonly overlayProvider?: OverlayProvider;
}

/**
 * Coordinates only the production cutover boundary. CSV, object-store access,
 * materialization, DDL and capacity measurement must already be complete.
 */
export class SnapshotGroupCutoverCoordinator {
  readonly #repository: SnapshotGroupCutoverRepository;
  readonly #overlayProvider: OverlayProvider;

  constructor(
    repository: SnapshotGroupCutoverRepository,
    options: SnapshotGroupCutoverCoordinatorOptions = {},
  ) {
    this.#repository = repository;
    this.#overlayProvider = options.overlayProvider ?? new CertifiedZeroOverlayProvider();
  }

  async activate(input: unknown): Promise<SnapshotGroupCutoverResult> {
    const command = parseCutoverCommand(input);
    const snapshotGroupKey = `${command.snapshotGroupId}:${command.groupVersion}`;
    const overlay = await catchUpOverlay(
      {
        mode: "PRODUCTION_ZERO",
        projectId: command.projectId,
        snapshotGroupKey,
        stagedHeads: {},
      },
      this.#overlayProvider,
    );
    const preparation = await mapRepository(() =>
      this.#repository.prepareSnapshotGroupCutover({
        command,
        overlayEvidence: overlay.finalEvidence,
      }),
    );
    assertPreparationBinding(command, preparation, overlay.finalEvidence);
    return mapRepository(() =>
      this.#repository.commitSnapshotGroupCutover({
        preparation,
        overlayEvidence: overlay.finalEvidence,
      }),
    );
  }
}

export function parseCutoverCommand(input: unknown): SnapshotGroupCutoverCommand {
  try {
    const record = strictRecord(input, [
      "projectId",
      "snapshotGroupId",
      "groupVersion",
      "expectedControlRevision",
      "idempotencyKey",
    ]);
    const groupVersion = record["groupVersion"];
    const idempotencyKey = record["idempotencyKey"];
    if (!Number.isSafeInteger(groupVersion) || (groupVersion as number) < 1) throw new TypeError();
    if (
      typeof idempotencyKey !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/u.test(idempotencyKey)
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      projectId: parseOntosId(record["projectId"]),
      snapshotGroupId: parseOntosId(record["snapshotGroupId"]),
      groupVersion: groupVersion as number,
      expectedControlRevision: parseRevision(record["expectedControlRevision"]),
      idempotencyKey,
    });
  } catch (cause) {
    throw new SnapshotGroupCutoverError("CUTOVER_INPUT_INVALID", { cause });
  }
}

function assertPreparationBinding(
  command: SnapshotGroupCutoverCommand,
  preparation: SnapshotGroupCutoverPreparation,
  overlay: OverlayInventoryEvidence,
): void {
  if (
    preparation.projectId !== command.projectId ||
    preparation.snapshotGroupId !== command.snapshotGroupId ||
    preparation.groupVersion !== command.groupVersion ||
    preparation.expectedControlRevision !== command.expectedControlRevision ||
    preparation.overlayEvidence.providerId !== overlay.providerId ||
    preparation.overlayEvidence.providerVersion !== overlay.providerVersion ||
    preparation.overlayEvidence.watermark !== overlay.watermark ||
    preparation.overlayEvidence.deltaCount !== overlay.deltaCount ||
    preparation.overlayEvidence.digest !== overlay.digest
  ) {
    throw new SnapshotGroupCutoverError("CUTOVER_DEPENDENCY_UNAVAILABLE");
  }
}

function parseRevision(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,18})$/u.test(value)) {
    const revision = BigInt(value);
    if (revision <= 9_223_372_036_854_775_807n) return revision;
  }
  throw new TypeError();
}

function strictRecord(
  value: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError();
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).toSorted();
  const expected = fields.toSorted();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError();
  }
  return record;
}

async function mapRepository<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SnapshotGroupCutoverError || error instanceof OverlayCutoverError) {
      throw error;
    }
    throw new SnapshotGroupCutoverError("CUTOVER_DEPENDENCY_UNAVAILABLE", { cause: error });
  }
}
