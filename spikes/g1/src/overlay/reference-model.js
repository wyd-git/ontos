import { invariant } from "../core/kernel-error.js";
import { stableJson } from "../core/stable-json.js";

const PROPERTY_OPERATIONS = new Set(["SET_PROPERTY", "CLEAR_PROPERTY", "REMOVE_OVERRIDE"]);
const OBJECT_OPERATIONS = new Set(["CREATE_OBJECT", "TOMBSTONE_OBJECT", "RESTORE_OBJECT"]);

export function materializeReference({
  snapshots,
  incomingSnapshotId,
  operations,
  watermark = Number.POSITIVE_INFINITY,
  previousProjection = new Map(),
}) {
  invariant(snapshots instanceof Map, "INVALID_SNAPSHOT", "snapshots must be a Map");
  const incoming = snapshots.get(incomingSnapshotId);
  invariant(incoming, "SNAPSHOT_NOT_FOUND", `Snapshot not found: ${incomingSnapshotId}`);

  const states = new Map();
  for (const object of incoming.objects) {
    const rid = objectRid(object.objectType, object.primaryKey);
    states.set(rid, makeState({ rid, ...object, basePresent: true }));
  }

  const acceptedOperations = [...operations]
    .filter((operation) => operation.seq <= watermark)
    .sort((left, right) => left.seq - right.seq);

  for (const operation of acceptedOperations) {
    validateOperation(operation);
    const rid = objectRid(operation.objectType, operation.primaryKey);
    let state = states.get(rid);
    if (!state) {
      state = makeState({
        rid,
        objectType: operation.objectType,
        primaryKey: operation.primaryKey,
        properties: {},
        basePresent: false,
      });
      states.set(rid, state);
    }

    applyOperation(state, operation);
  }

  const projection = new Map();
  const conflicts = [];
  for (const [rid, state] of states) {
    const previous = previousProjection.get(rid);
    const previousBase = findPreviousBase(snapshots, incomingSnapshotId, state.objectType, state.primaryKey);
    const result = resolveState({ state, snapshots, incoming, incomingSnapshotId, previousBase });
    if (!result.presentInProjection) {
      continue;
    }

    const comparable = {
      properties: result.properties,
      lifecycleState: result.lifecycleState,
      conflictState: result.conflictState,
    };
    const previousComparable = previous
      ? {
        properties: previous.properties,
        lifecycleState: previous.lifecycleState,
        conflictState: previous.conflictState,
      }
      : null;
    const changed = stableJson(comparable) !== stableJson(previousComparable);
    const objectVersion = previous ? previous.objectVersion + (changed ? 1 : 0) : 1;
    const object = {
      objectType: state.objectType,
      primaryKey: state.primaryKey,
      objectRid: rid,
      objectVersion,
      properties: result.properties,
      lifecycleState: result.lifecycleState,
      conflictState: result.conflictState,
      conflicts: result.conflicts,
      provenance: result.provenance,
      incomingSnapshotId,
      overlayWatermark: watermark,
    };
    projection.set(rid, object);
    conflicts.push(...result.conflicts.map((conflict) => ({ objectRid: rid, ...conflict })));
  }

  return {
    snapshotId: incomingSnapshotId,
    overlayWatermark: watermark,
    objects: projection,
    conflicts,
  };
}

export function catchUpReference({ staged, snapshots, operations, watermark }) {
  invariant(watermark >= staged.overlayWatermark, "INVALID_WATERMARK", "Catch-up watermark cannot move backwards");
  return materializeReference({
    snapshots,
    incomingSnapshotId: staged.snapshotId,
    operations,
    watermark,
    previousProjection: staged.objects,
  });
}

export function snapshot(id, objects) {
  return Object.freeze({
    id,
    objects: objects.map((object) => Object.freeze({
      ...object,
      properties: structuredClone(object.properties),
    })),
  });
}

