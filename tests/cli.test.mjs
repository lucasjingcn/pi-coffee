import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const cli = new URL("../scripts/cli.mjs", import.meta.url).pathname;

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
