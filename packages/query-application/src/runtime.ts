import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  parseCanonicalInstant,
  parseCorrelationId,
  parseOntosId,
  parseRuntimeMetadataResponse,
  parseRuntimeObjectGetResponse,
  type ArtifactDigest,
  type CanonicalInstant,
  type CorrelationId,
  type RuntimeFilterOperator,
  type RuntimeLinkMetadata,
  type RuntimeMetadataResponse,
  type RuntimeObjectGetResponse,
  type RuntimePropertyDisposition,
} from "@ontos/contracts";
import type { RuntimeIdentityContext } from "@ontos/identity-application";
import type { PolicyGatewayContext, PolicyGatewayPort } from "@ontos/policy-application";
import {
  QueryDomainError,
  QuerySchemaRegistry,
  compileObjectGet,
  compileObjectPolicyPlan,
  type ObjectGetLogicalPlan,
  type QueryLinkTypeSchema,
  type QueryObjectTypeSchema,
  type QueryPolicyPlan,
  type QueryPropertySchema,
} from "@ontos/query-domain";

export type RuntimeReleaseSelector =
  | { readonly kind: "release"; readonly releaseId: string }
  | { readonly kind: "channel"; readonly channelName: "stable" };

export interface RuntimeQueryMemberCandidate {
  readonly memberKey: string;
  readonly kind: "object" | "link";
  readonly resourceId: string;
  readonly revisionId: string;
  readonly generationId: string;
  readonly definition: unknown;
}

export interface RuntimeQueryPolicyCandidate {
  readonly policyResourceId: string;
  readonly policyRevisionId: string;
  readonly policyCompilationId: string;
  readonly artifactDigest: ArtifactDigest;
  readonly compilerVersion: string;
}

export interface RuntimeQueryContextCandidate {
  readonly projectId: string;
  readonly releaseId: string;
  readonly releaseRevisionId: string;
  readonly activationId: string;
  readonly runtimePlanDigest: ArtifactDigest;
  readonly generationSetDigest: ArtifactDigest;
  readonly observedDatabaseAt: CanonicalInstant;
  readonly policy: RuntimeQueryPolicyCandidate;
  readonly members: readonly RuntimeQueryMemberCandidate[];
}

export interface CommittedRuntimeQueryLease {
  readonly queryLeaseId: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly activationId: string;
  readonly identityContextHash: ArtifactDigest;
  readonly authorizationEpoch: string;
  readonly policyContextHash: ArtifactDigest;
  readonly queryHash: ArtifactDigest;
  readonly generationSetDigest: ArtifactDigest;
  readonly controlSequence: bigint;
  readonly expiresAt: CanonicalInstant;
}

export interface RuntimeQueryContextRepository {
  resolveCandidate(input: {
    readonly projectId: string;
    readonly selector: RuntimeReleaseSelector;
  }): Promise<RuntimeQueryContextCandidate>;
  commitLease(input: {
    readonly candidate: RuntimeQueryContextCandidate;
    readonly queryLeaseId: string;
    readonly identityContextHash: ArtifactDigest;
    readonly authorizationEpoch: string;
    readonly policyContextHash: ArtifactDigest;
    readonly queryHash: ArtifactDigest;
    readonly correlationId: CorrelationId;
    readonly ttlSeconds: number;
  }): Promise<CommittedRuntimeQueryLease>;
  releaseLease(lease: CommittedRuntimeQueryLease): Promise<void>;
}

export interface RuntimeObjectProjectionRow extends Readonly<Record<string, unknown>> {
  readonly objectRid: unknown;
  readonly canonicalPrimaryKey: unknown;
  readonly objectVersion: unknown;
  readonly properties: unknown;
}

export interface RuntimeObjectGetRepository {
  executeObjectGet(input: {
    readonly plan: ObjectGetLogicalPlan;
    readonly lease: CommittedRuntimeQueryLease;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly rows: readonly RuntimeObjectProjectionRow[];
    readonly rowCount: number;
    readonly byteCount: number;
  }>;
}

export type RuntimeQueryErrorCode =
  | "RELEASE_RETIRED"
  | "OBJECT_NOT_ACCESSIBLE"
  | "POLICY_EVALUATION_UNAVAILABLE"
  | "QUERY_CONTEXT_CHANGED"
  | "QUERY_EXECUTION_FAILED";

export class RuntimeQueryError extends Error {
  readonly code: RuntimeQueryErrorCode;

