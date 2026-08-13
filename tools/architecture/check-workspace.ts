import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

interface ArchitecturePolicy {
  readonly schemaVersion: number;
  readonly packageNamePrefix: string;
  readonly workspaceRoots: readonly string[];
  readonly layers: readonly string[];
  readonly allowedLayersByRoot: Readonly<Record<string, readonly string[]>>;
  readonly allowedWorkspaceDependencies: Readonly<Record<string, readonly string[]>>;
  readonly requireRootExportLayers: readonly string[];
  readonly allowedExternalRuntimeDependencies: Readonly<Record<string, readonly string[]>>;
  readonly allowedExternalImports: Readonly<Record<string, readonly string[]>>;
  readonly forbidDeepWorkspaceImports: boolean;
}

interface PackageManifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly exports?: unknown;
  readonly ontos?: {
    readonly layer?: string;
  };
}

interface WorkspacePackage {
  readonly name: string;
  readonly directory: string;
  readonly workspaceRoot: string;
  readonly layer: string;
  readonly manifest: PackageManifest;
}

export interface ArchitectureViolation {
  readonly code: string;
  readonly message: string;
  readonly packageName?: string;
  readonly file?: string;
  readonly dependency?: string;
}

export interface ArchitectureResult {
  readonly packageCount: number;
  readonly sourceFileCount: number;
  readonly violations: readonly ArchitectureViolation[];
}

const sourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

export async function loadPolicy(policyPath: string): Promise<ArchitecturePolicy> {
  const candidate: unknown = JSON.parse(await readFile(policyPath, "utf8"));
  if (!isRecord(candidate) || candidate.schemaVersion !== 1) {
    throw new Error(`Unsupported architecture policy at ${policyPath}.`);
  }

  const requiredArrays = ["workspaceRoots", "layers", "requireRootExportLayers"];
  for (const key of requiredArrays) {
    if (!isStringArray(candidate[key]))
      throw new Error(`Architecture policy field ${key} is invalid.`);
  }

  if (
    typeof candidate.packageNamePrefix !== "string" ||
    !isRecordOfStringArrays(candidate.allowedLayersByRoot) ||
    !isRecordOfStringArrays(candidate.allowedWorkspaceDependencies) ||
    !isRecordOfStringArrays(candidate.allowedExternalRuntimeDependencies) ||
    !isRecordOfStringArrays(candidate.allowedExternalImports) ||
    typeof candidate.forbidDeepWorkspaceImports !== "boolean"
  ) {
    throw new Error(`Architecture policy at ${policyPath} is incomplete.`);
  }

  return candidate as unknown as ArchitecturePolicy;
}

export async function checkWorkspace(
  repositoryRoot: string,
  policy: ArchitecturePolicy,
): Promise<ArchitectureResult> {
  const root = resolve(repositoryRoot);
  const violations: ArchitectureViolation[] = [];
  const packages = await discoverPackages(root, policy, violations);
  const packagesByName = new Map<string, WorkspacePackage>();

  for (const workspacePackage of packages) {
    const previous = packagesByName.get(workspacePackage.name);
    if (previous) {
      violations.push({
        code: "DUPLICATE_PACKAGE_NAME",
        message: `${workspacePackage.name} is declared by both ${displayPath(root, previous.directory)} and ${displayPath(root, workspacePackage.directory)}.`,
        packageName: workspacePackage.name,
      });
      continue;
    }
    packagesByName.set(workspacePackage.name, workspacePackage);
  }

  const graph = new Map<string, Set<string>>();
  let sourceFileCount = 0;
  for (const workspacePackage of packages) {
    graph.set(workspacePackage.name, new Set());
    checkLocationAndExports(workspacePackage, policy, violations);
    checkManifestDependencies(workspacePackage, packagesByName, graph, policy, violations);
    sourceFileCount += await checkSourceImports(
      root,
      workspacePackage,
      packages,
      packagesByName,
      policy,
      violations,
    );
  }

  checkCycles(graph, violations);
  violations.sort((left, right) =>
    `${left.code}:${left.packageName ?? ""}:${left.file ?? ""}:${left.message}`.localeCompare(
      `${right.code}:${right.packageName ?? ""}:${right.file ?? ""}:${right.message}`,
    ),
  );

  return { packageCount: packages.length, sourceFileCount, violations };
}

