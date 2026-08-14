import type { CompatibilityFinding, CompatibilityReport } from "./compatibility.ts";

interface ErrorCodeDefinition {
  readonly code: string;
  readonly httpStatus: number;
  readonly category: string;
  readonly retryable: boolean;
  readonly meaning: string;
  readonly clientAction: string;
}

const categories = new Set([
  "authentication",
  "authorization",
  "conflict",
  "dependency",
  "internal",
  "not_found",
  "rate_limit",
  "unavailable",
  "validation",
]);

export function diffErrorCodeCatalogs(
  baselineValue: unknown,
  candidateValue: unknown,
): CompatibilityReport {
  const baseline = parseCatalog(baselineValue, "$baseline");
  const candidate = parseCatalog(candidateValue, "$candidate");
  const findings: CompatibilityFinding[] = [];
  if (baseline.schemaVersion !== candidate.schemaVersion) {
    findings.push(
      finding("breaking", "ERROR_CATALOG_VERSION_CHANGED", "$.schemaVersion", "Version changed."),
    );
  }
  if (baseline.catalog !== candidate.catalog) {
    findings.push(
      finding("breaking", "ERROR_CATALOG_NAME_CHANGED", "$.catalog", "Catalog name changed."),
    );
  }
  for (const [code, before] of baseline.errors) {
    const after = candidate.errors.get(code);
    if (after === undefined) {
      findings.push(
        finding("breaking", "ERROR_CODE_REMOVED", `$.errors.${code}`, "Error code was removed."),
      );
      continue;
    }
    for (const field of [
      "httpStatus",
      "category",
      "retryable",
      "meaning",
      "clientAction",
    ] as const) {
      if (before[field] !== after[field]) {
        findings.push(
          finding(
            "breaking",
            "ERROR_CODE_SEMANTICS_CHANGED",
            `$.errors.${code}.${field}`,
            `${field} changed.`,
          ),
        );
      }
    }
  }
  for (const code of candidate.errors.keys()) {
    if (!baseline.errors.has(code)) {
      findings.push(
        finding(
          "compatible",
          "ERROR_CODE_ADDED",
          `$.errors.${code}`,
          "A new stable error code was added.",
        ),
      );
    }
  }
  findings.sort((left, right) =>
    `${left.path}:${left.code}`.localeCompare(`${right.path}:${right.code}`),
  );
  return Object.freeze({
    compatible: findings.every((item) => item.severity !== "breaking"),
    findings: Object.freeze(findings),
  });
}

export function readErrorCodeDefinitions(value: unknown): readonly ErrorCodeDefinition[] {
  return Object.freeze([...parseCatalog(value, "$catalog").errors.values()]);
}

function parseCatalog(
  value: unknown,
  path: string,
): Readonly<{
  schemaVersion: number;
  catalog: string;
  errors: ReadonlyMap<string, ErrorCodeDefinition>;
}> {
  const record = requireRecord(value, path);
  requireExactKeys(record, ["schemaVersion", "catalog", "errors"], path);
  if (record.schemaVersion !== 1) throw new Error(`${path}.schemaVersion must be 1.`);
  const catalog = requireString(record.catalog, `${path}.catalog`);
  if (!Array.isArray(record.errors)) throw new Error(`${path}.errors must be an array.`);
  const errors = new Map<string, ErrorCodeDefinition>();
  record.errors.forEach((item, index) => {
    const errorPath = `${path}.errors[${index}]`;
    const error = requireRecord(item, errorPath);
    requireExactKeys(
      error,
      ["code", "httpStatus", "category", "retryable", "meaning", "clientAction"],
      errorPath,
    );
    const code = requireString(error.code, `${errorPath}.code`);
    if (!/^[A-Z][A-Z0-9_]{2,127}$/u.test(code)) throw new Error(`${errorPath}.code is invalid.`);
    if (errors.has(code)) throw new Error(`Duplicate error code ${code}.`);
    if (
      !Number.isSafeInteger(error.httpStatus) ||
      (error.httpStatus as number) < 400 ||
      (error.httpStatus as number) > 599
    ) {
      throw new Error(`${errorPath}.httpStatus must be an HTTP error status.`);
    }
    const category = requireString(error.category, `${errorPath}.category`);
    if (!categories.has(category)) throw new Error(`${errorPath}.category is invalid.`);
    if (typeof error.retryable !== "boolean") {
      throw new Error(`${errorPath}.retryable must be boolean.`);
    }
    errors.set(
      code,
      Object.freeze({
        code,
        httpStatus: error.httpStatus as number,
        category,
        retryable: error.retryable,
        meaning: requireString(error.meaning, `${errorPath}.meaning`),
        clientAction: requireString(error.clientAction, `${errorPath}.clientAction`),
      }),
    );
  });
  return Object.freeze({ schemaVersion: 1, catalog, errors });
}

function finding(
  severity: "breaking" | "compatible",
  code: string,
  path: string,
  message: string,
): CompatibilityFinding {
  return Object.freeze({ severity, code, path, message });
}

function requireRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a string.`);
  return value;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  path: string,
): void {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${path}.${key} is unknown.`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} is missing.`);
  }
}
