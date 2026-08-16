import { DATASET_PRESETS } from "./generator.ts";

export const MATERIALIZATION_FIXTURE_VERSION = "materialization-testkit-v1" as const;

const qualityRules = Object.freeze({
  primaryKeyNullMaximumCount: 0,
  primaryKeyDuplicateMaximumCount: 0,
  requiredPropertyFailureMaximumCount: 0,
  requiredLinkDanglingMaximumCount: 0,
  optionalPropertyFailureMaximumBasisPoints: 100,
  optionalLinkDanglingMaximumBasisPoints: 100,
  rowCountChangeConfirmationBasisPoints: 1_000,
  optionalFailureDisposition: "reject_row" as const,
});

function property(apiName: string, options: { readonly searchable?: boolean } = {}) {
  return Object.freeze({
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `${apiName} materialization fixture property.`,
    valueType: "string" as const,
    caseSensitive: true,
    nullable: false,
    writeMode: "source_only" as const,
    unique: apiName === "id",
    filterable: true,
    sortable: true,
    searchable: options.searchable ?? false,
    classification: "internal" as const,
  });
}

function objectType(apiName: string) {
  return Object.freeze({
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `${apiName} materialization testkit Object.`,
    primaryKeyPropertyApiName: "id",
    titlePropertyApiName: "name",
    defaultSearchPropertyApiNames: Object.freeze(["name"]),
    defaultSort: Object.freeze([{ propertyApiName: "id", direction: "asc" as const }]),
    defaultClassification: "internal" as const,
    properties: Object.freeze([property("id"), property("name", { searchable: true })]),
  });
}

function objectSchema() {
  return Object.freeze({
    schemaVersion: 1,
    contractVersion: "snapshot-schema-v1" as const,
    format: "csv_utf8" as const,
    headerRow: true as const,
    columns: Object.freeze([
      { ordinal: 0, columnApiName: "id", valueType: "string" as const, required: true },
      { ordinal: 1, columnApiName: "name", valueType: "string" as const, required: true },
    ]),
  });
}

function linkSchema(sourceColumn: string, targetColumn: string) {
  return Object.freeze({
    schemaVersion: 1,
    contractVersion: "snapshot-schema-v1" as const,
    format: "csv_utf8" as const,
    headerRow: true as const,
    columns: Object.freeze([
      { ordinal: 0, columnApiName: sourceColumn, valueType: "string" as const, required: true },
      { ordinal: 1, columnApiName: targetColumn, valueType: "string" as const, required: true },
    ]),
  });
}

function objectMapping(input: {
  readonly schemaRevisionId: string;
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
}) {
  return Object.freeze({
    schemaVersion: 1,
    mappingVersion: "mapping-v1" as const,
    targetKind: "object" as const,
    inputSchemaRevisionId: input.schemaRevisionId,
    targetResourceId: input.targetResourceId,
    targetRevisionId: input.targetRevisionId,
    valueCodecVersion: "pk1" as const,
    propertyMappings: Object.freeze([
      Object.freeze({
        propertyApiName: "name",
        required: true,
        nullPolicy: "reject_row" as const,
        expression: Object.freeze({ op: "column" as const, columnApiName: "name" }),
      }),
    ]),
    primaryKeyExpression: Object.freeze({ op: "column" as const, columnApiName: "id" }),
    qualityRules,
  });
}

function linkType(input: {
  readonly apiName: string;
  readonly sourceRevisionId: string;
  readonly sourceApiName: string;
  readonly targetRevisionId: string;
  readonly targetApiName: string;
}) {
  return Object.freeze({
    schemaVersion: 1,
    apiName: input.apiName,
    displayName: input.apiName,
    description: `${input.apiName} materialization testkit Link.`,
    source: Object.freeze({
      objectTypeRevisionId: input.sourceRevisionId,
      apiName: input.sourceApiName,
      displayName: input.sourceApiName,
    }),
    target: Object.freeze({
      objectTypeRevisionId: input.targetRevisionId,
      apiName: input.targetApiName,
      displayName: input.targetApiName,
    }),
    cardinality: "one_to_many" as const,
    sourceKind: "base" as const,
    deletionBehavior: "restrict" as const,
    actionCreateAllowed: false,
    actionDeleteAllowed: false,
  });
}

