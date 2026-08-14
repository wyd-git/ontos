import { runFoundationContractChecks } from "./check-foundation.ts";
import { runMetadataContractChecks } from "./check-metadata.ts";

const [foundation, metadata] = await Promise.all([
  runFoundationContractChecks(process.cwd()),
  runMetadataContractChecks(process.cwd()),
]);
console.log(
  `contracts: PASS (${foundation.foundationContractCount} foundation, ${metadata.metadataContractCount} metadata, ${foundation.errorCodeCount} stable error codes, ${foundation.goldenCaseCount + metadata.goldenCaseCount} golden cases)`,
);
