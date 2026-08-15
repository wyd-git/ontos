import assert from "node:assert/strict";
import test from "node:test";

import {
  catchUpOverlay,
  CertifiedZeroOverlayProvider,
  OverlayCutoverError,
  type OverlayDelta,
  type OverlayInventoryEvidence,
  type OverlayProvider,
} from "./overlay-cutover.ts";

const projectId = "00000000-0000-4000-8000-000000000001";
const snapshotGroupKey = "orders";
const digest0 = `sha256:${"0".repeat(64)}`;
const digest1 = `sha256:${"1".repeat(64)}`;
const digest2 = `sha256:${"2".repeat(64)}`;

void test("production activation accepts only certified stable zero Overlay", async () => {
  const result = await catchUpOverlay(
    {
      mode: "PRODUCTION_ZERO",
      projectId,
      snapshotGroupKey,
      stagedHeads: { order1: { digest: digest0, version: 7 } },
    },
    new CertifiedZeroOverlayProvider(),
  );
  assert.equal(result.initialWatermark, 0);
  assert.equal(result.finalWatermark, 0);
  assert.deepEqual(result.appliedDeltaIds, []);
  assert.deepEqual(result.heads.order1, { digest: digest0, version: 7 });
});

void test("production fails closed on unknown or non-zero evidence", async () => {
  const unknown = providerWithEvidence([
    evidence({ providerId: "unknown" }),
    evidence({ providerId: "unknown" }),
  ]);
  await assert.rejects(
    catchUpOverlay(baseInput("PRODUCTION_ZERO"), unknown),
    overlayError("OVERLAY_INVENTORY_UNAVAILABLE"),
  );

  const nonZero = providerWithEvidence([
    evidence({ watermark: 1, deltaCount: 1 }),
    evidence({ watermark: 1, deltaCount: 1 }),
  ]);
  await assert.rejects(
    catchUpOverlay(baseInput("PRODUCTION_ZERO"), nonZero),
    overlayError("OVERLAY_NON_ZERO"),
  );
});

void test("adversarial adapter catches up deltas injected after W0 in exact order", async () => {
  const deltas: OverlayDelta[] = [
    delta({ watermark: 1, deltaId: "d1", expectedBeforeDigest: digest0, afterDigest: digest1 }),
    delta({ watermark: 2, deltaId: "d2", expectedBeforeDigest: digest1, afterDigest: digest1 }),
    delta({ watermark: 3, deltaId: "d3", expectedBeforeDigest: digest1, afterDigest: digest2 }),
  ];
  const provider = providerWithEvidence(
    [
      evidence({ watermark: 0, deltaCount: 0 }),
      evidence({ watermark: 2, deltaCount: 2 }),
      evidence({ watermark: 3, deltaCount: 3 }),
      evidence({ watermark: 3, deltaCount: 3 }),
    ],
    deltas,
  );
  const result = await catchUpOverlay(baseInput("ADVERSARIAL"), provider);
  assert.deepEqual(result.appliedDeltaIds, ["d1", "d2", "d3"]);
  assert.equal(result.initialWatermark, 0);
  assert.equal(result.finalWatermark, 3);
  assert.deepEqual(result.heads.order1, { digest: digest2, version: 2 });
});

void test("delta gaps, stale Head conditions and Provider failures roll back the candidate", async () => {
  const original = baseInput("ADVERSARIAL");
  const gap = providerWithEvidence(
    [evidence({ watermark: 0, deltaCount: 0 }), evidence({ watermark: 2, deltaCount: 2 })],
    [delta({ watermark: 2, deltaId: "gap", afterDigest: digest1 })],
  );
  await assert.rejects(catchUpOverlay(original, gap), overlayError("OVERLAY_DELTA_INVALID"));
  assert.deepEqual(original.stagedHeads.order1, { digest: digest0, version: 0 });

  const conflict = providerWithEvidence(
    [evidence({ watermark: 0, deltaCount: 0 }), evidence({ watermark: 1, deltaCount: 1 })],
    [delta({ watermark: 1, deltaId: "conflict", expectedBeforeDigest: digest2 })],
  );
  await assert.rejects(catchUpOverlay(original, conflict), overlayError("OVERLAY_DELTA_CONFLICT"));
  assert.deepEqual(original.stagedHeads.order1, { digest: digest0, version: 0 });

  const failure: OverlayProvider = {
    readInventory() {
      return Promise.reject(new Error("provider secret detail"));
    },
    readDeltaRange() {
      return Promise.resolve([]);
    },
  };
  await assert.rejects(
    catchUpOverlay(original, failure),
    overlayError("OVERLAY_INVENTORY_UNAVAILABLE"),
  );
});

function baseInput(mode: "PRODUCTION_ZERO" | "ADVERSARIAL") {
  return {
    mode,
    projectId,
    snapshotGroupKey,
    stagedHeads: { order1: { digest: digest0, version: 0 } },
  } as const;
}

function evidence(overrides: Partial<OverlayInventoryEvidence> = {}): OverlayInventoryEvidence {
  return {
    providerId: "ontos.zero-overlay",
    providerVersion: "1",
    projectId,
    snapshotGroupKey,
    complete: true,
    watermark: 0,
    deltaCount: 0,
    digest: digest0,
    ...overrides,
  };
}

function delta(overrides: Partial<OverlayDelta>): OverlayDelta {
  return {
    watermark: 1,
    deltaId: "d1",
    projectId,
    snapshotGroupKey,
    headKey: "order1",
    expectedBeforeDigest: digest0,
    afterDigest: digest1,
    ...overrides,
  };
}

function providerWithEvidence(
  values: readonly OverlayInventoryEvidence[],
  deltas: readonly OverlayDelta[] = [],
): OverlayProvider {
  let evidenceIndex = 0;
  return {
    readInventory() {
      const value = values[Math.min(evidenceIndex, values.length - 1)];
      evidenceIndex += 1;
      if (value === undefined) return Promise.reject(new Error("missing evidence"));
      return Promise.resolve(structuredClone(value));
    },
    readDeltaRange(input) {
      return Promise.resolve(
        deltas.filter(
          (item) =>
            item.watermark > input.afterWatermark && item.watermark <= input.throughWatermark,
        ),
      );
    },
  };
}

function overlayError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof OverlayCutoverError && error.code === code;
}
