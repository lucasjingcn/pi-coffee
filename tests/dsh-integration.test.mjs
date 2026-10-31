import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/setup-dsh.mjs", import.meta.url));
const PROXY = fileURLToPath(new URL("../scripts/proxy.mjs", import.meta.url));
const SECRET = "s3cr3t-token-value-never-printed";

/**
 * Run the setup script with a clean pi-coffee environment: the developer's real
 * ~/.pi-coffee/env and DSH state must never influence a test.
 */
function run(args, { env = {}, cwd } = {}) {
  const clean = { ...process.env };
  for (const key of ["PI_COFFEE_PORT", "PI_COFFEE_TOKEN", "PI_COFFEE_URL", "DSH_HOME", "PI_COFFEE_ENV_FILE"]) {
    delete clean[key];
  }
  // Nonexistent env file: no port/token leakage from the developer's machine.
  Object.assign(clean, { PI_COFFEE_ENV_FILE: join(tmpdir(), "pi-coffee-no-such-env-file") }, env);
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: clean, cwd });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-dsh-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("--print emits one JSON object with the daemon's real HTTP defaults", () => {
  const result = run(["--print"]);
  assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(config), ["mcpServers"]);
  const server = config.mcpServers["pi-coffee"];
  assert.ok(server, "expected a pi-coffee server entry");
  assert.equal(server.transport, "streamable-http");
  assert.equal(server.serverName, "pi-coffee");
  assert.equal(server.url, "http://127.0.0.1:8787/mcp");
  assert.equal(server.toolCallTimeoutMs, 900000);
  assert.equal(server.headers, undefined, "no token header when the daemon has no token");
});

