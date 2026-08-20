import type { ArtifactDigest, PolicyActorAttributeSchema } from "@ontos/contracts";
import {
  POLICY_COMPILER_VERSION,
  compilePolicy,
  type CompiledPolicyResult,
  type PolicyCompilerTargetSnapshot,
  type PolicyTextDigester,
} from "@ontos/policy-domain";

export * from "./gateway.ts";

export type PolicyApplicationErrorCode = "INVALID_INPUT" | "STORAGE_FAILURE";

export class PolicyApplicationError extends Error {
  readonly code: PolicyApplicationErrorCode;

  constructor(code: PolicyApplicationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PolicyApplicationError";
    this.code = code;
  }
}

export interface PolicyCompilationInputSnapshot {
  readonly projectId: string;
  readonly releaseId: string;
  readonly policyResourceId: string;
  readonly policyRevisionId: string;
  readonly policyContentDigest: ArtifactDigest;
  readonly definition: unknown;
  readonly releaseRevisionIds: readonly string[];
  readonly targets: readonly PolicyCompilerTargetSnapshot[];
  readonly trustedActorAttributes: readonly PolicyActorAttributeSchema[];
}

export interface PolicyCompilationSource {
  loadCompilationInput(input: {
    readonly projectId: string;
    readonly releaseId: string;
    readonly policyRevisionId: string;
  }): Promise<PolicyCompilationInputSnapshot>;
}

export type PolicyArtifactKind = "ir" | "test";

export interface PolicyArtifactStore {
  putArtifact(input: {
    readonly kind: PolicyArtifactKind;
    readonly digest: ArtifactDigest;
    readonly canonicalBytes: string;
  }): Promise<void>;
  readArtifact(input: {
    readonly kind: PolicyArtifactKind;
    readonly digest: ArtifactDigest;
  }): Promise<string>;
}

export interface PolicyCompilationRecorder {
  recordCompilation(input: {
    readonly projectId: string;
    readonly policyCompilationId: string;
    readonly releaseId: string;
    readonly policyResourceId: string;
    readonly policyRevisionId: string;
    readonly policyContentDigest: ArtifactDigest;
    readonly compilerVersion: typeof POLICY_COMPILER_VERSION;
    readonly artifactReferenceId: string;
    readonly artifactDigest: ArtifactDigest;
    readonly testReportReferenceId: string;
    readonly testReportDigest: ArtifactDigest;
    readonly testVectorCount: number;
    readonly passedVectorCount: number;
    readonly failedVectorCount: number;
    readonly status: "passed" | "failed";
  }): Promise<void>;
}

export interface PolicyCompilationApplicationOptions {
  readonly source: PolicyCompilationSource;
  readonly artifacts: PolicyArtifactStore;
  readonly recorder: PolicyCompilationRecorder;
  readonly digest: PolicyTextDigester;
  readonly uuid: () => string;
}

export class PolicyCompilationApplicationService {
  readonly #source: PolicyCompilationSource;
  readonly #artifacts: PolicyArtifactStore;
  readonly #recorder: PolicyCompilationRecorder;
  readonly #digest: PolicyTextDigester;
  readonly #uuid: () => string;

  constructor(options: PolicyCompilationApplicationOptions) {
    this.#source = options.source;
    this.#artifacts = options.artifacts;
    this.#recorder = options.recorder;
    this.#digest = options.digest;
    this.#uuid = options.uuid;
  }

  async compileReleasePolicy(input: {
    readonly projectId: string;
    readonly releaseId: string;
    readonly policyRevisionId: string;
  }): Promise<CompiledPolicyResult> {
    let snapshot: PolicyCompilationInputSnapshot;
    try {
      snapshot = await this.#source.loadCompilationInput(input);
    } catch (error) {
      if (error instanceof PolicyApplicationError) throw error;
      throw new PolicyApplicationError("STORAGE_FAILURE", "Policy source is unavailable.", {
        cause: error,
      });
    }
    if (
      snapshot.projectId !== input.projectId ||
      snapshot.releaseId !== input.releaseId ||
      snapshot.policyRevisionId !== input.policyRevisionId
    ) {
      throw new PolicyApplicationError(
        "STORAGE_FAILURE",
        "Policy compilation input identity is inconsistent.",
      );
    }

    let compiled: CompiledPolicyResult;
    try {
      compiled = compilePolicy({
        projectId: snapshot.projectId,
        releaseId: snapshot.releaseId,
        policyRevisionId: snapshot.policyRevisionId,
        definition: snapshot.definition,
        releaseRevisionIds: snapshot.releaseRevisionIds,
        targets: snapshot.targets,
        trustedActorAttributes: snapshot.trustedActorAttributes,
        digest: this.#digest,
      });
    } catch (error) {
      throw new PolicyApplicationError("INVALID_INPUT", "Policy compilation failed closed.", {
        cause: error,
      });
    }

    try {
      await this.#artifacts.putArtifact({
        kind: "ir",
        digest: compiled.artifactDigest,
        canonicalBytes: compiled.artifactBytes,
      });
      await this.#artifacts.putArtifact({
        kind: "test",
        digest: compiled.testReportDigest,
        canonicalBytes: compiled.testReportBytes,
      });
      await this.#recorder.recordCompilation({
        projectId: snapshot.projectId,
        policyCompilationId: this.#uuid(),
        releaseId: snapshot.releaseId,
        policyResourceId: snapshot.policyResourceId,
        policyRevisionId: snapshot.policyRevisionId,
        policyContentDigest: snapshot.policyContentDigest,
        compilerVersion: POLICY_COMPILER_VERSION,
        artifactReferenceId: this.#uuid(),
        artifactDigest: compiled.artifactDigest,
        testReportReferenceId: this.#uuid(),
        testReportDigest: compiled.testReportDigest,
        testVectorCount: compiled.testReport.vectorCount,
        passedVectorCount: compiled.testReport.passedVectorCount,
        failedVectorCount: compiled.testReport.failedVectorCount,
        status: compiled.testReport.status,
      });
      return compiled;
    } catch (error) {
      if (error instanceof PolicyApplicationError) throw error;
      throw new PolicyApplicationError(
        "STORAGE_FAILURE",
        "Policy output persistence failed closed.",
        {
          cause: error,
        },
      );
    }
  }
}
