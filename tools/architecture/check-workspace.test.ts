import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkWorkspace, loadPolicy } from "./check-workspace.ts";

const policyPath = fileURLToPath(new URL("./policy.json", import.meta.url));
const policy = await loadPolicy(policyPath);

interface FixturePackage {
  readonly directory: string;
  readonly name: string;
  readonly layer: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly source?: string;
  readonly exports?: unknown;
}

void test("accepts the intended app, module, domain, contract, adapter, and testkit direction", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, {
      directory: "packages/contracts",
      name: "@ontos/contracts",
      layer: "contracts",
      source: "export interface Identifier { readonly value: string; }\n",
    });
    await writePackage(root, {
      directory: "packages/domain",
      name: "@ontos/domain",
      layer: "domain",
      dependencies: { "@ontos/contracts": "workspace:*" },
      source:
        'import type { Identifier } from "@ontos/contracts";\nexport type EntityId = Identifier;\n',
    });
    await writePackage(root, {
      directory: "packages/application",
      name: "@ontos/application",
      layer: "application",
      dependencies: { "@ontos/contracts": "workspace:*", "@ontos/domain": "workspace:*" },
      source: 'export type { EntityId } from "@ontos/domain";\n',
    });
    await writePackage(root, {
      directory: "packages/db",
      name: "@ontos/db",
      layer: "adapter",
      dependencies: { "@ontos/application": "workspace:*", pg: "8.0.0" },
      source: 'export type { EntityId } from "@ontos/application";\n',
    });
    await writePackage(root, {
      directory: "packages/testkit",
      name: "@ontos/testkit",
      layer: "testkit",
      dependencies: { "@ontos/application": "workspace:*", "@ontos/db": "workspace:*" },
      source: 'export type { EntityId } from "@ontos/application";\n',
    });
    await writePackage(root, {
      directory: "apps/api",
      name: "@ontos/api",
      layer: "app",
      dependencies: { "@ontos/application": "workspace:*", "@ontos/db": "workspace:*" },
      source:
        'import type { EntityId } from "@ontos/application";\nexport type ApiId = EntityId;\n',
    });

    const result = await checkWorkspace(root, policy);
    assert.deepEqual(result.violations, []);
    assert.equal(result.packageCount, 6);
  });
});

void test("rejects runtime and framework dependencies from contracts", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, {
      directory: "packages/contracts",
      name: "@ontos/contracts",
      layer: "contracts",
      dependencies: { pg: "8.0.0" },
      source: 'import type { Client } from "pg";\nexport type DatabaseClient = Client;\n',
    });

    assert.deepEqual(await violationCodes(root), [
      "FORBIDDEN_EXTERNAL_DEPENDENCY",
      "FORBIDDEN_EXTERNAL_IMPORT",
    ]);
  });
});

void test("rejects an unclassified infrastructure SDK from application code", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, {
      directory: "packages/application",
      name: "@ontos/application",
      layer: "application",
      dependencies: { mysql2: "3.0.0" },
      source: 'export type { Pool } from "mysql2";\n',
    });

    assert.deepEqual(await violationCodes(root), [
      "FORBIDDEN_EXTERNAL_DEPENDENCY",
      "FORBIDDEN_EXTERNAL_IMPORT",
    ]);
  });
});

void test("rejects a contracts package depending on an application package", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, {
      directory: "apps/api",
      name: "@ontos/api",
      layer: "app",
      source: "export interface Api {}\n",
    });
    await writePackage(root, {
      directory: "packages/contracts",
      name: "@ontos/contracts",
      layer: "contracts",
      dependencies: { "@ontos/api": "workspace:*" },
      source: 'export type { Api } from "@ontos/api";\n',
    });

    assert.ok((await violationCodes(root)).includes("WORKSPACE_LAYER_VIOLATION"));
  });
});

void test("rejects a domain package depending on an infrastructure adapter", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, {
      directory: "packages/domain",
      name: "@ontos/domain",
      layer: "domain",
      dependencies: { "@ontos/db": "workspace:*" },
      source: 'export type { DbPort } from "@ontos/db";\n',
    });
    await writePackage(root, {
      directory: "packages/db",
      name: "@ontos/db",
      layer: "adapter",
      source: "export interface DbPort {}\n",
    });

    assert.ok((await violationCodes(root)).includes("WORKSPACE_LAYER_VIOLATION"));
  });
});

void test("rejects workspace dependency cycles even when each edge is otherwise allowed", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, {
      directory: "packages/alpha",
      name: "@ontos/alpha",
      layer: "application",
      dependencies: { "@ontos/beta": "workspace:*" },
      source: 'export type { Beta } from "@ontos/beta";\n',
    });
    await writePackage(root, {
      directory: "packages/beta",
      name: "@ontos/beta",
      layer: "application",
      dependencies: { "@ontos/alpha": "workspace:*" },
      source: 'export type { Alpha } from "@ontos/alpha";\n',
    });

    assert.ok((await violationCodes(root)).includes("WORKSPACE_DEPENDENCY_CYCLE"));
  });
});

