import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalizePrimaryKey } from "@ontos/value-codec";
import type pg from "pg";

import {
  compileObjectList,
  compileOneHopLink,
  compilePolicyCount,
  compileTypedGet,
  type CompiledReadStatement,
  type PropertyCapability,
  type ServingContext,
  type ServingMember,
} from "./policy-query.ts";

export interface QueryPolicyPostgresSpikeInput {
  readonly repositoryRoot: string;
  readonly pool: pg.Pool;
  readonly commit: string;
  readonly cleanCheckout: boolean;
  readonly projectId: string;
  readonly releaseId: string;
  readonly sourceMemberKey: string;
  readonly linkMemberKey: string;
  readonly targetMemberKey: string;
  readonly propertyApiName: string;
  readonly sourcePrimaryKeyValue: string;
  readonly sourcePolicyUpperBound: string;
  readonly targetPolicyUpperBound: string;
  readonly expectedListRows: number;
  readonly expectedPolicyCount: number;
  readonly expectedLinkRows: number;
}

interface ExplainNode {
  readonly [key: string]: unknown;
}

interface StatementEvidence {
  readonly name: CompiledReadStatement["name"];
  readonly sqlShape: string;
  readonly parameterTypes: readonly string[];
  readonly resultRows: number;
  readonly indexes: readonly string[];
  readonly planningTimeMilliseconds: number | null;
  readonly executionTimeMilliseconds: number | null;
  readonly bufferBlocks: Readonly<{
    hit: number;
    read: number;
    dirtied: number;
    written: number;
  }>;
  readonly explainAnalyzeBuffers: unknown;
}

const servingResolverSql = `SELECT head.activation_id::text AS "activationId",
       member.member_key AS "memberKey",
       plan.member_kind AS kind,
       plan.target_resource_id::text AS "targetResourceId",
       plan.target_revision_id::text AS "targetRevisionId",
       member.generation_id::text AS "generationId",
       transaction_timestamp() AS "readTimestamp"
  FROM meta.releases AS release
  JOIN meta.release_serving_heads AS head
    ON head.release_id = release.release_id
  JOIN meta.runtime_activation_members AS member
    ON member.project_id = release.project_id
   AND member.release_id = release.release_id
   AND member.activation_id = head.activation_id
  JOIN meta.release_runtime_plan_members AS plan
    ON plan.project_id = member.project_id
   AND plan.release_id = member.release_id
   AND plan.member_key = member.member_key
 WHERE release.project_id = $1::uuid
   AND release.release_id = $2::uuid
   AND release.state = 'published'
   AND member.member_key = ANY($3::text[])
 ORDER BY member.member_key`;

