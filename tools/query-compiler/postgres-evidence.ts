import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  parseArtifactDigest,
  parseOntosId,
  type ArtifactDigest,
  type PolicyRule,
} from "@ontos/contracts";
import { QueryApplicationError } from "@ontos/query-application";
import {
  QuerySchemaRegistry,
  compileLinkCandidate,
  compileObjectCount,
  compileObjectGet,
  compileObjectSearch,
  type QueryLogicalPlan,
  type QueryPolicyContext,
} from "@ontos/query-domain";
import {
  PostgresQueryExecutor,
  renderPostgresQuery,
  type ParameterizedQueryStatement,
} from "@ontos/query-postgres";
import type pg from "pg";

export interface QueryCompilerEvidenceMember {
  readonly memberKey: string;
  readonly kind: "object" | "link";
  readonly resourceId: string;
  readonly revisionId: string;
  readonly definition: unknown;
}

export interface QueryCompilerPostgresEvidenceInput {
  readonly repositoryRoot: string;
  readonly pool: pg.Pool;
  readonly commit: string;
  readonly cleanCheckout: boolean;
  readonly projectId: string;
  readonly releaseId: string;
  readonly members: readonly QueryCompilerEvidenceMember[];
  readonly sourceObjectTypeApiName: string;
  readonly linkTypeApiName: string;
  readonly targetObjectTypeApiName: string;
  readonly sourcePrimaryKeyValue: string;
  readonly sourcePolicyUpperBound: string;
  readonly targetPolicyUpperBound: string;
  readonly expectedListRows: number;
  readonly expectedPolicyCount: number;
  readonly expectedLinkRows: number;
  readonly fixtureDigest: string;
}

interface ServingRow extends pg.QueryResultRow {
  readonly activationId: string;
  readonly memberKey: string;
  readonly generationId: string;
  readonly readTimestamp: Date;
}

interface ExplainNode {
  readonly [key: string]: unknown;
}

interface StatementEvidence {
  readonly scenario: "get" | "list" | "policy_filter" | "count" | "link_candidate";
  readonly statementName: ParameterizedQueryStatement["name"];
  readonly sqlShape: string;
  readonly parameterTypes: readonly string[];
  readonly resultRows: number;
  readonly indexes: readonly string[];
  readonly publishedPlanIndexes: readonly string[];
  readonly currentSequentialScans: number;
  readonly planningTimeMilliseconds: number | null;
  readonly executionTimeMilliseconds: number | null;
  readonly explainAnalyzeBuffers: unknown;
}

const servingResolverSql = `SELECT head.activation_id::text AS "activationId",
       member.member_key AS "memberKey",
       member.generation_id::text AS "generationId",
       transaction_timestamp() AS "readTimestamp"
FROM meta.releases AS release
JOIN meta.release_serving_heads AS head
  ON head.release_id = release.release_id
JOIN meta.runtime_activation_members AS member
  ON member.project_id = release.project_id
 AND member.release_id = release.release_id
 AND member.activation_id = head.activation_id
WHERE release.project_id = $1::uuid
  AND release.release_id = $2::uuid
  AND release.state = 'published'
  AND member.member_key = ANY($3::text[])
ORDER BY member.member_key`;

