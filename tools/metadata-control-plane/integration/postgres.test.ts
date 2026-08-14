import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";

import {
  MetadataApplicationError,
  MetadataApplicationService,
  ResourceLifecycleApplicationService,
  RoleMatrixManagementAuthorizer,
  parseVerifiedFoundationIdentity,
  type VerifiedFoundationIdentity,
} from "@ontos/metadata-application";
import {
  MANAGEMENT_PERMISSIONS,
  prepareDirectResourceContent,
  type ManagementRole,
} from "@ontos/metadata-domain";
import { PostgresMetadataControlPlane } from "@ontos/metadata-postgres";
import pg from "pg";

import { runDatabaseMigrations } from "../../database/migrator.ts";

const execFileAsync = promisify(execFile);
const postgresImage =
  "postgres:16.14-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8";
const database = "ontos_g20104";
const adminPassword = "local-only-g20104-admin-secret";
const runtimePassword = "local-only-g20104-runtime-secret";

void test(
  "G2-01-04/05/06/07 PostgreSQL management, Revision, validation and compatibility",
  { timeout: 120_000 },
  async () => {
    const containerName = `ontos-g20104-${process.pid}-${randomUUID().slice(0, 8)}`;
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
        application_name: "ontos-g2-01-04-admin",
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
        application_name: "ontos-g2-01-04-runtime",
        max: 8,
      });
      const store = new PostgresMetadataControlPlane(pool);
      const authorizer = new RoleMatrixManagementAuthorizer(store);
      const application = new MetadataApplicationService({
        principals: store,
        projects: store,
        roleBindings: store,
        authorizer,
      });
      const resourceApplication = new ResourceLifecycleApplicationService({
        principals: store,
        resources: store,
        authorizer,
      });

      const ownerIdentity = identity("owner");
      const concurrentPrincipals = await Promise.all(
        Array.from({ length: 12 }, () => store.resolveVerifiedIdentity(ownerIdentity)),
      );
      assert.equal(new Set(concurrentPrincipals.map(({ principalId }) => principalId)).size, 1);
      const ownerPrincipal = concurrentPrincipals[0];
      assert.ok(ownerPrincipal);

      const creation = await application.createProject(ownerIdentity, {
        apiName: "Commerce",
        displayName: "Commerce Control Plane",
      });
      assert.equal(creation.ownerBinding.principalId, ownerPrincipal.principalId);
      assert.equal(creation.ownerBinding.role, "owner");
      assert.equal(creation.authorizationEpoch, 1n);
      await assertProjectCreationFacts(
        pool,
        creation.project.projectId,
        ownerPrincipal.principalId,
      );

      const failedProjectId = randomUUID();
      const collidingProjectStore = new PostgresMetadataControlPlane(
        pool,
        sequenceUuidFactory([failedProjectId, creation.ownerBinding.bindingId]),
      );
      await assert.rejects(
        collidingProjectStore.createProjectWithOwner({
          principalId: ownerPrincipal.principalId,
          apiName: "AtomicFailure",
          displayName: "Must Roll Back",
        }),
        isApplicationError("ALREADY_EXISTS"),
      );
      await assertNoProjectFacts(pool, failedProjectId);

      const disabledIdentity = identity("disabled");
      const disabledPrincipal = await store.resolveVerifiedIdentity(disabledIdentity);
      await pool.query(
        `UPDATE authz.principals
         SET state = 'disabled', disabled_at = clock_timestamp(), changed_at = clock_timestamp()
         WHERE principal_id = $1`,
        [disabledPrincipal.principalId],
      );
      await assert.rejects(
        application.createProject(disabledIdentity, {
          apiName: "DisabledProject",
          displayName: "Disabled Project",
        }),
        isApplicationError("FORBIDDEN"),
      );

      const identities = {
        editor: identity("editor"),
        viewer: identity("viewer"),
        executor: identity("executor"),
        auditor: identity("auditor"),
      } as const;
      const principals = {
        editor: await store.resolveVerifiedIdentity(identities.editor),
        viewer: await store.resolveVerifiedIdentity(identities.viewer),
        executor: await store.resolveVerifiedIdentity(identities.executor),
        auditor: await store.resolveVerifiedIdentity(identities.auditor),
      } as const;
      let epoch = creation.authorizationEpoch;
      const assignedBindings = new Map<ManagementRole, string>();
      for (const role of ["editor", "viewer", "executor", "auditor"] as const) {
        const replacement = await application.replaceRoleBinding(ownerIdentity, {
          projectId: creation.project.projectId,
          targetPrincipalId: principals[role].principalId,
          role,
          expectedEpoch: epoch,
        });
        assert.equal(replacement.changed, true);
        assert.equal(replacement.authorizationEpoch, epoch + 1n);
        assert.ok(replacement.activeBinding);
        assignedBindings.set(role, replacement.activeBinding.bindingId);
        epoch = replacement.authorizationEpoch;
      }

      const expectedByRole: Readonly<Record<ManagementRole, readonly string[]>> = {
        owner: [...MANAGEMENT_PERMISSIONS],
        editor: ["metadata.read", "metadata.edit"],
        viewer: ["metadata.read"],
        executor: [],
        auditor: [],
      };
      for (const role of ["owner", "editor", "viewer", "executor", "auditor"] as const) {
        const actorIdentity = role === "owner" ? ownerIdentity : identities[role];
        for (const permission of MANAGEMENT_PERMISSIONS) {
          assert.equal(
            await application.authorizeManagement(actorIdentity, {
              projectId: creation.project.projectId,
              permission,
            }),
            expectedByRole[role].includes(permission),
            `${role}:${permission}`,
          );
        }
      }

      const resourceId = randomUUID();
      await pool.query(
        `INSERT INTO meta.resources (resource_id, project_id, namespace, api_name, family)
         VALUES ($1, $2, 'commerce.orders', 'Order', 'object_type')`,
        [resourceId, creation.project.projectId],
      );
      for (const [role, resourceRole] of [
        ["editor", "viewer"],
        ["viewer", "owner"],
        ["executor", "owner"],
      ] as const) {
        const replacement = await application.replaceRoleBinding(ownerIdentity, {
          projectId: creation.project.projectId,
          targetPrincipalId: principals[role].principalId,
          resourceId,
          role: resourceRole,
          expectedEpoch: epoch,
        });
        epoch = replacement.authorizationEpoch;
      }
      assert.equal(
        await application.authorizeManagement(identities.editor, {
          projectId: creation.project.projectId,
          resourceId,
          permission: "metadata.read",
        }),
        true,
      );
      assert.equal(
        await application.authorizeManagement(identities.editor, {
          projectId: creation.project.projectId,
          resourceId,
          permission: "metadata.edit",
        }),
        false,
      );
      for (const actorIdentity of [identities.viewer, identities.executor]) {
        assert.equal(
          await application.authorizeManagement(actorIdentity, {
            projectId: creation.project.projectId,
            resourceId,
            permission: "metadata.edit",
          }),
          false,
        );
      }

      const foreignCreation = await application.createProject(identity("foreign-owner"), {
        apiName: "ForeignProject",
        displayName: "Foreign Project",
      });
      const foreignResourceId = randomUUID();
      await pool.query(
        `INSERT INTO meta.resources (resource_id, project_id, namespace, api_name, family)
         VALUES ($1, $2, 'foreign.resource', 'Foreign', 'object_type')`,
        [foreignResourceId, foreignCreation.project.projectId],
      );
      assert.equal(
        await application.authorizeManagement(ownerIdentity, {
          projectId: creation.project.projectId,
          resourceId: foreignResourceId,
          permission: "metadata.read",
        }),
        false,
      );

      const baseContent = objectTypeContent("Initial lifecycle content.");
      await assert.rejects(
        resourceApplication.createResource(ownerIdentity, {
          resourceId: randomUUID(),
          projectId: creation.project.projectId,
          namespace: "commerce.lifecycle",
          apiName: "LifecycleOrder",
          family: "object_type",
          content: baseContent,
        }),
        isApplicationError("INVALID_INPUT"),
      );
      await assert.rejects(
        resourceApplication.createResource(identities.viewer, {
          projectId: creation.project.projectId,
          namespace: "commerce.lifecycle",
          apiName: "ViewerCannotCreate",
          family: "object_type",
          content: baseContent,
        }),
        isApplicationError("FORBIDDEN"),
      );

      const lifecycle = await resourceApplication.createResource(ownerIdentity, {
        projectId: creation.project.projectId,
        namespace: "commerce.lifecycle",
        apiName: "LifecycleOrder",
        family: "object_type",
        content: baseContent,
      });
      assert.equal(lifecycle.initialDraft.revisionNumber, 1n);
      assert.equal(lifecycle.initialDraft.etag, 1n);
      assert.equal(lifecycle.initialDraft.parentRevisionId, null);
      assert.equal(lifecycle.initialDraft.createdByPrincipalId, ownerPrincipal.principalId);

      const digestTwin = await resourceApplication.createResource(ownerIdentity, {
        projectId: creation.project.projectId,
        namespace: "commerce.lifecycle",
        apiName: "DigestTwin",
        family: "object_type",
        content: reverseObjectKeys(baseContent),
      });
      assert.equal(digestTwin.initialDraft.contentDigest, lifecycle.initialDraft.contentDigest);

      const rolledBackResourceId = randomUUID();
      const collidingRevisionStore = new PostgresMetadataControlPlane(
        pool,
        sequenceUuidFactory([rolledBackResourceId, lifecycle.initialDraft.revisionId]),
      );
      await assert.rejects(
        collidingRevisionStore.createResourceWithInitialDraft({
          projectId: creation.project.projectId,
          namespace: "commerce.lifecycle",
          apiName: "AtomicRollback",
          family: "object_type",
          authorPrincipalId: ownerPrincipal.principalId,
          content: prepareDirectResourceContent("object_type", baseContent),
        }),
        isApplicationError("ALREADY_EXISTS"),
      );
      assert.equal(await rowCount(pool, "meta.resources", "resource_id", rolledBackResourceId), 0);

      const patchAttempts = await Promise.allSettled(
        Array.from({ length: 100 }, (_, index) =>
          store.patchDraftRevision({
            revisionId: lifecycle.initialDraft.revisionId,
            expectedEtag: 1n,
            content: prepareDirectResourceContent(
              "object_type",
              objectTypeContent(`Concurrent writer ${String(index)}.`),
            ),
          }),
        ),
      );
      const successfulPatches = patchAttempts.filter(
        (
          result,
        ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof store.patchDraftRevision>>> =>
          result.status === "fulfilled",
      );
      const rejectedPatches = patchAttempts.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      assert.equal(successfulPatches.length, 1);
      assert.equal(rejectedPatches.length, 99);
      assert.ok(
        rejectedPatches.every(
          ({ reason }: PromiseRejectedResult) =>
            reason instanceof MetadataApplicationError && reason.code === "CONCURRENT_MODIFICATION",
        ),
      );
      const patched = await store.getRevision(lifecycle.initialDraft.revisionId);
      assert.equal(patched.etag, 2n);
      assert.equal(patched.contentDigest, successfulPatches[0]?.value.contentDigest);

      const noOpPatch = await store.patchDraftRevision({
        revisionId: patched.revisionId,
        expectedEtag: patched.etag,
        content: prepareDirectResourceContent("object_type", patched.content),
      });
      assert.equal(noOpPatch.etag, patched.etag);
      assert.equal(noOpPatch.contentDigest, patched.contentDigest);

      const validation = await resourceApplication.validateRevision(ownerIdentity, {
        revisionId: patched.revisionId,
      });
      assert.equal(validation.report.valid, true);
      assert.deepEqual(validation.report.issues, []);
      const validated = validation.revision;

      const linkSource = await resourceApplication.createResource(ownerIdentity, {
        projectId: creation.project.projectId,
        namespace: "commerce.validation",
        apiName: "LinkSource",
        family: "object_type",
        content: objectTypeContent("Validated Link source."),
      });
      const linkTarget = await resourceApplication.createResource(ownerIdentity, {
        projectId: creation.project.projectId,
        namespace: "commerce.validation",
        apiName: "LinkTarget",
        family: "object_type",
        content: objectTypeContent("Initially unvalidated Link target."),
      });
      const validatedSource = await resourceApplication.validateRevision(ownerIdentity, {
        revisionId: linkSource.initialDraft.revisionId,
      });
      const retryableLink = await resourceApplication.createResource(ownerIdentity, {
        projectId: creation.project.projectId,
        namespace: "commerce.validation",
        apiName: "RetryableLink",
        family: "link_type",
        content: linkTypeContent(
          validatedSource.revision.revisionId,
          linkTarget.initialDraft.revisionId,
        ),
      });
      const failedBeforeTargetValidation = await resourceApplication.validateRevision(
        ownerIdentity,
        { revisionId: retryableLink.initialDraft.revisionId },
      );
      assert.equal(failedBeforeTargetValidation.report.valid, false);
      assert.deepEqual(
        failedBeforeTargetValidation.report.issues.map(({ code, path }) => ({ code, path })),
        [
          {
            code: "DEPENDENCY_NOT_VALIDATED",
            path: "/target/objectTypeRevisionId",
          },
        ],
      );
      assert.equal(failedBeforeTargetValidation.revision.state, "draft");
      assert.equal(
        Number(
          (
            await pool.query<{ readonly count: string }>(
              `SELECT COUNT(*)::text AS count
               FROM meta.resource_dependencies
               WHERE source_revision_id = $1`,
              [retryableLink.initialDraft.revisionId],
            )
          ).rows[0]?.count ?? "0",
        ),
        0,
      );

      await resourceApplication.validateRevision(ownerIdentity, {
        revisionId: linkTarget.initialDraft.revisionId,
      });
      const concurrentValidations = await Promise.all(
        Array.from({ length: 32 }, () =>
          resourceApplication.validateRevision(ownerIdentity, {
            revisionId: retryableLink.initialDraft.revisionId,
          }),
        ),
      );
      assert.ok(concurrentValidations.every(({ revision }) => revision.state === "validated"));
      assert.equal(new Set(concurrentValidations.map(({ report }) => report.reportId)).size, 1);
      const successfulLinkValidation = concurrentValidations[0];
      assert.ok(successfulLinkValidation);
      assert.equal(successfulLinkValidation.report.valid, true);
      assert.equal(
        successfulLinkValidation.report.subjectDigest,
        failedBeforeTargetValidation.report.subjectDigest,
      );
      assert.notEqual(
        successfulLinkValidation.report.reportId,
        failedBeforeTargetValidation.report.reportId,
      );
      const reportContexts = await pool.query<{
        readonly report_id: string;
        readonly validation_context_digest: string;
      }>(
        `SELECT report_id, validation_context_digest
         FROM meta.validation_reports
         WHERE resource_revision_id = $1
         ORDER BY report_id`,
        [retryableLink.initialDraft.revisionId],
      );
      assert.equal(reportContexts.rowCount, 2);
      assert.equal(
        new Set(reportContexts.rows.map(({ validation_context_digest: context }) => context)).size,
        2,
      );
      assert.deepEqual(
        await resourceApplication.getRevisionValidationReport(ownerIdentity, {
          revisionId: retryableLink.initialDraft.revisionId,
        }),
        successfulLinkValidation.report,
      );
      const persistedEdges = await pool.query<{
        readonly dependency_type: string;
        readonly source_path: string;
        readonly target_revision_id: string;
      }>(
        `SELECT dependency_type, source_path, target_revision_id
         FROM meta.resource_dependencies
         WHERE source_revision_id = $1
         ORDER BY dependency_type, source_path, target_revision_id`,
        [retryableLink.initialDraft.revisionId],
      );
      assert.deepEqual(persistedEdges.rows, [
        {
          dependency_type: "link_source",
          source_path: "/source/objectTypeRevisionId",
          target_revision_id: validatedSource.revision.revisionId,
        },
        {
          dependency_type: "link_target",
          source_path: "/target/objectTypeRevisionId",
          target_revision_id: linkTarget.initialDraft.revisionId,
        },
      ]);

      const forgedLink = await resourceApplication.createResource(ownerIdentity, {
        projectId: creation.project.projectId,
        namespace: "commerce.validation",
        apiName: "ForgedLink",
        family: "link_type",
        content: linkTypeContent(
          validatedSource.revision.revisionId,
          linkTarget.initialDraft.revisionId,
        ),
      });
      await assert.rejects(
        pool.query(
          `INSERT INTO meta.resource_dependencies
             (dependency_id, source_revision_id, target_revision_id, dependency_type, source_path)
           VALUES ($1, $2, $3, 'link_source', '/target/objectTypeRevisionId')`,
          [randomUUID(), forgedLink.initialDraft.revisionId, validatedSource.revision.revisionId],
        ),
        isPostgresError("23514"),
      );
      await resourceApplication.validateRevision(ownerIdentity, {
        revisionId: forgedLink.initialDraft.revisionId,
      });

      const bypassDraft = await resourceApplication.createResource(ownerIdentity, {
        projectId: creation.project.projectId,
        namespace: "commerce.validation",
        apiName: "BypassDraft",
        family: "object_type",
        content: objectTypeContent("Direct state update must be rejected."),
      });
      await assert.rejects(
        pool.query(
          `UPDATE meta.resource_revisions
           SET state = 'validated', changed_at = clock_timestamp()
           WHERE revision_id = $1`,
          [bypassDraft.initialDraft.revisionId],
        ),
        isPostgresError("55000"),
      );

      const missingRevision = randomUUID();
      const missingLink = await resourceApplication.createResource(ownerIdentity, {
        projectId: creation.project.projectId,
        namespace: "commerce.validation",
        apiName: "MissingLink",
        family: "link_type",
        content: linkTypeContent(validatedSource.revision.revisionId, missingRevision),
      });
      const missingReport = (
        await resourceApplication.validateRevision(ownerIdentity, {
          revisionId: missingLink.initialDraft.revisionId,
        })
      ).report;
      assert.equal(missingReport.valid, false);
      assert.ok(
        missingReport.issues.some(
          ({ code, path, message }) =>
            code === "DEPENDENCY_UNAVAILABLE" &&
            path === "/target/objectTypeRevisionId" &&
            !message.includes(missingRevision),
        ),
      );

      const foreignProject = await application.createProject(ownerIdentity, {
        apiName: "ForeignValidation",
        displayName: "Foreign Validation",
      });
      const foreignTarget = await resourceApplication.createResource(ownerIdentity, {
        projectId: foreignProject.project.projectId,
        namespace: "foreign.validation",
        apiName: "ForeignTarget",
        family: "object_type",
        content: objectTypeContent("Foreign target."),
      });
      await resourceApplication.validateRevision(ownerIdentity, {
        revisionId: foreignTarget.initialDraft.revisionId,
      });
      const foreignTargetChild = await resourceApplication.createChildDraft(ownerIdentity, {
        sourceRevisionId: foreignTarget.initialDraft.revisionId,
        content: objectTypeContent("Second foreign target Revision."),
      });
      await resourceApplication.validateRevision(ownerIdentity, {
        revisionId: foreignTargetChild.revisionId,
      });
      const foreignEndpointBaseline = await resourceApplication.createChildDraft(ownerIdentity, {
        sourceRevisionId: successfulLinkValidation.revision.revisionId,
        content: linkTypeContent(
          validatedSource.revision.revisionId,
          foreignTarget.initialDraft.revisionId,
        ),
      });
      const foreignEndpointCandidate = await resourceApplication.createChildDraft(ownerIdentity, {
        sourceRevisionId: successfulLinkValidation.revision.revisionId,
        content: linkTypeContent(
          validatedSource.revision.revisionId,
          foreignTargetChild.revisionId,
        ),
      });
      const foreignEndpointDiff = await resourceApplication.compareRevisionCompatibility(
        ownerIdentity,
        {
          revisionId: foreignEndpointCandidate.revisionId,
          againstRevisionId: foreignEndpointBaseline.revisionId,
        },
      );
      assert.equal(foreignEndpointDiff.outcome, "breaking");
      assert.ok(
        foreignEndpointDiff.findings.some(({ code }) => code === "LINK_TYPE_ENDPOINT_CHANGED"),
      );
      const crossProjectLink = await resourceApplication.createResource(ownerIdentity, {
        projectId: creation.project.projectId,
        namespace: "commerce.validation",
        apiName: "CrossProjectLink",
        family: "link_type",
        content: linkTypeContent(
          validatedSource.revision.revisionId,
          foreignTarget.initialDraft.revisionId,
        ),
      });
      const crossProjectReport = (
        await resourceApplication.validateRevision(ownerIdentity, {
          revisionId: crossProjectLink.initialDraft.revisionId,
        })
      ).report;
      assert.equal(missingReport.issues.length, 1);
      assert.equal(crossProjectReport.issues.length, 1);
      const missingIssue = missingReport.issues.find(
        ({ code, path }) =>
          code === "DEPENDENCY_UNAVAILABLE" && path === "/target/objectTypeRevisionId",
      );
      const crossProjectIssue = crossProjectReport.issues.find(
        ({ code, path }) =>
          code === "DEPENDENCY_UNAVAILABLE" && path === "/target/objectTypeRevisionId",
      );
      assert.deepEqual(
        missingIssue === undefined
          ? undefined
          : {
              code: missingIssue.code,
              severity: missingIssue.severity,
              path: missingIssue.path,
              message: missingIssue.message,
              remediation: missingIssue.remediation,
            },
        crossProjectIssue === undefined
          ? undefined
          : {
              code: crossProjectIssue.code,
              severity: crossProjectIssue.severity,
              path: crossProjectIssue.path,
              message: crossProjectIssue.message,
              remediation: crossProjectIssue.remediation,
            },
      );
      assert.ok(!JSON.stringify(crossProjectReport).includes(foreignTarget.resource.resourceId));

      const concurrentChildren = await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          store.createChildDraft({
            sourceRevisionId: validated.revisionId,
            authorPrincipalId: ownerPrincipal.principalId,
            content: prepareDirectResourceContent(
              "object_type",
              objectTypeContent(`Concurrent child ${String(index)}.`),
            ),
          }),
        ),
      );
      assert.equal(new Set(concurrentChildren.map(({ revisionId }) => revisionId)).size, 100);
      assert.equal(
        new Set(concurrentChildren.map(({ revisionNumber }) => revisionNumber)).size,
        100,
      );
      assert.ok(
        concurrentChildren.every(
          ({ parentRevisionId, state, etag }) =>
            parentRevisionId === validated.revisionId && state === "draft" && etag === 1n,
        ),
      );

      const compatibleDiff = await resourceApplication.compareRevisionCompatibility(ownerIdentity, {
        revisionId: concurrentChildren[0]?.revisionId,
        againstRevisionId: validated.revisionId,
      });
      assert.equal(compatibleDiff.outcome, "compatible");
      assert.deepEqual(
        compatibleDiff.findings.map(({ code }) => code),
        ["DISPLAY_TEXT_CHANGED"],
      );
      assert.deepEqual(
        await resourceApplication.compareRevisionCompatibility(ownerIdentity, {
          revisionId: concurrentChildren[0]?.revisionId,
          againstRevisionId: validated.revisionId,
        }),
        compatibleDiff,
      );
      await assert.rejects(
        resourceApplication.compareRevisionCompatibility(ownerIdentity, {
          revisionId: concurrentChildren[0]?.revisionId,
          againstRevisionId: retryableLink.initialDraft.revisionId,
        }),
        isApplicationError("INVALID_INPUT"),
      );

      const listedRevisions = [];
      let revisionCursor = null;
      do {
        const page = await resourceApplication.listRevisions(ownerIdentity, {
          resourceId: lifecycle.resource.resourceId,
          limit: 17,
          ...(revisionCursor === null ? {} : { after: revisionCursor }),
        });
        listedRevisions.push(...page.items);
        revisionCursor = page.nextCursor;
      } while (revisionCursor !== null);
      assert.equal(listedRevisions.length, 101);
      assert.deepEqual(
        listedRevisions.map(({ revisionNumber }) => revisionNumber),
        Array.from({ length: 101 }, (_, index) => BigInt(index + 1)),
      );
      assert.equal(new Set(listedRevisions.map(({ revisionId }) => revisionId)).size, 101);
      assert.equal(listedRevisions[0]?.parentRevisionId, null);
      assert.ok(
        listedRevisions
          .slice(1)
          .every(({ parentRevisionId }) => parentRevisionId === validated.revisionId),
      );

      const published = await store.transitionRevisionState({
        revisionId: validated.revisionId,
        targetState: "published",
      });
      await assert.rejects(
        resourceApplication.patchDraftRevision(ownerIdentity, {
          revisionId: published.revisionId,
          expectedEtag: published.etag,
          content: objectTypeContent("Published mutation must fail."),
        }),
        isApplicationError("INVALID_STATE"),
      );
      await assert.rejects(
        pool.query(
          `UPDATE meta.resource_revisions
           SET parent_revision_id = $2
           WHERE revision_id = $1`,
          [published.revisionId, concurrentChildren[0]?.revisionId],
        ),
        isPostgresError("42501"),
      );
      await assert.rejects(
        pool.query(
          `UPDATE meta.resource_revisions
           SET created_by_principal_id = $2
           WHERE revision_id = $1`,
          [published.revisionId, principals.editor.principalId],
        ),
        isPostgresError("42501"),
      );

      const publishedChild = await resourceApplication.createChildDraft(ownerIdentity, {
        sourceRevisionId: published.revisionId,
        content: objectTypeContent("Child of Published Revision."),
      });
      assert.equal(publishedChild.parentRevisionId, published.revisionId);
      const publishedAfterEdit = await store.getRevision(published.revisionId);
      assert.deepEqual(publishedAfterEdit, published);

      const deprecatedRevision = await resourceApplication.deprecateRevision(ownerIdentity, {
        revisionId: published.revisionId,
      });
      const deprecatedChild = await resourceApplication.createChildDraft(ownerIdentity, {
        sourceRevisionId: deprecatedRevision.revisionId,
        content: objectTypeContent("Child of Deprecated Revision."),
      });
      assert.equal(deprecatedChild.parentRevisionId, deprecatedRevision.revisionId);
      await resourceApplication.archiveRevision(ownerIdentity, {
        revisionId: deprecatedRevision.revisionId,
      });
      await assert.rejects(
        resourceApplication.createChildDraft(ownerIdentity, {
          sourceRevisionId: deprecatedRevision.revisionId,
          content: objectTypeContent("Archived parent must fail."),
        }),
        isApplicationError("INVALID_STATE"),
      );

      const orderedResources = [];
      let resourceCursor = null;
      do {
        const page = await resourceApplication.listResources(ownerIdentity, {
          projectId: creation.project.projectId,
          limit: 1,
          ...(resourceCursor === null ? {} : { after: resourceCursor }),
        });
        orderedResources.push(...page.items);
        resourceCursor = page.nextCursor;
      } while (resourceCursor !== null);
      const resourceKeys = orderedResources.map(
        ({ namespace, apiName, resourceId: listedResourceId }) =>
          `${namespace}\u0000${apiName}\u0000${listedResourceId}`,
      );
      assert.deepEqual(resourceKeys, [...resourceKeys].sort());
      assert.equal(
        new Set(orderedResources.map(({ resourceId: listedResourceId }) => listedResourceId)).size,
        orderedResources.length,
      );

      await resourceApplication.deprecateResource(ownerIdentity, {
        resourceId: lifecycle.resource.resourceId,
      });
      const archivedResource = await resourceApplication.archiveResource(ownerIdentity, {
        resourceId: lifecycle.resource.resourceId,
      });
      assert.equal(archivedResource.state, "archived");
      await assert.rejects(
        store.patchDraftRevision({
          revisionId: publishedChild.revisionId,
          expectedEtag: publishedChild.etag,
          content: prepareDirectResourceContent(
            "object_type",
            objectTypeContent("Archived Resource must be read-only."),
          ),
        }),
        isApplicationError("INVALID_STATE"),
      );
      await assert.rejects(
        store.transitionRevisionState({
          revisionId: deprecatedChild.revisionId,
          targetState: "validated",
        }),
        isApplicationError("INVALID_STATE"),
      );
      await assert.rejects(
        pool.query(
          `UPDATE meta.resource_revisions
           SET content = '{"tampered":true}'::jsonb,
               content_digest = $2,
               etag = etag + 1,
               changed_at = clock_timestamp()
           WHERE revision_id = $1`,
          [publishedChild.revisionId, `sha256:${"f".repeat(64)}`],
        ),
        isPostgresError("55000"),
      );
      await assert.rejects(
        resourceApplication.createResource(ownerIdentity, {
          projectId: creation.project.projectId,
          namespace: lifecycle.resource.namespace,
          apiName: lifecycle.resource.apiName,
          family: lifecycle.resource.family,
          content: baseContent,
        }),
        isApplicationError("ALREADY_EXISTS"),
      );

      const noOp = await application.replaceRoleBinding(ownerIdentity, {
        projectId: creation.project.projectId,
        targetPrincipalId: principals.editor.principalId,
        role: "editor",
        expectedEpoch: epoch,
      });
      assert.deepEqual(
        { changed: noOp.changed, authorizationEpoch: noOp.authorizationEpoch },
        { changed: false, authorizationEpoch: epoch },
      );

      await assert.rejects(
        application.replaceRoleBinding(ownerIdentity, {
          projectId: creation.project.projectId,
          targetPrincipalId: principals.auditor.principalId,
          role: "executor",
          expectedEpoch: epoch - 1n,
        }),
        isApplicationError("CONCURRENT_MODIFICATION"),
      );
      assert.equal(await readEpoch(pool, creation.project.projectId), epoch);

      const collidingBindingStore = new PostgresMetadataControlPlane(
        pool,
        () => creation.ownerBinding.bindingId,
      );
      await assert.rejects(
        collidingBindingStore.replaceRoleBinding({
          projectId: creation.project.projectId,
          targetPrincipalId: principals.editor.principalId,
          resourceId: null,
          role: "viewer",
          expectedEpoch: epoch,
        }),
        isApplicationError("ALREADY_EXISTS"),
      );
      assert.equal(await readEpoch(pool, creation.project.projectId), epoch);
      assert.equal(
        await readActiveRole(pool, creation.project.projectId, principals.editor.principalId, null),
        "editor",
      );

      const revoked = await application.replaceRoleBinding(ownerIdentity, {
        projectId: creation.project.projectId,
        targetPrincipalId: principals.editor.principalId,
        role: null,
        expectedEpoch: epoch,
      });
      assert.equal(revoked.authorizationEpoch, epoch + 1n);
      epoch = revoked.authorizationEpoch;
      assert.equal(
        await application.authorizeManagement(identities.editor, {
          projectId: creation.project.projectId,
          permission: "metadata.read",
        }),
        false,
      );

      const releaseId = randomUUID();
      await pool.query(
        `INSERT INTO meta.releases
           (release_id, project_id, release_number, manifest_digest, created_by_principal_id)
         VALUES ($1, $2, 1, $3, $4)`,
        [
          releaseId,
          creation.project.projectId,
          `sha256:${"a".repeat(64)}`,
          ownerPrincipal.principalId,
        ],
      );
      const archived = await application.archiveProject(ownerIdentity, {
        projectId: creation.project.projectId,
        expectedEpoch: epoch,
      });
      assert.equal(archived.project.state, "archived");
      assert.equal(archived.authorizationEpoch, epoch + 1n);
      assert.equal(await rowCount(pool, "meta.resources", "resource_id", resourceId), 1);
      assert.equal(await rowCount(pool, "meta.releases", "release_id", releaseId), 1);
      assert.equal(
        await application.authorizeManagement(ownerIdentity, {
          projectId: creation.project.projectId,
          permission: "metadata.read",
        }),
        false,
      );
      await assert.rejects(
        application.createProject(identity("replacement-owner"), {
          apiName: creation.project.apiName,
          displayName: "Cannot Reuse Tombstone",
        }),
        isApplicationError("ALREADY_EXISTS"),
      );

      assert.ok(assignedBindings.get("editor"));
    } finally {
      await pool?.end();
      await docker(["rm", "--force", containerName], true);
    }
  },
);

