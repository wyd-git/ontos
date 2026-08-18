import { createHash, randomUUID } from "node:crypto";

import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseCompatibilityReport,
  parseOntosId,
  parsePackageManifest,
  type ArtifactDigest,
  type CompatibilityReportContract,
  type PackageManifestContract,
  type ResourceFamily,
} from "@ontos/contracts";
import {
  MetadataApplicationError,
  type PackageChangeOperation,
  type PackageChangeRecord,
  type PackageChangeResult,
  type PackageLifecycleRepository,
} from "@ontos/metadata-application";
import {
  METADATA_PACKAGE_VALIDATOR_VERSION,
  METADATA_VALIDATOR_VERSION,
  PackageDomainError,
  assertPackageCandidateIntegrity,
  buildCompatibilityReport,
  comparePackageCompatibility,
  preparePackageCandidate,
  summarizeCompatibilityFindings,
  validateRevisionDefinition,
  type CompatibilityEvaluation,
  type PackageInstallInputBinding,
  type PreparedPackageCandidate,
  type PreparedPackageResource,
} from "@ontos/metadata-domain";
import type pg from "pg";

export type PackagePrepareFaultPoint =
  "after_package" | "after_resources" | "after_installation" | "after_release" | "after_change";

export interface PostgresPackageStoreOptions {
  readonly uuidFactory?: () => string;
  readonly faultInjector?: (point: PackagePrepareFaultPoint) => void;
}

interface PackageRow {
  readonly package_id: string;
  readonly namespace: string;
  readonly api_name: string;
}

interface PackageRevisionRow {
  readonly package_revision_id: string;
  readonly package_id: string;
  readonly version: string;
  readonly manifest_digest: string;
  readonly manifest: unknown;
}

interface InstallationRow {
  readonly installation_id: string;
  readonly project_id: string;
  readonly package_id: string;
  readonly active_package_revision_id: string | null;
  readonly active_release_id: string | null;
  readonly control_sequence: string;
}

interface ChangeRow {
  readonly operation: PackageChangeOperation;
  readonly project_id: string;
  readonly package_id: string;
  readonly target_package_revision_id: string;
  readonly installation_id: string;
  readonly change_id: string;
  readonly target_release_id: string;
  readonly target_channel_name: string;
  readonly request_key: string;
  readonly request_digest: string;
  readonly input_bindings: unknown;
  readonly input_bindings_digest: string;
  readonly state: "pending" | "active" | "superseded" | "failed";
  readonly manifest: unknown;
  readonly compatibility_report: unknown;
}

interface RevisionFactRow {
  readonly revision_id: string;
  readonly resource_id: string;
  readonly namespace: string;
  readonly api_name: string;
  readonly family: ResourceFamily;
  readonly content_digest: string;
  readonly content: unknown;
  readonly state: string;
}

interface ReleasePinFact {
  readonly resourceId: string;
  readonly revisionId: string;
  readonly family: ResourceFamily;
  readonly contentDigest: ArtifactDigest;
}

const reusableRevisionStates = new Set(["validated", "published", "deprecated"]);
const zeroDigest = parseArtifactDigest(`sha256:${"0".repeat(64)}`);

export class PostgresPackageStore implements PackageLifecycleRepository {
  readonly #pool: pg.Pool;
  readonly #uuid: () => string;
  readonly #faultInjector: (point: PackagePrepareFaultPoint) => void;

  constructor(pool: pg.Pool, options: PostgresPackageStoreOptions = {}) {
    this.#pool = pool;
    this.#uuid = options.uuidFactory ?? randomUUID;
    this.#faultInjector = options.faultInjector ?? (() => undefined);
  }

