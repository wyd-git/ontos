import type {
  ArtifactDigest,
  CanonicalInstant,
  PolicyOperand,
  PolicyPredicate,
  PolicyRule,
  PolicyTarget,
} from "@ontos/contracts";

import { failQuery } from "./error.ts";
import type {
  QueryParameterOperand,
  QueryPolicyPlan,
  QueryPredicatePlan,
  QueryPropertyAccessPlan,
  QueryTypedOperand,
} from "./model.ts";
import {
  requireQueryProperty,
  type QueryLinkTypeSchema,
  type QueryObjectTypeSchema,
  type QueryPropertySchema,
  type QuerySchemaRegistry,
} from "./schema-registry.ts";
import {
  canonicalizeActorParameter,
  canonicalizeRequestTimeParameter,
  canonicalizeTrustedPolicyCollectionParameter,
  canonicalizeTrustedPolicyParameter,
  queryOperandValueType,
} from "./value.ts";

export interface QueryPolicyActorAttribute {
  readonly name: string;
  readonly value: boolean | string | readonly string[];
}

export interface QueryPolicyContext {
  readonly projectId: string;
  readonly resourceId: string;
  readonly resourceRevisionId: string;
  readonly releaseId: string;
  readonly artifactDigest: ArtifactDigest;
  readonly authorizationEpoch: string;
  readonly policyContextHash: ArtifactDigest;
  readonly policyRules: readonly PolicyRule[];
  readonly trustedActorAttributes: readonly QueryPolicyActorAttribute[];
}

export function compileObjectPolicyPlan(input: {
  readonly registry: QuerySchemaRegistry;
  readonly object: QueryObjectTypeSchema;
  readonly context: QueryPolicyContext;
  readonly requestTime: CanonicalInstant;
}): QueryPolicyPlan {
  assertPolicyBinding(input.registry, input.context, input.object);
  const state = policyCompilationState(input.registry, input.context, input.requestTime);
  const rowRules = input.context.policyRules.filter((rule) =>
    sameObjectTarget(rule.target, input.object),
  );
  const propertyAccess = input.object.properties.map((property) =>
    compilePropertyAccess(input.context.policyRules, input.object, property, state),
  );
  return Object.freeze({
    policyContextHash: input.context.policyContextHash,
    authorizationEpoch: input.context.authorizationEpoch,
    rowAllow: anyOf(
      rowRules
        .filter((rule) => rule.effect === "allow")
        .map((rule) => compilePolicyPredicate(rule.predicate, input.object, "root", state)),
    ),
    rowDeny: anyOf(
      rowRules
        .filter((rule) => rule.effect === "deny")
        .map((rule) => compilePolicyPredicate(rule.predicate, input.object, "root", state)),
    ),
    propertyAccess: Object.freeze(propertyAccess),
  });
}

export function compileLinkPolicyPlan(input: {
  readonly registry: QuerySchemaRegistry;
  readonly link: QueryLinkTypeSchema;
  readonly context: QueryPolicyContext;
  readonly requestTime: CanonicalInstant;
}): QueryPolicyPlan {
  assertPolicyBinding(input.registry, input.context, input.link);
  const state = policyCompilationState(input.registry, input.context, input.requestTime);
  const rules = input.context.policyRules.filter((rule) => sameLinkTarget(rule.target, input.link));
  return Object.freeze({
    policyContextHash: input.context.policyContextHash,
    authorizationEpoch: input.context.authorizationEpoch,
    rowAllow: anyOf(
      rules
        .filter((rule) => rule.effect === "allow")
        .map((rule) => compilePolicyPredicate(rule.predicate, null, "root", state)),
    ),
    rowDeny: anyOf(
      rules
        .filter((rule) => rule.effect === "deny")
        .map((rule) => compilePolicyPredicate(rule.predicate, null, "root", state)),
    ),
    propertyAccess: Object.freeze([]),
  });
}

export function requirePropertyAccess(
  policy: QueryPolicyPlan,
  property: QueryPropertySchema,
): QueryPropertyAccessPlan {
  const access = policy.propertyAccess.find(
    (candidate) => candidate.property.apiName === property.apiName,
  );
  if (access === undefined || !access.canEverAllow) {
    failQuery("PROPERTY_NOT_QUERYABLE", "Property has no applicable allow Policy.");
  }
  return access;
}

