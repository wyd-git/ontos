import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";

import { canonicalizeContractForDigest, canonicalizeManifestForDigest } from "@ontos/contracts";
import {
  MetadataApplicationError,
  MetadataApplicationService,
  PackageLifecycleApplicationService,
  ReleaseLifecycleApplicationService,
  RoleMatrixManagementAuthorizer,
  parseVerifiedFoundationIdentity,
  type PackageChangeResult,
  type VerifiedFoundationIdentity,
} from "@ontos/metadata-application";
import { assertPackageCandidateIntegrity, preparePackageCandidate } from "@ontos/metadata-domain";
import {
  PostgresMetadataControlPlane,
  PostgresPackageStore,
  PostgresReleaseStore,
  sha256CanonicalText,
  type PackagePrepareFaultPoint,
  type ReleasePublishFaultPoint,
} from "@ontos/metadata-postgres";
import pg from "pg";

import { runDatabaseMigrations } from "../../database/migrator.ts";

const execFileAsync = promisify(execFile);
const postgresImage =
  "postgres:16.14-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8";
const database = "ontos_g20109";
const adminPassword = "local-only-g20109-admin-secret";
const runtimePassword = "local-only-g20109-runtime-secret";
const prepareFaultPoints: readonly PackagePrepareFaultPoint[] = [
  "after_package",
  "after_resources",
  "after_installation",
  "after_release",
  "after_change",
];
const publishFaultPoints: readonly ReleasePublishFaultPoint[] = [
  "after_activation",
  "after_serving_head",
  "after_revisions",
  "after_release",
  "after_channel",
  "after_installations",
  "after_project",
  "after_epoch",
];

