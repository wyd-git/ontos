import {
  createMappingExecution,
  type CanonicalTextDigester,
  type CompiledMappingPlan,
  type MappingErrorAggregate,
  type MappingEventSink,
  type MappingExecutionSummary,
} from "./mapping.ts";

export * from "./mapping.ts";
export * from "./index-plan.ts";
export * from "./projection-baseline.ts";
export * from "./projection-capacity.ts";
export * from "./runtime-plan.ts";

export const MANAGED_CSV_HARD_LIMITS = Object.freeze({
  maximumFileBytes: 512 * 1024 * 1024,
  maximumRows: 10_000_000,
  maximumColumns: 512,
  maximumFieldBytes: 1024 * 1024,
  maximumRecordBytes: 8 * 1024 * 1024,
  maximumHeaderFieldBytes: 128,
  maximumSourceLabelBytes: 128,
});

export interface ManagedCsvScanLimits {
  readonly maximumFileBytes: number;
  readonly maximumRows: number;
  readonly maximumColumns: number;
  readonly maximumFieldBytes: number;
  readonly maximumRecordBytes: number;
  readonly maximumHeaderFieldBytes: number;
}

export interface ManagedCsvScanResult {
  readonly byteCount: number;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly bom: boolean;
}

export interface ManagedCsvRow {
  readonly rowNumber: number;
  readonly values: readonly string[];
}

export type ManagedCsvRowConsumer = (row: ManagedCsvRow) => void | Promise<void>;

export type ManagedCsvErrorCode =
  | "CSV_EMPTY"
  | "CSV_UTF8_INVALID"
  | "CSV_NUL_BYTE"
  | "CSV_UNSUPPORTED_SIGNATURE"
  | "CSV_QUOTE_INVALID"
  | "CSV_TRUNCATED_QUOTE"
  | "CSV_BARE_CR"
  | "CSV_HEADER_DUPLICATE"
  | "CSV_HEADER_MISMATCH"
  | "CSV_COLUMN_COUNT_MISMATCH"
  | "CSV_FILE_LIMIT_EXCEEDED"
  | "CSV_ROW_LIMIT_EXCEEDED"
  | "CSV_COLUMN_LIMIT_EXCEEDED"
  | "CSV_FIELD_LIMIT_EXCEEDED"
  | "CSV_RECORD_LIMIT_EXCEEDED";

const errorMessages = Object.freeze({
  CSV_EMPTY: "The managed CSV does not contain a Header record.",
  CSV_UTF8_INVALID: "The managed CSV is not valid UTF-8.",
  CSV_NUL_BYTE: "The managed CSV contains a forbidden NUL byte.",
  CSV_UNSUPPORTED_SIGNATURE: "The uploaded object is not an uncompressed CSV file.",
  CSV_QUOTE_INVALID: "The managed CSV contains invalid quote placement.",
  CSV_TRUNCATED_QUOTE: "The managed CSV ends inside a quoted field.",
  CSV_BARE_CR: "The managed CSV contains a bare carriage return.",
  CSV_HEADER_DUPLICATE: "The managed CSV Header contains a duplicate name.",
  CSV_HEADER_MISMATCH: "The managed CSV Header does not match the explicit Schema.",
  CSV_COLUMN_COUNT_MISMATCH: "A managed CSV record has the wrong column count.",
  CSV_FILE_LIMIT_EXCEEDED: "The managed CSV exceeds the file-byte limit.",
  CSV_ROW_LIMIT_EXCEEDED: "The managed CSV exceeds the record-count limit.",
  CSV_COLUMN_LIMIT_EXCEEDED: "The managed CSV exceeds the column-count limit.",
  CSV_FIELD_LIMIT_EXCEEDED: "A managed CSV field exceeds its byte limit.",
  CSV_RECORD_LIMIT_EXCEEDED: "A managed CSV record exceeds its byte limit.",
} satisfies Readonly<Record<ManagedCsvErrorCode, string>>);

