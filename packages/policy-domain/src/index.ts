import {
  canonicalizeContractForDigest,
  extractPolicyResourceDependencies,
  parseArtifactDigest,
  parseLinkTypeDefinition,
  parseObjectTypeDefinition,
  parsePolicyArtifact,
  parsePolicyResourceDefinition,
  type ArtifactDigest,
  type ObjectTypeDefinition,
  type PolicyActorAttributeSchema,
  type PolicyArtifact,
  type PolicyComparisonOperator,
  type PolicyFact,
  type PolicyMask,
  type PolicyOperand,
  type PolicyPredicate,
  type PolicyResourceDefinition,
  type PolicyRule,
  type PolicyTarget,
  type PolicyTestVector,
  type PropertyPolicyDisposition,
  type QueryScalar,
  type ResourceFamily,
} from "@ontos/contracts";

export * from "./gateway.ts";

export const POLICY_COMPILER_VERSION = "policy-compiler-g2-03-05-v1" as const;
export const POLICY_ARTIFACT_MAXIMUM_BYTES = 16 * 1024 * 1024;

export type PolicyCompilerErrorCode =
  "INPUT_INVALID" | "TARGET_UNAVAILABLE" | "PREDICATE_NOT_COMPILABLE" | "DIGEST_INVALID";

export class PolicyCompilerError extends Error {
  readonly code: PolicyCompilerErrorCode;

  constructor(code: PolicyCompilerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PolicyCompilerError";
    this.code = code;
  }
}

export interface PolicyCompilerTargetSnapshot {
  readonly projectId: string;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly family: ResourceFamily;
  readonly apiName: string;
  readonly contentDigest: ArtifactDigest;
  readonly content: unknown;
}

export interface PolicyTestVectorResult {
  readonly vectorId: string;
  readonly passed: boolean;
  readonly actualDecision: "allow" | "deny";
  readonly actualPropertyDisposition?: PropertyPolicyDisposition;
}

export interface PolicyTestReport {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly releaseId: string;
  readonly policyRevisionId: string;
  readonly compilerVersion: typeof POLICY_COMPILER_VERSION;
  readonly artifactDigest: ArtifactDigest;
  readonly status: "passed" | "failed";
  readonly vectorCount: number;
  readonly passedVectorCount: number;
  readonly failedVectorCount: number;
  readonly results: readonly PolicyTestVectorResult[];
}

export interface CompiledPolicyResult {
  readonly definition: PolicyResourceDefinition;
  readonly artifact: PolicyArtifact;
  readonly artifactBytes: string;
  readonly artifactDigest: ArtifactDigest;
  readonly testReport: PolicyTestReport;
  readonly testReportBytes: string;
  readonly testReportDigest: ArtifactDigest;
  readonly dependencyContextDigest: ArtifactDigest;
}

export type PolicyTextDigester = (canonicalText: string) => ArtifactDigest;

export interface PolicyEvaluationResult {
  readonly decision: "allow" | "deny";
  readonly propertyDisposition?: PropertyPolicyDisposition;
  readonly mask?: PolicyMask;
}