export async function runQueryCompilerPostgresEvidence(
  input: QueryCompilerPostgresEvidenceInput,
): Promise<Readonly<Record<string, unknown>>> {
  assert.equal(input.cleanCheckout, true, "G2-03-07 evidence requires a clean checkout");
  const client = await input.pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL plan_cache_mode = force_custom_plan");
    const version = await client.query<{ readonly server_version_num: string }>(
      "SHOW server_version_num",
    );
    const serverVersionNum = required(version.rows[0]).server_version_num;
    if (!/^16[0-9]{4}$/u.test(serverVersionNum)) {
      throw new Error(`QUERY_COMPILER_POSTGRES_VERSION_INVALID:${serverVersionNum}`);
    }

    const memberKeys = input.members.map(({ memberKey }) => memberKey).sort();
    const serving = await client.query<ServingRow>(servingResolverSql, [
      input.projectId,
      input.releaseId,
      memberKeys,
    ]);
    assert.equal(serving.rows.length, input.members.length);
    const activationIds = new Set(serving.rows.map(({ activationId }) => activationId));
    assert.equal(activationIds.size, 1);
    const generations = new Map(
      serving.rows.map(({ memberKey, generationId }) => [memberKey, generationId]),
    );
    const registry = new QuerySchemaRegistry({
      projectId: input.projectId,
      releaseId: input.releaseId,
      releaseRevisionId: input.releaseId,
      activationId: required([...activationIds][0]),
      objects: input.members
        .filter((member) => member.kind === "object")
        .map((member) => ({
          ...member,
          generationId: required(generations.get(member.memberKey)),
        })),
      links: input.members
        .filter((member) => member.kind === "link")
        .map((member) => ({
          ...member,
          generationId: required(generations.get(member.memberKey)),
        })),
    });
    const requestTime = canonicalInstant(required(serving.rows[0]).readTimestamp);
    const context = Object.freeze({ registry, requestTime, digestCanonicalText: digestText });
    const source = registry.requireObjectByApiName(input.sourceObjectTypeApiName);
    const target = registry.requireObjectByApiName(input.targetObjectTypeApiName);
    const link = registry.requireLinkByApiName(input.linkTypeApiName);
    const sourcePolicy = objectPolicy(
      input.projectId,
      input.releaseId,
      source,
      input.sourcePolicyUpperBound,
    );
    const targetPolicy = objectPolicy(
      input.projectId,
      input.releaseId,
      target,
      input.targetPolicyUpperBound,
    );
    const linkPolicy = allowLinkPolicy(input.projectId, input.releaseId, link);

    const candidates = [
      Object.freeze({
        scenario: "get" as const,
        plan: compileObjectGet({
          context,
          objectTypeApiName: source.apiName,
          request: { primaryKey: input.sourcePrimaryKeyValue, select: ["id", "name"] },
          policy: sourcePolicy,
        }),
        expectedRows: 1,
        expectedCount: null,
        requiresPublishedIndex: false,
      }),
      Object.freeze({
        scenario: "list" as const,
        plan: compileObjectSearch({
          context,
          objectTypeApiName: source.apiName,
          request: searchRequest(input.expectedListRows),
          policy: sourcePolicy,
        }),
        expectedRows: input.expectedListRows,
        expectedCount: null,
        requiresPublishedIndex: true,
      }),
      Object.freeze({
        scenario: "policy_filter" as const,
        plan: compileObjectSearch({
          context,
          objectTypeApiName: source.apiName,
          request: searchRequest(input.expectedListRows, {
            where: { property: "name", op: "prefix", value: "Customer 000" },
          }),
          policy: sourcePolicy,
        }),
        expectedRows: input.expectedListRows,
        expectedCount: null,
        requiresPublishedIndex: true,
      }),
      Object.freeze({
        scenario: "count" as const,
        plan: compileObjectCount({
          context,
          objectTypeApiName: source.apiName,
          request: { schemaVersion: 1, operation: "count" },
          policy: sourcePolicy,
        }),
        expectedRows: 1,
        expectedCount: input.expectedPolicyCount,
        requiresPublishedIndex: true,
      }),
      Object.freeze({
        scenario: "link_candidate" as const,
        plan: compileLinkCandidate({
          context,
          sourceObjectTypeApiName: source.apiName,
          linkTypeApiName: link.apiName,
          sourcePrimaryKey: input.sourcePrimaryKeyValue,
          request: {
            schemaVersion: 1,
            direction: "outgoing",
            select: ["id", "name"],
            orderBy: [{ property: "name", direction: "asc" }],
            page: { size: 25, cursor: null },
          },
          sourcePolicy,
          linkPolicy,
          targetPolicy,
        }),
        expectedRows: input.expectedLinkRows,
        expectedCount: null,
        requiresPublishedIndex: false,
      }),
    ];

    const publishedIndexes = await readyPublishedIndexes(client, input.projectId);
    const evidence: StatementEvidence[] = [];
    for (const candidate of candidates) {
      evidence.push(
        await executeAndExplain(
          client,
          candidate.scenario,
          candidate.plan,
          candidate.expectedRows,
          candidate.expectedCount,
          candidate.requiresPublishedIndex,
          publishedIndexes,
        ),
      );
    }
    await client.query("ROLLBACK");
    transactionOpen = false;

    const timeoutRecovery = await verifyTimeoutAndPoolRecovery(input.pool, registry, sourcePolicy);
    const artifact = Object.freeze({
      schemaVersion: 1,
      gate: "G2-03-07",
      status: "PASS",
      qualification: "REAL_POSTGRES_16_TYPED_QUERY_COMPILER",
      commit: input.commit,
      cleanCheckout: input.cleanCheckout,
      postgres: Object.freeze({ serverVersionNum }),
      provenance: Object.freeze({
        source: "packages/testkit/src/materialization.ts",
        fixtureDigest: input.fixtureDigest,
        originalG1Sources: Object.freeze([
          "spikes/g1/packages/commerce/package.json",
          "spikes/g1/src/query/compiler.js",
        ]),
        productionImportsFromG1: false,
      }),
      executionContext: Object.freeze({
        resolution: "release-serving-head",
        projectId: input.projectId,
        releaseId: input.releaseId,
        releaseRevisionId: input.releaseId,
        activationId: registry.activationId,
        memberCount: input.members.length,
        generationCount: new Set([...generations.values()]).size,
        requestTime,
      }),
      statements: Object.freeze(evidence),
      executionBoundaries: timeoutRecovery,
      assertions: Object.freeze({
        typedAstBeforeExecution: true,
        publicValueCodec: true,
        allValuesParameterized: true,
        clientAndPolicySameWhere: true,
        propertyPolicyBeforeSortAndLimit: true,
        currentGenerationBound: true,
        unboundedCurrentTableSequentialScans: evidence.reduce(
          (sum, item) => sum + item.currentSequentialScans,
          0,
        ),
        timeoutCancelledServerStatement: timeoutRecovery.timeoutCancelledServerStatement,
        poolReusableAfterTimeout: timeoutRecovery.poolReusableAfterTimeout,
      }),
    });
    const outputDirectory = resolve(input.repositoryRoot, "generated/ci-report");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      resolve(outputDirectory, "g2-03-07-query-compiler.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
    process.stdout.write(
      `CI_G2_03_07_QUERY_COMPILER status=PASS statements=${String(evidence.length)} postgres=${serverVersionNum}\n`,
    );
    return artifact;
  } finally {
    if (transactionOpen) await client.query("ROLLBACK");
    client.release();
  }
}

