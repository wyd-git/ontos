import { createHash, randomUUID } from "node:crypto";

import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseCompatibilityReport,
  parseOntosId,
  parseValidationReport,
  type CompatibilityFindingContract,
  type CompatibilityReportContract,
  type LinkTypeDefinition,
  type ResourceFamily,
  type ValidationIssueContract,
  type ValidationReportContract,
} from "@ontos/contracts";
import { MetadataApplicationError } from "@ontos/metadata-application";
import type {
  AuthorizationRoleSnapshot,
  ManagementAuthorizationReader,
  PrincipalDirectory,
  PrincipalRecord,
  ProjectCreation,
  ProjectReadResult,
  ProjectRecord,
  ProjectRepository,
  ResourceCreation,
  ResourceLifecycleRepository,
  ResourceListCursor,
  ResourceRecord,
  ResourceRevisionRecord,
  ResourceScopeRecord,
  RevisionValidationResult,
  RevisionListCursor,
  RevisionScopeRecord,
  RoleBindingRecord,
  RoleBindingListResult,
  RoleBindingReplacement,
  RoleBindingRepository,
  VerifiedFoundationIdentity,
} from "@ontos/metadata-application";
import {
  METADATA_VALIDATOR_VERSION,
  METADATA_COMPATIBILITY_VERSION,
  MetadataDomainError,
  analyzeDependencyGraph,
  assertChildDraftSourceState,
  assertResourceRevisionStateTransition,
  assertResourceStateTransition,
  buildCompatibilityReport,
  compareResourceCompatibility,
  extractResourceDependencies,
  prepareDirectResourceContent,
  sortValidationIssues,
  validateDependencyTargets,
  validateRevisionDefinition,
  validatorVersionForFamily,
  type DependencyGraphEdge,
  type DependencyTargetSnapshot,
  type ExtractedResourceDependency,
  type ManagementRole,
  type PreparedResourceContent,
  type ResourceRevisionState,
  type ResourceState,
} from "@ontos/metadata-domain";
import type pg from "pg";

export {
  PostgresPackageStore,
  sha256CanonicalText,
  type PackagePrepareFaultPoint,
  type PostgresPackageStoreOptions,
} from "./package.ts";

export type UuidFactory = () => string;

interface PrincipalRow {
  readonly principal_id: string;
  readonly oidc_issuer: string;
  readonly oidc_subject: string;
  readonly display_name: string;
  readonly state: "active" | "disabled";
}

interface ProjectRow {
  readonly project_id: string;
  readonly api_name: string;
  readonly display_name: string;
  readonly state: "active" | "archived";
  readonly created_at: Date | string;
}

interface BindingRow {
  readonly binding_id: string;
  readonly project_id: string;
  readonly principal_id: string;
  readonly resource_id: string | null;
  readonly role: ManagementRole;
  readonly state: "active" | "revoked";
}

interface EpochRow {
  readonly epoch: string;
}

interface BindingListRow extends EpochRow {
  readonly binding_id: string | null;
  readonly project_id: string;
  readonly principal_id: string | null;
  readonly resource_id: string | null;
  readonly role: ManagementRole | null;
  readonly state: "active" | null;
}

interface AuthorizationRow extends EpochRow {
  readonly project_state: "active" | "archived";
  readonly principal_state: "active" | "disabled";
  readonly resource_exists: boolean;
  readonly project_role: ManagementRole | null;
  readonly resource_role: ManagementRole | null;
}

interface ResourceRow {
  readonly resource_id: string;
  readonly project_id: string;
  readonly namespace: string;
  readonly api_name: string;
  readonly family: ResourceFamily;
  readonly state: ResourceState;
  readonly created_at: Date | string;
}

interface RevisionRow {
  readonly revision_id: string;
  readonly resource_id: string;
  readonly parent_revision_id: string | null;
  readonly revision_number: string;
  readonly family: ResourceFamily;
  readonly state: ResourceRevisionState;
  readonly etag: string;
  readonly content_digest: string;
  readonly content: unknown;
  readonly created_by_principal_id: string;
  readonly created_at: Date | string;
}

interface ResourceScopeRow {
  readonly project_id: string;
  readonly resource_id: string;
}

interface RevisionScopeRow extends ResourceScopeRow {
  readonly family: ResourceFamily;
}

interface ValidationNodeRow extends RevisionRow {
  readonly project_id: string;
  readonly resource_state: ResourceState;
  readonly api_name: string;
}

interface DependencyRow {
  readonly source_revision_id: string;
  readonly target_revision_id: string;
  readonly dependency_type: ExtractedResourceDependency["dependencyType"];
  readonly source_path: string;
}

interface ValidationReportRow {
  readonly report_id: string;
  readonly subject_id: string;
  readonly subject_digest: string;
  readonly validator_version: string;
  readonly valid: boolean;
  readonly issues: unknown;
}

