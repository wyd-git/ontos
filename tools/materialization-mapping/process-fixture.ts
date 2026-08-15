import { createMappingExecution, type MappingRowEvent } from "@ontos/materialization-domain";

import { compileObjectFixture, digestCanonicalText, validObjectRow } from "./fixtures.ts";

const events: MappingRowEvent[] = [];
const execution = createMappingExecution({
  plan: compileObjectFixture(),
  sourceContentDigest: digestCanonicalText("cross-process-mapping-fixture"),
  digestCanonicalText,
  sink: {
    write(event) {
      events.push(event);
    },
  },
});

for (const [index, values] of [
  validObjectRow("Cafe\u0301"),
  validObjectRow("CAFÉ"),
  validObjectRow("customer-界"),
].entries()) {
  await execution.consumeRow({ rowNumber: index + 1, values });
}

process.stdout.write(
  JSON.stringify({ plan: compileObjectFixture(), events, summary: execution.finish() }),
);