void test(
  "G2-01-09 Package Validate, Install, Upgrade, Publish and Rollback",
  { timeout: 180_000 },
  async () => {
    const containerName = `ontos-g20109-${process.pid}-${randomUUID().slice(0, 8)}`;
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
        application_name: "ontos-g2-01-09-admin",
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
        application_name: "ontos-g2-01-09-runtime",
        max: 12,
      });
      const metadataStore = new PostgresMetadataControlPlane(pool);
      const packageStore = new PostgresPackageStore(pool);
      const releaseStore = new PostgresReleaseStore(pool);
      const authorizer = new RoleMatrixManagementAuthorizer(metadataStore);
      const metadata = new MetadataApplicationService({
        principals: metadataStore,
        projects: metadataStore,
        roleBindings: metadataStore,
        authorizer,
      });
      const packages = new PackageLifecycleApplicationService({
        principals: metadataStore,
        packages: packageStore,
        authorizer,
        digestCanonicalText: sha256CanonicalText,
      });
      const releases = new ReleaseLifecycleApplicationService({
        principals: metadataStore,
        releases: releaseStore,
        authorizer,
      });

      const ownerIdentity = identity("package-owner");
      const editorIdentity = identity("package-editor");
      const ownerPrincipal = await metadataStore.resolveVerifiedIdentity(ownerIdentity);
      const editorPrincipal = await metadataStore.resolveVerifiedIdentity(editorIdentity);
      const project = await metadata.createProject(ownerIdentity, {
        apiName: "PackageProject",
        displayName: "Package Project",
      });
      await metadata.replaceRoleBinding(ownerIdentity, {
        projectId: project.project.projectId,
        targetPrincipalId: editorPrincipal.principalId,
        role: "editor",
        expectedEpoch: 1n,
      });

      const commerceV1 = packageBundle({
        packageApiName: "CommerceCore",
        namespace: "fixture.commerce",
        version: "1.0.0",
        resourceId: "00000000-0000-4000-8000-000000020101",
        revisionId: "00000000-0000-4000-8000-000000020201",
        resourceApiName: "Order",
        marker: "baseline",
      });
      const validation = await packages.validatePackage(ownerIdentity, {
        projectId: project.project.projectId,
        ...commerceV1,
      });
      assert.equal(validation.resourceCount, 1);
      assert.equal(validation.manifestDigest, commerceV1.manifest.manifestDigest);

      await assert.rejects(
        packages.installPackage(editorIdentity, {
          projectId: project.project.projectId,
          targetChannelName: "stable",
          requestKey: "commerce-install-request-0001",
          ...commerceV1,
        }),
        isApplicationError("FORBIDDEN"),
      );
      const preparedForDirectDenial = preparePackageCandidate(commerceV1);
      const directIntegrity = assertPackageCandidateIntegrity(
        preparedForDirectDenial,
        sha256CanonicalText,
      );
      await assert.rejects(
        packageStore.installPackage({
          projectId: project.project.projectId,
          targetChannelName: "stable",
          requestKey: "commerce-direct-request-0001",
          candidate: preparedForDirectDenial,
          ...directIntegrity,
          createdByPrincipalId: editorPrincipal.principalId,
        }),
        isApplicationError("FORBIDDEN"),
      );
      const forgedCandidate = structuredClone(preparedForDirectDenial) as unknown as {
        readonly resources: Array<{ readonly content: { description: string } }>;
      };
      requireValue(forgedCandidate.resources[0]).content.description = "Forged after validation";
      await assert.rejects(
        packageStore.installPackage({
          projectId: project.project.projectId,
          targetChannelName: "stable",
          requestKey: "commerce-forged-request-0001",
          candidate: forgedCandidate as unknown as typeof preparedForDirectDenial,
          ...directIntegrity,
          createdByPrincipalId: ownerPrincipal.principalId,
        }),
        isApplicationError("INVALID_INPUT"),
      );

      const commerceInstall = await packages.installPackage(ownerIdentity, {
        projectId: project.project.projectId,
        targetChannelName: "stable",
        requestKey: "commerce-install-request-0001",
        ...commerceV1,
      });
      assert.equal(commerceInstall.accepted, true);
      const commerceInstallChange = requireValue(commerceInstall.change);
      assert.equal(commerceInstallChange.state, "pending");
      await assertPendingWorld(pool, commerceInstallChange, null);
      const firstPublication = await stageAndPublish(
        releases,
        ownerIdentity,
        commerceInstallChange,
        0n,
      );
      assert.equal(firstPublication.channelControlSequence, 1n);
      await assertActiveWorld(pool, commerceInstallChange);

      const repeatedInstall = await packages.installPackage(ownerIdentity, {
        projectId: project.project.projectId,
        targetChannelName: "stable",
        requestKey: "commerce-install-request-0001",
        ...commerceV1,
      });
      assert.equal(repeatedInstall.change?.changeId, commerceInstallChange.changeId);
      assert.equal(repeatedInstall.change?.idempotent, true);

      const workV1 = packageBundle({
        packageApiName: "WorkCore",
        namespace: "fixture.work",
        version: "1.0.0",
        resourceId: "00000000-0000-4000-8000-000000021101",
        revisionId: "00000000-0000-4000-8000-000000021201",
        resourceApiName: "WorkItem",
        marker: "baseline",
        linkResourceId: "00000000-0000-4000-8000-000000021102",
        linkRevisionId: "00000000-0000-4000-8000-000000021202",
        linkApiName: "WorkItemRelation",
        linkTargetRevisionId: "00000000-0000-4000-8000-000000021201",
      });
      const workInstall = await packages.installPackage(ownerIdentity, {
        projectId: project.project.projectId,
        targetChannelName: "stable",
        requestKey: "work-install-request-00000001",
        ...workV1,
      });
      const workInstallChange = requireValue(workInstall.change);
      await stageAndPublish(releases, ownerIdentity, workInstallChange, 1n);
      const namespaces = await pool.query<{
        readonly namespace: string;
        readonly api_name: string;
      }>(
        `SELECT namespace, api_name
         FROM meta.resources
         WHERE project_id = $1
         ORDER BY namespace, api_name`,
        [project.project.projectId],
      );
      assert.deepEqual(namespaces.rows, [
        { namespace: "fixture.commerce", api_name: "Order" },
        { namespace: "fixture.work", api_name: "WorkItem" },
        { namespace: "fixture.work", api_name: "WorkItemRelation" },
      ]);
      const workDependencies = await pool.query<{
        readonly source_revision_id: string;
        readonly target_revision_id: string;
        readonly dependency_type: string;
      }>(
        `SELECT dependency.source_revision_id, dependency.target_revision_id,
                dependency.dependency_type
         FROM meta.resource_dependencies AS dependency
         WHERE dependency.source_revision_id = $1
         ORDER BY dependency.dependency_type`,
        [workV1.manifest.resourceEntries[1]?.revisionId],
      );
      assert.deepEqual(workDependencies.rows, [
        {
          source_revision_id: workV1.manifest.resourceEntries[1]?.revisionId,
          target_revision_id: workV1.manifest.resourceEntries[0]?.revisionId,
          dependency_type: "link_source",
        },
        {
          source_revision_id: workV1.manifest.resourceEntries[1]?.revisionId,
          target_revision_id: workV1.manifest.resourceEntries[0]?.revisionId,
          dependency_type: "link_target",
        },
      ]);
      await assertActiveWorld(pool, commerceInstallChange);
      await assertActiveWorld(pool, workInstallChange);

      const overlappingPackage = packageBundle({
        packageApiName: "RogueCore",
        namespace: "fixture.rogue",
        version: "1.0.0",
        resourceId: commerceV1.manifest.resourceEntries[0]?.resourceId ?? "",
        revisionId: "00000000-0000-4000-8000-000000022201",
        resourceApiName: "StolenOrder",
        marker: "overlapping-resource-ownership",
      });
      await assert.rejects(
        packages.installPackage(ownerIdentity, {
          projectId: project.project.projectId,
          targetChannelName: "stable",
          requestKey: "rogue-overlap-request-0001",
          ...overlappingPackage,
        }),
        isApplicationError("ALREADY_EXISTS"),
      );

      const commerceV11 = packageBundle({
        packageApiName: "CommerceCore",
        namespace: "fixture.commerce",
        version: "1.1.0",
        resourceId: commerceV1.manifest.resourceEntries[0]?.resourceId ?? "",
        revisionId: "00000000-0000-4000-8000-000000020202",
        resourceApiName: "Order",
        marker: "compatible-description",
      });
      const commerceUpgrade = await packages.upgradePackage(ownerIdentity, {
        projectId: project.project.projectId,
        targetChannelName: "stable",
        requestKey: "commerce-upgrade-request-001",
        ...commerceV11,
      });
      assert.equal(commerceUpgrade.accepted, true);
      assert.equal(commerceUpgrade.compatibility.outcome, "compatible");
      const commerceUpgradeChange = requireValue(commerceUpgrade.change);
      await assertPendingWorld(
        pool,
        commerceUpgradeChange,
        commerceInstallChange.packageRevisionId,
      );
      await stageAndPublish(releases, ownerIdentity, commerceUpgradeChange, 2n);
      await assertActiveWorld(pool, commerceUpgradeChange);
      await assertActiveWorld(pool, workInstallChange);

      const releaseCountBeforeBreaking = await countRows(pool, "meta.releases");
      const commerceV2Breaking = packageBundle({
        packageApiName: "CommerceCore",
        namespace: "fixture.commerce",
        version: "2.0.0",
        resourceId: commerceV1.manifest.resourceEntries[0]?.resourceId ?? "",
        revisionId: "00000000-0000-4000-8000-000000020203",
        resourceApiName: "Order",
        marker: "breaking",
        addRequiredProperty: true,
      });
      const blocked = await packages.upgradePackage(ownerIdentity, {
        projectId: project.project.projectId,
        targetChannelName: "stable",
        requestKey: "commerce-breaking-request-01",
        ...commerceV2Breaking,
      });
      assert.equal(blocked.accepted, false);
      assert.equal(blocked.compatibility.outcome, "breaking");
      assert.equal(blocked.change, null);
      assert.equal(await countRows(pool, "meta.releases"), releaseCountBeforeBreaking);
      await assertActiveWorld(pool, commerceUpgradeChange);

      const commerceV111Conditional = packageBundle({
        packageApiName: "CommerceCore",
        namespace: "fixture.commerce",
        version: "1.1.1",
        resourceId: commerceV1.manifest.resourceEntries[0]?.resourceId ?? "",
        revisionId: "00000000-0000-4000-8000-000000020206",
        resourceApiName: "Order",
        marker: "conditional-index",
        addIndexedNullableProperty: true,
      });
      const conditionallyBlocked = await packages.upgradePackage(ownerIdentity, {
        projectId: project.project.projectId,
        targetChannelName: "stable",
        requestKey: "commerce-conditional-request-01",
        ...commerceV111Conditional,
      });
      assert.equal(conditionallyBlocked.accepted, false);
      assert.equal(conditionallyBlocked.compatibility.outcome, "conditional");
      assert.equal(conditionallyBlocked.change, null);
      assert.equal(await countRows(pool, "meta.releases"), releaseCountBeforeBreaking);
      await assertActiveWorld(pool, commerceUpgradeChange);

      const reusedVersion = packageBundle({
        packageApiName: "CommerceCore",
        namespace: "fixture.commerce",
        version: "1.1.0",
        resourceId: commerceV1.manifest.resourceEntries[0]?.resourceId ?? "",
        revisionId: "00000000-0000-4000-8000-000000020204",
        resourceApiName: "Order",
        marker: "different-content-same-version",
      });
      await assert.rejects(
        packages.upgradePackage(ownerIdentity, {
          projectId: project.project.projectId,
          targetChannelName: "stable",
          requestKey: "commerce-version-reuse-001",
          ...reusedVersion,
        }),
        isApplicationError("ALREADY_EXISTS"),
      );

      const firstReleaseHistory = await historicalRelease(pool, commerceInstallChange.releaseId);
      const rollback = await packages.rollbackPackage(ownerIdentity, {
        installationId: commerceUpgradeChange.installationId,
        targetPackageRevisionId: commerceInstallChange.packageRevisionId,
        targetChannelName: "stable",
        requestKey: "commerce-rollback-request-001",
      });
      const rollbackChange = requireValue(rollback.change);
      assert.equal(rollbackChange.operation, "rollback");
      assert.notEqual(rollbackChange.releaseId, commerceInstallChange.releaseId);
      await assertPendingWorld(pool, rollbackChange, commerceUpgradeChange.packageRevisionId);
      await stageAndPublish(releases, ownerIdentity, rollbackChange, 3n);
      await assertActiveWorld(pool, rollbackChange);
      assert.deepEqual(
        await historicalRelease(pool, commerceInstallChange.releaseId),
        firstReleaseHistory,
      );

      const commerceV12 = packageBundle({
        packageApiName: "CommerceCore",
        namespace: "fixture.commerce",
        version: "1.2.0",
        resourceId: commerceV1.manifest.resourceEntries[0]?.resourceId ?? "",
        revisionId: "00000000-0000-4000-8000-000000020205",
        resourceApiName: "Order",
        marker: "fault-publish",
      });
      const faultCandidate = await packages.upgradePackage(ownerIdentity, {
        projectId: project.project.projectId,
        targetChannelName: "stable",
        requestKey: "commerce-fault-publish-0001",
        ...commerceV12,
      });
      const faultChange = requireValue(faultCandidate.change);
      await releases.stageRelease(ownerIdentity, { releaseId: faultChange.releaseId });
      const beforeFault = await packageWorldSnapshot(pool, project.project.projectId, faultChange);
      for (const faultPoint of publishFaultPoints) {
        const faultingReleaseStore = new PostgresReleaseStore(pool, {
          faultInjector(actual) {
            if (actual === faultPoint) throw new Error(`injected:${faultPoint}`);
          },
        });
        await assert.rejects(
          faultingReleaseStore.publishRelease({
            releaseId: faultChange.releaseId,
            expectedChannelControlSequence: 4n,
            publishedByPrincipalId: ownerPrincipal.principalId,
          }),
          isApplicationError("STORAGE_FAILURE"),
        );
        assert.deepEqual(
          await packageWorldSnapshot(pool, project.project.projectId, faultChange),
          beforeFault,
          `publish fault ${faultPoint} must leave the old Package world active`,
        );
      }
      await releases.publishRelease(ownerIdentity, {
        releaseId: faultChange.releaseId,
        expectedChannelControlSequence: 4n,
      });
      await assertActiveWorld(pool, faultChange);

      for (const [index, faultPoint] of prepareFaultPoints.entries()) {
        const faultProject = await metadata.createProject(ownerIdentity, {
          apiName: `FaultPackageProject${String(index)}`,
          displayName: `Fault Package Project ${String(index)}`,
        });
        const faultBundle = packageBundle({
          packageApiName: `FaultPackage${String(index)}`,
          namespace: `fixture.fault${String(index)}`,
          version: "1.0.0",
          resourceId: randomUUID(),
          revisionId: randomUUID(),
          resourceApiName: `FaultObject${String(index)}`,
          marker: faultPoint,
        });
        const prepared = preparePackageCandidate(faultBundle);
        const integrity = assertPackageCandidateIntegrity(prepared, sha256CanonicalText);
        const faultingStore = new PostgresPackageStore(pool, {
          faultInjector(actual) {
            if (actual === faultPoint) throw new Error(`injected:${faultPoint}`);
          },
        });
        const before = await preparationCounts(
          pool,
          faultProject.project.projectId,
          faultBundle.manifest.namespace,
        );
        await assert.rejects(
          faultingStore.installPackage({
            projectId: faultProject.project.projectId,
            targetChannelName: "stable",
            requestKey: `fault-package-request-000${String(index)}`,
            candidate: prepared,
            ...integrity,
            createdByPrincipalId: ownerPrincipal.principalId,
          }),
          isApplicationError("STORAGE_FAILURE"),
        );
        assert.deepEqual(
          await preparationCounts(
            pool,
            faultProject.project.projectId,
            faultBundle.manifest.namespace,
          ),
          before,
          `prepare fault ${faultPoint} must leave no partial Package world`,
        );
      }
    } finally {
      await pool?.end();
      await docker(["rm", "--force", containerName], true);
    }
  },
);

