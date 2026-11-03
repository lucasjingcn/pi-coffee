import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const script = join(repoRoot, "scripts", "bootstrap.sh");
const skipOnWindows = process.platform === "win32" ? "POSIX shell fixtures" : false;

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pi-bootstrap "));
  const home = join(dir, "home");
  const app = join(dir, "app");
  mkdirSync(home, { recursive: true });
  // A fake release: only an install.sh is needed to prove the fetch/unpack/forward contract.
  const source = join(dir, "src", "pi-coffee-9.9.9");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "pi-coffee", version: "9.9.9" }));
  writeFileSync(join(source, "install.sh"), '#!/usr/bin/env bash\necho "installer ran with: $*"\n', { mode: 0o755 });
  const archive = join(dir, "pi-coffee-9.9.9.tgz");
  execFileSync("tar", ["-czf", archive, "-C", join(dir, "src"), "pi-coffee-9.9.9"]);
  const env = {
    ...process.env,
    HOME: home,
    PI_COFFEE_APP_DIR: app,
    PI_COFFEE_BOOTSTRAP_ARCHIVE: archive,
  };
  try {
    fn({ dir, home, app, archive, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(args, env) {
  return spawnSync("bash", [script, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("unpacks the archive into a stable directory and forwards installer options", { skip: skipOnWindows }, (t) => {
  fixture(({ app, env }) => {
    const result = run(["--provider", "deepseek", "--model", "deepseek-flash"], env);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /installer ran with: --provider deepseek --model deepseek-flash/);
    assert.ok(existsSync(join(app, "pi-coffee-9.9.9", "install.sh")), "the versioned copy must exist");
  });
});

test("--dry-run resolves the archive without writing anything", { skip: skipOnWindows }, (t) => {
  fixture(({ app, archive, env }) => {
    const result = run(["--dry-run"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dry run: would install .*pi-coffee-9\.9\.9\.tgz/);
    assert.ok(result.stdout.includes(join(app, "pi-coffee-9.9.9")), result.stdout);
    assert.ok(!existsSync(app), "a dry run must not create the destination");
    assert.ok(existsSync(archive));
  });
});

test("--help documents the forwarded options", { skip: skipOnWindows }, (t) => {
  fixture(({ env }) => {
    const result = run(["--help"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--provider/);
    assert.match(result.stdout, /--skip-setup/);
  });
});

test("a missing archive fails with the path it tried", { skip: skipOnWindows }, (t) => {
  fixture(({ dir, env }) => {
    const missing = join(dir, "nope.tgz");
    const result = run([], { ...env, PI_COFFEE_BOOTSTRAP_ARCHIVE: missing });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nope\.tgz/);
  });
});
