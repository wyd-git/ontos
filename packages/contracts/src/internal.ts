import { failContract } from "./error.ts";

export type ContractJsonPrimitive = boolean | null | number | string;
export type ContractJsonValue = ContractJsonPrimitive | ContractJsonArray | ContractJsonObject;
export interface ContractJsonArray {
  readonly [index: number]: ContractJsonValue;
  readonly length: number;
}
export interface ContractJsonObject {
  readonly [key: string]: ContractJsonValue;
}

export type UnknownFieldMode = "ignore" | "reject";

export function requirePlainRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failContract("CONTRACT_TYPE_INVALID", "Expected an object.", path);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    failContract("CONTRACT_TYPE_INVALID", "Expected a plain object.", path);
  }
  return value as Record<string, unknown>;
}

export function requireObjectShape(
  record: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  path: string,
  unknownFieldMode: UnknownFieldMode = "reject",
): void {
  const allowed = new Set(allowedKeys);
  if (unknownFieldMode === "reject") {
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        failContract("CONTRACT_UNKNOWN_FIELD", `Unknown field ${key}.`, childPath(path, key));
      }
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(record, key)) {
      failContract(
        "CONTRACT_FIELD_MISSING",
        `Required field ${key} is missing.`,
        childPath(path, key),
      );
    }
  }
}

export function requireString(
  value: unknown,
  path: string,
  options: Readonly<{
    minimumLength?: number;
    maximumLength?: number;
    pattern?: RegExp;
  }> = {},
): string {
  if (typeof value !== "string") {
    failContract("CONTRACT_TYPE_INVALID", "Expected a string.", path);
  }
  const minimumLength = options.minimumLength ?? 1;
  const maximumLength = options.maximumLength ?? Number.MAX_SAFE_INTEGER;
  const length = [...value].length;
  if (length < minimumLength || length > maximumLength) {
    failContract("CONTRACT_VALUE_OUT_OF_RANGE", "String length is outside its contract.", path);
  }
  if (hasControlCharacter(value)) {
    failContract("CONTRACT_FORMAT_INVALID", "Control characters are not allowed.", path);
  }
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    failContract("CONTRACT_FORMAT_INVALID", "String format is invalid.", path);
  }
  return value;
}

export function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    failContract("CONTRACT_TYPE_INVALID", "Expected a boolean.", path);
  }
  return value;
}

export function requireSafeInteger(
  value: unknown,
  path: string,
  options: Readonly<{ minimum?: number; maximum?: number }> = {},
): number {
  if (!Number.isSafeInteger(value)) {
    failContract("CONTRACT_TYPE_INVALID", "Expected a safe integer.", path);
  }
  const minimum = options.minimum ?? Number.MIN_SAFE_INTEGER;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if ((value as number) < minimum || (value as number) > maximum) {
    failContract("CONTRACT_VALUE_OUT_OF_RANGE", "Integer is outside its contract.", path);
  }
  return value as number;
}

export function requireArray(
  value: unknown,
  path: string,
  options: Readonly<{ minimumItems?: number; maximumItems?: number }> = {},
): readonly unknown[] {
  if (!Array.isArray(value)) {
    failContract("CONTRACT_TYPE_INVALID", "Expected an array.", path);
  }
  const minimumItems = options.minimumItems ?? 0;
  const maximumItems = options.maximumItems ?? Number.MAX_SAFE_INTEGER;
  if (value.length < minimumItems || value.length > maximumItems) {
    failContract("CONTRACT_VALUE_OUT_OF_RANGE", "Array length is outside its contract.", path);
  }
  return value as unknown[];
}

export function requireLiteral<T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) {
    failContract("CONTRACT_FORMAT_INVALID", `Expected ${expected}.`, path);
  }
  return expected;
}

export function requireOneOf<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  path: string,
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    failContract("CONTRACT_FORMAT_INVALID", "Value is not in the closed contract set.", path);
  }
  return value as T;
}

export function cloneRestrictedJsonObject(
  value: unknown,
  path: string,
  maximumBytes: number,
  maximumDepth: number,
  maximumNodes: number,
): Readonly<Record<string, ContractJsonValue>> {
  const encoded = safeStringify(value, path);
  if (new TextEncoder().encode(encoded).byteLength > maximumBytes) {
    failContract("CONTRACT_VALUE_OUT_OF_RANGE", "JSON object exceeds its byte limit.", path);
  }
  const budget = { remaining: maximumNodes };
  const cloned = cloneJsonValue(value, path, 0, maximumDepth, budget);
  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) {
    failContract("CONTRACT_TYPE_INVALID", "Expected a JSON object.", path);
  }
  return cloned as ContractJsonObject;
}

export function childPath(parent: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function cloneJsonValue(
  value: unknown,
  path: string,
  depth: number,
  maximumDepth: number,
  budget: { remaining: number },
): ContractJsonValue {
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    failContract("CONTRACT_VALUE_OUT_OF_RANGE", "JSON object exceeds its node limit.", path);
  }
  if (depth > maximumDepth) {
    failContract("CONTRACT_VALUE_OUT_OF_RANGE", "JSON object exceeds its depth limit.", path);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      failContract("CONTRACT_FORMAT_INVALID", "JSON numbers must be finite.", path);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      (value as unknown[]).map((item, index) =>
        cloneJsonValue(item, `${path}[${index}]`, depth + 1, maximumDepth, budget),
      ),
    );
  }
  const record = requirePlainRecord(value, path);
  const result: Record<string, ContractJsonValue> = Object.create(null) as Record<
    string,
    ContractJsonValue
  >;
  for (const [key, item] of Object.entries(record)) {
    Object.defineProperty(result, key, {
      value: cloneJsonValue(item, childPath(path, key), depth + 1, maximumDepth, budget),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(result);
}

function safeStringify(value: unknown, path: string): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("not JSON");
    return encoded;
  } catch {
    failContract("CONTRACT_FORMAT_INVALID", "Value is not serializable JSON.", path);
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}
