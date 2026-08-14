import type { IncomingMessage } from "node:http";

export const ADMIN_BODY_LIMITS = Object.freeze({
  maximumBytes: 1_048_576,
  maximumDepth: 32,
  maximumNodes: 20_000,
  maximumArrayItems: 1_024,
  maximumStringLength: 65_536,
  maximumKeyLength: 128,
});

export class RequestBodyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RequestBodyError";
  }
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  assertJsonMediaType(request);
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > ADMIN_BODY_LIMITS.maximumBytes) {
      throw new RequestBodyError("Request body exceeds the supported size.");
    }
  }
  if (request.headers["content-encoding"] !== undefined) {
    throw new RequestBodyError("Compressed request bodies are not supported.");
  }

  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const candidate of request) {
    const chunk = Buffer.isBuffer(candidate) ? candidate : Buffer.from(candidate as Uint8Array);
    byteLength += chunk.length;
    if (byteLength > ADMIN_BODY_LIMITS.maximumBytes) {
      throw new RequestBodyError("Request body exceeds the supported size.");
    }
    chunks.push(chunk);
  }
  if (byteLength === 0) throw new RequestBodyError("A JSON request body is required.");

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, byteLength).toString("utf8")) as unknown;
  } catch (error) {
    throw new RequestBodyError("Request body is not valid JSON.", { cause: error });
  }
  assertBoundedJson(value);
  return value;
}

export async function assertEmptyActionBody(request: IncomingMessage): Promise<void> {
  if (!hasRequestBody(request)) return;
  const value = await readJsonBody(request);
  if (!isPlainRecord(value) || Object.keys(value).length !== 0) {
    throw new RequestBodyError("This action accepts only an empty JSON object.");
  }
}

export function hasRequestBody(request: IncomingMessage): boolean {
  const length = request.headers["content-length"];
  return length !== undefined ? length !== "0" : request.headers["transfer-encoding"] !== undefined;
}

function assertJsonMediaType(request: IncomingMessage): void {
  const header = request.headers["content-type"];
  if (
    typeof header !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(header.trim())
  ) {
    throw new RequestBodyError("Content-Type must be application/json.");
  }
}

function assertBoundedJson(root: unknown): void {
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value: root, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > ADMIN_BODY_LIMITS.maximumNodes) {
      throw new RequestBodyError("Request JSON contains too many values.");
    }
    if (current.depth > ADMIN_BODY_LIMITS.maximumDepth) {
      throw new RequestBodyError("Request JSON is nested too deeply.");
    }
    const value = current.value;
    if (typeof value === "string") {
      if (value.length > ADMIN_BODY_LIMITS.maximumStringLength) {
        throw new RequestBodyError("Request JSON contains an oversized string.");
      }
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        throw new RequestBodyError("Request JSON contains a bad number.");
      continue;
    }
    if (value === null || typeof value === "boolean") continue;
    if (Array.isArray(value)) {
      if (value.length > ADMIN_BODY_LIMITS.maximumArrayItems) {
        throw new RequestBodyError("Request JSON contains an oversized array.");
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(value))
      throw new RequestBodyError("Request JSON must contain plain values.");
    for (const [key, child] of Object.entries(value)) {
      if (
        key.length > ADMIN_BODY_LIMITS.maximumKeyLength ||
        key === "__proto__" ||
        key === "prototype" ||
        key === "constructor"
      ) {
        throw new RequestBodyError("Request JSON contains an unsupported field name.");
      }
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
