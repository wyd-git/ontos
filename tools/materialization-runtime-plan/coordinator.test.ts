import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCompatibilityCertificate, type ArtifactDigest } from "@ontos/contracts";
import {
  RuntimeCompatibilityCoordinator,
  RuntimeCompatibilityError,
  type RuntimeCompatibilityRepository,
} from "@ontos/materialization-application";

const ids = Object.freeze({
  project: "20000000-0000-4000-8000-000000000001",
  group: "20000000-0000-4000-8000-000000000002",
  release1: "20000000-0000-4000-8000-000000000003",
  release2: "20000000-0000-4000-8000-000000000004",
  release3: "20000000-0000-4000-8000-000000000005",
  generation: "20000000-0000-4000-8000-000000000006",
  failedGeneration: "20000000-0000-4000-8000-000000000007",
  job: "20000000-0000-4000-8000-000000000008",
  targetRevision: "20000000-0000-4000-8000-000000000009",
  schemaRevision: "20000000-0000-4000-8000-000000000010",
  mappingRevision: "20000000-0000-4000-8000-000000000011",
});

void describe("Runtime compatibility coordinator", () => {
  void it("reports each affected Release independently and marks cross-Release reuse", async () => {
    const result = await new RuntimeCompatibilityCoordinator(
      repository(),
    ).prepareSnapshotGroupRefresh({
      projectId: ids.project,
      snapshotGroupId: ids.group,
      groupVersion: 7,
    });

    assert.deepEqual(
      result.releases.map((release) => [release.releaseId, release.outcome]),
      [
        [ids.release1, "ready"],
        [ids.release2, "reused"],
        [ids.release3, "failed"],
      ],
    );
    assert.equal(result.releases[0]?.certifiedMemberCount, 1);
    assert.equal(result.releases[1]?.certifiedMemberCount, 1);
    assert.equal(result.releases[2]?.certifiedMemberCount, 0);
    assert.equal(result.job.reused, true);
  });

  void it("rejects caller-supplied compatibility facts instead of ignoring them", async () => {
    await assert.rejects(
      new RuntimeCompatibilityCoordinator(repository()).issueGenerationCertificate({
        projectId: ids.project,
        generationId: ids.generation,
        targetReleaseId: ids.release1,
        decision: "exact_pin",
      }),
      (error: unknown) =>
        error instanceof RuntimeCompatibilityError &&
        error.code === "RUNTIME_COMPATIBILITY_INPUT_INVALID",
    );
  });

  void it("keeps a stale Release result local while another Release becomes ready", async () => {
    const base = repository();
    const staleRepository: RuntimeCompatibilityRepository = {
      ...base,
      issueCompatibilityCertificate(input) {
        if (input.targetReleaseId === ids.release2) {
          throw new RuntimeCompatibilityError("RUNTIME_COMPATIBILITY_STALE");
        }
        return base.issueCompatibilityCertificate(input);
      },
    };
    const result = await new RuntimeCompatibilityCoordinator(
      staleRepository,
    ).prepareSnapshotGroupRefresh({
      projectId: ids.project,
      snapshotGroupId: ids.group,
      groupVersion: 7,
    });
    assert.equal(result.releases[0]?.outcome, "ready");
    assert.equal(result.releases[1]?.outcome, "stale");
  });

  void it("reports a mismatched Snapshot Group as stale without issuing a partial certificate", async () => {
    const base = repository();
    let issueCount = 0;
    const result = await new RuntimeCompatibilityCoordinator({
      ...base,
      readRefreshTargets() {
        return Promise.resolve([
          {
            ...target(ids.release1, "published", digest("1")),
            snapshotGroupCompatible: false,
          },
        ]);
      },
      async issueCompatibilityCertificate(input) {
        issueCount += 1;
        return base.issueCompatibilityCertificate(input);
      },
    }).prepareSnapshotGroupRefresh({
      projectId: ids.project,
      snapshotGroupId: ids.group,
      groupVersion: 7,
    });
    assert.equal(result.releases[0]?.outcome, "stale");
    assert.equal(result.releases[0]?.certifiedMemberCount, 0);
    assert.equal(issueCount, 0);
  });
});

function repository(): RuntimeCompatibilityRepository {
  const plan1 = digest("1");
  const plan2 = digest("2");
  const plan3 = digest("3");
  return {
    readRefreshTargets() {
      return Promise.resolve([
        target(ids.release2, "published", plan2),
        target(ids.release1, "published", plan1),
        target(ids.release3, "superseded", plan3),
      ]);
    },
    ensureMaterializationJob() {
      return Promise.resolve({ jobId: ids.job, state: "succeeded" as const, reused: true });
    },
    readGenerationCandidates(input) {
      if (input.memberKey !== "object:Customer") return Promise.resolve([]);
      if (input.projectId !== ids.project) return Promise.resolve([]);
      return Promise.resolve(
        input.groupVersion === 7
          ? [
              { generationId: ids.generation, state: "ready", runtimePlanDigest: plan1 },
              {
                generationId: ids.failedGeneration,
                state: "failed",
                runtimePlanDigest: plan3,
              },
            ]
          : [],
      );
    },
    issueCompatibilityCertificate(input) {
      if (input.targetReleaseId === ids.release3) {
        throw new RuntimeCompatibilityError("RUNTIME_GENERATION_INCOMPATIBLE");
      }
      const targetPlan = input.targetReleaseId === ids.release1 ? plan1 : plan2;
      return Promise.resolve(certificate(input.targetReleaseId, targetPlan));
    },
  };
}

function target(
  releaseId: string,
  releaseState: "published" | "superseded",
  runtimePlanDigest: ArtifactDigest,
) {
  return {
    releaseId,
    releaseState,
    snapshotGroupCompatible: true,
    members: [{ memberKey: "object:Customer", runtimePlanDigest }],
  } as const;
}

function certificate(targetReleaseId: string, runtimePlanDigest: ArtifactDigest) {
  return parseCompatibilityCertificate({
    schemaVersion: 1,
    contractVersion: "generation-compatibility-v1",
    issuer: "materialization-compatibility-verifier",
    certificateId:
      targetReleaseId === ids.release1
        ? "20000000-0000-4000-8000-000000000021"
        : "20000000-0000-4000-8000-000000000022",
    projectId: ids.project,
    generationId: ids.generation,
    generationDigest: digest("a"),
    targetReleaseId,
    targetMemberKey: "object:Customer",
    targetRevisionId: ids.targetRevision,
    snapshotGroupId: ids.group,
    groupVersion: 7,
    snapshotSchemaRevisionId: ids.schemaRevision,
    snapshotSchemaDigest: digest("b"),
    mappingRevisionId: ids.mappingRevision,
    mappingDigest: digest("c"),
    indexPlanDigest: digest("d"),
    runtimePlanDigest,
    decision: targetReleaseId === ids.release1 ? "exact_pin" : "projection_equivalent",
    validatorVersion: "materialization-compatibility-g2-02-10-v1",
    evidenceDigest: digest("e"),
    issuedAt: "2026-08-16T00:00:00.000000Z",
    certificateDigest: digest("f"),
  });
}

function digest(character: string): ArtifactDigest {
  return `sha256:${character.repeat(64)}` as ArtifactDigest;
}
