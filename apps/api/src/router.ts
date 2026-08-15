import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import { parseIdempotencyKey } from "@ontos/contracts";
import type { MaterializationIngressService } from "@ontos/materialization-application";
import type {
  MetadataApplicationService,
  PackageLifecycleApplicationService,
  ReleaseLifecycleApplicationService,
  ResourceLifecycleApplicationService,
  VerifiedFoundationIdentity,
} from "@ontos/metadata-application";

import { assertEmptyActionBody, readJsonBody } from "./body.ts";
import type { AdminCursorCodec } from "./cursor.ts";
import { HttpProblem, correlationIdFromHeader, writeErrorResponse, writeJson } from "./errors.ts";
import type { FoundationAuthenticator } from "./oidc.ts";

export interface AdminApiServices {
  readonly metadata: Pick<
    MetadataApplicationService,
    "createProject" | "getProject" | "listRoleBindings" | "replaceRoleBinding"
  >;
  readonly resources: Pick<
    ResourceLifecycleApplicationService,
    | "createResource"
    | "getResource"
    | "listResources"
    | "getRevision"
    | "patchDraftRevision"
    | "createChildDraftForResource"
    | "validateRevision"
    | "getRevisionValidationReport"
    | "compareRevisionCompatibility"
  >;
  readonly releases: Pick<
    ReleaseLifecycleApplicationService,
    | "createRelease"
    | "getRelease"
    | "validateRelease"
    | "stageRelease"
    | "publishRelease"
    | "rollbackRelease"
  >;
  readonly packages: Pick<
    PackageLifecycleApplicationService,
    "validatePackage" | "installPackage" | "upgradePackageInstallation" | "rollbackPackage"
  >;
  readonly materialization: Pick<
    MaterializationIngressService,
    "createUploadSession" | "uploadSessionContent" | "finalizeSnapshotGroup"
  >;
}

export interface AdminRequestHandlerOptions {
  readonly authenticator: FoundationAuthenticator;
  readonly cursors: AdminCursorCodec;
  readonly services: AdminApiServices;
}

