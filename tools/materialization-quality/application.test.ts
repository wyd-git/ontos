import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseCanonicalInstant,
  type ArtifactDigest,
} from "@ontos/contracts";
import {
  MaterializationQualityError,
  MaterializationQualityService,
  REJECTED_ROW_MEDIA_TYPE,
  RowCountConfirmationService,
  observationsFromMappingRejections,
  provenanceTemplatesFromPlan,
  type FinalizedQualityResult,
  type MaterializationQualityObservation,
  type MaterializationQualityRepository,
  type MaterializationQualityScopeRecord,
  type PreparedQualitySummary,
  type QualityObservationCursor,
  type RejectedArtifactBinding,
  type RowCountConfirmationRecord,
  type RowCountConfirmationScope,
} from "@ontos/materialization-application";
import type { CompiledObjectMappingPlan } from "@ontos/materialization-domain";

import { compileObjectFixture, digestCanonicalText } from "../materialization-mapping/fixtures.ts";

const ids = Object.freeze({
  project: "11111111-1111-4111-8111-111111111111",
  job: "22222222-2222-4222-8222-222222222222",
  attempt: "33333333-3333-4333-8333-333333333333",
  generation: "44444444-4444-4444-8444-444444444444",
  target: "55555555-5555-4555-8555-555555555555",
  revision: "66666666-6666-4666-8666-666666666666",
  snapshot: "77777777-7777-4777-8777-777777777777",
  group: "88888888-8888-4888-8888-888888888888",
  mapping: "99999999-9999-4999-8999-999999999999",
  file: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  report: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  rejectedSet: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  artifact: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  confirmation: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  principal: "ffffffff-ffff-4fff-8fff-ffffffffffff",
});

const scope = Object.freeze({
  projectId: ids.project,
  jobId: ids.job,
  attemptId: ids.attempt,
  fencingToken: 7n,
});

void test("quality fails closed before Current preparation when overlay inventory is unknown/nonzero", async () => {
  for (const overlay of [
    { state: "unknown" as const, rowCount: null },
    { state: "known" as const, rowCount: 1 },
  ]) {
    const repository = new FakeQualityRepository(baseScope(), summary([]));
    const service = qualityService(repository, overlay);
    await assert.rejects(
      service.build({ scope, generationId: ids.generation, provenanceTemplates: [] }),
      (error: unknown) => qualityError(error, "ZERO_OVERLAY_REQUIRED"),
    );
    assert.equal(repository.prepareCalls, 0);
    assert.equal(repository.finalizeInputs.length, 0);
  }
});

void test("optional errors at exactly 0.1% pass, reject whole rows and emit a deterministic redacted artifact", async () => {
  const observations = [observation(10, "OPTIONAL_PROPERTY_INVALID")];
  const first = await runBuild(observations, 1_000);
  const second = await runBuild(observations, 1_000);
  assert.equal(first.result.outcome, "passed");
  assert.equal(first.repository.finalizeInputs[0]?.report.acceptedRows, 999);
  assert.equal(first.repository.finalizeInputs[0]?.report.rejectedRows, 1);
  assert.equal(first.uploads.length, 1);
  assert.equal(first.uploads[0]?.body, second.uploads[0]?.body);
  assert.equal(first.result.reportDigest, second.result.reportDigest);
  assert.equal(first.result.generationDigest, second.result.generationDigest);
  assert.match(first.uploads[0]?.body ?? "", /OPTIONAL_PROPERTY_INVALID/u);
  assert.doesNotMatch(first.uploads[0]?.body ?? "", /secret|primary.?key|columnName/iu);
  assert.equal(first.uploads[0]?.mediaType, REJECTED_ROW_MEDIA_TYPE);
  assert.equal(first.repository.listCalls, 3, "samples plus two artifact passes");
});

void test("optional errors above 0.1% and every required error fail deterministically", async () => {
  const optional = await runBuild(
    [observation(1, "OPTIONAL_PROPERTY_INVALID"), observation(2, "OPTIONAL_PROPERTY_INVALID")],
    1_000,
  );
  assert.equal(optional.result.outcome, "failed");

  for (const code of [
    "PRIMARY_KEY_NULL",
    "PRIMARY_KEY_DUPLICATE",
    "REQUIRED_PROPERTY_INVALID",
    "REQUIRED_LINK_DANGLING",
  ] as const) {
    const required = await runBuild([observation(1, code)], 100);
    assert.equal(required.result.outcome, "failed", code);
  }
});