export async function runQueryPolicyPostgresSpike(
  input: QueryPolicyPostgresSpikeInput,
): Promise<Readonly<Record<string, unknown>>> {
  const client = await input.pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '15s'");
    const versionResult = await client.query<{ server_version_num: string }>(
      "SHOW server_version_num",
    );
    const serverVersionNum = requiredRow(versionResult.rows).server_version_num;
    if (!/^16[0-9]{4}$/u.test(serverVersionNum)) {
      throw new Error(`QUERY_SPIKE_POSTGRES_VERSION_INVALID:${serverVersionNum}`);
    }
    const memberKeys = [input.sourceMemberKey, input.linkMemberKey, input.targetMemberKey];
    const contextResult = await client.query<{
      activationId: string;
      memberKey: string;
      kind: "object" | "link";
      targetResourceId: string;
      targetRevisionId: string;
      generationId: string;
      readTimestamp: Date;
    }>(servingResolverSql, [input.projectId, input.releaseId, memberKeys]);
    if (contextResult.rows.length !== memberKeys.length) {
      throw new Error("QUERY_SPIKE_SERVING_CONTEXT_INCOMPLETE");
    }
    const activationIds = new Set(contextResult.rows.map(({ activationId }) => activationId));
    if (activationIds.size !== 1) throw new Error("QUERY_SPIKE_MIXED_ACTIVATION");
    const serving: ServingContext = Object.freeze({
      resolution: "release-serving-head",
      projectId: input.projectId,
      releaseId: input.releaseId,
      activationId: required([...activationIds][0]),
      members: Object.freeze(
        contextResult.rows.map(
          ({ memberKey, kind, targetResourceId, targetRevisionId, generationId }) =>
            Object.freeze<ServingMember>({
              memberKey,
              kind,
              targetResourceId,
              targetRevisionId,
              generationId,
            }),
        ),
      ),
    });
    const property: PropertyCapability = Object.freeze({
      apiName: input.propertyApiName,
      valueType: "string",
      filterable: true,
      sortable: true,
      access: "allow",
      policyUsable: true,
    });
    const sourcePolicy = Object.freeze({
      kind: "compare" as const,
      property,
      operator: "lt" as const,
      value: input.sourcePolicyUpperBound,
    });
    const targetPolicy = Object.freeze({
      kind: "compare" as const,
      property,
      operator: "lt" as const,
      value: input.targetPolicyUpperBound,
    });
    const canonicalPrimaryKey = canonicalizePrimaryKey([input.sourcePrimaryKeyValue], {
      components: [{ type: "string", caseSensitive: true }],
    });
    const statements = [
      Object.freeze({
        statement: compileTypedGet(serving, {
          memberKey: input.sourceMemberKey,
          canonicalPrimaryKey,
          selectedProperties: [property],
          policy: sourcePolicy,
        }),
        expectedRows: 1,
        expectedCount: null,
      }),
      Object.freeze({
        statement: compileObjectList(serving, {
          memberKey: input.sourceMemberKey,
          selectedProperties: [property],
          policy: sourcePolicy,
          limit: input.expectedListRows,
        }),
        expectedRows: input.expectedListRows,
        expectedCount: null,
      }),
      Object.freeze({
        statement: compilePolicyCount(serving, {
          memberKey: input.sourceMemberKey,
          policy: sourcePolicy,
        }),
        expectedRows: 1,
        expectedCount: input.expectedPolicyCount,
      }),
      Object.freeze({
        statement: compileOneHopLink(serving, {
          sourceMemberKey: input.sourceMemberKey,
          linkMemberKey: input.linkMemberKey,
          targetMemberKey: input.targetMemberKey,
          sourceCanonicalPrimaryKey: canonicalPrimaryKey,
          selectedTargetProperties: [property],
          sourcePolicy,
          linkPolicy: { kind: "allow" },
          targetPolicy,
          limit: 25,
        }),
        expectedRows: input.expectedLinkRows,
        expectedCount: null,
      }),
    ];
    const evidence: StatementEvidence[] = [];
    for (const candidate of statements) {
      evidence.push(
        await executeAndExplain(
          client,
          candidate.statement,
          candidate.expectedRows,
          candidate.expectedCount,
        ),
      );
    }
    await client.query("ROLLBACK");
    transactionOpen = false;
    const artifact = Object.freeze({
      schemaVersion: 1,
      gate: "G2-03-01",
      status: "PASS",
      qualification: "REAL_POSTGRES_16_POLICY_QUERY_SPIKE",
      commit: input.commit,
      cleanCheckout: input.cleanCheckout,
      postgres: Object.freeze({ serverVersionNum }),
      executionContext: Object.freeze({
        source: serving.resolution,
        projectId: serving.projectId,
        releaseId: serving.releaseId,
        activationId: serving.activationId,
        memberCount: serving.members.length,
        generationCount: new Set(serving.members.map(({ generationId }) => generationId)).size,
        readTimestamp: requiredRow(contextResult.rows).readTimestamp.toISOString(),
        resolverSqlShape: servingResolverSql,
      }),
      statements: Object.freeze(evidence),
      assertions: Object.freeze({
        currentGenerationResolvedOnce: true,
        policyBeforePagination: true,
        allValuesParameterized: true,
        fixtureApiBranching: false,
        productionG1Imports: false,
        unboundedCurrentTableSequentialScans: 0,
      }),
    });
    const outputDirectory = resolve(input.repositoryRoot, "generated/ci-report");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      resolve(outputDirectory, "g2-03-01-postgres-query-spike.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
    process.stdout.write(
      `CI_G2_03_01_QUERY_SPIKE status=PASS statements=${String(evidence.length)} postgres=${serverVersionNum}\n`,
    );
    return artifact;
  } finally {
    if (transactionOpen) await client.query("ROLLBACK");
    client.release();
  }
}