interface RouteResponse {
  readonly status: number;
  readonly value: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const rootSegments = ["api", "v1", "admin"] as const;

export function createAdminRequestHandler(options: AdminRequestHandlerOptions): RequestListener {
  return (request, response) => {
    void dispatchRequest(options, request, response);
  };
}

async function dispatchRequest(
  options: AdminRequestHandlerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const correlationId = correlationIdFromHeader(request.headers["x-correlation-id"]);
  try {
    const identity = await options.authenticator.authenticateAuthorizationHeader(
      request.headers.authorization,
    );
    const routed = await route(options.services, options.cursors, identity, request);
    writeJson(response, routed.status, routed.value, correlationId, routed.headers ?? {});
  } catch (error) {
    if (!response.headersSent) writeErrorResponse(response, correlationId, error);
    else response.destroy();
  }
}

async function route(
  services: AdminApiServices,
  cursors: AdminCursorCodec,
  identity: VerifiedFoundationIdentity,
  request: IncomingMessage,
): Promise<RouteResponse> {
  const method = request.method ?? "";
  const url = requestUrl(request);
  const segments = pathSegments(url);
  if (!rootSegments.every((value, index) => segments[index] === value)) throw routeNotFound();
  const path = segments.slice(rootSegments.length);

  if (method === "POST" && equalPath(path, ["snapshot-upload-sessions"])) {
    requireNoQuery(url);
    const body = strictBody(await readJsonBody(request), [
      "projectId",
      "releaseId",
      "targetMemberKey",
      "groupVersion",
      "expectedByteCount",
      "sourceLabel",
    ]);
    return created(await services.materialization.createUploadSession(identity, body));
  }

  if (
    method === "PUT" &&
    path[0] === "snapshot-upload-sessions" &&
    path[2] === "content" &&
    path.length === 3
  ) {
    requireNoQuery(url);
    const sessionId = requireSegment(path[1]);
    return ok(
      await services.materialization.uploadSessionContent(identity, {
        sessionId,
        contentLength: requiredContentLength(request),
        mediaType: request.headers["content-type"],
        contentEncoding: request.headers["content-encoding"] ?? null,
        body: request,
      }),
    );
  }

  if (method === "POST" && equalPath(path, ["snapshots"])) {
    requireNoQuery(url);
    const body = strictBody(await readJsonBody(request), ["projectId", "sessions"]);
    return created(await services.materialization.finalizeSnapshotGroup(identity, body));
  }

  if (method === "POST" && equalPath(path, ["projects"])) {
    requireNoQuery(url);
    const body = strictBody(await readJsonBody(request), ["apiName", "displayName"]);
    const result = await services.metadata.createProject(identity, body);
    return created(result, { etag: strongEtag(result.authorizationEpoch) });
  }

  if (path[0] === "projects" && path.length >= 2) {
    const projectId = requireSegment(path[1]);
    if (method === "GET" && path.length === 2) {
      requireNoQuery(url);
      const result = await services.metadata.getProject(identity, { projectId });
      return ok(result, { etag: strongEtag(result.authorizationEpoch) });
    }
    if (path[2] === "resources" && path.length === 3) {
      if (method === "POST") {
        requireNoQuery(url);
        const body = strictBody(await readJsonBody(request), [
          "namespace",
          "apiName",
          "family",
          "content",
        ]);
        const result = await services.resources.createResource(identity, { projectId, ...body });
        return created(result, { etag: strongEtag(result.initialDraft.etag) });
      }
      if (method === "GET") {
        const query = queryRecord(url, ["limit", "cursor"]);
        const limit = pageLimit(query["limit"]);
        const after =
          query["cursor"] === undefined ? null : cursors.decodeResource(projectId, query["cursor"]);
        const page = await services.resources.listResources(identity, {
          projectId,
          limit,
          ...(after === null ? {} : { after }),
        });
        return ok({
          items: page.items,
          nextCursor:
            page.nextCursor === null ? null : cursors.encodeResource(projectId, page.nextCursor),
        });
      }
    }
    if (method === "POST" && path[2] === "releases" && path.length === 3) {
      requireNoQuery(url);
      const body = strictBody(await readJsonBody(request), ["targetChannelName", "revisionIds"]);
      return created(await services.releases.createRelease(identity, { projectId, ...body }));
    }
    if (path[2] === "package-installations" && path.length === 3 && method === "POST") {
      requireNoQuery(url);
      const body = strictBody(await readJsonBody(request), [
        "targetChannelName",
        "manifest",
        "resources",
        "installInputBindings",
      ]);
      const requestKey = requiredIdempotencyKey(request);
      return accepted(
        await services.packages.installPackage(identity, { projectId, requestKey, ...body }),
      );
    }
    if (path[2] === "role-bindings" && path.length === 3) {
      if (method === "GET") {
        requireNoQuery(url);
        const result = await services.metadata.listRoleBindings(identity, { projectId });
        return ok(result, { etag: strongEtag(result.authorizationEpoch) });
      }
      if (method === "PUT") {
        requireNoQuery(url);
        const body = strictBody(
          await readJsonBody(request),
          ["targetPrincipalId", "role"],
          ["resourceId"],
        );
        const result = await services.metadata.replaceRoleBinding(identity, {
          projectId,
          ...body,
          expectedEpoch: requiredIfMatch(request),
        });
        return ok(result, { etag: strongEtag(result.authorizationEpoch) });
      }
    }
  }

  if (path[0] === "resources" && path.length >= 2) {
    const resourceId = requireSegment(path[1]);
    if (method === "GET" && path.length === 2) {
      requireNoQuery(url);
      return ok(await services.resources.getResource(identity, { resourceId }));
    }
    if (method === "POST" && path[2] === "revisions" && path.length === 3) {
      requireNoQuery(url);
      const body = strictBody(await readJsonBody(request), ["sourceRevisionId", "content"]);
      const result = await services.resources.createChildDraftForResource(identity, {
        resourceId,
        ...body,
      });
      return created(result, { etag: strongEtag(result.etag) });
    }
  }

  if (path[0] === "revisions" && path.length >= 2) {
    const revisionId = requireSegment(path[1]);
    if (path.length === 2) {
      if (method === "GET") {
        requireNoQuery(url);
        const result = await services.resources.getRevision(identity, { revisionId });
        return ok(result, { etag: strongEtag(result.etag) });
      }
      if (method === "PATCH") {
        requireNoQuery(url);
        const body = strictBody(await readJsonBody(request), ["content"]);
        const result = await services.resources.patchDraftRevision(identity, {
          revisionId,
          expectedEtag: requiredIfMatch(request),
          ...body,
        });
        return ok(result, { etag: strongEtag(result.etag) });
      }
    }
    if (method === "POST" && path[2] === "validate" && path.length === 3) {
      requireNoQuery(url);
      await assertEmptyActionBody(request);
      return ok(await services.resources.validateRevision(identity, { revisionId }));
    }
    if (method === "GET" && path[2] === "validation-report" && path.length === 3) {
      requireNoQuery(url);
      return ok(await services.resources.getRevisionValidationReport(identity, { revisionId }));
    }
    if (method === "GET" && path[2] === "diff" && path.length === 3) {
      const query = queryRecord(url, ["against"]);
      const againstRevisionId = query["against"];
      if (againstRevisionId === undefined) throw invalidRequest("against is required.");
      return ok(
        await services.resources.compareRevisionCompatibility(identity, {
          revisionId,
          againstRevisionId,
        }),
      );
    }
  }

  if (path[0] === "releases" && path.length >= 2) {
    const releaseId = requireSegment(path[1]);
    if (method === "GET" && path.length === 2) {
      requireNoQuery(url);
      return ok(await services.releases.getRelease(identity, { releaseId }));
    }
    if (method === "POST" && path.length === 3) {
      requireNoQuery(url);
      const action = path[2];
      if (action === "validate") {
        await assertEmptyActionBody(request);
        return ok(await services.releases.validateRelease(identity, { releaseId }));
      }
      if (action === "stage") {
        await assertEmptyActionBody(request);
        return ok(await services.releases.stageRelease(identity, { releaseId }));
      }
      if (action === "publish" || action === "rollback") {
        const body = strictBody(await readJsonBody(request), ["expectedChannelControlSequence"]);
        const expectedChannelControlSequence = decimalBigint(
          body["expectedChannelControlSequence"],
          true,
        );
        const command = { releaseId, expectedChannelControlSequence };
        return ok(
          action === "publish"
            ? await services.releases.publishRelease(identity, command)
            : await services.releases.rollbackRelease(identity, command),
        );
      }
    }
  }

  if (method === "POST" && equalPath(path, ["packages", "validate"])) {
    requireNoQuery(url);
    const body = strictBody(await readJsonBody(request), [
      "projectId",
      "manifest",
      "resources",
      "installInputBindings",
    ]);
    return ok(await services.packages.validatePackage(identity, body));
  }

  if (path[0] === "package-installations" && path.length === 3 && method === "POST") {
    requireNoQuery(url);
    const installationId = requireSegment(path[1]);
    const requestKey = requiredIdempotencyKey(request);
    if (path[2] === "upgrade") {
      const body = strictBody(await readJsonBody(request), [
        "targetChannelName",
        "manifest",
        "resources",
        "installInputBindings",
      ]);
      return accepted(
        await services.packages.upgradePackageInstallation(identity, {
          installationId,
          requestKey,
          ...body,
        }),
      );
    }
    if (path[2] === "rollback") {
      const body = strictBody(await readJsonBody(request), [
        "targetPackageRevisionId",
        "targetChannelName",
      ]);
      return accepted(
        await services.packages.rollbackPackage(identity, {
          installationId,
          requestKey,
          ...body,
        }),
      );
    }
  }

  throw routeNotFound();
}

function requestUrl(request: IncomingMessage): URL {
  const value = request.url;
  if (value === undefined || value.length > 4_096) throw invalidRequest("URL is invalid.");
  try {
    return new URL(value, "http://admin.invalid");
  } catch (error) {
    throw invalidRequest("URL is invalid.", error);
  }
}

function pathSegments(url: URL): readonly string[] {
  if (url.pathname.endsWith("/") && url.pathname !== "/") throw routeNotFound();
  try {
    return url.pathname
      .split("/")
      .filter((value) => value.length > 0)
      .map((value) => {
        const decoded = decodeURIComponent(value);
        if (decoded.includes("/") || decoded.includes("\\") || decoded.length === 0) {
          throw routeNotFound();
        }
        return decoded;
      });
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    throw invalidRequest("URL path is invalid.", error);
  }
}

function queryRecord(url: URL, allowed: readonly string[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const allowedSet = new Set(allowed);
  for (const [key, value] of url.searchParams) {
    if (!allowedSet.has(key) || Object.hasOwn(result, key)) {
      throw invalidRequest("Query parameters are invalid.");
    }
    if (value.length > 2_048) throw invalidRequest("Query parameter is too long.");
    result[key] = value;
  }
  return Object.freeze(result);
}

function requireNoQuery(url: URL): void {
  if (url.search.length !== 0)
    throw invalidRequest("This endpoint does not accept query parameters.");
}

function strictBody(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) throw invalidRequest("JSON body must be an object.");
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw invalidRequest("JSON body contains missing or unsupported fields.");
  }
  return value;
}

