import { createHash } from "node:crypto";

export type IndexPlanErrorCode =
  | "INDEX_AUTO_PROPERTY_FORBIDDEN"
  | "INDEX_CAPABILITY_UNCOVERED"
  | "INDEX_DECLARATION_DUPLICATE"
  | "INDEX_DECLARATION_INVALID"
  | "INDEX_EVIDENCE_REQUIRED"
  | "INDEX_HARD_LIMIT_EXCEEDED"
  | "INDEX_INVENTORY_INCOMPLETE"
  | "INDEX_NAME_COLLISION"
  | "INDEX_PLAN_PROPERTY_NOT_DECLARED"
  | "INDEX_PROJECT_BUDGET_EXCEEDED"
  | "INDEX_RELEASE_BUDGET_EXCEEDED"
  | "INDEX_TYPE_BUDGET_EXCEEDED";

export class IndexPlanError extends Error {
  readonly code: IndexPlanErrorCode;

  constructor(code: IndexPlanErrorCode, message: string) {
    super(message);
    this.name = "IndexPlanError";
    this.code = code;
  }
}

export type PropertyType =
  | "string"
  | "string[]"
  | "enum"
  | "integer"
  | "decimal"
  | "date"
  | "timestamp"
  | "boolean"
  | "json";

export interface RegisteredJsonPath {
  path: string;
  valueType: Exclude<PropertyType, "string[]" | "json">;
  filterable: boolean;
}

export interface PropertyIndexMetadata {
  propertyId: string;
  type: PropertyType;
  primaryKey?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  searchable?: boolean;
  unique?: boolean;
  registeredJsonPaths?: readonly RegisteredJsonPath[];
}

export interface BtreeIndexKey {
  propertyId: string;
  jsonPath?: string;
  direction?: "ASC" | "DESC";
}

export type IndexDeclaration =
  | {
      kind: "btree";
      keys: readonly BtreeIndexKey[];
      unique?: boolean;
      evidenceRefs: readonly string[];
    }
  | {
      kind: "gin_trigram";
      propertyId: string;
      evidenceRefs: readonly string[];
    }
  | {
      kind: "gin_array";
      propertyId: string;
      evidenceRefs: readonly string[];
    };

export interface ObjectTypeIndexPlanInput {
  resourceId: string;
  revisionId: string;
  displayName?: string;
  properties: readonly PropertyIndexMetadata[];
  indexes: readonly IndexDeclaration[];
}

export interface ReleaseIndexPlanInput {
  projectId: string;
  releaseId: string;
  evidenceCatalog: readonly string[];
  objectTypes: readonly ObjectTypeIndexPlanInput[];
  autoIndexAllProperties?: boolean;
}

export interface CompiledIndexDefinition {
  name: string;
  physicalSignature: string;
  table: "runtime.object_current";
  resourceId: string;
  revisionId: string;
  predicate: {
    objectTypeResourceId: string;
    objectTypeRevisionId: string;
    lifecycleState: "active";
  };
  kind: IndexDeclaration["kind"];
  unitCost: number;
  evidenceRefs: string[];
  keys: BtreeIndexKey[];
}

export interface CompiledObjectTypeIndexPlan {
  resourceId: string;
  revisionId: string;
  secondaryIndexUnits: number;
  indexes: CompiledIndexDefinition[];
}

export interface CompiledReleaseIndexPlan {
  projectId: string;
  releaseId: string;
  secondaryIndexUnits: number;
  physicalIndexCount: number;
  objectTypes: CompiledObjectTypeIndexPlan[];
  indexes: CompiledIndexDefinition[];
}

export interface IndexBudgetPolicy {
  maxSecondaryUnitsPerObjectType: number;
  normalMaxSecondaryUnitsPerRelease: number;
  hardMaxSecondaryUnitsPerRelease: number;
  normalMaxProjectUnionUnits: number;
  hardMaxProjectUnionUnits: number;
  normalMaxProjectPhysicalIndexes: number;
  hardMaxProjectPhysicalIndexes: number;
  maximumApprovalMs: number;
  minimumRetirementReclaimMs: number;
}

