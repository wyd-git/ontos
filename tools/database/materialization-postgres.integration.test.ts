import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { arch, cpus, freemem, platform, tmpdir, totalmem } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  canonicalizeContractForDigest,
  canonicalizeMaterializationContractForDigest,
  parseArtifactDigest,
  parseCanonicalInstant,
  parseOntosId,
  type ArtifactDigest,
} from "@ontos/contracts";
import {
  GarbageCollectionApplicationError,
  GarbageCollectionService,
  IndexPlanAdmissionService,
  MaterializationBaseError,
  MaterializationBaseService,
  MaterializationQualityError,
  MaterializationQualityService,
  ProjectionCapacityAdmissionService,
  RowCountConfirmationService,
  SnapshotGroupCutoverCoordinator,
  SnapshotGroupCutoverError,
  RuntimeCompatibilityCoordinator,
  RuntimeCompatibilityError,
  provenanceTemplatesFromPlan,
  type BaseBatchReceipt,
} from "@ontos/materialization-application";
import {
  compileMapping,
  executeManagedCsvMapping,
  type CapacityReport,
  type MappingAcceptedLinkRow,
  type MappingAcceptedObjectRow,
  type ReleaseIndexPlanInput,
} from "@ontos/materialization-domain";
import {
  executeProjectionDdlRequest,
  PostgresGarbageCollectionRepository,
  PostgresIndexPlanAdmissionRepository,
  PostgresMaterializationBaseRepository,
  PostgresMaterializationQualityRepository,
  PostgresProjectionCapacityAdmissionRepository,
  PostgresRuntimeCompatibilityRepository,
  PostgresSnapshotGroupCutoverRepository,
  scanAndRecordProjectPhysicalInventory,
  type ProjectPhysicalInventoryMeasurement,
} from "@ontos/materialization-postgres";
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
const gcCommitCliPath = fileURLToPath(
  new URL("../materialization-gc/commit-cli.ts", import.meta.url),
);
const postgresImage = resolvePostgresTestImage();
const database = "ontos_db02_upgrade";
const adminPassword = "local-only-db02-admin-secret";
const runtimePassword = "local-only-db02-runtime-secret";
const projectionDdlPassword = "local-only-g20209-capacity-ddl-secret";
const capacityS3Image =
  "chrislusf/seaweedfs:4.41@sha256:43b768cd62b00d132439cda881b93fd1adebf1b315e996e794087743821d771d";
const baseCapacityMode = process.env.ONTOS_G2_02_06_CAPACITY === "1";
const projectionCapacityMode = process.env.ONTOS_G2_02_09_CAPACITY === "1";
const projectionCapacitySmokeMode =
  projectionCapacityMode && process.env.ONTOS_G2_02_09_CAPACITY_SMOKE === "1";
const capacityMode = baseCapacityMode || projectionCapacityMode;
const materializationLeaseSeconds = 300;
const qualityObjectRows = 1_000;
const capacityMetrics = {
  objectRows: projectionCapacityMode
    ? projectionCapacitySmokeMode
      ? 1_000
      : 100_000
    : baseCapacityMode
      ? 10_000
      : 2,
  linkRows: projectionCapacityMode
    ? projectionCapacitySmokeMode
      ? 10_000
      : 1_000_000
    : baseCapacityMode
      ? 100_000
      : 1,
  objectBatches: 0,
  linkBatches: 0,
  objectMilliseconds: 0,
  linkMilliseconds: 0,
  peakRssBytes: process.memoryUsage().rss,
  walStart: "",
  identityProbeRows: 0,
};
let projectionBuildStartedAt: bigint | undefined;

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
  releaseValidation3: "10000000-0000-4000-8000-000000000323",
  release1: "10000000-0000-4000-8000-000000000401",
  release2: "10000000-0000-4000-8000-000000000402",
  release3: "10000000-0000-4000-8000-000000000403",
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
  indexAdmission: "10000000-0000-4000-8000-000000000702",
  indexAdmission3: "10000000-0000-4000-8000-000000000703",
  job: "10000000-0000-4000-8000-000000000801",
  leaseJob: "10000000-0000-4000-8000-000000000802",
  report: "10000000-0000-4000-8000-000000000901",
  generation: "10000000-0000-4000-8000-000000001001",
  certificate: "10000000-0000-4000-8000-000000001101",
  linkCertificate: "10000000-0000-4000-8000-000000001103",
  capacityAdmission: "10000000-0000-4000-8000-000000001102",
  worker1: "10000000-0000-4000-8000-000000001201",
  worker2: "10000000-0000-4000-8000-000000001202",
  attempt1: "10000000-0000-4000-8000-000000001301",
  attempt2: "10000000-0000-4000-8000-000000001302",
  baseAttempt1: "10000000-0000-4000-8000-000000001303",
  baseAttempt2: "10000000-0000-4000-8000-000000001304",
  checkpoint: "10000000-0000-4000-8000-000000001401",
  checkpoint2: "10000000-0000-4000-8000-000000001402",
  checkpoint3: "10000000-0000-4000-8000-000000001403",
  checkpoint4: "10000000-0000-4000-8000-000000001404",
  checkpointOutput1: "10000000-0000-4000-8000-000000001411",
  checkpointOutput2: "10000000-0000-4000-8000-000000001412",
  checkpointOutput3: "10000000-0000-4000-8000-000000001413",
  checkpointOutput4: "10000000-0000-4000-8000-000000001414",
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
  projectionLinkQualityReport: "10000000-0000-4000-8000-00000000200f",
  refresh2Snapshot: "40000000-0000-4000-8000-000000000001",
  refresh2File: "40000000-0000-4000-8000-000000000002",
  refresh2Artifact: "40000000-0000-4000-8000-000000000003",
  refresh2Job: "40000000-0000-4000-8000-000000000004",
  refresh2Attempt: "40000000-0000-4000-8000-000000000005",
  refresh2Report: "40000000-0000-4000-8000-000000000006",
  refresh2Generation: "40000000-0000-4000-8000-000000000007",
  refresh2CapacityAdmission: "40000000-0000-4000-8000-000000000008",
  refresh2Certificate2: "40000000-0000-4000-8000-000000000009",
  refresh2Certificate3: "40000000-0000-4000-8000-00000000000a",
  refresh3Snapshot: "40000000-0000-4000-8000-000000000011",
  refresh3File: "40000000-0000-4000-8000-000000000012",
  refresh3Artifact: "40000000-0000-4000-8000-000000000013",
  refresh3Job: "40000000-0000-4000-8000-000000000014",
  refresh3Attempt: "40000000-0000-4000-8000-000000000015",
  refresh3Report: "40000000-0000-4000-8000-000000000016",
  refresh3Generation: "40000000-0000-4000-8000-000000000017",
  refresh3CapacityAdmission: "40000000-0000-4000-8000-000000000018",
  refresh3Certificate2: "40000000-0000-4000-8000-000000000019",
  refresh3Certificate3: "40000000-0000-4000-8000-00000000001a",
  gcGeneration: "50000000-0000-4000-8000-000000000001",
  gcReport: "50000000-0000-4000-8000-000000000002",
  gcHeadSet: "50000000-0000-4000-8000-000000000003",
  gcOrphanSession: "50000000-0000-4000-8000-000000000004",
  gcOrphanArtifact: "50000000-0000-4000-8000-000000000005",
  gcStaleJob: "50000000-0000-4000-8000-000000000006",
  qualityGroup: "30000000-0000-4000-8000-000000000001",
  qualityObjectSnapshot: "30000000-0000-4000-8000-000000000002",
  qualityObjectFile: "30000000-0000-4000-8000-000000000003",
  qualityObjectArtifact: "30000000-0000-4000-8000-000000000004",
  qualityLinkSnapshot: "30000000-0000-4000-8000-000000000005",
  qualityLinkFile: "30000000-0000-4000-8000-000000000006",
  qualityLinkArtifact: "30000000-0000-4000-8000-000000000007",
  qualityObjectGeneration: "30000000-0000-4000-8000-000000000008",
  qualityLinkGeneration: "30000000-0000-4000-8000-000000000009",
  qualityJob: "30000000-0000-4000-8000-00000000000a",
  qualityAttempt: "30000000-0000-4000-8000-00000000000b",
  qualityObjectReport: "30000000-0000-4000-8000-00000000000c",
  qualityObjectRejectedSet: "30000000-0000-4000-8000-00000000000d",
  qualityObjectRejectedArtifact: "30000000-0000-4000-8000-00000000000e",
  qualityLinkReport: "30000000-0000-4000-8000-00000000000f",
  qualityLinkRejectedSet: "30000000-0000-4000-8000-000000000010",
  qualityLinkRejectedArtifact: "30000000-0000-4000-8000-000000000011",
  linkSchemaResource: "30000000-0000-4000-8000-000000000012",
  linkSchemaRevision: "30000000-0000-4000-8000-000000000013",
  linkSchemaValidation: "30000000-0000-4000-8000-000000000014",
  linkMappingResource: "30000000-0000-4000-8000-000000000015",
  linkMappingRevision: "30000000-0000-4000-8000-000000000016",
  linkMappingValidation: "30000000-0000-4000-8000-000000000017",
  qualityLinkIndexPlan: "30000000-0000-4000-8000-000000000018",
  qualityOwnerBinding: "30000000-0000-4000-8000-000000000019",
  qualityObjectSnapshotV2: "30000000-0000-4000-8000-00000000001a",
  qualityObjectFileV2: "30000000-0000-4000-8000-00000000001b",
  qualityObjectArtifactV2: "30000000-0000-4000-8000-00000000001c",
  qualityObjectGenerationV2: "30000000-0000-4000-8000-00000000001d",
  qualityJobV2: "30000000-0000-4000-8000-00000000001e",
  qualityAttemptV2: "30000000-0000-4000-8000-00000000001f",
  qualityObjectReportV2: "30000000-0000-4000-8000-000000000020",
  qualityConfirmationV2Stale: "30000000-0000-4000-8000-000000000021",
  qualityConfirmationV2: "30000000-0000-4000-8000-000000000022",
  qualityObjectSnapshotV3: "30000000-0000-4000-8000-000000000023",
  qualityObjectFileV3: "30000000-0000-4000-8000-000000000024",
  qualityObjectArtifactV3: "30000000-0000-4000-8000-000000000025",
  qualityObjectGenerationV3: "30000000-0000-4000-8000-000000000026",
  qualityJobV3: "30000000-0000-4000-8000-000000000027",
  qualityAttemptV3: "30000000-0000-4000-8000-000000000028",
  qualityObjectReportV3: "30000000-0000-4000-8000-000000000029",
  qualityConfirmationV3: "30000000-0000-4000-8000-00000000002a",
  qualityConfirmationV2Race: "30000000-0000-4000-8000-00000000002b",
} as const;

let activatedRelease2Id: string = ids.activation1;

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

interface ProjectionBenchmarkPlan {
  readonly indexPlanId: string;
  readonly planDigest: ArtifactDigest;
  readonly releasePlanDigest: ArtifactDigest;
  readonly secondaryIndexUnits: number;
  readonly indexCount: number;
  readonly initialMeasurement: ProjectPhysicalInventoryMeasurement;
  inventoryRevision: bigint;
  prebuildReport?: CapacityReport;
}

let activeProjectionPlan: ProjectionBenchmarkPlan | undefined;

function runtimeObjectIndexPlanDigest(): ArtifactDigest {
  return activeProjectionPlan?.planDigest ?? parseArtifactDigest(digests.indexPlan);
}

void test(
  projectionCapacityMode
    ? "G2-02-09 validates Projection indexes and capacity on real materialized data"
    : "G2-02-03 upgrades A0 safely and enforces DB-02 facts, fencing and least privilege",
  { timeout: projectionCapacityMode ? 2_400_000 : capacityMode ? 600_000 : 240_000 },
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
      ...(projectionCapacityMode
        ? []
        : ["--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=2g"]),
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
          [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
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
      const ddlConfig = {
        ...adminConfig,
        user: "g20209_capacity_ddl_login",
        password: projectionDdlPassword,
      };

      const projectionPlan = await withClient(adminConfig, (admin) =>
        prepareRuntimeFacts(
          admin,
          projectionCapacityMode
            ? () => prepareProjectionIndexPlan(admin, apiConfig, worker1Config)
            : undefined,
        ),
      );
      if (projectionCapacityMode) {
        assert.ok(projectionPlan);
        await prepareProjectionCapacityPrebuild(
          adminConfig,
          apiConfig,
          worker1Config,
          projectionPlan,
        );
        projectionBuildStartedAt = process.hrtime.bigint();
      }
      await exercisePermanentIdentityAndObjectBase(adminConfig, worker1Config, worker2Config);
      if (!projectionCapacityMode) await withClient(adminConfig, prepareLinkRuntimeFacts);
      if (projectionCapacityMode) await makeLinkJobAvailable(adminConfig);
      const qualityCurrentMilliseconds = await exerciseLinkBase(
        adminConfig,
        apiConfig,
        worker1Config,
      );
      await exerciseQualityCurrentAndRequiredDangling(adminConfig, apiConfig, worker2Config);
      if (projectionCapacityMode) {
        assert.ok(projectionPlan);
        await exerciseProjectionCapacityPostbuild(
          adminConfig,
          apiConfig,
          worker1Config,
          ddlConfig,
          projectionPlan,
          containerName,
          required(qualityCurrentMilliseconds),
        );
      }
      await withClient(adminConfig, prepareCompatibilityCapacityFacts);
      await withClient(apiConfig, async (api) => {
        await issueCertificateAndReady(api);
      });
      if (!projectionCapacityMode) {
        await exerciseRuntimeCompatibilityCoordinator(adminConfig, apiConfig);
        await exerciseCompatibilityFailureVectors(adminConfig, apiConfig, worker1Config);
      }
      if (!projectionCapacityMode) {
        await exerciseManagedCsvIngressDatabase(apiConfig, worker1Config, opsConfig);
      }
      await prepareAndCommitA1(adminConfig, apiConfig);
      await withClient(apiConfig, async (api) => {
        await publishA1(api);
      });
      await withClient(adminConfig, async (admin) => {
        assert.deepEqual(await activationSnapshot(admin, ids.activation0), beforeUpgrade);
        await assertA1AndCrossProjectGuards(admin);
        await assertImmutableAndControlledBoundaries(admin);
      });

      await exerciseRealWorkerFencing(adminConfig, apiConfig, worker1Config, worker2Config);
      await assertRuntimePrivilegeMatrix(apiConfig, worker1Config, opsConfig);
      if (!projectionCapacityMode) {
        await exerciseCompatibilityStalenessVectors(adminConfig, apiConfig, worker1Config);
        await exerciseSnapshotGroupRefreshCutover(adminConfig, apiConfig, worker1Config);
        // The per-batch SIGKILL matrix belongs to the normal PostgreSQL gate.
        // Capacity lanes retain their own throughput purpose instead of
        // duplicating every GC rollback over a large fixture.
        if (!capacityMode) await exerciseGenerationGarbageCollection(adminConfig, apiConfig);
      } else {
        await assertCapacityCutoverLinkSemantics(adminConfig);
      }
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
    content: capacityOrderObjectType(),
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
    readonly content?: unknown;
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
     VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6)`,
    [
      input.revisionId,
      input.resourceId,
      input.family,
      input.contentDigest,
      JSON.stringify(input.content ?? { schemaVersion: 1 }),
      ids.principal,
    ],
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

async function prepareRuntimeFacts(
  client: pg.Client,
  prepareIndexPlan?: () => Promise<ProjectionBenchmarkPlan>,
): Promise<ProjectionBenchmarkPlan | undefined> {
  await createPublishedResource(client, {
    resourceId: ids.schemaResource,
    revisionId: ids.schemaRevision,
    reportId: ids.schemaValidation,
    family: "snapshot_schema",
    apiName: "OrderCsvSchema",
    contentDigest: digests.schema,
    content: capacityObjectSchemaDefinition(),
  });
  await createPublishedResource(client, {
    resourceId: ids.mappingResource,
    revisionId: ids.mappingRevision,
    reportId: ids.mappingValidation,
    family: "mapping",
    apiName: "OrderCsvMapping",
    contentDigest: digests.mapping,
    content: capacityObjectMappingDefinition(),
  });
  if (projectionCapacityMode) {
    await prepareLinkTypeFacts(client);
    const linkSchema = qualityLinkSchemaDefinition();
    const linkMapping = qualityLinkMappingDefinition();
    await createPublishedResource(client, {
      resourceId: ids.linkSchemaResource,
      revisionId: ids.linkSchemaRevision,
      reportId: ids.linkSchemaValidation,
      family: "snapshot_schema",
      apiName: "ProjectionLinkCsvSchema",
      contentDigest: definitionDigest(linkSchema),
      content: linkSchema,
    });
    await createPublishedResource(client, {
      resourceId: ids.linkMappingResource,
      revisionId: ids.linkMappingRevision,
      reportId: ids.linkMappingValidation,
      family: "mapping",
      apiName: "ProjectionLinkCsvMapping",
      contentDigest: definitionDigest(linkMapping),
      content: linkMapping,
    });
  }
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
  if (projectionCapacityMode) {
    for (const [order, resourceId, revisionId, family] of [
      [3, ids.linkResource, ids.linkRevision, "link_type"],
      [4, ids.linkSchemaResource, ids.linkSchemaRevision, "snapshot_schema"],
      [5, ids.linkMappingResource, ids.linkMappingRevision, "mapping"],
    ] as const) {
      await client.query(
        `INSERT INTO meta.release_pins
           (release_id, resource_id, revision_id, pin_order, family, content_digest)
         SELECT $1, revision.resource_id, revision.revision_id, $2, $3, revision.content_digest
         FROM meta.resource_revisions AS revision
         WHERE revision.resource_id = $4 AND revision.revision_id = $5`,
        [ids.release2, order, family, resourceId, revisionId],
      );
    }
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
  const projectionPlan = await prepareIndexPlan?.();
  activeProjectionPlan = projectionPlan;
  const objectIndexPlanId = projectionPlan?.indexPlanId ?? ids.indexPlan;
  const objectIndexPlanDigest = projectionPlan?.planDigest ?? digests.indexPlan;

  if (projectionPlan === undefined) {
    await client.query(
      `INSERT INTO runtime.project_runtime_inventories
         (project_id, state_revision, inventory_revision, measurement_complete, inventory_digest)
       VALUES ($1, 1, 1, true, $2)`,
      [ids.project, sha256Digest("g2-02-10-regression-inventory")],
    );
  }
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO runtime.snapshot_groups
       (project_id, snapshot_group_id, group_key, definition_member_count)
     VALUES ($1, $2, 'orders', $3)`,
    [ids.project, ids.snapshotGroup, projectionCapacityMode ? 2 : 1],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_group_definition_members
       (project_id, snapshot_group_id, ordinal, mapping_resource_id)
     VALUES ($1, $2, 0, $3)`,
    [ids.project, ids.snapshotGroup, ids.mappingResource],
  );
  if (projectionCapacityMode) {
    await client.query(
      `INSERT INTO runtime.snapshot_group_definition_members
         (project_id, snapshot_group_id, ordinal, mapping_resource_id)
       VALUES ($1, $2, 1, $3)`,
      [ids.project, ids.snapshotGroup, ids.linkMappingResource],
    );
  }
  await client.query("COMMIT");
  if (projectionPlan === undefined) {
    await client.query(
      `INSERT INTO runtime.index_plans
         (project_id, index_plan_id, target_resource_id, target_revision_id,
          plan_digest, entry_count, compiler_version)
       VALUES ($1, $2, $3, $4, $5, 0, 'index-plan-g2-02-v1')`,
      [
        ids.project,
        objectIndexPlanId,
        ids.objectResource,
        ids.objectRevision,
        objectIndexPlanDigest,
      ],
    );
    await client.query(
      `INSERT INTO runtime.index_plan_admissions (
         project_id, admission_id, release_id, release_plan_digest,
         index_plan_id, inventory_revision, release_units, project_union_units,
         project_physical_index_count, admission_mode, report_digest
       ) VALUES ($1, $2, $3, $4, $5, 1, 0, 0, 0, 'WITHIN_NORMAL', $6)`,
      [
        ids.project,
        ids.indexAdmission,
        ids.release2,
        sha256Digest("g2-02-10-regression-release-index-plan"),
        objectIndexPlanId,
        sha256Digest("g2-02-10-regression-index-admission"),
      ],
    );
  }
  if (projectionCapacityMode) {
    await client.query(
      `INSERT INTO runtime.index_plans
         (project_id, index_plan_id, target_resource_id, target_revision_id,
          plan_digest, entry_count, compiler_version)
       VALUES ($1, $2, $3, $4, $5, 0, 'g2-02-10-link-index-v1')`,
      [
        ids.project,
        ids.linkIndexPlan,
        ids.linkResource,
        ids.linkRevision,
        sha256Digest("link-index-plan"),
      ],
    );
  }

  const runtimePlanMembers = [
    ...(projectionCapacityMode
      ? [
          {
            memberKey: "link:OrderRelation",
            memberKind: "link",
            targetResourceId: ids.linkResource,
            targetRevisionId: ids.linkRevision,
            snapshotSchemaRevisionId: ids.linkSchemaRevision,
            mappingRevisionId: ids.linkMappingRevision,
            snapshotGroupId: ids.snapshotGroup,
            indexPlanDigest: sha256Digest("link-index-plan"),
          },
        ]
      : []),
    {
      memberKey: "object:Order",
      memberKind: "object",
      targetResourceId: ids.objectResource,
      targetRevisionId: ids.objectRevision,
      snapshotSchemaRevisionId: ids.schemaRevision,
      mappingRevisionId: ids.mappingRevision,
      snapshotGroupId: ids.snapshotGroup,
      indexPlanDigest: objectIndexPlanDigest,
    },
  ];
  const runtimePlanDigest = materializationDigest("RuntimeMemberPlan", {
    schemaVersion: 1,
    contractVersion: "runtime-member-plan-v1",
    projectId: ids.project,
    releaseId: ids.release2,
    members: runtimePlanMembers,
    planDigest: digestOf("0"),
  });

  await client.query("BEGIN");
  await client.query(
    `INSERT INTO meta.release_runtime_plans
       (project_id, release_id, plan_digest, member_count) VALUES ($1, $2, $3, $4)`,
    [ids.project, ids.release2, runtimePlanDigest, runtimePlanMembers.length],
  );
  if (projectionCapacityMode) {
    await client.query(
      `INSERT INTO meta.release_runtime_plan_members (
         project_id, release_id, runtime_plan_digest, member_key, member_kind,
         target_resource_id, target_revision_id,
         snapshot_schema_resource_id, snapshot_schema_revision_id,
         mapping_resource_id, mapping_revision_id, snapshot_group_id, index_plan_digest
       ) VALUES ($1, $2, $3, 'link:OrderRelation', 'link', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        ids.project,
        ids.release2,
        runtimePlanDigest,
        ids.linkResource,
        ids.linkRevision,
        ids.linkSchemaResource,
        ids.linkSchemaRevision,
        ids.linkMappingResource,
        ids.linkMappingRevision,
        ids.snapshotGroup,
        sha256Digest("link-index-plan"),
      ],
    );
  }
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
      objectIndexPlanDigest,
    ],
  );
  await client.query("COMMIT");
  const dbDigest = await client.query<{ readonly digest: string }>(
    `SELECT ontos_migration.g20203_runtime_plan_digest($1, $2) AS digest`,
    [ids.project, ids.release2],
  );
  assert.equal(dbDigest.rows[0]?.digest, runtimePlanDigest);

  const objectSourceBytes = capacityMode
    ? capacityObjectSourceBytes(capacityMetrics.objectRows)
    : 0n;
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO runtime.snapshot_group_versions
       (project_id, snapshot_group_id, group_version, member_count, group_digest)
     VALUES ($1, $2, 1, $3, $4)`,
    [
      ids.project,
      ids.snapshotGroup,
      projectionCapacityMode ? 2 : 1,
      projectionCapacityMode ? sha256Digest("g2-02-09-object-link-group") : digests.group,
    ],
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
       $10, $11, $12, $13, 1, $14
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
      objectSourceBytes.toString(),
      capacityMetrics.objectRows,
      digests.snapshot,
    ],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_files (
       project_id, snapshot_id, file_id, managed_artifact_id, object_version,
       ordinal, content_digest, byte_count, row_count, source_label, scan_status
     ) VALUES ($1, $2, $3, $4, 'version-1', 0, $5, $6, $7,
               'DB-02 migration fixture', 'complete')`,
    [
      ids.project,
      ids.snapshot,
      ids.snapshotFile,
      ids.managedArtifact,
      digests.snapshotContent,
      objectSourceBytes.toString(),
      capacityMetrics.objectRows,
    ],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_group_members (
       project_id, snapshot_group_id, group_version, member_key, member_kind,
       snapshot_id, target_resource_id, target_revision_id
     ) VALUES ($1, $2, 1, 'object:Order', 'object', $3, $4, $5)`,
    [ids.project, ids.snapshotGroup, ids.snapshot, ids.objectResource, ids.objectRevision],
  );
  if (projectionCapacityMode) {
    const linkContentDigest = sha256Digest("link-snapshot-content");
    const linkSourceBytes = capacityLinkSourceBytes(capacityMetrics.linkRows);
    await client.query(
      `INSERT INTO runtime.dataset_snapshots (
         project_id, snapshot_id, snapshot_group_id, group_version,
         member_key, member_kind, target_resource_id, target_revision_id,
         snapshot_schema_resource_id, snapshot_schema_revision_id,
         mapping_resource_id, mapping_revision_id, runtime_plan_digest,
         content_digest, byte_count, row_count, file_count, snapshot_digest
       ) VALUES (
         $1, $2, $3, 1, 'link:OrderRelation', 'link', $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, 1, $14
       )`,
      [
        ids.project,
        ids.linkSnapshot,
        ids.snapshotGroup,
        ids.linkResource,
        ids.linkRevision,
        ids.linkSchemaResource,
        ids.linkSchemaRevision,
        ids.linkMappingResource,
        ids.linkMappingRevision,
        runtimePlanDigest,
        linkContentDigest,
        linkSourceBytes.toString(),
        capacityMetrics.linkRows,
        sha256Digest("link-snapshot"),
      ],
    );
    await client.query(
      `INSERT INTO runtime.snapshot_files (
         project_id, snapshot_id, file_id, managed_artifact_id, object_version,
         ordinal, content_digest, byte_count, row_count, source_label, scan_status
       ) VALUES ($1, $2, $3, $4, 'link-version-1', 0, $5, $6, $7,
                 'G2-02-09 Link capacity fixture', 'complete')`,
      [
        ids.project,
        ids.linkSnapshot,
        ids.linkSnapshotFile,
        ids.linkManagedArtifact,
        linkContentDigest,
        linkSourceBytes.toString(),
        capacityMetrics.linkRows,
      ],
    );
    await client.query(
      `INSERT INTO runtime.snapshot_group_members (
         project_id, snapshot_group_id, group_version, member_key, member_kind,
         snapshot_id, target_resource_id, target_revision_id
       ) VALUES ($1, $2, 1, 'link:OrderRelation', 'link', $3, $4, $5)`,
      [ids.project, ids.snapshotGroup, ids.linkSnapshot, ids.linkResource, ids.linkRevision],
    );
  }
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
       WHERE project_id = $1 AND snapshot_group_id = $2 AND group_version = 1`,
      [ids.project, ids.snapshotGroup, state],
    );
  }

  await client.query(
    `INSERT INTO ops.materialization_jobs
       (project_id, job_id, snapshot_group_id, group_version, idempotency_key, input_digest)
     VALUES ($1, $2, $3, 1, 'db02-runtime-job-0001', $4)`,
    [ids.project, ids.job, ids.snapshotGroup, digests.job],
  );
  await client.query(
    `INSERT INTO runtime.generations (
       project_id, generation_id, member_key, member_kind,
       target_resource_id, target_revision_id, snapshot_id, snapshot_group_id, group_version,
       snapshot_schema_resource_id, snapshot_schema_revision_id,
       mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest
     ) VALUES (
       $1, $2, 'object:Order', 'object', $3, $4, $5, $6, 1,
       $7, $8, $9, $10, $11, $12
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
      objectIndexPlanDigest,
    ],
  );
  if (projectionCapacityMode) {
    await client.query(
      `INSERT INTO ops.materialization_jobs
         (project_id, job_id, snapshot_group_id, group_version, idempotency_key, input_digest,
          available_at)
       VALUES ($1, $2, $3, 1, 'g2-02-09-link-base-job-0001', $4,
               clock_timestamp() + interval '1 day')`,
      [ids.project, ids.linkJob, ids.snapshotGroup, sha256Digest("link-job")],
    );
    await client.query(
      `INSERT INTO runtime.generations (
         project_id, generation_id, member_key, member_kind,
         target_resource_id, target_revision_id, snapshot_id, snapshot_group_id, group_version,
         snapshot_schema_resource_id, snapshot_schema_revision_id,
         mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest
       ) VALUES (
         $1, $2, 'link:OrderRelation', 'link', $3, $4, $5, $6, 1,
         $7, $8, $9, $10, $11, $12
       )`,
      [
        ids.project,
        ids.linkGeneration,
        ids.linkResource,
        ids.linkRevision,
        ids.linkSnapshot,
        ids.snapshotGroup,
        ids.linkSchemaResource,
        ids.linkSchemaRevision,
        ids.linkMappingResource,
        ids.linkMappingRevision,
        runtimePlanDigest,
        sha256Digest("link-index-plan"),
      ],
    );
  }
  const empty = await client.query<{ readonly objects: number; readonly links: number }>(
    `SELECT
       (SELECT count(*)::integer FROM runtime.object_current WHERE generation_id = $1) AS objects,
       (SELECT count(*)::integer FROM runtime.link_current WHERE generation_id = $1) AS links`,
    [ids.generation],
  );
  assert.deepEqual(empty.rows[0], { objects: 0, links: 0 });
  return projectionPlan;
}

async function prepareProjectionIndexPlan(
  admin: pg.Client,
  apiConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
): Promise<ProjectionBenchmarkPlan> {
  await admin.query(
    `INSERT INTO runtime.project_runtime_inventories
       (project_id, state_revision, inventory_revision, measurement_complete)
     VALUES ($1::uuid, 1, 1, false)`,
    [ids.project],
  );
  const crypto = projectionCapacityCrypto();
  const workerPool = new pg.Pool(workerConfig);
  let initialMeasurement: ProjectPhysicalInventoryMeasurement;
  try {
    initialMeasurement = await scanAndRecordProjectPhysicalInventory(workerPool, crypto, {
      projectId: ids.project,
      expectedInventoryRevision: 1n,
    });
  } finally {
    await workerPool.end();
  }

  const apiPool = new pg.Pool(apiConfig);
  try {
    const staged = await new IndexPlanAdmissionService({
      repository: new PostgresIndexPlanAdmissionRepository(apiPool),
      crypto,
    }).stageReleasePlan({ plan: projectionBenchmarkIndexPlan(), at: Date.now() });
    assert.equal(staged.persistedPlans.length, 1);
    assert.equal(staged.compiled.objectTypes.length, 1);
    assert.equal(staged.compiled.indexes.length, 3);
    assert.equal(staged.compiled.secondaryIndexUnits, 7);
    const persisted = required(staged.persistedPlans[0]);
    const objectPlan = required(staged.compiled.objectTypes[0]);
    assert.equal(persisted.planDigest, objectPlan.planDigest);
    assert.equal(persisted.reused, false);
    return {
      indexPlanId: persisted.indexPlanId,
      planDigest: persisted.planDigest,
      releasePlanDigest: staged.compiled.planDigest,
      secondaryIndexUnits: objectPlan.secondaryIndexUnits,
      indexCount: objectPlan.indexes.length,
      initialMeasurement,
      inventoryRevision: initialMeasurement.inventoryRevision,
    };
  } finally {
    await apiPool.end();
  }
}

function projectionBenchmarkIndexPlan(): ReleaseIndexPlanInput {
  return {
    projectId: ids.project,
    releaseId: ids.release2,
    evidenceCatalog: ["query:order-id", "query:display-filter", "query:display-search"],
    objectTypes: [
      {
        resourceId: ids.objectResource,
        revisionId: ids.objectRevision,
        properties: [
          { propertyId: "orderId", type: "string", primaryKey: true, unique: true },
          {
            propertyId: "displayName",
            type: "string",
            filterable: true,
            sortable: true,
            searchable: true,
          },
        ],
        indexes: [
          {
            kind: "btree",
            keys: [{ propertyId: "orderId" }],
            unique: true,
            evidenceRefs: ["query:order-id"],
          },
          {
            kind: "btree",
            keys: [{ propertyId: "displayName" }],
            evidenceRefs: ["query:display-filter"],
          },
          {
            kind: "gin_trigram",
            propertyId: "displayName",
            evidenceRefs: ["query:display-search"],
          },
        ],
      },
    ],
  };
}

function projectionCapacityCrypto() {
  return Object.freeze({ randomId: randomUUID, digestCanonicalText: sha256Artifact });
}

async function prepareProjectionCapacityPrebuild(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
  plan: ProjectionBenchmarkPlan,
): Promise<void> {
  const workerPool = new pg.Pool(workerConfig);
  try {
    await persistProjectionSourceForecasts(workerPool);
    const measurement = await scanAndRecordProjectPhysicalInventory(
      workerPool,
      projectionCapacityCrypto(),
      { projectId: ids.project, expectedInventoryRevision: plan.inventoryRevision },
    );
    plan.inventoryRevision = measurement.inventoryRevision;
  } finally {
    await workerPool.end();
  }

  const apiPool = new pg.Pool(apiConfig);
  try {
    const restaged = await new IndexPlanAdmissionService({
      repository: new PostgresIndexPlanAdmissionRepository(apiPool),
      crypto: projectionCapacityCrypto(),
    }).stageReleasePlan({ plan: projectionBenchmarkIndexPlan(), at: Date.now() });
    assert.equal(required(restaged.persistedPlans[0]).indexPlanId, plan.indexPlanId);
    assert.equal(required(restaged.persistedPlans[0]).reused, true);
    assert.equal(restaged.compiled.planDigest, plan.releasePlanDigest);
  } finally {
    await apiPool.end();
  }

  const admissionPool = new pg.Pool(workerConfig);
  try {
    // PREBUILD deliberately uses the adapter's production loader. The scoped benchmark loader
    // below remains only for POSTBUILD because later regression fixtures add unrelated Generations.
    const repository = new PostgresProjectionCapacityAdmissionRepository(admissionPool);
    plan.prebuildReport = await new ProjectionCapacityAdmissionService({
      repository,
      crypto: projectionCapacityCrypto(),
    }).admit({ projectId: ids.project, generationId: ids.generation, phase: "PREBUILD" });
    assert.equal(plan.prebuildReport.accepted, true);
    assert.equal(plan.prebuildReport.peakReservedBytes < 12n * 1024n ** 3n, true);
    const postbuildShape = await repository.readCapacityAdmissionSnapshot({
      projectId: ids.project,
      generationId: ids.generation,
      phase: "POSTBUILD",
    });
    assert.equal(postbuildShape.inventoryRevision, plan.inventoryRevision);
    assert.equal(postbuildShape.input.generations.length, 2);
    assert.equal(postbuildShape.physicalMeasurementDigest !== undefined, true);
  } finally {
    await admissionPool.end();
  }

  await withClient(adminConfig, async (admin) => {
    const facts = await admin.query<{
      readonly generationCount: number;
      readonly forecastCount: number;
      readonly admissionCount: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM runtime.generations
           WHERE project_id = $1 AND generation_id IN ($2::uuid, $3::uuid)) AS "generationCount",
         (SELECT count(*)::integer FROM runtime.source_forecasts
           WHERE project_id = $1 AND generation_id IN ($2::uuid, $3::uuid)) AS "forecastCount",
         (SELECT count(*)::integer FROM runtime.capacity_admissions
           WHERE project_id = $1 AND generation_id = $2::uuid AND phase = 'PREBUILD') AS "admissionCount"`,
      [ids.project, ids.generation, ids.linkGeneration],
    );
    assert.deepEqual(facts.rows[0], {
      generationCount: 2,
      forecastCount: 2,
      admissionCount: 1,
    });
  });
}

