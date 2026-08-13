import type { ArtifactHandler } from "../artifact-api.ts";

export const invoke: ArtifactHandler = async (context, parameters) => {
  const objectRid = parameters.objectRid;
  if (typeof objectRid !== "string") throw new Error("validated objectRid is missing");
  const result = await context.query({
    queryName: "object.get",
    objectRid,
    properties: ["status", "priority"],
  });
  return {
    objectRid: result.objectRid,
    objectVersion: result.objectVersion,
    properties: result.properties,
  };
};