  async readInstallationScope(installationId: string): Promise<{ readonly projectId: string }> {
    try {
      const result = await this.#pool.query<{ readonly project_id: string }>(
        `SELECT project_id
         FROM meta.package_installations
         WHERE installation_id = $1`,
        [installationId],
      );
      return Object.freeze({
        projectId: requireRow(result.rows[0], "Package Installation does not exist.", "NOT_FOUND")
          .project_id,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async installPackage(input: CandidateChangeInput): Promise<PackageChangeResult> {
    return this.#prepareCandidateChange("install", input);
  }

  async upgradePackage(input: CandidateChangeInput): Promise<PackageChangeResult> {
    return this.#prepareCandidateChange("upgrade", input);
  }

  async rollbackPackage(input: {
    readonly installationId: string;
    readonly targetPackageRevisionId: string;
    readonly targetChannelName: string;
    readonly requestKey: string;
    readonly createdByPrincipalId: string;
  }): Promise<PackageChangeResult> {
    const scope = await this.readInstallationScope(input.installationId);
    return this.#transaction(async (client) => {
      await lockProjectAndAssertOwner(client, scope.projectId, input.createdByPrincipalId);
      const installation = await readInstallationById(client, input.installationId, true);
      if (
        installation.active_package_revision_id === null ||
        installation.active_release_id === null
      ) {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "An unactivated Package Installation cannot be rolled back.",
        );
      }
      await lockPackageIdentity(client, installation.package_id);
      const target = await readPackageRevision(
        client,
        installation.package_id,
        input.targetPackageRevisionId,
      );
      if (target.package_revision_id === installation.active_package_revision_id) {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "Package rollback target is already active.",
        );
      }
      const historical = await client.query<{
        readonly input_bindings: unknown;
        readonly input_bindings_digest: string;
      }>(
        `SELECT input_bindings, input_bindings_digest
         FROM meta.package_installation_changes
         WHERE installation_id = $1
           AND target_package_revision_id = $2
           AND state IN ('active', 'superseded')
         ORDER BY created_at DESC, change_id DESC
         LIMIT 1`,
        [installation.installation_id, target.package_revision_id],
      );
      const historicalInputs = requireRow(
        historical.rows[0],
        "Rollback target was never active in this Installation.",
        "INVALID_STATE",
      );
      const candidate = await preparedCandidateFromStoredRevision(
        client,
        target,
        historicalInputs.input_bindings,
      );
      const integrity = assertPackageCandidateIntegrity(candidate, sha256CanonicalText);
      if (integrity.inputBindingsDigest !== historicalInputs.input_bindings_digest) {
        throw new MetadataApplicationError(
          "STORAGE_FAILURE",
          "Historical Package input binding Digest does not match its stored content.",
        );
      }
      return this.#prepareLockedChange(client, {
        operation: "rollback",
        projectId: installation.project_id,
        targetChannelName: input.targetChannelName,
        requestKey: input.requestKey,
        candidate,
        manifestDigest: integrity.manifestDigest,
        inputBindingsDigest: integrity.inputBindingsDigest,
        createdByPrincipalId: input.createdByPrincipalId,
        packageIdentity: await readPackageById(client, installation.package_id),
        installation,
        targetRevision: target,
        persistCandidate: false,
      });
    });
  }

  async #prepareCandidateChange(
    operation: "install" | "upgrade",
    input: CandidateChangeInput,
  ): Promise<PackageChangeResult> {
    let candidate: PreparedPackageCandidate;
    let integrity;
    try {
      candidate = revalidatePreparedCandidate(input.candidate);
      integrity = assertPackageCandidateIntegrity(candidate, sha256CanonicalText);
    } catch (error) {
      throw mapStorageError(error);
    }
    if (
      integrity.manifestDigest !== input.manifestDigest ||
      integrity.inputBindingsDigest !== input.inputBindingsDigest
    ) {
      throw new MetadataApplicationError(
        "INVALID_INPUT",
        "Package integrity facts differ from the server-computed values.",
      );
    }
    return this.#transaction(async (client) => {
      await lockProjectAndAssertOwner(client, input.projectId, input.createdByPrincipalId);
      const manifest = candidate.manifest;
      await lockPackageIdentity(client, `${manifest.namespace}:${manifest.packageApiName}`);
      const packageIdentity = await findPackageByIdentity(
        client,
        manifest.namespace,
        manifest.packageApiName,
      );
      const packageId = packageIdentity?.package_id ?? this.#uuid();
      let installation: InstallationRow | null;
      if (
        operation === "upgrade" &&
        input.installationId !== undefined &&
        input.installationId !== null
      ) {
        installation = await readInstallationById(client, input.installationId, true);
        if (
          packageIdentity === null ||
          installation.project_id !== input.projectId ||
          installation.package_id !== packageId
        ) {
          throw new MetadataApplicationError(
            "NOT_FOUND",
            "Package Installation is not accessible for this candidate.",
          );
        }
      } else {
        installation =
          packageIdentity === null
            ? null
            : await findInstallation(client, input.projectId, packageId, true);
      }
      const targetRevision =
        packageIdentity === null
          ? null
          : await findPackageRevisionByVersion(client, packageId, manifest.version);
      if (targetRevision !== null && targetRevision.manifest_digest !== manifest.manifestDigest) {
        throw new MetadataApplicationError(
          "ALREADY_EXISTS",
          "Package version already exists with different immutable content.",
        );
      }
      return this.#prepareLockedChange(client, {
        operation,
        projectId: input.projectId,
        targetChannelName: input.targetChannelName,
        requestKey: input.requestKey,
        candidate,
        manifestDigest: input.manifestDigest,
        inputBindingsDigest: input.inputBindingsDigest,
        createdByPrincipalId: input.createdByPrincipalId,
        packageIdentity:
          packageIdentity ??
          Object.freeze({
            package_id: packageId,
            namespace: manifest.namespace,
            api_name: manifest.packageApiName,
          }),
        installation,
        targetRevision,
        persistCandidate: true,
      });
    });
  }

  async #prepareLockedChange(
    client: pg.PoolClient,
    input: LockedChangeInput,
  ): Promise<PackageChangeResult> {
    const requestDigest = digestCanonical({
      schemaVersion: 1,
      operation: input.operation,
      projectId: input.projectId,
      targetChannelName: input.targetChannelName,
      packageManifestDigest: input.manifestDigest,
      inputBindingsDigest: input.inputBindingsDigest,
    });
    if (input.installation !== null) {
      const idempotent = await findIdempotentChange(
        client,
        input.installation.installation_id,
        input.requestKey,
        requestDigest,
      );
      if (idempotent !== null)
        return acceptedResult(await readChangeRecord(client, idempotent, true));
    }

    if (input.operation === "install") {
      if (
        input.installation !== null &&
        (input.installation.active_package_revision_id !== null ||
          (await hasPendingChange(client, input.installation.installation_id)))
      ) {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "Package is already installed or has a Pending Change in this Project.",
        );
      }
    } else if (
      input.installation === null ||
      input.installation.active_package_revision_id === null ||
      input.installation.active_release_id === null
    ) {
      throw new MetadataApplicationError(
        "INVALID_STATE",
        `${capitalize(input.operation)} requires an active Package Installation.`,
      );
    }
    if (
      input.operation !== "install" &&
      input.targetRevision?.package_revision_id === input.installation?.active_package_revision_id
    ) {
      throw new MetadataApplicationError(
        "INVALID_STATE",
        "Target Package Revision is already active.",
      );
    }
    await assertNoPackageResourceOwnershipCollision(
      client,
      input.projectId,
      input.packageIdentity.package_id,
      input.candidate.manifest,
    );

    const baseline =
      input.installation?.active_package_revision_id === null ||
      input.installation?.active_package_revision_id === undefined
        ? null
        : await readPackageRevision(
            client,
            input.packageIdentity.package_id,
            input.installation.active_package_revision_id,
          );
    const compatibility = await buildPackageCompatibility(
      client,
      baseline,
      input.candidate,
      this.#uuid(),
    );
    if (compatibility.outcome !== "compatible") {
      return Object.freeze({ accepted: false, compatibility, change: null });
    }

    if (input.persistCandidate) {
      await client.query(
        `INSERT INTO meta.packages
           (package_id, namespace, api_name, created_by_principal_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (namespace, api_name) DO NOTHING`,
        [
          input.packageIdentity.package_id,
          input.packageIdentity.namespace,
          input.packageIdentity.api_name,
          input.createdByPrincipalId,
        ],
      );
      let targetRevision = input.targetRevision;
      if (targetRevision === null) {
        const packageRevisionId = this.#uuid();
        const inserted = await client.query<PackageRevisionRow>(
          `INSERT INTO meta.package_revisions
             (package_revision_id, package_id, version, manifest_digest, manifest,
              created_by_principal_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           RETURNING package_revision_id, package_id, version, manifest_digest, manifest`,
          [
            packageRevisionId,
            input.packageIdentity.package_id,
            input.candidate.manifest.version,
            input.manifestDigest,
            JSON.stringify(input.candidate.manifest),
            input.createdByPrincipalId,
          ],
        );
        targetRevision = requireRow(inserted.rows[0], "Package Revision insert returned no row.");
      }
      input.targetRevision = targetRevision;
      for (const artifactDigest of input.candidate.manifest.artifactDigests) {
        await client.query(
          `INSERT INTO meta.artifact_references
             (artifact_reference_id, digest, media_type, source_kind, source_id)
           VALUES ($1, $2, 'application/vnd.ontos.package-artifact',
                   'package_revision', $3)
           ON CONFLICT (digest, media_type, source_kind, source_id) DO NOTHING`,
          [this.#uuid(), artifactDigest, targetRevision.package_revision_id],
        );
      }
      this.#faultInjector("after_package");
      await persistPackageResources(
        client,
        input.projectId,
        input.candidate.resources,
        input.createdByPrincipalId,
        this.#uuid,
      );
      this.#faultInjector("after_resources");
    }

    const targetRevision = requireValue(
      input.targetRevision,
      "Target Package Revision was not available after persistence.",
    );
    let installation = input.installation;
    if (installation === null) {
      const inserted = await client.query<InstallationRow>(
        `INSERT INTO meta.package_installations
           (installation_id, project_id, package_id)
         VALUES ($1, $2, $3)
         RETURNING installation_id, project_id, package_id,
                   active_package_revision_id, active_release_id, control_sequence::text`,
        [this.#uuid(), input.projectId, input.packageIdentity.package_id],
      );
      installation = requireRow(inserted.rows[0], "Package Installation insert returned no row.");
    }
    this.#faultInjector("after_installation");

    const currentPackageManifest =
      baseline === null ? null : parsePackageManifest(baseline.manifest);
    const releaseId = await createPackageReleaseDraft(client, {
      projectId: input.projectId,
      targetChannelName: input.targetChannelName,
      previousPackageManifest: currentPackageManifest,
      targetManifest: input.candidate.manifest,
      createdByPrincipalId: input.createdByPrincipalId,
      uuid: this.#uuid,
    });
    this.#faultInjector("after_release");

    const changeId = this.#uuid();
    await client.query(
      `INSERT INTO meta.package_installation_changes
         (change_id, installation_id, project_id, package_id, request_key,
          target_package_revision_id, target_release_id, operation,
          previous_package_revision_id, previous_release_id, request_digest,
          input_bindings, input_bindings_digest, compatibility_report,
          created_by_principal_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12::jsonb, $13, $14::jsonb, $15)`,
      [
        changeId,
        installation.installation_id,
        input.projectId,
        input.packageIdentity.package_id,
        input.requestKey,
        targetRevision.package_revision_id,
        releaseId,
        input.operation,
        installation.active_package_revision_id,
        installation.active_release_id,
        requestDigest,
        JSON.stringify(input.candidate.installInputBindings),
        input.inputBindingsDigest,
        JSON.stringify(compatibility),
        input.createdByPrincipalId,
      ],
    );
    this.#faultInjector("after_change");
    return acceptedResult(await readChangeRecord(client, changeId, false));
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
      const result = await action(client);
      await client.query("COMMIT");
      return result;
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

interface CandidateChangeInput {
  readonly installationId?: string | null;
  readonly projectId: string;
  readonly targetChannelName: string;
  readonly requestKey: string;
  readonly candidate: PreparedPackageCandidate;
  readonly manifestDigest: ArtifactDigest;
  readonly inputBindingsDigest: ArtifactDigest;
  readonly createdByPrincipalId: string;
}

interface LockedChangeInput extends CandidateChangeInput {
  readonly operation: PackageChangeOperation;
  readonly packageIdentity: PackageRow;
  readonly installation: InstallationRow | null;
  targetRevision: PackageRevisionRow | null;
  readonly persistCandidate: boolean;
}

async function lockProjectAndAssertOwner(
  client: pg.PoolClient,
  projectId: string,
  principalId: string,
): Promise<void> {
  const result = await client.query<{ readonly state: string; readonly allowed: boolean }>(
    `SELECT project.state,
            EXISTS (
              SELECT 1
              FROM authz.principals AS principal
              JOIN authz.role_bindings AS binding
                ON binding.principal_id = principal.principal_id
               AND binding.project_id = project.project_id
               AND binding.scope = 'project'
               AND binding.resource_id IS NULL
               AND binding.role = 'owner'
               AND binding.state = 'active'
              WHERE principal.principal_id = $2 AND principal.state = 'active'
            ) AS allowed
     FROM meta.projects AS project
     WHERE project.project_id = $1
     FOR UPDATE OF project`,
    [projectId, principalId],
  );
  const row = requireRow(result.rows[0], "Project control state does not exist.", "NOT_FOUND");
  await client.query(`SELECT authz.lock_authorization_epoch($1)`, [projectId]);
  if (row.state !== "active") {
    throw new MetadataApplicationError("INVALID_STATE", "Archived Project cannot change Packages.");
  }
  if (!row.allowed) {
    throw new MetadataApplicationError(
      "FORBIDDEN",
      "Principal no longer has the Project Owner Package grant.",
    );
  }
}

async function lockPackageIdentity(client: pg.PoolClient, identity: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 20109))`, [identity]);
}

async function findPackageByIdentity(
  client: pg.PoolClient,
  namespace: string,
  apiName: string,
): Promise<PackageRow | null> {
  const result = await client.query<PackageRow>(
    `SELECT package_id, namespace, api_name
     FROM meta.packages
     WHERE namespace = $1 AND api_name = $2`,
    [namespace, apiName],
  );
  return result.rows[0] ?? null;
}

async function readPackageById(client: pg.PoolClient, packageId: string): Promise<PackageRow> {
  const result = await client.query<PackageRow>(
    `SELECT package_id, namespace, api_name
     FROM meta.packages
     WHERE package_id = $1`,
    [packageId],
  );
  return requireRow(result.rows[0], "Package does not exist.", "NOT_FOUND");
}

async function findPackageRevisionByVersion(
  client: pg.PoolClient,
  packageId: string,
  version: string,
): Promise<PackageRevisionRow | null> {
  const result = await client.query<PackageRevisionRow>(
    `SELECT package_revision_id, package_id, version, manifest_digest, manifest
     FROM meta.package_revisions
     WHERE package_id = $1 AND version = $2`,
    [packageId, version],
  );
  return result.rows[0] ?? null;
}

async function readPackageRevision(
  client: pg.PoolClient,
  packageId: string,
  packageRevisionId: string,
): Promise<PackageRevisionRow> {
  const result = await client.query<PackageRevisionRow>(
    `SELECT package_revision_id, package_id, version, manifest_digest, manifest
     FROM meta.package_revisions
     WHERE package_id = $1 AND package_revision_id = $2`,
    [packageId, packageRevisionId],
  );
  return requireRow(result.rows[0], "Package Revision does not exist.", "NOT_FOUND");
}

async function findInstallation(
  client: pg.PoolClient,
  projectId: string,
  packageId: string,
  lock: boolean,
): Promise<InstallationRow | null> {
  const result = await client.query<InstallationRow>(
    `SELECT installation_id, project_id, package_id, active_package_revision_id,
            active_release_id, control_sequence::text
     FROM meta.package_installations
     WHERE project_id = $1 AND package_id = $2${lock ? " FOR UPDATE" : ""}`,
    [projectId, packageId],
  );
  return result.rows[0] ?? null;
}

async function readInstallationById(
  client: pg.PoolClient,
  installationId: string,
  lock: boolean,
): Promise<InstallationRow> {
  const result = await client.query<InstallationRow>(
    `SELECT installation_id, project_id, package_id, active_package_revision_id,
            active_release_id, control_sequence::text
     FROM meta.package_installations
     WHERE installation_id = $1${lock ? " FOR UPDATE" : ""}`,
    [installationId],
  );
  return requireRow(result.rows[0], "Package Installation does not exist.", "NOT_FOUND");
}

async function hasPendingChange(client: pg.PoolClient, installationId: string): Promise<boolean> {
  const result = await client.query<{ readonly present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM meta.package_installation_changes
       WHERE installation_id = $1 AND state = 'pending'
     ) AS present`,
    [installationId],
  );
  return result.rows[0]?.present === true;
}

