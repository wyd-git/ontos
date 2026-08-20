import type {
  ArtifactDigest,
  CanonicalInstant,
  QueryComparisonOperator,
  QuerySortDirection,
} from "@ontos/contracts";

import type {
  QueryLinkTypeSchema,
  QueryObjectTypeSchema,
  QueryPropertySchema,
} from "./schema-registry.ts";

export const QUERY_COMPILER_VERSION = "query-compiler-g2-03-07-v1" as const;
export const QUERY_COMPLEXITY_MAXIMUM_UNITS = 10_000;
export const QUERY_SQL_MAXIMUM_PARAMETERS = 10_000;
export const QUERY_SQL_MAXIMUM_BYTES = 1024 * 1024;
export const QUERY_RESULT_DEFAULT_MAXIMUM_BYTES = 8 * 1024 * 1024;
export const QUERY_STATEMENT_DEFAULT_TIMEOUT_MS = 15_000;
export const QUERY_STATEMENT_MAXIMUM_TIMEOUT_MS = 30_000;

export type QueryOperation = "object_get" | "object_search" | "object_count" | "link_candidate";
export type QueryOperandValueType =
  | "boolean"
  | "integer"
  | "decimal"
  | "date"
  | "timestamp"
  | "enum"
  | "string"
  | "string_array"
  | "json";
export type QueryCanonicalScalar = boolean | string;
export type QueryCanonicalParameter = QueryCanonicalScalar | readonly QueryCanonicalScalar[];

export interface QueryPropertyOperand {
  readonly kind: "property";
  readonly scope: "root" | "link_target";
  readonly property: QueryPropertySchema;
}

export interface QueryParameterOperand {
  readonly kind: "parameter";
  readonly valueType: QueryOperandValueType;
  readonly collection: boolean;
  readonly value: QueryCanonicalParameter;
}

export interface QueryMissingOperand {
  readonly kind: "missing";
  readonly valueType: QueryOperandValueType;
}

export type QueryTypedOperand = QueryPropertyOperand | QueryParameterOperand | QueryMissingOperand;

export interface QueryConstantPredicatePlan {
  readonly kind: "constant";
  readonly value: boolean;
}

export interface QueryComparisonPredicatePlan {
  readonly kind: "compare";
  readonly op: QueryComparisonOperator;
  readonly left: QueryTypedOperand;
  readonly right: QueryTypedOperand;
}

export interface QueryNullPredicatePlan {
  readonly kind: "is_null";
  readonly operand: QueryTypedOperand;
}

export interface QueryLogicalPredicatePlan {
  readonly kind: "all" | "any";
  readonly predicates: readonly QueryPredicatePlan[];
}

export interface QueryNotPredicatePlan {
  readonly kind: "not";
  readonly predicate: QueryPredicatePlan;
}

export interface QueryLinkExistsPredicatePlan {
  readonly kind: "link_exists";
  readonly source: QueryObjectTypeSchema;
  readonly link: QueryLinkTypeSchema;
  readonly target: QueryObjectTypeSchema;
  readonly predicate: QueryPredicatePlan;
}

export type QueryPredicatePlan =
  | QueryConstantPredicatePlan
  | QueryComparisonPredicatePlan
  | QueryNullPredicatePlan
  | QueryLogicalPredicatePlan
  | QueryNotPredicatePlan
  | QueryLinkExistsPredicatePlan;

export interface QueryPropertyMaskPlan {
  readonly predicate: QueryPredicatePlan;
  readonly displayValue: string;
}

export interface QueryPropertyAccessPlan {
  readonly property: QueryPropertySchema;
  readonly allow: QueryPredicatePlan;
  readonly deny: QueryPredicatePlan;
  readonly masks: readonly QueryPropertyMaskPlan[];
  readonly canEverAllow: boolean;
}

export interface QueryPolicyPlan {
  readonly policyContextHash: ArtifactDigest;
  readonly authorizationEpoch: string;
  readonly rowAllow: QueryPredicatePlan;
  readonly rowDeny: QueryPredicatePlan;
  readonly propertyAccess: readonly QueryPropertyAccessPlan[];
}