function linkMapping(input: {
  readonly schemaRevisionId: string;
  readonly targetResourceId: string;
  readonly targetRevisionId: string;
  readonly sourceRevisionId: string;
  readonly sourceColumn: string;
  readonly targetRevisionIdForKey: string;
  readonly targetColumn: string;
}) {
  return Object.freeze({
    schemaVersion: 1,
    mappingVersion: "mapping-v1" as const,
    targetKind: "link" as const,
    inputSchemaRevisionId: input.schemaRevisionId,
    targetResourceId: input.targetResourceId,
    targetRevisionId: input.targetRevisionId,
    valueCodecVersion: "pk1" as const,
    propertyMappings: Object.freeze([]),
    sourceKeyMapping: Object.freeze({
      objectTypeRevisionId: input.sourceRevisionId,
      expression: Object.freeze({ op: "column" as const, columnApiName: input.sourceColumn }),
      codecVersion: "pk1" as const,
    }),
    targetKeyMapping: Object.freeze({
      objectTypeRevisionId: input.targetRevisionIdForKey,
      expression: Object.freeze({ op: "column" as const, columnApiName: input.targetColumn }),
      codecVersion: "pk1" as const,
    }),
    qualityRules,
  });
}

const commerceIds = Object.freeze({
  customerResource: "31000000-0000-4000-8000-000000000001",
  customerRevision: "31000000-0000-4000-8000-000000000011",
  orderResource: "31000000-0000-4000-8000-000000000002",
  orderRevision: "31000000-0000-4000-8000-000000000012",
  linkResource: "31000000-0000-4000-8000-000000000003",
  linkRevision: "31000000-0000-4000-8000-000000000013",
  customerSchemaRevision: "31000000-0000-4000-8000-000000000101",
  orderSchemaRevision: "31000000-0000-4000-8000-000000000102",
  linkSchemaRevision: "31000000-0000-4000-8000-000000000103",
  customerMappingRevision: "31000000-0000-4000-8000-000000000201",
  orderMappingRevision: "31000000-0000-4000-8000-000000000202",
  linkMappingRevision: "31000000-0000-4000-8000-000000000203",
});

const workIds = Object.freeze({
  workerResource: "32000000-0000-4000-8000-000000000001",
  workerRevision: "32000000-0000-4000-8000-000000000011",
  itemResource: "32000000-0000-4000-8000-000000000002",
  itemRevision: "32000000-0000-4000-8000-000000000012",
  linkResource: "32000000-0000-4000-8000-000000000003",
  linkRevision: "32000000-0000-4000-8000-000000000013",
  workerSchemaRevision: "32000000-0000-4000-8000-000000000101",
  itemSchemaRevision: "32000000-0000-4000-8000-000000000102",
  linkSchemaRevision: "32000000-0000-4000-8000-000000000103",
  workerMappingRevision: "32000000-0000-4000-8000-000000000201",
  itemMappingRevision: "32000000-0000-4000-8000-000000000202",
  linkMappingRevision: "32000000-0000-4000-8000-000000000203",
});

const customerType = objectType("Customer");
const orderType = objectType("Order");
const commerceLinkType = linkType({
  apiName: "CustomerPlacedOrder",
  sourceRevisionId: commerceIds.customerRevision,
  sourceApiName: "customer",
  targetRevisionId: commerceIds.orderRevision,
  targetApiName: "order",
});
const workerType = objectType("Worker");
const workItemType = objectType("WorkItem");
const workLinkType = linkType({
  apiName: "WorkerAssignedWorkItem",
  sourceRevisionId: workIds.workerRevision,
  sourceApiName: "worker",
  targetRevisionId: workIds.itemRevision,
  targetApiName: "workItem",
});

