import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptPath = join(repoRoot, "scripts/register-clients.mjs");
const proxyPath = join(repoRoot, "scripts/proxy.mjs");
const skipOnWindows = process.platform === "win32" ? "POSIX shell fixtures" : false;

function fixture(tag) {
  const home = mkdtempSync(join(tmpdir(), `pi-register ${tag} `));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  return { home, bin, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function writeCommand(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function installFakeCodex(bin, { failAdd = false } = {}) {
  const body = failAdd
    ? `echo "codex $*" >> "$REGISTER_LOG"
case "$1 $2" in
  "mcp remove") exit 0 ;;
  "mcp add")
    printf '%s\\n' CORRUPT > "$CODEX_HOME/config.toml"
    echo "codex: cannot add server" >&2
    exit 1 ;;
esac
exit 1`
    : `echo "codex $*" >> "$REGISTER_LOG"
case "$1 $2" in
  "mcp remove") exit 0 ;;
  "mcp add") echo "Added global MCP server 'pi'."; exit 0 ;;
esac
exit 1`;
  writeCommand(join(bin, "codex"), body);
}

function installFakePi(home) {
  const binDir = join(home, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  writeCommand(
    join(binDir, "pi"),
    `echo "pi $*" >> "$REGISTER_LOG"
case "$1 $2" in
  "mcp add") echo 'Added global MCP server "pi".'; exit 0 ;;
esac
exit 1`,
  );
}

function environment({ home, bin }, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    // Only the fixture directory: a real codex/claude on the host PATH must not leak in.
    PATH: bin,
    CODEX_HOME: join(home, ".codex"),
    DSH_HOME: join(home, "no-dsh"),
    REGISTER_LOG: join(home, "commands.log"),
    ...extra,
  };
}

function run(env, args = []) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [scriptPath, ...args], { env, encoding: "utf8" }) };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function commands(home) {
  const file = join(home, "commands.log");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
}

test("registers every client it finds and never fails for a missing one", { skip: skipOnWindows }, (t) => {
  const { home, bin, cleanup } = fixture("both");
  t.after(cleanup);
  installFakeCodex(bin);
  installFakePi(home);

  const env = environment({ home, bin });
  const result = run(env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex\s+registered/);
  assert.match(result.stdout, /pi\s+registered/);

  const log = commands(home).join("\n");
  assert.ok(log.includes(`codex mcp add pi -- ${process.execPath} ${proxyPath}`), log);
  assert.ok(log.includes(`pi mcp add pi --description`), log);
  assert.ok(log.includes(`${process.execPath} ${proxyPath}`), log);
});

test("a missing Codex and pi CLI does not abort the install or the summary", { skip: skipOnWindows }, (t) => {
  const { home, bin, cleanup } = fixture("none");
  t.after(cleanup);

  const result = run(environment({ home, bin }));
  assert.equal(result.status, 0, result.stderr);
  // The bundled checkout pi is a valid fallback, so at least it registers; no Codex is required.
  assert.doesNotMatch(result.stdout, /codex\s+FAILED/);
  assert.match(result.stdout, /codex\s+not found on PATH; skipped/);
});

test("clients that own their configuration are reported with the exact command", { skip: skipOnWindows }, (t) => {
  const { home, bin, cleanup } = fixture("manual");
  t.after(cleanup);
  installFakePi(home);
  mkdirSync(join(home, ".dsh"), { recursive: true });
  writeCommand(join(bin, "claude"), "exit 0");

  const env = environment({ home, bin }, { DSH_HOME: join(home, ".dsh") });
  const result = run(env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /setup-dsh\.mjs"? --write/, result.stdout);
  assert.match(result.stdout, /claude mcp add pi -- /, result.stdout);
  // DSH is never written implicitly.
  assert.deepEqual(readdirSync(join(home, ".dsh")), [], "the DSH directory must stay untouched");
});

test("a failed Codex registration restores the previous client configuration", { skip: skipOnWindows }, (t) => {
  const { home, bin, cleanup } = fixture("restore");
  t.after(cleanup);
  installFakeCodex(bin, { failAdd: true });
  installFakePi(home);
  mkdirSync(join(home, ".codex"), { recursive: true });
  const config = join(home, ".codex", "config.toml");
  const original = "[mcp_servers.other]\ncommand = \"other\"\n";
  writeFileSync(config, original);

  const result = run(environment({ home, bin }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /codex\s+FAILED/);
  assert.equal(readFileSync(config, "utf8"), original, "the original Codex config must be restored");
  assert.match(result.stdout, /pi\s+registered/, "one failed client must not block the others");
});

test("--json is machine readable and carries the fallback snippet", { skip: skipOnWindows }, (t) => {
  const { home, bin, cleanup } = fixture("json");
  t.after(cleanup);
  installFakeCodex(bin);
  installFakePi(home);

  const result = run(environment({ home, bin }), ["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.server, "pi");
  assert.deepEqual(parsed.registered.map((entry) => entry.client).sort(), ["codex", "pi"]);
  assert.equal(parsed.snippet.mcpServers.pi.command, process.execPath);
  assert.deepEqual(parsed.snippet.mcpServers.pi.args, [proxyPath]);
});

test("a failed first registration leaves no half-written config and says so", { skip: skipOnWindows }, (t) => {
  const { home, bin, cleanup } = fixture("restore-none");
  t.after(cleanup);
  installFakeCodex(bin, { failAdd: true });
  installFakePi(home);
  // ~/.codex exists but has no config.toml: the fake writes a half-finished file,
  // which used to survive while the summary claimed a restore had happened.
  mkdirSync(join(home, ".codex"), { recursive: true });
  const result = run(environment({ home, bin }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /codex\s+FAILED/);
  const config = join(home, ".codex", "config.toml");
  assert.equal(existsSync(config), false, "the partial file is removed, restoring the previous state");
  assert.match(result.stderr, /previous configuration was restored/);
});
