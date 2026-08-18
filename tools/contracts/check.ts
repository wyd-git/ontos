import { runFoundationContractChecks } from "./check-foundation.ts";
import { runMaterializationContractChecks } from "./check-materialization.ts";
import { runMetadataContractChecks } from "./check-metadata.ts";
import { runRuntimeReadContractChecks } from "./check-runtime-read.ts";

const [foundation, metadata, materialization, runtimeRead] = await Promise.all([
  runFoundationContractChecks(process.cwd()),
  runMetadataContractChecks(process.cwd()),
  runMaterializationContractChecks(process.cwd()),
  runRuntimeReadContractChecks(process.cwd()),
]);
console.log(
  `contracts: PASS (${foundation.foundationContractCount} foundation, ${metadata.metadataContractCount} metadata, ${materialization.materializationContractCount} materialization, ${runtimeRead.runtimeReadContractCount} runtime read, ${foundation.errorCodeCount} stable API error codes, ${materialization.stableOperationErrorCodeCount} materialization operation errors, ${materialization.stableReasonCodeCount} materialization reason codes, ${foundation.goldenCaseCount + metadata.goldenCaseCount + materialization.goldenCaseCount + runtimeRead.goldenCaseCount} golden cases)`,
);