export function requirePropertyReadAccess(
  policy: QueryPolicyPlan,
  property: QueryPropertySchema,
): QueryPropertyAccessPlan {
  const access = policy.propertyAccess.find(
    (candidate) => candidate.property.apiName === property.apiName,
  );
  if (access === undefined || (!access.canEverAllow && access.masks.length === 0)) {
    failQuery("PROPERTY_NOT_QUERYABLE", "Property is not readable under the bound Policy.");
  }
  return access;
}

export function propertyValueAllowedPredicate(access: QueryPropertyAccessPlan): QueryPredicatePlan {
  return allOf([
    access.allow,
    Object.freeze({ kind: "not", predicate: access.deny }),
    ...access.masks.map((mask) =>
      Object.freeze({ kind: "not" as const, predicate: mask.predicate }),
    ),
  ]);
}

interface PolicyCompilationState {
  readonly registry: QuerySchemaRegistry;
  readonly attributes: ReadonlyMap<string, QueryPolicyActorAttribute["value"]>;
  readonly requestTime: CanonicalInstant;
}

function policyCompilationState(
  registry: QuerySchemaRegistry,
  context: QueryPolicyContext,
  requestTime: CanonicalInstant,
): PolicyCompilationState {
  const attributes = new Map<string, QueryPolicyActorAttribute["value"]>();
  for (const attribute of context.trustedActorAttributes) {
    if (attributes.has(attribute.name)) {
      failQuery("POLICY_EVALUATION_UNAVAILABLE", "Actor Attribute is duplicated.");
    }
    attributes.set(attribute.name, attribute.value);
  }
  return Object.freeze({ registry, attributes, requestTime });
}

function compilePropertyAccess(
  rules: readonly PolicyRule[],
  object: QueryObjectTypeSchema,
  property: QueryPropertySchema,
  state: PolicyCompilationState,
): QueryPropertyAccessPlan {
  const matches = rules.filter((rule) => samePropertyTarget(rule.target, object, property));
  const allowRules = matches.filter((rule) => rule.effect === "allow");
  const denyRules = matches.filter((rule) => rule.effect === "deny");
  const masks = matches
    .filter((rule) => rule.effect === "mask")
    .map((rule) => {
      if (rule.mask === undefined) {
        failQuery("POLICY_EVALUATION_UNAVAILABLE", "Mask Policy is missing its display value.");
      }
      return Object.freeze({
        predicate: compilePolicyPredicate(rule.predicate, object, "root", state),
        displayValue: rule.mask.displayValue,
      });
    });
  return Object.freeze({
    property,
    allow: anyOf(
      allowRules.map((rule) => compilePolicyPredicate(rule.predicate, object, "root", state)),
    ),
    deny: anyOf(
      denyRules.map((rule) => compilePolicyPredicate(rule.predicate, object, "root", state)),
    ),
    masks: Object.freeze(masks),
    canEverAllow: allowRules.length > 0,
  });
}

function compilePolicyPredicate(
  predicate: PolicyPredicate,
  object: QueryObjectTypeSchema | null,
  scope: "root" | "link_target",
  state: PolicyCompilationState,
): QueryPredicatePlan {
  if (predicate.kind === "constant") {
    return Object.freeze({ kind: "constant", value: predicate.value });
  }
  if (predicate.kind === "compare") {
    return compilePolicyComparison(predicate, object, scope, state);
  }
  if (predicate.kind === "is_null") {
    return Object.freeze({
      kind: "is_null",
      operand: compileOperand(predicate.operand, object, scope, state, undefined, false),
    });
  }
  if (predicate.kind === "all" || predicate.kind === "any") {
    return Object.freeze({
      kind: predicate.kind,
      predicates: Object.freeze(
        predicate.predicates.map((item) => compilePolicyPredicate(item, object, scope, state)),
      ),
    });
  }
  if (predicate.kind === "not") {
    return Object.freeze({
      kind: "not",
      predicate: compilePolicyPredicate(predicate.predicate, object, scope, state),
    });
  }
  if (predicate.kind !== "link_exists") {
    failQuery("POLICY_EVALUATION_UNAVAILABLE", "Policy predicate kind is unavailable.");
  }
  if (object === null) {
    failQuery("POLICY_EVALUATION_UNAVAILABLE", "Link Policy cannot traverse from this target.");
  }
  const link = state.registry.requireLinkByApiName(predicate.linkTypeApiName);
  const target = state.registry.requireObjectByApiName(predicate.targetObjectTypeApiName);
  if (
    predicate.linkTypeResourceId !== link.resourceId ||
    predicate.linkTypeRevisionId !== link.revisionId ||
    predicate.targetObjectTypeResourceId !== target.resourceId ||
    predicate.targetObjectTypeRevisionId !== target.revisionId ||
    link.sourceObjectTypeRevisionId !== object.revisionId ||
    link.targetObjectTypeRevisionId !== target.revisionId
  ) {
    failQuery("POLICY_EVALUATION_UNAVAILABLE", "Policy Link binding differs from the Registry.");
  }
  return Object.freeze({
    kind: "link_exists",
    source: object,
    link,
    target,
    predicate: compilePolicyPredicate(predicate.predicate, target, "link_target", state),
  });
}