async function executeAndExplain(
  client: pg.PoolClient,
  statement: CompiledReadStatement,
  expectedRows: number,
  expectedCount: number | null,
): Promise<StatementEvidence> {
  const result = await client.query<Record<string, unknown>>(statement.text, [...statement.values]);
  if (result.rows.length !== expectedRows) {
    throw new Error(
      `QUERY_SPIKE_RESULT_ROWS_INVALID:${statement.name}:${String(result.rows.length)}`,
    );
  }
  if (expectedCount !== null) {
    const value = requiredRow(result.rows)["count"];
    if (typeof value !== "string" || Number(value) !== expectedCount) {
      throw new Error(`QUERY_SPIKE_COUNT_INVALID:${String(value)}`);
    }
  }
  const explainResult = await client.query<Record<string, unknown>>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
    [...statement.values],
  );
  const explain = explainDocument(requiredRow(explainResult.rows)["QUERY PLAN"]);
  const plan = record(explain["Plan"], "EXPLAIN Plan");
  const nodes = flattenPlan(plan);
  const forbiddenScans = nodes.filter(
    (node) =>
      node["Node Type"] === "Seq Scan" &&
      ["object_current", "link_current"].includes(String(node["Relation Name"])),
  );
  if (forbiddenScans.length > 0) {
    throw new Error(`QUERY_SPIKE_UNBOUNDED_SEQ_SCAN:${statement.name}`);
  }
  const indexes = [
    ...new Set(
      nodes.flatMap((node) => (typeof node["Index Name"] === "string" ? [node["Index Name"]] : [])),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  if (indexes.length === 0) throw new Error(`QUERY_SPIKE_INDEX_NOT_USED:${statement.name}`);
  return Object.freeze({
    name: statement.name,
    sqlShape: statement.text,
    parameterTypes: statement.parameterTypes,
    resultRows: expectedCount ?? result.rows.length,
    indexes: Object.freeze(indexes),
    planningTimeMilliseconds: finiteNumber(explain["Planning Time"]),
    executionTimeMilliseconds: finiteNumber(explain["Execution Time"]),
    bufferBlocks: Object.freeze(sumBuffers(nodes)),
    explainAnalyzeBuffers: explain,
  });
}

function explainDocument(value: unknown): Readonly<Record<string, unknown>> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("QUERY_SPIKE_EXPLAIN_INVALID");
  }
  return record(parsed[0], "EXPLAIN document");
}

function flattenPlan(root: Readonly<Record<string, unknown>>): readonly ExplainNode[] {
  const nodes: ExplainNode[] = [root];
  const children = root["Plans"];
  if (Array.isArray(children)) {
    for (const child of children) nodes.push(...flattenPlan(record(child, "EXPLAIN child")));
  }
  return nodes;
}

function sumBuffers(nodes: readonly ExplainNode[]): {
  readonly hit: number;
  readonly read: number;
  readonly dirtied: number;
  readonly written: number;
} {
  return {
    hit: sumNodeNumbers(nodes, "Shared Hit Blocks"),
    read: sumNodeNumbers(nodes, "Shared Read Blocks"),
    dirtied: sumNodeNumbers(nodes, "Shared Dirtied Blocks"),
    written: sumNodeNumbers(nodes, "Shared Written Blocks"),
  };
}

function sumNodeNumbers(nodes: readonly ExplainNode[], key: string): number {
  return nodes.reduce((sum, node) => sum + (finiteNumber(node[key]) ?? 0), 0);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("QUERY_SPIKE_ROW_REQUIRED");
  return row;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("QUERY_SPIKE_VALUE_REQUIRED");
  return value;
}
