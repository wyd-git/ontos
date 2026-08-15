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