async function persistProjectionSourceForecasts(pool: pg.Pool): Promise<void> {
  const forecasts = [
    {
      generationId: ids.generation,
      objectRows: BigInt(capacityMetrics.objectRows),
      linkRows: 0n,
      sourceBytes: capacityObjectSourceBytes(capacityMetrics.objectRows),
      projectedMeasuredBytes: 132_124_672n,
    },
    {
      generationId: ids.linkGeneration,
      objectRows: 0n,
      linkRows: BigInt(capacityMetrics.linkRows),
      sourceBytes: capacityLinkSourceBytes(capacityMetrics.linkRows),
      projectedMeasuredBytes: 389_017_600n,
    },
  ] as const;
  for (const forecast of forecasts) {
    const digest = sha256Artifact(
      canonicalizeContractForDigest({
        schemaVersion: 1,
        contractVersion: "projection-source-forecast-v1",
        projectId: ids.project,
        generationId: forecast.generationId,
        objectRows: forecast.objectRows.toString(),
        linkRows: forecast.linkRows.toString(),
        sourceBytes: forecast.sourceBytes.toString(),
        projectedMeasuredBytes: forecast.projectedMeasuredBytes.toString(),
        scannerVersion: "g2-02-09-benchmark-v1",
      }),
    );
    await pool.query(
      `INSERT INTO runtime.source_forecasts (
         project_id, generation_id, forecast_id, object_row_count, link_row_count,
         source_bytes, projected_measured_bytes, scanner_version, forecast_digest
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9)`,
      [
        ids.project,
        forecast.generationId,
        randomUUID(),
        forecast.objectRows.toString(),
        forecast.linkRows.toString(),
        forecast.sourceBytes.toString(),
        forecast.projectedMeasuredBytes.toString(),
        "g2-02-09-benchmark-v1",
        digest,
      ],
    );
  }
}

async function loadProjectionCapacitySnapshot(
  pool: pg.Pool,
  plan: ProjectionBenchmarkPlan,
  phase: "PREBUILD" | "POSTBUILD",
  generationId: string = ids.generation,
) {
  const inventory = await pool.query<{
    readonly inventoryRevision: string;
    readonly measurementComplete: boolean;
    readonly totalRelationBytes: string;
    readonly measurementDigest: string;
  }>(
    `SELECT inventory.inventory_revision::text AS "inventoryRevision",
            inventory.measurement_complete AND NOT EXISTS (
              SELECT 1 FROM runtime.index_inventory AS index_inventory
              WHERE index_inventory.project_id = inventory.project_id
                AND index_inventory.state IN ('planned', 'building', 'failed')
            ) AS "measurementComplete",
            measurement.total_relation_bytes::text AS "totalRelationBytes",
            measurement.measurement_digest AS "measurementDigest"
     FROM runtime.project_runtime_inventories AS inventory
     JOIN runtime.project_physical_measurements AS measurement
       ON measurement.project_id = inventory.project_id
      AND measurement.inventory_revision = inventory.inventory_revision
     WHERE inventory.project_id = $1::uuid`,
    [ids.project],
  );
  const inventoryRow = required(inventory.rows[0]);
  const generations = await pool.query<{
    readonly generationId: string;
    readonly memberKind: "object" | "link";
    readonly resourceId: string;
    readonly state: "building" | "ready" | "active" | "retired" | "failed";
    readonly createdAt: string;
    readonly objectRows: string;
    readonly linkRows: string;
    readonly projectedMeasuredBytes: string;
    readonly forecastDigest: string;
  }>(
    `SELECT generation.generation_id AS "generationId",
            generation.member_kind AS "memberKind",
            generation.target_resource_id AS "resourceId", generation.state,
            (extract(epoch FROM generation.created_at) * 1000)::bigint::text AS "createdAt",
            forecast.object_row_count::text AS "objectRows",
            forecast.link_row_count::text AS "linkRows",
            forecast.projected_measured_bytes::text AS "projectedMeasuredBytes",
            forecast.forecast_digest AS "forecastDigest"
     FROM runtime.generations AS generation
     JOIN runtime.source_forecasts AS forecast
       ON forecast.project_id = generation.project_id
      AND forecast.generation_id = generation.generation_id
     WHERE generation.project_id = $1::uuid
       AND generation.generation_id IN ($2::uuid, $3::uuid)
     ORDER BY generation.generation_id`,
    [ids.project, ids.generation, ids.linkGeneration],
  );
  assert.equal(generations.rows.length, 2);
  const sourceForecast = required(
    generations.rows.find((generation) => generation.generationId === generationId),
  );
  const at = Date.now();
  return Object.freeze({
    input: Object.freeze({
      projectId: ids.project,
      at,
      measurementComplete: inventoryRow.measurementComplete,
      observedProjectPhysicalBytes: BigInt(inventoryRow.totalRelationBytes),
      generations: Object.freeze(
        generations.rows.map((generation) =>
          Object.freeze({
            id: generation.generationId,
            projectId: ids.project,
            state: projectionCapacityGenerationState(generation.state),
            createdAt: Number(generation.createdAt),
            leftServingAt: null,
            derivedRecentSuccessful:
              generation.state === "ready" ||
              generation.state === "active" ||
              generation.state === "retired",
            objectTypes:
              generation.memberKind === "object"
                ? Object.freeze([
                    Object.freeze({
                      resourceId: generation.resourceId,
                      rows: BigInt(generation.objectRows),
                      secondaryIndexUnitsPerRow: BigInt(plan.secondaryIndexUnits),
                    }),
                  ])
                : Object.freeze([]),
            linkRows: BigInt(generation.linkRows),
            forecastMeasuredBytes: BigInt(generation.projectedMeasuredBytes),
            roots: Object.freeze([]),
          }),
        ),
      ),
      releaseServingSets: Object.freeze([]),
    }),
    inventoryRevision: BigInt(inventoryRow.inventoryRevision),
    indexPlanDigest:
      generationId === ids.linkGeneration ? sha256Artifact("link-index-plan") : plan.planDigest,
    sourceForecastDigest: parseArtifactDigest(sourceForecast.forecastDigest),
    ...(phase === "POSTBUILD"
      ? { physicalMeasurementDigest: parseArtifactDigest(inventoryRow.measurementDigest) }
      : {}),
  });
}

function projectionCapacityGenerationState(
  state: "building" | "ready" | "active" | "retired" | "failed",
): "STAGING" | "READY" | "FAILED_STAGING" {
  if (state === "building") return "STAGING";
  if (state === "failed") return "FAILED_STAGING";
  return "READY";
}

function capacityObjectSourceBytes(rowCount: number): bigint {
  let bytes = BigInt(Buffer.byteLength("orderId,displayName\n"));
  for (let index = 1; index <= rowCount; index += 1) {
    const digits = BigInt(String(index).length);
    bytes += 14n + 2n * digits;
  }
  return bytes;
}

function capacityLinkSourceBytes(rowCount: number): bigint {
  let bytes = BigInt(Buffer.byteLength("sourceOrderId,targetOrderId\n"));
  for (let index = 0; index < rowCount; index += 1) {
    const [source, target] = capacityLinkEndpoints(index);
    bytes += 14n + BigInt(String(source).length + String(target).length);
  }
  return bytes;
}

async function exerciseProjectionCapacityPostbuild(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
  ddlConfig: pg.ClientConfig,
  plan: ProjectionBenchmarkPlan,
  containerName: string,
  qualityCurrentMilliseconds: number,
): Promise<void> {
  await withClient(adminConfig, async (admin) => {
    const current = await admin.query<{
      readonly count: string;
      readonly endpointTypesBound: boolean;
    }>(
      `SELECT count(*)::text AS count,
              bool_and(source_object_type_resource_id = $3::uuid
                       AND target_object_type_resource_id = $3::uuid)
                AS "endpointTypesBound"
       FROM runtime.link_current
       WHERE project_id = $1::uuid AND generation_id = $2::uuid`,
      [ids.project, ids.linkGeneration, ids.objectResource],
    );
    assert.equal(current.rows[0]?.count, String(capacityMetrics.linkRows));
    assert.equal(current.rows[0]?.endpointTypesBound, true);
  });

  const requests = await withClient(workerConfig, async (worker) => {
    const entries = await worker.query<{ readonly entryKey: string }>(
      `SELECT entry_key AS "entryKey"
       FROM runtime.index_plan_entries
       WHERE project_id = $1::uuid AND index_plan_id = $2::uuid
       ORDER BY ordinal`,
      [ids.project, plan.indexPlanId],
    );
    const queued: string[] = [];
    for (const entry of entries.rows) {
      const requestId = randomUUID();
      const result = await worker.query<{ readonly state: string }>(
        `SELECT state FROM ops.request_projection_index_build($1::uuid, $2::uuid, $3, $4::uuid)`,
        [ids.project, plan.indexPlanId, entry.entryKey, requestId],
      );
      assert.equal(result.rows[0]?.state, "APPROVED");
      queued.push(requestId);
    }
    return queued;
  });
  assert.equal(requests.length, plan.indexCount);

  const ddlResults: Array<{
    readonly indexName: string;
    readonly observedBytes: string;
    readonly milliseconds: number;
  }> = [];
  for (const requestId of requests) {
    const startedAt = process.hrtime.bigint();
    const result = await withClient(ddlConfig, (ddl) =>
      executeProjectionDdlRequest(ddl, requestId),
    );
    ddlResults.push({
      indexName: result.indexName,
      observedBytes: result.observedBytes.toString(),
      milliseconds: Math.round(elapsedMilliseconds(startedAt)),
    });
  }

  const workerPool = new pg.Pool(workerConfig);
  let measurement: ProjectPhysicalInventoryMeasurement;
  let postbuildReport: CapacityReport;
  let linkPostbuildReport: CapacityReport;
  try {
    measurement = await scanAndRecordProjectPhysicalInventory(
      workerPool,
      projectionCapacityCrypto(),
      { projectId: ids.project, expectedInventoryRevision: plan.inventoryRevision },
    );
    plan.inventoryRevision = measurement.inventoryRevision;
    const repository = new PostgresProjectionCapacityAdmissionRepository(workerPool, (input) =>
      loadProjectionCapacitySnapshot(workerPool, plan, input.phase, input.generationId),
    );
    const service = new ProjectionCapacityAdmissionService({
      repository,
      crypto: projectionCapacityCrypto(),
    });
    postbuildReport = await service.admit({
      projectId: ids.project,
      generationId: ids.generation,
      phase: "POSTBUILD",
    });
    linkPostbuildReport = await service.admit({
      projectId: ids.project,
      generationId: ids.linkGeneration,
      phase: "POSTBUILD",
    });
  } finally {
    await workerPool.end();
  }
  samplePeakRss();

  assert.equal(postbuildReport.accepted, true);
  assert.equal(postbuildReport.observedProjectPhysicalBytes, measurement.totalRelationBytes);
  assert.equal(postbuildReport.measuredBytes >= measurement.totalRelationBytes, true);
  assert.equal(postbuildReport.peakReservedBytes < 12n * 1024n ** 3n, true);
  assert.equal(linkPostbuildReport.accepted, true);
  assert.equal(linkPostbuildReport.observedProjectPhysicalBytes, measurement.totalRelationBytes);
  const restagePool = new pg.Pool(apiConfig);
  try {
    const restaged = await new IndexPlanAdmissionService({
      repository: new PostgresIndexPlanAdmissionRepository(restagePool),
      crypto: projectionCapacityCrypto(),
    }).stageReleasePlan({ plan: projectionBenchmarkIndexPlan(), at: Date.now() });
    assert.equal(required(restaged.persistedPlans[0]).indexPlanId, plan.indexPlanId);
    assert.equal(required(restaged.persistedPlans[0]).reused, true);
  } finally {
    await restagePool.end();
  }
  const buildMilliseconds = elapsedMilliseconds(required(projectionBuildStartedAt));
  assert.equal(buildMilliseconds < 30 * 60 * 1_000, true);

  const metrics = await readProjectionBenchmarkMetrics(
    adminConfig,
    plan,
    measurement,
    containerName,
  );
  process.stdout.write(
    `CI_G2_02_09_PROJECTION_CAPACITY ${JSON.stringify({
      schemaVersion: 1,
      workload: { objectRows: capacityMetrics.objectRows, linkRows: capacityMetrics.linkRows },
      build: {
        state: "cold-empty-postgresql-container-and-data-layer",
        milliseconds: Math.round(buildMilliseconds),
        qualityCurrentMilliseconds: Math.round(qualityCurrentMilliseconds),
        ddlResults,
      },
      query: metrics.query,
      hardware: metrics.hardware,
      versions: metrics.versions,
      configuration: metrics.configuration,
      bytes: {
        wal: metrics.walBytes,
        projectHeap: measurement.heapBytes.toString(),
        projectIndex: measurement.indexBytes.toString(),
        projectToast: measurement.toastBytes.toString(),
        projectActual: measurement.totalRelationBytes.toString(),
        capacityMeasuredLowerBound: postbuildReport.measuredBytes.toString(),
        capacityReserved: postbuildReport.reservedBytes.toString(),
        capacityPeak: postbuildReport.peakReservedBytes.toString(),
        objectCurrentHeap: metrics.objectCurrentHeapBytes,
        objectCurrentIndexes: metrics.objectCurrentIndexBytes,
        linkCurrentHeap: metrics.linkCurrentHeapBytes,
        linkCurrentIndexes: metrics.linkCurrentIndexBytes,
        dynamicIndexes: metrics.dynamicIndexBytes,
      },
      memory: {
        peakNodeRssBytes: capacityMetrics.peakRssBytes,
        postgresContainerAtCompletionBytes: metrics.postgresContainerMemoryBytes,
        hostTotalBytes: totalmem(),
        hostFreeAtCompletionBytes: freemem(),
      },
      inventory: {
        revision: plan.inventoryRevision.toString(),
        relationCount: measurement.relationCount,
        measurementDigest: measurement.measurementDigest,
        prebuildPeakBytes: required(plan.prebuildReport).peakReservedBytes.toString(),
        lowerBoundCoversActual: postbuildReport.measuredBytes >= measurement.totalRelationBytes,
      },
    })}\n`,
  );
}

