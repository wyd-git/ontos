import {
  canonicalizeContractForDigest,
  canonicalizeManifestForDigest,
  parseOntosId,
  parsePackageManifest,
  parsePackageResourceContent,
  type ArtifactDigest,
  type LinkTypeDefinition,
  type PackageManifestContract,
  type ResourceFamily,
} from "@ontos/contracts";

export const METADATA_PACKAGE_VALIDATOR_VERSION = "metadata-package-g2-01-v1" as const;
export const METADATA_PACKAGE_KERNEL_CONTRACT_VERSION = "metadata-1" as const;

export type PackageDomainErrorCode =
  | "INVALID_PACKAGE"
  | "PACKAGE_CAPABILITY_FORBIDDEN"
  | "PACKAGE_DIGEST_MISMATCH"
  | "PACKAGE_INPUT_INVALID";

export class PackageDomainError extends Error {
  readonly code: PackageDomainErrorCode;

  constructor(code: PackageDomainErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PackageDomainError";
    this.code = code;
  }
}

export interface PackageInstallInputBinding {
  readonly apiName: string;
  readonly value: string;
}

export interface PreparedPackageDependency {
  readonly sourceRevisionId: string;
  readonly targetRevisionId: string;
  readonly dependencyType: "link_source" | "link_target";
  readonly sourcePath: "/source/objectTypeRevisionId" | "/target/objectTypeRevisionId";
}

export interface PreparedPackageResource {
  readonly namespace: string;
  readonly apiName: string;
  readonly family: ResourceFamily;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly contentDigest: ArtifactDigest;
  readonly content: ReturnType<typeof parsePackageResourceContent>;
  readonly canonicalContent: string;
  readonly dependencies: readonly PreparedPackageDependency[];
}

export interface PreparedPackageCandidate {
  readonly manifest: PackageManifestContract;
  readonly canonicalManifestPreimage: string;
  readonly resources: readonly PreparedPackageResource[];
  readonly installInputBindings: readonly PackageInstallInputBinding[];
  readonly canonicalInputBindings: string;
}

export interface PackageIntegrityResult {
  readonly manifestDigest: ArtifactDigest;
  readonly inputBindingsDigest: ArtifactDigest;
}

export type CanonicalTextDigester = (canonicalText: string) => ArtifactDigest;

const forbiddenFieldExpression =
  /^(?:raw_?sql|sql|statement|statements|migration|migrations|kernel_?migration|kernel_?migrations|file_?path|module_?path|artifact_?path|absolute_?path|relative_?path|password|secret|credential|database_?url|connection_?string)$/iu;
const forbiddenValueExpression =
  /(?:\b(?:postgres(?:ql)?|mysql|mongodb|redis|jdbc):\/\/|file:\/\/|(?:^|\s)(?:\.\.\/|\/etc\/|\/var\/|[A-Za-z]:\\))/iu;
const inputValueExpression = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const sensitiveInputNameExpression = /(?:password|secret|token|credential|databaseurl)/iu;

/**
 * The Package path uses the same Resource Family Registry as direct Metadata.
 * It accepts only a closed bundle shape and returns canonical preimages for an
 * infrastructure-owned SHA-256 implementation.
 */