function compilePolicyComparison(
  predicate: Extract<PolicyPredicate, { readonly kind: "compare" }>,
  object: QueryObjectTypeSchema | null,
  scope: "root" | "link_target",
  state: PolicyCompilationState,
): QueryPredicatePlan {
  const leftHint = operandProperty(predicate.left, object);
  const rightHint = operandProperty(predicate.right, object);
  if (leftHint !== null && rightHint !== null && !samePropertyType(leftHint, rightHint)) {
    failQuery("POLICY_EVALUATION_UNAVAILABLE", "Policy compares incompatible Property types.");
  }
  const hint = leftHint ?? rightHint ?? undefined;
  const left = compileOperand(predicate.left, object, scope, state, hint, false);
  const right = compileOperand(
    predicate.right,
    object,
    scope,
    state,
    hint,
    predicate.op === "in" || predicate.op === "containsAny",
  );
  assertPolicyOperator(predicate.op, left, right);
  return Object.freeze({ kind: "compare", op: predicate.op, left, right });
}

function compileOperand(
  operand: PolicyOperand,
  object: QueryObjectTypeSchema | null,
  scope: "root" | "link_target",
  state: PolicyCompilationState,
  hint: QueryPropertySchema | undefined,
  collection: boolean,
): QueryTypedOperand {
  if (operand.source === "object_property") {
    if (object === null) {
      failQuery("POLICY_EVALUATION_UNAVAILABLE", "Policy Property has no Object context.");
    }
    const property = requireQueryProperty(object, operand.apiName);
    if (!property.filterable || property.valueType === "json") {
      failQuery("POLICY_EVALUATION_UNAVAILABLE", "Policy Property is not filterable.");
    }
    return Object.freeze({ kind: "property", scope, property });
  }
  if (operand.source === "request_time") {
    return canonicalizeRequestTimeParameter(state.requestTime);
  }
  if (operand.source === "actor_attribute") {
    const value = state.attributes.get(operand.apiName);
    if (value === undefined) {
      return Object.freeze({
        kind: "missing",
        valueType: hint === undefined ? "string" : queryOperandValueType(hint),
      });
    }
    return canonicalizeActorParameter(value);
  }
  if (hint !== undefined) {
    if (collection) {
      if (!Array.isArray(operand.value)) {
        failQuery("POLICY_EVALUATION_UNAVAILABLE", "Policy collection operand is invalid.");
      }
      if (hint.valueType === "string[]") return canonicalizeActorParameter(operand.value);
      return canonicalizeTrustedPolicyCollectionParameter(hint, operand.value);
    }
    return canonicalizeTrustedPolicyParameter(hint, operand.value);
  }
  return canonicalizeUnhintedConstant(operand.value, collection);
}

function canonicalizeUnhintedConstant(
  input: boolean | string | number | readonly (boolean | string | number)[],
  collection: boolean,
): QueryParameterOperand {
  if (typeof input === "number") {
    failQuery(
      "POLICY_EVALUATION_UNAVAILABLE",
      "Unbound numeric Policy constants have no public Value Codec type.",
    );
  }
  if (collection !== Array.isArray(input)) {
    failQuery("POLICY_EVALUATION_UNAVAILABLE", "Policy operand shape is inconsistent.");
  }
  return canonicalizeActorParameter(input);
}