export const defaultIndexBudgetPolicy: IndexBudgetPolicy = {
  maxSecondaryUnitsPerObjectType: 13,
  normalMaxSecondaryUnitsPerRelease: 80,
  hardMaxSecondaryUnitsPerRelease: 104,
  normalMaxProjectUnionUnits: 120,
  hardMaxProjectUnionUnits: 240,
  normalMaxProjectPhysicalIndexes: 80,
  hardMaxProjectPhysicalIndexes: 160,
  maximumApprovalMs: 30 * 24 * 60 * 60 * 1_000,
  minimumRetirementReclaimMs: 7 * 24 * 60 * 60 * 1_000,
};

export interface IndexCapacityApproval {
  id: string;
  projectId: string;
  approvedAt: number;
  expiresAt: number;
  maximumReleaseUnits: number;
  maximumProjectUnionUnits: number;
  maximumProjectPhysicalIndexes: number;
  retirementReleaseIds: readonly string[];
  supportUntilByReleaseId: Readonly<Record<string, number>>;
}

export interface IndexAdmissionReport {
  accepted: boolean;
  admissionMode: "WITHIN_NORMAL" | "NON_EXPANDING_OVERAGE" | "APPROVED_OVERAGE";
  releaseUnits: number;
  projectUnionUnits: number;
  projectPhysicalIndexCount: number;
  normalLimitExceeded: boolean;
  approvalId: string | null;
}

export type RetainedIndexPlanReason = "SERVING" | "RECENT_SUCCESS" | "PROTECTED" | "STAGING";

export interface RetainedIndexPlan {
  plan: CompiledReleaseIndexPlan;
  reasons: readonly RetainedIndexPlanReason[];
}

export interface ProjectIndexInventory {
  complete: boolean;
  retainedPlans: readonly RetainedIndexPlan[];
}

const scalarBtreeTypes: ReadonlySet<PropertyType> = new Set([
  "string",
  "enum",
  "integer",
  "decimal",
  "date",
  "timestamp",
  "boolean",
]);

export function compileReleaseIndexPlan(
  input: ReleaseIndexPlanInput,
  policy: IndexBudgetPolicy = defaultIndexBudgetPolicy,
): CompiledReleaseIndexPlan {
  assertIndexBudgetPolicy(policy);
  if (input.autoIndexAllProperties === true) {
    fail(
      "INDEX_AUTO_PROPERTY_FORBIDDEN",
      "Index Plans must be derived from explicit query capabilities and evidence, never all Properties.",
    );
  }
  if (input.objectTypes.length === 0) {
    fail("INDEX_DECLARATION_INVALID", "A Release Index Plan needs at least one Object Type.");
  }
  const evidenceCatalog = new Set(input.evidenceCatalog.map((item) => item.trim()));
  if (
    evidenceCatalog.has("") ||
    evidenceCatalog.size !== input.evidenceCatalog.length ||
    evidenceCatalog.size === 0
  ) {
    fail(
      "INDEX_EVIDENCE_REQUIRED",
      "A Release Index Plan needs a non-empty, duplicate-free evidence catalog.",
    );
  }

  const resourceIds = new Set<string>();
  const compiledObjectTypes: CompiledObjectTypeIndexPlan[] = [];
  const names = new Map<string, string>();
  for (const objectType of input.objectTypes) {
    if (resourceIds.has(objectType.resourceId)) {
      fail("INDEX_DECLARATION_DUPLICATE", `Object Type ${objectType.resourceId} appears twice.`);
    }
    resourceIds.add(objectType.resourceId);
    const compiled = compileObjectType(objectType, evidenceCatalog, policy);
    for (const index of compiled.indexes) {
      const existing = names.get(index.name);
      if (existing !== undefined && existing !== index.physicalSignature) {
        fail("INDEX_NAME_COLLISION", `Index name ${index.name} maps to two signatures.`);
      }
      names.set(index.name, index.physicalSignature);
    }
    compiledObjectTypes.push(compiled);
  }

  const indexes = compiledObjectTypes.flatMap((objectType) => objectType.indexes);
  const secondaryIndexUnits = compiledObjectTypes.reduce(
    (sum, objectType) => sum + objectType.secondaryIndexUnits,
    0,
  );
  if (secondaryIndexUnits > policy.hardMaxSecondaryUnitsPerRelease) {
    fail(
      "INDEX_HARD_LIMIT_EXCEEDED",
      `Release ${input.releaseId} needs ${secondaryIndexUnits} units; hard limit is ${policy.hardMaxSecondaryUnitsPerRelease}.`,
    );
  }

  return {
    projectId: input.projectId,
    releaseId: input.releaseId,
    secondaryIndexUnits,
    physicalIndexCount: indexes.length,
    objectTypes: compiledObjectTypes,
    indexes,
  };
}

