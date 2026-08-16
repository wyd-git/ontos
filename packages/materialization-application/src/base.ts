import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseOntosId,
  type ArtifactDigest,
} from "@ontos/contracts";
import type {
  CanonicalJsonMappedValue,
  MappingAcceptedLinkRow,
  MappingAcceptedObjectRow,
  MappedProperty,
  MappedPropertyValue,
} from "@ontos/materialization-domain";

export const MATERIALIZATION_BASE_BATCH_MAXIMUM_ROWS = 5_000;

export type MaterializationBaseErrorCode =
  | "BASE_REQUEST_INVALID"
  | "DEPENDENCY_UNAVAILABLE"
  | "LINK_ENDPOINT_COLLISION"
  | "LINK_ENDPOINT_DANGLING"
  | "LINK_ENDPOINT_TYPE_INVALID"
  | "MATERIALIZATION_ATTEMPT_FENCED"
  | "MATERIALIZATION_BASE_CONFLICT"
  | "OBJECT_IDENTITY_CONFLICT"
  | "PRIMARY_KEY_COLLISION";

const baseErrorMessages = Object.freeze({
  BASE_REQUEST_INVALID: "The materialization Base request is invalid.",
  DEPENDENCY_UNAVAILABLE: "A materialization Base dependency is temporarily unavailable.",
  LINK_ENDPOINT_COLLISION: "The batch contains duplicate canonical Link endpoints.",
  LINK_ENDPOINT_DANGLING: "One or more Link endpoints do not resolve to an Object identity.",
  LINK_ENDPOINT_TYPE_INVALID: "A Link endpoint does not match its pinned Object Type.",
  MATERIALIZATION_ATTEMPT_FENCED: "The materialization Attempt no longer owns its lease.",
  MATERIALIZATION_BASE_CONFLICT: "The immutable materialization Base conflicts with this Attempt.",
  OBJECT_IDENTITY_CONFLICT: "The permanent Object identity could not be resolved safely.",
  PRIMARY_KEY_COLLISION: "The batch contains duplicate canonical Primary Keys.",
} satisfies Readonly<Record<MaterializationBaseErrorCode, string>>);

export class MaterializationBaseError extends Error {
  readonly code: MaterializationBaseErrorCode;

  constructor(code: MaterializationBaseErrorCode) {
    super(baseErrorMessages[code]);
    this.name = "MaterializationBaseError";
    this.code = code;
  }
}

export interface MaterializationAttemptScope {
  readonly projectId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly fencingToken: bigint;
}

export interface MaterializationGenerationBinding {
  readonly generationId: string;
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly sourceSnapshotId: string;
  readonly sourceFileId: string;
  readonly mappingRevisionId: string;
}

export interface ObjectIdentityCandidate {
  readonly ordinal: number;
  readonly objectTypeResourceId: string;
  readonly canonicalPrimaryKey: string;
  readonly candidateObjectRid: string;
}

export interface ObjectIdentityLookup {
  readonly ordinal: number;
  readonly objectTypeResourceId: string;
  readonly objectTypeRevisionId: string;
  readonly canonicalPrimaryKey: string;
}

export interface ObjectIdentityResolution {
  readonly ordinal: number;
  readonly objectRid: string;
}

export interface ObjectBaseStageRow {
  readonly objectRid: string;
  readonly canonicalPrimaryKey: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly sourceRowNumber: number;
  readonly valueDigest: ArtifactDigest;
}

export interface LinkBaseStageRow {
  readonly linkRid: string;
  readonly sourceObjectTypeResourceId: string;
  readonly sourceObjectTypeRevisionId: string;
  readonly sourceObjectRid: string;
  readonly targetObjectTypeResourceId: string;
  readonly targetObjectTypeRevisionId: string;
  readonly targetObjectRid: string;
  readonly sourceRowNumber: number;
  readonly valueDigest: ArtifactDigest;
}

