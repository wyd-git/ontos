import { KernelError, invariant } from "../core/kernel-error.js";
import { getObjectType } from "../core/schema-registry.js";
import { stableHash } from "../core/stable-json.js";
import { compileAggregate, compileSearch } from "../query/compiler.js";
import { compileTraversal } from "../query/traversal-compiler.js";

export class PolicyGateway {
  constructor({ registry, resolvePolicy, resolveLinkPolicy, execute, audit = () => {} }) {
    invariant(registry, "INVALID_GATEWAY", "Schema registry is required");
    invariant(typeof resolvePolicy === "function", "INVALID_GATEWAY", "resolvePolicy is required");
    invariant(typeof resolveLinkPolicy === "function", "INVALID_GATEWAY", "resolveLinkPolicy is required and must fail closed");
    invariant(typeof execute === "function", "INVALID_GATEWAY", "execute is required");
    this.registry = registry;
    this.resolvePolicy = resolvePolicy;
    this.resolveLinkPolicy = resolveLinkPolicy;
    this.execute = execute;
    this.audit = audit;
  }

  async search({ actor, objectType, query, entryPoint }) {
    return this.#run({
      actor,
      objectType,
      entryPoint,
      operation: "search",
      query,
      compile: (policy) => compileSearch({
        registry: this.registry,
        objectType,
        query,
        policy,
      }),
    });
  }

  async aggregate({ actor, objectType, query, entryPoint }) {
    return this.#run({
      actor,
      objectType,
      entryPoint,
      operation: "aggregate",
      query,
      compile: (policy) => compileAggregate({
        registry: this.registry,
        objectType,
        query,
        policy,
      }),
    });
  }

  async loadActionTarget({ actor, objectType, primaryKey, entryPoint = "actionTarget" }) {
    const result = await this.search({
      actor,
      objectType,
      entryPoint,
      query: {
        where: { property: getObjectType(this.registry, objectType).primaryKey, op: "eq", value: primaryKey },
        page: { size: 1 },
      },
    });
    invariant(result.rows.length === 1, "OBJECT_NOT_ACCESSIBLE", "Object does not exist or is not accessible");
    return result.rows[0];
  }

  async traverse({ actor, startObjectType, startPrimaryKey, path, select, pageSize, entryPoint }) {
    invariant(actor && typeof actor.id === "string", "AUTHENTICATION_REQUIRED", "Authenticated actor is required");
    invariant(typeof entryPoint === "string" && entryPoint.length > 0, "INVALID_GATEWAY", "entryPoint is required");
    const startedAt = performance.now();
    const requestHash = stableHash({ startObjectType, startPrimaryKey, path, select, pageSize });
    const policyByObjectType = {};
    const linkPolicyByLinkType = {};

    try {
      let currentType = startObjectType;
      policyByObjectType[currentType] = await this.resolvePolicy({ actor, objectType: currentType, operation: "traverse" });
      invariant(policyByObjectType[currentType], "RESOURCE_FORBIDDEN", "No policy allows the traversal start");
      for (const step of path ?? []) {
        const link = this.registry.linkTypes[step.linkType];
        invariant(link, "LINK_TYPE_NOT_FOUND", `Unknown link type: ${String(step.linkType)}`);
        linkPolicyByLinkType[step.linkType] = await this.resolveLinkPolicy({ actor, linkType: step.linkType, operation: "traverse" });
        invariant(linkPolicyByLinkType[step.linkType], "RESOURCE_FORBIDDEN", "No policy allows this link type");
        currentType = step.direction === "out" ? link.targetType : link.sourceType;
        policyByObjectType[currentType] = await this.resolvePolicy({ actor, objectType: currentType, operation: "traverse" });
        invariant(policyByObjectType[currentType], "RESOURCE_FORBIDDEN", "No policy allows the traversal target");
      }

      const compiled = compileTraversal({
        registry: this.registry,
        startObjectType,
        startPrimaryKey,
        path,
        select,
        pageSize,
        policyByObjectType,
        linkPolicyByLinkType,
      });
      const databaseResult = await this.execute({ compiled, operation: "traverse", objectType: compiled.finalObjectType });
      const finalPolicy = policyByObjectType[compiled.finalObjectType];
      const rawRows = databaseResult.rows ?? [];
      const pageRows = rawRows.slice(0, compiled.pageSize);
      const rows = sanitizeRows(
        pageRows,
        getObjectType(this.registry, compiled.finalObjectType),
        finalPolicy,
        compiled.selectedProperties,
      );
      const response = {
        rows,
        rowCount: rows.length,
        hasNextPage: rawRows.length > compiled.pageSize,
        policyContextHash: stableHash({
          object: compiled.policyContextHashes,
          link: compiled.linkPolicyContextHashes,
        }),
        queryHash: requestHash,
      };
      this.audit({
        outcome: "allow",
        actorId: actor.id,
        objectType: startObjectType,
        entryPoint,
        operation: "traverse",
        policyContextHash: response.policyContextHash,
        queryHash: requestHash,
        rowCount: response.rowCount,
        durationMs: performance.now() - startedAt,
      });
      return response;
    } catch (error) {
      this.audit({
        outcome: "deny_or_error",
        actorId: actor.id,
        objectType: startObjectType,
        entryPoint,
        operation: "traverse",
        queryHash: requestHash,
        errorCode: error instanceof KernelError ? error.code : "INTERNAL_ERROR",
        durationMs: performance.now() - startedAt,
      });
      throw error;
    }
  }

  async #run({ actor, objectType, entryPoint, operation, query, compile }) {
    invariant(actor && typeof actor.id === "string", "AUTHENTICATION_REQUIRED", "Authenticated actor is required");
    invariant(typeof entryPoint === "string" && entryPoint.length > 0, "INVALID_GATEWAY", "entryPoint is required");
    const startedAt = performance.now();
    let policy;

    try {
      policy = await this.resolvePolicy({ actor, objectType, operation });
      invariant(policy, "RESOURCE_FORBIDDEN", "No policy allows this request");
      const compiled = compile(policy);
      const databaseResult = await this.execute({ compiled, operation, objectType });
      const rawRows = databaseResult.rows ?? [];
      const pageRows = operation === "search"
        ? rawRows.slice(0, compiled.pageSize)
        : rawRows;
      const rows = operation === "search"
        ? sanitizeRows(
          pageRows,
          getObjectType(this.registry, objectType),
          policy,
          compiled.selectedProperties,
        )
        : pageRows;
      const response = {
        rows,
        rowCount: operation === "search" ? rows.length : (databaseResult.rowCount ?? rows.length),
        ...(operation === "search" ? { hasNextPage: rawRows.length > compiled.pageSize } : {}),
        redactedProperties: compiled.redactedProperties ?? [],
        policyContextHash: policy.contextHash,
        queryHash: compiled.queryHash,
      };
      this.audit({
        outcome: "allow",
        actorId: actor.id,
        objectType,
        entryPoint,
        operation,
        policyContextHash: policy.contextHash,
        queryHash: compiled.queryHash ?? stableHash(query),
        rowCount: response.rowCount,
        durationMs: performance.now() - startedAt,
      });
      return response;
    } catch (error) {
      this.audit({
        outcome: "deny_or_error",
        actorId: actor.id,
        objectType,
        entryPoint,
        operation,
        policyContextHash: policy?.contextHash,
        queryHash: stableHash(query),
        errorCode: error instanceof KernelError ? error.code : "INTERNAL_ERROR",
        durationMs: performance.now() - startedAt,
      });
      throw error;
    }
  }
}

export function sanitizeRows(rows, objectType, policy, selectedProperties) {
  return rows.map((row) => {
    const sanitized = {};
    for (const propertyName of selectedProperties) {
      if (!objectType.properties[propertyName]) {
        continue;
      }
      const decision = policy.propertyDecisions?.[propertyName]
        ?? policy.defaultPropertyDecision
        ?? "deny";
      if (decision === "deny") {
        continue;
      }
      sanitized[propertyName] = decision === "mask" ? null : row[propertyName];
    }
    return sanitized;
  });
}
