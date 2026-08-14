export type CompatibilitySeverity = "breaking" | "compatible";

export interface CompatibilityFinding {
  readonly severity: CompatibilitySeverity;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface CompatibilityReport {
  readonly compatible: boolean;
  readonly findings: readonly CompatibilityFinding[];
}

export function diffContractSchemas(
  baselineValue: unknown,
  candidateValue: unknown,
): CompatibilityReport {
  const baseline = requireRecord(baselineValue, "$baseline");
  const candidate = requireRecord(candidateValue, "$candidate");
  const findings: CompatibilityFinding[] = [];
  compareExactKeyword(baseline, candidate, "$id", "$", findings);
  compareSchemaMaps(
    requireRecord(baseline.$defs, "$baseline.$defs"),
    requireRecord(candidate.$defs, "$candidate.$defs"),
    "$defs",
    findings,
  );
  findings.sort((left, right) =>
    `${left.path}:${left.code}:${left.severity}`.localeCompare(
      `${right.path}:${right.code}:${right.severity}`,
    ),
  );
  return Object.freeze({
    compatible: findings.every((finding) => finding.severity !== "breaking"),
    findings: Object.freeze(findings),
  });
}

function compareSchemaMaps(
  baseline: Readonly<Record<string, unknown>>,
  candidate: Readonly<Record<string, unknown>>,
  path: string,
  findings: CompatibilityFinding[],
): void {
  for (const [name, baselineSchema] of Object.entries(baseline)) {
    if (!Object.hasOwn(candidate, name)) {
      addFinding(
        findings,
        "breaking",
        "DEFINITION_REMOVED",
        `${path}.${name}`,
        "Definition was removed.",
      );
      continue;
    }
    compareSchema(baselineSchema, candidate[name], `${path}.${name}`, findings);
  }
  for (const name of Object.keys(candidate)) {
    if (!Object.hasOwn(baseline, name)) {
      addFinding(
        findings,
        "compatible",
        "DEFINITION_ADDED",
        `${path}.${name}`,
        "A new independent definition was added.",
      );
    }
  }
}

function compareSchema(
  baselineValue: unknown,
  candidateValue: unknown,
  path: string,
  findings: CompatibilityFinding[],
): void {
  const baseline = requireRecord(baselineValue, `$baseline.${path}`);
  const candidate = requireRecord(candidateValue, `$candidate.${path}`);
  for (const keyword of ["type", "$ref", "const", "pattern", "format"] as const) {
    compareExactKeyword(baseline, candidate, keyword, path, findings);
  }
  compareEnum(baseline.enum, candidate.enum, path, findings);
  compareMinimum(baseline, candidate, "minLength", path, findings);
  compareMinimum(baseline, candidate, "minItems", path, findings);
  compareMinimum(baseline, candidate, "minimum", path, findings);
  compareMaximum(baseline, candidate, "maxLength", path, findings);
  compareMaximum(baseline, candidate, "maxItems", path, findings);
  compareMaximum(baseline, candidate, "maximum", path, findings);
  compareBooleanTightening(baseline, candidate, "uniqueItems", path, findings);
  compareAdditionalProperties(baseline, candidate, path, findings);

  if (baseline.properties !== undefined || candidate.properties !== undefined) {
    compareProperties(
      baseline.properties === undefined
        ? {}
        : requireRecord(baseline.properties, `${path}.properties`),
      candidate.properties === undefined
        ? {}
        : requireRecord(candidate.properties, `${path}.properties`),
      stringSet(baseline.required),
      stringSet(candidate.required),
      path,
      findings,
    );
  }
  if (baseline.items !== undefined || candidate.items !== undefined) {
    if (baseline.items === undefined || candidate.items === undefined) {
      addFinding(
        findings,
        "breaking",
        "ARRAY_ITEM_SCHEMA_CHANGED",
        `${path}.items`,
        "Array item validation was added or removed.",
      );
    } else {
      compareSchema(baseline.items, candidate.items, `${path}.items`, findings);
    }
  }
}

function compareProperties(
  baseline: Readonly<Record<string, unknown>>,
  candidate: Readonly<Record<string, unknown>>,
  baselineRequired: ReadonlySet<string>,
  candidateRequired: ReadonlySet<string>,
  path: string,
  findings: CompatibilityFinding[],
): void {
  for (const [name, baselineProperty] of Object.entries(baseline)) {
    const propertyPath = `${path}.properties.${name}`;
    if (!Object.hasOwn(candidate, name)) {
      addFinding(
        findings,
        "breaking",
        "PROPERTY_REMOVED",
        propertyPath,
        "Property was removed or renamed.",
      );
      continue;
    }
    compareSchema(baselineProperty, candidate[name], propertyPath, findings);
    if (baselineRequired.has(name) && !candidateRequired.has(name)) {
      addFinding(
        findings,
        "compatible",
        "REQUIRED_PROPERTY_OPTIONALIZED",
        propertyPath,
        "A required property became optional.",
      );
    }
  }
  for (const name of Object.keys(candidate)) {
    if (Object.hasOwn(baseline, name)) continue;
    const propertyPath = `${path}.properties.${name}`;
    if (candidateRequired.has(name)) {
      addFinding(
        findings,
        "breaking",
        "REQUIRED_PROPERTY_ADDED",
        propertyPath,
        "A new required property was added.",
      );
    } else {
      addFinding(
        findings,
        "compatible",
        "OPTIONAL_PROPERTY_ADDED",
        propertyPath,
        "A new optional property was added; deploy readers before writers emit it.",
      );
    }
  }
  for (const name of candidateRequired) {
    if (Object.hasOwn(baseline, name) && !baselineRequired.has(name)) {
      addFinding(
        findings,
        "breaking",
        "OPTIONAL_PROPERTY_REQUIRED",
        `${path}.properties.${name}`,
        "An existing optional property became required.",
      );
    }
  }
}

function compareExactKeyword(
  baseline: Readonly<Record<string, unknown>>,
  candidate: Readonly<Record<string, unknown>>,
  keyword: string,
  path: string,
  findings: CompatibilityFinding[],
): void {
  if (stableJson(baseline[keyword]) === stableJson(candidate[keyword])) return;
  addFinding(
    findings,
    "breaking",
    `${keyword.replaceAll("$", "").toUpperCase()}_CHANGED`,
    `${path}.${keyword}`,
    `${keyword} changed.`,
  );
}

function compareEnum(
  baselineValue: unknown,
  candidateValue: unknown,
  path: string,
  findings: CompatibilityFinding[],
): void {
  if (stableJson(baselineValue) === stableJson(candidateValue)) return;
  if (baselineValue === undefined && candidateValue === undefined) return;
  addFinding(
    findings,
    "breaking",
    "ENUM_CHANGED",
    `${path}.enum`,
    "Closed enum values changed; use a new schema version or an explicitly open enum contract.",
  );
}

function compareMinimum(
  baseline: Readonly<Record<string, unknown>>,
  candidate: Readonly<Record<string, unknown>>,
  keyword: "minItems" | "minLength" | "minimum",
  path: string,
  findings: CompatibilityFinding[],
): void {
  const before = numericConstraint(baseline[keyword]);
  const after = numericConstraint(candidate[keyword]);
  if (after === null || (before !== null && after <= before)) return;
  addFinding(
    findings,
    "breaking",
    "CONSTRAINT_TIGHTENED",
    `${path}.${keyword}`,
    `${keyword} increased.`,
  );
}

function compareMaximum(
  baseline: Readonly<Record<string, unknown>>,
  candidate: Readonly<Record<string, unknown>>,
  keyword: "maxItems" | "maxLength" | "maximum",
  path: string,
  findings: CompatibilityFinding[],
): void {
  const before = numericConstraint(baseline[keyword]);
  const after = numericConstraint(candidate[keyword]);
  if (after === null || (before !== null && after >= before)) return;
  addFinding(
    findings,
    "breaking",
    "CONSTRAINT_TIGHTENED",
    `${path}.${keyword}`,
    `${keyword} decreased.`,
  );
}

function compareBooleanTightening(
  baseline: Readonly<Record<string, unknown>>,
  candidate: Readonly<Record<string, unknown>>,
  keyword: "uniqueItems",
  path: string,
  findings: CompatibilityFinding[],
): void {
  if (baseline[keyword] !== true && candidate[keyword] === true) {
    addFinding(
      findings,
      "breaking",
      "CONSTRAINT_TIGHTENED",
      `${path}.${keyword}`,
      `${keyword} became true.`,
    );
  }
}

function compareAdditionalProperties(
  baseline: Readonly<Record<string, unknown>>,
  candidate: Readonly<Record<string, unknown>>,
  path: string,
  findings: CompatibilityFinding[],
): void {
  if (stableJson(baseline.additionalProperties) === stableJson(candidate.additionalProperties))
    return;
  addFinding(
    findings,
    "breaking",
    "UNKNOWN_FIELD_POLICY_CHANGED",
    `${path}.additionalProperties`,
    "Unknown-field policy changed and requires an explicit new contract version.",
  );
}

function stringSet(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set();
  const result = new Set<string>();
  for (const item of value as unknown[]) {
    if (typeof item !== "string") throw new Error("required must contain only strings.");
    result.add(item);
  }
  return result;
}

function numericConstraint(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Schema constraint must be a non-negative safe integer.");
  }
  return value;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "<undefined>";
  if (Array.isArray(value)) return `[${(value as unknown[]).map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  return value;
}

function addFinding(
  findings: CompatibilityFinding[],
  severity: CompatibilitySeverity,
  code: string,
  path: string,
  message: string,
): void {
  findings.push(Object.freeze({ severity, code, path, message }));
}