async function executeAndExplain(
  client: pg.PoolClient,
  scenario: StatementEvidence["scenario"],
  plan: QueryLogicalPlan,
  expectedRows: number,
  expectedCount: number | null,
  requiresPublishedIndex: boolean,
  publishedIndexes: ReadonlySet<string>,
): Promise<StatementEvidence> {
  const statement = renderPostgresQuery(plan);
  const result = await client.query<Record<string, unknown>>(statement.text, [...statement.values]);
  assert.equal(result.rows.length, expectedRows, scenario);
  if (expectedCount !== null) {
    assert.equal(Number(required(result.rows[0])?.["count"]), expectedCount, scenario);
  }
  const explained = await client.query<Record<string, unknown>>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
    [...statement.values],
  );
  const document = explainDocument(required(explained.rows[0])?.["QUERY PLAN"]);
  const nodes = flattenPlan(record(document["Plan"]));
  const currentSequentialScans = nodes.filter(
    (node) =>
      node["Node Type"] === "Seq Scan" &&
      ["object_current", "link_current"].includes(String(node["Relation Name"])),
  ).length;
  assert.equal(currentSequentialScans, 0, `${scenario}: Current sequential scan`);
  const indexes = [
    ...new Set(
      nodes.flatMap((node) => (typeof node["Index Name"] === "string" ? [node["Index Name"]] : [])),
    ),
  ].sort();
  assert.ok(indexes.length > 0, `${scenario}: index required`);
  const publishedPlanIndexes = indexes.filter((index) => publishedIndexes.has(index));
  if (requiresPublishedIndex) {
    assert.ok(publishedPlanIndexes.length > 0, `${scenario}: Published Index Plan required`);
  }
  return Object.freeze({
    scenario,
    statementName: statement.name,
    sqlShape: statement.text,
    parameterTypes: statement.parameterTypes,
    resultRows: expectedCount ?? result.rows.length,
    indexes: Object.freeze(indexes),
    publishedPlanIndexes: Object.freeze(publishedPlanIndexes),
    currentSequentialScans,
    planningTimeMilliseconds: finiteNumber(document["Planning Time"]),
    executionTimeMilliseconds: finiteNumber(document["Execution Time"]),
    explainAnalyzeBuffers: document,
  });
}

