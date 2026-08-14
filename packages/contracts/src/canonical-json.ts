import { failContract } from "./error.ts";
import { requirePlainRecord } from "./internal.ts";

/**
 * Canonical JSON bytes are the only accepted preimage for Metadata digests.
 * SHA-256 is applied by an infrastructure adapter so @ontos/contracts remains
 * independent of Node.js, browsers, databases and network libraries.
 */
export function canonicalizeContractForDigest(value: unknown): string {
  return canonicalize(value, "$digest");
}

/**
 * Manifest digests cover every manifest field except manifestDigest itself.
 * Removing that single self-referential field here keeps every caller on the
 * same preimage rule.
 */
export function canonicalizeManifestForDigest(value: unknown): string {
  const record = requirePlainRecord(value, "$manifest");
  if (!Object.hasOwn(record, "manifestDigest")) {
    failContract(
      "CONTRACT_FIELD_MISSING",
      "Manifest digest input must include manifestDigest.",
      "$manifest.manifestDigest",
    );
  }
  const preimage: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (key !== "manifestDigest") preimage[key] = item;
  }
  return canonicalize(preimage, "$manifest");
}

function canonicalize(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        "Digest input numbers must be safe integers and cannot be negative zero.",
        path,
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(",")}]`;
  }
  const record = requirePlainRecord(value, path);
  const keys = Object.keys(record).sort(compareCodeUnits);
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], childPath(path, key))}`)
    .join(",")}}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function childPath(parent: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}
