export type ContractValidationErrorCode =
  | "CONTRACT_FIELD_MISSING"
  | "CONTRACT_FORMAT_INVALID"
  | "CONTRACT_SCHEMA_VERSION_UNSUPPORTED"
  | "CONTRACT_STATE_TRANSITION_INVALID"
  | "CONTRACT_TYPE_INVALID"
  | "CONTRACT_UNKNOWN_FIELD"
  | "CONTRACT_VALUE_OUT_OF_RANGE";

export class ContractValidationError extends Error {
  readonly code: ContractValidationErrorCode;
  readonly path: string;

  constructor(code: ContractValidationErrorCode, message: string, path = "$") {
    super(message);
    this.name = "ContractValidationError";
    this.code = code;
    this.path = path;
  }
}

export function failContract(
  code: ContractValidationErrorCode,
  message: string,
  path?: string,
): never {
  throw new ContractValidationError(code, message, path);
}