export function operation({
  seq,
  type,
  objectType = "EntityA",
  primaryKey,
  propertyName,
  value,
  basisSnapshotId,
}) {
  return Object.freeze({
    seq,
    type,
    objectType,
    primaryKey,
    propertyName,
    value: structuredClone(value),
    basisSnapshotId,
  });
}

function makeState({ rid, objectType, primaryKey, properties, basePresent }) {
  return {
    rid,
    objectType,
    primaryKey,
    basePresent,
    baseProperties: structuredClone(properties),
    createOperation: null,
    propertyOperations: new Map(),
    tombstoned: false,
    lastLifecycleOperation: null,
    operations: [],
  };
}

function validateOperation(operationValue) {
  invariant(Number.isSafeInteger(operationValue.seq) && operationValue.seq > 0, "INVALID_OVERLAY_OPERATION", "Operation seq must be a positive integer");
  invariant(typeof operationValue.objectType === "string" && typeof operationValue.primaryKey === "string", "INVALID_OVERLAY_OPERATION", "Operation identity is required");
  invariant(PROPERTY_OPERATIONS.has(operationValue.type) || OBJECT_OPERATIONS.has(operationValue.type), "INVALID_OVERLAY_OPERATION", `Unsupported operation: ${operationValue.type}`);
  if (PROPERTY_OPERATIONS.has(operationValue.type)) {
    invariant(typeof operationValue.propertyName === "string", "INVALID_OVERLAY_OPERATION", `${operationValue.type} requires propertyName`);
  }
}

function applyOperation(state, operationValue) {
  state.operations.push(operationValue);
  if (operationValue.type === "CREATE_OBJECT") {
    invariant(operationValue.value && typeof operationValue.value === "object" && !Array.isArray(operationValue.value), "INVALID_OVERLAY_OPERATION", "CREATE_OBJECT requires property object");
    state.createOperation = operationValue;
    return;
  }

  if (operationValue.type === "TOMBSTONE_OBJECT") {
    state.tombstoned = true;
    state.lastLifecycleOperation = operationValue;
    return;
  }

  if (operationValue.type === "RESTORE_OBJECT") {
    state.tombstoned = false;
    state.lastLifecycleOperation = operationValue;
    return;
  }

  if (operationValue.type === "REMOVE_OVERRIDE") {
    state.propertyOperations.delete(operationValue.propertyName);
    return;
  }

  state.propertyOperations.set(operationValue.propertyName, operationValue);
}

