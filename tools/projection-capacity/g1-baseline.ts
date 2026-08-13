export const KIB = 1_024n;
export const MIB = 1_024n * KIB;
export const GIB = 1_024n * MIB;

export const G1_INDEX_COST_BASELINE = Object.freeze({
  evidenceResultSha256: "7b39f705e61d1b7d97bc0fb3d2acb5b546de61d4a473585007fc5eb452730201",
  summaryFileSha256: "6e1259749f0d020237095d1cedb01e30069685e1b6d22acb2e205a68bbf2591b",
  benchmarkFileSha256: "36e97ff607450b8234a93abcb75ef6ac276d0b46c7167f9526c0821cfd9fb55f",
  schemaFileSha256: "897c86436696960dd04be9150118f31108ea76c3083c3a7c0152079c85b40cdc",
  indexesFileSha256: "34d1366e6b3a5ee6725f30b8c107a2c57b023d60181631caaf7a7d35738b31a6",
  physicalObjectRows: 200_000n,
  physicalLinkRows: 2_000_000n,
  objectHeapBytes: 113_131_520n,
  objectIndexBytes: 151_117_824n,
  linkHeapBytes: 233_906_176n,
  linkIndexBytes: 544_129_024n,
  activeObjectRows: 100_000n,
  activeLinkRows: 1_000_000n,
  identityOnlyWriteMedianMicros: 387_298n,
  metadataIndexedWriteMedianMicros: 1_384_235n,
  metadataWriteAmplificationMilli: 3_574n,
  referenceSecondaryIndexUnitsPerObjectRow: 13n,
});

export const DEFAULT_MEASUREMENT_SAFETY_BPS = 15_000n;

export interface ObjectProjectionEstimate {
  rows: bigint;
  secondaryIndexUnitsPerRow: bigint;
  heapBytes: bigint;
  indexBytes: bigint;
  measuredBytes: bigint;
  reservedBytes: bigint;
  estimatedWriteAmplificationMilli: bigint;
}

export interface LinkProjectionEstimate {
  rows: bigint;
  heapBytes: bigint;
  indexBytes: bigint;
  measuredBytes: bigint;
  reservedBytes: bigint;
}

export interface FullProjectionEstimate {
  objects: ObjectProjectionEstimate;
  links: LinkProjectionEstimate;
  measuredBytes: bigint;
  reservedBytes: bigint;
}

export function estimateObjectProjection(
  rows: bigint,
  secondaryIndexUnitsPerRow: bigint,
  safetyBps = DEFAULT_MEASUREMENT_SAFETY_BPS,
): ObjectProjectionEstimate {
  assertNonNegative(rows, "Object row count");
  assertNonNegative(secondaryIndexUnitsPerRow, "Object secondary index units");
  assertSafetyBps(safetyBps);

  const baseline = G1_INDEX_COST_BASELINE;
  const heapBytes = ceilRatio(baseline.objectHeapBytes * rows, baseline.physicalObjectRows);
  const effectiveUnits = maxBigInt(
    secondaryIndexUnitsPerRow,
    baseline.referenceSecondaryIndexUnitsPerObjectRow,
  );
  const indexBytes = ceilRatio(
    baseline.objectIndexBytes * rows * effectiveUnits,
    baseline.physicalObjectRows * baseline.referenceSecondaryIndexUnitsPerObjectRow,
  );
  const measuredBytes = heapBytes + indexBytes;
  const additionalWriteAmplification = baseline.metadataWriteAmplificationMilli - 1_000n;
  const estimatedWriteAmplificationMilli =
    1_000n +
    ceilRatio(
      additionalWriteAmplification * secondaryIndexUnitsPerRow,
      baseline.referenceSecondaryIndexUnitsPerObjectRow,
    );

  return {
    rows,
    secondaryIndexUnitsPerRow,
    heapBytes,
    indexBytes,
    measuredBytes,
    reservedBytes: applySafetyMargin(measuredBytes, safetyBps),
    estimatedWriteAmplificationMilli,
  };
}

export function estimateLinkProjection(
  rows: bigint,
  safetyBps = DEFAULT_MEASUREMENT_SAFETY_BPS,
): LinkProjectionEstimate {
  assertNonNegative(rows, "Link row count");
  assertSafetyBps(safetyBps);
  const baseline = G1_INDEX_COST_BASELINE;
  const heapBytes = ceilRatio(baseline.linkHeapBytes * rows, baseline.physicalLinkRows);
  const indexBytes = ceilRatio(baseline.linkIndexBytes * rows, baseline.physicalLinkRows);
  const measuredBytes = heapBytes + indexBytes;
  return {
    rows,
    heapBytes,
    indexBytes,
    measuredBytes,
    reservedBytes: applySafetyMargin(measuredBytes, safetyBps),
  };
}

export function estimateFullProjection(
  objectRows: bigint,
  linkRows: bigint,
  secondaryIndexUnitsPerObjectRow = G1_INDEX_COST_BASELINE.referenceSecondaryIndexUnitsPerObjectRow,
  safetyBps = DEFAULT_MEASUREMENT_SAFETY_BPS,
): FullProjectionEstimate {
  const objects = estimateObjectProjection(objectRows, secondaryIndexUnitsPerObjectRow, safetyBps);
  const links = estimateLinkProjection(linkRows, safetyBps);
  return {
    objects,
    links,
    measuredBytes: objects.measuredBytes + links.measuredBytes,
    reservedBytes: objects.reservedBytes + links.reservedBytes,
  };
}

export function applySafetyMargin(bytes: bigint, safetyBps: bigint): bigint {
  assertNonNegative(bytes, "Bytes");
  assertSafetyBps(safetyBps);
  return ceilRatio(bytes * safetyBps, 10_000n);
}

export function ceilRatio(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new Error("ceilRatio requires a non-negative numerator and positive denominator.");
  }
  if (numerator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

function assertNonNegative(value: bigint, label: string): void {
  if (value < 0n) throw new Error(`${label} must be non-negative.`);
}

function assertSafetyBps(value: bigint): void {
  if (value < 10_000n) throw new Error("Measurement safety margin cannot be below 100%. ");
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
