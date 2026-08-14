import {
  parseArtifactDigest,
  parseCanonicalInstant,
  parseOntosId,
  type ArtifactDigest,
  type CanonicalInstant,
  type ResourceFamily,
} from "@ontos/contracts";
import {
  MetadataDomainError,
  isManagementPermissionAllowed,
  prepareDirectResourceContent,
  validateDisplayName,
  validateManagementPermission,
  validateManagementRole,
  validateProjectApiName,
  validateResourceApiName,
  validateResourceFamily,
  validateResourceNamespace,
  type DirectResourceContent,
  type ManagementPermission,
  type ManagementRole,
  type PreparedResourceContent,
  type ResourceRevisionState,
  type ResourceState,
} from "@ontos/metadata-domain";

export type MetadataApplicationErrorCode =
  | "ALREADY_EXISTS"
  | "CONCURRENT_MODIFICATION"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "INVALID_STATE"
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

export interface ResourceRecord {
  readonly resourceId: string;
  readonly projectId: string;
  readonly namespace: string;
  readonly apiName: string;
  readonly family: ResourceFamily;
  readonly state: ResourceState;
  readonly createdAt: string;
}

export interface ResourceRevisionRecord {
  readonly revisionId: string;
  readonly resourceId: string;
  readonly parentRevisionId: string | null;
  readonly revisionNumber: bigint;
  readonly family: ResourceFamily;
  readonly state: ResourceRevisionState;
  readonly etag: bigint;
  readonly contentDigest: ArtifactDigest;
  readonly content: DirectResourceContent;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
}

export interface ResourceCreation {
  readonly resource: ResourceRecord;
  readonly initialDraft: ResourceRevisionRecord;
}

export interface ResourceScopeRecord {
  readonly projectId: string;
  readonly resourceId: string;
}

export interface RevisionScopeRecord extends ResourceScopeRecord {
  readonly family: ResourceFamily;
}

export interface ResourceListCursor {
  readonly namespace: string;
  readonly apiName: string;
  readonly resourceId: string;
}

export interface RevisionListCursor {
  readonly revisionNumber: bigint;
  readonly revisionId: string;
}

export interface MetadataPage<Item, Cursor> {
  readonly items: readonly Item[];
  readonly nextCursor: Cursor | null;
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

export interface ResourceLifecycleRepository {
  createResourceWithInitialDraft(input: {
    readonly projectId: string;
    readonly namespace: string;
    readonly apiName: string;
    readonly family: ResourceFamily;
    readonly authorPrincipalId: string;
    readonly content: PreparedResourceContent;
  }): Promise<ResourceCreation>;
  readResourceScope(resourceId: string): Promise<ResourceScopeRecord>;
  readRevisionScope(revisionId: string): Promise<RevisionScopeRecord>;
  getResource(resourceId: string): Promise<ResourceRecord>;
  listResources(input: {
    readonly projectId: string;
    readonly limit: number;
    readonly after: ResourceListCursor | null;
  }): Promise<MetadataPage<ResourceRecord, ResourceListCursor>>;
  getRevision(revisionId: string): Promise<ResourceRevisionRecord>;
  listRevisions(input: {
    readonly resourceId: string;
    readonly limit: number;
    readonly after: RevisionListCursor | null;
  }): Promise<MetadataPage<ResourceRevisionRecord, RevisionListCursor>>;
  patchDraftRevision(input: {
    readonly revisionId: string;
    readonly expectedEtag: bigint;
    readonly content: PreparedResourceContent;
  }): Promise<ResourceRevisionRecord>;
  createChildDraft(input: {
    readonly sourceRevisionId: string;
    readonly authorPrincipalId: string;
    readonly content: PreparedResourceContent;
  }): Promise<ResourceRevisionRecord>;
  transitionResourceState(input: {
    readonly resourceId: string;
    readonly targetState: ResourceState;
  }): Promise<ResourceRecord>;
  transitionRevisionState(input: {
    readonly revisionId: string;
    readonly targetState: ResourceRevisionState;
  }): Promise<ResourceRevisionRecord>;
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

export interface ResourceLifecycleApplicationServiceOptions {
  readonly principals: PrincipalDirectory;
  readonly resources: ResourceLifecycleRepository;
  readonly authorizer: ManagementAuthorizer;
}

export class ResourceLifecycleApplicationService {
  readonly #principals: PrincipalDirectory;
  readonly #resources: ResourceLifecycleRepository;
  readonly #authorizer: ManagementAuthorizer;

  constructor(options: ResourceLifecycleApplicationServiceOptions) {
    this.#principals = options.principals;
    this.#resources = options.resources;
    this.#authorizer = options.authorizer;
  }

