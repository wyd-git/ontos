export type OverlayErrorCode =
  | "OVERLAY_BINDING_MISMATCH"
  | "OVERLAY_CATCH_UP_UNSTABLE"
  | "OVERLAY_DELTA_CONFLICT"
  | "OVERLAY_DELTA_INVALID"
  | "OVERLAY_INVENTORY_UNAVAILABLE"
  | "OVERLAY_NON_ZERO";

export class OverlayCutoverError extends Error {
  readonly code: OverlayErrorCode;

  constructor(code: OverlayErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OverlayCutoverError";
    this.code = code;
  }
}

export interface OverlayInventoryEvidence {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly projectId: string;
  readonly snapshotGroupKey: string;
  readonly complete: boolean;
  readonly watermark: number;
  readonly deltaCount: number;
  readonly digest: string;
}

export interface OverlayDelta {
  readonly watermark: number;
  readonly deltaId: string;
  readonly projectId: string;
  readonly snapshotGroupKey: string;
  readonly headKey: string;
  readonly expectedBeforeDigest: string;
  readonly afterDigest: string;
}

export interface OverlayHead {
  readonly digest: string;
  readonly version: number;
}

export interface OverlayInventoryPort {
  readInventory(input: {
    readonly projectId: string;
    readonly snapshotGroupKey: string;
  }): Promise<OverlayInventoryEvidence>;
}

export interface OverlayDeltaReader {
  readDeltaRange(input: {
    readonly projectId: string;
    readonly snapshotGroupKey: string;
    readonly afterWatermark: number;
    readonly throughWatermark: number;
  }): Promise<readonly OverlayDelta[]>;
}

export interface OverlayProvider extends OverlayInventoryPort, OverlayDeltaReader {}

export interface OverlayCatchUpResult {
  readonly initialWatermark: number;
  readonly finalWatermark: number;
  readonly appliedDeltaIds: readonly string[];
  readonly heads: Readonly<Record<string, OverlayHead>>;
  readonly finalEvidence: OverlayInventoryEvidence;
}

export interface OverlayCatchUpInput {
  readonly mode: "PRODUCTION_ZERO" | "ADVERSARIAL";
  readonly projectId: string;
  readonly snapshotGroupKey: string;
  readonly stagedHeads: Readonly<Record<string, OverlayHead>>;
  readonly maximumRounds?: number;
}

export const zeroOverlayProviderId = "ontos.zero-overlay";
export const zeroOverlayProviderVersion = "1";

export class CertifiedZeroOverlayProvider implements OverlayProvider {
  readInventory(input: {
    readonly projectId: string;
    readonly snapshotGroupKey: string;
  }): Promise<OverlayInventoryEvidence> {
    return Promise.resolve({
      providerId: zeroOverlayProviderId,
      providerVersion: zeroOverlayProviderVersion,
      projectId: input.projectId,
      snapshotGroupKey: input.snapshotGroupKey,
      complete: true,
      watermark: 0,
      deltaCount: 0,
      digest: `sha256:${"0".repeat(64)}`,
    });
  }

  readDeltaRange(): Promise<readonly OverlayDelta[]> {
    return Promise.resolve([]);
  }
}

export async function catchUpOverlay(
  input: OverlayCatchUpInput,
  provider: OverlayProvider,
): Promise<OverlayCatchUpResult> {
  const maximumRounds = input.maximumRounds ?? 8;
  if (!Number.isSafeInteger(maximumRounds) || maximumRounds < 1 || maximumRounds > 64) {
    throw new OverlayCutoverError(
      "OVERLAY_DELTA_INVALID",
      "Overlay catch-up round limit is outside the supported range.",
    );
  }

  const heads: Record<string, OverlayHead> = Object.fromEntries(
    Object.entries(input.stagedHeads).map(([key, head]) => [key, structuredClone(head)]),
  );
  const appliedDeltaIds: string[] = [];
  const seenDeltaIds = new Set<string>();
  let current = await readEvidence(provider, input);
  const initialWatermark = current.watermark;
  assertProductionEvidence(input.mode, current);

  for (let round = 0; round < maximumRounds; round += 1) {
    const next = await readEvidence(provider, input);
    assertSameProvider(current, next);
    assertProductionEvidence(input.mode, next);
    if (next.watermark < current.watermark || next.deltaCount < current.deltaCount) {
      throw invalidEvidence("Overlay watermark and count must be monotonic.");
    }
    if (next.watermark === current.watermark) {
      if (next.deltaCount !== current.deltaCount || next.digest !== current.digest) {
        throw invalidEvidence("Stable Overlay watermark has inconsistent evidence.");
      }
      return Object.freeze({
        initialWatermark,
        finalWatermark: next.watermark,
        appliedDeltaIds: Object.freeze(appliedDeltaIds),
        heads: Object.freeze(heads),
        finalEvidence: Object.freeze(next),
      });
    }

    let deltas: readonly OverlayDelta[];
    try {
      deltas = await provider.readDeltaRange({
        projectId: input.projectId,
        snapshotGroupKey: input.snapshotGroupKey,
        afterWatermark: current.watermark,
        throughWatermark: next.watermark,
      });
    } catch (cause) {
      throw unavailable(cause);
    }
    const expectedCount = next.watermark - current.watermark;
    if (deltas.length !== expectedCount || next.deltaCount - current.deltaCount !== expectedCount) {
      throw invalidEvidence("Overlay delta range is incomplete or contains unexpected entries.");
    }

    for (const [index, delta] of deltas.entries()) {
      const expectedWatermark = current.watermark + index + 1;
      assertDelta(input, delta, expectedWatermark, seenDeltaIds);
      const head = heads[delta.headKey];
      if (head === undefined || head.digest !== delta.expectedBeforeDigest) {
        throw new OverlayCutoverError(
          "OVERLAY_DELTA_CONFLICT",
          "Overlay delta does not bind the staged Head it expected.",
        );
      }
      if (head.digest !== delta.afterDigest) {
        heads[delta.headKey] = { digest: delta.afterDigest, version: head.version + 1 };
      }
      seenDeltaIds.add(delta.deltaId);
      appliedDeltaIds.push(delta.deltaId);
    }
    current = next;
  }

  throw new OverlayCutoverError(
    "OVERLAY_CATCH_UP_UNSTABLE",
    "Overlay watermark did not stabilize inside the bounded catch-up loop.",
  );
}