export function compilePolicy(input: {
  readonly projectId: string;
  readonly releaseId: string;
  readonly policyRevisionId: string;
  readonly definition: unknown;
  readonly releaseRevisionIds: readonly string[];
  readonly targets: readonly PolicyCompilerTargetSnapshot[];
  readonly trustedActorAttributes: readonly PolicyActorAttributeSchema[];
  readonly digest: PolicyTextDigester;
}): CompiledPolicyResult {
  let definition: PolicyResourceDefinition;
  try {
    definition = parsePolicyResourceDefinition(input.definition);
  } catch (error) {
    throw new PolicyCompilerError("INPUT_INVALID", "Policy Resource contract is invalid.", {
      cause: error,
    });
  }
  const trustedActorAttributes = normalizeActorAttributes(input.trustedActorAttributes);
  const actorAttributes = new Map(
    trustedActorAttributes.map(({ apiName, valueType }) => [apiName, valueType] as const),
  );
  const releases = new Set(uniqueSorted(input.releaseRevisionIds, "Release Revision"));
  const targets = targetMap(input.targets);
  const dependencies = extractPolicyResourceDependencies(input.policyRevisionId, definition);
  for (const dependency of dependencies) {
    const target = targets.get(dependency.targetRevisionId);
    if (
      target === undefined ||
      !releases.has(dependency.targetRevisionId) ||
      target.projectId !== input.projectId ||
      target.resourceId !== dependency.targetResourceId ||
      target.family !== dependency.expectedFamily
    ) {
      throw targetError();
    }
    assertDependencyIdentity(dependency, target);
  }

  const objectDefinitions = new Map<string, ObjectTypeDefinition>();
  for (const rule of definition.rules) {
    const rootObject = objectDefinitionForTarget(rule.target, targets, objectDefinitions);
    validatePredicate(rule.predicate, rootObject, targets, objectDefinitions, actorAttributes);
  }
  for (const vector of definition.testVectors) assertUniqueFacts(vector);

  const dependencyContextDigest = parseArtifactDigest(
    input.digest(
      canonicalizeContractForDigest({
        schemaVersion: 1,
        dependencies: dependencies.map((dependency) => ({
          dependencyType: dependency.dependencyType,
          sourcePath: dependency.sourcePath,
          targetResourceId: dependency.targetResourceId,
          targetRevisionId: dependency.targetRevisionId,
          target: snapshotDigestIdentity(requireTarget(targets, dependency.targetRevisionId)),
        })),
      }),
    ),
  );
  const artifactDraft = {
    schemaVersion: 1,
    projectId: input.projectId,
    releaseId: input.releaseId,
    policyRevisionId: input.policyRevisionId,
    compilerVersion: POLICY_COMPILER_VERSION,
    dependencyContextDigest,
    trustedActorAttributes,
    rules: definition.rules,
    testVectors: definition.testVectors,
  } as const;
  const artifactDigest = parseArtifactDigest(
    input.digest(canonicalizeContractForDigest(artifactDraft)),
  );
  const artifact = parsePolicyArtifact({ ...artifactDraft, artifactDigest });
  const artifactBytes = canonicalizeContractForDigest(artifact);
  if (new TextEncoder().encode(artifactBytes).byteLength > POLICY_ARTIFACT_MAXIMUM_BYTES) {
    throw new PolicyCompilerError("INPUT_INVALID", "Compiled Policy Artifact is too large.");
  }
  const results = Object.freeze(
    artifact.testVectors.map((vector) => testVectorResult(artifact.rules, vector)),
  );
  const passedVectorCount = results.filter(({ passed }) => passed).length;
  const testReport = Object.freeze({
    schemaVersion: 1 as const,
    projectId: input.projectId,
    releaseId: input.releaseId,
    policyRevisionId: input.policyRevisionId,
    compilerVersion: POLICY_COMPILER_VERSION,
    artifactDigest,
    status: passedVectorCount === results.length ? ("passed" as const) : ("failed" as const),
    vectorCount: results.length,
    passedVectorCount,
    failedVectorCount: results.length - passedVectorCount,
    results,
  });
  const testReportBytes = canonicalizeContractForDigest(testReport);
  if (new TextEncoder().encode(testReportBytes).byteLength > POLICY_ARTIFACT_MAXIMUM_BYTES) {
    throw new PolicyCompilerError("INPUT_INVALID", "Policy Test Report is too large.");
  }
  const testReportDigest = parseArtifactDigest(input.digest(testReportBytes));
  return Object.freeze({
    definition,
    artifact,
    artifactBytes,
    artifactDigest,
    testReport,
    testReportBytes,
    testReportDigest,
    dependencyContextDigest,
  });
}

export function evaluatePolicyRules(
  rules: readonly PolicyRule[],
  target: PolicyTarget,
  facts: readonly PolicyFact[],
  requestTime: string,
): PolicyEvaluationResult {
  const factMap = policyFactMap(facts);
  const matched = rules.filter(
    (rule) =>
      sameTarget(rule.target, target) &&
      evaluatePredicate(rule.predicate, factMap, requestTime) === true,
  );
  if (matched.some(({ effect }) => effect === "deny")) {
    return target.kind === "property"
      ? Object.freeze({ decision: "deny", propertyDisposition: "deny" })
      : Object.freeze({ decision: "deny" });
  }
  if (target.kind === "property") {
    const masked = matched.find(({ effect }) => effect === "mask");
    if (masked?.mask !== undefined) {
      return Object.freeze({
        decision: "allow",
        propertyDisposition: "mask",
        mask: masked.mask,
      });
    }
    if (matched.some(({ effect }) => effect === "allow")) {
      return Object.freeze({ decision: "allow", propertyDisposition: "allow" });
    }
    return Object.freeze({ decision: "deny", propertyDisposition: "deny" });
  }
  return matched.some(({ effect }) => effect === "allow")
    ? Object.freeze({ decision: "allow" })
    : Object.freeze({ decision: "deny" });
}