export interface StageBaseBatchInput<Row> {
  readonly scope: MaterializationAttemptScope;
  readonly generation: MaterializationGenerationBinding;
  readonly batchSequence: number;
  readonly batchDigest: ArtifactDigest;
  readonly rows: readonly Row[];
}

export interface MaterializationBasePromotion {
  readonly rowCount: number;
  readonly stageDigest: ArtifactDigest;
  readonly reused: boolean;
}

export interface MaterializationBaseRepository {
  resolveOrCreateObjectIdentities(input: {
    readonly projectId: string;
    readonly candidates: readonly ObjectIdentityCandidate[];
  }): Promise<readonly ObjectIdentityResolution[]>;
  lookupObjectIdentities(input: {
    readonly projectId: string;
    readonly lookups: readonly ObjectIdentityLookup[];
  }): Promise<readonly ObjectIdentityResolution[]>;
  stageObjectBaseBatch(input: StageBaseBatchInput<ObjectBaseStageRow>): Promise<void>;
  stageLinkBaseBatch(input: StageBaseBatchInput<LinkBaseStageRow>): Promise<void>;
  promoteGenerationBase(input: {
    readonly scope: MaterializationAttemptScope;
    readonly generationId: string;
    readonly expectedRowCount: number;
    readonly expectedStageDigest: ArtifactDigest;
  }): Promise<MaterializationBasePromotion>;
}

export interface MaterializationBaseCrypto {
  randomId(): string;
  digestCanonicalText(value: string): ArtifactDigest;
}

export interface StageObjectBatchRequest {
  readonly scope: MaterializationAttemptScope;
  readonly generation: MaterializationGenerationBinding;
  readonly batchSequence: number;
  readonly rows: readonly MappingAcceptedObjectRow[];
}

export interface StageLinkBatchRequest {
  readonly scope: MaterializationAttemptScope;
  readonly generation: MaterializationGenerationBinding;
  readonly batchSequence: number;
  readonly rows: readonly MappingAcceptedLinkRow[];
}

export interface BaseBatchReceipt {
  readonly batchSequence: number;
  readonly inputRowCount: number;
  readonly stagedRowCount: number;
  readonly batchDigest: ArtifactDigest;
}

export interface DanglingLinkCandidate {
  readonly rowNumber: number;
  readonly missingEndpoints: readonly ("source" | "target")[];
  readonly fingerprint: ArtifactDigest;
}

export interface LinkBaseBatchReceipt extends BaseBatchReceipt {
  readonly dangling: readonly DanglingLinkCandidate[];
}

export interface MaterializationBaseServiceOptions {
  readonly repository: MaterializationBaseRepository;
  readonly crypto: MaterializationBaseCrypto;
}

export class MaterializationBaseService {
  readonly #repository: MaterializationBaseRepository;
  readonly #crypto: MaterializationBaseCrypto;

  constructor(options: MaterializationBaseServiceOptions) {
    this.#repository = options.repository;
    this.#crypto = options.crypto;
  }

  async stageObjectBatch(input: StageObjectBatchRequest): Promise<BaseBatchReceipt> {
    const scope = parseScope(input.scope);
    const generation = parseGeneration(input.generation);
    const batchSequence = parseBatchSequence(input.batchSequence);
    const rows = parseObjectRows(input.rows, generation);
    assertDistinctObjectPrimaryKeys(rows);

    const candidates = rows
      .map((row, ordinal) => ({
        ordinal,
        objectTypeResourceId: row.targetResourceId,
        canonicalPrimaryKey: row.canonicalPrimaryKey,
        candidateObjectRid: parseOntosId(this.#crypto.randomId(), "$candidateObjectRid"),
      }))
      .sort(compareIdentityCandidate);
    const resolved = await mapRepositoryFailure(() =>
      this.#repository.resolveOrCreateObjectIdentities({
        projectId: scope.projectId,
        candidates,
      }),
    );
    const identities = resolutionMap(resolved, rows.length, "OBJECT_IDENTITY_CONFLICT");

