import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import {
  canonicalizeContractForDigest,
  canonicalizeMaterializationContractForDigest,
  parseArtifactDigest,
  parseOntosId,
} from "@ontos/contracts";
import {
  MaterializationBaseError,
  MaterializationBaseService,
  type BaseBatchReceipt,
} from "@ontos/materialization-application";
import {
  compileMapping,
  executeManagedCsvMapping,
  type MappingAcceptedLinkRow,
  type MappingAcceptedObjectRow,
} from "@ontos/materialization-domain";
import { PostgresMaterializationBaseRepository } from "@ontos/materialization-postgres";
import { canonicalizePrimaryKey } from "@ontos/value-codec";
import pg from "pg";

import {
  definitionDigest,
  objectMapping,
  orderObjectType,
} from "../materialization-mapping/fixtures.ts";

import { isDatabaseMigrationError } from "./errors.ts";
import { databaseMigrationDirectory, runDatabaseMigrations } from "./migrator.ts";
import { resolvePostgresTestImage } from "./postgres-test-image.ts";

const execFileAsync = promisify(execFile);
const postgresImage = resolvePostgresTestImage();
const database = "ontos_db02_upgrade";
const adminPassword = "local-only-db02-admin-secret";
const runtimePassword = "local-only-db02-runtime-secret";
const capacityMode = process.env.ONTOS_G2_02_06_CAPACITY === "1";
const capacityMetrics = {
  objectRows: capacityMode ? 10_000 : 2,
  linkRows: capacityMode ? 100_000 : 1,
  objectBatches: 0,
  linkBatches: 0,
  objectMilliseconds: 0,
  linkMilliseconds: 0,
  peakRssBytes: process.memoryUsage().rss,
  walStart: "",
  identityProbeRows: 0,
};

const ids = {
  principal: "10000000-0000-4000-8000-000000000001",
  project: "10000000-0000-4000-8000-000000000101",
  otherProject: "10000000-0000-4000-8000-000000000102",
  objectResource: "10000000-0000-4000-8000-000000000201",
  schemaResource: "10000000-0000-4000-8000-000000000202",
  mappingResource: "10000000-0000-4000-8000-000000000203",
  objectRevision: "10000000-0000-4000-8000-000000000301",
  schemaRevision: "10000000-0000-4000-8000-000000000302",
  mappingRevision: "10000000-0000-4000-8000-000000000303",
  objectValidation: "10000000-0000-4000-8000-000000000311",
  schemaValidation: "10000000-0000-4000-8000-000000000312",
  mappingValidation: "10000000-0000-4000-8000-000000000313",
  releaseValidation1: "10000000-0000-4000-8000-000000000321",
  releaseValidation2: "10000000-0000-4000-8000-000000000322",
  release1: "10000000-0000-4000-8000-000000000401",
  release2: "10000000-0000-4000-8000-000000000402",
  activation0: "10000000-0000-4000-8000-000000000501",
  activation1: "10000000-0000-4000-8000-000000000502",
  activationBadDigest: "10000000-0000-4000-8000-000000000503",
  activationBadCount: "10000000-0000-4000-8000-000000000504",
  activationCrossProject: "10000000-0000-4000-8000-000000000505",
  snapshotGroup: "10000000-0000-4000-8000-000000000601",
  snapshot: "10000000-0000-4000-8000-000000000602",
  snapshotFile: "10000000-0000-4000-8000-000000000603",
  managedArtifact: "10000000-0000-4000-8000-000000000604",
  indexPlan: "10000000-0000-4000-8000-000000000701",
  job: "10000000-0000-4000-8000-000000000801",
  leaseJob: "10000000-0000-4000-8000-000000000802",
  report: "10000000-0000-4000-8000-000000000901",
  generation: "10000000-0000-4000-8000-000000001001",
  certificate: "10000000-0000-4000-8000-000000001101",
  worker1: "10000000-0000-4000-8000-000000001201",
  worker2: "10000000-0000-4000-8000-000000001202",
  attempt1: "10000000-0000-4000-8000-000000001301",
  attempt2: "10000000-0000-4000-8000-000000001302",
  baseAttempt1: "10000000-0000-4000-8000-000000001303",
  baseAttempt2: "10000000-0000-4000-8000-000000001304",
  checkpoint: "10000000-0000-4000-8000-000000001401",
  ingressSession: "10000000-0000-4000-8000-000000001501",
  ingressExpiredSession: "10000000-0000-4000-8000-000000001502",
  ingressArtifact: "10000000-0000-4000-8000-000000001601",
  ingressExpiredArtifact: "10000000-0000-4000-8000-000000001602",
  ingressClaim: "10000000-0000-4000-8000-000000001701",
  ingressSnapshot: "10000000-0000-4000-8000-000000001801",
  ingressFile: "10000000-0000-4000-8000-000000001901",
  linkResource: "10000000-0000-4000-8000-000000002001",
  linkRevision: "10000000-0000-4000-8000-000000002002",
  linkValidation: "10000000-0000-4000-8000-000000002003",
  linkSourceDependency: "10000000-0000-4000-8000-000000002004",
  linkTargetDependency: "10000000-0000-4000-8000-000000002005",
  linkIndexPlan: "10000000-0000-4000-8000-000000002006",
  linkSnapshotGroup: "10000000-0000-4000-8000-000000002007",
  linkSnapshot: "10000000-0000-4000-8000-000000002008",
  linkSnapshotFile: "10000000-0000-4000-8000-000000002009",
  linkManagedArtifact: "10000000-0000-4000-8000-00000000200a",
  linkJob: "10000000-0000-4000-8000-00000000200b",
  linkReport: "10000000-0000-4000-8000-00000000200c",
  linkGeneration: "10000000-0000-4000-8000-00000000200d",
  linkAttempt: "10000000-0000-4000-8000-00000000200e",
} as const;

const digests = {
  object: digestOf("1"),
  schema: digestOf("2"),
  mapping: digestOf("3"),
  release1: digestOf("4"),
  release2: digestOf("5"),
  validationContext1: digestOf("6"),
  validationContext2: digestOf("7"),
  indexPlan: digestOf("8"),
  group: digestOf("9"),
  snapshotContent: digestOf("a"),
  snapshot: digestOf("b"),
  report: digestOf("c"),
  generation: digestOf("d"),
  evidence: digestOf("e"),
  job: digestOf("f"),
  batch1: digestOf("0"),
  batch2: digestOf("a"),
  checkpoint: digestOf("b"),
  activation0: digestOf("c"),
} as const;

void test(
  "G2-02-03 upgrades A0 safely and enforces DB-02 facts, fencing and least privilege",
  { timeout: capacityMode ? 600_000 : 240_000 },
  async () => {
    const containerName = `ontos-db02-${process.pid}-${randomUUID().slice(0, 8)}`;
    const prefix6 = await migrationPrefixDirectory(6);
    await docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--env",
      `POSTGRES_PASSWORD=${adminPassword}`,
      "--env",
      `POSTGRES_DB=${database}`,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,noexec,nosuid,size=1g",
      "--publish",
      "127.0.0.1::5432",
      postgresImage,
    ]);

    try {
      const port = await publishedPostgreSqlPort(containerName);
      const adminConfig: pg.ClientConfig = {
        host: "127.0.0.1",
        port,
        database,
        user: "postgres",
        password: adminPassword,
        application_name: "ontos-db02-integration",
      };
      await waitForPostgreSql(adminConfig);

      let beforeUpgrade: Awaited<ReturnType<typeof activationSnapshot>>;
      let prefixLedger: readonly LedgerRow[];
      await withClient(adminConfig, async (admin) => {
        const baseline = await runDatabaseMigrations(admin, { directory: prefix6 });
        assert.deepEqual(
          baseline.applied.map(({ version }) => version),
          [1, 2, 3, 4, 5, 6],
        );
        await seedMetadataOnlyRelease(admin);
        beforeUpgrade = await activationSnapshot(admin, ids.activation0);
        prefixLedger = await migrationLedger(admin, 6);

        const upgrade = await runDatabaseMigrations(admin);
        assert.deepEqual(
          upgrade.applied.map(({ version }) => version),
          [7, 8, 9, 10, 11],
        );
        assert.equal((await runDatabaseMigrations(admin)).noOp, true);
        assert.deepEqual(await migrationLedger(admin, 6), prefixLedger);
        assert.deepEqual(await activationSnapshot(admin, ids.activation0), beforeUpgrade);
        await assertDb02Catalog(admin);
        await createRuntimeLogins(admin);
      });

      const apiConfig = { ...adminConfig, user: "g20203_api_login", password: runtimePassword };
      const worker1Config = {
        ...adminConfig,
        user: "g20203_worker1_login",
        password: runtimePassword,
      };
      const worker2Config = {
        ...adminConfig,
        user: "g20203_worker2_login",
        password: runtimePassword,
      };
      const opsConfig = { ...adminConfig, user: "g20203_ops_login", password: runtimePassword };

      await withClient(adminConfig, async (admin) => {
        await prepareRuntimeFacts(admin);
      });
      await exercisePermanentIdentityAndObjectBase(adminConfig, worker1Config, worker2Config);
      await withClient(adminConfig, prepareLinkRuntimeFacts);
      await exerciseLinkBase(adminConfig, apiConfig, worker1Config);
      await exerciseManagedCsvIngressDatabase(apiConfig, worker1Config, opsConfig);
      await withClient(apiConfig, async (api) => {
        await issueCertificateAndPublishA1(api);
      });
      await withClient(adminConfig, async (admin) => {
        assert.deepEqual(await activationSnapshot(admin, ids.activation0), beforeUpgrade);
        await assertA1AndCrossProjectGuards(admin);
        await assertImmutableAndControlledBoundaries(admin);
      });

      await exerciseRealWorkerFencing(adminConfig, apiConfig, worker1Config, worker2Config);
      await assertRuntimePrivilegeMatrix(apiConfig, worker1Config, opsConfig);
      await assertFreshConcurrentMigration(adminConfig);
      await assertEveryDb02MigrationRollsBack(adminConfig);
    } finally {
      await rm(prefix6, { recursive: true, force: true });
      await docker(["rm", "--force", "--volumes", containerName], true);
    }
  },
);

interface LedgerRow {
  readonly version: string;
  readonly name: string;
  readonly sha256: string;
}

async function seedMetadataOnlyRelease(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO authz.principals
       (principal_id, oidc_issuer, oidc_subject, display_name)
     VALUES ($1, 'https://issuer.db02.test', 'db02-owner', 'DB-02 Owner')`,
    [ids.principal],
  );
  await client.query(
    `INSERT INTO meta.projects (project_id, api_name, display_name)
     VALUES ($1, 'Db02Project', 'DB-02 Project')`,
    [ids.project],
  );
  await createPublishedResource(client, {
    resourceId: ids.objectResource,
    revisionId: ids.objectRevision,
    reportId: ids.objectValidation,
    family: "object_type",
    apiName: "Order",
    contentDigest: digests.object,
  });
  await client.query(
    `INSERT INTO meta.releases
       (release_id, project_id, release_number, manifest_digest,
        target_channel_name, created_by_principal_id)
     VALUES ($1, $2, 1, $3, 'production', $4)`,
    [ids.release1, ids.project, digests.release1, ids.principal],
  );
  await client.query(
    `INSERT INTO meta.release_pins
       (release_id, resource_id, revision_id, pin_order, family, content_digest)
     VALUES ($1, $2, $3, 0, 'object_type', $4)`,
    [ids.release1, ids.objectResource, ids.objectRevision, digests.object],
  );
  await client.query(
    `INSERT INTO meta.validation_reports
       (report_id, subject_type, subject_id, release_id, subject_digest,
        validation_context_digest, validator_version, valid, issues)
     VALUES ($1, 'release', $2, $2, $3, $4,
             'metadata-release-g2-01-v1', TRUE, '[]'::jsonb)`,
    [ids.releaseValidation1, ids.release1, digests.release1, digests.validationContext1],
  );
  await client.query(
    `UPDATE meta.releases
     SET state = 'staging', staged_channel_control_sequence = 0,
         staged_validation_context_digest = $2, staged_at = clock_timestamp(),
         changed_at = clock_timestamp()
     WHERE release_id = $1`,
    [ids.release1, digests.validationContext1],
  );
  await client.query(
    `UPDATE meta.releases SET state = 'ready', changed_at = clock_timestamp()
     WHERE release_id = $1`,
    [ids.release1],
  );
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO meta.runtime_activations
       (activation_id, release_id, activation_digest)
     VALUES ($1, $2, $3)`,
    [ids.activation0, ids.release1, digests.activation0],
  );
  await client.query(
    `UPDATE meta.releases
     SET state = 'published', published_by_principal_id = $2,
         published_at = clock_timestamp(), changed_at = clock_timestamp()
     WHERE release_id = $1`,
    [ids.release1, ids.principal],
  );
  await client.query(
    `INSERT INTO meta.release_serving_heads
       (release_id, activation_id, control_sequence) VALUES ($1, $2, 1)`,
    [ids.release1, ids.activation0],
  );
  await client.query(
    `INSERT INTO meta.release_channels
       (project_id, channel_name, release_id, activation_id, control_sequence)
     VALUES ($1, 'production', $2, $3, 1)`,
    [ids.project, ids.release1, ids.activation0],
  );
  await client.query("COMMIT");
}

