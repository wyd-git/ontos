import {
  API_NAME_PATTERN,
  NAMESPACE_PATTERN,
  MANAGEMENT_ROLE_VALUES,
  RESOURCE_FAMILY_VALUES,
  canonicalizeContractForDigest,
  parseDirectResourceContent,
  parseOntosId,
  type LinkTypeDefinition,
  type ManagementRoleValue,
  type ObjectTypeDefinition,
  type ResourceFamily,
  type ValidationIssueContract,
} from "@ontos/contracts";

export type ManagementRole = ManagementRoleValue;

export const MANAGEMENT_PERMISSIONS = Object.freeze([
  "metadata.read",
  "metadata.edit",
  "release.publish",
  "package.manage",
  "role.manage",
] as const);

export type ManagementPermission = (typeof MANAGEMENT_PERMISSIONS)[number];

export type MetadataDomainErrorCode = "INVALID_INPUT" | "INVALID_STATE";

export class MetadataDomainError extends Error {
  readonly code: MetadataDomainErrorCode;

  constructor(code: MetadataDomainErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MetadataDomainError";
    this.code = code;
  }
}

export interface ManagementRoleSnapshot {
  readonly projectRole: ManagementRole | null;
  readonly resourceRole: ManagementRole | null;
}

const apiNameExpression = new RegExp(API_NAME_PATTERN, "u");
const namespaceExpression = new RegExp(NAMESPACE_PATTERN, "u");
const roles = new Set<ManagementRole>(MANAGEMENT_ROLE_VALUES);
const resourceFamilies = new Set<ResourceFamily>(RESOURCE_FAMILY_VALUES);
const childDraftSourceStates = new Set<ResourceRevisionState>([
  "validated",
  "published",
  "deprecated",
]);
const permissions = new Set<ManagementPermission>(MANAGEMENT_PERMISSIONS);
const grants: Readonly<Record<ManagementRole, ReadonlySet<ManagementPermission>>> = Object.freeze({
  owner: new Set<ManagementPermission>(MANAGEMENT_PERMISSIONS),
  editor: new Set<ManagementPermission>(["metadata.read", "metadata.edit"]),
  viewer: new Set<ManagementPermission>(["metadata.read"]),
  executor: new Set<ManagementPermission>(),
  auditor: new Set<ManagementPermission>(),
});

export function validateProjectApiName(value: unknown): string {
  if (typeof value !== "string" || !apiNameExpression.test(value)) {
    throw new MetadataDomainError("INVALID_INPUT", "Project apiName is invalid.");
  }
  return value;
}

export type ResourceState = "active" | "deprecated" | "archived";
export type ResourceRevisionState = "draft" | "validated" | "published" | "deprecated" | "archived";
export type DirectResourceContent = ObjectTypeDefinition | LinkTypeDefinition;

export interface PreparedResourceContent {
  readonly content: DirectResourceContent;
  readonly canonicalContent: string;
}

export const METADATA_VALIDATOR_VERSION = "metadata-g2-01-v1" as const;

export type ResourceDependencyType = "property_reference" | "link_source" | "link_target";

export interface ExtractedResourceDependency {
  readonly sourceRevisionId: string;
  readonly targetRevisionId: string;
  readonly dependencyType: ResourceDependencyType;
  readonly sourcePath: string;
}

export type DependencyGraphEdge = ExtractedResourceDependency;

export interface DependencyTargetSnapshot {
  readonly revisionId: string;
  readonly resourceId: string;
  readonly projectId: string;
  readonly family: ResourceFamily;
  readonly resourceState: ResourceState;
  readonly revisionState: ResourceRevisionState;
}

export interface RevisionDefinitionValidationInput {
  readonly revisionId: string;
  readonly resourceId: string;
  readonly family: ResourceFamily;
  readonly content: unknown;
}

export interface RevisionDefinitionValidation {
  readonly content: DirectResourceContent | null;
  readonly dependencies: readonly ExtractedResourceDependency[];
  readonly issues: readonly ValidationIssueContract[];
}

export interface DependencyGraphAnalysis {
  readonly closureRevisionIds: readonly string[];
  readonly missingRevisionIds: readonly string[];
  readonly topologicalRevisionIds: readonly string[];
  readonly cyclePath: readonly string[] | null;
}

