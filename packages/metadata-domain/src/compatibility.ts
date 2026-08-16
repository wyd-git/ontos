import {
  canonicalizeContractForDigest,
  parseLinkTypeDefinition,
  parseMappingDefinition,
  parseObjectTypeDefinition,
  parseSnapshotSchemaDefinition,
  type ArtifactDigest,
  type CompatibilityFindingContract,
  type CompatibilityReportContract,
  type LinkTypeDefinition,
  type ObjectTypeDefinition,
  type OntosId,
  type PackageManifestContract,
  type PropertyDefinition,
  type ResourceFamily,
} from "@ontos/contracts";

export const METADATA_COMPATIBILITY_VERSION = "metadata-compatibility-g2-02-10-v1" as const;

const runtimePlanCompatibilityFamilies = new Set<ResourceFamily>([
  "object_type",
  "link_type",
  "snapshot_schema",
  "mapping",
]);

export interface ResourceCompatibilityInput {
  readonly baselineFamily: ResourceFamily;
  readonly baselineContent: unknown;
  readonly candidateFamily: ResourceFamily;
  readonly candidateContent: unknown;
  readonly endpointRevisionIdentities?: readonly EndpointRevisionIdentity[];
}

export interface EndpointRevisionIdentity {
  readonly revisionId: string;
  readonly resourceId: string;
}

export interface CompatibilityEvaluation {
  readonly outcome: CompatibilityReportContract["outcome"];
  readonly findings: readonly CompatibilityFindingContract[];
}

export interface PinnedCompatibilityRevision {
  readonly resourceId: string;
  readonly revisionId: string;
  readonly family: ResourceFamily;
  readonly content: unknown;
}

export interface PinnedCompatibilityDependency {
  readonly sourceRevisionId: string;
  readonly targetRevisionId: string;
  readonly dependencyType: string;
  readonly sourcePath: string;
}

export interface PinnedCompatibilityInput {
  readonly baselinePins: readonly PinnedCompatibilityRevision[];
  readonly candidatePins: readonly PinnedCompatibilityRevision[];
  readonly candidateDependencies: readonly PinnedCompatibilityDependency[];
}

export interface PackageCompatibilityPin extends PinnedCompatibilityRevision {
  readonly namespace: string;
  readonly apiName: string;
  readonly contentDigest: ArtifactDigest;
}

export interface PackageCompatibilityInput {
  readonly baselineManifest: PackageManifestContract;
  readonly candidateManifest: PackageManifestContract;
  readonly baselinePins: readonly PackageCompatibilityPin[];
  readonly candidatePins: readonly PackageCompatibilityPin[];
  readonly candidateDependencies: readonly PinnedCompatibilityDependency[];
}

/**
 * Compares the meaning of two immutable definitions. Semantic version strings
 * are deliberately absent: callers cannot relabel a breaking change to bypass
 * this decision.
 */
export function compareResourceCompatibility(
  input: ResourceCompatibilityInput,
): CompatibilityEvaluation {
  if (input.baselineFamily !== input.candidateFamily) {
    return evaluation([
      finding(
        "forbidden",
        "RESOURCE_FAMILY_CHANGED",
        "/family",
        "A Resource cannot change family across Revisions.",
        "Create a new Resource identity for the new family.",
      ),
    ]);
  }

  if (input.baselineFamily === "object_type") {
    return compareObjectTypes(
      parseObjectTypeDefinition(input.baselineContent),
      parseObjectTypeDefinition(input.candidateContent),
    );
  }
  if (input.baselineFamily === "link_type") {
    return compareLinkTypes(
      parseLinkTypeDefinition(input.baselineContent),
      parseLinkTypeDefinition(input.candidateContent),
      endpointIdentityMap(input.endpointRevisionIdentities ?? []),
    );
  }
  if (input.baselineFamily === "snapshot_schema") {
    const baseline = parseSnapshotSchemaDefinition(input.baselineContent);
    const candidate = parseSnapshotSchemaDefinition(input.candidateContent);
    return sameValue(baseline, candidate)
      ? evaluation([])
      : evaluation([
          finding(
            "conditional",
            "SNAPSHOT_SCHEMA_REMATERIALIZATION_REQUIRED",
            "/",
            "The Snapshot Schema changed and existing Generation data cannot be assumed compatible.",
            "Derive the new Runtime Plan and complete a new trusted Generation before Release readiness.",
          ),
        ]);
  }
  if (input.baselineFamily === "mapping") {
    const baseline = parseMappingDefinition(input.baselineContent);
    const candidate = parseMappingDefinition(input.candidateContent);
    return sameValue(baseline, candidate)
      ? evaluation([])
      : evaluation([
          finding(
            "conditional",
            "MAPPING_REMATERIALIZATION_REQUIRED",
            "/",
            "The Mapping changed and an existing Generation cannot be trusted for the new semantics.",
            "Derive the new Runtime Plan and complete a new trusted Generation before Release readiness.",
          ),
        ]);
  }

  return evaluation([
    finding(
      "conditional",
      "RESOURCE_FAMILY_COMPATIBILITY_DEFERRED",
      "/family",
      `Compatibility semantics for ${input.baselineFamily} are not active in G2-01.`,
      "Wait for the owning Resource-family Gate; this finding cannot enter READY in G2-01.",
    ),
  ]);
}