  constructor(code: RuntimeQueryErrorCode, options?: ErrorOptions) {
    super(publicMessage(code), options);
    this.name = "RuntimeQueryError";
    this.code = code;
  }
}

export interface RuntimeQueryApplicationServiceOptions {
  readonly contexts: RuntimeQueryContextRepository;
  readonly objects: RuntimeObjectGetRepository;
  readonly policyGateway: PolicyGatewayPort;
  readonly digestCanonicalText: (canonicalText: string) => ArtifactDigest;
  readonly uuid: () => string;
  readonly leaseTtlSeconds?: number;
}

export interface RuntimeRequestScope {
  readonly projectId: string;
  readonly selector: RuntimeReleaseSelector;
  readonly identity: RuntimeIdentityContext;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}

interface AuthorizedObject {
  readonly object: QueryObjectTypeSchema;
  readonly plan: QueryPolicyPlan;
}

interface MetadataAuthorization {
  readonly visible: readonly AuthorizedObject[];
  readonly visibleLinks: readonly QueryLinkTypeSchema[];
  readonly authorizationEpoch: string;
  readonly aggregatePolicyContextHash: ArtifactDigest;
}

interface MetadataDecision {
  readonly kind: "object" | "link";
  readonly resourceId: string;
  readonly decision: "ALLOW" | "DENY";
  readonly epoch: string;
  readonly contextHash: ArtifactDigest | null;
}

const uuidExpression = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class RuntimeQueryApplicationService {
  readonly #contexts: RuntimeQueryContextRepository;
  readonly #objects: RuntimeObjectGetRepository;
  readonly #policyGateway: PolicyGatewayPort;
  readonly #digestCanonicalText: (canonicalText: string) => ArtifactDigest;
  readonly #uuid: () => string;
  readonly #leaseTtlSeconds: number;

  constructor(options: RuntimeQueryApplicationServiceOptions) {
    const ttl = options.leaseTtlSeconds ?? 30;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 120) {
      throw new Error("Runtime Query Lease TTL is invalid.");
    }
    this.#contexts = options.contexts;
    this.#objects = options.objects;
    this.#policyGateway = options.policyGateway;
    this.#digestCanonicalText = options.digestCanonicalText;
    this.#uuid = options.uuid;
    this.#leaseTtlSeconds = ttl;
  }

