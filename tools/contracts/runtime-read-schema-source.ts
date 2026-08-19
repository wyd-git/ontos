import * as contract from "../../packages/contracts/src/index.ts";

type SchemaNode = Record<string, unknown>;

const ref = (name: string): SchemaNode => ({ $ref: `#/$defs/${name}` });
const nullableRef = (name: string): SchemaNode => ({ oneOf: [ref(name), { type: "null" }] });

function strictObject(
  fields: readonly string[],
  properties: Readonly<Record<string, SchemaNode>>,
  required: readonly string[] = fields,
): SchemaNode {
  const actual = Object.keys(properties).toSorted();
  const expected = [...fields].toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Schema field source mismatch: ${actual.join(",")} != ${expected.join(",")}`);
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: [...required],
  };
}

function arrayOf(
  items: SchemaNode,
  options: Readonly<{
    minimumItems?: number;
    maximumItems?: number;
    uniqueItems?: boolean;
  }> = {},
): SchemaNode {
  return {
    type: "array",
    items,
    ...(options.minimumItems === undefined ? {} : { minItems: options.minimumItems }),
    ...(options.maximumItems === undefined ? {} : { maxItems: options.maximumItems }),
    ...(options.uniqueItems === undefined ? {} : { uniqueItems: options.uniqueItems }),
  };
}

const queryScalar: SchemaNode = {
  type: ["string", "number", "boolean"],
  maxLength: 4_096,
};

export function buildRuntimeReadSchema(): Readonly<Record<string, unknown>> {
  const definitions: Record<string, SchemaNode> = {
    SchemaVersion: { type: "integer", const: contract.FOUNDATION_SCHEMA_VERSION },
    OntosId: {
      type: "string",
      minLength: contract.ONTOS_ID_LENGTH,
      maxLength: contract.ONTOS_ID_LENGTH,
      pattern: contract.ONTOS_ID_PATTERN,
    },
    CorrelationId: {
      type: "string",
      minLength: contract.CORRELATION_ID_MINIMUM_LENGTH,
      maxLength: contract.CORRELATION_ID_MAXIMUM_LENGTH,
      pattern: contract.CORRELATION_ID_PATTERN,
    },
    ArtifactDigest: {
      type: "string",
      minLength: contract.ARTIFACT_DIGEST_LENGTH,
      maxLength: contract.ARTIFACT_DIGEST_LENGTH,
      pattern: contract.ARTIFACT_DIGEST_PATTERN,
    },
    CanonicalInstant: {
      type: "string",
      minLength: contract.CANONICAL_INSTANT_LENGTH,
      maxLength: contract.CANONICAL_INSTANT_LENGTH,
      pattern: contract.CANONICAL_INSTANT_PATTERN,
      format: "ontos-canonical-instant",
    },
    ApiName: {
      type: "string",
      minLength: 1,
      maxLength: 63,
      pattern: contract.API_NAME_PATTERN,
    },
    DisplayName: { type: "string", minLength: 1, maxLength: 128 },
    QueryScalar: queryScalar,
    CursorScalar: { oneOf: [ref("QueryScalar"), { type: "null" }] },
    QueryScalarCollection: arrayOf(ref("QueryScalar"), {
      minimumItems: 1,
      maximumItems: contract.QUERY_IN_MAXIMUM_ITEMS,
      uniqueItems: true,
    }),
    PolicyScalarCollection: arrayOf(ref("QueryScalar"), {
      minimumItems: 1,
      maximumItems: contract.POLICY_COLLECTION_MAXIMUM_ITEMS,
      uniqueItems: true,
    }),
    OpaqueCursor: {
      type: "string",
      minLength: contract.OPAQUE_CURSOR_MINIMUM_LENGTH,
      maxLength: contract.OPAQUE_CURSOR_MAXIMUM_LENGTH,
      pattern: contract.OPAQUE_CURSOR_PATTERN,
    },
    QueryComparisonPredicate: strictObject(contract.QUERY_COMPARISON_PREDICATE_FIELDS, {
      property: ref("ApiName"),
      op: { type: "string", enum: contract.QUERY_COMPARISON_OPERATOR_VALUES },
      value: { oneOf: [ref("QueryScalar"), ref("QueryScalarCollection")] },
    }),
    QueryNullPredicate: strictObject(contract.QUERY_NULL_PREDICATE_FIELDS, {
      property: ref("ApiName"),
      op: { type: "string", const: "isNull" },
    }),
    QueryAndPredicate: strictObject(contract.QUERY_AND_PREDICATE_FIELDS, {
      and: arrayOf(ref("QueryPredicate"), {
        minimumItems: 1,
        maximumItems: contract.QUERY_PREDICATE_MAXIMUM_COUNT,
      }),
    }),
    QueryOrPredicate: strictObject(contract.QUERY_OR_PREDICATE_FIELDS, {
      or: arrayOf(ref("QueryPredicate"), {
        minimumItems: 1,
        maximumItems: contract.QUERY_PREDICATE_MAXIMUM_COUNT,
      }),
    }),
    QueryNotPredicate: strictObject(contract.QUERY_NOT_PREDICATE_FIELDS, {
      not: ref("QueryPredicate"),
    }),
    QueryPredicate: {
      oneOf: [
        ref("QueryComparisonPredicate"),
        ref("QueryNullPredicate"),
        ref("QueryAndPredicate"),
        ref("QueryOrPredicate"),
        ref("QueryNotPredicate"),
      ],
    },
    QuerySort: strictObject(contract.QUERY_SORT_FIELDS, {
      property: ref("ApiName"),
      direction: { type: "string", enum: contract.QUERY_SORT_DIRECTION_VALUES },
    }),
    QueryPage: strictObject(
      contract.QUERY_PAGE_FIELDS,
      {
        size: {
          type: "integer",
          minimum: 1,
          maximum: contract.QUERY_PAGE_MAXIMUM_SIZE,
          default: contract.QUERY_PAGE_DEFAULT_SIZE,
        },
        cursor: nullableRef("OpaqueCursor"),
      },
      [],
    ),
    LinkQueryPage: strictObject(
      contract.QUERY_PAGE_FIELDS,
      {
        size: {
          type: "integer",
          minimum: 1,
          maximum: contract.QUERY_LINK_PAGE_MAXIMUM_SIZE,
          default: contract.QUERY_PAGE_DEFAULT_SIZE,
        },
        cursor: nullableRef("OpaqueCursor"),
      },
      [],
    ),
    RuntimeSearchRequest: strictObject(
      contract.RUNTIME_SEARCH_REQUEST_FIELDS,
      {
        schemaVersion: ref("SchemaVersion"),
        select: arrayOf(ref("ApiName"), {
          minimumItems: 1,
          maximumItems: contract.QUERY_SELECT_MAXIMUM_ITEMS,
          uniqueItems: true,
        }),
        searchText: {
          type: "string",
          minLength: 0,
          maxLength: contract.QUERY_SEARCH_TEXT_MAXIMUM_LENGTH,
        },
        where: ref("QueryPredicate"),
        orderBy: arrayOf(ref("QuerySort"), { maximumItems: 1 }),
        page: ref("QueryPage"),
      },
      contract.RUNTIME_SEARCH_REQUEST_REQUIRED_FIELDS,
    ),
    RuntimeCountRequest: strictObject(
      contract.RUNTIME_COUNT_REQUEST_FIELDS,
      {
        schemaVersion: ref("SchemaVersion"),
        operation: { type: "string", const: "count" },
        searchText: {
          type: "string",
          minLength: 0,
          maxLength: contract.QUERY_SEARCH_TEXT_MAXIMUM_LENGTH,
        },
        where: ref("QueryPredicate"),
      },
      contract.RUNTIME_COUNT_REQUEST_REQUIRED_FIELDS,
    ),
    RuntimeLinkHop: strictObject(contract.RUNTIME_LINK_HOP_FIELDS, {
      linkTypeApiName: ref("ApiName"),
      direction: { type: "string", enum: ["outgoing", "incoming"] },
    }),
    RuntimeLinkSearchRequest: strictObject(
      contract.RUNTIME_LINK_SEARCH_REQUEST_FIELDS,
      {
        schemaVersion: ref("SchemaVersion"),
        direction: { type: "string", enum: ["outgoing", "incoming"] },
        secondHop: ref("RuntimeLinkHop"),
        select: arrayOf(ref("ApiName"), {
          minimumItems: 1,
          maximumItems: contract.QUERY_SELECT_MAXIMUM_ITEMS,
          uniqueItems: true,
        }),
        searchText: {
          type: "string",
          minLength: 0,
          maxLength: contract.QUERY_SEARCH_TEXT_MAXIMUM_LENGTH,
        },
        where: ref("QueryPredicate"),
        orderBy: arrayOf(ref("QuerySort"), { maximumItems: 1 }),
        page: ref("LinkQueryPage"),
      },
      contract.RUNTIME_LINK_SEARCH_REQUEST_REQUIRED_FIELDS,
    ),
    PrincipalSummary: strictObject(contract.PRINCIPAL_SUMMARY_FIELDS, {
      principalId: ref("OntosId"),
      identityType: { type: "string", enum: contract.IDENTITY_TYPE_VALUES },
    }),
    RuntimeIdentityContext: strictObject(contract.RUNTIME_IDENTITY_CONTEXT_FIELDS, {
      schemaVersion: ref("SchemaVersion"),
      actor: ref("PrincipalSummary"),
      delegationChain: arrayOf(ref("PrincipalSummary"), {
        maximumItems: contract.DELEGATION_CHAIN_MAXIMUM_ITEMS,
        uniqueItems: true,
      }),
      claimsFingerprint: ref("ArtifactDigest"),
      authenticatedAt: ref("CanonicalInstant"),
      authorizationMode: { type: "string", const: "intersection" },
    }),
    PolicyTarget: strictObject(
      contract.POLICY_TARGET_FIELDS,
      {
        kind: { type: "string", enum: contract.POLICY_TARGET_KIND_VALUES },
        resourceId: ref("OntosId"),
        resourceRevisionId: ref("OntosId"),
        propertyApiName: ref("ApiName"),
        targetObjectTypeResourceId: ref("OntosId"),
        targetObjectTypeRevisionId: ref("OntosId"),
      },
      contract.POLICY_TARGET_REQUIRED_FIELDS,
    ),
    PolicyPropertyOperand: strictObject(["source", "apiName"], {
      source: { type: "string", const: "object_property" },
      apiName: ref("ApiName"),
    }),
    PolicyActorAttributeOperand: strictObject(["source", "apiName"], {
      source: { type: "string", const: "actor_attribute" },
      apiName: ref("ApiName"),
    }),
    PolicyConstantOperand: strictObject(["source", "value"], {
      source: { type: "string", const: "constant" },
      value: { oneOf: [ref("QueryScalar"), ref("PolicyScalarCollection")] },
    }),
    PolicyRequestTimeOperand: strictObject(["source"], {
      source: { type: "string", const: "request_time" },
    }),
    PolicyOperand: {
      oneOf: [
        ref("PolicyPropertyOperand"),
        ref("PolicyActorAttributeOperand"),
        ref("PolicyConstantOperand"),
        ref("PolicyRequestTimeOperand"),
      ],
    },
    PolicyConstantPredicate: strictObject(contract.POLICY_CONSTANT_PREDICATE_FIELDS, {
      kind: { type: "string", const: "constant" },
      value: { type: "boolean" },
    }),
    PolicyComparisonPredicate: strictObject(contract.POLICY_COMPARISON_PREDICATE_FIELDS, {
      kind: { type: "string", const: "compare" },
      left: ref("PolicyOperand"),
      op: { type: "string", enum: contract.POLICY_COMPARISON_OPERATOR_VALUES },
      right: ref("PolicyOperand"),
    }),
    PolicyNullPredicate: strictObject(contract.POLICY_NULL_PREDICATE_FIELDS, {
      kind: { type: "string", const: "is_null" },
      operand: ref("PolicyOperand"),
    }),
    PolicyLogicalPredicate: strictObject(contract.POLICY_LOGICAL_PREDICATE_FIELDS, {
      kind: { type: "string", enum: ["all", "any"] },
      predicates: arrayOf(ref("PolicyPredicate"), {
        minimumItems: 1,
        maximumItems: contract.POLICY_PREDICATE_MAXIMUM_COUNT,
      }),
    }),
    PolicyNotPredicate: strictObject(contract.POLICY_NOT_PREDICATE_FIELDS, {
      kind: { type: "string", const: "not" },
      predicate: ref("PolicyPredicate"),
    }),
    PolicyLinkExistsPredicate: strictObject(
      contract.POLICY_LINK_EXISTS_PREDICATE_FIELDS,
      {
        kind: { type: "string", const: "link_exists" },
        linkTypeApiName: ref("ApiName"),
        linkTypeResourceId: ref("OntosId"),
        linkTypeRevisionId: ref("OntosId"),
        targetObjectTypeApiName: ref("ApiName"),
        targetObjectTypeResourceId: ref("OntosId"),
        targetObjectTypeRevisionId: ref("OntosId"),
        predicate: ref("PolicyPredicate"),
      },
      contract.POLICY_LINK_EXISTS_PREDICATE_REQUIRED_FIELDS,
    ),
    PolicyPredicate: {
      oneOf: [
        ref("PolicyConstantPredicate"),
        ref("PolicyComparisonPredicate"),
        ref("PolicyNullPredicate"),
        ref("PolicyLogicalPredicate"),
        ref("PolicyNotPredicate"),
        ref("PolicyLinkExistsPredicate"),
      ],
    },
    PolicyMask: strictObject(contract.POLICY_MASK_FIELDS, {
      kind: { type: "string", const: "redact" },
      displayValue: { type: "string", minLength: 1, maxLength: 64 },
    }),
    PolicyRule: strictObject(
      contract.POLICY_RULE_FIELDS,
      {
        ruleId: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: contract.POLICY_STABLE_NAME_PATTERN,
        },
        target: ref("PolicyTarget"),
        effect: { type: "string", enum: contract.POLICY_EFFECT_VALUES },
        predicate: ref("PolicyPredicate"),
        mask: ref("PolicyMask"),
      },
      contract.POLICY_RULE_REQUIRED_FIELDS,
    ),
    PolicyFact: strictObject(
      contract.POLICY_FACT_FIELDS,
      {
        source: {
          type: "string",
          enum: ["object_property", "actor_attribute", "link"],
        },
        apiName: ref("ApiName"),
        state: { type: "string", enum: ["value", "null", "missing"] },
        value: ref("QueryScalar"),
        values: arrayOf(
          { type: "string", maxLength: 4_096 },
          {
            maximumItems: contract.POLICY_COLLECTION_MAXIMUM_ITEMS,
            uniqueItems: true,
          },
        ),
      },
      contract.POLICY_FACT_REQUIRED_FIELDS,
    ),
    PolicyTestVector: strictObject(
      contract.POLICY_TEST_VECTOR_FIELDS,
      {
        vectorId: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: contract.POLICY_STABLE_NAME_PATTERN,
        },
        identity: ref("RuntimeIdentityContext"),
        requestTime: ref("CanonicalInstant"),
        target: ref("PolicyTarget"),
        facts: arrayOf(ref("PolicyFact"), {
          maximumItems: contract.POLICY_FACT_MAXIMUM_ITEMS,
        }),
        expectedDecision: { type: "string", enum: ["allow", "deny"] },
        expectedPropertyDisposition: {
          type: "string",
          enum: contract.PROPERTY_POLICY_DISPOSITION_VALUES,
        },
      },
      contract.POLICY_TEST_VECTOR_REQUIRED_FIELDS,
    ),
    PolicyActorAttributeSchema: strictObject(contract.POLICY_ACTOR_ATTRIBUTE_SCHEMA_FIELDS, {
      apiName: ref("ApiName"),
      valueType: { type: "string", enum: ["string", "string_array", "boolean"] },
    }),
    PolicyArtifact: strictObject(
      contract.POLICY_ARTIFACT_FIELDS,
      {
        schemaVersion: ref("SchemaVersion"),
        projectId: ref("OntosId"),
        releaseId: ref("OntosId"),
        policyRevisionId: ref("OntosId"),
        compilerVersion: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: contract.POLICY_COMPILER_VERSION_PATTERN,
        },
        artifactDigest: ref("ArtifactDigest"),
        dependencyContextDigest: ref("ArtifactDigest"),
        trustedActorAttributes: arrayOf(ref("PolicyActorAttributeSchema"), {
          maximumItems: 32,
        }),
        rules: arrayOf(ref("PolicyRule"), {
          minimumItems: 1,
          maximumItems: contract.POLICY_RULE_MAXIMUM_ITEMS,
        }),
        testVectors: arrayOf(ref("PolicyTestVector"), {
          minimumItems: 1,
          maximumItems: contract.POLICY_TEST_VECTOR_MAXIMUM_ITEMS,
        }),
      },
      contract.POLICY_ARTIFACT_REQUIRED_FIELDS,
    ),
    PolicyDecision: strictObject(
      contract.POLICY_DECISION_FIELDS,
      {
        schemaVersion: ref("SchemaVersion"),
        target: ref("PolicyTarget"),
        decision: { type: "string", enum: ["allow", "deny"] },
        propertyDisposition: {
          type: "string",
          enum: contract.PROPERTY_POLICY_DISPOSITION_VALUES,
        },
        mask: ref("PolicyMask"),
        policyContextHash: ref("ArtifactDigest"),
        authorizationEpoch: {
          type: "string",
          minLength: 1,
          maxLength: 19,
          pattern: contract.AUTHORIZATION_EPOCH_PATTERN,
        },
        evaluatedAt: ref("CanonicalInstant"),
      },
      contract.POLICY_DECISION_REQUIRED_FIELDS,
    ),
    CursorGenerationBinding: strictObject(contract.CURSOR_GENERATION_BINDING_FIELDS, {
      memberKey: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        pattern: "^(?:object|link):[A-Za-z][A-Za-z0-9_]{0,62}$",
      },
      resourceRevisionId: ref("OntosId"),
      generationId: ref("OntosId"),
    }),
    CursorSortBinding: strictObject(contract.CURSOR_SORT_BINDING_FIELDS, {
      property: ref("ApiName"),
      direction: { type: "string", enum: contract.QUERY_SORT_DIRECTION_VALUES },
      nulls: { type: "string", enum: ["first", "last"] },
      collation: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
      },
    }),
    CursorEnvelope: strictObject(contract.CURSOR_ENVELOPE_FIELDS, {
      schemaVersion: ref("SchemaVersion"),
      keyVersion: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        pattern: contract.CURSOR_KEY_VERSION_PATTERN,
      },
      issuedAt: ref("CanonicalInstant"),
      expiresAt: ref("CanonicalInstant"),
      projectId: ref("OntosId"),
      releaseId: ref("OntosId"),
      releaseRevisionId: ref("OntosId"),
      activationId: ref("OntosId"),
      objectTypeResourceId: ref("OntosId"),
      objectTypeRevisionId: ref("OntosId"),
      generations: arrayOf(ref("CursorGenerationBinding"), {
        minimumItems: 1,
        maximumItems: contract.CURSOR_GENERATION_MAXIMUM_ITEMS,
      }),
      queryHash: ref("ArtifactDigest"),
      policyContextHash: ref("ArtifactDigest"),
      identityContextHash: ref("ArtifactDigest"),
      sort: arrayOf(ref("CursorSortBinding"), {
        minimumItems: 1,
        maximumItems: contract.CURSOR_SORT_MAXIMUM_ITEMS,
      }),
      lastValues: arrayOf(ref("CursorScalar"), {
        minimumItems: 1,
        maximumItems: contract.CURSOR_SORT_MAXIMUM_ITEMS,
      }),
    }),
    RuntimePropertyMetadata: strictObject(contract.RUNTIME_PROPERTY_METADATA_FIELDS, {
      apiName: ref("ApiName"),
      displayName: ref("DisplayName"),
      valueType: { type: "string", enum: contract.PROPERTY_VALUE_TYPE_VALUES },
      disposition: { type: "string", enum: contract.RUNTIME_PROPERTY_DISPOSITION_VALUES },
      nullable: { type: "boolean" },
      filterOperators: arrayOf(
        {
          type: "string",
          enum: [...contract.QUERY_COMPARISON_OPERATOR_VALUES, "isNull"],
        },
        { maximumItems: contract.QUERY_COMPARISON_OPERATOR_VALUES.length + 1, uniqueItems: true },
      ),
      sortable: { type: "boolean" },
      searchable: { type: "boolean" },
    }),
    RuntimeLinkMetadata: strictObject(contract.RUNTIME_LINK_METADATA_FIELDS, {
      apiName: ref("ApiName"),
      displayName: ref("DisplayName"),
      targetObjectTypeApiName: ref("ApiName"),
      direction: { type: "string", enum: ["outgoing", "incoming"] },
    }),
    RuntimeObjectTypeMetadata: strictObject(contract.RUNTIME_OBJECT_TYPE_METADATA_FIELDS, {
      apiName: ref("ApiName"),
      displayName: ref("DisplayName"),
      titlePropertyApiName: nullableRef("ApiName"),
      defaultSearchProperties: arrayOf(ref("ApiName"), {
        maximumItems: contract.RUNTIME_METADATA_PROPERTY_MAXIMUM_ITEMS,
        uniqueItems: true,
      }),
      defaultSort: nullableRef("QuerySort"),
      properties: arrayOf(ref("RuntimePropertyMetadata"), {
        minimumItems: 1,
        maximumItems: contract.RUNTIME_METADATA_PROPERTY_MAXIMUM_ITEMS,
      }),
      links: arrayOf(ref("RuntimeLinkMetadata"), {
        maximumItems: contract.RUNTIME_METADATA_LINK_MAXIMUM_ITEMS,
      }),
    }),
    RuntimeWarning: strictObject(contract.RUNTIME_WARNING_FIELDS, {
      code: {
        type: "string",
        minLength: 3,
        maxLength: 64,
        pattern: contract.RUNTIME_WARNING_CODE_PATTERN,
      },
      message: {
        type: "string",
        minLength: 1,
        maxLength: contract.RUNTIME_WARNING_MESSAGE_MAXIMUM_LENGTH,
      },
    }),
    RuntimeObjectReference: strictObject(contract.RUNTIME_OBJECT_REFERENCE_FIELDS, {
      objectTypeApiName: ref("ApiName"),
      primaryKey: {
        type: "string",
        minLength: 1,
        maxLength: contract.RUNTIME_PRIMARY_KEY_MAXIMUM_LENGTH,
      },
    }),
    RuntimeNonNullJsonValue: {
      type: ["object", "array", "string", "number", "boolean"],
    },
    RuntimeValueProperty: strictObject(["apiName", "state", "value"], {
      apiName: ref("ApiName"),
      state: { type: "string", const: "value" },
      value: ref("RuntimeNonNullJsonValue"),
    }),
    RuntimeNullProperty: strictObject(["apiName", "state", "value"], {
      apiName: ref("ApiName"),
      state: { type: "string", const: "null" },
      value: { type: "null" },
    }),
    RuntimeMissingProperty: strictObject(["apiName", "state"], {
      apiName: ref("ApiName"),
      state: { type: "string", const: "missing" },
    }),
    RuntimeMaskedProperty: strictObject(["apiName", "state", "displayValue"], {
      apiName: ref("ApiName"),
      state: { type: "string", const: "masked" },
      displayValue: { type: "string", minLength: 1, maxLength: 256 },
    }),
    RuntimeRestrictedProperty: strictObject(["apiName", "state"], {
      apiName: ref("ApiName"),
      state: { type: "string", const: "restricted" },
    }),
    RuntimePropertyResult: {
      oneOf: [
        ref("RuntimeValueProperty"),
        ref("RuntimeNullProperty"),
        ref("RuntimeMissingProperty"),
        ref("RuntimeMaskedProperty"),
        ref("RuntimeRestrictedProperty"),
      ],
    },
    RuntimeObject: strictObject(contract.RUNTIME_OBJECT_FIELDS, {
      reference: ref("RuntimeObjectReference"),
      objectVersion: {
        type: "string",
        minLength: 1,
        maxLength: 19,
        pattern: contract.RUNTIME_OBJECT_VERSION_PATTERN,
      },
      properties: arrayOf(ref("RuntimePropertyResult"), {
        maximumItems: contract.QUERY_SELECT_MAXIMUM_ITEMS,
      }),
    }),
    RuntimeResponseMetadata: strictObject(contract.RUNTIME_RESPONSE_METADATA_FIELDS, {
      schemaVersion: ref("SchemaVersion"),
      releaseId: ref("OntosId"),
      releaseRevisionId: ref("OntosId"),
      readTimestamp: ref("CanonicalInstant"),
      correlationId: ref("CorrelationId"),
      warnings: arrayOf(ref("RuntimeWarning"), {
        maximumItems: contract.RUNTIME_WARNING_MAXIMUM_ITEMS,
      }),
    }),
    RuntimeMetadataResponse: strictObject(contract.RUNTIME_METADATA_RESPONSE_FIELDS, {
      schemaVersion: ref("SchemaVersion"),
      releaseId: ref("OntosId"),
      releaseRevisionId: ref("OntosId"),
      readTimestamp: ref("CanonicalInstant"),
      correlationId: ref("CorrelationId"),
      warnings: arrayOf(ref("RuntimeWarning"), {
        maximumItems: contract.RUNTIME_WARNING_MAXIMUM_ITEMS,
      }),
      data: arrayOf(ref("RuntimeObjectTypeMetadata"), {
        maximumItems: contract.RUNTIME_METADATA_OBJECT_TYPE_MAXIMUM_ITEMS,
      }),
    }),
    RuntimeObjectGetResponse: strictObject(contract.RUNTIME_OBJECT_GET_RESPONSE_FIELDS, {
      schemaVersion: ref("SchemaVersion"),
      releaseId: ref("OntosId"),
      releaseRevisionId: ref("OntosId"),
      readTimestamp: ref("CanonicalInstant"),
      correlationId: ref("CorrelationId"),
      warnings: arrayOf(ref("RuntimeWarning"), {
        maximumItems: contract.RUNTIME_WARNING_MAXIMUM_ITEMS,
      }),
      data: ref("RuntimeObject"),
    }),
    RuntimeSearchResponse: strictObject(contract.RUNTIME_SEARCH_RESPONSE_FIELDS, {
      schemaVersion: ref("SchemaVersion"),
      releaseId: ref("OntosId"),
      releaseRevisionId: ref("OntosId"),
      readTimestamp: ref("CanonicalInstant"),
      correlationId: ref("CorrelationId"),
      warnings: arrayOf(ref("RuntimeWarning"), {
        maximumItems: contract.RUNTIME_WARNING_MAXIMUM_ITEMS,
      }),
      data: arrayOf(ref("RuntimeObject"), { maximumItems: contract.QUERY_PAGE_MAXIMUM_SIZE }),
      nextCursor: nullableRef("OpaqueCursor"),
    }),
    RuntimeCountResponse: strictObject(contract.RUNTIME_COUNT_RESPONSE_FIELDS, {
      schemaVersion: ref("SchemaVersion"),
      releaseId: ref("OntosId"),
      releaseRevisionId: ref("OntosId"),
      readTimestamp: ref("CanonicalInstant"),
      correlationId: ref("CorrelationId"),
      warnings: arrayOf(ref("RuntimeWarning"), {
        maximumItems: contract.RUNTIME_WARNING_MAXIMUM_ITEMS,
      }),
      count: {
        type: "string",
        minLength: 1,
        maxLength: 19,
        pattern: contract.RUNTIME_COUNT_PATTERN,
      },
    }),
    RuntimeResolvedLinkHop: strictObject(contract.RUNTIME_RESOLVED_LINK_HOP_FIELDS, {
      linkTypeApiName: ref("ApiName"),
      direction: { type: "string", enum: ["outgoing", "incoming"] },
    }),
    RuntimeLinkSearchResponse: strictObject(contract.RUNTIME_LINK_SEARCH_RESPONSE_FIELDS, {
      schemaVersion: ref("SchemaVersion"),
      releaseId: ref("OntosId"),
      releaseRevisionId: ref("OntosId"),
      readTimestamp: ref("CanonicalInstant"),
      correlationId: ref("CorrelationId"),
      warnings: arrayOf(ref("RuntimeWarning"), {
        maximumItems: contract.RUNTIME_WARNING_MAXIMUM_ITEMS,
      }),
      resolvedPath: arrayOf(ref("RuntimeResolvedLinkHop"), {
        minimumItems: 1,
        maximumItems: contract.QUERY_LINK_MAXIMUM_HOPS,
      }),
      data: arrayOf(ref("RuntimeObject"), {
        maximumItems: contract.QUERY_LINK_PAGE_MAXIMUM_SIZE,
      }),
      nextCursor: nullableRef("OpaqueCursor"),
    }),
  };

  return Object.freeze({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://ontos.dev/contracts/runtime-read.v1.schema.json",
    title: "Ontos Query, Policy, Identity and Runtime Read Contracts",
    description:
      "G2-03 kernel semantic contracts and Runtime Read Candidate. The HTTP candidate is not a published SDK support commitment.",
    $defs: definitions,
  });
}
