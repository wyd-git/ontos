import { createHash } from "node:crypto";

import {
  canonicalizeContractForDigest,
  parseArtifactDigest,
  type ArtifactDigest,
} from "@ontos/contracts";
import {
  compileMapping,
  type CompileMappingInput,
  type CompiledMappingPlan,
} from "@ontos/materialization-domain";

export const ids = Object.freeze({
  mappingRevision: "11111111-1111-4111-8111-111111111111",
  schemaRevision: "22222222-2222-4222-8222-222222222222",
  objectResource: "33333333-3333-4333-8333-333333333333",
  objectRevision: "44444444-4444-4444-8444-444444444444",
  linkResource: "55555555-5555-4555-8555-555555555555",
  linkRevision: "66666666-6666-4666-8666-666666666666",
  orderResource: "77777777-7777-4777-8777-777777777777",
  orderRevision: "88888888-8888-4888-8888-888888888888",
});

export const objectSchema = Object.freeze({
  schemaVersion: 1,
  contractVersion: "snapshot-schema-v1",
  format: "csv_utf8",
  headerRow: true,
  columns: Object.freeze([
    { ordinal: 0, columnApiName: "id", valueType: "string", required: true },
    { ordinal: 1, columnApiName: "firstName", valueType: "string", required: true },
    { ordinal: 2, columnApiName: "lastName", valueType: "string", required: true },
    { ordinal: 3, columnApiName: "amountText", valueType: "string", required: false },
    { ordinal: 4, columnApiName: "count", valueType: "integer", required: true },
    { ordinal: 5, columnApiName: "createdDate", valueType: "date", required: true },
    { ordinal: 6, columnApiName: "enabled", valueType: "boolean", required: true },
    { ordinal: 7, columnApiName: "eventAt", valueType: "timestamp", required: true },
    { ordinal: 8, columnApiName: "payload", valueType: "json", required: false },
    {
      ordinal: 9,
      columnApiName: "status",
      valueType: "enum",
      required: true,
      enumValues: Object.freeze(["ACTIVE", "INACTIVE"]),
    },
    { ordinal: 10, columnApiName: "tags", valueType: "string[]", required: false },
    { ordinal: 11, columnApiName: "sensitiveCode", valueType: "string", required: false },
  ]),
});

export const customerObjectType = Object.freeze({
  schemaVersion: 1,
  apiName: "Customer",
  displayName: "Customer",
  description: "Deterministic Mapping customer fixture.",
  primaryKeyPropertyApiName: "id",
  titlePropertyApiName: "displayName",
  defaultSearchPropertyApiNames: Object.freeze(["displayName"]),
  defaultSort: Object.freeze([{ propertyApiName: "id", direction: "asc" }]),
  defaultClassification: "internal",
  properties: Object.freeze([
    property("id", "string", false, { caseSensitive: false, unique: true }),
    property("displayName", "string", false, { caseSensitive: true, searchable: true }),
    property("amount", "decimal", true, { decimalPrecision: 12, decimalScale: 2 }),
    property("count", "integer", false),
    property("createdDate", "date", false),
    property("enabled", "boolean", false),
    property("eventAt", "timestamp", false),
    property("payload", "json", true),
    property("secret", "string", true, {
      caseSensitive: true,
      classification: "restricted",
    }),
    property("status", "enum", false, { enumValues: Object.freeze(["ACTIVE", "INACTIVE"]) }),
    property("tags", "string[]", true),
  ]),
});

