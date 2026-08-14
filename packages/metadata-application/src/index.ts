import {
  parseArtifactDigest,
  parseCanonicalInstant,
  type ArtifactDigest,
  type CanonicalInstant,
} from "@ontos/contracts";
import {
  isManagementPermissionAllowed,
  validateDisplayName,
  validateManagementPermission,
  validateManagementRole,
  validateProjectApiName,
  type ManagementPermission,
  type ManagementRole,
} from "@ontos/metadata-domain";

export type MetadataApplicationErrorCode =
  | "ALREADY_EXISTS"
  | "CONCURRENT_MODIFICATION"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "STORAGE_FAILURE";

export class MetadataApplicationError extends Error {
  readonly code: MetadataApplicationErrorCode;

  constructor(code: MetadataApplicationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MetadataApplicationError";
    this.code = code;
  }
}

/**
 * Output of the trusted OIDC adapter. It is deliberately closed and contains
 * neither a Bearer token, a client-supplied Principal ID nor an arbitrary claims map.
 */
export interface VerifiedFoundationIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string;
  readonly claimsFingerprint: ArtifactDigest;
  readonly authenticatedAt: CanonicalInstant;
}

export interface ResolvedFoundationIdentity {
  readonly principalId: string;
  readonly claimsFingerprint: ArtifactDigest;
  readonly authenticatedAt: CanonicalInstant;
}

export interface PrincipalRecord {
  readonly principalId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string;
  readonly state: "active" | "disabled";
}

export interface ProjectRecord {
  readonly projectId: string;
  readonly apiName: string;
  readonly displayName: string;
  readonly state: "active" | "archived";
  readonly createdAt: string;
}

export interface RoleBindingRecord {
  readonly bindingId: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly resourceId: string | null;
  readonly role: ManagementRole;
  readonly state: "active" | "revoked";
}

export interface ProjectCreation {
  readonly project: ProjectRecord;
  readonly ownerBinding: RoleBindingRecord;
  readonly authorizationEpoch: bigint;
}

export interface RoleBindingReplacement {
  readonly changed: boolean;
  readonly authorizationEpoch: bigint;
  readonly activeBinding: RoleBindingRecord | null;
}

export interface AuthorizationRoleSnapshot {
  readonly authorizationEpoch: bigint;
  readonly projectRole: ManagementRole | null;
  readonly resourceRole: ManagementRole | null;
}

export interface PrincipalDirectory {
  resolveVerifiedIdentity(identity: VerifiedFoundationIdentity): Promise<PrincipalRecord>;
}

export interface ProjectRepository {
  createProjectWithOwner(input: {
    readonly principalId: string;
    readonly apiName: string;
    readonly displayName: string;
  }): Promise<ProjectCreation>;
  archiveProject(input: {
    readonly projectId: string;
    readonly expectedEpoch: bigint;
  }): Promise<{ readonly project: ProjectRecord; readonly authorizationEpoch: bigint }>;
}

export interface RoleBindingRepository {
  replaceRoleBinding(input: {
    readonly projectId: string;
    readonly targetPrincipalId: string;
    readonly resourceId: string | null;
    readonly role: ManagementRole | null;
    readonly expectedEpoch: bigint;
  }): Promise<RoleBindingReplacement>;
}

export interface ManagementAuthorizationReader {
  readAuthorizationRoles(input: {
    readonly principalId: string;
    readonly projectId: string;
    readonly resourceId: string | null;
  }): Promise<AuthorizationRoleSnapshot>;
}

export interface ManagementAuthorizationRequest {
  readonly projectId: string;
  readonly resourceId?: string;
  readonly permission: ManagementPermission;
}

export interface ManagementAuthorizer {
  authorize(
    identity: ResolvedFoundationIdentity,
    request: ManagementAuthorizationRequest,
  ): Promise<boolean>;
}

export class RoleMatrixManagementAuthorizer implements ManagementAuthorizer {
  readonly #reader: ManagementAuthorizationReader;