void test("rejects deep workspace imports that bypass the public package entrypoint", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, {
      directory: "packages/contracts",
      name: "@ontos/contracts",
      layer: "contracts",
      source: "export interface Identifier {}\n",
    });
    await writePackage(root, {
      directory: "apps/api",
      name: "@ontos/api",
      layer: "app",
      dependencies: { "@ontos/contracts": "workspace:*" },
      source:
        'import type { Identifier } from "@ontos/contracts/src/internal.ts";\nexport type ApiId = Identifier;\n',
    });

    assert.ok((await violationCodes(root)).includes("DEEP_WORKSPACE_IMPORT"));
  });
});

void test("rejects packages that publish internal subpaths", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, {
      directory: "packages/contracts",
      name: "@ontos/contracts",
      layer: "contracts",
      source: "export interface Identifier {}\n",
      exports: {
        ".": "./src/index.ts",
        "./internal": "./src/internal.ts",
      },
    });

    assert.ok((await violationCodes(root)).includes("EXPORTED_INTERNAL_SUBPATH"));
  });
});

void test("rejects relative imports that cross package directories", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, {
      directory: "packages/contracts",
      name: "@ontos/contracts",
      layer: "contracts",
      source: "export interface Identifier {}\n",
    });
    await writePackage(root, {
      directory: "apps/api",
      name: "@ontos/api",
      layer: "app",
      source:
        'import type { Identifier } from "../../../packages/contracts/src/index.ts";\nexport type ApiId = Identifier;\n',
    });

    assert.ok((await violationCodes(root)).includes("CROSS_PACKAGE_RELATIVE_IMPORT"));
  });
});

void test("rejects production modules depending on testkit", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, {
      directory: "packages/testkit",
      name: "@ontos/testkit",
      layer: "testkit",
      source: "export interface Fixture {}\n",
    });
    await writePackage(root, {
      directory: "packages/application",
      name: "@ontos/application",
      layer: "application",
      dependencies: { "@ontos/testkit": "workspace:*" },
      source: 'export type { Fixture } from "@ontos/testkit";\n',
    });

    assert.ok((await violationCodes(root)).includes("WORKSPACE_LAYER_VIOLATION"));
  });
});

void test("rejects runtime imports from the frozen G1 spike in every workspace layer", async () => {
  await withWorkspace(async (root) => {
    const spikeSource = join(root, "spikes/g1/src/reference.js");
    await mkdir(dirname(spikeSource), { recursive: true });
    await writeFile(spikeSource, "export const spikeOnly = true;\n");
    await writePackage(root, {
      directory: "packages/testkit",
      name: "@ontos/testkit",
      layer: "testkit",
      source:
        'import { spikeOnly } from "../../../spikes/g1/src/reference.js";\nexport { spikeOnly };\n',
    });

    const rootEntry = join(root, "packages/testkit/index.ts");
    await writeFile(rootEntry, 'export { spikeOnly } from "../../spikes/g1/src/reference.js";\n');

    assert.equal(
      (await violationCodes(root)).filter((code) => code === "FORBIDDEN_REPOSITORY_IMPORT").length,
      2,
    );
  });
});

void test("rejects file dependencies that point at the frozen G1 spike", async () => {
  await withWorkspace(async (root) => {
    await writePackage(root, {
      directory: "apps/api",
      name: "@ontos/api",
      layer: "app",
      dependencies: { "g1-spike": "file:../../spikes/g1" },
    });

    assert.ok((await violationCodes(root)).includes("FORBIDDEN_REPOSITORY_DEPENDENCY"));
  });
});

async function violationCodes(root: string): Promise<string[]> {
  const result = await checkWorkspace(root, policy);
  return result.violations.map((violation) => violation.code).sort();
}

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ontos-architecture-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writePackage(root: string, fixture: FixturePackage): Promise<void> {
  const directory = join(root, fixture.directory);
  const sourcePath = join(directory, "src/index.ts");
  await mkdir(dirname(sourcePath), { recursive: true });

  const manifest = {
    name: fixture.name,
    version: "0.0.0",
    private: true,
    type: "module",
    ...(fixture.exports === undefined ? {} : { exports: fixture.exports }),
    ...(fixture.layer === "app" || fixture.layer === "testkit"
      ? {}
      : { exports: fixture.exports ?? { ".": "./src/index.ts" } }),
    ...(fixture.dependencies ? { dependencies: fixture.dependencies } : {}),
    ontos: { layer: fixture.layer },
  };

  await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(sourcePath, fixture.source ?? "export {};\n");
}