export class ManagedCsvError extends Error {
  readonly code: ManagedCsvErrorCode;
  readonly rowNumber: number | null;
  readonly columnNumber: number | null;

  constructor(
    code: ManagedCsvErrorCode,
    position: {
      readonly rowNumber?: number;
      readonly columnNumber?: number;
    } = {},
    options?: ErrorOptions,
  ) {
    super(errorMessages[code], options);
    this.name = "ManagedCsvError";
    this.code = code;
    this.rowNumber = position.rowNumber ?? null;
    this.columnNumber = position.columnNumber ?? null;
  }
}

type CsvState = "field_start" | "unquoted" | "quoted" | "after_quote";

const comma = 0x2c;
const quote = 0x22;
const carriageReturn = 0x0d;
const lineFeed = 0x0a;
const nul = 0x00;
const utf8Bom = Object.freeze([0xef, 0xbb, 0xbf]);

export async function scanManagedCsv(
  source: AsyncIterable<Uint8Array>,
  expectedHeaderInput: readonly string[],
  limitOverrides: Partial<ManagedCsvScanLimits> = {},
): Promise<ManagedCsvScanResult> {
  return scanManagedCsvRows(source, expectedHeaderInput, undefined, limitOverrides);
}

export async function scanManagedCsvRows(
  source: AsyncIterable<Uint8Array>,
  expectedHeaderInput: readonly string[],
  consumeRow: ManagedCsvRowConsumer | undefined,
  limitOverrides: Partial<ManagedCsvScanLimits> = {},
): Promise<ManagedCsvScanResult> {
  const limits = parseLimits(limitOverrides);
  const expectedHeader = parseExpectedHeader(expectedHeaderInput, limits);
  const scanner = new ManagedCsvScanner(expectedHeader, limits, consumeRow);
  await scanner.consume(source);
  return scanner.result();
}

export interface ExecuteManagedCsvMappingInput {
  readonly plan: CompiledMappingPlan;
  readonly sourceContentDigest: unknown;
  readonly source: AsyncIterable<Uint8Array>;
  readonly digestCanonicalText: CanonicalTextDigester;
  readonly sink?: MappingEventSink;
  readonly limits?: Partial<ManagedCsvScanLimits>;
}

export interface ManagedCsvMappingExecutionResult extends MappingExecutionSummary {
  readonly scan: ManagedCsvScanResult;
  readonly errorAggregates: readonly MappingErrorAggregate[];
}

