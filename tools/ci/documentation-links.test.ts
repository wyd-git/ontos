import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkDocumentationLinks, extractMarkdownTargets } from "./documentation-links.ts";

void test("extracts inline, image and reference Markdown targets", () => {
  const targets = extractMarkdownTargets(`
[Architecture](architecture.md#owner)
![Diagram](images/flow.png)
[External](https://example.com/path)
[Reference][core]
[core]: <core.md>
`);
  assert.deepEqual(targets, [
    "architecture.md#owner",
    "images/flow.png",
    "https://example.com/path",
    "<core.md>",
  ]);
});

void test("checks repository-local links and ignores URLs and anchors", async () => {
  const root = await mkdtemp(join(tmpdir(), "ontos-doc-links-"));
  try {
    await mkdir(join(root, "docs", "images"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Root\n");
    await writeFile(join(root, "docs", "images", "flow.png"), "image");
    await writeFile(
      join(root, "docs", "guide.md"),
      [
        "[Root](../README.md)",
        "![Flow](images/flow.png)",
        "[Anchor](#local)",
        "[Web](https://example.com)",
      ].join("\n"),
    );

    const report = await checkDocumentationLinks(root, ["README.md", "docs/guide.md"]);
    assert.equal(report.status, "PASS");
    assert.equal(report.localLinkCount, 2);
    assert.deepEqual(report.findings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("reports missing, malformed and repository-escaping local targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "ontos-doc-links-"));
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "docs", "guide.md"),
      ["[Missing](missing.md)", "[Malformed](bad%ZZ.md)", "[Escape](../../outside.md)"].join("\n"),
    );
    const report = await checkDocumentationLinks(root, ["docs/guide.md"]);
    assert.equal(report.status, "FAIL");
    assert.equal(report.findings.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