/**
 * Compares complete, actual pin sets. It catches the case where a candidate
 * replaces an Object Revision but leaves a pinned Link pointing to the old
 * Revision, rather than assuming that same-Resource compatibility is enough.
 */
export function comparePinnedCompatibility(
  input: PinnedCompatibilityInput,
): CompatibilityEvaluation {
  const findings: CompatibilityFindingContract[] = [];
  const baselineByResource = uniquePinsByResource(input.baselinePins, "baseline");
  const candidateByResource = uniquePinsByResource(input.candidatePins, "candidate");
  const endpointRevisionIdentities = [
    ...baselineByResource.values(),
    ...candidateByResource.values(),
  ]
    .filter(({ family }) => family === "object_type")
    .map(({ revisionId, resourceId }) => ({ revisionId, resourceId }));

  for (const [resourceId, candidate] of sortedEntries(candidateByResource)) {
    if (runtimePlanCompatibilityFamilies.has(candidate.family)) continue;
    findings.push(
      finding(
        "conditional",
        "RESOURCE_FAMILY_COMPATIBILITY_DEFERRED",
        `/resources/${escapePointer(resourceId)}/family`,
        `Compatibility semantics for ${candidate.family} are not active in G2-01.`,
        "Wait for the owning Resource-family Gate; this finding cannot enter READY in G2-01.",
      ),
    );
  }

  for (const [resourceId, baseline] of sortedEntries(baselineByResource)) {
    const candidate = candidateByResource.get(resourceId);
    const resourcePath = `/resources/${escapePointer(resourceId)}`;
    if (candidate === undefined) {
      findings.push(
        finding(
          "breaking",
          "RESOURCE_REMOVED",
          resourcePath,
          "A Resource pinned by the baseline Release is absent from the candidate Release.",
          "Restore the Resource Pin or publish a new API identity with an explicit migration plan.",
        ),
      );
      continue;
    }
    if (baseline.revisionId === candidate.revisionId) continue;
    findings.push(
      ...prefixFindings(
        compareResourceCompatibility({
          baselineFamily: baseline.family,
          baselineContent: baseline.content,
          candidateFamily: candidate.family,
          candidateContent: candidate.content,
          endpointRevisionIdentities,
        }).findings,
        resourcePath,
      ),
    );
  }

  for (const [resourceId] of sortedEntries(candidateByResource)) {
    if (baselineByResource.has(resourceId)) continue;
    findings.push(
      finding(
        "compatible",
        "RESOURCE_ADDED",
        `/resources/${escapePointer(resourceId)}`,
        "The candidate Release adds a Resource without changing a baseline identity.",
        "No compatibility action is required.",
      ),
    );
  }

  const candidateRevisionIds = new Set(
    [...candidateByResource.values()].map(({ revisionId }) => revisionId),
  );
  const candidateResourceByRevision = new Map(
    [...candidateByResource.values()].map((pin) => [pin.revisionId, pin.resourceId]),
  );
  for (const dependency of [...input.candidateDependencies].sort(compareDependencies)) {
    if (!candidateRevisionIds.has(dependency.sourceRevisionId)) continue;
    if (candidateRevisionIds.has(dependency.targetRevisionId)) continue;
    const sourceResourceId = candidateResourceByRevision.get(dependency.sourceRevisionId);
    if (sourceResourceId === undefined) continue;
    findings.push(
      finding(
        "breaking",
        "DOWNSTREAM_PIN_REQUIRES_REPIN",
        `/resources/${escapePointer(sourceResourceId)}/dependencies/${escapePointer(
          dependency.dependencyType,
        )}${dependency.sourcePath}`,
        "A candidate downstream Pin still targets a Revision that is absent from the candidate Release.",
        "Create and validate a downstream Revision that targets the candidate Pin, then stage the closed Pin set again.",
      ),
    );
  }

  return evaluation(findings);
}

