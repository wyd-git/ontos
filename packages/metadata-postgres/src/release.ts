import { createHash, randomUUID } from "node:crypto";

import {
  canonicalizeContractForDigest,
  canonicalizeManifestForDigest,
  parseArtifactDigest,
  parseCompatibilityReport,
  parseMappingDefinition,
  parseOntosId,
  parseReleaseBinding,
  parseReleaseManifest,
  parseValidationReport,
  type ArtifactDigest,
  type CompatibilityFindingContract,
  type CompatibilityReportContract,
  type ReleaseManifestContract,
  type ResourceFamily,
  type RuntimeMemberPlanContract,
  type ValidationReportContract,
} from "@ontos/contracts";
import {
  RuntimePlanError,
  compileRuntimeMemberPlan,
  type RuntimePlanIndexReference,
  type RuntimePlanPinnedResource,
  type RuntimePlanSnapshotGroupDefinition,
} from "@ontos/materialization-domain";
import {
  MetadataApplicationError,
  type PublishedReleaseBinding,
  type ReleaseLifecycleRepository,
  type ReleaseRecord,
  type ReleaseStageResult,
  type ReleaseValidationResult,
} from "@ontos/metadata-application";
import {
  METADATA_COMPATIBILITY_VERSION,
  METADATA_RELEASE_VALIDATOR_VERSION,
  METADATA_VALIDATOR_VERSION,
  POLICY_VALIDATOR_VERSION,
  buildCompatibilityReport,
  evaluateReleaseGate,
  type CompatibilityEvaluation,
  type PinnedCompatibilityDependency,
  type ReleaseBaselinePin,
  type ReleaseGatePin,
  type ReleaseLifecycleState,
  type ResourceRevisionState,
  type ResourceState,
} from "@ontos/metadata-domain";
import type pg from "pg";

export type ReleasePublishFaultPoint =
  | "after_activation"
  | "after_serving_head"
  | "after_revisions"
  | "after_release"
  | "after_channel"
  | "after_installations"
  | "after_project"
  | "after_epoch";

export interface PostgresReleaseStoreOptions {
  readonly uuidFactory?: () => string;
  readonly faultInjector?: (point: ReleasePublishFaultPoint) => void;
}

interface ReleaseRow {
  readonly release_id: string;
  readonly project_id: string;
  readonly rollback_of_release_id: string | null;
  readonly release_number: string;
  readonly manifest_digest: string;
  readonly state: ReleaseLifecycleState;
  readonly target_channel_name: string;
  readonly staged_from_release_id: string | null;
  readonly staged_from_activation_id: string | null;
  readonly staged_channel_control_sequence: string | null;
  readonly staged_validation_context_digest: string | null;
  readonly created_by_principal_id: string;
  readonly published_by_principal_id: string | null;
  readonly created_at: string;
  readonly staged_at: string | null;
  readonly published_at: string | null;
}

interface PinRow {
  readonly pin_order: number;
  readonly resource_id: string;
  readonly revision_id: string;
  readonly stored_family: ResourceFamily;
  readonly stored_content_digest: string;
  readonly project_id: string;
  readonly api_name: string;
  readonly resource_state: ResourceState;
  readonly revision_family: ResourceFamily;
  readonly revision_state: ResourceRevisionState;
  readonly revision_content_digest: string;
  readonly content: unknown;
  readonly has_current_validation_report: boolean;
  readonly policy_compilation_id: string | null;
  readonly policy_content_digest: string | null;
  readonly policy_compiler_version: string | null;
  readonly policy_artifact_digest: string | null;
  readonly policy_test_report_digest: string | null;
  readonly policy_test_vector_count: number | null;
  readonly policy_passed_vector_count: number | null;
  readonly policy_failed_vector_count: number | null;
  readonly policy_compilation_status: "passed" | "failed" | null;
}

interface DependencyRow {
  readonly source_revision_id: string;
  readonly target_revision_id: string;
  readonly dependency_type: string;
  readonly source_path: string;
}

interface ChannelRow {
  readonly release_id: string;
  readonly activation_id: string;
  readonly control_sequence: string;
}

interface ControlRow {
  readonly project_state: ResourceState;
  readonly publication_sequence: string;
  readonly authorization_epoch: string;
}

interface ReportRow {
  readonly report_id: string;
  readonly subject_id: string;
  readonly subject_digest: string;
  readonly validation_context_digest: string;
  readonly validator_version: string;
  readonly valid: boolean;
  readonly issues: unknown;
}

interface PackagePublicationRow {
  readonly change_id: string;
  readonly installation_id: string;
  readonly package_id: string;
  readonly target_package_revision_id: string;
  readonly target_release_id: string;
  readonly change_state: "pending" | "active" | "superseded" | "failed";
  readonly operation: "install" | "upgrade" | "rollback";
  readonly previous_package_revision_id: string | null;
  readonly previous_release_id: string | null;
  readonly request_digest: string;
  readonly input_bindings_digest: string;
  readonly compatibility_report: unknown;
  readonly installation_project_id: string;
  readonly installation_package_id: string;
  readonly active_package_revision_id: string | null;
  readonly active_release_id: string | null;
  readonly installation_control_sequence: string;
  readonly target_manifest_digest: string;
}

const zeroDigest = `sha256:${"0".repeat(64)}` as const;
const reusableRevisionStates = new Set<ResourceRevisionState>([
  "validated",
  "published",
  "deprecated",
]);

export class PostgresReleaseStore implements ReleaseLifecycleRepository {
  readonly #pool: pg.Pool;
  readonly #uuid: () => string;
  readonly #faultInjector: (point: ReleasePublishFaultPoint) => void;

  constructor(pool: pg.Pool, options: PostgresReleaseStoreOptions = {}) {
    this.#pool = pool;
    this.#uuid = options.uuidFactory ?? randomUUID;
    this.#faultInjector = options.faultInjector ?? (() => undefined);
  }