  async createResource(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ResourceCreation> {
    const identity = parseVerifiedFoundationIdentity(identityInput);
    const command = parseCreateResourceCommand(commandInput);
    const resolved = await this.#resolveIdentity(identity);
    await this.#requirePermission(resolved, {
      projectId: command.projectId,
      permission: "metadata.edit",
    });
    return this.#resources.createResourceWithInitialDraft({
      ...command,
      authorPrincipalId: resolved.principalId,
    });
  }

  async getResource(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ResourceRecord> {
    const identity = parseVerifiedFoundationIdentity(identityInput);
    const { resourceId } = parseResourceIdentifierCommand(commandInput);
    const resolved = await this.#resolveIdentity(identity);
    const scope = await this.#resources.readResourceScope(resourceId);
    await this.#requirePermission(resolved, {
      ...scope,
      permission: "metadata.read",
    });
    return this.#resources.getResource(resourceId);
  }

  async listResources(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<MetadataPage<ResourceRecord, ResourceListCursor>> {
    const identity = parseVerifiedFoundationIdentity(identityInput);
    const command = parseListResourcesCommand(commandInput);
    const resolved = await this.#resolveIdentity(identity);
    await this.#requirePermission(resolved, {
      projectId: command.projectId,
      permission: "metadata.read",
    });
    return this.#resources.listResources(command);
  }

  async getRevision(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ResourceRevisionRecord> {
    const identity = parseVerifiedFoundationIdentity(identityInput);
    const { revisionId } = parseRevisionIdentifierCommand(commandInput);
    const resolved = await this.#resolveIdentity(identity);
    const scope = await this.#resources.readRevisionScope(revisionId);
    await this.#requirePermission(resolved, {
      ...scope,
      permission: "metadata.read",
    });
    return this.#resources.getRevision(revisionId);
  }

  async listRevisions(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<MetadataPage<ResourceRevisionRecord, RevisionListCursor>> {
    const identity = parseVerifiedFoundationIdentity(identityInput);
    const command = parseListRevisionsCommand(commandInput);
    const resolved = await this.#resolveIdentity(identity);
    const scope = await this.#resources.readResourceScope(command.resourceId);
    await this.#requirePermission(resolved, {
      ...scope,
      permission: "metadata.read",
    });
    return this.#resources.listRevisions(command);
  }

  async patchDraftRevision(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ResourceRevisionRecord> {
    const identity = parseVerifiedFoundationIdentity(identityInput);
    const command = parsePatchDraftRevisionCommand(commandInput);
    const resolved = await this.#resolveIdentity(identity);
    const scope = await this.#resources.readRevisionScope(command.revisionId);
    await this.#requirePermission(resolved, {
      ...scope,
      permission: "metadata.edit",
    });
    return this.#resources.patchDraftRevision({
      revisionId: command.revisionId,
      expectedEtag: command.expectedEtag,
      content: prepareContent(scope.family, command.content),
    });
  }

  async createChildDraft(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ResourceRevisionRecord> {
    const identity = parseVerifiedFoundationIdentity(identityInput);
    const command = parseCreateChildDraftCommand(commandInput);
    const resolved = await this.#resolveIdentity(identity);
    const scope = await this.#resources.readRevisionScope(command.sourceRevisionId);
    await this.#requirePermission(resolved, {
      ...scope,
      permission: "metadata.edit",
    });
    return this.#resources.createChildDraft({
      sourceRevisionId: command.sourceRevisionId,
      authorPrincipalId: resolved.principalId,
      content: prepareContent(scope.family, command.content),
    });
  }

  async deprecateResource(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ResourceRecord> {
    return this.#transitionResource(identityInput, commandInput, "deprecated");
  }

  async archiveResource(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ResourceRecord> {
    return this.#transitionResource(identityInput, commandInput, "archived");
  }

  async deprecateRevision(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ResourceRevisionRecord> {
    return this.#transitionRevision(identityInput, commandInput, "deprecated");
  }

  async archiveRevision(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
  ): Promise<ResourceRevisionRecord> {
    return this.#transitionRevision(identityInput, commandInput, "archived");
  }

  async #transitionResource(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
    targetState: ResourceState,
  ): Promise<ResourceRecord> {
    const identity = parseVerifiedFoundationIdentity(identityInput);
    const { resourceId } = parseResourceIdentifierCommand(commandInput);
    const resolved = await this.#resolveIdentity(identity);
    const scope = await this.#resources.readResourceScope(resourceId);
    await this.#requirePermission(resolved, {
      ...scope,
      permission: "metadata.edit",
    });
    return this.#resources.transitionResourceState({ resourceId, targetState });
  }

  async #transitionRevision(
    identityInput: VerifiedFoundationIdentity,
    commandInput: unknown,
    targetState: ResourceRevisionState,
  ): Promise<ResourceRevisionRecord> {
    const identity = parseVerifiedFoundationIdentity(identityInput);
    const { revisionId } = parseRevisionIdentifierCommand(commandInput);
    const resolved = await this.#resolveIdentity(identity);
    const scope = await this.#resources.readRevisionScope(revisionId);
    await this.#requirePermission(resolved, {
      ...scope,
      permission: "metadata.edit",
    });
    return this.#resources.transitionRevisionState({ revisionId, targetState });
  }

  async #resolveIdentity(
    identity: VerifiedFoundationIdentity,
  ): Promise<ResolvedFoundationIdentity> {
    const principal = await this.#principals.resolveVerifiedIdentity(identity);
    return resolvedIdentity(identity, principal);
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

function parseCreateResourceCommand(value: unknown): {
  readonly projectId: string;
  readonly namespace: string;
  readonly apiName: string;
  readonly family: ResourceFamily;
  readonly content: PreparedResourceContent;
} {
  const record = strictRecord(value, ["projectId", "namespace", "apiName", "family", "content"]);
  const family = domainValue(() => validateResourceFamily(record["family"]));
  return Object.freeze({
    projectId: ontosIdentifier(record["projectId"], "projectId"),
    namespace: domainValue(() => validateResourceNamespace(record["namespace"])),
    apiName: domainValue(() => validateResourceApiName(record["apiName"])),
    family,
    content: prepareContent(family, record["content"]),
  });
}

function parseResourceIdentifierCommand(value: unknown): { readonly resourceId: string } {
  const record = strictRecord(value, ["resourceId"]);
  return Object.freeze({ resourceId: ontosIdentifier(record["resourceId"], "resourceId") });
}

function parseRevisionIdentifierCommand(value: unknown): { readonly revisionId: string } {
  const record = strictRecord(value, ["revisionId"]);
  return Object.freeze({ revisionId: ontosIdentifier(record["revisionId"], "revisionId") });
}

function parseListResourcesCommand(value: unknown): {
  readonly projectId: string;
  readonly limit: number;
  readonly after: ResourceListCursor | null;
} {
  const candidate = asRecord(value);
  const fields = [
    "projectId",
    ...(candidate["limit"] === undefined ? [] : ["limit"]),
    ...(candidate["after"] === undefined ? [] : ["after"]),
  ];
  const record = strictRecord(candidate, fields);
  return Object.freeze({
    projectId: ontosIdentifier(record["projectId"], "projectId"),
    limit: pageLimit(record["limit"]),
    after: record["after"] === undefined ? null : parseResourceListCursor(record["after"]),
  });
}

function parseResourceListCursor(value: unknown): ResourceListCursor {
  const record = strictRecord(value, ["namespace", "apiName", "resourceId"]);
  return Object.freeze({
    namespace: domainValue(() => validateResourceNamespace(record["namespace"])),
    apiName: domainValue(() => validateResourceApiName(record["apiName"])),
    resourceId: ontosIdentifier(record["resourceId"], "after.resourceId"),
  });
}

function parseListRevisionsCommand(value: unknown): {
  readonly resourceId: string;
  readonly limit: number;
  readonly after: RevisionListCursor | null;
} {
  const candidate = asRecord(value);
  const fields = [
    "resourceId",
    ...(candidate["limit"] === undefined ? [] : ["limit"]),
    ...(candidate["after"] === undefined ? [] : ["after"]),
  ];
  const record = strictRecord(candidate, fields);
  return Object.freeze({
    resourceId: ontosIdentifier(record["resourceId"], "resourceId"),
    limit: pageLimit(record["limit"]),
    after: record["after"] === undefined ? null : parseRevisionListCursor(record["after"]),
  });
}

function parseRevisionListCursor(value: unknown): RevisionListCursor {
  const record = strictRecord(value, ["revisionNumber", "revisionId"]);
  return Object.freeze({
    revisionNumber: positiveBigint(record["revisionNumber"], "after.revisionNumber"),
    revisionId: ontosIdentifier(record["revisionId"], "after.revisionId"),
  });
}

function parsePatchDraftRevisionCommand(value: unknown): {
  readonly revisionId: string;
  readonly expectedEtag: bigint;
  readonly content: unknown;
} {
  const record = strictRecord(value, ["revisionId", "expectedEtag", "content"]);
  return Object.freeze({
    revisionId: ontosIdentifier(record["revisionId"], "revisionId"),
    expectedEtag: positiveBigint(record["expectedEtag"], "expectedEtag"),
    content: record["content"],
  });
}

function parseCreateChildDraftCommand(value: unknown): {
  readonly sourceRevisionId: string;
  readonly content: unknown;
} {
  const record = strictRecord(value, ["sourceRevisionId", "content"]);
  return Object.freeze({
    sourceRevisionId: ontosIdentifier(record["sourceRevisionId"], "sourceRevisionId"),
    content: record["content"],
  });
}

function prepareContent(family: ResourceFamily, content: unknown): PreparedResourceContent {
  return domainValue(() => prepareDirectResourceContent(family, content));
}

function domainValue<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof MetadataDomainError) {
      throw new MetadataApplicationError(error.code, error.message, { cause: error });
    }
    throw error;
  }
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

function ontosIdentifier(value: unknown, field: string): string {
  try {
    return parseOntosId(value, `$command.${field}`);
  } catch (error) {
    throw new MetadataApplicationError("INVALID_INPUT", `${field} is invalid.`, { cause: error });
  }
}

function pageLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) {
    throw new MetadataApplicationError("INVALID_INPUT", "limit must be an integer from 1 to 100.");
  }
  return value as number;
}

function positiveBigint(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value < 1n) {
    throw new MetadataApplicationError("INVALID_INPUT", `${field} must be a positive bigint.`);
  }
  return value;
}

function epoch(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n) {
    throw new MetadataApplicationError("INVALID_INPUT", "expectedEpoch is invalid.");
  }
  return value;
}