export interface QueryComplexityReport {
  readonly units: number;
  readonly clientPredicateNodes: number;
  readonly policyPredicateNodes: number;
  readonly collectionItems: number;
  readonly linkExistsPredicates: number;
  readonly selectedProperties: number;
  readonly searchableProperties: number;
}

export type QuerySortPlan =
  | {
      readonly kind: "property";
      readonly property: QueryPropertySchema;
      readonly direction: QuerySortDirection;
      readonly enumDeclarationOrder: readonly string[] | null;
    }
  | {
      readonly kind: "relevance";
      readonly direction: "desc";
      readonly properties: readonly QueryPropertySchema[];
    }
  | {
      readonly kind: "canonical_primary_key";
      readonly direction: QuerySortDirection;
    };

export interface QuerySearchPlan {
  readonly text: string;
  readonly properties: readonly QueryPropertySchema[];
}

export interface QueryPlanBinding {
  readonly projectId: string;
  readonly releaseId: string;
  readonly releaseRevisionId: string;
  readonly activationId: string;
}

interface QueryLogicalPlanBase {
  readonly compilerVersion: typeof QUERY_COMPILER_VERSION;
  readonly operation: QueryOperation;
  readonly binding: QueryPlanBinding;
  readonly queryHash: ArtifactDigest;
  readonly requestTime: CanonicalInstant;
  readonly complexity: QueryComplexityReport;
  readonly statementTimeoutMs: number;
  readonly maximumResultRows: number;
  readonly maximumResultBytes: number;
}

export interface ObjectGetLogicalPlan extends QueryLogicalPlanBase {
  readonly operation: "object_get";
  readonly object: QueryObjectTypeSchema;
  readonly canonicalPrimaryKey: string;
  readonly selectedProperties: readonly QueryPropertySchema[];
  readonly policy: QueryPolicyPlan;
}

export interface ObjectSearchLogicalPlan extends QueryLogicalPlanBase {
  readonly operation: "object_search";
  readonly object: QueryObjectTypeSchema;
  readonly selectedProperties: readonly QueryPropertySchema[];
  readonly policy: QueryPolicyPlan;
  readonly clientPredicate: QueryPredicatePlan | null;
  readonly search: QuerySearchPlan | null;
  readonly sort: QuerySortPlan;
  readonly pageSize: number;
}

export interface ObjectCountLogicalPlan extends QueryLogicalPlanBase {
  readonly operation: "object_count";
  readonly object: QueryObjectTypeSchema;
  readonly policy: QueryPolicyPlan;
  readonly clientPredicate: QueryPredicatePlan | null;
  readonly search: QuerySearchPlan | null;
}

export interface LinkCandidateLogicalPlan extends QueryLogicalPlanBase {
  readonly operation: "link_candidate";
  readonly sourceObject: QueryObjectTypeSchema;
  readonly link: QueryLinkTypeSchema;
  readonly targetObject: QueryObjectTypeSchema;
  readonly direction: "outgoing" | "incoming";
  readonly sourceCanonicalPrimaryKey: string;
  readonly selectedProperties: readonly QueryPropertySchema[];
  readonly sourcePolicy: QueryPolicyPlan;
  readonly linkPolicy: QueryPolicyPlan;
  readonly targetPolicy: QueryPolicyPlan;
  readonly clientPredicate: QueryPredicatePlan | null;
  readonly search: QuerySearchPlan | null;
  readonly sort: QuerySortPlan;
  readonly pageSize: number;
}

export type QueryLogicalPlan =
  | ObjectGetLogicalPlan
  | ObjectSearchLogicalPlan
  | ObjectCountLogicalPlan
  | LinkCandidateLogicalPlan;

const authenticPlans = new WeakSet<object>();

export function registerQueryLogicalPlan<T extends QueryLogicalPlan>(plan: T): T {
  authenticPlans.add(plan);
  return plan;
}

export function assertAuthenticQueryLogicalPlan(value: unknown): asserts value is QueryLogicalPlan {
  if (typeof value !== "object" || value === null || !authenticPlans.has(value)) {
    throw new TypeError("QUERY_LOGICAL_PLAN_UNTRUSTED");
  }
}
