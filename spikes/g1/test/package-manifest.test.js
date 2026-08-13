import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compareManifests, validateManifest } from "../src/packages/manifest.js";
import { KernelError } from "../src/core/kernel-error.js";
import { PackageReleaseStore } from "../src/packages/release-store.js";
import { compilePackageRuntimeProbe } from "../src/packages/runtime-bridge.js";

const workPackage = await loadManifest("../packages/work-management/package.json");
const commercePackage = await loadManifest("../packages/commerce/package.json");

test("validates two structurally different domain packages with one loader", () => {
  const work = validateManifest(workPackage);
  const commerce = validateManifest(commercePackage);
  assert.deepEqual(work.counts, { objectTypes: 5, linkTypes: 5, actions: 3, policies: 2, views: 2 });
  assert.deepEqual(commerce.counts, work.counts);
  assert.notEqual(work.packageApiName, commerce.packageApiName);
});

test("allows a nullable property addition as a compatible upgrade", () => {
  const next = structuredClone(commercePackage);
  next.version = "1.1.0";
  next.resources.objectTypes
    .find((objectType) => objectType.apiName === "Shipment")
    .properties.trackingNote = { type: "string", nullable: true };
  const comparison = compareManifests(commercePackage, next);
  assert.equal(comparison.compatible, true);
  assert.deepEqual(comparison.changes, [{
    kind: "compatible",
    code: "NULLABLE_PROPERTY_ADDED",
    path: "Shipment.trackingNote",
  }]);
});

test("blocks primary key changes and removed properties", () => {
  const next = structuredClone(commercePackage);
  next.version = "2.0.0";
  const order = next.resources.objectTypes.find((objectType) => objectType.apiName === "Order");
  order.properties.newOrderId = { type: "string", nullable: false };
  order.primaryKey = "newOrderId";
  delete order.properties.status;
  next.resources.policies = next.resources.policies.filter((policy) => policy.objectType !== "Order");
  next.resources.policies.push({
    apiName: "ordersByTotal",
    objectType: "Order",
    predicate: { property: "total", op: "gte", value: "0" },
  });
  next.resources.views.find((view) => view.objectType === "Order").fields = ["newOrderId", "total"];
  const comparison = compareManifests(commercePackage, next);
  assert.equal(comparison.compatible, false);
  assert.equal(comparison.changes.some((change) => change.code === "PRIMARY_KEY_CHANGED"), true);
  assert.equal(comparison.changes.some((change) => change.code === "PROPERTY_REMOVED"), true);
});

test("rejects package attempts to add raw SQL or kernel migrations", () => {
  const malicious = structuredClone(workPackage);
  malicious.kernelMigrations = ["DROP SCHEMA kernel CASCADE"];
  assert.throws(
    () => validateManifest(malicious),
    (error) => error instanceof KernelError && error.code === "INVALID_PACKAGE",
  );

  const nested = structuredClone(workPackage);
  nested.resources.actions[0].rawSql = "UPDATE kernel.object_current SET properties = '{}'";
  assert.throws(
    () => validateManifest(nested),
    (error) => error instanceof KernelError && error.code === "PACKAGE_CAPABILITY_FORBIDDEN",
  );

  const executableMigration = structuredClone(workPackage);
  executableMigration.migrations = ["UPDATE kernel.object_current SET properties = '{}'::jsonb"];
  assert.throws(
    () => validateManifest(executableMigration),
    (error) => error instanceof KernelError && error.code === "INVALID_PACKAGE",
  );
});

