import { runFoundationContractChecks } from "./check-foundation.ts";

const result = await runFoundationContractChecks(process.cwd());
console.log(
  `contracts: PASS (${result.foundationContractCount} foundation, ${result.errorCodeCount} stable error codes, ${result.deferredFamilyCount} deferred families, ${result.goldenCaseCount} golden cases)`,
);
