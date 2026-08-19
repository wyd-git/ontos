import { failContract } from "./error.ts";
import { parseIdentityDelegationSummary, type IdentityDelegationSummary } from "./identity.ts";
import {
  requireArray,
  requireBoolean,
  requireObjectShape,
  requireOneOf,
  requirePlainRecord,
  requireString,
} from "./internal.ts";
import { API_NAME_PATTERN } from "./metadata.ts";
import { parseQueryScalar, type QueryScalar } from "./query.ts";
import {
  parseArtifactDigest,
  parseCanonicalInstant,
  parseOntosId,
  parseSchemaVersion,
  type ArtifactDigest,
  type CanonicalInstant,
  type ContractSchemaVersion,
  type OntosId,
} from "./scalars.ts";

export const POLICY_TARGET_KIND_VALUES = Object.freeze([
  "resource",
  "object",
  "property",
  "link",
  "action_target",
] as const);
export type PolicyTargetKind = (typeof POLICY_TARGET_KIND_VALUES)[number];

export const POLICY_EFFECT_VALUES = Object.freeze(["allow", "deny", "mask"] as const);
export type PolicyEffect = (typeof POLICY_EFFECT_VALUES)[number];

export const PROPERTY_POLICY_DISPOSITION_VALUES = Object.freeze(["allow", "mask", "deny"] as const);
export type PropertyPolicyDisposition = (typeof PROPERTY_POLICY_DISPOSITION_VALUES)[number];

export const POLICY_COMPARISON_OPERATOR_VALUES = Object.freeze([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "contains",
  "prefix",
  "containsAny",
] as const);
export type PolicyComparisonOperator = (typeof POLICY_COMPARISON_OPERATOR_VALUES)[number];

export const POLICY_RULE_MAXIMUM_ITEMS = 512;
export const POLICY_TEST_VECTOR_MAXIMUM_ITEMS = 1_000;
export const POLICY_FACT_MAXIMUM_ITEMS = 512;
export const POLICY_PREDICATE_MAXIMUM_COUNT = 50;
export const POLICY_LOGICAL_MAXIMUM_DEPTH = 5;
export const POLICY_COLLECTION_MAXIMUM_ITEMS = 500;
export const POLICY_COMPILER_VERSION_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
export const POLICY_STABLE_NAME_PATTERN = "^[A-Z][A-Z0-9_]{0,63}$";
export const AUTHORIZATION_EPOCH_PATTERN = "^[1-9][0-9]{0,18}$";

const apiNameExpression = new RegExp(API_NAME_PATTERN, "u");
const compilerVersionExpression = new RegExp(POLICY_COMPILER_VERSION_PATTERN, "u");
const stableNameExpression = new RegExp(POLICY_STABLE_NAME_PATTERN, "u");
const authorizationEpochExpression = new RegExp(AUTHORIZATION_EPOCH_PATTERN, "u");
const targetKinds = new Set<PolicyTargetKind>(POLICY_TARGET_KIND_VALUES);
const policyEffects = new Set<PolicyEffect>(POLICY_EFFECT_VALUES);
const propertyDispositions = new Set<PropertyPolicyDisposition>(PROPERTY_POLICY_DISPOSITION_VALUES);
const comparisonOperators = new Set<PolicyComparisonOperator>(POLICY_COMPARISON_OPERATOR_VALUES);
const collectionOperators = new Set<PolicyComparisonOperator>(["in", "containsAny"]);
const stringOperators = new Set<PolicyComparisonOperator>(["contains", "prefix"]);

export interface PolicyTarget {
  readonly kind: PolicyTargetKind;
  readonly resourceId: OntosId;
  readonly resourceRevisionId: OntosId;
  readonly propertyApiName?: string;
  readonly targetObjectTypeResourceId?: OntosId;
  readonly targetObjectTypeRevisionId?: OntosId;
}

export interface PolicyPropertyOperand {
  readonly source: "object_property";
  readonly apiName: string;
}

export interface PolicyActorAttributeOperand {
  readonly source: "actor_attribute";
  readonly apiName: string;
}

export interface PolicyConstantOperand {
  readonly source: "constant";
  readonly value: QueryScalar | readonly QueryScalar[];
}

export interface PolicyRequestTimeOperand {
  readonly source: "request_time";
}

export type PolicyOperand =
  | PolicyPropertyOperand
  | PolicyActorAttributeOperand
  | PolicyConstantOperand
  | PolicyRequestTimeOperand;

export interface PolicyConstantPredicate {
  readonly kind: "constant";
  readonly value: boolean;
}

export interface PolicyComparisonPredicate {
  readonly kind: "compare";
  readonly left: PolicyOperand;
  readonly op: PolicyComparisonOperator;
  readonly right: PolicyOperand;
}

export interface PolicyNullPredicate {
  readonly kind: "is_null";
  readonly operand: PolicyOperand;
}

export interface PolicyLogicalPredicate {
  readonly kind: "all" | "any";
  readonly predicates: readonly PolicyPredicate[];
}

export interface PolicyNotPredicate {
  readonly kind: "not";
  readonly predicate: PolicyPredicate;
}

export interface PolicyLinkExistsPredicate {
  readonly kind: "link_exists";
  readonly linkTypeApiName: string;
  readonly linkTypeResourceId?: OntosId;
  readonly linkTypeRevisionId?: OntosId;
  readonly targetObjectTypeApiName: string;
  readonly targetObjectTypeResourceId?: OntosId;
  readonly targetObjectTypeRevisionId?: OntosId;
  readonly predicate: PolicyPredicate;
}

export type PolicyPredicate =
  | PolicyConstantPredicate
  | PolicyComparisonPredicate
  | PolicyNullPredicate
  | PolicyLogicalPredicate
  | PolicyNotPredicate
  | PolicyLinkExistsPredicate;