async function findIdempotentChange(
  client: pg.PoolClient,
  installationId: string,
  requestKey: string,
  requestDigest: string,
): Promise<string | null> {
  const result = await client.query<{
    readonly change_id: string;
    readonly request_key: string;
    readonly request_digest: string;
  }>(
    `SELECT change_id, request_key, request_digest
     FROM meta.package_installation_changes
     WHERE installation_id = $1
       AND (request_key = $2 OR request_digest = $3)
     ORDER BY change_id`,
    [installationId, requestKey, requestDigest],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1 || result.rows[0]?.request_digest !== requestDigest) {
    throw new MetadataApplicationError(
      "ALREADY_EXISTS",
      "Package idempotency key or request content was reused inconsistently.",
    );
  }
  return requireValue(result.rows[0]?.change_id, "Idempotent Package Change has no identity.");
}

async function buildPackageCompatibility(
  client: pg.PoolClient,
  baseline: PackageRevisionRow | null,
  candidate: PreparedPackageCandidate,
  reportId: string,
): Promise<CompatibilityReportContract> {
  const rawEvaluation =
    baseline === null
      ? summarizeCompatibilityFindings([])
      : comparePackageCompatibility({
          baselineManifest: parsePackageManifest(baseline.manifest),
          candidateManifest: candidate.manifest,
          baselinePins: await readPackageCompatibilityPins(
            client,
            parsePackageManifest(baseline.manifest),
          ),
          candidatePins: candidate.resources.map((resource) => ({
            namespace: resource.namespace,
            apiName: resource.apiName,
            resourceId: resource.resourceId,
            revisionId: resource.revisionId,
            family: resource.family,
            contentDigest: resource.contentDigest,
            content: resource.content,
          })),
          candidateDependencies: candidate.resources.flatMap(({ dependencies }) => dependencies),
        });
  const evaluation = boundPackageCompatibility(rawEvaluation);
  return parseCompatibilityReport({
    ...buildCompatibilityReport({
      reportId: parseOntosId(reportId),
      baselineDigest:
        baseline === null ? zeroDigest : parseArtifactDigest(baseline.manifest_digest),
      candidateDigest: candidate.manifest.manifestDigest,
      evaluation,
    }),
  });
}