export class PostgresMetadataControlPlane
  implements
    PrincipalDirectory,
    ProjectRepository,
    RoleBindingRepository,
    ManagementAuthorizationReader,
    ResourceLifecycleRepository
{
  readonly #pool: pg.Pool;
  readonly #uuid: UuidFactory;

  constructor(pool: pg.Pool, uuidFactory: UuidFactory = randomUUID) {
    this.#pool = pool;
    this.#uuid = uuidFactory;
  }

  async resolveVerifiedIdentity(identity: VerifiedFoundationIdentity): Promise<PrincipalRecord> {
    return this.#transaction(async (client) => {
      await client.query(
        `INSERT INTO authz.principals
           (principal_id, oidc_issuer, oidc_subject, display_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (oidc_issuer, oidc_subject) DO NOTHING`,
        [this.#uuid(), identity.issuer, identity.subject, identity.displayName],
      );
      const result = await client.query<PrincipalRow>(
        `SELECT principal_id, oidc_issuer, oidc_subject, display_name, state
         FROM authz.principals
         WHERE oidc_issuer = $1 AND oidc_subject = $2`,
        [identity.issuer, identity.subject],
      );
      const row = requireRow(result.rows[0], "Principal mapping was not visible.");
      return principalRecord(row);
    });
  }

  async createProjectWithOwner(input: {
    readonly principalId: string;
    readonly apiName: string;
    readonly displayName: string;
  }): Promise<ProjectCreation> {
    const projectId = this.#uuid();
    const bindingId = this.#uuid();
    return this.#transaction(async (client) => {
      const projectResult = await client.query<ProjectRow>(
        `INSERT INTO meta.projects (project_id, api_name, display_name)
         VALUES ($1, $2, $3)
         RETURNING project_id, api_name, display_name, state, created_at`,
        [projectId, input.apiName, input.displayName],
      );
      const bindingResult = await client.query<BindingRow>(
        `INSERT INTO authz.role_bindings
           (binding_id, project_id, principal_id, scope, resource_id, role)
         VALUES ($1, $2, $3, 'project', NULL, 'owner')
         RETURNING binding_id, project_id, principal_id, resource_id, role, state`,
        [bindingId, projectId, input.principalId],
      );
      const epochResult = await client.query<EpochRow>(
        `INSERT INTO authz.authorization_epochs (project_id)
         VALUES ($1)
         RETURNING epoch::text`,
        [projectId],
      );
      return Object.freeze({
        project: projectRecord(
          requireRow(projectResult.rows[0], "Project insert returned no row."),
        ),
        ownerBinding: bindingRecord(
          requireRow(bindingResult.rows[0], "Owner Binding insert returned no row."),
        ),
        authorizationEpoch: BigInt(
          requireRow(epochResult.rows[0], "Authorization Epoch insert returned no row.").epoch,
        ),
      });
    });
  }

  async getProjectWithEpoch(projectId: string): Promise<ProjectReadResult> {
    try {
      const result = await this.#pool.query<ProjectRow & EpochRow>(
        `SELECT project.project_id, project.api_name, project.display_name,
                project.state, project.created_at, epoch.epoch::text
         FROM meta.projects AS project
         JOIN authz.authorization_epochs AS epoch ON epoch.project_id = project.project_id
         WHERE project.project_id = $1`,
        [projectId],
      );
      const row = requireRow(result.rows[0], "Project does not exist.", "NOT_FOUND");
      return Object.freeze({ project: projectRecord(row), authorizationEpoch: BigInt(row.epoch) });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async listRoleBindings(projectId: string): Promise<RoleBindingListResult> {
    try {
      const result = await this.#pool.query<BindingListRow>(
        `SELECT binding.binding_id,
                epoch.project_id,
                binding.principal_id,
                binding.resource_id,
                binding.role,
                binding.state,
                epoch.epoch::text
         FROM authz.authorization_epochs AS epoch
         LEFT JOIN authz.role_bindings AS binding
           ON binding.project_id = epoch.project_id
          AND binding.state = 'active'
         WHERE epoch.project_id = $1
         ORDER BY binding.principal_id, binding.resource_id NULLS FIRST, binding.binding_id
         LIMIT 1001`,
        [projectId],
      );
      const first = requireRow(
        result.rows[0],
        "Project authorization state does not exist.",
        "NOT_FOUND",
      );
      if (result.rows.length > 1000) {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "Project has more active Role Bindings than the G2-01 response bound permits.",
        );
      }
      const bindings = result.rows.flatMap((row) => {
        if (
          row.binding_id === null ||
          row.principal_id === null ||
          row.role === null ||
          row.state === null
        ) {
          return [];
        }
        return [
          bindingRecord({
            binding_id: row.binding_id,
            project_id: row.project_id,
            principal_id: row.principal_id,
            resource_id: row.resource_id,
            role: row.role,
            state: row.state,
          }),
        ];
      });
      return Object.freeze({
        items: Object.freeze(bindings),
        authorizationEpoch: BigInt(first.epoch),
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async replaceRoleBinding(input: {
    readonly projectId: string;
    readonly targetPrincipalId: string;
    readonly resourceId: string | null;
    readonly role: ManagementRole | null;
    readonly expectedEpoch: bigint;
  }): Promise<RoleBindingReplacement> {
    return this.#transaction(async (client) => {
      const epoch = await lockEpoch(client, input.projectId);
      assertExpectedEpoch(epoch, input.expectedEpoch);
      const scope = input.resourceId === null ? "project" : "resource";
      const currentResult = await client.query<BindingRow>(
        `SELECT binding_id, project_id, principal_id, resource_id, role, state
         FROM authz.role_bindings
         WHERE project_id = $1
           AND principal_id = $2
           AND scope = $3
           AND resource_id IS NOT DISTINCT FROM $4::uuid
           AND state = 'active'
         FOR UPDATE`,
        [input.projectId, input.targetPrincipalId, scope, input.resourceId],
      );
      const current = currentResult.rows[0];
      if ((current?.role ?? null) === input.role) {
        return Object.freeze({
          changed: false,
          authorizationEpoch: epoch,
          activeBinding: current === undefined ? null : bindingRecord(current),
        });
      }

      if (current !== undefined) {
        await client.query(
          `UPDATE authz.role_bindings
           SET state = 'revoked', revoked_at = clock_timestamp(), changed_at = clock_timestamp()
           WHERE binding_id = $1`,
          [current.binding_id],
        );
      }

      let activeBinding: RoleBindingRecord | null = null;
      if (input.role !== null) {
        const inserted = await client.query<BindingRow>(
          `INSERT INTO authz.role_bindings
             (binding_id, project_id, principal_id, scope, resource_id, role)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING binding_id, project_id, principal_id, resource_id, role, state`,
          [
            this.#uuid(),
            input.projectId,
            input.targetPrincipalId,
            scope,
            input.resourceId,
            input.role,
          ],
        );
        activeBinding = bindingRecord(
          requireRow(inserted.rows[0], "Role Binding insert returned no row."),
        );
      }

      const nextEpoch = await incrementEpoch(client, input.projectId);
      return Object.freeze({ changed: true, authorizationEpoch: nextEpoch, activeBinding });
    });
  }

  async archiveProject(input: {
    readonly projectId: string;
    readonly expectedEpoch: bigint;
  }): Promise<{ readonly project: ProjectRecord; readonly authorizationEpoch: bigint }> {
    return this.#transaction(async (client) => {
      const epoch = await lockEpoch(client, input.projectId);
      assertExpectedEpoch(epoch, input.expectedEpoch);
      const currentResult = await client.query<ProjectRow>(
        `SELECT project_id, api_name, display_name, state, created_at
         FROM meta.projects
         WHERE project_id = $1
         FOR UPDATE`,
        [input.projectId],
      );
      const current = requireRow(currentResult.rows[0], "Project does not exist.", "NOT_FOUND");
      if (current.state === "archived") {
        return Object.freeze({ project: projectRecord(current), authorizationEpoch: epoch });
      }
      const updatedResult = await client.query<ProjectRow>(
        `UPDATE meta.projects
         SET state = 'archived', changed_at = clock_timestamp()
         WHERE project_id = $1
         RETURNING project_id, api_name, display_name, state, created_at`,
        [input.projectId],
      );
      const nextEpoch = await incrementEpoch(client, input.projectId);
      return Object.freeze({
        project: projectRecord(
          requireRow(updatedResult.rows[0], "Project archive returned no row."),
        ),
        authorizationEpoch: nextEpoch,
      });
    });
  }

  async createResourceWithInitialDraft(input: {
    readonly projectId: string;
    readonly namespace: string;
    readonly apiName: string;
    readonly family: ResourceFamily;
    readonly authorPrincipalId: string;
    readonly content: PreparedResourceContent;
  }): Promise<ResourceCreation> {
    const prepared = verifiedPreparedContent(input.family, input.content);
    const digest = digestCanonicalContent(prepared.canonicalContent);
    const resourceId = this.#uuid();
    const revisionId = this.#uuid();
    return this.#transaction(async (client) => {
      const resourceResult = await client.query<ResourceRow>(
        `INSERT INTO meta.resources
           (resource_id, project_id, namespace, api_name, family)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING resource_id, project_id, namespace, api_name, family, state, created_at`,
        [resourceId, input.projectId, input.namespace, input.apiName, input.family],
      );
      const revisionResult = await client.query<RevisionRow>(
        `INSERT INTO meta.resource_revisions
           (revision_id, resource_id, parent_revision_id, revision_number, family,
            content_digest, content, created_by_principal_id)
         VALUES ($1, $2, NULL, 1, $3, $4, $5::jsonb, $6)
         RETURNING revision_id, resource_id, parent_revision_id, revision_number::text,
                   family, state, etag::text, content_digest, content,
                   created_by_principal_id, created_at`,
        [
          revisionId,
          resourceId,
          input.family,
          digest,
          prepared.canonicalContent,
          input.authorPrincipalId,
        ],
      );
      return Object.freeze({
        resource: resourceRecord(
          requireRow(resourceResult.rows[0], "Resource insert returned no row."),
        ),
        initialDraft: revisionRecord(
          requireRow(revisionResult.rows[0], "Initial Draft insert returned no row."),
        ),
      });
    });
  }

  async readResourceScope(resourceId: string): Promise<ResourceScopeRecord> {
    try {
      const result = await this.#pool.query<ResourceScopeRow>(
        `SELECT project_id, resource_id
         FROM meta.resources
         WHERE resource_id = $1`,
        [resourceId],
      );
      const row = requireRow(result.rows[0], "Resource does not exist.", "NOT_FOUND");
      return Object.freeze({ projectId: row.project_id, resourceId: row.resource_id });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async readRevisionScope(revisionId: string): Promise<RevisionScopeRecord> {
    try {
      const result = await this.#pool.query<RevisionScopeRow>(
        `SELECT resource.project_id, revision.resource_id, revision.family
         FROM meta.resource_revisions AS revision
         JOIN meta.resources AS resource ON resource.resource_id = revision.resource_id
         WHERE revision.revision_id = $1`,
        [revisionId],
      );
      const row = requireRow(result.rows[0], "Resource Revision does not exist.", "NOT_FOUND");
      return Object.freeze({
        projectId: row.project_id,
        resourceId: row.resource_id,
        family: row.family,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async getResource(resourceId: string): Promise<ResourceRecord> {
    try {
      const result = await this.#pool.query<ResourceRow>(
        `SELECT resource_id, project_id, namespace, api_name, family, state, created_at
         FROM meta.resources
         WHERE resource_id = $1`,
        [resourceId],
      );
      return resourceRecord(requireRow(result.rows[0], "Resource does not exist.", "NOT_FOUND"));
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async listResources(input: {
    readonly projectId: string;
    readonly limit: number;
    readonly after: ResourceListCursor | null;
  }): Promise<{
    readonly items: readonly ResourceRecord[];
    readonly nextCursor: ResourceListCursor | null;
  }> {
    try {
      const result = await this.#pool.query<ResourceRow>(
        `SELECT resource_id, project_id, namespace, api_name, family, state, created_at
         FROM meta.resources
         WHERE project_id = $1
           AND (
             $2::text IS NULL
             OR namespace COLLATE "C" > $2::text COLLATE "C"
             OR (namespace COLLATE "C" = $2::text COLLATE "C"
                 AND api_name COLLATE "C" > $3::text COLLATE "C")
             OR (namespace COLLATE "C" = $2::text COLLATE "C"
                 AND api_name COLLATE "C" = $3::text COLLATE "C"
                 AND resource_id > $4::uuid)
           )
         ORDER BY namespace COLLATE "C", api_name COLLATE "C", resource_id
         LIMIT $5`,
        [
          input.projectId,
          input.after?.namespace ?? null,
          input.after?.apiName ?? null,
          input.after?.resourceId ?? null,
          input.limit + 1,
        ],
      );
      const records = result.rows.map(resourceRecord);
      const items = Object.freeze(records.slice(0, input.limit));
      const last = records.length > input.limit ? items.at(-1) : undefined;
      return Object.freeze({
        items,
        nextCursor:
          last === undefined
            ? null
            : Object.freeze({
                namespace: last.namespace,
                apiName: last.apiName,
                resourceId: last.resourceId,
              }),
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async getRevision(revisionId: string): Promise<ResourceRevisionRecord> {
    try {
      const result = await this.#pool.query<RevisionRow>(
        `SELECT revision_id, resource_id, parent_revision_id, revision_number::text,
                family, state, etag::text, content_digest, content,
                created_by_principal_id, created_at
         FROM meta.resource_revisions
         WHERE revision_id = $1`,
        [revisionId],
      );
      return revisionRecord(
        requireRow(result.rows[0], "Resource Revision does not exist.", "NOT_FOUND"),
      );
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async listRevisions(input: {
    readonly resourceId: string;
    readonly limit: number;
    readonly after: RevisionListCursor | null;
  }): Promise<{
    readonly items: readonly ResourceRevisionRecord[];
    readonly nextCursor: RevisionListCursor | null;
  }> {
    try {
      const result = await this.#pool.query<RevisionRow>(
        `SELECT revision_id, resource_id, parent_revision_id, revision_number::text,
                family, state, etag::text, content_digest, content,
                created_by_principal_id, created_at
         FROM meta.resource_revisions AS revision
         WHERE revision.resource_id = $1
           AND (
             $2::bigint IS NULL
             OR revision.revision_number > $2::bigint
             OR (revision.revision_number = $2::bigint AND revision.revision_id > $3::uuid)
           )
         ORDER BY revision.revision_number, revision.revision_id
         LIMIT $4`,
        [
          input.resourceId,
          input.after?.revisionNumber.toString() ?? null,
          input.after?.revisionId ?? null,
          input.limit + 1,
        ],
      );
      const records = result.rows.map(revisionRecord);
      const items = Object.freeze(records.slice(0, input.limit));
      const last = records.length > input.limit ? items.at(-1) : undefined;
      return Object.freeze({
        items,
        nextCursor:
          last === undefined
            ? null
            : Object.freeze({
                revisionNumber: last.revisionNumber,
                revisionId: last.revisionId,
              }),
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async patchDraftRevision(input: {
    readonly revisionId: string;
    readonly expectedEtag: bigint;
    readonly content: PreparedResourceContent;
  }): Promise<ResourceRevisionRecord> {
    return this.#transaction(async (client) => {
      const identityResult = await client.query<{ readonly resource_id: string }>(
        `SELECT resource_id
         FROM meta.resource_revisions
         WHERE revision_id = $1`,
        [input.revisionId],
      );
      const { resource_id: resourceId } = requireRow(
        identityResult.rows[0],
        "Resource Revision does not exist.",
        "NOT_FOUND",
      );
      const resourceResult = await client.query<ResourceRow>(
        `SELECT resource_id, project_id, namespace, api_name, family, state, created_at
         FROM meta.resources
         WHERE resource_id = $1
         FOR UPDATE`,
        [resourceId],
      );
      const resource = resourceRecord(
        requireRow(resourceResult.rows[0], "Resource does not exist.", "NOT_FOUND"),
      );
      if (resource.state !== "active") {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "A Draft under a non-active Resource cannot be patched.",
        );
      }
      const currentResult = await client.query<RevisionRow>(
        `SELECT revision_id, resource_id, parent_revision_id, revision_number::text,
                family, state, etag::text, content_digest, content,
                created_by_principal_id, created_at
         FROM meta.resource_revisions
         WHERE revision_id = $1
         FOR UPDATE`,
        [input.revisionId],
      );
      const current = revisionRecord(
        requireRow(currentResult.rows[0], "Resource Revision does not exist.", "NOT_FOUND"),
      );
      if (current.state !== "draft") {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "Only a Draft Resource Revision can be patched.",
        );
      }
      if (current.etag !== input.expectedEtag) {
        throw new MetadataApplicationError(
          "CONCURRENT_MODIFICATION",
          "Resource Revision etag changed before the write.",
        );
      }
      if (current.resourceId !== resource.resourceId || current.family !== resource.family) {
        throw new MetadataApplicationError(
          "STORAGE_FAILURE",
          "Resource and Revision identity facts do not match.",
        );
      }
      const prepared = verifiedPreparedContent(current.family, input.content);
      const digest = digestCanonicalContent(prepared.canonicalContent);
      if (current.contentDigest === digest) return current;

      const updatedResult = await client.query<RevisionRow>(
        `UPDATE meta.resource_revisions
         SET content = $2::jsonb,
             content_digest = $3,
             etag = etag + 1,
             changed_at = clock_timestamp()
         WHERE revision_id = $1
         RETURNING revision_id, resource_id, parent_revision_id, revision_number::text,
                   family, state, etag::text, content_digest, content,
                   created_by_principal_id, created_at`,
        [input.revisionId, prepared.canonicalContent, digest],
      );
      return revisionRecord(
        requireRow(updatedResult.rows[0], "Draft Resource Revision update returned no row."),
      );
    });
  }

  async createChildDraft(input: {
    readonly sourceRevisionId: string;
    readonly authorPrincipalId: string;
    readonly content: PreparedResourceContent;
  }): Promise<ResourceRevisionRecord> {
    return this.#transaction(async (client) => {
      const sourceIdentityResult = await client.query<{ readonly resource_id: string }>(
        `SELECT resource_id
         FROM meta.resource_revisions
         WHERE revision_id = $1`,
        [input.sourceRevisionId],
      );
      const { resource_id: resourceId } = requireRow(
        sourceIdentityResult.rows[0],
        "Source Resource Revision does not exist.",
        "NOT_FOUND",
      );
      const resourceResult = await client.query<ResourceRow>(
        `SELECT resource_id, project_id, namespace, api_name, family, state, created_at
         FROM meta.resources
         WHERE resource_id = $1
         FOR UPDATE`,
        [resourceId],
      );
      const resource = resourceRecord(
        requireRow(resourceResult.rows[0], "Resource does not exist.", "NOT_FOUND"),
      );
      if (resource.state !== "active") {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "A child Draft cannot be created for a non-active Resource.",
        );
      }

      const sourceResult = await client.query<RevisionRow>(
        `SELECT revision_id, resource_id, parent_revision_id, revision_number::text,
                family, state, etag::text, content_digest, content,
                created_by_principal_id, created_at
         FROM meta.resource_revisions
         WHERE revision_id = $1
         FOR UPDATE`,
        [input.sourceRevisionId],
      );
      const source = revisionRecord(
        requireRow(sourceResult.rows[0], "Source Resource Revision does not exist.", "NOT_FOUND"),
      );
      assertChildSourceState(source.state);
      if (source.family !== resource.family) {
        throw new MetadataApplicationError(
          "STORAGE_FAILURE",
          "Resource and Revision families do not match.",
        );
      }
      const prepared = verifiedPreparedContent(source.family, input.content);
      const digest = digestCanonicalContent(prepared.canonicalContent);
      if (source.contentDigest === digest) {
        throw new MetadataApplicationError(
          "INVALID_INPUT",
          "A child Draft must contain a semantic content change.",
        );
      }
      const numberResult = await client.query<{ readonly revision_number: string }>(
        `SELECT (COALESCE(MAX(revision_number), 0) + 1)::text AS revision_number
         FROM meta.resource_revisions
         WHERE resource_id = $1`,
        [resourceId],
      );
      const revisionNumber = requireRow(
        numberResult.rows[0],
        "Resource Revision number allocation returned no row.",
      ).revision_number;
      const insertedResult = await client.query<RevisionRow>(
        `INSERT INTO meta.resource_revisions
           (revision_id, resource_id, parent_revision_id, revision_number, family,
            content_digest, content, created_by_principal_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING revision_id, resource_id, parent_revision_id, revision_number::text,
                   family, state, etag::text, content_digest, content,
                   created_by_principal_id, created_at`,
        [
          this.#uuid(),
          resourceId,
          source.revisionId,
          revisionNumber,
          source.family,
          digest,
          prepared.canonicalContent,
          input.authorPrincipalId,
        ],
      );
      return revisionRecord(
        requireRow(insertedResult.rows[0], "Child Draft insert returned no row."),
      );
    });
  }

  async validateDraftRevision(input: {
    readonly revisionId: string;
    readonly validatorVersion: string;
  }): Promise<RevisionValidationResult> {
    if (
      input.validatorVersion !== METADATA_VALIDATOR_VERSION &&
      input.validatorVersion !== "policy-g2-03-v1"
    ) {
      throw new MetadataApplicationError("INVALID_INPUT", "Validator version is not active.");
    }
    return this.#transaction(async (client) => {
      const identityResult = await client.query<{
        readonly resource_id: string;
        readonly project_id: string;
      }>(
        `SELECT revision.resource_id, resource.project_id
         FROM meta.resource_revisions AS revision
         JOIN meta.resources AS resource ON resource.resource_id = revision.resource_id
         WHERE revision.revision_id = $1`,
        [input.revisionId],
      );
      const identity = requireRow(
        identityResult.rows[0],
        "Resource Revision does not exist.",
        "NOT_FOUND",
      );
      const projectResult = await client.query<{ readonly state: "active" | "archived" }>(
        `SELECT state FROM meta.projects WHERE project_id = $1 FOR UPDATE`,
        [identity.project_id],
      );
      const project = requireRow(projectResult.rows[0], "Project does not exist.", "NOT_FOUND");
      if (project.state !== "active") {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "A Revision in an archived Project cannot be validated.",
        );
      }
      const resourceResult = await client.query<ResourceRow>(
        `SELECT resource_id, project_id, namespace, api_name, family, state, created_at
         FROM meta.resources
         WHERE resource_id = $1
         FOR UPDATE`,
        [identity.resource_id],
      );
      const resource = resourceRecord(
        requireRow(resourceResult.rows[0], "Resource does not exist.", "NOT_FOUND"),
      );
      if (resource.state !== "active") {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "A Revision under a non-active Resource cannot be validated.",
        );
      }
      const rootResult = await client.query<RevisionRow>(
        `SELECT revision_id, resource_id, parent_revision_id, revision_number::text,
                family, state, etag::text, content_digest, content,
                created_by_principal_id, created_at
         FROM meta.resource_revisions
         WHERE revision_id = $1
         FOR UPDATE`,
        [input.revisionId],
      );
      const root = revisionRecord(
        requireRow(rootResult.rows[0], "Resource Revision does not exist.", "NOT_FOUND"),
      );
      if (input.validatorVersion !== validatorVersionForFamily(root.family)) {
        throw new MetadataApplicationError("INVALID_INPUT", "Validator version is not active.");
      }
      if (root.state !== "draft") {
        if (
          new Set<ResourceRevisionState>(["validated", "published", "deprecated"]).has(root.state)
        ) {
          const report = await readRevisionValidationReport(
            client,
            root.revisionId,
            root.contentDigest,
            input.validatorVersion,
            true,
          );
          return Object.freeze({ revision: root, report });
        }
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "Only a Draft or reusable immutable Revision can be validated.",
        );
      }

      const definition = validateRevisionDefinition({
        revisionId: root.revisionId,
        resourceId: root.resourceId,
        family: root.family,
        content: root.content,
      });
      const initialTargets = definition.dependencies.map(
        ({ targetRevisionId }) => targetRevisionId,
      );
      const validationNodes = await client.query<ValidationNodeRow>(
        `WITH RECURSIVE closure(revision_id) AS (
           SELECT initial.revision_id
           FROM unnest($1::uuid[]) AS initial(revision_id)
           UNION
           SELECT dependency.target_revision_id
           FROM closure
           JOIN meta.resource_revisions AS source_revision
             ON source_revision.revision_id = closure.revision_id
           JOIN meta.resources AS source_resource
             ON source_resource.resource_id = source_revision.resource_id
            AND source_resource.project_id = $2
           JOIN meta.resource_dependencies AS dependency
             ON dependency.source_revision_id = closure.revision_id
         )
         SELECT revision.revision_id, revision.resource_id, revision.parent_revision_id,
                revision.revision_number::text, revision.family, revision.state,
                revision.etag::text, revision.content_digest, revision.content,
                revision.created_by_principal_id, revision.created_at,
                resource.project_id, resource.state AS resource_state, resource.api_name
         FROM closure
         JOIN meta.resource_revisions AS revision ON revision.revision_id = closure.revision_id
         JOIN meta.resources AS resource ON resource.resource_id = revision.resource_id
         WHERE resource.project_id = $2
         ORDER BY revision.revision_id
         FOR UPDATE OF revision, resource`,
        [initialTargets, resource.projectId],
      );
      const storedDependencies = await client.query<DependencyRow>(
        `WITH RECURSIVE closure(revision_id) AS (
           SELECT initial.revision_id
           FROM unnest($1::uuid[]) AS initial(revision_id)
           UNION
           SELECT dependency.target_revision_id
           FROM closure
           JOIN meta.resource_revisions AS source_revision
             ON source_revision.revision_id = closure.revision_id
           JOIN meta.resources AS source_resource
             ON source_resource.resource_id = source_revision.resource_id
            AND source_resource.project_id = $2
           JOIN meta.resource_dependencies AS dependency
             ON dependency.source_revision_id = closure.revision_id
         )
         SELECT dependency.source_revision_id, dependency.target_revision_id,
                dependency.dependency_type, dependency.source_path
         FROM closure
         JOIN meta.resource_dependencies AS dependency
           ON dependency.source_revision_id = closure.revision_id
         JOIN meta.resource_revisions AS source_revision
           ON source_revision.revision_id = dependency.source_revision_id
         JOIN meta.resources AS source_resource
           ON source_resource.resource_id = source_revision.resource_id
          AND source_resource.project_id = $2
         ORDER BY dependency.source_revision_id, dependency.dependency_type,
                  dependency.source_path, dependency.target_revision_id`,
        [initialTargets, resource.projectId],
      );

      const parsedNodes = validationNodes.rows.map((row) => ({
        row,
        revision: revisionRecord(row),
      }));
      const targetSnapshots: DependencyTargetSnapshot[] = parsedNodes.map(({ row, revision }) => ({
        revisionId: revision.revisionId,
        resourceId: revision.resourceId,
        projectId: row.project_id,
        family: revision.family,
        apiName: row.api_name,
        content: revision.content,
        resourceState: row.resource_state,
        revisionState: revision.state,
      }));
      const issues: ValidationIssueContract[] = [
        ...definition.issues,
        ...validateDependencyTargets({
          projectId: resource.projectId,
          resourceId: resource.resourceId,
          dependencies: definition.dependencies,
          targets: targetSnapshots,
        }),
      ];

      const nodeByRevision = new Map(parsedNodes.map((node) => [node.revision.revisionId, node]));
      const directTargetIds = new Set(
        definition.dependencies.map(({ targetRevisionId }) => targetRevisionId),
      );
      let closureInvalid = false;
      let graphDrift = false;
      for (const { row, revision } of parsedNodes) {
        if (revision.revisionId === root.revisionId) continue;
        if (
          !directTargetIds.has(revision.revisionId) &&
          (row.project_id !== resource.projectId ||
            row.resource_state === "archived" ||
            revision.state === "archived" ||
            !new Set<ResourceRevisionState>(["validated", "published", "deprecated"]).has(
              revision.state,
            ))
        ) {
          closureInvalid = true;
        }
        const expected = extractResourceDependencies(
          revision.revisionId,
          revision.family,
          revision.content,
        );
        const actual = storedDependencies.rows
          .filter(({ source_revision_id: source }) => source === revision.revisionId)
          .map(dependencyFromRow);
        if (!sameDependencyEdges(expected, actual)) graphDrift = true;
      }
      if (closureInvalid) {
        issues.push(
          validationReportIssue(
            "DEPENDENCY_CLOSURE_INVALID",
            resource.resourceId,
            "/dependencies",
            "The dependency closure contains an unavailable or unsupported Revision.",
            "Repair and validate the dependency chain before retrying.",
          ),
        );
      }
      if (graphDrift) {
        issues.push(
          validationReportIssue(
            "DEPENDENCY_GRAPH_DRIFT",
            resource.resourceId,
            "/dependencies",
            "Stored dependency edges do not match server extraction.",
            "Create a new Draft and let the server rebuild its dependency graph.",
          ),
        );
      }

      const graphEdges: DependencyGraphEdge[] = [
        ...definition.dependencies,
        ...storedDependencies.rows.map(dependencyFromRow),
      ];
      const graph = analyzeDependencyGraph({
        roots: [root.revisionId],
        revisionIds: [
          root.revisionId,
          ...[...nodeByRevision.keys()].filter((revisionId) => revisionId !== root.revisionId),
        ],
        edges: graphEdges,
      });
      if (
        graph.missingRevisionIds.length > 0 &&
        !issues.some(({ code }) => code === "DEPENDENCY_UNAVAILABLE")
      ) {
        issues.push(
          validationReportIssue(
            "DEPENDENCY_UNAVAILABLE",
            resource.resourceId,
            "/dependencies",
            "The dependency closure contains an unavailable Revision.",
            "Select visible, validated Revisions from the same Project.",
          ),
        );
      }
      if (graph.cyclePath !== null) {
        const cyclePointers = cycleSourcePaths(graph.cyclePath, graphEdges);
        issues.push(
          validationReportIssue(
            "DEPENDENCY_CYCLE",
            resource.resourceId,
            "/dependencies",
            "The dependency graph contains a cycle.",
            `Break the stable dependency path: ${cyclePointers.join(" -> ")}.`,
          ),
        );
      }

      const sortedIssues = sortValidationIssues(issues);
      const valid = !sortedIssues.some(({ severity }) => severity === "error");
      const contextDigest = validationContextDigest({
        validatorVersion: input.validatorVersion,
        root,
        nodes: parsedNodes.map(({ row, revision }) => ({ row, revision })),
        missingRevisionIds: graph.missingRevisionIds,
        edges: graphEdges,
        topologicalRevisionIds: graph.topologicalRevisionIds,
        cyclePath: graph.cyclePath,
      });
      let report = await findRevisionValidationReport(
        client,
        root.revisionId,
        root.contentDigest,
        contextDigest,
        input.validatorVersion,
      );
      if (report === null) {
        const insertedReport = await client.query<ValidationReportRow>(
          `INSERT INTO meta.validation_reports
             (report_id, subject_type, subject_id, resource_revision_id, release_id,
              subject_digest, validation_context_digest, validator_version, valid, issues)
           VALUES ($1, 'resource_revision', $2, $2, NULL, $3, $4, $5, $6, $7::jsonb)
           RETURNING report_id, subject_id, subject_digest, validator_version, valid, issues`,
          [
            this.#uuid(),
            root.revisionId,
            root.contentDigest,
            contextDigest,
            input.validatorVersion,
            valid,
            canonicalizeContractForDigest(sortedIssues),
          ],
        );
        report = validationReportRecord(
          requireRow(insertedReport.rows[0], "Validation Report insert returned no row."),
        );
      }

      if (!report.valid) return Object.freeze({ revision: root, report });
      for (const dependency of definition.dependencies) {
        await client.query(
          `INSERT INTO meta.resource_dependencies
             (dependency_id, source_revision_id, target_revision_id, dependency_type, source_path)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            this.#uuid(),
            dependency.sourceRevisionId,
            dependency.targetRevisionId,
            dependency.dependencyType,
            dependency.sourcePath,
          ],
        );
      }
      const updated = await client.query<RevisionRow>(
        `UPDATE meta.resource_revisions
         SET state = 'validated', changed_at = clock_timestamp()
         WHERE revision_id = $1
         RETURNING revision_id, resource_id, parent_revision_id, revision_number::text,
                   family, state, etag::text, content_digest, content,
                   created_by_principal_id, created_at`,
        [root.revisionId],
      );
      return Object.freeze({
        revision: revisionRecord(
          requireRow(updated.rows[0], "Validated Revision update returned no row."),
        ),
        report,
      });
    });
  }

  async getRevisionValidationReport(input: {
    readonly revisionId: string;
    readonly validatorVersion: string;
  }): Promise<ValidationReportContract> {
    try {
      const revision = await this.getRevision(input.revisionId);
      return await readRevisionValidationReport(
        this.#pool,
        input.revisionId,
        revision.contentDigest,
        input.validatorVersion,
        false,
      );
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async compareRevisionCompatibility(input: {
    readonly baselineRevisionId: string;
    readonly candidateRevisionId: string;
  }): Promise<CompatibilityReportContract> {
    try {
      const identifiers = [...new Set([input.baselineRevisionId, input.candidateRevisionId])];
      const result = await this.#pool.query<RevisionRow>(
        `SELECT revision_id, resource_id, parent_revision_id, revision_number::text,
                family, state, etag::text, content_digest, content,
                created_by_principal_id, created_at
         FROM meta.resource_revisions
         WHERE revision_id = ANY($1::uuid[])
         ORDER BY revision_id`,
        [identifiers],
      );
      if (result.rowCount !== identifiers.length) {
        throw new MetadataApplicationError(
          "NOT_FOUND",
          "One or more Resource Revisions do not exist in the authorized Resource.",
        );
      }
      const byId = new Map(result.rows.map((row) => [row.revision_id, revisionRecord(row)]));
      const baseline = requireRow(
        byId.get(input.baselineRevisionId),
        "Baseline Resource Revision does not exist.",
        "NOT_FOUND",
      );
      const candidate = requireRow(
        byId.get(input.candidateRevisionId),
        "Candidate Resource Revision does not exist.",
        "NOT_FOUND",
      );
      if (baseline.resourceId !== candidate.resourceId) {
        throw new MetadataApplicationError(
          "INVALID_INPUT",
          "Compatibility comparison requires two Revisions of the same Resource.",
        );
      }
      let endpointRevisionIdentities:
        readonly { readonly revisionId: string; readonly resourceId: string }[] | undefined;
      if (baseline.family === "link_type" && candidate.family === "link_type") {
        const baselineLink = baseline.content as LinkTypeDefinition;
        const candidateLink = candidate.content as LinkTypeDefinition;
        const endpointIds = [
          baselineLink.source.objectTypeRevisionId,
          baselineLink.target.objectTypeRevisionId,
          candidateLink.source.objectTypeRevisionId,
          candidateLink.target.objectTypeRevisionId,
        ];
        const endpointResult = await this.#pool.query<{
          readonly revision_id: string;
          readonly resource_id: string;
        }>(
          `SELECT endpoint_revision.revision_id, endpoint_revision.resource_id
           FROM meta.resource_revisions AS endpoint_revision
           JOIN meta.resources AS endpoint_resource
             ON endpoint_resource.resource_id = endpoint_revision.resource_id
           JOIN meta.resources AS source_resource
             ON source_resource.resource_id = $2
            AND source_resource.project_id = endpoint_resource.project_id
           WHERE endpoint_revision.revision_id = ANY($1::uuid[])
           ORDER BY endpoint_revision.revision_id`,
          [[...new Set(endpointIds)], baseline.resourceId],
        );
        endpointRevisionIdentities = endpointResult.rows.map(
          ({ revision_id: revisionId, resource_id: endpointResourceId }) => ({
            revisionId,
            resourceId: endpointResourceId,
          }),
        );
      }
      const compared = compareResourceCompatibility({
        baselineFamily: baseline.family,
        baselineContent: baseline.content,
        candidateFamily: candidate.family,
        candidateContent: candidate.content,
        ...(endpointRevisionIdentities === undefined ? {} : { endpointRevisionIdentities }),
      });
      const reportId = deterministicCompatibilityReportId({
        baselineRevisionId: baseline.revisionId,
        candidateRevisionId: candidate.revisionId,
        baselineDigest: baseline.contentDigest,
        candidateDigest: candidate.contentDigest,
        findings: compared.findings,
      });
      return parseCompatibilityReport(
        buildCompatibilityReport({
          reportId,
          baselineDigest: baseline.contentDigest,
          candidateDigest: candidate.contentDigest,
          evaluation: compared,
        }),
      );
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async transitionResourceState(input: {
    readonly resourceId: string;
    readonly targetState: ResourceState;
  }): Promise<ResourceRecord> {
    return this.#transaction(async (client) => {
      const currentResult = await client.query<ResourceRow>(
        `SELECT resource_id, project_id, namespace, api_name, family, state, created_at
         FROM meta.resources
         WHERE resource_id = $1
         FOR UPDATE`,
        [input.resourceId],
      );
      const current = resourceRecord(
        requireRow(currentResult.rows[0], "Resource does not exist.", "NOT_FOUND"),
      );
      assertResourceTransition(current.state, input.targetState);
      if (current.state === input.targetState) return current;
      const updatedResult = await client.query<ResourceRow>(
        `UPDATE meta.resources
         SET state = $2, changed_at = clock_timestamp()
         WHERE resource_id = $1
         RETURNING resource_id, project_id, namespace, api_name, family, state, created_at`,
        [input.resourceId, input.targetState],
      );
      return resourceRecord(
        requireRow(updatedResult.rows[0], "Resource state update returned no row."),
      );
    });
  }

  async transitionRevisionState(input: {
    readonly revisionId: string;
    readonly targetState: ResourceRevisionState;
  }): Promise<ResourceRevisionRecord> {
    if (input.targetState === "validated") {
      throw new MetadataApplicationError(
        "INVALID_STATE",
        "Draft validation must use the server Validator and Dependency Extractor.",
      );
    }
    return this.#transaction(async (client) => {
      const identityResult = await client.query<{ readonly resource_id: string }>(
        `SELECT resource_id
         FROM meta.resource_revisions
         WHERE revision_id = $1`,
        [input.revisionId],
      );
      const { resource_id: resourceId } = requireRow(
        identityResult.rows[0],
        "Resource Revision does not exist.",
        "NOT_FOUND",
      );
      const resourceResult = await client.query<ResourceRow>(
        `SELECT resource_id, project_id, namespace, api_name, family, state, created_at
         FROM meta.resources
         WHERE resource_id = $1
         FOR UPDATE`,
        [resourceId],
      );
      const resource = resourceRecord(
        requireRow(resourceResult.rows[0], "Resource does not exist.", "NOT_FOUND"),
      );
      const currentResult = await client.query<RevisionRow>(
        `SELECT revision_id, resource_id, parent_revision_id, revision_number::text,
                family, state, etag::text, content_digest, content,
                created_by_principal_id, created_at
         FROM meta.resource_revisions
         WHERE revision_id = $1
         FOR UPDATE`,
        [input.revisionId],
      );
      const current = revisionRecord(
        requireRow(currentResult.rows[0], "Resource Revision does not exist.", "NOT_FOUND"),
      );
      if (current.resourceId !== resource.resourceId || current.family !== resource.family) {
        throw new MetadataApplicationError(
          "STORAGE_FAILURE",
          "Resource and Revision identity facts do not match.",
        );
      }
      if (current.state === input.targetState) return current;
      if (
        (input.targetState === "validated" || input.targetState === "published") &&
        resource.state !== "active"
      ) {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "A non-active Resource cannot advance a Revision toward publication.",
        );
      }
      assertRevisionTransition(current.state, input.targetState);
      const updatedResult = await client.query<RevisionRow>(
        `UPDATE meta.resource_revisions
         SET state = $2, changed_at = clock_timestamp()
         WHERE revision_id = $1
         RETURNING revision_id, resource_id, parent_revision_id, revision_number::text,
                   family, state, etag::text, content_digest, content,
                   created_by_principal_id, created_at`,
        [input.revisionId, input.targetState],
      );
      return revisionRecord(
        requireRow(updatedResult.rows[0], "Resource Revision state update returned no row."),
      );
    });
  }

  async readAuthorizationRoles(input: {
    readonly principalId: string;
    readonly projectId: string;
    readonly resourceId: string | null;
  }): Promise<AuthorizationRoleSnapshot> {
    try {
      const result = await this.#pool.query<AuthorizationRow>(
        `SELECT epoch.epoch::text,
                project.state AS project_state,
                principal.state AS principal_state,
                CASE WHEN $3::uuid IS NULL THEN TRUE ELSE EXISTS (
                  SELECT 1
                  FROM meta.resources AS resource
                  WHERE resource.project_id = epoch.project_id
                    AND resource.resource_id = $3::uuid
                ) END AS resource_exists,
                (
                  SELECT binding.role
                  FROM authz.role_bindings AS binding
                  WHERE binding.project_id = epoch.project_id
                    AND binding.principal_id = principal.principal_id
                    AND binding.scope = 'project'
                    AND binding.state = 'active'
                ) AS project_role,
                CASE WHEN $3::uuid IS NULL THEN NULL ELSE (
                  SELECT binding.role
                  FROM authz.role_bindings AS binding
                  WHERE binding.project_id = epoch.project_id
                    AND binding.principal_id = principal.principal_id
                    AND binding.scope = 'resource'
                    AND binding.resource_id = $3::uuid
                    AND binding.state = 'active'
                ) END AS resource_role
         FROM authz.authorization_epochs AS epoch
         JOIN meta.projects AS project ON project.project_id = epoch.project_id
         JOIN authz.principals AS principal ON principal.principal_id = $2
         WHERE epoch.project_id = $1`,
        [input.projectId, input.principalId, input.resourceId],
      );
      const row = requireRow(result.rows[0], "Authorization state is unavailable.", "NOT_FOUND");
      const enabled =
        row.project_state === "active" && row.principal_state === "active" && row.resource_exists;
      return Object.freeze({
        authorizationEpoch: BigInt(row.epoch),
        projectRole: enabled ? row.project_role : null,
        resourceRole: enabled ? row.resource_role : null,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async #transaction<T>(action: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      throw mapStorageError(error);
    }
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      const value = await action(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError =
          rollbackError instanceof Error ? rollbackError : new Error("Rollback failed.");
      }
      throw mapStorageError(error);
    } finally {
      client.release(releaseError);
    }
  }
}

type ValidationQueryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

async function findRevisionValidationReport(
  queryable: ValidationQueryable,
  revisionId: string,
  subjectDigest: string,
  contextDigest: string,
  validatorVersion: string,
): Promise<ValidationReportContract | null> {
  const result = await queryable.query<ValidationReportRow>(
    `SELECT report_id, subject_id, subject_digest, validator_version, valid, issues
     FROM meta.validation_reports
     WHERE subject_type = 'resource_revision'
       AND resource_revision_id = $1
       AND subject_digest = $2
       AND validation_context_digest = $3
       AND validator_version = $4
     ORDER BY report_id
     LIMIT 1`,
    [revisionId, subjectDigest, contextDigest, validatorVersion],
  );
  const row = result.rows[0];
  return row === undefined ? null : validationReportRecord(row);
}

async function readRevisionValidationReport(
  queryable: ValidationQueryable,
  revisionId: string,
  subjectDigest: string,
  validatorVersion: string,
  requireValid: boolean,
): Promise<ValidationReportContract> {
  const result = await queryable.query<ValidationReportRow>(
    `SELECT report_id, subject_id, subject_digest, validator_version, valid, issues
     FROM meta.validation_reports
     WHERE subject_type = 'resource_revision'
       AND resource_revision_id = $1
       AND subject_digest = $2
       AND validator_version = $3
       AND ($4::boolean = FALSE OR valid = TRUE)
     ORDER BY created_at DESC, report_id DESC
     LIMIT 1`,
    [revisionId, subjectDigest, validatorVersion, requireValid],
  );
  return validationReportRecord(
    requireRow(result.rows[0], "Validation Report does not exist.", "NOT_FOUND"),
  );
}

function validationReportRecord(row: ValidationReportRow): ValidationReportContract {
  try {
    return parseValidationReport({
      schemaVersion: 1,
      reportId: row.report_id,
      subjectId: row.subject_id,
      subjectDigest: row.subject_digest,
      validatorVersion: row.validator_version,
      valid: row.valid,
      issues: row.issues,
    });
  } catch (error) {
    throw new MetadataApplicationError("STORAGE_FAILURE", "Stored Validation Report is invalid.", {
      cause: error,
    });
  }
}

function dependencyFromRow(row: DependencyRow): ExtractedResourceDependency {
  return Object.freeze({
    sourceRevisionId: row.source_revision_id,
    targetRevisionId: row.target_revision_id,
    dependencyType: row.dependency_type,
    sourcePath: row.source_path,
  });
}

function sameDependencyEdges(
  left: readonly ExtractedResourceDependency[],
  right: readonly ExtractedResourceDependency[],
): boolean {
  const leftKeys = left.map(dependencyComparisonKey).sort();
  const rightKeys = right.map(dependencyComparisonKey).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((value, index) => value === rightKeys[index])
  );
}

function dependencyComparisonKey(edge: ExtractedResourceDependency): string {
  return [edge.sourceRevisionId, edge.dependencyType, edge.sourcePath, edge.targetRevisionId].join(
    "\u0000",
  );
}

function cycleSourcePaths(
  cyclePath: readonly string[],
  edges: readonly DependencyGraphEdge[],
): readonly string[] {
  const paths: string[] = [];
  for (let index = 0; index + 1 < cyclePath.length; index += 1) {
    const source = cyclePath[index];
    const target = cyclePath[index + 1];
    const edge = edges
      .filter(
        (candidate) =>
          candidate.sourceRevisionId === source && candidate.targetRevisionId === target,
      )
      .sort((left, right) =>
        compareValidationText(dependencyComparisonKey(left), dependencyComparisonKey(right)),
      )[0];
    paths.push(edge?.sourcePath ?? "/dependencies");
  }
  return Object.freeze(paths);
}

function validationContextDigest(input: {
  readonly validatorVersion: string;
  readonly root: ResourceRevisionRecord;
  readonly nodes: readonly {
    readonly row: ValidationNodeRow;
    readonly revision: ResourceRevisionRecord;
  }[];
  readonly missingRevisionIds: readonly string[];
  readonly edges: readonly DependencyGraphEdge[];
  readonly topologicalRevisionIds: readonly string[];
  readonly cyclePath: readonly string[] | null;
}): `sha256:${string}` {
  const nodes = input.nodes
    .map(({ row, revision }) => ({
      revisionId: revision.revisionId,
      resourceId: revision.resourceId,
      projectId: row.project_id,
      family: revision.family,
      resourceState: row.resource_state,
      revisionState: revision.state,
      contentDigest: revision.contentDigest,
    }))
    .sort((left, right) => compareValidationText(left.revisionId, right.revisionId));
  const edges = input.edges
    .map((edge) => ({
      sourceRevisionId: edge.sourceRevisionId,
      targetRevisionId: edge.targetRevisionId,
      dependencyType: edge.dependencyType,
      sourcePath: edge.sourcePath,
    }))
    .sort((left, right) =>
      compareValidationText(dependencyComparisonKey(left), dependencyComparisonKey(right)),
    );
  return digestCanonicalContent(
    canonicalizeContractForDigest({
      schemaVersion: 1,
      validatorVersion: input.validatorVersion,
      subjectRevisionId: input.root.revisionId,
      subjectDigest: input.root.contentDigest,
      nodes,
      missingRevisionIds: [...input.missingRevisionIds].sort(compareValidationText),
      edges,
      topologicalRevisionIds: input.topologicalRevisionIds,
      cyclePath: input.cyclePath,
    }),
  );
}

function validationReportIssue(
  code: string,
  resourceId: string,
  path: string,
  message: string,
  remediation: string,
): ValidationIssueContract {
  return Object.freeze({
    code,
    severity: "error",
    resourceId: parseOntosId(resourceId, "$validationIssue.resourceId"),
    path,
    message,
    remediation,
  });
}

function compareValidationText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function lockEpoch(client: pg.PoolClient, projectId: string): Promise<bigint> {
  const result = await client.query<EpochRow>(
    `SELECT authz.lock_authorization_epoch($1)::text AS epoch`,
    [projectId],
  );
  return BigInt(
    requireRow(result.rows[0], "Authorization Epoch does not exist.", "NOT_FOUND").epoch,
  );
}

async function incrementEpoch(client: pg.PoolClient, projectId: string): Promise<bigint> {
  const result = await client.query<EpochRow>(
    `SELECT authz.advance_authorization_epoch($1, NULL)::text AS epoch`,
    [projectId],
  );
  return BigInt(requireRow(result.rows[0], "Authorization Epoch advance returned no row.").epoch);
}

function assertExpectedEpoch(actual: bigint, expected: bigint): void {
  if (actual !== expected) {
    throw new MetadataApplicationError(
      "CONCURRENT_MODIFICATION",
      "Authorization Epoch changed before the write.",
    );
  }
}

function principalRecord(row: PrincipalRow): PrincipalRecord {
  return Object.freeze({
    principalId: row.principal_id,
    issuer: row.oidc_issuer,
    subject: row.oidc_subject,
    displayName: row.display_name,
    state: row.state,
  });
}

function projectRecord(row: ProjectRow): ProjectRecord {
  return Object.freeze({
    projectId: row.project_id,
    apiName: row.api_name,
    displayName: row.display_name,
    state: row.state,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  });
}

function resourceRecord(row: ResourceRow): ResourceRecord {
  return Object.freeze({
    resourceId: row.resource_id,
    projectId: row.project_id,
    namespace: row.namespace,
    apiName: row.api_name,
    family: row.family,
    state: row.state,
    createdAt: timestamp(row.created_at),
  });
}

function revisionRecord(row: RevisionRow): ResourceRevisionRecord {
  try {
    const prepared = prepareDirectResourceContent(row.family, row.content);
    const actualDigest = digestCanonicalContent(prepared.canonicalContent);
    const storedDigest = parseArtifactDigest(row.content_digest, "$storage.contentDigest");
    if (storedDigest !== actualDigest) {
      throw new MetadataApplicationError(
        "STORAGE_FAILURE",
        "Stored Resource Revision content does not match its digest.",
      );
    }
    return Object.freeze({
      revisionId: row.revision_id,
      resourceId: row.resource_id,
      parentRevisionId: row.parent_revision_id,
      revisionNumber: BigInt(row.revision_number),
      family: row.family,
      state: row.state,
      etag: BigInt(row.etag),
      contentDigest: storedDigest,
      content: prepared.content,
      createdByPrincipalId: row.created_by_principal_id,
      createdAt: timestamp(row.created_at),
    });
  } catch (error) {
    if (error instanceof MetadataApplicationError) throw error;
    throw new MetadataApplicationError(
      "STORAGE_FAILURE",
      "Stored Resource Revision content is invalid.",
      { cause: error },
    );
  }
}

function verifiedPreparedContent(
  family: ResourceFamily,
  input: PreparedResourceContent,
): PreparedResourceContent {
  try {
    const normalized = prepareDirectResourceContent(family, input.content);
    const suppliedPreimage = canonicalizeContractForDigest(input.content);
    if (
      input.canonicalContent !== suppliedPreimage ||
      input.canonicalContent !== normalized.canonicalContent
    ) {
      throw new MetadataApplicationError(
        "INVALID_INPUT",
        "Resource content canonical preimage does not match its parsed content.",
      );
    }
    return normalized;
  } catch (error) {
    if (error instanceof MetadataApplicationError) throw error;
    throw new MetadataApplicationError(
      "INVALID_INPUT",
      "Resource content does not satisfy its family contract.",
      { cause: error },
    );
  }
}

function digestCanonicalContent(canonicalContent: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalContent, "utf8").digest("hex")}`;
}

function deterministicCompatibilityReportId(input: {
  readonly baselineRevisionId: string;
  readonly candidateRevisionId: string;
  readonly baselineDigest: string;
  readonly candidateDigest: string;
  readonly findings: readonly CompatibilityFindingContract[];
}) {
  const hexadecimal = createHash("sha256")
    .update(
      canonicalizeContractForDigest({
        version: METADATA_COMPATIBILITY_VERSION,
        baselineRevisionId: input.baselineRevisionId,
        candidateRevisionId: input.candidateRevisionId,
        baselineDigest: input.baselineDigest,
        candidateDigest: input.candidateDigest,
        findings: input.findings,
      }),
      "utf8",
    )
    .digest("hex");
  const uuid = `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-5${hexadecimal.slice(
    13,
    16,
  )}-a${hexadecimal.slice(17, 20)}-${hexadecimal.slice(20, 32)}`;
  return parseOntosId(uuid, "$compatibilityReport.reportId");
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function assertChildSourceState(state: ResourceRevisionState): void {
  mapDomainState(() => assertChildDraftSourceState(state));
}

function assertResourceTransition(current: ResourceState, target: ResourceState): void {
  mapDomainState(() => assertResourceStateTransition(current, target));
}

function assertRevisionTransition(
  current: ResourceRevisionState,
  target: ResourceRevisionState,
): void {
  mapDomainState(() => assertResourceRevisionStateTransition(current, target));
}

function mapDomainState(action: () => void): void {
  try {
    action();
  } catch (error) {
    if (error instanceof MetadataDomainError) {
      throw new MetadataApplicationError(error.code, error.message, { cause: error });
    }
    throw error;
  }
}

function bindingRecord(row: BindingRow): RoleBindingRecord {
  return Object.freeze({
    bindingId: row.binding_id,
    projectId: row.project_id,
    principalId: row.principal_id,
    resourceId: row.resource_id,
    role: row.role,
    state: row.state,
  });
}

function requireRow<T>(
  row: T | undefined,
  message: string,
  code: "NOT_FOUND" | "STORAGE_FAILURE" = "STORAGE_FAILURE",
): T {
  if (row === undefined) throw new MetadataApplicationError(code, message);
  return row;
}

function mapStorageError(error: unknown): MetadataApplicationError {
  if (error instanceof MetadataApplicationError) return error;
  const postgresCode = postgreSqlErrorCode(error);
  if (postgresCode === "23505") {
    return new MetadataApplicationError(
      "ALREADY_EXISTS",
      "A unique metadata fact already exists.",
      {
        cause: error,
      },
    );
  }
  if (postgresCode === "23503") {
    return new MetadataApplicationError("NOT_FOUND", "A referenced metadata fact does not exist.", {
      cause: error,
    });
  }
  if (postgresCode === "22P02" || postgresCode === "23514") {
    return new MetadataApplicationError("INVALID_INPUT", "The metadata write is invalid.", {
      cause: error,
    });
  }
  if (postgresCode === "40001" || postgresCode === "40P01") {
    return new MetadataApplicationError(
      "CONCURRENT_MODIFICATION",
      "The metadata transaction must be retried from a fresh read.",
      { cause: error },
    );
  }
  if (postgresCode === "55000") {
    return new MetadataApplicationError(
      "INVALID_STATE",
      "The metadata lifecycle transition is not allowed.",
      { cause: error },
    );
  }
  return new MetadataApplicationError("STORAGE_FAILURE", "The metadata store operation failed.", {
    cause: error,
  });
}

function postgreSqlErrorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("code" in value)) return null;
  return typeof value.code === "string" ? value.code : null;
}

export {
  PostgresReleaseStore,
  type PostgresReleaseStoreOptions,
  type ReleasePublishFaultPoint,
} from "./release.ts";