async function readProjectionBenchmarkMetrics(
  adminConfig: pg.ClientConfig,
  plan: ProjectionBenchmarkPlan,
  measurement: ProjectPhysicalInventoryMeasurement,
  containerName: string,
) {
  const databaseMetrics = await withClient(adminConfig, async (admin) => {
    const result = await admin.query<{
      readonly serverVersion: string;
      readonly walBytes: string;
      readonly objectRows: string;
      readonly linkRows: string;
      readonly objectCurrentHeapBytes: string;
      readonly objectCurrentIndexBytes: string;
      readonly linkCurrentHeapBytes: string;
      readonly linkCurrentIndexBytes: string;
      readonly dynamicIndexBytes: string;
      readonly configuration: Record<string, string>;
    }>(
      `SELECT current_setting('server_version') AS "serverVersion",
              pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::bigint::text AS "walBytes",
              (SELECT count(*)::text FROM runtime.object_current
                WHERE project_id = $2::uuid AND generation_id = $3::uuid) AS "objectRows",
              (SELECT count(*)::text FROM runtime.link_current
                WHERE project_id = $2::uuid AND generation_id = $4::uuid) AS "linkRows",
              pg_relation_size('runtime.object_current')::text AS "objectCurrentHeapBytes",
              pg_indexes_size('runtime.object_current')::text AS "objectCurrentIndexBytes",
              pg_relation_size('runtime.link_current')::text AS "linkCurrentHeapBytes",
              pg_indexes_size('runtime.link_current')::text AS "linkCurrentIndexBytes",
              COALESCE((SELECT sum(observed_bytes) FROM runtime.index_inventory
                WHERE project_id = $2::uuid AND state = 'ready'), 0)::text AS "dynamicIndexBytes",
              jsonb_build_object(
                'shared_buffers', current_setting('shared_buffers'),
                'work_mem', current_setting('work_mem'),
                'maintenance_work_mem', current_setting('maintenance_work_mem'),
                'effective_cache_size', current_setting('effective_cache_size'),
                'max_wal_size', current_setting('max_wal_size'),
                'checkpoint_timeout', current_setting('checkpoint_timeout'),
                'effective_io_concurrency', current_setting('effective_io_concurrency'),
                'random_page_cost', current_setting('random_page_cost'),
                'synchronous_commit', current_setting('synchronous_commit')
              ) AS configuration`,
      [capacityMetrics.walStart, ids.project, ids.generation, ids.linkGeneration],
    );
    const row = required(result.rows[0]);
    assert.equal(row.objectRows, String(capacityMetrics.objectRows));
    assert.equal(row.linkRows, String(capacityMetrics.linkRows));
    const query = await measureProjectionLookup(admin, plan);
    return { ...row, query };
  });
  assert.equal(measurement.totalRelationBytes > 0n, true);
  const containerMemory = parseDockerMemoryUsage(
    (
      await execFileAsync("docker", [
        "stats",
        "--no-stream",
        "--format",
        "{{.MemUsage}}",
        containerName,
      ])
    ).stdout,
  );
  return {
    ...databaseMetrics,
    postgresContainerMemoryBytes: containerMemory,
    hardware: {
      platform: platform(),
      arch: arch(),
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    versions: {
      node: process.version,
      postgres: databaseMetrics.serverVersion,
      s3: {
        implementation: "SeaweedFS",
        version: "4.41",
        image: capacityS3Image,
        exercised: false,
      },
      duckdb: {
        version: null,
        exercised: false,
        reason: "DuckDB is not a G2-02-09 production runtime dependency",
      },
    },
  };
}

async function measureProjectionLookup(admin: pg.Client, plan: ProjectionBenchmarkPlan) {
  const index = await admin.query<{ readonly indexName: string }>(
    `SELECT index_name AS "indexName"
     FROM runtime.index_plan_entries
     WHERE project_id = $1::uuid AND index_plan_id = $2::uuid AND recipe = 'BTREE_TEXT'`,
    [ids.project, plan.indexPlanId],
  );
  const indexName = required(index.rows[0]).indexName;
  const sql = `EXPLAIN (ANALYZE, COSTS OFF, FORMAT JSON)
    SELECT object_rid
    FROM runtime.object_current
    WHERE project_id = $1::uuid
      AND object_type_resource_id = $2::uuid
      AND object_type_revision_id = $3::uuid
      AND lifecycle_state = 'active'
      AND (properties #>> '{values,displayName,value}'::text[]) COLLATE "C" = $4
    ORDER BY (properties #>> '{values,displayName,value}'::text[]) COLLATE "C",
             canonical_primary_key COLLATE "C"
    LIMIT 1`;
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL enable_seqscan = off");
    const execute = async () => {
      const startedAt = process.hrtime.bigint();
      const explained = await admin.query<{ readonly "QUERY PLAN": unknown }>(sql, [
        ids.project,
        ids.objectResource,
        ids.objectRevision,
        `Order ${String(capacityMetrics.objectRows - 1)}`,
      ]);
      const text = JSON.stringify(explained.rows[0]?.["QUERY PLAN"]);
      assert.equal(text.includes(indexName), true);
      return Math.round(elapsedMilliseconds(startedAt) * 1_000) / 1_000;
    };
    const firstMilliseconds = await execute();
    const hotMilliseconds = await execute();
    return {
      firstState: "first-execution-after-cold-build-without-host-cache-drop",
      hotState: "same-index-second-execution",
      indexName,
      firstMilliseconds,
      hotMilliseconds,
    };
  } finally {
    await admin.query("ROLLBACK");
  }
}

function parseDockerMemoryUsage(value: string): number {
  const token = value.trim().split(/\s+/u)[0] ?? "";
  const match = /^(\d+(?:\.\d+)?)(B|KiB|MiB|GiB)$/u.exec(token);
  if (match === null) throw new Error(`Unexpected Docker memory value: ${value}`);
  const amount = Number(match[1]);
  const multiplier = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[
    match[2] as "B" | "KiB" | "MiB" | "GiB"
  ];
  return Math.round(amount * multiplier);
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
       FROM ops.claim_materialization_job_v2($1, $2, $3)`,
      [ids.worker1, ids.baseAttempt1, materializationLeaseSeconds],
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
    await admin.query("SELECT ops.reap_expired_materialization_jobs(32)");
    await admin.query(
      `UPDATE ops.materialization_jobs
       SET available_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE project_id = $1 AND job_id = $2 AND state = 'retry_wait'`,
      [ids.project, ids.job],
    );
  });

  const secondClaim = await withClient(worker2Config, async (worker) => {
    const result = await worker.query<{
      readonly job_id: string;
      readonly fencing_token: string;
    }>(
      `SELECT job_id, fencing_token::text
       FROM ops.claim_materialization_job_v2($1, $2, $3)`,
      [ids.worker2, ids.baseAttempt2, materializationLeaseSeconds],
    );
    assert.equal(result.rows[0]?.job_id, ids.job);
    return result.rows[0];
  });
  assert.ok(secondClaim);
  await using objectHeartbeat = projectionCapacityMode
    ? startCapacityHeartbeat(worker2Config, {
        projectId: ids.project,
        jobId: ids.job,
        attemptId: ids.baseAttempt2,
        workerInstanceId: ids.worker2,
        fencingToken: secondClaim.fencing_token,
      })
    : null;

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

  await exerciseObjectQuality(adminConfig, worker2Config, BigInt(secondClaim.fencing_token));
  await objectHeartbeat?.stop();

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
           heartbeat_at = NULL, result_code = 'SUCCEEDED', result_digest = $3,
           updated_at = clock_timestamp()
       WHERE project_id = $1 AND job_id = $2`,
      [ids.project, ids.job, digests.checkpoint],
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

async function exerciseObjectQuality(
  adminConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
  fencingToken: bigint,
): Promise<void> {
  const pool = new pg.Pool(workerConfig);
  try {
    const scopeProbe = await pool.query<{ readonly generation_id: string }>(
      `SELECT generation_id
       FROM ops.get_materialization_quality_scope($1, $2, $3, $4, $5)`,
      [ids.project, ids.job, ids.baseAttempt2, fencingToken.toString(), ids.generation],
    );
    assert.equal(scopeProbe.rows[0]?.generation_id, ids.generation);
    const repository = new PostgresMaterializationQualityRepository(pool);
    const randomIds = [ids.report];
    const service = new MaterializationQualityService({
      repository,
      overlays: {
        inspect() {
          return Promise.resolve({ state: "known" as const, rowCount: 0 });
        },
      },
      artifacts: {
        putVersion() {
          return Promise.reject(new Error("a passing quality run has no rejected artifact"));
        },
      },
      crypto: {
        randomId() {
          const value = randomIds.shift();
          if (value === undefined) throw new Error("quality fixture exhausted IDs");
          return value;
        },
        digestCanonicalText: sha256Artifact,
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
      },
      clock: { now: () => parseCanonicalInstant("2026-08-16T00:00:00.000000Z") },
    });
    const qualityPlan = capacityObjectMappingPlan();
    if (qualityPlan.targetKind !== "object") throw new Error("quality fixture must be Object");
    const provenanceTemplates = provenanceTemplatesFromPlan(qualityPlan, {
      digestCanonicalText: sha256Artifact,
    });
    assert.deepEqual(
      provenanceTemplates.map(({ propertyApiName, inputColumnOrdinal }) => ({
        propertyApiName,
        inputColumnOrdinal,
      })),
      [
        { propertyApiName: "displayName", inputColumnOrdinal: 1 },
        { propertyApiName: "orderId", inputColumnOrdinal: 0 },
      ],
    );
    await withClient(adminConfig, async (admin) => {
      const basePropertyShape = await admin.query<{ readonly property_names: string[] }>(
        `SELECT ARRAY(
           SELECT property_name
           FROM jsonb_object_keys(base.properties -> 'values') AS property_name
           ORDER BY property_name COLLATE "C"
         ) AS property_names
         FROM runtime.object_base AS base
         WHERE base.project_id = $1 AND base.generation_id = $2
         ORDER BY base.object_rid
         LIMIT 1`,
        [ids.project, ids.generation],
      );
      assert.deepEqual(basePropertyShape.rows[0]?.property_names, ["displayName", "orderId"]);
    });
    const result = await service.build({
      scope: {
        projectId: ids.project,
        jobId: ids.job,
        attemptId: ids.baseAttempt2,
        fencingToken,
      },
      generationId: ids.generation,
      provenanceTemplates,
    });
    assert.equal(result.outcome, "passed");
    assert.equal(result.reportId, ids.report);
    await withClient(adminConfig, async (admin) => {
      const state = await admin.query<{
        readonly current_rows: number;
        readonly provenance_rows: number;
        readonly candidates: number;
        readonly report_rows: string;
        readonly generation_state: string;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM runtime.object_current
             WHERE project_id = $1 AND generation_id = $2) AS current_rows,
           (SELECT count(*)::integer FROM runtime.property_provenance
             WHERE project_id = $1 AND generation_id = $2) AS provenance_rows,
           (SELECT count(*)::integer FROM runtime.object_head_candidates
             WHERE project_id = $1 AND generation_id = $2) AS candidates,
           report.accepted_rows::text AS report_rows,
           generation.state AS generation_state
         FROM runtime.generations AS generation
         JOIN runtime.materialization_reports AS report
           ON report.project_id = generation.project_id
          AND report.report_id = generation.report_id
         WHERE generation.project_id = $1 AND generation.generation_id = $2`,
        [ids.project, ids.generation],
      );
      assert.deepEqual(state.rows[0], {
        current_rows: capacityMetrics.objectRows,
        provenance_rows: capacityMetrics.objectRows * 2,
        candidates: capacityMetrics.objectRows,
        report_rows: String(capacityMetrics.objectRows),
        generation_state: "building",
      });
    });
    const candidate = await pool.query<{ readonly object_rid: string }>(
      `SELECT object_rid::text
       FROM runtime.read_object_current_candidate($1, $2, $3, $4, NULL, 1)`,
      [ids.project, ids.generation, ids.objectResource, ids.objectRevision],
    );
    assert.equal(candidate.rows.length, capacityMetrics.objectRows === 0 ? 0 : 1);
    await assertPgCode(
      pool.query(`SELECT * FROM runtime.read_object_current_candidate($1, $2, $3, $4, NULL, 1)`, [
        ids.otherProject,
        ids.generation,
        ids.objectResource,
        ids.objectRevision,
      ]),
      "42501",
    );
  } finally {
    await pool.end();
  }
}

async function exerciseQualityCurrentAndRequiredDangling(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
): Promise<void> {
  const activationBefore = await withClient(adminConfig, (admin) =>
    activationSnapshot(admin, ids.activation0),
  );
  await withClient(adminConfig, prepareQualityCurrentFacts);
  const claim = await withClient(workerConfig, async (worker) => {
    const result = await worker.query<{ readonly fencing_token: string }>(
      `SELECT fencing_token::text
       FROM ops.claim_materialization_job_v2($1, $2, 300)`,
      [ids.worker2, ids.qualityAttempt],
    );
    return result.rows[0];
  });
  assert.ok(claim);
  const fencingToken = BigInt(claim.fencing_token);
  const scope = Object.freeze({
    projectId: ids.project,
    jobId: ids.qualityJob,
    attemptId: ids.qualityAttempt,
    fencingToken,
  });
  const pool = new pg.Pool(workerConfig);
  const objectUploads: QualityUploadRecord[] = [];
  const linkUploads: QualityUploadRecord[] = [];
  try {
    const base = baseService(pool);
    const objectRows = Array.from({ length: qualityObjectRows - 1 }, (_, index) =>
      baseObjectRow(index + 1, `quality-order-${String(index + 1)}`),
    );
    const objectReceipt = await base.stageObjectBatch({
      scope,
      generation: Object.freeze({
        generationId: ids.qualityObjectGeneration,
        targetResourceId: ids.objectResource,
        targetRevisionId: ids.objectRevision,
        sourceSnapshotId: ids.qualityObjectSnapshot,
        sourceFileId: ids.qualityObjectFile,
        mappingRevisionId: ids.mappingRevision,
      }),
      batchSequence: 1,
      rows: objectRows,
    });
    await pool.query(`SELECT * FROM runtime.resolve_or_create_object_identities($1, $2::jsonb)`, [
      ids.project,
      JSON.stringify([
        {
          ordinal: 0,
          objectTypeResourceId: ids.objectResource,
          canonicalPrimaryKey: canonicalizePrimaryKey(
            [`quality-order-${String(qualityObjectRows)}`],
            { components: [{ type: "string" as const, caseSensitive: false }] },
          ),
          candidateObjectRid: randomUUID(),
        },
      ]),
    ]);
    await base.promoteGenerationBase({
      scope,
      generationId: ids.qualityObjectGeneration,
      expectedRowCount: qualityObjectRows - 1,
      batchReceipts: [objectReceipt],
    });
    await assertPgCode(
      pool.query(`SELECT * FROM runtime.read_object_current_candidate($1, $2, $3, $4, NULL, 1)`, [
        ids.project,
        ids.qualityObjectGeneration,
        ids.objectResource,
        ids.objectRevision,
      ]),
      "42501",
    );

    const quality = postgresQualityService(
      pool,
      [ids.qualityObjectReport, ids.qualityObjectRejectedSet, ids.qualityObjectRejectedArtifact],
      objectUploads,
    );
    await quality.stageObservations({
      scope,
      generationId: ids.qualityObjectGeneration,
      observations: [
        Object.freeze({
          fileId: ids.qualityObjectFile,
          rowNumber: qualityObjectRows,
          reasonCode: "OPTIONAL_PROPERTY_INVALID" as const,
          fingerprint: sha256Artifact("quality-object-optional-row-1000"),
          columnClassification: "redacted" as const,
          phase: "mapping" as const,
        }),
      ],
    });
    const objectPlan = capacityObjectMappingPlan();
    if (objectPlan.targetKind !== "object") throw new Error("quality Object plan required");
    const provenanceTemplates = provenanceTemplatesFromPlan(objectPlan, {
      digestCanonicalText: sha256Artifact,
    });
    await assert.rejects(
      postgresQualityService(pool, [], []).build({
        scope,
        generationId: ids.qualityObjectGeneration,
        provenanceTemplates: provenanceTemplates.map((template) =>
          Object.freeze({ ...template, inputColumnOrdinal: 99 }),
        ),
      }),
      (error: unknown) =>
        error instanceof MaterializationQualityError && error.code === "QUALITY_REQUEST_INVALID",
    );
    const objectResult = await quality.build({
      scope,
      generationId: ids.qualityObjectGeneration,
      provenanceTemplates,
    });
    assert.equal(objectResult.outcome, "passed");
    assert.equal(objectUploads.length, 1);
    assert.match(objectUploads[0]?.body ?? "", /OPTIONAL_PROPERTY_INVALID/u);
    assert.doesNotMatch(objectUploads[0]?.body ?? "", /quality-order|displayName/iu);

    const candidate = await pool.query<{ readonly object_rid: string }>(
      `SELECT object_rid::text
       FROM runtime.read_object_current_candidate($1, $2, $3, $4, NULL, 1)`,
      [ids.project, ids.qualityObjectGeneration, ids.objectResource, ids.objectRevision],
    );
    assert.equal(candidate.rows.length, 1);
    await assertPgCode(
      pool.query(`SELECT * FROM runtime.read_object_current_candidate($1, $2, $3, $4, NULL, 1)`, [
        ids.otherProject,
        ids.qualityObjectGeneration,
        ids.objectResource,
        ids.objectRevision,
      ]),
      "42501",
    );

    const linkReceipt = await base.stageLinkBatch({
      scope,
      generation: Object.freeze({
        generationId: ids.qualityLinkGeneration,
        targetResourceId: ids.linkResource,
        targetRevisionId: ids.linkRevision,
        sourceSnapshotId: ids.qualityLinkSnapshot,
        sourceFileId: ids.qualityLinkFile,
        mappingRevisionId: ids.linkMappingRevision,
      }),
      batchSequence: 2,
      rows: [
        baseLinkRow(
          1,
          "quality-order-1",
          `quality-order-${String(qualityObjectRows)}`,
          false,
          false,
        ),
      ],
    });
    assert.equal(linkReceipt.stagedRowCount, 1);
    await base.promoteGenerationBase({
      scope,
      generationId: ids.qualityLinkGeneration,
      expectedRowCount: 1,
      batchReceipts: [linkReceipt],
    });
    const linkResult = await postgresQualityService(
      pool,
      [ids.qualityLinkReport, ids.qualityLinkRejectedSet, ids.qualityLinkRejectedArtifact],
      linkUploads,
    ).build({
      scope,
      generationId: ids.qualityLinkGeneration,
      provenanceTemplates: [],
    });
    assert.equal(linkResult.outcome, "failed");
    assert.equal(linkUploads.length, 1);
    assert.match(linkUploads[0]?.body ?? "", /REQUIRED_LINK_DANGLING/u);
    assert.doesNotMatch(linkUploads[0]?.body ?? "", /quality-order/iu);
    await assertPgCode(
      pool.query(`SELECT * FROM runtime.read_link_current_candidate($1, $2, $3, $4, NULL, 1)`, [
        ids.project,
        ids.qualityLinkGeneration,
        ids.linkResource,
        ids.linkRevision,
      ]),
      "42501",
    );
  } finally {
    await pool.end();
  }

  await withClient(adminConfig, async (admin) => {
    const state = await admin.query<{
      readonly object_current: number;
      readonly provenance: number;
      readonly object_rejected: string;
      readonly object_reason: string;
      readonly link_current: number;
      readonly link_reason: string;
      readonly link_state: string;
      readonly old_generation_state: string;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM runtime.object_current
           WHERE project_id = $1 AND generation_id = $2) AS object_current,
         (SELECT count(*)::integer FROM runtime.property_provenance
           WHERE project_id = $1 AND generation_id = $2) AS provenance,
         (SELECT rejected_rows::text FROM runtime.materialization_reports
           WHERE project_id = $1 AND report_id = $3) AS object_rejected,
         (SELECT reason_code FROM runtime.materialization_report_reasons
           WHERE project_id = $1 AND report_id = $3) AS object_reason,
         (SELECT count(*)::integer FROM runtime.link_current
           WHERE project_id = $1 AND generation_id = $4) AS link_current,
         (SELECT reason_code FROM runtime.materialization_report_reasons
           WHERE project_id = $1 AND report_id = $5) AS link_reason,
         (SELECT state FROM runtime.generations
           WHERE project_id = $1 AND generation_id = $4) AS link_state,
         (SELECT state FROM runtime.generations
           WHERE project_id = $1 AND generation_id = $6) AS old_generation_state`,
      [
        ids.project,
        ids.qualityObjectGeneration,
        ids.qualityObjectReport,
        ids.qualityLinkGeneration,
        ids.qualityLinkReport,
        ids.generation,
      ],
    );
    assert.deepEqual(state.rows[0], {
      object_current: qualityObjectRows - 1,
      provenance: (qualityObjectRows - 1) * 2,
      object_rejected: "1",
      object_reason: "OPTIONAL_PROPERTY_INVALID",
      link_current: 0,
      link_reason: "REQUIRED_LINK_DANGLING",
      link_state: "failed",
      old_generation_state: "ready",
    });
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL enable_seqscan = off");
      const explain = await admin.query<{ readonly "QUERY PLAN": string }>(
        `EXPLAIN (COSTS OFF)
         SELECT object_rid
         FROM runtime.object_current
         WHERE project_id = $1 AND generation_id = $2
           AND object_type_resource_id = $3 AND object_type_revision_id = $4
           AND object_rid > $5
         ORDER BY object_rid
         LIMIT 100`,
        [
          ids.project,
          ids.qualityObjectGeneration,
          ids.objectResource,
          ids.objectRevision,
          "00000000-0000-4000-8000-000000000000",
        ],
      );
      const plan = explain.rows.map((row) => row["QUERY PLAN"]).join("\n");
      assert.match(plan, /Index (?:Only )?Scan/u);
      assert.doesNotMatch(plan, /Seq Scan/u);
    } finally {
      await admin.query("ROLLBACK");
    }
    await admin.query(
      `UPDATE ops.materialization_attempts
       SET state = 'failed', finished_at = clock_timestamp(), result_code = 'QUALITY_FAILED'
       WHERE project_id = $1 AND attempt_id = $2 AND state = 'leased'`,
      [ids.project, ids.qualityAttempt],
    );
    await admin.query(
      `UPDATE ops.materialization_jobs
       SET state = 'dead_letter', lease_owner_id = NULL, lease_expires_at = NULL,
           heartbeat_at = NULL, result_code = 'QUALITY_FAILED', updated_at = clock_timestamp()
       WHERE project_id = $1 AND job_id = $2`,
      [ids.project, ids.qualityJob],
    );
  });
  await exerciseRowCountConfirmations(adminConfig, apiConfig, workerConfig);
  assert.deepEqual(
    await withClient(adminConfig, (admin) => activationSnapshot(admin, ids.activation0)),
    activationBefore,
  );
}

async function exerciseRowCountConfirmations(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
): Promise<void> {
  const v2: QualityObjectVersionFixture = Object.freeze({
    groupVersion: 2,
    rowCount: 500,
    snapshotId: ids.qualityObjectSnapshotV2,
    fileId: ids.qualityObjectFileV2,
    managedArtifactId: ids.qualityObjectArtifactV2,
    generationId: ids.qualityObjectGenerationV2,
    jobId: ids.qualityJobV2,
    attemptId: ids.qualityAttemptV2,
    reportId: ids.qualityObjectReportV2,
    previousSnapshotId: ids.qualityObjectSnapshot,
  });
  await withClient(adminConfig, (admin) => prepareQualityObjectVersion(admin, v2));
  const v2Result = await buildQualityObjectVersion(workerConfig, v2);
  assert.equal(v2Result.outcome, "awaiting_confirmation");

  const apiPool = new pg.Pool(apiConfig);
  try {
    const repository = new PostgresMaterializationQualityRepository(apiPool);
    const staleScope = await repository.getConfirmationScope({
      projectId: ids.project,
      generationId: v2.generationId,
    });
    const publicationLock = new pg.Client(adminConfig);
    await publicationLock.connect();
    try {
      await publicationLock.query("BEGIN");
      await publicationLock.query(`SELECT 1 FROM meta.projects WHERE project_id = $1 FOR UPDATE`, [
        ids.project,
      ]);
      const racePool = new pg.Pool({
        ...apiConfig,
        options: "-c lock_timeout=200ms",
      });
      try {
        const raceRepository = new PostgresMaterializationQualityRepository(racePool);
        await assert.rejects(
          raceRepository.recordRowCountConfirmation({
            ...staleScope,
            confirmationId: ids.qualityConfirmationV2Race,
            actorPrincipalId: ids.principal,
            decision: "accepted",
            expiresAt: futureCanonicalInstant(15),
            confirmationDigest: sha256Artifact("racing-row-count-confirmation-v2"),
          }),
          (error: unknown) =>
            error instanceof MaterializationQualityError && error.code === "DEPENDENCY_UNAVAILABLE",
        );
      } finally {
        await racePool.end();
      }
    } finally {
      await publicationLock.query("ROLLBACK");
      await publicationLock.end();
    }
    await withClient(adminConfig, async (admin) => {
      await admin.query(
        `UPDATE meta.projects
         SET publication_sequence = publication_sequence + 1,
             changed_at = clock_timestamp()
         WHERE project_id = $1`,
        [ids.project],
      );
    });
    await assert.rejects(
      repository.recordRowCountConfirmation({
        ...staleScope,
        confirmationId: ids.qualityConfirmationV2Stale,
        actorPrincipalId: ids.principal,
        decision: "accepted",
        expiresAt: futureCanonicalInstant(15),
        confirmationDigest: sha256Artifact("stale-row-count-confirmation-v2"),
      }),
      (error: unknown) =>
        error instanceof MaterializationQualityError &&
        error.code === "QUALITY_CONFIRMATION_INVALID",
    );
    const currentScope = await repository.getConfirmationScope({
      projectId: ids.project,
      generationId: v2.generationId,
    });
    assert.equal(
      currentScope.publicationControlSequence,
      staleScope.publicationControlSequence + 1n,
    );
    const accepted = await postgresRowCountConfirmationService(
      repository,
      ids.qualityConfirmationV2,
    ).confirm(qualityVerifiedIdentity(), {
      projectId: ids.project,
      generationId: v2.generationId,
      expectedReportDigest: v2Result.reportDigest,
      expectedPublicationControlSequence: currentScope.publicationControlSequence,
      decision: "accepted",
    });
    assert.equal(accepted.outcome, "passed");
  } finally {
    await apiPool.end();
  }
  await withClient(adminConfig, async (admin) => {
    await finishQualityObjectJob(admin, v2, "succeeded");
    await admin.query(
      `UPDATE runtime.generations SET state = 'ready', changed_at = clock_timestamp()
       WHERE project_id = $1 AND generation_id = $2`,
      [ids.project, v2.generationId],
    );
  });

  const v3: QualityObjectVersionFixture = Object.freeze({
    groupVersion: 3,
    rowCount: 1,
    snapshotId: ids.qualityObjectSnapshotV3,
    fileId: ids.qualityObjectFileV3,
    managedArtifactId: ids.qualityObjectArtifactV3,
    generationId: ids.qualityObjectGenerationV3,
    jobId: ids.qualityJobV3,
    attemptId: ids.qualityAttemptV3,
    reportId: ids.qualityObjectReportV3,
    previousSnapshotId: ids.qualityObjectSnapshotV2,
  });
  await withClient(adminConfig, (admin) => prepareQualityObjectVersion(admin, v3));
  const v3Result = await buildQualityObjectVersion(workerConfig, v3);
  assert.equal(v3Result.outcome, "awaiting_confirmation");
  const rejectionPool = new pg.Pool(apiConfig);
  try {
    const repository = new PostgresMaterializationQualityRepository(rejectionPool);
    const current = await repository.getConfirmationScope({
      projectId: ids.project,
      generationId: v3.generationId,
    });
    const rejected = await postgresRowCountConfirmationService(
      repository,
      ids.qualityConfirmationV3,
    ).confirm(qualityVerifiedIdentity(), {
      projectId: ids.project,
      generationId: v3.generationId,
      expectedReportDigest: v3Result.reportDigest,
      expectedPublicationControlSequence: current.publicationControlSequence,
      decision: "rejected",
    });
    assert.equal(rejected.outcome, "failed");
  } finally {
    await rejectionPool.end();
  }
  await withClient(adminConfig, async (admin) => {
    await finishQualityObjectJob(admin, v3, "dead_letter");
    const state = await admin.query<{
      readonly accepted_binding: string;
      readonly accepted_generation: string;
      readonly rejected_binding: string;
      readonly rejected_generation: string;
      readonly confirmation_count: number;
    }>(
      `SELECT
         (SELECT state FROM runtime.materialization_quality_bindings
           WHERE project_id = $1 AND generation_id = $2) AS accepted_binding,
         (SELECT state FROM runtime.generations
           WHERE project_id = $1 AND generation_id = $2) AS accepted_generation,
         (SELECT state FROM runtime.materialization_quality_bindings
           WHERE project_id = $1 AND generation_id = $3) AS rejected_binding,
         (SELECT state FROM runtime.generations
           WHERE project_id = $1 AND generation_id = $3) AS rejected_generation,
         (SELECT count(*)::integer FROM runtime.materialization_confirmations
           WHERE project_id = $1 AND generation_id IN ($2, $3)) AS confirmation_count`,
      [ids.project, v2.generationId, v3.generationId],
    );
    assert.deepEqual(state.rows[0], {
      accepted_binding: "confirmed",
      accepted_generation: "ready",
      rejected_binding: "failed",
      rejected_generation: "failed",
      confirmation_count: 2,
    });
  });
}

