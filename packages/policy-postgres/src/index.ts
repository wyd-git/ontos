import { createHash } from "node:crypto";

import {
  parseArtifactDigest,
  type ArtifactDigest,
  type PolicyActorAttributeSchema,
  type ResourceFamily,
} from "@ontos/contracts";
import {
  PolicyApplicationError,
  type PolicyCompilationInputSnapshot,
  type PolicyCompilationRecorder,
  type PolicyCompilationSource,
} from "@ontos/policy-application";
import type { PolicyCompilerTargetSnapshot } from "@ontos/policy-domain";
import type pg from "pg";

interface PolicyPinRow {
  readonly project_id: string;
  readonly release_id: string;
  readonly release_state: string;
  readonly policy_resource_id: string;
  readonly policy_revision_id: string;
  readonly policy_content_digest: string;
  readonly content: unknown;
}

interface TargetRow {
  readonly project_id: string;
  readonly resource_id: string;
  readonly revision_id: string;
  readonly family: ResourceFamily;
  readonly api_name: string;
  readonly content_digest: string;
  readonly content: unknown;
}

interface ActorAttributeRow {
  readonly attribute_name: string;
  readonly value_type: PolicyActorAttributeSchema["valueType"];
}

export class PostgresPolicyCompilationStore
  implements PolicyCompilationSource, PolicyCompilationRecorder
{
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async loadCompilationInput(input: {
    readonly projectId: string;
    readonly releaseId: string;
    readonly policyRevisionId: string;
  }): Promise<PolicyCompilationInputSnapshot> {
    return this.#transaction(true, async (client) => {
      await client.query(`SELECT set_config('ontos.project_id', $1, true)`, [input.projectId]);
      const pinResult = await client.query<PolicyPinRow>(
        `SELECT release.project_id, release.release_id, release.state AS release_state,
                pin.resource_id AS policy_resource_id,
                pin.revision_id AS policy_revision_id,
                revision.content_digest AS policy_content_digest, revision.content
         FROM meta.releases AS release
         JOIN meta.release_pins AS pin ON pin.release_id = release.release_id
         JOIN meta.resource_revisions AS revision
           ON revision.resource_id = pin.resource_id
          AND revision.revision_id = pin.revision_id
         WHERE release.project_id = $1
           AND release.release_id = $2
           AND pin.revision_id = $3
           AND pin.family = 'policy'
           AND revision.family = 'policy'`,
        [input.projectId, input.releaseId, input.policyRevisionId],
      );
      const pin = requireSingle(pinResult.rows, "Policy Release Pin is unavailable.");
      if (pin.release_state !== "draft" && pin.release_state !== "staging") {
        throw new PolicyApplicationError(
          "INVALID_INPUT",
          "Policy compilation is only available before Release readiness.",
        );
      }
      const targetsResult = await client.query<TargetRow>(
        `SELECT resource.project_id, pin.resource_id, pin.revision_id,
                revision.family, resource.api_name, revision.content_digest, revision.content
         FROM meta.release_pins AS pin
         JOIN meta.resources AS resource ON resource.resource_id = pin.resource_id
         JOIN meta.resource_revisions AS revision
           ON revision.resource_id = pin.resource_id
          AND revision.revision_id = pin.revision_id
         WHERE pin.release_id = $1
         ORDER BY pin.revision_id`,
        [input.releaseId],
      );
      if (targetsResult.rows.length === 0) {
        throw new PolicyApplicationError("STORAGE_FAILURE", "Release Pin set is unavailable.");
      }
      const attributeResult = await client.query<ActorAttributeRow>(
        `SELECT attribute_name, value_type
         FROM authz.resolve_policy_actor_attribute_schema($1)
         ORDER BY attribute_name COLLATE "C"`,
        [input.projectId],
      );
      const targets: readonly PolicyCompilerTargetSnapshot[] = Object.freeze(
        targetsResult.rows.map((row) =>
          Object.freeze({
            projectId: row.project_id,
            resourceId: row.resource_id,
            revisionId: row.revision_id,
            family: row.family,
            apiName: row.api_name,
            contentDigest: parseArtifactDigest(row.content_digest),
            content: row.content,
          }),
        ),
      );
      return Object.freeze({
        projectId: pin.project_id,
        releaseId: pin.release_id,
        policyResourceId: pin.policy_resource_id,
        policyRevisionId: pin.policy_revision_id,
        policyContentDigest: parseArtifactDigest(pin.policy_content_digest),
        definition: pin.content,
        releaseRevisionIds: Object.freeze(targets.map(({ revisionId }) => revisionId)),
        targets,
        trustedActorAttributes: Object.freeze(
          attributeResult.rows.map(({ attribute_name: apiName, value_type: valueType }) =>
            Object.freeze({ apiName, valueType }),
          ),
        ),
      });
    });
  }

  async recordCompilation(
    input: Parameters<PolicyCompilationRecorder["recordCompilation"]>[0],
  ): Promise<void> {
    await this.#transaction(false, async (client) => {
      await client.query(`SELECT set_config('ontos.project_id', $1, true)`, [input.projectId]);
      await client.query(
        `SELECT authz.record_policy_compilation(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13, $14, $15
         )`,
        [
          input.projectId,
          input.policyCompilationId,
          input.releaseId,
          input.policyResourceId,
          input.policyRevisionId,
          input.policyContentDigest,
          input.compilerVersion,
          input.artifactReferenceId,
          input.artifactDigest,
          input.testReportReferenceId,
          input.testReportDigest,
          input.testVectorCount,
          input.passedVectorCount,
          input.failedVectorCount,
          input.status,
        ],
      );
    });
  }

  async #transaction<T>(
    readOnly: boolean,
    action: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      throw storageError(error);
    }
    let releaseError: Error | undefined;
    try {
      await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
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
      if (error instanceof PolicyApplicationError) throw error;
      throw storageError(error);
    } finally {
      client.release(releaseError);
    }
  }
}

export function sha256PolicyText(value: string): ArtifactDigest {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}

function requireSingle<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new PolicyApplicationError("STORAGE_FAILURE", message);
  }
  return rows[0];
}

function storageError(error: unknown): PolicyApplicationError {
  return new PolicyApplicationError("STORAGE_FAILURE", "Policy persistence failed closed.", {
    cause: error,
  });
}