export function compareReleaseCompatibility(
  input: PinnedCompatibilityInput,
): CompatibilityEvaluation {
  return comparePinnedCompatibility(input);
}

export function comparePackageCompatibility(
  input: PackageCompatibilityInput,
): CompatibilityEvaluation {
  const findings: CompatibilityFindingContract[] = [];
  if (input.baselineManifest.packageApiName !== input.candidateManifest.packageApiName) {
    findings.push(
      finding(
        "forbidden",
        "PACKAGE_IDENTITY_CHANGED",
        "/packageApiName",
        "A Package upgrade cannot change the Package API identity.",
        "Install the candidate as a new Package identity.",
      ),
    );
  }
  if (input.baselineManifest.namespace !== input.candidateManifest.namespace) {
    findings.push(
      finding(
        "forbidden",
        "NAMESPACE_CHANGED",
        "/namespace",
        "A Package upgrade cannot move its Resource namespace.",
        "Publish a new Package identity and migrate consumers explicitly.",
      ),
    );
  }
  if (
    input.baselineManifest.kernelContractVersion !== input.candidateManifest.kernelContractVersion
  ) {
    findings.push(
      finding(
        "forbidden",
        "KERNEL_CONTRACT_CHANGED",
        "/kernelContractVersion",
        "The candidate Package targets a different Kernel contract.",
        "Use the Kernel contract migration process before installing this Package.",
      ),
    );
  }

  compareInstallInputs(
    input.baselineManifest.installInputs,
    input.candidateManifest.installInputs,
    findings,
  );
  if (!sameValue(input.baselineManifest.artifactDigests, input.candidateManifest.artifactDigests)) {
    findings.push(
      finding(
        "conditional",
        "PACKAGE_ARTIFACT_COMPATIBILITY_DEFERRED",
        "/artifactDigests",
        "Package executable artifacts changed, but their owning runtime is not active in G2-01.",
        "Validate the artifacts in the owning Function/Action Gate before this upgrade can enter READY.",
      ),
    );
  }
  for (const side of ["baseline", "candidate"] as const) {
    const manifest = side === "baseline" ? input.baselineManifest : input.candidateManifest;
    const pins = side === "baseline" ? input.baselinePins : input.candidatePins;
    if (!manifestMatchesPins(manifest, pins)) {
      findings.push(
        finding(
          "forbidden",
          "PACKAGE_RESOURCE_EXPANSION_MISMATCH",
          "/resourceEntries",
          `The ${side} Package Manifest does not match its server-expanded Resource Pins.`,
          "Reject the Package and repeat expansion from the immutable Manifest.",
        ),
      );
    }
  }
  findings.push(...compareReleaseCompatibility(input).findings);
  return evaluation(findings);
}

export function summarizeCompatibilityFindings(
  findings: readonly CompatibilityFindingContract[],
): CompatibilityEvaluation {
  return evaluation(findings);
}

export function buildCompatibilityReport(input: {
  readonly reportId: OntosId;
  readonly baselineDigest: CompatibilityReportContract["baselineDigest"];
  readonly candidateDigest: CompatibilityReportContract["candidateDigest"];
  readonly evaluation: CompatibilityEvaluation;
}): CompatibilityReportContract {
  return Object.freeze({
    schemaVersion: 1,
    reportId: input.reportId,
    baselineDigest: input.baselineDigest,
    candidateDigest: input.candidateDigest,
    outcome: input.evaluation.outcome,
    findings: input.evaluation.findings,
  });
}