interface QualityObjectVersionFixture {
  readonly groupVersion: number;
  readonly rowCount: number;
  readonly snapshotId: string;
  readonly fileId: string;
  readonly managedArtifactId: string;
  readonly generationId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly reportId: string;
  readonly previousSnapshotId: string;
}

async function prepareQualityObjectVersion(
  client: pg.Client,
  fixture: QualityObjectVersionFixture,
): Promise<void> {
  const runtimePlanDigest = sha256Digest(
    `quality-object-runtime-plan-v${String(fixture.groupVersion)}`,
  );
  const contentDigest = sha256Digest(`quality-object-content-v${String(fixture.groupVersion)}`);
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO runtime.snapshot_group_versions
       (project_id, snapshot_group_id, group_version, member_count, group_digest)
     VALUES ($1, $2, $3, 1, $4)`,
    [
      ids.project,
      ids.qualityGroup,
      fixture.groupVersion,
      sha256Digest(`quality-group-v${String(fixture.groupVersion)}`),
    ],
  );
  await client.query(
    `INSERT INTO runtime.dataset_snapshots (
       project_id, snapshot_id, snapshot_group_id, group_version,
       member_key, member_kind, target_resource_id, target_revision_id,
       snapshot_schema_resource_id, snapshot_schema_revision_id,
       mapping_resource_id, mapping_revision_id, runtime_plan_digest,
       content_digest, byte_count, row_count, file_count, previous_snapshot_id,
       snapshot_digest
     ) VALUES (
       $1, $2, $3, $4, 'object:Order', 'object', $5, $6, $7, $8, $9, $10,
       $11, $12, 0, $13, 1, $14, $15
     )`,
    [
      ids.project,
      fixture.snapshotId,
      ids.qualityGroup,
      fixture.groupVersion,
      ids.objectResource,
      ids.objectRevision,
      ids.schemaResource,
      ids.schemaRevision,
      ids.mappingResource,
      ids.mappingRevision,
      runtimePlanDigest,
      contentDigest,
      fixture.rowCount,
      fixture.previousSnapshotId,
      sha256Digest(`quality-object-snapshot-v${String(fixture.groupVersion)}`),
    ],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_files (
       project_id, snapshot_id, file_id, managed_artifact_id, object_version,
       ordinal, content_digest, byte_count, row_count, source_label, scan_status
     ) VALUES ($1, $2, $3, $4, $5, 0, $6, 0, $7,
               'G2-02-07 row-count fixture', 'complete')`,
    [
      ids.project,
      fixture.snapshotId,
      fixture.fileId,
      fixture.managedArtifactId,
      `quality-object-version-${String(fixture.groupVersion)}`,
      contentDigest,
      fixture.rowCount,
    ],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_group_members (
       project_id, snapshot_group_id, group_version, member_key, member_kind,
       snapshot_id, target_resource_id, target_revision_id
     ) VALUES ($1, $2, $3, 'object:Order', 'object', $4, $5, $6)`,
    [
      ids.project,
      ids.qualityGroup,
      fixture.groupVersion,
      fixture.snapshotId,
      ids.objectResource,
      ids.objectRevision,
    ],
  );
  await client.query("COMMIT");
  for (const state of ["validated", "materializing", "ready"] as const) {
    await client.query(
      `UPDATE runtime.snapshot_group_versions
       SET state = $4, changed_at = clock_timestamp()
       WHERE project_id = $1 AND snapshot_group_id = $2 AND group_version = $3`,
      [ids.project, ids.qualityGroup, fixture.groupVersion, state],
    );
    await client.query(
      `UPDATE runtime.dataset_snapshots
       SET state = $3, changed_at = clock_timestamp()
       WHERE project_id = $1 AND snapshot_id = $2`,
      [ids.project, fixture.snapshotId, state],
    );
  }
  await client.query(
    `INSERT INTO ops.materialization_jobs
       (project_id, job_id, snapshot_group_id, group_version, idempotency_key, input_digest)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ids.project,
      fixture.jobId,
      ids.qualityGroup,
      fixture.groupVersion,
      `g2-02-07-quality-job-v${String(fixture.groupVersion)}`,
      sha256Digest(`quality-job-v${String(fixture.groupVersion)}`),
    ],
  );
  await client.query(
    `INSERT INTO runtime.generations (
       project_id, generation_id, member_key, member_kind,
       target_resource_id, target_revision_id, snapshot_id, snapshot_group_id, group_version,
       snapshot_schema_resource_id, snapshot_schema_revision_id,
       mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest
     ) VALUES (
       $1, $2, 'object:Order', 'object', $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13
     )`,
    [
      ids.project,
      fixture.generationId,
      ids.objectResource,
      ids.objectRevision,
      fixture.snapshotId,
      ids.qualityGroup,
      fixture.groupVersion,
      ids.schemaResource,
      ids.schemaRevision,
      ids.mappingResource,
      ids.mappingRevision,
      runtimePlanDigest,
      runtimeObjectIndexPlanDigest(),
    ],
  );
}

async function buildQualityObjectVersion(
  workerConfig: pg.ClientConfig,
  fixture: QualityObjectVersionFixture,
) {
  const claim = await withClient(workerConfig, async (worker) => {
    const result = await worker.query<{ readonly fencing_token: string }>(
      `SELECT fencing_token::text
       FROM ops.claim_materialization_job_v2($1, $2, 300)`,
      [ids.worker2, fixture.attemptId],
    );
    return result.rows[0];
  });
  assert.ok(claim);
  const scope = Object.freeze({
    projectId: ids.project,
    jobId: fixture.jobId,
    attemptId: fixture.attemptId,
    fencingToken: BigInt(claim.fencing_token),
  });
  const pool = new pg.Pool(workerConfig);
  try {
    const base = baseService(pool);
    const receipt = await base.stageObjectBatch({
      scope,
      generation: Object.freeze({
        generationId: fixture.generationId,
        targetResourceId: ids.objectResource,
        targetRevisionId: ids.objectRevision,
        sourceSnapshotId: fixture.snapshotId,
        sourceFileId: fixture.fileId,
        mappingRevisionId: ids.mappingRevision,
      }),
      batchSequence: 1,
      rows: Array.from({ length: fixture.rowCount }, (_, index) =>
        baseObjectRow(index + 1, `quality-order-${String(index + 1)}`),
      ),
    });
    await base.promoteGenerationBase({
      scope,
      generationId: fixture.generationId,
      expectedRowCount: fixture.rowCount,
      batchReceipts: [receipt],
    });
    const plan = capacityObjectMappingPlan();
    if (plan.targetKind !== "object") throw new Error("quality Object plan required");
    return await postgresQualityService(pool, [fixture.reportId], []).build({
      scope,
      generationId: fixture.generationId,
      provenanceTemplates: provenanceTemplatesFromPlan(plan, {
        digestCanonicalText: sha256Artifact,
      }),
    });
  } finally {
    await pool.end();
  }
}

function postgresRowCountConfirmationService(
  repository: PostgresMaterializationQualityRepository,
  confirmationId: string,
): RowCountConfirmationService {
  return new RowCountConfirmationService({
    principals: {
      resolveVerifiedIdentity() {
        return Promise.resolve({
          principalId: ids.principal,
          issuer: "https://issuer.db02.test",
          subject: "db02-owner",
          displayName: "DB-02 Owner",
          state: "active" as const,
        });
      },
    },
    authorizer: {
      authorize(_identity, request) {
        assert.equal(request.projectId, ids.project);
        assert.equal(request.permission, "release.publish");
        return Promise.resolve(true);
      },
    },
    repository,
    crypto: {
      randomId: () => confirmationId,
      digestCanonicalText: sha256Artifact,
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
    },
    clock: { now: currentCanonicalInstant },
  });
}

function qualityVerifiedIdentity() {
  return Object.freeze({
    issuer: "https://issuer.db02.test",
    subject: "db02-owner",
    displayName: "DB-02 Owner",
    claimsFingerprint: sha256Artifact("quality-owner-claims"),
    authenticatedAt: currentCanonicalInstant(),
  });
}

function futureCanonicalInstant(minutes: number) {
  return parseCanonicalInstant(
    new Date(Date.now() + minutes * 60_000).toISOString().replace(/Z$/u, "000Z"),
  );
}

async function finishQualityObjectJob(
  client: pg.Client,
  fixture: QualityObjectVersionFixture,
  state: "succeeded" | "dead_letter",
): Promise<void> {
  await client.query(
    `UPDATE ops.materialization_attempts
     SET state = $3, finished_at = clock_timestamp(), result_code = $4
     WHERE project_id = $1 AND attempt_id = $2 AND state = 'leased'`,
    [
      ids.project,
      fixture.attemptId,
      state === "succeeded" ? "completed" : "failed",
      state === "succeeded" ? "QUALITY_CONFIRMED" : "QUALITY_REJECTED",
    ],
  );
  await client.query(
    `UPDATE ops.materialization_jobs
     SET state = $3, lease_owner_id = NULL, lease_expires_at = NULL,
         heartbeat_at = NULL, result_code = $4, result_digest = $5,
         updated_at = clock_timestamp()
     WHERE project_id = $1 AND job_id = $2`,
    [
      ids.project,
      fixture.jobId,
      state,
      state === "succeeded" ? "SUCCEEDED" : "QUALITY_REJECTED",
      state === "succeeded" ? sha256Artifact(`quality-job-${fixture.jobId}`) : null,
    ],
  );
}

interface QualityUploadRecord {
  readonly objectKey: string;
  readonly body: string;
  readonly mediaType: string;
}

function postgresQualityService(
  pool: pg.Pool,
  randomIds: string[],
  uploads: QualityUploadRecord[],
): MaterializationQualityService {
  return new MaterializationQualityService({
    repository: new PostgresMaterializationQualityRepository(pool),
    overlays: {
      inspect() {
        return Promise.resolve({ state: "known" as const, rowCount: 0 });
      },
    },
    artifacts: {
      async putVersion(input) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of input.body) chunks.push(chunk);
        const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
        assert.equal(Buffer.byteLength(body), input.expectedByteCount);
        uploads.push({ objectKey: input.objectKey, body, mediaType: input.mediaType });
        return {
          versionId: `quality-version-${String(uploads.length)}`,
          byteCount: input.expectedByteCount,
          mediaType: input.mediaType,
        };
      },
    },
    crypto: {
      randomId() {
        const value = randomIds.shift();
        if (value === undefined) throw new Error("quality fixture exhausted IDs");
        return value;
      },
      digestCanonicalText: sha256Artifact,
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
    },
    clock: { now: currentCanonicalInstant },
  });
}

function currentCanonicalInstant() {
  return parseCanonicalInstant(new Date().toISOString().replace(/Z$/u, "000Z"));
}

async function prepareQualityCurrentFacts(client: pg.Client): Promise<void> {
  const linkSchema = qualityLinkSchemaDefinition();
  const linkMapping = qualityLinkMappingDefinition();
  if (!projectionCapacityMode) {
    await createPublishedResource(client, {
      resourceId: ids.linkSchemaResource,
      revisionId: ids.linkSchemaRevision,
      reportId: ids.linkSchemaValidation,
      family: "snapshot_schema",
      apiName: "QualityLinkCsvSchema",
      contentDigest: definitionDigest(linkSchema),
      content: linkSchema,
    });
    await createPublishedResource(client, {
      resourceId: ids.linkMappingResource,
      revisionId: ids.linkMappingRevision,
      reportId: ids.linkMappingValidation,
      family: "mapping",
      apiName: "QualityLinkCsvMapping",
      contentDigest: definitionDigest(linkMapping),
      content: linkMapping,
    });
  }
  const linkIndexDigest = sha256Digest("quality-link-index-plan");
  const runtimePlanDigest = sha256Digest("quality-object-link-runtime-plan");
  const objectContentDigest = sha256Digest("quality-object-snapshot-content");
  const linkContentDigest = sha256Digest("quality-link-snapshot-content");
  await client.query(
    `INSERT INTO runtime.index_plans
       (project_id, index_plan_id, target_resource_id, target_revision_id,
        plan_digest, entry_count, compiler_version)
     VALUES ($1, $2, $3, $4, $5, 0, 'index-plan-g2-02-v1')`,
    [ids.project, ids.qualityLinkIndexPlan, ids.linkResource, ids.linkRevision, linkIndexDigest],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_groups (project_id, snapshot_group_id, group_key)
     VALUES ($1, $2, 'quality-object-links')`,
    [ids.project, ids.qualityGroup],
  );
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO runtime.snapshot_group_versions
       (project_id, snapshot_group_id, group_version, member_count, group_digest)
     VALUES ($1, $2, 1, 2, $3)`,
    [ids.project, ids.qualityGroup, sha256Digest("quality-group-v1")],
  );
  await client.query(
    `INSERT INTO runtime.dataset_snapshots (
       project_id, snapshot_id, snapshot_group_id, group_version,
       member_key, member_kind, target_resource_id, target_revision_id,
       snapshot_schema_resource_id, snapshot_schema_revision_id,
       mapping_resource_id, mapping_revision_id, runtime_plan_digest,
       content_digest, byte_count, row_count, file_count, snapshot_digest
     ) VALUES
       ($1, $2, $3, 1, 'object:Order', 'object', $4, $5, $6, $7, $8, $9,
        $10, $11, 0, $12, 1, $13),
       ($1, $14, $3, 1, 'link:OrderRelation', 'link', $15, $16, $17, $18, $19, $20,
        $10, $21, 0, 1, 1, $22)`,
    [
      ids.project,
      ids.qualityObjectSnapshot,
      ids.qualityGroup,
      ids.objectResource,
      ids.objectRevision,
      ids.schemaResource,
      ids.schemaRevision,
      ids.mappingResource,
      ids.mappingRevision,
      runtimePlanDigest,
      objectContentDigest,
      qualityObjectRows,
      sha256Digest("quality-object-snapshot-v1"),
      ids.qualityLinkSnapshot,
      ids.linkResource,
      ids.linkRevision,
      ids.linkSchemaResource,
      ids.linkSchemaRevision,
      ids.linkMappingResource,
      ids.linkMappingRevision,
      linkContentDigest,
      sha256Digest("quality-link-snapshot-v1"),
    ],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_files (
       project_id, snapshot_id, file_id, managed_artifact_id, object_version,
       ordinal, content_digest, byte_count, row_count, source_label, scan_status
     ) VALUES
       ($1, $2, $3, $4, 'quality-object-version-1', 0, $5, 0, $6,
        'G2-02-07 Object quality fixture', 'complete'),
       ($1, $7, $8, $9, 'quality-link-version-1', 0, $10, 0, 1,
        'G2-02-07 Link quality fixture', 'complete')`,
    [
      ids.project,
      ids.qualityObjectSnapshot,
      ids.qualityObjectFile,
      ids.qualityObjectArtifact,
      objectContentDigest,
      qualityObjectRows,
      ids.qualityLinkSnapshot,
      ids.qualityLinkFile,
      ids.qualityLinkArtifact,
      linkContentDigest,
    ],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_group_members (
       project_id, snapshot_group_id, group_version, member_key, member_kind,
       snapshot_id, target_resource_id, target_revision_id
     ) VALUES
       ($1, $2, 1, 'object:Order', 'object', $3, $4, $5),
       ($1, $2, 1, 'link:OrderRelation', 'link', $6, $7, $8)`,
    [
      ids.project,
      ids.qualityGroup,
      ids.qualityObjectSnapshot,
      ids.objectResource,
      ids.objectRevision,
      ids.qualityLinkSnapshot,
      ids.linkResource,
      ids.linkRevision,
    ],
  );
  await client.query("COMMIT");
  for (const state of ["validated", "materializing", "ready"] as const) {
    await client.query(
      `UPDATE runtime.snapshot_group_versions
       SET state = $4, changed_at = clock_timestamp()
       WHERE project_id = $1 AND snapshot_group_id = $2 AND group_version = $3`,
      [ids.project, ids.qualityGroup, 1, state],
    );
    await client.query(
      `UPDATE runtime.dataset_snapshots
       SET state = $4, changed_at = clock_timestamp()
       WHERE project_id = $1 AND snapshot_group_id = $2 AND group_version = $3`,
      [ids.project, ids.qualityGroup, 1, state],
    );
  }
  await client.query(
    `INSERT INTO ops.materialization_jobs
       (project_id, job_id, snapshot_group_id, group_version, idempotency_key, input_digest)
     VALUES ($1, $2, $3, 1, 'g2-02-07-quality-job-v1', $4)`,
    [ids.project, ids.qualityJob, ids.qualityGroup, sha256Digest("quality-job-v1")],
  );
  await client.query(
    `INSERT INTO runtime.generations (
       project_id, generation_id, member_key, member_kind,
       target_resource_id, target_revision_id, snapshot_id, snapshot_group_id, group_version,
       snapshot_schema_resource_id, snapshot_schema_revision_id,
       mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest
     ) VALUES
       ($1, $2, 'object:Order', 'object', $3, $4, $5, $6, 1,
        $7, $8, $9, $10, $11, $12),
       ($1, $13, 'link:OrderRelation', 'link', $14, $15, $16, $6, 1,
        $17, $18, $19, $20, $11, $21)`,
    [
      ids.project,
      ids.qualityObjectGeneration,
      ids.objectResource,
      ids.objectRevision,
      ids.qualityObjectSnapshot,
      ids.qualityGroup,
      ids.schemaResource,
      ids.schemaRevision,
      ids.mappingResource,
      ids.mappingRevision,
      runtimePlanDigest,
      runtimeObjectIndexPlanDigest(),
      ids.qualityLinkGeneration,
      ids.linkResource,
      ids.linkRevision,
      ids.qualityLinkSnapshot,
      ids.linkSchemaResource,
      ids.linkSchemaRevision,
      ids.linkMappingResource,
      ids.linkMappingRevision,
      linkIndexDigest,
    ],
  );
  await client.query(
    `INSERT INTO authz.role_bindings
       (binding_id, project_id, principal_id, scope, resource_id, role)
     VALUES ($1, $2, $3, 'project', NULL, 'owner')`,
    [ids.qualityOwnerBinding, ids.project, ids.principal],
  );
}

function qualityLinkSchemaDefinition() {
  return {
    schemaVersion: 1,
    contractVersion: "snapshot-schema-v1",
    format: "csv_utf8",
    headerRow: true,
    columns: [
      { ordinal: 0, columnApiName: "sourceOrderId", valueType: "string", required: true },
      { ordinal: 1, columnApiName: "targetOrderId", valueType: "string", required: true },
    ],
  } as const;
}

function qualityLinkMappingDefinition() {
  return {
    schemaVersion: 1,
    mappingVersion: "mapping-v1",
    targetKind: "link",
    inputSchemaRevisionId: ids.linkSchemaRevision,
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

async function prepareLinkTypeFacts(client: pg.Client): Promise<void> {
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
}

async function prepareLinkRuntimeFacts(client: pg.Client, deferJob = false): Promise<void> {
  await prepareLinkTypeFacts(client);
  const indexDigest = sha256Digest("link-index-plan");
  const groupDigest = sha256Digest("link-snapshot-group");
  const contentDigest = sha256Digest("link-snapshot-content");
  const snapshotDigest = sha256Digest("link-snapshot");
  const runtimePlanDigest = sha256Digest("link-runtime-plan");
  const jobDigest = sha256Digest("link-job");
  const reportDigest = sha256Digest("link-report");
  const generationDigest = sha256Digest("link-generation");
  const linkSourceBytes = capacityMode ? capacityLinkSourceBytes(capacityMetrics.linkRows) : 64n;
  const linkSourceRows = capacityMode ? capacityMetrics.linkRows : 2;
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
       $10, $11, $12, $13, 1, $14
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
      linkSourceBytes.toString(),
      linkSourceRows,
      snapshotDigest,
    ],
  );
  await client.query(
    `INSERT INTO runtime.snapshot_files (
       project_id, snapshot_id, file_id, managed_artifact_id, object_version,
       ordinal, content_digest, byte_count, row_count, source_label, scan_status
     ) VALUES ($1, $2, $3, $4, 'link-version-1', 0, $5, $6, $7,
               'DB-02 Link Base fixture', 'complete')`,
    [
      ids.project,
      ids.linkSnapshot,
      ids.linkSnapshotFile,
      ids.linkManagedArtifact,
      contentDigest,
      linkSourceBytes.toString(),
      linkSourceRows,
    ],
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
       (project_id, job_id, snapshot_group_id, group_version, idempotency_key, input_digest,
        available_at)
     VALUES ($1, $2, $3, 1, 'db02-link-base-job-0001', $4,
             CASE WHEN $5::boolean
               THEN clock_timestamp() + interval '1 day'
               ELSE clock_timestamp()
             END)`,
    [ids.project, ids.linkJob, ids.linkSnapshotGroup, jobDigest, deferJob],
  );
  if (!projectionCapacityMode) {
    await client.query(
      `INSERT INTO runtime.materialization_reports (
         project_id, report_id, snapshot_group_id, group_version, job_id, outcome,
         total_rows, accepted_rows, rejected_rows, validator_version, report_digest
       ) VALUES ($1, $2, $3, 1, $4, 'passed', 1, 1, 0,
                 'materialization-g2-02-v1', $5)`,
      [ids.project, ids.linkReport, ids.linkSnapshotGroup, ids.linkJob, reportDigest],
    );
  }
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
      projectionCapacityMode ? null : ids.linkReport,
      projectionCapacityMode ? null : reportDigest,
      projectionCapacityMode ? null : generationDigest,
    ],
  );
}

async function makeLinkJobAvailable(adminConfig: pg.ClientConfig): Promise<void> {
  await withClient(adminConfig, async (admin) => {
    const result = await admin.query(
      `UPDATE ops.materialization_jobs
       SET available_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE project_id = $1 AND job_id = $2 AND state = 'queued'`,
      [ids.project, ids.linkJob],
    );
    assert.equal(result.rowCount, 1);
  });
}

async function exerciseLinkBase(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
): Promise<number | undefined> {
  const linkStartedAt = process.hrtime.bigint();
  const claim = await withClient(workerConfig, async (worker) => {
    const result = await worker.query<{ readonly fencing_token: string }>(
      `SELECT fencing_token::text
       FROM ops.claim_materialization_job_v2($1, $2, $3)`,
      [ids.worker1, ids.linkAttempt, materializationLeaseSeconds],
    );
    return result.rows[0];
  });
  assert.ok(claim);
  await using linkHeartbeat = projectionCapacityMode
    ? startCapacityHeartbeat(workerConfig, {
        projectId: ids.project,
        jobId: ids.linkJob,
        attemptId: ids.linkAttempt,
        workerInstanceId: ids.worker1,
        fencingToken: claim.fencing_token,
      })
    : null;
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
  let qualityCurrentMilliseconds: number | undefined;
  if (projectionCapacityMode) {
    const qualityCurrentStartedAt = process.hrtime.bigint();
    const qualityPool = new pg.Pool(workerConfig);
    try {
      const result = await postgresQualityService(
        qualityPool,
        [ids.projectionLinkQualityReport],
        [],
      ).build({
        scope: linkScope(BigInt(claim.fencing_token)),
        generationId: ids.linkGeneration,
        provenanceTemplates: [],
      });
      assert.equal(result.outcome, "passed");
    } finally {
      await qualityPool.end();
    }
    qualityCurrentMilliseconds = elapsedMilliseconds(qualityCurrentStartedAt);
  }
  await linkHeartbeat?.stop();

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
           heartbeat_at = NULL, result_code = 'SUCCEEDED', result_digest = $3,
           updated_at = clock_timestamp()
       WHERE project_id = $1 AND job_id = $2`,
      [ids.project, ids.linkJob, digests.checkpoint],
    );
    if (projectionCapacityMode) {
      await admin.query(
        `UPDATE runtime.generations SET state = 'ready', changed_at = clock_timestamp()
         WHERE project_id = $1 AND generation_id = $2`,
        [ids.project, ids.linkGeneration],
      );
    }
  });
  capacityMetrics.linkBatches = Math.ceil(capacityMetrics.linkRows / 5_000);
  capacityMetrics.linkMilliseconds = elapsedMilliseconds(linkStartedAt);
  samplePeakRss();
  if (capacityMode) await reportBaseCapacity(adminConfig, digestBeforeRestart);
  return qualityCurrentMilliseconds;
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
  const schema = capacityObjectSchemaDefinition();
  const mapping = capacityObjectMappingDefinition();
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