export type PolicyCompatibilityDirection = "unchanged" | "tightening" | "widening" | "ambiguous";

export function comparePolicyDefinitions(
  baselineInput: unknown,
  candidateInput: unknown,
): PolicyCompatibilityDirection {
  const baseline = parsePolicyResourceDefinition(baselineInput);
  const candidate = parsePolicyResourceDefinition(candidateInput);
  if (canonicalizeContractForDigest(baseline) === canonicalizeContractForDigest(candidate)) {
    return "unchanged";
  }
  const baselineRules = new Map(baseline.rules.map((rule) => [rule.ruleId, rule]));
  const candidateRules = new Map(candidate.rules.map((rule) => [rule.ruleId, rule]));
  if (
    canonicalizeContractForDigest(baseline.rules) === canonicalizeContractForDigest(candidate.rules)
  ) {
    return "unchanged";
  }
  let widening = false;
  let tightening = false;
  for (const ruleId of new Set([...baselineRules.keys(), ...candidateRules.keys()])) {
    const before = baselineRules.get(ruleId);
    const after = candidateRules.get(ruleId);
    if (before !== undefined && after !== undefined) {
      if (canonicalizeContractForDigest(before) !== canonicalizeContractForDigest(after)) {
        const beforeSemantics = { target: before.target, predicate: before.predicate };
        const afterSemantics = { target: after.target, predicate: after.predicate };
        if (
          canonicalizeContractForDigest(beforeSemantics) !==
          canonicalizeContractForDigest(afterSemantics)
        ) {
          return "ambiguous";
        }
        const beforeRank = policyRestrictionRank(before.effect);
        const afterRank = policyRestrictionRank(after.effect);
        if (beforeRank === afterRank) return "ambiguous";
        widening ||= afterRank < beforeRank;
        tightening ||= afterRank > beforeRank;
      }
      continue;
    }
    const rule = before ?? after;
    if (rule === undefined) continue;
    const added = after !== undefined;
    if (rule.effect === "allow") {
      widening ||= added;
      tightening ||= !added;
    } else {
      tightening ||= added;
      widening ||= !added;
    }
  }
  return widening && tightening ? "ambiguous" : widening ? "widening" : "tightening";
}

function policyRestrictionRank(effect: PolicyRule["effect"]): number {
  return effect === "allow" ? 0 : effect === "mask" ? 1 : 2;
}

function assertDependencyIdentity(
  dependency: ReturnType<typeof extractPolicyResourceDependencies>[number],
  target: PolicyCompilerTargetSnapshot,
): void {
  try {
    if (target.family === "object_type") {
      const definition = parseObjectTypeDefinition(target.content);
      if (
        (dependency.expectedApiName !== undefined &&
          (target.apiName !== dependency.expectedApiName ||
            definition.apiName !== dependency.expectedApiName)) ||
        (dependency.propertyApiName !== undefined &&
          !definition.properties.some(({ apiName }) => apiName === dependency.propertyApiName))
      ) {
        throw targetError();
      }
    } else if (target.family === "link_type") {
      const definition = parseLinkTypeDefinition(target.content);
      if (
        dependency.expectedApiName !== undefined &&
        (target.apiName !== dependency.expectedApiName ||
          definition.apiName !== dependency.expectedApiName)
      ) {
        throw targetError();
      }
    }
  } catch (error) {
    if (error instanceof PolicyCompilerError) throw error;
    throw targetError();
  }
}

function objectDefinitionForTarget(
  target: PolicyTarget,
  targets: ReadonlyMap<string, PolicyCompilerTargetSnapshot>,
  cache: Map<string, ObjectTypeDefinition>,
): PolicyObjectContext | null {
  if (target.kind === "object" || target.kind === "property") {
    return objectDefinition(requireTarget(targets, target.resourceRevisionId), cache);
  }
  if (target.kind === "action_target") {
    return objectDefinition(
      requireTarget(targets, requiredTargetBinding(target.targetObjectTypeRevisionId)),
      cache,
    );
  }
  return null;
}