function identity(subject: string): VerifiedFoundationIdentity {
  return parseVerifiedFoundationIdentity({
    issuer: "https://issuer.example.test",
    subject,
    displayName: `Identity ${subject}`,
    claimsFingerprint: `sha256:${subject.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`,
    authenticatedAt: "2026-08-14T00:00:00.000000Z",
  });
}

function sequenceUuidFactory(values: readonly string[]): () => string {
  const remaining = [...values];
  return () => {
    const value = remaining.shift();
    if (value === undefined) throw new Error("UUID sequence exhausted.");
    return value;
  };
}

async function assertProjectCreationFacts(
  pool: pg.Pool,
  projectId: string,
  principalId: string,
): Promise<void> {
  const result = await pool.query<{
    readonly owner_count: string;
    readonly epoch: string;
  }>(
    `SELECT COUNT(binding.binding_id)::text AS owner_count, epoch.epoch::text
     FROM authz.authorization_epochs AS epoch
     LEFT JOIN authz.role_bindings AS binding
       ON binding.project_id = epoch.project_id
      AND binding.principal_id = $2
      AND binding.scope = 'project'
      AND binding.role = 'owner'
      AND binding.state = 'active'
     WHERE epoch.project_id = $1
     GROUP BY epoch.epoch`,
    [projectId, principalId],
  );
  assert.deepEqual(result.rows[0], { owner_count: "1", epoch: "1" });
}