test("installs, upgrades, rolls back definitions, and preserves action history pins", () => {
  const store = new PackageReleaseStore();
  const workRelease = store.install(workPackage);
  const commerceRelease = store.install(commercePackage);
  const historicalExecution = store.recordActionExecution({
    executionId: "action-1",
    packageApiName: "commerce_fixture",
    actionApiName: "confirmOrder",
    payload: { orderId: "O-1" },
  });

  const compatible = structuredClone(commercePackage);
  compatible.version = "1.1.0";
  compatible.resources.objectTypes
    .find((objectType) => objectType.apiName === "Shipment")
    .properties.trackingNote = { type: "string", nullable: true };
  const upgradeRelease = store.upgrade(compatible);
  const rollbackRelease = store.rollback("commerce_fixture", commerceRelease.revisionId);

  assert.equal(store.getActiveManifest("work_management_fixture").version, "1.0.0");
  assert.equal(store.getActiveManifest("commerce_fixture").version, "1.0.0");
  assert.equal(upgradeRelease.parentRevisionId, commerceRelease.revisionId);
  assert.equal(rollbackRelease.kind, "rollback");
  assert.equal(rollbackRelease.restoredFromRevisionId, commerceRelease.revisionId);
  const resolved = store.resolveHistoricalAction(historicalExecution.executionId);
  assert.equal(resolved.release.revisionId, commerceRelease.revisionId);
  assert.equal(resolved.action.handlerDigest, historicalExecution.handlerDigest);
  assert.notEqual(workRelease.revisionId, commerceRelease.revisionId);
});

test("blocks a breaking upgrade before publishing a revision", () => {
  const store = new PackageReleaseStore();
  store.install(commercePackage);
  const breaking = structuredClone(commercePackage);
  breaking.version = "2.0.0";
  delete breaking.resources.objectTypes.find((item) => item.apiName === "Order").properties.total;
  breaking.resources.views.find((item) => item.apiName === "orderConsole").fields = ["orderId", "status"];

  assert.throws(
    () => store.upgrade(breaking),
    (error) => error.code === "BREAKING_PACKAGE_UPGRADE",
  );
  assert.equal(store.listReleases("commerce_fixture").length, 1);
});

test("classifies link, action, policy, and namespace compatibility", () => {
  const next = structuredClone(commercePackage);
  next.version = "1.1.0";
  next.namespace = "fixture.renamed";
  next.resources.linkTypes.find((item) => item.apiName === "orderProducts").targetType = "Shipment";
  next.resources.actions.find((item) => item.apiName === "confirmOrder").targetType = "Return";
  next.resources.policies.find((item) => item.apiName === "ordersByStatus").predicate.value = ["CONFIRMED"];
  const comparison = compareManifests(commercePackage, next);

  assert.equal(comparison.compatible, false);
  assert.equal(comparison.changes.some((item) => item.code === "NAMESPACE_CHANGED"), true);
  assert.equal(comparison.changes.some((item) => item.code === "LINK_TYPE_ENDPOINT_CHANGED"), true);
  assert.equal(comparison.changes.some((item) => item.code === "ACTION_TARGET_CHANGED"), true);
  assert.equal(comparison.changes.some((item) => item.code === "POLICY_SEMANTICS_CHANGED"), true);
});

test("permits a handler digest update only as a new compatible release", () => {
  const next = structuredClone(commercePackage);
  next.version = "1.1.0";
  next.resources.actions.find((item) => item.apiName === "confirmOrder").handlerDigest = `sha256:${"1".repeat(64)}`;
  const comparison = compareManifests(commercePackage, next);
  assert.equal(comparison.compatible, true);
  assert.deepEqual(comparison.changes, [{
    kind: "compatible",
    code: "ACTION_HANDLER_CHANGED",
    path: "confirmOrder",
  }]);
});

test("both domains compile view, link, policy, and action through one runtime bridge", () => {
  for (const manifest of [workPackage, commercePackage]) {
    const probe = compilePackageRuntimeProbe(manifest);
    assert.equal(probe.viewCompilations.length, 2);
    assert.equal(probe.linkCompilations.length, 5);
    assert.equal(probe.policyCompilations.length, 2);
    assert.equal(probe.actionPlans.length, 3);
    assert.equal(probe.viewCompilations.every((item) => item.compiled.text.includes("kernel.object_current")), true);
    assert.equal(probe.linkCompilations.every((item) => item.compiled.text.includes("kernel.link_current")), true);
    assert.equal(probe.policyCompilations.every((item) => item.compiled.values.length >= 3), true);
    assert.equal(probe.actionPlans.every((item) => item.handlerDigest.startsWith("sha256:")), true);
  }
});

async function loadManifest(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(await readFile(url, "utf8"));
}