async function createPublishedResource(
  client: pg.Client,
  input: {
    readonly resourceId: string;
    readonly revisionId: string;
    readonly reportId: string;
    readonly family: "object_type" | "snapshot_schema" | "mapping";
    readonly apiName: string;
    readonly contentDigest: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO meta.resources
       (resource_id, project_id, namespace, api_name, family)
     VALUES ($1, $2, 'db02.core', $3, $4)`,
    [input.resourceId, ids.project, input.apiName, input.family],
  );
  await client.query(
    `INSERT INTO meta.resource_revisions
       (revision_id, resource_id, revision_number, family, content_digest,
        content, created_by_principal_id)
     VALUES ($1, $2, 1, $3, $4, '{"schemaVersion":1}'::jsonb, $5)`,
    [input.revisionId, input.resourceId, input.family, input.contentDigest, ids.principal],
  );
  await client.query(
    `INSERT INTO meta.validation_reports
       (report_id, subject_type, subject_id, resource_revision_id,
        subject_digest, validation_context_digest, validator_version, valid, issues)
     VALUES ($1, 'resource_revision', $2, $2, $3, $3,
             'metadata-g2-01-v1', TRUE, '[]'::jsonb)`,
    [input.reportId, input.revisionId, input.contentDigest],
  );
  await client.query(
    `UPDATE meta.resource_revisions
     SET state = 'validated', changed_at = clock_timestamp() WHERE revision_id = $1`,
    [input.revisionId],
  );
  await client.query(
    `UPDATE meta.resource_revisions
     SET state = 'published', changed_at = clock_timestamp() WHERE revision_id = $1`,
    [input.revisionId],
  );
}

async function prepareRuntimeFacts(client: pg.Client): Promise<void> {
  await createPublishedResource(client, {
    resourceId: ids.schemaResource,
    revisionId: ids.schemaRevision,
    reportId: ids.schemaValidation,
    family: "snapshot_schema",
    apiName: "OrderCsvSchema",
    contentDigest: digests.schema,
  });
  await createPublishedResource(client, {
    resourceId: ids.mappingResource,
    revisionId: ids.mappingRevision,
    reportId: ids.mappingValidation,
    family: "mapping",
    apiName: "OrderCsvMapping",
    contentDigest: digests.mapping,
  });
  await client.query(
    `INSERT INTO meta.projects (project_id, api_name, display_name)
     VALUES ($1, 'Db02OtherProject', 'DB-02 Other Project')`,
    [ids.otherProject],
  );

  await client.query(
    `INSERT INTO meta.releases
       (release_id, project_id, release_number, manifest_digest,
        target_channel_name, created_by_principal_id)
     VALUES ($1, $2, 2, $3, 'production', $4)`,
    [ids.release2, ids.project, digests.release2, ids.principal],
  );
  for (const [order, resourceId, revisionId, family, contentDigest] of [
    [0, ids.objectResource, ids.objectRevision, "object_type", digests.object],
    [1, ids.schemaResource, ids.schemaRevision, "snapshot_schema", digests.schema],
    [2, ids.mappingResource, ids.mappingRevision, "mapping", digests.mapping],
  ] as const) {
    await client.query(
      `INSERT INTO meta.release_pins
         (release_id, resource_id, revision_id, pin_order, family, content_digest)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ids.release2, resourceId, revisionId, order, family, contentDigest],
    );
  }
  await client.query(
    `INSERT INTO meta.validation_reports
       (report_id, subject_type, subject_id, release_id, subject_digest,
        validation_context_digest, validator_version, valid, issues)
     VALUES ($1, 'release', $2, $2, $3, $4,
             'metadata-release-g2-01-v1', TRUE, '[]'::jsonb)`,
    [ids.releaseValidation2, ids.release2, digests.release2, digests.validationContext2],
  );
  await client.query(
    `UPDATE meta.releases
     SET state = 'staging', staged_from_release_id = $2,
         staged_from_activation_id = $3, staged_channel_control_sequence = 1,
         staged_validation_context_digest = $4, staged_at = clock_timestamp(),
         changed_at = clock_timestamp()
     WHERE release_id = $1`,
    [ids.release2, ids.release1, ids.activation0, digests.validationContext2],
  );
  await client.query(
    `UPDATE meta.releases SET state = 'ready', changed_at = clock_timestamp()
     WHERE release_id = $1`,
    [ids.release2],
  );

  await client.query(
    `INSERT INTO runtime.snapshot_groups
       (project_id, snapshot_group_id, group_key) VALUES ($1, $2, 'orders')`,
    [ids.project, ids.snapshotGroup],
  );
  await client.query(
    `INSERT INTO runtime.index_plans
       (project_id, index_plan_id, target_resource_id, target_revision_id,
        plan_digest, entry_count, compiler_version)
     VALUES ($1, $2, $3, $4, $5, 0, 'index-plan-g2-02-v1')`,
    [ids.project, ids.indexPlan, ids.objectResource, ids.objectRevision, digests.indexPlan],
  );

  const runtimePlanDigest = materializationDigest("RuntimeMemberPlan", {
    schemaVersion: 1,
    contractVersion: "runtime-member-plan-v1",
    projectId: ids.project,
    releaseId: ids.release2,
    members: [
      {
        memberKey: "object:Order",
        memberKind: "object",
        targetResourceId: ids.objectResource,
        targetRevisionId: ids.objectRevision,
        snapshotSchemaRevisionId: ids.schemaRevision,
        mappingRevisionId: ids.mappingRevision,
        snapshotGroupId: ids.snapshotGroup,
        indexPlanDigest: digests.indexPlan,
      },
    ],
    planDigest: digestOf("0"),
  });

  await client.query("BEGIN");
  await client.query(
    `INSERT INTO meta.release_runtime_plans
       (project_id, release_id, plan_digest, member_count) VALUES ($1, $2, $3, 1)`,
    [ids.project, ids.release2, runtimePlanDigest],
  );
  await client.query(
    `INSERT INTO meta.release_runtime_plan_members (
       project_id, release_id, runtime_plan_digest, member_key, member_kind,
       target_resource_id, target_revision_id,
       snapshot_schema_resource_id, snapshot_schema_revision_id,
       mapping_resource_id, mapping_revision_id, snapshot_group_id, index_plan_digest
     ) VALUES ($1, $2, $3, 'object:Order', 'object', $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      ids.project,
      ids.release2,
      runtimePlanDigest,
      ids.objectResource,
      ids.objectRevision,
      ids.schemaResource,
      ids.schemaRevision,
      ids.mappingResource,
      ids.mappingRevision,
      ids.snapshotGroup,
      digests.indexPlan,
    ],
  );
  await client.query("COMMIT");
  const dbDigest = await client.query<{ readonly digest: string }>(
    `SELECT ontos_migration.g20203_runtime_plan_digest($1, $2) AS digest`,
    [ids.project, ids.release2],
  );
  assert.equal(dbDigest.rows[0]?.digest, runtimePlanDigest);

  await client.query("BEGIN");
  await client.query(
    `INSERT INTO runtime.snapshot_group_versions
       (project_id, snapshot_group_id, group_version, member_count, group_digest)
     VALUES ($1, $2, 1, 1, $3)`,
    [ids.project, ids.snapshotGroup, digests.group],
  );
  await client.query(
    `INSERT INTO runtime.dataset_snapshots (
       project_id, snapshot_id, snapshot_group_id, group_version,
       member_key, member_kind, target_resource_id, target_revision_id,
       snapshot_schema_resource_id, snapshot_schema_revision_id,
       mapping_resource_id, mapping_revision_id, runtime_plan_digest,
       content_digest, byte_count, row_count, file_count, snapshot_digest
     ) VALUES (
       $1, $2, $3, 1, 'object:Order', 'object', $4, $5, $6, $7, $8, $9,
       $10, $11, 0, 0, 1, $12
     )`,
    [
      ids.project,
      ids.snapshot,
      ids.snapshotGroup,
      ids.objectResource,
      ids.objectRevision,
      ids.schemaResource,
      ids.schemaRevision,
      ids.mappingResource,
      ids.mappingRevision,
      runtimePlanDigest,
      digests.snapshotContent,
      digests.snapshot,
    ],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_files (
       project_id, snapshot_id, file_id, managed_artifact_id, object_version,
       ordinal, content_digest, byte_count, row_count, source_label, scan_status
     ) VALUES ($1, $2, $3, $4, 'version-1', 0, $5, 0, 0,
               'DB-02 migration fixture', 'complete')`,
    [ids.project, ids.snapshot, ids.snapshotFile, ids.managedArtifact, digests.snapshotContent],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_group_members (
       project_id, snapshot_group_id, group_version, member_key, member_kind,
       snapshot_id, target_resource_id, target_revision_id
     ) VALUES ($1, $2, 1, 'object:Order', 'object', $3, $4, $5)`,
    [ids.project, ids.snapshotGroup, ids.snapshot, ids.objectResource, ids.objectRevision],
  );
  await client.query("COMMIT");

  for (const state of ["validated", "materializing", "ready"] as const) {
    await client.query(
      `UPDATE runtime.snapshot_group_versions
       SET state = $4, changed_at = clock_timestamp()
       WHERE project_id = $1 AND snapshot_group_id = $2 AND group_version = $3`,
      [ids.project, ids.snapshotGroup, 1, state],
    );
    await client.query(
      `UPDATE runtime.dataset_snapshots
       SET state = $3, changed_at = clock_timestamp()
       WHERE project_id = $1 AND snapshot_id = $2`,
      [ids.project, ids.snapshot, state],
    );
  }

  await client.query(
    `INSERT INTO ops.materialization_jobs
       (project_id, job_id, snapshot_group_id, group_version, idempotency_key, input_digest)
     VALUES ($1, $2, $3, 1, 'db02-runtime-job-0001', $4)`,
    [ids.project, ids.job, ids.snapshotGroup, digests.job],
  );
  await client.query(
    `INSERT INTO runtime.materialization_reports (
       project_id, report_id, snapshot_group_id, group_version, job_id, outcome,
       total_rows, accepted_rows, rejected_rows, validator_version, report_digest
     ) VALUES ($1, $2, $3, 1, $4, 'passed', 0, 0, 0,
               'materialization-g2-02-v1', $5)`,
    [ids.project, ids.report, ids.snapshotGroup, ids.job, digests.report],
  );
  await client.query(
    `INSERT INTO runtime.generations (
       project_id, generation_id, member_key, member_kind,
       target_resource_id, target_revision_id, snapshot_id, snapshot_group_id, group_version,
       snapshot_schema_resource_id, snapshot_schema_revision_id,
       mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest,
       report_id, report_digest, generation_digest
     ) VALUES (
       $1, $2, 'object:Order', 'object', $3, $4, $5, $6, 1,
       $7, $8, $9, $10, $11, $12, $13, $14, $15
     )`,
    [
      ids.project,
      ids.generation,
      ids.objectResource,
      ids.objectRevision,
      ids.snapshot,
      ids.snapshotGroup,
      ids.schemaResource,
      ids.schemaRevision,
      ids.mappingResource,
      ids.mappingRevision,
      runtimePlanDigest,
      digests.indexPlan,
      ids.report,
      digests.report,
      digests.generation,
    ],
  );
  const empty = await client.query<{ readonly objects: number; readonly links: number }>(
    `SELECT
       (SELECT count(*)::integer FROM runtime.object_current WHERE generation_id = $1) AS objects,
       (SELECT count(*)::integer FROM runtime.link_current WHERE generation_id = $1) AS links`,
    [ids.generation],
  );
  assert.deepEqual(empty.rows[0], { objects: 0, links: 0 });
}

async function exercisePermanentIdentityAndObjectBase(
  adminConfig: pg.ClientConfig,
  worker1Config: pg.ClientConfig,
  worker2Config: pg.ClientConfig,
): Promise<void> {
  capacityMetrics.identityProbeRows = capacityMode
    ? 0
    : await assertConcurrentIdentityResolution(adminConfig, worker1Config, worker2Config);
  if (capacityMode) {
    capacityMetrics.walStart = await withClient(adminConfig, async (admin) => {
      const result = await admin.query<{ readonly lsn: string }>(
        "SELECT pg_current_wal_lsn()::text AS lsn",
      );
      return result.rows[0]?.lsn ?? "";
    });
  }
  const objectStartedAt = process.hrtime.bigint();
  const firstClaim = await withClient(worker1Config, async (worker) => {
    const result = await worker.query<{
      readonly job_id: string;
      readonly fencing_token: string;
    }>(
      `SELECT job_id, fencing_token::text
       FROM ops.claim_materialization_job($1, $2, 300)`,
      [ids.worker1, ids.baseAttempt1],
    );
    assert.equal(result.rows[0]?.job_id, ids.job);
    return result.rows[0];
  });
  assert.ok(firstClaim);
  const firstPool = new pg.Pool(worker1Config);
  const rows = capacityMode
    ? []
    : Array.from({ length: capacityMetrics.objectRows }, (_, index) =>
        baseObjectRow(index + 1, `order-${String(index + 1)}`),
      );
  samplePeakRss();
  const firstReceipts = await (async (): Promise<readonly BaseBatchReceipt[]> => {
    try {
      const service = baseService(firstPool);
      const attemptScope = {
        projectId: ids.project,
        jobId: ids.job,
        attemptId: ids.baseAttempt1,
        fencingToken: BigInt(firstClaim.fencing_token),
      };
      return capacityMode
        ? await stageObjectUpload(service, attemptScope, capacityMetrics.objectRows)
        : await stageObjectRows(service, attemptScope, rows);
    } finally {
      await firstPool.end();
    }
  })();

  await withClient(adminConfig, async (admin) => {
    const invisible = await admin.query<{ readonly count: number }>(
      `SELECT count(*)::integer AS count FROM runtime.object_base
       WHERE project_id = $1 AND generation_id = $2`,
      [ids.project, ids.generation],
    );
    assert.equal(invisible.rows[0]?.count, 0);
    await admin.query(
      `UPDATE ops.materialization_jobs
       SET lease_expires_at = clock_timestamp() - interval '1 second',
           updated_at = clock_timestamp()
       WHERE project_id = $1 AND job_id = $2`,
      [ids.project, ids.job],
    );
  });

  const secondClaim = await withClient(worker2Config, async (worker) => {
    const result = await worker.query<{
      readonly job_id: string;
      readonly fencing_token: string;
    }>(
      `SELECT job_id, fencing_token::text
       FROM ops.claim_materialization_job($1, $2, 300)`,
      [ids.worker2, ids.baseAttempt2],
    );
    assert.equal(result.rows[0]?.job_id, ids.job);
    return result.rows[0];
  });
  assert.ok(secondClaim);

  const stalePool = new pg.Pool(worker1Config);
  try {
    await assert.rejects(
      baseService(stalePool).promoteGenerationBase({
        scope: {
          projectId: ids.project,
          jobId: ids.job,
          attemptId: ids.baseAttempt1,
          fencingToken: BigInt(firstClaim.fencing_token),
        },
        generationId: ids.generation,
        expectedRowCount: capacityMetrics.objectRows,
        batchReceipts: firstReceipts,
      }),
      (error: unknown) =>
        error instanceof MaterializationBaseError &&
        error.code === "MATERIALIZATION_ATTEMPT_FENCED",
    );
  } finally {
    await stalePool.end();
  }

  const secondPool = new pg.Pool(worker2Config);
  const secondReceipts = await (async (): Promise<readonly BaseBatchReceipt[]> => {
    try {
      const service = baseService(secondPool);
      const attemptScope = {
        projectId: ids.project,
        jobId: ids.job,
        attemptId: ids.baseAttempt2,
        fencingToken: BigInt(secondClaim.fencing_token),
      };
      const receipts = capacityMode
        ? await stageObjectUpload(service, attemptScope, capacityMetrics.objectRows)
        : await stageObjectRows(service, attemptScope, rows);
      assert.deepEqual(
        receipts.map(({ batchDigest }) => batchDigest),
        firstReceipts.map(({ batchDigest }) => batchDigest),
      );
      const promoted = await service.promoteGenerationBase({
        scope: {
          projectId: ids.project,
          jobId: ids.job,
          attemptId: ids.baseAttempt2,
          fencingToken: BigInt(secondClaim.fencing_token),
        },
        generationId: ids.generation,
        expectedRowCount: capacityMetrics.objectRows,
        batchReceipts: receipts,
      });
      assert.equal(promoted.reused, false);
      return receipts;
    } finally {
      await secondPool.end();
    }
  })();

  const restartedPool = new pg.Pool(worker2Config);
  try {
    const replay = await baseService(restartedPool).promoteGenerationBase({
      scope: {
        projectId: ids.project,
        jobId: ids.job,
        attemptId: ids.baseAttempt2,
        fencingToken: BigInt(secondClaim.fencing_token),
      },
      generationId: ids.generation,
      expectedRowCount: capacityMetrics.objectRows,
      batchReceipts: firstReceipts,
    });
    assert.equal(replay.reused, true);
  } finally {
    await restartedPool.end();
  }

  await withClient(adminConfig, async (admin) => {
    const state = await admin.query<{
      readonly identities: number;
      readonly staged: number;
      readonly base: number;
      readonly distinct_rids: number;
      readonly abandoned: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM runtime.object_identities
           WHERE project_id = $1 AND object_type_resource_id = $2) AS identities,
         (SELECT count(*)::integer FROM ops.object_base_staging
           WHERE project_id = $1 AND generation_id = $3) AS staged,
         (SELECT count(*)::integer FROM runtime.object_base
           WHERE project_id = $1 AND generation_id = $3) AS base,
         (SELECT count(DISTINCT object_rid)::integer FROM ops.object_base_staging
           WHERE project_id = $1 AND generation_id = $3) AS distinct_rids,
         (SELECT count(*)::integer FROM ops.materialization_attempts
           WHERE project_id = $1 AND job_id = $4 AND state = 'abandoned') AS abandoned`,
      [ids.project, ids.objectResource, ids.generation, ids.job],
    );
    assert.deepEqual(state.rows[0], {
      identities: capacityMetrics.objectRows + capacityMetrics.identityProbeRows,
      staged: capacityMetrics.objectRows * 2,
      base: capacityMetrics.objectRows,
      distinct_rids: capacityMetrics.objectRows,
      abandoned: 1,
    });
    await admin.query(
      `UPDATE ops.materialization_attempts
       SET state = 'completed', finished_at = clock_timestamp(), result_code = 'BASE_PROMOTED'
       WHERE project_id = $1 AND attempt_id = $2 AND state = 'leased'`,
      [ids.project, ids.baseAttempt2],
    );
    await admin.query(
      `UPDATE ops.materialization_jobs
       SET state = 'succeeded', lease_owner_id = NULL, lease_expires_at = NULL,
           result_code = 'BASE_PROMOTED', updated_at = clock_timestamp()
       WHERE project_id = $1 AND job_id = $2`,
      [ids.project, ids.job],
    );
    await admin.query(
      `UPDATE runtime.generations SET state = 'ready', changed_at = clock_timestamp()
       WHERE project_id = $1 AND generation_id = $2`,
      [ids.project, ids.generation],
    );
  });
  capacityMetrics.objectBatches = secondReceipts.length;
  capacityMetrics.objectMilliseconds = elapsedMilliseconds(objectStartedAt);
  samplePeakRss();
}