export interface PolicyMask {
  readonly kind: "redact";
  readonly displayValue: string;
}

export interface PolicyRule {
  readonly ruleId: string;
  readonly target: PolicyTarget;
  readonly effect: PolicyEffect;
  readonly predicate: PolicyPredicate;
  readonly mask?: PolicyMask;
}

export interface PolicyFact {
  readonly source: "object_property" | "actor_attribute" | "link";
  readonly apiName: string;
  readonly state: "value" | "null" | "missing";
  readonly value?: QueryScalar;
  readonly values?: readonly string[];
}

export interface PolicyTestVector {
  readonly vectorId: string;
  readonly identity: IdentityDelegationSummary;
  readonly requestTime: CanonicalInstant;
  readonly target: PolicyTarget;
  readonly facts: readonly PolicyFact[];
  readonly expectedDecision: "allow" | "deny";
  readonly expectedPropertyDisposition?: PropertyPolicyDisposition;
}

export type PolicyActorAttributeValueType = "string" | "string_array" | "boolean";

export interface PolicyActorAttributeSchema {
  readonly apiName: string;
  readonly valueType: PolicyActorAttributeValueType;
}

/**
 * Author-owned Policy Resource content. Compiler identity and Artifact facts
 * are deliberately absent so a client cannot submit a forged compiled result.
 */
export interface PolicyResourceDefinition {
  readonly schemaVersion: ContractSchemaVersion;
  readonly rules: readonly PolicyRule[];
  readonly testVectors: readonly PolicyTestVector[];
}

export type PolicyResourceDependencyType =
  "policy_object_target" | "policy_property_target" | "policy_link_target" | "policy_action_target";

export interface PolicyResourceDependency {
  readonly sourceRevisionId: string;
  readonly targetResourceId: OntosId;
  readonly targetRevisionId: OntosId;
  readonly dependencyType: PolicyResourceDependencyType;
  readonly sourcePath: string;
  readonly expectedFamily: "object_type" | "link_type" | "action_type";
  readonly expectedApiName?: string;
  readonly propertyApiName?: string;
}

export interface PolicyArtifact {
  readonly schemaVersion: ContractSchemaVersion;
  readonly projectId: OntosId;
  readonly releaseId: OntosId;
  readonly policyRevisionId: OntosId;
  readonly compilerVersion: string;
  readonly artifactDigest: ArtifactDigest;
  readonly dependencyContextDigest?: ArtifactDigest;
  readonly trustedActorAttributes?: readonly PolicyActorAttributeSchema[];
  readonly rules: readonly PolicyRule[];
  readonly testVectors: readonly PolicyTestVector[];
}

export interface PolicyDecision {
  readonly schemaVersion: ContractSchemaVersion;
  readonly target: PolicyTarget;
  readonly decision: "allow" | "deny";
  readonly propertyDisposition?: PropertyPolicyDisposition;
  readonly mask?: PolicyMask;
  readonly policyContextHash: ArtifactDigest;
  readonly authorizationEpoch: string;
  readonly evaluatedAt: CanonicalInstant;
}

export const POLICY_TARGET_FIELDS = Object.freeze([
  "kind",
  "resourceId",
  "resourceRevisionId",
  "propertyApiName",
  "targetObjectTypeResourceId",
  "targetObjectTypeRevisionId",
] as const);
export const POLICY_TARGET_REQUIRED_FIELDS = Object.freeze([
  "kind",
  "resourceId",
  "resourceRevisionId",
] as const);
export const POLICY_OPERAND_FIELDS = Object.freeze(["source", "apiName", "value"] as const);
export const POLICY_CONSTANT_PREDICATE_FIELDS = Object.freeze(["kind", "value"] as const);
export const POLICY_COMPARISON_PREDICATE_FIELDS = Object.freeze([
  "kind",
  "left",
  "op",
  "right",
] as const);
export const POLICY_NULL_PREDICATE_FIELDS = Object.freeze(["kind", "operand"] as const);
export const POLICY_LOGICAL_PREDICATE_FIELDS = Object.freeze(["kind", "predicates"] as const);
export const POLICY_NOT_PREDICATE_FIELDS = Object.freeze(["kind", "predicate"] as const);
export const POLICY_LINK_EXISTS_PREDICATE_FIELDS = Object.freeze([
  "kind",
  "linkTypeApiName",
  "linkTypeResourceId",
  "linkTypeRevisionId",
  "targetObjectTypeApiName",
  "targetObjectTypeResourceId",
  "targetObjectTypeRevisionId",
  "predicate",
] as const);
export const POLICY_LINK_EXISTS_PREDICATE_REQUIRED_FIELDS = Object.freeze([
  "kind",
  "linkTypeApiName",
  "targetObjectTypeApiName",
  "predicate",
] as const);
export const POLICY_MASK_FIELDS = Object.freeze(["kind", "displayValue"] as const);
export const POLICY_RULE_FIELDS = Object.freeze([
  "ruleId",
  "target",
  "effect",
  "predicate",
  "mask",
] as const);
export const POLICY_RULE_REQUIRED_FIELDS = Object.freeze([
  "ruleId",
  "target",
  "effect",
  "predicate",
] as const);
export const POLICY_FACT_FIELDS = Object.freeze([
  "source",
  "apiName",
  "state",
  "value",
  "values",
] as const);
export const POLICY_FACT_REQUIRED_FIELDS = Object.freeze(["source", "apiName", "state"] as const);
export const POLICY_TEST_VECTOR_FIELDS = Object.freeze([
  "vectorId",
  "identity",
  "requestTime",
  "target",
  "facts",
  "expectedDecision",
  "expectedPropertyDisposition",
] as const);
export const POLICY_TEST_VECTOR_REQUIRED_FIELDS = Object.freeze([
  "vectorId",
  "identity",
  "requestTime",
  "target",
  "facts",
  "expectedDecision",
] as const);
export const POLICY_ACTOR_ATTRIBUTE_SCHEMA_FIELDS = Object.freeze([
  "apiName",
  "valueType",
] as const);
export const POLICY_RESOURCE_DEFINITION_FIELDS = Object.freeze([
  "schemaVersion",
  "rules",
  "testVectors",
] as const);
export const POLICY_ARTIFACT_FIELDS = Object.freeze([
  "schemaVersion",
  "projectId",
  "releaseId",
  "policyRevisionId",
  "compilerVersion",
  "artifactDigest",
  "dependencyContextDigest",
  "trustedActorAttributes",
  "rules",
  "testVectors",
] as const);
export const POLICY_ARTIFACT_REQUIRED_FIELDS = Object.freeze(
  POLICY_ARTIFACT_FIELDS.filter(
    (field) => field !== "dependencyContextDigest" && field !== "trustedActorAttributes",
  ),
);
export const POLICY_DECISION_FIELDS = Object.freeze([
  "schemaVersion",
  "target",
  "decision",
  "propertyDisposition",
  "mask",
  "policyContextHash",
  "authorizationEpoch",
  "evaluatedAt",
] as const);
export const POLICY_DECISION_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "target",
  "decision",
  "policyContextHash",
  "authorizationEpoch",
  "evaluatedAt",
] as const);