function compareObjectTypes(
  baseline: ObjectTypeDefinition,
  candidate: ObjectTypeDefinition,
): CompatibilityEvaluation {
  const findings: CompatibilityFindingContract[] = [];
  compareDefinitionIdentityAndText(baseline, candidate, findings);

  if (baseline.primaryKeyPropertyApiName !== candidate.primaryKeyPropertyApiName) {
    findings.push(
      finding(
        "forbidden",
        "PRIMARY_KEY_CHANGED",
        "/primaryKeyPropertyApiName",
        "The Primary Key Property changed.",
        "Create a new Object Type API identity or provide an explicit migration in a future owning Gate.",
      ),
    );
  }
  if (baseline.titlePropertyApiName !== candidate.titlePropertyApiName) {
    findings.push(
      finding(
        "compatible",
        "TITLE_PROPERTY_CHANGED",
        "/titlePropertyApiName",
        "The default title Property changed without changing stored values.",
        "No compatibility action is required.",
      ),
    );
  }
  if (!sameValue(baseline.defaultSearchPropertyApiNames, candidate.defaultSearchPropertyApiNames)) {
    findings.push(indexPlanFinding("/defaultSearchPropertyApiNames"));
  }
  if (!sameValue(baseline.defaultSort, candidate.defaultSort)) {
    findings.push(indexPlanFinding("/defaultSort"));
  }
  if (baseline.defaultClassification !== candidate.defaultClassification) {
    findings.push(
      finding(
        "conditional",
        "POLICY_SEMANTICS_REVIEW_REQUIRED",
        "/defaultClassification",
        "The default classification for future values changed.",
        "Wait for G2-03 Policy compilation and review before this change can enter READY.",
      ),
    );
  }

  const baselineProperties = byApiName(baseline.properties);
  const candidateProperties = byApiName(candidate.properties);
  for (const [apiName, property] of sortedEntries(baselineProperties)) {
    const candidateProperty = candidateProperties.get(apiName);
    const path = `/properties/${escapePointer(apiName)}`;
    if (candidateProperty === undefined) {
      findings.push(
        finding(
          "breaking",
          "PROPERTY_REMOVED",
          path,
          "A Property available to existing consumers was removed or renamed.",
          "Restore the Property or create a new API identity with an explicit alias or migration plan.",
        ),
      );
      continue;
    }
    compareProperty(property, candidateProperty, path, findings);
  }
  for (const [apiName, property] of sortedEntries(candidateProperties)) {
    if (baselineProperties.has(apiName)) continue;
    const path = `/properties/${escapePointer(apiName)}`;
    if (!property.nullable) {
      findings.push(
        finding(
          "breaking",
          "REQUIRED_PROPERTY_ADDED",
          path,
          "A required Property without a contract-level default was added.",
          "Make the Property nullable or introduce a supported default plus Materialization plan in G2-02.",
        ),
      );
    } else if (requiresIndex(property)) {
      findings.push(
        finding(
          "conditional",
          "NULLABLE_PROPERTY_INDEX_REQUIRED",
          path,
          "A nullable Property was added with query or uniqueness capabilities that require physical readiness.",
          "Produce the required Index Plan in G2-02 before this change can enter READY.",
        ),
      );
    } else {
      findings.push(
        finding(
          "compatible",
          "NULLABLE_PROPERTY_ADDED",
          path,
          "A nullable Property was added without changing existing values.",
          "No compatibility action is required.",
        ),
      );
    }
  }

  return evaluation(findings);
}

function compareLinkTypes(
  baseline: LinkTypeDefinition,
  candidate: LinkTypeDefinition,
  endpointIdentities: ReadonlyMap<string, string>,
): CompatibilityEvaluation {
  const findings: CompatibilityFindingContract[] = [];
  compareDefinitionIdentityAndText(baseline, candidate, findings);

  for (const endpoint of ["source", "target"] as const) {
    const left = baseline[endpoint];
    const right = candidate[endpoint];
    if (
      !sameEndpointResource(
        left.objectTypeRevisionId,
        right.objectTypeRevisionId,
        endpointIdentities,
      ) ||
      left.apiName !== right.apiName
    ) {
      findings.push(
        finding(
          "breaking",
          "LINK_TYPE_ENDPOINT_CHANGED",
          `/${endpoint}`,
          `The Link ${endpoint} identity or pinned Object Type Revision changed.`,
          "Create a new Link Type API identity or provide an explicit migration plan.",
        ),
      );
    } else if (left.displayName !== right.displayName) {
      findings.push(displayTextFinding(`/${endpoint}/displayName`, "endpoint display name"));
    }
  }
  if (baseline.cardinality !== candidate.cardinality) {
    findings.push(
      finding(
        "breaking",
        "LINK_TYPE_CARDINALITY_CHANGED",
        "/cardinality",
        "The Link cardinality changed.",
        "Create a new Link Type API identity or provide an explicit migration plan.",
      ),
    );
  }
  for (const field of [
    "sourceKind",
    "deletionBehavior",
    "actionCreateAllowed",
    "actionDeleteAllowed",
  ] as const) {
    if (baseline[field] === candidate[field]) continue;
    findings.push(
      finding(
        "breaking",
        `LINK_TYPE_${camelToCode(field)}_CHANGED`,
        `/${field}`,
        `The Link ${field} execution semantics changed.`,
        "Create a new Link Type API identity or provide an explicit migration plan.",
      ),
    );
  }
  return evaluation(findings);
}