async function assertConcurrentIdentityResolution(
  adminConfig: pg.ClientConfig,
  worker1Config: pg.ClientConfig,
  worker2Config: pg.ClientConfig,
): Promise<number> {
  const first = new pg.Client(worker1Config);
  const second = new pg.Client(worker2Config);
  await Promise.all([first.connect(), second.connect()]);
  const canonicalPrimaryKey = canonicalizePrimaryKey(["order-concurrent"], {
    components: [{ type: "string", caseSensitive: false }],
  });
  const resolveSql = `SELECT ordinal, object_rid::text AS object_rid
                        FROM runtime.resolve_or_create_object_identities($1, $2::jsonb)`;
  const candidates = () =>
    JSON.stringify([
      {
        ordinal: 0,
        objectTypeResourceId: ids.objectResource,
        canonicalPrimaryKey,
        candidateObjectRid: randomUUID(),
      },
    ]);
  let committed = false;
  try {
    await first.query("BEGIN");
    const firstResolution = await first.query<{ readonly object_rid: string }>(resolveSql, [
      ids.project,
      candidates(),
    ]);
    const concurrent = second
      .query<{ readonly object_rid: string }>(resolveSql, [ids.project, candidates()])
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    await first.query("COMMIT");
    committed = true;
    const secondOutcome = await concurrent;
    if (!secondOutcome.ok) throw secondOutcome.error;
    assert.equal(firstResolution.rows[0]?.object_rid, secondOutcome.value.rows[0]?.object_rid);
    const count = await withClient(adminConfig, async (admin) =>
      admin.query<{ readonly count: number }>(
        `SELECT count(*)::integer AS count
           FROM runtime.object_identities
          WHERE project_id = $1 AND object_type_resource_id = $2
            AND canonical_primary_key = $3`,
        [ids.project, ids.objectResource, canonicalPrimaryKey],
      ),
    );
    assert.equal(count.rows[0]?.count, 1);
    return 1;
  } finally {
    if (!committed) await first.query("ROLLBACK").catch(() => undefined);
    await Promise.all([first.end(), second.end()]);
  }
}

async function prepareLinkRuntimeFacts(client: pg.Client): Promise<void> {
  const linkDefinition = {
    schemaVersion: 1,
    apiName: "OrderRelation",
    displayName: "Order Relation",
    description: "DB-02 permanent Link Base fixture.",
    source: {
      objectTypeRevisionId: ids.objectRevision,
      apiName: "sourceOrder",
      displayName: "Source Order",
    },
    target: {
      objectTypeRevisionId: ids.objectRevision,
      apiName: "targetOrder",
      displayName: "Target Order",
    },
    cardinality: "many_to_many",
    sourceKind: "base",
    deletionBehavior: "restrict",
    actionCreateAllowed: false,
    actionDeleteAllowed: false,
  } as const;
  const linkDefinitionDigest = sha256Digest(canonicalizeContractForDigest(linkDefinition));
  await client.query(
    `INSERT INTO meta.resources
       (resource_id, project_id, namespace, api_name, family)
     VALUES ($1, $2, 'db02.core', 'OrderRelation', 'link_type')`,
    [ids.linkResource, ids.project],
  );
  await client.query(
    `INSERT INTO meta.resource_revisions
       (revision_id, resource_id, revision_number, family, content_digest,
        content, created_by_principal_id)
     VALUES ($1, $2, 1, 'link_type', $3, $4::jsonb, $5)`,
    [
      ids.linkRevision,
      ids.linkResource,
      linkDefinitionDigest,
      JSON.stringify(linkDefinition),
      ids.principal,
    ],
  );
  await client.query(
    `INSERT INTO meta.resource_dependencies
       (dependency_id, source_revision_id, target_revision_id, dependency_type, source_path)
     VALUES
       ($1, $3, $4, 'link_source', '/source/objectTypeRevisionId'),
       ($2, $3, $4, 'link_target', '/target/objectTypeRevisionId')`,
    [ids.linkSourceDependency, ids.linkTargetDependency, ids.linkRevision, ids.objectRevision],
  );
  await client.query(
    `INSERT INTO meta.validation_reports
       (report_id, subject_type, subject_id, resource_revision_id,
        subject_digest, validation_context_digest, validator_version, valid, issues)
     VALUES ($1, 'resource_revision', $2, $2, $3, $3,
             'metadata-g2-01-v1', TRUE, '[]'::jsonb)`,
    [ids.linkValidation, ids.linkRevision, linkDefinitionDigest],
  );
  for (const state of ["validated", "published"] as const) {
    await client.query(
      `UPDATE meta.resource_revisions
       SET state = $2, changed_at = clock_timestamp() WHERE revision_id = $1`,
      [ids.linkRevision, state],
    );
  }

  const indexDigest = sha256Digest("link-index-plan");
  const groupDigest = sha256Digest("link-snapshot-group");
  const contentDigest = sha256Digest("link-snapshot-content");
  const snapshotDigest = sha256Digest("link-snapshot");
  const runtimePlanDigest = sha256Digest("link-runtime-plan");
  const jobDigest = sha256Digest("link-job");
  const reportDigest = sha256Digest("link-report");
  const generationDigest = sha256Digest("link-generation");
  await client.query(
    `INSERT INTO runtime.index_plans
       (project_id, index_plan_id, target_resource_id, target_revision_id,
        plan_digest, entry_count, compiler_version)
     VALUES ($1, $2, $3, $4, $5, 0, 'index-plan-g2-02-v1')`,
    [ids.project, ids.linkIndexPlan, ids.linkResource, ids.linkRevision, indexDigest],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_groups
       (project_id, snapshot_group_id, group_key)
     VALUES ($1, $2, 'order-links')`,
    [ids.project, ids.linkSnapshotGroup],
  );
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO runtime.snapshot_group_versions
       (project_id, snapshot_group_id, group_version, member_count, group_digest)
     VALUES ($1, $2, 1, 1, $3)`,
    [ids.project, ids.linkSnapshotGroup, groupDigest],
  );
  await client.query(
    `INSERT INTO runtime.dataset_snapshots (
       project_id, snapshot_id, snapshot_group_id, group_version,
       member_key, member_kind, target_resource_id, target_revision_id,
       snapshot_schema_resource_id, snapshot_schema_revision_id,
       mapping_resource_id, mapping_revision_id, runtime_plan_digest,
       content_digest, byte_count, row_count, file_count, snapshot_digest
     ) VALUES (
       $1, $2, $3, 1, 'link:OrderRelation', 'link', $4, $5, $6, $7, $8, $9,
       $10, $11, 64, 2, 1, $12
     )`,
    [
      ids.project,
      ids.linkSnapshot,
      ids.linkSnapshotGroup,
      ids.linkResource,
      ids.linkRevision,
      ids.schemaResource,
      ids.schemaRevision,
      ids.mappingResource,
      ids.mappingRevision,
      runtimePlanDigest,
      contentDigest,
      snapshotDigest,
    ],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_files (
       project_id, snapshot_id, file_id, managed_artifact_id, object_version,
       ordinal, content_digest, byte_count, row_count, source_label, scan_status
     ) VALUES ($1, $2, $3, $4, 'link-version-1', 0, $5, 64, 2,
               'DB-02 Link Base fixture', 'complete')`,
    [ids.project, ids.linkSnapshot, ids.linkSnapshotFile, ids.linkManagedArtifact, contentDigest],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_group_members (
       project_id, snapshot_group_id, group_version, member_key, member_kind,
       snapshot_id, target_resource_id, target_revision_id
     ) VALUES ($1, $2, 1, 'link:OrderRelation', 'link', $3, $4, $5)`,
    [ids.project, ids.linkSnapshotGroup, ids.linkSnapshot, ids.linkResource, ids.linkRevision],
  );
  await client.query("COMMIT");
  await client.query(
    `INSERT INTO ops.materialization_jobs
       (project_id, job_id, snapshot_group_id, group_version, idempotency_key, input_digest)
     VALUES ($1, $2, $3, 1, 'db02-link-base-job-0001', $4)`,
    [ids.project, ids.linkJob, ids.linkSnapshotGroup, jobDigest],
  );
  await client.query(
    `INSERT INTO runtime.materialization_reports (
       project_id, report_id, snapshot_group_id, group_version, job_id, outcome,
       total_rows, accepted_rows, rejected_rows, validator_version, report_digest
     ) VALUES ($1, $2, $3, 1, $4, 'passed', 1, 1, 0,
               'materialization-g2-02-v1', $5)`,
    [ids.project, ids.linkReport, ids.linkSnapshotGroup, ids.linkJob, reportDigest],
  );
  await client.query(
    `INSERT INTO runtime.generations (
       project_id, generation_id, member_key, member_kind,
       target_resource_id, target_revision_id, snapshot_id, snapshot_group_id, group_version,
       snapshot_schema_resource_id, snapshot_schema_revision_id,
       mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest,
       report_id, report_digest, generation_digest
     ) VALUES (
       $1, $2, 'link:OrderRelation', 'link', $3, $4, $5, $6, 1,
       $7, $8, $9, $10, $11, $12, $13, $14, $15
     )`,
    [
      ids.project,
      ids.linkGeneration,
      ids.linkResource,
      ids.linkRevision,
      ids.linkSnapshot,
      ids.linkSnapshotGroup,
      ids.schemaResource,
      ids.schemaRevision,
      ids.mappingResource,
      ids.mappingRevision,
      runtimePlanDigest,
      indexDigest,
      ids.linkReport,
      reportDigest,
      generationDigest,
    ],
  );
}