function objectDefinition(
  target: PolicyCompilerTargetSnapshot,
  cache: Map<string, ObjectTypeDefinition>,
): PolicyObjectContext {
  if (target.family !== "object_type") throw targetError();
  const existing = cache.get(target.revisionId);
  if (existing !== undefined) return { definition: existing, revisionId: target.revisionId };
  try {
    const definition = parseObjectTypeDefinition(target.content);
    cache.set(target.revisionId, definition);
    return { definition, revisionId: target.revisionId };
  } catch (error) {
    throw new PolicyCompilerError("TARGET_UNAVAILABLE", "Policy target is unavailable.", {
      cause: error,
    });
  }
}

function validatePredicate(
  predicate: PolicyPredicate,
  objectType: PolicyObjectContext | null,
  targets: ReadonlyMap<string, PolicyCompilerTargetSnapshot>,
  cache: Map<string, ObjectTypeDefinition>,
  actorAttributes: ReadonlyMap<string, PolicyActorAttributeSchema["valueType"]>,
): void {
  if (predicate.kind === "compare") {
    const left = operandType(predicate.left, objectType, actorAttributes);
    const right = operandType(predicate.right, objectType, actorAttributes);
    if (!operatorAccepts(predicate.op, left, right)) throw predicateError();
    return;
  }
  if (predicate.kind === "is_null") {
    operandType(predicate.operand, objectType, actorAttributes);
    return;
  }
  if (predicate.kind === "all" || predicate.kind === "any") {
    predicate.predicates.forEach((item) =>
      validatePredicate(item, objectType, targets, cache, actorAttributes),
    );
    return;
  }
  if (predicate.kind === "not") {
    validatePredicate(predicate.predicate, objectType, targets, cache, actorAttributes);
    return;
  }
  if (predicate.kind === "link_exists") {
    if (objectType === null) throw predicateError();
    const linkTypeResourceId = requiredTargetBinding(predicate.linkTypeResourceId);
    const linkTypeRevisionId = requiredTargetBinding(predicate.linkTypeRevisionId);
    const targetObjectTypeResourceId = requiredTargetBinding(predicate.targetObjectTypeResourceId);
    const targetObjectTypeRevisionId = requiredTargetBinding(predicate.targetObjectTypeRevisionId);
    const link = requireTarget(targets, linkTypeRevisionId);
    const target = requireTarget(targets, targetObjectTypeRevisionId);
    if (
      link.family !== "link_type" ||
      link.resourceId !== linkTypeResourceId ||
      link.apiName !== predicate.linkTypeApiName ||
      target.resourceId !== targetObjectTypeResourceId ||
      target.apiName !== predicate.targetObjectTypeApiName
    ) {
      throw targetError();
    }
    const linkDefinition = parseLinkTypeDefinition(link.content);
    if (
      linkDefinition.source.objectTypeRevisionId !== objectType.revisionId ||
      linkDefinition.target.objectTypeRevisionId !== target.revisionId ||
      linkDefinition.target.apiName !== predicate.targetObjectTypeApiName
    ) {
      throw targetError();
    }
    validatePredicate(
      predicate.predicate,
      objectDefinition(target, cache),
      targets,
      cache,
      actorAttributes,
    );
  }
}

type OperandType = "boolean" | "number" | "string" | "string_array" | "scalar_array";

function operandType(
  operand: PolicyOperand,
  objectType: PolicyObjectContext | null,
  actorAttributes: ReadonlyMap<string, PolicyActorAttributeSchema["valueType"]>,
): OperandType {
  if (operand.source === "request_time") return "string";
  if (operand.source === "actor_attribute") {
    const type = actorAttributes.get(operand.apiName);
    if (type === undefined) throw predicateError();
    return type;
  }
  if (operand.source === "object_property") {
    const property = objectType?.definition.properties.find(
      ({ apiName }) => apiName === operand.apiName,
    );
    if (property === undefined || !property.filterable || property.valueType === "json") {
      throw predicateError();
    }
    return property.valueType === "boolean"
      ? "boolean"
      : property.valueType === "integer" || property.valueType === "decimal"
        ? "number"
        : "string";
  }
  if (Array.isArray(operand.value)) {
    if (operand.value.every((value) => typeof value === "string")) return "string_array";
    return "scalar_array";
  }
  return typeof operand.value === "boolean"
    ? "boolean"
    : typeof operand.value === "number"
      ? "number"
      : "string";
}

