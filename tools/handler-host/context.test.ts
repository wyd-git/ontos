import assert from "node:assert/strict";
import test from "node:test";

import { FIXTURE_ARTIFACT_DIGESTS, getRegisteredArtifact } from "./catalog.ts";
import { createRestrictedContext, HandlerBoundaryError } from "./context.ts";
import type { InvocationContextData } from "./protocol.ts";

const queryRegistration = getRegisteredArtifact(FIXTURE_ARTIFACT_DIGESTS.queryObject);
if (queryRegistration === undefined) throw new Error("Query Fixture must be registered.");

void test("Restricted Context returns only authorized Properties as a frozen copy", async () => {
  const context = createRestrictedContext(queryRegistration, queryContext());
  const result = await context.query({
    queryName: "object.get",
    objectRid: "ri.ontos.object.work-item-1",
    properties: ["status"],
  });

  assert.deepEqual(result, {
    objectRid: "ri.ontos.object.work-item-1",
    objectVersion: "version-7",
    properties: { status: "OPEN" },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.properties), true);
  assert.equal("internalNote" in result.properties, false);
});

void test("Restricted Context rejects undeclared Query, object and Property expansion", async () => {
  const base = queryContext();
  await assertBoundaryError(
    createRestrictedContext(queryRegistration, { ...base, declaredQueries: [] }).query({
      queryName: "object.get",
      objectRid: "ri.ontos.object.work-item-1",
      properties: ["status"],
    }),
    "QUERY_NOT_DECLARED",
  );
  await assertBoundaryError(
    createRestrictedContext(queryRegistration, base).query({
      queryName: "object.get",
      objectRid: "ri.ontos.object.work-item-2",
      properties: ["status"],
    }),
    "READ_SET_VIOLATION",
  );
  await assertBoundaryError(
    createRestrictedContext(queryRegistration, base).query({
      queryName: "object.get",
      objectRid: "ri.ontos.object.work-item-1",
      properties: ["internalNote"],
    }),
    "READ_SET_VIOLATION",
  );
});

void test("Restricted Context enforces the per-invocation read budget", async () => {
  const context = createRestrictedContext(queryRegistration, {
    ...queryContext(),
    maximumReads: 1,
  });
  await context.query({
    queryName: "object.get",
    objectRid: "ri.ontos.object.work-item-1",
    properties: ["status"],
  });
  await assertBoundaryError(
    context.query({
      queryName: "object.get",
      objectRid: "ri.ontos.object.work-item-1",
      properties: ["status"],
    }),
    "QUERY_LIMIT_EXCEEDED",
  );
});

function queryContext(): InvocationContextData {
  return {
    declaredQueries: ["object.get"],
    maximumReads: 2,
    readSet: [
      {
        queryName: "object.get",
        objectRid: "ri.ontos.object.work-item-1",
        properties: ["status", "priority"],
      },
    ],
    queryResults: [
      {
        queryName: "object.get",
        objectRid: "ri.ontos.object.work-item-1",
        objectVersion: "version-7",
        properties: { status: "OPEN", priority: 3 },
      },
    ],
  };
}

async function assertBoundaryError(
  promise: Promise<unknown>,
  code: HandlerBoundaryError["code"],
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof HandlerBoundaryError && error.code === code,
  );
}
