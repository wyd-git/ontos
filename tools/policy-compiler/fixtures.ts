import { createHash } from "node:crypto";

import {
  parseArtifactDigest,
  parsePolicyResourceDefinition,
  type PolicyResourceDefinition,
} from "@ontos/contracts";
import type { PolicyCompilerTargetSnapshot } from "@ontos/policy-domain";

export const policyIds = Object.freeze({
  project: "018f47a2-755b-7cc3-98c8-4d2fb871c300",
  release: "018f47a2-755b-7cc3-98c8-4d2fb871c301",
  policyResource: "018f47a2-755b-7cc3-98c8-4d2fb871c302",
  policyRevision: "018f47a2-755b-7cc3-98c8-4d2fb871c303",
  workItemResource: "018f47a2-755b-7cc3-98c8-4d2fb871c304",
  workItemRevision: "018f47a2-755b-7cc3-98c8-4d2fb871c305",
  personResource: "018f47a2-755b-7cc3-98c8-4d2fb871c306",
  personRevision: "018f47a2-755b-7cc3-98c8-4d2fb871c307",
  linkResource: "018f47a2-755b-7cc3-98c8-4d2fb871c308",
  linkRevision: "018f47a2-755b-7cc3-98c8-4d2fb871c309",
});

export function sha256(value: string) {
  return parseArtifactDigest(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
}

export function policyDefinition(): PolicyResourceDefinition {
  const objectTarget = {
    kind: "object" as const,
    resourceId: policyIds.workItemResource,
    resourceRevisionId: policyIds.workItemRevision,
  };
  return parsePolicyResourceDefinition({
    schemaVersion: 1,
    rules: [
      {
        ruleId: "ALLOW_OBJECT",
        target: objectTarget,
        effect: "allow",
        predicate: {
          kind: "all",
          predicates: [
            {
              kind: "compare",
              left: { source: "object_property", apiName: "region" },
              op: "eq",
              right: { source: "actor_attribute", apiName: "region" },
            },
            {
              kind: "link_exists",
              linkTypeApiName: "Assignments",
              linkTypeResourceId: policyIds.linkResource,
              linkTypeRevisionId: policyIds.linkRevision,
              targetObjectTypeApiName: "Person",
              targetObjectTypeResourceId: policyIds.personResource,
              targetObjectTypeRevisionId: policyIds.personRevision,
              predicate: {
                kind: "compare",
                left: { source: "object_property", apiName: "active" },
                op: "eq",
                right: { source: "constant", value: true },
              },
            },
          ],
        },
      },
      {
        ruleId: "DENY_OBJECT",
        target: objectTarget,
        effect: "deny",
        predicate: {
          kind: "compare",
          left: { source: "object_property", apiName: "status" },
          op: "eq",
          right: { source: "constant", value: "BLOCKED" },
        },
      },
      {
        ruleId: "DENY_PROPERTY",
        target: { ...objectTarget, kind: "property", propertyApiName: "salary" },
        effect: "deny",
        predicate: { kind: "constant", value: true },
      },
      {
        ruleId: "MASK_PROPERTY",
        target: { ...objectTarget, kind: "property", propertyApiName: "email" },
        effect: "mask",
        predicate: { kind: "constant", value: true },
        mask: { kind: "redact", displayValue: "Restricted" },
      },
    ],
    testVectors: [
      vector("ALLOW_OBJECT", objectTarget, "allow", [
        fact("object_property", "active", "value", true),
        fact("actor_attribute", "region", "value", "EU"),
        fact("link", "Assignments", "value", true),
        fact("object_property", "region", "value", "EU"),
        fact("object_property", "status", "value", "OPEN"),
      ]),
      vector(
        "DENY_LINK",
        {
          kind: "link",
          resourceId: policyIds.linkResource,
          resourceRevisionId: policyIds.linkRevision,
        },
        "deny",
        [fact("link", "Assignments", "missing")],
      ),
      vector("DENY_MISSING", objectTarget, "deny", [fact("object_property", "region", "missing")]),
      vector("DENY_NULL", objectTarget, "deny", [fact("object_property", "region", "null")]),
      {
        ...vector(
          "DENY_PROPERTY",
          { ...objectTarget, kind: "property", propertyApiName: "salary" },
          "deny",
          [],
        ),
        expectedPropertyDisposition: "deny",
      },
      {
        ...vector(
          "MASK_PROPERTY",
          { ...objectTarget, kind: "property", propertyApiName: "email" },
          "allow",
          [],
        ),
        expectedPropertyDisposition: "mask",
      },
    ],
  });
}

export function compilerTargets(): readonly PolicyCompilerTargetSnapshot[] {
  const targets = [
    target(
      policyIds.workItemResource,
      policyIds.workItemRevision,
      "object_type",
      "WorkItem",
      objectType("WorkItem", [
        property("id", "string", true),
        property("region", "string", true),
        property("status", "string", true),
        property("email", "string", false),
        property("salary", "integer", false),
      ]),
    ),
    target(
      policyIds.personResource,
      policyIds.personRevision,
      "object_type",
      "Person",
      objectType("Person", [property("id", "string", true), property("active", "boolean", true)]),
    ),
    target(policyIds.linkResource, policyIds.linkRevision, "link_type", "Assignments", {
      schemaVersion: 1,
      apiName: "Assignments",
      displayName: "Assignments",
      description: "Work item assignment.",
      source: {
        objectTypeRevisionId: policyIds.workItemRevision,
        apiName: "WorkItem",
        displayName: "Work item",
      },
      target: {
        objectTypeRevisionId: policyIds.personRevision,
        apiName: "Person",
        displayName: "Person",
      },
      cardinality: "many_to_many",
      sourceKind: "base",
      deletionBehavior: "detach",
      actionCreateAllowed: false,
      actionDeleteAllowed: false,
    }),
  ];
  return Object.freeze(targets);
}

export function compileInput() {
  const targets = compilerTargets();
  return {
    projectId: policyIds.project,
    releaseId: policyIds.release,
    policyRevisionId: policyIds.policyRevision,
    definition: policyDefinition(),
    releaseRevisionIds: targets.map(({ revisionId }) => revisionId),
    targets,
    trustedActorAttributes: [{ apiName: "region", valueType: "string" as const }],
    digest: sha256,
  };
}

function target(
  resourceId: string,
  revisionId: string,
  family: "object_type" | "link_type",
  apiName: string,
  content: unknown,
): PolicyCompilerTargetSnapshot {
  return Object.freeze({
    projectId: policyIds.project,
    resourceId,
    revisionId,
    family,
    apiName,
    contentDigest: sha256(JSON.stringify(content)),
    content,
  });
}

function objectType(apiName: string, properties: readonly ReturnType<typeof property>[]) {
  return {
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `${apiName} definition.`,
    primaryKeyPropertyApiName: "id",
    titlePropertyApiName: "id",
    defaultSearchPropertyApiNames: [],
    defaultSort: [{ propertyApiName: "id", direction: "asc" }],
    defaultClassification: "internal",
    properties,
  };
}

function property(
  apiName: string,
  valueType: "string" | "integer" | "boolean",
  filterable: boolean,
) {
  return {
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `${apiName} value.`,
    valueType,
    ...(valueType === "string" ? { caseSensitive: true } : {}),
    nullable: apiName !== "id",
    writeMode: "source_only",
    unique: apiName === "id",
    filterable,
    sortable: apiName === "id",
    searchable: false,
    classification: "internal",
  };
}

function vector(
  vectorId: string,
  target: object,
  expectedDecision: "allow" | "deny",
  facts: readonly object[],
) {
  return {
    vectorId,
    identity: identity(vectorId),
    requestTime: "2026-08-19T08:00:00.000000Z",
    target,
    facts,
    expectedDecision,
  };
}

function fact(
  source: "object_property" | "actor_attribute" | "link",
  apiName: string,
  state: "value" | "null" | "missing",
  value?: string | number | boolean,
) {
  return { source, apiName, state, ...(state === "value" ? { value } : {}) };
}

function identity(seed: string) {
  const suffix = createHash("sha256").update(seed).digest("hex").slice(0, 12);
  return {
    schemaVersion: 1,
    actor: {
      principalId: `018f47a2-755b-7cc3-98c8-${suffix}`,
      identityType: "human",
    },
    delegationChain: [],
    claimsFingerprint: sha256(seed),
    authenticatedAt: "2026-08-19T08:00:00.000000Z",
    authorizationMode: "intersection",
  };
}