  async metadata(scopeInput: RuntimeRequestScope): Promise<RuntimeMetadataResponse> {
    const scope = normalizeScope(scopeInput);
    const candidate = await this.#resolve(scope);
    const registry = registryFromCandidate(candidate);
    const authorization = await this.#authorizeMetadata(scope, candidate, registry);
    const identityContextHash = identityHash(scope.identity, this.#digestCanonicalText);
    const queryHash = this.#digestCanonicalText(
      canonicalizeContractForDigest({
        schemaVersion: 1,
        operation: "runtime_metadata",
        projectId: candidate.projectId,
        releaseId: candidate.releaseId,
        releaseRevisionId: candidate.releaseRevisionId,
        activationId: candidate.activationId,
        generationSetDigest: candidate.generationSetDigest,
      }),
    );
    const lease = await this.#commitLease({
      candidate,
      identityContextHash,
      authorizationEpoch: authorization.authorizationEpoch,
      policyContextHash: authorization.aggregatePolicyContextHash,
      queryHash,
      correlationId: scope.correlationId,
    });
    try {
      return metadataResponse(
        candidate,
        registry,
        authorization.visible,
        authorization.visibleLinks,
        scope.correlationId,
      );
    } finally {
      await this.#release(lease);
    }
  }

  async objectGet(
    scopeInput: RuntimeRequestScope,
    input: { readonly objectTypeApiName: string; readonly primaryKey: unknown },
  ): Promise<RuntimeObjectGetResponse> {
    const scope = normalizeScope(scopeInput);
    const candidate = await this.#resolve(scope);
    const registry = registryFromCandidate(candidate);
    const object = registry.objects.find((item) => item.apiName === input.objectTypeApiName);
    if (object === undefined) throw new RuntimeQueryError("OBJECT_NOT_ACCESSIBLE");
    const gateway = await this.#authorizeObject(scope, candidate, object);
    if (gateway === null) throw new RuntimeQueryError("OBJECT_NOT_ACCESSIBLE");

    let plan: ObjectGetLogicalPlan;
    try {
      plan = compileObjectGet({
        context: {
          registry,
          requestTime: candidate.observedDatabaseAt,
          digestCanonicalText: this.#digestCanonicalText,
        },
        objectTypeApiName: object.apiName,
        request: {
          primaryKey: input.primaryKey,
          select: object.properties.map(({ apiName }) => apiName),
        },
        policy: gateway,
      });
    } catch (error) {
      throw new RuntimeQueryError(
        error instanceof QueryDomainError && error.code === "POLICY_EVALUATION_UNAVAILABLE"
          ? "POLICY_EVALUATION_UNAVAILABLE"
          : "QUERY_EXECUTION_FAILED",
        { cause: error },
      );
    }

    const identityContextHash = identityHash(scope.identity, this.#digestCanonicalText);
    const lease = await this.#commitLease({
      candidate,
      identityContextHash,
      authorizationEpoch: gateway.authorizationEpoch,
      policyContextHash: gateway.policyContextHash,
      queryHash: plan.queryHash,
      correlationId: scope.correlationId,
    });
    try {
      const result = await this.#objects.executeObjectGet({
        plan,
        lease,
        ...(scope.signal === undefined ? {} : { signal: scope.signal }),
      });
      if (
        result.rowCount !== result.rows.length ||
        !Number.isSafeInteger(result.byteCount) ||
        result.byteCount < 0 ||
        result.byteCount > plan.maximumResultBytes
      ) {
        throw new RuntimeQueryError("QUERY_EXECUTION_FAILED");
      }
      return objectGetResponse(candidate, plan, result.rows, scope.correlationId);
    } catch (error) {
      if (error instanceof RuntimeQueryError) throw error;
      throw new RuntimeQueryError("QUERY_EXECUTION_FAILED", { cause: error });
    } finally {
      await this.#release(lease);
    }
  }

  async #resolve(scope: NormalizedRuntimeRequestScope): Promise<RuntimeQueryContextCandidate> {
    try {
      return await this.#contexts.resolveCandidate({
        projectId: scope.projectId,
        selector: scope.selector,
      });
    } catch (error) {
      if (error instanceof RuntimeQueryError) throw error;
      throw new RuntimeQueryError("QUERY_EXECUTION_FAILED", { cause: error });
    }
  }

  async #authorizeObject(
    scope: NormalizedRuntimeRequestScope,
    candidate: RuntimeQueryContextCandidate,
    object: QueryObjectTypeSchema,
  ): Promise<PolicyGatewayContext | null> {
    const result = await this.#policyGateway.authorize({
      projectId: candidate.projectId,
      identity: scope.identity,
      resourceId: object.resourceId,
      permission: "object.read",
      releaseId: candidate.releaseId,
      policyRevisionId: candidate.policy.policyRevisionId,
      compilerVersion: candidate.policy.compilerVersion,
      correlationId: scope.correlationId,
    });
    if (result.source === "FAIL_CLOSED" || result.epoch === null) {
      throw new RuntimeQueryError("POLICY_EVALUATION_UNAVAILABLE");
    }
    if (result.decision === "DENY") return null;
    assertGatewayBinding(candidate, object, result.context);
    return result.context;
  }

  async #authorizeMetadata(
    scope: NormalizedRuntimeRequestScope,
    candidate: RuntimeQueryContextCandidate,
    registry: QuerySchemaRegistry,
  ): Promise<MetadataAuthorization> {
    const decisions: MetadataDecision[] = [];
    const visibleObjects: AuthorizedObject[] = [];

    // Keep database/artifact fan-out bounded.  Policy cache still removes
    // duplicate artifact reads, while eight resources at a time avoids a 256
    // connection burst from one metadata request.
    for (let offset = 0; offset < registry.objects.length; offset += 8) {
      const batch = registry.objects.slice(offset, offset + 8);
      const values = await Promise.all(
        batch.map(async (object) => {
          const result = await this.#policyGateway.authorize({
            projectId: candidate.projectId,
            identity: scope.identity,
            resourceId: object.resourceId,
            permission: "object.read",
            releaseId: candidate.releaseId,
            policyRevisionId: candidate.policy.policyRevisionId,
            compilerVersion: candidate.policy.compilerVersion,
            correlationId: scope.correlationId,
          });
          if (result.source === "FAIL_CLOSED" || result.epoch === null) {
            throw new RuntimeQueryError("POLICY_EVALUATION_UNAVAILABLE");
          }
          if (result.decision === "DENY") {
            return Object.freeze({
              kind: "object" as const,
              resourceId: object.resourceId,
              decision: "DENY" as const,
              epoch: result.epoch,
              contextHash: null,
              authorized: null,
            });
          }
          assertGatewayBinding(candidate, object, result.context);
          const plan = compileObjectPolicyPlan({
            registry,
            object,
            context: result.context,
            requestTime: candidate.observedDatabaseAt,
          });
          const discoverable = result.context.policyRules.some(
            (rule) =>
              rule.effect === "allow" &&
              rule.target.kind === "object" &&
              rule.target.resourceId === object.resourceId &&
              rule.target.resourceRevisionId === object.revisionId,
          );
          return Object.freeze({
            kind: "object" as const,
            resourceId: object.resourceId,
            decision: "ALLOW" as const,
            epoch: result.epoch,
            contextHash: result.context.policyContextHash,
            authorized: discoverable ? Object.freeze({ object, plan }) : null,
          });
        }),
      );
      decisions.push(
        ...values.map(({ kind, resourceId, decision, epoch, contextHash }) =>
          Object.freeze({ kind, resourceId, decision, epoch, contextHash }),
        ),
      );
      visibleObjects.push(
        ...values.flatMap(({ authorized }) => (authorized === null ? [] : [authorized])),
      );
    }

    const visibleObjectRevisions = new Set(visibleObjects.map(({ object }) => object.revisionId));
    const linkCandidates = registry.links.filter(
      (link) =>
        visibleObjectRevisions.has(link.sourceObjectTypeRevisionId) &&
        visibleObjectRevisions.has(link.targetObjectTypeRevisionId),
    );
    const visibleLinks: QueryLinkTypeSchema[] = [];
    for (let offset = 0; offset < linkCandidates.length; offset += 8) {
      const batch = linkCandidates.slice(offset, offset + 8);
      const values = await Promise.all(
        batch.map(async (link) => {
          const result = await this.#policyGateway.authorize({
            projectId: candidate.projectId,
            identity: scope.identity,
            resourceId: link.resourceId,
            // G2-03-06 deliberately activates one coarse Runtime read
            // permission.  The exact Link target rule remains the fine-grained
            // decision inside the same immutable Policy Artifact.
            permission: "object.read",
            releaseId: candidate.releaseId,
            policyRevisionId: candidate.policy.policyRevisionId,
            compilerVersion: candidate.policy.compilerVersion,
            correlationId: scope.correlationId,
          });
          if (result.source === "FAIL_CLOSED" || result.epoch === null) {
            throw new RuntimeQueryError("POLICY_EVALUATION_UNAVAILABLE");
          }
          if (result.decision === "DENY") {
            return Object.freeze({
              decision: Object.freeze({
                kind: "link" as const,
                resourceId: link.resourceId,
                decision: "DENY" as const,
                epoch: result.epoch,
                contextHash: null,
              }),
              link: null,
            });
          }
          assertGatewayBinding(candidate, link, result.context);
          const discoverable = result.context.policyRules.some(
            (rule) =>
              rule.effect === "allow" &&
              rule.target.kind === "link" &&
              rule.target.resourceId === link.resourceId &&
              rule.target.resourceRevisionId === link.revisionId,
          );
          return Object.freeze({
            decision: Object.freeze({
              kind: "link" as const,
              resourceId: link.resourceId,
              decision: "ALLOW" as const,
              epoch: result.epoch,
              contextHash: result.context.policyContextHash,
            }),
            link: discoverable ? link : null,
          });
        }),
      );
      decisions.push(...values.map(({ decision }) => decision));
      visibleLinks.push(...values.flatMap(({ link }) => (link === null ? [] : [link])));
    }

    const epochs = new Set(decisions.map(({ epoch }) => epoch));
    if (decisions.length === 0 || epochs.size !== 1) {
      throw new RuntimeQueryError("POLICY_EVALUATION_UNAVAILABLE");
    }
    const authorizationEpoch = decisions[0]?.epoch;
    if (authorizationEpoch === undefined) {
      throw new RuntimeQueryError("POLICY_EVALUATION_UNAVAILABLE");
    }
    const aggregatePolicyContextHash = this.#digestCanonicalText(
      canonicalizeContractForDigest({
        schemaVersion: 1,
        artifactDigest: candidate.policy.artifactDigest,
        authorizationEpoch,
        decisions: decisions
          .map(({ kind, resourceId, decision, contextHash }) => ({
            kind,
            resourceId,
            decision,
            contextHash,
          }))
          .toSorted((left, right) =>
            compareText(`${left.kind}:${left.resourceId}`, `${right.kind}:${right.resourceId}`),
          ),
      }),
    );
    return Object.freeze({
      visible: Object.freeze(
        visibleObjects.toSorted((left, right) =>
          compareText(left.object.apiName, right.object.apiName),
        ),
      ),
      visibleLinks: Object.freeze(
        visibleLinks.toSorted((left, right) => compareText(left.apiName, right.apiName)),
      ),
      authorizationEpoch,
      aggregatePolicyContextHash,
    });
  }

  async #commitLease(input: {
    readonly candidate: RuntimeQueryContextCandidate;
    readonly identityContextHash: ArtifactDigest;
    readonly authorizationEpoch: string;
    readonly policyContextHash: ArtifactDigest;
    readonly queryHash: ArtifactDigest;
    readonly correlationId: CorrelationId;
  }): Promise<CommittedRuntimeQueryLease> {
    const queryLeaseId = this.#uuid();
    if (!uuidExpression.test(queryLeaseId)) {
      throw new RuntimeQueryError("QUERY_EXECUTION_FAILED");
    }
    try {
      return await this.#contexts.commitLease({
        ...input,
        queryLeaseId,
        ttlSeconds: this.#leaseTtlSeconds,
      });
    } catch (error) {
      if (error instanceof RuntimeQueryError) throw error;
      throw new RuntimeQueryError("QUERY_CONTEXT_CHANGED", { cause: error });
    }
  }

  async #release(lease: CommittedRuntimeQueryLease): Promise<void> {
    try {
      await this.#contexts.releaseLease(lease);
    } catch (error) {
      throw new RuntimeQueryError("QUERY_EXECUTION_FAILED", { cause: error });
    }
  }
}

