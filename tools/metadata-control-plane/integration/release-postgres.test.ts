import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";

import {
  MetadataApplicationError,
  MetadataApplicationService,
  ReleaseLifecycleApplicationService,
  ResourceLifecycleApplicationService,
  RoleMatrixManagementAuthorizer,
  parseVerifiedFoundationIdentity,
  type VerifiedFoundationIdentity,
} from "@ontos/metadata-application";
import type { ResourceFamily } from "@ontos/contracts";
import {
  PostgresMetadataControlPlane,
  PostgresReleaseStore,
  type ReleasePublishFaultPoint,
} from "@ontos/metadata-postgres";
import pg from "pg";

import { runDatabaseMigrations } from "../../database/migrator.ts";
import { resolvePostgresTestImage } from "../../database/postgres-test-image.ts";

const execFileAsync = promisify(execFile);
const postgresImage = resolvePostgresTestImage();
const database = "ontos_g20108";
const adminPassword = "local-only-g20108-admin-secret";
const runtimePassword = "local-only-g20108-runtime-secret";
const publishFaultPoints: readonly ReleasePublishFaultPoint[] = [
  "after_activation",
  "after_serving_head",
  "after_revisions",
  "after_release",
  "after_channel",
  "after_project",
  "after_epoch",
];

void test(
  "G2-01-08 Release Validate, Stage, atomic Publish, CAS and Rollback",
  { timeout: 180_000 },
  async () => {
    const containerName = `ontos-g20108-${process.pid}-${randomUUID().slice(0, 8)}`;
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

    let pool: pg.Pool | null = null;
    try {
      const port = await publishedPostgreSqlPort(containerName);
      const adminConfig: pg.ClientConfig = {
        host: "127.0.0.1",
        port,
        database,
        user: "postgres",
        password: adminPassword,
        application_name: "ontos-g2-01-08-admin",
      };
      await waitForPostgreSql(adminConfig);
      await withClient(adminConfig, async (admin) => {
        await runDatabaseMigrations(admin);
        await admin.query(`ALTER ROLE api_runtime LOGIN PASSWORD '${runtimePassword}'`);
      });

      pool = new pg.Pool({
        ...adminConfig,
        user: "api_runtime",
        password: runtimePassword,
        application_name: "ontos-g2-01-08-runtime",
        max: 12,
      });
      const metadataStore = new PostgresMetadataControlPlane(pool);
      const releaseStore = new PostgresReleaseStore(pool);
      const authorizer = new RoleMatrixManagementAuthorizer(metadataStore);
      const metadata = new MetadataApplicationService({
        principals: metadataStore,
        projects: metadataStore,
        roleBindings: metadataStore,
        authorizer,
      });
      const resources = new ResourceLifecycleApplicationService({
        principals: metadataStore,
        resources: metadataStore,
        authorizer,
      });
      const releases = new ReleaseLifecycleApplicationService({
        principals: metadataStore,
        releases: releaseStore,
        authorizer,
      });

      const ownerIdentity = identity("release-owner");
      const editorIdentity = identity("release-editor");
      const ownerPrincipal = await metadataStore.resolveVerifiedIdentity(ownerIdentity);
      const editorPrincipal = await metadataStore.resolveVerifiedIdentity(editorIdentity);
      const project = await metadata.createProject(ownerIdentity, {
        apiName: "ReleaseProject",
        displayName: "Release Project",
      });
      await metadata.replaceRoleBinding(ownerIdentity, {
        projectId: project.project.projectId,
        targetPrincipalId: editorPrincipal.principalId,
        role: "editor",
        expectedEpoch: 1n,
      });

      const resource = await resources.createResource(ownerIdentity, {
        projectId: project.project.projectId,
        namespace: "release.core",
        apiName: "Order",
        family: "object_type",
        content: objectTypeContent("baseline"),
      });
      const baselineValidation = await resources.validateRevision(ownerIdentity, {
        revisionId: resource.initialDraft.revisionId,
      });
      assert.equal(baselineValidation.report.valid, true);

      const first = await releases.createRelease(editorIdentity, {
        projectId: project.project.projectId,
        targetChannelName: "stable",
        revisionIds: [baselineValidation.revision.revisionId],
      });
      const firstValidation = await releases.validateRelease(editorIdentity, {
        releaseId: first.releaseId,
      });
      assert.equal(firstValidation.report.valid, true);
      assert.equal(firstValidation.compatibility.outcome, "compatible");
      const firstStage = await releases.stageRelease(editorIdentity, {
        releaseId: first.releaseId,
      });
      assert.equal(firstStage.staged, true);
      assert.equal(firstStage.release.state, "ready");
      assert.equal(firstStage.release.stagedChannelControlSequence, 0n);
      await assert.rejects(
        releases.publishRelease(editorIdentity, {
          releaseId: first.releaseId,
          expectedChannelControlSequence: 0n,
        }),
        isApplicationError("FORBIDDEN"),
      );
      await assert.rejects(
        releaseStore.publishRelease({
          releaseId: first.releaseId,
          expectedChannelControlSequence: 0n,
          publishedByPrincipalId: editorPrincipal.principalId,
        }),
        isApplicationError("FORBIDDEN"),
      );

      const firstPublication = await releases.publishRelease(ownerIdentity, {
        releaseId: first.releaseId,
        expectedChannelControlSequence: 0n,
      });
      assert.equal(firstPublication.binding.releaseId, first.releaseId);
      assert.equal(firstPublication.binding.releaseRevisionId, first.releaseId);
      assert.equal(firstPublication.binding.manifestDigest, first.manifestDigest);
      assert.equal(firstPublication.channelControlSequence, 1n);
      assert.equal(firstPublication.projectPublicationSequence, 1n);
      assert.equal(firstPublication.authorizationEpoch, 3n);
      const repeated = await releases.publishRelease(ownerIdentity, {
        releaseId: first.releaseId,
        expectedChannelControlSequence: 0n,
      });
      assert.deepEqual(repeated, firstPublication);
      await assertPublishedWorld(pool, first.releaseId, firstPublication.binding.activationId, 1n);

      await assertServerDerivedRuntimePlanVector({
        adminConfig,
        pool,
        resources,
        releases,
        identityInput: ownerIdentity,
        projectId: project.project.projectId,
        baselineReleaseId: first.releaseId,
        orderResourceId: resource.resource.resourceId,
        orderRevisionId: baselineValidation.revision.revisionId,
      });

      const concurrentRevisionA = await createValidatedChild(
        resources,
        ownerIdentity,
        baselineValidation.revision.revisionId,
        "concurrent-a",
      );
      const concurrentRevisionB = await createValidatedChild(
        resources,
        ownerIdentity,
        baselineValidation.revision.revisionId,
        "concurrent-b",
      );
      const concurrentReleaseA = await createAndStage(
        releases,
        ownerIdentity,
        project.project.projectId,
        concurrentRevisionA.revisionId,
      );
      const concurrentReleaseB = await createAndStage(
        releases,
        ownerIdentity,
        project.project.projectId,
        concurrentRevisionB.revisionId,
      );
      assert.equal(concurrentReleaseA.stagedChannelControlSequence, 1n);
      assert.equal(concurrentReleaseB.stagedChannelControlSequence, 1n);

      const concurrentResults = await Promise.allSettled([
        releases.publishRelease(ownerIdentity, {
          releaseId: concurrentReleaseA.releaseId,
          expectedChannelControlSequence: 1n,
        }),
        releases.publishRelease(ownerIdentity, {
          releaseId: concurrentReleaseB.releaseId,
          expectedChannelControlSequence: 1n,
        }),
      ]);
      const fulfilled = concurrentResults.filter(
        (
          result,
        ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof releases.publishRelease>>> =>
          result.status === "fulfilled",
      );
      const rejected = concurrentResults.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.ok(isApplicationError("CONCURRENT_MODIFICATION")(rejected[0]?.reason));
      const concurrentPublication = requireValue(fulfilled[0]).value;
      const concurrentReleaseId = concurrentPublication.binding.releaseId;
      const concurrentRevisionId =
        concurrentReleaseId === concurrentReleaseA.releaseId
          ? concurrentRevisionA.revisionId
          : concurrentRevisionB.revisionId;
      assert.equal(concurrentPublication.channelControlSequence, 2n);

      for (const point of publishFaultPoints) {
        const candidateRevision = await createValidatedChild(
          resources,
          ownerIdentity,
          concurrentRevisionId,
          `fault-${point}`,
        );
        const candidate = await createAndStage(
          releases,
          ownerIdentity,
          project.project.projectId,
          candidateRevision.revisionId,
        );
        const before = await publicationSnapshot(
          pool,
          project.project.projectId,
          candidate.releaseId,
        );
        const faultingStore = new PostgresReleaseStore(pool, {
          faultInjector(actual) {
            if (actual === point) throw new Error(`injected:${point}`);
          },
        });
        await assert.rejects(
          faultingStore.publishRelease({
            releaseId: candidate.releaseId,
            expectedChannelControlSequence: 2n,
            publishedByPrincipalId: ownerPrincipal.principalId,
          }),
          isApplicationError("STORAGE_FAILURE"),
        );
        const after = await publicationSnapshot(
          pool,
          project.project.projectId,
          candidate.releaseId,
        );
        assert.deepEqual(after, before, `publication fault ${point} must roll back every fact`);
        assert.equal(after.candidate_release_state, "ready");
        assert.equal(after.activation_count, 0);
        assert.equal(after.serving_head_count, 0);
        const stateResult: pg.QueryResult<{ readonly state: string }> = await pool.query(
          `SELECT state FROM meta.resource_revisions WHERE revision_id = $1`,
          [candidateRevision.revisionId],
        );
        assert.equal(stateResult.rows[0]?.state, "validated");
      }
      // G2_NEGATIVE:partial_publish

      const orphanTarget = await createAndStage(
        releases,
        ownerIdentity,
        project.project.projectId,
        concurrentRevisionId,
      );
      const preparedActivationId = randomUUID();
      await pool.query(
        `INSERT INTO meta.runtime_activations
           (activation_id, release_id, activation_digest)
         VALUES ($1, $2, $3)`,
        [preparedActivationId, orphanTarget.releaseId, `sha256:${"a".repeat(64)}`],
      );
      const prepared = await pool.query<{
        readonly activation_count: number;
        readonly serving_head_count: number;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM meta.runtime_activations
            WHERE release_id = $1) AS activation_count,
           (SELECT count(*)::integer FROM meta.release_serving_heads
            WHERE release_id = $1) AS serving_head_count`,
        [orphanTarget.releaseId],
      );
      assert.deepEqual(prepared.rows[0], { activation_count: 1, serving_head_count: 0 });

      const staleRevision = await createValidatedChild(
        resources,
        ownerIdentity,
        concurrentRevisionId,
        "stale-after-stage",
      );
      const staleStableRelease = await createAndStage(
        releases,
        ownerIdentity,
        project.project.projectId,
        staleRevision.revisionId,
      );
      const canaryDraft = await releases.createRelease(ownerIdentity, {
        projectId: project.project.projectId,
        targetChannelName: "canary",
        revisionIds: [staleRevision.revisionId],
      });
      const canaryStage = await releases.stageRelease(ownerIdentity, {
        releaseId: canaryDraft.releaseId,
      });
      assert.equal(canaryStage.staged, true);
      await releases.publishRelease(ownerIdentity, {
        releaseId: canaryDraft.releaseId,
        expectedChannelControlSequence: 0n,
      });
      await assert.rejects(
        releases.publishRelease(ownerIdentity, {
          releaseId: staleStableRelease.releaseId,
          expectedChannelControlSequence: 2n,
        }),
        isApplicationError("CONCURRENT_MODIFICATION"),
      );
      const stableAfterStale = await pool.query<{ readonly release_id: string }>(
        `SELECT release_id
         FROM meta.release_channels
         WHERE project_id = $1 AND channel_name = 'stable'`,
        [project.project.projectId],
      );
      assert.equal(stableAfterStale.rows[0]?.release_id, concurrentReleaseId);

      const historicalBefore = await historicalSnapshot(pool, first.releaseId);
      const rollback = await releases.rollbackRelease(ownerIdentity, {
        releaseId: first.releaseId,
        expectedChannelControlSequence: 2n,
      });
      assert.notEqual(rollback.release.releaseId, first.releaseId);
      assert.equal(rollback.release.rollbackOfReleaseId, first.releaseId);
      assert.equal(rollback.validation.report.valid, true);
      assert.equal(rollback.publication.channelControlSequence, 3n);
      assert.equal(rollback.publication.binding.manifestDigest, rollback.release.manifestDigest);
      const rollbackFacts = await pool.query<{
        readonly state: string;
        readonly activation_id: string;
        readonly rollback_of_release_id: string | null;
      }>(
        `SELECT release.state, head.activation_id, release.rollback_of_release_id
         FROM meta.releases AS release
         JOIN meta.release_serving_heads AS head ON head.release_id = release.release_id
         WHERE release.release_id = $1`,
        [rollback.release.releaseId],
      );
      assert.deepEqual(rollbackFacts.rows[0], {
        state: "published",
        activation_id: rollback.publication.binding.activationId,
        rollback_of_release_id: first.releaseId,
      });
      assert.deepEqual(await historicalSnapshot(pool, first.releaseId), historicalBefore);
    } finally {
      await pool?.end();
      await docker(["rm", "--force", "--volumes", containerName], true);
    }
  },
);

async function assertServerDerivedRuntimePlanVector(input: {
  readonly adminConfig: pg.ClientConfig;
  readonly pool: pg.Pool;
  readonly resources: ResourceLifecycleApplicationService;
  readonly releases: ReleaseLifecycleApplicationService;
  readonly identityInput: VerifiedFoundationIdentity;
  readonly projectId: string;
  readonly baselineReleaseId: string;
  readonly orderResourceId: string;
  readonly orderRevisionId: string;
}): Promise<void> {
  const customer = await createValidatedRuntimeResource(input, {
    apiName: "Customer",
    family: "object_type",
    content: runtimeObjectTypeContent("Customer"),
  });
  const link = await createValidatedRuntimeResource(input, {
    apiName: "OrderToCustomer",
    family: "link_type",
    content: runtimeLinkTypeContent(input.orderRevisionId, customer.revision.revisionId),
  });
  const orderSchema = await createValidatedRuntimeResource(input, {
    apiName: "OrderSnapshot",
    family: "snapshot_schema",
    content: runtimeObjectSchema("orderId"),
  });
  const customerSchema = await createValidatedRuntimeResource(input, {
    apiName: "CustomerSnapshot",
    family: "snapshot_schema",
    content: runtimeObjectSchema("customerId"),
  });
  const linkSchema = await createValidatedRuntimeResource(input, {
    apiName: "OrderCustomerLinkSnapshot",
    family: "snapshot_schema",
    content: runtimeLinkSchema(),
  });
  const orderMapping = await createValidatedRuntimeResource(input, {
    apiName: "OrderSnapshotMapping",
    family: "mapping",
    content: runtimeObjectMapping({
      schemaRevisionId: orderSchema.revision.revisionId,
      targetResourceId: input.orderResourceId,
      targetRevisionId: input.orderRevisionId,
      keyColumn: "orderId",
    }),
  });
  const customerMapping = await createValidatedRuntimeResource(input, {
    apiName: "CustomerSnapshotMapping",
    family: "mapping",
    content: runtimeObjectMapping({
      schemaRevisionId: customerSchema.revision.revisionId,
      targetResourceId: customer.resource.resourceId,
      targetRevisionId: customer.revision.revisionId,
      keyColumn: "customerId",
    }),
  });
  const linkMapping = await createValidatedRuntimeResource(input, {
    apiName: "OrderCustomerLinkMapping",
    family: "mapping",
    content: runtimeLinkMapping({
      schemaRevisionId: linkSchema.revision.revisionId,
      targetResourceId: link.resource.resourceId,
      targetRevisionId: link.revision.revisionId,
      sourceRevisionId: input.orderRevisionId,
      targetRevisionIdForKey: customer.revision.revisionId,
    }),
  });

  const draft = await input.releases.createRelease(input.identityInput, {
    projectId: input.projectId,
    targetChannelName: "stable",
    revisionIds: [
      input.orderRevisionId,
      customer.revision.revisionId,
      link.revision.revisionId,
      orderSchema.revision.revisionId,
      customerSchema.revision.revisionId,
      linkSchema.revision.revisionId,
      orderMapping.revision.revisionId,
      customerMapping.revision.revisionId,
      linkMapping.revision.revisionId,
    ],
  });
  const groupId = randomUUID();
  const objectPlans = [
    {
      id: randomUUID(),
      targetResourceId: input.orderResourceId,
      targetRevisionId: input.orderRevisionId,
      digest: fixedDigest("1"),
    },
    {
      id: randomUUID(),
      targetResourceId: customer.resource.resourceId,
      targetRevisionId: customer.revision.revisionId,
      digest: fixedDigest("2"),
    },
  ] as const;
  await withClient(input.adminConfig, async (admin) => {
    await admin.query(
      `INSERT INTO runtime.project_runtime_inventories
         (project_id, state_revision, inventory_revision, measurement_complete, inventory_digest)
       VALUES ($1, 1, 1, true, $2)`,
      [input.projectId, fixedDigest("3")],
    );
  });
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO runtime.snapshot_groups
         (project_id, snapshot_group_id, group_key, definition_member_count)
       VALUES ($1, $2, 'order-customer', 3)`,
      [input.projectId, groupId],
    );
    const mappings = [
      orderMapping.resource.resourceId,
      customerMapping.resource.resourceId,
      linkMapping.resource.resourceId,
    ].sort();
    for (const [ordinal, mappingResourceId] of mappings.entries()) {
      await client.query(
        `INSERT INTO runtime.snapshot_group_definition_members
           (project_id, snapshot_group_id, ordinal, mapping_resource_id)
         VALUES ($1, $2, $3, $4)`,
        [input.projectId, groupId, ordinal, mappingResourceId],
      );
    }
    for (const [ordinal, plan] of objectPlans.entries()) {
      await client.query(
        `INSERT INTO runtime.index_plans
           (project_id, index_plan_id, target_resource_id, target_revision_id,
            plan_digest, entry_count, compiler_version)
         VALUES ($1, $2, $3, $4, $5, 0, 'g2-02-10-pg-vector-v1')`,
        [input.projectId, plan.id, plan.targetResourceId, plan.targetRevisionId, plan.digest],
      );
      await client.query(
        `INSERT INTO runtime.index_plan_admissions (
           project_id, admission_id, release_id, release_plan_digest,
           index_plan_id, inventory_revision, release_units, project_union_units,
           project_physical_index_count, admission_mode, report_digest
         ) VALUES ($1, $2, $3, $4, $5, 1, 0, 0, 0, 'WITHIN_NORMAL', $6)`,
        [
          input.projectId,
          randomUUID(),
          draft.releaseId,
          fixedDigest("4"),
          plan.id,
          fixedDigest(ordinal === 0 ? "5" : "6"),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const staged = await input.releases.stageRelease(input.identityInput, {
    releaseId: draft.releaseId,
  });
  assert.equal(staged.staged, true, JSON.stringify(staged.report.issues));
  assert.equal(staged.report.valid, true);
  assert.equal(staged.release.state, "staging");
  const plan = await input.pool.query<{
    readonly plan_digest: string;
    readonly member_count: number;
    readonly member_keys: string[];
    readonly group_ids: string[];
  }>(
    `SELECT root.plan_digest, root.member_count,
            array_agg(member.member_key ORDER BY member.member_key COLLATE "C") AS member_keys,
            array_agg(DISTINCT member.snapshot_group_id::text) AS group_ids
     FROM meta.release_runtime_plans AS root
     JOIN meta.release_runtime_plan_members AS member
       ON member.release_id = root.release_id
     WHERE root.release_id = $1
     GROUP BY root.plan_digest, root.member_count`,
    [draft.releaseId],
  );
  assert.deepEqual(plan.rows[0], {
    plan_digest: plan.rows[0]?.plan_digest,
    member_count: 3,
    member_keys: ["link:OrderToCustomer", "object:Customer", "object:Order"],
    group_ids: [groupId],
  });
  const originalDigest = plan.rows[0]?.plan_digest;
  assert.ok(originalDigest !== undefined);
  const repeated = await input.releases.stageRelease(input.identityInput, {
    releaseId: draft.releaseId,
  });
  assert.equal(repeated.release.state, "staging");
  const after = await input.pool.query<{ readonly plan_digest: string }>(
    `SELECT plan_digest FROM meta.release_runtime_plans WHERE release_id = $1`,
    [draft.releaseId],
  );
  assert.equal(after.rows[0]?.plan_digest, originalDigest);
  const baseline = await input.pool.query<{
    readonly plan_count: number;
    readonly activation_member_count: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM meta.release_runtime_plans
        WHERE release_id = $1) AS plan_count,
       (SELECT activation.member_count
        FROM meta.release_serving_heads AS head
        JOIN meta.runtime_activations AS activation
          ON activation.release_id = head.release_id
         AND activation.activation_id = head.activation_id
        WHERE head.release_id = $1) AS activation_member_count`,
    [input.baselineReleaseId],
  );
  assert.deepEqual(baseline.rows[0], { plan_count: 0, activation_member_count: 0 });
}

async function createValidatedRuntimeResource(
  input: {
    readonly resources: ResourceLifecycleApplicationService;
    readonly identityInput: VerifiedFoundationIdentity;
    readonly projectId: string;
  },
  resource: {
    readonly apiName: string;
    readonly family: ResourceFamily;
    readonly content: unknown;
  },
) {
  const created = await input.resources.createResource(input.identityInput, {
    projectId: input.projectId,
    namespace: "release.runtime",
    apiName: resource.apiName,
    family: resource.family,
    content: resource.content,
  });
  const validation = await input.resources.validateRevision(input.identityInput, {
    revisionId: created.initialDraft.revisionId,
  });
  assert.equal(validation.report.valid, true);
  return Object.freeze({ resource: created.resource, revision: validation.revision });
}

async function createAndStage(
  releases: ReleaseLifecycleApplicationService,
  identityInput: VerifiedFoundationIdentity,
  projectId: string,
  revisionId: string,
) {
  const draft = await releases.createRelease(identityInput, {
    projectId,
    targetChannelName: "stable",
    revisionIds: [revisionId],
  });
  const staged = await releases.stageRelease(identityInput, { releaseId: draft.releaseId });
  assert.equal(staged.staged, true);
  assert.equal(staged.report.valid, true);
  return staged.release;
}

async function createValidatedChild(
  resources: ResourceLifecycleApplicationService,
  identityInput: VerifiedFoundationIdentity,
  sourceRevisionId: string,
  marker: string,
) {
  const draft = await resources.createChildDraft(identityInput, {
    sourceRevisionId,
    content: objectTypeContent(marker),
  });
  const validation = await resources.validateRevision(identityInput, {
    revisionId: draft.revisionId,
  });
  assert.equal(validation.report.valid, true);
  return validation.revision;
}

async function assertPublishedWorld(
  pool: pg.Pool,
  releaseId: string,
  activationId: string,
  sequence: bigint,
): Promise<void> {
  const result = await pool.query<{
    readonly release_state: string;
    readonly channel_release_id: string;
    readonly channel_activation_id: string;
    readonly channel_sequence: string;
    readonly head_activation_id: string;
    readonly member_count: number;
  }>(
    `SELECT release.state AS release_state,
            channel.release_id AS channel_release_id,
            channel.activation_id AS channel_activation_id,
            channel.control_sequence::text AS channel_sequence,
            head.activation_id AS head_activation_id,
            activation.member_count
     FROM meta.releases AS release
     JOIN meta.release_channels AS channel
       ON channel.project_id = release.project_id
      AND channel.channel_name = release.target_channel_name
     JOIN meta.release_serving_heads AS head ON head.release_id = release.release_id
     JOIN meta.runtime_activations AS activation
       ON activation.release_id = head.release_id
      AND activation.activation_id = head.activation_id
     WHERE release.release_id = $1`,
    [releaseId],
  );
  assert.deepEqual(result.rows[0], {
    release_state: "published",
    channel_release_id: releaseId,
    channel_activation_id: activationId,
    channel_sequence: sequence.toString(),
    head_activation_id: activationId,
    member_count: 0,
  });
}

async function publicationSnapshot(pool: pg.Pool, projectId: string, releaseId: string) {
  const result = await pool.query<{
    readonly channel_release_id: string;
    readonly channel_activation_id: string;
    readonly channel_sequence: string;
    readonly project_sequence: string;
    readonly authorization_epoch: string;
    readonly candidate_release_state: string;
    readonly activation_count: number;
    readonly serving_head_count: number;
    readonly pin_count: number;
  }>(
    `SELECT channel.release_id AS channel_release_id,
            channel.activation_id AS channel_activation_id,
            channel.control_sequence::text AS channel_sequence,
            project.publication_sequence::text AS project_sequence,
            epoch.epoch::text AS authorization_epoch,
            candidate.state AS candidate_release_state,
            (SELECT count(*)::integer FROM meta.runtime_activations
             WHERE release_id = candidate.release_id) AS activation_count,
            (SELECT count(*)::integer FROM meta.release_serving_heads
             WHERE release_id = candidate.release_id) AS serving_head_count,
            (SELECT count(*)::integer FROM meta.release_pins
             WHERE release_id = candidate.release_id) AS pin_count
     FROM meta.projects AS project
     JOIN authz.authorization_epochs AS epoch ON epoch.project_id = project.project_id
     JOIN meta.release_channels AS channel
       ON channel.project_id = project.project_id AND channel.channel_name = 'stable'
     JOIN meta.releases AS candidate ON candidate.release_id = $2
     WHERE project.project_id = $1`,
    [projectId, releaseId],
  );
  return requireValue(result.rows[0]);
}

async function historicalSnapshot(pool: pg.Pool, releaseId: string) {
  const result = await pool.query<{
    readonly release_id: string;
    readonly manifest_digest: string;
    readonly state: string;
    readonly pins: unknown;
  }>(
    `SELECT release.release_id,
            release.manifest_digest,
            release.state,
            jsonb_agg(
              jsonb_build_object(
                'resourceId', pin.resource_id,
                'revisionId', pin.revision_id,
                'family', pin.family,
                'digest', pin.content_digest,
                'order', pin.pin_order
              ) ORDER BY pin.pin_order
            ) AS pins
     FROM meta.releases AS release
     JOIN meta.release_pins AS pin ON pin.release_id = release.release_id
     WHERE release.release_id = $1
     GROUP BY release.release_id`,
    [releaseId],
  );
  return requireValue(result.rows[0]);
}

function objectTypeContent(marker: string) {
  return {
    schemaVersion: 1,
    apiName: "Order",
    displayName: "Order",
    description: `Release lifecycle ${marker}`,
    primaryKeyPropertyApiName: "id",
    titlePropertyApiName: "id",
    defaultSearchPropertyApiNames: [],
    defaultSort: [{ propertyApiName: "id", direction: "asc" }],
    defaultClassification: "internal",
    properties: [
      {
        schemaVersion: 1,
        apiName: "id",
        displayName: "ID",
        description: "Stable source identifier.",
        valueType: "string",
        caseSensitive: true,
        nullable: false,
        writeMode: "source_only",
        unique: true,
        filterable: true,
        sortable: true,
        searchable: false,
        classification: "internal",
      },
    ],
  };
}

function runtimeObjectTypeContent(apiName: string) {
  const key = apiName === "Customer" ? "customerId" : "orderId";
  return {
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `G2-02-10 ${apiName} Runtime Plan vector.`,
    primaryKeyPropertyApiName: key,
    titlePropertyApiName: key,
    defaultSearchPropertyApiNames: [],
    defaultSort: [{ propertyApiName: key, direction: "asc" }],
    defaultClassification: "internal",
    properties: [
      {
        schemaVersion: 1,
        apiName: key,
        displayName: `${apiName} ID`,
        description: "Stable source identifier.",
        valueType: "string",
        caseSensitive: true,
        nullable: false,
        writeMode: "source_only",
        unique: true,
        filterable: true,
        sortable: true,
        searchable: false,
        classification: "internal",
      },
    ],
  };
}

function runtimeObjectSchema(keyColumn: string) {
  return {
    schemaVersion: 1,
    contractVersion: "snapshot-schema-v1",
    format: "csv_utf8",
    headerRow: true,
    columns: [{ ordinal: 0, columnApiName: keyColumn, valueType: "string", required: true }],
  };
}

function runtimeLinkTypeContent(sourceRevisionId: string, targetRevisionId: string) {
  return {
    schemaVersion: 1,
    apiName: "OrderToCustomer",
    displayName: "Order to Customer",
    description: "G2-02-10 base Link Runtime Plan vector.",
    source: {
      objectTypeRevisionId: sourceRevisionId,
      apiName: "order",
      displayName: "Order",
    },
    target: {
      objectTypeRevisionId: targetRevisionId,
      apiName: "customer",
      displayName: "Customer",
    },
    cardinality: "many_to_one",
    sourceKind: "base",
    deletionBehavior: "restrict",
    actionCreateAllowed: false,
    actionDeleteAllowed: false,
  };
}

function runtimeLinkSchema() {
  return {
    schemaVersion: 1,
    contractVersion: "snapshot-schema-v1",
    format: "csv_utf8",
    headerRow: true,
    columns: [
      { ordinal: 0, columnApiName: "orderId", valueType: "string", required: true },
      { ordinal: 1, columnApiName: "customerId", valueType: "string", required: true },
    ],
  };
}

function runtimeObjectMapping(input: {
  readonly schemaRevisionId: string;
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly keyColumn: string;
}) {
  return {
    schemaVersion: 1,
    mappingVersion: "mapping-v1",
    targetKind: "object",
    inputSchemaRevisionId: input.schemaRevisionId,
    targetResourceId: input.targetResourceId,
    targetRevisionId: input.targetRevisionId,
    valueCodecVersion: "pk1",
    propertyMappings: [],
    primaryKeyExpression: { op: "column", columnApiName: input.keyColumn },
    qualityRules: runtimeQualityRules(),
  };
}

function runtimeLinkMapping(input: {
  readonly schemaRevisionId: string;
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly sourceRevisionId: string;
  readonly targetRevisionIdForKey: string;
}) {
  return {
    schemaVersion: 1,
    mappingVersion: "mapping-v1",
    targetKind: "link",
    inputSchemaRevisionId: input.schemaRevisionId,
    targetResourceId: input.targetResourceId,
    targetRevisionId: input.targetRevisionId,
    valueCodecVersion: "pk1",
    propertyMappings: [],
    sourceKeyMapping: {
      objectTypeRevisionId: input.sourceRevisionId,
      expression: { op: "column", columnApiName: "orderId" },
      codecVersion: "pk1",
    },
    targetKeyMapping: {
      objectTypeRevisionId: input.targetRevisionIdForKey,
      expression: { op: "column", columnApiName: "customerId" },
      codecVersion: "pk1",
    },
    qualityRules: runtimeQualityRules(),
  };
}

function runtimeQualityRules() {
  return {
    primaryKeyNullMaximumCount: 0,
    primaryKeyDuplicateMaximumCount: 0,
    requiredPropertyFailureMaximumCount: 0,
    requiredLinkDanglingMaximumCount: 0,
    optionalPropertyFailureMaximumBasisPoints: 0,
    optionalLinkDanglingMaximumBasisPoints: 0,
    rowCountChangeConfirmationBasisPoints: 5_000,
    optionalFailureDisposition: "reject_row",
  };
}

function fixedDigest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function identity(subject: string): VerifiedFoundationIdentity {
  return parseVerifiedFoundationIdentity({
    issuer: "https://issuer.release.test",
    subject,
    displayName: subject,
    claimsFingerprint: `sha256:${"c".repeat(64)}`,
    authenticatedAt: "2026-08-15T00:00:00.000000Z",
  });
}

function isApplicationError(code: MetadataApplicationError["code"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof MetadataApplicationError && error.code === code;
}

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value was not present.");
  return value;
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
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("PostgreSQL integration container did not become ready.", { cause: lastError });
}

async function publishedPostgreSqlPort(containerName: string): Promise<number> {
  const { stdout } = await execFileAsync("docker", ["port", containerName, "5432/tcp"]);
  const match = /:(\d+)\s*$/u.exec(stdout);
  if (match?.[1] === undefined) throw new Error("PostgreSQL container port was not published.");
  return Number(match[1]);
}

async function docker(args: readonly string[], ignoreFailure = false): Promise<void> {
  try {
    await execFileAsync("docker", [...args]);
  } catch (error) {
    if (!ignoreFailure) throw error;
  }
}