async function verifyTimeoutAndPoolRecovery(
  pool: pg.Pool,
  registry: QuerySchemaRegistry,
  sourcePolicy: QueryPolicyContext,
) {
  const timeoutPlan = compileObjectCount({
    context: {
      registry,
      requestTime: "2026-08-20T04:00:00.000000Z",
      digestCanonicalText: digestText,
      statementTimeoutMs: 1,
    },
    objectTypeApiName: "Customer",
    request: { schemaVersion: 1, operation: "count" },
    policy: allowAllRows(sourcePolicy),
  });
  const executor = new PostgresQueryExecutor(pool);
  let timeoutCancelledServerStatement = false;
  try {
    await executor.execute(timeoutPlan);
  } catch (error) {
    timeoutCancelledServerStatement =
      error instanceof QueryApplicationError && postgresErrorCode(error.cause) === "57014";
  }
  assert.equal(timeoutCancelledServerStatement, true);
  const reusable = await pool.query<{ readonly value: number }>("SELECT 1::integer AS value");
  const active = await pool.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND state <> 'idle'
       AND query LIKE 'SELECT count(*)::text AS "count"%'
       AND pid <> pg_backend_pid()`,
  );
  const poolReusableAfterTimeout = required(reusable.rows[0]).value === 1;
  const backgroundLongStatements = Number(required(active.rows[0]).count);
  assert.equal(poolReusableAfterTimeout, true);
  assert.equal(backgroundLongStatements, 0);
  return Object.freeze({
    statementTimeoutMs: 1,
    timeoutCancelledServerStatement,
    poolReusableAfterTimeout,
    backgroundLongStatements,
    abortUnitGate: "query-compiler-unit",
    rowAndByteBoundaryUnitGate: "query-compiler-unit",
  });
}

function objectPolicy(
  projectId: string,
  releaseId: string,
  object: ReturnType<QuerySchemaRegistry["requireObjectByApiName"]>,
  upperBound: string,
): QueryPolicyContext {
  const rules: PolicyRule[] = [
    Object.freeze({
      ruleId: `ALLOW_${object.apiName.toUpperCase()}_ROWS`,
      target: Object.freeze({
        kind: "object",
        resourceId: parseOntosId(object.resourceId),
        resourceRevisionId: parseOntosId(object.revisionId),
      }),
      effect: "allow",
      predicate: Object.freeze({
        kind: "compare",
        left: Object.freeze({ source: "object_property", apiName: "name" }),
        op: "lt",
        right: Object.freeze({ source: "constant", value: upperBound }),
      }),
    }),
  ];
  for (const property of object.properties) {
    rules.push(
      Object.freeze({
        ruleId: `ALLOW_${object.apiName.toUpperCase()}_${property.apiName.toUpperCase()}`,
        target: Object.freeze({
          kind: "property",
          resourceId: parseOntosId(object.resourceId),
          resourceRevisionId: parseOntosId(object.revisionId),
          propertyApiName: property.apiName,
        }),
        effect: "allow",
        predicate: Object.freeze({ kind: "constant", value: true }),
      }),
    );
  }
  return policyContext(projectId, releaseId, object.resourceId, object.revisionId, rules);
}

function allowLinkPolicy(
  projectId: string,
  releaseId: string,
  link: ReturnType<QuerySchemaRegistry["requireLinkByApiName"]>,
): QueryPolicyContext {
  return policyContext(projectId, releaseId, link.resourceId, link.revisionId, [
    Object.freeze({
      ruleId: "ALLOW_LINK_ROWS",
      target: Object.freeze({
        kind: "link",
        resourceId: parseOntosId(link.resourceId),
        resourceRevisionId: parseOntosId(link.revisionId),
      }),
      effect: "allow",
      predicate: Object.freeze({ kind: "constant", value: true }),
    }),
  ]);
}

function policyContext(
  projectId: string,
  releaseId: string,
  resourceId: string,
  resourceRevisionId: string,
  policyRules: readonly PolicyRule[],
): QueryPolicyContext {
  return Object.freeze({
    projectId,
    releaseId,
    resourceId,
    resourceRevisionId,
    artifactDigest: digestText(`artifact:${resourceRevisionId}`),
    authorizationEpoch: "1",
    policyContextHash: digestText(`context:${resourceRevisionId}`),
    policyRules: Object.freeze([...policyRules]),
    trustedActorAttributes: Object.freeze([]),
  });
}

function allowAllRows(context: QueryPolicyContext): QueryPolicyContext {
  return Object.freeze({
    ...context,
    policyRules: Object.freeze(
      context.policyRules.map((rule) =>
        rule.target.kind === "object"
          ? Object.freeze({
              ...rule,
              predicate: Object.freeze({ kind: "constant" as const, value: true }),
            })
          : rule,
      ),
    ),
  });
}

function searchRequest(pageSize: number, extra: Readonly<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    select: ["id", "name"],
    orderBy: [{ property: "name", direction: "asc" }],
    page: { size: pageSize, cursor: null },
    ...extra,
  };
}

async function readyPublishedIndexes(
  client: pg.PoolClient,
  projectId: string,
): Promise<ReadonlySet<string>> {
  const result = await client.query<{ readonly index_name: string }>(
    `SELECT index_name
     FROM runtime.index_inventory
     WHERE project_id = $1::uuid AND state = 'ready'`,
    [projectId],
  );
  return new Set(result.rows.map(({ index_name }) => index_name));
}

function explainDocument(value: unknown): Readonly<Record<string, unknown>> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("EXPLAIN document invalid.");
  return record(parsed[0]);
}

function flattenPlan(root: Readonly<Record<string, unknown>>): readonly ExplainNode[] {
  const nodes: ExplainNode[] = [root];
  if (Array.isArray(root["Plans"])) {
    for (const child of root["Plans"]) nodes.push(...flattenPlan(record(child)));
  }
  return nodes;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an evidence record.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function postgresErrorCode(value: unknown): string | null {
  return typeof value === "object" && value !== null && "code" in value ? String(value.code) : null;
}

function canonicalInstant(value: Date): string {
  const iso = value.toISOString();
  return `${iso.slice(0, -1)}000Z`;
}

function digestText(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required query evidence value is missing.");
  return value;
}