export function parsePolicyArtifact(value: unknown): PolicyArtifact {
  const path = "$policyArtifact";
  const record = strictRecord(value, path, POLICY_ARTIFACT_FIELDS, POLICY_ARTIFACT_REQUIRED_FIELDS);
  const rules = parsePolicyRules(record.rules, path);
  const testVectors = parsePolicyTestVectors(record.testVectors, rules, path);
  for (const [index, rule] of rules.entries()) {
    assertPolicyResourcePredicateBindings(
      rule.predicate,
      `${path}.rules[${String(index)}].predicate`,
    );
  }
  const trustedActorAttributes =
    record.trustedActorAttributes === undefined
      ? undefined
      : parsePolicyActorAttributes(record.trustedActorAttributes, `${path}.trustedActorAttributes`);
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    projectId: parseOntosId(record.projectId, `${path}.projectId`),
    releaseId: parseOntosId(record.releaseId, `${path}.releaseId`),
    policyRevisionId: parseOntosId(record.policyRevisionId, `${path}.policyRevisionId`),
    compilerVersion: requireString(record.compilerVersion, `${path}.compilerVersion`, {
      minimumLength: 1,
      maximumLength: 64,
      pattern: compilerVersionExpression,
    }),
    artifactDigest: parseArtifactDigest(record.artifactDigest, `${path}.artifactDigest`),
    ...(record.dependencyContextDigest === undefined
      ? {}
      : {
          dependencyContextDigest: parseArtifactDigest(
            record.dependencyContextDigest,
            `${path}.dependencyContextDigest`,
          ),
        }),
    ...(trustedActorAttributes === undefined ? {} : { trustedActorAttributes }),
    rules,
    testVectors,
  });
}

export function parsePolicyResourceDefinition(value: unknown): PolicyResourceDefinition {
  const path = "$policy";
  const record = strictRecord(
    value,
    path,
    POLICY_RESOURCE_DEFINITION_FIELDS,
    POLICY_RESOURCE_DEFINITION_FIELDS,
  );
  const rules = parsePolicyRules(record.rules, path);
  if (
    rules.some(({ target }) => target.kind === "resource") ||
    testVectorsContainResourceTarget(record.testVectors)
  ) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Policy Resources require an explicit Object, Property, Link or Action target.",
      `${path}.rules`,
    );
  }
  const testVectors = parsePolicyTestVectors(record.testVectors, rules, path);
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    rules,
    testVectors,
  });
}

export function extractPolicyResourceDependencies(
  sourceRevisionId: string,
  definitionInput: unknown,
): readonly PolicyResourceDependency[] {
  const definition = parsePolicyResourceDefinition(definitionInput);
  const dependencies: PolicyResourceDependency[] = [];
  for (const [index, rule] of definition.rules.entries()) {
    const path = `/rules/${String(index)}`;
    if (rule.target.kind === "object") {
      dependencies.push(
        policyDependency(sourceRevisionId, rule.target.resourceId, rule.target.resourceRevisionId, {
          dependencyType: "policy_object_target",
          sourcePath: `${path}/target/resourceRevisionId`,
          expectedFamily: "object_type",
        }),
      );
    } else if (rule.target.kind === "property") {
      const propertyApiName = requiredPolicyBinding(rule.target.propertyApiName);
      dependencies.push(
        policyDependency(sourceRevisionId, rule.target.resourceId, rule.target.resourceRevisionId, {
          dependencyType: "policy_property_target",
          sourcePath: `${path}/target/resourceRevisionId`,
          expectedFamily: "object_type",
          propertyApiName,
        }),
      );
    } else if (rule.target.kind === "link") {
      dependencies.push(
        policyDependency(sourceRevisionId, rule.target.resourceId, rule.target.resourceRevisionId, {
          dependencyType: "policy_link_target",
          sourcePath: `${path}/target/resourceRevisionId`,
          expectedFamily: "link_type",
        }),
      );
    } else if (rule.target.kind === "action_target") {
      const targetObjectTypeResourceId = requiredPolicyBinding(
        rule.target.targetObjectTypeResourceId,
      );
      const targetObjectTypeRevisionId = requiredPolicyBinding(
        rule.target.targetObjectTypeRevisionId,
      );
      dependencies.push(
        policyDependency(sourceRevisionId, rule.target.resourceId, rule.target.resourceRevisionId, {
          dependencyType: "policy_action_target",
          sourcePath: `${path}/target/resourceRevisionId`,
          expectedFamily: "action_type",
        }),
        policyDependency(sourceRevisionId, targetObjectTypeResourceId, targetObjectTypeRevisionId, {
          dependencyType: "policy_object_target",
          sourcePath: `${path}/target/targetObjectTypeRevisionId`,
          expectedFamily: "object_type",
        }),
      );
    }
    collectPredicateDependencies(
      sourceRevisionId,
      rule.predicate,
      `${path}/predicate`,
      dependencies,
    );
  }
  for (const [index, vector] of definition.testVectors.entries()) {
    collectTargetDependencies(
      sourceRevisionId,
      vector.target,
      `/testVectors/${String(index)}/target`,
      dependencies,
    );
  }
  return Object.freeze(dependencies.sort(comparePolicyDependencies));
}