export const objectMapping = Object.freeze({
  schemaVersion: 1,
  mappingVersion: "mapping-v1",
  targetKind: "object",
  inputSchemaRevisionId: ids.schemaRevision,
  targetResourceId: ids.objectResource,
  targetRevisionId: ids.objectRevision,
  valueCodecVersion: "pk1",
  propertyMappings: Object.freeze([
    {
      propertyApiName: "amount",
      required: false,
      nullPolicy: "allow",
      expression: {
        op: "cast",
        input: { op: "column", columnApiName: "amountText" },
        targetValueType: "decimal",
        codecVersion: "pk1",
      },
    },
    {
      propertyApiName: "count",
      required: true,
      nullPolicy: "reject_row",
      expression: { op: "column", columnApiName: "count" },
    },
    {
      propertyApiName: "createdDate",
      required: true,
      nullPolicy: "reject_row",
      expression: { op: "column", columnApiName: "createdDate" },
    },
    {
      propertyApiName: "displayName",
      required: true,
      nullPolicy: "reject_row",
      expression: {
        op: "concat",
        inputs: Object.freeze([
          { op: "column", columnApiName: "firstName" },
          { op: "column", columnApiName: "lastName" },
        ]),
        separator: " ",
      },
    },
    {
      propertyApiName: "enabled",
      required: true,
      nullPolicy: "reject_row",
      expression: { op: "column", columnApiName: "enabled" },
    },
    {
      propertyApiName: "eventAt",
      required: true,
      nullPolicy: "reject_row",
      expression: { op: "column", columnApiName: "eventAt" },
    },
    {
      propertyApiName: "payload",
      required: false,
      nullPolicy: "allow",
      expression: { op: "column", columnApiName: "payload" },
    },
    {
      propertyApiName: "secret",
      required: false,
      nullPolicy: "reject_row",
      expression: { op: "column", columnApiName: "sensitiveCode" },
    },
    {
      propertyApiName: "status",
      required: true,
      nullPolicy: "reject_row",
      expression: { op: "column", columnApiName: "status" },
    },
    {
      propertyApiName: "tags",
      required: false,
      nullPolicy: "allow",
      expression: { op: "column", columnApiName: "tags" },
    },
  ]),
  primaryKeyExpression: { op: "column", columnApiName: "id" },
  qualityRules: qualityRules(),
});

export const orderObjectType = Object.freeze({
  ...customerObjectType,
  apiName: "Order",
  displayName: "Order",
  description: "Deterministic Mapping order fixture.",
  primaryKeyPropertyApiName: "orderId",
  titlePropertyApiName: "orderId",
  defaultSearchPropertyApiNames: Object.freeze([]),
  defaultSort: Object.freeze([{ propertyApiName: "orderId", direction: "asc" }]),
  properties: Object.freeze([
    property("orderId", "string", false, { caseSensitive: true, unique: true }),
  ]),
});

export const linkSchema = Object.freeze({
  schemaVersion: 1,
  contractVersion: "snapshot-schema-v1",
  format: "csv_utf8",
  headerRow: true,
  columns: Object.freeze([
    { ordinal: 0, columnApiName: "customerId", valueType: "string", required: true },
    { ordinal: 1, columnApiName: "orderId", valueType: "string", required: true },
  ]),
});

export const orderCustomerLinkType = Object.freeze({
  schemaVersion: 1,
  apiName: "CustomerOrder",
  displayName: "Customer Order",
  description: "Deterministic Mapping Link fixture.",
  source: {
    objectTypeRevisionId: ids.objectRevision,
    apiName: "customer",
    displayName: "Customer",
  },
  target: {
    objectTypeRevisionId: ids.orderRevision,
    apiName: "order",
    displayName: "Order",
  },
  cardinality: "one_to_many",
  sourceKind: "base",
  deletionBehavior: "restrict",
  actionCreateAllowed: false,
  actionDeleteAllowed: false,
});

export const linkMapping = Object.freeze({
  schemaVersion: 1,
  mappingVersion: "mapping-v1",
  targetKind: "link",
  inputSchemaRevisionId: ids.schemaRevision,
  targetResourceId: ids.linkResource,
  targetRevisionId: ids.linkRevision,
  valueCodecVersion: "pk1",
  propertyMappings: Object.freeze([]),
  sourceKeyMapping: {
    objectTypeRevisionId: ids.objectRevision,
    expression: { op: "column", columnApiName: "customerId" },
    codecVersion: "pk1",
  },
  targetKeyMapping: {
    objectTypeRevisionId: ids.orderRevision,
    expression: { op: "column", columnApiName: "orderId" },
    codecVersion: "pk1",
  },
  qualityRules: qualityRules(),
});