  async readReleaseScope(releaseId: string): Promise<{ readonly projectId: string }> {
    try {
      const result = await this.#pool.query<{ readonly project_id: string }>(
        `SELECT project_id FROM meta.releases WHERE release_id = $1`,
        [releaseId],
      );
      return Object.freeze({
        projectId: requireRow(result.rows[0], "Release does not exist.", "NOT_FOUND").project_id,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async getRelease(releaseId: string): Promise<ReleaseRecord> {
    return this.#transaction(async (client) => {
      const result = await client.query<ReleaseRow>(releaseSelect(false), [releaseId]);
      const release = requireRow(result.rows[0], "Release does not exist.", "NOT_FOUND");
      const record = releaseRecord(release, await readPins(client, releaseId));
      if (record.manifest.manifestDigest !== record.manifestDigest) {
        throw new MetadataApplicationError(
          "STORAGE_FAILURE",
          "Release Manifest differs from its immutable Digest.",
        );
      }
      return record;
    });
  }

  async createReleaseDraft(input: {
    readonly projectId: string;
    readonly targetChannelName: string;
    readonly revisionIds: readonly string[];
    readonly createdByPrincipalId: string;
  }): Promise<ReleaseRecord> {
    return this.#createDraft({ ...input, rollbackOfReleaseId: null });
  }

  async createRollbackDraft(input: {
    readonly sourceReleaseId: string;
    readonly createdByPrincipalId: string;
  }): Promise<ReleaseRecord> {
    let source: ReleaseRow;
    let revisionIds: readonly string[];
    try {
      const sourceResult = await this.#pool.query<ReleaseRow>(releaseSelect(false), [
        input.sourceReleaseId,
      ]);
      source = requireRow(
        sourceResult.rows[0],
        "Rollback source Release does not exist.",
        "NOT_FOUND",
      );
      if (source.state !== "published" && source.state !== "superseded") {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "Only a Published or Superseded Release can be used as a rollback source.",
        );
      }
      const pinsResult = await this.#pool.query<{ readonly revision_id: string }>(
        `SELECT revision_id
         FROM meta.release_pins
         WHERE release_id = $1
         ORDER BY pin_order`,
        [input.sourceReleaseId],
      );
      revisionIds = Object.freeze(pinsResult.rows.map(({ revision_id }) => revision_id));
    } catch (error) {
      throw mapStorageError(error);
    }
    return this.#createDraft({
      projectId: source.project_id,
      targetChannelName: source.target_channel_name,
      revisionIds,
      createdByPrincipalId: input.createdByPrincipalId,
      rollbackOfReleaseId: source.release_id,
    });
  }

  async validateReleaseDraft(input: {
    readonly releaseId: string;
    readonly validatorVersion: string;
  }): Promise<ReleaseValidationResult> {
    assertReleaseValidatorVersion(input.validatorVersion);
    return this.#transaction(async (client) => {
      const evaluated = await lockAndEvaluateRelease(
        client,
        input.releaseId,
        input.validatorVersion,
      );
      return persistEvaluation(client, evaluated);
    });
  }

  async stageRelease(input: {
    readonly releaseId: string;
    readonly validatorVersion: string;
  }): Promise<ReleaseStageResult> {
    assertReleaseValidatorVersion(input.validatorVersion);
    return this.#transaction(async (client) => {
      const evaluated = await lockAndEvaluateRelease(
        client,
        input.releaseId,
        input.validatorVersion,
      );
      const validation = await persistEvaluation(client, evaluated);
      if (evaluated.release.state === "ready") {
        if (
          evaluated.release.staged_validation_context_digest !== evaluated.contextDigest ||
          !validation.report.valid
        ) {
          throw new MetadataApplicationError(
            "CONCURRENT_MODIFICATION",
            "The Ready Release no longer matches its sealed Stage context.",
          );
        }
        const runtimePlan = await deriveAndPersistRuntimePlan(
          client,
          evaluated.release,
          evaluated.pins,
        );
        if (
          runtimePlan.members.length > 0 &&
          !(await releaseRuntimeMembersReady(client, evaluated.release.release_id))
        ) {
          throw new MetadataApplicationError(
            "CONCURRENT_MODIFICATION",
            "The Ready Release no longer has a complete current Runtime compatibility set.",
          );
        }
        return Object.freeze({ ...validation, staged: true });
      }
      if (evaluated.release.state !== "draft" && evaluated.release.state !== "staging") {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "Only a Draft or Staging Release can enter Stage.",
        );
      }
      if (!validation.report.valid) {
        if (evaluated.release.state === "staging") {
          throw new MetadataApplicationError(
            "CONCURRENT_MODIFICATION",
            "The Staging Release no longer passes its sealed validation gate.",
          );
        }
        return Object.freeze({ ...validation, staged: false });
      }

      if (evaluated.release.state === "draft") {
        await client.query(
          `UPDATE meta.releases
           SET state = 'staging',
               staged_from_release_id = $2,
               staged_from_activation_id = $3,
               staged_channel_control_sequence = $4,
               staged_validation_context_digest = $5,
               staged_at = clock_timestamp(),
               changed_at = clock_timestamp()
           WHERE release_id = $1`,
          [
            evaluated.release.release_id,
            evaluated.channel?.release_id ?? null,
            evaluated.channel?.activation_id ?? null,
            evaluated.channel?.control_sequence ?? "0",
            evaluated.contextDigest,
          ],
        );
      } else if (evaluated.release.staged_validation_context_digest !== evaluated.contextDigest) {
        throw new MetadataApplicationError(
          "CONCURRENT_MODIFICATION",
          "The Staging Release no longer matches its sealed Stage context.",
        );
      }

      const runtimePlan = await deriveAndPersistRuntimePlan(
        client,
        evaluated.release,
        evaluated.pins,
      );
      const runtimeReady =
        runtimePlan.members.length === 0 ||
        (await releaseRuntimeMembersReady(client, evaluated.release.release_id));
      const stateResult = runtimeReady
        ? await client.query<ReleaseRow>(
            `${releaseUpdateToReady()} RETURNING ${releaseColumns()}`,
            [evaluated.release.release_id],
          )
        : await client.query<ReleaseRow>(releaseSelect(false), [evaluated.release.release_id]);
      const stateRow = requireRow(
        stateResult.rows[0],
        runtimeReady
          ? "Ready Release update returned no row."
          : "Staging Release reread returned no row.",
      );
      const release = releaseRecord(stateRow, evaluated.pins);
      return Object.freeze({ ...validation, release, staged: true });
    });
  }

  async publishRelease(input: {
    readonly releaseId: string;
    readonly expectedChannelControlSequence: bigint;
    readonly publishedByPrincipalId: string;
  }): Promise<PublishedReleaseBinding> {
    const identity = await this.#readImmutableIdentity(input.releaseId);
    return this.#transaction(async (client) => {
      const control = await lockProjectControl(client, identity.projectId);
      await lockChannelDomain(client, identity.projectId, identity.targetChannelName);
      const channel = await readChannel(
        client,
        identity.projectId,
        identity.targetChannelName,
        true,
      );
      const releaseResult = await client.query<ReleaseRow>(releaseSelect(true), [input.releaseId]);
      const release = requireRow(releaseResult.rows[0], "Release does not exist.", "NOT_FOUND");
      if (
        release.project_id !== identity.projectId ||
        release.target_channel_name !== identity.targetChannelName
      ) {
        throw new MetadataApplicationError(
          "STORAGE_FAILURE",
          "Release identity changed while locking.",
        );
      }

      await assertPublisherOwner(client, release.project_id, input.publishedByPrincipalId);
      if (release.state === "published") {
        await assertPackagePublicationApplied(client, release.release_id);
        return readPublishedBinding(client, release, control);
      }
      if (release.state !== "ready") {
        throw new MetadataApplicationError("INVALID_STATE", "Release is not Ready.");
      }
      const stagedSequence = BigInt(
        requireValue(
          release.staged_channel_control_sequence,
          "Ready Release has no staged Channel sequence.",
        ),
      );
      if (
        input.expectedChannelControlSequence !== stagedSequence ||
        BigInt(channel?.control_sequence ?? "0") !== stagedSequence ||
        (channel?.release_id ?? null) !== release.staged_from_release_id ||
        (channel?.activation_id ?? null) !== release.staged_from_activation_id
      ) {
        throw new MetadataApplicationError(
          "CONCURRENT_MODIFICATION",
          "The Release Channel changed after Stage.",
        );
      }

      const pins = await readPins(client, release.release_id, true);
      const packagePublication = await readPackagePublication(client, release.release_id, true);
      assertPendingPackagePublication(packagePublication, release.project_id);
      const manifest = manifestFromFacts(release, pins);
      if (manifest.manifestDigest !== release.manifest_digest) {
        throw new MetadataApplicationError(
          "STORAGE_FAILURE",
          "The sealed Release Manifest no longer matches its stored Digest.",
        );
      }
      if (
        pins.length === 0 ||
        pins.some(
          (pin) =>
            pin.project_id !== release.project_id ||
            pin.resource_state === "archived" ||
            !reusableRevisionStates.has(pin.revision_state) ||
            pin.stored_family !== pin.revision_family ||
            pin.stored_content_digest !== pin.revision_content_digest ||
            !pin.has_current_validation_report,
        )
      ) {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "The sealed Release Pin set is no longer publishable.",
        );
      }
      const stagedContext = requireValue(
        release.staged_validation_context_digest,
        "Ready Release has no staged validation context.",
      );
      const currentEvaluation = await evaluateReleaseFacts(
        client,
        release,
        pins,
        channel,
        METADATA_RELEASE_VALIDATOR_VERSION,
        control.publication_sequence,
        packagePublication,
      );
      if (currentEvaluation.contextDigest !== stagedContext || !currentEvaluation.report.valid) {
        throw new MetadataApplicationError(
          "CONCURRENT_MODIFICATION",
          "The Release facts changed after Stage.",
        );
      }
      const validReport = await client.query<{ readonly present: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM meta.validation_reports
           WHERE subject_type = 'release'
             AND release_id = $1
             AND subject_digest = $2
             AND validation_context_digest = $3
             AND validator_version = $4
             AND valid = TRUE
         ) AS present`,
        [
          release.release_id,
          release.manifest_digest,
          stagedContext,
          METADATA_RELEASE_VALIDATOR_VERSION,
        ],
      );
      if (validReport.rows[0]?.present !== true) {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "The staged Release Validation Report is unavailable.",
        );
      }

      const runtimePlan = await client.query<{ readonly plan_digest: string }>(
        `SELECT plan_digest FROM meta.release_runtime_plans WHERE release_id = $1`,
        [release.release_id],
      );
      let activationId: string;
      if (runtimePlan.rows.length === 0) {
        activationId = this.#uuid();
        const activationDigest = digestCanonical({
          schemaVersion: 1,
          releaseId: release.release_id,
          manifestDigest: release.manifest_digest,
          memberCount: 0,
        });
        await client.query(
          `INSERT INTO meta.runtime_activations
             (activation_id, release_id, activation_digest, member_count, state)
           VALUES ($1, $2, $3, 0, 'ready')`,
          [activationId, release.release_id, activationDigest],
        );
      } else {
        const candidate = await client.query<{ readonly activation_id: string }>(
          `SELECT activation.activation_id
           FROM meta.runtime_activations AS activation
           WHERE activation.release_id = $1 AND activation.state = 'ready'
           ORDER BY activation.created_at DESC, activation.activation_id
           LIMIT 1`,
          [release.release_id],
        );
        const row = candidate.rows[0];
        if (row === undefined) {
          throw new MetadataApplicationError(
            "INVALID_STATE",
            "The data-bearing Release has no complete Ready Runtime Activation.",
          );
        }
        activationId = row.activation_id;
      }
      this.#faultInjector("after_activation");

      await client.query(
        `INSERT INTO meta.release_serving_heads
           (release_id, activation_id, control_sequence)
         VALUES ($1, $2, 1)`,
        [release.release_id, activationId],
      );
      this.#faultInjector("after_serving_head");

      await client.query(
        `UPDATE meta.resource_revisions
         SET state = 'published', changed_at = clock_timestamp()
         WHERE revision_id = ANY($1::uuid[]) AND state = 'validated'`,
        [pins.map(({ revision_id }) => revision_id)],
      );
      this.#faultInjector("after_revisions");

      await client.query(
        `UPDATE meta.releases
         SET state = 'published',
             published_by_principal_id = $2,
             published_at = clock_timestamp(),
             changed_at = clock_timestamp()
         WHERE release_id = $1`,
        [release.release_id, input.publishedByPrincipalId],
      );
      if (channel !== null && channel.release_id !== release.release_id) {
        await client.query(
          `UPDATE meta.releases
           SET state = 'superseded', changed_at = clock_timestamp()
           WHERE release_id = $1 AND state = 'published'`,
          [channel.release_id],
        );
      }
      this.#faultInjector("after_release");

      const nextChannelSequence = stagedSequence + 1n;
      if (channel === null) {
        await client.query(
          `INSERT INTO meta.release_channels
             (project_id, channel_name, release_id, activation_id, control_sequence)
           VALUES ($1, $2, $3, $4, 1)`,
          [release.project_id, release.target_channel_name, release.release_id, activationId],
        );
      } else {
        const result = await client.query(
          `UPDATE meta.release_channels
           SET release_id = $3,
               activation_id = $4,
               control_sequence = control_sequence + 1,
               changed_at = clock_timestamp()
           WHERE project_id = $1
             AND channel_name = $2
             AND control_sequence = $5`,
          [
            release.project_id,
            release.target_channel_name,
            release.release_id,
            activationId,
            stagedSequence.toString(),
          ],
        );
        if (result.rowCount !== 1) {
          throw new MetadataApplicationError(
            "CONCURRENT_MODIFICATION",
            "The Release Channel compare-and-swap failed.",
          );
        }
      }
      this.#faultInjector("after_channel");

      if (packagePublication !== null) {
        const installationResult = await client.query(
          `UPDATE meta.package_installations
           SET active_package_revision_id = $2,
               active_release_id = $3,
               control_sequence = control_sequence + 1,
               changed_at = clock_timestamp()
           WHERE installation_id = $1
             AND control_sequence = $4
             AND active_package_revision_id IS NOT DISTINCT FROM $5::uuid
             AND active_release_id IS NOT DISTINCT FROM $6::uuid`,
          [
            packagePublication.installation_id,
            packagePublication.target_package_revision_id,
            release.release_id,
            packagePublication.installation_control_sequence,
            packagePublication.previous_package_revision_id,
            packagePublication.previous_release_id,
          ],
        );
        if (installationResult.rowCount !== 1) {
          throw new MetadataApplicationError(
            "CONCURRENT_MODIFICATION",
            "The Package Installation pointer changed after Stage.",
          );
        }
        if (packagePublication.previous_package_revision_id !== null) {
          const previousChangeResult = await client.query(
            `UPDATE meta.package_installation_changes
             SET state = 'superseded', changed_at = clock_timestamp()
             WHERE installation_id = $1
               AND target_package_revision_id = $2
               AND target_release_id = $3
               AND state = 'active'`,
            [
              packagePublication.installation_id,
              packagePublication.previous_package_revision_id,
              packagePublication.previous_release_id,
            ],
          );
          if (previousChangeResult.rowCount !== 1) {
            throw new MetadataApplicationError(
              "CONCURRENT_MODIFICATION",
              "The previous active Package Change no longer matches the Installation pointer.",
            );
          }
        }
        const changeResult = await client.query(
          `UPDATE meta.package_installation_changes
           SET state = 'active', changed_at = clock_timestamp()
           WHERE change_id = $1 AND state = 'pending'`,
          [packagePublication.change_id],
        );
        if (changeResult.rowCount !== 1) {
          throw new MetadataApplicationError(
            "CONCURRENT_MODIFICATION",
            "The Package Change is no longer Pending.",
          );
        }
      }
      this.#faultInjector("after_installations");

      const projectResult = await client.query<{ readonly publication_sequence: string }>(
        `UPDATE meta.projects
         SET publication_sequence = publication_sequence + 1,
             changed_at = clock_timestamp()
         WHERE project_id = $1
         RETURNING publication_sequence::text`,
        [release.project_id],
      );
      const projectPublicationSequence = BigInt(
        requireRow(projectResult.rows[0], "Project publication sequence update returned no row.")
          .publication_sequence,
      );
      this.#faultInjector("after_project");

      const epochResult = await client.query<{ readonly epoch: string }>(
        `SELECT authz.advance_authorization_epoch($1, NULL)::text AS epoch`,
        [release.project_id],
      );
      const authorizationEpoch = BigInt(
        requireRow(epochResult.rows[0], "Authorization Epoch advance returned no row.").epoch,
      );
      this.#faultInjector("after_epoch");

      return publishedBinding({
        release,
        activationId,
        channelControlSequence: nextChannelSequence,
        projectPublicationSequence,
        authorizationEpoch,
      });
    });
  }

  async #createDraft(input: {
    readonly projectId: string;
    readonly targetChannelName: string;
    readonly revisionIds: readonly string[];
    readonly createdByPrincipalId: string;
    readonly rollbackOfReleaseId: string | null;
  }): Promise<ReleaseRecord> {
    if (input.revisionIds.length < 1 || input.revisionIds.length > 512) {
      throw new MetadataApplicationError(
        "INVALID_INPUT",
        "A Release must contain between 1 and 512 Revision Pins.",
      );
    }
    return this.#transaction(async (client) => {
      await lockProjectControl(client, input.projectId);
      const factsResult = await client.query<{
        readonly resource_id: string;
        readonly revision_id: string;
        readonly family: ResourceFamily;
        readonly content_digest: string;
        readonly project_id: string;
        readonly api_name: string;
        readonly state: ResourceRevisionState;
      }>(
        `SELECT revision.resource_id, revision.revision_id, revision.family,
                revision.content_digest, resource.project_id, resource.api_name, revision.state
         FROM meta.resource_revisions AS revision
         JOIN meta.resources AS resource ON resource.resource_id = revision.resource_id
         WHERE revision.revision_id = ANY($1::uuid[])
         ORDER BY revision.resource_id, revision.revision_id
         FOR KEY SHARE OF revision, resource`,
        [input.revisionIds],
      );
      if (factsResult.rows.length !== input.revisionIds.length) {
        throw new MetadataApplicationError(
          "NOT_FOUND",
          "A selected Resource Revision does not exist.",
        );
      }
      if (
        factsResult.rows.some(
          (row) => row.project_id !== input.projectId || !reusableRevisionStates.has(row.state),
        )
      ) {
        throw new MetadataApplicationError(
          "INVALID_STATE",
          "Every Release Pin must be a reusable validated Revision in the same Project.",
        );
      }
      if (
        new Set(factsResult.rows.map(({ resource_id }) => resource_id)).size !==
        factsResult.rows.length
      ) {
        throw new MetadataApplicationError(
          "INVALID_INPUT",
          "A Release can Pin only one Revision for each Resource.",
        );
      }
      if (input.rollbackOfReleaseId !== null) {
        const sourceResult = await client.query<{ readonly project_id: string }>(
          `SELECT project_id
           FROM meta.releases
           WHERE release_id = $1 AND state IN ('published', 'superseded')
           FOR KEY SHARE`,
          [input.rollbackOfReleaseId],
        );
        if (sourceResult.rows[0]?.project_id !== input.projectId) {
          throw new MetadataApplicationError(
            "INVALID_STATE",
            "Rollback source is not a historical Release in this Project.",
          );
        }
      }

      const numberResult = await client.query<{ readonly release_number: string }>(
        `SELECT (COALESCE(MAX(release_number), 0) + 1)::text AS release_number
         FROM meta.releases
         WHERE project_id = $1`,
        [input.projectId],
      );
      const releaseNumber = BigInt(
        requireRow(numberResult.rows[0], "Release number allocation returned no row.")
          .release_number,
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
      const releaseId = this.#uuid();
      const manifest = createManifest({
        releaseId,
        projectId: input.projectId,
        releaseNumber: Number(releaseNumber),
        createdAt,
        pins: factsResult.rows.map((row, order) => ({
          order,
          resourceId: row.resource_id,
          revisionId: row.revision_id,
          family: row.family,
          contentDigest: row.content_digest,
        })),
      });
      const releaseResult = await client.query<ReleaseRow>(
        `INSERT INTO meta.releases
           (release_id, project_id, rollback_of_release_id, release_number,
            manifest_digest, target_channel_name, created_by_principal_id, created_at, changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz)
         RETURNING ${releaseColumns()}`,
        [
          releaseId,
          input.projectId,
          input.rollbackOfReleaseId,
          releaseNumber.toString(),
          manifest.manifestDigest,
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
          manifest.pins.map(({ resourceId }) => resourceId),
          manifest.pins.map(({ revisionId }) => revisionId),
          manifest.pins.map(({ order }) => order),
          manifest.pins.map(({ family }) => family),
          manifest.pins.map(({ contentDigest }) => contentDigest),
        ],
      );
      return releaseRecord(
        requireRow(releaseResult.rows[0], "Release insert returned no row."),
        factsResult.rows.map((row, index) => pinRowFromCreation(row, index)),
      );
    });
  }

  async #readImmutableIdentity(releaseId: string): Promise<{
    readonly projectId: string;
    readonly targetChannelName: string;
  }> {
    try {
      const result = await this.#pool.query<{
        readonly project_id: string;
        readonly target_channel_name: string;
      }>(
        `SELECT project_id, target_channel_name
         FROM meta.releases
         WHERE release_id = $1`,
        [releaseId],
      );
      const row = requireRow(result.rows[0], "Release does not exist.", "NOT_FOUND");
      return Object.freeze({
        projectId: row.project_id,
        targetChannelName: row.target_channel_name,
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

interface EvaluatedRelease {
  readonly release: ReleaseRow;
  readonly pins: readonly PinRow[];
  readonly channel: ChannelRow | null;
  readonly contextDigest: ArtifactDigest;
  readonly report: ValidationReportContract;
  readonly compatibility: CompatibilityReportContract;
}

interface RuntimePlanRootRow {
  readonly plan_digest: string;
  readonly member_count: number;
}

interface RuntimePlanGroupRow {
  readonly snapshot_group_id: string;
  readonly group_key: string;
  readonly mapping_resource_ids: string[];
}

interface RuntimePlanIndexRow {
  readonly target_resource_id: string;
  readonly target_revision_id: string;
  readonly index_plan_digest: string;
}

async function deriveAndPersistRuntimePlan(
  client: pg.PoolClient,
  release: ReleaseRow,
  pins: readonly PinRow[],
): Promise<RuntimeMemberPlanContract> {
  try {
    const existingResult = await client.query<RuntimePlanRootRow>(
      `SELECT plan_digest, member_count
       FROM meta.release_runtime_plans
       WHERE project_id = $1 AND release_id = $2`,
      [release.project_id, release.release_id],
    );
    const existing = existingResult.rows[0] ?? null;
    const groupResult = await client.query<RuntimePlanGroupRow>(
      `SELECT snapshot_group.snapshot_group_id,
              snapshot_group.group_key,
              array_agg(definition.mapping_resource_id::text
                        ORDER BY definition.ordinal) AS mapping_resource_ids
       FROM runtime.snapshot_groups AS snapshot_group
       JOIN runtime.snapshot_group_definition_members AS definition
         ON definition.project_id = snapshot_group.project_id
        AND definition.snapshot_group_id = snapshot_group.snapshot_group_id
       WHERE snapshot_group.project_id = $1
         AND snapshot_group.definition_member_count > 0
       GROUP BY snapshot_group.snapshot_group_id, snapshot_group.group_key,
                snapshot_group.definition_member_count
       HAVING count(*) = snapshot_group.definition_member_count
       ORDER BY snapshot_group.group_key COLLATE "C", snapshot_group.snapshot_group_id`,
      [release.project_id],
    );
    const snapshotGroups: RuntimePlanSnapshotGroupDefinition[] = groupResult.rows.map((row) =>
      Object.freeze({
        snapshotGroupId: row.snapshot_group_id,
        groupKey: row.group_key,
        mappingResourceIds: Object.freeze(row.mapping_resource_ids),
      }),
    );
    const planPins: RuntimePlanPinnedResource[] = pins.map((pin) =>
      Object.freeze({
        resourceId: pin.resource_id,
        revisionId: pin.revision_id,
        family: pin.revision_family,
        apiName: pin.api_name,
        contentDigest: parseArtifactDigest(pin.revision_content_digest),
        content: pin.content,
      }),
    );
    const indexPlans =
      existing === null
        ? await readNewRuntimePlanIndexes(client, release, pins)
        : await readPersistedRuntimePlanIndexes(client, release.release_id);
    const plan = compileRuntimeMemberPlan(
      {
        projectId: release.project_id,
        releaseId: release.release_id,
        pins: planPins,
        snapshotGroups,
        indexPlans,
      },
      digestText,
    );

    if (plan.members.length === 0) {
      if (existing !== null) {
        throw new MetadataApplicationError(
          "CONCURRENT_MODIFICATION",
          "A persisted Runtime Plan cannot become metadata-only.",
        );
      }
      return plan;
    }
    if (existing !== null) {
      if (
        existing.plan_digest !== plan.planDigest ||
        existing.member_count !== plan.members.length
      ) {
        throw new MetadataApplicationError(
          "CONCURRENT_MODIFICATION",
          "The server-derived Runtime Plan differs from the immutable persisted Plan.",
        );
      }
      await assertPersistedRuntimePlanMembers(client, plan, pins);
      return plan;
    }

    await client.query(
      `INSERT INTO meta.release_runtime_plans
         (project_id, release_id, plan_digest, member_count)
       VALUES ($1, $2, $3, $4)`,
      [release.project_id, release.release_id, plan.planDigest, plan.members.length],
    );
    const pinByRevision = new Map(pins.map((pin) => [pin.revision_id, pin] as const));
    for (const member of plan.members) {
      const schema = pinByRevision.get(member.snapshotSchemaRevisionId);
      const mapping = pinByRevision.get(member.mappingRevisionId);
      if (schema === undefined || mapping === undefined) {
        throw new MetadataApplicationError(
          "STORAGE_FAILURE",
          "The compiled Runtime Plan lost a pinned Schema or Mapping Resource.",
        );
      }
      await client.query(
        `INSERT INTO meta.release_runtime_plan_members (
           project_id, release_id, runtime_plan_digest, member_key, member_kind,
           target_resource_id, target_revision_id,
           snapshot_schema_resource_id, snapshot_schema_revision_id,
           mapping_resource_id, mapping_revision_id,
           snapshot_group_id, index_plan_digest
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
         )`,
        [
          release.project_id,
          release.release_id,
          plan.planDigest,
          member.memberKey,
          member.memberKind,
          member.targetResourceId,
          member.targetRevisionId,
          schema.resource_id,
          member.snapshotSchemaRevisionId,
          mapping.resource_id,
          member.mappingRevisionId,
          member.snapshotGroupId,
          member.indexPlanDigest,
        ],
      );
    }
    return plan;
  } catch (error) {
    if (error instanceof MetadataApplicationError) throw error;
    if (error instanceof RuntimePlanError) {
      throw new MetadataApplicationError("INVALID_STATE", error.message, { cause: error });
    }
    throw error;
  }
}

async function readNewRuntimePlanIndexes(
  client: pg.PoolClient,
  release: ReleaseRow,
  pins: readonly PinRow[],
): Promise<readonly RuntimePlanIndexReference[]> {
  const result = await client.query<RuntimePlanIndexRow>(
    `SELECT DISTINCT ON (plan.target_resource_id, plan.target_revision_id)
            plan.target_resource_id, plan.target_revision_id,
            plan.plan_digest AS index_plan_digest
     FROM runtime.index_plan_admissions AS admission
     JOIN runtime.index_plans AS plan
       ON plan.project_id = admission.project_id
      AND plan.index_plan_id = admission.index_plan_id
     JOIN runtime.project_runtime_inventories AS inventory
       ON inventory.project_id = admission.project_id
      AND inventory.inventory_revision = admission.inventory_revision
      AND inventory.measurement_complete
     WHERE admission.project_id = $1
       AND admission.release_id = $2
       AND (
         admission.approval_id IS NULL
         OR EXISTS (
           SELECT 1
           FROM runtime.capacity_approvals AS approval
           WHERE approval.project_id = admission.project_id
             AND approval.approval_id = admission.approval_id
             AND approval.state = 'active'
             AND approval.expires_at = admission.approval_expires_at
             AND approval.expires_at > clock_timestamp()
         )
       )
     ORDER BY plan.target_resource_id, plan.target_revision_id,
              admission.admitted_at DESC, admission.admission_id`,
    [release.project_id, release.release_id],
  );
  const indexes: RuntimePlanIndexReference[] = result.rows.map(runtimePlanIndexReference);
  for (const pin of pins) {
    if (pin.revision_family !== "mapping") continue;
    const mapping = parseMappingDefinition(pin.content);
    if (mapping.targetKind !== "link") continue;
    indexes.push(
      await ensureLinkIndexPlan(
        client,
        release.project_id,
        mapping.targetResourceId,
        mapping.targetRevisionId,
      ),
    );
  }
  return Object.freeze(indexes);
}

async function readPersistedRuntimePlanIndexes(
  client: pg.PoolClient,
  releaseId: string,
): Promise<readonly RuntimePlanIndexReference[]> {
  const result = await client.query<RuntimePlanIndexRow>(
    `SELECT DISTINCT target_resource_id, target_revision_id,
            index_plan_digest
     FROM meta.release_runtime_plan_members
     WHERE release_id = $1
     ORDER BY target_resource_id, target_revision_id`,
    [releaseId],
  );
  return Object.freeze(result.rows.map(runtimePlanIndexReference));
}

async function ensureLinkIndexPlan(
  client: pg.PoolClient,
  projectId: string,
  targetResourceId: string,
  targetRevisionId: string,
): Promise<RuntimePlanIndexReference> {
  const planDigest = digestCanonical({
    schemaVersion: 1,
    compilerVersion: "g2-02-10-link-index-v1",
    targetKind: "link",
    targetResourceId,
    targetRevisionId,
    entries: [],
  });
  const indexPlanId = deterministicUuid(
    "g2-02-10-link-index-plan",
    projectId,
    targetResourceId,
    targetRevisionId,
    planDigest,
  );
  await client.query(
    `INSERT INTO runtime.index_plans (
       project_id, index_plan_id, target_resource_id, target_revision_id,
       plan_digest, entry_count, compiler_version
     ) VALUES ($1, $2, $3, $4, $5, 0, 'g2-02-10-link-index-v1')
     ON CONFLICT (project_id, plan_digest) DO NOTHING`,
    [projectId, indexPlanId, targetResourceId, targetRevisionId, planDigest],
  );
  const result = await client.query<RuntimePlanIndexRow & { readonly entry_count: number }>(
    `SELECT target_resource_id, target_revision_id,
            plan_digest AS index_plan_digest, entry_count
     FROM runtime.index_plans
     WHERE project_id = $1 AND plan_digest = $2`,
    [projectId, planDigest],
  );
  const row = requireRow(result.rows[0], "Link Index Plan insert was not visible.");
  if (
    row.target_resource_id !== targetResourceId ||
    row.target_revision_id !== targetRevisionId ||
    row.entry_count !== 0
  ) {
    throw new MetadataApplicationError(
      "STORAGE_FAILURE",
      "A reused Link Index Plan has a mismatched immutable identity.",
    );
  }
  return runtimePlanIndexReference(row);
}

function runtimePlanIndexReference(row: RuntimePlanIndexRow): RuntimePlanIndexReference {
  return Object.freeze({
    targetResourceId: row.target_resource_id,
    targetRevisionId: row.target_revision_id,
    indexPlanDigest: parseArtifactDigest(row.index_plan_digest),
  });
}

async function assertPersistedRuntimePlanMembers(
  client: pg.PoolClient,
  plan: RuntimeMemberPlanContract,
  pins: readonly PinRow[],
): Promise<void> {
  const result = await client.query<{
    readonly member_key: string;
    readonly member_kind: "object" | "link";
    readonly target_resource_id: string;
    readonly target_revision_id: string;
    readonly snapshot_schema_resource_id: string;
    readonly snapshot_schema_revision_id: string;
    readonly mapping_resource_id: string;
    readonly mapping_revision_id: string;
    readonly snapshot_group_id: string;
    readonly index_plan_digest: string;
  }>(
    `SELECT member_key, member_kind, target_resource_id, target_revision_id,
            snapshot_schema_resource_id, snapshot_schema_revision_id,
            mapping_resource_id, mapping_revision_id,
            snapshot_group_id, index_plan_digest
     FROM meta.release_runtime_plan_members
     WHERE release_id = $1
     ORDER BY member_key COLLATE "C"`,
    [plan.releaseId],
  );
  const pinByRevision = new Map(pins.map((pin) => [pin.revision_id, pin] as const));
  const expected = plan.members.map((member) => {
    const schema = pinByRevision.get(member.snapshotSchemaRevisionId);
    const mapping = pinByRevision.get(member.mappingRevisionId);
    return {
      member_key: member.memberKey,
      member_kind: member.memberKind,
      target_resource_id: member.targetResourceId,
      target_revision_id: member.targetRevisionId,
      snapshot_schema_resource_id: schema?.resource_id,
      snapshot_schema_revision_id: member.snapshotSchemaRevisionId,
      mapping_resource_id: mapping?.resource_id,
      mapping_revision_id: member.mappingRevisionId,
      snapshot_group_id: member.snapshotGroupId,
      index_plan_digest: member.indexPlanDigest,
    };
  });
  if (JSON.stringify(result.rows) !== JSON.stringify(expected)) {
    throw new MetadataApplicationError(
      "CONCURRENT_MODIFICATION",
      "Persisted Runtime Plan members differ from the server-derived Plan.",
    );
  }
}

async function releaseRuntimeMembersReady(
  client: pg.PoolClient,
  releaseId: string,
): Promise<boolean> {
  const result = await client.query<{ readonly ready: boolean }>(
    `SELECT NOT EXISTS (
       SELECT 1
       FROM (
         SELECT member.snapshot_group_id, count(*)::integer AS expected_count
         FROM meta.release_runtime_plan_members AS member
         WHERE member.release_id = $1
         GROUP BY member.snapshot_group_id
       ) AS expected
       WHERE NOT EXISTS (
         SELECT 1
         FROM runtime.current_compatibility_certificates AS certificate
         WHERE certificate.target_release_id = $1
           AND certificate.snapshot_group_id = expected.snapshot_group_id
         GROUP BY certificate.group_version
         HAVING count(DISTINCT certificate.target_member_key) = expected.expected_count
       )
     ) AS ready`,
    [releaseId],
  );
  return result.rows[0]?.ready === true;
}

async function lockAndEvaluateRelease(
  client: pg.PoolClient,
  releaseId: string,
  validatorVersion: string,
): Promise<EvaluatedRelease> {
  const identityResult = await client.query<{
    readonly project_id: string;
    readonly target_channel_name: string;
  }>(`SELECT project_id, target_channel_name FROM meta.releases WHERE release_id = $1`, [
    releaseId,
  ]);
  const identity = requireRow(identityResult.rows[0], "Release does not exist.", "NOT_FOUND");
  const control = await lockProjectControl(client, identity.project_id);
  await lockChannelDomain(client, identity.project_id, identity.target_channel_name);
  const channel = await readChannel(
    client,
    identity.project_id,
    identity.target_channel_name,
    true,
  );
  const releaseResult = await client.query<ReleaseRow>(releaseSelect(true), [releaseId]);
  const release = requireRow(releaseResult.rows[0], "Release does not exist.", "NOT_FOUND");
  if (!["draft", "staging", "ready"].includes(release.state)) {
    throw new MetadataApplicationError(
      "INVALID_STATE",
      "Only a Draft, Staging or Ready Release can be validated.",
    );
  }
  const pins = await readPins(client, release.release_id);
  const packagePublication = await readPackagePublication(client, release.release_id, false);
  assertPendingPackagePublication(packagePublication, release.project_id);
  const manifest = manifestFromFacts(release, pins);
  if (manifest.manifestDigest !== release.manifest_digest) {
    throw new MetadataApplicationError(
      "STORAGE_FAILURE",
      "The sealed Release Manifest does not match its stored Digest.",
    );
  }
  return evaluateReleaseFacts(
    client,
    release,
    pins,
    channel,
    validatorVersion,
    control.publication_sequence,
    packagePublication,
  );
}

async function evaluateReleaseFacts(
  client: pg.PoolClient,
  release: ReleaseRow,
  pins: readonly PinRow[],
  channel: ChannelRow | null,
  validatorVersion: string,
  projectPublicationSequence: string,
  packagePublication: PackagePublicationRow | null,
): Promise<EvaluatedRelease> {
  const dependencies = await readDependencies(
    client,
    pins.map(({ revision_id }) => revision_id),
  );
  const baseline = channel === null ? [] : await readBaselinePins(client, channel.release_id);
  const gate = evaluateReleaseGate({
    releaseId: release.release_id,
    projectId: release.project_id,
    pins: pins.map(releaseGatePin),
    dependencies,
    baselinePins: baseline,
  });
  const contextDigest = digestCanonical({
    schemaVersion: 1,
    validatorVersion,
    compatibilityVersion: METADATA_COMPATIBILITY_VERSION,
    releaseId: release.release_id,
    manifestDigest: release.manifest_digest,
    projectPublicationSequence,
    channel: channel ?? {
      release_id: null,
      activation_id: null,
      control_sequence: "0",
    },
    pins: pins.map((pin) => ({
      order: pin.pin_order,
      resourceId: pin.resource_id,
      revisionId: pin.revision_id,
      storedFamily: pin.stored_family,
      revisionFamily: pin.revision_family,
      storedContentDigest: pin.stored_content_digest,
      revisionContentDigest: pin.revision_content_digest,
      resourceState: pin.resource_state,
      revisionState: pin.revision_state,
      hasCurrentValidationReport: pin.has_current_validation_report,
      policyCompilation: policyCompilationFromRow(pin),
    })),
    dependencies,
    baseline: baseline.map(({ resourceId, revisionId, family, contentDigest }) => ({
      resourceId,
      revisionId,
      family,
      contentDigest,
    })),
    compatibility: gate.compatibility,
    packagePublication:
      packagePublication === null
        ? null
        : {
            changeId: packagePublication.change_id,
            installationId: packagePublication.installation_id,
            packageId: packagePublication.package_id,
            targetPackageRevisionId: packagePublication.target_package_revision_id,
            targetReleaseId: packagePublication.target_release_id,
            state: packagePublication.change_state,
            operation: packagePublication.operation,
            previousPackageRevisionId: packagePublication.previous_package_revision_id,
            previousReleaseId: packagePublication.previous_release_id,
            requestDigest: packagePublication.request_digest,
            inputBindingsDigest: packagePublication.input_bindings_digest,
            compatibilityReport: packagePublication.compatibility_report,
            installationControlSequence: packagePublication.installation_control_sequence,
            activePackageRevisionId: packagePublication.active_package_revision_id,
            activeReleaseId: packagePublication.active_release_id,
            targetManifestDigest: packagePublication.target_manifest_digest,
          },
  });
  const compatibility = parseCompatibilityReport(
    buildCompatibilityReport({
      reportId: parseOntosId(
        deterministicUuid("release-compatibility", release.release_id, contextDigest),
      ),
      baselineDigest:
        channel === null
          ? parseArtifactDigest(release.manifest_digest)
          : await readReleaseManifestDigest(client, channel.release_id),
      candidateDigest: parseArtifactDigest(release.manifest_digest),
      evaluation: boundCompatibility(gate.compatibility),
    }),
  );
  const report = parseValidationReport({
    schemaVersion: 1,
    reportId: deterministicUuid("release-validation", release.release_id, contextDigest),
    subjectId: release.release_id,
    subjectDigest: release.manifest_digest,
    validatorVersion,
    valid: gate.valid,
    issues: gate.issues,
  });
  return Object.freeze({ release, pins, channel, contextDigest, report, compatibility });
}

async function persistEvaluation(
  client: pg.PoolClient,
  evaluated: EvaluatedRelease,
): Promise<ReleaseValidationResult> {
  await client.query(
    `INSERT INTO meta.validation_reports
       (report_id, subject_type, subject_id, release_id, subject_digest,
        validation_context_digest, validator_version, valid, issues)
     VALUES ($1, 'release', $2, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (
       subject_type, subject_id, subject_digest, validation_context_digest, validator_version
     ) DO NOTHING`,
    [
      evaluated.report.reportId,
      evaluated.release.release_id,
      evaluated.release.manifest_digest,
      evaluated.contextDigest,
      evaluated.report.validatorVersion,
      evaluated.report.valid,
      JSON.stringify(evaluated.report.issues),
    ],
  );
  const storedResult = await client.query<ReportRow>(
    `SELECT report_id, subject_id, subject_digest, validation_context_digest,
            validator_version, valid, issues
     FROM meta.validation_reports
     WHERE subject_type = 'release'
       AND release_id = $1
       AND subject_digest = $2
       AND validation_context_digest = $3
       AND validator_version = $4`,
    [
      evaluated.release.release_id,
      evaluated.release.manifest_digest,
      evaluated.contextDigest,
      evaluated.report.validatorVersion,
    ],
  );
  const stored = requireRow(
    storedResult.rows[0],
    "Release Validation Report insert was not visible.",
  );
  const report = parseValidationReport({
    schemaVersion: 1,
    reportId: stored.report_id,
    subjectId: stored.subject_id,
    subjectDigest: stored.subject_digest,
    validatorVersion: stored.validator_version,
    valid: stored.valid,
    issues: stored.issues,
  });
  return Object.freeze({
    release: releaseRecord(evaluated.release, evaluated.pins),
    report,
    compatibility: evaluated.compatibility,
    validationContextDigest: evaluated.contextDigest,
  });
}

async function lockProjectControl(client: pg.PoolClient, projectId: string): Promise<ControlRow> {
  const projectResult = await client.query<
    Pick<ControlRow, "project_state" | "publication_sequence">
  >(
    `SELECT project.state AS project_state,
            project.publication_sequence::text
     FROM meta.projects AS project
     WHERE project.project_id = $1
     FOR UPDATE OF project`,
    [projectId],
  );
  const project = requireRow(
    projectResult.rows[0],
    "Project control state does not exist.",
    "NOT_FOUND",
  );
  const epochResult = await client.query<Pick<ControlRow, "authorization_epoch">>(
    `SELECT authz.lock_authorization_epoch($1)::text AS authorization_epoch`,
    [projectId],
  );
  const row: ControlRow = {
    ...project,
    authorization_epoch: requireRow(
      epochResult.rows[0],
      "Authorization Epoch does not exist.",
      "NOT_FOUND",
    ).authorization_epoch,
  };
  if (row.project_state !== "active") {
    throw new MetadataApplicationError(
      "INVALID_STATE",
      "Archived Project cannot publish Releases.",
    );
  }
  return row;
}

async function assertPublisherOwner(
  client: pg.PoolClient,
  projectId: string,
  principalId: string,
): Promise<void> {
  const result = await client.query<{ readonly allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM authz.principals AS principal
       JOIN authz.role_bindings AS binding
         ON binding.principal_id = principal.principal_id
        AND binding.project_id = $1
        AND binding.scope = 'project'
        AND binding.resource_id IS NULL
        AND binding.role = 'owner'
        AND binding.state = 'active'
       WHERE principal.principal_id = $2
         AND principal.state = 'active'
     ) AS allowed`,
    [projectId, principalId],
  );
  if (result.rows[0]?.allowed !== true) {
    throw new MetadataApplicationError(
      "FORBIDDEN",
      "Publisher no longer has the Project Owner publication grant.",
    );
  }
}