export function validateResourceNamespace(value: unknown): string {
  if (typeof value !== "string" || !namespaceExpression.test(value)) {
    throw new MetadataDomainError("INVALID_INPUT", "Resource namespace is invalid.");
  }
  return value;
}

export function validateResourceApiName(value: unknown): string {
  if (typeof value !== "string" || !apiNameExpression.test(value)) {
    throw new MetadataDomainError("INVALID_INPUT", "Resource apiName is invalid.");
  }
  return value;
}

export function validateResourceFamily(value: unknown): ResourceFamily {
  if (typeof value !== "string" || !resourceFamilies.has(value as ResourceFamily)) {
    throw new MetadataDomainError("INVALID_INPUT", "Resource family is invalid.");
  }
  return value as ResourceFamily;
}

/**
 * The strict family parser is applied before hashing or persistence. This makes
 * the canonical preimage a server-owned fact and rejects deferred families on
 * the direct Resource path.
 */
export function prepareDirectResourceContent(
  familyInput: unknown,
  contentInput: unknown,
): PreparedResourceContent {
  const family = validateResourceFamily(familyInput);
  try {
    const content = parseDirectResourceContent(family, contentInput);
    return Object.freeze({
      content,
      canonicalContent: canonicalizeContractForDigest(content),
    });
  } catch (error) {
    throw new MetadataDomainError(
      "INVALID_INPUT",
      "Resource content does not satisfy the active family contract.",
      { cause: error },
    );
  }
}

/**
 * Validates the semantic rules that need a structured report rather than a
 * request-parser failure. The strict contract parser remains the only route to
 * a typed definition, so callers cannot validate an opaque JSON document.
 */
export function validateRevisionDefinition(
  input: RevisionDefinitionValidationInput,
): RevisionDefinitionValidation {
  let content: DirectResourceContent;
  try {
    content = parseDirectResourceContent(input.family, input.content);
  } catch {
    return Object.freeze({
      content: null,
      dependencies: Object.freeze([]),
      issues: Object.freeze([
        validationIssue(
          "DEFINITION_INVALID",
          input.resourceId,
          "/",
          "The definition does not satisfy the active Resource family contract.",
          "Correct the reported definition and submit a new Draft validation.",
        ),
      ]),
    });
  }

  const issues: ValidationIssueContract[] = [];
  if (input.family === "object_type") {
    const objectType = content as ObjectTypeDefinition;
    const primaryKey = objectType.properties.find(
      (property) => property.apiName === objectType.primaryKeyPropertyApiName,
    );
    if (
      primaryKey !== undefined &&
      primaryKey.writeMode !== "source_only" &&
      primaryKey.writeMode !== "system_managed"
    ) {
      issues.push(
        validationIssue(
          "PRIMARY_KEY_WRITE_MODE_INVALID",
          input.resourceId,
          "/primaryKeyPropertyApiName",
          "The Primary Key cannot use an actor-writable overlay mode.",
          "Use source_only or system_managed for the Primary Key Property.",
        ),
      );
    }
    for (const [index, property] of objectType.properties.entries()) {
      for (const [pathIndex, pointer] of (property.jsonFilterPaths ?? []).entries()) {
        if (!isTopLevelJsonPointer(pointer)) {
          issues.push(
            validationIssue(
              "JSON_FILTER_PATH_NOT_TOP_LEVEL",
              input.resourceId,
              `/properties/${String(index)}/jsonFilterPaths/${String(pathIndex)}`,
              "A filterable JSON path must name exactly one top-level member.",
              "Register a single-segment JSON Pointer such as /status.",
            ),
          );
        }
      }
    }
  } else {
    const linkType = content as LinkTypeDefinition;
    if (
      linkType.sourceKind === "base" &&
      (linkType.actionCreateAllowed || linkType.actionDeleteAllowed)
    ) {
      issues.push(
        validationIssue(
          "LINK_BASE_ACTION_MUTATION_INVALID",
          input.resourceId,
          "/sourceKind",
          "A base-only Link cannot also declare Action-created or Action-deleted Links.",
          "Disable Action mutation flags or use overlay or mixed as the Link source.",
        ),
      );
    }
  }

  return Object.freeze({
    content,
    dependencies: extractResourceDependencies(input.revisionId, input.family, content),
    issues: sortValidationIssues(issues),
  });
}

