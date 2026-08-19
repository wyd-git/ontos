import { compilePolicy } from "@ontos/policy-domain";

import { compileInput } from "./fixtures.ts";

const compiled = compilePolicy(compileInput());
process.stdout.write(
  `${compiled.artifactDigest}\n${compiled.artifactBytes}\n${compiled.testReportDigest}\n`,
);