function compareDefinitionIdentityAndText(
  baseline: Pick<ObjectTypeDefinition, "apiName" | "displayName" | "description">,
  candidate: Pick<ObjectTypeDefinition, "apiName" | "displayName" | "description">,
  findings: CompatibilityFindingContract[],
): void {
  if (baseline.apiName !== candidate.apiName) {
    findings.push(
      finding(
        "forbidden",
        "RESOURCE_API_NAME_CHANGED",
        "/apiName",
        "The definition API Name changed within the same Resource identity.",
        "Restore the API Name or create a new Resource identity.",
      ),
    );
  }
  if (baseline.displayName !== candidate.displayName) {
    findings.push(displayTextFinding("/displayName", "display name"));
  }
  if (baseline.description !== candidate.description) {
    findings.push(displayTextFinding("/description", "description"));
  }
}

function compareProperty(
  baseline: PropertyDefinition,
  candidate: PropertyDefinition,
  path: string,
  findings: CompatibilityFindingContract[],
): void {
  if (baseline.valueType !== candidate.valueType) {
    findings.push(
      finding(
        "breaking",
        "PROPERTY_TYPE_CHANGED",
        `${path}/valueType`,
        "The Property value type changed.",
        "Create a new Property API Name or provide an explicit conversion migration.",
      ),
    );
    return;
  }
  if (baseline.displayName !== candidate.displayName) {
    findings.push(displayTextFinding(`${path}/displayName`, "Property display name"));
  }
  if (baseline.description !== candidate.description) {
    findings.push(displayTextFinding(`${path}/description`, "Property description"));
  }
  if (baseline.nullable !== candidate.nullable) {
    findings.push(
      candidate.nullable
        ? finding(
            "compatible",
            "PROPERTY_NULLABILITY_WIDENED",
            `${path}/nullable`,
            "The Property now accepts null.",
            "No compatibility action is required.",
          )
        : finding(
            "breaking",
            "PROPERTY_NULLABILITY_NARROWED",
            `${path}/nullable`,
            "A nullable Property became required.",
            "Provide a supported default and Materialization plan or create a new Property API Name.",
          ),
    );
  }
  if (baseline.writeMode !== candidate.writeMode) {
    findings.push(
      finding(
        "breaking",
        "PROPERTY_WRITE_MODE_CHANGED",
        `${path}/writeMode`,
        "The Property write ownership semantics changed.",
        "Create a new Property API Name or provide an explicit migration plan.",
      ),
    );
  }
  if (baseline.caseSensitive !== candidate.caseSensitive) {
    findings.push(
      finding(
        "breaking",
        "PROPERTY_CASE_SENSITIVITY_CHANGED",
        `${path}/caseSensitive`,
        "The Property comparison and identity semantics changed.",
        "Create a new Property API Name or provide an explicit conversion migration.",
      ),
    );
  }
  if (baseline.classification !== candidate.classification) {
    findings.push(
      finding(
        "conditional",
        "POLICY_SEMANTICS_REVIEW_REQUIRED",
        `${path}/classification`,
        "The Property classification metadata changed.",
        "Wait for G2-03 Policy compilation and review before this change can enter READY.",
      ),
    );
  }
  compareBooleanCapability(baseline, candidate, "unique", path, findings);
  compareBooleanCapability(baseline, candidate, "filterable", path, findings);
  compareBooleanCapability(baseline, candidate, "sortable", path, findings);
  compareBooleanCapability(baseline, candidate, "searchable", path, findings);
  compareEnumValues(baseline, candidate, path, findings);
  compareDecimalBounds(baseline, candidate, path, findings);
  compareJsonFilterPaths(baseline, candidate, path, findings);
}