export function extractResourceDependencies(
  sourceRevisionId: string,
  family: ResourceFamily,
  contentInput: unknown,
): readonly ExtractedResourceDependency[] {
  const content = parseDirectResourceContent(family, contentInput);
  if (family === "object_type") return Object.freeze([]);
  const link = content as LinkTypeDefinition;
  return Object.freeze(
    [
      Object.freeze({
        sourceRevisionId,
        targetRevisionId: link.source.objectTypeRevisionId,
        dependencyType: "link_source" as const,
        sourcePath: "/source/objectTypeRevisionId",
      }),
      Object.freeze({
        sourceRevisionId,
        targetRevisionId: link.target.objectTypeRevisionId,
        dependencyType: "link_target" as const,
        sourcePath: "/target/objectTypeRevisionId",
      }),
    ].sort(compareDependencyEdges),
  );
}

export function validateDependencyTargets(input: {
  readonly projectId: string;
  readonly resourceId: string;
  readonly dependencies: readonly ExtractedResourceDependency[];
  readonly targets: readonly DependencyTargetSnapshot[];
}): readonly ValidationIssueContract[] {
  const targets = new Map(input.targets.map((target) => [target.revisionId, target]));
  const issues: ValidationIssueContract[] = [];
  for (const dependency of [...input.dependencies].sort(compareDependencyEdges)) {
    const target = targets.get(dependency.targetRevisionId);
    if (target === undefined || target.projectId !== input.projectId) {
      issues.push(
        validationIssue(
          "DEPENDENCY_UNAVAILABLE",
          input.resourceId,
          dependency.sourcePath,
          "The referenced Revision is unavailable in this Project.",
          "Select a visible, validated Revision from the same Project.",
        ),
      );
      continue;
    }
    if (target.resourceState === "archived" || target.revisionState === "archived") {
      issues.push(
        validationIssue(
          "DEPENDENCY_ARCHIVED",
          input.resourceId,
          dependency.sourcePath,
          "The referenced Revision or its Resource is archived.",
          "Reference an active or supported Revision instead.",
        ),
      );
    }
    if (
      (dependency.dependencyType === "link_source" ||
        dependency.dependencyType === "link_target") &&
      target.family !== "object_type"
    ) {
      issues.push(
        validationIssue(
          "LINK_ENDPOINT_FAMILY_INVALID",
          input.resourceId,
          dependency.sourcePath,
          "A Link endpoint must reference an Object Type Revision.",
          "Select a validated Object Type Revision for this endpoint.",
        ),
      );
    }
    if (
      !new Set<ResourceRevisionState>(["validated", "published", "deprecated"]).has(
        target.revisionState,
      )
    ) {
      issues.push(
        validationIssue(
          "DEPENDENCY_NOT_VALIDATED",
          input.resourceId,
          dependency.sourcePath,
          "The referenced Revision has not reached a reusable validated state.",
          "Validate the referenced Revision before validating this definition.",
        ),
      );
    }
  }
  return sortValidationIssues(issues);
}

/**
 * Returns a dependency-first order. UUID/string comparison is the only
 * tie-breaker, so database and insertion order cannot affect the result.
 */