async function readEvidence(
  provider: OverlayInventoryPort,
  input: OverlayCatchUpInput,
): Promise<OverlayInventoryEvidence> {
  let evidence: OverlayInventoryEvidence;
  try {
    evidence = await provider.readInventory({
      projectId: input.projectId,
      snapshotGroupKey: input.snapshotGroupKey,
    });
  } catch (cause) {
    throw unavailable(cause);
  }
  if (
    !evidence.complete ||
    !Number.isSafeInteger(evidence.watermark) ||
    evidence.watermark < 0 ||
    !Number.isSafeInteger(evidence.deltaCount) ||
    evidence.deltaCount < 0 ||
    !/^sha256:[0-9a-f]{64}$/u.test(evidence.digest)
  ) {
    throw new OverlayCutoverError(
      "OVERLAY_INVENTORY_UNAVAILABLE",
      "Overlay inventory is incomplete or invalid.",
    );
  }
  if (
    evidence.projectId !== input.projectId ||
    evidence.snapshotGroupKey !== input.snapshotGroupKey
  ) {
    throw new OverlayCutoverError(
      "OVERLAY_BINDING_MISMATCH",
      "Overlay inventory belongs to another Project or Snapshot Group.",
    );
  }
  return evidence;
}

function assertProductionEvidence(
  mode: OverlayCatchUpInput["mode"],
  evidence: OverlayInventoryEvidence,
): void {
  if (mode !== "PRODUCTION_ZERO") return;
  if (
    evidence.providerId !== zeroOverlayProviderId ||
    evidence.providerVersion !== zeroOverlayProviderVersion
  ) {
    throw new OverlayCutoverError(
      "OVERLAY_INVENTORY_UNAVAILABLE",
      "Production requires the registered zero-overlay Provider.",
    );
  }
  if (evidence.watermark !== 0 || evidence.deltaCount !== 0) {
    throw new OverlayCutoverError(
      "OVERLAY_NON_ZERO",
      "G2-02 production activation requires a certified empty Overlay.",
    );
  }
}

function assertSameProvider(
  before: OverlayInventoryEvidence,
  after: OverlayInventoryEvidence,
): void {
  if (before.providerId !== after.providerId || before.providerVersion !== after.providerVersion) {
    throw new OverlayCutoverError(
      "OVERLAY_INVENTORY_UNAVAILABLE",
      "Overlay Provider identity changed during catch-up.",
    );
  }
}

function assertDelta(
  input: OverlayCatchUpInput,
  delta: OverlayDelta,
  expectedWatermark: number,
  seenDeltaIds: ReadonlySet<string>,
): void {
  if (
    delta.watermark !== expectedWatermark ||
    delta.projectId !== input.projectId ||
    delta.snapshotGroupKey !== input.snapshotGroupKey ||
    delta.deltaId.trim() === "" ||
    seenDeltaIds.has(delta.deltaId) ||
    delta.headKey.trim() === "" ||
    !/^sha256:[0-9a-f]{64}$/u.test(delta.expectedBeforeDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(delta.afterDigest)
  ) {
    throw invalidEvidence("Overlay delta is out of range, duplicated or malformed.");
  }
}

function invalidEvidence(message: string): OverlayCutoverError {
  return new OverlayCutoverError("OVERLAY_DELTA_INVALID", message);
}

function unavailable(cause: unknown): OverlayCutoverError {
  return new OverlayCutoverError(
    "OVERLAY_INVENTORY_UNAVAILABLE",
    "Overlay Provider could not produce complete evidence.",
    { cause },
  );
}