export function parsePolicyDecision(value: unknown): PolicyDecision {
  const path = "$policyDecision";
  const record = strictRecord(value, path, POLICY_DECISION_FIELDS, POLICY_DECISION_REQUIRED_FIELDS);
  const target = parsePolicyTarget(record.target, `${path}.target`);
  const decision = requireOneOf(
    record.decision,
    new Set(["allow", "deny"] as const),
    `${path}.decision`,
  );
  const propertyDisposition =
    record.propertyDisposition === undefined
      ? undefined
      : requireOneOf(
          record.propertyDisposition,
          propertyDispositions,
          `${path}.propertyDisposition`,
        );
  const mask = record.mask === undefined ? undefined : parsePolicyMask(record.mask, `${path}.mask`);
  if (target.kind === "property" && propertyDisposition === undefined) {
    failContract(
      "CONTRACT_FIELD_MISSING",
      "Property decisions require propertyDisposition.",
      `${path}.propertyDisposition`,
    );
  }
  if (target.kind !== "property" && propertyDisposition !== undefined) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Only Property decisions may carry propertyDisposition.",
      `${path}.propertyDisposition`,
    );
  }
  if ((propertyDisposition === "mask") !== (mask !== undefined)) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "A mask payload is required exactly when the Property disposition is mask.",
      `${path}.mask`,
    );
  }
  if (decision === "deny" && propertyDisposition !== undefined && propertyDisposition !== "deny") {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "A denied Property decision cannot carry an allow or mask disposition.",
      `${path}.propertyDisposition`,
    );
  }
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    target,
    decision,
    ...(propertyDisposition === undefined ? {} : { propertyDisposition }),
    ...(mask === undefined ? {} : { mask }),
    policyContextHash: parseArtifactDigest(record.policyContextHash, `${path}.policyContextHash`),
    authorizationEpoch: requireString(record.authorizationEpoch, `${path}.authorizationEpoch`, {
      minimumLength: 1,
      maximumLength: 19,
      pattern: authorizationEpochExpression,
    }),
    evaluatedAt: parseCanonicalInstant(record.evaluatedAt, `${path}.evaluatedAt`),
  });
}

export function parsePolicyPredicate(value: unknown): PolicyPredicate {
  return parsePolicyPredicateNode(value, "$policyPredicate", { count: 0 }, 0, true);
}

function parsePolicyRule(value: unknown, path: string): PolicyRule {
  const record = strictRecord(value, path, POLICY_RULE_FIELDS, POLICY_RULE_REQUIRED_FIELDS);
  const target = parsePolicyTarget(record.target, `${path}.target`);
  const effect = requireOneOf(record.effect, policyEffects, `${path}.effect`);
  const mask = record.mask === undefined ? undefined : parsePolicyMask(record.mask, `${path}.mask`);
  if (effect === "mask" && target.kind !== "property") {
    failContract("CONTRACT_FORMAT_INVALID", "Only Property rules may mask.", `${path}.effect`);
  }
  if ((effect === "mask") !== (mask !== undefined)) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "A mask descriptor is required exactly for mask rules.",
      `${path}.mask`,
    );
  }
  return Object.freeze({
    ruleId: parseStableName(record.ruleId, `${path}.ruleId`),
    target,
    effect,
    predicate: parsePolicyPredicateNode(
      record.predicate,
      `${path}.predicate`,
      { count: 0 },
      0,
      true,
    ),
    ...(mask === undefined ? {} : { mask }),
  });
}

function parsePolicyTarget(value: unknown, path: string): PolicyTarget {
  const record = strictRecord(value, path, POLICY_TARGET_FIELDS, POLICY_TARGET_REQUIRED_FIELDS);
  const kind = requireOneOf(record.kind, targetKinds, `${path}.kind`);
  const propertyApiName =
    record.propertyApiName === undefined
      ? undefined
      : parseApiName(record.propertyApiName, `${path}.propertyApiName`);
  const targetObjectTypeResourceId =
    record.targetObjectTypeResourceId === undefined
      ? undefined
      : parseOntosId(record.targetObjectTypeResourceId, `${path}.targetObjectTypeResourceId`);
  const targetObjectTypeRevisionId =
    record.targetObjectTypeRevisionId === undefined
      ? undefined
      : parseOntosId(record.targetObjectTypeRevisionId, `${path}.targetObjectTypeRevisionId`);
  if ((kind === "property") !== (propertyApiName !== undefined)) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "propertyApiName is required exactly for Property targets.",
      `${path}.propertyApiName`,
    );
  }
  if (
    (kind === "action_target") !==
    (targetObjectTypeResourceId !== undefined && targetObjectTypeRevisionId !== undefined)
  ) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Action targets require both target Object Type bindings; other targets forbid them.",
      path,
    );
  }
  return Object.freeze({
    kind,
    resourceId: parseOntosId(record.resourceId, `${path}.resourceId`),
    resourceRevisionId: parseOntosId(record.resourceRevisionId, `${path}.resourceRevisionId`),
    ...(propertyApiName === undefined ? {} : { propertyApiName }),
    ...(targetObjectTypeResourceId === undefined ? {} : { targetObjectTypeResourceId }),
    ...(targetObjectTypeRevisionId === undefined ? {} : { targetObjectTypeRevisionId }),
  });
}