async function discoverPackages(
  root: string,
  policy: ArchitecturePolicy,
  violations: ArchitectureViolation[],
): Promise<WorkspacePackage[]> {
  const result: WorkspacePackage[] = [];
  for (const workspaceRoot of policy.workspaceRoots) {
    const rootDirectory = join(root, workspaceRoot);
    let entries;
    try {
      entries = await readdir(rootDirectory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(rootDirectory, entry.name);
      let manifest: PackageManifest;
      try {
        const candidate: unknown = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        );
        if (!isPackageManifest(candidate)) {
          throw new Error("package.json does not match the supported manifest shape");
        }
        manifest = candidate;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw new Error(
          `Cannot read ${displayPath(root, join(directory, "package.json"))}: ${String(error)}`,
          { cause: error },
        );
      }

      if (!manifest.name || !manifest.name.startsWith(policy.packageNamePrefix)) {
        violations.push({
          code: "INVALID_PACKAGE_NAME",
          message: `${displayPath(root, directory)} must declare a name beginning with ${policy.packageNamePrefix}.`,
        });
        continue;
      }
      const layer = manifest.ontos?.layer;
      if (!layer || !policy.layers.includes(layer)) {
        violations.push({
          code: "MISSING_OR_INVALID_LAYER",
          message: `${manifest.name} must declare ontos.layer as one of: ${policy.layers.join(", ")}.`,
          packageName: manifest.name,
        });
        continue;
      }

      result.push({ name: manifest.name, directory, workspaceRoot, layer, manifest });
    }
  }
  return result;
}

function checkLocationAndExports(
  workspacePackage: WorkspacePackage,
  policy: ArchitecturePolicy,
  violations: ArchitectureViolation[],
): void {
  const allowedLayers = policy.allowedLayersByRoot[workspacePackage.workspaceRoot] ?? [];
  if (!allowedLayers.includes(workspacePackage.layer)) {
    violations.push({
      code: "LAYER_LOCATION_VIOLATION",
      message: `${workspacePackage.name} uses layer ${workspacePackage.layer}, which is not allowed under ${workspacePackage.workspaceRoot}/.`,
      packageName: workspacePackage.name,
    });
  }

  if (!policy.requireRootExportLayers.includes(workspacePackage.layer)) return;
  if (workspacePackage.manifest.exports === undefined) {
    violations.push({
      code: "MISSING_PACKAGE_EXPORTS",
      message: `${workspacePackage.name} must expose an explicit root export and keep internal paths private.`,
      packageName: workspacePackage.name,
    });
    return;
  }

  if (policy.forbidDeepWorkspaceImports && hasExportedSubpath(workspacePackage.manifest.exports)) {
    violations.push({
      code: "EXPORTED_INTERNAL_SUBPATH",
      message: `${workspacePackage.name} may only expose the package root during G2-00.`,
      packageName: workspacePackage.name,
    });
  }
}

