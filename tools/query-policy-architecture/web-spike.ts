import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

interface MutationResult {
  readonly id: "required" | "enum" | "nullability";
  readonly generated: true;
  readonly consumerCompileRejected: true;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const specPath = resolve(repositoryRoot, "spikes/g2-03-01/openapi/runtime-read.candidate.json");
const webRoot = resolve(repositoryRoot, "spikes/g2-03-01/web");
const committedGenerated = resolve(webRoot, "src/generated");
const nodeModules = resolve(repositoryRoot, "node_modules");
const generatorEntry = resolve(nodeModules, "@hey-api/openapi-ts/bin/run.js");
const typescriptEntry = resolve(nodeModules, "typescript/bin/tsc");
const viteEntry = resolve(nodeModules, "vite/bin/vite.js");

export async function runWebSpike(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ontos-g2-03-01-web-"));
  try {
    const baselineGenerated = resolve(temporaryRoot, "baseline/generated");
    await runGenerator(specPath, baselineGenerated);
    const committedFiles = await filesIn(committedGenerated);
    const regeneratedFiles = await filesIn(baselineGenerated);
    if (committedFiles.join("\0") !== regeneratedFiles.join("\0")) {
      throw new Error("G2_03_01_GENERATED_FILE_SET_DRIFT");
    }
    for (const path of committedFiles) {
      const [committed, regenerated] = await Promise.all([
        readFile(resolve(committedGenerated, path)),
        readFile(resolve(baselineGenerated, path)),
      ]);
      if (!committed.equals(regenerated)) {
        throw new Error(`G2_03_01_GENERATED_CLIENT_DRIFT:${path}`);
      }
    }

    await mustPass(
      process.execPath,
      [typescriptEntry, "-p", resolve(webRoot, "tsconfig.json"), "--noEmit"],
      repositoryRoot,
      "G2_03_01_WEB_TYPECHECK_FAILED",
    );
    await mustPass(
      process.execPath,
      [
        viteEntry,
        "build",
        "--config",
        resolve(webRoot, "vite.config.ts"),
        "--outDir",
        resolve(temporaryRoot, "vite-dist"),
        "--emptyOutDir",
      ],
      webRoot,
      "G2_03_01_WEB_BUILD_FAILED",
    );
    await assertConsumerBoundary();

    const baselineSpec: unknown = JSON.parse(await readFile(specPath, "utf8"));
    const mutations: MutationResult[] = [];
    for (const id of ["required", "enum", "nullability"] as const) {
      const mutated = structuredClone(baselineSpec);
      mutateSpec(mutated, id);
      const mutationRoot = resolve(temporaryRoot, `mutation-${id}`);
      const mutationSpec = resolve(mutationRoot, "runtime-read.json");
      const mutationGenerated = resolve(mutationRoot, "generated");
      await mkdir(mutationRoot, { recursive: true });
      await writeFile(mutationSpec, `${JSON.stringify(mutated, null, 2)}\n`);
      await runGenerator(mutationSpec, mutationGenerated);
      await writeMutationWitness(mutationRoot);
      const compile = await capture(
        process.execPath,
        [typescriptEntry, "-p", resolve(mutationRoot, "tsconfig.json"), "--noEmit"],
        repositoryRoot,
      );
      if (compile.exitCode === 0) throw new Error(`G2_03_01_MUTATION_SURVIVED:${id}`);
      mutations.push({ id, generated: true, consumerCompileRejected: true });
    }

    const packageManifest = parseRecord(
      JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8")) as unknown,
      "package.json",
    );
    const dependencies = parseRecord(packageManifest["devDependencies"], "devDependencies");
    const versions = Object.freeze({
      node: process.versions.node,
      typescript: stringProperty(dependencies, "typescript"),
      openapiGenerator: stringProperty(dependencies, "@hey-api/openapi-ts"),
      react: stringProperty(dependencies, "react"),
      reactDom: stringProperty(dependencies, "react-dom"),
      reactRouter: stringProperty(dependencies, "react-router"),
      vite: stringProperty(dependencies, "vite"),
      reactPlugin: stringProperty(dependencies, "@vitejs/plugin-react"),
      oidc: stringProperty(dependencies, "oidc-client-ts"),
      query: stringProperty(dependencies, "@tanstack/react-query"),
      table: stringProperty(dependencies, "@tanstack/react-table"),
      browserTest: stringProperty(dependencies, "@playwright/test"),
    });
    if (Object.values(versions).some((value) => value.length === 0)) {
      throw new Error("G2_03_01_WEB_STACK_VERSION_MISSING");
    }
    const artifact = Object.freeze({
      schemaVersion: 1,
      gate: "G2-03-01",
      status: "PASS",
      qualification: "OPENAPI_GENERATED_CLIENT_CONSUMER_COMPILE",
      input: Object.freeze({
        path: relative(repositoryRoot, specPath),
        sha256: await sha256File(specPath),
        operationCount: 3,
      }),
      generated: Object.freeze({
        path: relative(repositoryRoot, committedGenerated),
        fileCount: committedFiles.length,
        sha256: await sha256Directory(committedGenerated, committedFiles),
        deterministicRegeneration: true,
      }),
      consumer: Object.freeze({
        typecheck: true,
        productionBuild: true,
        generatedClientOnly: true,
        workspaceInternalImports: 0,
        domainSpecificFields: 0,
        strictTypeScript: true,
        exactOptionalPropertyTypes: false,
        exactOptionalReason:
          "Generated fetch-client source 0.99.0 is not compatible with exactOptionalPropertyTypes; the exception is isolated to this compile-only Spike and must be re-evaluated before apps/web.",
      }),
      mutations: Object.freeze(mutations),
      versions,
      supplyChain: Object.freeze({
        jsYamlOverride: "4.3.1",
        reason:
          "Closes current quadratic-CPU YAML parser advisories in the generator dependency tree.",
      }),
    });
    const outputDirectory = resolve(repositoryRoot, "generated/ci-report");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      resolve(outputDirectory, "g2-03-01-web-spike.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
    process.stdout.write(
      `g2-03-01 web spike: PASS (${String(committedFiles.length)} generated files, ${String(mutations.length)} breaking mutations)\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runGenerator(input: string, output: string): Promise<void> {
  await mustPass(
    process.execPath,
    [generatorEntry, "--input", input, "--output", output, "--silent"],
    repositoryRoot,
    "G2_03_01_OPENAPI_GENERATION_FAILED",
  );
}

async function assertConsumerBoundary(): Promise<void> {
  const sourceRoot = resolve(webRoot, "src");
  const sourceFiles = (await filesIn(sourceRoot)).filter(
    (path) => !path.startsWith("generated/") && (path.endsWith(".ts") || path.endsWith(".tsx")),
  );
  for (const path of sourceFiles) {
    const contents = await readFile(resolve(sourceRoot, path), "utf8");
    if (/@ontos\//u.test(contents) || /(?:packages|apps)\//u.test(contents)) {
      throw new Error(`G2_03_01_WEB_INTERNAL_IMPORT:${path}`);
    }
    if (/Customer|Order|Worker|WorkItem/u.test(contents)) {
      throw new Error(`G2_03_01_WEB_DOMAIN_BRANCH:${path}`);
    }
  }
}

function mutateSpec(value: unknown, id: MutationResult["id"]): void {
  const root = parseRecord(value, "OpenAPI");
  const components = parseRecord(root["components"], "components");
  const schemas = parseRecord(components["schemas"], "schemas");
  if (id === "required") {
    const metadata = parseRecord(schemas["ObjectTypeMetadata"], "ObjectTypeMetadata");
    const required = stringArray(metadata["required"], "ObjectTypeMetadata.required");
    metadata["required"] = required.filter((name) => name !== "apiName");
    return;
  }
  if (id === "enum") {
    const disposition = parseRecord(schemas["PolicyDisposition"], "PolicyDisposition");
    disposition["enum"] = [...stringArray(disposition["enum"], "PolicyDisposition.enum"), "deny"];
    return;
  }
  const metadata = parseRecord(schemas["ObjectTypeMetadata"], "ObjectTypeMetadata");
  const properties = parseRecord(metadata["properties"], "ObjectTypeMetadata.properties");
  const displayName = parseRecord(properties["displayName"], "displayName");
  displayName["type"] = ["string", "null"];
}

async function writeMutationWitness(root: string): Promise<void> {
  await writeFile(
    resolve(root, "witness.ts"),
    `import type { ObjectTypeMetadata, PolicyDisposition } from "./generated/types.gen.ts";\n\n` +
      `export function requiredWitness(value: ObjectTypeMetadata): string {\n` +
      `  const apiName: string = value.apiName;\n` +
      `  const displayName: string = value.displayName;\n` +
      `  return apiName + displayName;\n` +
      `}\n\n` +
      `export function enumWitness(value: PolicyDisposition): string {\n` +
      `  switch (value) {\n` +
      `    case "allow": return "allow";\n` +
      `    case "mask": return "mask";\n` +
      `    case "restricted": return "restricted";\n` +
      `    default: { const neverValue: never = value; return neverValue; }\n` +
      `  }\n` +
      `}\n`,
  );
  await writeFile(
    resolve(root, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2024",
          lib: ["ES2024", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          exactOptionalPropertyTypes: false,
          noEmit: true,
          isolatedModules: true,
          allowImportingTsExtensions: true,
          skipLibCheck: false,
        },
        include: ["witness.ts", "generated/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
}

async function filesIn(root: string, prefix = ""): Promise<readonly string[]> {
  const entries = await readdir(resolve(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

async function sha256Directory(root: string, paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(resolve(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function mustPass(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  errorCode: string,
): Promise<void> {
  const result = await capture(command, arguments_, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`${errorCode}:${result.output.slice(-4_000)}`);
  }
}

function capture(
  command: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(command, [...arguments_], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const receive = (chunk: Buffer): void => {
      output = `${output}${chunk.toString("utf8")}`.slice(-20_000);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("error", rejectCapture);
    child.once("close", (code, signal) => {
      if (signal !== null) rejectCapture(new Error(`${command} ended with ${signal}.`));
      else resolveCapture({ exitCode: code ?? 1, output });
    });
  });
}

function parseRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function stringProperty(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string") throw new Error(`${key} is missing.`);
  return candidate;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runWebSpike();
}