export function admitIndexPlan(
  candidate: CompiledReleaseIndexPlan,
  inventory: ProjectIndexInventory,
  at: number,
  approval?: IndexCapacityApproval,
  policy: IndexBudgetPolicy = defaultIndexBudgetPolicy,
): IndexAdmissionReport {
  assertIndexBudgetPolicy(policy);
  if (!inventory.complete) {
    fail(
      "INDEX_INVENTORY_INCOMPLETE",
      "Index admission requires a complete inventory of serving, recent, protected and Staging plans.",
    );
  }
  const plans = [candidate, ...inventory.retainedPlans.map((item) => item.plan)];
  if (plans.some((plan) => plan.projectId !== candidate.projectId)) {
    fail("INDEX_DECLARATION_INVALID", "Project Index admission cannot span projects.");
  }
  const conflictingSameRelease = inventory.retainedPlans.find(
    (item) =>
      item.plan.releaseId === candidate.releaseId && !samePhysicalPlan(item.plan, candidate),
  );
  if (conflictingSameRelease !== undefined) {
    fail(
      "INDEX_DECLARATION_INVALID",
      `Immutable Release ${candidate.releaseId} cannot change its physical Index Plan.`,
    );
  }
  const uniqueIndexes = new Map<string, CompiledIndexDefinition>();
  for (const plan of plans) {
    for (const index of plan.indexes) uniqueIndexes.set(index.physicalSignature, index);
  }
  const projectUnionUnits = [...uniqueIndexes.values()].reduce(
    (sum, index) => sum + index.unitCost,
    0,
  );
  const projectPhysicalIndexCount = uniqueIndexes.size;
  const retainedUniqueIndexes = uniquePhysicalIndexes(
    inventory.retainedPlans.map((item) => item.plan),
  );
  const retainedProjectUnionUnits = [...retainedUniqueIndexes.values()].reduce(
    (sum, index) => sum + index.unitCost,
    0,
  );

  if (
    candidate.secondaryIndexUnits > policy.hardMaxSecondaryUnitsPerRelease ||
    projectUnionUnits > policy.hardMaxProjectUnionUnits ||
    projectPhysicalIndexCount > policy.hardMaxProjectPhysicalIndexes
  ) {
    fail("INDEX_HARD_LIMIT_EXCEEDED", "Index Plan exceeds a non-approvable hard limit.");
  }

  const normalLimitExceeded =
    candidate.secondaryIndexUnits > policy.normalMaxSecondaryUnitsPerRelease ||
    projectUnionUnits > policy.normalMaxProjectUnionUnits ||
    projectPhysicalIndexCount > policy.normalMaxProjectPhysicalIndexes;
  if (!normalLimitExceeded) {
    return {
      accepted: true,
      admissionMode: "WITHIN_NORMAL",
      releaseUnits: candidate.secondaryIndexUnits,
      projectUnionUnits,
      projectPhysicalIndexCount,
      normalLimitExceeded: false,
      approvalId: null,
    };
  }
  if (approval === undefined) {
    const sameReleasePlanRetained = inventory.retainedPlans.some(
      (item) =>
        item.plan.releaseId === candidate.releaseId && samePhysicalPlan(item.plan, candidate),
    );
    const releaseDoesNotIntroduceOverage =
      candidate.secondaryIndexUnits <= policy.normalMaxSecondaryUnitsPerRelease ||
      sameReleasePlanRetained;
    const projectDoesNotExpand =
      projectUnionUnits <= retainedProjectUnionUnits &&
      projectPhysicalIndexCount <= retainedUniqueIndexes.size;
    if (releaseDoesNotIntroduceOverage && projectDoesNotExpand) {
      return {
        accepted: true,
        admissionMode: "NON_EXPANDING_OVERAGE",
        releaseUnits: candidate.secondaryIndexUnits,
        projectUnionUnits,
        projectPhysicalIndexCount,
        normalLimitExceeded: true,
        approvalId: null,
      };
    }
    const code =
      candidate.secondaryIndexUnits > policy.normalMaxSecondaryUnitsPerRelease
        ? "INDEX_RELEASE_BUDGET_EXCEEDED"
        : "INDEX_PROJECT_BUDGET_EXCEEDED";
    fail(code, "Index Plan exceeds its normal budget and has no valid capacity approval.");
  }
  validateIndexApproval(
    candidate,
    inventory,
    projectUnionUnits,
    projectPhysicalIndexCount,
    at,
    approval,
    policy,
  );
  return {
    accepted: true,
    admissionMode: "APPROVED_OVERAGE",
    releaseUnits: candidate.secondaryIndexUnits,
    projectUnionUnits,
    projectPhysicalIndexCount,
    normalLimitExceeded: true,
    approvalId: approval.id,
  };
}

