import { createHash } from "node:crypto";

import { parseArtifactDigest } from "@ontos/contracts";
import {
  compileReleaseIndexPlan as compileProductionReleaseIndexPlan,
  type IndexBudgetPolicy,
  type ReleaseIndexPlanInput,
} from "@ontos/materialization-domain";

export * from "@ontos/materialization-domain";

export function compileReleaseIndexPlan(input: ReleaseIndexPlanInput, policy?: IndexBudgetPolicy) {
  return compileProductionReleaseIndexPlan(
    input,
    (value) =>
      parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`),
    policy,
  );
}
