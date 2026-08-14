import { createHmac, timingSafeEqual } from "node:crypto";

import type { ResourceListCursor, RevisionListCursor } from "@ontos/metadata-application";

export type AdminCursorKind = "resources" | "revisions";

interface CursorEnvelope {
  readonly version: 1;
  readonly kind: AdminCursorKind;
  readonly scopeId: string;
  readonly value: Readonly<Record<string, string>>;
}

export class CursorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CursorError";
  }
}

export class AdminCursorCodec {
  readonly #key: Buffer;

  constructor(secret: string | Uint8Array) {
    this.#key = Buffer.from(secret);
    if (this.#key.length < 32)
      throw new Error("Cursor HMAC secret must contain at least 32 bytes.");
  }

  encodeResource(scopeId: string, value: ResourceListCursor): string {
    return this.#encode({
      version: 1,
      kind: "resources",
      scopeId,
      value: { namespace: value.namespace, apiName: value.apiName, resourceId: value.resourceId },
    });
  }

  decodeResource(scopeId: string, token: string): ResourceListCursor {
    const envelope = this.#decode("resources", scopeId, token);
    return strictResourceCursor(envelope.value);
  }

  encodeRevision(scopeId: string, value: RevisionListCursor): string {
    return this.#encode({
      version: 1,
      kind: "revisions",
      scopeId,
      value: { revisionNumber: value.revisionNumber.toString(), revisionId: value.revisionId },
    });
  }

  decodeRevision(scopeId: string, token: string): RevisionListCursor {
    const envelope = this.#decode("revisions", scopeId, token);
    const keys = Object.keys(envelope.value).sort();
    if (keys.join(",") !== "revisionId,revisionNumber") throw new CursorError("Cursor is invalid.");
    const revisionNumber = envelope.value["revisionNumber"];
    const revisionId = envelope.value["revisionId"];
    if (
      typeof revisionNumber !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(revisionNumber) ||
      typeof revisionId !== "string"
    ) {
      throw new CursorError("Cursor is invalid.");
    }
    return Object.freeze({ revisionNumber: BigInt(revisionNumber), revisionId });
  }

  #encode(envelope: CursorEnvelope): string {
    const payload = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#key).update(payload, "ascii").digest("base64url");
    return `${payload}.${signature}`;
  }

  #decode(kind: AdminCursorKind, scopeId: string, token: string): CursorEnvelope {
    if (token.length < 40 || token.length > 2_048) throw new CursorError("Cursor is invalid.");
    const pieces = token.split(".");
    if (pieces.length !== 2) throw new CursorError("Cursor is invalid.");
    const [payload, suppliedSignature] = pieces;
    if (payload === undefined || suppliedSignature === undefined)
      throw new CursorError("Cursor is invalid.");
    const expected = createHmac("sha256", this.#key).update(payload, "ascii").digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(suppliedSignature, "base64url");
    } catch (error) {
      throw new CursorError("Cursor is invalid.", { cause: error });
    }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new CursorError("Cursor is invalid.");
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    } catch (error) {
      throw new CursorError("Cursor is invalid.", { cause: error });
    }
    if (
      !isPlainRecord(candidate) ||
      Object.keys(candidate).sort().join(",") !== "kind,scopeId,value,version"
    ) {
      throw new CursorError("Cursor is invalid.");
    }
    if (
      candidate["version"] !== 1 ||
      candidate["kind"] !== kind ||
      candidate["scopeId"] !== scopeId ||
      !isStringRecord(candidate["value"])
    ) {
      throw new CursorError("Cursor does not belong to this collection.");
    }
    return candidate as unknown as CursorEnvelope;
  }
}

function strictResourceCursor(value: Readonly<Record<string, string>>): ResourceListCursor {
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "apiName,namespace,resourceId")
    throw new CursorError("Cursor is invalid.");
  const namespace = value["namespace"];
  const apiName = value["apiName"];
  const resourceId = value["resourceId"];
  if (namespace === undefined || apiName === undefined || resourceId === undefined) {
    throw new CursorError("Cursor is invalid.");
  }
  return Object.freeze({ namespace, apiName, resourceId });
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isPlainRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
