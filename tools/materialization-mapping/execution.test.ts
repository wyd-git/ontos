import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compileMapping,
  createMappingExecution,
  executeManagedCsvMapping,
  MappingExecutionError,
  type MappingRowEvent,
} from "@ontos/materialization-domain";

import {
  compileLinkFixture,
  compileObjectFixture,
  definitionDigest,
  digestCanonicalText,
  ids,
  objectSchema,
  objectCompileInput,
  objectMapping,
  validObjectRow,
} from "./fixtures.ts";

const sourceContentDigest = digestCanonicalText("mapping-execution-fixture");

void describe("deterministic Mapping execution", () => {
  void it("canonicalizes every supported target value and Object identity", async () => {
    const { events, summary } = await executeRows([validObjectRow("customer-é")]);

    assert.equal(summary.sourceRowCount, 1);
    assert.equal(summary.acceptedRowCount, 1);
    assert.equal(summary.rejectedRowCount, 0);
    assert.deepEqual(summary.errorAggregates, []);

    const event = events[0];
    assert.equal(event?.kind, "object");
    if (event?.kind !== "object") return;
    assert.equal(event.targetResourceId, ids.objectResource);
    assert.equal(event.targetRevisionId, ids.objectRevision);
    assert.equal(event.canonicalPrimaryKey, "pk1|1|s11#CUSTOMER-É");
    assert.deepEqual(propertyValues(event), {
      amount: "123.40",
      count: "9223372036854775807",
      createdDate: "2024-02-29",
      displayName: "Ada Lovelace",
      enabled: true,
      eventAt: "2026-08-15T12:01:02.123456Z",
      id: "customer-é",
      payload: { kind: "canonical_json", canonicalJson: '{"a":1.5,"b":2}' },
      secret: "classified",
      status: "ACTIVE",
      tags: ["alpha", "界"],
    });
    assert.deepEqual(
      event.properties.map(({ propertyApiName }) => propertyApiName),
      [
        "amount",
        "count",
        "createdDate",
        "displayName",
        "enabled",
        "eventAt",
        "id",
        "payload",
        "secret",
        "status",
        "tags",
      ],
    );
  });

  void it("keeps null and concat semantics explicit", async () => {
    const row = [...validObjectRow()];
    row[1] = "";
    row[3] = "";
    row[8] = "";
    row[10] = "";
    const { events } = await executeRows([row]);

    const event = events[0];
    assert.equal(event?.kind, "rejected");
    if (event?.kind !== "rejected") return;
    assert.deepEqual(event.errors, [
      {
        reasonCode: "REQUIRED_PROPERTY_INVALID",
        mappingCode: "MAPPING_SOURCE_REQUIRED_NULL",
        columnApiName: "firstName",
      },
    ]);
  });

  void it('keeps constant "" distinct from a blank CSV field interpreted as null', async () => {
    const mapping = {
      ...objectMapping,
      propertyMappings: objectMapping.propertyMappings.map((property) =>
        property.propertyApiName === "secret"
          ? { ...property, expression: { op: "constant", literal: "" } }
          : property,
      ),
    };
    const plan = compileMapping(
      objectCompileInput({
        mapping,
        mappingRevisionDigest: definitionDigest(mapping),
      }),
      digestCanonicalText,
    );
    const row = [...validObjectRow()];
    row[11] = "";
    const events: MappingRowEvent[] = [];
    const execution = createMappingExecution({
      plan,
      sourceContentDigest,
      digestCanonicalText,
      sink: {
        write(event) {
          events.push(event);
        },
      },
    });
    await execution.consumeRow({ rowNumber: 1, values: row });
    execution.finish();

    const event = events[0];
    assert.equal(event?.kind, "object");
    if (event?.kind === "object") assert.equal(propertyValues(event).secret, "");
  });

  void it("redacts values, full Primary Keys, and sensitive/key column names from failures", async () => {
    const sensitiveValue = "do-not-leak-secret-value";
    const fullPrimaryKey = "do-not-leak-full-primary-key";
    const invalid = [...validObjectRow(fullPrimaryKey)];
    invalid[4] = "not-an-int64";
    invalid[11] = sensitiveValue;
    const oversizedKey = [...validObjectRow("x".repeat(1_013))];

    const { events, summary } = await executeRows([invalid, oversizedKey]);
    assert.equal(summary.rejectedRowCount, 2);
    assert.equal(events[0]?.kind, "rejected");
    assert.equal(events[1]?.kind, "rejected");
    const serialized = JSON.stringify({ events, summary });
    assert.doesNotMatch(serialized, /do-not-leak|sensitiveCode|"id"/u);
    assert.match(serialized, /MAPPING_SOURCE_VALUE_INVALID/u);
    assert.match(serialized, /MAPPING_PRIMARY_KEY_INVALID/u);
    assert.match(serialized, /PRIMARY_KEY_TOO_LARGE/u);
  });

  void it("produces byte-identical ordered events and digests for identical runs", async () => {
    const rows = [
      validObjectRow("collision"),
      validObjectRow("COLLISION"),
      validObjectRow("Cafe\u0301"),
      validObjectRow("CAFÉ"),
    ];
    const first = await executeRows(rows);
    const second = await executeRows(rows.map((row) => [...row]));

    assert.equal(JSON.stringify(second.events), JSON.stringify(first.events));
    assert.equal(JSON.stringify(second.summary), JSON.stringify(first.summary));
    assert.equal(first.summary.mappedStreamDigest, second.summary.mappedStreamDigest);
    assert.equal(first.events[0]?.kind, "object");
    assert.equal(first.events[1]?.kind, "object");
    if (first.events[0]?.kind === "object" && first.events[1]?.kind === "object") {
      assert.equal(first.events[0].canonicalPrimaryKey, first.events[1].canonicalPrimaryKey);
    }
    if (first.events[2]?.kind === "object" && first.events[3]?.kind === "object") {
      assert.equal(first.events[2].canonicalPrimaryKey, first.events[3].canonicalPrimaryKey);
    }
  });

  void it("emits controlled Link identity candidates without display or API-name identity", async () => {
    const plan = compileLinkFixture();
    const events: MappingRowEvent[] = [];
    const execution = createMappingExecution({
      plan,
      sourceContentDigest,
      digestCanonicalText,
      sink: {
        write(event) {
          events.push(event);
        },
      },
    });
    await execution.consumeRow({ rowNumber: 1, values: ["customer-é", "Order-7"] });
    const summary = execution.finish();

    assert.equal(summary.acceptedRowCount, 1);
    const event = events[0];
    assert.equal(event?.kind, "link");
    if (event?.kind !== "link") return;
    assert.deepEqual(event.sourceLookup, {
      objectTypeResourceId: ids.objectResource,
      objectTypeRevisionId: ids.objectRevision,
      canonicalPrimaryKey: "pk1|1|s11#CUSTOMER-É",
      sourceColumnApiNames: ["customerId"],
    });
    assert.deepEqual(event.targetLookup, {
      objectTypeResourceId: ids.orderResource,
      objectTypeRevisionId: ids.orderRevision,
      canonicalPrimaryKey: "pk1|1|s7#Order-7",
      sourceColumnApiNames: ["orderId"],
    });
    assert.doesNotMatch(JSON.stringify(event), /CustomerOrder|Customer Order|"apiName"/u);
  });

  void it("streams managed CSV rows with sink backpressure", async () => {
    const plan = compileObjectFixture();
    const events: MappingRowEvent[] = [];
    let writes = 0;
    const csv = `${objectSchema.columns.map(({ columnApiName }) => columnApiName).join(",")}\n${csvRow(
      validObjectRow(),
    )}\n`;
    const result = await executeManagedCsvMapping({
      plan,
      sourceContentDigest: digestCanonicalText(csv),
      source: byteChunks(csv, 7),
      digestCanonicalText,
      sink: {
        async write(event) {
          await Promise.resolve();
          writes += 1;
          events.push(event);
        },
      },
    });

    assert.equal(writes, 1);
    assert.equal(events[0]?.kind, "object");
    assert.deepEqual(result.scan, {
      byteCount: Buffer.byteLength(csv),
      rowCount: 1,
      columnCount: 12,
      bom: false,
    });
    assert.equal(result.acceptedRowCount, 1);
  });

  void it("fails closed and becomes terminal when the downstream sink rejects", async () => {
    const execution = createMappingExecution({
      plan: compileObjectFixture(),
      sourceContentDigest,
      digestCanonicalText,
      sink: {
        write() {
          throw new Error("do-not-leak-sink-detail");
        },
      },
    });
    await assert.rejects(
      execution.consumeRow({ rowNumber: 1, values: validObjectRow() }),
      (error: unknown) => {
        assert.ok(error instanceof MappingExecutionError);
        assert.equal(error.code, "MAPPING_EVENT_SINK_FAILED");
        assert.doesNotMatch(error.message, /do-not-leak/u);
        return true;
      },
    );
    await assert.rejects(
      execution.consumeRow({ rowNumber: 2, values: validObjectRow("customer-2") }),
      (error: unknown) =>
        error instanceof MappingExecutionError &&
        error.code === "MAPPING_EXECUTION_ALREADY_FINISHED",
    );
    assert.throws(
      () => execution.finish(),
      (error: unknown) =>
        error instanceof MappingExecutionError &&
        error.code === "MAPPING_EXECUTION_ALREADY_FINISHED",
    );
  });

  void it("accepts the exact 1,024-byte canonical Primary Key boundary", async () => {
    const accepted = await executeRows([validObjectRow("a".repeat(1_012))]);
    const rejected = await executeRows([validObjectRow("a".repeat(1_013))]);

    assert.equal(accepted.events[0]?.kind, "object");
    if (accepted.events[0]?.kind === "object") {
      assert.equal(Buffer.byteLength(accepted.events[0].canonicalPrimaryKey), 1_024);
    }
    assert.equal(rejected.events[0]?.kind, "rejected");
  });
});

async function executeRows(rows: readonly (readonly string[])[]) {
  const events: MappingRowEvent[] = [];
  const execution = createMappingExecution({
    plan: compileObjectFixture(),
    sourceContentDigest,
    digestCanonicalText,
    sink: {
      write(event) {
        events.push(event);
      },
    },
  });
  for (const [index, values] of rows.entries()) {
    await execution.consumeRow({ rowNumber: index + 1, values });
  }
  return { events, summary: execution.finish() };
}

function propertyValues(
  event: Extract<MappingRowEvent, { readonly kind: "object" }>,
): Record<string, unknown> {
  return Object.fromEntries(
    event.properties.map(({ propertyApiName, value }) => [propertyApiName, value]),
  );
}

function csvRow(values: readonly string[]): string {
  return values.map((value) => `"${value.replaceAll('"', '""')}"`).join(",");
}

async function* byteChunks(value: string, chunkBytes: number): AsyncIterable<Uint8Array> {
  const bytes = Buffer.from(value, "utf8");
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    await Promise.resolve();
    yield bytes.subarray(offset, offset + chunkBytes);
  }
}