function operatorAccepts(
  operator: PolicyComparisonOperator,
  left: OperandType,
  right: OperandType,
): boolean {
  if (operator === "contains" || operator === "prefix")
    return left === "string" && right === "string";
  if (operator === "in") {
    return (
      (right === "string_array" && left === "string") ||
      (right === "scalar_array" && (left === "number" || left === "boolean"))
    );
  }
  if (operator === "containsAny") return left === "string_array" && right === "string_array";
  if (operator === "eq" || operator === "ne") return left === right;
  return left === right && (left === "number" || left === "string");
}

function testVectorResult(
  rules: readonly PolicyRule[],
  vector: PolicyTestVector,
): PolicyTestVectorResult {
  const actual = evaluatePolicyRules(rules, vector.target, vector.facts, vector.requestTime);
  const passed =
    actual.decision === vector.expectedDecision &&
    actual.propertyDisposition === vector.expectedPropertyDisposition;
  return Object.freeze({
    vectorId: vector.vectorId,
    passed,
    actualDecision: actual.decision,
    ...(actual.propertyDisposition === undefined
      ? {}
      : { actualPropertyDisposition: actual.propertyDisposition }),
  });
}

const missingOperand = Symbol("missing-policy-operand");
type PredicateTruth = true | false | "unknown";
type OperandValue = QueryScalar | readonly QueryScalar[] | typeof missingOperand | null;

function evaluatePredicate(
  predicate: PolicyPredicate,
  facts: ReadonlyMap<string, PolicyFact>,
  requestTime: string,
): PredicateTruth {
  if (predicate.kind === "constant") return predicate.value;
  if (predicate.kind === "compare") {
    const left = operandValue(predicate.left, facts, requestTime);
    const right = operandValue(predicate.right, facts, requestTime);
    if (left === missingOperand || right === missingOperand || left === null || right === null) {
      return "unknown";
    }
    return compareValues(predicate.op, left, right);
  }
  if (predicate.kind === "is_null") {
    const value = operandValue(predicate.operand, facts, requestTime);
    return value === missingOperand ? "unknown" : value === null;
  }
  if (predicate.kind === "not") {
    const result = evaluatePredicate(predicate.predicate, facts, requestTime);
    return result === "unknown" ? result : !result;
  }
  if (predicate.kind === "all") {
    let unknown = false;
    for (const item of predicate.predicates) {
      const result = evaluatePredicate(item, facts, requestTime);
      if (result === false) return false;
      unknown ||= result === "unknown";
    }
    return unknown ? "unknown" : true;
  }
  if (predicate.kind === "any") {
    let unknown = false;
    for (const item of predicate.predicates) {
      const result = evaluatePredicate(item, facts, requestTime);
      if (result === true) return true;
      unknown ||= result === "unknown";
    }
    return unknown ? "unknown" : false;
  }
  if (predicate.kind !== "link_exists") return false;
  const linkFact = facts.get(factKey("link", predicate.linkTypeApiName));
  if (linkFact === undefined || linkFact.state === "missing") return "unknown";
  if (linkFact.state === "null" || linkFact.value !== true) return false;
  return evaluatePredicate(predicate.predicate, facts, requestTime);
}

function operandValue(
  operand: PolicyOperand,
  facts: ReadonlyMap<string, PolicyFact>,
  requestTime: string,
): OperandValue {
  if (operand.source === "constant") return operand.value;
  if (operand.source === "request_time") return requestTime;
  const fact = facts.get(factKey(operand.source, operand.apiName));
  if (fact === undefined || fact.state === "missing") return missingOperand;
  if (fact.state === "null") return null;
  return fact.values ?? fact.value ?? missingOperand;
}

