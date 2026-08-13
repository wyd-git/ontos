const ENTRY_POINTS = [
  "objectApi",
  "sdk",
  "functionContext",
  "actionTarget",
  "exportAdapter",
  "automationAdapter",
  "aiToolAdapter",
];

export function createPolicyAwareAdapters(gateway) {
  return Object.fromEntries(ENTRY_POINTS.map((entryPoint) => [
    entryPoint,
    Object.freeze({
      search: (request) => gateway.search({ ...request, entryPoint }),
      aggregate: (request) => gateway.aggregate({ ...request, entryPoint }),
      traverse: (request) => gateway.traverse({ ...request, entryPoint }),
      loadActionTarget: (request) => gateway.loadActionTarget({ ...request, entryPoint }),
    }),
  ]));
}

export { ENTRY_POINTS };