async function stageAndPublish(
  releases: ReleaseLifecycleApplicationService,
  identityInput: VerifiedFoundationIdentity,
  change: NonNullable<PackageChangeResult["change"]>,
  expectedSequence: bigint,
) {
  const stage = await releases.stageRelease(identityInput, { releaseId: change.releaseId });
  assert.equal(stage.staged, true);
  assert.equal(stage.report.valid, true);
  return releases.publishRelease(identityInput, {
    releaseId: change.releaseId,
    expectedChannelControlSequence: expectedSequence,
  });
}

async function assertPendingWorld(
  pool: pg.Pool,
  change: NonNullable<PackageChangeResult["change"]>,
  expectedActiveRevisionId: string | null,
) {
  const result = await pool.query<{
    readonly state: string;
    readonly active_package_revision_id: string | null;
    readonly active_release_id: string | null;
    readonly release_state: string;
  }>(
    `SELECT change.state, installation.active_package_revision_id,
            installation.active_release_id, release.state AS release_state
     FROM meta.package_installation_changes AS change
     JOIN meta.package_installations AS installation
       ON installation.installation_id = change.installation_id
     JOIN meta.releases AS release ON release.release_id = change.target_release_id
     WHERE change.change_id = $1`,
    [change.changeId],
  );
  const row = requireValue(result.rows[0]);
  assert.equal(row.state, "pending");
  assert.equal(row.active_package_revision_id, expectedActiveRevisionId);
  assert.equal(row.release_state, "draft");
  if (expectedActiveRevisionId === null) assert.equal(row.active_release_id, null);
}