function compareBooleanCapability(
  baseline: PropertyDefinition,
  candidate: PropertyDefinition,
  field: "unique" | "filterable" | "sortable" | "searchable",
  path: string,
  findings: CompatibilityFindingContract[],
): void {
  if (baseline[field] === candidate[field]) return;
  if (candidate[field]) {
    findings.push(
      finding(
        "conditional",
        field === "unique" ? "PROPERTY_UNIQUENESS_VALIDATION_REQUIRED" : "PROPERTY_INDEX_REQUIRED",
        `${path}/${field}`,
        `The Property enables ${field}, which requires physical readiness evidence.`,
        field === "unique"
          ? "Validate existing values and produce the required Materialization and Index plans in G2-02."
          : "Produce the required Index Plan in G2-02 before this change can enter READY.",
      ),
    );
  } else {
    findings.push(
      finding(
        "breaking",
        field === "unique" ? "PROPERTY_UNIQUENESS_REMOVED" : "PROPERTY_QUERY_CAPABILITY_REMOVED",
        `${path}/${field}`,
        `The Property removes the existing ${field} contract.`,
        "Create a new Property API Name or provide an explicit consumer migration plan.",
      ),
    );
  }
}

function compareEnumValues(
  baseline: PropertyDefinition,
  candidate: PropertyDefinition,
  path: string,
  findings: CompatibilityFindingContract[],
): void {
  if (baseline.valueType !== "enum" || candidate.valueType !== "enum") return;
  const baselineValues = new Set(baseline.enumValues ?? []);
  const candidateValues = new Set(candidate.enumValues ?? []);
  const removed = [...baselineValues].filter((value) => !candidateValues.has(value));
  const added = [...candidateValues].filter((value) => !baselineValues.has(value));
  if (removed.length > 0) {
    findings.push(
      finding(
        "breaking",
        "ENUM_NARROWED",
        `${path}/enumValues`,
        "One or more previously valid Enum values were removed.",
        "Restore the values or create a new Property API Name with an explicit migration.",
      ),
    );
  } else if (added.length > 0) {
    findings.push(
      finding(
        "compatible",
        "ENUM_WIDENED",
        `${path}/enumValues`,
        "New Enum values were added without invalidating existing values.",
        "No compatibility action is required.",
      ),
    );
  }
}

function compareDecimalBounds(
  baseline: PropertyDefinition,
  candidate: PropertyDefinition,
  path: string,
  findings: CompatibilityFindingContract[],
): void {
  if (baseline.valueType !== "decimal" || candidate.valueType !== "decimal") return;
  const baselinePrecision = baseline.decimalPrecision;
  const baselineScale = baseline.decimalScale;
  const candidatePrecision = candidate.decimalPrecision;
  const candidateScale = candidate.decimalScale;
  if (
    baselinePrecision === undefined ||
    baselineScale === undefined ||
    candidatePrecision === undefined ||
    candidateScale === undefined ||
    (baselinePrecision === candidatePrecision && baselineScale === candidateScale)
  ) {
    return;
  }
  const preservesIntegerDigits =
    candidatePrecision - candidateScale >= baselinePrecision - baselineScale;
  const preservesFractionalDigits = candidateScale >= baselineScale;
  const widened = preservesIntegerDigits && preservesFractionalDigits;
  findings.push(
    widened
      ? finding(
          "compatible",
          "DECIMAL_RANGE_WIDENED",
          `${path}/decimalPrecision`,
          "The accepted Decimal integer and fractional ranges were both preserved or widened.",
          "No compatibility action is required.",
        )
      : finding(
          "breaking",
          "DECIMAL_RANGE_NARROWED",
          `${path}/decimalPrecision`,
          "The Decimal change loses integer range or fractional scale accepted by the baseline.",
          "Create a new Property API Name or provide an explicit conversion migration.",
        ),
  );
}

