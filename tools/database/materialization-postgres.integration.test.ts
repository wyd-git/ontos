import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { canonicalizeMaterializationContractForDigest } from "@ontos/contracts";
import pg from "pg";

import { isDatabaseMigrationError } from "./errors.ts";
import { databaseMigrationDirectory, runDatabaseMigrations } from "./migrator.ts";
import { resolvePostgresTestImage } from "./postgres-test-image.ts";

const execFileAsync = promisify(execFile);
const postgresImage = resolvePostgresTestImage();
const database = "ontos_db02_upgrade";
const adminPassword = "local-only-db02-admin-secret";
const runtimePassword = "local-only-db02-runtime-secret";

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
  checkpoint: "10000000-0000-4000-8000-000000001401",
  ingressSession: "10000000-0000-4000-8000-000000001501",
  ingressExpiredSession: "10000000-0000-4000-8000-000000001502",
  ingressArtifact: "10000000-0000-4000-8000-000000001601",
  ingressExpiredArtifact: "10000000-0000-4000-8000-000000001602",
  ingressClaim: "10000000-0000-4000-8000-000000001701",
  ingressSnapshot: "10000000-0000-4000-8000-000000001801",
  ingressFile: "10000000-0000-4000-8000-000000001901",
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
  { timeout: 240_000 },
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
          [7, 8, 9, 10],
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
  await client.query(
    `UPDATE runtime.generations SET state = 'ready', changed_at = clock_timestamp()
     WHERE project_id = $1 AND generation_id = $2`,
    [ids.project, ids.generation],
  );
  await client.query(
    `UPDATE ops.materialization_jobs
     SET state = 'cancelled', updated_at = clock_timestamp()
     WHERE project_id = $1 AND job_id = $2`,
    [ids.project, ids.job],
  );
  const empty = await client.query<{ readonly objects: number; readonly links: number }>(
    `SELECT
       (SELECT count(*)::integer FROM runtime.object_current WHERE generation_id = $1) AS objects,
       (SELECT count(*)::integer FROM runtime.link_current WHERE generation_id = $1) AS links`,
    [ids.generation],
  );
  assert.deepEqual(empty.rows[0], { objects: 0, links: 0 });
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
  assert.equal(left.applied.length + right.applied.length, 10);
  assert.equal(Number(left.noOp) + Number(right.noOp), 1);
  await withClient(freshConfig, async (client) => {
    assert.equal((await runDatabaseMigrations(client)).noOp, true);
    assert.equal((await migrationLedger(client, 10)).length, 10);
  });
}

async function assertEveryDb02MigrationRollsBack(adminConfig: pg.ClientConfig): Promise<void> {
  const probes = new Map<number, string>([
    [7, "runtime.snapshot_groups"],
    [8, "runtime.object_identities"],
    [9, "ops.materialization_jobs"],
    [10, "runtime.snapshot_upload_sessions"],
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
  const directory = await migrationPrefixDirectory(10);
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