export const MATERIALIZATION_DOMAINS = Object.freeze([
  Object.freeze({
    id: "commerce",
    namespace: "fixture.commerce",
    sourcePath: "spikes/g1/packages/commerce/package.json",
    sourceSha256: "12cebc3d1ae3e25ab3bd8ef70cf3b020481652a3ba74e6fb1db4342eb11ee08c",
    members: Object.freeze([
      Object.freeze({
        memberKey: "object:Customer",
        kind: "object" as const,
        resourceId: commerceIds.customerResource,
        revisionId: commerceIds.customerRevision,
        definition: customerType,
        schemaRevisionId: commerceIds.customerSchemaRevision,
        schema: objectSchema(),
        mappingRevisionId: commerceIds.customerMappingRevision,
        mapping: objectMapping({
          schemaRevisionId: commerceIds.customerSchemaRevision,
          targetResourceId: commerceIds.customerResource,
          targetRevisionId: commerceIds.customerRevision,
        }),
        csv: "id,name\ncustomer-1,Ada\ncustomer-2,Grace\n",
      }),
      Object.freeze({
        memberKey: "object:Order",
        kind: "object" as const,
        resourceId: commerceIds.orderResource,
        revisionId: commerceIds.orderRevision,
        definition: orderType,
        schemaRevisionId: commerceIds.orderSchemaRevision,
        schema: objectSchema(),
        mappingRevisionId: commerceIds.orderMappingRevision,
        mapping: objectMapping({
          schemaRevisionId: commerceIds.orderSchemaRevision,
          targetResourceId: commerceIds.orderResource,
          targetRevisionId: commerceIds.orderRevision,
        }),
        csv: "id,name\norder-1,Analytical Engine\norder-2,Compiler\n",
      }),
      Object.freeze({
        memberKey: "link:CustomerPlacedOrder",
        kind: "link" as const,
        resourceId: commerceIds.linkResource,
        revisionId: commerceIds.linkRevision,
        definition: commerceLinkType,
        schemaRevisionId: commerceIds.linkSchemaRevision,
        schema: linkSchema("customerId", "orderId"),
        mappingRevisionId: commerceIds.linkMappingRevision,
        mapping: linkMapping({
          schemaRevisionId: commerceIds.linkSchemaRevision,
          targetResourceId: commerceIds.linkResource,
          targetRevisionId: commerceIds.linkRevision,
          sourceRevisionId: commerceIds.customerRevision,
          sourceColumn: "customerId",
          targetRevisionIdForKey: commerceIds.orderRevision,
          targetColumn: "orderId",
        }),
        sourceObject: Object.freeze({
          resourceId: commerceIds.customerResource,
          revisionId: commerceIds.customerRevision,
          definition: customerType,
        }),
        targetObject: Object.freeze({
          resourceId: commerceIds.orderResource,
          revisionId: commerceIds.orderRevision,
          definition: orderType,
        }),
        csv: "customerId,orderId\ncustomer-1,order-1\ncustomer-2,order-2\n",
      }),
    ]),
  }),
  Object.freeze({
    id: "work-management",
    namespace: "fixture.work",
    sourcePath: "spikes/g1/packages/work-management/package.json",
    sourceSha256: "dcae4da2aea7d9446989d54445c976158c9356095b9eb53d92d9b32f102944da",
    members: Object.freeze([
      Object.freeze({
        memberKey: "object:Worker",
        kind: "object" as const,
        resourceId: workIds.workerResource,
        revisionId: workIds.workerRevision,
        definition: workerType,
        schemaRevisionId: workIds.workerSchemaRevision,
        schema: objectSchema(),
        mappingRevisionId: workIds.workerMappingRevision,
        mapping: objectMapping({
          schemaRevisionId: workIds.workerSchemaRevision,
          targetResourceId: workIds.workerResource,
          targetRevisionId: workIds.workerRevision,
        }),
        csv: "id,name\nworker-1,Lin\nworker-2,Margaret\n",
      }),
      Object.freeze({
        memberKey: "object:WorkItem",
        kind: "object" as const,
        resourceId: workIds.itemResource,
        revisionId: workIds.itemRevision,
        definition: workItemType,
        schemaRevisionId: workIds.itemSchemaRevision,
        schema: objectSchema(),
        mappingRevisionId: workIds.itemMappingRevision,
        mapping: objectMapping({
          schemaRevisionId: workIds.itemSchemaRevision,
          targetResourceId: workIds.itemResource,
          targetRevisionId: workIds.itemRevision,
        }),
        csv: "id,name\nwork-1,Design\nwork-2,Verify\n",
      }),
      Object.freeze({
        memberKey: "link:WorkerAssignedWorkItem",
        kind: "link" as const,
        resourceId: workIds.linkResource,
        revisionId: workIds.linkRevision,
        definition: workLinkType,
        schemaRevisionId: workIds.linkSchemaRevision,
        schema: linkSchema("workerId", "workItemId"),
        mappingRevisionId: workIds.linkMappingRevision,
        mapping: linkMapping({
          schemaRevisionId: workIds.linkSchemaRevision,
          targetResourceId: workIds.linkResource,
          targetRevisionId: workIds.linkRevision,
          sourceRevisionId: workIds.workerRevision,
          sourceColumn: "workerId",
          targetRevisionIdForKey: workIds.itemRevision,
          targetColumn: "workItemId",
        }),
        sourceObject: Object.freeze({
          resourceId: workIds.workerResource,
          revisionId: workIds.workerRevision,
          definition: workerType,
        }),
        targetObject: Object.freeze({
          resourceId: workIds.itemResource,
          revisionId: workIds.itemRevision,
          definition: workItemType,
        }),
        csv: "workerId,workItemId\nworker-1,work-1\nworker-2,work-2\n",
      }),
    ]),
  }),
]);