function compareJsonFilterPaths(
  baseline: PropertyDefinition,
  candidate: PropertyDefinition,
  path: string,
  findings: CompatibilityFindingContract[],
): void {
  if (baseline.valueType !== "json" || candidate.valueType !== "json") return;
  const left = new Set(baseline.jsonFilterPaths ?? []);
  const right = new Set(candidate.jsonFilterPaths ?? []);
  if ([...left].some((pointer) => !right.has(pointer))) {
    findings.push(
      finding(
        "breaking",
        "JSON_FILTER_PATH_REMOVED",
        `${path}/jsonFilterPaths`,
        "A registered JSON filter path was removed.",
        "Restore the path or provide an explicit consumer migration plan.",
      ),
    );
  } else if ([...right].some((pointer) => !left.has(pointer))) {
    findings.push(indexPlanFinding(`${path}/jsonFilterPaths`));
  }
}

function compareInstallInputs(
  baselineInputs: PackageManifestContract["installInputs"],
  candidateInputs: PackageManifestContract["installInputs"],
  findings: CompatibilityFindingContract[],
): void {
  const baselineByName = byApiName(baselineInputs);
  const candidateByName = byApiName(candidateInputs);
  for (const [apiName, baseline] of sortedEntries(baselineByName)) {
    const candidate = candidateByName.get(apiName);
    const path = `/installInputs/${escapePointer(apiName)}`;
    if (candidate === undefined) {
      findings.push(
        finding(
          "compatible",
          "PACKAGE_INSTALL_INPUT_REMOVED",
          path,
          "The candidate Package no longer requests this installation input.",
          "No compatibility action is required; retain historical input values for audit only.",
        ),
      );
      continue;
    }
    if (baseline.required !== candidate.required) {
      findings.push(
        candidate.required
          ? finding(
              "breaking",
              "PACKAGE_INSTALL_INPUT_REQUIRED",
              `${path}/required`,
              "An existing optional installation input became required.",
              "Keep the input optional or create an explicit installation migration.",
            )
          : finding(
              "compatible",
              "PACKAGE_INSTALL_INPUT_OPTIONAL",
              `${path}/required`,
              "An existing required installation input became optional.",
              "No compatibility action is required.",
            ),
      );
    }
    if (baseline.displayName !== candidate.displayName) {
      findings.push(displayTextFinding(`${path}/displayName`, "installation input display name"));
    }
    if (baseline.description !== candidate.description) {
      findings.push(displayTextFinding(`${path}/description`, "installation input description"));
    }
  }
  for (const [apiName, candidate] of sortedEntries(candidateByName)) {
    if (baselineByName.has(apiName)) continue;
    findings.push(
      candidate.required
        ? finding(
            "breaking",
            "PACKAGE_REQUIRED_INSTALL_INPUT_ADDED",
            `/installInputs/${escapePointer(apiName)}`,
            "The candidate Package adds a required installation input.",
            "Make the input optional or run an explicit installation migration that supplies it.",
          )
        : finding(
            "compatible",
            "PACKAGE_OPTIONAL_INSTALL_INPUT_ADDED",
            `/installInputs/${escapePointer(apiName)}`,
            "The candidate Package adds an optional installation input.",
            "No compatibility action is required.",
          ),
    );
  }
}

function manifestMatchesPins(
  manifest: PackageManifestContract,
  pins: readonly PackageCompatibilityPin[],
): boolean {
  const entries = manifest.resourceEntries.map(packageEntryKey).sort(compareText);
  const expanded = pins
    .map((pin) =>
      packageEntryKey({
        namespace: pin.namespace,
        apiName: pin.apiName,
        family: pin.family,
        resourceId: pin.resourceId,
        revisionId: pin.revisionId,
        contentDigest: pin.contentDigest,
      }),
    )
    .sort(compareText);
  return (
    entries.length === expanded.length && entries.every((value, index) => value === expanded[index])
  );
}

function packageEntryKey(entry: {
  readonly namespace: string;
  readonly apiName: string;
  readonly family: ResourceFamily;
  readonly resourceId: string;
  readonly revisionId: string;
  readonly contentDigest: string;
}): string {
  return [
    entry.namespace,
    entry.apiName,
    entry.family,
    entry.resourceId,
    entry.revisionId,
    entry.contentDigest,
  ].join("\u0000");
}