function checkManifestDependencies(
  workspacePackage: WorkspacePackage,
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
  graph: Map<string, Set<string>>,
  policy: ArchitecturePolicy,
  violations: ArchitectureViolation[],
): void {
  const dependencies = runtimeDependencies(workspacePackage.manifest);
  const allowedExternalDependencies =
    policy.allowedExternalRuntimeDependencies[workspacePackage.layer] ?? [];

  for (const dependency of dependencies) {
    const target = packagesByName.get(dependency);
    if (target) {
      graph.get(workspacePackage.name)?.add(target.name);
      const allowedLayers = policy.allowedWorkspaceDependencies[workspacePackage.layer] ?? [];
      if (!allowedLayers.includes(target.layer)) {
        violations.push({
          code: "WORKSPACE_LAYER_VIOLATION",
          message: `${workspacePackage.name} (${workspacePackage.layer}) cannot depend on ${target.name} (${target.layer}).`,
          packageName: workspacePackage.name,
          dependency,
        });
      }
      continue;
    }

    if (dependency.startsWith(policy.packageNamePrefix)) {
      violations.push({
        code: "UNKNOWN_WORKSPACE_DEPENDENCY",
        message: `${workspacePackage.name} declares missing workspace dependency ${dependency}.`,
        packageName: workspacePackage.name,
        dependency,
      });
      continue;
    }

    if (!allowedExternalDependencies.some((pattern) => dependencyMatches(dependency, pattern))) {
      violations.push({
        code: "FORBIDDEN_EXTERNAL_DEPENDENCY",
        message: `${workspacePackage.name} (${workspacePackage.layer}) cannot declare non-allowlisted runtime dependency ${dependency}.`,
        packageName: workspacePackage.name,
        dependency,
      });
    }
  }
}

async function checkSourceImports(
  root: string,
  workspacePackage: WorkspacePackage,
  packages: readonly WorkspacePackage[],
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
  policy: ArchitecturePolicy,
  violations: ArchitectureViolation[],
): Promise<number> {
  const sourceRoot = join(workspacePackage.directory, "src");
  const files = await listSourceFiles(sourceRoot);
  const declaredDependencies = runtimeDependencies(workspacePackage.manifest);
  const allowedExternalImports = policy.allowedExternalImports[workspacePackage.layer] ?? [];

  for (const file of files) {
    const contents = await readFile(file, "utf8");
    for (const specifier of moduleSpecifiers(file, contents)) {
      if (specifier.startsWith(".")) {
        const targetPath = resolve(dirname(file), specifier);
        const otherPackage = packages.find(
          (candidate) =>
            candidate.name !== workspacePackage.name && isInside(candidate.directory, targetPath),
        );
        if (otherPackage) {
          violations.push({
            code: "CROSS_PACKAGE_RELATIVE_IMPORT",
            message: `${workspacePackage.name} crosses into ${otherPackage.name} with relative import ${specifier}.`,
            packageName: workspacePackage.name,
            file: displayPath(root, file),
            dependency: otherPackage.name,
          });
        }
        continue;
      }

      const targetName = workspacePackageName(specifier, policy.packageNamePrefix);
      if (targetName) {
        const target = packagesByName.get(targetName);
        if (!target) continue;
        if (!declaredDependencies.has(targetName) && targetName !== workspacePackage.name) {
          violations.push({
            code: "UNDECLARED_WORKSPACE_IMPORT",
            message: `${workspacePackage.name} imports ${targetName} without a runtime dependency declaration.`,
            packageName: workspacePackage.name,
            file: displayPath(root, file),
            dependency: targetName,
          });
        }
        if (policy.forbidDeepWorkspaceImports && specifier !== targetName) {
          violations.push({
            code: "DEEP_WORKSPACE_IMPORT",
            message: `${workspacePackage.name} must import ${targetName} through its package root, not ${specifier}.`,
            packageName: workspacePackage.name,
            file: displayPath(root, file),
            dependency: targetName,
          });
        }
        continue;
      }

      const externalName = externalPackageName(specifier);
      if (!allowedExternalImports.some((pattern) => dependencyMatches(externalName, pattern))) {
        violations.push({
          code: "FORBIDDEN_EXTERNAL_IMPORT",
          message: `${workspacePackage.name} (${workspacePackage.layer}) cannot import non-allowlisted external module ${externalName} from production source.`,
          packageName: workspacePackage.name,
          file: displayPath(root, file),
          dependency: externalName,
        });
      }
    }
  }

  return files.length;
}

