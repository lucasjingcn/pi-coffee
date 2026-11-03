import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * The doctor's MCP-client section is informational: a daemon without a registered client is
 * still healthy, so it must never change the exit code. These tests pin both halves: the
 * report shows what is registered, and a missing registration stays non-fatal.
 */

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PI_COFFEE_")) delete env[key];
  // A client directory exported by the machine running the tests must not leak in.
  delete env.DSH_HOME;
  delete env.CODEX_HOME;
  return env;
}

function runDoctor(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/doctor.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pi-doctor-clients-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const env = {
    ...cleanEnv(),
    HOME: home,
    USERPROFILE: home,
    PI_COFFEE_ENV_FILE: join(dir, "env"),
    PI_COFFEE_DATA_DIR: join(dir, "data"),
    // A shell key satisfies the interactive credential check without touching the file.
    DEEPSEEK_API_KEY: "fixture-key",
  };
  try {
    await fn(home, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reports no client without failing the preflight", () => fixture(async (home, env) => {
  // A minimal PATH hides the host's Codex/pi installs so the empty report is exercised.
  const result = await runDoctor({...env, PATH: "/usr/bin:/bin"});
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /MCP clients/);
  assert.match(result.stdout, /none detected/);
  assert.match(result.stdout, /register-clients\.mjs/);
}));

test("reports clients it can see and their exact follow-up", () => fixture(async (home, env) => {
  // Codex: a config with the server row counts as registered.
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.pi]\ncommand = "node"\n');
  // pi: the user-level MCP config is shared by every pi binary.
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: { pi: { command: "node" } } }));
  // DSH: detected but never written by the installer, so it must print the command.
  mkdirSync(join(home, ".dsh"), { recursive: true });

  const result = await runDoctor(env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /codex\s+registered/);
  assert.match(result.stdout, /pi\s+registered/);
  assert.match(result.stdout, /dsh\s+detected, not registered -> node .*setup-dsh\.mjs --write/);
}));
