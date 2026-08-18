import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { format as formatText } from "prettier";

import { buildRuntimeReadSchema } from "./runtime-read-schema-source.ts";

type JsonRecord = Record<string, unknown>;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schemaPath = resolve(repositoryRoot, "packages/contracts/schemas/runtime-read.schema.json");
const foundationSchemaPath = resolve(
  repositoryRoot,
  "packages/contracts/schemas/foundation.schema.json",
);
const openApiPath = resolve(
  repositoryRoot,
  "packages/contracts/openapi/runtime-read.candidate.json",
);
const clientRoot = resolve(repositoryRoot, "packages/runtime-read-client/generated");
const clientDistributionRoot = resolve(repositoryRoot, "packages/runtime-read-client/dist");
const generatorEntry = resolve(repositoryRoot, "node_modules/@hey-api/openapi-ts/bin/run.js");
const typescriptEntry = resolve(repositoryRoot, "node_modules/typescript/bin/tsc");

export interface RuntimeReadGenerationResult {
  readonly schemaSha256: string;
  readonly openApiSha256: string;
  readonly generatedSha256: string;
  readonly generatedFileCount: number;
  readonly distributionSha256: string;
  readonly distributionFileCount: number;
  readonly operationCount: number;
  readonly deterministic: true;
  readonly generatedClientCompiled: true;
  readonly strictPublicTypesCompiled: true;
  readonly strictWebConsumerCompiled: true;
  readonly distributionRuntimeImported: true;
}

