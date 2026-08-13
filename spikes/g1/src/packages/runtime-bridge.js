import { invariant } from "../core/kernel-error.js";
import { createSchemaRegistry } from "../core/schema-registry.js";
import { stableHash } from "../core/stable-json.js";
import { compileSearch } from "../query/compiler.js";
import { compileTraversal } from "../query/traversal-compiler.js";
import { validateManifest } from "./manifest.js";

export function buildRegistryFromManifest(manifest) {
  validateManifest(manifest);
  const objectTypes = Object.fromEntries(manifest.resources.objectTypes.map((objectType) => [
    objectType.apiName,
    {
      apiName: objectType.apiName,
      primaryKey: objectType.primaryKey,
      properties: Object.fromEntries(Object.entries(objectType.properties).map(([propertyName, property]) => [
        propertyName,
        propertyName === objectType.primaryKey
          ? {
              ...property,
              storage: "column",
              column: "primary_key",
              filterable: true,
              sortable: true,
              searchable: false,
            }
          : {
              ...property,
              storage: "json",
              jsonKey: propertyName,
              filterable: property.type !== "json",
              sortable: !["string[]", "json"].includes(property.type),
              searchable: property.type === "string",
            },
      ])),
    },
  ]));
  const linkTypes = Object.fromEntries(manifest.resources.linkTypes.map((link) => [
    link.apiName,
    { sourceType: link.sourceType, targetType: link.targetType },
  ]));
  return createSchemaRegistry({
    releaseRevision: `${manifest.packageApiName}@${manifest.version}`,
    objectTypes,
    linkTypes,
  });
}

export function compilePackageRuntimeProbe(manifest) {
  const registry = buildRegistryFromManifest(manifest);
  const allowAll = makeAllowAllPolicy(manifest);
  const allowAllLinks = makeAllowAllLinkPolicy(manifest);
  const viewCompilations = manifest.resources.views.map((view) => ({
    viewApiName: view.apiName,
    compiled: compileSearch({
      registry,
      objectType: view.objectType,
      policy: allowAll,
      query: { select: view.fields, page: { size: 25 } },
    }),
  }));
  const linkCompilations = manifest.resources.linkTypes.map((link) => {
    const target = registry.objectTypes[link.targetType];
    return {
      linkApiName: link.apiName,
      compiled: compileTraversal({
        registry,
        startObjectType: link.sourceType,
        startPrimaryKey: "runtime-probe-key",
        path: [{ linkType: link.apiName, direction: "out" }],
        select: [target.primaryKey],
        policyByObjectType: { "*": allowAll },
        linkPolicyByLinkType: { "*": allowAllLinks },
      }),
    };
  });
  const policyCompilations = manifest.resources.policies.map((definition) => {
    const objectType = registry.objectTypes[definition.objectType];
    const policy = makePolicyFromDefinition(manifest, definition);
    return {
      policyApiName: definition.apiName,
      compiled: compileSearch({
        registry,
        objectType: definition.objectType,
        policy,
        query: { select: [objectType.primaryKey], page: { size: 1 } },
      }),
    };
  });
  const actionPlans = manifest.resources.actions.map((action) => planManifestAction({
    manifest,
    actionApiName: action.apiName,
    targetPrimaryKey: "runtime-probe-key",
    expectedObjectVersion: 1,
    input: {},
  }));

  return Object.freeze({
    releaseRevision: registry.releaseRevision,
    viewCompilations,
    linkCompilations,
    policyCompilations,
    actionPlans,
  });
}

export function planManifestAction({
  manifest,
  actionApiName,
  targetPrimaryKey,
  expectedObjectVersion,
  input,
}) {
  validateManifest(manifest);
  const action = manifest.resources.actions.find((item) => item.apiName === actionApiName);
  invariant(action, "ACTION_NOT_FOUND", `Unknown action ${String(actionApiName)}`);
  invariant(typeof targetPrimaryKey === "string" && targetPrimaryKey.length > 0, "INVALID_ACTION_PLAN", "targetPrimaryKey is required");
  invariant(Number.isSafeInteger(expectedObjectVersion) && expectedObjectVersion > 0, "INVALID_ACTION_PLAN", "expectedObjectVersion must be positive");
  return Object.freeze({
    packageApiName: manifest.packageApiName,
    packageVersion: manifest.version,
    actionApiName: action.apiName,
    targetObjectType: action.targetType,
    targetPrimaryKey,
    expectedObjectVersion,
    risk: action.risk,
    handlerDigest: action.handlerDigest,
    inputHash: stableHash(input),
  });
}

function makeAllowAllPolicy(manifest) {
  const policy = {
    id: `${manifest.packageApiName}:runtime-probe-allow`,
    allowObjectType: true,
    rowPredicate: null,
    defaultPropertyDecision: "allow",
    propertyDecisions: {},
  };
  return Object.freeze({ ...policy, contextHash: stableHash(policy) });
}

function makeAllowAllLinkPolicy(manifest) {
  const policy = {
    id: `${manifest.packageApiName}:runtime-probe-link-allow`,
    allowLinkType: true,
  };
  return Object.freeze({ ...policy, contextHash: stableHash(policy) });
}

function makePolicyFromDefinition(manifest, definition) {
  const policy = {
    id: `${manifest.packageApiName}:${definition.apiName}`,
    allowObjectType: true,
    rowPredicate: definition.predicate,
    defaultPropertyDecision: "allow",
    propertyDecisions: {},
  };
  return Object.freeze({ ...policy, contextHash: stableHash(policy) });
}