function uniquePhysicalIndexes(
  plans: readonly CompiledReleaseIndexPlan[],
): Map<string, CompiledIndexDefinition> {
  const result = new Map<string, CompiledIndexDefinition>();
  for (const plan of plans) {
    for (const index of plan.indexes) result.set(index.physicalSignature, index);
  }
  return result;
}

function samePhysicalPlan(
  left: CompiledReleaseIndexPlan,
  right: CompiledReleaseIndexPlan,
): boolean {
  if (left.secondaryIndexUnits !== right.secondaryIndexUnits) return false;
  const leftSignatures = left.indexes.map((index) => index.physicalSignature).sort();
  const rightSignatures = right.indexes.map((index) => index.physicalSignature).sort();
  return (
    leftSignatures.length === rightSignatures.length &&
    leftSignatures.every((signature, index) => signature === rightSignatures[index])
  );
}

function compileObjectType(
  input: ObjectTypeIndexPlanInput,
  evidenceCatalog: ReadonlySet<string>,
  policy: IndexBudgetPolicy,
): CompiledObjectTypeIndexPlan {
  const properties = new Map<string, PropertyIndexMetadata>();
  let primaryKeyCount = 0;
  for (const property of input.properties) {
    if (properties.has(property.propertyId)) {
      fail("INDEX_DECLARATION_DUPLICATE", `Property ${property.propertyId} appears twice.`);
    }
    if (property.primaryKey === true) primaryKeyCount += 1;
    validatePropertyMetadata(property);
    properties.set(property.propertyId, property);
  }
  if (primaryKeyCount !== 1) {
    fail("INDEX_DECLARATION_INVALID", "Each Object Type must declare exactly one Primary Key.");
  }

  const signatures = new Set<string>();
  const compiled: CompiledIndexDefinition[] = [];
  for (const declaration of input.indexes) {
    const result = compileDeclaration(input, properties, declaration, evidenceCatalog);
    if (signatures.has(result.physicalSignature)) {
      fail("INDEX_DECLARATION_DUPLICATE", `Duplicate index ${result.physicalSignature}.`);
    }
    signatures.add(result.physicalSignature);
    compiled.push(result);
  }
  assertCapabilitiesCovered(input, properties, compiled);

  const secondaryIndexUnits = compiled.reduce((sum, index) => sum + index.unitCost, 0);
  if (secondaryIndexUnits > policy.maxSecondaryUnitsPerObjectType) {
    fail(
      "INDEX_TYPE_BUDGET_EXCEEDED",
      `Object Type ${input.resourceId} needs ${secondaryIndexUnits} units; limit is ${policy.maxSecondaryUnitsPerObjectType}.`,
    );
  }
  return {
    resourceId: input.resourceId,
    revisionId: input.revisionId,
    secondaryIndexUnits,
    indexes: compiled,
  };
}

