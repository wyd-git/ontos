import { createHash } from "node:crypto";

import {
  parseArtifactDigest,
  parseOntosId,
  type ArtifactDigest,
  type PolicyRule,
} from "@ontos/contracts";
import {
  QuerySchemaRegistry,
  type QueryPolicyActorAttribute,
  type QueryPolicyContext,
} from "@ontos/query-domain";

import {
  customerObjectType,
  ids as mappingIds,
  orderCustomerLinkType,
  orderObjectType,
} from "../materialization-mapping/fixtures.ts";

export const queryIds = Object.freeze({
  project: "01000000-0000-4000-8000-000000000001",
  release: "01000000-0000-4000-8000-000000000002",
  releaseRevision: "01000000-0000-4000-8000-000000000003",
  activation: "01000000-0000-4000-8000-000000000004",
  customerGeneration: "01000000-0000-4000-8000-000000000005",
  orderGeneration: "01000000-0000-4000-8000-000000000006",
  linkGeneration: "01000000-0000-4000-8000-000000000007",
  policyResource: "01000000-0000-4000-8000-000000000008",
  policyRevision: "01000000-0000-4000-8000-000000000009",
  policyCompilation: "01000000-0000-4000-8000-00000000000a",
});

export function queryRegistry(): QuerySchemaRegistry {
  return new QuerySchemaRegistry({
    projectId: queryIds.project,
    releaseId: queryIds.release,
    releaseRevisionId: queryIds.releaseRevision,
    activationId: queryIds.activation,
    objects: [
      {
        memberKey: "object:Customer",
        resourceId: mappingIds.objectResource,
        revisionId: mappingIds.objectRevision,
        generationId: queryIds.customerGeneration,
        definition: customerObjectType,
      },
      {
        memberKey: "object:Order",
        resourceId: mappingIds.orderResource,
        revisionId: mappingIds.orderRevision,
        generationId: queryIds.orderGeneration,
        definition: orderObjectType,
      },
    ],
    links: [
      {
        memberKey: "link:CustomerOrder",
        resourceId: mappingIds.linkResource,
        revisionId: mappingIds.linkRevision,
        generationId: queryIds.linkGeneration,
        definition: orderCustomerLinkType,
      },
    ],
  });
}

export function objectPolicy(
  object: "Customer" | "Order",
  options: {
    readonly attributes?: readonly QueryPolicyActorAttribute[];
    readonly secretAccess?: "allow" | "mask" | "deny";
    readonly extraRules?: readonly PolicyRule[];
  } = {},
): QueryPolicyContext {
  const registry = queryRegistry();
  const schema = registry.requireObjectByApiName(object);
  const rules: PolicyRule[] = [rowRule(schema.resourceId, schema.revisionId, "allow")];
  for (const property of schema.properties) {
    if (property.apiName === "secret" && options.secretAccess !== undefined) {
      if (options.secretAccess === "mask") {
        rules.push(
          Object.freeze({
            ruleId: "MASK_SECRET",
            target: propertyTarget(schema.resourceId, schema.revisionId, property.apiName),
            effect: "mask",
            predicate: Object.freeze({ kind: "constant", value: true }),
            mask: Object.freeze({ kind: "redact", displayValue: "[REDACTED]" }),
          }),
        );
      } else {
        rules.push(
          propertyRule(
            schema.resourceId,
            schema.revisionId,
            property.apiName,
            options.secretAccess,
          ),
        );
      }
      continue;
    }
    rules.push(propertyRule(schema.resourceId, schema.revisionId, property.apiName, "allow"));
  }
  rules.push(...(options.extraRules ?? []));
  return context(schema.resourceId, schema.revisionId, rules, options.attributes ?? []);
}

export function linkPolicy(): QueryPolicyContext {
  return context(mappingIds.linkResource, mappingIds.linkRevision, [
    Object.freeze({
      ruleId: "ALLOW_LINK",
      target: Object.freeze({
        kind: "link",
        resourceId: parseOntosId(mappingIds.linkResource),
        resourceRevisionId: parseOntosId(mappingIds.linkRevision),
      }),
      effect: "allow",
      predicate: Object.freeze({ kind: "constant", value: true }),
    }),
  ]);
}

export function searchRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    select: ["id", "displayName", "status"],
    where: { property: "status", op: "in", value: ["INACTIVE", "ACTIVE"] },
    orderBy: [{ property: "status", direction: "asc" }],
    page: { size: 20, cursor: null },
    ...overrides,
  };
}

export function sha256(canonicalText: string): ArtifactDigest {
  return parseArtifactDigest(
    `sha256:${createHash("sha256").update(canonicalText, "utf8").digest("hex")}`,
  );
}

function context(
  resourceId: string,
  resourceRevisionId: string,
  policyRules: readonly PolicyRule[],
  trustedActorAttributes: readonly QueryPolicyActorAttribute[] = [],
): QueryPolicyContext {
  return Object.freeze({
    projectId: queryIds.project,
    resourceId,
    resourceRevisionId,
    releaseId: queryIds.release,
    artifactDigest: sha256("query-policy-artifact"),
    authorizationEpoch: "7",
    policyContextHash: sha256(`query-policy-context:${resourceId}`),
    policyRules: Object.freeze([...policyRules]),
    trustedActorAttributes: Object.freeze([...trustedActorAttributes]),
  });
}

function rowRule(
  resourceId: string,
  resourceRevisionId: string,
  effect: "allow" | "deny",
): PolicyRule {
  return Object.freeze({
    ruleId: `${effect.toUpperCase()}_ROW`,
    target: Object.freeze({
      kind: "object",
      resourceId: parseOntosId(resourceId),
      resourceRevisionId: parseOntosId(resourceRevisionId),
    }),
    effect,
    predicate: Object.freeze({ kind: "constant", value: true }),
  });
}

function propertyRule(
  resourceId: string,
  resourceRevisionId: string,
  propertyApiName: string,
  effect: "allow" | "deny",
): PolicyRule {
  return Object.freeze({
    ruleId: `${effect.toUpperCase()}_${propertyApiName.toUpperCase()}`,
    target: propertyTarget(resourceId, resourceRevisionId, propertyApiName),
    effect,
    predicate: Object.freeze({ kind: "constant", value: true }),
  });
}

function propertyTarget(resourceId: string, resourceRevisionId: string, propertyApiName: string) {
  return Object.freeze({
    kind: "property" as const,
    resourceId: parseOntosId(resourceId),
    resourceRevisionId: parseOntosId(resourceRevisionId),
    propertyApiName,
  });
}