export function preparePackageCandidate(input: {
  readonly manifest: unknown;
  readonly resources: unknown;
  readonly installInputBindings: unknown;
}): PreparedPackageCandidate {
  assertNoForbiddenCapabilities(input.manifest, "$package.manifest");
  assertNoForbiddenCapabilities(input.resources, "$package.resources");

  let manifest: PackageManifestContract;
  try {
    manifest = parsePackageManifest(input.manifest);
  } catch (error) {
    throw new PackageDomainError("INVALID_PACKAGE", "Package Manifest is invalid.", {
      cause: error,
    });
  }
  if (manifest.kernelContractVersion !== METADATA_PACKAGE_KERNEL_CONTRACT_VERSION) {
    throw new PackageDomainError(
      "PACKAGE_CAPABILITY_FORBIDDEN",
      `Kernel contract ${manifest.kernelContractVersion} is not active.`,
    );
  }

  const resourcePayloads = strictArray(input.resources, "$package.resources", 1, 512).map(
    (value, index) =>
      strictRecord(value, `$package.resources[${String(index)}]`, [
        "resourceId",
        "revisionId",
        "content",
      ]),
  );
  if (resourcePayloads.length !== manifest.resourceEntries.length) {
    throw new PackageDomainError(
      "INVALID_PACKAGE",
      "Package Resource payload count does not match the Manifest.",
    );
  }
  const payloadsByKey = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [index, payload] of resourcePayloads.entries()) {
    const resourceId = packageIdentifier(
      payload["resourceId"],
      `resources[${String(index)}].resourceId`,
    );
    const revisionId = packageIdentifier(
      payload["revisionId"],
      `resources[${String(index)}].revisionId`,
    );
    const key = `${resourceId}\u0000${revisionId}`;
    if (payloadsByKey.has(key)) {
      throw new PackageDomainError("INVALID_PACKAGE", "Package Resource payload is duplicated.");
    }
    payloadsByKey.set(key, payload);
  }

  const resources = manifest.resourceEntries.map((entry) => {
    const payload = payloadsByKey.get(`${entry.resourceId}\u0000${entry.revisionId}`);
    if (payload === undefined) {
      throw new PackageDomainError(
        "INVALID_PACKAGE",
        "Package Resource payload identity does not match the Manifest.",
      );
    }
    let content: ReturnType<typeof parsePackageResourceContent>;
    try {
      content = parsePackageResourceContent(entry.family, payload["content"]);
    } catch (error) {
      throw new PackageDomainError(
        "PACKAGE_CAPABILITY_FORBIDDEN",
        `Resource family ${entry.family} is unavailable or its content is invalid.`,
        { cause: error },
      );
    }
    const dependencies =
      entry.family === "link_type"
        ? packageLinkDependencies(entry.revisionId, content as LinkTypeDefinition)
        : Object.freeze([]);
    return Object.freeze({
      namespace: entry.namespace,
      apiName: entry.apiName,
      family: entry.family,
      resourceId: entry.resourceId,
      revisionId: entry.revisionId,
      contentDigest: entry.contentDigest,
      content,
      canonicalContent: canonicalizeContractForDigest(content),
      dependencies,
    });
  });

  const installInputBindings = parseInstallInputBindings(input.installInputBindings, manifest);
  return Object.freeze({
    manifest,
    canonicalManifestPreimage: canonicalizeManifestForDigest(manifest),
    resources: Object.freeze(resources),
    installInputBindings,
    canonicalInputBindings: canonicalizeContractForDigest(installInputBindings),
  });
}

export function assertPackageCandidateIntegrity(
  candidate: PreparedPackageCandidate,
  digest: CanonicalTextDigester,
): PackageIntegrityResult {
  const manifestDigest = digest(candidate.canonicalManifestPreimage);
  if (manifestDigest !== candidate.manifest.manifestDigest) {
    throw new PackageDomainError(
      "PACKAGE_DIGEST_MISMATCH",
      "Package Manifest Digest does not match its canonical content.",
    );
  }
  for (const resource of candidate.resources) {
    if (digest(resource.canonicalContent) !== resource.contentDigest) {
      throw new PackageDomainError(
        "PACKAGE_DIGEST_MISMATCH",
        `Package Resource ${resource.resourceId} Digest does not match its canonical content.`,
      );
    }
  }
  return Object.freeze({
    manifestDigest,
    inputBindingsDigest: digest(candidate.canonicalInputBindings),
  });
}