    const stagedRows = rows.map((row, ordinal): ObjectBaseStageRow => {
      const objectRid = identities.get(ordinal);
      if (objectRid === undefined) throw new MaterializationBaseError("OBJECT_IDENTITY_CONFLICT");
      const properties = encodeProperties(row.properties);
      const valueDigest = digest(this.#crypto, {
        schemaVersion: 1,
        contractVersion: "object-base-value-v1",
        valueCodecVersion: "pk1",
        targetResourceId: row.targetResourceId,
        targetRevisionId: row.targetRevisionId,
        canonicalPrimaryKey: row.canonicalPrimaryKey,
        properties,
      });
      return Object.freeze({
        objectRid,
        canonicalPrimaryKey: row.canonicalPrimaryKey,
        properties,
        sourceRowNumber: row.rowNumber,
        valueDigest,
      });
    });
    const batchDigest = objectBatchDigest(this.#crypto, generation, batchSequence, stagedRows);
    await mapRepositoryFailure(() =>
      this.#repository.stageObjectBaseBatch({
        scope,
        generation,
        batchSequence,
        batchDigest,
        rows: stagedRows,
      }),
    );
    return Object.freeze({
      batchSequence,
      inputRowCount: rows.length,
      stagedRowCount: stagedRows.length,
      batchDigest,
    });
  }

  async stageLinkBatch(input: StageLinkBatchRequest): Promise<LinkBaseBatchReceipt> {
    const scope = parseScope(input.scope);
    const generation = parseGeneration(input.generation);
    const batchSequence = parseBatchSequence(input.batchSequence);
    const rows = parseLinkRows(input.rows, generation);
    const lookupPlan = buildLookupPlan(rows);
    const resolved = await mapRepositoryFailure(() =>
      this.#repository.lookupObjectIdentities({
        projectId: scope.projectId,
        lookups: lookupPlan.lookups,
      }),
    );
    const identities = partialResolutionMap(resolved, lookupPlan.lookups.length);
    const dangling: DanglingLinkCandidate[] = [];
    const stagedRows: LinkBaseStageRow[] = [];
    const seenEndpoints = new Set<string>();

    for (const [rowIndex, row] of rows.entries()) {
      const sourceOrdinal = lookupPlan.sourceOrdinals[rowIndex];
      const targetOrdinal = lookupPlan.targetOrdinals[rowIndex];
      if (sourceOrdinal === undefined || targetOrdinal === undefined) {
        throw new MaterializationBaseError("DEPENDENCY_UNAVAILABLE");
      }
      const sourceRid = identities.get(sourceOrdinal);
      const targetRid = identities.get(targetOrdinal);
      if (sourceRid === undefined || targetRid === undefined) {
        const missingEndpoints = Object.freeze([
          ...(sourceRid === undefined ? (["source"] as const) : []),
          ...(targetRid === undefined ? (["target"] as const) : []),
        ]);
        dangling.push(
          Object.freeze({
            rowNumber: row.rowNumber,
            missingEndpoints,
            fingerprint: digest(this.#crypto, {
              schemaVersion: 1,
              contractVersion: "dangling-link-fingerprint-v1",
              targetResourceId: row.targetResourceId,
              targetRevisionId: row.targetRevisionId,
              sourceTypeResourceId: row.sourceLookup.objectTypeResourceId,
              sourceTypeRevisionId: row.sourceLookup.objectTypeRevisionId,
              sourceKeyDigest: digestTextOnly(this.#crypto, row.sourceLookup.canonicalPrimaryKey),
              targetTypeResourceId: row.targetLookup.objectTypeResourceId,
              targetTypeRevisionId: row.targetLookup.objectTypeRevisionId,
              targetKeyDigest: digestTextOnly(this.#crypto, row.targetLookup.canonicalPrimaryKey),
            }),
          }),
        );
        continue;
      }
      const endpointKey = `${row.targetResourceId}\u0000${sourceRid}\u0000${targetRid}`;
      if (seenEndpoints.has(endpointKey)) {
        throw new MaterializationBaseError("LINK_ENDPOINT_COLLISION");
      }
      seenEndpoints.add(endpointKey);
      const linkRid = deterministicUuid(
        digest(this.#crypto, {
          schemaVersion: 1,
          contractVersion: "link-rid-v1",
          projectId: scope.projectId,
          generationId: generation.generationId,
          linkTypeResourceId: row.targetResourceId,
          sourceObjectRid: sourceRid,
          targetObjectRid: targetRid,
        }),
      );
      const valueDigest = digest(this.#crypto, {
        schemaVersion: 1,
        contractVersion: "link-base-value-v1",
        targetResourceId: row.targetResourceId,
        targetRevisionId: row.targetRevisionId,
        sourceObjectTypeResourceId: row.sourceLookup.objectTypeResourceId,
        sourceObjectTypeRevisionId: row.sourceLookup.objectTypeRevisionId,
        sourceObjectRid: sourceRid,
        targetObjectTypeResourceId: row.targetLookup.objectTypeResourceId,
        targetObjectTypeRevisionId: row.targetLookup.objectTypeRevisionId,
        targetObjectRid: targetRid,
      });
      stagedRows.push(
        Object.freeze({
          linkRid,
          sourceObjectTypeResourceId: row.sourceLookup.objectTypeResourceId,
          sourceObjectTypeRevisionId: row.sourceLookup.objectTypeRevisionId,
          sourceObjectRid: sourceRid,
          targetObjectTypeResourceId: row.targetLookup.objectTypeResourceId,
          targetObjectTypeRevisionId: row.targetLookup.objectTypeRevisionId,
          targetObjectRid: targetRid,
          sourceRowNumber: row.rowNumber,
          valueDigest,
        }),
      );
    }

    const batchDigest = linkBatchDigest(
      this.#crypto,
      generation,
      batchSequence,
      stagedRows,
      dangling,
    );
    await mapRepositoryFailure(() =>
      this.#repository.stageLinkBaseBatch({
        scope,
        generation,
        batchSequence,
        batchDigest,
        rows: stagedRows,
      }),
    );
    return Object.freeze({
      batchSequence,
      inputRowCount: rows.length,
      stagedRowCount: stagedRows.length,
      batchDigest,
      dangling: Object.freeze(dangling),
    });
  }

  async promoteGenerationBase(input: {
    readonly scope: MaterializationAttemptScope;
    readonly generationId: string;
    readonly expectedRowCount: number;
    readonly batchReceipts: readonly BaseBatchReceipt[];
  }): Promise<MaterializationBasePromotion> {
    const scope = parseScope(input.scope);
    const generationId = parseOntosId(input.generationId, "$generationId");
    if (!Number.isSafeInteger(input.expectedRowCount) || input.expectedRowCount < 0) {
      throw new MaterializationBaseError("BASE_REQUEST_INVALID");
    }
    const receipts = [...input.batchReceipts].sort(
      (left, right) => left.batchSequence - right.batchSequence,
    );
    if (
      (receipts.length === 0 && input.expectedRowCount !== 0) ||
      receipts.some(
        (receipt, index) =>
          !Number.isSafeInteger(receipt.batchSequence) ||
          receipt.batchSequence < 1 ||
          (index > 0 && receipt.batchSequence <= (receipts[index - 1]?.batchSequence ?? 0)) ||
          receipt.stagedRowCount < 0 ||
          !Number.isSafeInteger(receipt.stagedRowCount),
      ) ||
      receipts.reduce((count, receipt) => count + receipt.stagedRowCount, 0) !==
        input.expectedRowCount
    ) {
      throw new MaterializationBaseError("BASE_REQUEST_INVALID");
    }
    const expectedStageDigest = stageDigest(this.#crypto, generationId, receipts);
    return mapRepositoryFailure(() =>
      this.#repository.promoteGenerationBase({
        scope,
        generationId,
        expectedRowCount: input.expectedRowCount,
        expectedStageDigest,
      }),
    );
  }
}