async function assertNoPackageResourceOwnershipCollision(
  client: pg.PoolClient,
  projectId: string,
  packageId: string,
  manifest: PackageManifestContract,
): Promise<void> {
  const result = await client.query<{ readonly collided: boolean }>(
    `WITH candidate AS (
       SELECT value
       FROM jsonb_array_elements($3::jsonb) AS entry(value)
     ), owned AS (
       SELECT entry.value
       FROM meta.package_installations AS installation
       JOIN meta.package_revisions AS revision
         ON revision.package_revision_id = installation.active_package_revision_id
       CROSS JOIN LATERAL
         jsonb_array_elements(revision.manifest -> 'resourceEntries') AS entry(value)
       WHERE installation.project_id = $1
         AND installation.package_id <> $2
       UNION ALL
       SELECT entry.value
       FROM meta.package_installations AS installation
       JOIN meta.package_installation_changes AS change
         ON change.installation_id = installation.installation_id
        AND change.state = 'pending'
       JOIN meta.package_revisions AS revision
         ON revision.package_revision_id = change.target_package_revision_id
       CROSS JOIN LATERAL
         jsonb_array_elements(revision.manifest -> 'resourceEntries') AS entry(value)
       WHERE installation.project_id = $1
         AND installation.package_id <> $2
     )
     SELECT EXISTS (
       SELECT 1
       FROM candidate
       JOIN owned
         ON candidate.value ->> 'resourceId' = owned.value ->> 'resourceId'
         OR (
           candidate.value ->> 'namespace' = owned.value ->> 'namespace'
           AND candidate.value ->> 'apiName' = owned.value ->> 'apiName'
         )
     ) AS collided`,
    [projectId, packageId, JSON.stringify(manifest.resourceEntries)],
  );
  if (result.rows[0]?.collided === true) {
    throw new MetadataApplicationError(
      "ALREADY_EXISTS",
      "Package Resource ownership overlaps another active or Pending Package.",
    );
  }
}