async function lockChannelDomain(
  client: pg.PoolClient,
  projectId: string,
  channelName: string,
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 20108))`, [
    `${projectId}:${channelName}`,
  ]);
}

async function readChannel(
  client: pg.PoolClient,
  projectId: string,
  channelName: string,
  lock: boolean,
): Promise<ChannelRow | null> {
  const result = await client.query<ChannelRow>(
    `SELECT release_id, activation_id, control_sequence::text
     FROM meta.release_channels
     WHERE project_id = $1 AND channel_name = $2${lock ? " FOR UPDATE" : ""}`,
    [projectId, channelName],
  );
  return result.rows[0] ?? null;
}

async function readPackagePublication(
  client: pg.PoolClient,
  releaseId: string,
  lock: boolean,
): Promise<PackagePublicationRow | null> {
  const result = await client.query<PackagePublicationRow>(
    `SELECT change.change_id,
            change.installation_id,
            change.package_id,
            change.target_package_revision_id,
            change.target_release_id,
            change.state AS change_state,
            change.operation,
            change.previous_package_revision_id,
            change.previous_release_id,
            change.request_digest,
            change.input_bindings_digest,
            change.compatibility_report,
            installation.project_id AS installation_project_id,
            installation.package_id AS installation_package_id,
            installation.active_package_revision_id,
            installation.active_release_id,
            installation.control_sequence::text AS installation_control_sequence,
            revision.manifest_digest AS target_manifest_digest
     FROM meta.package_installation_changes AS change
     JOIN meta.package_installations AS installation
       ON installation.installation_id = change.installation_id
      AND installation.project_id = change.project_id
      AND installation.package_id = change.package_id
     JOIN meta.package_revisions AS revision
       ON revision.package_revision_id = change.target_package_revision_id
      AND revision.package_id = change.package_id
     WHERE change.target_release_id = $1${lock ? " FOR UPDATE OF change, installation" : ""}`,
    [releaseId],
  );
  if (result.rows.length > 1) {
    throw new MetadataApplicationError(
      "STORAGE_FAILURE",
      "Release is bound to more than one Package Change.",
    );
  }
  return result.rows[0] ?? null;
}

function assertPendingPackagePublication(
  publication: PackagePublicationRow | null,
  projectId: string,
): void {
  if (publication === null) return;
  if (
    publication.change_state !== "pending" ||
    publication.target_release_id.length === 0 ||
    publication.installation_project_id !== projectId ||
    publication.installation_package_id !== publication.package_id ||
    publication.active_package_revision_id !== publication.previous_package_revision_id ||
    publication.active_release_id !== publication.previous_release_id
  ) {
    throw new MetadataApplicationError(
      "CONCURRENT_MODIFICATION",
      "Package Installation facts no longer match the Pending Release Change.",
    );
  }
  const report = parseCompatibilityReport(publication.compatibility_report);
  if (
    report.outcome !== "compatible" ||
    report.candidateDigest !== publication.target_manifest_digest
  ) {
    throw new MetadataApplicationError(
      "INVALID_STATE",
      "Package Change has no compatible report for its target Manifest.",
    );
  }
}

async function assertPackagePublicationApplied(
  client: pg.PoolClient,
  releaseId: string,
): Promise<void> {
  const publication = await readPackagePublication(client, releaseId, true);
  if (publication === null) return;
  if (
    publication.change_state !== "active" ||
    publication.active_package_revision_id !== publication.target_package_revision_id ||
    publication.active_release_id !== releaseId
  ) {
    throw new MetadataApplicationError(
      "STORAGE_FAILURE",
      "Published Release has an incomplete Package activation.",
    );
  }
}

async function readPins(
  client: pg.PoolClient,
  releaseId: string,
  lock = false,
): Promise<readonly PinRow[]> {
  const result = await client.query<PinRow>(
    `SELECT pin.pin_order,
            pin.resource_id,
            pin.revision_id,
            pin.family AS stored_family,
            pin.content_digest AS stored_content_digest,
            resource.project_id,
            resource.api_name,
            resource.state AS resource_state,
            revision.family AS revision_family,
            revision.state AS revision_state,
            revision.content_digest AS revision_content_digest,
            revision.content,
            EXISTS (
              SELECT 1
              FROM meta.validation_reports AS report
              WHERE report.subject_type = 'resource_revision'
                AND report.resource_revision_id = revision.revision_id
                AND report.subject_digest = revision.content_digest
                AND report.validator_version = CASE
                  WHEN revision.family = 'policy' THEN $3
                  ELSE $2
                END
                AND report.valid = TRUE
            ) AS has_current_validation_report,
            compilation.policy_compilation_id,
            compilation.policy_content_digest,
            compilation.compiler_version AS policy_compiler_version,
            compilation.artifact_digest AS policy_artifact_digest,
            compilation.test_report_digest AS policy_test_report_digest,
            compilation.test_vector_count AS policy_test_vector_count,
            compilation.passed_vector_count AS policy_passed_vector_count,
            compilation.failed_vector_count AS policy_failed_vector_count,
            compilation.status AS policy_compilation_status
     FROM meta.release_pins AS pin
     JOIN meta.releases AS release ON release.release_id = pin.release_id
     JOIN meta.resources AS resource ON resource.resource_id = pin.resource_id
     JOIN meta.resource_revisions AS revision
       ON revision.resource_id = pin.resource_id
      AND revision.revision_id = pin.revision_id
     LEFT JOIN LATERAL authz.resolve_release_policy_compilations(
       release.project_id, release.release_id
     ) AS compilation ON compilation.policy_revision_id = pin.revision_id
     WHERE pin.release_id = $1
     ORDER BY pin.pin_order, pin.resource_id${lock ? " FOR UPDATE OF resource, revision" : ""}`,
    [releaseId, METADATA_VALIDATOR_VERSION, POLICY_VALIDATOR_VERSION],
  );
  return Object.freeze(result.rows);
}

async function readBaselinePins(
  client: pg.PoolClient,
  releaseId: string,
): Promise<readonly ReleaseBaselinePin[]> {
  const rows = await readPins(client, releaseId);
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        resourceId: row.resource_id,
        revisionId: row.revision_id,
        family: row.revision_family,
        content: row.content,
        contentDigest: parseArtifactDigest(row.revision_content_digest),
      }),
    ),
  );
}

async function readDependencies(
  client: pg.PoolClient,
  sourceRevisionIds: readonly string[],
): Promise<readonly PinnedCompatibilityDependency[]> {
  const result = await client.query<DependencyRow>(
    `SELECT source_revision_id, target_revision_id, dependency_type, source_path
     FROM meta.resource_dependencies
     WHERE source_revision_id = ANY($1::uuid[])
     ORDER BY source_revision_id, target_revision_id, dependency_type, source_path`,
    [sourceRevisionIds],
  );
  return Object.freeze(
    result.rows.map((row) =>
      Object.freeze({
        sourceRevisionId: row.source_revision_id,
        targetRevisionId: row.target_revision_id,
        dependencyType: row.dependency_type,
        sourcePath: row.source_path,
      }),
    ),
  );
}

async function readReleaseManifestDigest(
  client: pg.PoolClient,
  releaseId: string,
): Promise<ArtifactDigest> {
  const result = await client.query<{ readonly manifest_digest: string }>(
    `SELECT manifest_digest FROM meta.releases WHERE release_id = $1`,
    [releaseId],
  );
  return parseArtifactDigest(
    requireRow(result.rows[0], "Baseline Release does not exist.").manifest_digest,
  );
}

async function readPublishedBinding(
  client: pg.PoolClient,
  release: ReleaseRow,
  control: ControlRow,
): Promise<PublishedReleaseBinding> {
  const result = await client.query<{
    readonly activation_id: string;
    readonly control_sequence: string;
  }>(
    `SELECT channel.activation_id, channel.control_sequence::text
     FROM meta.release_channels AS channel
     JOIN meta.release_serving_heads AS head
       ON head.release_id = channel.release_id
      AND head.activation_id = channel.activation_id
     WHERE channel.project_id = $1
       AND channel.channel_name = $2
       AND channel.release_id = $3`,
    [release.project_id, release.target_channel_name, release.release_id],
  );
  const row = requireRow(
    result.rows[0],
    "Published Release is not the current sealed Channel binding.",
    "CONCURRENT_MODIFICATION",
  );
  return publishedBinding({
    release,
    activationId: row.activation_id,
    channelControlSequence: BigInt(row.control_sequence),
    projectPublicationSequence: BigInt(control.publication_sequence),
    authorizationEpoch: BigInt(control.authorization_epoch),
  });
}

function publishedBinding(input: {
  readonly release: ReleaseRow;
  readonly activationId: string;
  readonly channelControlSequence: bigint;
  readonly projectPublicationSequence: bigint;
  readonly authorizationEpoch: bigint;
}): PublishedReleaseBinding {
  return Object.freeze({
    binding: parseReleaseBinding({
      schemaVersion: 1,
      projectId: input.release.project_id,
      releaseId: input.release.release_id,
      // DB-01 has a one-to-one Release fact/Release Revision relation. The
      // immutable Release row is therefore the actual revision identity.
      releaseRevisionId: input.release.release_id,
      activationId: input.activationId,
      manifestDigest: input.release.manifest_digest,
    }),
    channelName: input.release.target_channel_name,
    channelControlSequence: input.channelControlSequence,
    projectPublicationSequence: input.projectPublicationSequence,
    authorizationEpoch: input.authorizationEpoch,
  });
}

function releaseRecord(row: ReleaseRow, pins: readonly PinRow[]): ReleaseRecord {
  const manifest = manifestFromFacts(row, pins);
  return Object.freeze({
    releaseId: row.release_id,
    projectId: row.project_id,
    rollbackOfReleaseId: row.rollback_of_release_id,
    releaseNumber: BigInt(row.release_number),
    manifestDigest: parseArtifactDigest(row.manifest_digest),
    state: row.state,
    targetChannelName: row.target_channel_name,
    stagedFromReleaseId: row.staged_from_release_id,
    stagedFromActivationId: row.staged_from_activation_id,
    stagedChannelControlSequence:
      row.staged_channel_control_sequence === null
        ? null
        : BigInt(row.staged_channel_control_sequence),
    stagedValidationContextDigest:
      row.staged_validation_context_digest === null
        ? null
        : parseArtifactDigest(row.staged_validation_context_digest),
    createdByPrincipalId: row.created_by_principal_id,
    publishedByPrincipalId: row.published_by_principal_id,
    createdAt: row.created_at,
    stagedAt: row.staged_at,
    publishedAt: row.published_at,
    manifest,
  });
}

function manifestFromFacts(row: ReleaseRow, pins: readonly PinRow[]): ReleaseManifestContract {
  const manifest = parseReleaseManifest({
    schemaVersion: 1,
    releaseId: row.release_id,
    projectId: row.project_id,
    releaseNumber: Number(BigInt(row.release_number)),
    pins: pins.map((pin) => ({
      order: pin.pin_order,
      resourceId: pin.resource_id,
      revisionId: pin.revision_id,
      family: pin.stored_family,
      contentDigest: pin.stored_content_digest,
    })),
    manifestDigest: row.manifest_digest,
    createdAt: row.created_at,
  });
  const actual = digestText(canonicalizeManifestForDigest(manifest));
  if (actual !== manifest.manifestDigest) {
    throw new MetadataApplicationError(
      "STORAGE_FAILURE",
      "Stored Release facts do not reproduce the Manifest Digest.",
    );
  }
  return manifest;
}

function createManifest(input: {
  readonly releaseId: string;
  readonly projectId: string;
  readonly releaseNumber: number;
  readonly pins: readonly {
    readonly order: number;
    readonly resourceId: string;
    readonly revisionId: string;
    readonly family: ResourceFamily;
    readonly contentDigest: string;
  }[];
  readonly createdAt: string;
}): ReleaseManifestContract {
  const draft = {
    schemaVersion: 1,
    ...input,
    manifestDigest: zeroDigest,
  };
  const digest = digestText(canonicalizeManifestForDigest(draft));
  return parseReleaseManifest({ ...draft, manifestDigest: digest });
}

function releaseGatePin(row: PinRow): ReleaseGatePin {
  return Object.freeze({
    order: row.pin_order,
    resourceId: row.resource_id,
    revisionId: row.revision_id,
    projectId: row.project_id,
    family: row.revision_family,
    storedFamily: row.stored_family,
    content: row.content,
    storedContentDigest: parseArtifactDigest(row.stored_content_digest),
    revisionContentDigest: parseArtifactDigest(row.revision_content_digest),
    resourceState: row.resource_state,
    revisionState: row.revision_state,
    hasCurrentValidationReport: row.has_current_validation_report,
    policyCompilation: policyCompilationFromRow(row),
  });
}

function policyCompilationFromRow(
  row: PinRow,
): NonNullable<ReleaseGatePin["policyCompilation"]> | null {
  const values = [
    row.policy_content_digest,
    row.policy_compiler_version,
    row.policy_artifact_digest,
    row.policy_test_report_digest,
    row.policy_test_vector_count,
    row.policy_passed_vector_count,
    row.policy_failed_vector_count,
    row.policy_compilation_status,
  ];
  if (row.policy_compilation_id === null) {
    if (values.some((value) => value !== null)) {
      throw new MetadataApplicationError(
        "STORAGE_FAILURE",
        "Policy Compilation facts are partially populated.",
      );
    }
    return null;
  }
  return Object.freeze({
    policyCompilationId: row.policy_compilation_id,
    policyContentDigest: parseArtifactDigest(
      requireValue(row.policy_content_digest, "Policy Content Digest is unavailable."),
    ),
    compilerVersion: requireValue(
      row.policy_compiler_version,
      "Policy Compiler Version is unavailable.",
    ),
    artifactDigest: parseArtifactDigest(
      requireValue(row.policy_artifact_digest, "Policy Artifact Digest is unavailable."),
    ),
    testReportDigest: parseArtifactDigest(
      requireValue(row.policy_test_report_digest, "Policy Test Digest is unavailable."),
    ),
    testVectorCount: requireValue(
      row.policy_test_vector_count,
      "Policy Test count is unavailable.",
    ),
    passedVectorCount: requireValue(
      row.policy_passed_vector_count,
      "Policy passed count is unavailable.",
    ),
    failedVectorCount: requireValue(
      row.policy_failed_vector_count,
      "Policy failed count is unavailable.",
    ),
    status: requireValue(row.policy_compilation_status, "Policy status is unavailable."),
  });
}

function pinRowFromCreation(
  row: {
    readonly resource_id: string;
    readonly revision_id: string;
    readonly family: ResourceFamily;
    readonly content_digest: string;
    readonly project_id: string;
    readonly api_name: string;
    readonly state: ResourceRevisionState;
  },
  order: number,
): PinRow {
  return {
    pin_order: order,
    resource_id: row.resource_id,
    revision_id: row.revision_id,
    stored_family: row.family,
    stored_content_digest: row.content_digest,
    project_id: row.project_id,
    api_name: row.api_name,
    resource_state: "active",
    revision_family: row.family,
    revision_state: row.state,
    policy_compilation_id: null,
    policy_content_digest: null,
    policy_compiler_version: null,
    policy_artifact_digest: null,
    policy_test_report_digest: null,
    policy_test_vector_count: null,
    policy_passed_vector_count: null,
    policy_failed_vector_count: null,
    policy_compilation_status: null,
    revision_content_digest: row.content_digest,
    content: {},
    has_current_validation_report: true,
  };
}

function releaseSelect(lock: boolean): string {
  return `SELECT ${releaseColumns()}
          FROM meta.releases
          WHERE release_id = $1${lock ? " FOR UPDATE" : ""}`;
}

function releaseColumns(): string {
  return `release_id,
          project_id,
          rollback_of_release_id,
          release_number::text,
          manifest_digest,
          state,
          target_channel_name,
          staged_from_release_id,
          staged_from_activation_id,
          staged_channel_control_sequence::text,
          staged_validation_context_digest,
          created_by_principal_id,
          published_by_principal_id,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
          CASE WHEN staged_at IS NULL THEN NULL ELSE
            to_char(staged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS staged_at,
          CASE WHEN published_at IS NULL THEN NULL ELSE
            to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS published_at`;
}

function releaseUpdateToReady(): string {
  return `UPDATE meta.releases
          SET state = 'ready', changed_at = clock_timestamp()
          WHERE release_id = $1 AND state = 'staging'`;
}

function deterministicUuid(namespace: string, ...values: readonly string[]): string {
  const hexadecimal = createHash("sha256")
    .update([namespace, ...values].join("\u0000"), "utf8")
    .digest("hex");
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-5${hexadecimal.slice(
    13,
    16,
  )}-a${hexadecimal.slice(17, 20)}-${hexadecimal.slice(20, 32)}`;
}

