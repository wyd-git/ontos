import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  type ArtifactDigest,
} from "@ontos/contracts";
import {
  compileMapping,
  ManagedCsvError,
  scanManagedCsv,
  scanManagedCsvRows,
} from "@ontos/materialization-domain";
import {
  MATERIALIZATION_BENCHMARK_FIXTURE,
  MATERIALIZATION_CONCURRENT_DELTA_FIXTURE,
  MATERIALIZATION_DOMAINS,
  MATERIALIZATION_FIXTURE_DIGEST,
  MATERIALIZATION_NEGATIVE_FIXTURES,
  datasetDigest,
} from "@ontos/testkit";

export const EXPECTED_MATERIALIZATION_FIXTURE_DIGEST = MATERIALIZATION_FIXTURE_DIGEST;

export interface MaterializationFixtureAudit {
  readonly schemaVersion: 1;
  readonly status: "PASS" | "FAIL";
  readonly fixtureDigest: string;
  readonly domainCount: number;
  readonly memberCount: number;
  readonly validCsvRowCount: number;
  readonly negativeFixtureIds: readonly string[];
  readonly benchmark: {
    readonly objectCount: number;
    readonly linkCount: number;
    readonly datasetDigest: string;
  };
  readonly provenance: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly violations: readonly string[];
}

export async function auditMaterializationFixtures(
  repositoryRoot: string,
  expectedFixtureDigest: string = EXPECTED_MATERIALIZATION_FIXTURE_DIGEST,
): Promise<MaterializationFixtureAudit> {
  const violations: string[] = [];
  const provenance: { path: string; sha256: string }[] = [];
  let memberCount = 0;
  let validCsvRowCount = 0;

  if (MATERIALIZATION_DOMAINS.length !== 2) {
    violations.push("Materialization Testkit must contain exactly two domains.");
  }
  for (const domain of MATERIALIZATION_DOMAINS) {
    const source = await readFile(resolve(repositoryRoot, domain.sourcePath));
    const actualSourceSha256 = sha256(source);
    provenance.push({ path: domain.sourcePath, sha256: actualSourceSha256 });
    if (actualSourceSha256 !== domain.sourceSha256) {
      violations.push(`${domain.id} source provenance drifted.`);
    }
    if (domain.members.length !== 3) {
      violations.push(`${domain.id} must contain two Object members and one Link member.`);
    }
    for (const member of domain.members) {
      memberCount += 1;
      try {
        const plan = compileFixtureMember(member);
        const scan = await scanManagedCsv(
          bytes(member.csv),
          plan.columns.map((column) => column.columnApiName),
        );
        validCsvRowCount += scan.rowCount;
        if (scan.rowCount !== 2)
          violations.push(`${domain.id}/${member.memberKey} needs two rows.`);
      } catch (error) {
        violations.push(
          `${domain.id}/${member.memberKey} failed production parsing: ${errorCode(error)}.`,
        );
      }
    }
  }

  await auditNegativeFixtures(violations);
  auditConcurrentDelta(violations);
  const benchmarkDigest = datasetDigest(MATERIALIZATION_BENCHMARK_FIXTURE.config);
  if (benchmarkDigest !== MATERIALIZATION_BENCHMARK_FIXTURE.expectedDatasetDigest) {
    violations.push("The 100k Object / 1m Link benchmark stream digest drifted.");
  }

  const fixtureDigest = digestCanonical({
    schemaVersion: 1,
    contractVersion: "materialization-testkit-audit-v1",
    domains: MATERIALIZATION_DOMAINS,
    negatives: MATERIALIZATION_NEGATIVE_FIXTURES,
    concurrentDelta: MATERIALIZATION_CONCURRENT_DELTA_FIXTURE,
    benchmark: MATERIALIZATION_BENCHMARK_FIXTURE,
  });
  if (fixtureDigest !== expectedFixtureDigest) {
    violations.push(
      `Materialization fixture digest drifted: expected ${expectedFixtureDigest}, received ${fixtureDigest}.`,
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    status: violations.length === 0 ? "PASS" : "FAIL",
    fixtureDigest,
    domainCount: MATERIALIZATION_DOMAINS.length,
    memberCount,
    validCsvRowCount,
    negativeFixtureIds: Object.freeze(
      Object.values(MATERIALIZATION_NEGATIVE_FIXTURES)
        .map((fixture) => fixture.id)
        .sort(),
    ),
    benchmark: Object.freeze({
      objectCount: MATERIALIZATION_BENCHMARK_FIXTURE.config.objectCount,
      linkCount: MATERIALIZATION_BENCHMARK_FIXTURE.config.linkCount,
      datasetDigest: benchmarkDigest,
    }),
    provenance: Object.freeze(provenance),
    violations: Object.freeze(violations),
  });
}