function requiredIfMatch(request: IncomingMessage): bigint {
  const value = request.headers["if-match"];
  const match = typeof value === "string" ? /^"([1-9][0-9]{0,19})"$/u.exec(value) : null;
  if (match?.[1] === undefined) throw invalidRequest("A strong If-Match value is required.");
  return decimalBigint(match[1], false);
}

function requiredIdempotencyKey(request: IncomingMessage): string {
  const value = request.headers["idempotency-key"];
  try {
    return parseIdempotencyKey(value, "$headers.idempotency-key");
  } catch (error) {
    throw invalidRequest("A valid Idempotency-Key header is required.", error);
  }
}

function requiredContentLength(request: IncomingMessage): number {
  const value = request.headers["content-length"];
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw invalidRequest("A valid Content-Length header is required.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidRequest("A valid Content-Length header is required.");
  }
  return parsed;
}

function pageLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  if (!/^[1-9][0-9]{0,2}$/u.test(value)) throw invalidRequest("limit is invalid.");
  const parsed = Number(value);
  if (parsed > 100) throw invalidRequest("limit is invalid.");
  return parsed;
}

function decimalBigint(value: unknown, allowZero: boolean): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) {
    throw invalidRequest("Sequence value is invalid.");
  }
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > 9_223_372_036_854_775_807n) {
    throw invalidRequest("Sequence value is invalid.");
  }
  return parsed;
}

function strongEtag(value: bigint): string {
  return `"${value.toString()}"`;
}

function requireSegment(value: string | undefined): string {
  if (value === undefined || value.length > 160) throw routeNotFound();
  return value;
}

function equalPath(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function ok(value: unknown, headers?: Readonly<Record<string, string>>): RouteResponse {
  return { status: 200, value, ...(headers === undefined ? {} : { headers }) };
}

function created(value: unknown, headers?: Readonly<Record<string, string>>): RouteResponse {
  return { status: 201, value, ...(headers === undefined ? {} : { headers }) };
}

function accepted(value: unknown): RouteResponse {
  return { status: 202, value };
}

function routeNotFound(): HttpProblem {
  return new HttpProblem({
    status: 404,
    code: "ADMIN_ENDPOINT_NOT_FOUND",
    message: "The administrator endpoint does not exist.",
    category: "not_found",
  });
}

function invalidRequest(message: string, cause?: unknown): HttpProblem {
  return new HttpProblem({
    status: 400,
    code: "ADMIN_REQUEST_INVALID",
    message: cause === undefined ? message : "The administrator request is invalid.",
    category: "validation",
  });
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