function parsePolicyPredicateNode(
  value: unknown,
  path: string,
  state: { count: number },
  depth: number,
  linkAllowed: boolean,
): PolicyPredicate {
  if (depth > POLICY_LOGICAL_MAXIMUM_DEPTH) {
    failContract("CONTRACT_VALUE_OUT_OF_RANGE", "Policy nesting is too deep.", path);
  }
  state.count += 1;
  if (state.count > POLICY_PREDICATE_MAXIMUM_COUNT) {
    failContract("CONTRACT_VALUE_OUT_OF_RANGE", "Policy has too many predicates.", path);
  }
  const record = requirePlainRecord(value, path);
  const kind = record.kind;
  if (kind === "constant") {
    requireObjectShape(
      record,
      POLICY_CONSTANT_PREDICATE_FIELDS,
      POLICY_CONSTANT_PREDICATE_FIELDS,
      path,
    );
    return Object.freeze({ kind, value: requireBoolean(record.value, `${path}.value`) });
  }
  if (kind === "compare") {
    requireObjectShape(
      record,
      POLICY_COMPARISON_PREDICATE_FIELDS,
      POLICY_COMPARISON_PREDICATE_FIELDS,
      path,
    );
    const op = requireOneOf(record.op, comparisonOperators, `${path}.op`);
    const right = parsePolicyOperand(record.right, `${path}.right`);
    if (
      collectionOperators.has(op) &&
      (right.source !== "constant" || !Array.isArray(right.value))
    ) {
      failContract(
        "CONTRACT_TYPE_INVALID",
        `${op} requires a constant collection on the right.`,
        `${path}.right`,
      );
    }
    if (
      stringOperators.has(op) &&
      (right.source !== "constant" || typeof right.value !== "string")
    ) {
      failContract(
        "CONTRACT_TYPE_INVALID",
        `${op} requires a constant string on the right.`,
        `${path}.right`,
      );
    }
    return Object.freeze({
      kind,
      left: parsePolicyOperand(record.left, `${path}.left`),
      op,
      right,
    });
  }
  if (kind === "is_null") {
    requireObjectShape(record, POLICY_NULL_PREDICATE_FIELDS, POLICY_NULL_PREDICATE_FIELDS, path);
    return Object.freeze({ kind, operand: parsePolicyOperand(record.operand, `${path}.operand`) });
  }
  if (kind === "all" || kind === "any") {
    requireObjectShape(
      record,
      POLICY_LOGICAL_PREDICATE_FIELDS,
      POLICY_LOGICAL_PREDICATE_FIELDS,
      path,
    );
    const predicates = Object.freeze(
      requireArray(record.predicates, `${path}.predicates`, {
        minimumItems: 1,
        maximumItems: POLICY_PREDICATE_MAXIMUM_COUNT,
      }).map((item, index) =>
        parsePolicyPredicateNode(
          item,
          `${path}.predicates[${index}]`,
          state,
          depth + 1,
          linkAllowed,
        ),
      ),
    );
    return Object.freeze({ kind, predicates });
  }
  if (kind === "not") {
    requireObjectShape(record, POLICY_NOT_PREDICATE_FIELDS, POLICY_NOT_PREDICATE_FIELDS, path);
    return Object.freeze({
      kind,
      predicate: parsePolicyPredicateNode(
        record.predicate,
        `${path}.predicate`,
        state,
        depth + 1,
        linkAllowed,
      ),
    });
  }
  if (kind === "link_exists") {
    requireObjectShape(
      record,
      POLICY_LINK_EXISTS_PREDICATE_FIELDS,
      POLICY_LINK_EXISTS_PREDICATE_REQUIRED_FIELDS,
      path,
    );
    if (!linkAllowed) {
      failContract(
        "CONTRACT_VALUE_OUT_OF_RANGE",
        "Policy traversal is limited to one one-hop Link Exists.",
        path,
      );
    }
    const exactBindings = [
      record.linkTypeResourceId,
      record.linkTypeRevisionId,
      record.targetObjectTypeResourceId,
      record.targetObjectTypeRevisionId,
    ];
    if (
      exactBindings.some((binding) => binding === undefined) &&
      exactBindings.some((binding) => binding !== undefined)
    ) {
      failContract(
        "CONTRACT_FIELD_MISSING",
        "Exact Link Policy bindings must be supplied together.",
        path,
      );
    }
    return Object.freeze({
      kind,
      linkTypeApiName: parseApiName(record.linkTypeApiName, `${path}.linkTypeApiName`),
      ...(record.linkTypeResourceId === undefined
        ? {}
        : {
            linkTypeResourceId: parseOntosId(
              record.linkTypeResourceId,
              `${path}.linkTypeResourceId`,
            ),
            linkTypeRevisionId: parseOntosId(
              record.linkTypeRevisionId,
              `${path}.linkTypeRevisionId`,
            ),
          }),
      targetObjectTypeApiName: parseApiName(
        record.targetObjectTypeApiName,
        `${path}.targetObjectTypeApiName`,
      ),
      ...(record.targetObjectTypeResourceId === undefined
        ? {}
        : {
            targetObjectTypeResourceId: parseOntosId(
              record.targetObjectTypeResourceId,
              `${path}.targetObjectTypeResourceId`,
            ),
            targetObjectTypeRevisionId: parseOntosId(
              record.targetObjectTypeRevisionId,
              `${path}.targetObjectTypeRevisionId`,
            ),
          }),
      predicate: parsePolicyPredicateNode(
        record.predicate,
        `${path}.predicate`,
        state,
        depth + 1,
        false,
      ),
    });
  }
  failContract("CONTRACT_FORMAT_INVALID", "Unknown Policy predicate kind.", `${path}.kind`);
}