function parseScope(input: MaterializationAttemptScope): MaterializationAttemptScope {
  try {
    if (typeof input.fencingToken !== "bigint" || input.fencingToken < 1n) {
      throw new TypeError("invalid fencing token");
    }
    return Object.freeze({
      projectId: parseOntosId(input.projectId, "$scope.projectId"),
      jobId: parseOntosId(input.jobId, "$scope.jobId"),
      attemptId: parseOntosId(input.attemptId, "$scope.attemptId"),
      fencingToken: input.fencingToken,
    });
  } catch (error) {
    throw invalidRequest(error);
  }
}

function parseGeneration(
  input: MaterializationGenerationBinding,
): MaterializationGenerationBinding {
  try {
    return Object.freeze({
      generationId: parseOntosId(input.generationId, "$generation.generationId"),
      targetResourceId: parseOntosId(input.targetResourceId, "$generation.targetResourceId"),
      targetRevisionId: parseOntosId(input.targetRevisionId, "$generation.targetRevisionId"),
      sourceSnapshotId: parseOntosId(input.sourceSnapshotId, "$generation.sourceSnapshotId"),
      sourceFileId: parseOntosId(input.sourceFileId, "$generation.sourceFileId"),
      mappingRevisionId: parseOntosId(input.mappingRevisionId, "$generation.mappingRevisionId"),
    });
  } catch (error) {
    throw invalidRequest(error);
  }
}

function parseBatchSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MaterializationBaseError("BASE_REQUEST_INVALID");
  }
  return value;
}

function parseObjectRows(
  input: readonly MappingAcceptedObjectRow[],
  generation: MaterializationGenerationBinding,
): readonly MappingAcceptedObjectRow[] {
  if (
    !isRuntimeArray(input) ||
    input.length < 1 ||
    input.length > MATERIALIZATION_BASE_BATCH_MAXIMUM_ROWS
  ) {
    throw new MaterializationBaseError("BASE_REQUEST_INVALID");
  }
  for (const row of input) {
    if (
      row.kind !== "object" ||
      !Number.isSafeInteger(row.rowNumber) ||
      row.rowNumber < 1 ||
      row.targetResourceId !== generation.targetResourceId ||
      row.targetRevisionId !== generation.targetRevisionId ||
      typeof row.canonicalPrimaryKey !== "string" ||
      Buffer.byteLength(row.canonicalPrimaryKey, "utf8") < 1 ||
      Buffer.byteLength(row.canonicalPrimaryKey, "utf8") > 1_024 ||
      !isRuntimeArray(row.properties)
    ) {
      throw new MaterializationBaseError("BASE_REQUEST_INVALID");
    }
  }
  return input;
}

function parseLinkRows(
  input: readonly MappingAcceptedLinkRow[],
  generation: MaterializationGenerationBinding,
): readonly MappingAcceptedLinkRow[] {
  if (
    !isRuntimeArray(input) ||
    input.length < 1 ||
    input.length > MATERIALIZATION_BASE_BATCH_MAXIMUM_ROWS
  ) {
    throw new MaterializationBaseError("BASE_REQUEST_INVALID");
  }
  try {
    for (const row of input) {
      if (
        row.kind !== "link" ||
        !Number.isSafeInteger(row.rowNumber) ||
        row.rowNumber < 1 ||
        row.targetResourceId !== generation.targetResourceId ||
        row.targetRevisionId !== generation.targetRevisionId
      ) {
        throw new TypeError("invalid link row");
      }
      for (const lookup of [row.sourceLookup, row.targetLookup]) {
        parseOntosId(lookup.objectTypeResourceId);
        parseOntosId(lookup.objectTypeRevisionId);
        if (
          typeof lookup.canonicalPrimaryKey !== "string" ||
          Buffer.byteLength(lookup.canonicalPrimaryKey, "utf8") < 1 ||
          Buffer.byteLength(lookup.canonicalPrimaryKey, "utf8") > 1_024
        ) {
          throw new TypeError("invalid link lookup");
        }
      }
    }
    return input;
  } catch (error) {
    throw invalidRequest(error);
  }
}