function compileDeclaration(
  objectType: ObjectTypeIndexPlanInput,
  properties: ReadonlyMap<string, PropertyIndexMetadata>,
  declaration: IndexDeclaration,
  evidenceCatalog: ReadonlySet<string>,
): CompiledIndexDefinition {
  const evidenceRefs = [...new Set(declaration.evidenceRefs.map((item) => item.trim()))].filter(
    Boolean,
  );
  if (evidenceRefs.length === 0) {
    fail(
      "INDEX_EVIDENCE_REQUIRED",
      "Every secondary index needs a Release test or Policy evidence ref.",
    );
  }
  const missingEvidence = evidenceRefs.find((reference) => !evidenceCatalog.has(reference));
  if (missingEvidence !== undefined) {
    fail(
      "INDEX_EVIDENCE_REQUIRED",
      `Index evidence ${missingEvidence} is not present in the Release evidence catalog.`,
    );
  }

  let keys: BtreeIndexKey[];
  let unitCost: number;
  if (declaration.kind === "btree") {
    keys = declaration.keys.map((key) => ({ ...key, direction: key.direction ?? "ASC" }));
    if (keys.length === 0 || keys.length > 3) {
      fail("INDEX_DECLARATION_INVALID", "A btree index needs one to three explicit keys.");
    }
    if (
      new Set(keys.map((key) => `${key.propertyId}:${key.jsonPath ?? ""}`)).size !== keys.length
    ) {
      fail("INDEX_DECLARATION_DUPLICATE", "A btree index cannot repeat a key.");
    }
    for (const key of keys) validateBtreeKey(properties, key);
    if (declaration.unique === true) {
      if (keys.length !== 1) {
        fail("INDEX_DECLARATION_INVALID", "P0 secondary uniqueness supports one Property only.");
      }
      const property = requireProperty(properties, required(keys[0], "Index key").propertyId);
      if (property.unique !== true) {
        fail("INDEX_DECLARATION_INVALID", "A unique index needs Property metadata unique=true.");
      }
      unitCost = 2;
    } else {
      unitCost = keys.length;
    }
  } else {
    keys = [{ propertyId: declaration.propertyId, direction: "ASC" }];
    const property = requireProperty(properties, declaration.propertyId);
    if (declaration.kind === "gin_trigram") {
      if (property.type !== "string" || property.searchable !== true) {
        fail("INDEX_DECLARATION_INVALID", "Trigram indexes require a searchable string Property.");
      }
      unitCost = 4;
    } else {
      if (property.type !== "string[]" || property.filterable !== true) {
        fail(
          "INDEX_DECLARATION_INVALID",
          "Array GIN indexes require a filterable string[] Property.",
        );
      }
      unitCost = 3;
    }
  }

  const canonical = canonicalIndexSignature(objectType, declaration, keys);
  const physicalSignature = sha256(canonical);
  const kindCode =
    declaration.kind === "btree"
      ? declaration.unique === true
        ? "uq"
        : "bt"
      : declaration.kind === "gin_trigram"
        ? "trgm"
        : "arr";
  const name = `ok_oc_${kindCode}_${sha256(objectType.resourceId).slice(0, 10)}_${sha256(objectType.revisionId).slice(0, 8)}_${physicalSignature.slice(0, 12)}`;
  if (Buffer.byteLength(name, "utf8") > 63) {
    fail("INDEX_DECLARATION_INVALID", `Generated PostgreSQL index name ${name} exceeds 63 bytes.`);
  }
  return {
    name,
    physicalSignature,
    table: "runtime.object_current",
    resourceId: objectType.resourceId,
    revisionId: objectType.revisionId,
    predicate: {
      objectTypeResourceId: objectType.resourceId,
      objectTypeRevisionId: objectType.revisionId,
      lifecycleState: "active",
    },
    kind: declaration.kind,
    unitCost,
    evidenceRefs,
    keys,
  };
}

