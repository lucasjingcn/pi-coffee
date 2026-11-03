import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// `URL.pathname` percent-encodes spaces and yields `/C:/...` on Windows, which
// made every case in this file fail for a checkout in a path with a space.
const cli = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("prints the package version and its usage", () => {
  const version = run(["version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), pkg.version);

  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /pi-coffee install/);
  assert.match(help.stdout, /bootstrap\.sh/);
});

test("an unknown command is a usage error, not a crash", () => {
  const result = run(["frobnicate"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command "frobnicate"/);
});

test("setup is forwarded to scripts/setup.mjs unchanged", (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = run(
    ["setup", "--non-interactive", "--provider", "deepseek", "--model", "deepseek-flash", "--api-key", "sk-fixture"],
    { HOME: home, USERPROFILE: home, PI_COFFEE_ENV_FILE: join(home, "env") },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const env = readFileSync(join(home, "env"), "utf8");
  assert.match(env, /PI_COFFEE_PROVIDER='deepseek'/);
  assert.match(env, /PI_COFFEE_MODEL='deepseek-flash'/);
});

test("durable commands refuse to run from a temporary npx cache", () => {
  // `npx pi-coffee register-clients` used to write a permanent MCP registration
  // pointing at scripts/proxy.mjs inside a cache directory npm may delete.
  const root = mkdtempSync(join(tmpdir(), "pi-npx-"));
  try {
    const cached = join(root, "_npx", "abc123", "node_modules", "pi-coffee");
    mkdirSync(join(cached, "scripts"), { recursive: true });
    writeFileSync(join(cached, "package.json"), JSON.stringify({ name: "pi-coffee", version: "0.0.0" }));
    writeFileSync(join(cached, "scripts", "cli.mjs"), readFileSync(cli, "utf8"));
    for (const command of ["register-clients", "install", "start", "upgrade", "setup"]) {
      const result = spawnSync(process.execPath, [join(cached, "scripts", "cli.mjs"), command], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      assert.equal(result.status, 1, `${command} must refuse: ${result.stderr}`);
      assert.match(result.stderr, /cannot run from a temporary npx cache/, command);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