function revalidatePreparedCandidate(
  candidate: PreparedPackageCandidate,
): PreparedPackageCandidate {
  return preparePackageCandidate({
    manifest: candidate.manifest,
    resources: candidate.resources.map(({ resourceId, revisionId, content }) => ({
      resourceId,
      revisionId,
      content,
    })),
    installInputBindings: candidate.installInputBindings,
  });
}

function boundPackageCompatibility(evaluation: CompatibilityEvaluation): CompatibilityEvaluation {
  if (evaluation.findings.length <= 1_000) return evaluation;
  return Object.freeze({
    outcome: evaluation.outcome,
    findings: Object.freeze([
      ...evaluation.findings.slice(0, 999),
      Object.freeze({
        kind: evaluation.outcome,
        code: "PACKAGE_FINDINGS_TRUNCATED",
        path: "/resourceEntries",
        message: `Package compatibility produced ${String(evaluation.findings.length)} findings; the public report is bounded to 1000.`,
        requiredNextStep:
          "Resolve the retained findings and rerun compatibility to reveal any remaining findings.",
      }),
    ]),
  });
}

async function readPackageCompatibilityPins(
  client: pg.PoolClient,
  manifest: PackageManifestContract,
) {
  const result = await client.query<RevisionFactRow>(
    `SELECT revision.revision_id, resource.resource_id, resource.namespace,
            resource.api_name, revision.family, revision.content_digest,
            revision.content, revision.state
     FROM meta.resource_revisions AS revision
     JOIN meta.resources AS resource ON resource.resource_id = revision.resource_id
     WHERE revision.revision_id = ANY($1::uuid[])`,
    [manifest.resourceEntries.map(({ revisionId }) => revisionId)],
  );
  const byRevision = new Map(result.rows.map((row) => [row.revision_id, row]));
  return manifest.resourceEntries.map((entry) => {
    const row = requireValue(
      byRevision.get(entry.revisionId),
      "Package Manifest references a missing Resource Revision.",
    );
    if (
      row.resource_id !== entry.resourceId ||
      row.namespace !== entry.namespace ||
      row.api_name !== entry.apiName ||
      row.family !== entry.family ||
      row.content_digest !== entry.contentDigest
    ) {
      throw new MetadataApplicationError(
        "STORAGE_FAILURE",
        "Stored Package expansion does not match its immutable Manifest.",
      );
    }
    return Object.freeze({
      namespace: row.namespace,
      apiName: row.api_name,
      resourceId: row.resource_id,
      revisionId: row.revision_id,
      family: row.family,
      contentDigest: parseArtifactDigest(row.content_digest),
      content: row.content,
    });
  });
}