function validatePropertyMetadata(property: PropertyIndexMetadata): void {
  if (property.primaryKey === true && property.type === "json") {
    fail("INDEX_DECLARATION_INVALID", "Primary Keys cannot use json Properties.");
  }
  if (property.sortable === true && (property.type === "string[]" || property.type === "json")) {
    fail("INDEX_DECLARATION_INVALID", `${property.type} Properties cannot be sortable in P0.`);
  }
  if (property.searchable === true && property.type !== "string") {
    fail("INDEX_DECLARATION_INVALID", "Only string Properties can be searchable in P0.");
  }
  if (property.unique === true && !scalarBtreeTypes.has(property.type)) {
    fail("INDEX_DECLARATION_INVALID", "Unique Properties require a scalar btree type.");
  }
  if (property.type === "json") {
    for (const path of property.registeredJsonPaths ?? []) {
      if (!/^\$\.[A-Za-z][A-Za-z0-9_]*$/u.test(path.path)) {
        fail(
          "INDEX_DECLARATION_INVALID",
          `JSON path ${path.path} is not a registered top-level path.`,
        );
      }
    }
  } else if ((property.registeredJsonPaths?.length ?? 0) > 0) {
    fail("INDEX_DECLARATION_INVALID", "Only json Properties can register JSON paths.");
  }
}

function validateBtreeKey(
  properties: ReadonlyMap<string, PropertyIndexMetadata>,
  key: BtreeIndexKey,
): void {
  const property = requireProperty(properties, key.propertyId);
  if (key.jsonPath !== undefined) {
    if (property.type !== "json") {
      fail("INDEX_DECLARATION_INVALID", "Only json Properties accept an index JSON path.");
    }
    const path = property.registeredJsonPaths?.find((item) => item.path === key.jsonPath);
    if (path === undefined || path.filterable !== true) {
      fail("INDEX_DECLARATION_INVALID", `JSON path ${key.jsonPath} is not registered filterable.`);
    }
    return;
  }
  if (!scalarBtreeTypes.has(property.type)) {
    fail("INDEX_DECLARATION_INVALID", `Property ${property.propertyId} is not btree scalar.`);
  }
  if (
    property.primaryKey !== true &&
    property.filterable !== true &&
    property.sortable !== true &&
    property.unique !== true
  ) {
    fail(
      "INDEX_PLAN_PROPERTY_NOT_DECLARED",
      `Property ${property.propertyId} has no declared btree capability.`,
    );
  }
}

function assertCapabilitiesCovered(
  objectType: ObjectTypeIndexPlanInput,
  properties: ReadonlyMap<string, PropertyIndexMetadata>,
  indexes: readonly CompiledIndexDefinition[],
): void {
  for (const property of properties.values()) {
    if (property.primaryKey === true) continue;
    const firstKeyIndexes = indexes.filter(
      (index) => index.keys[0]?.propertyId === property.propertyId,
    );
    if (property.type === "json") {
      for (const path of property.registeredJsonPaths ?? []) {
        if (
          path.filterable &&
          !firstKeyIndexes.some(
            (index) => index.kind === "btree" && index.keys[0]?.jsonPath === path.path,
          )
        ) {
          uncovered(objectType, `${property.propertyId}${path.path}`);
        }
      }
      continue;
    }
    if (
      (property.filterable === true || property.sortable === true) &&
      property.type !== "string[]" &&
      !firstKeyIndexes.some((index) => index.kind === "btree")
    ) {
      uncovered(objectType, property.propertyId);
    }
    if (
      property.type === "string[]" &&
      property.filterable === true &&
      !firstKeyIndexes.some((index) => index.kind === "gin_array")
    ) {
      uncovered(objectType, property.propertyId);
    }
    if (
      property.searchable === true &&
      !firstKeyIndexes.some((index) => index.kind === "gin_trigram")
    ) {
      uncovered(objectType, property.propertyId);
    }
    if (
      property.unique === true &&
      !firstKeyIndexes.some((index) => index.kind === "btree" && index.name.includes("_uq_"))
    ) {
      uncovered(objectType, `${property.propertyId}:unique`);
    }
  }
}