void test("row-count anomaly awaits an owner confirmation bound to immutable control facts", async () => {
  const qualityScope = baseScope({ previousAcceptedRows: 80, sourceRowCount: 100 });
  const repository = new FakeQualityRepository(qualityScope, summary([], 100));
  const built = await qualityService(repository, { state: "known", rowCount: 0 }).build({
    scope,
    generationId: ids.generation,
    provenanceTemplates: [],
  });
  assert.equal(built.outcome, "awaiting_confirmation");
  const report = repository.finalizeInputs[0]?.report;
  assert.deepEqual(report?.reasonCounts, [{ code: "ROW_COUNT_CONFIRMATION_REQUIRED", count: 1 }]);
  repository.confirmationScope = Object.freeze({
    projectId: ids.project,
    generationId: ids.generation,
    snapshotDigest: qualityScope.snapshotDigest,
    reportId: built.reportId,
    reportDigest: built.reportDigest,
    observedRows: 100,
    baselineRows: 80,
    thresholdBasisPoints: 1_000,
    publicationControlSequence: 9n,
    state: "awaiting_confirmation",
  });
  const confirmation = confirmationService(repository, true);
  const accepted = await confirmation.confirm(identity(), {
    projectId: ids.project,
    generationId: ids.generation,
    expectedReportDigest: built.reportDigest,
    expectedPublicationControlSequence: 9n,
    decision: "accepted",
  });
  assert.equal(accepted.outcome, "passed");
  assert.equal(repository.confirmations[0]?.actorPrincipalId, ids.principal);
  assert.equal(repository.confirmations[0]?.snapshotDigest, qualityScope.snapshotDigest);
  assert.equal(repository.confirmations[0]?.publicationControlSequence, 9n);

  await assert.rejects(
    confirmation.confirm(identity(), {
      projectId: ids.project,
      generationId: ids.generation,
      expectedReportDigest: digest("stale"),
      expectedPublicationControlSequence: 9n,
      decision: "accepted",
    }),
    (error: unknown) => qualityError(error, "QUALITY_CONFIRMATION_INVALID"),
  );
  await assert.rejects(
    confirmationService(repository, false).confirm(identity(), {
      projectId: ids.project,
      generationId: ids.generation,
      expectedReportDigest: built.reportDigest,
      expectedPublicationControlSequence: 9n,
      decision: "accepted",
    }),
    (error: unknown) => qualityError(error, "FORBIDDEN"),
  );
});

void test("provenance templates preserve multi-column sources and represent constants explicitly", () => {
  const plan = compileObjectFixture();
  assert.equal(plan.targetKind, "object");
  if (plan.targetKind !== "object") throw new Error("fixture must compile an Object Mapping");
  const planWithConstant: CompiledObjectMappingPlan = Object.freeze({
    ...plan,
    propertyMappings: Object.freeze(
      plan.propertyMappings.map((property) =>
        property.propertyApiName === "status"
          ? Object.freeze({
              ...property,
              sourceColumnOrdinals: Object.freeze([]),
              expression: Object.freeze({
                op: "constant" as const,
                valueType: property.expression.valueType,
                sourceColumnOrdinals: Object.freeze([]),
                literal: "active",
              }),
            })
          : property,
      ),
    ),
  });
  const templates = provenanceTemplatesFromPlan(planWithConstant, { digestCanonicalText });
  const byProperty = Map.groupBy(templates, (template) => template.propertyApiName);
  assert.deepEqual(
    byProperty.get("displayName")?.map((template) => template.inputColumnOrdinal),
    [1, 2],
  );
  assert.deepEqual(
    byProperty.get("id")?.map((template) => template.inputColumnOrdinal),
    [0],
  );
  const constant = byProperty.get("status")?.[0];
  assert.equal(constant?.sourceKind, "constant");
  assert.equal(constant?.inputColumnOrdinal, null);
  assert.match(constant?.sourceExpressionDigest ?? "", /^sha256:[0-9a-f]{64}$/u);
});