test("--print follows PI_COFFEE_PORT and can emit the stdio proxy form", () => {
  const http = run(["--print"], { env: { PI_COFFEE_PORT: "9123" } });
  assert.equal(http.code, 0, http.stderr);
  assert.equal(JSON.parse(http.stdout).mcpServers["pi-coffee"].url, "http://127.0.0.1:9123/mcp");

  const stdio = run(["--print", "--transport", "stdio"]);
  assert.equal(stdio.code, 0, stdio.stderr);
  const server = JSON.parse(stdio.stdout).mcpServers["pi-coffee"];
  assert.equal(server.transport, "stdio");
  assert.equal(server.serverName, "pi-coffee");
  assert.ok(server.command.startsWith("/") || /^[A-Za-z]:[\\/]/.test(server.command), "command must be absolute");
  assert.deepEqual(server.args, [PROXY]);

  const yaml = run(["--print", "--format", "yaml"]);
  assert.equal(yaml.code, 0, yaml.stderr);
  assert.match(yaml.stdout, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(yaml.stdout, /serverName: pi-coffee/);
  assert.match(yaml.stdout, /id: mcp-pi-coffee/);
});

test("print and write never reveal the shared secret", () => {
  const env = { PI_COFFEE_TOKEN: SECRET };
  const printed = run(["--print"], { env });
  assert.equal(printed.code, 0, printed.stderr);
  const http = JSON.parse(printed.stdout).mcpServers["pi-coffee"];
  assert.equal(http.headers["x-pi-coord-token"], "${PI_COFFEE_TOKEN}");
  assert.ok(!printed.stdout.includes(SECRET) && !printed.stderr.includes(SECRET));

  const yaml = run(["--print", "--format", "yaml"], { env });
  assert.match(yaml.stdout, /x-pi-coord-token: !!js process\.env\.PI_COFFEE_TOKEN/);
  assert.ok(!yaml.stdout.includes(SECRET));

  const { dir, cleanup } = tempDir();
  try {
    const target = join(dir, "cordis.patch.yml");
    const written = run(["--write", "--config", target], { env });
    assert.equal(written.code, 0, written.stderr);
    const text = readFileSync(target, "utf8");
    assert.ok(!text.includes(SECRET), "the config file must not contain the token value");
    assert.match(text, /!!js process\.env\.PI_COFFEE_TOKEN/);
    assert.ok(!written.stdout.includes(SECRET) && !written.stderr.includes(SECRET));
  } finally {
    cleanup();
  }
});

test("--write merges into a JSON config, preserves other servers, and is idempotent", () => {
  const { dir, cleanup } = tempDir();
  try {
    const target = join(dir, "mcp.json");
    writeFileSync(
      target,
      `${JSON.stringify({ mcpServers: { other: { transport: "stdio", command: "other-server" } }, keep: true }, null, 2)}\n`,
    );

    const first = run(["--write", "--config", target]);
    assert.equal(first.code, 0, first.stderr);
    const merged = JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(merged.mcpServers.other, { transport: "stdio", command: "other-server" });
    assert.equal(merged.keep, true);
    assert.equal(merged.mcpServers["pi-coffee"].url, "http://127.0.0.1:8787/mcp");

    const afterFirst = readFileSync(target, "utf8");
    const second = run(["--write", "--config", target]);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(readFileSync(target, "utf8"), afterFirst, "a second write must change nothing");
    assert.equal(Object.keys(JSON.parse(afterFirst).mcpServers).length, 2, "no duplicate server entry");
  } finally {
    cleanup();
  }
});

test("--write merges into a DSH JSON patch list without duplicating its insert row", () => {
  const { dir, cleanup } = tempDir();
  try {
    const target = join(dir, "cordis.patch.json");
    writeFileSync(target, `${JSON.stringify([{ id: "keep", name: "example-plugin" }], null, 2)}\n`);

    assert.equal(run(["--write", "--config", target]).code, 0);
    const list = JSON.parse(readFileSync(target, "utf8"));
    assert.equal(list[0].id, "keep");
    const inserted = list.flatMap((entry) => entry.insert ?? []);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].id, "mcp-pi-coffee");
    assert.equal(inserted[0].name, "@deepseek-ai/dsh-mcp-client");
    assert.equal(inserted[0].config.serverName, "pi-coffee");

    const afterFirst = readFileSync(target, "utf8");
    assert.equal(run(["--write", "--config", target]).code, 0);
    assert.equal(readFileSync(target, "utf8"), afterFirst, "a second write must change nothing");
    assert.equal(JSON.parse(readFileSync(target, "utf8")).flatMap((entry) => entry.insert ?? []).length, 1);
  } finally {
    cleanup();
  }
});

test("--write refuses malformed JSON and leaves the file untouched", () => {
  const { dir, cleanup } = tempDir();
  try {
    const target = join(dir, "broken.json");
    const original = '{ "mcpServers": { "other": { }, }';
    writeFileSync(target, original);

    const result = run(["--write", "--config", target]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not valid JSON/i);
    assert.match(result.stderr, /refusing/i);
    assert.equal(readFileSync(target, "utf8"), original, "a refused write must not touch the file");

    const empty = join(dir, "empty.json");
    writeFileSync(empty, "");
    assert.equal(run(["--write", "--config", empty]).code, 0, "an empty file is a valid starting point");
    assert.equal(JSON.parse(readFileSync(empty, "utf8")).mcpServers["pi-coffee"].serverName, "pi-coffee");
  } finally {
    cleanup();
  }
});

test("--write targets the DSH profile patch layer discovered from DSH_HOME", () => {
  const { dir, cleanup } = tempDir();
  try {
    const dshHome = join(dir, "dsh");
    const result = run(["--write"], { env: { DSH_HOME: dshHome } });
    assert.equal(result.code, 0, result.stderr);
    const target = join(dshHome, "profiles", "desktop", "cordis.patch.yml");
    const text = readFileSync(target, "utf8");
    assert.match(text, /- insert:/);
    assert.match(text, /name: '@deepseek-ai\/dsh-mcp-client'/);
    assert.match(text, /url: http:\/\/127\.0\.0\.1:8787\/mcp/);

    const second = run(["--write"], { env: { DSH_HOME: dshHome } });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(readFileSync(target, "utf8"), text, "a second write must change nothing");

    const profile = run(["--write", "--profile", "work"], { env: { DSH_HOME: dshHome } });
    assert.equal(profile.code, 0, profile.stderr);
    assert.match(readFileSync(join(dshHome, "profiles", "work", "cordis.patch.yml"), "utf8"), /mcp-pi-coffee/);
  } finally {
    cleanup();
  }
});