async function assertNoProjectFacts(pool: pg.Pool, projectId: string): Promise<void> {
  const result = await pool.query<{
    readonly projects: string;
    readonly bindings: string;
    readonly epochs: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM meta.projects WHERE project_id = $1)::text AS projects,
       (SELECT COUNT(*) FROM authz.role_bindings WHERE project_id = $1)::text AS bindings,
       (SELECT COUNT(*) FROM authz.authorization_epochs WHERE project_id = $1)::text AS epochs`,
    [projectId],
  );
  assert.deepEqual(result.rows[0], { projects: "0", bindings: "0", epochs: "0" });
}

async function readEpoch(pool: pg.Pool, projectId: string): Promise<bigint> {
  const result = await pool.query<{ readonly epoch: string }>(
    "SELECT epoch::text FROM authz.authorization_epochs WHERE project_id = $1",
    [projectId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return BigInt(row.epoch);
}

async function readActiveRole(
  pool: pg.Pool,
  projectId: string,
  principalId: string,
  resourceId: string | null,
): Promise<string | null> {
  const result = await pool.query<{ readonly role: string }>(
    `SELECT role
     FROM authz.role_bindings
     WHERE project_id = $1 AND principal_id = $2
       AND resource_id IS NOT DISTINCT FROM $3::uuid AND state = 'active'`,
    [projectId, principalId, resourceId],
  );
  return result.rows[0]?.role ?? null;
}

async function rowCount(
  pool: pg.Pool,
  table: "meta.resources" | "meta.releases",
  column: "resource_id" | "release_id",
  id: string,
): Promise<number> {
  const result = await pool.query<{ readonly count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${column} = $1`,
    [id],
  );
  return Number(result.rows[0]?.count ?? "0");
}

function objectTypeContent(description: string) {
  return {
    schemaVersion: 1,
    apiName: "Order",
    displayName: "Order",
    description,
    primaryKeyPropertyApiName: "orderId",
    titlePropertyApiName: "orderId",
    defaultSearchPropertyApiNames: [],
    defaultSort: [{ propertyApiName: "orderId", direction: "asc" }],
    defaultClassification: "internal",
    properties: [
      {
        schemaVersion: 1,
        apiName: "orderId",
        displayName: "Order ID",
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

function linkTypeContent(sourceRevisionId: string, targetRevisionId: string) {
  return {
    schemaVersion: 1,
    apiName: "OrderToCustomer",
    displayName: "Order to Customer",
    description: "Validated Link definition.",
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

function reverseObjectKeys(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).reverse());
}

function isApplicationError(code: MetadataApplicationError["code"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof MetadataApplicationError && error.code === code;
}

function isPostgresError(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === code;
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