function capacityObjectSchemaDefinition() {
  return {
    schemaVersion: 1,
    contractVersion: "snapshot-schema-v1",
    format: "csv_utf8",
    headerRow: true,
    columns: [
      { ordinal: 0, columnApiName: "orderId", valueType: "string", required: true },
      { ordinal: 1, columnApiName: "displayName", valueType: "string", required: true },
    ],
  } as const;
}

function capacityObjectMappingDefinition() {
  return {
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
  caseSensitive = capacityMode,
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
        components: [{ type: "string" as const, caseSensitive }],
      }),
      sourceColumnApiNames: Object.freeze(["sourceOrderId"]),
    }),
    targetLookup: Object.freeze({
      objectTypeResourceId: parseOntosId(ids.objectResource),
      objectTypeRevisionId: parseOntosId(ids.objectRevision),
      canonicalPrimaryKey: canonicalizePrimaryKey([targetIdentity], {
        components: [{ type: "string" as const, caseSensitive }],
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
        propertyApiName: "displayName",
        valueType: "string" as const,
        value: `Order ${identity}`,
        sourceColumnApiNames: Object.freeze(["displayName"]),
      }),
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

interface CapacityHeartbeat {
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

function startCapacityHeartbeat(
  config: pg.ClientConfig,
  lease: {
    readonly projectId: string;
    readonly jobId: string;
    readonly attemptId: string;
    readonly workerInstanceId: string;
    readonly fencingToken: string;
  },
): CapacityHeartbeat {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let pending = Promise.resolve();
  let failure: unknown;
  const tick = (): void => {
    pending = withClient(config, (client) =>
      client
        .query(`SELECT ops.heartbeat_materialization_job($1, $2, $3, $4, $5, $6)`, [
          lease.projectId,
          lease.jobId,
          lease.attemptId,
          lease.workerInstanceId,
          lease.fencingToken,
          materializationLeaseSeconds,
        ])
        .then(() => undefined),
    )
      .catch((error: unknown) => {
        failure = error;
        stopped = true;
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, 60_000);
      });
  };
  timer = setTimeout(tick, 60_000);
  const stop = async (): Promise<void> => {
    if (!stopped) {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    }
    await pending;
    if (failure !== undefined) {
      throw failure instanceof Error
        ? failure
        : new Error("Capacity heartbeat failed with a non-Error value.", { cause: failure });
    }
  };
  return Object.freeze({ stop, [Symbol.asyncDispose]: stop });
}

async function prepareCompatibilityCapacityFacts(client: pg.Client): Promise<void> {
  const existing = await client.query<{ readonly count: number }>(
    `SELECT count(*)::integer AS count
     FROM runtime.capacity_admissions AS admission
     JOIN runtime.project_runtime_inventories AS inventory
       ON inventory.project_id = admission.project_id
      AND inventory.inventory_revision = admission.inventory_revision
      AND inventory.inventory_digest = admission.physical_measurement_digest
      AND inventory.measurement_complete
     WHERE admission.project_id = $1
       AND admission.generation_id = $2
       AND admission.phase = 'POSTBUILD'
       AND admission.report->>'accepted' = 'true'`,
    [ids.project, ids.generation],
  );
  if ((existing.rows[0]?.count ?? 0) > 0) return;

  const inventory = await client.query<{
    readonly inventory_revision: string;
    readonly inventory_digest: string | null;
  }>(
    `SELECT inventory_revision::text, inventory_digest
     FROM runtime.project_runtime_inventories
     WHERE project_id = $1 AND measurement_complete`,
    [ids.project],
  );
  const current = required(inventory.rows[0]);
  assert.ok(current.inventory_digest !== null);
  await client.query(
    `INSERT INTO runtime.capacity_admissions (
       project_id, admission_id, generation_id, phase, inventory_revision,
       index_plan_digest, source_forecast_digest, physical_measurement_digest,
       measured_bytes, observed_project_physical_bytes, reserved_bytes,
       steady_reserved_bytes, peak_reserved_bytes, report, report_digest
     ) VALUES (
       $1, $2, $3, 'POSTBUILD', $4, $5, $6, $7,
       0, 0, 0, 0, 0, '{"accepted":true,"fixture":"g2-02-10"}'::jsonb, $8
     )`,
    [
      ids.project,
      ids.capacityAdmission,
      ids.generation,
      current.inventory_revision,
      runtimeObjectIndexPlanDigest(),
      sha256Digest("g2-02-10-regression-source-forecast"),
      current.inventory_digest,
      sha256Digest("g2-02-10-regression-capacity-admission"),
    ],
  );
}

async function issueCertificateAndReady(client: pg.Client): Promise<void> {
  const certificate = await client.query<{
    readonly certificate_id: string;
    readonly certificate_digest: string;
    readonly decision: string;
  }>(`SELECT * FROM runtime.issue_compatibility_certificate($1, $2, $3, $4)`, [
    ids.certificate,
    ids.project,
    ids.generation,
    ids.release2,
  ]);
  assert.equal(certificate.rows[0]?.certificate_id, ids.certificate);
  assert.equal(certificate.rows[0]?.decision, "exact_pin");
  if (projectionCapacityMode) {
    const linkCertificate = await client.query<{
      readonly certificate_id: string;
      readonly decision: string;
    }>(`SELECT * FROM runtime.issue_compatibility_certificate($1, $2, $3, $4)`, [
      ids.linkCertificate,
      ids.project,
      ids.linkGeneration,
      ids.release2,
    ]);
    assert.equal(linkCertificate.rows[0]?.certificate_id, ids.linkCertificate);
    assert.equal(linkCertificate.rows[0]?.decision, "exact_pin");
  }
  await client.query(
    `UPDATE meta.releases SET state = 'ready', changed_at = clock_timestamp()
     WHERE release_id = $1`,
    [ids.release2],
  );
}

async function exerciseRuntimeCompatibilityCoordinator(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
): Promise<void> {
  const releaseDigest = sha256Digest("g2-02-10-second-supported-release");
  const validationContext = sha256Digest("g2-02-10-second-release-validation-context");
  const objectIndexPlan = await withClient(adminConfig, async (admin) => {
    await admin.query(
      `INSERT INTO meta.releases
         (release_id, project_id, release_number, manifest_digest,
          target_channel_name, created_by_principal_id)
       VALUES ($1, $2, 3, $3, 'production', $4)`,
      [ids.release3, ids.project, releaseDigest, ids.principal],
    );
    await admin.query(
      `INSERT INTO meta.release_pins
         (release_id, resource_id, revision_id, pin_order, family, content_digest)
       SELECT $1, resource_id, revision_id, pin_order, family, content_digest
       FROM meta.release_pins WHERE release_id = $2 ORDER BY pin_order`,
      [ids.release3, ids.release2],
    );
    await admin.query(
      `INSERT INTO meta.validation_reports
         (report_id, subject_type, subject_id, release_id, subject_digest,
          validation_context_digest, validator_version, valid, issues)
       VALUES ($1, 'release', $2, $2, $3, $4,
               'metadata-release-g2-01-v1', TRUE, '[]'::jsonb)`,
      [ids.releaseValidation3, ids.release3, releaseDigest, validationContext],
    );
    await admin.query(
      `UPDATE meta.releases
       SET state = 'staging', staged_from_release_id = $2,
           staged_from_activation_id = $3, staged_channel_control_sequence = 1,
           staged_validation_context_digest = $4, staged_at = clock_timestamp(),
           changed_at = clock_timestamp()
       WHERE release_id = $1`,
      [ids.release3, ids.release1, ids.activation0, validationContext],
    );
    const plan = await admin.query<{
      readonly index_plan_id: string;
      readonly plan_digest: string;
    }>(
      `SELECT index_plan_id, plan_digest
       FROM runtime.index_plans
       WHERE project_id = $1 AND target_resource_id = $2 AND target_revision_id = $3
       ORDER BY created_at, index_plan_id LIMIT 1`,
      [ids.project, ids.objectResource, ids.objectRevision],
    );
    return required(plan.rows[0]);
  });
  await withClient(adminConfig, async (admin) => {
    await admin.query(
      `INSERT INTO runtime.index_plan_admissions (
         project_id, admission_id, release_id, release_plan_digest,
         index_plan_id, inventory_revision, release_units, project_union_units,
         project_physical_index_count, admission_mode, report_digest
       ) VALUES ($1, $2, $3, $4, $5, 1, 0, 0, 0, 'WITHIN_NORMAL', $6)`,
      [
        ids.project,
        ids.indexAdmission3,
        ids.release3,
        sha256Digest("g2-02-10-second-release-index-plan"),
        objectIndexPlan.index_plan_id,
        sha256Digest("g2-02-10-second-release-index-admission"),
      ],
    );
    const runtimePlanDigest = materializationDigest("RuntimeMemberPlan", {
      schemaVersion: 1,
      contractVersion: "runtime-member-plan-v1",
      projectId: ids.project,
      releaseId: ids.release3,
      members: [
        {
          memberKey: "object:Order",
          memberKind: "object",
          targetResourceId: ids.objectResource,
          targetRevisionId: ids.objectRevision,
          snapshotSchemaRevisionId: ids.schemaRevision,
          mappingRevisionId: ids.mappingRevision,
          snapshotGroupId: ids.snapshotGroup,
          indexPlanDigest: objectIndexPlan.plan_digest,
        },
      ],
      planDigest: digestOf("0"),
    });
    await admin.query("BEGIN");
    try {
      await admin.query(
        `INSERT INTO meta.release_runtime_plans
           (project_id, release_id, plan_digest, member_count) VALUES ($1, $2, $3, 1)`,
        [ids.project, ids.release3, runtimePlanDigest],
      );
      await admin.query(
        `INSERT INTO meta.release_runtime_plan_members (
           project_id, release_id, runtime_plan_digest, member_key, member_kind,
           target_resource_id, target_revision_id,
           snapshot_schema_resource_id, snapshot_schema_revision_id,
           mapping_resource_id, mapping_revision_id, snapshot_group_id, index_plan_digest
         ) VALUES (
           $1, $2, $3, 'object:Order', 'object', $4, $5, $6, $7, $8, $9, $10, $11
         )`,
        [
          ids.project,
          ids.release3,
          runtimePlanDigest,
          ids.objectResource,
          ids.objectRevision,
          ids.schemaResource,
          ids.schemaRevision,
          ids.mappingResource,
          ids.mappingRevision,
          ids.snapshotGroup,
          objectIndexPlan.plan_digest,
        ],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  });

  const pool = new pg.Pool(apiConfig);
  try {
    const coordinator = new RuntimeCompatibilityCoordinator(
      new PostgresRuntimeCompatibilityRepository(pool),
    );
    const result = await coordinator.prepareSnapshotGroupRefresh({
      projectId: ids.project,
      snapshotGroupId: ids.snapshotGroup,
      groupVersion: 1,
    });
    assert.equal(result.job.state, "succeeded");
    assert.equal(result.job.reused, true);
    assert.deepEqual(
      result.releases.map((release) => [
        release.releaseId,
        release.outcome,
        release.certifiedMemberCount,
      ]),
      [
        [ids.release2, "ready", 1],
        [ids.release3, "reused", 1],
      ],
    );
    await assert.rejects(
      coordinator.issueGenerationCertificate({
        projectId: ids.otherProject,
        generationId: ids.generation,
        targetReleaseId: ids.release3,
      }),
      (error: unknown) =>
        error instanceof RuntimeCompatibilityError &&
        error.code === "RUNTIME_GENERATION_INCOMPATIBLE",
    );
    await assertPgCode(
      pool.query(
        `SELECT * FROM runtime.issue_compatibility_certificate(
           $1, $2, $3, $4, 'exact_pin', 'forged-validator', $5
         )`,
        [randomUUID(), ids.project, ids.generation, ids.release3, digestOf("e")],
      ),
      "42883",
    );
    await pool.query(
      `UPDATE meta.releases SET state = 'ready', changed_at = clock_timestamp()
       WHERE release_id = $1`,
      [ids.release3],
    );
    const current = await pool.query<{
      readonly release_count: number;
      readonly generation_count: number;
    }>(
      `SELECT count(DISTINCT target_release_id)::integer AS release_count,
              count(DISTINCT generation_id)::integer AS generation_count
       FROM runtime.current_compatibility_certificates
       WHERE project_id = $1 AND target_release_id IN ($2, $3)`,
      [ids.project, ids.release2, ids.release3],
    );
    assert.deepEqual(current.rows[0], { release_count: 2, generation_count: 1 });
  } finally {
    await pool.end();
  }
}

async function exerciseCompatibilityFailureVectors(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
): Promise<void> {
  const failedJobId = randomUUID();
  const failedAttemptId = randomUUID();
  const failedReportId = randomUUID();
  const failedGenerationId = randomUUID();
  const failedCertificateId = randomUUID();
  const failedReportDigest = sha256Artifact(`failed-job-report-${failedReportId}`);
  const failedGenerationDigest = sha256Artifact(`failed-job-generation-${failedGenerationId}`);
  const failedQualityDigest = sha256Artifact(`failed-job-quality-${failedGenerationId}`);

  await withClient(apiConfig, async (api) => {
    const queued = await api.query<{ readonly job_id: string; readonly state: string }>(
      `SELECT job_id, state
       FROM ops.enqueue_materialization_job($1, $2, $3, 1, $4, $5, $6, 100)`,
      [
        ids.project,
        failedJobId,
        ids.snapshotGroup,
        `g2-02-10-failed-job-${failedJobId}`,
        sha256Artifact(`failed-job-input-${failedJobId}`),
        randomUUID(),
      ],
    );
    assert.deepEqual(queued.rows[0], { job_id: failedJobId, state: "queued" });
  });
  await withClient(workerConfig, async (worker) => {
    const claim = await worker.query<{
      readonly job_id: string;
      readonly fencing_token: string;
    }>(`SELECT job_id, fencing_token::text FROM ops.claim_materialization_job_v2($1, $2, 300)`, [
      ids.worker1,
      failedAttemptId,
    ]);
    assert.equal(claim.rows[0]?.job_id, failedJobId);
    const failed = await worker.query<{ readonly state: string }>(
      `SELECT state FROM ops.fail_materialization_job(
         $1, $2, $3, $4, $5, 'CERTIFICATE_SOURCE_FAILED', 'permanent', false, $6, '[]'::jsonb
       )`,
      [
        ids.project,
        failedJobId,
        failedAttemptId,
        ids.worker1,
        required(claim.rows[0]).fencing_token,
        sha256Artifact(`failed-job-fingerprint-${failedJobId}`),
      ],
    );
    assert.equal(failed.rows[0]?.state, "dead_letter");
  });

  await withClient(adminConfig, async (admin) => {
    await assertPgCode(
      admin.query(
        `INSERT INTO meta.release_runtime_plan_members (
           project_id, release_id, runtime_plan_digest, member_key, member_kind,
           target_resource_id, target_revision_id,
           snapshot_schema_resource_id, snapshot_schema_revision_id,
           mapping_resource_id, mapping_revision_id, snapshot_group_id, index_plan_digest
         )
         SELECT project_id, release_id, runtime_plan_digest, 'object:Late', member_kind,
                target_resource_id, target_revision_id,
                snapshot_schema_resource_id, snapshot_schema_revision_id,
                mapping_resource_id, mapping_revision_id, snapshot_group_id, index_plan_digest
         FROM meta.release_runtime_plan_members
         WHERE release_id = $1 AND member_key = 'object:Order'`,
        [ids.release3],
      ),
      "55000",
    );

    await admin.query("BEGIN");
    try {
      await admin.query(
        `INSERT INTO runtime.materialization_reports (
           project_id, report_id, snapshot_group_id, group_version, job_id, outcome,
           total_rows, accepted_rows, rejected_rows, validator_version, report_digest
         )
         SELECT project_id, $1, snapshot_group_id, group_version, $2, outcome,
                total_rows, accepted_rows, rejected_rows, validator_version, $3
         FROM runtime.materialization_reports
         WHERE project_id = $4 AND report_id = $5`,
        [failedReportId, failedJobId, failedReportDigest, ids.project, ids.report],
      );
      await admin.query(
        `INSERT INTO runtime.generations (
           project_id, generation_id, member_key, member_kind,
           target_resource_id, target_revision_id, snapshot_id, snapshot_group_id, group_version,
           snapshot_schema_resource_id, snapshot_schema_revision_id,
           mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest,
           report_id, report_digest, generation_digest
         )
         SELECT project_id, $1, member_key, member_kind,
                target_resource_id, target_revision_id, snapshot_id, snapshot_group_id, group_version,
                snapshot_schema_resource_id, snapshot_schema_revision_id,
                mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest,
                $2, $3, $4
         FROM runtime.generations
         WHERE project_id = $5 AND generation_id = $6`,
        [
          failedGenerationId,
          failedReportId,
          failedReportDigest,
          failedGenerationDigest,
          ids.project,
          ids.generation,
        ],
      );
      await admin.query(
        `INSERT INTO runtime.object_base (
           project_id, generation_id, object_type_resource_id, object_type_revision_id,
           object_rid, canonical_primary_key, properties, source_snapshot_id,
           source_file_id, source_row_number, mapping_revision_id, value_digest
         )
         SELECT project_id, $1, object_type_resource_id, object_type_revision_id,
                object_rid, canonical_primary_key, properties, source_snapshot_id,
                source_file_id, source_row_number, mapping_revision_id, value_digest
         FROM runtime.object_base
         WHERE project_id = $2 AND generation_id = $3`,
        [failedGenerationId, ids.project, ids.generation],
      );
      await admin.query(
        `INSERT INTO runtime.object_current (
           project_id, generation_id, object_type_resource_id, object_type_revision_id,
           object_rid, canonical_primary_key, properties, base_value_digest
         )
         SELECT project_id, $1, object_type_resource_id, object_type_revision_id,
                object_rid, canonical_primary_key, properties, base_value_digest
         FROM runtime.object_current
         WHERE project_id = $2 AND generation_id = $3`,
        [failedGenerationId, ids.project, ids.generation],
      );
      await admin.query(
        `INSERT INTO runtime.property_provenance (
           project_id, generation_id, object_type_resource_id, object_rid,
           property_api_name, source_snapshot_id, source_file_id, source_row_number,
           input_column_ordinal, mapping_revision_id, algorithm_version, value_digest,
           source_index, source_kind, source_expression_digest
         )
         SELECT project_id, $1, object_type_resource_id, object_rid,
                property_api_name, source_snapshot_id, source_file_id, source_row_number,
                input_column_ordinal, mapping_revision_id, algorithm_version, value_digest,
                source_index, source_kind, source_expression_digest
         FROM runtime.property_provenance
         WHERE project_id = $2 AND generation_id = $3`,
        [failedGenerationId, ids.project, ids.generation],
      );
      await admin.query(
        `INSERT INTO runtime.materialization_quality_bindings (
           project_id, generation_id, report_id, report_digest,
           snapshot_digest, mapping_revision_digest, observation_digest,
           current_digest, provenance_digest, zero_overlay_row_count,
           state, quality_binding_digest
         )
         SELECT project_id, $1, $2, $3,
                snapshot_digest, mapping_revision_digest, observation_digest,
                current_digest, provenance_digest, zero_overlay_row_count,
                'passed', $4
         FROM runtime.materialization_quality_bindings
         WHERE project_id = $5 AND generation_id = $6`,
        [
          failedGenerationId,
          failedReportId,
          failedReportDigest,
          failedQualityDigest,
          ids.project,
          ids.generation,
        ],
      );
      await admin.query(
        `UPDATE runtime.generations
         SET state = 'ready', changed_at = clock_timestamp()
         WHERE project_id = $1 AND generation_id = $2`,
        [ids.project, failedGenerationId],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  });

  const pool = new pg.Pool(apiConfig);
  try {
    const coordinator = new RuntimeCompatibilityCoordinator(
      new PostgresRuntimeCompatibilityRepository(pool, {
        uuidFactory: () => failedCertificateId,
      }),
    );
    await assert.rejects(
      coordinator.issueGenerationCertificate({
        projectId: ids.project,
        generationId: failedGenerationId,
        targetReleaseId: ids.release3,
      }),
      (error: unknown) =>
        error instanceof RuntimeCompatibilityError &&
        error.code === "RUNTIME_GENERATION_INCOMPATIBLE",
    );
    const persisted = await pool.query<{ readonly count: number }>(
      `SELECT count(*)::integer AS count
       FROM runtime.compatibility_certificates
       WHERE project_id = $1 AND generation_id = $2`,
      [ids.project, failedGenerationId],
    );
    assert.equal(persisted.rows[0]?.count, 0);
  } finally {
    await pool.end();
  }
}

async function exerciseCompatibilityStalenessVectors(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
): Promise<void> {
  const before = await withClient(adminConfig, (admin) =>
    admin.query<{ readonly release_count: number }>(
      `SELECT count(DISTINCT target_release_id)::integer AS release_count
       FROM runtime.current_compatibility_certificates
       WHERE project_id = $1 AND target_release_id IN ($2, $3)`,
      [ids.project, ids.release2, ids.release3],
    ),
  );
  assert.equal(before.rows[0]?.release_count, 2);

  const workerPool = new pg.Pool(workerConfig);
  let measurement: ProjectPhysicalInventoryMeasurement;
  try {
    measurement = await scanAndRecordProjectPhysicalInventory(
      workerPool,
      projectionCapacityCrypto(),
      { projectId: ids.project, expectedInventoryRevision: 1n },
    );
  } finally {
    await workerPool.end();
  }
  assert.equal(measurement.inventoryRevision, 2n);

  const staleCertificateId = randomUUID();
  const apiPool = new pg.Pool(apiConfig);
  const repository = new PostgresRuntimeCompatibilityRepository(apiPool, {
    uuidFactory: () => staleCertificateId,
  });
  try {
    const staleRows = await apiPool.query<{ readonly count: number }>(
      `SELECT count(*)::integer AS count
       FROM runtime.current_compatibility_certificates
       WHERE project_id = $1 AND target_release_id IN ($2, $3)`,
      [ids.project, ids.release2, ids.release3],
    );
    assert.equal(staleRows.rows[0]?.count, 0);
    await assert.rejects(
      repository.issueCompatibilityCertificate({
        projectId: ids.project,
        generationId: ids.generation,
        targetReleaseId: ids.release3,
      }),
      (error: unknown) =>
        error instanceof RuntimeCompatibilityError && error.code === "RUNTIME_COMPATIBILITY_STALE",
    );

    const approvalId = randomUUID();
    const capacityAdmissionId = randomUUID();
    const activeCertificateId = randomUUID();
    await withClient(adminConfig, async (admin) => {
      await admin.query(
        `INSERT INTO runtime.capacity_approvals (
           project_id, approval_id, scope, scope_id,
           approved_limit_bytes, hard_limit_bytes, approved_by_principal_id,
           evidence_digest, expires_at
         ) VALUES ($1, $2, 'project_peak', $1, $3, $3, $4, $5,
                   clock_timestamp() + interval '1 hour')`,
        [
          ids.project,
          approvalId,
          (12n * 1024n ** 3n).toString(),
          ids.principal,
          sha256Artifact(`compatibility-approval-${approvalId}`),
        ],
      );
      for (const releaseId of [ids.release2, ids.release3]) {
        await admin.query(
          `INSERT INTO runtime.index_plan_admissions (
             project_id, admission_id, release_id, release_plan_digest,
             index_plan_id, inventory_revision, release_units, project_union_units,
             project_physical_index_count, admission_mode, approval_id,
             report_digest, approval_expires_at
           )
           SELECT $1, $2, $3, $4, plan.index_plan_id, $5, 0, 0, 0,
                  'APPROVED_OVERAGE', approval.approval_id, $6, approval.expires_at
           FROM runtime.index_plans AS plan
           JOIN runtime.capacity_approvals AS approval
             ON approval.project_id = plan.project_id AND approval.approval_id = $7
           WHERE plan.project_id = $1
             AND plan.target_resource_id = $8
             AND plan.target_revision_id = $9
             AND plan.plan_digest = $10`,
          [
            ids.project,
            randomUUID(),
            releaseId,
            sha256Artifact(`inventory-2-release-plan-${releaseId}`),
            measurement.inventoryRevision.toString(),
            sha256Artifact(`inventory-2-index-admission-${releaseId}`),
            approvalId,
            ids.objectResource,
            ids.objectRevision,
            runtimeObjectIndexPlanDigest(),
          ],
        );
      }
      await admin.query(
        `INSERT INTO runtime.capacity_admissions (
           project_id, admission_id, generation_id, phase, inventory_revision,
           index_plan_digest, source_forecast_digest, physical_measurement_digest,
           measured_bytes, observed_project_physical_bytes, reserved_bytes,
           steady_reserved_bytes, peak_reserved_bytes, approval_id,
           report, report_digest, approval_expires_at
         )
         SELECT $1, $2, $3, 'POSTBUILD', $4, $5, $6, $7,
                $8, $8, $8, $8, $8, approval.approval_id,
                '{"accepted":true,"fixture":"g2-02-10-expiry"}'::jsonb,
                $9, approval.expires_at
         FROM runtime.capacity_approvals AS approval
         WHERE approval.project_id = $1 AND approval.approval_id = $10`,
        [
          ids.project,
          capacityAdmissionId,
          ids.generation,
          measurement.inventoryRevision.toString(),
          runtimeObjectIndexPlanDigest(),
          sha256Artifact("inventory-2-source-forecast"),
          measurement.measurementDigest,
          measurement.totalRelationBytes.toString(),
          sha256Artifact("inventory-2-capacity-admission"),
          approvalId,
        ],
      );
    });

    const activeRepository = new PostgresRuntimeCompatibilityRepository(apiPool, {
      uuidFactory: () => activeCertificateId,
    });
    const active = await activeRepository.issueCompatibilityCertificate({
      projectId: ids.project,
      generationId: ids.generation,
      targetReleaseId: ids.release3,
    });
    assert.equal(active.certificateId, activeCertificateId);
    const rebound = await apiPool.query<{ readonly count: number }>(
      `SELECT count(*)::integer AS count
       FROM runtime.current_compatibility_certificates
       WHERE project_id = $1 AND target_release_id IN ($2, $3)`,
      [ids.project, ids.release2, ids.release3],
    );
    assert.equal(rebound.rows[0]?.count, 1);

    await withClient(adminConfig, (admin) =>
      admin.query(
        `UPDATE runtime.capacity_approvals
         SET state = 'expired', changed_at = clock_timestamp()
         WHERE project_id = $1 AND approval_id = $2`,
        [ids.project, approvalId],
      ),
    );
    const expired = await apiPool.query<{ readonly count: number }>(
      `SELECT count(*)::integer AS count
       FROM runtime.current_compatibility_certificates
       WHERE project_id = $1 AND target_release_id IN ($2, $3)`,
      [ids.project, ids.release2, ids.release3],
    );
    assert.equal(expired.rows[0]?.count, 0);
    await assert.rejects(
      activeRepository.issueCompatibilityCertificate({
        projectId: ids.project,
        generationId: ids.generation,
        targetReleaseId: ids.release3,
      }),
      (error: unknown) =>
        error instanceof RuntimeCompatibilityError && error.code === "RUNTIME_COMPATIBILITY_STALE",
    );
  } finally {
    await apiPool.end();
  }
}

interface RefreshFixtureIds {
  readonly snapshotId: string;
  readonly fileId: string;
  readonly artifactId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly reportId: string;
  readonly generationId: string;
  readonly capacityAdmissionId: string;
  readonly release2CertificateId: string;
  readonly release3CertificateId: string;
}

const refreshFixtureIds = Object.freeze({
  3: Object.freeze({
    snapshotId: ids.refresh2Snapshot,
    fileId: ids.refresh2File,
    artifactId: ids.refresh2Artifact,
    jobId: ids.refresh2Job,
    attemptId: ids.refresh2Attempt,
    reportId: ids.refresh2Report,
    generationId: ids.refresh2Generation,
    capacityAdmissionId: ids.refresh2CapacityAdmission,
    release2CertificateId: ids.refresh2Certificate2,
    release3CertificateId: ids.refresh2Certificate3,
  }),
  4: Object.freeze({
    snapshotId: ids.refresh3Snapshot,
    fileId: ids.refresh3File,
    artifactId: ids.refresh3Artifact,
    jobId: ids.refresh3Job,
    attemptId: ids.refresh3Attempt,
    reportId: ids.refresh3Report,
    generationId: ids.refresh3Generation,
    capacityAdmissionId: ids.refresh3CapacityAdmission,
    release2CertificateId: ids.refresh3Certificate2,
    release3CertificateId: ids.refresh3Certificate3,
  }),
}) satisfies Readonly<Record<3 | 4, RefreshFixtureIds>>;

function zeroOverlayEvidence(groupVersion: number) {
  return Object.freeze({
    providerId: "ontos.zero-overlay",
    providerVersion: "1",
    projectId: ids.project,
    snapshotGroupKey: `${ids.snapshotGroup}:${String(groupVersion)}`,
    complete: true,
    watermark: 0,
    deltaCount: 0,
    digest: `sha256:${"0".repeat(64)}`,
  });
}

async function exerciseSnapshotGroupRefreshCutover(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
): Promise<void> {
  const inventoryPool = new pg.Pool(workerConfig);
  let measurement: ProjectPhysicalInventoryMeasurement;
  try {
    measurement = await scanAndRecordProjectPhysicalInventory(
      inventoryPool,
      projectionCapacityCrypto(),
      {
        projectId: ids.project,
        expectedInventoryRevision: 2n,
      },
    );
  } finally {
    await inventoryPool.end();
  }
  assert.equal(measurement.inventoryRevision, 3n);
  await withClient(adminConfig, async (admin) => {
    const indexPlan = await admin.query<{ readonly index_plan_id: string }>(
      `SELECT index_plan_id
       FROM runtime.index_plans
       WHERE project_id = $1 AND target_resource_id = $2
         AND target_revision_id = $3 AND plan_digest = $4`,
      [ids.project, ids.objectResource, ids.objectRevision, runtimeObjectIndexPlanDigest()],
    );
    for (const releaseId of [ids.release2, ids.release3]) {
      await admin.query(
        `INSERT INTO runtime.index_plan_admissions (
           project_id, admission_id, release_id, release_plan_digest,
           index_plan_id, inventory_revision, release_units, project_union_units,
           project_physical_index_count, admission_mode, report_digest
         ) VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 'WITHIN_NORMAL', $7)`,
        [
          ids.project,
          randomUUID(),
          releaseId,
          sha256Digest(`g20211-refresh-index-plan-${releaseId}`),
          required(indexPlan.rows[0]).index_plan_id,
          measurement.inventoryRevision.toString(),
          sha256Digest(`g20211-refresh-index-admission-${releaseId}`),
        ],
      );
    }
  });

  const before = await withClient(adminConfig, readObjectHeads);
  assert.equal(before.length, capacityMetrics.objectRows);
  await prepareRefreshFixture(adminConfig, apiConfig, workerConfig, 3);

  const apiPool = new pg.Pool(apiConfig);
  try {
    const repository = new PostgresSnapshotGroupCutoverRepository(apiPool);
    const control = await readPublicationSequence(apiPool);
    const evidence = zeroOverlayEvidence(3);
    const preparations = await Promise.all(
      ["g20211-double-refresh-left-0002", "g20211-double-refresh-right-0002"].map(
        (idempotencyKey) =>
          repository.prepareSnapshotGroupCutover({
            command: {
              projectId: ids.project,
              snapshotGroupId: ids.snapshotGroup,
              groupVersion: 3,
              expectedControlRevision: control,
              idempotencyKey,
            },
            overlayEvidence: evidence,
          }),
      ),
    );
    const concurrent = await Promise.allSettled(
      preparations.map((preparation) =>
        repository.commitSnapshotGroupCutover({ preparation, overlayEvidence: evidence }),
      ),
    );
    const fulfilled = concurrent.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof repository.commitSnapshotGroupCutover>>
      > => result.status === "fulfilled",
    );
    const rejected = concurrent.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (fulfilled.length !== 1) {
      throw new Error(
        concurrent
          .map((result) =>
            result.status === "fulfilled"
              ? "fulfilled"
              : `${String(result.reason)}:${String(
                  (result.reason as { readonly cause?: { readonly message?: unknown } }).cause
                    ?.message,
                )}`,
          )
          .join(" | "),
      );
    }
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(
      rejected[0]?.reason instanceof SnapshotGroupCutoverError &&
        rejected[0].reason.code === "CUTOVER_CONCURRENT_MODIFICATION",
      true,
    );
    const refresh2 = required(fulfilled[0]).value;
    assert.deepEqual(
      {
        inserted: refresh2.insertedHeadCount,
        updated: refresh2.updatedHeadCount,
        repointed: refresh2.repointedHeadCount,
        releaseCount: refresh2.releases.length,
      },
      {
        inserted: 0,
        updated: 0,
        repointed: capacityMetrics.objectRows,
        releaseCount: 2,
      },
    );
    const winningPreparation =
      preparations[concurrent.findIndex((result) => result.status === "fulfilled")];
    const lostResponseRetry = await repository.commitSnapshotGroupCutover({
      preparation: required(winningPreparation),
      overlayEvidence: evidence,
    });
    assert.equal(lostResponseRetry.reused, true);

    const afterRebuild = await withClient(adminConfig, readObjectHeads);
    assert.deepEqual(
      afterRebuild.map((head) => [head.object_rid, head.head_version, head.head_digest]),
      before.map((head) => [head.object_rid, head.head_version, head.head_digest]),
    );
    assert.equal(
      afterRebuild.every((head) => head.current_generation_id === ids.refresh2Generation),
      true,
    );
    await assertRefreshLifecycle(adminConfig, 1, "retired", "superseded");
    await assertRefreshLifecycle(adminConfig, 3, "active", "active");

    await prepareRefreshFixture(adminConfig, apiConfig, workerConfig, 4);
    const stalePreparation = await repository.prepareSnapshotGroupCutover({
      command: {
        projectId: ids.project,
        snapshotGroupId: ids.snapshotGroup,
        groupVersion: 4,
        expectedControlRevision: await readPublicationSequence(apiPool),
        idempotencyKey: "g20211-refresh-versus-publish-0003",
      },
      overlayEvidence: zeroOverlayEvidence(4),
    });
    const release3Activation = required(
      refresh2.releases.find((release) => release.releaseId === ids.release3),
    ).activationId;
    await publishRelease3(adminConfig, release3Activation);
    await assert.rejects(
      repository.commitSnapshotGroupCutover({
        preparation: stalePreparation,
        overlayEvidence: zeroOverlayEvidence(4),
      }),
      (error: unknown) =>
        error instanceof SnapshotGroupCutoverError &&
        error.code === "CUTOVER_CONCURRENT_MODIFICATION",
    );

    const coordinator = new SnapshotGroupCutoverCoordinator(repository);
    const refresh3 = await coordinator.activate({
      projectId: ids.project,
      snapshotGroupId: ids.snapshotGroup,
      groupVersion: 4,
      expectedControlRevision: await readPublicationSequence(apiPool),
      idempotencyKey: "g20211-refresh-after-publish-0003",
    });
    assert.deepEqual(
      {
        inserted: refresh3.insertedHeadCount,
        updated: refresh3.updatedHeadCount,
        repointed: refresh3.repointedHeadCount,
        servingMoved: refresh3.releases.filter((release) => release.servingHeadMoved).length,
        channelMoved: refresh3.releases.filter((release) => release.channelMoved).length,
      },
      {
        inserted: 0,
        updated: 2,
        repointed: capacityMetrics.objectRows - 2,
        servingMoved: 2,
        channelMoved: 1,
      },
    );
    const afterBusinessChange = await withClient(adminConfig, readObjectHeads);
    assert.deepEqual(
      afterBusinessChange.map((head) => head.head_version),
      before.map((head, index) => head.head_version + (index < 2 ? 1 : 0)),
    );
    assert.equal(
      afterBusinessChange.every((head) => head.current_generation_id === ids.refresh3Generation),
      true,
    );
    assert.equal(afterBusinessChange[0]?.head_digest, afterBusinessChange[0]?.base_value_digest);
    assert.notEqual(afterBusinessChange[1]?.head_digest, afterBusinessChange[1]?.base_value_digest);
    await assertRefreshLifecycle(adminConfig, 3, "retired", "superseded");
    await assertRefreshLifecycle(adminConfig, 4, "active", "active");
    await assertSemanticHeadDigestContract(adminConfig);

    const performance = await measureRepeatedCutovers(repository, apiPool);
    assert.equal(performance.p95Milliseconds < 1_000, true);
    assert.equal(performance.maxMilliseconds < 5_000, true);
    process.stdout.write(`${JSON.stringify({ g20211Cutover: performance })}\n`);
  } finally {
    await apiPool.end();
  }
}

async function exerciseGenerationGarbageCollection(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
): Promise<void> {
  await withClient(adminConfig, async (admin) => {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE migration_owner");
      await admin.query(
        `INSERT INTO runtime.materialization_reports (
           project_id, report_id, snapshot_group_id, group_version, job_id, outcome,
           total_rows, accepted_rows, rejected_rows, validator_version,
           report_digest, created_at
         )
         SELECT project_id, $1::uuid, snapshot_group_id, group_version, job_id, outcome,
                total_rows, accepted_rows, rejected_rows, 'g2-02-12-gc-fixture-v1',
                $2, clock_timestamp() - interval '9 days'
         FROM runtime.materialization_reports
         WHERE project_id = $3::uuid AND report_id = $4::uuid`,
        [ids.gcReport, sha256Digest("g2-02-12-gc-report"), ids.project, ids.refresh3Report],
      );
      await admin.query(
        `INSERT INTO runtime.generations (
           project_id, generation_id, member_key, member_kind,
           target_resource_id, target_revision_id, snapshot_id, snapshot_group_id,
           group_version, snapshot_schema_resource_id, snapshot_schema_revision_id,
           mapping_resource_id, mapping_revision_id, runtime_plan_digest,
           index_plan_digest, report_id, report_digest, state, generation_digest,
           created_at, changed_at
         )
         SELECT project_id, $1::uuid, member_key, member_kind,
                target_resource_id, target_revision_id, snapshot_id, snapshot_group_id,
                group_version, snapshot_schema_resource_id, snapshot_schema_revision_id,
                mapping_resource_id, mapping_revision_id, runtime_plan_digest,
                index_plan_digest, $2::uuid, $3, 'building', $4,
                clock_timestamp() - interval '9 days',
                clock_timestamp() - interval '8 days'
         FROM runtime.generations
         WHERE project_id = $5::uuid AND generation_id = $6::uuid`,
        [
          ids.gcGeneration,
          ids.gcReport,
          sha256Digest("g2-02-12-gc-report"),
          sha256Digest("g2-02-12-gc-generation"),
          ids.project,
          ids.refresh3Generation,
        ],
      );
      await admin.query(
        `INSERT INTO runtime.object_base (
           project_id, generation_id, object_type_resource_id, object_type_revision_id,
           object_rid, canonical_primary_key, properties, source_snapshot_id,
           source_file_id, source_row_number, mapping_revision_id, value_digest
         )
         SELECT project_id, $1::uuid, object_type_resource_id, object_type_revision_id,
                object_rid, canonical_primary_key, properties, source_snapshot_id,
                source_file_id, source_row_number, mapping_revision_id, value_digest
         FROM runtime.object_base
         WHERE project_id = $2::uuid AND generation_id = $3::uuid`,
        [ids.gcGeneration, ids.project, ids.refresh3Generation],
      );
      await admin.query(
        `INSERT INTO runtime.object_current (
           project_id, generation_id, object_type_resource_id, object_type_revision_id,
           object_rid, canonical_primary_key, properties, base_value_digest, lifecycle_state
         )
         SELECT project_id, $1::uuid, object_type_resource_id, object_type_revision_id,
                object_rid, canonical_primary_key, properties, base_value_digest, lifecycle_state
         FROM runtime.object_current
         WHERE project_id = $2::uuid AND generation_id = $3::uuid`,
        [ids.gcGeneration, ids.project, ids.refresh3Generation],
      );
      await admin.query(
        `INSERT INTO runtime.property_provenance (
           project_id, generation_id, object_type_resource_id, object_rid,
           property_api_name, source_snapshot_id, source_file_id, source_row_number,
           input_column_ordinal, mapping_revision_id, algorithm_version, value_digest,
           source_index, source_kind, source_expression_digest
         )
         SELECT project_id, $1::uuid, object_type_resource_id, object_rid,
                property_api_name, source_snapshot_id, source_file_id, source_row_number,
                input_column_ordinal, mapping_revision_id, 'g2-02-12-gc-fixture-v1',
                value_digest, source_index, source_kind, source_expression_digest
         FROM runtime.property_provenance
         WHERE project_id = $2::uuid AND generation_id = $3::uuid`,
        [ids.gcGeneration, ids.project, ids.refresh3Generation],
      );
      await admin.query(
        `UPDATE runtime.generations
         SET state = 'failed', changed_at = clock_timestamp() - interval '8 days'
         WHERE project_id = $1::uuid AND generation_id = $2::uuid`,
        [ids.project, ids.gcGeneration],
      );
      await admin.query(
        `INSERT INTO runtime.object_head_sets (
           project_id, head_set_id, head_set_digest, state, head_count,
           created_at, changed_at
         )
         SELECT $1::uuid, $2::uuid, $3, 'retired', count(*),
                clock_timestamp() - interval '8 days',
                clock_timestamp() - interval '8 days'
         FROM runtime.object_current
         WHERE project_id = $1::uuid AND generation_id = $4::uuid`,
        [ids.project, ids.gcHeadSet, sha256Digest("g2-02-12-gc-head-set"), ids.gcGeneration],
      );
      await admin.query(
        `INSERT INTO runtime.object_head_versions (
           project_id, head_set_id, object_type_resource_id, object_rid,
           current_generation_id, object_type_revision_id, head_version,
           head_digest, base_value_digest, created_at, changed_at
         )
         SELECT project_id, $1::uuid, object_type_resource_id, object_rid,
                $2::uuid, object_type_revision_id, 1, base_value_digest,
                base_value_digest, clock_timestamp() - interval '8 days',
                clock_timestamp() - interval '8 days'
         FROM runtime.object_current
         WHERE project_id = $3::uuid AND generation_id = $2::uuid`,
        [ids.gcHeadSet, ids.gcGeneration, ids.project],
      );
      await admin.query(
        "ALTER TABLE ops.materialization_attempts DISABLE TRIGGER materialization_attempts_controlled_update",
      );
      await admin.query(
        `UPDATE ops.materialization_attempts
         SET leased_at = clock_timestamp() - interval '3 days',
             lease_expires_at = clock_timestamp() - interval '3 days' + interval '5 minutes',
             heartbeat_at = clock_timestamp() - interval '3 days',
             finished_at = clock_timestamp() - interval '2 days'
         WHERE project_id = $1::uuid AND attempt_id = $2::uuid`,
        [ids.project, ids.refresh2Attempt],
      );
      await admin.query(
        "ALTER TABLE ops.materialization_attempts ENABLE TRIGGER materialization_attempts_controlled_update",
      );
      await admin.query(
        "ALTER TABLE runtime.snapshot_upload_sessions DISABLE TRIGGER snapshot_upload_sessions_validate_insert",
      );
      await admin.query(
        `INSERT INTO runtime.snapshot_upload_sessions (
           project_id, session_id, created_by_principal_id, release_id,
           snapshot_group_id, group_version, group_member_count, member_key, member_kind,
           target_resource_id, target_revision_id, snapshot_schema_resource_id,
           snapshot_schema_revision_id, mapping_resource_id, mapping_revision_id,
           index_plan_digest, runtime_plan_digest, managed_artifact_id, object_key,
           allowed_media_type, expected_byte_count, max_byte_count, source_label,
           finalize_token_digest, state, uploaded_object_version, uploaded_byte_count,
           failure_code, expires_at, cleanup_after, created_at, changed_at
         )
         SELECT project_id, $1::uuid, created_by_principal_id, release_id,
                snapshot_group_id, group_version, group_member_count, member_key, member_kind,
                target_resource_id, target_revision_id, snapshot_schema_resource_id,
                snapshot_schema_revision_id, mapping_resource_id, mapping_revision_id,
                index_plan_digest, runtime_plan_digest, $2::uuid, $3,
                allowed_media_type, expected_byte_count, max_byte_count,
                'G2-02-12 orphan fixture', $4, 'failed', 'gc-exact-version-1',
                expected_byte_count, 'UPLOAD_ABORTED',
                clock_timestamp() - interval '3 days' + interval '15 minutes',
                clock_timestamp() - interval '2 days',
                clock_timestamp() - interval '3 days',
                clock_timestamp() - interval '2 days'
         FROM runtime.snapshot_upload_sessions
         WHERE project_id = $5::uuid AND session_id = $6::uuid`,
        [
          ids.gcOrphanSession,
          ids.gcOrphanArtifact,
          `ingress/50/${ids.gcOrphanArtifact}.csv`,
          sha256Digest("g2-02-12-gc-finalize-token"),
          ids.project,
          ids.ingressSession,
        ],
      );
      await admin.query(
        "ALTER TABLE runtime.snapshot_upload_sessions ENABLE TRIGGER snapshot_upload_sessions_validate_insert",
      );
      await admin.query(
        `INSERT INTO runtime.generation_measurements (
           project_id, generation_id, measurement_id, object_row_count, link_row_count,
           heap_bytes, fixed_index_bytes, dynamic_index_bytes, scanner_version,
           inventory_revision, measurement_digest
         )
         SELECT generation.project_id, generation.generation_id, gen_random_uuid(),
                (SELECT count(*) FROM runtime.object_base AS object_row
                  WHERE object_row.project_id = generation.project_id
                    AND object_row.generation_id = generation.generation_id),
                (SELECT count(*) FROM runtime.link_base AS link_row
                  WHERE link_row.project_id = generation.project_id
                    AND link_row.generation_id = generation.generation_id),
                COALESCE(physical.bytes, 0), 0, 0, 'g2-02-12-fixture-scanner-v1',
                inventory.inventory_revision + 1,
                'sha256:' || encode(sha256(convert_to(
                  generation.project_id::text || ':' || generation.generation_id::text ||
                  ':g2-02-12', 'UTF8')), 'hex')
         FROM runtime.generations AS generation
         JOIN runtime.project_runtime_inventories AS inventory
           ON inventory.project_id = generation.project_id
         LEFT JOIN LATERAL (
           SELECT sum(bytes)::bigint AS bytes FROM (
             SELECT pg_column_size(row_value)::bigint AS bytes
             FROM runtime.object_base AS row_value
             WHERE row_value.project_id = generation.project_id
               AND row_value.generation_id = generation.generation_id
             UNION ALL
             SELECT pg_column_size(row_value)::bigint
             FROM runtime.object_current AS row_value
             WHERE row_value.project_id = generation.project_id
               AND row_value.generation_id = generation.generation_id
             UNION ALL
             SELECT pg_column_size(row_value)::bigint
             FROM runtime.link_base AS row_value
             WHERE row_value.project_id = generation.project_id
               AND row_value.generation_id = generation.generation_id
             UNION ALL
             SELECT pg_column_size(row_value)::bigint
             FROM runtime.link_current AS row_value
             WHERE row_value.project_id = generation.project_id
               AND row_value.generation_id = generation.generation_id
           ) AS rows
         ) AS physical ON true
         WHERE generation.project_id = $1::uuid
           AND generation.state IN ('ready', 'active', 'retired')
           AND NOT EXISTS (
             SELECT 1 FROM runtime.generation_measurements AS measurement
             WHERE measurement.project_id = generation.project_id
               AND measurement.generation_id = generation.generation_id
           )`,
        [ids.project],
      );
      await admin.query(
        `UPDATE runtime.project_runtime_inventories
         SET state_revision = state_revision + 1,
             inventory_revision = inventory_revision + 1,
             measurement_complete = true,
             inventory_digest = $2,
             changed_at = clock_timestamp()
         WHERE project_id = $1::uuid`,
        [ids.project, sha256Digest("g2-02-12-complete-inventory")],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  });

  const apiPool = new pg.Pool(apiConfig);
  const deletedVersions: string[] = [];
  const gcBatchSize = 1;
  try {
    const repository = new PostgresGarbageCollectionRepository(apiPool);
    let failFirstOrphanAcknowledgement = true;
    const service = new GarbageCollectionService({
      repository: {
        readInventory: (projectId) => repository.readInventory(projectId),
        persistDryRun: (input) => repository.persistDryRun(input),
        claimOrphanUploadBatch: (input) => repository.claimOrphanUploadBatch(input),
        acknowledgeOrphanUpload: async (input) => {
          if (failFirstOrphanAcknowledgement) {
            failFirstOrphanAcknowledgement = false;
            throw new Error("injected orphan acknowledgement loss");
          }
          await repository.acknowledgeOrphanUpload(input);
        },
        commitNextRelationalBatch: (input) => repository.commitNextRelationalBatch(input),
      },
      crypto: projectionCapacityCrypto(),
      objectStore: {
        deleteVersion: (objectKey, objectVersion) => {
          assert.equal(objectKey, `ingress/50/${ids.gcOrphanArtifact}.csv`);
          assert.equal(objectVersion, "gc-exact-version-1");
          deletedVersions.push(`${objectKey}:${objectVersion}`);
          return Promise.resolve();
        },
      },
      batchSize: gcBatchSize,
    });
    const staleDryRun = await service.dryRun({
      projectId: ids.project,
      idempotencyKey: "g2-02-12-stale-plan-0001",
    });
    assert.equal(staleDryRun.analysis.status, "READY");
    assert.ok(staleDryRun.planId);

    await withClient(adminConfig, (admin) =>
      admin.query(
        `INSERT INTO ops.materialization_jobs (
           project_id, job_id, snapshot_group_id, group_version,
           idempotency_key, input_digest, correlation_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 4,
                   'g2-02-12-stale-root-job', $4, gen_random_uuid())`,
        [ids.project, ids.gcStaleJob, ids.snapshotGroup, sha256Digest("g2-02-12-stale-job")],
      ),
    );
    await assert.rejects(
      service.commitNext({ projectId: ids.project, planId: required(staleDryRun.planId) }),
      (error: unknown) =>
        error instanceof GarbageCollectionApplicationError && error.code === "GC_PLAN_STALE",
    );
    await withClient(apiConfig, async (api) => {
      const cancelled = await api.query<{ readonly state: string }>(
        `SELECT state FROM ops.request_materialization_job_cancel($1, $2, $3, 'GC_STALE_PROBE')`,
        [ids.project, ids.gcStaleJob, ids.principal],
      );
      assert.equal(cancelled.rows[0]?.state, "cancelled");
    });
    await assert.rejects(
      service.commitNext({ projectId: ids.project, planId: required(staleDryRun.planId) }),
      (error: unknown) =>
        error instanceof GarbageCollectionApplicationError && error.code === "GC_PLAN_STALE",
    );

    const dryRun = await service.dryRun({
      projectId: ids.project,
      idempotencyKey: "g2-02-12-relational-gc-0002",
    });
    assert.equal(dryRun.analysis.status, "READY");
    assert.ok(dryRun.planId);
    assert.equal(
      dryRun.analysis.protected.some(
        (entry) =>
          entry.kind === "GENERATION" &&
          entry.key === ids.generation &&
          entry.reasons.includes("HISTORICAL_ACTIVATION"),
      ),
      true,
    );
    assert.equal(
      dryRun.analysis.candidates.some(
        (entry) => entry.kind === "GENERATION" && entry.key === ids.gcGeneration,
      ),
      true,
    );
    assert.equal(
      dryRun.analysis.candidates.some(
        (entry) => entry.kind === "HEAD_SET" && entry.key === ids.gcHeadSet,
      ),
      true,
    );
    assert.equal(
      dryRun.analysis.candidates.some(
        (entry) => entry.kind === "ORPHAN_UPLOAD" && entry.key === ids.gcOrphanSession,
      ),
      true,
    );
    const planId = required(dryRun.planId);
    await assert.rejects(
      service.commitNext({ projectId: ids.project, planId }),
      (error: unknown) =>
        error instanceof GarbageCollectionApplicationError &&
        error.code === "GC_DEPENDENCY_UNAVAILABLE",
    );
    assert.equal(deletedVersions.length, 1);
    const orphanBatch = await service.commitNext({ projectId: ids.project, planId });
    assert.deepEqual(
      { phase: orphanBatch.phase, affectedRows: orphanBatch.affectedRows },
      { phase: "ORPHAN_UPLOAD", affectedRows: 1 },
    );
    let batches = 1;
    while ((await pendingGcCandidates(apiPool, planId)) > 0) {
      const before = await gcProgress(apiPool, planId);
      try {
        await killGcRelationalBatch(adminConfig, apiConfig, planId, gcBatchSize);
      } catch (error) {
        throw new Error(`GC kill boundary failed from ${JSON.stringify(before)}.`, {
          cause: error,
        });
      }
      assert.deepEqual(await gcProgress(apiPool, planId), before);
      const batch = await service.commitNext({ projectId: ids.project, planId });
      batches += 1;
      assert.equal(batch.affectedRows > 0 && batch.affectedRows <= gcBatchSize, true);
      if (batches > 100) throw new Error("GC did not converge within bounded batches.");
    }
    const completed = await service.commitNext({ projectId: ids.project, planId });
    assert.equal(completed.state, "COMMITTED");
    assert.equal(batches > 5, true);
    assert.equal(deletedVersions.length, 2);
    const replay = await service.commitNext({ projectId: ids.project, planId });
    assert.equal(replay.state, "COMMITTED");

    await withClient(adminConfig, async (admin) => {
      const result = await admin.query<{
        readonly baseRows: number;
        readonly currentRows: number;
        readonly provenanceRows: number;
        readonly generationCollected: boolean;
        readonly headSetCollected: boolean;
        readonly attemptCollected: boolean;
        readonly orphanCleaned: boolean;
        readonly historicalBaseRows: number;
        readonly historicalActivationMembers: number;
        readonly measurementComplete: boolean;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM runtime.object_base
             WHERE project_id = $1::uuid AND generation_id = $2::uuid) AS "baseRows",
           (SELECT count(*)::integer FROM runtime.object_current
             WHERE project_id = $1::uuid AND generation_id = $2::uuid) AS "currentRows",
           (SELECT count(*)::integer FROM runtime.property_provenance
             WHERE project_id = $1::uuid AND generation_id = $2::uuid) AS "provenanceRows",
           EXISTS (SELECT 1 FROM runtime.generation_collections
             WHERE project_id = $1::uuid AND generation_id = $2::uuid) AS "generationCollected",
           EXISTS (SELECT 1 FROM runtime.head_set_collections
             WHERE project_id = $1::uuid AND head_set_id = $3::uuid) AS "headSetCollected",
           EXISTS (SELECT 1 FROM ops.materialization_attempt_collections
             WHERE project_id = $1::uuid AND attempt_id = $4::uuid) AS "attemptCollected",
           EXISTS (SELECT 1 FROM runtime.snapshot_upload_sessions
             WHERE project_id = $1::uuid AND session_id = $5::uuid
               AND state = 'cleaned') AS "orphanCleaned",
           (SELECT count(*)::integer FROM runtime.object_base
             WHERE project_id = $1::uuid AND generation_id = $6::uuid) AS "historicalBaseRows",
           (SELECT count(*)::integer FROM meta.runtime_activation_members
             WHERE project_id = $1::uuid AND generation_id = $6::uuid) AS "historicalActivationMembers",
           (SELECT measurement_complete FROM runtime.project_runtime_inventories
             WHERE project_id = $1::uuid) AS "measurementComplete"`,
        [
          ids.project,
          ids.gcGeneration,
          ids.gcHeadSet,
          ids.refresh2Attempt,
          ids.gcOrphanSession,
          ids.generation,
        ],
      );
      assert.deepEqual(result.rows[0], {
        baseRows: 0,
        currentRows: 0,
        provenanceRows: 0,
        generationCollected: true,
        headSetCollected: true,
        attemptCollected: true,
        orphanCleaned: true,
        historicalBaseRows: capacityMetrics.objectRows,
        historicalActivationMembers: 2,
        measurementComplete: false,
      });
    });
    const blocked = await service.dryRun({
      projectId: ids.project,
      idempotencyKey: "g2-02-12-rescan-required-0003",
    });
    assert.equal(blocked.analysis.status, "BLOCKED");
    assert.deepEqual(blocked.analysis.candidates, []);
    assert.equal(blocked.analysis.blockedReasons.includes("MEASUREMENT_INCOMPLETE"), true);
  } finally {
    await apiPool.end();
  }
}

async function pendingGcCandidates(pool: pg.Pool, planId: string): Promise<number> {
  const result = await pool.query<{ readonly count: number }>(
    `SELECT count(*)::integer AS count
     FROM ops.gc_plan_entry_status
     WHERE project_id = $1::uuid AND gc_plan_id = $2::uuid
       AND disposition = 'CANDIDATE' AND completed_at IS NULL`,
    [ids.project, planId],
  );
  return required(result.rows[0]).count;
}

async function gcProgress(
  pool: pg.Pool,
  planId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const result = await pool.query<{
    readonly state: string;
    readonly phase: string;
    readonly currentStateRevision: string;
    readonly currentInventoryRevision: string;
    readonly pending: number;
  }>(
    `SELECT plan.state, plan.phase,
            plan.current_state_revision::text AS "currentStateRevision",
            plan.current_inventory_revision::text AS "currentInventoryRevision",
            (SELECT count(*)::integer FROM ops.gc_plan_entry_status AS entry
              WHERE entry.project_id = plan.project_id
                AND entry.gc_plan_id = plan.gc_plan_id
                AND entry.disposition = 'CANDIDATE'
                AND entry.completed_at IS NULL) AS pending
     FROM ops.gc_plan_status AS plan
     WHERE plan.project_id = $1::uuid AND plan.gc_plan_id = $2::uuid`,
    [ids.project, planId],
  );
  return Object.freeze({ ...required(result.rows[0]) });
}

async function killGcRelationalBatch(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
  planId: string,
  batchSize: number,
): Promise<void> {
  const blocker = new pg.Client(adminConfig);
  await blocker.connect();
  await blocker.query("BEGIN");
  await blocker.query("LOCK TABLE ops.gc_batch_events IN ACCESS EXCLUSIVE MODE");
  const environment = {
    ...process.env,
    ONTOS_GC_TEST_DATABASE_URL: postgresConnectionString(apiConfig),
  };
  const child = spawn(
    process.execPath,
    [
      gcCommitCliPath,
      "--project-id",
      ids.project,
      "--plan-id",
      planId,
      "--batch-size",
      String(batchSize),
    ],
    { env: environment, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  let backendPid: number | undefined;
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  try {
    await waitUntilCondition(
      async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`GC kill probe exited before blocking: ${stderr}`);
        }
        return withClient(adminConfig, async (admin) => {
          const result = await admin.query<{ readonly pid: number }>(
            `SELECT pid FROM pg_stat_activity
             WHERE application_name = 'ontos-gc-kill-probe'
               AND wait_event_type = 'Lock'
             ORDER BY backend_start DESC LIMIT 1`,
          );
          backendPid = result.rows[0]?.pid;
          return backendPid !== undefined;
        });
      },
      batchSize >= 1_000 ? 60_000 : 10_000,
    );
    assert.equal(child.kill("SIGKILL"), true);
    await waitForProcessExit(child);
    assert.equal(child.signalCode, "SIGKILL");
    if (backendPid !== undefined) {
      await withClient(adminConfig, async (admin) => {
        await admin.query("SELECT pg_terminate_backend($1::integer)", [backendPid]);
      });
      await waitUntilCondition(() =>
        withClient(adminConfig, async (admin) => {
          const result = await admin.query<{ readonly present: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1::integer) AS present",
            [backendPid],
          );
          return result.rows[0]?.present === false;
        }),
      );
    }
  } catch (error) {
    const activity = await withClient(adminConfig, async (admin) => {
      const result = await admin.query<{
        readonly state: string;
        readonly waitEventType: string | null;
        readonly waitEvent: string | null;
        readonly query: string;
      }>(
        `SELECT state, wait_event_type AS "waitEventType", wait_event AS "waitEvent",
                left(query, 256) AS query
         FROM pg_stat_activity
         WHERE application_name = 'ontos-gc-kill-probe'
         ORDER BY backend_start DESC`,
      );
      return result.rows;
    });
    throw new Error(`GC kill probe activity: ${JSON.stringify(activity)}.`, { cause: error });
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    await blocker.end().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function postgresConnectionString(config: pg.ClientConfig): string {
  return `postgresql://${encodeURIComponent(String(config.user))}:${encodeURIComponent(
    String(config.password),
  )}@${String(config.host)}:${String(config.port)}/${String(config.database)}`;
}

async function waitUntilCondition(
  action: () => Promise<boolean>,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await action()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the GC kill boundary.");
}

async function waitForProcessExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

interface ObjectHeadProbe {
  readonly object_rid: string;
  readonly current_generation_id: string;
  readonly head_version: number;
  readonly head_digest: string;
  readonly base_value_digest: string;
}

async function readObjectHeads(client: pg.Client): Promise<readonly ObjectHeadProbe[]> {
  const result = await client.query<ObjectHeadProbe>(
    `SELECT object_rid::text, current_generation_id::text, head_version::integer,
            head_digest, base_value_digest
     FROM runtime.object_heads
     WHERE project_id = $1 AND object_type_resource_id = $2
     ORDER BY object_rid`,
    [ids.project, ids.objectResource],
  );
  return result.rows;
}

async function readPublicationSequence(pool: pg.Pool): Promise<bigint> {
  const result = await pool.query<{ readonly revision: string }>(
    `SELECT publication_sequence::text AS revision FROM meta.projects WHERE project_id = $1`,
    [ids.project],
  );
  return BigInt(required(result.rows[0]).revision);
}

async function prepareRefreshFixture(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
  workerConfig: pg.ClientConfig,
  groupVersion: 3 | 4,
): Promise<void> {
  const fixture = refreshFixtureIds[groupVersion];
  const sourceSnapshotId = groupVersion === 3 ? ids.snapshot : ids.refresh2Snapshot;
  const sourceGenerationId = groupVersion === 3 ? ids.generation : ids.refresh2Generation;
  const reportDigest = sha256Digest(`g20211-refresh-report-${String(groupVersion)}`);
  const generationDigest = sha256Digest(`g20211-refresh-generation-${String(groupVersion)}`);
  const snapshotDigest = sha256Digest(`g20211-refresh-snapshot-${String(groupVersion)}`);
  const contentDigest = sha256Digest(`g20211-refresh-content-${String(groupVersion)}`);

  await withClient(adminConfig, async (admin) => {
    await admin.query("BEGIN");
    try {
      await admin.query(
        `INSERT INTO runtime.snapshot_group_versions
           (project_id, snapshot_group_id, group_version, member_count, group_digest)
         VALUES ($1, $2, $3, 1, $4)`,
        [
          ids.project,
          ids.snapshotGroup,
          groupVersion,
          sha256Digest(`g20211-refresh-group-${String(groupVersion)}`),
        ],
      );
      await admin.query(
        `INSERT INTO runtime.dataset_snapshots (
           project_id, snapshot_id, snapshot_group_id, group_version,
           member_key, member_kind, target_resource_id, target_revision_id,
           snapshot_schema_resource_id, snapshot_schema_revision_id,
           mapping_resource_id, mapping_revision_id, runtime_plan_digest,
           content_digest, byte_count, row_count, file_count, previous_snapshot_id,
           snapshot_digest
         )
         SELECT project_id, $1, snapshot_group_id, $2, member_key, member_kind,
                target_resource_id, target_revision_id, snapshot_schema_resource_id,
                snapshot_schema_revision_id, mapping_resource_id, mapping_revision_id,
                runtime_plan_digest, $3, byte_count, row_count, 1, snapshot_id, $4
         FROM runtime.dataset_snapshots
         WHERE project_id = $5 AND snapshot_id = $6`,
        [
          fixture.snapshotId,
          groupVersion,
          contentDigest,
          snapshotDigest,
          ids.project,
          sourceSnapshotId,
        ],
      );
      await admin.query(
        `INSERT INTO runtime.snapshot_files (
           project_id, snapshot_id, file_id, managed_artifact_id, object_version,
           ordinal, content_digest, byte_count, row_count, source_label, scan_status
         )
         SELECT project_id, $1, $2, $3, $4, 0, $5, byte_count, row_count,
                'G2-02-11 refresh fixture', 'complete'
         FROM runtime.dataset_snapshots
         WHERE project_id = $6 AND snapshot_id = $1`,
        [
          fixture.snapshotId,
          fixture.fileId,
          fixture.artifactId,
          `refresh-version-${String(groupVersion)}`,
          contentDigest,
          ids.project,
        ],
      );
      await admin.query(
        `INSERT INTO runtime.snapshot_group_members (
           project_id, snapshot_group_id, group_version, member_key, member_kind,
           snapshot_id, target_resource_id, target_revision_id
         ) VALUES ($1, $2, $3, 'object:Order', 'object', $4, $5, $6)`,
        [
          ids.project,
          ids.snapshotGroup,
          groupVersion,
          fixture.snapshotId,
          ids.objectResource,
          ids.objectRevision,
        ],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    for (const state of ["validated", "materializing"] as const) {
      await admin.query(
        `UPDATE runtime.snapshot_group_versions
         SET state = $4, changed_at = clock_timestamp()
         WHERE project_id = $1 AND snapshot_group_id = $2 AND group_version = $3`,
        [ids.project, ids.snapshotGroup, groupVersion, state],
      );
      await admin.query(
        `UPDATE runtime.dataset_snapshots
         SET state = $4, changed_at = clock_timestamp()
         WHERE project_id = $1 AND snapshot_group_id = $2 AND group_version = $3`,
        [ids.project, ids.snapshotGroup, groupVersion, state],
      );
    }
  });

  await withClient(apiConfig, async (api) => {
    const result = await api.query<{ readonly state: string; readonly reused: boolean }>(
      `SELECT state, reused FROM ops.ensure_runtime_refresh_job($1, $2, $3, $4, $5)`,
      [ids.project, fixture.jobId, ids.snapshotGroup, groupVersion, randomUUID()],
    );
    assert.deepEqual(result.rows[0], { state: "queued", reused: false });
  });

  await withClient(adminConfig, async (admin) => {
    await admin.query(
      `INSERT INTO runtime.generations (
         project_id, generation_id, member_key, member_kind,
         target_resource_id, target_revision_id, snapshot_id, snapshot_group_id,
         group_version, snapshot_schema_resource_id, snapshot_schema_revision_id,
         mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest
       )
       SELECT project_id, $1, member_key, member_kind, target_resource_id,
              target_revision_id, $2, snapshot_group_id, $3,
              snapshot_schema_resource_id, snapshot_schema_revision_id,
              mapping_resource_id, mapping_revision_id, runtime_plan_digest, index_plan_digest
       FROM runtime.generations
       WHERE project_id = $4 AND generation_id = $5`,
      [fixture.generationId, fixture.snapshotId, groupVersion, ids.project, sourceGenerationId],
    );
  });

  await withClient(workerConfig, async (worker) => {
    const claim = await worker.query<{ readonly job_id: string }>(
      `SELECT job_id FROM ops.claim_materialization_job_v2($1, $2, 300)`,
      [ids.worker1, fixture.attemptId],
    );
    assert.equal(claim.rows[0]?.job_id, fixture.jobId);
  });

  await withClient(adminConfig, async (admin) => {
    await admin.query("BEGIN");
    try {
      await admin.query(
        `WITH ranked AS (
           SELECT base.*, row_number() OVER (ORDER BY base.object_rid) AS ordinal
           FROM runtime.object_base AS base
           WHERE base.project_id = $1 AND base.generation_id = $2
         )
         INSERT INTO runtime.object_base (
           project_id, generation_id, object_type_resource_id, object_type_revision_id,
           object_rid, canonical_primary_key, properties, source_snapshot_id,
           source_file_id, source_row_number, mapping_revision_id, value_digest
         )
         SELECT project_id, $3, object_type_resource_id, object_type_revision_id,
                object_rid, canonical_primary_key,
                CASE WHEN $4::boolean AND ordinal = 1
                  THEN jsonb_set(properties, '{values,displayName,value}',
                    to_jsonb('Order refresh v3'::text), false)
                  ELSE properties END,
                $5, $6, source_row_number, mapping_revision_id,
                CASE WHEN $4::boolean AND ordinal = 1 THEN $7 ELSE value_digest END
         FROM ranked`,
        [
          ids.project,
          sourceGenerationId,
          fixture.generationId,
          groupVersion === 4,
          fixture.snapshotId,
          fixture.fileId,
          sha256Digest("g20211-refresh-v3-business-value"),
        ],
      );
      await admin.query(
        `WITH ranked AS (
           SELECT base.*, row_number() OVER (ORDER BY base.object_rid) AS ordinal
           FROM runtime.object_base AS base
           WHERE base.project_id = $1 AND base.generation_id = $2
         )
         INSERT INTO runtime.object_current (
           project_id, generation_id, object_type_resource_id, object_type_revision_id,
           object_rid, canonical_primary_key, properties, base_value_digest, lifecycle_state
         )
         SELECT base.project_id, base.generation_id, base.object_type_resource_id,
                base.object_type_revision_id, base.object_rid, base.canonical_primary_key,
                base.properties, base.value_digest,
                CASE WHEN $3::boolean AND base.ordinal = 2 THEN 'inactive'
                     ELSE old_current.lifecycle_state END
         FROM ranked AS base
         JOIN runtime.object_current AS old_current
           ON old_current.project_id = base.project_id
          AND old_current.generation_id = $4
          AND old_current.object_type_resource_id = base.object_type_resource_id
          AND old_current.object_rid = base.object_rid`,
        [ids.project, fixture.generationId, groupVersion === 4, sourceGenerationId],
      );
      await admin.query(
        `INSERT INTO runtime.property_provenance (
           project_id, generation_id, object_type_resource_id, object_rid,
           property_api_name, source_snapshot_id, source_file_id, source_row_number,
           input_column_ordinal, mapping_revision_id, algorithm_version, value_digest,
           source_index, source_kind, source_expression_digest
         )
         SELECT project_id, $1, object_type_resource_id, object_rid,
                property_api_name, $2, $3, source_row_number,
                input_column_ordinal, mapping_revision_id,
                'g2-02-11-refresh-rebuild-v1', value_digest,
                source_index, source_kind, source_expression_digest
         FROM runtime.property_provenance
         WHERE project_id = $4 AND generation_id = $5`,
        [fixture.generationId, fixture.snapshotId, fixture.fileId, ids.project, sourceGenerationId],
      );
      await admin.query(
        `INSERT INTO runtime.materialization_reports (
           project_id, report_id, snapshot_group_id, group_version, job_id, outcome,
           total_rows, accepted_rows, rejected_rows, validator_version, report_digest
         )
         SELECT $1, $2, $3, $4, $5, 'passed', count(*), count(*), 0,
                'g2-02-11-refresh-fixture-v1', $6
         FROM runtime.object_current
         WHERE project_id = $1 AND generation_id = $7`,
        [
          ids.project,
          fixture.reportId,
          ids.snapshotGroup,
          groupVersion,
          fixture.jobId,
          reportDigest,
          fixture.generationId,
        ],
      );
      await admin.query(
        `UPDATE runtime.generations
         SET report_id = $3, report_digest = $4, generation_digest = $5,
             changed_at = clock_timestamp()
         WHERE project_id = $1 AND generation_id = $2`,
        [ids.project, fixture.generationId, fixture.reportId, reportDigest, generationDigest],
      );
      await admin.query(
        `INSERT INTO runtime.materialization_quality_bindings (
           project_id, generation_id, report_id, report_digest,
           snapshot_digest, mapping_revision_digest, observation_digest,
           current_digest, provenance_digest, zero_overlay_row_count,
           state, quality_binding_digest
         )
         SELECT $1, $2, $3, $4, $5, revision.content_digest, $6, $7, $8, 0,
                'passed', $9
         FROM runtime.generations AS generation
         JOIN meta.resource_revisions AS revision
           ON revision.resource_id = generation.mapping_resource_id
          AND revision.revision_id = generation.mapping_revision_id
         WHERE generation.project_id = $1 AND generation.generation_id = $2`,
        [
          ids.project,
          fixture.generationId,
          fixture.reportId,
          reportDigest,
          snapshotDigest,
          sha256Digest(`g20211-refresh-observations-${String(groupVersion)}`),
          sha256Digest(`g20211-refresh-current-${String(groupVersion)}`),
          sha256Digest(`g20211-refresh-provenance-${String(groupVersion)}`),
          sha256Digest(`g20211-refresh-quality-${String(groupVersion)}`),
        ],
      );
      await admin.query(
        `UPDATE ops.materialization_attempts
         SET state = 'completed', finished_at = clock_timestamp(), result_code = 'SUCCEEDED'
         WHERE project_id = $1 AND attempt_id = $2 AND state = 'leased'`,
        [ids.project, fixture.attemptId],
      );
      await admin.query(
        `UPDATE ops.materialization_jobs
         SET state = 'succeeded', lease_owner_id = NULL, lease_expires_at = NULL,
             heartbeat_at = NULL, result_code = 'SUCCEEDED', result_digest = $3,
             updated_at = clock_timestamp()
         WHERE project_id = $1 AND job_id = $2`,
        [ids.project, fixture.jobId, sha256Digest(`g20211-refresh-job-${String(groupVersion)}`)],
      );
      for (const table of ["snapshot_group_versions", "dataset_snapshots"] as const) {
        await admin.query(
          `UPDATE runtime.${table}
           SET state = 'ready', changed_at = clock_timestamp()
           WHERE project_id = $1 AND snapshot_group_id = $2 AND group_version = $3`,
          [ids.project, ids.snapshotGroup, groupVersion],
        );
      }
      await admin.query(
        `UPDATE runtime.generations SET state = 'ready', changed_at = clock_timestamp()
         WHERE project_id = $1 AND generation_id = $2`,
        [ids.project, fixture.generationId],
      );
      await admin.query(
        `INSERT INTO runtime.capacity_admissions (
           project_id, admission_id, generation_id, phase, inventory_revision,
           index_plan_digest, source_forecast_digest, physical_measurement_digest,
           measured_bytes, observed_project_physical_bytes, reserved_bytes,
           steady_reserved_bytes, peak_reserved_bytes, report, report_digest
         )
         SELECT generation.project_id, $1, generation.generation_id, 'POSTBUILD',
                inventory.inventory_revision, generation.index_plan_digest, $2,
                inventory.inventory_digest, 0, 0, 0, 0, 0,
                '{"accepted":true,"fixture":"g2-02-11-refresh"}'::jsonb, $3
         FROM runtime.generations AS generation
         JOIN runtime.project_runtime_inventories AS inventory
           ON inventory.project_id = generation.project_id AND inventory.measurement_complete
         WHERE generation.project_id = $4 AND generation.generation_id = $5`,
        [
          fixture.capacityAdmissionId,
          sha256Digest(`g20211-refresh-forecast-${String(groupVersion)}`),
          sha256Digest(`g20211-refresh-capacity-${String(groupVersion)}`),
          ids.project,
          fixture.generationId,
        ],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  });

  await withClient(apiConfig, async (api) => {
    for (const [releaseId, certificateId] of [
      [ids.release2, fixture.release2CertificateId],
      [ids.release3, fixture.release3CertificateId],
    ] as const) {
      const issued = await api.query<{ readonly certificate_id: string }>(
        `SELECT certificate_id FROM runtime.issue_compatibility_certificate($1, $2, $3, $4)`,
        [certificateId, ids.project, fixture.generationId, releaseId],
      );
      assert.equal(issued.rows[0]?.certificate_id, certificateId);
    }
  });
}

async function publishRelease3(adminConfig: pg.ClientConfig, activationId: string): Promise<void> {
  await withClient(adminConfig, async (admin) => {
    await admin.query("BEGIN");
    try {
      await admin.query(
        `INSERT INTO meta.release_serving_heads
           (release_id, activation_id, control_sequence) VALUES ($1, $2, 1)`,
        [ids.release3, activationId],
      );
      await admin.query(
        `UPDATE meta.releases
         SET state = 'published', published_by_principal_id = $2,
             published_at = clock_timestamp(), changed_at = clock_timestamp()
         WHERE release_id = $1 AND state = 'ready'`,
        [ids.release3, ids.principal],
      );
      await admin.query(
        `UPDATE meta.releases SET state = 'superseded', changed_at = clock_timestamp()
         WHERE release_id = $1 AND state = 'published'`,
        [ids.release2],
      );
      await admin.query(
        `UPDATE meta.release_channels
         SET release_id = $2, activation_id = $3,
             control_sequence = control_sequence + 1, changed_at = clock_timestamp()
         WHERE project_id = $1 AND channel_name = 'production'`,
        [ids.project, ids.release3, activationId],
      );
      await admin.query(
        `UPDATE meta.projects
         SET publication_sequence = publication_sequence + 1,
             changed_at = clock_timestamp()
         WHERE project_id = $1`,
        [ids.project],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  });
}

async function assertRefreshLifecycle(
  adminConfig: pg.ClientConfig,
  groupVersion: number,
  expectedGenerationState: string,
  expectedSnapshotState: string,
): Promise<void> {
  const generationId =
    groupVersion === 1
      ? ids.generation
      : groupVersion === 3
        ? ids.refresh2Generation
        : ids.refresh3Generation;
  await withClient(adminConfig, async (admin) => {
    const result = await admin.query<{
      readonly generation_state: string;
      readonly snapshot_state: string;
      readonly group_state: string;
    }>(
      `SELECT
         (SELECT state FROM runtime.generations
          WHERE project_id = $1 AND generation_id = $4) AS generation_state,
         (SELECT state FROM runtime.dataset_snapshots
          WHERE project_id = $1 AND snapshot_group_id = $2 AND group_version = $3
            AND member_kind = 'object') AS snapshot_state,
         (SELECT state FROM runtime.snapshot_group_versions
          WHERE project_id = $1 AND snapshot_group_id = $2 AND group_version = $3) AS group_state`,
      [ids.project, ids.snapshotGroup, groupVersion, generationId],
    );
    assert.deepEqual(result.rows[0], {
      generation_state: expectedGenerationState,
      snapshot_state: expectedSnapshotState,
      group_state: expectedSnapshotState,
    });
  });
}

async function assertSemanticHeadDigestContract(adminConfig: pg.ClientConfig): Promise<void> {
  await withClient(adminConfig, async (admin) => {
    const base = sha256Digest("g20211-semantic-base");
    const firstLink = sha256Digest("g20211-semantic-link-a");
    const secondLink = sha256Digest("g20211-semantic-link-b");
    const result = await admin.query<{
      readonly plain: string;
      readonly inactive: string;
      readonly first_link: string;
      readonly second_link: string;
    }>(
      `SELECT
         ontos_migration.g20211_semantic_head_digest($1, 'active', NULL) AS plain,
         ontos_migration.g20211_semantic_head_digest($1, 'inactive', NULL) AS inactive,
         ontos_migration.g20211_semantic_head_digest($1, 'active', $2) AS first_link,
         ontos_migration.g20211_semantic_head_digest($1, 'active', $3) AS second_link`,
      [base, firstLink, secondLink],
    );
    assert.equal(result.rows[0]?.plain, base);
    assert.notEqual(result.rows[0]?.inactive, base);
    assert.notEqual(result.rows[0]?.first_link, result.rows[0]?.second_link);
  });
}

async function assertCapacityCutoverLinkSemantics(adminConfig: pg.ClientConfig): Promise<void> {
  await withClient(adminConfig, async (admin) => {
    const result = await admin.query<{ readonly linked_heads: number }>(
      `SELECT count(*)::integer AS linked_heads
       FROM runtime.object_heads
       WHERE project_id = $1 AND object_type_resource_id = $2
         AND head_digest <> base_value_digest`,
      [ids.project, ids.objectResource],
    );
    assert.equal((result.rows[0]?.linked_heads ?? 0) > 0, true);
  });
  await assertSemanticHeadDigestContract(adminConfig);
}

async function measureRepeatedCutovers(
  repository: PostgresSnapshotGroupCutoverRepository,
  pool: pg.Pool,
): Promise<{
  readonly runs: number;
  readonly p95Milliseconds: number;
  readonly maxMilliseconds: number;
  readonly samplesMilliseconds: readonly number[];
}> {
  const expectedControlRevision = await readPublicationSequence(pool);
  const overlayEvidence = zeroOverlayEvidence(4);
  const samples: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const preparation = await repository.prepareSnapshotGroupCutover({
      command: {
        projectId: ids.project,
        snapshotGroupId: ids.snapshotGroup,
        groupVersion: 4,
        expectedControlRevision,
        idempotencyKey: `g20211-performance-${String(index).padStart(4, "0")}`,
      },
      overlayEvidence,
    });
    const startedAt = process.hrtime.bigint();
    const result = await repository.commitSnapshotGroupCutover({ preparation, overlayEvidence });
    samples.push(elapsedMilliseconds(startedAt));
    assert.equal(result.changed, false);
  }
  const ordered = samples.toSorted((left, right) => left - right);
  return Object.freeze({
    runs: samples.length,
    p95Milliseconds: required(ordered[Math.ceil(ordered.length * 0.95) - 1]),
    maxMilliseconds: Math.max(...samples),
    samplesMilliseconds: Object.freeze(samples),
  });
}

async function prepareAndCommitA1(
  adminConfig: pg.ClientConfig,
  apiConfig: pg.ClientConfig,
): Promise<void> {
  const apiPool = new pg.Pool(apiConfig);
  const adminPool = new pg.Pool(adminConfig);
  try {
    const control = await apiPool.query<{ readonly revision: string }>(
      `SELECT publication_sequence::text AS revision
       FROM meta.projects WHERE project_id = $1`,
      [ids.project],
    );
    const expectedControlRevision = required(control.rows[0]).revision;
    const repository = new PostgresSnapshotGroupCutoverRepository(apiPool);
    const evidence = {
      providerId: "ontos.zero-overlay",
      providerVersion: "1",
      projectId: ids.project,
      snapshotGroupKey: `${ids.snapshotGroup}:1`,
      complete: true,
      watermark: 0,
      deltaCount: 0,
      digest: `sha256:${"0".repeat(64)}`,
    } as const;

    if (!projectionCapacityMode) {
      const before = await cutoverAtomicState(adminPool);
      for (const [index, faultPoint] of [
        "after_locks",
        "after_activations",
        "after_heads",
        "after_serving_heads",
        "after_channels",
        "after_lifecycle",
        "after_revisions",
        "after_result",
      ].entries()) {
        const preparation = await repository.prepareSnapshotGroupCutover({
          command: {
            projectId: ids.project,
            snapshotGroupId: ids.snapshotGroup,
            groupVersion: 1,
            expectedControlRevision: BigInt(expectedControlRevision),
            idempotencyKey: `g20211-fault-${String(index).padStart(4, "0")}`,
          },
          overlayEvidence: evidence,
        });
        await withClient(adminConfig, async (admin) => {
          await assert.rejects(
            admin.query(
              `SELECT * FROM ontos_migration.g20211_commit_snapshot_group_cutover(
                 $1, $2, $3, $4, $5, $6, $7, $8
               )`,
              [
                ids.project,
                preparation.preparationId,
                evidence.providerId,
                evidence.providerVersion,
                evidence.watermark,
                evidence.deltaCount,
                evidence.digest,
                faultPoint,
              ],
            ),
            (error: unknown) =>
              (error as { readonly code?: unknown }).code === "XX000" &&
              String((error as { readonly message?: unknown }).message).includes(faultPoint),
          );
        });
        assert.deepEqual(await cutoverAtomicState(adminPool), before);
      }
    }

    const coordinator = new SnapshotGroupCutoverCoordinator(repository);
    const command = {
      projectId: ids.project,
      snapshotGroupId: ids.snapshotGroup,
      groupVersion: 1,
      expectedControlRevision: BigInt(expectedControlRevision),
      idempotencyKey: "g20211-initial-cutover-0001",
    } as const;
    const preparation = await repository.prepareSnapshotGroupCutover({
      command,
      overlayEvidence: evidence,
    });
    const commitStartedAt = process.hrtime.bigint();
    const result = await repository.commitSnapshotGroupCutover({
      preparation,
      overlayEvidence: evidence,
    });
    const commitMilliseconds = elapsedMilliseconds(commitStartedAt);
    assert.equal(commitMilliseconds < 5_000, true);
    if (projectionCapacityMode) {
      process.stdout.write(
        `CI_G2_02_11_CUTOVER_CAPACITY ${JSON.stringify({
          objectRows: capacityMetrics.objectRows,
          linkRows: capacityMetrics.linkRows,
          preparationHeadRows: preparation.objectHeadCount,
          commitMilliseconds: Math.round(commitMilliseconds * 1_000) / 1_000,
        })}\n`,
      );
    }
    const release2 = result.releases.find((release) => release.releaseId === ids.release2);
    assert.ok(release2 !== undefined);
    assert.equal(release2.servingHeadMoved, false);
    activatedRelease2Id = release2.activationId;
    const retry = await coordinator.activate({
      projectId: ids.project,
      snapshotGroupId: ids.snapshotGroup,
      groupVersion: 1,
      expectedControlRevision,
      idempotencyKey: "g20211-initial-cutover-0001",
    });
    assert.equal(retry.reused, true);
    assert.equal(
      retry.releases.find((release) => release.releaseId === ids.release2)?.activationId,
      activatedRelease2Id,
    );
  } finally {
    await apiPool.end();
    await adminPool.end();
  }
}

async function cutoverAtomicState(pool: pg.Pool): Promise<unknown> {
  const result = await pool.query(
    `SELECT
       (SELECT COALESCE(jsonb_agg(jsonb_build_array(
          release_id::text, activation_id::text, activation_digest, member_count, state
        ) ORDER BY release_id, activation_id), '[]'::jsonb)
        FROM meta.runtime_activations WHERE release_id IN ($1, $2)) AS activations,
       (SELECT COALESCE(jsonb_agg(jsonb_build_array(
          release_id::text, activation_id::text, member_key, generation_id::text,
          snapshot_id::text, group_version, certificate_id::text
        ) ORDER BY release_id, activation_id, member_key COLLATE "C"), '[]'::jsonb)
        FROM meta.runtime_activation_members WHERE release_id IN ($1, $2)) AS members,
       (SELECT COALESCE(jsonb_agg(jsonb_build_array(
          object_type_resource_id::text, object_rid::text, current_generation_id::text,
          object_type_revision_id::text, head_version, head_digest, base_value_digest
        ) ORDER BY object_type_resource_id, object_rid), '[]'::jsonb)
        FROM runtime.object_heads WHERE project_id = $3) AS heads,
       (SELECT COALESCE(jsonb_agg(jsonb_build_array(
          release_id::text, activation_id::text, control_sequence
        ) ORDER BY release_id), '[]'::jsonb)
        FROM meta.release_serving_heads WHERE release_id IN ($1, $2)) AS serving,
       (SELECT jsonb_build_array(release_id::text, activation_id::text, control_sequence)
        FROM meta.release_channels WHERE project_id = $3 AND channel_name = 'production') AS channel,
       (SELECT publication_sequence FROM meta.projects WHERE project_id = $3) AS control,
       (SELECT jsonb_build_array(state_revision, inventory_revision)
        FROM runtime.project_runtime_inventories WHERE project_id = $3) AS inventory,
       (SELECT COALESCE(jsonb_agg(jsonb_build_array(
          snapshot_group_id::text, group_version, state
        ) ORDER BY snapshot_group_id, group_version), '[]'::jsonb)
        FROM runtime.snapshot_group_versions WHERE project_id = $3) AS group_versions,
       (SELECT COALESCE(jsonb_agg(jsonb_build_array(
          snapshot_id::text, snapshot_group_id::text, group_version, state
        ) ORDER BY snapshot_id), '[]'::jsonb)
        FROM runtime.dataset_snapshots WHERE project_id = $3) AS snapshots,
       (SELECT COALESCE(jsonb_agg(jsonb_build_array(
          generation_id::text, snapshot_group_id::text, group_version, state
        ) ORDER BY generation_id), '[]'::jsonb)
        FROM runtime.generations WHERE project_id = $3) AS generations,
       (SELECT COALESCE(jsonb_agg(jsonb_build_array(
          job_id::text, snapshot_group_id::text, group_version, state,
          fencing_token, result_code
        ) ORDER BY job_id), '[]'::jsonb)
        FROM ops.materialization_jobs WHERE project_id = $3) AS jobs`,
    [ids.release2, ids.release3, ids.project],
  );
  return result.rows[0];
}

async function publishA1(client: pg.Client): Promise<void> {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO meta.release_serving_heads
       (release_id, activation_id, control_sequence) VALUES ($1, $2, 1)`,
    [ids.release2, activatedRelease2Id],
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
    [ids.project, ids.release2, activatedRelease2Id],
  );
  await client.query(
    `UPDATE meta.projects
     SET publication_sequence = publication_sequence + 1,
         changed_at = clock_timestamp()
     WHERE project_id = $1`,
    [ids.project],
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
    [activatedRelease2Id],
  );
  assert.deepEqual(a1.rows[0], {
    member_count: projectionCapacityMode ? 2 : 1,
    actual_members: projectionCapacityMode ? 2 : 1,
    generation_state: "active",
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
      AND (tablename LIKE '%order%' OR tablename ~ '^release_[0-9]')`);
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
      `UPDATE runtime.dataset_snapshots
       SET snapshot_digest = $3, changed_at = clock_timestamp()
       WHERE project_id = $1 AND snapshot_id = $2`,
      [ids.project, ids.snapshot, sha256Artifact("forged-snapshot-digest")],
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
      `SELECT * FROM ops.enqueue_materialization_job(
         $1, $2, $3, 1, 'db02-worker-smoke-0001', $4, $5, 0
       )`,
      [ids.project, ids.leaseJob, ids.snapshotGroup, digestOf("1"), ids.leaseJob],
    );
  });

  let firstToken = 0n;
  await withClient(worker1Config, async (worker1) => {
    const claim = await worker1.query<{ readonly fencing_token: string }>(
      `SELECT * FROM ops.claim_materialization_job_v2($1, $2, 1)`,
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
    await admin.query("SELECT ops.reap_expired_materialization_jobs(32)");
    await admin.query(
      `UPDATE ops.materialization_jobs
       SET available_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE project_id = $1 AND job_id = $2 AND state = 'retry_wait'`,
      [ids.project, ids.leaseJob],
    );
  });

  await withClient(worker2Config, async (worker2) => {
    const claim = await worker2.query<{ readonly fencing_token: string }>(
      `SELECT * FROM ops.claim_materialization_job_v2($1, $2, 30)`,
      [ids.worker2, ids.attempt2],
    );
    assert.equal(BigInt(claim.rows[0]?.fencing_token ?? "0"), 2n);
    await worker2.query(`SELECT ops.write_materialization_staged_batch($1, $2, $3, 2, 1, $4, 10)`, [
      ids.project,
      ids.leaseJob,
      ids.attempt2,
      digests.batch2,
    ]);
    const stages = [
      [1, "scan", ids.checkpoint, ids.checkpointOutput1],
      [2, "map", ids.checkpoint2, ids.checkpointOutput2],
      [3, "validate", ids.checkpoint3, ids.checkpointOutput3],
      [4, "build_stage", ids.checkpoint4, ids.checkpointOutput4],
    ] as const;
    for (const [sequence, stage, checkpointId, outputReferenceId] of stages) {
      await worker2.query(
        `SELECT * FROM ops.complete_materialization_stage(
           $1, $2, $3, $4, 2, $5, $6, $7, $8, $9
         )`,
        [
          ids.project,
          ids.leaseJob,
          ids.attempt2,
          ids.worker2,
          checkpointId,
          sequence,
          stage,
          outputReferenceId,
          sha256Digest(`worker-${stage}`),
        ],
      );
    }
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
      readonly checkpoints: number;
      readonly batches: number;
      readonly staleCheckpoints: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM ops.materialization_checkpoints
           WHERE project_id = $1 AND job_id = $2) AS checkpoints,
         (SELECT count(*)::integer FROM ops.materialization_staged_batches
           WHERE project_id = $1 AND job_id = $2) AS batches,
         (SELECT count(*)::integer FROM ops.materialization_checkpoints
           WHERE project_id = $1 AND job_id = $2 AND attempt_id = $3) AS "staleCheckpoints"`,
      [ids.project, ids.leaseJob, ids.attempt1],
    );
    assert.deepEqual(rows.rows[0], { checkpoints: 4, batches: 2, staleCheckpoints: 0 });
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
      "SELECT count(*) FROM runtime.object_heads",
      "SELECT count(*) FROM runtime.object_head_sets",
      "SELECT count(*) FROM runtime.object_head_versions",
      "SELECT count(*) FROM runtime.project_object_head_pointers",
      "SELECT count(*) FROM runtime.snapshot_group_cutover_head_candidates",
      "SELECT count(*) FROM ops.object_base_staging",
      "SELECT count(*) FROM ops.link_base_staging",
      "UPDATE runtime.object_base SET properties = properties WHERE false",
      "DELETE FROM runtime.object_base WHERE false",
      "UPDATE runtime.link_base SET value_digest = value_digest WHERE false",
      "DELETE FROM runtime.link_base WHERE false",
      "UPDATE runtime.object_head_versions SET head_version = head_version WHERE false",
      "UPDATE runtime.project_object_head_pointers SET head_set_id = head_set_id WHERE false",
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
    await assertPgCode(
      api.query(
        `INSERT INTO ops.materialization_jobs
           (project_id, job_id, snapshot_group_id, group_version, idempotency_key, input_digest)
         VALUES ($1, $2, $3, 1, 'raw-job-insert-denied-0001', $4)`,
        [ids.project, randomUUID(), ids.snapshotGroup, digestOf("9")],
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
      "SELECT count(*) FROM runtime.object_heads",
      "SELECT count(*) FROM runtime.object_head_sets",
      "SELECT count(*) FROM runtime.object_head_versions",
      "SELECT count(*) FROM runtime.project_object_head_pointers",
      "UPDATE runtime.object_head_versions SET head_version = head_version WHERE false",
      "UPDATE runtime.project_object_head_pointers SET head_set_id = head_set_id WHERE false",
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
      "SELECT count(*) FROM runtime.object_heads",
      "SELECT count(*) FROM runtime.object_head_sets",
      "SELECT count(*) FROM runtime.object_head_versions",
      "SELECT count(*) FROM runtime.project_object_head_pointers",
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
  assert.equal(left.applied.length + right.applied.length, 20);
  assert.equal(Number(left.noOp) + Number(right.noOp), 1);
  await withClient(freshConfig, async (client) => {
    assert.equal((await runDatabaseMigrations(client)).noOp, true);
    assert.equal((await migrationLedger(client, 20)).length, 20);
  });
}

async function assertEveryDb02MigrationRollsBack(adminConfig: pg.ClientConfig): Promise<void> {
  const probes = new Map<
    number,
    { readonly relation: string } | { readonly functionSignature: string; readonly setting: string }
  >([
    [7, { relation: "runtime.snapshot_groups" }],
    [8, { relation: "runtime.object_identities" }],
    [9, { relation: "ops.materialization_jobs" }],
    [10, { relation: "runtime.snapshot_upload_sessions" }],
    [11, { relation: "ops.materialization_generation_stages" }],
    [12, { relation: "runtime.materialization_quality_bindings" }],
    [13, { relation: "ops.materialization_job_error_samples" }],
    [14, { relation: "ops.projection_ddl_requests" }],
    [15, { relation: "runtime.snapshot_group_definition_members" }],
    [16, { relation: "runtime.snapshot_group_cutover_preparations" }],
    [17, { relation: "ops.gc_plan_entries" }],
    [18, { relation: "ops.materialization_admin_report_samples" }],
    [19, { relation: "runtime.data_bearing_project_guard" }],
    [
      20,
      {
        functionSignature:
          "ops.prepare_materialization_staging_current(uuid,uuid,uuid,bigint,uuid,jsonb)",
        setting: "enable_nestloop=off",
      },
    ],
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
        const state =
          "relation" in probe
            ? await client.query<{
                readonly ledger_count: number;
                readonly probe_exists: boolean;
              }>(
                `SELECT
                   (SELECT count(*)::integer FROM ontos_migration.schema_migrations) AS ledger_count,
                   pg_catalog.to_regclass($1) IS NOT NULL AS probe_exists`,
                [probe.relation],
              )
            : await client.query<{
                readonly ledger_count: number;
                readonly probe_exists: boolean;
              }>(
                `SELECT
                   (SELECT count(*)::integer FROM ontos_migration.schema_migrations) AS ledger_count,
                   EXISTS (
                     SELECT 1
                     FROM pg_catalog.pg_proc AS procedure
                     WHERE procedure.oid = pg_catalog.to_regprocedure($1)
                       AND $2 = ANY(COALESCE(procedure.proconfig, ARRAY[]::text[]))
                   ) AS probe_exists`,
                [probe.functionSignature, probe.setting],
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
    "ops.gc_root_provider_registry",
    "ops.gc_root_epochs",
    "ops.gc_root_provider_scans",
    "ops.gc_plan_entries",
    "ops.gc_orphan_deletions",
    "ops.gc_batch_events",
    "ops.gc_execution_contexts",
    "ops.materialization_attempt_collections",
    "ops.materialization_attempts",
    "ops.materialization_checkpoints",
    "ops.materialization_jobs",
    "ops.materialization_job_error_samples",
    "ops.materialization_staged_batches",
    "ops.materialization_generation_stages",
    "ops.materialization_generation_stage_batches",
    "ops.materialization_quality_observations",
    "ops.materialization_quality_preparations",
    "ops.materialization_provenance_templates",
    "ops.object_base_staging",
    "ops.link_base_staging",
    "runtime.compatibility_certificates",
    "runtime.dataset_snapshots",
    "runtime.data_bearing_project_guard",
    "runtime.generations",
    "runtime.generation_collections",
    "runtime.head_set_collections",
    "runtime.materialization_report_collections",
    "runtime.link_base",
    "runtime.link_current",
    "runtime.materialization_confirmations",
    "runtime.materialization_quality_bindings",
    "runtime.object_base",
    "runtime.object_current",
    "runtime.object_head_candidates",
    "runtime.object_head_sets",
    "runtime.object_head_versions",
    "runtime.project_object_head_pointers",
    "runtime.object_identities",
    "runtime.snapshot_files",
    "runtime.snapshot_group_versions",
    "runtime.snapshot_groups",
    "runtime.snapshot_group_cutover_preparations",
    "runtime.snapshot_group_cutover_release_candidates",
    "runtime.snapshot_group_cutover_member_candidates",
    "runtime.snapshot_group_cutover_head_candidates",
    "runtime.snapshot_group_cutover_object_type_locks",
    "runtime.activation_content_bindings",
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

  const plannerGuards = await client.query<{
    readonly functionName: string;
    readonly proconfig: readonly string[];
  }>(`
    SELECT namespace.nspname || '.' || procedure.proname AS "functionName",
           COALESCE(procedure.proconfig, ARRAY[]::text[]) AS proconfig
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE procedure.oid = ANY(ARRAY[
      pg_catalog.to_regprocedure(
        'ops.prepare_materialization_staging_current(uuid,uuid,uuid,bigint,uuid,jsonb)'
      ),
      pg_catalog.to_regprocedure(
        'runtime.prepare_snapshot_group_cutover(uuid,uuid,bigint,bigint,text,text,text,bigint,bigint,text)'
      )
    ])
    ORDER BY "functionName"`);
  assert.deepEqual(
    plannerGuards.rows.map(({ functionName }) => functionName),
    ["ops.prepare_materialization_staging_current", "runtime.prepare_snapshot_group_cutover"],
  );
  for (const plannerGuard of plannerGuards.rows) {
    assert.deepEqual(
      [...plannerGuard.proconfig].sort(),
      plannerGuard.functionName === "runtime.prepare_snapshot_group_cutover"
        ? ["enable_nestloop=off", "jit=off", "search_path=pg_catalog"]
        : ["enable_nestloop=off", "search_path=pg_catalog"],
    );
  }
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
  if (projectionCapacityMode) {
    await client.query(`
      CREATE ROLE g20209_capacity_ddl_login LOGIN PASSWORD '${projectionDdlPassword}'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      GRANT migration_owner TO g20209_capacity_ddl_login;
      GRANT CONNECT ON DATABASE ${database} TO g20209_capacity_ddl_login;`);
  }
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
  const directory = await migrationPrefixDirectory(20);
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

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required integration fixture value is missing.");
  return value;
}

function isPostgreSqlError(value: unknown): value is { readonly code: string } {
  return typeof value === "object" && value !== null && "code" in value;
}
