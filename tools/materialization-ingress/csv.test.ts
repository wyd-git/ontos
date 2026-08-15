import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import {
  ManagedCsvError,
  parseManagedCsvMediaType,
  parseManagedSourceLabel,
  scanManagedCsv,
  type ManagedCsvErrorCode,
  type ManagedCsvScanLimits,
} from "@ontos/materialization-domain";

const encoder = new TextEncoder();

void describe("managed UTF-8 CSV physical scanner", () => {
  void it("streams BOM, CRLF, quoted newlines, commas and escaped quotes", async () => {
    const bytes = encoder.encode('\uFEFFid,note\r\n1,"hello,\r\nworld"\r\n2,"a""b"');
    const result = await scanManagedCsv(oneByteChunks(bytes), ["id", "note"]);
    assert.deepEqual(result, {
      byteCount: bytes.byteLength,
      rowCount: 2,
      columnCount: 2,
      bom: true,
    });
  });

  void it("accepts Header-only input and does not invent a row after a trailing newline", async () => {
    assert.equal((await scan("id,name\n", ["id", "name"])).rowCount, 0);
    assert.equal((await scan("id\n\n", ["id"])).rowCount, 1);
  });

  void it("accepts LF, CRLF and a final record without newline across arbitrary chunks", async () => {
    const bytes = encoder.encode("id,name\r\n1,A\n2,B");
    const result = await scanManagedCsv(chunks(bytes, [1, 2, 5, 3, 1]), ["id", "name"]);
    assert.equal(result.rowCount, 2);
  });

  void it("rejects duplicate or non-exact Headers without reflecting their content", async () => {
    await expectCsvError("id,id\n1,2", ["id", "name"], "CSV_HEADER_DUPLICATE");
    const error = await captureCsvError("id,privateSecret\n1,2", ["id", "name"]);
    assert.equal(error.code, "CSV_HEADER_MISMATCH");
    assert.doesNotMatch(error.message, /privateSecret/u);
  });

  void it("rejects malformed quoting, bare CR, NUL and truncation", async () => {
    await expectCsvError('id\nabc"def', ["id"], "CSV_QUOTE_INVALID");
    await expectCsvError('id\n"abc"tail', ["id"], "CSV_QUOTE_INVALID");
    await expectCsvError('id\n"abc', ["id"], "CSV_TRUNCATED_QUOTE");
    await expectCsvError("id\rvalue", ["id"], "CSV_BARE_CR");
    await expectCsvError(Uint8Array.from([0x69, 0x64, 0x0a, 0x00]), ["id"], "CSV_NUL_BYTE");
  });

  void it("rejects invalid UTF-8 and common compressed or Parquet signatures", async () => {
    await expectCsvError(
      Uint8Array.from([0x69, 0x64, 0x0a, 0xc3, 0x28]),
      ["id"],
      "CSV_UTF8_INVALID",
    );
    await expectCsvError(Uint8Array.from([0x1f, 0x8b, 0x08]), ["id"], "CSV_UNSUPPORTED_SIGNATURE");
    await expectCsvError(
      Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
      ["id"],
      "CSV_UNSUPPORTED_SIGNATURE",
    );
    await expectCsvError(
      Uint8Array.from([0x50, 0x41, 0x52, 0x31]),
      ["id"],
      "CSV_UNSUPPORTED_SIGNATURE",
    );
  });

  void it("rejects wrong data column counts", async () => {
    await expectCsvError("id,name\n1", ["id", "name"], "CSV_COLUMN_COUNT_MISMATCH");
    await expectCsvError("id,name\n1,A,extra", ["id", "name"], "CSV_COLUMN_COUNT_MISMATCH");
  });

  void it("enforces file, row, column, field, record and Header limits while streaming", async () => {
    await expectCsvError("id\n1", ["id"], "CSV_FILE_LIMIT_EXCEEDED", {
      maximumFileBytes: 3,
    });
    await expectCsvError("id\n1\n2", ["id"], "CSV_ROW_LIMIT_EXCEEDED", { maximumRows: 1 });
    await expectCsvError("a,b\n1,2", ["a"], "CSV_COLUMN_LIMIT_EXCEEDED", {
      maximumColumns: 1,
    });
    await expectCsvError("id\n1234", ["id"], "CSV_FIELD_LIMIT_EXCEEDED", {
      maximumFieldBytes: 3,
    });
    await expectCsvError("id\n1234", ["id"], "CSV_RECORD_LIMIT_EXCEEDED", {
      maximumRecordBytes: 3,
      maximumFieldBytes: 10,
    });
    await expectCsvError("long\n1", ["id"], "CSV_FIELD_LIMIT_EXCEEDED", {
      maximumHeaderFieldBytes: 3,
    });
  });

  void it("validates the media type and bounded non-path source label", () => {
    assert.equal(parseManagedCsvMediaType("text/csv; charset=UTF-8"), "text/csv");
    assert.equal(parseManagedCsvMediaType('text/csv; charset="utf-8"'), "text/csv");
    assert.throws(() => parseManagedCsvMediaType("application/x-gzip"), TypeError);
    assert.throws(() => parseManagedCsvMediaType("application/x-ndjson"), TypeError);
    assert.throws(() => parseManagedCsvMediaType("application/vnd.apache.parquet"), TypeError);
    assert.equal(parseManagedSourceLabel("Orders 2026-08-15"), "Orders 2026-08-15");
    assert.throws(() => parseManagedSourceLabel("../orders.csv"), TypeError);
    assert.throws(() => parseManagedSourceLabel("orders\\private"), TypeError);
    assert.throws(() => parseManagedSourceLabel("bad\u0000label"), TypeError);
    assert.throws(() => parseManagedSourceLabel("界".repeat(43)), TypeError);
  });
});

async function scan(text: string, header: readonly string[]) {
  const bytes = encoder.encode(text);
  return scanManagedCsv(chunks(bytes, [3, 1, 7]), header);
}

async function expectCsvError(
  input: string | Uint8Array,
  header: readonly string[],
  code: ManagedCsvErrorCode,
  limits: Partial<ManagedCsvScanLimits> = {},
): Promise<void> {
  const error = await captureCsvError(input, header, limits);
  assert.equal(error.code, code);
  if (error.rowNumber !== null) assert.ok(error.rowNumber >= 1);
  if (error.columnNumber !== null) assert.ok(error.columnNumber >= 1);
}

async function captureCsvError(
  input: string | Uint8Array,
  header: readonly string[],
  limits: Partial<ManagedCsvScanLimits> = {},
): Promise<ManagedCsvError> {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  try {
    await scanManagedCsv(oneByteChunks(bytes), header, limits);
  } catch (error) {
    assert.ok(error instanceof ManagedCsvError);
    return error;
  }
  throw new Error("Expected managed CSV scan to fail.");
}

function oneByteChunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return Readable.from(
    (function* () {
      for (let index = 0; index < bytes.byteLength; index += 1) {
        yield bytes.subarray(index, index + 1);
      }
    })(),
  );
}

function chunks(bytes: Uint8Array, sizes: readonly number[]): AsyncIterable<Uint8Array> {
  return Readable.from(
    (function* () {
      let offset = 0;
      let sizeIndex = 0;
      while (offset < bytes.byteLength) {
        const size = sizes[sizeIndex % sizes.length] ?? 1;
        yield bytes.subarray(offset, Math.min(offset + size, bytes.byteLength));
        offset += size;
        sizeIndex += 1;
      }
    })(),
  );
}