function parsePolicyOperand(value: unknown, path: string): PolicyOperand {
  const record = requirePlainRecord(value, path);
  const source = record.source;
  if (source === "object_property" || source === "actor_attribute") {
    requireObjectShape(record, ["source", "apiName"], ["source", "apiName"], path);
    return Object.freeze({ source, apiName: parseApiName(record.apiName, `${path}.apiName`) });
  }
  if (source === "request_time") {
    requireObjectShape(record, ["source"], ["source"], path);
    return Object.freeze({ source });
  }
  if (source === "constant") {
    requireObjectShape(record, ["source", "value"], ["source", "value"], path);
    if (Array.isArray(record.value)) {
      const values = requireArray(record.value, `${path}.value`, {
        minimumItems: 1,
        maximumItems: POLICY_COLLECTION_MAXIMUM_ITEMS,
      }).map((item, index) => parseQueryScalar(item, `${path}.value[${index}]`));
      if (new Set(values.map((item) => JSON.stringify(item))).size !== values.length) {
        failContract(
          "CONTRACT_FORMAT_INVALID",
          "Policy constants must be unique.",
          `${path}.value`,
        );
      }
      return Object.freeze({ source, value: Object.freeze(values) });
    }
    return Object.freeze({ source, value: parseQueryScalar(record.value, `${path}.value`) });
  }
  failContract("CONTRACT_FORMAT_INVALID", "Unknown Policy operand source.", `${path}.source`);
}

function parsePolicyMask(value: unknown, path: string): PolicyMask {
  const record = strictRecord(value, path, POLICY_MASK_FIELDS, POLICY_MASK_FIELDS);
  if (record.kind !== "redact") {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Only deterministic redaction is active.",
      `${path}.kind`,
    );
  }
  return Object.freeze({
    kind: "redact",
    displayValue: requireString(record.displayValue, `${path}.displayValue`, {
      minimumLength: 1,
      maximumLength: 64,
    }),
  });
}

function parsePolicyTestVector(value: unknown, path: string): PolicyTestVector {
  const record = strictRecord(
    value,
    path,
    POLICY_TEST_VECTOR_FIELDS,
    POLICY_TEST_VECTOR_REQUIRED_FIELDS,
  );
  const expectedPropertyDisposition =
    record.expectedPropertyDisposition === undefined
      ? undefined
      : requireOneOf(
          record.expectedPropertyDisposition,
          propertyDispositions,
          `${path}.expectedPropertyDisposition`,
        );
  const target = parsePolicyTarget(record.target, `${path}.target`);
  if ((target.kind === "property") !== (expectedPropertyDisposition !== undefined)) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Property test vectors require an expected Property disposition only for Property targets.",
      `${path}.expectedPropertyDisposition`,
    );
  }
  return Object.freeze({
    vectorId: parseStableName(record.vectorId, `${path}.vectorId`),
    identity: parseIdentityDelegationSummary(record.identity),
    requestTime: parseCanonicalInstant(record.requestTime, `${path}.requestTime`),
    target,
    facts: Object.freeze(
      requireArray(record.facts, `${path}.facts`, {
        maximumItems: POLICY_FACT_MAXIMUM_ITEMS,
      }).map((item, index) => parsePolicyFact(item, `${path}.facts[${index}]`)),
    ),
    expectedDecision: requireOneOf(
      record.expectedDecision,
      new Set(["allow", "deny"] as const),
      `${path}.expectedDecision`,
    ),
    ...(expectedPropertyDisposition === undefined ? {} : { expectedPropertyDisposition }),
  });
}

function parsePolicyFact(value: unknown, path: string): PolicyFact {
  const record = strictRecord(value, path, POLICY_FACT_FIELDS, POLICY_FACT_REQUIRED_FIELDS);
  const source = requireOneOf(
    record.source,
    new Set(["object_property", "actor_attribute", "link"] as const),
    `${path}.source`,
  );
  const state = requireOneOf(
    record.state,
    new Set(["value", "null", "missing"] as const),
    `${path}.state`,
  );
  const hasScalarValue = Object.hasOwn(record, "value");
  const hasStringValues = Object.hasOwn(record, "values");
  if (
    (state === "value" && Number(hasScalarValue) + Number(hasStringValues) !== 1) ||
    (state !== "value" && (hasScalarValue || hasStringValues))
  ) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Policy fact requires exactly one scalar value or string values collection for value state.",
      `${path}.value`,
    );
  }
  const values = hasStringValues
    ? Object.freeze(
        requireArray(record.values, `${path}.values`, {
          maximumItems: POLICY_COLLECTION_MAXIMUM_ITEMS,
        }).map((item, index) => {
          const parsed = parseQueryScalar(item, `${path}.values[${String(index)}]`);
          if (typeof parsed !== "string") {
            failContract(
              "CONTRACT_TYPE_INVALID",
              "Policy fact collections contain only strings.",
              `${path}.values[${String(index)}]`,
            );
          }
          return parsed;
        }),
      )
    : undefined;
  if (
    values !== undefined &&
    values.some((item, index) => index > 0 && item <= (values[index - 1] ?? ""))
  ) {
    failContract(
      "CONTRACT_FORMAT_INVALID",
      "Policy fact string collections must be unique and sorted.",
      `${path}.values`,
    );
  }
  return Object.freeze({
    source,
    apiName: parseApiName(record.apiName, `${path}.apiName`),
    state,
    ...(hasScalarValue ? { value: parseQueryScalar(record.value, `${path}.value`) } : {}),
    ...(values === undefined ? {} : { values }),
  });
}