async function assertActiveWorld(
  pool: pg.Pool,
  change: NonNullable<PackageChangeResult["change"]>,
) {
  const result = await pool.query<{
    readonly state: string;
    readonly active_package_revision_id: string;
    readonly active_release_id: string;
  }>(
    `SELECT change.state, installation.active_package_revision_id,
            installation.active_release_id
     FROM meta.package_installation_changes AS change
     JOIN meta.package_installations AS installation
       ON installation.installation_id = change.installation_id
     WHERE change.change_id = $1`,
    [change.changeId],
  );
  assert.deepEqual(result.rows[0], {
    state: "active",
    active_package_revision_id: change.packageRevisionId,
    active_release_id: change.releaseId,
  });
}

async function historicalRelease(pool: pg.Pool, releaseId: string) {
  const result = await pool.query<{
    readonly release_id: string;
    readonly manifest_digest: string;
    readonly pins: unknown;
  }>(
    `SELECT release.release_id, release.manifest_digest,
            jsonb_agg(
              jsonb_build_object(
                'resourceId', pin.resource_id,
                'revisionId', pin.revision_id,
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

async function packageWorldSnapshot(
  pool: pg.Pool,
  projectId: string,
  change: NonNullable<PackageChangeResult["change"]>,
) {
  const result = await pool.query<{
    readonly channel_release_id: string;
    readonly channel_sequence: string;
    readonly installation_revision_id: string;
    readonly installation_release_id: string;
    readonly installation_sequence: string;
    readonly change_state: string;
    readonly release_state: string;
    readonly activation_count: number;
  }>(
    `SELECT channel.release_id AS channel_release_id,
            channel.control_sequence::text AS channel_sequence,
            installation.active_package_revision_id AS installation_revision_id,
            installation.active_release_id AS installation_release_id,
            installation.control_sequence::text AS installation_sequence,
            change.state AS change_state,
            release.state AS release_state,
            (SELECT count(*)::integer FROM meta.runtime_activations
             WHERE release_id = change.target_release_id) AS activation_count
     FROM meta.release_channels AS channel
     JOIN meta.package_installation_changes AS change ON change.change_id = $2
     JOIN meta.package_installations AS installation
       ON installation.installation_id = change.installation_id
     JOIN meta.releases AS release ON release.release_id = change.target_release_id
     WHERE channel.project_id = $1 AND channel.channel_name = 'stable'`,
    [projectId, change.changeId],
  );
  return requireValue(result.rows[0]);
}

async function preparationCounts(pool: pg.Pool, projectId: string, namespace: string) {
  const result = await pool.query<{
    readonly packages: number;
    readonly resources: number;
    readonly installations: number;
    readonly releases: number;
    readonly changes: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM meta.packages WHERE namespace = $2) AS packages,
       (SELECT count(*)::integer FROM meta.resources
        WHERE project_id = $1 AND namespace = $2) AS resources,
       (SELECT count(*)::integer FROM meta.package_installations
        WHERE project_id = $1) AS installations,
       (SELECT count(*)::integer FROM meta.releases WHERE project_id = $1) AS releases,
       (SELECT count(*)::integer FROM meta.package_installation_changes
        WHERE project_id = $1) AS changes`,
    [projectId, namespace],
  );
  return requireValue(result.rows[0]);
}