function assertDistinctObjectPrimaryKeys(rows: readonly MappingAcceptedObjectRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.targetResourceId}\u0000${row.canonicalPrimaryKey}`;
    if (seen.has(key)) throw new MaterializationBaseError("PRIMARY_KEY_COLLISION");
    seen.add(key);
  }
}

function buildLookupPlan(rows: readonly MappingAcceptedLinkRow[]): {
  readonly lookups: readonly ObjectIdentityLookup[];
  readonly sourceOrdinals: readonly number[];
  readonly targetOrdinals: readonly number[];
} {
  const lookups: ObjectIdentityLookup[] = [];
  const ordinals = new Map<string, number>();
  const sourceOrdinals: number[] = [];
  const targetOrdinals: number[] = [];
  const add = (lookup: MappingAcceptedLinkRow["sourceLookup"]): number => {
    const key = `${lookup.objectTypeResourceId}\u0000${lookup.objectTypeRevisionId}\u0000${lookup.canonicalPrimaryKey}`;
    const existing = ordinals.get(key);
    if (existing !== undefined) return existing;
    const ordinal = lookups.length;
    ordinals.set(key, ordinal);
    lookups.push(
      Object.freeze({
        ordinal,
        objectTypeResourceId: lookup.objectTypeResourceId,
        objectTypeRevisionId: lookup.objectTypeRevisionId,
        canonicalPrimaryKey: lookup.canonicalPrimaryKey,
      }),
    );
    return ordinal;
  };
  for (const row of rows) {
    sourceOrdinals.push(add(row.sourceLookup));
    targetOrdinals.push(add(row.targetLookup));
  }
  return Object.freeze({
    lookups: Object.freeze(lookups),
    sourceOrdinals: Object.freeze(sourceOrdinals),
    targetOrdinals: Object.freeze(targetOrdinals),
  });
}

function resolutionMap(
  resolutions: readonly ObjectIdentityResolution[],
  expectedCount: number,
  code: MaterializationBaseErrorCode,
): ReadonlyMap<number, string> {
  const result = partialResolutionMap(resolutions, expectedCount);
  if (result.size !== expectedCount) throw new MaterializationBaseError(code);
  return result;
}

function partialResolutionMap(
  resolutions: readonly ObjectIdentityResolution[],
  maximumCount: number,
): ReadonlyMap<number, string> {
  const result = new Map<number, string>();
  try {
    for (const resolution of resolutions) {
      if (
        !Number.isSafeInteger(resolution.ordinal) ||
        resolution.ordinal < 0 ||
        resolution.ordinal >= maximumCount ||
        result.has(resolution.ordinal)
      ) {
        throw new TypeError("invalid identity resolution");
      }
      result.set(resolution.ordinal, parseOntosId(resolution.objectRid));
    }
    return result;
  } catch {
    throw new MaterializationBaseError("DEPENDENCY_UNAVAILABLE");
  }
}

function encodeProperties(
  properties: readonly MappedProperty[],
): Readonly<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const property of properties) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,62}$/u.test(property.propertyApiName) ||
      Object.hasOwn(values, property.propertyApiName)
    ) {
      throw new MaterializationBaseError("BASE_REQUEST_INVALID");
    }
    values[property.propertyApiName] = Object.freeze({
      valueType: property.valueType,
      value: encodeMappedValue(property.value),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    valueCodecVersion: "pk1",
    values: Object.freeze(values),
  });
}

function encodeMappedValue(value: MappedPropertyValue): unknown {
  if (isRuntimeArray(value)) {
    return Object.freeze([...(value as readonly string[])]);
  }
  if (isCanonicalJson(value)) return Object.freeze({ canonicalJson: value.canonicalJson });
  return value;
}

function isCanonicalJson(value: MappedPropertyValue): value is CanonicalJsonMappedValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "canonical_json"
  );
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function objectBatchDigest(
  crypto: MaterializationBaseCrypto,
  generation: MaterializationGenerationBinding,
  batchSequence: number,
  rows: readonly ObjectBaseStageRow[],
): ArtifactDigest {
  return digest(crypto, {
    schemaVersion: 1,
    contractVersion: "object-base-batch-v1",
    generationId: generation.generationId,
    targetResourceId: generation.targetResourceId,
    targetRevisionId: generation.targetRevisionId,
    sourceSnapshotId: generation.sourceSnapshotId,
    sourceFileId: generation.sourceFileId,
    mappingRevisionId: generation.mappingRevisionId,
    batchSequence,
    rows: [...rows]
      .sort((left, right) => compareText(left.canonicalPrimaryKey, right.canonicalPrimaryKey))
      .map(({ objectRid, canonicalPrimaryKey, sourceRowNumber, valueDigest }) => ({
        objectRid,
        canonicalPrimaryKey,
        sourceRowNumber,
        valueDigest,
      })),
  });
}

function linkBatchDigest(
  crypto: MaterializationBaseCrypto,
  generation: MaterializationGenerationBinding,
  batchSequence: number,
  rows: readonly LinkBaseStageRow[],
  dangling: readonly DanglingLinkCandidate[],
): ArtifactDigest {
  return digest(crypto, {
    schemaVersion: 1,
    contractVersion: "link-base-batch-v1",
    generationId: generation.generationId,
    targetResourceId: generation.targetResourceId,
    targetRevisionId: generation.targetRevisionId,
    sourceSnapshotId: generation.sourceSnapshotId,
    sourceFileId: generation.sourceFileId,
    mappingRevisionId: generation.mappingRevisionId,
    batchSequence,
    rows: [...rows]
      .sort((left, right) => compareText(left.linkRid, right.linkRid))
      .map(({ linkRid, sourceObjectRid, targetObjectRid, sourceRowNumber, valueDigest }) => ({
        linkRid,
        sourceObjectRid,
        targetObjectRid,
        sourceRowNumber,
        valueDigest,
      })),
    dangling: [...dangling]
      .sort((left, right) => left.rowNumber - right.rowNumber)
      .map(({ rowNumber, missingEndpoints, fingerprint }) => ({
        rowNumber,
        missingEndpoints,
        fingerprint,
      })),
  });
}

function stageDigest(
  crypto: MaterializationBaseCrypto,
  generationId: string,
  receipts: readonly BaseBatchReceipt[],
): ArtifactDigest {
  return digest(crypto, {
    schemaVersion: 1,
    contractVersion: "base-stage-v1",
    generationId,
    batches: receipts.map(({ batchSequence, batchDigest, stagedRowCount }) => ({
      batchSequence,
      batchDigest,
      rowCount: stagedRowCount,
    })),
  });
}

function deterministicUuid(value: ArtifactDigest): string {
  const source = value.slice("sha256:".length, "sha256:".length + 32).split("");
  source[12] = "5";
  const variant = Number.parseInt(source[16] ?? "0", 16);
  source[16] = ((variant & 0x3) | 0x8).toString(16);
  const hex = source.join("");
  return parseOntosId(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

function digest(crypto: MaterializationBaseCrypto, value: unknown): ArtifactDigest {
  return parseArtifactDigest(
    crypto.digestCanonicalText(canonicalizeContractForDigest(value)),
    "$materializationBaseDigest",
  );
}

function digestTextOnly(crypto: MaterializationBaseCrypto, value: string): ArtifactDigest {
  return parseArtifactDigest(crypto.digestCanonicalText(value), "$materializationBaseFingerprint");
}

function compareIdentityCandidate(
  left: ObjectIdentityCandidate,
  right: ObjectIdentityCandidate,
): number {
  return (
    compareText(left.objectTypeResourceId, right.objectTypeResourceId) ||
    compareText(left.canonicalPrimaryKey, right.canonicalPrimaryKey)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidRequest(cause: unknown): MaterializationBaseError {
  return cause instanceof MaterializationBaseError
    ? cause
    : new MaterializationBaseError("BASE_REQUEST_INVALID");
}

async function mapRepositoryFailure<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MaterializationBaseError) throw error;
    throw new MaterializationBaseError("DEPENDENCY_UNAVAILABLE");
  }
}