function boundCompatibility(evaluation: CompatibilityEvaluation): CompatibilityEvaluation {
  if (evaluation.findings.length <= 1_000) return evaluation;
  const summary = Object.freeze({
    kind: evaluation.outcome,
    code: "COMPATIBILITY_FINDINGS_TRUNCATED",
    path: "/",
    message: "The Release comparison produced more Findings than the public report limit.",
    requiredNextStep:
      "Resolve the reported changes in smaller Release batches, then compare again.",
  }) satisfies CompatibilityFindingContract;
  return Object.freeze({
    outcome: evaluation.outcome,
    findings: Object.freeze([...evaluation.findings.slice(0, 999), summary]),
  });
}

function digestCanonical(value: unknown): ArtifactDigest {
  return digestText(canonicalizeContractForDigest(value));
}

function digestText(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}

function assertReleaseValidatorVersion(value: string): void {
  if (value !== METADATA_RELEASE_VALIDATOR_VERSION) {
    throw new MetadataApplicationError("INVALID_INPUT", "Release Validator version is not active.");
  }
}

function requireValue<T>(value: T | null, message: string): T {
  if (value === null) throw new MetadataApplicationError("STORAGE_FAILURE", message);
  return value;
}

function requireRow<T>(
  row: T | undefined,
  message: string,
  code: "NOT_FOUND" | "CONCURRENT_MODIFICATION" | "STORAGE_FAILURE" = "STORAGE_FAILURE",
): T {
  if (row === undefined) throw new MetadataApplicationError(code, message);
  return row;
}

function mapStorageError(error: unknown): MetadataApplicationError {
  if (error instanceof MetadataApplicationError) return error;
  const code = postgreSqlErrorCode(error);
  if (code === "23505") {
    return new MetadataApplicationError("ALREADY_EXISTS", "A unique Release fact already exists.", {
      cause: error,
    });
  }
  if (code === "23503") {
    return new MetadataApplicationError("NOT_FOUND", "A referenced Release fact does not exist.", {
      cause: error,
    });
  }
  if (code === "22P02" || code === "23514") {
    return new MetadataApplicationError("INVALID_INPUT", "The Release write is invalid.", {
      cause: error,
    });
  }
  if (code === "40001" || code === "40P01") {
    return new MetadataApplicationError(
      "CONCURRENT_MODIFICATION",
      "The Release transaction must be retried from a fresh read.",
      { cause: error },
    );
  }
  if (code === "55000") {
    return new MetadataApplicationError("INVALID_STATE", "The Release state is not publishable.", {
      cause: error,
    });
  }
  return new MetadataApplicationError("STORAGE_FAILURE", "The Release store operation failed.", {
    cause: error,
  });
}

function postgreSqlErrorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("code" in value)) return null;
  return typeof value.code === "string" ? value.code : null;
}
