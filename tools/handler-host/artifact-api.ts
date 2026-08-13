import type { JsonObject, JsonValue } from "./protocol.ts";

export interface ArtifactQuery {
  readonly queryName: string;
  readonly objectRid: string;
  readonly properties: readonly string[];
}

export interface ArtifactQueryResult {
  readonly objectRid: string;
  readonly objectVersion: string;
  readonly properties: JsonObject;
}

export interface RestrictedHandlerContext {
  query(request: ArtifactQuery): Promise<ArtifactQueryResult>;
}

export type ArtifactHandler = (
  context: RestrictedHandlerContext,
  parameters: JsonObject,
) => JsonValue | Promise<JsonValue>;

export interface ArtifactModule {
  readonly invoke: ArtifactHandler;
}