function assertTestCoverage(
  rules: readonly PolicyRule[],
  vectors: readonly PolicyTestVector[],
  path: string,
): void {
  if (!vectors.some(({ expectedDecision }) => expectedDecision === "allow")) {
    failContract("CONTRACT_FORMAT_INVALID", "Policy tests require an allow vector.", path);
  }
  if (!vectors.some(({ expectedDecision }) => expectedDecision === "deny")) {
    failContract("CONTRACT_FORMAT_INVALID", "Policy tests require a deny vector.", path);
  }
  for (const state of ["null", "missing"] as const) {
    if (!vectors.some(({ facts }) => facts.some((fact) => fact.state === state))) {
      failContract("CONTRACT_FORMAT_INVALID", `Policy tests require a ${state} fact vector.`, path);
    }
  }
  const linkUsed = rules.some(
    (rule) => rule.target.kind === "link" || predicateContainsLink(rule.predicate),
  );
  if (
    linkUsed &&
    !vectors.some(
      ({ target, expectedDecision }) => target.kind === "link" && expectedDecision === "deny",
    )
  ) {
    failContract("CONTRACT_FORMAT_INVALID", "Link Policy requires an invisible Link vector.", path);
  }
  for (const disposition of ["mask", "deny"] as const) {
    if (
      rules.some((rule) => rule.target.kind === "property" && rule.effect === disposition) &&
      !vectors.some(
        ({ expectedPropertyDisposition }) => expectedPropertyDisposition === disposition,
      )
    ) {
      failContract(
        "CONTRACT_FORMAT_INVALID",
        `Property ${disposition} requires a matching test vector.`,
        path,
      );
    }
  }
}

function parsePolicyRules(value: unknown, parentPath: string): readonly PolicyRule[] {
  const path = `${parentPath}.rules`;
  const rules = Object.freeze(
    requireArray(value, path, {
      minimumItems: 1,
      maximumItems: POLICY_RULE_MAXIMUM_ITEMS,
    }).map((item, index) => parsePolicyRule(item, `${path}[${index}]`)),
  );
  assertUniqueSorted(
    rules.map(({ ruleId }) => ruleId),
    path,
  );
  return rules;
}

function parsePolicyTestVectors(
  value: unknown,
  rules: readonly PolicyRule[],
  parentPath: string,
): readonly PolicyTestVector[] {
  const path = `${parentPath}.testVectors`;
  const testVectors = Object.freeze(
    requireArray(value, path, {
      minimumItems: 1,
      maximumItems: POLICY_TEST_VECTOR_MAXIMUM_ITEMS,
    }).map((item, index) => parsePolicyTestVector(item, `${path}[${index}]`)),
  );
  assertUniqueSorted(
    testVectors.map(({ vectorId }) => vectorId),
    path,
  );
  assertTestCoverage(rules, testVectors, path);
  return testVectors;
}

function parsePolicyActorAttributes(
  value: unknown,
  path: string,
): readonly PolicyActorAttributeSchema[] {
  const valueTypes = new Set<PolicyActorAttributeValueType>(["string", "string_array", "boolean"]);
  const attributes = Object.freeze(
    requireArray(value, path, { maximumItems: 32 }).map((item, index) => {
      const itemPath = `${path}[${String(index)}]`;
      const record = strictRecord(
        item,
        itemPath,
        POLICY_ACTOR_ATTRIBUTE_SCHEMA_FIELDS,
        POLICY_ACTOR_ATTRIBUTE_SCHEMA_FIELDS,
      );
      return Object.freeze({
        apiName: parseApiName(record.apiName, `${itemPath}.apiName`),
        valueType: requireOneOf(record.valueType, valueTypes, `${itemPath}.valueType`),
      });
    }),
  );
  assertUniqueSorted(
    attributes.map(({ apiName }) => apiName),
    path,
  );
  return attributes;
}

function policyDependency(
  sourceRevisionId: string,
  targetResourceId: OntosId,
  targetRevisionId: OntosId,
  descriptor: Omit<
    PolicyResourceDependency,
    "sourceRevisionId" | "targetResourceId" | "targetRevisionId"
  >,
): PolicyResourceDependency {
  return Object.freeze({ sourceRevisionId, targetResourceId, targetRevisionId, ...descriptor });
}

function collectTargetDependencies(
  sourceRevisionId: string,
  target: PolicyTarget,
  path: string,
  dependencies: PolicyResourceDependency[],
): void {
  if (target.kind === "object" || target.kind === "property" || target.kind === "link") {
    const propertyApiName =
      target.kind === "property" ? requiredPolicyBinding(target.propertyApiName) : undefined;
    dependencies.push(
      policyDependency(sourceRevisionId, target.resourceId, target.resourceRevisionId, {
        dependencyType:
          target.kind === "object"
            ? "policy_object_target"
            : target.kind === "property"
              ? "policy_property_target"
              : "policy_link_target",
        sourcePath: `${path}/resourceRevisionId`,
        expectedFamily: target.kind === "link" ? "link_type" : "object_type",
        ...(propertyApiName === undefined ? {} : { propertyApiName }),
      }),
    );
  } else if (target.kind === "action_target") {
    const targetObjectTypeResourceId = requiredPolicyBinding(target.targetObjectTypeResourceId);
    const targetObjectTypeRevisionId = requiredPolicyBinding(target.targetObjectTypeRevisionId);
    dependencies.push(
      policyDependency(sourceRevisionId, target.resourceId, target.resourceRevisionId, {
        dependencyType: "policy_action_target",
        sourcePath: `${path}/resourceRevisionId`,
        expectedFamily: "action_type",
      }),
      policyDependency(sourceRevisionId, targetObjectTypeResourceId, targetObjectTypeRevisionId, {
        dependencyType: "policy_object_target",
        sourcePath: `${path}/targetObjectTypeRevisionId`,
        expectedFamily: "object_type",
      }),
    );
  }
}