void test("mapping rejection observations choose one stable reason and never retain raw diagnostics", () => {
  const observations = observationsFromMappingRejections(
    {
      fileId: ids.file,
      rejectedRows: [
        {
          kind: "rejected",
          rowNumber: 7,
          errors: [
            {
              reasonCode: "OPTIONAL_PROPERTY_INVALID",
              mappingCode: "MAPPING_PROPERTY_INVALID",
              columnApiName: "secret_column",
            },
            { reasonCode: "PRIMARY_KEY_NULL", mappingCode: "MAPPING_PRIMARY_KEY_NULL" },
          ],
        },
      ],
    },
    { digestCanonicalText },
  );
  assert.equal(observations[0]?.reasonCode, "PRIMARY_KEY_NULL");
  assert.equal(observations[0]?.columnClassification, "redacted");
  assert.doesNotMatch(JSON.stringify(observations), /secret_column/u);
});

void test("rejected artifact hard limit stops before upload/finalize", async () => {
  const observations = [observation(1, "OPTIONAL_PROPERTY_INVALID")];
  const repository = new FakeQualityRepository(
    baseScope({ sourceRowCount: 1 }),
    summary(observations, 1),
    observations,
  );
  const uploads: UploadRecord[] = [];
  const service = qualityService(repository, { state: "known", rowCount: 0 }, uploads, 8);
  await assert.rejects(
    service.build({ scope, generationId: ids.generation, provenanceTemplates: [] }),
    (error: unknown) => qualityError(error, "REJECTED_ARTIFACT_TOO_LARGE"),
  );
  assert.equal(uploads.length, 0);
  assert.equal(repository.finalizeInputs.length, 0);
});

interface FinalizeInput {
  readonly report: Parameters<
    MaterializationQualityRepository["finalizeGenerationQuality"]
  >[0]["report"];
  readonly rejectedArtifact: RejectedArtifactBinding | null;
  readonly generationDigest: ArtifactDigest;
  readonly qualityBindingDigest: ArtifactDigest;
}

class FakeQualityRepository implements MaterializationQualityRepository {
  readonly scope: MaterializationQualityScopeRecord;
  readonly prepared: PreparedQualitySummary;
  readonly observations: readonly MaterializationQualityObservation[];
  prepareCalls = 0;
  listCalls = 0;
  readonly finalizeInputs: FinalizeInput[] = [];
  readonly confirmations: RowCountConfirmationRecord[] = [];
  confirmationScope: RowCountConfirmationScope | null = null;

  constructor(
    scopeValue: MaterializationQualityScopeRecord,
    prepared: PreparedQualitySummary,
    observations: readonly MaterializationQualityObservation[] = [],
  ) {
    this.scope = scopeValue;
    this.prepared = prepared;
    this.observations = observations;
  }

  getGenerationQualityScope(): Promise<MaterializationQualityScopeRecord> {
    return Promise.resolve(this.scope);
  }

  stageQualityObservations(): Promise<void> {
    return Promise.resolve();
  }

  prepareStagingCurrent(): Promise<PreparedQualitySummary> {
    this.prepareCalls += 1;
    return Promise.resolve(this.prepared);
  }