function resolveState({ state, snapshots, incoming, incomingSnapshotId, previousBase }) {
  const conflicts = [];
  const hasActiveOverlay = Boolean(state.createOperation)
    || state.propertyOperations.size > 0
    || state.tombstoned;

  if (!state.basePresent && !state.createOperation && !hasActiveOverlay) {
    return { presentInProjection: false };
  }

  const createBasis = state.createOperation?.basisSnapshotId
    ? snapshots.get(state.createOperation.basisSnapshotId)
    : null;
  const createBasisHadObject = createBasis
    ? Boolean(objectInSnapshot(createBasis, state.objectType, state.primaryKey))
    : false;
  if (state.basePresent && state.createOperation && !createBasisHadObject) {
    conflicts.push({
      type: "IDENTITY_COLLISION",
      propertyName: null,
      basisSnapshotId: state.createOperation.basisSnapshotId ?? null,
      incomingValue: structuredClone(state.baseProperties),
      overlayValue: structuredClone(state.createOperation.value),
      operationSeq: state.createOperation.seq,
    });
  }

  if (!state.basePresent && !state.createOperation && hasActiveOverlay) {
    conflicts.push({
      type: "BASE_OBJECT_REMOVED",
      propertyName: null,
      basisSnapshotId: latestBasisSnapshotId(state),
      incomingValue: undefined,
      overlayValue: activeOverlaySummary(state),
      operationSeq: latestOperationSeq(state),
    });
  }

  const properties = state.createOperation
    ? structuredClone(state.createOperation.value)
    : structuredClone(state.baseProperties);
  const provenance = Object.fromEntries(Object.keys(properties).map((propertyName) => [
    propertyName,
    { source: state.createOperation ? "overlay_create" : "base", snapshotId: incomingSnapshotId },
  ]));

  for (const [propertyName, propertyOperation] of state.propertyOperations) {
    const basis = propertyOperation.basisSnapshotId
      ? snapshots.get(propertyOperation.basisSnapshotId)
      : null;
    const basisObject = basis
      ? objectInSnapshot(basis, state.objectType, state.primaryKey)
      : null;
    const basisValue = basisObject?.properties[propertyName];
    const incomingValue = state.basePresent ? state.baseProperties[propertyName] : undefined;

    if (basisObject && stableJson(basisValue) !== stableJson(incomingValue)) {
      conflicts.push({
        type: "BASE_CHANGED_UNDER_OVERRIDE",
        propertyName,
        basisSnapshotId: propertyOperation.basisSnapshotId,
        basisValue: structuredClone(basisValue),
        incomingValue: structuredClone(incomingValue),
        overlayValue: propertyOperation.type === "CLEAR_PROPERTY" ? null : structuredClone(propertyOperation.value),
        operationSeq: propertyOperation.seq,
      });
    }

    properties[propertyName] = propertyOperation.type === "CLEAR_PROPERTY"
      ? null
      : structuredClone(propertyOperation.value);
    provenance[propertyName] = {
      source: "overlay",
      operationSeq: propertyOperation.seq,
      basisSnapshotId: propertyOperation.basisSnapshotId ?? null,
    };
  }

  if (!state.basePresent && !state.createOperation && previousBase) {
    for (const [propertyName, value] of Object.entries(previousBase.properties)) {
      if (!Object.hasOwn(properties, propertyName)) {
        properties[propertyName] = structuredClone(value);
        provenance[propertyName] = {
          source: "previous_base_orphan",
          snapshotId: previousBase.snapshotId,
        };
      }
    }
  }

  const lifecycleState = state.tombstoned
    ? "tombstoned"
    : (!state.basePresent && !state.createOperation ? "source_removed" : "active");
  const conflictState = highestConflict(conflicts);
  return {
    presentInProjection: true,
    properties,
    provenance,
    lifecycleState,
    conflictState,
    conflicts,
  };
}

function findPreviousBase(snapshots, incomingSnapshotId, objectType, primaryKey) {
  const ordered = [...snapshots.values()];
  const incomingIndex = ordered.findIndex((item) => item.id === incomingSnapshotId);
  for (let index = incomingIndex - 1; index >= 0; index -= 1) {
    const object = objectInSnapshot(ordered[index], objectType, primaryKey);
    if (object) {
      return { snapshotId: ordered[index].id, ...object };
    }
  }
  return null;
}

function objectInSnapshot(snapshotValue, objectType, primaryKey) {
  return snapshotValue.objects.find((object) => {
    return object.objectType === objectType && object.primaryKey === primaryKey;
  });
}

function highestConflict(conflicts) {
  const priority = ["IDENTITY_COLLISION", "BASE_OBJECT_REMOVED", "BASE_CHANGED_UNDER_OVERRIDE"];
  return priority.find((type) => conflicts.some((conflict) => conflict.type === type)) ?? null;
}

function activeOverlaySummary(state) {
  return {
    properties: Object.fromEntries([...state.propertyOperations].map(([propertyName, value]) => [
      propertyName,
      value.type === "CLEAR_PROPERTY" ? null : value.value,
    ])),
    tombstoned: state.tombstoned,
  };
}

function latestBasisSnapshotId(state) {
  return [...state.operations].reverse().find((item) => item.basisSnapshotId)?.basisSnapshotId ?? null;
}

function latestOperationSeq(state) {
  return state.operations.at(-1)?.seq ?? null;
}

function objectRid(objectType, primaryKey) {
  return `${objectType}:${primaryKey}`;
}