  constructor(reader: ManagementAuthorizationReader) {
    this.#reader = reader;
  }

  async authorize(
    identity: ResolvedFoundationIdentity,
    request: ManagementAuthorizationRequest,
  ): Promise<boolean> {
    try {
      const permission = validateManagementPermission(request.permission);
      const snapshot = await this.#reader.readAuthorizationRoles({
        principalId: identity.principalId,
        projectId: request.projectId,
        resourceId: request.resourceId ?? null,
      });
      return isManagementPermissionAllowed(snapshot, permission, request.resourceId !== undefined);
    } catch {
      return false;
    }
  }
}

export interface MetadataApplicationServiceOptions {
  readonly principals: PrincipalDirectory;
  readonly projects: ProjectRepository;
  readonly roleBindings: RoleBindingRepository;
  readonly authorizer: ManagementAuthorizer;
}

export class MetadataApplicationService {
  readonly #principals: PrincipalDirectory;
  readonly #projects: ProjectRepository;
  readonly #roleBindings: RoleBindingRepository;
  readonly #authorizer: ManagementAuthorizer;

  constructor(options: MetadataApplicationServiceOptions) {
    this.#principals = options.principals;
    this.#projects = options.projects;
    this.#roleBindings = options.roleBindings;
    this.#authorizer = options.authorizer;
  }

  async createProject(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ProjectCreation> {
    const identity = parseVerifiedFoundationIdentity(identityInput);
    const command = parseCreateProjectCommand(commandInput);
    const principal = await this.#principals.resolveVerifiedIdentity(identity);
    const resolved = resolvedIdentity(identity, principal);
    return this.#projects.createProjectWithOwner({
      principalId: resolved.principalId,
      apiName: command.apiName,
      displayName: command.displayName,
    });
  }

  async authorizeManagement(
    identityInput: VerifiedFoundationIdentity,
    requestInput: unknown,
  ): Promise<boolean> {
    const identity = parseVerifiedFoundationIdentity(identityInput);
    const request = parseManagementAuthorizationRequest(requestInput);
    const principal = await this.#principals.resolveVerifiedIdentity(identity);
    return this.#authorizer.authorize(resolvedIdentity(identity, principal), request);
  }

  async replaceRoleBinding(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<RoleBindingReplacement> {
    const identity = parseVerifiedFoundationIdentity(identityInput);
    const command = parseReplaceRoleBindingCommand(commandInput);
    const principal = await this.#principals.resolveVerifiedIdentity(identity);
    await this.#requirePermission(resolvedIdentity(identity, principal), {
      projectId: command.projectId,
      permission: "role.manage",
    });
    return this.#roleBindings.replaceRoleBinding(command);
  }

  async archiveProject(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<{ readonly project: ProjectRecord; readonly authorizationEpoch: bigint }> {
    const identity = parseVerifiedFoundationIdentity(identityInput);
    const command = parseArchiveProjectCommand(commandInput);
    const principal = await this.#principals.resolveVerifiedIdentity(identity);
    await this.#requirePermission(resolvedIdentity(identity, principal), {
      projectId: command.projectId,
      permission: "metadata.edit",
    });
    return this.#projects.archiveProject(command);
  }

  async #requirePermission(
    identity: ResolvedFoundationIdentity,
    request: ManagementAuthorizationRequest,
  ): Promise<void> {
    if (!(await this.#authorizer.authorize(identity, request))) {
      throw new MetadataApplicationError("FORBIDDEN", "Management permission was denied.");
    }
  }
}

export function parseVerifiedFoundationIdentity(value: unknown): VerifiedFoundationIdentity {
  const record = strictRecord(value, [
    "issuer",
    "subject",
    "displayName",
    "claimsFingerprint",
    "authenticatedAt",
  ]);
  return Object.freeze({
    issuer: boundedString(record["issuer"], "issuer", 2_048),
    subject: boundedString(record["subject"], "subject", 512),
    displayName: validateDisplayName(record["displayName"]),
    claimsFingerprint: parseArtifactDigest(
      record["claimsFingerprint"],
      "$identity.claimsFingerprint",
    ),
    authenticatedAt: parseCanonicalInstant(record["authenticatedAt"], "$identity.authenticatedAt"),
  });
}