export async function executeManagedCsvMapping(
  input: ExecuteManagedCsvMappingInput,
): Promise<ManagedCsvMappingExecutionResult> {
  const execution = createMappingExecution({
    plan: input.plan,
    sourceContentDigest: input.sourceContentDigest,
    digestCanonicalText: input.digestCanonicalText,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  const scan = await scanManagedCsvRows(
    input.source,
    input.plan.columns.map((column) => column.columnApiName),
    (row) => execution.consumeRow(row),
    input.limits ?? {},
  );
  const summary = execution.finish();
  return Object.freeze({ ...summary, scan });
}

export function parseManagedCsvMediaType(value: unknown): "text/csv" {
  if (
    typeof value !== "string" ||
    !/^text\/csv(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/iu.test(value.trim())
  ) {
    throw new TypeError("Managed Snapshot media type must be UTF-8 text/csv.");
  }
  return "text/csv";
}

export function parseManagedSourceLabel(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.isWellFormed() ||
    /[\p{Cc}/\\]/u.test(value) ||
    new TextEncoder().encode(value).byteLength > MANAGED_CSV_HARD_LIMITS.maximumSourceLabelBytes
  ) {
    throw new TypeError("Managed Snapshot source label is invalid.");
  }
  return value;
}

class ManagedCsvScanner {
  readonly #expectedHeader: readonly string[];
  readonly #limits: ManagedCsvScanLimits;
  readonly #consumeRow: ManagedCsvRowConsumer | undefined;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  readonly #prefix: number[] = [];
  readonly #headerFields: string[] = [];
  readonly #recordFields: string[] = [];
  readonly #fieldValueBytes: number[] = [];

  #prefixDecided = false;
  #bom = false;
  #byteCount = 0;
  #rowCount = 0;
  #recordIndex = 0;
  #fieldIndex = 0;
  #recordBytes = 0;
  #fieldBytes = 0;
  #recordHasBytes = false;
  #pendingCarriageReturn = false;
  #state: CsvState = "field_start";

  constructor(
    expectedHeader: readonly string[],
    limits: ManagedCsvScanLimits,
    consumeRow: ManagedCsvRowConsumer | undefined,
  ) {
    this.#expectedHeader = expectedHeader;
    this.#limits = limits;
    this.#consumeRow = consumeRow;
  }

  async consume(source: AsyncIterable<Uint8Array>): Promise<void> {
    try {
      for await (const candidate of source) {
        if (!(candidate instanceof Uint8Array)) {
          throw new TypeError("Managed CSV source yielded a non-byte chunk.");
        }
        if (candidate.byteLength === 0) continue;
        this.#byteCount += candidate.byteLength;
        if (this.#byteCount > this.#limits.maximumFileBytes) {
          this.#fail("CSV_FILE_LIMIT_EXCEEDED");
        }
        await this.#consumeChunk(candidate);
      }
      this.#decoder.decode();
      if (!this.#prefixDecided) await this.#decidePrefix();
      if (this.#pendingCarriageReturn) this.#fail("CSV_BARE_CR");
      if (this.#state === "quoted") this.#fail("CSV_TRUNCATED_QUOTE");
      if (this.#recordHasBytes) {
        const row = this.#finishRecord();
        if (row !== null) await this.#emitRow(row);
      }
      if (this.#recordIndex === 0) this.#fail("CSV_EMPTY");
    } catch (error) {
      if (error instanceof ManagedCsvRowConsumerFailure) throw error.cause;
      if (error instanceof ManagedCsvError || error instanceof TypeError) {
        if (
          error instanceof TypeError &&
          error.message === "Managed CSV source yielded a non-byte chunk."
        ) {
          throw error;
        }
        if (error instanceof ManagedCsvError) throw error;
        throw new ManagedCsvError("CSV_UTF8_INVALID", {}, { cause: error });
      }
      throw error;
    }
  }

  result(): ManagedCsvScanResult {
    return Object.freeze({
      byteCount: this.#byteCount,
      rowCount: this.#rowCount,
      columnCount: this.#expectedHeader.length,
      bom: this.#bom,
    });
  }

  async #consumeChunk(chunk: Uint8Array): Promise<void> {
    let offset = 0;
    if (!this.#prefixDecided) {
      while (offset < chunk.byteLength && this.#prefix.length < 4) {
        this.#prefix.push(chunk[offset] ?? 0);
        offset += 1;
      }
      if (this.#prefix.length === 4) await this.#decidePrefix();
    }
    if (this.#prefixDecided && offset < chunk.byteLength) {
      const remainder = chunk.subarray(offset);
      this.#decoder.decode(remainder, { stream: true });
      await this.#consumeBytes(remainder);
    }
  }

  async #decidePrefix(): Promise<void> {
    if (this.#prefixDecided) return;
    this.#prefixDecided = true;
    if (
      (this.#prefix[0] === 0x1f && this.#prefix[1] === 0x8b) ||
      (this.#prefix[0] === 0x50 &&
        this.#prefix[1] === 0x4b &&
        this.#prefix[2] === 0x03 &&
        this.#prefix[3] === 0x04) ||
      (this.#prefix[0] === 0x50 &&
        this.#prefix[1] === 0x41 &&
        this.#prefix[2] === 0x52 &&
        this.#prefix[3] === 0x31)
    ) {
      this.#fail("CSV_UNSUPPORTED_SIGNATURE");
    }
    this.#bom = utf8Bom.every((byte, index) => this.#prefix[index] === byte);
    this.#decoder.decode(Uint8Array.from(this.#prefix), { stream: true });
    const firstCsvByte = this.#bom ? utf8Bom.length : 0;
    await this.#consumeBytes(Uint8Array.from(this.#prefix.slice(firstCsvByte)));
  }

  async #consumeBytes(bytes: Uint8Array): Promise<void> {
    for (const byte of bytes) {
      const row = this.#consumeByte(byte);
      if (row !== null) await this.#emitRow(row);
    }
  }

  #consumeByte(byte: number): ManagedCsvRow | null {
    if (byte === nul) this.#fail("CSV_NUL_BYTE");
    this.#recordHasBytes = true;
    this.#recordBytes += 1;
    if (this.#recordBytes > this.#limits.maximumRecordBytes) {
      this.#fail("CSV_RECORD_LIMIT_EXCEEDED");
    }

    if (this.#pendingCarriageReturn) {
      if (byte !== lineFeed) this.#fail("CSV_BARE_CR");
      this.#pendingCarriageReturn = false;
      return this.#finishRecord();
    }

    if (this.#state !== "quoted") {
      if (byte === carriageReturn) {
        this.#pendingCarriageReturn = true;
        return null;
      }
      if (byte === lineFeed) {
        return this.#finishRecord();
      }
    }

    switch (this.#state) {
      case "field_start":
        if (byte === comma) {
          this.#finishField();
        } else if (byte === quote) {
          this.#countFieldByte();
          this.#state = "quoted";
        } else {
          this.#countFieldByte();
          this.#appendFieldValueByte(byte);
          this.#state = "unquoted";
        }
        return null;
      case "unquoted":
        if (byte === comma) {
          this.#finishField();
        } else if (byte === quote) {
          this.#fail("CSV_QUOTE_INVALID");
        } else {
          this.#countFieldByte();
          this.#appendFieldValueByte(byte);
        }
        return null;
      case "quoted":
        this.#countFieldByte();
        if (byte === quote) this.#state = "after_quote";
        else this.#appendFieldValueByte(byte);
        return null;
      case "after_quote":
        if (byte === quote) {
          this.#countFieldByte();
          this.#appendFieldValueByte(quote);
          this.#state = "quoted";
        } else if (byte === comma) {
          this.#finishField();
        } else {
          this.#fail("CSV_QUOTE_INVALID");
        }
        return null;
    }
  }

  #countFieldByte(): void {
    this.#fieldBytes += 1;
    if (this.#fieldBytes > this.#limits.maximumFieldBytes) {
      this.#fail("CSV_FIELD_LIMIT_EXCEEDED");
    }
  }

  #appendFieldValueByte(byte: number): void {
    this.#fieldValueBytes.push(byte);
    if (
      this.#recordIndex === 0 &&
      this.#fieldValueBytes.length > this.#limits.maximumHeaderFieldBytes
    ) {
      this.#fail("CSV_FIELD_LIMIT_EXCEEDED");
    }
  }

  #finishField(): void {
    this.#fieldIndex += 1;
    if (this.#fieldIndex > this.#limits.maximumColumns) {
      this.#fail("CSV_COLUMN_LIMIT_EXCEEDED");
    }
    const value = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(this.#fieldValueBytes),
    );
    if (this.#recordIndex === 0) this.#headerFields.push(value);
    else this.#recordFields.push(value);
    this.#fieldValueBytes.length = 0;
    this.#fieldBytes = 0;
    this.#state = "field_start";
  }

  #finishRecord(): ManagedCsvRow | null {
    this.#finishField();
    let row: ManagedCsvRow | null = null;
    if (this.#recordIndex === 0) {
      this.#validateHeader();
    } else {
      if (this.#fieldIndex !== this.#expectedHeader.length) {
        this.#fail("CSV_COLUMN_COUNT_MISMATCH");
      }
      this.#rowCount += 1;
      if (this.#rowCount > this.#limits.maximumRows) this.#fail("CSV_ROW_LIMIT_EXCEEDED");
      row = Object.freeze({
        rowNumber: this.#rowCount,
        values: Object.freeze([...this.#recordFields]),
      });
    }
    this.#recordIndex += 1;
    this.#recordFields.length = 0;
    this.#fieldIndex = 0;
    this.#recordBytes = 0;
    this.#fieldBytes = 0;
    this.#recordHasBytes = false;
    this.#state = "field_start";
    return row;
  }

  async #emitRow(row: ManagedCsvRow): Promise<void> {
    if (this.#consumeRow === undefined) return;
    try {
      await this.#consumeRow(row);
    } catch (error) {
      throw new ManagedCsvRowConsumerFailure(error);
    }
  }

  #validateHeader(): void {
    if (this.#headerFields.length !== this.#expectedHeader.length) {
      this.#fail("CSV_HEADER_MISMATCH");
    }
    if (new Set(this.#headerFields).size !== this.#headerFields.length) {
      this.#fail("CSV_HEADER_DUPLICATE");
    }
    for (let index = 0; index < this.#expectedHeader.length; index += 1) {
      if (this.#headerFields[index] !== this.#expectedHeader[index]) {
        this.#fail("CSV_HEADER_MISMATCH", index + 1);
      }
    }
  }

  #fail(code: ManagedCsvErrorCode, columnNumber = this.#fieldIndex + 1): never {
    throw new ManagedCsvError(code, {
      rowNumber: this.#recordIndex + 1,
      columnNumber,
    });
  }
}

class ManagedCsvRowConsumerFailure extends Error {
  constructor(cause: unknown) {
    super("Managed CSV row consumer failed.", { cause });
    this.name = "ManagedCsvRowConsumerFailure";
  }
}

function parseLimits(overrides: Partial<ManagedCsvScanLimits>): ManagedCsvScanLimits {
  const hard = MANAGED_CSV_HARD_LIMITS;
  return Object.freeze({
    maximumFileBytes: boundedLimit(
      overrides.maximumFileBytes,
      hard.maximumFileBytes,
      "maximumFileBytes",
    ),
    maximumRows: boundedLimit(overrides.maximumRows, hard.maximumRows, "maximumRows"),
    maximumColumns: boundedLimit(overrides.maximumColumns, hard.maximumColumns, "maximumColumns"),
    maximumFieldBytes: boundedLimit(
      overrides.maximumFieldBytes,
      hard.maximumFieldBytes,
      "maximumFieldBytes",
    ),
    maximumRecordBytes: boundedLimit(
      overrides.maximumRecordBytes,
      hard.maximumRecordBytes,
      "maximumRecordBytes",
    ),
    maximumHeaderFieldBytes: boundedLimit(
      overrides.maximumHeaderFieldBytes,
      hard.maximumHeaderFieldBytes,
      "maximumHeaderFieldBytes",
    ),
  });
}

function boundedLimit(value: number | undefined, hardMaximum: number, name: string): number {
  const candidate = value ?? hardMaximum;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > hardMaximum) {
    throw new RangeError(`${name} is outside the managed CSV hard envelope.`);
  }
  return candidate;
}

function parseExpectedHeader(
  value: readonly string[],
  limits: ManagedCsvScanLimits,
): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > limits.maximumColumns) {
    throw new RangeError("Expected managed CSV Header is outside the column envelope.");
  }
  const encoder = new TextEncoder();
  const result = value.map((name) => {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      !name.isWellFormed() ||
      encoder.encode(name).byteLength > limits.maximumHeaderFieldBytes
    ) {
      throw new TypeError("Expected managed CSV Header contains an invalid name.");
    }
    return name;
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError("Expected managed CSV Header contains duplicate names.");
  }
  return Object.freeze(result);
}