export function analyzeDependencyGraph(input: {
  readonly roots: readonly string[];
  readonly revisionIds: readonly string[];
  readonly edges: readonly DependencyGraphEdge[];
}): DependencyGraphAnalysis {
  const nodeIds = uniqueSorted(input.revisionIds, "Dependency graph nodes");
  const nodeSet = new Set(nodeIds);
  const roots = uniqueSorted(input.roots, "Dependency graph roots");
  const edgeKeys = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of [...input.edges].sort(compareDependencyEdges)) {
    const key = dependencyEdgeKey(edge);
    if (edgeKeys.has(key)) {
      throw new MetadataDomainError("INVALID_INPUT", "Dependency graph contains a duplicate edge.");
    }
    edgeKeys.add(key);
    const targets = adjacency.get(edge.sourceRevisionId) ?? [];
    targets.push(edge.targetRevisionId);
    adjacency.set(edge.sourceRevisionId, targets);
  }
  for (const targets of adjacency.values()) targets.sort(compareText);

  const closure = new Set<string>();
  const missing = new Set<string>();
  const pending = [...roots].sort(compareText).reverse();
  while (pending.length > 0) {
    const revisionId = pending.pop();
    if (revisionId === undefined || closure.has(revisionId)) continue;
    closure.add(revisionId);
    if (!nodeSet.has(revisionId)) missing.add(revisionId);
    const targets = adjacency.get(revisionId) ?? [];
    for (let index = targets.length - 1; index >= 0; index -= 1) {
      const target = targets[index];
      if (target !== undefined && !closure.has(target)) pending.push(target);
    }
  }

  const presentClosure = [...closure]
    .filter((revisionId) => nodeSet.has(revisionId))
    .sort(compareText);
  const dependencyCount = new Map(presentClosure.map((revisionId) => [revisionId, 0]));
  const dependents = new Map<string, string[]>();
  for (const source of presentClosure) {
    for (const target of adjacency.get(source) ?? []) {
      if (!dependencyCount.has(target)) continue;
      dependencyCount.set(source, (dependencyCount.get(source) ?? 0) + 1);
      const values = dependents.get(target) ?? [];
      values.push(source);
      dependents.set(target, values);
    }
  }
  for (const values of dependents.values()) values.sort(compareText);

  const ready = presentClosure.filter((revisionId) => dependencyCount.get(revisionId) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const revisionId = ready.shift();
    if (revisionId === undefined) break;
    order.push(revisionId);
    for (const dependent of dependents.get(revisionId) ?? []) {
      const next = (dependencyCount.get(dependent) ?? 0) - 1;
      dependencyCount.set(dependent, next);
      if (next === 0) insertSorted(ready, dependent);
    }
  }

  const cyclePath =
    order.length === presentClosure.length ? null : findStableCycle(presentClosure, adjacency);
  return Object.freeze({
    closureRevisionIds: Object.freeze([...closure].sort(compareText)),
    missingRevisionIds: Object.freeze([...missing].sort(compareText)),
    topologicalRevisionIds: Object.freeze(cyclePath === null ? order : []),
    cyclePath: cyclePath === null ? null : Object.freeze(cyclePath),
  });
}

export function sortValidationIssues(
  issues: readonly ValidationIssueContract[],
): readonly ValidationIssueContract[] {
  return Object.freeze(
    [...issues].sort(
      (left, right) =>
        compareText(left.resourceId, right.resourceId) ||
        compareText(left.path, right.path) ||
        compareText(left.code, right.code) ||
        compareText(left.severity, right.severity) ||
        compareText(left.message, right.message) ||
        compareText(left.remediation, right.remediation),
    ),
  );
}

export function assertResourceStateTransition(current: ResourceState, target: ResourceState): void {
  if (current === target) return;
  const allowed: Readonly<Record<ResourceState, readonly ResourceState[]>> = {
    active: ["deprecated", "archived"],
    deprecated: ["archived"],
    archived: [],
  };
  if (!allowed[current].includes(target)) {
    throw new MetadataDomainError(
      "INVALID_STATE",
      `Resource cannot transition from ${current} to ${target}.`,
    );
  }
}

export function assertResourceRevisionStateTransition(
  current: ResourceRevisionState,
  target: ResourceRevisionState,
): void {
  if (current === target) return;
  const allowed: Readonly<Record<ResourceRevisionState, readonly ResourceRevisionState[]>> = {
    draft: ["validated"],
    validated: ["published"],
    published: ["deprecated"],
    deprecated: ["archived"],
    archived: [],
  };
  if (!allowed[current].includes(target)) {
    throw new MetadataDomainError(
      "INVALID_STATE",
      `Resource Revision cannot transition from ${current} to ${target}.`,
    );
  }
}

export function assertChildDraftSourceState(state: ResourceRevisionState): void {
  if (!childDraftSourceStates.has(state)) {
    throw new MetadataDomainError(
      "INVALID_STATE",
      "Only a Validated, Published or Deprecated Revision can create a child Draft.",
    );
  }
}

export function validateDisplayName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 160) {
    throw new MetadataDomainError("INVALID_INPUT", "displayName is invalid.");
  }
  return value;
}