export async function writeRuntimeReadArtifacts(): Promise<void> {
  const schema = buildRuntimeReadSchema();
  const foundation = parseRecord(
    JSON.parse(await readFile(foundationSchemaPath, "utf8")) as unknown,
    "Foundation Schema",
  );
  const openApi = buildRuntimeReadOpenApi(schema, foundation);
  await Promise.all([
    mkdir(dirname(schemaPath), { recursive: true }),
    mkdir(dirname(openApiPath), { recursive: true }),
    mkdir(dirname(clientRoot), { recursive: true }),
  ]);
  await Promise.all([writeJson(schemaPath, schema), writeJson(openApiPath, openApi)]);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ontos-runtime-read-write-"));
  try {
    await runGenerator(openApiPath, clientRoot);
    await compileClientDistribution(clientRoot, clientDistributionRoot, temporaryRoot);
    await assertClientDistributionExports(clientDistributionRoot);
    process.stdout.write("runtime read artifacts: GENERATED\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function checkRuntimeReadArtifacts(): Promise<RuntimeReadGenerationResult> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ontos-runtime-read-contract-"));
  try {
    const generatedSchema = resolve(temporaryRoot, "runtime-read.schema.json");
    const generatedOpenApi = resolve(temporaryRoot, "runtime-read.openapi.json");
    const generatedClient = resolve(temporaryRoot, "generated-client");
    const generatedDistribution = resolve(temporaryRoot, "client-dist");
    const schema = buildRuntimeReadSchema();
    const foundation = parseRecord(
      JSON.parse(await readFile(foundationSchemaPath, "utf8")) as unknown,
      "Foundation Schema",
    );
    const openApi = buildRuntimeReadOpenApi(schema, foundation);
    await Promise.all([writeJson(generatedSchema, schema), writeJson(generatedOpenApi, openApi)]);
    await assertSameFile(schemaPath, generatedSchema, "RUNTIME_READ_SCHEMA_DRIFT");
    await assertSameFile(openApiPath, generatedOpenApi, "RUNTIME_READ_OPENAPI_DRIFT");
    await runGenerator(generatedOpenApi, generatedClient);
    await compileClientDistribution(
      generatedClient,
      generatedDistribution,
      resolve(temporaryRoot, "client-build"),
    );
    await assertSameDirectory(clientRoot, generatedClient, "RUNTIME_READ_CLIENT_DRIFT");
    await assertSameDirectory(
      clientDistributionRoot,
      generatedDistribution,
      "RUNTIME_READ_CLIENT_DISTRIBUTION_DRIFT",
    );
    await mustPass(
      process.execPath,
      [
        typescriptEntry,
        "-p",
        resolve(repositoryRoot, "packages/runtime-read-client/tsconfig.json"),
      ],
      repositoryRoot,
      "RUNTIME_READ_CLIENT_COMPILE_FAILED",
    );
    await assertStrictPublicTypesCompile(temporaryRoot);
    await assertStrictWebConsumerCompile();
    await assertClientDistributionExports(generatedDistribution);

    const generatedFiles = await filesIn(clientRoot);
    const distributionFiles = await filesIn(clientDistributionRoot);
    const result = Object.freeze({
      schemaSha256: await sha256File(schemaPath),
      openApiSha256: await sha256File(openApiPath),
      generatedSha256: await sha256Directory(clientRoot, generatedFiles),
      generatedFileCount: generatedFiles.length,
      distributionSha256: await sha256Directory(clientDistributionRoot, distributionFiles),
      distributionFileCount: distributionFiles.length,
      operationCount: countOperations(openApi),
      deterministic: true as const,
      generatedClientCompiled: true as const,
      strictPublicTypesCompiled: true as const,
      strictWebConsumerCompiled: true as const,
      distributionRuntimeImported: true as const,
    });
    const outputDirectory = resolve(repositoryRoot, "generated/ci-report");
    await mkdir(outputDirectory, { recursive: true });
    await writeJson(resolve(outputDirectory, "g2-03-02-runtime-read-generation.json"), {
      schemaVersion: 1,
      gate: "G2-03-02",
      status: "PASS",
      qualification: "SINGLE_SOURCE_SCHEMA_OPENAPI_GENERATED_CLIENT",
      ...result,
      exactOptionalPropertyTypes: {
        publicTypes: true,
        generatedTransport: false,
        packagedWebConsumer: true,
        isolation:
          "The 0.99.0 generated transport compiles once with exactOptionalPropertyTypes=false, emits deterministic JavaScript and declarations, and a Web-shaped consumer imports that package boundary with exactOptionalPropertyTypes=true.",
      },
    });
    process.stdout.write(
      `runtime read generation: PASS (${String(result.operationCount)} operations, ${String(result.generatedFileCount)} source files, ${String(result.distributionFileCount)} distribution files)\n`,
    );
    return result;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function buildRuntimeReadOpenApi(
  schemaValue: Readonly<Record<string, unknown>>,
  foundationValue: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const runtimeDefinitions = parseRecord(schemaValue.$defs, "Runtime Read definitions");
  const foundationDefinitions = parseRecord(foundationValue.$defs, "Foundation definitions");
  const publicRoots = [
    "RuntimeSearchRequest",
    "RuntimeCountRequest",
    "RuntimeLinkSearchRequest",
    "RuntimeMetadataResponse",
    "RuntimeObjectGetResponse",
    "RuntimeSearchResponse",
    "RuntimeCountResponse",
    "RuntimeLinkSearchResponse",
  ];
  const publicDefinitions = collectDefinitions(runtimeDefinitions, publicRoots);
  const errorDefinitions = collectDefinitions(foundationDefinitions, ["ErrorEnvelope"]);
  for (const [name, definition] of Object.entries(errorDefinitions)) {
    const existing = publicDefinitions[name];
    if (existing !== undefined && stableJson(existing) !== stableJson(definition)) {
      throw new Error(`Runtime and Foundation definition ${name} disagree.`);
    }
    publicDefinitions[name] = definition;
  }
  const schemas = rewriteReferences(publicDefinitions);
  const runtimeError = {
    description: "Stable fail-closed Runtime error.",
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } },
    },
  };
  const operationResponse = (definition: string): JsonRecord => ({
    description: "Successful policy-filtered Runtime read.",
    content: {
      "application/json": { schema: { $ref: `#/components/schemas/${definition}` } },
    },
  });
  const requestBody = (definition: string): JsonRecord => ({
    required: true,
    content: {
      "application/json": { schema: { $ref: `#/components/schemas/${definition}` } },
    },
  });
  const error = { $ref: "#/components/responses/RuntimeError" };
  return Object.freeze({
    openapi: "3.1.0",
    info: {
      title: "Ontos Runtime Read Candidate",
      version: "0.2.0-candidate",
      description:
        "G2-03 Runtime Read Candidate generated from the formal kernel contract. It is consumed in-repo but is not a published SDK support commitment.",
    },
    servers: [{ url: "https://runtime.example.invalid" }],
    security: [{ oidc: ["runtime.read"] }],
    paths: {
      "/api/v1/ontologies/{ontology}/metadata": {
        get: {
          operationId: "getRuntimeMetadata",
          parameters: [{ $ref: "#/components/parameters/Ontology" }],
          responses: {
            "200": operationResponse("RuntimeMetadataResponse"),
            "401": error,
            "403": error,
            "410": error,
            "503": error,
          },
        },
      },
      "/api/v1/ontologies/{ontology}/objects/{objectType}/{primaryKey}": {
        get: {
          operationId: "getRuntimeObject",
          parameters: [
            { $ref: "#/components/parameters/Ontology" },
            { $ref: "#/components/parameters/ObjectType" },
            { $ref: "#/components/parameters/PrimaryKey" },
          ],
          responses: {
            "200": operationResponse("RuntimeObjectGetResponse"),
            "401": error,
            "403": error,
            "404": error,
            "410": error,
            "503": error,
          },
        },
      },
      "/api/v1/ontologies/{ontology}/objects/{objectType}/search": {
        post: {
          operationId: "searchRuntimeObjects",
          parameters: [
            { $ref: "#/components/parameters/Ontology" },
            { $ref: "#/components/parameters/ObjectType" },
          ],
          requestBody: requestBody("RuntimeSearchRequest"),
          responses: {
            "200": operationResponse("RuntimeSearchResponse"),
            "400": error,
            "401": error,
            "403": error,
            "409": error,
            "410": error,
            "429": error,
            "503": error,
          },
        },
      },
      "/api/v1/ontologies/{ontology}/objects/{objectType}/aggregate": {
        post: {
          operationId: "countRuntimeObjects",
          parameters: [
            { $ref: "#/components/parameters/Ontology" },
            { $ref: "#/components/parameters/ObjectType" },
          ],
          requestBody: requestBody("RuntimeCountRequest"),
          responses: {
            "200": operationResponse("RuntimeCountResponse"),
            "400": error,
            "401": error,
            "403": error,
            "410": error,
            "429": error,
            "503": error,
          },
        },
      },
      "/api/v1/ontologies/{ontology}/objects/{objectType}/{primaryKey}/links/{linkType}/search": {
        post: {
          operationId: "searchRuntimeLinks",
          parameters: [
            { $ref: "#/components/parameters/Ontology" },
            { $ref: "#/components/parameters/ObjectType" },
            { $ref: "#/components/parameters/PrimaryKey" },
            { $ref: "#/components/parameters/LinkType" },
          ],
          requestBody: requestBody("RuntimeLinkSearchRequest"),
          responses: {
            "200": operationResponse("RuntimeLinkSearchResponse"),
            "400": error,
            "401": error,
            "403": error,
            "404": error,
            "409": error,
            "410": error,
            "429": error,
            "503": error,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        oidc: {
          type: "openIdConnect",
          openIdConnectUrl: "https://identity.example.invalid/.well-known/openid-configuration",
        },
      },
      parameters: {
        Ontology: pathParameter("ontology", "ApiName"),
        ObjectType: pathParameter("objectType", "ApiName"),
        LinkType: pathParameter("linkType", "ApiName"),
        PrimaryKey: {
          name: "primaryKey",
          in: "path",
          required: true,
          schema: {
            type: "string",
            minLength: 1,
            maxLength: 1_024,
          },
        },
      },
      responses: { RuntimeError: runtimeError },
      schemas,
    },
  });
}

function pathParameter(name: string, definition: string): JsonRecord {
  return {
    name,
    in: "path",
    required: true,
    schema: { $ref: `#/components/schemas/${definition}` },
  };
}

function collectDefinitions(
  definitions: Readonly<Record<string, unknown>>,
  roots: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || Object.hasOwn(result, name)) continue;
    const definition = definitions[name];
    if (definition === undefined) throw new Error(`Missing schema definition ${name}.`);
    result[name] = structuredClone(definition);
    for (const reference of referencesIn(definition)) {
      const prefix = "#/$defs/";
      if (!reference.startsWith(prefix)) {
        throw new Error(`Unsupported schema reference ${reference}.`);
      }
      pending.push(reference.slice(prefix.length));
    }
  }
  return result;
}

