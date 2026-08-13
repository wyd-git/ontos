import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function validateToolchain({ nodeVersion, npmUserAgent, expectedNode, expectedNpm }) {
  const errors = [];

  if (nodeVersion !== expectedNode) {
    errors.push(`Node.js ${expectedNode} is required; received ${nodeVersion || "unknown"}.`);
  }

  const npmVersion = npmUserAgent?.match(/(?:^|\s)npm\/([^\s]+)/)?.[1];
  if (npmVersion !== expectedNpm) {
    errors.push(
      `npm ${expectedNpm} is required; received ${npmVersion || "an unknown/non-npm client"}.`,
    );
  }

  return errors;
}

export function expectedVersions(root = repositoryRoot) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return {
    node: manifest.engines.node,
    npm: manifest.engines.npm,
  };
}

function main() {
  const expected = expectedVersions();
  const errors = validateToolchain({
    nodeVersion: process.versions.node,
    npmUserAgent: process.env.npm_config_user_agent,
    expectedNode: expected.node,
    expectedNpm: expected.npm,
  });

  if (errors.length > 0) {
    for (const error of errors) console.error(`toolchain: ${error}`);
    console.error(`toolchain: run 'nvm use' from ${repositoryRoot} and retry with npm.`);
    process.exitCode = 1;
    return;
  }

  console.log(`toolchain: PASS (node ${expected.node}, npm ${expected.npm})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