interface NormalizedRuntimeRequestScope {
  readonly projectId: string;
  readonly selector: RuntimeReleaseSelector;
  readonly identity: RuntimeIdentityContext;
  readonly correlationId: CorrelationId;
  readonly signal?: AbortSignal;
}

function normalizeScope(input: RuntimeRequestScope): NormalizedRuntimeRequestScope {
  let projectId: string;
  let correlationId: CorrelationId;
  try {
    projectId = parseOntosId(input.projectId);
    correlationId = parseCorrelationId(input.correlationId);
  } catch (error) {
    throw new RuntimeQueryError("QUERY_EXECUTION_FAILED", { cause: error });
  }
  let selector: RuntimeReleaseSelector;
  if (input.selector.kind === "release") {
    try {
      selector = Object.freeze({
        kind: "release",
        releaseId: parseOntosId(input.selector.releaseId),
      });
    } catch (error) {
      throw new RuntimeQueryError("RELEASE_RETIRED", { cause: error });
    }
  } else if (input.selector.channelName === "stable") {
    selector = Object.freeze({ kind: "channel", channelName: "stable" });
  } else {
    throw new RuntimeQueryError("QUERY_EXECUTION_FAILED");
  }
  return Object.freeze({
    projectId,
    selector,
    identity: input.identity,
    correlationId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

function registryFromCandidate(candidate: RuntimeQueryContextCandidate): QuerySchemaRegistry {
  try {
    return new QuerySchemaRegistry({
      projectId: candidate.projectId,
      releaseId: candidate.releaseId,
      releaseRevisionId: candidate.releaseRevisionId,
      activationId: candidate.activationId,
      objects: candidate.members
        .filter((member) => member.kind === "object")
        .map((member) => ({
          memberKey: member.memberKey,
          resourceId: member.resourceId,
          revisionId: member.revisionId,
          generationId: member.generationId,
          definition: member.definition,
        })),
      links: candidate.members
        .filter((member) => member.kind === "link")
        .map((member) => ({
          memberKey: member.memberKey,
          resourceId: member.resourceId,
          revisionId: member.revisionId,
          generationId: member.generationId,
          definition: member.definition,
        })),
    });
  } catch (error) {
    throw new RuntimeQueryError("QUERY_EXECUTION_FAILED", { cause: error });
  }
}

function assertGatewayBinding(
  candidate: RuntimeQueryContextCandidate,
  resource: Pick<QueryObjectTypeSchema | QueryLinkTypeSchema, "resourceId" | "revisionId">,
  context: PolicyGatewayContext,
): void {
  if (
    context.projectId !== candidate.projectId ||
    context.releaseId !== candidate.releaseId ||
    context.resourceId !== resource.resourceId ||
    context.resourceRevisionId !== resource.revisionId ||
    context.policyResourceId !== candidate.policy.policyResourceId ||
    context.policyRevisionId !== candidate.policy.policyRevisionId ||
    context.policyCompilationId !== candidate.policy.policyCompilationId ||
    context.artifactDigest !== candidate.policy.artifactDigest ||
    context.compilerVersion !== candidate.policy.compilerVersion
  ) {
    throw new RuntimeQueryError("POLICY_EVALUATION_UNAVAILABLE");
  }
}

function identityHash(
  identity: RuntimeIdentityContext,
  digest: (canonicalText: string) => ArtifactDigest,
): ArtifactDigest {
  return digest(
    canonicalizeContractForDigest({
      schemaVersion: 1,
      identity: identity.identity,
      attributes: identity.attributes,
      capabilities: identity.capabilities,
      authorizationPrincipalIds: identity.authorizationPrincipalIds,
    }),
  );
}

function metadataResponse(
  candidate: RuntimeQueryContextCandidate,
  registry: QuerySchemaRegistry,
  visible: readonly AuthorizedObject[],
  visibleLinks: readonly QueryLinkTypeSchema[],
  correlationId: CorrelationId,
): RuntimeMetadataResponse {
  const visibleByRevision = new Map(visible.map((item) => [item.object.revisionId, item]));
  const visibleLinkRevisions = new Set(visibleLinks.map((link) => link.revisionId));
  const data = visible.map(({ object, plan }) => {
    const properties = object.properties.map((property) => {
      const access = requiredPropertyPlan(plan, property.apiName);
      const disposition: RuntimePropertyDisposition = access.canEverAllow
        ? "allow"
        : access.masks.length > 0
          ? "mask"
          : "restricted";
      return {
        apiName: property.apiName,
        displayName: property.displayName,
        valueType: property.valueType,
        disposition,
        nullable: property.nullable,
        filterOperators:
          disposition === "allow" && property.filterable ? filterOperators(property) : [],
        sortable: disposition === "allow" && property.sortable,
        searchable: disposition === "allow" && property.searchable,
      };
    });
    const propertyByName = new Map(properties.map((property) => [property.apiName, property]));
    const title = propertyByName.get(object.titlePropertyApiName);
    const firstSort = object.defaultSort[0];
    const defaultSort =
      firstSort !== undefined && propertyByName.get(firstSort.propertyApiName)?.sortable === true
        ? { property: firstSort.propertyApiName, direction: firstSort.direction }
        : null;
    const links = registry.links.flatMap<RuntimeLinkMetadata>((link) => {
      const sourceVisible = visibleByRevision.has(link.sourceObjectTypeRevisionId);
      const targetVisible = visibleByRevision.has(link.targetObjectTypeRevisionId);
      if (!sourceVisible || !targetVisible || !visibleLinkRevisions.has(link.revisionId)) return [];
      if (link.sourceObjectTypeRevisionId === object.revisionId) {
        const targetObject = registry.requireObjectByRevision(link.targetObjectTypeRevisionId);
        return [
          {
            apiName: link.apiName,
            displayName: link.displayName,
            targetObjectTypeApiName: targetObject.apiName,
            direction: "outgoing" as const,
          },
        ];
      }
      if (
        link.targetObjectTypeRevisionId === object.revisionId &&
        link.sourceObjectTypeRevisionId !== link.targetObjectTypeRevisionId
      ) {
        const sourceObject = registry.requireObjectByRevision(link.sourceObjectTypeRevisionId);
        return [
          {
            apiName: link.apiName,
            displayName: link.displayName,
            targetObjectTypeApiName: sourceObject.apiName,
            direction: "incoming" as const,
          },
        ];
      }
      return [];
    });
    return {
      apiName: object.apiName,
      displayName: object.displayName,
      titlePropertyApiName:
        title?.disposition === "restricted" ? null : object.titlePropertyApiName,
      defaultSearchProperties: object.defaultSearchPropertyApiNames.filter(
        (name) => propertyByName.get(name)?.searchable === true,
      ),
      defaultSort,
      properties,
      links,
    };
  });
  try {
    return parseRuntimeMetadataResponse({
      schemaVersion: 1,
      releaseId: candidate.releaseId,
      releaseRevisionId: candidate.releaseRevisionId,
      readTimestamp: candidate.observedDatabaseAt,
      correlationId,
      warnings: [],
      data,
    });
  } catch (error) {
    throw new RuntimeQueryError("QUERY_EXECUTION_FAILED", { cause: error });
  }
}

function objectGetResponse(
  candidate: RuntimeQueryContextCandidate,
  plan: ObjectGetLogicalPlan,
  rows: readonly RuntimeObjectProjectionRow[],
  correlationId: CorrelationId,
): RuntimeObjectGetResponse {
  if (rows.length === 0) throw new RuntimeQueryError("OBJECT_NOT_ACCESSIBLE");
  if (rows.length !== 1) throw new RuntimeQueryError("QUERY_EXECUTION_FAILED");
  const row = rows[0];
  if (
    row === undefined ||
    !isPlainRecord(row) ||
    !hasExactKeys(row, ["objectRid", "canonicalPrimaryKey", "objectVersion", "properties"])
  ) {
    throw new RuntimeQueryError("QUERY_EXECUTION_FAILED");
  }
  try {
    parseOntosId(row.objectRid);
  } catch (error) {
    throw new RuntimeQueryError("QUERY_EXECUTION_FAILED", { cause: error });
  }
  if (
    row.canonicalPrimaryKey !== plan.canonicalPrimaryKey ||
    typeof row.objectVersion !== "string" ||
    !isPlainRecord(row.properties)
  ) {
    throw new RuntimeQueryError("QUERY_EXECUTION_FAILED");
  }
  const expectedNames = plan.selectedProperties.map(({ apiName }) => apiName);
  const rowProperties = row.properties;
  if (!hasExactKeys(rowProperties, expectedNames)) {
    throw new RuntimeQueryError("QUERY_EXECUTION_FAILED");
  }
  const properties = plan.selectedProperties.map((property) => {
    const value = rowProperties[property.apiName];
    if (!isPlainRecord(value)) throw new RuntimeQueryError("QUERY_EXECUTION_FAILED");
    const access = requiredPropertyPlan(plan.policy, property.apiName);
    const state = value.state;
    if (
      ((state === "value" || state === "null" || state === "missing") && !access.canEverAllow) ||
      (state === "masked" && access.masks.length === 0) ||
      !new Set(["value", "null", "missing", "masked", "restricted"]).has(String(state))
    ) {
      throw new RuntimeQueryError("QUERY_EXECUTION_FAILED");
    }
    return { apiName: property.apiName, ...value };
  });
  try {
    return parseRuntimeObjectGetResponse({
      schemaVersion: 1,
      releaseId: candidate.releaseId,
      releaseRevisionId: candidate.releaseRevisionId,
      readTimestamp: candidate.observedDatabaseAt,
      correlationId,
      warnings: [],
      data: {
        reference: {
          objectTypeApiName: plan.object.apiName,
          primaryKey: plan.canonicalPrimaryKey,
        },
        objectVersion: row.objectVersion,
        properties,
      },
    });
  } catch (error) {
    throw new RuntimeQueryError("QUERY_EXECUTION_FAILED", { cause: error });
  }
}

function requiredPropertyPlan(plan: QueryPolicyPlan, apiName: string) {
  const access = plan.propertyAccess.find((item) => item.property.apiName === apiName);
  if (access === undefined) throw new RuntimeQueryError("QUERY_EXECUTION_FAILED");
  return access;
}

function filterOperators(property: QueryPropertySchema): readonly RuntimeFilterOperator[] {
  const nullable: readonly RuntimeFilterOperator[] = property.nullable ? ["isNull"] : [];
  switch (property.valueType) {
    case "string":
      return Object.freeze([
        "eq",
        "ne",
        "lt",
        "lte",
        "gt",
        "gte",
        "in",
        "contains",
        "prefix",
        ...nullable,
      ]);
    case "boolean":
      return Object.freeze(["eq", "ne", "in", ...nullable]);
    case "integer":
    case "decimal":
    case "date":
    case "timestamp":
    case "enum":
      return Object.freeze(["eq", "ne", "lt", "lte", "gt", "gte", "in", ...nullable]);
    case "string[]":
      return Object.freeze(["containsAny", ...nullable]);
    case "json":
      return Object.freeze([...nullable]);
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).toSorted(compareText);
  const expected = [...keys].toSorted(compareText);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function publicMessage(code: RuntimeQueryErrorCode): string {
  switch (code) {
    case "RELEASE_RETIRED":
      return "The requested Release is no longer serviceable.";
    case "OBJECT_NOT_ACCESSIBLE":
      return "The requested Object is not accessible.";
    case "POLICY_EVALUATION_UNAVAILABLE":
      return "Authorization could not be confirmed.";
    case "QUERY_CONTEXT_CHANGED":
      return "The Runtime Query context changed before the read could start.";
    case "QUERY_EXECUTION_FAILED":
      return "Runtime Query execution failed closed.";
  }
}

export function parseRuntimeQueryCandidate(
  input: RuntimeQueryContextCandidate,
): RuntimeQueryContextCandidate {
  try {
    const members = input.members.map((member) =>
      Object.freeze({
        memberKey: member.memberKey,
        kind: member.kind,
        resourceId: parseOntosId(member.resourceId),
        revisionId: parseOntosId(member.revisionId),
        generationId: parseOntosId(member.generationId),
        definition: member.definition,
      }),
    );
    return Object.freeze({
      projectId: parseOntosId(input.projectId),
      releaseId: parseOntosId(input.releaseId),
      releaseRevisionId: parseOntosId(input.releaseRevisionId),
      activationId: parseOntosId(input.activationId),
      runtimePlanDigest: parseArtifactDigest(input.runtimePlanDigest),
      generationSetDigest: parseArtifactDigest(input.generationSetDigest),
      observedDatabaseAt: parseCanonicalInstant(input.observedDatabaseAt),
      policy: Object.freeze({
        policyResourceId: parseOntosId(input.policy.policyResourceId),
        policyRevisionId: parseOntosId(input.policy.policyRevisionId),
        policyCompilationId: parseOntosId(input.policy.policyCompilationId),
        artifactDigest: parseArtifactDigest(input.policy.artifactDigest),
        compilerVersion: input.policy.compilerVersion,
      }),
      members: Object.freeze(members),
    });
  } catch (error) {
    throw new RuntimeQueryError("QUERY_EXECUTION_FAILED", { cause: error });
  }
}
