import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MCP_TOOL_ORDER, buildServer } from "../dist/mcp-server.js";
import { PI_COFFEE_VERSION } from "../dist/version.js";

const root = process.cwd();

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

test("README tool tables document exactly the registered MCP tools", async () => {
  for (const file of ["README.md", "README.zh-CN.md"]) {
    const text = await readFile(join(root, file), "utf8");
    const documented = new Set();
    for (const line of text.split("\n")) {
      if (!line.startsWith("| ")) continue;
      const firstCell = line.split("|")[1] ?? "";
      for (const match of firstCell.matchAll(/`(pi_[a-z_]+)`/g)) documented.add(match[1]);
    }
    const expected = new Set(MCP_TOOL_ORDER);
    const missing = [...expected].filter((name) => !documented.has(name));
    const extra = [...documented].filter((name) => !expected.has(name));
    assert.deepEqual(missing, [], `${file} is missing tool rows: ${missing.join(", ")}`);
    assert.deepEqual(extra, [], `${file} documents unknown tools: ${extra.join(", ")}`);
  }
});

test("package version and README config names stay in sync", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(pkg.version, PI_COFFEE_VERSION);
  const config = await readFile(join(root, "src/config.ts"), "utf8");
  const envNames = [...new Set(config.match(/PI_COFFEE_[A-Z0-9_]+/g) ?? [])];
  const readme = await readFile(join(root, "README.md"), "utf8");
  const missing = envNames.filter((name) => !readme.includes(name));
  assert.deepEqual(missing, [], `README.md is missing config vars: ${missing.join(", ")}`);
});