function operandProperty(
  operand: PolicyOperand,
  object: QueryObjectTypeSchema | null,
): QueryPropertySchema | null {
  if (operand.source !== "object_property") return null;
  if (object === null) {
    failQuery("POLICY_EVALUATION_UNAVAILABLE", "Policy Property has no Object context.");
  }
  return requireQueryProperty(object, operand.apiName);
}

function assertPolicyOperator(
  operator: string,
  left: QueryTypedOperand,
  right: QueryTypedOperand,
): void {
  const leftType = typedOperandValueType(left);
  const rightType = typedOperandValueType(right);
  if (operator === "in") {
    if (right.kind !== "parameter" || !right.collection || leftType !== rightType) {
      failQuery("POLICY_EVALUATION_UNAVAILABLE", "Policy IN operands are incompatible.");
    }
    return;
  }
  if (operator === "containsAny") {
    if (leftType !== "string_array" || rightType !== "string_array") {
      failQuery("POLICY_EVALUATION_UNAVAILABLE", "Policy containsAny operands are incompatible.");
    }
    return;
  }
  if (leftType !== rightType) {
    failQuery("POLICY_EVALUATION_UNAVAILABLE", "Policy operand types are incompatible.");
  }
  if ((operator === "contains" || operator === "prefix") && leftType !== "string") {
    failQuery("POLICY_EVALUATION_UNAVAILABLE", "Policy text operator requires strings.");
  }
  if (
    (operator === "lt" || operator === "lte" || operator === "gt" || operator === "gte") &&
    (leftType === "boolean" || leftType === "string_array" || leftType === "json")
  ) {
    failQuery("POLICY_EVALUATION_UNAVAILABLE", "Policy ordering operator is unsupported.");
  }
}

function typedOperandValueType(operand: QueryTypedOperand) {
  return operand.kind === "property" ? queryOperandValueType(operand.property) : operand.valueType;
}

function assertPolicyBinding(
  registry: QuerySchemaRegistry,
  context: QueryPolicyContext,
  resource: QueryObjectTypeSchema | QueryLinkTypeSchema,
): void {
  if (
    context.projectId !== registry.projectId ||
    context.releaseId !== registry.releaseId ||
    context.resourceId !== resource.resourceId ||
    context.resourceRevisionId !== resource.revisionId ||
    !/^[1-9][0-9]{0,18}$/u.test(context.authorizationEpoch)
  ) {
    failQuery("QUERY_BINDING_INVALID", "Policy context does not match the Query Registry.");
  }
}

function sameObjectTarget(target: PolicyTarget, object: QueryObjectTypeSchema): boolean {
  return (
    target.kind === "object" &&
    target.resourceId === object.resourceId &&
    target.resourceRevisionId === object.revisionId
  );
}

function samePropertyTarget(
  target: PolicyTarget,
  object: QueryObjectTypeSchema,
  property: QueryPropertySchema,
): boolean {
  return (
    target.kind === "property" &&
    target.resourceId === object.resourceId &&
    target.resourceRevisionId === object.revisionId &&
    target.propertyApiName === property.apiName
  );
}

function sameLinkTarget(target: PolicyTarget, link: QueryLinkTypeSchema): boolean {
  return (
    target.kind === "link" &&
    target.resourceId === link.resourceId &&
    target.resourceRevisionId === link.revisionId
  );
}

function samePropertyType(left: QueryPropertySchema, right: QueryPropertySchema): boolean {
  return (
    left.valueType === right.valueType &&
    left.decimalPrecision === right.decimalPrecision &&
    left.decimalScale === right.decimalScale &&
    JSON.stringify(left.enumValues) === JSON.stringify(right.enumValues)
  );
}

function anyOf(predicates: readonly QueryPredicatePlan[]): QueryPredicatePlan {
  if (predicates.length === 0) return Object.freeze({ kind: "constant", value: false });
  if (predicates.length === 1) return required(predicates[0]);
  return Object.freeze({ kind: "any", predicates: Object.freeze([...predicates]) });
}

function allOf(predicates: readonly QueryPredicatePlan[]): QueryPredicatePlan {
  if (predicates.length === 0) return Object.freeze({ kind: "constant", value: true });
  if (predicates.length === 1) return required(predicates[0]);
  return Object.freeze({ kind: "all", predicates: Object.freeze([...predicates]) });
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("Expected a Policy predicate.");
  return value;
}
