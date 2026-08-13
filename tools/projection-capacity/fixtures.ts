import type {
  GenerationFootprintInput,
  GenerationReferenceRoot,
  ReleaseServingSet,
} from "./capacity.ts";
import type { ObjectTypeIndexPlanInput, ReleaseIndexPlanInput } from "./index-plan.ts";

export const capacityProjectId = "project-capacity";

export function g1ShapedObjectType(
  resourceId: string,
  revisionId: string,
): ObjectTypeIndexPlanInput {
  return {
    resourceId,
    revisionId,
    displayName: `Display ${resourceId}`,
    properties: [
      {
        propertyId: "id",
        type: "string",
        primaryKey: true,
        filterable: true,
        sortable: true,
      },
      {
        propertyId: "name",
        type: "string",
        filterable: true,
        sortable: true,
        searchable: true,
      },
      { propertyId: "status", type: "enum", filterable: true },
      { propertyId: "updatedAt", type: "timestamp", sortable: true },
      { propertyId: "amount", type: "decimal", filterable: true, sortable: true },
      { propertyId: "region", type: "enum", filterable: true },
      { propertyId: "tags", type: "string[]", filterable: true },
      { propertyId: "sensitiveCode", type: "string" },
    ],
    indexes: [
      btree("name"),
      { kind: "gin_trigram", propertyId: "name", evidenceRefs: ["query:name-search"] },
      btree("status"),
      btree("updatedAt", "DESC"),
      btree("amount"),
      btree("region"),
      { kind: "gin_array", propertyId: "tags", evidenceRefs: ["query:tags"] },
    ],
  };
}

export function g1ShapedReleaseIndexPlan(
  releaseId: string,
  revisionLabel: string,
  objectTypeCount = 5,
): ReleaseIndexPlanInput {
  const objectTypes = Array.from({ length: objectTypeCount }, (_, index) =>
    g1ShapedObjectType(`object-type-${index + 1}`, `${revisionLabel}-${index + 1}`),
  );
  return {
    projectId: capacityProjectId,
    releaseId,
    evidenceCatalog: [
      ...new Set(
        objectTypes.flatMap((objectType) =>
          objectType.indexes.flatMap((index) => index.evidenceRefs),
        ),
      ),
    ],
    objectTypes,
  };
}

export function fullProjectionCohort(
  label: string,
  input: {
    state?: GenerationFootprintInput["state"];
    createdAt?: number;
    leftServingAt?: number | null;
    derivedRecentSuccessful?: boolean;
    roots?: readonly GenerationReferenceRoot[];
  } = {},
): GenerationFootprintInput[] {
  const common = {
    projectId: capacityProjectId,
    state: input.state ?? "READY",
    createdAt: input.createdAt ?? 0,
    leftServingAt: input.leftServingAt ?? null,
    derivedRecentSuccessful: input.derivedRecentSuccessful ?? false,
    roots: input.roots ?? [],
  };
  return [
    {
      ...common,
      id: `${label}:objects`,
      objectTypes: Array.from({ length: 5 }, (_, index) => ({
        resourceId: `object-type-${index + 1}`,
        rows: 20_000n,
        secondaryIndexUnitsPerRow: 13n,
      })),
      linkRows: 0n,
    },
    {
      ...common,
      id: `${label}:links`,
      objectTypes: [],
      linkRows: 1_000_000n,
    },
  ];
}

export function servingCohort(
  releaseId: string,
  at = 0,
): { generations: GenerationFootprintInput[]; servingSet: ReleaseServingSet } {
  const generations = fullProjectionCohort(releaseId, {
    createdAt: at,
    roots: [{ kind: "SERVING_HEAD", id: `head:${releaseId}`, releaseId }],
  });
  return {
    generations,
    servingSet: {
      releaseId,
      generationIds: generations.map((generation) => generation.id),
    },
  };
}

function btree(propertyId: string, direction: "ASC" | "DESC" = "ASC") {
  return {
    kind: "btree" as const,
    keys: [{ propertyId, direction }],
    evidenceRefs: [`query:${propertyId}`],
  };
}
