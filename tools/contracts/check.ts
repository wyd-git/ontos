import { runFoundationContractChecks } from "./check-foundation.ts";
import { runMaterializationContractChecks } from "./check-materialization.ts";
import { runMetadataContractChecks } from "./check-metadata.ts";

const [foundation, metadata, materialization] = await Promise.all([
  runFoundationContractChecks(process.cwd()),
  runMetadataContractChecks(process.cwd()),
  runMaterializationContractChecks(process.cwd()),
]);
console.log(
  `contracts: PASS (${foundation.foundationContractCount} foundation, ${metadata.metadataContractCount} metadata, ${materialization.materializationContractCount} materialization, ${foundation.errorCodeCount} stable API error codes, ${materialization.stableOperationErrorCodeCount} materialization operation errors, ${materialization.stableReasonCodeCount} materialization reason codes, ${foundation.goldenCaseCount + metadata.goldenCaseCount + materialization.goldenCaseCount} golden cases)`,
);
