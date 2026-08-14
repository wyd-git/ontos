export interface SchemaValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly issues: readonly SchemaValidationIssue[];
}

const supportedSchemaKeywords = new Set([
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "const",
  "description",
  "enum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "minItems",
  "minLength",
  "pattern",
  "properties",
  "required",
  "title",
  "type",
  "uniqueItems",
]);

export function validateSchemaDefinition(
  rootSchema: unknown,
  definitionName: string,
  value: unknown,
): SchemaValidationResult {
  const root = requireRecord(rootSchema, "$schema");
  const definitions = requireRecord(root.$defs, "$schema.$defs");
  const definition = definitions[definitionName];
  if (definition === undefined) {
    throw new Error(`Unknown schema definition ${definitionName}.`);
  }
  const issues: SchemaValidationIssue[] = [];
  validateValue(root, definition, value, "$", issues);
  return Object.freeze({ valid: issues.length === 0, issues: Object.freeze(issues) });
}

export function assertSupportedSchema(rootSchema: unknown): void {
  const root = requireRecord(rootSchema, "$schema");
  inspectSchemaNode(root, "$schema");
}

function inspectSchemaNode(value: unknown, path: string): void {
  const schema = requireRecord(value, path);
  for (const key of Object.keys(schema)) {
    if (!supportedSchemaKeywords.has(key)) {
      throw new Error(`Unsupported JSON Schema keyword ${key} at ${path}.`);
    }
  }
  for (const containerKey of ["$defs", "properties"] as const) {
    if (schema[containerKey] === undefined) continue;
    const children = requireRecord(schema[containerKey], `${path}.${containerKey}`);
    for (const [key, child] of Object.entries(children)) {
      inspectSchemaNode(child, `${path}.${containerKey}.${key}`);
    }
  }
  if (schema.items !== undefined) inspectSchemaNode(schema.items, `${path}.items`);
  if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
    inspectSchemaNode(schema.additionalProperties, `${path}.additionalProperties`);
  }
}

function validateValue(
  root: Readonly<Record<string, unknown>>,
  schemaValue: unknown,
  value: unknown,
  path: string,
  issues: SchemaValidationIssue[],
): void {
  const schema = requireRecord(schemaValue, "$schema-node");
  if (typeof schema.$ref === "string") {
    const target = resolveReference(root, schema.$ref);
    validateValue(root, target, value, path, issues);
    return;
  }
  if (Object.hasOwn(schema, "const") && !deepEqual(value, schema.const)) {
    addIssue(issues, "CONST_MISMATCH", path, "Value does not match const.");
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    addIssue(issues, "ENUM_MISMATCH", path, "Value is not in enum.");
    return;
  }
  if (typeof schema.type === "string" && !matchesType(value, schema.type)) {
    addIssue(issues, "TYPE_MISMATCH", path, `Expected ${schema.type}.`);
    return;
  }

  if (typeof value === "string") validateString(schema, value, path, issues);
  if (Array.isArray(value)) validateArray(root, schema, value, path, issues);
  if (isRecord(value)) validateObject(root, schema, value, path, issues);
}

function validateString(
  schema: Readonly<Record<string, unknown>>,
  value: string,
  path: string,
  issues: SchemaValidationIssue[],
): void {
  const length = [...value].length;
  if (typeof schema.minLength === "number" && length < schema.minLength) {
    addIssue(issues, "MIN_LENGTH", path, "String is shorter than minLength.");
  }
  if (typeof schema.maxLength === "number" && length > schema.maxLength) {
    addIssue(issues, "MAX_LENGTH", path, "String is longer than maxLength.");
  }
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
    addIssue(issues, "PATTERN", path, "String does not match pattern.");
  }
  if (schema.format === "ontos-canonical-instant" && !isGregorianMicrosecondInstant(value)) {
    addIssue(issues, "FORMAT", path, "String is not a canonical Ontos instant.");
  }
}

function validateArray(
  root: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, unknown>>,
  value: readonly unknown[],
  path: string,
  issues: SchemaValidationIssue[],
): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    addIssue(issues, "MIN_ITEMS", path, "Array has fewer than minItems.");
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    addIssue(issues, "MAX_ITEMS", path, "Array has more than maxItems.");
  }
  if (schema.uniqueItems === true) {
    const encoded = value.map(stableJson);
    if (new Set(encoded).size !== encoded.length) {
      addIssue(issues, "UNIQUE_ITEMS", path, "Array items are not unique.");
    }
  }
  if (schema.items !== undefined) {
    value.forEach((item, index) =>
      validateValue(root, schema.items, item, `${path}[${index}]`, issues),
    );
  }
}

function validateObject(
  root: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, unknown>>,
  value: Readonly<Record<string, unknown>>,
  path: string,
  issues: SchemaValidationIssue[],
): void {
  const properties =
    schema.properties === undefined ? {} : requireRecord(schema.properties, "$properties");
  if (Array.isArray(schema.required)) {
    for (const required of schema.required) {
      if (typeof required === "string" && !Object.hasOwn(value, required)) {
        addIssue(issues, "REQUIRED", childPath(path, required), "Required property is missing.");
      }
    }
  }
  for (const [key, item] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (propertySchema !== undefined) {
      validateValue(root, propertySchema, item, childPath(path, key), issues);
      continue;
    }
    if (schema.additionalProperties === false) {
      addIssue(issues, "ADDITIONAL_PROPERTY", childPath(path, key), "Unknown property.");
    } else if (
      typeof schema.additionalProperties === "object" &&
      schema.additionalProperties !== null
    ) {
      validateValue(root, schema.additionalProperties, item, childPath(path, key), issues);
    }
  }
}

function resolveReference(root: Readonly<Record<string, unknown>>, reference: string): unknown {
  const prefix = "#/$defs/";
  if (!reference.startsWith(prefix))
    throw new Error(`Unsupported JSON Schema reference ${reference}.`);
  const definitions = requireRecord(root.$defs, "$schema.$defs");
  const name = reference.slice(prefix.length);
  const target = definitions[name];
  if (target === undefined) throw new Error(`Unresolved JSON Schema reference ${reference}.`);
  return target;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  throw new Error(`Unsupported JSON Schema type ${type}.`);
}

function isGregorianMicrosecondInstant(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const maximumDay =
    month === 2 ? (isLeapYear(year) ? 29 : 28) : new Set([4, 6, 9, 11]).has(month) ? 30 : 31;
  return day >= 1 && day <= maximumDay;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${(value as unknown[]).map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function deepEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  return value;
}

function childPath(parent: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function addIssue(
  issues: SchemaValidationIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push(Object.freeze({ code, path, message }));
}
