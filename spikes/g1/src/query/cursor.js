import { createHmac, timingSafeEqual } from "node:crypto";
import { KernelError, invariant } from "../core/kernel-error.js";

export function encodeCursor(payload, secret) {
  invariant(typeof secret === "string" && secret.length >= 16, "INVALID_CURSOR_SECRET", "Cursor secret must contain at least 16 characters");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(body, secret);
  return `${body}.${signature}`;
}

export function decodeCursor(cursor, secret) {
  invariant(typeof cursor === "string", "INVALID_CURSOR", "Cursor must be a string");
  const [body, signature, extra] = cursor.split(".");
  invariant(body && signature && !extra, "INVALID_CURSOR", "Cursor format is invalid");

  const expected = sign(body, secret);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  const valid = expectedBuffer.length === actualBuffer.length
    && timingSafeEqual(expectedBuffer, actualBuffer);

  invariant(valid, "INVALID_CURSOR", "Cursor signature is invalid");

  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch (error) {
    throw new KernelError("INVALID_CURSOR", "Cursor payload is invalid", { cause: error.message });
  }
}

function sign(body, secret) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