async function preparedCandidateFromStoredRevision(
  client: pg.PoolClient,
  revision: PackageRevisionRow,
  inputBindings: unknown,
): Promise<PreparedPackageCandidate> {
  const manifest = parsePackageManifest(revision.manifest);
  const result = await client.query<{
    readonly revision_id: string;
    readonly resource_id: string;
    readonly content: unknown;
  }>(
    `SELECT revision_id, resource_id, content
     FROM meta.resource_revisions
     WHERE revision_id = ANY($1::uuid[])`,
    [manifest.resourceEntries.map(({ revisionId }) => revisionId)],
  );
  const byRevision = new Map(result.rows.map((row) => [row.revision_id, row]));
  return preparePackageCandidate({
    manifest,
    resources: manifest.resourceEntries.map((entry) => {
      const row = requireValue(
        byRevision.get(entry.revisionId),
        "Historical Package Resource Revision is unavailable.",
      );
      if (row.resource_id !== entry.resourceId) {
        throw new MetadataApplicationError(
          "STORAGE_FAILURE",
          "Historical Package Resource identity does not match its Manifest.",
        );
      }
      return { resourceId: entry.resourceId, revisionId: entry.revisionId, content: row.content };
    }),
    installInputBindings: inputBindings,
  });
}

async function persistPackageResources(
  client: pg.PoolClient,
  projectId: string,
  resources: readonly PreparedPackageResource[],
  principalId: string,
  uuid: () => string,
): Promise<void> {
  const ordered = [...resources].sort(
    (left, right) =>
      Number(left.family === "link_type") - Number(right.family === "link_type") ||
      compareText(left.resourceId, right.resourceId),
  );
  for (const resource of ordered) {
    const semantic = validateRevisionDefinition({
      revisionId: resource.revisionId,
      resourceId: resource.resourceId,
      family: resource.family,
      content: resource.content,
    });
    if (semantic.issues.length > 0) {
      throw new MetadataApplicationError(
        "INVALID_INPUT",
        `Package Resource ${resource.resourceId} failed active definition validation.`,
      );
    }
    const existingResource = await client.query<{
      readonly resource_id: string;
      readonly project_id: string;
      readonly namespace: string;
      readonly api_name: string;
      readonly family: ResourceFamily;
      readonly state: string;
    }>(
      `SELECT resource_id, project_id, namespace, api_name, family, state
       FROM meta.resources
       WHERE resource_id = $1
          OR (project_id = $2 AND namespace = $3 AND api_name = $4)
       FOR UPDATE`,
      [resource.resourceId, projectId, resource.namespace, resource.apiName],
    );
    if (existingResource.rows.length === 0) {
      await client.query(
        `INSERT INTO meta.resources
           (resource_id, project_id, namespace, api_name, family)
         VALUES ($1, $2, $3, $4, $5)`,
        [resource.resourceId, projectId, resource.namespace, resource.apiName, resource.family],
      );
    } else {
      const row = requireRow(existingResource.rows[0], "Existing Resource read returned no row.");
      if (
        existingResource.rows.length !== 1 ||
        row.resource_id !== resource.resourceId ||
        row.project_id !== projectId ||
        row.namespace !== resource.namespace ||
        row.api_name !== resource.apiName ||
        row.family !== resource.family ||
        row.state !== "active"
      ) {
        throw new MetadataApplicationError(
          "ALREADY_EXISTS",
          "Package Resource identity collides with another Project or Namespace entry.",
        );
      }
    }

    const existingRevision = await client.query<{
      readonly revision_id: string;
      readonly resource_id: string;
      readonly family: ResourceFamily;
      readonly content_digest: string;
      readonly content: unknown;
      readonly state: string;
    }>(
      `SELECT revision_id, resource_id, family, content_digest, content, state
       FROM meta.resource_revisions
       WHERE revision_id = $1 OR (resource_id = $2 AND content_digest = $3)
       FOR UPDATE`,
      [resource.revisionId, resource.resourceId, resource.contentDigest],
    );
    if (existingRevision.rows.length > 0) {
      const row = requireRow(existingRevision.rows[0], "Existing Revision read returned no row.");
      if (
        existingRevision.rows.length !== 1 ||
        row.revision_id !== resource.revisionId ||
        row.resource_id !== resource.resourceId ||
        row.family !== resource.family ||
        row.content_digest !== resource.contentDigest ||
        canonicalizeContractForDigest(row.content) !== resource.canonicalContent ||
        !reusableRevisionStates.has(row.state)
      ) {
        throw new MetadataApplicationError(
          "ALREADY_EXISTS",
          "Package Resource Revision identity or Digest was reused inconsistently.",
        );
      }
      continue;
    }

    const parent = await client.query<{
      readonly revision_id: string;
      readonly revision_number: string;
      readonly state: string;
    }>(
      `SELECT revision_id, revision_number::text, state
       FROM meta.resource_revisions
       WHERE resource_id = $1
       ORDER BY revision_number DESC, revision_id DESC
       LIMIT 1
       FOR UPDATE`,
      [resource.resourceId],
    );
    const parentRow = parent.rows[0];
    if (parentRow !== undefined && !reusableRevisionStates.has(parentRow.state)) {
      throw new MetadataApplicationError(
        "INVALID_STATE",
        "Package Resource has an unfinished Draft Revision.",
      );
    }
    const revisionNumber = parentRow === undefined ? 1n : BigInt(parentRow.revision_number) + 1n;
    await client.query(
      `INSERT INTO meta.resource_revisions
         (revision_id, resource_id, parent_revision_id, revision_number, family,
          content_digest, content, created_by_principal_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        resource.revisionId,
        resource.resourceId,
        parentRow?.revision_id ?? null,
        revisionNumber.toString(),
        resource.family,
        resource.contentDigest,
        resource.canonicalContent,
        principalId,
      ],
    );
    for (const dependency of resource.dependencies) {
      await client.query(
        `INSERT INTO meta.resource_dependencies
           (dependency_id, source_revision_id, target_revision_id,
            dependency_type, source_path)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          uuid(),
          dependency.sourceRevisionId,
          dependency.targetRevisionId,
          dependency.dependencyType,
          dependency.sourcePath,
        ],
      );
    }
    const validationContextDigest = digestCanonical({
      schemaVersion: 1,
      validatorVersion: METADATA_VALIDATOR_VERSION,
      packageValidatorVersion: METADATA_PACKAGE_VALIDATOR_VERSION,
      revisionId: resource.revisionId,
      contentDigest: resource.contentDigest,
      dependencies: resource.dependencies,
    });
    await client.query(
      `INSERT INTO meta.validation_reports
         (report_id, subject_type, subject_id, resource_revision_id,
          subject_digest, validation_context_digest, validator_version, valid, issues)
       VALUES ($1, 'resource_revision', $2, $2, $3, $4, $5, TRUE, '[]'::jsonb)`,
      [
        uuid(),
        resource.revisionId,
        resource.contentDigest,
        validationContextDigest,
        METADATA_VALIDATOR_VERSION,
      ],
    );
    await client.query(
      `UPDATE meta.resource_revisions
       SET state = 'validated', changed_at = clock_timestamp()
       WHERE revision_id = $1`,
      [resource.revisionId],
    );
  }
}