async function countRows(pool: pg.Pool, table: "meta.releases") {
  const result = await pool.query<{ readonly count: number }>(
    `SELECT count(*)::integer AS count FROM ${table}`,
  );
  return requireValue(result.rows[0]).count;
}

function packageBundle(input: {
  readonly packageApiName: string;
  readonly namespace: string;
  readonly version: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly resourceApiName: string;
  readonly marker: string;
  readonly addRequiredProperty?: boolean;
  readonly addIndexedNullableProperty?: boolean;
  readonly linkResourceId?: string;
  readonly linkRevisionId?: string;
  readonly linkApiName?: string;
  readonly linkTargetRevisionId?: string;
}) {
  const content = objectType(
    input.resourceApiName,
    input.marker,
    input.addRequiredProperty ?? false,
    input.addIndexedNullableProperty ?? false,
  );
  const contentDigest = sha256CanonicalText(canonicalizeContractForDigest(content));
  const resourceEntries = [
    {
      namespace: input.namespace,
      apiName: input.resourceApiName,
      family: "object_type",
      resourceId: input.resourceId,
      revisionId: input.revisionId,
      contentDigest,
    },
  ];
  const resources: Array<{ resourceId: string; revisionId: string; content: unknown }> = [
    { resourceId: input.resourceId, revisionId: input.revisionId, content },
  ];
  const linkFields = [
    input.linkResourceId,
    input.linkRevisionId,
    input.linkApiName,
    input.linkTargetRevisionId,
  ];
  if (linkFields.some((value) => value !== undefined)) {
    if (linkFields.some((value) => value === undefined)) {
      throw new Error("Package Link fixture requires all Link identity fields.");
    }
    const linkResourceId = requireValue(input.linkResourceId);
    const linkRevisionId = requireValue(input.linkRevisionId);
    const linkApiName = requireValue(input.linkApiName);
    const linkTargetRevisionId = requireValue(input.linkTargetRevisionId);
    const linkContent = linkType(linkApiName, input.revisionId, linkTargetRevisionId);
    const linkContentDigest = sha256CanonicalText(canonicalizeContractForDigest(linkContent));
    resourceEntries.push({
      namespace: input.namespace,
      apiName: linkApiName,
      family: "link_type",
      resourceId: linkResourceId,
      revisionId: linkRevisionId,
      contentDigest: linkContentDigest,
    });
    resources.push({
      resourceId: linkResourceId,
      revisionId: linkRevisionId,
      content: linkContent,
    });
  }
  const manifest = {
    schemaVersion: 1,
    packageApiName: input.packageApiName,
    version: input.version,
    namespace: input.namespace,
    kernelContractVersion: "metadata-1",
    resourceEntries,
    artifactDigests: [] as string[],
    installInputs: [
      {
        apiName: "environment",
        displayName: "Environment",
        description: "Target environment label.",
        required: true,
      },
    ],
    manifestDigest: `sha256:${"0".repeat(64)}`,
  };
  manifest.manifestDigest = sha256CanonicalText(canonicalizeManifestForDigest(manifest));
  return {
    manifest,
    resources,
    installInputBindings: [{ apiName: "environment", value: "prod" }],
  };
}

