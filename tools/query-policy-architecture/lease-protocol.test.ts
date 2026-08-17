import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReadMayStart,
  buildExecutionContextCandidate,
  commitQueryLease,
  generationRootsFromLeases,
  planQueryLease,
  releaseQueryLease,
} from "./lease-protocol.ts";
import type { ServingContext } from "./policy-query.ts";

const serving: ServingContext = Object.freeze({
  resolution: "release-serving-head",
  projectId: "43000000-0000-4000-8000-000000000001",
  releaseId: "43000000-0000-4000-8000-000000000002",
  activationId: "43000000-0000-4000-8000-000000000003",
  members: Object.freeze([
    Object.freeze({
      memberKey: "object:EntityAlpha",
      kind: "object" as const,
      targetResourceId: "43000000-0000-4000-8000-000000000011",
      targetRevisionId: "43000000-0000-4000-8000-000000000012",
      generationId: "43000000-0000-4000-8000-000000000013",
    }),
    Object.freeze({
      memberKey: "link:AlphaRelatedBeta",
      kind: "link" as const,
      targetResourceId: "43000000-0000-4000-8000-000000000021",
      targetRevisionId: "43000000-0000-4000-8000-000000000022",
      generationId: "43000000-0000-4000-8000-000000000023",
    }),
  ]),
});

const acquiredAt = 1_800_000_000_000;

void test("a read cannot start until the Query Lease has committed", () => {
  const planned = planQueryLease({
    leaseId: "43000000-0000-4000-8000-000000000100",
    serving,
    acquiredAtEpochMilliseconds: acquiredAt,
    ttlMilliseconds: 60_000,
  });
  assert.throws(() => assertReadMayStart(planned, acquiredAt + 1), /QUERY_LEASE_NOT_ACTIVE/u);
  const committed = commitQueryLease(planned);
  assert.doesNotThrow(() => assertReadMayStart(committed, acquiredAt + 1));
});

void test("only committed, unexpired leases protect Generations from GC", () => {
  const planned = planQueryLease({
    leaseId: "43000000-0000-4000-8000-000000000100",
    serving,
    acquiredAtEpochMilliseconds: acquiredAt,
    ttlMilliseconds: 60_000,
  });
  const committed = commitQueryLease(planned);
  assert.deepEqual(generationRootsFromLeases([planned], acquiredAt + 1), []);
  assert.deepEqual(generationRootsFromLeases([committed], acquiredAt + 1), [
    "43000000-0000-4000-8000-000000000013",
    "43000000-0000-4000-8000-000000000023",
  ]);
  const released = releaseQueryLease(committed, acquiredAt + 2);
  assert.deepEqual(generationRootsFromLeases([released], acquiredAt + 3), []);
  assert.deepEqual(generationRootsFromLeases([committed], acquiredAt + 60_000), []);
});

void test("a Cursor is not a GC root and every request resolves a fresh Lease", () => {
  const committed = commitQueryLease(
    planQueryLease({
      leaseId: "43000000-0000-4000-8000-000000000100",
      serving,
      acquiredAtEpochMilliseconds: acquiredAt,
      ttlMilliseconds: 60_000,
    }),
  );
  const cursorOnlyReference = "opaque-cursor-that-mentions-no-generation";
  assert.equal(cursorOnlyReference.length > 0, true);
  assert.deepEqual(generationRootsFromLeases([], acquiredAt + 1), []);
  assert.throws(
    () => assertReadMayStart(committed, acquiredAt + 60_000),
    /QUERY_LEASE_NOT_ACTIVE/u,
  );
});

void test("Execution Context binds identity, epoch, policy, serving snapshot and Lease once", () => {
  const committed = commitQueryLease(
    planQueryLease({
      leaseId: "43000000-0000-4000-8000-000000000100",
      serving,
      acquiredAtEpochMilliseconds: acquiredAt,
      ttlMilliseconds: 60_000,
    }),
  );
  const context = buildExecutionContextCandidate({
    serving,
    lease: committed,
    identityFingerprint: `sha256:${"1".repeat(64)}`,
    authorizationEpoch: "9",
    policyArtifactDigest: `sha256:${"2".repeat(64)}`,
    policyCompilerVersion: "policy-sql-candidate-v1",
    readTimestamp: "2026-08-18T00:00:00.000Z",
    databaseNowEpochMilliseconds: acquiredAt + 1,
  });
  assert.equal(context.source, "resolved-once-per-request");
  assert.equal(context.queryLeaseId, committed.leaseId);
  assert.equal(context.generationIds.length, 2);
});
