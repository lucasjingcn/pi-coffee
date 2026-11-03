import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MCP_TOOL_ORDER, buildServer } from "../dist/mcp-server.js";
import { PI_COFFEE_VERSION } from "../dist/version.js";

const root = process.cwd();
const READMES = ["README.md", "README.zh-CN.md"];
const TOOLS_DOC = "docs/reference/tools.md";
const CONFIG_DOC = "docs/reference/configuration.md";

/**
 * The README is a front page, not an appendix: detail belongs in docs/. This cap keeps the
 * document that grew to ~960 lines from silently growing back.
 */
const README_LINE_CAP = 280;

function documentedTools(text) {
  const found = new Set();
  for (const line of text.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const firstCell = line.split("|")[1] ?? "";
    for (const match of firstCell.matchAll(/`(pi_[a-z_]+)`/g)) found.add(match[1]);
  }
  return found;
}

test("tool registration order is deterministic and matches MCP_TOOL_ORDER", () => {
  const server = buildServer({}, { dir: join(root, "dist"), distMtimeMs: 0 });
  const registry = server._registeredTools;
  assert.ok(registry, "MCP SDK registry surface changed");
  assert.deepEqual(Object.keys(registry), [...MCP_TOOL_ORDER]);
});

test("every registered tool declares annotations", async () => {
  const source = await readFile(join(root, "src/mcp-server.ts"), "utf8");
  for (const name of MCP_TOOL_ORDER) {
    const match = new RegExp(`registerTool\\(\\s*"${name}"`).exec(source);
    assert.ok(match, `missing registration for ${name}`);
    const next = source.indexOf("server.registerTool(", match.index + 1);
    const block = source.slice(match.index, next > 0 ? next : match.index + 6000);
    assert.match(block, /annotations: \{/, `${name} is missing annotations`);
  }
});

test("tool tables document exactly the registered MCP tools", async () => {
  const expected = new Set(MCP_TOOL_ORDER);
  for (const file of [TOOLS_DOC, ...READMES]) {
    const documented = documentedTools(await readFile(join(root, file), "utf8"));
    const missing = [...expected].filter((name) => !documented.has(name));
    const extra = [...documented].filter((name) => !expected.has(name));
    assert.deepEqual(missing, [], `${file} is missing tool rows: ${missing.join(", ")}`);
    assert.deepEqual(extra, [], `${file} documents unknown tools: ${extra.join(", ")}`);
  }
});

test("package version and config names stay in sync with the reference docs", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(pkg.version, PI_COFFEE_VERSION);

  const config = await readFile(join(root, "src/config.ts"), "utf8");
  const envNames = [...new Set(config.match(/PI_COFFEE_[A-Z0-9_]+/g) ?? [])];
  const configDoc = await readFile(join(root, CONFIG_DOC), "utf8");
  const missing = envNames.filter((name) => !configDoc.includes(name));
  assert.deepEqual(missing, [], `${CONFIG_DOC} is missing config vars: ${missing.join(", ")}`);

  const readme = await readFile(join(root, "README.md"), "utf8");
  assert.ok(
    readme.includes(CONFIG_DOC),
    `README.md must link every configuration variable to ${CONFIG_DOC}`,
  );
});

test("READMEs stay a front page and link to the reference docs", async () => {
  for (const file of READMES) {
    const text = await readFile(join(root, file), "utf8");
    const lines = text.split("\n").length;
    assert.ok(
      lines <= README_LINE_CAP,
      `${file} is ${lines} lines (cap ${README_LINE_CAP}); move detail into docs/`,
    );
    for (const doc of [TOOLS_DOC, CONFIG_DOC, "docs/reference/operations.md", "docs/development.md"]) {
      assert.ok(text.includes(`(${doc}`), `${file} must link to ${doc}`);
    }
  }
});

test("every relative markdown link resolves to a real file", async () => {
  const files = [join(root, "README.md"), join(root, "README.zh-CN.md")];
  for (const entry of await readdir(join(root, "docs"), { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(join(entry.parentPath, entry.name));
  }
  for (const file of files) {
    const text = await readFile(file, "utf8");
    let inFence = false;
    for (const [index, line] of text.split("\n").entries()) {
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1];
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const path = target.split("#")[0];
        if (!path) continue;
        const absolute = resolve(dirname(file), path);
        const exists = await stat(absolute).then(
          () => true,
          () => false,
        );
        assert.ok(
          exists,
          `${file.split("/").pop()}:${index + 1} links to missing ${target}`,
        );
      }
    }
  }
});