function objectType(
  apiName: string,
  marker: string,
  addRequiredProperty: boolean,
  addIndexedNullableProperty: boolean,
) {
  const properties = [
    {
      schemaVersion: 1,
      apiName: "id",
      displayName: "ID",
      description: "Stable identifier.",
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
  ];
  if (addRequiredProperty) {
    properties.push({
      schemaVersion: 1,
      apiName: "requiredValue",
      displayName: "Required Value",
      description: "Breaking required value.",
      valueType: "string",
      caseSensitive: true,
      nullable: false,
      writeMode: "source_only",
      unique: false,
      filterable: false,
      sortable: false,
      searchable: false,
      classification: "internal",
    });
  }
  if (addIndexedNullableProperty) {
    properties.push({
      schemaVersion: 1,
      apiName: "indexedNote",
      displayName: "Indexed Note",
      description: "Conditionally compatible query surface.",
      valueType: "string",
      caseSensitive: true,
      nullable: true,
      writeMode: "source_only",
      unique: false,
      filterable: true,
      sortable: false,
      searchable: false,
      classification: "internal",
    });
  }
  return {
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `Package ${marker}`,
    primaryKeyPropertyApiName: "id",
    titlePropertyApiName: "id",
    defaultSearchPropertyApiNames: [],
    defaultSort: [{ propertyApiName: "id", direction: "asc" }],
    defaultClassification: "internal",
    properties,
  };
}

function linkType(apiName: string, sourceRevisionId: string, targetRevisionId: string) {
  return {
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: "Package-owned Link with explicit immutable endpoints.",
    source: {
      objectTypeRevisionId: sourceRevisionId,
      apiName: "source",
      displayName: "Source",
    },
    target: {
      objectTypeRevisionId: targetRevisionId,
      apiName: "target",
      displayName: "Target",
    },
    cardinality: "many_to_one",
    sourceKind: "base",
    deletionBehavior: "restrict",
    actionCreateAllowed: false,
    actionDeleteAllowed: false,
  };
}

function identity(subject: string) {
  return parseVerifiedFoundationIdentity({
    issuer: "https://issuer.package.test",
    subject,
    displayName: subject,
    claimsFingerprint: `sha256:${"c".repeat(64)}`,
    authenticatedAt: "2026-08-15T00:00:00.000000Z",
  });
}

function isApplicationError(code: MetadataApplicationError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof MetadataApplicationError && error.code === code;
}

function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected value was not present.");
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