export const MATERIALIZATION_NEGATIVE_FIXTURES = Object.freeze({
  badCsv: Object.freeze({
    id: "bad_csv_unclosed_quote",
    memberKey: "object:Customer",
    csv: 'id,name\ncustomer-1,"Ada\n',
    expectedCode: "CSV_TRUNCATED_QUOTE",
  }),
  primaryKeyCollision: Object.freeze({
    id: "primary_key_collision",
    memberKey: "object:Customer",
    csv: "id,name\ncustomer-1,Ada\ncustomer-1,Grace\n",
    expectedReasonCode: "PRIMARY_KEY_DUPLICATE",
  }),
  danglingLink: Object.freeze({
    id: "required_link_dangling",
    memberKey: "link:CustomerPlacedOrder",
    csv: "customerId,orderId\nmissing-customer,order-1\n",
    expectedReasonCode: "REQUIRED_LINK_DANGLING",
  }),
  qualityThreshold: Object.freeze({
    id: "quality_threshold_exceeded",
    observedRows: 10_000,
    optionalFailures: 101,
    maximumBasisPoints: 100,
    expectedOutcome: "failed",
  }),
});

export const MATERIALIZATION_CONCURRENT_DELTA_FIXTURE = Object.freeze({
  schemaVersion: 1,
  contractVersion: "materialization-overlay-adversarial-port-v1",
  mode: "ADVERSARIAL_TEST_ONLY",
  w0: 41,
  w1: 43,
  stagedHead: Object.freeze({ objectRid: "Customer:customer-1", name: "Ada" }),
  deltas: Object.freeze([
    Object.freeze({ sequence: 42, objectRid: "Customer:customer-1", name: "Ada Updated" }),
    Object.freeze({ sequence: 43, objectRid: "Customer:customer-2", name: "Grace Updated" }),
  ]),
  expectedHeads: Object.freeze([
    Object.freeze({ objectRid: "Customer:customer-1", name: "Ada Updated" }),
    Object.freeze({ objectRid: "Customer:customer-2", name: "Grace Updated" }),
  ]),
  productionOverlayClaim: "ZERO_ONLY",
  realOverlayOwningGate: "G2-04",
});

export const MATERIALIZATION_BENCHMARK_FIXTURE = Object.freeze({
  schemaVersion: 1,
  contractVersion: MATERIALIZATION_FIXTURE_VERSION,
  generatorVersion: "testkit-dataset-v1",
  config: DATASET_PRESETS.benchmark,
  expectedDatasetDigest: "sha256:4cf9491ef477c7c98c9fba693dd3028100cc7f419bf8f7c53eac1fd1d6328446",
});