export function validateManagementRole(value: unknown): ManagementRole {
  if (typeof value !== "string" || !roles.has(value as ManagementRole)) {
    throw new MetadataDomainError("INVALID_INPUT", "Management role is invalid.");
  }
  return value as ManagementRole;
}

export function validateManagementPermission(value: unknown): ManagementPermission {
  if (typeof value !== "string" || !permissions.has(value as ManagementPermission)) {
    throw new MetadataDomainError("INVALID_INPUT", "Management permission is invalid.");
  }
  return value as ManagementPermission;
}

/**
 * Resource bindings are optional narrowing facts. A missing resource binding
 * preserves the Project grant; a present binding is intersected with it.
 */
export function isManagementPermissionAllowed(
  snapshot: ManagementRoleSnapshot,
  permission: ManagementPermission,
  resourceScoped: boolean,
): boolean {
  if (snapshot.projectRole === null || !grants[snapshot.projectRole].has(permission)) {
    return false;
  }
  if (!resourceScoped || snapshot.resourceRole === null) return true;
  return grants[snapshot.resourceRole].has(permission);
}

export function permissionsForRole(role: ManagementRole): ReadonlySet<ManagementPermission> {
  return grants[role];
}

function validationIssue(
  code: string,
  resourceId: string,
  path: string,
  message: string,
  remediation: string,
): ValidationIssueContract {
  return Object.freeze({
    code,
    severity: "error",
    resourceId: parseOntosId(resourceId, "$validationIssue.resourceId"),
    path,
    message,
    remediation,
  });
}

function isTopLevelJsonPointer(value: string): boolean {
  return /^\/(?:[^~/]|~0|~1)+$/u.test(value);
}

function compareDependencyEdges(
  left: ExtractedResourceDependency,
  right: ExtractedResourceDependency,
): number {
  return (
    compareText(left.sourceRevisionId, right.sourceRevisionId) ||
    compareText(left.dependencyType, right.dependencyType) ||
    compareText(left.sourcePath, right.sourcePath) ||
    compareText(left.targetRevisionId, right.targetRevisionId)
  );
}

function dependencyEdgeKey(edge: ExtractedResourceDependency): string {
  return [edge.sourceRevisionId, edge.targetRevisionId, edge.dependencyType, edge.sourcePath].join(
    "\u0000",
  );
}

function uniqueSorted(values: readonly string[], label: string): string[] {
  const sorted = [...values].sort(compareText);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) {
      throw new MetadataDomainError("INVALID_INPUT", `${label} contain a duplicate value.`);
    }
  }
  return sorted;
}

function insertSorted(values: string[], value: string): void {
  let lower = 0;
  let upper = values.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (compareText(values[middle] ?? "", value) < 0) lower = middle + 1;
    else upper = middle;
  }
  values.splice(lower, 0, value);
}

function findStableCycle(
  revisionIds: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): readonly string[] | null {
  const allowed = new Set(revisionIds);
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  const visit = (revisionId: string): readonly string[] | null => {
    state.set(revisionId, "visiting");
    stackIndex.set(revisionId, stack.length);
    stack.push(revisionId);
    for (const target of adjacency.get(revisionId) ?? []) {
      if (!allowed.has(target)) continue;
      if (state.get(target) === "visiting") {
        const start = stackIndex.get(target);
        if (start === undefined) continue;
        return canonicalCycle([...stack.slice(start), target]);
      }
      if (state.get(target) !== "visited") {
        const nested = visit(target);
        if (nested !== null) return nested;
      }
    }
    stack.pop();
    stackIndex.delete(revisionId);
    state.set(revisionId, "visited");
    return null;
  };

  for (const revisionId of [...revisionIds].sort(compareText)) {
    if (state.has(revisionId)) continue;
    const cycle = visit(revisionId);
    if (cycle !== null) return cycle;
  }
  return null;
}

function canonicalCycle(path: readonly string[]): readonly string[] {
  const cycle = path.slice(0, -1);
  let minimumIndex = 0;
  for (let index = 1; index < cycle.length; index += 1) {
    if (compareText(cycle[index] ?? "", cycle[minimumIndex] ?? "") < 0) minimumIndex = index;
  }
  const rotated = [...cycle.slice(minimumIndex), ...cycle.slice(0, minimumIndex)];
  const first = rotated[0];
  return first === undefined ? [] : [...rotated, first];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