function compareValues(
  operator: PolicyComparisonOperator,
  left: QueryScalar | readonly QueryScalar[],
  right: QueryScalar | readonly QueryScalar[],
): boolean {
  if (operator === "eq" || operator === "ne") {
    const equal = canonicalizeContractForDigest(left) === canonicalizeContractForDigest(right);
    return operator === "eq" ? equal : !equal;
  }
  if (operator === "contains")
    return typeof left === "string" && typeof right === "string" && left.includes(right);
  if (operator === "prefix")
    return typeof left === "string" && typeof right === "string" && left.startsWith(right);
  if (operator === "in")
    return !Array.isArray(left) && Array.isArray(right) && right.includes(left);
  if (operator === "containsAny") {
    return (
      Array.isArray(left) && Array.isArray(right) && left.some((value) => right.includes(value))
    );
  }
  if (Array.isArray(left) || Array.isArray(right) || typeof left !== typeof right) return false;
  if (
    (typeof left !== "number" && typeof left !== "string") ||
    (typeof right !== "number" && typeof right !== "string")
  )
    return false;
  if (typeof left === "number" && typeof right === "number") {
    if (operator === "lt") return left < right;
    if (operator === "lte") return left <= right;
    if (operator === "gt") return left > right;
    return left >= right;
  }
  if (typeof left === "string" && typeof right === "string") {
    if (operator === "lt") return left < right;
    if (operator === "lte") return left <= right;
    if (operator === "gt") return left > right;
    return left >= right;
  }
  return false;
}

function policyFactMap(facts: readonly PolicyFact[]): ReadonlyMap<string, PolicyFact> {
  const result = new Map<string, PolicyFact>();
  for (const fact of facts) {
    const key = factKey(fact.source, fact.apiName);
    if (result.has(key))
      throw new PolicyCompilerError("INPUT_INVALID", "Policy facts are duplicated.");
    result.set(key, fact);
  }
  return result;
}

function assertUniqueFacts(vector: PolicyTestVector): void {
  policyFactMap(vector.facts);
}

function factKey(source: PolicyFact["source"] | PolicyOperand["source"], apiName: string): string {
  return `${source}\u0000${apiName}`;
}

function sameTarget(left: PolicyTarget, right: PolicyTarget): boolean {
  return canonicalizeContractForDigest(left) === canonicalizeContractForDigest(right);
}

function normalizeActorAttributes(
  input: readonly PolicyActorAttributeSchema[],
): readonly PolicyActorAttributeSchema[] {
  const sorted = [...input].sort((left, right) => compareText(left.apiName, right.apiName));
  if (
    sorted.length > 32 ||
    sorted.some(
      (item, index) =>
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(item.apiName) ||
        !new Set(["string", "string_array", "boolean"]).has(item.valueType) ||
        (index > 0 && item.apiName === sorted[index - 1]?.apiName),
    )
  ) {
    throw new PolicyCompilerError("INPUT_INVALID", "Trusted Actor Attribute schema is invalid.");
  }
  return Object.freeze(sorted.map((item) => Object.freeze({ ...item })));
}

function targetMap(
  input: readonly PolicyCompilerTargetSnapshot[],
): ReadonlyMap<string, PolicyCompilerTargetSnapshot> {
  const result = new Map<string, PolicyCompilerTargetSnapshot>();
  for (const target of input) {
    if (result.has(target.revisionId)) {
      throw new PolicyCompilerError("INPUT_INVALID", "Policy target snapshot is duplicated.");
    }
    result.set(target.revisionId, target);
  }
  return result;
}

function requireTarget(
  targets: ReadonlyMap<string, PolicyCompilerTargetSnapshot>,
  revisionId: string,
): PolicyCompilerTargetSnapshot {
  const target = targets.get(revisionId);
  if (target === undefined) throw targetError();
  return target;
}

function snapshotDigestIdentity(target: PolicyCompilerTargetSnapshot): object {
  return Object.freeze({
    projectId: target.projectId,
    resourceId: target.resourceId,
    revisionId: target.revisionId,
    family: target.family,
    apiName: target.apiName,
    contentDigest: target.contentDigest,
  });
}

interface PolicyObjectContext {
  readonly definition: ObjectTypeDefinition;
  readonly revisionId: string;
}

function requiredTargetBinding<T>(value: T | undefined): T {
  if (value === undefined) throw targetError();
  return value;
}

function uniqueSorted(values: readonly string[], label: string): readonly string[] {
  const sorted = [...values].sort(compareText);
  if (sorted.some((value, index) => index > 0 && value === sorted[index - 1])) {
    throw new PolicyCompilerError("INPUT_INVALID", `${label} set is duplicated.`);
  }
  return sorted;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function targetError(): PolicyCompilerError {
  return new PolicyCompilerError("TARGET_UNAVAILABLE", "Policy target is unavailable.");
}

function predicateError(): PolicyCompilerError {
  return new PolicyCompilerError(
    "PREDICATE_NOT_COMPILABLE",
    "Policy predicate is outside the trusted bounded compiler subset.",
  );
}