function testVectorsContainResourceTarget(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const target = (item as Readonly<Record<string, unknown>>)["target"];
    return (
      typeof target === "object" &&
      target !== null &&
      !Array.isArray(target) &&
      (target as Readonly<Record<string, unknown>>)["kind"] === "resource"
    );
  });
}

function collectPredicateDependencies(
  sourceRevisionId: string,
  predicate: PolicyPredicate,
  path: string,
  dependencies: PolicyResourceDependency[],
): void {
  if (predicate.kind === "link_exists") {
    const linkTypeResourceId = requiredPolicyBinding(predicate.linkTypeResourceId);
    const linkTypeRevisionId = requiredPolicyBinding(predicate.linkTypeRevisionId);
    const targetObjectTypeResourceId = requiredPolicyBinding(predicate.targetObjectTypeResourceId);
    const targetObjectTypeRevisionId = requiredPolicyBinding(predicate.targetObjectTypeRevisionId);
    dependencies.push(
      policyDependency(sourceRevisionId, linkTypeResourceId, linkTypeRevisionId, {
        dependencyType: "policy_link_target",
        sourcePath: `${path}/linkTypeRevisionId`,
        expectedFamily: "link_type",
        expectedApiName: predicate.linkTypeApiName,
      }),
      policyDependency(sourceRevisionId, targetObjectTypeResourceId, targetObjectTypeRevisionId, {
        dependencyType: "policy_object_target",
        sourcePath: `${path}/targetObjectTypeRevisionId`,
        expectedFamily: "object_type",
        expectedApiName: predicate.targetObjectTypeApiName,
      }),
    );
    collectPredicateDependencies(
      sourceRevisionId,
      predicate.predicate,
      `${path}/predicate`,
      dependencies,
    );
    return;
  }
  if (predicate.kind === "all" || predicate.kind === "any") {
    predicate.predicates.forEach((item, index) =>
      collectPredicateDependencies(
        sourceRevisionId,
        item,
        `${path}/predicates/${String(index)}`,
        dependencies,
      ),
    );
  } else if (predicate.kind === "not") {
    collectPredicateDependencies(
      sourceRevisionId,
      predicate.predicate,
      `${path}/predicate`,
      dependencies,
    );
  }
}

function assertPolicyResourcePredicateBindings(predicate: PolicyPredicate, path: string): void {
  if (predicate.kind === "link_exists") {
    if (
      predicate.linkTypeResourceId === undefined ||
      predicate.linkTypeRevisionId === undefined ||
      predicate.targetObjectTypeResourceId === undefined ||
      predicate.targetObjectTypeRevisionId === undefined
    ) {
      failContract(
        "CONTRACT_FIELD_MISSING",
        "Policy Resource Link Exists requires exact Link and target Object Revision bindings.",
        path,
      );
    }
    assertPolicyResourcePredicateBindings(predicate.predicate, `${path}.predicate`);
  } else if (predicate.kind === "all" || predicate.kind === "any") {
    predicate.predicates.forEach((item, index) =>
      assertPolicyResourcePredicateBindings(item, `${path}.predicates[${String(index)}]`),
    );
  } else if (predicate.kind === "not") {
    assertPolicyResourcePredicateBindings(predicate.predicate, `${path}.predicate`);
  }
}

function comparePolicyDependencies(
  left: PolicyResourceDependency,
  right: PolicyResourceDependency,
): number {
  return (
    compareText(left.sourceRevisionId, right.sourceRevisionId) ||
    compareText(left.dependencyType, right.dependencyType) ||
    compareText(left.sourcePath, right.sourcePath) ||
    compareText(left.targetRevisionId, right.targetRevisionId)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredPolicyBinding<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError("Parsed Policy target lost a required exact binding.");
  }
  return value;
}

function predicateContainsLink(predicate: PolicyPredicate): boolean {
  if (predicate.kind === "link_exists") return true;
  if (predicate.kind === "all" || predicate.kind === "any") {
    return predicate.predicates.some(predicateContainsLink);
  }
  if (predicate.kind === "not") return predicateContainsLink(predicate.predicate);
  return false;
}

function assertUniqueSorted(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length || !isStrictlySorted(values)) {
    failContract("CONTRACT_FORMAT_INVALID", "Entries must be unique and sorted.", path);
  }
}

function isStrictlySorted(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values.at(index - 1);
    const current = values.at(index);
    if (previous === undefined || current === undefined || previous >= current) {
      return false;
    }
  }
  return true;
}

function parseStableName(value: unknown, path: string): string {
  return requireString(value, path, {
    minimumLength: 1,
    maximumLength: 64,
    pattern: stableNameExpression,
  });
}

function parseApiName(value: unknown, path: string): string {
  return requireString(value, path, {
    minimumLength: 1,
    maximumLength: 63,
    pattern: apiNameExpression,
  });
}

function strictRecord(
  value: unknown,
  path: string,
  fields: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  const record = requirePlainRecord(value, path);
  requireObjectShape(record, fields, required, path);
  return record;
}