function referencesIn(value: unknown): readonly string[] {
  const result: string[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isRecord(candidate)) return;
    if (typeof candidate.$ref === "string") result.push(candidate.$ref);
    Object.values(candidate).forEach(visit);
  };
  visit(value);
  return result;
}

function rewriteReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteReferences);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] =
      key === "$ref" && typeof item === "string"
        ? item.replace("#/$defs/", "#/components/schemas/")
        : rewriteReferences(item);
  }
  return result;
}

function countOperations(openApi: Readonly<Record<string, unknown>>): number {
  const paths = parseRecord(openApi.paths, "OpenAPI paths");
  return Object.values(paths)
    .map((path) => parseRecord(path, "OpenAPI path"))
    .reduce(
      (count, path) =>
        count +
        Object.keys(path).filter((key) =>
          new Set(["get", "post", "put", "patch", "delete"]).has(key),
        ).length,
      0,
    );
}

async function assertStrictPublicTypesCompile(temporaryRoot: string): Promise<void> {
  const root = resolve(temporaryRoot, "strict-public-types");
  await mkdir(root, { recursive: true });
  const typesPath = resolve(clientRoot, "types.gen.ts");
  await writeFile(
    resolve(root, "witness.ts"),
    `import type { RuntimePropertyResult, RuntimeSearchRequest, RuntimeSearchResponse } from ${JSON.stringify(typesPath)};\n\n` +
      `export function witness(request: RuntimeSearchRequest, response: RuntimeSearchResponse, property: RuntimePropertyResult): string {\n` +
      `  const selected: string = request.select[0]!;\n` +
      `  const release: string = response.releaseRevisionId;\n` +
      `  switch (property.state) {\n` +
      `    case "value": return selected + release + String(property.value);\n` +
      `    case "null": return selected + release + String(property.value);\n` +
      `    case "missing": return selected + release;\n` +
      `    case "masked": return selected + release + property.displayValue;\n` +
      `    case "restricted": return selected + release;\n` +
      `    default: { const neverValue: never = property; return neverValue; }\n` +
      `  }\n` +
      `}\n`,
  );
  await writeJson(resolve(root, "tsconfig.json"), {
    compilerOptions: {
      target: "ES2024",
      lib: ["ES2024", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      isolatedModules: true,
      allowImportingTsExtensions: true,
      skipLibCheck: false,
    },
    include: ["witness.ts"],
  });
  await mustPass(
    process.execPath,
    [typescriptEntry, "-p", resolve(root, "tsconfig.json")],
    repositoryRoot,
    "RUNTIME_READ_STRICT_PUBLIC_TYPES_FAILED",
  );
}

async function assertStrictWebConsumerCompile(): Promise<void> {
  const parent = resolve(repositoryRoot, "generated");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "runtime-read-web-"));
  try {
    await writeFile(
      resolve(root, "witness.ts"),
      `import { createClient, searchRuntimeObjects, type RuntimePropertyResult, type RuntimeSearchRequest, type RuntimeSearchResponse } from "@ontos/runtime-read-client";\n\n` +
        `const runtimeClient = createClient({ baseUrl: "https://runtime.example.invalid" });\n\n` +
        `export function search(ontology: string, objectType: string, body: RuntimeSearchRequest) {\n` +
        `  return searchRuntimeObjects({ client: runtimeClient, path: { ontology, objectType }, body });\n` +
        `}\n\n` +
        `export function render(response: RuntimeSearchResponse, property: RuntimePropertyResult): string {\n` +
        `  const release: string = response.releaseRevisionId;\n` +
        `  switch (property.state) {\n` +
        `    case "value": return release + String(property.value);\n` +
        `    case "null": return release + String(property.value);\n` +
        `    case "missing": return release;\n` +
        `    case "masked": return release + property.displayValue;\n` +
        `    case "restricted": return release;\n` +
        `    default: { const neverValue: never = property; return neverValue; }\n` +
        `  }\n` +
        `}\n`,
    );
    await writeJson(resolve(root, "tsconfig.json"), {
      compilerOptions: {
        target: "ES2024",
        lib: ["ES2024", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        isolatedModules: true,
        skipLibCheck: false,
      },
      include: ["witness.ts"],
    });
    await mustPass(
      process.execPath,
      [typescriptEntry, "-p", resolve(root, "tsconfig.json")],
      repositoryRoot,
      "RUNTIME_READ_STRICT_WEB_CONSUMER_FAILED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runGenerator(input: string, output: string): Promise<void> {
  await mustPass(
    process.execPath,
    [generatorEntry, "--input", input, "--output", output, "--silent"],
    repositoryRoot,
    "RUNTIME_READ_OPENAPI_GENERATION_FAILED",
  );
  await writeFile(
    resolve(output, "package.ts"),
    await formatText(
      `export * from "./index.js";\n` +
        `export { client } from "./client.gen.js";\n` +
        `export { createClient, createConfig } from "./client/index.js";\n` +
        `export type { Client, Config } from "./client/index.js";\n`,
      { parser: "typescript", printWidth: 100 },
    ),
  );
}

async function compileClientDistribution(
  sourceRoot: string,
  outputRoot: string,
  workingRoot: string,
): Promise<void> {
  const sourceFiles = (await filesIn(sourceRoot))
    .filter((path) => path.endsWith(".ts"))
    .map((path) => resolve(sourceRoot, path));
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(workingRoot, { recursive: true });
  const configPath = resolve(workingRoot, "tsconfig.json");
  await writeJson(configPath, {
    compilerOptions: {
      target: "ES2024",
      lib: ["ES2024", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: false,
      noImplicitOverride: true,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      useUnknownInCatchVariables: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      skipLibCheck: false,
      declaration: true,
      declarationMap: false,
      sourceMap: false,
      noEmitOnError: true,
      rootDir: sourceRoot,
      outDir: outputRoot,
    },
    files: sourceFiles,
  });
  await mustPass(
    process.execPath,
    [typescriptEntry, "-p", configPath],
    repositoryRoot,
    "RUNTIME_READ_CLIENT_DISTRIBUTION_COMPILE_FAILED",
  );
  await normalizeDistributionWhitespace(outputRoot);
}

async function normalizeDistributionWhitespace(outputRoot: string): Promise<void> {
  for (const path of await filesIn(outputRoot)) {
    const absolutePath = resolve(outputRoot, path);
    const contents = await readFile(absolutePath, "utf8");
    const normalized = contents.replace(/[ \t]+$/gmu, "");
    if (normalized !== contents) await writeFile(absolutePath, normalized);
  }
}

async function assertClientDistributionExports(distributionRoot: string): Promise<void> {
  const module = (await import(
    `${pathToFileURL(resolve(distributionRoot, "package.js")).href}?check=${Date.now().toString()}`
  )) as Readonly<Record<string, unknown>>;
  for (const name of [
    "client",
    "createClient",
    "getRuntimeMetadata",
    "getRuntimeObject",
    "searchRuntimeObjects",
    "countRuntimeObjects",
    "searchRuntimeLinks",
  ]) {
    if (typeof module[name] !== (name === "client" ? "object" : "function")) {
      throw new Error(`RUNTIME_READ_CLIENT_DISTRIBUTION_EXPORT_MISSING:${name}`);
    }
  }
}

async function assertSameFile(expected: string, actual: string, code: string): Promise<void> {
  const [left, right] = await Promise.all([readFile(expected), readFile(actual)]);
  if (!left.equals(right)) throw new Error(code);
}

async function assertSameDirectory(expected: string, actual: string, code: string): Promise<void> {
  const [expectedFiles, actualFiles] = await Promise.all([filesIn(expected), filesIn(actual)]);
  if (expectedFiles.join("\0") !== actualFiles.join("\0")) throw new Error(`${code}:FILE_SET`);
  for (const path of expectedFiles) {
    const [left, right] = await Promise.all([
      readFile(resolve(expected, path)),
      readFile(resolve(actual, path)),
    ]);
    if (!left.equals(right)) throw new Error(`${code}:${path}`);
  }
}

async function filesIn(root: string, prefix = ""): Promise<readonly string[]> {
  const entries = await readdir(resolve(root, prefix), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await filesIn(root, path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.toSorted((left, right) => left.localeCompare(right));
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function sha256Directory(root: string, paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(relative(root, resolve(root, path)));
    hash.update("\0");
    hash.update(await readFile(resolve(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    await formatText(`${JSON.stringify(value, null, 2)}\n`, {
      filepath: path,
      parser: "json",
      printWidth: 100,
    }),
  );
}

async function mustPass(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  errorCode: string,
): Promise<void> {
  const result = await capture(command, arguments_, cwd);
  if (result.exitCode !== 0) throw new Error(`${errorCode}:${result.output.slice(-6_000)}`);
}

function capture(
  command: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<Readonly<{ exitCode: number; output: string }>> {
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

function parseRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

const mode = process.argv[2];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (mode === "--write") await writeRuntimeReadArtifacts();
  else await checkRuntimeReadArtifacts();
}
