export type QueryDomainErrorCode =
  | "INVALID_QUERY_AST"
  | "POLICY_EVALUATION_UNAVAILABLE"
  | "PROPERTY_NOT_QUERYABLE"
  | "QUERY_BINDING_INVALID"
  | "QUERY_COMPLEXITY_EXCEEDED"
  | "QUERY_SCHEMA_INVALID";

export class QueryDomainError extends Error {
  readonly code: QueryDomainErrorCode;

  constructor(code: QueryDomainErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QueryDomainError";
    this.code = code;
  }
}

export function failQuery(
  code: QueryDomainErrorCode,
  message: string,
  options?: ErrorOptions,
): never {
  throw new QueryDomainError(code, message, options);
}