function evaluation(
  findingsInput: readonly CompatibilityFindingContract[],
): CompatibilityEvaluation {
  const unique = new Map<string, CompatibilityFindingContract>();
  for (const item of findingsInput) {
    unique.set(
      [item.kind, item.code, item.path, item.message, item.requiredNextStep].join("\u0000"),
      item,
    );
  }
  const findings = Object.freeze([...unique.values()].sort(compareFindings));
  const rank: Readonly<Record<CompatibilityFindingContract["kind"], number>> = {
    compatible: 0,
    conditional: 1,
    breaking: 2,
    forbidden: 3,
  };
  let outcome: CompatibilityReportContract["outcome"] = "compatible";
  for (const item of findings) if (rank[item.kind] > rank[outcome]) outcome = item.kind;
  return Object.freeze({ outcome, findings });
}

function finding(
  kind: CompatibilityFindingContract["kind"],
  code: string,
  path: string,
  message: string,
  requiredNextStep: string,
): CompatibilityFindingContract {
  return Object.freeze({ kind, code, path, message, requiredNextStep });
}

function displayTextFinding(path: string, subject: string): CompatibilityFindingContract {
  return finding(
    "compatible",
    "DISPLAY_TEXT_CHANGED",
    path,
    `The ${subject} changed without changing API semantics.`,
    "No compatibility action is required.",
  );
}

function indexPlanFinding(path: string): CompatibilityFindingContract {
  return finding(
    "conditional",
    "INDEX_PLAN_REQUIRED",
    path,
    "The query shape changed and requires an Index Plan that G2-01 cannot prove ready.",
    "Produce and verify the required Index Plan in G2-02 before this change can enter READY.",
  );
}

function requiresIndex(property: PropertyDefinition): boolean {
  return property.unique || property.filterable || property.sortable || property.searchable;
}

function byApiName<T extends { readonly apiName: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.apiName, item]));
}

function uniquePinsByResource(
  pins: readonly PinnedCompatibilityRevision[],
  label: string,
): Map<string, PinnedCompatibilityRevision> {
  const result = new Map<string, PinnedCompatibilityRevision>();
  for (const pin of pins) {
    if (result.has(pin.resourceId)) {
      throw new TypeError(`Duplicate ${label} Resource Pin: ${pin.resourceId}`);
    }
    result.set(pin.resourceId, pin);
  }
  return result;
}

function endpointIdentityMap(
  identities: readonly EndpointRevisionIdentity[],
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const identity of identities) {
    const existing = result.get(identity.revisionId);
    if (existing !== undefined && existing !== identity.resourceId) {
      throw new TypeError(`Revision identity maps to multiple Resources: ${identity.revisionId}`);
    }
    result.set(identity.revisionId, identity.resourceId);
  }
  return result;
}

function sameEndpointResource(
  baselineRevisionId: string,
  candidateRevisionId: string,
  identities: ReadonlyMap<string, string>,
): boolean {
  if (baselineRevisionId === candidateRevisionId) return true;
  const baselineResourceId = identities.get(baselineRevisionId);
  const candidateResourceId = identities.get(candidateRevisionId);
  return baselineResourceId !== undefined && baselineResourceId === candidateResourceId;
}

function sortedEntries<T>(map: ReadonlyMap<string, T>): readonly (readonly [string, T])[] {
  return [...map.entries()].sort(([left], [right]) => compareText(left, right));
}

function prefixFindings(
  findings: readonly CompatibilityFindingContract[],
  prefix: string,
): readonly CompatibilityFindingContract[] {
  return findings.map((item) => Object.freeze({ ...item, path: `${prefix}${item.path}` }));
}

function compareFindings(
  left: CompatibilityFindingContract,
  right: CompatibilityFindingContract,
): number {
  return (
    compareText(left.path, right.path) ||
    compareText(left.code, right.code) ||
    compareText(left.kind, right.kind) ||
    compareText(left.requiredNextStep, right.requiredNextStep) ||
    compareText(left.message, right.message)
  );
}

function compareDependencies(
  left: PinnedCompatibilityDependency,
  right: PinnedCompatibilityDependency,
): number {
  return (
    compareText(left.sourceRevisionId, right.sourceRevisionId) ||
    compareText(left.targetRevisionId, right.targetRevisionId) ||
    compareText(left.dependencyType, right.dependencyType) ||
    compareText(left.sourcePath, right.sourcePath)
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalizeContractForDigest(left) === canonicalizeContractForDigest(right);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function camelToCode(value: string): string {
  return value.replaceAll(/([a-z])([A-Z])/gu, "$1_$2").toUpperCase();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