function parseCreateProjectCommand(value: unknown): {
  readonly apiName: string;
  readonly displayName: string;
} {
  const record = strictRecord(value, ["apiName", "displayName"]);
  return Object.freeze({
    apiName: validateProjectApiName(record["apiName"]),
    displayName: validateDisplayName(record["displayName"]),
  });
}

function parseManagementAuthorizationRequest(value: unknown): ManagementAuthorizationRequest {
  const candidate = asRecord(value);
  const fields =
    candidate["resourceId"] === undefined
      ? ["projectId", "permission"]
      : ["projectId", "resourceId", "permission"];
  const record = strictRecord(candidate, fields);
  const result: {
    projectId: string;
    resourceId?: string;
    permission: ManagementPermission;
  } = {
    projectId: identifier(record["projectId"], "projectId"),
    permission: validateManagementPermission(record["permission"]),
  };
  if (record["resourceId"] !== undefined) {
    result.resourceId = identifier(record["resourceId"], "resourceId");
  }
  return Object.freeze(result);
}

function parseReplaceRoleBindingCommand(value: unknown): {
  readonly projectId: string;
  readonly targetPrincipalId: string;
  readonly resourceId: string | null;
  readonly role: ManagementRole | null;
  readonly expectedEpoch: bigint;
} {
  const candidate = asRecord(value);
  const fields =
    candidate["resourceId"] === undefined
      ? ["projectId", "targetPrincipalId", "role", "expectedEpoch"]
      : ["projectId", "targetPrincipalId", "resourceId", "role", "expectedEpoch"];
  const record = strictRecord(candidate, fields);
  const role = record["role"] === null ? null : validateManagementRole(record["role"]);
  return Object.freeze({
    projectId: identifier(record["projectId"], "projectId"),
    targetPrincipalId: identifier(record["targetPrincipalId"], "targetPrincipalId"),
    resourceId:
      record["resourceId"] === undefined ? null : identifier(record["resourceId"], "resourceId"),
    role,
    expectedEpoch: epoch(record["expectedEpoch"]),
  });
}

function parseArchiveProjectCommand(value: unknown): {
  readonly projectId: string;
  readonly expectedEpoch: bigint;
} {
  const record = strictRecord(value, ["projectId", "expectedEpoch"]);
  return Object.freeze({
    projectId: identifier(record["projectId"], "projectId"),
    expectedEpoch: epoch(record["expectedEpoch"]),
  });
}

function resolvedIdentity(
  identity: VerifiedFoundationIdentity,
  principal: PrincipalRecord,
): ResolvedFoundationIdentity {
  if (principal.issuer !== identity.issuer || principal.subject !== identity.subject) {
    throw new MetadataApplicationError(
      "STORAGE_FAILURE",
      "Principal Directory returned a mismatched external identity.",
    );
  }
  if (principal.state !== "active") {
    throw new MetadataApplicationError("FORBIDDEN", "Principal is disabled.");
  }
  return Object.freeze({
    principalId: principal.principalId,
    claimsFingerprint: identity.claimsFingerprint,
    authenticatedAt: identity.authenticatedAt,
  });
}

function strictRecord(
  value: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = asRecord(value);
  const keys = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new MetadataApplicationError(
      "INVALID_INPUT",
      "Input contains missing or unsupported fields.",
    );
  }
  return record;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MetadataApplicationError("INVALID_INPUT", "Input must be an object.");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MetadataApplicationError("INVALID_INPUT", "Input must be a plain object.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new MetadataApplicationError("INVALID_INPUT", `${field} is invalid.`);
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  return boundedString(value, field, 2_048);
}

function epoch(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n) {
    throw new MetadataApplicationError("INVALID_INPUT", "expectedEpoch is invalid.");
  }
  return value;
}
