export type ValueCodecErrorCode =
  | "DATE_INVALID"
  | "DECIMAL_FORMAT_INVALID"
  | "DECIMAL_SCHEMA_INVALID"
  | "DECIMAL_VALUE_OUT_OF_RANGE"
  | "ENUM_SCHEMA_INVALID"
  | "ENUM_VALUE_INVALID"
  | "INTEGER_FORMAT_INVALID"
  | "INTEGER_VALUE_OUT_OF_RANGE"
  | "JSON_VALUE_INVALID"
  | "PRIMARY_KEY_COLLISION"
  | "PRIMARY_KEY_INVALID"
  | "PRIMARY_KEY_TOO_LARGE"
  | "STRING_ARRAY_TOO_LARGE"
  | "STRING_INVALID"
  | "STRING_TOO_LARGE"
  | "TIMESTAMP_INVALID"
  | "UUID_INVALID"
  | "VALUE_TYPE_MISMATCH";

export class ValueCodecError extends Error {
  readonly code: ValueCodecErrorCode;
  readonly path: string;

  constructor(code: ValueCodecErrorCode, message: string, path = "$value") {
    super(message);
    this.name = "ValueCodecError";
    this.code = code;
    this.path = path;
  }
}

export function fail(code: ValueCodecErrorCode, message: string, path?: string): never {
  throw new ValueCodecError(code, message, path);
}