test("--write preserves existing YAML rows, updates its own block, and refuses a non-list file", () => {
  const { dir, cleanup } = tempDir();
  try {
    const target = join(dir, "cordis.patch.yml");
    writeFileSync(target, "- id: keep\n  name: 'example-plugin'\n");

    assert.equal(run(["--write", "--config", target]).code, 0);
    const first = readFileSync(target, "utf8");
    assert.ok(first.startsWith("- id: keep\n  name: 'example-plugin'\n"), "existing rows stay in place");
    assert.equal(first.match(/id: mcp-pi-coffee/g).length, 1);

    // A changed setting rewrites the managed block in place instead of appending again.
    assert.equal(run(["--write", "--config", target, "--transport", "stdio"]).code, 0);
    const updated = readFileSync(target, "utf8");
    assert.ok(updated.startsWith("- id: keep\n  name: 'example-plugin'\n"));
    assert.equal(updated.match(/id: mcp-pi-coffee/g).length, 1);
    assert.match(updated, /transport: stdio/);
    assert.doesNotMatch(updated, /streamable-http/);

    const objectFile = join(dir, "not-a-patch-list.yml");
    writeFileSync(objectFile, "mcpServers:\n  pi-coffee:\n    url: http://127.0.0.1:8787/mcp\n");
    const refused = run(["--write", "--config", objectFile]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /refusing/i);
    assert.equal(readFileSync(objectFile, "utf8"), "mcpServers:\n  pi-coffee:\n    url: http://127.0.0.1:8787/mcp\n");
  } finally {
    cleanup();
  }
});

test("--help exits 0 with usage; bad usage exits 2", () => {
  const help = run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: node scripts\/setup-dsh\.mjs/);
  assert.match(help.stdout, /--print/);
  assert.match(help.stdout, /--write/);
  assert.match(help.stdout, /--config <path>/);

  assert.equal(run([]).code, 2, "a mode is required");
  assert.equal(run(["--print", "--write"]).code, 2, "modes are exclusive");
  assert.equal(run(["--nope"]).code, 2, "unknown flags are rejected");
  assert.equal(run(["--print", "--transport", "sse"]).code, 2, "only the two supported transports");
});

test("the generated YAML row is a patch list DSH can load", () => {
  const { dir, cleanup } = tempDir();
  try {
    const dshHome = join(dir, "dsh");
    const target = join(dshHome, "profiles", "desktop", "cordis.patch.yml");
    mkdirSync(join(dshHome, "profiles", "desktop"), { recursive: true });
    writeFileSync(target, "- id: keep\n  name: 'example-plugin'\n");
    assert.equal(run(["--write"], { env: { DSH_HOME: dshHome } }).code, 0);

    // Structural checks that hold without a YAML dependency: one insert list whose
    // single row carries id/name/config, indented with spaces only.
    const lines = readFileSync(target, "utf8").split("\n");
    assert.ok(!lines.some((line) => line.includes("\t")), "DSH patch files must not rely on tabs");
    assert.equal(lines.filter((line) => /^- insert:$/.test(line)).length, 1);
    const configIndex = lines.findIndex((line) => /^      config:$/.test(line));
    assert.ok(configIndex > 0, "config block must sit under the inserted row");
    for (const key of ["serverName: pi-coffee", "transport: streamable-http", "url: http://127.0.0.1:8787/mcp"]) {
      assert.ok(lines.slice(configIndex).some((line) => line.trim() === key), `missing ${key}`);
    }
  } finally {
    cleanup();
  }
});
