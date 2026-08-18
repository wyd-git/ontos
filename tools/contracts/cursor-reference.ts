import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import {
  ContractValidationError,
  CursorContextChangedError,
  assertCursorEnvelopeContext,
  parseCursorEnvelope,
  parseOpaqueCursor,
  type CursorEnvelope,
  type CursorExpectedContext,
  type OpaqueCursor,
} from "../../packages/contracts/src/index.ts";

export type CursorTokenErrorCode = "CURSOR_EXPIRED" | "CURSOR_INVALID";

export class CursorTokenError extends Error {
  readonly code: CursorTokenErrorCode;

  constructor(code: CursorTokenErrorCode, message: string) {
    super(message);
    this.name = "CursorTokenError";
    this.code = code;
  }
}

export interface CursorKey {
  readonly version: string;
  readonly key: Uint8Array;
}

interface EncodedCursorToken {
  readonly v: 1;
  readonly k: string;
  readonly i: string;
  readonly c: string;
  readonly t: string;
}

export function sealCursorEnvelope(envelope: CursorEnvelope, key: CursorKey): OpaqueCursor {
  if (key.version !== envelope.keyVersion || key.key.byteLength !== 32) {
    throw new CursorTokenError("CURSOR_INVALID", "Cursor encryption key is invalid.");
  }
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, initializationVector);
  cipher.setAAD(Buffer.from(aad(key.version)));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(envelope), "utf8")),
    cipher.final(),
  ]);
  const encoded: EncodedCursorToken = Object.freeze({
    v: 1,
    k: key.version,
    i: initializationVector.toString("base64url"),
    c: ciphertext.toString("base64url"),
    t: cipher.getAuthTag().toString("base64url"),
  });
  return parseOpaqueCursor(Buffer.from(JSON.stringify(encoded), "utf8").toString("base64url"));
}

export function verifyCursorToken(
  tokenValue: unknown,
  keyRing: ReadonlyMap<string, Uint8Array>,
  expected: CursorExpectedContext,
  now: Date,
): CursorEnvelope {
  try {
    const token = parseOpaqueCursor(tokenValue);
    const encoded = parseEncodedToken(
      JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown,
    );
    const key = keyRing.get(encoded.k);
    if (key === undefined || key.byteLength !== 32) {
      throw new CursorTokenError("CURSOR_INVALID", "Cursor key version is unavailable.");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encoded.i, "base64url"));
    decipher.setAAD(Buffer.from(aad(encoded.k)));
    decipher.setAuthTag(Buffer.from(encoded.t, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encoded.c, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const envelope = parseCursorEnvelope(JSON.parse(plaintext) as unknown, {
      now,
      acceptedKeyVersions: new Set(keyRing.keys()),
    });
    if (envelope.keyVersion !== encoded.k) {
      throw new CursorTokenError("CURSOR_INVALID", "Cursor key binding is inconsistent.");
    }
    assertCursorEnvelopeContext(envelope, expected);
    return envelope;
  } catch (error) {
    if (error instanceof CursorContextChangedError || error instanceof CursorTokenError) {
      throw error;
    }
    if (
      error instanceof ContractValidationError &&
      error.path === "$cursorEnvelope.expiresAt" &&
      error.message === "Cursor is expired."
    ) {
      throw new CursorTokenError("CURSOR_EXPIRED", "Cursor has expired.");
    }
    throw new CursorTokenError("CURSOR_INVALID", "Cursor authentication failed.");
  }
}

function parseEncodedToken(value: unknown): EncodedCursorToken {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CursorTokenError("CURSOR_INVALID", "Cursor token envelope is invalid.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  if (JSON.stringify(keys) !== JSON.stringify(["c", "i", "k", "t", "v"])) {
    throw new CursorTokenError("CURSOR_INVALID", "Cursor token fields are invalid.");
  }
  if (
    record.v !== 1 ||
    typeof record.k !== "string" ||
    typeof record.i !== "string" ||
    typeof record.c !== "string" ||
    typeof record.t !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(record.i) ||
    !/^[A-Za-z0-9_-]+$/u.test(record.c) ||
    !/^[A-Za-z0-9_-]+$/u.test(record.t)
  ) {
    throw new CursorTokenError("CURSOR_INVALID", "Cursor token values are invalid.");
  }
  const initializationVector = Buffer.from(record.i, "base64url");
  const ciphertext = Buffer.from(record.c, "base64url");
  const authenticationTag = Buffer.from(record.t, "base64url");
  if (
    initializationVector.byteLength !== 12 ||
    authenticationTag.byteLength !== 16 ||
    ciphertext.byteLength < 1 ||
    initializationVector.toString("base64url") !== record.i ||
    ciphertext.toString("base64url") !== record.c ||
    authenticationTag.toString("base64url") !== record.t
  ) {
    throw new CursorTokenError("CURSOR_INVALID", "Cursor token encoding is invalid.");
  }
  return Object.freeze({ v: 1, k: record.k, i: record.i, c: record.c, t: record.t });
}

function aad(keyVersion: string): string {
  return `ontos-runtime-cursor:v1:${keyVersion}`;
}
