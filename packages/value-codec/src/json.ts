import { fail } from "./error.ts";
import { compareUtf8, requireString, utf8ByteLength } from "./text.ts";

declare const canonicalJsonBrand: unique symbol;

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type CanonicalJson = string & { readonly [canonicalJsonBrand]: true };

export interface RestrictedJsonOptions {
  readonly maximumBytes?: number;
  readonly maximumDepth?: number;
  readonly maximumNodes?: number;
}

export const DEFAULT_JSON_MAX_BYTES = 1_024 * 1_024;
export const DEFAULT_JSON_MAXIMUM_DEPTH = 64;
export const DEFAULT_JSON_MAXIMUM_NODES = 100_000;

export function canonicalizeRestrictedJson(
  input: unknown,
  options: RestrictedJsonOptions = {},
): CanonicalJson {
  const maximumBytes = options.maximumBytes ?? DEFAULT_JSON_MAX_BYTES;
  const maximumDepth = options.maximumDepth ?? DEFAULT_JSON_MAXIMUM_DEPTH;
  const maximumNodes = options.maximumNodes ?? DEFAULT_JSON_MAXIMUM_NODES;
  validateLimit(maximumBytes, "maximumBytes");
  validateLimit(maximumDepth, "maximumDepth");
  validateLimit(maximumNodes, "maximumNodes");

  const state: TraversalState = {
    activeContainers: new WeakSet<object>(),
    bytes: 0,
    maximumBytes,
    maximumDepth,
    maximumNodes,
    nodes: 0,
  };
  const canonical = canonicalJsonFragment(input, "$value", 0, state);
  return canonical as CanonicalJson;
}

export function parseCanonicalJson(value: CanonicalJson): JsonValue {
  return JSON.parse(value) as JsonValue;
}

interface TraversalState {
  readonly activeContainers: WeakSet<object>;
  readonly maximumBytes: number;
  readonly maximumDepth: number;
  readonly maximumNodes: number;
  bytes: number;
  nodes: number;
}

function canonicalJsonFragment(
  input: unknown,
  path: string,
  depth: number,
  state: TraversalState,
): string {
  state.nodes += 1;
  if (state.nodes > state.maximumNodes) {
    fail("JSON_VALUE_INVALID", `JSON exceeds ${state.maximumNodes} nodes.`, path);
  }
  if (depth > state.maximumDepth) {
    fail("JSON_VALUE_INVALID", `JSON exceeds depth ${state.maximumDepth}.`, path);
  }

  if (input === null) return emit("null", path, state);
  if (typeof input === "boolean") return emit(input ? "true" : "false", path, state);
  if (typeof input === "string") {
    return emit(quoteJsonString(requireString(input, path)), path, state);
  }
  if (typeof input === "number") {
    return emit(canonicalizeJsonNumber(input, path), path, state);
  }
  if (typeof input !== "object") {
    fail(
      "JSON_VALUE_INVALID",
      "JSON accepts only null, boolean, number, string, array, and plain object values.",
      path,
    );
  }

  if (state.activeContainers.has(input)) {
    fail("JSON_VALUE_INVALID", "JSON cannot contain a cyclic reference.", path);
  }
  state.activeContainers.add(input);
  try {
    if (Array.isArray(input)) {
      emit("[", path, state);
      const items = input.map((item, index) => {
        if (index > 0) emit(",", path, state);
        return canonicalJsonFragment(item, `${path}[${index}]`, depth + 1, state);
      });
      emit("]", path, state);
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(input) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      fail("JSON_VALUE_INVALID", "JSON objects must use a plain or null prototype.", path);
    }
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf8);
    emit("{", path, state);
    const members = keys.map((key, index) => {
      if (index > 0) emit(",", path, state);
      const validKey = requireString(key, `${path}.[key]`);
      const quotedKey = emit(quoteJsonString(validKey), `${path}.[key]`, state);
      emit(":", path, state);
      return `${quotedKey}:${canonicalJsonFragment(
        record[key],
        `${path}.${key}`,
        depth + 1,
        state,
      )}`;
    });
    emit("}", path, state);
    return `{${members.join(",")}}`;
  } finally {
    state.activeContainers.delete(input);
  }
}

function emit(fragment: string, path: string, state: TraversalState): string {
  state.bytes += utf8ByteLength(fragment);
  if (state.bytes > state.maximumBytes) {
    fail("JSON_VALUE_INVALID", `JSON exceeds ${state.maximumBytes} UTF-8 bytes.`, path);
  }
  return fragment;
}

function canonicalizeJsonNumber(input: number, path: string): string {
  if (!Number.isFinite(input)) {
    fail("JSON_VALUE_INVALID", "JSON number must be finite.", path);
  }
  if (Number.isInteger(input) && !Number.isSafeInteger(input)) {
    fail(
      "JSON_VALUE_INVALID",
      "JSON integers must be JavaScript-safe; use an integer or decimal Property for exact values.",
      path,
    );
  }
  const canonical = Object.is(input, -0) ? "0" : JSON.stringify(input);
  if (canonical.includes("e") || canonical.includes("E")) {
    fail(
      "JSON_VALUE_INVALID",
      "Restricted JSON does not accept exponent-form numbers; use a decimal Property or string.",
      path,
    );
  }
  return canonical;
}

function quoteJsonString(value: string): string {
  return JSON.stringify(value);
}

function validateLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("JSON_VALUE_INVALID", `${label} must be a positive safe integer.`);
  }
}