export function digestCanonicalText(canonicalText: string): ArtifactDigest {
  return parseArtifactDigest(
    `sha256:${createHash("sha256").update(canonicalText, "utf8").digest("hex")}`,
  );
}

export function definitionDigest(value: unknown): ArtifactDigest {
  return digestCanonicalText(canonicalizeContractForDigest(value));
}

export function objectCompileInput(
  overrides: Partial<CompileMappingInput> = {},
): CompileMappingInput {
  return {
    mappingRevisionId: ids.mappingRevision,
    mappingRevisionDigest: definitionDigest(objectMapping),
    mapping: objectMapping,
    inputSchemaRevisionId: ids.schemaRevision,
    inputSchemaDigest: definitionDigest(objectSchema),
    inputSchema: objectSchema,
    target: {
      kind: "object",
      resourceId: ids.objectResource,
      revisionId: ids.objectRevision,
      definitionDigest: definitionDigest(customerObjectType),
      definition: customerObjectType,
    },
    ...overrides,
  };
}

export function linkCompileInput(
  overrides: Partial<CompileMappingInput> = {},
): CompileMappingInput {
  return {
    mappingRevisionId: ids.mappingRevision,
    mappingRevisionDigest: definitionDigest(linkMapping),
    mapping: linkMapping,
    inputSchemaRevisionId: ids.schemaRevision,
    inputSchemaDigest: definitionDigest(linkSchema),
    inputSchema: linkSchema,
    target: {
      kind: "link",
      resourceId: ids.linkResource,
      revisionId: ids.linkRevision,
      definitionDigest: definitionDigest(orderCustomerLinkType),
      definition: orderCustomerLinkType,
      sourceObject: {
        resourceId: ids.objectResource,
        revisionId: ids.objectRevision,
        definitionDigest: definitionDigest(customerObjectType),
        definition: customerObjectType,
      },
      targetObject: {
        resourceId: ids.orderResource,
        revisionId: ids.orderRevision,
        definitionDigest: definitionDigest(orderObjectType),
        definition: orderObjectType,
      },
    },
    ...overrides,
  };
}

export function compileObjectFixture(): CompiledMappingPlan {
  return compileMapping(objectCompileInput(), digestCanonicalText);
}

export function compileLinkFixture(): CompiledMappingPlan {
  return compileMapping(linkCompileInput(), digestCanonicalText);
}

export function validObjectRow(id = "customer-1"): readonly string[] {
  return Object.freeze([
    id,
    "Ada",
    "Lovelace",
    "123.40",
    "9223372036854775807",
    "2024-02-29",
    "true",
    "2026-08-15T20:01:02.123456+08:00",
    '{"b":2,"a":1.5}',
    "ACTIVE",
    '["alpha","界"]',
    "classified",
  ]);
}

function property(
  apiName: string,
  valueType: string,
  nullable: boolean,
  options: Readonly<Record<string, unknown>> = {},
) {
  return Object.freeze({
    schemaVersion: 1,
    apiName,
    displayName: apiName,
    description: `${apiName} fixture property.`,
    valueType,
    nullable,
    writeMode: "source_only",
    unique: false,
    filterable: valueType !== "json",
    sortable: valueType !== "json" && valueType !== "string[]",
    searchable: false,
    classification: "internal",
    ...options,
  });
}

function qualityRules() {
  return Object.freeze({
    primaryKeyNullMaximumCount: 0,
    primaryKeyDuplicateMaximumCount: 0,
    requiredPropertyFailureMaximumCount: 0,
    requiredLinkDanglingMaximumCount: 0,
    optionalPropertyFailureMaximumBasisPoints: 10,
    optionalLinkDanglingMaximumBasisPoints: 10,
    rowCountChangeConfirmationBasisPoints: 1000,
    optionalFailureDisposition: "reject_row",
  });
}