function checkCycles(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  violations: ArchitectureViolation[],
): void {
  const state = new Map<string, "visiting" | "visited">();
  const path: string[] = [];
  const emitted = new Set<string>();

  function visit(node: string): void {
    if (state.get(node) === "visited") return;
    if (state.get(node) === "visiting") {
      const start = path.indexOf(node);
      const cycle = [...path.slice(start), node];
      const key = canonicalCycle(cycle);
      if (!emitted.has(key)) {
        emitted.add(key);
        violations.push({
          code: "WORKSPACE_DEPENDENCY_CYCLE",
          message: `Workspace dependency cycle: ${cycle.join(" -> ")}.`,
          packageName: node,
        });
      }
      return;
    }

    state.set(node, "visiting");
    path.push(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    path.pop();
    state.set(node, "visited");
  }

  for (const node of graph.keys()) visit(node);
}

async function listSourceFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listSourceFiles(path)));
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files.sort();
}

function moduleSpecifiers(file: string, contents: string): string[] {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const result: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      result.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (node.arguments.length === 1 && argument && ts.isStringLiteral(argument)) {
        result.push(argument.text);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      result.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return result;
}

function runtimeDependencies(manifest: PackageManifest): Set<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

function workspacePackageName(specifier: string, prefix: string): string | undefined {
  if (!specifier.startsWith(prefix)) return undefined;
  const segments = specifier.split("/");
  return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined;
}

function externalPackageName(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier;
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? `${segments[0]}/${segments[1]}` : (segments[0] ?? specifier);
}

function dependencyMatches(dependency: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return dependency.startsWith(pattern.slice(0, -1));
  return dependency === pattern;
}

function hasExportedSubpath(exportsField: unknown): boolean {
  if (!isRecord(exportsField)) return false;
  return Object.keys(exportsField).some((key) => key.startsWith(".") && key !== ".");
}

function canonicalCycle(cycle: readonly string[]): string {
  const nodes = cycle.slice(0, -1);
  if (nodes.length === 0) return "";
  const rotations = nodes.map((_, index) =>
    [...nodes.slice(index), ...nodes.slice(0, index)].join("|"),
  );
  return rotations.sort()[0] ?? "";
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function displayPath(root: string, path: string): string {
  const displayed = relative(root, path);
  return displayed || ".";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecordOfStringArrays(value: unknown): value is Record<string, string[]> {
  return isRecord(value) && Object.values(value).every(isStringArray);
}

function isPackageManifest(value: unknown): value is PackageManifest {
  if (!isRecord(value)) return false;
  const optionalStringRecords = [
    value.dependencies,
    value.optionalDependencies,
    value.peerDependencies,
    value.devDependencies,
  ];

  return (
    (value.name === undefined || typeof value.name === "string") &&
    (value.private === undefined || typeof value.private === "boolean") &&
    optionalStringRecords.every(
      (candidate) =>
        candidate === undefined ||
        (isRecord(candidate) && Object.values(candidate).every((item) => typeof item === "string")),
    ) &&
    (value.ontos === undefined ||
      (isRecord(value.ontos) &&
        (value.ontos.layer === undefined || typeof value.ontos.layer === "string")))
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function main(): Promise<void> {
  const rootArgument = argumentValue("--root") ?? process.cwd();
  const policyArgument =
    argumentValue("--policy") ?? join(dirname(fileURLToPath(import.meta.url)), "policy.json");
  const result = await checkWorkspace(
    resolve(rootArgument),
    await loadPolicy(resolve(policyArgument)),
  );

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      const location = violation.file ? ` ${violation.file}` : "";
      console.error(`${violation.code}${location}: ${violation.message}`);
    }
    console.error(
      `architecture: FAIL (${result.violations.length} violation(s), ${result.packageCount} package(s))`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `architecture: PASS (${result.packageCount} package(s), ${result.sourceFileCount} source file(s))`,
  );
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