  listRejectedObservations(input: {
    readonly after: QualityObservationCursor | null;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly MaterializationQualityObservation[];
    readonly nextCursor: QualityObservationCursor | null;
  }> {
    this.listCalls += 1;
    const start =
      input.after === null
        ? 0
        : this.observations.findIndex(
            (item) =>
              cursorKey(item) === cursorKey(input.after as MaterializationQualityObservation),
          ) + 1;
    const items = this.observations.slice(start, start + input.limit);
    const last = items.at(-1);
    const hasMore = start + items.length < this.observations.length;
    return Promise.resolve(
      Object.freeze({
        items,
        nextCursor:
          hasMore && last !== undefined
            ? Object.freeze({
                fileId: last.fileId,
                rowNumber: last.rowNumber,
                reasonCode: last.reasonCode,
                fingerprint: last.fingerprint,
              })
            : null,
      }),
    );
  }

  finalizeGenerationQuality(
    input: Parameters<MaterializationQualityRepository["finalizeGenerationQuality"]>[0],
  ): Promise<FinalizedQualityResult> {
    this.finalizeInputs.push(input);
    return Promise.resolve(
      Object.freeze({
        projectId: this.scope.projectId,
        generationId: this.scope.generationId,
        outcome: input.report.outcome,
        reportId: input.report.reportId,
        reportDigest: input.report.reportDigest,
        generationDigest: input.generationDigest,
        qualityBindingDigest: input.qualityBindingDigest,
      }),
    );
  }

  getConfirmationScope(): Promise<RowCountConfirmationScope> {
    if (this.confirmationScope === null) return Promise.reject(new Error("missing confirmation"));
    return Promise.resolve(this.confirmationScope);
  }

  recordRowCountConfirmation(input: RowCountConfirmationRecord): Promise<FinalizedQualityResult> {
    this.confirmations.push(input);
    return Promise.resolve(
      Object.freeze({
        projectId: input.projectId,
        generationId: input.generationId,
        outcome: input.decision === "accepted" ? "passed" : "failed",
        reportId: input.reportId,
        reportDigest: input.reportDigest,
        generationDigest: digest("generation"),
        qualityBindingDigest: digest("binding"),
      }),
    );
  }
}

interface UploadRecord {
  readonly objectKey: string;
  readonly body: string;
  readonly mediaType: string;
}

async function runBuild(
  observations: readonly MaterializationQualityObservation[],
  totalRows: number,
): Promise<{
  readonly result: FinalizedQualityResult;
  readonly repository: FakeQualityRepository;
  readonly uploads: UploadRecord[];
}> {
  const qualityScope = baseScope({ sourceRowCount: totalRows });
  const repository = new FakeQualityRepository(
    qualityScope,
    summary(observations, totalRows),
    observations,
  );
  const uploads: UploadRecord[] = [];
  const result = await qualityService(repository, { state: "known", rowCount: 0 }, uploads).build({
    scope,
    generationId: ids.generation,
    provenanceTemplates: [],
  });
  return Object.freeze({ result, repository, uploads });
}

function qualityService(
  repository: FakeQualityRepository,
  overlay: { readonly state: "known" | "unknown"; readonly rowCount: number | null },
  uploads: UploadRecord[] = [],
  maximumRejectedArtifactBytes?: number,
): MaterializationQualityService {
  const randomIds = [ids.report, ids.rejectedSet, ids.artifact];
  return new MaterializationQualityService({
    repository,
    overlays: {
      inspect() {
        return Promise.resolve(overlay);
      },
    },
    artifacts: {
      async putVersion(input) {
        let body = "";
        for await (const chunk of input.body) body += new TextDecoder().decode(chunk);
        assert.equal(Buffer.byteLength(body), input.expectedByteCount);
        uploads.push({ objectKey: input.objectKey, body, mediaType: input.mediaType });
        return {
          versionId: "version-1",
          byteCount: input.expectedByteCount,
          mediaType: input.mediaType,
        };
      },
    },
    crypto: crypto(randomIds),
    clock: { now: () => parseCanonicalInstant("2026-08-16T00:00:00.000000Z") },
    ...(maximumRejectedArtifactBytes === undefined ? {} : { maximumRejectedArtifactBytes }),
  });
}

function confirmationService(
  repository: FakeQualityRepository,
  allowed: boolean,
): RowCountConfirmationService {
  return new RowCountConfirmationService({
    principals: {
      resolveVerifiedIdentity() {
        return Promise.resolve({
          principalId: ids.principal,
          issuer: "https://issuer.example",
          subject: "owner",
          displayName: "Owner",
          state: "active" as const,
        });
      },
    },
    authorizer: {
      authorize(_identity, request) {
        assert.equal(request.permission, "release.publish");
        return Promise.resolve(allowed);
      },
    },
    repository,
    crypto: crypto([ids.confirmation]),
    clock: { now: () => parseCanonicalInstant("2026-08-16T00:00:00.000000Z") },
  });
}

function baseScope(
  overrides: Partial<MaterializationQualityScopeRecord> = {},
): MaterializationQualityScopeRecord {
  return Object.freeze({
    projectId: ids.project,
    jobId: ids.job,
    generationId: ids.generation,
    memberKind: "object",
    targetResourceId: ids.target,
    targetRevisionId: ids.revision,
    snapshotId: ids.snapshot,
    snapshotDigest: digest("snapshot"),
    snapshotGroupId: ids.group,
    groupVersion: 1,
    mappingRevisionId: ids.mapping,
    mappingRevisionDigest: digest("mapping"),
    sourceRowCount: 0,
    previousAcceptedRows: null,
    qualityRules: Object.freeze({
      primaryKeyNullMaximumCount: 0,
      primaryKeyDuplicateMaximumCount: 0,
      requiredPropertyFailureMaximumCount: 0,
      requiredLinkDanglingMaximumCount: 0,
      optionalPropertyFailureMaximumBasisPoints: 10,
      optionalLinkDanglingMaximumBasisPoints: 10,
      rowCountChangeConfirmationBasisPoints: 1_000,
      optionalFailureDisposition: "reject_row",
    } as const),
    linkDanglingDisposition: "required",
    publicationControlSequence: 9n,
    ...overrides,
  });
}

function summary(
  observations: readonly MaterializationQualityObservation[],
  totalRows = 0,
): PreparedQualitySummary {
  const counts = new Map<string, number>();
  for (const item of observations)
    counts.set(item.reasonCode, (counts.get(item.reasonCode) ?? 0) + 1);
  return Object.freeze({
    totalRows,
    acceptedRows: totalRows - observations.length,
    rejectedRows: observations.length,
    reasonCounts: [...counts.entries()].sort().map(([code, count]) => ({
      code: code as MaterializationQualityObservation["reasonCode"],
      count,
    })),
    observationDigest: artifactDigest(observations),
    currentDigest: digest(`current-${String(totalRows - observations.length)}`),
    provenanceDigest: digest("provenance"),
  });
}

function observation(
  rowNumber: number,
  reasonCode: MaterializationQualityObservation["reasonCode"],
): MaterializationQualityObservation {
  return Object.freeze({
    fileId: ids.file,
    rowNumber,
    reasonCode,
    fingerprint: digest(`${reasonCode}-${String(rowNumber)}`),
    columnClassification: "redacted",
    phase: reasonCode.includes("LINK") ? "current_resolution" : "mapping",
  });
}

function artifactDigest(
  observations: readonly MaterializationQualityObservation[],
): ArtifactDigest {
  const hash = createHash("sha256");
  for (const item of observations) {
    hash.update(
      `${canonicalizeContractForDigest({
        schemaVersion: 1,
        fileId: item.fileId,
        rowNumber: item.rowNumber,
        reasonCode: item.reasonCode,
        fingerprint: item.fingerprint,
        columnClassification: item.columnClassification,
      })}\n`,
      "utf8",
    );
  }
  return parseArtifactDigest(`sha256:${hash.digest("hex")}`);
}

function crypto(randomIds: string[]) {
  return {
    randomId() {
      const value = randomIds.shift();
      if (value === undefined) throw new Error("no random id");
      return value;
    },
    digestCanonicalText,
    createStreamingDigest() {
      const hash = createHash("sha256");
      return {
        update(chunk: Uint8Array) {
          hash.update(chunk);
        },
        finish() {
          return parseArtifactDigest(`sha256:${hash.digest("hex")}`);
        },
      };
    },
  };
}

function identity() {
  return Object.freeze({
    issuer: "https://issuer.example",
    subject: "owner",
    displayName: "Owner",
    claimsFingerprint: digest("claims"),
    authenticatedAt: parseCanonicalInstant("2026-08-16T00:00:00.000000Z"),
  });
}

function digest(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function cursorKey(
  value: Pick<
    MaterializationQualityObservation,
    "fileId" | "rowNumber" | "reasonCode" | "fingerprint"
  >,
): string {
  return `${value.fileId}:${String(value.rowNumber)}:${value.reasonCode}:${value.fingerprint}`;
}

function qualityError(error: unknown, code: MaterializationQualityError["code"]): boolean {
  return error instanceof MaterializationQualityError && error.code === code;
}