function parseInstallInputBindings(
  value: unknown,
  manifest: PackageManifestContract,
): readonly PackageInstallInputBinding[] {
  const values = strictArray(value, "$package.installInputBindings", 0, 64).map((item, index) => {
    const record = strictRecord(item, `$package.installInputBindings[${String(index)}]`, [
      "apiName",
      "value",
    ]);
    if (typeof record["apiName"] !== "string" || typeof record["value"] !== "string") {
      throw new PackageDomainError(
        "PACKAGE_INPUT_INVALID",
        "Package install input bindings must contain string apiName and value fields.",
      );
    }
    if (!inputValueExpression.test(record["value"])) {
      throw new PackageDomainError(
        "PACKAGE_INPUT_INVALID",
        "Package install input values must be bounded opaque labels, not paths, URLs or secrets.",
      );
    }
    return Object.freeze({ apiName: record["apiName"], value: record["value"] });
  });
  const sorted = [...values].sort((left, right) => compareText(left.apiName, right.apiName));
  if (sorted.some((item, index) => index > 0 && item.apiName === sorted[index - 1]?.apiName)) {
    throw new PackageDomainError("PACKAGE_INPUT_INVALID", "Package install input is duplicated.");
  }
  if (values.some((item, index) => item.apiName !== sorted[index]?.apiName)) {
    throw new PackageDomainError(
      "PACKAGE_INPUT_INVALID",
      "Package install input bindings must use deterministic API Name order.",
    );
  }
  const definitions = new Map(
    manifest.installInputs.map((definition) => [definition.apiName, definition]),
  );
  for (const definition of manifest.installInputs) {
    if (sensitiveInputNameExpression.test(definition.apiName)) {
      throw new PackageDomainError(
        "PACKAGE_CAPABILITY_FORBIDDEN",
        `Install input ${definition.apiName} could carry a fixed secret and is not active in G2-01.`,
      );
    }
  }
  for (const binding of sorted) {
    if (!definitions.has(binding.apiName)) {
      throw new PackageDomainError(
        "PACKAGE_INPUT_INVALID",
        `Install input ${binding.apiName} is not declared by the Package Manifest.`,
      );
    }
  }
  for (const definition of manifest.installInputs) {
    if (definition.required && !sorted.some(({ apiName }) => apiName === definition.apiName)) {
      throw new PackageDomainError(
        "PACKAGE_INPUT_INVALID",
        `Required install input ${definition.apiName} is missing.`,
      );
    }
  }
  return Object.freeze(sorted);
}

function packageLinkDependencies(
  revisionId: string,
  content: LinkTypeDefinition,
): readonly PreparedPackageDependency[] {
  return Object.freeze([
    Object.freeze({
      sourceRevisionId: revisionId,
      targetRevisionId: content.source.objectTypeRevisionId,
      dependencyType: "link_source" as const,
      sourcePath: "/source/objectTypeRevisionId" as const,
    }),
    Object.freeze({
      sourceRevisionId: revisionId,
      targetRevisionId: content.target.objectTypeRevisionId,
      dependencyType: "link_target" as const,
      sourcePath: "/target/objectTypeRevisionId" as const,
    }),
  ]);
}

function assertNoForbiddenCapabilities(value: unknown, path: string): void {
  let nodes = 0;
  const visit = (item: unknown, itemPath: string, depth: number): void => {
    nodes += 1;
    if (nodes > 20_000 || depth > 32) {
      throw new PackageDomainError("INVALID_PACKAGE", "Package payload exceeds safe limits.");
    }
    if (typeof item === "string") {
      if (forbiddenValueExpression.test(item)) {
        throw new PackageDomainError(
          "PACKAGE_CAPABILITY_FORBIDDEN",
          `Package contains a forbidden fixed address or filesystem path at ${itemPath}.`,
        );
      }
      return;
    }
    if (item === null || typeof item === "boolean" || typeof item === "number") return;
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${itemPath}[${String(index)}]`, depth + 1));
      return;
    }
    if (typeof item !== "object") {
      throw new PackageDomainError(
        "INVALID_PACKAGE",
        "Package payload must contain JSON values only.",
      );
    }
    const prototype = Object.getPrototypeOf(item) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PackageDomainError(
        "INVALID_PACKAGE",
        "Package payload must contain plain objects only.",
      );
    }
    for (const [key, child] of Object.entries(item as Readonly<Record<string, unknown>>)) {
      if (forbiddenFieldExpression.test(key)) {
        throw new PackageDomainError(
          "PACKAGE_CAPABILITY_FORBIDDEN",
          `Package capability ${key} is forbidden at ${itemPath}.`,
        );
      }
      visit(child, `${itemPath}.${key}`, depth + 1);
    }
  };
  visit(value, path, 0);
}

function strictArray(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new PackageDomainError(
      "INVALID_PACKAGE",
      `${path} must contain between ${String(minimum)} and ${String(maximum)} items.`,
    );
  }
  return value;
}

function strictRecord(
  value: unknown,
  path: string,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PackageDomainError("INVALID_PACKAGE", `${path} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PackageDomainError("INVALID_PACKAGE", `${path} must be a plain object.`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort(compareText);
  const expected = [...fields].sort(compareText);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new PackageDomainError(
      "INVALID_PACKAGE",
      `${path} contains missing or unsupported fields.`,
    );
  }
  return record;
}

function packageIdentifier(value: unknown, field: string): string {
  try {
    return parseOntosId(value, `$package.${field}`);
  } catch (error) {
    throw new PackageDomainError("INVALID_PACKAGE", `${field} is invalid.`, { cause: error });
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