async function createPackageReleaseDraft(
  client: pg.PoolClient,
  input: {
    readonly projectId: string;
    readonly targetChannelName: string;
    readonly previousPackageManifest: PackageManifestContract | null;
    readonly targetManifest: PackageManifestContract;
    readonly createdByPrincipalId: string;
    readonly uuid: () => string;
  },
): Promise<string> {
  const channel = await client.query<{ readonly release_id: string }>(
    `SELECT release_id
     FROM meta.release_channels
     WHERE project_id = $1 AND channel_name = $2
     FOR UPDATE`,
    [input.projectId, input.targetChannelName],
  );
  const baselinePins =
    channel.rows[0] === undefined
      ? []
      : await client.query<{
          readonly resource_id: string;
          readonly revision_id: string;
          readonly family: ResourceFamily;
          readonly content_digest: string;
        }>(
          `SELECT resource_id, revision_id, family, content_digest
           FROM meta.release_pins
           WHERE release_id = $1
           ORDER BY pin_order`,
          [channel.rows[0].release_id],
        );
  const pins = new Map<string, ReleasePinFact>();
  for (const pin of Array.isArray(baselinePins) ? [] : baselinePins.rows) {
    pins.set(
      pin.resource_id,
      Object.freeze({
        resourceId: pin.resource_id,
        revisionId: pin.revision_id,
        family: pin.family,
        contentDigest: parseArtifactDigest(pin.content_digest),
      }),
    );
  }
  for (const entry of input.previousPackageManifest?.resourceEntries ?? []) {
    pins.delete(entry.resourceId);
  }
  for (const entry of input.targetManifest.resourceEntries) {
    pins.set(
      entry.resourceId,
      Object.freeze({
        resourceId: entry.resourceId,
        revisionId: entry.revisionId,
        family: entry.family,
        contentDigest: entry.contentDigest,
      }),
    );
  }
  const orderedPins = [...pins.values()].sort(
    (left, right) =>
      compareText(left.resourceId, right.resourceId) ||
      compareText(left.revisionId, right.revisionId),
  );
  if (orderedPins.length < 1 || orderedPins.length > 512) {
    throw new MetadataApplicationError(
      "INVALID_STATE",
      "Package expansion produced an invalid Release Pin count.",
    );
  }
  const facts = await client.query<{
    readonly revision_id: string;
    readonly resource_id: string;
    readonly state: string;
  }>(
    `SELECT revision.revision_id, revision.resource_id, revision.state
     FROM meta.resource_revisions AS revision
     JOIN meta.resources AS resource ON resource.resource_id = revision.resource_id
     WHERE revision.revision_id = ANY($1::uuid[])
       AND resource.project_id = $2
       AND resource.state <> 'archived'
     FOR KEY SHARE OF revision, resource`,
    [orderedPins.map(({ revisionId }) => revisionId), input.projectId],
  );
  if (
    facts.rows.length !== orderedPins.length ||
    facts.rows.some((row) => !reusableRevisionStates.has(row.state))
  ) {
    throw new MetadataApplicationError(
      "INVALID_STATE",
      "Package Release contains an unavailable Resource Revision.",
    );
  }
  const numberResult = await client.query<{ readonly release_number: string }>(
    `SELECT (COALESCE(MAX(release_number), 0) + 1)::text AS release_number
     FROM meta.releases
     WHERE project_id = $1`,
    [input.projectId],
  );
  const releaseNumber = BigInt(
    requireRow(numberResult.rows[0], "Release number allocation returned no row.").release_number,
  );
  if (releaseNumber > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MetadataApplicationError("INVALID_STATE", "Release number space is exhausted.");
  }
  const timeResult = await client.query<{ readonly created_at: string }>(
    `SELECT to_char(
       clock_timestamp() AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
     ) AS created_at`,
  );
  const createdAt = requireRow(
    timeResult.rows[0],
    "Release timestamp allocation failed.",
  ).created_at;
  const releaseId = input.uuid();
  const manifestWithoutDigest = {
    schemaVersion: 1,
    releaseId,
    projectId: input.projectId,
    releaseNumber: Number(releaseNumber),
    pins: orderedPins.map((pin, order) => ({ order, ...pin })),
    createdAt,
  };
  const manifestDigest = digestCanonical(manifestWithoutDigest);
  await client.query(
    `INSERT INTO meta.releases
       (release_id, project_id, release_number, manifest_digest,
        target_channel_name, created_by_principal_id, created_at, changed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz)`,
    [
      releaseId,
      input.projectId,
      releaseNumber.toString(),
      manifestDigest,
      input.targetChannelName,
      input.createdByPrincipalId,
      createdAt,
    ],
  );
  await client.query(
    `INSERT INTO meta.release_pins
       (release_id, resource_id, revision_id, pin_order, family, content_digest)
     SELECT $1, input.resource_id, input.revision_id, input.pin_order,
            input.family, input.content_digest
     FROM unnest(
       $2::uuid[], $3::uuid[], $4::integer[], $5::text[], $6::text[]
     ) AS input(resource_id, revision_id, pin_order, family, content_digest)`,
    [
      releaseId,
      orderedPins.map(({ resourceId }) => resourceId),
      orderedPins.map(({ revisionId }) => revisionId),
      orderedPins.map((_, order) => order),
      orderedPins.map(({ family }) => family),
      orderedPins.map(({ contentDigest }) => contentDigest),
    ],
  );
  return releaseId;
}