async function auditNegativeFixtures(violations: string[]): Promise<void> {
  const bad = MATERIALIZATION_NEGATIVE_FIXTURES.badCsv;
  try {
    await scanManagedCsv(bytes(bad.csv), ["id", "name"]);
    violations.push("Malformed CSV did not fail.");
  } catch (error) {
    if (!(error instanceof ManagedCsvError) || error.code !== bad.expectedCode) {
      violations.push(`Malformed CSV returned ${errorCode(error)} instead of ${bad.expectedCode}.`);
    }
  }

  const primaryKeys: string[] = [];
  await scanManagedCsvRows(
    bytes(MATERIALIZATION_NEGATIVE_FIXTURES.primaryKeyCollision.csv),
    ["id", "name"],
    (row) => {
      const key = row.values[0];
      if (key !== undefined) primaryKeys.push(key);
    },
  );
  if (new Set(primaryKeys).size === primaryKeys.length) {
    violations.push("Primary-key collision fixture no longer collides.");
  }

  let danglingSource: string | undefined;
  await scanManagedCsvRows(
    bytes(MATERIALIZATION_NEGATIVE_FIXTURES.danglingLink.csv),
    ["customerId", "orderId"],
    (row) => {
      danglingSource = row.values[0];
    },
  );
  if (danglingSource !== "missing-customer") {
    violations.push("Required dangling-Link fixture no longer references a missing source.");
  }

  const threshold = MATERIALIZATION_NEGATIVE_FIXTURES.qualityThreshold;
  if (
    threshold.optionalFailures * 10_000 <=
    threshold.observedRows * threshold.maximumBasisPoints
  ) {
    violations.push("Quality threshold fixture no longer exceeds its configured threshold.");
  }
}

function auditConcurrentDelta(violations: string[]): void {
  const fixture = MATERIALIZATION_CONCURRENT_DELTA_FIXTURE;
  const sequences = fixture.deltas.map((delta) => delta.sequence);
  if (
    fixture.mode !== "ADVERSARIAL_TEST_ONLY" ||
    fixture.productionOverlayClaim !== "ZERO_ONLY" ||
    fixture.realOverlayOwningGate !== "G2-04" ||
    sequences.length !== fixture.w1 - fixture.w0 ||
    sequences.some((sequence, index) => sequence !== fixture.w0 + index + 1)
  ) {
    violations.push("Concurrent Delta fixture no longer covers every W0..W1 event exactly once.");
  }
  const resultIds = fixture.expectedHeads.map((head) => head.objectRid);
  if (new Set(resultIds).size !== resultIds.length) {
    violations.push("Concurrent Delta expected Heads contain duplicate identities.");
  }
}

function compileFixtureMember(member: (typeof MATERIALIZATION_DOMAINS)[number]["members"][number]) {
  const common = {
    mappingRevisionId: member.mappingRevisionId,
    mappingRevisionDigest: definitionDigest(member.mapping),
    mapping: member.mapping,
    inputSchemaRevisionId: member.schemaRevisionId,
    inputSchemaDigest: definitionDigest(member.schema),
    inputSchema: member.schema,
  };
  return compileMapping(
    member.kind === "object"
      ? {
          ...common,
          target: {
            kind: "object" as const,
            resourceId: member.resourceId,
            revisionId: member.revisionId,
            definitionDigest: definitionDigest(member.definition),
            definition: member.definition,
          },
        }
      : {
          ...common,
          target: {
            kind: "link" as const,
            resourceId: member.resourceId,
            revisionId: member.revisionId,
            definitionDigest: definitionDigest(member.definition),
            definition: member.definition,
            sourceObject: {
              ...member.sourceObject,
              definitionDigest: definitionDigest(member.sourceObject.definition),
            },
            targetObject: {
              ...member.targetObject,
              definitionDigest: definitionDigest(member.targetObject.definition),
            },
          },
        },
    digestText,
  );
}

function bytes(value: string): AsyncIterable<Uint8Array> {
  return Readable.from([new TextEncoder().encode(value)]);
}

function definitionDigest(value: unknown): ArtifactDigest {
  return parseArtifactDigest(digestCanonical(value));
}

function digestCanonical(value: unknown): ArtifactDigest {
  return digestText(canonicalizeContractForDigest(value));
}

function digestText(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${sha256(value)}`);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.name : "UNKNOWN";
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const audit = await auditMaterializationFixtures(repositoryRoot);
  const outputDirectory = resolve(repositoryRoot, "generated/ci-report");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    resolve(outputDirectory, "materialization-fixtures.json"),
    `${JSON.stringify(audit, null, 2)}\n`,
  );
  if (audit.status !== "PASS") throw new Error(audit.violations.join(" "));
  process.stdout.write(
    `materialization fixtures: PASS (${String(audit.domainCount)} domains, ${String(audit.memberCount)} members, ${String(audit.negativeFixtureIds.length)} negative fixtures, ${String(audit.benchmark.objectCount)} Objects / ${String(audit.benchmark.linkCount)} Links)\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