function validateIndexApproval(
  candidate: CompiledReleaseIndexPlan,
  inventory: ProjectIndexInventory,
  projectUnionUnits: number,
  projectPhysicalIndexCount: number,
  at: number,
  approval: IndexCapacityApproval,
  policy: IndexBudgetPolicy,
): void {
  if (
    approval.projectId !== candidate.projectId ||
    at < approval.approvedAt ||
    at >= approval.expiresAt ||
    approval.expiresAt - approval.approvedAt > policy.maximumApprovalMs ||
    approval.maximumReleaseUnits > policy.hardMaxSecondaryUnitsPerRelease ||
    approval.maximumProjectUnionUnits > policy.hardMaxProjectUnionUnits ||
    approval.maximumProjectPhysicalIndexes > policy.hardMaxProjectPhysicalIndexes ||
    candidate.secondaryIndexUnits > approval.maximumReleaseUnits ||
    projectUnionUnits > approval.maximumProjectUnionUnits ||
    projectPhysicalIndexCount > approval.maximumProjectPhysicalIndexes ||
    approval.retirementReleaseIds.length === 0
  ) {
    fail("INDEX_PROJECT_BUDGET_EXCEEDED", `Index capacity approval ${approval.id} is invalid.`);
  }
  for (const releaseId of new Set(approval.retirementReleaseIds)) {
    const supportUntil = approval.supportUntilByReleaseId[releaseId];
    const retained = inventory.retainedPlans.find(
      (item) => item.plan.releaseId === releaseId && item.reasons.includes("SERVING"),
    );
    if (
      supportUntil === undefined ||
      supportUntil + policy.minimumRetirementReclaimMs > approval.expiresAt ||
      retained === undefined
    ) {
      fail(
        "INDEX_PROJECT_BUDGET_EXCEEDED",
        `Release ${releaseId} is not a reclaimable serving plan before approval ${approval.id} expires.`,
      );
    }
  }
}

function canonicalIndexSignature(
  objectType: ObjectTypeIndexPlanInput,
  declaration: IndexDeclaration,
  keys: readonly BtreeIndexKey[],
): string {
  return JSON.stringify({
    table: "runtime.object_current",
    resourceId: objectType.resourceId,
    revisionId: objectType.revisionId,
    kind: declaration.kind,
    unique: declaration.kind === "btree" && declaration.unique === true,
    keys: keys.map((key) => ({
      propertyId: key.propertyId,
      jsonPath: key.jsonPath ?? null,
      direction: key.direction ?? "ASC",
    })),
    predicate: {
      objectTypeResourceId: objectType.resourceId,
      objectTypeRevisionId: objectType.revisionId,
      lifecycleState: "active",
    },
    tieBreaker: declaration.kind === "btree" ? "canonical_primary_key" : null,
  });
}

function assertIndexBudgetPolicy(policy: IndexBudgetPolicy): void {
  const values = Object.values(policy);
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    fail("INDEX_DECLARATION_INVALID", "Index budget values must be positive safe integers.");
  }
  if (
    policy.normalMaxSecondaryUnitsPerRelease > policy.hardMaxSecondaryUnitsPerRelease ||
    policy.normalMaxProjectUnionUnits > policy.hardMaxProjectUnionUnits ||
    policy.normalMaxProjectPhysicalIndexes > policy.hardMaxProjectPhysicalIndexes
  ) {
    fail("INDEX_DECLARATION_INVALID", "Normal Index limits cannot exceed hard limits.");
  }
}

function requireProperty(
  properties: ReadonlyMap<string, PropertyIndexMetadata>,
  propertyId: string,
): PropertyIndexMetadata {
  const property = properties.get(propertyId);
  if (property === undefined) {
    fail("INDEX_PLAN_PROPERTY_NOT_DECLARED", `Property ${propertyId} is not in the Object Type.`);
  }
  return property;
}

function uncovered(objectType: ObjectTypeIndexPlanInput, property: string): never {
  fail(
    "INDEX_CAPABILITY_UNCOVERED",
    `Object Type ${objectType.resourceId} declares ${property} queryable but its Index Plan does not cover it.`,
  );
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) fail("INDEX_DECLARATION_INVALID", `${label} is missing.`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code: IndexPlanErrorCode, message: string): never {
  throw new IndexPlanError(code, message);
}