async function exerciseLinkBase(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
): Promise<void> {
  const linkStartedAt = process.hrtime.bigint();
  const claim = await withClient(workerConfig, async (worker) => {
    const result = await worker.query<{ readonly fencing_token: string }>(
      `SELECT fencing_token::text
       FROM ops.claim_materialization_job($1, $2, 300)`,
      [ids.worker1, ids.linkAttempt],
    );
    return result.rows[0];
  });
  assert.ok(claim);
  const pool = new pg.Pool(workerConfig);
  const batchReceipts = await (async (): Promise<readonly BaseBatchReceipt[]> => {
    try {
      const service = baseService(pool);
      await assert.rejects(
        service.stageLinkBatch({
          scope: linkScope(BigInt(claim.fencing_token)),
          generation: linkGenerationBinding(),
          batchSequence: 1,
          rows: [baseLinkRow(1, "order-1", "order-2", true)],
        }),
        (error: unknown) =>
          error instanceof MaterializationBaseError && error.code === "LINK_ENDPOINT_TYPE_INVALID",
      );

      const dangling = await service.stageLinkBatch({
        scope: linkScope(BigInt(claim.fencing_token)),
        generation: linkGenerationBinding(),
        batchSequence: 1,
        rows: [baseLinkRow(1, "order-1", "missing-order")],
      });
      assert.equal(dangling.stagedRowCount, 0);
      assert.deepEqual(dangling.dangling[0]?.missingEndpoints, ["target"]);

      const linked = capacityMode
        ? await stageLinkUpload(
            service,
            linkScope(BigInt(claim.fencing_token)),
            2,
            capacityMetrics.linkRows,
          )
        : await stageLinkRows(
            service,
            linkScope(BigInt(claim.fencing_token)),
            2,
            capacityMetrics.linkRows,
          );
      const receipts = [dangling, ...linked];
      const promoted = await service.promoteGenerationBase({
        scope: linkScope(BigInt(claim.fencing_token)),
        generationId: ids.linkGeneration,
        expectedRowCount: capacityMetrics.linkRows,
        batchReceipts: receipts,
      });
      assert.equal(promoted.rowCount, capacityMetrics.linkRows);
      return receipts;
    } finally {
      await pool.end();
    }
  })();

  const digestBeforeRestart = await withClient(adminConfig, baseContentDigest);
  const restartedWorkerPool = new pg.Pool(workerConfig);
  try {
    const replay = await baseService(restartedWorkerPool).promoteGenerationBase({
      scope: linkScope(BigInt(claim.fencing_token)),
      generationId: ids.linkGeneration,
      expectedRowCount: capacityMetrics.linkRows,
      batchReceipts,
    });
    assert.equal(replay.reused, true);
  } finally {
    await restartedWorkerPool.end();
  }
  const firstApiPool = new pg.Pool(apiConfig);
  const beforeApiRestart = await firstApiPool.query<{ readonly generation_digest: string }>(
    `SELECT generation_digest FROM runtime.generations
     WHERE project_id = $1 AND generation_id = $2`,
    [ids.project, ids.linkGeneration],
  );
  await firstApiPool.end();
  const restartedApiPool = new pg.Pool(apiConfig);
  const afterApiRestart = await restartedApiPool.query<{ readonly generation_digest: string }>(
    `SELECT generation_digest FROM runtime.generations
     WHERE project_id = $1 AND generation_id = $2`,
    [ids.project, ids.linkGeneration],
  );
  await restartedApiPool.end();
  assert.deepEqual(afterApiRestart.rows, beforeApiRestart.rows);
  assert.equal(await withClient(adminConfig, baseContentDigest), digestBeforeRestart);

  await withClient(adminConfig, async (admin) => {
    const state = await admin.query<{
      readonly links: number;
      readonly source_type: string;
      readonly target_type: string;
      readonly identities: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM runtime.link_base
           WHERE project_id = $1 AND generation_id = $2) AS links,
         min(source_object_type_resource_id::text) AS source_type,
         min(target_object_type_resource_id::text) AS target_type,
         (SELECT count(*)::integer FROM runtime.object_identities
           WHERE project_id = $1) AS identities
       FROM runtime.link_base
       WHERE project_id = $1 AND generation_id = $2`,
      [ids.project, ids.linkGeneration],
    );
    assert.deepEqual(state.rows[0], {
      links: capacityMetrics.linkRows,
      source_type: ids.objectResource,
      target_type: ids.objectResource,
      identities: capacityMetrics.objectRows + capacityMetrics.identityProbeRows,
    });
    await admin.query(
      `UPDATE ops.materialization_attempts
       SET state = 'completed', finished_at = clock_timestamp(), result_code = 'BASE_PROMOTED'
       WHERE project_id = $1 AND attempt_id = $2 AND state = 'leased'`,
      [ids.project, ids.linkAttempt],
    );
    await admin.query(
      `UPDATE ops.materialization_jobs
       SET state = 'succeeded', lease_owner_id = NULL, lease_expires_at = NULL,
           result_code = 'BASE_PROMOTED', updated_at = clock_timestamp()
       WHERE project_id = $1 AND job_id = $2`,
      [ids.project, ids.linkJob],
    );
    await admin.query(
      `UPDATE runtime.generations SET state = 'ready', changed_at = clock_timestamp()
       WHERE project_id = $1 AND generation_id = $2`,
      [ids.project, ids.linkGeneration],
    );
  });
  capacityMetrics.linkBatches = Math.ceil(capacityMetrics.linkRows / 5_000);
  capacityMetrics.linkMilliseconds = elapsedMilliseconds(linkStartedAt);
  samplePeakRss();
  if (capacityMode) await reportBaseCapacity(adminConfig, digestBeforeRestart);
}

async function stageLinkRows(
  service: MaterializationBaseService,
  scope: ReturnType<typeof linkScope>,
  firstBatchSequence: number,
  rowCount: number,
): Promise<readonly BaseBatchReceipt[]> {
  const receipts: BaseBatchReceipt[] = [];
  const batchSize = 5_000;
  for (let offset = 0; offset < rowCount; offset += batchSize) {
    const count = Math.min(batchSize, rowCount - offset);
    const rows = Array.from({ length: count }, (_, localIndex) => {
      const index = offset + localIndex;
      const source = (index % capacityMetrics.objectRows) + 1;
      const relationOffset = Math.floor(index / capacityMetrics.objectRows) + 1;
      const target = ((source - 1 + relationOffset) % capacityMetrics.objectRows) + 1;
      return baseLinkRow(index + 2, `order-${String(source)}`, `order-${String(target)}`);
    });
    receipts.push(
      await service.stageLinkBatch({
        scope,
        generation: linkGenerationBinding(),
        batchSequence: firstBatchSequence + receipts.length,
        rows,
      }),
    );
    samplePeakRss();
  }
  return Object.freeze(receipts);
}

async function stageObjectUpload(
  service: MaterializationBaseService,
  scope: {
    readonly projectId: string;
    readonly jobId: string;
    readonly attemptId: string;
    readonly fencingToken: bigint;
  },
  rowCount: number,
): Promise<readonly BaseBatchReceipt[]> {
  const receipts: BaseBatchReceipt[] = [];
  const batch: MappingAcceptedObjectRow[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    receipts.push(
      await service.stageObjectBatch({
        scope,
        generation: baseGenerationBinding(),
        batchSequence: receipts.length + 1,
        rows: batch.splice(0, batch.length),
      }),
    );
    samplePeakRss();
  };
  const result = await executeManagedCsvMapping({
    plan: capacityObjectMappingPlan(),
    sourceContentDigest: capacityObjectCsvDigest(rowCount),
    source: capacityObjectCsv(rowCount),
    digestCanonicalText: sha256Artifact,
    sink: {
      async write(event) {
        if (event.kind !== "object") throw new Error("capacity object mapping rejected a row");
        batch.push(event);
        if (batch.length === 5_000) await flush();
      },
    },
  });
  await flush();
  assert.equal(result.acceptedRowCount, rowCount);
  assert.equal(result.rejectedRowCount, 0);
  return Object.freeze(receipts);
}

async function stageLinkUpload(
  service: MaterializationBaseService,
  scope: ReturnType<typeof linkScope>,
  firstBatchSequence: number,
  rowCount: number,
): Promise<readonly BaseBatchReceipt[]> {
  const receipts: BaseBatchReceipt[] = [];
  const batch: MappingAcceptedLinkRow[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    receipts.push(
      await service.stageLinkBatch({
        scope,
        generation: linkGenerationBinding(),
        batchSequence: firstBatchSequence + receipts.length,
        rows: batch.splice(0, batch.length),
      }),
    );
    samplePeakRss();
  };
  const result = await executeManagedCsvMapping({
    plan: capacityLinkMappingPlan(),
    sourceContentDigest: capacityLinkCsvDigest(rowCount),
    source: capacityLinkCsv(rowCount),
    digestCanonicalText: sha256Artifact,
    sink: {
      async write(event) {
        if (event.kind !== "link") throw new Error("capacity Link mapping rejected a row");
        batch.push(event);
        if (batch.length === 5_000) await flush();
      },
    },
  });
  await flush();
  assert.equal(result.acceptedRowCount, rowCount);
  assert.equal(result.rejectedRowCount, 0);
  return Object.freeze(receipts);
}

function capacityObjectMappingPlan() {
  const schema = {
    schemaVersion: 1,
    contractVersion: "snapshot-schema-v1",
    format: "csv_utf8",
    headerRow: true,
    columns: [
      { ordinal: 0, columnApiName: "orderId", valueType: "string", required: true },
      { ordinal: 1, columnApiName: "displayName", valueType: "string", required: true },
    ],
  } as const;
  const mapping = {
    schemaVersion: 1,
    mappingVersion: "mapping-v1",
    targetKind: "object",
    inputSchemaRevisionId: ids.schemaRevision,
    targetResourceId: ids.objectResource,
    targetRevisionId: ids.objectRevision,
    valueCodecVersion: "pk1",
    propertyMappings: [
      {
        propertyApiName: "displayName",
        required: true,
        nullPolicy: "reject_row",
        expression: { op: "column", columnApiName: "displayName" },
      },
    ],
    primaryKeyExpression: { op: "column", columnApiName: "orderId" },
    qualityRules: objectMapping.qualityRules,
  } as const;
  return compileMapping(
    {
      mappingRevisionId: ids.mappingRevision,
      mappingRevisionDigest: definitionDigest(mapping),
      mapping,
      inputSchemaRevisionId: ids.schemaRevision,
      inputSchemaDigest: definitionDigest(schema),
      inputSchema: schema,
      target: {
        kind: "object",
        resourceId: ids.objectResource,
        revisionId: ids.objectRevision,
        definitionDigest: definitionDigest(capacityOrderObjectType()),
        definition: capacityOrderObjectType(),
      },
    },
    sha256Artifact,
  );
}

function capacityLinkMappingPlan() {
  const schema = {
    schemaVersion: 1,
    contractVersion: "snapshot-schema-v1",
    format: "csv_utf8",
    headerRow: true,
    columns: [
      { ordinal: 0, columnApiName: "sourceOrderId", valueType: "string", required: true },
      { ordinal: 1, columnApiName: "targetOrderId", valueType: "string", required: true },
    ],
  } as const;
  const definition = {
    schemaVersion: 1,
    apiName: "OrderRelation",
    displayName: "Order Relation",
    description: "Capacity Link fixture.",
    source: {
      objectTypeRevisionId: ids.objectRevision,
      apiName: "sourceOrder",
      displayName: "Source Order",
    },
    target: {
      objectTypeRevisionId: ids.objectRevision,
      apiName: "targetOrder",
      displayName: "Target Order",
    },
    cardinality: "many_to_many",
    sourceKind: "base",
    deletionBehavior: "restrict",
    actionCreateAllowed: false,
    actionDeleteAllowed: false,
  } as const;
  const mapping = {
    schemaVersion: 1,
    mappingVersion: "mapping-v1",
    targetKind: "link",
    inputSchemaRevisionId: ids.schemaRevision,
    targetResourceId: ids.linkResource,
    targetRevisionId: ids.linkRevision,
    valueCodecVersion: "pk1",
    propertyMappings: [],
    sourceKeyMapping: {
      objectTypeRevisionId: ids.objectRevision,
      expression: { op: "column", columnApiName: "sourceOrderId" },
      codecVersion: "pk1",
    },
    targetKeyMapping: {
      objectTypeRevisionId: ids.objectRevision,
      expression: { op: "column", columnApiName: "targetOrderId" },
      codecVersion: "pk1",
    },
    qualityRules: objectMapping.qualityRules,
  } as const;
  return compileMapping(
    {
      mappingRevisionId: ids.mappingRevision,
      mappingRevisionDigest: definitionDigest(mapping),
      mapping,
      inputSchemaRevisionId: ids.schemaRevision,
      inputSchemaDigest: definitionDigest(schema),
      inputSchema: schema,
      target: {
        kind: "link",
        resourceId: ids.linkResource,
        revisionId: ids.linkRevision,
        definitionDigest: definitionDigest(definition),
        definition,
        sourceObject: {
          resourceId: ids.objectResource,
          revisionId: ids.objectRevision,
          definitionDigest: definitionDigest(capacityOrderObjectType()),
          definition: capacityOrderObjectType(),
        },
        targetObject: {
          resourceId: ids.objectResource,
          revisionId: ids.objectRevision,
          definitionDigest: definitionDigest(capacityOrderObjectType()),
          definition: capacityOrderObjectType(),
        },
      },
    },
    sha256Artifact,
  );
}

async function* capacityObjectCsv(rowCount: number): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  yield Buffer.from("orderId,displayName\n");
  let chunk = "";
  for (let index = 1; index <= rowCount; index += 1) {
    chunk += `order-${String(index)},Order ${String(index)}\n`;
    if (chunk.length >= 64 * 1024) {
      yield Buffer.from(chunk);
      chunk = "";
    }
  }
  if (chunk.length > 0) yield Buffer.from(chunk);
}

async function* capacityLinkCsv(rowCount: number): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  yield Buffer.from("sourceOrderId,targetOrderId\n");
  let chunk = "";
  for (let index = 0; index < rowCount; index += 1) {
    const [source, target] = capacityLinkEndpoints(index);
    chunk += `order-${String(source)},order-${String(target)}\n`;
    if (chunk.length >= 64 * 1024) {
      yield Buffer.from(chunk);
      chunk = "";
    }
  }
  if (chunk.length > 0) yield Buffer.from(chunk);
}

function capacityObjectCsvDigest(rowCount: number) {
  const hash = createHash("sha256").update("orderId,displayName\n");
  for (let index = 1; index <= rowCount; index += 1) {
    hash.update(`order-${String(index)},Order ${String(index)}\n`);
  }
  return parseArtifactDigest(`sha256:${hash.digest("hex")}`);
}

function capacityOrderObjectType() {
  return {
    ...orderObjectType,
    titlePropertyApiName: "displayName",
    defaultSearchPropertyApiNames: ["displayName"],
    properties: [
      ...orderObjectType.properties,
      {
        schemaVersion: 1,
        apiName: "displayName",
        displayName: "Display Name",
        description: "Capacity fixture business property.",
        valueType: "string",
        caseSensitive: true,
        nullable: false,
        writeMode: "source_only",
        unique: false,
        filterable: true,
        sortable: true,
        searchable: true,
        classification: "internal",
      },
    ],
  } as const;
}

function capacityLinkCsvDigest(rowCount: number) {
  const hash = createHash("sha256").update("sourceOrderId,targetOrderId\n");
  for (let index = 0; index < rowCount; index += 1) {
    const [source, target] = capacityLinkEndpoints(index);
    hash.update(`order-${String(source)},order-${String(target)}\n`);
  }
  return parseArtifactDigest(`sha256:${hash.digest("hex")}`);
}

function capacityLinkEndpoints(index: number): readonly [number, number] {
  const source = (index % capacityMetrics.objectRows) + 1;
  const relationOffset = Math.floor(index / capacityMetrics.objectRows) + 1;
  const target = ((source - 1 + relationOffset) % capacityMetrics.objectRows) + 1;
  return [source, target];
}

function sha256Artifact(value: string) {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

async function baseContentDigest(client: pg.Client | pg.Pool): Promise<string> {
  const result = await client.query<{ readonly digest: string }>(
    `SELECT 'sha256:' || encode(sha256(convert_to(
       COALESCE((SELECT string_agg('o:' || object_rid::text || ':' || value_digest,
                                  ',' ORDER BY object_rid)
                 FROM runtime.object_base WHERE project_id = $1), '') || '|' ||
       COALESCE((SELECT string_agg('l:' || link_rid::text || ':' || value_digest,
                                  ',' ORDER BY link_rid)
                 FROM runtime.link_base WHERE project_id = $1), ''),
       'UTF8')), 'hex') AS digest`,
    [ids.project],
  );
  return result.rows[0]?.digest ?? "";
}

async function reportBaseCapacity(
  adminConfig: pg.ClientConfig,
  contentDigest: string,
): Promise<void> {
  const storage = await withClient(adminConfig, async (admin) => {
    const result = await admin.query<{
      readonly wal_bytes: string;
      readonly object_heap_bytes: string;
      readonly object_index_bytes: string;
      readonly link_heap_bytes: string;
      readonly link_index_bytes: string;
      readonly identity_heap_bytes: string;
      readonly identity_index_bytes: string;
      readonly staging_total_bytes: string;
    }>(
      `SELECT
         pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::bigint::text AS wal_bytes,
         pg_relation_size('runtime.object_base')::bigint::text AS object_heap_bytes,
         pg_indexes_size('runtime.object_base')::bigint::text AS object_index_bytes,
         pg_relation_size('runtime.link_base')::bigint::text AS link_heap_bytes,
         pg_indexes_size('runtime.link_base')::bigint::text AS link_index_bytes,
         pg_relation_size('runtime.object_identities')::bigint::text AS identity_heap_bytes,
         pg_indexes_size('runtime.object_identities')::bigint::text AS identity_index_bytes,
         (pg_total_relation_size('ops.object_base_staging') +
          pg_total_relation_size('ops.link_base_staging'))::bigint::text AS staging_total_bytes`,
      [capacityMetrics.walStart],
    );
    return result.rows[0];
  });
  assert.ok(storage);
  const totalRows = capacityMetrics.objectRows + capacityMetrics.linkRows;
  const totalMilliseconds = capacityMetrics.objectMilliseconds + capacityMetrics.linkMilliseconds;
  process.stdout.write(
    `CI_MATERIALIZATION_BASE_CAPACITY ${JSON.stringify({
      objectRows: capacityMetrics.objectRows,
      linkRows: capacityMetrics.linkRows,
      objectBatches: capacityMetrics.objectBatches,
      linkBatches: capacityMetrics.linkBatches,
      objectMilliseconds: Math.round(capacityMetrics.objectMilliseconds),
      linkMilliseconds: Math.round(capacityMetrics.linkMilliseconds),
      rowsPerSecond: Math.round((totalRows * 1_000) / totalMilliseconds),
      peakNodeRssBytes: capacityMetrics.peakRssBytes,
      contentDigest,
      workerRestartDigestStable: true,
      apiRestartDigestStable: true,
      ...storage,
    })}\n`,
  );
}

function linkScope(fencingToken: bigint) {
  return Object.freeze({
    projectId: ids.project,
    jobId: ids.linkJob,
    attemptId: ids.linkAttempt,
    fencingToken,
  });
}

function linkGenerationBinding() {
  return Object.freeze({
    generationId: ids.linkGeneration,
    targetResourceId: ids.linkResource,
    targetRevisionId: ids.linkRevision,
    sourceSnapshotId: ids.linkSnapshot,
    sourceFileId: ids.linkSnapshotFile,
    mappingRevisionId: ids.mappingRevision,
  });
}

function baseLinkRow(
  rowNumber: number,
  sourceIdentity: string,
  targetIdentity: string,
  wrongSourceType = false,
) {
  return Object.freeze({
    kind: "link" as const,
    rowNumber,
    targetResourceId: parseOntosId(ids.linkResource),
    targetRevisionId: parseOntosId(ids.linkRevision),
    sourceLookup: Object.freeze({
      objectTypeResourceId: parseOntosId(
        wrongSourceType ? ids.mappingResource : ids.objectResource,
      ),
      objectTypeRevisionId: parseOntosId(
        wrongSourceType ? ids.mappingRevision : ids.objectRevision,
      ),
      canonicalPrimaryKey: canonicalizePrimaryKey([sourceIdentity], {
        components: [{ type: "string" as const, caseSensitive: capacityMode }],
      }),
      sourceColumnApiNames: Object.freeze(["sourceOrderId"]),
    }),
    targetLookup: Object.freeze({
      objectTypeResourceId: parseOntosId(ids.objectResource),
      objectTypeRevisionId: parseOntosId(ids.objectRevision),
      canonicalPrimaryKey: canonicalizePrimaryKey([targetIdentity], {
        components: [{ type: "string" as const, caseSensitive: capacityMode }],
      }),
      sourceColumnApiNames: Object.freeze(["targetOrderId"]),
    }),
  });
}

function baseService(pool: pg.Pool): MaterializationBaseService {
  return new MaterializationBaseService({
    repository: new PostgresMaterializationBaseRepository(pool),
    crypto: {
      randomId: randomUUID,
      digestCanonicalText(value) {
        return parseArtifactDigest(`sha256:${createHash("sha256").update(value).digest("hex")}`);
      },
    },
  });
}

function baseGenerationBinding() {
  return Object.freeze({
    generationId: ids.generation,
    targetResourceId: ids.objectResource,
    targetRevisionId: ids.objectRevision,
    sourceSnapshotId: ids.snapshot,
    sourceFileId: ids.snapshotFile,
    mappingRevisionId: ids.mappingRevision,
  });
}

function baseObjectRow(rowNumber: number, identity: string) {
  return Object.freeze({
    kind: "object" as const,
    rowNumber,
    targetResourceId: parseOntosId(ids.objectResource),
    targetRevisionId: parseOntosId(ids.objectRevision),
    canonicalPrimaryKey: canonicalizePrimaryKey([identity], {
      components: [{ type: "string" as const, caseSensitive: false }],
    }),
    properties: Object.freeze([
      Object.freeze({
        propertyApiName: "orderId",
        valueType: "string" as const,
        value: identity,
        sourceColumnApiNames: Object.freeze(["orderId"]),
      }),
    ]),
  });
}

async function stageObjectRows(
  service: MaterializationBaseService,
  scope: {
    readonly projectId: string;
    readonly jobId: string;
    readonly attemptId: string;
    readonly fencingToken: bigint;
  },
  rows: readonly ReturnType<typeof baseObjectRow>[],
): Promise<readonly BaseBatchReceipt[]> {
  const receipts: BaseBatchReceipt[] = [];
  const batchSize = 5_000;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    receipts.push(
      await service.stageObjectBatch({
        scope,
        generation: baseGenerationBinding(),
        batchSequence: receipts.length + 1,
        rows: rows.slice(offset, offset + batchSize),
      }),
    );
    samplePeakRss();
  }
  return Object.freeze(receipts);
}

function samplePeakRss(): void {
  capacityMetrics.peakRssBytes = Math.max(capacityMetrics.peakRssBytes, process.memoryUsage().rss);
}

function elapsedMilliseconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

async function issueCertificateAndPublishA1(client: pg.Client): Promise<void> {
  const certificate = await client.query<{
    readonly certificate_id: string;
    readonly certificate_digest: string;
  }>(`SELECT * FROM runtime.issue_compatibility_certificate($1, $2, $3, $4, $5, $6, $7)`, [
    ids.certificate,
    ids.project,
    ids.generation,
    ids.release2,
    "exact_pin",
    "materialization-g2-02-v1",
    digests.evidence,
  ]);
  assert.equal(certificate.rows[0]?.certificate_id, ids.certificate);
  const runtimePlan = await client.query<{ readonly plan_digest: string }>(
    `SELECT plan_digest FROM meta.release_runtime_plans WHERE release_id = $1`,
    [ids.release2],
  );
  const runtimePlanDigest = runtimePlan.rows[0]?.plan_digest;
  assert.ok(runtimePlanDigest !== undefined);
  const activationDigest = materializationDigest("RuntimeActivation", {
    schemaVersion: 1,
    contractVersion: "runtime-activation-v1",
    activationId: ids.activation1,
    projectId: ids.project,
    releaseId: ids.release2,
    runtimePlanDigest,
    state: "ready",
    members: [
      {
        memberKey: "object:Order",
        generationId: ids.generation,
        snapshotId: ids.snapshot,
        snapshotGroupId: ids.snapshotGroup,
        groupVersion: 1,
        certificateId: ids.certificate,
      },
    ],
    activationDigest: digestOf("0"),
    createdAt: "2026-08-15T00:00:00.000000Z",
  });

  await client.query("BEGIN");
  await client.query(
    `INSERT INTO meta.runtime_activations
       (activation_id, release_id, activation_digest, member_count)
     VALUES ($1, $2, $3, 1)`,
    [ids.activation1, ids.release2, activationDigest],
  );
  await client.query(
    `INSERT INTO meta.runtime_activation_members (
       project_id, release_id, activation_id, member_key, generation_id,
       snapshot_id, snapshot_group_id, group_version, certificate_id
     ) VALUES ($1, $2, $3, 'object:Order', $4, $5, $6, 1, $7)`,
    [
      ids.project,
      ids.release2,
      ids.activation1,
      ids.generation,
      ids.snapshot,
      ids.snapshotGroup,
      ids.certificate,
    ],
  );
  await client.query(
    `INSERT INTO meta.release_serving_heads
       (release_id, activation_id, control_sequence) VALUES ($1, $2, 1)`,
    [ids.release2, ids.activation1],
  );
  await client.query(
    `UPDATE meta.releases
     SET state = 'published', published_by_principal_id = $2,
         published_at = clock_timestamp(), changed_at = clock_timestamp()
     WHERE release_id = $1`,
    [ids.release2, ids.principal],
  );
  await client.query(
    `UPDATE meta.releases SET state = 'superseded', changed_at = clock_timestamp()
     WHERE release_id = $1`,
    [ids.release1],
  );
  await client.query(
    `UPDATE meta.release_channels
     SET release_id = $2, activation_id = $3,
         control_sequence = control_sequence + 1, changed_at = clock_timestamp()
     WHERE project_id = $1 AND channel_name = 'production'`,
    [ids.project, ids.release2, ids.activation1],
  );
  await client.query("COMMIT");
}

async function assertA1AndCrossProjectGuards(client: pg.Client): Promise<void> {
  const a1 = await client.query<{
    readonly member_count: number;
    readonly actual_members: number;
    readonly generation_state: string;
  }>(
    `SELECT activation.member_count,
            count(member.*)::integer AS actual_members,
            min(generation.state) AS generation_state
     FROM meta.runtime_activations AS activation
     JOIN meta.runtime_activation_members AS member
       ON member.release_id = activation.release_id
      AND member.activation_id = activation.activation_id
     JOIN runtime.generations AS generation
       ON generation.project_id = member.project_id
      AND generation.generation_id = member.generation_id
     WHERE activation.activation_id = $1
     GROUP BY activation.member_count`,
    [ids.activation1],
  );
  assert.deepEqual(a1.rows[0], {
    member_count: 1,
    actual_members: 1,
    generation_state: "ready",
  });

  await assertFailedTransaction(client, "23514", async () => {
    await client.query(
      `INSERT INTO meta.runtime_activations
         (activation_id, release_id, activation_digest, member_count)
       VALUES ($1, $2, $3, 1)`,
      [ids.activationBadDigest, ids.release2, digestOf("f")],
    );
    await insertActivationMember(client, ids.activationBadDigest, ids.project);
  });
  await assertFailedTransaction(client, "23514", async () => {
    await client.query(
      `INSERT INTO meta.runtime_activations
         (activation_id, release_id, activation_digest, member_count)
       VALUES ($1, $2, $3, 2)`,
      [ids.activationBadCount, ids.release2, digestOf("e")],
    );
    await insertActivationMember(client, ids.activationBadCount, ids.project);
  });
  await assertFailedTransaction(client, "23503", async () => {
    await client.query(
      `INSERT INTO meta.runtime_activations
         (activation_id, release_id, activation_digest, member_count)
       VALUES ($1, $2, $3, 1)`,
      [ids.activationCrossProject, ids.release2, digestOf("d")],
    );
    await insertActivationMember(client, ids.activationCrossProject, ids.otherProject);
  });
  await assertPgCode(
    client.query(
      `INSERT INTO runtime.object_identities
         (project_id, object_type_resource_id, object_rid, canonical_primary_key)
       VALUES ($1, $2, $3, 'pk1|1|s5#wrong')`,
      [ids.project, ids.mappingResource, randomUUID()],
    ),
    "23514",
  );
  await assertPgCode(
    client.query(
      `INSERT INTO runtime.generations (
         project_id, generation_id, member_key, member_kind,
         target_resource_id, target_revision_id, snapshot_id, snapshot_group_id, group_version,
         snapshot_schema_resource_id, snapshot_schema_revision_id,
         mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest,
         report_id, report_digest, generation_digest
       ) SELECT $1, $2, member_key, member_kind, target_resource_id, target_revision_id,
                snapshot_id, snapshot_group_id, group_version,
                snapshot_schema_resource_id, snapshot_schema_revision_id,
                mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest,
                report_id, report_digest, $3
         FROM runtime.generations WHERE project_id = $4 AND generation_id = $5`,
      [ids.otherProject, randomUUID(), digestOf("5"), ids.project, ids.generation],
    ),
    "23503",
  );
  await assertPgCode(
    client.query(
      `INSERT INTO runtime.object_base (
         project_id, generation_id, object_type_resource_id, object_type_revision_id,
         object_rid, canonical_primary_key, properties, source_snapshot_id,
         source_file_id, source_row_number, mapping_revision_id, value_digest
       ) VALUES ($1, $2, $3, $4, $5, 'pk1|1|s5#order', '{}'::jsonb,
                 $6, $7, 1, $8, $9)`,
      [
        ids.project,
        ids.generation,
        ids.objectResource,
        ids.objectRevision,
        randomUUID(),
        ids.snapshot,
        ids.snapshotFile,
        ids.mappingRevision,
        digestOf("4"),
      ],
    ),
    "23514",
  );

  const constraints = await client.query<{ readonly definition: string }>(`
    SELECT pg_catalog.pg_get_constraintdef(oid) AS definition
    FROM pg_catalog.pg_constraint
    WHERE conname IN (
      'object_current_pkey', 'object_current_canonical_pk_uq',
      'link_current_pkey', 'link_current_endpoints_uq',
      'object_current_generation_fk', 'link_current_generation_fk'
    )
    ORDER BY conname`);
  assert.equal(constraints.rows.length, 6);
  const definitions = constraints.rows.map(({ definition }) => definition).join("\n");
  for (const required of [
    "project_id, generation_id, object_type_resource_id, object_rid",
    "canonical_primary_key",
    "project_id, generation_id, link_type_resource_id, link_rid",
    "source_object_rid, target_object_rid",
    "object_type_revision_id",
    "link_type_revision_id",
  ]) {
    assert.match(definitions, new RegExp(required.replaceAll(" ", "\\s+"), "u"));
  }
  const perTypeTables = await client.query<{ readonly count: number }>(`
    SELECT count(*)::integer AS count FROM pg_catalog.pg_tables
    WHERE schemaname = 'runtime'
      AND (tablename LIKE '%order%' OR tablename LIKE '%release%')`);
  assert.equal(perTypeTables.rows[0]?.count, 0);
}

async function insertActivationMember(
  client: pg.Client,
  activationId: string,
  projectId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO meta.runtime_activation_members (
       project_id, release_id, activation_id, member_key, generation_id,
       snapshot_id, snapshot_group_id, group_version, certificate_id
     ) VALUES ($1, $2, $3, 'object:Order', $4, $5, $6, 1, $7)`,
    [
      projectId,
      ids.release2,
      activationId,
      ids.generation,
      ids.snapshot,
      ids.snapshotGroup,
      ids.certificate,
    ],
  );
}

async function assertImmutableAndControlledBoundaries(client: pg.Client): Promise<void> {
  for (const statement of [
    "UPDATE meta.release_runtime_plans SET created_at = created_at WHERE false",
    "UPDATE meta.runtime_activation_members SET created_at = created_at WHERE false",
    "UPDATE runtime.snapshot_files SET row_count = row_count WHERE false",
    "UPDATE runtime.object_identities SET codec_version = codec_version WHERE false",
    "UPDATE runtime.object_base SET properties = properties WHERE false",
    "UPDATE runtime.materialization_reports SET outcome = outcome WHERE false",
    "UPDATE runtime.index_plans SET compiler_version = compiler_version WHERE false",
    "UPDATE runtime.compatibility_certificates SET decision = decision WHERE false",
    "UPDATE ops.materialization_checkpoints SET output_digest = output_digest WHERE false",
  ]) {
    await assertPgCode(client.query(statement), "55000");
  }
  await assertPgCode(
    client.query(
      `UPDATE runtime.dataset_snapshots SET state = 'registered', changed_at = clock_timestamp()
       WHERE project_id = $1 AND snapshot_id = $2`,
      [ids.project, ids.snapshot],
    ),
    "55000",
  );
  await assertPgCode(
    client.query(
      `UPDATE runtime.generations SET state = 'building', changed_at = clock_timestamp()
       WHERE project_id = $1 AND generation_id = $2`,
      [ids.project, ids.generation],
    ),
    "55000",
  );
}

async function exerciseRealWorkerFencing(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
  worker1Config: pg.ClientConfig,
  worker2Config: pg.ClientConfig,
): Promise<void> {
  await withClient(apiConfig, async (api) => {
    await api.query(
      `INSERT INTO ops.materialization_jobs
         (project_id, job_id, snapshot_group_id, group_version, idempotency_key, input_digest)
       VALUES ($1, $2, $3, 1, 'db02-worker-smoke-0001', $4)`,
      [ids.project, ids.leaseJob, ids.snapshotGroup, digestOf("1")],
    );
  });

  let firstToken = 0n;
  await withClient(worker1Config, async (worker1) => {
    const claim = await worker1.query<{ readonly fencing_token: string }>(
      `SELECT * FROM ops.claim_materialization_job($1, $2, 1)`,
      [ids.worker1, ids.attempt1],
    );
    firstToken = BigInt(claim.rows[0]?.fencing_token ?? "0");
    assert.equal(firstToken, 1n);
    await worker1.query(
      `SELECT ops.write_materialization_staged_batch($1, $2, $3, $4, 1, $5, 10)`,
      [ids.project, ids.leaseJob, ids.attempt1, firstToken.toString(), digests.batch1],
    );
  });

  await withClient(adminConfig, async (admin) => {
    const beforeCheckpoint = await admin.query<{ readonly complete: number }>(
      `SELECT count(*)::integer AS complete FROM ops.materialization_staged_batches
       WHERE project_id = $1 AND job_id = $2 AND checkpoint_id IS NOT NULL`,
      [ids.project, ids.leaseJob],
    );
    assert.equal(beforeCheckpoint.rows[0]?.complete, 0);
    await admin.query("SELECT pg_sleep(1.2)");
  });

  await withClient(worker2Config, async (worker2) => {
    const claim = await worker2.query<{ readonly fencing_token: string }>(
      `SELECT * FROM ops.claim_materialization_job($1, $2, 30)`,
      [ids.worker2, ids.attempt2],
    );
    assert.equal(BigInt(claim.rows[0]?.fencing_token ?? "0"), 2n);
    await worker2.query(`SELECT ops.write_materialization_staged_batch($1, $2, $3, 2, 1, $4, 10)`, [
      ids.project,
      ids.leaseJob,
      ids.attempt2,
      digests.batch2,
    ]);
    await worker2.query(
      `SELECT ops.checkpoint_materialization_job(
         $1, $2, $3, 2, $4, 1, 'build_stage', $5, 1
       )`,
      [ids.project, ids.leaseJob, ids.attempt2, ids.checkpoint, digests.checkpoint],
    );
  });

  await withClient(worker1Config, async (staleWorker) => {
    await assertPgCode(
      staleWorker.query(`SELECT ops.write_materialization_staged_batch($1, $2, $3, $4, 2, $5, 1)`, [
        ids.project,
        ids.leaseJob,
        ids.attempt1,
        firstToken.toString(),
        digestOf("2"),
      ]),
      "55000",
    );
  });

  await withClient(worker2Config, async (restartedWorker) => {
    const rows = await restartedWorker.query<{
      readonly complete: number;
      readonly incomplete: number;
    }>(
      `SELECT
         count(*) FILTER (WHERE checkpoint_id IS NOT NULL)::integer AS complete,
         count(*) FILTER (WHERE checkpoint_id IS NULL)::integer AS incomplete
       FROM ops.materialization_staged_batches
       WHERE project_id = $1 AND job_id = $2`,
      [ids.project, ids.leaseJob],
    );
    assert.deepEqual(rows.rows[0], { complete: 1, incomplete: 1 });
  });
}

async function assertRuntimePrivilegeMatrix(
  apiConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
  opsConfig: pg.ClientConfig,
): Promise<void> {
  await withClient(apiConfig, async (api) => {
    await api.query("SELECT count(*) FROM meta.release_runtime_plans");
    await assertPgCode(api.query("DELETE FROM meta.release_runtime_plans"), "42501");
    for (const statement of [
      "SELECT count(*) FROM runtime.object_base",
      "SELECT count(*) FROM runtime.link_base",
      "SELECT count(*) FROM ops.object_base_staging",
      "SELECT count(*) FROM ops.link_base_staging",
      "UPDATE runtime.object_base SET properties = properties WHERE false",
      "DELETE FROM runtime.object_base WHERE false",
      "UPDATE runtime.link_base SET value_digest = value_digest WHERE false",
      "DELETE FROM runtime.link_base WHERE false",
    ]) {
      await assertPgCode(api.query(statement), "42501");
    }
    await assertPgCode(
      api.query("SELECT * FROM runtime.lookup_object_identities($1, '[]'::jsonb)", [ids.project]),
      "42501",
    );
    await assertPgCode(
      api.query(
        `INSERT INTO runtime.compatibility_certificates
           (project_id, certificate_id, generation_id) VALUES ($1, $2, $3)`,
        [ids.project, randomUUID(), ids.generation],
      ),
      "42501",
    );
    await assertCommonEscalationsDenied(api);
  });
  await withClient(workerConfig, async (worker) => {
    await worker.query("SELECT count(*) FROM runtime.generations");
    await worker.query("SELECT count(*) FROM ops.materialization_generation_stages");
    await worker.query("SELECT count(*) FROM ops.materialization_generation_stage_batches");
    await worker.query("SELECT count(*) FROM ops.object_base_staging");
    await worker.query("SELECT count(*) FROM ops.link_base_staging");
    await assertPgCode(
      worker.query(
        `INSERT INTO ops.materialization_staged_batches
           (project_id, job_id, attempt_id, fencing_token,
            batch_sequence, batch_digest, row_count)
         VALUES ($1, $2, $3, 1, 99, $4, 1)`,
        [ids.project, ids.leaseJob, ids.attempt1, digestOf("3")],
      ),
      "42501",
    );
    await assertPgCode(
      worker.query(
        `INSERT INTO ops.materialization_checkpoints (
           project_id, checkpoint_id, job_id, attempt_id, fencing_token,
           sequence, stage, completed_batch_sequence, output_digest
         ) VALUES ($1, $2, $3, $4, 1, 99, 'build_stage', 1, $5)`,
        [ids.project, randomUUID(), ids.leaseJob, ids.attempt1, digestOf("6")],
      ),
      "42501",
    );
    for (const statement of [
      "UPDATE ops.object_base_staging SET properties = properties WHERE false",
      "DELETE FROM ops.object_base_staging WHERE false",
      "UPDATE ops.link_base_staging SET value_digest = value_digest WHERE false",
      "DELETE FROM ops.link_base_staging WHERE false",
      "UPDATE runtime.object_base SET properties = properties WHERE false",
      "DELETE FROM runtime.object_base WHERE false",
      "UPDATE runtime.link_base SET value_digest = value_digest WHERE false",
      "DELETE FROM runtime.link_base WHERE false",
    ]) {
      await assertPgCode(worker.query(statement), "42501");
    }
    await assertPgCode(worker.query("DELETE FROM runtime.generations"), "42501");
    await assertPgCode(worker.query("SELECT * FROM runtime.snapshot_upload_sessions"), "42501");
    await assertCommonEscalationsDenied(worker);
  });
  await withClient(opsConfig, async (ops) => {
    await ops.query("SELECT count(*) FROM ops.materialization_job_status");
    await ops.query("SELECT count(*) FROM ops.runtime_inventory_status");
    await ops.query("SELECT count(*) FROM ops.snapshot_ingress_status");
    await assertPgCode(ops.query("SELECT * FROM ops.materialization_jobs"), "42501");
    await assertPgCode(ops.query("SELECT * FROM runtime.generations"), "42501");
    for (const statement of [
      "SELECT count(*) FROM runtime.object_base",
      "SELECT count(*) FROM runtime.link_base",
      "SELECT count(*) FROM ops.object_base_staging",
      "SELECT count(*) FROM ops.link_base_staging",
    ]) {
      await assertPgCode(ops.query(statement), "42501");
    }
    await assertPgCode(
      ops.query("SELECT * FROM ops.promote_materialization_base($1, $2, $3, 1, $4, 0, $5)", [
        ids.project,
        ids.linkJob,
        ids.linkAttempt,
        ids.linkGeneration,
        digestOf("1"),
      ]),
      "42501",
    );
    await assertCommonEscalationsDenied(ops);
  });
}

async function exerciseManagedCsvIngressDatabase(
  apiConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
  opsConfig: pg.ClientConfig,
): Promise<void> {
  const contentDigest = digestOf("6");
  const snapshotDigest = digestOf("5");
  const groupDigest = digestOf("4");
  const tokenDigest = digestOf("7");
  const sourceLabel = "Orders 2026-08-15";
  const objectVersion = "managed-version-2";

  await withClient(apiConfig, async (api) => {
    await api.query(
      `INSERT INTO runtime.snapshot_upload_sessions (
         project_id, session_id, created_by_principal_id, release_id,
         snapshot_group_id, group_version, group_member_count,
         member_key, member_kind, target_resource_id, target_revision_id,
         snapshot_schema_resource_id, snapshot_schema_revision_id,
         mapping_resource_id, mapping_revision_id, index_plan_digest,
         runtime_plan_digest, managed_artifact_id, object_key,
         allowed_media_type, expected_byte_count, max_byte_count,
         source_label, finalize_token_digest, expires_at, cleanup_after
       )
       SELECT member.project_id, $1, $2, member.release_id,
              member.snapshot_group_id, 2,
              (SELECT count(*)::integer
                 FROM meta.release_runtime_plan_members AS grouped
                WHERE grouped.project_id = member.project_id
                  AND grouped.release_id = member.release_id
                  AND grouped.snapshot_group_id = member.snapshot_group_id),
              member.member_key, member.member_kind,
              member.target_resource_id, member.target_revision_id,
              member.snapshot_schema_resource_id, member.snapshot_schema_revision_id,
              member.mapping_resource_id, member.mapping_revision_id,
              member.index_plan_digest, member.runtime_plan_digest,
              $3, $4, 'text/csv', 12, 536870912, $5, $6,
              statement_timestamp() + interval '14 minutes',
              statement_timestamp() + interval '23 hours'
         FROM meta.release_runtime_plan_members AS member
        WHERE member.project_id = $7 AND member.release_id = $8
          AND member.member_key = 'object:Order'`,
      [
        ids.ingressSession,
        ids.principal,
        ids.ingressArtifact,
        `ingress/10/${ids.ingressArtifact}.csv`,
        sourceLabel,
        tokenDigest,
        ids.project,
        ids.release2,
      ],
    );

    await assertPgCode(
      api.query(
        `UPDATE runtime.snapshot_upload_sessions
            SET object_key = 'ingress/ff/10000000-0000-4000-8000-000000009999.csv'
          WHERE project_id = $1 AND session_id = $2`,
        [ids.project, ids.ingressSession],
      ),
      "42501",
    );

    await api.query(
      `UPDATE runtime.snapshot_upload_sessions
          SET state = 'uploaded', uploaded_object_version = $3,
              uploaded_byte_count = 12, changed_at = clock_timestamp()
        WHERE project_id = $1 AND session_id = $2`,
      [ids.project, ids.ingressSession, objectVersion],
    );
    await api.query(
      `UPDATE runtime.snapshot_upload_sessions
          SET state = 'finalizing', finalize_claim_id = $3,
              finalize_lease_expires_at = clock_timestamp() + interval '4 minutes 59 seconds',
              changed_at = clock_timestamp()
        WHERE project_id = $1 AND session_id = $2`,
      [ids.project, ids.ingressSession, ids.ingressClaim],
    );

    await api.query("BEGIN");
    try {
      const plan = await api.query<{ readonly plan_digest: string }>(
        `SELECT plan_digest FROM meta.release_runtime_plans WHERE release_id = $1`,
        [ids.release2],
      );
      const runtimePlanDigest = plan.rows[0]?.plan_digest;
      assert.ok(runtimePlanDigest);
      await api.query(
        `INSERT INTO runtime.snapshot_group_versions
           (project_id, snapshot_group_id, group_version, member_count, group_digest)
         VALUES ($1, $2, 2, 1, $3)`,
        [ids.project, ids.snapshotGroup, groupDigest],
      );
      await api.query(
        `INSERT INTO runtime.dataset_snapshots (
           project_id, snapshot_id, snapshot_group_id, group_version,
           member_key, member_kind, target_resource_id, target_revision_id,
           snapshot_schema_resource_id, snapshot_schema_revision_id,
           mapping_resource_id, mapping_revision_id, runtime_plan_digest,
           content_digest, byte_count, row_count, file_count, snapshot_digest
         ) VALUES (
           $1, $2, $3, 2, 'object:Order', 'object', $4, $5, $6, $7, $8, $9,
           $10, $11, 12, 1, 1, $12
         )`,
        [
          ids.project,
          ids.ingressSnapshot,
          ids.snapshotGroup,
          ids.objectResource,
          ids.objectRevision,
          ids.schemaResource,
          ids.schemaRevision,
          ids.mappingResource,
          ids.mappingRevision,
          runtimePlanDigest,
          contentDigest,
          snapshotDigest,
        ],
      );
      await api.query(
        `INSERT INTO runtime.snapshot_files (
           project_id, snapshot_id, file_id, managed_artifact_id, object_version,
           ordinal, content_digest, byte_count, row_count, source_label, scan_status
         ) VALUES ($1, $2, $3, $4, $5, 0, $6, 12, 1, $7, 'complete')`,
        [
          ids.project,
          ids.ingressSnapshot,
          ids.ingressFile,
          ids.ingressArtifact,
          objectVersion,
          contentDigest,
          sourceLabel,
        ],
      );
      await api.query(
        `INSERT INTO runtime.snapshot_group_members (
           project_id, snapshot_group_id, group_version, member_key, member_kind,
           snapshot_id, target_resource_id, target_revision_id
         ) VALUES ($1, $2, 2, 'object:Order', 'object', $3, $4, $5)`,
        [
          ids.project,
          ids.snapshotGroup,
          ids.ingressSnapshot,
          ids.objectResource,
          ids.objectRevision,
        ],
      );
      await api.query(
        `UPDATE runtime.snapshot_upload_sessions
            SET state = 'finalized', finalize_claim_id = NULL,
                finalize_lease_expires_at = NULL, snapshot_id = $3,
                changed_at = clock_timestamp()
          WHERE project_id = $1 AND session_id = $2`,
        [ids.project, ids.ingressSession, ids.ingressSnapshot],
      );
      await api.query("COMMIT");
    } catch (error) {
      await api.query("ROLLBACK");
      throw error;
    }

    const finalized = await api.query<{
      readonly state: string;
      readonly snapshot_id: string | null;
      readonly source_label: string;
      readonly scan_status: string;
    }>(
      `SELECT session.state, session.snapshot_id, file.source_label, file.scan_status
         FROM runtime.snapshot_upload_sessions AS session
         JOIN runtime.snapshot_files AS file
           ON file.project_id = session.project_id AND file.snapshot_id = session.snapshot_id
        WHERE session.project_id = $1 AND session.session_id = $2`,
      [ids.project, ids.ingressSession],
    );
    assert.deepEqual(finalized.rows[0], {
      state: "finalized",
      snapshot_id: ids.ingressSnapshot,
      source_label: sourceLabel,
      scan_status: "complete",
    });

    await api.query(
      `UPDATE runtime.snapshot_upload_sessions
          SET object_cleanup_completed_at = clock_timestamp(), changed_at = clock_timestamp()
        WHERE project_id = $1 AND session_id = $2`,
      [ids.project, ids.ingressSession],
    );

    await assertPgCode(
      api.query(
        `UPDATE runtime.snapshot_upload_sessions
            SET state = 'cleaned', snapshot_id = NULL,
                failure_code = 'UPLOAD_ABORTED', changed_at = clock_timestamp()
          WHERE project_id = $1 AND session_id = $2`,
        [ids.project, ids.ingressSession],
      ),
      "55000",
    );
    await assertPgCode(
      api.query(
        `DELETE FROM runtime.snapshot_upload_sessions
          WHERE project_id = $1 AND session_id = $2`,
        [ids.project, ids.ingressSession],
      ),
      "42501",
    );

    await api.query(
      `INSERT INTO runtime.snapshot_upload_sessions (
         project_id, session_id, created_by_principal_id, release_id,
         snapshot_group_id, group_version, group_member_count,
         member_key, member_kind, target_resource_id, target_revision_id,
         snapshot_schema_resource_id, snapshot_schema_revision_id,
         mapping_resource_id, mapping_revision_id, index_plan_digest,
         runtime_plan_digest, managed_artifact_id, object_key,
         allowed_media_type, expected_byte_count, max_byte_count,
         source_label, finalize_token_digest, expires_at, cleanup_after
       )
       SELECT member.project_id, $1, $2, member.release_id,
              member.snapshot_group_id, 3, 1,
              member.member_key, member.member_kind,
              member.target_resource_id, member.target_revision_id,
              member.snapshot_schema_resource_id, member.snapshot_schema_revision_id,
              member.mapping_resource_id, member.mapping_revision_id,
              member.index_plan_digest, member.runtime_plan_digest,
              $3, $4, 'text/csv', 12, 536870912, 'Expired fixture', $5,
              statement_timestamp() + interval '14 minutes',
              statement_timestamp() + interval '23 hours'
         FROM meta.release_runtime_plan_members AS member
        WHERE member.project_id = $6 AND member.release_id = $7
          AND member.member_key = 'object:Order'`,
      [
        ids.ingressExpiredSession,
        ids.principal,
        ids.ingressExpiredArtifact,
        `ingress/10/${ids.ingressExpiredArtifact}.csv`,
        digestOf("8"),
        ids.project,
        ids.release2,
      ],
    );
    await api.query(
      `UPDATE runtime.snapshot_upload_sessions
          SET state = 'expired', failure_code = 'SESSION_EXPIRED',
              changed_at = clock_timestamp()
        WHERE project_id = $1 AND session_id = $2`,
      [ids.project, ids.ingressExpiredSession],
    );
    await api.query(
      `UPDATE runtime.snapshot_upload_sessions
          SET state = 'cleaned', object_cleanup_completed_at = clock_timestamp(),
              changed_at = clock_timestamp()
        WHERE project_id = $1 AND session_id = $2`,
      [ids.project, ids.ingressExpiredSession],
    );
  });

  await withClient(workerConfig, async (worker) => {
    await assertPgCode(worker.query("SELECT * FROM runtime.snapshot_upload_sessions"), "42501");
  });
  await withClient(opsConfig, async (ops) => {
    const statuses = await ops.query<{ readonly state: string; readonly count: number }>(
      `SELECT state, count(*)::integer AS count
         FROM ops.snapshot_ingress_status
        GROUP BY state ORDER BY state`,
    );
    assert.deepEqual(statuses.rows, [
      { state: "cleaned", count: 1 },
      { state: "finalized", count: 1 },
    ]);
    const hidden = await ops.query<{ readonly column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'ops' AND table_name = 'snapshot_ingress_status'
          AND column_name IN ('object_key', 'finalize_token_digest', 'source_label')`,
    );
    assert.deepEqual(hidden.rows, []);
  });
}

async function assertCommonEscalationsDenied(client: pg.Client): Promise<void> {
  await assertPgCode(client.query("CREATE TABLE ops.g20203_denied(id integer)"), "42501");
  await assertPgCode(client.query("SET ROLE migration_owner"), "42501");
  await assertPgCode(client.query("SELECT * FROM ontos_migration.schema_migrations"), "42501");
}

async function assertFreshConcurrentMigration(adminConfig: pg.ClientConfig): Promise<void> {
  await withClient(adminConfig, async (admin) => {
    await admin.query("CREATE DATABASE ontos_db02_fresh");
  });
  const freshConfig = { ...adminConfig, database: "ontos_db02_fresh" };
  const [left, right] = await Promise.all([
    withClient(freshConfig, runMigrationsWithCause),
    withClient(freshConfig, runMigrationsWithCause),
  ]);
  assert.equal(left.applied.length + right.applied.length, 11);
  assert.equal(Number(left.noOp) + Number(right.noOp), 1);
  await withClient(freshConfig, async (client) => {
    assert.equal((await runDatabaseMigrations(client)).noOp, true);
    assert.equal((await migrationLedger(client, 11)).length, 11);
  });
}

async function assertEveryDb02MigrationRollsBack(adminConfig: pg.ClientConfig): Promise<void> {
  const probes = new Map<number, string>([
    [7, "runtime.snapshot_groups"],
    [8, "runtime.object_identities"],
    [9, "ops.materialization_jobs"],
    [10, "runtime.snapshot_upload_sessions"],
    [11, "ops.materialization_generation_stages"],
  ]);
  for (const [version, probe] of probes) {
    const databaseName = `ontos_db02_fault_${String(version)}`;
    await withClient(adminConfig, async (admin) => {
      await admin.query(`CREATE DATABASE ${databaseName}`);
    });
    const config = { ...adminConfig, database: databaseName };
    const prefix = await migrationPrefixDirectory(version - 1);
    const fault = await faultingMigrationDirectory(version);
    try {
      await withClient(config, async (client) => {
        await runDatabaseMigrations(client, { directory: prefix });
        await assert.rejects(
          runDatabaseMigrations(client, { directory: fault }),
          (error: unknown) =>
            isDatabaseMigrationError(error) && error.code === "DB_MIGRATION_EXECUTION_FAILED",
        );
        const state = await client.query<{
          readonly ledger_count: number;
          readonly probe_exists: boolean;
        }>(
          `SELECT
             (SELECT count(*)::integer FROM ontos_migration.schema_migrations) AS ledger_count,
             pg_catalog.to_regclass($1) IS NOT NULL AS probe_exists`,
          [probe],
        );
        assert.deepEqual(state.rows[0], {
          ledger_count: version - 1,
          probe_exists: false,
        });
      });
    } finally {
      await rm(prefix, { recursive: true, force: true });
      await rm(fault, { recursive: true, force: true });
    }
  }
}

async function assertDb02Catalog(client: pg.Client): Promise<void> {
  const required = [
    "meta.release_runtime_plan_members",
    "meta.release_runtime_plans",
    "meta.runtime_activation_members",
    "ops.gc_plans",
    "ops.gc_runs",
    "ops.materialization_attempts",
    "ops.materialization_checkpoints",
    "ops.materialization_jobs",
    "ops.materialization_staged_batches",
    "ops.materialization_generation_stages",
    "ops.materialization_generation_stage_batches",
    "ops.object_base_staging",
    "ops.link_base_staging",
    "runtime.compatibility_certificates",
    "runtime.dataset_snapshots",
    "runtime.generations",
    "runtime.link_base",
    "runtime.link_current",
    "runtime.object_base",
    "runtime.object_current",
    "runtime.object_identities",
    "runtime.snapshot_files",
    "runtime.snapshot_group_versions",
    "runtime.snapshot_groups",
  ];
  const result = await client.query<{ readonly relation: string; readonly owner: string }>(
    `
    SELECT schemaname || '.' || tablename AS relation, tableowner AS owner
    FROM pg_catalog.pg_tables
    WHERE schemaname IN ('meta', 'runtime', 'ops')
      AND schemaname || '.' || tablename = ANY($1::text[])
    ORDER BY relation`,
    [required],
  );
  assert.deepEqual(
    result.rows.map(({ relation }) => relation),
    [...required].sort(),
  );
  assert.ok(result.rows.every(({ owner }) => owner === "migration_owner"));
}

async function activationSnapshot(client: pg.Client, activationId: string) {
  const row = await client.query<{
    readonly record: unknown;
    readonly row_bytes: number;
    readonly columns: string[];
  }>(
    `SELECT to_jsonb(activation) AS record,
            pg_column_size(activation)::integer AS row_bytes,
            ARRAY(
              SELECT column_name::text
              FROM information_schema.columns
              WHERE table_schema = 'meta' AND table_name = 'runtime_activations'
              ORDER BY ordinal_position
            ) AS columns
     FROM meta.runtime_activations AS activation
     WHERE activation_id = $1`,
    [activationId],
  );
  assert.equal(row.rows.length, 1);
  return row.rows[0];
}

async function migrationLedger(client: pg.Client, through: number): Promise<readonly LedgerRow[]> {
  const result = await client.query<LedgerRow>(
    `SELECT version::text, name, sha256
     FROM ontos_migration.schema_migrations WHERE version <= $1 ORDER BY version`,
    [through],
  );
  return result.rows;
}

async function createRuntimeLogins(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE ROLE g20203_api_login LOGIN PASSWORD '${runtimePassword}';
    CREATE ROLE g20203_worker1_login LOGIN PASSWORD '${runtimePassword}';
    CREATE ROLE g20203_worker2_login LOGIN PASSWORD '${runtimePassword}';
    CREATE ROLE g20203_ops_login LOGIN PASSWORD '${runtimePassword}';
    GRANT api_runtime TO g20203_api_login;
    GRANT worker_runtime TO g20203_worker1_login, g20203_worker2_login;
    GRANT read_only_ops TO g20203_ops_login;`);
}

async function assertFailedTransaction(
  client: pg.Client,
  code: string,
  action: () => Promise<void>,
): Promise<void> {
  await client.query("BEGIN");
  let rejected = false;
  try {
    try {
      await action();
      await client.query("COMMIT");
    } catch (error) {
      assert.equal(isPostgreSqlError(error) ? error.code : undefined, code);
      rejected = true;
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
  assert.equal(rejected, true, `transaction must fail with PostgreSQL ${code}`);
}

async function assertPgCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => isPostgreSqlError(error) && error.code === code,
  );
}

function materializationDigest(
  name: "RuntimeMemberPlan" | "RuntimeActivation",
  value: unknown,
): string {
  const canonical = canonicalizeMaterializationContractForDigest(name, value);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function digestOf(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function sha256Digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function migrationPrefixDirectory(through: number): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), `ontos-migrations-${String(through)}-`));
  const files = (await readdir(databaseMigrationDirectory)).sort();
  for (const file of files) {
    const version = Number(file.slice(0, 4));
    if (Number.isInteger(version) && version <= through && file.endsWith(".sql")) {
      await copyFile(resolve(databaseMigrationDirectory, file), resolve(directory, file));
    }
  }
  return directory;
}

async function faultingMigrationDirectory(version: number): Promise<string> {
  const directory = await migrationPrefixDirectory(11);
  const prefix = String(version).padStart(4, "0");
  const file = (await readdir(directory)).find((candidate) => candidate.startsWith(`${prefix}_`));
  if (file === undefined) throw new Error(`Missing migration ${prefix}`);
  const path = resolve(directory, file);
  const contents = await readFile(path, "utf8");
  await writeFile(path, `${contents}\nSELECT 1 / 0;\n`);
  return directory;
}

async function runMigrationsWithCause(client: pg.Client) {
  try {
    return await runDatabaseMigrations(client);
  } catch (error) {
    if (isDatabaseMigrationError(error) && error.cause instanceof Error) throw error.cause;
    throw error;
  }
}

async function withClient<T>(
  config: pg.ClientConfig,
  action: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client(config);
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}

async function waitForPostgreSql(config: pg.ClientConfig): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await withClient(config, async (client) => {
        await client.query("SELECT 1");
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw new Error("PostgreSQL integration container did not become ready.", { cause: lastError });
}

async function publishedPostgreSqlPort(containerName: string): Promise<number> {
  const { stdout } = await execFileAsync("docker", ["port", containerName, "5432/tcp"]);
  const match = /:(?<port>[0-9]+)\s*$/u.exec(stdout);
  const port = Number(match?.groups?.["port"]);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Docker did not publish a valid PostgreSQL port.");
  }
  return port;
}

async function docker(arguments_: readonly string[], ignoreFailure = false): Promise<void> {
  try {
    await execFileAsync("docker", arguments_);
  } catch (error) {
    if (!ignoreFailure) throw error;
  }
}

function isPostgreSqlError(value: unknown): value is { readonly code: string } {
  return typeof value === "object" && value !== null && "code" in value;
}