async function readChangeRecord(
  client: pg.PoolClient,
  changeId: string,
  idempotent: boolean,
): Promise<PackageChangeRecord> {
  const result = await client.query<ChangeRow>(
    `SELECT change.operation, change.project_id, change.package_id,
            change.target_package_revision_id, change.installation_id, change.change_id,
            change.target_release_id, release.target_channel_name, change.request_key,
            change.request_digest, change.input_bindings, change.input_bindings_digest,
            change.state, revision.manifest, change.compatibility_report
     FROM meta.package_installation_changes AS change
     JOIN meta.package_revisions AS revision
       ON revision.package_revision_id = change.target_package_revision_id
      AND revision.package_id = change.package_id
     JOIN meta.releases AS release ON release.release_id = change.target_release_id
     WHERE change.change_id = $1`,
    [changeId],
  );
  const row = requireRow(result.rows[0], "Package Change does not exist.", "NOT_FOUND");
  const bindings = parseStoredBindings(row.input_bindings);
  return Object.freeze({
    operation: row.operation,
    projectId: row.project_id,
    packageId: row.package_id,
    packageRevisionId: row.target_package_revision_id,
    installationId: row.installation_id,
    changeId: row.change_id,
    releaseId: row.target_release_id,
    targetChannelName: row.target_channel_name,
    requestKey: row.request_key,
    requestDigest: parseArtifactDigest(row.request_digest),
    inputBindings: bindings,
    inputBindingsDigest: parseArtifactDigest(row.input_bindings_digest),
    state: row.state,
    manifest: parsePackageManifest(row.manifest),
    compatibility: parseCompatibilityReport(row.compatibility_report),
    idempotent,
  });
}

function parseStoredBindings(value: unknown): readonly PackageInstallInputBinding[] {
  if (!Array.isArray(value)) {
    throw new MetadataApplicationError("STORAGE_FAILURE", "Package input bindings are corrupted.");
  }
  return Object.freeze(
    value.map((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item) ||
        typeof (item as Record<string, unknown>)["apiName"] !== "string" ||
        typeof (item as Record<string, unknown>)["value"] !== "string"
      ) {
        throw new MetadataApplicationError(
          "STORAGE_FAILURE",
          "Package input binding entry is corrupted.",
        );
      }
      return Object.freeze({
        apiName: (item as Record<string, string>)["apiName"] ?? "",
        value: (item as Record<string, string>)["value"] ?? "",
      });
    }),
  );
}

function acceptedResult(change: PackageChangeRecord): PackageChangeResult {
  return Object.freeze({ accepted: true, compatibility: change.compatibility, change });
}

export function sha256CanonicalText(canonicalText: string): ArtifactDigest {
  return parseArtifactDigest(
    `sha256:${createHash("sha256").update(canonicalText, "utf8").digest("hex")}`,
  );
}

function digestCanonical(value: unknown): ArtifactDigest {
  return sha256CanonicalText(canonicalizeContractForDigest(value));
}

function requireRow<T>(
  row: T | undefined,
  message: string,
  code: "INVALID_STATE" | "NOT_FOUND" = "INVALID_STATE",
): T {
  if (row === undefined) throw new MetadataApplicationError(code, message);
  return row;
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new MetadataApplicationError("STORAGE_FAILURE", message);
  }
  return value;
}

function mapStorageError(error: unknown): MetadataApplicationError {
  if (error instanceof MetadataApplicationError) return error;
  if (error instanceof PackageDomainError) {
    return new MetadataApplicationError("INVALID_INPUT", `${error.code}: ${error.message}`, {
      cause: error,
    });
  }
  const code = postgresCode(error);
  if (code === "23505") {
    return new MetadataApplicationError(
      "ALREADY_EXISTS",
      "Immutable Package fact already exists.",
      {
        cause: error,
      },
    );
  }
  if (code === "40001" || code === "40P01") {
    return new MetadataApplicationError(
      "CONCURRENT_MODIFICATION",
      "Package control state changed concurrently.",
      { cause: error },
    );
  }
  if (code === "42501") {
    return new MetadataApplicationError("FORBIDDEN", "Package storage permission was denied.", {
      cause: error,
    });
  }
  if (code === "55000" || code === "23514" || code === "23503") {
    return new MetadataApplicationError(
      "INVALID_STATE",
      "Package storage invariant rejected the change.",
      {
        cause: error,
      },
    );
  }
  return new MetadataApplicationError("STORAGE_FAILURE", "Package storage operation failed.", {
    cause: error instanceof Error ? error : undefined,
  });
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
