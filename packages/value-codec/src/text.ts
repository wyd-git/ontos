import { fail } from "./error.ts";

const utf8Encoder = new TextEncoder();

export const DEFAULT_STRING_MAX_BYTES = 64 * 1_024;

export function requireString(input: unknown, path = "$value"): string {
  if (typeof input !== "string") {
    fail("VALUE_TYPE_MISMATCH", "Value must be a string.", path);
  }
  if (!input.isWellFormed() || input.includes("\u0000")) {
    fail("STRING_INVALID", "String must be well-formed Unicode and cannot contain U+0000.", path);
  }
  return input;
}

export function assertUtf8ByteLimit(value: string, maximumBytes: number, path = "$value"): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    fail("STRING_INVALID", "String byte limit must be a non-negative safe integer.", path);
  }
  const actualBytes = utf8ByteLength(value);
  if (actualBytes > maximumBytes) {
    fail(
      "STRING_TOO_LARGE",
      `String is ${actualBytes} UTF-8 bytes; maximum is ${maximumBytes}.`,
      path,
    );
  }
}

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

export function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return Math.sign(leftBytes.length - rightBytes.length);
}
